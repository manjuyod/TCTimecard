-- Ensure pay_period_type allows custom_semimonthly on existing databases.
-- Safe to run once via server/db/migrate.ts.

DO $$
DECLARE
  existing_constraint RECORD;
BEGIN
  IF to_regclass('public.franchise_payroll_settings') IS NULL THEN
    RETURN;
  END IF;

  -- Drop any existing CHECK constraint that references pay_period_type so we can recreate it uniformly.
  FOR existing_constraint IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'public.franchise_payroll_settings'::regclass
      AND contype = 'c'
      AND pg_get_constraintdef(oid) ILIKE '%pay_period_type%'
  LOOP
    EXECUTE format(
      'ALTER TABLE public.franchise_payroll_settings DROP CONSTRAINT %I',
      existing_constraint.conname
    );
  END LOOP;
END $$;

DO $$
BEGIN
  IF to_regclass('public.franchise_payroll_settings') IS NULL THEN
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conrelid = 'public.franchise_payroll_settings'::regclass
      AND conname = 'chk_pay_period_type'
  ) THEN
    ALTER TABLE public.franchise_payroll_settings
      ADD CONSTRAINT chk_pay_period_type
      CHECK (
        pay_period_type IN (
          'weekly',
          'biweekly',
          'semimonthly',
          'monthly',
          'custom_semimonthly'
        )
      );
  END IF;
END $$;
