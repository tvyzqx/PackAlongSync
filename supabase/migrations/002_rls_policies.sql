-- 002_rls_policies.sql
--
-- Phase 1 RLS scoping for the v3 circles n:m model (ADR-2). Three helper
-- functions identify the caller's profile, their circle set, and ownership
-- status once per query so policies don't inline the same subquery against
-- profiles and circle_members.
--
-- The helpers must be SECURITY DEFINER. Otherwise any read of
-- packalong.profiles or packalong.circle_members inside the helper would
-- re-trigger their RLS, which calls the helper, which reads the same table …
-- → infinite recursion. security definer makes the helpers run as the
-- function owner (postgres), bypassing RLS for the lookup. search_path is
-- locked down to keep them safe from search_path injection.

-- helpers -------------------------------------------------------------------

create or replace function packalong.auth_profile_id()
returns uuid
language sql
security definer
stable
set search_path = packalong, pg_temp
as $$
  select id
    from packalong.profiles
   where user_id = auth.uid()
     and deleted = false
   limit 1;
$$;

create or replace function packalong.auth_circle_ids()
returns setof uuid
language sql
security definer
stable
set search_path = packalong, pg_temp
as $$
  select cm.circle_id
    from packalong.circle_members cm
    join packalong.profiles p on p.id = cm.profile_id
   where p.user_id = auth.uid()
     and cm.deleted = false
     and p.deleted = false;
$$;

create or replace function packalong.is_circle_owner(target_circle uuid)
returns boolean
language sql
security definer
stable
set search_path = packalong, pg_temp
as $$
  select exists (
    select 1
      from packalong.circle_members cm
      join packalong.profiles p on p.id = cm.profile_id
     where cm.circle_id = target_circle
       and p.user_id = auth.uid()
       and cm.role = 'owner'
       and cm.deleted = false
       and p.deleted = false
  );
$$;

grant execute on function packalong.auth_profile_id()         to authenticated;
grant execute on function packalong.auth_circle_ids()         to authenticated;
grant execute on function packalong.is_circle_owner(uuid)     to authenticated;

-- circles -------------------------------------------------------------------
--
-- SELECT  : any member of the circle sees its row.
-- INSERT  : authenticated users may create a circle as long as created_by
--           matches their auth uid. Membership (owner role) is added in a
--           separate insert into circle_members by the calling edge
--           function. bootstrap-account / create-circle typically run as
--           service role and bypass RLS, but this policy keeps direct
--           PostgREST inserts safe.
-- UPDATE  : owner only.
-- DELETE  : owner only.

alter table packalong.circles enable row level security;

create policy circles_select_member
  on packalong.circles
  for select
  to authenticated
  using (id in (select packalong.auth_circle_ids()));

create policy circles_insert_self
  on packalong.circles
  for insert
  to authenticated
  with check (created_by = auth.uid());

create policy circles_update_owner
  on packalong.circles
  for update
  to authenticated
  using (packalong.is_circle_owner(id))
  with check (packalong.is_circle_owner(id));

create policy circles_delete_owner
  on packalong.circles
  for delete
  to authenticated
  using (packalong.is_circle_owner(id));

-- profiles ------------------------------------------------------------------
--
-- SELECT  : self (any role) OR any profile that shares at least one circle
--           with the caller. Within a shared circle, everyone sees everyone
--           (no can_see_* flags in PackAlong).
-- INSERT  : own profile (user_id = auth.uid()) OR a local guest profile
--           (user_id IS NULL). bootstrap-account and join-circle run as
--           service role and bypass this policy.
-- UPDATE  : self OR a circle-owner that shares a circle with the target
--           profile.
-- DELETE  : circle-owner that shares a circle with the target profile.
--           Soft delete via deleted=true is the recommended path.

alter table packalong.profiles enable row level security;

create policy profiles_select_self_or_circle
  on packalong.profiles
  for select
  to authenticated
  using (
    user_id = auth.uid()
    or id in (
      select cm.profile_id
        from packalong.circle_members cm
       where cm.circle_id in (select packalong.auth_circle_ids())
         and cm.deleted = false
    )
  );

create policy profiles_insert_self_or_guest
  on packalong.profiles
  for insert
  to authenticated
  with check (user_id = auth.uid() or user_id is null);

create policy profiles_update_self_or_circle_owner
  on packalong.profiles
  for update
  to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1
        from packalong.circle_members cm
       where cm.profile_id = packalong.profiles.id
         and cm.deleted = false
         and packalong.is_circle_owner(cm.circle_id)
    )
  )
  with check (
    user_id = auth.uid()
    or exists (
      select 1
        from packalong.circle_members cm
       where cm.profile_id = packalong.profiles.id
         and cm.deleted = false
         and packalong.is_circle_owner(cm.circle_id)
    )
  );

create policy profiles_delete_circle_owner
  on packalong.profiles
  for delete
  to authenticated
  using (
    exists (
      select 1
        from packalong.circle_members cm
       where cm.profile_id = packalong.profiles.id
         and cm.deleted = false
         and packalong.is_circle_owner(cm.circle_id)
    )
  );

-- circle_members ------------------------------------------------------------
--
-- SELECT  : any member of the circle sees its membership rows. Required so
--           a member can render "who else is in this group".
-- INSERT  : owner of the target circle. join-circle runs as service role.
-- UPDATE  : owner of the target circle (role / soft-delete bookkeeping).
-- DELETE  : owner of the target circle OR the user themselves (self-leave).

alter table packalong.circle_members enable row level security;

create policy circle_members_select_member
  on packalong.circle_members
  for select
  to authenticated
  using (circle_id in (select packalong.auth_circle_ids()));

create policy circle_members_insert_owner
  on packalong.circle_members
  for insert
  to authenticated
  with check (packalong.is_circle_owner(circle_id));

create policy circle_members_update_owner
  on packalong.circle_members
  for update
  to authenticated
  using (packalong.is_circle_owner(circle_id))
  with check (packalong.is_circle_owner(circle_id));

create policy circle_members_delete_owner_or_self
  on packalong.circle_members
  for delete
  to authenticated
  using (
    packalong.is_circle_owner(circle_id)
    or profile_id = packalong.auth_profile_id()
  );
