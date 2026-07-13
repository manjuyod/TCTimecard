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
  ]
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
