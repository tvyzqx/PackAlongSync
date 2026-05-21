// join-circle
//
// Receiver-side (Plan 5.4): redeem a single-use circle_invites token and
// land the caller as a member of the target circle. Multi-circle
// membership is fine (ADR-10) — re-joining the same (profile, circle)
// pair is idempotent.
//
// Two entry conditions:
//   * Caller is already authenticated (magic-link redeem with existing
//     session, OR cross-circle join from a logged-in user). We use their
//     auth.uid() directly and reuse their existing profile if any.
//   * Caller is anonymous (QR redeem on a fresh device). We provision an
//     auth user — against email_target if the token came over email, or
//     against a synthetic join-<uuid>@packalong.local address for pure
//     in-person QR.
//
// Profile resolution:
//   * preassigned_profile_id set -> link that guest profile to the auth
//     user (user_id = caller.id, profile_type = 'account'). If the profile
//     is already linked to the same auth user, that's idempotent. Linked
//     to a different user => 409 / profile_already_claimed.
//   * preassigned_profile_id null -> reuse the caller's existing profile
//     (JWT branch), or create a fresh one with memberName.
//
// Membership: a (circle_id, profile_id) row is upserted with
// ignoreDuplicates so a retry collapses to a no-op.
//
// Atomicity: every downstream step records what it changed; if anything
// after the auth-user creation fails we unwind in reverse order so a
// retry isn't blocked by partial state.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const VALID_ROLES = ["owner", "member", "viewer"] as const;
type InvitedRole = typeof VALID_ROLES[number];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

type InviteRow = {
  token: string;
  circle_id: string;
  preassigned_profile_id: string | null;
  expires_at: string;
  consumed_at: string | null;
  delivery_channel: string;
  email_target: string | null;
  invited_role: string;
};

