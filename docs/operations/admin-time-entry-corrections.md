# Admin time-entry corrections

## Admin workflow

In **Approvals → Time entries → Manage time entries**, select a tutor and date. The default list is the current pay period; use the date range and status filters for earlier entries. An exact-date lookup distinguishes a genuinely missing entry from a failed request. Historical tutors remain available for existing entries, but only a verified active tutor can receive a new missing day.

- Missing, draft or pending: **Add missing time / Adjust time → Review adjustment → Save & approve**. Enter actual sessions, resolve open sessions and active breaks, and explain the change. Saving approves the completed whole day immediately; no second approval is required.
- Approved and completed: **Adjust time → Review adjustment → Save & keep approved**. The same day stays approved; counted hours update to the reviewed amount. A reason is required, and original sessions, breaks and approval details remain in before/after audit history. An inconsistent approved entry with an open clock session or active break is not editable through this action.
- To remove an approved whole day: **Void entry → Review removal → Void entry**. The entire work date stops contributing to approved totals. Sessions, breaks and original approval are preserved, not deleted.
- Voided: **Restore entry → Review restoration → Restore & approve**. Restore returns exactly the preserved approved day once, while the day is still voided. The action remains available after the original toast is gone. If the tutor replaces that day first, the original void cannot be restored over the replacement.
- Denied: read-only in this admin correction workflow. Ordinary pending approve/deny remains in the inbox.

All form changes are staged locally. Canceling or discarding does not write to the database. A review request is read-only; only the final confirmation commits. Times use the entry's center timezone, not the browser timezone. Repeated daylight-saving times require an explicit offset; nonexistent times are rejected.

Review distinguishes recorded paid time from approved counted time. Correcting a pending three-hour day to three hours fifteen minutes adds fifteen recorded minutes but adds the full three hours fifteen minutes to approved totals. Unknown legacy totals display as unavailable, not zero.

Correcting an already-approved three-hour day to three hours fifteen minutes changes both recorded and approved time by fifteen minutes. Reductions work the same way; this replaces the counted amount rather than adding a second entry. Existing payroll exports must be regenerated after saving. Direct approved adjustments use the same signed review, stale-revision protection, idempotent operation, and atomic audit as other corrections; no additional migration beyond 0015 is required.

Existing duration-only or partly outside-session breaks are preserved with warnings and the established allocation rules. Removing a linked session requires resolving the break into a final session or explicitly voiding it. New breaks require actual start/end times. Corrections do not apply clock Time Snap or sign a tutor's weekly attestation.

## Conflicts, retries and history

Each review is signed, tied to the admin and center, and expires after ten minutes. A changed entry returns a reload conflict instead of overwriting a newer save. Editing after review requires a new preview.

If a save response is lost, keep the editor open and use **Check save status** or **Retry same save**. Both retain the original operation UUID; do not create a new operation to recover an uncertain outcome. A lookup returning not found does not prove a still-running save failed. A committed retry recovers its original result even after preview expiry, without applying the old action again.

History records actor, reason, before/after day and child snapshots, schedule provenance, original approval, and the immutable operation result. Old events without full snapshots remain readable. Automatic clock-out skips voided days; ordinary tutor writes cannot change them.

### Tutor replacement of a voided day

Tutors can explicitly replace a voided day from their calendar, or choose **Clock In → Start a replacement session? → Start new session** for today. Calendar replacement opens with blank session inputs; it does not prefill the erroneous time. Canceling confirmation leaves the void untouched.

Replacement reuses the same tutor/center/date row and starts **pending**. Original sessions and breaks are removed from the active rows only within the same transaction that archives their complete before/after snapshots in a **Tutor replaced voided time** audit event. They are never added to the replacement's hours or break deductions. Original void/approval audit events remain intact.

Manual submission and clock-out still use normal schedule comparison: complete scheduled coverage without payable extra time can auto-approve; a variance stays pending. Replacement alone is not approval. It does not bypass weekly attestation.

The API exposes `voidedAuditId` on voided tutor days/clock state. Only an explicit `reopenVoidedAuditId` matching that current admin void can replace it. Stale confirmations, restored or re-voided days, and concurrent duplicate replacements return a reload conflict without changing the newer data. Older clients without this confirmation remain blocked. Admin restore previews from before a replacement also expire as changed-entry conflicts. This follow-up requires no additional schema migration.

## Payroll effects

Weekly, monthly, pay-period, comparison detail, clipboard sources, CSV and Excel count only approved entries. Voiding excludes the day; restoring counts it exactly once. CRM reported hours and schedules are not edited. Regenerate previously downloaded exports after a correction; files already downloaded cannot update themselves.

## Deployment

1. Review all pending migrations against the intended environment and take the normal database backup. Do not run tests against a shared or production database.
2. Apply `0015_admin_time_entry_operations.sql` with the existing migration runner (`npm run db:migrate`) in the authorized deployment environment. The runner applies **all** pending migrations, not only this file. Migration 0015 adds nullable `time_entry_audit.operation_id` and a unique partial index; existing audit rows are retained.
3. Configure a nonempty, stable `SESSION_SECRET` on every API instance. Admin preview signatures use a dedicated purpose prefix with this secret. All instances must share it; rotation invalidates outstanding previews. Existing schedule signing configuration remains separate.
4. Deploy the API, tutor/clock writer guards and client together. Drain older writer instances before permitting void operations. Ordinary clock-out work on this branch must remain included.
5. Smoke-test with a designated nonproduction tutor: missing-day correction, open-session completion, pending correction, void and restore, history, totals and fresh exports. Verify ordinary tutor writes cannot change a voided day, explicit replacement starts fresh/pending, and normal submission approval excludes the archived original hours.

