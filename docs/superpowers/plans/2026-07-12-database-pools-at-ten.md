# Database Pools at Ten Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Raise the default Postgres and MSSQL pool maxima from five to ten connections per application process and document the matching Replit deployment settings.

**Architecture:** Keep the existing shared Postgres pool and existing MSSQL pool architecture unchanged. Only their default maximum sizes and operational documentation change; explicit environment values still override defaults.

**Tech Stack:** TypeScript, Node.js, `pg`, `mssql`, native `node:test`, Replit Reserved VM environment variables.

## Global Constraints

- Set both `POSTGRES_POOL_MAX` and `MSSQL_POOL_MAX` defaults to exactly `10`.
- Do not create a dedicated session pool.
- Do not change session persistence, SQL queries, VM size, or export concurrency.
- Agents must not run authenticated production requests, production SQL, migrations, or load tests.
- A human operator must update explicit Replit deployment variables and run staged credential/load tests.
- Roll back both production variables to `5` if database errors increase or latency worsens.

---

### Task 1: Raise both pool defaults with TDD

**Files:**
- Modify: `server/tests/dbConfig.test.ts:33-41`
- Modify: `server/config/env.ts:67`
- Modify: `server/config/env.ts:103`

**Interfaces:**
- Consumes: existing `getPostgresConfig()` and `getMssqlConfig()` environment parsing.
- Produces: `getPostgresConfig().max === 10` and `getMssqlConfig().pool.max === 10` when override variables are absent.

- [ ] **Step 1: Change the focused test first**

Replace the default test with:

```ts
test('database pool defaults are ten connections per process', () => {
  setRequiredValues();
  delete process.env.POSTGRES_POOL_MAX;
  delete process.env.MSSQL_POOL_MAX;

  assert.equal(getPostgresConfig().max, 10);
  assert.equal(getMssqlConfig().pool?.max, 10);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test --import tsx server/tests/dbConfig.test.ts`

Expected: FAIL twice because both actual defaults are `5` instead of `10`; the explicit-override test remains green.

- [ ] **Step 3: Change the two defaults**

In `getPostgresConfig`, use:

```ts
const max = parseInteger('POSTGRES_POOL_MAX', process.env.POSTGRES_POOL_MAX, 10, { min: 1 });
```

In `getMssqlConfig`, use:

```ts
const poolMax = parseInteger('MSSQL_POOL_MAX', process.env.MSSQL_POOL_MAX, 10, { min: 1 });
```

- [ ] **Step 4: Run the focused test and verify GREEN**

Run: `node --test --import tsx server/tests/dbConfig.test.ts`

Expected: 2 tests pass and 0 fail.

- [ ] **Step 5: Commit the tested configuration change**

Stage the two files, run `gitnexus_detect_changes(scope: "staged")`, and confirm LOW risk with only `getPostgresConfig`, `getMssqlConfig`, and the focused test touched.

```bash
git add server/config/env.ts server/tests/dbConfig.test.ts
git commit -m "perf: raise database pool defaults to ten"
```

---

### Task 2: Align examples and operations documentation

**Files:**
- Modify: `.env.example:15`
- Modify: `.env.example:27`
- Modify: `README.md:107`
- Modify: `README.md:115`
- Modify: `docs/operations/replit-200-user-runbook.md:37`
- Modify: `docs/operations/replit-200-user-runbook.md` failure-response section

**Interfaces:**
- Consumes: the defaults implemented in Task 1.
- Produces: consistent operator guidance for both pool variables at `10` and rollback to `5`.

- [ ] **Step 1: Update environment examples**

Use exactly:

```dotenv
POSTGRES_POOL_MAX=10
MSSQL_POOL_MAX=10
```

- [ ] **Step 2: Update README defaults**

Document:

```markdown
- `POSTGRES_POOL_MAX` (default `10`)
- `MSSQL_POOL_MAX` (default `10`), `MSSQL_POOL_MIN` (default `0`), `MSSQL_POOL_IDLE` (default `30000` ms)
```

- [ ] **Step 3: Update Replit deployment and rollback instructions**

Change the publishing instruction to:

```markdown
5. Set `POSTGRES_POOL_MAX=10` and `MSSQL_POOL_MAX=10` plus all existing required production secrets.
```

Append to the failure-response section:

```markdown
If database connection errors increase or latency worsens after the pool change, restore both deployment variables to `5` and redeploy before further testing.
```

- [ ] **Step 4: Verify documentation consistency**

Run:

```powershell
rg -n "POSTGRES_POOL_MAX|MSSQL_POOL_MAX" .env.example README.md docs/operations/replit-200-user-runbook.md
git diff --check
```

Expected: active configuration and operations documents show `10`; rollback guidance alone references `5`; no whitespace errors.

- [ ] **Step 5: Commit documentation changes**

Stage the three files, run `gitnexus_detect_changes(scope: "staged")`, and confirm no execution flows are affected.

```bash
git add .env.example README.md docs/operations/replit-200-user-runbook.md
git commit -m "docs: configure database pools at ten"
```

---

### Task 3: Final verification and human rollout gate

**Files:**
- Verify all files changed by Tasks 1-2.

**Interfaces:**
- Consumes: tested defaults and updated operations documentation.
- Produces: a verified repository change and a human-only Replit rollout checklist.

- [ ] **Step 1: Run fresh automated tests**

Run: `npm test`

Expected: all server and load-tool tests pass with 0 failures.

- [ ] **Step 2: Run typecheck, build, and whitespace verification**

Run: `npm run typecheck && npm run build && git diff --check`

Expected: every command exits zero. Existing advisory bundle-size and Browserslist warnings may remain.

- [ ] **Step 3: Run final GitNexus scope review**

Run `gitnexus_detect_changes(scope: "compare", base_ref: "af16bd0")`.

Expected: LOW risk; only pool configuration, its focused test, examples, and operations documentation changed; no query or session behavior changed.

- [ ] **Step 4: Hand off the human deployment gate**

Report these exact human actions without executing them:

1. Set Replit `POSTGRES_POOL_MAX=10` and `MSSQL_POOL_MAX=10` or remove both explicit variables after deploying code with the new defaults.
2. Redeploy.
3. Run credential preflight.
4. Run the 100-user stage before 200 users.
5. Capture Replit CPU, memory, request duration, HTTP status, and database/pool error logs.
6. Restore both variables to `5` and redeploy if database errors increase or latency worsens.
