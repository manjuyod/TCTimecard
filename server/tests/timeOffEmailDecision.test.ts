import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decideTimeOffByEmailToken, previewTimeOffEmailDecision } from '../services/timeOffDecision';
import { TimeOffRecord } from '../types/timeoff';

const request = {
  id: 42,
  franchiseId: 6,
  tutorId: 123,
  status: 'pending'
} as TimeOffRecord;

describe('time-off email decision workflow', () => {
  it('normalizes a blank reason before a token-authorized denial', async () => {
    const lockedCalls: Array<Record<string, unknown>> = [];
    const result = await decideTimeOffByEmailToken(
      {
        rawToken: 'A'.repeat(43),
        nowIso: '2026-07-12T18:00:00.000Z',
        decision: 'deny',
        reason: ''
      },
      {
        findFranchiseId: async () => 6,
        resolveTimezone: async () => 'America/Los_Angeles',
        decideLocked: async (args) => {
          lockedCalls.push(args);
          return {
            kind: 'ok',
            request: { ...request, status: 'denied', decisionReason: 'Email correspondence' },
            notification: { kind: 'requester_decision', status: 'sent' }
          };
        }
      }
    );

    assert.equal(result.kind, 'ok');
    assert.equal(lockedCalls[0]?.reason, 'Email correspondence');
    assert.match(String(lockedCalls[0]?.tokenHash), /^[a-f0-9]{64}$/);
    assert.equal(lockedCalls[0]?.actorAccountType, 'ADMIN_EMAIL');
    assert.equal(lockedCalls[0]?.actorId, null);
  });

  it('resolves a valid token through its database franchise scope', async () => {
    const calls: string[] = [];
    const result = await previewTimeOffEmailDecision(
      { rawToken: 'A'.repeat(43), nowIso: '2026-07-12T18:00:00.000Z' },
      {
        findFranchiseId: async (tokenHash, nowIso) => {
          calls.push(`scope:${tokenHash}:${nowIso}`);
          return 6;
        },
        resolveTimezone: async (franchiseId) => {
          calls.push(`timezone:${franchiseId}`);
          return 'America/Los_Angeles';
        },
        fetchPending: async (tokenHash, nowIso, timezone) => {
          calls.push(`request:${tokenHash}:${nowIso}:${timezone}`);
          return request;
        }
      }
    );

    assert.equal(result, request);
    assert.equal(calls.length, 3);
    assert.match(calls[0] ?? '', /^scope:[a-f0-9]{64}:/);
    assert.equal(calls[1], 'timezone:6');
    assert.match(calls[2] ?? '', /America\/Los_Angeles$/);
  });

  it('rejects malformed tokens before touching persistence', async () => {
    let touched = false;
    const result = await previewTimeOffEmailDecision(
      { rawToken: 'short', nowIso: '2026-07-12T18:00:00.000Z' },
      {
        findFranchiseId: async () => {
          touched = true;
          return 6;
        },
        resolveTimezone: async () => 'America/Los_Angeles',
        fetchPending: async () => request
      }
    );

    assert.equal(result, null);
    assert.equal(touched, false);
  });
});
