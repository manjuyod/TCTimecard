import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Response } from 'express';
import { createExportConcurrencyGuard, rejectBusyExport } from '../services/exportConcurrency';

test('three export permits are admitted and the fourth is rejected', () => {
  const guard = createExportConcurrencyGuard(3);
  const releases = [guard.tryAcquire(), guard.tryAcquire(), guard.tryAcquire()];

  assert.ok(releases.every((release) => typeof release === 'function'));
  assert.equal(guard.activeCount, 3);
  assert.equal(guard.tryAcquire(), null);
});

test('release is idempotent and makes a slot available', () => {
  const guard = createExportConcurrencyGuard(1);
  const release = guard.tryAcquire();
  assert.ok(release);
  assert.equal(guard.tryAcquire(), null);

  release();
  release();
  assert.equal(guard.activeCount, 0);
  assert.ok(guard.tryAcquire());
});

test('busy response is immediately retryable and safe', () => {
  const headers = new Map<string, string>();
  let statusCode = 0;
  let payload: unknown;
  const response = {
    setHeader: (name: string, value: string | number) => headers.set(name.toLowerCase(), String(value)),
    status: (code: number) => {
      statusCode = code;
      return response;
    },
    json: (body: unknown) => {
      payload = body;
      return response;
    }
  } as unknown as Response;

  rejectBusyExport(response, () => undefined);

  assert.equal(statusCode, 429);
  assert.equal(headers.get('retry-after'), '15');
  assert.deepEqual(payload, { error: 'Exports are busy. Please retry shortly.' });
});
