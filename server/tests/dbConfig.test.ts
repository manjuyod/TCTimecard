import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { getMssqlConfig, getPostgresConfig } from '../config/env';

const MANAGED_KEYS = [
  'POSTGRES_URL',
  'POSTGRES_POOL_MAX',
  'MSSQL_SERVER',
  'MSSQL_DATABASE',
  'MSSQL_USER',
  'MSSQL_PASSWORD',
  'MSSQL_POOL_MAX'
] as const;

const originalValues = new Map(MANAGED_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of MANAGED_KEYS) {
    const original = originalValues.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

const setRequiredValues = (): void => {
  process.env.POSTGRES_URL = 'postgresql://user:password@example.test/timecard';
  process.env.MSSQL_SERVER = 'sql.example.test';
  process.env.MSSQL_DATABASE = 'timecard';
  process.env.MSSQL_USER = 'user';
  process.env.MSSQL_PASSWORD = 'password';
};

test('database pool defaults are ten connections per process', () => {
  setRequiredValues();
  delete process.env.POSTGRES_POOL_MAX;
  delete process.env.MSSQL_POOL_MAX;

  assert.equal(getPostgresConfig().max, 10);
  assert.equal(getMssqlConfig().pool?.max, 10);
});

test('explicit database pool maxima still override the defaults', () => {
  setRequiredValues();
  process.env.POSTGRES_POOL_MAX = '3';
  process.env.MSSQL_POOL_MAX = '4';

  assert.equal(getPostgresConfig().max, 3);
  assert.equal(getMssqlConfig().pool?.max, 4);
});
