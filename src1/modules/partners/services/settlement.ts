import { ClientSession } from 'mongoose';
import { AppError } from '@/modules/common/types';
import {
  SettlementAccountModel,
  LedgerEntryModel,
  ISettlementAccount,
  ILedgerEntry,
  LedgerEntryKind,
} from '@/modules/partners/model/settlement';

/** Q16a: an ObjectId-shaped owner id in its canonical (lower-case) spelling; anything else as given. */
export const canonicalOwnerId = (id: unknown): string => {
  const v = String(id ?? '');
  return /^[0-9a-fA-F]{24}$/.test(v) ? v.toLowerCase() : v;
};

/**
 * §7a: idempotent find-or-create by owner; safe under concurrency (unique {ownerKind, ownerId}). Q16a: the owner id is
 * canonical (lower-case) — an id sent in another letter case finds the same account (also one stored earlier in another
 * spelling) and never creates a second one.
 */
export async function ensureSettlementAccount(
  ownerKind: 'partner' | 'doctor',
  ownerIdIn: string,
  beneficiaryName: string,
  session?: ClientSession
): Promise<ISettlementAccount> {
  const ownerId = canonicalOwnerId(ownerIdIn);
  if (/^[0-9a-f]{24}$/.test(ownerId)) {
    // Q16a re-review (G): the canonical (lower-case) account wins whenever it exists; another spelling only when it is
    // the only one (oldest first). `npm run audit:q16a-doctor-id-case` lists owners with several spellings.
    const canonical = await SettlementAccountModel.findOne({ ownerKind, ownerId }).session(session ?? null).lean();
    if (canonical) return canonical as ISettlementAccount;
    const anyCase = await SettlementAccountModel.findOne({ ownerKind, ownerId: new RegExp(`^${ownerId}$`, 'i') }).sort({ createdAt: 1, _id: 1 })
      .session(session ?? null).lean();
    if (anyCase) return anyCase as ISettlementAccount;
  }
  const upsert = () => SettlementAccountModel.findOneAndUpdate(
    { ownerKind, ownerId },
    { $setOnInsert: { ownerKind, ownerId, beneficiaryName, isActive: true } },
    { upsert: true, new: true, ...(session ? { session } : {}) }
  ).lean();
  try {
    return (await upsert()) as ISettlementAccount;
  } catch (e: any) {
    if (e?.code !== 11000 || session) throw e; // inside a transaction the caller's retry handles it
    return (await upsert()) as ISettlementAccount;
  }
}

export interface PostEntryInput {
  settlementAccountId: string;
  kind: LedgerEntryKind;
  amountMinor: number;
  grossMinor?: number;
  commissionMinor?: number;
  source: string;
  sourceId: string;
  reference?: string;
  note?: string;
  by: string;
  byKind: 'system' | 'admin';
}

const SIGN: Record<LedgerEntryKind, 1 | -1 | 0> = { earning: 1, reversal: -1, payout: -1, adjustment: 0 };

/**
 * Exactly once per (account, source, sourceId, kind). A repeat with the same amount returns the stored entry; a repeat
 * with a different amount is refused (it would mean two different facts claim one source).
 */
export async function postLedgerEntry(input: PostEntryInput, session?: ClientSession): Promise<ILedgerEntry> {
  if (!Number.isSafeInteger(input.amountMinor)) throw new AppError({ status: 400, code: 'INVALID_AMOUNT', message: 'Amount must be whole paise' });
  const sign = SIGN[input.kind];
  if (sign !== 0 && Math.sign(input.amountMinor) !== sign && input.amountMinor !== 0) {
    throw new AppError({ status: 400, code: 'INVALID_AMOUNT_SIGN', message: `A ${input.kind} entry has the wrong sign` });
  }
  const key = { settlementAccountId: input.settlementAccountId, source: input.source, sourceId: String(input.sourceId), kind: input.kind };
  const existing = await LedgerEntryModel.findOne(key).session(session ?? null).lean();
  if (existing) return sameOrConflict(existing, input);
  const doc = {
    ...key,
    amountMinor: input.amountMinor,
    grossMinor: input.grossMinor ?? Math.abs(input.amountMinor),
    commissionMinor: input.commissionMinor ?? 0,
    reference: input.reference,
    note: input.note,
    at: new Date(),
    by: input.by,
    byKind: input.byKind,
  };
  try {
    const [created] = await LedgerEntryModel.create([doc], session ? { session } : {});
    return created!.toObject() as ILedgerEntry;
  } catch (e: any) {
    if (e?.code !== 11000 || session) throw e;
    const raced = await LedgerEntryModel.findOne(key).lean();
    if (!raced) throw e;
    return sameOrConflict(raced, input);
  }
}

function sameOrConflict(existing: ILedgerEntry, input: PostEntryInput): ILedgerEntry {
  if (existing.amountMinor !== input.amountMinor) {
    throw new AppError({ status: 409, code: 'LEDGER_SOURCE_CONFLICT', message: 'This source already has a different ledger entry' });
  }
  return existing;
}

export async function ledgerBalance(settlementAccountId: string, session?: ClientSession): Promise<number> {
  const agg = await LedgerEntryModel.aggregate([
    { $match: { settlementAccountId } },
    { $group: { _id: null, total: { $sum: '$amountMinor' } } },
  ]).session(session ?? null);
  return agg[0]?.total ?? 0;
}

export async function ledgerStatement(settlementAccountId: string, opts: { before?: Date; limit?: number } = {}): Promise<ILedgerEntry[]> {
  return LedgerEntryModel.find({ settlementAccountId, ...(opts.before ? { at: { $lt: opts.before } } : {}) })
    .sort({ at: -1, _id: -1 })
    .limit(Math.min(opts.limit ?? 100, 500))
    .lean();
}
