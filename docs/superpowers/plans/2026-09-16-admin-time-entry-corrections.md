# Admin Time-Entry Corrections Implementation Plan

## Implementation record — 2026-09-16

Tasks 1–8 have been implemented in the working tree. The checklist below is retained as the original implementation recipe; current verification and rollout instructions are in [the operations guide](../../operations/admin-time-entry-corrections.md).

Approved follow-up: tutors may explicitly replace a voided day on the same row, confirmed against the current admin void audit ID. The replacement starts pending with fresh sessions and no inherited breaks; original children and approval fields remain in immutable before/after audit history. Normal schedule submission/clock-out approval applies. Ordinary/stale writes still cannot reopen voided time, and admin restore cannot overwrite a replacement. This supersedes the blanket tutor read-only wording in the original recipe below; see the updated spec and operations guide.

Additional approved follow-up: admins can adjust completed approved days using the existing correction review and **Save & keep approved**. The shared policy and SQL writer now accept closed approved entries; open approved sessions/active breaks stay blocked. Original approval, hours and reason are audited; increases/decreases replace counted hours without duplicates. This supersedes approved-edit exclusions in the original recipe below and needs no additional migration.

Reviewed adjustments: the detail DTO supplies authoritative totals; structurally stale children require an explicit restart while retaining previous edits for reference; the outer router now uses the installed React Router data-router API to support safe browser navigation blocking, with existing routes/providers unchanged. No runtime dependencies, Rust migration, live database migration, deployment, commit or push were performed. User-owned settings and clock-out changes are preserved.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Default to inline execution unless delegation is authorized. This document is a plan, not an instruction to deploy or change live payroll.

**Goal:** Let admins create missing time, correct and approve draft/pending days, and reversibly void erroneous approved days through an additive, staged admin workflow.

**Architecture:** Extend the existing Approvals time-entry tab with a management view and one shared correction dialog. A dedicated Express router reads complete day aggregates and issues signed read-only previews; one transaction commits the preview, approval/status change, and audit event. Existing clock/tutor writers share parent-day locking and reject voided days; existing approved-only payroll readers retain their calculation rules.

**Tech Stack:** Existing Node.js >=18.18.0, TypeScript, Express 4, PostgreSQL/pg, MSSQL/mssql, Luxon 3, React 18, Vite, Radix dialog, Tailwind, Node test runner, Vitest and Testing Library. No new runtime dependencies.

**Spec:** [Product and technical spec](../specs/2026-09-16-admin-time-entry-corrections-design.md). Read it in full before execution; its state matrix, validation, accessibility, and acceptance examples are requirements.

## Global Constraints

- A time entry means one tutor's **whole work date**, including every session and break. Corrections may stage segment/break changes but review the whole day; void remains a whole-day action.
- Missing, draft, pending and completed approved days can be corrected. Approved corrections retain approved status. Denied days remain view-only for this admin workflow, with existing tutor resubmission behavior preserved.
- Work dates must be today or earlier in the center's timezone. Existing past pay periods are searchable; this application has no finalized-payroll lock or reliable export-history flag to invent.
- Admin corrections do not sign, erase, or silently amend weekly attestations. The affected day and its correction history remain available alongside the existing attestation records.
- Every admin correction saves a complete day as approved in the same transaction as its sessions, breaks, and audit event.
- Void and restore preserve day identity, original approval details, sessions, breaks, and earlier audit records.
- No physical deletion of day or audit rows. Removed correction segments are preserved in the operation's before snapshot.
- No new runtime dependencies, global theme changes, unrelated refactors, Rust migration, or production database access during implementation tests.
- The current working tree contains user-owned clock-out changes. Preserve them; inspect the actual integration base before editing overlapping files.
- Before every existing-symbol edit, run GitNexus upstream impact with the exact file/symbol, report direct callers/affected processes/risk, and warn on HIGH/CRITICAL. UNKNOWN is unresolved and needs corroboration, not an all-clear.
- Before any authorized commit, run GitNexus change analysis and inspect the expected scope. Do not commit, deploy, migrate a live database, or push merely because this plan contains implementation steps.

## Planning evidence and preparatory check

Inspected 2026-09-16: branch `fix/clockoutsnap`, HEAD `6539583`. Pre-existing changes were `client/src/pages/admin/SettingsPage.tsx`, `server/routes/clock.ts`, `server/services/clockOutFinalization.ts`, `server/tests/clockRoutes.test.ts`, and four clock-out backfill document/script/test files. Recheck; this inventory can change.

`npx gitnexus analyze` rebuilt the local index successfully. MCP impact remained UNKNOWN with incomplete caller metadata on six probes. Source checks established these consumers; these are navigation evidence, not a substitute for pre-edit impact:

| Symbol | Direct consumers verified in source | Processes to cover |
| --- | --- | --- |
| `ApprovalsPage` | `/admin/approvals` route in `App.tsx` | Pending queue, time-off deep links, all tabs, franchise switching |
| `adminEditTimeEntryDay` | `saveFix` in `ApprovalsPage.tsx` | Existing fix dialog migration |
| `fetchDayByWorkDate` | Tutor save, submit, and break-create handlers | Parent locking, voided guards, missing-day creation race |
| `mapDayRowToResponse` | Tutor/admin read and write responses | Closed-session compatibility and correct voided display |
| `finalizeClockOutInTransaction` | Manual clock route and `finalizeProductionCandidate` | Manual and automatic clock races |
| `fetchApprovedDaysForFranchise` | Summary payload, legacy summary/export, review export, and grouped export | Approved-only totals, void exclusion, restore inclusion |

- [ ] Read the current spec, `AGENTS.md`, and local GitNexus instructions; inspect the actual checkout.

```powershell
git status --short
git branch --show-current
git log -1 --oneline
```

- [ ] Refresh impact evidence on the actual execution tree. If MCP has an obsolete index handle, use the generated local runner after reading the CLI skill:

```powershell
node .gitnexus/run.cjs impact ApprovalsPage --direction upstream --repo .
node .gitnexus/run.cjs impact finalizeClockOutInTransaction --direction upstream --repo .
```

Do not switch branches or move current edits blindly. If isolation is required, establish a reviewed integration base using the worktree workflow; a new worktree at HEAD alone does not contain the uncommitted clock-out fixes.

## Planned file ownership

| Area | New files | Existing files to touch |
| --- | --- | --- |
| Contracts and policy | `server/services/adminTimeEntry/contracts.ts`, `policy.ts`, `revision.ts`; `server/types/timeEntry.ts` | Status aliases in `server/services/clockSubmission.ts`, `server/routes/timeEntry.ts`, `server/routes/clock.ts` |
| Persistence/read model | `server/services/adminTimeEntry/repository.ts`, `directory.ts`; `server/db/migrations/0015_admin_time_entry_operations.sql` | No change to payroll math or PTO services |
| Preview/operations | `server/services/adminTimeEntry/preview.ts`, `previewToken.ts`, `operations.ts`; `server/routes/adminTimeEntry.ts` | `server/index.ts` router mount |
| Writer integration | `server/services/timeEntryMutationGuard.ts` | `server/routes/timeEntry.ts`, `server/routes/clock.ts`, `server/services/autoClockOutScheduler.ts`, `server/services/clockOutFinalization.ts` |
| Admin client | `client/src/lib/adminTimeEntry.ts`, `adminTimeEntryApi.ts`; `client/src/pages/admin/time-entry/TimeEntryManagementPanel.tsx`, `TimeEntryCorrectionDialog.tsx`, `TimeEntryHistory.tsx`, `TimeEntryStatusBadge.tsx` | `client/src/lib/api.ts`, `client/src/pages/admin/ApprovalsPage.tsx` |
| Reader integration | New tests described below | `client/src/pages/tutor/CalendarPage.tsx`, `client/src/components/tutor/ClockWidget.tsx`, `client/src/pages/admin/PayPeriodSummaryPage.tsx` |
| Test infrastructure | `server/tests/helpers/adminTimeEntryFixtures.ts`, `adminTimeEntryDatabase.ts`, `adminTimeEntryHttp.ts`; feature test files listed per task | Existing clock, time-entry, and hours tests |
| Documentation | `docs/operations/admin-time-entry-corrections.md` | `README.md` |

