# Replit 200-User Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make TCTimecard a predictable single-Reserved-VM Replit application that safely supports 200 concurrent authenticated tutor/admin sessions with durable sessions, bounded database pressure, protected admin exports, measurable readiness, and a reproducible load-test harness.

**Architecture:** Persist `express-session` data through `connect-pg-simple` using the existing five-connection PostgreSQL pool, while retaining the existing secure rolling cookie behavior. Keep one 2 vCPU / 8 GB Reserved VM for launch; coalesce identical in-flight summary reads, admit only three export jobs per process, expose liveness/readiness separately, and close HTTP/database resources gracefully. Use mock-backed automated tests and a human-operated native Node load harness so agentic work never mutates a database.

**Tech Stack:** Node.js 18.18+, TypeScript 5.9, Express 4, `express-session`, `connect-pg-simple` 10.0.0, PostgreSQL (`pg` 8), MSSQL 12, React/Vite, Node's built-in test runner, native `fetch` load harness, Replit Reserved VM.

## Global Constraints

- All database access performed by Codex or another agent must be read-only.
- Agents must not run `npm run db:migrate`, DDL, `INSERT`, `UPDATE`, `DELETE`, authenticated login traffic, clock actions, approvals, or the authenticated load test against a database-backed deployment.
- Every SQL statement intended for production must be checked into the repository as a reviewable file and applied/tested manually by a human operator.
- Agent-run tests must use in-memory fakes or mocks and must not connect to PostgreSQL or MSSQL.
- Preserve the existing `timecard.sid` cookie, HTTP-only flag, production Secure flag, `SameSite=Lax`, login regeneration, and rolling 15-minute expiration.
- `POSTGRES_POOL_MAX` defaults to 5 and `MSSQL_POOL_MAX` defaults to 5 per process.
- Permit exactly 3 concurrent export jobs across pay-period and attestation exports; reject excess work immediately with `429` and `Retry-After`.
- Summary coalescing stores only active promises. Do not retain completed payroll results.
- Launch on one Replit Reserved VM with 2 vCPU / 8 GB RAM; do not add Redis, queues, workers, or distributed locks.
- The 200-user acceptance workload is 90% tutor and 10% admin for 15 minutes after warm-up.
- Acceptance thresholds are: unexpected errors below 1%, non-export p95 below 1.5 seconds, non-export p99 below 3 seconds, no session loss/crossing, no pool-acquisition timeout, and no process crash.
- `getMssqlPool` has CRITICAL GitNexus blast radius: 14 direct callers across auth and route modules, 13 affected execution flows, and 2 modules. Do not modify this function; add lifecycle behavior in a new adjacent export.
- Before editing any existing function, class, method, or route handler, rerun the required GitNexus upstream impact/API-impact check and report direct callers, affected processes, and risk to the user. Stop for renewed approval if risk is HIGH or CRITICAL.
- Before every commit, run `gitnexus_detect_changes({ repo: "TCTimecard", scope: "staged" })` and verify the affected scope is expected.

## File Structure

- `server/config/env.ts` — conservative database pool defaults.
- `server/config/sessionMiddleware.ts` — PostgreSQL session-store construction, fail-closed error mapping, and Express session options.
- `server/db/migrations/0006_postgres_sessions.sql` — reviewable production session-table DDL; never agent-executed.
- `server/db/postgres.ts` / `server/db/mssql.ts` — idempotent pool-close exports without changing existing pool factories.
- `server/services/exportConcurrency.ts` — shared three-slot process-local export guard.
- `server/services/inFlightCoalescer.ts` — generic active-promise coalescer.
- `server/services/readiness.ts` — safe PostgreSQL/MSSQL dependency checks.
- `server/services/gracefulShutdown.ts` — idempotent signal-driven shutdown.
- `server/routes/health.ts` — liveness and readiness routes mounted before sessions.
- `server/routes/hours.ts` — summary coalescer wiring and pay-period export guard.
- `server/routes/attestation.ts` — attestation export guard.
- `server/index.ts` — middleware wiring, health route mount, and graceful shutdown registration.
- `server/tests/*.test.ts` — mock-backed focused tests; no live database access.
- `load-tests/replit-200-users.mjs` — native Node authenticated mixed-workload harness, manually launched only.
- `load-tests/credentials.example.json` — credential/config shape without secrets.
- `docs/operations/replit-200-user-runbook.md` — manual migration, publishing, smoke, staged load, monitoring, and rollback instructions.

---

### Task 1: Conservative Database Pool Defaults

**Files:**
- Create: `server/tests/dbConfig.test.ts`
- Modify: `server/config/env.ts:58-130`
- Modify: `.env.example:10-28`
- Modify: `README.md` environment-variable defaults

**Interfaces:**
- Consumes: existing `getPostgresConfig(): PostgresConfig` and `getMssqlConfig(): MssqlConfig`.
- Produces: unchanged interfaces whose `max` / `pool.max` default to `5` when the environment override is absent.

- [ ] **Step 1: Reconfirm symbol impact before editing**

Run through GitNexus MCP:

```text
gitnexus_impact({ target: "getPostgresConfig", file_path: "server/config/env.ts", kind: "Function", direction: "upstream", includeTests: true })
gitnexus_impact({ target: "getMssqlConfig", file_path: "server/config/env.ts", kind: "Function", direction: "upstream", includeTests: true })
```

Expected: both LOW. Report direct callers, affected processes, and risk before continuing.

- [ ] **Step 2: Write the failing configuration test**

Create `server/tests/dbConfig.test.ts`:

```ts
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { getMssqlConfig, getPostgresConfig } from '../config/env';

const MANAGED_KEYS = [
  'POSTGRES_URL',
  'POSTGRES_POOL_MAX',
  'MSSQL_SERVER',
  'MSSQL_DATABASE',
  'MSSQL_USER',
  'MSSQL_PASSWORD',
  'MSSQL_POOL_MAX'
] as const;

const originalValues = new Map(MANAGED_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
  for (const key of MANAGED_KEYS) {
    const original = originalValues.get(key);
    if (original === undefined) delete process.env[key];
    else process.env[key] = original;
  }
});

const setRequiredValues = (): void => {
  process.env.POSTGRES_URL = 'postgresql://user:password@example.test/timecard';
  process.env.MSSQL_SERVER = 'sql.example.test';
  process.env.MSSQL_DATABASE = 'timecard';
  process.env.MSSQL_USER = 'user';
  process.env.MSSQL_PASSWORD = 'password';
};

test('database pool defaults are five connections per process', () => {
  setRequiredValues();
  delete process.env.POSTGRES_POOL_MAX;
  delete process.env.MSSQL_POOL_MAX;

  assert.equal(getPostgresConfig().max, 5);
  assert.equal(getMssqlConfig().pool?.max, 5);
});

test('explicit database pool maxima still override the defaults', () => {
  setRequiredValues();
  process.env.POSTGRES_POOL_MAX = '3';
  process.env.MSSQL_POOL_MAX = '4';

  assert.equal(getPostgresConfig().max, 3);
  assert.equal(getMssqlConfig().pool?.max, 4);
});
```

- [ ] **Step 3: Run the focused test and confirm the default assertion fails**

Run:

```powershell
node --test --import tsx server/tests/dbConfig.test.ts
```

Expected: the override test passes and the default test fails because both current defaults are `10`.

- [ ] **Step 4: Change only the two defaults**

In `server/config/env.ts`, change the existing expressions to:

```ts
const max = parseInteger('POSTGRES_POOL_MAX', process.env.POSTGRES_POOL_MAX, 5, { min: 1 });
```

```ts
const poolMax = parseInteger('MSSQL_POOL_MAX', process.env.MSSQL_POOL_MAX, 5, { min: 1 });
```

Do not modify `getMssqlPool`.

