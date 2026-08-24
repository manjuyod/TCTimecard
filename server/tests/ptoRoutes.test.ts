import assert from 'node:assert/strict';
import { AddressInfo } from 'node:net';
import { afterEach, test } from 'node:test';
import express from 'express';
import type { Server } from 'node:http';
import { createPtoRouter, type PtoRouteDeps } from '../routes/pto';
import { mapPtoHttpError } from '../services/pto/errors';

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
});

const profile = {
  profile: { id: '10', firstName: 'Ada', lastName: 'Lovelace', active: true,
    balance: { grantedDays: 5, balanceDays: 4, reservedDays: 1, availableDays: 3 } },
  memberships: [
    { id: '20', profileId: '10', franchiseId: 6, tutorId: 123, active: true,
      crmSnapshot: {}, firstSeenAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: '21', profileId: '10', franchiseId: 7, tutorId: 202, active: true,
      crmSnapshot: {}, firstSeenAt: '2026-02-01T00:00:00.000Z', updatedAt: '2026-02-01T00:00:00.000Z' }
  ],
  emails: [
    { id: '30', profileId: '10', franchiseId: 6, email: 'ada@example.com', active: true,
      source: 'crm' as const, sourceMembershipId: '20', createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: '31', profileId: '10', franchiseId: 6, email: 'manual@example.com', active: true,
      source: 'manual' as const, sourceMembershipId: '20', createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z' },
    { id: '32', profileId: '10', franchiseId: 7, email: 'ada.center7@example.com', active: true,
      source: 'crm' as const, sourceMembershipId: '21', createdAt: '2026-02-01T00:00:00.000Z',
      updatedAt: '2026-02-01T00:00:00.000Z' }
  ],
  balance: { grantedDays: 5, balanceDays: 4, reservedDays: 1, availableDays: 3 },
  unresolvedReason: null
};

const adminProfile = {
  ...profile.profile,
  memberships: profile.memberships,
  emails: profile.emails,
  accounts: [],
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

const syncHealth = {
  lastSuccessfulSyncAt: '2026-08-15T00:00:00.000Z',
  lastSyncError: null,
  lastSuccessfulRosterSyncAt: '2026-08-15T00:00:00.000Z',
  lastRosterSyncError: null,
  lastSuccessfulDiscoveryAt: '2026-08-15T00:00:01.000Z',
  lastDiscoveryError: null
};

const accountCounts = {
  discoveredAccountCount: 0,
  linkedAccountCount: 0,
  excludedAccountCount: 0,
  pendingReviewCount: 0
};

const baseDeps = (): PtoRouteDeps => ({
  nowIso: () => '2026-08-16T12:00:00.000Z',
  resolveTimezone: async () => 'America/Los_Angeles',
  resolveTimeOffNoticeRequired: async () => false,
  getProgramPolicy: async () => ({ id: '1', effectiveFrom: '1970-01-01', entitlementDays: 5, renewalMonth: 1, renewalDay: 1, carryoverDays: 0 }),
  getCenterStatus: async (franchiseId) => ({ franchiseId, enabled: true,
    firstActivatedAt: '2026-01-01T00:00:00.000Z', ...syncHealth }),
  syncRoster: async () => ({ activeTutorCount: 1, activatedMembershipCount: 1,
    deactivatedMembershipCount: 0, createdProfileCount: 0, ...accountCounts, pendingCandidateCount: 0,
    ...syncHealth, lastSuccessfulSyncAt: '2026-08-16T12:00:00.000Z', warnings: [] }),
  getTutorProfile: async () => profile,
  getBalanceSummary: async () => quote.balance,
  authorizePublicCenter: async () => ({ franchiseId: 6 }),
  quoteAuthenticated: async () => quote,
  quotePublic: async () => quote,
  listProfiles: async () => ({ items: [], page: 1, pageSize: 25, total: 0 }),
  getAdminProfile: async () => adminProfile,
  decideAlias: async (input) => ({ profileId: '10', decision: input.decision }),
  detachMembership: async () => ({ sourceProfileId: '10', detachedProfileId: '11' }),
  addEmail: async (input) => ({ id: '32', email: input.email, active: true, source: 'manual', sourceMembershipId: input.membershipId }),
  removeEmail: async (input) => ({ id: input.emailId, email: 'manual@example.com', active: false, source: 'manual', sourceMembershipId: '20' }),
  adjustBalance: async () => ({ ledgerEntryId: '40', availableDays: 3.5 }),
  previewAccountLink: async () => ({ mode: 'link', profileId: '10', account: {} as never, version: 1,
    beforeBalances: [], afterBalances: [], affectedRequestIds: [], ambiguousAdjustmentIds: [], warnings: [] }),
  linkAccount: async () => ({ canonicalProfileId: '10', detachedProfileId: null, decisionVersion: 2 }),
  previewAccountUnlink: async () => ({ mode: 'unlink', profileId: '10', account: {} as never, version: 2,
    beforeBalances: [], afterBalances: [], affectedRequestIds: [], ambiguousAdjustmentIds: [], warnings: [] }),
  unlinkAccount: async () => ({ canonicalProfileId: '10', detachedProfileId: '11', decisionVersion: 3 }),
  assignAdjustmentProvenance: async (input) => ({ ledgerEntryId: input.ledgerEntryId,
    membershipId: input.membershipId }),
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
  const meBody = await me.json() as { profile: unknown; memberships: unknown[]; emails: unknown[] };
  assert.deepEqual(meBody.profile, profile.profile);
  assert.deepEqual(meBody.memberships, profile.memberships);
  assert.deepEqual(meBody.emails, profile.emails);
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

test('tutor profile and quote use the center-local date across a UTC year boundary', async () => {
  let profileBalanceDate = '';
  let quoteBalanceDate: unknown;
  const deps = baseDeps();
  deps.nowIso = () => '2027-01-01T00:30:00.000Z';
  deps.resolveTimezone = async () => 'America/Los_Angeles';
  deps.getBalanceSummary = async (_profileId, balanceDate) => {
    profileBalanceDate = balanceDate;
    return quote.balance;
  };
  deps.quoteAuthenticated = async (input) => {
    quoteBalanceDate = (input as typeof input & { balanceDate?: string }).balanceDate;
    return quote;
  };
  const base = await startApp(deps, { accountType: 'TUTOR', accountId: 123, franchiseId: 6 });
  assert.equal((await fetch(`${base}/api/pto/me`)).status, 200);
  const response = await fetch(`${base}/api/pto/me/quote`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ startDate: '2026-12-31', endDate: '2026-12-31', partialDay: false })
  });
  assert.equal(response.status, 200);
  assert.equal(profileBalanceDate, '2026-12-31');
  assert.equal(quoteBalanceDate, '2026-12-31');
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
  deps.authorizePublicCenter = async (token) => { rawToken = token; return { franchiseId: 6 }; };
  deps.quotePublic = async () => quote;
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

test('public quote authorizes the center token before validating identity or dates', async () => {
  let quoted = false;
  const deps = { ...baseDeps(), authorizePublicCenter: async () => null } as PtoRouteDeps;
  deps.quotePublic = async () => { quoted = true; return quote; };
  const base = await startApp(deps);
  const response = await fetch(`${base}/api/pto/public/quote`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer inactive-secret' },
    body: JSON.stringify({ email: 'invalid', startDate: 'not-a-date', partialDay: false })
  });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: 'Center link is invalid or inactive', code: 'PTO_CENTER_LINK_INVALID' });
  assert.equal(quoted, false);
});

