import { createHash } from 'node:crypto';
import type { Pool, QueryResultRow } from 'pg';
import { getPostgresPool } from '../../db/postgres';
import type { PtoBalanceSummary, PtoEligibilityReason, PtoPolicyStatus, PtoQuote } from '../../types/pto';
import type { PtoCenterStatus } from './contracts';

export interface PtoQuoteDayCharge {
  date: string;
  days: number;
}

export interface AuthenticatedPtoQuoteInput {
  franchiseId: number;
  tutorId: number;
  balanceDate: string;
  chargeDays: number;
  dayCharges: PtoQuoteDayCharge[];
}

export interface PublicPtoQuoteInput {
  franchiseId: number;
  email: string;
  balanceDate: string;
  chargeDays: number;
  dayCharges: PtoQuoteDayCharge[];
}

type Queryable = Pick<Pool, 'query'>;

const number = (value: unknown): number => Number(value ?? 0);
const dateText = (value: unknown): string => value instanceof Date
  ? value.toISOString().slice(0, 10)
  : String(value).slice(0, 10);

const centerStatus = (franchiseId: number, row?: Record<string, unknown>): PtoCenterStatus => ({
  franchiseId,
  enabled: Boolean(row?.enabled),
  firstActivatedAt: row?.first_activated_at == null ? null : new Date(row.first_activated_at as string).toISOString(),
  lastSuccessfulSyncAt: row?.last_successful_sync_at == null ? null : new Date(row.last_successful_sync_at as string).toISOString(),
  lastSyncError: row?.last_sync_error == null ? null : String(row.last_sync_error)
});

const getStatus = async (db: Queryable, franchiseId: number): Promise<PtoCenterStatus> => {
  const result = await db.query(`
    SELECT enabled, first_activated_at, last_successful_sync_at, last_sync_error
    FROM public.pto_center_settings WHERE franchiseid = $1
  `, [franchiseId]);
  return centerStatus(franchiseId, result.rows[0]);
};

const resolveAuthenticatedProfile = async (db: Queryable, franchiseId: number, tutorId: number): Promise<string | null> => {
  const result = await db.query(`
    SELECT DISTINCT public.pto_canonical_profile_id(center.profile_id) AS profile_id
    FROM public.pto_profile_centers center
    JOIN public.pto_profiles profile ON profile.id = public.pto_canonical_profile_id(center.profile_id)
    JOIN public.pto_profile_crm_ids crm ON crm.profile_id = center.profile_id
    WHERE center.franchiseid = $1 AND center.tutor_id = $2 AND center.active AND profile.active
      AND crm.provider = 'timecard-center:' || ($1::INTEGER)::TEXT AND crm.crm_id = ($2::BIGINT)::TEXT
  `, [franchiseId, tutorId]);
  return result.rowCount === 1 ? String(result.rows[0].profile_id) : null;
};

const resolvePublicCenter = async (db: Queryable, token: string): Promise<{ franchiseId: number } | null> => {
  const tokenHash = createHash('sha256').update(token, 'utf8').digest('hex');
  const result = await db.query(`
    SELECT link.franchiseid
    FROM public.time_off_center_links link
    WHERE link.token_hash = $1 AND link.active
  `, [tokenHash]);
  return result.rowCount === 1 ? { franchiseId: number(result.rows[0].franchiseid) } : null;
};

const resolvePublicProfile = async (db: Queryable, franchiseId: number, emailAddress: string): Promise<string | null> => {
  const result = await db.query(`
    SELECT public.pto_canonical_profile_id(email.profile_id) AS profile_id
    FROM public.pto_profile_emails email
    JOIN public.pto_profile_centers center ON center.franchiseid = email.franchiseid
      AND center.active
      AND (center.id = email.source_membership_id
        OR (email.source_membership_id IS NULL AND center.profile_id = email.profile_id))
    JOIN public.pto_profiles profile ON profile.id = public.pto_canonical_profile_id(email.profile_id)
      AND profile.active
    WHERE email.franchiseid = $1 AND email.email = $2 AND email.active
    GROUP BY public.pto_canonical_profile_id(email.profile_id)
  `, [franchiseId, emailAddress]);
  return result.rowCount === 1 ? String(result.rows[0].profile_id) : null;
};