- [ ] **Step 5: Document explicit launch values**

Add these lines to the relevant sections of `.env.example`:

```dotenv
POSTGRES_POOL_MAX=5
MSSQL_POOL_MAX=5
```

Change the two README default descriptions from `10` to `5` and add one sentence:

```markdown
For the single Reserved VM launch, set both pool maxima explicitly to `5` in Published App Secrets.
```

- [ ] **Step 6: Run focused verification**

Run:

```powershell
node --test --import tsx server/tests/dbConfig.test.ts
npm run typecheck
```

Expected: 2 tests pass and typecheck exits 0. These commands do not connect to a database.

- [ ] **Step 7: Run staged GitNexus change detection and commit**

Stage only Task 1 files, then run:

```text
gitnexus_detect_changes({ repo: "TCTimecard", scope: "staged" })
```

Expected: only configuration/docs and the new test; no unexpected execution flows.

Commit:

```powershell
git add server/tests/dbConfig.test.ts server/config/env.ts .env.example README.md
git commit -m "perf: bound database pools at five connections"
```

---

### Task 2: Durable PostgreSQL Sessions That Fail Closed

**Files:**
- Create: `server/config/sessionMiddleware.ts`
- Create: `server/db/migrations/0006_postgres_sessions.sql`
- Create: `server/tests/sessionMiddleware.test.ts`
- Modify: `server/index.ts:7-81`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: `getPostgresPool(): Pool`, existing session constants from `server/config/session.ts`, and the existing `express-session` request contract.
- Produces: `SessionStoreUnavailableError`, `FailClosedSessionStore`, `createPostgresSessionStore(pool?: Pool): Store`, `buildSessionOptions(store: Store): SessionOptions`, and `createSessionMiddleware(): RequestHandler`.

- [ ] **Step 1: Reconfirm entry-point/API impact before changing session wiring**

Run:

```text
gitnexus_api_impact({ file: "server/index.ts", repo: "TCTimecard" })
```

Expected: LOW for the indexed entry-point routes. Report the result. Do not change `createAuthSession`; the fail-closed wrapper will preserve a 503 status through its existing callback errors.

- [ ] **Step 2: Install the pinned store and TypeScript definitions**

Run separately:

```powershell
npm install connect-pg-simple@10.0.0
```

```powershell
npm install --save-dev @types/connect-pg-simple@7.0.3
```

Change `package.json` engines to match the store's supported Node floor:

```json
"engines": {
  "node": ">=18.18.0"
}
```

Do not run any database command.

- [ ] **Step 3: Write the failing session tests**

Create `server/tests/sessionMiddleware.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import session, { SessionData, Store } from 'express-session';
import {
  FailClosedSessionStore,
  SessionStoreUnavailableError,
  buildSessionOptions,
  createPostgresSessionStore
} from '../config/sessionMiddleware';
import { SESSION_COOKIE_NAME, SESSION_SAME_SITE, SESSION_SECURE, SESSION_TTL_MS } from '../config/session';

class FailingStore extends Store {
  get(_sid: string, callback: (err: unknown, session?: SessionData | null) => void): void {
    callback(new Error('database unavailable'));
  }

  set(_sid: string, _value: SessionData, callback?: (err?: unknown) => void): void {
    callback?.(new Error('database unavailable'));
  }

  destroy(_sid: string, callback?: (err?: unknown) => void): void {
    callback?.(new Error('database unavailable'));
  }
}

test('session options preserve the existing rolling cookie contract', () => {
  const store = new session.MemoryStore();
  const options = buildSessionOptions(store);

  assert.equal(options.store, store);
  assert.equal(options.name, SESSION_COOKIE_NAME);
  assert.equal(options.resave, false);
  assert.equal(options.rolling, true);
  assert.equal(options.saveUninitialized, false);
  assert.equal(options.cookie?.httpOnly, true);
  assert.equal(options.cookie?.secure, SESSION_SECURE);
  assert.equal(options.cookie?.sameSite, SESSION_SAME_SITE);
  assert.equal(options.cookie?.maxAge, SESSION_TTL_MS);
});

test('the production store is explicit and never falls back to MemoryStore', () => {
  const fakePool = { query: async () => ({ rows: [] }) };
  const store = createPostgresSessionStore(fakePool as never);

  assert.ok(store instanceof FailClosedSessionStore);
  assert.ok(!(store instanceof session.MemoryStore));
});

test('store read errors become safe 503 errors', async () => {
  const store = new FailClosedSessionStore(new FailingStore());
  const error = await new Promise<unknown>((resolve) => {
    store.get('sid', (err) => resolve(err));
  });

  assert.ok(error instanceof SessionStoreUnavailableError);
  assert.equal((error as SessionStoreUnavailableError).status, 503);
  assert.equal((error as Error).message, 'Session service unavailable');
});

test('store write errors become safe 503 errors', async () => {
  const store = new FailClosedSessionStore(new FailingStore());
  const error = await new Promise<unknown>((resolve) => {
    store.set('sid', { cookie: { originalMaxAge: null } } as SessionData, (err) => resolve(err));
  });

  assert.ok(error instanceof SessionStoreUnavailableError);
  assert.equal((error as SessionStoreUnavailableError).status, 503);
});
```

- [ ] **Step 4: Run the session test and confirm it fails before implementation**

Run:

```powershell
node --test --import tsx server/tests/sessionMiddleware.test.ts
```

Expected: FAIL because `server/config/sessionMiddleware.ts` does not exist.

- [ ] **Step 5: Create the fail-closed PostgreSQL session middleware**

Create `server/config/sessionMiddleware.ts`:

```ts
import session, { SessionData, SessionOptions, Store } from 'express-session';
import connectPgSimple from 'connect-pg-simple';
import type { Pool } from 'pg';
import { getPostgresPool } from '../db/postgres';
import {
  SESSION_COOKIE_NAME,
  SESSION_SAME_SITE,
  SESSION_SECRET,
  SESSION_SECURE,
  SESSION_TTL_MS
} from './session';

const PostgresSessionStore = connectPgSimple(session);

export class SessionStoreUnavailableError extends Error {
  readonly status = 503;
  readonly cause: unknown;

  constructor(cause?: unknown) {
    super('Session service unavailable');
    this.name = 'SessionStoreUnavailableError';
    this.cause = cause;
  }
}

const unavailable = (error: unknown): SessionStoreUnavailableError =>
  error instanceof SessionStoreUnavailableError ? error : new SessionStoreUnavailableError(error);

export class FailClosedSessionStore extends Store {
  constructor(private readonly delegate: Store) {
    super();
  }

  get(sid: string, callback: (err: unknown, session?: SessionData | null) => void): void {
    this.delegate.get(sid, (error, value) => callback(error ? unavailable(error) : null, value));
  }

  set(sid: string, value: SessionData, callback?: (err?: unknown) => void): void {
    this.delegate.set(sid, value, (error) => callback?.(error ? unavailable(error) : undefined));
  }

  destroy(sid: string, callback?: (err?: unknown) => void): void {
    this.delegate.destroy(sid, (error) => callback?.(error ? unavailable(error) : undefined));
  }

  touch(sid: string, value: SessionData, callback?: (err?: unknown) => void): void {
    const touch = this.delegate.touch;
    if (!touch) {
      this.set(sid, value, callback);
      return;
    }
    touch.call(this.delegate, sid, value, (error?: unknown) =>
      callback?.(error ? unavailable(error) : undefined)
    );
  }
}

export const createPostgresSessionStore = (pool: Pool = getPostgresPool()): Store =>
  new FailClosedSessionStore(
    new PostgresSessionStore({
      pool,
      schemaName: 'public',
      tableName: 'user_sessions',
      createTableIfMissing: false,
      ttl: SESSION_TTL_MS / 1000,
      pruneSessionInterval: 15 * 60,
      errorLog: (...args: unknown[]) => console.error('[session-store]', ...args)
    })
  );

export const buildSessionOptions = (store: Store): SessionOptions => ({
  store,
  name: SESSION_COOKIE_NAME,
  secret: SESSION_SECRET,
  resave: false,
  rolling: true,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: SESSION_SECURE,
    sameSite: SESSION_SAME_SITE,
    maxAge: SESSION_TTL_MS
  }
});

export const createSessionMiddleware = () => session(buildSessionOptions(createPostgresSessionStore()));
```

