-- 010_trip_history.sql
--
-- Phase 3 step 6 of 6: trip history snapshot. Mirrors
--   packalong/lib/db/tables/trip_history_items.dart
-- but with full SyncColumns added (ADR-12). The Drift table doesn't
-- mix in SyncColumns yet — P4.3 brings the local schema in line.
-- Risk R10: a freshly-archived item will be marked dirty on the
-- archiver's device. Acceptable in the single-user case; the row
-- still syncs on next push.
--
-- Scope: indirect via trip_id; RLS bridges through can_access_trip()
-- in 011.
--
-- History rows are intentionally "frozen". source_item_id is a soft
-- pointer (no FK) — if the original item is deleted after archiving,
-- the history row stays intact and the pointer becomes a tombstone
-- reference instead of disappearing. status_at_archive is a closed
-- subset of items.status: 'toBuy' is excluded because items in that
-- state were never on the trip in the first place.

create table packalong.trip_history_items (
  id                  uuid primary key,
  trip_id             uuid not null references packalong.trips(id) on delete cascade,
  source_item_id      uuid not null,
  title               text not null,
  status_at_archive   text not null
                          check (status_at_archive in ('open', 'unclear',
                                                       'planning', 'packed')),
  is_forgotten        boolean not null default false,
  archived_at         timestamptz not null,
  origin_instance     text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  synced_at           timestamptz,
  dirty               boolean not null default false,
  dirty_fields        text,
  deleted             boolean not null default false
);

create index trip_history_items_trip_idx
  on packalong.trip_history_items (trip_id, archived_at desc)
  where deleted = false;
create index trip_history_items_source_idx
  on packalong.trip_history_items (source_item_id);
create index trip_history_items_forgotten_idx
  on packalong.trip_history_items (trip_id) where is_forgotten = true and deleted = false;

create trigger trip_history_items_set_updated_at
  before update on packalong.trip_history_items
  for each row execute function packalong.set_updated_at();
