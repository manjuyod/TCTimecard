# Time Card App

A Vite + React (TypeScript) client and an Express (TypeScript) API for tutoring franchises to track manually entered tutoring hours, enforce approvals on any variance from the scheduled blocks, collect weekly attestations, request time off, and process approvals. UI is Tailwind + shadcn/ui with FullCalendar, and legacy branding tokens are applied globally.

## What's included
- Tutor: dashboard hour totals (week / pay period / month), clock in/out (server-time minute precision) + status widget, calendar view (schedule + time off overlay), manual entry of arrival/departure (supporting break splits) with automatic approval requests on any mismatch to scheduled hours, weekly attestation (hard-blocking next-week entry until signed), submit/cancel time off.
- Admin: approvals inbox (hour variance requests + time off), current pay period display, pay period summary table (copy/export CSV) driven by approved manual entries.
- Auth: MSSQL-backed login with optional multi-account selection; cookie sessions (rolling 15 minutes).
- Data: tutoring schedule + tutor/franchise identity from MSSQL; requests + payroll config from Postgres.

## Structure
- `client/` - Vite React app (TSX) with React Router, Tailwind, shadcn/ui, FullCalendar.
- `server/` - Express API in TypeScript, built with `tsc -p server/tsconfig.json` into `server/dist`; serves the built client in production.
- `LegacyFormForStyle/` - legacy assets used to derive branding tokens.

## Scripts
- `npm run dev` - run client (Vite) and server (Express via `tsx watch`) concurrently for local/Replit development.
- `npm run build` - build the client into `client/dist` and the server into `server/dist`.
- `npm run build:client` / `npm run build:server` - build either side individually.
- `npm run typecheck` - typecheck server + client (no emit).
- `npm run lint` - currently aliases `typecheck`.
- `npm test` - runs server unit tests (`node --test` via `tsx` loader).
- `npm start` - serve the built client and API from Express using the compiled `server/dist`.

## Local dev
1. Install deps:
   - Root: `npm install`
   - Client: `npm install --prefix client`
2. Copy `.env.example` to `.env` and fill in MSSQL + Postgres credentials (the server validates DB env on startup and exits on missing/invalid values).
3. Run: `npm run dev`
4. Open: `http://localhost:5173` (Vite) and `http://localhost:3000/api/health` (API health)

## App routes
Public:
- `/login`, `/select-account`, `/timeout`

Tutor:
- `/tutor/dashboard`, `/tutor/calendar`, `/tutor/time-off` (manual time entry and variance requests live in the dashboard/calendar; the old extra-hours page is removed)

Admin:
- `/admin/dashboard`, `/admin/approvals`, `/admin/pay-period-summary`

## API routes (high level)
Health:
- `GET /api/health`

Auth:
- `POST /api/auth/login`
- `POST /api/auth/select-account`
- `GET /api/auth/me`
- `POST /api/auth/logout`

Pay periods:
- `GET /api/pay-period/current`
- `GET /api/pay-period`

Tutor hours + calendar:
- `GET /api/hours/me/weekly`
- `GET /api/hours/me/pay-period`
- `GET /api/hours/me/monthly?month=YYYY-MM`
- `GET /api/calendar/me/month?month=YYYY-MM`
- `GET /api/calendar/me/day/:workDate/snapshot`

Clock in/out:
- `GET /api/clock/me/state`
- `POST /api/clock/me/in`
- `POST /api/clock/me/out` (body: `{ finalize?: boolean, scheduleSnapshot?: ScheduleSnapshotV1 }`)

Manual time entry + approvals:
- `PUT /api/time-entry/me/day/:workDate` (save sessions draft; multiple sessions per day allowed)
- `GET /api/time-entry/me?start=YYYY-MM-DD&end=YYYY-MM-DD`
- `POST /api/time-entry/me/day/:workDate/submit` (requires `scheduleSnapshot` from the calendar API (month/day snapshot endpoints); zero-tolerance match auto-approves, otherwise pending)
- `GET /api/time-entry/admin/pending?franchiseId=...&limit=...`
- `POST /api/time-entry/admin/day/:id/decide` (body: `decision=approve|deny`, `reason` required for `deny`, min 5 chars)
- `PUT /api/time-entry/admin/day/:id` (admin fixes time errors; requires `reason` (min 5 chars); resets to pending)

