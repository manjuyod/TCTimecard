import { DateTime } from 'luxon';
import { getPostgresPool } from '../db/postgres';

type PayPeriodType = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly';

export interface PayPeriod {
  franchiseId: number;
  timezone: string;
  periodType: PayPeriodType;
  startDate: string;
  endDate: string;
  startAt: string;
  endAt: string;
  source: 'override' | 'computed';
  overrideId: number | null;
  resolvedForDate: string;
}

interface FranchisePayrollSettings {
  franchiseId: number;
  policyType: string;
  timezone: string;
  payPeriodType: PayPeriodType;
  autoEmailEnabled: boolean;
}

interface PayPeriodOverrideRow {
  id: number;
  periodstart: string;
  periodend: string;
  createdat: string;
}

const DEFAULT_TIMEZONE = 'America/Los_Angeles';
const DEFAULT_PAY_PERIOD_TYPE: PayPeriodType = 'biweekly';
const DEFAULT_POLICY_TYPE = 'strict_approval';
const DEFAULT_AUTO_EMAIL_ENABLED = false;
const DEFAULT_BIWEEKLY_ANCHOR = '2024-01-01';

const VALID_PAY_PERIOD_TYPES: PayPeriodType[] = ['weekly', 'biweekly', 'semimonthly', 'monthly'];

const normalizeTimezone = (timezone?: string | null): string => {
  if (!timezone) return DEFAULT_TIMEZONE;
  const safeTz = String(timezone).trim();
  const dt = DateTime.now().setZone(safeTz);
  return dt.isValid ? safeTz : DEFAULT_TIMEZONE;
};

const normalizePayPeriodType = (value?: string | null): PayPeriodType => {
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase() as PayPeriodType;
    if (VALID_PAY_PERIOD_TYPES.includes(normalized)) {
      return normalized;
    }
  }
  return DEFAULT_PAY_PERIOD_TYPE;
};

const parseBoolean = (value: unknown, fallback: boolean): boolean => {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).toLowerCase();
  if (['true', '1', 'yes', 'on', 'y'].includes(normalized)) return true;
  if (['false', '0', 'no', 'off', 'n'].includes(normalized)) return false;
  return fallback;
};

export const parseLocalDate = (dateISO: string | null, timezone: string): DateTime => {
  const zone = normalizeTimezone(timezone);
  if (!dateISO) {
    return DateTime.now().setZone(zone).startOf('day');
  }
  return DateTime.fromISO(dateISO, { zone, setZone: true }).startOf('day');
};

export const formatLocalDateISO = (dt: DateTime): string => dt.toISODate()!;

export const getLastDayOfMonth = (dt: DateTime): DateTime => dt.endOf('month').startOf('day');

export const localDateRangeToUtcBounds = (
  startLocal: DateTime,
  endLocal: DateTime
): { startAtUtcISO: string; endAtUtcISO: string } => {
  const startAtUtcISO = startLocal.startOf('day').toUTC().toISO();
  const endAtUtcISO = endLocal.startOf('day').plus({ days: 1 }).toUTC().toISO();
  return { startAtUtcISO: startAtUtcISO!, endAtUtcISO: endAtUtcISO! };
};

const fetchPayrollSettings = async (franchiseId: number): Promise<FranchisePayrollSettings> => {
  const pool = getPostgresPool();
  const result = await pool.query(
    `
      SELECT franchiseid, policytype, timezone, pay_period_type, auto_email_enabled
      FROM franchise_payroll_settings
      WHERE franchiseid = $1
      LIMIT 1
    `,
    [franchiseId]
  );

  if (!result.rowCount) {
    return {
      franchiseId,
      policyType: DEFAULT_POLICY_TYPE,
      timezone: DEFAULT_TIMEZONE,
      payPeriodType: DEFAULT_PAY_PERIOD_TYPE,
      autoEmailEnabled: DEFAULT_AUTO_EMAIL_ENABLED
    };
  }

  const row = result.rows[0];
  return {
    franchiseId,
    policyType: row.policytype ?? DEFAULT_POLICY_TYPE,
    timezone: normalizeTimezone(row.timezone),
    payPeriodType: normalizePayPeriodType(row.pay_period_type),
    autoEmailEnabled: parseBoolean(row.auto_email_enabled, DEFAULT_AUTO_EMAIL_ENABLED)
  };
};

const findMatchingOverride = async (
  franchiseId: number,
  forDateLocal: DateTime,
  timezone: string
): Promise<{ override: PayPeriodOverrideRow; startLocal: DateTime; endLocal: DateTime } | null> => {
  const pool = getPostgresPool();
  const targetDate = formatLocalDateISO(forDateLocal);

  const result = await pool.query(
    `
      SELECT id, periodstart, periodend, createdat
      FROM franchise_pay_period_overrides
      WHERE franchiseid = $1
        AND periodstart <= $2
        AND periodend >= $2
      ORDER BY createdat DESC, id DESC
      LIMIT 1
    `,
    [franchiseId, targetDate]
  );

  if (!result.rowCount) return null;

  const row = result.rows[0] as PayPeriodOverrideRow;
  const startLocal = DateTime.fromISO(row.periodstart, { zone: timezone, setZone: true }).startOf('day');
  const endLocal = DateTime.fromISO(row.periodend, { zone: timezone, setZone: true }).startOf('day');

  return { override: row, startLocal, endLocal };
};

