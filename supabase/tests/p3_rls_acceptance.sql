-- p3_rls_acceptance.sql
--
-- Acceptance smoke-tests for Phase 3 (migrations 005–012, especially the
-- RLS policies in 011_sync_rls.sql). Designed to be run end-to-end against
-- a database that has all P1+P2+P3 migrations applied.
--
-- Run as: docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -f - < p3_rls_acceptance.sql
-- or via the apply-pattern from server-packalong-sync.md.
--
-- The script bootstraps four users (alice owner, bob member, carol viewer
-- in circle "Familie"; dave owner in a separate circle "Freunde"), a trip
-- with normal + personal items, and then exercises the three RLS tiers
-- (Editor / Admin / Audit) plus is_personal visibility and cross-circle
-- isolation. Every check is wrapped in a DO block that raises an
-- exception on mismatch — the first failure aborts the run.
--
-- Wrapped in BEGIN/ROLLBACK so the database is unchanged after the run.
-- Re-runnable.
--
-- Caveats:
--   * Inserts into auth.users use the minimum fields needed for a JWT
--     subject to resolve. If your auth schema enforces extra columns
--     (instance_id NOT NULL without default, etc.), the bootstrap block
--     needs the matching values — adjust there, not in the assertions.
--   * set_config('request.jwt.claims', ..., true) + set local role
--     authenticated is the standard PostgREST-context simulation.
--   * Each scenario resets the JWT context. The bootstrap and final
--     teardown sit outside any role switch so they run as the executing
--     superuser / service_role.

begin;

set search_path to packalong, public;

-- Test-data UUIDs ----------------------------------------------------------

-- auth users
\set alice_uid '''11111111-1111-1111-1111-111111111111'''
\set bob_uid   '''22222222-2222-2222-2222-222222222222'''
\set carol_uid '''33333333-3333-3333-3333-333333333333'''
\set dave_uid  '''44444444-4444-4444-4444-444444444444'''

-- profiles
\set alice_pid '''aaaaaaaa-1111-1111-1111-111111111111'''
\set bob_pid   '''aaaaaaaa-2222-2222-2222-222222222222'''
\set carol_pid '''aaaaaaaa-3333-3333-3333-333333333333'''
\set dave_pid  '''aaaaaaaa-4444-4444-4444-444444444444'''

-- circles
\set familie_cid '''bbbbbbbb-1111-1111-1111-111111111111'''
\set freunde_cid '''bbbbbbbb-2222-2222-2222-222222222222'''

-- trip, items
\set trip_id '''cccccccc-1111-1111-1111-111111111111'''
\set normal_item_id   '''dddddddd-1111-1111-1111-111111111111'''
\set personal_item_id '''dddddddd-2222-2222-2222-222222222222'''
\set personal_null_item_id '''dddddddd-3333-3333-3333-333333333333'''
\set ae_alice_id      '''eeeeeeee-1111-1111-1111-111111111111'''
\set ae_bob_id        '''eeeeeeee-2222-2222-2222-222222222222'''

-- Bootstrap auth users -----------------------------------------------------
-- Minimal insert; adjust if your auth.users has additional NOT NULL fields
-- without defaults.

insert into auth.users (id, email)
values
  (:alice_uid, 'alice@p3-acceptance.local'),
  (:bob_uid,   'bob@p3-acceptance.local'),
  (:carol_uid, 'carol@p3-acceptance.local'),
  (:dave_uid,  'dave@p3-acceptance.local');

-- Bootstrap profiles + circles + memberships -------------------------------

insert into packalong.profiles (id, user_id, profile_type, name) values
  (:alice_pid, :alice_uid, 'account', 'Alice'),
  (:bob_pid,   :bob_uid,   'account', 'Bob'),
  (:carol_pid, :carol_uid, 'account', 'Carol'),
  (:dave_pid,  :dave_uid,  'account', 'Dave');

insert into packalong.circles (id, name, created_by) values
  (:familie_cid, 'Familie', :alice_uid),
  (:freunde_cid, 'Freunde', :dave_uid);

insert into packalong.circle_members (circle_id, profile_id, role) values
  (:familie_cid, :alice_pid, 'owner'),
  (:familie_cid, :bob_pid,   'member'),
  (:familie_cid, :carol_pid, 'viewer'),
  (:freunde_cid, :dave_pid,  'owner');

-- Bootstrap trip + items + activity_events ---------------------------------

insert into packalong.trips (id, circle_id, owner_person_id, title) values
  (:trip_id, :familie_cid, :alice_pid, 'Sommerurlaub');

insert into packalong.items
  (id, trip_id, title, is_personal, created_by_person_id, assigned_to_person_id)
values
  (:normal_item_id,        :trip_id, 'Zelt',          false, :alice_pid, null),
  (:personal_item_id,      :trip_id, 'Tagebuch',      true,  :alice_pid, :bob_pid),
  -- created_by NULL on purpose (ADR-14 NULL-fallback test)
  (:personal_null_item_id, :trip_id, 'Heimlicher Brief', true, null,     :bob_pid);

insert into packalong.activity_events
  (id, trip_id, actor_person_id, action, target_type, target_id)
