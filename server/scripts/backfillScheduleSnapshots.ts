import { getPostgresPool } from '../db/postgres';
import { getScheduleSnapshotSigningSecret, normalizeScheduleTimeLabel, parseScheduleSnapshotV1, signScheduleSnapshot, deriveIntervalsFromEntries, type ScheduleSnapshotEntry, type ScheduleSnapshotV1 } from '../services/scheduleSnapshot';

type TimeEntryDayRow = {
  id: number;
  franchiseid: number;
  tutorid: number;
  work_date: string;
  schedule_snapshot: unknown;
};

type BackfillArgs = {
  apply: boolean;
  franchiseId: number | null;
  startDate: string | null;
  endDate: string | null;
  limit: number | null;
};

const parseArgs = (argv: string[]): BackfillArgs => {
  const args: BackfillArgs = {
    apply: false,
    franchiseId: null,
    startDate: null,
    endDate: null,
    limit: null
  };

  for (const raw of argv) {
    if (raw === '--apply') {
      args.apply = true;
      continue;
    }

    if (raw.startsWith('--franchiseId=')) {
      const value = Number(raw.slice('--franchiseId='.length));
      if (!Number.isInteger(value)) throw new Error('--franchiseId must be an integer');
      args.franchiseId = value;
      continue;
    }

    if (raw.startsWith('--startDate=')) {
      const value = raw.slice('--startDate='.length);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('--startDate must be YYYY-MM-DD');
      args.startDate = value;
      continue;
    }

    if (raw.startsWith('--endDate=')) {
      const value = raw.slice('--endDate='.length);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('--endDate must be YYYY-MM-DD');
      args.endDate = value;
      continue;
    }

    if (raw.startsWith('--limit=')) {
      const value = Number(raw.slice('--limit='.length));
      if (!Number.isInteger(value) || value <= 0) throw new Error('--limit must be a positive integer');
      args.limit = value;
      continue;
    }

    throw new Error(`Unknown argument: ${raw}`);
  }

  return args;
};

const rebuildSnapshot = (snapshot: ScheduleSnapshotV1, signingSecret: string | null): { next: ScheduleSnapshotV1; changed: boolean } => {
  const normalizedEntries: ScheduleSnapshotEntry[] = snapshot.entries.map((entry) => ({
    timeId: entry.timeId,
    timeLabel: normalizeScheduleTimeLabel(entry.timeLabel)
  }));

  const intervals = deriveIntervalsFromEntries({
    workDate: snapshot.workDate,
    timezone: snapshot.timezone,
    slotMinutes: snapshot.slotMinutes,
    entries: normalizedEntries
  });

  const baseNext: ScheduleSnapshotV1 = {
    ...snapshot,
    entries: normalizedEntries,
    intervals
  };

  const next =
    signingSecret
      ? signScheduleSnapshot(baseNext, signingSecret)
      : { ...baseNext, signature: undefined };

  const changed =
    JSON.stringify(snapshot.entries) !== JSON.stringify(next.entries) ||
    JSON.stringify(snapshot.intervals) !== JSON.stringify(next.intervals) ||
    snapshot.signature !== next.signature;

  return { next, changed };
};

const main = async (): Promise<void> => {
  const args = parseArgs(process.argv.slice(2));
  const signingSecret = getScheduleSnapshotSigningSecret();
  const pool = getPostgresPool();

  const filters: string[] = [
    'schedule_snapshot IS NOT NULL',
    "jsonb_typeof(schedule_snapshot) = 'object'",
    "COALESCE(jsonb_array_length(schedule_snapshot->'entries'), 0) > 0",
    "COALESCE(jsonb_array_length(schedule_snapshot->'intervals'), 0) = 0"
  ];
  const params: unknown[] = [];

  if (args.franchiseId !== null) {
    params.push(args.franchiseId);
    filters.push(`franchiseid = $${params.length}`);
  }
  if (args.startDate !== null) {
    params.push(args.startDate);
    filters.push(`work_date >= $${params.length}`);
  }
  if (args.endDate !== null) {
    params.push(args.endDate);
    filters.push(`work_date <= $${params.length}`);
  }

  let limitClause = '';
  if (args.limit !== null) {
    params.push(args.limit);
    limitClause = `LIMIT $${params.length}`;
  }

  const result = await pool.query<TimeEntryDayRow>(
    `
      SELECT id, franchiseid, tutorid, work_date::text, schedule_snapshot
      FROM public.time_entry_days
      WHERE ${filters.join('\n        AND ')}
      ORDER BY work_date ASC, id ASC
      ${limitClause}
    `,
    params
  );

  let scanned = 0;
  let changed = 0;
  let updated = 0;
  let skipped = 0;
  let invalid = 0;

  for (const row of result.rows ?? []) {
    scanned += 1;
    const parsed = parseScheduleSnapshotV1(row.schedule_snapshot);
    if (!parsed) {
      invalid += 1;
      console.warn(`[backfill-schedule-snapshots] Skipping id=${row.id}: snapshot payload is invalid`);
      continue;
    }

    const rebuilt = rebuildSnapshot(parsed, signingSecret);
    if (!rebuilt.changed) {
      skipped += 1;
      continue;
    }

    changed += 1;

    if (!args.apply) {
      console.log(
        `[dry-run] id=${row.id} franchise=${row.franchiseid} tutor=${row.tutorid} workDate=${row.work_date} entries=${parsed.entries.length} intervals: ${parsed.intervals.length} -> ${rebuilt.next.intervals.length}`
      );
      continue;
    }

    await pool.query(
      `
        UPDATE public.time_entry_days
        SET schedule_snapshot = $1,
            updated_at = NOW()
        WHERE id = $2
      `,
      [rebuilt.next, row.id]
    );
    updated += 1;
    console.log(
      `[updated] id=${row.id} franchise=${row.franchiseid} tutor=${row.tutorid} workDate=${row.work_date} intervals: ${parsed.intervals.length} -> ${rebuilt.next.intervals.length}`
    );
  }

  console.log(
    `[backfill-schedule-snapshots] scanned=${scanned} changed=${changed} updated=${updated} skipped=${skipped} invalid=${invalid} mode=${args.apply ? 'apply' : 'dry-run'}`
  );
};

main()
  .catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[backfill-schedule-snapshots] Failed:', message);
    process.exitCode = 1;
  })
  .finally(async () => {
    try {
      await getPostgresPool().end();
    } catch {
      // ignore
    }
  });
