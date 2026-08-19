# Shared Cross-Center PTO Implementation Plan

> **Follow-up:** Persistent default-off cross-center account discovery and remembered per-center link controls are specified in `docs/superpowers/specs/2026-08-19-persistent-cross-center-pto-profile-linking-design.md` and planned in `docs/superpowers/plans/2026-08-19-persistent-cross-center-pto-profile-linking.md`. The completed tasks below remain the baseline implementation history.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add one auditable PTO balance per verified person across every linked, PTO-enabled center.

**Architecture:** PostgreSQL owns the balance invariants through normalized identity tables, append-only ledger entries, request allocations, and trigger-backed lifecycle transitions. Express owns CRM synchronization, authorization, profile administration, and quote APIs; React exposes center activation, PTO management, tutor balances, and alternate emails.

**Tech Stack:** PostgreSQL/Neon migrations and PL/pgSQL, Express + TypeScript, React + TypeScript, Node test runner, Vitest/Testing Library.

## Global Constraints

- Default entitlement is 5 days; the first policy renews January 1 with no carryover.
- One confirmed person has one balance across centers; exact-name matches remain pending until confirmed.
- Reserve on submission, consume on approval, release on denial or pending cancellation.
- Weekdays cost 1, Saturday 0.5, Sunday 0; same-day partials through 4 hours cost 0.5 and longer partials cost 1; multi-date partial boundaries cost 0.5.
- Existing PTO rows created before first center activation never consume the new entitlement.
- Global policy changes are database-only, future-effective versions.
- Admin adjustments use 0.5-day increments and require a reason.
- Public matching is center plus normalized email and must resolve exactly one active profile; public quote responses never expose raw balances.
- PTO is disabled by default for every center.
- Follow AGENTS.md: run GitNexus upstream impact before editing existing symbols and detect_changes before commits.

---

### Task 1: PTO Calculation and Database Foundation

**Files:**
- Create: `server/services/ptoCharge.ts`
- Create: `server/tests/ptoCharge.test.ts`
- Create: `server/db/migrations/0010_shared_pto.sql`
- Create: `server/tests/ptoMigration.test.ts`

**Interfaces:**
- Produces `calculatePtoCharge(input): PtoChargeQuote` for application previews.
- Produces normalized PTO tables, cycle/charge functions, ledger transitions, allocations, and request triggers.

- [x] Write charge-matrix and migration-contract tests and verify they fail.
- [x] Implement the TypeScript charge calculator and additive PostgreSQL migration.
- [x] Run focused tests, server typecheck, and self-review.
- [x] Commit the independently testable database foundation.

### Task 2: PTO Profiles, Roster Sync, Aliases, and Ledger Services

**Files:**
- Create focused modules under `server/services/pto/` for policy, profiles, sync, aliases, emails, balances, and audit.
- Create corresponding focused tests under `server/tests/`.

**Interfaces:**
- Consumes Task 1 schema and charge types.
- Produces activation preview/sync, profile lookup, paginated management data, merge/split, email management, and adjustment services.

- [x] Write failing service tests for idempotent sync, grants, pending name matches, merge/split, email ambiguity, and adjustments.
- [x] Implement minimal services with dependency-injected MSSQL/PostgreSQL boundaries.
- [x] Run focused tests and server typecheck.
- [x] Commit the server domain layer.

### Task 3: PTO Routes and Time-Off Lifecycle Integration

**Files:**
- Create: `server/routes/pto.ts`
- Modify: `server/routes/timeoff.ts`, `server/index.ts`, and related time-off types/repositories.
- Test: PTO route and existing time-off route suites.

**Interfaces:**
- Produces authenticated/admin/public quote and management APIs.
- Extends the time-off policy payload with PTO eligibility/balance and maps expected database PTO errors to 409/422 responses.

- [x] Run GitNexus impacts for every existing route/type/repository symbol before editing and report risk.
- [x] Write failing route/lifecycle tests for scope, quotes, zero/insufficient balance, both request sources, activation/deactivation, and error mapping.
- [x] Implement routes and lifecycle integration.
- [x] Run focused tests, full server tests, and typecheck.
- [x] Commit the API slice.

### Task 4: Admin Activation and PTO Management UI

**Files:**
- Modify the admin settings/API types and app navigation.
- Create a focused PTO Management page and supporting components/models/tests.

**Interfaces:**
- Consumes Task 3 admin APIs.
- Produces activation preview/confirmation, roster/alias/audit views, profile detail, emails, detachment, and adjustments.

- [x] Run GitNexus impacts for existing client symbols before editing and report risk.
- [x] Write failing component/helper tests for activation, center scoping, sync failures, pagination, alias actions, and adjustments.
- [x] Implement the admin experience with confirmation and stale-data states.
- [x] Run focused UI tests, client typecheck, and accessibility-focused assertions.
- [x] Commit the admin UI slice.

### Task 5: Tutor Balance, Quotes, Alternate Emails, and Public Contract

**Files:**
- Modify the tutor time-off page, client API/types/helpers, and tests.
- Add public-form integration documentation.

**Interfaces:**
- Consumes Task 3 tutor/public APIs.
- Produces balance display, quote-aware paid-option behavior, alternate-email management, and the external quote/rejection contract.

- [x] Run GitNexus impacts for existing tutor/client symbols before editing and report risk.
- [x] Write failing helper/UI tests for hidden PTO, insufficient balances, cycle splits, and email ambiguity.
- [x] Implement tutor UI and public integration documentation.
- [x] Run focused client tests, client typecheck, and time-off regression tests.
- [x] Commit the tutor/public slice.

### Task 6: Full Verification and Rollout Documentation

**Files:**
- Update README/schema preflight/operations documentation as required by the finished interfaces.

**Interfaces:**
- Produces deployment order, disabled-by-default rollout, public-client prerequisite, pilot reconciliation, and rollback guidance.

- [x] Run schema migration validation against a disposable PostgreSQL database when available; do not apply to production.
- [x] Run `npm test`, `npm run typecheck`, and `npm run build`.
- [x] Run GitNexus `detect_changes` and review all affected flows.
- [x] Update docs, run final review, and commit verification/documentation.
