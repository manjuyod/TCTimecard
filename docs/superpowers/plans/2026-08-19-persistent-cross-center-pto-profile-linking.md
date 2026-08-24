# Persistent Cross-Center PTO Profile Linking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discover, review, remember, link, and safely split a tutor's CRM accounts across centers so every verified account and email alias uses one canonical PTO pool.

**Architecture:** A new PostgreSQL discovery registry stores stable CRM accounts separately from explicit `pending`/`linked`/`excluded` decisions. MSSQL discovery remains read-only and exact-name matching only proposes default-off candidates; transactional PostgreSQL link/split functions preserve one canonical grant, center-scoped request activity, adjustment provenance, concurrency safety, and append-only audits. Express exposes typed preview/confirm operations, while focused React components add remembered center-account switches to the existing PTO management flow.

**Tech Stack:** PostgreSQL/Neon migrations and PL/pgSQL, MSSQL, Express + TypeScript, React + TypeScript, Node test runner, Vitest/Testing Library.

**Spec:** `docs/superpowers/specs/2026-08-19-persistent-cross-center-pto-profile-linking-design.md`

## Global Constraints

- Exact-name and email similarity may discover candidates but must never link them automatically.
- Every newly discovered account starts `pending` with its switch off.
- Existing `linked` and `excluded` decisions survive every roster/discovery sync.
- Provider plus CRM ID is the stable account identity; name and email changes only refresh snapshots.
- Any administrator from a linked center or the candidate account's center may manage any account in the group.
- A CRM account may belong to only one canonical PTO pool.
- A canonical pool may link at most one tutor account per center.
- Dormant links never activate a center, grant eligibility, or activate an email alias.
- One confirmed person receives one entitlement grant per policy cycle across all linked centers.
- Authenticated `(franchiseId, tutorId)` and unambiguous public `(franchiseId, email)` requests must resolve the same canonical pool after membership activation.
- Opt-out moves center-attributable requests, reservations, usage, emails, identities, and adjustments without resetting PTO.
- Ambiguous legacy adjustments block a split until their membership provenance is reconciled.
- Every mutation is transactional, version-checked, idempotent, and append-only audited.
- PTO remains disabled by default for every center.
- Do not apply PTO migrations to production from an automated agent session; a human owns production credentials and the deployment window.
- Before modifying any existing function, class, or method, run GitNexus upstream impact analysis and report direct callers, affected processes, and risk. Stop and warn the user on HIGH or CRITICAL risk.
- Before every commit, run GitNexus `detect_changes({ scope: "all" })` and review the affected symbols and execution flows.

## Implementation Map

- `server/db/migrations/0013_persistent_pto_profile_links.sql`: additive discovery/decision schema, sync timestamps, adjustment provenance, link/split functions, backfill, and database invariants.
- `server/services/pto/contracts.ts`: typed discovery, decision, preview, mutation, and adjustment-provenance contracts.
- `server/services/pto/discoverySource.ts`: batched, parameterized MSSQL exact-name discovery with no password access.
- `server/services/pto/rosterSource.ts`: retains center-local roster reads and composes the new discovery source.
- `server/services/pto/postgresLinkStore.ts`: focused PostgreSQL account/preview/link/unlink/provenance methods.
- `server/services/pto/postgresStore.ts`: composes link methods and reconciles discovered accounts during roster sync.
- `server/services/pto/service.ts` and `server/services/pto/index.ts`: orchestrate independent roster/discovery reads and expose transactional operations.
- `server/routes/pto.ts` and `server/services/pto/errors.ts`: validated preview/confirm endpoints and stable error codes.
- `server/services/timeOffSchema.ts`: schema preflight for the new tables and columns.
- `server/services/pto/routeStore.ts`: verifies linked authenticated and public aliases still resolve canonical active memberships.
- `client/src/lib/api.ts`: typed account rows, previews, mutations, status timestamps, and adjustment membership input.
- `client/src/pages/admin/pto/PtoAccountLinksPanel.tsx`: account/center rows, statuses, switches, and accessibility labels.
- `client/src/pages/admin/pto/PtoLinkPreviewDialog.tsx`: link/split impact confirmation and reconciliation display.
- `client/src/pages/admin/PtoManagementPage.tsx`: integrates focused account-link components and discovery status into activation/profile flows.
- `client/src/pages/tutor/TimeOffPage.tsx`: shows linked active centers and aliases beneath the single shared balance.
- Existing PTO test files plus new focused component/source tests: contract, integration, route, UI, and three-center acceptance coverage.
- `docs/operations/shared-pto-rollout.md`, `docs/pto-public-integration.md`, and the original completed plan: deployment/reconciliation guidance and follow-up links.

---

### Task 1: Add the Persistent Discovery Schema Contract

**Files:**
- Create: `server/db/migrations/0013_persistent_pto_profile_links.sql`
- Modify: `server/tests/ptoMigration.test.ts`
- Modify: `server/services/timeOffSchema.ts`
- Modify: `server/tests/timeOffSchema.test.ts`

**Interfaces:**
- Produces tables `pto_discovered_tutor_accounts` and `pto_profile_link_decisions`.
- Adds `last_successful_roster_sync_at`, `last_roster_sync_error`, `last_successful_discovery_at`, and `last_discovery_error` to `pto_center_settings`.
- Adds nullable `source_membership_id BIGINT` to `pto_ledger_entries`.
- Later tasks consume the table/column names exactly as defined here.

- [ ] **Step 1: Run required impact analysis before touching schema preflight code**

Run GitNexus:

```json
{"target":"findMissingTimeOffSchemaColumns","file_path":"server/services/timeOffSchema.ts","direction":"upstream","includeTests":true}
```

Record the risk and direct callers. Stop for user review if the result is HIGH or CRITICAL.

- [ ] **Step 2: Write failing migration-contract tests**

Add a loader for `0013_persistent_pto_profile_links.sql` and assertions like:

```ts
const linkMigrationPath = path.resolve(__dirname, '../db/migrations/0013_persistent_pto_profile_links.sql');
const loadLinkMigration = (): string =>
  existsSync(linkMigrationPath) ? readFileSync(linkMigrationPath, 'utf8').replace(/\s+/g, ' ').trim() : '';

test('persistent PTO link migration separates discovered accounts from explicit decisions', () => {
  const sql = loadLinkMigration();
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.pto_discovered_tutor_accounts/i);
  assert.match(sql, /UNIQUE \(provider, crm_id\)/i);
  assert.match(sql, /UNIQUE \(franchiseid, tutor_id\)/i);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS public\.pto_profile_link_decisions/i);
  assert.match(sql, /status TEXT NOT NULL.*pending.*linked.*excluded/is);
  assert.match(sql, /version INTEGER NOT NULL DEFAULT 1/i);
  assert.match(sql, /source_membership_id BIGINT/i);
});
```

Extend `timeOffSchema.test.ts`:

```ts
assert.ok(missing.includes('pto_discovered_tutor_accounts.provider'));
assert.ok(missing.includes('pto_profile_link_decisions.status'));
assert.ok(missing.includes('pto_ledger_entries.source_membership_id'));
assert.ok(missing.includes('pto_center_settings.last_successful_discovery_at'));
```

- [ ] **Step 3: Run the contract tests and verify they fail**

Run:

```powershell
node --test --import tsx server/tests/ptoMigration.test.ts server/tests/timeOffSchema.test.ts
```

Expected: FAIL because migration `0013` and required schema columns do not exist.

- [ ] **Step 4: Create the additive schema**

Implement the concrete DDL foundation:

```sql
CREATE TABLE IF NOT EXISTS public.pto_discovered_tutor_accounts (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL,
  crm_id TEXT NOT NULL,
  franchiseid INTEGER NOT NULL,
  tutor_id BIGINT NOT NULL,
  normalized_first_name TEXT NOT NULL,
  normalized_last_name TEXT NOT NULL,
  crm_snapshot JSONB NOT NULL DEFAULT '{}'::JSONB,
  crm_active BOOLEAN NOT NULL DEFAULT TRUE,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (provider, crm_id),
  UNIQUE (franchiseid, tutor_id)
);

CREATE TABLE IF NOT EXISTS public.pto_profile_link_decisions (
  id BIGSERIAL PRIMARY KEY,
  profile_id BIGINT NOT NULL REFERENCES public.pto_profiles(id),
  account_id BIGINT NOT NULL REFERENCES public.pto_discovered_tutor_accounts(id),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'linked', 'excluded')),
  version INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
  decided_by TEXT,
  decision_franchiseid INTEGER,
  decided_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (profile_id, account_id)
);
```

Add the four center sync columns, the ledger provenance foreign key, normalized-name index, decision lookup indexes, and idempotent `IF NOT EXISTS` guards. Backfill new roster timestamps from `last_successful_sync_at`/`last_sync_error` without removing the compatibility columns.

- [ ] **Step 5: Update schema preflight expectations**

Add the exact new tables/columns to `REQUIRED_COLUMNS`, including all timestamps and decision metadata. Keep existing requirements unchanged.

- [ ] **Step 6: Run focused tests and static checks**

Run:

```powershell
node --test --import tsx server/tests/ptoMigration.test.ts server/tests/timeOffSchema.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Review scope and commit**

Run GitNexus `detect_changes({"scope":"all","repo":"TCTimecard"})`; expect only schema-preflight symbols and no runtime PTO flow yet. Then:

```powershell
git add server/db/migrations/0013_persistent_pto_profile_links.sql server/tests/ptoMigration.test.ts server/services/timeOffSchema.ts server/tests/timeOffSchema.test.ts
git commit -m "feat: add persistent PTO account discovery schema"
```

---

### Task 2: Add Typed Batched CRM Account Discovery

**Files:**
- Create: `server/services/pto/discoverySource.ts`
- Create: `server/tests/ptoDiscoverySource.test.ts`
- Modify: `server/services/pto/contracts.ts`
- Modify: `server/services/pto/rosterSource.ts`
- Modify: `server/services/pto/index.ts`
- Test: `server/tests/ptoRosterSource.test.ts`

**Interfaces:**
- Produces `PtoDiscoveryResult` and `PtoDiscoveredRosterAccount`.
- Produces `PtoTutorRosterSource.discoverRelatedAccounts(tutors): Promise<PtoDiscoveryResult>`.
- Keeps `fetchTutors(franchiseId): Promise<PtoRosterTutor[]>` unchanged for local roster authority.

- [ ] **Step 1: Run required impact analyses**

Run GitNexus upstream impact for `createMssqlPtoRosterSource` in `server/services/pto/rosterSource.ts` and report the result before editing.

- [ ] **Step 2: Define the discovery contracts and failing tests**

Add:

```ts
export interface PtoDiscoveredRosterAccount extends PtoRosterTutor {
  provider: string;
  crmId: string;
}

