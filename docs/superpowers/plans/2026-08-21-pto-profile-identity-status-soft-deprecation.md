# PTO Profile Identity Status Soft-Deprecation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove profile-level `identityStatus` from the unmerged PTO API contracts and user interface while preserving the legacy database column and all account-level decision behavior.

**Architecture:** Stop reading and mapping `pto_profiles.identity_status` at the shared PostgreSQL profile-summary boundary, then remove the property from the corresponding server and client TypeScript contracts. Remove only the profile-level status presentation from the admin UI; retain account-level `pending`/`linked`/`excluded` states, legacy identity-match audit records, and all database behavior.

**Tech Stack:** PostgreSQL, Express + TypeScript, React + TypeScript, Node test runner, Vitest, Testing Library, GitNexus.

**Spec:** `docs/superpowers/specs/2026-08-21-pto-profile-identity-status-soft-deprecation-design.md`

## Global Constraints

- Execute this plan inline with `superpowers:executing-plans`; do not dispatch subagents.
- Do not create, edit, or apply a database migration.
- Keep `pto_profiles.identity_status`, its constraints, schema preflight checks, stored-procedure reads/writes, and database regression tests intact.
- New PTO profile summary and detail responses must not contain `identityStatus`.
- The UI must not show a profile-level pending/confirmed identity state.
- Account-level `pending`, `linked`, and `excluded` states remain authoritative and unchanged.
- Keep the read-only **Identity matches** records in admin profile detail.
- Do not change PTO eligibility, balances, entitlements, memberships, discovery, linking, unlinking, aliases, requests, or audits.
- Follow TDD: add an assertion that fails for the current behavior, observe the failure, implement the minimum change, then observe the passing test.
- Before editing any existing symbol, run fresh GitNexus upstream impact analysis and report direct callers, affected processes, and risk to the user.
- A planning-time impact check reported HIGH risk for the client `PtoProfileSummary` because `client/src/lib/api.ts` is imported broadly. Warn the user before editing it and use direct `identityStatus` search plus full typecheck/build to constrain the real property-level impact.
- Before every commit, run GitNexus `detect_changes({"repo":"TCTimecard","scope":"all"})` and review all affected symbols and flows.
- Use `apply_patch` for every manual file edit.

## Implementation Map

- `server/services/pto/contracts.ts`: remove the deprecated field from the server `PtoProfileSummary` interface.
- `server/services/pto/postgresStore.ts`: stop selecting and mapping profile-level identity status for API-facing profile summaries.
- `server/tests/ptoAdminMigration.integration.test.ts`: prove the real PostgreSQL tutor, admin-detail, and admin-list mappings omit the field.
- `server/tests/ptoRoutes.test.ts`: keep route fixtures aligned with the reduced server contract.
- `client/src/lib/api.ts`: remove the field from the client `PtoProfileSummary` interface and all transitively extended response types.
- `client/src/pages/admin/PtoManagementPage.tsx`: remove the profile-level table column, badge, and dialog copy while retaining account states and legacy matches.
- `client/src/pages/admin/PtoManagementPage.test.tsx`: verify the removed presentation and retained legacy/account behavior.
- `client/src/pages/tutor/TimeOffPage.test.tsx`: align the tutor response fixture with the reduced API contract.
- `server/db/migrations/**`, `server/services/timeOffSchema.ts`, and `server/tests/timeOffSchema.test.ts`: deliberately unchanged.

---

### Task 1: Remove Identity Status from the Server Profile Contract

**Files:**
- Modify: `server/tests/ptoAdminMigration.integration.test.ts:124-132`
- Modify: `server/services/pto/contracts.ts:156-163`
- Modify: `server/services/pto/postgresStore.ts:46-53`
- Modify: `server/services/pto/postgresStore.ts:102-110`
- Modify: `server/tests/ptoRoutes.test.ts:14-17`

