-- 006_items_participants.sql
--
-- Phase 3 step 2 of 6: items, trip participants, activity events. Mirrors
--   packalong/lib/db/tables/items.dart
--   packalong/lib/db/tables/participants.dart
--   packalong/lib/db/tables/activity_events.dart
--
-- Sync anchor: every row is trip-bound; RLS in 011 bridges through
-- can_access_trip(trip_id).
--
-- v3 additions over the Drift schema:
--   * items.is_personal (ADR-14) — when true, only created_by_person_id
--     and assigned_to_person_id see the row (RLS in 011).
--   * items.created_by_person_id — needed as the visibility anchor for
--     is_personal. The Drift table doesn't carry it yet; P4.3 adds the
--     column locally. Until then it stays NULL and the is_personal
--     branch falls back to "assigned_to only".
--
-- FK to tags (007) and template_categories (008) is deferred to those
-- files via ALTER TABLE; tag_id and category_id are bare uuids here.

-- items --------------------------------------------------------------------

create table packalong.items (
  id                       uuid primary key,
  trip_id                  uuid not null references packalong.trips(id) on delete cascade,
  title                    text not null,
  status                   text not null default 'open'
                                check (status in ('toBuy', 'open', 'unclear',
                                                  'planning', 'packed')),
  kind                     text not null default 'gear'
                                check (kind in ('gear', 'task')),
  quantity                 integer not null default 1,
  sort_order               integer not null default 0,
  return_packed            boolean not null default false,
  return_packed_at         timestamptz,
  assigned_to_person_id    uuid references packalong.profiles(id) on delete set null,
  pack_list_person_id      uuid references packalong.profiles(id) on delete set null,
  created_by_person_id     uuid references packalong.profiles(id) on delete set null,
  updated_by_person_id     uuid references packalong.profiles(id) on delete set null,
  container_id             uuid references packalong.pack_containers(id) on delete set null,
  tag_id                   uuid,
  category_id              uuid,
  category                 text,
  note                     text,
  needs_washing            boolean not null default false,
  needs_refill             boolean not null default false,
  is_personal              boolean not null default false,
  origin_instance          text,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  synced_at                timestamptz,
  dirty                    boolean not null default false,
  dirty_fields             text,
  deleted                  boolean not null default false
);

create index items_trip_idx
  on packalong.items (trip_id) where deleted = false;
create index items_container_idx
  on packalong.items (container_id) where container_id is not null and deleted = false;
create index items_assigned_to_idx
  on packalong.items (assigned_to_person_id) where assigned_to_person_id is not null;
create index items_status_idx
  on packalong.items (status) where deleted = false;
-- Risk R14 (Plan §7): personal-item RLS scans by (trip_id, is_personal,
-- assigned_to_person_id). Partial index keeps the scan cheap once
-- personal items become non-trivial.
create index items_personal_visibility_idx
  on packalong.items (trip_id, assigned_to_person_id)
  where is_personal = true and deleted = false;

create trigger items_set_updated_at
  before update on packalong.items
  for each row execute function packalong.set_updated_at();

-- participants -------------------------------------------------------------
--
-- Tracks WHO is on a trip (independent of who can edit it — that's
-- circle_members.role). Roles here are trip-scoped and mirror the
-- legacy Drift values.

create table packalong.participants (
  id              uuid primary key,
  trip_id         uuid not null references packalong.trips(id) on delete cascade,
  person_id       uuid not null references packalong.profiles(id) on delete cascade,
  role            text not null
                       check (role in ('owner', 'editor', 'guest', 'child')),
  join_type       text not null
                       check (join_type in ('account', 'qr', 'local')),
  joined_at       timestamptz not null default now(),
  origin_instance text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  synced_at       timestamptz,
  dirty           boolean not null default false,
  dirty_fields    text,
  deleted         boolean not null default false,
  unique (trip_id, person_id)
);

create index participants_trip_idx
  on packalong.participants (trip_id) where deleted = false;
create index participants_person_idx
  on packalong.participants (person_id) where deleted = false;

create trigger participants_set_updated_at
  before update on packalong.participants
  for each row execute function packalong.set_updated_at();

-- activity_events ----------------------------------------------------------
--
-- Append-only activity feed per trip. target_type is a free-form string
-- (e.g. 'item', 'container', 'participant') so the feed can describe any
-- entity without a schema change. target_id stays text so non-uuid
-- targets (synthetic events, future entity kinds) still fit.
-- payload_json stays text rather than jsonb to match the Drift column
-- 1:1 — converting at the sync boundary is more annoying than queries
-- against jsonb would buy us.

create table packalong.activity_events (
  id              uuid primary key,
  trip_id         uuid not null references packalong.trips(id) on delete cascade,
  actor_person_id uuid references packalong.profiles(id) on delete set null,
  action          text not null,
  target_type     text not null,
  target_id       text,
  payload_json    text,
  origin_instance text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  synced_at       timestamptz,
  dirty           boolean not null default false,
  dirty_fields    text,
  deleted         boolean not null default false
);

create index activity_events_trip_idx
  on packalong.activity_events (trip_id, created_at desc);
create index activity_events_actor_idx
  on packalong.activity_events (actor_person_id) where actor_person_id is not null;

create trigger activity_events_set_updated_at
  before update on packalong.activity_events
  for each row execute function packalong.set_updated_at();
