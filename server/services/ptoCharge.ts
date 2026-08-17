export type PtoChargeInput = {
  startDate: string;
  endDate: string;
  partialDay: boolean;
  durationHours?: number;
};

export type PtoDayCharge = {
  date: string;
  days: number;
  cycleStart: string;
  cycleEnd: string;
};

export type PtoCycleCharge = {
  cycleStart: string;
  cycleEnd: string;
  days: number;
};

export type PtoChargeQuote = {
  entitlementDays: 5;
  carryoverDays: 0;
  totalDays: number;
  dayCharges: PtoDayCharge[];
  cycleCharges: PtoCycleCharge[];
};

const formatDate = (date: Date): string => date.toISOString().slice(0, 10);

const parsePtoDate = (value: string): Date => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new RangeError('startDate and endDate must be valid ISO calendar dates');
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || formatDate(parsed) !== value) {
    throw new RangeError('startDate and endDate must be valid ISO calendar dates');
  }
  return parsed;
};

const ordinaryCharge = (date: Date): number => {
  const day = date.getUTCDay();
  if (day === 0) return 0;
  if (day === 6) return 0.5;
  return 1;
};

export const calculatePtoCharge = (input: PtoChargeInput): PtoChargeQuote => {
  const start = parsePtoDate(input.startDate);
  const end = parsePtoDate(input.endDate);
  if (end < start) throw new RangeError('endDate must not precede startDate');
  if (
    input.partialDay &&
    input.startDate === input.endDate &&
    (!Number.isFinite(input.durationHours) || Number(input.durationHours) <= 0)
  ) {
    throw new RangeError('durationHours must be positive and finite for same-day partial PTO');
  }
  const dayCharges: PtoDayCharge[] = [];

  for (const date = new Date(start); date <= end; date.setUTCDate(date.getUTCDate() + 1)) {
    const year = date.getUTCFullYear();
    const isSameDayPartial = input.partialDay && input.startDate === input.endDate;
    dayCharges.push({
      date: formatDate(date),
      days: isSameDayPartial ? (Number(input.durationHours) <= 4 ? 0.5 : 1) : ordinaryCharge(date),
      cycleStart: `${year}-01-01`,
      cycleEnd: `${year}-12-31`
    });
  }

  if (input.partialDay && input.startDate !== input.endDate) {
    const eligibleCharges = dayCharges.filter((charge) => charge.days > 0);
    const first = eligibleCharges[0];
    const last = eligibleCharges[eligibleCharges.length - 1];
    if (first) first.days = 0.5;
    if (last) last.days = 0.5;
  }

  const totalDays = dayCharges.reduce((sum, charge) => sum + charge.days, 0);
  const cycleCharges = dayCharges.reduce<PtoCycleCharge[]>((cycles, charge) => {
    const current = cycles[cycles.length - 1];
    if (current?.cycleStart === charge.cycleStart) {
      current.days += charge.days;
    } else {
      cycles.push({
        cycleStart: charge.cycleStart,
        cycleEnd: charge.cycleEnd,
        days: charge.days
      });
    }
    return cycles;
  }, []);
  return {
    entitlementDays: 5,
    carryoverDays: 0,
    totalDays,
    dayCharges,
    cycleCharges
  };
};
