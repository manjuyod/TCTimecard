import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mapTimeOffRow } from '../services/timeOffRepository';

describe('time-off repository row mapping', () => {
  it('maps an authenticated emergency stored as other back to the API type', () => {
    const result = mapTimeOffRow(
      {
        id: 10,
        franchiseid: 6,
        tutorid: 123,
        bridge_flag: false,
        bridge_profile_id: null,
        first_name: 'Ada',
        last_name: 'Lovelace',
        email: 'ada@example.com',
        start_at: '2026-07-12T07:00:00.000Z',
        end_at: '2026-07-13T07:00:00.000Z',
        type: 'other',
        absence_label: 'Emergency',
        notes: 'Unexpected family emergency today',
        status: 'pending',
        created_at: '2026-07-12T18:00:00.000Z',
        created_by: 123,
        decided_at: null,
        decided_by: null,
        decision_reason: null,
        google_calendar_event_id: null,
        duration_hours: '24',
        partial_day: false,
        leave_time: null,
        return_time: null,
        public_metadata: { source: 'authenticated_timecard_app' }
      },
      'America/Los_Angeles'
    );

    assert.equal(result.type, 'emergency');
    assert.equal(result.source, 'authenticated');
    assert.equal(result.startDate, '2026-07-12');
    assert.equal(result.endDate, '2026-07-12');
  });

  it('maps public bridge rows without a tutor id into the unified queue', () => {
    const result = mapTimeOffRow(
      {
        id: '11',
        franchiseid: 6,
        tutorid: null,
        bridge_flag: true,
        bridge_profile_id: '900',
        first_name: 'Grace',
        last_name: 'Hopper',
        email: 'grace@example.com',
        start_at: '2026-07-26T20:30:00.000Z',
        end_at: '2026-07-27T00:00:00.000Z',
        type: 'other',
        absence_label: 'Personal Time',
        notes: 'Personal appointment in the afternoon',
        status: 'pending',
        created_at: '2026-07-12T18:00:00.000Z',
        created_by: null,
        decided_at: null,
        decided_by: null,
        decision_reason: null,
        google_calendar_event_id: null,
        duration_hours: '3.5',
        partial_day: true,
        leave_time: '13:30:00',
        return_time: '17:00:00',
        public_metadata: { source: 'public_timeoff_form' }
      },
      'America/Los_Angeles'
    );

    assert.equal(result.tutorId, null);
    assert.equal(result.bridgeProfileId, 900);
    assert.equal(result.tutorName, 'Grace Hopper');
    assert.equal(result.source, 'public');
    assert.equal(result.type, 'other');
    assert.equal(result.partialDay, true);
  });

  it('treats legacy non-midnight rows as timed events even when partial_day is false', () => {
    const result = mapTimeOffRow(
      {
        id: 12,
        franchiseid: 6,
        tutorid: 123,
        bridge_flag: false,
        bridge_profile_id: null,
        first_name: 'Ada',
        last_name: 'Lovelace',
        email: 'ada@example.com',
        start_at: '2026-07-26T16:00:00.000Z',
        end_at: '2026-07-26T20:00:00.000Z',
        type: 'pto',
        absence_label: 'Paid Time Off',
        notes: 'Legacy custom datetime request',
        status: 'pending',
        created_at: '2026-07-12T18:00:00.000Z',
        created_by: 123,
        decided_at: null,
        decided_by: null,
        decision_reason: null,
        google_calendar_event_id: null,
        duration_hours: '4',
        partial_day: false,
        leave_time: null,
        return_time: null,
        public_metadata: {}
      },
      'America/Los_Angeles'
    );

    assert.equal(result.partialDay, true);
    assert.equal(result.endDate, '2026-07-26');
  });
});
