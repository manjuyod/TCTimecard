-- Approved time-off changes: amendments, operation receipts, durable delivery
-- jobs, and guarded PTO reconciliation for approved requests.

-- ---------------------------------------------------------------------------
-- Request versioning and calendar identity
-- ---------------------------------------------------------------------------

ALTER TABLE public.time_off_requests
  ADD COLUMN IF NOT EXISTS version BIGINT NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS last_change_operation_id UUID,
  -- Existing approvals keep a NULL calendar id; the delivery worker adopts the
  -- franchise calendar only after verifying event ownership.
  ADD COLUMN IF NOT EXISTS google_calendar_id TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'time_off_requests_version_positive'
      AND conrelid = 'public.time_off_requests'::REGCLASS
  ) THEN
    ALTER TABLE public.time_off_requests
      ADD CONSTRAINT time_off_requests_version_positive CHECK (version > 0);
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Amendments: proposed replacements for an approved request
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.time_off_amendments (
  id BIGSERIAL PRIMARY KEY,
  request_id BIGINT NOT NULL REFERENCES public.time_off_requests(id),
  base_version BIGINT NOT NULL CHECK (base_version > 0),
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  start_at TIMESTAMPTZ NOT NULL,
  end_at TIMESTAMPTZ NOT NULL,
  partial_day BOOLEAN NOT NULL,
  leave_time TEXT CHECK (leave_time IS NULL OR leave_time ~ '^[0-9]{2}:[0-9]{2}$'),
  return_time TEXT CHECK (return_time IS NULL OR return_time ~ '^[0-9]{2}:[0-9]{2}$'),
  type TEXT NOT NULL CHECK (type IN ('pto', 'sick', 'emergency', 'unpaid', 'other')),
  storage_type TEXT NOT NULL CHECK (storage_type IN ('pto', 'sick', 'unpaid', 'other')),
  absence_label TEXT NOT NULL CHECK (BTRIM(absence_label) <> ''),
  reason TEXT NOT NULL CHECK (CHAR_LENGTH(BTRIM(reason)) BETWEEN 10 AND 2000),
  duration_hours NUMERIC NOT NULL CHECK (duration_hours > 0 AND duration_hours <= 336),
  timezone TEXT NOT NULL CHECK (BTRIM(timezone) <> ''),
  change_reason TEXT NOT NULL CHECK (CHAR_LENGTH(BTRIM(change_reason)) BETWEEN 10 AND 2000),
  proposed_by BIGINT NOT NULL CHECK (proposed_by > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'denied', 'withdrawn', 'superseded', 'expired')),
  decided_by_type TEXT CHECK (decided_by_type IN ('TUTOR', 'ADMIN', 'SYSTEM')),
  decided_by BIGINT CHECK (decided_by >= 0),
  decided_at TIMESTAMPTZ,
  decision_reason TEXT CHECK (decision_reason IS NULL OR CHAR_LENGTH(decision_reason) <= 2000),
  CONSTRAINT time_off_amendments_dates CHECK (end_date >= start_date AND end_at > start_at),
  CONSTRAINT time_off_amendments_decision_state CHECK (
    (status = 'pending' AND decided_at IS NULL AND decided_by_type IS NULL AND decided_by IS NULL)
    OR (status <> 'pending' AND decided_at IS NOT NULL AND decided_by_type IS NOT NULL AND decided_by IS NOT NULL)
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS time_off_amendments_one_pending_idx
  ON public.time_off_amendments (request_id)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS time_off_amendments_request_created_idx
  ON public.time_off_amendments (request_id, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS time_off_amendments_pending_created_idx
  ON public.time_off_amendments (created_at, id)
  WHERE status = 'pending';

CREATE OR REPLACE FUNCTION public.time_off_guard_amendment()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_decision_columns TEXT[] := ARRAY['status', 'decided_by_type', 'decided_by', 'decided_at', 'decision_reason'];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Time-off amendments are immutable history and cannot be deleted';
  END IF;
  IF OLD.status <> 'pending' THEN
    RAISE EXCEPTION 'Terminal time-off amendment % cannot be changed', OLD.id;
  END IF;
  IF (TO_JSONB(NEW) - v_decision_columns) IS DISTINCT FROM (TO_JSONB(OLD) - v_decision_columns) THEN
    RAISE EXCEPTION 'Proposed time-off amendment fields are frozen';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS time_off_amendments_guard ON public.time_off_amendments;
CREATE TRIGGER time_off_amendments_guard
BEFORE UPDATE OR DELETE ON public.time_off_amendments
FOR EACH ROW EXECUTE FUNCTION public.time_off_guard_amendment();

-- ---------------------------------------------------------------------------
-- Operations: immutable, actor-scoped idempotent receipts and history
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.time_off_change_operations (
  id UUID PRIMARY KEY,
  request_id BIGINT NOT NULL REFERENCES public.time_off_requests(id),
  actor_type TEXT NOT NULL CHECK (actor_type IN ('TUTOR', 'ADMIN', 'SYSTEM')),
  actor_id BIGINT NOT NULL,
  franchiseid INTEGER NOT NULL CHECK (franchiseid > 0),
  action TEXT NOT NULL CHECK (action IN (
    'propose', 'withdraw', 'approve_amendment', 'deny_amendment', 'admin_edit', 'cancel', 'expire'
  )),
  amendment_id BIGINT REFERENCES public.time_off_amendments(id),
  expected_version BIGINT NOT NULL CHECK (expected_version > 0),
  result_version BIGINT NOT NULL,
  idempotency_key TEXT NOT NULL CHECK (CHAR_LENGTH(idempotency_key) BETWEEN 1 AND 200),
  input_hash TEXT NOT NULL CHECK (BTRIM(input_hash) <> ''),
  before_snapshot JSONB NOT NULL,
  after_snapshot JSONB NOT NULL,
  -- Normalized camelCase effective fields for an edit; NULL for every other action.
  target JSONB,
  change_reason TEXT CHECK (change_reason IS NULL OR CHAR_LENGTH(change_reason) <= 2000),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  response JSONB NOT NULL,
  CONSTRAINT time_off_change_operations_actor CHECK (
    (actor_type = 'SYSTEM' AND actor_id = 0 AND action = 'expire')
    OR (actor_type <> 'SYSTEM' AND actor_id > 0 AND action <> 'expire')
  ),
  CONSTRAINT time_off_change_operations_result_version CHECK (result_version = expected_version + 1),
  CONSTRAINT time_off_change_operations_target CHECK (
    (action IN ('admin_edit', 'approve_amendment')) = (target IS NOT NULL)
  ),
  CONSTRAINT time_off_change_operations_scope_key UNIQUE (actor_type, actor_id, franchiseid, idempotency_key)
);

CREATE INDEX IF NOT EXISTS time_off_change_operations_request_idx
  ON public.time_off_change_operations (request_id, result_version);

CREATE OR REPLACE FUNCTION public.time_off_reject_operation_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'Time-off change operations are immutable';
END;
$$;

DROP TRIGGER IF EXISTS time_off_change_operations_immutable ON public.time_off_change_operations;
CREATE TRIGGER time_off_change_operations_immutable
BEFORE UPDATE OR DELETE ON public.time_off_change_operations
FOR EACH ROW EXECUTE FUNCTION public.time_off_reject_operation_mutation();

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'time_off_requests_last_change_operation_fk'
      AND conrelid = 'public.time_off_requests'::REGCLASS
  ) THEN
    ALTER TABLE public.time_off_requests
      ADD CONSTRAINT time_off_requests_last_change_operation_fk
      FOREIGN KEY (last_change_operation_id) REFERENCES public.time_off_change_operations(id);
  END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Deliveries: durable calendar/email jobs committed with the business change
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.time_off_change_deliveries (
  id UUID PRIMARY KEY,
  operation_id UUID NOT NULL REFERENCES public.time_off_change_operations(id),
  request_id BIGINT NOT NULL REFERENCES public.time_off_requests(id),
  channel TEXT NOT NULL CHECK (channel IN ('calendar', 'email')),
  kind TEXT NOT NULL CHECK (BTRIM(kind) <> ''),
  target_version BIGINT NOT NULL CHECK (target_version > 0),
  payload JSONB NOT NULL,
  recipient TEXT,
  -- Impersonation subject used for the provider call.
  identity TEXT,
  calendar_id TEXT,
  -- Deterministic replacement event id, assigned before any provider call.
  recovery_event_id TEXT,
  -- Event id verified or created by the worker for this target.
  adopted_event_id TEXT,
  dedupe_key TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'superseded')),
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at TIMESTAMPTZ,
  last_error TEXT CHECK (last_error IS NULL OR CHAR_LENGTH(last_error) <= 1000),
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT time_off_change_deliveries_dedupe_key UNIQUE (dedupe_key),
  CONSTRAINT time_off_change_deliveries_calendar_recovery CHECK (channel <> 'calendar' OR recovery_event_id IS NOT NULL),
  CONSTRAINT time_off_change_deliveries_email_recipient CHECK (channel <> 'email' OR BTRIM(COALESCE(recipient, '')) <> '')
);

