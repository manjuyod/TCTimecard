ALTER TABLE public.pto_center_settings
  ADD COLUMN IF NOT EXISTS last_successful_sync_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_sync_error TEXT;

ALTER TABLE public.pto_profile_centers
  ADD COLUMN IF NOT EXISTS id BIGSERIAL,
  ADD COLUMN IF NOT EXISTS tutor_id BIGINT,
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS crm_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

UPDATE public.pto_profile_centers AS center
SET tutor_id = (
  SELECT MIN(crm.crm_id::BIGINT)
  FROM public.pto_profile_crm_ids AS crm
  WHERE crm.profile_id = center.profile_id
    AND crm.provider = 'timecard-center:' || center.franchiseid
    AND crm.crm_id ~ '^[0-9]+$'
)
WHERE center.tutor_id IS NULL
  AND 1 = (
    SELECT COUNT(*)
    FROM public.pto_profile_crm_ids AS crm
    WHERE crm.profile_id = center.profile_id
      AND crm.provider = 'timecard-center:' || center.franchiseid
      AND crm.crm_id ~ '^[0-9]+$'
  );

CREATE UNIQUE INDEX IF NOT EXISTS pto_profile_centers_id_idx
  ON public.pto_profile_centers (id);
CREATE UNIQUE INDEX IF NOT EXISTS pto_profile_centers_franchise_tutor_idx
  ON public.pto_profile_centers (franchiseid, tutor_id)
  WHERE tutor_id IS NOT NULL;

ALTER TABLE public.pto_profile_emails
  ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'crm'
    CHECK (source IN ('crm', 'manual')),
  ADD COLUMN IF NOT EXISTS source_membership_id BIGINT,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

ALTER TABLE public.pto_profile_emails
  DROP CONSTRAINT IF EXISTS pto_profile_emails_profile_id_franchiseid_email_key;
CREATE UNIQUE INDEX IF NOT EXISTS pto_profile_emails_profile_center_email_source_idx
  ON public.pto_profile_emails (profile_id, franchiseid, email, source);

UPDATE public.pto_profile_emails AS email
SET source_membership_id = center.id
FROM public.pto_profile_centers AS center
WHERE email.source_membership_id IS NULL
  AND email.profile_id = center.profile_id
  AND email.franchiseid = center.franchiseid;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'pto_profile_emails_source_membership_fk'
  ) THEN
    ALTER TABLE public.pto_profile_emails
      ADD CONSTRAINT pto_profile_emails_source_membership_fk
      FOREIGN KEY (source_membership_id) REFERENCES public.pto_profile_centers(id);
  END IF;
END;
$$;

ALTER TABLE public.pto_profile_match_candidates
  ADD COLUMN IF NOT EXISTS decided_by TEXT,
  ADD COLUMN IF NOT EXISTS decided_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS public.pto_profile_aliases (
  source_profile_id BIGINT PRIMARY KEY REFERENCES public.pto_profiles(id),
  target_profile_id BIGINT NOT NULL REFERENCES public.pto_profiles(id),
  candidate_id BIGINT NOT NULL UNIQUE REFERENCES public.pto_profile_match_candidates(id),
  merged_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (source_profile_id <> target_profile_id)
);

