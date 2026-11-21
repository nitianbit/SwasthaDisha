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
