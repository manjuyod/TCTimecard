-- Extend only public identity resolution. The authenticated resolver branch
-- below is retained from 0011; existing function signatures/ACLs stay intact.
-- Apply through the migration runner (one transaction per migration).

-- Expose only eligible canonical IDs for a supplied center/email. The form
-- role does not need SELECT on account snapshots, link decisions, or CRM IDs.
CREATE OR REPLACE FUNCTION public.pto_public_linked_email_profiles(
  p_franchiseid INTEGER,
  p_email TEXT
)
RETURNS TABLE (profile_id BIGINT)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $$
  SELECT DISTINCT profile.id
  FROM public.pto_discovered_tutor_accounts AS account
  JOIN public.pto_profile_link_decisions AS decision
    ON decision.account_id = account.id
   AND decision.status = 'linked'
  JOIN public.pto_profiles AS profile
    ON profile.id = public.pto_canonical_profile_id(decision.profile_id)
   AND profile.active
  JOIN public.pto_profile_crm_ids AS crm
    ON crm.provider = account.provider
   AND crm.crm_id = account.crm_id
   AND public.pto_canonical_profile_id(crm.profile_id) = profile.id
  WHERE account.crm_active
    AND account.provider = 'timecard-center:' || account.franchiseid::TEXT
    AND account.crm_id = account.tutor_id::TEXT
    AND NULLIF(LOWER(BTRIM(account.crm_snapshot ->> 'email')), '')
      = NULLIF(LOWER(BTRIM(p_email)), '')
    AND EXISTS (
      SELECT 1
      FROM public.pto_profile_centers AS membership
      JOIN public.pto_center_settings AS settings
        ON settings.franchiseid = membership.franchiseid
       AND settings.enabled
      WHERE membership.franchiseid = p_franchiseid
        AND membership.active
        AND public.pto_canonical_profile_id(membership.profile_id) = profile.id
    );
$$;

REVOKE ALL ON FUNCTION public.pto_public_linked_email_profiles(INTEGER, TEXT) FROM PUBLIC;

-- The public-form deployment owns role creation. Keep migrations usable in
-- Time Card databases that do not host that form, without creating login roles.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'timeoff_form_app') THEN
    GRANT EXECUTE ON FUNCTION public.pto_public_linked_email_profiles(INTEGER, TEXT)
      TO timeoff_form_app;
  END IF;
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
  v_membership_active BOOLEAN;
  v_public_match_count INTEGER;
  v_identity_status TEXT;
  v_local_provider TEXT := 'timecard-center:' || p_franchiseid;
BEGIN
  IF p_request_source = 'public' THEN
    IF v_email IS NULL THEN
      RAISE EXCEPTION 'Public PTO identity must resolve exactly one active profile';
    END IF;

    -- UNION deduplicates both sources by canonical identity before counting.
    -- Do not prefer a registered email over a conflicting explicit link.
    WITH candidates AS (
      SELECT public.pto_canonical_profile_id(email.profile_id) AS profile_id
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
        )
      UNION
      SELECT linked.profile_id
      FROM public.pto_public_linked_email_profiles(p_franchiseid, v_email) AS linked
    )
    SELECT COUNT(*), MIN(profile_id)
    INTO v_public_match_count, v_profile_id
    FROM candidates;

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

  IF v_profile_id IS NULL OR (p_tutorid IS NOT NULL AND v_local_profile IS NULL) THEN
    RAISE EXCEPTION 'Authenticated PTO identity requires an active CRM membership';
  END IF;

  UPDATE public.pto_profiles
  SET first_name = v_first_name,
      last_name = v_last_name,
      identity_status = CASE WHEN p_bridge_profile_id IS NULL THEN identity_status ELSE 'confirmed' END
  WHERE id = v_profile_id;

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
    SELECT public.pto_canonical_profile_id(profile_id) INTO v_attached_profile
    FROM public.pto_profile_crm_ids
    WHERE provider = v_local_provider AND crm_id = p_tutorid::TEXT;
    IF v_attached_profile IS DISTINCT FROM v_profile_id THEN
      RAISE EXCEPTION 'PTO identities belong to different profiles';
    END IF;

    SELECT id, profile_id, active
    INTO v_membership_id, v_membership_profile_id, v_membership_active
    FROM public.pto_profile_centers
    WHERE franchiseid = p_franchiseid AND tutor_id = p_tutorid
    FOR UPDATE;
  END IF;

  IF p_tutorid IS NULL THEN
    SELECT id, profile_id, active
    INTO v_membership_id, v_membership_profile_id, v_membership_active
    FROM public.pto_profile_centers
    WHERE franchiseid = p_franchiseid
      AND public.pto_canonical_profile_id(profile_id) = v_profile_id
    ORDER BY id LIMIT 1 FOR UPDATE;
  END IF;

  IF v_membership_id IS NULL OR NOT COALESCE(v_membership_active, FALSE) THEN
    RAISE EXCEPTION 'Authenticated PTO identity requires an active CRM membership';
  END IF;
  IF public.pto_canonical_profile_id(v_membership_profile_id) IS DISTINCT FROM v_profile_id THEN
    RAISE EXCEPTION 'PTO membership belongs to a different profile';
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
