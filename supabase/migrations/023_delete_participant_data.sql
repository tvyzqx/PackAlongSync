-- 023_delete_participant_data.sql
--
-- Delete one participant's data within a circle. Complements pa-remove-member
-- (which only ends membership, leaving their contributed data behind): this
-- purges the content that is intrinsically theirs, for two use cases —
--   * the owner scrubbing a participant they added (e.g. a guest), and
--   * a participant erasing their own footprint (self-service).
--
-- Like the other destructive flows this is a soft-delete cascade (deleted=true
-- + updated_at bump) so tombstones propagate to every device on the next pull.
-- Scoped to ONE circle via trip_id -> circle_id / group_id -> circle_id joins,
-- mirroring soft_delete_circle (016).
--
-- What counts as "their data" (all scoped to target_circle):
--   * items on their pack list (pack_list_person_id) or authored by them
--     (created_by_person_id), plus those items' comments and tags;
--   * item_comments they authored on any item in the circle;
--   * activity_events they are the actor of;
--   * pack_containers they created;
--   * their participants rows (trip participation / their packing lists);
--   * their group_members rows;
--   * their circle_members row (they leave the circle).
-- Shared structure they merely reference (trips.owner_person_id,
-- items.assigned_to_person_id / updated_by_person_id) is intentionally left
-- intact — removing it would corrupt other members' data. Those are historical
-- references to a now-departed person and render harmlessly.
--
-- Finally, a GUEST profile (never linked to an auth user) with no remaining
-- active membership anywhere is itself tombstoned. An ACCOUNT profile is never
-- deleted here — that is a whole-account concern, not a per-circle one.
--
-- SECURITY DEFINER, no internal auth check; the pa-delete-participant-data edge
-- function authorizes (owner, or self) before calling. service_role only.

create or replace function packalong.soft_delete_participant_data(
  target_circle uuid,
  target_profile uuid
)
returns void
language plpgsql
security definer
set search_path = packalong, pg_temp
as $$
begin
  -- Children of the items we are about to remove (their pack-list / authored
  -- items in this circle): tombstone comments and tags on those items first.
  update packalong.item_comments c
     set deleted = true, updated_at = now()
   where c.deleted = false
     and c.item_id in (
       select i.id from packalong.items i
         join packalong.trips t on t.id = i.trip_id
        where t.circle_id = target_circle
          and (i.created_by_person_id = target_profile
               or i.pack_list_person_id = target_profile)
     );

  update packalong.item_tags it
     set deleted = true, updated_at = now()
   where it.deleted = false
     and it.item_id in (
       select i.id from packalong.items i
         join packalong.trips t on t.id = i.trip_id
        where t.circle_id = target_circle
          and (i.created_by_person_id = target_profile
               or i.pack_list_person_id = target_profile)
     );

  -- The participant's own items in this circle.
  update packalong.items i
     set deleted = true, updated_at = now()
   where i.deleted = false
     and i.trip_id in (select id from packalong.trips where circle_id = target_circle)
     and (i.created_by_person_id = target_profile
          or i.pack_list_person_id = target_profile);

  -- Comments they authored on ANY item in the circle (not just their own).
  update packalong.item_comments c
     set deleted = true, updated_at = now()
   where c.deleted = false
     and c.person_id = target_profile
     and c.item_id in (
       select i.id from packalong.items i
         join packalong.trips t on t.id = i.trip_id
        where t.circle_id = target_circle
     );

  -- Activity events they are the actor of, in this circle.
  update packalong.activity_events a
     set deleted = true, updated_at = now()
   where a.deleted = false
     and a.actor_person_id = target_profile
     and a.trip_id in (select id from packalong.trips where circle_id = target_circle);

  -- Containers they created, in this circle.
  update packalong.pack_containers pc
     set deleted = true, updated_at = now()
   where pc.deleted = false
     and pc.created_by_person_id = target_profile
     and pc.trip_id in (select id from packalong.trips where circle_id = target_circle);

  -- Their trip participation in this circle.
  update packalong.participants p
     set deleted = true, updated_at = now()
   where p.deleted = false
     and p.person_id = target_profile
     and p.trip_id in (select id from packalong.trips where circle_id = target_circle);

  -- Their group memberships in this circle.
  update packalong.group_members gm
     set deleted = true, updated_at = now()
   where gm.deleted = false
     and gm.person_id = target_profile
     and gm.group_id in (select id from packalong.groups where circle_id = target_circle);

  -- Their membership: they leave the circle.
  update packalong.circle_members cm
     set deleted = true, updated_at = now()
   where cm.deleted = false
     and cm.circle_id = target_circle
     and cm.profile_id = target_profile;

  -- Expire any unconsumed invite pre-bound to them for this circle.
  update packalong.circle_invites ci
     set expires_at = now()
   where ci.circle_id = target_circle
     and ci.preassigned_profile_id = target_profile
     and ci.consumed_at is null
     and ci.expires_at > now();

  -- Tombstone the profile itself ONLY if it is a guest (no auth account) with
  -- no remaining active membership anywhere. Account profiles are untouched.
  if not exists (
        select 1 from packalong.profiles
         where id = target_profile and user_id is not null and deleted = false
     )
     and not exists (
        select 1 from packalong.circle_members
         where profile_id = target_profile and deleted = false
     )
  then
    update packalong.profiles
       set deleted = true, updated_at = now()
     where id = target_profile and deleted = false;
  end if;
end;
$$;

revoke all on function packalong.soft_delete_participant_data(uuid, uuid) from public;
revoke all on function packalong.soft_delete_participant_data(uuid, uuid) from anon;
revoke all on function packalong.soft_delete_participant_data(uuid, uuid) from authenticated;
grant execute on function packalong.soft_delete_participant_data(uuid, uuid) to service_role;