CREATE INDEX IF NOT EXISTS time_off_change_deliveries_due_idx
  ON public.time_off_change_deliveries (next_attempt_at, created_at)
  WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS time_off_change_deliveries_request_idx
  ON public.time_off_change_deliveries (request_id, created_at DESC);
CREATE INDEX IF NOT EXISTS time_off_change_deliveries_failed_idx
  ON public.time_off_change_deliveries (request_id, updated_at DESC)
  WHERE status = 'failed';

CREATE OR REPLACE FUNCTION public.time_off_guard_delivery()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_mutable TEXT[] := ARRAY[
    'status', 'attempts', 'next_attempt_at', 'last_error', 'completed_at', 'updated_at',
    'adopted_event_id', 'calendar_id'
  ];
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Time-off change deliveries are immutable history and cannot be deleted';
  END IF;
  IF (TO_JSONB(NEW) - v_mutable) IS DISTINCT FROM (TO_JSONB(OLD) - v_mutable) THEN
    RAISE EXCEPTION 'Frozen time-off delivery fields cannot be changed';
  END IF;
  IF OLD.calendar_id IS NOT NULL AND NEW.calendar_id IS DISTINCT FROM OLD.calendar_id THEN
    RAISE EXCEPTION 'A delivery calendar identity cannot be reassigned';
  END IF;
  IF OLD.status IN ('sent', 'superseded') AND NEW.status IS DISTINCT FROM OLD.status THEN
    RAISE EXCEPTION 'Terminal time-off delivery % cannot be reopened', OLD.id;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS time_off_change_deliveries_guard ON public.time_off_change_deliveries;
CREATE TRIGGER time_off_change_deliveries_guard
BEFORE UPDATE OR DELETE ON public.time_off_change_deliveries
FOR EACH ROW EXECUTE FUNCTION public.time_off_guard_delivery();
