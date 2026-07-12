// delete-circle
//
// Owner-triggered deletion of an entire circle. Complements create-circle:
// where create-circle spins up a circle + owner membership, this tears the
// whole thing down. The last remaining owner previously had no exit at all
// ("leave" is blocked for the final owner), so a solo-owner circle was
// permanent — this closes that gap.
//
// The sync layer is soft-delete based, so deletion is a cascade *soft-delete*
// (deleted=true + updated_at bump) so the tombstones propagate to every
// member's device on the next pull. The cascade itself lives in the
// packalong.soft_delete_circle(uuid) SQL function (migration 016) so it runs
// atomically; this function only authorizes the caller and invokes it.
//
// Mirrors create-circle's shape: the TS layer validates the JWT and enforces
// the owner check, the service-role client performs the writes.

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
    if (!circleId) {
      return json({ error: "circle_id is required." }, 400);
    }

    const admin = createPackalongAdmin(url, serviceRoleKey);

    // Resolve the caller's profile (ADR-5: at most one per auth user), then
    // verify they hold an `owner` membership in the target circle. service_role
    // bypasses RLS, so this check is the only authorization gate — the SQL
    // cascade trusts its caller.
    const { data: profile, error: profileError } = await admin
      .from("profiles")
      .select("id")
      .eq("user_id", callerId)
      .eq("deleted", false)
      .maybeSingle();
    if (profileError) {
      return json({ error: String(profileError.message) }, 500);
    }
    if (!profile) {
      return json(
        {
          error: "No profile exists for this auth user. Run bootstrap-account first.",
          code: "profile_missing",
        },
        409,
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
    if (ownerError) {
      return json({ error: String(ownerError.message) }, 500);
    }
    if (!ownerRow) {
      return json(
        {
          error: "Only an owner of this circle may delete it.",
          code: "not_owner",
        },
        403,
      );
    }

    const { error: rpcError } = await admin.rpc("soft_delete_circle", {
      target_circle: circleId,
    });
    if (rpcError) {
      return json({ error: String(rpcError.message) }, 500);
    }

    return json({ ok: true, circle_id: circleId });
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
