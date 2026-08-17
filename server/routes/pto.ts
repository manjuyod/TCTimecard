import express, { NextFunction, Request, Response } from 'express';
import { requireAdmin, requireTutor } from '../middleware/auth';
import { enforceFranchiseScope } from '../middleware/franchiseScope';
import { getFranchisePayrollSettings } from '../payroll/payPeriodResolution';
import { getFranchiseSettings } from '../services/franchiseSettings';
import {
  addPtoEmail, adjustPtoBalance, decidePtoAlias, detachPtoMembership, getAdminPtoProfile,
  getPtoCenterStatus, getPtoProgramPolicy, getTutorPtoProfile, listAdminPtoProfiles,
  listPtoAudit, previewPtoActivation, removePtoEmail, syncPtoRoster
} from '../services/pto';
import {
  authorizePublicPtoCenter, deactivatePtoCenter, getPtoBalanceSummary, quoteAuthenticatedPto, quotePublicPto,
  type AuthenticatedPtoQuoteInput, type PublicPtoQuoteInput
} from '../services/pto/routeStore';
import { mapPtoHttpError } from '../services/pto/errors';
import { calculatePtoCharge } from '../services/ptoCharge';
import { localDateForTimeZone, normalizeTimeOffSubmission } from '../services/timeOffPolicy';
import type { PtoBalanceSummary, PtoQuote } from '../types/pto';

type ServiceInput<T extends (...args: never[]) => unknown> = Parameters<T>[0];

export interface PtoRouteDeps {
  nowIso: () => string;
  resolveTimezone: (franchiseId: number) => Promise<string>;
  resolveTimeOffNoticeRequired: (franchiseId: number) => Promise<boolean>;
  getProgramPolicy: typeof getPtoProgramPolicy;
  getCenterStatus: typeof getPtoCenterStatus;
  previewActivation: typeof previewPtoActivation;
  syncRoster: typeof syncPtoRoster;
  deactivateCenter: typeof deactivatePtoCenter;
  getTutorProfile: typeof getTutorPtoProfile;
  getBalanceSummary: (profileId: string, balanceDate: string) => Promise<PtoBalanceSummary>;
  authorizePublicCenter: typeof authorizePublicPtoCenter;
  quoteAuthenticated: (input: AuthenticatedPtoQuoteInput) => Promise<PtoQuote>;
  quotePublic: (input: PublicPtoQuoteInput) => Promise<PtoQuote>;
  listProfiles: typeof listAdminPtoProfiles;
  getAdminProfile: typeof getAdminPtoProfile;
  decideAlias: typeof decidePtoAlias;
  detachMembership: typeof detachPtoMembership;
  addEmail: typeof addPtoEmail;
  removeEmail: typeof removePtoEmail;
  adjustBalance: typeof adjustPtoBalance;
  listAudit: typeof listPtoAudit;
}

const defaultDeps: PtoRouteDeps = {
  nowIso: () => new Date().toISOString(),
  resolveTimezone: async (franchiseId) => (await getFranchisePayrollSettings(franchiseId)).timezone,
  resolveTimeOffNoticeRequired: async (franchiseId) => (await getFranchiseSettings(franchiseId)).timeOffNoticeRequired,
  getProgramPolicy: getPtoProgramPolicy,
  getCenterStatus: getPtoCenterStatus,
  previewActivation: previewPtoActivation,
  syncRoster: syncPtoRoster,
  deactivateCenter: deactivatePtoCenter,
  getTutorProfile: getTutorPtoProfile,
  getBalanceSummary: getPtoBalanceSummary,
  authorizePublicCenter: authorizePublicPtoCenter,
  quoteAuthenticated: quoteAuthenticatedPto,
  quotePublic: quotePublicPto,
  listProfiles: listAdminPtoProfiles,
  getAdminProfile: getAdminPtoProfile,
  decideAlias: decidePtoAlias,
  detachMembership: detachPtoMembership,
  addEmail: addPtoEmail,
  removeEmail: removePtoEmail,
  adjustBalance: adjustPtoBalance,
  listAudit: listPtoAudit
};