const balanceSummary = async (db: Queryable, profileId: string, balanceDate: string): Promise<PtoBalanceSummary> => {
  const result = await db.query(`
    WITH policy AS (
      SELECT * FROM public.pto_policies WHERE effective_from <= $2::DATE
      ORDER BY effective_from DESC LIMIT 1
    ), bounds AS (
      SELECT public.pto_cycle_start($2::DATE, renewal_month, renewal_day) AS cycle_start,
        entitlement_days FROM policy
    ), values AS (
      SELECT balance.*, bounds.cycle_start, bounds.entitlement_days,
        (bounds.cycle_start + INTERVAL '1 year' - INTERVAL '1 day')::DATE AS cycle_end
      FROM bounds
      LEFT JOIN LATERAL public.pto_profile_balance($1::BIGINT, bounds.cycle_start) balance ON TRUE
    ), activity AS (
      SELECT
        COALESCE(SUM(ledger.balance_delta) FILTER (WHERE ledger.event_type = 'adjustment'), 0) AS adjusted_days,
        COALESCE(-SUM(ledger.balance_delta) FILTER (WHERE ledger.event_type = 'consume'), 0) AS used_days
      FROM public.pto_entitlement_cycles cycle
      LEFT JOIN public.pto_ledger_entries ledger ON ledger.cycle_id = cycle.id
      WHERE public.pto_canonical_profile_id(cycle.profile_id) = public.pto_canonical_profile_id($1::BIGINT)
        AND cycle.starts_on = (SELECT cycle_start FROM bounds)
    )
    SELECT values.*, activity.adjusted_days, activity.used_days FROM values CROSS JOIN activity
  `, [profileId, balanceDate]);
  const row = result.rows[0] as Record<string, unknown> | undefined;
  if (!row) throw new Error('No PTO policy applies to the requested date');
  const cycleStart = dateText(row.cycle_start);
  const cycleEnd = dateText(row.cycle_end);
  const grantedDays = number(row.grant_count) > 0 ? number(row.granted_days) : number(row.entitlement_days);
  const adjustedDays = number(row.adjusted_days);
  const reservedDays = number(row.reserved_days);
  const usedDays = number(row.used_days);
  return {
    cycleStart,
    cycleEnd,
    renewsOn: new Date(`${cycleEnd}T00:00:00.000Z`).toISOString().slice(0, 10).replace(/-\d{2}-\d{2}$/, '') === ''
      ? cycleEnd
      : new Date(Date.parse(`${cycleEnd}T00:00:00.000Z`) + 86_400_000).toISOString().slice(0, 10),
    grantedDays,
    adjustedDays,
    availableDays: number(row.grant_count) > 0 ? number(row.available_days) : grantedDays + adjustedDays - reservedDays - usedDays,
    reservedDays,
    usedDays
  };
};

const cycleAllocations = async (db: Queryable, charges: PtoQuoteDayCharge[]) => {
  if (charges.length === 0) return [];
  const result = await db.query(`
    WITH charges AS (
      SELECT * FROM JSONB_TO_RECORDSET($1::JSONB) AS charge(date DATE, days NUMERIC)
    ), mapped AS (
      SELECT charge.days,
        public.pto_cycle_start(charge.date, policy.renewal_month, policy.renewal_day) AS cycle_start
      FROM charges charge
      JOIN LATERAL (
        SELECT * FROM public.pto_policies WHERE effective_from <= charge.date
        ORDER BY effective_from DESC LIMIT 1
      ) policy ON TRUE
      WHERE charge.days > 0
    )
    SELECT cycle_start, SUM(days) AS days FROM mapped GROUP BY cycle_start ORDER BY cycle_start
  `, [JSON.stringify(charges)]);
  return result.rows.map((row: QueryResultRow) => ({ cycleStart: dateText(row.cycle_start), days: number(row.days) }));
};

