ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.persons ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trips ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pack_containers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.items ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.person_devices ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.person_claims ENABLE ROW LEVEL SECURITY;

CREATE OR REPLACE FUNCTION public.current_account_id()
RETURNS TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT auth.uid()::TEXT;
$$;

CREATE OR REPLACE FUNCTION public.current_person_ids()
RETURNS SETOF TEXT
LANGUAGE sql
STABLE
AS $$
  SELECT p.id
  FROM public.persons p
  WHERE p.deleted = false
    AND (
      p.account_id = public.current_account_id()
      OR p.created_by_account_id = public.current_account_id()
    );
$$;

CREATE OR REPLACE FUNCTION public.can_access_trip(target_trip_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.participants part
    WHERE part.trip_id = target_trip_id
      AND part.deleted = false
      AND part.person_id IN (SELECT * FROM public.current_person_ids())
  );
$$;

CREATE OR REPLACE FUNCTION public.can_edit_trip(target_trip_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.participants part
    WHERE part.trip_id = target_trip_id
      AND part.deleted = false
      AND part.role IN ('owner', 'editor')
      AND part.person_id IN (SELECT * FROM public.current_person_ids())
  );
$$;

CREATE OR REPLACE FUNCTION public.is_trip_owner(target_trip_id TEXT)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.trips t
    WHERE t.id = target_trip_id
      AND t.deleted = false
      AND t.owner_person_id IN (SELECT * FROM public.current_person_ids())
  );
$$;

DROP POLICY IF EXISTS users_select_self ON public.users;
CREATE POLICY users_select_self ON public.users
FOR SELECT
USING (id = public.current_account_id());

DROP POLICY IF EXISTS users_insert_self ON public.users;
CREATE POLICY users_insert_self ON public.users
FOR INSERT
WITH CHECK (id = public.current_account_id());

DROP POLICY IF EXISTS users_update_self ON public.users;
CREATE POLICY users_update_self ON public.users
FOR UPDATE
USING (id = public.current_account_id())
WITH CHECK (id = public.current_account_id());

DROP POLICY IF EXISTS persons_select_accessible ON public.persons;
CREATE POLICY persons_select_accessible ON public.persons
FOR SELECT
USING (
  account_id = public.current_account_id()
  OR created_by_account_id = public.current_account_id()
  OR EXISTS (
    SELECT 1
    FROM public.participants part
    WHERE part.person_id = persons.id
      AND part.deleted = false
      AND public.can_access_trip(part.trip_id)
  )
);

DROP POLICY IF EXISTS persons_insert_owner ON public.persons;
CREATE POLICY persons_insert_owner ON public.persons
FOR INSERT
WITH CHECK (
  created_by_account_id = public.current_account_id()
  OR account_id = public.current_account_id()
);

DROP POLICY IF EXISTS persons_update_owner ON public.persons;
CREATE POLICY persons_update_owner ON public.persons
FOR UPDATE
USING (
  account_id = public.current_account_id()
  OR created_by_account_id = public.current_account_id()
)
WITH CHECK (
  account_id = public.current_account_id()
  OR created_by_account_id = public.current_account_id()
);

DROP POLICY IF EXISTS persons_delete_owner ON public.persons;
CREATE POLICY persons_delete_owner ON public.persons
FOR DELETE
USING (
  account_id = public.current_account_id()
  OR created_by_account_id = public.current_account_id()
);

DROP POLICY IF EXISTS trips_select_accessible ON public.trips;
CREATE POLICY trips_select_accessible ON public.trips
FOR SELECT
USING (public.can_access_trip(id));

DROP POLICY IF EXISTS trips_insert_owner ON public.trips;
CREATE POLICY trips_insert_owner ON public.trips
FOR INSERT
WITH CHECK (owner_person_id IN (SELECT * FROM public.current_person_ids()));

DROP POLICY IF EXISTS trips_update_owner ON public.trips;
CREATE POLICY trips_update_owner ON public.trips
FOR UPDATE
USING (public.is_trip_owner(id))
WITH CHECK (public.is_trip_owner(id));

DROP POLICY IF EXISTS trips_delete_owner ON public.trips;
CREATE POLICY trips_delete_owner ON public.trips
FOR DELETE
USING (public.is_trip_owner(id));

DROP POLICY IF EXISTS participants_select_accessible ON public.participants;
CREATE POLICY participants_select_accessible ON public.participants
FOR SELECT
USING (public.can_access_trip(trip_id));

