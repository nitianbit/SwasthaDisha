import { Types } from 'mongoose';
import UserModel from '@/modules/user/model';
import DependentModel from '@/modules/dependents/model';

type Row = Record<string, any>;

/**
 * Q15 (admin booking list): each row gains `patientName` — the family member's name when the booking is for a dependent,
 * otherwise the account holder's name (null when neither is known). Two batched reads; for admin callers only.
 */
export async function withPatientNames<T extends Row>(rows: T[]): Promise<(T & { patientName: string | null })[]> {
  const ids = (key: string) => [...new Set(rows.map((r) => String(r?.[key] ?? '')).filter((id) => Types.ObjectId.isValid(id) && id.length === 24))];
  const [users, deps] = await Promise.all([
    UserModel.find({ _id: { $in: ids('userId') } }).select({ name: 1 }).lean() as unknown as Promise<{ _id: unknown; name?: string }[]>,
    DependentModel.find({ _id: { $in: ids('dependentId') } }).select({ name: 1 }).lean() as unknown as Promise<{ _id: unknown; name?: string }[]>,
  ]);
  const name = (list: { _id: unknown; name?: string }[]) => new Map(list.map((d) => [String(d._id).toLowerCase(), d.name?.trim() || null]));
  const userNames = name(users);
  const depNames = name(deps);
  return rows.map((r) => {
    const dep = r?.dependentId ? depNames.get(String(r.dependentId).toLowerCase()) : undefined;
    const holder = r?.userId ? userNames.get(String(r.userId).toLowerCase()) : undefined;
    return { ...r, patientName: (r?.dependentId ? dep : holder) ?? null };
  });
}
