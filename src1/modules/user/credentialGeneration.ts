import { ClientSession, Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import UserModel from '@/modules/user/model';

/**
 * Customer credential generation (C1 revoke-only). Every customer token carries the account's `authVersion` at the
 * time it was issued; the middleware admits it only while the account still has that generation. "Sign out on all
 * devices" advances the generation, so every earlier token stops working. Accounts and tokens from before this change
 * have no field: both read as generation 0, so deploying this signs nobody out.
 */
const reauth = () => new AppError({ status: 401, code: 'UNAUTHORIZED', message: 'Please sign in again' });
const unavailable = () => new AppError({ status: 503, code: 'AUTH_STATE_UNAVAILABLE', message: 'Sign-in state is temporarily unavailable' });
const isVersion = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;

/** Generation claimed by a decoded token: absent = 0 (legacy token); anything else malformed = not admitted. */
export function tokenCredentialVersion(claims: { authVersion?: unknown } | undefined): number {
  if (!claims || !Object.prototype.hasOwnProperty.call(claims, 'authVersion')) return 0;
  if (!isVersion(claims.authVersion)) throw reauth();
  return claims.authVersion;
}

/**
 * Filter matching an account exactly at generation `version`. Absent counts as 0. Only scalar numeric types match:
 * Mongo equality would also match an array element, which must never pass as a generation.
 */
export function credentialFilter(version: number): Record<string, unknown> {
  return {
    $expr: { $in: [{ $type: '$authVersion' }, version === 0 ? ['missing', 'int', 'long', 'double'] : ['int', 'long', 'double']] },
    ...(version === 0 ? { $or: [{ authVersion: { $exists: false } }, { authVersion: { $eq: 0 } }] } : { authVersion: { $eq: version } }),
  };
}

/** Current generation of a customer account; null if there is no such customer. */
export async function readCredentialVersion(userId: string, session?: ClientSession): Promise<number | null> {
  if (!Types.ObjectId.isValid(userId) || String(new Types.ObjectId(userId)) !== userId.toLowerCase()) return null;
  let row: { authVersion?: unknown; userType?: unknown } | null;
  try {
    row = await UserModel.findOne({ _id: new Types.ObjectId(userId) }).select({ authVersion: 1, userType: 1 })
      .session(session ?? null).maxTimeMS(2000).lean() as { authVersion?: unknown; userType?: unknown } | null;
  } catch { throw unavailable(); }
  if (!row || row.userType !== 'user') return null;
  return storedCredentialVersion(row);
}

/**
 * Generation stored on an account row. Only an ABSENT field is legacy generation 0 (exactly what credentialFilter(0)
 * matches). Anything present but not a safe non-negative integer, including a stored BSON Undefined (decoded as an
 * own property whose value is undefined) or null, is corrupt: -1, which matches no token.
 */
export function storedCredentialVersion(row: { authVersion?: unknown }): number {
  if (!Object.prototype.hasOwnProperty.call(row, 'authVersion')) return 0;
  return isVersion(row.authVersion) ? row.authVersion : -1;
}

/** Middleware check for customer tokens. Other token types are unaffected. */
export async function admitCustomerToken(claims: { _id?: unknown; userType?: unknown; authVersion?: unknown } | undefined): Promise<void> {
  if (!claims || claims.userType !== 'user') return;
  if (typeof claims._id !== 'string') throw reauth();
  const claimed = tokenCredentialVersion(claims);
  const current = await readCredentialVersion(claims._id);
  if (current === null || current !== claimed) throw reauth();
}

/** Advances the generation from exactly `version` (the caller's token). False if it already moved on. */
export async function advanceCredentialVersion(userId: string, version: number): Promise<boolean> {
  if (version >= Number.MAX_SAFE_INTEGER) throw new AppError({ status: 409, code: 'CREDENTIAL_VERSION_EXHAUSTED', message: 'Cannot sign out again' });
  const r = await UserModel.updateOne({ _id: new Types.ObjectId(userId), userType: 'user', ...credentialFilter(version) },
    { $set: { authVersion: version + 1 } });
  return r.modifiedCount === 1;
}
