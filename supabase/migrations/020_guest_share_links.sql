-- 020_guest_share_links.sql
--
-- Guest-view feature (Issue #1). A circle owner mints an unguessable,
-- expiring token that renders a public, read-only web page showing exactly
-- one guest's packing list for exactly one trip (see the pa-guest-view edge
-- function). Token shape/hygiene mirror packalong.circle_invites (003).
--
-- Security model:
--   * The public page is served by a service-role edge function, NOT via
--     RLS — the anon role never touches this table directly.
--   * The "join the circle" button is only wired up when the guest profile
--     carries an email (019). It points at an email-bound circle_invite
--     (companion_invite_token, invited_role='member', email_target=guest
--     email). The link alone does not admit anyone: join-circle enforces the
--     email binding, so a joiner must authenticate as that address.
--   * A guest profile WITHOUT an email gets no companion invite and the page
--     shows only an app-download link.
--
-- RLS below scopes owner-facing select/insert/revoke to the circle owner via
-- is_circle_owner(circle_id) (002). update is used for revoke (revoked_at).

create table packalong.guest_share_links (
  token                   text primary key,
  trip_id                 uuid not null references packalong.trips(id)    on delete cascade,
  profile_id              uuid not null references packalong.profiles(id) on delete cascade,
  circle_id               uuid not null references packalong.circles(id)  on delete cascade,
  issued_by               uuid not null references auth.users(id)         on delete cascade,
  issued_at               timestamptz not null default now(),
  -- nullable = never expires; pa-generate-guest-share defaults to +30 days.
  expires_at              timestamptz,
  revoked_at              timestamptz,
  -- optional pre-minted email-bound invite backing the "join" button. set
  -- null (not cascade-delete) if the invite row is ever pruned so the share
  -- link survives as a view-only page.
  companion_invite_token  text references packalong.circle_invites(token) on delete set null
);

-- Active-link hygiene: pa-generate-guest-share revokes any still-open link
-- for the same (profile, trip) before issuing a new one. expires_at is left
-- out of the predicate because now() is not immutable; the function filters
-- expiry at read time.
create index guest_share_links_active_idx
  on packalong.guest_share_links (profile_id, trip_id)
  where revoked_at is null;

create index guest_share_links_circle_idx
  on packalong.guest_share_links (circle_id);

-- RLS: owner-only management surface. The public read path runs through the
-- service role inside pa-guest-view and bypasses these policies.
alter table packalong.guest_share_links enable row level security;

create policy guest_share_links_select_owner
  on packalong.guest_share_links
  for select
  to authenticated
  using (packalong.is_circle_owner(circle_id));

create policy guest_share_links_insert_owner
  on packalong.guest_share_links
  for insert
  to authenticated
  with check (packalong.is_circle_owner(circle_id));

create policy guest_share_links_update_owner
  on packalong.guest_share_links
  for update
  to authenticated
  using (packalong.is_circle_owner(circle_id))
  with check (packalong.is_circle_owner(circle_id));
