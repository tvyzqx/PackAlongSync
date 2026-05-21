// generate-circle-invite
//
// Owner-side (Plan 5.3): produce a single-use token that another device
// can redeem to join a specific circle. Optionally pre-bind the token to
// an existing guest profile (e.g. an in-household child placeholder) so
// the receiver claims that identity instead of creating a fresh one.
//
// Two delivery channels (ADR-6 / ADR-13):
//   'qr'    : response carries server + anonKey + token in clear so the
//             caller can encode them as a base64 payload into a
//             packalong://circle?payload=... deep link. TTL ~10 min.
//   'email' : when recipient_email is set we additionally invoke
//             auth.admin.inviteUserByEmail (with admin.generateLink as
//             fallback if the address is already registered). TTL ~7 d.
//             Receiver lands at https://packalong.app/claim/<token>.
//
// Role gating: invited_role defaults to 'member'. The DB CHECK constraint
// enforces {owner|member|viewer}; we validate up-front for a friendlier
// 400 instead of a downstream constraint error.
//
// Token hygiene: when a new token is issued for a pre-bound profile we
// retire any still-open token for that (profile, circle) pair so two
// devices can't race for the same slot.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const VALID_ROLES = ["owner", "member", "viewer"] as const;
type InvitedRole = typeof VALID_ROLES[number];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed." }, 405);
  }

  try {
    const url = Deno.env.get("SUPABASE_URL") ?? "";
    // SUPABASE_URL is the in-cluster S2S endpoint (e.g. http://kong:8000).
    // SUPABASE_PUBLIC_URL is what the second device reaches over the
    // internet. On managed Supabase they're the same; on self-hosted
    // installs the admin must set the latter explicitly (see README).
    const publicUrl = Deno.env.get("SUPABASE_PUBLIC_URL") ?? url;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
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
    const callerId = userData.user.id;

    const body = await req.json().catch(() => null);
    const circleId = stringValue(body?.circle_id);
    const profileId = stringValue(body?.profile_id);
    const recipientEmail = stringValue(body?.recipient_email).toLowerCase();
    const isEmailChannel = recipientEmail.length > 0;

    if (!circleId) {
      return json({ error: "circle_id is required." }, 400);
    }

    const invitedRole = parseInvitedRole(body?.invited_role);
    if (!invitedRole) {
      return json(
        { error: `invited_role must be one of ${VALID_ROLES.join(", ")}.` },
        400,
      );
    }

    // Owner-Check. The packalong.is_circle_owner(uuid) helper runs against
    // auth.uid(), which is NULL under the service-role client. So we
    // resolve the caller's profile + membership explicitly instead of
    // calling the RLS helper as an RPC.
    const ownerCheck = await assertCallerIsCircleOwner(admin, callerId, circleId);
    if (!ownerCheck.ok) {
      return json({ error: ownerCheck.error, code: ownerCheck.code }, ownerCheck.status);
    }
    const callerProfileId = ownerCheck.profileId;

    if (profileId) {
      const targetCheck = await assertPreassignableProfile(admin, profileId, circleId);
      if (!targetCheck.ok) {
        return json({ error: targetCheck.error, code: targetCheck.code }, targetCheck.status);
      }
    }

    const ttlMinutes = parseTtl(isEmailChannel);
    const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);
    const token = crypto.randomUUID() + "." + randomToken(32);

    // Hygiene: retire any still-open invites for the same (profile,
    // circle) pair before issuing a new one. consumed_by stays NULL
    // because no one actually consumed it — consumed_at being set is
    // enough to take it out of the active-token partial index.
    if (profileId) {
      const { error: hygieneError } = await admin
        .from("circle_invites")
        .update({ consumed_at: new Date().toISOString() })
        .eq("preassigned_profile_id", profileId)
        .eq("circle_id", circleId)
        .is("consumed_at", null);
      if (hygieneError) throw hygieneError;
    }

    const { error: insertError } = await admin.from("circle_invites").insert({
      token,
      circle_id: circleId,
      preassigned_profile_id: profileId || null,
      issued_by: callerId,
      expires_at: expiresAt.toISOString(),
      delivery_channel: isEmailChannel ? "email" : "qr",
      email_target: isEmailChannel ? recipientEmail : null,
      invited_role: invitedRole,
    });
    if (insertError) throw insertError;

    const universalLink = buildClaimUniversalLink(token);
    let emailSent = false;
    let emailFallbackLink: string | null = null;
    if (isEmailChannel) {
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
      circleId,
      profileId: profileId || null,
      invitedRole,
      issuedByProfileId: callerProfileId,
      deliveryChannel: isEmailChannel ? "email" : "qr",
      emailTarget: isEmailChannel ? recipientEmail : null,
      emailSent,
      emailFallbackLink,
      universalLink,
    });
  } catch (error) {
    return json(
      {
        error: String(
          (error as { message?: unknown })?.message ?? error ?? "Unknown error.",
        ),
      },
      400,
    );
  }
});