Keep the new components and services focused. Do not expand the already-large `ApprovalsPage.tsx` or `timeEntry.ts` with the entire new feature.

## Task 1: Define lifecycle, wire contracts, revision, and pure validation

**Files:** Create `server/types/timeEntry.ts`, `server/services/adminTimeEntry/{contracts,policy,revision}.ts`, `server/tests/helpers/adminTimeEntryFixtures.ts`, and `server/tests/adminTimeEntryPolicy.test.ts`.

**Produces:** `TimeEntryStatus`; the contracts below; `allowedAdminTimeEntryActions`, `normalizeCorrection`, and `revisionForEntry`. No database calls in this task.

Define the server contracts in one place; client copies of the wire DTOs must match these shapes and be checked by API contract tests in Task 6:

```ts
export type TimeEntryStatus = 'draft' | 'pending' | 'approved' | 'denied' | 'voided';
export type AdminAction = 'correct' | 'void' | 'restore';
export type ScheduleSource = 'stored' | 'current' | 'none' | 'unavailable';
export type SessionInput = { id: number | null; startAt: string; endAt: string };
export type BreakInput = {
  id: number | null;
  breakType: 'lunch' | 'rest_break' | 'personal' | 'training' | 'travel' | 'other';
  payTreatment: 'paid' | 'unpaid';
  status: 'completed' | 'voided';
  startTime: string | null;
  endTime: string | null;
  durationMinutes: number;
  note: string | null;
};
export type AdminSession = Omit<SessionInput, 'id' | 'endAt'> & {
  id: number; endAt: string | null; sortOrder: number;
  createdAt: string; updatedAt: string;
};
export type AdminBreak = Omit<BreakInput, 'id' | 'status'> & {
  id: number; sessionId: number | null;
  status: 'active' | 'completed' | 'voided';
  source: 'employee' | 'manager' | 'auto_rule' | 'import';
  createdAt: string; updatedAt: string;
};
export type AdminEntry = {
  id: number; franchiseId: number; tutorId: number; workDate: string;
  timezone: string; status: TimeEntryStatus; clockState: 0 | 1;
  scheduleSnapshot: unknown | null; comparison: unknown | null;
  submittedAt: string | null; decidedBy: number | null;
  decidedAt: string | null; decisionReason: string | null;
  createdAt: string; updatedAt: string;
  sessions: AdminSession[]; breaks: AdminBreak[]; lastAuditId: number | null;
};
export type AdminTutor = {
  tutorId: number; displayName: string; active: boolean; historyOnly: boolean;
};
export type AdminTimeEntryDetail = {
  franchiseId: number; tutor: AdminTutor; workDate: string; timezone: string;
  day: AdminEntry | null; revision: string; allowedActions: AdminAction[];
};
export type CorrectionInput = {
  franchiseId: number; tutorId: number; workDate: string; expectedRevision: string;
  sessions: SessionInput[]; breaks: BreakInput[]; reason: string;
};
export type StatusOperationInput = {
  franchiseId: number; dayId: number; expectedRevision: string; reason: string;
};
export type NormalizedCorrection = {
  sessions: SessionInput[]; breaks: BreakInput[]; reason: string;
};
export type MinuteSummary = {
  grossMinutes: number | null; unpaidBreakMinutes: number | null;
  recordedPaidMinutes: number | null; approvedMinutes: number | null;
};
export type AdminPreview = {
  previewToken: string; expiresAt: string;
  review: { action: AdminAction; originalEntry: AdminEntry | null;
    correction: NormalizedCorrection | null; workDate: string; timezone: string; reason: string };
  before: MinuteSummary; after: MinuteSummary;
  recordedDeltaMinutes: number | null; approvedDeltaMinutes: number | null;
  warnings: string[];
};
export type AdminOperationResult = {
  operationId: string; auditId: number; action: AdminAction;
  entryId: number; status: 'approved' | 'voided'; committedAt: string;
  before: MinuteSummary; after: MinuteSummary;
};
```

`AdminOperationResult` is the immutable recorded outcome, not a promise that the current day still has that status after later operations. The client refetches current detail after recovering/replaying it.

Interfaces:

```ts
function allowedAdminTimeEntryActions(
  day: AdminEntry | null, canCreate: boolean
): AdminAction[];
function normalizeCorrection(input: CorrectionInput, context: {
  day: AdminEntry | null; timezone: string; now: Date;
}): NormalizedCorrection;
function revisionForEntry(day: AdminEntry | null): string;
```

- [ ] Write behavior tests before policy implementation. Build this complete fixture in `helpers/adminTimeEntryFixtures.ts` and export both factories:

```ts
import type { AdminEntry, CorrectionInput } from '../../services/adminTimeEntry/contracts';

export const pendingEntry = (overrides: Partial<AdminEntry> = {}): AdminEntry => ({
  id: 44, franchiseId: 77, tutorId: 88, workDate: '2026-09-15',
  timezone: 'America/Los_Angeles', status: 'pending', clockState: 0,
  scheduleSnapshot: null, comparison: null,
  submittedAt: '2026-09-16T01:00:00Z', decidedBy: null,
  decidedAt: null, decisionReason: null,
  createdAt: '2026-09-15T22:00:00Z', updatedAt: '2026-09-16T01:00:00Z',
  sessions: [{ id: 99, startAt: '2026-09-15T22:00:00Z',
    endAt: '2026-09-16T01:00:00Z', sortOrder: 0,
    createdAt: '2026-09-15T22:00:00Z', updatedAt: '2026-09-16T01:00:00Z' }],
  breaks: [], lastAuditId: 1, ...overrides
});
export const correctionInput = (overrides: Partial<CorrectionInput> = {}): CorrectionInput => ({
  franchiseId: 77, tutorId: 88, workDate: '2026-09-15', expectedRevision: 'test-revision',
  sessions: [{ id: 99, startAt: '2026-09-15T22:00:00Z', endAt: '2026-09-16T01:15:00Z' }],
  breaks: [], reason: 'Corrected forgotten clock-out', ...overrides
});
```

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { allowedAdminTimeEntryActions, normalizeCorrection } from '../services/adminTimeEntry/policy';
import { revisionForEntry } from '../services/adminTimeEntry/revision';
import { pendingEntry, correctionInput } from './helpers/adminTimeEntryFixtures';

