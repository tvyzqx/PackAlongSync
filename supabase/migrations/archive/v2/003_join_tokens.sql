-- 003_join_tokens.sql
--
-- Single-use invitation tokens for household onboarding (ADR-6, ADR-13).
-- Two channels:
--   'qr'    — in-person scan, TTL ~10 minutes, payload base64-encoded as
--             part of packalong://household?payload=... (FFS-style).
--   'email' — magic-link via auth.admin.inviteUserByEmail, TTL ~7 days,
--             redirect lands at https://packalong.org/claim/<token>.
-- TTL itself is enforced inside generate-household-invite; the column
-- documents which channel a token belongs to (audit + reissue logic).
--
-- This table replaces v1's person_claims (now archived under
-- migrations/archive/v1/). The v1 model assumed Person-bound device
-- tokens; v2 anchors invites on households and uses Supabase auth users
-- as the identity primitive — see ADR-5.

create table packalong.join_tokens (
  token                   text primary key,
  household_id            uuid not null references packalong.households(id) on delete cascade,
  preassigned_profile_id  uuid references packalong.profiles(id) on delete set null,
  issued_by               uuid not null references auth.users(id) on delete cascade,
  issued_at               timestamptz not null default now(),
  expires_at              timestamptz not null,
  consumed_at             timestamptz,
  consumed_by             uuid references auth.users(id) on delete set null,

  delivery_channel        text not null default 'qr'
                                check (delivery_channel in ('qr', 'email')),
  email_target            text
);

create index join_tokens_household_id_idx
  on packalong.join_tokens (household_id);

create index join_tokens_expires_at_idx
  on packalong.join_tokens (expires_at);

-- Token hygiene: generate-household-invite closes open tokens for the
-- same profile before issuing a new one. Partial index keeps that lookup
-- cheap as the table accumulates consumed rows.
create index join_tokens_open_by_profile_idx
  on packalong.join_tokens (preassigned_profile_id)
  where consumed_at is null;

-- RLS: owners see and create their own tokens; nobody else reads them.
-- update + delete stay service-role-only (token consumption happens in
-- the join-household edge function).

alter table packalong.join_tokens enable row level security;

create policy join_tokens_select_issuer
  on packalong.join_tokens
  for select
  to authenticated
  using (issued_by = auth.uid());

create policy join_tokens_insert_issuer
  on packalong.join_tokens
  for insert
  to authenticated
  with check (issued_by = auth.uid());