**Interfaces:**
- Consumes: existing `PtoBalance`, `PtoTutorProfileResult`, `PtoAdminProfileDetail`, and PostgreSQL `pto_profile_balance` output.
- Produces: `PtoProfileSummary = { id: Id; firstName: string; lastName: string; active: boolean; balance: PtoBalance }`.
- Guarantees: `getTutorProfile`, `listAdminProfiles`, and `getAdminProfile` return profile objects with no own `identityStatus` property.
- Preserves: the database `identity_status` column and every database-only path that still reads or writes it.

- [ ] **Step 1: Run required server impact analysis**

Run GitNexus for every production symbol changed in this task:

```json
{"target":"PtoProfileSummary","file_path":"server/services/pto/contracts.ts","direction":"upstream","includeTests":true,"maxDepth":3}
```

```json
{"target":"profile","file_path":"server/services/pto/postgresStore.ts","kind":"Function","direction":"upstream","includeTests":true,"maxDepth":3}
```

```json
{"target":"profileSelect","file_path":"server/services/pto/postgresStore.ts","direction":"upstream","includeTests":true,"maxDepth":3}
```

```json
{"target":"profile","file_path":"server/tests/ptoRoutes.test.ts","direction":"upstream","includeTests":true,"maxDepth":3}
```

Record and report the direct callers, affected processes, and risk before editing. Planning-time results were MEDIUM for the server interface, LOW for `profile`, and LOW for `profileSelect`; investigate and warn before proceeding if the fresh results rise to HIGH or CRITICAL.

- [ ] **Step 2: Add failing PostgreSQL contract assertions**

In the existing test `confirmed merge deduplicates cycle grants while combining adjustments into a negative balance`, add these assertions immediately after the corresponding existing ID/membership assertions:

```ts
assert.equal(Object.hasOwn(tutorView.profile ?? {}, 'identityStatus'), false);

assert.equal(Object.hasOwn(adminDetail ?? {}, 'identityStatus'), false);

assert.equal(Object.hasOwn(adminRoster.items[0] ?? {}, 'identityStatus'), false);
```

The resulting section must read in this order:

```ts
const tutorView = await createPostgresPtoStore(pool).getTutorProfile({ franchiseId: 20, tutorId: 200 });
assert.equal(tutorView.profile?.id, merged.rows[0].profile_id);
assert.equal(tutorView.memberships.length, 2);
assert.equal(Object.hasOwn(tutorView.profile ?? {}, 'identityStatus'), false);
const adminStore = createPostgresPtoStore(pool);
const adminDetail = await adminStore.getAdminProfile({ franchiseId: 20, profileId: merged.rows[0].profile_id });
assert.equal(adminDetail?.id, merged.rows[0].profile_id);
assert.equal(adminDetail?.memberships.length, 2);
assert.equal(Object.hasOwn(adminDetail ?? {}, 'identityStatus'), false);
const adminRoster = await adminStore.listAdminProfiles({ franchiseId: 20, search: '', page: 1, pageSize: 25 });
assert.deepEqual(adminRoster.items.map((item) => item.id), [merged.rows[0].profile_id]);
assert.equal(Object.hasOwn(adminRoster.items[0] ?? {}, 'identityStatus'), false);
```

- [ ] **Step 3: Run the PostgreSQL test and verify the red state**

Run:

```powershell
npx cross-env RUN_PTO_POSTGRES_TESTS=1 node --test --import tsx --test-name-pattern="confirmed merge deduplicates" server/tests/ptoAdminMigration.integration.test.ts
```

Expected: FAIL on the first new `Object.hasOwn(..., 'identityStatus')` assertion because the current mapper returns the property.

- [ ] **Step 4: Remove the property from the server contract and mapper**

Change `PtoProfileSummary` to exactly:

```ts
export interface PtoProfileSummary {
  id: Id;
  firstName: string;
  lastName: string;
  active: boolean;
  balance: PtoBalance;
}
```

Change the profile mapper to exactly:

```ts
const profile = (row: Record<string, unknown>): PtoProfileSummary => ({
  id: String(row.id),
  firstName: String(row.first_name ?? ''),
  lastName: String(row.last_name ?? ''),
  active: Boolean(row.active),
  balance: balance(row)
});
```

