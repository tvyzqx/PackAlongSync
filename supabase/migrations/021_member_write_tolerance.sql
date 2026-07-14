-- 021_member_write_tolerance.sql
--
-- STOPGAP (server-side) for the "joined member never syncs / shows as local"
-- bug. Root cause is client-side: features/sync/remote_sync_service.dart pushes
-- the whole local dataset with per-table upserts, INCLUDING rows of the
-- server-managed identity tables `circles` and `circle_members` that the caller
-- does not own. The strict policies
--   circles_insert_self       (created_by = auth.uid())
--   circles_update_owner      (is_circle_owner(id))
--   circle_members_*_owner    (is_circle_owner(circle_id))
-- reject those rows, and because the client applies the push as one batch, a
-- single rejected row aborts the entire push. The member's local rows never get
-- their synced_at stamped, so the app keeps showing them (and the member) as
-- "local" and nothing ever reaches the server. Reproduced live 2026-07-14 for
-- a member after an accidental remove + re-add from a shared circle.
--
-- The DURABLE fix is in the client (do not push circles / circle_members you do
-- not own; make the push resilient to per-row rejects) — see
-- docs/sync-circles-fix-spec.md. Until that ships, this migration makes the
-- server TOLERANT of such a push WITHOUT loosening the actual authorization
-- model:
--   * The write gate on circles / circle_members is widened so a member can
--     reach an existing row (INSERT-on-conflict / UPDATE) instead of erroring.
--   * A BEFORE trigger then reverts every column of a NON-owner write back to
--     the existing server values, so the member's write is a pure no-op. A
--     brand-new circle a member legitimately creates (created_by = auth.uid())
--     is untouched; foreign INSERTs are dropped (RETURN NULL) so an upsert of a
--     circle they don't own collapses to nothing.
--   * Owners are unaffected. Edge functions run as service_role with
--     auth.uid() = NULL and are short-circuited to full pass-through, so
--     pa-create-circle / pa-join-circle / soft_delete_circle keep working.
--
-- Validated live (in a rolled-back tx): a member's malicious upsert
-- (rename + deleted=true + created_by theft + self-promote to owner) is
-- accepted with no error yet leaves both rows byte-for-byte unchanged.

begin;

-- ── guard: circles ────────────────────────────────────────────────────────
create or replace function packalong.guard_nonowner_circle()
returns trigger
language plpgsql
security definer
set search_path to 'packalong', 'pg_temp'
as $$
begin
  -- service_role (edge functions) and the circle's owner may write freely.
  if auth.uid() is null or packalong.is_circle_owner(new.id) then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    -- non-owner member: neutralize — keep the server's row verbatim.
    new.name       := old.name;
    new.icon_emoji := old.icon_emoji;
    new.color      := old.color;
    new.created_by := old.created_by;
    new.created_at := old.created_at;
    new.deleted    := old.deleted;
    new.updated_at := old.updated_at;  -- overrides circles_set_updated_at (fires earlier by name)
    return new;
  end if;
  -- INSERT of a circle the caller does not create -> drop the row (no-op upsert).
  if new.created_by <> auth.uid() then
    return null;
  end if;
  return new;
end;
$$;

-- ── guard: circle_members ─────────────────────────────────────────────────
create or replace function packalong.guard_nonowner_circle_member()
returns trigger
language plpgsql
security definer
set search_path to 'packalong', 'pg_temp'
as $$
begin
  if auth.uid() is null or packalong.is_circle_owner(new.circle_id) then
    return new;
  end if;
  if tg_op = 'UPDATE' then
    new.circle_id  := old.circle_id;
    new.profile_id := old.profile_id;
    new.role       := old.role;
    new.deleted    := old.deleted;
    new.sort_order := old.sort_order;
    new.joined_at  := old.joined_at;
    new.updated_at := old.updated_at;
    return new;
  end if;
  -- members never create memberships (that is an owner / edge-function action).
  return null;
end;
$$;

drop trigger if exists guard_nonowner on packalong.circles;
create trigger guard_nonowner
  before insert or update on packalong.circles
  for each row execute function packalong.guard_nonowner_circle();

drop trigger if exists guard_nonowner on packalong.circle_members;
create trigger guard_nonowner
  before insert or update on packalong.circle_members
  for each row execute function packalong.guard_nonowner_circle_member();

-- ── widen the write gate so a member reaches the row (the trigger no-ops it) ──
-- A member can only ever reach an id/circle_id that is already in their
-- auth_circle_ids() set, i.e. a circle they belong to; brand-new ids are not,
-- so the "create attributed to self" guarantee of the INSERT policy is kept.
drop policy if exists circles_insert_self on packalong.circles;
create policy circles_insert_self
  on packalong.circles
  for insert
  to authenticated
  with check (created_by = auth.uid() or id in (select packalong.auth_circle_ids()));

drop policy if exists circles_update_owner on packalong.circles;
create policy circles_update_owner
  on packalong.circles
  for update
  to authenticated
  using (id in (select packalong.auth_circle_ids()))
  with check (id in (select packalong.auth_circle_ids()));

drop policy if exists circle_members_insert_owner on packalong.circle_members;
create policy circle_members_insert_owner
  on packalong.circle_members
  for insert
  to authenticated
  with check (packalong.is_circle_owner(circle_id) or circle_id in (select packalong.auth_circle_ids()));

drop policy if exists circle_members_update_owner on packalong.circle_members;
create policy circle_members_update_owner
  on packalong.circle_members
  for update
  to authenticated
  using (packalong.is_circle_owner(circle_id) or circle_id in (select packalong.auth_circle_ids()))
  with check (packalong.is_circle_owner(circle_id) or circle_id in (select packalong.auth_circle_ids()));

commit;
