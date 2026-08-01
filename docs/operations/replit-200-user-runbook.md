# Replit 200-User Launch Runbook

## Agent/database safety

Only a human operator may apply SQL or launch authenticated tests. Login creates PostgreSQL session rows, so even the read-route workload is database-mutating at the session layer.

## Manual migration gate

1. Review `server/db/migrations/0006_postgres_sessions.sql`.
2. Apply that checked-in file in an approved non-production PostgreSQL environment using the organization's normal database console.
3. Verify the table and index with these read-only queries:

```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'user_sessions'
ORDER BY ordinal_position;

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'user_sessions'
ORDER BY indexname;
```

Expected columns: `sid` varchar non-null, `sess` json non-null, `expire` timestamp non-null. Expected indexes: primary key on `sid` and `user_sessions_expire_idx` on `expire`.

4. Manually test login, `/api/auth/me`, rolling activity, logout, and a process restart in non-production.
5. Confirm the session survives restart, activity extends expiration, and logout deletes the session.
6. Record approval before applying the identical checked-in migration to production.

### Automatic clock-out migration

1. Review the additive `server/db/migrations/0007_franchise_auto_clock_out.sql` and apply it through the same approved migration process.
2. Confirm through `/admin/settings` that every franchise remains disabled after migration and deployment. The new `auto_clock_out_enabled` column defaults to `false`; do not enable it as part of migration.
3. Use `GET /api/admin/settings?franchiseId=...` and `PATCH /api/admin/settings` only through an authenticated admin session or the Settings UI. Do not put session cookies, database URLs, or credentials in the runbook or deployment logs.

## Replit publishing

1. In Publishing, select Reserved VM and Web server.
2. Select 2 vCPU / 8 GB RAM.
3. Build command: `npm run build`.
4. Run command: `npm start`.
5. Set `POSTGRES_POOL_MAX=10` and `MSSQL_POOL_MAX=10` plus all existing required production secrets.
6. Publish only after the production session migration is approved and applied.

## Manual smoke test

1. `GET /api/health` returns 200 without database status.
2. `GET /api/ready` returns 200 with both dependencies `ok`.
3. Tutor login, `/api/auth/me`, dashboard totals, and clock state load normally.
4. Admin login, dashboard, approvals, pay-period summary, one XLSX export, and one attestation export work normally.
5. Replit logs contain no session-store, pool-timeout, or unhandled error.

## Automatic clock-out canary

The worker checks only UTC minutes `00`-`09` and `50`-`59`. A pass holds one PostgreSQL advisory-lock connection, uses no more than four PostgreSQL connections total, and fetches the latest schedules for all candidates in one MSSQL batch. Missing or malformed schedules are safely counted and skipped.

1. Deploy migration `0007_franchise_auto_clock_out.sql` and the application with all franchise flags left off. Confirm a structured `[auto-clock-out] pass summary` shows zero candidates or only already-enabled canaries; no database credentials are needed to read this Replit log event.
2. Choose one test franchise. In `/admin/settings`, enable automatic clock-out only for that franchise and leave every other franchise off.
3. Clock in a controlled test tutor whose latest MSSQL schedule has two blocks with a gap, for example `3:00-5:00 PM` and `6:00-8:00 PM`. Keep the session open through the first worker pass after `5:00 PM` and confirm the tutor remains clocked in during the gap.
4. After the first eligible worker pass following `8:00 PM`, focus or reopen the tutor dashboard. Confirm it shows clocked out and the session ends at exactly `8:00 PM`, not at the worker's later detection time.
5. In the admin review UI, confirm the resulting status is `approved` when coverage matches or `pending` when it does not, and inspect the displayed latest audit action. Pair that UI record with the single structured run summary (`runId`, `candidates`, `due`, `succeeded`, `alreadyClosed`, `failed`, `skipped`, `durationMs`, and `lockAcquired`) to confirm automatic processing without direct database access.
6. If the tutor has a valid active break, automatic completion ends it at the same exact final schedule timestamp. Manual clock-out behavior is unchanged and still requires ending an active break first. Automatic completion does not create or waive a weekly attestation; the existing attestation gate still applies to later interactive actions.
7. Disable the test franchise flag in `/admin/settings` immediately after the canary. On the next eligible pass, confirm candidates from that franchise are absent or counted under `skipped.settingDisabled` if the flag changed after candidate selection.