- [ ] **Step 6: Write the production SQL migration file without executing it**

Create `server/db/migrations/0006_postgres_sessions.sql`:

```sql
CREATE TABLE IF NOT EXISTS public.user_sessions (
  sid VARCHAR NOT NULL PRIMARY KEY,
  sess JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL
);

CREATE INDEX IF NOT EXISTS user_sessions_expire_idx
  ON public.user_sessions (expire);
```

This is the only session DDL. Do not run it. Do not run `npm run db:migrate`.

- [ ] **Step 7: Wire the session middleware into Express**

In `server/index.ts`, remove the direct `express-session` import and the inline `session({...})` block. Import and mount the factory in the same middleware position:

```ts
import { createSessionMiddleware } from './config/sessionMiddleware';
```

```ts
app.use(createSessionMiddleware());
```

Keep the existing `SESSION_SECRET` warning, `trust proxy`, middleware order, cookie behavior, and route mounts unchanged.

- [ ] **Step 8: Run mock-only session verification**

Run:

```powershell
node --test --import tsx server/tests/sessionMiddleware.test.ts
npm run typecheck
npm run build:server
```

Expected: 4 tests pass, typecheck exits 0, and the server build exits 0. None of these commands connects to a database.

- [ ] **Step 9: Run staged GitNexus change detection and commit**

Stage Task 2 files and run:

```text
gitnexus_detect_changes({ repo: "TCTimecard", scope: "staged" })
```

Expected: session wiring, one new migration file, dependency manifests, and session tests only. Review any entry-point flow changes.

Commit:

```powershell
git add package.json package-lock.json server/config/sessionMiddleware.ts server/db/migrations/0006_postgres_sessions.sql server/tests/sessionMiddleware.test.ts server/index.ts
git commit -m "feat: persist sessions in postgres"
```

---

### Task 3: Three-Slot Export Concurrency Guard

**Files:**
- Create: `server/services/exportConcurrency.ts`
- Create: `server/tests/exportConcurrency.test.ts`
- Modify: `server/routes/hours.ts:1427-1505`
- Modify: `server/routes/attestation.ts:326-372`

**Interfaces:**
- Produces: `createExportConcurrencyGuard(maxConcurrent?: number): ExportConcurrencyGuard`, singleton `exportConcurrencyGuard`, and `rejectBusyExport(res: Response): void`.
- Consumers: the pay-period and attestation export route handlers share the singleton and release returned permits in `finally`.

- [ ] **Step 1: Reconfirm both route blast radii**

Run:

```text
gitnexus_api_impact({ route: "/hours/admin/pay-period/export", repo: "TCTimecard" })
gitnexus_api_impact({ route: "/attestation/admin/export", repo: "TCTimecard" })
```

Expected: LOW; current index reports 29 flows for pay-period export and 1 for attestation export, with no direct consumers. Report the blast radius before editing.

- [ ] **Step 2: Write the failing guard tests**

Create `server/tests/exportConcurrency.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Response } from 'express';
import { createExportConcurrencyGuard, rejectBusyExport } from '../services/exportConcurrency';

test('three export permits are admitted and the fourth is rejected', () => {
  const guard = createExportConcurrencyGuard(3);
  const releases = [guard.tryAcquire(), guard.tryAcquire(), guard.tryAcquire()];

  assert.ok(releases.every((release) => typeof release === 'function'));
  assert.equal(guard.activeCount, 3);
  assert.equal(guard.tryAcquire(), null);
});

test('release is idempotent and makes a slot available', () => {
  const guard = createExportConcurrencyGuard(1);
  const release = guard.tryAcquire();
  assert.ok(release);
  assert.equal(guard.tryAcquire(), null);

  release();
  release();
  assert.equal(guard.activeCount, 0);
  assert.ok(guard.tryAcquire());
});

test('busy response is immediately retryable and safe', () => {
  const headers = new Map<string, string>();
  let statusCode = 0;
  let payload: unknown;
  const response = {
    setHeader: (name: string, value: string | number) => headers.set(name.toLowerCase(), String(value)),
    status: (code: number) => {
      statusCode = code;
      return response;
    },
    json: (body: unknown) => {
      payload = body;
      return response;
    }
  } as unknown as Response;

  rejectBusyExport(response, () => undefined);

  assert.equal(statusCode, 429);
  assert.equal(headers.get('retry-after'), '15');
  assert.deepEqual(payload, { error: 'Exports are busy. Please retry shortly.' });
});
```

- [ ] **Step 3: Run the test and confirm it fails before implementation**

Run:

```powershell
node --test --import tsx server/tests/exportConcurrency.test.ts
```

Expected: FAIL because `server/services/exportConcurrency.ts` does not exist.

- [ ] **Step 4: Implement the shared process-local guard**

Create `server/services/exportConcurrency.ts`:

```ts
import type { Response } from 'express';

export const MAX_CONCURRENT_EXPORTS = 3;
export const EXPORT_RETRY_AFTER_SECONDS = 15;

export interface ExportConcurrencyGuard {
  readonly activeCount: number;
  tryAcquire(): (() => void) | null;
}

export const createExportConcurrencyGuard = (
  maxConcurrent = MAX_CONCURRENT_EXPORTS
): ExportConcurrencyGuard => {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
    throw new Error('maxConcurrent must be a positive integer');
  }

  let activeCount = 0;
  return {
    get activeCount() {
      return activeCount;
    },
    tryAcquire() {
      if (activeCount >= maxConcurrent) return null;
      activeCount += 1;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        activeCount -= 1;
      };
    }
  };
};

export const exportConcurrencyGuard = createExportConcurrencyGuard();

export const rejectBusyExport = (
  res: Response,
  log: (message: string) => void = console.warn
): void => {
  log('[export] concurrency limit reached');
  res.setHeader('Retry-After', EXPORT_RETRY_AFTER_SECONDS);
  res.status(429).json({ error: 'Exports are busy. Please retry shortly.' });
};
```

- [ ] **Step 5: Guard both export handlers with the same singleton**

Add this import to both `server/routes/hours.ts` and `server/routes/attestation.ts`:

```ts
import { exportConcurrencyGuard, rejectBusyExport } from '../services/exportConcurrency';
```

In each export route, after auth/scope/query validation but immediately before database/export work, add:

```ts
const releaseExportSlot = exportConcurrencyGuard.tryAcquire();
if (!releaseExportSlot) {
  rejectBusyExport(res);
  return;
}
```

Extend the existing `try/catch` with:

```ts
} finally {
  releaseExportSlot();
}
```

Keep CSV, XLSX, oversized-export, authorization, and validation behavior unchanged. Early `return` statements inside `try` still execute `finally`.

- [ ] **Step 6: Run guard and route regressions**

Run:

```powershell
node --test --import tsx server/tests/exportConcurrency.test.ts server/tests/hoursRoutes.test.ts server/tests/attestationAdminRoutes.test.ts
npm run typecheck
```

Expected: all focused and existing export-route tests pass; typecheck exits 0. Tests use pool overrides only.

- [ ] **Step 7: Run staged GitNexus change detection and commit**

Stage Task 3 files, run:

```text
gitnexus_detect_changes({ repo: "TCTimecard", scope: "staged" })
```

