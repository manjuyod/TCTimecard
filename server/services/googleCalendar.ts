import { JWT } from 'google-auth-library';
import { DateTime } from 'luxon';

const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

export const resolveCalendarServiceAccountCredentials = (
  env: Record<string, string | undefined> = process.env
): ServiceAccount => {
  const raw = env.GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON;
  if (!raw || !raw.trim()) {
    throw new Error('[google_calendar] GOOGLE_CALENDAR_SERVICE_ACCOUNT_JSON is required for calendar actions');
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error('[google_calendar] GOOGLE_SERVICE_ACCOUNT_JSON must be valid JSON');
  }

  const clientEmail = parsed.client_email;
  const privateKeyRaw = parsed.private_key;

  const privateKey =
    typeof privateKeyRaw === 'string' && privateKeyRaw.includes('\\n') ? privateKeyRaw.replace(/\\n/g, '\n') : privateKeyRaw;

  if (typeof clientEmail !== 'string' || !clientEmail.trim()) {
    throw new Error('[google_calendar] client_email is required in service account json');
  }

  if (typeof privateKey !== 'string' || !privateKey.trim()) {
    throw new Error('[google_calendar] private_key is required in service account json');
  }

  return { client_email: clientEmail.trim(), private_key: privateKey };
};

export interface CalendarClient {
  insertEvent: (calendarId: string, event: Record<string, unknown>) => Promise<{ id: string; htmlLink?: string }>;
  getEvent: (calendarId: string, eventId: string) => Promise<Record<string, unknown>>;
  /** Partial update: omitted fields are kept and `null` clears a field. */
  patchEvent: (calendarId: string, eventId: string, patch: Record<string, unknown>) => Promise<Record<string, unknown>>;
  deleteEvent: (calendarId: string, eventId: string) => Promise<void>;
  /** Proves the subject can read the calendar using only the events scope. */
  assertCalendarAccess: (calendarId: string) => Promise<void>;
}

export type CalendarProviderError = Error & { status?: number; reason?: string };

const CALENDAR_API = 'https://www.googleapis.com/calendar/v3/calendars';
const CALENDAR_REQUEST_TIMEOUT_MS = 10_000;

const calendarEventsUrl = (calendarId: string, eventId?: string) =>
  `${CALENDAR_API}/${encodeURIComponent(calendarId)}/events${eventId ? `/${encodeURIComponent(eventId)}` : ''}`;

const providerError = (operation: string, status: number, body: unknown): CalendarProviderError => {
  const detail = (body as { error?: { message?: string; errors?: Array<{ reason?: string }> } } | null)?.error;
  const error = new Error(
    `Google Calendar ${operation} failed (${status})${detail?.message ? `: ${detail.message}` : ''}`
  ) as CalendarProviderError;
  error.status = status;
  error.reason = detail?.errors?.[0]?.reason;
  return error;
};

const parseJson = (text: string): unknown => {
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return null;
  }
};

/**
 * Patch, delete, and access-probe requests for an authorized calendar subject.
 * Every request carries a 10-second timeout.
 */
export const createCalendarEventTransport = (input: {
  getAccessToken: () => Promise<string>;
  fetch?: typeof fetch;
  timeoutMs?: number;
}): Pick<CalendarClient, 'patchEvent' | 'deleteEvent' | 'assertCalendarAccess'> => {
  const fetchImpl = input.fetch ?? fetch;
  const send = async (operation: string, url: string, init: RequestInit = {}): Promise<unknown> => {
    const accessToken = await input.getAccessToken();
    const response = await fetchImpl(url, {
      ...init,
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {})
      },
      signal: AbortSignal.timeout(input.timeoutMs ?? CALENDAR_REQUEST_TIMEOUT_MS)
    });
    const body = parseJson(await response.text());
    if (!response.ok) throw providerError(operation, response.status, body);
    return body;
  };
  return {
    patchEvent: async (calendarId, eventId, patch) =>
      ((await send('patch', calendarEventsUrl(calendarId, eventId), { method: 'PATCH', body: JSON.stringify(patch) }))
        ?? {}) as Record<string, unknown>,
    deleteEvent: async (calendarId, eventId) => {
      await send('delete', calendarEventsUrl(calendarId, eventId), { method: 'DELETE' });
    },
    assertCalendarAccess: async (calendarId) => {
      await send('access check', `${calendarEventsUrl(calendarId)}?maxResults=1`);
    }
  };
};

export const buildGcalClientForSubject = (subjectEmail: string): CalendarClient => {
  const subject = subjectEmail?.trim();
  if (!subject) {
    throw new Error('Impersonation subject email is required for calendar actions');
  }

  const creds = resolveCalendarServiceAccountCredentials();
  const jwt = new JWT({
    email: creds.client_email,
    key: creds.private_key,
    scopes: [CALENDAR_SCOPE],
    subject
  });

  const insertEvent = async (calendarId: string, event: Record<string, unknown>) => {
    const tokens = await jwt.authorize();
    const accessToken = tokens?.access_token;
    if (!accessToken) {
      throw new Error('Unable to acquire Google access token');
    }

    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(event)
      }
    );

    const text = await response.text();
    let json: Record<string, unknown> | null = null;
    try {
      json = text ? (JSON.parse(text) as Record<string, unknown>) : null;
    } catch (_err) {
      json = null;
    }

    if (!response.ok) {
      const message =
        (json as { error?: { message?: string } } | null)?.error?.message ||
        response.statusText ||
        'Unknown Google Calendar error';
      const error = new Error(`Google Calendar insert failed (${response.status}): ${message}`) as Error & {
        status?: number;
      };
      error.status = response.status;
      throw error;
    }

    return (json ?? {}) as { id: string; htmlLink?: string };
  };

  const getEvent = async (calendarId: string, eventId: string) => {
    const tokens = await jwt.authorize();
    const accessToken = tokens?.access_token;
    if (!accessToken) throw new Error('Unable to acquire Google access token');
    const response = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const text = await response.text();
    const body = parseJson(text);
    if (!response.ok) {
      const error = new Error(`Google Calendar event lookup failed (${response.status})`) as CalendarProviderError;
      error.status = response.status;
      error.reason = (body as { error?: { errors?: Array<{ reason?: string }> } } | null)?.error?.errors?.[0]?.reason;
      throw error;
    }
    return (body ?? {}) as Record<string, unknown>;
  };

  const transport = createCalendarEventTransport({
    getAccessToken: async () => {
      const accessToken = (await jwt.authorize())?.access_token;
      if (!accessToken) throw new Error('Unable to acquire Google access token');
      return accessToken;
    }
  });

  return { insertEvent, getEvent, ...transport };
};