values
  (:ae_alice_id, :trip_id, :alice_pid, 'created', 'item', :normal_item_id),
  (:ae_bob_id,   :trip_id, :bob_pid,   'updated', 'item', :normal_item_id);

-- Helper: assert(expected_int, actual_int, label) --------------------------
-- Inline pattern via DO + RAISE EXCEPTION used directly in each test so the
-- log line tells you which check failed.

-- ==========================================================================
-- Scenario 1: anon (no JWT) sees nothing
-- ==========================================================================

reset role;
select set_config('request.jwt.claims', '', true);
set local role anon;

do $$
declare
  n int;
begin
  select count(*) into n from packalong.trips;
  if n <> 0 then raise exception 'S1.anon: trips visible to anon (got %)', n; end if;
  select count(*) into n from packalong.items;
  if n <> 0 then raise exception 'S1.anon: items visible to anon (got %)', n; end if;
  select count(*) into n from packalong.pack_templates;
  if n <> 0 then raise exception 'S1.anon: pack_templates visible to anon (got %)', n; end if;
  select count(*) into n from packalong.circle_members;
  if n <> 0 then raise exception 'S1.anon: circle_members visible to anon (got %)', n; end if;
end $$;

-- ==========================================================================
-- Scenario 2: cross-circle isolation
-- ==========================================================================
-- Dave is owner of "Freunde" only. He must not see Alice's trip / items.

reset role;
select set_config('request.jwt.claims', json_build_object('sub', '44444444-4444-4444-4444-444444444444')::text, true);
set local role authenticated;

do $$
declare
  n int;
begin
  select count(*) into n from packalong.trips;
  if n <> 0 then raise exception 'S2.dave: trips cross-leaked (got %)', n; end if;
  select count(*) into n from packalong.items;
  if n <> 0 then raise exception 'S2.dave: items cross-leaked (got %)', n; end if;
  select count(*) into n from packalong.circles where id <> 'bbbbbbbb-2222-2222-2222-222222222222';
  if n <> 0 then raise exception 'S2.dave: foreign circles visible (got %)', n; end if;
end $$;

-- ==========================================================================
-- Scenario 3: viewer (Carol) — read-only
-- ==========================================================================
-- Carol sees everything non-personal in her circle but cannot mutate.

reset role;
select set_config('request.jwt.claims', json_build_object('sub', '33333333-3333-3333-3333-333333333333')::text, true);
set local role authenticated;

do $$
declare
  n int;
  err_caught boolean;
begin
  -- Carol should see Alice's trip + Zelt (normal item). Personal items not hers → invisible.
  select count(*) into n from packalong.trips;
  if n <> 1 then raise exception 'S3.carol.read: expected 1 trip, got %', n; end if;
  select count(*) into n from packalong.items;
  if n <> 1 then raise exception 'S3.carol.read: expected 1 non-personal item, got %', n; end if;

  -- INSERT trip must fail (RLS WITH CHECK).
  err_caught := false;
  begin
    insert into packalong.trips (id, circle_id, owner_person_id, title)
      values (gen_random_uuid(), 'bbbbbbbb-1111-1111-1111-111111111111',
              'aaaaaaaa-3333-3333-3333-333333333333', 'Carol-Trip');
  exception when others then err_caught := true;
  end;
  if not err_caught then raise exception 'S3.carol.insert_trip: WITH CHECK did not block viewer'; end if;

  -- UPDATE existing trip must affect 0 rows (USING blocks the row).
  update packalong.trips set title = 'Hijacked' where id = 'cccccccc-1111-1111-1111-111111111111';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'S3.carol.update_trip: USING did not block viewer (% rows)', n; end if;
end $$;

-- ==========================================================================
-- Scenario 4: member (Bob) — editor on most tables, blocked on participants
-- ==========================================================================

reset role;
select set_config('request.jwt.claims', json_build_object('sub', '22222222-2222-2222-2222-222222222222')::text, true);
set local role authenticated;

do $$
declare
  n int;
  err_caught boolean;
begin
  -- Bob CAN edit items (Editor tier).
  update packalong.items set title = 'Zelt 2.0' where id = 'dddddddd-1111-1111-1111-111111111111';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'S4.bob.update_item: expected 1, got %', n; end if;

  -- Bob CAN insert a template (A1/A2 — editor tier, no is_system guard).
  insert into packalong.pack_templates
    (id, circle_id, name, is_system)
  values
    ('eeeeeeee-aaaa-1111-1111-111111111111', 'bbbbbbbb-1111-1111-1111-111111111111',
     'Mein Wanderset', true);
  -- ^ is_system=true MUST be allowed for Bob (member) per ADR-11 v3-revidiert.

  -- Bob CAN delete the template he just made.
  delete from packalong.pack_templates where id = 'eeeeeeee-aaaa-1111-1111-111111111111';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'S4.bob.delete_template: expected 1, got %', n; end if;

  -- Bob CANNOT insert a participant (Admin tier).
  err_caught := false;
  begin
    insert into packalong.participants (id, trip_id, person_id, role, join_type)
      values (gen_random_uuid(), 'cccccccc-1111-1111-1111-111111111111',
              'aaaaaaaa-2222-2222-2222-222222222222', 'editor', 'account');
  exception when others then err_caught := true;
  end;
  if not err_caught then raise exception 'S4.bob.insert_participant: admin-tier did not block member'; end if;
