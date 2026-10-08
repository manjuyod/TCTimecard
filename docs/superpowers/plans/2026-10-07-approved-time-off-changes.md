# Approved Time-Off Changes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let tutors propose changes to approved time off while the original approval remains effective, and let authorized admins edit directly; both roles can cancel upcoming approved leave with correct PTO, calendar, notifications, and history.

**Architecture:** Keep the effective request in `time_off_requests` and store proposed amendments separately. Commit effective edits, operation receipts, audit, PTO deltas, and delivery jobs in one PostgreSQL transaction; an ordered worker synchronizes Google Calendar and sends notifications afterward. Extend the existing tutor Time Off and admin Approvals screens with shared editing/comparison components.

**Tech Stack:** Existing TypeScript, React 18, Express, PostgreSQL/pg, Luxon, Google authentication client, node:test, Vitest/Testing Library, and disposable PostgreSQL 17 integration-test containers. No new package dependencies.

**Spec:** [Approved time-off changes: product and technical spec](../specs/2026-10-07-approved-time-off-changes-design.md). Read the full spec before executing a task.

**Status:** Implemented on branch `feature/approved-time-off-changes` (inline execution, Tasks 1–9). Verified locally: `npm run typecheck`, `npm test`, `npm run build`, the five approved-time-off PostgreSQL suites and the three legacy PTO PostgreSQL suites (Docker), plus a browser pass against a disposable local harness with in-memory calendar/email providers. Not deployed; migration 0016 has not been applied to any shared database.

## Global Constraints

- Tutor changes require admin approval. The original approval, dates, calendar event, and PTO charge remain effective while a proposal is pending.
- Admin changes take effect directly and remain approved.
- Version one permits changes and cancellation only before the current leave starts. Both the current and proposed start instants must be strictly later than the server's current instant.
- Only one pending amendment per request. A tutor withdraws an amendment before proposing another.
- Editable fields are start/end dates, partial-day times, absence type, and request reason. Tutor, franchise, requester identity, source, and creation history are immutable.
- Require an explicit `changeReason` of 10–2000 trimmed characters for proposals, direct edits, and approved cancellation. Keep the request reason at 10–2000 characters. Denial reasons are 1–2000 characters.
- Normalize all proposed dates in the franchise timezone; retain inclusive input end dates and exclusive persisted full-day ends. Preserve the existing 336-hour maximum.
- An amendment does not reserve additional days. Validate `available + old >= new` independently for each cycle.
- Preserve request/allocation IDs and the append-only ledger. Never grant a refund based solely on dates or a fresh quote.
- No network call is part of the business transaction. PostgreSQL is authoritative.
- Expose request versions as decimal strings in JSON; keep database BIGINT precision.
- Use the existing React, Express, PostgreSQL, Luxon, and Google authentication stack. Add no package dependencies.
- Add `TIME_OFF_CHANGES_ENABLED` (default false) to gate new reads/writes/UI capabilities while deploying; the delivery worker remains able to drain already-committed jobs when the flag is turned off.

Follow-up scope approved 2026-10-07: admins may directly edit or cancel past/ongoing approved requests. Tutors and amendment decisions remain upcoming-only. Retrospective edits use the existing per-cycle preview/reconciliation; cancellation means leave was not taken and refunds only recorded consumption to its original cycle. Self-edit, center scope, duration, overlap and sufficiency checks remain. Clocked hours are unaffected. No additional migration is needed. Regression coverage extends Tasks 3/4/5/8 with historical and ongoing corrections, expired proposal refusal, previous-cycle refunds, untracked PTO, tutor/scope/self-edit denials and calendar delivery.

## Review Focus

1. An unchanged/reduced request inside the notice window remains editable, but added non-exempt leave cannot bypass notice; waiting for approval does not restart that window. Pin in Task 3.
2. A paid request may predate tracking, have zero charge, or belong to a now-disabled/changed profile; refund actual recorded consumption without moving money to a different person. Pin in Task 2.
3. Full-day/timed conversion across DST and browser/center timezone differences preserves local intent and clears incompatible Google fields. Pin in Tasks 3, 5, and 7.
4. Provider success followed by process death, a newer cancellation, or a second app instance must converge without resurrecting leave or duplicating PTO. Pin in Tasks 4 and 5.
5. A center switch or stale tab must not expose/save another center's detail, approve the wrong amendment, or discard an unsaved draft silently. Pin in Tasks 6–8.

## Execution preparation and graph gates

Work from the inspected `TCTimecard` repository; planning baseline is `b92b266c00368d0563f5dfaeb628adab8acdb8ac`. Follow the worktree skill at implementation time if isolation is needed. Check the current branch, changes, migration numbers, and index freshness before starting; do not discard unrelated changes.

For each existing function/file being changed, run GitNexus upstream impact first and report callers/processes/risk. HIGH/CRITICAL warnings must be communicated. UNKNOWN SQL impact requires confirming trigger/function references in source. The spec records the initial risk findings, including HIGH for `appendTimeOffAudit`; keep that helper's behavior unchanged. Do not treat this planning analysis as permanent authorization for a later, changed checkout.

Before every task commit, stage only its intended files and run:

```powershell
node .gitnexus/run.cjs detect-changes --scope all --repo .
git diff --cached --check
```

Re-run incomplete/truncated graph checks. Verify the correct checkout. SQL functions need PostgreSQL tests regardless of a small graph count. Use the next free migration number if `0016` has been taken; update references in the tests/spec/plan together.

## File map and responsibility boundaries

| Files | Responsibility |
| --- | --- |
| `server/db/migrations/0016_approved_time_off_changes.sql` | Additive workflow schema; guarded approved changes, ledger reconciliation, versioning, and lock compatibility |
| `server/types/timeOffChanges.ts` | New commands, previews, detail/list/receipt/delivery DTOs; no changes to existing status meanings |
| `server/services/timeOffChangeRepository.ts` | SQL reads, operation idempotency, amendment/history/delivery persistence |
| `server/services/timeOffChangePolicy.ts` | Existing-request-aware validation, allowed actions, notice and deadline rules |
| `server/services/pto/timeOffChanges.ts` | Replacement PTO quote/reconciliation adapters; current source eligibility/provenance |
| `server/services/timeOffChanges.ts` | Authorized transactional lifecycle and expiry orchestration |
| `server/services/timeOffChangeDelivery.ts` | Ordered durable job dispatch and retry/worker lifecycle |
| `server/services/timeOffChangeEmail.ts` | Operation-snapshot email rendering and recipient selection |
| `server/services/googleCalendar.ts` | Preserve insert/get; add typed patch/delete/access-probe transport |
| `server/routes/timeOffChanges.ts` | Scoped management/preview/command/delivery endpoints |
| `server/config/timeOffChanges.ts`, `server/index.ts` | Feature gate, router ordering, worker start/drain |
| `server/services/timeOffSchema.ts` | Readiness check for new tables/columns |
| `server/services/pto/routeStore.ts`, `server/services/pto/postgresStore.ts` | Net used-PTO display after releases; adjustment-writer lock compatibility |
| `client/src/lib/timeOffChanges.ts`, `client/src/lib/timeOffChangesApi.ts` | DTOs, client form adapters, API calls with stable idempotency keys |
| `client/src/components/time-off/*` | Shared draft editor, before/after comparison, history and delivery status |
| `client/src/pages/tutor/TimeOffPage.tsx` | Owner proposal/withdraw/cancel interaction |
| `client/src/pages/admin/time-off/*`, `client/src/pages/admin/ApprovalsPage.tsx` | Amendment review and management without expanding the large page with all new internals |
| `client/src/lib/timeOff.ts` | Additive deep-link parsing that preserves original links |
| `docs/operations/approved-time-off-changes.md` | Enablement, monitoring, retry/repair, and rollback runbook |

Add tests beside each new responsibility using the concrete paths below. Do not turn this into a general PTO/UI rewrite.

### Task 1: Introduce workflow storage, contracts, and idempotent reads

**Files:** Create migration `0016_approved_time_off_changes.sql`, `server/types/timeOffChanges.ts`, `server/services/timeOffChangeRepository.ts`, `server/tests/timeOffChangeRepository.test.ts`, `server/tests/timeOffChangesMigration.integration.test.ts`; modify `server/services/timeOffSchema.ts`, `server/tests/timeOffSchema.test.ts`.

**Interfaces:** Define the following in `server/types/timeOffChanges.ts`:

```ts
type TimeOffChangeActor = { kind: 'TUTOR' | 'ADMIN'; accountId: number; franchiseId: number };
type AmendmentStatus = 'pending' | 'approved' | 'denied' | 'withdrawn' | 'superseded' | 'expired';
type CommandMeta = { actor: TimeOffChangeActor; requestId: number; expectedVersion: string; idempotencyKey: string; nowIso: string };
type TimeOffChangeCommand = CommandMeta & (
  | { action: 'propose' | 'admin_edit'; proposed: TimeOffSubmissionInput; changeReason: string }
  | { action: 'withdraw'; amendmentId: string }
  | { action: 'approve_amendment'; amendmentId: string }
  | { action: 'deny_amendment'; amendmentId: string; reason: string }
  | { action: 'cancel'; changeReason: string }
);
type TimeOffChangeReceipt = {
  operationId: string; requestId: number; version: string; amendmentId: string | null;
  outcome: 'proposed' | 'withdrawn' | 'approved' | 'denied' | 'edited' | 'cancelled' | 'expired';
  deliveryIds: string[];
};
```

Also define `TimeOffAmendment` (spec columns mapped to camelCase, normalized proposed value and timezone), `TimeOffChangeHistoryEntry` (operation ID/action/actor/time/reason/before/after), `TimeOffChangeDelivery` (ID/channel/kind/status/attempts/next attempt/sanitized error/target version), `TimeOffChangeDetail` (`request: TimeOffRecord`, `version`, `timezone`, `pendingAmendment`, `history`, `deliveries`, `allowedActions`), and `TimeOffChangePage<T>` (`items`, `nextCursor`). Allowed actions are the six command action names; the UI derives buttons from those, not role guesses. Add `changesEnabled` as an optional additive field on the existing `TimeOffPolicy` DTO in server and client in Task 6.