export interface PtoDiscoveryResult {
  accounts: PtoDiscoveredRosterAccount[];
  attemptedAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface PtoTutorRosterSource {
  fetchTutors(franchiseId: number): Promise<PtoRosterTutor[]>;
  discoverRelatedAccounts(tutors: PtoRosterTutor[]): Promise<PtoDiscoveryResult>;
}
```

Test a source roster containing `Ada Lovelace` and `Grace Hopper`. Capture the generated SQL and assert that it:

```ts
assert.match(queryText, /JOIN \(VALUES/i);
assert.match(queryText, /LOWER\(LTRIM\(RTRIM\(candidate\.FirstName\)\)\)/i);
assert.match(queryText, /candidate\.IsDeleted = 0/i);
assert.doesNotMatch(queryText, /\bPassword\b/i);
assert.deepEqual(result.accounts.map(({ franchiseId, id }) => [franchiseId, id]), [[2, 200]]);
```

Also test empty input returns without opening a request, source rows are excluded, missing names are ignored, and duplicate candidates are deduplicated by `(franchiseId,id)`.

- [ ] **Step 3: Run focused tests and verify failure**

Run:

```powershell
node --test --import tsx server/tests/ptoDiscoverySource.test.ts server/tests/ptoRosterSource.test.ts
```

Expected: FAIL because the discovery module and method are missing.

- [ ] **Step 4: Implement one batched parameterized query**

Implement `createMssqlPtoDiscoverySource(getPool, now)` in `discoverySource.ts`. Build a deduplicated array of normalized name pairs, bind each first/last name as `sql.VarChar(255)`, and construct a bounded `VALUES` list such as:

```sql
JOIN (VALUES (@first0, @last0), (@first1, @last1)) AS incoming(first_name, last_name)
  ON LOWER(LTRIM(RTRIM(candidate.FirstName))) = incoming.first_name
 AND LOWER(LTRIM(RTRIM(candidate.LastName))) = incoming.last_name
WHERE candidate.IsDeleted = 0
```

Select only `ID, FranchiseID, FirstName, LastName, Email, IsDeleted`. Filter source account keys in TypeScript and return normalized provider/CRM IDs. Cap one query at 500 unique name pairs and merge chunk results by account key.

- [ ] **Step 5: Compose discovery into the existing roster source**

Have `createMssqlPtoRosterSource` expose both methods, delegating discovery to the focused source. Update test doubles in `ptoService.test.ts` to provide `discoverRelatedAccounts` in later tasks; do not change service orchestration yet.

- [ ] **Step 6: Run tests and typecheck**

Run:

```powershell
node --test --import tsx server/tests/ptoDiscoverySource.test.ts server/tests/ptoRosterSource.test.ts
npm run typecheck
```

Expected: PASS, with tests proving no password column is read.

- [ ] **Step 7: Detect impact and commit**

Run GitNexus `detect_changes({"scope":"all","repo":"TCTimecard"})`, review the roster-source consumers, then:

```powershell
git add server/services/pto/discoverySource.ts server/tests/ptoDiscoverySource.test.ts server/services/pto/contracts.ts server/services/pto/rosterSource.ts server/services/pto/index.ts server/tests/ptoRosterSource.test.ts
git commit -m "feat: discover cross-center PTO account candidates"
```

---

### Task 3: Persist Discovery Without Overwriting Decisions

**Files:**
- Modify: `server/services/pto/contracts.ts`
- Modify: `server/services/pto/service.ts`
- Modify: `server/services/pto/postgresStore.ts`
- Test: `server/tests/ptoService.test.ts`
- Test: `server/tests/ptoAdminMigration.integration.test.ts`

**Interfaces:**
- Extends `PtoRosterSyncStoreInput` with `discovery: PtoDiscoveryResult`.
- Extends activation/sync summaries with `discoveredAccountCount`, `linkedAccountCount`, `excludedAccountCount`, `pendingReviewCount`, and separate roster/discovery timestamps/errors.
- Produces idempotent discovered-account and default-pending decision upserts.

Use these exact health fields in `PtoCenterStatus`, `PtoActivationPreview`, and `PtoRosterSyncSummary`, retaining `lastSuccessfulSyncAt` and `lastSyncError` as compatibility aliases until Task 8 migrates all consumers:

```ts
export interface PtoSyncHealth {
  lastSuccessfulRosterSyncAt: string | null;
  lastRosterSyncError: string | null;
  lastSuccessfulDiscoveryAt: string | null;
  lastDiscoveryError: string | null;
}
```

- [ ] **Step 1: Run required impact analyses**

Run GitNexus upstream impact for `createPtoService` and `createPostgresPtoStore`. Report callers, affected flows, and risk before editing.

- [ ] **Step 2: Write failing service tests for independent failure semantics**

Add tests proving local roster failure performs zero PostgreSQL writes and discovery failure still performs local sync with preserved decisions:

```ts
const now = '2026-08-19T20:00:00.000Z';
const localTutor = {
  id: 6801, franchiseId: 68, firstName: 'Ada', lastName: 'Lovelace',
  email: 'ada@example.com', isDeleted: false
};

rosterSource: {
  fetchTutors: async () => [localTutor],
  discoverRelatedAccounts: async () => ({
    accounts: [], attemptedAt: now, completedAt: null, error: 'global discovery unavailable'
  })
}
```

Assert `syncRoster` receives the discovery error and the service returns a warning instead of throwing. Preview must run both reads without a write transaction.

- [ ] **Step 3: Write failing PostgreSQL integration tests**

Extend the integration migration list with `0013_persistent_pto_profile_links.sql`. Sync a local tutor plus one remote discovered account, manually update its decision to `excluded`, sync again, and assert:

```sql
SELECT status, version
FROM public.pto_profile_link_decisions
WHERE account_id = $1
```

returns `excluded` with the same version. Repeat for `linked`. Assert a new discovery starts `pending` and no remote `pto_profile_centers` row or entitlement cycle is created.

- [ ] **Step 4: Run focused tests and verify failure**

Run:

```powershell
node --test --import tsx server/tests/ptoService.test.ts
$env:RUN_PTO_POSTGRES_TESTS='1'; node --test --import tsx --test-name-pattern="discovery" server/tests/ptoAdminMigration.integration.test.ts
```

Expected: FAIL because service/store discovery support is absent.

- [ ] **Step 5: Implement independent roster/discovery orchestration**

In `createPtoService`, read the local roster first, then call discovery with active local tutors. Convert thrown discovery errors into a `PtoDiscoveryResult` with `completedAt: null`; do not convert local roster errors.

- [ ] **Step 6: Persist discovered accounts without mutating decisions**

In `syncRoster`, upsert accounts and decisions with conflict behavior that only refreshes account snapshots:

```sql
INSERT INTO public.pto_profile_link_decisions (profile_id, account_id, status)
VALUES ($1, $2, 'pending')
ON CONFLICT (profile_id, account_id) DO NOTHING;
```

Never update decision status/version during sync. Write roster and discovery timestamps/errors separately and add `pto_account_discovered`/`pto_discovery_failed` audit events with deterministic idempotency keys scoped to account plus discovery timestamp.

- [ ] **Step 7: Return typed activation and sync counts**

Add the four account counts. Keep `pendingExactNameCandidateCount` on activation preview and `pendingCandidateCount` on sync summary as compatibility aliases whose values equal `pendingReviewCount`; Task 8 migrates the UI to the new fields but does not remove the aliases in this feature. Include warnings for incomplete local names and failed/stale discovery.

- [ ] **Step 8: Run focused and regression tests**

Run:

```powershell
node --test --import tsx server/tests/ptoService.test.ts server/tests/ptoRosterSource.test.ts
$env:RUN_PTO_POSTGRES_TESTS='1'; node --test --import tsx --test-name-pattern="discovery" server/tests/ptoAdminMigration.integration.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 9: Detect impact and commit**

Run GitNexus `detect_changes({"scope":"all","repo":"TCTimecard"})`, confirm only PTO activation/sync flows are affected, then:

```powershell
git add server/services/pto/contracts.ts server/services/pto/service.ts server/services/pto/postgresStore.ts server/tests/ptoService.test.ts server/tests/ptoAdminMigration.integration.test.ts server/db/migrations/0013_persistent_pto_profile_links.sql
git commit -m "feat: persist remembered PTO discovery decisions"
```

---

### Task 4: Implement Account Link Preview and Confirmation

**Files:**
- Create: `server/services/pto/postgresTypes.ts`
- Create: `server/services/pto/postgresLinkStore.ts`
- Modify: `server/services/pto/contracts.ts`
- Modify: `server/services/pto/postgresStore.ts`
- Modify: `server/db/migrations/0013_persistent_pto_profile_links.sql`
- Test: `server/tests/ptoAdminMigration.integration.test.ts`
- Test: `server/tests/ptoService.test.ts`

**Interfaces:**
- Produces `previewAccountLink(input: PtoAccountLinkPreviewInput): Promise<PtoAccountLinkPreview>`.
- Produces `linkAccount(input: PtoAccountLinkMutationInput): Promise<PtoAccountLinkMutationResult>`.
- Produces database functions `pto_assert_link_admin` and `pto_admin_link_account`.

- [ ] **Step 1: Run required impact analysis**

Run GitNexus upstream impact for `createPostgresPtoStore` and `createPtoService`; stop for HIGH/CRITICAL risk.

- [ ] **Step 2: Add exact input/output contracts**

Define:

```ts
export interface PtoDiscoveredAccount {
  id: Id;
  provider: string;
  crmId: string;
  franchiseId: number;
  tutorId: number;
  firstName: string;
  lastName: string;
  displayEmail: string | null;
  crmActive: boolean;
  centerEnabled: boolean;
  membershipId: Id | null;
  status: 'pending' | 'linked' | 'excluded';
  version: number;
  lastSeenAt: string;
  warnings: string[];
}

export interface PtoAccountLinkBaseInput {
  profileId: Id;
  accountId: Id;
  actorId: Id;
  actorFranchiseId: number;
  expectedVersion: number;
}

export interface PtoAccountLinkMutationInput extends PtoAccountLinkBaseInput {
  idempotencyKey: string;
}

export interface PtoAccountLinkPreview {
  mode: 'link' | 'unlink';
  profileId: Id;
  account: PtoDiscoveredAccount;
  version: number;
  beforeBalances: Array<{ profileId: Id; availableDays: number }>;
  afterBalances: Array<{ profileId: Id; availableDays: number }>;
  affectedRequestIds: Id[];
  ambiguousAdjustmentIds: Id[];
  warnings: string[];
}

export interface PtoAccountLinkMutationResult {
  canonicalProfileId: Id;
  detachedProfileId: Id | null;
  decisionVersion: number;
}
```

- [ ] **Step 3: Write failing integration tests for dormant and active links**

Cover:

1. Dormant link inserts the provider/CRM identity but no center membership, email, cycle, or activation.
2. Later center sync finds that identity and attaches to the canonical profile with one grant.
3. Linking two active profiles calls the alias path, preserves non-grant activity, and reports a negative result when applicable.
4. A CRM account already linked elsewhere returns a conflict.
5. A second linked account from the same center returns a center-account conflict.
6. Actor center is authorized when it owns the candidate or has an active linked membership; an unrelated center is rejected.
7. Repeating an idempotency key returns the stored result; a stale version is rejected.

- [ ] **Step 4: Run integration tests and verify failure**

Run:

```powershell
$env:RUN_PTO_POSTGRES_TESTS='1'; node --test --import tsx --test-name-pattern="account link|dormant link|link conflict" server/tests/ptoAdminMigration.integration.test.ts
```

Expected: FAIL because link functions/store methods are missing.

- [ ] **Step 5: Implement database authorization and lock acquisition**

Add `pto_assert_link_admin(profileId, accountId, actorFranchiseId)` and `pto_admin_link_account(...)`. Lock advisory keys in sorted order:

```sql
PERFORM PG_ADVISORY_XACT_LOCK(HASHTEXTEXTENDED('pto-profile:' || v_profile_id, 0));
PERFORM PG_ADVISORY_XACT_LOCK(HASHTEXTEXTENDED('pto-account:' || p_account_id, 0));
```

After locking, canonicalize the profile and re-check decision version/status, CRM activity, involved-center authorization, provider/CRM uniqueness, and one-account-per-center. Stop this step after the common validation path compiles and its authorization/conflict tests pass.

- [ ] **Step 6: Implement the dormant-link database branch**

When the account has no materialized PTO profile, insert its `pto_profile_crm_ids` assignment to the canonical profile, mark the decision linked, increment its version, and write one `pto_account_linked` event keyed by the mutation idempotency key. Do not insert a center membership, email, cycle, or center activation row.

- [ ] **Step 7: Implement the active-profile merge branch**

When the provider/CRM identity already belongs to another materialized profile, call the existing alias merge invariant, re-home discovery decisions to the canonical target, collapse duplicates deterministically, retain one grant per cycle, increment the selected decision version, and audit the linked account plus source/target balances.

- [ ] **Step 8: Create the shared PostgreSQL query type**

Create `postgresTypes.ts`:

```ts
import type { Pool, PoolClient } from 'pg';

export type PtoQueryable = Pick<Pool | PoolClient, 'query'>;
```

Replace the private `Queryable` declaration in `postgresStore.ts` with this import.

- [ ] **Step 9: Implement focused store previews and mutations**

`postgresLinkStore.ts` owns account DTO mapping, preview SQL, and database-function calls. Export:

```ts
export const createPostgresPtoLinkStore = (db: PtoQueryable) => ({
  previewAccountLink,
  linkAccount,
  previewAccountUnlink,
  unlinkAccount,
  assignAdjustmentProvenance
});
```

Compose the returned methods into `createStore`; do not duplicate query interfaces.

- [ ] **Step 10: Add service transaction wrappers**

Wrap link mutation in `store.runInTransaction`; preview remains read-only.

- [ ] **Step 11: Run focused tests**

Run:

```powershell
node --test --import tsx server/tests/ptoService.test.ts
$env:RUN_PTO_POSTGRES_TESTS='1'; node --test --import tsx --test-name-pattern="account link|dormant link|link conflict" server/tests/ptoAdminMigration.integration.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 12: Detect impact and commit**

Run GitNexus `detect_changes({"scope":"all","repo":"TCTimecard"})`, review canonical profile and entitlement flows, then:

```powershell
git add server/services/pto/postgresTypes.ts server/services/pto/postgresLinkStore.ts server/services/pto/contracts.ts server/services/pto/postgresStore.ts server/services/pto/service.ts server/tests/ptoAdminMigration.integration.test.ts server/tests/ptoService.test.ts server/db/migrations/0013_persistent_pto_profile_links.sql
git commit -m "feat: link discovered PTO accounts transactionally"
```

---

### Task 5: Implement History-Preserving Opt-Out and Adjustment Provenance

**Files:**
- Modify: `server/db/migrations/0013_persistent_pto_profile_links.sql`
- Modify: `server/services/pto/contracts.ts`
- Modify: `server/services/pto/postgresLinkStore.ts`
- Modify: `server/services/pto/postgresStore.ts`
- Modify: `server/services/pto/service.ts`
- Test: `server/tests/ptoAdminMigration.integration.test.ts`
- Test: `server/tests/ptoService.test.ts`

**Interfaces:**
- Produces `previewAccountUnlink` and `unlinkAccount` using the Task 4 types.
- Extends `AdjustPtoBalanceInput` with required `membershipId: Id`.
- Produces `assignAdjustmentProvenance(input)` for legacy adjustment reconciliation.

- [ ] **Step 1: Run required impact analyses**

Run GitNexus upstream impact for `createPostgresPtoStore`, `createPtoService`, and the existing `detachMembership` store contract before modifying their behavior.

- [ ] **Step 2: Write failing tests for provenance and split previews**

Update adjustment tests to require a membership belonging to the canonical group. Add integration tests proving:

- new adjustments write `source_membership_id`;
- unlink preview lists legacy null-provenance adjustment ledger IDs;
- confirmation fails with `PTO_SPLIT_RECONCILIATION_REQUIRED` while any remain;
- provenance may be assigned only by an involved-center admin and only to a membership in the group.

- [ ] **Step 3: Write the three-center split test**

Create one canonical group with Centers 1, 2, and 3. Add reserved and consumed allocations plus a Center 3 adjustment. Unlink Center 3 and assert:

```ts
assert.deepEqual(centerOneView.memberships.map((item) => Number(item.franchiseid)).sort(), [1, 2]);
assert.deepEqual(centerThreeView.memberships.map((item) => Number(item.franchiseid)), [3]);
assert.equal(centerOneView.balance.grantedDays, 5);
assert.equal(centerThreeView.balance.grantedDays, 5);
assert.equal(centerThreeView.balance.reservedDays, centerThreeReservedBefore);
assert.equal(centerThreeView.balance.balanceDays, 5 + centerThreeAdjustment - centerThreeUsed);
```

Also assert the old pool contains compensating release/adjustment entries, the new pool contains reserve/consume entries, and no prior ledger or audit row is deleted.

- [ ] **Step 4: Run focused tests and verify failure**

Run:

```powershell
node --test --import tsx --test-name-pattern="adjustment" server/tests/ptoService.test.ts
$env:RUN_PTO_POSTGRES_TESTS='1'; node --test --import tsx --test-name-pattern="three-center|provenance|opt-out" server/tests/ptoAdminMigration.integration.test.ts
```

Expected: FAIL because provenance and unlink behavior are incomplete.

- [ ] **Step 5: Implement adjustment-provenance assignment**

Add `pto_admin_assign_adjustment_provenance`. Lock the ledger entry and canonical group, require an `adjustment` event with null provenance, authorize the actor through the group, require the selected membership to resolve to that canonical profile, update only `source_membership_id`, and append a `pto_adjustment_provenance_assigned` audit event.

- [ ] **Step 6: Implement the dormant unlink branch**

Add the validation/locking shell of `pto_admin_unlink_account`. For a linked account without an active membership, remove only its dormant `pto_profile_crm_ids` assignment, mark the decision excluded, increment its version, and append `pto_account_excluded`. Do not create a detached profile or entitlement.

- [ ] **Step 7: Implement active split identity and membership movement**

For active membership opt-out, adapt the existing `pto_admin_detach_membership` algorithm to:

1. lock canonical profile, account, membership, cycles, and allocations;
2. reject unresolved legacy adjustments;
3. create the detached confirmed profile;
4. move provider/CRM identity, membership, emails, and decision ownership.

Stop this step after those identity and membership rows point to the correct old/new profiles.

- [ ] **Step 8: Implement compensating balance and allocation movement**

Continue `pto_admin_unlink_account` by creating one grant on each affected cycle, inserting compensating release/adjustment entries on old cycles, repointing allocations, inserting equivalent reserve/consume entries on new cycles, moving membership-attributed adjustments with compensating entries, and writing one `pto_account_split` audit event containing both balance projections. Never delete an existing ledger or audit row.

- [ ] **Step 9: Implement store and service methods**

Keep the old `detachMembership` API operational for compatibility, but route new account-switch opt-outs through `unlinkAccount`. Require `membershipId` when creating new adjustments:

```ts
if (!input.membershipId) throw new RangeError('A source membership is required for PTO adjustments');
```

- [ ] **Step 10: Run integration, service, and type tests**

Run:

```powershell
node --test --import tsx server/tests/ptoService.test.ts
$env:RUN_PTO_POSTGRES_TESTS='1'; node --test --import tsx --test-name-pattern="three-center|provenance|opt-out" server/tests/ptoAdminMigration.integration.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 11: Detect impact and commit**

Run GitNexus `detect_changes({"scope":"all","repo":"TCTimecard"})`, explicitly review PTO balance, reservation, approval, denial, and cancellation processes, then:

```powershell
git add server/db/migrations/0013_persistent_pto_profile_links.sql server/services/pto/contracts.ts server/services/pto/postgresLinkStore.ts server/services/pto/postgresStore.ts server/services/pto/service.ts server/tests/ptoAdminMigration.integration.test.ts server/tests/ptoService.test.ts
git commit -m "feat: split PTO account pools without resetting history"
```

---

### Task 6: Expose Typed Admin Link APIs and Stable Errors

**Files:**
- Modify: `server/services/pto/index.ts`
- Modify: `server/routes/pto.ts`
- Modify: `server/services/pto/errors.ts`
- Modify: `server/services/pto/postgresStore.ts`
- Test: `server/tests/ptoRoutes.test.ts`
- Test: `server/tests/ptoService.test.ts`

**Interfaces:**
- Produces the four preview/link/unlink routes from the spec.
- Produces adjustment-provenance reconciliation route.
- Extends `PtoAdminProfileDetail` with `accounts: PtoDiscoveredAccount[]` and typed memberships/emails.
- Extends activation preview with `candidateGroups: Array<{ profileId: Id; profileName: string; account: PtoDiscoveredAccount }>` so a disabled candidate center can review its own proposed links before activation.

- [ ] **Step 1: Run required impact analyses**

Run GitNexus upstream impact for `createPtoRouter`, `createPtoService`, `getAdminProfile`, and `mapPtoHttpError`. Report the existing low/medium/high risk before editing.

- [ ] **Step 2: Write failing route tests**

Add dependency fakes and tests for:

```text
POST   /api/pto/admin/profiles/10/accounts/99/link-preview
PUT    /api/pto/admin/profiles/10/accounts/99/link
POST   /api/pto/admin/profiles/10/accounts/99/unlink-preview
DELETE /api/pto/admin/profiles/10/accounts/99/link
PUT    /api/pto/admin/profiles/10/adjustments/55/provenance
```

Assert positive integer IDs, integer `expectedVersion`, UUID-like nonempty idempotency keys, enforced session franchise scope, and exact dependency payloads. Test `PTO_LINK_STALE`, `PTO_ACCOUNT_ALREADY_LINKED`, `PTO_CENTER_ACCOUNT_CONFLICT`, `PTO_LINK_FORBIDDEN`, `PTO_SPLIT_RECONCILIATION_REQUIRED`, and `PTO_DISCOVERY_STALE` mappings.

- [ ] **Step 3: Run route tests and verify failure**

Run:

```powershell
node --test --import tsx server/tests/ptoRoutes.test.ts
```

Expected: FAIL with missing dependency properties/routes/error codes.

- [ ] **Step 4: Add route dependencies and exports**

Extend `PtoRouteDeps` and `server/services/pto/index.ts` with exact service methods. Validate bodies before calling the service. For `PUT`/`DELETE`, call `apiFetch` semantics directly rather than the existing POST-only helper on the client in Task 7.

Return:

```ts
{ preview: PtoAccountLinkPreview }
{ result: PtoAccountLinkMutationResult, profile: PtoAdminProfileDetail }
```

After mutation, reload the canonical profile under group-aware authorization so the browser receives the server's authoritative version.

- [ ] **Step 5: Make profile detail typed and group-aware**

Replace `Record<string, unknown>[]` for accounts, memberships, and emails with explicit contracts. `getAdminProfile` must authorize using active linked membership or candidate ownership, mask pending cross-center email data, and include account status/version, CRM/center activity, conflict codes, and last discovery time without returning raw snapshots. Activation preview must return only candidate groups containing an account owned by the requested franchise, which gives that center enough identifiers to call the same preview/confirm endpoints without exposing unrelated groups.

- [ ] **Step 6: Map stable errors and run tests**

Add exact `byCode` entries rather than relying only on regex matching. Run:

```powershell
node --test --import tsx server/tests/ptoRoutes.test.ts server/tests/ptoService.test.ts
npm run typecheck
```

Expected: PASS.

- [ ] **Step 7: Detect impact and commit**

Run GitNexus `detect_changes({"scope":"all","repo":"TCTimecard"})`; verify affected routes are confined to PTO admin/profile flows. Then:

```powershell
git add server/services/pto/index.ts server/routes/pto.ts server/services/pto/errors.ts server/services/pto/postgresStore.ts server/services/pto/contracts.ts server/tests/ptoRoutes.test.ts server/tests/ptoService.test.ts
git commit -m "feat: expose PTO account link management APIs"
```

---

### Task 7: Add Typed Client APIs and Focused Account-Link Components

**Files:**
- Modify: `client/src/lib/api.ts`
- Create: `client/src/pages/admin/pto/PtoAccountLinksPanel.tsx`
- Create: `client/src/pages/admin/pto/PtoLinkPreviewDialog.tsx`
- Create: `client/src/pages/admin/pto/PtoAccountLinksPanel.test.tsx`
- Modify: `client/src/pages/admin/PtoManagementPage.tsx`
- Modify: `client/src/pages/admin/PtoManagementPage.test.tsx`

**Interfaces:**
- Produces typed `previewPtoAccountLink`, `linkPtoAccount`, `previewPtoAccountUnlink`, `unlinkPtoAccount`, and `assignPtoAdjustmentProvenance` client calls.
- `PtoAccountLinksPanel` emits intent only; the page owns networking and refreshed profile state.
- `PtoLinkPreviewDialog` renders the server-calculated preview and confirmation state.

- [ ] **Step 1: Run required impact analyses**

Run GitNexus upstream impact for `PtoManagementPage` and the exported API functions being modified. Stop for HIGH/CRITICAL risk.

- [ ] **Step 2: Replace raw client account types and write failing component tests**

Mirror server contracts:

```ts
export type PtoAccountLinkStatus = 'pending' | 'linked' | 'excluded';

export interface PtoDiscoveredAccount {
  id: string;
  franchiseId: number;
  tutorId: number;
  firstName: string;
  lastName: string;
  displayEmail: string | null;
  crmActive: boolean;
  centerEnabled: boolean;
  membershipId: string | null;
  status: PtoAccountLinkStatus;
  version: number;
  lastSeenAt: string;
  warnings: string[];
}

export interface PtoAccountMutationArgs {
  franchiseId: number;
  profileId: string;
  accountId: string;
  expectedVersion: number;
  idempotencyKey: string;
}
```

Test accessible rows for `Linked`, `Dormant`, `Pending review`, `Excluded`, and `CRM inactive`. Assert pending/excluded switches are off, linked/dormant switches are on, and every switch name includes center and tutor ID.

- [ ] **Step 3: Run component tests and verify failure**

Run:

```powershell
npm run test --prefix client -- --run client/src/pages/admin/pto/PtoAccountLinksPanel.test.tsx
```

Expected: FAIL because the components do not exist.

- [ ] **Step 4: Implement typed client methods**

Use `apiFetch` with explicit methods:

```ts
const accountMutationBody = (args: PtoAccountMutationArgs) => ({
  franchiseId: args.franchiseId,
  expectedVersion: args.expectedVersion,
  idempotencyKey: args.idempotencyKey
});

export const linkPtoAccount = (args: PtoAccountMutationArgs) => apiFetch(
  `/api/pto/admin/profiles/${encodeURIComponent(args.profileId)}/accounts/${encodeURIComponent(args.accountId)}/link`,
  { method: 'PUT', body: JSON.stringify(accountMutationBody(args)) }
);
```

`argsBody` includes `franchiseId`, `expectedVersion`, and `idempotencyKey`. Preview calls include `expectedVersion`; unlink uses `DELETE` with a JSON body supported by `apiFetch`.

- [ ] **Step 5: Implement the account-links panel**

`PtoAccountLinksPanel` sorts active linked, dormant linked, pending, excluded, then inactive. It renders masked emails exactly as returned, never derives masking client-side. Toggling emits `{ mode: 'link' | 'unlink', account }` and does not optimistically change the switch.

- [ ] **Step 6: Implement the preview dialog**

`PtoLinkPreviewDialog` renders before/after balances, affected request count, negative-balance warnings, ambiguous adjustment rows, actor-center notice, and a disabled confirmation button until reconciliation is complete.

- [ ] **Step 7: Integrate into PTO Management**

Replace the old Identity Matches/Detach interaction with the account panel while keeping legacy alias details read-only for audit compatibility. Reuse the same panel inside activation preview for `candidateGroups`, grouped by proposed canonical profile, so a disabled candidate center can decide its own proposed links. On intent:

1. fetch the matching preview;
2. open the dialog;
3. confirm with a generated `crypto.randomUUID()` idempotency key and the preview version;
4. replace `selectedProfile` with the server response;
5. on `PTO_LINK_STALE`, reload the profile and announce the refresh.

Add a membership selector to balance adjustments and include `membershipId` in `adjustAdminPtoBalance`.

- [ ] **Step 8: Expand page tests**

Cover default-off pending rows, remembered excluded rows, dormant links, preview-before-confirm, group-wide action copy, stale refresh, negative balance warning, unresolved adjustment blocking, and successful refreshed profile replacement.

- [ ] **Step 9: Run UI tests, typecheck, and accessibility assertions**

Run:

```powershell
npm run test --prefix client -- --run client/src/pages/admin/pto/PtoAccountLinksPanel.test.tsx client/src/pages/admin/PtoManagementPage.test.tsx
npm run typecheck
```

Expected: PASS with no unlabeled switches/dialog controls.

- [ ] **Step 10: Detect impact and commit**

Run GitNexus `detect_changes({"scope":"all","repo":"TCTimecard"})`, review the PTO management page flow, then:

```powershell
git add client/src/lib/api.ts client/src/pages/admin/pto/PtoAccountLinksPanel.tsx client/src/pages/admin/pto/PtoLinkPreviewDialog.tsx client/src/pages/admin/pto/PtoAccountLinksPanel.test.tsx client/src/pages/admin/PtoManagementPage.tsx client/src/pages/admin/PtoManagementPage.test.tsx
git commit -m "feat: manage remembered PTO account links"
```

---

### Task 8: Surface Discovery Status and Linked Accounts to Admins and Tutors

**Files:**
- Modify: `client/src/lib/api.ts`
- Modify: `client/src/pages/admin/PtoManagementPage.tsx`
- Modify: `client/src/pages/admin/PtoManagementPage.test.tsx`
- Modify: `client/src/pages/tutor/TimeOffPage.tsx`
- Modify: `client/src/pages/tutor/TimeOffPage.test.tsx`
- Test: `server/tests/ptoRouteStore.test.ts`
- Test: `server/tests/ptoRoutes.test.ts`

**Interfaces:**
- Admin activation/sync displays roster and discovery states independently.
- Tutor profile response exposes typed active linked memberships and aliases beneath one balance.
- Existing quote and policy methods keep their external signatures.

- [ ] **Step 1: Run required impact analyses**

Run GitNexus upstream impact for `PtoManagementPage`, `TimeOffPage`, `createPtoRouteStore`, and `createPtoRouter` before editing.

- [ ] **Step 2: Write failing admin/tutor UI tests**

Admin tests assert preview renders discovered, linked/dormant, excluded, and pending-review counts. A disabled candidate center must see only groups containing its own CRM accounts and must be able to open the normal link preview before activation. A discovery error with successful roster sync must show both `Roster synced` and `Discovery failed; last successful ...` rather than a generic sync failure.

Tutor tests return two active memberships and their aliases but assert one balance card, one policy summary, center-grouped aliases, and no dormant account in the eligible list.

- [ ] **Step 3: Write request-resolution regressions**

In `ptoRouteStore.test.ts`, set up two active center memberships whose provider/CRM IDs resolve through one canonical alias. Assert authenticated quotes for both tutor IDs and public quotes for both center-scoped emails return the same profile balance. Also assert dormant/disabled memberships remain unresolved.

- [ ] **Step 4: Run focused tests and verify failure**

Run:

```powershell
node --test --import tsx server/tests/ptoRouteStore.test.ts server/tests/ptoRoutes.test.ts
npm run test --prefix client -- --run client/src/pages/admin/PtoManagementPage.test.tsx client/src/pages/tutor/TimeOffPage.test.tsx
```

Expected: FAIL on missing typed status/account display.

- [ ] **Step 5: Implement admin and tutor presentation**

Extend `PtoCenterStatus`, preview, and sync DTOs with separate roster/discovery timestamps/errors. Render status cards and warnings. On tutor profile detail, return only active linked memberships and active aliases; render them under the existing shared balance without creating additional balance cards.

- [ ] **Step 6: Verify request resolution remains canonical**

Keep `routeStore.ts` unchanged: its active membership, CRM identity, canonical profile, and center predicates are the intended eligibility boundary. The new regression tests must prove discovery decisions alone do not grant eligibility.

- [ ] **Step 7: Run focused tests and typecheck**

Run:

```powershell
node --test --import tsx server/tests/ptoRouteStore.test.ts server/tests/ptoRoutes.test.ts
npm run test --prefix client -- --run client/src/pages/admin/PtoManagementPage.test.tsx client/src/pages/tutor/TimeOffPage.test.tsx
npm run typecheck
```

Expected: PASS.

- [ ] **Step 8: Detect impact and commit**

Run GitNexus `detect_changes({"scope":"all","repo":"TCTimecard"})`, review admin activation and tutor quote flows, then:

```powershell
git add client/src/lib/api.ts client/src/pages/admin/PtoManagementPage.tsx client/src/pages/admin/PtoManagementPage.test.tsx client/src/pages/tutor/TimeOffPage.tsx client/src/pages/tutor/TimeOffPage.test.tsx server/tests/ptoRouteStore.test.ts server/tests/ptoRoutes.test.ts
git commit -m "feat: show PTO discovery and linked account status"
```

---

### Task 9: Backfill Existing Identities and Prove the Full Three-Center Lifecycle

**Files:**
- Modify: `server/db/migrations/0013_persistent_pto_profile_links.sql`
- Modify: `server/tests/ptoMigration.test.ts`
- Modify: `server/tests/ptoAdminMigration.integration.test.ts`
- Modify: `server/tests/ptoMigration.integration.test.ts`

**Interfaces:**
- Migration backfills discovered accounts and decisions without changing canonical balances.
- Produces one executable acceptance test matching the approved three-center scenario.

- [ ] **Step 1: Write failing backfill tests**

Seed legacy memberships, `timecard-center:*` identities, confirmed aliases, rejected match candidates, cycles, ledger activity, emails, and requests before applying `0013`. Assert after migration:

- every parseable center identity has one discovered account;
- every existing active assignment has one linked decision;
- confirmed aliases resolve decisions to the canonical target;
- unambiguous rejected matches become excluded;
- ambiguous rejected records remain available in the legacy table and are not guessed;
- profile balances before and after migration are equal.

- [ ] **Step 2: Run migration integration tests and verify failure**

Run:

```powershell
$env:RUN_PTO_POSTGRES_TESTS='1'; node --test --import tsx --test-name-pattern="backfill|three-center acceptance" server/tests/ptoMigration.integration.test.ts server/tests/ptoAdminMigration.integration.test.ts
```

Expected: FAIL because the backfill/acceptance coverage is incomplete.

- [ ] **Step 3: Implement deterministic backfill SQL**

Parse only providers matching `^timecard-center:[0-9]+$` and numeric CRM IDs. Upsert discovered rows from membership snapshots, seed linked decisions through canonical profile IDs, and use `ON CONFLICT DO NOTHING` for reruns. Translate rejected legacy candidates only when each side resolves to exactly one discovered account; otherwise leave them untouched and write a migration audit summary rather than assigning identity.

- [ ] **Step 4: Add the complete acceptance test**

Automate:

1. Center 1 activation discovers Centers 2 and 3 as pending/off.
2. Center 1 links both while they remain dormant.
3. Centers 2 and 3 activate and reuse one canonical grant.
4. Center 1 authenticated PTO and Center 2 email-alias PTO deduct from that pool.
5. An admin from Center 2 unlinks Center 3.
6. Centers 1 and 2 remain shared; Center 3 owns a separate five-day pool plus its attributable activity.
7. A later sync preserves Center 3 as excluded from the original group.

- [ ] **Step 5: Run all PostgreSQL PTO integration tests**

Run:

```powershell
$env:RUN_PTO_POSTGRES_TESTS='1'; node --test --import tsx server/tests/ptoMigration.integration.test.ts server/tests/ptoAdminMigration.integration.test.ts server/tests/ptoRouteMigration.integration.test.ts
```

Expected: PASS.

- [ ] **Step 6: Detect impact and commit**

Run GitNexus `detect_changes({"scope":"all","repo":"TCTimecard"})`, inspect every affected PTO flow, then:

```powershell
git add server/db/migrations/0013_persistent_pto_profile_links.sql server/tests/ptoMigration.test.ts server/tests/ptoAdminMigration.integration.test.ts server/tests/ptoMigration.integration.test.ts
git commit -m "test: verify persistent PTO links across three centers"
```

---

### Task 10: Update Operations Documentation and Run Full Verification

**Files:**
- Modify: `docs/operations/shared-pto-rollout.md`
- Modify: `docs/pto-public-integration.md`
- Modify: `README.md`

**Interfaces:**
- Produces human-owned deployment, Franchise 68 review, discovery recovery, split reconciliation, rollback, and public-alias guidance.
- Marks this plan as the approved follow-up to the completed original implementation.

- [ ] **Step 1: Verify the completed original plan still points to this follow-up**

Confirm `docs/superpowers/plans/2026-08-16-shared-cross-center-pto.md` links this spec and plan and still keeps Tasks 1–6 checked as baseline implementation history. This pointer is added with the plan-writing commit and should not be rewritten during implementation.

- [ ] **Step 2: Update rollout and public integration procedures**

Document this exact deployment order:

1. backup and name the rollback owner;
2. deploy migration `0013` without activating new centers;
3. run schema preflight;
4. deploy server/client together;
5. sync Franchise 68 and verify roster/discovery timestamps separately;
6. review every default-off candidate;
7. link verified dormant accounts;
8. activate additional centers only after previews reconcile;
9. run authenticated and public alias deductions;
10. test one opt-out preview in a non-production environment.

Include recovery for stale discovery, negative post-link balances, legacy adjustment reconciliation, link conflicts, and center deactivation. State that public aliases remain center-scoped and dormant links are ineligible.

- [ ] **Step 3: Run focused server and client suites**

Run:

```powershell
npm run test:server
npm run test:client-helpers
npm run test:client-ui
```

Expected: PASS.

- [ ] **Step 4: Run full verification**

Run:

```powershell
npm test
npm run typecheck
npm run build
npm run db:check-timeoff-schema
```

Expected: all commands PASS against a database where migration `0013` is applied. Do not apply it to production from the agent session.

- [ ] **Step 5: Review repository-wide impact**

Run GitNexus `detect_changes({"scope":"compare","base_ref":"12529ed","repo":"TCTimecard"})` or the actual branch base chosen at execution time. Review PTO activation, admin management, authenticated quote, public quote, reservation, approval, denial, cancellation, and schema-preflight flows. Investigate any unrelated flow before committing.

- [ ] **Step 6: Commit documentation and final verification**

```powershell
git add docs/operations/shared-pto-rollout.md docs/pto-public-integration.md README.md
git commit -m "docs: roll out persistent PTO profile links"
```

Record the exact verification commands and results in the commit/PR handoff. Do not claim production readiness if PostgreSQL integration tests or schema preflight were skipped.
