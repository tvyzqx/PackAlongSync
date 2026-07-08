-- 017_circle_member_sort_order.sql
--
-- Personal, synced ordering of a user's circles. The order lives on the
-- membership (circle_members.sort_order), not on the shared circles row, so
-- every member arranges their OWN chip / list order and it follows them
-- across their devices via the normal sync pull.
--
-- Persistence path: a dedicated RPC, NOT the generic dirty-row upsert. Two
-- reasons the upsert path is unsuitable here:
--   * circle_members INSERT/UPDATE is owner-only (002). A plain member could
--     not push their own row, and PostgREST's upsert (INSERT ... ON CONFLICT
--     DO UPDATE) additionally evaluates the INSERT policy, so even an
--     existing-row update is gated by it. Opening an insert-self policy would
--     be a self-join hole.
--   * sort_order is a per-member field on a row an owner may also write (role
--     changes). If it rode along in the generic upsert, a stale owner-side
--     copy could clobber a member's newer ordering.
--
-- set_circle_order runs SECURITY DEFINER and only ever touches the caller's
-- OWN rows and only the sort_order column, so it needs no RLS relaxation and
-- carries no escalation surface. Clients call it directly; the server bumps
-- updated_at so other devices of the same user pick the order up on pull.

alter table packalong.circle_members
  add column if not exists sort_order integer not null default 0;

-- target_profile is passed explicitly (not derived from auth.uid()) because
-- the app supports profile switching: the active profile whose order is being
-- saved may not be the auth user's primary profile. The ownership guard
-- (profiles.user_id = auth.uid()) ensures a caller can only reorder their own
-- profiles' memberships. orders: jsonb array of
-- {"circle_id": uuid, "sort_order": int}; unknown circle_ids join out.
create or replace function packalong.set_circle_order(
  target_profile uuid,
  orders jsonb
)
returns void
language sql
security definer
set search_path = packalong, pg_temp
as $$
  update packalong.circle_members cm
     set sort_order = (o->>'sort_order')::int,
         updated_at = now()
    from jsonb_array_elements(orders) as o
   where cm.profile_id = target_profile
     and cm.circle_id = (o->>'circle_id')::uuid
     and exists (
       select 1
         from packalong.profiles p
        where p.id = target_profile
          and p.user_id = auth.uid()
          and p.deleted = false
     );
$$;

grant execute on function packalong.set_circle_order(uuid, jsonb) to authenticated;