Expected: only the two export handlers plus the new guard/test. Verify the affected export flows match the earlier API-impact reports.

Commit:

```powershell
git add server/services/exportConcurrency.ts server/tests/exportConcurrency.test.ts server/routes/hours.ts server/routes/attestation.ts
git commit -m "perf: cap concurrent admin exports"
```

---

### Task 4: In-Flight Pay-Period Summary Coalescing

**Files:**
- Create: `server/services/inFlightCoalescer.ts`
- Create: `server/tests/inFlightCoalescer.test.ts`
- Modify: `server/routes/hours.ts:1281-1316`

**Interfaces:**
- Produces: `createInFlightCoalescer<T>(): { run(key: string, work: () => Promise<T>): Promise<T>; readonly size: number }`.
- Consumes: the existing pay-period summary calculation, extracted into `loadAdminComparisonSummary(franchiseId: number, forDate: string | null): Promise<AdminComparisonSummaryResult>`.

- [ ] **Step 1: Reconfirm summary-route blast radius**

Run:

```text
gitnexus_api_impact({ route: "/hours/admin/pay-period/summary", repo: "TCTimecard" })
```

Expected: LOW; current index reports no direct consumers and 29 related execution flows. Report the blast radius.

- [ ] **Step 2: Write the failing coalescer tests**

Create `server/tests/inFlightCoalescer.test.ts`:

```ts
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createInFlightCoalescer } from '../services/inFlightCoalescer';

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
};

test('identical active keys share one calculation', async () => {
  const gate = deferred<number>();
  const coalescer = createInFlightCoalescer<number>();
  let calls = 0;
  const work = () => {
    calls += 1;
    return gate.promise;
  };

  const first = coalescer.run('77:2026-02-03', work);
  const second = coalescer.run('77:2026-02-03', work);
  assert.equal(calls, 1);
  assert.equal(coalescer.size, 1);

  gate.resolve(42);
  assert.deepEqual(await Promise.all([first, second]), [42, 42]);
  assert.equal(coalescer.size, 0);
});

test('different keys run independently', async () => {
  const coalescer = createInFlightCoalescer<number>();
  let calls = 0;
  const values = await Promise.all([
    coalescer.run('77:current', async () => ++calls),
    coalescer.run('88:current', async () => ++calls)
  ]);

  assert.equal(calls, 2);
  assert.deepEqual(values.sort(), [1, 2]);
});

test('failed work is removed so a later request can retry', async () => {
  const coalescer = createInFlightCoalescer<number>();
  let calls = 0;

  await assert.rejects(
    coalescer.run('77:current', async () => {
      calls += 1;
      throw new Error('temporary failure');
    }),
    /temporary failure/
  );
  assert.equal(coalescer.size, 0);

  const result = await coalescer.run('77:current', async () => ++calls);
  assert.equal(result, 2);
});
```

- [ ] **Step 3: Run the test and confirm it fails before implementation**

Run:

```powershell
node --test --import tsx server/tests/inFlightCoalescer.test.ts
```

Expected: FAIL because `server/services/inFlightCoalescer.ts` does not exist.

- [ ] **Step 4: Implement active-promise-only coalescing**

Create `server/services/inFlightCoalescer.ts`:

```ts
export interface InFlightCoalescer<T> {
  readonly size: number;
  run(key: string, work: () => Promise<T>): Promise<T>;
}

export const createInFlightCoalescer = <T>(): InFlightCoalescer<T> => {
  const inFlight = new Map<string, Promise<T>>();

  return {
    get size() {
      return inFlight.size;
    },
    run(key, work) {
      const existing = inFlight.get(key);
      if (existing) return existing;

      let active!: Promise<T>;
      active = Promise.resolve()
        .then(work)
        .finally(() => {
          if (inFlight.get(key) === active) inFlight.delete(key);
        });
      inFlight.set(key, active);
      return active;
    }
  };
};
```

- [ ] **Step 5: Extract and coalesce only the main comparison summary**

In `server/routes/hours.ts`, add:

```ts
import { createInFlightCoalescer } from '../services/inFlightCoalescer';
```

Near the summary helper functions, add:

```ts
type AdminComparisonSummaryResult = {
  payPeriod: PayPeriod;
  rows: AdminComparisonSummaryRow[];
};

const adminComparisonSummaryRequests = createInFlightCoalescer<AdminComparisonSummaryResult>();

const loadAdminComparisonSummary = async (
  franchiseId: number,
  forDate: string | null
): Promise<AdminComparisonSummaryResult> => {
  const payPeriod = await resolvePayPeriod(franchiseId, forDate);
  const approvedDays = await fetchApprovedDaysForFranchise(franchiseId, payPeriod.startDate, payPeriod.endDate);
  const sessionsByDay = await fetchSessionsByDayIds(approvedDays.map((day) => day.id));
  const breaksByDay = await fetchBreaksByDayIds(getPostgresPool(), approvedDays.map((day) => day.id));
  const totalsByTutor = buildTutorTotalsByTutor(approvedDays, sessionsByDay, breaksByDay);
  const loggedHoursByTutor = buildLoggedHoursByTutor(totalsByTutor);
  const crmHoursByTutor = await fetchReportedCrmHoursByTutor(franchiseId, payPeriod);
  const tutorIds = Array.from(new Set([...loggedHoursByTutor.keys(), ...crmHoursByTutor.keys()]));
  const namesById = await fetchTutorNamesByIds(tutorIds);
  const rows = buildAdminComparisonSummaryRows(loggedHoursByTutor, crmHoursByTutor, namesById);
  return { payPeriod, rows };
};
```

Replace only the body of the main `/hours/admin/pay-period/summary` route's `try` block with:

```ts
const key = `${franchiseId}:${forDate ?? 'current'}`;
const result = await adminComparisonSummaryRequests.run(key, () =>
  loadAdminComparisonSummary(franchiseId, forDate)
);
res.status(200).json(result);
```

Do not coalesce detail, legacy, daily, or export routes.

- [ ] **Step 6: Run coalescer and hours-route regressions**

Run:

```powershell
node --test --import tsx server/tests/inFlightCoalescer.test.ts server/tests/hoursRoutes.test.ts
npm run typecheck
```

Expected: all tests pass and typecheck exits 0. Pool calls remain mocked.

- [ ] **Step 7: Run staged GitNexus change detection and commit**

Stage Task 4 files, run:

```text
gitnexus_detect_changes({ repo: "TCTimecard", scope: "staged" })
```

Expected: the main summary route and its existing calculation flows, plus the isolated coalescer/test.

Commit:

```powershell
git add server/services/inFlightCoalescer.ts server/tests/inFlightCoalescer.test.ts server/routes/hours.ts
git commit -m "perf: coalesce concurrent pay period summaries"
```

---

### Task 5: Liveness, Readiness, and Graceful Shutdown

**Files:**
- Create: `server/services/readiness.ts`
- Create: `server/services/gracefulShutdown.ts`
- Create: `server/routes/health.ts`
- Create: `server/tests/readiness.test.ts`
- Create: `server/tests/gracefulShutdown.test.ts`
- Create: `server/tests/dbLifecycle.test.ts`
- Modify: `server/db/postgres.ts:4-23`
- Modify: `server/db/mssql.ts:4-35`
- Modify: `server/index.ts:10-138`

**Interfaces:**
- Produces: `closePostgresPool(): Promise<void>`, `closeMssqlPool(): Promise<void>`, `checkReadiness(checks?: ReadinessChecks): Promise<ReadinessResult>`, `createHealthRouter(checks?: ReadinessChecks): Router`, `createGracefulShutdown(options): (signal) => void`, and `installGracefulShutdown(options): void`.
- Preserves: `GET /api/health` response and all existing database factory signatures.

