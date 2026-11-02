# Preserve history when voiding a break

## Intent and authorization

An administrator must be able to remove an existing break from a corrected time
entry even when that break was recorded outside the entry's work date. The user
approved this behavior and requested specification, planning, and execution.

The reported October 26 entry retained an October 27 break after an overnight
clock session was shortened. Remove break correctly preserved the historical
timestamps and requested `status: voided`, but `normalizeCorrection` rejected
those timestamps before saving. The error was reproduced locally.

## Required behavior

- An existing completed or already-voided break submitted as voided with its
  original type, pay treatment, duration, and time window preserves the stored
  timestamps exactly, even outside the corrected date/session or minute grid.
- Equivalent timestamp representations may match, but the stored values are
  authoritative for the preserved result. Notes retain existing validation.
- Voided breaks contribute no paid/unpaid break deductions. Subsequent
  corrections and whole-day void/restore operations retain their voided status.
- Explicitly changing a voided break back to completed requires ordinary date,
  time, duration, and session containment validation, including legacy
  duration-only or outside-session records.
- Existing identity, duplicate, mandatory-child, reason, revision, and preview
  integrity checks remain in force. New or changed break data gets no historical
  preservation exception. Active-break removal keeps its existing behavior.

## Approach

Use a narrow preservation branch in `normalizeCorrection`, after validating the
break's identity and basic fields and comparing it with the existing record.
Keep all retained/restored break validation in the normal path. The existing
editor payload, persistence, audit, and allocation code already support voids.

Alternatives considered: rewriting dates would corrupt history; skipping all
validation for any voided payload would accept fabricated or modified history.
The selected approach implements the previously agreed behavior with one
production file change and regression coverage of preview/save/restoration.

## Constraints and non-goals

- Never query CRM. Never write to Neon. Integration tests use disposable local
  PostgreSQL only; roster and schedule access are injected test fixtures.
- No production data repair, migration, deployment, new restore UI, or changes to
  clock session creation. Preserve unrelated workspace work.
- Use existing TypeScript, node:test, PostgreSQL test helpers, and dependencies.
- GitNexus impact reports HIGH risk: correction preview, operation commit, and
  preserved-entry validation feed correction and whole-day void/restore flows.

## Acceptance evidence

First observe the October 26/27 removal regression fail. Then prove preservation,
zero deductions, repeat corrections, preview-token verification, persisted audit
history, whole-day restore, and strict explicit break restoration. Run the
relevant existing suites and typecheck; obtain an independent review and a
complete GitNexus change analysis before the local commit.
