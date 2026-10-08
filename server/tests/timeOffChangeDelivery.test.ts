import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  classifyDeliveryError,
  nextDeliveryRetryDelayMs,
  sanitizeDeliveryError,
  startTimeOffChangeWorker,
  syncTimeOffCalendarJob,
  type CalendarJob
} from '../services/timeOffChangeDelivery';
import { FakeCalendar } from './helpers/fakeCalendar';

const CALENDAR = 'center@example.com';
const owned = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  summary: 'TIME OFF: Ada Lovelace (Paid Time Off)',
  start: { date: '2026-11-16' },
  end: { date: '2026-11-18' },
  colorId: '5',
  extendedProperties: { private: { timeOffRequestId: '42', franchiseId: '6' } },
  ...overrides
});
const desiredAllDay = {
  summary: 'TIME OFF: Ada Lovelace (Paid Time Off)',
  description: 'Request ID: 42',
  start: { date: '2026-11-16' },
  end: { date: '2026-11-19' },
  extendedProperties: { private: { timeOffRequestId: '42', franchiseId: '6' } }
};
const desiredTimed = {
  ...desiredAllDay,
  start: { dateTime: '2026-11-16T17:00:00.000Z' },
  end: { dateTime: '2026-11-16T20:00:00.000Z' }
};
const job = (overrides: Partial<CalendarJob> = {}): CalendarJob => ({
  action: 'upsert',
  requestId: 42,
  franchiseId: 6,
  calendarId: CALENDAR,
  identity: CALENDAR,
  event: desiredAllDay,
  currentEventId: 'tctimeoff1a',
  cleanupEventIds: [],
  recoveryEventId: 'tctimeoff1av5',
  targetVersion: '5',
  ...overrides
});
const rejectsPermanently = (pattern: RegExp) => (error: unknown) =>
  (error as { retryable?: boolean }).retryable === false && pattern.test(String((error as Error).message));

