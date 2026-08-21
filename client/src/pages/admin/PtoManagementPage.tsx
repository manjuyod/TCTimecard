import { useEffect, useState } from 'react';
import {
  activatePtoCenter,
  addAdminPtoEmail,
  adjustAdminPtoBalance,
  assignPtoAdjustmentProvenance,
  deactivatePtoCenter,
  fetchAdminPtoAudit,
  fetchAdminPtoProfile,
  fetchAdminPtoProfiles,
  fetchFranchiseSettings,
  fetchPtoActivationPreview,
  FranchiseSettings,
  PtoActivationPreview,
  PtoAccountLinkPreview,
  PtoAdminProfileDetail,
  PtoAuditEvent,
  PtoPagedResult,
  PtoProfileEmail,
  PtoProfileSummary,
  PtoRawRecord,
  linkPtoAccount,
  previewPtoAccountLink,
  previewPtoAccountUnlink,
  removeAdminPtoEmail,
  syncPtoCenter,
  unlinkPtoAccount
} from '../../lib/api';
import { ApiError } from '../../lib/errors';
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
import { PtoAccountLinksPanel, PtoAccountLinkIntent } from './pto/PtoAccountLinksPanel';
import { PtoLinkPreviewDialog } from './pto/PtoLinkPreviewDialog';

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
  const [adjustmentMembershipId, setAdjustmentMembershipId] = useState('');
  const [cycleStart, setCycleStart] = useState('');
  const [adjustmentDays, setAdjustmentDays] = useState('');
  const [adjustmentReason, setAdjustmentReason] = useState('');
  const [accountPreview, setAccountPreview] = useState<PtoAccountLinkPreview | null>(null);
  const [accountContextProfile, setAccountContextProfile] = useState<PtoAdminProfileDetail | null>(null);
  const [accountPreviewSource, setAccountPreviewSource] = useState<'profile' | 'activation'>('profile');
  const [accountPreviewing, setAccountPreviewing] = useState(false);
  const [accountConfirming, setAccountConfirming] = useState(false);
  const [provenanceSaving, setProvenanceSaving] = useState(false);
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
      setEmailMembershipId(detail.memberships[0]?.id ?? '');
      setAdjustmentMembershipId(detail.memberships[0]?.id ?? '');
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
    setEmailMembershipId((current) => current || detail.memberships[0]?.id || '');
    setAdjustmentMembershipId((current) => current || detail.memberships[0]?.id || '');
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

  const addEmail = () => {
    if (!selectedProfile || appliedFranchiseId === null) return;
    void runProfileAction('add-email', () => addAdminPtoEmail({
      franchiseId: appliedFranchiseId,
      profileId: selectedProfile.id,
      membershipId: emailMembershipId,
      email: newEmail.trim()
    }), 'Alternate email added').then(() => setNewEmail(''));
  };

  const removeEmail = (record: PtoProfileEmail) => {
    if (!selectedProfile || appliedFranchiseId === null) return;
    const emailId = record.id;
    void runProfileAction(`email-${emailId}`, () => removeAdminPtoEmail({
      franchiseId: appliedFranchiseId, profileId: selectedProfile.id, emailId
    }), 'Alternate email removed');
  };

  const applyAdjustment = () => {
    if (!selectedProfile || appliedFranchiseId === null) return;
    void runProfileAction('adjustment', () => adjustAdminPtoBalance({
      franchiseId: appliedFranchiseId,
      profileId: selectedProfile.id,
      membershipId: adjustmentMembershipId,
      cycleStart,
      deltaDays: Number(adjustmentDays),
      reason: adjustmentReason.trim()
    }), 'PTO balance adjusted').then(() => {
      setAdjustmentDays('');
      setAdjustmentReason('');
    });
  };

  const openAccountLinkPreview = async (
    profileId: string,
    intent: PtoAccountLinkIntent,
    source: 'profile' | 'activation'
  ) => {
    if (appliedFranchiseId === null) return;
    setAccountPreviewing(true);
    setProfileError(null);
    try {
      const args = {
        franchiseId: appliedFranchiseId,
        profileId,
        accountId: intent.account.id,
        expectedVersion: intent.account.version
      };
      const previewRequest = intent.mode === 'link' ? previewPtoAccountLink(args) : previewPtoAccountUnlink(args);
      const profileRequest = selectedProfile?.id === profileId
        ? Promise.resolve(selectedProfile)
        : fetchAdminPtoProfile(appliedFranchiseId, profileId);
      const [nextPreview, contextProfile] = await Promise.all([previewRequest, profileRequest]);
      setAccountPreview(nextPreview);
      setAccountContextProfile(contextProfile);
      setAccountPreviewSource(source);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Unable to preview PTO account change';
      if (source === 'profile') setProfileError(message);
      else setError(message);
      toast.error(message);
    } finally {
      setAccountPreviewing(false);
    }
  };

  const refreshStaleAccountContext = async (previewValue: PtoAccountLinkPreview) => {
    if (appliedFranchiseId === null) return;
    if (accountPreviewSource === 'profile') {
      const detail = await fetchAdminPtoProfile(appliedFranchiseId, previewValue.profileId);
      setSelectedProfile(detail);
      setAccountContextProfile(detail);
      setEmailMembershipId(detail.memberships[0]?.id ?? '');
      setAdjustmentMembershipId(detail.memberships[0]?.id ?? '');
      setProfileError('This account link changed. The profile was refreshed; review it and try again.');
    } else {
      setPreview(await fetchPtoActivationPreview(appliedFranchiseId));
      setError('This account link changed. The activation preview was refreshed; review it and try again.');
    }
  };

  const confirmAccountLink = async () => {
    if (!accountPreview || appliedFranchiseId === null) return;
    const currentPreview = accountPreview;
    setAccountConfirming(true);
    try {
      const args = {
        franchiseId: appliedFranchiseId,
        profileId: currentPreview.profileId,
        accountId: currentPreview.account.id,
        expectedVersion: currentPreview.version,
        idempotencyKey: crypto.randomUUID()
      };
      const response = currentPreview.mode === 'link' ? await linkPtoAccount(args) : await unlinkPtoAccount(args);
      setAccountContextProfile(response.profile);
      if (accountPreviewSource === 'profile') {
        setSelectedProfile(response.profile);
        setEmailMembershipId(response.profile.memberships[0]?.id ?? '');
        setAdjustmentMembershipId(response.profile.memberships[0]?.id ?? '');
      } else {
        setPreview(await fetchPtoActivationPreview(appliedFranchiseId));
      }
      setAccountPreview(null);
      toast.success(currentPreview.mode === 'link' ? 'PTO account linked' : 'PTO account unlinked');
    } catch (cause) {
      if (apiErrorCode(cause) === 'PTO_LINK_STALE') {
        setAccountPreview(null);
        await refreshStaleAccountContext(currentPreview);
        toast.error('The account link changed and the page was refreshed.');
      } else {
        const message = cause instanceof Error ? cause.message : 'Unable to update PTO account link';
        if (accountPreviewSource === 'profile') setProfileError(message);
        else setError(message);
        toast.error(message);
      }
    } finally {
      setAccountConfirming(false);
    }
  };

  const assignAdjustmentProvenance = async (ledgerEntryId: string, membershipId: string) => {
    if (!accountPreview || appliedFranchiseId === null) return;
    setProvenanceSaving(true);
    try {
      await assignPtoAdjustmentProvenance({
        franchiseId: appliedFranchiseId,
        profileId: accountPreview.profileId,
        ledgerEntryId,
        membershipId,
        idempotencyKey: crypto.randomUUID()
      });
      const args = {
        franchiseId: appliedFranchiseId,
        profileId: accountPreview.profileId,
        accountId: accountPreview.account.id,
        expectedVersion: accountPreview.version
      };
      setAccountPreview(accountPreview.mode === 'link'
        ? await previewPtoAccountLink(args)
        : await previewPtoAccountUnlink(args));
      toast.success('Adjustment provenance assigned');
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'Unable to assign adjustment provenance';
      toast.error(message);
    } finally {
      setProvenanceSaving(false);
    }
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

              <DetailSection title="Accounts and centers">
                <PtoAccountLinksPanel
                  accounts={selectedProfile.accounts}
                  disabled={profileAction !== null || accountPreviewing}
                  onIntent={(intent) => void openAccountLinkPreview(selectedProfile.id, intent, 'profile')}
                />
              </DetailSection>

              <DetailSection title="Active center memberships">
                {selectedProfile.memberships.map((record) => (
                  <div key={record.id} className="rounded-lg border p-3 text-sm">
                    <p className="font-semibold">Tutor {record.tutorId ?? '—'} · Center {record.franchiseId}</p>
                  </div>
                ))}
              </DetailSection>

              <DetailSection title="Email addresses">
                {selectedProfile.emails.map((record) => (
                  <div key={record.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3 text-sm">
                    <div><p className="font-semibold">{record.email}</p>
                      <p className="text-xs text-muted-foreground">{humanize(record.source)} · Center {record.franchiseId}</p></div>
                    {record.source === 'manual' ? (
                      <Button variant="outline" size="sm" aria-label={`Remove ${record.email}`}
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
                      {selectedProfile.memberships.map((record) => <option key={record.id} value={record.id}>Center {record.franchiseId}</option>)}
                    </select></div>
                  <Button onClick={addEmail} disabled={profileAction !== null || !newEmail.trim() || !emailMembershipId}>Add alternate email</Button>
                </div>
              </DetailSection>

              <DetailSection title="Identity matches">
                {selectedProfile.candidates.map((record) => (
                  <div key={recordId(record)} className="rounded-lg border p-3 text-sm">
                    <div><p className="font-semibold">Profile {recordText(record, 'left_profile_id')} ↔ Profile {recordText(record, 'right_profile_id')}</p>
                      <p className="text-xs text-muted-foreground">{humanize(recordText(record, 'status'))}</p></div>
                  </div>
                ))}
              </DetailSection>

              <DetailSection title="Balance adjustment">
                <div className="grid gap-3 rounded-lg border p-3 sm:grid-cols-4">
                  <div className="space-y-2"><Label htmlFor="ptoAdjustmentMembership">Source membership</Label>
                    <select id="ptoAdjustmentMembership" className="h-10 w-full rounded-md border border-input bg-background px-3 text-sm"
                      value={adjustmentMembershipId} onChange={(event) => setAdjustmentMembershipId(event.target.value)}>
                      {selectedProfile.memberships.map((record) => <option key={record.id} value={record.id}>Center {record.franchiseId}</option>)}
                    </select></div>
                  <div className="space-y-2"><Label htmlFor="ptoCycleStart">Cycle start</Label>
                    <Input id="ptoCycleStart" type="date" value={cycleStart} onChange={(event) => setCycleStart(event.target.value)} /></div>
                  <div className="space-y-2"><Label htmlFor="ptoAdjustmentDays">Adjustment days</Label>
                    <Input id="ptoAdjustmentDays" type="number" step="0.5" value={adjustmentDays}
                      onChange={(event) => setAdjustmentDays(event.target.value)} /></div>
                  <div className="space-y-2"><Label htmlFor="ptoAdjustmentReason">Adjustment reason</Label>
                    <Input id="ptoAdjustmentReason" value={adjustmentReason} onChange={(event) => setAdjustmentReason(event.target.value)} /></div>
                </div>
                <Button onClick={applyAdjustment} disabled={profileAction !== null || !adjustmentMembershipId
                  || !validAdjustment(cycleStart, adjustmentDays, adjustmentReason)}>
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
              {activationCandidateGroups(preview).map((group) => (
                <section key={group.profileId} className="space-y-2 rounded-lg border p-3">
                  <p className="text-sm font-semibold">Proposed profile: {group.profileName}</p>
                  <PtoAccountLinksPanel
                    accounts={group.accounts}
                    disabled={accountPreviewing}
                    onIntent={(intent) => void openAccountLinkPreview(group.profileId, intent, 'activation')}
                  />
                </section>
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

      {accountPreview ? (
        <PtoLinkPreviewDialog
          key={`${accountPreview.mode}-${accountPreview.account.id}-${accountPreview.version}-${accountPreview.ambiguousAdjustmentIds.join('-')}`}
          open
          preview={accountPreview}
          actorFranchiseId={appliedFranchiseId ?? 0}
          confirming={accountConfirming}
          memberships={accountContextProfile?.memberships ?? []}
          reconciling={provenanceSaving}
          onAssignProvenance={(ledgerEntryId, membershipId) => void assignAdjustmentProvenance(ledgerEntryId, membershipId)}
          onConfirm={() => void confirmAccountLink()}
          onOpenChange={(open) => {
            if (!open) {
              setAccountPreview(null);
              setAccountContextProfile(null);
            }
          }}
        />
      ) : null}
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

const apiErrorCode = (cause: unknown): string | null => {
  if (!(cause instanceof ApiError) || !cause.data || typeof cause.data !== 'object') return null;
  const code = (cause.data as Record<string, unknown>).code;
  return typeof code === 'string' ? code : null;
};

const activationCandidateGroups = (preview: PtoActivationPreview): Array<{
  profileId: string;
  profileName: string;
  accounts: PtoActivationPreview['candidateGroups'][number]['account'][];
}> => {
  const grouped = new Map<string, {
    profileId: string;
    profileName: string;
    accounts: PtoActivationPreview['candidateGroups'][number]['account'][];
  }>();
  for (const row of preview.candidateGroups ?? []) {
    const group = grouped.get(row.profileId) ?? { profileId: row.profileId, profileName: row.profileName, accounts: [] };
    group.accounts.push(row.account);
    grouped.set(row.profileId, group);
  }
  return [...grouped.values()];
};
