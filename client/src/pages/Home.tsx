import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';

type TimeOffRequest = {
  id: number;
  startAt: string;
  endAt: string;
  type: string;
  notes: string | null;
  status: string;
  createdAt: string;
  decidedAt?: string | null;
  decisionReason?: string | null;
  googleCalendarEventId?: string | null;
  tutorId?: number;
  tutorName?: string;
  tutorEmail?: string;
};

const toIsoWithOffset = (value: string): string | null => {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
};

const formatDateTime = (iso: string | null | undefined): string => {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString();
};

const statusLabel = (status: string): string => {
  switch (status) {
    case 'approved':
      return 'Approved';
    case 'denied':
      return 'Denied';
    case 'cancelled':
      return 'Cancelled';
    default:
      return 'Pending';
  }
};

const StatusPill = ({ status }: { status: string }): JSX.Element => {
  const tone = useMemo(() => {
    const normalized = status.toLowerCase();
    if (normalized === 'approved') return 'approved';
    if (normalized === 'denied') return 'denied';
    if (normalized === 'cancelled') return 'cancelled';
    return 'pending';
  }, [status]);

  return <span className={`status-pill ${tone}`}>{statusLabel(status)}</span>;
};

function TutorTimeOffSection(): JSX.Element {
  const [formData, setFormData] = useState({ startAt: '', endAt: '', type: 'pto', notes: '' });
  const [requests, setRequests] = useState<TimeOffRequest[]>([]);
  const [loadingRequests, setLoadingRequests] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [successRequest, setSuccessRequest] = useState<TimeOffRequest | null>(null);

  const loadRequests = useCallback(async () => {
    setLoadingRequests(true);
    setError(null);
    try {
      const response = await fetch('/api/timeoff/me?limit=200', { credentials: 'include' });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || 'Failed to load requests');
      }
      setRequests(Array.isArray(data.requests) ? data.requests : []);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load requests';
      setError(message);
    } finally {
      setLoadingRequests(false);
    }
  }, []);

  useEffect(() => {
    void loadRequests();
  }, [loadRequests]);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    setSuccessRequest(null);

    const startIso = toIsoWithOffset(formData.startAt);
    const endIso = toIsoWithOffset(formData.endAt);
    if (!startIso || !endIso) {
      setError('Please enter valid start and end times.');
      setSubmitting(false);
      return;
    }

    try {
      const response = await fetch('/api/timeoff', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          startAt: startIso,
          endAt: endIso,
          type: formData.type,
          notes: formData.notes.trim() ? formData.notes.trim() : undefined
        })
      });

      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || 'Unable to submit request');
      }

      setSuccessRequest(data.request as TimeOffRequest);
      setFormData((prev) => ({ ...prev, notes: '' }));
      await loadRequests();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to submit request';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = async (id: number) => {
    setError(null);
    try {
      const response = await fetch(`/api/timeoff/${id}/cancel`, {
        method: 'POST',
        credentials: 'include'
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || 'Unable to cancel request');
      }

      setRequests((prev) => prev.map((req) => (req.id === id ? (data.request as TimeOffRequest) : req)));
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to cancel request';
      setError(message);
    }
  };

  return (
    <>
      <section className="form-section visible">
        <h3>Tutor: Request Time Off</h3>
        <form className="time-off-form" onSubmit={handleSubmit}>
          <div className="form-row">
            <div className="form-group">
              <label htmlFor="startAt">Start</label>
              <input
                id="startAt"
                type="datetime-local"
                value={formData.startAt}
                onChange={(e) => setFormData((prev) => ({ ...prev, startAt: e.target.value }))}
                required
              />
            </div>
            <div className="form-group">
              <label htmlFor="endAt">End</label>
              <input
                id="endAt"
                type="datetime-local"
                value={formData.endAt}
                onChange={(e) => setFormData((prev) => ({ ...prev, endAt: e.target.value }))}
                required
              />
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label htmlFor="type">Type</label>
              <select
                id="type"
                value={formData.type}
                onChange={(e) => setFormData((prev) => ({ ...prev, type: e.target.value }))}
                required
              >
                <option value="pto">Paid Time Off</option>
                <option value="sick">Sick</option>
                <option value="unpaid">Unpaid</option>
                <option value="other">Other</option>
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="notes">Notes (optional)</label>
              <textarea
                id="notes"
                maxLength={2000}
                value={formData.notes}
                onChange={(e) => setFormData((prev) => ({ ...prev, notes: e.target.value }))}
                placeholder="Provide helpful context for your supervisor"
              />
            </div>
          </div>

          <div className="form-actions">
            <button className="btn btn-primary" type="submit" disabled={submitting}>
              {submitting ? 'Submitting...' : 'Submit Request'}
            </button>
            <button
              className="btn btn-secondary"
              type="button"
              onClick={() => setFormData({ startAt: '', endAt: '', type: 'pto', notes: '' })}
              disabled={submitting}
            >
              Clear
            </button>
          </div>

          {error && (
            <p className="error-message show" role="alert">
              {error}
            </p>
          )}
        </form>

        {successRequest && (
          <div className="success-message" role="status">
            <h3>Request submitted</h3>
            <p>
              Request #{successRequest.id} is <strong>{statusLabel(successRequest.status)}</strong>.
            </p>
            <p>
              {formatDateTime(successRequest.startAt)} - {formatDateTime(successRequest.endAt)}
            </p>
          </div>
        )}
      </section>

      <section className="form-section visible">
        <h3>My Time Off Requests</h3>
        {loadingRequests ? (
          <p className="body-copy">Loading requests...</p>
        ) : requests.length === 0 ? (
          <p className="body-copy">No requests yet.</p>
        ) : (
          <div className="request-list">
            {requests.map((request) => (
              <div className="request-card" key={request.id}>
                <div className="request-card__header">
                  <StatusPill status={request.status} />
                  <span className="request-date">{formatDateTime(request.createdAt)}</span>
                </div>
                <div className="request-details">
                  <div className="request-detail">
                    <span className="label">Start</span>
                    <span className="value">{formatDateTime(request.startAt)}</span>
                  </div>
                  <div className="request-detail">
                    <span className="label">End</span>
                    <span className="value">{formatDateTime(request.endAt)}</span>
                  </div>
                  <div className="request-detail">
                    <span className="label">Type</span>
                    <span className="value text-strong">{request.type}</span>
                  </div>
                  {request.notes && (
                    <div className="request-detail">
                      <span className="label">Notes</span>
                      <span className="value">{request.notes}</span>
                    </div>
                  )}
                  {request.decisionReason && (
                    <div className="request-detail">
                      <span className="label">Decision</span>
                      <span className="value">{request.decisionReason}</span>
                    </div>
                  )}
                  {request.googleCalendarEventId && (
                    <div className="request-detail">
                      <span className="label">Calendar Event</span>
                      <span className="value">{request.googleCalendarEventId}</span>
                    </div>
                  )}
                </div>
                {request.status === 'pending' && (
                  <div className="request-actions">
                    <button className="btn btn-secondary" type="button" onClick={() => void handleCancel(request.id)}>
                      Cancel Request
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </>
  );
}

function AdminPendingSection(): JSX.Element {
  const [franchiseId, setFranchiseId] = useState('');
  const [requests, setRequests] = useState<TimeOffRequest[]>([]);
  const [reasons, setReasons] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPending = useCallback(async () => {
    if (!franchiseId.trim()) {
      setError('Enter a franchiseId to load pending requests.');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      const response = await fetch(`/api/timeoff/admin/pending?franchiseId=${encodeURIComponent(franchiseId.trim())}`, {
        credentials: 'include'
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || 'Failed to load pending requests');
      }
      setRequests(Array.isArray(data.requests) ? data.requests : []);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load pending requests';
      setError(message);
    } finally {
      setLoading(false);
    }
  }, [franchiseId]);

  const decide = async (request: TimeOffRequest, decision: 'approve' | 'deny') => {
    setError(null);
    const reason = (reasons[request.id] || '').trim();
    if (decision === 'deny' && !reason) {
      setError('A reason is required to deny a request.');
      return;
    }

    try {
      const response = await fetch(`/api/timeoff/${request.id}/decide`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          decision,
          reason: reason || undefined,
          franchiseId: Number(franchiseId) || franchiseId
        })
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error || 'Decision failed');
      }

      setRequests((prev) => prev.filter((item) => item.id !== request.id));
      setReasons((prev) => {
        const copy = { ...prev };
        delete copy[request.id];
        return copy;
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Decision failed';
      setError(message);
    }
  };

  return (
    <section className="form-section visible">
      <h3>Admin: Pending Time Off Requests</h3>
      <div className="form-row">
        <div className="form-group">
          <label htmlFor="franchiseId">Franchise ID</label>
          <input
            id="franchiseId"
            type="text"
            inputMode="numeric"
            value={franchiseId}
            onChange={(e) => setFranchiseId(e.target.value)}
            placeholder="Required"
          />
        </div>
        <div className="form-group">
          <label>&nbsp;</label>
          <button className="btn btn-primary" type="button" onClick={() => void loadPending()} disabled={loading}>
            {loading ? 'Loading...' : 'Load Pending'}
          </button>
        </div>
      </div>

      {error && (
        <p className="error-message show" role="alert">
          {error}
        </p>
      )}

      {loading ? (
        <p className="body-copy">Fetching pending requests...</p>
      ) : requests.length === 0 ? (
        <p className="body-copy">No pending requests for this franchise.</p>
      ) : (
        <div className="request-list">
          {requests.map((request) => (
            <div className="request-card" key={request.id}>
              <div className="request-card__header">
                <div>
                  <div className="text-strong">{request.tutorName || `Tutor #${request.tutorId ?? ''}`}</div>
                  <div className="request-subtitle">{request.tutorEmail || 'Email unavailable'}</div>
                </div>
                <StatusPill status={request.status} />
              </div>
              <div className="request-details">
                <div className="request-detail">
                  <span className="label">Start</span>
                  <span className="value">{formatDateTime(request.startAt)}</span>
                </div>
                <div className="request-detail">
                  <span className="label">End</span>
                  <span className="value">{formatDateTime(request.endAt)}</span>
                </div>
                <div className="request-detail">
                  <span className="label">Type</span>
                  <span className="value text-strong">{request.type}</span>
                </div>
                <div className="request-detail">
                  <span className="label">Created</span>
                  <span className="value">{formatDateTime(request.createdAt)}</span>
                </div>
                {request.notes && (
                  <div className="request-detail">
                    <span className="label">Notes</span>
                    <span className="value">{request.notes}</span>
                  </div>
                )}
              </div>

              <div className="request-actions">
                <input
                  type="text"
                  placeholder="Reason (required to deny)"
                  value={reasons[request.id] || ''}
                  onChange={(e) =>
                    setReasons((prev) => ({
                      ...prev,
                      [request.id]: e.target.value
                    }))
                  }
                />
                <div className="action-buttons">
                  <button
                    className="btn btn-primary"
                    type="button"
                    onClick={() => void decide(request, 'approve')}
                  >
                    Approve
                  </button>
                  <button className="btn btn-secondary" type="button" onClick={() => void decide(request, 'deny')}>
                    Deny
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Home(): JSX.Element {
  return (
    <form className="time-off-form">
      <TutorTimeOffSection />
      <AdminPendingSection />
    </form>
  );
}

export default Home;
