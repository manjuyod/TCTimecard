import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMssqlPtoRosterSource } from '../services/pto';

test('CRM roster query explicitly selects the required tutor columns and scopes by FranchiseID', async () => {
  let queryText = '';
  let input: unknown;
  const source = createMssqlPtoRosterSource(async () => ({
    request: () => ({
      input: (_name: string, _type: unknown, value: unknown) => {
        input = value;
        return undefined;
      },
      query: async (sqlText: string) => {
        queryText = sqlText;
        return {
          recordset: [{ ID: 1, FranchiseID: 77, FirstName: 'Ada', LastName: 'Lovelace', Email: 'ada@example.com', IsDeleted: 0 }]
        };
      }
    })
  } as never));

  const rows = await source.fetchTutors(77);

  assert.match(queryText, /SELECT\s+ID,\s*FranchiseID,\s*FirstName,\s*LastName,\s*Email,\s*IsDeleted\s+FROM dbo\.tblTutors\s+WHERE FranchiseID = @FranchiseId/is);
  assert.doesNotMatch(queryText, /SELECT\s+\*/i);
  assert.equal(input, 77);
  assert.deepEqual(rows, [{
    id: 1,
    franchiseId: 77,
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com',
    isDeleted: false
  }]);
});
