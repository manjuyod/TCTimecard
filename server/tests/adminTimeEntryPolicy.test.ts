import test from 'node:test';
import assert from 'node:assert/strict';
import {
  allowedAdminTimeEntryActions,
  normalizeCorrection,
} from '../services/adminTimeEntry/policy';
import { revisionForEntry } from '../services/adminTimeEntry/revision';
import {
  pendingEntry,
  correctionInput,
} from './helpers/adminTimeEntryFixtures';
const context = (day = pendingEntry()) => ({
  day,
  timezone: day.timezone,
  now: new Date('2026-09-16T12:00:00Z'),
});

test('session and break ends may reach the next local midnight but not pass it', () => {
  const input = correctionInput({
    sessions: [{ id: 99, startAt: '2026-09-15T23:00:00-07:00', endAt: '2026-09-16T00:00:00-07:00' }],
    breaks: [{ id: null, breakType: 'rest_break', payTreatment: 'paid', status: 'completed',
      startTime: '2026-09-15T23:45:00-07:00', endTime: '2026-09-16T00:00:00-07:00', durationMinutes: 15, note: null }],
  });
  const result = normalizeCorrection(input, context());
  assert.equal(result.sessions[0].endAt, '2026-09-16T07:00:00.000Z');
  assert.equal(result.breaks[0].endTime, '2026-09-16T07:00:00.000Z');
  assert.throws(() => normalizeCorrection({ ...input, sessions: [{ ...input.sessions[0], endAt: '2026-09-16T00:01:00-07:00' }] }, context()), /within work date/);
  assert.throws(() => normalizeCorrection({ ...input, sessions: [{ ...input.sessions[0], startAt: '2026-09-16T00:00:00-07:00' }] }, context()), /within work date/);
  assert.throws(() => normalizeCorrection(input, { ...context(), now: new Date('2026-09-16T06:59:00Z') }), /future/);
});
test('lifecycle actions allow closed approved corrections but protect denied, voided and in-progress days', () => {
  assert.deepEqual(
    allowedAdminTimeEntryActions(pendingEntry({ status: 'approved' }), false),
    ['correct', 'void'],
  );
  assert.deepEqual(
    allowedAdminTimeEntryActions(pendingEntry({ status: 'voided' }), false),
    ['restore'],
  );
  assert.deepEqual(
    allowedAdminTimeEntryActions(
      pendingEntry({ status: 'approved', clockState: 1 }),
      false,
    ),
    [],
  );
  assert.deepEqual(allowedAdminTimeEntryActions(null, true), ['correct']);
  assert.deepEqual(allowedAdminTimeEntryActions(null, false), []);
  assert.equal(normalizeCorrection(correctionInput(), context(pendingEntry({ status: 'approved' }))).sessions.length, 1);
  const openApproved = pendingEntry({ status: 'approved' });
  openApproved.sessions[0].endAt = null;
  assert.deepEqual(allowedAdminTimeEntryActions(openApproved, false), []);
  assert.throws(() => normalizeCorrection(correctionInput(), context(openApproved)), /state/i);
  assert.throws(() => normalizeCorrection(correctionInput({ reason: '' }), context(pendingEntry({ status: 'approved' }))), /reason/i);
  for (const status of ['denied', 'voided'] as const)
    assert.throws(
      () =>
        normalizeCorrection(
          correctionInput(),
          context(pendingEntry({ status })),
        ),
      /state/i,
    );
});
test('revision covers nullable ends and audit history, ignores ordering and offset formatting', () => {
  const day = pendingEntry();
  assert.notEqual(
    revisionForEntry(day),
    revisionForEntry({
      ...day,
      sessions: [{ ...day.sessions[0], endAt: null }],
    }),
  );
  assert.notEqual(
    revisionForEntry(day),
    revisionForEntry({ ...day, lastAuditId: 2 }),
  );
  assert.equal(
    revisionForEntry(day),
    revisionForEntry({
      ...day,
      sessions: [{ ...day.sessions[0], startAt: '2026-09-15T15:00:00-07:00' }],
    }),
  );
});
test('correction validates end, overlap, local date, minute alignment and future times', () => {
  for (const endAt of [
    '',
    '2026-09-15T21:00:00Z',
    '2026-09-16T01:00:01Z',
    '2026-09-17T01:00:00Z',
    '2026-09-16T08:00:00Z',
  ]) {
    assert.throws(() =>
      normalizeCorrection(
        correctionInput({
          sessions: [{ id: 99, startAt: '2026-09-15T22:00:00Z', endAt }],
        }),
        context(),
      ),
    );
  }
  assert.throws(
    () =>
      normalizeCorrection(
        correctionInput({
          sessions: [
            ...correctionInput().sessions,
            {
              id: null,
              startAt: '2026-09-15T23:00:00Z',
              endAt: '2026-09-16T01:00:00Z',
            },
          ],
        }),
        context(),
      ),
    /overlap/i,
  );
  assert.throws(() =>
    normalizeCorrection(correctionInput({ sessions: [] }), context()),
  );
  for (let count = 1; count <= 20; count++) {
    const sessions = Array.from({ length: count }, (_, i) => ({
      id: null,
      startAt: `2026-09-15T${String(8 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}:00-07:00`,
      endAt: `2026-09-15T${String(8 + Math.floor((i + 1) / 2)).padStart(2, '0')}:${(i + 1) % 2 ? '30' : '00'}:00-07:00`,
    }));
    assert.equal(
      normalizeCorrection(correctionInput({ sessions }), context()).sessions
        .length,
      count,
    );
  }
  assert.throws(() =>
    normalizeCorrection(
      correctionInput({
        sessions: Array(21).fill(correctionInput().sessions[0]),
      }),
      context(),
    ),
  );
});
test('reason and child identity cannot be coerced, duplicated or foreign', () => {
  for (const reason of ['1234', 'x'.repeat(2001)])
    assert.throws(() =>
      normalizeCorrection(correctionInput({ reason }), context()),
    );
  for (const reason of ['12345', 'x'.repeat(2000)])
    assert.equal(
      normalizeCorrection(correctionInput({ reason }), context()).reason,
      reason,
    );
  for (const id of [10, '99', true, 0])
    assert.throws(() =>
      normalizeCorrection(
        correctionInput({
          sessions: [{ ...correctionInput().sessions[0], id: id as number }],
        }),
        context(),
      ),
    );
});
test('break identity preservation, containment, completion and legacy preservation are enforced', () => {
  const day = pendingEntry({
    breaks: [
      {
        id: 11,
        sessionId: 99,
        breakType: 'lunch',
        payTreatment: 'unpaid',
        status: 'completed',
        source: 'auto_rule',
        startTime: '2026-09-15T23:00:00Z',
        endTime: '2026-09-15T23:30:00Z',
        durationMinutes: 30,
        note: null,
        createdAt: '2026-09-15T23:00:00Z',
        updatedAt: '2026-09-15T23:30:00Z',
      },
    ],
  });
  const { sessionId, source, createdAt, updatedAt, ...original } =
    day.breaks[0];
  const b = { ...original, status: 'completed' as const };
  const input = correctionInput({ breaks: [b] });
  assert.equal(normalizeCorrection(input, context(day)).breaks[0].id, 11);
  assert.throws(
    () => normalizeCorrection(correctionInput(), context(day)),
    /every existing break/i,
  );
  for (const breaks of [
    [{ ...b, id: 12 }],
    [b, b],
    [{ ...b, status: 'active' as 'completed' }],
    [
      {
        ...b,
        startTime: '2026-09-15T21:00:00Z',
        endTime: '2026-09-15T21:30:00Z',
      },
    ],
  ])
    assert.throws(() =>
      normalizeCorrection({ ...input, breaks }, context(day)),
    );
  assert.equal(
    normalizeCorrection(
      { ...input, breaks: [{ ...b, status: 'voided' }] },
      context(day),
    ).breaks[0].status,
    'voided',
  );
  assert.throws(
    () =>
      normalizeCorrection(
        {
          ...input,
          breaks: [{ ...b, id: null, startTime: null, endTime: null }],
        },
        context(day),
      ),
    /require start and end/i,
  );
});
test('revision changes for submillisecond persisted timestamps even when JS Date would truncate', () => {
  assert.notEqual(
    revisionForEntry(
      pendingEntry({ updatedAt: '2026-09-16T01:00:00.000001Z' }),
    ),
    revisionForEntry(
      pendingEntry({ updatedAt: '2026-09-16T01:00:00.000002Z' }),
    ),
  );
});
test('DST nonexistent wall times reject but repeated-hour explicit offsets identify different valid instants', () => {
  const spring = {
    day: null,
    timezone: 'America/Los_Angeles',
    now: new Date('2026-11-03T12:00:00Z'),
  };
  assert.throws(
    () =>
      normalizeCorrection(
        correctionInput({
          workDate: '2026-03-08',
          sessions: [
            {
              id: null,
              startAt: '2026-03-08T02:30:00-08:00',
              endAt: '2026-03-08T04:00:00-07:00',
            },
          ],
        }),
        spring,
      ),
    /offset|daylight/i,
  );
  const repeated = normalizeCorrection(
    correctionInput({
      workDate: '2026-11-01',
      sessions: [
        {
          id: null,
          startAt: '2026-11-01T01:15:00-07:00',
          endAt: '2026-11-01T01:45:00-08:00',
        },
      ],
    }),
    spring,
  );
  assert.equal(repeated.sessions[0].startAt, '2026-11-01T08:15:00.000Z');
  assert.equal(repeated.sessions[0].endAt, '2026-11-01T09:45:00.000Z');
});
test('removing a linked segment requires containing reassignment or explicit break void, not silent orphaning', () => {
  const day = pendingEntry({
    breaks: [
      {
        id: 11,
        sessionId: 99,
        breakType: 'lunch',
        payTreatment: 'unpaid',
        status: 'completed',
        source: 'employee',
        startTime: '2026-09-15T23:00:00Z',
        endTime: '2026-09-15T23:30:00Z',
        durationMinutes: 30,
        note: null,
        createdAt: '2026-09-15T23:00:00Z',
        updatedAt: '2026-09-15T23:30:00Z',
      },
    ],
  });
  const { sessionId, source, createdAt, updatedAt, ...original } =
    day.breaks[0];
  const b = { ...original, status: 'completed' as const };
  const unrelated = [
    {
      id: null,
      startAt: '2026-09-16T01:00:00Z',
      endAt: '2026-09-16T02:00:00Z',
    },
  ];
  assert.throws(
    () =>
      normalizeCorrection(
        correctionInput({ sessions: unrelated, breaks: [b] }),
        context(day),
      ),
    /removed.*session|reassign|void/i,
  );
  const legacy = normalizeCorrection(
    correctionInput({
      sessions: [
        {
          id: 99,
          startAt: '2026-09-16T01:00:00Z',
          endAt: '2026-09-16T02:00:00Z',
        },
      ],
      breaks: [b],
    }),
    context(day),
  );
  assert.equal(
    legacy.breaks[0].id,
    11,
    'Same-segment legacy outside break remains preservable',
  );
  assert.equal(
    normalizeCorrection(
      correctionInput({
        sessions: unrelated,
        breaks: [{ ...b, status: 'voided' }],
      }),
      context(day),
    ).breaks[0].status,
    'voided',
  );
  const positioned = {
    ...b,
    startTime: '2026-09-16T01:00:00Z',
    endTime: '2026-09-16T01:30:00Z',
  };
  assert.equal(
    normalizeCorrection(
      correctionInput({ sessions: unrelated, breaks: [positioned] }),
      context(day),
    ).breaks[0].startTime,
    '2026-09-16T01:00:00.000Z',
  );
  const durationOnlyDay = {
    ...day,
    breaks: [{ ...day.breaks[0], startTime: null, endTime: null }],
  };
  assert.throws(
    () =>
      normalizeCorrection(
        correctionInput({
          sessions: unrelated,
          breaks: [{ ...b, startTime: null, endTime: null }],
        }),
        context(durationOnlyDay),
      ),
    /removed.*session|reassign|void/i,
  );
});
