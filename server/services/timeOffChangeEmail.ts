import type { NormalizedTimeOffSubmission, TimeOffRecord } from '../types/timeoff';
import type {
  TimeOffAmendment,
  TimeOffChangeActorType,
  TimeOffChangeOperationAction
} from '../types/timeOffChanges';
import type { FranchiseContact } from './franchiseContact';

/** Everything an email needs, frozen when the business change commits. */
export interface TimeOffChangeEmailSnapshot {
  operationId: string;
  action: TimeOffChangeOperationAction;
  actorKind: TimeOffChangeActorType;
  at: string;
  before: TimeOffRecord;
  after: TimeOffRecord;
  amendment: TimeOffAmendment | null;
  supersededAmendment: TimeOffAmendment | null;
  changeReason: string | null;
  decisionReason: string | null;
}

export interface TimeOffChangeEmailJob {
  kind: string;
  recipient: string;
  impersonationSubject: string;
  subject: string;
  text: string;
  html: string;
  operationId: string;
  dedupeKey: string;
}

type Audience = 'center' | 'requester';
type Range = Pick<NormalizedTimeOffSubmission, 'startDate' | 'endDate' | 'partialDay' | 'leaveTime' | 'returnTime' | 'absenceLabel'>;

/**
 * Renders one email per intended recipient for an operation. Proposal emails
 * link to authenticated review only; nothing here claims calendar sync.
 */
export function buildTimeOffChangeEmails(
  snapshot: TimeOffChangeEmailSnapshot,
  center: FranchiseContact | null,
  appOrigin: string
): TimeOffChangeEmailJob[] {
  return audiences(snapshot).map(({ audience, kind }) => {
    const content = render(kind, snapshot, center, appOrigin);
    const recipient = audience === 'center'
      ? (center?.email?.trim() || center?.gmailId?.trim() || '')
      : (snapshot.after.tutorEmail || snapshot.before.tutorEmail || '').trim();
    return {
      kind,
      recipient,
      impersonationSubject: center?.gmailId?.trim() || '',
      ...content,
      operationId: snapshot.operationId,
      dedupeKey: `${snapshot.operationId}:email:${kind}`
    };
  });
}

function audiences(snapshot: TimeOffChangeEmailSnapshot): Array<{ audience: Audience; kind: string }> {
  switch (snapshot.action) {
    case 'propose': return [{ audience: 'center', kind: 'center_change_proposed' }];
    case 'withdraw': return [{ audience: 'center', kind: 'center_change_withdrawn' }];
    case 'expire': return [{ audience: 'center', kind: 'center_change_expired' }];
    case 'approve_amendment': return [{ audience: 'requester', kind: 'requester_change_approved' }];
    case 'deny_amendment': return [{ audience: 'requester', kind: 'requester_change_denied' }];
    case 'admin_edit': return [{ audience: 'requester', kind: 'requester_edited' }];
    case 'cancel':
      return snapshot.actorKind === 'TUTOR'
        ? [{ audience: 'center', kind: 'center_cancelled' }, { audience: 'requester', kind: 'requester_cancel_confirmation' }]
        : [{ audience: 'requester', kind: 'requester_cancelled' }];
  }
}

