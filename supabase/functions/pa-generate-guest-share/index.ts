// generate-guest-share  (deployed as pa-generate-guest-share)
//
// Owner-side counterpart to pa-guest-view (Issue #1). A circle owner mints an
// unguessable, expiring token that renders a public read-only web page of one
// guest's packing list for one trip. Structurally a sibling of
// generate-circle-invite: verify the caller owns the circle, validate the
// target, retire stale tokens, insert a fresh row, return a URL.
//
// Two shapes depending on the guest profile's email (added in migration 019):
//   * guest HAS an email  -> we additionally coin an email-bound companion
//     circle_invite (preassigned_profile_id = guest, email_target = email,
//     invited_role = 'member'). The guest page shows a "get the app & join"
//     button pointing at /claim/<companion_token>. Because the invite is
//     email-bound, join-circle only admits a caller who authenticates as that
//     address — the public link alone is not a bearer credential.
//   * guest has NO email  -> no companion invite; the page shows only an
//     app-download link.
//
// The share link itself is served by service role in pa-guest-view, never via
// RLS, so guest_share_links rows are opaque to the anon role.

import {
  createPackalongAdmin,
  type PackalongClient,
} from "../_shared/packalong_client.ts";

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
    // SUPABASE_PUBLIC_URL is the internet-reachable origin (e.g.
    // https://api.7-tm.de); on managed Supabase it equals SUPABASE_URL.
    const publicUrl = Deno.env.get("SUPABASE_PUBLIC_URL") ?? url;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
    const authHeader = req.headers.get("Authorization") ?? "";
    const jwt = authHeader.replace(/^Bearer\s+/i, "").trim();
    if (!url || !serviceRoleKey || !jwt) {
      return json({ error: "Server auth is not configured." }, 500);
    }

    const admin = createPackalongAdmin(url, serviceRoleKey);

    const { data: userData, error: userError } = await admin.auth.getUser(jwt);
    if (userError || !userData.user) {
      return json({ error: "Unauthorized" }, 401);
    }
    const callerId = userData.user.id;

    const body = await req.json().catch(() => null);
    const tripId = stringValue(body?.trip_id) || stringValue(body?.tripId);
    const profileId = stringValue(body?.profile_id) ||
      stringValue(body?.profileId);
    if (!tripId) return json({ error: "trip_id is required." }, 400);
    if (!profileId) return json({ error: "profile_id is required." }, 400);

    // Resolve the trip -> its circle. The share is trip-scoped; ownership is
    // circle-scoped, so we derive circle_id from the trip rather than trusting
    // the caller to pass it.
    const { data: trip, error: tripError } = await admin
      .from("trips")
      .select("id, circle_id, deleted")
      .eq("id", tripId)
      .maybeSingle();
    if (tripError) throw tripError;
    if (!trip || trip.deleted) {
      return json({ error: "Trip not found." }, 404);
    }
    const circleId = trip.circle_id as string;

    // Owner check. is_circle_owner(uuid) runs against auth.uid(), which is
    // NULL under the service-role client, so resolve membership explicitly
    // (same approach as generate-circle-invite).
    const ownerCheck = await assertCallerIsCircleOwner(admin, callerId, circleId);
    if (!ownerCheck.ok) {
      return json({ error: ownerCheck.error, code: ownerCheck.code }, ownerCheck.status);
    }

    // Validate the target guest: unclaimed profile that actually participates
    // in this trip.
    const guestCheck = await assertShareableGuest(admin, profileId, tripId);
    if (!guestCheck.ok) {
      return json({ error: guestCheck.error, code: guestCheck.code }, guestCheck.status);
    }
    const guestEmail = guestCheck.email;

    const ttlDays = parseTtlDays();
    const expiresAt = ttlDays > 0
      ? new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000)
      : null;

    // Hygiene: revoke any still-open share link for this (profile, trip), and
    // consume the companion invite it carried, before minting a new one.
    await retireOpenShareLinks(admin, profileId, tripId);

    // Coin an email-bound companion invite only when the guest has an email.
    let companionInviteToken: string | null = null;
    if (guestEmail) {
      companionInviteToken = crypto.randomUUID() + "." + randomToken(32);
      const { error: inviteError } = await admin.from("circle_invites").insert({
        token: companionInviteToken,
        circle_id: circleId,
        preassigned_profile_id: profileId,
        issued_by: callerId,
        expires_at: (expiresAt ?? defaultInviteExpiry()).toISOString(),
        delivery_channel: "email",
        email_target: guestEmail,
        invited_role: "member",
      });
      if (inviteError) throw inviteError;
    }

    const token = crypto.randomUUID() + "." + randomToken(32);
    const { error: insertError } = await admin.from("guest_share_links").insert({
      token,
      trip_id: tripId,
      profile_id: profileId,
      circle_id: circleId,
      issued_by: callerId,
      expires_at: expiresAt ? expiresAt.toISOString() : null,
      companion_invite_token: companionInviteToken,
    });
    if (insertError) throw insertError;

    const viewPath = Deno.env.get("GUEST_VIEW_FUNCTION") ?? "pa-guest-view";
    const shareUrl =
      `${publicUrl.replace(/\/$/, "")}/functions/v1/${viewPath}?token=${encodeURIComponent(token)}`;
    const joinUrl = companionInviteToken
      ? buildClaimUniversalLink(companionInviteToken)
      : null;

    return json({
      token,
      url: shareUrl,
      expires_at: expiresAt ? expiresAt.toISOString() : null,
      expiresAt: expiresAt ? expiresAt.toISOString() : null,
      join_url: joinUrl,
      joinUrl,
      companion_invite_token: companionInviteToken,
      companionInviteToken,
      trip_id: tripId,
      profile_id: profileId,
      circle_id: circleId,
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

// helpers -----------------------------------------------------------------

type OwnerSuccess = { ok: true; profileId: string };
type CheckFailure = { ok: false; status: number; error: string; code?: string };

async function assertCallerIsCircleOwner(
  admin: PackalongClient,
  callerId: string,
  circleId: string,
): Promise<OwnerSuccess | CheckFailure> {
  const { data: callerProfile, error: callerError } = await admin
    .from("profiles")
    .select("id")
    .eq("user_id", callerId)
    .eq("deleted", false)
    .maybeSingle();
  if (callerError) {
    return { ok: false, status: 500, error: String(callerError.message) };
  }
  if (!callerProfile) {
    return {
      ok: false,
      status: 409,
      error: "No profile exists for this auth user.",
      code: "profile_missing",
    };
  }

  const { data: membership, error: membershipError } = await admin
    .from("circle_members")
    .select("role")
    .eq("circle_id", circleId)
    .eq("profile_id", callerProfile.id)
    .eq("deleted", false)
    .maybeSingle();
  if (membershipError) {
    return { ok: false, status: 500, error: String(membershipError.message) };
  }
  if (!membership || membership.role !== "owner") {
    return {
      ok: false,
      status: 403,
      error: "Only a circle owner can share a guest view.",
      code: "not_circle_owner",
    };
  }
  return { ok: true, profileId: callerProfile.id };
}

type GuestSuccess = { ok: true; email: string | null };

async function assertShareableGuest(
  admin: PackalongClient,
  profileId: string,
  tripId: string,
): Promise<GuestSuccess | CheckFailure> {
  const { data: guest, error: guestError } = await admin
    .from("profiles")
    .select("id, user_id, email, deleted")
    .eq("id", profileId)
    .maybeSingle();
  if (guestError) {
    return { ok: false, status: 500, error: String(guestError.message) };
  }
  if (!guest || guest.deleted) {
    return { ok: false, status: 404, error: "Guest profile not found." };
  }
  if (guest.user_id !== null) {
    return {
      ok: false,
      status: 409,
      error: "Profile is already linked to an account, not a guest.",
      code: "profile_not_guest",
    };
  }

  // The guest must actually be on this trip.
  const { data: participant, error: participantError } = await admin
    .from("participants")
    .select("id")
    .eq("trip_id", tripId)
    .eq("person_id", profileId)
    .eq("deleted", false)
    .maybeSingle();
  if (participantError) {
    return { ok: false, status: 500, error: String(participantError.message) };
  }
  if (!participant) {
    return {
      ok: false,
      status: 403,
      error: "Guest is not a participant of this trip.",
      code: "guest_not_in_trip",
    };
  }

  const email = typeof guest.email === "string" && guest.email.trim().length > 0
    ? guest.email.trim().toLowerCase()
    : null;
  return { ok: true, email };
}

async function retireOpenShareLinks(
  admin: PackalongClient,
  profileId: string,
  tripId: string,
): Promise<void> {
  const { data: openLinks, error: selectError } = await admin
    .from("guest_share_links")
    .select("token, companion_invite_token")
    .eq("profile_id", profileId)
    .eq("trip_id", tripId)
    .is("revoked_at", null);
  if (selectError) throw selectError;
  if (!openLinks || openLinks.length === 0) return;

  const now = new Date().toISOString();
  const { error: revokeError } = await admin
    .from("guest_share_links")
    .update({ revoked_at: now })
    .eq("profile_id", profileId)
    .eq("trip_id", tripId)
    .is("revoked_at", null);
  if (revokeError) throw revokeError;

  // Consume the companion invites that backed the now-revoked links so their
  // "join" buttons stop working alongside the page.
  const staleInviteTokens = openLinks
    .map((l) => l.companion_invite_token)
    .filter((t): t is string => typeof t === "string" && t.length > 0);
  if (staleInviteTokens.length > 0) {
    const { error: consumeError } = await admin
      .from("circle_invites")
      .update({ consumed_at: now })
      .in("token", staleInviteTokens)
      .is("consumed_at", null);
    if (consumeError) throw consumeError;
  }
}

function parseTtlDays(): number {
  const raw = Deno.env.get("GUEST_SHARE_TTL_DAYS");
  const parsed = raw ? Number(raw) : NaN;
  // 0 (or negative) means "no expiry"; default 30 days.
  if (raw != null && Number.isFinite(parsed) && parsed >= 0) return parsed;
  return 30;
}

function defaultInviteExpiry(): Date {
  // Fallback when the share link itself never expires: keep the companion
  // invite generous but bounded (90 days) so a stale email-bound invite does
  // not live forever.
  return new Date(Date.now() + 90 * 24 * 60 * 60 * 1000);
}

function buildClaimUniversalLink(token: string): string {
  const host = Deno.env.get("PUBLIC_APP_HOST") ?? "packalong.org";
  return `https://${host}/claim/${token}`;
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

function randomToken(bytes: number): string {
  const data = new Uint8Array(bytes);
  crypto.getRandomValues(data);
  return btoa(String.fromCharCode(...data))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