export function createPtoRouter(overrides: Partial<PtoRouteDeps> = {}) {
  const deps = { ...defaultDeps, ...overrides };
  const router = express.Router();

  router.get('/pto/me', requireTutor, asyncHandler(async (req, res) => {
    const context = tutorContext(req);
    if (!context) return res.status(400).json({ error: 'Tutor context missing' });
    const nowIso = deps.nowIso();
    const [result, policy, center, timezone] = await Promise.all([
      deps.getTutorProfile(context), deps.getProgramPolicy(), deps.getCenterStatus(context.franchiseId),
      deps.resolveTimezone(context.franchiseId)
    ]);
    const balance = result.profile
      ? await deps.getBalanceSummary(result.profile.id, localDateForTimeZone(nowIso, timezone))
      : null;
    return res.json({ ...result, balance, policy, center });
  }));

  router.post('/pto/me/quote', requireTutor, asyncHandler(async (req, res) => {
    const context = tutorContext(req);
    if (!context) return res.status(400).json({ error: 'Tutor context missing' });
    const charge = await normalizedCharge(req, res, deps, context.franchiseId);
    if (!charge) return;
    try {
      return res.json(await deps.quoteAuthenticated({ ...context, ...charge }));
    } catch (error) {
      return sendPtoError(res, error);
    }
  }));

  router.post('/pto/me/emails', requireTutor, asyncHandler(async (req, res) => {
    const context = tutorContext(req);
    if (!context) return res.status(400).json({ error: 'Tutor context missing' });
    const email = manualEmail(req.body?.email);
    if (!email) return res.status(400).json({ error: 'A valid email address is required' });
    const identity = await tutorIdentity(deps, context);
    if (!identity) return res.status(422).json({ error: 'PTO identity is unresolved' });
    try {
      return res.status(201).json({ email: await deps.addEmail({
        profileId: identity.profileId, membershipId: identity.membershipId, email,
        actorId: String(context.tutorId), actorFranchiseId: context.franchiseId
      }) });
    } catch (error) { return sendPtoError(res, error); }
  }));

  router.delete('/pto/me/emails/:emailId', requireTutor, asyncHandler(async (req, res) => {
    const context = tutorContext(req);
    const emailId = id(req.params.emailId);
    if (!context) return res.status(400).json({ error: 'Tutor context missing' });
    if (!emailId) return res.status(400).json({ error: 'Invalid email id' });
    const result = await deps.getTutorProfile(context);
    const email = result.emails.find((item) => String(item.id) === emailId);
    if (!result.profile || !email) return res.status(404).json({ error: 'Email not found' });
    if (email.source !== 'manual') return res.status(403).json({ error: 'CRM email addresses cannot be removed' });
    return res.json({ email: await deps.removeEmail({
      profileId: result.profile.id, emailId, actorId: String(context.tutorId), actorFranchiseId: context.franchiseId
    }) });
  }));

  router.post('/pto/public/quote', asyncHandler(async (req, res) => {
    const authorization = req.get('authorization') ?? '';
    const match = /^Bearer ([^\s]+)$/i.exec(authorization);
    if (!match) return res.status(401).json({ error: 'A bearer center token is required' });
    const center = await deps.authorizePublicCenter(match[1]);
    if (!center) {
      return res.status(401).json({ error: 'Center link is invalid or inactive', code: 'PTO_CENTER_LINK_INVALID' });
    }
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    if (!email || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      return res.status(400).json({ error: 'A valid email address is required' });
    }
    const charge = await normalizedCharge(req, res, deps, center.franchiseId);
    if (!charge) return;
    try {
      const result = await deps.quotePublic({ franchiseId: center.franchiseId, email, ...charge });
      return res.json({ eligible: result.eligible, reason: result.reason, chargeDays: result.chargeDays,
        cycleAllocations: result.cycleAllocations });
    } catch (error) { return sendPtoError(res, error); }
  }));

  router.get('/pto/admin/activation-preview', requireAdmin, admin(async (req, res, franchiseId) =>
    res.json({ preview: await deps.previewActivation(franchiseId) })));
  router.post('/pto/admin/activate', requireAdmin, admin(async (req, res, franchiseId) =>
    res.json({ sync: await deps.syncRoster({ franchiseId, activate: true, actorId: actor(req) }) })));
  router.post('/pto/admin/deactivate', requireAdmin, admin(async (req, res, franchiseId) =>
    res.json({ center: await deps.deactivateCenter({ franchiseId, actorId: actor(req) }) })));
  router.post('/pto/admin/sync', requireAdmin, admin(async (req, res, franchiseId) =>
    res.json({ sync: await deps.syncRoster({ franchiseId, activate: false, actorId: actor(req) }) })));
  router.get('/pto/admin/profiles', requireAdmin, admin(async (req, res, franchiseId) => {
    const pagination = parsePagination(req, res); if (!pagination) return;
    return res.json(await deps.listProfiles({ franchiseId, search: text(req.query.search), ...pagination }));
  }));
  router.get('/pto/admin/profiles/:profileId', requireAdmin, admin(async (req, res, franchiseId) => {
    const profileId = requiredId(res, req.params.profileId, 'profile'); if (!profileId) return;
    const profile = await deps.getAdminProfile({ franchiseId, profileId });
    return profile ? res.json({ profile }) : res.status(404).json({ error: 'Profile not found' });
  }));
  router.post('/pto/admin/aliases/:candidateId/decide', requireAdmin, admin(async (req, res, franchiseId) => {
    const candidateId = requiredId(res, req.params.candidateId, 'candidate'); if (!candidateId) return;
    const decision = req.body?.decision === 'confirm' || req.body?.decision === 'reject' ? req.body.decision : null;
    if (!decision) return res.status(400).json({ error: 'decision must be confirm or reject' });
    return res.json(await deps.decideAlias({ candidateId, decision, actorId: actor(req), actorFranchiseId: franchiseId }));
  }));
  router.post('/pto/admin/profiles/:profileId/memberships/:membershipId/detach', requireAdmin, admin(async (req, res, franchiseId) => {
    const profileId = requiredId(res, req.params.profileId, 'profile');
    const membershipId = requiredId(res, req.params.membershipId, 'membership'); if (!profileId || !membershipId) return;
    return res.json(await deps.detachMembership({ profileId, membershipId, actorId: actor(req), actorFranchiseId: franchiseId }));
  }));
  router.post('/pto/admin/profiles/:profileId/emails', requireAdmin, admin(async (req, res, franchiseId) => {
    const profileId = requiredId(res, req.params.profileId, 'profile');
    const membershipId = requiredId(res, req.body?.membershipId, 'membership'); if (!profileId || !membershipId) return;
    const email = manualEmail(req.body?.email);
    if (!email) return res.status(400).json({ error: 'A valid email address is required' });
    return res.status(201).json({ email: await deps.addEmail({ profileId, membershipId, email, actorId: actor(req), actorFranchiseId: franchiseId }) });
  }));
  router.delete('/pto/admin/profiles/:profileId/emails/:emailId', requireAdmin, admin(async (req, res, franchiseId) => {
    const profileId = requiredId(res, req.params.profileId, 'profile');
    const emailId = requiredId(res, req.params.emailId, 'email'); if (!profileId || !emailId) return;
    return res.json({ email: await deps.removeEmail({ profileId, emailId, actorId: actor(req), actorFranchiseId: franchiseId }) });
  }));
  router.post('/pto/admin/profiles/:profileId/adjustments', requireAdmin, admin(async (req, res, franchiseId) => {
    const profileId = requiredId(res, req.params.profileId, 'profile'); if (!profileId) return;
    const cycleStart = text(req.body?.cycleStart); const deltaDays = req.body?.deltaDays; const reason = text(req.body?.reason);
    if (!calendarDate(cycleStart) || typeof deltaDays !== 'number' || !Number.isFinite(deltaDays)
      || deltaDays === 0 || Math.abs(deltaDays * 2 - Math.round(deltaDays * 2)) > Number.EPSILON || !reason) {
      return res.status(400).json({ error: 'Valid cycleStart, half-day deltaDays, and reason are required' });
    }
    return res.json(await deps.adjustBalance({ profileId, cycleStart, deltaDays, reason, actorId: actor(req), actorFranchiseId: franchiseId }));
  }));
  router.get('/pto/admin/audit', requireAdmin, admin(async (req, res, franchiseId) => {
    const profileId = req.query.profileId == null ? undefined : id(req.query.profileId);
    if (req.query.profileId != null && !profileId) return res.status(400).json({ error: 'Invalid profile id' });
    const pagination = parsePagination(req, res); if (!pagination) return;
    return res.json(await deps.listAudit({ franchiseId, profileId: profileId ?? undefined, ...pagination }));
  }));
  return router;
}

