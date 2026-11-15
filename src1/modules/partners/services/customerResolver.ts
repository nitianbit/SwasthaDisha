import UserModel from '@/modules/user/model';

export function normalizePhone(raw: string): string {
  let phone = raw.trim();
  if (phone.startsWith('+91')) phone = phone.slice(3);
  else if (phone.startsWith('91') && phone.length === 12) phone = phone.slice(2);
  else if (phone.startsWith('0')) phone = phone.slice(1);
  if (!/^[0-9]{10}$/.test(phone)) {
    throw new Error(`Invalid phone after normalization: ${raw}`);
  }
  return phone;
}

export async function resolveCustomerByPhone(
  rawPhone: string,
  source: string
): Promise<{ _id: unknown; phone: string } | null> {
  const phone = normalizePhone(rawPhone);
  const user = await UserModel.findOneAndUpdate(
    { phone, userType: 'user' },
    { $setOnInsert: { createdSource: source, userType: 'user', otpVerified: false } },
    { upsert: true, new: true }
  ).select('_id phone').lean();
  return user as { _id: unknown; phone: string } | null;
}
