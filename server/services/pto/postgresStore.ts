import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import type {
  AddPtoEmailInput,
  AdjustPtoBalanceInput,
  DetachPtoMembershipInput,
  NormalizedListAdminPtoProfilesInput,
  NormalizedListPtoAuditInput,
  PagedResult,
  PtoAdminProfileDetail,
  PtoAliasDecisionInput,
  PtoAuditEvent,
  PtoBalance,
  PtoCenterStatus,
  PtoEmail,
  PtoProfileSummary,
  PtoProgramPolicy,
  PtoRosterSyncStoreInput,
  PtoRosterSyncSummary,
  PtoServiceStore,
  PtoTutorProfileResult,
  PtoRosterTutor,
  RemovePtoEmailInput
} from './contracts';

type Queryable = Pick<Pool | PoolClient, 'query'>;

const number = (value: unknown): number => Number(value ?? 0);
const iso = (value: unknown): string | null => value == null ? null : new Date(value as string | Date).toISOString();
const dateText = (value: unknown): string => value instanceof Date
  ? value.toISOString().slice(0, 10)
  : String(value).slice(0, 10);

const balance = (row: Record<string, unknown>): PtoBalance => ({
  grantedDays: number(row.granted_days),
  balanceDays: number(row.balance_days),
  reservedDays: number(row.reserved_days),
  availableDays: number(row.available_days)
});

const profile = (row: Record<string, unknown>): PtoProfileSummary => ({
  id: String(row.id),
  firstName: String(row.first_name ?? ''),
  lastName: String(row.last_name ?? ''),
  identityStatus: row.identity_status === 'confirmed' ? 'confirmed' : 'pending',
  active: Boolean(row.active),
  balance: balance(row)
});

const profileSelect = `
  SELECT profile.id, profile.first_name, profile.last_name, profile.identity_status, profile.active,
    COALESCE(balance.granted_days, 0) AS granted_days,
    COALESCE(balance.balance_days, 0) AS balance_days,
    COALESCE(balance.reserved_days, 0) AS reserved_days,
    COALESCE(balance.available_days, 0) AS available_days
  FROM public.pto_profiles profile
  LEFT JOIN LATERAL public.pto_profile_balance(profile.id, CURRENT_DATE) balance ON TRUE
`;

const queryRows = async <T extends QueryResultRow = QueryResultRow>(
  db: Queryable,
  text: string,
  values: unknown[] = []
): Promise<T[]> => (await db.query<T>(text, values)).rows;

const auditRow = (row: Record<string, unknown>): PtoAuditEvent => ({
  id: String(row.id),
  profileId: row.profile_id == null ? null : String(row.profile_id),
  franchiseId: row.franchiseid == null ? null : number(row.franchiseid),
  actorId: String(row.actor_id),
  eventType: String(row.event_type),
  before: row.before_state,
  after: row.after_state,
  createdAt: iso(row.created_at) ?? ''
});

