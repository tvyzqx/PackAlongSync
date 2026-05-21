CREATE TABLE IF NOT EXISTS public.tags (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  emoji TEXT,
  is_system BOOLEAN NOT NULL DEFAULT false,
  owner_account_id TEXT,
  origin_instance TEXT,
  user_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  synced_at TIMESTAMPTZ,
  dirty BOOLEAN NOT NULL DEFAULT false,
  dirty_fields TEXT,
  deleted BOOLEAN NOT NULL DEFAULT false
);

ALTER TABLE public.items
ADD COLUMN IF NOT EXISTS tag_id TEXT REFERENCES public.tags(id) ON DELETE SET NULL;

DROP TRIGGER IF EXISTS trg_tags_updated_at ON public.tags;
CREATE TRIGGER trg_tags_updated_at
BEFORE UPDATE ON public.tags
FOR EACH ROW
EXECUTE FUNCTION public.update_updated_at();

ALTER TABLE public.tags ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tags_select_accessible ON public.tags;
CREATE POLICY tags_select_accessible ON public.tags
FOR SELECT
USING (
  is_system = true
  OR owner_account_id = public.current_account_id()
);

DROP POLICY IF EXISTS tags_insert_owner ON public.tags;
CREATE POLICY tags_insert_owner ON public.tags
FOR INSERT
WITH CHECK (
  is_system = false
  AND owner_account_id = public.current_account_id()
);

DROP POLICY IF EXISTS tags_update_owner ON public.tags;
CREATE POLICY tags_update_owner ON public.tags
FOR UPDATE
USING (owner_account_id = public.current_account_id() AND is_system = false)
WITH CHECK (owner_account_id = public.current_account_id() AND is_system = false);

DROP POLICY IF EXISTS tags_delete_owner ON public.tags;
CREATE POLICY tags_delete_owner ON public.tags
FOR DELETE
USING (owner_account_id = public.current_account_id() AND is_system = false);

CREATE INDEX IF NOT EXISTS idx_tags_owner_account_id
ON public.tags(owner_account_id);

CREATE INDEX IF NOT EXISTS idx_tags_updated_at
ON public.tags(updated_at);

CREATE INDEX IF NOT EXISTS idx_tags_is_system
ON public.tags(is_system);

CREATE INDEX IF NOT EXISTS idx_items_tag_id
ON public.items(tag_id);
