import type {
  AddPtoEmailInput,
  AdjustPtoBalanceInput,
  DetachPtoMembershipInput,
  Id,
  ListAdminPtoProfilesInput,
  ListPtoAuditInput,
  PtoAliasDecisionInput,
  PtoServiceStore,
  PtoTutorRosterSource,
  RemovePtoEmailInput
} from './contracts';

const page = (value: number | undefined): number =>
  Number.isInteger(value) && Number(value) > 0 ? Number(value) : 1;

const pageSize = (value: number | undefined): number =>
  Math.min(100, Number.isInteger(value) && Number(value) > 0 ? Number(value) : 25);

const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export const normalizeManualPtoEmail = (value: string): string => {
  const normalized = value.trim().toLowerCase();
  if (normalized.length > 254 || !emailPattern.test(normalized)) {
    throw new RangeError('A valid email address is required');
  }
  return normalized;
};

export const createPtoService = (dependencies: {
  store: PtoServiceStore;
  rosterSource: PtoTutorRosterSource;
}) => {
  const { store, rosterSource } = dependencies;

  return {
    getPtoProgramPolicy: () => store.getProgramPolicy(),
    getPtoCenterStatus: (franchiseId: number) => store.getCenterStatus(franchiseId),
    previewPtoActivation: async (franchiseId: number) => {
      const [tutors, policy] = await Promise.all([
        rosterSource.fetchTutors(franchiseId),
        store.getProgramPolicy()
      ]);
      const activeTutors = tutors.filter((tutor) => !tutor.isDeleted);
      const preview = await store.previewActivation(franchiseId, activeTutors);
      return { ...preview, policy };
    },
    syncPtoRoster: async (input: { franchiseId: number; activate: boolean; actorId: Id }) => {
      const tutors = await rosterSource.fetchTutors(input.franchiseId);
      return store.runInTransaction((transactionalStore) =>
        transactionalStore.syncRoster({ ...input, tutors })
      );
    },
    getTutorPtoProfile: (input: { franchiseId: number; tutorId: number }) => store.getTutorProfile(input),
    listAdminPtoProfiles: (input: ListAdminPtoProfilesInput) => store.listAdminProfiles({
      franchiseId: input.franchiseId,
      search: input.search?.trim() ?? '',
      page: page(input.page),
      pageSize: pageSize(input.pageSize)
    }),
    getAdminPtoProfile: (input: { franchiseId: number; profileId: Id }) => store.getAdminProfile(input),
    decidePtoAlias: (input: PtoAliasDecisionInput) => store.runInTransaction((tx) => tx.decideAlias(input)),
    detachPtoMembership: (input: DetachPtoMembershipInput) =>
      store.runInTransaction((tx) => tx.detachMembership(input)),
    addPtoEmail: (input: AddPtoEmailInput) => store.runInTransaction((tx) => tx.addEmail({
      ...input,
      email: normalizeManualPtoEmail(input.email)
    })),
    removePtoEmail: (input: RemovePtoEmailInput) =>
      store.runInTransaction((tx) => tx.removeEmail(input)),
    adjustPtoBalance: async (input: AdjustPtoBalanceInput) => {
      if (!Number.isFinite(input.deltaDays) || input.deltaDays === 0) {
        throw new RangeError('PTO adjustment must be nonzero');
      }
      if (Math.abs(input.deltaDays * 2 - Math.round(input.deltaDays * 2)) > Number.EPSILON) {
        throw new RangeError('PTO adjustment must use 0.5-day increments');
      }
      const reason = input.reason.trim();
      if (!reason) throw new RangeError('PTO adjustment reason is required');
      return store.runInTransaction((tx) => tx.adjustBalance({ ...input, reason }));
    },
    listPtoAudit: (input: ListPtoAuditInput) => store.listAudit({
      franchiseId: input.franchiseId,
      profileId: input.profileId,
      page: page(input.page),
      pageSize: pageSize(input.pageSize)
    })
  };
};

export type PtoService = ReturnType<typeof createPtoService>;
