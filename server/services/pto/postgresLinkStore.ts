import type {
  AssignPtoAdjustmentProvenanceInput,
  PtoAccountLinkBaseInput,
  PtoAccountLinkMutationInput,
  PtoAccountLinkMutationResult,
  PtoAccountLinkPreview,
  PtoAdjustmentProvenanceResult,
  PtoDiscoveredAccount
} from './contracts';
import type { PtoQueryable } from './postgresTypes';

const numeric = (value: unknown): number => Number(value ?? 0);
const iso = (value: unknown): string => new Date(value as string | Date).toISOString();

const accountFromRow = (row: Record<string, unknown>): PtoDiscoveredAccount => {
  const warnings: string[] = [];
  if (!row.crm_active) warnings.push('CRM inactive');
  if (!row.center_enabled) warnings.push('Center PTO disabled');
  return {
    id: String(row.id),
    provider: String(row.provider),
    crmId: String(row.crm_id),
    franchiseId: numeric(row.franchiseid),
    tutorId: numeric(row.tutor_id),
    firstName: String(row.first_name ?? ''),
    lastName: String(row.last_name ?? ''),
    displayEmail: row.display_email == null ? null : String(row.display_email),
    crmActive: Boolean(row.crm_active),
    centerEnabled: Boolean(row.center_enabled),
    membershipId: row.membership_id == null ? null : String(row.membership_id),
    status: row.status === 'linked' ? 'linked' : row.status === 'excluded' ? 'excluded' : 'pending',
    version: numeric(row.version),
    lastSeenAt: iso(row.last_seen_at),
    warnings
  };
};

