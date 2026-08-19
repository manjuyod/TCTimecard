import { useEffect, useState } from 'react';
import {
  activatePtoCenter,
  addAdminPtoEmail,
  adjustAdminPtoBalance,
  decidePtoAlias,
  deactivatePtoCenter,
  detachPtoMembership,
  fetchAdminPtoAudit,
  fetchAdminPtoProfile,
  fetchAdminPtoProfiles,
  fetchFranchiseSettings,
  fetchPtoActivationPreview,
  FranchiseSettings,
  PtoActivationPreview,
  PtoAdminProfileDetail,
  PtoAuditEvent,
  PtoPagedResult,
  PtoProfileSummary,
  PtoRawRecord,
  removeAdminPtoEmail,
  syncPtoCenter
} from '../../lib/api';
import { getSessionFranchiseId, isSelectorAllowed } from '../../lib/franchise';
import { useAuth } from '../../providers/AuthProvider';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../../components/ui/card';
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle
} from '../../components/ui/dialog';
import { InlineError } from '../../components/shared/InlineError';
import { Input } from '../../components/ui/input';
import { Label } from '../../components/ui/label';
import { Skeleton } from '../../components/ui/skeleton';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../../components/ui/tabs';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '../../components/ui/table';
import { toast } from '../../components/ui/toast';

