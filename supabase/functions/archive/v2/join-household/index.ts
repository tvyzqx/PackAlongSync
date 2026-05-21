// join-household
//
// Receiver-side: redeem a single-use token and either link the caller's
// existing Supabase session to a preassigned profile, or provision a new
// auth user + profile in one atomic flow.
//
// Two entry conditions:
//   - Caller is already authenticated (magic-link branch from email).
//     We use that auth.uid() directly; we do NOT create a new user.
//   - Caller is anonymous (QR branch). We provision an auth user — either
//     against the email_target stored on the token (magic-link redeem on
//     a fresh device) or against a synthetic join-<uuid>@packalong.local
//     address (pure in-person QR with no email exchange).
//
// Atomicity: every downstream step is rollbackable. If any fails after
// auth user creation we delete the user + revert token consumption so a
// retry is clean.
//
// Adapted from familyfocal/supabase/functions/join-family, minus the
// invited_role split (ADR-3) and with the "find unclaimed profile by
// role" fallback removed (packalong has flat roles; if no profile is
// preassigned we create a self-service member row).

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
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!url || !anonKey || !serviceRoleKey) {
      return json({ error: "Server auth is not configured." }, 500);
    }

    const body = await req.json();
    const token = stringValue(body.token);
    const deviceLabel = stringValue(body.deviceLabel) || "second-device";
    const receiverPassword = typeof body.password === "string"
      ? body.password
      : "";
    const memberName = stringValue(body.memberName);
    if (!token) return json({ error: "Token is required." }, 400);

    const admin = createClient(url, serviceRoleKey, {
      db: { schema: "packalong" },
    });

    // If the caller arrives with a session (magic-link branch), pick up
    // their auth.uid here so we can link the existing user instead of
    // minting a new one.
    let preAuthUserId: string | null = null;
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace("Bearer ", "");
    if (jwt) {
      const { data: pre, error: preError } = await admin.auth.getUser(jwt);
      if (!preError && pre.user) {
        preAuthUserId = pre.user.id;
      }
    }

    const { data: joinToken, error: tokenError } = await admin
      .from("join_tokens")
      .select(
        "token, household_id, preassigned_profile_id, expires_at, consumed_at, delivery_channel, email_target",
      )
      .eq("token", token)
      .maybeSingle();
    if (tokenError) throw tokenError;
    if (!joinToken) return json({ error: "Token not found." }, 404);
    if (joinToken.consumed_at) {
      return json({ error: "Token was already used." }, 409);
    }
    if (new Date(joinToken.expires_at).getTime() <= Date.now()) {
      return json({ error: "Token has expired." }, 410);
    }

    // Reject if the (pre-authenticated) caller is already linked to a
    // profile in *another* household — ADR-10. Re-claim in the same
    // household isn't valid either; the QR/magic-link should never have
    // been re-issued for them.
    if (preAuthUserId) {
      const { data: existingProfile, error: existingError } = await admin
        .from("profiles")
        .select("id, household_id, name")
        .eq("user_id", preAuthUserId)
        .eq("deleted", false)
        .maybeSingle();
      if (existingError) throw existingError;
      if (existingProfile) {
        if (existingProfile.household_id !== joinToken.household_id) {
          return json(
            {
              error:
                `You are already linked to the profile '${existingProfile.name}' in another household.`,
              code: "already_in_other_household",
            },
            409,
          );
        }
        // Same household: idempotent re-claim — just return the existing
        // state instead of failing.
        return await respondWithExisting(admin, joinToken.household_id, existingProfile.id);
      }
    }

    // Resolve the auth user we'll attach to the profile.
    let authUserId: string;
    let createdUserId: string | null = null;
    let createdEmail: string | null = null;
    let createdPassword: string | null = null;
    if (preAuthUserId) {
      authUserId = preAuthUserId;
    } else {
      const provision = await provisionAuthUser({
        admin,
        token: joinToken,
        receiverPassword,
        deviceLabel,
      });
      if ("errorResponse" in provision) return provision.errorResponse;
      authUserId = provision.userId;
      createdUserId = provision.userId;
      createdEmail = provision.email;
      createdPassword = provision.password;
    }

    // From here on every step is rollback-able. If anything fails after
    // auth user creation we must unwind so a retry isn't blocked.
    let tokenConsumed = false;
    let profileUserIdSet = false;
    let createdProfileId: string | null = null;
    const rollback = async () => {
      if (createdProfileId) {
        try {
          await admin.from("profiles").delete().eq("id", createdProfileId);
        } catch (_) { /* best effort */ }
      }
      if (profileUserIdSet && joinToken.preassigned_profile_id) {
        try {
          await admin
            .from("profiles")
            .update({ user_id: null, profile_type: "guest" })
            .eq("id", joinToken.preassigned_profile_id);
        } catch (_) { /* best effort */ }
      }
      if (tokenConsumed) {
        try {
          await admin
            .from("join_tokens")
            .update({ consumed_at: null, consumed_by: null })
            .eq("token", token);
        } catch (_) { /* best effort */ }
      }
      if (createdUserId) {
        try {
          await admin.auth.admin.deleteUser(createdUserId);
        } catch (_) { /* best effort */ }
      }
    };

    let profile = null;
    try {
      // Atomic CAS: consume the token only if it's still open AND not
      // expired. The .select("token") return tells us whether we won.
      const { data: consumedRows, error: consumeError } = await admin
        .from("join_tokens")
        .update({
          consumed_at: new Date().toISOString(),
          consumed_by: authUserId,
        })
        .eq("token", token)
        .is("consumed_at", null)
        .gt("expires_at", new Date().toISOString())
        .select("token");
      if (consumeError) throw consumeError;
      if (!consumedRows || consumedRows.length !== 1) {
        if (createdUserId) {
          await admin.auth.admin.deleteUser(createdUserId).catch(() => {});
        }
        return json({ error: "Token can no longer be used." }, 409);
      }
      tokenConsumed = true;

      if (joinToken.preassigned_profile_id) {
        const { data, error } = await admin
          .from("profiles")
          .update({
            user_id: authUserId,
            profile_type: "account",
          })
          .eq("id", joinToken.preassigned_profile_id)
          .select("*")
          .maybeSingle();
        if (error) throw error;
        profile = data;
        profileUserIdSet = data != null;
      } else {
        // Self-service join: no preassigned profile. Create a new member
        // row in the household. memberName is the caller-supplied name;
        // fall back to a placeholder if missing.
        const { data, error } = await admin
          .from("profiles")
          .insert({
            household_id: joinToken.household_id,
            user_id: authUserId,
            role: "member",
            profile_type: "account",
            name: memberName || "New member",
          })
          .select("*")
          .single();
        if (error) throw error;
        profile = data;
        createdProfileId = data?.id ?? null;
      }
    } catch (downstream) {
      await rollback();
      throw downstream;
    }

    // Build the response. When we created the auth user we also sign in
    // so the receiver gets a session; when the caller arrived already
    // authenticated, we return the existing session implicitly via the
    // caller's JWT — no signInWithPassword needed.
    let accessToken: string | null = null;
    let refreshToken: string | null = null;
    if (createdUserId && createdEmail && createdPassword) {
      const session = await signInWithUserPassword({
        url,
        anonKey,
        email: createdEmail,
        password: createdPassword,
      });
      if (!session) {
        await rollback();
        return json(
          { error: "Could not create auth session after join." },
          500,
        );
      }
      accessToken = session.accessToken;
      refreshToken = session.refreshToken;
    }

    const { data: householdMembers, error: membersError } = await admin
      .from("profiles")
      .select("*")
      .eq("household_id", joinToken.household_id)
      .eq("deleted", false)
      .order("name");
    if (membersError) throw membersError;

    return json({
      accessToken,
      refreshToken,
      profile,
      householdMembers,
    });
  } catch (error) {
    return json(
      { error: String((error as { message?: string })?.message ?? error) },
      400,
    );
  }
});

