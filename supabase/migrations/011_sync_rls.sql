-- 011_sync_rls.sql
--
-- Phase 3 step 7 of 9: RLS for the sync entity tables introduced by
-- 005–010. Implements Plan §4.6 with ADR-3 (roles), ADR-11 (post-A2:
-- is_system is now a UI marker, not an RLS gate), ADR-14 (items.is_personal
-- visibility).
--
-- Three anchor patterns share a small helper layer:
--   * direct circle-bound (trips, preset_containers, tags, pack_templates,
--     template_categories, catalog_items, groups) — circle_id is on the
--     row and we gate on circle membership.
--   * trip-indirect (items, pack_containers, participants, activity_events,
--     trip_history_items) — scope inherits via trip_id; the helpers
--     can_access_trip()/can_edit_trip()/can_administer_trip() bridge the
--     join.
--   * parent-indirect (template_items via template_id, group_members via
--     group_id, item_tags via item_id) — scope inherits via the parent's
--     own scope and the policies subquery into the parent.
--
-- Mutation tiers per A1–A5 decisions (Session 2026-05-21):
--   * Editor-tier (default): INSERT/UPDATE/DELETE allowed for any
--     non-viewer member. Covers trips, preset_containers, groups, items,
--     pack_containers, group_members, item_tags, tags, pack_templates,
--     template_items, template_categories, catalog_items, trip_history_items
--     (UPDATE/INSERT only).
--   * Admin-tier (Owner-only): participants — adding/removing trip
--     members is an admin action. Also: trip_history_items DELETE
--     (hard-removing an archived row).
--   * Audit-tier: activity_events — INSERT/SELECT editor, UPDATE only
--     for the row's actor (so an actor can soft-delete their own event),
--     hard DELETE not granted to authenticated.
--
-- A2 (is_system de-emphasized): the structural tables still carry an
-- is_system column for UI marking, but no WITH CHECK guard. App-seeded
-- "starter templates" are normal rows that sync and are editable like
-- any other entity. If we later decide is_system was a mistake, we can
-- drop the column in a separate migration.
--
-- ADR-14 personal-item visibility: items with is_personal = true are
-- visible/editable only when the caller is created_by_person_id OR
-- assigned_to_person_id. When created_by_person_id IS NULL the equality
-- yields NULL → effectively "assigned_to only", which matches the spec
-- handed down for Drift schemas that haven't grown the column yet
-- (P4.3). item_tags inherits the same visibility through its parent
-- item.
--
-- All helpers are SECURITY DEFINER + locked search_path so policies
-- evaluating them don't re-enter RLS on circle_members / profiles /
-- trips and recurse. Same recipe as the helpers in 002_rls_policies.sql.

-- helpers ------------------------------------------------------------------

create or replace function packalong.can_access_trip(target_trip_id uuid)
returns boolean
language sql
security definer
stable
set search_path = packalong, pg_temp
as $$
  select exists (
    select 1
      from packalong.trips t
     where t.id = target_trip_id
       and t.deleted = false
       and t.circle_id in (select packalong.auth_circle_ids())
  );
$$;

create or replace function packalong.can_edit_trip(target_trip_id uuid)
returns boolean
language sql
security definer
stable
set search_path = packalong, pg_temp
as $$
  select exists (
    select 1
      from packalong.trips t
      join packalong.circle_members cm on cm.circle_id = t.circle_id
      join packalong.profiles p on p.id = cm.profile_id
     where t.id = target_trip_id
       and t.deleted = false
       and p.user_id = auth.uid()
       and cm.role in ('owner', 'member')
       and cm.deleted = false
       and p.deleted = false
  );
$$;

create or replace function packalong.can_administer_trip(target_trip_id uuid)
returns boolean
language sql
security definer
stable
set search_path = packalong, pg_temp
as $$
  select exists (
    select 1
      from packalong.trips t
      join packalong.circle_members cm on cm.circle_id = t.circle_id
      join packalong.profiles p on p.id = cm.profile_id
     where t.id = target_trip_id
       and t.deleted = false
       and p.user_id = auth.uid()
       and cm.role = 'owner'
       and cm.deleted = false
       and p.deleted = false
  );
