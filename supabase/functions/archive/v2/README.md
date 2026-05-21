v3-Pivot auf Circles n:m, 2026-05-21.

Diese v2-Edge-Functions (households 1:1) wurden nie deployed und sind durch
v3-Versionen ersetzt:

  bootstrap-household         -> bootstrap-account
  generate-household-invite   -> generate-circle-invite
  join-household              -> join-circle
  check-join-status           -> check-join-status (Tabelle circle_invites)

Sie bleiben hier als Stilreferenz erhalten — siehe
`docs/profile-sync-plan.md` Kapitel 10.
