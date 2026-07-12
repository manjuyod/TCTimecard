import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import express from 'express';
import { createHealthRouter } from '../routes/health';
import { checkReadiness } from '../services/readiness';

const withServer = async <T>(app: express.Express, run: (baseUrl: string) => Promise<T>): Promise<T> => {
  const server = await new Promise<ReturnType<express.Express['listen']>>((resolve) => {
    const nextServer = app.listen(0, () => resolve(nextServer));
  });
  try {
    const address = server.address() as AddressInfo;
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
};

test('readiness is healthy only when both dependencies respond', async () => {
  const result = await checkReadiness({
    postgres: async () => undefined,
    mssql: async () => undefined
  });

  assert.deepEqual(result, {
    ready: true,
    status: 'ready',
    dependencies: { postgres: 'ok', mssql: 'ok' }
  });
});

test('readiness hides dependency errors and returns not-ready', async () => {
  const result = await checkReadiness({
    postgres: async () => {
      throw new Error('secret connection text');
    },
    mssql: async () => undefined
  });

  assert.deepEqual(result, {
    ready: false,
    status: 'not_ready',
    dependencies: { postgres: 'error', mssql: 'ok' }
  });
  assert.doesNotMatch(JSON.stringify(result), /secret connection text/);
});

test('health is live without dependency checks', async () => {
  const app = express();
  app.use('/api', createHealthRouter({
    postgres: async () => { throw new Error('must not run'); },
    mssql: async () => { throw new Error('must not run'); }
  }));

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { status: string }).status, 'ok');
  });
});

test('ready route returns 200 or 503 from safe dependency state', async () => {
  const healthyApp = express();
  healthyApp.use('/api', createHealthRouter({
    postgres: async () => undefined,
    mssql: async () => undefined
  }));
  await withServer(healthyApp, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/ready`);
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { ready: boolean }).ready, true);
  });

  const failingApp = express();
  failingApp.use('/api', createHealthRouter({
    postgres: async () => { throw new Error('secret connection text'); },
    mssql: async () => undefined
  }));
  await withServer(failingApp, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/ready`);
    const body = await response.text();
    assert.equal(response.status, 503);
    assert.doesNotMatch(body, /secret connection text/);
  });
});
