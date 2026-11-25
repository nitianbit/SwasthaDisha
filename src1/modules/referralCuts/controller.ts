import { Request, Response } from 'express';
import { AuthRequest } from '@/modules/middleware/auth';
import { AppError } from '@/modules/common/types';
import { assertAdminToolsOn, assistedFlags } from '@/modules/assisted/flags';
import { assertPartnerFinanceReader, financeSummary, findOwnerAccount, statementCsv, statementPage } from '@/modules/partners/services/finance';
import { csvName, period, sendCsv } from '@/modules/partners/controller/finance';
import { actorOf as partnerActorOf } from '@/modules/partners/controller';
import PartnerModel from '@/modules/partners/model';
import { listRules, putRule, ruleEvents } from '@/modules/referralCuts/service';
import { actorOf } from '@/modules/assisted/controller/phase1a';

/**
 * Phase 4a/4b (§26.5.4, §26.6.2): referral rules (admin writes, partner reads) and the bookers' referral accounts.
 * r33: the answers report the switches (`cutsEnabled`, `payoutsEnabled`); the statement has a CSV; labs read theirs (M17).
 */
const send = (res: Response, data: unknown, extra: Record<string, unknown> = {}) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(200).json({ success: true, data, ...extra });
};
/** r33: REFERRAL_CUTS_ENABLED (new bookings are cut) and REFERRAL_PAYOUTS_ENABLED (referral balances are paid, O1). */
const switches = () => ({ cutsEnabled: assistedFlags.referralCuts(), payoutsEnabled: assistedFlags.referralPayouts() });

export const adminRules = async (req: AuthRequest, res: Response) =>
  send(res, await listRules(req.query.bookerKind as never, String(req.query.bookerId), true), { switches: switches() });
export const adminPutRule = async (req: AuthRequest, res: Response) => {
  assertAdminToolsOn();
  send(res, await putRule(String(req.user!._id), req.params as never, req.body));
};
export const adminRuleEvents = async (req: AuthRequest, res: Response) =>
  send(res, await ruleEvents(req.params.bookerKind as never, req.params.bookerId, req.params.category as never));

/** The booker whose own referral account and rates are read. Doctors have none here (doctor cuts stay off). */
interface Reader { kind: 'pharmacy' | 'lab'; id: string }
const ACCOUNT = { pharmacy: 'pharmacy_referral', lab: 'lab_referral' } as const;

/**
 * The booker's reads, one set for each kind: its rates (read only), what its cuts earned / were paid / are due, and the
 * statement (newest first by `before`; short refs and categories, never patient names) and its CSV (the finance CSV).
 */
function referralReads(readerOf: (req: Request) => Reader | Promise<Reader>) {
  const accountOf = async (req: Request) => {
    const r = await readerOf(req);
    return { r, account: await findOwnerAccount(ACCOUNT[r.kind], r.id) };
  };
  return {
    rules: async (req: Request, res: Response) => {
      const r = await readerOf(req);
      send(res, await listRules(r.kind, r.id), { switches: switches() });
    },
    summary: async (req: Request, res: Response) => {
      const f = await financeSummary((await accountOf(req)).account, false);
      send(res, { earnedMinor: f.totals.earnedMinor, paidMinor: f.totals.paidOutMinor, dueMinor: f.balanceMinor, ...switches() });
    },
    statement: async (req: Request, res: Response) => {
      const page = await statementPage((await accountOf(req)).account, req.query as never);
      send(res, page.lines, { pagination: { nextCursor: page.nextCursor } });
    },
    statementCsv: async (req: Request, res: Response) => {
      const { r, account } = await accountOf(req);
      sendCsv(res, csvName(`${r.kind}-referral`, req.query), await statementCsv(account, period(req.query)));
    },
  };
}

/** `/api/v1/pharmacy-assisted/referral*`: the signed-in pharmacy. */
export const pharmacyReferral = referralReads((req) => ({ kind: 'pharmacy', id: actorOf(req as AuthRequest).pharmacyId.toLowerCase() }));

/**
 * r33 (M17) `/api/v1/partner-workspace/assisted/referral*`: a LAB's members with `finance.view` and partner-wide scope (as
 * the lab's own finance), and admins acting as owner. Other partners book no patients (403 LAB_PARTNER_REQUIRED).
 */
export const labReferral = referralReads(async (req) => {
  const actor = partnerActorOf(req);
  assertPartnerFinanceReader(actor);
  if (!(await PartnerModel.exists({ _id: actor.partnerId, kind: 'lab' }))) {
    throw new AppError({ status: 403, code: 'LAB_PARTNER_REQUIRED', message: 'Referral earnings are for labs' });
  }
  return { kind: 'lab', id: actor.partnerId.toLowerCase() };
});