test('approved days are removable but cannot use pending correction', () => {
  assert.deepEqual(allowedAdminTimeEntryActions(pendingEntry({ status: 'approved' }), false), ['void']);
  assert.deepEqual(allowedAdminTimeEntryActions(pendingEntry({ status: 'voided' }), false), ['restore']);
  assert.deepEqual(allowedAdminTimeEntryActions(null, true), ['correct']);
  assert.deepEqual(allowedAdminTimeEntryActions(null, false), []);
});
test('revision changes when an open end or audit history changes', () => {
  const day = pendingEntry();
  assert.notEqual(revisionForEntry(day), revisionForEntry({ ...day,
    sessions: [{ ...day.sessions[0], endAt: null }] }));
  assert.notEqual(revisionForEntry(day), revisionForEntry({ ...day, lastAuditId: 2 }));
});
test('a correction cannot approve an open end', () => {
  const input = correctionInput({ sessions: [{ id: 99, startAt: '2026-09-15T22:00:00Z', endAt: '' }] });
  assert.throws(() => normalizeCorrection(input, {
    day: pendingEntry(), timezone: 'America/Los_Angeles', now: new Date('2026-09-16T12:00:00Z')
  }), /end/i);
});
```

Add parameterized assertions for 1–20 sessions; reversed, overlapping, future, non-minute, and wrong-local-date times; 5/2000-character reason boundaries; foreign/duplicate session IDs; omitted existing break IDs; no active break in output; edited break containment; duration-only legacy preservation; and denied/approved/voided correction rejection.

- [ ] Run `node --test --import tsx server/tests/adminTimeEntryPolicy.test.ts` and observe missing-behavior failures. Initial missing-module errors only establish the skeleton is absent; repeat after the exports exist to prove the actual policy assertions fail before implementing them.
- [ ] Implement action selection, normalized ID/timestamp checks, reason validation, and revision hashing. Use these core rules:

```ts
export function allowedAdminTimeEntryActions(day: AdminEntry | null, canCreate: boolean): AdminAction[] {
  if (!day) return canCreate ? ['correct'] : [];
  if (day.status === 'draft' || day.status === 'pending') return ['correct'];
  const open = day.clockState === 1 || day.sessions.some(s => s.endAt === null)
    || day.breaks.some(b => b.status === 'active');
  if (open) return [];
  if (day.status === 'approved') return ['void'];
  if (day.status === 'voided') return ['restore'];
  return [];
}
```

Use `parseTimestamptzMinute` from `timeEntryComparison.ts` and Luxon to check each normalized instant against the authoritative work date. Sort intervals and reject overlap before allocation. Do not use `Boolean(raw)` or numeric coercion as validation of IDs/enums. For revision, `createHash('sha256').update(canonicalJsonStringify(canonicalEntry)).digest('hex')` uses persisted fields only, session/break arrays sorted by ID, and UTC-normalized timestamps; return `missing` for null. Import `canonicalJsonStringify` from `scheduleSnapshot.ts`.

- [ ] Rerun the policy tests and typecheck the new exports. Record which assertions fail when removing a status guard or excluding nullable session ends from revision.

## Task 2: Add operation identity, complete aggregate reads, and tutor discovery

**Files:** Create migration `0015_admin_time_entry_operations.sql`, `server/services/adminTimeEntry/{repository,directory}.ts`, `server/tests/helpers/adminTimeEntryDatabase.ts`, `server/tests/adminTimeEntryRepository.test.ts`, and `server/tests/adminTimeEntryRepository.integration.test.ts`.

**Consumes:** Task 1 DTOs and revision function; existing pg/mssql pools and `mapBreakRowToResponse` conventions. Directory lookup must not depend on PTO enablement.

**Produces:**

```ts
type EntryKey = { franchiseId: number; tutorId: number; workDate: string };
type DayFilters = { franchiseId: number; start: string; end: string;
  tutorId?: number; status?: 'all' | TimeEntryStatus; cursor?: string; limit: number };
type DayListItem = { id: number; tutorId: number; tutorName: string; workDate: string;
  timezone: string; status: TimeEntryStatus; inProgress: boolean; totals: MinuteSummary };
type TutorFilters = { franchiseId: number; search: string; cursor?: string; limit: number };
type AuditItem = { id: number; action: string; actorAccountId: number | null;
  actorAccountType: string; at: string; reason: string | null; metadata: unknown };
function readEntry(client: PoolClient, key: EntryKey, lock: boolean): Promise<AdminEntry | null>;
function readEntryById(client: PoolClient, franchiseId: number, dayId: number, lock: boolean): Promise<AdminEntry | null>;
function getAdminDetail(key: EntryKey): Promise<AdminTimeEntryDetail>;
function listAdminDays(filters: DayFilters): Promise<{ items: DayListItem[]; nextCursor: string | null }>;
function listAdminTutors(filters: TutorFilters): Promise<{ items: AdminTutor[]; nextCursor: string | null }>;
function readHistory(franchiseId: number, dayId: number, beforeId: number | null, limit: number):
  Promise<{ items: AuditItem[]; nextCursor: string | null }>;
function requireActiveTutor(franchiseId: number, tutorId: number): Promise<AdminTutor>;
```

`getAdminDetail` resolves the existing tutor identity from scoped historical rows when CRM fails; a null day requires successful identity resolution before it is represented as creatable. Query/mapping implementations receive injectable pool providers for unit tests. Public HTTP handlers will be dependency-injected in Task 4.

- [ ] Add the additive migration:

```sql
ALTER TABLE public.time_entry_audit
  ADD COLUMN IF NOT EXISTS operation_id UUID;
CREATE UNIQUE INDEX IF NOT EXISTS time_entry_audit_operation_id_uniq
  ON public.time_entry_audit (operation_id)
  WHERE operation_id IS NOT NULL;
```

Verify migration number 0015 is still available before implementation; if another change has consumed it, select the next free number and update all references together. Do not rewrite existing migrations.

- [ ] Implement the disposable PostgreSQL helper for real locking/migration tests. It exports `withTimeEntryDatabase(run: (pool: Pool) => Promise<void>): Promise<void>` and never reads a production URL. Follow the existing Docker integration pattern, but use a new container per top-level feature integration suite:

```ts
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { Pool } from 'pg';

export async function withTimeEntryDatabase(run: (pool: Pool) => Promise<void>) {
  const name = `timecard-admin-entry-test-${randomUUID()}`;
  const docker = (...args: string[]) => execFileSync('docker', args, {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000
  }).trim();
  let pool: Pool | undefined;
  let started = false;
  try {
    docker('run', '--detach', '--rm', '--name', name,
      '--env', 'POSTGRES_PASSWORD=local_time_entry_test',
      '--env', 'POSTGRES_DB=time_entry_test', '--publish', '127.0.0.1::5432', 'postgres:17-alpine');
    started = true;
    const portText = docker('port', name, '5432/tcp');
    const port = Number(portText.slice(portText.lastIndexOf(':') + 1));
    if (!Number.isInteger(port) || port < 1) throw new Error('Invalid disposable test port');
    pool = new Pool({ host: '127.0.0.1', port, database: 'time_entry_test',
      user: 'postgres', password: 'local_time_entry_test', max: 5 });
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt += 1) {
      try { await pool.query('SELECT 1'); ready = true; break; }
      catch { await new Promise(resolve => setTimeout(resolve, 500)); }
    }
    if (!ready) throw new Error('Disposable PostgreSQL did not start');
    for (const name of ['0001_time_entry_and_weekly_attestations.sql', '0002_clock_in_out.sql',
      '0005_time_entry_breaks.sql', '0015_admin_time_entry_operations.sql']) {
      await pool.query(readFileSync(path.resolve(__dirname, '../../db/migrations', name), 'utf8'));
    }
    await run(pool);
  } finally {
    await pool?.end();
    if (started) docker('stop', name);
  }
}
```

The integration suite calls this helper only when `RUN_TIME_ENTRY_POSTGRES_TESTS=1`. Keep its connection settings local and explicit; never substitute a shared environment database URL.

- [ ] Write a real aggregate test before implementing reads:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { readEntry } from '../services/adminTimeEntry/repository';
import { withTimeEntryDatabase } from './helpers/adminTimeEntryDatabase';

test('admin aggregate includes an open session and hides cross-center data', {
  skip: process.env.RUN_TIME_ENTRY_POSTGRES_TESTS !== '1'
}, async () => withTimeEntryDatabase(async pool => {
  const inserted = await pool.query(`INSERT INTO public.time_entry_days
    (franchiseid,tutorid,work_date,timezone,status,clock_state)
    VALUES (77,88,'2026-09-15','America/Los_Angeles','draft',1) RETURNING id`);
  const id = inserted.rows[0].id;
  await pool.query(`INSERT INTO public.time_entry_sessions
    (entry_day_id,franchiseid,tutorid,start_at,end_at,sort_order)
    VALUES ($1,77,88,'2026-09-15T22:00:00Z',NULL,0)`, [id]);
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const entry = await readEntry(client, { franchiseId: 77, tutorId: 88, workDate: '2026-09-15' }, false);
    assert.equal(entry?.clockState, 1);
    assert.equal(entry?.sessions.length, 1);
    assert.equal(entry?.sessions[0].endAt, null);
    assert.equal(await readEntry(client, { franchiseId: 78, tutorId: 88, workDate: '2026-09-15' }, false), null);
    await client.query('COMMIT');
  } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
}));
```