Repository public methods use `PoolClient` for mutations; export `lockTimeOffChangeRequest(client, requestId, timezone): Promise<{request: TimeOffRecord; version: string} | null>`, `readTimeOffChangeDetail(client, requestId, timezone): Promise<TimeOffChangeDetail | null>`, `findTimeOffChangeReplay(client, actor, key, inputHash): Promise<TimeOffChangeReceipt | null>`, and `persistTimeOffChangeOperation(client, operation): Promise<TimeOffChangeReceipt>`. Define the typed operation persistence input here with the schema's exact fields. Authorization is performed by the service before returning these reads.

- [ ] **Write migration/repository tests:** `one pending amendment per request` rejects the second insert; `version remains precise` returns `'9007199254740993'`; `same actor key replays` returns the exact saved receipt; changed-payload reuse yields `TIME_OFF_IDEMPOTENCY_MISMATCH`; the same key in another actor/franchise scope does not match. Assert `assert.deepEqual(replay, firstReceipt)` and `assert.equal(detail.version, '9007199254740993')`.
- [ ] **Run red checks:** `node --test --import tsx server/tests/timeOffChangeRepository.test.ts`; `npx cross-env RUN_PTO_POSTGRES_TESTS=1 node --test --import tsx server/tests/timeOffChangesMigration.integration.test.ts`. Expected failure is missing new contracts/schema, not a Docker or fixture failure.
- [ ] **Implement schema and repository:** Add spec tables, foreign keys/indexes/checks, frozen normalized amendment fields, operation response snapshots, and due-delivery fields. Guard terminal amendment immutability. Add request version/calendar ID columns without fabricating existing calendar IDs. Implement actor-scoped replay with normalized input hashes; command action/request/version are part of the hash, server receipt time is not. Concurrent key insertion uses the unique index plus fetch/recheck, not an unguarded check-then-insert.
- [ ] **Build disposable integration fixtures:** Follow `ptoRouteMigration.integration.test.ts` to create the existing prerequisite time-off tables and apply the production migration chain through 0016 in order. Use two separate `pg` clients for races. Never use a developer/production connection string; test containers bind localhost only.
- [ ] **Run green checks:** Repeat both commands plus `node --test --import tsx server/tests/timeOffSchema.test.ts`; expect passing assertions and a non-skipped database suite. Run `npm run typecheck` after introducing DTOs.
- [ ] **Graph-check and commit:** `feat: add approved time-off change storage and contracts`.

### Task 2: Implement replacement PTO accounting and guarded database transitions

**Files:** Extend `0016_approved_time_off_changes.sql`; create `server/services/pto/timeOffChanges.ts`, `server/tests/ptoTimeOffChanges.test.ts`, `server/tests/ptoTimeOffChanges.integration.test.ts`; modify `server/services/pto/routeStore.ts`, `server/services/pto/postgresStore.ts` (`adjustBalance` lock compatibility), `server/tests/ptoRouteStore.test.ts`. Replace necessary deployed SQL functions in 0016, never their older migration files.

**Interfaces:** Define `TimeOffReplacementQuote = { eligible: boolean; reason: string; tracked: boolean; cycles: Array<{cycleStart: string; oldDays: number; newDays: number; availableDays: number; availableAfter: number}>; warnings: string[] }`. Export `quoteApprovedTimeOffChange(client: PoolClient, requestId: number, proposed: NormalizedTimeOffSubmission): Promise<TimeOffReplacementQuote>` and `applyApprovedTimeOffChange(client: PoolClient, operationId: string): Promise<void>`. The latter calls `time_off_apply_approved_change(UUID) RETURNS BIGINT`, whose returned version is read by the service. Define SQL preview/reconcile signatures exactly as in the spec; use normalized camelCase JSON target fields.

