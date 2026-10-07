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
  CONSTRAINT time_off_change_deliveries_email_recipient CHECK (
    channel <> 'email' OR BTRIM(COALESCE(recipient, '')) <> '' OR status = 'failed'
  )
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

-- ---------------------------------------------------------------------------
-- Lock ordering for every PTO balance writer:
--   request row (where applicable) -> PTO policy advisory lock ->
--   canonical-profile advisory locks (ascending) -> profile rows (ascending) ->
--   allocation rows (cycle order).
-- Aliases change only while the policy lock is held, so canonical ids computed
-- after acquiring it are stable for the rest of the transaction.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.pto_lock_balance_scope(p_profile_ids BIGINT[])
RETURNS BIGINT[]
LANGUAGE plpgsql
AS $$
DECLARE
  v_ids BIGINT[];
  v_id BIGINT;
BEGIN
  PERFORM PG_ADVISORY_XACT_LOCK(HASHTEXTEXTENDED('pto-policy-version', 0));
  SELECT COALESCE(ARRAY_AGG(DISTINCT canonical_ids.canonical_id ORDER BY canonical_ids.canonical_id), ARRAY[]::BIGINT[])
  INTO v_ids
  FROM (
    SELECT public.pto_canonical_profile_id(ids.profile_id) AS canonical_id
    FROM UNNEST(COALESCE(p_profile_ids, ARRAY[]::BIGINT[])) AS ids(profile_id)
    WHERE ids.profile_id IS NOT NULL
  ) canonical_ids;
  FOREACH v_id IN ARRAY v_ids LOOP
    PERFORM PG_ADVISORY_XACT_LOCK(HASHTEXTEXTENDED('pto-profile:' || v_id, 0));
  END LOOP;
  PERFORM 1 FROM public.pto_profiles WHERE id = ANY(v_ids) ORDER BY id FOR UPDATE;
  RETURN v_ids;
END;
$$;

