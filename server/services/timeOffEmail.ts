import { JWT } from 'google-auth-library';

export interface TimeOffEmailPayload {
  to: string;
  subject: string;
  text: string;
  html?: string;
  metadata: Record<string, unknown>;
}

export interface AdminApprovalEmailInput {
  to: string;
  requesterName: string;
  requesterEmail: string;
  centerName: string;
  startLabel: string;
  endLabel: string;
  absenceLabel: string;
  reason: string;
  reviewUrl: string;
  approveUrl: string;
  denyUrl: string;
}

export interface RequesterDecisionEmailInput {
  to: string;
  requesterName: string;
  decision: 'approved' | 'denied';
  startLabel: string;
  endLabel: string;
  reason: string;
}

export interface GmailDwdOptions {
  logOnly: boolean;
  dwdSubject: string;
  nowIso?: string;
  serviceAccountJson?: string;
}

export interface GmailDwdResult {
  provider: 'gmail_dwd';
  mode: 'log_only' | 'send';
  sentAt: string;
  payload: TimeOffEmailPayload;
  response?: unknown;
}

const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send';
const GMAIL_SEND_URL = 'https://gmail.googleapis.com/gmail/v1/users/me/messages/send';

export function buildAdminApprovalEmail(input: AdminApprovalEmailInput): TimeOffEmailPayload {
  const subject = `Time Off Request: ${input.requesterName} (${input.centerName})`;
  const text = [
    `Time off request for ${input.requesterName} <${input.requesterEmail}>`,
    `Center: ${input.centerName}`,
    `Dates: ${input.startLabel} through ${input.endLabel}`,
    `Absence: ${input.absenceLabel}`,
    `Reason: ${input.reason}`,
    '',
    `Review: ${input.reviewUrl}`,
    `Approve: ${input.approveUrl}`,
    `Deny: ${input.denyUrl}`
  ].join('\n');

  const html = [
    `<p><strong>Time off request for ${escapeHtml(input.requesterName)}</strong></p>`,
    `<p>${escapeHtml(input.requesterEmail)}</p>`,
    `<ul>`,
    `<li>Center: ${escapeHtml(input.centerName)}</li>`,
    `<li>Dates: ${escapeHtml(input.startLabel)} through ${escapeHtml(input.endLabel)}</li>`,
    `<li>Absence: ${escapeHtml(input.absenceLabel)}</li>`,
    `</ul>`,
    `<p>${escapeHtml(input.reason)}</p>`,
    `<p><a href="${escapeHtml(input.reviewUrl)}">Review</a> | <a href="${escapeHtml(input.approveUrl)}">Approve</a> | <a href="${escapeHtml(input.denyUrl)}">Deny</a></p>`
  ].join('');

  return {
    to: input.to,
    subject,
    text,
    html,
    metadata: {
      kind: 'admin_approval_request',
      requesterName: input.requesterName,
      requesterEmail: input.requesterEmail,
      centerName: input.centerName,
      startLabel: input.startLabel,
      endLabel: input.endLabel,
      absenceLabel: input.absenceLabel,
      reviewUrl: input.reviewUrl,
      approveUrl: input.approveUrl,
      denyUrl: input.denyUrl
    }
  };
}

export function buildRequesterDecisionEmail(input: RequesterDecisionEmailInput): TimeOffEmailPayload {
  const subject = `Time Off Request ${capitalize(input.decision)}`;
  const text = [
    `${input.requesterName},`,
    '',
    `Your time off request for ${input.startLabel} through ${input.endLabel} was ${input.decision}.`,
    `Reason: ${input.reason}`
  ].join('\n');

  return {
    to: input.to,
    subject,
    text,
    html: `<p>${escapeHtml(input.requesterName)},</p><p>Your time off request for ${escapeHtml(input.startLabel)} through ${escapeHtml(input.endLabel)} was <strong>${escapeHtml(input.decision)}</strong>.</p><p>Reason: ${escapeHtml(input.reason)}</p>`,
    metadata: {
      kind: 'requester_decision_notice',
      requesterName: input.requesterName,
      decision: input.decision,
      startLabel: input.startLabel,
      endLabel: input.endLabel
    }
  };
}

