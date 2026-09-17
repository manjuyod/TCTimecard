# Admin time-entry corrections: product and technical spec

Date: 2026-09-16  
Status: Implemented in the working tree, with approved follow-ups for tutor replacement and admin edits of approved time. Deployment is separate.  
Companion: [Implementation plan](../plans/2026-09-16-admin-time-entry-corrections.md)

## Outcome and scope

An admin can find a tutor's work date, enter missing time, correct draft or pending time, and save the complete day as approved. An admin can also adjust a completed approved day while keeping it approved, or remove an erroneous approved day from counted hours using **Void entry**, then **Restore entry** if the removal was mistaken. Each mutation records who acted, when, why, and the before/after state.

The user explicitly selected immediate approval after an admin correction and requested removal of erroneous approved entries. Restore is the proposed reversible counterpart to removal. The UI changes are additive to the existing Approvals screen and reuse its visual language.

This is one time-entry lifecycle feature spanning the admin interface, API, audit records, clock writers, and hour readers. The deliverable for this planning pass is this spec and its executable work plan. There are no application, database, or payroll mutations in this pass.

### Boundaries chosen for this version

- A time entry means one tutor's **whole work date**, including every session and break. The correction draft can adjust individual segments and breaks, but review and approval apply to the complete day. Void remains a whole-day action.
- Missing, draft, pending, and completed approved days can be corrected. An approved correction stays approved and preserves the original approval in audit history. Approved entries with an open clock session or active break remain blocked. Denied days remain view-only for this admin workflow, with existing tutor resubmission behavior preserved.
- A pending day that was previously approved and then invalidated is editable because its current state is pending; its earlier approval remains in history.
- An unfinished day can be loaded with its open session visible. Saving and approving requires explicit end times and completion or voiding of every active break. An admin cannot approve a still-running shift or silently clock someone out at the current time.
- Work dates must be today or earlier in the center's timezone. Existing past pay periods are searchable; this application has no finalized-payroll lock or reliable export-history flag to invent.
- No bulk removal, bulk correction, tutor impersonation, new role system, payroll disbursement changes, automatic emails, Rust migration, or independent redesign of other admin pages.
- Admin corrections do not sign, erase, or silently amend weekly attestations. The affected day and its correction history remain available alongside the existing attestation records.

## Current code and evidence

At inspection, the workspace is on `fix/clockoutsnap`, HEAD `6539583`, with existing uncommitted clock-out work. The original `rust/backend` branch name does not describe a Rust implementation: the inspected app uses React/TypeScript and Express/TypeScript.

| Current behavior | Source | Design consequence |
| --- | --- | --- |
| Admin inbox fetches only `status = 'pending'` | `server/routes/timeEntry.ts`, `/time-entry/admin/pending` | Add a management read path covering draft, pending, approved, denied, and voided records. |
| Admin session correction resets the day to pending and replaces its sessions | `server/routes/timeEntry.ts`, `PUT /time-entry/admin/day/:id` | Replace this editor's save flow with one audited correction-and-approval transaction. |
| Break add/edit/void buttons call mutation endpoints immediately | `client/src/pages/admin/ApprovalsPage.tsx`, `saveManagerBreak`, `voidManagerBreak` | Stage break edits locally together with session edits. Cancel must cancel all edits. |
| Closed-session reads exclude `end_at IS NULL` | `fetchSessionsByDayId` and pending-list SQL in `server/routes/timeEntry.ts` | Use a separate admin detail DTO supporting nullable session ends. |
| Existing correction form converts times using the browser timezone | `openFixDialog`, `buildFixSessionsPayload` in `ApprovalsPage.tsx` | Always display and parse correction times in the work date's center timezone. |
| Payroll readers select approved days | `fetchApprovedDaysForTutor`, `fetchApprovedDaysForFranchise` in `server/routes/hours.ts` | A distinct `voided` day status naturally excludes the day; test all rollups and exports. |
| Day deletion cascades to sessions and audit history | migration `0001_time_entry_and_weekly_attestations.sql` | Never delete a day to remove counted hours. |
| The clock and scheduler share finalization logic | `server/services/clockOutFinalization.ts`, `server/services/autoClockOutScheduler.ts` | Serialize admin corrections with clock mutations and reject voided-day writes. |
| Break calculations use positioned intervals; duration-only breaks are not deducted | `server/services/timeAllocation.ts` | Display this explicitly in the preview; do not change existing pay math. |