const createStore = (db: Queryable, transactionPool?: Pool): PtoServiceStore => ({
  getProgramPolicy: async (): Promise<PtoProgramPolicy> => {
    const rows = await queryRows(db, `
      SELECT id, effective_from, entitlement_days, renewal_month, renewal_day, carryover_days
      FROM public.pto_policies WHERE effective_from <= CURRENT_DATE
      ORDER BY effective_from DESC LIMIT 1
    `);
    if (!rows[0]) throw new Error('No current PTO policy is configured');
    return {
      id: String(rows[0].id), effectiveFrom: dateText(rows[0].effective_from),
      entitlementDays: number(rows[0].entitlement_days), renewalMonth: number(rows[0].renewal_month),
      renewalDay: number(rows[0].renewal_day), carryoverDays: number(rows[0].carryover_days)
    };
  },

  getCenterStatus: async (franchiseId): Promise<PtoCenterStatus> => {
    const rows = await queryRows(db, `
      SELECT franchiseid, enabled, first_activated_at, last_successful_sync_at, last_sync_error
      FROM public.pto_center_settings WHERE franchiseid = $1
    `, [franchiseId]);
    const row = rows[0];
    return {
      franchiseId,
      enabled: Boolean(row?.enabled),
      firstActivatedAt: iso(row?.first_activated_at),
      lastSuccessfulSyncAt: iso(row?.last_successful_sync_at),
      lastSyncError: row?.last_sync_error == null ? null : String(row.last_sync_error)
    };
  },

  previewActivation: async (franchiseId, tutors) => {
    const activeIds = tutors.map((tutor) => tutor.id);
    const counts = await queryRows(db, `
      WITH incoming AS (
        SELECT * FROM JSONB_TO_RECORDSET($2::JSONB)
          AS tutor(id BIGINT, first_name TEXT, last_name TEXT)
      ), new_incoming AS (
        SELECT incoming.* FROM incoming
        WHERE NOT EXISTS (
          SELECT 1 FROM public.pto_profile_crm_ids crm
          WHERE crm.provider = 'timecard-center:' || ($1::INTEGER)::TEXT
            AND crm.crm_id = incoming.id::TEXT
        )
      ), candidate_pairs AS (
        SELECT 'existing:' || incoming.id || ':' || public.pto_canonical_profile_id(profile.id) AS pair_key
        FROM new_incoming incoming
        JOIN public.pto_profiles profile
          ON profile.active
          AND profile.normalized_first_name = LOWER(BTRIM(incoming.first_name))
          AND profile.normalized_last_name = LOWER(BTRIM(incoming.last_name))
        UNION
        SELECT 'incoming:' || LEAST(left_tutor.id, right_tutor.id) || ':'
          || GREATEST(left_tutor.id, right_tutor.id)
        FROM new_incoming left_tutor
        JOIN new_incoming right_tutor ON left_tutor.id < right_tutor.id
          AND LOWER(BTRIM(left_tutor.first_name)) = LOWER(BTRIM(right_tutor.first_name))
          AND LOWER(BTRIM(left_tutor.last_name)) = LOWER(BTRIM(right_tutor.last_name))
      )
      SELECT
        (SELECT COUNT(*) FROM incoming WHERE NOT EXISTS (
          SELECT 1 FROM public.pto_profile_centers center
          WHERE center.franchiseid = $1::INTEGER AND center.tutor_id = incoming.id
        )) AS new_memberships,
        (SELECT COUNT(*) FROM new_incoming) AS new_profiles,
        (SELECT COUNT(*) FROM candidate_pairs) AS pending_candidates
    `, [franchiseId, JSON.stringify(tutors.map((tutor) => ({
      id: tutor.id, first_name: tutor.firstName, last_name: tutor.lastName
    })))]);
    return {
      activeCrmTutorCount: activeIds.length,
      newMembershipCount: number(counts[0]?.new_memberships),
      newProfileCount: number(counts[0]?.new_profiles),
      pendingExactNameCandidateCount: number(counts[0]?.pending_candidates),
      warnings: tutors.some((tutor) => !tutor.firstName.trim() || !tutor.lastName.trim())
        ? ['Some active CRM tutors have incomplete names'] : []
    };
  },

  syncRoster: async (input: PtoRosterSyncStoreInput): Promise<PtoRosterSyncSummary> => {
    if (!input.tutors.every((tutor) => tutor.franchiseId === input.franchiseId)) {
      throw new Error('CRM roster contained a tutor from another franchise');
    }
    const priorCenterRows = await queryRows(db, `
      SELECT enabled, first_activated_at, last_successful_sync_at, last_sync_error
      FROM public.pto_center_settings WHERE franchiseid = $1
    `, [input.franchiseId]);
    const priorRosterRows = await queryRows(db, `
      SELECT tutor_id FROM public.pto_profile_centers
      WHERE franchiseid = $1 AND active AND tutor_id IS NOT NULL ORDER BY tutor_id
    `, [input.franchiseId]);
    const priorCenter = {
      enabled: Boolean(priorCenterRows[0]?.enabled),
      firstActivatedAt: iso(priorCenterRows[0]?.first_activated_at),
      lastSuccessfulSyncAt: iso(priorCenterRows[0]?.last_successful_sync_at),
      lastSyncError: priorCenterRows[0]?.last_sync_error == null ? null : String(priorCenterRows[0].last_sync_error),
      activeTutorIds: priorRosterRows.map((row) => number(row.tutor_id))
    };
    if (input.activate) {
      await db.query(`
        INSERT INTO public.pto_center_settings (franchiseid, enabled)
        VALUES ($1, TRUE)
        ON CONFLICT (franchiseid) DO UPDATE SET enabled = TRUE
      `, [input.franchiseId]);
    }
    let createdProfileCount = 0;
    let activatedMembershipCount = 0;
    let pendingCandidateCount = 0;
    const seenIds: number[] = [];
    for (const tutor of input.tutors) {
      seenIds.push(tutor.id);
      if (tutor.isDeleted) {
        await db.query(`UPDATE public.pto_profile_centers SET active = FALSE, updated_at = NOW()
          WHERE franchiseid = $1 AND tutor_id = $2`, [input.franchiseId, tutor.id]);
        continue;
      }
      const provider = `timecard-center:${input.franchiseId}`;
      let identity = await queryRows(db, `
        SELECT public.pto_canonical_profile_id(profile_id) AS profile_id
        FROM public.pto_profile_crm_ids WHERE provider = $1 AND crm_id = $2
      `, [provider, String(tutor.id)]);
      let profileId: string;
      if (!identity[0]) {
        const created = await queryRows(db, `
          INSERT INTO public.pto_profiles (first_name, last_name, identity_status)
          VALUES ($1, $2, 'pending') RETURNING id
        `, [tutor.firstName.trim(), tutor.lastName.trim()]);
        profileId = String(created[0].id);
        createdProfileCount += 1;
        await db.query(`INSERT INTO public.pto_profile_crm_ids (profile_id, provider, crm_id)
          VALUES ($1, $2, $3)`, [profileId, provider, String(tutor.id)]);
      } else {
        profileId = String(identity[0].profile_id);
        await db.query(`UPDATE public.pto_profiles SET first_name = $2, last_name = $3
          WHERE id = $1`, [profileId, tutor.firstName.trim(), tutor.lastName.trim()]);
      }
      let membership = await queryRows(db, `
        SELECT id, profile_id, FALSE AS inserted FROM public.pto_profile_centers
        WHERE franchiseid = $1 AND tutor_id = $2 FOR UPDATE
      `, [input.franchiseId, tutor.id]);
      if (membership[0]) {
        const membershipCanonical = await queryRows(db,
          'SELECT public.pto_canonical_profile_id($1) AS id', [membership[0].profile_id]);
        if (String(membershipCanonical[0].id) !== profileId) {
          throw new Error('PTO roster membership belongs to a different canonical profile');
        }
        membership = await queryRows(db, `UPDATE public.pto_profile_centers SET
          active = TRUE, crm_snapshot = $2, updated_at = NOW()
          WHERE id = $1 RETURNING id, profile_id, FALSE AS inserted`,
        [membership[0].id, tutor]);
      } else {
        membership = await queryRows(db, `INSERT INTO public.pto_profile_centers
          (profile_id, franchiseid, tutor_id, active, crm_snapshot, updated_at)
        VALUES ($1, $2, $3, TRUE, $4, NOW())
        ON CONFLICT (profile_id, franchiseid) DO UPDATE SET
          tutor_id = EXCLUDED.tutor_id, active = TRUE,
          crm_snapshot = EXCLUDED.crm_snapshot, updated_at = NOW()
        RETURNING id, profile_id, (xmax = 0) AS inserted`,
        [profileId, input.franchiseId, tutor.id, tutor]);
      }
      if (membership[0]?.inserted) activatedMembershipCount += 1;
      const membershipId = String(membership[0].id);
      await db.query(`UPDATE public.pto_profile_emails SET active = FALSE, updated_at = NOW()
        WHERE source_membership_id = $1 AND source = 'crm' AND email IS DISTINCT FROM $2`,
        [membershipId, tutor.email]);
      if (tutor.email) {
        await db.query(`
          INSERT INTO public.pto_profile_emails
            (profile_id, franchiseid, email, active, source, source_membership_id)
          VALUES ($1, $2, $3, TRUE, 'crm', $4)
          ON CONFLICT (profile_id, franchiseid, email, source) DO UPDATE SET
            active = TRUE, source_membership_id = EXCLUDED.source_membership_id,
            updated_at = NOW()
        `, [membership[0].profile_id, input.franchiseId, tutor.email.trim().toLowerCase(), membershipId]);
      }
      await db.query('SELECT public.pto_get_or_create_cycle($1, CURRENT_DATE)', [profileId]);
      const candidates = await db.query(`
        INSERT INTO public.pto_profile_match_candidates (left_profile_id, right_profile_id)
        SELECT LEAST($1::BIGINT, candidate.id), GREATEST($1::BIGINT, candidate.id)
        FROM public.pto_profiles candidate
        WHERE candidate.id <> $1 AND candidate.active
          AND candidate.normalized_first_name = LOWER(BTRIM($2))
          AND candidate.normalized_last_name = LOWER(BTRIM($3))
        ON CONFLICT (left_profile_id, right_profile_id) DO NOTHING
      `, [profileId, tutor.firstName, tutor.lastName]);
      pendingCandidateCount += candidates.rowCount ?? 0;
    }
    const activeIds = input.tutors.filter((tutor) => !tutor.isDeleted).map((tutor) => tutor.id);
    const deactivated = await db.query(`
      UPDATE public.pto_profile_centers SET active = FALSE, updated_at = NOW()
      WHERE franchiseid = $1 AND active AND NOT (tutor_id = ANY($2::BIGINT[]))
    `, [input.franchiseId, activeIds]);
    const syncRows = await queryRows(db, `
      INSERT INTO public.pto_center_settings
        (franchiseid, enabled, last_successful_sync_at, last_sync_error)
      VALUES ($1, $2, NOW(), NULL)
      ON CONFLICT (franchiseid) DO UPDATE SET
        enabled = public.pto_center_settings.enabled OR EXCLUDED.enabled,
        last_successful_sync_at = EXCLUDED.last_successful_sync_at,
        last_sync_error = NULL
      RETURNING enabled, first_activated_at, last_successful_sync_at, last_sync_error
    `, [input.franchiseId, input.activate]);
    const nextRosterRows = await queryRows(db, `
      SELECT tutor_id FROM public.pto_profile_centers
      WHERE franchiseid = $1 AND active AND tutor_id IS NOT NULL ORDER BY tutor_id
    `, [input.franchiseId]);
    const lastSuccessfulSyncAt = iso(syncRows[0].last_successful_sync_at) ?? new Date().toISOString();
    const summary = {
      activeTutorCount: activeIds.length,
      activatedMembershipCount,
      deactivatedMembershipCount: deactivated.rowCount ?? 0,
      createdProfileCount,
      pendingCandidateCount,
      lastSuccessfulSyncAt
    };
    const nextCenter = {
      enabled: Boolean(syncRows[0].enabled),
      firstActivatedAt: iso(syncRows[0].first_activated_at),
      lastSuccessfulSyncAt,
      lastSyncError: syncRows[0].last_sync_error == null ? null : String(syncRows[0].last_sync_error),
      activeTutorIds: nextRosterRows.map((row) => number(row.tutor_id))
    };
    await db.query(`
      INSERT INTO public.pto_audit_events
        (franchiseid, actor_id, event_type, before_state, after_state, idempotency_key)
      VALUES ($1, $2, $3, $4, $5, $6)
    `, [input.franchiseId, input.actorId,
      input.activate ? 'center_activated_and_synced' : 'roster_synced',
      priorCenter, { ...nextCenter, summary }, `roster-sync:${input.franchiseId}:${randomUUID()}`]);
    return summary;
  },

  getTutorProfile: async ({ franchiseId, tutorId }): Promise<PtoTutorProfileResult> => {
    const membership = await queryRows(db, `
      SELECT public.pto_canonical_profile_id(center.profile_id) AS profile_id
      FROM public.pto_profile_centers center
      WHERE center.franchiseid = $1 AND center.tutor_id = $2 AND center.active
    `, [franchiseId, tutorId]);
    if (!membership[0]) {
      const status = await queryRows(db, 'SELECT enabled FROM public.pto_center_settings WHERE franchiseid = $1', [franchiseId]);
      return { profile: null, memberships: [], emails: [], balance: null,
        unresolvedReason: status[0]?.enabled ? 'membership_missing' : 'center_disabled' };
    }
    const rows = await queryRows(db, `${profileSelect} WHERE profile.id = $1`, [membership[0].profile_id]);
    const summary = rows[0] ? profile(rows[0]) : null;
    const memberships = await queryRows(db, `
      SELECT center.id, center.franchiseid, center.tutor_id, center.active,
        center.crm_snapshot, center.updated_at
      FROM public.pto_profile_centers center
      WHERE public.pto_canonical_profile_id(center.profile_id) = $1 AND center.active
      ORDER BY center.franchiseid
    `, [membership[0].profile_id]);
    const emails = await queryRows(db, `
      SELECT email.id, email.franchiseid, email.email, email.active,
        email.source, email.source_membership_id
      FROM public.pto_profile_emails email
      WHERE public.pto_canonical_profile_id(email.profile_id) = $1 AND email.active
      ORDER BY email.email
    `, [membership[0].profile_id]);
    return { profile: summary, memberships, emails, balance: summary?.balance ?? null,
      unresolvedReason: summary?.active ? null : 'profile_inactive' };
  },

  listAdminProfiles: async (input: NormalizedListAdminPtoProfilesInput): Promise<PagedResult<PtoProfileSummary>> => {
    const offset = (input.page - 1) * input.pageSize;
    const values = [input.franchiseId, input.search, input.pageSize, offset];
    const rows = await queryRows(db, `${profileSelect}
      WHERE profile.active AND EXISTS (
        SELECT 1 FROM public.pto_profile_centers center
        WHERE public.pto_canonical_profile_id(center.profile_id) = profile.id
          AND center.franchiseid = $1
      )
        AND ($2 = '' OR CONCAT_WS(' ', profile.first_name, profile.last_name) ILIKE '%' || $2 || '%'
          OR EXISTS (
            SELECT 1 FROM public.pto_profile_emails email
            WHERE public.pto_canonical_profile_id(email.profile_id) = profile.id
              AND email.email ILIKE '%' || $2 || '%'
          ))
      ORDER BY profile.last_name, profile.first_name, profile.id LIMIT $3 OFFSET $4`, values);
    const totals = await queryRows(db, `SELECT COUNT(DISTINCT profile.id) AS total
      FROM public.pto_profiles profile
      WHERE profile.active AND EXISTS (
        SELECT 1 FROM public.pto_profile_centers center
        WHERE public.pto_canonical_profile_id(center.profile_id) = profile.id
          AND center.franchiseid = $1
      ) AND ($2 = '' OR CONCAT_WS(' ', profile.first_name, profile.last_name) ILIKE '%' || $2 || '%'
        OR EXISTS (
          SELECT 1 FROM public.pto_profile_emails email
          WHERE public.pto_canonical_profile_id(email.profile_id) = profile.id
            AND email.email ILIKE '%' || $2 || '%'
        ))`,
      [input.franchiseId, input.search]);
    return { items: rows.map(profile), page: input.page, pageSize: input.pageSize, total: number(totals[0]?.total) };
  },

  getAdminProfile: async ({ franchiseId, profileId }): Promise<PtoAdminProfileDetail | null> => {
    const allowed = await queryRows(db, `
      SELECT 1 FROM public.pto_profile_centers center
      WHERE public.pto_canonical_profile_id(center.profile_id) = $1
        AND center.franchiseid = $2 LIMIT 1
    `, [profileId, franchiseId]);
    if (!allowed[0]) return null;
    const rows = await queryRows(db, `${profileSelect} WHERE profile.id = $1`, [profileId]);
    if (!rows[0]) return null;
    const [memberships, emails, candidates, ledger, requests, audit] = await Promise.all([
      queryRows(db, `SELECT center.* FROM public.pto_profile_centers center
        WHERE public.pto_canonical_profile_id(center.profile_id) = $1 ORDER BY center.franchiseid`, [profileId]),
      queryRows(db, `SELECT email.* FROM public.pto_profile_emails email
        WHERE public.pto_canonical_profile_id(email.profile_id) = $1 ORDER BY email.email`, [profileId]),
      queryRows(db, `SELECT * FROM public.pto_profile_match_candidates
        WHERE public.pto_canonical_profile_id(left_profile_id) = $1
          OR public.pto_canonical_profile_id(right_profile_id) = $1
        ORDER BY created_at DESC`, [profileId]),
      queryRows(db, `SELECT * FROM public.pto_ledger_entries
        WHERE public.pto_canonical_profile_id(profile_id) = $1
        ORDER BY created_at DESC, id DESC LIMIT 200`, [profileId]),
      queryRows(db, `SELECT request.*, allocation.charged_days, allocation.state
        FROM public.pto_request_allocations allocation
        JOIN public.pto_entitlement_cycles cycle ON cycle.id = allocation.cycle_id
        JOIN public.time_off_requests request ON request.id = allocation.request_id
        WHERE public.pto_canonical_profile_id(cycle.profile_id) = $1
        ORDER BY request.created_at DESC LIMIT 200`, [profileId]),
      queryRows(db, `SELECT * FROM public.pto_audit_events
        WHERE public.pto_canonical_profile_id(profile_id) = $1
        ORDER BY created_at DESC, id DESC LIMIT 200`, [profileId])
    ]);
    return { ...profile(rows[0]), memberships, emails, candidates, ledger, requests, audit };
  },

  decideAlias: async (input: PtoAliasDecisionInput) => {
    const rows = await queryRows(db, 'SELECT public.pto_admin_decide_alias($1, $2, $3, $4) AS profile_id',
      [input.candidateId, input.decision, input.actorId, input.actorFranchiseId]);
    return { profileId: String(rows[0].profile_id), decision: input.decision };
  },

  detachMembership: async (input: DetachPtoMembershipInput) => {
    const rows = await queryRows(db, 'SELECT public.pto_admin_detach_membership($1, $2, $3, $4) AS profile_id',
      [input.profileId, input.membershipId, input.actorId, input.actorFranchiseId]);
    return { sourceProfileId: input.profileId, detachedProfileId: String(rows[0].profile_id) };
  },

  addEmail: async (input: AddPtoEmailInput): Promise<PtoEmail> => {
    await db.query('SELECT public.pto_assert_profile_admin($1, $2)', [input.profileId, input.actorFranchiseId]);
    const canonicalRows = await queryRows(db,
      'SELECT public.pto_canonical_profile_id($1) AS id', [input.profileId]);
    const canonicalProfileId = String(canonicalRows[0].id);
    const membership = await queryRows(db, `SELECT id, profile_id, franchiseid FROM public.pto_profile_centers
      WHERE id = $1 AND public.pto_canonical_profile_id(profile_id) = $2 AND active`,
    [input.membershipId, canonicalProfileId]);
    if (!membership[0]) throw new Error('PTO email provenance membership is not active on this profile');
    const ambiguous = await queryRows(db, `
      SELECT 1 FROM public.pto_profile_emails email
      WHERE email.email = $2 AND email.active
        AND email.franchiseid IN (
          SELECT center.franchiseid FROM public.pto_profile_centers center
          WHERE public.pto_canonical_profile_id(center.profile_id) = $1 AND center.active
        )
        AND public.pto_canonical_profile_id(email.profile_id) <> $1
        AND EXISTS (
          SELECT 1 FROM public.pto_profile_centers email_center
          WHERE email_center.franchiseid = email.franchiseid
            AND public.pto_canonical_profile_id(email_center.profile_id)
              = public.pto_canonical_profile_id(email.profile_id)
            AND email_center.active
        )
      LIMIT 1
    `, [canonicalProfileId, input.email]);
    if (ambiguous[0]) throw new Error('PTO email would be ambiguous in this center');
    const previous = await queryRows(db, `SELECT id, profile_id, franchiseid, email, active, source,
        source_membership_id FROM public.pto_profile_emails
      WHERE profile_id = $1 AND franchiseid = $2 AND email = $3 AND source = 'manual'`,
    [membership[0].profile_id, membership[0].franchiseid, input.email]);
    const rows = await queryRows(db, `INSERT INTO public.pto_profile_emails
      (profile_id, franchiseid, email, active, source, source_membership_id)
      VALUES ($1, $2, $3, TRUE, 'manual', $4)
      ON CONFLICT (profile_id, franchiseid, email, source) DO UPDATE SET active = TRUE,
        source_membership_id = EXCLUDED.source_membership_id, updated_at = NOW()
      RETURNING id, profile_id, franchiseid, email, active, source, source_membership_id`,
      [membership[0].profile_id, membership[0].franchiseid, input.email, input.membershipId]);
    await db.query(`INSERT INTO public.pto_audit_events
      (profile_id, franchiseid, actor_id, event_type, before_state, after_state, idempotency_key)
      VALUES ($1, $2, $3, 'email_added', $4, $5, $6)`,
      [canonicalProfileId, membership[0].franchiseid, input.actorId,
        previous[0] ?? { exists: false }, rows[0], `email-add:${rows[0].id}:${randomUUID()}`]);
    return { id: String(rows[0].id), email: String(rows[0].email), active: true, source: 'manual',
      sourceMembershipId: String(rows[0].source_membership_id) };
  },

  removeEmail: async (input: RemovePtoEmailInput): Promise<PtoEmail> => {
    await db.query('SELECT public.pto_assert_profile_admin($1, $2)', [input.profileId, input.actorFranchiseId]);
    const previous = await queryRows(db, `SELECT id, profile_id, franchiseid, email, active, source,
        source_membership_id FROM public.pto_profile_emails
      WHERE id = $1 AND public.pto_canonical_profile_id(profile_id)
        = public.pto_canonical_profile_id($2) AND source = 'manual'`, [input.emailId, input.profileId]);
    if (!previous[0]) throw new Error('Only an existing manual PTO email can be removed');
    const rows = await queryRows(db, `UPDATE public.pto_profile_emails SET active = FALSE, updated_at = NOW()
      WHERE id = $1 RETURNING id, profile_id, email, active, source, source_membership_id, franchiseid`,
    [input.emailId]);
    await db.query(`INSERT INTO public.pto_audit_events
      (profile_id, franchiseid, actor_id, event_type, before_state, after_state, idempotency_key)
      VALUES ($1, $2, $3, 'email_removed', $4, $5, $6)`,
      [input.profileId, rows[0].franchiseid, input.actorId, previous[0], rows[0],
        `email-remove:${input.emailId}:${randomUUID()}`]);
    return { id: String(rows[0].id), email: String(rows[0].email), active: false, source: 'manual',
      sourceMembershipId: rows[0].source_membership_id == null ? null : String(rows[0].source_membership_id) };
  },

  adjustBalance: async (input: AdjustPtoBalanceInput) => {
    await db.query('SELECT public.pto_assert_profile_admin($1, $2)', [input.profileId, input.actorFranchiseId]);
    const canonical = await queryRows(db,
      'SELECT public.pto_canonical_profile_id($1) AS id', [input.profileId]);
    const canonicalProfileId = String(canonical[0].id);
    const beforeBalance = await queryRows(db,
      'SELECT * FROM public.pto_profile_balance($1, $2::DATE)', [canonicalProfileId, input.cycleStart]);
    let cycles = await queryRows(db, `SELECT id FROM public.pto_entitlement_cycles
      WHERE profile_id = $1 AND starts_on = $2::DATE`, [canonicalProfileId, input.cycleStart]);
    if (!cycles[0]) cycles = await queryRows(db,
      'SELECT public.pto_get_or_create_cycle($1, $2::DATE) AS id', [canonicalProfileId, input.cycleStart]);
    const entry = await queryRows(db, `INSERT INTO public.pto_ledger_entries
      (profile_id, cycle_id, event_type, balance_delta, idempotency_key, metadata)
      VALUES ($1, $2, 'adjustment', $3, $4,
        JSONB_BUILD_OBJECT('reason', $5::TEXT, 'actorId', $6::TEXT)) RETURNING id`,
      [canonicalProfileId, cycles[0].id, input.deltaDays, `adjustment:${randomUUID()}`, input.reason, input.actorId]);
    const balances = await queryRows(db,
      'SELECT * FROM public.pto_profile_balance($1, $2::DATE)', [canonicalProfileId, input.cycleStart]);
    await db.query(`INSERT INTO public.pto_audit_events
      (profile_id, franchiseid, actor_id, event_type, before_state, after_state, idempotency_key)
      VALUES ($1, $2, $3, 'balance_adjusted', $4, $5, $6)`,
      [canonicalProfileId, input.actorFranchiseId, input.actorId,
        { cycleStart: input.cycleStart, balance: beforeBalance[0] },
        { cycleStart: input.cycleStart, balance: balances[0], deltaDays: input.deltaDays,
          reason: input.reason, ledgerEntryId: entry[0].id },
        `balance-adjust:${entry[0].id}`]);
    return { ledgerEntryId: String(entry[0].id), availableDays: number(balances[0].available_days) };
  },

  listAudit: async (input: NormalizedListPtoAuditInput): Promise<PagedResult<PtoAuditEvent>> => {
    const offset = (input.page - 1) * input.pageSize;
    const rows = await queryRows(db, `SELECT * FROM public.pto_audit_events audit
      WHERE (audit.franchiseid = $1 OR EXISTS (SELECT 1 FROM public.pto_profile_centers center
        WHERE public.pto_canonical_profile_id(center.profile_id)
          = public.pto_canonical_profile_id(audit.profile_id)
          AND center.franchiseid = $1))
        AND ($2::BIGINT IS NULL OR public.pto_canonical_profile_id(audit.profile_id)
          = public.pto_canonical_profile_id($2))
      ORDER BY audit.created_at DESC, audit.id DESC LIMIT $3 OFFSET $4`,
      [input.franchiseId, input.profileId ?? null, input.pageSize, offset]);
    const totals = await queryRows(db, `SELECT COUNT(*) AS total FROM public.pto_audit_events audit
      WHERE (audit.franchiseid = $1 OR EXISTS (SELECT 1 FROM public.pto_profile_centers center
        WHERE public.pto_canonical_profile_id(center.profile_id)
          = public.pto_canonical_profile_id(audit.profile_id)
          AND center.franchiseid = $1))
        AND ($2::BIGINT IS NULL OR public.pto_canonical_profile_id(audit.profile_id)
          = public.pto_canonical_profile_id($2))`, [input.franchiseId, input.profileId ?? null]);
    return { items: rows.map(auditRow), page: input.page, pageSize: input.pageSize, total: number(totals[0]?.total) };
  },

  runInTransaction: async <T>(work: (store: PtoServiceStore) => Promise<T>): Promise<T> => {
    if (!transactionPool) return work(createStore(db));
    const client = await transactionPool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(createStore(client));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
});

export const createPostgresPtoStore = (pool: Pool): PtoServiceStore => createStore(pool, pool);
