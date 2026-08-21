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

CREATE OR REPLACE FUNCTION public.pto_reject_ledger_mutation()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'UPDATE'
    AND OLD.source_membership_id IS NULL
    AND NEW.source_membership_id IS NOT NULL
    AND (TO_JSONB(NEW) - 'source_membership_id') = (TO_JSONB(OLD) - 'source_membership_id') THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'PTO ledger entries are append-only';
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

  PERFORM PG_ADVISORY_XACT_LOCK(HASHTEXTEXTENDED('pto-profile:' || v_profile_id, 0));
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

  PERFORM PG_ADVISORY_XACT_LOCK(HASHTEXTEXTENDED('pto-profile:' || v_profile_id, 0));
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
