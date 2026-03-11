import { DateTime } from 'luxon';
import { getPostgresPool } from '../db/postgres';

type PayPeriodType = 'weekly' | 'biweekly' | 'semimonthly' | 'monthly' | 'custom_semimonthly';

export interface CustomSemimonthlyConfig {
  period1StartDay: number;
  period1EndDay: number;
  period2StartDay: number;
  period2EndDay: number;
}

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
  customPeriod1StartDay: number | null;
  customPeriod1EndDay: number | null;
  customPeriod2StartDay: number | null;
  customPeriod2EndDay: number | null;
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

const VALID_PAY_PERIOD_TYPES: PayPeriodType[] = [
  'weekly',
  'biweekly',
  'semimonthly',
  'monthly',
  'custom_semimonthly'
];

const VALID_CUSTOM_DAY_MIN = 1;
const VALID_CUSTOM_DAY_MAX = 31;

const createStatusError = (status: number, message: string): Error & { status: number } =>
  Object.assign(new Error(message), { status });

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

export const isPayPeriodType = (value: unknown): value is PayPeriodType =>
  typeof value === 'string' && VALID_PAY_PERIOD_TYPES.includes(value.trim().toLowerCase() as PayPeriodType);

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

const nextRecurringDay = (day: number): number => (day === VALID_CUSTOM_DAY_MAX ? VALID_CUSTOM_DAY_MIN : day + 1);

const coerceIntegerOrNull = (value: unknown): number | null => {
  if (value === undefined || value === null || value === '') return null;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) return null;
  return parsed;
};

const isValidCustomDay = (value: number): boolean =>
  Number.isInteger(value) && value >= VALID_CUSTOM_DAY_MIN && value <= VALID_CUSTOM_DAY_MAX;

const clampDayToMonth = (monthLocal: DateTime, day: number): number => Math.min(day, getLastDayOfMonth(monthLocal).day);

const toCustomSemimonthlyConfig = (settings: FranchisePayrollSettings): CustomSemimonthlyConfig | null => {
  if (
    settings.customPeriod1StartDay === null ||
    settings.customPeriod1EndDay === null ||
    settings.customPeriod2StartDay === null ||
    settings.customPeriod2EndDay === null
  ) {
    return null;
  }

  return {
    period1StartDay: settings.customPeriod1StartDay,
    period1EndDay: settings.customPeriod1EndDay,
    period2StartDay: settings.customPeriod2StartDay,
    period2EndDay: settings.customPeriod2EndDay
  };
};

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
           , custom_period_1_start_day, custom_period_1_end_day
           , custom_period_2_start_day, custom_period_2_end_day
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
      autoEmailEnabled: DEFAULT_AUTO_EMAIL_ENABLED,
      customPeriod1StartDay: null,
      customPeriod1EndDay: null,
      customPeriod2StartDay: null,
      customPeriod2EndDay: null
    };
  }

  const row = result.rows[0];
  return {
    franchiseId,
    policyType: row.policytype ?? DEFAULT_POLICY_TYPE,
    timezone: normalizeTimezone(row.timezone),
    payPeriodType: normalizePayPeriodType(row.pay_period_type),
    autoEmailEnabled: parseBoolean(row.auto_email_enabled, DEFAULT_AUTO_EMAIL_ENABLED),
    customPeriod1StartDay: coerceIntegerOrNull(row.custom_period_1_start_day),
    customPeriod1EndDay: coerceIntegerOrNull(row.custom_period_1_end_day),
    customPeriod2StartDay: coerceIntegerOrNull(row.custom_period_2_start_day),
    customPeriod2EndDay: coerceIntegerOrNull(row.custom_period_2_end_day)
  };
};

export const getFranchisePayrollSettings = fetchPayrollSettings;

