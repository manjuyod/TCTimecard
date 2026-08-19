# Shared Cross-Center PTO Rollout

Shared PTO is disabled by default for every center. Roll out one pilot center at a time; activation is the only step that begins creating memberships and entitlement cycles.

## Deployment order

1. Take the normal PostgreSQL backup/snapshot and confirm a rollback owner.
2. Deploy migrations `0010_shared_pto.sql`, `0011_pto_admin_invariants.sql`, then `0012_pto_routes.sql` with `npm run db:migrate`.
3. Run the read-only compatibility check: `npm run db:check-timeoff-schema`.
4. Deploy the Express and React builds together. Do not activate a center yet.
5. Complete the external form’s [public quote integration](../pto-public-integration.md), provision a center-scoped token, and verify that the raw token is held only by the external server.
6. Confirm authenticated non-PTO time-off submissions and approvals still work.

Do not apply these migrations to production from an automated agent session. A human operator owns credentials, deployment, and the production change window.

## Pilot activation

1. Open **Admin → PTO Management**, apply the pilot franchise ID, and confirm the page says PTO is disabled.
2. Select **Preview activation**. Reconcile active CRM tutor count, new memberships/profiles, pending exact-name matches, and the five-day January 1 policy.
3. Resolve unexpected roster data before continuing. Activation performs a fresh roster read; a failed read must leave the center disabled.
4. Select **Activate and sync** once. Confirm the returned active tutor count and successful-sync timestamp.
5. Review every pending identity match. Confirm only verified same-person matches; reject unrelated exact-name matches.
6. Spot-check tutors who work at multiple centers: one canonical profile, one entitlement grant per cycle, every active membership listed, and no ambiguous email.
7. Submit one authenticated PTO request and one public-form quote. Verify reserve on submission, consume on approval, and release on denial or pending cancellation.

## Reconciliation and monitoring

- Compare active CRM tutor count to active `pto_profile_centers` rows for the pilot center after every sync.
- Review **Audit history** for activation, sync, identity, email, adjustment, detachment, and deactivation events.
- Investigate `PTO_IDENTITY_UNRESOLVED`, `PTO_EMAIL_AMBIGUOUS`, and `PTO_IDENTITY_CONFLICT` before retrying.
- Treat `PTO_INSUFFICIENT_BALANCE` and `PTO_NO_BALANCE` as expected business rejections, not infrastructure failures.
- Reconcile each sampled profile as `granted + adjustments - used - reserved = available` for the active cycle.
- The center settings response exposes first activation and last successful sync timestamps. A stale timestamp after a requested sync is an operational failure.

## Rollback

1. Select **Deactivate PTO** for the affected center. This blocks new paid submissions while preserving profiles, allocations, ledger entries, and audit history.
2. Disable the external center-link row and remove the raw token from the external secret manager.
3. Keep existing migrations and data in place; do not drop PTO tables or rewrite the append-only ledger during rollback.
4. If an application rollback is required, deploy the prior server/client build after center deactivation. Existing non-PTO time-off behavior remains available.
5. Re-enable only after the root cause is fixed, migrations and full tests pass, the roster preview is reconciled again, and a new public quote succeeds.
