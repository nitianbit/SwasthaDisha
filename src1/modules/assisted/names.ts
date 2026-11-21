import { Types } from 'mongoose';
import UserModel from '@/modules/user/model';
import DependentModel from '@/modules/dependents/model';
import PharmacyCustomerModel from '@/modules/pharmacyCustomers/model';

type Row = Record<string, any>;

/**
 * Design §6.2 (ASSUMED D7): the first word plus the initial of the last word ("Rina Kumari Das" → "Rina D."); a one-word
 * name shows its first two letters and "…", and a one-word name of two letters or fewer is fully masked ("…", review
 * finding 8); no name → null.
 */
export function maskName(name: unknown): string | null {
  const words = typeof name === 'string' ? name.trim().split(/\s+/).filter(Boolean) : [];
  if (!words.length) return null;
  if (words.length === 1) {
    const letters = Array.from(words[0]!);
    return letters.length <= 2 ? '…' : `${letters.slice(0, 2).join('')}…`;
  }
  return `${words[0]} ${Array.from(words[words.length - 1]!)[0]!.toUpperCase()}.`;
}

const ids = (rows: Row[], field: string) =>
  [...new Set(rows.map((r) => String(r?.[field] ?? '')).filter((id) => Types.ObjectId.isValid(id) && id.length === 24))];
const key = (v: unknown) => String(v ?? '').toLowerCase();
/** Link consents by which the patient chose the pharmacy (S3): the pharmacy sees the account name. */
export const CONSENTED = ['patient_agreed', 'customer_order'];

/**
 * The account holder's name as a PHARMACY may see it (booker view, dispensing copy, pharmacy order lists and review
 * queue, subscriptions, customer list): when the link records the patient's consent (`patient_agreed`, `customer_order`)
 * the real account name (phase 1a decision, overnight, assumed); otherwise the name that pharmacy TYPED — the link's `typedName` (phase 1a, §17.4) or, until then, the account name of an
 * account this pharmacy opened (`createdSource: 'pharmacy_app'`, `linkedPharmacyId` = it) that its holder never took
 * over (`otpVerified` not true: only the holder can rename it after signing in, so it is still the typed name) —
 * otherwise the account name masked. Never the email or another account field. Two batched reads.
 */
export async function pharmacyFacingHolderNames(userIds: unknown[], pharmacyId: string): Promise<Map<string, string | null>> {
  const wanted = [...new Set(userIds.map((u) => String(u ?? '')).filter((u) => Types.ObjectId.isValid(u) && u.length === 24))];
  const out = new Map<string, string | null>();
  if (!wanted.length) return out;
  const [users, links] = await Promise.all([
    UserModel.find({ _id: { $in: wanted } }).select({ name: 1, createdSource: 1, linkedPharmacyId: 1, otpVerified: 1 }).lean() as unknown as Promise<Row[]>,
    Types.ObjectId.isValid(pharmacyId)
      ? PharmacyCustomerModel.find({ pharmacyId: new Types.ObjectId(pharmacyId), userId: { $in: wanted.map((u) => new Types.ObjectId(u)) } })
        .lean() as unknown as Promise<Row[]>
      : Promise.resolve([] as Row[]),
  ]);
  const linkBy = new Map(links.map((l) => [key(l.userId), l]));
  for (const u of users) {
    const link = linkBy.get(key(u._id));
    const typed = typeof link?.typedName === 'string' && link.typedName.trim() ? link.typedName.trim() : null;
    const accountName = String(u.name ?? '').trim() || null;
    // Phase 1a decision (overnight, assumed): the patient chose this pharmacy (link consent `patient_agreed` or
    // `customer_order`), so it sees the real account name; otherwise only the typed or masked name.
    if (link && CONSENTED.includes(String(link.consent)) && accountName) { out.set(key(u._id), accountName); continue; }
    const opened = u.createdSource === 'pharmacy_app' && key(u.linkedPharmacyId) === key(pharmacyId) && u.otpVerified !== true;
    out.set(key(u._id), typed ?? (opened ? accountName : maskName(u.name)));
  }
  return out;
}

/**
 * §17.2 `patientName` for bookings this pharmacy made: the family member's name when the booking is for one (only a
 * family member of that booking's account), otherwise the holder's pharmacy-facing name (above).
 */
export async function bookerPatientNames(rows: Row[], pharmacyId: string): Promise<Map<string, string | null>> {
  const [holders, deps] = await Promise.all([
    pharmacyFacingHolderNames(ids(rows, 'userId'), pharmacyId),
    DependentModel.find({ _id: { $in: ids(rows, 'dependentId') } }).select({ name: 1, userId: 1 }).lean() as unknown as Promise<Row[]>,
  ]);
  const depBy = new Map(deps.map((d) => [key(d._id), d]));
  const out = new Map<string, string | null>();
  for (const r of rows) {
    let name: string | null;
    if (r?.dependentId) {
      const dep = depBy.get(key(r.dependentId));
      name = dep && key(dep.userId) === key(r.userId) ? (String(dep.name ?? '').trim() || null) : null;
    } else {
      name = holders.get(key(r.userId)) ?? null;
    }
    out.set(key(r._id), name);
  }
  return out;
}

/**
 * Review finding 8: pharmacy order rows (list, review queue) name their customer as the booker view does. Rows whose
 * `customerId` is populated (`{_id, name, phone}`) get `name` replaced; other rows are unchanged.
 */
export async function withPharmacyFacingCustomerNames<T>(rows: T[], pharmacyId: string): Promise<T[]> {
  const isPopulated = (r: Row) => !!r?.customerId && typeof r.customerId === 'object' && !(r.customerId instanceof Types.ObjectId)
    && !!r.customerId._id;
  const populated = (rows as Row[]).filter(isPopulated);
  if (!populated.length) return rows;
  const names = await pharmacyFacingHolderNames(populated.map((r) => r.customerId._id), pharmacyId);
  return (rows as Row[]).map((r) => (isPopulated(r)
    ? { ...r, customerId: { ...r.customerId, name: names.get(key(r.customerId._id)) ?? null } }
    : r)) as T[];
}

/**
 * Assisted booking phase 1a (§17.4): the same names rule for other pharmacy-facing lists that populate a customer under
 * another field (`userId` on subscriptions): `name` from pharmacyFacingHolderNames, and the email is never shown. Rows
 * whose field is not populated are left as they are.
 */
export async function withLinkNames<T>(rows: T[], pharmacyId: string, field: string): Promise<T[]> {
  if (!Array.isArray(rows) || !rows.length) return rows;
  const isPopulated = (r: Row) => !!r?.[field] && typeof r[field] === 'object' && !(r[field] instanceof Types.ObjectId) && !!r[field]._id;
  const populated = (rows as Row[]).filter(isPopulated);
  if (!populated.length) return rows;
  const names = await pharmacyFacingHolderNames(populated.map((r) => r[field]._id), pharmacyId);
  return (rows as Row[]).map((r) => {
    if (!isPopulated(r)) return r;
    const { email: _e, ...rest } = r[field] as Row;
    return { ...r, [field]: { ...rest, name: names.get(key(rest._id)) ?? null } };
  }) as T[];
}