test('public quote uses the authorized center timezone, local date, and notice policy', async () => {
  let timezoneCenter = 0;
  let noticeCenter = 0;
  let quoteInput: Record<string, unknown> | undefined;
  const deps = { ...baseDeps(), authorizePublicCenter: async () => ({ franchiseId: 77 }) } as PtoRouteDeps;
  deps.nowIso = () => '2027-01-01T00:30:00.000Z';
  deps.resolveTimezone = async (franchiseId) => { timezoneCenter = franchiseId; return 'America/Los_Angeles'; };
  deps.resolveTimeOffNoticeRequired = async (franchiseId) => { noticeCenter = franchiseId; return false; };
  deps.quotePublic = async (input) => { quoteInput = input as unknown as Record<string, unknown>; return quote; };
  const base = await startApp(deps);
  const response = await fetch(`${base}/api/pto/public/quote`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer center-secret' },
    body: JSON.stringify({ email: 'ada@example.com', startDate: '2026-12-31', endDate: '2026-12-31', partialDay: false })
  });
  assert.equal(response.status, 200);
  assert.equal(timezoneCenter, 77);
  assert.equal(noticeCenter, 77);
  assert.equal(quoteInput?.franchiseId, 77);
  assert.equal(quoteInput?.balanceDate, '2026-12-31');

  deps.resolveTimeOffNoticeRequired = async () => true;
  const noticeBase = await startApp(deps);
  const noticeResponse = await fetch(`${noticeBase}/api/pto/public/quote`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer center-secret' },
    body: JSON.stringify({ email: 'ada@example.com', startDate: '2026-12-31', endDate: '2026-12-31', partialDay: false })
  });
  assert.equal(noticeResponse.status, 400);
});

