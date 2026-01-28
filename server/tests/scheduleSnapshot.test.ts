import test from 'node:test';
import assert from 'node:assert/strict';
import { parseScheduleSnapshotV1, signScheduleSnapshot, verifyScheduleSnapshot } from '../services/scheduleSnapshot';

test('schedule snapshots: sign + verify roundtrip', () => {
  const secret = 'unit-test-secret';
  const unsigned = {
    version: 1 as const,
    franchiseId: 10,
    tutorId: 20,
    workDate: '2026-01-01',
    timezone: 'America/Chicago',
    slotMinutes: 60,
    entries: [{ timeId: 1, timeLabel: '9:00 AM - 10:00 AM' }],
    intervals: [{ startAt: '2026-01-01T09:00:00-06:00', endAt: '2026-01-01T10:00:00-06:00' }],
    issuedAt: '2026-01-01T00:00:00Z'
  };

  const signed = signScheduleSnapshot(unsigned, secret);
  assert.ok(signed.signature);

  const parsed = parseScheduleSnapshotV1(signed);
  assert.ok(parsed);
  assert.equal(parsed?.franchiseId, 10);
  assert.equal(parsed?.tutorId, 20);
  assert.equal(parsed?.signature, signed.signature);

  assert.deepEqual(verifyScheduleSnapshot(signed, secret), { ok: true });

  const tampered = { ...signed, tutorId: 21 };
  const verifyTampered = verifyScheduleSnapshot(tampered, secret);
  assert.equal(verifyTampered.ok, false);
});

