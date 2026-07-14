// delete-participant-data
//
// Erase one participant's data within a circle. Two callers are allowed:
//   * an OWNER of the circle scrubbing any participant (e.g. a guest), or
//   * a participant erasing THEIR OWN footprint (self-service).
//
// Unlike pa-remove-member (which only ends membership), this purges the
// content that is intrinsically theirs — pack-list/authored items and their
// comments/tags, authored comments, activity events, containers, trip
// participation, group memberships — then removes their membership, and, for a
// guest-only profile with no remaining membership, tombstones the profile too.
// Shared structure (trips, the circle) is left intact. The cascade lives in the
// SECURITY DEFINER packalong.soft_delete_participant_data(uuid, uuid) SQL
// function (migration 023); this layer only authorizes and invokes it.
//
// Guard: an OWNER may not delete their OWN data here (it could orphan the
// circle) — they should transfer ownership or use pa-delete-circle.

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

    // Resolve caller's profile (ADR-5: at most one per auth user).
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

    const isSelf = profile.id === targetProfileId;

    // Is the caller an active owner of this circle?
    const { data: ownerRow, error: ownerError } = await admin
      .from("circle_members")
      .select("profile_id")
      .eq("circle_id", circleId)
      .eq("profile_id", profile.id)
      .eq("role", "owner")
      .eq("deleted", false)
      .maybeSingle();
    if (ownerError) return json({ error: String(ownerError.message) }, 500);
    const isOwner = !!ownerRow;

    // Authorization: owner (deleting anyone) or self (deleting own data).
    if (!isOwner && !isSelf) {
      return json(
        {
          error: "Only a circle owner, or the participant themselves, may delete this data.",
          code: "not_authorized",
        },
        403,
      );
    }
    // An owner erasing their OWN data could orphan the circle.
    if (isOwner && isSelf) {
      return json(
        {
          error:
            "An owner cannot delete their own data here. Transfer ownership or delete the circle.",
          code: "owner_self_delete",
        },
        400,
      );
    }

    // The target must have (or have had) a membership in this circle, so an
    // authorized caller can only reach data scoped to a circle they belong to.
    const { data: targetMembership, error: targetError } = await admin
      .from("circle_members")
      .select("profile_id")
      .eq("circle_id", circleId)
      .eq("profile_id", targetProfileId)
      .maybeSingle();
    if (targetError) return json({ error: String(targetError.message) }, 500);
    if (!targetMembership) {
      return json(
        { error: "That profile has no membership in this circle.", code: "not_a_member" },
        404,
      );
    }

    const { error: rpcError } = await admin.rpc("soft_delete_participant_data", {
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
