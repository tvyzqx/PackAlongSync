-- 019_profile_email.sql
--
-- Guest-view feature (Issue #1): a guest profile may carry an email so a
-- share page can offer an email-bound "join the circle" path. The column is
-- nullable — most profiles (accounts derive their address from auth.users,
-- in-person guests have none) leave it empty.
--
-- profiles is already published for realtime and syncs in full, so the new
-- column rides along the generic dirty-row upsert with no publication or RLS
-- change. It is metadata only; the actual join gate lives in the
-- email-bound circle_invite (email_target) and join-circle's binding check.

alter table packalong.profiles
  add column if not exists email text;
