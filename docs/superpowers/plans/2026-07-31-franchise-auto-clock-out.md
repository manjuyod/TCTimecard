# Franchise Auto Clock-Out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an opt-in franchise setting that automatically closes and submits tutor clock sessions at the exact end of the tutor's latest final scheduled block.

**Architecture:** A dedicated admin settings API and page persist `auto_clock_out_enabled` in PostgreSQL. An in-process scheduler wakes only during the first and last ten minutes of each hour, claims a PostgreSQL advisory lock, batch-loads the latest schedules for eligible open sessions from MSSQL, and delegates exact-time closure to the same transactional finalization service used by manual clock-out.

**Tech Stack:** Node.js 18.18+, TypeScript 5.9, Express 4, React 18, Vite 5, PostgreSQL via `pg`, SQL Server via `mssql`, Luxon, Node test runner, Vitest, Testing Library.

## Global Constraints

- Automatic clock-out is franchise-wide and defaults to `false` for every existing and new franchise.
- The authoritative target is the end of the latest valid interval in the tutor's latest MSSQL schedule for the current work date.
- Split schedule gaps and active breaks never trigger an intermediate clock-out.
- Scheduler database work occurs only during minute values `00`-`09` and `50`-`59`.
- A late detection stores the exact scheduled end, never the detection time.
- Missing, malformed, or unavailable schedules leave the session open; the worker never guesses a timestamp.
- Automatic completion uses the existing comparison policy: matching time may auto-approve, and mismatches become pending.
- Automatic completion does not wait for interactive attestation; existing attestation gates remain unchanged for tutor actions.
- At most four PostgreSQL connections may participate in one worker pass, including the connection holding the advisory lock, leaving six of the configured ten connections for web traffic.
- The 80-tutor path uses one batched MSSQL request, not one request per tutor.
- Preserve the existing `/api/clock/me/out`, calendar snapshot, pay-period settings, and clock-state response contracts.
- Do not introduce Windows Task Scheduler, SQL Server Agent, `pg_cron`, a foreign-data wrapper, or a schedule replication subsystem.
- Before editing an existing function, class, or method, run `gitnexus_impact({ target, direction: "upstream", repo: "TCTimecard" })`. Warn and stop for user confirmation if risk is HIGH or CRITICAL.
- Before every commit, stage the intended files and run `gitnexus_detect_changes({ repo: "TCTimecard", scope: "staged" })`; review every affected process before committing.
- Follow strict red-green-refactor: write the behavior test, run it and confirm the expected failure, then write production code.

## Planned File Structure

### New server files

- `server/db/migrations/0007_franchise_auto_clock_out.sql` — additive setting column.
- `server/services/franchiseSettings.ts` — typed read/update access for general franchise settings.
- `server/routes/adminSettings.ts` — admin-only franchise settings HTTP contract.
- `server/services/scheduleSource.ts` — reusable single-tutor and batched MSSQL schedule access plus server-built snapshots.
- `server/services/clockOutFinalization.ts` — shared transaction-local manual/automatic completion logic.
- `server/services/autoClockOutScheduler.ts` — cadence, advisory locking, candidate selection, batch lookup, bounded processing, logging, and timer lifecycle.
- `server/tests/franchiseSettings.test.ts` — repository behavior.
- `server/tests/adminSettingsRoutes.test.ts` — admin settings authentication, scope, validation, and persistence.
- `server/tests/scheduleSource.test.ts` — batch and snapshot behavior.
- `server/tests/clockOutFinalization.test.ts` — exact closure, breaks, comparison, approval, audit, and idempotency.
- `server/tests/autoClockOutScheduler.test.ts` — cadence, no-candidate fast path, 80-tutor batching, locking, concurrency, failures, and stop behavior.

### New client files

- `client/src/pages/admin/SettingsPage.tsx` — automatic timekeeping and payroll settings page.
- `client/src/pages/admin/settingsModel.ts` — pure payroll form mapping and payload validation.
- `client/src/lib/autoClockOut.ts` — final schedule end and one-time refresh calculation.
- `client/src/test/setup.ts` and `client/vitest.config.ts` — React component test environment.
- `client/src/pages/admin/SettingsPage.test.tsx` — rendered settings behavior and admin routing.
- `client/tests/adminSettingsApi.test.ts` — client API request contract.
- `client/src/pages/admin/settingsModel.test.ts` — payroll form validation after the move.
- `client/tests/autoClockOut.test.ts` — one-time refresh timing.
- `client/src/components/tutor/ClockWidget.test.tsx` — focus/visibility state refresh.

### Existing files to modify

- `server/index.ts` — mount settings routes, start the scheduler, and stop it before pool shutdown.
- `server/routes/hours.ts` — consume the extracted schedule source without changing route payloads.
- `server/routes/clock.ts` — delegate the closed-session transaction core to the shared finalizer.
- `server/services/clockSubmission.ts` — carry an explicit `clock_out` or `auto_clock_out` audit source.
- `server/tests/clockRoutes.test.ts` and `server/tests/clockSubmission.test.ts` — preserve manual behavior and audit source.
- `client/src/lib/api.ts` — general franchise settings types and calls.
- `client/src/App.tsx` — Settings navigation and admin route.
- `client/src/components/layout/AppShell.tsx` — gear icon support.
- `client/src/pages/admin/Dashboard.tsx` — remove the payroll form while retaining metrics and current pay period.
- `client/src/components/tutor/ClockWidget.tsx` — focus/visibility and calculated one-time refresh.
- `package.json`, `client/package.json`, and `client/package-lock.json` — UI test command and dependencies.
- `README.md` and `docs/operations/replit-200-user-runbook.md` — routes, worker cadence, rollout, monitoring, and burst verification.

## Pre-Implementation Blast Radius

GitNexus analysis on the approved design found no HIGH or CRITICAL risk:

- `App`, `AppShell`, `AdminDashboardPage`, and `ClockWidget`: LOW, no indexed upstream callers.
- `toSettingsFormState`: LOW, two direct callers (`load`, `handleSavePayrollSettings`) inside the admin dashboard flow.
- `parseDayInput`: LOW, one direct caller (`handleSavePayrollSettings`) inside the admin dashboard flow.
- `fetchCalendarEntries`: LOW, one direct route-module caller; indirect coverage is `server/index.ts` and `server/tests/hoursRoutes.test.ts`.
- `/clock/me/out` API: LOW, unchanged success envelope `{ state }` and error envelope.
- `resolveClockOutSubmission`: LOW, no indexed upstream blast radius.

Refresh the GitNexus index with `npx gitnexus analyze` before Task 1 because the committed design documentation moved HEAD beyond the current index.

---

### Task 1: Persist General Franchise Settings

**Files:**
- Create: `server/db/migrations/0007_franchise_auto_clock_out.sql`
- Create: `server/services/franchiseSettings.ts`
- Create: `server/tests/franchiseSettings.test.ts`

**Interfaces:**
- Produces: `FranchiseSettings { franchiseId: number; autoClockOutEnabled: boolean }`.
- Produces: `getFranchiseSettings(franchiseId: number, db?: Queryable): Promise<FranchiseSettings>`.
- Produces: `updateFranchiseSettings(input: FranchiseSettings, db?: Queryable): Promise<FranchiseSettings>`.
- Consumes: the existing `getPostgresPool()` and `franchise_payroll_settings` primary key.

- [ ] **Step 1: Refresh code intelligence and confirm the worktree baseline**

Run:

```powershell
npx gitnexus analyze
git status --short
```

Expected: indexing succeeds and the worktree is clean.

- [ ] **Step 2: Write failing repository tests**

Create `server/tests/franchiseSettings.test.ts` with a query fake that records SQL and parameters. The tests must name the production breaks they catch: a missing row accidentally enabling the feature, incorrect Boolean mapping, and an upsert targeting the wrong franchise.

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getFranchiseSettings,
  updateFranchiseSettings
} from '../services/franchiseSettings';

test('missing franchise settings remain safely disabled', async () => {
  const db = {
    query: async () => ({ rowCount: 0, rows: [] })
  };

  assert.deepEqual(await getFranchiseSettings(77, db as never), {
    franchiseId: 77,
    autoClockOutEnabled: false
  });
});

test('stored auto-clock-out flag is mapped from PostgreSQL', async () => {
  const db = {
    query: async () => ({
      rowCount: 1,
      rows: [{ franchiseid: 77, auto_clock_out_enabled: true }]
    })
  };

  assert.deepEqual(await getFranchiseSettings(77, db as never), {
    franchiseId: 77,
    autoClockOutEnabled: true
  });
});

test('updating settings persists the requested franchise and Boolean', async () => {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return {
        rowCount: 1,
        rows: [{ franchiseid: 77, auto_clock_out_enabled: true }]
      };
    }
  };

  const result = await updateFranchiseSettings(
    { franchiseId: 77, autoClockOutEnabled: true },
    db as never
  );

  assert.deepEqual(calls[0]?.params, [77, true]);
  assert.match(calls[0]?.sql ?? '', /ON CONFLICT \(franchiseid\)/i);
  assert.deepEqual(result, { franchiseId: 77, autoClockOutEnabled: true });
});
```

- [ ] **Step 3: Run the tests and verify the expected red state**

Run:

```powershell
node --test --import tsx server/tests/franchiseSettings.test.ts
```

Expected: FAIL because `../services/franchiseSettings` does not exist.

- [ ] **Step 4: Add the migration and minimal repository implementation**

Create the migration exactly as an additive, disabled-by-default change:

```sql
ALTER TABLE public.franchise_payroll_settings
  ADD COLUMN IF NOT EXISTS auto_clock_out_enabled BOOLEAN NOT NULL DEFAULT FALSE;
```

Implement `server/services/franchiseSettings.ts`:

```ts
import type { Pool, PoolClient } from 'pg';
import { getPostgresPool } from '../db/postgres';

type Queryable = Pick<Pool | PoolClient, 'query'>;

export interface FranchiseSettings {
  franchiseId: number;
  autoClockOutEnabled: boolean;
}

type FranchiseSettingsRow = {
  franchiseid: number;
  auto_clock_out_enabled: boolean;
};

const mapRow = (row: FranchiseSettingsRow): FranchiseSettings => ({
  franchiseId: Number(row.franchiseid),
  autoClockOutEnabled: row.auto_clock_out_enabled === true
});

export const getFranchiseSettings = async (
  franchiseId: number,
  db: Queryable = getPostgresPool()
): Promise<FranchiseSettings> => {
  const result = await db.query<FranchiseSettingsRow>(
    `SELECT franchiseid, auto_clock_out_enabled
       FROM public.franchise_payroll_settings
      WHERE franchiseid = $1
      LIMIT 1`,
    [franchiseId]
  );
  return result.rowCount
    ? mapRow(result.rows[0])
    : { franchiseId, autoClockOutEnabled: false };
};

