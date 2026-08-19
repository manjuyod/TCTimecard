# Public PTO Quote Integration

The public time-off form can check shared PTO eligibility through the Time Card API before it submits through its existing bridge workflow. The quote endpoint does not create a request and never returns a profile identifier or raw balance.

## Prerequisites

1. Apply migrations `0010_shared_pto.sql`, `0011_pto_admin_invariants.sql`, and `0012_pto_routes.sql` in order.
2. Activate and successfully sync the center from **Admin → PTO Management**.
3. Provision a distinct high-entropy bearer token for the center. Store only its lowercase SHA-256 hash in `public.time_off_center_links.token_hash`; deliver the raw token through the deployment secret manager.
4. Keep the bearer token on the public form’s server. Browser code must call a same-origin backend proxy rather than embed the center token in JavaScript.

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

Handle these HTTP outcomes without exposing repository or identity details:

- `400`: malformed email, dates, partial-day times, or notice-policy violation.
- `401`: missing, inactive, or unknown center token. Stop submission and alert the integration operator.
- `409`: center disabled, no balance, insufficient balance, or a conflicting PTO state.
- `422`: the center-scoped email does not resolve exactly one active profile, or the request is invalid.
- `500`: generic PTO failure. Treat as retryable; do not submit paid time off without a fresh successful quote.

Never log the raw bearer token, place it in a URL, or return it to the browser. Token rotation is performed by inserting a new hashed link, updating the external secret, confirming successful quotes, and then setting the prior link row to `active = false`.
