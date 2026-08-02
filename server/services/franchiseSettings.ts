import type { Pool, PoolClient } from 'pg';
import { getPostgresPool } from '../db/postgres';

type Queryable = Pick<Pool | PoolClient, 'query'>;

export interface FranchiseSettings {
  franchiseId: number;
  autoClockOutEnabled: boolean;
  clockInTimeSnapEnabled: boolean;
}

export interface FranchiseSettingsPatch {
  franchiseId: number;
  autoClockOutEnabled?: boolean;
  clockInTimeSnapEnabled?: boolean;
}

type FranchiseSettingsRow = {
  franchiseid: number;
  auto_clock_out_enabled: boolean;
  clock_in_time_snap_enabled: boolean;
};

const mapRow = (row: FranchiseSettingsRow): FranchiseSettings => ({
  franchiseId: Number(row.franchiseid),
  autoClockOutEnabled: row.auto_clock_out_enabled === true,
  clockInTimeSnapEnabled: row.clock_in_time_snap_enabled === true
});

export const getFranchiseSettings = async (
  franchiseId: number,
  db: Queryable = getPostgresPool()
): Promise<FranchiseSettings> => {
  const result = await db.query<FranchiseSettingsRow>(
    `SELECT franchiseid, auto_clock_out_enabled, clock_in_time_snap_enabled
       FROM public.franchise_payroll_settings
      WHERE franchiseid = $1
      LIMIT 1`,
    [franchiseId]
  );
  return result.rowCount
    ? mapRow(result.rows[0])
    : { franchiseId, autoClockOutEnabled: false, clockInTimeSnapEnabled: false };
};

export const updateFranchiseSettings = async (
  input: FranchiseSettingsPatch,
  db: Queryable = getPostgresPool()
): Promise<FranchiseSettings> => {
  const result = await db.query<FranchiseSettingsRow>(
    `INSERT INTO public.franchise_payroll_settings
       (franchiseid, auto_clock_out_enabled, clock_in_time_snap_enabled, updatedat)
     VALUES ($1, COALESCE($2, FALSE), COALESCE($3, FALSE), NOW())
     ON CONFLICT (franchiseid) DO UPDATE
       SET auto_clock_out_enabled = COALESCE($2, franchise_payroll_settings.auto_clock_out_enabled),
           clock_in_time_snap_enabled = COALESCE($3, franchise_payroll_settings.clock_in_time_snap_enabled),
           updatedat = NOW()
     RETURNING franchiseid, auto_clock_out_enabled, clock_in_time_snap_enabled`,
    [
      input.franchiseId,
      input.autoClockOutEnabled ?? null,
      input.clockInTimeSnapEnabled ?? null
    ]
  );
  return mapRow(result.rows[0]);
};
