-- 013_item_comments.sql
--
-- Per-item discussion comments (feature #22). Mirrors the packalong sync
-- table conventions from 005–010: uuid keys, packalong schema, the shared
-- sync columns (origin_instance/user_id/synced_at/dirty/dirty_fields/deleted),
-- the packalong.set_updated_at() trigger, and RLS bridged through
-- packalong.can_access_trip()/can_edit_trip().

create table if not exists packalong.item_comments (
  id               uuid primary key,
  item_id          uuid not null references packalong.items(id) on delete cascade,
  person_id        uuid not null references packalong.profiles(id) on delete cascade,
  comment_text     text not null,
  origin_instance  text,
  user_id          text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  synced_at        timestamptz,
  dirty            boolean not null default false,
  dirty_fields     text,
  deleted          boolean not null default false
);

drop trigger if exists item_comments_set_updated_at on packalong.item_comments;
create trigger item_comments_set_updated_at
  before update on packalong.item_comments
  for each row execute function packalong.set_updated_at();

alter table packalong.item_comments enable row level security;

drop policy if exists item_comments_select_accessible on packalong.item_comments;
create policy item_comments_select_accessible on packalong.item_comments
for select
using (
  exists (
    select 1
    from packalong.items i
    where i.id = item_comments.item_id
      and packalong.can_access_trip(i.trip_id)
  )
);

drop policy if exists item_comments_insert_editors on packalong.item_comments;
create policy item_comments_insert_editors on packalong.item_comments
for insert
with check (
  exists (
    select 1
    from packalong.items i
    where i.id = item_comments.item_id
      and packalong.can_edit_trip(i.trip_id)
  )
);

drop policy if exists item_comments_update_editors on packalong.item_comments;
create policy item_comments_update_editors on packalong.item_comments
for update
using (
  exists (
    select 1
    from packalong.items i
    where i.id = item_comments.item_id
      and packalong.can_edit_trip(i.trip_id)
  )
)
with check (
  exists (
    select 1
    from packalong.items i
    where i.id = item_comments.item_id
      and packalong.can_edit_trip(i.trip_id)
  )
);

drop policy if exists item_comments_delete_editors on packalong.item_comments;
create policy item_comments_delete_editors on packalong.item_comments
for delete
using (
  exists (
    select 1
    from packalong.items i
    where i.id = item_comments.item_id
      and packalong.can_edit_trip(i.trip_id)
  )
);

create index if not exists item_comments_item_idx
  on packalong.item_comments (item_id) where deleted = false;
create index if not exists item_comments_person_idx
  on packalong.item_comments (person_id);
create index if not exists item_comments_updated_idx
  on packalong.item_comments (updated_at);
