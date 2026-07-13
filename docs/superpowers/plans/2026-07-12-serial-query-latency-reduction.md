# Serial Query Latency Reduction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reduce authenticated-request database queueing by throttling forced session saves, removing timezone-only pay-period override lookups, and overlapping independent read queries.

**Architecture:** Preserve the existing Express monolith and both database adapters. Make narrowly scoped control-flow changes: a one-minute activity persistence threshold in auth middleware, direct use of normalized payroll settings for timezone-only routes, and `Promise.all` only where query inputs are already known and no shared transaction-bound client is involved.

**Tech Stack:** TypeScript, Express, express-session, PostgreSQL (`pg`), MSSQL, Node test runner.

## Global Constraints

- Target a comfortable maximum of 200 concurrent internal-tool users; the expected clock-state burst is approximately 30 tutors.
- Keep database pools at their current configured defaults; this plan does not change pool sizing.
- All agentic database work is read-only. Do not execute authenticated application requests, migrations, production queries, or load tests.
- Any SQL intended for production must be written to a file and tested/executed manually by a human; this plan introduces no production SQL.
- Do not add caching, indexes, dependencies, schema changes, or new environment variables.
- Run GitNexus impact analysis before editing every named symbol and `gitnexus_detect_changes()` before every commit.

---

### Task 1: Throttle Forced Session Activity Saves

**Files:**
- Create: `server/tests/authMiddleware.test.ts`
- Modify: `server/middleware/auth.ts:8-14`

**Interfaces:**
- Consumes: `AuthSessionData.lastSeenAt`, `Request.session.save`, existing `requireAuth` and `touchActiveSession` middleware contracts.
- Produces: `LAST_SEEN_PERSIST_INTERVAL_MS = 60_000` internal threshold and middleware behavior that calls `next()` without saving for recent valid activity.

- [ ] **Step 1: Write failing middleware tests**

Create request/session fakes and test the public `requireAuth` middleware:

```ts
test('requireAuth skips a forced save when lastSeenAt is less than one minute old', () => {
  const { req, getSaveCalls } = createRequest(new Date(Date.now() - 30_000).toISOString());
  let nextCalls = 0;

  requireAuth(req, createResponse(), () => { nextCalls += 1; });

  assert.equal(nextCalls, 1);
  assert.equal(getSaveCalls(), 0);
});

test('requireAuth persists activity when lastSeenAt is at least one minute old', () => {
  const { req, getSaveCalls } = createRequest(new Date(Date.now() - 61_000).toISOString());
  requireAuth(req, createResponse(), () => undefined);
  assert.equal(getSaveCalls(), 1);
  assert.ok(Date.parse(req.session.auth!.lastSeenAt) > Date.now() - 5_000);
});

test('requireAuth persists activity when lastSeenAt is invalid', () => {
  const { req, getSaveCalls } = createRequest('invalid');
  requireAuth(req, createResponse(), () => undefined);
  assert.equal(getSaveCalls(), 1);
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run: `node --test --import tsx server/tests/authMiddleware.test.ts`

Expected: the recent-activity test fails because the current middleware always calls `session.save()`.

- [ ] **Step 3: Implement the minimum threshold behavior**

Update `updateLastSeen`:

```ts
const LAST_SEEN_PERSIST_INTERVAL_MS = 60_000;

