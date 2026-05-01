import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
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

  if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
    return json(500, { error: "Supabase environment is not configured" });
  }

  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  const payload = await request.json().catch(() => null);
  const claimToken = typeof payload?.claim_token === "string" ? payload.claim_token.trim() : "";
  const deviceId = typeof payload?.device_id === "string" ? payload.device_id.trim() : "";

  if (!claimToken || !deviceId) {
    return json(400, { error: "claim_token and device_id are required" });
  }

  const nowIso = new Date().toISOString();
  const { data: claimRow, error: claimError } = await supabase
    .from("person_claims")
    .select("id, person_id, used, expires_at")
    .eq("claim_token", claimToken)
    .eq("used", false)
    .gt("expires_at", nowIso)
    .maybeSingle();

  if (claimError) {
    return json(500, { error: claimError.message });
  }
  if (!claimRow) {
    return json(404, { error: "Claim token is invalid or expired" });
  }

  const accessToken = crypto.randomUUID();
  const now = new Date().toISOString();

  const { error: deviceError } = await supabase
    .from("person_devices")
    .upsert(
      {
        id: crypto.randomUUID(),
        person_id: claimRow.person_id,
        device_id: deviceId,
        access_token: accessToken,
        created_at: now,
      },
      { onConflict: "person_id,device_id" },
    );

  if (deviceError) {
    return json(500, { error: deviceError.message });
  }

  const { error: markUsedError } = await supabase
    .from("person_claims")
    .update({ used: true })
    .eq("id", claimRow.id);

  if (markUsedError) {
    return json(500, { error: markUsedError.message });
  }

  const { data: personRow, error: personError } = await supabase
    .from("persons")
    .select("id, name")
    .eq("id", claimRow.person_id)
    .maybeSingle();

  if (personError) {
    return json(500, { error: personError.message });
  }

  return json(200, {
    person_id: claimRow.person_id,
    person_name: personRow?.name ?? null,
    access_token: accessToken,
  });
});