end $$;

-- ==========================================================================
-- Scenario 5: owner (Alice) — can do admin actions
-- ==========================================================================

reset role;
select set_config('request.jwt.claims', json_build_object('sub', '11111111-1111-1111-1111-111111111111')::text, true);
set local role authenticated;

do $$
declare
  n int;
begin
  -- Alice CAN add a participant.
  insert into packalong.participants (id, trip_id, person_id, role, join_type)
    values ('fffffff1-0000-0000-0000-000000000001', 'cccccccc-1111-1111-1111-111111111111',
            'aaaaaaaa-2222-2222-2222-222222222222', 'editor', 'account');

  -- Alice CAN delete trip_history (admin-tier DELETE).
  insert into packalong.trip_history_items
    (id, trip_id, source_item_id, title, status_at_archive, archived_at)
    values ('fffffff2-0000-0000-0000-000000000002', 'cccccccc-1111-1111-1111-111111111111',
            'dddddddd-1111-1111-1111-111111111111', 'Zelt', 'packed', now());
  delete from packalong.trip_history_items where id = 'fffffff2-0000-0000-0000-000000000002';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'S5.alice.delete_history: expected 1, got %', n; end if;
end $$;

-- ==========================================================================
-- Scenario 6: is_personal visibility
-- ==========================================================================

-- 6a) Bob (assignee) sees the personal item assigned to him.
reset role;
select set_config('request.jwt.claims', json_build_object('sub', '22222222-2222-2222-2222-222222222222')::text, true);
set local role authenticated;

do $$
declare
  n int;
begin
  select count(*) into n from packalong.items where is_personal = true;
  -- Bob is assigned to both personal items → both visible.
  if n <> 2 then raise exception 'S6a.bob.personal: expected 2 personal items, got %', n; end if;
end $$;

-- 6b) Carol (viewer, not assigned to any personal item) sees zero personal items.
reset role;
select set_config('request.jwt.claims', json_build_object('sub', '33333333-3333-3333-3333-333333333333')::text, true);
set local role authenticated;

do $$
declare
  n int;
begin
  select count(*) into n from packalong.items where is_personal = true;
  if n <> 0 then raise exception 'S6b.carol.personal: expected 0 personal items, got %', n; end if;
end $$;

-- 6c) Alice (creator of "Tagebuch", but NOT assignee of "Heimlicher Brief"
-- whose created_by is NULL) sees only the one where she's creator.
reset role;
select set_config('request.jwt.claims', json_build_object('sub', '11111111-1111-1111-1111-111111111111')::text, true);
set local role authenticated;

do $$
declare
  n int;
begin
  -- Alice sees: Tagebuch (she is created_by). Heimlicher Brief: created_by NULL,
  -- assigned_to=Bob → Alice is neither → invisible. So count == 1.
  select count(*) into n from packalong.items where is_personal = true;
  if n <> 1 then raise exception 'S6c.alice.personal: expected 1 (Tagebuch only), got %', n; end if;
end $$;

-- ==========================================================================
-- Scenario 7: activity_events audit-tier
-- ==========================================================================

-- 7a) Bob can update his own event but not Alice's.
reset role;
select set_config('request.jwt.claims', json_build_object('sub', '22222222-2222-2222-2222-222222222222')::text, true);
set local role authenticated;

do $$
declare
  n int;
begin
  -- Bob's own event: update succeeds.
  update packalong.activity_events set action = 'corrected'
   where id = 'eeeeeeee-2222-2222-2222-222222222222';
  get diagnostics n = row_count;
  if n <> 1 then raise exception 'S7a.bob.update_own_event: expected 1, got %', n; end if;

  -- Alice's event: USING blocks the row → 0 rows updated.
  update packalong.activity_events set action = 'hijacked'
   where id = 'eeeeeeee-1111-1111-1111-111111111111';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'S7a.bob.update_alice_event: USING did not block (% rows)', n; end if;
end $$;

-- 7b) Authenticated cannot DELETE activity_events at all.
reset role;
select set_config('request.jwt.claims', json_build_object('sub', '11111111-1111-1111-1111-111111111111')::text, true);
set local role authenticated;

do $$
declare
  n int;
begin
  -- Even Alice (owner) gets 0 rows deleted — no DELETE policy granted.
  delete from packalong.activity_events where id = 'eeeeeeee-1111-1111-1111-111111111111';
  get diagnostics n = row_count;
  if n <> 0 then raise exception 'S7b.alice.delete_event: expected 0 rows, got % (no DELETE policy means RLS should block)', n; end if;
end $$;

-- ==========================================================================
-- Done — rollback all test data
-- ==========================================================================

reset role;
select set_config('request.jwt.claims', '', true);

\echo 'p3_rls_acceptance.sql: all scenarios passed.'

rollback;