const updateLastSeen = (req: Request, auth: AuthSessionData, next: NextFunction) => {
  const now = Date.now();
  const previousLastSeenAt = Date.parse(auth.lastSeenAt);
  if (Number.isFinite(previousLastSeenAt) && now - previousLastSeenAt < LAST_SEEN_PERSIST_INTERVAL_MS) {
    next();
    return;
  }

  req.session.auth = { ...auth, lastSeenAt: new Date(now).toISOString() };
  req.session.save((err) => {
    if (err) next(err);
    else next();
  });
};
```

- [ ] **Step 4: Verify GREEN and regression coverage**

Run:

```powershell
node --test --import tsx server/tests/authMiddleware.test.ts
node --test --import tsx server/tests/sessionMiddleware.test.ts server/tests/payPeriodRoutes.test.ts
```

Expected: all selected tests pass.

- [ ] **Step 5: Detect impact and commit**

Run GitNexus change detection, review that only auth middleware callers are affected, then commit:

```powershell
git add server/middleware/auth.ts server/tests/authMiddleware.test.ts
git commit -m "perf: throttle session activity saves"
```

---

### Task 2: Remove Timezone-Only Override Queries

**Files:**
- Modify: `server/routes/hours.ts:8-9,308-311`
- Modify: `server/routes/clock.ts:6,295-310`
- Modify: `server/tests/hoursRoutes.test.ts`
- Modify: `server/tests/clockSubmission.test.ts` only if its pool fake asserts the timezone query sequence.

**Interfaces:**
- Consumes: `getFranchisePayrollSettings(franchiseId): Promise<FranchisePayrollSettings>` and its normalized `timezone` property.
- Produces: timezone-only helpers and clock-state reads that perform one payroll-settings query and no override query. Actual pay-period calculations continue using `resolvePayPeriod`.

- [ ] **Step 1: Write failing query-count tests**

Extend the Postgres fake to collect SQL strings. Exercise `/api/hours/me/weekly` and `/api/calendar/me/day/:workDate/snapshot`, then assert:

```ts
assert.equal(queries.filter((sql) => sql.includes('FROM franchise_payroll_settings')).length, 1);
assert.equal(queries.filter((sql) => sql.includes('FROM franchise_pay_period_overrides')).length, 0);
```

Add or extend the clock-state test to make the same assertion for `GET /api/clock/state`. Keep a pay-period resolver test proving overrides still win when an actual period is requested.

- [ ] **Step 2: Run focused tests and verify RED**

Run:

```powershell
node --test --import tsx server/tests/hoursRoutes.test.ts
node --test --import tsx server/tests/clockSubmission.test.ts
```

Expected: timezone-only endpoint assertions fail because they currently call `resolvePayPeriod` and query overrides.

- [ ] **Step 3: Implement direct settings lookup**

Import `getFranchisePayrollSettings` and change the hours helper:

```ts
const resolveTimezone = async (franchiseId: number): Promise<string> => {
  const settings = await getFranchisePayrollSettings(franchiseId);
  return settings.timezone;
};
```

For the read-only clock-state route, obtain `settings.timezone` directly. Leave clock mutations that require a real pay period on `resolvePayPeriod`.

- [ ] **Step 4: Verify GREEN**

Run the hours, clock, and pay-period resolution tests. Expected: all pass, timezone-only queries omit overrides, and actual pay-period resolution still honors overrides.

- [ ] **Step 5: Detect impact and commit**

Run GitNexus change detection, inspect all affected hours/calendar/clock flows, then commit:

```powershell
git add server/routes/hours.ts server/routes/clock.ts server/tests/hoursRoutes.test.ts server/tests/clockSubmission.test.ts
git commit -m "perf: avoid timezone-only override queries"
```

---

### Task 3: Overlap Independent Read Queries

**Files:**
- Modify: `server/routes/hours.ts:748-760,1014-1560`
- Modify: `server/tests/hoursRoutes.test.ts`

**Interfaces:**
- Consumes: approved day IDs; `fetchSessionsByDayIds`, `fetchBreaksByDayIds`, `fetchReportedCrmHoursByTutor`, and `fetchReportedCrmHoursByTutorDate` existing return types.
- Produces: unchanged HTTP response shapes and error propagation with lower serial query depth.

- [ ] **Step 1: Write failing concurrency tests**

Enhance fakes with optional query-start observers. For a tutor totals endpoint, make the session query defer its concurrency assertion to a microtask:

```ts
if (sqlText.includes('FROM public.time_entry_sessions')) {
  sessionsStarted = true;
  await Promise.resolve();
  assert.equal(breaksStarted, true, 'break query should start before session query resolves');
}
if (sqlText.includes('FROM public.time_entry_breaks')) {
  breaksStarted = true;
  await Promise.resolve();
  assert.equal(sessionsStarted, true);
}
```

For export, use the same pattern to prove CRM summary and daily aggregate queries are both started before either resolves. Assert the existing response body/workbook behavior as well.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `node --test --import tsx server/tests/hoursRoutes.test.ts`

Expected: concurrency assertions fail because sessions/breaks and export CRM aggregates are currently awaited sequentially.

- [ ] **Step 3: Implement concurrent session/break batches**

For every hours read path with known day IDs, replace serial awaits with:

```ts
const dayIds = approvedDays.map((day) => day.id);
const [sessionsByDay, breaksByDay] = await Promise.all([
  fetchSessionsByDayIds(dayIds),
  fetchBreaksByDayIds(getPostgresPool(), dayIds)
]);
```

Do not parallelize operations using a shared transaction-bound client.

- [ ] **Step 4: Implement concurrent export CRM aggregates**

Replace the two serial export aggregate awaits with:

```ts
const [crmHoursByTutor, crmHoursByTutorDate] = await Promise.all([
  fetchReportedCrmHoursByTutor(franchiseId, payPeriod),
  fetchReportedCrmHoursByTutorDate(franchiseId, payPeriod)
]);
```

- [ ] **Step 5: Verify GREEN and response compatibility**

Run:

```powershell
node --test --import tsx server/tests/hoursRoutes.test.ts
npm run test:server
```

Expected: concurrency tests and every server test pass with unchanged response assertions.

- [ ] **Step 6: Detect impact and commit**

Run GitNexus change detection, review affected hours/export flows, then commit:

```powershell
git add server/routes/hours.ts server/tests/hoursRoutes.test.ts
git commit -m "perf: overlap independent timecard reads"
```

---

### Task 4: Full Verification and Handoff

**Files:**
- Verify only; no expected production edits.

**Interfaces:**
- Consumes: all three committed optimizations.
- Produces: evidence that the repository builds and tests cleanly before the human-run single-load timing test.

- [ ] **Step 1: Run complete verification**

Run:

```powershell
npm test
npm run typecheck
npm run build
git diff --check HEAD~3..HEAD
```

Expected: all tests pass, typecheck passes, build completes, and diff check reports no whitespace errors.

- [ ] **Step 2: Run final GitNexus change detection**

Compare the implementation range to the design commit. Confirm affected symbols and execution flows match auth activity, timezone-only hours/clock routes, and hours/export read paths.

- [ ] **Step 3: Report human test procedure**

Do not run the load harness. Hand off a controlled sequence: deploy, verify one session request, then record single-user clock-state, weekly, monthly, admin summary, and export timings before running a 30-tutor clock-state burst or a later 200-user test.
