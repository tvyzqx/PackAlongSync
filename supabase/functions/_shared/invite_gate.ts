// invite_gate.ts
//
// Pure, side-effect-free decision logic for who may redeem a circle invite
// (ADR-13 / Issue #1 guest-share hardening). Kept separate from the
// pa-join-circle handler so it can be unit-tested deterministically and so the
// security invariant lives in exactly one place.
//
// The invariant, in one sentence: only an in-person 'qr' invite may be
// redeemed anonymously; every forwardable channel ('link'/'email' — e.g. the
// email-bound companion invite behind a public guest-view page) must present a
// verified session whose email equals the invite's bound address.
//
// Why this matters for guest-view: pa-guest-view renders the companion
// invite's /claim/<token> as a public "join" button, so the token is exposed
// to anyone who opens the page. Redemption therefore CANNOT be a bearer
// capability — it must prove ownership of the bound email (via the OTP /
// magic-link flow), which this gate enforces by refusing the anonymous path
// for any non-'qr' invite.

export type JoinGateResult =
  | { allow: true }
  | { allow: false; code: string; status: number; error: string };

/**
 * Decide whether a caller may redeem an invite.
 *
 * [callerEmail] is the *verified* email of the caller's session (from the JWT),
 * or null when the caller is anonymous / has no session. For 'qr' the caller
 * is trusted by physical proximity, so anonymous is fine. For any forwardable
 * channel the caller must be signed in as exactly the bound address.
 */
export function evaluateJoinGate(params: {
  deliveryChannel: string;
  emailTarget: string | null;
  callerEmail: string | null;
}): JoinGateResult {
  const channel = (params.deliveryChannel ?? "").toLowerCase();
  const emailTarget = (params.emailTarget ?? "").trim().toLowerCase();
  const callerEmail = (params.callerEmail ?? "").trim().toLowerCase();

  // In-person QR: physical trust, may mint an anonymous account.
  if (channel === "qr") return { allow: true };

  // Forwardable link/email: prove possession of the bound address.
  if (callerEmail.length === 0) {
    return {
      allow: false,
      code: "email_verification_required",
      status: 401,
      error:
        "This invite is bound to an email. Verify that email first, then redeem the invite.",
    };
  }
  // A forwardable invite that was never bound to an address is view-only and
  // can never become a membership.
  if (emailTarget.length === 0) {
    return {
      allow: false,
      code: "invite_not_joinable",
      status: 403,
      error: "This invite cannot be joined — it is view-only.",
    };
  }
  if (callerEmail !== emailTarget) {
    return {
      allow: false,
      code: "email_mismatch",
      status: 403,
      error:
        "You are signed in with a different email than this invite was sent to.",
    };
  }
  // Email-bound and the caller proved they own it.
  return { allow: true };
}
