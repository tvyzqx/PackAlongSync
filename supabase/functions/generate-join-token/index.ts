import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const DEFAULT_JOIN_TOKEN_TTL_MINUTES = 60 * 24 * 7;

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

function readJoinTokenTtlMinutes(): number {
  const raw = Deno.env.get("JOIN_TOKEN_TTL_MINUTES");
  if (!raw || raw.trim().length === 0) {
    return DEFAULT_JOIN_TOKEN_TTL_MINUTES;
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return DEFAULT_JOIN_TOKEN_TTL_MINUTES;
  }
  return parsed;
}

Deno.serve(async (request) => {
  if (request.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (request.method !== "POST") {
    return json(405, { error: "Method not allowed" });
  }
  if (!SUPABASE_URL || !ANON_KEY) {
    return json(500, { error: "Supabase environment is not configured" });
  }

  const authHeader = request.headers.get("Authorization") ?? "";
  const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!jwt) {
    return json(401, { error: "Missing bearer token" });
  }

  const payload = await request.json().catch(() => null);
  const tripId = typeof payload?.trip_id === "string" ? payload.trip_id.trim() : "";
  if (!tripId) {
    return json(400, { error: "trip_id is required" });
  }

  const supabase = createClient(SUPABASE_URL, ANON_KEY, {
    global: {
      headers: {
        Authorization: `Bearer ${jwt}`,
      },
    },
  });

  const { data: userData, error: userError } = await supabase.auth.getUser(jwt);
  if (userError || !userData?.user) {
    return json(401, { error: "Invalid owner session" });
  }

  // RLS ensures only trips the owner can edit are visible/updateable.
  const { data: tripRow, error: tripError } = await supabase
    .from("trips")
    .select("id")
    .eq("id", tripId)
    .eq("deleted", false)
    .maybeSingle();
  if (tripError) {
    return json(500, { error: tripError.message });
  }
  if (!tripRow) {
    return json(404, { error: "Trip not found or not accessible" });
  }

  const joinToken = crypto.randomUUID();
  const ttlMinutes = readJoinTokenTtlMinutes();
  const joinTokenExpiresAt = new Date(Date.now() + ttlMinutes * 60_000).toISOString();
  const now = new Date().toISOString();
  const { error: updateError } = await supabase
    .from("trips")
    .update({
      join_token: joinToken,
      join_token_expires_at: joinTokenExpiresAt,
      updated_at: now,
      deleted: false,
    })
    .eq("id", tripId);

  if (updateError) {
    return json(500, { error: updateError.message });
  }

  return json(200, {
    trip_id: tripId,
    join_token: joinToken,
    expires_at: joinTokenExpiresAt,
    ttl_minutes: ttlMinutes,
  });
});
