-- 002_rls_policies.sql
--
-- Phase 1 RLS scoping (ADR-1, ADR-2). Two helper functions identify the
-- caller's household and ownership status once per query so policies don't
-- have to inline the same subquery against profiles.
--
-- The helpers must be SECURITY DEFINER. Otherwise any read of
-- packalong.profiles inside the helper would re-trigger profiles RLS,
-- which calls the helper, which reads profiles … → infinite recursion.
-- security definer makes the helpers run as the function owner (postgres),
-- bypassing RLS for the lookup. search_path is locked down to keep them
-- safe from search_path injection.

-- helpers -----------------------------------------------------------------

create or replace function packalong.auth_household_id()
returns uuid
language sql
security definer
stable
set search_path = packalong, pg_temp
as $$
  select household_id
    from packalong.profiles
   where user_id = auth.uid()
     and deleted = false
   limit 1;
$$;

create or replace function packalong.auth_is_owner()
returns boolean
language sql
security definer
stable
set search_path = packalong, pg_temp
as $$
  select exists (
    select 1
      from packalong.profiles
     where user_id = auth.uid()
       and role = 'owner'
       and deleted = false
  );
$$;

grant execute on function packalong.auth_household_id() to authenticated;
grant execute on function packalong.auth_is_owner()     to authenticated;

-- households -------------------------------------------------------------
--
-- INSERT goes through the bootstrap-household edge function (service role,
-- bypasses RLS). DELETE is reserved for an account-deletion flow that does
-- not exist yet. Only SELECT and UPDATE need user-facing policies.

alter table packalong.households enable row level security;

create policy households_select_own
  on packalong.households
  for select
  to authenticated
  using (id = packalong.auth_household_id());

create policy households_update_owner
  on packalong.households
  for update
  to authenticated
  using (id = packalong.auth_household_id() and packalong.auth_is_owner())
  with check (id = packalong.auth_household_id() and packalong.auth_is_owner());

-- profiles ---------------------------------------------------------------
--
-- SELECT : any member of the household sees every profile in their household.
--          PackAlong has no can_see_* visibility flags (ADR-3) — within a
--          household, everyone sees everyone.
-- UPDATE : self (any role) OR owner of the same household. Members edit
--          their own profile; owners edit any profile in the household.
-- INSERT : owner only, into their own household. join-household creates
--          claimed-profile rows via service role and bypasses this policy.
-- DELETE : owner only, in their own household. Soft delete via
--          deleted=true is the recommended path.

alter table packalong.profiles enable row level security;

create policy profiles_select_household
  on packalong.profiles
  for select
  to authenticated
  using (household_id = packalong.auth_household_id());

create policy profiles_update_self_or_owner
  on packalong.profiles
  for update
  to authenticated
  using (
    user_id = auth.uid()
    or (
      household_id = packalong.auth_household_id()
      and packalong.auth_is_owner()
    )
  )
  with check (
    user_id = auth.uid()
    or (
      household_id = packalong.auth_household_id()
      and packalong.auth_is_owner()
    )
  );

create policy profiles_insert_owner
  on packalong.profiles
  for insert
  to authenticated
  with check (
    packalong.auth_is_owner()
    and household_id = packalong.auth_household_id()
  );

create policy profiles_delete_owner
  on packalong.profiles
  for delete
  to authenticated
  using (
    packalong.auth_is_owner()
    and household_id = packalong.auth_household_id()
  );