Remove `profile.identity_status` from the shared projection while retaining every other selected field:

```ts
const profileSelect = `
  SELECT profile.id, profile.first_name, profile.last_name, profile.active,
    COALESCE(balance.granted_days, 0) AS granted_days,
    COALESCE(balance.balance_days, 0) AS balance_days,
    COALESCE(balance.reserved_days, 0) AS reserved_days,
    COALESCE(balance.available_days, 0) AS available_days
  FROM public.pto_profiles profile
  LEFT JOIN LATERAL public.pto_profile_balance(profile.id, CURRENT_DATE) balance ON TRUE
`;
```

Align the route fixture without changing route behavior:

```ts
const profile = {
  profile: { id: '10', firstName: 'Ada', lastName: 'Lovelace', active: true,
    balance: { grantedDays: 5, balanceDays: 4, reservedDays: 1, availableDays: 3 } },
```

- [ ] **Step 5: Re-run the focused PostgreSQL test and verify the green state**

Run:

```powershell
npx cross-env RUN_PTO_POSTGRES_TESTS=1 node --test --import tsx --test-name-pattern="confirmed merge deduplicates" server/tests/ptoAdminMigration.integration.test.ts
```

Expected: PASS; tutor profile, admin detail, and admin list contain no `identityStatus` property.

- [ ] **Step 6: Run the complete affected server tests**

Run:

```powershell
node --test --import tsx server/tests/ptoRoutes.test.ts
npx cross-env RUN_PTO_POSTGRES_TESTS=1 node --test --import tsx server/tests/ptoAdminMigration.integration.test.ts
npm run build:server
```

Expected: all route tests and all PostgreSQL admin integration tests pass; the server TypeScript build exits successfully.

- [ ] **Step 7: Prove the database surface stayed unchanged**

Run:

```powershell
git diff --exit-code ce0b32f -- server/db/migrations server/services/timeOffSchema.ts server/tests/timeOffSchema.test.ts
```

Expected: exit code 0 and no diff.

- [ ] **Step 8: Review the Task 1 blast radius and commit**

Run GitNexus:

```json
{"repo":"TCTimecard","scope":"all"}
```

Use `gitnexus_detect_changes`. Confirm that only the server PTO contract, mapper/projection, and their tests are affected. Then run:

```powershell
git add server/services/pto/contracts.ts server/services/pto/postgresStore.ts server/tests/ptoAdminMigration.integration.test.ts server/tests/ptoRoutes.test.ts
git commit -m "refactor: remove PTO identity status from server contract"
```

---

### Task 2: Remove Profile Identity Status from the Client Contract and UI

**Files:**
- Modify: `client/src/pages/admin/PtoManagementPage.test.tsx:91-163`
- Modify: `client/src/pages/admin/PtoManagementPage.test.tsx:389-392`
- Modify: `client/src/lib/api.ts:255-262`
- Modify: `client/src/pages/admin/PtoManagementPage.tsx:573-583`
- Modify: `client/src/pages/admin/PtoManagementPage.tsx:635-638`
- Modify: `client/src/pages/tutor/TimeOffPage.test.tsx:55-59`

**Interfaces:**
- Consumes: the reduced server `PtoProfileSummary` from Task 1.
- Produces: client `PtoProfileSummary = { id: string; firstName: string; lastName: string; active: boolean; balance: PtoProfileBalance }`.
- Preserves: `PtoAdminProfileDetail.accounts[*].status` as `pending | linked | excluded` and `PtoAdminProfileDetail.candidates` for read-only legacy matches.
- Removes: the profile table **Identity** column, its status badge, and the profile-dialog pending/confirmed text.

- [ ] **Step 1: Run required client impact analysis and report the HIGH-risk result**

Run GitNexus:

```json
{"target":"PtoProfileSummary","file_path":"client/src/lib/api.ts","direction":"upstream","includeTests":true,"maxDepth":3}
```

