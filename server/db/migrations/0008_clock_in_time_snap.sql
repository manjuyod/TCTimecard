ALTER TABLE public.franchise_payroll_settings
  ADD COLUMN IF NOT EXISTS clock_in_time_snap_enabled BOOLEAN NOT NULL DEFAULT FALSE;
