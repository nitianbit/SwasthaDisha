import { ClientSession, Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { assertUniqueIndex } from '@/modules/common/utils/requiredIndex';
import { runLedgerTransaction } from '@/modules/common/utils/bookingWalletFunding';
import PharmacyModel from '@/modules/pharmacies/model';
import PartnerModel from '@/modules/partners/model';
import SpecialistModel from '@/modules/specialists/model';
import { SettlementAccountModel, type ReferralOwnerKind } from '@/modules/partners/model/settlement';
import { ensureSettlementAccount, postLedgerEntry } from '@/modules/partners/services/settlement';
import { assistedFlags } from '@/modules/assisted/flags';
import type { AssistedReferral, BookerKind, ReferralCategory, ReferralSnapshot } from '@/modules/assisted/types';
import { ReferralRuleEventModel, ReferralRuleModel, type IReferralRule } from '@/modules/referralCuts/model';

/**
 * Phase 4a/4b (ASSISTED_BOOKING_DESIGN.md §26.5–§26.6): referral cuts. The cut is paid TO the booking partner OUT OF
 * the provider's earning (owner, 22 Nov: ₹500 at 10% → provider ₹450, partner ₹50), after the coupon (§8.3). A rule per
 * booker and category is snapshotted on the booking at create (instant: at accept); at completion the provider earns
 * base − cut and the booker's `*_referral` account earns the cut, both once, in the completion transaction.
 */
const err = (status: number, code: string, message: string) => new AppError({ status, code, message });
const lower = (v: unknown) => String(v ?? '').toLowerCase();
const ACCOUNT_KIND: Record<BookerKind, ReferralOwnerKind> = { pharmacy: 'pharmacy_referral', lab: 'lab_referral', doctor: 'doctor_referral' };

/** §26.5.1: a lab catalogue item's referral category (tests and packages only; other kinds are not cut). */
export const labCategoryOf = (catalogueKind: unknown): ReferralCategory | null =>
  (catalogueKind === 'test' ? 'lab_test' : catalogueKind === 'package' ? 'lab_package' : null);

type RuleTerms = Pick<IReferralRule, 'basis' | 'percentBasisPoints' | 'fixedMinor' | 'capMinor'> & { _id?: unknown; version?: number };

/**
 * §26.5.2 (§8.3 step 4), one pure function: percent = floor(base × bp / 10 000); fixed = min(fixed, base); then the
 * per-line cap; never above the base; 0 with the reason when the switches or the rule say so.
 */
export function cutFor(baseMinor: number, rule: RuleTerms | null, ctx: { category: ReferralCategory | null; bookerKind: BookerKind;
  cutsOn: boolean; doctorCutsOn: boolean }): ReferralSnapshot {
  const zero = (disabledReason: ReferralSnapshot['disabledReason']): ReferralSnapshot => ({ category: ctx.category, cutMinor: 0, disabledReason });
  if (!ctx.cutsOn) return zero('cuts_off');
  if (ctx.bookerKind === 'doctor' && !ctx.doctorCutsOn) return zero('doctor_cuts_off');
  if (!ctx.category) return zero('category_not_cut');
  if (!rule) return zero('no_rule');
  const base = Math.max(0, Math.trunc(Number(baseMinor) || 0));
  let cut = rule.basis === 'percent' ? Math.floor((base * Number(rule.percentBasisPoints || 0)) / 10_000) : Math.min(Number(rule.fixedMinor || 0), base);
  if (rule.capMinor) cut = Math.min(cut, Number(rule.capMinor));
  cut = Math.max(0, Math.min(cut, base));
  return { category: ctx.category, cutMinor: cut, ...(rule._id ? { ruleId: String(rule._id) } : {}), ...(rule.version ? { ruleVersion: rule.version } : {}),
    basis: rule.basis, ...(rule.basis === 'percent' ? { percentBasisPoints: rule.percentBasisPoints } : { fixedMinor: rule.fixedMinor }),
    ...(rule.capMinor ? { capMinor: rule.capMinor } : {}) };
}

/**
 * §26.5.3: the cut of each line of a new booking for this booker, and — when the total is above 0 — the booker's
 * `*_referral` account it will be credited to (opened idempotently now; an unused empty account is harmless).
 * While the master switch is off nothing is snapshotted (`lines` are null): a booking is stored exactly as before
 * phase 4 (cut 0, no snapshot), so the dark deploy changes no row (ASSUMED M20).
 */
export async function snapshotCuts(booker: { kind: BookerKind; id: string; name: string }, lines: { category: ReferralCategory | null; baseMinor: number }[],
  s?: ClientSession): Promise<{ lines: (ReferralSnapshot | null)[]; totalCutMinor: number; referral: AssistedReferral | null }> {
  const cutsOn = assistedFlags.referralCuts();
  if (!cutsOn) return { lines: lines.map(() => null), totalCutMinor: 0, referral: null };
  const doctorCutsOn = assistedFlags.referralDoctorCuts();
  const bookerId = lower(booker.id);
  const rules = booker.kind !== 'doctor' || doctorCutsOn
    ? await ReferralRuleModel.find({ bookerKind: booker.kind, bookerId, isActive: true }).session(s ?? null).lean() as IReferralRule[] : [];
  const byCategory = new Map(rules.map((r) => [r.category, r]));
  const snapshots = lines.map((l) => cutFor(l.baseMinor, l.category ? byCategory.get(l.category) ?? null : null,
    { category: l.category, bookerKind: booker.kind, cutsOn, doctorCutsOn }));
  const totalCutMinor = snapshots.reduce((a, x) => a + x.cutMinor, 0);
  if (!(totalCutMinor > 0)) return { lines: snapshots, totalCutMinor: 0, referral: null };
  const ownerKind = ACCOUNT_KIND[booker.kind];
  const account = await ensureSettlementAccount(ownerKind, bookerId, booker.name || 'Partner', s);
  return { lines: snapshots, totalCutMinor,
    referral: { accountId: String(account._id), ownerKind, bookerKind: booker.kind, bookerId, cutMinor: totalCutMinor } };
}

/**
 * The referral account a nonzero cut opens relies on `settlement_accounts {ownerKind, ownerId}` (unique). Each create
 * checks it with its other indexes, before any lookup is counted or audited (503 INDEXES_OUTDATED); off: not needed.
 */
export async function assertReferralIndexes(): Promise<void> {
  if (assistedFlags.referralCuts()) await assertUniqueIndex(SettlementAccountModel, { ownerKind: 1, ownerId: 1 });
}

/**
 * §26.6.1: at completion, in the provider-earning transaction — the booker's cut as an earning on its referral account,
 * exactly once (the ledger key {account, source, booking, kind}). A cut of 0 posts nothing.
 */
export async function postReferralEarningIn(b: { _id?: unknown; assisted?: { referral?: AssistedReferral | null; split?: { baseMinor?: number } } | null },
  source: 'referral_consultation' | 'referral_lab_booking', s: ClientSession, actor: { by: string; byKind: 'system' | 'admin' }): Promise<void> {
  const r = b.assisted?.referral;
  if (!r || !(Number(r.cutMinor) > 0)) return;
  await postLedgerEntry({ settlementAccountId: r.accountId, kind: 'earning', amountMinor: Number(r.cutMinor), grossMinor: Number(b.assisted?.split?.baseMinor ?? 0),
    commissionMinor: 0, source, sourceId: String(b._id), by: actor.by, byKind: actor.byKind }, s);
}

// ───────────────────────────── Rules (admin writes, partner reads) ─────────────────────────────

export interface RuleInput {
  basis: 'percent' | 'fixed';
  percentBasisPoints?: number;
  fixedMinor?: number;
  capMinor?: number;
  isActive: boolean;
  expectedVersion: number;
  reason: string;
}

/** The fields a rule change records (amounts and switches only). */
const termsOf = (r: Partial<IReferralRule>) => ({ basis: r.basis, percentBasisPoints: r.percentBasisPoints ?? null, fixedMinor: r.fixedMinor ?? null,
  capMinor: r.capMinor ?? null, isActive: r.isActive });

/** A rule as partners and admins read it; `effective` says whether it cuts new bookings now (the switches). */
export function ruleView(r: IReferralRule, admin = false) {
  const effective = r.isActive && assistedFlags.referralCuts() && (r.bookerKind !== 'doctor' || assistedFlags.referralDoctorCuts());
  return { _id: String(r._id), category: r.category, basis: r.basis, percentBasisPoints: r.percentBasisPoints ?? null, fixedMinor: r.fixedMinor ?? null,
    capMinor: r.capMinor ?? null, isActive: r.isActive, version: r.version, updatedAt: r.updatedAt, effective, ...(admin ? { updatedBy: r.updatedBy } : {}) };
}

export async function listRules(bookerKind: BookerKind, bookerId: string, admin = false) {
  const rows = await ReferralRuleModel.find({ bookerKind, bookerId: lower(bookerId) }).sort({ category: 1 }).lean() as IReferralRule[];
  return rows.map((r) => ruleView(r, admin));
}

async function assertBookerExists(kind: BookerKind, id: string): Promise<void> {
  const found = !Types.ObjectId.isValid(id) ? null
    : kind === 'pharmacy' ? await PharmacyModel.exists({ _id: id })
      : kind === 'lab' ? await PartnerModel.exists({ _id: id, kind: 'lab' })
        : await SpecialistModel.exists({ _id: id });
  if (!found) throw err(404, 'BOOKER_NOT_FOUND', 'Partner not found');
}

/**
 * PUT /api/v1/admin/referral-rules/:bookerKind/:bookerId/:category — creates (expectedVersion 0) or changes a rule,
 * fenced by its version (409 RECORD_CHANGED), with one history row per version in the same transaction.
 */
export async function putRule(adminId: string, key: { bookerKind: BookerKind; bookerId: string; category: ReferralCategory }, input: RuleInput) {
  const bookerId = lower(key.bookerId);
  if (input.basis === 'percent' && !(Number.isInteger(input.percentBasisPoints) && input.percentBasisPoints! >= 1 && input.percentBasisPoints! <= 5000)) {
    throw err(400, 'VALIDATION_ERROR', 'A percent rule needs percentBasisPoints from 1 to 5000 (0.01% to 50%)');
  }
  if (input.basis === 'fixed' && !(Number.isInteger(input.fixedMinor) && input.fixedMinor! >= 1)) throw err(400, 'VALIDATION_ERROR', 'A fixed rule needs fixedMinor ≥ 1');
  await assertBookerExists(key.bookerKind, bookerId);
  await assertUniqueIndex(ReferralRuleModel, { bookerKind: 1, bookerId: 1, category: 1 });
  await assertUniqueIndex(ReferralRuleEventModel, { ruleId: 1, version: 1 });
  const terms = { basis: input.basis, ...(input.basis === 'percent' ? { percentBasisPoints: input.percentBasisPoints } : { fixedMinor: input.fixedMinor }),
    ...(input.capMinor ? { capMinor: input.capMinor } : {}), isActive: input.isActive };
  const changed = () => err(409, 'RECORD_CHANGED', 'This rule was changed meanwhile; reload it and try again');
  const saved = await runLedgerTransaction(async (s) => {
    let before: IReferralRule | null = null;
    let after: IReferralRule | null;
    if (input.expectedVersion === 0) {
      try {
        const [created] = await ReferralRuleModel.create([{ bookerKind: key.bookerKind, bookerId, category: key.category, ...terms, version: 1, updatedBy: adminId }],
          { session: s });
        after = created!.toObject() as IReferralRule;
      } catch (e: any) {
        if (e?.code === 11000) throw changed();
        throw e;
      }
    } else {
      before = await ReferralRuleModel.findOne({ bookerKind: key.bookerKind, bookerId, category: key.category, version: input.expectedVersion }).session(s).lean() as IReferralRule | null;
      if (!before) throw changed();
      after = await ReferralRuleModel.findOneAndUpdate({ _id: before._id, version: input.expectedVersion },
        { $set: { ...terms, updatedBy: adminId }, $unset: input.basis === 'percent' ? { fixedMinor: 1, ...(input.capMinor ? {} : { capMinor: 1 }) }
          : { percentBasisPoints: 1, ...(input.capMinor ? {} : { capMinor: 1 }) }, $inc: { version: 1 } }, { new: true, session: s }).lean() as IReferralRule | null;
      if (!after) throw changed();
    }
    await ReferralRuleEventModel.create([{ ruleId: String(after._id), version: after.version, before: before ? termsOf(before) : null, after: termsOf(after),
      by: adminId, reason: String(input.reason ?? '').trim().slice(0, 500), at: new Date() }], { session: s });
    return after;
  });
  return ruleView(saved, true);
}

export async function ruleEvents(bookerKind: BookerKind, bookerId: string, category: ReferralCategory) {
  const rule = await ReferralRuleModel.findOne({ bookerKind, bookerId: lower(bookerId), category }).select({ _id: 1 }).lean();
  if (!rule) return [];
  return ReferralRuleEventModel.find({ ruleId: String(rule._id) }).sort({ version: -1 }).select({ _id: 0 }).lean();
}
