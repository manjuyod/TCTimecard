export * from './contracts';
export * from './service';
export * from './rosterSource';
export * from './discoverySource';
export * from './postgresStore';
export * from './postgresLinkStore';
export * from './postgresTypes';

import { getMssqlPool } from '../../db/mssql';
import { getPostgresPool } from '../../db/postgres';
import type {
  AddPtoEmailInput,
  AdjustPtoBalanceInput,
  AssignPtoAdjustmentProvenanceInput,
  DetachPtoMembershipInput,
  Id,
  ListAdminPtoProfilesInput,
  ListPtoAuditInput,
  PtoAliasDecisionInput,
  PtoAccountLinkBaseInput,
  PtoAccountLinkMutationInput,
  RemovePtoEmailInput
} from './contracts';
import { createPostgresPtoStore } from './postgresStore';
import { createMssqlPtoRosterSource } from './rosterSource';
import { createPtoService } from './service';

const getDefaultPtoService = () => createPtoService({
  store: createPostgresPtoStore(getPostgresPool()),
  rosterSource: createMssqlPtoRosterSource(getMssqlPool)
});

export const getPtoProgramPolicy = () => getDefaultPtoService().getPtoProgramPolicy();
export const getPtoCenterStatus = (franchiseId: number) =>
  getDefaultPtoService().getPtoCenterStatus(franchiseId);
export const previewPtoActivation = (franchiseId: number) =>
  getDefaultPtoService().previewPtoActivation(franchiseId);
export const syncPtoRoster = (input: { franchiseId: number; actorId: Id }) =>
  getDefaultPtoService().syncPtoRoster(input);
export const getTutorPtoProfile = (input: { franchiseId: number; tutorId: number }) =>
  getDefaultPtoService().getTutorPtoProfile(input);
export const listAdminPtoProfiles = (input: ListAdminPtoProfilesInput) =>
  getDefaultPtoService().listAdminPtoProfiles(input);
export const getAdminPtoProfile = (input: { franchiseId: number; profileId: Id }) =>
  getDefaultPtoService().getAdminPtoProfile(input);
export const decidePtoAlias = (input: PtoAliasDecisionInput) =>
  getDefaultPtoService().decidePtoAlias(input);
export const detachPtoMembership = (input: DetachPtoMembershipInput) =>
  getDefaultPtoService().detachPtoMembership(input);
export const addPtoEmail = (input: AddPtoEmailInput) => getDefaultPtoService().addPtoEmail(input);
export const removePtoEmail = (input: RemovePtoEmailInput) => getDefaultPtoService().removePtoEmail(input);
export const adjustPtoBalance = (input: AdjustPtoBalanceInput) =>
  getDefaultPtoService().adjustPtoBalance(input);
export const previewPtoAccountLink = (input: PtoAccountLinkBaseInput) =>
  getDefaultPtoService().previewPtoAccountLink(input);
export const linkPtoAccount = (input: PtoAccountLinkMutationInput) =>
  getDefaultPtoService().linkPtoAccount(input);
export const previewPtoAccountUnlink = (input: PtoAccountLinkBaseInput) =>
  getDefaultPtoService().previewPtoAccountUnlink(input);
export const unlinkPtoAccount = (input: PtoAccountLinkMutationInput) =>
  getDefaultPtoService().unlinkPtoAccount(input);
export const assignPtoAdjustmentProvenance = (input: AssignPtoAdjustmentProvenanceInput) =>
  getDefaultPtoService().assignPtoAdjustmentProvenance(input);
export const listPtoAudit = (input: ListPtoAuditInput) => getDefaultPtoService().listPtoAudit(input);
