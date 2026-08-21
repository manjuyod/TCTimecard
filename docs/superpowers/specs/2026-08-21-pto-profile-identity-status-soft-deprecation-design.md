# PTO Profile Identity Status Soft-Deprecation Design

## Summary

The shared PTO feature currently exposes a profile-level `identityStatus` value with `pending` and `confirmed` states. That value predates the persistent cross-center account-linking model and no longer communicates an actionable or authoritative state. In particular, explicitly reviewing a discovered account does not consistently change the profile-level value, so the UI can continue to show `pending` after administrators have completed the decisions that matter.

This design soft-deprecates profile-level identity status. The application removes it from the new PTO API contracts and from the UI before the feature branch is merged. The underlying `pto_profiles.identity_status` column and its legacy database behavior remain intact for compatibility. The per-account decision states `pending`, `linked`, and `excluded` become the only user-facing identity-review states.

## Goals

- Remove the misleading profile-level pending/confirmed identity state from all user-facing PTO experiences.
- Remove `identityStatus` from the server and client contracts introduced by the shared PTO feature.
- Make per-account link decisions the authoritative, actionable review state.
- Preserve the existing database schema and legacy stored-procedure behavior.
- Avoid a data migration, destructive schema change, or rollout dependency.

## Non-goals

- Dropping or renaming `pto_profiles.identity_status`.
- Rewriting legacy migrations or stored procedures that read or write the column.
- Converting existing pending rows to confirmed rows.
- Changing account discovery, linking, exclusion, unlinking, or split behavior.
- Changing profile eligibility, membership activation, email resolution, balances, entitlement grants, or PTO requests.
- Removing the read-only legacy identity-match records from the admin profile detail.
- Defining a future hard-removal date for the database column.

## Status Semantics

### Authoritative product state

Identity review is represented at the discovered-account level:

- `pending`: the account was discovered and still requires an administrator decision;
- `linked`: the account is explicitly associated with the canonical PTO profile;
- `excluded`: the account was explicitly kept outside that canonical group.

These states remain persistent across roster synchronization and center activation. They continue to drive the account toggle, review badges, linking behavior, and audit history.

Profile activity and PTO eligibility remain separate concerns. They continue to be determined by canonical profile resolution, active center membership, active profile state, center configuration, and the existing eligibility rules. A value in `pto_profiles.identity_status` must not be introduced into those decisions.

### Deprecated legacy state

`pto_profiles.identity_status` remains a valid database field with its existing `pending` and `confirmed` values, but the application treats it as legacy storage rather than product state:

- the UI does not display or interpret it;
- new API response types do not expose it;
- client code does not depend on it;
- no new business rule may use it;
- existing database functions may continue to update it without affecting application behavior.

The column is retained so this change does not rewrite migration history, invalidate deployed schema checks, or disturb legacy alias-resolution behavior.

## API Contract

Remove `identityStatus` from the server `PtoProfileSummary` contract and the corresponding client `PtoProfileSummary` contract. Because `PtoAdminProfileDetail` extends the summary and tutor responses embed the summary, the removal applies transitively to every new response that includes one of those shapes.

The affected response surfaces include:

- `GET /api/pto/me`;
- `GET /api/pto/admin/profiles`;
- `GET /api/pto/admin/profiles/:profileId`;
- account link and unlink mutation responses that embed refreshed admin profile detail.

The profile row mapper must stop serializing `identityStatus`. The normal profile read path does not need to select `identity_status` solely for API construction, although database-only operations may continue reading it where required by retained legacy logic.

This is not a deployed-contract breaking change: these routes and types are part of the unmerged shared PTO feature. No versioned compatibility field, fallback value, or deprecation header is required.

## User Interface

### Admin profile list

Remove the **Identity** column and its pending/confirmed badge. The remaining columns continue to identify the person, show available PTO, and provide the profile-detail action.

### Admin profile detail

Remove the pending/confirmed identity text from the dialog description. The description may continue to show the shared profile ID.

Keep the **Accounts and centers** controls and their account-level `pending`, `linked`, and `excluded` states unchanged. These are the states administrators can review and act upon.