- [ ] **Write accounting tests:** Seed a five-day cycle with a two-day approved request: `availableDays = 3`. Replacement with three days succeeds with available 2; replacement with one day returns available 4; cancellation then returns available 5 and used 0. Assert that these operations retain the parent ID and all earlier ledger rows. Paid → unpaid refunds two days; unpaid → paid consumes only the new quote. Assert `assert.equal(balance.usedDays, 0)` after final cancellation.
- [ ] **Add boundary/concurrency tests:** A cross-cycle move cannot spend the old cycle's credit in the new cycle; two concurrent center requests cannot exceed one shared balance; competing edit/cancel applies one valid version only; repeated operation ID makes zero extra ledger entries. Cover Saturdays, Sundays, <=4-hour partial leave, non-January policy renewal, profile merge/unlink, inactive centers, immutable identity, missing provenance, and positive-charge untracked legacy leave versus legitimate zero-charge/no-allocation leave.
- [ ] **Run red checks:** `node --test --import tsx server/tests/ptoTimeOffChanges.test.ts`; `npx cross-env RUN_PTO_POSTGRES_TESTS=1 node --test --import tsx server/tests/ptoTimeOffChanges.integration.test.ts`. Expect missing accounting functions or failing accounting assertions.
- [ ] **Implement the guarded transition:** Validate the stored operation and target against the locked request/version. Allow approved field writes only when the operation matches; run the reconcile trigger for those writes. Preserve all initial pending lifecycle behavior and ensure new approved cancellation never also calls the legacy refund. Reprice each cycle using actual old consumption, append `consume`/`release` deltas with operation/allocation-specific keys and `reserved_delta = 0`, and retain provenance. Update allocation state without deleting rows or violating positive charged-days constraints.
- [ ] **Unify lock ordering in the new migration:** Cover `pto_reserve_request`, `pto_transition_request`, approved reconciliation, `pto_admin_decide_alias`, `pto_admin_detach_membership`, `pto_admin_link_account`, `pto_admin_unlink_account`, and adjustment writers discovered through graph/source references. Apply the spec's policy/profile/allocation order in their actual entry paths, including nested calls; do not acquire the policy lock after holding a profile lock. Test new edits versus ordinary reservations/decisions and profile changes with real concurrent clients. Preserve existing business rules and retry at most three whole transactions for SQLSTATE 40P01/40001.
- [ ] **Fix net used-day reads:** Include consume and release balance deltas in `balanceSummary.usedDays`; keep reserve/release reserved deltas and manual adjustments separate. Quotes use database cycle policies and credit only the selected request's active consumption. Untracked legacy cancellation returns a warning and no fabricated refund.
- [ ] **Run green/regression checks:** Repeat Task 2 tests; run `node --test --import tsx server/tests/ptoRouteStore.test.ts server/tests/ptoCharge.test.ts` and `npx cross-env RUN_PTO_POSTGRES_TESTS=1 node --test --import tsx server/tests/ptoMigration.integration.test.ts server/tests/ptoAdminMigration.integration.test.ts server/tests/ptoRouteMigration.integration.test.ts`. Extend the new migration harness to exercise the latest replacements; old-migration tests alone are not proof the new chain works.
- [ ] **Graph-check and commit:** `feat: reconcile PTO for approved time-off changes`.

### Task 3: Define amendment policy, actions, and expiration

**Files:** Create `server/services/timeOffChangePolicy.ts`, `server/tests/timeOffChangePolicy.test.ts`. Read/reuse `server/services/timeOffPolicy.ts` and `server/services/ptoCharge.ts`; change shared normalizers only after impact and with their existing tests.

**Interfaces:** Export `validateApprovedTimeOffChange(input: { request: TimeOffRecord; proposed: TimeOffSubmissionInput; actor: TimeOffChangeActor; timezone: string; noticeRequired: boolean; nowIso: string; submittedAt?: string }): TimeOffValidationResult` and `getTimeOffChangeActions(input: { actor: TimeOffChangeActor; request: TimeOffRecord; amendment: TimeOffAmendment | null; nowIso: string }): TimeOffChangeCommand['action'][]`. Reuse `TimeOffValidationResult` from `timeOffPolicy.ts`. Export `amendmentExpiresAt(request: TimeOffRecord, proposed: NormalizedTimeOffSubmission): string` as the earlier start instant. Keep denial and withdrawal checks separate from proposal-field validation.

- [ ] **Write policy tests with a frozen clock:** Future-only commit checks for both roles, no-op rejection, current interval excluded from overlap checks, own-admin edit/approval denied but owner cancellation permitted. Test a reduction inside 14 days succeeds; newly covered non-exempt dates inside 14 days fail; Emergency succeeds; approval uses submission time for notice but current time for start expiry. Assert `assert.equal(reduction.valid, true)` and `assert.equal(tooSoonExpansion.valid, false)`.
- [ ] **Write timezone/input tests:** `America/Los_Angeles` full-day input `2026-11-01` maps to `2026-11-01T07:00:00.000Z` through exclusive end `2026-11-02T08:00:00.000Z` (25 hours). Reject nonexistent local times on spring-forward transitions. Ambiguous `2026-11-01 01:30` resolves to the earlier occurrence, `2026-11-01T08:30:00.000Z` (UTC-07:00), with that offset visible in preview. Cover reason lengths 9/10/2000/2001 and the 336-hour maximum. Add the resolved start/end offsets to the preview DTO so both clients display the server's choice.
- [ ] **Run red:** `node --test --import tsx server/tests/timeOffChangePolicy.test.ts`.
- [ ] **Implement the policy adapter:** Reuse type/range normalization with notice enforcement off internally, then apply existing-request notice semantics. Compare normalized values for no-op detection. Derive actions on the server, ensuring terminal or expired amendments cannot be approved. Keep all security checks authoritative at service commit, not just in returned actions.
- [ ] **Run green:** `node --test --import tsx server/tests/timeOffChangePolicy.test.ts server/tests/timeOffPolicy.test.ts`.
- [ ] **Graph-check and commit:** `feat: validate approved time-off amendments`.

### Task 4: Add transactional amendment and cancellation services

**Files:** Create `server/services/timeOffChanges.ts`, `server/tests/timeOffChanges.test.ts`, `server/tests/timeOffChanges.integration.test.ts`; extend `server/services/timeOffChangeRepository.ts`. Modify initial-decision persistence only as required for version/calendar ID capture in `server/services/timeOffRepository.ts`, `server/services/timeOffDecision.ts`, with `server/tests/timeOffDecisionPersistence.test.ts` and `server/tests/timeOffDecision.test.ts`.