test('enabled-center admin PTO routes enforce selected center scope and expose maintenance endpoints', async () => {
  const calls: Array<{ name: string; value: unknown }> = [];
  const deps = baseDeps();
  deps.syncRoster = async (input) => { calls.push({ name: 'sync', value: input.franchiseId }); return baseDeps().syncRoster(input); };
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
    ['POST', '/api/pto/admin/sync', { franchiseId: 77 }],
    ['GET', '/api/pto/admin/profiles?franchiseId=77'],
    ['GET', '/api/pto/admin/profiles/10?franchiseId=77'],
    ['POST', '/api/pto/admin/aliases/12/decide', { franchiseId: 77, decision: 'confirm' }],
    ['POST', '/api/pto/admin/profiles/10/memberships/20/detach', { franchiseId: 77 }],
    ['POST', '/api/pto/admin/profiles/10/emails', { franchiseId: 77, membershipId: 20, email: 'x@example.com' }],
    ['DELETE', '/api/pto/admin/profiles/10/emails/31?franchiseId=77'],
    ['POST', '/api/pto/admin/profiles/10/adjustments', { franchiseId: 77, membershipId: 20,
      cycleStart: '2026-01-01', deltaDays: 0.5, reason: 'Correction' }],
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

test('activation routes are unavailable and inactive-center administration is rejected before work starts', async () => {
  let syncCalls = 0;
  let profileCalls = 0;
  const deps = baseDeps();
  deps.getCenterStatus = async (franchiseId) => ({
    franchiseId,
    enabled: false,
    firstActivatedAt: null,
    ...syncHealth
  });
  deps.syncRoster = async () => {
    syncCalls += 1;
    return baseDeps().syncRoster({ franchiseId: 16, actorId: '900' });
  };
  deps.listProfiles = async () => {
    profileCalls += 1;
    return { items: [], page: 1, pageSize: 25, total: 0 };
  };
  const base = await startApp(deps, { accountType: 'ADMIN', accountId: 900, franchiseId: 16 });

  const removed: Array<[string, string]> = [
    ['GET', '/api/pto/admin/activation-preview?franchiseId=16'],
    ['POST', '/api/pto/admin/activate'],
    ['POST', '/api/pto/admin/deactivate']
  ];
  for (const [method, path] of removed) {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: method === 'POST' ? { 'Content-Type': 'application/json' } : undefined,
      body: method === 'POST' ? JSON.stringify({ franchiseId: 16 }) : undefined
    });
    assert.equal(response.status, 404, `${method} ${path} remained available`);
  }

  const sync = await fetch(`${base}/api/pto/admin/sync`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ franchiseId: 16 })
  });
  const profiles = await fetch(`${base}/api/pto/admin/profiles?franchiseId=16`);

  assert.equal(sync.status, 409);
  assert.deepEqual(await sync.json(), { error: 'PTO is disabled for this center', code: 'PTO_CENTER_DISABLED' });
  assert.equal(profiles.status, 409);
  assert.equal(syncCalls, 0);
  assert.equal(profileCalls, 0);
});