Weekly attestation:
- `GET /api/attestation/me/status` (last closed workweek)
- `GET /api/attestation/me/reminder` (blocking flag + missing `weekEnd`)
- `POST /api/attestation/me/sign` (body: `typedName`)

Time off:
- `POST /api/timeoff`
- `GET /api/timeoff/me?limit=...`
- `POST /api/timeoff/:id/cancel`
- `GET /api/timeoff/admin/pending?franchiseId=...&limit=...`
- `POST /api/timeoff/:id/decide`

## Environment variables
Use `.env` locally or Replit Secrets. `.env.example` includes a full template.

Server + sessions
- `PORT` - Express port (default `3000`).
- `CLIENT_ORIGIN` - allowed origin for dev CORS (default `http://localhost:5173`).
- `APP_ORIGIN` - used to build deep links in email drafts (defaults to `CLIENT_ORIGIN`). In dev, set to `http://localhost:5173`; in production, set to your deployed origin (often `http://localhost:3000`).
- `SESSION_SECRET` - session signing secret (required for production).

Postgres (required)
- `POSTGRES_URL` (preferred) or `DATABASE_URL` - full connection string.
- `POSTGRES_SSL` (default `true`)
- `POSTGRES_SSL_REJECT_UNAUTHORIZED` (default `false` for hosted providers like Neon)
- `POSTGRES_POOL_MAX` (default `10`)
- `POSTGRES_POOL_IDLE` (default `30000` ms)
- `POSTGRES_CONNECTION_TIMEOUT` (default `10000` ms)

MSSQL (required)
- `MSSQL_SERVER`, `MSSQL_PORT` (default `1433`), `MSSQL_DATABASE`, `MSSQL_USER`, `MSSQL_PASSWORD`
- `MSSQL_ENCRYPT` (default `true`)
- `MSSQL_TRUST_SERVER_CERTIFICATE` (default `false`)
- `MSSQL_POOL_MAX` (default `10`), `MSSQL_POOL_MIN` (default `0`), `MSSQL_POOL_IDLE` (default `30000` ms)
- `MSSQL_CONNECTION_TIMEOUT` (default `15000` ms), `MSSQL_REQUEST_TIMEOUT` (default `30000` ms)

Payroll / pay period resolution
- `BIWEEKLY_ANCHOR_DATE` (optional, default `2024-01-01`) - anchor date for computed biweekly periods.

Manual entry + approvals
- `SCHEDULE_SNAPSHOT_SIGNING_SECRET` (optional) - when set, calendar responses include signed schedule snapshots and manual entry submission requires a valid signature.
- `SCHEDULE_SLOT_MINUTES` (optional, default `60`) - minutes per schedule slot when deriving schedule intervals from `TimeLabel`.

Feature flags / guardrails
- `MAX_EXTRA_HOURS_PER_REQUEST_HOURS` (or `MAX_EXTRA_HOURS_PER_REQUEST`) - max hours per extra-hours request (default `12`).
- `MAX_TIME_OFF_DURATION_HOURS` (or `MAX_TIME_OFF_DURATION`) - max hours per time-off request (default `336`).
- `ENFORCE_TIMEOFF_OVERLAP` - if `true`, rejects overlapping time off requests (default `false`).

Email (optional)
- `EMAIL_SEND_ENABLED` - if `false`, email payloads are logged instead of sent (default `false`).
- `EMAIL_PROVIDER` - only `smtp` is supported currently.
- `SMTP_HOST`, `SMTP_PORT` (default `587`), `SMTP_USER`, `SMTP_PASS`
- `SMTP_FROM` (or `EMAIL_FROM`)
- `DECISION_EMAIL_ENABLED` - if `true` and `EMAIL_SEND_ENABLED=true`, sends optional approval/denial emails (extra hours decision flow).

Google Calendar (optional; used on time off approvals)
- `GOOGLE_SERVICE_ACCOUNT_JSON` - JSON string for a service account with Domain-Wide Delegation enabled.
  - Approval uses the franchise Gmail ID as both the impersonation subject and the `calendarId` for event inserts.

