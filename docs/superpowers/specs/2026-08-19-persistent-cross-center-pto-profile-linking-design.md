# Persistent Cross-Center PTO Profile Linking Design

## Summary

The PTO system must maintain one balance per verified person while allowing the same person to sign in through different tutor accounts and submit through the email aliases attached to those accounts. The current implementation creates PTO profiles only from centers that have already been synchronized and proposes exact-name matches only after both profiles exist. That behavior cannot discover or remember another CRM account before its center activates.

This design adds a persistent discovery registry and explicit per-account link decisions. A sync may discover same-name accounts across all CRM centers, but every new candidate remains unlinked until an involved-center administrator turns it on. The decision is stored by stable CRM identity, survives later roster syncs and center activation, and controls whether authenticated accounts and center-scoped email aliases resolve to one canonical PTO pool.

## Goals

- Discover the other active CRM tutor accounts that may belong to each synchronized tutor, including accounts in centers where PTO is not yet enabled.
- Show one remembered toggle per discovered CRM account and center.
- Default every new candidate to unlinked, even when its normalized name or email matches.
- Never merge people automatically from exact-name or email similarity.
- Let an administrator from any involved center manage any account in the proposed or linked group.
- Reuse a remembered link when another center later activates, avoiding a second entitlement grant.
- Resolve every linked authenticated account and every unambiguous center-scoped email alias to the same canonical balance.
- Allow a center account to opt out later and receive its own pool without resetting or losing its attributable PTO activity.
- Preserve transactional balance invariants, append-only audit history, and disabled-by-default center rollout.

## Non-goals

- Creating a universal identity system for all application features.
- Automatically deciding that same-name, same-email, same-phone, or same-password rows are the same person.
- Activating PTO for a center merely because one of its tutor accounts is linked from another center.
- Allowing a disabled center or dormant membership to submit PTO.
- Supporting more than one linked tutor account from the same center in one canonical pool. If legitimate duplicate accounts emerge, an administrator must keep one linked and leave the others separate until a later design explicitly supports them.
- Replacing the existing PTO ledger, request-allocation lifecycle, policy, or public quote contract.

## Terminology

- **CRM account:** One `dbo.tblTutors` row, identified by `(FranchiseID, ID)` and represented as provider `timecard-center:<FranchiseID>` plus CRM ID `<ID>`.
- **Discovered account:** A durable PostgreSQL snapshot of a CRM account found during local roster sync or global same-name discovery.
- **Candidate:** A possible association between a canonical PTO profile and a discovered CRM account.
- **Linked account:** A CRM account explicitly assigned to a canonical PTO profile.
- **Dormant link:** A remembered linked account whose center is not PTO-enabled or whose membership has not yet been activated by that center's roster sync.
- **Excluded account:** An account explicitly kept outside a proposed canonical group. Exclusion persists across syncs.
- **Canonical profile:** The active PTO profile whose entitlement cycles and ledger represent one verified person, after resolving existing `pto_profile_aliases`.
- **Involved center:** A center with an active linked membership in the canonical group or the center that owns a candidate account being considered for the group.

## Required Behavior

### Safe discovery

The roster service continues to fetch the selected center by `FranchiseID`. It also performs a parameterized, batched query for active CRM rows whose trimmed, case-normalized first and last names match a tutor in the selected roster. Exact name is only a discovery signal.

The discovery query must:

- exclude the source `(FranchiseID, ID)` row from its own candidate list;
- include center ID, tutor ID, name, email, deleted status, and the minimal display metadata approved for the UI;
- avoid password reads and password comparisons;
- avoid one-query-per-tutor behavior;
- treat missing first or last names as non-discoverable and return a warning;
- upsert the latest CRM snapshot by stable account identity;
- mark a previously discovered row inactive when CRM reports it deleted, without erasing its decisions or history.

No discovered row changes a PTO profile, membership, entitlement, email, or request until an administrator confirms a link or the account is already linked.

### Persistent decision states

Every candidate has one of three states:

- `pending`: discovered and never decided; displayed with its switch off and a review badge;
- `linked`: explicitly assigned to the canonical group; displayed with its switch on;
- `excluded`: explicitly kept separate or later opted out; displayed with its switch off and an excluded badge.

