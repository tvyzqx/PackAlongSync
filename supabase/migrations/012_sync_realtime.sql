-- 012_sync_realtime.sql
--
-- Phase 3 step 8 of 9: add the 15 sync entity tables (005–010) to the
-- supabase_realtime publication so client subscriptions on
-- packalong.<table> actually receive change events. Mirrors the
-- idempotent do-block pattern from 004_realtime_publication.sql — same
-- pg_publication_tables guard per table, format() with %I to keep the
-- identifier interpolation safe.
--
-- Order in the array matches Plan §4.7. Re-applying is a no-op.

do $$
declare
  t text;
begin
  foreach t in array array[
    'trips',
    'items',
    'tags',
    'participants',
    'pack_containers',
    'preset_containers',
    'pack_templates',
    'template_items',
    'template_categories',
    'catalog_items',
    'groups',
    'group_members',
    'trip_history_items',
    'item_tags',
    'activity_events'
  ]
  loop
    if not exists (
      select 1 from pg_publication_tables
       where pubname    = 'supabase_realtime'
         and schemaname = 'packalong'
         and tablename  = t
    ) then
      execute format('alter publication supabase_realtime add table packalong.%I', t);
    end if;
  end loop;
end $$;
