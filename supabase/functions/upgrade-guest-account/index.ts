import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...corsHeaders,
    },
  });
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return json(405, { error: "Method not allowed" });
  }
  if (!SUPABASE_URL || !ANON_KEY || !SERVICE_ROLE_KEY) {
    return json(500, { error: "Supabase environment is not configured" });
  }

  const authHeader = request.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) {
    return json(401, { error: "Missing bearer token" });
  }

  const payload = await request.json().catch(() => null);
  const personId = typeof payload?.person_id === "string" ? payload.person_id.trim() : "";
  const deviceId = typeof payload?.device_id === "string" ? payload.device_id.trim() : "";
  if (!personId || !deviceId) {
    return json(400, { error: "person_id and device_id are required" });
  }

  const anonClient = createClient(SUPABASE_URL, ANON_KEY);
  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const { data: userData, error: userError } = await anonClient.auth.getUser(jwt);
  if (userError || !userData?.user) {
    return json(401, { error: "Invalid owner session" });
  }

  const accountId = userData.user.id;

  const { data: personRow, error: personError } = await serviceClient
    .from("persons")
    .select("id, account_id, created_by_account_id, deleted")
    .eq("id", personId)
    .maybeSingle();
  if (personError) {
    return json(500, { error: personError.message });
  }
  if (!personRow || personRow.deleted) {
    return json(404, { error: "Person not found" });
  }

  if (personRow.account_id && personRow.account_id !== accountId) {
    return json(409, {
      error: "Profile is already linked to another account. Merge is required.",
    });
  }

  let authorized =
    personRow.account_id === accountId ||
    personRow.created_by_account_id === accountId;

  if (!authorized) {
    const { data: deviceRow, error: deviceError } = await serviceClient
      .from("person_devices")
      .select("id")
      .eq("person_id", personId)
      .eq("device_id", deviceId)
      .maybeSingle();
    if (deviceError) {
      return json(500, { error: deviceError.message });
    }
    authorized = !!deviceRow;
  }

  if (!authorized) {
    return json(403, { error: "You are not allowed to upgrade this profile" });
  }

  const { data: conflictRow, error: conflictError } = await serviceClient
    .from("persons")
    .select("id")
    .eq("account_id", accountId)
    .eq("deleted", false)
    .neq("id", personId)
    .maybeSingle();
  if (conflictError) {
    return json(500, { error: conflictError.message });
  }
  if (conflictRow) {
    return json(409, {
      error: "Account is already linked to another profile. Merge dialog required.",
    });
  }

  const now = new Date().toISOString();
  const { error: updateError } = await serviceClient
    .from("persons")
    .update({
      account_id: accountId,
      profile_type: "account",
      updated_at: now,
      deleted: false,
      dirty: false,
    })
    .eq("id", personId);
  if (updateError) {
    return json(500, { error: updateError.message });
  }

  const { error: cleanupError } = await serviceClient
    .from("person_devices")
    .delete()
    .eq("person_id", personId);
  if (cleanupError) {
    return json(500, { error: cleanupError.message });
  }

  return json(200, {
    person_id: personId,
    account_id: accountId,
    profile_type: "account",
  });
});