CREATE TABLE IF NOT EXISTS public.pto_audit_events (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT REFERENCES public.pto_profiles(id),
  franchiseid INTEGER,
  actor_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  before_state JSONB,
  after_state JSONB,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS pto_audit_events_center_created_idx
  ON public.pto_audit_events (franchiseid, created_at DESC, id DESC);
CREATE INDEX IF NOT EXISTS pto_audit_events_profile_created_idx
  ON public.pto_audit_events (profile_id, created_at DESC, id DESC);

CREATE OR REPLACE FUNCTION public.pto_reject_audit_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'PTO audit events are append-only';
END;
$$;

DROP TRIGGER IF EXISTS pto_audit_append_only ON public.pto_audit_events;
CREATE TRIGGER pto_audit_append_only
BEFORE UPDATE OR DELETE ON public.pto_audit_events
FOR EACH ROW EXECUTE FUNCTION public.pto_reject_audit_mutation();

CREATE OR REPLACE FUNCTION public.pto_canonical_profile_id(p_profile_id BIGINT)
RETURNS BIGINT
LANGUAGE SQL
STABLE
STRICT
AS $$
  WITH RECURSIVE chain(profile_id, visited) AS (
    SELECT p_profile_id, ARRAY[p_profile_id]
    UNION ALL
    SELECT alias.target_profile_id, chain.visited || alias.target_profile_id
    FROM chain
    JOIN public.pto_profile_aliases alias ON alias.source_profile_id = chain.profile_id
    WHERE NOT alias.target_profile_id = ANY(chain.visited)
  )
  SELECT profile_id FROM chain ORDER BY CARDINALITY(visited) DESC LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION public.pto_assert_profile_admin(
  p_profile_id BIGINT,
  p_actor_franchiseid INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.pto_profile_centers
    WHERE public.pto_canonical_profile_id(profile_id)
        = public.pto_canonical_profile_id(p_profile_id)
      AND franchiseid = p_actor_franchiseid
      AND active
  ) THEN
    RAISE EXCEPTION 'Actor center is not authorized for PTO profile %', p_profile_id;
  END IF;
END;
$$;

DROP FUNCTION IF EXISTS public.pto_profile_balance(BIGINT, DATE);
CREATE FUNCTION public.pto_profile_balance(
  p_profile_id BIGINT,
  p_balance_date DATE
)
RETURNS TABLE (
  granted_days NUMERIC,
  balance_days NUMERIC,
  reserved_days NUMERIC,
  available_days NUMERIC,
  grant_count BIGINT
)
LANGUAGE SQL
STABLE
AS $$
  WITH RECURSIVE canonical AS (
    SELECT public.pto_canonical_profile_id(p_profile_id) AS profile_id
  ),
  members AS (
    SELECT profile_id FROM canonical
    UNION ALL
    SELECT alias.source_profile_id
    FROM public.pto_profile_aliases alias
    JOIN members ON alias.target_profile_id = members.profile_id
  ),
  applicable_policy AS (
    SELECT * FROM public.pto_policies
    WHERE effective_from <= p_balance_date
    ORDER BY effective_from DESC LIMIT 1
  ),
  relevant_cycles AS (
    SELECT cycle.*
    FROM public.pto_entitlement_cycles cycle
    JOIN members ON members.profile_id = cycle.profile_id
    CROSS JOIN applicable_policy policy
    WHERE cycle.starts_on = public.pto_cycle_start(
      p_balance_date, policy.renewal_month, policy.renewal_day
    )
  ),
  amounts AS (
    SELECT
      COALESCE(MAX(cycle.entitlement_days), 0) AS one_grant,
      COALESCE(SUM(ledger.balance_delta)
        FILTER (WHERE ledger.event_type <> 'grant'), 0) AS balance_activity,
      COALESCE(SUM(ledger.reserved_delta)
        FILTER (WHERE ledger.event_type <> 'grant'), 0) AS reserved_activity,
      COUNT(DISTINCT cycle.starts_on) FILTER (WHERE cycle.id IS NOT NULL) AS grants
    FROM relevant_cycles cycle
    LEFT JOIN public.pto_ledger_entries ledger ON ledger.cycle_id = cycle.id
  )
  SELECT
    one_grant,
    one_grant + balance_activity,
    reserved_activity,
    one_grant + balance_activity - reserved_activity,
    CASE WHEN grants > 0 THEN 1 ELSE 0 END
  FROM amounts;
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
BEGIN
  IF p_decision NOT IN ('confirm', 'reject') THEN
    RAISE EXCEPTION 'Unsupported PTO alias decision %', p_decision;
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

CREATE OR REPLACE FUNCTION public.pto_resolve_profile(
  p_franchiseid INTEGER,
  p_tutorid BIGINT,
  p_bridge_profile_id BIGINT,
  p_email TEXT,
  p_request_source TEXT,
  p_first_name TEXT,
  p_last_name TEXT
)
RETURNS BIGINT
LANGUAGE plpgsql
AS $$
DECLARE
  v_email TEXT := NULLIF(LOWER(BTRIM(p_email)), '');
  v_first_name TEXT := NULLIF(BTRIM(p_first_name), '');
  v_last_name TEXT := NULLIF(BTRIM(p_last_name), '');
  v_bridge_profile BIGINT;
  v_local_profile BIGINT;
  v_profile_id BIGINT;
  v_attached_profile BIGINT;
  v_membership_id BIGINT;
  v_membership_profile_id BIGINT;
  v_public_match_count INTEGER;
  v_identity_status TEXT;
  v_local_provider TEXT := 'timecard-center:' || p_franchiseid;
BEGIN
  IF p_request_source = 'public' THEN
    IF v_email IS NULL THEN
      RAISE EXCEPTION 'Public PTO identity must resolve exactly one active profile';
    END IF;

    SELECT
      COUNT(DISTINCT public.pto_canonical_profile_id(email.profile_id)),
      MIN(public.pto_canonical_profile_id(email.profile_id))
    INTO v_public_match_count, v_profile_id
    FROM public.pto_profile_emails AS email
    JOIN public.pto_profiles AS profile ON profile.id = email.profile_id
    JOIN public.pto_profile_centers AS center
      ON center.franchiseid = email.franchiseid
      AND (
        center.id = email.source_membership_id
        OR (email.source_membership_id IS NULL AND center.profile_id = email.profile_id)
      )
    WHERE email.franchiseid = p_franchiseid
      AND email.email = v_email
      AND email.active
      AND center.active
      AND public.pto_canonical_profile_id(profile.id) IN (
        SELECT public.pto_canonical_profile_id(active_profile.id)
        FROM public.pto_profiles active_profile WHERE active_profile.active
      );

    IF v_public_match_count <> 1 THEN
      RAISE EXCEPTION 'Public PTO identity must resolve exactly one active profile';
    END IF;
    RETURN v_profile_id;
  ELSIF p_request_source <> 'authenticated' THEN
    RAISE EXCEPTION 'Unsupported PTO request source %', p_request_source;
  END IF;

  IF p_bridge_profile_id IS NULL AND p_tutorid IS NULL THEN
    RAISE EXCEPTION 'Authenticated PTO profile requires a CRM identity';
  END IF;
  IF v_first_name IS NULL OR v_last_name IS NULL THEN
    RAISE EXCEPTION 'Authenticated PTO profile requires exact first and last names';
  END IF;

  PERFORM PG_ADVISORY_XACT_LOCK(HASHTEXTEXTENDED(
    'pto-exact-name:' || LOWER(v_first_name) || ':' || LOWER(v_last_name), 0
  ));
  PERFORM PG_ADVISORY_XACT_LOCK(HASHTEXTEXTENDED(
    COALESCE('bridge:' || p_bridge_profile_id, v_local_provider || ':' || p_tutorid), 0
  ));

  IF p_bridge_profile_id IS NOT NULL THEN
    SELECT public.pto_canonical_profile_id(profile_id) INTO v_bridge_profile
    FROM public.pto_profile_crm_ids
    WHERE provider = 'bridge' AND crm_id = p_bridge_profile_id::TEXT;
  END IF;
  IF p_tutorid IS NOT NULL THEN
    SELECT public.pto_canonical_profile_id(profile_id) INTO v_local_profile
    FROM public.pto_profile_crm_ids
    WHERE provider = v_local_provider AND crm_id = p_tutorid::TEXT;
  END IF;

  v_profile_id := COALESCE(v_bridge_profile, v_local_profile);
  IF (v_bridge_profile IS NOT NULL AND v_bridge_profile IS DISTINCT FROM v_profile_id)
    OR (v_local_profile IS NOT NULL AND v_local_profile IS DISTINCT FROM v_profile_id) THEN
    RAISE EXCEPTION 'PTO identities belong to different profiles';
  END IF;

  IF v_profile_id IS NULL THEN
    INSERT INTO public.pto_profiles (first_name, last_name, identity_status)
    VALUES (v_first_name, v_last_name,
      CASE WHEN p_bridge_profile_id IS NULL THEN 'pending' ELSE 'confirmed' END)
    RETURNING id INTO v_profile_id;
  ELSE
    UPDATE public.pto_profiles
    SET first_name = v_first_name,
        last_name = v_last_name,
        identity_status = CASE WHEN p_bridge_profile_id IS NULL THEN identity_status ELSE 'confirmed' END
    WHERE id = v_profile_id;
  END IF;

  IF p_bridge_profile_id IS NOT NULL THEN
    INSERT INTO public.pto_profile_crm_ids (profile_id, provider, crm_id)
    VALUES (v_profile_id, 'bridge', p_bridge_profile_id::TEXT)
    ON CONFLICT (provider, crm_id) DO NOTHING;
    SELECT public.pto_canonical_profile_id(profile_id) INTO v_attached_profile
    FROM public.pto_profile_crm_ids
    WHERE provider = 'bridge' AND crm_id = p_bridge_profile_id::TEXT;
    IF v_attached_profile IS DISTINCT FROM v_profile_id THEN
      RAISE EXCEPTION 'PTO identities belong to different profiles';
    END IF;
  END IF;

  IF p_tutorid IS NOT NULL THEN
    INSERT INTO public.pto_profile_crm_ids (profile_id, provider, crm_id)
    VALUES (v_profile_id, v_local_provider, p_tutorid::TEXT)
    ON CONFLICT (provider, crm_id) DO NOTHING;
    SELECT public.pto_canonical_profile_id(profile_id) INTO v_attached_profile
    FROM public.pto_profile_crm_ids
    WHERE provider = v_local_provider AND crm_id = p_tutorid::TEXT;
    IF v_attached_profile IS DISTINCT FROM v_profile_id THEN
      RAISE EXCEPTION 'PTO identities belong to different profiles';
    END IF;

    SELECT id, profile_id INTO v_membership_id, v_membership_profile_id
    FROM public.pto_profile_centers
    WHERE franchiseid = p_franchiseid AND tutor_id = p_tutorid
    FOR UPDATE;
  END IF;

  IF v_membership_id IS NULL THEN
    SELECT id, profile_id INTO v_membership_id, v_membership_profile_id
    FROM public.pto_profile_centers
    WHERE franchiseid = p_franchiseid
      AND public.pto_canonical_profile_id(profile_id) = v_profile_id
    ORDER BY id LIMIT 1 FOR UPDATE;
  END IF;

  IF v_membership_id IS NULL THEN
    INSERT INTO public.pto_profile_centers (profile_id, franchiseid, tutor_id, active)
    VALUES (v_profile_id, p_franchiseid, p_tutorid, TRUE)
    RETURNING id, profile_id INTO v_membership_id, v_membership_profile_id;
  ELSE
    IF public.pto_canonical_profile_id(v_membership_profile_id) IS DISTINCT FROM v_profile_id THEN
      RAISE EXCEPTION 'PTO membership belongs to a different profile';
    END IF;
    UPDATE public.pto_profile_centers SET active = TRUE, updated_at = NOW()
    WHERE id = v_membership_id;
  END IF;

  IF v_email IS NOT NULL THEN
    INSERT INTO public.pto_profile_emails
      (profile_id, franchiseid, email, active, source, source_membership_id)
    VALUES (v_membership_profile_id, p_franchiseid, v_email, TRUE, 'crm', v_membership_id)
    ON CONFLICT (profile_id, franchiseid, email, source)
    DO UPDATE SET active = TRUE, source_membership_id = EXCLUDED.source_membership_id, updated_at = NOW();
  END IF;

  SELECT identity_status INTO v_identity_status
  FROM public.pto_profiles WHERE id = v_profile_id;
  INSERT INTO public.pto_profile_match_candidates (left_profile_id, right_profile_id)
  SELECT LEAST(v_profile_id, candidate.id), GREATEST(v_profile_id, candidate.id)
  FROM public.pto_profiles AS candidate
  WHERE candidate.id <> v_profile_id
    AND candidate.active
    AND public.pto_canonical_profile_id(candidate.id) <> v_profile_id
    AND (v_identity_status = 'pending' OR candidate.identity_status = 'pending')
    AND candidate.normalized_first_name = LOWER(v_first_name)
    AND candidate.normalized_last_name = LOWER(v_last_name)
  ON CONFLICT (left_profile_id, right_profile_id) DO NOTHING;

  RETURN v_profile_id;
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
  SELECT * INTO v_center FROM public.pto_center_settings WHERE franchiseid = p_franchiseid;
  IF NOT FOUND OR NOT v_center.enabled OR v_center.first_activated_at IS NULL
    OR p_created_at < v_center.first_activated_at THEN
    RETURN;
  END IF;

  PERFORM 1 FROM public.time_off_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PTO request % does not exist', p_request_id; END IF;
  IF EXISTS (SELECT 1 FROM public.pto_request_allocations WHERE request_id = p_request_id) THEN RETURN; END IF;

  v_profile_id := public.pto_resolve_profile(
    p_franchiseid, p_tutorid, p_bridge_profile_id, p_email, p_request_source,
    p_first_name, p_last_name
  );
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
