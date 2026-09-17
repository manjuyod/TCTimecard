# Staging clock-out rounding: September 1–15, 2026

Use `server/scripts/backfillClockOutSnaps.sql` in the Neon SQL editor. Prepared and syntax-checked, **not executed**.

## Scope

- Franchises: **6, 11, 16, 60, 110, 57, 103**. Franchise **15 is excluded**.
- Entry `work_date`: **2026-09-01 through 2026-09-15 inclusive**.
- All statuses qualify if `submitted_at` exists or a `submitted`/`auto_approved` audit record exists.
- All closed sessions qualify, including manually entered, edited, and automatic clock-outs. No original-clock-out audit or current Time Snap setting is required.
- Open sessions are left alone. A proposed end at or before its start is left alone to satisfy the database constraint.

## Two updates in one transaction

1. Round `time_entry_sessions.end_at` to the nearest quarter-hour: minutes 0–7 within each quarter round down, 8–14 round up. Examples: 6:07 → 6:00, 6:08 → 6:15, 6:22 → 6:15, 6:23 → 6:30. Seconds are removed. Update the changed sessions' `updated_at`.
2. Rebuild `time_entry_days.comparison` for changed days using all their closed sessions, completed breaks, and stored schedule intervals. This refreshes paid minutes, schedule coverage/differences, and related comparison fields. Update those days' `updated_at`.

Statuses and approval details stay unchanged. Clock-ins, break records, schedules, and audit history are unchanged; this simplified staging script does not insert correction audit records.

The hours code calculates rollup totals from sessions, breaks, and schedules when queried (`server/routes/hours.ts`, `computeRollupTotalsForDays`). There is no additional hours-rollup table to update in that path. Existing exported files are not rewritten.

The temporary/session-local calculation functions reproduce the app's interval and break arithmetic, require PostgreSQL 14+, and install no public functions. If a changed day's sessions or schedule intervals cannot be calculated, an error prevents committing a partial correction.

## Run it yourself

1. Select the intended **staging** database in Neon.
2. Paste and run the **entire SQL file**. It starts with `BEGIN;`, performs both updates, shows before/after results, and ends with `ROLLBACK;`. This trial run performs updates inside the transaction and then discards them.
3. To persist the updates, change the final `ROLLBACK;` to `COMMIT;` and rerun the whole file. There are no preview tokens or apply flags.

Both updates commit together or neither does. After an SQL error, issue `ROLLBACK;` before retrying. Do not split the batch across separate SQL-editor runs: its temporary objects belong to the transaction/session.

Neon supports transactions; see [PostgreSQL transaction commands](https://www.postgresql.org/docs/current/tutorial-transactions.html) and [Neon's transaction support](https://neon.com/docs/serverless/serverless-driver).

## Verification and older alternative

The SQL statements and PL/pgSQL bodies were parsed without executing them. Database behavior has not been runtime-tested. No Neon or SMSS/MSSQL instance was accessed during preparation.

The earlier `backfillClockOutSnaps.ts` remains as a separate, more restrictive alternative, with franchise 15 also removed. Its audit/provenance restrictions and preview-token workflow do **not** apply to this simplified SQL version.