Do not roll back to a binary without voided-state guards after any void operation. Disable mutation entry points if necessary and roll forward with a fix; retain entries and audit records. Do not drop operation IDs or the unique index as a routine rollback.

## Verification

Run `npm run typecheck`, `npm test`, and `npm run build`. The new PostgreSQL integration tests require a working local Docker engine and `postgres:17-alpine`. Their helper creates UUID-named disposable containers bound only to loopback, applies a minimal test schema, and stops the containers afterward. It never uses a deployment database URL. CRM responses are fictional fixtures.

Enable real database suites explicitly; default `npm test` skips opt-in PostgreSQL tests:

```powershell
$env:RUN_TIME_ENTRY_POSTGRES_TESTS = '1'
$env:RUN_PTO_POSTGRES_TESTS = '1'
npm test
```

These flags affect disposable test containers only, not migration targeting. Existing PTO integration tests use their own disposable fixtures.

Focused regressions are in `server/tests/adminTimeEntry*.test.ts`, `server/tests/timeEntry*Routes.test.ts`, `server/tests/timeEntryMutationGuard.test.ts`, `client/tests/adminTimeEntry*.test.ts` and `client/src/pages/admin/time-entry/*.test.tsx`. Payroll integration parses exported CSV/Excel cells through correction → void → restore, rather than inspecting SQL strings alone.

This document describes rollout; creating it does not apply a migration, deploy the feature, or change live hours.

### Implementation verification — 2026-09-16

Verified the complete server suite with both integration flags enabled (414 passed, no failures/skips), client helper suite (26 passed), client UI suite (86 passed), and load-tool contracts (5 passed): 531 passing tests. UI checks include cancellation without writes, open-session completion, immediate approval, void/restore, historical breaks, stale children, uncertain-save retries including expiry/auth errors, navigation, focus, center-timezone/DST behavior and payroll refresh. Typechecks and production builds pass; Vite still reports its large-bundle advisory.

Chrome checks used the real frontend and router with all API requests intercepted by fictional local fixtures: desktop 1440×1000 and mobile 375×812, light/dark themes, reduced motion, dialog scrolling/footer, review, missing time, open clock session, void/restore/history, stale errors and lost-response retry. Cancel/Escape/close/outside click produced no mutations. Browser Back/Forward retained drafts until explicit discard; void starts on **Keep entry**, Enter cancels, and focus returns to the initiating row. Retry reused the same UUID. General errors and review headings are brought into view. Injected 409/network errors were expected; no other runtime errors were observed.

Backend, writer and client reviews were completed with their reported issues resolved. GitNexus reports a critical aggregate footprint across shared entry/clock/approval/payroll paths; reviewed tracked paths are expected and include inherited clock-out work. Its change detector omits untracked files and its index has known flow-truncation limits, so new-file review plus behavioral/integration tests supplement—not replace—graph analysis. Production migration, real CRM availability, live payroll verification and deployment remain operator steps.

### Tutor replacement follow-up verification — 2026-09-16

The complete test command passes with both disposable PostgreSQL integration flags enabled. Nine new real-database replacement tests cover GET confirmation identity, malformed/wrong-day input, concurrent replacements, audit rollback, stale confirmations after restore/re-void, manual save/submission and clock-in/clock-out approval outcomes. The UI suite now has 90 passing tests, including blank replacement inputs, confirmation/cancel behavior, and readable before/after tutor replacement history. Typechecks and production builds pass; the existing Vite bundle advisory remains.

Playwright checks used fictional intercepted API responses only at 1440×1000 and 375×812. The new clock confirmation fits both viewports, initially focuses **Keep voided**, and Enter/Escape cancel without writes. Explicit confirmation sends exactly one request with the observed void identity and shows a pending clocked-in session. Screenshots were inspected after disabling capture-time animations; no browser runtime errors occurred (only the existing React Router future-flag warning). Independent follow-up review reported no blocking findings; its suggested clock-out regressions are included. No deployment, migration or live test mutation was performed.

### Admin approved-edit follow-up verification — 2026-09-16

The complete suite passes with disposable PostgreSQL tests enabled: 429 server, 26 client helper, 93 UI, and 5 load-tool tests (553 total; no skips or failures). Typechecks and production builds pass. New coverage verifies approved-to-approved correction with existing breaks and preserved original approval metadata; idempotent retry; stale void/admin previews; a tutor clocking in after admin review; audit-failure rollback; and public payroll/export results for both increases and decreases. Closed approved entries now offer both correction and void; denied, voided, and inconsistent open approved states retain their guards.

Fake-API-only Chrome checks at desktop 1440×1000 and mobile 375×812 verify **Adjust time**, cancellation/discard without any request, read-only review, visible **Save & keep approved**, exactly one commit, retained approved status, and displayed history showing 3h → 3h 15m. Screenshots were inspected; no runtime errors occurred. Independent review found no blocking issues. Prior approver/time/reason remain in the audit payload; the current History expansion displays original/changed times and counted-hour effects rather than every stored approval field. No new migration, deployment or live payroll test mutation was performed by this follow-up.