Roster and discovery sync may create `pending` candidates and refresh CRM snapshots. They must never change an existing `linked` or `excluded` decision. A decision stores the actor account, actor franchise, timestamp, monotonically increasing version, and before/after state in the audit log.

### Group-wide administration

An administrator may view and change a candidate when the administrator's franchise either:

1. has an active membership in the candidate's canonical group; or
2. owns the candidate CRM account.

Once authorized, that administrator may link or exclude any account displayed in the group, not only the account from the administrator's own center. This intentionally broad permission is acceptable for the initial small-center rollout, but every action requires confirmation and audit attribution.

### Shared pool

A canonical profile receives one entitlement grant per policy cycle, regardless of how many accounts or centers are linked. Authenticated requests from any active linked `(franchiseId, tutorId)` and public requests from any unambiguous active linked `(franchiseId, normalizedEmail)` reserve and consume that canonical pool.

Linking two profiles that already have entitlement cycles keeps a single grant for each cycle and combines non-grant ledger activity. If combined activity produces a negative available balance, the link may complete, the preview and result must warn about the negative balance, and subsequent PTO submissions remain blocked by the existing insufficient-balance invariant.

### Opt-out and split

Turning off a dormant link removes its canonical assignment, records `excluded`, and leaves the account to create its own profile when its center later activates.

Turning off an active membership performs an audited transactional split:

- create a new confirmed PTO profile for the detached person;
- move that center's membership, provider/CRM identity, CRM email, manual membership aliases, and center-scoped request allocations to the new profile;
- create the normal single grant for every affected policy cycle on the new profile;
- reproduce that center's reserved and consumed activity on the new cycles;
- insert compensating entries on the old cycles instead of deleting historical ledger rows;
- preserve the remaining centers on the original canonical profile;
- mark the old group/account decision `excluded` so discovery does not propose it again;
- record both resulting profiles, balances, cycles, memberships, requests, emails, and decision versions in one append-only audit event.

Future manual adjustments must carry `source_membership_id`. The adjustment UI defaults that field to the actor center's membership but allows an authorized group administrator to select another linked membership when the correction belongs there. A split moves adjustments attributed to the detached membership. A legacy adjustment with no reliable membership provenance is listed as ambiguous in the split preview and blocks confirmation until an administrator assigns its provenance or makes an explicit reconciling adjustment.

## Data Model

### `pto_discovered_tutor_accounts`

Add a durable registry containing:

- `id BIGSERIAL PRIMARY KEY`;
- `provider TEXT NOT NULL`;
- `crm_id TEXT NOT NULL`;
- `franchiseid INTEGER NOT NULL`;
- `tutor_id BIGINT NOT NULL`;
- `normalized_first_name TEXT NOT NULL`;
- `normalized_last_name TEXT NOT NULL`;
- `crm_snapshot JSONB NOT NULL`;
- `crm_active BOOLEAN NOT NULL`;
- `first_seen_at TIMESTAMPTZ NOT NULL`;
- `last_seen_at TIMESTAMPTZ NOT NULL`;
- unique `(provider, crm_id)`;
- unique `(franchiseid, tutor_id)`;
- an index on normalized first and last name for administrative reads and backfill verification.

The registry is not a PTO membership and never grants eligibility.

### `pto_profile_link_decisions`

Add a decision table containing:

- `id BIGSERIAL PRIMARY KEY`;
- `profile_id BIGINT NOT NULL REFERENCES pto_profiles(id)`;
- `account_id BIGINT NOT NULL REFERENCES pto_discovered_tutor_accounts(id)`;
- `status TEXT NOT NULL CHECK (status IN ('pending', 'linked', 'excluded'))`;
- `version INTEGER NOT NULL DEFAULT 1`;
- `decided_by TEXT`, `decision_franchiseid INTEGER`, and `decided_at TIMESTAMPTZ`;
- `created_at` and `updated_at` timestamps;
- unique `(profile_id, account_id)`.

