import { ClientSession, Types } from 'mongoose';
import PharmacySupplierModel from '@/modules/pharmacySuppliers/model';
import { AppError } from '@/modules/common/types';

/**
 * Q16c: supplier per delivery. The supplier a stock delivery came from is recorded on that delivery's adjustment
 * (Add stock or an import row), never on the batch: one batch (number + expiry) can be topped up by later deliveries
 * from other suppliers. It must be one of the pharmacy's own suppliers and active.
 */
export const isHexId = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-fA-F]{24}$/.test(value);

export interface DeliverySupplier { supplierId: string; displayName: string; state: 'active' | 'archived' }

const notFound = () => new AppError({ status: 404, code: 'SUPPLIER_NOT_FOUND', message: 'Supplier not found' });

/** The pharmacy's suppliers (any state), for name matching in imports. */
export async function suppliersOf(pharmacyId: string): Promise<DeliverySupplier[]> {
  if (!isHexId(pharmacyId)) return [];
  const rows = await PharmacySupplierModel.find({ pharmacyId: new Types.ObjectId(pharmacyId) })
    .select({ _id: 1, displayName: 1, state: 1 }).lean();
  return rows.map((r) => ({ supplierId: String(r._id).toLowerCase(), displayName: String(r.displayName), state: r.state }));
}

/** 404 SUPPLIER_NOT_FOUND unless it is this pharmacy's supplier; 409 SUPPLIER_ARCHIVED unless it is active. */
export async function assertDeliverySupplier(pharmacyId: string, supplierId: unknown, session?: ClientSession | null): Promise<DeliverySupplier> {
  if (!isHexId(supplierId) || !isHexId(pharmacyId)) throw notFound();
  const row = await PharmacySupplierModel.findOne({ _id: new Types.ObjectId(supplierId), pharmacyId: new Types.ObjectId(pharmacyId) })
    .select({ _id: 1, displayName: 1, state: 1 }).session(session ?? null).lean();
  if (!row) throw notFound();
  if (row.state !== 'active') throw new AppError({ status: 409, code: 'SUPPLIER_ARCHIVED', message: 'This supplier is archived' });
  return { supplierId: String(row._id).toLowerCase(), displayName: String(row.displayName), state: row.state };
}

/** The adjustment history rows with `supplier: { supplierId, displayName, state }` (null when the row has none). */
export async function withSuppliers<T extends { supplierId?: unknown }>(pharmacyId: string, rows: T[]): Promise<(T & { supplier: DeliverySupplier | null })[]> {
  const ids = [...new Set(rows.map((r) => (r.supplierId ? String(r.supplierId) : '')).filter(isHexId))];
  const byId = new Map<string, DeliverySupplier>();
  if (ids.length && isHexId(pharmacyId)) {
    const found = await PharmacySupplierModel.find({ _id: { $in: ids.map((id) => new Types.ObjectId(id)) }, pharmacyId: new Types.ObjectId(pharmacyId) })
      .select({ _id: 1, displayName: 1, state: 1 }).lean();
    for (const s of found) byId.set(String(s._id), { supplierId: String(s._id), displayName: String(s.displayName), state: s.state });
  }
  return rows.map((r) => ({ ...r, supplier: r.supplierId ? byId.get(String(r.supplierId)) ?? null : null }));
}