- [ ] **Step 1: Reconfirm entry-point and critical MSSQL boundaries**

Run:

```text
gitnexus_api_impact({ route: "/api/health", repo: "TCTimecard" })
gitnexus_impact({ target: "getPostgresPool", file_path: "server/db/postgres.ts", kind: "Function", direction: "upstream", includeTests: true })
gitnexus_impact({ target: "getMssqlPool", file_path: "server/db/mssql.ts", kind: "Function", direction: "upstream", includeTests: true })
```

Expected: health LOW, PostgreSQL factory LOW in the current index, and MSSQL factory CRITICAL with 14 direct callers / 13 processes. Report the warning. Do not change either factory body; add new close exports after existing functions.

- [ ] **Step 2: Write failing lifecycle and readiness tests**

Create `server/tests/readiness.test.ts`:

```ts
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import express from 'express';
import { createHealthRouter } from '../routes/health';
import { checkReadiness } from '../services/readiness';

const withServer = async <T>(app: express.Express, run: (baseUrl: string) => Promise<T>): Promise<T> => {
  const server = await new Promise<ReturnType<express.Express['listen']>>((resolve) => {
    const nextServer = app.listen(0, () => resolve(nextServer));
  });
  try {
    const address = server.address() as AddressInfo;
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
};

test('readiness is healthy only when both dependencies respond', async () => {
  const result = await checkReadiness({
    postgres: async () => undefined,
    mssql: async () => undefined
  });

  assert.deepEqual(result, {
    ready: true,
    status: 'ready',
    dependencies: { postgres: 'ok', mssql: 'ok' }
  });
});

test('readiness hides dependency errors and returns not-ready', async () => {
  const result = await checkReadiness({
    postgres: async () => {
      throw new Error('secret connection text');
    },
    mssql: async () => undefined
  });

  assert.deepEqual(result, {
    ready: false,
    status: 'not_ready',
    dependencies: { postgres: 'error', mssql: 'ok' }
  });
  assert.doesNotMatch(JSON.stringify(result), /secret connection text/);
});

test('health is live without dependency checks', async () => {
  const app = express();
  app.use('/api', createHealthRouter({
    postgres: async () => { throw new Error('must not run'); },
    mssql: async () => { throw new Error('must not run'); }
  }));

  await withServer(app, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { status: string }).status, 'ok');
  });
});

test('ready route returns 200 or 503 from safe dependency state', async () => {
  const healthyApp = express();
  healthyApp.use('/api', createHealthRouter({
    postgres: async () => undefined,
    mssql: async () => undefined
  }));
  await withServer(healthyApp, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/ready`);
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { ready: boolean }).ready, true);
  });

  const failingApp = express();
  failingApp.use('/api', createHealthRouter({
    postgres: async () => { throw new Error('secret connection text'); },
    mssql: async () => undefined
  }));
  await withServer(failingApp, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/ready`);
    const body = await response.text();
    assert.equal(response.status, 503);
    assert.doesNotMatch(body, /secret connection text/);
  });
});
```

Create `server/tests/dbLifecycle.test.ts`:

```ts
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { closeMssqlPool, setMssqlPoolOverride } from '../db/mssql';
import { closePostgresPool, setPostgresPoolOverride } from '../db/postgres';

afterEach(() => {
  setPostgresPoolOverride(undefined);
  setMssqlPoolOverride(undefined);
});

test('pool close helpers are idempotent', async () => {
  let postgresCloses = 0;
  let mssqlCloses = 0;
  setPostgresPoolOverride({ end: async () => { postgresCloses += 1; } } as never);
  setMssqlPoolOverride({ close: async () => { mssqlCloses += 1; } } as never);

  await closePostgresPool();
  await closeMssqlPool();
  await closePostgresPool();
  await closeMssqlPool();

  assert.equal(postgresCloses, 1);
  assert.equal(mssqlCloses, 1);
});
```

Create `server/tests/gracefulShutdown.test.ts`:

```ts
import assert from 'node:assert/strict';
import { setImmediate as waitImmediate } from 'node:timers/promises';
import { test } from 'node:test';
import { createGracefulShutdown } from '../services/gracefulShutdown';

test('graceful shutdown is idempotent and closes resources before exit', async () => {
  let closeCalls = 0;
  let closeCallback: ((error?: Error) => void) | undefined;
  let resourceCloses = 0;
  const exitCodes: number[] = [];
  const server = {
    close(callback: (error?: Error) => void) {
      closeCalls += 1;
      closeCallback = callback;
      return server;
    }
  };

  const shutdown = createGracefulShutdown({
    server: server as never,
    closeResources: async () => { resourceCloses += 1; },
    exit: (code) => { exitCodes.push(code); },
    timeoutMs: 60_000,
    log: { info: () => undefined, error: () => undefined }
  });

  shutdown('SIGTERM');
  shutdown('SIGINT');
  assert.equal(closeCalls, 1);

  closeCallback?.();
  await waitImmediate();
  assert.equal(resourceCloses, 1);
  assert.deepEqual(exitCodes, [0]);
});
```

- [ ] **Step 3: Run the focused tests and confirm missing-module failures**

Run:

```powershell
node --test --import tsx server/tests/readiness.test.ts server/tests/dbLifecycle.test.ts server/tests/gracefulShutdown.test.ts
```

Expected: FAIL because the readiness/shutdown modules and close exports do not exist.

- [ ] **Step 4: Add idempotent close exports without changing pool factories**

Append to `server/db/postgres.ts`:

```ts
export const closePostgresPool = async (): Promise<void> => {
  const current = poolOverride ?? pool;
  poolOverride = undefined;
  pool = undefined;
  if (current) await current.end();
};
```

Append to `server/db/mssql.ts` and include it in the existing export list:

```ts
const closeMssqlPool = async (): Promise<void> => {
  const current = poolOverride ?? poolPromise;
  poolOverride = undefined;
  poolPromise = undefined;
  if (!current) return;
  const connected = await Promise.resolve(current);
  await connected.close();
};
```

```ts
export { sql, getMssqlPool, setMssqlPoolOverride, closeMssqlPool };
```

Do not alter `getMssqlPool` or its callers.

- [ ] **Step 5: Implement safe readiness checks**

Create `server/services/readiness.ts`:

```ts
import { getMssqlPool } from '../db/mssql';
import { getPostgresPool } from '../db/postgres';

export type DependencyState = 'ok' | 'error';

export interface ReadinessChecks {
  postgres: () => Promise<void>;
  mssql: () => Promise<void>;
}

export interface ReadinessResult {
  ready: boolean;
  status: 'ready' | 'not_ready';
  dependencies: { postgres: DependencyState; mssql: DependencyState };
}

const defaultChecks: ReadinessChecks = {
  postgres: async () => {
    await getPostgresPool().query('SELECT 1 AS ok');
  },
  mssql: async () => {
    const pool = await getMssqlPool();
    await pool.request().query('SELECT 1 AS ok');
  }
};

export const checkReadiness = async (
  checks: ReadinessChecks = defaultChecks
): Promise<ReadinessResult> => {
  const [postgres, mssql] = await Promise.allSettled([checks.postgres(), checks.mssql()]);
  const dependencies = {
    postgres: postgres.status === 'fulfilled' ? 'ok' : 'error',
    mssql: mssql.status === 'fulfilled' ? 'ok' : 'error'
  } as const;
  const ready = dependencies.postgres === 'ok' && dependencies.mssql === 'ok';
  return { ready, status: ready ? 'ready' : 'not_ready', dependencies };
};
```

The only SQL here is checked-in, read-only `SELECT 1`. Agent tests inject fake checks and do not execute it.

- [ ] **Step 6: Add health routes before session middleware**

Create `server/routes/health.ts`:

```ts
import express from 'express';
import { checkReadiness, ReadinessChecks } from '../services/readiness';

export const createHealthRouter = (checks?: ReadinessChecks) => {
  const router = express.Router();

  router.get('/health', (_req, res) => {
    res.status(200).json({ status: 'ok', timestamp: new Date().toISOString() });
  });

  router.get('/ready', async (_req, res, next) => {
    try {
      const result = await checkReadiness(checks);
      res.status(result.ready ? 200 : 503).json(result);
    } catch (error) {
      next(error);
    }
  });

  return router;
};

export default createHealthRouter();
```

- [ ] **Step 7: Implement idempotent graceful shutdown**

Create `server/services/gracefulShutdown.ts`:

```ts
import type { Server } from 'node:http';

type Logger = Pick<Console, 'info' | 'error'>;

export interface GracefulShutdownOptions {
  server: Pick<Server, 'close'>;
  closeResources: () => Promise<void>;
  exit?: (code: number) => void;
  timeoutMs?: number;
  log?: Logger;
}

export const createGracefulShutdown = ({
  server,
  closeResources,
  exit = (code) => process.exit(code),
  timeoutMs = 10_000,
  log = console
}: GracefulShutdownOptions) => {
  let shuttingDown = false;

  return (signal: NodeJS.Signals): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info(`[shutdown] ${signal} received; draining requests`);

    const forceTimer = setTimeout(() => {
      log.error('[shutdown] grace period expired; forcing exit');
      exit(1);
    }, timeoutMs);
    forceTimer.unref();

    server.close((serverError?: Error) => {
      void closeResources()
        .then(() => {
          clearTimeout(forceTimer);
          exit(serverError ? 1 : 0);
        })
        .catch((error: unknown) => {
          clearTimeout(forceTimer);
          log.error('[shutdown] resource cleanup failed', error);
          exit(1);
        });
    });
  };
};

export const installGracefulShutdown = (options: GracefulShutdownOptions): void => {
  const shutdown = createGracefulShutdown(options);
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
};
```

- [ ] **Step 8: Wire health and shutdown in `server/index.ts`**

Import:

```ts
import healthRoutes from './routes/health';
import { closePostgresPool } from './db/postgres';
import { closeMssqlPool } from './db/mssql';
import { installGracefulShutdown } from './services/gracefulShutdown';
```

Mount health before `createSessionMiddleware()`:

```ts
app.use('/api', healthRoutes);
app.use(createSessionMiddleware());
```

Remove the old inline `/api/health` handler. Replace the final `app.listen` call with:

```ts
const server = app.listen(PORT, () => {
  console.log(`[server] Listening on http://localhost:${PORT}`);
});

