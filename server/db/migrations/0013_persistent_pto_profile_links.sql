ALTER TABLE public.pto_center_settings
  ADD COLUMN IF NOT EXISTS last_successful_roster_sync_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_roster_sync_error TEXT,
  ADD COLUMN IF NOT EXISTS last_successful_discovery_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_discovery_error TEXT;

UPDATE public.pto_center_settings
SET last_successful_roster_sync_at = COALESCE(last_successful_roster_sync_at, last_successful_sync_at),
    last_roster_sync_error = COALESCE(last_roster_sync_error, last_sync_error);

CREATE TABLE IF NOT EXISTS public.pto_discovered_tutor_accounts (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  crm_id TEXT NOT NULL,
  franchiseid INTEGER NOT NULL,
  tutor_id BIGINT NOT NULL,
  normalized_first_name TEXT NOT NULL,
  normalized_last_name TEXT NOT NULL,
  crm_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
  crm_active BOOLEAN NOT NULL DEFAULT TRUE,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, crm_id),
  UNIQUE (franchiseid, tutor_id)
);

CREATE INDEX IF NOT EXISTS pto_discovered_tutor_accounts_name_idx
  ON public.pto_discovered_tutor_accounts (normalized_first_name, normalized_last_name);

CREATE TABLE IF NOT EXISTS public.pto_profile_link_decisions (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL REFERENCES public.pto_profiles(id),
  account_id BIGINT NOT NULL REFERENCES public.pto_discovered_tutor_accounts(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'linked', 'excluded')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  decided_by TEXT,
  decision_franchiseid INTEGER,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (profile_id, account_id)
);

CREATE INDEX IF NOT EXISTS pto_profile_link_decisions_profile_status_idx
  ON public.pto_profile_link_decisions (profile_id, status, account_id);
CREATE INDEX IF NOT EXISTS pto_profile_link_decisions_account_status_idx
  ON public.pto_profile_link_decisions (account_id, status, profile_id);
CREATE UNIQUE INDEX IF NOT EXISTS pto_profile_link_decisions_linked_account_idx
  ON public.pto_profile_link_decisions (account_id)
  WHERE status = 'linked';

ALTER TABLE public.pto_ledger_entries
  ADD COLUMN IF NOT EXISTS source_membership_id BIGINT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'pto_ledger_entries_source_membership_fk'
      AND conrelid = 'public.pto_ledger_entries'::REGCLASS
  ) THEN
    ALTER TABLE public.pto_ledger_entries
      ADD CONSTRAINT pto_ledger_entries_source_membership_fk
      FOREIGN KEY (source_membership_id) REFERENCES public.pto_profile_centers(id);
  END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS pto_ledger_entries_source_membership_idx
  ON public.pto_ledger_entries (source_membership_id, created_at)
  WHERE source_membership_id IS NOT NULL;

CREATE OR REPLACE FUNCTION public.pto_assert_link_admin(
  p_profile_id BIGINT,
  p_account_id BIGINT,
  p_actor_franchiseid INTEGER
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  v_profile_id BIGINT := public.pto_canonical_profile_id(p_profile_id);
  v_account_franchiseid INTEGER;
BEGIN
  SELECT franchiseid INTO v_account_franchiseid
  FROM public.pto_discovered_tutor_accounts
  WHERE id = p_account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'PTO_DISCOVERY_STALE: account % does not exist', p_account_id;
  END IF;

  IF p_actor_franchiseid <> v_account_franchiseid
    AND NOT EXISTS (
      SELECT 1 FROM public.pto_profile_centers center
      WHERE public.pto_canonical_profile_id(center.profile_id) = v_profile_id
        AND center.franchiseid = p_actor_franchiseid
        AND center.active
    ) THEN
    RAISE EXCEPTION 'PTO_LINK_FORBIDDEN: actor center is not involved in profile % or account %',
      p_profile_id, p_account_id;
  END IF;
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
  v_lock_profile_id BIGINT;
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

  FOR v_lock_profile_id IN
    SELECT DISTINCT lock_id
    FROM UNNEST(ARRAY[v_profile_id, v_source_profile_id]) AS lock_ids(lock_id)
    WHERE lock_id IS NOT NULL
    ORDER BY lock_id
  LOOP
    PERFORM PG_ADVISORY_XACT_LOCK(HASHTEXTEXTENDED('pto-profile:' || v_lock_profile_id, 0));
  END LOOP;
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
