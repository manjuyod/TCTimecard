export type Id = string;

export interface PtoProgramPolicy {
  id: Id;
  effectiveFrom: string;
  entitlementDays: number;
  renewalMonth: number;
  renewalDay: number;
  carryoverDays: number;
}

export interface PtoCenterStatus {
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

export interface PtoActivationPreviewBase {
  activeCrmTutorCount: number;
  newMembershipCount: number;
  newProfileCount: number;
  pendingExactNameCandidateCount: number;
  warnings: string[];
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
}

export interface PtoRosterSyncSummary {
  activeTutorCount: number;
  activatedMembershipCount: number;
  deactivatedMembershipCount: number;
  createdProfileCount: number;
  pendingCandidateCount: number;
  lastSuccessfulSyncAt: string;
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
  identityStatus: 'pending' | 'confirmed';
  active: boolean;
  balance: PtoBalance;
}

export interface PtoTutorProfileResult {
  profile: PtoProfileSummary | null;
  memberships: Record<string, unknown>[];
  emails: Record<string, unknown>[];
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
  memberships: Record<string, unknown>[];
  emails: Record<string, unknown>[];
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

export interface AdjustPtoBalanceInput {
  profileId: Id;
  cycleStart: string;
  deltaDays: number;
  reason: string;
  actorId: Id;
  actorFranchiseId: number;
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
}

export interface PtoServiceStore {
  getProgramPolicy(): Promise<PtoProgramPolicy>;
  getCenterStatus(franchiseId: number): Promise<PtoCenterStatus>;
  previewActivation(franchiseId: number, tutors: PtoRosterTutor[]): Promise<PtoActivationPreviewBase>;
  syncRoster(input: PtoRosterSyncStoreInput): Promise<PtoRosterSyncSummary>;
  getTutorProfile(input: { franchiseId: number; tutorId: number }): Promise<PtoTutorProfileResult>;
  listAdminProfiles(input: NormalizedListAdminPtoProfilesInput): Promise<PagedResult<PtoProfileSummary>>;
  getAdminProfile(input: { franchiseId: number; profileId: Id }): Promise<PtoAdminProfileDetail | null>;
  decideAlias(input: PtoAliasDecisionInput): Promise<{ profileId: Id; decision: 'confirm' | 'reject' }>;
  detachMembership(input: DetachPtoMembershipInput): Promise<{ sourceProfileId: Id; detachedProfileId: Id }>;
  addEmail(input: AddPtoEmailInput): Promise<PtoEmail>;
  removeEmail(input: RemovePtoEmailInput): Promise<PtoEmail>;
  adjustBalance(input: AdjustPtoBalanceInput): Promise<PtoBalanceAdjustmentResult>;
  listAudit(input: NormalizedListPtoAuditInput): Promise<PagedResult<PtoAuditEvent>>;
  runInTransaction<T>(work: (store: PtoServiceStore) => Promise<T>): Promise<T>;
}
