import { Service } from 'typedi';
import { ClientSession, startSession, Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { InventoryAdjustmentModel, InventoryItemModel } from '@/modules/pharmacyInventory/model';
import { SupplierReturnModel, ISupplierReturn } from '@/modules/pharmacyInventory/supplierReturnModel';
import { rearmLowStock, todayYyyymmdd } from '@/modules/pharmacyInventory/sellable';
import PharmacySupplierModel from '@/modules/pharmacySuppliers/model';
import PharmacyOrderModel from '@/modules/pharmacyOrders/model';

export interface StaffActor { pharmacyId: string; actorId: string }
const OPEN_ORDER_STATUSES = ['placed', 'accepted', 'packed', 'ready_for_pickup', 'out_for_delivery', 'delivery_failed'];
const RETURNABLE = ['active', 'expired', 'quarantined', 'recalled'];

const notFound = () => new AppError({ status: 404, code: 'BATCH_NOT_FOUND', message: 'Inventory batch not found' });
const changed = () => new AppError({ status: 409, code: 'BATCH_STATE_CHANGED', message: 'The batch changed; reload and try again' });
const isId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v);

async function inTransaction<T>(work: (s: ClientSession) => Promise<T>): Promise<T> {
  const session = await startSession();
  try {
    let result: T | undefined;
    await session.withTransaction(async () => { result = await work(session); });
    return result as T;
  } finally { await session.endSession(); }
}

/**
 * Batch quality operations (P3): quarantine/release (with optional write-off) and returns to suppliers.
 * Every stock change is ONE conditional write on the batch (status + quantity in the filter) in a transaction with
 * its adjustment / supplier-return record, so concurrent operations can never drive quantities negative or act on
 * a batch whose state changed. Reserved units are never touched: orders holding them are surfaced by impactedOrders().
 */
@Service()
export class BatchQualityService {
  private async loadBatch(actor: StaffActor, itemId: unknown, batchId: unknown) {
    if (!isId(itemId) || !isId(batchId) || !isId(actor.pharmacyId)) throw notFound();
    const item = await InventoryItemModel.findOne({ _id: itemId, pharmacyId: actor.pharmacyId }).lean();
    const batch = item?.batches?.find(b => String((b as { _id?: unknown })._id) === batchId.toLowerCase());
    if (!item || !batch) throw notFound();
    return { item, batch };
  }

  /** Puts a sellable/expired batch on hold: it can no longer be sold or reserved. Returns orders holding its units. */
  async quarantine(actor: StaffActor, itemId: unknown, batchId: unknown, reason: string) {
    const { item, batch } = await this.loadBatch(actor, itemId, batchId);
    if (!['active', 'expired'].includes(batch.status)) {
      throw new AppError({ status: 409, code: 'BATCH_NOT_HOLDABLE', message: `A ${batch.status} batch cannot be quarantined` });
    }
    const r = await InventoryItemModel.updateOne(
      { _id: item._id, pharmacyId: actor.pharmacyId, batches: { $elemMatch: { _id: new Types.ObjectId(String(batchId)), status: batch.status } } },
      { $set: { 'batches.$.status': 'quarantined', 'batches.$.holdId': new Types.ObjectId().toHexString(),
        'batches.$.holdReason': reason.trim(), 'batches.$.heldAt': new Date(), 'batches.$.heldBy': actor.actorId } });
    if (r.modifiedCount !== 1) throw changed();
    return { batch: await this.batchView(String(item._id), String(batchId)), impactedOrders: await this.impactedOrders(actor, [String(batchId)]) };
  }

