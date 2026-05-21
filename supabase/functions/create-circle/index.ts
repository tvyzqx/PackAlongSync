// create-circle
//
// Authenticated owner spins up an additional circle (Plan 5.2). Typical
// use case: "Wandern mit Mike" — a parallel sync container that doesn't
// leak the user's main household templates. The caller becomes owner of
// the new circle.
//
// Precondition: the caller already has a profile. bootstrap-account
// runs first; if a client somehow lands here without one we surface
// 409 / profile_missing so the UI can route the user back to onboarding.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

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
    const name = stringValue(body?.name);
    const iconEmoji = optionalString(body?.icon_emoji);
    const color = optionalString(body?.color);

    if (!name) {
      return json({ error: "name is required." }, 400);
    }

    const admin = createClient(url, serviceRoleKey, {
      db: { schema: "packalong" },
    });

    // ADR-5: at most one profile per auth user. If there's none the
    // caller skipped bootstrap-account; abort with a distinct code so
    // the client can recover.
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

    return await createCircleAndMembership(admin, callerId, profile.id, {
      name,
      iconEmoji,
      color,
    });
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
  fields: { name: string; iconEmoji: string | null; color: string | null },
): Promise<Response> {
  const insertRow: Record<string, unknown> = {
    name: fields.name,
    created_by: callerId,
  };
  if (fields.iconEmoji !== null) insertRow.icon_emoji = fields.iconEmoji;
  if (fields.color !== null) insertRow.color = fields.color;

  const { data: circle, error: circleError } = await admin
    .from("circles")
    .insert(insertRow)
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
    // Drop the orphan circle so it doesn't pollute the user's circle
    // list or skew owner-default heuristics elsewhere.
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

  return json({ circle_id: circle.id });
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

function optionalString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
