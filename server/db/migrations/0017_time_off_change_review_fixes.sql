-- Preserve the deployed audit allow-list and admit the approved-change actions.
-- The shared time-off tables predate the migration chain in this repository.
DO $$
DECLARE
  v_check TEXT;
BEGIN
  SELECT pg_get_expr(conbin, conrelid) INTO v_check
  FROM pg_constraint
  WHERE conrelid = 'public.time_off_audit'::REGCLASS
    AND conname = 'time_off_audit_action_check' AND contype = 'c';
  IF v_check IS NOT NULL THEN
    ALTER TABLE public.time_off_audit DROP CONSTRAINT time_off_audit_action_check;
    EXECUTE FORMAT('ALTER TABLE public.time_off_audit ADD CONSTRAINT time_off_audit_action_check CHECK ((%s) OR action IN (%L,%L,%L,%L,%L,%L,%L))',
      v_check, 'change_proposed', 'change_withdrawn', 'change_approved', 'change_denied',
      'approved_edited', 'approved_cancelled', 'change_expired');
  END IF;
END;
$$;

-- Match the application mapper's center-local dates for legacy rows which have
-- no normalized dates. UTC dates can move evening leave into another weekday.
CREATE OR REPLACE FUNCTION public.pto_request_charge_shape(p_row JSONB)
RETURNS JSONB
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  v_timezone TEXT := 'America/Los_Angeles';
  v_start TIMESTAMP;
  v_end TIMESTAMP;
  v_partial BOOLEAN;
BEGIN
  IF p_row IS NULL THEN RETURN NULL; END IF;
  IF TO_REGCLASS('public.franchise_payroll_settings') IS NOT NULL THEN
    EXECUTE 'SELECT timezone FROM public.franchise_payroll_settings WHERE franchiseid = $1'
      INTO v_timezone USING (p_row ->> 'franchiseid')::INTEGER;
  END IF;
  IF v_timezone IS NULL OR NOT EXISTS (SELECT 1 FROM pg_timezone_names WHERE name = v_timezone) THEN
    v_timezone := 'America/Los_Angeles';
  END IF;
  v_start := (p_row ->> 'start_at')::TIMESTAMPTZ AT TIME ZONE v_timezone;
  v_end := (p_row ->> 'end_at')::TIMESTAMPTZ AT TIME ZONE v_timezone;
  v_partial := COALESCE((p_row ->> 'partial_day')::BOOLEAN, FALSE)
    OR (NULLIF(p_row -> 'public_metadata' ->> 'startDate', '') IS NULL
      AND (v_start::TIME <> TIME '00:00' OR v_end::TIME <> TIME '00:00'));
  RETURN JSONB_BUILD_OBJECT(
    'type', p_row ->> 'type',
    'startDate', COALESCE(NULLIF(p_row -> 'public_metadata' ->> 'startDate', ''),
      (v_start::DATE)::TEXT),
    'endDate', COALESCE(NULLIF(p_row -> 'public_metadata' ->> 'endDate', ''),
      (v_end::DATE - CASE WHEN v_partial THEN 0 ELSE 1 END)::TEXT),
    'partialDay', v_partial,
    'durationHours', p_row -> 'duration_hours'
  );
END;
$$;
