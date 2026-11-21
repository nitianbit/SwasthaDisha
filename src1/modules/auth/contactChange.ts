import mongoose, { ClientSession } from 'mongoose';
import { revokeAllSessions } from '@/modules/auth/sessions';
import { AppError } from '@/modules/common/types';
import MemberModel from '@/modules/partners/model/member';
import { bumpCredentialVersion } from '@/modules/user/credentialGeneration';

/**
 * A sign-in contact moved: an existing phone or email changed or was removed. Q16b N4: a FIRST phone or email (none
 * before) ends nothing — the sessions were opened with the other contact, which still works.
 */
export function signInContactChanged(before: { phone?: unknown; email?: unknown }, write: { phone?: unknown; email?: unknown }): boolean {
  const norm = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
  const phoneChanged = !!norm(before.phone) && write.phone !== undefined && norm(write.phone) !== norm(before.phone);
  const emailChanged = !!norm(before.email) && write.email !== undefined && norm(write.email) !== norm(before.email);
  return phoneChanged || emailChanged;
}

/**
 * Q16b: an admin's change of a customer's or doctor's sign-in contact ends every sign-in made with the old one. The
 * write and the ending commit together (one transaction): the account's token generation advances (customers: C1r
 * authVersion; doctors: tokenVersion) and every web/app session ends. Nothing ends when the write matched nothing (null).
 */
export async function inContactChange<T>(userType: 'user' | 'specialist', userId: string, reason: string,
  write: (session: ClientSession) => Promise<T | null>, endSignIns = true): Promise<T | null> {
  const session = await mongoose.startSession();
  try {
    let out: T | null = null;
    await session.withTransaction(async () => {
      out = await write(session);
      if (!out || !endSignIns) return;
      if (userType === 'user') await bumpCredentialVersion(userId, session);
      await revokeAllSessions(userType, userId, reason, session);
    });
    return out;
  } finally {
    await session.endSession();
  }
}

const phoneInUseAtClinic = () => new AppError({ status: 409, code: 'PHONE_IN_USE_AT_CLINIC',
  message: 'Another member of a clinic this doctor works at already signs in with this mobile number' });

/**
 * Q16b N2: a doctor's clinic memberships sign in with the doctor's mobile number, so an admin's change of that number
 * moves every active membership carrying the doctor (same transaction): the phone is updated and the member's token
 * generation and sessions end (the old number no longer opens the clinic workspace). A number another active member of
 * the same partner already uses refuses the whole edit (409 PHONE_IN_USE_AT_CLINIC).
 */
export async function moveDoctorMemberPhones(doctorId: string, phone: string, session: ClientSession): Promise<void> {
  const rows = await MemberModel.find({ doctorId: String(doctorId).toLowerCase(), isActive: true }).session(session)
    .select({ partnerId: 1, phone: 1 }).lean() as { _id: unknown; partnerId: string; phone: string }[];
  for (const m of rows) {
    if (m.phone === phone) continue;
    if (await MemberModel.exists({ partnerId: m.partnerId, phone, isActive: true, _id: { $ne: m._id } }).session(session)) throw phoneInUseAtClinic();
    try {
      await MemberModel.updateOne({ _id: m._id, isActive: true }, { $set: { phone } }, { session });
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw phoneInUseAtClinic();
      throw e;
    }
    await revokeAllSessions('partner', String(m._id), 'sign_in_phone_changed', session);
  }
}
