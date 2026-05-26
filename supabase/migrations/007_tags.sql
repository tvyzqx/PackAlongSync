-- 007_tags.sql
--
-- Phase 3 step 3 of 6: tags + item_tags pivot. Mirrors
--   packalong/lib/db/tables/tags.dart
-- plus a forward-looking pivot table `item_tags` that the Drift schema
-- doesn't carry yet — Plan §4.5 + §4.6 + ADR-11 list item_tags as a
-- sync entity, so the server provisions the shape now. Once the Drift
-- side grows the same table (deferred until n:m tagging actually lands
-- in the UI), sync will populate it without further server changes.
-- Until then the existing items.tag_id column carries 1:1 tagging.
--
-- ADR-11 system-template flag: tags.is_system stays for parity with
-- pack_templates / template_categories / catalog_items. The is_system
-- guard (clients can't flip it to true) is enforced via RLS in 011.

-- tags ---------------------------------------------------------------------

create table packalong.tags (
  id              uuid primary key,
  circle_id       uuid not null references packalong.circles(id) on delete cascade,
  name            text not null,
  color           text not null,
  icon            text,
  emoji           text,
  slug            text,
  is_system       boolean not null default false,
  origin_instance text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  synced_at       timestamptz,
  dirty           boolean not null default false,
  dirty_fields    text,
  deleted         boolean not null default false
);

create index tags_circle_idx
  on packalong.tags (circle_id) where deleted = false;
create index tags_is_system_idx
  on packalong.tags (is_system);

create trigger tags_set_updated_at
  before update on packalong.tags
  for each row execute function packalong.set_updated_at();

-- items.tag_id FK ----------------------------------------------------------
--
-- Migration 006 left tag_id as a bare uuid (tags didn't exist yet). Now
-- that the target table is in place we can wire up the constraint. ON
-- DELETE SET NULL preserves the v1 behavior: dropping a tag clears it
-- from items but doesn't cascade-delete the items themselves.

alter table packalong.items
  add constraint items_tag_id_fkey
  foreign key (tag_id) references packalong.tags(id) on delete set null;

-- item_tags pivot ----------------------------------------------------------
--
-- Composite (item_id, tag_id) PK gives idempotent upserts and a natural
-- uniqueness guarantee. Sync columns mirror the pattern from
-- circle_members — pivot rows still need dirty/synced_at bookkeeping
-- so the sync layer can track them like any other entity.

create table packalong.item_tags (
  item_id         uuid not null references packalong.items(id) on delete cascade,
  tag_id          uuid not null references packalong.tags(id) on delete cascade,
  origin_instance text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  synced_at       timestamptz,
  dirty           boolean not null default false,
  dirty_fields    text,
  deleted         boolean not null default false,
  primary key (item_id, tag_id)
);

create index item_tags_tag_idx
  on packalong.item_tags (tag_id) where deleted = false;

create trigger item_tags_set_updated_at
  before update on packalong.item_tags
  for each row execute function packalong.set_updated_at();