### Automatic clock-out rollback

Disable `autoClockOutEnabled` for the canary franchise first; this is the immediate rollback and requires no database credential. Preserve migration `0007` because it is additive. If application rollback is also required, republish the last known-good snapshot, then inspect one subsequent structured pass summary for `failed: 0` and no new canary success. Do not drop the column or expose credentials while collecting rollback evidence.

## Manual credential preflight

The credential checker logs in and immediately logs out, which creates and deletes PostgreSQL session rows. Only a human operator may run it. Agents may inspect its secret-free result but must not launch it.

For the 20-user stage, validate exactly the credentials the harness will select:

```powershell
$env:LOAD_TEST_BASE_URL='https://timecard.tutoringclub.com'
$env:LOAD_TEST_CREDENTIALS_FILE=(Resolve-Path 'load-tests/credentials.json').Path
$env:CREDENTIAL_CHECK_TUTOR_INDICES='0-17'
$env:CREDENTIAL_CHECK_ADMIN_INDICES='0-2,18-19'
$env:CREDENTIAL_CHECK_MAX_CONSECUTIVE_FAILURES='4'
$env:CREDENTIAL_CHECK_RESULTS_FILE='credential-check-results-20.json'
npm run credentials:check
```

Do not begin the load stage unless every selected credential is valid and the checker exits zero. If the checker reports failures, remove only the reported role/index entries, recalculate the stage selectors, and rerun the preflight after the login cooldown has cleared.

## Human-operated load stages

Create an ignored credentials file from `load-tests/credentials.example.json`. Use controlled accounts. Leave `LOAD_TEST_ENABLE_WRITES=false` until dedicated write fixtures are approved.

Run 20 users for 5 minutes, then 100 users for 10 minutes, then 200 users for 15 minutes. For each stage set `LOAD_TEST_USERS`, `LOAD_TEST_DURATION_SECONDS`, and a unique `LOAD_TEST_RESULTS_FILE`, then run `npm run load:test` manually.

The 200-user stage must use `LOAD_TEST_TUTOR_PERCENT=90` and `LOAD_TEST_EXPORT_CONCURRENCY=3`.

Example PowerShell configuration for the 20-user stage:

```powershell
$env:LOAD_TEST_BASE_URL='https://timecard.tutoringclub.com'
$env:LOAD_TEST_CREDENTIALS_FILE=(Resolve-Path 'load-tests/credentials.json').Path
$env:LOAD_TEST_USERS='20'
$env:LOAD_TEST_DURATION_SECONDS='300'
$env:LOAD_TEST_RAMP_SECONDS='30'
$env:LOAD_TEST_TUTOR_PERCENT='90'
$env:LOAD_TEST_EXPORT_CONCURRENCY='3'
$env:LOAD_TEST_RESULTS_FILE='load-test-results-20.json'
$env:LOAD_TEST_ENABLE_WRITES='false'
npm run load:test
```

Repeat with `100` users / `600` seconds, then `200` users / `900` seconds. Keep the result files for review. The result's `byLabel.tutor:clock-state` metrics allow clock latency to be compared against the export wave.

## Acceptance

- Unexpected error rate below 1%.
- Non-export p95 below 1500 ms.
- Non-export p99 below 3000 ms.
- Zero 401/403 responses after successful login.
- No pool-acquisition timeout or process restart.
- CPU and memory recover after the export wave.
- Three exports finish without material clock-route degradation.

## Failure response

Stop before the next stage if a threshold fails. Save the JSON result, Replit request-duration view, CPU/memory screenshots, and relevant logs. Prefer measured query optimization, lowering export concurrency, or increasing VM size. Do not increase database pool sizes as the first response.

If database connection errors increase or latency worsens after the pool change, restore both deployment variables to `5` and redeploy before further testing.

## Rollback

Republish the last known-good application snapshot. Keep the additive `user_sessions` table in place; do not drop it during an application rollback. Restore the prior app only after confirming its session behavior is acceptable for a single Reserved VM.