describe('calendar synchronization for approved time-off changes', () => {
  it('patches the owned event, preserves unrelated fields, and clears the other date format', async () => {
    const calendar = new FakeCalendar();
    calendar.seed(CALENDAR, owned('tctimeoff1a'));

    const timed = await syncTimeOffCalendarJob(calendar, job({ event: desiredTimed }));
    let event = calendar.get(CALENDAR, 'tctimeoff1a') as Record<string, Record<string, unknown>>;
    assert.deepEqual(timed, { eventId: 'tctimeoff1a', calendarId: CALENDAR });
    assert.equal(event.colorId as unknown, '5');
    assert.deepEqual(event.start, { dateTime: '2026-11-16T17:00:00.000Z' });
    assert.equal((event.extendedProperties.private as Record<string, string>).timeOffTargetVersion, '5');

    await syncTimeOffCalendarJob(calendar, job({ event: desiredAllDay, targetVersion: '6' }));
    event = calendar.get(CALENDAR, 'tctimeoff1a') as Record<string, Record<string, unknown>>;
    assert.deepEqual(event.start, { date: '2026-11-16' });
    assert.deepEqual(event.end, { date: '2026-11-19' });
  });

  it('never mutates an event owned by another request', async () => {
    const calendar = new FakeCalendar();
    calendar.seed(CALENDAR, owned('tctimeoff1a', { extendedProperties: { private: { timeOffRequestId: '43', franchiseId: '6' } } }));

    await assert.rejects(syncTimeOffCalendarJob(calendar, job()), rejectsPermanently(/does not belong/));
    await assert.rejects(syncTimeOffCalendarJob(calendar, job({ action: 'delete', event: null })), rejectsPermanently(/does not belong/));
    assert.equal(calendar.count('patch') + calendar.count('delete') + calendar.count('insert'), 0);
  });

  it('deletes the owned event and treats an already deleted event as converged', async () => {
    const calendar = new FakeCalendar();
    calendar.seed(CALENDAR, owned('tctimeoff1a'));
    assert.deepEqual(await syncTimeOffCalendarJob(calendar, job({ action: 'delete', event: null })),
      { eventId: null, calendarId: CALENDAR });
    assert.equal(calendar.get(CALENDAR, 'tctimeoff1a'), undefined);
    await syncTimeOffCalendarJob(calendar, job({ action: 'delete', event: null }));
    assert.equal(calendar.count('delete'), 1);
  });

  it('requires a successful access probe before treating a 404 as absence', async () => {
    const calendar = new FakeCalendar();
    calendar.accessible = false;
    await assert.rejects(syncTimeOffCalendarJob(calendar, job({ action: 'delete', event: null })), rejectsPermanently(/access/i));
    await assert.rejects(syncTimeOffCalendarJob(calendar, job()), rejectsPermanently(/access/i));
    assert.equal(calendar.count('insert'), 0);

    calendar.accessible = true;
    await syncTimeOffCalendarJob(calendar, job({ action: 'delete', event: null }));
    assert.equal(calendar.count('probe'), 3);
  });

  it('recreates a missing event once under the persisted recovery id and verifies content on a 409', async () => {
    const calendar = new FakeCalendar();
    const recovered = await syncTimeOffCalendarJob(calendar, job());
    assert.deepEqual(recovered, { eventId: 'tctimeoff1av5', calendarId: CALENDAR });
    const insertCallsForSameRecoveryId = calendar.count('insert', 'tctimeoff1av5');
    assert.equal(insertCallsForSameRecoveryId, 1);

    calendar.patchEvent(CALENDAR, 'tctimeoff1av5', { summary: 'Edited outside the app' });
    await syncTimeOffCalendarJob(calendar, job({ currentEventId: null }));
    assert.equal(calendar.count('insert', 'tctimeoff1av5'), 2);
    assert.equal(calendar.get(CALENDAR, 'tctimeoff1av5')?.summary, desiredAllDay.summary);
    assert.equal(calendar.count('insert', 'tctimeoff1a'), 0, 'a known deleted id is never reused');
  });

  it('fails visibly when the recovery event itself was deleted externally', async () => {
    const calendar = new FakeCalendar();
    calendar.seed(CALENDAR, owned('tctimeoff1av5'));
    await calendar.deleteEvent(CALENDAR, 'tctimeoff1av5');
    await assert.rejects(syncTimeOffCalendarJob(calendar, job({ currentEventId: null })), rejectsPermanently(/repair/i));
  });

  it('deletes every potentially inserted recovery event when cancelling', async () => {
    const calendar = new FakeCalendar();
    calendar.seed(CALENDAR, owned('tctimeoff1a'));
    calendar.seed(CALENDAR, owned('tctimeoff1av3'));
    await syncTimeOffCalendarJob(calendar, job({
      action: 'delete', event: null, cleanupEventIds: ['tctimeoff1av3', 'tctimeoff1av4']
    }));
    assert.equal(calendar.get(CALENDAR, 'tctimeoff1a'), undefined);
    assert.equal(calendar.get(CALENDAR, 'tctimeoff1av3'), undefined);
    assert.equal(calendar.count('delete'), 2);
  });

  it('adopts the franchise calendar for legacy approvals only after verifying ownership', async () => {
    const calendar = new FakeCalendar();
    calendar.seed(CALENDAR, owned('tctimeoff1a'));
    assert.deepEqual(await syncTimeOffCalendarJob(calendar, job({ calendarId: null })), { eventId: 'tctimeoff1a', calendarId: CALENDAR });

    const missing = new FakeCalendar();
    await assert.rejects(syncTimeOffCalendarJob(missing, job({ calendarId: null })), rejectsPermanently(/repair/i));
    await assert.rejects(syncTimeOffCalendarJob(missing, job({ calendarId: null, currentEventId: null })), rejectsPermanently(/repair/i));
    assert.equal(missing.count('insert'), 0);
  });

  it('does not migrate events when the franchise calendar identity changed', async () => {
    const calendar = new FakeCalendar();
    calendar.seed(CALENDAR, owned('tctimeoff1a'));
    await assert.rejects(syncTimeOffCalendarJob(calendar, job({ identity: 'new-center@example.com' })), rejectsPermanently(/repair/i));
    await assert.rejects(syncTimeOffCalendarJob(calendar, job({ identity: null })), rejectsPermanently(/GmailID/));
    assert.equal(calendar.count('patch'), 0);
  });
});

