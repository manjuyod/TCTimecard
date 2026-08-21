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
  assert.ok(missing.includes('time_off_requests.decision_token_hash'));
  assert.ok(missing.includes('time_off_requests.decision_token_expires_at'));
  assert.ok(missing.includes('time_off_requests.decision_token_used_at'));
  assert.ok(!missing.includes('time_off_audit.metadata'));
});

test('time-off schema preflight includes shared cross-center PTO tables', () => {
  const missing = findMissingTimeOffSchemaColumns([]);

  assert.ok(missing.includes('pto_center_settings.enabled'));
  assert.ok(missing.includes('pto_profiles.identity_status'));
  assert.ok(missing.includes('pto_profile_centers.tutor_id'));
  assert.ok(missing.includes('pto_profile_emails.source'));
  assert.ok(missing.includes('pto_request_allocations.state'));
  assert.ok(missing.includes('pto_audit_events.event_type'));
  assert.ok(missing.includes('time_off_center_links.token_hash'));
});

test('time-off schema preflight includes persistent PTO discovery and provenance columns', () => {
  const missing = findMissingTimeOffSchemaColumns([]);

  assert.ok(missing.includes('pto_discovered_tutor_accounts.provider'));
  assert.ok(missing.includes('pto_discovered_tutor_accounts.crm_active'));
  assert.ok(missing.includes('pto_profile_link_decisions.status'));
  assert.ok(missing.includes('pto_profile_link_decisions.version'));
  assert.ok(missing.includes('pto_ledger_entries.source_membership_id'));
  assert.ok(missing.includes('pto_center_settings.last_successful_roster_sync_at'));
  assert.ok(missing.includes('pto_center_settings.last_roster_sync_error'));
  assert.ok(missing.includes('pto_center_settings.last_successful_discovery_at'));
  assert.ok(missing.includes('pto_center_settings.last_discovery_error'));
});
