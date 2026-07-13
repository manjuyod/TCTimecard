import { getMssqlPool, sql } from '../db/mssql';

export interface TutorDirectoryIdentity {
  tutorId: number;
  firstName: string;
  lastName: string;
  email: string;
}

export async function fetchTimeOffTutorsByIds(tutorIds: number[]): Promise<Map<number, TutorDirectoryIdentity>> {
  const unique = Array.from(new Set(tutorIds.filter((id) => Number.isInteger(id) && id > 0)));
  if (unique.length === 0) return new Map();
  const pool = await getMssqlPool();
  const request = pool.request();
  const params = unique.map((id, index) => {
    const name = `tutorId${index}`;
    request.input(name, sql.Int, id);
    return `@${name}`;
  });
  const result = await request.query(`
    SELECT ID, FirstName, LastName, Email
    FROM dbo.tblTutors
    WHERE ID IN (${params.join(', ')})
      AND IsDeleted = 0
  `);
  return mapTutorDirectoryRows(result.recordset ?? []);
}

export async function fetchTimeOffTutorById(tutorId: number): Promise<TutorDirectoryIdentity | null> {
  return (await fetchTimeOffTutorsByIds([tutorId])).get(tutorId) ?? null;
}

export function mapTutorDirectoryRows(rows: Array<Record<string, unknown>>): Map<number, TutorDirectoryIdentity> {
  const map = new Map<number, TutorDirectoryIdentity>();
  for (const row of rows) {
    const tutorId = Number(row.ID);
    if (!Number.isInteger(tutorId) || tutorId <= 0) continue;
    map.set(tutorId, {
      tutorId,
      firstName: row.FirstName === undefined || row.FirstName === null ? '' : String(row.FirstName),
      lastName: row.LastName === undefined || row.LastName === null ? '' : String(row.LastName),
      email: row.Email === undefined || row.Email === null ? '' : String(row.Email)
    });
  }
  return map;
}