function render(
  kind: string,
  snapshot: TimeOffChangeEmailSnapshot,
  center: FranchiseContact | null,
  appOrigin: string
): { subject: string; text: string; html: string } {
  const name = snapshot.before.tutorName || `${snapshot.before.firstName} ${snapshot.before.lastName}`.trim() || 'Tutor';
  const centerName = center?.name ?? `Franchise ${snapshot.before.franchiseId}`;
  const current = describe(snapshot.before);
  const proposed = snapshot.amendment ? describe(snapshot.amendment.proposed) : null;
  const now = describe(snapshot.after);
  const adminLink = adminReviewUrl(appOrigin, snapshot);
  const tutorLink = tutorRequestUrl(appOrigin, snapshot.before.id);
  const superseded = snapshot.supersededAmendment
    ? `This change replaces your pending change request for ${describe(snapshot.supersededAmendment.proposed)}.`
    : null;
  const reason = (label: string, value: string | null) => (value ? `${label}: ${value}` : null);
  const footer = [
    '',
    `Recorded ${snapshot.at} (operation ${snapshot.operationId}). This message describes the change at that time; open the request for its current details and calendar status.`
  ];

  const lines: Record<string, { subject: string; body: Array<string | null> }> = {
    center_change_proposed: {
      subject: `Time off change requested: ${name} (${centerName})`,
      body: [
        `${name} requested a change to approved time off. The current approved time off stays in effect until an admin approves this change.`,
        `Current: ${current}`,
        `Proposed: ${proposed}`,
        reason('Change reason', snapshot.changeReason),
        '',
        `Review: ${adminLink}`
      ]
    },
    center_change_withdrawn: {
      subject: `Time off change withdrawn: ${name} (${centerName})`,
      body: [`${name} withdrew a pending change request. The approved time off is unchanged.`, `Approved: ${current}`,
        proposed ? `Withdrawn proposal: ${proposed}` : null, '', `Details: ${adminLink}`]
    },
    center_change_expired: {
      subject: `Time off change expired: ${name} (${centerName})`,
      body: [`A pending change request from ${name} expired before it was reviewed. The approved time off is unchanged.`,
        `Approved: ${current}`, proposed ? `Expired proposal: ${proposed}` : null, '', `Details: ${adminLink}`]
    },
    center_cancelled: {
      subject: `Approved time off cancelled: ${name} (${centerName})`,
      body: [`${name} cancelled approved time off.`, `Cancelled: ${current}`, reason('Reason', snapshot.changeReason),
        snapshot.supersededAmendment ? 'Their pending change request was also closed.' : null, '', `Details: ${adminLink}`]
    },
    requester_change_approved: {
      subject: 'Your time off change was approved',
      body: [`Your change to approved time off was approved.`, `Now: ${now}`, `Previously: ${current}`, '', `Details: ${tutorLink}`]
    },
    requester_change_denied: {
      subject: 'Your time off change was not approved',
      body: [`Your change request was not approved. Your approved time off is unchanged.`, `Approved: ${current}`,
        proposed ? `Requested: ${proposed}` : null, reason('Reason', snapshot.decisionReason), '', `Details: ${tutorLink}`]
    },
    requester_edited: {
      subject: 'Your approved time off was changed',
      body: [`An administrator changed your approved time off.`, `Now: ${now}`, `Previously: ${current}`,
        reason('Reason', snapshot.changeReason), superseded, '', `Details: ${tutorLink}`]
    },
    requester_cancelled: {
      subject: 'Your approved time off was cancelled',
      body: [`An administrator cancelled your approved time off.`, `Cancelled: ${current}`, reason('Reason', snapshot.changeReason),
        snapshot.supersededAmendment ? 'Your pending change request was also closed.' : null, '', `Details: ${tutorLink}`]
    },
    requester_cancel_confirmation: {
      subject: 'You cancelled your approved time off',
      body: [`You cancelled your approved time off.`, `Cancelled: ${current}`, reason('Reason', snapshot.changeReason),
        snapshot.supersededAmendment ? 'Your pending change request was also closed.' : null, '', `Details: ${tutorLink}`]
    }
  };
  const { subject, body } = lines[kind];
  const text = [...body, ...footer].filter((line): line is string => line !== null).join('\n');
  const html = text.split('\n').map((line) => (line ? `<p>${linkify(escapeHtml(line))}</p>` : '')).join('');
  return { subject, text, html };
}

function describe(range: Range): string {
  const dates = range.startDate === range.endDate ? range.startDate : `${range.startDate} through ${range.endDate}`;
  const times = range.partialDay && range.leaveTime && range.returnTime ? ` (${range.leaveTime}–${range.returnTime})` : '';
  return `${dates}${times}, ${range.absenceLabel}`;
}

function adminReviewUrl(appOrigin: string, snapshot: TimeOffChangeEmailSnapshot): string {
  const url = new URL('/admin/approvals', withTrailingSlash(appOrigin));
  url.searchParams.set('tab', 'timeoff');
  url.searchParams.set('franchiseId', String(snapshot.before.franchiseId));
  url.searchParams.set('requestId', String(snapshot.before.id));
  url.searchParams.set('view', 'manage');
  const amendmentId = snapshot.amendment?.id ?? snapshot.supersededAmendment?.id;
  if (amendmentId) url.searchParams.set('amendmentId', amendmentId);
  return url.toString();
}

function tutorRequestUrl(appOrigin: string, requestId: number): string {
  const url = new URL('/tutor/time-off', withTrailingSlash(appOrigin));
  url.searchParams.set('requestId', String(requestId));
  return url.toString();
}

function withTrailingSlash(origin: string): string {
  return origin.endsWith('/') ? origin : `${origin}/`;
}

function linkify(escaped: string): string {
  return escaped.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>');
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
