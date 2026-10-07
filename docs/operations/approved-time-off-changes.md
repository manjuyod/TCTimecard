# Approved time-off changes

Tutors can propose changes to approved time off, and admins can approve or deny those proposals. Admins can also edit approved time off directly, and both roles can cancel upcoming approved leave. A saved change is the business record. Calendar updates and emails are follow-up jobs that run after the change is saved.

## What users see

- **Tutor, Time Off → My Requests.** Upcoming approved cards offer **Request change** and **Cancel time off**. A submitted proposal shows **Change pending**, with the approved dates first and the proposed dates beneath. The approved time off, calendar event and PTO charge stay in effect until an admin approves the change. **Withdraw change** closes the proposal.
- **Admin, Approvals → Time Off.** The pending-request inbox is unchanged. Two sections sit below it:
  - **Change requests** compares the current and proposed versions, including the per-cycle PTO difference, and offers **Approve change** and **Deny change**. Denial requires a reason.
  - **Manage time off** defaults to approved requests starting today or later. You can filter by status, tutor ID, local date range or request ID. **Edit approved request** saves immediately and the request stays approved. **Cancel time off** removes the leave and returns any PTO it used.
- **Who can do what.**
  - Changes and cancellations are allowed only before the leave starts. Ongoing and past requests are view-only.
  - An admin cannot edit or approve a change to their own request; they can still cancel it.
  - Admin edits and cancellations close any pending proposal, recorded as superseded.
- **Reasons.** Proposals, direct edits and approved cancellations require a 10–2000 character change reason.
- **Links.** Proposal emails link to `/admin/approvals?tab=timeoff&franchiseId=…&requestId=…&view=manage&amendmentId=…`. Original approval tokens never authorize a change.

## Deploying and enabling

1. **Migrate first.** Take the normal backup. Apply migrations through `0017_time_off_change_review_fixes.sql` with `npm run db:migrate` in the authorized environment; the runner applies every pending migration.
   - 0016 adds `version`, `last_change_operation_id` and `google_calendar_id` to `time_off_requests`.
   - It adds the amendment, operation and delivery tables.
   - It replaces the PTO writer functions so every balance writer takes the PTO policy lock before profile and allocation locks.
   - Existing approvals keep a NULL calendar ID; nothing is backfilled or guessed.
   - 0017 extends the deployed `time_off_audit_action_check` allow-list for the seven change actions, retaining the existing values. It also resolves missing legacy date metadata in the center timezone, including legacy timed leave. A read-only check on 2026-10-07 confirmed the shared database's old CHECK rejects the new actions; **0016 alone is insufficient**. `actor_account_type` is unconstrained text and permits SYSTEM with a null actor ID.
2. **Check readiness.** Run `npm run db:check-timeoff-schema`; it must report no missing columns.
3. **Deploy with the flag off.** `TIME_OFF_CHANGES_ENABLED` is off unless set to exactly `true`. With the flag off:
   - The new tutor and admin endpoints return 404 `TIME_OFF_CHANGES_DISABLED`.
   - The tutor policy reports `changesEnabled: false`, and the admin capability endpoint answers `{ "enabled": false }`.
   - Original submission, approval, email-decision and pending-cancellation flows work as before.
4. **Smoke-test outside production.** Use a nonproduction center and disposable data. Do not send live email: `EMAIL_LOG_ONLY` stays at its default unless you deliberately test live sends. Walk through propose → deny → propose → approve → admin edit → cancel. Confirm the calendar event, emails, PTO balance and history at each step.
5. **Enable.** Set `TIME_OFF_CHANGES_ENABLED=true` on every API instance and restart. If 0016 is missing, startup logs the missing columns and exits; an unreachable database only logs a warning.

## Calendar and email delivery

Every API instance runs a delivery worker, whether or not the flag is on, so jobs already committed always drain.

- **Schedule.** One pass every 30 seconds, plus an immediate pass after each saved change. A pass handles at most 20 due jobs and runs the expiry check (at most 100 expired proposals). Passes never overlap, and each uses one database connection.
- **Coordination between instances.** A calendar job locks its time-off request. Business changes take the same lock, so an older edit can never overwrite a newer edit or cancellation. Older pending calendar jobs for the request are marked **superseded**; a superseded job can never be revived. An email job locks only its own row.
- **Timeouts.** Each Google request, including token acquisition and insert/lookup, times out after 10 seconds. Each job attempt is capped at 20 seconds for email and 60 seconds for calendar work. Calendar attempts abort the sequence and transport together, and retain the request lock until the attempt settles. A command waiting for that lock rechecks the leave's start deadline before committing.
- **Retries.** Transient failures (network, timeout, 429, 5xx, rate-limit 403) retry after 30 seconds, 2 minutes, 10 minutes, 1 hour and 6 hours. The job is marked **failed** after the sixth failed attempt. Permission, validation and ownership errors fail immediately.
- **Before migration.** On startup before 0016, the worker logs once that the delivery tables do not exist yet and stays idle.