### Product Design grounding

Product Design's index, user-context preflight, get-context workflow, and critical overrides informed this design. There is no saved Product Design context; the existing app is the reference. This is a code-grounded interaction specification, not a screenshot audit or a browser-verified visual prototype.

Use `client/src/index.css` as the active theme: `main.tsx` imports it. Reuse `AppShell`, `Card`, `Tabs`, `Table`, `Dialog`, `Input`, `Label`, `Textarea`, `Badge`, `Button`, `InlineError`, and the existing toast system. Keep Segoe UI/system typography, semantic theme colors, existing spacing, and light/dark support. The legacy `styles/tokens.css` is brand reference, not authority for replacing the active CSS theme.

Do not change global tokens, the logo, sidebar order, time-off deep links, or the extra-hours and attestation flows. Use labeled text actions and existing Lucide icons only where they help recognition.

## Screen and interaction design

### 1. Find the entry without losing the inbox

Retain `/admin/approvals` and its default pending queue. Within the Time Entry Variances tab, add a clearly labeled **Manage time entries** secondary action. It opens a management view in the same tab, with **Back to pending approvals** visible. Keep all other tabs and the franchise selector behavior intact.

URL state: `/admin/approvals?tab=timeentry&view=manage&tutorId=88&workDate=2026-09-15`. Preserve unrelated query parameters when changing these keys; only parse these keys for the time-entry tab. Support browser back/forward and existing time-off links.

| Screen area | Content and behavior |
| --- | --- |
| Header | “Manage time entries”; short description: “Find, correct, or remove a tutor's time entry.” |
| Center context | Existing enforced franchise context plus readable timezone. Changing centers resets tutor, selection, results, and drafts after a dirty-form check. |
| Filters | Tutor selector with name search; From/To dates default to the center's current pay period; status filter default “All entries”. Exact work-date lookup is also available. |
| Results | Date, tutor, state, recorded paid time, approved counted time, and “Review”. Newest work date first, tutor ID second, entry ID as stable tie-breaker; always display the tutor's readable name when available. |
| Status labels | Draft, In progress, Pending, Approved, Denied, Voided. “In progress” is derived from an open session/clock state, not a stored approval status. |
| Missing day | After selecting an eligible tutor and exact date, show “No time entry for this date” and **Add missing time**. An empty list or a failed request never proves a particular day is missing. |
| History access | Voided rows remain discoverable under All entries and Voided, with a clear “Excluded from totals” label. |
| Footer | Explicit result range and Next/Previous controls; never silently truncate at 500. |

Use a desktop table at widths at least 768px. Below that, use stacked rows with field labels and the same actions; no horizontally clipped controls. Filters wrap naturally. Use the existing page width and theme rather than adding a new dashboard shell.

The tutor selector includes active CRM tutors for new entries, plus tutors with existing time-entry records in the selected center. Inactive or unavailable identities are labeled and remain usable for reviewing/voiding/restoring existing records. New-day creation requires verified active membership in that center.

### 2. Review before editing

One detail dialog shows tutor, center, work date, timezone, status, sessions, breaks, recorded paid minutes, approved counted minutes, schedule comparison, and a History section. An open session has its actual start and **Still clocked in**, with no invented end time.

- Missing/draft/pending: **Adjust time** (or **Add missing time**).
- Approved and completed: **Adjust time**, plus **Void entry** as a secondary action. Adjustment review ends with **Save & keep approved** and warns that previously downloaded exports must be regenerated.
- Voided: **Restore entry** and History.
- Denied: History and Close.

Existing pending-row “Fix time errors” opens this same new correction editor. Existing Approve and Deny actions remain available for complete pending days; the server blocks approval with an open session or active break.

### 3. Edit sessions and breaks as one draft

Keep a single dialog with Edit and Review steps rather than stacking a review dialog over an edit dialog. Pin identity/date/timezone in the header and keep the footer visible while the body scrolls.

