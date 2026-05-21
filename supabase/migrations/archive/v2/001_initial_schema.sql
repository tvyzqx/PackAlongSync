-- 001_initial_schema.sql
--
-- Phase 1 of the PackAlong sync rollout (v2 — FFS-style schema isolation).
-- Creates the two core tables households and profiles in the dedicated
-- packalong schema (ADR-1).
--
-- The v1 migrations (now under migrations/archive/v1/) operated on the
-- public schema and were never applied to a production DB. v2 is a clean
-- cut — do not mix v1 and v2 against the same database.
--
-- Prerequisites (applied manually by the server admin once, before this
-- migration runs):
--   create schema if not exists packalong;
--   grant usage on schema packalong to anon, authenticated, service_role;
--   alter default privileges in schema packalong
--     grant all on tables, sequences, functions to anon, authenticated, service_role;
--   PGRST_DB_SCHEMAS in supabase/docker/.env must include 'packalong'.
--
-- This migration assumes the schema exists. RLS policies live in
-- 002_rls_policies.sql.

-- updated_at maintenance --------------------------------------------------
--
-- LWW conflict resolution downstream (profile sync, entity sync) relies on
-- updated_at being monotonic on UPDATE. Trigger is defined once and reused
-- across all sync tables that follow in migrations 005+.

create or replace function packalong.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- households --------------------------------------------------------------
--
-- ADR-2: grouping entity. Every profile (and downstream every trip, item,
-- template, tag, …) is anchored on exactly one household. RLS uses
-- households.id as the canonical access boundary.
--
-- Unlike FamilyFocal (parent / child roles, can_see_* visibility flags),
-- PackAlong has a flat role space — see migration 001 of profiles below.

create table packalong.households (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  created_by  uuid not null references auth.users(id) on delete restrict,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index households_created_by_idx on packalong.households (created_by);

create trigger households_set_updated_at
  before update on packalong.households
  for each row execute function packalong.set_updated_at();

-- profiles ----------------------------------------------------------------
--
-- ADR-3: flat role space. Two values only:
--   'owner'  — bootstrap user, can issue invites, manage household structure.
--   'member' — claimed guest profile or self-onboarded household member.
--
-- profile_type tracks the auth-status of the row:
--   'owner'   — created by bootstrap-household, user_id is set from the start.
--   'guest'   — created by owner, no auth identity yet (user_id IS NULL).
--   'account' — guest profile that has been claimed via join-household,
--               user_id is now linked.
--
-- Sync columns (synced_at, dirty, dirty_fields, deleted, origin_instance)
-- are present because profiles participates in the LWW push/pull loop
-- alongside the entity tables added in migrations 005+.

create table packalong.profiles (
  id                 uuid primary key default gen_random_uuid(),
  household_id       uuid not null references packalong.households(id) on delete cascade,
  user_id            uuid references auth.users(id) on delete set null,
  role               text not null default 'member' check (role in ('owner', 'member')),
  profile_type       text not null default 'guest' check (profile_type in ('owner', 'guest', 'account')),
  name               text not null,
  avatar_emoji       text,
  avatar_color       text,
  origin_instance    text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  synced_at          timestamptz,
  dirty              boolean not null default false,
  dirty_fields       text,
  deleted            boolean not null default false
);

create index profiles_household_id_idx
  on packalong.profiles (household_id)
  where deleted = false;

create index profiles_user_id_idx
  on packalong.profiles (user_id);

-- ADR-5: a single supabase user maps to at most one profile across all
-- households. Partial index ignores guest rows where user_id is null
-- (preassigned profiles waiting for a claim).
create unique index profiles_user_id_unique
  on packalong.profiles (user_id)
  where user_id is not null;

create trigger profiles_set_updated_at
  before update on packalong.profiles
  for each row execute function packalong.set_updated_at();