export const validateCustomSemimonthlyConfig = (
  config: CustomSemimonthlyConfig
): { ok: true } | { ok: false; error: string } => {
  const days = [
    config.period1StartDay,
    config.period1EndDay,
    config.period2StartDay,
    config.period2EndDay
  ];

  if (!days.every(isValidCustomDay)) {
    return { ok: false, error: 'Custom recurring payroll day values must be integers between 1 and 31.' };
  }

  if (
    nextRecurringDay(config.period1EndDay) !== config.period2StartDay ||
    nextRecurringDay(config.period2EndDay) !== config.period1StartDay
  ) {
    return {
      ok: false,
      error: 'Custom recurring payroll periods must be contiguous and cover the full cycle.'
    };
  }

  const sampleStart = DateTime.fromISO('2024-01-01', { zone: 'UTC' }).startOf('day');
  const sampleEnd = DateTime.fromISO('2025-12-31', { zone: 'UTC' }).startOf('day');

  for (let cursor = sampleStart; cursor <= sampleEnd; cursor = cursor.plus({ days: 1 })) {
    const matches = findContainingCustomSemimonthlyWindows(cursor, config);
    if (matches.length !== 1) {
      return {
        ok: false,
        error: 'Custom recurring payroll periods create a gap or overlap for one or more calendar months.'
      };
    }
  }

  return { ok: true };
};