$$;

create or replace function packalong.is_circle_editor(target_circle uuid)
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
       and cm.role in ('owner', 'member')
       and cm.deleted = false
       and p.deleted = false
  );
$$;

grant execute on function packalong.can_access_trip(uuid)     to authenticated;
grant execute on function packalong.can_edit_trip(uuid)       to authenticated;
grant execute on function packalong.can_administer_trip(uuid) to authenticated;
grant execute on function packalong.is_circle_editor(uuid)    to authenticated;

-- trips --------------------------------------------------------------------
--
-- Direct circle-bound. Editor-tier.

alter table packalong.trips enable row level security;

create policy trips_select_member on packalong.trips
  for select to authenticated
  using (circle_id in (select packalong.auth_circle_ids()));

create policy trips_insert_editor on packalong.trips
  for insert to authenticated
  with check (packalong.is_circle_editor(circle_id));

create policy trips_update_editor on packalong.trips
  for update to authenticated
  using (packalong.is_circle_editor(circle_id))
  with check (packalong.is_circle_editor(circle_id));

create policy trips_delete_editor on packalong.trips
  for delete to authenticated
  using (packalong.is_circle_editor(circle_id));

-- preset_containers --------------------------------------------------------
--
-- Direct circle-bound. Editor-tier.

alter table packalong.preset_containers enable row level security;

create policy preset_containers_select_member on packalong.preset_containers
  for select to authenticated
  using (circle_id in (select packalong.auth_circle_ids()));

create policy preset_containers_insert_editor on packalong.preset_containers
  for insert to authenticated
  with check (packalong.is_circle_editor(circle_id));

create policy preset_containers_update_editor on packalong.preset_containers
  for update to authenticated
  using (packalong.is_circle_editor(circle_id))
  with check (packalong.is_circle_editor(circle_id));

create policy preset_containers_delete_editor on packalong.preset_containers
  for delete to authenticated
  using (packalong.is_circle_editor(circle_id));

-- pack_containers ----------------------------------------------------------
--
-- Trip-indirect. Editor-tier.

alter table packalong.pack_containers enable row level security;

create policy pack_containers_select_member on packalong.pack_containers
  for select to authenticated
  using (packalong.can_access_trip(trip_id));

create policy pack_containers_insert_editor on packalong.pack_containers
  for insert to authenticated
  with check (packalong.can_edit_trip(trip_id));

create policy pack_containers_update_editor on packalong.pack_containers
  for update to authenticated
  using (packalong.can_edit_trip(trip_id))
  with check (packalong.can_edit_trip(trip_id));

create policy pack_containers_delete_editor on packalong.pack_containers
  for delete to authenticated
  using (packalong.can_edit_trip(trip_id));

-- items --------------------------------------------------------------------
--
-- Trip-indirect + is_personal (ADR-14). Personal items are visible AND
-- editable only by the creator or the assignee. NULL on
-- created_by_person_id behaves like "only assigned_to" — the equality
-- collapses to NULL and the disjunction needs the other branch.
--
-- WITH CHECK enforces the same predicate on the NEW row so a member
-- can't smuggle an item to a trip they can't edit, nor escape the
-- is_personal restriction by clearing the flag without being the
-- creator/assignee themselves.

alter table packalong.items enable row level security;

create policy items_select_visible on packalong.items
  for select to authenticated
  using (
    packalong.can_access_trip(trip_id)
    and (
      is_personal = false
      or created_by_person_id = packalong.auth_profile_id()
      or assigned_to_person_id = packalong.auth_profile_id()
    )
  );

create policy items_insert_editor on packalong.items
  for insert to authenticated
  with check (
    packalong.can_edit_trip(trip_id)
    and (
      is_personal = false
      or created_by_person_id = packalong.auth_profile_id()
      or assigned_to_person_id = packalong.auth_profile_id()
    )
  );

create policy items_update_editor on packalong.items
  for update to authenticated
  using (
    packalong.can_edit_trip(trip_id)
    and (
      is_personal = false
      or created_by_person_id = packalong.auth_profile_id()
      or assigned_to_person_id = packalong.auth_profile_id()
    )
  )
  with check (
    packalong.can_edit_trip(trip_id)
    and (
      is_personal = false
      or created_by_person_id = packalong.auth_profile_id()
      or assigned_to_person_id = packalong.auth_profile_id()
    )
  );