**Interfaces:** Export `createTimeOffChangeService(deps: TimeOffChangeDeps)` with methods `execute(command: TimeOffChangeCommand): Promise<TimeOffChangeReceipt>`, `preview(input: {actor: TimeOffChangeActor; requestId: number; proposed: TimeOffSubmissionInput; nowIso: string}): Promise<TimeOffChangePreview>`, `detail(actor: TimeOffChangeActor, requestId: number, nowIso: string): Promise<TimeOffChangeDetail>`, and `expire(nowIso: string, limit?: number): Promise<number>`. Default expiry limit is 100 per pass. Define dependencies for `Pool`, timezone/notice/contact resolution, and an optional delivery wake callback; default to existing production adapters and inject fakes in unit tests. Define `TimeOffChangePreview = {version: string; normalized: NormalizedTimeOffSubmission; resolvedOffsets: {start: string; end: string}; pto: TimeOffReplacementQuote | null; warnings: string[]}` in the new DTO module; offset values use `-07:00` format.

- [ ] **Write lifecycle tests:** Submit/withdraw/deny/expire leaves effective fields, PTO, and event unchanged. Approve swaps fields exactly once and retains parent status approved. Admin edit/cancel closes a pending proposal as superseded. Assert `assert.equal(after.request.status, 'approved')` for a proposal and `assert.deepEqual(effectiveAfter, effectiveBefore)`; assert one version increment, audit, and operation receipt per success. Failed validation/balance/audit insert leaves no partial writes/jobs.
- [ ] **Write race/idempotency tests:** Same key/same body returns the same receipt; same key/changed body conflicts; two admin decisions at one version produce one success and one conflict. Race proposal versus direct edit, cancellation versus approval, expiry versus approval, and replay after request visibility is revoked. Include stale `amendmentId` and admin self-approval.
- [ ] **Run red:** `node --test --import tsx server/tests/timeOffChanges.test.ts`; `npx cross-env RUN_PTO_POSTGRES_TESTS=1 node --test --import tsx server/tests/timeOffChanges.integration.test.ts`.
- [ ] **Implement commands:** Use parent row locking, expected versions, the one-pending constraint, the policy adapter and Task 2 database apply function. Freeze proposal timezone; reject approval if the center timezone has changed since proposal until it is reviewed/resubmitted. Preserve original approval metadata for edits. Persist immutable operation receipts and delivery jobs with the audit using the existing `appendTimeOffAudit` interface. No provider calls before commit.
- [ ] **Implement expiry and initial-decision compatibility:** Expire at the earlier start under the parent lock, audit once, increment once, and queue a center notification. Reads make expired proposals non-actionable before persistence catches up. Capture the exact calendar ID on successful new initial approvals and increment version on existing first decisions/pending cancellation; leave original token validation and pending-only actions intact.
- [ ] **Run green/regression:** Repeat Task 4 tests plus `node --test --import tsx server/tests/timeOffDecisionPersistence.test.ts server/tests/timeOffDecision.test.ts server/tests/timeOffEmailDecision.test.ts server/tests/timeOffRoutes.test.ts`. Expect old pending/token behavior unchanged and new races deterministic.
- [ ] **Graph-check and commit:** `feat: add approved time-off amendment lifecycle`.

### Task 5: Deliver calendar changes and notifications durably

**Files:** Create `server/services/timeOffChangeDelivery.ts`, `server/services/timeOffChangeEmail.ts`, `server/tests/timeOffChangeDelivery.test.ts`, `server/tests/timeOffChangeDelivery.integration.test.ts`, `server/tests/timeOffChangeEmail.test.ts`; modify `server/services/googleCalendar.ts`, `server/tests/googleCalendarTimeOff.test.ts`, and delivery repository methods. Reuse email sending from `server/services/timeOffEmail.ts`.

**Interfaces:** Extend `CalendarClient` with `patchEvent(calendarId: string, eventId: string, patch: Record<string, unknown>): Promise<Record<string, unknown>>`, `deleteEvent(calendarId: string, eventId: string): Promise<void>`, and `assertCalendarAccess(calendarId: string): Promise<void>`. Access probing must succeed using the existing calendar.events scope (a harmless minimal events-list request is suitable); do not require broader scopes. Export `runTimeOffChangeDeliveryPass(deps: TimeOffChangeDeliveryDeps, nowIso: string): Promise<{sent: number; failed: number; superseded: number}>` and `startTimeOffChangeWorker(deps): {wake(): void; stop(): Promise<void>}`. Define dependencies with injected clock/provider/timer and database access. Export `buildTimeOffChangeEmails(operationSnapshot, center, appOrigin): TimeOffChangeEmailJob[]`; each typed job has frozen recipient, impersonation subject, subject/text/html, operation ID and deduplication key.

