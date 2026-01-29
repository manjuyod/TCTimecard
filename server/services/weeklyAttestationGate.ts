import { DateTime } from 'luxon';
import { getPostgresPool } from '../db/postgres';
import { computeLastClosedWorkweek, computeSundayWeekStart } from './workweek';

export type WeeklyAttestationGateResult =
  | { ok: true }
  | { ok: false; weekEnd: string }
  | { ok: false; error: string };

export const enforcePriorWeekAttestation = async (params: {
  franchiseId: number;
  tutorId: number;
  timezone: string;
  workDate: string;
}): Promise<WeeklyAttestationGateResult> => {
  const workLocal = DateTime.fromISO(params.workDate, { zone: params.timezone, setZone: true }).startOf('day');
  if (!workLocal.isValid) {
    const message = `[attestation] Invalid workDate "${params.workDate}" for timezone "${params.timezone}".`;
    console.error(message);
    return { ok: false, error: message };
  }

  const nowLocal = DateTime.now().setZone(params.timezone);
  const currentWeekStart = computeSundayWeekStart(nowLocal);

  if (workLocal < currentWeekStart) return { ok: true };

  const required = computeLastClosedWorkweek(params.timezone);
  const requiredWeekEnd = required.weekEnd.toISODate();
  if (!requiredWeekEnd) {
    const message = `[attestation] Unable to resolve last closed workweek end for timezone "${params.timezone}".`;
    console.error(message);
    return { ok: false, error: message };
  }

  const pool = getPostgresPool();
  try {
    const result = await pool.query(
      `
        SELECT 1
        FROM public.weekly_attestations
        WHERE franchiseid = $1
          AND tutorid = $2
          AND week_end = $3
        LIMIT 1
      `,
      [params.franchiseId, params.tutorId, requiredWeekEnd]
    );

    if (result.rowCount && result.rowCount > 0) return { ok: true };
  } catch (err) {
    const message = `[attestation] Database error checking attestation: ${err instanceof Error ? err.message : err}`;
    console.error(message);
    return { ok: false, error: message };
  }

  return { ok: false, weekEnd: requiredWeekEnd };
};
