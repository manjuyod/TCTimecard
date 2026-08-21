import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createPtoService,
  normalizeManualPtoEmail,
  type PtoServiceStore,
  type PtoTutorRosterSource
} from '../services/pto';

const policy = {
  id: '1',
  effectiveFrom: '1970-01-01',
  entitlementDays: 5,
  renewalMonth: 1,
  renewalDay: 1,
  carryoverDays: 0
};

const centerStatus = {
  franchiseId: 77,
  enabled: false,
  firstActivatedAt: null,
  lastSuccessfulSyncAt: null,
  lastSyncError: null
};

const unsupported = async (): Promise<never> => {
  throw new Error('unexpected store call');
};

const createStore = (overrides: Partial<PtoServiceStore> = {}): PtoServiceStore => {
  const store: PtoServiceStore = {
    getProgramPolicy: async () => policy,
    getCenterStatus: async () => centerStatus,
    previewActivation: unsupported,
    syncRoster: unsupported,
    getTutorProfile: unsupported,
    listAdminProfiles: unsupported,
    getAdminProfile: unsupported,
    decideAlias: unsupported,
    detachMembership: unsupported,
    addEmail: unsupported,
    removeEmail: unsupported,
    adjustBalance: unsupported,
    listAudit: unsupported,
    runInTransaction: async (work) => work(store),
    ...overrides
  };
  return store;
};

const roster = (fetchTutors: PtoTutorRosterSource['fetchTutors']): PtoTutorRosterSource => ({
  fetchTutors,
  discoverRelatedAccounts: async () => ({
    accounts: [],
    attemptedAt: '1970-01-01T00:00:00.000Z',
    completedAt: '1970-01-01T00:00:00.000Z',
    error: null
  })
});

