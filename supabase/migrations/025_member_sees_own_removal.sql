-- 025_member_sees_own_removal.sql
--
-- Fix: a removed member never learned they were removed, so the circle stayed
-- in their app until they manually hit "leave" (reported 2026-07-16).
--
-- Root cause: removal is a soft-delete of their circle_members row
-- (soft_remove_member / pa-remove-member, migration 022). The tombstone is
-- meant to ride the normal incremental pull to the removed member's device,
-- where the client flips their local membership to deleted=true and drops the
-- circle. But the only SELECT policy on circle_members gated visibility on
-- `circle_id in (auth_circle_ids())`, and auth_circle_ids() returns only
-- circles where the caller has an ACTIVE (deleted=false) membership. The moment
-- the membership is soft-deleted the circle leaves that set, so the removed
-- member can no longer SELECT their own tombstone row — the very row that would
-- tell their device the removal happened. Result: no auto-removal; the member
-- is stranded in a circle the owner already removed them from.
--
-- Fix: let a user always see their OWN membership rows, active or tombstoned,
-- in any circle. This exposes the deleted=true row to the removed member so the
-- pull delivers it and the client drops the circle automatically. It leaks
-- nothing new — a user seeing their own membership rows is not a disclosure of
-- other members or circle content (those stay gated on auth_circle_ids()).
--
-- Applies to every app version: the client already applies its own membership
-- tombstone (circle list filters on deleted=false); only the server row was
-- unreachable.

drop policy if exists circle_members_select_member on packalong.circle_members;
create policy circle_members_select_member
  on packalong.circle_members
  for select
  to authenticated
  using (
    circle_id in (select packalong.auth_circle_ids())
    or profile_id = packalong.auth_profile_id()
  );
