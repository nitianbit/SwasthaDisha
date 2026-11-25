import { Response } from 'express';
import { AuthRequest } from '@/modules/middleware/auth';
import { actorOf } from '@/modules/assisted/controller/phase1a';
import { csvName, period, sendCsv } from '@/modules/partners/controller/finance';
import { pharmacyReferral } from '@/modules/referralCuts/controller';
import { referralSummary, setOffByKey, setOffFromReferral, abandonSetOffKey } from '@/modules/referralCuts/payouts';
import { destinationFor, walletSummary, withdrawalsSummary } from '@/modules/walletWithdrawals/service';
import { walletStatementCsv, walletStatementPage } from '@/modules/pharmacyWallet/services';
import { topupDisputes, topupsWithoutLot } from '@/modules/partnerWallets/topupKinds';

/**
 * Rounds 4e / 4f (ASSISTED_BOOKING_DESIGN.md §26.9, §26.10): the pharmacy's finance reads and the admin's referral set-off
 * and disputes. Every read is the signed-in pharmacy's own (its id from the token); answers are `{ success, data }`, paise.
 */
const send = (res: Response, data: unknown, status = 200, extra: Record<string, unknown> = {}) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(status).json({ success: true, data, ...extra });
};
const pharmacyOf = (req: AuthRequest) => actorOf(req).pharmacyId.toLowerCase();

/** GET /api/v1/pharmacy-assisted/finance — the four blocks of the Finance screen. */
export const pharmacyFinance = async (req: AuthRequest, res: Response) => {
  const id = pharmacyOf(req);
  const [wallet, referral, withdrawals, payoutDetails] = await Promise.all([walletSummary('pharmacy', id), referralSummary('pharmacy', id),
    withdrawalsSummary('pharmacy', id), destinationFor('pharmacy', id)]);
  send(res, { wallet, referral, withdrawals, payoutDetails });
};

/**
 * GET …/finance/statement?kind=wallet|referral&before&limit&from&to — the wallet rows (as `transactionView`) or the referral
 * account's statement (r33's); `pagination.nextCursor` pages further back. `.csv` is the one finance CSV for either.
 */
export const pharmacyStatement = async (req: AuthRequest, res: Response) => {
  if (req.query.kind === 'referral') return pharmacyReferral.statement(req, res);
  const page = await walletStatementPage(pharmacyOf(req), req.query as never);
  send(res, page.lines, 200, { pagination: { nextCursor: page.nextCursor } });
};
export const pharmacyStatementCsv = async (req: AuthRequest, res: Response) => {
  if (req.query.kind === 'referral') return pharmacyReferral.statementCsv(req, res);
  sendCsv(res, csvName('pharmacy-wallet', req.query), await walletStatementCsv(pharmacyOf(req), period(req.query)));
};

// ── Admin ──
const adminOf = (req: AuthRequest) => String(req.user?._id ?? '');
/** POST /api/v1/admin/wallets/:kind/:id/receivable/setoff-from-referral { amountMinor, requestKey } (§26.9). */
export const adminSetOff = async (req: AuthRequest, res: Response) => {
  const out = await setOffFromReferral(adminOf(req), req.params.kind as never, req.params.id, req.body);
  send(res, out, out.replayed ? 200 : 201);
};
export const adminSetOffByKey = async (req: AuthRequest, res: Response) => send(res, await setOffByKey(req.params.kind as never, req.params.id, req.params.key));
export const adminSetOffAbandon = async (req: AuthRequest, res: Response) => send(res, await abandonSetOffKey(req.params.kind as never, req.params.id, req.params.key));
/** GET /api/v1/admin/wallet-disputes?state&walletKind&limit (§26.10). */
export const adminDisputes = async (req: AuthRequest, res: Response) => send(res, await topupDisputes(req.query as never));
/** GET /api/v1/admin/wallets/:kind/:id/topups-without-lot (WQ29): card top-ups credited without a lot (recover them by payment id). */
export const adminTopupsWithoutLot = async (req: AuthRequest, res: Response) => send(res, await topupsWithoutLot(req.params.kind as never, req.params.id));
