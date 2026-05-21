// generate-household-invite
//
// Owner-side: produce a single-use token that another device can redeem
// to claim a guest profile or join the household as a new member.
//
// Two delivery channels (ADR-13):
//   - 'qr'    : the response carries server+anonKey+token in clear so the
//               caller can encode them as a base64 payload into a
//               packalong://household?payload=... deep link. TTL ~10 min.
//   - 'email' : when recipientEmail is set, we additionally invoke
//               auth.admin.inviteUserByEmail (falls back to
//               admin.generateLink + manual mail if the address is already
//               registered). TTL ~7 d. The receiver lands at
//               https://packalong.app/claim/<token>.
//
// Token hygiene (ADR-4): when a new token is issued for a profile we
// retire any still-open token for that profile so two devices can't race
// for the same slot.
//
// Adapted from familyfocal/supabase/functions/generate-join-token, minus
// the parent/child role split (ADR-3).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const url = Deno.env.get("SUPABASE_URL") ?? "";
    // SUPABASE_URL is the in-cluster S2S endpoint (e.g. http://kong:8000).
    // SUPABASE_PUBLIC_URL is what the second device actually reaches over
    // the internet. On managed Supabase they're the same; on self-hosted
    // installs the admin must set the latter explicitly (see README).
    const publicUrl = Deno.env.get("SUPABASE_PUBLIC_URL") ?? url;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace("Bearer ", "");
    if (!url || !serviceRoleKey || !anonKey || !jwt) {
      return json({ error: "Server auth is not configured." }, 500);
    }

    const admin = createClient(url, serviceRoleKey, {
      db: { schema: "packalong" },
    });

    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData.user) {
      return json({ error: "Unauthorized" }, 401);
    }

    const body = await req.json();
    const profileId = stringValue(body.profileId);
    const recipientEmail = stringValue(body.recipientEmail).toLowerCase();
    const isEmailChannel = recipientEmail.length > 0;

    // Resolve the caller's household + owner status. Single round trip.
    const { data: callerProfile, error: callerError } = await admin
      .from("profiles")
      .select("id, household_id, role")
      .eq("user_id", userData.user.id)
      .eq("deleted", false)
      .maybeSingle();
    if (callerError) throw callerError;
    if (!callerProfile || callerProfile.role !== "owner") {
      return json(
        { error: "Only the household owner can issue invites." },
        403,
      );
    }
    const householdId = callerProfile.household_id as string;

    // Optional: verify the preassigned profile belongs to the same
    // household and is still claimable (user_id is null).
    if (profileId) {
      const { data: target, error: targetError } = await admin
        .from("profiles")
        .select("id, household_id, user_id, name")
        .eq("id", profileId)
        .maybeSingle();
      if (targetError) throw targetError;
      if (!target) return json({ error: "Profile not found." }, 404);
      if (target.household_id !== householdId) {
        return json(
          { error: "Profile belongs to a different household." },
          403,
        );
      }
      if (target.user_id !== null) {
        return json(
          {
            error: "Profile is already linked to an account.",
            code: "profile_already_claimed",
          },
          409,
        );
      }
    }

    const ttlMinutes = parseTtl(isEmailChannel);
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);
    const token = crypto.randomUUID() + "." + randomToken(32);

    // Token hygiene: close any still-open token for the same profile.
    if (profileId) {
      const { error: hygieneError } = await admin
        .from("join_tokens")
        .update({ consumed_at: new Date().toISOString() })
        .eq("preassigned_profile_id", profileId)
        .is("consumed_at", null);
      if (hygieneError) throw hygieneError;
    }

    const { error: insertError } = await admin.from("join_tokens").insert({
      token,
      household_id: householdId,
      preassigned_profile_id: profileId || null,
      issued_by: userData.user.id,
      expires_at: expiresAt.toISOString(),
      delivery_channel: isEmailChannel ? "email" : "qr",
      email_target: isEmailChannel ? recipientEmail : null,
    });
    if (insertError) throw insertError;

    let emailSent = false;
    let emailFallbackLink: string | null = null;
    if (isEmailChannel) {
      const universalLink = buildClaimUniversalLink(token);
      const inviteResult = await sendInviteEmail(
        admin,
        recipientEmail,
        universalLink,
        token,
      );
      emailSent = inviteResult.sent;
      emailFallbackLink = inviteResult.fallbackLink;
    }

    return json({
      token,
      expiresAt: expiresAt.toISOString(),
      ttlSeconds: ttlMinutes * 60,
      server: publicUrl,
      anonKey,
      householdId,
      profileId: profileId || null,
      deliveryChannel: isEmailChannel ? "email" : "qr",
      emailTarget: isEmailChannel ? recipientEmail : null,
      emailSent,
      emailFallbackLink,
      // Pre-built deep links for app convenience. The QR payload is
      // built client-side because it needs anonKey embedded; we still
      // expose the universalLink for the share-sheet branch.
      universalLink: buildClaimUniversalLink(token),
    });
  } catch (error) {
    return json(
      { error: String((error as { message?: string })?.message ?? error) },
      400,
    );
  }
});

async function sendInviteEmail(
  admin: ReturnType<typeof createClient>,
  email: string,
  redirectTo: string,
  token: string,
): Promise<{ sent: boolean; fallbackLink: string | null }> {
  try {
    const { error } = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo,
      data: { invite_token: token },
    });
    if (!error) return { sent: true, fallbackLink: null };
    const message = String(error.message ?? "");
    if (!/already.*registered/i.test(message) && !/already exists/i.test(message)) {
      // Some other failure (rate-limit, SMTP down). Let the caller
      // surface a fallback link instead of failing the whole invite.
      return { sent: false, fallbackLink: redirectTo };
    }
  } catch (_) {
    // Best-effort: fall through to the magiclink path.
  }

  try {
    const { data, error } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email,
      options: { redirectTo },
    });
    if (error || !data?.properties?.action_link) {
      return { sent: false, fallbackLink: redirectTo };
    }
    return { sent: false, fallbackLink: data.properties.action_link };
  } catch (_) {
    return { sent: false, fallbackLink: redirectTo };
  }
}

function parseTtl(isEmailChannel: boolean): number {
  const envName = isEmailChannel
    ? "INVITE_TTL_MINUTES"
    : "JOIN_TOKEN_TTL_MINUTES";
  const fallback = isEmailChannel ? 10080 : 10;
  const raw = Deno.env.get(envName);
  const parsed = raw ? Number(raw) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function buildClaimUniversalLink(token: string): string {
  const host = Deno.env.get("PUBLIC_APP_HOST") ?? "packalong.app";
  return `https://${host}/claim/${token}`;
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function randomToken(bytes: number): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return btoa(String.fromCharCode(...data))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
