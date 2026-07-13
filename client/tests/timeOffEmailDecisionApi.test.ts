import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { decideTimeOffByEmail, previewTimeOffEmailDecision } from '../src/lib/api';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('time-off email decision API client', () => {
  it('posts the bearer token in JSON rather than the URL', async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      calls.push({ input: String(input), init });
      return new Response(JSON.stringify({
        request: {
          requesterName: 'Ada Lovelace',
          requesterEmail: 'ada@example.com',
          startDate: '2026-07-26',
          endDate: '2026-07-26',
          absenceLabel: 'Paid Time Off',
          requestReason: 'Family vacation out of town',
          partialDay: false,
          leaveTime: null,
          returnTime: null
        }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const token = 'A'.repeat(43);
    const preview = await previewTimeOffEmailDecision(token);

    assert.equal(preview.requesterName, 'Ada Lovelace');
    assert.equal(calls[0]?.input, '/api/timeoff/email-decision/preview');
    assert.equal(calls[0]?.input.includes(token), false);
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), { token });
  });

  it('posts an explicit decision and optional reason', async () => {
    const calls: Array<{ input: string; init?: RequestInit }> = [];
    globalThis.fetch = async (input, init) => {
      calls.push({ input: String(input), init });
      return new Response(JSON.stringify({
        status: 'denied',
        decisionReason: 'Email correspondence',
        notification: { kind: 'requester_decision', status: 'sent' }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };

    const result = await decideTimeOffByEmail({
      token: 'A'.repeat(43),
      decision: 'deny',
      reason: ''
    });

    assert.equal(result.status, 'denied');
    assert.equal(calls[0]?.input, '/api/timeoff/email-decision');
    assert.deepEqual(JSON.parse(String(calls[0]?.init?.body)), {
      token: 'A'.repeat(43),
      decision: 'deny',
      reason: ''
    });
  });
});
