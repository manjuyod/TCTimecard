import test from 'node:test';
import assert from 'node:assert/strict';
import {
  pendingEntry,
  correctionInput,
} from './helpers/adminTimeEntryFixtures';
import { revisionForEntry } from '../services/adminTimeEntry/revision';
import {
  previewCorrection,
  previewStatusOperation,
} from '../services/adminTimeEntry/preview';
import { verifyAdminPreviewIntegrity } from '../services/adminTimeEntry/previewToken';
import type {
  AdminEntry,
  PreviewDeps,
} from '../services/adminTimeEntry/contracts';
export const makeDeps = (
  day: AdminEntry | null = pendingEntry(),
): PreviewDeps => {
  const tutor = {
    tutorId: 88,
    displayName: 'Alex Rivera',
    active: true,
    historyOnly: false,
  };
  const detail = {
    franchiseId: 77,
    tutor,
    day,
    timezone: day?.timezone ?? 'America/Los_Angeles',
    workDate: '2026-09-15',
    revision: revisionForEntry(day),
    allowedActions: [],
  };
  return {
    getDetail: async () => detail,
    getById: async () => detail,
    requireActiveTutor: async () => tutor,
    getSchedule: async () => {
      throw new Error('CRM unavailable');
    },
    now: () => new Date('2026-09-16T12:00:00Z'),
    secret: 'local-preview-test-secret',
  };
};
const actor = { accountId: 100, franchiseId: 77 };
test('pending correction reports full newly approved minutes independently from edit delta', async () => {
  const deps = makeDeps();
  const preview = await previewCorrection(
    actor,
    correctionInput({ expectedRevision: revisionForEntry(pendingEntry()) }),
    deps,
  );
  assert.equal(preview.before.recordedPaidMinutes, 180);
  assert.equal(preview.before.approvedMinutes, 0);
  assert.equal(preview.after.recordedPaidMinutes, 195);
  assert.equal(preview.after.approvedMinutes, 195);
  assert.equal(preview.recordedDeltaMinutes, 15);
  assert.equal(preview.approvedDeltaMinutes, 195);
  assert.ok(preview.warnings.some((t) => /schedule.*unavailable/i.test(t)));
});
test('stale revisions and other center are refused before preview', async () => {
  await assert.rejects(
    () => previewCorrection(actor, correctionInput(), makeDeps()),
    { code: 'ENTRY_CHANGED' },
  );
  await assert.rejects(() =>
    previewCorrection(
      { ...actor, franchiseId: 78 },
      correctionInput(),
      makeDeps(),
    ),
  );
});
test('unverified roster blocks only missing creation, not existing corrections', async () => {
  const deps = makeDeps(null);
  deps.requireActiveTutor = async () => {
    throw new Error('CRM unavailable');
  };
  await assert.rejects(
    () =>
      previewCorrection(
        actor,
        correctionInput({
          expectedRevision: 'missing',
          sessions: correctionInput().sessions.map((s) => ({ ...s, id: null })),
        }),
        deps,
      ),
    { code: 'ROSTER_UNAVAILABLE' },
  );
  const existing = makeDeps();
  existing.requireActiveTutor = deps.requireActiveTutor;
  await previewCorrection(
    actor,
    correctionInput({ expectedRevision: revisionForEntry(pendingEntry()) }),
    existing,
  );
});
test('invalid closed approved data may be voided, never restored as valid paid minutes', async () => {
  const bad = pendingEntry({
    status: 'approved',
    sessions: [
      { ...pendingEntry().sessions[0], endAt: '2026-09-15T21:00:00Z' },
    ],
  });
  const preview = await previewStatusOperation(
    'void',
    actor,
    {
      franchiseId: 77,
      dayId: 44,
      expectedRevision: 'bad',
      reason: 'Invalid old entry',
    },
    {
      ...makeDeps(bad),
      getById: async () => ({
        franchiseId: 77,
        tutor: {
          tutorId: 88,
          displayName: 'Alex',
          active: true,
          historyOnly: false,
        },
        day: bad,
        timezone: bad.timezone,
        workDate: bad.workDate,
        revision: 'bad',
        allowedActions: ['void'],
      }),
    },
  );
  assert.equal(preview.before.recordedPaidMinutes, null);
  assert.equal(preview.approvedDeltaMinutes, null);
});
test('preserved paid duration-only break is unpositioned and is not deducted', async () => {
  const day = pendingEntry({
    breaks: [
      {
        id: 11,
        sessionId: 99,
        breakType: 'lunch',
        payTreatment: 'paid',
        status: 'completed',
        source: 'auto_rule',
        startTime: null,
        endTime: null,
        durationMinutes: 30,
        note: null,
        createdAt: '2026-09-16T01:00:00Z',
        updatedAt: '2026-09-16T01:00:00Z',
      },
    ],
  });
  const { sessionId, source, createdAt, updatedAt, ...breakInput } =
    day.breaks[0];
  const preview = await previewCorrection(
    actor,
    correctionInput({
      expectedRevision: revisionForEntry(day),
      breaks: [{ ...breakInput, status: 'completed' }],
    }),
    makeDeps(day),
  );
  assert.equal(preview.after.recordedPaidMinutes, 195);
  assert.ok(
    preview.warnings.some((t) => /unpositioned.*30|30.*unpositioned/i.test(t)),
  );
  assert.equal(
    verifyAdminPreviewIntegrity(preview.previewToken, makeDeps().secret)
      .correction?.breaks[0].durationMinutes,
    30,
  );
});
test('timed legacy break preserved outside edited shift yields 420 paid and -60 scheduled delta', async () => {
  const day = pendingEntry({
    timezone: 'UTC',
    sessions: [
      {
        ...pendingEntry().sessions[0],
        startAt: '2026-09-15T09:00:00Z',
        endAt: '2026-09-15T17:00:00Z',
      },
    ],
    breaks: [
      {
        id: 11,
        sessionId: 99,
        breakType: 'lunch',
        payTreatment: 'unpaid',
        status: 'completed',
        source: 'auto_rule',
        startTime: '2026-09-15T09:00:00Z',
        endTime: '2026-09-15T09:30:00Z',
        durationMinutes: 30,
        note: null,
        createdAt: '2026-09-15T09:00:00Z',
        updatedAt: '2026-09-15T09:30:00Z',
      },
    ],
  });
  const { sessionId, source, createdAt, updatedAt, ...breakInput } =
    day.breaks[0];
  const deps = makeDeps(day);
  deps.getSchedule = async () => ({
    version: 1,
    franchiseId: 77,
    tutorId: 88,
    workDate: day.workDate,
    timezone: 'UTC',
    slotMinutes: 60,
    entries: [],
    intervals: [
      { startAt: '2026-09-15T09:00:00Z', endAt: '2026-09-15T17:00:00Z' },
    ],
  });
  const preview = await previewCorrection(
    actor,
    correctionInput({
      expectedRevision: revisionForEntry(day),
      sessions: [
        {
          id: 99,
          startAt: '2026-09-15T10:00:00Z',
          endAt: '2026-09-15T17:00:00Z',
        },
      ],
      breaks: [{ ...breakInput, status: 'completed' }],
    }),
    deps,
  );
  assert.equal(preview.after.recordedPaidMinutes, 420);
  assert.ok(preview.warnings.some((t) => /30.*outside sessions/i.test(t)));
  const command = verifyAdminPreviewIntegrity(
    preview.previewToken,
    deps.secret,
  );
  const { computeTimeEntryComparisonV2 } = await import(
    '../services/timeEntryComparison'
  );
  const comparison = computeTimeEntryComparisonV2({
    sessions: command.correction!.sessions,
    breaks: command.correction!.breaks,
    snapshotIntervals: [
      { startAt: '2026-09-15T09:00:00Z', endAt: '2026-09-15T17:00:00Z' },
    ],
  });
  assert.ok(comparison.ok);
  assert.equal(comparison.comparison.breaks.outsideSessionMinutes, 30);
  assert.equal(comparison.comparison.scheduled.deltaMinutes, -60);
});
test('active break may be explicitly voided while completing the open session', async () => {
  const day = pendingEntry({
    clockState: 1,
    sessions: [{ ...pendingEntry().sessions[0], endAt: null }],
    breaks: [
      {
        id: 11,
        sessionId: 99,
        breakType: 'lunch',
        payTreatment: 'unpaid',
        status: 'active',
        source: 'employee',
        startTime: '2026-09-15T23:00:00Z',
        endTime: null,
        durationMinutes: 0,
        note: null,
        createdAt: '2026-09-15T23:00:00Z',
        updatedAt: '2026-09-15T23:00:00Z',
      },
    ],
  });
  const preview = await previewCorrection(
    actor,
    correctionInput({
      expectedRevision: revisionForEntry(day),
      breaks: [
        {
          id: 11,
          breakType: 'lunch',
          payTreatment: 'unpaid',
          status: 'voided',
          startTime: null,
          endTime: null,
          durationMinutes: 0,
          note: 'Incorrect active break',
        },
      ],
    }),
    makeDeps(day),
  );
  assert.equal(preview.after.approvedMinutes, 195);
  assert.equal(preview.review.correction!.breaks[0].status, 'voided');
  assert.equal(preview.before.recordedPaidMinutes, null);
  assert.equal(
    preview.before.approvedMinutes,
    0,
    'An incomplete pending day is known to contribute zero approved minutes',
  );
  assert.equal(preview.approvedDeltaMinutes, 195);
});
test('invalid overlapping before data has unknown totals but valid correction remains possible', async () => {
  const day = pendingEntry({
    sessions: [
      ...pendingEntry().sessions,
      {
        ...pendingEntry().sessions[0],
        id: 100,
        startAt: '2026-09-15T23:00:00Z',
      },
    ],
  });
  const preview = await previewCorrection(
    actor,
    correctionInput({ expectedRevision: revisionForEntry(day) }),
    makeDeps(day),
  );
  assert.equal(preview.before.recordedPaidMinutes, null);
  assert.equal(preview.recordedDeltaMinutes, null);
  assert.equal(preview.after.approvedMinutes, 195);
});
test('stored schedule with different interval dates is rejected in favor of successful empty current schedule', async () => {
  const day = pendingEntry({
    scheduleSnapshot: {
      version: 1,
      franchiseId: 77,
      tutorId: 88,
      workDate: '2026-09-15',
      timezone: 'America/Los_Angeles',
      slotMinutes: 60,
      entries: [],
      intervals: [
        { startAt: '2026-09-14T22:00:00Z', endAt: '2026-09-15T01:00:00Z' },
      ],
    },
  });
  const deps = makeDeps(day);
  deps.getSchedule = async () => ({
    version: 1,
    franchiseId: 77,
    tutorId: 88,
    workDate: '2026-09-15',
    timezone: 'America/Los_Angeles',
    slotMinutes: 60,
    entries: [],
    intervals: [],
  });
  const preview = await previewCorrection(
    actor,
    correctionInput({ expectedRevision: revisionForEntry(day) }),
    deps,
  );
  assert.equal(
    verifyAdminPreviewIntegrity(preview.previewToken, deps.secret)
      .scheduleSource,
    'none',
  );
  assert.ok(preview.warnings.some((t) => /no schedule/i.test(t)));
});
test('malformed fetched schedule is unavailable, not a successful empty schedule', async () => {
  const deps = makeDeps();
  deps.getSchedule = async () => ({ unexpected: 'not a schedule' });
  const preview = await previewCorrection(
    actor,
    correctionInput({ expectedRevision: revisionForEntry(pendingEntry()) }),
    deps,
  );
  assert.equal(
    verifyAdminPreviewIntegrity(preview.previewToken, deps.secret)
      .scheduleSource,
    'unavailable',
  );
  assert.ok(preview.warnings.some((t) => /schedule unavailable/i.test(t)));
});
test('void preview is commit-verifiable even when historical schedule snapshot is malformed', async () => {
  const day = pendingEntry({
    status: 'approved',
    scheduleSnapshot: { legacy: 'unparseable' },
  });
  const deps = makeDeps(day);
  const preview = await previewStatusOperation(
    'void',
    actor,
    {
      franchiseId: 77,
      dayId: 44,
      expectedRevision: revisionForEntry(day),
      reason: 'Void erroneous day',
    },
    deps,
  );
  const command = verifyAdminPreviewIntegrity(
    preview.previewToken,
    deps.secret,
  );
  assert.equal(command.action, 'void');
  assert.equal(command.scheduleSnapshot, null);
  assert.deepEqual(preview.review.originalEntry!.scheduleSnapshot, {
    legacy: 'unparseable',
  });
});
