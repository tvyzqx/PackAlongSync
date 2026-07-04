-- 015_weight_quantity_review.sql
--
-- Column additions for the 2026-07 feature batch. Mirrors the Drift schema
-- v41 migration in packalong/lib/db/app_database.dart:
--   * items.weight_grams              — weight of one unit in grams
--   * pack_containers.weight_limit_grams — optional per-container limit
--     (e.g. airline luggage allowance); photo_path is intentionally NOT
--     mirrored here: container photos stay on the device that took them.
--   * catalog_items.quantity_per_day  — packing rule "quantity per trip day"
--   * trip_history_items.was_unused   — post-trip review flag "packed but
--     never used", feeds template suggestions on the next trip
--
-- Plain nullable columns / boolean default false: no backfill, no RLS or
-- realtime changes needed. Re-applying is a no-op (if not exists).

alter table packalong.items
  add column if not exists weight_grams integer;

alter table packalong.pack_containers
  add column if not exists weight_limit_grams integer;

alter table packalong.catalog_items
  add column if not exists quantity_per_day double precision;

alter table packalong.trip_history_items
  add column if not exists was_unused boolean not null default false;