test('activation preview reads a fresh active CRM roster without opening a write transaction', async () => {
  let transactions = 0;
  let previewTutors: unknown[] = [];
  const store = createStore({
    runInTransaction: async () => {
      transactions += 1;
      throw new Error('preview must not transact');
    },
    previewActivation: async (_franchiseId, tutors) => {
      previewTutors = tutors;
      return {
        activeCrmTutorCount: tutors.length,
        newMembershipCount: 1,
        newProfileCount: 1,
        pendingExactNameCandidateCount: 2,
        warnings: []
      };
    }
  });
  const service = createPtoService({
    store,
    rosterSource: roster(async () => [
      { id: 10, franchiseId: 77, firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', isDeleted: false },
      { id: 11, franchiseId: 77, firstName: 'Gone', lastName: 'Tutor', email: null, isDeleted: true }
    ])
  });

  const result = await service.previewPtoActivation(77);

  assert.equal(transactions, 0);
  assert.equal(previewTutors.length, 1);
  assert.equal(result.activeCrmTutorCount, 1);
  assert.equal(result.policy.entitlementDays, 5);
});

test('sync refetches CRM before a single transaction and performs no store writes when CRM fails', async () => {
  let transactions = 0;
  const service = createPtoService({
    store: createStore({
      runInTransaction: async () => {
        transactions += 1;
        throw new Error('must not be reached');
      }
    }),
    rosterSource: roster(async () => {
      throw new Error('crm unavailable');
    })
  });

  await assert.rejects(
    service.syncPtoRoster({ franchiseId: 77, activate: true, actorId: 'admin-1' }),
    /crm unavailable/
  );
  assert.equal(transactions, 0);
});

test('sync reconciles active and deleted CRM rows transactionally and returns the successful timestamp', async () => {
  const calls: string[] = [];
  const syncedAt = '2026-08-16T12:00:00.000Z';
  const transactional = createStore({
    syncRoster: async (input) => {
      calls.push(`sync:${input.tutors.length}:${input.activate}`);
      return {
        activeTutorCount: 1,
        activatedMembershipCount: 1,
        deactivatedMembershipCount: 1,
        createdProfileCount: 1,
        pendingCandidateCount: 0,
        lastSuccessfulSyncAt: syncedAt
      };
    }
  });
  const store = createStore({
    runInTransaction: async (work) => {
      calls.push('begin');
      const result = await work(transactional);
      calls.push('commit');
      return result;
    }
  });
  const service = createPtoService({
    store,
    rosterSource: roster(async () => {
      calls.push('crm');
      return [
        { id: 1, franchiseId: 77, firstName: 'Active', lastName: 'Tutor', email: ' ACTIVE@example.com ', isDeleted: false },
        { id: 2, franchiseId: 77, firstName: 'Deleted', lastName: 'Tutor', email: null, isDeleted: true }
      ];
    })
  });

  const result = await service.syncPtoRoster({ franchiseId: 77, activate: true, actorId: 'admin-1' });

  assert.deepEqual(calls, ['crm', 'begin', 'sync:2:true', 'commit']);
  assert.equal(result.lastSuccessfulSyncAt, syncedAt);
});

test('manual email normalization trims, lowercases, and rejects malformed values', () => {
  assert.equal(normalizeManualPtoEmail(' Tutor.Name+pto@Example.COM '), 'tutor.name+pto@example.com');
  assert.throws(() => normalizeManualPtoEmail('not-an-email'), /valid email/i);
  assert.throws(() => normalizeManualPtoEmail('a@b'), /valid email/i);
});

test('manual email mutation passes normalized provenance and linked-admin scope to the store', async () => {
  let captured: unknown;
  const service = createPtoService({
    store: createStore({
      addEmail: async (input) => {
        captured = input;
        return { id: '9', email: input.email, active: true, source: 'manual', sourceMembershipId: input.membershipId };
      }
    }),
    rosterSource: roster(async () => [])
  });

  const result = await service.addPtoEmail({
    profileId: '4',
    membershipId: '8',
    email: ' NEW@Example.com ',
    actorId: 'admin-1',
    actorFranchiseId: 77
  });

  assert.deepEqual(captured, {
    profileId: '4',
    membershipId: '8',
    email: 'new@example.com',
    actorId: 'admin-1',
    actorFranchiseId: 77
  });
  assert.equal(result.email, 'new@example.com');
});

test('balance adjustments require a reason and nonzero half-day increments before touching storage', async () => {
  let writes = 0;
  const service = createPtoService({
    store: createStore({
      adjustBalance: async () => {
        writes += 1;
        return { ledgerEntryId: '1', availableDays: 4.5 };
      }
    }),
    rosterSource: roster(async () => [])
  });
  const base = {
    profileId: '4', cycleStart: '2026-01-01', reason: 'Correction', actorId: 'admin-1', actorFranchiseId: 77
  };

  await assert.rejects(service.adjustPtoBalance({ ...base, deltaDays: 0 }), /nonzero/i);
  await assert.rejects(service.adjustPtoBalance({ ...base, deltaDays: 0.25 }), /0.5/i);
  await assert.rejects(service.adjustPtoBalance({ ...base, deltaDays: 0.5, reason: ' ' }), /reason/i);
  assert.equal(writes, 0);
  await service.adjustPtoBalance({ ...base, deltaDays: -0.5 });
  assert.equal(writes, 1);
});

test('admin roster pagination is server-side and bounded to 100 rows', async () => {
  let captured: unknown;
  const service = createPtoService({
    store: createStore({
      listAdminProfiles: async (input) => {
        captured = input;
        return { items: [], page: input.page, pageSize: input.pageSize, total: 0 };
      }
    }),
    rosterSource: roster(async () => [])
  });

  await service.listAdminPtoProfiles({ franchiseId: 77, search: ' ada ', page: -2, pageSize: 5000 });
  assert.deepEqual(captured, { franchiseId: 77, search: 'ada', page: 1, pageSize: 100 });
});

test('alias decisions return the stored outcome instead of echoing a contradictory request', async () => {
  const service = createPtoService({
    store: createStore({
      decideAlias: async (input) => ({ profileId: '4', decision: input.decision === 'confirm' ? 'reject' : input.decision })
    }),
    rosterSource: roster(async () => [])
  });

  const result = await service.decidePtoAlias({
    candidateId: '9', decision: 'confirm', actorId: 'admin-1', actorFranchiseId: 77
  });

  assert.deepEqual(result, { profileId: '4', decision: 'reject' });
});
