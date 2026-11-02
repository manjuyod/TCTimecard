# Voided Break History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Allow existing breaks to be voided with their historical timestamps and keep restoration strictly validated.

**Architecture:** Add a preservation branch to the existing correction validator. Exercise the real preview, token, allocation, and commit paths with fixtures; retain existing persistence and UI behavior.

**Tech Stack:** TypeScript, node:test, Luxon, PostgreSQL 17 in disposable Docker containers.

**Spec:** `docs/superpowers/specs/2026-11-02-voided-break-history-design.md`

## Global Constraints

- Never query CRM. Never write to Neon. Integration tests use disposable local PostgreSQL only.
- No production data repair, migration, deployment, new restore UI, or clock-creation changes.
- Use existing dependencies and preserve unrelated workspace work.
- Run GitNexus impact before edits and complete change analysis before committing.

## Review Focus

1. Previously voided breaks survive subsequent corrections and whole-day restoration.
2. Explicit restoration of legacy duration-only/outside-session breaks cannot use preservation exemptions.
3. Foreign IDs, duplicate IDs, omitted existing breaks, and fabricated/edited voided histories remain rejected.
4. Historical timestamps retain exact precision through normalization, signed previews, persistence, and audit.
5. Removing an active break retains its established behavior; voiding a positioned unpaid break restores its deducted minutes.

## Task 1: Preserve voided history and enforce restoration validation

**Files:**
- Modify `server/services/adminTimeEntry/policy.ts`.
- Create `server/tests/adminTimeEntryVoidedBreaks.test.ts`.
- Create `server/tests/adminTimeEntryVoidedBreaks.integration.test.ts`.

**Interfaces:** Consume `normalizeCorrection(input, { day, timezone, now })`,
`previewCorrection`, `verifyAdminPreviewIntegrity`, and `commitAdminOperation`.
Keep `NormalizedCorrection` and all public signatures unchanged.

- [x] Add policy regressions for a next-day break removed from October 26, repeat
  voids, exact stored timestamp preservation, invalid identities/edited history,
  zero deduction, valid restoration, and invalid date/session/duration-only restoration.
- [x] Add a disposable PostgreSQL regression covering preview, commit, audit,
  repeated correction, and whole-day void/restore with roster/schedule stubs.
- [x] Run the new tests and observe the expected work-date/restore failures.
  Command: `node --test --import tsx server/tests/adminTimeEntryVoidedBreaks.test.ts`.
- [x] In `normalizeCorrection`, preserve original start/end values for an
  unchanged existing break submitted as voided. Treat voided-to-completed
  transitions as restoration for duration-only and containment validation.
- [x] Run the unit regression and the existing admin policy/preview/token suites.
  Expected: all pass, including active-break removal.
- [x] Run local integration regressions with `RUN_TIME_ENTRY_POSTGRES_TESTS=1`.
  Expected: persisted void, unchanged timestamps and audit history, correct
  totals, repeat correction, and whole-day restore all pass.
- [x] Run the related admin suites and `npm run typecheck`; review the full diff.
- [x] Obtain an independent review; address substantive findings with regression tests.
- [x] Run complete GitNexus change analysis and prepare only this task's files for a local commit.

## Execution record

- Baseline: 22 existing policy/preview/token tests passed.
- Impact: HIGH; direct callers are previewCorrection, commitAdminOperation, and
  validPreservedEntry. Seven symbols and four process groups are affected.
- Workspace: local branch `fix/voided-break-history` in the existing checkout.
  User's execute instruction covers this bounded fix; no additional approval gate.
- Pre-flight: one task; no cross-task interfaces.
- RED: new policy regressions had seven failures and one pass; disposable
  PostgreSQL regression failed at historical timestamp validation.
- GREEN: all 30 focused unit tests and the disposable PostgreSQL regression pass.
  The integration test checks idempotent saves, exact microsecond timestamps,
  before/after audit snapshots, subsequent correction, and whole-day restoration.
- Typecheck: server and client passed. No CRM or Neon access during implementation.
- Related suite: `RUN_TIME_ENTRY_POSTGRES_TESTS=1 node --test --test-concurrency=2
  --import tsx "server/tests/adminTimeEntry*.test.ts"` passed 56/56, zero skipped.
  Existing operation, repository, payroll, export, and route coverage passed.
- GitNexus `detect_changes({scope: "all"})`: complete, five changed files, two
  indexed symbols, medium change risk, no partial/truncated flags. The earlier
  HIGH impact warning remains relevant to the shared validator.
- Independent review: no production-code findings and no declined judgments.
  Strengthened the integration test with fixed microsecond timestamp expectations
  and end-time assertions through preview and audit; the test passed again.
- Test-file impact was UNKNOWN because the new file was not indexed. Text search
  confirmed it has no production consumers; it is discovered by the test glob.
- Task 1 complete. Ready for local commit; no deployment or production data edits.