The Edit step includes labeled start/end controls for each session, **Add segment**, local **Remove segment**, and a staged break editor. Each existing session and break keeps its server ID; new rows use a client-only key. Removing a row here changes only the local draft. Existing voided breaks appear in read-only history, not as editable deductions.

All break changes are staged, including changing paid/unpaid treatment, completing an active break, adding a positioned break, and voiding an erroneous break. Every existing non-voided break must be accounted for in the draft, so omission cannot silently delete it.

Require a reason, trimmed to 5–2000 characters. Suggested placeholder: “For example: Tutor arrived at 3:00 PM but could not clock in.” No auto-filled reason and no mandatory preset reason taxonomy.

For an open day, show: “Saving this correction will end the clock session at the end time you enter.” Require an actual end time at or before the server's current minute. Do not copy the schedule into actual worked times automatically.

Footer: **Cancel** and **Review adjustment**. Review calls a read-only server preview; it does not write a draft row, a break, an audit event, or an approval.

### 4. Review and save

Show before/after sessions, break changes, gross time, unpaid break overlap, recorded paid time, and the change in approved counted time. Show all times in the center timezone with the work date attached. Present durations as hours/minutes, using integer minutes for calculations.

Two changes must remain distinct. A pending entry containing 4h recorded time currently contributes 0h to approved totals. Correcting it to 4h 15m changes recorded time by +15m but changes approved counted time by **+4h 15m**. Never label the +15m difference as the payroll effect.

Schedule comparison uses the existing allocation rules. Show schedule-overlap warnings, duration-only breaks not deducted, and any unavailable schedule distinctly from “No scheduled blocks.” With unavailable schedule data, paid time can still be approved; under the current allocation rules it is counted as extra/unmatched time, and the preview must say so.

Footer: **Back to editing** and **Save & approve**. Under the primary action: “This saves the correction and approves the completed day.” A reason and a valid preview are prerequisites; no second approval click follows a successful save.

Success: “Time entry corrected and approved.” Refresh the pending queue and management detail/list. Keep the selected tutor/date and filter context. History immediately includes the new correction. Other hour screens show the new values on their next refresh/navigation/focus refresh.

### 5. Void with a clear effect and a way back

Void is a whole-day action, never a trash icon that deletes a row immediately. The confirmation names the tutor, center, date, every session, and the approved paid time to be removed. Include before/after approved counted time, e.g. **3h → 0h**.

Copy: “This entry will be excluded from approved hour totals. Its times and history will be kept.” Require a reason, 5–2000 characters. Show **Keep entry** as the safe initial focus and **Void entry** as the explicit final action. Use destructive styling only on this final action, never rely on red alone to explain its meaning.

Success: “Entry voided. 3h removed from approved totals.” The detail switches to a Voided badge with the actor, time, and reason; sessions and breaks remain inspectable. Provide a persistent **Restore entry** action. A toast may link back to the detail but is not the only route to recovery.

If the original stored intervals cannot be calculated, show “Counted hours unavailable” and never pretend the delta is zero. Voiding can still remove the erroneous closed approved day; restoration remains blocked until the preserved data is valid.

All void/restore reviews include the factual reminder: “Previously downloaded payroll exports are not updated. Regenerate them if needed.” Do not claim that an export was sent, payroll paid, or a period closed; the app does not track those events.

### 6. Restore exactly what was voided

**Restore entry** opens a review of the preserved whole day and the time it will add back. Require a restoration reason and an explicit **Restore & approve** action. Restoration preserves the sessions, breaks, work date, and original approval details; it appends a separate restoration event rather than replacing history.

Only the current voided version can be restored. The server rejects changed or invalid snapshots, duplicate operations with altered content, open intervals, and active breaks. It never recreates a second day for the same tutor/date.

### Interaction states and accessibility