Keep the existing **Identity matches** area as read-only legacy/audit information. Its records provide historical alias-matching evidence and do not restore or imply a profile-level identity status.

### Tutor experience

The tutor experience must not introduce a pending/confirmed profile label. It continues to show PTO eligibility, balance, policy, memberships, and aliases from the existing response fields. Removing `identityStatus` does not change whether a tutor can use PTO.

## Persistence and Compatibility

No database migration is required.

The following remain unchanged:

- the `pto_profiles.identity_status` column;
- its `NOT NULL`, default, and allowed-value constraints;
- schema preflight validation for the retained column;
- legacy migration SQL and stored procedures that set or inspect the value;
- database integration tests that verify retained legacy behavior.

Keeping the column is deliberate rollback protection. Restoring the API field or UI presentation would require an application rollback only; no data repair or schema restoration would be necessary.

New code must not add another profile-level replacement status. If a future workflow needs an additional review state, it must be modeled on the account decision or as a separately designed operational state with an explicit transition owner.

## Error Handling and Observability

This change introduces no new error codes or failure modes. Account decision conflicts, stale versions, authorization errors, and eligibility failures continue to use their existing responses.

No new metrics or audit events are required because no business transition is being added or removed. Existing account-link decision audit events remain the source for determining who reviewed an account, what decision was made, and when it changed.

## Testing Strategy

### Server contract tests

- Assert that a mapped `PtoProfileSummary` contains profile identity, activity, and balance fields but does not contain `identityStatus`.
- Assert that `GET /api/pto/me` omits `identityStatus` from a non-null profile.
- Assert that admin profile list and detail responses omit `identityStatus`.
- Assert that link and unlink responses embedding refreshed profile detail also omit the field.
- Update fixtures and compile-time expectations that currently construct `PtoProfileSummary` with `identityStatus`.

### Client tests

- Assert that the admin profile table has no **Identity** heading and renders no pending/confirmed profile badge.
- Assert that the profile dialog description does not contain a profile identity state.
- Preserve coverage for account-level pending, linked, and excluded presentation and actions.
- Preserve coverage for the read-only legacy identity-match records.
- Update tutor and admin fixtures to match the reduced profile contract.

### Database regression tests

- Keep schema validation coverage for `pto_profiles.identity_status`.
- Keep migration and integration coverage that observes existing pending/confirmed writes.
- Do not add a migration test because this design introduces no schema migration.

### Verification

The implementation must pass the relevant PTO route, service, migration, and client tests, followed by the repository type check and production build.

## Rollout and Rollback

Apply the contract and UI removal on the current shared PTO feature branch before merging it. The application and API therefore enter production without ever publishing profile-level identity status as part of the new feature.

No operator action, backfill, or migration command is required. Existing environments may contain any mixture of `pending` and `confirmed` database values; those values are intentionally ignored by the product surface.

Rollback consists of restoring the server/client contract field, mapper output, and UI presentation. The retained database column supplies the legacy values, so rollback does not require reconstructing data.

## Acceptance Criteria

- Users never see a profile-level pending or confirmed identity state.
- New PTO API responses never include `identityStatus` in a profile summary or detail.
- Client and server types compile without a profile-level `identityStatus` property.
- Administrators still see and manage account-level `pending`, `linked`, and `excluded` states.
- Read-only legacy identity-match records remain available.
- PTO eligibility, balances, memberships, account linking, alias handling, and audit behavior are unchanged.
- `pto_profiles.identity_status` and its legacy database behavior remain intact.
- Deployment requires no new database migration.

## Rejected Alternatives

### Promote a profile to confirmed after explicit account review

This would preserve a profile-level status but still leave its meaning ambiguous: a profile may have several accounts, each with an independent decision. A single confirmed flag cannot accurately summarize that group.

### Derive confirmation from active membership

Membership activation indicates PTO eligibility for an account and center, not that every discovered identity relationship was reviewed. Reusing it as identity confirmation would combine separate concerns.

### Remove the database column immediately

A hard removal would require a migration and changes to retained SQL paths without providing user-visible value. Soft deprecation removes the misleading contract now while preserving a safe, independently planned hard-removal option later.
