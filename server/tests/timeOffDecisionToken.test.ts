import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createTimeOffDecisionToken,
  hashTimeOffDecisionToken,
  issueTimeOffDecisionToken,
  isAcceptedTimeOffDecisionToken,
  isTimeOffDecisionTokenExpired,
  normalizeEmailDecisionReason
} from '../services/timeOffDecisionToken';

describe('time-off email decision tokens', () => {
  it('issues a fresh token only after its hash and expiry are persisted', async () => {
    const stored: Array<{ tokenHash: string; expiresAt: string }> = [];
    const created = await issueTimeOffDecisionToken(
      '2026-07-12T12:00:00.000Z',
      async (tokenHash, expiresAt) => {
        stored.push({ tokenHash, expiresAt });
        return true;
      }
    );

    assert.match(created?.rawToken ?? '', /^[A-Za-z0-9_-]{43}$/);
    assert.equal(stored[0]?.tokenHash, hashTimeOffDecisionToken(created?.rawToken ?? ''));
    assert.equal(stored[0]?.expiresAt, '2026-07-19T12:00:00.000Z');
  });

  it('does not expose a raw token when persistence rejects rotation', async () => {
    const created = await issueTimeOffDecisionToken(
      '2026-07-12T12:00:00.000Z',
      async () => false
    );

    assert.equal(created, null);
  });

  it('creates a 256-bit token and stores a seven-day hash/expiry pair', () => {
    const created = createTimeOffDecisionToken('2026-07-12T12:00:00.000Z');

    assert.match(created.rawToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(created.tokenHash, hashTimeOffDecisionToken(created.rawToken));
    assert.equal(created.expiresAt, '2026-07-19T12:00:00.000Z');
  });

  it('accepts current and source-compatible legacy token shapes', () => {
    assert.equal(isAcceptedTimeOffDecisionToken('A'.repeat(43)), true);
    assert.equal(isAcceptedTimeOffDecisionToken(`0.${'B'.repeat(43)}`), true);
    assert.equal(isAcceptedTimeOffDecisionToken('short'), false);
    assert.equal(isAcceptedTimeOffDecisionToken(`${'A'.repeat(43)}?leak=true`), false);
  });

  it('expires tokens at the exact expiry boundary', () => {
    const expiresAt = '2026-07-19T12:00:00.000Z';

    assert.equal(isTimeOffDecisionTokenExpired(expiresAt, '2026-07-19T11:59:59.999Z'), false);
    assert.equal(isTimeOffDecisionTokenExpired(expiresAt, expiresAt), true);
  });

  it('normalizes a blank email decision reason to the approved database value', () => {
    assert.equal(normalizeEmailDecisionReason(''), 'Email correspondence');
    assert.equal(normalizeEmailDecisionReason('   '), 'Email correspondence');
    assert.equal(normalizeEmailDecisionReason('Approved after coverage review'), 'Approved after coverage review');
  });
});
