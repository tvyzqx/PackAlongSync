// check-join-status
//
// Owner-side polling endpoint: was the token I issued already consumed?
//
// The UI sits on the QR-display sheet and pings this every couple of
// seconds. The endpoint is read-only and only returns the consumption
// state plus consumer id; the owner does not need to know what the
// second device did beyond "yes, the link was used".
//
// 1:1 port of the v2 check-join-status (archive/v2/) — only the table
// name changed (join_tokens -> circle_invites, ADR-2 v3 pivot).

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

  try {
    const url = Deno.env.get("SUPABASE_URL") ?? "";
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    // Missing env is the operator's problem (500); a missing token is the
    // caller's (401). Same split as pa-delete-circle et al.
    if (!url || !serviceRoleKey) {
      return json({ error: "Server auth is not configured." }, 500);
    }
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!jwt) {
      return json({ error: "Missing Authorization bearer token." }, 401);
    }

    const admin = createPackalongAdmin(url, serviceRoleKey);
    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData.user) {
      return json({ error: "Unauthorized" }, 401);
    }

    const body = await req.json().catch(() => null);
    const token = typeof body?.token === "string" ? body.token.trim() : "";
    if (!token) return json({ error: "Token is required." }, 400);

    const { data, error } = await admin
      .from("circle_invites")
      .select("issued_by, consumed_at, consumed_by")
      .eq("token", token)
      .maybeSingle();
    if (error) throw error;
    if (!data) return json({ error: "Token not found." }, 404);
    if (data.issued_by !== userData.user.id) {
      return json({ error: "Forbidden" }, 403);
    }

    return json({
      consumed: data.consumed_at !== null,
      consumedAt: data.consumed_at,
      consumedBy: data.consumed_by,
    });
  } catch (error) {
    return json(
      { error: String((error as { message?: string })?.message ?? error) },
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
