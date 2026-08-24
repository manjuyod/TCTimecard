# Database-Controlled PTO and Linked-Login Eligibility Design

## Goal

Make center-level PTO activation a database-engineer-only operation while allowing a tutor who signs in through any explicitly linked CRM account to view, request, and reserve PTO from one canonical shared pool whenever that profile has at least one active membership at a PTO-enabled center.

The center used for login continues to own the time-off request, notification, and approval workflow. The canonical PTO profile owns the reservation, balance, and final usage.

## Current Production-Like Baseline

The read-only database review on August 23, 2026 found exactly one enabled PTO center:

- Center 68 is enabled and has an activation timestamp.
- No other center has an enabled PTO settings row.

This change must not activate or deactivate any center automatically. Center 68 remains the only enabled center until a database engineer deliberately changes `public.pto_center_settings`.

### Shannon Force acceptance example

Shannon Force has canonical PTO profile `8` with a five-day available balance and these explicitly linked CRM accounts:

| Center | Tutor account | Link state | Center PTO state |
|---|---:|---|---|
| 6 | 1467 | linked | off |
| 11 | 1497 | linked | off |
| 16 | 3487 | linked | off |
| 57 | 3404 | linked | off |
| 60 | 3895 | linked | off |
| 68 | 3937 | linked | enabled |

Only Center 68 currently has an active PTO membership for Shannon. Center 68 therefore sponsors eligibility for the canonical profile without taking ownership of requests submitted through other linked accounts.

When Shannon signs in as tutor `3487` at Center 16:

1. The account resolves to canonical profile `8` through an explicit `linked` decision.
2. Profile `8` qualifies because it has an active membership at enabled Center 68.
3. The tutor UI shows the five-day shared balance and offers Paid Time Off.
4. A one-day request is stored as a Center 16 request owned by tutor `3487`.
5. The insert immediately creates a one-day reservation against profile `8`, changing the pool to four available and one reserved day.
6. Center 16 owns notification and approval.
7. Approval converts the reservation to usage; denial or cancellation releases it.
8. Every other linked authenticated account then observes the same updated canonical balance.

## Activation Authority

The application must not expose center activation or deactivation controls.

- Remove the admin activation preview, activation, and deactivation HTTP routes.
- Remove their client API methods, buttons, dialogs, and activation-preview state.
- An admin may sync a roster only after a database engineer has enabled that center.
- The server must reject sync attempts for an inactive center. A sync cannot create or enable an inactive center settings row.
- The migration for this change must not change the enabled state of any center.
- Database engineers activate or deactivate centers through controlled database operations on `public.pto_center_settings`. The existing activation timestamp invariant remains authoritative.

Application removal is the operational enforcement boundary for this repository. Database-role provisioning and production credentials remain owned by database engineers and deployment operators.

## Hidden-Feature Behavior

An inactive center must not advertise PTO administration.

- Hide PTO Management navigation for an admin whose session center is inactive.
- Hide the Shared PTO settings card for an inactive selected center.
- Direct access to PTO administration for an inactive center must show no activation controls or program data and must return to the normal admin experience.
- Selector-capable admins may administer only a selected center that is already enabled.
- PTO admin data and mutation endpoints must reject inactive-center scope, except for the read-only center status needed to determine visibility.

Tutor visibility uses a deliberate exception:

- An ordinary tutor at an inactive center with no eligible explicit link sees no PTO balance and no Paid Time Off option.
- A tutor at an inactive center whose exact CRM account is explicitly linked to an eligible canonical profile sees and may use the canonical shared pool.
- Pending, excluded, stale, or CRM-inactive discovered accounts never receive the exception.

## Authenticated Eligibility Rule

An authenticated `(franchiseId, tutorId)` is PTO-eligible only when all of the following are true:

1. A stable discovered CRM account exists for provider `timecard-center:<franchiseId>` and the exact tutor ID.
2. The discovered account is CRM-active.
3. An explicit `pto_profile_link_decisions.status = 'linked'` decision connects that account to exactly one canonical profile.
4. The canonical profile is active.
5. The canonical profile has at least one active `pto_profile_centers` membership whose center has `pto_center_settings.enabled = TRUE`.

The authenticated source account does not need a local active PTO membership. This is what permits a dormant linked account such as Center 16 tutor `3487` to use the pool sponsored by Center 68.

All authenticated policy, profile, quote, and reservation paths must use the same database-backed resolver so their decisions cannot drift.

When the resolver fails:

- Return `center_disabled` for an inactive current center so the feature remains hidden.
- Return `identity_unresolved` for an enabled current center whose account does not resolve safely.
- Never fall back to name-only matching, email-only matching, or an unreviewed discovery candidate.

## Request Ownership and Balance Lifecycle

Submitting through a linked account does not rewrite request ownership.

- `time_off_requests.franchiseid` remains the login center.
- `time_off_requests.tutorid` remains the login tutor account.
- The login center receives the notification and owns approval, denial, cancellation visibility, and request history.
- PTO allocations and ledger entries use the canonical profile returned by the authenticated linked-account resolver.

Reservation remains immediate and transactional:

