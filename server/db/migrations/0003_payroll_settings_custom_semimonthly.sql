-- Payroll settings tables + recurring custom semimonthly support.
-- Safe to run once via server/db/migrate.ts. Uses guards where possible.

CREATE TABLE IF NOT EXISTS public.franchise_payroll_settings (
  franchiseid INTEGER PRIMARY KEY,
  policytype TEXT NOT NULL DEFAULT 'strict_approval',
  timezone TEXT NOT NULL DEFAULT 'America/Los_Angeles',
  pay_period_type TEXT NOT NULL DEFAULT 'biweekly',
  auto_email_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  createdat TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updatedat TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.franchise_pay_period_overrides (
  id SERIAL PRIMARY KEY,
  franchiseid INTEGER NOT NULL,
  periodstart DATE NOT NULL,
  periodend DATE NOT NULL,
  reason TEXT,
  createdat TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS franchise_pay_period_overrides_franchiseid_idx
  ON public.franchise_pay_period_overrides (franchiseid);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'franchise_payroll_settings'
      AND column_name = 'custom_period_1_start_day'
  ) THEN
    ALTER TABLE public.franchise_payroll_settings
      ADD COLUMN custom_period_1_start_day INTEGER;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'franchise_payroll_settings'
      AND column_name = 'custom_period_1_end_day'
  ) THEN
    ALTER TABLE public.franchise_payroll_settings
      ADD COLUMN custom_period_1_end_day INTEGER;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'franchise_payroll_settings'
      AND column_name = 'custom_period_2_start_day'
  ) THEN
    ALTER TABLE public.franchise_payroll_settings
      ADD COLUMN custom_period_2_start_day INTEGER;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'franchise_payroll_settings'
      AND column_name = 'custom_period_2_end_day'
  ) THEN
    ALTER TABLE public.franchise_payroll_settings
      ADD COLUMN custom_period_2_end_day INTEGER;
  END IF;
END $$;