const getPreviewAccount = async (
  db: PtoQueryable,
  input: PtoAccountLinkBaseInput
): Promise<{ account: PtoDiscoveredAccount; canonicalProfileId: string }> => {
  await db.query('SELECT public.pto_assert_link_admin($1, $2, $3)', [
    input.profileId, input.accountId, input.actorFranchiseId
  ]);
  const result = await db.query(`
    SELECT account.id, account.provider, account.crm_id, account.franchiseid, account.tutor_id,
      COALESCE(account.crm_snapshot ->> 'firstName', account.normalized_first_name) AS first_name,
      COALESCE(account.crm_snapshot ->> 'lastName', account.normalized_last_name) AS last_name,
      NULLIF(LOWER(BTRIM(account.crm_snapshot ->> 'email')), '') AS display_email,
      account.crm_active, account.last_seen_at,
      COALESCE(settings.enabled, FALSE) AS center_enabled,
      center.id AS membership_id,
      decision.status, decision.version,
      public.pto_canonical_profile_id($1) AS canonical_profile_id
    FROM public.pto_profile_link_decisions decision
    JOIN public.pto_discovered_tutor_accounts account ON account.id = decision.account_id
    LEFT JOIN public.pto_center_settings settings ON settings.franchiseid = account.franchiseid
    LEFT JOIN public.pto_profile_centers center
      ON center.franchiseid = account.franchiseid
     AND center.tutor_id = account.tutor_id
     AND center.active
    WHERE account.id = $2
      AND public.pto_canonical_profile_id(decision.profile_id)
        = public.pto_canonical_profile_id($1)
    ORDER BY (decision.profile_id = public.pto_canonical_profile_id($1)) DESC, decision.id
    LIMIT 1
  `, [input.profileId, input.accountId]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new Error('PTO_DISCOVERY_STALE: account is no longer a candidate');
  const account = accountFromRow(row);
  if (account.version !== input.expectedVersion) {
    throw new Error(`PTO_LINK_STALE: expected version ${input.expectedVersion}, found ${account.version}`);
  }
  if (!account.crmActive) throw new Error('PTO_DISCOVERY_STALE: account is inactive');
  return { account, canonicalProfileId: String(row.canonical_profile_id) };
};

export const createPostgresPtoLinkStore = (db: PtoQueryable) => ({
  previewAccountLink: async (input: PtoAccountLinkBaseInput): Promise<PtoAccountLinkPreview> => {
    const { account, canonicalProfileId } = await getPreviewAccount(db, input);
    const identity = await db.query(`
      SELECT public.pto_canonical_profile_id(crm.profile_id) AS profile_id
      FROM public.pto_profile_crm_ids crm
      WHERE crm.provider = $1 AND crm.crm_id = $2
    `, [account.provider, account.crmId]);
    const sourceProfileId = identity.rows[0]?.profile_id == null
      ? null : String(identity.rows[0].profile_id);
    const profileIds = [...new Set([canonicalProfileId, sourceProfileId].filter((value): value is string => Boolean(value)))];
    const balancesResult = await db.query(`
      SELECT requested.profile_id::TEXT AS profile_id,
        balance.granted_days, balance.balance_days, balance.reserved_days, balance.available_days
      FROM UNNEST($1::BIGINT[]) AS requested(profile_id)
      CROSS JOIN LATERAL public.pto_profile_balance(requested.profile_id, CURRENT_DATE) balance
      ORDER BY requested.profile_id
    `, [profileIds]);
    const balances = balancesResult.rows.map((row) => ({
      profileId: String(row.profile_id),
      grantedDays: numeric(row.granted_days),
      balanceDays: numeric(row.balance_days),
      reservedDays: numeric(row.reserved_days),
      availableDays: numeric(row.available_days)
    }));
    const resultingProfileId = sourceProfileId && sourceProfileId !== canonicalProfileId
      ? String(Math.min(Number(sourceProfileId), Number(canonicalProfileId)))
      : canonicalProfileId;
    const oneGrant = Math.max(0, ...balances.map((item) => item.grantedDays));
    const balanceActivity = balances.reduce(
      (total, item) => total + item.balanceDays - item.grantedDays,
      0
    );
    const reservedDays = balances.reduce((total, item) => total + item.reservedDays, 0);
    const afterAvailableDays = oneGrant + balanceActivity - reservedDays;
    const requests = sourceProfileId && sourceProfileId !== canonicalProfileId
      ? await db.query(`
          SELECT DISTINCT allocation.request_id
          FROM public.pto_request_allocations allocation
          JOIN public.pto_entitlement_cycles cycle ON cycle.id = allocation.cycle_id
          WHERE public.pto_canonical_profile_id(cycle.profile_id) = $1
          ORDER BY allocation.request_id
        `, [sourceProfileId])
      : { rows: [] as Array<Record<string, unknown>> };
    const warnings = [...account.warnings];
    if (afterAvailableDays < 0) warnings.push('Linking these accounts produces a negative available balance');
    return {
      mode: 'link',
      profileId: canonicalProfileId,
      account,
      version: account.version,
      beforeBalances: balances.map((item) => ({
        profileId: item.profileId,
        availableDays: item.availableDays
      })),
      afterBalances: [{ profileId: resultingProfileId, availableDays: afterAvailableDays }],
      affectedRequestIds: requests.rows.map((row) => String(row.request_id)),
      ambiguousAdjustmentIds: [],
      warnings
    };
  },

  linkAccount: async (input: PtoAccountLinkMutationInput): Promise<PtoAccountLinkMutationResult> => {
    const result = await db.query(`
      SELECT public.pto_admin_link_account($1, $2, $3, $4, $5, $6) AS result
    `, [input.profileId, input.accountId, input.actorId, input.actorFranchiseId,
      input.expectedVersion, input.idempotencyKey]);
    const value = result.rows[0]?.result as Record<string, unknown> | undefined;
    if (!value) throw new Error('PTO account link did not return a result');
    return {
      canonicalProfileId: String(value.canonicalProfileId),
      detachedProfileId: value.detachedProfileId == null ? null : String(value.detachedProfileId),
      decisionVersion: numeric(value.decisionVersion)
    };
  },

  previewAccountUnlink: async (input: PtoAccountLinkBaseInput): Promise<PtoAccountLinkPreview> => {
    const { account, canonicalProfileId } = await getPreviewAccount(db, input);
    if (account.status !== 'linked') throw new Error('PTO_LINK_STALE: account is not linked');
    const balanceResult = await db.query(`
      SELECT granted_days, available_days
      FROM public.pto_profile_balance($1, CURRENT_DATE)
    `, [canonicalProfileId]);
    const grantedDays = numeric(balanceResult.rows[0]?.granted_days);
    const availableDays = numeric(balanceResult.rows[0]?.available_days);
    if (!account.membershipId) {
      return {
        mode: 'unlink',
        profileId: canonicalProfileId,
        account,
        version: account.version,
        beforeBalances: [{ profileId: canonicalProfileId, availableDays }],
        afterBalances: [{ profileId: canonicalProfileId, availableDays }],
        affectedRequestIds: [],
        ambiguousAdjustmentIds: [],
        warnings: [...account.warnings]
      };
    }

    const [requests, ambiguous, activity] = await Promise.all([
      db.query(`
        SELECT DISTINCT request.id
        FROM public.time_off_requests request
        JOIN public.pto_request_allocations allocation ON allocation.request_id = request.id
        JOIN public.pto_entitlement_cycles cycle ON cycle.id = allocation.cycle_id
        WHERE request.franchiseid = $1
          AND public.pto_canonical_profile_id(cycle.profile_id) = $2
        ORDER BY request.id
      `, [account.franchiseId, canonicalProfileId]),
      db.query(`
        SELECT ledger.id
        FROM public.pto_ledger_entries ledger
        WHERE public.pto_canonical_profile_id(ledger.profile_id) = $1
          AND ledger.event_type = 'adjustment'
          AND ledger.source_membership_id IS NULL
        ORDER BY ledger.id
      `, [canonicalProfileId]),
      db.query(`
        WITH current_cycles AS (
          SELECT cycle.id
          FROM public.pto_entitlement_cycles cycle
          JOIN public.pto_policies policy ON policy.id = cycle.policy_id
          WHERE public.pto_canonical_profile_id(cycle.profile_id) = $2
            AND cycle.starts_on = public.pto_cycle_start(
              CURRENT_DATE, policy.renewal_month, policy.renewal_day
            )
        ), allocation_activity AS (
          SELECT
            COALESCE(SUM(allocation.charged_days) FILTER (WHERE allocation.state = 'reserved'), 0) AS reserved_days,
            COALESCE(SUM(allocation.charged_days) FILTER (WHERE allocation.state = 'consumed'), 0) AS consumed_days
          FROM public.pto_request_allocations allocation
          JOIN current_cycles cycle ON cycle.id = allocation.cycle_id
          JOIN public.time_off_requests request ON request.id = allocation.request_id
          WHERE request.franchiseid = $1
        ), adjustment_activity AS (
          SELECT COALESCE(SUM(ledger.balance_delta), 0) AS adjustment_days
          FROM public.pto_ledger_entries ledger
          JOIN current_cycles cycle ON cycle.id = ledger.cycle_id
          WHERE ledger.event_type = 'adjustment' AND ledger.source_membership_id = $3
        )
        SELECT allocation_activity.reserved_days, allocation_activity.consumed_days,
          adjustment_activity.adjustment_days
        FROM allocation_activity CROSS JOIN adjustment_activity
      `, [account.franchiseId, canonicalProfileId, account.membershipId])
    ]);
    const reservedDays = numeric(activity.rows[0]?.reserved_days);
    const consumedDays = numeric(activity.rows[0]?.consumed_days);
    const adjustmentDays = numeric(activity.rows[0]?.adjustment_days);
    const remainingAvailableDays = availableDays + reservedDays + consumedDays - adjustmentDays;
    const detachedAvailableDays = grantedDays + adjustmentDays - reservedDays - consumedDays;
    const ambiguousAdjustmentIds = ambiguous.rows.map((row) => String(row.id));
    const warnings = [...account.warnings];
    if (ambiguousAdjustmentIds.length) {
      warnings.push('Legacy adjustments require membership reconciliation before unlinking');
    }
    return {
      mode: 'unlink',
      profileId: canonicalProfileId,
      account,
      version: account.version,
      beforeBalances: [{ profileId: canonicalProfileId, availableDays }],
      afterBalances: [
        { profileId: canonicalProfileId, availableDays: remainingAvailableDays },
        { profileId: `detached:${account.id}`, availableDays: detachedAvailableDays }
      ],
      affectedRequestIds: requests.rows.map((row) => String(row.id)),
      ambiguousAdjustmentIds,
      warnings
    };
  },

  unlinkAccount: async (input: PtoAccountLinkMutationInput): Promise<PtoAccountLinkMutationResult> => {
    const result = await db.query(`
      SELECT public.pto_admin_unlink_account($1, $2, $3, $4, $5, $6) AS result
    `, [input.profileId, input.accountId, input.actorId, input.actorFranchiseId,
      input.expectedVersion, input.idempotencyKey]);
    const value = result.rows[0]?.result as Record<string, unknown> | undefined;
    if (!value) throw new Error('PTO account unlink did not return a result');
    return {
      canonicalProfileId: String(value.canonicalProfileId),
      detachedProfileId: value.detachedProfileId == null ? null : String(value.detachedProfileId),
      decisionVersion: numeric(value.decisionVersion)
    };
  },

  assignAdjustmentProvenance: async (
    input: AssignPtoAdjustmentProvenanceInput
  ): Promise<PtoAdjustmentProvenanceResult> => {
    const result = await db.query(`
      SELECT public.pto_admin_assign_adjustment_provenance($1, $2, $3, $4, $5, $6) AS result
    `, [input.profileId, input.ledgerEntryId, input.membershipId, input.actorId,
      input.actorFranchiseId, input.idempotencyKey]);
    const value = result.rows[0]?.result as Record<string, unknown> | undefined;
    if (!value) throw new Error('PTO adjustment provenance did not return a result');
    return { ledgerEntryId: String(value.ledgerEntryId), membershipId: String(value.membershipId) };
  }
});
