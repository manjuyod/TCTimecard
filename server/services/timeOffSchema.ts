const REQUIRED_COLUMNS: Record<string, string[]> = {
  time_off_requests: [
    'id', 'franchiseid', 'tutorid', 'bridge_flag', 'bridge_profile_id', 'first_name', 'last_name', 'email',
    'start_at', 'end_at', 'type', 'absence_label', 'notes', 'status', 'created_at', 'created_by', 'decided_at',
    'decided_by', 'decision_reason', 'google_calendar_event_id', 'duration_hours', 'partial_day', 'leave_time',
    'return_time', 'public_metadata', 'decision_token_hash', 'decision_token_expires_at', 'decision_token_used_at'
  ],
  time_off_audit: [
    'id', 'request_id', 'action', 'actor_account_type', 'actor_account_id', 'at', 'previous_status', 'new_status',
    'metadata'
  ],
  pto_policies: [
    'id', 'effective_from', 'entitlement_days', 'renewal_month', 'renewal_day', 'carryover_days', 'created_at'
  ],
  pto_center_settings: [
    'franchiseid', 'enabled', 'first_activated_at', 'last_successful_sync_at', 'last_sync_error',
    'last_successful_roster_sync_at', 'last_roster_sync_error', 'last_successful_discovery_at',
    'last_discovery_error', 'created_at', 'updated_at'
  ],
  pto_profiles: [
    'id', 'first_name', 'last_name', 'normalized_first_name', 'normalized_last_name', 'identity_status', 'active', 'created_at'
  ],
  pto_profile_crm_ids: ['profile_id', 'provider', 'crm_id', 'created_at'],
  pto_profile_emails: [
    'id', 'profile_id', 'franchiseid', 'email', 'active', 'source', 'source_membership_id', 'created_at', 'updated_at'
  ],
  pto_profile_centers: [
    'id', 'profile_id', 'franchiseid', 'tutor_id', 'active', 'crm_snapshot', 'first_seen_at', 'updated_at'
  ],
  pto_profile_match_candidates: [
    'id', 'left_profile_id', 'right_profile_id', 'match_type', 'status', 'decided_by', 'decided_at', 'created_at'
  ],
  pto_profile_aliases: ['source_profile_id', 'target_profile_id', 'candidate_id', 'merged_at'],
  pto_discovered_tutor_accounts: [
    'id', 'provider', 'crm_id', 'franchiseid', 'tutor_id', 'normalized_first_name', 'normalized_last_name',
    'crm_snapshot', 'crm_active', 'first_seen_at', 'last_seen_at'
  ],
  pto_profile_link_decisions: [
    'id', 'profile_id', 'account_id', 'status', 'version', 'decided_by', 'decision_franchiseid', 'decided_at',
    'created_at', 'updated_at'
  ],
  pto_entitlement_cycles: [
    'id', 'profile_id', 'starts_on', 'ends_on', 'entitlement_days', 'policy_id', 'created_at'
  ],
  pto_ledger_entries: [
    'id', 'profile_id', 'cycle_id', 'request_id', 'allocation_id', 'event_type', 'balance_delta',
    'reserved_delta', 'idempotency_key', 'metadata', 'source_membership_id', 'created_at'
  ],
  pto_request_allocations: [
    'id', 'request_id', 'cycle_id', 'charged_days', 'state', 'created_at', 'updated_at'
  ],
  pto_audit_events: [
    'id', 'profile_id', 'franchiseid', 'actor_id', 'event_type', 'before_state', 'after_state',
    'idempotency_key', 'created_at'
  ],
  time_off_center_links: ['id', 'franchiseid', 'token_hash', 'active', 'created_at', 'updated_at']
};

export function findMissingTimeOffSchemaColumns(
  rows: Array<{ table_name: string; column_name: string }>
): string[] {
  const found = new Set(rows.map((row) => `${row.table_name}.${row.column_name}`));
  return Object.entries(REQUIRED_COLUMNS).flatMap(([table, columns]) =>
    columns.map((column) => `${table}.${column}`).filter((column) => !found.has(column))
  );
}

export const timeOffSchemaTables = Object.keys(REQUIRED_COLUMNS);
