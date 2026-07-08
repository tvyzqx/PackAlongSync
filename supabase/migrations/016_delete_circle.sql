-- 016_delete_circle.sql
--
-- Owner-triggered circle deletion. Until now the only exit from a circle was
-- "leave" (soft-delete of the caller's own circle_members row); the last
-- remaining owner could not even leave, so a solo-owner circle was permanent.
--
-- The sync layer (features/sync/remote_sync_service.dart) is soft-delete
-- based: a row with deleted=true and a bumped updated_at propagates to every
-- member's device on the next incremental pull (updated_at >= since). A hard
-- DELETE would instead vanish from the pull and leave permanent local orphans
-- ("Karteileichen") on other members' devices. So "delete a circle" is a
-- cascade *soft-delete* across the circle and every child table, bumping
-- updated_at everywhere so the tombstones ride the normal pull.
--
-- Wrapped in one SECURITY DEFINER function so the whole cascade is atomic and
-- can be invoked by the pa-delete-circle edge function via RPC. Execute is
-- granted to service_role only: the edge function is the sole gateway and
-- performs the owner-authorization check before calling this (mirrors the
-- create-circle pattern where the TS layer guards and the service role
-- writes). is_circle_owner is not usable here because the edge function runs
-- as service role (auth.uid() is null).
--
-- Idempotent: every statement guards on deleted = false, so re-running only
-- touches rows that are still live.
--
-- The circles table was created in 001 WITHOUT the sync columns every other
-- synced table carries (it predates the soft-delete sync model and was
-- previously undeletable). Two of those columns are needed now:
--   * deleted        — the cascade below writes circles.deleted, and the
--                      client circle-pull honours it to purge tombstones.
--   * origin_instance — every other synced table has it (nullable text); the
--                      client already pushes it in the circles upsert payload,
--                      so its absence silently failed that push.
-- Both guarded with IF NOT EXISTS so this migration stays idempotent.

alter table packalong.circles
  add column if not exists deleted boolean not null default false;

alter table packalong.circles
  add column if not exists origin_instance text;

create or replace function packalong.soft_delete_circle(target_circle uuid)
returns void
language plpgsql
security definer
set search_path = packalong, pg_temp
as $$
begin
  -- Leaf tables reachable through items (via trips). The trip/item
  -- subqueries intentionally do NOT filter on deleted so children of an
  -- already-soft-deleted trip still get tombstoned.
  update packalong.item_comments
     set deleted = true, updated_at = now()
   where deleted = false
     and item_id in (
       select i.id
         from packalong.items i
         join packalong.trips t on t.id = i.trip_id
        where t.circle_id = target_circle
     );

  update packalong.item_tags
     set deleted = true, updated_at = now()
   where deleted = false
     and item_id in (
       select i.id
         from packalong.items i
         join packalong.trips t on t.id = i.trip_id
        where t.circle_id = target_circle
     );

  -- Tables reachable through trips.
  update packalong.items
     set deleted = true, updated_at = now()
   where deleted = false
     and trip_id in (select id from packalong.trips where circle_id = target_circle);

  update packalong.pack_containers
     set deleted = true, updated_at = now()
   where deleted = false
     and trip_id in (select id from packalong.trips where circle_id = target_circle);

  update packalong.participants
     set deleted = true, updated_at = now()
   where deleted = false
     and trip_id in (select id from packalong.trips where circle_id = target_circle);

  update packalong.activity_events
     set deleted = true, updated_at = now()
   where deleted = false
     and trip_id in (select id from packalong.trips where circle_id = target_circle);

  update packalong.trip_history_items
     set deleted = true, updated_at = now()
   where deleted = false
     and trip_id in (select id from packalong.trips where circle_id = target_circle);

  -- Tables reachable through pack_templates / groups.
  update packalong.template_items
     set deleted = true, updated_at = now()
   where deleted = false
     and template_id in (
       select id from packalong.pack_templates where circle_id = target_circle
     );

  update packalong.group_members
     set deleted = true, updated_at = now()
   where deleted = false
     and group_id in (
       select id from packalong.groups where circle_id = target_circle
     );

  -- Direct circle_id children.
  update packalong.trips
     set deleted = true, updated_at = now()
   where deleted = false and circle_id = target_circle;

  update packalong.preset_containers
     set deleted = true, updated_at = now()
   where deleted = false and circle_id = target_circle;

  update packalong.tags
     set deleted = true, updated_at = now()
   where deleted = false and circle_id = target_circle;

  update packalong.pack_templates
     set deleted = true, updated_at = now()
   where deleted = false and circle_id = target_circle;

  update packalong.template_categories
     set deleted = true, updated_at = now()
   where deleted = false and circle_id = target_circle;

  update packalong.catalog_items
     set deleted = true, updated_at = now()
   where deleted = false and circle_id = target_circle;

  update packalong.groups
     set deleted = true, updated_at = now()
   where deleted = false and circle_id = target_circle;

  -- Membership rows and the circle itself. circles.deleted=true and each
  -- member's own circle_members.deleted=true are the two signals that reach
  -- every device unconditionally (both tables are pulled without a circle_id
  -- filter), so the circle disappears from every member's UI.
  update packalong.circle_members
     set deleted = true, updated_at = now()
   where deleted = false and circle_id = target_circle;

  update packalong.circles
     set deleted = true, updated_at = now()
   where deleted = false and id = target_circle;
end;
$$;

-- Postgres grants EXECUTE to PUBLIC on every new function. Since this is a
-- SECURITY DEFINER cascade with NO internal auth check (the owner check lives
-- in the pa-delete-circle edge function), that default would let any anon /
-- authenticated client call it directly via PostgREST rpc and delete an
-- arbitrary circle by UUID. Revoke the default and grant only service_role so
-- the edge function is the sole gateway.
revoke all on function packalong.soft_delete_circle(uuid) from public;
revoke all on function packalong.soft_delete_circle(uuid) from anon;
revoke all on function packalong.soft_delete_circle(uuid) from authenticated;
grant execute on function packalong.soft_delete_circle(uuid) to service_role;
