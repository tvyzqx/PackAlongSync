-- 018_trip_visible_to_participants.sql
--
-- Per-trip "visible to participants only" flag. This is purely a CLIENT-SIDE
-- list filter, NOT access control: when true, the trip is hidden in the trip
-- list for circle members who are neither a participant nor the trip owner.
--
-- The data still syncs to every circle member (per-circle sync is unchanged),
-- so this column carries no RLS/enforcement. It rides along the generic
-- dirty-row upsert like every other trips column. Real isolation remains the
-- job of separate circles and is deliberately out of scope here.
--
-- Adding a column to the already-published packalong.trips table needs no
-- realtime publication change (the table is published in full).

alter table packalong.trips
  add column if not exists visible_to_participants_only boolean not null default false;