test('admin account link routes validate and forward scoped preview and mutation payloads', async () => {
  const calls: Array<{ name: string; input: unknown }> = [];
  const deps = baseDeps();
  const result = { canonicalProfileId: '10', detachedProfileId: null, decisionVersion: 4 };
  Object.assign(deps, {
    previewAccountLink: async (input: unknown) => {
      calls.push({ name: 'link-preview', input });
      return { mode: 'link', profileId: '10', account: {}, version: 3,
        beforeBalances: [], afterBalances: [], affectedRequestIds: [], ambiguousAdjustmentIds: [], warnings: [] };
    },
    linkAccount: async (input: unknown) => { calls.push({ name: 'link', input }); return result; },
    previewAccountUnlink: async (input: unknown) => {
      calls.push({ name: 'unlink-preview', input });
      return { mode: 'unlink', profileId: '10', account: {}, version: 3,
        beforeBalances: [], afterBalances: [], affectedRequestIds: [], ambiguousAdjustmentIds: [], warnings: [] };
    },
    unlinkAccount: async (input: unknown) => { calls.push({ name: 'unlink', input }); return result; },
    assignAdjustmentProvenance: async (input: unknown) => {
      calls.push({ name: 'provenance', input });
      return { ledgerEntryId: '55', membershipId: '20' };
    }
  });
  const base = await startApp(deps, { accountType: 'ADMIN', accountId: 900, franchiseId: 1 });
  const idempotencyKey = '00000000-0000-4000-8000-000000000030';
  const requests: Array<[string, string, Record<string, unknown>]> = [
    ['POST', '/api/pto/admin/profiles/10/accounts/99/link-preview',
      { franchiseId: 77, expectedVersion: 3 }],
    ['PUT', '/api/pto/admin/profiles/10/accounts/99/link',
      { franchiseId: 77, expectedVersion: 3, idempotencyKey }],
    ['POST', '/api/pto/admin/profiles/10/accounts/99/unlink-preview',
      { franchiseId: 77, expectedVersion: 3 }],
    ['DELETE', '/api/pto/admin/profiles/10/accounts/99/link',
      { franchiseId: 77, expectedVersion: 3, idempotencyKey }],
    ['PUT', '/api/pto/admin/profiles/10/adjustments/55/provenance',
      { franchiseId: 77, membershipId: 20, idempotencyKey }]
  ];
  for (const [method, route, body] of requests) {
    const response = await fetch(`${base}${route}`, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    assert.equal(response.status, 200, `${method} ${route} returned ${response.status}`);
  }
  assert.deepEqual(calls, [
    { name: 'link-preview', input: { profileId: '10', accountId: '99', actorId: '900',
      actorFranchiseId: 77, expectedVersion: 3 } },
    { name: 'link', input: { profileId: '10', accountId: '99', actorId: '900',
      actorFranchiseId: 77, expectedVersion: 3, idempotencyKey } },
    { name: 'unlink-preview', input: { profileId: '10', accountId: '99', actorId: '900',
      actorFranchiseId: 77, expectedVersion: 3 } },
    { name: 'unlink', input: { profileId: '10', accountId: '99', actorId: '900',
      actorFranchiseId: 77, expectedVersion: 3, idempotencyKey } },
    { name: 'provenance', input: { profileId: '10', ledgerEntryId: '55', membershipId: '20',
      actorId: '900', actorFranchiseId: 77, idempotencyKey } }
  ]);
});

test('admin account link routes reject invalid ids versions and idempotency keys before service calls', async () => {
  let calls = 0;
  const deps = baseDeps();
  Object.assign(deps, {
    previewAccountLink: async () => { calls += 1; throw new Error('unexpected'); },
    linkAccount: async () => { calls += 1; throw new Error('unexpected'); },
    assignAdjustmentProvenance: async () => { calls += 1; throw new Error('unexpected'); }
  });
  const base = await startApp(deps, { accountType: 'ADMIN', accountId: 900, franchiseId: 9 });
  const invalid = await Promise.all([
    fetch(`${base}/api/pto/admin/profiles/10/accounts/nope/link-preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: 1 })
    }),
    fetch(`${base}/api/pto/admin/profiles/10/accounts/99/link-preview`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: 0 })
    }),
    fetch(`${base}/api/pto/admin/profiles/10/accounts/99/link`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: 1, idempotencyKey: '' })
    }),
    fetch(`${base}/api/pto/admin/profiles/10/adjustments/55/provenance`, {
      method: 'PUT', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ membershipId: 0, idempotencyKey: 'key' })
    })
  ]);
  assert.deepEqual(invalid.map((response) => response.status), [400, 400, 400, 400]);
  assert.equal(calls, 0);
});

test('stable PTO account-link errors map to explicit safe responses', () => {
  const expected = [
    ['PTO_LINK_STALE', 409],
    ['PTO_ACCOUNT_ALREADY_LINKED', 409],
    ['PTO_CENTER_ACCOUNT_CONFLICT', 409],
    ['PTO_LINK_FORBIDDEN', 403],
    ['PTO_SPLIT_RECONCILIATION_REQUIRED', 409],
    ['PTO_DISCOVERY_STALE', 409]
  ] as const;
  for (const [code, status] of expected) {
    const mapped = mapPtoHttpError(Object.assign(new Error('database detail'), { code }), true);
    assert.equal(mapped?.status, status);
    assert.equal(mapped?.code, code);
    assert.doesNotMatch(mapped?.error ?? '', /database detail/i);
    const databaseMapped = mapPtoHttpError(new Error(`${code}: raw PostgreSQL detail`), true);
    assert.equal(databaseMapped?.status, status);
    assert.equal(databaseMapped?.code, code);
    assert.doesNotMatch(databaseMapped?.error ?? '', /PostgreSQL detail/i);
  }
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

test('an admin linked to the canonical profile may mutate another listed center membership', async () => {
  let received: Record<string, unknown> | undefined;
  const deps = baseDeps();
  deps.detachMembership = async (input) => {
    received = input as unknown as Record<string, unknown>;
    return { sourceProfileId: input.profileId, detachedProfileId: '11' };
  };
  const base = await startApp(deps, { accountType: 'ADMIN', accountId: 900, franchiseId: 9 });
  const response = await fetch(`${base}/api/pto/admin/profiles/10/memberships/200/detach`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ franchiseId: 77 })
  });
  assert.equal(response.status, 200);
  assert.equal(received?.profileId, '10');
  assert.equal(received?.membershipId, '200');
  assert.equal(received?.actorFranchiseId, 9);
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
    { membershipId: 20, cycleStart: '2026-13-40', deltaDays: 0.5, reason: 'Correction' },
    { membershipId: 20, cycleStart: '2026-01-01', deltaDays: 0, reason: 'Correction' },
    { membershipId: 20, cycleStart: '2026-01-01', deltaDays: 0.25, reason: 'Correction' }
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

test('real repository permission, identity, and email failures map without leaking raw details', async () => {
  const deps = baseDeps();
  deps.detachMembership = async () => { throw new Error('Actor center is not authorized for PTO membership 987654'); };
  deps.addEmail = async (input) => {
    if (input.email === 'provenance@example.com') {
      throw new Error('PTO email provenance membership is not active on this profile');
    }
    throw new Error('PTO email would be ambiguous in this center');
  };
  deps.decideAlias = async () => { throw new Error('PTO alias candidate 123456 does not exist'); };
  const base = await startApp(deps, { accountType: 'ADMIN', accountId: 900, franchiseId: 9 });
  const forbidden = await fetch(`${base}/api/pto/admin/profiles/10/memberships/20/detach`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}'
  });
  assert.equal(forbidden.status, 403);
  assert.deepEqual(await forbidden.json(), { error: 'Not authorized for this PTO profile', code: 'PTO_FORBIDDEN' });
  const conflict = await fetch(`${base}/api/pto/admin/profiles/10/emails`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ membershipId: 20, email: 'valid@example.com' })
  });
  assert.equal(conflict.status, 409);
  assert.deepEqual(await conflict.json(), { error: 'PTO email conflicts with another profile', code: 'PTO_EMAIL_AMBIGUOUS' });
  const provenance = await fetch(`${base}/api/pto/admin/profiles/10/emails`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ membershipId: 20, email: 'provenance@example.com' })
  });
  assert.equal(provenance.status, 422);
  assert.deepEqual(await provenance.json(), { error: 'PTO email provenance is invalid', code: 'PTO_EMAIL_PROVENANCE_INVALID' });
  const missing = await fetch(`${base}/api/pto/admin/aliases/12/decide`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ decision: 'confirm' })
  });
  assert.equal(missing.status, 404);
  assert.deepEqual(await missing.json(), { error: 'PTO record was not found', code: 'PTO_NOT_FOUND' });
});

test('a real PTO identity conflict maps safely and unknown failures are sanitized at the router boundary', async () => {
  const deps = baseDeps();
  deps.getTutorProfile = async () => {
    throw new Error('PTO roster membership belongs to a different canonical profile');
  };
  const base = await startApp(deps, { accountType: 'TUTOR', accountId: 123, franchiseId: 6 });
  const response = await fetch(`${base}/api/pto/me`);
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: 'PTO identity state conflicts with this request', code: 'PTO_IDENTITY_CONFLICT' });
  deps.getTutorProfile = async () => { throw new Error('sensitive repository row detail'); };
  const unknownBase = await startApp(deps, { accountType: 'TUTOR', accountId: 123, franchiseId: 6 });
  const unknown = await fetch(`${unknownBase}/api/pto/me`);
  assert.equal(unknown.status, 500);
  assert.deepEqual(await unknown.json(), { error: 'PTO operation failed', code: 'PTO_INTERNAL_ERROR' });
});