export const buildDeterministicTimeOffEventId = (requestId: number): string => `tctimeoff${requestId.toString(32)}`;

/** Replacement event id for one calendar target version; base32hex like Google requires. */
export const buildRecoveryTimeOffEventId = (requestId: number, targetVersion: string): string =>
  `tctimeoff${requestId.toString(32)}v${BigInt(targetVersion).toString(32)}`;

export const buildTimeOffCalendarEvent = (
  request: import('../types/timeoff').TimeOffCalendarRequest,
  decisionReason: string
): Record<string, unknown> => {
  const requesterName = `${request.firstName} ${request.lastName}`.trim() || `Request ${request.id}`;
  const identity = request.tutorId
    ? `Tutor ID: ${request.tutorId}`
    : `Bridge profile ID: ${request.bridgeProfileId ?? 'unmapped'}`;
  const description = [
    `Requester: ${requesterName}`,
    request.email ? `Email: ${request.email}` : null,
    identity,
    `Franchise ID: ${request.franchiseId}`,
    `Type: ${request.type}`,
    `Absence label: ${request.absenceLabel}`,
    request.reason ? `Request reason: ${request.reason}` : null,
    `Decision reason: ${decisionReason}`,
    `Request ID: ${request.id}`
  ].filter(Boolean);
  const boundaries = request.partialDay
    ? { start: { dateTime: request.startAt }, end: { dateTime: request.endAt } }
    : {
        start: { date: request.startDate },
        end: { date: DateTime.fromISO(request.endDate).plus({ days: 1 }).toISODate() }
      };

  return {
    id: buildDeterministicTimeOffEventId(request.id),
    summary: `TIME OFF: ${requesterName} (${request.absenceLabel})`,
    description: description.join('\n'),
    ...boundaries,
    extendedProperties: {
      private: { timeOffRequestId: String(request.id), franchiseId: String(request.franchiseId) }
    }
  };
};

export const insertOrVerifyTimeOffEvent = async (
  client: Pick<CalendarClient, 'insertEvent' | 'getEvent'>,
  calendarId: string,
  payload: Record<string, unknown>,
  requestId: number,
  franchiseId: number
): Promise<string> => {
  try {
    const inserted = await client.insertEvent(calendarId, payload);
    const insertedId = String(inserted.id ?? '').trim();
    if (!insertedId) throw new Error('Google Calendar did not return an event id');
    return insertedId;
  } catch (error) {
    if ((error as { status?: number }).status !== 409) throw error;
    const eventId = buildDeterministicTimeOffEventId(requestId);
    const existing = await client.getEvent(calendarId, eventId);
    const properties = (existing.extendedProperties as { private?: Record<string, unknown> } | undefined)?.private;
    if (
      String(properties?.timeOffRequestId ?? '') !== String(requestId) ||
      String(properties?.franchiseId ?? '') !== String(franchiseId)
    ) {
      throw new Error(`Existing Google Calendar event ${eventId} does not match time-off request ${requestId}`);
    }
    return String(existing.id ?? eventId);
  }
};

export interface TimeOffForCalendar {
  id: number;
  franchiseId: number;
  tutorId: number;
  startAt: string;
  endAt: string;
  type: string;
  notes: string | null;
}

export interface CalendarTutorIdentity {
  tutorId: number;
  firstName: string;
  lastName: string;
  email: string;
}

export const buildGcalEventPayload = (
  request: TimeOffForCalendar,
  tutorIdentity: CalendarTutorIdentity
): Record<string, unknown> => {
  const tutorName = `${tutorIdentity.firstName} ${tutorIdentity.lastName}`.trim() || `Tutor ${request.tutorId}`;
  const summary = `TIME OFF: ${tutorName} (${request.type})`;

  const start = DateTime.fromISO(request.startAt, { setZone: true });
  const end = DateTime.fromISO(request.endAt, { setZone: true });
  const startDateTime = start.isValid ? start.toISO() : request.startAt;
  const endDateTime = end.isValid ? end.toISO() : request.endAt;

  const descriptionLines = [
    `Tutor: ${tutorName} (ID: ${request.tutorId})`,
    tutorIdentity.email ? `Tutor email: ${tutorIdentity.email}` : null,
    `Franchise ID: ${request.franchiseId}`,
    `Type: ${request.type}`,
    request.notes ? `Notes: ${request.notes}` : null,
    `Request ID: ${request.id}`
  ].filter(Boolean) as string[];

  return {
    summary,
    description: descriptionLines.join('\n'),
    start: { dateTime: startDateTime },
    end: { dateTime: endDateTime }
  };
};