const buildQuote = async (
  db: Queryable,
  context: { franchiseId: number; profileId: string } | null,
  chargeDays: number,
  charges: PtoQuoteDayCharge[],
  authenticated: boolean,
  balanceDate: string,
  missingReason: PtoEligibilityReason = 'identity_unresolved'
): Promise<PtoQuote> => {
  const allocations = await cycleAllocations(db, charges);
  if (!context) return { eligible: false, reason: missingReason, chargeDays, cycleAllocations: allocations };
  const status = await getStatus(db, context.franchiseId);
  if (!status.enabled) return { eligible: false, reason: 'center_disabled', chargeDays, cycleAllocations: allocations };
  const summaries = await Promise.all(allocations.map((allocation) => balanceSummary(db, context.profileId, allocation.cycleStart)));
  const insufficient = allocations.some((allocation, index) => allocation.days > (summaries[index]?.availableDays ?? 0));
  const noBalance = summaries.length > 0 && summaries.every((summary) => summary.availableDays <= 0);
  const reason: PtoEligibilityReason = noBalance ? 'no_balance' : insufficient ? 'insufficient_balance' : 'eligible';
  const result: PtoQuote = { eligible: reason === 'eligible', reason, chargeDays, cycleAllocations: allocations };
  if (authenticated) result.balance = await balanceSummary(db, context.profileId, balanceDate);
  return result;
};

export const createPtoRouteStore = (pool: Pool) => ({
  authorizePublicCenter: (token: string) => resolvePublicCenter(pool, token),
  getBalanceSummary: (profileId: string, balanceDate: string) => balanceSummary(pool, profileId, balanceDate),
  getPolicyStatus: async (input: { franchiseId: number; tutorId: number; balanceDate: string }): Promise<PtoPolicyStatus> => {
    const status = await getStatus(pool, input.franchiseId);
    if (!status.enabled) return { enabled: false, reason: 'center_disabled' };
    const profileId = await resolveAuthenticatedProfile(pool, input.franchiseId, input.tutorId);
    if (!profileId) return { enabled: true, reason: 'identity_unresolved' };
    const summary = await balanceSummary(pool, profileId, input.balanceDate);
    return { enabled: true, reason: summary.availableDays > 0 ? 'eligible' : 'no_balance', balance: summary };
  },
  quoteAuthenticated: async (input: AuthenticatedPtoQuoteInput) => {
    const profileId = await resolveAuthenticatedProfile(pool, input.franchiseId, input.tutorId);
    return buildQuote(
      pool,
      profileId ? { franchiseId: input.franchiseId, profileId } : null,
      input.chargeDays,
      input.dayCharges,
      true,
      input.balanceDate
    );
  },
  quotePublic: async (input: PublicPtoQuoteInput) => {
    const profileId = await resolvePublicProfile(pool, input.franchiseId, input.email);
    return buildQuote(
      pool,
      profileId ? { franchiseId: input.franchiseId, profileId } : null,
      input.chargeDays,
      input.dayCharges,
      false,
      input.balanceDate
    );
  },
  deactivateCenter: async (input: { franchiseId: number; actorId: string }): Promise<PtoCenterStatus> => {
    const result = await pool.query('SELECT * FROM public.pto_deactivate_center($1, $2)', [input.franchiseId, input.actorId]);
    return centerStatus(input.franchiseId, result.rows[0]);
  }
});

let defaultStore: ReturnType<typeof createPtoRouteStore> | undefined;
const store = () => defaultStore ??= createPtoRouteStore(getPostgresPool());
export const getPtoBalanceSummary = (profileId: string, balanceDate: string) => store().getBalanceSummary(profileId, balanceDate);
export const authorizePublicPtoCenter = (token: string) => store().authorizePublicCenter(token);
export const getAuthenticatedPtoPolicyStatus = (input: { franchiseId: number; tutorId: number; balanceDate: string }) =>
  store().getPolicyStatus(input);
export const quoteAuthenticatedPto = (input: AuthenticatedPtoQuoteInput) => store().quoteAuthenticated(input);
export const quotePublicPto = (input: PublicPtoQuoteInput) => store().quotePublic(input);
export const deactivatePtoCenter = (input: { franchiseId: number; actorId: string }) => store().deactivateCenter(input);
