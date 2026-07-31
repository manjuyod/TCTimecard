import { describe, expect, it } from 'vitest';
import {
  buildPayrollSettingsPayload,
  toPayrollSettingsFormState
} from './settingsModel';

describe('admin settings payroll form', () => {
  it('maps nullable API day values to editable strings', () => {
    expect(toPayrollSettingsFormState({
      franchiseId: 77,
      timezone: 'America/Los_Angeles',
      payPeriodType: 'biweekly',
      customPeriod1StartDay: null,
      customPeriod1EndDay: null,
      customPeriod2StartDay: null,
      customPeriod2EndDay: null
    })).toEqual({
      payPeriodType: 'biweekly',
      customPeriod1StartDay: '',
      customPeriod1EndDay: '',
      customPeriod2StartDay: '',
      customPeriod2EndDay: ''
    });
  });

  it('rejects incomplete custom semimonthly days', () => {
    expect(buildPayrollSettingsPayload({
      payPeriodType: 'custom_semimonthly',
      customPeriod1StartDay: '11',
      customPeriod1EndDay: '25',
      customPeriod2StartDay: '',
      customPeriod2EndDay: '10'
    }, 77)).toEqual({
      ok: false,
      error: 'Custom recurring payroll day values must be integers between 1 and 31.'
    });
  });

  it('builds all four valid custom days', () => {
    expect(buildPayrollSettingsPayload({
      payPeriodType: 'custom_semimonthly',
      customPeriod1StartDay: '11',
      customPeriod1EndDay: '25',
      customPeriod2StartDay: '26',
      customPeriod2EndDay: '10'
    }, 77)).toEqual({
      ok: true,
      payload: {
        franchiseId: 77,
        payPeriodType: 'custom_semimonthly',
        customPeriod1StartDay: 11,
        customPeriod1EndDay: 25,
        customPeriod2StartDay: 26,
        customPeriod2EndDay: 10
      }
    });
  });
});
