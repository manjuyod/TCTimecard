# Approved time-off changes: product and technical spec

Date: 2026-10-07

Status: Proposed for review. The user approved the core behavior and requested both this spec and an implementation plan. Application implementation has not started.

Companion: [Implementation plan](../plans/2026-10-07-approved-time-off-changes.md)

## Intent and accepted behavior

People change their plans after time off is approved. Tutors need to propose revisions or cancel their own leave, and admins need to correct or cancel approved requests for their center. The user accepted these rules:

- Tutor changes require admin approval. The original approval, dates, calendar event, and PTO charge remain effective while a proposal is pending.
- Admin changes take effect directly and remain approved.
- Tutors and admins can cancel approved requests. Cancellation takes effect directly; it is not another approval request.
- Changes maintain PTO accounting, synchronize Google Calendar, notify the affected people, and preserve history.

This is one lifecycle feature spanning existing requests, PostgreSQL accounting, Google Calendar, and two existing screens. The requested deliverables in this pass are the spec and plan.

### Proposed boundaries and defaults

These are design decisions for review, rather than additional requirements explicitly supplied by the user:

- Version one permits changes and cancellation only before the current leave starts. Both the current and proposed start instants must be strictly later than the server's current instant. Ongoing and past requests are view-only for both roles. Full-day leave starts at local midnight, so full-day leave beginning today has already started. The user was offered a broader admin-history option; this document uses the upcoming-only default unless that preference changes.
- Editable fields are start/end dates, partial-day times, absence type, and request reason. Tutor, franchise, requester identity, source, and creation history are immutable.
- Only one pending amendment per request. A tutor withdraws an amendment before proposing another. An admin edit or cancellation supersedes any pending amendment, with an explicit warning and audit record.
- Pending ordinary requests retain their existing submit/approve/deny/cancel flow. Editing pending requests, restoring cancelled requests, bulk actions, retrospective PTO corrections, and anonymous self-service edits are outside this version.
- Public/bridge requests can be managed by the owning center's admin. Possession of a submission link, an old approval token, or a matching email does not grant tutor ownership.
- Use the existing React, Express, PostgreSQL, Luxon, and Google authentication stack. Add no package dependencies.

## Current implementation and evidence

Inspected repository: `TCTimecard`, workspace `C:\Users\17026\Documents\Code stuff\Time Card App`, branch `dev`, HEAD `b92b266c00368d0563f5dfaeb628adab8acdb8ac`. The GitNexus index is at that same commit. The working tree was clean before authoring these documents.

| Evidence | Consequence |
| --- | --- |
| `client/src/pages/tutor/TimeOffPage.tsx` renders Cancel only for pending requests. `server/routes/timeoff.ts` and `cancelPendingTimeOff` enforce pending-only cancellation. | Approved cancellation needs a new transactional path, not just an enabled button. |
| `client/src/pages/admin/ApprovalsPage.tsx` loads `fetchAdminPendingTimeOff`; approved details are view-only. | Add management/history reads and a separate amendment review queue. |
| `decideLockedTimeOffRequest` in `server/services/timeOffDecision.ts` locks the request and rejects every status except pending. | Preserve initial approval semantics; implement amendments separately. |
| `pto_protect_held_request` in migration `0010_shared_pto.sql` rejects identity/date/type changes whenever allocations exist. | Approved changes require a guarded database accounting transition. |
| Existing allocations are unique by `(request_id, cycle_id)` and ledger entries are append-only. The latest reservation implementation is in `0014_database_controlled_pto_linked_login.sql`. | Update current allocation state while appending operation-specific ledger deltas. Do not delete/recreate the request or reuse original reservation keys. |
| `pto_transition_request` already refunds consumed allocations on cancellation, but the public app exposes no approved-cancellation path. | Reuse the accounting semantics, with explicit exactly-once ownership for the new lifecycle. |
| `balanceSummary` in `server/services/pto/routeStore.ts` computes used days from consume entries alone. | Display net consumption after releases so balances reconcile after corrections. |
| `CalendarClient` currently supports insert/get only; the approved event ID lives on the request. | Add update/delete and durable delivery for new changes. |
| Time-off email decisions are single-use tokens for pending original requests. | Amendment emails link to authenticated review; original tokens never authorize amendments. |

### GitNexus risk assessment

