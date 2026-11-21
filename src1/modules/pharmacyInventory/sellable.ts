import { ClientSession, Types } from 'mongoose';
import { InventoryItemModel } from '@/modules/pharmacyInventory/model';
import { istTodayYyyymmdd } from '@/modules/pharmacyInventory/businessDate';

// Q16c: the IST calendar date, explicitly (it was the process-local date, which is the UTC date on a UTC server).
export const todayYyyymmdd = (): string => istTodayYyyymmdd();

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

/**
 * Q16c: the shelf lists an item only at a price its viewer can buy at, the cart's own rule (MEDICINE_PRICE_NOT_AVAILABLE
 * otherwise): a customer pays the retail price; a pharmacy (or admin) viewer the wholesale price, or the retail price
 * when no wholesale price is set. An item without that price (a new medicine imported without one) is not sellable
 * until priced.
 */
export function pricedForViewerMatch(wholesaleViewer: boolean): Record<string, unknown> {
  return wholesaleViewer
    ? { $or: [{ wholesalePrice: { $gt: 0 } }, { wholesalePrice: null, retailPrice: { $gt: 0 } }] }
    : { retailPrice: { $gt: 0 } };
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
