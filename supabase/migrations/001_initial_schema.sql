-- 001_initial_schema.sql
--
-- Phase 1 of the PackAlong sync rollout (v3 — Circles n:m, 2026-05-21).
-- Creates the three core tables circles, profiles, and circle_members in
-- the dedicated `packalong` schema (ADR-1).
--
-- Prerequisites (P1.0, applied manually by the server admin once):
--   create schema if not exists packalong;
--   grant usage on schema packalong to anon, authenticated, service_role;
--   alter default privileges in schema packalong
--     grant all on tables, sequences, functions to anon, authenticated, service_role;
--   PGRST_DB_SCHEMAS must include 'packalong'.
--
-- This migration assumes the schema exists. RLS policies live in
-- 002_rls_policies.sql.

-- updated_at maintenance ----------------------------------------------------
--
-- LWW conflict resolution downstream (profile sync, entity sync) relies on
-- updated_at being monotonic on UPDATE. We don't trust clients to set it, so
-- a trigger does it server-side. Defined once, reused across tables.

create or replace function packalong.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- circles -------------------------------------------------------------------
--
-- Top-level sync and visibility boundary (ADR-2). UI label: "Gruppe".
-- A profile is a member of N circles via circle_members (n:m). Patchwork
-- (one person in multiple families) is a day-one feature.

create table packalong.circles (
  id          uuid primary key default gen_random_uuid(),
  name        text not null,
  icon_emoji  text,
  color       text,
  created_by  uuid not null references auth.users(id) on delete restrict,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index circles_created_by_idx on packalong.circles (created_by);

create trigger circles_set_updated_at
  before update on packalong.circles
  for each row execute function packalong.set_updated_at();

-- profiles ------------------------------------------------------------------
--
-- A person's identity. UI label: "Person". ADR-5: one auth user maps to
-- at most one profile (partial unique index ignores guest profiles where
-- user_id is null). Guest profiles can be claimed later by setting user_id
-- and flipping profile_type to 'account'.
--
-- No circle_id here (v2 -> v3 pivot). Circle membership lives in
-- circle_members so a profile can belong to N circles simultaneously.

create table packalong.profiles (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid references auth.users(id) on delete set null,
  profile_type     text not null default 'guest'
                       check (profile_type in ('guest', 'account')),
  name             text not null,
  avatar_emoji     text,
  avatar_color     text,
  origin_instance  text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  synced_at        timestamptz,
  dirty            boolean not null default false,
  dirty_fields     text,
  deleted          boolean not null default false
);

-- ADR-5: one supabase user -> at most one profile. Partial index ignores
-- guest rows (user_id null) waiting for a claim.
create unique index profiles_user_id_unique
  on packalong.profiles (user_id)
  where user_id is not null;

create trigger profiles_set_updated_at
  before update on packalong.profiles
  for each row execute function packalong.set_updated_at();

-- circle_members ------------------------------------------------------------
--
-- n:m membership between profiles and circles (ADR-2). Role is per
-- membership, so the same person can be owner in their family circle and
-- member in a friend-trip circle.

create table packalong.circle_members (
  circle_id        uuid not null references packalong.circles(id) on delete cascade,
  profile_id       uuid not null references packalong.profiles(id) on delete cascade,
  role             text not null default 'member'
                       check (role in ('owner', 'member', 'viewer')),
  joined_at        timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  synced_at        timestamptz,
  dirty            boolean not null default false,
  dirty_fields     text,
  deleted          boolean not null default false,
  origin_instance  text,
  primary key (circle_id, profile_id)
);

create index circle_members_profile_idx
  on packalong.circle_members (profile_id) where deleted = false;
create index circle_members_circle_idx
  on packalong.circle_members (circle_id) where deleted = false;

create trigger circle_members_set_updated_at
  before update on packalong.circle_members
  for each row execute function packalong.set_updated_at();
