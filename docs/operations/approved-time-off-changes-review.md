# Approved time-off changes: final review

Reviewed 2026-10-07, inline, without subagents. Scope: `85249b1..0881366` (nine feature commits), followed by the final fix pass. Older commits in `main..HEAD` were excluded. Authority: the approved-change spec, nine-task plan, operations runbook, and every `Ruling:` in the implementation ledger.

## Strengths

- The parent approval stays effective during a proposal. Immutable operation receipts, scoped idempotency keys, version checks and transactional audit/ledger writes make retries and competing decisions predictable.
- The accounting suite uses real PostgreSQL, including shared profiles, entitlement cycles, disabled centers, concurrent writers, refunds and original approval compatibility. Refunds use recorded allocations.
- Calendar recovery IDs are committed before delivery. Fake-provider tests kill a real PostgreSQL worker connection after remote success, exercising recovery across the actual transaction boundary.
- Roles and center scope are enforced on the server. The client uses server actions, separate amendment decisions, and version conflicts rather than assuming permission from a card's status.

## Issues

### Critical — fixed

1. **The deployed audit CHECK rejected every feature mutation.** The local fixture omitted Neon's `time_off_audit_action_check`. A read-only schema inspection confirmed that only the ten legacy actions were allowed; actor type is unrestricted text. The fixture now includes that CHECK, and migration `0017_time_off_change_review_fixes.sql:3` preserves its existing expression while permitting the seven feature actions. Before the fix, the lifecycle suite failed with SQLSTATE 23514; it now passes. Deploying only 0016 is insufficient.
2. **Calendar work could outlive its lock and resurrect cancelled leave.** `server/services/timeOffChangeDelivery.ts:458` previously raced an uncancelled provider promise against a timer. Insert/lookup and token acquisition were not covered by request timeouts. The worker now aborts the whole sequence and its transports, awaits settlement under the parent lock, and checks cancellation between calls. `server/services/googleCalendar.ts:89` applies deadlines to token acquisition and every event method. Regression tests prove expired work cannot start a later mutation.
3. **An older retry could run after a newer cancellation was sent.** The worker selected only pending targets, missing a sent/failed newer target. `server/services/timeOffChangeDelivery.ts:405` now fences pending work against every newer calendar target. A PostgreSQL regression reproduces the stale retry and proves it cannot recreate the leave event.

### Important — fixed

1. **A newer edit could duplicate an event recovered by a crashed older edit.** `server/services/timeOffChangeDelivery.ts:49` now finds and adopts the owned recovery event from the earlier attempt before creating another. The crash/new-edit regression finishes with one event containing the newer dates.
2. **Legacy reason-only PTO edits could require false reconciliation or charge untracked leave.** `server/db/migrations/0017_time_off_change_review_fixes.sql:21` replaces the UTC fallback with center-local date resolution and recognizes legacy timed records without normalized date metadata. Evening leave crossing UTC midnight and old false partial-day flags now permit a reason-only edit with no ledger entries or inferred refund.
3. **Ambiguous fall-back times depended on the server's current season.** `server/services/timeOffChangePolicy.ts:22` explicitly selects the earlier possible UTC occurrence. A test with Luxon's clock set to winter first reproduced the incorrect one-hour shift, then passed with the correct offset.
4. **A command could change or cancel leave after waiting past its start.** `server/services/timeOffChanges.ts:148` advances the command clock through dependency and lock waits, rechecks after the parent lock, and checks the earliest applicable start before commit. A blocked-connection test leaves the approval intact after its start deadline passes.
5. **A refreshed request could reuse its previous preview.** `client/src/components/time-off/TimeOffChangeEditor.tsx:49` now ties previews to request version as well as draft fields. Drafts survive refresh, saves require a fresh preview, and a newer version discovered during preview gives an explicit refresh message. Both hosts expose Refresh details without discarding the draft.
6. **Tutor requests outside the initial detail batch were unreachable; late dialog reads could replace another request's draft.** `client/src/pages/tutor/TimeOffPage.tsx:103` retains the initial bound but gives remaining approved/cancelled cards an explicit detail action. Dialog reads use a generation guard. Tests cover the 21st approval and an older response arriving after another dialog opens.
7. **Navigation could retain the wrong request or discard a draft.** `client/src/pages/admin/time-off/TimeOffManagement.tsx:76` follows same-center request/amendment link changes. The host clears request IDs on center selection, defers cross-center link targets until confirmation, and protects drafts during tab and center navigation. Review denial drafts participate in the guard. Tests cover same-center links, changed centers, late old-center responses, and declining to discard a denial draft.

