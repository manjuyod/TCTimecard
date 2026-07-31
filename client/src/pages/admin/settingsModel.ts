import type { PayrollSettings, PayPeriodType } from '../../lib/api';

export type PayrollSettingsFormState = {
  payPeriodType: PayPeriodType;
  customPeriod1StartDay: string;
  customPeriod1EndDay: string;
  customPeriod2StartDay: string;
  customPeriod2EndDay: string;
};

export const EMPTY_PAYROLL_SETTINGS_FORM: PayrollSettingsFormState = {
  payPeriodType: 'biweekly',
  customPeriod1StartDay: '', customPeriod1EndDay: '',
  customPeriod2StartDay: '', customPeriod2EndDay: ''
};

export const toPayrollSettingsFormState = (
  settings: PayrollSettings
): PayrollSettingsFormState => ({
  payPeriodType: settings.payPeriodType,
  customPeriod1StartDay: settings.customPeriod1StartDay?.toString() ?? '',
  customPeriod1EndDay: settings.customPeriod1EndDay?.toString() ?? '',
  customPeriod2StartDay: settings.customPeriod2StartDay?.toString() ?? '',
  customPeriod2EndDay: settings.customPeriod2EndDay?.toString() ?? ''
});

const parseDay = (value: string): number | null => {
  const parsed = Number(value.trim());
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 31 ? parsed : null;
};

export const buildPayrollSettingsPayload = (
  form: PayrollSettingsFormState,
  franchiseId: number
): { ok: true; payload: Parameters<typeof import('../../lib/api').updatePayrollSettings>[0] }
 | { ok: false; error: string } => {
  if (form.payPeriodType !== 'custom_semimonthly') {
    return { ok: true, payload: { franchiseId, payPeriodType: form.payPeriodType } };
  }
  const values = [form.customPeriod1StartDay, form.customPeriod1EndDay,
    form.customPeriod2StartDay, form.customPeriod2EndDay].map(parseDay);
  if (values.some((value) => value === null)) {
    return { ok: false, error: 'Custom recurring payroll day values must be integers between 1 and 31.' };
  }
  return { ok: true, payload: {
    franchiseId, payPeriodType: form.payPeriodType,
    customPeriod1StartDay: values[0]!, customPeriod1EndDay: values[1]!,
    customPeriod2StartDay: values[2]!, customPeriod2EndDay: values[3]!
  } };
};
