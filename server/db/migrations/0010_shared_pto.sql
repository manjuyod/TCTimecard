CREATE TABLE IF NOT EXISTS public.pto_policies (
  id BIGSERIAL PRIMARY KEY,
  effective_from DATE NOT NULL UNIQUE,
  entitlement_days NUMERIC(6, 2) NOT NULL DEFAULT 5 CHECK (entitlement_days >= 0),
  renewal_month SMALLINT NOT NULL DEFAULT 1 CHECK (renewal_month BETWEEN 1 AND 12),
  renewal_day SMALLINT NOT NULL DEFAULT 1 CHECK (renewal_day BETWEEN 1 AND 28),
  carryover_days NUMERIC(6, 2) NOT NULL DEFAULT 0 CHECK (carryover_days >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO public.pto_policies (effective_from)
VALUES (DATE '1970-01-01')
ON CONFLICT (effective_from) DO NOTHING;

CREATE TABLE IF NOT EXISTS public.pto_center_settings (
  franchiseid INTEGER PRIMARY KEY,
  enabled BOOLEAN NOT NULL DEFAULT FALSE,
  first_activated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.pto_profiles (
  id BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.pto_profile_crm_ids (
  profile_id BIGINT NOT NULL REFERENCES public.pto_profiles(id),
  provider TEXT NOT NULL,
  crm_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, crm_id),
  UNIQUE (profile_id, provider, crm_id)
);

CREATE TABLE IF NOT EXISTS public.pto_profile_emails (
  profile_id BIGINT NOT NULL REFERENCES public.pto_profiles(id),
  email TEXT PRIMARY KEY CHECK (email = LOWER(BTRIM(email))),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (profile_id, email)
);

CREATE TABLE IF NOT EXISTS public.pto_profile_centers (
  profile_id BIGINT NOT NULL REFERENCES public.pto_profiles(id),
  franchiseid INTEGER NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (profile_id, franchiseid)
);

CREATE TABLE IF NOT EXISTS public.pto_entitlement_cycles (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL REFERENCES public.pto_profiles(id),
  starts_on DATE NOT NULL,
  ends_on DATE NOT NULL,
  entitlement_days NUMERIC(6, 2) NOT NULL CHECK (entitlement_days >= 0),
  policy_id BIGINT NOT NULL REFERENCES public.pto_policies(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (profile_id, starts_on),
  CHECK (ends_on >= starts_on)
);

CREATE TABLE IF NOT EXISTS public.pto_ledger_entries (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL REFERENCES public.pto_profiles(id),
  cycle_id BIGINT NOT NULL REFERENCES public.pto_entitlement_cycles(id),
  request_id BIGINT,
  allocation_id BIGINT,
  event_type TEXT NOT NULL CHECK (event_type IN ('grant', 'reserve', 'consume', 'release', 'adjustment')),
  balance_delta NUMERIC(6, 2) NOT NULL DEFAULT 0,
  reserved_delta NUMERIC(6, 2) NOT NULL DEFAULT 0,
  idempotency_key TEXT NOT NULL UNIQUE,
  metadata JSONB NOT NULL DEFAULT '{}'::JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pto_ledger_entries_profile_cycle_idx
  ON public.pto_ledger_entries (profile_id, cycle_id, created_at);

CREATE TABLE IF NOT EXISTS public.pto_request_allocations (
  id BIGSERIAL PRIMARY KEY,
  request_id BIGINT NOT NULL,
  cycle_id BIGINT NOT NULL REFERENCES public.pto_entitlement_cycles(id),
  charged_days NUMERIC(6, 2) NOT NULL CHECK (charged_days > 0),
  state TEXT NOT NULL CHECK (state IN ('reserved', 'consumed', 'released')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (request_id, cycle_id)
);

CREATE INDEX IF NOT EXISTS pto_request_allocations_cycle_idx
  ON public.pto_request_allocations (cycle_id, state);

CREATE OR REPLACE FUNCTION public.pto_charge_for_date(p_leave_date DATE)
RETURNS NUMERIC
LANGUAGE SQL
IMMUTABLE
STRICT
AS $$
  SELECT CASE
    WHEN EXTRACT(ISODOW FROM p_leave_date) = 6 THEN 0.5
    WHEN EXTRACT(ISODOW FROM p_leave_date) = 7 THEN 0
    ELSE 1
  END::NUMERIC;
$$;

CREATE OR REPLACE FUNCTION public.pto_cycle_start(
  p_leave_date DATE,
  p_renewal_month SMALLINT DEFAULT 1,
  p_renewal_day SMALLINT DEFAULT 1
)
RETURNS DATE
LANGUAGE SQL
IMMUTABLE
STRICT
AS $$
  SELECT CASE
    WHEN p_leave_date >= MAKE_DATE(EXTRACT(YEAR FROM p_leave_date)::INTEGER, p_renewal_month, p_renewal_day)
      THEN MAKE_DATE(EXTRACT(YEAR FROM p_leave_date)::INTEGER, p_renewal_month, p_renewal_day)
    ELSE MAKE_DATE(EXTRACT(YEAR FROM p_leave_date)::INTEGER - 1, p_renewal_month, p_renewal_day)
  END;
$$;

CREATE OR REPLACE FUNCTION public.pto_get_or_create_cycle(
  p_profile_id BIGINT,
  p_leave_date DATE
)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  v_policy public.pto_policies%ROWTYPE;
  v_cycle_start DATE;
  v_cycle_end DATE;
  v_cycle_id BIGINT;
BEGIN
  PERFORM 1
  FROM public.pto_profiles
  WHERE id = p_profile_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'PTO profile % does not exist', p_profile_id;
  END IF;

  SELECT *
  INTO v_policy
  FROM public.pto_policies
  WHERE effective_from <= p_leave_date
  ORDER BY effective_from DESC
  LIMIT 1;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'No PTO policy applies to %', p_leave_date;
  END IF;

  v_cycle_start := public.pto_cycle_start(
    p_leave_date,
    v_policy.renewal_month,
    v_policy.renewal_day
  );
  v_cycle_end := (
    v_cycle_start + INTERVAL '1 year' - INTERVAL '1 day'
  )::DATE;

  INSERT INTO public.pto_entitlement_cycles (
    profile_id,
    starts_on,
    ends_on,
    entitlement_days,
    policy_id
  )
  VALUES (
    p_profile_id,
    v_cycle_start,
    v_cycle_end,
    v_policy.entitlement_days,
    v_policy.id
  )
  ON CONFLICT (profile_id, starts_on) DO NOTHING;

  SELECT id
  INTO v_cycle_id
  FROM public.pto_entitlement_cycles
  WHERE profile_id = p_profile_id
    AND starts_on = v_cycle_start;

  INSERT INTO public.pto_ledger_entries (
    profile_id,
    cycle_id,
    event_type,
    balance_delta,
    reserved_delta,
    idempotency_key,
    metadata
  )
  VALUES (
    p_profile_id,
    v_cycle_id,
    'grant',
    v_policy.entitlement_days,
    0,
    'grant:' || v_cycle_id,
    JSONB_BUILD_OBJECT('policyId', v_policy.id)
  )
  ON CONFLICT (idempotency_key) DO NOTHING;

  RETURN v_cycle_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.pto_set_center_activation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD.first_activated_at IS NOT NULL
    AND NEW.first_activated_at IS DISTINCT FROM OLD.first_activated_at THEN
    RAISE EXCEPTION 'first_activated_at cannot be changed after activation';
  END IF;

  IF NEW.enabled AND NEW.first_activated_at IS NULL THEN
    NEW.first_activated_at := CLOCK_TIMESTAMP();
  END IF;

  NEW.updated_at := NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pto_center_activation_guard ON public.pto_center_settings;
CREATE TRIGGER pto_center_activation_guard
BEFORE INSERT OR UPDATE ON public.pto_center_settings
FOR EACH ROW
EXECUTE FUNCTION public.pto_set_center_activation();

CREATE OR REPLACE FUNCTION public.pto_enforce_future_policy()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.effective_from <= CURRENT_DATE THEN
    RAISE EXCEPTION 'PTO policy changes must be future-effective';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pto_policy_future_guard ON public.pto_policies;
CREATE TRIGGER pto_policy_future_guard
BEFORE INSERT OR UPDATE ON public.pto_policies
FOR EACH ROW
EXECUTE FUNCTION public.pto_enforce_future_policy();

CREATE OR REPLACE FUNCTION public.pto_request_day_charges(
  p_start_date DATE,
  p_end_date DATE,
  p_partial_day BOOLEAN,
  p_duration_hours NUMERIC DEFAULT NULL
)
RETURNS TABLE (leave_date DATE, charged_days NUMERIC)
LANGUAGE plpgsql
AS $$
BEGIN
  IF p_end_date < p_start_date THEN
    RAISE EXCEPTION 'PTO request end date precedes start date';
  END IF;
  IF p_partial_day
    AND p_start_date = p_end_date
    AND (p_duration_hours IS NULL OR p_duration_hours <= 0) THEN
    RAISE EXCEPTION 'Same-day partial PTO requires positive duration hours';
  END IF;

  RETURN QUERY
  WITH ordinary AS (
    SELECT
      series_date::DATE AS leave_date,
      public.pto_charge_for_date(series_date::DATE) AS ordinary_days
    FROM GENERATE_SERIES(
      p_start_date::TIMESTAMP,
      p_end_date::TIMESTAMP,
      INTERVAL '1 day'
    ) AS series_date
  ),
  eligible AS (
    SELECT
      ordinary.leave_date,
      ROW_NUMBER() OVER (ORDER BY ordinary.leave_date) AS eligible_rank,
      COUNT(*) OVER () AS eligible_count
    FROM ordinary
    WHERE ordinary.ordinary_days > 0
  )
  SELECT
    ordinary.leave_date,
    CASE
      WHEN p_partial_day AND p_start_date = p_end_date
        THEN CASE WHEN p_duration_hours <= 4 THEN 0.5 ELSE 1 END
      WHEN p_partial_day AND (eligible_rank = 1 OR eligible_rank = eligible_count)
        THEN 0.5
      ELSE ordinary.ordinary_days
    END::NUMERIC AS charged_days
  FROM ordinary
  LEFT JOIN eligible USING (leave_date)
  ORDER BY ordinary.leave_date;
END;
$$;

CREATE OR REPLACE FUNCTION public.pto_resolve_profile(
  p_franchiseid INTEGER,
  p_tutorid BIGINT,
  p_bridge_profile_id BIGINT,
  p_email TEXT
)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  v_email TEXT := NULLIF(LOWER(BTRIM(p_email)), '');
  v_bridge_profile BIGINT;
  v_email_profile BIGINT;
  v_local_profile BIGINT;
  v_profile_id BIGINT;
  v_attached_profile BIGINT;
  v_local_provider TEXT := 'timecard-center:' || p_franchiseid;
BEGIN
  IF p_bridge_profile_id IS NULL AND p_tutorid IS NULL AND v_email IS NULL THEN
    RAISE EXCEPTION 'PTO profile requires a CRM ID or email identity';
  END IF;

  PERFORM PG_ADVISORY_XACT_LOCK(
    HASHTEXTENDED(
      COALESCE(
        'bridge:' || p_bridge_profile_id,
        'email:' || v_email,
        v_local_provider || ':' || p_tutorid
      ),
      0
    )
  );

  IF p_bridge_profile_id IS NOT NULL THEN
    SELECT profile_id INTO v_bridge_profile
    FROM public.pto_profile_crm_ids
    WHERE provider = 'bridge' AND crm_id = p_bridge_profile_id::TEXT;
  END IF;

  IF v_email IS NOT NULL THEN
    SELECT profile_id INTO v_email_profile
    FROM public.pto_profile_emails
    WHERE email = v_email;
  END IF;

  IF p_tutorid IS NOT NULL THEN
    SELECT profile_id INTO v_local_profile
    FROM public.pto_profile_crm_ids
    WHERE provider = v_local_provider AND crm_id = p_tutorid::TEXT;
  END IF;

  v_profile_id := COALESCE(v_bridge_profile, v_email_profile, v_local_profile);
  IF (v_bridge_profile IS NOT NULL AND v_bridge_profile IS DISTINCT FROM v_profile_id)
    OR (v_email_profile IS NOT NULL AND v_email_profile IS DISTINCT FROM v_profile_id)
    OR (v_local_profile IS NOT NULL AND v_local_profile IS DISTINCT FROM v_profile_id) THEN
    RAISE EXCEPTION 'PTO identities belong to different profiles';
  END IF;

  IF v_profile_id IS NULL THEN
    INSERT INTO public.pto_profiles DEFAULT VALUES RETURNING id INTO v_profile_id;
  END IF;

  IF p_bridge_profile_id IS NOT NULL THEN
    INSERT INTO public.pto_profile_crm_ids (profile_id, provider, crm_id)
    VALUES (v_profile_id, 'bridge', p_bridge_profile_id::TEXT)
    ON CONFLICT (provider, crm_id) DO NOTHING;
    SELECT profile_id INTO v_attached_profile
    FROM public.pto_profile_crm_ids
    WHERE provider = 'bridge' AND crm_id = p_bridge_profile_id::TEXT;
    IF v_attached_profile IS DISTINCT FROM v_profile_id THEN
      RAISE EXCEPTION 'PTO identities belong to different profiles';
    END IF;
  END IF;

  IF v_email IS NOT NULL THEN
    INSERT INTO public.pto_profile_emails (profile_id, email)
    VALUES (v_profile_id, v_email)
    ON CONFLICT (email) DO NOTHING;
    SELECT profile_id INTO v_attached_profile
    FROM public.pto_profile_emails
    WHERE email = v_email;
    IF v_attached_profile IS DISTINCT FROM v_profile_id THEN
      RAISE EXCEPTION 'PTO identities belong to different profiles';
    END IF;
  END IF;

  IF p_tutorid IS NOT NULL THEN
    INSERT INTO public.pto_profile_crm_ids (profile_id, provider, crm_id)
    VALUES (v_profile_id, v_local_provider, p_tutorid::TEXT)
    ON CONFLICT (provider, crm_id) DO NOTHING;
    SELECT profile_id INTO v_attached_profile
    FROM public.pto_profile_crm_ids
    WHERE provider = v_local_provider AND crm_id = p_tutorid::TEXT;
    IF v_attached_profile IS DISTINCT FROM v_profile_id THEN
      RAISE EXCEPTION 'PTO identities belong to different profiles';
    END IF;
  END IF;

  INSERT INTO public.pto_profile_centers (profile_id, franchiseid)
  VALUES (v_profile_id, p_franchiseid)
  ON CONFLICT (profile_id, franchiseid) DO NOTHING;

  RETURN v_profile_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.pto_reserve_request(
  p_request_id BIGINT,
  p_franchiseid INTEGER,
  p_tutorid BIGINT,
  p_bridge_profile_id BIGINT,
  p_email TEXT,
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
  SELECT * INTO v_center
  FROM public.pto_center_settings
  WHERE franchiseid = p_franchiseid;

  IF NOT FOUND
    OR NOT v_center.enabled
    OR v_center.first_activated_at IS NULL
    OR p_created_at < v_center.first_activated_at THEN
    RETURN;
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.pto_request_allocations WHERE request_id = p_request_id
  ) THEN
    RETURN;
  END IF;

  v_profile_id := public.pto_resolve_profile(
    p_franchiseid,
    p_tutorid,
    p_bridge_profile_id,
    p_email
  );

  FOR v_day IN
    SELECT leave_date, charged_days
    FROM public.pto_request_day_charges(
      p_start_date,
      p_end_date,
      p_partial_day,
      p_duration_hours
    )
    WHERE charged_days > 0
  LOOP
    v_cycle_id := public.pto_get_or_create_cycle(v_profile_id, v_day.leave_date);
    INSERT INTO public.pto_request_allocations (
      request_id,
      cycle_id,
      charged_days,
      state
    )
    VALUES (p_request_id, v_cycle_id, v_day.charged_days, 'reserved')
    ON CONFLICT (request_id, cycle_id)
    DO UPDATE SET
      charged_days = public.pto_request_allocations.charged_days + EXCLUDED.charged_days,
      updated_at = NOW();
  END LOOP;

  FOR v_allocation IN
    SELECT allocation.*, cycle.profile_id
    FROM public.pto_request_allocations AS allocation
    JOIN public.pto_entitlement_cycles AS cycle ON cycle.id = allocation.cycle_id
    WHERE allocation.request_id = p_request_id
    ORDER BY allocation.cycle_id
  LOOP
    SELECT COALESCE(SUM(balance_delta - reserved_delta), 0)
    INTO v_available
    FROM public.pto_ledger_entries
    WHERE cycle_id = v_allocation.cycle_id;

    IF v_available < v_allocation.charged_days THEN
      RAISE EXCEPTION 'Insufficient shared PTO balance for cycle %', v_allocation.cycle_id;
    END IF;

    INSERT INTO public.pto_ledger_entries (
      profile_id,
      cycle_id,
      request_id,
      allocation_id,
      event_type,
      balance_delta,
      reserved_delta,
      idempotency_key
    )
    VALUES (
      v_allocation.profile_id,
      v_allocation.cycle_id,
      p_request_id,
      v_allocation.id,
      'reserve',
      0,
      v_allocation.charged_days,
      'reserve:' || p_request_id || ':' || v_allocation.cycle_id
    )
    ON CONFLICT (idempotency_key) DO NOTHING;
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
BEGIN
  IF p_new_status NOT IN ('approved', 'denied', 'cancelled') THEN
    RETURN;
  END IF;

  FOR v_allocation IN
    SELECT allocation.*, cycle.profile_id
    FROM public.pto_request_allocations AS allocation
    JOIN public.pto_entitlement_cycles AS cycle ON cycle.id = allocation.cycle_id
    WHERE allocation.request_id = p_request_id
    ORDER BY allocation.cycle_id
    FOR UPDATE OF allocation
  LOOP
    PERFORM 1
    FROM public.pto_profiles
    WHERE id = v_allocation.profile_id
    FOR UPDATE;

    IF p_new_status = 'approved' AND v_allocation.state = 'reserved' THEN
      INSERT INTO public.pto_ledger_entries (
        profile_id,
        cycle_id,
        request_id,
        allocation_id,
        event_type,
        balance_delta,
        reserved_delta,
        idempotency_key
      )
      VALUES (
        v_allocation.profile_id,
        v_allocation.cycle_id,
        p_request_id,
        v_allocation.id,
        'consume',
        -v_allocation.charged_days,
        -v_allocation.charged_days,
        'consume:' || p_request_id || ':' || v_allocation.cycle_id
      )
      ON CONFLICT (idempotency_key) DO NOTHING;

      UPDATE public.pto_request_allocations
      SET state = 'consumed', updated_at = NOW()
      WHERE id = v_allocation.id;
    ELSIF p_new_status IN ('denied', 'cancelled')
      AND v_allocation.state IN ('reserved', 'consumed') THEN
      INSERT INTO public.pto_ledger_entries (
        profile_id,
        cycle_id,
        request_id,
        allocation_id,
        event_type,
        balance_delta,
        reserved_delta,
        idempotency_key
      )
      VALUES (
        v_allocation.profile_id,
        v_allocation.cycle_id,
        p_request_id,
        v_allocation.id,
        'release',
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
      NEW.created_at,
      v_start_date,
      v_end_date,
      COALESCE(NEW.partial_day, FALSE),
      NEW.duration_hours
    );
  ELSIF TG_OP = 'UPDATE' AND NEW.status IS DISTINCT FROM OLD.status THEN
    PERFORM public.pto_transition_request(NEW.id, NEW.status);
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pto_time_off_request_lifecycle ON public.time_off_requests;
CREATE TRIGGER pto_time_off_request_lifecycle
AFTER INSERT OR UPDATE OF status ON public.time_off_requests
FOR EACH ROW
EXECUTE FUNCTION public.pto_handle_time_off_request();

CREATE OR REPLACE FUNCTION public.pto_protect_held_request()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.pto_request_allocations
    WHERE request_id = OLD.id
  ) AND (
    NEW.franchiseid IS DISTINCT FROM OLD.franchiseid
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
    OR (NEW.public_metadata ->> 'endDate') IS DISTINCT FROM (OLD.public_metadata ->> 'endDate')
  ) THEN
    RAISE EXCEPTION 'Held PTO identity/date/type fields cannot be changed';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pto_time_off_request_held_fields ON public.time_off_requests;
CREATE TRIGGER pto_time_off_request_held_fields
BEFORE UPDATE ON public.time_off_requests
FOR EACH ROW
EXECUTE FUNCTION public.pto_protect_held_request();

CREATE OR REPLACE FUNCTION public.pto_reject_ledger_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'PTO ledger entries are append-only';
END;
$$;

DROP TRIGGER IF EXISTS pto_ledger_append_only ON public.pto_ledger_entries;
CREATE TRIGGER pto_ledger_append_only
BEFORE UPDATE OR DELETE ON public.pto_ledger_entries
FOR EACH ROW
EXECUTE FUNCTION public.pto_reject_ledger_mutation();
