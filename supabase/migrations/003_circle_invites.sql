-- 003_circle_invites.sql
--
-- Single-use invitation tokens for circle onboarding (ADR-6, ADR-13).
-- Two channels:
--   'qr'    — in-person scan, TTL ~10 minutes, payload base64-encoded as
--             part of packalong://circle?payload=...
--   'email' — magic-link via auth.admin.inviteUserByEmail, TTL ~7 days,
--             redirect lands at https://packalong.org/claim/<token>.
-- TTL itself is enforced inside generate-circle-invite; the column
-- documents which channel a token belongs to (audit + reissue logic).
--
-- v3 differences vs. v2/join_tokens (archived under migrations/archive/v2/):
--   * anchored on circle_id (top-level n:m container) instead of household_id
--   * new invited_role column so an invite can carry a non-default role
--     (e.g. invite a child as viewer)
--   * preassigned_profile_id still optional; a bare invite creates a fresh
--     profile on claim, a preassigned one upgrades that guest profile.

create table packalong.circle_invites (
  token                   text primary key,
  circle_id               uuid not null references packalong.circles(id) on delete cascade,
  preassigned_profile_id  uuid references packalong.profiles(id) on delete set null,
  issued_by               uuid not null references auth.users(id) on delete cascade,
  issued_at               timestamptz not null default now(),
  expires_at              timestamptz not null,
  consumed_at             timestamptz,
  consumed_by             uuid references auth.users(id) on delete set null,

  delivery_channel        text not null default 'qr'
                                check (delivery_channel in ('qr', 'email')),
  email_target            text,
  invited_role            text not null default 'member'
                                check (invited_role in ('owner', 'member', 'viewer'))
);

-- generate-circle-invite looks up active tokens by string; the partial
-- index keeps it cheap as the table accumulates consumed rows.
create index circle_invites_active_idx
  on packalong.circle_invites (token)
  where consumed_at is null;

create index circle_invites_circle_idx
  on packalong.circle_invites (circle_id);

-- Token hygiene: generate-circle-invite closes open tokens for the same
-- (profile, circle) pair before issuing a new one. Partial index supports
-- that lookup.
create index circle_invites_open_by_profile_idx
  on packalong.circle_invites (preassigned_profile_id)
  where consumed_at is null;

-- RLS: any circle owner sees and creates invites for their circle.
-- update + delete stay service-role-only (token consumption happens in the
-- join-circle edge function).

alter table packalong.circle_invites enable row level security;

create policy circle_invites_select_owner
  on packalong.circle_invites
  for select
  to authenticated
  using (packalong.is_circle_owner(circle_id));

create policy circle_invites_insert_owner
  on packalong.circle_invites
  for insert
  to authenticated
  with check (packalong.is_circle_owner(circle_id));