- A pending PTO insert reserves charged days before the insert transaction commits.
- Insufficient balance rejects the request and leaves no request, allocation, or ledger residue.
- Approval moves the allocation from reserved to consumed without a second reduction in available days.
- Denial or cancellation releases the reservation.
- Concurrent linked-account submissions remain protected by the existing database locking and unique idempotency rules.

The disabled-center insert guard and reservation function must be revised so authenticated linked requests use canonical-profile sponsorship rather than the source center's activation state. Public requests continue to require activation of their own center.

## Alias Boundary

All approved aliases attached to a canonical profile share that profile's pool. They do not create separate grants or balances.

Public aliases remain center-scoped:

- A public alias is eligible only through its own active center token, active source membership, and enabled center.
- An email discovered at inactive Center 16 does not expose PTO publicly merely because the corresponding authenticated CRM account is linked.
- Center 68's active aliases continue to resolve Shannon's canonical profile and debit the same shared pool.
- The authenticated linked-login exception does not weaken bearer-token or public-email authorization boundaries.

## Server and Database Design

Add a migration that introduces one canonical authenticated resolver and updates the database guards/functions that admit and reserve authenticated PTO requests.

The resolver returns a canonical profile only for the exact, CRM-active, explicitly linked account with at least one active enabled membership. Server route-store policy, profile, and quote queries use this resolver. Database request guards and reservation logic use the same rule.

Public quote and reservation paths preserve their current source-center activation and alias-membership checks.

Roster synchronization becomes an enabled-center maintenance operation. The application passes no activation flag, and the store verifies that the center was enabled before reading or writing roster state. It updates sync health without changing `enabled`.

## Client Design

The tutor Time Off page retains its existing shared balance card, linked centers, policy summary, quote preview, and request form. No new tutor interaction is necessary; corrected eligibility data makes these elements appear for verified linked logins.

The admin PTO page becomes maintenance-only:

- Describe the program as database-controlled rather than admin-activated.
- Show roster sync, profile management, account linking, adjustments, and audit history only for enabled centers.
- Remove activation previews and deactivation confirmation UI.
- Redirect or suppress the page when the selected center is inactive.

Admin navigation and Settings must not advertise PTO for an inactive session or selected center.

## API Contract Changes

Remove these application-admin operations:

- `GET /api/pto/admin/activation-preview`
- `POST /api/pto/admin/activate`
- `POST /api/pto/admin/deactivate`

Retain `POST /api/pto/admin/sync`, but only for a center already enabled in the database. An inactive-center call returns the stable `PTO_CENTER_DISABLED` response and makes no database or CRM changes beyond the initial read-only authorization/status check.

Tutor endpoints retain their response shapes. Their eligibility semantics change to canonical-profile sponsorship:

- `GET /api/timeoff/policy`
- `GET /api/pto/me`
- `POST /api/pto/me/quote`
- `POST /api/timeoff`

## Error Handling and Safety

- Reject ambiguous or multiply linked identities rather than guessing.
- Reject inactive discovered CRM accounts.
- Reject profiles without any active enabled-center membership.
- Preserve `PTO_INSUFFICIENT_BALANCE`, stale-link, and identity conflict mappings.
- Do not reveal profile identifiers or balances through public quote responses.
- Do not apply the new migration to production automatically; a database engineer owns credentials and the deployment window.
- Do not alter Center 68's current grant, ledger, memberships, aliases, requests, or activation timestamp.

## Testing

Automated coverage must prove:

1. Shannon-like tutor `3487` at inactive Center 16 resolves the canonical profile sponsored by active Center 68.
2. The policy and tutor profile endpoints show the shared balance for that linked login.
3. Paid Time Off is selectable through that login.
4. A pending Center 16 request immediately reserves the canonical pool.
5. Center 16 remains the request owner and approval scope.
6. Approval consumes the reservation once; denial and cancellation release it.
7. Another linked login sees the same updated pool.
8. An inactive center's ordinary, pending, excluded, or CRM-inactive account remains ineligible and sees no PTO feature.
9. Public aliases at inactive centers remain blocked.
10. Public aliases at active centers continue to use the canonical pool without returning balance data.
11. Activation preview, activation, and deactivation routes are unavailable.
12. Inactive-center sync is rejected without mutation.
13. Admin navigation, Settings, and direct PTO management hide inactive centers.
14. Existing Center 68 management, linking, adjustments, audit, quote, request, and lifecycle tests remain green.

## Documentation and Operations

Update the README and shared-PTO rollout documentation to state:

- Activation is database-controlled.
- Center 68 is the only currently enabled center.
- Admins can sync and manage only already-enabled centers.
- Authenticated linked accounts may use a canonical pool sponsored by another active center while their request remains owned by their login center.
- Public aliases remain center-scoped.

## Non-Goals

- Automatically activating discovered centers.
- Granting eligibility from name matching, email matching, or pending discovery alone.
- Moving linked-account requests to the active sponsoring center.
- Enabling public PTO forms or aliases for inactive centers.
- Creating separate balances per account, center, or alias.
- Changing the five-day policy or automatically modifying Shannon Force's current balance.