- [ ] **Write calendar tests:** Patches preserve unrelated fields and explicitly clear date/dateTime when switching formats; delete accepts an empty success body; owned 410 is converged; 404 requires a successful access probe; wrong ownership fails without mutation. Recovery insert reuses a persisted deterministic ID and verifies both ownership and desired content on 409. Assert `assert.equal(insertCallsForSameRecoveryId, 1)` for a clean retry and no unauthorized patch/delete calls.
- [ ] **Write crash/order tests:** Simulate remote success followed by a DB rollback/crash, then replay; ensure only one effective event and no changed ledger. Two workers cannot process the same parent concurrently. An older edit never runs after a newer cancellation. Cancellation deletes any recovery ID from an uncertain earlier attempt. An unrelated proposal version increment does not cause the latest valid calendar job to be discarded.
- [ ] **Write delivery/email tests:** Freeze every recipient/snapshot, show old/new dates, use authenticated amendment links, and never send old original approval tokens. Combined admin edit/cancel sends one requester message even when superseding a proposal. Verify retry delays 30s/2m/10m/1h/6h, failure after attempt six, manual retry of the same job, rejection of superseded retries, bounded worker shutdown, and expiry pass execution. Test at most one active pass and one worker client, with 20 deliveries/100 expirations per pass.
- [ ] **Run red:** `node --test --import tsx server/tests/timeOffChangeDelivery.test.ts server/tests/timeOffChangeEmail.test.ts`; `npx cross-env RUN_PTO_POSTGRES_TESTS=1 node --test --import tsx server/tests/timeOffChangeDelivery.integration.test.ts`.
- [ ] **Implement provider adapters and worker:** Set per-request 10-second timeouts, preserve known calendar identity, and verify ownership. Assign recovery IDs during Task 4's job enqueue transaction so they survive a later failed attempt transaction; use those precommitted IDs for inserts and cancellation cleanup. Under the request lock choose the newest effective calendar job and supersede older jobs; hold this lock through the bounded attempt/commit. Email delivery uses its own row lock to avoid concurrent sends, without claiming provider exactly-once semantics. Sanitize errors, keep business state unchanged, and expose retryable failures. Use the spec's worker timing and shutdown limits.
- [ ] **Run green/regression:** Repeat Task 5 tests plus `node --test --import tsx server/tests/googleCalendarTimeOff.test.ts server/tests/timeOffEmail.test.ts server/tests/timeOffWorkflow.test.ts`. Use fake providers; this test phase sends no live emails or calendar mutations.
- [ ] **Graph-check and commit:** `feat: synchronize approved time-off changes with retries`.

### Task 6: Expose scoped APIs, management reads, and feature gating

**Files:** Create `server/routes/timeOffChanges.ts`, `server/config/timeOffChanges.ts`, `server/tests/timeOffChangeRoutes.test.ts`; modify `server/index.ts`, `server/routes/timeoff.ts` (additive policy capability only), `server/types/timeoff.ts`; extend repository list/history/delivery reads. Update API readiness tests as needed.

**Interfaces:** Export `createTimeOffChangesRouter(overrides?: Partial<TimeOffChangeRouteDeps>): Router`, injected with the Task 4 service and scoped list/retry adapters. Implement every endpoint in the spec API table with those exact bodies. Export `isTimeOffChangesEnabled(env: Record<string, string | undefined>): boolean`, true only for the string `true`. The existing policy adds `changesEnabled?: boolean`; false/absent hides the UI. The admin capability endpoint always returns `{enabled}` after authentication/scope checks; other disabled new endpoints return 404 with code `TIME_OFF_CHANGES_DISABLED`.

- [ ] **Write route tests:** All spec paths require auth and enforce their role/scope; body-supplied actor/franchise cannot override session identity. Tutor cannot read/change another center's request even when sharing PTO. Public/bridge requests are admin-only. Self-edit/approval returns 403; an owner cancellation succeeds. Invalid decimal versions, IDs, reason lengths, enum values, and conflicting keys return the documented codes. Assert `assert.equal(response.status, 403)` and zero service/provider writes for forbidden requests.
- [ ] **Write read/gate tests:** Initial policy endpoints remain backward compatible with the new optional flag. Default flag is off; old approval/cancel paths still work; worker draining does not depend on the flag. Verify route precedence before `/timeoff/admin/:id`, server filters, date overlap in center timezone, 50/200 pagination, stable cursors, scope-safe history, and stale-cursor validation when filters change.
- [ ] **Run red:** `node --test --import tsx server/tests/timeOffChangeRoutes.test.ts`.
- [ ] **Implement routes and list methods:** Derive actors from session, reuse franchise scoping, normalize input, expose allowed actions, and map exact domain error codes. Add query limits/cursor validation and join each delivery to its parent before retrying. Prevent detail/error leaks outside scope. Keep new delivery retry separate from legacy notification retry.
- [ ] **Wire startup/shutdown:** Mount the new router before existing time-off routes, start the worker with its injected dependencies, and await `stop()` before pool shutdown. Provide a configuration/readiness failure when enabled with missing schema; the worker should not crash startup during a pre-migration disabled rollout. If delivery tables exist, it drains pending jobs even while new operations are disabled.
- [ ] **Run green:** `node --test --import tsx server/tests/timeOffChangeRoutes.test.ts server/tests/timeOffRoutes.test.ts server/tests/timeOffEmailDecision.test.ts`; `npm run typecheck`.
- [ ] **Graph-check and commit:** `feat: expose scoped time-off change APIs`.

### Task 7: Add shared editing components and tutor change actions