Upstream impact checks before writing these documents found LOW risk for `createTimeOffRouter` (route module and `server/index.ts`), `normalizeTimeOffSubmission` (time-off submission and PTO quote routes), `buildGcalClientForSubject` (initial approval), and the tutor/admin page components (App routing). `mapTimeOffRow` is MEDIUM with seven direct callers and 16 total affected symbols.

**HIGH impact:** `appendTimeOffAudit` has seven direct callers and 16 affected symbols, including approval, notification/retry, and a graph-reported clock-out flow. Keep its existing interface and behavior; consume it from the new service rather than widening its contract. Re-run impact if that helper must change.

SQL functions `pto_protect_held_request`, `pto_transition_request`, and `pto_reserve_request` returned UNKNOWN/not found. Text confirmation located the trigger bindings in `0010`, reservation replacements in `0011` and `0014`, and direct SQL integration tests. This is a graph coverage gap, not proof of low risk. PostgreSQL integration tests must exercise the deployed migration chain and concurrency.

## Product rules

### State transitions

The parent request keeps the existing four statuses. Amendment state is separate.

| Action | Parent before/after | Amendment outcome | Effective dates, PTO, calendar |
| --- | --- | --- | --- |
| Tutor proposes edit | approved → approved | pending | Unchanged |
| Tutor withdraws proposal | approved → approved | withdrawn | Unchanged |
| Admin denies proposal | approved → approved | denied | Unchanged |
| Admin approves proposal | approved → approved | approved | Replace effective fields and reconcile charge |
| Admin directly edits | approved → approved | Any pending proposal becomes superseded | Apply admin draft and reconcile charge |
| Tutor/admin cancels | approved → cancelled | Any pending proposal becomes superseded | Refund actual consumption and remove calendar event |
| Either start deadline passes before decision | approved → approved | pending proposal becomes expired | Original approval remains effective |

Amendment statuses: `pending`, `approved`, `denied`, `withdrawn`, `superseded`, `expired`. Terminal amendments are immutable. Request history always retains the original approval and every later operation.

### Permissions and validation

- Derive actor ID, role, and franchise scope from the authenticated session and existing scope middleware. Never accept these as authoritative body fields.
- Tutors can view/propose/withdraw/cancel only requests with their own `tutorid` in their session franchise. Sharing a PTO profile does not share request-edit permissions.
- Admins can read/manage requests only within their authorized selected franchise. Keep the existing self-approval restriction: an admin cannot directly edit or approve an amendment to their own request; they use the tutor flow. An owner may cancel their own request without approval.
- Require an explicit `changeReason` of 10–2000 trimmed characters for proposals, direct edits, and approved cancellation. Keep the request reason at 10–2000 characters. Denial reasons are 1–2000 characters. Withdrawal needs confirmation but no new reason.
- Normalize all proposed dates in the franchise timezone; retain inclusive input end dates and exclusive persisted full-day ends. Preserve the existing 336-hour maximum and existing absence-type mapping, including Emergency stored as Other plus its label.
- Reject local times that do not exist during a DST jump. For an ambiguous fall-back time, choose the earlier UTC occurrence and display the resolved zone/offset in the preview. Freeze the proposal timezone; if the center timezone changes before review, require a new proposal instead of silently reinterpreting it.
- Reject normalized no-op proposals/direct edits. A changed explanation alone is a meaningful edit and follows the same approval/audit flow.
- Tutor proposals that add coverage outside the existing approved interval follow the configured 14-day notice rule, except Sick/Emergency. A pure reduction within the approved interval, or reason-only change, is grandfathered. A type change into a non-exempt type is checked as a new non-exempt request. Use proposal submission time for notice validation; do not move the notice window forward while an admin reviews it.
- Admin direct edits may bypass the notice window, with their mandatory change reason recorded. They cannot bypass ownership, future-date, overlap, duration, or PTO sufficiency checks.
- Reuse the optional overlap enforcement setting. When enabled, exclude the parent request itself and compare with other active pending/approved requests. Recheck at save and approval; a proposal itself does not block other leave.
- Recheck current and proposed start instants at commit. A pending proposal expires at the earlier start instant; withdrawal remains possible until expiration. Reads report it non-actionable immediately even before the background expiry pass persists the terminal state.

## Screen behavior

### Tutor: My Requests

Upcoming approved cards gain **Request change** and **Cancel time off**. The editor is prefilled from the request's normalized local dates, times, type, and reason. It shows current approved details alongside the draft, the change reason, and any PTO before/after quote. The save label is **Submit change for approval**.

