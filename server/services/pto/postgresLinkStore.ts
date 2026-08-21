import type {
  PtoAccountLinkBaseInput,
  PtoAccountLinkMutationInput,
  PtoAccountLinkMutationResult,
  PtoAccountLinkPreview,
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
  }
});