| State | Required response |
| --- | --- |
| Loading | Labeled loading state; mutation actions unavailable until authoritative detail loads. |
| Load failure | Inline retry; preserve filter input; never offer Add missing time based on an error. |
| Invalid time/break/reason | Specific inline error tied with `aria-describedby`; focus the first invalid field. |
| Dirty Cancel, Escape, close button, outside click, center/date change | Offer **Keep editing** / **Discard changes**; a pristine editor closes directly. Discard sends no mutation. |
| Preview pending | Keep draft visible; prevent duplicate preview; discard a response if center, date, draft, or request generation changed. |
| Back to editing | Keep every field; invalidate the old preview if anything changes. |
| Save pending | Disable edits and duplicate submission; intercept every dialog dismissal route through controlled `onOpenChange`. |
| Stale entry | “This entry changed while you were reviewing it.” Offer **Reload entry**; retain the draft for comparison, but require a new preview. |
| Save response lost | Retry the same operation ID, or fetch its outcome. Never show “Not saved” when the outcome is unknown. |
| Success | Announce through an `aria-live` region, update the status and totals, restore sensible focus. |

Use associated labels, keyboard-operable controls, visible focus, textual status labels, and a focus-trapped Radix dialog. At 375px width, stack comparison rows and footer actions with usable touch targets; use at least 44px for the new editor's touch controls. Test light and dark themes. Honor reduced motion. Do not change the shared Dialog globally merely to support this feature.

## State rules

Stored day status expands to `draft | pending | approved | denied | voided`. Derive Missing and In progress only for presentation.

| Current state | Operation | Result | Approved contribution |
| --- | --- | --- | --- |
| Missing | Create complete corrected day | Approved | Adds computed paid minutes |
| Draft or Pending, including an open session | Correct and explicitly complete day | Approved, clock state 0, no active break | Adds computed paid minutes |
| Approved and closed | Void | Voided, original details retained | Becomes 0 |
| Voided and valid | Restore | Approved, original details retained | Adds preserved paid minutes |
| Approved and closed | Correct | Approved with updated sessions/breaks and audited original approval | Replaces counted amount; increases or decreases by the reviewed delta |
| Approved with an open session/active break | Correct or Void | Reject | Unchanged |
| Denied | Correct/void/restore | Reject | Unchanged |
| Voided | Tutor save, submit, break mutation, clock action, or scheduler finalization | Reject or scheduler skip | Remains 0 |

All admin mutations are center-scoped and authenticated as ADMIN. The server derives the actor from the session. Existing franchise-selection policy remains authoritative; tutor and day lookups independently enforce the effective center.

## Data and API design

### Modules and record preservation

Introduce a dedicated `server/services/adminTimeEntry/` module and `server/routes/adminTimeEntry.ts`. Reuse `computeTimeAllocation`, `computeTimeEntryComparisonV2`, server schedule snapshots, and existing auth/scope middleware. Keep the new admin DTO separate from the tutor's closed-session contract.

Reuse `time_entry_days`, `time_entry_sessions`, `time_entry_breaks`, and `time_entry_audit`. No hard-delete endpoint is added. Void/restore change only the day status/update timestamp and append audit records; they do not delete or rewrite sessions, breaks, or earlier decisions.

For a correction, retain existing session IDs where possible and update them in place. Insert new segments. A deliberately removed segment can be removed from the active sessions table only after its complete original representation has been captured in the same transaction's audit snapshot. Reassign break/session links against the final sessions; preserve every existing break row, using its existing `voided` status for staged break removals. Day and audit rows are never deleted.

Migration `0015_admin_time_entry_operations.sql` adds nullable `operation_id UUID` to the audit table and a unique partial index for non-null operation IDs. Old audit rows stay valid. The stored day status is currently unconstrained text, so no table rebuild or historical-status rewrite is necessary for `voided`.

The one final operation audit event stores metadata version 1, source `admin_time_entry`, actor/center/date, reason, stable command hash, full before/after day/session/break snapshots, previous approval details, counted-minute effects, schedule provenance, and the operation ID. Actions: `admin_corrected_approved`, `admin_voided`, `admin_restored`. Store no preview secrets or authentication tokens. Extend `wasEverApproved` history queries to include the correction/restoration actions.

### Reads

All paths are under `/api/time-entry/admin`:

