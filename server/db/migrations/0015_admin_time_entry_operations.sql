ALTER TABLE public.time_entry_audit ADD COLUMN IF NOT EXISTS operation_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS time_entry_audit_operation_id_uniq
  ON public.time_entry_audit (operation_id) WHERE operation_id IS NOT NULL;