All services canonicalize `profile_id` before reads and writes. Existing alias confirmation and new account linking must re-home decision rows to the resulting canonical profile and collapse duplicates deterministically. PostgreSQL enforces that an account has at most one `linked` decision and that one canonical profile has at most one linked account per franchise.

### Existing authoritative identity and membership tables

`pto_profile_crm_ids` remains the authoritative assignment from a CRM account to a PTO identity. A dormant link inserts that assignment before a center membership exists. Its existing provider/CRM uniqueness ensures that one CRM account cannot belong to two pools.

`pto_profile_centers` remains the source of active PTO membership and center eligibility. A dormant assignment is not represented as an active membership. When the account's center later syncs, its provider/CRM assignment causes the membership to attach to the stored canonical profile.

`pto_profile_emails` remains center- and membership-scoped. A dormant candidate snapshot does not become an eligible alias. CRM email activation occurs only when the owning center successfully syncs an active membership.

### Adjustment provenance

Add nullable `source_membership_id` to `pto_ledger_entries`, with a foreign key to `pto_profile_centers(id)`. New adjustment writes require a valid active membership on the canonical profile. Existing rows remain nullable for migration compatibility and are handled by split preview reconciliation.

## Synchronization Flow

### Activation preview

Activation preview reads a fresh local roster and performs read-only discovery. It reports:

- active local tutor count;
- new local membership/profile count;
- discovered remote account count;
- remembered linked/dormant count;
- remembered excluded count;
- pending-review count;
- incomplete-name and discovery-staleness warnings;
- the existing policy summary.

Preview does not persist discovery or decisions and does not open a PostgreSQL write transaction.

### Activation and normal sync

The service reads both local roster data and global discovery data before beginning its PostgreSQL transaction. If the local roster read fails, activation/sync fails without writes. If local roster succeeds but global discovery fails, local membership reconciliation may complete, prior discovery decisions remain unchanged, and the center records a discovery warning and error timestamp rather than reporting full discovery success.

Within the transaction:

1. upsert every local account in the discovery registry;
2. resolve an existing provider/CRM identity through `pto_canonical_profile_id`;
3. create a separate pending profile only when no remembered assignment exists;
4. activate or refresh the local center membership;
5. refresh the membership's CRM email;
6. create the entitlement cycle idempotently;
7. upsert remote discovered accounts and only missing `pending` decisions;
8. preserve all `linked` and `excluded` decisions;
9. deactivate local memberships absent or deleted in the fresh local roster;
10. write separate roster and discovery timestamps plus a complete sync audit event.

### Later-center activation

If Center 1 links a dormant Center 2 account, `pto_profile_crm_ids` stores the assignment immediately while Center 2 remains disabled. When Center 2 later activates, its local sync finds that assignment, creates its membership on the same canonical profile, imports its CRM email for Center 2, and reuses the existing cycle grant.

If Center 2 activated before the decision and therefore already owns a separate PTO profile, turning the candidate on calls the audited alias-merge path. The operation re-homes discovery decisions, retains one grant per cycle, and makes both memberships resolve to the canonical profile.

### CRM changes

Provider and CRM ID, not name or email, preserve a decision. A later name or email change refreshes the registry snapshot and linked membership/email data without dropping the decision. A deleted CRM account becomes inactive, and any active membership is deactivated while historical identity, decisions, requests, ledger entries, and audits remain intact.

## API Design

Extend the admin profile response with typed account rows rather than unstructured records. Each row includes account identity, center, masked or full display fields according to authorization, CRM state, center PTO state, decision status/version, membership state, last discovery time, and conflict/warning codes.

Add these center-scoped admin operations:

- `POST /api/pto/admin/profiles/:profileId/accounts/:accountId/link-preview`
- `PUT /api/pto/admin/profiles/:profileId/accounts/:accountId/link`
- `POST /api/pto/admin/profiles/:profileId/accounts/:accountId/unlink-preview`
- `DELETE /api/pto/admin/profiles/:profileId/accounts/:accountId/link`
- `PUT /api/pto/admin/profiles/:profileId/adjustments/:ledgerEntryId/provenance` for legacy adjustment reconciliation.