  /**
   * Releases a quarantined batch back to sale (or 'expired' if past its date), first writing off `writeOffQty` of its
   * unreserved units (recorded as an adjustment). Reserved units stay with their orders.
   */
  async release(actor: StaffActor, itemId: unknown, batchId: unknown, writeOffQty: number, reason: string) {
    const { item, batch } = await this.loadBatch(actor, itemId, batchId);
    if (batch.status !== 'quarantined') throw new AppError({ status: 409, code: 'BATCH_NOT_QUARANTINED', message: 'Only a quarantined batch can be released' });
    if (!Number.isSafeInteger(writeOffQty) || writeOffQty < 0 || writeOffQty > batch.availableQty) {
      throw new AppError({ status: 400, code: 'VALIDATION_ERROR', message: `Write-off must be between 0 and ${batch.availableQty} (unreserved units)` });
    }
    const nextStatus = batch.expiryDate < todayYyyymmdd() ? 'expired'
      : (batch.availableQty - writeOffQty === 0 && batch.reservedQty === 0 ? 'depleted' : 'active');
    await inTransaction(async s => {
      // Fenced on THIS hold (holdId) and its exact quantities: a stale release cannot clear a newer quarantine.
      const pre = await InventoryItemModel.findOneAndUpdate(
        { _id: item._id, pharmacyId: actor.pharmacyId, availableQty: { $gte: writeOffQty },
          batches: { $elemMatch: { _id: new Types.ObjectId(String(batchId)), status: 'quarantined',
            holdId: batch.holdId ?? { $exists: false }, availableQty: batch.availableQty, reservedQty: batch.reservedQty } } },
        { $inc: { availableQty: -writeOffQty, 'batches.$.availableQty': -writeOffQty },
          $set: { 'batches.$.status': nextStatus, ...(nextStatus === 'depleted' ? { 'batches.$.depletedAt': new Date() } : {}) },
          $unset: { 'batches.$.holdId': '', 'batches.$.holdReason': '', 'batches.$.heldAt': '', 'batches.$.heldBy': '' } },
        { new: false, session: s }).lean();
      if (!pre) throw changed();
      if (writeOffQty > 0) {
        // Audit from the committed write's pre-image, batch-scoped like stock receipts (adjustBatchStock).
        const was = pre.batches!.find(b => String((b as { _id?: unknown })._id) === String(batchId).toLowerCase())!;
        await InventoryAdjustmentModel.create([{ pharmacyId: actor.pharmacyId, medicineId: pre.medicineId, inventoryItemId: pre._id,
          adjustmentType: 'remove', quantity: writeOffQty, batchId: was._id, batchNumber: was.batchNumber, expiryDate: was.expiryDate,
          availableQtyBefore: was.availableQty, availableQtyAfter: was.availableQty - writeOffQty, sourceType: 'manual',
          reason: 'damage', notes: `Written off on release from quarantine: ${reason.trim()}`, adjustedBy: actor.actorId, adjustedByRole: 'pharmacy' }], { session: s });
      }
      await rearmLowStock(item.pharmacyId, item.medicineId, s); // released units are sellable again
      return true;
    });
    return { batch: await this.batchView(String(item._id), String(batchId)) };
  }

