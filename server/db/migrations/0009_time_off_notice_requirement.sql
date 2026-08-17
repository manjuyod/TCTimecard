ALTER TABLE public.franchise_payroll_settings
  ADD COLUMN IF NOT EXISTS time_off_notice_required BOOLEAN NOT NULL DEFAULT TRUE;
