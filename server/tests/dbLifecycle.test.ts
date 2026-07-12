import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { closeMssqlPool, setMssqlPoolOverride } from '../db/mssql';
import { closePostgresPool, setPostgresPoolOverride } from '../db/postgres';

afterEach(() => {
  setPostgresPoolOverride(undefined);
  setMssqlPoolOverride(undefined);
});

test('pool close helpers are idempotent', async () => {
  let postgresCloses = 0;
  let mssqlCloses = 0;
  setPostgresPoolOverride({ end: async () => { postgresCloses += 1; } } as never);
  setMssqlPoolOverride({ close: async () => { mssqlCloses += 1; } } as never);

  await closePostgresPool();
  await closeMssqlPool();
  await closePostgresPool();
  await closeMssqlPool();

  assert.equal(postgresCloses, 1);
  assert.equal(mssqlCloses, 1);
});
