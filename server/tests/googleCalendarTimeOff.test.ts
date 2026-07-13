import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildDeterministicTimeOffEventId,
  buildTimeOffCalendarEvent,
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