- [ ] Implement parameterized SQL with the following critical selection shape; use the same parent-first order in locked reads:

```sql
SELECT * FROM public.time_entry_days
WHERE franchiseid = $1 AND tutorid = $2 AND work_date = $3
FOR UPDATE;

SELECT * FROM public.time_entry_sessions
WHERE entry_day_id = $1 ORDER BY sort_order, start_at, id;

SELECT * FROM public.time_entry_breaks
WHERE entry_day_id = $1 ORDER BY id;

SELECT id FROM public.time_entry_audit
WHERE entry_day_id = $1 ORDER BY id DESC LIMIT 1;
```

Use `FOR UPDATE` only for `lock: true` and only inside a transaction; unlocked repeatable-read responses omit it. Never filter out nullable ends. Preserve PostgreSQL DATE strings and all original audit/snapshot fields. For the directory, follow the existing parameterized `dbo.tblTutors` query with `FranchiseID = @FranchiseId`; combine it with center-scoped historical IDs, label inactive/history-only names, and do not invoke PTO discovery or mutate a roster.

Pagination must have stable cursors bound to normalized filters and center. List days by `work_date DESC, tutorid ASC, id DESC`; cursor contains that tuple. Tutor list sorts normalized display name then tutor ID. Fetch `limit + 1`, return at most `limit`, and issue a next cursor only when another row exists. Batch child/identity lookups; no per-row database requests.

- [ ] Add tests for list pagination without duplicates/omissions, 93-day range enforcement, timezone/date serialization, inactive historical tutors, missing versus failed lookup, and duplicate non-null operation IDs rejected while legacy null operation IDs remain valid.
- [ ] Run the unit tests and the real integration suite in a disposable database:

```powershell
node --test --import tsx server/tests/adminTimeEntryRepository.test.ts
$env:RUN_TIME_ENTRY_POSTGRES_TESTS='1'
node --test --import tsx server/tests/adminTimeEntryRepository.integration.test.ts
Remove-Item Env:RUN_TIME_ENTRY_POSTGRES_TESTS
```

If Docker is unavailable, record the real integration tests as unrun and keep them required before release. Do not substitute an environment-provided live database.

## Task 3: Build read-only previews and signed confirmation tokens

**Files:** Create `server/services/adminTimeEntry/{preview,previewToken}.ts`, `server/tests/adminTimeEntryPreview.test.ts`, and `server/tests/adminTimeEntryPreviewToken.test.ts`.

**Consumes:** Tasks 1–2, `computeTimeAllocation`, `computeTimeEntryComparisonV2`, `parseScheduleSnapshotV1`, `fetchLatestScheduleSnapshots`, `scheduleCandidateKey`, and the existing `SESSION_SECRET` configuration.

**Produces:**

```ts
type AdminActor = { accountId: number; franchiseId: number };
type AdminCommand = {
  version: 1; action: AdminAction; actor: AdminActor;
  tutorId: number; workDate: string; timezone: string; entryId: number | null;
  expectedRevision: string; reason: string;
  correction: NormalizedCorrection | null;
  scheduleSnapshot: unknown | null; scheduleSource: ScheduleSource;
  before: MinuteSummary; after: MinuteSummary;
  issuedAt: string; expiresAt: string;
};
type PreviewDeps = {
  getDetail: (key: EntryKey) => Promise<AdminTimeEntryDetail>;
  getById: (franchiseId: number, dayId: number) => Promise<AdminTimeEntryDetail>;
  requireActiveTutor: (franchiseId: number, tutorId: number) => Promise<AdminTutor>;
  getSchedule: (key: EntryKey & { timezone: string }) => Promise<unknown>;
  now: () => Date; secret: string;
};
function previewCorrection(actor: AdminActor, input: CorrectionInput, deps: PreviewDeps): Promise<AdminPreview>;
function previewStatusOperation(action: 'void' | 'restore', actor: AdminActor,
  input: StatusOperationInput, deps: PreviewDeps): Promise<AdminPreview>;
function signAdminPreview(command: AdminCommand, secret: string): string;
function verifyAdminPreviewIntegrity(token: string, secret: string): AdminCommand;
function assertAdminPreviewFresh(command: AdminCommand, now: Date): void;
```

All these interfaces live in `contracts.ts`, with pg-specific interfaces confined to the repository. `getById` is a service wrapper around the scoped repository lookup, never an unscoped numeric-ID read.

- [ ] Write preview tests with a fixed clock and no write dependency. The following complete dependency object is sufficient for the pending example:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { pendingEntry, correctionInput } from './helpers/adminTimeEntryFixtures';
import { revisionForEntry } from '../services/adminTimeEntry/revision';
import { previewCorrection } from '../services/adminTimeEntry/preview';
import type { PreviewDeps } from '../services/adminTimeEntry/contracts';

