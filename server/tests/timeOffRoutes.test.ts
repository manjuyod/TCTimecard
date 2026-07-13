import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { afterEach, describe, it } from 'node:test';
import express, { Request } from 'express';
import { Server } from 'node:http';
import { createTimeOffRouter, isTimeOffOverlapEnabled } from '../routes/timeoff';
import { TimeOffRecord } from '../types/timeoff';
import { FranchiseContact } from '../services/franchiseContact';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

const baseRequest: TimeOffRecord = {
  id: 42,
  franchiseId: 6,
  tutorId: 123,
  bridgeFlag: false,
  bridgeProfileId: null,
  firstName: 'Ada',
  lastName: 'Lovelace',
  tutorName: 'Ada Lovelace',
  tutorEmail: 'ada@example.com',
  startAt: '2026-07-26T07:00:00.000Z',
  endAt: '2026-07-27T07:00:00.000Z',
  startDate: '2026-07-26',
  endDate: '2026-07-26',
  type: 'pto',
  absenceLabel: 'Paid Time Off',
  reason: 'Family vacation out of town',
  notes: 'Family vacation out of town',
  status: 'pending',
  createdAt: '2026-07-12T18:00:00.000Z',
  createdBy: 123,
  decidedAt: null,
  decidedBy: null,
  decisionReason: null,
  googleCalendarEventId: null,
  durationHours: 24,
  partialDay: false,
  leaveTime: null,
  returnTime: null,
  source: 'authenticated'
};

