import { Session } from './api';

export const getSessionFranchiseId = (session: Session | null | undefined): number | null => {
  if (!session) return null;
  const parsed = Number(session.franchiseId);
  return Number.isFinite(parsed) ? parsed : null;
};

export const isSelectorAllowed = (session: Session | null | undefined): boolean => {
  const id = getSessionFranchiseId(session);
  return session?.accountType === 'ADMIN' && id !== null && [1, 2, 3].includes(id);
};
