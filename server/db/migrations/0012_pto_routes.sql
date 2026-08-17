CREATE TABLE IF NOT EXISTS public.time_off_center_links (
  id BIGSERIAL PRIMARY KEY,
  franchiseid INTEGER NOT NULL,
  token_hash TEXT NOT NULL CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (token_hash)
);

CREATE INDEX IF NOT EXISTS time_off_center_links_active_center_idx
  ON public.time_off_center_links (franchiseid) WHERE active;

CREATE OR REPLACE FUNCTION public.pto_reject_disabled_request()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  v_enabled BOOLEAN;
BEGIN
  IF NEW.type <> 'pto' THEN RETURN NEW; END IF;
  SELECT enabled INTO v_enabled FROM public.pto_center_settings WHERE franchiseid = NEW.franchiseid;
  IF NOT COALESCE(v_enabled, FALSE) THEN
    RAISE EXCEPTION USING MESSAGE = 'PTO_CENTER_DISABLED', ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS pto_disabled_center_insert_guard ON public.time_off_requests;
CREATE TRIGGER pto_disabled_center_insert_guard
BEFORE INSERT ON public.time_off_requests
FOR EACH ROW EXECUTE FUNCTION public.pto_reject_disabled_request();

CREATE OR REPLACE FUNCTION public.pto_deactivate_center(
  p_franchiseid INTEGER,
  p_actor_id TEXT
)
RETURNS SETOF public.pto_center_settings
LANGUAGE plpgsql
AS $$
DECLARE
  v_before public.pto_center_settings%ROWTYPE;
  v_after public.pto_center_settings%ROWTYPE;
BEGIN
  SELECT * INTO v_before FROM public.pto_center_settings
  WHERE franchiseid = p_franchiseid FOR UPDATE;

  INSERT INTO public.pto_center_settings (franchiseid, enabled)
  VALUES (p_franchiseid, FALSE)
  ON CONFLICT (franchiseid) DO UPDATE SET enabled = FALSE
  RETURNING * INTO v_after;

  INSERT INTO public.pto_audit_events (
    franchiseid, actor_id, event_type, before_state, after_state, idempotency_key
  ) VALUES (
    p_franchiseid, p_actor_id, 'center_deactivated', TO_JSONB(v_before), TO_JSONB(v_after),
    'center-deactivate:' || p_franchiseid || ':' || TXID_CURRENT() || ':' || CLOCK_TIMESTAMP()
  );

  RETURN NEXT v_after;
END;
$$;