test('pending correction reports full newly approved minutes, not only the edit delta', async () => {
  const day = pendingEntry();
  const tutor = { tutorId: 88, displayName: 'Alex Rivera', active: true, historyOnly: false };
  const detail = { franchiseId: 77, tutor, day, timezone: day.timezone, workDate: day.workDate,
    revision: revisionForEntry(day), allowedActions: ['correct' as const] };
  const deps: PreviewDeps = { getDetail: async () => detail, getById: async () => detail,
    requireActiveTutor: async () => tutor, getSchedule: async () => { throw new Error('CRM unavailable'); },
    now: () => new Date('2026-09-16T12:00:00Z'), secret: 'local-preview-test-secret' };
  const preview = await previewCorrection({ accountId: 100, franchiseId: 77 },
    correctionInput({ expectedRevision: detail.revision }), deps);
  assert.equal(preview.before.recordedPaidMinutes, 180);
  assert.equal(preview.before.approvedMinutes, 0);
  assert.equal(preview.after.recordedPaidMinutes, 195);
  assert.equal(preview.after.approvedMinutes, 195);
  assert.equal(preview.recordedDeltaMinutes, 15);
  assert.equal(preview.approvedDeltaMinutes, 195);
  assert.ok(preview.warnings.some(text => /schedule.*unavailable/i.test(text)));
});
```

- [ ] Run `node --test --import tsx server/tests/adminTimeEntryPreview.test.ts server/tests/adminTimeEntryPreviewToken.test.ts` and confirm behavior failures before implementation.
- [ ] Implement signing with a dedicated purpose, strict payload decoding, and constant-time signature comparison. HMAC recipe:

```ts
const purpose = 'admin-time-entry-preview:v1:';
const encoded = Buffer.from(canonicalJsonStringify(command), 'utf8').toString('base64url');
const signature = createHmac('sha256', secret).update(purpose + encoded).digest('base64url');
const token = `${encoded}.${signature}`;
```

The verifier must enforce exactly two segments, a payload size cap of 128 KiB, a 32-byte decoded signature, constant-time equality, a strict version/action/identity/schema check, and valid dates. Reject unknown fields that could affect the command. Treat the token as sensitive in logs. Separate integrity verification from expiry so committed operation retries can be recovered after expiry.

Normalize and compute the after-state on the server. Prefer a stored snapshot only when its center, tutor, date, timezone, and interval validity match. Fetch a current scoped schedule outside write transactions otherwise. With unavailable schedule, `comparison` is null, warnings explain unmatched classification, and paid totals come from `computeTimeAllocation({ sessions, breaks, scheduleIntervals: [] })`. A successful empty schedule is `none`, not `unavailable`.

Correction requires valid after totals; invalid before totals are null. Voiding an invalid closed approved day is allowed with unknown before/delta totals; restore is blocked for invalid preserved data. Do not turn unknown totals into numeric zero.

- [ ] Test token tampering, other-admin/center reuse, ten-minute expiry, replay after expiry, stale revisions, unverified roster blocking only missing-day creation, active-session completion, and valid legacy duration-only break warnings. Assert no preview path has SQL insert/update/delete side effects.
- [ ] Rerun preview/policy tests. Inspect all `AdminCommand` fields used by commit in Task 4 for exact type consistency.

## Task 4: Commit each preview atomically with audit and retry recovery

**Files:** Create `server/services/adminTimeEntry/operations.ts`, `server/routes/adminTimeEntry.ts`, `server/tests/helpers/adminTimeEntryHttp.ts`, `server/tests/adminTimeEntryRoutes.test.ts`, and `server/tests/adminTimeEntryOperations.integration.test.ts`. Extend `repository.ts` with the explicitly listed write methods. Mount the router in `server/index.ts` after auth/session middleware and before the `/api` 404 fallback.

**Consumes:** Prior contracts and signed preview. **Produces:**

```ts
type OperationDeps = { pool: Pool; secret: string; now: () => Date };
type OperationRequest = { operationId: string; previewToken: string };
function commitAdminOperation(actor: AdminActor, input: OperationRequest,
  deps: OperationDeps): Promise<AdminOperationResult>;
function getAdminOperation(actor: AdminActor, operationId: string,
  pool: Pool): Promise<AdminOperationResult | null>;
function createAdminTimeEntryRouter(deps: AdminTimeEntryRouteDeps): Router;
```

`AdminTimeEntryRouteDeps` exposes `listTutors`, `listDays`, `getDetail`, `getHistory`, `previewCorrection`, `previewVoid`, `previewRestore`, `commit`, and `getOperation`, each with the input/return types already defined above. The router parses unknown request data, calls `requireAdmin`, obtains the actor from `req.session.auth`, resolves `enforceFranchiseScope`, and passes only the effective center to services.

Write repository functions with exact responsibilities:

```ts
type StoredOperation = { commandHash: string; actorId: number; franchiseId: number;
  result: AdminOperationResult };
function findOperation(client: PoolClient, operationId: string): Promise<StoredOperation | null>;
function createMissingDay(client: PoolClient, command: AdminCommand): Promise<number | null>;
function writeCorrectedChildren(client: PoolClient, day: AdminEntry,
  correction: NormalizedCorrection): Promise<void>;
function writeApprovedDay(client: PoolClient, dayId: number, command: AdminCommand): Promise<void>;
function writeDayStatus(client: PoolClient, dayId: number, status: 'approved' | 'voided'): Promise<void>;
function appendOperationAudit(client: PoolClient, operationId: string, commandHash: string,
  command: AdminCommand, before: AdminEntry | null, after: AdminEntry): Promise<AdminOperationResult>;
```

`commandHash` hashes the complete signed command, including preview issuance. A retry uses the same preview token and UUID. A new preview requires a new UUID. An actor cannot retrieve another actor's recorded operation result even if the UUID is guessed.

- [ ] Add transactional integration tests. Export a fixture seeder in the test helper:

```ts
export async function seedPendingEntry(pool: Pool): Promise<void> {
  await pool.query(`INSERT INTO public.time_entry_days
    (id,franchiseid,tutorid,work_date,timezone,status,clock_state)
    VALUES (44,77,88,'2026-09-15','America/Los_Angeles','pending',0)`);
  await pool.query(`INSERT INTO public.time_entry_sessions
    (id,entry_day_id,franchiseid,tutorid,start_at,end_at,sort_order)
    VALUES (99,44,77,88,'2026-09-15T22:00:00Z','2026-09-16T01:00:00Z',0)`);
  await pool.query(`SELECT setval(pg_get_serial_sequence('public.time_entry_days','id'),44)`);
  await pool.query(`SELECT setval(pg_get_serial_sequence('public.time_entry_sessions','id'),99)`);
}
```

In `adminTimeEntryOperations.integration.test.ts`, use real PostgreSQL aggregate reads and fake roster/schedule providers. This example defines the complete operation setup:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { withTimeEntryDatabase } from './helpers/adminTimeEntryDatabase';
import { seedPendingEntry, correctionInput } from './helpers/adminTimeEntryFixtures';
import { readEntry } from '../services/adminTimeEntry/repository';
import { revisionForEntry } from '../services/adminTimeEntry/revision';
import { previewCorrection } from '../services/adminTimeEntry/preview';
import { commitAdminOperation } from '../services/adminTimeEntry/operations';
import type { PreviewDeps } from '../services/adminTimeEntry/contracts';

test('correction commits approval and a recoverable audit result exactly once', {
  skip: process.env.RUN_TIME_ENTRY_POSTGRES_TESTS !== '1'
}, async () => withTimeEntryDatabase(async pool => {
  await seedPendingEntry(pool);
  const tutor = { tutorId: 88, displayName: 'Alex Rivera', active: true, historyOnly: false };
  const key = { franchiseId: 77, tutorId: 88, workDate: '2026-09-15' };
  const loadDetail = async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const day = await readEntry(client, key, false);
      assert.ok(day);
      await client.query('COMMIT');
      return { franchiseId: 77, tutor, day, workDate: day.workDate, timezone: day.timezone,
        revision: revisionForEntry(day), allowedActions: ['correct' as const] };
    } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
  };
  const now = () => new Date('2026-09-16T12:00:00Z');
  const secret = 'local-preview-test-secret';
  const previewDeps: PreviewDeps = { getDetail: loadDetail, getById: loadDetail,
    requireActiveTutor: async () => tutor,
    getSchedule: async () => { throw new Error('CRM unavailable'); }, now, secret };
  const detail = await loadDetail();
  const actor = { accountId: 100, franchiseId: 77 };
  const preview = await previewCorrection(actor,
    correctionInput({ expectedRevision: detail.revision }), previewDeps);
  const input = { operationId: randomUUID(), previewToken: preview.previewToken };
  const operationDeps = { pool, now, secret };
  const first = await commitAdminOperation(actor, input, operationDeps);
  const retried = await commitAdminOperation(actor, input, operationDeps);
  assert.deepEqual(retried, first);
  const stored = await pool.query('SELECT status, decided_by, clock_state FROM public.time_entry_days WHERE id=44');
  assert.deepEqual(stored.rows[0], { status: 'approved', decided_by: 100, clock_state: 0 });
  const audit = await pool.query('SELECT metadata FROM public.time_entry_audit WHERE operation_id=$1', [input.operationId]);
  assert.equal(audit.rowCount, 1);
  assert.equal(audit.rows[0].metadata.before.sessions[0].endAt, '2026-09-16T01:00:00.000Z');
  assert.equal(audit.rows[0].metadata.after.sessions[0].endAt, '2026-09-16T01:15:00.000Z');
}));
```

