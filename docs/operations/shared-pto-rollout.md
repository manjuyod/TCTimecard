# Shared Cross-Center PTO Rollout

Shared PTO is disabled by default for every center, and only database engineers may change center activation. Center 68 is currently the sole enabled center. Application administrators can sync and maintain enabled centers, but the application has no activation or deactivation route.

Discovered cross-center accounts are also default-off: discovery proposes candidates, while an explicit remembered `linked` or `excluded` decision determines identity. An authenticated exact linked account may use the canonical pool when it is CRM-active and that canonical profile has at least one active membership at any enabled center. The login account's center still owns the request and approval workflow.

## Deployment order

1. Take the normal PostgreSQL backup/snapshot, record its identifier, and name the human rollback owner.
2. Confirm migrations `0010_shared_pto.sql` through `0013_persistent_pto_profile_links.sql` are already applied, then have the database engineer deploy `0014_database_controlled_pto_linked_login.sql`. Do not activate a new center.
3. Run the read-only compatibility check with `npm run db:check-timeoff-schema`. Stop if discovery tables, decision constraints, provenance, or separate sync-health columns are missing.
4. Deploy the Express and React builds together. Do not mix a new client with an old API or a new API with a pre-`0014` database.
5. Read `public.pto_center_settings` and confirm Franchise 68 is the only enabled row. Stop if any other center is enabled.
6. From **Admin → PTO Management** for Franchise 68, sync the roster. Verify the local roster timestamp succeeds independently from the global discovery timestamp; a discovery warning must not be reported as full discovery success.
7. Review every Franchise 68 candidate. Pending and excluded candidates remain off. Confirm provider/CRM ID, center, tutor ID, name, and masked contact data before changing a decision.
8. Link only verified accounts. Read the server-calculated before/after balance and affected-request preview before confirmation.
9. Run one authenticated deduction through a linked inactive-center login. Confirm the request keeps the login center/tutor ownership and immediately reserves the canonical pool sponsored by Center 68.
10. Run one public, Center 68-scoped email-alias deduction. Confirm it affects the same canonical pool without exposing a balance through the public quote response. Confirm an inactive-center public alias is still rejected.
11. In a non-production environment, preview one linked-account opt-out. Verify attributable requests, adjustments, emails, and projected balances before cancelling or confirming the test.

Do not apply these migrations to production from an automated agent session. A human operator owns credentials, deployment, and the production change window.

## Database activation handoff

The database engineer owns the production change window and is the only operator authorized to enable or disable a center. The application must not be granted write access that lets its routes change `pto_center_settings.enabled`.

Before enabling a center, confirm business approval, reconcile its roster and remembered identity decisions in a non-production environment, and record the rollback owner. In the production transaction, upsert the approved center as enabled and let `pto_center_activation_guard` set the immutable first-activation timestamp:

```sql
BEGIN;

INSERT INTO public.pto_center_settings (franchiseid, enabled)
VALUES (:approved_franchise_id, TRUE)
ON CONFLICT (franchiseid) DO UPDATE
SET enabled = EXCLUDED.enabled;

SELECT franchiseid, enabled, first_activated_at
FROM public.pto_center_settings
WHERE enabled
ORDER BY franchiseid;

COMMIT;
```

At present, the verification query must return only Franchise 68. Enabling any additional center is a separate database-engineering change, not an application-admin action. After an approved enablement, an administrator may use **Sync roster** for that center.

## Candidate and eligibility review

- **Linked** means the discovered provider/CRM account belongs to the canonical PTO person. An authenticated linked login is eligible when that account is CRM-active and the canonical profile has an active membership at any enabled center.
- **Sponsor membership** is an active canonical-profile membership whose center is enabled. It makes the pool available to eligible authenticated linked logins; it does not take ownership of their requests.
- **Dormant** means the remembered account cannot currently satisfy linked-login eligibility, for example because the discovered CRM account is inactive or the canonical profile has no active sponsor membership.
- **Pending review** is default-off and requires a preview plus explicit confirmation.
- **Excluded** is a remembered off decision and must survive later discovery and syncs.
- **CRM inactive** cannot be switched on. Resolve the source account state first.

