v3-Pivot auf Circles n:m, 2026-05-21.

Diese v2-Edge-Functions (households 1:1) wurden nie deployed und sind durch
v3-Versionen ersetzt:

  bootstrap-household         -> bootstrap-account
  generate-household-invite   -> generate-circle-invite
  join-household              -> join-circle
  check-join-status           -> check-join-status (Tabelle circle_invites)

Zusätzlich archiviert (P3.9, 2026-05-21): die beiden Trip-Invite-Functions
aus v1/v2. ADR-8 v3 löst Trip-Sharing in Circle-Sharing auf — wer in einem
Trip mitarbeiten soll, wird Circle-Mitglied, nicht Trip-Mitglied:

  generate-join-token         -> (deprecated; keine v3-Entsprechung)
  join-trip                   -> (deprecated; keine v3-Entsprechung)

Sie bleiben hier als Stilreferenz erhalten — siehe
`docs/profile-sync-plan.md` Kapitel 10.