export const updateFranchiseSettings = async (
  input: FranchiseSettings,
  db: Queryable = getPostgresPool()
): Promise<FranchiseSettings> => {
  const result = await db.query<FranchiseSettingsRow>(
    `INSERT INTO public.franchise_payroll_settings
       (franchiseid, auto_clock_out_enabled, updatedat)
     VALUES ($1, $2, NOW())
     ON CONFLICT (franchiseid) DO UPDATE
       SET auto_clock_out_enabled = EXCLUDED.auto_clock_out_enabled,
           updatedat = NOW()
     RETURNING franchiseid, auto_clock_out_enabled`,
    [input.franchiseId, input.autoClockOutEnabled]
  );
  return mapRow(result.rows[0]);
};
```

- [ ] **Step 5: Verify green and server type safety**

Run:

```powershell
node --test --import tsx server/tests/franchiseSettings.test.ts
npm run build:server
```

Expected: all repository tests PASS and TypeScript compilation succeeds.

- [ ] **Step 6: Review impact and commit the persistence boundary**

Run `gitnexus_detect_changes({ repo: "TCTimecard", scope: "staged" })` after staging only the three Task 1 files. Expected: new symbols and the additive migration only; no existing execution flow changes.

```powershell
git add server/db/migrations/0007_franchise_auto_clock_out.sql server/services/franchiseSettings.ts server/tests/franchiseSettings.test.ts
git commit -m "feat: persist franchise auto clock-out setting"
```

---

### Task 2: Add the Admin Settings API Contract

**Files:**
- Create: `server/routes/adminSettings.ts`
- Create: `server/tests/adminSettingsRoutes.test.ts`
- Create: `client/tests/adminSettingsApi.test.ts`
- Modify: `server/index.ts:8-22,101-116`
- Modify: `client/src/lib/api.ts:137-146,625-654`

**Interfaces:**
- Consumes: `getFranchiseSettings` and `updateFranchiseSettings` from Task 1.
- Produces: `GET /api/admin/settings?franchiseId=<id>` returning `{ settings: FranchiseSettings }`.
- Produces: `PATCH /api/admin/settings` accepting `{ franchiseId?: number; autoClockOutEnabled: boolean }`.
- Produces: client `fetchFranchiseSettings(franchiseId?: number | null)` and `updateFranchiseSettings(args)`.

- [ ] **Step 1: Run required impact checks before editing existing API symbols**

Use GitNexus:

```text
gitnexus_api_impact({ repo: "TCTimecard", file: "server/index.ts" })
gitnexus_impact({ repo: "TCTimecard", target: "apiFetch", direction: "upstream", file_path: "client/src/lib/api.ts", includeTests: true })
```

Expected: review mount-point/API helper consumers; warn the user before code changes if either report is HIGH or CRITICAL.

- [ ] **Step 2: Write failing server route tests**

Create `server/tests/adminSettingsRoutes.test.ts` using the real Express router, session-shaped middleware, an ephemeral HTTP server, and a fake PostgreSQL pool. Define this complete harness before the tests:

```ts
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import express from 'express';
import type { AddressInfo } from 'node:net';
import { setPostgresPoolOverride } from '../db/postgres';
import adminSettingsRoutes from '../routes/adminSettings';

type SessionAuth = {
  accountType: 'ADMIN' | 'TUTOR';
  accountId: number;
  franchiseId: number | null;
};

type SettingRow = { franchiseid: number; auto_clock_out_enabled: boolean };

afterEach(() => setPostgresPoolOverride(undefined));

const createPool = (initial: SettingRow[]) => {
  const rows = new Map(initial.map((row) => [row.franchiseid, { ...row }]));
  let lastUpdatedFranchiseId: number | null = null;
  const pool = {
    async query(sql: string, params: unknown[] = []) {
      const franchiseId = Number(params[0]);
      if (/SELECT franchiseid, auto_clock_out_enabled/i.test(sql)) {
        const row = rows.get(franchiseId);
        return row ? { rowCount: 1, rows: [{ ...row }] } : { rowCount: 0, rows: [] };
      }
      if (/INSERT INTO public\.franchise_payroll_settings/i.test(sql)) {
        lastUpdatedFranchiseId = franchiseId;
        const row = {
          franchiseid: franchiseId,
          auto_clock_out_enabled: params[1] === true
        };
        rows.set(franchiseId, row);
        return { rowCount: 1, rows: [row] };
      }
      throw new Error(`Unexpected query: ${sql}`);
    }
  };
  return { pool, rows, lastUpdatedFranchiseId: () => lastUpdatedFranchiseId };
};

const createApp = (auth: SessionAuth) => {
  const now = new Date().toISOString();
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as never as { session: { auth: object; save(callback?: (error?: Error) => void): void } }).session = {
      auth: { ...auth, createdAt: now, lastSeenAt: now },
      save: (callback) => callback?.()
    };
    next();
  });
  app.use('/api/admin', adminSettingsRoutes);
  app.use((error: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = typeof (error as { status?: unknown })?.status === 'number'
      ? Number((error as { status: number }).status) : 500;
    res.status(status).json({ error: error instanceof Error ? error.message : 'Internal server error' });
  });
  return app;
};

const withServer = async <T>(app: express.Express, run: (baseUrl: string) => Promise<T>): Promise<T> => {
  const server = await new Promise<ReturnType<express.Express['listen']>>((resolve) => {
    const listening = app.listen(0, () => resolve(listening));
  });
  try {
    const address = server.address() as AddressInfo;
    return await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
};
```

Add these complete route tests:

```ts
test('admin reads and enables auto clock-out for the scoped franchise', async () => {
  const harness = createPool([]);
  setPostgresPoolOverride(harness.pool as never);
  const app = createApp({ accountType: 'ADMIN', accountId: 10, franchiseId: 1 });
  await withServer(app, async (baseUrl) => {
    const get = await fetch(`${baseUrl}/api/admin/settings?franchiseId=77`);
    assert.equal(get.status, 200);
    assert.deepEqual(await get.json(), {
      settings: { franchiseId: 77, autoClockOutEnabled: false }
    });

    const patch = await fetch(`${baseUrl}/api/admin/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ franchiseId: 77, autoClockOutEnabled: true })
    });
    assert.equal(patch.status, 200);
    assert.deepEqual(await patch.json(), {
      settings: { franchiseId: 77, autoClockOutEnabled: true }
    });
  });
});

test('non-Boolean auto clock-out payload is rejected', async () => {
  const harness = createPool([]);
  setPostgresPoolOverride(harness.pool as never);
  await withServer(createApp({ accountType: 'ADMIN', accountId: 10, franchiseId: 1 }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/admin/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ franchiseId: 77, autoClockOutEnabled: 'true' })
    });
    assert.equal(response.status, 400);
    assert.match(((await response.json()) as { error: string }).error, /boolean/i);
  });
});

test('tutors cannot access admin settings', async () => {
  const harness = createPool([]);
  setPostgresPoolOverride(harness.pool as never);
  await withServer(createApp({ accountType: 'TUTOR', accountId: 20, franchiseId: 9 }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/admin/settings`);
    assert.equal(response.status, 403);
  });
});

test('fixed-franchise admins cannot override their session franchise', async () => {
  const harness = createPool([]);
  setPostgresPoolOverride(harness.pool as never);
  await withServer(createApp({ accountType: 'ADMIN', accountId: 30, franchiseId: 9 }), async (baseUrl) => {
    const response = await fetch(`${baseUrl}/api/admin/settings`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ franchiseId: 77, autoClockOutEnabled: true })
    });
    assert.equal(response.status, 200);
  });
  assert.equal(harness.lastUpdatedFranchiseId(), 9);
});
```

- [ ] **Step 3: Write a failing client request-contract test**

Create `client/tests/adminSettingsApi.test.ts` and replace `globalThis.fetch` only at the HTTP boundary:

```ts
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import {
  fetchFranchiseSettings,
  updateFranchiseSettings
} from '../src/lib/api';

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

test('franchise settings client sends scoped GET and Boolean PATCH', async () => {
  const calls: Array<{ input: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    calls.push({ input: String(input), init });
    return new Response(JSON.stringify({
      settings: { franchiseId: 77, autoClockOutEnabled: true }
    }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };

  await fetchFranchiseSettings(77);
  await updateFranchiseSettings({ franchiseId: 77, autoClockOutEnabled: true });

  assert.equal(calls[0]?.input, '/api/admin/settings?franchiseId=77');
  assert.equal(calls[1]?.input, '/api/admin/settings');
  assert.equal(calls[1]?.init?.method, 'PATCH');
  assert.deepEqual(JSON.parse(String(calls[1]?.init?.body)), {
    franchiseId: 77,
    autoClockOutEnabled: true
  });
});
```

- [ ] **Step 4: Run both tests and confirm they fail for missing contracts**

Run:

```powershell
node --test --import tsx server/tests/adminSettingsRoutes.test.ts
node --test --import tsx client/tests/adminSettingsApi.test.ts
```

Expected: FAIL because the router and client exports do not exist.

- [ ] **Step 5: Implement and mount the admin router**

Create `server/routes/adminSettings.ts`:

```ts
import express, { NextFunction, Request, Response } from 'express';
import { requireAdmin } from '../middleware/auth';
import { enforceFranchiseScope } from '../middleware/franchiseScope';
import {
  getFranchiseSettings,
  updateFranchiseSettings
} from '../services/franchiseSettings';

const router = express.Router();

const resolveScope = (req: Request, res: Response): number | null => {
  const scope = enforceFranchiseScope(req, {
    requireFranchiseId: true,
    requiredMessage: 'franchiseId is required for admin requests'
  });
  if (scope.error || scope.franchiseId === null) {
    res.status(scope.error?.status ?? 400).json({
      error: scope.error?.message ?? 'franchiseId is required for admin requests'
    });
    return null;
  }
  return scope.franchiseId;
};

router.get('/settings', requireAdmin, async (req, res, next): Promise<void> => {
  const franchiseId = resolveScope(req, res);
  if (franchiseId === null) return;
  try {
    res.status(200).json({ settings: await getFranchiseSettings(franchiseId) });
  } catch (error) {
    next(error);
  }
});

router.patch('/settings', requireAdmin, async (req, res, next): Promise<void> => {
  const franchiseId = resolveScope(req, res);
  if (franchiseId === null) return;
  if (typeof req.body?.autoClockOutEnabled !== 'boolean') {
    res.status(400).json({ error: 'autoClockOutEnabled must be a boolean' });
    return;
  }
  try {
    const settings = await updateFranchiseSettings({
      franchiseId,
      autoClockOutEnabled: req.body.autoClockOutEnabled
    });
    res.status(200).json({ settings });
  } catch (error) {
    next(error);
  }
});

export default router;
```

Mount it in `server/index.ts`:

```ts
import adminSettingsRoutes from './routes/adminSettings';
// after session middleware and alongside authenticated API routes
app.use('/api/admin', adminSettingsRoutes);
```

- [ ] **Step 6: Implement the client API types and functions**

Add to `client/src/lib/api.ts`:

```ts
export interface FranchiseSettings {
  franchiseId: number;
  autoClockOutEnabled: boolean;
}

export const fetchFranchiseSettings = async (
  franchiseId?: number | null
): Promise<FranchiseSettings> => {
  const query = franchiseId !== undefined && franchiseId !== null
    ? `?franchiseId=${franchiseId}`
    : '';
  const result = await apiFetch<{ settings: FranchiseSettings }>(
    `/api/admin/settings${query}`
  );
  return result.settings;
};

export const updateFranchiseSettings = async (args: {
  franchiseId?: number | null;
  autoClockOutEnabled: boolean;
}): Promise<FranchiseSettings> => {
  const payload: Record<string, unknown> = {
    autoClockOutEnabled: args.autoClockOutEnabled
  };
  if (args.franchiseId !== undefined && args.franchiseId !== null) {
    payload.franchiseId = args.franchiseId;
  }
  const result = await apiFetch<{ settings: FranchiseSettings }>(
    '/api/admin/settings',
    { method: 'PATCH', body: JSON.stringify(payload) }
  );
  return result.settings;
};
```

- [ ] **Step 7: Verify green, typecheck, review, and commit**

Run:

```powershell
node --test --import tsx server/tests/adminSettingsRoutes.test.ts
node --test --import tsx client/tests/adminSettingsApi.test.ts
npm run typecheck
```

Expected: all tests PASS and both TypeScript projects typecheck.

Stage the Task 2 files, run `gitnexus_detect_changes({ repo: "TCTimecard", scope: "staged" })`, and confirm only the new admin route plus `server/index.ts` API mounting and client API symbols are affected.

```powershell
git add server/routes/adminSettings.ts server/tests/adminSettingsRoutes.test.ts server/index.ts client/src/lib/api.ts client/tests/adminSettingsApi.test.ts
git commit -m "feat: add franchise settings API"
```

---

### Task 3: Build the Admin Settings Page and Move Payroll Configuration

**Files:**
- Create: `client/src/pages/admin/SettingsPage.tsx`
- Create: `client/src/pages/admin/settingsModel.ts`
- Create: `client/src/pages/admin/SettingsPage.test.tsx`
- Create: `client/src/pages/admin/settingsModel.test.ts`
- Create: `client/src/test/setup.ts`
- Create: `client/vitest.config.ts`
- Modify: `client/src/App.tsx:1-76`
- Modify: `client/src/components/layout/AppShell.tsx:1-37`
- Modify: `client/src/pages/admin/Dashboard.tsx:1-386`
- Modify: `client/package.json`
- Modify: `client/package-lock.json`
- Modify: `package.json`

**Interfaces:**
- Consumes: general settings and payroll settings client APIs from Tasks 1-2 and existing code.
- Produces: `/admin/settings`, admin sidebar item `{ label: 'Settings', path: '/admin/settings', icon: 'Settings' }`.
- Produces: `buildPayrollSettingsPayload(form, franchiseId)` returning a discriminated success/error result.
- Preserves: current dashboard metrics, approval links, franchise selector, current pay period, and payroll validation.

- [ ] **Step 1: Re-run exact GitNexus impacts before moving existing symbols**

Use the exact function targets and stop if risk has risen to HIGH or CRITICAL:

```text
gitnexus_impact({ repo: "TCTimecard", target: "App", direction: "upstream", file_path: "client/src/App.tsx", kind: "Function", includeTests: true })
gitnexus_impact({ repo: "TCTimecard", target: "AppShell", direction: "upstream", file_path: "client/src/components/layout/AppShell.tsx", kind: "Function", includeTests: true })
gitnexus_impact({ repo: "TCTimecard", target: "AdminDashboardPage", direction: "upstream", file_path: "client/src/pages/admin/Dashboard.tsx", kind: "Function", includeTests: true })
gitnexus_impact({ repo: "TCTimecard", target_uid: "Function:client/src/pages/admin/Dashboard.tsx:toSettingsFormState", target: "toSettingsFormState", direction: "upstream", includeTests: true })
gitnexus_impact({ repo: "TCTimecard", target_uid: "Function:client/src/pages/admin/Dashboard.tsx:parseDayInput", target: "parseDayInput", direction: "upstream", includeTests: true })
```

- [ ] **Step 2: Install a focused React test environment**

Run:

```powershell
npm install --prefix client --save-dev vitest@^2.1.9 jsdom@^25.0.1 @testing-library/react@^16.1.0 @testing-library/jest-dom@^6.6.3
```

Add client script `"test": "vitest run"`, root script `"test:client-ui": "npm run test --prefix client"`, and insert `npm run test:client-ui` into the root `test` chain.

Create `client/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    restoreMocks: true
  }
});
```

Create `client/src/test/setup.ts`:

```ts
import '@testing-library/jest-dom/vitest';

