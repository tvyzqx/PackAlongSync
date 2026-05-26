-- 005_trips_containers.sql
--
-- Phase 3 step 1 of 6: trip-domain core (ADR-11). Mirrors the Drift
-- schemas in
--   packalong/lib/db/tables/trips.dart
--   packalong/lib/db/tables/preset_containers.dart
--   packalong/lib/db/tables/pack_containers.dart
--
-- Sync anchor: trips + preset_containers carry circle_id directly.
-- pack_containers inherits scope via trip_id (RLS bridges through
-- can_access_trip() in 011_sync_rls.sql).
--
-- RLS policies for these tables live in 011_sync_rls.sql so the entity
-- migrations stay focused on shape. Realtime publication ad in 012.
--
-- Client IDs (ADR-4): the app generates UUIDs locally so LWW conflict
-- resolution is stable across devices; the table has no `default
-- gen_random_uuid()` on entity rows to make missing-id bugs loud at
-- INSERT time instead of silently writing server-generated rows.

-- trips --------------------------------------------------------------------
--
-- group_id stays unconstrained here; the FK to packalong.groups is added
-- in 009_person_groups.sql once that table exists. Keeping it nullable
-- and FK-less in 005 avoids a chicken-and-egg ordering between the two
-- files.
--
-- join_token (legacy v1/v2 trip-invite path) is intentionally NOT mirrored
-- on the server: ADR-8 v3 deprecated trip-invites in favor of circle
-- invites. The Drift column survives locally for backward compatibility
-- but the sync layer filters it out.

create table packalong.trips (
  id                  uuid primary key,
  circle_id           uuid not null references packalong.circles(id) on delete cascade,
  owner_person_id     uuid not null references packalong.profiles(id) on delete restrict,
  title               text not null,
  emoji               text,
  template_emoji      text,
  group_id            uuid,
  start_date          timestamptz,
  end_date            timestamptz,
  destination         text,
  latitude            double precision,
  longitude           double precision,
  is_archived         boolean not null default false,
  origin_instance     text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  synced_at           timestamptz,
  dirty               boolean not null default false,
  dirty_fields        text,
  deleted             boolean not null default false
);

create index trips_circle_idx
  on packalong.trips (circle_id) where deleted = false;
create index trips_owner_person_idx
  on packalong.trips (owner_person_id);
create index trips_group_idx
  on packalong.trips (group_id) where group_id is not null and deleted = false;
create index trips_is_archived_idx
  on packalong.trips (is_archived) where deleted = false;

create trigger trips_set_updated_at
  before update on packalong.trips
  for each row execute function packalong.set_updated_at();

-- preset_containers --------------------------------------------------------
--
-- Reusable container blueprints (rucksack, kulturtasche, …). Lives per
-- circle so each household can curate its own list without polluting a
-- friend-trip circle.

create table packalong.preset_containers (
  id                      uuid primary key,
  circle_id               uuid not null references packalong.circles(id) on delete cascade,
  name                    text not null,
  icon                    text,
  color                   text,
  created_by_person_id    uuid references packalong.profiles(id) on delete set null,
  origin_instance         text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  synced_at               timestamptz,
  dirty                   boolean not null default false,
  dirty_fields            text,
  deleted                 boolean not null default false
);

create index preset_containers_circle_idx
  on packalong.preset_containers (circle_id) where deleted = false;

create trigger preset_containers_set_updated_at
  before update on packalong.preset_containers
  for each row execute function packalong.set_updated_at();

-- pack_containers ----------------------------------------------------------
--
-- Per-trip instances of containers. preset_id is nullable — a container
-- created ad hoc in a trip doesn't need to map back to a preset, and
-- when a preset is removed later we don't want to cascade-drop the
-- already-packed instance.

create table packalong.pack_containers (
  id                      uuid primary key,
  trip_id                 uuid not null references packalong.trips(id) on delete cascade,
  preset_id               uuid references packalong.preset_containers(id) on delete set null,
  name                    text not null,
  icon                    text,
  color                   text,
  created_by_person_id    uuid references packalong.profiles(id) on delete set null,
  origin_instance         text,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  synced_at               timestamptz,
  dirty                   boolean not null default false,
  dirty_fields            text,
  deleted                 boolean not null default false
);

create index pack_containers_trip_idx
  on packalong.pack_containers (trip_id) where deleted = false;
create index pack_containers_preset_idx
  on packalong.pack_containers (preset_id) where preset_id is not null;

create trigger pack_containers_set_updated_at
  before update on packalong.pack_containers
  for each row execute function packalong.set_updated_at();