Add `import type { Pool } from 'pg'` to the fixture helper for `seedPendingEntry`. ISO serialization must consistently use UTC `.toISOString()` so these assertions are stable.

- [ ] Implement commit in this exact order:

```text
verify token signature/schema → verify actor and effective center → validate operation UUID
BEGIN
find prior operation; same actor+command → return recorded result after COMMIT
assert preview not expired and recheck now-dependent constraints
for missing: INSERT ... ON CONFLICT DO NOTHING RETURNING id
  on conflict: check identical operation replay again; otherwise ENTRY_CHANGED
lock day by ID AND franchise; SELECT ... FOR UPDATE
find prior operation again (covers a concurrent retry waiting for the lock)
read all children/latest audit and compare revision (except newly inserted missing row)
recheck action eligibility; for restore verify current children match the preserved void snapshot
capture full before snapshot
apply correction or status transition
refetch final canonical aggregate and validate completion/invariants
insert one operation audit event containing before/after snapshots and result
COMMIT; return the recorded result
on any failure: ROLLBACK; release connection in finally
```

Use conditional UPDATE status predicates as an additional defense. No external API calls happen inside this write transaction. Lock before touching child rows. A PostgreSQL unique violation on the operation index must roll back the attempted mutation, then resolve identical replay or return `OPERATION_CONFLICT`. Do not catch arbitrary unique violations as successful replays.

Audit metadata uses `{ version: 1, source: 'admin_time_entry', commandHash, reason, before, after, result, scheduleSource }`, plus server actor/workdate context. `appendOperationAudit` obtains the audit ID and server time, builds the recorded result, and saves that same result in metadata before commit. It may update only the newly inserted event within its creating transaction; previously committed audit events are never amended. Set `operation_id` on that one final event only.

For corrections, preserve unchanged session IDs, insert new sessions, update changed sessions, explicitly handle removed segment IDs, and preserve all break rows. Reattach timed breaks only to containing final sessions, nulling links for preserved historical/voided unpositioned breaks. Record original times and links before removing any active segment. Update status/approval and comparison after children are final.

- [ ] Add real database tests for full rollback on an injected audit failure; two different creators of a missing day; two admins using the same old revision; same-operation concurrent retry; altered-content UUID reuse; void+restore retaining child row IDs/timestamps and original decision fields; and stale restore rejection after out-of-band child change. Use two connections and explicit barriers/lock observation, not timing guesses.
- [ ] Add HTTP tests with fake service dependencies and the existing session-auth harness pattern. Test every route's 401/403/scoped 404 behavior, input bounds, safe error messages, and no client authority over `status`/`decidedBy`. Legacy locked-center request parameters must resolve according to existing `enforceFranchiseScope`; assert services receive the enforced center.
- [ ] Mount the router with a minimal integration change:

```ts
import adminTimeEntryRoutes from './routes/adminTimeEntry';
app.use('/api', adminTimeEntryRoutes);
```

Production default export is created from real dependencies without opening a database connection at module import. Keep the factory export for tests.

- [ ] Run route/unit tests, real operations integration tests, and server typecheck. Do not expose the UI until Task 5 writer guards are integrated.

## Task 5: Guard existing writers and retire immediate admin correction saves

**Files:** Create `server/services/timeEntryMutationGuard.ts`, `server/tests/timeEntryMutationGuard.test.ts`, and `server/tests/timeEntryAdminCompatibility.test.ts`. Modify `server/routes/timeEntry.ts`, `server/routes/clock.ts`, `server/services/clockSubmission.ts`, `server/services/clockOutFinalization.ts`, `server/services/autoClockOutScheduler.ts`, and corresponding existing tests.

**Consumes:** Canonical `TimeEntryStatus` and parent-locking invariant. **Produces:** voided-day protection across every mutation path and safe legacy-route behavior.

```ts
function assertDayNotVoided(day: { status: TimeEntryStatus } | null): void;
```

- [ ] Run impact for each modified symbol, including nested route handlers. For anonymous handlers, use the route/file impact tool plus containing-symbol/file impact, and document the caller limitation. Read the current uncommitted clock changes before applying any guard.
- [ ] Write failing HTTP/service tests for this complete writer matrix:

| Writer | Required test |
| --- | --- |
| Tutor PUT day | Voided day remains unchanged; current approved-day invalidation still works. |
| Tutor submit | Cannot approve a voided row using a stored/signed schedule. |
| Tutor break creation | Cannot create a break on a voided row. |
| Admin decide | Cannot decide voided/non-pending rows; cannot approve pending open sessions/active breaks. |
| Manual clock in/start break/end break/out | Each rejects a voided day before session/break/status writes. |
| Automatic candidate finalization | Normalizer accepts `voided`, then skips it before finalization, even if an old candidate was fetched earlier. |
| Legacy admin session/break mutation routes | Return `409 ADMIN_CORRECTION_REQUIRED` for old request bodies; no write occurs. |

Pure guard test:

```ts
test('voided days cannot enter an ordinary mutation path', () => {
  assert.throws(() => assertDayNotVoided({ status: 'voided' }),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_ENTRY_STATE');
  assert.doesNotThrow(() => assertDayNotVoided({ status: 'approved' }));
});
```

- [ ] Implement the guard after each parent-day locked read and before child writes:

```ts
export function assertDayNotVoided(day: { status: TimeEntryStatus } | null): void {
  if (day?.status !== 'voided') return;
  throw Object.assign(new Error('This entry was voided by an admin and cannot be changed here.'), {
    status: 409, code: 'INVALID_ENTRY_STATE'
  });
}
```

`fetchDayByWorkDate` gains an explicit `lock` option used by all three mutation callers (save/submit/break-create); unlocked reads must never lock accidentally. Existing admin decide must select parent `FOR UPDATE` and test completeness under that lock. Existing manual clock code already takes the day lock; retain its order and insert state guards without reworking snap/finalization behavior. Automatic candidate selection excludes voided days, and the locked candidate recheck repeats the exclusion.

For manual creation, preserve the existing unique `(franchiseid,tutorid,work_date)` constraint. If a concurrent admin creates that day, the tutor creation path must refetch/return a conflict rather than overwrite the admin day. All revised writers capture previous state only after obtaining the parent lock.

Replace old admin correction/break handlers after auth/scope validation with this safe contract, until/unless their callers migrate to the new preview contract:

```ts
res.status(409).json({
  code: 'ADMIN_CORRECTION_REQUIRED',
  error: 'Reload the entry to use the correction editor.'
});
```

Update old route tests to verify the new compatibility response, and move their substantive allocation/break regression assertions into the new preview/operation tests. Do not delete meaningful break-placement coverage.

- [ ] Extend time-entry status aliases to the canonical server type, and update scheduler exhaustive validation. Keep time-off/PTO status types unchanged. Extend pending-history `wasEverApproved` SQL to recognize `admin_corrected_approved` and `admin_restored` as approval history.
- [ ] Run focused regression commands:

```powershell
node --test --import tsx server/tests/timeEntryMutationGuard.test.ts server/tests/timeEntryAdminCompatibility.test.ts server/tests/timeEntryTutorSubmissionRoutes.test.ts server/tests/timeEntryAdminBreakRoutes.test.ts server/tests/timeEntryHistoricalReadRoutes.test.ts server/tests/clockRoutes.test.ts server/tests/clockOutFinalization.test.ts server/tests/autoClockOutScheduler.test.ts server/tests/clockSubmission.test.ts
```

