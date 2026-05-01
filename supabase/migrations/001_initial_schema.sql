CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE OR REPLACE FUNCTION public.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TABLE IF NOT EXISTS public.users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  premium_status TEXT NOT NULL DEFAULT 'free',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.persons (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  profile_type TEXT NOT NULL DEFAULT 'guest',
  account_id TEXT,
  created_by_account_id TEXT,
  avatar_emoji TEXT,
  origin_instance TEXT,
  user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at TIMESTAMPTZ,
  dirty BOOLEAN NOT NULL DEFAULT false,
  dirty_fields TEXT,
  deleted BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS public.trips (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  owner_person_id TEXT NOT NULL REFERENCES public.persons(id) ON DELETE CASCADE,
  join_token TEXT UNIQUE,
  start_date TIMESTAMPTZ,
  end_date TIMESTAMPTZ,
  is_archived BOOLEAN NOT NULL DEFAULT false,
  origin_instance TEXT,
  user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at TIMESTAMPTZ,
  dirty BOOLEAN NOT NULL DEFAULT false,
  dirty_fields TEXT,
  deleted BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS public.pack_containers (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  icon TEXT,
  created_by_person_id TEXT REFERENCES public.persons(id) ON DELETE SET NULL,
  origin_instance TEXT,
  user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at TIMESTAMPTZ,
  dirty BOOLEAN NOT NULL DEFAULT false,
  dirty_fields TEXT,
  deleted BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS public.items (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  assigned_to_person_id TEXT REFERENCES public.persons(id) ON DELETE SET NULL,
  container_id TEXT REFERENCES public.pack_containers(id) ON DELETE SET NULL,
  category TEXT,
  note TEXT,
  updated_by_person_id TEXT REFERENCES public.persons(id) ON DELETE SET NULL,
  origin_instance TEXT,
  user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at TIMESTAMPTZ,
  dirty BOOLEAN NOT NULL DEFAULT false,
  dirty_fields TEXT,
  deleted BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE IF NOT EXISTS public.participants (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  person_id TEXT NOT NULL REFERENCES public.persons(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'guest',
  join_type TEXT NOT NULL DEFAULT 'local',
  joined_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  origin_instance TEXT,
  user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at TIMESTAMPTZ,
  dirty BOOLEAN NOT NULL DEFAULT false,
  dirty_fields TEXT,
  deleted BOOLEAN NOT NULL DEFAULT false,
  UNIQUE(trip_id, person_id)
);

CREATE TABLE IF NOT EXISTS public.person_devices (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  person_id TEXT NOT NULL REFERENCES public.persons(id) ON DELETE CASCADE,
  device_id TEXT NOT NULL,
  access_token TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(person_id, device_id)
);

CREATE TABLE IF NOT EXISTS public.person_claims (
  id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::TEXT,
  person_id TEXT NOT NULL REFERENCES public.persons(id) ON DELETE CASCADE,
  claim_token TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS trg_persons_updated_at ON public.persons;
CREATE TRIGGER trg_persons_updated_at
BEFORE UPDATE ON public.persons
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS trg_trips_updated_at ON public.trips;
CREATE TRIGGER trg_trips_updated_at
BEFORE UPDATE ON public.trips
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS trg_pack_containers_updated_at ON public.pack_containers;
CREATE TRIGGER trg_pack_containers_updated_at
BEFORE UPDATE ON public.pack_containers
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS trg_items_updated_at ON public.items;
CREATE TRIGGER trg_items_updated_at
BEFORE UPDATE ON public.items
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at();

DROP TRIGGER IF EXISTS trg_participants_updated_at ON public.participants;
CREATE TRIGGER trg_participants_updated_at
BEFORE UPDATE ON public.participants
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at();
