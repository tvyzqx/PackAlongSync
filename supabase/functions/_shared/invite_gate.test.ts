// Tests for the circle-invite join gate (ADR-13 / Issue #1 guest-share).
//
// Run:  deno test supabase/functions/_shared/invite_gate.test.ts
//
// The three product cases:
//   1) Guest WITH a stored email -> joining works, but only for someone who
//      proves possession of that email (the companion invite is channel
//      'email'). The public guest-view still shows their items regardless.
//   2) Guest WITHOUT a stored email -> no companion invite is minted, so any
//      stray token is view-only; the gate refuses to turn it into a join.
//   3) In-person QR -> may be redeemed anonymously (physical trust).

import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { evaluateJoinGate } from "./invite_gate.ts";

Deno.test("case 1: email-bound invite, caller proves the email -> allow", () => {
  const result = evaluateJoinGate({
    deliveryChannel: "email",
    emailTarget: "jane@example.com",
    callerEmail: "jane@example.com",
  });
  assertEquals(result, { allow: true });
});

Deno.test("case 1: email match is case-insensitive and trimmed", () => {
  const result = evaluateJoinGate({
    deliveryChannel: "email",
    emailTarget: "jane@example.com",
    callerEmail: "  JANE@Example.com ",
  });
  assertEquals(result.allow, true);
});

Deno.test("case 1: wrong signed-in email -> email_mismatch 403", () => {
  const result = evaluateJoinGate({
    deliveryChannel: "email",
    emailTarget: "jane@example.com",
    callerEmail: "eve@evil.com",
  });
  assertEquals(result.allow, false);
  if (!result.allow) {
    assertEquals(result.code, "email_mismatch");
    assertEquals(result.status, 403);
  }
});

Deno.test("case 1: public companion token, no session -> email_verification_required 401", () => {
  // The companion token is exposed on the public guest-view page. An anonymous
  // caller who grabbed it must still prove they own the bound email.
  const result = evaluateJoinGate({
    deliveryChannel: "email",
    emailTarget: "jane@example.com",
    callerEmail: null,
  });
  assertEquals(result.allow, false);
  if (!result.allow) {
    assertEquals(result.code, "email_verification_required");
    assertEquals(result.status, 401);
  }
});

Deno.test("case 2: forwardable invite without a bound email is view-only -> invite_not_joinable 403", () => {
  const result = evaluateJoinGate({
    deliveryChannel: "email",
    emailTarget: null,
    callerEmail: "someone@example.com",
  });
  assertEquals(result.allow, false);
  if (!result.allow) {
    assertEquals(result.code, "invite_not_joinable");
    assertEquals(result.status, 403);
  }
});

Deno.test("case 2: forwardable invite without a bound email is NOT anonymously joinable", () => {
  // Critical regression guard against the old anonymous-provisioning hole.
  const result = evaluateJoinGate({
    deliveryChannel: "email",
    emailTarget: null,
    callerEmail: null,
  });
  assertEquals(result.allow, false);
});

Deno.test("case 3: in-person QR, anonymous caller -> allow", () => {
  const result = evaluateJoinGate({
    deliveryChannel: "qr",
    emailTarget: null,
    callerEmail: null,
  });
  assertEquals(result, { allow: true });
});

Deno.test("case 3: in-person QR with an existing session -> allow", () => {
  const result = evaluateJoinGate({
    deliveryChannel: "qr",
    emailTarget: null,
    callerEmail: "member@example.com",
  });
  assertEquals(result, { allow: true });
});
