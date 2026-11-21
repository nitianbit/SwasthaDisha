import mongoose, { ClientSession } from 'mongoose';
import { revokeAllSessions } from '@/modules/auth/sessions';
import { bumpCredentialVersion } from '@/modules/user/credentialGeneration';

/** A sign-in contact moved: the phone changed, or an existing email changed or was removed (a first email ends nothing). */
export function signInContactChanged(before: { phone?: unknown; email?: unknown }, write: { phone?: unknown; email?: unknown }): boolean {
  const norm = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
  const phoneChanged = write.phone !== undefined && norm(write.phone) !== norm(before.phone);
  const emailChanged = !!norm(before.email) && write.email !== undefined && norm(write.email) !== norm(before.email);
  return phoneChanged || emailChanged;
}

/**
 * Q16b: an admin's change of a customer's or doctor's sign-in contact ends every sign-in made with the old one. The
 * write and the ending commit together (one transaction): the account's token generation advances (customers: C1r
 * authVersion; doctors: tokenVersion) and every web/app session ends. Nothing ends when the write matched nothing (null).
 */
export async function inContactChange<T>(userType: 'user' | 'specialist', userId: string, reason: string,
  write: (session: ClientSession) => Promise<T | null>): Promise<T | null> {
  const session = await mongoose.startSession();
  try {
    let out: T | null = null;
    await session.withTransaction(async () => {
      out = await write(session);
      if (!out) return;
      if (userType === 'user') await bumpCredentialVersion(userId, session);
      await revokeAllSessions(userType, userId, reason, session);
    });
    return out;
  } finally {
    await session.endSession();
  }
}
