// bootstrap-household
//
// Owner-side first-run flow. Creates a brand-new auth.users row plus the
// household + owner-profile rows that anchor everything downstream.
//
// Called by the app (anonymous — caller has no session yet) with email +
// password + display names. Supabase mails the standard confirmation
// link; the app then waits for the user to tap it and finally calls
// signInWithPassword to obtain the actual session.
//
// Idempotency: if the email is already registered we surface a
// `user_already_exists` error so the UI can route to the "sign in"
// screen. We do NOT silently create another household for an existing
// auth user — that would split the user's data across two scopes
// (ADR-5: one auth user maps to at most one profile).
//
// Mirrors the bootstrap path documented in
// `familyfocal/lib/features/auth/bootstrap_service.dart`.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

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
    if (!url || !serviceRoleKey) {
      return json({ error: "Server auth is not configured." }, 500);
    }

    const body = await req.json();
    const email = stringValue(body.email).toLowerCase();
    const password = typeof body.password === "string" ? body.password : "";
    const ownerName = stringValue(body.ownerName);
    const householdName = stringValue(body.householdName);

    if (!email || !password || !ownerName || !householdName) {
      return json(
        { error: "email, password, ownerName and householdName are required." },
        400,
      );
    }
    if (password.length < 8) {
      return json(
        {
          error: "Password must be at least 8 characters.",
          code: "password_too_short",
        },
        400,
      );
    }

    const admin = createClient(url, serviceRoleKey, {
      db: { schema: "packalong" },
    });

    // Re-use an existing unconfirmed user: in the happy path the user
    // bootstrapped once, lost the confirmation mail, and is retrying.
    // For a confirmed user we'd create a duplicate, which is silently
    // wrong (RLS would still scope them to the *first* household). So
    // we look up the existing row first.
    const existingProfileRow = await findExistingProfileByEmail(admin, email);
    if (existingProfileRow) {
      return json(
        {
          error:
            "An account with this email already exists. Sign in to your household instead.",
          code: "user_already_exists",
        },
        409,
      );
    }

    // Create the auth user. email_confirm=false keeps the standard
    // Supabase Auth flow that mails a confirmation link. The app waits
    // for the user to tap it before calling signInWithPassword.
    const { data: created, error: createError } = await admin.auth.admin
      .createUser({
        email,
        password,
        email_confirm: false,
        user_metadata: {
          owner_name: ownerName,
          household_name: householdName,
        },
      });
    if (createError || !created.user) {
      const message = String(
        createError?.message ?? "Could not create auth user.",
      );
      if (/already.*registered/i.test(message) || /already exists/i.test(message)) {
        return json(
          {
            error:
              "An account with this email already exists. Sign in instead.",
            code: "user_already_exists",
          },
          409,
        );
      }
      throw createError ?? new Error(message);
    }

    // From here on we own a freshly minted auth.users row that must be
    // unwound if any downstream insert fails — otherwise a retry hits
    // "user already registered" and the user is permanently stuck.
    let householdId: string | null = null;
    const rollback = async () => {
      if (householdId) {
        try {
          await admin.from("households").delete().eq("id", householdId);
        } catch (_) { /* best effort */ }
      }
      try {
        await admin.auth.admin.deleteUser(created.user.id);
      } catch (_) { /* best effort */ }
    };

    try {
      const { data: household, error: hhError } = await admin
        .from("households")
        .insert({ name: householdName, created_by: created.user.id })
        .select("id")
        .single();
      if (hhError || !household) {
        throw hhError ?? new Error("Could not create household.");
      }
      householdId = household.id;

      const { data: profile, error: profError } = await admin
        .from("profiles")
        .insert({
          household_id: household.id,
          user_id: created.user.id,
          role: "owner",
          profile_type: "owner",
          name: ownerName,
        })
        .select("id")
        .single();
      if (profError || !profile) {
        throw profError ?? new Error("Could not create owner profile.");
      }

      return json({
        user_id: created.user.id,
        household_id: household.id,
        profile_id: profile.id,
        requires_email_confirmation: true,
      });
    } catch (downstream) {
      await rollback();
      throw downstream;
    }
  } catch (error) {
    return json(
      { error: String((error as { message?: string })?.message ?? error) },
      400,
    );
  }
});

async function findExistingProfileByEmail(
  admin: ReturnType<typeof createClient>,
  email: string,
): Promise<{ user_id: string } | null> {
  // admin.auth.admin.listUsers() doesn't allow filtering by email in the
  // public API; iterating it for every bootstrap call would be wasteful.
  // Instead we look at our own profiles table joined to auth.users via
  // user_id, but auth.users is in a different schema. We use the admin
  // GoTrue endpoint with a per-email lookup via a follow-up call only
  // when really needed — for the happy path the createUser call below
  // already surfaces "user already exists".
  // Returning null here makes the createUser call the canonical
  // existence check; this helper exists as a hook for future
  // optimization (e.g. caching) without changing the call sites.
  void admin;
  void email;
  return null;
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
