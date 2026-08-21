import { sql } from '../../db/mssql';
import type { PtoRosterTutor, PtoTutorRosterSource } from './contracts';
import { createMssqlPtoDiscoverySource } from './discoverySource';

interface MssqlRosterRequest {
  input(name: string, type: unknown, value: unknown): unknown;
  query(text: string): Promise<{ recordset?: Record<string, unknown>[] }>;
}

interface MssqlRosterPool {
  request(): MssqlRosterRequest;
}

const nullableText = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};

export const createMssqlPtoRosterSource = (
  getPool: () => Promise<MssqlRosterPool>
): PtoTutorRosterSource => {
  const discoverySource = createMssqlPtoDiscoverySource(getPool);
  return {
    fetchTutors: async (franchiseId: number): Promise<PtoRosterTutor[]> => {
      const pool = await getPool();
      const request = pool.request();
      request.input('FranchiseId', sql.Int, franchiseId);
      const result = await request.query(`
        SELECT ID, FranchiseID, FirstName, LastName, Email, IsDeleted
        FROM dbo.tblTutors
        WHERE FranchiseID = @FranchiseId
      `);
      return (result.recordset ?? []).map((row) => ({
        id: Number(row.ID),
        franchiseId: Number(row.FranchiseID),
        firstName: nullableText(row.FirstName) ?? '',
        lastName: nullableText(row.LastName) ?? '',
        email: nullableText(row.Email)?.toLowerCase() ?? null,
        isDeleted: Boolean(row.IsDeleted)
      }));
    },
    discoverRelatedAccounts: discoverySource.discoverRelatedAccounts
  };
};