async function normalizedCharge(req: Request, res: Response, deps: PtoRouteDeps, franchiseId: number) {
  const [timezone, noticeRequired] = await Promise.all([
    deps.resolveTimezone(franchiseId), deps.resolveTimeOffNoticeRequired(franchiseId)
  ]);
  const nowIso = deps.nowIso();
  const normalized = normalizeTimeOffSubmission({ ...req.body, type: 'pto', reason: 'PTO quote request' }, {
    timezone, nowIso, maxDurationHours: 336, noticeRequired
  });
  if (!normalized.valid) { res.status(400).json({ error: normalized.errors[0], errors: normalized.errors }); return null; }
  const calculated = calculatePtoCharge({ startDate: normalized.value.startDate, endDate: normalized.value.endDate,
    partialDay: normalized.value.partialDay, durationHours: normalized.value.durationHours });
  return {
    balanceDate: localDateForTimeZone(nowIso, timezone),
    chargeDays: calculated.totalDays,
    dayCharges: calculated.dayCharges.map(({ date, days }) => ({ date, days }))
  };
}

async function tutorIdentity(deps: PtoRouteDeps, context: { franchiseId: number; tutorId: number }) {
  const result = await deps.getTutorProfile(context);
  const membership = result.memberships.find((item) => Number(item.franchiseid ?? item.franchiseId) === context.franchiseId
    && Number(item.tutor_id ?? item.tutorId) === context.tutorId && item.active !== false);
  return result.profile && membership ? { profileId: result.profile.id, membershipId: String(membership.id) } : null;
}