describe('delivery retries and errors', () => {
  it('backs off 30s, 2m, 10m, 1h, 6h and fails after the sixth attempt', () => {
    assert.deepEqual([1, 2, 3, 4, 5, 6].map(nextDeliveryRetryDelayMs),
      [30_000, 120_000, 600_000, 3_600_000, 21_600_000, null]);
  });

  it('retries transient provider failures and fails permission and validation errors immediately', () => {
    const status = (code: number, reason?: string) => Object.assign(new Error(`failed (${code})`), { status: code, reason });
    assert.equal(classifyDeliveryError(status(503)).retryable, true);
    assert.equal(classifyDeliveryError(status(429)).retryable, true);
    assert.equal(classifyDeliveryError(status(403, 'rateLimitExceeded')).retryable, true);
    assert.equal(classifyDeliveryError(new Error('fetch failed')).retryable, true);
    assert.equal(classifyDeliveryError(status(403, 'forbidden')).retryable, false);
    assert.equal(classifyDeliveryError(status(400)).retryable, false);
    assert.equal(classifyDeliveryError(new Error('Gmail DWD send failed: 503 {"error":"backend"}')).retryable, true);
    assert.equal(classifyDeliveryError(new Error('Gmail DWD send failed: 400 {"error":"bad"}')).retryable, false);
  });

  it('removes credentials and tokens from stored errors', () => {
    const message = sanitizeDeliveryError(new Error(
      'Request failed Authorization: Bearer ya29.secretTOKEN-value https://x.test/?access_token=abc123&ok=1'));
    assert.doesNotMatch(message, /ya29|abc123/);
    assert.ok(message.length <= 500);
  });
});

describe('time-off change delivery worker', () => {
  const timers = () => {
    const scheduled: Array<{ id: number; ms: number; run: () => void }> = [];
    let next = 0;
    return {
      scheduled,
      setTimer: (run: () => void, ms: number) => {
        const id = (next += 1);
        scheduled.push({ id, ms, run });
        return id;
      },
      clearTimer: (id: unknown) => {
        const index = scheduled.findIndex((timer) => timer.id === id);
        if (index >= 0) scheduled.splice(index, 1);
      },
      fire: () => scheduled.splice(0).forEach((timer) => timer.run())
    };
  };

  it('runs one pass at a time, reruns once after a wake, and schedules every 30 seconds', async () => {
    const clock = timers();
    let active = 0;
    let maxActive = 0;
    let passes = 0;
    let release: () => void = () => undefined;
    const worker = startTimeOffChangeWorker({
      runPass: async () => {
        passes += 1;
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise<void>((resolve) => { release = resolve; });
        active -= 1;
      },
      now: () => '2026-10-07T17:00:00.000Z',
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    });
    clock.fire();
    await new Promise((resolve) => setImmediate(resolve));
    worker.wake();
    worker.wake();
    release();
    await new Promise((resolve) => setImmediate(resolve));
    clock.fire();
    await new Promise((resolve) => setImmediate(resolve));
    release();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(maxActive, 1);
    assert.equal(passes, 2);
    assert.ok(clock.scheduled.some((timer) => timer.ms === 30_000));
    await worker.stop();
  });

  it('stops scheduling and waits only a bounded time for the active pass', async () => {
    const clock = timers();
    const worker = startTimeOffChangeWorker({
      runPass: () => new Promise(() => undefined),
      now: () => '2026-10-07T17:00:00.000Z',
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer,
      shutdownTimeoutMs: 20
    });
    clock.fire();
    const started = Date.now();
    await worker.stop();
    assert.ok(Date.now() - started < 1_000);
    assert.equal(clock.scheduled.length, 0);
    worker.wake();
    assert.equal(clock.scheduled.length, 0);
  });

  it('keeps running when the delivery tables do not exist yet', async () => {
    const clock = timers();
    let passes = 0;
    const worker = startTimeOffChangeWorker({
      runPass: async () => {
        passes += 1;
        throw Object.assign(new Error('relation "public.time_off_change_deliveries" does not exist'), { code: '42P01' });
      },
      now: () => '2026-10-07T17:00:00.000Z',
      setTimer: clock.setTimer,
      clearTimer: clock.clearTimer
    });
    clock.fire();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(passes, 1);
    assert.ok(clock.scheduled.some((timer) => timer.ms === 30_000));
    await worker.stop();
  });
});
