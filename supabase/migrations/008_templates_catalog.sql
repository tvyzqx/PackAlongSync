-- 008_templates_catalog.sql
--
-- Phase 3 step 4 of 6: pack templates, template items, template
-- categories, catalog items. Mirrors
--   packalong/lib/db/tables/pack_templates.dart
--   packalong/lib/db/tables/template_items.dart
--   packalong/lib/db/tables/template_categories.dart
--   packalong/lib/db/tables/catalog_items.dart
--
-- Sync anchor: pack_templates, template_categories, catalog_items carry
-- circle_id directly. template_items inherits scope via template_id and
-- gets bridged through the parent template's circle.
--
-- is_system (ADR-11): every table here can host App-Binary-seeded
-- system rows. The sync layer filters `WHERE is_system = false` on read,
-- and the RLS policies in 011 enforce `WITH CHECK (is_system = false)`
-- on writes for non-service roles so clients can't promote a row to
-- system status.
--
-- Ordering: pack_templates and template_categories first (no inter-
-- dependencies), then catalog_items (FK to template_categories), then
-- template_items (FK to pack_templates AND catalog_items).

-- pack_templates -----------------------------------------------------------

create table packalong.pack_templates (
  id              uuid primary key,
  circle_id       uuid not null references packalong.circles(id) on delete cascade,
  name            text not null,
  name_key        text,
  icon            text,
  theme           text,
  is_system       boolean not null default false,
  origin_instance text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  synced_at       timestamptz,
  dirty           boolean not null default false,
  dirty_fields    text,
  deleted         boolean not null default false
);

create index pack_templates_circle_idx
  on packalong.pack_templates (circle_id) where deleted = false;
create index pack_templates_is_system_idx
  on packalong.pack_templates (is_system);

create trigger pack_templates_set_updated_at
  before update on packalong.pack_templates
  for each row execute function packalong.set_updated_at();

-- template_categories ------------------------------------------------------
--
-- icon + color are NOT NULL in the Drift schema; we preserve that.

create table packalong.template_categories (
  id              uuid primary key,
  circle_id       uuid not null references packalong.circles(id) on delete cascade,
  key             text not null,
  name            text not null,
  name_key        text,
  icon            text not null,
  color           text not null,
  is_system       boolean not null default false,
  origin_instance text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  synced_at       timestamptz,
  dirty           boolean not null default false,
  dirty_fields    text,
  deleted         boolean not null default false
);

create index template_categories_circle_idx
  on packalong.template_categories (circle_id) where deleted = false;
create index template_categories_is_system_idx
  on packalong.template_categories (is_system);

create trigger template_categories_set_updated_at
  before update on packalong.template_categories
  for each row execute function packalong.set_updated_at();

-- items.category_id FK -----------------------------------------------------
--
-- Migration 006 left category_id as a bare uuid. Now that
-- template_categories exists, wire the constraint up. SET NULL on
-- delete preserves items when a category is removed.

alter table packalong.items
  add constraint items_category_id_fkey
  foreign key (category_id) references packalong.template_categories(id) on delete set null;

-- catalog_items ------------------------------------------------------------
--
-- Reusable item definitions ("Wanderstöcke", "Sonnencreme", …) that can
-- be dropped into a template or directly added to a trip. tag_slugs is
-- a JSON array text — the Drift schema stores it as text with default
-- '[]'; we keep the same shape to avoid a sync-layer conversion.

create table packalong.catalog_items (
  id                   uuid primary key,
  circle_id            uuid not null references packalong.circles(id) on delete cascade,
  title                text not null,
  title_key            text,
  kind                 text not null default 'gear'
                            check (kind in ('gear', 'task')),
  category_id          uuid references packalong.template_categories(id) on delete set null,
  category             text,
  tag_slugs            text not null default '[]',
  default_quantity     integer not null default 1,
  preset_container_id  uuid references packalong.preset_containers(id) on delete set null,
  note                 text,
  is_system            boolean not null default false,
  origin_instance      text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  synced_at            timestamptz,
  dirty                boolean not null default false,
  dirty_fields         text,
  deleted              boolean not null default false
);

create index catalog_items_circle_idx
  on packalong.catalog_items (circle_id) where deleted = false;
create index catalog_items_category_idx
  on packalong.catalog_items (category_id) where category_id is not null;
create index catalog_items_preset_container_idx
  on packalong.catalog_items (preset_container_id) where preset_container_id is not null;
create index catalog_items_is_system_idx
  on packalong.catalog_items (is_system);

create trigger catalog_items_set_updated_at
  before update on packalong.catalog_items
  for each row execute function packalong.set_updated_at();

-- template_items -----------------------------------------------------------
--
-- The "lines" inside a pack template. Scope inherits from the parent
-- template's circle. catalog_item_id links to the catalog row when the
-- line was added via the catalog; nullable so ad-hoc lines still work.

create table packalong.template_items (
  id                   uuid primary key,
  template_id          uuid not null references packalong.pack_templates(id) on delete cascade,
  title                text not null,
  title_key            text,
  kind                 text not null default 'gear'
                            check (kind in ('gear', 'task')),
  category             text,
  tag_slugs            text not null default '[]',
  quantity             integer not null default 1,
  sort_order           integer not null default 0,
  preset_container_id  uuid references packalong.preset_containers(id) on delete set null,
  catalog_item_id      uuid references packalong.catalog_items(id) on delete set null,
  origin_instance      text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  synced_at            timestamptz,
  dirty                boolean not null default false,
  dirty_fields         text,
  deleted              boolean not null default false
);

create index template_items_template_idx
  on packalong.template_items (template_id) where deleted = false;
create index template_items_catalog_idx
  on packalong.template_items (catalog_item_id) where catalog_item_id is not null;

create trigger template_items_set_updated_at
  before update on packalong.template_items
  for each row execute function packalong.set_updated_at();
