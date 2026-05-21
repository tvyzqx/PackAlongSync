ALTER TABLE public.trips
ADD COLUMN IF NOT EXISTS join_token_expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_trips_join_token_expires_at
ON public.trips(join_token_expires_at);
