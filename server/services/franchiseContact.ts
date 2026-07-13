import { getMssqlPool, sql } from '../db/mssql';

export interface FranchiseContact {
  id: number;
  name: string;
  email: string | null;
  gmailId: string | null;
}

let franchiseNameColumn: string | null | undefined;

const detectFranchiseNameColumn = async (): Promise<string | null> => {
  if (franchiseNameColumn !== undefined) return franchiseNameColumn;

  const pool = await getMssqlPool();
  const result = await pool.request().query(`
    SELECT TOP 1 COLUMN_NAME
    FROM INFORMATION_SCHEMA.COLUMNS
    WHERE TABLE_NAME = 'tblFranchies' AND COLUMN_NAME IN ('Franchise', 'FranchiesName', 'FranchiseName', 'CenterName')
  `);

  const column = result.recordset?.[0]?.COLUMN_NAME;
  franchiseNameColumn = column ? String(column) : null;
  return franchiseNameColumn;
};

export const fetchFranchiseContact = async (franchiseId: number): Promise<FranchiseContact | null> => {
  const nameColumn = await detectFranchiseNameColumn();
  const pool = await getMssqlPool();
  const request = pool.request();
  request.input('franchiseId', sql.Int, franchiseId);

  const selectName = nameColumn ? `, [${nameColumn}] AS FranchiseName` : '';
  const query = `
    SELECT ID, FranchiesEmail, GmailID${selectName}
    FROM dbo.tblFranchies
    WHERE ID = @franchiseId
  `;

  const result = await request.query(query);
  if (!result.recordset?.length) return null;

  return mapFranchiseContactRow(franchiseId, result.recordset[0] as Record<string, unknown>);
};

export const mapFranchiseContactRow = (franchiseId: number, row: Record<string, unknown>): FranchiseContact => {
  const nameRaw = (row as Record<string, unknown>).FranchiseName;
  const name =
    typeof nameRaw === 'string' && nameRaw.trim() ? nameRaw.trim() : `Franchise ${franchiseId.toString()}`;
  const emailRaw = row.FranchiesEmail;
  const gmailIdRaw = row.GmailID;

  return {
    id: franchiseId,
    name,
    email: emailRaw !== undefined && emailRaw !== null && String(emailRaw).trim() ? String(emailRaw).trim() : null,
    gmailId:
      gmailIdRaw !== undefined && gmailIdRaw !== null && String(gmailIdRaw).trim() ? String(gmailIdRaw).trim() : null
  };
};