### Minor — deferred

- `client/src/pages/tutor/TimeOffPage.tsx:103`: up to 20 detail GETs still run on initial load. Additional requests are reachable now; batching the initial reads remains an optimization.
- `client/src/pages/admin/time-off/TimeOffManagement.tsx:418`: an obsolete amendment deep link hides decision buttons without explaining the mismatch. The server ID/version checks prevent approving the wrong amendment; reopening the current queue item provides the current actions.
- `server/index.ts:66` / `server/services/timeOffChangeDelivery.ts:548`: an instance without database configuration logs a failed pass every 30 seconds. This is development/operations noise, not lost business work.
- `client/src/pages/admin/time-off/TimeOffManagement.tsx:100`: the amendment queue and failure summary display their first page. Management search and per-request detail remain available; processing the first queue page exposes subsequent items on refresh. Dedicated pagination is deferred.

## Review Focus

| Case | Evidence and result |
| --- | --- |
| Notice window | Policy tests verify reductions and reason-only edits inside notice, refusal of newly covered dates, exempt types, and proposal submission time during approval. No regression found. |
| Untracked / zero-charge / disabled-profile PTO | PostgreSQL tests verify actual consumed-allocation credits, cross-cycle sufficiency, disabled-center reductions and cancellation, linked/detached profiles, and zero-charge versus untracked leave. Added legacy local-date regressions. |
| DST and day format | Winter-clock regression now pins the earlier ambiguous occurrence; existing tests reject gaps and preserve full-day exclusive ends. Calendar patches clear incompatible date/dateTime fields and preserve unrelated fields. |
| Crashes / cancellation / two instances | Real transaction/crash tests cover replay, two workers, uncertain recovery cleanup and exactly-once accounting. Added newer-edit recovery adoption, expired provider sequences, stale retries after sent cancellation, and lock-wait start deadlines. |
| Center / stale tab / draft | Server scope and amendment ID/version tests remain green. Added version-bound previews, tutor dialog race protection, same-center navigation, center-link cleanup and dirty denial navigation tests. |

## Rulings and recommendations

- **Request locks during calendar calls:** retain the spec's serialization design. The repaired transport deadlines bound normal production attempts; business commands for that request can still wait up to the attempt deadline. Replacing this with leases or fencing at Google would require a different delivery protocol. Cost if wrong: visible command latency during slow provider calls.
- **Email delivery is not exactly-once:** retain the documented at-least-once behavior. The provider can accept an email before the transaction's completion record survives a crash. Cost if wrong: duplicate historical notification, not a repeated PTO action.
- **Admin preview of their own request returns 403:** retain the self-edit restriction. The endpoint previews an admin edit; own-request detail and cancellation remain available. Cost if wrong: no admin-mode quote for their own edit.
- **Ledger rulings:** retain the other recorded decisions. In particular, the old PTO suites intentionally keep their legacy fixtures, while the feature suites test replaced functions and lock order through the new migrations. The local browser harness evidence does not establish real login or provider transport behavior. The earlier audit-constraint and UTC-fallback assumptions are superseded by this fix pass.
- Apply **both 0016 and 0017** before enabling the feature. Verify the authorized deployed schema again during rollout; the read-only check here made no production changes. Continue to use the feature flag and the operations runbook.

## Verification

- `npm run typecheck`: passed.
- `npm test`: server 435 passed, 68 DB-gated skipped; client helpers 27 passed; client UI 131 passed; load tools 5 passed.
- `npm run build`: passed; existing bundle-size warning remains.
- Runbook feature PostgreSQL command: **70/70**, no skips.
- Runbook legacy PTO PostgreSQL command: **40/40**, no skips.
- Each fix has a failing regression before implementation, with RED/GREEN evidence and the final suite totals recorded in `.superpowers/sdd/2026-10-07-approved-time-off-changes/progress.md`.

## Declined to judge

- Real MSSQL login: not exercised by this pass or the earlier throwaway browser harness; needs the authorized authentication environment.
- Real Google Calendar/Gmail acceptance and timing: deterministic local transports and race tests do not establish live behavior; stage a provider smoke test before rollout.
- Older shared-PTO/admin-time-entry features outside `85249b1..HEAD`: excluded at the user's direction; their relevant regression suites passed.

## Assessment

**Ready to merge? Yes.** The reproduced Critical and Important findings are fixed and covered by regressions. Deployment still requires migration 0017 as well as 0016 and the real-environment checks above; no deployment or live provider mutation occurred in this review.
