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

  const payload = await request.json().catch(() => null);
  const joinToken = typeof payload?.join_token === "string" ? payload.join_token.trim() : "";
  const personId = typeof payload?.person_id === "string" ? payload.person_id.trim() : "";
  if (!joinToken || !personId) {
    return json(400, { error: "join_token and person_id are required" });
  }

  const authHeader = request.headers.get("Authorization") ?? "";
  const token = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!token) {
    return json(401, { error: "Missing authorization token" });
  }

  const anonClient = createClient(SUPABASE_URL, ANON_KEY);
  const serviceClient = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

  let authorized = false;

  const { data: userData } = await anonClient.auth.getUser(token);
  if (userData?.user) {
    const { data: personRow } = await serviceClient
      .from("persons")
      .select("id")
      .eq("id", personId)
      .or(`account_id.eq.${userData.user.id},created_by_account_id.eq.${userData.user.id}`)
      .eq("deleted", false)
      .maybeSingle();
    authorized = !!personRow;
  }

  if (!authorized) {
    const { data: deviceRow } = await serviceClient
      .from("person_devices")
      .select("id")
      .eq("person_id", personId)
      .eq("access_token", token)
      .maybeSingle();
    authorized = !!deviceRow;
  }

  if (!authorized) {
    return json(401, { error: "Not authorized for this person_id" });
  }

  const { data: tripRow, error: tripError } = await serviceClient
    .from("trips")
    .select("id, join_token_expires_at")
    .eq("join_token", joinToken)
    .eq("deleted", false)
    .maybeSingle();
  if (tripError) {
    return json(500, { error: tripError.message });
  }
  if (!tripRow) {
    return json(404, { error: "Trip not found for join_token" });
  }
  if (tripRow.join_token_expires_at) {
    const expiresAt = Date.parse(tripRow.join_token_expires_at);
    if (!Number.isNaN(expiresAt) && expiresAt <= Date.now()) {
      return json(410, { error: "Join token expired" });
    }
  }

  const now = new Date().toISOString();
  const participantId = crypto.randomUUID();
  const { error: participantError } = await serviceClient
    .from("participants")
    .upsert(
      {
        id: participantId,
        trip_id: tripRow.id,
        person_id: personId,
        role: "guest",
        join_type: "qr",
        joined_at: now,
        created_at: now,
        updated_at: now,
        dirty: false,
        deleted: false,
      },
      { onConflict: "trip_id,person_id" },
    );

  if (participantError) {
    return json(500, { error: participantError.message });
  }

  return json(200, {
    trip_id: tripRow.id,
    participant_id: participantId,
  });
});
