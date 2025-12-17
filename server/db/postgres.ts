import { Pool } from 'pg';
import { getPostgresConfig } from '../config/env';

let pool: Pool | undefined;

export const getPostgresPool = (): Pool => {
  if (pool) return pool;

  const config = getPostgresConfig();
  pool = new Pool(config);

  pool.on('error', (err: Error) => {
    console.error('[postgres] Unexpected pool error', err);
  });

  return pool;
};