Mutation requests include `franchiseId`, `expectedVersion`, and an idempotency key. Link confirmation includes the preview version. Unlink confirmation includes the preview version and any completed legacy-adjustment provenance decisions. Responses return the refreshed canonical profile/group and resulting balance summaries.

Expected errors include:

- `PTO_LINK_STALE` (`409`) when the expected version no longer matches;
- `PTO_ACCOUNT_ALREADY_LINKED` (`409`) when another canonical profile owns the account;
- `PTO_CENTER_ACCOUNT_CONFLICT` (`409`) when the group already has a linked account for that center;
- `PTO_LINK_FORBIDDEN` (`403`) when the actor is not from an involved center;
- `PTO_SPLIT_RECONCILIATION_REQUIRED` (`409`) when legacy adjustments remain ambiguous;
- `PTO_DISCOVERY_STALE` (`409`) when confirmation relies on a no-longer-active or outdated candidate snapshot;
- existing `PTO_EMAIL_AMBIGUOUS`, balance, and center-disabled errors where applicable.

## User Experience

### Admin profile detail

Add an **Accounts and centers** section to PTO profile detail. Sort rows as active linked, dormant linked, pending, excluded, then inactive CRM. Each row shows:

- center name/ID and tutor ID;
- latest CRM name;
- masked email for a pending account viewed from another center and full membership aliases after linking;
- center PTO activation state;
- linked/dormant/pending/excluded/inactive status;
- last successful discovery time;
- a switch and concise explanation.

Pending and excluded switches are off; linked and dormant switches are on. Pending rows include a review badge so default-off and explicitly excluded states are not visually confused.

Link confirmation shows both sides, current memberships, aliases, active requests, current-cycle balances, the resulting single entitlement, and a negative-balance warning when applicable. Unlink confirmation shows the new and remaining profiles, activity that will move, ambiguous adjustments, and projected balances.

Any involved-center administrator may perform the action. The confirmation identifies the administrator's own center and states that the change affects the whole linked group.

### Activation and synchronization UI

Activation preview and sync results show local roster status separately from discovery status. A candidate's own center may review and persist its pending link decisions from the activation preview before enabling PTO; this stores identity decisions but does not create eligibility. A discovery failure is a visible warning with the last successful discovery timestamp. The UI never represents a local roster sync as a successful discovery refresh when the global query failed.

### Tutor view

The tutor sees one shared balance, one policy summary, and a list of active linked centers/accounts. Email aliases are grouped by center and membership. Dormant links are not shown as eligible accounts until their centers activate.

## Concurrency and Invariants

Link and unlink transactions acquire advisory locks for the canonical profile and provider/CRM identity in stable sorted order. Database functions re-check authorization, candidate version, CRM activity, center-account uniqueness, and canonical ownership after locking.

The database must guarantee:

- one provider/CRM identity assignment;
- no more than one linked account per canonical profile and franchise;
- one entitlement grant per canonical person and cycle;
- no mutation of prior audit events;
- idempotent link, unlink, merge, and split retries;
- no partial identity, membership, allocation, email, or ledger movement;
- decision status and authoritative CRM assignment cannot disagree after commit.

Concurrent confirmations return the stored result when the same idempotency key repeats. A different stale decision receives `PTO_LINK_STALE` or `PTO_ACCOUNT_ALREADY_LINKED`, never silent last-write-wins behavior.

## Privacy and Security

Candidate discovery stores only fields required for identity review and later membership synchronization. It never stores or compares CRM passwords. Pending accounts viewed by an administrator from another center display a masked email; the candidate's own center may see its normal CRM contact data. Full email aliases become group-visible only after the account is explicitly linked because they then participate in the shared PTO identity.

Every endpoint remains admin-authenticated and franchise-scoped. Group-wide authorization is enforced again in PostgreSQL so a route or service bug cannot bypass it. Raw CRM snapshots are not returned wholesale to the browser.

## Migration and Backfill

Create additive migration `0013_persistent_pto_profile_links.sql` after `0012_pto_routes.sql`.

The migration and one controlled post-deploy sync must:

