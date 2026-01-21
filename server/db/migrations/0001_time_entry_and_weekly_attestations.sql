-- Manual time entry + weekly attestations (Postgres-only)
-- Safe to run once via server/db/migrate.ts. Uses idempotent guards where possible.

CREATE TABLE IF NOT EXISTS public.time_entry_days (
  id SERIAL PRIMARY KEY,
  franchiseid INTEGER NOT NULL,
  tutorid INTEGER NOT NULL,
  work_date DATE NOT NULL,
  timezone TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  schedule_snapshot JSONB,
  comparison JSONB,
  submitted_at TIMESTAMPTZ,
  decided_by INTEGER,
  decided_at TIMESTAMPTZ,
  decision_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'time_entry_days_franchise_tutor_work_date_uniq'
  ) THEN
    ALTER TABLE public.time_entry_days
      ADD CONSTRAINT time_entry_days_franchise_tutor_work_date_uniq UNIQUE (franchiseid, tutorid, work_date);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS time_entry_days_franchise_tutor_work_date_idx
  ON public.time_entry_days (franchiseid, tutorid, work_date);
CREATE INDEX IF NOT EXISTS time_entry_days_status_idx
  ON public.time_entry_days (status);
CREATE INDEX IF NOT EXISTS time_entry_days_work_date_idx
  ON public.time_entry_days (work_date);

CREATE TABLE IF NOT EXISTS public.time_entry_sessions (
  id SERIAL PRIMARY KEY,
  entry_day_id INTEGER NOT NULL REFERENCES public.time_entry_days(id) ON DELETE CASCADE,
  franchiseid INTEGER NOT NULL,
  tutorid INTEGER NOT NULL,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'time_entry_sessions_end_after_start_chk'
  ) THEN
    ALTER TABLE public.time_entry_sessions
      ADD CONSTRAINT time_entry_sessions_end_after_start_chk CHECK (end_at > start_at);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS time_entry_sessions_entry_day_id_idx
  ON public.time_entry_sessions (entry_day_id);
CREATE INDEX IF NOT EXISTS time_entry_sessions_start_at_idx
  ON public.time_entry_sessions (start_at);
CREATE INDEX IF NOT EXISTS time_entry_sessions_franchise_tutor_start_at_idx
  ON public.time_entry_sessions (franchiseid, tutorid, start_at);

CREATE TABLE IF NOT EXISTS public.time_entry_audit (
  id SERIAL PRIMARY KEY,
  entry_day_id INTEGER NOT NULL REFERENCES public.time_entry_days(id) ON DELETE CASCADE,
  action TEXT NOT NULL,
  actor_account_type TEXT NOT NULL,
  actor_account_id INTEGER,
  at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  previous_status TEXT,
  new_status TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS time_entry_audit_entry_day_id_idx
  ON public.time_entry_audit (entry_day_id);
CREATE INDEX IF NOT EXISTS time_entry_audit_at_idx
  ON public.time_entry_audit (at);

CREATE TABLE IF NOT EXISTS public.weekly_attestations (
  id SERIAL PRIMARY KEY,
  franchiseid INTEGER NOT NULL,
  tutorid INTEGER NOT NULL,
  week_start DATE NOT NULL,
  week_end DATE NOT NULL,
  timezone TEXT NOT NULL,
  typed_name TEXT NOT NULL,
  signed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  attestation_text TEXT NOT NULL,
  attestation_text_version TEXT NOT NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'weekly_attestations_franchise_tutor_week_end_uniq'
  ) THEN
    ALTER TABLE public.weekly_attestations
      ADD CONSTRAINT weekly_attestations_franchise_tutor_week_end_uniq UNIQUE (franchiseid, tutorid, week_end);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS weekly_attestations_franchise_tutor_week_end_idx
  ON public.weekly_attestations (franchiseid, tutorid, week_end);
