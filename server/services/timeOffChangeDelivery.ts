import type { Pool, PoolClient } from 'pg';
import { buildGcalClientForSubject, CalendarClient } from './googleCalendar';
import { sendTimeOffGmailDwd, TimeOffEmailPayload } from './timeOffEmail';

const RETRY_DELAYS_MS = [30_000, 120_000, 600_000, 3_600_000, 21_600_000];
const DEFAULT_BATCH_SIZE = 20;
const EMAIL_ATTEMPT_TIMEOUT_MS = 20_000;
const CALENDAR_ATTEMPT_TIMEOUT_MS = 60_000;
const WORKER_INTERVAL_MS = 30_000;
const WORKER_SHUTDOWN_TIMEOUT_MS = 15_000;
const RATE_LIMIT_REASONS = ['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded'];

/** A provider attempt outcome; permanent failures skip the retry schedule. */
export class DeliveryAttemptError extends Error {
  constructor(message: string, public retryable: boolean) {
    super(message);
    this.name = 'DeliveryAttemptError';
  }
}
const permanent = (message: string) => new DeliveryAttemptError(message, false);
const statusOf = (error: unknown): number | undefined => (error as { status?: number } | null)?.status;

export interface CalendarJob {
  action: 'upsert' | 'delete';
  requestId: number;
  franchiseId: number;
  /** The calendar recorded for the request; `null` for a legacy approval. */
  calendarId: string | null;
  /** The franchise Gmail identity used as the impersonation subject. */
  identity: string | null;
  event: Record<string, unknown> | null;
  /** The latest verified event id for this request. */
  currentEventId: string | null;
  /** Other ids that may hold this request's event (cancellation cleanup). */
  cleanupEventIds: string[];
  recoveryEventId: string;
  targetVersion: string;
}

export interface CalendarSyncResult {
  eventId: string | null;
  calendarId: string;
}

/**
 * Converges one request's calendar event with a job's target. Mutates only
 * events that carry this request's ownership markers.
 */
