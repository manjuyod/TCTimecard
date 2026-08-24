# Database-Controlled PTO and Linked-Login Eligibility Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove application-controlled PTO activation and let explicitly linked authenticated tutor accounts use one canonical pool whenever that profile has an active membership at any enabled center, while retaining request ownership at the login center.

**Architecture:** PostgreSQL will expose one canonical linked-account resolver used by request guards and reservations. Express will use the same rule for tutor policy/profile/quote responses and will gate PTO administration to centers already enabled by database engineers. React will hide inactive-center administration while the existing tutor Time Off UI becomes available from eligible linked logins.

**Tech Stack:** PostgreSQL 17 SQL/PLpgSQL migrations, Express 4 with TypeScript, React 18 with React Router, Node test runner, Vitest and Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-23-database-controlled-pto-linked-login-eligibility-design.md`

## Global Constraints

- Execute all work inline; do not dispatch subagents.
- Center 68 remains the only enabled center; no migration or test command may mutate the configured external database.
- Production migration application remains a database-engineer-owned operation.
- Authenticated eligibility requires an exact CRM-active account with an explicit `linked` decision and at least one active membership at an enabled center.
- The login center and tutor ID remain the owner of the time-off request and approval workflow.
- Public aliases remain center-scoped and require their own enabled center.
- Every production symbol receives upstream GitNexus impact analysis before editing.
- Every behavior change follows red-green-refactor and is committed only after `gitnexus_detect_changes` confirms expected scope.

---

### Task 1: Canonical Linked-Account Database Resolver and Immediate Reservation

**Files:**
- Create: `server/db/migrations/0014_database_controlled_pto_linked_login.sql`
- Modify: `server/tests/ptoRouteMigration.test.ts`
- Modify: `server/tests/ptoRouteMigration.integration.test.ts`
- Modify: `server/tests/ptoAdminMigration.integration.test.ts`
- Modify: `server/tests/ptoMigration.integration.test.ts`

**Interfaces:**
- Consumes: `public.pto_canonical_profile_id(BIGINT)`, `public.pto_profile_link_decisions`, `public.pto_discovered_tutor_accounts`, `public.pto_profile_centers`, `public.pto_center_settings`, and the existing request lifecycle functions.
- Produces: `public.pto_authenticated_linked_profile(INTEGER, BIGINT) RETURNS BIGINT`, plus revised `public.pto_reject_disabled_request()` and `public.pto_reserve_request(...)` behavior.

- [ ] **Step 1: Run impact analysis for the SQL functions represented in the current migration graph**

Run GitNexus upstream impact analysis for `pto_reject_disabled_request`, `pto_reserve_request`, and `pto_resolve_profile`, including tests and a depth of three. Record risk, direct dependents, and affected flows before editing.

- [ ] **Step 2: Write the failing static migration contract test**

Extend `server/tests/ptoRouteMigration.test.ts` to load migration `0014_database_controlled_pto_linked_login.sql` and assert its defining contract:

```ts
const linkedEligibilityMigration = readFileSync(
  path.resolve(process.cwd(), 'server/db/migrations/0014_database_controlled_pto_linked_login.sql'),
  'utf8'
);