export const updateFranchisePayrollSettings = async (
  input: {
    franchiseId: number;
    payPeriodType: PayPeriodType;
    customPeriod1StartDay?: number;
    customPeriod1EndDay?: number;
    customPeriod2StartDay?: number;
    customPeriod2EndDay?: number;
  }
): Promise<FranchisePayrollSettings> => {
  const existing = await fetchPayrollSettings(input.franchiseId);

  const nextSettings: FranchisePayrollSettings = {
    ...existing,
    payPeriodType: input.payPeriodType
  };

  const customValues = [
    input.customPeriod1StartDay,
    input.customPeriod1EndDay,
    input.customPeriod2StartDay,
    input.customPeriod2EndDay
  ];
  const hasAnyCustomValues = customValues.some((value) => value !== undefined);
  const hasAllCustomValues = customValues.every((value) => value !== undefined);

  if (hasAnyCustomValues && !hasAllCustomValues) {
    throw createStatusError(400, 'Provide all four custom recurring payroll day values together.');
  }

  if (hasAllCustomValues) {
    nextSettings.customPeriod1StartDay = input.customPeriod1StartDay ?? null;
    nextSettings.customPeriod1EndDay = input.customPeriod1EndDay ?? null;
    nextSettings.customPeriod2StartDay = input.customPeriod2StartDay ?? null;
    nextSettings.customPeriod2EndDay = input.customPeriod2EndDay ?? null;

    const customConfig = toCustomSemimonthlyConfig(nextSettings);
    if (!customConfig) {
      throw createStatusError(400, 'Custom semimonthly pay periods require all four custom day values.');
    }

    const validation = validateCustomSemimonthlyConfig(customConfig);
    if (!validation.ok) {
      throw createStatusError(400, validation.error);
    }
  }

  if (nextSettings.payPeriodType === 'custom_semimonthly') {
    const customConfig = toCustomSemimonthlyConfig(nextSettings);
    if (!customConfig) {
      throw createStatusError(400, 'Custom semimonthly pay periods require all four custom day values.');
    }

    const validation = validateCustomSemimonthlyConfig(customConfig);
    if (!validation.ok) {
      throw createStatusError(400, validation.error);
    }
  }

  const pool = getPostgresPool();
  await pool.query(
    `
      INSERT INTO franchise_payroll_settings (
        franchiseid,
        policytype,
        timezone,
        pay_period_type,
        auto_email_enabled,
        custom_period_1_start_day,
        custom_period_1_end_day,
        custom_period_2_start_day,
        custom_period_2_end_day
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (franchiseid) DO UPDATE
      SET policytype = EXCLUDED.policytype,
          timezone = EXCLUDED.timezone,
          pay_period_type = EXCLUDED.pay_period_type,
          auto_email_enabled = EXCLUDED.auto_email_enabled,
          custom_period_1_start_day = EXCLUDED.custom_period_1_start_day,
          custom_period_1_end_day = EXCLUDED.custom_period_1_end_day,
          custom_period_2_start_day = EXCLUDED.custom_period_2_start_day,
          custom_period_2_end_day = EXCLUDED.custom_period_2_end_day,
          updatedat = NOW()
    `,
    [
      nextSettings.franchiseId,
      nextSettings.policyType,
      nextSettings.timezone,
      nextSettings.payPeriodType,
      nextSettings.autoEmailEnabled,
      nextSettings.customPeriod1StartDay,
      nextSettings.customPeriod1EndDay,
      nextSettings.customPeriod2StartDay,
      nextSettings.customPeriod2EndDay
    ]
  );

  return fetchPayrollSettings(input.franchiseId);
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

const buildCustomSemimonthlyWindow = (
  anchorMonthLocal: DateTime,
  startDay: number,
  endDay: number
): { startLocal: DateTime; endLocal: DateTime } => {
  const startMonthLocal = anchorMonthLocal.startOf('month').startOf('day');
  const startLocal = startMonthLocal.set({ day: clampDayToMonth(startMonthLocal, startDay) }).startOf('day');

  if (startDay <= endDay) {
    const endLocal = startMonthLocal.set({ day: clampDayToMonth(startMonthLocal, endDay) }).startOf('day');
    return { startLocal, endLocal };
  }

  const endMonthLocal = startMonthLocal.plus({ months: 1 }).startOf('month').startOf('day');
  const endLocal = endMonthLocal.set({ day: clampDayToMonth(endMonthLocal, endDay) }).startOf('day');
  return { startLocal, endLocal };
};

const findContainingCustomSemimonthlyWindows = (
  forDateLocal: DateTime,
  config: CustomSemimonthlyConfig
): Array<{ startLocal: DateTime; endLocal: DateTime }> => {
  const currentMonthLocal = forDateLocal.startOf('month').startOf('day');
  const anchorMonths = [
    currentMonthLocal.minus({ months: 1 }),
    currentMonthLocal,
    currentMonthLocal.plus({ months: 1 })
  ];

  const rawWindows = anchorMonths.flatMap((anchorMonthLocal) => [
    buildCustomSemimonthlyWindow(anchorMonthLocal, config.period1StartDay, config.period1EndDay),
    buildCustomSemimonthlyWindow(anchorMonthLocal, config.period2StartDay, config.period2EndDay)
  ]);

  const seen = new Set<string>();
  const uniqueWindows = rawWindows.filter((window) => {
    const key = `${formatLocalDateISO(window.startLocal)}:${formatLocalDateISO(window.endLocal)}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const target = forDateLocal.toMillis();
  return uniqueWindows.filter((window) => window.startLocal.toMillis() <= target && target <= window.endLocal.toMillis());
};

export const computeCustomSemimonthlyWindow = (
  forDateLocal: DateTime,
  config: CustomSemimonthlyConfig
): { startLocal: DateTime; endLocal: DateTime } => {
  const matches = findContainingCustomSemimonthlyWindows(forDateLocal, config);
  if (matches.length !== 1) {
    throw new Error('Invalid custom semimonthly payroll configuration for the requested date.');
  }

  return matches[0];
};

const computeMonthlyWindow = (forDateLocal: DateTime): { startLocal: DateTime; endLocal: DateTime } => {
  const startLocal = forDateLocal.startOf('month').startOf('day');
  const endLocal = getLastDayOfMonth(forDateLocal);
  return { startLocal, endLocal };
};

const computePayPeriodWindow = (
  periodType: PayPeriodType,
  forDateLocal: DateTime,
  timezone: string,
  settings?: FranchisePayrollSettings
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
    case 'custom_semimonthly': {
      const config = settings ? toCustomSemimonthlyConfig(settings) : null;
      if (!config) {
        throw new Error('Custom semimonthly pay period is missing recurring day configuration.');
      }
      return computeCustomSemimonthlyWindow(forDateLocal, config);
    }
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

  const { startLocal, endLocal } = computePayPeriodWindow(
    settings.payPeriodType,
    forDateLocal,
    settings.timezone,
    settings
  );

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
