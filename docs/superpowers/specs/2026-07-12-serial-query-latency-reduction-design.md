# Serial Query Latency Reduction Design

**Date:** 2026-07-12

**Status:** Approved in conversation

## Goal

Reduce the database queueing observed in the 200-user load test without changing the monolithic Replit architecture, adding caches, changing database schemas, or optimizing for substantially more than 200 concurrent users. The expected normal clock-in/clock-out burst is approximately 30 tutors, with 200 users remaining the maximum comfort target.

## Scope

This change implements the first three optimizations from the read-only query audit:

1. Throttle forced `lastSeenAt` session saves.
2. Avoid pay-period override queries when a route only needs the franchise timezone.
3. Run independent read queries concurrently where their results do not depend on one another.

No production SQL, migrations, indexes, database writes, authenticated production requests, or load tests are part of this implementation. Any later diagnostic or production SQL will be written to a file and executed manually by a human.

## Session Activity Writes

Authenticated requests currently assign a new `lastSeenAt` value and synchronously save the complete session on every request. Rolling session expiry already allows the session store to touch the expiry after a response.

The middleware will persist `lastSeenAt` only when it is missing, invalid, or at least 60 seconds old. Requests within that interval will continue immediately without an explicit full-session save. The existing rolling-cookie and session-store touch behavior remains unchanged.

The interval is an in-process constant, not a new environment variable. Sixty seconds is sufficiently accurate for internal activity tracking and avoids adding configuration that is unnecessary for the 200-user target.

If the required save fails, the middleware will preserve its existing error behavior. A skipped save cannot fail because it performs no explicit persistence operation.

## Timezone Resolution

Routes that need only a timezone will call the existing `getFranchisePayrollSettings(franchiseId)` function and return its normalized `timezone`. They will not call `resolvePayPeriod`, so they will not query pay-period overrides.

Routes that calculate an actual pay period will continue using `resolvePayPeriod`; override semantics remain unchanged. Clock mutation routes that require a pay-period boundary for validation also remain on the complete resolver. Only timezone-only reads are changed.

## Concurrent Read Queries

After approved day IDs are known, session and break batch queries are independent. They will be awaited together with `Promise.all` in the hours read paths, including tutor totals, admin summaries, drilldowns, and exports.

For exports, the CRM pay-period summary and CRM daily-detail aggregate are independent after the pay-period inputs are known and will run concurrently. Tutor-name lookup remains dependent on the union of IDs returned by those reads.

Clock-state reads will not issue concurrent commands through one checked-out Postgres client. Where safe concurrency would require additional pool clients or a transaction-boundary change, the code will retain serial behavior in this pass. The timezone-only optimization still reduces its query count. This avoids increasing connection pressure or weakening lock semantics.

Admin pending-entry concurrency is excluded from this pass because it spans several result-shaping and audit semantics in a large route. It can be evaluated separately if the focused load test shows that admin pending routes remain material.

## Testing

Implementation follows test-driven development:

- Middleware tests prove that recent valid activity skips the explicit save, stale activity saves once, and missing or invalid activity saves once.
- Hours-route query spies prove timezone-only endpoints do not query overrides while pay-period endpoints retain override behavior.
- Deferred query controls prove session and break reads begin before either is resolved, while response data remains unchanged.
- Export tests prove both independent CRM aggregates are in flight concurrently and the existing export output remains correct.
- The complete server and load-tool test suites, typecheck, and build run after focused tests pass.

## Rollback

The three changes are isolated and reversible:

- Restore per-request `lastSeenAt` saves if activity reporting requires sub-minute precision.
- Restore `resolvePayPeriod` in timezone-only helpers if a hidden dependency on override resolution is discovered.
- Restore sequential awaits if concurrent reads increase pool waiting or database load during the controlled test.

No database rollback is required because this design changes no schema or stored data format.