Include current clock-snap tests/backfill tests in the final regression pass if they exist on the integration tree. Do not revert them to make this feature's tests pass.

## Task 6: Build the staged correction dialog and client API

**Files:** Create `client/src/lib/adminTimeEntry.ts`, `adminTimeEntryApi.ts`, `client/tests/adminTimeEntryApi.test.ts`, `client/src/pages/admin/time-entry/{TimeEntryCorrectionDialog,TimeEntryHistory,TimeEntryStatusBadge}.tsx`, and colocated `.test.tsx` files. Extend only the time-entry union in `client/src/lib/api.ts`.

**Consumes:** Tasks 1–4 wire contracts and current UI primitives. **Produces:**

```ts
type CorrectionDialogTarget =
  | { action: 'correct'; detail: AdminTimeEntryDetail }
  | { action: 'void' | 'restore'; detail: AdminTimeEntryDetail & { day: AdminEntry } };
type TimeEntryCorrectionDialogProps = {
  target: CorrectionDialogTarget | null;
  onClose: () => void;
  onCommitted: (result: AdminOperationResult) => void;
  onDirtyChange: (dirty: boolean) => void;
};
function TimeEntryCorrectionDialog(props: TimeEntryCorrectionDialogProps): JSX.Element;
function TimeEntryHistory(props: { franchiseId: number; dayId: number }): JSX.Element;
function TimeEntryStatusBadge(props: { status: TimeEntryStatus; inProgress?: boolean }): JSX.Element;
```

`adminTimeEntryApi.ts` exports `listAdminTimeEntryTutors`, `listAdminTimeEntryDays`, `getAdminTimeEntryDetail`, `getAdminTimeEntryHistory`, `previewAdminCorrection`, `previewAdminVoid`, `previewAdminRestore`, `commitAdminTimeEntryOperation`, and `getAdminTimeEntryOperation`, with the corresponding spec request/response DTOs. Use `credentials: 'include'`, JSON content type for POSTs, encoded URL parameters, and the existing `ApiError` convention while preserving `code`/`fieldErrors`. Abort/cancel or generation-guard superseded reads. Do not send preview tokens in query strings.

- [ ] Add behavioral API tests for the exact route/body mapping, effective center, nullable ends, errors, and operation retry body stability.
- [ ] Implement a pure draft reducer in `adminTimeEntry.ts` with states `editing | previewing | reviewing | committing | outcome_unknown | discard_confirmation`. Its actions cover field edit, local add/remove, preview success/failure, save success/failure, and dismissal. Store a draft-generation counter and reject stale preview responses. Changes clear the token and operation ID; retries of an unchanged review retain both.
- [ ] Add UI tests that stage a break and cancel without sending mutations. Use fictional data and mock the network boundary, not the reducer/component:

```tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { TimeEntryCorrectionDialog } from './TimeEntryCorrectionDialog';
import type { AdminTimeEntryDetail } from '../../../lib/adminTimeEntry';

const originalFetch = globalThis.fetch;
afterEach(() => { cleanup(); globalThis.fetch = originalFetch; });
const pendingDetail: AdminTimeEntryDetail = {
  franchiseId: 77,
  tutor: { tutorId: 88, displayName: 'Alex Rivera', active: true, historyOnly: false },
  workDate: '2026-09-15', timezone: 'America/Los_Angeles', revision: 'fixture-revision',
  allowedActions: ['correct'],
  day: {
    id: 44, franchiseId: 77, tutorId: 88, workDate: '2026-09-15',
    timezone: 'America/Los_Angeles', status: 'pending', clockState: 0,
    scheduleSnapshot: null, comparison: null,
    submittedAt: '2026-09-16T01:00:00Z', decidedBy: null,
    decidedAt: null, decisionReason: null,
    createdAt: '2026-09-15T22:00:00Z', updatedAt: '2026-09-16T01:00:00Z',
    sessions: [{ id: 99, startAt: '2026-09-15T22:00:00Z', endAt: '2026-09-16T01:00:00Z',
      sortOrder: 0, createdAt: '2026-09-15T22:00:00Z', updatedAt: '2026-09-16T01:00:00Z' }],
    breaks: [], lastAuditId: 1
  }
};
it('discarding a session and break edit does not commit anything', async () => {
  const requests: string[] = [];
  globalThis.fetch = async input => {
    requests.push(String(input));
    throw new Error('No request is expected while editing or discarding');
  };
  const onClose = vi.fn();
  render(<TimeEntryCorrectionDialog target={{ action: 'correct', detail: pendingDetail }}
    onClose={onClose} onCommitted={vi.fn()} onDirtyChange={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Session 1 end'), { target: { value: '18:15' } });
  fireEvent.click(screen.getByRole('button', { name: 'Add break' }));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
  expect(onClose).toHaveBeenCalledOnce();
  expect(requests).toEqual([]);
});
```

The editor must not fetch history automatically on opening; history loads only when its section is requested, making this test's no-network expectation meaningful.

- [ ] Implement time inputs using `detail.timezone`, not `browserTimeZone`. Use Luxon to convert UTC instants for display and convert local date/time back with minute precision. Compare requested wall time to the resulting wall time to reject a daylight-saving gap. `getPossibleOffsets()` is present in installed Luxon 3; when it returns multiple offsets, present a labeled offset selector and send the explicit selected instant. Preserve separate date/time/offset fields in the draft.
- [ ] Implement Edit/Review inside one controlled existing Dialog, with a local discard-confirmation state. All break/session row changes remain local until final commit. Before/after totals come from server preview. Render copied reason and action effect in review; **Save & approve**, **Void entry**, and **Restore & approve** are the only commit controls. Void initial focus is **Keep entry**. Preserve source/IDs for existing breaks, but prevent client ownership of audit actor/source fields.

Use semantic `bg-card`, `text-foreground`, `text-muted-foreground`, `border-border`, and button variants. Do not add global CSS or alter shared dialog semantics. At small widths, allow the dialog's body to scroll and stack comparison/footers; avoid nested full-screen dialogs.

- [ ] On final confirm generate `crypto.randomUUID()` once and call `commitAdminTimeEntryOperation`. Disable duplicate submission. On an unknown network outcome, retain token/UUID and offer **Check save status** or retry the same operation. A 404 operation lookup alone does not prove an in-flight request failed; a same-operation retry safely resolves it. Render a successful recovered result then refetch current detail.
- [ ] Add tests for all close mechanisms, no network write on preview, live generation changes invalidating preview, missing-day entry, explicit open-end completion, before/after approval effect, void/restore reason and labels, expired/stale response retention, double-click prevention, and operation replay recovery.
- [ ] Run:

```powershell
node --test --import tsx client/tests/adminTimeEntryApi.test.ts
npm run test --prefix client -- src/pages/admin/time-entry/TimeEntryCorrectionDialog.test.tsx src/pages/admin/time-entry/TimeEntryHistory.test.tsx src/pages/admin/time-entry/TimeEntryStatusBadge.test.tsx
```

## Task 7: Integrate management, pending fixes, tutor visibility, and totals

**Files:** Create `client/src/pages/admin/time-entry/TimeEntryManagementPanel.tsx`, its test, and `client/src/pages/admin/ApprovalsPage.test.tsx`. Modify `ApprovalsPage.tsx`, `client/src/pages/tutor/CalendarPage.tsx`, `client/src/components/tutor/ClockWidget.tsx`, `client/src/pages/admin/PayPeriodSummaryPage.tsx`, and the relevant tests. Extend `server/tests/hoursRoutes.test.ts` and add `server/tests/adminTimeEntryPayroll.integration.test.ts`.

