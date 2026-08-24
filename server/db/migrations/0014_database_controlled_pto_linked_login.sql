CREATE OR REPLACE FUNCTION public.pto_authenticated_linked_profile(
  p_franchiseid INTEGER,
  p_tutorid BIGINT
)
RETURNS BIGINT
LANGUAGE sql
STABLE
AS $$
  WITH matches AS (
    SELECT DISTINCT public.pto_canonical_profile_id(decision.profile_id) AS profile_id
    FROM public.pto_discovered_tutor_accounts account
    JOIN public.pto_profile_link_decisions decision
      ON decision.account_id = account.id
     AND decision.status = 'linked'
    JOIN public.pto_profiles profile
      ON profile.id = public.pto_canonical_profile_id(decision.profile_id)
     AND profile.active
    JOIN public.pto_profile_crm_ids crm
      ON crm.provider = account.provider
     AND crm.crm_id = account.crm_id
     AND public.pto_canonical_profile_id(crm.profile_id)
       = public.pto_canonical_profile_id(decision.profile_id)
    WHERE account.franchiseid = p_franchiseid
      AND account.tutor_id = p_tutorid
      AND account.provider = 'timecard-center:' || p_franchiseid::TEXT
      AND account.crm_id = p_tutorid::TEXT
      AND account.crm_active
      AND EXISTS (
        SELECT 1
        FROM public.pto_profile_centers sponsor
        JOIN public.pto_center_settings settings
          ON settings.franchiseid = sponsor.franchiseid
         AND settings.enabled
        WHERE sponsor.active
          AND public.pto_canonical_profile_id(sponsor.profile_id)
            = public.pto_canonical_profile_id(decision.profile_id)
      )
  )
  SELECT CASE WHEN COUNT(*) = 1 THEN MIN(profile_id) END
  FROM matches;
$$;

CREATE OR REPLACE FUNCTION public.pto_reject_disabled_request()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_enabled BOOLEAN;
  v_profile_id BIGINT;
  v_source TEXT := COALESCE(NEW.public_metadata ->> 'source', 'authenticated_timecard_app');
BEGIN
  IF NEW.type <> 'pto' THEN RETURN NEW; END IF;

  IF v_source = 'public_timeoff_form' THEN
    SELECT enabled INTO v_enabled
    FROM public.pto_center_settings
    WHERE franchiseid = NEW.franchiseid;
    IF NOT COALESCE(v_enabled, FALSE) THEN
      RAISE EXCEPTION USING MESSAGE = 'PTO_CENTER_DISABLED', ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;

  v_profile_id := public.pto_authenticated_linked_profile(NEW.franchiseid, NEW.tutorid);
  IF v_profile_id IS NOT NULL THEN RETURN NEW; END IF;

  SELECT enabled INTO v_enabled
  FROM public.pto_center_settings
  WHERE franchiseid = NEW.franchiseid;
  IF COALESCE(v_enabled, FALSE) THEN
    RAISE EXCEPTION USING MESSAGE = 'PTO_IDENTITY_UNRESOLVED', ERRCODE = 'P0001';
  END IF;
  RAISE EXCEPTION USING MESSAGE = 'PTO_CENTER_DISABLED', ERRCODE = 'P0001';
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
  v_profile_id := public.pto_canonical_profile_id(v_profile_id);

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