Object.defineProperty(window, 'matchMedia', {
  writable: true,
  value: () => ({ matches: false, addListener() {}, removeListener() {} })
});
```

- [ ] **Step 3: Write failing pure form-model tests**

Create `client/src/pages/admin/settingsModel.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import {
  buildPayrollSettingsPayload,
  toPayrollSettingsFormState
} from './settingsModel';

describe('admin settings payroll form', () => {
  it('maps nullable API day values to editable strings', () => {
    expect(toPayrollSettingsFormState({
      franchiseId: 77,
      timezone: 'America/Los_Angeles',
      payPeriodType: 'biweekly',
      customPeriod1StartDay: null,
      customPeriod1EndDay: null,
      customPeriod2StartDay: null,
      customPeriod2EndDay: null
    })).toEqual({
      payPeriodType: 'biweekly',
      customPeriod1StartDay: '',
      customPeriod1EndDay: '',
      customPeriod2StartDay: '',
      customPeriod2EndDay: ''
    });
  });

  it('rejects incomplete custom semimonthly days', () => {
    expect(buildPayrollSettingsPayload({
      payPeriodType: 'custom_semimonthly',
      customPeriod1StartDay: '11',
      customPeriod1EndDay: '25',
      customPeriod2StartDay: '',
      customPeriod2EndDay: '10'
    }, 77)).toEqual({
      ok: false,
      error: 'Custom recurring payroll day values must be integers between 1 and 31.'
    });
  });

  it('builds all four valid custom days', () => {
    expect(buildPayrollSettingsPayload({
      payPeriodType: 'custom_semimonthly',
      customPeriod1StartDay: '11',
      customPeriod1EndDay: '25',
      customPeriod2StartDay: '26',
      customPeriod2EndDay: '10'
    }, 77)).toEqual({
      ok: true,
      payload: {
        franchiseId: 77,
        payPeriodType: 'custom_semimonthly',
        customPeriod1StartDay: 11,
        customPeriod1EndDay: 25,
        customPeriod2StartDay: 26,
        customPeriod2EndDay: 10
      }
    });
  });
});
```

- [ ] **Step 4: Write failing rendered UI and route tests**

Create `client/src/pages/admin/SettingsPage.test.tsx`. Mock only `useAuth`; keep the page, router, API client, and fetch behavior real. Return complete settings payloads from the fetch fake.

```tsx
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import App from '../../App';
import { SettingsPage } from './SettingsPage';

