# Public PTO Quote Integration

The public time-off form can check shared PTO eligibility through the Time Card API before it submits through its existing bridge workflow. The quote endpoint does not create a request and never returns a profile identifier or raw balance.

## Prerequisites

1. Apply migrations `0010_shared_pto.sql` through `0013_persistent_pto_profile_links.sql` in order.
2. Activate and successfully sync the center from **Admin → PTO Management**.
3. Provision a distinct high-entropy bearer token for the center. Store only its lowercase SHA-256 hash in `public.time_off_center_links.token_hash`; deliver the raw token through the deployment secret manager.
4. Keep the bearer token on the public form’s server. Browser code must call a same-origin backend proxy rather than embed the center token in JavaScript.

## Center-scoped identity and eligibility

Public email aliases remain center-scoped. A Center 2 token can resolve only an active Center 2 alias backed by an active Center 2 membership; it cannot use the same person’s Center 1 or Center 3 email. Linking accounts shares the canonical PTO pool, not the public authorization boundary.

A remembered dormant link is ineligible until its center is activated and its CRM membership is active. Pending and excluded accounts are also ineligible. Discovery alone never grants public-form access. After activation, `GET /api/pto/me` may show the tutor’s active linked centers and aliases, but the public quote continues to return no profile ID or balance.

## Quote request

`POST /api/pto/public/quote`

Headers:

```http
Authorization: Bearer <center-token>
Content-Type: application/json
```

Full-day body:

```json
{
  "email": "tutor@example.com",
  "startDate": "2026-12-31",
  "endDate": "2027-01-02",
  "partialDay": false
}
```

Partial-day requests also send `leaveTime` and `returnTime` as local `HH:mm` values. Dates are interpreted in the authorized center’s configured timezone and are subject to its notice policy.

An eligible response is deliberately balance-free:

```json
{
  "eligible": true,
  "reason": "eligible",
  "chargeDays": 1.5,
  "cycleAllocations": [
    { "cycleStart": "2026-01-01", "days": 1 },
    { "cycleStart": "2027-01-01", "days": 0.5 }
  ]
}
```

An ineligible identity or balance returns the same shape with `eligible: false` and one of:

- `center_disabled`
- `identity_unresolved`
- `no_balance`
- `insufficient_balance`
- `invalid_request`

The public form should hide or disable its paid option when `eligible` is false, show a generic explanation, and leave unpaid/other request types available. It must not infer or display a balance from repeated quotes.

## Submission and errors

The quote endpoint is a preflight only. After an eligible quote, the public system continues through its existing time-off bridge submission path. The PostgreSQL reservation trigger remains authoritative and can reject a race between quote and submission.

For rollout verification, quote with the alias owned by the token’s center, submit through the bridge, approve the request, and confirm the deduction appears once in the shared canonical pool. Repeat with a different active linked center only using that center’s own token and alias. A dormant linked center must continue to return `identity_unresolved` until activation.

Handle these HTTP outcomes without exposing repository or identity details:

- `400`: malformed email, dates, partial-day times, or notice-policy violation.
- `401`: missing, inactive, or unknown center token. Stop submission and alert the integration operator.
- `409`: center disabled, no balance, insufficient balance, or a conflicting PTO state.
- `422`: the center-scoped email does not resolve exactly one active profile, or the request is invalid.
- `500`: generic PTO failure. Treat as retryable; do not submit paid time off without a fresh successful quote.

Never log the raw bearer token, place it in a URL, or return it to the browser. Token rotation is performed by inserting a new hashed link, updating the external secret, confirming successful quotes, and then setting the prior link row to `active = false`.

If a center is deactivated, its public aliases become ineligible immediately even though identity decisions and historical email rows remain. Disable its hashed center-link row as part of the rollback procedure; do not delete canonical profiles or alias history.
