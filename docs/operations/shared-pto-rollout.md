# Shared Cross-Center PTO Rollout

Shared PTO is disabled by default for every center. Discovered cross-center accounts are also default-off: discovery proposes candidates, while an explicit remembered `linked` or `excluded` decision determines identity. A dormant linked account does not become PTO-eligible until its own center is activated and its membership is active.

## Deployment order

1. Take the normal PostgreSQL backup/snapshot, record its identifier, and name the human rollback owner.
2. Confirm migrations `0010_shared_pto.sql` through `0012_pto_routes.sql` are already applied, then deploy `0013_persistent_pto_profile_links.sql` with `npm run db:migrate`. Do not activate a new center.
3. Run the read-only compatibility check with `npm run db:check-timeoff-schema`. Stop if discovery tables, decision constraints, provenance, or separate sync-health columns are missing.
4. Deploy the Express and React builds together. Do not mix a new client with an old API or a new API with a pre-`0013` database.
5. Sync Franchise 68. Verify the local roster timestamp succeeds independently from the global discovery timestamp; a discovery warning must not be reported as full discovery success.
6. Review every Franchise 68 candidate. Pending and excluded candidates remain off. Confirm provider/CRM ID, center, tutor ID, name, and masked contact data before changing a decision.
7. Link only verified dormant accounts. Read the server-calculated before/after balance and affected-request preview before confirmation.
8. Activate each additional center only after its activation preview and remembered candidates reconcile. Confirm it joins the stored canonical profile and reuses the existing grant.
9. Run one authenticated deduction and one public, center-scoped email-alias deduction. Verify both affect the same canonical pool without exposing a balance through the public quote response.
10. In a non-production environment, preview one linked-center opt-out. Verify attributable requests, adjustments, emails, and projected balances before cancelling or confirming the test.

Do not apply these migrations to production from an automated agent session. A human operator owns credentials, deployment, and the production change window.

## Candidate and activation review

- **Linked** means the account belongs to the canonical PTO person and its active membership participates in eligibility.
- **Dormant** means the link is remembered but the account’s center or membership is inactive. It contributes no eligibility yet.
- **Pending review** is default-off and requires a preview plus explicit confirmation.
- **Excluded** is a remembered off decision and must survive later discovery and syncs.
- **CRM inactive** cannot be switched on. Resolve the source account state first.

For every activation, reconcile active local tutors, new memberships/profiles, discovered accounts, linked/dormant accounts, exclusions, pending reviews, and the policy summary. A failed local roster read must leave activation unchanged. A successful local roster read with failed global discovery may update local memberships, but must preserve earlier decisions and display the discovery error and last successful discovery time.

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

### Center deactivation

Use **Deactivate PTO** when a center must stop new paid submissions. Deactivation preserves canonical identities, remembered decisions, requests, allocations, ledger history, and audit events. It does not turn dormant links into eligible accounts or delete aliases.

## Reconciliation and monitoring

- Compare active CRM tutor count to active `pto_profile_centers` rows for the pilot center after every sync.
- Compare discovered provider/CRM identities to `pto_discovered_tutor_accounts`, and review `pto_profile_link_decisions` for pending decisions left unattended.
- Review **Audit history** for activation, roster sync, discovery failure, account link/unlink, email, adjustment, provenance, detachment, and deactivation events.
- Investigate `PTO_IDENTITY_UNRESOLVED`, `PTO_EMAIL_AMBIGUOUS`, `PTO_IDENTITY_CONFLICT`, and stable account-link errors before retrying.
- Treat `PTO_INSUFFICIENT_BALANCE` and `PTO_NO_BALANCE` as expected business rejections, not infrastructure failures.
- Reconcile each sampled profile as `granted + adjustments - used - reserved = available` for the active cycle.
- Monitor last successful roster sync and last successful discovery independently. A stale timestamp after its corresponding requested operation is an operational failure.

## Rollback

1. Select **Deactivate PTO** for the affected center. This blocks new paid submissions while preserving profiles, allocations, ledger entries, and audit history.
2. Disable the external center-link row and remove the raw token from the external secret manager.
3. Keep migrations and persistent decisions in place; do not drop PTO tables, delete discovery history, or rewrite the append-only ledger during rollback.
4. If an application rollback is required, deploy the prior server/client build after center deactivation. Existing non-PTO time-off behavior remains available.
5. The named rollback owner decides whether to restore the recorded backup. A restore discards all later time-off writes and therefore requires a separate business approval; it is not the normal application rollback.
6. Re-enable only after the root cause is fixed, migrations and full tests pass, roster and discovery are reconciled independently, every candidate is reviewed again, and a new public quote succeeds.