export async function syncTimeOffCalendarJob(client: CalendarClient, job: CalendarJob, signal?: AbortSignal): Promise<CalendarSyncResult> {
  const call = async <T>(work: () => Promise<T>): Promise<T> => {
    signal?.throwIfAborted();
    const result = await work();
    signal?.throwIfAborted();
    return result;
  };
  if (!job.identity) throw permanent('Franchise GmailID is not configured for calendar updates.');
  if (job.calendarId && job.calendarId !== job.identity) {
    throw permanent('TIME_OFF_CALENDAR_REPAIR_REQUIRED: the franchise calendar changed since this event was created; repair it manually.');
  }
  const legacy = job.calendarId === null;
  const calendarId = job.calendarId ?? job.identity;
  let accessVerified = false;

  const ensureAccess = async () => {
    if (accessVerified) return;
    try {
      await call(() => client.assertCalendarAccess(calendarId, signal));
      accessVerified = true;
    } catch (error) {
      const classified = classifyDeliveryError(error);
      throw new DeliveryAttemptError(`Calendar access check failed: ${classified.message}`,
        classified.retryable && statusOf(error) !== 404);
    }
  };
  const lookup = async (eventId: string): Promise<{ state: 'present'; event: Record<string, unknown> } | { state: 'gone' }> => {
    try {
      const event = await call(() => client.getEvent(calendarId, eventId, signal));
      return event.status === 'cancelled' ? { state: 'gone' } : { state: 'present', event };
    } catch (error) {
      if (statusOf(error) === 410) return { state: 'gone' };
      if (statusOf(error) === 404) {
        await ensureAccess();
        return { state: 'gone' };
      }
      throw asAttemptError(error);
    }
  };
  const assertOwned = (event: Record<string, unknown>, eventId: string) => {
    const properties = (event.extendedProperties as { private?: Record<string, unknown> } | undefined)?.private;
    if (String(properties?.timeOffRequestId ?? '') !== String(job.requestId)
      || String(properties?.franchiseId ?? '') !== String(job.franchiseId)) {
      throw permanent(`Calendar event ${eventId} does not belong to time-off request ${job.requestId}.`);
    }
  };

  if (job.action === 'delete') {
    const candidates = [...new Set([job.currentEventId, ...job.cleanupEventIds].filter((id): id is string => Boolean(id)))];
    for (const eventId of candidates) {
      const found = await lookup(eventId);
      if (found.state === 'gone') {
        if (legacy && eventId === job.currentEventId) {
          throw permanent(`TIME_OFF_CALENDAR_REPAIR_REQUIRED: legacy calendar event ${eventId} could not be verified on ${calendarId}.`);
        }
        continue;
      }
      assertOwned(found.event, eventId);
      try {
        await call(() => client.deleteEvent(calendarId, eventId, signal));
      } catch (error) {
        if (statusOf(error) === 410) continue;
        if (statusOf(error) === 404) {
          await ensureAccess();
          continue;
        }
        throw asAttemptError(error);
      }
    }
    return { eventId: null, calendarId };
  }

  if (!job.event) throw permanent('Calendar job has no event payload.');
  const desired = withTargetVersion(job.event, job);
  const patchTo = async (eventId: string) => {
    await call(() => client.patchEvent(calendarId, eventId, eventPatch(desired), signal));
  };

  if (job.currentEventId) {
    const found = await lookup(job.currentEventId);
    if (found.state === 'present') {
      assertOwned(found.event, job.currentEventId);
      try {
        await patchTo(job.currentEventId);
        return { eventId: job.currentEventId, calendarId };
      } catch (error) {
        if (statusOf(error) === 404) await ensureAccess();
        else if (statusOf(error) !== 410) throw asAttemptError(error);
      }
    } else if (legacy) {
      throw permanent(`TIME_OFF_CALENDAR_REPAIR_REQUIRED: legacy calendar event ${job.currentEventId} could not be verified on ${calendarId}.`);
    }
  } else if (legacy) {
    throw permanent('TIME_OFF_CALENDAR_REPAIR_REQUIRED: this legacy approval has no recorded calendar event to update.');
  }

  // A prior attempt can create its recovery event and then lose its DB commit.
  // Adopt that owned event before allocating another version's recovery id.
  for (const eventId of new Set(job.cleanupEventIds)) {
    if (eventId === job.currentEventId || eventId === job.recoveryEventId) continue;
    const found = await lookup(eventId);
    if (found.state === 'gone') continue;
    assertOwned(found.event, eventId);
    await patchTo(eventId);
    return { eventId, calendarId };
  }

  // The verified event is gone: recreate it under this target's persisted id.
  try {
    await call(() => client.insertEvent(calendarId, { ...desired, id: job.recoveryEventId }, signal));
    return { eventId: job.recoveryEventId, calendarId };
  } catch (error) {
    if (statusOf(error) !== 409) throw asAttemptError(error);
  }
  const existing = await lookup(job.recoveryEventId);
  if (existing.state === 'gone') {
    throw permanent(`TIME_OFF_CALENDAR_REPAIR_REQUIRED: recovery event ${job.recoveryEventId} was deleted outside the app.`);
  }
  assertOwned(existing.event, job.recoveryEventId);
  if (!matchesDesired(existing.event, desired)) await patchTo(job.recoveryEventId);
  return { eventId: job.recoveryEventId, calendarId };
}

function withTargetVersion(event: Record<string, unknown>, job: CalendarJob): Record<string, unknown> {
  const { id: _id, ...rest } = event;
  const extended = (rest.extendedProperties as { private?: Record<string, unknown> } | undefined) ?? {};
  return {
    ...rest,
    extendedProperties: {
      ...extended,
      private: {
        ...(extended.private ?? {}),
        timeOffRequestId: String(job.requestId),
        franchiseId: String(job.franchiseId),
        timeOffTargetVersion: job.targetVersion
      }
    }
  };
}

/** A partial update that also clears the incompatible all-day/timed fields. */
function eventPatch(desired: Record<string, unknown>): Record<string, unknown> {
  const boundary = (value: unknown) => {
    const time = (value ?? {}) as { date?: string; dateTime?: string };
    return time.date
      ? { date: time.date, dateTime: null, timeZone: null }
      : { dateTime: time.dateTime ?? null, date: null };
  };
  return { ...desired, start: boundary(desired.start), end: boundary(desired.end) };
}