| Method/path | Contract |
| --- | --- |
| `GET /tutors?franchiseId=&search=&cursor=&limit=` | Active center roster plus identities with existing center entries; `items`, `nextCursor`. Limit default 50, maximum 100. Distinguish inactive/history-only tutors. |
| `GET /days?franchiseId=&start=&end=&tutorId=&status=&cursor=&limit=` | Stored days with derived open/closed state and minute totals; `items`, `nextCursor`. Default limit 50, maximum 100; date range maximum 93 days. |
| `GET /tutor/:tutorId/day/:workDate?franchiseId=` | One consistent aggregate, including effective franchise ID, open sessions and all breaks, nullable day, revision, timezone, and allowed actions. Missing returns 200 with `day: null` only after successful lookup. |
| `GET /day/:id/history?franchiseId=&beforeId=&limit=` | Newest first by audit ID, paginated; readable actor/action/reason and before/after changes. Limit default 20, maximum 100. Older events may have partial data and must be labeled accordingly. |
| `GET /operations/:operationId?franchiseId=` | Current admin's scoped recorded operation result, or 404. Used to resolve a lost mutation response. |

Date strings remain `YYYY-MM-DD`; serialize PostgreSQL DATE values without a browser timezone round trip. Use the stored day timezone for an existing record, or resolved center timezone for a missing day. Keep the selected timezone authoritative throughout preview and commit.

Use a short repeatable-read, read-only PostgreSQL transaction for detail aggregates so day, sessions, breaks, and last audit ID describe the same state. Finish it before external schedule/identity requests. List rows can use a consistent read transaction with batched session/break queries. Never omit open sessions from the admin aggregate.

An existing record carries a server-generated `revision`, a SHA-256 hash of canonical persisted day fields, sorted sessions/breaks, and latest audit ID. Include actual nullable ends, clock state, status, decision fields, timestamps, and stored snapshot/comparison; exclude recomputed comparison timestamps, display names, and current elapsed-time estimates. A missing day has revision `missing`. This avoids relying on JavaScript's millisecond timestamp truncation for concurrency checks.

### Preview and commit

- `POST /corrections/preview`: `{ franchiseId, tutorId, workDate, expectedRevision, sessions, breaks, reason }`.
- `POST /day/:id/void/preview`: `{ franchiseId, expectedRevision, reason }`.
- `POST /day/:id/restore/preview`: `{ franchiseId, expectedRevision, reason }`.
- `POST /operations`: `{ franchiseId, operationId, previewToken }`.

Preview validates the whole candidate and returns `{ previewToken, expiresAt, review, before, after, recordedDeltaMinutes, approvedDeltaMinutes, warnings }`. The `review` object supplies the original entry, normalized correction when applicable, action, work date, timezone, and reason for the visual before/after step; the UI does not decode the token to obtain display data. Totals are nullable when the original stored data is invalid; correction after-totals must always be valid. The token contains the exact normalized command and server-selected schedule snapshot, signed using the existing server secret with a dedicated signing-purpose prefix. It is bound to the admin ID, effective franchise, tutor, date, expected revision, and a ten-minute expiry. Do not log tokens.

Commit accepts the signed preview rather than trusting client-supplied totals/status/actor. Revalidate session authority, scope, token integrity, date/time limits, current lifecycle state, and the current aggregate revision. Use the captured schedule snapshot shown in that preview, not a newly fetched schedule that could change the confirmed effect.

Operation IDs are client-created UUIDs stable across retries of the same confirmed preview. Store exactly one final audit event per operation. An identical retry by the same scoped actor returns the recorded result and does not reapply a write. Reusing an ID with a different command or actor returns a conflict, without disclosing another actor's data. A committed operation can be recovered even when its preview has since expired; validate token integrity and identity, then resolve the existing operation before enforcing expiry for a new write.

### Transaction and concurrency rules

1. Resolve all MSSQL schedule/roster needs during reads/preview, outside a PostgreSQL write transaction. Missing-day creation requires a fresh verified active-center roster identity at preview; its evidence expires with the ten-minute token. An existing record's center/tutor relationship is authoritative for history and void/restore even if CRM is unavailable.
2. Authenticate and validate the operation envelope. Look up a previous operation under the same actor/center before starting a new mutation.
3. Lock the existing day `FOR UPDATE` before reading or changing sessions, breaks, or audit records. For creation, insert only when the preview expected `missing`, using `ON CONFLICT DO NOTHING`; a different creator winning returns `409 ENTRY_CHANGED`. An identical retried create resolves its recorded operation.
4. Recheck replay after acquiring the day lock, then read all children and latest audit ID and compare the revision. Every existing day mutation path, including tutor session saves/submits, admin decisions, break changes, manual clock, and the automatic worker, must take the parent day lock before child writes.
5. Recheck action eligibility and validate the final sessions/breaks. For correction, persist changes, set `status = 'approved'`, `clock_state = 0`, `decided_by = admin`, `decided_at = server now`, and the reason. Retain any previous submission timestamp; initialize it for a missing/unsubmitted day.
6. For void/restore, preserve original submission/approval fields and child rows; set only the lifecycle status/update timestamp. Restoration appends its own actor/time/reason without pretending to be the original approval.
7. Insert the final audit snapshot with `operation_id`, then commit. Any validation, child-write, audit, or unique-operation error rolls back the entire change. Use a final refetch for canonical response data after any session IDs/link mappings change.