### Telling a saved change from a delivery failure

The request detail (tutor card or admin **Manage time off**) lists **Calendar update**, **Calendar removal**, **Center email** and **Requester email** with their status. **Pending** and **Failed** never mean the change itself failed: the request, PTO and history are already saved. Emails do not claim calendar sync.

### Retrying

In **Manage time off**, failed deliveries appear under *Calendar and email follow-up that needs attention* and in the request detail. **Retry** re-queues the same job with a fresh retry schedule; it does not repeat the business change or rebuild the email. A retry is refused for jobs that are superseded, already sent, or belong to another center. These retries are separate from the legacy notification retry for original requests.

Email is not exactly-once. If the email provider accepts a message and the process crashes before the job is marked sent, the email can be sent twice. Calendar work is idempotent: patches repeat safely, and replacement events use an ID fixed when the job was queued.

A newer edit adopts an owned recovery event left by an earlier crashed attempt. A newer calendar target fences every older pending retry, including when the newer target is already sent or failed.

### Repair-needed calendar failures

A failure whose message starts with `TIME_OFF_CALENDAR_REPAIR_REQUIRED` needs a person:

- **Legacy approval with no recorded event, or an event that cannot be verified** in the franchise calendar. Nothing was changed in Google. Update or remove the event manually, then leave the job failed; the request itself is correct.
- **The franchise Gmail/calendar changed** since the event was created. Events are not migrated between calendars automatically. Move or remove the event under the old identity manually.
- **A replacement event was deleted outside the app.** The worker will not keep creating new replacement IDs.

A **does not belong to time-off request** failure means the event ID points at another request's event. Nothing was mutated; investigate before changing anything.

## PTO behavior and reconciliation errors

- A proposal never reserves PTO. Approval and admin edits re-check PTO for each entitlement cycle using only that request's actual consumption as credit. Credit from one cycle cannot fund another.
- **Not enough PTO.** Approval fails with *Insufficient PTO balance*, the proposal stays pending, and the original approval is untouched.
- **Ledger history.** Changes append `consume` and `release` ledger rows keyed by operation and allocation. Earlier ledger rows, allocations and request IDs are never deleted or rewritten. Displayed **Used** is net of releases.
- **Paid requests that predate PTO tracking** (no allocations, positive charge) return `TIME_OFF_PTO_RECONCILIATION_REQUIRED` (422) for date or type changes. Reason-only edits and cancellation still work; cancelling such a request records no refund, and the preview warns about this. Reconcile the PTO by hand with a PTO adjustment before changing the dates.
- **Disabled centers.** When a center later disables PTO, reductions and cancellations still refund. Increases, or converting unpaid leave into PTO, return `PTO_CENTER_DISABLED` or `PTO_IDENTITY_UNRESOLVED`.

## Monitoring

Watch these with read-only queries against the authorized database:

- Failed jobs: `time_off_change_deliveries` with `status = 'failed'`.
- Stuck jobs: `status = 'pending'` with an old `next_attempt_at`.
- Overdue proposals: `time_off_amendments` with `status = 'pending'` past their start date. Normally the expiry pass closes these within 30 seconds.
- Worker errors: `[timeoff-changes]` log lines.

## Rolling back

Set `TIME_OFF_CHANGES_ENABLED=false` and restart. This stops new proposals, edits and cancellations; the worker keeps draining committed jobs.

Keep the 0016 schema, operations, amendments, deliveries and ledger rows. Do not drop the tables or reverse ledger entries. An application binary from before 0016 still runs against the 0016 schema, but its PTO writers would no longer share the new lock order. Prefer disabling the flag and rolling forward with a fix.

## Verification commands

```powershell
npm run typecheck
npm test
npm run build
npx cross-env RUN_PTO_POSTGRES_TESTS=1 node --test --import tsx server/tests/timeOffChangesMigration.integration.test.ts server/tests/ptoTimeOffChanges.integration.test.ts server/tests/timeOffChanges.integration.test.ts server/tests/timeOffChangeDelivery.integration.test.ts server/tests/timeOffChangeLists.integration.test.ts
npx cross-env RUN_PTO_POSTGRES_TESTS=1 node --test --import tsx server/tests/ptoMigration.integration.test.ts server/tests/ptoAdminMigration.integration.test.ts server/tests/ptoRouteMigration.integration.test.ts
```

The PostgreSQL suites need a local Docker engine. They start disposable `postgres:17-alpine` containers bound to loopback and never read a deployment connection string. Default `npm test` skips them; a skipped suite has not passed.