CREATE OR REPLACE FUNCTION public.pto_reserve_request(
  p_request_id BIGINT,
  p_franchiseid INTEGER,
  p_tutorid BIGINT,
  p_bridge_profile_id BIGINT,
  p_email TEXT,
  p_request_source TEXT,
  p_first_name TEXT,
  p_last_name TEXT,
  p_created_at TIMESTAMPTZ,
  p_start_date DATE,
  p_end_date DATE,
  p_partial_day BOOLEAN,
  p_duration_hours NUMERIC
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_center public.pto_center_settings%ROWTYPE;
  v_profile_id BIGINT;
  v_cycle_id BIGINT;
  v_day RECORD;
  v_allocation RECORD;
  v_available NUMERIC;
BEGIN
  IF p_request_source = 'public' THEN
    SELECT * INTO v_center
    FROM public.pto_center_settings
    WHERE franchiseid = p_franchiseid;
    IF NOT FOUND OR NOT v_center.enabled OR v_center.first_activated_at IS NULL
      OR p_created_at < v_center.first_activated_at THEN
      RETURN;
    END IF;
  ELSIF p_request_source = 'authenticated' THEN
    v_profile_id := public.pto_authenticated_linked_profile(p_franchiseid, p_tutorid);
    IF v_profile_id IS NULL THEN
      RAISE EXCEPTION 'Authenticated PTO identity requires an active CRM membership';
    END IF;
    PERFORM 1
    FROM public.pto_profile_centers sponsor
    JOIN public.pto_center_settings settings
      ON settings.franchiseid = sponsor.franchiseid
     AND settings.enabled
     AND settings.first_activated_at IS NOT NULL
     AND p_created_at >= settings.first_activated_at
    WHERE sponsor.active
      AND public.pto_canonical_profile_id(sponsor.profile_id) = v_profile_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'Authenticated PTO profile requires an active enabled membership';
    END IF;
  ELSE
    RAISE EXCEPTION 'Unsupported PTO request source %', p_request_source;
  END IF;

  PERFORM 1 FROM public.time_off_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PTO request % does not exist', p_request_id; END IF;
  IF EXISTS (SELECT 1 FROM public.pto_request_allocations WHERE request_id = p_request_id) THEN RETURN; END IF;

  IF p_request_source = 'public' THEN
    v_profile_id := public.pto_resolve_profile(
      p_franchiseid, p_tutorid, p_bridge_profile_id, p_email, p_request_source,
      p_first_name, p_last_name
    );
  END IF;
  v_profile_id := (public.pto_lock_balance_scope(ARRAY[v_profile_id]))[1];

  FOR v_day IN
    SELECT leave_date, charged_days
    FROM public.pto_request_day_charges(
      p_start_date, p_end_date, p_partial_day, p_duration_hours
    ) WHERE charged_days > 0
  LOOP
    v_cycle_id := public.pto_get_or_create_cycle(v_profile_id, v_day.leave_date);
    INSERT INTO public.pto_request_allocations (request_id, cycle_id, charged_days, state)
    VALUES (p_request_id, v_cycle_id, v_day.charged_days, 'reserved')
    ON CONFLICT (request_id, cycle_id) DO UPDATE SET
      charged_days = public.pto_request_allocations.charged_days + EXCLUDED.charged_days,
      updated_at = NOW();
  END LOOP;

  FOR v_allocation IN
    SELECT allocation.*, cycle.profile_id, cycle.starts_on
    FROM public.pto_request_allocations AS allocation
    JOIN public.pto_entitlement_cycles AS cycle ON cycle.id = allocation.cycle_id
    WHERE allocation.request_id = p_request_id ORDER BY allocation.cycle_id
  LOOP
    SELECT available_days INTO v_available
    FROM public.pto_profile_balance(v_profile_id, v_allocation.starts_on);
    IF v_available < v_allocation.charged_days THEN
      RAISE EXCEPTION 'Insufficient shared PTO balance for cycle %', v_allocation.cycle_id;
    END IF;
    INSERT INTO public.pto_ledger_entries (
      profile_id, cycle_id, request_id, allocation_id, event_type,
      balance_delta, reserved_delta, idempotency_key
    ) VALUES (
      v_profile_id, v_allocation.cycle_id, p_request_id, v_allocation.id, 'reserve',
      0, v_allocation.charged_days,
      'reserve:' || p_request_id || ':' || v_allocation.cycle_id
    ) ON CONFLICT (idempotency_key) DO NOTHING;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.pto_transition_request(
  p_request_id BIGINT,
  p_new_status TEXT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_allocation RECORD;
  v_profile_ids BIGINT[];
BEGIN
  IF p_new_status NOT IN ('approved', 'denied', 'cancelled') THEN
    RETURN;
  END IF;

  SELECT ARRAY_AGG(cycle.profile_id)
  INTO v_profile_ids
  FROM public.pto_request_allocations AS allocation
  JOIN public.pto_entitlement_cycles AS cycle ON cycle.id = allocation.cycle_id
  WHERE allocation.request_id = p_request_id;
  IF v_profile_ids IS NULL THEN
    RETURN;
  END IF;
  -- Policy and profile locks precede allocation row locks (no inversion).
  PERFORM public.pto_lock_balance_scope(v_profile_ids);

  FOR v_allocation IN
    SELECT allocation.*, cycle.profile_id
    FROM public.pto_request_allocations AS allocation
    JOIN public.pto_entitlement_cycles AS cycle ON cycle.id = allocation.cycle_id
    WHERE allocation.request_id = p_request_id
    ORDER BY allocation.cycle_id
    FOR UPDATE OF allocation
  LOOP
    IF p_new_status = 'approved' AND v_allocation.state = 'reserved' THEN
      INSERT INTO public.pto_ledger_entries (
        profile_id, cycle_id, request_id, allocation_id, event_type,
        balance_delta, reserved_delta, idempotency_key
      )
      VALUES (
        v_allocation.profile_id, v_allocation.cycle_id, p_request_id, v_allocation.id, 'consume',
        -v_allocation.charged_days, -v_allocation.charged_days,
        'consume:' || p_request_id || ':' || v_allocation.cycle_id
      )
      ON CONFLICT (idempotency_key) DO NOTHING;

      UPDATE public.pto_request_allocations
      SET state = 'consumed', updated_at = NOW()
      WHERE id = v_allocation.id;
    ELSIF p_new_status IN ('denied', 'cancelled')
      AND v_allocation.state IN ('reserved', 'consumed') THEN
      INSERT INTO public.pto_ledger_entries (
        profile_id, cycle_id, request_id, allocation_id, event_type,
        balance_delta, reserved_delta, idempotency_key
      )
      VALUES (
        v_allocation.profile_id, v_allocation.cycle_id, p_request_id, v_allocation.id, 'release',
        CASE WHEN v_allocation.state = 'consumed' THEN v_allocation.charged_days ELSE 0 END,
        CASE WHEN v_allocation.state = 'reserved' THEN -v_allocation.charged_days ELSE 0 END,
        'release:' || p_request_id || ':' || v_allocation.cycle_id
      )
      ON CONFLICT (idempotency_key) DO NOTHING;

      UPDATE public.pto_request_allocations
      SET state = 'released', updated_at = NOW()
      WHERE id = v_allocation.id;
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.pto_handle_time_off_request()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_start_date DATE;
  v_end_date DATE;
BEGIN
  IF NEW.type::TEXT <> 'pto' THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' AND NEW.status = 'pending' THEN
    v_start_date := COALESCE(
      NULLIF(NEW.public_metadata ->> 'startDate', '')::DATE,
      (NEW.start_at AT TIME ZONE 'UTC')::DATE
    );
    v_end_date := COALESCE(
      NULLIF(NEW.public_metadata ->> 'endDate', '')::DATE,
      CASE
        WHEN COALESCE(NEW.partial_day, FALSE)
          THEN (NEW.end_at AT TIME ZONE 'UTC')::DATE
        ELSE (NEW.end_at AT TIME ZONE 'UTC')::DATE - 1
      END
    );

    PERFORM public.pto_reserve_request(
      NEW.id,
      NEW.franchiseid,
      NEW.tutorid,
      NEW.bridge_profile_id,
      NEW.email,
      CASE
        WHEN NEW.public_metadata ->> 'source' = 'public_timeoff_form' THEN 'public'
        ELSE 'authenticated'
      END,
      NEW.first_name,
      NEW.last_name,
      NEW.created_at,
      v_start_date,
      v_end_date,
      COALESCE(NEW.partial_day, FALSE),
      NEW.duration_hours
    );
  ELSIF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status
    -- Approved-change operations reconcile through their own trigger; the
    -- legacy status refund must never also run for the same change.
    AND NEW.last_change_operation_id IS NOT DISTINCT FROM OLD.last_change_operation_id THEN
    PERFORM public.pto_transition_request(NEW.id, NEW.status);
  END IF;

  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.pto_admin_decide_alias(
  p_candidate_id BIGINT,
  p_decision TEXT,
  p_actor_id TEXT,
  p_actor_franchiseid INTEGER
)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  v_candidate public.pto_profile_match_candidates%ROWTYPE;
  v_target_id BIGINT;
  v_source_id BIGINT;
  v_before_state JSONB;
  v_left_id BIGINT;
  v_right_id BIGINT;
BEGIN
  IF p_decision NOT IN ('confirm', 'reject') THEN
    RAISE EXCEPTION 'Unsupported PTO alias decision %', p_decision;
  END IF;
  PERFORM PG_ADVISORY_XACT_LOCK(HASHTEXTEXTENDED('pto-policy-version', 0));
  SELECT left_profile_id, right_profile_id INTO v_left_id, v_right_id
  FROM public.pto_profile_match_candidates WHERE id = p_candidate_id;
  IF FOUND THEN
    PERFORM public.pto_lock_balance_scope(ARRAY[v_left_id, v_right_id]);
  END IF;
  SELECT * INTO v_candidate FROM public.pto_profile_match_candidates
  WHERE id = p_candidate_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PTO alias candidate % does not exist', p_candidate_id; END IF;

  v_target_id := v_candidate.left_profile_id;
  v_source_id := v_candidate.right_profile_id;
  v_target_id := public.pto_canonical_profile_id(v_target_id);
  v_source_id := public.pto_canonical_profile_id(v_source_id);
  IF NOT EXISTS (
    SELECT 1 FROM public.pto_profile_centers
    WHERE public.pto_canonical_profile_id(profile_id) IN (v_target_id, v_source_id)
      AND franchiseid = p_actor_franchiseid AND active
  ) THEN
    RAISE EXCEPTION 'Actor center is not authorized for PTO alias candidate %', p_candidate_id;
  END IF;
  v_before_state := JSONB_BUILD_OBJECT(
    'candidate', TO_JSONB(v_candidate),
    'targetProfile', (SELECT TO_JSONB(profile) FROM public.pto_profiles profile WHERE id = v_target_id),
    'sourceProfile', (SELECT TO_JSONB(profile) FROM public.pto_profiles profile WHERE id = v_source_id)
  );

  IF v_candidate.status <> 'pending' THEN
    IF (v_candidate.status = 'confirmed' AND p_decision <> 'confirm')
      OR (v_candidate.status = 'rejected' AND p_decision <> 'reject') THEN
      RAISE EXCEPTION 'PTO alias candidate % is already %', p_candidate_id, v_candidate.status;
    END IF;
    RETURN COALESCE(
      (SELECT target_profile_id FROM public.pto_profile_aliases WHERE candidate_id = p_candidate_id),
      v_target_id
    );
  END IF;

  IF p_decision = 'reject' THEN
    UPDATE public.pto_profile_match_candidates
    SET status = 'rejected', decided_by = p_actor_id, decided_at = NOW()
    WHERE id = p_candidate_id;
    INSERT INTO public.pto_audit_events
      (profile_id, franchiseid, actor_id, event_type, before_state, after_state, idempotency_key)
    VALUES (v_target_id, p_actor_franchiseid, p_actor_id, 'alias_rejected', v_before_state,
      JSONB_BUILD_OBJECT(
        'candidate', (SELECT TO_JSONB(candidate) FROM public.pto_profile_match_candidates candidate
          WHERE id = p_candidate_id),
        'targetProfile', (SELECT TO_JSONB(profile) FROM public.pto_profiles profile WHERE id = v_target_id),
        'sourceProfile', (SELECT TO_JSONB(profile) FROM public.pto_profiles profile WHERE id = v_source_id)
      ),
      'alias-reject:' || p_candidate_id)
    ON CONFLICT (idempotency_key) DO NOTHING;
    RETURN v_target_id;
  END IF;

  IF v_target_id = v_source_id THEN
    UPDATE public.pto_profile_match_candidates
    SET status = 'confirmed', decided_by = p_actor_id, decided_at = NOW()
    WHERE id = p_candidate_id;
    INSERT INTO public.pto_audit_events
      (profile_id, franchiseid, actor_id, event_type, before_state, after_state, idempotency_key)
    VALUES (v_target_id, p_actor_franchiseid, p_actor_id, 'alias_confirmed', v_before_state,
      JSONB_BUILD_OBJECT(
        'candidate', (SELECT TO_JSONB(candidate) FROM public.pto_profile_match_candidates candidate
          WHERE id = p_candidate_id),
        'canonicalProfileId', v_target_id,
        'alreadyCanonical', TRUE
      ),
      'alias-confirm:' || p_candidate_id)
    ON CONFLICT (idempotency_key) DO NOTHING;
    RETURN v_target_id;
  END IF;

  INSERT INTO public.pto_profile_aliases (source_profile_id, target_profile_id, candidate_id)
  VALUES (v_source_id, v_target_id, p_candidate_id)
  ON CONFLICT (candidate_id) DO NOTHING;
  UPDATE public.pto_profiles SET active = FALSE WHERE id = v_source_id;
  UPDATE public.pto_profile_match_candidates
  SET status = 'confirmed', decided_by = p_actor_id, decided_at = NOW()
  WHERE id = p_candidate_id;
  INSERT INTO public.pto_audit_events
    (profile_id, franchiseid, actor_id, event_type, before_state, after_state, idempotency_key)
  VALUES (v_target_id, p_actor_franchiseid, p_actor_id, 'alias_confirmed', v_before_state,
    JSONB_BUILD_OBJECT(
      'candidate', (SELECT TO_JSONB(candidate) FROM public.pto_profile_match_candidates candidate
        WHERE id = p_candidate_id),
      'targetProfile', (SELECT TO_JSONB(profile) FROM public.pto_profiles profile WHERE id = v_target_id),
      'sourceProfile', (SELECT TO_JSONB(profile) FROM public.pto_profiles profile WHERE id = v_source_id),
      'canonicalProfileId', v_target_id
    ),
    'alias-confirm:' || p_candidate_id)
  ON CONFLICT (idempotency_key) DO NOTHING;
  RETURN v_target_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.pto_admin_detach_membership(
  p_profile_id BIGINT,
  p_membership_id BIGINT,
  p_actor_id TEXT,
  p_actor_franchiseid INTEGER
)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  v_membership public.pto_profile_centers%ROWTYPE;
  v_profile public.pto_profiles%ROWTYPE;
  v_new_profile_id BIGINT;
  v_allocation RECORD;
  v_new_cycle_id BIGINT;
  v_canonical_profile_id BIGINT;
  v_before_state JSONB;
  v_after_state JSONB;
BEGIN
  PERFORM public.pto_lock_balance_scope(ARRAY[p_profile_id]);
  SELECT * INTO v_membership FROM public.pto_profile_centers
  WHERE id = p_membership_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PTO membership % does not exist', p_membership_id; END IF;

  v_canonical_profile_id := public.pto_canonical_profile_id(p_profile_id);

  IF public.pto_canonical_profile_id(v_membership.profile_id) <> v_canonical_profile_id THEN
    SELECT (after_state ->> 'detachedProfileId')::BIGINT INTO v_new_profile_id
    FROM public.pto_audit_events
    WHERE idempotency_key = 'membership-detach:' || p_membership_id;
    IF v_new_profile_id IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.pto_profile_centers
        WHERE public.pto_canonical_profile_id(profile_id)
            IN (v_canonical_profile_id, v_new_profile_id)
          AND franchiseid = p_actor_franchiseid
          AND active
      ) THEN
        RAISE EXCEPTION 'Actor center is not authorized for PTO membership %', p_membership_id;
      END IF;
      RETURN v_new_profile_id;
    END IF;
    RAISE EXCEPTION 'PTO membership does not belong to profile %', p_profile_id;
  END IF;
  PERFORM public.pto_assert_profile_admin(v_canonical_profile_id, p_actor_franchiseid);
  SELECT * INTO v_profile FROM public.pto_profiles WHERE id = v_canonical_profile_id FOR UPDATE;
  v_before_state := JSONB_BUILD_OBJECT(
    'membership', TO_JSONB(v_membership),
    'profile', TO_JSONB(v_profile),
    'emails', COALESCE((SELECT JSONB_AGG(TO_JSONB(email) ORDER BY email.id)
      FROM public.pto_profile_emails email WHERE email.source_membership_id = p_membership_id), '[]'::JSONB),
    'allocationIds', COALESCE((SELECT JSONB_AGG(allocation.id ORDER BY allocation.id)
      FROM public.pto_request_allocations allocation
      JOIN public.pto_entitlement_cycles cycle ON cycle.id = allocation.cycle_id
      JOIN public.time_off_requests request ON request.id = allocation.request_id
      WHERE public.pto_canonical_profile_id(cycle.profile_id) = v_canonical_profile_id
        AND request.franchiseid = v_membership.franchiseid), '[]'::JSONB)
  );

  INSERT INTO public.pto_profiles (first_name, last_name, identity_status, active)
  VALUES (v_profile.first_name, v_profile.last_name, 'confirmed', TRUE)
  RETURNING id INTO v_new_profile_id;
  UPDATE public.pto_profile_centers SET profile_id = v_new_profile_id, updated_at = NOW()
  WHERE id = p_membership_id;
  UPDATE public.pto_profile_emails SET profile_id = v_new_profile_id, updated_at = NOW()
  WHERE source_membership_id = p_membership_id;
  UPDATE public.pto_profile_crm_ids SET profile_id = v_new_profile_id
  WHERE public.pto_canonical_profile_id(profile_id) = v_canonical_profile_id
    AND provider = 'timecard-center:' || v_membership.franchiseid
    AND crm_id = v_membership.tutor_id::TEXT;

  FOR v_allocation IN
    SELECT allocation.*, cycle.starts_on, cycle.profile_id
    FROM public.pto_request_allocations allocation
    JOIN public.pto_entitlement_cycles cycle ON cycle.id = allocation.cycle_id
    JOIN public.time_off_requests request ON request.id = allocation.request_id
    WHERE public.pto_canonical_profile_id(cycle.profile_id) = v_canonical_profile_id
      AND request.franchiseid = v_membership.franchiseid
    ORDER BY allocation.id
    FOR UPDATE OF allocation
  LOOP
    v_new_cycle_id := public.pto_get_or_create_cycle(v_new_profile_id, v_allocation.starts_on);
    IF v_allocation.state = 'reserved' THEN
      INSERT INTO public.pto_ledger_entries
        (profile_id, cycle_id, request_id, allocation_id, event_type, reserved_delta, idempotency_key, metadata)
      VALUES (v_allocation.profile_id, v_allocation.cycle_id, v_allocation.request_id, v_allocation.id,
        'release', -v_allocation.charged_days, 'split-release:' || p_membership_id || ':' || v_allocation.id,
        JSONB_BUILD_OBJECT('detachedProfileId', v_new_profile_id));
    ELSIF v_allocation.state = 'consumed' THEN
      INSERT INTO public.pto_ledger_entries
        (profile_id, cycle_id, request_id, allocation_id, event_type, balance_delta, idempotency_key, metadata)
      VALUES (v_allocation.profile_id, v_allocation.cycle_id, v_allocation.request_id, v_allocation.id,
        'adjustment', v_allocation.charged_days, 'split-reverse:' || p_membership_id || ':' || v_allocation.id,
        JSONB_BUILD_OBJECT('reason', 'Detached center allocation', 'detachedProfileId', v_new_profile_id));
    END IF;
    UPDATE public.pto_request_allocations SET cycle_id = v_new_cycle_id, updated_at = NOW()
    WHERE id = v_allocation.id;
    IF v_allocation.state = 'reserved' THEN
      INSERT INTO public.pto_ledger_entries
        (profile_id, cycle_id, request_id, allocation_id, event_type, reserved_delta, idempotency_key, metadata)
      VALUES (v_new_profile_id, v_new_cycle_id, v_allocation.request_id, v_allocation.id,
        'reserve', v_allocation.charged_days, 'split-reserve:' || p_membership_id || ':' || v_allocation.id,
        JSONB_BUILD_OBJECT('sourceProfileId', v_allocation.profile_id));
    ELSIF v_allocation.state = 'consumed' THEN
      INSERT INTO public.pto_ledger_entries
        (profile_id, cycle_id, request_id, allocation_id, event_type, balance_delta, idempotency_key, metadata)
      VALUES (v_new_profile_id, v_new_cycle_id, v_allocation.request_id, v_allocation.id,
        'consume', -v_allocation.charged_days, 'split-consume:' || p_membership_id || ':' || v_allocation.id,
        JSONB_BUILD_OBJECT('sourceProfileId', v_allocation.profile_id));
    END IF;
  END LOOP;

  PERFORM public.pto_get_or_create_cycle(v_new_profile_id, CURRENT_DATE);
  v_after_state := JSONB_BUILD_OBJECT(
    'membership', (SELECT TO_JSONB(center) FROM public.pto_profile_centers center WHERE id = p_membership_id),
    'detachedProfile', (SELECT TO_JSONB(profile) FROM public.pto_profiles profile WHERE id = v_new_profile_id),
    'emails', COALESCE((SELECT JSONB_AGG(TO_JSONB(email) ORDER BY email.id)
      FROM public.pto_profile_emails email WHERE email.source_membership_id = p_membership_id), '[]'::JSONB),
    'allocationIds', COALESCE((SELECT JSONB_AGG(allocation.id ORDER BY allocation.id)
      FROM public.pto_request_allocations allocation
      JOIN public.pto_entitlement_cycles cycle ON cycle.id = allocation.cycle_id
      JOIN public.time_off_requests request ON request.id = allocation.request_id
      WHERE cycle.profile_id = v_new_profile_id
        AND request.franchiseid = v_membership.franchiseid), '[]'::JSONB),
    'detachedProfileId', v_new_profile_id
  );
  INSERT INTO public.pto_audit_events
    (profile_id, franchiseid, actor_id, event_type, before_state, after_state, idempotency_key)
  VALUES (v_canonical_profile_id, v_membership.franchiseid, p_actor_id, 'membership_detached',
    v_before_state, v_after_state,
    'membership-detach:' || p_membership_id);
  RETURN v_new_profile_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.pto_admin_link_account(
  p_profile_id BIGINT,
  p_account_id BIGINT,
  p_actor_id TEXT,
  p_actor_franchiseid INTEGER,
  p_expected_version INTEGER,
  p_idempotency_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_profile_id BIGINT := public.pto_canonical_profile_id(p_profile_id);
  v_source_profile_id BIGINT;
  v_linked_profile_id BIGINT;
  v_result JSONB;
  v_account public.pto_discovered_tutor_accounts%ROWTYPE;
  v_decision public.pto_profile_link_decisions%ROWTYPE;
  v_candidate_id BIGINT;
  v_decision_version INTEGER;
  v_before_state JSONB;
  v_existing_actor_id TEXT;
  v_existing_franchiseid INTEGER;
BEGIN
  IF NULLIF(BTRIM(p_idempotency_key), '') IS NULL THEN
    RAISE EXCEPTION 'PTO link idempotency key is required';
  END IF;

  SELECT after_state, actor_id, franchiseid
  INTO v_result, v_existing_actor_id, v_existing_franchiseid
  FROM public.pto_audit_events
  WHERE idempotency_key = 'pto-account-link:' || p_idempotency_key
    AND event_type = 'pto_account_linked';
  IF v_result IS NOT NULL THEN
    IF v_existing_actor_id <> p_actor_id OR v_existing_franchiseid <> p_actor_franchiseid THEN
      RAISE EXCEPTION 'PTO_LINK_FORBIDDEN: idempotency key belongs to another actor';
    END IF;
    RETURN v_result;
  END IF;

  SELECT public.pto_canonical_profile_id(crm.profile_id)
  INTO v_source_profile_id
  FROM public.pto_profile_crm_ids crm
  JOIN public.pto_discovered_tutor_accounts account
    ON account.provider = crm.provider AND account.crm_id = crm.crm_id
  WHERE account.id = p_account_id;

  PERFORM public.pto_lock_balance_scope(ARRAY[v_profile_id, v_source_profile_id]);
  PERFORM PG_ADVISORY_XACT_LOCK(HASHTEXTEXTENDED('pto-account:' || p_account_id, 0));

  SELECT after_state, actor_id, franchiseid
  INTO v_result, v_existing_actor_id, v_existing_franchiseid
  FROM public.pto_audit_events
  WHERE idempotency_key = 'pto-account-link:' || p_idempotency_key
    AND event_type = 'pto_account_linked';
  IF v_result IS NOT NULL THEN
    IF v_existing_actor_id <> p_actor_id OR v_existing_franchiseid <> p_actor_franchiseid THEN
      RAISE EXCEPTION 'PTO_LINK_FORBIDDEN: idempotency key belongs to another actor';
    END IF;
    RETURN v_result;
  END IF;

  v_profile_id := public.pto_canonical_profile_id(p_profile_id);
  PERFORM public.pto_assert_link_admin(v_profile_id, p_account_id, p_actor_franchiseid);

  SELECT * INTO v_account
  FROM public.pto_discovered_tutor_accounts
  WHERE id = p_account_id
  FOR UPDATE;
  IF NOT FOUND OR NOT v_account.crm_active THEN
    RAISE EXCEPTION 'PTO_DISCOVERY_STALE: account % is inactive or missing', p_account_id;
  END IF;

  SELECT decision.* INTO v_decision
  FROM public.pto_profile_link_decisions decision
  WHERE decision.account_id = p_account_id
    AND public.pto_canonical_profile_id(decision.profile_id) = v_profile_id
  ORDER BY (decision.profile_id = v_profile_id) DESC, decision.id
  LIMIT 1
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PTO_DISCOVERY_STALE: account % is not a candidate for profile %',
      p_account_id, p_profile_id;
  END IF;
  IF v_decision.version <> p_expected_version THEN
    RAISE EXCEPTION 'PTO_LINK_STALE: expected version %, found %',
      p_expected_version, v_decision.version;
  END IF;

  SELECT public.pto_canonical_profile_id(decision.profile_id)
  INTO v_linked_profile_id
  FROM public.pto_profile_link_decisions decision
  WHERE decision.account_id = p_account_id AND decision.status = 'linked';

  SELECT public.pto_canonical_profile_id(crm.profile_id)
  INTO v_source_profile_id
  FROM public.pto_profile_crm_ids crm
  WHERE crm.provider = v_account.provider AND crm.crm_id = v_account.crm_id;

  IF v_linked_profile_id IS NOT NULL
    AND v_source_profile_id IS DISTINCT FROM v_linked_profile_id
    AND v_linked_profile_id <> v_profile_id THEN
    RAISE EXCEPTION 'PTO_ACCOUNT_ALREADY_LINKED: account % belongs to profile %',
      p_account_id, v_linked_profile_id;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM public.pto_profile_link_decisions decision
    JOIN public.pto_discovered_tutor_accounts account ON account.id = decision.account_id
    WHERE decision.status = 'linked'
      AND decision.account_id <> p_account_id
      AND account.franchiseid = v_account.franchiseid
      AND public.pto_canonical_profile_id(decision.profile_id) = v_profile_id
  ) THEN
    RAISE EXCEPTION 'PTO_CENTER_ACCOUNT_CONFLICT: profile % already has a linked account for center %',
      v_profile_id, v_account.franchiseid;
  END IF;

  v_before_state := JSONB_BUILD_OBJECT(
    'profileId', v_profile_id,
    'sourceProfileId', v_source_profile_id,
    'account', TO_JSONB(v_account),
    'decision', TO_JSONB(v_decision),
    'targetBalance', (SELECT TO_JSONB(balance) FROM public.pto_profile_balance(v_profile_id, CURRENT_DATE) balance),
    'sourceBalance', CASE WHEN v_source_profile_id IS NULL OR v_source_profile_id = v_profile_id THEN NULL
      ELSE (SELECT TO_JSONB(balance) FROM public.pto_profile_balance(v_source_profile_id, CURRENT_DATE) balance)
    END
  );

  IF v_source_profile_id IS NULL THEN
    INSERT INTO public.pto_profile_crm_ids (profile_id, provider, crm_id)
    VALUES (v_profile_id, v_account.provider, v_account.crm_id);
  ELSIF v_source_profile_id <> v_profile_id THEN
    INSERT INTO public.pto_profile_match_candidates
      (left_profile_id, right_profile_id, status, decided_by, decided_at)
    VALUES (
      LEAST(v_profile_id, v_source_profile_id),
      GREATEST(v_profile_id, v_source_profile_id),
      'pending', NULL, NULL
    )
    ON CONFLICT (left_profile_id, right_profile_id) DO UPDATE SET
      status = 'pending', decided_by = NULL, decided_at = NULL
    RETURNING id INTO v_candidate_id;
    v_profile_id := public.pto_admin_decide_alias(
      v_candidate_id, 'confirm', p_actor_id, p_actor_franchiseid
    );
    v_profile_id := public.pto_canonical_profile_id(v_profile_id);
  END IF;

  WITH ranked AS (
    SELECT decision.id,
      ROW_NUMBER() OVER (
        PARTITION BY decision.account_id
        ORDER BY (decision.id = v_decision.id) DESC,
          (decision.status = 'linked') DESC,
          decision.version DESC,
          decision.id
      ) AS row_number
    FROM public.pto_profile_link_decisions decision
    WHERE public.pto_canonical_profile_id(decision.profile_id) = v_profile_id
  )
  DELETE FROM public.pto_profile_link_decisions decision
  USING ranked
  WHERE decision.id = ranked.id AND ranked.row_number > 1;

  UPDATE public.pto_profile_link_decisions decision
  SET profile_id = v_profile_id,
      status = CASE WHEN decision.id = v_decision.id THEN 'linked' ELSE decision.status END,
      version = CASE WHEN decision.id = v_decision.id THEN decision.version + 1 ELSE decision.version END,
      decided_by = CASE WHEN decision.id = v_decision.id THEN p_actor_id ELSE decision.decided_by END,
      decision_franchiseid = CASE WHEN decision.id = v_decision.id
        THEN p_actor_franchiseid ELSE decision.decision_franchiseid END,
      decided_at = CASE WHEN decision.id = v_decision.id THEN NOW() ELSE decision.decided_at END,
      updated_at = NOW()
  WHERE public.pto_canonical_profile_id(decision.profile_id) = v_profile_id;

  SELECT version INTO v_decision_version
  FROM public.pto_profile_link_decisions
  WHERE profile_id = v_profile_id AND account_id = p_account_id;

  v_result := JSONB_BUILD_OBJECT(
    'canonicalProfileId', v_profile_id::TEXT,
    'detachedProfileId', NULL,
    'decisionVersion', v_decision_version
  );
  INSERT INTO public.pto_audit_events
    (profile_id, franchiseid, actor_id, event_type, before_state, after_state, idempotency_key)
  VALUES (
    v_profile_id,
    p_actor_franchiseid,
    p_actor_id,
    'pto_account_linked',
    v_before_state,
    v_result,
    'pto-account-link:' || p_idempotency_key
  );
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.pto_admin_assign_adjustment_provenance(
  p_profile_id BIGINT,
  p_ledger_entry_id BIGINT,
  p_membership_id BIGINT,
  p_actor_id TEXT,
  p_actor_franchiseid INTEGER,
  p_idempotency_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_profile_id BIGINT := public.pto_canonical_profile_id(p_profile_id);
  v_ledger public.pto_ledger_entries%ROWTYPE;
  v_membership public.pto_profile_centers%ROWTYPE;
  v_result JSONB;
  v_existing_actor_id TEXT;
  v_existing_franchiseid INTEGER;
BEGIN
  SELECT after_state, actor_id, franchiseid
  INTO v_result, v_existing_actor_id, v_existing_franchiseid
  FROM public.pto_audit_events
  WHERE idempotency_key = 'pto-adjustment-provenance:' || p_idempotency_key
    AND event_type = 'pto_adjustment_provenance_assigned';
  IF v_result IS NOT NULL THEN
    IF v_existing_actor_id <> p_actor_id OR v_existing_franchiseid <> p_actor_franchiseid THEN
      RAISE EXCEPTION 'PTO_LINK_FORBIDDEN: idempotency key belongs to another actor';
    END IF;
    RETURN v_result;
  END IF;

  v_profile_id := (public.pto_lock_balance_scope(ARRAY[v_profile_id]))[1];
  PERFORM public.pto_assert_profile_admin(v_profile_id, p_actor_franchiseid);
  SELECT * INTO v_ledger FROM public.pto_ledger_entries
  WHERE id = p_ledger_entry_id FOR UPDATE;
  IF NOT FOUND OR public.pto_canonical_profile_id(v_ledger.profile_id) <> v_profile_id
    OR v_ledger.event_type <> 'adjustment' THEN
    RAISE EXCEPTION 'PTO adjustment % is not eligible for provenance assignment', p_ledger_entry_id;
  END IF;
  SELECT * INTO v_membership FROM public.pto_profile_centers
  WHERE id = p_membership_id AND active FOR UPDATE;
  IF NOT FOUND OR public.pto_canonical_profile_id(v_membership.profile_id) <> v_profile_id THEN
    RAISE EXCEPTION 'PTO provenance membership is not active on this profile';
  END IF;
  IF v_ledger.source_membership_id IS NOT NULL
    AND v_ledger.source_membership_id <> p_membership_id THEN
    RAISE EXCEPTION 'PTO adjustment provenance is already assigned';
  END IF;

  IF v_ledger.source_membership_id IS NULL THEN
    UPDATE public.pto_ledger_entries SET source_membership_id = p_membership_id
    WHERE id = p_ledger_entry_id;
  END IF;
  v_result := JSONB_BUILD_OBJECT(
    'ledgerEntryId', p_ledger_entry_id::TEXT,
    'membershipId', p_membership_id::TEXT
  );
  INSERT INTO public.pto_audit_events
    (profile_id, franchiseid, actor_id, event_type, before_state, after_state, idempotency_key)
  VALUES (
    v_profile_id,
    p_actor_franchiseid,
    p_actor_id,
    'pto_adjustment_provenance_assigned',
    TO_JSONB(v_ledger),
    v_result,
    'pto-adjustment-provenance:' || p_idempotency_key
  );
  RETURN v_result;
END;
$$;

CREATE OR REPLACE FUNCTION public.pto_admin_unlink_account(
  p_profile_id BIGINT,
  p_account_id BIGINT,
  p_actor_id TEXT,
  p_actor_franchiseid INTEGER,
  p_expected_version INTEGER,
  p_idempotency_key TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_profile_id BIGINT := public.pto_canonical_profile_id(p_profile_id);
  v_account public.pto_discovered_tutor_accounts%ROWTYPE;
  v_decision public.pto_profile_link_decisions%ROWTYPE;
  v_membership public.pto_profile_centers%ROWTYPE;
  v_adjustment RECORD;
  v_new_cycle_id BIGINT;
  v_new_profile_id BIGINT;
  v_result JSONB;
  v_before_state JSONB;
  v_decision_version INTEGER;
  v_existing_actor_id TEXT;
  v_existing_franchiseid INTEGER;
BEGIN
  IF NULLIF(BTRIM(p_idempotency_key), '') IS NULL THEN
    RAISE EXCEPTION 'PTO unlink idempotency key is required';
  END IF;
  SELECT after_state, actor_id, franchiseid
  INTO v_result, v_existing_actor_id, v_existing_franchiseid
  FROM public.pto_audit_events
  WHERE idempotency_key = 'pto-account-unlink:' || p_idempotency_key
    AND event_type IN ('pto_account_excluded', 'pto_account_split');
  IF v_result IS NOT NULL THEN
    IF v_existing_actor_id <> p_actor_id OR v_existing_franchiseid <> p_actor_franchiseid THEN
      RAISE EXCEPTION 'PTO_LINK_FORBIDDEN: idempotency key belongs to another actor';
    END IF;
    RETURN v_result;
  END IF;

  v_profile_id := (public.pto_lock_balance_scope(ARRAY[v_profile_id]))[1];
  PERFORM PG_ADVISORY_XACT_LOCK(HASHTEXTEXTENDED('pto-account:' || p_account_id, 0));
  PERFORM public.pto_assert_link_admin(v_profile_id, p_account_id, p_actor_franchiseid);

  SELECT * INTO v_account FROM public.pto_discovered_tutor_accounts
  WHERE id = p_account_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PTO_DISCOVERY_STALE: account % does not exist', p_account_id; END IF;
  SELECT decision.* INTO v_decision
  FROM public.pto_profile_link_decisions decision
  WHERE decision.account_id = p_account_id
    AND public.pto_canonical_profile_id(decision.profile_id) = v_profile_id
    AND decision.status = 'linked'
  ORDER BY (decision.profile_id = v_profile_id) DESC, decision.id
  LIMIT 1 FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PTO_LINK_STALE: account % is not linked to profile %', p_account_id, p_profile_id;
  END IF;
  IF v_decision.version <> p_expected_version THEN
    RAISE EXCEPTION 'PTO_LINK_STALE: expected version %, found %',
      p_expected_version, v_decision.version;
  END IF;

  SELECT center.* INTO v_membership
  FROM public.pto_profile_centers center
  WHERE center.franchiseid = v_account.franchiseid
    AND center.tutor_id = v_account.tutor_id
    AND center.active
    AND public.pto_canonical_profile_id(center.profile_id) = v_profile_id
  FOR UPDATE;
  v_before_state := JSONB_BUILD_OBJECT(
    'profileId', v_profile_id,
    'account', TO_JSONB(v_account),
    'decision', TO_JSONB(v_decision),
    'membership', CASE WHEN v_membership.id IS NULL THEN NULL ELSE TO_JSONB(v_membership) END,
    'balance', (SELECT TO_JSONB(balance) FROM public.pto_profile_balance(v_profile_id, CURRENT_DATE) balance),
    'requests', COALESCE((SELECT JSONB_AGG(request.id ORDER BY request.id)
      FROM public.time_off_requests request
      JOIN public.pto_request_allocations allocation ON allocation.request_id = request.id
      JOIN public.pto_entitlement_cycles cycle ON cycle.id = allocation.cycle_id
      WHERE request.franchiseid = v_account.franchiseid
        AND public.pto_canonical_profile_id(cycle.profile_id) = v_profile_id), '[]'::JSONB)
  );

  IF v_membership.id IS NULL THEN
    DELETE FROM public.pto_profile_crm_ids crm
    WHERE crm.provider = v_account.provider AND crm.crm_id = v_account.crm_id
      AND public.pto_canonical_profile_id(crm.profile_id) = v_profile_id;
    UPDATE public.pto_profile_link_decisions
    SET profile_id = v_profile_id,
      status = 'excluded',
      version = version + 1,
      decided_by = p_actor_id,
      decision_franchiseid = p_actor_franchiseid,
      decided_at = NOW(),
      updated_at = NOW()
    WHERE id = v_decision.id
    RETURNING version INTO v_decision_version;
    v_result := JSONB_BUILD_OBJECT(
      'canonicalProfileId', v_profile_id::TEXT,
      'detachedProfileId', NULL,
      'decisionVersion', v_decision_version
    );
    INSERT INTO public.pto_audit_events
      (profile_id, franchiseid, actor_id, event_type, before_state, after_state, idempotency_key)
    VALUES (v_profile_id, p_actor_franchiseid, p_actor_id, 'pto_account_excluded',
      v_before_state, v_result, 'pto-account-unlink:' || p_idempotency_key);
    RETURN v_result;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.pto_ledger_entries ledger
    WHERE public.pto_canonical_profile_id(ledger.profile_id) = v_profile_id
      AND ledger.event_type = 'adjustment'
      AND ledger.source_membership_id IS NULL
  ) THEN
    RAISE EXCEPTION 'PTO_SPLIT_RECONCILIATION_REQUIRED: legacy adjustments need membership provenance';
  END IF;

  v_new_profile_id := public.pto_admin_detach_membership(
    v_profile_id, v_membership.id, p_actor_id, p_actor_franchiseid
  );

  FOR v_adjustment IN
    SELECT ledger.*, cycle.starts_on
    FROM public.pto_ledger_entries ledger
    JOIN public.pto_entitlement_cycles cycle ON cycle.id = ledger.cycle_id
    WHERE ledger.event_type = 'adjustment'
      AND ledger.source_membership_id = v_membership.id
      AND public.pto_canonical_profile_id(ledger.profile_id) = v_profile_id
      AND ledger.idempotency_key NOT LIKE 'account-split:%'
    ORDER BY ledger.id
  LOOP
    v_new_cycle_id := public.pto_get_or_create_cycle(v_new_profile_id, v_adjustment.starts_on);
    INSERT INTO public.pto_ledger_entries
      (profile_id, cycle_id, event_type, balance_delta, idempotency_key, metadata, source_membership_id)
    VALUES (
      v_adjustment.profile_id,
      v_adjustment.cycle_id,
      'adjustment',
      -v_adjustment.balance_delta,
      'account-split:reverse-adjustment:' || v_membership.id || ':' || v_adjustment.id,
      JSONB_BUILD_OBJECT('reason', 'Detached membership adjustment',
        'detachedProfileId', v_new_profile_id, 'sourceLedgerEntryId', v_adjustment.id),
      v_membership.id
    ) ON CONFLICT (idempotency_key) DO NOTHING;
    INSERT INTO public.pto_ledger_entries
      (profile_id, cycle_id, event_type, balance_delta, idempotency_key, metadata, source_membership_id)
    VALUES (
      v_new_profile_id,
      v_new_cycle_id,
      'adjustment',
      v_adjustment.balance_delta,
      'account-split:move-adjustment:' || v_membership.id || ':' || v_adjustment.id,
      JSONB_BUILD_OBJECT('reason', COALESCE(v_adjustment.metadata ->> 'reason', 'Moved adjustment'),
        'sourceProfileId', v_adjustment.profile_id, 'sourceLedgerEntryId', v_adjustment.id),
      v_membership.id
    ) ON CONFLICT (idempotency_key) DO NOTHING;
  END LOOP;

  UPDATE public.pto_profile_link_decisions
  SET profile_id = v_profile_id,
    status = 'excluded',
    version = version + 1,
    decided_by = p_actor_id,
    decision_franchiseid = p_actor_franchiseid,
    decided_at = NOW(),
    updated_at = NOW()
  WHERE id = v_decision.id
  RETURNING version INTO v_decision_version;
  INSERT INTO public.pto_profile_link_decisions
    (profile_id, account_id, status, decided_by, decision_franchiseid, decided_at)
  VALUES (v_new_profile_id, p_account_id, 'linked', p_actor_id, p_actor_franchiseid, NOW())
  ON CONFLICT (profile_id, account_id) DO UPDATE SET
    status = 'linked',
    version = public.pto_profile_link_decisions.version + 1,
    decided_by = EXCLUDED.decided_by,
    decision_franchiseid = EXCLUDED.decision_franchiseid,
    decided_at = EXCLUDED.decided_at,
    updated_at = NOW();

  v_result := JSONB_BUILD_OBJECT(
    'canonicalProfileId', v_profile_id::TEXT,
    'detachedProfileId', v_new_profile_id::TEXT,
    'decisionVersion', v_decision_version,
    'remainingBalance', (SELECT TO_JSONB(balance) FROM public.pto_profile_balance(v_profile_id, CURRENT_DATE) balance),
    'detachedBalance', (SELECT TO_JSONB(balance) FROM public.pto_profile_balance(v_new_profile_id, CURRENT_DATE) balance),
    'membershipId', v_membership.id::TEXT,
    'accountId', p_account_id::TEXT
  );
  INSERT INTO public.pto_audit_events
    (profile_id, franchiseid, actor_id, event_type, before_state, after_state, idempotency_key)
  VALUES (v_profile_id, p_actor_franchiseid, p_actor_id, 'pto_account_split',
    v_before_state, v_result, 'pto-account-unlink:' || p_idempotency_key);
  RETURN v_result;
END;
$$;

-- ---------------------------------------------------------------------------
-- Approved-change PTO accounting
-- ---------------------------------------------------------------------------

-- The PTO-relevant shape of a time_off_requests row (as JSONB).
CREATE OR REPLACE FUNCTION public.pto_request_charge_shape(p_row JSONB)
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  SELECT CASE WHEN p_row IS NULL THEN NULL ELSE JSONB_BUILD_OBJECT(
    'type', p_row ->> 'type',
    'startDate', COALESCE(
      NULLIF(p_row -> 'public_metadata' ->> 'startDate', ''),
      (((p_row ->> 'start_at')::TIMESTAMPTZ AT TIME ZONE 'UTC')::DATE)::TEXT
    ),
    'endDate', COALESCE(
      NULLIF(p_row -> 'public_metadata' ->> 'endDate', ''),
      CASE
        WHEN COALESCE((p_row ->> 'partial_day')::BOOLEAN, FALSE)
          THEN (((p_row ->> 'end_at')::TIMESTAMPTZ AT TIME ZONE 'UTC')::DATE)::TEXT
        ELSE (((p_row ->> 'end_at')::TIMESTAMPTZ AT TIME ZONE 'UTC')::DATE - 1)::TEXT
      END
    ),
    'partialDay', COALESCE((p_row ->> 'partial_day')::BOOLEAN, FALSE),
    'durationHours', p_row -> 'duration_hours'
  ) END;
$$;

-- The PTO-relevant shape of a normalized camelCase submission target.
CREATE OR REPLACE FUNCTION public.pto_target_charge_shape(p_target JSONB)
RETURNS JSONB
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT CASE WHEN p_target IS NULL THEN NULL ELSE JSONB_BUILD_OBJECT(
    'type', p_target ->> 'storageType',
    'startDate', p_target ->> 'startDate',
    'endDate', p_target ->> 'endDate',
    'partialDay', COALESCE((p_target ->> 'partialDay')::BOOLEAN, FALSE),
    'durationHours', p_target -> 'durationHours'
  ) END;
$$;

-- Positive daily charges for a shape, mapped to the database policy's cycle.
CREATE OR REPLACE FUNCTION public.pto_change_charge_days(p_shape JSONB)
RETURNS TABLE (leave_date DATE, charged_days NUMERIC, cycle_start DATE)
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_shape IS NULL OR (p_shape ->> 'type') IS DISTINCT FROM 'pto' THEN
    RETURN;
  END IF;
  RETURN QUERY
  SELECT charge.leave_date, charge.charged_days,
    public.pto_cycle_start(charge.leave_date, policy.renewal_month, policy.renewal_day)
  FROM public.pto_request_day_charges(
    (p_shape ->> 'startDate')::DATE,
    (p_shape ->> 'endDate')::DATE,
    COALESCE((p_shape ->> 'partialDay')::BOOLEAN, FALSE),
    (p_shape ->> 'durationHours')::NUMERIC
  ) AS charge
  JOIN LATERAL (
    SELECT candidate.renewal_month, candidate.renewal_day
    FROM public.pto_policies candidate
    WHERE candidate.effective_from <= charge.leave_date
    ORDER BY candidate.effective_from DESC
    LIMIT 1
  ) AS policy ON TRUE
  WHERE charge.charged_days > 0;
END;
$$;

CREATE OR REPLACE FUNCTION public.pto_change_charges_differ(p_left JSONB, p_right JSONB)
RETURNS BOOLEAN
LANGUAGE sql
AS $$
  SELECT EXISTS (
    (SELECT leave_date, charged_days FROM public.pto_change_charge_days(p_left)
     EXCEPT ALL
     SELECT leave_date, charged_days FROM public.pto_change_charge_days(p_right))
    UNION ALL
    (SELECT leave_date, charged_days FROM public.pto_change_charge_days(p_right)
     EXCEPT ALL
     SELECT leave_date, charged_days FROM public.pto_change_charge_days(p_left))
  );
$$;

-- A paid request approved without allocations but with a positive charge
-- predates tracking: there is no recorded consumption to move or refund.
CREATE OR REPLACE FUNCTION public.pto_request_is_untracked(p_request_id BIGINT, p_before JSONB)
RETURNS BOOLEAN
LANGUAGE sql
AS $$
  SELECT (p_before ->> 'type') = 'pto'
    AND NOT EXISTS (SELECT 1 FROM public.pto_request_allocations WHERE request_id = p_request_id)
    AND COALESCE((
      SELECT SUM(charged_days) FROM public.pto_change_charge_days(public.pto_request_charge_shape(p_before))
    ), 0) > 0;
$$;

-- Per entitlement cycle: this request's active consumption (old) against the
-- proposed charge (new). Credit never crosses cycles.
CREATE OR REPLACE FUNCTION public.pto_approved_change_cycles(p_request_id BIGINT, p_after_shape JSONB)
RETURNS TABLE (
  cycle_start DATE,
  old_days NUMERIC,
  new_days NUMERIC,
  first_leave_date DATE,
  allocation_id BIGINT,
  allocation_profile_id BIGINT,
  allocation_count BIGINT
)
LANGUAGE sql
AS $$
  WITH new_charges AS (
    SELECT charge.cycle_start, SUM(charge.charged_days) AS days, MIN(charge.leave_date) AS first_date
    FROM public.pto_change_charge_days(p_after_shape) AS charge
    GROUP BY charge.cycle_start
  ), old_allocations AS (
    SELECT cycle.starts_on AS cycle_start,
      SUM(CASE WHEN allocation.state = 'consumed' THEN allocation.charged_days ELSE 0 END) AS days,
      (ARRAY_AGG(allocation.id ORDER BY (allocation.state = 'consumed') DESC, allocation.id))[1] AS allocation_id,
      (ARRAY_AGG(cycle.profile_id ORDER BY (allocation.state = 'consumed') DESC, allocation.id))[1] AS profile_id,
      COUNT(*) AS allocation_count
    FROM public.pto_request_allocations allocation
    JOIN public.pto_entitlement_cycles cycle ON cycle.id = allocation.cycle_id
    WHERE allocation.request_id = p_request_id
    GROUP BY cycle.starts_on
  )
  SELECT COALESCE(new_charges.cycle_start, old_allocations.cycle_start),
    COALESCE(old_allocations.days, 0),
    COALESCE(new_charges.days, 0),
    new_charges.first_date,
    old_allocations.allocation_id,
    old_allocations.profile_id,
    COALESCE(old_allocations.allocation_count, 0)
  FROM new_charges
  FULL OUTER JOIN old_allocations ON old_allocations.cycle_start = new_charges.cycle_start
  ORDER BY 1;
$$;

-- The canonical profile eligible to receive new consumption for a request, or
-- NULL when the request's source is currently ineligible or unresolved.
CREATE OR REPLACE FUNCTION public.pto_change_resolve_profile(p_row JSONB)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  v_enabled BOOLEAN;
BEGIN
  IF p_row -> 'public_metadata' ->> 'source' = 'public_timeoff_form' THEN
    SELECT enabled INTO v_enabled FROM public.pto_center_settings
    WHERE franchiseid = (p_row ->> 'franchiseid')::INTEGER;
    IF NOT COALESCE(v_enabled, FALSE) THEN
      RETURN NULL;
    END IF;
    BEGIN
      RETURN public.pto_canonical_profile_id(public.pto_resolve_profile(
        (p_row ->> 'franchiseid')::INTEGER, (p_row ->> 'tutorid')::BIGINT,
        (p_row ->> 'bridge_profile_id')::BIGINT, p_row ->> 'email', 'public',
        p_row ->> 'first_name', p_row ->> 'last_name'
      ));
    EXCEPTION WHEN raise_exception THEN
      RETURN NULL;
    END;
  END IF;
  RETURN public.pto_authenticated_linked_profile(
    (p_row ->> 'franchiseid')::INTEGER, (p_row ->> 'tutorid')::BIGINT
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.pto_change_unresolved_error(p_row JSONB)
RETURNS TEXT
LANGUAGE sql
AS $$
  SELECT CASE WHEN COALESCE((
    SELECT enabled FROM public.pto_center_settings WHERE franchiseid = (p_row ->> 'franchiseid')::INTEGER
  ), FALSE) THEN 'PTO_IDENTITY_UNRESOLVED' ELSE 'PTO_CENTER_DISABLED' END;
$$;

-- Ledger provenance: the one membership that sourced this request, if unambiguous.
CREATE OR REPLACE FUNCTION public.pto_change_source_membership(p_row JSONB, p_profile_id BIGINT)
RETURNS BIGINT
LANGUAGE sql
AS $$
  WITH candidates AS (
    SELECT center.id
    FROM public.pto_profile_centers center
    WHERE (p_row -> 'public_metadata' ->> 'source') IS DISTINCT FROM 'public_timeoff_form'
      AND center.franchiseid = (p_row ->> 'franchiseid')::INTEGER
      AND center.tutor_id = (p_row ->> 'tutorid')::BIGINT
      AND public.pto_canonical_profile_id(center.profile_id) = public.pto_canonical_profile_id(p_profile_id)
    UNION
    SELECT email.source_membership_id
    FROM public.pto_profile_emails email
    JOIN public.pto_profile_centers center ON center.id = email.source_membership_id
    WHERE (p_row -> 'public_metadata' ->> 'source') = 'public_timeoff_form'
      AND email.franchiseid = (p_row ->> 'franchiseid')::INTEGER
      AND email.email = LOWER(BTRIM(p_row ->> 'email'))
      AND email.active
      AND public.pto_canonical_profile_id(center.profile_id) = public.pto_canonical_profile_id(p_profile_id)
  )
  SELECT CASE WHEN COUNT(*) = 1 THEN MIN(id) END FROM candidates;
$$;

CREATE OR REPLACE FUNCTION public.pto_change_available(p_profile_id BIGINT, p_cycle_start DATE)
RETURNS NUMERIC
LANGUAGE sql
AS $$
  SELECT CASE
    WHEN p_profile_id IS NULL THEN 0
    WHEN balance.grant_count > 0 THEN balance.available_days
    -- An unmaterialized cycle would be granted the policy entitlement.
    ELSE COALESCE((
      SELECT policy.entitlement_days FROM public.pto_policies policy
      WHERE policy.effective_from <= p_cycle_start ORDER BY policy.effective_from DESC LIMIT 1
    ), 0) + balance.balance_days - balance.granted_days - balance.reserved_days
  END
  FROM public.pto_profile_balance(p_profile_id, p_cycle_start) AS balance;
$$;

CREATE OR REPLACE FUNCTION public.pto_preview_approved_change(p_request_id BIGINT, p_target_json JSONB)
RETURNS JSONB
LANGUAGE plpgsql
AS $$
DECLARE
  v_before JSONB;
  v_before_shape JSONB;
  v_after_shape JSONB;
  v_profile_id BIGINT;
  v_reference_profile_id BIGINT;
  v_cycle RECORD;
  v_available NUMERIC;
  v_reason TEXT := 'eligible';
  v_cycles JSONB := '[]'::JSONB;
BEGIN
  SELECT TO_JSONB(request) INTO v_before FROM public.time_off_requests request WHERE request.id = p_request_id;
  IF v_before IS NULL THEN
    RAISE EXCEPTION 'PTO request % does not exist', p_request_id;
  END IF;
  v_before_shape := public.pto_request_charge_shape(v_before);
  v_after_shape := public.pto_target_charge_shape(p_target_json);

  IF public.pto_request_is_untracked(p_request_id, v_before) THEN
    IF v_after_shape IS NOT NULL AND public.pto_change_charges_differ(v_before_shape, v_after_shape) THEN
      RETURN JSONB_BUILD_OBJECT('eligible', FALSE, 'reason', 'reconciliation_required', 'tracked', FALSE,
        'cycles', '[]'::JSONB, 'warnings', JSONB_BUILD_ARRAY(
          'This paid request predates PTO tracking, so its dates or type cannot change until its PTO is reconciled.'));
    END IF;
    RETURN JSONB_BUILD_OBJECT('eligible', TRUE, 'reason', 'eligible', 'tracked', FALSE,
      'cycles', '[]'::JSONB, 'warnings', JSONB_BUILD_ARRAY(
        'This paid request predates PTO tracking; no PTO refund or charge will be recorded.'));
  END IF;

  IF EXISTS (SELECT 1 FROM public.pto_change_charge_days(v_after_shape)) THEN
    v_profile_id := public.pto_change_resolve_profile(v_before);
  END IF;
  SELECT public.pto_canonical_profile_id(cycle.profile_id) INTO v_reference_profile_id
  FROM public.pto_request_allocations allocation
  JOIN public.pto_entitlement_cycles cycle ON cycle.id = allocation.cycle_id
  WHERE allocation.request_id = p_request_id
  ORDER BY allocation.id LIMIT 1;

  FOR v_cycle IN SELECT * FROM public.pto_approved_change_cycles(p_request_id, v_after_shape) LOOP
    v_available := public.pto_change_available(COALESCE(v_profile_id, v_reference_profile_id), v_cycle.cycle_start);
    IF v_cycle.new_days > v_cycle.old_days AND v_reason = 'eligible' THEN
      IF v_profile_id IS NULL THEN
        v_reason := CASE public.pto_change_unresolved_error(v_before)
          WHEN 'PTO_CENTER_DISABLED' THEN 'center_disabled' ELSE 'identity_unresolved' END;
      ELSIF v_cycle.allocation_profile_id IS NOT NULL
        AND public.pto_canonical_profile_id(v_cycle.allocation_profile_id) <> v_profile_id THEN
        v_reason := 'identity_conflict';
      ELSIF v_available < v_cycle.new_days - v_cycle.old_days THEN
        v_reason := 'insufficient_balance';
      END IF;
    END IF;
    v_cycles := v_cycles || JSONB_BUILD_ARRAY(JSONB_BUILD_OBJECT(
      'cycleStart', v_cycle.cycle_start,
      'oldDays', v_cycle.old_days,
      'newDays', v_cycle.new_days,
      'availableDays', v_available,
      'availableAfter', v_available + v_cycle.old_days - v_cycle.new_days
    ));
  END LOOP;

  RETURN JSONB_BUILD_OBJECT('eligible', v_reason = 'eligible', 'reason', v_reason, 'tracked', TRUE,
    'cycles', v_cycles, 'warnings', '[]'::JSONB);
END;
$$;

-- Recomputes the request's charge under locks after an approved edit or
-- cancellation; never trusts preview values. Appends consume/release deltas
-- keyed by operation and allocation, with zero reserved delta.
CREATE OR REPLACE FUNCTION public.pto_reconcile_approved_time_off(
  p_request_id BIGINT,
  p_operation_id UUID,
  p_before_json JSONB
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_operation public.time_off_change_operations%ROWTYPE;
  v_after JSONB;
  v_before_shape JSONB;
  v_after_shape JSONB;
  v_profile_id BIGINT;
  v_lock_ids BIGINT[];
  v_cycle RECORD;
  v_delta NUMERIC;
  v_available NUMERIC;
  v_cycle_id BIGINT;
  v_allocation_id BIGINT;
  v_ledger_profile_id BIGINT;
  v_metadata JSONB;
BEGIN
  SELECT * INTO v_operation FROM public.time_off_change_operations WHERE id = p_operation_id;
  IF NOT FOUND OR v_operation.action NOT IN ('admin_edit', 'approve_amendment', 'cancel') THEN
    RETURN;
  END IF;
  SELECT TO_JSONB(request) INTO v_after FROM public.time_off_requests request WHERE request.id = p_request_id;
  v_before_shape := public.pto_request_charge_shape(p_before_json);
  v_after_shape := CASE WHEN v_after ->> 'status' = 'cancelled' THEN NULL
    ELSE public.pto_request_charge_shape(v_after) END;

  IF public.pto_request_is_untracked(p_request_id, p_before_json) THEN
    IF v_after_shape IS NOT NULL AND public.pto_change_charges_differ(v_before_shape, v_after_shape) THEN
      RAISE EXCEPTION USING MESSAGE = 'TIME_OFF_PTO_RECONCILIATION_REQUIRED', ERRCODE = 'P0001';
    END IF;
    RETURN;
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.pto_request_allocations WHERE request_id = p_request_id AND state = 'reserved'
  ) THEN
    RAISE EXCEPTION USING MESSAGE = 'TIME_OFF_PTO_RECONCILIATION_REQUIRED', ERRCODE = 'P0001';
  END IF;

  IF EXISTS (SELECT 1 FROM public.pto_change_charge_days(v_after_shape)) THEN
    v_profile_id := public.pto_change_resolve_profile(v_after);
  END IF;
  SELECT ARRAY_AGG(cycle.profile_id) INTO v_lock_ids
  FROM public.pto_request_allocations allocation
  JOIN public.pto_entitlement_cycles cycle ON cycle.id = allocation.cycle_id
  WHERE allocation.request_id = p_request_id;
  PERFORM public.pto_lock_balance_scope(ARRAY_APPEND(COALESCE(v_lock_ids, ARRAY[]::BIGINT[]), v_profile_id));
  IF v_profile_id IS NOT NULL THEN
    v_profile_id := public.pto_canonical_profile_id(v_profile_id);
  END IF;
  PERFORM 1 FROM public.pto_request_allocations
  WHERE request_id = p_request_id ORDER BY cycle_id FOR UPDATE;

  FOR v_cycle IN SELECT * FROM public.pto_approved_change_cycles(p_request_id, v_after_shape) LOOP
    IF v_cycle.allocation_count > 1 THEN
      RAISE EXCEPTION USING MESSAGE = 'TIME_OFF_PTO_RECONCILIATION_REQUIRED', ERRCODE = 'P0001';
    END IF;
    v_delta := v_cycle.new_days - v_cycle.old_days;
    CONTINUE WHEN v_delta = 0;
    v_metadata := JSONB_BUILD_OBJECT('operationId', p_operation_id, 'action', v_operation.action,
      'cycleStart', v_cycle.cycle_start, 'oldDays', v_cycle.old_days, 'newDays', v_cycle.new_days);

    IF v_delta > 0 THEN
      IF v_profile_id IS NULL THEN
        RAISE EXCEPTION USING MESSAGE = public.pto_change_unresolved_error(v_after), ERRCODE = 'P0001';
      END IF;
      IF v_cycle.allocation_profile_id IS NOT NULL
        AND public.pto_canonical_profile_id(v_cycle.allocation_profile_id) <> v_profile_id THEN
        RAISE EXCEPTION USING MESSAGE = 'TIME_OFF_PTO_IDENTITY_CONFLICT', ERRCODE = 'P0001';
      END IF;
      IF v_cycle.allocation_id IS NULL THEN
        v_cycle_id := public.pto_get_or_create_cycle(v_profile_id, v_cycle.first_leave_date);
      ELSE
        SELECT cycle_id INTO v_cycle_id FROM public.pto_request_allocations WHERE id = v_cycle.allocation_id;
      END IF;
      SELECT available_days INTO v_available FROM public.pto_profile_balance(v_profile_id, v_cycle.cycle_start);
      IF v_available < v_delta THEN
        RAISE EXCEPTION 'Insufficient shared PTO balance for cycle %', v_cycle_id;
      END IF;
      IF v_cycle.allocation_id IS NULL THEN
        INSERT INTO public.pto_request_allocations (request_id, cycle_id, charged_days, state)
        VALUES (p_request_id, v_cycle_id, v_cycle.new_days, 'consumed')
        RETURNING id INTO v_allocation_id;
        v_ledger_profile_id := v_profile_id;
      ELSE
        UPDATE public.pto_request_allocations
        SET charged_days = v_cycle.new_days, state = 'consumed', updated_at = NOW()
        WHERE id = v_cycle.allocation_id;
        v_allocation_id := v_cycle.allocation_id;
        v_ledger_profile_id := v_cycle.allocation_profile_id;
      END IF;
      INSERT INTO public.pto_ledger_entries (
        profile_id, cycle_id, request_id, allocation_id, event_type, balance_delta, reserved_delta,
        idempotency_key, metadata, source_membership_id
      ) VALUES (
        v_ledger_profile_id, v_cycle_id, p_request_id, v_allocation_id, 'consume', -v_delta, 0,
        'change-consume:' || p_operation_id || ':' || v_allocation_id, v_metadata,
        public.pto_change_source_membership(v_after, v_ledger_profile_id)
      ) ON CONFLICT (idempotency_key) DO NOTHING;
    ELSE
      SELECT cycle_id INTO v_cycle_id FROM public.pto_request_allocations WHERE id = v_cycle.allocation_id;
      -- Released allocations keep their last positive charge (charged_days > 0).
      UPDATE public.pto_request_allocations
      SET charged_days = CASE WHEN v_cycle.new_days > 0 THEN v_cycle.new_days ELSE charged_days END,
        state = CASE WHEN v_cycle.new_days > 0 THEN 'consumed' ELSE 'released' END,
        updated_at = NOW()
      WHERE id = v_cycle.allocation_id;
      INSERT INTO public.pto_ledger_entries (
        profile_id, cycle_id, request_id, allocation_id, event_type, balance_delta, reserved_delta,
        idempotency_key, metadata, source_membership_id
      ) VALUES (
        v_cycle.allocation_profile_id, v_cycle_id, p_request_id, v_cycle.allocation_id, 'release', -v_delta, 0,
        'change-release:' || p_operation_id || ':' || v_cycle.allocation_id, v_metadata,
        public.pto_change_source_membership(v_after, v_cycle.allocation_profile_id)
      ) ON CONFLICT (idempotency_key) DO NOTHING;
    END IF;
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Guarded request writes
-- ---------------------------------------------------------------------------

-- Replaces the 0010 held-field guard. A write that moves the operation pointer
-- must match a stored, not-yet-applied operation exactly; every other write
-- keeps the original held-field rule. Versions advance only through an
-- operation or a status change.
CREATE OR REPLACE FUNCTION public.pto_protect_held_request()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_operation public.time_off_change_operations%ROWTYPE;
  v_target JSONB;
  v_identity_changed BOOLEAN;
  v_effective_changed BOOLEAN;
  v_held_changed BOOLEAN;
  v_start_at public.time_off_requests.start_at%TYPE;
  v_end_at public.time_off_requests.end_at%TYPE;
  v_type public.time_off_requests.type%TYPE;
  v_absence_label public.time_off_requests.absence_label%TYPE;
  v_notes public.time_off_requests.notes%TYPE;
  v_duration public.time_off_requests.duration_hours%TYPE;
  v_partial public.time_off_requests.partial_day%TYPE;
  v_leave public.time_off_requests.leave_time%TYPE;
  v_return public.time_off_requests.return_time%TYPE;
BEGIN
  v_identity_changed := NEW.franchiseid IS DISTINCT FROM OLD.franchiseid
    OR NEW.tutorid IS DISTINCT FROM OLD.tutorid
    OR NEW.bridge_flag IS DISTINCT FROM OLD.bridge_flag
    OR NEW.bridge_profile_id IS DISTINCT FROM OLD.bridge_profile_id
    OR NEW.email IS DISTINCT FROM OLD.email
    OR NEW.first_name IS DISTINCT FROM OLD.first_name
    OR NEW.last_name IS DISTINCT FROM OLD.last_name
    OR NEW.created_at IS DISTINCT FROM OLD.created_at
    OR NEW.created_by IS DISTINCT FROM OLD.created_by
    OR (NEW.public_metadata ->> 'source') IS DISTINCT FROM (OLD.public_metadata ->> 'source');
  v_held_changed := NEW.franchiseid IS DISTINCT FROM OLD.franchiseid
    OR NEW.tutorid IS DISTINCT FROM OLD.tutorid
    OR NEW.bridge_flag IS DISTINCT FROM OLD.bridge_flag
    OR NEW.bridge_profile_id IS DISTINCT FROM OLD.bridge_profile_id
    OR NEW.email IS DISTINCT FROM OLD.email
    OR NEW.start_at IS DISTINCT FROM OLD.start_at
    OR NEW.end_at IS DISTINCT FROM OLD.end_at
    OR NEW.type IS DISTINCT FROM OLD.type
    OR NEW.partial_day IS DISTINCT FROM OLD.partial_day
    OR NEW.duration_hours IS DISTINCT FROM OLD.duration_hours
    OR NEW.leave_time IS DISTINCT FROM OLD.leave_time
    OR NEW.return_time IS DISTINCT FROM OLD.return_time
    OR (NEW.public_metadata ->> 'startDate') IS DISTINCT FROM (OLD.public_metadata ->> 'startDate')
    OR (NEW.public_metadata ->> 'endDate') IS DISTINCT FROM (OLD.public_metadata ->> 'endDate');
  v_effective_changed := v_held_changed
    OR NEW.absence_label IS DISTINCT FROM OLD.absence_label
    OR NEW.notes IS DISTINCT FROM OLD.notes;

  IF NEW.last_change_operation_id IS DISTINCT FROM OLD.last_change_operation_id THEN
    SELECT * INTO v_operation FROM public.time_off_change_operations WHERE id = NEW.last_change_operation_id;
    IF NOT FOUND
      OR v_operation.request_id <> OLD.id
      OR v_operation.franchiseid <> OLD.franchiseid
      OR v_operation.expected_version <> OLD.version
      OR NEW.version <> OLD.version + 1
      OR NEW.version <> v_operation.result_version
      OR v_identity_changed THEN
      RAISE EXCEPTION 'TIME_OFF_CHANGE_GUARD: operation % does not authorize this write to request %',
        NEW.last_change_operation_id, OLD.id;
    END IF;
    IF v_operation.action IN ('admin_edit', 'approve_amendment') THEN
      v_target := v_operation.target;
      v_start_at := v_target ->> 'startAt';
      v_end_at := v_target ->> 'endAt';
      v_type := v_target ->> 'storageType';
      v_absence_label := v_target ->> 'absenceLabel';
      v_notes := v_target ->> 'reason';
      v_duration := v_target ->> 'durationHours';
      v_partial := v_target ->> 'partialDay';
      v_leave := v_target ->> 'leaveTime';
      v_return := v_target ->> 'returnTime';
      IF OLD.status::TEXT <> 'approved' OR NEW.status::TEXT <> 'approved'
        OR NEW.start_at IS DISTINCT FROM v_start_at
        OR NEW.end_at IS DISTINCT FROM v_end_at
        OR NEW.type IS DISTINCT FROM v_type
        OR NEW.absence_label IS DISTINCT FROM v_absence_label
        OR NEW.notes IS DISTINCT FROM v_notes
        OR NEW.duration_hours IS DISTINCT FROM v_duration
        OR NEW.partial_day IS DISTINCT FROM v_partial
        OR NEW.leave_time IS DISTINCT FROM v_leave
        OR NEW.return_time IS DISTINCT FROM v_return
        OR (NEW.public_metadata ->> 'startDate') IS DISTINCT FROM (v_target ->> 'startDate')
        OR (NEW.public_metadata ->> 'endDate') IS DISTINCT FROM (v_target ->> 'endDate') THEN
        RAISE EXCEPTION 'TIME_OFF_CHANGE_GUARD: request % fields do not match operation %', OLD.id, v_operation.id;
      END IF;
    ELSIF v_operation.action = 'cancel' THEN
      IF OLD.status::TEXT <> 'approved' OR NEW.status::TEXT <> 'cancelled' OR v_effective_changed THEN
        RAISE EXCEPTION 'TIME_OFF_CHANGE_GUARD: cancellation % must only cancel approved request %',
          v_operation.id, OLD.id;
      END IF;
    ELSIF NEW.status IS DISTINCT FROM OLD.status OR v_effective_changed THEN
      RAISE EXCEPTION 'TIME_OFF_CHANGE_GUARD: workflow operation % cannot change request % fields',
        v_operation.id, OLD.id;
    END IF;
    RETURN NEW;
  END IF;

  IF v_held_changed AND EXISTS (
    SELECT 1 FROM public.pto_request_allocations WHERE request_id = OLD.id
  ) THEN
    RAISE EXCEPTION 'Held PTO identity/date/type fields cannot be changed';
  END IF;
  NEW.version := CASE WHEN NEW.status IS DISTINCT FROM OLD.status THEN OLD.version + 1 ELSE OLD.version END;
  RETURN NEW;
END;
$$;

CREATE OR REPLACE FUNCTION public.time_off_reconcile_approved_change()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM public.pto_reconcile_approved_time_off(NEW.id, NEW.last_change_operation_id, TO_JSONB(OLD));
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS time_off_approved_change_reconcile ON public.time_off_requests;
CREATE TRIGGER time_off_approved_change_reconcile
AFTER UPDATE ON public.time_off_requests
FOR EACH ROW
WHEN (NEW.last_change_operation_id IS DISTINCT FROM OLD.last_change_operation_id)
EXECUTE FUNCTION public.time_off_reconcile_approved_change();

-- Applies a stored operation to its request. Workflow-only actions advance the
-- version; edits write the frozen target; cancellation records its own decision
-- metadata. Re-applying the operation that already produced the current state
-- is a no-op that returns its version.
CREATE OR REPLACE FUNCTION public.time_off_apply_approved_change(p_operation_id UUID)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  v_operation public.time_off_change_operations%ROWTYPE;
  v_request public.time_off_requests%ROWTYPE;
  v_target JSONB;
  v_start_at public.time_off_requests.start_at%TYPE;
  v_end_at public.time_off_requests.end_at%TYPE;
  v_type public.time_off_requests.type%TYPE;
  v_absence_label public.time_off_requests.absence_label%TYPE;
  v_notes public.time_off_requests.notes%TYPE;
  v_duration public.time_off_requests.duration_hours%TYPE;
  v_partial public.time_off_requests.partial_day%TYPE;
  v_leave public.time_off_requests.leave_time%TYPE;
  v_return public.time_off_requests.return_time%TYPE;
  v_status public.time_off_requests.status%TYPE;
BEGIN
  SELECT * INTO v_operation FROM public.time_off_change_operations WHERE id = p_operation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TIME_OFF_INVALID_STATE: operation % does not exist', p_operation_id;
  END IF;
  SELECT * INTO v_request FROM public.time_off_requests WHERE id = v_operation.request_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'TIME_OFF_INVALID_STATE: request % does not exist', v_operation.request_id;
  END IF;
  IF v_request.last_change_operation_id IS NOT DISTINCT FROM v_operation.id THEN
    RETURN v_operation.result_version;
  END IF;
  IF v_request.franchiseid <> v_operation.franchiseid THEN
    RAISE EXCEPTION 'TIME_OFF_INVALID_STATE: request % is not in franchise %', v_request.id, v_operation.franchiseid;
  END IF;
  IF v_request.version <> v_operation.expected_version THEN
    RAISE EXCEPTION 'TIME_OFF_VERSION_CONFLICT: expected version %, found %',
      v_operation.expected_version, v_request.version;
  END IF;
  IF v_operation.action IN ('admin_edit', 'approve_amendment', 'cancel') AND v_request.status::TEXT <> 'approved' THEN
    RAISE EXCEPTION 'TIME_OFF_INVALID_STATE: request % is %', v_request.id, v_request.status;
  END IF;

  IF v_operation.action IN ('admin_edit', 'approve_amendment') THEN
    v_target := v_operation.target;
    v_start_at := v_target ->> 'startAt';
    v_end_at := v_target ->> 'endAt';
    v_type := v_target ->> 'storageType';
    v_absence_label := v_target ->> 'absenceLabel';
    v_notes := v_target ->> 'reason';
    v_duration := v_target ->> 'durationHours';
    v_partial := v_target ->> 'partialDay';
    v_leave := v_target ->> 'leaveTime';
    v_return := v_target ->> 'returnTime';
    UPDATE public.time_off_requests
    SET start_at = v_start_at,
      end_at = v_end_at,
      type = v_type,
      absence_label = v_absence_label,
      notes = v_notes,
      duration_hours = v_duration,
      partial_day = v_partial,
      leave_time = v_leave,
      return_time = v_return,
      public_metadata = COALESCE(public_metadata, '{}'::JSONB)
        || JSONB_BUILD_OBJECT('startDate', v_target ->> 'startDate', 'endDate', v_target ->> 'endDate'),
      version = version + 1,
      last_change_operation_id = v_operation.id
    WHERE id = v_request.id;
  ELSIF v_operation.action = 'cancel' THEN
    v_status := 'cancelled';
    UPDATE public.time_off_requests
    SET status = v_status,
      decided_at = NOW(),
      decided_by = v_operation.actor_id,
      decision_reason = v_operation.change_reason,
      version = version + 1,
      last_change_operation_id = v_operation.id
    WHERE id = v_request.id;
  ELSE
    UPDATE public.time_off_requests
    SET version = version + 1,
      last_change_operation_id = v_operation.id
    WHERE id = v_request.id;
  END IF;
  RETURN v_operation.result_version;
END;
$$;
