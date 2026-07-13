import assert from 'node:assert/strict';
import test from 'node:test';
import { mapTutorDirectoryRows } from '../services/timeOffDirectory';

test('time-off tutor directory maps MSSQL identities', () => {
  const result = mapTutorDirectoryRows([
    { TutorID: 12, FirstName: 'Ada', LastName: 'Lovelace', Email: 'ada@example.com' }
  ]);
  assert.deepEqual(result.get(12), {
    tutorId: 12,
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com'
  });
});
