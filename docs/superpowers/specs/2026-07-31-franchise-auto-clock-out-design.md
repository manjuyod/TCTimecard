# Franchise Auto Clock-Out Design

**Date:** 2026-07-31

## Overview

Add a franchise-wide automatic clock-out setting and a dedicated admin Settings page. When enabled, the server closes any tutor's open clock session at the end of that tutor's final scheduled block for the current work date. The server always uses the latest schedule from MSSQL, records the exact scheduled end time, and submits the completed day through the existing approval workflow.

The feature is opt-in. Existing and new franchises default to automatic clock-out being disabled.

## Goals

- Give administrators one left-navigation destination for franchise configuration.
- Move the existing payroll configuration from the admin dashboard to the new Settings page.
- Allow an administrator to enable or disable automatic clock-out for the selected franchise.
- Clock out eligible tutors even when their browser is closed.
- Use the latest MSSQL schedule and the final scheduled block for the day.
- Preserve exact scheduled timestamps even when the worker detects the end later.
- Reuse the existing time-entry comparison, approval, break, attestation, and audit behavior where applicable.
- Support at least 80 simultaneously clocked-in tutors without exhausting either ten-connection database pool.

## Non-Goals

- Clocking tutors out between split schedule blocks.
- Inferring a clock-out time when no valid schedule is available.
- Adding Windows Task Scheduler, SQL Server Agent, `pg_cron`, foreign-data wrappers, or a new schedule-replication subsystem.
- Adding per-tutor automatic clock-out overrides.
- Changing weekly attestation requirements or approval policy.
- Renaming the existing `franchise_payroll_settings` table.

## Product Decisions

- Automatic clock-out is a franchise-wide Boolean setting.
- The default is `false` for every franchise.
- For split schedules, the clock-out target is the latest valid interval end on the tutor's current work date.
- The latest MSSQL schedule at worker execution time is authoritative; a clock-in-time snapshot is not authoritative.
- Worker database activity occurs only during minutes `00` through `09` and `50` through `59` of each hour.
- A late detection is backdated to the exact scheduled end. For example, a 3:30 PM shift discovered at 3:50 PM is stored with a 3:30 PM end.
- Automatic clock-out submits the day exactly as manual clock-out does: matching time may auto-approve, while a mismatch becomes pending for admin review.
- Automatic clock-out is not blocked waiting for an interactive attestation. Existing attestation gates continue to apply to tutor actions and subsequent timekeeping workflows.

## Architecture

The implementation stays inside the existing Node/Express process on the always-running VM. A focused scheduler service plans only eligible minute ticks, acquires a PostgreSQL advisory lock, reads eligible open sessions, batch-loads their latest schedules from MSSQL, and delegates due sessions to a shared clock-out finalization service.

The scheduler does not call the app through HTTP. It uses the existing PostgreSQL and MSSQL pools directly. Manual and automatic clock-out share the same transactional finalization boundary so break closure, comparison, submission status, and audit behavior cannot drift.

The worker never holds a row transaction open while waiting for MSSQL. It first reads candidate identifiers, performs the external schedule lookup, and then opens a short PostgreSQL transaction for each due tutor. The transaction locks and revalidates the day and open session before mutating them.

## Persistence

Add an additive migration that introduces:

```sql
ALTER TABLE public.franchise_payroll_settings
  ADD COLUMN IF NOT EXISTS auto_clock_out_enabled BOOLEAN NOT NULL DEFAULT FALSE;
```

The existing table already stores other franchise configuration and is the lowest-risk location for the new flag. The default makes deployment safe before any administrator opts in.

Existing partial uniqueness on open sessions continues to enforce at most one open session per time-entry day. No separate job-state table is required because the advisory lock, row locks, conditional updates, and audit records provide idempotency.

## Admin API

Introduce admin-only franchise settings endpoints separate from the existing pay-period endpoints:

- `GET /api/admin/settings?franchiseId=<id>` returns `{ settings: { franchiseId, autoClockOutEnabled } }`.
- `PATCH /api/admin/settings` accepts `{ franchiseId, autoClockOutEnabled }` and returns the updated settings object.

