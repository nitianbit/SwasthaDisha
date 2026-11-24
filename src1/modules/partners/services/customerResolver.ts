import UserModel from '@/modules/user/model';
import { AppError } from '@/modules/common/types';
import { canonicalMobile } from '@/modules/common/utils/phone';

/**
 * §6a. Customer phones are stored as ten digits. The resolver runs only while the unique partial index below is built
 * and ready on `users` (created by scripts/q2-user-phone-index.ts after its duplicate scan); there is no fallback.
 */
export const CUSTOMER_PHONE_INDEX = Object.freeze({
  name: 'q2_user_phone_unique',
  key: { phone: 1, userType: 1 },
  partialFilterExpression: { phone: { $type: 'string' } },
});

export function normalizePhone(raw: string): string {
  const phone = canonicalMobile(raw);
  if (!phone) throw new AppError({ status: 400, code: 'INVALID_PHONE', message: 'Enter a valid 10-digit mobile number' });
  return phone;
}

function isRequiredIndex(spec: any): boolean {
  if (!spec || spec.unique !== true || spec.sparse === true || spec.hidden === true) return false;
  const key = spec.key ?? {};
  const keys = Object.keys(key);
  if (keys.length !== 2 || keys[0] !== 'phone' || keys[1] !== 'userType' || key.phone !== 1 || key.userType !== 1) return false;
  const pfe = spec.partialFilterExpression;
  return !!pfe && Object.keys(pfe).length === 1 && !!pfe.phone && Object.keys(pfe.phone).length === 1 && pfe.phone.$type === 'string';
}

let readyUntil = 0;

/** Whether the unique partial phone index is present AND finished building (an in-progress build does not count). */
export async function customerPhoneIndexReady(now = Date.now()): Promise<boolean> {
  if (now < readyUntil) return true;
  let rows: any[];
  try {
    const r: any = await UserModel.db.db.command({ listIndexes: UserModel.collection.collectionName, includeIndexBuildInfo: true });
    rows = r?.cursor?.firstBatch ?? [];
  } catch {
    return false;
  }
  const ok = rows.some((row) => row && row.indexBuildInfo === undefined && isRequiredIndex(row.spec));
  if (ok) readyUntil = now + 60_000;
  return ok;
}

export function resetCustomerPhoneIndexCache(): void {
  readyUntil = 0;
}

export interface ResolvedCustomer {
  _id: string;
  phone: string;
  /** True when this call inserted the account. */
  created: boolean;
  /** The customer has never completed an OTP sign-in. */
  neverSignedIn: boolean;
}

/**
 * Find-or-create the customer account for a phone. Never merges accounts and never overwrites an existing customer's
 * fields (`$setOnInsert` only).
 */
export async function resolveCustomerByPhone(rawPhone: string, source: 'partner_invoice' | 'clinic_desk' | 'assisted_booking' | 'lab_desk'): Promise<ResolvedCustomer> {
  const phone = normalizePhone(rawPhone);
  if (!(await customerPhoneIndexReady())) {
    throw new AppError({
      status: 503,
      code: 'CUSTOMER_LINKING_UNAVAILABLE',
      message: 'Customer linking is not available yet; issue the bill without a phone number or try again later',
    });
  }
  const upsert = () => UserModel.findOneAndUpdate(
    { phone, userType: 'user' },
    { $setOnInsert: { phone, userType: 'user', createdSource: source, otpVerified: false } },
    { upsert: true, new: true, rawResult: true, runValidators: true, projection: { _id: 1, phone: 1, otpVerified: 1 } }
  );
  let raw: any;
  try {
    raw = await upsert();
  } catch (e: any) {
    if (e?.code !== 11000) throw e;
    raw = await upsert(); // a concurrent insert won; this now finds it
  }
  const doc = raw?.value;
  if (!doc) throw new AppError({ status: 500, code: 'CUSTOMER_LINKING_FAILED', message: 'Could not link the customer' });
  return {
    _id: String(doc._id),
    phone: doc.phone,
    created: raw?.lastErrorObject?.updatedExisting === false,
    neverSignedIn: doc.otpVerified !== true,
  };
}