No ordinary clock-in/out action or worker pass can resurrect a voided day. Approved follow-up: explicit tutor replacement can reopen the same day as pending only when bound to its current admin void audit ID. It archives the original aggregate in audit history and replaces active sessions/breaks atomically; it does not restore them. Parent locking plus a voided-state guard is mandatory on all ordinary writers, not just in the admin UI. Concurrent requests that lose a race reload instead of overwriting later work. Two separate create attempts must never merge their sessions.

### Validation and failure contracts

- Positive integer tutor/day/franchise IDs; validate resolved center as well as request syntax.
- Corrections have 1–20 complete, minute-aligned, non-overlapping sessions within the work date in the authoritative timezone. No blank end time, future end time, or zero/negative duration.
- New/edited timed breaks are minute-aligned, positive, and wholly inside one final session; require explicit session reassignment when a segment is removed. No active breaks survive approval. Existing duration-only or partially outside-session breaks can be preserved with the existing allocation warnings; never silently deduct them differently. Newly created duration-only breaks are not offered.
- Break arrays are capped at 100 items; preserve all existing IDs or explicitly stage a void. Reject foreign, duplicated, missing, or tampered child IDs. New breaks use source `manager`; existing sources remain intact and the audit records the admin edit.
- Use explicit UTC-offset timestamps at the API boundary. Client inputs use the day timezone; reject nonexistent daylight-saving times and require an explicit offset choice for an ambiguous repeated hour. Do not invoke clock Time Snap for a manually entered correction.
- Schedule provenance is `stored`, `current`, `unavailable`, or `none`. Prefer a valid matching stored snapshot; otherwise fetch a center-scoped snapshot. Distinguish a failed fetch from an empty successful schedule. Preserve original snapshots in audit history.
- A fresh active-roster lookup failure blocks new-day creation with retryable 503. It does not block correction/void/restore of an existing scoped day solely because the schedule or CRM is unavailable.
- Error envelope: `{ error, code, fieldErrors? }`. Codes include `INVALID_INPUT` (400), `ENTRY_CHANGED` (409), `INVALID_ENTRY_STATE` (409), `PREVIEW_EXPIRED` (409), `OPERATION_CONFLICT` (409), `ADMIN_CORRECTION_REQUIRED` (409), and `ROSTER_UNAVAILABLE` (503). Use existing auth 401/403 conventions and 404 for out-of-scope records. Never expose SQL or token contents.

## Integration and compatibility

The new admin flow owns staged session/break correction. Retire the old immediate-write admin correction and break routes from the UI. Keep their routes authenticated/scoped but respond with `409 ADMIN_CORRECTION_REQUIRED` and “Reload the entry to use the correction editor” for legacy bodies. Never leave a second bypass that resets a correction to pending or overwrites a voided day.

Ordinary pending approve/deny stays supported with parent locking, fresh state checks, and complete-day validation. Tutor editing of active approved days continues its existing invalidation-to-pending policy; voided days are specifically protected.

Add `voided` to the relevant time-entry status contracts and scheduler normalizer; use a dedicated time-entry badge rather than extending the time-off `RequestStatus` union. Tutor calendar/history shows “Voided by admin — excluded from totals” and blocks ordinary entry/break editing. Approved follow-up: calendar replacement starts blank and requires confirmation; today's clock-in offers an explicit fresh-session confirmation. Both reopen as pending and retain normal schedule-based submission/clock-out approval and weekly attestation. Old hours and breaks remain excluded and visible in admin before/after audit history. Restore remains available only until replacement. Admin correction does not fake a tutor's attestation.

