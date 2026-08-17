ALTER TABLE public.pto_center_settings
  ADD COLUMN IF NOT EXISTS last_successful_sync_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_sync_error TEXT;

ALTER TABLE public.pto_profile_centers
  ADD COLUMN IF NOT EXISTS id BIGSERIAL,
  ADD COLUMN IF NOT EXISTS tutor_id BIGINT,
  ADD COLUMN IF NOT EXISTS active BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS crm_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
  ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

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
    WHERE profile_id = p_profile_id
      AND franchiseid = p_actor_franchiseid
      AND active
  ) THEN
    RAISE EXCEPTION 'Actor center is not authorized for PTO profile %', p_profile_id;
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.pto_profile_balance(
  p_profile_id BIGINT,
  p_balance_date DATE
)
RETURNS TABLE (available_days NUMERIC, grant_count BIGINT)
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
      COALESCE(SUM(ledger.balance_delta - ledger.reserved_delta)
        FILTER (WHERE ledger.event_type <> 'grant'), 0) AS activity,
      COUNT(DISTINCT cycle.starts_on) FILTER (WHERE cycle.id IS NOT NULL) AS grants
    FROM relevant_cycles cycle
    LEFT JOIN public.pto_ledger_entries ledger ON ledger.cycle_id = cycle.id
  )
  SELECT one_grant + activity, CASE WHEN grants > 0 THEN 1 ELSE 0 END FROM amounts;
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

  IF v_candidate.status <> 'pending' THEN
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
    VALUES (v_target_id, p_actor_franchiseid, p_actor_id, 'alias_rejected',
      JSONB_BUILD_OBJECT('status', 'pending', 'candidateId', p_candidate_id),
      JSONB_BUILD_OBJECT('status', 'rejected', 'candidateId', p_candidate_id),
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
    VALUES (v_target_id, p_actor_franchiseid, p_actor_id, 'alias_confirmed',
      JSONB_BUILD_OBJECT('candidateId', p_candidate_id),
      JSONB_BUILD_OBJECT('canonicalProfileId', v_target_id, 'alreadyCanonical', TRUE),
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
  VALUES (v_target_id, p_actor_franchiseid, p_actor_id, 'alias_confirmed',
    JSONB_BUILD_OBJECT('sourceProfileId', v_source_id, 'targetProfileId', v_target_id),
    JSONB_BUILD_OBJECT('canonicalProfileId', v_target_id),
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
BEGIN
  SELECT * INTO v_membership FROM public.pto_profile_centers
  WHERE id = p_membership_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'PTO membership % does not exist', p_membership_id; END IF;

  IF v_membership.profile_id <> p_profile_id THEN
    SELECT (after_state ->> 'detachedProfileId')::BIGINT INTO v_new_profile_id
    FROM public.pto_audit_events
    WHERE idempotency_key = 'membership-detach:' || p_membership_id;
    IF v_new_profile_id IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM public.pto_profile_centers
        WHERE profile_id IN (p_profile_id, v_new_profile_id)
          AND franchiseid = p_actor_franchiseid
          AND active
      ) THEN
        RAISE EXCEPTION 'Actor center is not authorized for PTO membership %', p_membership_id;
      END IF;
      RETURN v_new_profile_id;
    END IF;
    RAISE EXCEPTION 'PTO membership does not belong to profile %', p_profile_id;
  END IF;
  PERFORM public.pto_assert_profile_admin(p_profile_id, p_actor_franchiseid);
  SELECT * INTO v_profile FROM public.pto_profiles WHERE id = p_profile_id FOR UPDATE;

  INSERT INTO public.pto_profiles (first_name, last_name, identity_status, active)
  VALUES (v_profile.first_name, v_profile.last_name, 'confirmed', TRUE)
  RETURNING id INTO v_new_profile_id;
  UPDATE public.pto_profile_centers SET profile_id = v_new_profile_id, updated_at = NOW()
  WHERE id = p_membership_id;
  UPDATE public.pto_profile_emails SET profile_id = v_new_profile_id, updated_at = NOW()
  WHERE source_membership_id = p_membership_id;

  FOR v_allocation IN
    SELECT allocation.*, cycle.starts_on
    FROM public.pto_request_allocations allocation
    JOIN public.pto_entitlement_cycles cycle ON cycle.id = allocation.cycle_id
    JOIN public.time_off_requests request ON request.id = allocation.request_id
    WHERE cycle.profile_id = p_profile_id
      AND request.franchiseid = v_membership.franchiseid
    ORDER BY allocation.id
    FOR UPDATE OF allocation
  LOOP
    v_new_cycle_id := public.pto_get_or_create_cycle(v_new_profile_id, v_allocation.starts_on);
    IF v_allocation.state = 'reserved' THEN
      INSERT INTO public.pto_ledger_entries
        (profile_id, cycle_id, request_id, allocation_id, event_type, reserved_delta, idempotency_key, metadata)
      VALUES (p_profile_id, v_allocation.cycle_id, v_allocation.request_id, v_allocation.id,
        'release', -v_allocation.charged_days, 'split-release:' || p_membership_id || ':' || v_allocation.id,
        JSONB_BUILD_OBJECT('detachedProfileId', v_new_profile_id));
    ELSIF v_allocation.state = 'consumed' THEN
      INSERT INTO public.pto_ledger_entries
        (profile_id, cycle_id, request_id, allocation_id, event_type, balance_delta, idempotency_key, metadata)
      VALUES (p_profile_id, v_allocation.cycle_id, v_allocation.request_id, v_allocation.id,
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
        JSONB_BUILD_OBJECT('sourceProfileId', p_profile_id));
    ELSIF v_allocation.state = 'consumed' THEN
      INSERT INTO public.pto_ledger_entries
        (profile_id, cycle_id, request_id, allocation_id, event_type, balance_delta, idempotency_key, metadata)
      VALUES (v_new_profile_id, v_new_cycle_id, v_allocation.request_id, v_allocation.id,
        'consume', -v_allocation.charged_days, 'split-consume:' || p_membership_id || ':' || v_allocation.id,
        JSONB_BUILD_OBJECT('sourceProfileId', p_profile_id));
    END IF;
  END LOOP;

  PERFORM public.pto_get_or_create_cycle(v_new_profile_id, CURRENT_DATE);
  INSERT INTO public.pto_audit_events
    (profile_id, franchiseid, actor_id, event_type, before_state, after_state, idempotency_key)
  VALUES (p_profile_id, v_membership.franchiseid, p_actor_id, 'membership_detached',
    JSONB_BUILD_OBJECT('profileId', p_profile_id, 'membershipId', p_membership_id),
    JSONB_BUILD_OBJECT('detachedProfileId', v_new_profile_id, 'membershipId', p_membership_id),
    'membership-detach:' || p_membership_id);
  RETURN v_new_profile_id;
END;
$$;
