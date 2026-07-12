import { getMssqlPool } from '../db/mssql';
import { getPostgresPool } from '../db/postgres';

export type DependencyState = 'ok' | 'error';

export interface ReadinessChecks {
  postgres: () => Promise<void>;
  mssql: () => Promise<void>;
}

export interface ReadinessResult {
  ready: boolean;
  status: 'ready' | 'not_ready';
  dependencies: { postgres: DependencyState; mssql: DependencyState };
}

const defaultChecks: ReadinessChecks = {
  postgres: async () => {
    await getPostgresPool().query('SELECT 1 AS ok');
  },
  mssql: async () => {
    const pool = await getMssqlPool();
    await pool.request().query('SELECT 1 AS ok');
  }
};

export const checkReadiness = async (
  checks: ReadinessChecks = defaultChecks
): Promise<ReadinessResult> => {
  const [postgres, mssql] = await Promise.allSettled([checks.postgres(), checks.mssql()]);
  const dependencies = {
    postgres: postgres.status === 'fulfilled' ? 'ok' : 'error',
    mssql: mssql.status === 'fulfilled' ? 'ok' : 'error'
  } as const;
  const ready = dependencies.postgres === 'ok' && dependencies.mssql === 'ok';
  return { ready, status: ready ? 'ready' : 'not_ready', dependencies };
};
