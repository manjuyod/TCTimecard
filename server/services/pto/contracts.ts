export type Id = string;

export interface PtoProgramPolicy {
  id: Id;
  effectiveFrom: string;
  entitlementDays: number;
  renewalMonth: number;
  renewalDay: number;
  carryoverDays: number;
}

export interface PtoSyncHealth {
  lastSuccessfulRosterSyncAt: string | null;
  lastRosterSyncError: string | null;
  lastSuccessfulDiscoveryAt: string | null;
  lastDiscoveryError: string | null;
}

export interface PtoCenterStatus extends PtoSyncHealth {
  franchiseId: number;
  enabled: boolean;
  firstActivatedAt: string | null;
  lastSuccessfulSyncAt: string | null;
  lastSyncError: string | null;
}

export interface PtoRosterTutor {
  id: number;
  franchiseId: number;
  firstName: string;
  lastName: string;
  email: string | null;
  isDeleted: boolean;
}

export interface PtoDiscoveredRosterAccount extends PtoRosterTutor {
  provider: string;
  crmId: string;
}

export type PtoAccountLinkStatus = 'pending' | 'linked' | 'excluded';

export interface PtoDiscoveredAccount {
  id: Id;
  provider: string;
  crmId: string;
  franchiseId: number;
  tutorId: number;
  firstName: string;
  lastName: string;
  displayEmail: string | null;
  crmActive: boolean;
  centerEnabled: boolean;
  membershipId: Id | null;
  status: PtoAccountLinkStatus;
  version: number;
  lastSeenAt: string;
  warnings: string[];
}

export interface PtoAccountLinkBaseInput {
  profileId: Id;
  accountId: Id;
  actorId: Id;
  actorFranchiseId: number;
  expectedVersion: number;
}

export interface PtoAccountLinkMutationInput extends PtoAccountLinkBaseInput {
  idempotencyKey: string;
}

export interface PtoAccountLinkPreview {
  mode: 'link' | 'unlink';
  profileId: Id;
  account: PtoDiscoveredAccount;
  version: number;
  beforeBalances: Array<{ profileId: Id; availableDays: number }>;
  afterBalances: Array<{ profileId: Id; availableDays: number }>;
  affectedRequestIds: Id[];
  ambiguousAdjustmentIds: Id[];
  warnings: string[];
}

export interface PtoAccountLinkMutationResult {
  canonicalProfileId: Id;
  detachedProfileId: Id | null;
  decisionVersion: number;
}

