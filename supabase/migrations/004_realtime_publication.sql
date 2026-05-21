-- 004_realtime_publication.sql
--
-- Realtime needs each table that should broadcast postgres changes to be
-- listed in the supabase_realtime publication. The publication's default
-- definition does not include the packalong schema — without this
-- migration, Realtime subscribers on packalong.* tables would never
-- receive events even though Realtime itself is healthy.
--
-- Phase 1 adds the three identity tables: circles (rename / icon updates),
-- circle_members (join / role / leave events), and profiles (name / avatar
-- / claim events). The Phase-3 sync tables (trips, items, templates, …)
-- are added in 012_sync_realtime.sql so this migration stays focused.
--
-- Idempotent: re-applying is a no-op.

do $$
declare
  t text;
begin
  foreach t in array array['circles', 'circle_members', 'profiles']
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
