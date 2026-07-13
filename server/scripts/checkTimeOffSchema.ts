import { closePostgresPool, getPostgresPool } from '../db/postgres';
import { findMissingTimeOffSchemaColumns, timeOffSchemaTables } from '../services/timeOffSchema';

async function main(): Promise<void> {
  const result = await getPostgresPool().query<{ table_name: string; column_name: string }>(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = ANY($1::text[])
     ORDER BY table_name, ordinal_position`,
    [timeOffSchemaTables]
  );
  const missing = findMissingTimeOffSchemaColumns(result.rows);
  if (missing.length > 0) {
    throw new Error(`Shared Neon time-off schema is missing: ${missing.join(', ')}`);
  }
  console.log('Shared Neon time-off schema preflight passed.');
}

main()
  .catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  })
  .finally(() => closePostgresPool());