export interface PtoDiscoveryResult {
  accounts: PtoDiscoveredRosterAccount[];
  attemptedAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface PtoActivationPreviewBase extends PtoSyncHealth {
  activeCrmTutorCount: number;
  newMembershipCount: number;
  newProfileCount: number;
  discoveredAccountCount: number;
  linkedAccountCount: number;
  excludedAccountCount: number;
  pendingReviewCount: number;
  pendingExactNameCandidateCount: number;
  lastSuccessfulSyncAt: string | null;
  lastSyncError: string | null;
  candidateGroups: PtoActivationCandidateGroup[];
  warnings: string[];
}

export interface PtoActivationCandidateGroup {
  profileId: Id;
  profileName: string;
  account: PtoDiscoveredAccount;
}

export interface PtoActivationPreview extends PtoActivationPreviewBase {
  policy: PtoProgramPolicy;
}

export interface PtoRosterSyncInput {
  franchiseId: number;
  activate: boolean;
  actorId: Id;
}

export interface PtoRosterSyncStoreInput extends PtoRosterSyncInput {
  tutors: PtoRosterTutor[];
  discovery: PtoDiscoveryResult;
}

export interface PtoRosterSyncSummary extends PtoSyncHealth {
  activeTutorCount: number;
  activatedMembershipCount: number;
  deactivatedMembershipCount: number;
  createdProfileCount: number;
  discoveredAccountCount: number;
  linkedAccountCount: number;
  excludedAccountCount: number;
  pendingReviewCount: number;
  pendingCandidateCount: number;
  lastSuccessfulSyncAt: string;
  lastSyncError: string | null;
  warnings: string[];
}

export interface PtoBalance {
  grantedDays: number;
  balanceDays: number;
  reservedDays: number;
  availableDays: number;
}

export interface PtoProfileSummary {
  id: Id;
  firstName: string;
  lastName: string;
  active: boolean;
  balance: PtoBalance;
}

export interface PtoTutorProfileResult {
  profile: PtoProfileSummary | null;
  memberships: PtoMembership[];
  emails: PtoProfileEmail[];
  balance: PtoBalance | null;
  unresolvedReason: 'center_disabled' | 'membership_missing' | 'profile_inactive' | null;
}

export interface PagedResult<T> {
  items: T[];
  page: number;
  pageSize: number;
  total: number;
}

export interface ListAdminPtoProfilesInput {
  franchiseId: number;
  search?: string;
  page?: number;
  pageSize?: number;
}

export interface NormalizedListAdminPtoProfilesInput {
  franchiseId: number;
  search: string;
  page: number;
  pageSize: number;
}

export interface PtoAdminProfileDetail extends PtoProfileSummary {
  memberships: PtoMembership[];
  emails: PtoProfileEmail[];
  accounts: PtoDiscoveredAccount[];
  candidates: Record<string, unknown>[];
  ledger: Record<string, unknown>[];
  requests: Record<string, unknown>[];
  audit: Record<string, unknown>[];
}

export interface PtoAliasDecisionInput {
  candidateId: Id;
  decision: 'confirm' | 'reject';
  actorId: Id;
  actorFranchiseId: number;
}

export interface DetachPtoMembershipInput {
  profileId: Id;
  membershipId: Id;
  actorId: Id;
  actorFranchiseId: number;
}

export interface AddPtoEmailInput extends DetachPtoMembershipInput {
  email: string;
}

export interface RemovePtoEmailInput {
  profileId: Id;
  emailId: Id;
  actorId: Id;
  actorFranchiseId: number;
}

export interface PtoEmail {
  id: Id;
  email: string;
  active: boolean;
  source: 'crm' | 'manual';
  sourceMembershipId: Id | null;
}

export interface PtoProfileEmail extends PtoEmail {
  profileId: Id;
  franchiseId: number;
  createdAt: string;
  updatedAt: string;
}

export interface PtoMembership {
  id: Id;
  profileId: Id;
  franchiseId: number;
  tutorId: number | null;
  active: boolean;
  crmSnapshot: Record<string, unknown>;
  firstSeenAt: string;
  updatedAt: string;
}

export interface AdjustPtoBalanceInput {
  profileId: Id;
  membershipId: Id;
  cycleStart: string;
  deltaDays: number;
  reason: string;
  actorId: Id;
  actorFranchiseId: number;
}

export interface AssignPtoAdjustmentProvenanceInput {
  profileId: Id;
  ledgerEntryId: Id;
  membershipId: Id;
  actorId: Id;
  actorFranchiseId: number;
  idempotencyKey: string;
}

export interface PtoAdjustmentProvenanceResult {
  ledgerEntryId: Id;
  membershipId: Id;
}

export interface PtoBalanceAdjustmentResult {
  ledgerEntryId: Id;
  availableDays: number;
}

export interface ListPtoAuditInput {
  franchiseId: number;
  profileId?: Id;
  page?: number;
  pageSize?: number;
}

export interface NormalizedListPtoAuditInput {
  franchiseId: number;
  profileId?: Id;
  page: number;
  pageSize: number;
}

export interface PtoAuditEvent {
  id: Id;
  profileId: Id | null;
  franchiseId: number | null;
  actorId: Id;
  eventType: string;
  before: unknown;
  after: unknown;
  createdAt: string;
}

export interface PtoTutorRosterSource {
  fetchTutors(franchiseId: number): Promise<PtoRosterTutor[]>;
  discoverRelatedAccounts(tutors: PtoRosterTutor[]): Promise<PtoDiscoveryResult>;
}

export interface PtoServiceStore {
  getProgramPolicy(): Promise<PtoProgramPolicy>;
  getCenterStatus(franchiseId: number): Promise<PtoCenterStatus>;
  previewActivation(
    franchiseId: number,
    tutors: PtoRosterTutor[],
    discovery: PtoDiscoveryResult
  ): Promise<PtoActivationPreviewBase>;
  syncRoster(input: PtoRosterSyncStoreInput): Promise<PtoRosterSyncSummary>;
  getTutorProfile(input: { franchiseId: number; tutorId: number }): Promise<PtoTutorProfileResult>;
  listAdminProfiles(input: NormalizedListAdminPtoProfilesInput): Promise<PagedResult<PtoProfileSummary>>;
  getAdminProfile(input: { franchiseId: number; profileId: Id }): Promise<PtoAdminProfileDetail | null>;
  decideAlias(input: PtoAliasDecisionInput): Promise<{ profileId: Id; decision: 'confirm' | 'reject' }>;
  detachMembership(input: DetachPtoMembershipInput): Promise<{ sourceProfileId: Id; detachedProfileId: Id }>;
  addEmail(input: AddPtoEmailInput): Promise<PtoEmail>;
  removeEmail(input: RemovePtoEmailInput): Promise<PtoEmail>;
  adjustBalance(input: AdjustPtoBalanceInput): Promise<PtoBalanceAdjustmentResult>;
  previewAccountLink(input: PtoAccountLinkBaseInput): Promise<PtoAccountLinkPreview>;
  linkAccount(input: PtoAccountLinkMutationInput): Promise<PtoAccountLinkMutationResult>;
  previewAccountUnlink(input: PtoAccountLinkBaseInput): Promise<PtoAccountLinkPreview>;
  unlinkAccount(input: PtoAccountLinkMutationInput): Promise<PtoAccountLinkMutationResult>;
  assignAdjustmentProvenance(
    input: AssignPtoAdjustmentProvenanceInput
  ): Promise<PtoAdjustmentProvenanceResult>;
  listAudit(input: NormalizedListPtoAuditInput): Promise<PagedResult<PtoAuditEvent>>;
  runInTransaction<T>(work: (store: PtoServiceStore) => Promise<T>): Promise<T>;
}
