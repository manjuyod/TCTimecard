import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { afterEach, test } from 'node:test';
import express from 'express';
import type { Server } from 'node:http';
import { createPtoRouter, type PtoRouteDeps } from '../routes/pto';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

const profile = {
  profile: { id: '10', firstName: 'Ada', lastName: 'Lovelace', identityStatus: 'confirmed' as const, active: true,
    balance: { grantedDays: 5, balanceDays: 4, reservedDays: 1, availableDays: 3 } },
  memberships: [{ id: '20', franchiseid: 6, tutorId: 123, active: true }],
  emails: [
    { id: '30', email: 'ada@example.com', active: true, source: 'crm', sourceMembershipId: '20' },
    { id: '31', email: 'manual@example.com', active: true, source: 'manual', sourceMembershipId: '20' }
  ],
  balance: { grantedDays: 5, balanceDays: 4, reservedDays: 1, availableDays: 3 },
  unresolvedReason: null
};

const adminProfile = {
  ...profile.profile,
  memberships: profile.memberships,
  emails: profile.emails,
  candidates: [],
  ledger: [],
  requests: [],
  audit: []
};

const quote = {
  eligible: true as const,
  reason: 'eligible' as const,
  chargeDays: 1,
  cycleAllocations: [{ cycleStart: '2026-01-01', days: 1 }],
  balance: {
    cycleStart: '2026-01-01', cycleEnd: '2026-12-31', renewsOn: '2027-01-01',
    grantedDays: 5, adjustedDays: -1, availableDays: 3, reservedDays: 1, usedDays: 0
  }
};

const baseDeps = (): PtoRouteDeps => ({
  nowIso: () => '2026-08-16T12:00:00.000Z',
  resolveTimezone: async () => 'America/Los_Angeles',
  resolveTimeOffNoticeRequired: async () => false,
  getProgramPolicy: async () => ({ id: '1', effectiveFrom: '1970-01-01', entitlementDays: 5, renewalMonth: 1, renewalDay: 1, carryoverDays: 0 }),
  getCenterStatus: async (franchiseId) => ({ franchiseId, enabled: true, firstActivatedAt: '2026-01-01T00:00:00.000Z', lastSuccessfulSyncAt: '2026-08-15T00:00:00.000Z', lastSyncError: null }),
  previewActivation: async () => ({ activeCrmTutorCount: 1, newMembershipCount: 0, newProfileCount: 0, pendingExactNameCandidateCount: 0, warnings: [], policy: { id: '1', effectiveFrom: '1970-01-01', entitlementDays: 5, renewalMonth: 1, renewalDay: 1, carryoverDays: 0 } }),
  syncRoster: async () => ({ activeTutorCount: 1, activatedMembershipCount: 1, deactivatedMembershipCount: 0, createdProfileCount: 0, pendingCandidateCount: 0, lastSuccessfulSyncAt: '2026-08-16T12:00:00.000Z' }),
  deactivateCenter: async (input) => ({ franchiseId: input.franchiseId, enabled: false, firstActivatedAt: '2026-01-01T00:00:00.000Z', lastSuccessfulSyncAt: '2026-08-15T00:00:00.000Z', lastSyncError: null }),
  getTutorProfile: async () => profile,
  getBalanceSummary: async () => quote.balance,
  quoteAuthenticated: async () => quote,
  quotePublic: async () => quote,
  listProfiles: async () => ({ items: [], page: 1, pageSize: 25, total: 0 }),
  getAdminProfile: async () => adminProfile,
  decideAlias: async (input) => ({ profileId: '10', decision: input.decision }),
  detachMembership: async () => ({ sourceProfileId: '10', detachedProfileId: '11' }),
  addEmail: async (input) => ({ id: '32', email: input.email, active: true, source: 'manual', sourceMembershipId: input.membershipId }),
  removeEmail: async (input) => ({ id: input.emailId, email: 'manual@example.com', active: false, source: 'manual', sourceMembershipId: '20' }),
  adjustBalance: async () => ({ ledgerEntryId: '40', availableDays: 3.5 }),
  listAudit: async () => ({ items: [], page: 1, pageSize: 25, total: 0 })
});

const startApp = async (deps: PtoRouteDeps, auth?: { accountType: 'TUTOR' | 'ADMIN'; accountId: number; franchiseId: number }) => {
  const app = express();
  app.use(express.json());
  if (auth) app.use((req, _res, next) => {
    const now = new Date().toISOString();
    (req as never as { session: {
      auth: object;
      save(callback?: (error?: Error) => void): void;
      destroy(callback: (error?: Error) => void): void;
    } }).session = {
      auth: { ...auth, createdAt: now, lastSeenAt: now },
      save: (callback) => callback?.(),
      destroy: (callback: (error?: Error) => void) => callback()
    };
    next();
  });
  app.use('/api', createPtoRouter(deps));
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    res.status(500).json({ error: error instanceof Error ? error.message : 'Internal server error' });
  });
  const server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
};

