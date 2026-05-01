CREATE TABLE IF NOT EXISTS public.activity_events (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES public.trips(id) ON DELETE CASCADE,
  actor_person_id TEXT,
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  payload_json TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted BOOLEAN NOT NULL DEFAULT FALSE,
  dirty BOOLEAN NOT NULL DEFAULT TRUE,
  origin_instance TEXT,
  user_id TEXT,
  synced_at TIMESTAMPTZ,
  dirty_fields TEXT
);

CREATE INDEX IF NOT EXISTS idx_activity_trip_created
  ON public.activity_events(trip_id, created_at DESC);

ALTER TABLE public.activity_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their group activity"
  ON public.activity_events FOR SELECT
  USING (
    trip_id IN (
      SELECT t.id FROM public.trips t
      LEFT JOIN public.group_members gm ON gm.group_id = t.group_id
      WHERE t.owner_person_id = (SELECT id FROM public.persons WHERE user_id = auth.uid() LIMIT 1)
         OR gm.person_id = (SELECT id FROM public.persons WHERE user_id = auth.uid() LIMIT 1)
    )
  );

CREATE POLICY "Users can insert their group activity"
  ON public.activity_events FOR INSERT
  WITH CHECK (
    trip_id IN (
      SELECT t.id FROM public.trips t
      LEFT JOIN public.group_members gm ON gm.group_id = t.group_id
      WHERE t.owner_person_id = (SELECT id FROM public.persons WHERE user_id = auth.uid() LIMIT 1)
         OR gm.person_id = (SELECT id FROM public.persons WHERE user_id = auth.uid() LIMIT 1)
    )
  );

CREATE POLICY "Users can update their group activity"
  ON public.activity_events FOR UPDATE
  USING (
    trip_id IN (
      SELECT t.id FROM public.trips t
      LEFT JOIN public.group_members gm ON gm.group_id = t.group_id
      WHERE t.owner_person_id = (SELECT id FROM public.persons WHERE user_id = auth.uid() LIMIT 1)
         OR gm.person_id = (SELECT id FROM public.persons WHERE user_id = auth.uid() LIMIT 1)
    )
  );
