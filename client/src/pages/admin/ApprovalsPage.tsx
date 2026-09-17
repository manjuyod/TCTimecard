import { TimeEntryManagementPanel } from './time-entry/TimeEntryManagementPanel';
import { TimeEntryReviewDialog } from './time-entry/TimeEntryReviewDialog';
import { TimeEntryCorrectionDialog, CorrectionDialogTarget } from './time-entry/TimeEntryCorrectionDialog';
import { getAdminTimeEntryDetail } from '../../lib/adminTimeEntryApi';
import type { AdminTimeEntryDetail, AdminOperationResult } from '../../lib/adminTimeEntry';
import { useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useSearchParams } from 'react-router-dom';
import { DateTime } from 'luxon';
import {
  AdminAttestationTutor,
  ExtraHoursRequest,
  TimeEntryDay,
  TimeOffRequest,
  TimeOffNotificationFailure,
  decideTimeEntryDay,
  decideExtraHours,
  decideTimeOff,
  downloadAdminAttestationExport,
  fetchAdminPendingExtraHours,
  fetchAdminPendingTimeEntries,
  fetchAdminPendingTimeOff,
  fetchAdminTimeOffDetail,
  fetchTimeOffNotificationFailures,
  retryTimeOffNotification,
  fetchAdminAttestationTutors
} from '../../lib/api';
import { useAuth } from '../../providers/AuthProvider';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Button } from '../../components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { StatusBadge } from '../../components/shared/StatusBadge';
import { EmptyState } from '../../components/shared/EmptyState';
import { InlineError } from '../../components/shared/InlineError';
import { Badge } from '../../components/ui/badge';
import { toast } from '../../components/ui/toast';
import { formatDateRange, formatDateTime, hoursBetween } from '../../lib/utils';
import { getSessionFranchiseId, isSelectorAllowed } from '../../lib/franchise';
import { parseTimeEntryComparison } from '../../lib/timeEntryComparison';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../components/ui/dialog';
import { Textarea } from '../../components/ui/textarea';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../../components/ui/select';
import { parseAdminTimeOffDeepLink } from '../../lib/timeOff';

type DenyContext =
  | { type: 'extra'; request: ExtraHoursRequest }
  | { type: 'timeoff'; request: TimeOffRequest }
  | { type: 'timeentry'; day: TimeEntryDay };

const toComparisonTotals = (day: TimeEntryDay) => parseTimeEntryComparison(day.comparison);

const browserTimeZone = DateTime.local().zoneName ?? 'UTC';

const formatWorkDate = (value: string): string => {
  const parsed = browserTimeZone
    ? DateTime.fromISO(value, { zone: browserTimeZone, setZone: true })
    : DateTime.fromISO(value);
  return parsed.isValid ? parsed.toISODate() ?? value : value;
};

const formatMinutes = (minutes: number): string => {
  const safe = Math.max(0, Math.round(minutes));
  const hours = Math.floor(safe / 60);
  const remainder = safe % 60;
  if (hours && remainder) return `${hours}h ${remainder}m`;
  if (hours) return `${hours}h`;
  return `${remainder}m`;
};

