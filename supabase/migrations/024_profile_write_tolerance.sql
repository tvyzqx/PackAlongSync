-- 024_profile_write_tolerance.sql
--
-- Second half of the "joined member shows as local" stopgap (see 021). 021
-- covered the circles / circle_members poison rows on the MEMBER's push. This
-- covers the `profiles` poison row, which strands BOTH devices:
--   * the OWNER's push contains the joined member's account profile
--     (user_id = <member>), and
--   * the MEMBER's push contains every other member's account profile
--     (pulled via profiles_select_self_or_circle, then re-marked dirty and
--     re-pushed by the sync engine).
-- Either way `profiles_insert_self_or_guest` (WITH CHECK
-- user_id = auth.uid() OR user_id IS NULL) rejects the foreign account row, and
-- because the push is one batch, the whole push aborts — so the member never
-- confirms to the server and keeps showing as "local" on every device,
-- including the owner's. Verified live 2026-07-14 (owner <-> member).
--
-- Durable fix is client-side (do not push profiles whose user_id is neither
-- yours nor null) — see docs/sync-circles-fix-spec.md. Until then, tolerate it:
-- a BEFORE trigger turns any write to a FOREIGN account profile into a no-op
-- (INSERT of such a row is skipped; UPDATE reverts every field). Writes to your
-- OWN profile and to GUEST profiles (user_id IS NULL, e.g. an owner editing a
-- guest they manage) are untouched, so existing behaviour is preserved. No RLS
-- policy is changed: the skip happens in the BEFORE-INSERT trigger before the
-- WITH CHECK is evaluated, and the owner UPDATE path already reaches foreign
-- profiles (profiles_update_self_or_circle_owner) where the trigger neutralizes
-- it. service_role (edge functions) is short-circuited to full pass-through.
--
-- Validated live (rolled back): the owner pushing the member's profile and the
-- member pushing the owner's profile — each with a malicious rename + deleted=true — are
-- both accepted as no-ops and leave the target rows unchanged, while each
-- user's edit of their OWN profile still applies.

begin;

create or replace function packalong.guard_nonowner_profile()
returns trigger
language plpgsql
security definer
set search_path to 'packalong', 'pg_temp'
as $$
begin
  if auth.uid() is null then
    return new;  -- service_role (edge functions)
  end if;

  if tg_op = 'INSERT' then
    -- own profile or a guest profile: allowed by profiles_insert_self_or_guest.
    if new.user_id is null or new.user_id = auth.uid() then
      return new;
    end if;
    -- foreign account profile: drop the row -> upsert collapses to a no-op.
    return null;
  end if;

  -- UPDATE
  if new.user_id = auth.uid() then
    return new;  -- editing your own profile
  end if;
  if old.user_id is not null and old.user_id <> auth.uid() then
    -- foreign account profile: neutralize (keep the stored row verbatim).
    new.user_id        := old.user_id;
    new.profile_type   := old.profile_type;
    new.name           := old.name;
    new.avatar_emoji   := old.avatar_emoji;
    new.avatar_color   := old.avatar_color;
    new.email          := old.email;
    new.origin_instance := old.origin_instance;
    new.created_at     := old.created_at;
    new.deleted        := old.deleted;
    new.updated_at     := old.updated_at;
    return new;
  end if;
  -- guest profile (old.user_id is null) edited by a circle owner: permitted.
  return new;
end;
$$;

drop trigger if exists guard_nonowner on packalong.profiles;
create trigger guard_nonowner
  before insert or update on packalong.profiles
  for each row execute function packalong.guard_nonowner_profile();

commit;
