import { Response } from 'express';
import { AuthRequest } from '@/modules/middleware/auth';
import { assertAdminToolsOn, assistedFlags } from '@/modules/assisted/flags';
import { financeSummary, findOwnerAccount, statementPage } from '@/modules/partners/services/finance';
import { listRules, putRule, ruleEvents } from '@/modules/referralCuts/service';
import { actorOf } from '@/modules/assisted/controller/phase1a';

/** Phase 4a/4b (§26.5.4, §26.6.2): referral rules (admin writes, partner reads) and the pharmacy's referral account. */
const send = (res: Response, data: unknown, extra: Record<string, unknown> = {}) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(200).json({ success: true, data, ...extra });
};
const pharmacyIdOf = (req: AuthRequest) => actorOf(req).pharmacyId.toLowerCase();

export const adminRules = async (req: AuthRequest, res: Response) =>
  send(res, await listRules(req.query.bookerKind as never, String(req.query.bookerId), true));
export const adminPutRule = async (req: AuthRequest, res: Response) => {
  assertAdminToolsOn();
  send(res, await putRule(String(req.user!._id), req.params as never, req.body));
};
export const adminRuleEvents = async (req: AuthRequest, res: Response) =>
  send(res, await ruleEvents(req.params.bookerKind as never, req.params.bookerId, req.params.category as never));

export const pharmacyRules = async (req: AuthRequest, res: Response) => send(res, await listRules('pharmacy', pharmacyIdOf(req)));

/** GET /pharmacy-assisted/referral — what the pharmacy's cuts have earned, been paid and are due (payouts paused: O1). */
export const pharmacyReferral = async (req: AuthRequest, res: Response) => {
  const f = await financeSummary(await findOwnerAccount('pharmacy_referral', pharmacyIdOf(req)), false);
  send(res, { earnedMinor: f.totals.earnedMinor, paidMinor: f.totals.paidOutMinor, dueMinor: f.balanceMinor, payoutsEnabled: assistedFlags.referralPayouts() });
};
/** GET /pharmacy-assisted/referral/statement — newest first (`before` cursor), short refs only, never patient names. */
export const pharmacyReferralStatement = async (req: AuthRequest, res: Response) => {
  const r = await statementPage(await findOwnerAccount('pharmacy_referral', pharmacyIdOf(req)), req.query as never);
  send(res, r.lines, { pagination: { nextCursor: r.nextCursor } });
};