Exact explanatory copy: **“Your current approved time off stays in effect until an admin approves this change.”** The pending card shows Approved plus **Change pending**, current dates first, proposed dates beneath, and **Withdraw change**. It does not expose another editor until withdrawal or a decision. Cancellation confirmation shows the effective dates and any PTO refund, and warns that a pending change will also close.

After a successful operation, refetch the request and shared balance. Never show a submitted proposal as the effective leave. Preserve drafts on validation/network failure. A version conflict requires refresh and explicit resubmission; do not automatically overwrite another action.

### Admin: Approvals → Time Off

Keep the pending-request inbox. Add a **Change requests** section and **Manage time off** view. Management supports status (`approved`, `cancelled`, `denied`, `pending`, or all), tutor ID, local date overlap, and request ID filters; default to approved requests starting today or later. Use server pagination (50 default, 200 maximum), stable order `(start_at DESC, id DESC)`, and an opaque cursor. Changing any filter resets the cursor.

Details show original approval, effective request, pending amendment if present, change history, and delivery status. **Approve change** and **Deny change** are distinct from original approval buttons. Before/after fields and per-cycle PTO differences appear before confirmation. Insufficient PTO leaves the proposal pending and the original request intact, with an actionable error.

**Edit approved request** opens the same field editor with a required change reason and **Save approved changes**. If a proposal exists, show **“Saving this edit will replace the pending change request.”** **Cancel time off** requires confirmation and a reason. Past/ongoing records remain searchable but explain why edits are unavailable.

Add `view=manage` and optional `amendmentId` to existing `tab=timeoff&franchiseId=…&requestId=…` links. Preserve existing time-entry/extra-hours links, unrelated query parameters, browser back/forward, and franchise switching. Clear stale detail/drafts on franchise switch; never render a late response from the previous center.

Reuse existing components, semantic colors, focus management, labels, dialogs, and toast conventions. The comparison stacks on narrow screens. Confirmation dialogs have a clear cancel action; dirty drafts prompt before dismissal. Test keyboard access and pending/busy states.

## Persistence and consistency

### Schema additions

Use a new migration `0016_approved_time_off_changes.sql` (recheck the next free number at implementation). Do not rewrite applied migrations.

1. `time_off_requests.version BIGINT NOT NULL DEFAULT 1`, positive; `last_change_operation_id UUID NULL`; `google_calendar_id TEXT NULL`. Version increments exactly once per successful workflow mutation, including proposal creation/withdrawal/denial/expiry, but not delivery retries. An ordinary first decision also increments it. Existing event IDs remain valid.
2. `time_off_amendments`: bigint ID, request FK, `base_version`, typed proposed fields corresponding to `NormalizedTimeOffSubmission`, frozen proposal timezone, required change reason, proposer ID, creation time, status, decider ID/time/reason. A partial unique index on request ID where status is pending enforces one open proposal. `base_version` is the parent version immediately after submitting the proposal.
3. `time_off_change_operations`: UUID ID supplied by the server, request FK, actor type/ID, franchise ID, action, optional amendment ID, expected/result version, client idempotency key, normalized input hash, before/after JSON snapshots, change reason, created time, completed time, and persisted response JSON. Unique `(actor_type, actor_id, franchiseid, idempotency_key)`; do not delete records while history exists. Allowed actions: `propose`, `withdraw`, `approve_amendment`, `deny_amendment`, `admin_edit`, `cancel`, `expire`. System expiry uses actor type SYSTEM and reserved actor ID 0; user IDs must be positive.
4. `time_off_change_deliveries`: UUID ID, operation/request FKs, channel (`calendar` or `email`), kind, target version, frozen payload/recipient/identity, unique deduplication key, status (`pending`, `sent`, `failed`, `superseded`), attempt count, next-attempt time, sanitized last error, completion time. Index due jobs and franchise-visible failures through request joins. A calendar payload also stores its verified/adopted event ID. Assign and durably save its deterministic recovery event ID when the job is enqueued in the business transaction, before any provider call can occur.

Expose request versions as decimal strings in JSON; keep database BIGINT precision. Existing numeric request IDs remain as today. New UUID operation/delivery IDs and bigint amendment IDs are strings. The new detail DTO wraps the existing request shape and adds version, pending amendment, allowed actions, history, and delivery state; ordinary list/approval consumers remain compatible.

### Transaction protocol

Each command executes in one database transaction:

1. Authorize request visibility, then check the actor-scoped idempotency key. Same key and normalized input returns the stored operation result without another write. Same key with different input returns 409. Replays still require current request visibility; never leak an old result to a now-unscoped actor.
2. Lock the parent request `FOR UPDATE`, then its amendment. Recheck the expected parent version, state, ownership, policy, and start deadlines under that lock. For an amendment decision, require the current pending amendment ID and its matching base version.
3. Record the operation intent and frozen inputs; validate/reconcile PTO if effective fields change. Persist the request, amendment terminal state, version increment, before/after audit, operation result, and delivery rows atomically. Any failure rolls the whole transaction back.
4. Commit before attempting network delivery. Wake the delivery worker as a best effort; process restarts still find due rows. Return the saved result with pending delivery status.

Tutor proposals/withdrawals/denials only change workflow metadata. They never overwrite effective fields or post calendar jobs. Admin edits and cancellation supersede a pending proposal in the same transaction. Preserve original `decided_at`, `decided_by`, and approval reason for approved edits; later decisions live in history. Cancellation records its own decision metadata and preserves the original in the operation/audit snapshot.

No network call is part of the business transaction. PostgreSQL is authoritative; calendar and email convergence are visible, retryable effects rather than a claimed distributed transaction.

## PTO accounting

### Quotes and pending proposals

An amendment does not reserve additional days. Quote the replacement using current entitlement policy/cycles and the original request's actually consumed allocations as credit. UI copy says **“PTO is checked again when this change is approved.”** Do not reuse the ordinary new-request quote unchanged: it would count the approved charge twice.

For each entitlement cycle, let `old` be this request's currently consumed days and `new` its proposed days. Validate `available + old >= new` independently for each cycle; credit from one cycle cannot fund another. Use database policy/cycle functions rather than the January-only `cycleCharges` convenience output of `calculatePtoCharge`.

### Atomic replacement

- Add `pto_preview_approved_change(request_id, target_json)` and `pto_reconcile_approved_time_off(request_id, operation_id, before_json)`. The latter is invoked by the approved-change lifecycle trigger and recomputes under locks; it does not trust preview values.
- Preserve request/allocation IDs and the append-only ledger. For a cycle reduction append `release` with positive balance delta; for an increase append `consume` with negative balance delta. Both have zero reserved delta because this is approved consumption. Idempotency keys include operation ID, allocation ID, and direction. Update each current allocation's charged days/state; zero-charge cycles become released while retaining their last positive charged-days value to satisfy the existing constraint.
- PTO → non-PTO releases actual consumption. Non-PTO → PTO validates current identity/eligibility and consumes new allocations. Cancellation releases actual active allocations exactly once. Never grant a refund based solely on dates or a fresh quote.
- Replace the held-fields trigger's blanket rejection only for a validated approved-change operation: matching request, expected version, actor/franchise, target fields, and incremented version/operation pointer. Identity remains immutable. A guarded AFTER UPDATE path reconciles the ledger for approved edits/cancellation. It must not also invoke the old status-transition refund for the same change. Initial pending insert/approve/deny/cancel behavior remains intact.
- All balance writers touched by this feature must coordinate with existing writers. Establish and test a common order: request row (where applicable), existing PTO policy advisory lock, canonical-profile advisory locks in ascending ID order, profile rows, then allocation rows in cycle-ID order. Recheck canonical identity after acquiring its lock. Update `pto_transition_request` and the latest reservation replacement where needed to remove the current allocation-before-profile inversion. Include profile linking/merging/unlinking and administrator adjustments in the lock-order review; do not introduce a new lock namespace that existing writers ignore. Retry the entire database-only transaction at most three times for deadlock/serialization failures, retaining the same idempotency key.
- Refunds/reductions use existing allocation provenance even if a center has since disabled PTO. Increases or conversion into PTO require the current request-source eligibility and a resolved canonical profile consistent with existing allocations. Do not switch the request to another person's balance because their email/profile link changed.
- New consume/release ledger entries retain `source_membership_id` provenance, so profile unlinking can attribute them correctly. Where legacy attribution is ambiguous, require reconciliation instead of inventing a membership.
- An approved legacy PTO request with no allocations and a positive original calculated charge is untracked: reject financial/date/type edits with `TIME_OFF_PTO_RECONCILIATION_REQUIRED`. Reason-only edits and cancellation are allowed, with zero inferred refund and a visible warning. Zero-charge requests with no allocations are not automatically untracked.
- Fix `balanceSummary.usedDays` to net consume and release balance deltas; pending reservation releases have zero balance delta and therefore do not lower used days. Keep manual adjustments separate. Verify `available = granted + adjusted - reserved - used` across the affected cycles and linked profiles.