For every enabled-center sync, reconcile active local tutors, memberships/profiles, discovered accounts, linked/dormant accounts, exclusions, pending reviews, and the policy summary. A failed local roster read must leave database activation unchanged. A successful local roster read with failed global discovery may update local memberships, but must preserve earlier decisions and display the discovery error and last successful discovery time.

Spot-check multi-center tutors for one canonical profile, one entitlement grant per cycle, active memberships grouped by center, center-scoped aliases, and `granted + adjustments - used - reserved = available`.

## Recovery and reconciliation

### Stale or failed discovery

- If discovery fails, do not toggle candidates from an old snapshot. Confirm **Roster synced** and **Discovery failed** are shown separately, repair global CRM connectivity, and sync again.
- `PTO_DISCOVERY_STALE` means the account disappeared, became inactive, or no longer matches the reviewed snapshot. Refresh before another decision.
- A stale discovery retry must not reset remembered `linked` or `excluded` decisions.

### Link preview and balance warnings

- `PTO_LINK_STALE` means another administrator changed the decision version. The UI refreshes the authoritative profile; review and preview again.
- `PTO_ACCOUNT_ALREADY_LINKED` means the provider/CRM identity belongs to another canonical group. Investigate that group instead of forcing a merge.
- `PTO_CENTER_ACCOUNT_CONFLICT` means one canonical profile would have more than one linked account for the same center. Resolve the CRM identity conflict first.
- If a link preview produces a negative available balance, verify grants, reservations, consumption, and adjustments across both profiles before confirming. The warning is not a calculation to override manually.

### Legacy adjustment provenance

An unlink preview is blocked when a legacy adjustment has no source membership. In the preview, assign each listed adjustment to the center membership that originated it, then rerun the preview. Do not guess provenance; use payroll/audit records and document the operator’s evidence.

### Database-controlled center disablement

A database engineer disables a center by setting `public.pto_center_settings.enabled = FALSE` in an approved transaction. There is no application control for this operation. Disablement hides that center's admin PTO surfaces and blocks its public aliases immediately. It preserves canonical identities, remembered decisions, requests, allocations, ledger history, and audit events.

Authenticated linked-login eligibility is sponsored by any active membership at any remaining enabled center. Therefore, disabling an inactive login center has no effect on a request already sponsored elsewhere, while disabling the last sponsor center makes every linked login for that canonical profile ineligible for new paid requests.

## Reconciliation and monitoring

- Compare active CRM tutor count to active `pto_profile_centers` rows for the pilot center after every sync.
- Compare discovered provider/CRM identities to `pto_discovered_tutor_accounts`, and review `pto_profile_link_decisions` for pending decisions left unattended.
- Review **Audit history** for roster sync, discovery failure, account link/unlink, email, adjustment, provenance, and detachment events. Database enable/disable changes must also be recorded in the database change ticket.
- Investigate `PTO_IDENTITY_UNRESOLVED`, `PTO_EMAIL_AMBIGUOUS`, `PTO_IDENTITY_CONFLICT`, and stable account-link errors before retrying.
- Treat `PTO_INSUFFICIENT_BALANCE` and `PTO_NO_BALANCE` as expected business rejections, not infrastructure failures.
- Reconcile each sampled profile as `granted + adjustments - used - reserved = available` for the active cycle.
- Monitor last successful roster sync and last successful discovery independently. A stale timestamp after its corresponding requested operation is an operational failure.

## Rollback

1. Have the database engineer set `public.pto_center_settings.enabled = FALSE` for the exact affected franchise in an approved transaction, then verify the enabled-center list. This blocks that center's public PTO and hides its admin PTO surfaces while preserving profiles, allocations, ledger entries, and audit history.
2. Disable the external center-link row and remove the raw token from the external secret manager.
3. Keep migrations and persistent decisions in place; do not drop PTO tables, delete discovery history, or rewrite the append-only ledger during rollback.
4. If an application rollback is required, deploy the prior server/client build after database disablement. Existing non-PTO time-off behavior remains available.
5. The named rollback owner decides whether to restore the recorded backup. A restore discards all later time-off writes and therefore requires a separate business approval; it is not the normal application rollback.
6. Re-enable only through a new database-engineering change after the root cause is fixed, migrations and full tests pass, roster and discovery are reconciled independently, every candidate is reviewed again, and a new public quote succeeds.
