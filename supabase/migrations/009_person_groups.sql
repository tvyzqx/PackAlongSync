-- 009_person_groups.sql
--
-- Phase 3 step 5 of 6: person bundles ("Eltern", "Kinder", "ganze
-- Familie") used for item assignment within a circle. Mirrors
--   packalong/lib/db/tables/groups.dart
--   packalong/lib/db/tables/group_members.dart
--
-- Naming caveat (ADR-15): `packalong.groups` is the inner person-bundle
-- table — NOT the top-level circle. The UI label is „Personenbündel".
-- The Drift code uses `groups`/`group_members` already and we don't
-- rename them; the DB namespace is unambiguous.
--
-- Sync anchor: groups carries circle_id directly. group_members
-- inherits scope via group_id (RLS bridges in 011).
--
-- This migration also retro-fits the trips.group_id FK that was left
-- bare in 005 (chicken-and-egg ordering — trips ships before groups).

-- groups -------------------------------------------------------------------

create table packalong.groups (
  id              uuid primary key,
  circle_id       uuid not null references packalong.circles(id) on delete cascade,
  name            text not null,
  icon            text,
  origin_instance text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  synced_at       timestamptz,
  dirty           boolean not null default false,
  dirty_fields    text,
  deleted         boolean not null default false
);

create index groups_circle_idx
  on packalong.groups (circle_id) where deleted = false;

create trigger groups_set_updated_at
  before update on packalong.groups
  for each row execute function packalong.set_updated_at();

-- group_members ------------------------------------------------------------
--
-- Composite (group_id, person_id) PK gives idempotent upserts and a
-- natural uniqueness guarantee. Sync columns mirror the pattern from
-- circle_members + item_tags — pivot rows still need dirty / synced_at
-- bookkeeping so the sync layer can track them like any other entity.

create table packalong.group_members (
  group_id        uuid not null references packalong.groups(id) on delete cascade,
  person_id       uuid not null references packalong.profiles(id) on delete cascade,
  role            text not null default 'guest',
  origin_instance text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  synced_at       timestamptz,
  dirty           boolean not null default false,
  dirty_fields    text,
  deleted         boolean not null default false,
  primary key (group_id, person_id)
);

create index group_members_person_idx
  on packalong.group_members (person_id) where deleted = false;

create trigger group_members_set_updated_at
  before update on packalong.group_members
  for each row execute function packalong.set_updated_at();

-- trips.group_id FK --------------------------------------------------------
--
-- 005 left group_id as a bare uuid because groups didn't exist yet.
-- ON DELETE SET NULL preserves the trip when a person-bundle is
-- removed; cascading would silently drop trips that referenced the
-- group, which would surprise the owner.

alter table packalong.trips
  add constraint trips_group_id_fkey
  foreign key (group_id) references packalong.groups(id) on delete set null;
