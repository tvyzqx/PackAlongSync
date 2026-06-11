-- 014_item_comments_realtime.sql
--
-- item_comments (added in 013) was not part of the supabase_realtime
-- publication, so client subscriptions on packalong.item_comments never
-- received change events and comments only synced on the next pull.
-- Add it now using the same idempotent do-block guard as 012_sync_realtime.sql
-- (pg_publication_tables check + format() %I). Re-applying is a no-op.

do $$
begin
  if not exists (
    select 1 from pg_publication_tables
     where pubname    = 'supabase_realtime'
       and schemaname = 'packalong'
       and tablename  = 'item_comments'
  ) then
    execute 'alter publication supabase_realtime add table packalong.item_comments';
  end if;
end $$;