Both endpoints use `requireAdmin` and `enforceFranchiseScope`. An administrator cannot read or mutate another franchise unless the existing session rules explicitly allow franchise selection. The patch accepts only a real Boolean; strings and omitted values are rejected with `400`.

The existing `/api/pay-period/settings` contract remains unchanged. The new Settings page composes the franchise-settings API with the existing payroll-settings API, avoiding a breaking change to payroll consumers.

## Admin User Experience

Add a `Settings` item with a gear icon to the admin sidebar and route it to `/admin/settings`.

The page follows the existing franchise selector rules. A fixed-franchise administrator sees only the session franchise. An account allowed to select franchises can enter or select a franchise using the existing pattern, and changing the franchise reloads both settings sections.

The page contains two cards:

1. **Automatic timekeeping**
   - An `Auto clock-out` switch.
   - Copy explaining that enabled tutors are clocked out at their final scheduled end time and that discrepancies still require approval.
   - An explicit save action with loading, success, and inline error states.
2. **Payroll**
   - The existing pay-period configuration currently rendered on the admin dashboard, with its current validation and save behavior unchanged.

The admin dashboard retains its metrics, approval links, and current pay-period summary but no longer owns the payroll settings form.

## Scheduler Cadence

The scheduler calculates the next eligible minute instead of querying a database every minute and discarding two-thirds of the results. Eligible minute values are:

```text
00 01 02 03 04 05 06 07 08 09
50 51 52 53 54 55 56 57 58 59
```

At startup, the service schedules the next eligible tick. After each run it schedules the following eligible tick. Shutdown cancels the timer before database pools close.

Each tick attempts a fixed PostgreSQL advisory lock. Failure to obtain the lock means another app instance is processing that tick, so the local run exits without work. The lock is always released in a `finally` path.

## Candidate and Schedule Lookup

The PostgreSQL candidate query returns only rows that meet all of these conditions:

- `auto_clock_out_enabled = true` for the day franchise.
- The time-entry day reports a clocked-in state.
- A session for that day still has `end_at IS NULL`.
- The work date is the franchise-local current date represented by the open day.

If no candidates exist, the tick ends without an MSSQL call.

For one or more candidates, a single parameterized MSSQL query joins a generated active-tutor value set to `tblSessionSchedule` and `tblTimes`. The value set includes franchise ID, tutor ID, and work date so tutor identifiers cannot collide across franchises. Eighty candidates require far fewer than SQL Server's parameter limit.

Results are grouped per candidate and converted through the existing schedule label normalization and interval derivation rules. The target time is the maximum valid interval end. A tutor is due only when that target is at or before the worker's captured current time.

## Transactional Clock-Out

Due tutors are processed with bounded concurrency of four. This leaves capacity in the configured ten-connection PostgreSQL pool for interactive app traffic. The single MSSQL schedule read uses one connection.

For each due tutor, the shared finalization service starts a PostgreSQL transaction and:

1. Locks and reloads the time-entry day and its open session.
2. Rechecks that automatic clock-out is still enabled for the franchise.
3. Exits idempotently if a manual or prior automatic clock-out already closed the session.
4. Rejects the automatic action if the scheduled end is not after the session start.
5. Closes any open break at the scheduled end when its start precedes that target. If an open break starts at or after the target, the complete automatic clock-out is skipped as invalid rather than leaving inconsistent break data.
6. Closes the open session at the scheduled end using a conditional `end_at IS NULL` update.
7. Sets the day clock state to clocked out.
8. Persists the latest server-built schedule snapshot.
9. Computes the time-entry comparison using the existing break-aware calculation.
10. Resolves auto-approval versus pending status through the existing clock-out submission policy.
11. Writes audit records identifying `auto_clock_out` as the source and including the scheduled target, detection time, and comparison decision.
12. Commits the transaction.

The service rolls back the complete tutor mutation on any failure. One tutor's failure does not abort other due tutors.

## Tutor Experience