Payroll counts only `approved`. Retain the existing SQL predicate and demonstrate through tests that weekly, monthly, pay-period, comparison-detail, legacy clipboard, CSV, and Excel paths exclude voided hours and include restored hours once. CRM reported hours and schedules are not modified; a void may legitimately create a CRM-versus-logged difference. Future reads/exports update; already downloaded files do not.

The client refreshes mounted approval/management data after successful mutation and reloads detail on focus before a new mutation. Pay-period summary/detail refresh on window focus so returning from an admin correction reflects current data. Avoid optimistic payroll changes before the server confirms success.

## Acceptance examples

| ID | Scenario | Observable result |
| --- | --- | --- |
| A1 | Tutor never clocked in yesterday | Successful exact lookup shows missing; admin adds actual sessions/reason, reviews and saves; one approved day exists. |
| A2 | Draft has one closed segment and one open segment | Both appear; admin supplies the real end and resolves its break; save closes and approves the full day. |
| A3 | Pending 4h changed to 4h 15m | Review distinguishes +15m recorded from +4h 15m approved; save removes the pending row. |
| A4 | Admin adjusts or voids a break then cancels | No sessions, breaks, statuses, or audit rows change. |
| A5 | Approved day is erroneous | Whole-day void review shows the removed minutes; confirmation retains raw children/history and excludes its hours. |
| A6 | Admin voided the wrong day | Persistent Restore action returns exactly the preserved hours once and records the restoration. |
| A7 | Tutor clocks out after admin loaded the form | Stale preview/commit returns a reload conflict; no overwrite or duplicate approval. |
| A8 | Two admins create the same missing day | One succeeds; the other reloads the existing day; no second day or merged segments. |
| A9 | Commit succeeds but response is lost | Same operation retry or operation lookup recovers success; one final audit event and one mutation. |
| A10 | Locked-center admin supplies another center's tutor/day | Effective center enforcement and record membership prevent access or mutation. |
| A11 | Browser timezone differs from center / DST transition | Display and saved timestamps remain correct; invalid/ambiguous wall times cannot silently shift. |
| A12 | Existing day has no available schedule | Review states unavailable and unmatched-time allocation; admin can approve actual validated paid time. |
| A13 | Legacy client or scheduler touches voided day | Legacy correction is redirected to modern workflow; tutor/clock writes reject; worker skips. |
| A14 | Voided day appears in payroll views and exports | Logged contribution is 0 everywhere; restore returns original contribution exactly once. |
| A15 | Existing historical tutor is inactive | Entry history and void/restore remain available; new missing-day creation is disallowed. |
| A16 | Preview is edited, expired, or from another admin | Server refuses the new commit; draft is retained and can request a new preview. |

## Delivery and review

Implement the plan in ordered increments: policy/contracts; aggregate reads; preview and atomic mutations; existing-writer guards; staged admin UI; payroll/tutor integration; regression and visual checks. A deployed release must contain the writer guards before exposing void/restore.

GitNexus impact probes were run for `ApprovalsPage`, `adminEditTimeEntryDay`, `fetchDayByWorkDate`, `mapDayRowToResponse`, `finalizeClockOutInTransaction`, and `fetchApprovedDaysForFranchise`. The index was rebuilt successfully; MCP still reports `UNKNOWN`/incomplete callers for these probes. This is not a low-risk result. Source checks confirm the touched flows include pending review/edit, tutor save/submit/break creation, manual and automatic finalization, and approved-hour summaries/exports. Re-run impact per edited symbol on the implementation checkout and report the real blast radius; use CLI fallback if MCP retains obsolete index handles.

Preserve the currently dirty clock-out work. Do not run migrations, connect tests to production databases, deploy, or commit unrelated files during this planning pass. For implementation, use disposable PostgreSQL integration tests and fake CRM dependencies. After voided records exist, do not roll back to a binary that lacks voided-state guards; disable mutation entry points and roll forward with a fix while retaining the data.

Visual verification is still required during implementation at 375px and desktop widths, light/dark modes, keyboard-only use, all dialog dismissal routes, and server-conflict/error states. This specification does not claim those checks have run.
