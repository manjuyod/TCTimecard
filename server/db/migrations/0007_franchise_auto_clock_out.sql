ALTER TABLE public.franchise_payroll_settings
  ADD COLUMN IF NOT EXISTS auto_clock_out_enabled BOOLEAN NOT NULL DEFAULT FALSE;