test('authenticated tutor reads the canonical profile and receives a balance-bearing quote', async () => {
  let quoteInput: Parameters<PtoRouteDeps['quoteAuthenticated']>[0] | undefined;
  const deps = baseDeps();
  deps.quoteAuthenticated = async (input) => { quoteInput = input; return quote; };
  const base = await startApp(deps, { accountType: 'TUTOR', accountId: 123, franchiseId: 6 });
  const me = await fetch(`${base}/api/pto/me`);
  assert.equal(me.status, 200);
  assert.deepEqual((await me.json() as { profile: unknown }).profile, profile.profile);
  const response = await fetch(`${base}/api/pto/me/quote`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ startDate: '2026-08-17', endDate: '2026-08-17', partialDay: false })
  });
  assert.equal(response.status, 200);
  assert.equal((await response.json() as { balance?: unknown }).balance !== undefined, true);
  assert.equal(quoteInput?.franchiseId, 6);
  assert.equal(quoteInput?.tutorId, 123);
  assert.equal(quoteInput?.chargeDays, 1);
});

test('tutor email mutations derive profile and membership and reject CRM email deletion', async () => {
  let added: Parameters<PtoRouteDeps['addEmail']>[0] | undefined;
  const deps = baseDeps();
  deps.addEmail = async (input) => { added = input; return { id: '32', email: input.email, active: true, source: 'manual', sourceMembershipId: input.membershipId }; };
  const base = await startApp(deps, { accountType: 'TUTOR', accountId: 123, franchiseId: 6 });
  const add = await fetch(`${base}/api/pto/me/emails`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'New@Example.com' })
  });
  assert.equal(add.status, 201);
  assert.deepEqual({ profileId: added?.profileId, membershipId: added?.membershipId, actorFranchiseId: added?.actorFranchiseId },
    { profileId: '10', membershipId: '20', actorFranchiseId: 6 });
  const removeCrm = await fetch(`${base}/api/pto/me/emails/30`, { method: 'DELETE' });
  assert.equal(removeCrm.status, 403);
});

test('public quote requires a bearer center token and never exposes identity or balances', async () => {
  let rawToken = '';
  const deps = baseDeps();
  deps.quotePublic = async (input) => { rawToken = input.token; return quote; };
  const base = await startApp(deps);
  assert.equal((await fetch(`${base}/api/pto/public/quote`, { method: 'POST' })).status, 401);
  const response = await fetch(`${base}/api/pto/public/quote`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer center-secret' },
    body: JSON.stringify({ email: 'ada@example.com', startDate: '2026-08-17', endDate: '2026-08-17', partialDay: false })
  });
  assert.equal(response.status, 200);
  assert.equal(rawToken, 'center-secret');
  const body = await response.json() as Record<string, unknown>;
  assert.deepEqual(Object.keys(body).sort(), ['chargeDays', 'cycleAllocations', 'eligible', 'reason']);
});

test('admin PTO routes enforce selected center scope and expose every lifecycle endpoint', async () => {
  const calls: Array<{ name: string; value: unknown }> = [];
  const deps = baseDeps();
  deps.previewActivation = async (franchiseId) => { calls.push({ name: 'preview', value: franchiseId }); return baseDeps().previewActivation(franchiseId); };
  deps.syncRoster = async (input) => { calls.push({ name: input.activate ? 'activate' : 'sync', value: input.franchiseId }); return baseDeps().syncRoster(input); };
  deps.deactivateCenter = async (input) => { calls.push({ name: 'deactivate', value: input.franchiseId }); return baseDeps().deactivateCenter(input); };
  deps.listProfiles = async (input) => { calls.push({ name: 'profiles', value: input.franchiseId }); return { items: [], page: 1, pageSize: 25, total: 0 }; };
  deps.getAdminProfile = async (input) => { calls.push({ name: 'profile', value: input.franchiseId }); return adminProfile; };
  deps.decideAlias = async (input) => { calls.push({ name: 'alias', value: input.actorFranchiseId }); return { profileId: '10', decision: input.decision }; };
  deps.detachMembership = async (input) => { calls.push({ name: 'detach', value: input.actorFranchiseId }); return { sourceProfileId: input.profileId, detachedProfileId: '11' }; };
  deps.addEmail = async (input) => { calls.push({ name: 'admin-email-add', value: input.actorFranchiseId }); return { id: '32', email: input.email, active: true, source: 'manual', sourceMembershipId: input.membershipId }; };
  deps.removeEmail = async (input) => { calls.push({ name: 'admin-email-remove', value: input.actorFranchiseId }); return { id: input.emailId, email: 'x@example.com', active: false, source: 'manual', sourceMembershipId: null }; };
  deps.adjustBalance = async (input) => { calls.push({ name: 'adjust', value: input.actorFranchiseId }); return { ledgerEntryId: '40', availableDays: 3 }; };
  deps.listAudit = async (input) => { calls.push({ name: 'audit', value: input.franchiseId }); return { items: [], page: 1, pageSize: 25, total: 0 }; };
  const base = await startApp(deps, { accountType: 'ADMIN', accountId: 900, franchiseId: 1 });
  const requests: Array<[string, string, unknown?]> = [
    ['GET', '/api/pto/admin/activation-preview?franchiseId=77'],
    ['POST', '/api/pto/admin/activate', { franchiseId: 77 }],
    ['POST', '/api/pto/admin/deactivate', { franchiseId: 77 }],
    ['POST', '/api/pto/admin/sync', { franchiseId: 77 }],
    ['GET', '/api/pto/admin/profiles?franchiseId=77'],
    ['GET', '/api/pto/admin/profiles/10?franchiseId=77'],
    ['POST', '/api/pto/admin/aliases/12/decide', { franchiseId: 77, decision: 'confirm' }],
    ['POST', '/api/pto/admin/profiles/10/memberships/20/detach', { franchiseId: 77 }],
    ['POST', '/api/pto/admin/profiles/10/emails', { franchiseId: 77, membershipId: 20, email: 'x@example.com' }],
    ['DELETE', '/api/pto/admin/profiles/10/emails/31?franchiseId=77'],
    ['POST', '/api/pto/admin/profiles/10/adjustments', { franchiseId: 77, cycleStart: '2026-01-01', deltaDays: 0.5, reason: 'Correction' }],
    ['GET', '/api/pto/admin/audit?franchiseId=77']
  ];
  for (const [method, path, body] of requests) {
    const response = await fetch(`${base}${path}`, {
      method, headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined
    });
    assert.equal(response.status >= 200 && response.status < 300, true, `${method} ${path} returned ${response.status}`);
  }
  assert.equal(calls.every((call) => call.value === 77), true);
});

