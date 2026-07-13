import assert from 'node:assert/strict';
import test from 'node:test';
import type { NextFunction, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth';

const createRequest = (lastSeenAt: string) => {
  let saveCalls = 0;
  const createdAt = new Date().toISOString();
  const req = {
    session: {
      auth: {
        accountType: 'TUTOR' as const,
        accountId: 42,
        franchiseId: 7,
        displayName: 'Test Tutor',
        createdAt,
        lastSeenAt
      },
      save(callback: (err?: unknown) => void) {
        saveCalls += 1;
        callback();
      },
      destroy(callback: (err?: unknown) => void) {
        callback();
      }
    }
  } as unknown as Request;

  return { req, getSaveCalls: () => saveCalls };
};

const createResponse = (): Response =>
  ({
    status() {
      return this;
    },
    json() {
      return this;
    }
  }) as unknown as Response;

test('requireAuth skips a forced save when lastSeenAt is less than one minute old', () => {
  const { req, getSaveCalls } = createRequest(new Date(Date.now() - 10_000).toISOString());
  let nextCalls = 0;

  requireAuth(req, createResponse(), (() => {
    nextCalls += 1;
  }) as NextFunction);

  assert.equal(nextCalls, 1);
  assert.equal(getSaveCalls(), 0);
});

test('requireAuth persists activity when lastSeenAt is at least one minute old', () => {
  const staleLastSeenAt = new Date(Date.now() - 61_000).toISOString();
  const { req, getSaveCalls } = createRequest(staleLastSeenAt);
  let nextCalls = 0;

  requireAuth(req, createResponse(), (() => {
    nextCalls += 1;
  }) as NextFunction);

  assert.equal(nextCalls, 1);
  assert.equal(getSaveCalls(), 1);
  assert.notEqual(req.session.auth?.lastSeenAt, staleLastSeenAt);
  assert.ok(Date.parse(req.session.auth!.lastSeenAt) > Date.now() - 5_000);
});

test('requireAuth persists activity when lastSeenAt is invalid', () => {
  const { req, getSaveCalls } = createRequest('invalid');
  let nextCalls = 0;

  requireAuth(req, createResponse(), (() => {
    nextCalls += 1;
  }) as NextFunction);

  assert.equal(nextCalls, 1);
  assert.equal(getSaveCalls(), 1);
  assert.ok(Number.isFinite(Date.parse(req.session.auth!.lastSeenAt)));
});
