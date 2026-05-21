// bootstrap-account
//
// Owner-side first-run flow (Plan 5.1, v3 — circles n:m).
//
// Unlike v2's bootstrap-household (archived under functions/archive/v2/)
// this endpoint does NOT create the auth.users row. The client calls
// supabase.auth.signUpWithPassword first; once that returns a session it
// invokes this function with a Bearer JWT. We trust the JWT (verified by
// the gateway, see supabase/config.toml) and only do the schema-side
// bootstrap: a profile, a default circle, and an owner-membership tying
// them together.
//
// Idempotent: a second call from the same auth user returns the existing
// profile + the user's first-owned circle. This matters because the app
// may retry across confirmation reloads or device hand-offs.
//
// Failure modes & cleanup:
//   * Profile insert fails              -> nothing to roll back.
//   * Circle insert fails               -> profile stays; a retry takes
//                                          the "existing profile, no owned
//                                          circle" branch and finishes
//                                          the bootstrap.
//   * Circle_members insert fails       -> we delete the orphan circle
//                                          (best effort) so the retry
//                                          isn't blocked by a stale row.
//
// We deliberately never delete the auth user from here — that's the
// client's domain (it owns the session and the sign-up flow).

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

const DEFAULT_CIRCLE_NAME = "Mein Haushalt";

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
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    if (!url || !serviceRoleKey) {
      return json({ error: "Server auth is not configured." }, 500);
    }

    // 1. Resolve caller from the bearer JWT. Even though config.toml sets
    //    verify_jwt = true at the gateway, we still need the user id, and
    //    auth.getUser(jwt) is the canonical way to obtain it.
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!jwt) {
      return json({ error: "Missing Authorization bearer token." }, 401);
    }

    const auth = createClient(url, serviceRoleKey);
    const { data: userResult, error: userError } = await auth.auth.getUser(jwt);
    if (userError || !userResult.user) {
      return json({ error: "Invalid auth token." }, 401);
    }
    const callerId = userResult.user.id;

    const body = await req.json().catch(() => null);
    const ownerName = stringValue(body?.owner_name);
    const circleNameInput = stringValue(body?.circle_name);
    const circleName = circleNameInput.length > 0
      ? circleNameInput
      : DEFAULT_CIRCLE_NAME;

    if (!ownerName) {
      return json({ error: "owner_name is required." }, 400);
    }

    const admin = createClient(url, serviceRoleKey, {
      db: { schema: "packalong" },
    });

    // 2. Idempotency probe. ADR-5 guarantees at most one profile per auth
    //    user via a partial unique index, so maybeSingle() is exact.
    const { data: existingProfile, error: lookupError } = await admin
      .from("profiles")
      .select("id")
      .eq("user_id", callerId)
      .eq("deleted", false)
      .maybeSingle();
    if (lookupError) {
      return json({ error: String(lookupError.message) }, 500);
    }

    if (existingProfile) {
      // Bootstrap previously got at least to the profile insert. Find the
      // earliest circle this profile owns and reuse it as the "default".
      const { data: ownerMembership } = await admin
        .from("circle_members")
        .select("circle_id")
        .eq("profile_id", existingProfile.id)
        .eq("role", "owner")
        .eq("deleted", false)
        .order("joined_at", { ascending: true })
        .limit(1)
        .maybeSingle();

      if (ownerMembership) {
        return json({
          profile_id: existingProfile.id,
          circle_id: ownerMembership.circle_id,
          owner_user_id: callerId,
          already_bootstrapped: true,
        });
      }
      // Profile exists but a previous run failed before creating the
      // default circle. Finish the bootstrap.
      return await createCircleAndMembership(
        admin,
        callerId,
        existingProfile.id,
        circleName,
      );
    }

    // 3. Fresh bootstrap.
    const { data: profile, error: profileError } = await admin
      .from("profiles")
      .insert({
        user_id: callerId,
        name: ownerName,
        profile_type: "account",
      })
      .select("id")
      .single();
    if (profileError || !profile) {
      return json(
        { error: String(profileError?.message ?? "Could not create profile.") },
        500,
      );
    }

    return await createCircleAndMembership(admin, callerId, profile.id, circleName);
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

async function createCircleAndMembership(
  admin: SupabaseClient,
  callerId: string,
  profileId: string,
  circleName: string,
): Promise<Response> {
  const { data: circle, error: circleError } = await admin
    .from("circles")
    .insert({ name: circleName, created_by: callerId })
    .select("id")
    .single();
  if (circleError || !circle) {
    return json(
      { error: String(circleError?.message ?? "Could not create circle.") },
      500,
    );
  }

  const { error: memberError } = await admin
    .from("circle_members")
    .insert({
      circle_id: circle.id,
      profile_id: profileId,
      role: "owner",
    });
  if (memberError) {
    // Orphan circle would block neither future bootstraps nor the user,
    // but it would clutter the schema and skew "earliest owner membership"
    // lookups on retry. Drop it.
    try {
      await admin.from("circles").delete().eq("id", circle.id);
    } catch (_) {
      // intentionally ignored
    }
    return json(
      {
        error: String(
          memberError.message ?? "Could not create owner membership.",
        ),
      },
      500,
    );
  }

  return json({
    profile_id: profileId,
    circle_id: circle.id,
    owner_user_id: callerId,
    already_bootstrapped: false,
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