test('fixed-center admin cannot override the session franchise and invalid ids are rejected before services', async () => {
  let receivedCenter = 0;
  const deps = baseDeps();
  deps.getAdminProfile = async (input) => { receivedCenter = input.franchiseId; return adminProfile; };
  const base = await startApp(deps, { accountType: 'ADMIN', accountId: 900, franchiseId: 9 });
  assert.equal((await fetch(`${base}/api/pto/admin/profiles/nope?franchiseId=77`)).status, 400);
  const response = await fetch(`${base}/api/pto/admin/profiles/10?franchiseId=77`);
  assert.equal(response.status, 200);
  assert.equal(receivedCenter, 9);
});

test('invalid pagination is rejected before PTO list services run', async () => {
  let calls = 0;
  const deps = baseDeps();
  deps.listProfiles = async () => { calls += 1; return { items: [], page: 1, pageSize: 25, total: 0 }; };
  deps.listAudit = async () => { calls += 1; return { items: [], page: 1, pageSize: 25, total: 0 }; };
  const base = await startApp(deps, { accountType: 'ADMIN', accountId: 900, franchiseId: 9 });
  assert.equal((await fetch(`${base}/api/pto/admin/profiles?page=0`)).status, 400);
  assert.equal((await fetch(`${base}/api/pto/admin/audit?pageSize=1.5`)).status, 400);
  assert.equal(calls, 0);
});

test('invalid manual emails are rejected before PTO email services run', async () => {
  let calls = 0;
  const deps = baseDeps();
  deps.addEmail = async (input) => { calls += 1; return baseDeps().addEmail(input); };
  const tutorBase = await startApp(deps, { accountType: 'TUTOR', accountId: 123, franchiseId: 6 });
  const tutorResponse = await fetch(`${tutorBase}/api/pto/me/emails`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'not-an-email' })
  });
  assert.equal(tutorResponse.status, 400);
  const adminBase = await startApp(deps, { accountType: 'ADMIN', accountId: 900, franchiseId: 9 });
  const adminResponse = await fetch(`${adminBase}/api/pto/admin/profiles/10/emails`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ membershipId: 20, email: 'not-an-email' })
  });
  assert.equal(adminResponse.status, 400);
  assert.equal(calls, 0);
});

test('invalid adjustment dates and deltas are rejected before the balance service runs', async () => {
  let calls = 0;
  const deps = baseDeps();
  deps.adjustBalance = async () => { calls += 1; return { ledgerEntryId: '40', availableDays: 3.5 }; };
  const base = await startApp(deps, { accountType: 'ADMIN', accountId: 900, franchiseId: 9 });
  for (const body of [
    { cycleStart: '2026-13-40', deltaDays: 0.5, reason: 'Correction' },
    { cycleStart: '2026-01-01', deltaDays: 0, reason: 'Correction' },
    { cycleStart: '2026-01-01', deltaDays: 0.25, reason: 'Correction' }
  ]) {
    const response = await fetch(`${base}/api/pto/admin/profiles/10/adjustments`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    assert.equal(response.status, 400);
  }
  assert.equal(calls, 0);
});

test('stable PTO domain failures map to safe conflict responses', async () => {
  const deps = baseDeps();
  deps.quoteAuthenticated = async () => { throw Object.assign(new Error('database detail must not leak'), { code: 'PTO_INSUFFICIENT_BALANCE' }); };
  const base = await startApp(deps, { accountType: 'TUTOR', accountId: 123, franchiseId: 6 });
  const response = await fetch(`${base}/api/pto/me/quote`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ startDate: '2026-08-17', endDate: '2026-08-17', partialDay: false })
  });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'Insufficient PTO balance', code: 'PTO_INSUFFICIENT_BALANCE' });
});