describe('time-off routes', () => {
  it('preserves the existing opt-in overlap guard', () => {
    assert.equal(isTimeOffOverlapEnabled(undefined), false);
    assert.equal(isTimeOffOverlapEnabled('true'), true);
  });

  it('returns server-calculated policy for the authenticated tutor franchise', async () => {
    const origin = await startApp('TUTOR', {
      resolveTimezone: async () => 'America/Los_Angeles',
      nowIso: () => '2026-07-12T18:00:00.000Z'
    });
    const response = await fetch(`${origin}/api/timeoff/policy`);
    assert.equal(response.status, 200);
    const body = await response.json() as { policy: { today: string; minimumStartDate: string } };
    assert.equal(body.policy.today, '2026-07-12');
    assert.equal(body.policy.minimumStartDate, '2026-07-26');
  });

  it('saves a valid request and returns a notification warning without failing submission', async () => {
    let created = false;
    let emailedToken = '';
    const origin = await startApp('TUTOR', {
      resolveTimezone: async () => 'America/Los_Angeles',
      nowIso: () => '2026-07-12T18:00:00.000Z',
      createDecisionToken: () => ({
        rawToken: 'A'.repeat(43),
        tokenHash: 'a'.repeat(64),
        expiresAt: '2026-07-19T18:00:00.000Z'
      }),
      checkOverlap: async () => false,
      fetchTutor: async () => ({ tutorId: 123, firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' }),
      fetchCenter: async () => ({ id: 6, name: 'Anthem', email: 'admin@example.com', gmailId: null }),
      createRequest: async (args: { decisionToken?: { tokenHash: string; expiresAt: string } }) => {
        created = true;
        assert.deepEqual(args.decisionToken, {
          tokenHash: 'a'.repeat(64),
          expiresAt: '2026-07-19T18:00:00.000Z'
        });
        return baseRequest;
      },
      appendAudit: async () => undefined,
      sendAdminNotification: async (_request: TimeOffRecord, _center: FranchiseContact | null, _actorId: number, rawToken: string) => {
        emailedToken = rawToken;
        return {
          kind: 'admin_request',
          status: 'failed',
          warning: 'The request was saved, but the admin notification failed. An administrator can retry it.'
        };
      }
    });

    const response = await fetch(`${origin}/api/timeoff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        startDate: '2026-07-26',
        endDate: '2026-07-26',
        partialDay: false,
        type: 'pto',
        reason: 'Family vacation out of town'
      })
    });
    const body = await response.json() as { notification: { status: string } };
    assert.equal(response.status, 201);
    assert.equal(created, true);
    assert.equal(emailedToken, 'A'.repeat(43));
    assert.equal(body.notification.status, 'failed');
  });

  it('still returns a saved request when franchise routing lookup fails', async () => {
    const origin = await startApp('TUTOR', {
      resolveTimezone: async () => 'America/Los_Angeles',
      nowIso: () => '2026-07-12T18:00:00.000Z',
      checkOverlap: async () => false,
      fetchTutor: async () => ({ tutorId: 123, firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com' }),
      fetchCenter: async () => { throw new Error('directory unavailable'); },
      createRequest: async () => baseRequest,
      appendAudit: async () => undefined,
      sendAdminNotification: async (_request: TimeOffRecord, center: FranchiseContact | null) => ({
        kind: 'admin_request',
        status: center === null ? 'failed' : 'sent',
        warning: center === null ? 'The request was saved, but the admin notification failed.' : undefined
      })
    });
    const response = await fetch(`${origin}/api/timeoff`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        startDate: '2026-07-26', endDate: '2026-07-26', partialDay: false,
        type: 'pto', reason: 'Family vacation out of town'
      })
    });
    const body = await response.json() as { notification?: { status: string } };
    assert.equal(response.status, 201);
    assert.equal(body.notification?.status, 'failed');
  });

  it('returns public-origin rows in the unified admin pending queue', async () => {
    const publicRequest = { ...baseRequest, id: 50, tutorId: null, bridgeFlag: true, bridgeProfileId: 900, source: 'public' as const };
    const origin = await startApp('ADMIN', {
      resolveTimezone: async () => 'America/Los_Angeles',
      listAdminPending: async () => [publicRequest]
    });
    const response = await fetch(`${origin}/api/timeoff/admin/pending?franchiseId=6`);
    const body = await response.json() as { requests: TimeOffRecord[] };
    assert.equal(response.status, 200);
    assert.equal(body.requests[0]?.source, 'public');
    assert.equal(body.requests[0]?.tutorId, null);
  });

  it('previews a sanitized email decision without a session', async () => {
    const origin = await startPublicApp({
      previewEmailDecision: async () => baseRequest
    });
    const response = await fetch(`${origin}/api/timeoff/email-decision/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'A'.repeat(43) })
    });
    const body = await response.json() as { request: Record<string, unknown> };

    assert.equal(response.status, 200);
    assert.deepEqual(Object.keys(body.request).sort(), [
      'absenceLabel', 'endDate', 'leaveTime', 'partialDay', 'requestReason',
      'requesterEmail', 'requesterName', 'returnTime', 'startDate'
    ]);
    assert.equal(body.request.requesterName, 'Ada Lovelace');
    assert.equal(body.request.requesterEmail, 'ada@example.com');
  });

  it('decides from email without a session and allows a blank reason', async () => {
    let receivedReason: string | null | undefined;
    const denied = { ...baseRequest, status: 'denied' as const, decisionReason: 'Email correspondence' };
    const origin = await startPublicApp({
      decideEmailRequest: async (args: { reason?: string | null }) => {
        receivedReason = args.reason;
        return {
          kind: 'ok',
          request: denied,
          notification: { kind: 'requester_decision', status: 'sent' }
        };
      }
    });
    const response = await fetch(`${origin}/api/timeoff/email-decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'A'.repeat(43), decision: 'deny', reason: '' })
    });
    const body = await response.json() as {
      status: string;
      decisionReason: string;
      notification: { status: string };
    };

    assert.equal(response.status, 200);
    assert.equal(receivedReason, null);
    assert.equal(body.status, 'denied');
    assert.equal(body.decisionReason, 'Email correspondence');
    assert.equal(body.notification.status, 'sent');
  });

  it('keeps an email decision successful when requester notification fails', async () => {
    const denied = { ...baseRequest, status: 'denied' as const, decisionReason: 'Email correspondence' };
    const origin = await startPublicApp({
      decideEmailRequest: async () => ({
        kind: 'ok',
        request: denied,
        notification: {
          kind: 'requester_decision',
          status: 'failed',
          warning: 'Decision saved, but the requester notification could not be sent.'
        }
      })
    });
    const response = await fetch(`${origin}/api/timeoff/email-decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'A'.repeat(43), decision: 'deny', reason: '' })
    });
    const body = await response.json() as {
      status: string;
      notification: { status: string; warning?: string };
    };

    assert.equal(response.status, 200);
    assert.equal(body.status, 'denied');
    assert.equal(body.notification.status, 'failed');
    assert.match(body.notification.warning ?? '', /Decision saved/);
  });

  it('returns one generic result for an unusable email decision token', async () => {
    const origin = await startPublicApp({
      previewEmailDecision: async () => null
    });
    const response = await fetch(`${origin}/api/timeoff/email-decision/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'legacy-token-that-does-not-exist'.padEnd(43, 'x') })
    });
    const body = await response.json() as { error: string };

    assert.equal(response.status, 404);
    assert.equal(body.error, 'Decision link is invalid, expired, or already used.');
    assert.equal(JSON.stringify(body).includes('Ada'), false);
  });

  it('returns a safe retryable error when email approval calendar sync fails', async () => {
    const origin = await startPublicApp({
      decideEmailRequest: async () => ({
        kind: 'calendar_failed',
        request: baseRequest,
        error: 'Google Calendar quota response with provider details'
      })
    });
    const response = await fetch(`${origin}/api/timeoff/email-decision`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'A'.repeat(43), decision: 'approve', reason: '' })
    });
    const body = await response.json() as { error: string };

    assert.equal(response.status, 502);
    assert.equal(body.error, 'Decision could not be saved right now. Please try again later.');
    assert.equal(JSON.stringify(body).includes('Google'), false);
  });

  it('hides unexpected preview provider errors and requester data', async () => {
    const origin = await startPublicApp({
      previewEmailDecision: async () => {
        throw new Error('database failed while loading Ada ada@example.com');
      }
    });
    const response = await fetch(`${origin}/api/timeoff/email-decision/preview`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: 'A'.repeat(43) })
    });
    const body = await response.json() as { error: string };

    assert.equal(response.status, 500);
    assert.equal(body.error, 'Decision could not be saved right now. Please try again later.');
    assert.equal(JSON.stringify(body).includes('Ada'), false);
  });
});

async function startApp(accountType: 'TUTOR' | 'ADMIN', overrides: Record<string, unknown>): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as Request).session = {
      auth: {
        accountType,
        accountId: 123,
        franchiseId: 6,
        displayName: 'Ada Lovelace',
        createdAt: new Date().toISOString(),
        lastSeenAt: new Date().toISOString()
      },
      save(callback: (error?: unknown) => void) { callback(); },
      destroy(callback: (error?: unknown) => void) { callback(); }
    } as Request['session'];
    next();
  });
  app.use('/api', createTimeOffRouter(overrides));
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}

async function startPublicApp(overrides: Record<string, unknown>): Promise<string> {
  const app = express();
  app.use(express.json());
  app.use('/api', createTimeOffRouter(overrides));
  const server = app.listen(0);
  servers.push(server);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const { port } = server.address() as AddressInfo;
  return `http://127.0.0.1:${port}`;
}