create policy items_delete_editor on packalong.items
  for delete to authenticated
  using (
    packalong.can_edit_trip(trip_id)
    and (
      is_personal = false
      or created_by_person_id = packalong.auth_profile_id()
      or assigned_to_person_id = packalong.auth_profile_id()
    )
  );

-- participants -------------------------------------------------------------
--
-- Trip-indirect. Admin-tier (A3): only the trip-circle's owner may add,
-- update or remove trip members. App-side may surface a setting to relax
-- this later; the server stays strict by default.

alter table packalong.participants enable row level security;

create policy participants_select_member on packalong.participants
  for select to authenticated
  using (packalong.can_access_trip(trip_id));

create policy participants_insert_owner on packalong.participants
  for insert to authenticated
  with check (packalong.can_administer_trip(trip_id));

create policy participants_update_owner on packalong.participants
  for update to authenticated
  using (packalong.can_administer_trip(trip_id))
  with check (packalong.can_administer_trip(trip_id));

create policy participants_delete_owner on packalong.participants
  for delete to authenticated
  using (packalong.can_administer_trip(trip_id));

-- activity_events ----------------------------------------------------------
--
-- Trip-indirect. Audit-tier (A4): INSERT/SELECT for any non-viewer in
-- the circle, but UPDATE is restricted to the row's own actor (so an
-- actor can soft-delete or correct their own entry), and hard DELETE
-- is not granted to authenticated at all — only service_role can prune
-- events. Soft-delete via UPDATE deleted=true is the supported path
-- for clients.
--
-- Caveat: an actor leaving the circle keeps the right to update events
-- they wrote earlier only as long as they remain a non-viewer member
-- (can_edit_trip becomes false otherwise). That's acceptable — losing
-- non-viewer status freezes the audit trail from that actor's side,
-- which is the more conservative behavior.

alter table packalong.activity_events enable row level security;

create policy activity_events_select_member on packalong.activity_events
  for select to authenticated
  using (packalong.can_access_trip(trip_id));

create policy activity_events_insert_editor on packalong.activity_events
  for insert to authenticated
  with check (packalong.can_edit_trip(trip_id));

create policy activity_events_update_self on packalong.activity_events
  for update to authenticated
  using (
    packalong.can_edit_trip(trip_id)
    and actor_person_id = packalong.auth_profile_id()
  )
  with check (
    packalong.can_edit_trip(trip_id)
    and actor_person_id = packalong.auth_profile_id()
  );

-- intentionally no DELETE policy: hard delete is service_role only.

-- tags ---------------------------------------------------------------------
--
-- Direct circle-bound. Editor-tier (A1/A2). is_system carries no RLS
-- weight any more; treated as a plain column.

alter table packalong.tags enable row level security;

create policy tags_select_member on packalong.tags
  for select to authenticated
  using (circle_id in (select packalong.auth_circle_ids()));

create policy tags_insert_editor on packalong.tags
  for insert to authenticated
  with check (packalong.is_circle_editor(circle_id));

create policy tags_update_editor on packalong.tags
  for update to authenticated
  using (packalong.is_circle_editor(circle_id))
  with check (packalong.is_circle_editor(circle_id));

create policy tags_delete_editor on packalong.tags
  for delete to authenticated
  using (packalong.is_circle_editor(circle_id));

-- item_tags ----------------------------------------------------------------
--
-- Parent-indirect (item_id → items → trip). Editor-tier. Inherits the
-- is_personal visibility from the parent item so a personal item's tags
-- aren't enumerable.

alter table packalong.item_tags enable row level security;

create policy item_tags_select_visible on packalong.item_tags
  for select to authenticated
  using (
    exists (
      select 1 from packalong.items i
       where i.id = item_tags.item_id
         and packalong.can_access_trip(i.trip_id)
         and (
           i.is_personal = false
           or i.created_by_person_id = packalong.auth_profile_id()
           or i.assigned_to_person_id = packalong.auth_profile_id()
         )
    )
  );

