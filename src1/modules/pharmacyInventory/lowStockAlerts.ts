import { Service } from 'typedi';
import { startSession, Types } from 'mongoose';
import { addDaysToYyyymmdd, getTodayYyyymmdd } from '@/modules/common/utils/dateUtils';
import { InventoryItemModel } from '@/modules/pharmacyInventory/model';
import MedicineModel from '@/modules/pharmacyMedicines/model';
import NotificationModel from '@/modules/notification/model';
import PharmacySubscriptionModel from '@/modules/pharmacySubscriptions/model';
import { sellableQty, sellableQtyExpr } from '@/modules/pharmacyInventory/sellable';

/** Refill demand window shown on the low-stock worklist. */
export const REFILL_DEMAND_DAYS = 14;
/** Only items whose pharmacy set a reorder threshold above zero raise notifications; sellable stock decides. */
const low = () => ({ isActive: true, reorderThreshold: { $gt: 0 }, $expr: { $lte: [sellableQtyExpr(), '$reorderThreshold'] } });

/**
 * Low stock (P7c): worklist enrichment with upcoming refill demand, and a sweep that notifies the pharmacy once per
 * drop below the reorder threshold. The "notified" marker and the notification are written in one transaction, and
 * the marker is cleared when the item is restocked above its threshold, so the next drop notifies again.
 */
@Service()
export class LowStockAlertService {
  /** Active refill subscriptions per medicine at this pharmacy, due within REFILL_DEMAND_DAYS. */
  async refillDemand(pharmacyId: string, medicineIds: string[]): Promise<Map<string, number>> {
    const ids = medicineIds.filter(id => Types.ObjectId.isValid(id)).map(id => new Types.ObjectId(id));
    if (!ids.length || !Types.ObjectId.isValid(pharmacyId)) return new Map();
    const through = addDaysToYyyymmdd(getTodayYyyymmdd(), REFILL_DEMAND_DAYS);
    const rows = await PharmacySubscriptionModel.aggregate<{ _id: Types.ObjectId; count: number }>([
      { $match: { pharmacyId: new Types.ObjectId(pharmacyId), medicineId: { $in: ids }, isActive: true, nextRefillDate: { $lte: through } } },
      { $group: { _id: '$medicineId', count: { $sum: 1 } } },
    ]);
    return new Map(rows.map(r => [String(r._id), r.count]));
  }

  async sweep(limit = 200): Promise<{ notified: number; cleared: number }> {
    // Safety net; stock-adding writes already re-arm in their own transaction (sellable.rearmLowStock).
    const cleared = await InventoryItemModel.updateMany(
      { lowStockNotifiedAt: { $exists: true }, $expr: { $gt: [sellableQtyExpr(), '$reorderThreshold'] } },
      { $unset: { lowStockNotifiedAt: '' } });
    const candidates = await InventoryItemModel.find({ ...low(), lowStockNotifiedAt: { $exists: false } }).select('_id').limit(limit).lean();
    let notified = 0;
    for (const candidate of candidates) {
      const session = await startSession();
      try {
        await session.withTransaction(async () => {
          // Re-check and mark in one write; the message is built from the document as it is at that moment.
          const item = await InventoryItemModel.findOneAndUpdate({ _id: candidate._id, ...low(), lowStockNotifiedAt: { $exists: false } },
            { $set: { lowStockNotifiedAt: new Date() } }, { new: true, session }).lean();
          if (!item) return; // restocked or already notified meanwhile
          const qty = sellableQty(item as never);
          const medicine = await MedicineModel.findById(item.medicineId).select('name').session(session).lean();
          const name = (medicine as { name?: string } | null)?.name ?? 'A medicine';
          await NotificationModel.create([{ userId: String(item.pharmacyId), type: 'general', title: 'Low stock',
            message: `${name} is low: ${qty} sellable left (reorder level ${item.reorderThreshold}).`, isRead: false,
            referenceType: 'inventory_low_stock', referenceId: String(item._id),
            data: { medicineId: String(item.medicineId), sellableQty: qty, reorderThreshold: item.reorderThreshold } }], { session });
          notified++;
        });
      } finally { await session.endSession(); }
    }
    return { notified, cleared: cleared.modifiedCount };
  }
}