DROP POLICY IF EXISTS participants_insert_editors ON public.participants;
CREATE POLICY participants_insert_editors ON public.participants
FOR INSERT
WITH CHECK (public.can_edit_trip(trip_id));

DROP POLICY IF EXISTS participants_update_editors ON public.participants;
CREATE POLICY participants_update_editors ON public.participants
FOR UPDATE
USING (public.can_edit_trip(trip_id))
WITH CHECK (public.can_edit_trip(trip_id));

DROP POLICY IF EXISTS participants_delete_owner ON public.participants;
CREATE POLICY participants_delete_owner ON public.participants
FOR DELETE
USING (public.is_trip_owner(trip_id));

DROP POLICY IF EXISTS items_select_accessible ON public.items;
CREATE POLICY items_select_accessible ON public.items
FOR SELECT
USING (public.can_access_trip(trip_id));

DROP POLICY IF EXISTS items_insert_editors ON public.items;
CREATE POLICY items_insert_editors ON public.items
FOR INSERT
WITH CHECK (public.can_edit_trip(trip_id));

DROP POLICY IF EXISTS items_update_editors ON public.items;
CREATE POLICY items_update_editors ON public.items
FOR UPDATE
USING (public.can_edit_trip(trip_id))
WITH CHECK (public.can_edit_trip(trip_id));

DROP POLICY IF EXISTS items_delete_editors ON public.items;
CREATE POLICY items_delete_editors ON public.items
FOR DELETE
USING (public.can_edit_trip(trip_id));

DROP POLICY IF EXISTS containers_select_accessible ON public.pack_containers;
CREATE POLICY containers_select_accessible ON public.pack_containers
FOR SELECT
USING (public.can_access_trip(trip_id));

DROP POLICY IF EXISTS containers_insert_editors ON public.pack_containers;
CREATE POLICY containers_insert_editors ON public.pack_containers
FOR INSERT
WITH CHECK (public.can_edit_trip(trip_id));

DROP POLICY IF EXISTS containers_update_editors ON public.pack_containers;
CREATE POLICY containers_update_editors ON public.pack_containers
FOR UPDATE
USING (public.can_edit_trip(trip_id))
WITH CHECK (public.can_edit_trip(trip_id));

DROP POLICY IF EXISTS containers_delete_editors ON public.pack_containers;
CREATE POLICY containers_delete_editors ON public.pack_containers
FOR DELETE
USING (public.can_edit_trip(trip_id));

DROP POLICY IF EXISTS person_devices_select_owner ON public.person_devices;
CREATE POLICY person_devices_select_owner ON public.person_devices
FOR SELECT
USING (
  EXISTS (
    SELECT 1
    FROM public.persons p
    WHERE p.id = person_devices.person_id
      AND (
        p.account_id = public.current_account_id()
        OR p.created_by_account_id = public.current_account_id()
      )
  )
);

DROP POLICY IF EXISTS person_devices_write_owner ON public.person_devices;
CREATE POLICY person_devices_write_owner ON public.person_devices
FOR ALL
USING (
  EXISTS (
    SELECT 1
    FROM public.persons p
    WHERE p.id = person_devices.person_id
      AND (
        p.account_id = public.current_account_id()
        OR p.created_by_account_id = public.current_account_id()
      )
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.persons p
    WHERE p.id = person_devices.person_id
      AND (
        p.account_id = public.current_account_id()
        OR p.created_by_account_id = public.current_account_id()
      )
  )
);

DROP POLICY IF EXISTS person_claims_select_owner ON public.person_claims;
CREATE POLICY person_claims_select_owner ON public.person_claims
FOR SELECT
USING (
  EXISTS (
    SELECT 1
    FROM public.persons p
    WHERE p.id = person_claims.person_id
      AND (
        p.account_id = public.current_account_id()
        OR p.created_by_account_id = public.current_account_id()
      )
  )
);

DROP POLICY IF EXISTS person_claims_write_owner ON public.person_claims;
CREATE POLICY person_claims_write_owner ON public.person_claims
FOR ALL
USING (
  EXISTS (
    SELECT 1
    FROM public.persons p
    WHERE p.id = person_claims.person_id
      AND (
        p.account_id = public.current_account_id()
        OR p.created_by_account_id = public.current_account_id()
      )
  )
)
WITH CHECK (
  EXISTS (
    SELECT 1
    FROM public.persons p
    WHERE p.id = person_claims.person_id
      AND (
        p.account_id = public.current_account_id()
        OR p.created_by_account_id = public.current_account_id()
      )
  )
);
