export type AccountType = 'TUTOR' | 'ADMIN';

export interface AuthSessionData {
  accountType: AccountType;
  accountId: number;
  franchiseId: number | null;
  displayName: string | null;
  createdAt: string;
  lastSeenAt: string;
}

export interface AccountCandidate {
  accountType: AccountType;
  accountId: number;
  franchiseId: number | null;
  displayName: string | null;
  password?: string | null;
  passwordHash?: string | null;
}

export interface SelectionAccount {
  accountType: AccountType;
  accountId: number;
  franchiseId: number | null;
  label: string;
}
