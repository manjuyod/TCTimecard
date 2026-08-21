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
