-- 004_realtime_publication.sql
--
-- Realtime needs each table that should broadcast postgres changes to be
-- listed in the supabase_realtime publication. The publication's default
-- definition does not include the packalong schema — without this
-- migration, Realtime subscribers on packalong.* tables would never
-- receive events even though Realtime itself is healthy.
--
-- Only profiles is added in Phase 1: households changes rarely and from
-- one device, join_tokens is polled via check-join-status. Migration 012
-- adds the entity tables (trips, items, templates, tags, …) the same way.
--
-- Idempotent: re-applying this migration is a no-op.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname    = 'supabase_realtime'
       and schemaname = 'packalong'
       and tablename  = 'profiles'
  ) then
    execute 'alter publication supabase_realtime add table packalong.profiles';
  end if;
end $$;
