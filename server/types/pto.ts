export type PtoEligibilityReason =
  | 'eligible'
  | 'center_disabled'
  | 'identity_unresolved'
  | 'no_balance'
  | 'insufficient_balance'
  | 'invalid_request';

export interface PtoBalanceSummary {
  cycleStart: string;
  cycleEnd: string;
  renewsOn: string;
  grantedDays: number;
  adjustedDays: number;
  availableDays: number;
  reservedDays: number;
  usedDays: number;
}

export interface PtoQuote {
  eligible: boolean;
  reason: PtoEligibilityReason;
  chargeDays: number;
  cycleAllocations: Array<{ cycleStart: string; days: number }>;
  balance?: PtoBalanceSummary;
}

export interface PtoPolicyStatus {
  enabled: boolean;
  reason: PtoEligibilityReason;
  balance?: PtoBalanceSummary;
}