```json
{"target":"PtoManagementPage","file_path":"client/src/pages/admin/PtoManagementPage.tsx","kind":"Function","direction":"upstream","includeTests":true,"maxDepth":3}
```

```json
{"target":"profileSummary","file_path":"client/src/pages/admin/PtoManagementPage.test.tsx","direction":"upstream","includeTests":true,"maxDepth":3}
```

```json
{"target":"installTimeOffFetch","file_path":"client/src/pages/tutor/TimeOffPage.test.tsx","kind":"Function","direction":"upstream","includeTests":true,"maxDepth":3}
```

Report the results before editing. The planning-time client interface result was HIGH because the large `api.ts` module has 25 direct file importers; direct repository search found property reads only in `PtoManagementPage.tsx` and stale PTO test fixtures. Treat full client typecheck and production build as mandatory containment checks.

- [ ] **Step 2: Add failing admin UI expectations**

In `loads center-scoped profiles and audit history with server-side pagination`, immediately after Ada appears, add:

```tsx
expect(screen.queryByRole('columnheader', { name: 'Identity' })).not.toBeInTheDocument();
expect(screen.queryByText('confirmed')).not.toBeInTheDocument();
```

Rename `shows profile identity, membership, email, ledger, and request details` to:

```ts
it('shows profile membership, email, ledger, request, and legacy match details without profile identity status', async () => {
```

Immediately after opening the profile dialog, use these expectations:

```tsx
expect(await screen.findByRole('heading', { name: 'Ada Lovelace' })).toBeInTheDocument();
expect(screen.getByText('Shared profile 10')).toBeInTheDocument();
expect(screen.queryByText(/confirmed identity/i)).not.toBeInTheDocument();
expect(screen.getByText('Identity matches')).toBeInTheDocument();
expect(screen.getByText('Tutor 123 · Center 1')).toBeInTheDocument();
expect(screen.getByText('ada+pto@example.com')).toBeInTheDocument();
expect(screen.getByText('Profile 10 ↔ Profile 11')).toBeInTheDocument();
expect(screen.getByText('Grant +5 days')).toBeInTheDocument();
expect(screen.getByText('Request 60 · 1 day · Reserved')).toBeInTheDocument();
```

- [ ] **Step 3: Run the admin component test and verify the red state**

Run:

```powershell
npm run test --prefix client -- src/pages/admin/PtoManagementPage.test.tsx
```

Expected: FAIL because the table still has an **Identity** heading and `confirmed` badge, and the dialog still renders `confirmed identity` instead of the exact `Shared profile 10` description.

- [ ] **Step 4: Remove the property from the client contract and fixtures**

Change the client contract to exactly:

```ts
export interface PtoProfileSummary {
  id: string;
  firstName: string;
  lastName: string;
  active: boolean;
  balance: PtoProfileBalance;
}
```

Add a type-only import to the admin component test:

```ts
import type { PtoProfileSummary } from '../../lib/api';
```

Make its fixture enforce the reduced contract:

```ts
const profileSummary = (
  id: string,
  firstName: string,
  lastName: string,
  availableDays: number
): PtoProfileSummary => ({
  id, firstName, lastName, active: true,
  balance: { grantedDays: 5, balanceDays: 4, reservedDays: 1, availableDays }
});
```

Remove `identityStatus: 'confirmed'` from the `/api/pto/me` fixture in `TimeOffPage.test.tsx`, leaving:

```ts
profile: { id: '10', firstName: 'Ada', lastName: 'Lovelace', active: true,
  balance: { grantedDays: 5, balanceDays: 4, reservedDays: 0.5, availableDays: 3.5 } },
```

- [ ] **Step 5: Remove only the profile-level UI presentation**

Change the profile table header to:

```tsx
<TableHeader><TableRow>
  <TableHead>Person</TableHead><TableHead>Available</TableHead><TableHead />
</TableRow></TableHeader>
```

Change each profile row to omit the identity-status cell:

```tsx
<TableRow key={profile.id}>
  <TableCell><p className="font-semibold text-foreground">{name}</p><p className="text-xs text-muted-foreground">Profile {profile.id}</p></TableCell>
  <TableCell>{profile.balance.availableDays} days</TableCell>
  <TableCell className="text-right">
```