function matchesDesired(event: Record<string, unknown>, desired: Record<string, unknown>): boolean {
  const same = (left: unknown, right: unknown) => {
    const a = (left ?? {}) as { date?: string; dateTime?: string };
    const b = (right ?? {}) as { date?: string; dateTime?: string };
    const instant = (value?: string) => (value ? Date.parse(value) : null);
    return (a.date ?? null) === (b.date ?? null) && instant(a.dateTime) === instant(b.dateTime);
  };
  return event.summary === desired.summary && same(event.start, desired.start) && same(event.end, desired.end);
}

/** 1-based failed-attempt count to the next delay; `null` once attempts are exhausted. */
export function nextDeliveryRetryDelayMs(failedAttempts: number): number | null {
  return RETRY_DELAYS_MS[failedAttempts - 1] ?? null;
}

export function classifyDeliveryError(error: unknown): { retryable: boolean; message: string } {
  const message = sanitizeDeliveryError(error);
  if (error instanceof DeliveryAttemptError) return { retryable: error.retryable, message };
  const raw = error instanceof Error ? error.message : String(error);
  const status = statusOf(error) ?? parseStatus(raw);
  const reason = (error as { reason?: string } | null)?.reason ?? '';
  if (status === undefined) return { retryable: true, message };
  if (status === 408 || status === 429 || status >= 500) return { retryable: true, message };
  if (status === 403 && (RATE_LIMIT_REASONS.includes(reason) || RATE_LIMIT_REASONS.some((code) => raw.includes(code)))) {
    return { retryable: true, message };
  }
  return { retryable: false, message };
}

function parseStatus(message: string): number | undefined {
  const match = /failed[^0-9]{0,4}([1-5][0-9]{2})\b/i.exec(message);
  return match ? Number(match[1]) : undefined;
}

