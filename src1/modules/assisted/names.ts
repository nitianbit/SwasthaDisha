import { Types } from 'mongoose';
import UserModel from '@/modules/user/model';
import DependentModel from '@/modules/dependents/model';
import PharmacyCustomerModel from '@/modules/pharmacyCustomers/model';

type Row = Record<string, any>;

/**
 * Design §6.2 (ASSUMED D7): the first word plus the initial of the last word ("Rina Kumari Das" → "Rina D."); a one-word
 * name shows its first two letters and "…"; no name → null.
 */
export function maskName(name: unknown): string | null {
  const words = typeof name === 'string' ? name.trim().split(/\s+/).filter(Boolean) : [];
  if (!words.length) return null;
  if (words.length === 1) return `${Array.from(words[0]!).slice(0, 2).join('')}…`;
  return `${words[0]} ${Array.from(words[words.length - 1]!)[0]!.toUpperCase()}.`;
}

const ids = (rows: Row[], key: string) =>
  [...new Set(rows.map((r) => String(r?.[key] ?? '')).filter((id) => Types.ObjectId.isValid(id) && id.length === 24))];

/**
 * §17.2 `patientName` as a pharmacy may see it, for bookings that pharmacy made: the family member's name when the
 * booking is for one; otherwise the name the pharmacy typed for the account holder — the link's `typedName` (phase 1a,
 * §17.4) or, until then, the account name when that pharmacy created the account (`createdSource: 'pharmacy_app'`,
 * `linkedPharmacyId` = it, as the §17.4 backfill) — otherwise the account name masked. Never the account's email or
 * any other account field. Three batched reads.
 */
export async function bookerPatientNames(rows: Row[], pharmacyId: string): Promise<Map<string, string | null>> {
  const userIds = ids(rows, 'userId');
  const [users, deps, links] = await Promise.all([
    UserModel.find({ _id: { $in: userIds } }).select({ name: 1, createdSource: 1, linkedPharmacyId: 1 }).lean() as unknown as Promise<Row[]>,
    DependentModel.find({ _id: { $in: ids(rows, 'dependentId') } }).select({ name: 1, userId: 1 }).lean() as unknown as Promise<Row[]>,
    Types.ObjectId.isValid(pharmacyId)
      ? PharmacyCustomerModel.find({ pharmacyId: new Types.ObjectId(pharmacyId), userId: { $in: userIds.map((u) => new Types.ObjectId(u)) } })
        .lean() as unknown as Promise<Row[]>
      : Promise.resolve([] as Row[]),
  ]);
  const key = (v: unknown) => String(v ?? '').toLowerCase();
  const userBy = new Map(users.map((u) => [key(u._id), u]));
  const depBy = new Map(deps.map((d) => [key(d._id), d]));
  const typedBy = new Map(links.map((l) => [key(l.userId), typeof l.typedName === 'string' && l.typedName.trim() ? l.typedName.trim() : null]));
  const out = new Map<string, string | null>();
  for (const r of rows) {
    let name: string | null = null;
    if (r?.dependentId) {
      const dep = depBy.get(key(r.dependentId));
      // Only a family member of this booking's account (a stale or foreign id names nobody).
      name = dep && key(dep.userId) === key(r.userId) ? (String(dep.name ?? '').trim() || null) : null;
    } else {
      const user = userBy.get(key(r.userId));
      const typed = typedBy.get(key(r.userId));
      if (typed) name = typed;
      else if (user && user.createdSource === 'pharmacy_app' && key(user.linkedPharmacyId) === key(pharmacyId)) name = String(user.name ?? '').trim() || null;
      else name = maskName(user?.name);
    }
    out.set(key(r._id), name);
  }
  return out;
}

/**
 * Assisted booking phase 1a (§17.4): pharmacy-facing lists that populate a customer (`field` = `customerId` on orders,
 * `userId` on subscriptions) keep their shape, but the name is the one this pharmacy typed (its link's `typedName`),
 * else the account name masked; the email is never shown. Rows whose field is not populated are left as they are.
 */
export async function withLinkNames<T>(rows: T[], pharmacyId: string, field: string): Promise<T[]> {
  if (!Array.isArray(rows) || !rows.length || !Types.ObjectId.isValid(pharmacyId)) return rows;
  const populated = rows.map((r) => (r as Row)?.[field]).filter((u) => u && typeof u === 'object' && u._id);
  if (!populated.length) return rows;
  const userIds = [...new Set(populated.map((u: Row) => String(u._id)))].filter((u) => Types.ObjectId.isValid(u));
  const links = await PharmacyCustomerModel.find({ pharmacyId: new Types.ObjectId(pharmacyId), userId: { $in: userIds.map((u) => new Types.ObjectId(u)) } })
    .select({ userId: 1, typedName: 1 }).lean() as unknown as Row[];
  const typedBy = new Map(links.map((l) => [String(l.userId).toLowerCase(), typeof l.typedName === 'string' && l.typedName.trim() ? l.typedName.trim() : null]));
  return rows.map((r) => {
    const u = (r as Row)?.[field];
    if (!u || typeof u !== 'object' || !u._id) return r;
    const { email: _e, ...rest } = u as Row;
    return { ...(r as Row), [field]: { ...rest, name: typedBy.get(String(u._id).toLowerCase()) ?? maskName(u.name) } } as T;
  });
}