vi.mock('../../providers/AuthProvider', () => ({
  useAuth: () => ({
    session: {
      accountType: 'ADMIN', accountId: 10, franchiseId: 1,
      displayName: 'Admin', createdAt: '', lastSeenAt: ''
    },
    loading: false,
    logout: vi.fn()
  })
}));

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const installSettingsFetch = () => {
  const calls: Array<{ path: string; init?: RequestInit }> = [];
  globalThis.fetch = async (input, init) => {
    const path = String(input);
    calls.push({ path, init });
    if (path.startsWith('/api/admin/settings')) {
      return new Response(JSON.stringify({
        settings: { franchiseId: 77, autoClockOutEnabled: false }
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (path.startsWith('/api/pay-period/settings')) {
      return new Response(JSON.stringify({ settings: {
        franchiseId: 77, timezone: 'America/Los_Angeles',
        payPeriodType: 'biweekly', customPeriod1StartDay: null,
        customPeriod1EndDay: null, customPeriod2StartDay: null,
        customPeriod2EndDay: null
      } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`Unexpected request: ${path}`);
  };
  return calls;
};

describe('admin settings page', () => {
  it('loads and saves the franchise-wide auto clock-out switch', async () => {
    const calls = installSettingsFetch();
    render(<MemoryRouter><SettingsPage /></MemoryRouter>);

    const switchControl = await screen.findByRole('switch', { name: /auto clock-out/i });
    expect(switchControl).not.toBeChecked();
    fireEvent.click(switchControl);
    fireEvent.click(screen.getByRole('button', { name: /save automatic timekeeping/i }));

    await waitFor(() => expect(calls.some((call) => call.init?.method === 'PATCH')).toBe(true));
    const patch = calls.find((call) => call.init?.method === 'PATCH');
    expect(JSON.parse(String(patch?.init?.body))).toEqual({
      franchiseId: 1,
      autoClockOutEnabled: true
    });
    expect(screen.getByText(/choose how recurring pay periods/i)).toBeInTheDocument();
  });

  it('exposes the settings route inside the admin shell', async () => {
    installSettingsFetch();
    render(<MemoryRouter initialEntries={['/admin/settings']}><App /></MemoryRouter>);
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /settings/i })).toHaveAttribute('href', '/admin/settings');
  });
});
```

- [ ] **Step 5: Run the focused tests and confirm the expected red state**

Run:

```powershell
npm run test --prefix client -- SettingsPage.test.tsx settingsModel.test.ts
```

Expected: FAIL because `SettingsPage` and `settingsModel` do not exist and the route/nav item is missing.

- [ ] **Step 6: Implement the form model**

Create `client/src/pages/admin/settingsModel.ts` with the exact public contract used by the tests:

```ts
import type { PayrollSettings, PayPeriodType } from '../../lib/api';

export type PayrollSettingsFormState = {
  payPeriodType: PayPeriodType;
  customPeriod1StartDay: string;
  customPeriod1EndDay: string;
  customPeriod2StartDay: string;
  customPeriod2EndDay: string;
};

export const EMPTY_PAYROLL_SETTINGS_FORM: PayrollSettingsFormState = {
  payPeriodType: 'biweekly',
  customPeriod1StartDay: '', customPeriod1EndDay: '',
  customPeriod2StartDay: '', customPeriod2EndDay: ''
};

export const toPayrollSettingsFormState = (
  settings: PayrollSettings
): PayrollSettingsFormState => ({
  payPeriodType: settings.payPeriodType,
  customPeriod1StartDay: settings.customPeriod1StartDay?.toString() ?? '',
  customPeriod1EndDay: settings.customPeriod1EndDay?.toString() ?? '',
  customPeriod2StartDay: settings.customPeriod2StartDay?.toString() ?? '',
  customPeriod2EndDay: settings.customPeriod2EndDay?.toString() ?? ''
});

const parseDay = (value: string): number | null => {
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 31 ? parsed : null;
};

export const buildPayrollSettingsPayload = (
  form: PayrollSettingsFormState,
  franchiseId: number
): { ok: true; payload: Parameters<typeof import('../../lib/api').updatePayrollSettings>[0] }
 | { ok: false; error: string } => {
  if (form.payPeriodType !== 'custom_semimonthly') {
    return { ok: true, payload: { franchiseId, payPeriodType: form.payPeriodType } };
  }
  const values = [form.customPeriod1StartDay, form.customPeriod1EndDay,
    form.customPeriod2StartDay, form.customPeriod2EndDay].map(parseDay);
  if (values.some((value) => value === null)) {
    return { ok: false, error: 'Custom recurring payroll day values must be integers between 1 and 31.' };
  }
  return { ok: true, payload: {
    franchiseId, payPeriodType: form.payPeriodType,
    customPeriod1StartDay: values[0]!, customPeriod1EndDay: values[1]!,
    customPeriod2StartDay: values[2]!, customPeriod2EndDay: values[3]!
  } };
};
```

- [ ] **Step 7: Implement the page, navigation, and dashboard move**

Create `SettingsPage.tsx` with separate loading/saving/error state for the automatic and payroll cards. Use the existing `getSessionFranchiseId` and `isSelectorAllowed` rules. The automatic control must be a labeled native checkbox with `role="switch"` and a separate save button:

```tsx
<Card>
  <CardHeader>
    <CardTitle>Automatic timekeeping</CardTitle>
    <CardDescription>
      Clock tutors out at the end of their final scheduled block. Time differences still require approval.
    </CardDescription>
  </CardHeader>
  <CardContent className="space-y-4">
    <label className="flex items-center justify-between gap-4 rounded-lg border p-4">
      <span>
        <span className="block text-sm font-semibold">Auto clock-out</span>
        <span className="block text-sm text-muted-foreground">Applies to every tutor in this franchise.</span>
      </span>
      <input
        type="checkbox"
        role="switch"
        aria-label="Auto clock-out"
        checked={autoClockOutEnabled}
        onChange={(event) => setAutoClockOutEnabled(event.target.checked)}
        disabled={loading || autoSaving}
      />
    </label>
    <InlineError message={autoError} />
    <div className="flex justify-end">
      <Button onClick={() => void saveAutomaticTimekeeping()} disabled={loading || autoSaving}>
        {autoSaving ? 'Saving...' : 'Save automatic timekeeping'}
      </Button>
    </div>
  </CardContent>
</Card>
```

Move the complete existing Payroll Settings card from `Dashboard.tsx` into the second card on `SettingsPage.tsx`, replacing local parsing with `buildPayrollSettingsPayload`. Move `PAY_PERIOD_TYPE_OPTIONS` with it. The load function performs:

```ts
const [general, payroll] = await Promise.all([
  fetchFranchiseSettings(franchiseId),
  fetchPayrollSettings(franchiseId)
]);
setAutoClockOutEnabled(general.autoClockOutEnabled);
setPayrollSettings(payroll);
setPayrollForm(toPayrollSettingsFormState(payroll));
```

In `App.tsx`, import `SettingsPage`, add the nav item, and add the admin route. In `AppShell.tsx`, import Lucide `Settings` and add it to `iconMap`.

Remove from `Dashboard.tsx` only the payroll settings imports, helper types/constants/functions, settings state, fourth `load()` promise, save handler, and payroll card. Keep `fetchPayPeriodCurrent` and the current-pay-period card.

- [ ] **Step 8: Verify UI and all prior client helpers**

Run:

```powershell
npm run test --prefix client -- SettingsPage.test.tsx settingsModel.test.ts
npm run test:client-helpers
npm run build:client
npm run typecheck
```

Expected: rendered tests PASS, all existing client helpers PASS, and the production client builds.

- [ ] **Step 9: Review impact and commit the admin experience**

Stage only Task 3 files, run `gitnexus_detect_changes({ repo: "TCTimecard", scope: "staged" })`, and confirm the affected area is limited to admin routing/navigation/dashboard/settings plus test configuration.

```powershell
git add package.json client/package.json client/package-lock.json client/vitest.config.ts client/src/test/setup.ts client/src/App.tsx client/src/components/layout/AppShell.tsx client/src/pages/admin/Dashboard.tsx client/src/pages/admin/SettingsPage.tsx client/src/pages/admin/SettingsPage.test.tsx client/src/pages/admin/settingsModel.ts client/src/pages/admin/settingsModel.test.ts
git commit -m "feat: add admin franchise settings page"
```

---

### Task 4: Extract and Batch the MSSQL Schedule Source

**Files:**
- Create: `server/services/scheduleSource.ts`
- Create: `server/tests/scheduleSource.test.ts`
- Modify: `server/routes/hours.ts:1-47,453-508,1191-1333`
- Test: `server/tests/hoursRoutes.test.ts`

**Interfaces:**
- Produces: `fetchCalendarEntries(tutorId, startDateISO, endDateExclusiveISO)` with the existing return shape.
- Produces: `ScheduleCandidate { franchiseId; tutorId; workDate; timezone }`.
- Produces: `scheduleCandidateKey(candidate): string`.
- Produces: `fetchLatestScheduleSnapshots(candidates, issuedAt?): Promise<Map<string, ScheduleSnapshotV1>>`.
- Preserves: `/calendar/me/month` and `/calendar/me/day/:workDate/snapshot` response shapes.

- [ ] **Step 1: Run the required impact and route checks**

Use GitNexus:

```text
gitnexus_impact({ repo: "TCTimecard", target_uid: "Function:server/routes/hours.ts:fetchCalendarEntries", target: "fetchCalendarEntries", direction: "upstream", includeTests: true })
gitnexus_api_impact({ repo: "TCTimecard", file: "server/routes/hours.ts" })
```

Expected: LOW impact with `hours.ts`, `server/index.ts`, and `hoursRoutes.test.ts` as the known blast radius. Do not alter any HTTP payload keys.

- [ ] **Step 2: Write failing schedule-source tests**

Create `server/tests/scheduleSource.test.ts` with these imports and cleanup, then use a complete fake `mssql` request object (`input()` returns itself and `query()` returns rows):

```ts
import assert from 'node:assert/strict';
import test, { afterEach } from 'node:test';
import { setMssqlPoolOverride } from '../db/mssql';
import {
  fetchLatestScheduleSnapshots,
  scheduleCandidateKey
} from '../services/scheduleSource';

afterEach(() => setMssqlPoolOverride(undefined));
```

Cover 80-candidate batching with this complete test:

```ts
test('80 active tutors are fetched in one batched MSSQL request', async () => {
  const queries: string[] = [];
  setMssqlPoolOverride({
    request: () => ({
      input() { return this; },
      async query(sql: string) {
        queries.push(sql);
        return { recordset: Array.from({ length: 80 }, (_, index) => ({
          FranchiseID: 77, TutorID: index + 1,
          WorkDate: new Date('2026-07-31T00:00:00Z'),
          TimeID: 1, TimeLabel: '3:00 PM - 4:00 PM'
        })) };
      }
    })
  } as never);

  const candidates = Array.from({ length: 80 }, (_, index) => ({
    franchiseId: 77, tutorId: index + 1, workDate: '2026-07-31',
    timezone: 'America/Los_Angeles'
  }));
  const snapshots = await fetchLatestScheduleSnapshots(
    candidates,
    new Date('2026-07-31T19:00:00Z')
  );

  assert.equal(queries.length, 1);
  assert.equal(snapshots.size, 80);
  assert.equal(
    snapshots.get(scheduleCandidateKey(candidates[0]))?.intervals[0]?.endAt,
    '2026-07-31T16:00:00.000-07:00'
  );
});

test('split blocks remain separate and expose the final end', async () => {
  setMssqlPoolOverride({
    request: () => ({
      input() { return this; },
      async query() {
        return { recordset: [
          { FranchiseID: 77, TutorID: 5, WorkDate: new Date('2026-07-31T00:00:00Z'),
            TimeID: 1, TimeLabel: '3:00 PM - 5:00 PM' },
          { FranchiseID: 77, TutorID: 5, WorkDate: new Date('2026-07-31T00:00:00Z'),
            TimeID: 2, TimeLabel: '6:00 PM - 8:00 PM' }
        ] };
      }
    })
  } as never);
  const candidate = {
    franchiseId: 77, tutorId: 5, workDate: '2026-07-31',
    timezone: 'America/Los_Angeles'
  };
  const snapshots = await fetchLatestScheduleSnapshots(
    [candidate],
    new Date('2026-07-31T19:00:00Z')
  );
  const snapshot = snapshots.get(scheduleCandidateKey(candidate));
  assert.ok(snapshot);
  assert.deepEqual(snapshot.intervals.map((entry) => entry.endAt), [
    '2026-07-31T17:00:00.000-07:00',
    '2026-07-31T20:00:00.000-07:00'
  ]);
});
```

- [ ] **Step 3: Run and verify red**

Run:

```powershell
node --test --import tsx server/tests/scheduleSource.test.ts
```

Expected: FAIL because `scheduleSource` does not exist.

- [ ] **Step 4: Implement the shared source and one-query batch**

Move the existing `CALENDAR_MONTH_SQL`, date normalization, and `fetchCalendarEntries` behavior into `scheduleSource.ts`. Add the batch types and key:

```ts
export interface ScheduleCandidate {
  franchiseId: number;
  tutorId: number;
  workDate: string;
  timezone: string;
}

export const scheduleCandidateKey = (candidate: ScheduleCandidate): string =>
  `${candidate.franchiseId}:${candidate.tutorId}:${candidate.workDate}`;
```

Build one parameterized CTE for the deduplicated candidate list:

```sql
WITH ActiveTutors AS (
  SELECT * FROM (VALUES
    (@p_franchise_0, @p_tutor_0, CAST(@p_date_0 AS DATE))
  ) AS requested(FranchiseID, TutorID, WorkDate)
)
SELECT
  requested.FranchiseID,
  requested.TutorID,
  requested.WorkDate,
  schedule.TimeID,
  times.Time AS TimeLabel
FROM ActiveTutors requested
JOIN dbo.tblSessionSchedule schedule
  ON schedule.FranchiseID = requested.FranchiseID
 AND schedule.TutorID = requested.TutorID
 AND schedule.ScheduleDate = requested.WorkDate
JOIN dbo.tblTimes times ON schedule.TimeID = times.ID
GROUP BY requested.FranchiseID, requested.TutorID, requested.WorkDate,
         schedule.TimeID, times.Time
ORDER BY requested.FranchiseID, requested.TutorID, schedule.TimeID;
```

Generate one `VALUES` tuple and three `request.input()` parameters per unique candidate. Group results by `scheduleCandidateKey`, normalize labels, derive intervals with `deriveIntervalsFromEntries`, set the injected `issuedAt`, and sign with `signScheduleSnapshot` when the existing signing secret is available. Return a snapshot with empty `entries`/`intervals` for a candidate with no rows so the worker can classify it as missing schedule without another query.

Replace the private function in `hours.ts` with:

```ts
import { fetchCalendarEntries } from '../services/scheduleSource';
```

Keep all existing route calls and payload construction unchanged.

- [ ] **Step 5: Verify the extracted behavior and route regressions**

Run:

```powershell
node --test --import tsx server/tests/scheduleSource.test.ts
node --test --import tsx server/tests/hoursRoutes.test.ts
npm run build:server
```

Expected: schedule tests PASS, all hours routes PASS without response changes, and the server builds.

- [ ] **Step 6: Review impact and commit the schedule boundary**

Stage Task 4 files and run `gitnexus_detect_changes({ repo: "TCTimecard", scope: "staged" })`. Review the calendar/hour processes reported for the moved function and confirm no response-shape mismatch.

```powershell
git add server/services/scheduleSource.ts server/tests/scheduleSource.test.ts server/routes/hours.ts server/tests/hoursRoutes.test.ts
git commit -m "refactor: share batched tutor schedule source"
```

---

### Task 5: Share Transactional Clock-Out Finalization

**Files:**
- Create: `server/services/clockOutFinalization.ts`
- Create: `server/tests/clockOutFinalization.test.ts`
- Modify: `server/services/clockSubmission.ts:20-50`
- Modify: `server/tests/clockSubmission.test.ts`
- Modify: `server/routes/clock.ts:1-22,850-1257`
- Modify: `server/tests/clockRoutes.test.ts`

**Interfaces:**
- Produces: `ClockOutSource = 'clock_out' | 'auto_clock_out'`.
- Produces: `finalizeClockOutInTransaction(params): Promise<ClockOutFinalizationResult>`.
- Produces: `createPostgresClockOutTransaction(client: PoolClient): ClockOutTransaction`.
- Consumes: a caller-owned `PoolClient` transaction with locked day/session rows.
- Preserves: manual active breaks return `409`; manual clock-out still requires a valid matching signed snapshot only when an open session is being closed.
- Enables: automatic mode closes a valid active break at the scheduled target.

- [ ] **Step 1: Run the required impact and endpoint checks**

Use GitNexus:

```text
gitnexus_impact({ repo: "TCTimecard", target_uid: "Function:server/services/clockSubmission.ts:resolveClockOutSubmission", target: "resolveClockOutSubmission", direction: "upstream", includeTests: true })
gitnexus_api_impact({ repo: "TCTimecard", route: "/clock/me/out" })
```

Expected: LOW risk. Preserve `{ state }` and current manual errors.

- [ ] **Step 2: Extend submission-policy tests for an explicit source**

Add to `server/tests/clockSubmission.test.ts`:

```ts
test('automatic worker submission records auto-clock-out source', () => {
  const computed = computeTimeEntryComparisonV2({
    sessions: [{ startAt: '2026-01-02T09:00:00-06:00', endAt: '2026-01-02T10:00:00-06:00' }],
    snapshotIntervals: baseSnapshot.intervals
  });
  assert.equal(computed.ok, true);
  if (!computed.ok) return;

  const decision = resolveClockOutSubmission({
    snapshot: baseSnapshot,
    comparison: computed.comparison,
    workDate: baseSnapshot.workDate,
    timezone: baseSnapshot.timezone,
    source: 'auto_clock_out',
    detectedAt: '2026-01-02T10:01:00-06:00'
  });
  assert.equal(decision.audit.metadata.source, 'auto_clock_out');
  assert.equal(decision.audit.metadata.detectedAt, '2026-01-02T10:01:00-06:00');
});
```

- [ ] **Step 3: Write failing transaction-core tests**

Create `clockOutFinalization.test.ts` against the real coordinator and an in-memory implementation of its transaction interface. This keeps assertions on finalized state while `clockRoutes.test.ts` continues exercising the PostgreSQL adapter SQL.

Use these complete fixtures and fake transaction:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  finalizeClockOutInTransaction,
  type ClockOutTransaction,
  type TimeEntryDayRow
} from '../services/clockOutFinalization';
import type { ScheduleSnapshotV1 } from '../services/scheduleSnapshot';
import type { TimeEntryBreakRow } from '../services/timeEntryBreaks';

const detectedAt = '2026-08-01T03:01:00.000Z';
const target = '2026-07-31T20:00:00.000-07:00';
const snapshot: ScheduleSnapshotV1 = {
  version: 1, franchiseId: 77, tutorId: 20, workDate: '2026-07-31',
  timezone: 'America/Los_Angeles', slotMinutes: 60,
  entries: [{ timeId: 1, timeLabel: '3:00 PM - 8:00 PM' }],
  intervals: [{ startAt: '2026-07-31T15:00:00.000-07:00', endAt: target }],
  issuedAt: '2026-08-01T02:50:00.000Z'
};

const day: TimeEntryDayRow = {
  id: 100, franchiseid: 77, tutorid: 20, work_date: '2026-07-31',
  timezone: 'America/Los_Angeles', status: 'draft', clock_state: 1,
  schedule_snapshot: null, comparison: null, submitted_at: null,
  decided_by: null, decided_at: null, decision_reason: null,
  created_at: '2026-07-31T22:00:00.000Z', updated_at: '2026-07-31T22:00:00.000Z'
};

const activeBreak: TimeEntryBreakRow = {
  id: 9, entry_day_id: 100, time_entry_session_id: 5,
  franchiseid: 77, tutorid: 20, break_type: 'lunch',
  pay_treatment: 'unpaid', start_time: '2026-07-31T19:45:00.000-07:00',
  end_time: null, duration_minutes: 0, source: 'employee', status: 'active',
  note: null, created_at: detectedAt, updated_at: detectedAt
};

const makeHarness = (options: { sessionStart?: string; loseCloseRace?: boolean } = {}) => {
  const state = {
    sessionStart: options.sessionStart ?? '2026-07-31T15:00:00.000-07:00',
    sessionEndAt: null as string | null,
    breakEndAt: null as string | null,
    dayStatus: 'draft' as TimeEntryDayRow['status'],
    clockState: 1,
    auditMetadata: [] as Array<Record<string, unknown>>
  };
  const transaction: ClockOutTransaction = {
    resolveTargetEndAt: async (explicit) => explicit ?? detectedAt,
    closeActiveBreak: async (row, endAt) => {
      state.breakEndAt = endAt;
      return { ...row, end_time: endAt, duration_minutes: 15, status: 'completed' };
    },
    closeSession: async (sessionId, endAt) => {
      if (options.loseCloseRace) return null;
      state.sessionEndAt = endAt;
      return { id: sessionId, startAt: state.sessionStart, endAt };
    },
    invalidateDay: async (row) => ({ ...row, status: 'pending' }),
    setClockStateOut: async (row) => {
      state.clockState = 0;
      return { ...row, clock_state: 0 };
    },
    appendAudit: async (entry) => { state.auditMetadata.push(entry.metadata ?? {}); },
    listClosedSessions: async () => state.sessionEndAt ? [{
      startAt: state.sessionStart, endAt: state.sessionEndAt
    }] : [],
    listBreaks: async () => state.breakEndAt ? [{
      ...activeBreak, end_time: state.breakEndAt,
      duration_minutes: 15, status: 'completed'
    }] : [],
    saveSubmission: async (row, decision) => {
      state.dayStatus = decision.nextStatus;
      return { ...row, status: decision.nextStatus, clock_state: 0,
        schedule_snapshot: snapshot, comparison: decision.comparison };
    }
  };
  return { state, transaction };
};
```

Add these complete behavior tests:

```ts
test('automatic finalization stores the exact scheduled target and closes an active break', async () => {
  const harness = makeHarness();
  const result = await finalizeClockOutInTransaction({
    transaction: harness.transaction, day,
    openSession: { id: 5, start_at: harness.state.sessionStart },
    activeBreak, targetEndAt: target, detectedAt, snapshot,
    source: 'auto_clock_out',
    actor: { accountType: 'SYSTEM', accountId: null },
    activeBreakPolicy: 'close'
  });
  assert.equal(result.kind, 'finalized');
  assert.equal(harness.state.sessionEndAt, target);
  assert.equal(harness.state.breakEndAt, target);
  assert.equal(harness.state.dayStatus, 'approved');
  assert.equal(harness.state.clockState, 0);
  assert.equal(harness.state.auditMetadata.some((value) => value.source === 'auto_clock_out'), true);
});

test('manual finalization rejects an active break without mutation', async () => {
  const harness = makeHarness();
  const result = await finalizeClockOutInTransaction({
    transaction: harness.transaction, day,
    openSession: { id: 5, start_at: harness.state.sessionStart },
    activeBreak, snapshot, source: 'clock_out', detectedAt,
    actor: { accountType: 'TUTOR', accountId: 20 }, activeBreakPolicy: 'reject'
  });
  assert.deepEqual(result, { kind: 'active_break' });
  assert.equal(harness.state.sessionEndAt, null);
});

test('target at or before session start is skipped without mutation', async () => {
  const harness = makeHarness({ sessionStart: '2026-07-31T20:01:00.000-07:00' });
  const result = await finalizeClockOutInTransaction({
    transaction: harness.transaction, day,
    openSession: { id: 5, start_at: harness.state.sessionStart },
    activeBreak: null, targetEndAt: target, detectedAt, snapshot,
    source: 'auto_clock_out', actor: { accountType: 'SYSTEM', accountId: null },
    activeBreakPolicy: 'close'
  });
  assert.deepEqual(result, { kind: 'invalid_end' });
  assert.equal(harness.state.sessionEndAt, null);
});

test('conditional session close losing a race returns already_closed', async () => {
  const harness = makeHarness({ loseCloseRace: true });
  const result = await finalizeClockOutInTransaction({
    transaction: harness.transaction, day,
    openSession: { id: 5, start_at: harness.state.sessionStart },
    activeBreak: null, targetEndAt: target, detectedAt, snapshot,
    source: 'auto_clock_out', actor: { accountType: 'SYSTEM', accountId: null },
    activeBreakPolicy: 'close'
  });
  assert.deepEqual(result, { kind: 'already_closed' });
});
```

Add these two literal cases using the same harness:

```ts
test('time before the scheduled block sends automatic completion to pending', async () => {
  const harness = makeHarness({ sessionStart: '2026-07-31T14:45:00.000-07:00' });
  const result = await finalizeClockOutInTransaction({
    transaction: harness.transaction, day,
    openSession: { id: 5, start_at: harness.state.sessionStart },
    activeBreak: null, targetEndAt: target, detectedAt, snapshot,
    source: 'auto_clock_out', actor: { accountType: 'SYSTEM', accountId: null },
    activeBreakPolicy: 'close'
  });
  assert.equal(result.kind, 'finalized');
  assert.equal(harness.state.dayStatus, 'pending');
});

test('active break at the target is invalid and leaves the session open', async () => {
  const harness = makeHarness();
  const result = await finalizeClockOutInTransaction({
    transaction: harness.transaction, day,
    openSession: { id: 5, start_at: harness.state.sessionStart },
    activeBreak: { ...activeBreak, start_time: target },
    targetEndAt: target, detectedAt, snapshot,
    source: 'auto_clock_out', actor: { accountType: 'SYSTEM', accountId: null },
    activeBreakPolicy: 'close'
  });
  assert.deepEqual(result, { kind: 'invalid_break' });
  assert.equal(harness.state.sessionEndAt, null);
  assert.equal(harness.state.breakEndAt, null);
});
```

- [ ] **Step 4: Run focused tests and verify red**

Run:

```powershell
node --test --import tsx server/tests/clockSubmission.test.ts server/tests/clockOutFinalization.test.ts
```

Expected: FAIL because the policy arguments and finalization service do not exist.

- [ ] **Step 5: Extend the submission source without changing defaults**

Change `resolveClockOutSubmission` input to include optional fields:

```ts
source?: ClockOutSource;
detectedAt?: string;
```

Set metadata with backward-compatible defaults:

```ts
source: params.source ?? 'clock_out',
...(params.detectedAt ? { detectedAt: params.detectedAt } : {})
```

Existing calls with no new arguments must continue producing `source: 'clock_out'`.

- [ ] **Step 6: Implement the transaction-local finalizer**

Create `clockOutFinalization.ts` with explicit input/result unions and a PostgreSQL adapter interface:

```ts
export type ClockOutSource = 'clock_out' | 'auto_clock_out';
export type ActiveBreakPolicy = 'reject' | 'close';

export type ClockOutFinalizationResult =
  | { kind: 'finalized'; day: TimeEntryDayRow; breaks: TimeEntryBreakRow[] }
  | { kind: 'active_break' | 'invalid_break' | 'invalid_end' | 'already_closed' };

export type ClockOutAuditEntry = {
  dayId: number;
  action: 'clock_out' | 'invalidated' | 'submitted' | 'auto_approved';
  actorAccountType: 'TUTOR' | 'SYSTEM';
  actorAccountId: number | null;
  previousStatus: TimeEntryStatus | null;
  newStatus: TimeEntryStatus;
  metadata?: Record<string, unknown>;
};

export type ClockOutSubmissionWrite = {
  nextStatus: 'pending' | 'approved';
  decidedAt: string | null;
  decisionReason: string | null;
  snapshot: ScheduleSnapshotV1;
  comparison: TimeEntryComparisonV2;
};

export interface ClockOutTransaction {
  resolveTargetEndAt(explicit?: string): Promise<string>;
  closeActiveBreak(row: TimeEntryBreakRow, endAt: string): Promise<TimeEntryBreakRow>;
  closeSession(id: number, endAt: string): Promise<{ id: number; startAt: string; endAt: string } | null>;
  invalidateDay(day: TimeEntryDayRow): Promise<TimeEntryDayRow>;
  setClockStateOut(day: TimeEntryDayRow): Promise<TimeEntryDayRow>;
  appendAudit(entry: ClockOutAuditEntry): Promise<void>;
  listClosedSessions(dayId: number): Promise<Array<{ startAt: string; endAt: string }>>;
  listBreaks(dayId: number): Promise<TimeEntryBreakRow[]>;
  saveSubmission(
    day: TimeEntryDayRow,
    input: ClockOutSubmissionWrite
  ): Promise<TimeEntryDayRow>;
}

export type FinalizeClockOutInTransaction = (params: {
  transaction: ClockOutTransaction;
  day: TimeEntryDayRow;
  openSession: { id: number; start_at: string };
  activeBreak: TimeEntryBreakRow | null;
  targetEndAt?: string;
  detectedAt: string;
  snapshot: ScheduleSnapshotV1;
  source: ClockOutSource;
  actor: { accountType: 'TUTOR' | 'SYSTEM'; accountId: number | null };
  activeBreakPolicy: ActiveBreakPolicy;
}) => Promise<ClockOutFinalizationResult>;

export type CreatePostgresClockOutTransaction = (
  client: PoolClient
) => ClockOutTransaction;
```

The implementation performs these concrete writes in order:

Implement and export `createPostgresClockOutTransaction` with concrete parameterized operations. No method opens or commits a transaction. Use `RETURNING *` for day rows because `TimeEntryDayRow` matches the persisted column names.

```ts
export const createPostgresClockOutTransaction: CreatePostgresClockOutTransaction = (client) => ({
  async resolveTargetEndAt(explicit) {
    if (explicit) return explicit;
    const result = await client.query<{ end_at: string }>(
      `SELECT DATE_TRUNC('minute', NOW()) AS end_at`
    );
    return new Date(result.rows[0].end_at).toISOString();
  },
  async closeActiveBreak(row, endAt) {
    const result = await client.query<TimeEntryBreakRow>(
      `UPDATE public.time_entry_breaks
          SET end_time = $1,
              duration_minutes = FLOOR(EXTRACT(EPOCH FROM ($1::timestamptz - start_time)) / 60)::integer,
              status = 'completed',
              updated_at = NOW()
        WHERE id = $2 AND status = 'active'
        RETURNING *`,
      [endAt, row.id]
    );
    if (!result.rowCount) throw new Error('Active break changed during clock-out');
    return result.rows[0];
  },
  async closeSession(id, endAt) {
    const result = await client.query<{ id: number; start_at: string; end_at: string }>(
      `UPDATE public.time_entry_sessions
          SET end_at = $1, updated_at = NOW()
        WHERE id = $2 AND end_at IS NULL
        RETURNING id, start_at, end_at`,
      [endAt, id]
    );
    return result.rowCount ? {
      id: result.rows[0].id,
      startAt: new Date(result.rows[0].start_at).toISOString(),
      endAt: new Date(result.rows[0].end_at).toISOString()
    } : null;
  },
  async invalidateDay(day) {
    const result = await client.query<TimeEntryDayRow>(
      `UPDATE public.time_entry_days
          SET status = 'pending', decided_by = NULL, decided_at = NULL,
              decision_reason = NULL, submitted_at = NOW(), updated_at = NOW()
        WHERE id = $1 RETURNING *`,
      [day.id]
    );
    return result.rows[0];
  },
  async setClockStateOut(day) {
    const result = await client.query<TimeEntryDayRow>(
      `UPDATE public.time_entry_days
          SET clock_state = 0, timezone = $1, updated_at = NOW()
        WHERE id = $2 RETURNING *`,
      [day.timezone, day.id]
    );
    return result.rows[0];
  },
  async appendAudit(entry) {
    await client.query(
      `INSERT INTO public.time_entry_audit
        (entry_day_id, action, actor_account_type, actor_account_id,
         at, previous_status, new_status, metadata)
       VALUES ($1, $2, $3, $4, NOW(), $5, $6, $7)`,
      [entry.dayId, entry.action, entry.actorAccountType, entry.actorAccountId,
       entry.previousStatus, entry.newStatus, entry.metadata ?? {}]
    );
  },
  async listClosedSessions(dayId) {
    const result = await client.query<{ start_at: string; end_at: string }>(
      `SELECT start_at, end_at FROM public.time_entry_sessions
        WHERE entry_day_id = $1 AND end_at IS NOT NULL
        ORDER BY sort_order ASC, start_at ASC`,
      [dayId]
    );
    return result.rows.map((row) => ({
      startAt: new Date(row.start_at).toISOString(),
      endAt: new Date(row.end_at).toISOString()
    }));
  },
  async listBreaks(dayId) {
    return (await fetchBreaksByDayIds(client, [dayId])).get(dayId) ?? [];
  },
  async saveSubmission(day, input) {
    const result = await client.query<TimeEntryDayRow>(
      `UPDATE public.time_entry_days
          SET status = $1, timezone = $2, schedule_snapshot = $3,
              comparison = $4, submitted_at = NOW(), decided_by = NULL,
              decided_at = $5, decision_reason = $6, clock_state = 0,
              updated_at = NOW()
        WHERE id = $7 RETURNING *`,
      [input.nextStatus, day.timezone, input.snapshot, input.comparison,
       input.decidedAt, input.decisionReason, day.id]
    );
    return result.rows[0];
  }
});
```

The coordinator begins with `let currentDay = { ...params.day, timezone: params.snapshot.timezone }` so latest schedule timezone is persisted consistently, then performs these operations in order:

1. Resolve the target with `targetEndAt` or `SELECT DATE_TRUNC('minute', NOW()) AS end_at`.
2. Compare epoch milliseconds and return `invalid_end` unless target is strictly after `openSession.start_at`.
3. If an active break exists, reject for manual mode; for automatic mode require `start_time < target`, then update `end_time`, integer `duration_minutes`, `status = 'completed'`, and `updated_at` using the same target parameter.
4. Close the session with `UPDATE ... SET end_at = $1 ... WHERE id = $2 AND end_at IS NULL RETURNING ...`; return `already_closed` on zero rows.
5. Apply existing approved/denied invalidation semantics.
6. Set `clock_state = 0`, append `clock_out` audit metadata with `source`, `detectedAt`, and exact `endedAt`.
7. Read all closed sessions and all breaks, run `computeTimeEntryComparisonV2`, resolve status with `resolveClockOutSubmission({ source, detectedAt })`, persist snapshot/comparison/submission fields, and append its system audit.
8. Return the finalized day and current break rows. Throw on an invalid stored session comparison so the caller rolls back.

- [ ] **Step 7: Refactor manual `/clock/me/out` to delegate only after validation**

Keep attestation checks, day/session locks, active-break lookup, stored/request snapshot validation, response mapping, and the caller-owned `BEGIN`/`COMMIT`/`ROLLBACK` in `clock.ts`.

When there is an open session:

```ts
const result = await finalizeClockOutInTransaction({
  transaction: createPostgresClockOutTransaction(client),
  day,
  openSession,
  activeBreak,
  detectedAt: new Date().toISOString(),
  snapshot,
  source: 'clock_out',
  actor: { accountType: 'TUTOR', accountId: context.tutorId },
  activeBreakPolicy: 'reject'
});
```

Map `active_break` to the existing `409` message. Map `already_closed` idempotently to an out state. Manual mode omits `targetEndAt`, so PostgreSQL remains the source of the current minute. Do not require a request snapshot when no open session exists.

- [ ] **Step 8: Verify manual regressions and shared behavior**

Run:

```powershell
node --test --import tsx server/tests/clockSubmission.test.ts server/tests/clockOutFinalization.test.ts server/tests/clockRoutes.test.ts
npm run build:server
```

Expected: all new tests PASS; existing manual clock in/out, break, snapshot, attestation, approval, and response tests remain PASS.

- [ ] **Step 9: Review impact and commit the shared finalizer**

Stage Task 5 files and run `gitnexus_detect_changes({ repo: "TCTimecard", scope: "staged" })`. Review the clock endpoint and submission processes and confirm no route shape change.

```powershell
git add server/services/clockOutFinalization.ts server/tests/clockOutFinalization.test.ts server/services/clockSubmission.ts server/tests/clockSubmission.test.ts server/routes/clock.ts server/tests/clockRoutes.test.ts
git commit -m "refactor: share transactional clock-out finalization"
```

---

### Task 6: Implement the Windowed Automatic Clock-Out Worker

**Files:**
- Create: `server/services/autoClockOutScheduler.ts`
- Create: `server/tests/autoClockOutScheduler.test.ts`

**Interfaces:**
- Consumes: `fetchLatestScheduleSnapshots`, `scheduleCandidateKey`, and `finalizeClockOutInTransaction`.
- Produces: `isAutoClockOutMinute(date: Date): boolean`.
- Produces: `nextAutoClockOutTick(after: Date): Date`.
- Produces: `getFinalScheduleEnd(snapshot): string | null`.
- Produces: `runAutoClockOutPass(dependencies): Promise<AutoClockOutRunSummary>`.
- Produces: `startAutoClockOutScheduler(options?): { stop(): void }`.

- [ ] **Step 1: Write failing pure cadence and target tests**

Create `autoClockOutScheduler.test.ts` with literal expected times:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getFinalScheduleEnd,
  isAutoClockOutMinute,
  nextAutoClockOutTick,
  runAutoClockOutPass,
  startAutoClockOutScheduler
} from '../services/autoClockOutScheduler';
import { scheduleCandidateKey, type ScheduleCandidate } from '../services/scheduleSource';
import type { ScheduleSnapshotV1 } from '../services/scheduleSnapshot';

test('eligible minutes are only 00-09 and 50-59', () => {
  for (let minute = 0; minute < 60; minute += 1) {
    const actual = isAutoClockOutMinute(new Date(Date.UTC(2026, 6, 31, 12, minute)));
    assert.equal(actual, minute <= 9 || minute >= 50, `minute ${minute}`);
  }
});

test('next tick skips the middle of the hour', () => {
  assert.equal(
    nextAutoClockOutTick(new Date('2026-07-31T12:09:30.000Z')).toISOString(),
    '2026-07-31T12:50:00.000Z'
  );
  assert.equal(
    nextAutoClockOutTick(new Date('2026-07-31T12:59:30.000Z')).toISOString(),
    '2026-07-31T13:00:00.000Z'
  );
});

test('final schedule end selects the last split block', () => {
  const split: ScheduleSnapshotV1 = {
    version: 1, franchiseId: 77, tutorId: 5, workDate: '2026-07-31',
    timezone: 'America/Los_Angeles', slotMinutes: 60, entries: [],
    intervals: [
      { startAt: '2026-07-31T15:00:00.000-07:00', endAt: '2026-07-31T17:00:00.000-07:00' },
      { startAt: '2026-07-31T18:00:00.000-07:00', endAt: '2026-07-31T20:00:00.000-07:00' }
    ]
  };
  assert.equal(getFinalScheduleEnd(split),
    '2026-07-31T20:00:00.000-07:00');
  assert.equal(getFinalScheduleEnd({ ...split, intervals: [] }), null);
});
```

- [ ] **Step 2: Write failing orchestration, safety, and scale tests**

Inject dependencies rather than mocking production classes. Tests exercise the real worker orchestration and pure helpers with fake external boundaries. Define these file-local builders before the orchestration tests:

```ts
const makeCandidates = (count: number): Array<ScheduleCandidate & {
  dayId: number; openSessionId: number; startedAt: string;
}> => Array.from({ length: count }, (_, index) => ({
  dayId: index + 1000, franchiseId: 77, tutorId: index + 1,
  workDate: '2026-07-31', timezone: 'America/Los_Angeles',
  openSessionId: index + 2000, startedAt: '2026-07-31T15:00:00.000-07:00'
}));

const snapshotsEndingAtEightPm = (
  candidates: ScheduleCandidate[]
): Map<string, ScheduleSnapshotV1> => new Map(candidates.map((candidate) => [
  scheduleCandidateKey(candidate),
  {
    version: 1, franchiseId: candidate.franchiseId, tutorId: candidate.tutorId,
    workDate: candidate.workDate, timezone: candidate.timezone, slotMinutes: 60,
    entries: [], intervals: [{
      startAt: `${candidate.workDate}T15:00:00.000-07:00`,
      endAt: `${candidate.workDate}T20:00:00.000-07:00`
    }]
  }
]));

const createLock = () => ({
  client: {} as never,
  release: async () => undefined
});
```

Add these complete orchestration tests:

```ts
test('no candidates avoids the MSSQL schedule call', async () => {
  let scheduleCalls = 0;
  const summary = await runAutoClockOutPass({
    now: new Date('2026-07-31T19:50:00.000Z'),
    acquireLockAndCandidates: async () => ({ lock: createLock(), candidates: [] }),
    fetchSchedules: async () => { scheduleCalls += 1; return new Map(); },
    acquireWorkerClient: async () => ({ client: {} as never, release: () => undefined }),
    finalize: async () => ({ kind: 'finalized' })
  });
  assert.equal(scheduleCalls, 0);
  assert.equal(summary.candidates, 0);
});

test('80 due tutors use one schedule batch and at most four PostgreSQL clients total', async () => {
  let scheduleCalls = 0;
  let activeClients = 1; // advisory-lock client
  let peakClients = 1;
  const candidates = makeCandidates(80);
  const summary = await runAutoClockOutPass({
    now: new Date('2026-08-01T03:01:00.000Z'),
    acquireLockAndCandidates: async () => ({ lock: createLock(), candidates }),
    fetchSchedules: async (requested) => {
      scheduleCalls += 1;
      assert.equal(requested.length, 80);
      return snapshotsEndingAtEightPm(requested);
    },
    acquireWorkerClient: async () => {
      activeClients += 1;
      peakClients = Math.max(peakClients, activeClients);
      return { client: {} as never, release: () => { activeClients -= 1; } };
    },
    finalize: async () => ({ kind: 'finalized' })
  });
  assert.equal(scheduleCalls, 1);
  assert.ok(peakClients <= 4);
  assert.equal(summary.succeeded, 80);
});

test('missing schedule and invalid target leave tutors unmodified', async () => {
  const candidates = makeCandidates(2);
  const invalid = snapshotsEndingAtEightPm([candidates[1]]);
  const invalidSnapshot = invalid.get(scheduleCandidateKey(candidates[1]));
  assert.ok(invalidSnapshot);
  invalidSnapshot.intervals = [{
    startAt: 'not-a-time', endAt: 'not-a-time'
  }];
  let finalizeCalls = 0;
  const summary = await runAutoClockOutPass({
    now: new Date('2026-08-01T03:01:00.000Z'),
    acquireLockAndCandidates: async () => ({ lock: createLock(), candidates }),
    fetchSchedules: async () => invalid,
    acquireWorkerClient: async () => ({ client: {} as never, release: () => undefined }),
    finalize: async () => { finalizeCalls += 1; return { kind: 'finalized' }; }
  });
  assert.equal(finalizeCalls, 0);
  assert.deepEqual(summary.skipped, {
    missingSchedule: 1,
    invalidSchedule: 1,
    settingDisabled: 0
  });
});

test('one tutor failure does not abort other due tutors', async () => {
  const candidates = makeCandidates(80);
  let call = 0;
  const summary = await runAutoClockOutPass({
    now: new Date('2026-08-01T03:01:00.000Z'),
    acquireLockAndCandidates: async () => ({ lock: createLock(), candidates }),
    fetchSchedules: async (requested) => snapshotsEndingAtEightPm(requested),
    acquireWorkerClient: async () => ({ client: {} as never, release: () => undefined }),
    finalize: async () => {
      call += 1;
      if (call === 1) throw new Error('controlled database failure');
      return { kind: 'finalized' };
    }
  });
  assert.equal(summary.succeeded, 79);
  assert.equal(summary.failed, 1);
});

test('failed advisory lock exits without candidate or schedule work', async () => {
  let scheduleCalls = 0;
  const summary = await runAutoClockOutPass({
    now: new Date('2026-07-31T19:50:00.000Z'),
    acquireLockAndCandidates: async () => null,
    fetchSchedules: async () => { scheduleCalls += 1; return new Map(); },
    acquireWorkerClient: async () => ({ client: {} as never, release: () => undefined }),
    finalize: async () => ({ kind: 'finalized' })
  });
  assert.equal(scheduleCalls, 0);
  assert.equal(summary.lockAcquired, false);
  assert.equal(summary.candidates, 0);
});
```

Add this fake-timer test proving `stop()` clears the pending timeout and no pass starts afterward:

```ts
test('scheduler stop cancels the pending tick before it can run', async () => {
  let queued: (() => void) | null = null;
  let cleared = false;
  let passes = 0;
  const scheduler = startAutoClockOutScheduler({
    now: () => new Date('2026-07-31T12:10:00.000Z'),
    setTimer: (callback) => { queued = callback; return 1 as never; },
    clearTimer: () => { cleared = true; },
    runPass: async () => { passes += 1; },
    log: { info: () => undefined, error: () => undefined }
  });
  scheduler.stop();
  queued?.();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cleared, true);
  assert.equal(passes, 0);
});
```

- [ ] **Step 3: Run and verify the expected red state**

Run:

```powershell
node --test --import tsx server/tests/autoClockOutScheduler.test.ts
```

Expected: FAIL because the scheduler module does not exist.

- [ ] **Step 4: Implement cadence and structured result types**

Use UTC minute values so scheduler cadence is independent of the VM's locale:

```ts
export const isAutoClockOutMinute = (date: Date): boolean => {
  const minute = date.getUTCMinutes();
  return minute <= 9 || minute >= 50;
};

export const nextAutoClockOutTick = (after: Date): Date => {
  const next = new Date(after);
  next.setUTCSeconds(0, 0);
  next.setUTCMinutes(next.getUTCMinutes() + 1);
  while (!isAutoClockOutMinute(next)) {
    next.setUTCMinutes(next.getUTCMinutes() + 1);
  }
  return next;
};

export const getFinalScheduleEnd = (snapshot: ScheduleSnapshotV1): string | null => {
  const valid = snapshot.intervals
    .map((interval) => ({ value: interval.endAt, epoch: Date.parse(interval.endAt) }))
    .filter((item) => Number.isFinite(item.epoch));
  valid.sort((left, right) => left.epoch - right.epoch);
  return valid.at(-1)?.value ?? null;
};
```

Define a summary with exact counters:

```ts
export interface AutoClockOutRunSummary {
  runId: string;
  candidates: number;
  due: number;
  succeeded: number;
  alreadyClosed: number;
  failed: number;
  skipped: {
    missingSchedule: number;
    invalidSchedule: number;
    settingDisabled: number;
  };
  durationMs: number;
  lockAcquired: boolean;
}
```

Define the injected pass boundary exactly so tests and production defaults use the same orchestration:

```ts
export interface AutoClockOutCandidate extends ScheduleCandidate {
  dayId: number;
  openSessionId: number;
  startedAt: string;
}

export interface AutoClockOutFinalizationInput {
  client: PoolClient;
  candidate: AutoClockOutCandidate;
  snapshot: ScheduleSnapshotV1;
  targetEndAt: string;
  detectedAt: string;
}

export interface AutoClockOutPassDependencies {
  now: Date;
  acquireLockAndCandidates(): Promise<{
    lock: { client: PoolClient; release(): Promise<void> };
    candidates: AutoClockOutCandidate[];
  } | null>;
  fetchSchedules(candidates: ScheduleCandidate[]): Promise<Map<string, ScheduleSnapshotV1>>;
  acquireWorkerClient(): Promise<{ client: PoolClient; release(): void }>;
  finalize(input: AutoClockOutFinalizationInput): Promise<
    ClockOutFinalizationResult | { kind: 'setting_disabled' }
  >;
}

export const runAutoClockOutPass = (
  dependencies: AutoClockOutPassDependencies
): Promise<AutoClockOutRunSummary>;
```

- [ ] **Step 5: Implement advisory locking and candidate selection**

Use one acquired `PoolClient` for the session advisory lock and candidate read:

```sql
SELECT pg_try_advisory_lock(739280451) AS acquired;

SELECT
  day.id AS day_id,
  day.franchiseid,
  day.tutorid,
  day.work_date,
  settings.timezone,
  session.id AS open_session_id,
  session.start_at
FROM public.time_entry_days day
JOIN public.time_entry_sessions session
  ON session.entry_day_id = day.id AND session.end_at IS NULL
JOIN public.franchise_payroll_settings settings
  ON settings.franchiseid = day.franchiseid
 AND settings.auto_clock_out_enabled = TRUE
WHERE day.clock_state = 1
  AND day.work_date = (NOW() AT TIME ZONE settings.timezone)::date
ORDER BY day.franchiseid, day.tutorid;
```

Always release with `SELECT pg_advisory_unlock(739280451)` and release the client in a `finally` block. If the lock is false or candidate count is zero, return immediately.

- [ ] **Step 6: Implement latest-schedule due filtering and four-client processing**

Call `fetchLatestScheduleSnapshots(candidates)` once. A candidate is due when `Date.parse(finalEnd) <= now.getTime()` and `Date.parse(finalEnd) > Date.parse(candidate.startAt)`.

Use the advisory-lock client as worker lane 1 and acquire at most three additional PostgreSQL clients for lanes 2-4. Each lane processes its assigned candidates sequentially. For every candidate:

1. `BEGIN`.
2. Lock the day and open session with `FOR UPDATE`.
3. Re-read `auto_clock_out_enabled`; roll back and return `setting_disabled` if false or absent.
4. Lock the active break.
5. Call `finalizeClockOutInTransaction` with `targetEndAt = finalEnd`, `source = 'auto_clock_out'`, `activeBreakPolicy = 'close'`, and SYSTEM actor.
6. `COMMIT` for `finalized`/idempotent outcomes; `ROLLBACK` for invalid data or errors.
7. Log a safe per-tutor error category and continue after failures.

Release the three additional clients after all lanes settle; keep the lock client until the advisory unlock in `finally`.

- [ ] **Step 7: Implement timer lifecycle and structured summaries**

`startAutoClockOutScheduler` uses this exact injection boundary:

```ts
export interface AutoClockOutSchedulerOptions {
  now?: () => Date;
  setTimer?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  runPass?: () => Promise<AutoClockOutRunSummary | void>;
  log?: Pick<Console, 'info' | 'error'>;
}

export const startAutoClockOutScheduler = (
  options: AutoClockOutSchedulerOptions = {}
): { stop(): void };
```

Default `runPass` constructs the production `AutoClockOutPassDependencies` and invokes `runAutoClockOutPass`. Schedule the first `nextAutoClockOutTick(now())`; after a pass settles, schedule from a fresh `now()`. `stop()` sets a stopped flag and clears the current timer. Log one summary object per pass and avoid tutor names, credentials, connection strings, and raw database errors.

- [ ] **Step 8: Verify worker behavior, scale, and server build**

Run:

```powershell
node --test --import tsx server/tests/autoClockOutScheduler.test.ts
npm run build:server
```

Expected: all cadence/safety/80-tutor tests PASS, observed PostgreSQL clients never exceed four, and TypeScript builds.

- [ ] **Step 9: Review impact and commit the worker**

Stage the two Task 6 files, run `gitnexus_detect_changes({ repo: "TCTimecard", scope: "staged" })`, and confirm the worker is isolated until lifecycle wiring in Task 7.

```powershell
git add server/services/autoClockOutScheduler.ts server/tests/autoClockOutScheduler.test.ts
git commit -m "feat: add windowed auto clock-out worker"
```

---

### Task 7: Wire VM Lifecycle and Efficient Tutor Refresh

**Files:**
- Create: `client/src/lib/autoClockOut.ts`
- Create: `client/tests/autoClockOut.test.ts`
- Modify: `server/index.ts:20-24,129-139`
- Modify: `client/src/components/tutor/ClockWidget.tsx:1-190`
- Create: `client/src/components/tutor/ClockWidget.test.tsx`
- Modify: `README.md`
- Modify: `docs/operations/replit-200-user-runbook.md`

**Interfaces:**
- Consumes: `startAutoClockOutScheduler()` from Task 6.
- Produces: `finalScheduleEnd(snapshot): string | null` and `nextWorkerRefreshAt(finalEndAt, now): Date` for the client.
- Preserves: no constant browser polling; refresh occurs on focus/visibility and once after the calculated worker tick.

- [ ] **Step 1: Run impacts before lifecycle and widget edits**

Use GitNexus:

```text
gitnexus_impact({ repo: "TCTimecard", target: "ClockWidget", direction: "upstream", file_path: "client/src/components/tutor/ClockWidget.tsx", kind: "Function", includeTests: true })
```

Also run `gitnexus_api_impact({ repo: "TCTimecard", file: "server/index.ts" })`. Do not change any API route shape.

- [ ] **Step 2: Write failing client timing tests**

Create `client/tests/autoClockOut.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';
import { finalScheduleEnd, nextWorkerRefreshAt } from '../src/lib/autoClockOut';

test('client refresh uses the final split block', () => {
  assert.equal(finalScheduleEnd({ intervals: [
    { startAt: '2026-07-31T15:00:00-07:00', endAt: '2026-07-31T17:00:00-07:00' },
    { startAt: '2026-07-31T18:00:00-07:00', endAt: '2026-07-31T20:00:00-07:00' }
  ] }), '2026-07-31T20:00:00-07:00');
});

test('middle-hour end refreshes after minute 50 worker pass', () => {
  assert.equal(
    nextWorkerRefreshAt(
      '2026-07-31T15:30:00-07:00',
      new Date('2026-07-31T22:20:00.000Z')
    ).toISOString(),
    '2026-07-31T22:50:05.000Z'
  );
});

test('minute 59 end refreshes after the next hour starts', () => {
  assert.equal(
    nextWorkerRefreshAt(
      '2026-07-31T15:59:00-07:00',
      new Date('2026-07-31T22:20:00.000Z')
    ).toISOString(),
    '2026-07-31T23:00:05.000Z'
  );
});
```

- [ ] **Step 3: Add failing lifecycle/widget behavior coverage**

Extend the scheduler test to assert `stop()` prevents a queued pass. Create `client/src/components/tutor/ClockWidget.test.tsx` with the real component and API client, replacing only `globalThis.fetch`. Return a complete clocked-in state on the initial `/api/clock/me/state` request and a complete clocked-out state after `fireEvent.focus(window)`. Assert that visible text changes from “Clocked in” to “Clocked out”; do not assert only a listener or mock call count. When the component requests `/api/calendar/me/day/2026-07-31/snapshot`, return a complete schedule snapshot ending at 8:00 PM.

```tsx
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { ClockWidget } from './ClockWidget';
import type { ClockState } from '../../lib/api';

const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

const state = (clockState: 0 | 1): ClockState => ({
  timezone: 'America/Los_Angeles', workDate: '2026-07-31', dayId: 100,
  dayStatus: clockState === 1 ? 'draft' : 'approved', clockState,
  persistedClockState: clockState, openSessionId: clockState === 1 ? 5 : null,
  startedAt: clockState === 1 ? '2026-07-31T15:00:00.000-07:00' : null,
  activeBreak: null, breaks: [], breakSummary: { paidBreakMinutes: 0, unpaidBreakMinutes: 0 },
  attestationBlocking: false, missingWeekEnd: null
});

it('refreshes an automatically closed session when the window regains focus', async () => {
  let clockRequests = 0;
  globalThis.fetch = async (input) => {
    const path = String(input);
    if (path === '/api/clock/me/state') {
      const next = state(clockRequests === 0 ? 1 : 0);
      clockRequests += 1;
      return new Response(JSON.stringify({ state: next }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }
    if (path === '/api/calendar/me/day/2026-07-31/snapshot') {
      return new Response(JSON.stringify({ snapshot: {
        version: 1, franchiseId: 77, tutorId: 20, workDate: '2026-07-31',
        timezone: 'America/Los_Angeles', slotMinutes: 60, entries: [],
        intervals: [{
          startAt: '2026-07-31T15:00:00.000-07:00',
          endAt: '2026-07-31T20:00:00.000-07:00'
        }]
      } }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    throw new Error(`Unexpected request: ${path}`);
  };

  render(<ClockWidget />);
  expect(await screen.findByText('Clocked in')).toBeInTheDocument();
  fireEvent.focus(window);
  expect(await screen.findByText('Clocked out')).toBeInTheDocument();
});
```

- [ ] **Step 4: Run the focused tests and verify red**

Run:

```powershell
node --test --import tsx client/tests/autoClockOut.test.ts
npm run test --prefix client -- ClockWidget.test.tsx
node --test --import tsx server/tests/autoClockOutScheduler.test.ts
```

Expected: client helper import fails and widget/lifecycle expectations fail before wiring.

- [ ] **Step 5: Implement the client refresh helpers**

Create `client/src/lib/autoClockOut.ts` with defensive snapshot parsing and the same minute windows as the server. `nextWorkerRefreshAt` selects the first eligible whole minute strictly after `max(finalEndAt, now)`, then adds five seconds so the server pass can commit first.

```ts
export const finalScheduleEnd = (snapshot: unknown): string | null => {
  if (!snapshot || typeof snapshot !== 'object') return null;
  const intervals = (snapshot as { intervals?: unknown }).intervals;
  if (!Array.isArray(intervals)) return null;
  const ends = intervals
    .map((value) => value && typeof value === 'object'
      ? String((value as { endAt?: unknown }).endAt ?? '') : '')
    .map((value) => ({ value, epoch: Date.parse(value) }))
    .filter((value) => Number.isFinite(value.epoch))
    .sort((left, right) => left.epoch - right.epoch);
  return ends.at(-1)?.value ?? null;
};

const isWorkerMinute = (date: Date): boolean => {
  const minute = date.getUTCMinutes();
  return minute <= 9 || minute >= 50;
};

export const nextWorkerRefreshAt = (finalEndAt: string, now: Date): Date => {
  const finalEpoch = Date.parse(finalEndAt);
  if (!Number.isFinite(finalEpoch)) throw new Error('finalEndAt must be a valid ISO timestamp');
  const cursor = new Date(Math.max(finalEpoch, now.getTime()));
  cursor.setUTCSeconds(0, 0);
  cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  while (!isWorkerMinute(cursor)) {
    cursor.setUTCMinutes(cursor.getUTCMinutes() + 1);
  }
  cursor.setUTCSeconds(5, 0);
  return cursor;
};
```

- [ ] **Step 6: Add focus, visibility, and one-time refresh to ClockWidget**

Change `load()` to return `Promise<ClockState | null>` while still updating state and toast behavior. Add `focus` and `visibilitychange` effects that call `load()` when visible.

Add one recursive timeout chain only while the returned state is clocked in:

```ts
const scheduleNextRefresh = async (clockState: ClockState): Promise<void> => {
  const snapshot = await fetchTutorScheduleSnapshot(clockState.workDate);
  const finalEnd = finalScheduleEnd(snapshot);
  if (!finalEnd || cancelled) return;
  const refreshAt = nextWorkerRefreshAt(finalEnd, new Date());
  timeout = window.setTimeout(async () => {
    const refreshed = await load();
    if (!cancelled && refreshed?.clockState === 1) {
      await scheduleNextRefresh(refreshed);
    }
  }, Math.max(0, refreshAt.getTime() - Date.now()));
};
```

Catch schedule-fetch errors silently in this background refresh path; manual clock-out retains its existing visible error. Clear the timeout on unmount or when the effect is replaced.

- [ ] **Step 7: Start and stop the scheduler with the VM process**

In `server/index.ts`, start once after database environment validation:

```ts
const autoClockOutScheduler = startAutoClockOutScheduler();
```

Stop before closing either pool:

```ts
closeResources: async () => {
  autoClockOutScheduler.stop();
  const results = await Promise.allSettled([closePostgresPool(), closeMssqlPool()]);
  const failed = results.find((result) => result.status === 'rejected');
  if (failed?.status === 'rejected') throw failed.reason;
}
```

Do not start the scheduler from imported route/test modules; only the production entry point owns it.

- [ ] **Step 8: Document operation and rollout**

Update README with:

- Admin route `/admin/settings` and API `GET/PATCH /api/admin/settings`.
- Additive migration `0007_franchise_auto_clock_out.sql`.
- Worker cadence `00`-`09` and `50`-`59`, latest MSSQL schedule, exact backdating, four-connection cap, and safe skip behavior.
- Automatic completion bypasses interactive attestation but does not change attestation policy.

Update the 200-user runbook with a canary procedure: leave all flags off after deploy, enable one test franchise, clock in a test tutor with a split schedule, confirm no mid-gap closure, confirm final exact timestamp/status/audit, disable the flag, and inspect one structured run summary without database credentials.

- [ ] **Step 9: Verify lifecycle, client refresh, and production builds**

Run:

```powershell
node --test --import tsx client/tests/autoClockOut.test.ts
npm run test --prefix client -- ClockWidget.test.tsx
node --test --import tsx server/tests/autoClockOutScheduler.test.ts
npm run typecheck
npm run build
```

Expected: all focused tests PASS, scheduler stop is idempotent, client refresh is calculated rather than polling, and production builds succeed.

- [ ] **Step 10: Review impact and commit lifecycle integration**

Stage Task 7 files and run `gitnexus_detect_changes({ repo: "TCTimecard", scope: "staged" })`. Review clock widget and server startup/shutdown flows; confirm no unrelated route or auth changes.

```powershell
git add client/src/lib/autoClockOut.ts client/tests/autoClockOut.test.ts client/src/components/tutor/ClockWidget.tsx client/src/components/tutor/ClockWidget.test.tsx server/index.ts README.md docs/operations/replit-200-user-runbook.md
git commit -m "feat: activate franchise auto clock-out lifecycle"
```

---

### Task 8: Full Verification and Canary-Ready Handoff

**Files:**
- Verify all files changed in Tasks 1-7.
- Modify only a failing implementation or its owning test if verification exposes a real defect.

**Interfaces:**
- Confirms every approved requirement and all unchanged contracts.
- Produces a clean worktree and an evidence-backed rollout summary.

- [ ] **Step 1: Run every automated check from a clean process**

Run:

```powershell
npm test
npm run typecheck
npm run build
git diff --check HEAD~7..HEAD
```

Expected: server tests, client helper tests, client UI tests, load-tool tests, type checks, and both production builds PASS with no whitespace errors.

- [ ] **Step 2: Run focused mutation checks**

Temporarily make each mutation one at a time, run the named test, confirm failure, then immediately restore the mutation with `apply_patch`:

1. Change the default missing setting to `true` — `franchiseSettings.test.ts` must fail.
2. Treat minute `30` as eligible — cadence tests must fail.
3. Select the first split interval end — scheduler and client helper tests must fail.
4. Use detection time instead of `targetEndAt` — finalization exact-time test must fail.
5. Remove the active-break close write — finalization break test must fail.
6. Raise the client cap from four to five — 80-tutor pool test must fail.
7. Remove the settings recheck — disabled-during-pass test must fail.

After restoration, rerun all seven focused test files and confirm PASS.

- [ ] **Step 3: Inspect API shapes and execution-flow impact**

Use GitNexus:

```text
gitnexus_api_impact({ repo: "TCTimecard", route: "/clock/me/out" })
gitnexus_api_impact({ repo: "TCTimecard", file: "server/routes/hours.ts" })
gitnexus_detect_changes({ repo: "TCTimecard", base_ref: "ae86b00", scope: "compare" })
```

Expected: manual clock/calendar response shapes remain compatible; changed processes are limited to admin settings, schedule lookup, clock-out, scheduler lifecycle, and clock widget refresh. Stop and investigate any unrelated auth, time-off, export, or payroll calculation flow.

- [ ] **Step 4: Verify migration and rollout without mutating production unintentionally**

Review the resolved `POSTGRES_URL` target before running `npm run db:migrate`. Run the migration only against an explicitly identified development/staging database. Then execute:

```sql
SELECT column_name, data_type, column_default, is_nullable
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'franchise_payroll_settings'
  AND column_name = 'auto_clock_out_enabled';

SELECT COUNT(*) AS unexpectedly_enabled
FROM public.franchise_payroll_settings
WHERE auto_clock_out_enabled = TRUE;
```

Expected after initial deployment: Boolean column, default `false`, not nullable, and `unexpectedly_enabled = 0` before a canary administrator opts in.

- [ ] **Step 5: Execute the 80-tutor staging burst and interactive smoke check**

On staging, create or select 80 test open sessions in an enabled test franchise with one common latest final schedule end. During an eligible pass, capture:

- One batched MSSQL schedule request.
- Peak worker PostgreSQL connections no greater than four.
- All 80 sessions closed at the literal scheduled target.
- No duplicate `clock_out`/submission audit for any session.
- Scheduler summary `candidates = 80`, `due = 80`, `succeeded = 80`, `failed = 0`.
- Admin dashboard, approvals, Settings, tutor clock state, and one pay-period summary remain responsive during the burst.

Do not use production tutor accounts or enable a production franchise for this test.

- [ ] **Step 6: Finish with a clean change review**

Run:

```powershell
git status --short
git log --oneline -8
```

If verification required a code fix, stage only that fix and its failing-first regression test, run `gitnexus_detect_changes({ repo: "TCTimecard", scope: "staged" })`, rerun the full checks, and commit with a message describing the corrected behavior. Expected final state: clean worktree and all evidence recorded in the handoff.
