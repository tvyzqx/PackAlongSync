ALTER TABLE public.items
ADD COLUMN IF NOT EXISTS quantity INTEGER NOT NULL DEFAULT 1;

UPDATE public.items
SET quantity = 1
WHERE quantity < 1;
