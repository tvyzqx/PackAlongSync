// remove-member
//
// Owner-triggered removal of one member from a circle. The counterpart to
// pa-join-circle (add). Mirrors pa-delete-circle's shape: the TS layer
// validates the JWT and enforces the owner check, then a service-role client
// invokes the SECURITY DEFINER packalong.soft_remove_member(uuid, uuid) SQL
// function (migration 022) which soft-deletes the membership and expires any
// unconsumed invite pre-bound to that member.
//
// Removal is a soft-delete so the tombstone propagates to every device via the
// normal incremental pull — including the removed member's own device, which
// drops the circle from their UI. It does NOT delete the member's contributed
// data; that is pa-delete-participant-data.
//
// Guards:
//   * caller must hold an active `owner` membership in the circle;
//   * an owner may not remove themselves here (that would risk orphaning the
//     circle) — use "leave" / pa-delete-circle instead.

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
    const targetProfileId = stringValue(body?.profile_id);
    if (!circleId) return json({ error: "circle_id is required." }, 400);
    if (!targetProfileId) return json({ error: "profile_id is required." }, 400);

    const admin = createPackalongAdmin(url, serviceRoleKey);

    // Resolve the caller's profile (ADR-5: at most one per auth user) and verify
    // they hold an active owner membership. service_role bypasses RLS, so this
    // is the sole authorization gate.
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

    if (profile.id === targetProfileId) {
      return json(
        {
          error: "An owner cannot remove themselves. Use leave or delete-circle.",
          code: "cannot_remove_self",
        },
        400,
      );
    }

    const { data: ownerRow, error: ownerError } = await admin
      .from("circle_members")
      .select("profile_id")
      .eq("circle_id", circleId)
      .eq("profile_id", profile.id)
      .eq("role", "owner")
      .eq("deleted", false)
      .maybeSingle();
    if (ownerError) return json({ error: String(ownerError.message) }, 500);
    if (!ownerRow) {
      return json(
        { error: "Only an owner of this circle may remove members.", code: "not_owner" },
        403,
      );
    }

    // Confirm the target is actually an active member (idempotent-friendly 404).
    const { data: targetRow, error: targetError } = await admin
      .from("circle_members")
      .select("profile_id")
      .eq("circle_id", circleId)
      .eq("profile_id", targetProfileId)
      .eq("deleted", false)
      .maybeSingle();
    if (targetError) return json({ error: String(targetError.message) }, 500);
    if (!targetRow) {
      return json(
        { error: "That profile is not an active member of this circle.", code: "not_a_member" },
        404,
      );
    }

    const { error: rpcError } = await admin.rpc("soft_remove_member", {
      target_circle: circleId,
      target_profile: targetProfileId,
    });
    if (rpcError) return json({ error: String(rpcError.message) }, 500);

    return json({ ok: true, circle_id: circleId, profile_id: targetProfileId });
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