1. create the discovery and decision tables, constraints, indexes, functions, and adjustment-provenance column;
2. backfill one discovered account for every existing `timecard-center:*` CRM identity and membership snapshot;
3. seed those active existing assignments as `linked` decisions;
4. translate confirmed `pto_profile_match_candidates` into canonical `linked` decisions;
5. translate rejected candidates into `excluded` decisions when the associated CRM accounts can be identified unambiguously;
6. leave ambiguous legacy candidates unchanged for manual review rather than guessing;
7. preserve every existing profile, alias, entitlement cycle, ledger entry, allocation, request, email, and audit event;
8. validate that each linked decision resolves to exactly one canonical profile and no canonical profile has two linked accounts from one center.

After deployment, run discovery for Franchise 68. Its newly found remote same-name accounts must remain `pending` and off. Administrators review and link verified accounts before activating additional centers.

## Observability and Operations

Track `last_successful_roster_sync_at`, `last_successful_discovery_at`, `last_roster_sync_error`, and `last_discovery_error` independently. Audit events include:

- `pto_account_discovered`;
- `pto_account_linked`;
- `pto_account_excluded`;
- `pto_account_relinked`;
- `pto_account_split`;
- `pto_account_crm_deactivated`;
- `pto_link_conflict`;
- `pto_discovery_failed`.

Operational reconciliation compares active local CRM rows to active memberships and separately compares discovered rows/decisions to the latest discovery snapshot. Rollback disables affected centers and public links but preserves the new registry and audit data; migrations and ledger history are not removed.

## Testing Strategy

### Unit tests

- Batched CRM discovery normalizes names, excludes the source row, ignores deleted rows, and never reads passwords.
- Candidate upserts preserve `linked` and `excluded` decisions.
- DTO and error mapping expose typed statuses without raw snapshots.
- Link and unlink previews calculate the same balances and affected records used by confirmation.

### PostgreSQL migration and integration tests

- Fresh migration and rerun are idempotent.
- Existing memberships and confirmed/rejected aliases backfill correctly.
- A discovered account cannot be linked to two canonical profiles.
- A canonical profile cannot link two accounts from one center.
- Dormant linking stores identity without enabling the center or email.
- Later activation reuses the canonical profile and creates no duplicate grant.
- Linking two active profiles preserves one grant and all non-grant activity.
- Opt-out moves reserved, consumed, released, email, identity, allocation, and attributable adjustment state using compensating ledger entries.
- Legacy adjustment ambiguity blocks split until reconciled.
- Three-center flow leaves Centers 1 and 2 shared while Center 3 receives a separate pool.
- Concurrent link/unlink attempts are deterministic and idempotent.

### Route and authorization tests

- Administrators from any linked center and the candidate's center can manage the group.
- Unrelated centers receive `403`.
- Stale versions and identity/center conflicts receive stable `409` codes.
- Disabled or dormant centers remain ineligible.
- Authenticated accounts and center-scoped email aliases resolve the same canonical pool after activation.

### Client tests

- Pending candidates default off and remain visually distinct from excluded accounts.
- Linked, dormant, excluded, inactive, conflict, and stale states render correctly.
- Link and unlink previews require explicit confirmation.
- Negative merged balance and ambiguous split adjustment warnings are accessible.
- Discovery warnings do not masquerade as roster failures or successes.
- Refresh after a stale mutation shows the server's current decision.

### Full acceptance scenario

1. Activate Center 1 and discover matching accounts in Centers 2 and 3.
2. Verify both candidates are off and no balance is shared.
3. Link Centers 2 and 3 from Center 1 and verify the decisions persist while those centers remain dormant.
4. Activate Centers 2 and 3 and verify all three accounts resolve one grant and one balance.
5. Submit PTO through Center 1's authenticated account and a Center 2 email alias; verify both deduct from the same pool.
6. Opt Center 3 out from any involved-center admin session.
7. Verify Centers 1 and 2 retain their shared pool, Center 3 receives its own pool with its attributable activity, and the excluded decision survives later syncs.

## Documentation Updates

Update the existing shared PTO implementation plan, rollout guide, public integration guide where alias behavior is described, and schema preflight expectations. The rollout guide must include candidate review, broad involved-center authorization, stale discovery recovery, split reconciliation, negative post-merge balances, and Franchise 68 pilot verification.
