-- Clock in/out support (open sessions + clock state)
-- Safe to run once via server/db/migrate.ts. Uses guards where possible.

-- Allow open sessions by making end_at nullable.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_attribute
    WHERE attrelid = 'public.time_entry_sessions'::regclass
      AND attname = 'end_at'
      AND attnotnull
  ) THEN
    ALTER TABLE public.time_entry_sessions
      ALTER COLUMN end_at DROP NOT NULL;
  END IF;
END $$;

-- Replace end-after-start constraint to allow NULL end_at.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'time_entry_sessions_end_after_start_chk'
  ) THEN
    ALTER TABLE public.time_entry_sessions
      DROP CONSTRAINT time_entry_sessions_end_after_start_chk;
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'time_entry_sessions_end_after_start_chk'
  ) THEN
    ALTER TABLE public.time_entry_sessions
      ADD CONSTRAINT time_entry_sessions_end_after_start_chk
      CHECK (end_at IS NULL OR end_at > start_at);
  END IF;
END $$;

-- Enforce at most one open session per day.
CREATE UNIQUE INDEX IF NOT EXISTS time_entry_sessions_one_open_per_day_uniq
  ON public.time_entry_sessions (entry_day_id)
  WHERE end_at IS NULL;

-- Track whether a tutor is currently clocked in for a given day.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'time_entry_days'
      AND column_name = 'clock_state'
  ) THEN
    ALTER TABLE public.time_entry_days
      ADD COLUMN clock_state SMALLINT;
  END IF;
END $$;

UPDATE public.time_entry_days
SET clock_state = 1
WHERE clock_state IS NULL;

ALTER TABLE public.time_entry_days
  ALTER COLUMN clock_state SET DEFAULT 1;

ALTER TABLE public.time_entry_days
  ALTER COLUMN clock_state SET NOT NULL;

