import crypto from 'crypto';
import { DateTime } from 'luxon';

export type ScheduleSnapshotVersion = 1;

export type ScheduleSnapshotInterval = {
  startAt: string; // ISO timestamp with timezone offset
  endAt: string; // ISO timestamp with timezone offset
};

export type ScheduleSnapshotEntry = {
  timeId: number;
  timeLabel: string;
};

export type ScheduleSnapshotV1 = {
  version: 1;
  franchiseId: number;
  tutorId: number;
  workDate: string; // YYYY-MM-DD in franchise timezone
  timezone: string;
  slotMinutes: number;
  entries: ScheduleSnapshotEntry[];
  intervals: ScheduleSnapshotInterval[];
  issuedAt: string; // ISO timestamp (UTC)
  signature?: string;
};

export const getScheduleSlotMinutes = (): number => {
  const raw = process.env.SCHEDULE_SLOT_MINUTES;
  if (raw === undefined || raw === null || raw === '') return 60;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 24 * 60) {
    throw new Error('[schedule] SCHEDULE_SLOT_MINUTES must be an integer between 1 and 1440');
  }
  return parsed;
};

export const getScheduleSnapshotSigningSecret = (): string | null => {
  const raw = process.env.SCHEDULE_SNAPSHOT_SIGNING_SECRET;
  if (!raw) return null;
  const trimmed = String(raw).trim();
  return trimmed ? trimmed : null;
};

