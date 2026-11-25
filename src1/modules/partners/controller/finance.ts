import { Request, Response, NextFunction } from 'express';
import { AuthRequest } from '@/modules/middleware/auth';
import { actorOf } from '@/modules/partners/controller';
import * as f from '@/modules/partners/services/finance';

const ok = (res: Response, data: unknown, status = 200) => res.status(status).json({ success: true, data });
/** A statement CSV answer (r33: shared with the referral statements). */
export const sendCsv = (res: Response, name: string, body: string) => {
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${name}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.status(200).send(body);
};
/** Q13: paged lists keep `data` an array and add `pagination` (as the Q10 bills list). */
const paged = (res: Response, p: { items: unknown[]; total: number; nextCursor: string | null }) =>
  res.status(200).json({ success: true, data: p.items, pagination: { total: p.total, nextCursor: p.nextCursor } });
const pageOpts = (q: Record<string, unknown>) => ({ cursor: q.cursor as string | undefined, limit: q.limit ? Number(q.limit) : undefined });
export const period = (q: Record<string, unknown>) => ({ from: q.from as string | undefined, to: q.to as string | undefined });
export const csvName = (prefix: string, q: Record<string, unknown>) => `${prefix}-statement${q.from ? '-' + q.from : ''}${q.to ? '-to-' + q.to : ''}.csv`;

// ── Partner workspace (members with finance.view and partner-wide scope; admins with owner authority) ──
async function partnerAccount(req: Request) {
  const actor = actorOf(req);
  f.assertPartnerFinanceReader(actor);
  return { actor, account: await f.findOwnerAccount('partner', actor.partnerId), full: actor.actorKind === 'admin' };
}
export const partnerFinance = async (req: Request, res: Response, _n: NextFunction) => {
  const { account, full } = await partnerAccount(req);
  ok(res, await f.financeSummary(account, full));
};
export const partnerStatement = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await f.statementPage((await partnerAccount(req)).account, req.query as any));
export const partnerStatementCsv = async (req: Request, res: Response, _n: NextFunction) =>
  sendCsv(res, csvName('partner', req.query), await f.statementCsv((await partnerAccount(req)).account, period(req.query)));
export const partnerEvents = async (req: Request, res: Response, _n: NextFunction) =>
  paged(res, await f.eventsPage((await partnerAccount(req)).account, pageOpts(req.query)));
export const partnerPayouts = async (req: Request, res: Response, _n: NextFunction) =>
  paged(res, await f.payoutsPage((await partnerAccount(req)).account, pageOpts(req.query)));
export const putPartnerPayoutDetails = async (req: Request, res: Response, _n: NextFunction) => {
  const actor = actorOf(req);
  const by: f.FinanceActor = actor.actorKind === 'admin' ? { kind: 'admin', id: actor.memberId.replace(/^admin:/, '') } : { kind: 'member', partner: actor };
  if (by.kind === 'member') f.assertPartnerFinanceReader(actor);
  ok(res, await f.setPayoutDetails({ ownerKind: 'partner', ownerId: actor.partnerId }, req.body, by));
};

// ── Doctor (specialist portal, their own account) ──
const doctorOf = (req: Request) => String((req as AuthRequest).user!.specialistId || (req as AuthRequest).user!._id);
const doctorAccount = (req: Request) => f.findOwnerAccount('doctor', doctorOf(req));
export const doctorFinance = async (req: Request, res: Response, _n: NextFunction) => ok(res, await f.financeSummary(await doctorAccount(req), false));
export const doctorStatement = async (req: Request, res: Response, _n: NextFunction) => ok(res, await f.statementPage(await doctorAccount(req), req.query as any));
export const doctorStatementCsv = async (req: Request, res: Response, _n: NextFunction) =>
  sendCsv(res, csvName('doctor', req.query), await f.statementCsv(await doctorAccount(req), period(req.query)));
export const doctorPayouts = async (req: Request, res: Response, _n: NextFunction) => paged(res, await f.payoutsPage(await doctorAccount(req), pageOpts(req.query)));
export const doctorEvents = async (req: Request, res: Response, _n: NextFunction) => paged(res, await f.eventsPage(await doctorAccount(req), pageOpts(req.query)));
export const doctorHistory = async (req: Request, res: Response, _n: NextFunction) => ok(res, await f.historyRefs(await doctorAccount(req)));
export const putDoctorPayoutDetails = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await f.setPayoutDetails({ ownerKind: 'doctor', ownerId: doctorOf(req) }, req.body, { kind: 'doctor', id: doctorOf(req) }));

