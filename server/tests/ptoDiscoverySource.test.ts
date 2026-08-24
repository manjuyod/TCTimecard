import assert from 'node:assert/strict';
import test from 'node:test';
import type { PtoRosterTutor } from '../services/pto/contracts';
import { createMssqlPtoDiscoverySource } from '../services/pto/discoverySource';

const tutor = (overrides: Partial<PtoRosterTutor> = {}): PtoRosterTutor => ({
  id: 100,
  franchiseId: 1,
  firstName: 'Ada',
  lastName: 'Lovelace',
  email: 'ada@one.example',
  isDeleted: false,
  ...overrides
});

test('discovery batches normalized names without reading passwords and excludes source or deleted rows', async () => {
  const inputs = new Map<string, unknown>();
  let queryText = '';
  let requestCount = 0;
  const source = createMssqlPtoDiscoverySource(async () => ({
    request: () => {
      requestCount += 1;
      return {
        input: (name: string, _type: unknown, value: unknown) => {
          inputs.set(name, value);
          return undefined;
        },
        query: async (text: string) => {
          queryText = text;
          return {
            recordset: [
              { ID: 100, FranchiseID: 1, FirstName: 'Ada', LastName: 'Lovelace', Email: 'ada@one.example', IsDeleted: 0 },
              { ID: 200, FranchiseID: 2, FirstName: ' ADA ', LastName: ' LOVELACE ', Email: 'ADA@TWO.EXAMPLE', IsDeleted: 0 },
              { ID: 200, FranchiseID: 2, FirstName: 'Ada', LastName: 'Lovelace', Email: 'ada@two.example', IsDeleted: 0 },
              { ID: 300, FranchiseID: 3, FirstName: 'Grace', LastName: 'Hopper', Email: 'grace@example.com', IsDeleted: 1 }
            ]
          };
        }
      };
    }
  } as never), () => '2026-08-19T20:00:00.000Z');

  const result = await source.discoverRelatedAccounts([
    tutor(),
    tutor({ id: 101, firstName: ' Grace ', lastName: 'Hopper', email: null })
  ]);

  assert.equal(requestCount, 1);
  assert.match(queryText, /JOIN\s*\(VALUES/i);
  assert.match(queryText, /LOWER\(LTRIM\(RTRIM\(candidate\.FirstName\)\)\)/i);
  assert.match(queryText, /LOWER\(LTRIM\(RTRIM\(candidate\.LastName\)\)\)/i);
  assert.match(queryText, /candidate\.IsDeleted\s*=\s*0/i);
  assert.doesNotMatch(queryText, /\bPassword\b/i);
  assert.deepEqual([...inputs.values()], ['ada', 'lovelace', 'grace', 'hopper']);
  assert.deepEqual(result, {
    accounts: [{
      id: 200,
      franchiseId: 2,
      firstName: 'ADA',
      lastName: 'LOVELACE',
      email: 'ada@two.example',
      isDeleted: false,
      provider: 'timecard-center:2',
      crmId: '200'
    }],
    attemptedAt: '2026-08-19T20:00:00.000Z',
    completedAt: '2026-08-19T20:00:00.000Z',
    error: null
  });
});

test('discovery skips incomplete names and does not open MSSQL for an empty batch', async () => {
  let poolCalls = 0;
  const source = createMssqlPtoDiscoverySource(async () => {
    poolCalls += 1;
    throw new Error('MSSQL should not be opened');
  }, () => '2026-08-19T20:00:00.000Z');

  const empty = await source.discoverRelatedAccounts([]);
  const incomplete = await source.discoverRelatedAccounts([
    tutor({ firstName: '' }),
    tutor({ id: 101, lastName: '   ' })
  ]);

  assert.equal(poolCalls, 0);
  assert.deepEqual(empty.accounts, []);
  assert.deepEqual(incomplete.accounts, []);
});

test('discovery caps each query at 500 unique names and deduplicates accounts across chunks', async () => {
  let requestCount = 0;
  const source = createMssqlPtoDiscoverySource(async () => ({
    request: () => {
      requestCount += 1;
      return {
        input: () => undefined,
        query: async () => ({
          recordset: [
            { ID: 900, FranchiseID: 9, FirstName: 'Remote', LastName: 'Tutor', Email: null, IsDeleted: 0 }
          ]
        })
      };
    }
  } as never), () => '2026-08-19T20:00:00.000Z');
  const tutors = Array.from({ length: 501 }, (_, index) => tutor({
    id: index + 1,
    firstName: `First${index}`,
    lastName: `Last${index}`
  }));

  const result = await source.discoverRelatedAccounts(tutors);

  assert.equal(requestCount, 2);
  assert.deepEqual(result.accounts.map(({ franchiseId, id }) => [franchiseId, id]), [[9, 900]]);
});