const isPlainObject = (value: unknown): value is Record<string, unknown> => {
  if (value === null || value === undefined) return false;
  if (typeof value !== 'object') return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

const parseIsoDateOnly = (value: unknown): string | null => {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const dt = DateTime.fromISO(trimmed, { zone: 'UTC', setZone: true });
  if (!dt.isValid) return null;

  return dt.toISODate() ?? null;
};

export const parseScheduleSnapshotV1 = (value: unknown): ScheduleSnapshotV1 | null => {
  if (!isPlainObject(value)) return null;
  if (value.version !== 1) return null;

  const record = value as Record<string, unknown>;

  const franchiseId = Number(record.franchiseId);
  const tutorId = Number(record.tutorId);
  const workDate = parseIsoDateOnly(record.workDate);
  const timezone = typeof record.timezone === 'string' ? record.timezone.trim() : '';
  const slotMinutes = Number(record.slotMinutes);

  if (!Number.isFinite(franchiseId) || !Number.isFinite(tutorId)) return null;
  if (!workDate) return null;
  if (!timezone) return null;
  if (!Number.isInteger(slotMinutes) || slotMinutes <= 0) return null;

  const entriesRaw = record.entries;
  const intervalsRaw = record.intervals;
  const issuedAt = typeof record.issuedAt === 'string' ? record.issuedAt : '';

  if (!Array.isArray(entriesRaw) || !Array.isArray(intervalsRaw)) return null;

  const entries = entriesRaw
    .filter((entry) => isPlainObject(entry))
    .map((entry) => ({
      timeId: Number((entry as Record<string, unknown>).timeId),
      timeLabel: typeof (entry as Record<string, unknown>).timeLabel === 'string' ? String((entry as Record<string, unknown>).timeLabel) : ''
    }))
    .filter((entry) => Number.isFinite(entry.timeId));

  const intervals = intervalsRaw
    .filter((interval) => isPlainObject(interval))
    .map((interval) => ({
      startAt: typeof (interval as Record<string, unknown>).startAt === 'string' ? String((interval as Record<string, unknown>).startAt) : '',
      endAt: typeof (interval as Record<string, unknown>).endAt === 'string' ? String((interval as Record<string, unknown>).endAt) : ''
    }))
    .filter((interval) => Boolean(interval.startAt) && Boolean(interval.endAt));

  const signature = typeof record.signature === 'string' ? record.signature : undefined;

  return {
    version: 1,
    franchiseId,
    tutorId,
    workDate,
    timezone,
    slotMinutes,
    entries,
    intervals,
    issuedAt,
    signature
  };
};

const canonicalizeJson = (value: unknown): unknown => {
  if (Array.isArray(value)) {
    return value.map(canonicalizeJson);
  }

  if (isPlainObject(value)) {
    const input = value as Record<string, unknown>;
    const output: Record<string, unknown> = {};
    Object.keys(input)
      .sort((a, b) => a.localeCompare(b))
      .forEach((key) => {
        const v = input[key];
        if (v === undefined) return;
        output[key] = canonicalizeJson(v);
      });
    return output;
  }

  return value;
};

export const canonicalJsonStringify = (value: unknown): string => JSON.stringify(canonicalizeJson(value));

const computeSignature = (payload: unknown, secret: string): string => {
  const canonical = canonicalJsonStringify(payload);
  return crypto.createHmac('sha256', secret).update(canonical, 'utf8').digest('base64url');
};

export const signScheduleSnapshot = (snapshot: ScheduleSnapshotV1, secret: string): ScheduleSnapshotV1 => {
  const { signature: _signature, ...unsigned } = snapshot;
  const signature = computeSignature(unsigned, secret);
  return { ...snapshot, signature };
};

export const verifyScheduleSnapshot = (
  snapshot: ScheduleSnapshotV1,
  secret: string
): { ok: true } | { ok: false; error: string } => {
  if (!snapshot.signature) {
    return { ok: false, error: 'Missing schedule snapshot signature' };
  }

  const { signature, ...unsigned } = snapshot;
  const expected = computeSignature(unsigned, secret);

  const a = Buffer.from(signature);
  const b = Buffer.from(expected);

  if (a.length !== b.length) {
    return { ok: false, error: 'Invalid schedule snapshot signature' };
  }

  const matches = crypto.timingSafeEqual(a, b);
  return matches ? { ok: true } : { ok: false, error: 'Invalid schedule snapshot signature' };
};

const TIME_RANGE_SEPARATORS = [/–/g, /—/g];

const parseTimeOfDay = (raw: string, timezone: string): { hour: number; minute: number } | null => {
  const cleaned = raw.trim();
  if (!cleaned) return null;

  const formats = ['h:mm a', 'h:mma', 'h a', 'ha', 'H:mm', 'HH:mm', 'H:mm:ss', 'HH:mm:ss'];

  for (const fmt of formats) {
    const parsed = DateTime.fromFormat(cleaned, fmt, { zone: timezone, setZone: true });
    if (!parsed.isValid) continue;
    return { hour: parsed.hour, minute: parsed.minute };
  }

  const isoParsed = DateTime.fromISO(cleaned, { zone: timezone, setZone: true });
  if (isoParsed.isValid) {
    return { hour: isoParsed.hour, minute: isoParsed.minute };
  }

  return null;
};

export const deriveIntervalsFromEntries = (params: {
  workDate: string;
  timezone: string;
  slotMinutes: number;
  entries: ScheduleSnapshotEntry[];
}): ScheduleSnapshotInterval[] => {
  const baseDate = DateTime.fromISO(params.workDate, { zone: params.timezone, setZone: true }).startOf('day');
  if (!baseDate.isValid) return [];

  const intervals: ScheduleSnapshotInterval[] = [];

  for (const entry of params.entries) {
    const labelRaw = entry.timeLabel ?? '';
    const normalizedLabel = TIME_RANGE_SEPARATORS.reduce((acc, re) => acc.replace(re, '-'), String(labelRaw)).trim();
    if (!normalizedLabel) continue;

    const parts = normalizedLabel.split(/\s*-\s*/).filter(Boolean);
    const startPart = parts[0] ?? '';
    const endPart = parts.length >= 2 ? parts[1] : '';

    const startTime = parseTimeOfDay(startPart, params.timezone);
    if (!startTime) continue;

    const startLocal = baseDate.set({ hour: startTime.hour, minute: startTime.minute, second: 0, millisecond: 0 });
    if (!startLocal.isValid) continue;

    let endLocal: DateTime | null = null;
    if (endPart) {
      const endTime = parseTimeOfDay(endPart, params.timezone);
      if (endTime) {
        endLocal = baseDate.set({ hour: endTime.hour, minute: endTime.minute, second: 0, millisecond: 0 });
      }
    }

    const computedEnd = endLocal && endLocal.isValid ? endLocal : startLocal.plus({ minutes: params.slotMinutes });
    if (!computedEnd.isValid) continue;
    if (computedEnd <= startLocal) continue;

    intervals.push({
      startAt: startLocal.toISO() ?? '',
      endAt: computedEnd.toISO() ?? ''
    });
  }

  return intervals.filter((interval) => Boolean(interval.startAt) && Boolean(interval.endAt));
};