No tutor interaction is required. The feature continues to work when the browser is closed, suspended, or disconnected.

To avoid constant client polling, the clock widget refreshes state when the document becomes visible or the window regains focus. When it loads a clocked-in state, it fetches the latest schedule once and schedules one state refresh for the first eligible worker minute after the final schedule end. If the tutor remains clocked in because the schedule was extended, the widget fetches the latest schedule again and schedules a replacement one-time refresh.

After an automatic clock-out, the next state load shows the tutor as clocked out and shows the resulting approved or pending day status. Existing weekly attestation UI and enforcement remain unchanged.

## Failure Handling

The worker makes no clock mutation in these cases:

- No valid schedule entries are returned.
- No valid final interval can be derived.
- The final scheduled end is not after the open session start.
- MSSQL is unavailable or its query times out.
- PostgreSQL is unavailable.
- The setting was disabled after candidate selection.
- The session was already closed by a tutor or another worker.

Transient failures are retried naturally at the next eligible scheduler tick. The worker does not invent timestamps, fall back to stale snapshots, or reopen completed sessions.

## Observability

Each scheduler run writes one structured summary containing:

- Run identifier and duration.
- Candidate count and due count.
- Successful automatic clock-outs.
- Idempotent skips.
- Missing- or invalid-schedule skips.
- Per-database failure counts.

Individual failures include franchise ID, tutor ID, work date, and a safe error category without credentials or raw database connection details. Audit metadata provides the permanent per-day record.

## Scale and Concurrency

Eighty clocked-in tutors produce one PostgreSQL candidate read and one batched MSSQL schedule read per eligible tick. Logged-in but clocked-out users add no scheduler work.

If all 80 tutors become due together, four-at-a-time PostgreSQL finalization creates 20 short waves while leaving six pool connections available for web requests. Stored end times remain exact even if processing the full burst takes several seconds. Conditional writes, row locks, and the advisory lock prevent duplicate completion during manual clock-out races, retries, or multiple app instances.

## Testing Strategy

### Unit tests

- Eligible cadence includes minutes `00`-`09` and `50`-`59` and excludes `10`-`49`.
- Next-run calculation crosses hour and day boundaries correctly.
- Split intervals select only the final valid end.
- Empty and malformed schedules yield a safe skip.
- A scheduled end at or before the open-session start yields a safe skip.
- Bounded concurrency never exceeds four finalizations.

### Server integration tests

- The migration and repository default disabled franchises to `false`.
- Admin settings reads and writes enforce authentication and franchise scope.
- Disabled franchises never become worker candidates.
- The batch schedule lookup covers 80 candidates in one MSSQL request.
- Latest schedule data, rather than a stored clock-in snapshot, determines the target.
- Detection after the target stores the exact target timestamp.
- Open breaks close at the target timestamp.
- Matching time auto-approves and mismatched time becomes pending.
- Missing schedules and database failures leave sessions open.
- Manual and automatic clock-out races result in one completion and no duplicate submission.
- Repeated worker runs are idempotent.
- Shutdown cancels future ticks before closing database pools.

### Client tests

- Admin navigation exposes Settings with the correct active state.
- The Settings route is admin-only.
- Franchise selection loads the correct automatic and payroll settings.
- The auto clock-out control loads, validates, saves, and reports errors.
- Payroll settings retain their existing validation after moving pages.
- The admin dashboard no longer renders the payroll form.
- The clock widget refreshes after focus or visibility restoration.

### Verification

- Run server and client unit/integration suites.
- Run type checks and production builds.
- Run an 80-tutor due-at-once burst test and verify pool usage, completion duration, exact timestamps, and interactive endpoint responsiveness.
- Review GitNexus change detection before every implementation commit.

## Rollout

Deploy the additive migration and application code with the setting disabled everywhere. Confirm scheduler startup and no-candidate logs, then enable one test franchise from the Settings page. Validate exact timestamping, approval outcomes, audit metadata, and retry behavior before enabling additional franchises.

Rollback consists of disabling the franchise flag or reverting the application. The additive column can remain safely in place.
