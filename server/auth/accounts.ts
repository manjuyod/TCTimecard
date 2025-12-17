import { getMssqlPool, sql } from '../db/mssql';
import { comparePassword } from './password';
import { AccountType } from './types';

interface AccountMatch {
  accountType: AccountType;
  accountId: number;
  franchiseId: number | null;
  displayName: string | null;
  needsRehash: boolean;
}

const buildName = (first?: string | null, last?: string | null): string | null => {
  const parts = [first, last].filter(Boolean).map((part) => String(part).trim()).filter(Boolean);
  if (!parts.length) return null;
  return parts.join(' ');
};

const mapTutor = (rows: Array<any>, password: string): AccountMatch[] => {
  const matches: AccountMatch[] = [];

  for (const row of rows) {
    const storedPassword = row.Password !== undefined && row.Password !== null ? String(row.Password) : null;
    const comparison = comparePassword(password, { password: storedPassword });
    if (!comparison.valid) continue;

    matches.push({
      accountType: 'TUTOR',
      accountId: Number(row.ID),
      franchiseId: row.FranchiseID !== undefined && row.FranchiseID !== null ? Number(row.FranchiseID) : null,
      displayName: buildName(row.FirstName, row.LastName),
      needsRehash: comparison.needsRehash
    });
  }

  return matches;
};

const mapAdmin = (rows: Array<any>, password: string): AccountMatch[] => {
  const matches: AccountMatch[] = [];

  for (const row of rows) {
    const storedPassword = row.Password !== undefined && row.Password !== null ? String(row.Password) : null;
    const comparison = comparePassword(password, { password: storedPassword });
    if (!comparison.valid) continue;

    matches.push({
      accountType: 'ADMIN',
      accountId: Number(row.ID),
      franchiseId: row.FranchiseID !== undefined && row.FranchiseID !== null ? Number(row.FranchiseID) : null,
      displayName: row.User ? String(row.User).trim() || null : null,
      needsRehash: comparison.needsRehash
    });
  }

  return matches;
};

export const findMatchingAccounts = async (identifier: string, password: string): Promise<AccountMatch[]> => {
  const pool = await getMssqlPool();

  const tutorRequest = pool.request();
  tutorRequest.input('identifier', sql.VarChar(255), identifier);
  const tutorResult = await tutorRequest.query(`
    SELECT ID, Password, FirstName, LastName, FranchiseID
    FROM tblTutors
    WHERE Email = @identifier AND IsDeleted = 0
  `);

  const adminRequest = pool.request();
  adminRequest.input('identifier', sql.VarChar(255), identifier);
  const adminResult = await adminRequest.query(`
    SELECT tblUsers.ID, tblUsers.Password, tblUsers.UserName, tblFranchies.ID AS FranchiseID
    FROM tblUsers
    JOIN tblFranchies ON tblUsers.email = tblFranchies.FranchiesEmail
    WHERE tblUsers.UserName = @identifier
  `);

  const matches: AccountMatch[] = [];
  matches.push(...mapTutor(tutorResult.recordset, password));
  matches.push(...mapAdmin(adminResult.recordset, password));

  return matches;
};

export type { AccountMatch };
