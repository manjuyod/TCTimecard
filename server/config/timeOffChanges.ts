import type { Pool } from 'pg';
import { findMissingTimeOffSchemaColumns, timeOffSchemaTables } from '../services/timeOffSchema';

/** Approved time-off changes are off unless TIME_OFF_CHANGES_ENABLED is exactly `true`. */
export function isTimeOffChangesEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.TIME_OFF_CHANGES_ENABLED === 'true';
}

const CHANGE_SCHEMA = /^(time_off_amendments|time_off_change_operations|time_off_change_deliveries)\.|^time_off_requests\.(version|last_change_operation_id|google_calendar_id)$/;

/** Columns from migration 0016 that are missing; enabling the feature requires none. */
export async function findMissingTimeOffChangeSchema(pool: Pick<Pool, 'query'>): Promise<string[]> {
  const result = await pool.query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ANY($1::TEXT[])`,
    [timeOffSchemaTables]
  );
  return findMissingTimeOffSchemaColumns(result.rows).filter((column) => CHANGE_SCHEMA.test(column));
}