## Database expectations
This repo expects these Postgres tables to exist (DDL is captured in `AgentPrompts/02_postgres_schema.json`):
- `public.extrahours`
- `public.franchise_payroll_settings`
- `public.franchise_pay_period_overrides`
- `public.time_off_requests`
- `public.time_off_audit`
- `public.time_entry_days`
- `public.time_entry_sessions`
- `public.time_entry_audit`
- `public.weekly_attestations`

### Postgres migrations
- Run: `npm run db:migrate`
- Migration SQL lives in `server/db/migrations/` and is tracked in `public.schema_migrations`.

Clock state model (Postgres):
- `public.time_entry_days.clock_state`: `0 = clocked out`, `1 = clocked in` (default `0`).
- `public.time_entry_sessions.end_at` is nullable for an open session.
- A partial unique index enforces at most one open session per day (`entry_day_id` where `end_at IS NULL`).

MSSQL tables/fields referenced by the API:
- `dbo.tblSessionSchedule` + `dbo.tblTimes` (tutoring calendar and hour aggregation)
- `dbo.tblTutors` (`ID`, `FirstName`, `LastName`, `Email`, `IsDeleted`)
- `dbo.tblFranchies` (`FranchiesEmail` for extra hours drafts; `GmailID` for time off calendar approvals; plus a name column such as `FranchiseName`/`CenterName` when present)

## Manual DB connection checks
- Postgres (TypeScript via tsx): `npx tsx -e "import { getPostgresPool } from './server/db/postgres'; (async () => { const pool = getPostgresPool(); const res = await pool.query('SELECT $1::int as ok', [1]); console.log(res.rows[0]); await pool.end(); })().catch((err) => { console.error(err); process.exit(1); });"`
- Powershell-safe Postgres: `npx tsx -e 'import { getPostgresPool } from \"./server/db/postgres\"; (async () => { const pool = getPostgresPool(); const res = await pool.query(\"SELECT $1::int as ok\", [1]); console.log(res.rows[0]); await pool.end(); })().catch((err) => { console.error(err); process.exit(1); });'`
- MSSQL (TypeScript via tsx): `npx tsx -e "import { getMssqlPool, sql } from './server/db/mssql'; (async () => { const pool = await getMssqlPool(); const result = await pool.request().input('ok', sql.Int, 1).query('SELECT @ok as ok'); console.log(result.recordset[0]); await pool.close(); })().catch((err) => { console.error(err); process.exit(1); });"`
- Powershell-safe MSSQL: `npx tsx -e 'import { getMssqlPool, sql } from \"./server/db/mssql\"; (async () => { const pool = await getMssqlPool(); const result = await pool.request().input(\"ok\", sql.Int, 1).query(\"SELECT @ok as ok\"); console.log(result.recordset[0]); await pool.close(); })().catch((err) => { console.error(err); process.exit(1); });'`

## Replit notes
1. Install dependencies:
   - Root: `npm install`
   - Client: `npm install --prefix client` (run separately to avoid nested npm calls)
2. Dev mode: use `npm run dev` to run Vite (client) and Express (API) together.
3. Production mode: run `npm run build && npm start` to serve the prebuilt client from Express.
4. Vite proxies `/api` to `http://localhost:3000` in dev (`client/vite.config.ts`).

### Windows install tips
- If `npm install --prefix client` fails with locked files, close editors/Explorer in `client/node_modules`, then `npx rimraf client\\node_modules` and retry.

## How to test (manual QA)
Clock in/out:
1. Tutor dashboard → Clock → `Clock In` (creates an open session with server time truncated to the minute).
2. `Clock Out` (closes the open session with server time truncated to the minute).
3. If the day still has scheduled blocks remaining, choose:
   - **Break** (do not finalize), or
   - **Ending early** (finalize submits with a signed schedule snapshot; auto-approves on exact match, otherwise routes to pending).

Admin fixes:
1. Admin → Approvals → Time Entry Variances → Review a day.
2. Click **Fix time errors**, adjust sessions, enter a reason (min 5 chars), save.
3. Confirm the day remains pending and can be approved/denied; denial requires a reason.