**Files:** Create `client/src/lib/timeOffChanges.ts`, `client/src/lib/timeOffChangesApi.ts`, `client/src/components/time-off/TimeOffChangeEditor.tsx`, `TimeOffChangeComparison.tsx`, `TimeOffChangeHistory.tsx`, `TimeOffDeliveryStatus.tsx` in that component directory, and `TimeOffChangeEditor.test.tsx`; modify `client/src/pages/tutor/TimeOffPage.tsx`, `TimeOffPage.test.tsx`, and `client/src/lib/api.ts` only for the additive policy capability/API transport export if needed.

**Interfaces:** Mirror Task 1/4 DTOs in the client module. Export `fetchTutorTimeOffChangeDetail(id)`, `previewTutorTimeOffChange(id, proposed)`, `submitTimeOffAmendment(id, body)`, `withdrawTimeOffAmendment(id, amendmentId, body)`, and `cancelApprovedTimeOff(id, body)` with spec paths and typed promise results. Reuse the existing credentialed `apiFetch`; do not create an inconsistent fetch wrapper. `TimeOffChangeEditor` takes `{detail, mode: 'tutor'|'admin', preview: (draft) => Promise<TimeOffChangePreview>, onSave: (draft, changeReason) => Promise<void>, onCancel: () => void, busy: boolean}`. Define its draft as the existing `TimeOffFormValue` and normalize empty times only at the API boundary.

- [ ] **Write tutor/editor tests:** Flag off retains existing UI. Upcoming approved card exposes Request change/Cancel; pending original requests retain their old Cancel action. Prefill uses franchise-local source values, including Emergency and full-day exclusive ends. Submit displays exact original-remains-effective copy and does not overwrite the approved card. A pending proposal exposes Withdraw; cancellation warns about closing it. Assert `expect(screen.getByText('Change pending')).toBeInTheDocument()` while the original date range remains visible.
- [ ] **Write failure/accessibility tests:** Stale detail refresh does not auto-resubmit; validation/network failure preserves drafts; editing any field invalidates the old preview. Preview shows delta per cycle and no guarantee of reservation. Disable duplicate submits, retain one idempotency key across a network retry of the same command, and create a new key when the user changes the command. Check keyboard focus, labels, dirty-dismiss confirmation, server-started/read-only reasons, and no browser-timezone conversion.
- [ ] **Run red:** `npm run test --prefix client -- src/pages/tutor/TimeOffPage.test.tsx src/components/time-off/TimeOffChangeEditor.test.tsx`.
- [ ] **Implement shared components and tutor wiring:** Use server allowed actions, controlled drafts, preview comparison, required change reason, explicit confirmation, history/delivery status, and existing semantic UI components. Show pending sync separately from business success. Refetch detail, requests, and PTO policy/balance after mutations; retain the current form behavior for new ordinary requests.
- [ ] **Run green:** Repeat Task 7 tests; run `npm run typecheck`. Check narrow-screen comparison layout and focus return when a dialog closes.
- [ ] **Graph-check and commit:** `feat: let tutors amend and cancel approved time off`.

### Task 8: Add admin amendment review and approved-request management

**Files:** Create `client/src/pages/admin/time-off/TimeOffManagement.tsx`, `TimeOffAmendmentReview.tsx`, `TimeOffManagement.test.tsx`; modify `client/src/pages/admin/ApprovalsPage.tsx`, `ApprovalsPage.test.tsx`, `client/src/lib/timeOffChangesApi.ts`, `client/src/lib/timeOff.ts`, and `client/tests/timeOff.test.ts`.

**Interfaces:** Export client functions `fetchAdminTimeOffChangeCapabilities(franchiseId): Promise<{enabled: boolean}>`, `fetchAdminTimeOffRequests(query)`, `fetchAdminTimeOffAmendments(query)`, `fetchAdminTimeOffChangeDetail(franchiseId, id)`, `previewAdminTimeOffChange(franchiseId, id, proposed)`, `decideTimeOffAmendment(franchiseId, id, amendmentId, body)`, `editApprovedTimeOff(franchiseId, id, body)`, `cancelAdminApprovedTimeOff(franchiseId, id, body)`, `fetchTimeOffChangeDeliveries(query)`, and `retryTimeOffChangeDelivery(franchiseId, deliveryId)`. Query types contain the spec filters/cursor/limit; use string versions consistently. `TimeOffManagement` takes `{franchiseId: number; requestId?: number; amendmentId?: string; onChanged: () => void}`; use the shared editor/history/delivery components from Task 7.

