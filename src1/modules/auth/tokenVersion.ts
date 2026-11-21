import { ClientSession, Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import PharmacyModel from '@/modules/pharmacies/model';
import SpecialistModel from '@/modules/specialists/model';
import MemberModel from '@/modules/partners/model/member';
import { storedCredentialVersion, tokenCredentialVersion } from '@/modules/user/credentialGeneration';

/**
 * Q16b: token generation for pharmacy, doctor and partner-member accounts (customers have theirs: C1r,
 * user/credentialGeneration.ts). Every token of these roles carries the account's `authVersion` when it was issued;
 * `authenticate` admits it only while the account still has that generation. A sign-in contact change and "sign out on
 * all devices" advance it (inside revokeAllSessions), so the 30-day bearer tokens of the released pharmacy apps end with
 * the sessions. Accounts and tokens from before this change have no field: both read as 0, so the deploy signs nobody out.
 * The field lives only in the database (not in the schemas), so no request body can ever set it.
 */
export type VersionedRole = 'pharmacy' | 'specialist' | 'partner';
const COLLECTION: Record<VersionedRole, () => typeof PharmacyModel.collection> = {
  pharmacy: () => PharmacyModel.collection,
  specialist: () => SpecialistModel.collection,
  partner: () => MemberModel.collection,
};
export const isVersionedRole = (t: unknown): t is VersionedRole => t === 'pharmacy' || t === 'specialist' || t === 'partner';

const reauth = () => new AppError({ status: 401, code: 'UNAUTHORIZED', message: 'Please sign in again' });
const unavailable = () => new AppError({ status: 503, code: 'AUTH_STATE_UNAVAILABLE', message: 'Sign-in state is temporarily unavailable' });
const objectId = (id: string): Types.ObjectId | null =>
  (Types.ObjectId.isValid(id) && String(new Types.ObjectId(id)) === id.toLowerCase() ? new Types.ObjectId(id) : null);

/** The account id a token of this role acts as (the same fallback the role guards use). */
export function accountIdOf(claims: { _id?: unknown; pharmacyId?: unknown; specialistId?: unknown; memberId?: unknown; userType?: unknown }): string {
  const v = claims.userType === 'pharmacy' ? claims.pharmacyId || claims._id
    : claims.userType === 'specialist' ? claims.specialistId || claims._id
      : claims.memberId || claims._id;
  return typeof v === 'string' ? v : '';
}

/** Current generation of the account (absent = 0, corrupt = -1); null if there is no such account. */
export async function readTokenVersion(role: VersionedRole, id: string, session?: ClientSession): Promise<number | null> {
  const _id = objectId(id);
  if (!_id) return null;
  let row: Record<string, unknown> | null;
  try {
    row = await COLLECTION[role]().findOne({ _id }, { projection: { authVersion: 1 }, maxTimeMS: 2000, ...(session ? { session } : {}) });
  } catch { throw unavailable(); }
  return row ? storedCredentialVersion(row) : null;
}

/**
 * Advances the account's generation by one (every token and session issued so far stops working). In the caller's
 * transaction when it has one. An unknown id changes nothing.
 */
export async function advanceTokenVersion(role: VersionedRole, id: string, session?: ClientSession): Promise<void> {
  const _id = objectId(id);
  if (!_id) return;
  await COLLECTION[role]().updateOne({ _id }, { $inc: { authVersion: 1 } }, session ? { session } : {});
}

/**
 * Middleware check for pharmacy, doctor and partner tokens (other roles are unaffected). A missing account is left to
 * the role guards (as before); a token claiming a generation the account does not have is refused.
 */
export async function admitVersionedToken(claims: Record<string, unknown> | undefined): Promise<void> {
  if (!claims || !isVersionedRole(claims.userType)) return;
  const claimed = tokenCredentialVersion(claims);
  const id = accountIdOf(claims);
  if (!id) throw reauth();
  const current = await readTokenVersion(claims.userType, id);
  if ((current ?? 0) !== claimed) throw reauth();
}

/** The generation to put in a token being issued now (after the code was proven). A corrupt stored value issues nothing. */
export async function versionForNewToken(role: VersionedRole, id: string): Promise<number> {
  const v = (await readTokenVersion(role, id)) ?? 0;
  if (v < 0) throw reauth();
  return v;
}
