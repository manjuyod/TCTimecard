import { useEffect, useMemo, useState } from 'react';
import {
  ExtraHoursRequest,
  TimeOffRequest,
  decideExtraHours,
  decideTimeOff,
  fetchAdminPendingExtraHours,
  fetchAdminPendingTimeOff
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../../components/ui/dialog';
import { Textarea } from '../../components/ui/textarea';

type DenyContext =
  | { type: 'extra'; request: ExtraHoursRequest }
  | { type: 'timeoff'; request: TimeOffRequest };

export function ApprovalsPage(): JSX.Element {
  const { session } = useAuth();
  const sessionFranchiseId = getSessionFranchiseId(session);
  const selectorAllowed = isSelectorAllowed(session);
  const [activeTab, setActiveTab] = useState<'extra' | 'timeoff'>('extra');
  const [franchiseInput, setFranchiseInput] = useState<string>(
    sessionFranchiseId !== null ? String(sessionFranchiseId) : ''
  );
  const [franchiseId, setFranchiseId] = useState<number | null>(sessionFranchiseId);
  const [extraRequests, setExtraRequests] = useState<
    Array<ExtraHoursRequest & { tutorName?: string; tutorEmail?: string; tutorId?: number }>
  >([]);
  const [timeOffRequests, setTimeOffRequests] = useState<TimeOffRequest[]>([]);
  const [loadingExtra, setLoadingExtra] = useState(false);
  const [loadingTimeOff, setLoadingTimeOff] = useState(false);
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
      const data = await fetchAdminPendingTimeOff(id, 300);
      setTimeOffRequests(data);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to load time off requests';
      setError(message);
      toast.error(message);
    } finally {
      setLoadingTimeOff(false);
    }
  };

  useEffect(() => {
    if (franchiseId !== null) {
      void loadExtra(franchiseId);
      void loadTimeOff(franchiseId);
    }
  }, [franchiseId]);

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

    setActingId(denyDialog.type === 'extra' ? denyDialog.request.id : denyDialog.request.id);
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
      } else {
        await decideTimeOff({
          id: denyDialog.request.id,
          decision: 'deny',
          reason: denyReason.trim(),
          franchiseId: targetFranchiseId
        });
        setTimeOffRequests((prev) => prev.filter((item) => item.id !== denyDialog.request.id));
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
      await decideTimeOff({
        id: request.id,
        decision: 'approve',
        franchiseId: targetFranchiseId
      });
      setTimeOffRequests((prev) => prev.filter((item) => item.id !== request.id));
      toast.success('Time off approved');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unable to approve request';
      toast.error(message);
    } finally {
      setActingId(null);
    }
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
            <TableHead>Notes</TableHead>
            <TableHead className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {timeOffRequests.map((req) => (
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
                <Badge variant="secondary" className="capitalize">
                  {req.type}
                </Badge>
              </TableCell>
              <TableCell className="text-sm text-slate-800">{req.notes || '—'}</TableCell>
              <TableCell className="text-right">
                <div className="flex justify-end gap-2">
                  <Button
                    size="sm"
                    onClick={() => void handleApproveTimeOff(req)}
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
  }, [actingId, loadingTimeOff, timeOffRequests]);

  return (
    <div className="space-y-6">
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
            <Button onClick={applyFranchise} disabled={loadingExtra || loadingTimeOff}>
              Apply
            </Button>
            <Badge variant="muted">Session: {session?.franchiseId ?? 'N/A'}</Badge>
          </CardContent>
        </Card>
      ) : null}

      <Tabs value={activeTab} onValueChange={(val) => setActiveTab(val as 'extra' | 'timeoff')}>
        <TabsList>
          <TabsTrigger value="extra">Extra Hours</TabsTrigger>
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

        <TabsContent value="timeoff" className="mt-4">
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
        </TabsContent>
      </Tabs>

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
    </div>
  );
}