- [ ] **Write admin tests:** Pending inbox remains available alongside Change requests/Manage time off. Review shows both versions and per-cycle PTO deltas. Approve/deny amendment calls the new endpoint, not the initial decision endpoint. Direct edit remains approved; cancellation closes/supersedes proposals with the exact warning. Search/filter/pagination finds approved and historical requests; historical records are view-only. Delivery retry never repeats the business command.
- [ ] **Write stale-center/navigation tests:** Switch franchises with an in-flight detail/preview/list request and assert no stale response is rendered or savable. Deep links target the intended request/amendment after login and browser navigation; existing time-entry and original time-off links remain valid. Unauthorized self-edit buttons are absent. Stale version errors preserve the draft for comparison and require a fresh confirmation.
- [ ] **Run red:** `npm run test --prefix client -- src/pages/admin/ApprovalsPage.test.tsx src/pages/admin/time-off/TimeOffManagement.test.tsx`.
- [ ] **Implement management and review:** Keep orchestration in the new admin time-off files, leaving ApprovalsPage as a host. Default to upcoming approved requests, reset cursors on filters, abort or ignore old generation responses, and render explicit busy/empty/error states. Preserve unrelated URL parameters and feature-gated visibility. Refetch inbox/count/detail after each operation.
- [ ] **Run green:** Repeat Task 8 tests; run `npm run test:client-helpers` and `npm run typecheck`. Verify mobile/keyboard flows and a center switch with a dirty draft.
- [ ] **Graph-check and commit:** `feat: manage approved time off and amendment reviews`.

### Task 9: Verify the full lifecycle and document rollout/recovery

**Files:** Extend `server/tests/timeOffChanges.integration.test.ts`, `server/tests/timeOffChangeDelivery.integration.test.ts`, and the tutor/admin UI tests as needed; create `docs/operations/approved-time-off-changes.md`. Update spec/plan status only to match actual verification.

**Interfaces:** No new business interfaces. Deliver a tested feature and an operational runbook for `TIME_OFF_CHANGES_ENABLED`, pending/failed jobs, manual retry, legacy-calendar repair, schema readiness, and rollback without dropping history.

- [ ] **Add end-to-end integration assertions:** Ordinary submission/initial approval → tutor proposal → denial → new proposal → approval → admin edit → cancellation. Assert original dates remain during pending review; final parent cancelled, no pending amendment, no active owned calendar event after delivery, original ledger/audit retained, and full actual consumption released. Repeat final commands with their original keys and assert unchanged ledger/job counts. Run provider failure/restart and two-worker variants.
- [ ] **Run focused database verification with Docker enabled:** `npx cross-env RUN_PTO_POSTGRES_TESTS=1 node --test --import tsx server/tests/timeOffChangesMigration.integration.test.ts server/tests/ptoTimeOffChanges.integration.test.ts server/tests/timeOffChanges.integration.test.ts server/tests/timeOffChangeDelivery.integration.test.ts`. Require executed tests, not skip-only output. Do not substitute mocked SQL for this gate.
- [ ] **Run repository checks:** `npm run typecheck`, `npm test`, and `npm run build`. Run relevant legacy PTO integration suites from Task 2 against their intended fixtures; fix failures caused by the feature. Record commands/results, including any integration tests skipped by default, without calling skipped tests passing.
- [ ] **Exercise the local browser:** Use the repository Playwright CLI skill for an authenticated tutor/admin fixture. Check pending amendment comparison, direct edit, cancellation, required reasons, stale versions, delivery failure/retry, narrow layout, keyboard dialog controls, and center switching. Use local/mock providers and disposable data; do not send live notifications. Capture concrete limitations if the local auth/database fixture cannot run.
- [ ] **Write the runbook:** Specify migration-first deployment, gated enablement only after checks, 30-second worker passes, attempt schedule/limits, repair-needed legacy-calendar failures, PTO reconciliation errors, and how to distinguish saved changes from delivery failures. Disable new operations to roll back while leaving the worker able to drain committed jobs. No automatic table rollback or ledger rewriting.
- [ ] **Final diff and graph review:** `git diff --check`; `node .gitnexus/run.cjs detect-changes --scope all --repo .`; for a branch regression review use `node .gitnexus/run.cjs detect-changes --scope compare --base-ref main --repo .` and distinguish unrelated pre-existing branch differences. Re-run partial/truncated checks. Verify changed files match this feature and no live credentials/artifacts were added.
- [ ] **Commit verified integration/runbook work:** `test: verify approved time-off change lifecycle and recovery`. Finish using the execution method selected by the user; deployment is a separate action.

## Coverage and handoff

| Spec requirement | Tasks |
| --- | --- |
| Parent remains effective during proposal; separate amendment state | 1, 3, 4, 7, 8 |
| Role/scope, own-admin restriction, tutor future-only limits, admin retrospective correction | 3, 4, 6–8 |
| Replacement quotes, delta ledger, type conversion, refunds, provenance | 2, 4, 7–9 |
| Idempotency, version conflicts, expiry, audit/history | 1, 3, 4, 6–9 |
| Calendar update/delete, legacy identity, retries/order/crash recovery | 4–6, 9 |
| Snapshot notifications, authenticated amendment links, separate retries | 4–6, 8, 9 |
| Admin search/history, tutor editor, shared UI, timezone/accessibility | 3, 6–8 |
| Existing pending/token flows, feature flag, deploy/rollback checks | 4–6, 9 |

Self-review checks: every endpoint has an owner in Task 6; every new callable interface is defined above or in the linked spec; the five review-focus cases have explicit tests; all commits require graph checks. No implementation, migration execution, live provider actions, or deployment is authorized by completion of these planning documents alone.

Recommended execution: subagent-driven after the user reviews the documents, because database accounting and delivery ordering deserve independent task reviews. Native execution is also supported. Do not start implementing until the user requests execution and selects the approach; the present request is for the spec and plan.