/** Stored errors never include credentials, bearer tokens, or token query values. */
export function sanitizeDeliveryError(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw
    .replace(/-----BEGIN [^-]+-----[\s\S]*?-----END [^-]+-----/g, '[redacted key]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
    .replace(/((?:access|refresh|id)_token|token|key|signature)=([^&\s"']+)/gi, '$1=[redacted]')
    .replace(/\bya29\.[A-Za-z0-9._-]+/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function asAttemptError(error: unknown): DeliveryAttemptError {
  const classified = classifyDeliveryError(error);
  return new DeliveryAttemptError(classified.message, classified.retryable);
}

async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    handle = setTimeout(() => reject(new DeliveryAttemptError(`${label} timed out after ${ms} ms`, true)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    if (handle) clearTimeout(handle);
  }
}

export interface TimeOffChangeDeliveryDeps {
  pool: Pool;
  calendarClientFor?: (subject: string) => CalendarClient;
  sendEmail?: (payload: TimeOffEmailPayload, impersonationSubject: string) => Promise<unknown>;
  /** The amendment expiry pass, run after deliveries (100 per pass by default). */
  expire?: (nowIso: string) => Promise<number>;
  batchSize?: number;
  calendarAttemptTimeoutMs?: number;
}

type Totals = { sent: number; failed: number; superseded: number };

/**
 * Runs one bounded delivery pass with a single database client: at most
 * `batchSize` due jobs, one calendar attempt per parent request, then expiry.
 */
export async function runTimeOffChangeDeliveryPass(
  deps: TimeOffChangeDeliveryDeps,
  nowIso: string
): Promise<Totals> {
  const totals: Totals = { sent: 0, failed: 0, superseded: 0 };
  const client = await deps.pool.connect();
  let connectionError: unknown = null;
  const onError = (error: unknown) => { connectionError = error; };
  client.on('error', onError);
  try {
    const due = await client.query<{ id: string; channel: 'calendar' | 'email'; request_id: string }>(
      `SELECT id::TEXT AS id, channel, request_id FROM public.time_off_change_deliveries
       WHERE status = 'pending' AND next_attempt_at <= $1
       ORDER BY next_attempt_at, created_at, id LIMIT $2`,
      [nowIso, deps.batchSize ?? DEFAULT_BATCH_SIZE]
    );
    const calendarRequests = new Set<number>();
    for (const row of due.rows) {
      if (row.channel === 'calendar') {
        const requestId = Number(row.request_id);
        if (calendarRequests.has(requestId)) continue;
        calendarRequests.add(requestId);
        await processCalendar(client, deps, requestId, nowIso, totals);
      } else {
        await processEmail(client, deps, row.id, nowIso, totals);
      }
    }
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    client.off('error', onError);
    client.release(true);
    throw connectionError ?? error;
  }
  client.off('error', onError);
  client.release(connectionError ? true : undefined);
  if (deps.expire) {
    try {
      await deps.expire(nowIso);
    } catch (error) {
      console.error('[timeoff-changes] expiry pass failed', sanitizeDeliveryError(error));
    }
  }
  return totals;
}

async function inAttemptTransaction(client: PoolClient, work: () => Promise<void>): Promise<void> {
  await client.query('BEGIN');
  try {
    await work();
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
}

async function processEmail(
  client: PoolClient,
  deps: TimeOffChangeDeliveryDeps,
  deliveryId: string,
  nowIso: string,
  totals: Totals
): Promise<void> {
  await inAttemptTransaction(client, async () => {
    // A row lock prevents concurrent sends; providers are not exactly-once.
    const locked = await client.query<{
      kind: string; recipient: string | null; identity: string | null; payload: Record<string, string>; attempts: number;
    }>(
      `SELECT kind, recipient, identity, payload, attempts FROM public.time_off_change_deliveries
       WHERE id::TEXT = $1 AND status = 'pending' AND next_attempt_at <= $2
       FOR UPDATE SKIP LOCKED`,
      [deliveryId, nowIso]
    );
    const job = locked.rows[0];
    if (!job) return;
    try {
      if (!job.recipient) throw permanent('No recipient email is configured for this notification.');
      if (!job.identity) throw permanent('Franchise GmailID is not configured for notifications.');
      const send = deps.sendEmail ?? defaultSendEmail;
      await withTimeout(send({
        to: job.recipient,
        subject: job.payload.subject,
        text: job.payload.text,
        html: job.payload.html,
        metadata: { kind: job.kind, deliveryId, operationId: job.payload.operationId }
      }, job.identity), EMAIL_ATTEMPT_TIMEOUT_MS, 'Email send');
      await markSent(client, deliveryId, nowIso, null, null);
      totals.sent += 1;
    } catch (error) {
      if (await markFailedAttempt(client, deliveryId, job.attempts, error, nowIso)) totals.failed += 1;
    }
  });
}

async function processCalendar(
  client: PoolClient,
  deps: TimeOffChangeDeliveryDeps,
  requestId: number,
  nowIso: string,
  totals: Totals
): Promise<void> {
  await inAttemptTransaction(client, async () => {
    // The parent lock serializes workers with each other and with business changes.
    const parent = await client.query<{ google_calendar_event_id: string | null }>(
      'SELECT google_calendar_event_id FROM public.time_off_requests WHERE id = $1 FOR UPDATE SKIP LOCKED',
      [requestId]
    );
    if (!parent.rows[0]) return;
    const pending = await client.query<{
      id: string; target_version: string; payload: { action: 'upsert' | 'delete'; franchiseId: number;
        event: Record<string, unknown> | null; knownEventIds?: string[] };
      identity: string | null; calendar_id: string | null; recovery_event_id: string; attempts: number;
      next_attempt_at: Date;
    }>(
      `SELECT id::TEXT AS id, target_version::TEXT AS target_version, payload, identity, calendar_id,
         recovery_event_id, attempts, next_attempt_at
       FROM public.time_off_change_deliveries
       WHERE request_id = $1 AND channel = 'calendar' AND status = 'pending'
       ORDER BY target_version DESC, created_at DESC
       FOR UPDATE`,
      [requestId]
    );
    const [newest, ...older] = pending.rows;
    if (!newest) return;
    // Failed/sent newer targets also fence stale retries, not just pending jobs.
    const newer = await client.query(
      `SELECT 1 FROM public.time_off_change_deliveries
       WHERE request_id = $1 AND channel = 'calendar' AND target_version > $2::BIGINT LIMIT 1`,
      [requestId, newest.target_version]
    );
    if (newer.rows.length) {
      await client.query(`UPDATE public.time_off_change_deliveries SET status = 'superseded',
        next_attempt_at = NULL, completed_at = $2, updated_at = $2
        WHERE request_id = $1 AND channel = 'calendar' AND status = 'pending'`, [requestId, nowIso]);
      totals.superseded += pending.rows.length;
      return;
    }
    if (older.length > 0) {
      await client.query(
        `UPDATE public.time_off_change_deliveries
         SET status = 'superseded', next_attempt_at = NULL, completed_at = $2, updated_at = $2
         WHERE id::TEXT = ANY($1::TEXT[])`,
        [older.map((job) => job.id), nowIso]
      );
      totals.superseded += older.length;
    }
    if (new Date(newest.next_attempt_at).getTime() > Date.parse(nowIso)) return;

    const history = await client.query<{ status: string; adopted_event_id: string | null; calendar_id: string | null;
      recovery_event_id: string; target_version: string }>(
      `SELECT status, adopted_event_id, calendar_id, recovery_event_id, target_version::TEXT AS target_version
       FROM public.time_off_change_deliveries
       WHERE request_id = $1 AND channel = 'calendar' AND target_version < $2::BIGINT
       ORDER BY target_version DESC`,
      [requestId, newest.target_version]
    );
    const lastSent = history.rows.find((row) => row.status === 'sent');
    const originalEventId = parent.rows[0].google_calendar_event_id;
    const currentEventId = lastSent ? lastSent.adopted_event_id : originalEventId;
    const cleanupEventIds = [
      originalEventId,
      ...(newest.payload.knownEventIds ?? []),
      ...history.rows.map((row) => row.adopted_event_id),
      // Recovery ids were assigned at enqueue, so an attempt that rolled back
      // after the provider created its event is still found here.
      ...history.rows.map((row) => row.recovery_event_id)
    ].filter((id): id is string => Boolean(id));

    try {
      const calendarId = newest.calendar_id ?? lastSent?.calendar_id ?? null;
      let calendarClient: CalendarClient;
      try {
        calendarClient = newest.identity ? (deps.calendarClientFor ?? buildGcalClientForSubject)(newest.identity) : missingIdentityClient;
      } catch (error) {
        throw permanent(`Calendar credentials are not configured: ${sanitizeDeliveryError(error)}`);
      }
      // Abort the sequence and its transports together. Await settlement while
      // retaining the lock; Promise.race alone leaves old writes running.
      const signal = AbortSignal.timeout(deps.calendarAttemptTimeoutMs ?? CALENDAR_ATTEMPT_TIMEOUT_MS);
      const result = await syncTimeOffCalendarJob(calendarClient, {
        action: newest.payload.action,
        requestId,
        franchiseId: Number(newest.payload.franchiseId),
        calendarId,
        identity: newest.identity,
        event: newest.payload.event,
        currentEventId,
        cleanupEventIds,
        recoveryEventId: newest.recovery_event_id,
        targetVersion: newest.target_version
      }, signal);
      await markSent(client, newest.id, nowIso, result.eventId, result.calendarId);
      totals.sent += 1;
    } catch (error) {
      if (await markFailedAttempt(client, newest.id, newest.attempts, error, nowIso)) totals.failed += 1;
    }
  });
}

const missingIdentityClient: CalendarClient = {
  insertEvent: async () => { throw permanent('Franchise GmailID is not configured for calendar updates.'); },
  getEvent: async () => { throw permanent('Franchise GmailID is not configured for calendar updates.'); },
  patchEvent: async () => { throw permanent('Franchise GmailID is not configured for calendar updates.'); },
  deleteEvent: async () => { throw permanent('Franchise GmailID is not configured for calendar updates.'); },
  assertCalendarAccess: async () => { throw permanent('Franchise GmailID is not configured for calendar updates.'); }
};

async function markSent(
  client: PoolClient,
  deliveryId: string,
  nowIso: string,
  adoptedEventId: string | null,
  calendarId: string | null
): Promise<void> {
  await client.query(
    `UPDATE public.time_off_change_deliveries
     SET status = 'sent', attempts = attempts + 1, last_error = NULL, next_attempt_at = NULL,
       completed_at = $2, updated_at = $2, adopted_event_id = COALESCE($3, adopted_event_id),
       calendar_id = COALESCE(calendar_id, $4)
     WHERE id::TEXT = $1`,
    [deliveryId, nowIso, adoptedEventId, calendarId]
  );
}

/** Records a failed attempt; returns true when the delivery is now terminally failed. */
async function markFailedAttempt(
  client: PoolClient,
  deliveryId: string,
  previousAttempts: number,
  error: unknown,
  nowIso: string
): Promise<boolean> {
  const { retryable, message } = classifyDeliveryError(error);
  const attempts = previousAttempts + 1;
  const delay = retryable ? nextDeliveryRetryDelayMs(attempts) : null;
  const nextAttempt = delay === null ? null : new Date(Date.parse(nowIso) + delay).toISOString();
  await client.query(
    `UPDATE public.time_off_change_deliveries
     SET attempts = $2, last_error = $3, updated_at = $5,
       status = CASE WHEN $4::TIMESTAMPTZ IS NULL THEN 'failed' ELSE 'pending' END,
       next_attempt_at = $4::TIMESTAMPTZ,
       completed_at = CASE WHEN $4::TIMESTAMPTZ IS NULL THEN $5::TIMESTAMPTZ ELSE NULL END
     WHERE id::TEXT = $1`,
    [deliveryId, attempts, message || 'Delivery failed', nextAttempt, nowIso]
  );
  return nextAttempt === null;
}

function defaultSendEmail(payload: TimeOffEmailPayload, impersonationSubject: string): Promise<unknown> {
  const logOnly = String(process.env.EMAIL_LOG_ONLY ?? 'true').trim().toLowerCase() !== 'false';
  return sendTimeOffGmailDwd(payload, { logOnly, dwdSubject: impersonationSubject });
}

export interface TimeOffChangeWorkerDeps {
  /** Defaults to a delivery pass over `delivery`. */
  runPass?: (nowIso: string) => Promise<unknown>;
  delivery?: TimeOffChangeDeliveryDeps;
  now?: () => string;
  intervalMs?: number;
  shutdownTimeoutMs?: number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
}

/**
 * Runs non-overlapping delivery passes every 30 seconds and on `wake()`.
 * `stop()` cancels scheduling and waits a bounded time for an active pass.
 */
export function startTimeOffChangeWorker(deps: TimeOffChangeWorkerDeps): { wake(): void; stop(): Promise<void> } {
  const runPass = deps.runPass ?? ((nowIso: string) => {
    if (!deps.delivery) throw new Error('Delivery dependencies are required');
    return runTimeOffChangeDeliveryPass(deps.delivery, nowIso);
  });
  const now = deps.now ?? (() => new Date().toISOString());
  const setTimer = deps.setTimer ?? ((run: () => void, ms: number) => {
    const handle = setTimeout(run, ms);
    handle.unref?.();
    return handle;
  });
  const clearTimer = deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>));
  const intervalMs = deps.intervalMs ?? WORKER_INTERVAL_MS;
  let stopped = false;
  let timer: unknown = null;
  let active: Promise<void> | null = null;
  let rerun = false;
  let reportedMissingSchema = false;

  const schedule = (ms: number) => {
    if (stopped) return;
    if (timer !== null) clearTimer(timer);
    timer = setTimer(() => {
      timer = null;
      void tick();
    }, ms);
  };

  const tick = async () => {
    if (stopped) return;
    if (active) {
      rerun = true;
      return;
    }
    active = (async () => {
      try {
        await runPass(now());
      } catch (error) {
        if ((error as { code?: string } | null)?.code === '42P01') {
          if (!reportedMissingSchema) console.warn('[timeoff-changes] delivery tables are not migrated yet; worker idle');
          reportedMissingSchema = true;
        } else {
          console.error('[timeoff-changes] delivery pass failed', sanitizeDeliveryError(error));
        }
      }
    })();
    await active;
    active = null;
    if (stopped) return;
    if (rerun) {
      rerun = false;
      schedule(0);
    } else {
      schedule(intervalMs);
    }
  };

  schedule(0);
  return {
    wake() {
      if (stopped) return;
      if (active) {
        rerun = true;
        return;
      }
      schedule(0);
    },
    async stop() {
      stopped = true;
      if (timer !== null) {
        clearTimer(timer);
        timer = null;
      }
      if (active) {
        let handle: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          active,
          new Promise<void>((resolve) => {
            handle = setTimeout(resolve, deps.shutdownTimeoutMs ?? WORKER_SHUTDOWN_TIMEOUT_MS);
            handle.unref?.();
          })
        ]);
        if (handle) clearTimeout(handle);
      }
    }
  };
}