Change the profile dialog description to:

```tsx
<DialogDescription>Shared profile {selectedProfile.id}</DialogDescription>
```

Do not change the `PtoAccountLinksPanel`, its account status badges/switches, or the `<DetailSection title="Identity matches">` block.

- [ ] **Step 6: Re-run the focused client tests and verify the green state**

Run:

```powershell
npm run test --prefix client -- src/pages/admin/PtoManagementPage.test.tsx src/pages/tutor/TimeOffPage.test.tsx
```

Expected: both files pass; the admin page has no profile-level identity status, account controls still render in their existing tests, and the legacy identity-match section remains present.

- [ ] **Step 7: Verify type and property consistency**

Run:

```powershell
npx tsc -p client/tsconfig.json --noEmit
$matches = rg -n "identityStatus" server client
if ($matches) { $matches; exit 1 }
Write-Output "No identityStatus references remain in server or client code"
```

Expected: client TypeScript exits successfully and the property scan prints `No identityStatus references remain in server or client code`.

- [ ] **Step 8: Run the complete regression suite and production build**

Run:

```powershell
npm test
npx cross-env RUN_PTO_POSTGRES_TESTS=1 node --test --import tsx server/tests/ptoAdminMigration.integration.test.ts
npm run typecheck
npm run build
```

Expected: all unit/helper/UI/load-tool tests pass, all PostgreSQL PTO admin integration tests pass, both TypeScript projects typecheck, and both production builds succeed.

- [ ] **Step 9: Reconfirm persistence and legacy-match boundaries**

Run:

```powershell
git diff --exit-code ce0b32f -- server/db/migrations server/services/timeOffSchema.ts server/tests/timeOffSchema.test.ts
rg -n "identity_status" server/db/migrations/0010_shared_pto.sql server/db/migrations/0011_pto_admin_invariants.sql server/services/timeOffSchema.ts
rg -n "Identity matches" client/src/pages/admin/PtoManagementPage.tsx client/src/pages/admin/PtoManagementPage.test.tsx
```

Expected: no diff in migration/schema files; retained legacy `identity_status` definitions and uses are found; the read-only **Identity matches** section and its test remain.

- [ ] **Step 10: Review the complete blast radius and commit**

Run GitNexus:

```json
{"repo":"TCTimecard","scope":"all"}
```

Use `gitnexus_detect_changes`. Review every changed symbol and affected flow, with special attention to the HIGH-fan-out client API module. Confirm that no eligibility, linking, balance, or database flow changed. Then run:

```powershell
git add client/src/lib/api.ts client/src/pages/admin/PtoManagementPage.tsx client/src/pages/admin/PtoManagementPage.test.tsx client/src/pages/tutor/TimeOffPage.test.tsx
git commit -m "refactor: hide legacy PTO profile identity status"
```

- [ ] **Step 11: Verify the final branch state before reporting completion**

Run:

```powershell
git status --short
git log -3 --oneline
```

Expected: the working tree is clean and the two implementation commits appear above design commit `ce0b32f`.

## Acceptance Checklist

- [ ] Tutor, admin-list, admin-detail, link, and unlink response shapes contain no `identityStatus` field.
- [ ] Server and client `PtoProfileSummary` interfaces contain no `identityStatus` property.
- [ ] Admin profile list contains no **Identity** column or pending/confirmed profile badge.
- [ ] Admin profile dialog contains no pending/confirmed identity description.
- [ ] Account-level `pending`, `linked`, and `excluded` presentation and actions still pass their existing tests.
- [ ] Read-only **Identity matches** records remain visible and tested.
- [ ] No `identityStatus` reference remains under `server/` or `client/`.
- [ ] Database migrations, schema preflight, and database-level `identity_status` behavior are unchanged.
- [ ] PTO tests, full typecheck, and production build pass.
- [ ] GitNexus reports only the expected PTO contract, mapping, UI, and test scope.
