import type { CalendarClient } from '../../services/googleCalendar';

type ProviderError = Error & { status?: number; reason?: string };
const providerError = (status: number, message: string, reason?: string): ProviderError =>
  Object.assign(new Error(`Google Calendar ${message} (${status})`), { status, reason });

/** In-memory Google Calendar with the provider behaviors the delivery worker relies on. */
export class FakeCalendar implements CalendarClient {
  readonly events = new Map<string, Record<string, unknown>>();
  readonly deleted = new Set<string>();
  readonly calls: Array<{ method: string; calendarId: string; eventId?: string }> = [];
  accessible = true;
  /** Optional hook invoked after a provider mutation succeeds (e.g. to simulate a crash). */
  afterMutation?: (method: string, eventId: string) => Promise<void> | void;
  /** Queue of failures injected before the next calls, by method. */
  readonly failures: Array<{ method: string; status: number; reason?: string }> = [];

  private key(calendarId: string, eventId: string) {
    return `${calendarId}/${eventId}`;
  }

  private injected(method: string) {
    const index = this.failures.findIndex((failure) => failure.method === method);
    if (index < 0) return;
    const [failure] = this.failures.splice(index, 1);
    throw providerError(failure.status, `${method} failed`, failure.reason);
  }

  seed(calendarId: string, event: Record<string, unknown>) {
    this.events.set(this.key(calendarId, String(event.id)), structuredClone(event));
  }

  get(calendarId: string, eventId: string): Record<string, unknown> | undefined {
    return this.events.get(this.key(calendarId, eventId));
  }

  count(method: string, eventId?: string) {
    return this.calls.filter((call) => call.method === method && (eventId === undefined || call.eventId === eventId)).length;
  }

  insertEvent = async (calendarId: string, event: Record<string, unknown>) => {
    const eventId = String(event.id ?? `generated${this.events.size + 1}`);
    this.calls.push({ method: 'insert', calendarId, eventId });
    this.injected('insert');
    const key = this.key(calendarId, eventId);
    if (this.events.has(key) || this.deleted.has(key)) throw providerError(409, 'insert conflict');
    this.events.set(key, structuredClone({ ...event, id: eventId, status: 'confirmed' }));
    await this.afterMutation?.('insert', eventId);
    return { id: eventId };
  };

  getEvent = async (calendarId: string, eventId: string) => {
    this.calls.push({ method: 'get', calendarId, eventId });
    this.injected('get');
    const key = this.key(calendarId, eventId);
    if (this.deleted.has(key)) throw providerError(410, 'event deleted');
    const event = this.events.get(key);
    if (!event) throw providerError(404, 'event not found');
    return structuredClone(event);
  };

  patchEvent = async (calendarId: string, eventId: string, patch: Record<string, unknown>) => {
    this.calls.push({ method: 'patch', calendarId, eventId });
    this.injected('patch');
    const key = this.key(calendarId, eventId);
    if (this.deleted.has(key)) throw providerError(410, 'event deleted');
    const event = this.events.get(key);
    if (!event) throw providerError(404, 'event not found');
    const merged = mergePatch(event, patch);
    this.events.set(key, merged);
    await this.afterMutation?.('patch', eventId);
    return structuredClone(merged);
  };

  deleteEvent = async (calendarId: string, eventId: string) => {
    this.calls.push({ method: 'delete', calendarId, eventId });
    this.injected('delete');
    const key = this.key(calendarId, eventId);
    if (this.deleted.has(key)) throw providerError(410, 'event deleted');
    if (!this.events.has(key)) throw providerError(404, 'event not found');
    this.events.delete(key);
    this.deleted.add(key);
    await this.afterMutation?.('delete', eventId);
  };

  assertCalendarAccess = async (calendarId: string) => {
    this.calls.push({ method: 'probe', calendarId });
    if (!this.accessible) throw providerError(404, 'calendar not found');
  };
}

/** Google patch semantics: nested objects merge, `null` clears a field. */
function mergePatch(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = structuredClone(target);
  for (const [field, value] of Object.entries(patch)) {
    if (value === null) {
      delete result[field];
    } else if (value && typeof value === 'object' && !Array.isArray(value)
      && result[field] && typeof result[field] === 'object' && !Array.isArray(result[field])) {
      result[field] = mergePatch(result[field] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      result[field] = structuredClone(value);
    }
  }
  return result;
}