test('linked-login migration centralizes authenticated eligibility without enabling centers', () => {
  assert.match(linkedEligibilityMigration, /FUNCTION public\.pto_authenticated_linked_profile/i);
  assert.match(linkedEligibilityMigration, /decision\.status = 'linked'/i);
  assert.match(linkedEligibilityMigration, /account\.crm_active/i);
  assert.match(linkedEligibilityMigration, /settings\.enabled/i);
  assert.match(linkedEligibilityMigration, /FUNCTION public\.pto_reject_disabled_request/i);
  assert.match(linkedEligibilityMigration, /FUNCTION public\.pto_reserve_request/i);
  assert.doesNotMatch(linkedEligibilityMigration, /VALUES\s*\(\s*68\s*,\s*TRUE/i);
});
```

- [ ] **Step 3: Run the static test and verify RED**

Run:

```powershell
node --test --import tsx server/tests/ptoRouteMigration.test.ts
```

Expected: FAIL because migration `0014_database_controlled_pto_linked_login.sql` does not exist.

- [ ] **Step 4: Write the failing PostgreSQL acceptance test**

Add migration `0014_database_controlled_pto_linked_login.sql` to the disposable PostgreSQL migration lists. In `ptoRouteMigration.integration.test.ts`, create a Shannon-like canonical profile with enabled Center 68 membership and an explicitly linked, CRM-active Center 16 tutor account without a Center 16 membership. Insert a one-day pending request through Center 16 tutor 3487 and assert:

```ts
assert.equal(request.rows[0].franchiseid, 16);
assert.equal(String(request.rows[0].tutorid), '3487');
assert.equal(allocation.rows[0].state, 'reserved');
assert.equal(Number(allocation.rows[0].charged_days), 1);
assert.equal(Number(balance.rows[0].available_days), 4);
assert.equal(Number(balance.rows[0].reserved_days), 1);
```

Then update the request to `approved`, `denied`, and `cancelled` in separate fixtures and assert consumed or released allocation state without changing request ownership.

- [ ] **Step 5: Run the PostgreSQL test and verify RED**

Run:

```powershell
$env:RUN_PTO_POSTGRES_TESTS='1'; node --test --import tsx server/tests/ptoRouteMigration.integration.test.ts; Remove-Item Env:RUN_PTO_POSTGRES_TESTS
```

Expected: FAIL because the disabled-center insert guard rejects the Center 16 linked request.

- [ ] **Step 6: Implement the database resolver and lifecycle changes**

Create migration `0014_database_controlled_pto_linked_login.sql` with this resolver shape:

```sql
CREATE OR REPLACE FUNCTION public.pto_authenticated_linked_profile(
  p_franchiseid INTEGER,
  p_tutorid BIGINT
)
RETURNS BIGINT
LANGUAGE sql
STABLE
AS $$
  WITH matches AS (
    SELECT DISTINCT public.pto_canonical_profile_id(decision.profile_id) AS profile_id
    FROM public.pto_discovered_tutor_accounts account
    JOIN public.pto_profile_link_decisions decision
      ON decision.account_id = account.id AND decision.status = 'linked'
    JOIN public.pto_profiles profile
      ON profile.id = public.pto_canonical_profile_id(decision.profile_id) AND profile.active
    JOIN public.pto_profile_crm_ids crm
      ON crm.provider = account.provider AND crm.crm_id = account.crm_id
     AND public.pto_canonical_profile_id(crm.profile_id)
       = public.pto_canonical_profile_id(decision.profile_id)
    WHERE account.franchiseid = p_franchiseid
      AND account.tutor_id = p_tutorid
      AND account.provider = 'timecard-center:' || p_franchiseid::TEXT
      AND account.crm_id = p_tutorid::TEXT
      AND account.crm_active
      AND EXISTS (
        SELECT 1
        FROM public.pto_profile_centers sponsor
        JOIN public.pto_center_settings settings
          ON settings.franchiseid = sponsor.franchiseid AND settings.enabled
        WHERE sponsor.active
          AND public.pto_canonical_profile_id(sponsor.profile_id)
            = public.pto_canonical_profile_id(decision.profile_id)
      )
  )
  SELECT CASE WHEN COUNT(*) = 1 THEN MIN(profile_id) END FROM matches;
$$;
```

Redefine the insert guard so public requests still require their source center, while authenticated requests are admitted only when this resolver succeeds. Redefine `pto_reserve_request` so authenticated requests use this resolver and public requests retain `pto_resolve_profile` plus source-center activation. Preserve existing allocation, insufficient-balance, ledger, and transition logic verbatim after profile resolution.

- [ ] **Step 7: Run database tests and verify GREEN**

Run the static test, `ptoRouteMigration.integration.test.ts`, `ptoMigration.integration.test.ts`, and `ptoAdminMigration.integration.test.ts` with `RUN_PTO_POSTGRES_TESTS=1`.

Expected: all pass; the disposable database proves immediate reservation and ownership at Center 16.

- [ ] **Step 8: Detect scope and commit Task 1**

Run `gitnexus_detect_changes(scope: "all")`, confirm only PTO migrations and migration tests are affected, then commit:

```powershell
git add server/db/migrations/0014_database_controlled_pto_linked_login.sql server/tests/ptoRouteMigration.test.ts server/tests/ptoRouteMigration.integration.test.ts server/tests/ptoAdminMigration.integration.test.ts server/tests/ptoMigration.integration.test.ts
git commit -m "feat: reserve shared PTO from linked logins"
```

---

### Task 2: Server Policy, Profile, and Quote Eligibility

**Files:**
- Modify: `server/services/pto/routeStore.ts`
- Modify: `server/services/pto/postgresStore.ts`
- Modify: `server/tests/ptoRouteStore.test.ts`
- Modify: `server/tests/ptoRoutes.test.ts`
- Modify: `server/tests/timeOffRoutes.test.ts`

**Interfaces:**
- Consumes: `public.pto_authenticated_linked_profile(franchiseId, tutorId)` from Task 1.
- Produces: one server resolver used by authenticated policy and quotes, and tutor profile responses that resolve through an eligible explicit linked account without requiring a source-center membership.

- [ ] **Step 1: Run GitNexus impact analysis**

Run upstream impact for `resolveAuthenticatedProfile`, `createPtoRouteStore`, and `createPostgresPtoStore`, including tests. Warn before edits if any result is HIGH or CRITICAL.

- [ ] **Step 2: Write failing route-store tests**

Replace membership-query mocks with the database resolver query and add an inactive-source linked-login case:

```ts
test('inactive source center may quote through an eligible linked canonical profile', async () => {
  const pool = { query: async (sql: string) => {
    if (/pto_authenticated_linked_profile/i.test(sql)) return { rowCount: 1, rows: [{ profile_id: '8' }] };
    if (/JSONB_TO_RECORDSET/i.test(sql)) return { rowCount: 1, rows: [{ cycle_start: '2026-01-01', days: '1' }] };
    if (/WITH policy AS/i.test(sql)) return { rowCount: 1, rows: [balanceRow] };
    throw new Error(`Unexpected query: ${sql}`);
  } };
  const result = await createPtoRouteStore(pool as never).quoteAuthenticated({
    franchiseId: 16, tutorId: 3487, balanceDate: '2026-08-23', chargeDays: 1,
    dayCharges: [{ date: '2026-08-24', days: 1 }]
  });
  assert.equal(result.eligible, true);
  assert.equal(result.balance?.availableDays, 4);
});
```

Add a policy test proving an unresolved account at an inactive center returns `center_disabled`, while a resolved linked account never reads the source center status.

- [ ] **Step 3: Run route-store tests and verify RED**

Run:

```powershell
node --test --import tsx server/tests/ptoRouteStore.test.ts
```

Expected: FAIL because authenticated quotes still check the login center and the resolver still requires a local membership.

- [ ] **Step 4: Implement server eligibility**

Change `resolveAuthenticatedProfile` to query:

```sql
SELECT public.pto_authenticated_linked_profile($1, $2) AS profile_id
```

For policy status, resolve first. If resolution succeeds, return canonical balance regardless of source-center activation. If resolution fails, read the current center and return `center_disabled` when off or `identity_unresolved` when on.

Add a `checkSourceCenter` parameter to quote construction. Pass `false` for authenticated quotes and `true` for public quotes. Keep public balance omission unchanged.

Change `postgresStore.getTutorProfile` to begin with the same resolver instead of querying a local active membership. Continue returning only active canonical memberships and active membership-backed aliases.

- [ ] **Step 5: Add route contract coverage**

Update `ptoRoutes.test.ts` and `timeOffRoutes.test.ts` so `/api/pto/me`, `/api/pto/me/quote`, and `/api/timeoff/policy` accept an eligible linked login at an inactive source center while preserving response shapes and current-center request context.

- [ ] **Step 6: Run server unit tests and verify GREEN**

Run:

```powershell
node --test --import tsx server/tests/ptoRouteStore.test.ts server/tests/ptoRoutes.test.ts server/tests/timeOffRoutes.test.ts
```

Expected: all pass.

- [ ] **Step 7: Detect scope and commit Task 2**

Run `gitnexus_detect_changes(scope: "all")`, review affected PTO policy/profile/quote flows, then commit:

```powershell
git add server/services/pto/routeStore.ts server/services/pto/postgresStore.ts server/tests/ptoRouteStore.test.ts server/tests/ptoRoutes.test.ts server/tests/timeOffRoutes.test.ts
git commit -m "feat: resolve PTO through linked tutor accounts"
```

---

### Task 3: Database-Only Activation and Enabled-Center Administration

**Files:**
- Modify: `server/routes/pto.ts`
- Modify: `server/services/pto/service.ts`
- Modify: `server/services/pto/index.ts`
- Modify: `server/services/pto/contracts.ts`
- Modify: `server/services/pto/postgresStore.ts`
- Modify: `server/tests/ptoRoutes.test.ts`
- Modify: `server/tests/ptoService.test.ts`

**Interfaces:**
- Consumes: existing `getPtoCenterStatus(franchiseId)`.
- Produces: `syncPtoRoster({ franchiseId, actorId })` with no activation flag; inactive admin routes return `PTO_CENTER_DISABLED`; activation preview/activate/deactivate routes are absent.

- [ ] **Step 1: Run GitNexus impact analysis**

Run upstream impact for `createPtoRouter`, `syncPtoRoster`, `createPtoService`, and the `PtoServiceStore` interface. Stop and warn on HIGH or CRITICAL results.

- [ ] **Step 2: Write failing API authority tests**

Update `ptoRoutes.test.ts` to assert:

```ts
for (const path of [
  '/api/pto/admin/activation-preview?franchiseId=68',
  '/api/pto/admin/activate',
  '/api/pto/admin/deactivate'
]) {
  const response = await fetch(`${origin}${path}`, path.includes('preview') ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ franchiseId: 68 })
  });
  assert.equal(response.status, 404);
}
```

Add a test where `getCenterStatus` returns disabled and assert `/api/pto/admin/sync` returns `409` without calling `syncRoster`. Add the same gate to profile, audit, and mutation routes.

- [ ] **Step 3: Run API tests and verify RED**

Run:

```powershell
node --test --import tsx server/tests/ptoRoutes.test.ts server/tests/ptoService.test.ts
```

Expected: FAIL because activation routes exist and inactive-center admin operations are not gated.

- [ ] **Step 4: Remove application activation paths**

Delete activation preview, activate, and deactivate route registrations and their route dependency fields/imports. Wrap every remaining PTO admin handler with an enabled-center check using `getCenterStatus`; return the existing mapped `PTO_CENTER_DISABLED` response before invoking CRM or store work.

Change sync signatures from:

```ts
{ franchiseId: number; activate: boolean; actorId: Id }
```

to:

```ts
{ franchiseId: number; actorId: Id }
```

The service checks `store.getCenterStatus` before fetching MSSQL roster data. The PostgreSQL store rechecks the enabled row inside its transaction, updates only that existing row's sync-health columns, never writes `enabled`, and always audits `roster_synced`.

- [ ] **Step 5: Run API and service tests and verify GREEN**

Run the two targeted test files again. Expected: all pass and inactive sync performs no roster read.

- [ ] **Step 6: Detect scope and commit Task 3**

Run `gitnexus_detect_changes(scope: "all")`, confirm the affected flows are PTO admin routing and roster sync, then commit:

```powershell
git add server/routes/pto.ts server/services/pto/service.ts server/services/pto/index.ts server/services/pto/contracts.ts server/services/pto/postgresStore.ts server/tests/ptoRoutes.test.ts server/tests/ptoService.test.ts
git commit -m "refactor: make PTO activation database controlled"
```

---

### Task 4: Hide Inactive-Center PTO Administration in React

**Files:**
- Modify: `client/src/lib/api.ts`
- Modify: `client/src/App.tsx`
- Modify: `client/src/pages/admin/PtoManagementPage.tsx`
- Modify: `client/src/pages/admin/PtoManagementPage.test.tsx`
- Modify: `client/src/pages/admin/SettingsPage.tsx`
- Modify: `client/src/pages/admin/SettingsPage.test.tsx`

**Interfaces:**
- Consumes: `fetchFranchiseSettings(franchiseId)` and `FranchiseSettings.ptoEnabled`.
- Produces: maintenance-only PTO management for enabled centers, hidden navigation/settings for inactive centers, and no activation/deactivation client functions.

- [ ] **Step 1: Run GitNexus impact analysis**

Run upstream impact for `PtoManagementPage`, `SettingsPage`, `AdminLayout`, and the activation/deactivation client API functions. Warn before edits if risk is HIGH or CRITICAL.

- [ ] **Step 2: Write failing client visibility tests**

Replace activation and deactivation UI tests with these behaviors:

```ts
it('does not render PTO management for an inactive center', async () => {
  installSettingsFetch({ ptoEnabled: false });
  render(<MemoryRouter initialEntries={['/admin/pto']}><App /></MemoryRouter>);
  await waitFor(() => expect(screen.queryByRole('link', { name: /pto management/i })).not.toBeInTheDocument());
  expect(screen.queryByRole('button', { name: /activation|deactivate/i })).not.toBeInTheDocument();
});