create policy item_tags_insert_editor on packalong.item_tags
  for insert to authenticated
  with check (
    exists (
      select 1 from packalong.items i
       where i.id = item_tags.item_id
         and packalong.can_edit_trip(i.trip_id)
         and (
           i.is_personal = false
           or i.created_by_person_id = packalong.auth_profile_id()
           or i.assigned_to_person_id = packalong.auth_profile_id()
         )
    )
  );

create policy item_tags_update_editor on packalong.item_tags
  for update to authenticated
  using (
    exists (
      select 1 from packalong.items i
       where i.id = item_tags.item_id
         and packalong.can_edit_trip(i.trip_id)
         and (
           i.is_personal = false
           or i.created_by_person_id = packalong.auth_profile_id()
           or i.assigned_to_person_id = packalong.auth_profile_id()
         )
    )
  )
  with check (
    exists (
      select 1 from packalong.items i
       where i.id = item_tags.item_id
         and packalong.can_edit_trip(i.trip_id)
         and (
           i.is_personal = false
           or i.created_by_person_id = packalong.auth_profile_id()
           or i.assigned_to_person_id = packalong.auth_profile_id()
         )
    )
  );

create policy item_tags_delete_editor on packalong.item_tags
  for delete to authenticated
  using (
    exists (
      select 1 from packalong.items i
       where i.id = item_tags.item_id
         and packalong.can_edit_trip(i.trip_id)
         and (
           i.is_personal = false
           or i.created_by_person_id = packalong.auth_profile_id()
           or i.assigned_to_person_id = packalong.auth_profile_id()
         )
    )
  );

-- pack_templates -----------------------------------------------------------
--
-- Direct circle-bound. Editor-tier (A1/A2).

alter table packalong.pack_templates enable row level security;

create policy pack_templates_select_member on packalong.pack_templates
  for select to authenticated
  using (circle_id in (select packalong.auth_circle_ids()));

create policy pack_templates_insert_editor on packalong.pack_templates
  for insert to authenticated
  with check (packalong.is_circle_editor(circle_id));

create policy pack_templates_update_editor on packalong.pack_templates
  for update to authenticated
  using (packalong.is_circle_editor(circle_id))
  with check (packalong.is_circle_editor(circle_id));

create policy pack_templates_delete_editor on packalong.pack_templates
  for delete to authenticated
  using (packalong.is_circle_editor(circle_id));

-- template_items -----------------------------------------------------------
--
-- Parent-indirect (template_id → pack_templates → circle). Editor-tier.

alter table packalong.template_items enable row level security;

create policy template_items_select_member on packalong.template_items
  for select to authenticated
  using (
    exists (
      select 1 from packalong.pack_templates pt
       where pt.id = template_items.template_id
         and pt.circle_id in (select packalong.auth_circle_ids())
    )
  );

create policy template_items_insert_editor on packalong.template_items
  for insert to authenticated
  with check (
    exists (
      select 1 from packalong.pack_templates pt
       where pt.id = template_items.template_id
         and packalong.is_circle_editor(pt.circle_id)
    )
  );

create policy template_items_update_editor on packalong.template_items
  for update to authenticated
  using (
    exists (
      select 1 from packalong.pack_templates pt
       where pt.id = template_items.template_id
         and packalong.is_circle_editor(pt.circle_id)
    )
  )
  with check (
    exists (
      select 1 from packalong.pack_templates pt
       where pt.id = template_items.template_id
         and packalong.is_circle_editor(pt.circle_id)
    )
  );

create policy template_items_delete_editor on packalong.template_items
  for delete to authenticated
  using (
    exists (
      select 1 from packalong.pack_templates pt
       where pt.id = template_items.template_id
         and packalong.is_circle_editor(pt.circle_id)
    )
  );

-- template_categories ------------------------------------------------------
--
-- Direct circle-bound. Editor-tier (A1/A2).

alter table packalong.template_categories enable row level security;

create policy template_categories_select_member on packalong.template_categories
  for select to authenticated
  using (circle_id in (select packalong.auth_circle_ids()));

create policy template_categories_insert_editor on packalong.template_categories
  for insert to authenticated
  with check (packalong.is_circle_editor(circle_id));