export function PtoManagementPage(): JSX.Element {
  const { session } = useAuth();
  const sessionFranchiseId = getSessionFranchiseId(session);
  const selectorAllowed = isSelectorAllowed(session);
  const [franchiseIdInput, setFranchiseIdInput] = useState(sessionFranchiseId ? String(sessionFranchiseId) : '');
  const [appliedFranchiseId, setAppliedFranchiseId] = useState<number | null>(null);
  const [settings, setSettings] = useState<FranchiseSettings | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<PtoActivationPreview | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const [activating, setActivating] = useState(false);
  const [tab, setTab] = useState<'profiles' | 'audit'>('profiles');
  const [profiles, setProfiles] = useState<PtoPagedResult<PtoProfileSummary> | null>(null);
  const [audit, setAudit] = useState<PtoPagedResult<PtoAuditEvent> | null>(null);
  const [dataLoading, setDataLoading] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [selectedProfile, setSelectedProfile] = useState<PtoAdminProfileDetail | null>(null);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileLoading, setProfileLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [profileAction, setProfileAction] = useState<string | null>(null);
  const [profileError, setProfileError] = useState<string | null>(null);
  const [newEmail, setNewEmail] = useState('');
  const [emailMembershipId, setEmailMembershipId] = useState('');
  const [cycleStart, setCycleStart] = useState('');
  const [adjustmentDays, setAdjustmentDays] = useState('');
  const [adjustmentReason, setAdjustmentReason] = useState('');
  const [detachTarget, setDetachTarget] = useState<PtoRawRecord | null>(null);
  const [deactivateOpen, setDeactivateOpen] = useState(false);
  const [deactivating, setDeactivating] = useState(false);

  const selectedFranchiseId = selectorAllowed ? Number(franchiseIdInput) : sessionFranchiseId;
  const validSelection = selectedFranchiseId !== null && Number.isSafeInteger(selectedFranchiseId)
    && selectedFranchiseId > 0;
  const scopeCurrent = validSelection && selectedFranchiseId === appliedFranchiseId;

  const loadProgramData = async (franchiseId: number, page = 1, search = appliedSearch) => {
    setDataLoading(true);
    try {
      const [profilePage, auditPage] = await Promise.all([
        fetchAdminPtoProfiles({ franchiseId, search, page, pageSize: 25 }),
        fetchAdminPtoAudit({ franchiseId, page: 1, pageSize: 25 })
      ]);
      setProfiles(profilePage);
      setAudit(auditPage);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Unable to load PTO management data';
      setError(message);
      toast.error(message);
    } finally {
      setDataLoading(false);
    }
  };

  const load = async (forcedFranchiseId?: number | null) => {
    const franchiseId = forcedFranchiseId ?? (validSelection ? selectedFranchiseId : null);
    if (franchiseId === null) {
      setError('Franchise ID is required.');
      return;
    }
    setLoading(true);
    setError(null);
    setAppliedFranchiseId(null);
    try {
      const next = await fetchFranchiseSettings(franchiseId);
      setSettings(next);
      setAppliedFranchiseId(franchiseId);
      setProfiles(null);
      setAudit(null);
      setSelectedProfile(null);
      setAppliedSearch('');
      setSearchInput('');
      if (next.ptoEnabled) await loadProgramData(franchiseId, 1, '');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Unable to load PTO settings';
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (sessionFranchiseId !== null) {
      setFranchiseIdInput(String(sessionFranchiseId));
      void load(sessionFranchiseId);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionFranchiseId]);

  const openActivationPreview = async () => {
    if (appliedFranchiseId === null || !scopeCurrent) return;
    setPreviewing(true);
    setError(null);
    try {
      const result = await fetchPtoActivationPreview(appliedFranchiseId);
      setPreview(result);
      setPreviewOpen(true);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Unable to preview PTO activation';
      setError(message);
      toast.error(message);
    } finally {
      setPreviewing(false);
    }
  };

  const activate = async () => {
    if (appliedFranchiseId === null || !preview) return;
    setActivating(true);
    setError(null);
    try {
      const sync = await activatePtoCenter(appliedFranchiseId);
      setSettings((current) => current ? {
        ...current,
        ptoEnabled: true,
        ptoFirstActivatedAt: current.ptoFirstActivatedAt ?? sync.lastSuccessfulSyncAt,
        ptoLastSuccessfulSyncAt: sync.lastSuccessfulSyncAt
      } : current);
      setPreviewOpen(false);
      setPreview(null);
      await loadProgramData(appliedFranchiseId, 1, '');
      toast.success(`PTO activated for ${sync.activeTutorCount} active tutors`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Unable to activate PTO';
      setError(message);
      toast.error(message);
    } finally {
      setActivating(false);
    }
  };

  const loadProfile = async (profileId: string) => {
    if (appliedFranchiseId === null || !scopeCurrent) return;
    setProfileLoading(true);
    setError(null);
    try {
      const detail = await fetchAdminPtoProfile(appliedFranchiseId, profileId);
      setSelectedProfile(detail);
      setEmailMembershipId(detail.memberships[0] ? recordId(detail.memberships[0]) : '');
      setProfileError(null);
      setProfileOpen(true);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Unable to load PTO profile';
      setError(message);
      toast.error(message);
    } finally {
      setProfileLoading(false);
    }
  };

  const refreshProfile = async (profileId: string) => {
    if (appliedFranchiseId === null) return;
    const detail = await fetchAdminPtoProfile(appliedFranchiseId, profileId);
    setSelectedProfile(detail);
    setEmailMembershipId((current) => current || (detail.memberships[0] ? recordId(detail.memberships[0]) : ''));
  };

  const runProfileAction = async (key: string, action: () => Promise<unknown>, success: string) => {
    if (!selectedProfile) return;
    setProfileAction(key);
    setProfileError(null);
    try {
      await action();
      await refreshProfile(selectedProfile.id);
      toast.success(success);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Unable to update PTO profile';
      setProfileError(message);
      toast.error(message);
    } finally {
      setProfileAction(null);
    }
  };

  const syncRoster = async () => {
    if (appliedFranchiseId === null || !scopeCurrent) return;
    setSyncing(true);
    setError(null);
    try {
      const result = await syncPtoCenter(appliedFranchiseId);
      setSettings((current) => current ? { ...current, ptoLastSuccessfulSyncAt: result.lastSuccessfulSyncAt } : current);
      await loadProgramData(appliedFranchiseId, 1, appliedSearch);
      toast.success(`Roster synced for ${result.activeTutorCount} active tutors`);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Unable to sync PTO roster';
      setError(message);
      toast.error(message);
    } finally {
      setSyncing(false);
    }
  };

  const confirmAlias = (candidate: PtoRawRecord, decision: 'confirm' | 'reject') => {
    if (appliedFranchiseId === null) return;
    const candidateId = recordId(candidate);
    void runProfileAction(`candidate-${candidateId}`, () => decidePtoAlias({
      franchiseId: appliedFranchiseId, candidateId, decision
    }), decision === 'confirm' ? 'Identity match confirmed' : 'Identity match rejected');
  };

  const addEmail = () => {
    if (!selectedProfile || appliedFranchiseId === null) return;
    void runProfileAction('add-email', () => addAdminPtoEmail({
      franchiseId: appliedFranchiseId,
      profileId: selectedProfile.id,
      membershipId: emailMembershipId,
      email: newEmail.trim()
    }), 'Alternate email added').then(() => setNewEmail(''));
  };

  const removeEmail = (record: PtoRawRecord) => {
    if (!selectedProfile || appliedFranchiseId === null) return;
    const emailId = recordId(record);
    void runProfileAction(`email-${emailId}`, () => removeAdminPtoEmail({
      franchiseId: appliedFranchiseId, profileId: selectedProfile.id, emailId
    }), 'Alternate email removed');
  };

  const applyAdjustment = () => {
    if (!selectedProfile || appliedFranchiseId === null) return;
    void runProfileAction('adjustment', () => adjustAdminPtoBalance({
      franchiseId: appliedFranchiseId,
      profileId: selectedProfile.id,
      cycleStart,
      deltaDays: Number(adjustmentDays),
      reason: adjustmentReason.trim()
    }), 'PTO balance adjusted').then(() => {
      setAdjustmentDays('');
      setAdjustmentReason('');
    });
  };

  const confirmDetach = () => {
    if (!selectedProfile || !detachTarget || appliedFranchiseId === null) return;
    const membershipId = recordId(detachTarget);
    void runProfileAction(`membership-${membershipId}`, () => detachPtoMembership({
      franchiseId: appliedFranchiseId, profileId: selectedProfile.id, membershipId
    }), 'Center membership detached').then(() => setDetachTarget(null));
  };

  const deactivate = async () => {
    if (appliedFranchiseId === null || !scopeCurrent) return;
    setDeactivating(true);
    setError(null);
    try {
      const center = await deactivatePtoCenter(appliedFranchiseId);
      setSettings((current) => current ? {
        ...current,
        ptoEnabled: center.enabled,
        ptoFirstActivatedAt: center.firstActivatedAt,
        ptoLastSuccessfulSyncAt: center.lastSuccessfulSyncAt
      } : current);
      setProfiles(null);
      setAudit(null);
      setSelectedProfile(null);
      setProfileOpen(false);
      setDeactivateOpen(false);
      toast.success('PTO deactivated for this center');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Unable to deactivate PTO';
      setError(message);
      toast.error(message);
    } finally {
      setDeactivating(false);
    }
  };

  const changeProfilePage = async (page: number) => {
    if (appliedFranchiseId === null || page < 1) return;
    await loadProgramData(appliedFranchiseId, page, appliedSearch);
  };

  const searchProfiles = async () => {
    if (appliedFranchiseId === null || !scopeCurrent) return;
    const search = searchInput.trim();
    setAppliedSearch(search);
    await loadProgramData(appliedFranchiseId, 1, search);
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold text-foreground">PTO Management</h1>
          <p className="text-sm text-muted-foreground">Activate and administer shared cross-center PTO.</p>
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={loading || !validSelection}>Refresh</Button>
      </div>

      {selectorAllowed ? (
        <Card>
          <CardHeader>
            <CardTitle>Franchise context</CardTitle>
            <CardDescription>PTO activation and roster data are scoped to the selected center.</CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-end gap-3">
            <div className="w-60 space-y-2">
              <Label htmlFor="ptoFranchiseId" requiredMark>Franchise ID</Label>
              <Input id="ptoFranchiseId" inputMode="numeric" value={franchiseIdInput}
                onChange={(event) => setFranchiseIdInput(event.target.value)} />
            </div>
            <Button onClick={() => void load()} disabled={loading || !validSelection}>
              {loading ? 'Loading...' : 'Apply'}
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle>Center PTO program</CardTitle>
              <CardDescription>PTO remains disabled until an administrator previews and confirms activation.</CardDescription>
            </div>
            {loading ? <Skeleton className="h-6 w-24" /> : (
              <Badge variant={settings?.ptoEnabled ? 'success' : 'muted'}>
                {settings?.ptoEnabled ? 'PTO is active' : 'PTO is disabled'}
              </Badge>
            )}
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-3 text-sm sm:grid-cols-2">
            <p><span className="font-semibold">First activated:</span>{' '}
              {settings?.ptoFirstActivatedAt ? new Date(settings.ptoFirstActivatedAt).toLocaleString() : 'Never'}</p>
            <p><span className="font-semibold">Last successful sync:</span>{' '}
              {settings?.ptoLastSuccessfulSyncAt ? new Date(settings.ptoLastSuccessfulSyncAt).toLocaleString() : 'Never'}</p>
          </div>
          <InlineError message={error} />
          {settings && !scopeCurrent ? (
            <p className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm font-semibold text-amber-900">
              Apply the selected franchise to refresh PTO data.
            </p>
          ) : null}
          {!settings?.ptoEnabled ? (
            <Button onClick={() => void openActivationPreview()} disabled={loading || previewing || !scopeCurrent}>
              {previewing ? 'Preparing preview...' : 'Preview activation'}
            </Button>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button onClick={() => void syncRoster()} disabled={loading || syncing || !scopeCurrent}>
                {syncing ? 'Syncing...' : 'Sync roster'}
              </Button>
              <Button variant="outline" onClick={() => setDeactivateOpen(true)} disabled={loading || syncing || !scopeCurrent}>
                Deactivate PTO
              </Button>
            </div>
          )}
        </CardContent>
      </Card>

      {settings?.ptoEnabled ? (
        <Tabs value={tab} onValueChange={(value) => setTab(value as 'profiles' | 'audit')}>
          <TabsList>
            <TabsTrigger value="profiles" onClick={() => setTab('profiles')}>Shared profiles</TabsTrigger>
            <TabsTrigger value="audit" onClick={() => setTab('audit')}>Audit history</TabsTrigger>
          </TabsList>

          <TabsContent value="profiles" className="mt-4">
            <Card>
              <CardHeader>
                <CardTitle>Shared PTO profiles</CardTitle>
                <CardDescription>{profiles?.total ?? 0} shared profiles</CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="flex flex-wrap items-end gap-3">
                  <div className="min-w-64 flex-1 space-y-2">
                    <Label htmlFor="ptoProfileSearch">Search name or email</Label>
                    <Input id="ptoProfileSearch" value={searchInput}
                      onChange={(event) => setSearchInput(event.target.value)}
                      onKeyDown={(event) => { if (event.key === 'Enter') void searchProfiles(); }} />
                  </div>
                  <Button variant="outline" onClick={() => void searchProfiles()} disabled={dataLoading || !scopeCurrent}>
                    Search
                  </Button>
                </div>

                {dataLoading && !profiles ? (
                  <div className="space-y-2"><Skeleton className="h-12 w-full" /><Skeleton className="h-12 w-full" /></div>
                ) : profiles?.items.length ? (
                  <Table>
                    <TableHeader><TableRow>
                      <TableHead>Person</TableHead><TableHead>Identity</TableHead><TableHead>Available</TableHead><TableHead />
                    </TableRow></TableHeader>
                    <TableBody>
                      {profiles.items.map((profile) => {
                        const name = `${profile.firstName} ${profile.lastName}`;
                        return (
                          <TableRow key={profile.id}>
                            <TableCell><p className="font-semibold text-foreground">{name}</p><p className="text-xs text-muted-foreground">Profile {profile.id}</p></TableCell>
                            <TableCell><Badge variant={profile.identityStatus === 'confirmed' ? 'success' : 'warning'}>{profile.identityStatus}</Badge></TableCell>
                            <TableCell>{profile.balance.availableDays} days</TableCell>
                            <TableCell className="text-right">
                              <Button variant="outline" size="sm" aria-label={`View ${name}`}
                                onClick={() => void loadProfile(profile.id)} disabled={profileLoading}>View</Button>
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                ) : <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No PTO profiles match this center and search.</p>}

                <div className="flex items-center justify-between gap-3">
                  <Button variant="outline" size="sm" aria-label="Previous page"
                    onClick={() => void changeProfilePage((profiles?.page ?? 1) - 1)}
                    disabled={dataLoading || (profiles?.page ?? 1) <= 1}>Previous</Button>
                  <p className="text-sm text-muted-foreground">Page {profiles?.page ?? 1} of {pageCount(profiles)}</p>
                  <Button variant="outline" size="sm" aria-label="Next page"
                    onClick={() => void changeProfilePage((profiles?.page ?? 1) + 1)}
                    disabled={dataLoading || (profiles?.page ?? 1) >= pageCount(profiles)}>Next</Button>
                </div>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="audit" className="mt-4">
            <Card>
              <CardHeader><CardTitle>Audit history</CardTitle><CardDescription>Append-only PTO administration events for this center.</CardDescription></CardHeader>
              <CardContent>
                {audit?.items.length ? (
                  <Table>
                    <TableHeader><TableRow><TableHead>Event</TableHead><TableHead>Profile</TableHead><TableHead>Actor</TableHead><TableHead>When</TableHead></TableRow></TableHeader>
                    <TableBody>{audit.items.map((event) => (
                      <TableRow key={event.id}>
                        <TableCell className="font-semibold">{humanize(event.eventType)}</TableCell>
                        <TableCell>{event.profileId ?? 'Center-wide'}</TableCell>
                        <TableCell>{event.actorId}</TableCell>
                        <TableCell>{formatDateTime(event.createdAt)}</TableCell>
                      </TableRow>
                    ))}</TableBody>
                  </Table>
                ) : <p className="rounded-lg border border-dashed p-6 text-center text-sm text-muted-foreground">No PTO audit events yet.</p>}
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      ) : null}

      <Dialog open={profileOpen} onOpenChange={setProfileOpen}>
        <DialogContent className="max-h-[90vh] max-w-5xl overflow-y-auto">
          {selectedProfile ? (
            <>
              <DialogHeader>
                <DialogTitle>{selectedProfile.firstName} {selectedProfile.lastName}</DialogTitle>
                <DialogDescription>Shared profile {selectedProfile.id} · {selectedProfile.identityStatus} identity</DialogDescription>
              </DialogHeader>
              <div className="grid gap-3 sm:grid-cols-4">
                <DetailMetric label="Granted" value={`${selectedProfile.balance.grantedDays} days`} />
                <DetailMetric label="Balance" value={`${selectedProfile.balance.balanceDays} days`} />
                <DetailMetric label="Reserved" value={`${selectedProfile.balance.reservedDays} days`} />
                <DetailMetric label="Available" value={`${selectedProfile.balance.availableDays} days`} />
              </div>
              <InlineError message={profileError} />

              <DetailSection title="Center memberships">
                {selectedProfile.memberships.map((record) => (
                  <div key={recordId(record)} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm">
                    <p className="font-semibold">Tutor {recordText(record, 'tutor_id')} · Center {recordText(record, 'franchiseid')}</p>
                    <Button variant="outline" size="sm" aria-label={`Detach membership ${recordId(record)}`}
                      onClick={() => setDetachTarget(record)} disabled={profileAction !== null}>Detach</Button>
                  </div>
                ))}
              </DetailSection>

              <DetailSection title="Email addresses">
                {selectedProfile.emails.map((record) => (
                  <div key={recordId(record)} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm">
                    <div><p className="font-semibold">{recordText(record, 'email')}</p>
                      <p className="text-xs text-muted-foreground">{humanize(recordText(record, 'source'))} · Center {recordText(record, 'franchiseid')}</p></div>
                    {recordText(record, 'source') === 'manual' ? (
                      <Button variant="outline" size="sm" aria-label={`Remove ${recordText(record, 'email')}`}
                        onClick={() => removeEmail(record)} disabled={profileAction !== null}>Remove</Button>
                    ) : null}
                  </div>
                ))}
                <div className="grid gap-3 rounded-lg border border-dashed p-3 sm:grid-cols-[1fr_180px_auto] sm:items-end">
                  <div className="space-y-2"><Label htmlFor="adminPtoEmail">Alternate email</Label>
                    <Input id="adminPtoEmail" type="email" value={newEmail} onChange={(event) => setNewEmail(event.target.value)} /></div>
                  <div className="space-y-2"><Label htmlFor="adminPtoEmailMembership">Source membership</Label>
                    <select id="adminPtoEmailMembership" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                      value={emailMembershipId} onChange={(event) => setEmailMembershipId(event.target.value)}>
                      {selectedProfile.memberships.map((record) => <option key={recordId(record)} value={recordId(record)}>Center {recordText(record, 'franchiseid')}</option>)}
                    </select></div>
                  <Button onClick={addEmail} disabled={profileAction !== null || !newEmail.trim() || !emailMembershipId}>Add alternate email</Button>
                </div>
              </DetailSection>

              <DetailSection title="Identity matches">
                {selectedProfile.candidates.map((record) => (
                  <div key={recordId(record)} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm">
                    <div><p className="font-semibold">Profile {recordText(record, 'left_profile_id')} ↔ Profile {recordText(record, 'right_profile_id')}</p>
                      <p className="text-xs text-muted-foreground">{humanize(recordText(record, 'status'))}</p></div>
                    {recordText(record, 'status') === 'pending' ? <div className="flex gap-2">
                      <Button size="sm" aria-label={`Confirm match ${recordId(record)}`} onClick={() => confirmAlias(record, 'confirm')}
                        disabled={profileAction !== null}>Confirm</Button>
                      <Button size="sm" variant="outline" aria-label={`Reject match ${recordId(record)}`} onClick={() => confirmAlias(record, 'reject')}
                        disabled={profileAction !== null}>Reject</Button>
                    </div> : null}
                  </div>
                ))}
              </DetailSection>

              <DetailSection title="Balance adjustment">
                <div className="grid gap-3 rounded-lg border p-3 sm:grid-cols-3">
                  <div className="space-y-2"><Label htmlFor="ptoCycleStart">Cycle start</Label>
                    <Input id="ptoCycleStart" type="date" value={cycleStart} onChange={(event) => setCycleStart(event.target.value)} /></div>
                  <div className="space-y-2"><Label htmlFor="ptoAdjustmentDays">Adjustment days</Label>
                    <Input id="ptoAdjustmentDays" type="number" step="0.5" value={adjustmentDays}
                      onChange={(event) => setAdjustmentDays(event.target.value)} /></div>
                  <div className="space-y-2"><Label htmlFor="ptoAdjustmentReason">Adjustment reason</Label>
                    <Input id="ptoAdjustmentReason" value={adjustmentReason} onChange={(event) => setAdjustmentReason(event.target.value)} /></div>
                </div>
                <Button onClick={applyAdjustment} disabled={profileAction !== null || !validAdjustment(cycleStart, adjustmentDays, adjustmentReason)}>
                  Apply balance adjustment
                </Button>
              </DetailSection>

              <DetailSection title="Ledger">
                {selectedProfile.ledger.map((record) => {
                  const delta = recordNumber(record, 'balance_delta');
                  return <RecordLine key={recordId(record)} text={`${humanize(recordText(record, 'event_type'))} ${delta >= 0 ? '+' : ''}${delta} days`}
                    detail={formatDateTime(recordText(record, 'created_at'))} />;
                })}
              </DetailSection>

              <DetailSection title="PTO requests">
                {selectedProfile.requests.map((record) => (
                  <RecordLine key={recordId(record)}
                    text={`Request ${recordId(record)} · ${recordNumber(record, 'charged_days')} day · ${humanize(recordText(record, 'state'))}`}
                    detail={`${formatDateTime(recordText(record, 'start_at'))} – ${formatDateTime(recordText(record, 'end_at'))}`} />
                ))}
              </DetailSection>
            </>
          ) : <Skeleton className="h-64 w-full" />}
        </DialogContent>
      </Dialog>

      <Dialog open={detachTarget !== null} onOpenChange={(open) => { if (!open && profileAction === null) setDetachTarget(null); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Detach center membership?</DialogTitle>
            <DialogDescription>This splits the selected center membership and its request allocations into a separate PTO profile.</DialogDescription></DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDetachTarget(null)} disabled={profileAction !== null}>Cancel</Button>
            <Button onClick={confirmDetach} disabled={profileAction !== null}>Confirm detachment</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deactivateOpen} onOpenChange={(open) => { if (!deactivating) setDeactivateOpen(open); }}>
        <DialogContent>
          <DialogHeader><DialogTitle>Deactivate PTO?</DialogTitle>
            <DialogDescription>New paid-time-off submissions will be blocked for this center. Existing reservations and ledger history are preserved.</DialogDescription></DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeactivateOpen(false)} disabled={deactivating}>Cancel</Button>
            <Button onClick={() => void deactivate()} disabled={deactivating}>{deactivating ? 'Deactivating...' : 'Confirm deactivation'}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={previewOpen} onOpenChange={(open) => { if (!activating) setPreviewOpen(open); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Activation preview</DialogTitle>
            <DialogDescription>
              Review the roster and shared entitlement policy before this center begins participating.
            </DialogDescription>
          </DialogHeader>
          {preview ? (
            <div className="space-y-4">
              <div className="grid gap-3 sm:grid-cols-2">
                <PreviewMetric value={preview.activeCrmTutorCount} label="active tutors" />
                <PreviewMetric value={preview.newMembershipCount} label="new memberships" />
                <PreviewMetric value={preview.newProfileCount} label="new profiles" />
                <PreviewMetric value={preview.pendingExactNameCandidateCount} label="identity matches" />
              </div>
              <p className="rounded-lg bg-muted p-3 text-sm">
                {preview.policy.entitlementDays} days per cycle, renewing {preview.policy.renewalMonth}/{preview.policy.renewalDay},
                {' '}{preview.policy.carryoverDays} carryover days.
              </p>
              {preview.warnings.map((warning) => (
                <p key={warning} className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-900">{warning}</p>
              ))}
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setPreviewOpen(false)} disabled={activating}>Cancel</Button>
            <Button onClick={() => void activate()} disabled={activating || !preview}>
              {activating ? 'Activating...' : 'Activate and sync'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function PreviewMetric({ value, label }: { value: number; label: string }): JSX.Element {
  return <p className="rounded-lg border bg-card p-3 text-sm font-semibold">{value} {label}</p>;
}

function DetailMetric({ label, value }: { label: string; value: string }): JSX.Element {
  return <div className="rounded-lg border bg-muted/30 p-3"><p className="text-xs font-semibold text-muted-foreground">{label}</p><p className="text-lg font-semibold">{value}</p></div>;
}

function DetailSection({ title, children }: { title: string; children: React.ReactNode }): JSX.Element {
  return <section className="space-y-2"><h3 className="text-sm font-semibold text-foreground">{title}</h3><div className="space-y-2">{children}</div></section>;
}

function RecordLine({ text, detail }: { text: string; detail?: string }): JSX.Element {
  return <div className="rounded-lg border p-3 text-sm"><p className="font-semibold">{text}</p>{detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}</div>;
}

const recordId = (record: PtoRawRecord): string => String(record.id ?? 'unknown');
const recordText = (record: PtoRawRecord, key: string): string => String(record[key] ?? '—');
const recordNumber = (record: PtoRawRecord, key: string): number => Number(record[key] ?? 0);
const humanize = (value: string): string => {
  const spaced = value.replace(/_/g, ' ');
  return spaced ? spaced[0].toUpperCase() + spaced.slice(1) : spaced;
};
const formatDateTime = (value: string): string => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
};
const pageCount = (page: PtoPagedResult<unknown> | null): number => Math.max(1, Math.ceil((page?.total ?? 0) / (page?.pageSize ?? 25)));
const validAdjustment = (cycle: string, delta: string, reason: string): boolean => {
  const value = Number(delta);
  return /^\d{4}-\d{2}-\d{2}$/.test(cycle) && Number.isFinite(value) && value !== 0
    && Math.abs(value * 2 - Math.round(value * 2)) < Number.EPSILON && reason.trim().length > 0;
};
