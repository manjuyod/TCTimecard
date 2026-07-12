# Replit 200-User Hardening Design

**Date:** 2026-07-12

**Status:** Approved design

## Objective

Harden TCTimecard into a predictable Replit-hosted internal tool that comfortably supports 200 concurrent authenticated users with a mixture of tutor and administrator activity. The launch design prioritizes durable authentication, bounded database pressure, safe handling of expensive administrative work, and measurable performance without introducing distributed infrastructure that the expected load does not require.

For this design, 200 concurrent users means 200 active browser sessions following realistic think times and route mixes. It does not mean 200 requests arriving in the same millisecond.

## Current State

- Express sessions use the default in-memory store, so sessions are lost on restart and are not shared across machines.
- PostgreSQL and MSSQL pools are configurable but default to 10 connections each per process.
- Replit is currently configured for Autoscale deployment.
- Pay-period summaries combine several PostgreSQL and MSSQL queries for every request.
- Pay-period and attestation Excel exports build complete workbooks in application memory.
- The health endpoint only proves that the HTTP process is listening.
- Database pools and the HTTP server do not have an explicit graceful-shutdown path.

## Goals

1. Persist sessions in PostgreSQL and preserve the current 15-minute rolling inactivity timeout.
2. Bound each database pool to five connections by default.
3. Use one Replit Reserved VM with 2 vCPU and 8 GB RAM for the launch window.
4. Prevent identical simultaneous pay-period summary requests from duplicating database work.
5. Permit at most three export jobs at once across pay-period and attestation exports.
6. Expose separate liveness and database-aware readiness checks.
7. Shut down the HTTP server and database pools cleanly during restarts.
8. Verify the system with an authenticated 200-user mixed-workload load test.

## Non-Goals

- A background job queue or separate worker deployment.
- Redis, distributed caching, or distributed locks.
- Automatic horizontal scaling for the launch window.
- Database schema or query redesign unrelated to measured load-test failures.
- Broad route-level rate limiting.
- Long-lived caching of payroll or approval data.
- Guaranteeing performance for 200 requests arriving simultaneously without think time.

## Database Safety Constraint

All database access performed by Codex or another agent must be read-only. Agentic work must not execute migrations, DDL, `INSERT`, `UPDATE`, `DELETE`, session-creating login traffic, clock actions, approval actions, or any other operation that can mutate PostgreSQL or MSSQL state.

Every SQL statement intended for production must be checked into the repository as a reviewable file. The PostgreSQL session schema will therefore be delivered only as a versioned migration file. A human operator must inspect it, apply it manually in an approved non-production environment, verify it with the documented read-only checks, and separately authorize its production application.

Automated agent-run tests must use in-memory fakes or mocks and must not connect to either live database. Because authenticated traffic writes session state, the final authenticated load test is also a human-operated step. Codex may create the harness, document the command, and analyze captured output, but may not launch that test against a database-backed deployment.

## Deployment Architecture

The launch deployment will use a single Replit Reserved VM with 2 vCPU and 8 GB RAM. Reserved compute removes cold starts and machine-count variability during the launch window while Replit monitoring supplies CPU, memory, HTTP status, and request-duration evidence.

The application will remain safe to move to Autoscale later because sessions will be stored in PostgreSQL. If Autoscale is enabled after launch, begin with a maximum of two machines and never exceed three without recalculating total PostgreSQL and MSSQL connection budgets. The export concurrency limit is intentionally process-local for launch; it must be revisited before enabling multiple machines.

Published-app secrets must include explicit `POSTGRES_POOL_MAX=5` and `MSSQL_POOL_MAX=5` values even though five will also become the application default. The Reserved VM type and size are selected in Replit Publishing rather than inferred from development workflows.

## Session Architecture

Use `connect-pg-simple` as the `express-session` store and give it the existing shared PostgreSQL pool. A normal versioned migration will create the session table and expiry index; runtime table creation will remain disabled so deployment startup does not mutate schema unexpectedly.

The existing cookie name and security properties remain unchanged:

- Cookie name: `timecard.sid`
- HTTP-only cookie
- Secure cookie in production
- `SameSite=Lax`
- Rolling 15-minute expiration
- Session ID regeneration at login

The store must not fall back to Express MemoryStore if PostgreSQL is unavailable. Authentication requests fail closed with a service-unavailable response rather than creating machine-local sessions. Expired rows are pruned by the store on a bounded schedule.

## Database Connection Budgets

Change both pool defaults from 10 to 5 while preserving the existing environment-variable overrides and timeout validation.

On the launch VM, the maximum application connection budget is therefore:

- PostgreSQL: five shared connections for application queries and session operations.
- MSSQL: five shared connections for identity, schedule, and CRM-hour queries.

The application continues to create one lazy singleton pool for each database. Pool errors are logged. Readiness checks borrow connections from these pools rather than creating additional pools.

If Autoscale is later enabled with two machines, the nominal maximum becomes 10 PostgreSQL and 10 MSSQL connections. Three machines would raise each maximum to 15 and requires confirmation that both database services can accept that budget.

## Pay-Period Summary Coalescing

Identical in-flight pay-period summary requests will share one promise keyed by the authorized franchise ID and resolved `forDate`. This is request coalescing, not a post-response cache:

1. The first request starts the existing summary calculation.
2. Requests for the same franchise and date await the same calculation.
3. Requests for other franchises or dates proceed independently.
4. The in-flight entry is removed in `finally`, whether the calculation succeeds or fails.
5. No completed result remains cached, so payroll and approval changes are visible on the next request.

Only the main administrator summary route is coalesced initially. Detail drilldowns and unrelated dashboards retain their current behavior unless the load test identifies them as bottlenecks.

## Export Concurrency Protection

A shared process-local limiter covers both pay-period review exports and attestation exports. It permits three active export jobs in total, regardless of export type.

When all three slots are occupied:

- A new export request fails immediately with HTTP `429 Too Many Requests`.
- The response includes a short `Retry-After` header.
- The JSON error explains that exports are busy and can be retried shortly.
- The client displays that message without logging out or disturbing other page state.

Every acquired slot is released in `finally`, including database errors, client disconnects, workbook-generation failures, and response failures. The limiter does not queue unbounded work in memory.

Existing oversized-export guards remain in place. Export data queries, CSV generation, and Excel workbook generation all occur within the limiter because each can hold database connections or substantial memory.

## Health and Process Lifecycle

`GET /api/health` remains a lightweight liveness endpoint. It returns success when the Node process can serve HTTP and does not query either database.

A separate readiness endpoint performs lightweight PostgreSQL and MSSQL checks through the existing pools. It returns:

- HTTP 200 only when both checks succeed.
- HTTP 503 when either check fails or times out.
- A safe per-dependency status without credentials, SQL text, or raw internal errors.

During `SIGTERM` or `SIGINT`, the application will:

1. Stop accepting new HTTP connections.
2. Allow active requests a short grace period to finish.
3. Close the PostgreSQL and MSSQL pools.
4. Exit successfully when cleanup completes.
5. Force exit after the grace deadline so a broken connection cannot hang a deployment indefinitely.

The shutdown path must be idempotent so repeated signals do not start overlapping cleanup.

## Error Handling and Observability

- Session-store outages produce service-unavailable behavior and never silently downgrade session durability.
- Summary failures are passed through the existing centralized JSON error handler; their in-flight coalescing entry is always removed.
- Export saturation is an expected `429`, not a server error.
- Readiness failures use `503` while liveness remains available for process diagnosis.
- Existing unexpected pool errors continue to be logged.
- Export saturation and graceful-shutdown events receive concise structured log messages suitable for Replit logs.
- No new external monitoring service is required for launch. Replit CPU, memory, HTTP status, request-duration, and log views are the operational dashboard.

## Verification Strategy

### Automated correctness checks

Add focused tests for:

- Postgres session-store configuration and preservation of cookie/TTL behavior.
- A maximum of three simultaneous export jobs.
- Immediate rejection of the fourth export with `429` and `Retry-After`.
- Slot release after successful and failed export work.
- Sharing one calculation for identical simultaneous summary requests.
- Independent calculations for different summary keys.
- Removal of failed summary calculations so later retries run normally.
- Readiness success and dependency-failure responses.
- Idempotent graceful-shutdown behavior where practical without terminating the test process.

Run the complete existing test suite, server and client typecheck, and production build after the focused tests pass.

All agent-run automated tests use mocks or fakes. They do not apply the migration or connect to PostgreSQL or MSSQL.

### Load-test harness

Provide a portable authenticated load-test script and operator documentation. Credentials are supplied at runtime and are never committed. The harness supports separate tutor and admin credential lists, independent cookie jars per virtual user, a configurable base URL, duration, user count, and optional controlled write activity.

The standard workload uses:

- 200 virtual users for 15 minutes after warm-up.
- 90% tutor and 10% administrator users.
- Realistic think time between actions.
- Tutor reads covering authentication, session lookup, dashboard totals, clock state, and calendar/schedule data.
- Administrator reads covering authentication, dashboard, approvals, pay-period summary, and detail views.
- Three concurrent export jobs during the sustained stage.
- Clock-in, clock-out, break, and approval writes only when explicitly enabled with dedicated test accounts in a controlled test franchise.

Run the workload in stages at 20, 100, and 200 users. Stop and diagnose at any stage that violates its thresholds instead of increasing load blindly.

These authenticated stages create and update PostgreSQL session rows and therefore must be started manually by a human operator. The harness prints a machine-readable results file that Codex can inspect afterward without writing to a database.

### Acceptance criteria

The 200-user run passes only when all of the following are true:

- Unexpected HTTP error rate is below 1%; expected export-saturation `429` responses are reported separately.
- Non-export API p95 latency is below 1.5 seconds.
- Non-export API p99 latency is below 3 seconds.
- Authenticated sessions are not lost, crossed between users, or invalidated by process-local routing.
- No PostgreSQL or MSSQL pool-acquisition timeouts occur.
- The Node process does not crash or restart.
- Three simultaneous export jobs complete without materially degrading tutor clock-state and clock-action requests.
- A fourth export is rejected quickly rather than queued indefinitely.
- Replit CPU and memory remain below sustained saturation and recover after export work completes.

Any production-data write test requires explicit confirmation that its accounts and franchise are isolated test fixtures. The read-heavy scenario may be run independently when write fixtures are unavailable, but it does not by itself prove clock-write capacity.

## Rollout

1. Have a human operator review the session-table migration, apply it manually in an approved non-production environment, and run the documented read-only verification queries.
2. After manual approval, have a human operator apply the same checked-in migration to production before publishing the new application snapshot.
3. Set production secrets, including both pool maxima at five and the existing required session/signing secrets.
4. Publish as one 2 vCPU / 8 GB Reserved VM.
5. Have a human operator verify liveness, readiness, login, tutor dashboard, administrator summary, and one export manually.
6. Have a human operator run staged load tests at 20, 100, and 200 users against controlled accounts.
7. Inspect Replit CPU, memory, HTTP statuses, request durations, and logs after each stage.
8. Keep three-export concurrency protection enabled during launch.
9. If thresholds fail, use measurements to decide between query optimization, a stricter export limit, or a larger VM; do not increase pool sizes as the first response.

## Trade-Offs

- Sharing the five-connection PostgreSQL pool between application queries and sessions keeps the total database budget bounded, but a severely slow application query could delay session operations. The load test verifies that five connections are sufficient before launch.
- In-flight request coalescing removes duplicate summary work without stale data, but it does not accelerate sequential summary requests.
- A process-local export limit is intentionally simple and correct on one Reserved VM. It becomes a per-machine limit under Autoscale and therefore must be redesigned or recalculated before horizontal scaling.
- Three concurrent exports provide administrator flexibility but create more CPU and memory pressure than a limit of one or two. The 200-user test must prove that three do not harm tutor clock paths.
- A single Reserved VM is a deliberate launch-window simplicity choice. Durable sessions reduce restart impact but do not make a single VM highly available.