create policy template_categories_update_editor on packalong.template_categories
  for update to authenticated
  using (packalong.is_circle_editor(circle_id))
  with check (packalong.is_circle_editor(circle_id));

create policy template_categories_delete_editor on packalong.template_categories
  for delete to authenticated
  using (packalong.is_circle_editor(circle_id));

-- catalog_items ------------------------------------------------------------
--
-- Direct circle-bound. Editor-tier (A1/A2).

alter table packalong.catalog_items enable row level security;

create policy catalog_items_select_member on packalong.catalog_items
  for select to authenticated
  using (circle_id in (select packalong.auth_circle_ids()));

create policy catalog_items_insert_editor on packalong.catalog_items
  for insert to authenticated
  with check (packalong.is_circle_editor(circle_id));

create policy catalog_items_update_editor on packalong.catalog_items
  for update to authenticated
  using (packalong.is_circle_editor(circle_id))
  with check (packalong.is_circle_editor(circle_id));

create policy catalog_items_delete_editor on packalong.catalog_items
  for delete to authenticated
  using (packalong.is_circle_editor(circle_id));

-- groups -------------------------------------------------------------------
--
-- Direct circle-bound. Editor-tier.
-- ADR-15: this is the inner Personenbündel table, NOT the top-level
-- circle.

alter table packalong.groups enable row level security;

create policy groups_select_member on packalong.groups
  for select to authenticated
  using (circle_id in (select packalong.auth_circle_ids()));

create policy groups_insert_editor on packalong.groups
  for insert to authenticated
  with check (packalong.is_circle_editor(circle_id));

create policy groups_update_editor on packalong.groups
  for update to authenticated
  using (packalong.is_circle_editor(circle_id))
  with check (packalong.is_circle_editor(circle_id));

create policy groups_delete_editor on packalong.groups
  for delete to authenticated
  using (packalong.is_circle_editor(circle_id));

-- group_members ------------------------------------------------------------
--
-- Parent-indirect (group_id → groups → circle). Editor-tier.

alter table packalong.group_members enable row level security;

create policy group_members_select_member on packalong.group_members
  for select to authenticated
  using (
    exists (
      select 1 from packalong.groups g
       where g.id = group_members.group_id
         and g.circle_id in (select packalong.auth_circle_ids())
    )
  );

create policy group_members_insert_editor on packalong.group_members
  for insert to authenticated
  with check (
    exists (
      select 1 from packalong.groups g
       where g.id = group_members.group_id
         and packalong.is_circle_editor(g.circle_id)
    )
  );

create policy group_members_update_editor on packalong.group_members
  for update to authenticated
  using (
    exists (
      select 1 from packalong.groups g
       where g.id = group_members.group_id
         and packalong.is_circle_editor(g.circle_id)
    )
  )
  with check (
    exists (
      select 1 from packalong.groups g
       where g.id = group_members.group_id
         and packalong.is_circle_editor(g.circle_id)
    )
  );

create policy group_members_delete_editor on packalong.group_members
  for delete to authenticated
  using (
    exists (
      select 1 from packalong.groups g
       where g.id = group_members.group_id
         and packalong.is_circle_editor(g.circle_id)
    )
  );

-- trip_history_items -------------------------------------------------------
--
-- Trip-indirect. Mixed tier (A5): INSERT/UPDATE editor (archiving and
-- soft-delete via sync), DELETE owner-only (hard removal is an admin
-- action analogous to deleting a trip).

alter table packalong.trip_history_items enable row level security;

create policy trip_history_items_select_member on packalong.trip_history_items
  for select to authenticated
  using (packalong.can_access_trip(trip_id));

create policy trip_history_items_insert_editor on packalong.trip_history_items
  for insert to authenticated
  with check (packalong.can_edit_trip(trip_id));

create policy trip_history_items_update_editor on packalong.trip_history_items
  for update to authenticated
  using (packalong.can_edit_trip(trip_id))
  with check (packalong.can_edit_trip(trip_id));

create policy trip_history_items_delete_owner on packalong.trip_history_items
  for delete to authenticated
  using (packalong.can_administer_trip(trip_id));