export async function sendTimeOffGmailDwd(
  payload: TimeOffEmailPayload,
  options: GmailDwdOptions
): Promise<GmailDwdResult> {
  const sentAt = options.nowIso ?? new Date().toISOString();
  if (options.logOnly) {
    const result: GmailDwdResult = { provider: 'gmail_dwd', mode: 'log_only', sentAt, payload };
    console.log(JSON.stringify(result));
    return result;
  }

  const subject = options.dwdSubject.trim();
  if (!subject) throw new Error('dwdSubject is required when Gmail send is enabled.');
  const credentials = resolveGmailDwdCredentials(process.env, options.serviceAccountJson);
  const auth = new JWT({
    email: credentials.clientEmail,
    key: credentials.privateKey,
    scopes: [GMAIL_SEND_SCOPE],
    subject
  });
  const headers = toRequestHeaders(await auth.getRequestHeaders(GMAIL_SEND_URL));
  const response = await fetch(GMAIL_SEND_URL, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({ raw: buildRawMessage(payload) })
  });
  const responseBody = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(`Gmail DWD send failed: ${response.status} ${JSON.stringify(responseBody)}`);
  }
  return { provider: 'gmail_dwd', mode: 'send', sentAt, payload, response: responseBody };
}

export function resolveGmailDwdCredentials(
  env: Record<string, string | undefined> = process.env,
  overrideJson?: string
): { clientEmail: string; privateKey: string } {
  const raw = overrideJson ?? env.GOOGLE_EMAIL_SERVICE_ACCOUNT_JSON;
  if (!raw?.trim()) throw new Error('GOOGLE_EMAIL_SERVICE_ACCOUNT_JSON is required when Gmail send is enabled.');
  const parsed = JSON.parse(raw) as { client_email?: string; private_key?: string };
  const privateKey = parsed.private_key?.includes('\\n') ? parsed.private_key.replace(/\\n/g, '\n') : parsed.private_key;
  if (!parsed.client_email?.trim() || !privateKey?.trim()) {
    throw new Error('Google email service account JSON must include client_email and private_key.');
  }
  return { clientEmail: parsed.client_email.trim(), privateKey };
}

function buildRawMessage(payload: TimeOffEmailPayload): string {
  const boundary = `timeoff-${Date.now()}`;
  const body = [
    `To: ${payload.to}`,
    `Subject: ${encodeSubject(payload.subject)}`,
    'MIME-Version: 1.0',
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    '',
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    payload.text,
    `--${boundary}`,
    'Content-Type: text/html; charset="UTF-8"',
    '',
    payload.html ?? `<pre>${escapeHtml(payload.text)}</pre>`,
    `--${boundary}--`
  ].join('\r\n');
  return Buffer.from(body, 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function toRequestHeaders(headers: unknown): Record<string, string> {
  if (!headers || typeof headers !== 'object') return {};
  const normalized: Record<string, string> = {};
  const iterable = headers as Iterable<readonly [unknown, unknown]>;
  if (typeof (iterable as { [Symbol.iterator]?: () => IterableIterator<unknown> })[Symbol.iterator] === 'function') {
    for (const [name, value] of iterable) {
      if (typeof name === 'string' && value !== undefined && value !== null) normalized[name] = String(value);
    }
    if (Object.keys(normalized).length > 0) return normalized;
  }
  for (const [name, value] of Object.entries(headers as Record<string, unknown>)) {
    if (value !== undefined && value !== null) normalized[name] = String(value);
  }
  return normalized;
}

function encodeSubject(subject: string): string {
  return `=?UTF-8?B?${Buffer.from(subject, 'utf8').toString('base64')}?=`;
}

function capitalize(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
