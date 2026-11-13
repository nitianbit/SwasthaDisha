import { ClientSession, Types } from 'mongoose';
import { InventoryItemModel } from '@/modules/pharmacyInventory/model';

export const todayYyyymmdd = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');

/**
 * Sellable stock, the same rule reservations use: active, unexpired batch quantity; items without batches (legacy)
 * use availableQty. Expired/quarantined/recalled units never count.
 */
export function sellableQtyExpr(today = todayYyyymmdd()) {
  return {
    $cond: [
      { $gt: [{ $size: { $ifNull: ['$batches', []] } }, 0] },
      { $sum: { $map: { input: { $ifNull: ['$batches', []] }, as: 'b',
        in: { $cond: [{ $and: [{ $eq: ['$$b.status', 'active'] }, { $gte: ['$$b.expiryDate', today] }] }, '$$b.availableQty', 0] } } } },
      '$availableQty',
    ],
  };
}

export function sellableQty(item: { availableQty?: number; batches?: { status?: string; expiryDate?: string; availableQty?: number }[] },
  today = todayYyyymmdd()): number {
  const batches = item.batches ?? [];
  if (!batches.length) return Number(item.availableQty ?? 0);
  return batches.filter(b => b.status === 'active' && String(b.expiryDate) >= today).reduce((a, b) => a + Number(b.availableQty ?? 0), 0);
}

/** Update-pipeline stage: clears the low-stock marker iff sellable stock (after the preceding stages) is above the level. */
export function rearmStage(today = todayYyyymmdd()) {
  return { $set: { lowStockNotifiedAt: { $cond: [{ $gt: [sellableQtyExpr(today), '$reorderThreshold'] }, '$$REMOVE', '$lowStockNotifiedAt'] } } };
}

/**
 * Called by every write that can ADD sellable stock, in the same session: once sellable stock is back above the
 * reorder level, the low-stock "notified" marker is cleared, so the next drop alerts again even if no sweep ran
 * in between (P7c).
 */
export async function rearmLowStock(pharmacyId: unknown, medicineId: unknown, session?: ClientSession | null): Promise<void> {
  const pid = Types.ObjectId.isValid(String(pharmacyId)) ? new Types.ObjectId(String(pharmacyId)) : pharmacyId;
  const mid = Types.ObjectId.isValid(String(medicineId)) ? new Types.ObjectId(String(medicineId)) : medicineId;
  await InventoryItemModel.updateOne(
    { pharmacyId: pid, medicineId: mid, lowStockNotifiedAt: { $exists: true }, $expr: { $gt: [sellableQtyExpr(), '$reorderThreshold'] } },
    { $unset: { lowStockNotifiedAt: '' } }, session ? { session } : {});
}
