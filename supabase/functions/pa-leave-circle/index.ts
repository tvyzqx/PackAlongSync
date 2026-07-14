// leave-circle
//
// Self-service departure: the CALLER removes THEIR OWN membership from a circle.
// The counterpart to pa-remove-member (owner removes someone else) — the two are
// deliberately split because their authorization is opposite: remove-member is
// owner-only and forbids self, leave-circle is self-only.
//
// Why this exists: once the client stopped pushing non-owned circle_members rows
// (sync fix, migration 021/024 stopgap), a non-owner who left a circle by the
// old direct-write path never propagated the tombstone — the server and the
// owner kept showing them as a member. Membership lifecycle now runs solely
// through edge functions; leaving needs its own gateway.
//
// Reuses packalong.soft_remove_member(circle, profile) (migration 022): it
// soft-deletes the membership (deleted=true, updated_at bumped — pulled without
// a circle_id filter, so it reaches every device including the leaver's) and
// expires any unconsumed invite pre-bound to the leaver. Leaving does NOT delete
// the member's contributed data (trips, items, …); that is
// pa-delete-participant-data.
//
// Guards:
//   * caller must hold an active membership in the circle;
//   * the SOLE remaining owner may not leave (it would orphan the circle) — they
//     must transfer ownership or use pa-delete-circle. A co-owner may leave.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createPackalongAdmin } from "../_shared/packalong_client.ts";

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
    const circleId = stringValue(body?.circle_id);
    if (!circleId) return json({ error: "circle_id is required." }, 400);

    const admin = createPackalongAdmin(url, serviceRoleKey);

    // Resolve the caller's profile (ADR-5: at most one per auth user). The
    // target of a leave is always the caller themselves. service_role bypasses
    // RLS, so this profile lookup is the sole identity gate.
    const { data: profile, error: profileError } = await admin
      .from("profiles")
      .select("id")
      .eq("user_id", callerId)
      .eq("deleted", false)
      .maybeSingle();
    if (profileError) return json({ error: String(profileError.message) }, 500);
    if (!profile) {
      return json(
        {
          error: "No profile exists for this auth user. Run bootstrap-account first.",
          code: "profile_missing",
        },
        409,
      );
    }

    // The caller must be an active member of this circle.
    const { data: myMembership, error: myError } = await admin
      .from("circle_members")
      .select("role")
      .eq("circle_id", circleId)
      .eq("profile_id", profile.id)
      .eq("deleted", false)
      .maybeSingle();
    if (myError) return json({ error: String(myError.message) }, 500);
    if (!myMembership) {
      return json(
        { error: "You are not an active member of this circle.", code: "not_a_member" },
        404,
      );
    }

    // The sole remaining owner may not leave — that would orphan the circle.
    if (myMembership.role === "owner") {
      const { count, error: ownerCountError } = await admin
        .from("circle_members")
        .select("profile_id", { count: "exact", head: true })
        .eq("circle_id", circleId)
        .eq("role", "owner")
        .eq("deleted", false);
      if (ownerCountError) {
        return json({ error: String(ownerCountError.message) }, 500);
      }
      if ((count ?? 0) <= 1) {
        return json(
          {
            error:
              "The sole owner cannot leave. Transfer ownership or delete the circle.",
            code: "sole_owner",
          },
          400,
        );
      }
    }

    const { error: rpcError } = await admin.rpc("soft_remove_member", {
      target_circle: circleId,
      target_profile: profile.id,
    });
    if (rpcError) return json({ error: String(rpcError.message) }, 500);

    return json({ ok: true, circle_id: circleId, profile_id: profile.id });
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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}
