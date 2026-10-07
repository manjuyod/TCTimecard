import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildDeterministicTimeOffEventId,
  buildRecoveryTimeOffEventId,
  buildTimeOffCalendarEvent,
  createCalendarEventTransport,
  insertOrVerifyTimeOffEvent,
  resolveCalendarServiceAccountCredentials
} from '../services/googleCalendar';

const request = {
  id: 42,
  franchiseId: 6,
  tutorId: 123,
  bridgeProfileId: null,
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@example.com',
  startAt: '2026-07-26T07:00:00.000Z',
  endAt: '2026-07-28T07:00:00.000Z',
  startDate: '2026-07-26',
  endDate: '2026-07-27',
  type: 'pto' as const,
  absenceLabel: 'Paid Time Off',
  reason: 'Family vacation out of town',
  partialDay: false
};

describe('time-off Google Calendar payload', () => {
  it('uses a deterministic Google-compatible event id', () => {
    assert.equal(buildDeterministicTimeOffEventId(42), 'tctimeoff1a');
  });

  it('builds a true all-day event with source details', () => {
    assert.deepEqual(buildTimeOffCalendarEvent(request, 'Email correspondence'), {
      id: 'tctimeoff1a',
      summary: 'TIME OFF: Ada Lovelace (Paid Time Off)',
      description: [
        'Requester: Ada Lovelace',
        'Email: ada@example.com',
        'Tutor ID: 123',
        'Franchise ID: 6',
        'Type: pto',
        'Absence label: Paid Time Off',
        'Request reason: Family vacation out of town',
        'Decision reason: Email correspondence',
        'Request ID: 42'
      ].join('\n'),
      start: { date: '2026-07-26' },
      end: { date: '2026-07-28' },
      extendedProperties: {
        private: { timeOffRequestId: '42', franchiseId: '6' }
      }
    });
  });

  it('uses dateTime boundaries for partial-day events and bridge identity', () => {
    const payload = buildTimeOffCalendarEvent(
      {
        ...request,
        tutorId: null,
        bridgeProfileId: 900,
        partialDay: true,
        type: 'emergency',
        absenceLabel: 'Emergency'
      },
      'Approved by manager'
    );

    assert.deepEqual(payload.start, { dateTime: request.startAt });
    assert.deepEqual(payload.end, { dateTime: request.endAt });
    assert.match(String(payload.description), /Bridge profile ID: 900/);
  });

  it('requires the split calendar service-account credential', () => {
    assert.throws(
      () =>
        resolveCalendarServiceAccountCredentials({
          GOOGLE_SERVICE_ACCOUNT_JSON: JSON.stringify({ client_email: 'legacy@example.com', private_key: 'legacy' })
        }),
      /GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON is required/
    );
  });

  it('recovers a deterministic existing event after an insert conflict', async () => {
    let lookups = 0;
    const payload = buildTimeOffCalendarEvent(request, 'Email correspondence');
    const id = await insertOrVerifyTimeOffEvent(
      {
        insertEvent: async () => {
          const error = new Error('already exists') as Error & { status?: number };
          error.status = 409;
          throw error;
        },
        getEvent: async (_calendarId, eventId) => {
          lookups += 1;
          return {
            id: eventId,
            extendedProperties: { private: { timeOffRequestId: '42', franchiseId: '6' } }
          };
        }
      },
      'calendar@example.com',
      payload,
      42,
      6
    );

    assert.equal(id, 'tctimeoff1a');
    assert.equal(lookups, 1);
  });

  it('rejects a conflicting event that belongs to another request', async () => {
    const payload = buildTimeOffCalendarEvent(request, 'Email correspondence');
    await assert.rejects(
      () =>
        insertOrVerifyTimeOffEvent(
          {
            insertEvent: async () => {
              const error = new Error('already exists') as Error & { status?: number };
              error.status = 409;
              throw error;
            },
            getEvent: async () => ({
              id: 'tctimeoff1a',
              extendedProperties: { private: { timeOffRequestId: '999', franchiseId: '6' } }
            })
          },
          'calendar@example.com',
          payload,
          42,
          6
        ),
      /does not match time-off request 42/i
    );
  });
});

describe('time-off Google Calendar event transport', () => {
  const recorder = (responses: Array<{ status: number; body?: unknown }>) => {
    const calls: Array<{ url: string; method: string; body: unknown; authorization: string; signal: unknown }> = [];
    const fetchImpl = async (url: string | URL, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      calls.push({ url: String(url), method: init.method ?? 'GET', body: init.body ? JSON.parse(String(init.body)) : undefined,
        authorization: headers.get('Authorization') ?? '', signal: init.signal });
      const next = responses.shift() ?? { status: 200, body: {} };
      return new Response(next.body === undefined ? null : JSON.stringify(next.body), { status: next.status });
    };
    const transport = createCalendarEventTransport({ getAccessToken: async () => 'token-1', fetch: fetchImpl as typeof fetch });
    return { calls, transport };
  };

  it('patches an event with only the supplied fields', async () => {
    const { calls, transport } = recorder([{ status: 200, body: { id: 'tctimeoff1a' } }]);
    const patch = { start: { date: '2026-11-16', dateTime: null } };
    assert.deepEqual(await transport.patchEvent('center@example.com', 'tctimeoff1a', patch), { id: 'tctimeoff1a' });
    assert.equal(calls[0].method, 'PATCH');
    assert.equal(calls[0].url, 'https://www.googleapis.com/calendar/v3/calendars/center%40example.com/events/tctimeoff1a');
    assert.deepEqual(calls[0].body, patch);
    assert.equal(calls[0].authorization, 'Bearer token-1');
    assert.ok(calls[0].signal, 'every provider request carries a timeout signal');
  });

  it('accepts an empty delete response and reports provider status and reason on failure', async () => {
    const { calls, transport } = recorder([
      { status: 204 },
      { status: 410, body: { error: { message: 'Resource has been deleted', errors: [{ reason: 'deleted' }] } } },
      { status: 403, body: { error: { message: 'Rate Limit Exceeded', errors: [{ reason: 'rateLimitExceeded' }] } } }
    ]);
    await transport.deleteEvent('center@example.com', 'tctimeoff1a');
    assert.equal(calls[0].method, 'DELETE');
    await assert.rejects(transport.deleteEvent('center@example.com', 'tctimeoff1a'),
      (error: { status?: number; reason?: string }) => error.status === 410 && error.reason === 'deleted');
    await assert.rejects(transport.assertCalendarAccess('center@example.com'),
      (error: { status?: number; reason?: string }) => error.status === 403 && error.reason === 'rateLimitExceeded');
  });

  it('probes calendar access with a minimal events list under the events scope', async () => {
    const { calls, transport } = recorder([{ status: 200, body: { items: [] } }]);
    await transport.assertCalendarAccess('center@example.com');
    assert.equal(calls[0].method, 'GET');
    assert.equal(calls[0].url, 'https://www.googleapis.com/calendar/v3/calendars/center%40example.com/events?maxResults=1');
  });

  it('derives a distinct Google-compatible recovery id per calendar target version', () => {
    assert.equal(buildRecoveryTimeOffEventId(42, '5'), 'tctimeoff1av5');
    assert.equal(buildRecoveryTimeOffEventId(42, '33'), 'tctimeoff1av11');
    assert.match(buildRecoveryTimeOffEventId(42, '9007199254740993'), /^[a-v0-9]{5,1024}$/);
  });
});
