import { sql } from '../../db/mssql';
import type {
  PtoDiscoveredRosterAccount,
  PtoDiscoveryResult,
  PtoRosterTutor
} from './contracts';

interface MssqlDiscoveryRequest {
  input(name: string, type: unknown, value: unknown): unknown;
  query(text: string): Promise<{ recordset?: Record<string, unknown>[] }>;
}

interface MssqlDiscoveryPool {
  request(): MssqlDiscoveryRequest;
}

interface NormalizedNamePair {
  firstName: string;
  lastName: string;
}

const MAX_NAMES_PER_QUERY = 500;

const nullableText = (value: unknown): string | null => {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  return text || null;
};

const normalizeName = (value: string): string => value.trim().toLowerCase();

const chunkNames = (names: NormalizedNamePair[]): NormalizedNamePair[][] => {
  const chunks: NormalizedNamePair[][] = [];
  for (let index = 0; index < names.length; index += MAX_NAMES_PER_QUERY) {
    chunks.push(names.slice(index, index + MAX_NAMES_PER_QUERY));
  }
  return chunks;
};

export const createMssqlPtoDiscoverySource = (
  getPool: () => Promise<MssqlDiscoveryPool>,
  now: () => string = () => new Date().toISOString()
) => ({
  discoverRelatedAccounts: async (tutors: PtoRosterTutor[]): Promise<PtoDiscoveryResult> => {
    const attemptedAt = now();
    const sourceAccountKeys = new Set(tutors.map((item) => `${item.franchiseId}:${item.id}`));
    const uniqueNames = new Map<string, NormalizedNamePair>();

    for (const item of tutors) {
      const firstName = normalizeName(item.firstName);
      const lastName = normalizeName(item.lastName);
      if (!firstName || !lastName) continue;
      uniqueNames.set(`${firstName}\u0000${lastName}`, { firstName, lastName });
    }

    if (!uniqueNames.size) {
      return { accounts: [], attemptedAt, completedAt: now(), error: null };
    }

    const pool = await getPool();
    const accounts = new Map<string, PtoDiscoveredRosterAccount>();

    for (const nameChunk of chunkNames([...uniqueNames.values()])) {
      const request = pool.request();
      const values = nameChunk.map((name, index) => {
        request.input(`first${index}`, sql.VarChar(255), name.firstName);
        request.input(`last${index}`, sql.VarChar(255), name.lastName);
        return `(@first${index}, @last${index})`;
      });
      const result = await request.query(`
        SELECT candidate.ID, candidate.FranchiseID, candidate.FirstName,
               candidate.LastName, candidate.Email, candidate.IsDeleted
        FROM dbo.tblTutors AS candidate
        JOIN (VALUES ${values.join(', ')}) AS incoming(first_name, last_name)
          ON LOWER(LTRIM(RTRIM(candidate.FirstName))) = incoming.first_name
         AND LOWER(LTRIM(RTRIM(candidate.LastName))) = incoming.last_name
        WHERE candidate.IsDeleted = 0
      `);

      for (const row of result.recordset ?? []) {
        const id = Number(row.ID);
        const franchiseId = Number(row.FranchiseID);
        if (!Number.isSafeInteger(id) || !Number.isSafeInteger(franchiseId) || Number(row.IsDeleted) !== 0) continue;
        const accountKey = `${franchiseId}:${id}`;
        if (sourceAccountKeys.has(accountKey) || accounts.has(accountKey)) continue;
        accounts.set(accountKey, {
          id,
          franchiseId,
          firstName: nullableText(row.FirstName) ?? '',
          lastName: nullableText(row.LastName) ?? '',
          email: nullableText(row.Email)?.toLowerCase() ?? null,
          isDeleted: false,
          provider: `timecard-center:${franchiseId}`,
          crmId: String(id)
        });
      }
    }

    return {
      accounts: [...accounts.values()].sort((left, right) =>
        left.franchiseId - right.franchiseId || left.id - right.id
      ),
      attemptedAt,
      completedAt: now(),
      error: null
    };
  }
});