**Consumes:** Complete admin reads, shared dialog, status guards, existing pay-period API and approved-only readers. **Produces:** The product flow in the spec on existing routes, without sidebar/theme changes.

Panel interface:

```ts
type TimeEntryManagementPanelProps = {
  franchiseId: number;
  onBackToPending: () => void;
  onSelectEntry: (detail: AdminTimeEntryDetail) => void;
  refreshKey: number;
};
function TimeEntryManagementPanel(props: TimeEntryManagementPanelProps): JSX.Element;
```

The parent Approvals page owns the selected dialog target, dirty state, and pending center/view navigation. Any center/date/tab navigation that would discard an open editor must use the same discard decision before changing scope. Requests carry their initiating center/date/generation; ignore stale responses. Avoid registering a new data-router-only navigation blocker in the existing BrowserRouter app.

- [ ] Write failing UI tests proving the current pending tab still appears first, time-off deep links still work, **Manage time entries** opens the management view, failed exact lookup cannot offer **Add missing time**, and an approved entry offers **Void entry** rather than **Adjust time**.
- [ ] Implement the additive section/URL keys specified in the design. Reuse current franchise handling and `fetchPayPeriodByDate` for date defaults. Use a searchable, labeled tutor control, bounded range inputs, status filter, paginated results, and a separate exact tutor/date lookup to create missing days. Include history-only identities for existing entries.
- [ ] Replace pending “Fix time errors” with the shared correction dialog after fetching fresh complete admin detail. Remove immediate break mutation controls from the old pending review and route those edits through the shared draft editor. Retain the existing pending Approve/Deny controls for complete days.

After commit, increment a local `refreshKey`, reload pending entries and selected management detail, and show the returned operation outcome. If the current status filter excludes the updated row, show that it moved to Approved/Voided rather than treating disappearance as an error. Keep the tutor/date available through the success detail link.

- [ ] Show a time-entry-specific **Voided** label and explanation in tutor Calendar; disable session/break editing and submit for that date. ClockWidget handles `dayStatus: 'voided'` without offering clock actions for that day. Do not change tutor behavior for other statuses or the attestation gate.
- [ ] Add focus-refresh handling to pay-period summary/detail using the selected center/date/tutor and existing request-cancellation conventions; never reinsert a late response for an old selection.
- [ ] Prove payroll inclusion with a real lifecycle test that uses public HTTP reads and a disposable PostgreSQL pool. Fake MSSQL schedule/identity data only. Exercise these before/after checkpoints:

```text
pending 180 recorded min → correction/approval 195 counted min
approved 195 min → void 0 counted min, child rows unchanged
voided day → restore 195 counted min, no duplicate child rows
```

Read weekly, monthly, pay-period tutor totals; admin summary and daily detail; legacy summary/clipboard source; CSV; and Excel after each relevant transition. Assert CRM reported hours are unchanged. Parse CSV output and ExcelJS workbook values rather than testing only that an export endpoint returns 200. Existing helper `fetchApprovedDaysForFranchise` remains approved-only; no new payroll calculation branch is needed.

- [ ] Run:

```powershell
npm run test --prefix client -- src/pages/admin/ApprovalsPage.test.tsx src/pages/admin/time-entry/TimeEntryManagementPanel.test.tsx src/components/tutor/ClockWidget.test.tsx
node --test --import tsx server/tests/hoursRoutes.test.ts server/tests/exportConcurrency.test.ts server/tests/timeEntryHistoricalReadRoutes.test.ts
```

Run `adminTimeEntryPayroll.integration.test.ts` with `RUN_TIME_ENTRY_POSTGRES_TESTS=1` against its disposable database. Include new tutor calendar/pay-period tests in the final UI suite.

## Task 8: Regression, visual verification, and handoff

**Files:** Update `README.md`; create `docs/operations/admin-time-entry-corrections.md`. Fix only defects found in the scoped feature, with fresh impact analysis before editing each existing symbol.

- [ ] Document entry eligibility, staged edits, immediate approval, whole-day void scope, restore, center timezone, read-only preview, duplicate-save recovery, and the export-regeneration limitation. Replace the README's old “fix routes to pending” instructions with the new behavior. List all new routes and the 409 compatibility response on old correction endpoints.
- [ ] Document deployment ordering: additive operation-ID migration; server release with void-aware writers and readers; then the client entry points. Preserve mixed-version safety by keeping correction controls unavailable until the compatible server is active. Once voided records exist, disable new mutations and roll forward if a defect occurs; never restore an older server that can resurrect them.
- [ ] Run the existing required checks after integrating the feature:

```powershell
npm run typecheck
npm test
npm run build
```

Run the three new real-PostgreSQL integration suites with `RUN_TIME_ENTRY_POSTGRES_TESTS=1`. Distinguish skipped Docker/integration checks from passing checks. These commands belong to implementation; none need to run merely to write this plan.

- [ ] Visually verify at desktop and 375px, in both themes, using fictional fixture data and no live writes. Inspect management, missing day, open session, break edit, review, save success, void confirmation, voided history, restore, stale conflict, and unknown-outcome recovery. Check keyboard focus, Enter/Escape, screen-reader labels/live announcements, body scrolling, and sticky footer visibility. Compare actual implementation screenshots to the existing app in the same viewport; this code-grounded spec contains no fabricated reference screenshot.

Product Design requests use the configured in-app browser when available. If a direct Playwright workflow is needed, follow Product Design's browser-choice rules at that point. Browser verification is a future implementation check, not an assertion made by this planning artifact.

- [ ] Review every acceptance case A1–A16 in the spec against test evidence and actual UX. Pay special attention to A4 Cancel, A7/A8 races, A9 retry, and A14 every payroll/export reader.
- [ ] Run `git diff --check`, inspect the diff, and run GitNexus change detection. With a dirty base, separate inherited clock-out changes from this feature's edits in the handoff. Re-run impact if the implementation grew beyond the planned files.

```powershell
git diff --check
git diff --stat
git status --short
node .gitnexus/run.cjs detect-changes --scope all --repo .
```

Partial/truncated graph output is not a clean regression check; investigate via current-index CLI and targeted source/tests before any authorized commit. Do not stage inherited edits or use `git add .` indiscriminately.

## Completion evidence to hand back

The implementation handoff reports the working admin entry point, the exact implemented state/action scope, tests/build results, real integration and visual checks that ran or remain unrun, and any live rollout steps left to an operator. Provide the final diff for review. This planning document alone does not claim the feature is built, tested, deployed, or approved for production.

## Acceptance coverage map

| Spec examples | Implementation tasks | Primary evidence |
| --- | --- | --- |
| A1 missing day, A2 unfinished day | 1–4, 6–7 | Policy, aggregate-read, operation, and management/dialog tests |
| A3 recorded versus counted effect, A12 unavailable schedule | 3–4, 6 | Real allocation preview assertions and before/after UI |
| A4 cancel saves nothing | 6–7 | Network-boundary dialog test and dirty navigation checks |
| A5 void, A6 restore | 3–4, 6–7 | Child-row preservation, original approval preservation, counted totals, and confirmation UI |
| A7 stale clock race, A8 competing creates, A9 retry | 2–5 | Two-connection PostgreSQL tests and operation-outcome recovery UI |
| A10 scope, A15 historical/inactive tutor | 2–4, 7 | Directory, scoped HTTP, and inactive-history tests |
| A11 timezone/DST, A16 stale/tampered preview | 1, 3, 6 | Timestamp normalization, signed-token tests, and offset-choice UI |
| A13 old clients/worker, A14 payroll/export inclusion | 5, 7–8 | Writer matrix plus actual weekly/monthly/pay-period/CSV/Excel regression reads |