// helpers -----------------------------------------------------------------

type CheckSuccess = { ok: true; profileId: string };
type CheckFailure = { ok: false; status: number; error: string; code?: string };

async function assertCallerIsCircleOwner(
  admin: SupabaseClient,
  callerId: string,
  circleId: string,
): Promise<CheckSuccess | CheckFailure> {
  const { data: callerProfile, error: callerError } = await admin
    .from("profiles")
    .select("id")
    .eq("user_id", callerId)
    .eq("deleted", false)
    .maybeSingle();
  if (callerError) {
    return { ok: false, status: 500, error: String(callerError.message) };
  }
  if (!callerProfile) {
    return {
      ok: false,
      status: 409,
      error: "No profile exists for this auth user.",
      code: "profile_missing",
    };
  }

  const { data: membership, error: membershipError } = await admin
    .from("circle_members")
    .select("role")
    .eq("circle_id", circleId)
    .eq("profile_id", callerProfile.id)
    .eq("deleted", false)
    .maybeSingle();
  if (membershipError) {
    return { ok: false, status: 500, error: String(membershipError.message) };
  }
  if (!membership || membership.role !== "owner") {
    return {
      ok: false,
      status: 403,
      error: "Only a circle owner can issue invites.",
      code: "not_circle_owner",
    };
  }
  return { ok: true, profileId: callerProfile.id };
}

type ProfileCheck =
  | { ok: true }
  | { ok: false; status: number; error: string; code?: string };

async function assertPreassignableProfile(
  admin: SupabaseClient,
  profileId: string,
  circleId: string,
): Promise<ProfileCheck> {
  const { data: target, error: targetError } = await admin
    .from("profiles")
    .select("id, user_id")
    .eq("id", profileId)
    .eq("deleted", false)
    .maybeSingle();
  if (targetError) {
    return { ok: false, status: 500, error: String(targetError.message) };
  }
  if (!target) {
    return { ok: false, status: 404, error: "Profile not found." };
  }
  if (target.user_id !== null) {
    return {
      ok: false,
      status: 409,
      error: "Profile is already linked to an account.",
      code: "profile_already_claimed",
    };
  }

  // Pre-bound profile must already be a member of the target circle —
  // a bare profile floating outside any circle is not addressable.
  const { data: membership, error: membershipError } = await admin
    .from("circle_members")
    .select("circle_id")
    .eq("circle_id", circleId)
    .eq("profile_id", profileId)
    .eq("deleted", false)
    .maybeSingle();
  if (membershipError) {
    return { ok: false, status: 500, error: String(membershipError.message) };
  }
  if (!membership) {
    return {
      ok: false,
      status: 403,
      error: "Profile is not a member of this circle.",
      code: "profile_not_in_circle",
    };
  }
  return { ok: true };
}

async function sendInviteEmail(
  admin: SupabaseClient,
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
      // SMTP down, rate-limit, etc. Surface a fallback link instead of
      // failing the whole invite.
      return { sent: false, fallbackLink: redirectTo };
    }
  } catch (_) {
    // fall through to magiclink path
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

function parseInvitedRole(value: unknown): InvitedRole | null {
  if (value == null) return "member";
  if (typeof value !== "string") return null;
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0) return "member";
  return (VALID_ROLES as readonly string[]).includes(trimmed)
    ? (trimmed as InvitedRole)
    : null;
}

function parseTtl(isEmailChannel: boolean): number {
  const envName = isEmailChannel ? "INVITE_TTL_MINUTES" : "JOIN_TOKEN_TTL_MINUTES";
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