async function provisionAuthUser({
  admin,
  token,
  receiverPassword,
  deviceLabel,
}: {
  admin: ReturnType<typeof createClient>;
  token: {
    household_id: string;
    email_target: string | null;
    delivery_channel: string;
  };
  receiverPassword: string;
  deviceLabel: string;
}): Promise<
  | { userId: string; email: string; password: string }
  | { errorResponse: Response }
> {
  const isEmailBound = typeof token.email_target === "string" &&
    token.email_target.trim().length > 0;

  let email: string;
  let password: string;
  if (isEmailBound) {
    if (receiverPassword.length < 8) {
      return {
        errorResponse: json(
          {
            error: "Password must be at least 8 characters.",
            code: "password_required",
          },
          400,
        ),
      };
    }
    email = token.email_target!.trim().toLowerCase();
    password = receiverPassword;
  } else {
    email = `join-${crypto.randomUUID()}@packalong.local`;
    password = randomToken(36);
  }

  const { data: created, error: createError } = await admin.auth.admin
    .createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        household_id: token.household_id,
        device_label: deviceLabel,
        delivery_channel: token.delivery_channel,
        email_bound: isEmailBound,
      },
    });
  if (createError || !created.user) {
    const message = String(createError?.message ?? "Could not create device account.");
    if (isEmailBound &&
        (/already.*registered/i.test(message) || /already exists/i.test(message))) {
      return {
        errorResponse: json(
          {
            error:
              "An account with this email already exists. Sign in instead, or ask the owner to use a different email.",
            code: "user_already_exists",
          },
          409,
        ),
      };
    }
    throw createError ?? new Error(message);
  }
  return { userId: created.user.id, email, password };
}

async function signInWithUserPassword({
  url,
  anonKey,
  email,
  password,
}: {
  url: string;
  anonKey: string;
  email: string;
  password: string;
}): Promise<{ accessToken: string; refreshToken: string } | null> {
  const client = createClient(url, anonKey);
  const { data, error } = await client.auth.signInWithPassword({ email, password });
  if (error || !data.session) return null;
  return {
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
  };
}

async function respondWithExisting(
  admin: ReturnType<typeof createClient>,
  householdId: string,
  profileId: string,
): Promise<Response> {
  const [{ data: profile }, { data: members }] = await Promise.all([
    admin.from("profiles").select("*").eq("id", profileId).maybeSingle(),
    admin
      .from("profiles")
      .select("*")
      .eq("household_id", householdId)
      .eq("deleted", false)
      .order("name"),
  ]);
  return json({
    accessToken: null,
    refreshToken: null,
    profile,
    householdMembers: members ?? [],
    note: "Already linked — returning existing state.",
  });
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
