import type { Pool, PoolClient } from 'pg';
import { getPostgresPool } from '../db/postgres';

type Queryable = Pick<Pool | PoolClient, 'query'>;

export interface FranchiseSettings {
  franchiseId: number;
  autoClockOutEnabled: boolean;
}

type FranchiseSettingsRow = {
  franchiseid: number;
  auto_clock_out_enabled: boolean;
};

const mapRow = (row: FranchiseSettingsRow): FranchiseSettings => ({
  franchiseId: Number(row.franchiseid),
  autoClockOutEnabled: row.auto_clock_out_enabled === true
});

export const getFranchiseSettings = async (
  franchiseId: number,
  db: Queryable = getPostgresPool()
): Promise<FranchiseSettings> => {
  const result = await db.query<FranchiseSettingsRow>(
    `SELECT franchiseid, auto_clock_out_enabled
       FROM public.franchise_payroll_settings
      WHERE franchiseid = $1
      LIMIT 1`,
    [franchiseId]
  );
  return result.rowCount
    ? mapRow(result.rows[0])
    : { franchiseId, autoClockOutEnabled: false };
};

export const updateFranchiseSettings = async (
  input: FranchiseSettings,
  db: Queryable = getPostgresPool()
): Promise<FranchiseSettings> => {
  const result = await db.query<FranchiseSettingsRow>(
    `INSERT INTO public.franchise_payroll_settings
       (franchiseid, auto_clock_out_enabled, updatedat)
     VALUES ($1, $2, NOW())
     ON CONFLICT (franchiseid) DO UPDATE
       SET auto_clock_out_enabled = EXCLUDED.auto_clock_out_enabled,
           updatedat = NOW()
     RETURNING franchiseid, auto_clock_out_enabled`,
    [input.franchiseId, input.autoClockOutEnabled]
  );
  return mapRow(result.rows[0]);
};