it('shows maintenance-only PTO management for an enabled center', async () => {
  installSettingsFetch({ ptoEnabled: true });
  render(<MemoryRouter initialEntries={['/admin/pto']}><App /></MemoryRouter>);
  expect(await screen.findByRole('button', { name: 'Sync roster' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /activation|deactivate/i })).not.toBeInTheDocument();
});
```

In `SettingsPage.test.tsx`, assert the Shared PTO card is absent when `ptoEnabled` is false and present with Manage PTO only when true.

- [ ] **Step 3: Run client tests and verify RED**

Run:

```powershell
npm run test --prefix client -- src/pages/admin/PtoManagementPage.test.tsx src/pages/admin/SettingsPage.test.tsx
```

Expected: FAIL because inactive centers still advertise activation and the nav/card are unconditional.

- [ ] **Step 4: Implement maintenance-only UI**

Remove `fetchPtoActivationPreview`, `activatePtoCenter`, and `deactivatePtoCenter` from `api.ts`. Remove activation preview state, handlers, candidate preview mode, and deactivation dialog from `PtoManagementPage`.

Make `AdminLayout` start with the PTO nav item hidden, fetch the session center's franchise settings, and add the item only when `ptoEnabled` is true. Keep other navigation usable if that request fails.

In `PtoManagementPage`, load settings first and render `<Navigate to="/admin/dashboard" replace />` when the applied center is inactive. For an enabled center, render Sync roster and the existing profiles/audit tools with copy stating activation is database-controlled.

Wrap the current Shared PTO settings card in this condition without changing its enabled-center contents:

```tsx
{ptoEnabled ? (
  <Card>
    <CardHeader>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><CardTitle>Shared PTO</CardTitle>
          <CardDescription>One auditable balance follows confirmed tutors across participating centers.</CardDescription></div>
        <Badge variant="success">Shared PTO is active</Badge>
      </div>
    </CardHeader>
    <CardContent className="flex flex-wrap items-center justify-between gap-4">
      <div className="text-sm text-muted-foreground">
        <p>First activated: {ptoFirstActivatedAt ? new Date(ptoFirstActivatedAt).toLocaleString() : 'Never'}</p>
        <p>Last successful sync: {ptoLastSuccessfulSyncAt ? new Date(ptoLastSuccessfulSyncAt).toLocaleString() : 'Never'}</p>
      </div>
      <Button asChild disabled={!generalSettingsScopeApplied}><Link to="/admin/pto">Manage PTO</Link></Button>
    </CardContent>
  </Card>
) : null}
```

- [ ] **Step 5: Run client tests and verify GREEN**

Run the targeted Vitest files. Expected: all pass with no activation/deactivation calls.

- [ ] **Step 6: Detect scope and commit Task 4**

Run `gitnexus_detect_changes(scope: "all")`, confirm only admin PTO visibility and client API consumers are affected, then commit:

```powershell
git add client/src/lib/api.ts client/src/App.tsx client/src/pages/admin/PtoManagementPage.tsx client/src/pages/admin/PtoManagementPage.test.tsx client/src/pages/admin/SettingsPage.tsx client/src/pages/admin/SettingsPage.test.tsx
git commit -m "feat: hide inactive-center PTO administration"
```

---

### Task 5: Tutor Linked-Login Acceptance Coverage

**Files:**
- Modify: `client/src/pages/tutor/TimeOffPage.test.tsx`
- Modify: `server/tests/ptoRouteMigration.integration.test.ts`

**Interfaces:**
- Consumes: unchanged `TimeOffPolicy` and `TutorPtoProfile` response shapes.
- Produces: regression coverage that the existing Time Off UI displays and submits PTO through an inactive-center linked login.

- [ ] **Step 1: Run GitNexus impact analysis**

Run upstream impact for `TutorTimeOffPage`. Record the affected refresh/quote flow before editing its tests.

- [ ] **Step 2: Write the failing Shannon UI acceptance test**

Add a fixture where the current `center` is Center 16 with `enabled: false`, the policy is `eligible` with five available days, and the profile returns only active Center 68 membership plus its alias. Assert:

```ts
expect(await screen.findByText('5 days available')).toBeInTheDocument();
expect(screen.getByRole('option', { name: 'Paid Time Off' })).toBeInTheDocument();
expect(screen.getByRole('heading', { name: 'Center 68' })).toBeInTheDocument();
```

Submit or preview a one-day PTO request and assert the request call remains source-scoped while the quote endpoint is used.

- [ ] **Step 3: Run the tutor UI test and verify behavior**

Run:

```powershell
npm run test --prefix client -- src/pages/tutor/TimeOffPage.test.tsx
```

If the test passes immediately, retain it as an acceptance regression because Tasks 1 and 2 changed the server behavior that supplies the fixture. If it fails, make only the minimal presentation correction needed and rerun.

- [ ] **Step 4: Re-run the disposable PostgreSQL Shannon scenario**

Run `ptoRouteMigration.integration.test.ts` with `RUN_PTO_POSTGRES_TESTS=1` and confirm the UI fixture values match the database-backed acceptance outcome: Center 16 ownership, canonical profile 8 allocation, and immediate reservation.

- [ ] **Step 5: Detect scope and commit Task 5**

Run `gitnexus_detect_changes(scope: "all")`, then commit the acceptance coverage:

```powershell
git add client/src/pages/tutor/TimeOffPage.test.tsx server/tests/ptoRouteMigration.integration.test.ts
git commit -m "test: cover linked-login shared PTO requests"
```

---

### Task 6: Documentation, Full Verification, and Change Audit

**Files:**
- Modify: `README.md`
- Modify: `docs/operations/shared-pto-rollout.md`
- Modify: `docs/pto-public-integration.md`

**Interfaces:**
- Consumes: the implemented API and eligibility behavior.
- Produces: deployment instructions stating database-only activation, enabled-center admin maintenance, authenticated linked-login sponsorship, and unchanged public alias boundaries.

- [ ] **Step 1: Update documentation**

Remove admin activation/deactivation instructions and document the database-engineer activation handoff. State that Center 68 is the only currently enabled center, that authenticated linked accounts may submit through inactive centers while requests remain source-center-owned, and that public aliases remain blocked when their own center is inactive.

- [ ] **Step 2: Run focused server and client tests**

Run:

```powershell
node --test --import tsx server/tests/ptoRouteMigration.test.ts server/tests/ptoRouteStore.test.ts server/tests/ptoRoutes.test.ts server/tests/ptoService.test.ts server/tests/timeOffRoutes.test.ts
npm run test --prefix client -- src/pages/tutor/TimeOffPage.test.tsx src/pages/admin/PtoManagementPage.test.tsx src/pages/admin/SettingsPage.test.tsx
```

Expected: all pass.

- [ ] **Step 3: Run PostgreSQL integration tests**

Run all PTO PostgreSQL integration suites with `RUN_PTO_POSTGRES_TESTS=1`. Expected: all pass against disposable PostgreSQL 17 containers. Do not run `npm run db:migrate` against the configured external database.

- [ ] **Step 4: Run full repository verification**

Run:

```powershell
npm test
npm run typecheck
npm run build
git diff --check
```

Expected: every command exits zero with no TypeScript or build errors.

- [ ] **Step 5: Audit final blast radius**

Run `gitnexus_detect_changes(scope: "all")`. Confirm affected processes are limited to PTO eligibility, PTO route administration, roster sync, tutor Time Off presentation, admin PTO visibility, migrations, tests, and documentation.

- [ ] **Step 6: Verify external state remains unchanged**

Run a read-only query of `public.pto_center_settings` and confirm Center 68 is the sole enabled row. Verify Shannon Force's canonical profile still has the same balance and no implementation test records exist in the configured external database.

- [ ] **Step 7: Commit documentation and final fixes**

After `gitnexus_detect_changes`, commit:

```powershell
git add README.md docs/operations/shared-pto-rollout.md docs/pto-public-integration.md
git commit -m "docs: explain database-controlled PTO eligibility"
```