## Calendar and notifications

### Delivery worker

Add a small PostgreSQL-backed worker within the existing Express process; no new queue service. Run one non-overlapping pass every 30 seconds, process at most 20 due deliveries per pass, and use one worker database client at a time. Stop scheduling on graceful shutdown and drain the active attempt within its bounded timeout. Multiple app instances coordinate through database locks.

For calendar deliveries, lock the parent request before selecting its newest unsent calendar target; retain that request lock through the bounded provider attempt and delivery-state commit. Business mutations take the same request lock, so an older worker cannot overwrite a later edit/cancellation. Mark older calendar jobs superseded. Compare calendar target versions with other calendar jobs, not the parent's workflow-only version increments. Workers never change request version, PTO, or business history. The latest cancellation still cleans up known event IDs from earlier attempts whose completion was uncertain.

Use a 10-second timeout per provider request. Retry transient/network/quota failures after 30 seconds, 2 minutes, 10 minutes, 1 hour, and 6 hours, then mark failed after the sixth failed attempt. Permanent permission/validation/ownership errors become failed immediately. Failed deliveries remain visible; a scoped admin **Retry** queues the same delivery without reapplying the business action. A superseded calendar job cannot be manually revived. Authenticated reads never cause provider writes.

### Calendar projection

- Update the stored event using its verified request/franchise ownership markers. Preserve unrelated event fields. Add the target request version to private extended properties.
- Persist the calendar ID used by all new initial approvals. Legacy requests have a null calendar ID: resolve the current franchise Gmail calendar and adopt it only after verifying the existing event's ownership. If that event cannot be verified, show a repair-needed failure; do not invent a successful sync or delete a different event.
- Add provider patch/delete helpers. When changing all-day ↔ timed leave, explicitly remove the incompatible `date`/`dateTime` fields. The existing event builder remains the source of approved payloads.
- Cancel by deleting the owned event. A verified deleted event / provider `410 deleted` is converged. A generic 404 can mean missing permission as well as missing data: require a successful calendar access probe before treating absence as success or recreating an event.
- If a previously verified event has disappeared, use the recovery ID already persisted in the job, derived from request ID and target version, and verify ownership on insert conflict. Retries use that ID; reconcile its desired content as well as ownership on a 409. A later cancellation must consider the stored original and all potentially inserted recovery IDs from prior jobs, even if their attempt transactions rolled back. Never reuse a known deleted-event ID. If the recovery ID itself was externally deleted, fail visibly for repair instead of allocating endless replacement IDs.
- Do not auto-migrate events between calendars if franchise Gmail configuration changes. Mark the job failed for explicit repair while retaining the last known calendar identity.