type ProfileRow = {
  id: string;
  user_id: string | null;
  profile_type: string;
  name: string;
  avatar_emoji: string | null;
  avatar_color: string | null;
  deleted: boolean;
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
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!url || !anonKey || !serviceRoleKey) {
      return json({ error: "Server auth is not configured." }, 500);
    }

    const body = await req.json().catch(() => null);
    const token = stringValue(body?.token);
    const deviceLabel = stringValue(body?.deviceLabel) || "second-device";
    const receiverPassword = typeof body?.password === "string"
      ? body.password
      : "";
    const memberName = stringValue(body?.memberName);
    if (!token) return json({ error: "Token is required." }, 400);

    const admin = createClient(url, serviceRoleKey, {
      db: { schema: "packalong" },
    });

    const { data: rawInvite, error: tokenError } = await admin
      .from("circle_invites")
      .select(
        "token, circle_id, preassigned_profile_id, expires_at, consumed_at, delivery_channel, email_target, invited_role",
      )
      .eq("token", token)
      .maybeSingle();
    if (tokenError) throw tokenError;
    if (!rawInvite) return json({ error: "Token not found." }, 404);
    const invite = rawInvite as InviteRow;
    if (invite.consumed_at) {
      return json({ error: "Token was already used." }, 409);
    }
    if (new Date(invite.expires_at).getTime() <= Date.now()) {
      return json({ error: "Token has expired." }, 410);
    }
    const invitedRole = (VALID_ROLES as readonly string[]).includes(
      invite.invited_role,
    )
      ? (invite.invited_role as InvitedRole)
      : "member";

    // Caller resolution: prefer the JWT branch when a session is
    // present, otherwise provision a new auth user.
    let callerId: string;
    let createdUserId: string | null = null;
    let createdEmail: string | null = null;
    let createdPassword: string | null = null;

    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
    let preAuthUserId: string | null = null;
    if (jwt) {
      const { data: pre, error: preError } = await admin.auth.getUser(jwt);
      if (!preError && pre.user) preAuthUserId = pre.user.id;
    }

    if (preAuthUserId) {
      callerId = preAuthUserId;
    } else {
      const provision = await provisionAuthUser({
        admin,
        invite,
        receiverPassword,
        deviceLabel,
      });
      if ("errorResponse" in provision) return provision.errorResponse;
      callerId = provision.userId;
      createdUserId = provision.userId;
      createdEmail = provision.email;
      createdPassword = provision.password;
    }

    // Track what we touch so we can roll back in reverse on failure.
    let tokenConsumed = false;
    let createdProfileId: string | null = null;
    let linkedPreassignedProfileId: string | null = null;
    let membershipCreated = false;
    const rollback = async () => {
      if (membershipCreated) {
        try {
          await admin
            .from("circle_members")
            .delete()
            .eq("circle_id", invite.circle_id)
            .eq("profile_id", createdProfileId ?? linkedPreassignedProfileId ?? "");
        } catch (_) { /* best effort */ }
      }
      if (linkedPreassignedProfileId) {
        try {
          await admin
            .from("profiles")
            .update({ user_id: null, profile_type: "guest" })
            .eq("id", linkedPreassignedProfileId);
        } catch (_) { /* best effort */ }
      }
      if (createdProfileId) {
        try {
          await admin.from("profiles").delete().eq("id", createdProfileId);
        } catch (_) { /* best effort */ }
      }
      if (tokenConsumed) {
        try {
          await admin
            .from("circle_invites")
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

    let profile: ProfileRow | null = null;
    try {
      // Resolve the profile we'll attach the membership to.
      if (invite.preassigned_profile_id) {
        const result = await linkPreassignedProfile(
          admin,
          invite.preassigned_profile_id,
          callerId,
        );
        if ("errorResponse" in result) {
          await rollback();
          return result.errorResponse;
        }
        profile = result.profile;
        linkedPreassignedProfileId = result.didLink ? profile.id : null;
      } else {
        const reuseOrCreate = await reuseOrCreateProfile(
          admin,
          callerId,
          memberName,
        );
        if ("errorResponse" in reuseOrCreate) {
          await rollback();
          return reuseOrCreate.errorResponse;
        }
        profile = reuseOrCreate.profile;
        createdProfileId = reuseOrCreate.createdId;
      }

      // CAS-consume the token. Only succeeds if it's still open AND not
      // expired. A racing redeem either lost the race (no rows updated)
      // or won it and is finishing right now.
      const { data: consumedRows, error: consumeError } = await admin
        .from("circle_invites")
        .update({
          consumed_at: new Date().toISOString(),
          consumed_by: callerId,
        })
        .eq("token", token)
        .is("consumed_at", null)
        .gt("expires_at", new Date().toISOString())
        .select("token");
      if (consumeError) throw consumeError;
      if (!consumedRows || consumedRows.length !== 1) {
        await rollback();
        return json({ error: "Token can no longer be used." }, 409);
      }
      tokenConsumed = true;

      // Ensure circle_members row exists. ADR-10: idempotent on the PK
      // (circle_id, profile_id) — a re-join is a no-op. We probe first
      // so we know whether we created the row (for rollback bookkeeping).
      const { data: existingMembership, error: membershipLookupError } =
        await admin
          .from("circle_members")
          .select("role, deleted")
          .eq("circle_id", invite.circle_id)
          .eq("profile_id", profile.id)
          .maybeSingle();
      if (membershipLookupError) throw membershipLookupError;
      if (!existingMembership) {
        const { error: insertError } = await admin
          .from("circle_members")
          .insert({
            circle_id: invite.circle_id,
            profile_id: profile.id,
            role: invitedRole,
          });
        if (insertError) throw insertError;
        membershipCreated = true;
      }
      // If the membership exists and is soft-deleted, we intentionally
      // leave it alone — a stale deleted=true row probably encodes an
      // owner-initiated kick; reactivating would be surprising. The owner
      // can flip the flag manually.
    } catch (downstream) {
      await rollback();
      throw downstream;
    }

    // Session resolution. When we minted the auth user we also sign in
    // so the receiver gets a usable session. When the caller arrived
    // with their own JWT we return null tokens and rely on their
    // existing session.
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

    const [circleRes, membersRes] = await Promise.all([
      admin
        .from("circles")
        .select("id, name, icon_emoji, color, created_by, created_at, updated_at")
        .eq("id", invite.circle_id)
        .maybeSingle(),
      admin
        .from("circle_members")
        .select(
          "circle_id, profile_id, role, joined_at, updated_at, deleted",
        )
        .eq("circle_id", invite.circle_id)
        .eq("deleted", false),
    ]);
    if (circleRes.error) throw circleRes.error;
    if (membersRes.error) throw membersRes.error;
    const memberRows = membersRes.data ?? [];

    // Embed each membership's profile so the receiver can render the
    // member list immediately without a second round trip.
    const profileIds = memberRows.map((m) => m.profile_id);
    let profilesById = new Map<string, ProfileRow>();
    if (profileIds.length > 0) {
      const { data: profileRows, error: profilesError } = await admin
        .from("profiles")
        .select("*")
        .in("id", profileIds);
      if (profilesError) throw profilesError;
      for (const p of (profileRows ?? []) as ProfileRow[]) {
        profilesById.set(p.id, p);
      }
    }
    const circleMembers = memberRows.map((m) => ({
      ...m,
      profile: profilesById.get(m.profile_id) ?? null,
    }));

    return json({
      accessToken,
      refreshToken,
      profile,
      circle: circleRes.data,
      circleMembers,
      invitedRole,
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

async function linkPreassignedProfile(
  admin: SupabaseClient,
  profileId: string,
  callerId: string,
): Promise<
  | { profile: ProfileRow; didLink: boolean }
  | { errorResponse: Response }
> {
  const { data: target, error } = await admin
    .from("profiles")
    .select("*")
    .eq("id", profileId)
    .maybeSingle();
  if (error) throw error;
  if (!target) {
    return { errorResponse: json({ error: "Preassigned profile not found." }, 404) };
  }
  const row = target as ProfileRow;
  if (row.user_id === callerId) {
    // Already linked to this user — idempotent re-claim.
    return { profile: row, didLink: false };
  }
  if (row.user_id !== null) {
    return {
      errorResponse: json(
        {
          error: "Profile is already linked to another account.",
          code: "profile_already_claimed",
        },
        409,
      ),
    };
  }
  // CAS-style update: only flip user_id while it's still null so a
  // concurrent redeem can't double-link.
  const { data: linked, error: updateError } = await admin
    .from("profiles")
    .update({ user_id: callerId, profile_type: "account" })
    .eq("id", profileId)
    .is("user_id", null)
    .select("*")
    .maybeSingle();
  if (updateError) throw updateError;
  if (!linked) {
    return {
      errorResponse: json(
        {
          error: "Profile was claimed by another device while linking.",
          code: "profile_claim_race",
        },
        409,
      ),
    };
  }
  return { profile: linked as ProfileRow, didLink: true };
}

async function reuseOrCreateProfile(
  admin: SupabaseClient,
  callerId: string,
  memberName: string,
): Promise<
  | { profile: ProfileRow; createdId: string | null }
  | { errorResponse: Response }
> {
  const { data: existing, error: lookupError } = await admin
    .from("profiles")
    .select("*")
    .eq("user_id", callerId)
    .eq("deleted", false)
    .maybeSingle();
  if (lookupError) throw lookupError;
  if (existing) return { profile: existing as ProfileRow, createdId: null };

  const { data: created, error: insertError } = await admin
    .from("profiles")
    .insert({
      user_id: callerId,
      name: memberName || "New member",
      profile_type: "account",
    })
    .select("*")
    .single();
  if (insertError || !created) {
    return {
      errorResponse: json(
        { error: String(insertError?.message ?? "Could not create profile.") },
        500,
      ),
    };
  }
  return { profile: created as ProfileRow, createdId: created.id };
}

async function provisionAuthUser({
  admin,
  invite,
  receiverPassword,
  deviceLabel,
}: {
  admin: SupabaseClient;
  invite: InviteRow;
  receiverPassword: string;
  deviceLabel: string;
}): Promise<
  | { userId: string; email: string; password: string }
  | { errorResponse: Response }
> {
  const isEmailBound = typeof invite.email_target === "string" &&
    invite.email_target.trim().length > 0;

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
    email = invite.email_target!.trim().toLowerCase();
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
        circle_id: invite.circle_id,
        device_label: deviceLabel,
        delivery_channel: invite.delivery_channel,
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
              "An account with this email already exists. Sign in first, then redeem the invite again.",
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
  const { data, error } = await client.auth.signInWithPassword({
    email,
    password,
  });
  if (error || !data.session) return null;
  return {
    accessToken: data.session.access_token,
    refreshToken: data.session.refresh_token,
  };
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