installGracefulShutdown({
  server,
  closeResources: async () => {
    const results = await Promise.allSettled([closePostgresPool(), closeMssqlPool()]);
    const failed = results.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
});
```

- [ ] **Step 9: Run mock-only lifecycle verification**

Run:

```powershell
node --test --import tsx server/tests/readiness.test.ts server/tests/dbLifecycle.test.ts server/tests/gracefulShutdown.test.ts
npm run typecheck
npm run build:server
```

Expected: all focused tests pass; typecheck and server build exit 0. No command connects to a database.

- [ ] **Step 10: Run staged GitNexus change detection and commit**

Stage Task 5 files, run:

```text
gitnexus_detect_changes({ repo: "TCTimecard", scope: "staged" })
```

Expected: health entry point, new readiness/shutdown services, adjacent close exports, and tests. Confirm `getMssqlPool` itself is not listed as a changed symbol.

Commit:

```powershell
git add server/services/readiness.ts server/services/gracefulShutdown.ts server/routes/health.ts server/tests/readiness.test.ts server/tests/dbLifecycle.test.ts server/tests/gracefulShutdown.test.ts server/db/postgres.ts server/db/mssql.ts server/index.ts
git commit -m "feat: add readiness and graceful shutdown"
```

---

### Task 6: Human-Operated 200-User Load Harness and Replit Runbook

**Files:**
- Create: `load-tests/replit-200-users.mjs`
- Create: `load-tests/credentials.example.json`
- Create: `docs/operations/replit-200-user-runbook.md`
- Modify: `.gitignore`
- Modify: `package.json`
- Modify: `README.md`

**Interfaces:**
- Consumes: a human-supplied JSON credential file and a deployed HTTPS base URL.
- Produces: `npm run load:test`, a JSON result artifact, console threshold summary, and a nonzero exit code when thresholds fail.
- Safety: agents may run `node --check` on the file but must never launch `npm run load:test` because login writes PostgreSQL session rows.

- [ ] **Step 1: Add credential/result ignores before creating local artifacts**

Append to `.gitignore`:

```gitignore
load-tests/credentials*.json
!load-tests/credentials.example.json
load-test-results*.json
```

- [ ] **Step 2: Create the secret-free credential example**

Create `load-tests/credentials.example.json`:

```json
{
  "tutors": [
    {
      "identifier": "loadtest-tutor@example.test",
      "password": "replace-at-runtime",
      "selectedAccount": { "accountType": "TUTOR", "accountId": 1001 },
      "writeActions": []
    }
  ],
  "admins": [
    {
      "identifier": "loadtest-admin@example.test",
      "password": "replace-at-runtime",
      "selectedAccount": { "accountType": "ADMIN", "accountId": 2001 },
      "writeActions": []
    }
  ]
}
```

Real credentials must be stored outside version control.

- [ ] **Step 3: Create the native Node harness**

Create `load-tests/replit-200-users.mjs` with these complete behaviors:

```js
import fs from 'node:fs';
import { performance } from 'node:perf_hooks';

const numberEnv = (name, fallback) => {
  const value = process.env[name];
  if (!value) return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative number`);
  return parsed;
};

const requiredEnv = (name) => {
  const value = String(process.env[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const BASE_URL = requiredEnv('LOAD_TEST_BASE_URL').replace(/\/$/, '');
const CREDENTIALS_FILE = requiredEnv('LOAD_TEST_CREDENTIALS_FILE');
const RESULTS_FILE = process.env.LOAD_TEST_RESULTS_FILE || 'load-test-results.json';
const USERS = numberEnv('LOAD_TEST_USERS', 200);
const DURATION_SECONDS = numberEnv('LOAD_TEST_DURATION_SECONDS', 900);
const RAMP_SECONDS = numberEnv('LOAD_TEST_RAMP_SECONDS', 60);
const TUTOR_PERCENT = numberEnv('LOAD_TEST_TUTOR_PERCENT', 90);
const THINK_MIN_MS = numberEnv('LOAD_TEST_THINK_MIN_MS', 1000);
const THINK_MAX_MS = numberEnv('LOAD_TEST_THINK_MAX_MS', 3000);
const EXPORT_CONCURRENCY = numberEnv('LOAD_TEST_EXPORT_CONCURRENCY', 3);
const ENABLE_WRITES = process.env.LOAD_TEST_ENABLE_WRITES === 'true';

if (!Number.isInteger(USERS) || USERS < 1) throw new Error('LOAD_TEST_USERS must be a positive integer');
if (TUTOR_PERCENT < 0 || TUTOR_PERCENT > 100) throw new Error('LOAD_TEST_TUTOR_PERCENT must be 0-100');
if (THINK_MAX_MS < THINK_MIN_MS) throw new Error('LOAD_TEST_THINK_MAX_MS must be >= LOAD_TEST_THINK_MIN_MS');

const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8'));
if (!Array.isArray(credentials.tutors) || !credentials.tutors.length) throw new Error('credentials.tutors is required');
if (!Array.isArray(credentials.admins) || !credentials.admins.length) throw new Error('credentials.admins is required');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const randomBetween = (min, max) => Math.round(min + Math.random() * (max - min));
const percentile = (sorted, fraction) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] : 0;
const today = new Date().toISOString().slice(0, 10);
const month = today.slice(0, 7);

const samples = [];
let expectedExport429 = 0;
let unexpectedErrors = 0;
let sessionErrors = 0;

const updateCookie = (jar, response) => {
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) jar.cookie = setCookie.split(';', 1)[0];
};

const request = async (jar, label, path, init = {}, expectedStatuses = [200]) => {
  const started = performance.now();
  let status = 0;
  try {
    const response = await fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(jar.cookie ? { Cookie: jar.cookie } : {}),
        ...(init.headers || {})
      }
    });
    status = response.status;
    updateCookie(jar, response);
    const text = await response.text();
    let body = null;
    if (text) {
      try { body = JSON.parse(text); } catch { body = text; }
    }
    const durationMs = performance.now() - started;
    const isExport429 = label.startsWith('export:') && status === 429;
    if (isExport429) expectedExport429 += 1;
    else if (!expectedStatuses.includes(status)) unexpectedErrors += 1;
    if (status === 401 || status === 403) sessionErrors += 1;
    samples.push({ label, status, durationMs, export: label.startsWith('export:') });
    return { status, body, headers: response.headers };
  } catch (error) {
    unexpectedErrors += 1;
    samples.push({ label, status, durationMs: performance.now() - started, export: label.startsWith('export:'), error: String(error) });
    throw error;
  }
};

const login = async (jar, credential, role) => {
  const loginResult = await request(jar, `${role}:login`, '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ identifier: credential.identifier, password: credential.password })
  });
  if (loginResult.body?.session) return loginResult.body.session;
  if (!loginResult.body?.requiresSelection || !loginResult.body?.selectionToken) {
    throw new Error(`${role} login did not return a session or selection token`);
  }
  const selectedAccount = credential.selectedAccount ?? loginResult.body.accounts?.find((item) => item.accountType === role.toUpperCase());
  if (!selectedAccount) throw new Error(`${role} credential requires selectedAccount`);
  const selection = await request(jar, `${role}:select-account`, '/api/auth/select-account', {
    method: 'POST',
    body: JSON.stringify({
      selectionToken: loginResult.body.selectionToken,
      selectedAccount: { accountType: selectedAccount.accountType, accountId: selectedAccount.accountId }
    })
  });
  return selection.body?.session;
};

const tutorPaths = [
  ['tutor:session', '/api/auth/me'],
  ['tutor:weekly', '/api/hours/me/weekly'],
  ['tutor:pay-period', '/api/hours/me/pay-period'],
  ['tutor:monthly', `/api/hours/me/monthly?month=${month}`],
  ['tutor:clock-state', '/api/clock/me/state'],
  ['tutor:calendar', `/api/calendar/me/month?month=${month}`]
];

const adminPaths = (franchiseId) => [
  ['admin:session', '/api/auth/me'],
  ['admin:pay-period', `/api/pay-period/current?franchiseId=${franchiseId}`],
  ['admin:extra-pending', `/api/extrahours/admin/pending?franchiseId=${franchiseId}&limit=20`],
  ['admin:timeoff-pending', `/api/timeoff/admin/pending?franchiseId=${franchiseId}&limit=20`],
  ['admin:entry-pending', `/api/time-entry/admin/pending?franchiseId=${franchiseId}&limit=20`],
  ['admin:summary', `/api/hours/admin/pay-period/summary?franchiseId=${franchiseId}&forDate=${today}`]
];

const renderPath = (path, session) => path
  .replaceAll('{franchiseId}', String(session.franchiseId))
  .replaceAll('{accountId}', String(session.accountId));

const runWriteAction = async (jar, credential, session, index) => {
  if (!ENABLE_WRITES || !Array.isArray(credential.writeActions) || !credential.writeActions.length) return;
  const action = credential.writeActions[index % credential.writeActions.length];
  await request(
    jar,
    `${session.accountType.toLowerCase()}:controlled-write`,
    renderPath(action.path, session),
    { method: action.method, body: action.body === undefined ? undefined : JSON.stringify(action.body) },
    action.expectedStatuses ?? [200]
  );
};

const runVirtualUser = async (index, role, deadline) => {
  await sleep((index / USERS) * RAMP_SECONDS * 1000);
  const accountList = role === 'tutor' ? credentials.tutors : credentials.admins;
  const credential = accountList[index % accountList.length];
  const jar = { cookie: '' };
  const session = await login(jar, credential, role);
  if (!session?.franchiseId) throw new Error(`${role} session has no franchiseId`);
  let iteration = 0;
  while (Date.now() < deadline) {
    const paths = role === 'tutor' ? tutorPaths : adminPaths(session.franchiseId);
    const [label, path] = paths[Math.floor(Math.random() * paths.length)];
    await request(jar, label, path);
    if (iteration > 0 && iteration % 30 === 0) await runWriteAction(jar, credential, session, iteration);
    iteration += 1;
    await sleep(randomBetween(THINK_MIN_MS, THINK_MAX_MS));
  }
};

const runExportWave = async (deadline) => {
  await sleep(RAMP_SECONDS * 1000);
  const jobs = Array.from({ length: EXPORT_CONCURRENCY }, async (_, index) => {
    const credential = credentials.admins[index % credentials.admins.length];
    const jar = { cookie: '' };
    const session = await login(jar, credential, 'admin');
    if (Date.now() >= deadline) return;
    await request(
      jar,
      'export:pay-period',
      `/api/hours/admin/pay-period/export?franchiseId=${session.franchiseId}&forDate=${today}&format=xlsx`,
      {},
      [200, 404]
    );
  });
  await Promise.all(jobs);
};

const tutorUsers = Math.round(USERS * (TUTOR_PERCENT / 100));
const deadline = Date.now() + (RAMP_SECONDS + DURATION_SECONDS) * 1000;
const workers = Array.from({ length: USERS }, (_, index) =>
  runVirtualUser(index, index < tutorUsers ? 'tutor' : 'admin', deadline)
);

const workerResults = await Promise.allSettled([...workers, runExportWave(deadline)]);
const workerFailures = workerResults
  .filter((item) => item.status === 'rejected')
  .map((item) => String(item.reason));
unexpectedErrors += workerFailures.length;

const nonExportDurations = samples.filter((sample) => !sample.export).map((sample) => sample.durationMs).sort((a, b) => a - b);
const totalRequests = samples.length;
const unexpectedErrorRate = totalRequests ? unexpectedErrors / totalRequests : 1;
const result = {
  config: { users: USERS, tutorUsers, adminUsers: USERS - tutorUsers, durationSeconds: DURATION_SECONDS, exportConcurrency: EXPORT_CONCURRENCY, writesEnabled: ENABLE_WRITES },
  requests: totalRequests,
  unexpectedErrors,
  unexpectedErrorRate,
  expectedExport429,
  sessionErrors,
  workerFailures,
  nonExportLatencyMs: { p95: percentile(nonExportDurations, 0.95), p99: percentile(nonExportDurations, 0.99) },
  passed: workerFailures.length === 0 && unexpectedErrorRate < 0.01 && sessionErrors === 0 && percentile(nonExportDurations, 0.95) < 1500 && percentile(nonExportDurations, 0.99) < 3000
};

fs.writeFileSync(RESULTS_FILE, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
console.log(JSON.stringify(result, null, 2));
if (!result.passed) process.exitCode = 1;
```

- [ ] **Step 4: Add the npm script and syntax-check only**

Add to root `package.json` scripts:

```json
"load:test": "node load-tests/replit-200-users.mjs"
```

Agent-safe verification command:

```powershell
node --check load-tests/replit-200-users.mjs
```

Expected: exits 0. Do not run `npm run load:test`.

- [ ] **Step 5: Write the complete human runbook**

Create `docs/operations/replit-200-user-runbook.md` with these sections and exact content:

```markdown
# Replit 200-User Launch Runbook

## Agent/database safety

Only a human operator may apply SQL or launch authenticated tests. Login creates PostgreSQL session rows, so even the read-route workload is database-mutating at the session layer.

## Manual migration gate

1. Review `server/db/migrations/0006_postgres_sessions.sql`.
2. Apply that checked-in file in an approved non-production PostgreSQL environment using the organization's normal database console.
3. Verify the table and index with these read-only queries:

```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'user_sessions'
ORDER BY ordinal_position;

SELECT indexname, indexdef
FROM pg_indexes
WHERE schemaname = 'public' AND tablename = 'user_sessions'
ORDER BY indexname;
```

Expected columns: `sid` varchar non-null, `sess` json non-null, `expire` timestamp non-null. Expected indexes: primary key on `sid` and `user_sessions_expire_idx` on `expire`.

4. Manually test login, `/api/auth/me`, rolling activity, logout, and a process restart in non-production.
5. Confirm the session survives restart, activity extends expiration, and logout deletes the session.
6. Record approval before applying the identical checked-in migration to production.

## Replit publishing

1. In Publishing, select Reserved VM and Web server.
2. Select 2 vCPU / 8 GB RAM.
3. Build command: `npm run build`.
4. Run command: `npm start`.
5. Set `POSTGRES_POOL_MAX=5` and `MSSQL_POOL_MAX=5` plus all existing required production secrets.
6. Publish only after the production session migration is approved and applied.

## Manual smoke test

1. `GET /api/health` returns 200 without database status.
2. `GET /api/ready` returns 200 with both dependencies `ok`.
3. Tutor login, `/api/auth/me`, dashboard totals, and clock state load normally.
4. Admin login, dashboard, approvals, pay-period summary, one XLSX export, and one attestation export work normally.
5. Replit logs contain no session-store, pool-timeout, or unhandled error.

## Human-operated load stages

Create an ignored credentials file from `load-tests/credentials.example.json`. Use controlled accounts. Leave `LOAD_TEST_ENABLE_WRITES=false` until dedicated write fixtures are approved.

Run 20 users for 5 minutes, then 100 users for 10 minutes, then 200 users for 15 minutes. For each stage set `LOAD_TEST_USERS`, `LOAD_TEST_DURATION_SECONDS`, and a unique `LOAD_TEST_RESULTS_FILE`, then run `npm run load:test` manually.

The 200-user stage must use `LOAD_TEST_TUTOR_PERCENT=90` and `LOAD_TEST_EXPORT_CONCURRENCY=3`.

## Acceptance

- Unexpected error rate below 1%.
- Non-export p95 below 1500 ms.
- Non-export p99 below 3000 ms.
- Zero 401/403 responses after successful login.
- No pool-acquisition timeout or process restart.
- CPU and memory recover after the export wave.
- Three exports finish without material clock-route degradation.

## Failure response

Stop before the next stage if a threshold fails. Save the JSON result, Replit request-duration view, CPU/memory screenshots, and relevant logs. Prefer measured query optimization, lowering export concurrency, or increasing VM size. Do not increase database pool sizes as the first response.

## Rollback

Republish the last known-good application snapshot. Keep the additive `user_sessions` table in place; do not drop it during an application rollback. Restore the prior app only after confirming its session behavior is acceptable for a single Reserved VM.
```

- [ ] **Step 6: Link the runbook from README**

Add a short “200-user Replit launch” section to `README.md` linking the design, implementation plan, and runbook. State that Reserved VM selection, migration application, authenticated smoke tests, and load tests are human-operated.

- [ ] **Step 7: Run documentation/script checks and GitNexus change detection**

Run:

```powershell
node --check load-tests/replit-200-users.mjs
git diff --check
```

Do not launch the harness.

Stage Task 6 files and run:

```text
gitnexus_detect_changes({ repo: "TCTimecard", scope: "staged" })
```

Expected: load tooling/docs/package script only; no application execution flow changes.

Commit:

```powershell
git add .gitignore package.json README.md load-tests/replit-200-users.mjs load-tests/credentials.example.json docs/operations/replit-200-user-runbook.md
git commit -m "test: add manual 200 user load harness"
```

---

### Task 7: Full Agent-Safe Verification and Manual Handoff

**Files:**
- Read: `docs/superpowers/specs/2026-07-12-replit-200-user-hardening-design.md`
- Read: `docs/operations/replit-200-user-runbook.md`
- Verify: all files created or modified by Tasks 1-6; no Task 7 source edit is expected.

**Interfaces:**
- Produces: green mock-backed test/typecheck/build evidence, a GitNexus affected-scope report, and an explicit list of human database/deployment/load gates that remain.

- [ ] **Step 1: Run the complete mock-backed automated suite**

Run separately:

```powershell
npm test
```

```powershell
npm run typecheck
```

```powershell
npm run build
```

```powershell
node --check load-tests/replit-200-users.mjs
```

Expected: every command exits 0. Existing tests use pool overrides; confirm no test creates an unmocked pool before running. Do not set real database secrets and do not run migration or load-test commands.

- [ ] **Step 2: Verify the migration and safety boundaries statically**

Run:

```powershell
rg -n "CREATE TABLE|CREATE INDEX" server/db/migrations/0006_postgres_sessions.sql
rg -n "POSTGRES_POOL_MAX=5|MSSQL_POOL_MAX=5" .env.example docs/operations/replit-200-user-runbook.md
rg -n "MAX_CONCURRENT_EXPORTS = 3|Retry-After" server/services/exportConcurrency.ts
rg -n "createTableIfMissing: false|tableName: 'user_sessions'" server/config/sessionMiddleware.ts
git diff --check
```

Expected: only the checked-in migration contains the new DDL, documented pool values are five, export concurrency is three, runtime table creation is disabled, and no whitespace errors exist.

- [ ] **Step 3: Run final GitNexus scope detection before the final implementation commit**

Run:

```text
gitnexus_detect_changes({ repo: "TCTimecard", scope: "all" })
```

Review every changed symbol and affected process. Confirm:

- `getMssqlPool` is not a changed symbol.
- Auth/session entry points are affected only through the new store middleware.
- Pay-period summary flows are affected only by in-flight coalescing.
- Export flows are affected only by the shared three-slot guard.
- Health/startup flows are affected only by readiness and graceful shutdown.

If final verification required code fixes, stage only those fixes, rerun staged `gitnexus_detect_changes`, and commit them with a narrow message. If no fixes were needed, do not create an empty commit.

- [ ] **Step 4: Hand off the mandatory human gates without claiming completion**

Report these as incomplete until a human supplies evidence:

1. Manual review and non-production application of `0006_postgres_sessions.sql`.
2. Read-only schema/index query output and non-production restart/session checks.
3. Human-approved production migration application.
4. Reserved VM 2 vCPU / 8 GB publication with both pool secrets set to five.
5. Manual smoke-test results.
6. Human-launched 20-, 100-, and 200-user result JSON files plus Replit CPU/memory/request-duration evidence.

Do not mark the overarching goal complete until the evidence proves every acceptance criterion.

## Plan Self-Review

- Spec coverage: Tasks 1-6 cover pool sizing, durable sessions, production SQL file, summary coalescing, three-export limiting, health/readiness, graceful shutdown, Replit operations, and the 200-user harness. Task 7 covers final automated and manual evidence gates.
- Database safety: every agent-run command is mock-backed, static, typecheck, or build-only. Migration, login, smoke, and load execution are explicitly human-operated.
- Type consistency: route consumers use the exact exported names defined by the producing tasks; the critical `getMssqlPool` signature is unchanged.
- Scope: no Redis, queue, worker, distributed lock, broad rate limiting, or unrelated query/schema redesign is included.
