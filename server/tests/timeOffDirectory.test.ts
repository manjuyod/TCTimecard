import assert from 'node:assert/strict';
import test from 'node:test';
import { setMssqlPoolOverride } from '../db/mssql';
import { fetchTimeOffTutorsByIds, mapTutorDirectoryRows } from '../services/timeOffDirectory';

test('time-off tutor directory maps MSSQL identities', () => {
  const result = mapTutorDirectoryRows([
    { ID: 12, FirstName: 'Ada', LastName: 'Lovelace', Email: 'ada@example.com' }
  ]);
  assert.deepEqual(result.get(12), {
    tutorId: 12,
    firstName: 'Ada',
    lastName: 'Lovelace',
    email: 'ada@example.com'
  });
});

test('time-off tutor directory queries the authenticated tblTutors ID and returns Email', async () => {
  let queryText = '';
  const inputs: Array<{ name: string; value: number }> = [];
  const request = {
    input(name: string, _type: unknown, value: number) {
      inputs.push({ name, value });
      return request;
    },
    async query(sqlText: string) {
      queryText = sqlText;
      return {
        recordset: [
          { ID: 12, FirstName: 'Ada', LastName: 'Lovelace', Email: 'ada@example.com' }
        ]
      };
    }
  };
  setMssqlPoolOverride({ request: () => request } as never);

  try {
    const result = await fetchTimeOffTutorsByIds([12]);
    const normalizedSql = queryText.replace(/\s+/g, ' ').trim();
    assert.match(normalizedSql, /SELECT ID, FirstName, LastName, Email FROM dbo\.tblTutors/);
    assert.match(normalizedSql, /WHERE ID IN \(@tutorId0\) AND IsDeleted = 0/);
    assert.deepEqual(inputs, [{ name: 'tutorId0', value: 12 }]);
    assert.equal(result.get(12)?.email, 'ada@example.com');
  } finally {
    setMssqlPoolOverride(undefined);
  }
});