const resolveBiweeklyAnchor = (timezone: string): DateTime => {
  const configured = process.env.BIWEEKLY_ANCHOR_DATE || DEFAULT_BIWEEKLY_ANCHOR;
  const attempt = DateTime.fromISO(configured, { zone: timezone, setZone: true }).startOf('day');
  if (attempt.isValid) return attempt;

  const fallback = DateTime.fromISO(DEFAULT_BIWEEKLY_ANCHOR, { zone: timezone, setZone: true }).startOf('day');
  return fallback.isValid ? fallback : DateTime.now().setZone(timezone).startOf('day');
};

const computeWeeklyWindow = (forDateLocal: DateTime): { startLocal: DateTime; endLocal: DateTime } => {
  const startLocal = forDateLocal.startOf('day').minus({ days: forDateLocal.weekday - 1 });
  const endLocal = startLocal.plus({ days: 6 });
  return { startLocal, endLocal };
};

const computeBiweeklyWindow = (forDateLocal: DateTime, timezone: string): { startLocal: DateTime; endLocal: DateTime } => {
  const anchorLocal = resolveBiweeklyAnchor(timezone);
  const dayDiff = Math.floor(forDateLocal.startOf('day').diff(anchorLocal, 'days').days);
  const k = Math.floor(dayDiff / 14);
  const startLocal = anchorLocal.plus({ days: k * 14 });
  const endLocal = startLocal.plus({ days: 13 });
  return { startLocal, endLocal };
};

const computeSemimonthlyWindow = (forDateLocal: DateTime): { startLocal: DateTime; endLocal: DateTime } => {
  if (forDateLocal.day <= 15) {
    const startLocal = forDateLocal.startOf('month').startOf('day');
    const endLocal = forDateLocal.set({ day: 15 }).startOf('day');
    return { startLocal, endLocal };
  }

  const startLocal = forDateLocal.set({ day: 16 }).startOf('day');
  const endLocal = getLastDayOfMonth(forDateLocal);
  return { startLocal, endLocal };
};

const computeMonthlyWindow = (forDateLocal: DateTime): { startLocal: DateTime; endLocal: DateTime } => {
  const startLocal = forDateLocal.startOf('month').startOf('day');
  const endLocal = getLastDayOfMonth(forDateLocal);
  return { startLocal, endLocal };
};

const computePayPeriodWindow = (
  periodType: PayPeriodType,
  forDateLocal: DateTime,
  timezone: string
): { startLocal: DateTime; endLocal: DateTime } => {
  switch (periodType) {
    case 'weekly':
      return computeWeeklyWindow(forDateLocal);
    case 'biweekly':
      return computeBiweeklyWindow(forDateLocal, timezone);
    case 'semimonthly':
      return computeSemimonthlyWindow(forDateLocal);
    case 'monthly':
      return computeMonthlyWindow(forDateLocal);
    default:
      return computeBiweeklyWindow(forDateLocal, timezone);
  }
};

const buildPayPeriod = (
  params: {
    franchiseId: number;
    timezone: string;
    periodType: PayPeriodType;
    source: 'override' | 'computed';
    overrideId: number | null;
    startLocal: DateTime;
    endLocal: DateTime;
    resolvedForDate: DateTime;
  }
): PayPeriod => {
  const { startAtUtcISO, endAtUtcISO } = localDateRangeToUtcBounds(params.startLocal, params.endLocal);

  return {
    franchiseId: params.franchiseId,
    timezone: params.timezone,
    periodType: params.periodType,
    startDate: formatLocalDateISO(params.startLocal),
    endDate: formatLocalDateISO(params.endLocal),
    startAt: startAtUtcISO,
    endAt: endAtUtcISO,
    source: params.source,
    overrideId: params.overrideId,
    resolvedForDate: formatLocalDateISO(params.resolvedForDate)
  };
};

export const resolvePayPeriod = async (franchiseId: number, forDateISO: string | null): Promise<PayPeriod> => {
  const settings = await fetchPayrollSettings(franchiseId);
  const forDateLocal = parseLocalDate(forDateISO, settings.timezone);

  const overrideMatch = await findMatchingOverride(franchiseId, forDateLocal, settings.timezone);
  if (overrideMatch) {
    return buildPayPeriod({
      franchiseId,
      timezone: settings.timezone,
      periodType: settings.payPeriodType,
      source: 'override',
      overrideId: overrideMatch.override.id,
      startLocal: overrideMatch.startLocal,
      endLocal: overrideMatch.endLocal,
      resolvedForDate: forDateLocal
    });
  }

  const { startLocal, endLocal } = computePayPeriodWindow(settings.payPeriodType, forDateLocal, settings.timezone);

  return buildPayPeriod({
    franchiseId,
    timezone: settings.timezone,
    periodType: settings.payPeriodType,
    source: 'computed',
    overrideId: null,
    startLocal,
    endLocal,
    resolvedForDate: forDateLocal
  });
};

export type { PayPeriodType, FranchisePayrollSettings };
