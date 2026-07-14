-- 022_remove_member.sql
--
-- Owner-triggered removal of a single member from a circle. Until now removing
-- a member was done client-side by a direct write to circle_members, with no
-- single authorized gateway — inconsistent (soft vs hard delete) and, combined
-- with pa-join-circle previously refusing to reactivate a soft-deleted row,
-- left removed members unable to cleanly re-join (see the 2026-07-14 case).
--
-- This is the counterpart to pa-join-circle (add) and pa-delete-circle (tear
-- down the whole circle). Like soft_delete_circle it is a soft-delete so the
-- tombstone rides the normal incremental pull to every device: circle_members
-- (deleted=true, updated_at bumped) is pulled without a circle_id filter, so
-- the removal reaches the removed member's own device and drops the circle from
-- their UI. Removal does NOT touch the member's contributed data (trips, items,
-- …) — that is a separate, explicit action (pa-delete-participant-data).
--
-- Any still-open (unconsumed) invite that was pre-bound to this member for this
-- circle is expired, so a stale guest-bound token can't silently re-admit them
-- after removal; a fresh invite (the owner's explicit re-add) still works and,
-- with the 021+join-circle changes, reactivates their membership cleanly.
--
-- SECURITY DEFINER with NO internal auth check: the owner authorization lives
-- in the pa-remove-member edge function (service_role), mirroring
-- soft_delete_circle. Execute is granted to service_role only so the edge
-- function is the sole gateway.

create or replace function packalong.soft_remove_member(
  target_circle uuid,
  target_profile uuid
)
returns void
language plpgsql
security definer
set search_path = packalong, pg_temp
as $$
begin
  update packalong.circle_members
     set deleted = true, updated_at = now()
   where circle_id = target_circle
     and profile_id = target_profile
     and deleted = false;

  -- Revoke (expire) any unconsumed invite pre-bound to this profile for this
  -- circle. Unbound QR invites are left alone — they are not member-specific.
  update packalong.circle_invites
     set expires_at = now()
   where circle_id = target_circle
     and preassigned_profile_id = target_profile
     and consumed_at is null
     and expires_at > now();
end;
$$;

revoke all on function packalong.soft_remove_member(uuid, uuid) from public;
revoke all on function packalong.soft_remove_member(uuid, uuid) from anon;
revoke all on function packalong.soft_remove_member(uuid, uuid) from authenticated;
grant execute on function packalong.soft_remove_member(uuid, uuid) to service_role;
