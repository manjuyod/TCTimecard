# Database Pools at Ten Design

## Purpose

Increase both database pool maxima from five to ten connections per application process before the next staged load test. The 200-user run remained correct but saturated on latency while Replit CPU stayed below 17%, indicating queued database work rather than compute pressure.

## Configuration

Change the default values for both pools:

- `POSTGRES_POOL_MAX=10`
- `MSSQL_POOL_MAX=10`

The Postgres pool is shared by the persistent session store and PostgreSQL application queries. The MSSQL pool serves CRM and schedule queries. This design does not introduce a separate session pool.

Explicit environment values continue to override defaults. Because Replit production already sets both variables explicitly, a human operator must update both deployment secrets to `10` and redeploy; changing the repository defaults alone will not alter the running deployment.

## Scope

Tracked changes are limited to:

- Pool default assertions and configuration values.
- `.env.example` and README defaults.
- The Replit operations runbook and its rollback instructions.

Do not change session persistence behavior, query implementations, VM size, or export concurrency in the same deployment. That keeps the next test focused on connection capacity, despite changing both database pools together.

## Query review

Perform a static, read-only audit of slow routes separately. Agents must not execute production SQL, authenticated requests, `EXPLAIN`, or database mutations. Any production-oriented diagnostic SQL must be saved under `specs/sql/` and run manually by a human after review.

Query findings may recommend a follow-up change, but they are not implemented as part of this pool-sizing change.

## Testing and rollout

Use test-driven development:

1. Change the configuration test to expect Postgres and MSSQL defaults of ten and verify it fails against the current code.
2. Change the two defaults and verify the focused test passes.
3. Run the complete test suite, typecheck, and production build.
4. Human updates both Replit deployment variables to `10` and redeploys.
5. Human runs credential preflight and then the 100-user stage before repeating 200 users.

Acceptance remains:

- Unexpected errors below 1%.
- Non-export p95 below 1500 ms.
- Non-export p99 below 3000 ms.
- Zero post-login 401/403 responses.
- No pool-acquisition timeout, process restart, or database connection error.
- Three exports complete without material clock-route degradation.

## Monitoring and rollback

During the 100-user and 200-user stages, capture Replit CPU, memory, server-side request durations, HTTP statuses, and logs. Specifically inspect logs for MSSQL login/connection errors, PostgreSQL pool timeouts, session-store errors, and process restarts.

If database errors increase, latency worsens, or either database rejects connections, restore both deployment variables to `5` and redeploy. Repository defaults can be reverted separately after the operational rollback; no database migration or SQL rollback is required.
