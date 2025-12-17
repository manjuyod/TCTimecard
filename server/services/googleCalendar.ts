import { JWT } from 'google-auth-library';
import { DateTime } from 'luxon';

const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar.events';

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

const parseServiceAccount = (): ServiceAccount => {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw || !raw.trim()) {
    throw new Error('[google_calendar] GOOGLE_SERVICE_ACCOUNT_JSON is required for calendar actions');
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
}

export const buildGcalClientForSubject = (subjectEmail: string): CalendarClient => {
  const subject = subjectEmail?.trim();
  if (!subject) {
    throw new Error('Impersonation subject email is required for calendar actions');
  }

  const creds = parseServiceAccount();
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
      throw new Error(`Google Calendar insert failed (${response.status}): ${message}`);
    }

    return (json ?? {}) as { id: string; htmlLink?: string };
  };

  return { insertEvent };
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