function admin(handler: (req: Request, res: Response, franchiseId: number) => Promise<unknown>) {
  return asyncHandler(async (req, res) => {
    const scope = enforceFranchiseScope(req, { requireFranchiseId: true, requiredMessage: 'franchiseId is required' });
    if (scope.error || scope.franchiseId === null) return res.status(scope.error?.status ?? 400).json({ error: scope.error?.message ?? 'franchiseId is required' });
    try { return await handler(req, res, scope.franchiseId); } catch (error) { return sendPtoError(res, error); }
  });
}

function tutorContext(req: Request) {
  const tutorId = Number(req.session.auth?.accountId); const franchiseId = Number(req.session.auth?.franchiseId);
  return Number.isInteger(tutorId) && tutorId > 0 && Number.isInteger(franchiseId) && franchiseId > 0 ? { tutorId, franchiseId } : null;
}
function actor(req: Request) { return String(req.session.auth!.accountId); }
function id(value: unknown) { const parsed = Number(value); return Number.isSafeInteger(parsed) && parsed > 0 ? String(parsed) : null; }
function text(value: unknown) { return typeof value === 'string' ? value.trim() : ''; }
function positiveInteger(value: unknown) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && !value.trim()) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}
function parsePagination(req: Request, res: Response) {
  const page = req.query.page == null ? undefined : positiveInteger(req.query.page);
  const pageSize = req.query.pageSize == null ? undefined : positiveInteger(req.query.pageSize);
  if (page === null || pageSize === null) {
    res.status(400).json({ error: 'page and pageSize must be positive integers' });
    return null;
  }
  return { page, pageSize };
}
function manualEmail(value: unknown) {
  const normalized = text(value).toLowerCase();
  return normalized.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(normalized) ? normalized : null;
}
function calendarDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.getUTCFullYear() === Number(match[1])
    && date.getUTCMonth() === Number(match[2]) - 1
    && date.getUTCDate() === Number(match[3]);
}
function requiredId(res: Response, value: unknown, label: string) { const parsed = id(value); if (!parsed) res.status(400).json({ error: `Invalid ${label} id` }); return parsed; }
function asyncHandler(handler: (req: Request, res: Response) => Promise<unknown>) {
  return (req: Request, res: Response, _next: NextFunction) => {
    Promise.resolve(handler(req, res)).catch((error) => sendPtoError(res, error));
  };
}

export function sendPtoError(res: Response, error: unknown) {
  const mapped = mapPtoHttpError(error, true) as NonNullable<ReturnType<typeof mapPtoHttpError>>;
  return res.status(mapped.status).json({ error: mapped.error, code: mapped.code });
}

export default createPtoRouter();