  /** Sends unreserved units of a batch back to one of the pharmacy's own active suppliers. */
  async returnToSupplier(actor: StaffActor, itemId: unknown, batchId: unknown,
    input: { supplierId: unknown; quantity: number; reason: ISupplierReturn['reason']; notes?: string }) {
    const { item, batch } = await this.loadBatch(actor, itemId, batchId);
    if (!isId(input.supplierId)) throw new AppError({ status: 404, code: 'SUPPLIER_NOT_FOUND', message: 'Supplier not found' });
    const supplier = await PharmacySupplierModel.findOne({ _id: input.supplierId, pharmacyId: new Types.ObjectId(actor.pharmacyId) }).lean();
    if (!supplier) throw new AppError({ status: 404, code: 'SUPPLIER_NOT_FOUND', message: 'Supplier not found' });
    if (supplier.state !== 'active') throw new AppError({ status: 409, code: 'SUPPLIER_ARCHIVED', message: 'This supplier is archived' });
    if (!RETURNABLE.includes(batch.status)) {
      throw new AppError({ status: 409, code: 'BATCH_NOT_RETURNABLE', message: `A ${batch.status} batch cannot be returned` });
    }
    const q = input.quantity;
    if (!Number.isSafeInteger(q) || q < 1 || q > batch.availableQty) {
      throw new AppError({ status: 400, code: 'VALIDATION_ERROR', message: `Quantity must be between 1 and ${batch.availableQty} (unreserved units)` });
    }
    return inTransaction(async s => {
      // new:false → the pre-image of exactly the write that committed: status, cost and quantities for the audit.
      const pre = await InventoryItemModel.findOneAndUpdate(
        { _id: item._id, pharmacyId: actor.pharmacyId, availableQty: { $gte: q },
          batches: { $elemMatch: { _id: new Types.ObjectId(String(batchId)), status: { $in: RETURNABLE }, availableQty: { $gte: q } } } },
        { $inc: { availableQty: -q, 'batches.$.availableQty': -q } }, { new: false, session: s }).lean();
      if (!pre) throw changed();
      const was = pre.batches!.find(b => String((b as { _id?: unknown })._id) === String(batchId).toLowerCase())!;
      // Only an ACTIVE batch becomes 'depleted' at zero. A quarantined/recalled (or expired) batch keeps its status,
      // so receiving more of the same batch later cannot silently make an un-released held batch sellable.
      if (was.status === 'active' && was.availableQty - q === 0 && was.reservedQty === 0) {
        await InventoryItemModel.updateOne({ _id: item._id, batches: { $elemMatch: { _id: new Types.ObjectId(String(batchId)), status: 'active', availableQty: 0, reservedQty: 0 } } },
          { $set: { 'batches.$.status': 'depleted', 'batches.$.depletedAt': new Date() } }, { session: s });
      }
      const [record] = await SupplierReturnModel.create([{ pharmacyId: actor.pharmacyId, supplierId: String(input.supplierId).toLowerCase(),
        inventoryItemId: String(pre._id), medicineId: String(pre.medicineId), batchId: String(batchId).toLowerCase(), batchNumber: was.batchNumber,
        expiryDate: was.expiryDate, batchStatusAtReturn: was.status, quantity: q, unitCost: was.purchasePrice, reason: input.reason,
        ...(input.notes ? { notes: input.notes.trim() } : {}), createdBy: actor.actorId }], { session: s });
      await InventoryAdjustmentModel.create([{ pharmacyId: actor.pharmacyId, medicineId: pre.medicineId, inventoryItemId: pre._id,
        adjustmentType: 'remove', quantity: q, batchId: was._id, batchNumber: was.batchNumber, expiryDate: was.expiryDate,
        availableQtyBefore: was.availableQty, availableQtyAfter: was.availableQty - q, sourceType: 'manual', sourceId: String(record._id),
        reason: 'return', notes: `Returned to supplier ${supplier.displayName}`, adjustedBy: actor.actorId, adjustedByRole: 'pharmacy' }], { session: s });
      return record.toObject();
    });
  }

  async listSupplierReturns(actor: StaffActor, page = 1, limit = 20) {
    const p = Math.max(1, Math.floor(page)), l = Math.min(100, Math.max(1, Math.floor(limit)));
    const [data, total] = await Promise.all([
      SupplierReturnModel.find({ pharmacyId: actor.pharmacyId }).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l).lean(),
      SupplierReturnModel.countDocuments({ pharmacyId: actor.pharmacyId }),
    ]);
    return { data, total, page: p, totalPages: Math.ceil(total / l) };
  }

  /** Open orders of this pharmacy holding reserved units from the given (or all quarantined/recalled) batches. */
  async impactedOrders(actor: StaffActor, batchIds?: string[]) {
    let ids = batchIds;
    if (!ids) {
      const held = await InventoryItemModel.find({ pharmacyId: actor.pharmacyId, 'batches.status': { $in: ['quarantined', 'recalled'] } })
        .select('batches._id batches.status').lean();
      ids = held.flatMap(i => (i.batches ?? []).filter(b => ['quarantined', 'recalled'].includes(b.status)).map(b => String((b as { _id?: unknown })._id)));
    }
    if (!ids.length) return [];
    const objectIds = ids.map(id => new Types.ObjectId(id));
    const orders = await PharmacyOrderModel.find({ pharmacyId: actor.pharmacyId, status: { $in: OPEN_ORDER_STATUSES },
      'items.batchAllocations.batchId': { $in: objectIds } }).select('_id orderNumber status customerId items').limit(200).lean();
    const wanted = new Set(ids.map(i => i.toLowerCase()));
    return orders.map(o => ({ orderId: String(o._id), orderNumber: o.orderNumber, status: o.status,
      heldUnits: (o.items ?? []).flatMap(it => (it.batchAllocations ?? []).filter(a => wanted.has(String(a.batchId)))
        .map(a => ({ medicineId: String(it.medicineId), medicineName: it.medicineName, batchId: String(a.batchId), batchNumber: a.batchNumber, quantity: a.quantity }))) }));
  }

  private async batchView(itemId: string, batchId: string) {
    const item = await InventoryItemModel.findById(itemId).lean();
    return item?.batches?.find(b => String((b as { _id?: unknown })._id) === batchId.toLowerCase());
  }
}