function AttestationExportCard({
  franchiseId,
  sessionFranchiseId
}: {
  franchiseId: number | null;
  sessionFranchiseId: number | null;
}): JSX.Element {
  const [weekEndStart, setWeekEndStart] = useState('');
  const [weekEndEnd, setWeekEndEnd] = useState('');
  const [tutors, setTutors] = useState<AdminAttestationTutor[]>([]);
  const [selectedTutorId, setSelectedTutorId] = useState('all');
  const [loadingTutors, setLoadingTutors] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [attestationError, setAttestationError] = useState<string | null>(null);

  const targetFranchiseId = franchiseId ?? sessionFranchiseId;

  useEffect(() => {
    setTutors([]);
    setSelectedTutorId('all');
  }, [targetFranchiseId, weekEndStart, weekEndEnd]);

  const validateFilters = (): { franchiseId: number; weekEndStart: string; weekEndEnd: string } | null => {
    if (targetFranchiseId === null) {
      setAttestationError('Franchise ID is required.');
      return null;
    }
    if (!weekEndStart || !weekEndEnd) {
      setAttestationError('Week ending start and end dates are required.');
      return null;
    }
    if (weekEndStart > weekEndEnd) {
      setAttestationError('Week ending start must be on or before the end date.');
      return null;
    }
    setAttestationError(null);
    return { franchiseId: targetFranchiseId, weekEndStart, weekEndEnd };
  };

  const loadTutors = async () => {
    const filters = validateFilters();
    if (!filters) return;

    setLoadingTutors(true);
    try {
      const nextTutors = await fetchAdminAttestationTutors(filters);
      setTutors(nextTutors);
      setSelectedTutorId((prev) =>
        prev !== 'all' && !nextTutors.some((tutor) => String(tutor.tutorId) === prev) ? 'all' : prev
      );
      if (!nextTutors.length) toast('No signed attestations found for that range.');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to load attestation tutors';
      setAttestationError(message);
      toast.error(message);
    } finally {
      setLoadingTutors(false);
    }
  };

  const exportAttestations = async () => {
    const filters = validateFilters();
    if (!filters) return;

    setExporting(true);
    try {
      const tutorId = selectedTutorId === 'all' ? null : Number(selectedTutorId);
      const { blob, filename } = await downloadAdminAttestationExport({
        ...filters,
        tutorId: Number.isFinite(tutorId) ? tutorId : null
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      link.click();
      URL.revokeObjectURL(url);
      toast.success('Exported attestation log');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to export attestation log';
      setAttestationError(message);
      toast.error(message);
    } finally {
      setExporting(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Attestation Export</CardTitle>
        <CardDescription>Download signed weekly attestations by week-ending range.</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4 md:grid-cols-[1fr_1fr_1.5fr_auto_auto] md:items-end">
        <div className="space-y-2">
          <Label htmlFor="attestationWeekEndStart" requiredMark>
            Week ending from
          </Label>
          <Input
            id="attestationWeekEndStart"
            type="date"
            value={weekEndStart}
            onChange={(event) => setWeekEndStart(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="attestationWeekEndEnd" requiredMark>
            Week ending to
          </Label>
          <Input
            id="attestationWeekEndEnd"
            type="date"
            value={weekEndEnd}
            onChange={(event) => setWeekEndEnd(event.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label>Tutor</Label>
          <Select value={selectedTutorId} onValueChange={setSelectedTutorId}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All tutors</SelectItem>
              {tutors.map((tutor) => (
                <SelectItem key={tutor.tutorId} value={String(tutor.tutorId)}>
                  {tutor.displayName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <Button variant="outline" onClick={() => void loadTutors()} disabled={loadingTutors || exporting}>
          {loadingTutors ? 'Loading...' : 'Load tutors'}
        </Button>
        <Button onClick={() => void exportAttestations()} disabled={loadingTutors || exporting}>
          {exporting ? 'Exporting...' : 'Export Excel'}
        </Button>
        {attestationError ? <InlineError message={attestationError} /> : null}
      </CardContent>
    </Card>
  );
}

export function ApprovalsPage(): JSX.Element {
  const { session } = useAuth();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const manageEntries = searchParams.get('tab') === 'timeentry' && searchParams.get('view') === 'manage';
  const [reviewDetail, setReviewDetail] = useState<AdminTimeEntryDetail | null>(null);
  const [correctionTarget, setCorrectionTarget] = useState<CorrectionDialogTarget | null>(null);
  const [correctionDirty, setCorrectionDirty] = useState(false);
  const [entryRefreshKey, setEntryRefreshKey] = useState(0);
  const entryRequest = useRef(0);
  const entryFocusTarget = useRef<HTMLElement | null>(null);
  const restoreEntryFocus = () => {
    const target = entryFocusTarget.current;
    if (target?.isConnected && !target.hasAttribute('disabled')) target.focus();
    else (document.getElementById('entry-exact-date') ?? document.getElementById('manage-time-entries'))?.focus();
  };
  const activeFranchise = useRef<number | null>(null);
  const sessionFranchiseId = getSessionFranchiseId(session);
  const selectorAllowed = isSelectorAllowed(session);
  const [activeTab, setActiveTab] = useState<'extra' | 'timeoff' | 'timeentry'>('timeentry');
  const [franchiseInput, setFranchiseInput] = useState<string>(
    sessionFranchiseId !== null ? String(sessionFranchiseId) : ''
  );
  const [franchiseId, setFranchiseId] = useState<number | null>(sessionFranchiseId);
  activeFranchise.current = franchiseId;
  useEffect(() => { entryRequest.current++; setReviewDetail(null); setCorrectionTarget(null); }, [franchiseId]);
  useEffect(() => { if (manageEntries) setActiveTab('timeentry'); }, [manageEntries]);
  const [extraRequests, setExtraRequests] = useState<
    Array<ExtraHoursRequest & { tutorName?: string; tutorEmail?: string; tutorId?: number }>
  >([]);
  const [timeOffRequests, setTimeOffRequests] = useState<TimeOffRequest[]>([]);
  const [timeOffFailures, setTimeOffFailures] = useState<TimeOffNotificationFailure[]>([]);
  const [reviewedTimeOff, setReviewedTimeOff] = useState<TimeOffRequest | null>(null);
  const [approveTimeOffDialog, setApproveTimeOffDialog] = useState<TimeOffRequest | null>(null);
  const [retryingAuditId, setRetryingAuditId] = useState<number | null>(null);
  const [handledDeepLink, setHandledDeepLink] = useState('');
  const [timeEntryDays, setTimeEntryDays] = useState<TimeEntryDay[]>([]);
  const [loadingExtra, setLoadingExtra] = useState(false);
  const [loadingTimeOff, setLoadingTimeOff] = useState(false);
  const [loadingTimeEntry, setLoadingTimeEntry] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [denyDialog, setDenyDialog] = useState<DenyContext | null>(null);
  const [denyReason, setDenyReason] = useState('');
  const [actingId, setActingId] = useState<number | null>(null);
  useEffect(() => {
    if (!selectorAllowed) {
      setError(null);
      setFranchiseInput(sessionFranchiseId !== null ? String(sessionFranchiseId) : '');
      setFranchiseId(sessionFranchiseId);
      return;
    }

    if (selectorAllowed && franchiseId === null && sessionFranchiseId !== null) {
      setFranchiseInput(String(sessionFranchiseId));
      setFranchiseId(sessionFranchiseId);
    }
  }, [selectorAllowed, sessionFranchiseId, franchiseId]);

  const validateFranchise = (): number | null => {
    if (!selectorAllowed) return sessionFranchiseId;
    const parsed = Number(franchiseInput);
    if (!Number.isFinite(parsed)) {
      setError('Franchise ID is required.');
      return null;
    }
    return parsed;
  };

  const applyFranchise = () => {
    if (!selectorAllowed) return;
    const parsed = validateFranchise();
    if (parsed !== null) {
      if (correctionTarget) return;
      if (parsed !== franchiseId) setSearchParams(prev => {
        const next = new URLSearchParams(prev); next.delete('tutorId'); next.delete('workDate'); return next;
      });
      setFranchiseId(parsed);
      setError(null);
    }
  };

  const loadExtra = async (id: number) => {
    setLoadingExtra(true);
    setError(null);
    try {
      const data = await fetchAdminPendingExtraHours(id, 300);
      setExtraRequests(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to load extra hours';
      setError(message);
      toast.error(message);
    } finally {
      setLoadingExtra(false);
    }
  };

  const loadTimeOff = async (id: number) => {
    setLoadingTimeOff(true);
    setError(null);
    try {
      const [data, failures] = await Promise.all([
        fetchAdminPendingTimeOff(id, 300),
        fetchTimeOffNotificationFailures(id)
      ]);
      setTimeOffRequests(data);
      setTimeOffFailures(failures);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to load time off requests';
      setError(message);
      toast.error(message);
    } finally {
      setLoadingTimeOff(false);
    }
  };

  const loadTimeEntries = async (id: number) => {
    setLoadingTimeEntry(true);
    setError(null);
    try {
      const data = await fetchAdminPendingTimeEntries({ franchiseId: id, limit: 500 });
      setTimeEntryDays(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to load time entry variances';
      setError(message);
      toast.error(message);
    } finally {
      setLoadingTimeEntry(false);
    }
  };

  useEffect(() => {
    if (franchiseId !== null) {
      void loadExtra(franchiseId);
      void loadTimeOff(franchiseId);
      void loadTimeEntries(franchiseId);
    }
  }, [franchiseId]);

  const timeOffDeepLink = useMemo(() => parseAdminTimeOffDeepLink(location.search), [location.search]);

  useEffect(() => {
    if (!reviewDetail) return;
    const { franchiseId: center, tutor, workDate } = reviewDetail;
    let active = true;
    const refreshReview = async () => {
      const request = ++entryRequest.current;
      try {
        const next = await getAdminTimeEntryDetail({ franchiseId: center, tutorId: tutor.tutorId, workDate });
        if (active && request === entryRequest.current && activeFranchise.current === center) setReviewDetail(next);
      } catch (err) {
        if (active && request === entryRequest.current) toast.error(err instanceof Error ? err.message : 'Unable to refresh entry');
      }
    };
    window.addEventListener('focus', refreshReview);
    return () => { active = false; window.removeEventListener('focus', refreshReview); };
  }, [reviewDetail?.franchiseId, reviewDetail?.tutor.tutorId, reviewDetail?.workDate]);

  useEffect(() => {
    if (!timeOffDeepLink) return;
    setActiveTab('timeoff');
    if (selectorAllowed) {
      setFranchiseInput(String(timeOffDeepLink.franchiseId));
      setFranchiseId(timeOffDeepLink.franchiseId);
    }
  }, [selectorAllowed, timeOffDeepLink]);

  useEffect(() => {
    if (!timeOffDeepLink || franchiseId === null) return;
    const key = `${location.pathname}${location.search}`;
    if (handledDeepLink === key) return;
    const effectiveFranchiseId = selectorAllowed ? timeOffDeepLink.franchiseId : franchiseId;
    setHandledDeepLink(key);
    void fetchAdminTimeOffDetail(effectiveFranchiseId, timeOffDeepLink.requestId)
      .then((request) => {
        setReviewedTimeOff(request);
        if (request.status !== 'pending') {
          toast.info(`Time-off request #${request.id} is already ${request.status}.`);
          return;
        }
        if (timeOffDeepLink.action === 'approve') setApproveTimeOffDialog(request);
        if (timeOffDeepLink.action === 'deny') {
          setDenyDialog({ type: 'timeoff', request });
          setDenyReason('');
        }
      })
      .catch((err) => toast.error(err instanceof Error ? err.message : 'Unable to open time-off request'));
  }, [franchiseId, handledDeepLink, location.pathname, location.search, selectorAllowed, timeOffDeepLink]);

  const handleApproveExtra = async (request: ExtraHoursRequest) => {
    if (franchiseId === null && sessionFranchiseId === null) {
      toast.error('Franchise ID required');
      return;
    }

    setActingId(request.id);
    try {
      const targetFranchiseId = franchiseId ?? sessionFranchiseId;
      if (targetFranchiseId === null) {
        toast.error('Franchise ID required');
        return;
      }

      await decideExtraHours({ id: request.id, decision: 'approve', franchiseId: targetFranchiseId });
      setExtraRequests((prev) => prev.filter((item) => item.id !== request.id));
      toast.success('Extra hours approved');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to approve request';
      toast.error(message);
    } finally {
      setActingId(null);
    }
  };

  const handleDeny = async () => {
    if (!denyDialog || (franchiseId === null && sessionFranchiseId === null)) return;
    if (!denyReason.trim()) {
      toast.error('Reason is required to deny.');
      return;
    }

    setActingId(
      denyDialog.type === 'extra' ? denyDialog.request.id : denyDialog.type === 'timeoff' ? denyDialog.request.id : denyDialog.day.id
    );
    try {
      const targetFranchiseId = franchiseId ?? sessionFranchiseId;
      if (targetFranchiseId === null) {
        toast.error('Franchise ID required');
        return;
      }

      if (denyDialog.type === 'extra') {
        await decideExtraHours({
          id: denyDialog.request.id,
          decision: 'deny',
          reason: denyReason.trim(),
          franchiseId: targetFranchiseId
        });
        setExtraRequests((prev) => prev.filter((item) => item.id !== denyDialog.request.id));
      } else if (denyDialog.type === 'timeoff') {
        const result = await decideTimeOff({
          id: denyDialog.request.id,
          decision: 'deny',
          reason: denyReason.trim(),
          franchiseId: targetFranchiseId
        });
        setTimeOffRequests((prev) => prev.filter((item) => item.id !== denyDialog.request.id));
        setReviewedTimeOff(result.request);
        if (result.notification.status === 'failed') {
          toast.warning(result.notification.warning);
          void loadTimeOff(targetFranchiseId);
        }
      } else {
        await decideTimeEntryDay({
          id: denyDialog.day.id,
          decision: 'deny',
          reason: denyReason.trim(),
          franchiseId: targetFranchiseId
        });
        setTimeEntryDays((prev) => prev.filter((item) => item.id !== denyDialog.day.id));
        setReviewDetail((prev) => (prev?.day?.id === denyDialog.day.id ? null : prev));
      }
      toast.success('Request denied');
      setDenyDialog(null);
      setDenyReason('');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to deny request';
      toast.error(message);
    } finally {
      setActingId(null);
    }
  };

  const handleApproveTimeOff = async (request: TimeOffRequest) => {
    if (franchiseId === null && sessionFranchiseId === null) {
      toast.error('Franchise ID required');
      return;
    }
    setActingId(request.id);
    try {
      toast('Posting to calendar...');
      const targetFranchiseId = franchiseId ?? sessionFranchiseId;
      if (targetFranchiseId === null) {
        toast.error('Franchise ID required');
        return;
      }
      const result = await decideTimeOff({
        id: request.id,
        decision: 'approve',
        franchiseId: targetFranchiseId
      });
      setTimeOffRequests((prev) => prev.filter((item) => item.id !== request.id));
      setReviewedTimeOff(result.request);
      setApproveTimeOffDialog(null);
      if (result.notification.status === 'failed') {
        toast.warning(result.notification.warning);
        void loadTimeOff(targetFranchiseId);
      }
      else toast.success('Time off approved and the requester was notified');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to approve request';
      toast.error(message);
    } finally {
      setActingId(null);
    }
  };

  const handleRetryTimeOffNotification = async (failure: TimeOffNotificationFailure) => {
    const targetFranchiseId = franchiseId ?? sessionFranchiseId;
    if (targetFranchiseId === null) {
      toast.error('Franchise ID required');
      return;
    }
    setRetryingAuditId(failure.auditId);
    try {
      const result = await retryTimeOffNotification({
        id: failure.requestId,
        kind: failure.kind,
        franchiseId: targetFranchiseId
      });
      if (result.notification.status === 'failed') toast.error(result.notification.warning || 'Notification retry failed');
      else {
        setTimeOffFailures((previous) => previous.filter((item) => item.auditId !== failure.auditId));
        toast.success('Notification sent');
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Unable to retry notification');
    } finally {
      setRetryingAuditId(null);
    }
  };

  const handleApproveTimeEntry = async (day: TimeEntryDay) => {
    if (franchiseId === null && sessionFranchiseId === null) {
      toast.error('Franchise ID required');
      return;
    }

    setActingId(day.id);
    try {
      const targetFranchiseId = franchiseId ?? sessionFranchiseId;
      if (targetFranchiseId === null) {
        toast.error('Franchise ID required');
        return;
      }

      await decideTimeEntryDay({ id: day.id, decision: 'approve', franchiseId: targetFranchiseId });
      setTimeEntryDays((prev) => prev.filter((item) => item.id !== day.id));
      setReviewDetail((prev) => (prev?.day?.id === day.id ? null : prev));
      toast.success('Time entry approved');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to approve time entry';
      toast.error(message);
    } finally {
      setActingId(null);
    }
  };

  const setEntryView = (manage: boolean) => {
    if (correctionTarget) return;
    setSearchParams(prev => { const next = new URLSearchParams(prev); next.set('tab', 'timeentry');
      if (manage) next.set('view', 'manage'); else next.delete('view'); return next; });
  };
  const openAdminEntry = async (day: TimeEntryDay, adjust = false) => {
    const selectedFranchise = franchiseId;
    if (selectedFranchise === null) return;
    const generation = ++entryRequest.current;
    setActingId(day.id);
    try {
      const detail = await getAdminTimeEntryDetail({ franchiseId: selectedFranchise, tutorId: day.tutorId, workDate: day.workDate });
      if (generation !== entryRequest.current || activeFranchise.current !== selectedFranchise) return;
      if (adjust && detail.allowedActions.includes('correct')) setCorrectionTarget({ action: 'correct', detail });
      else setReviewDetail(detail);
    } catch (err) { if (generation === entryRequest.current) toast.error(err instanceof Error ? err.message : 'Unable to load time entry'); }
    finally { if (generation === entryRequest.current) setActingId(null); }
  };
  const onEntryCommitted = (result: AdminOperationResult) => {
    const target = correctionTarget;
    setCorrectionTarget(null); setCorrectionDirty(false); setEntryRefreshKey(value => value + 1);
    toast.success(result.action === 'correct' ? 'Time entry corrected and approved.' : result.action === 'void' ? 'Entry voided. Removed from approved totals.' : 'Entry restored and approved.');
    if (franchiseId !== null) void loadTimeEntries(franchiseId);
    if (!target) return;
    const generation = ++entryRequest.current;
    void getAdminTimeEntryDetail({ franchiseId: target.detail.franchiseId, tutorId: target.detail.tutor.tutorId, workDate: target.detail.workDate })
      .then(detail => { if (generation === entryRequest.current && activeFranchise.current === detail.franchiseId) setReviewDetail(detail); })
      .catch(() => toast.info('Saved successfully. Refresh the list to view the current entry.'));
  };

  const extraContent = useMemo(() => {
    if (loadingExtra) {
      return <p className="text-sm text-muted-foreground">Loading pending extra hours...</p>;
    }
    if (!extraRequests.length) {
      return <EmptyState title="No pending extra hours" description="All extra hours have been reviewed." />;
    }
    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Tutor</TableHead>
            <TableHead>Range</TableHead>
            <TableHead>Duration</TableHead>
            <TableHead>Description</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {extraRequests.map((req) => (
            <TableRow key={req.id}>
              <TableCell>
                <p className="font-semibold text-slate-900">{req.tutorName || `Tutor #${req.tutorId ?? ''}`}</p>
                <p className="text-xs text-muted-foreground">{req.tutorEmail || 'Email unavailable'}</p>
              </TableCell>
              <TableCell>
                <p className="text-sm font-semibold">{formatDateRange(req.startAt, req.endAt)}</p>
                <p className="text-xs text-muted-foreground">{formatDateTime(req.createdAt)}</p>
              </TableCell>
              <TableCell>
                <Badge variant="muted">{hoursBetween(req.startAt, req.endAt).toFixed(2)} hrs</Badge>
              </TableCell>
              <TableCell className="text-sm text-slate-800">{req.description}</TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-2">
                  <Button
                    size="sm"
                    onClick={() => void handleApproveExtra(req)}
                    disabled={actingId === req.id}
                  >
                    Approve
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setDenyDialog({ type: 'extra', request: req });
                      setDenyReason('');
                    }}
                  >
                    Deny
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }, [actingId, extraRequests, loadingExtra]);

  const timeOffContent = useMemo(() => {
    if (loadingTimeOff) {
      return <p className="text-sm text-muted-foreground">Loading pending time off...</p>;
    }
    if (!timeOffRequests.length) {
      return <EmptyState title="No pending time off" description="All requests are processed." />;
    }
    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Tutor</TableHead>
            <TableHead>Range</TableHead>
            <TableHead>Type</TableHead>
            <TableHead>Source</TableHead>
            <TableHead>Notes</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {timeOffRequests.map((req) => (
            <TableRow key={req.id} className={reviewedTimeOff?.id === req.id ? 'bg-brand-blue/10' : undefined}>
              <TableCell>
                <p className="font-semibold text-slate-900">{req.tutorName || `Tutor #${req.tutorId ?? ''}`}</p>
                <p className="text-xs text-muted-foreground">{req.tutorEmail || 'Email unavailable'}</p>
              </TableCell>
              <TableCell>
                <p className="text-sm font-semibold">{formatDateRange(req.startAt, req.endAt)}</p>
                <p className="text-xs text-muted-foreground">{formatDateTime(req.createdAt)}</p>
              </TableCell>
              <TableCell>
                <Badge variant="secondary" className="capitalize">
                  {req.absenceLabel || req.type}
                </Badge>
              </TableCell>
              <TableCell>
                <Badge variant={req.source === 'public' ? 'warning' : 'muted'}>
                  {req.source === 'public' ? 'Public form' : 'Authenticated'}
                </Badge>
              </TableCell>
              <TableCell className="text-sm text-slate-800">{req.notes || '—'}</TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-2">
                  <Button
                    size="sm"
                    onClick={() => setApproveTimeOffDialog(req)}
                    disabled={actingId === req.id}
                  >
                    {actingId === req.id ? 'Posting...' : 'Approve'}
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setDenyDialog({ type: 'timeoff', request: req });
                      setDenyReason('');
                    }}
                  >
                    Deny
                  </Button>
                </div>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    );
  }, [actingId, loadingTimeOff, reviewedTimeOff?.id, timeOffRequests]);

  const timeEntryContent = useMemo(() => {
    if (loadingTimeEntry) {
      return <p className="text-sm text-muted-foreground">Loading pending time entry variances...</p>;
    }
    if (!timeEntryDays.length) {
      return <EmptyState title="No pending time entries" description="All time entry variances have been reviewed." />;
    }

    return (
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Tutor</TableHead>
            <TableHead>Work Date</TableHead>
            <TableHead>Scheduled</TableHead>
            <TableHead>Covered</TableHead>
            <TableHead>Delta</TableHead>
            <TableHead>Payable Extra</TableHead>
            <TableHead>Flags</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {timeEntryDays.map((day) => {
            const totals = toComparisonTotals(day);
            const editedAfterApproval = Boolean(day.history?.wasEverApproved);

            return (
              <TableRow key={day.id}>
                <TableCell>
                  <p className="font-semibold text-slate-900">{day.tutorName || `Tutor #${day.tutorId}`}</p>
                  <p className="text-xs text-muted-foreground">{day.tutorEmail || 'Email unavailable'}</p>
                </TableCell>
                <TableCell>
                  <p className="text-sm font-semibold">{formatWorkDate(day.workDate)}</p>
                  <p className="text-xs text-muted-foreground">{day.submittedAt ? formatDateTime(day.submittedAt) : ''}</p>
                </TableCell>
                <TableCell>
                  {totals ? formatMinutes(totals.scheduledMinutes) : 'n/a'}
                </TableCell>
                <TableCell>
                  {totals ? formatMinutes(totals.coveredMinutes) : 'n/a'}
                </TableCell>
                <TableCell>
                  {!totals ? (
                    <Badge variant="muted">n/a</Badge>
                  ) : (
                    <Badge variant={totals.deltaMinutes === 0 ? 'success' : 'secondary'}>
                      {totals.deltaMinutes > 0 ? '+' : ''}
                      {totals.deltaMinutes} min
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  {!totals ? (
                    <Badge variant="muted">n/a</Badge>
                  ) : (
                    <Badge variant={totals.payableExtraMinutes === 0 ? 'muted' : 'warning'}>
                      {totals.payableExtraMinutes} min
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex flex-wrap gap-2">
                    {editedAfterApproval ? <Badge variant="warning">Edited after approval</Badge> : null}
                    {totals?.scheduledBreakOverlapMinutes ? (
                      <Badge variant="warning">{totals.scheduledBreakOverlapMinutes}m scheduled break overlap</Badge>
                    ) : null}
                    {totals?.outsideSessionMinutes ? (
                      <Badge variant="muted">{totals.outsideSessionMinutes}m outside sessions</Badge>
                    ) : null}
                    {totals?.unpositionedMinutes ? (
                      <Badge variant="muted">{totals.unpositionedMinutes}m unpositioned</Badge>
                    ) : null}
                    {day.history?.lastAudit?.action ? (
                      <Badge variant="muted">Last: {day.history.lastAudit.action}</Badge>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="text-right">
                  <div className="flex justify-end gap-2">
                    <Button size="sm" variant="outline" onClick={() => void openAdminEntry(day)}>
                      Review
                    </Button>
                    <Button size="sm" onClick={() => void handleApproveTimeEntry(day)} disabled={actingId === day.id}>
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setDenyDialog({ type: 'timeentry', day });
                        setDenyReason('');
                      }}
                      disabled={actingId === day.id}
                    >
                      Deny
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    );
  }, [actingId, loadingTimeEntry, timeEntryDays]);

  return (
    <div className="space-y-6" onClickCapture={event => {
      if (reviewDetail || correctionTarget || !(event.target instanceof Element)) return;
      const button = event.target.closest('button');
      if (button) entryFocusTarget.current = button;
    }}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Approvals Inbox</h1>
          <p className="text-sm text-muted-foreground">Approve or deny tutor requests by franchise.</p>
        </div>
        <Button
          variant="ghost"
          onClick={() => {
            const targetId = franchiseId ?? sessionFranchiseId;
            if (targetId !== null) {
              void loadExtra(targetId);
              void loadTimeOff(targetId);
              void loadTimeEntries(targetId);
            }
          }}
        >
          Refresh
        </Button>
      </div>

      {!selectorAllowed && error ? <InlineError message={error} /> : null}

      {selectorAllowed ? (
        <Card>
          <CardHeader>
            <CardTitle>Franchise</CardTitle>
            <CardDescription>Approvals are scoped to this franchise ID.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-3">
            <div className="w-full max-w-xs space-y-2">
              <Label htmlFor="franchiseId" requiredMark>
                Franchise ID
              </Label>
              <Input
                id="franchiseId"
                value={franchiseInput}
                inputMode="numeric"
                onChange={(e) => setFranchiseInput(e.target.value)}
              />
              <InlineError message={error} />
            </div>
            <Button onClick={applyFranchise} disabled={loadingExtra || loadingTimeOff || Boolean(correctionTarget)}>
              Apply
            </Button>
            <Badge variant="muted">Session: {session?.franchiseId ?? 'N/A'}</Badge>
          </CardContent>
        </Card>
      ) : null}

      <AttestationExportCard franchiseId={franchiseId} sessionFranchiseId={sessionFranchiseId} />

      <Tabs value={activeTab} onValueChange={(val) => { if (!correctionTarget) setActiveTab(val as 'extra' | 'timeoff' | 'timeentry'); }}>
        <TabsList>
          <TabsTrigger value="extra">Extra Hours</TabsTrigger>
          <TabsTrigger value="timeentry">Time Entry Variances</TabsTrigger>
          <TabsTrigger value="timeoff">Time Off</TabsTrigger>
        </TabsList>

        <TabsContent value="extra" className="mt-4">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <div>
                <CardTitle>Pending Extra Hours</CardTitle>
                <CardDescription>Approve or deny extra hours submissions.</CardDescription>
              </div>
              <StatusBadge status="pending" />
            </CardHeader>
            <CardContent>{extraContent}</CardContent>
          </Card>
        </TabsContent>

        <TabsContent value="timeentry" className="mt-4">
          {manageEntries && franchiseId !== null ? <TimeEntryManagementPanel key={franchiseId} franchiseId={franchiseId}
            refreshKey={entryRefreshKey} onBackToPending={() => setEntryView(false)} onSelectEntry={setReviewDetail} /> :
            <Card>
              <CardHeader className="flex flex-wrap flex-row items-center justify-between gap-3">
                <div><CardTitle>Time Entry Variances</CardTitle><CardDescription>Review and approve or deny mismatched manual time entries.</CardDescription></div>
                <Button id="manage-time-entries" variant="outline" onClick={() => setEntryView(true)} disabled={franchiseId === null}>Manage time entries</Button>
              </CardHeader>
              <CardContent>{timeEntryContent}</CardContent>
            </Card>}
        </TabsContent>

        <TabsContent value="timeoff" className="mt-4">
          <div className="space-y-4">
          {reviewedTimeOff ? (
            <Card className="border-brand-blue/30">
              <CardHeader>
                <CardTitle>Linked request #{reviewedTimeOff.id}</CardTitle>
                <CardDescription>
                  {reviewedTimeOff.tutorName || reviewedTimeOff.tutorEmail || 'Requester'} · {reviewedTimeOff.status}
                </CardDescription>
              </CardHeader>
              <CardContent className="flex flex-wrap items-center gap-2 text-sm">
                <StatusBadge status={reviewedTimeOff.status} />
                <Badge variant="secondary">{reviewedTimeOff.absenceLabel || reviewedTimeOff.type}</Badge>
                <span>{formatDateRange(reviewedTimeOff.startAt, reviewedTimeOff.endAt)}</span>
                {reviewedTimeOff.decisionReason ? <span>Reason: {reviewedTimeOff.decisionReason}</span> : null}
              </CardContent>
            </Card>
          ) : null}

          {timeOffFailures.length ? (
            <Card className="border-amber-300">
              <CardHeader>
                <CardTitle>Notification failures</CardTitle>
                <CardDescription>These saved requests or decisions need an email retry.</CardDescription>
              </CardHeader>
              <CardContent className="space-y-2">
                {timeOffFailures.map((failure) => (
                  <div key={failure.auditId} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm">
                    <div>
                      <p className="font-semibold">Request #{failure.requestId} · {failure.kind.replace('_', ' ')}</p>
                      <p className="text-xs text-muted-foreground">{failure.error || 'Notification provider error'}</p>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void handleRetryTimeOffNotification(failure)}
                      disabled={retryingAuditId === failure.auditId}
                    >
                      {retryingAuditId === failure.auditId ? 'Retrying...' : 'Retry email'}
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>
          ) : null}

          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2">
              <div>
                <CardTitle>Pending Time Off</CardTitle>
                <CardDescription>Approval posts events to franchise Google Calendar.</CardDescription>
              </div>
              <StatusBadge status="pending" />
            </CardHeader>
            <CardContent>{timeOffContent}</CardContent>
          </Card>
          </div>
        </TabsContent>
      </Tabs>

      <Dialog open={Boolean(approveTimeOffDialog)} onOpenChange={(open) => !open && setApproveTimeOffDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Approve time off</DialogTitle>
            <DialogDescription>
              Confirm request #{approveTimeOffDialog?.id}. Approval creates the franchise Google Calendar event and emails the requester.
            </DialogDescription>
          </DialogHeader>
          {approveTimeOffDialog ? (
            <div className="rounded-lg border p-3 text-sm">
              <p className="font-semibold">{approveTimeOffDialog.tutorName || approveTimeOffDialog.tutorEmail || 'Requester'}</p>
              <p>{formatDateRange(approveTimeOffDialog.startAt, approveTimeOffDialog.endAt)}</p>
              <p>{approveTimeOffDialog.absenceLabel || approveTimeOffDialog.type}</p>
            </div>
          ) : null}
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setApproveTimeOffDialog(null)}>Cancel</Button>
            <Button
              onClick={() => approveTimeOffDialog && void handleApproveTimeOff(approveTimeOffDialog)}
              disabled={!approveTimeOffDialog || actingId === approveTimeOffDialog.id}
            >
              {approveTimeOffDialog && actingId === approveTimeOffDialog.id ? 'Posting...' : 'Approve and post'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={Boolean(denyDialog)} onOpenChange={(open) => !open && setDenyDialog(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Deny request</DialogTitle>
            <DialogDescription>Please provide a reason to share with the tutor.</DialogDescription>
          </DialogHeader>
          <Textarea
            placeholder="Reason for denial"
            value={denyReason}
            onChange={(e) => setDenyReason(e.target.value)}
            className="min-h-[120px]"
          />
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setDenyDialog(null)}>
              Cancel
            </Button>
            <Button onClick={() => void handleDeny()} disabled={!denyReason.trim()}>
              Submit denial
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {reviewDetail && <TimeEntryReviewDialog key={reviewDetail.revision} detail={reviewDetail} onClose={() => setReviewDetail(null)} onReturnFocus={restoreEntryFocus}
        onAction={action => { setCorrectionTarget({ action, detail: reviewDetail }); setReviewDetail(null); }} />}
      <TimeEntryCorrectionDialog target={correctionTarget} onClose={() => { setCorrectionTarget(null); setCorrectionDirty(false); }}
        onCommitted={onEntryCommitted} onDirtyChange={setCorrectionDirty} onReturnFocus={restoreEntryFocus} />
      {correctionDirty && <span className="sr-only" aria-live="polite">Time entry has unsaved changes.</span>}
    </div>
  );
}
