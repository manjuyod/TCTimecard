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
    COALESCE(cycle.entitlement_days, 0) AS granted_days,
    COALESCE(ledger.balance_days, 0) AS balance_days,
    COALESCE(ledger.reserved_days, 0) AS reserved_days,
    COALESCE(balance.available_days, 0) AS available_days
  FROM public.pto_profiles profile
  LEFT JOIN LATERAL (
    SELECT entitlement_days FROM public.pto_entitlement_cycles
    WHERE profile_id = profile.id AND CURRENT_DATE BETWEEN starts_on AND ends_on LIMIT 1
  ) cycle ON TRUE
  LEFT JOIN LATERAL (
    SELECT COALESCE(SUM(balance_delta), 0) AS balance_days,
      COALESCE(SUM(reserved_delta), 0) AS reserved_days
    FROM public.pto_ledger_entries WHERE profile_id = profile.id
  ) ledger ON TRUE
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
      ), existing AS (
        SELECT tutor_id FROM public.pto_profile_centers WHERE franchiseid = $1
      )
      SELECT
        (SELECT COUNT(*) FROM incoming WHERE id NOT IN (SELECT tutor_id FROM existing)) AS new_memberships,
        (SELECT COUNT(*) FROM incoming i WHERE NOT EXISTS (
          SELECT 1 FROM public.pto_profile_crm_ids crm
          WHERE crm.provider = 'timecard-center:' || $1 AND crm.crm_id = i.id::TEXT
        )) AS new_profiles,
        (SELECT COUNT(*) FROM incoming i WHERE EXISTS (
          SELECT 1 FROM public.pto_profiles profile
          WHERE profile.active
            AND profile.normalized_first_name = LOWER(BTRIM(i.first_name))
            AND profile.normalized_last_name = LOWER(BTRIM(i.last_name))
        )) AS pending_candidates
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
        SELECT profile_id FROM public.pto_profile_crm_ids WHERE provider = $1 AND crm_id = $2
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
      const membership = await queryRows(db, `
        INSERT INTO public.pto_profile_centers
          (profile_id, franchiseid, tutor_id, active, crm_snapshot, updated_at)
        VALUES ($1, $2, $3, TRUE, $4, NOW())
        ON CONFLICT (profile_id, franchiseid) DO UPDATE SET
          tutor_id = EXCLUDED.tutor_id, active = TRUE,
          crm_snapshot = EXCLUDED.crm_snapshot, updated_at = NOW()
        RETURNING id, (xmax = 0) AS inserted
      `, [profileId, input.franchiseId, tutor.id, tutor]);
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
          ON CONFLICT (profile_id, franchiseid, email) DO UPDATE SET
            active = TRUE, source = 'crm', source_membership_id = EXCLUDED.source_membership_id,
            updated_at = NOW()
        `, [profileId, input.franchiseId, tutor.email.trim().toLowerCase(), membershipId]);
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
      RETURNING last_successful_sync_at
    `, [input.franchiseId, input.activate]);
    const lastSuccessfulSyncAt = iso(syncRows[0].last_successful_sync_at) ?? new Date().toISOString();
    await db.query(`
      INSERT INTO public.pto_audit_events
        (franchiseid, actor_id, event_type, after_state, idempotency_key)
      VALUES ($1, $2, $3, $4, $5)
    `, [input.franchiseId, input.actorId, input.activate ? 'center_activated_and_synced' : 'roster_synced', {
      activeTutorCount: activeIds.length, lastSuccessfulSyncAt
    }, `roster-sync:${input.franchiseId}:${randomUUID()}`]);
    return {
      activeTutorCount: activeIds.length,
      activatedMembershipCount,
      deactivatedMembershipCount: deactivated.rowCount ?? 0,
      createdProfileCount,
      pendingCandidateCount,
      lastSuccessfulSyncAt
    };
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
    const membership = await queryRows(db, `SELECT id, franchiseid FROM public.pto_profile_centers
      WHERE id = $1 AND profile_id = $2 AND active`, [input.membershipId, input.profileId]);
    if (!membership[0]) throw new Error('PTO email provenance membership is not active on this profile');
    const ambiguous = await queryRows(db, `SELECT 1 FROM public.pto_profile_emails email
      JOIN public.pto_profile_centers center ON center.profile_id = email.profile_id
        AND center.franchiseid = email.franchiseid AND center.active
      WHERE email.franchiseid = $1 AND email.email = $2 AND email.active AND email.profile_id <> $3 LIMIT 1`,
      [membership[0].franchiseid, input.email, input.profileId]);
    if (ambiguous[0]) throw new Error('PTO email would be ambiguous in this center');
    const rows = await queryRows(db, `INSERT INTO public.pto_profile_emails
      (profile_id, franchiseid, email, active, source, source_membership_id)
      VALUES ($1, $2, $3, TRUE, 'manual', $4)
      ON CONFLICT (profile_id, franchiseid, email) DO UPDATE SET active = TRUE, source = 'manual',
        source_membership_id = EXCLUDED.source_membership_id, updated_at = NOW()
      RETURNING id, email, active, source, source_membership_id`,
      [input.profileId, membership[0].franchiseid, input.email, input.membershipId]);
    await db.query(`INSERT INTO public.pto_audit_events
      (profile_id, franchiseid, actor_id, event_type, after_state, idempotency_key)
      VALUES ($1, $2, $3, 'email_added', $4, $5)`,
      [input.profileId, membership[0].franchiseid, input.actorId, rows[0], `email-add:${rows[0].id}:${randomUUID()}`]);
    return { id: String(rows[0].id), email: String(rows[0].email), active: true, source: 'manual',
      sourceMembershipId: String(rows[0].source_membership_id) };
  },

  removeEmail: async (input: RemovePtoEmailInput): Promise<PtoEmail> => {
    await db.query('SELECT public.pto_assert_profile_admin($1, $2)', [input.profileId, input.actorFranchiseId]);
    const rows = await queryRows(db, `UPDATE public.pto_profile_emails SET active = FALSE, updated_at = NOW()
      WHERE id = $1 AND profile_id = $2 AND source = 'manual'
      RETURNING id, email, active, source, source_membership_id, franchiseid`, [input.emailId, input.profileId]);
    if (!rows[0]) throw new Error('Only an existing manual PTO email can be removed');
    await db.query(`INSERT INTO public.pto_audit_events
      (profile_id, franchiseid, actor_id, event_type, before_state, after_state, idempotency_key)
      VALUES ($1, $2, $3, 'email_removed', $4, $5, $6)`,
      [input.profileId, rows[0].franchiseid, input.actorId, { ...rows[0], active: true }, rows[0],
        `email-remove:${input.emailId}:${randomUUID()}`]);
    return { id: String(rows[0].id), email: String(rows[0].email), active: false, source: 'manual',
      sourceMembershipId: rows[0].source_membership_id == null ? null : String(rows[0].source_membership_id) };
  },

  adjustBalance: async (input: AdjustPtoBalanceInput) => {
    await db.query('SELECT public.pto_assert_profile_admin($1, $2)', [input.profileId, input.actorFranchiseId]);
    let cycles = await queryRows(db, `SELECT id FROM public.pto_entitlement_cycles
      WHERE profile_id = $1 AND starts_on = $2::DATE`, [input.profileId, input.cycleStart]);
    if (!cycles[0]) cycles = await queryRows(db,
      'SELECT public.pto_get_or_create_cycle($1, $2::DATE) AS id', [input.profileId, input.cycleStart]);
    const entry = await queryRows(db, `INSERT INTO public.pto_ledger_entries
      (profile_id, cycle_id, event_type, balance_delta, idempotency_key, metadata)
      VALUES ($1, $2, 'adjustment', $3, $4,
        JSONB_BUILD_OBJECT('reason', $5::TEXT, 'actorId', $6::TEXT)) RETURNING id`,
      [input.profileId, cycles[0].id, input.deltaDays, `adjustment:${randomUUID()}`, input.reason, input.actorId]);
    await db.query(`INSERT INTO public.pto_audit_events
      (profile_id, franchiseid, actor_id, event_type, before_state, after_state, idempotency_key)
      VALUES ($1, $2, $3, 'balance_adjusted', NULL, $4, $5)`,
      [input.profileId, input.actorFranchiseId, input.actorId,
        { cycleStart: input.cycleStart, deltaDays: input.deltaDays, reason: input.reason, ledgerEntryId: entry[0].id },
        `balance-adjust:${entry[0].id}`]);
    const balances = await queryRows(db,
      'SELECT available_days FROM public.pto_profile_balance($1, $2::DATE)', [input.profileId, input.cycleStart]);
    return { ledgerEntryId: String(entry[0].id), availableDays: number(balances[0].available_days) };
  },

  listAudit: async (input: NormalizedListPtoAuditInput): Promise<PagedResult<PtoAuditEvent>> => {
    const offset = (input.page - 1) * input.pageSize;
    const rows = await queryRows(db, `SELECT * FROM public.pto_audit_events audit
      WHERE (audit.franchiseid = $1 OR EXISTS (SELECT 1 FROM public.pto_profile_centers center
        WHERE center.profile_id = audit.profile_id AND center.franchiseid = $1))
        AND ($2::BIGINT IS NULL OR audit.profile_id = $2)
      ORDER BY audit.created_at DESC, audit.id DESC LIMIT $3 OFFSET $4`,
      [input.franchiseId, input.profileId ?? null, input.pageSize, offset]);
    const totals = await queryRows(db, `SELECT COUNT(*) AS total FROM public.pto_audit_events audit
      WHERE (audit.franchiseid = $1 OR EXISTS (SELECT 1 FROM public.pto_profile_centers center
        WHERE center.profile_id = audit.profile_id AND center.franchiseid = $1))
        AND ($2::BIGINT IS NULL OR audit.profile_id = $2)`, [input.franchiseId, input.profileId ?? null]);
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
