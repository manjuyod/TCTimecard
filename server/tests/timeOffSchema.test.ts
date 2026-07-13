import assert from 'node:assert/strict';
import test from 'node:test';
import { findMissingTimeOffSchemaColumns } from '../services/timeOffSchema';

test('time-off schema preflight reports missing shared Neon columns', () => {
  const missing = findMissingTimeOffSchemaColumns([
    { table_name: 'time_off_requests', column_name: 'id' },
    { table_name: 'time_off_audit', column_name: 'metadata' }
  ]);
  assert.ok(missing.includes('time_off_requests.absence_label'));
  assert.ok(missing.includes('time_off_requests.public_metadata'));
  assert.ok(!missing.includes('time_off_audit.metadata'));
});
