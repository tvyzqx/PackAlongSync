CREATE INDEX IF NOT EXISTS idx_persons_account_id
ON public.persons(account_id);

CREATE INDEX IF NOT EXISTS idx_persons_created_by_account_id
ON public.persons(created_by_account_id);

CREATE INDEX IF NOT EXISTS idx_persons_updated_at
ON public.persons(updated_at);

CREATE INDEX IF NOT EXISTS idx_trips_owner_person_id
ON public.trips(owner_person_id);

CREATE INDEX IF NOT EXISTS idx_trips_updated_at
ON public.trips(updated_at);

CREATE INDEX IF NOT EXISTS idx_trips_join_token
ON public.trips(join_token);

CREATE INDEX IF NOT EXISTS idx_pack_containers_trip_id
ON public.pack_containers(trip_id);

CREATE INDEX IF NOT EXISTS idx_pack_containers_updated_at
ON public.pack_containers(updated_at);

CREATE INDEX IF NOT EXISTS idx_items_trip_id
ON public.items(trip_id);

CREATE INDEX IF NOT EXISTS idx_items_container_id
ON public.items(container_id);

CREATE INDEX IF NOT EXISTS idx_items_assigned_to_person_id
ON public.items(assigned_to_person_id);

CREATE INDEX IF NOT EXISTS idx_items_updated_at
ON public.items(updated_at);

CREATE INDEX IF NOT EXISTS idx_participants_trip_id
ON public.participants(trip_id);

CREATE INDEX IF NOT EXISTS idx_participants_person_id
ON public.participants(person_id);

CREATE INDEX IF NOT EXISTS idx_participants_updated_at
ON public.participants(updated_at);

CREATE INDEX IF NOT EXISTS idx_person_devices_person_id
ON public.person_devices(person_id);

CREATE INDEX IF NOT EXISTS idx_person_devices_access_token
ON public.person_devices(access_token);

CREATE INDEX IF NOT EXISTS idx_person_claims_person_id
ON public.person_claims(person_id);

CREATE INDEX IF NOT EXISTS idx_person_claims_claim_token
ON public.person_claims(claim_token);