Google supports partial event updates and deletion; unspecified patch fields are retained, and a successful delete has an empty response body. The planned helpers follow those contracts. [Events.patch](https://developers.google.com/workspace/calendar/api/v3/reference/events/patch), [Events.delete](https://developers.google.com/workspace/calendar/api/v3/reference/events/delete). Error handling distinguishes resource absence, access problems, and retryable failures using Google's [error guidance](https://developers.google.com/workspace/calendar/api/guides/errors).

### Email and audit

Persist one email job per intended recipient/operation. Notify the center on tutor proposals, withdrawal, expiry, and cancellation. Notify the requester on amendment approval/denial, admin edit, and admin cancellation. An admin edit/cancel that supersedes a proposal sends one combined requester message. Tutor cancellation also sends a requester confirmation. Use source request email snapshots and existing center contact resolution; preserve public/bridge support.

Proposal emails show current versus proposed dates and link to authenticated amendment review. No new anonymous decision tokens. Old original-decision links remain used/invalid. Do not claim calendar sync in email text before it succeeds; link to current request details for delivery status.

Email jobs are deduplicated in the application and immutable. Provider success followed by a process crash can still cause a duplicate email because the provider and database are not one transaction; the design does not promise exactly-once email. Messages include operation time and clearly identify historical changes. Record attempt/success/failure with operation and delivery IDs, without credentials or bearer tokens.

Expose these failures separately from legacy `admin_request`/`requester_decision` retries. Do not retry a new operation through a legacy endpoint that regenerates an email from the wrong request version.

## API contracts

All paths are under `/api`; exact new DTOs live in `server/types/timeOffChanges.ts` and are mirrored in a dedicated client module. Existing initial-request endpoints remain compatible.

| Method/path | Purpose |
| --- | --- |
| `GET /timeoff/:id/change-detail` | Owner detail, version, pending proposal, history, allowed actions, delivery states |
| `POST /timeoff/:id/change-preview` | Owner-authorized normalized proposal and replacement PTO quote; no writes |
| `POST /timeoff/:id/amendments` | Submit `{expectedVersion, idempotencyKey, proposed, changeReason}` |
| `POST /timeoff/:id/amendments/:amendmentId/withdraw` | Withdraw with expected version and idempotency key |
| `POST /timeoff/:id/cancel-approved` | Owner cancellation with expected version, idempotency key, and change reason |
| `GET /timeoff/admin/change-capabilities` | Scoped admin capability `{enabled}`; remains readable when the feature is off |
| `GET /timeoff/admin/requests` | Scoped filtered/cursor-paginated management list |
| `GET /timeoff/admin/amendments` | Scoped pending amendment queue, same pagination limits |
| `GET /timeoff/admin/:id/change-detail` | Scoped admin detail |
| `POST /timeoff/admin/:id/change-preview` | Admin edit preview; source identity stays on request |
| `POST /timeoff/admin/:id/amendments/:amendmentId/decide` | `{expectedVersion, idempotencyKey, decision: approve\|deny, reason?}` |
| `POST /timeoff/admin/:id/change` | Direct edit: `{expectedVersion, idempotencyKey, proposed, changeReason}` |
| `POST /timeoff/admin/:id/cancel-approved` | Admin cancellation with expected version, idempotency key, and reason |
| `GET /timeoff/admin/change-deliveries` | Scoped pending/failed new-operation deliveries, paginated |
| `POST /timeoff/admin/change-deliveries/:deliveryId/retry` | Retry delivery only |

Register specific management routes before existing `/timeoff/admin/:id` routes. New management handlers may live in a sibling router mounted before the existing time-off router. Extend detail reads with allowed actions rather than duplicating security logic in the browser.

Successful mutations return `{operationId, requestId, version, amendmentId, outcome, deliveryIds}` from the committed operation record; clients then refetch detail/balance. Replay returns that same immutable receipt, even if delivery or request state later changes. A preview returns `{version, normalized, resolvedOffsets: {start, end}, pto, warnings}`, where offsets are strings such as `-07:00`; it is advisory, not authorization or a reservation.

Errors use `{error, code}`: 400 malformed inputs; 401 unauthenticated; 403 forbidden/self-approval; 404 unavailable request/amendment; 409 stale version, terminal state, pending-amendment conflict, idempotency mismatch, start deadline, overlap, or insufficient PTO; 422 unresolved identity/provenance or legacy reconciliation requirement. Map existing PTO errors consistently. Do not return cross-center snapshots in errors.

## Verification and rollout

Acceptance must prove: proposal leaves the original untouched; approval swaps it once; denial/withdrawal/expiry retains it; admin edits/cancellation supersede proposals; retries and racing admins cannot double-consume/refund; calendar failures are visible and recover; every action is scoped and audited.

Run database tests against disposable PostgreSQL with migrations through the new migration, including concurrent connections. Exercise cross-cycle changes, full-day/partial-day conversion, linked profiles, disabled centers, missing provenance, and legacy records. Test an initial approval, then two edits, then cancellation: the ledger and visible used/available amounts must reflect the final state exactly.

Test stale tabs, repeated commands with the same/different payload, worker crashes after remote success, older jobs after newer jobs, permission failures, missing/deleted events, center changes while requests are in flight, and server-versus-browser timezones around DST. Check existing initial approval, original email decisions, pending cancellation, PTO public quotes, and time-entry flows for regressions.

Ship the migration before enabling mutation routes/UI. Add `TIME_OFF_CHANGES_ENABLED` (default false) to gate new reads/writes/UI capabilities while deploying; the delivery worker remains able to drain already-committed jobs when the flag is turned off. The existing tutor policy and an always-readable authenticated admin capability endpoint expose the flag without enabling any mutations. Enable after database, API, worker, and UI checks pass. Roll back by disabling new operations and preserving schema/history/jobs; do not reverse applied ledger changes or drop tables. Monitor due/failed deliveries and stale amendments.

No production migration, application deployment, or live calendar/email mutation is part of this planning pass.