// ── Admin: every settlement account (partners and doctors) ──
const adminId = (req: Request) => String((req as AuthRequest).user!._id);
export const adminAccounts = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await f.adminListAccounts({ ...(req.query as any), due: req.query.due === 'true' }));
export const adminAccount = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await f.financeSummary(await f.accountById(req.params.accountId), true));
export const adminStatement = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await f.statementPage(await f.accountById(req.params.accountId), req.query as any));
export const adminStatementCsv = async (req: Request, res: Response, _n: NextFunction) =>
  sendCsv(res, csvName(`account-${req.params.accountId}`, req.query), await f.statementCsv(await f.accountById(req.params.accountId), period(req.query)));
export const adminAccountPayouts = async (req: Request, res: Response, _n: NextFunction) =>
  paged(res, await f.payoutsPage(await f.accountById(req.params.accountId), pageOpts(req.query)));
export const adminHistory = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await f.historyRefs(await f.accountById(req.params.accountId)));
export const adminEvents = async (req: Request, res: Response, _n: NextFunction) =>
  paged(res, await f.eventsPage(await f.accountById(req.params.accountId), pageOpts(req.query)));
export const adminPutPayoutDetails = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await f.setPayoutDetails({ accountId: req.params.accountId }, req.body, { kind: 'admin', id: adminId(req) }));
export const adminVerifyPayoutDetails = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await f.verifyPayoutDetails(req.params.accountId, req.body.version, adminId(req)));
export const adminRecordPayout = async (req: Request, res: Response, _n: NextFunction) => {
  const r = await f.recordPayout(adminId(req), req.params.accountId, req.body);
  ok(res, r, r.replayed ? 200 : 201);
};
export const adminVoidPayout = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await f.voidPayout(adminId(req), req.params.payoutId, req.body.reason));
export const adminAdjustment = async (req: Request, res: Response, _n: NextFunction) => {
  const r = await f.postAdjustment(adminId(req), req.params.accountId, req.body);
  ok(res, r, r.replayed ? 200 : 201);
};
export const adminPayouts = async (req: Request, res: Response, _n: NextFunction) => paged(res, await f.adminPayoutsPage(req.query as any));
// Q13: a lost payout/adjustment answer — the admin's own key on this account.
export const adminPayoutByKey = async (req: Request, res: Response, _n: NextFunction) => {
  const p = await f.payoutByKey(adminId(req), req.params.accountId, req.params.key);
  if (!p) { res.status(404).json({ error: 404, code: 'PAYOUT_NOT_FOUND', message: 'No payout was recorded with this key' }); return; }
  ok(res, p);
};
export const adminAbandonPayoutKey = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await f.abandonPayoutKey(adminId(req), req.params.accountId, req.params.key));
export const adminAdjustmentByKey = async (req: Request, res: Response, _n: NextFunction) => {
  const e = await f.adjustmentByKey(adminId(req), req.params.accountId, req.params.key);
  if (!e) { res.status(404).json({ error: 404, code: 'ADJUSTMENT_NOT_FOUND', message: 'No adjustment was posted with this key' }); return; }
  ok(res, e);
};
export const adminAbandonAdjustmentKey = async (req: Request, res: Response, _n: NextFunction) =>
  ok(res, await f.abandonAdjustmentKey(adminId(req), req.params.accountId, req.params.key));

// Q16a: past paid ledger consultations never marked completed or no-show (doctor, date, booking id).
export const adminUnmarkedConsultations = async (req: Request, res: Response, _n: NextFunction) =>
  paged(res, await f.adminUnmarkedConsultations({ ...pageOpts(req.query as Record<string, unknown>), doctorId: req.query.doctorId as string | undefined,
    ...period(req.query as Record<string, unknown>) }));
// Q16a re-review (E): legacy months to recalculate after a moved no-show changed.
export const adminLegacyRecalculations = async (req: Request, res: Response, _n: NextFunction) =>
  paged(res, await f.adminLegacyRecalculations(pageOpts(req.query as Record<string, unknown>)));
