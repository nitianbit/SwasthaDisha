import { Service } from 'typedi';
import { ClientSession, startSession, Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { InventoryAdjustmentModel, InventoryItemModel } from '@/modules/pharmacyInventory/model';
import { SupplierReturnModel, ISupplierReturn } from '@/modules/pharmacyInventory/model/supplierReturn';
import { rearmLowStock, todayYyyymmdd } from '@/modules/pharmacyInventory/sellable';
import PharmacySupplierModel from '@/modules/pharmacySuppliers/model';
import PharmacyOrderModel from '@/modules/pharmacyOrders/model';
import { CustomerReturnModel } from '@/modules/pharmacyInventory/model/customerReturn';

export interface StaffActor { pharmacyId: string; actorId: string }
const OPEN_ORDER_STATUSES = ['placed', 'accepted', 'packed', 'ready_for_pickup', 'out_for_delivery', 'delivery_failed'];
const RETURNABLE = ['active', 'expired', 'quarantined', 'recalled'];
/** A recall applies to every unit of the batch, including units already sold (depleted batch). */
const RECALLABLE = ['active', 'expired', 'quarantined', 'depleted'];
/** Orders whose held units can still be swapped to another batch (not yet handed over or on the road). */
const REALLOCATABLE_ORDER_STATUSES = ['placed', 'accepted', 'packed', 'ready_for_pickup', 'delivery_failed'];
const TRACE_LIMIT = 1000;

const notFound = () => new AppError({ status: 404, code: 'BATCH_NOT_FOUND', message: 'Inventory batch not found' });
const changed = () => new AppError({ status: 409, code: 'BATCH_STATE_CHANGED', message: 'The batch changed; reload and try again' });
const orderNotFound = () => new AppError({ status: 404, code: 'ORDER_NOT_FOUND', message: 'Order not found' });
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

  /**
   * Recalls a batch (manufacturer/regulator notice). Permanent: a recalled batch is never released back to sale; its
   * unreserved units can only leave by return to supplier. Orders holding its units are NOT changed automatically:
   * they appear in the held-batch worklist for staff to swap (reallocateHeldUnits) or cancel with refund.
   * Returns those open orders and every completed order (customer) the batch was dispensed to.
   */
  async recall(actor: StaffActor, itemId: unknown, batchId: unknown, input: { reason: string; reference?: string }) {
    const { item, batch } = await this.loadBatch(actor, itemId, batchId);
    if (batch.status === 'recalled') throw new AppError({ status: 409, code: 'BATCH_ALREADY_RECALLED', message: 'This batch is already recalled' });
    if (!RECALLABLE.includes(batch.status)) {
      throw new AppError({ status: 409, code: 'BATCH_NOT_RECALLABLE', message: `A ${batch.status} batch cannot be recalled` });
    }
    const reference = input.reference?.trim();
    // Fenced on the status (and any quarantine hold) that was read; a quarantine becomes the recall (new hold id).
    const r = await InventoryItemModel.updateOne(
      { _id: item._id, pharmacyId: actor.pharmacyId, batches: { $elemMatch: { _id: new Types.ObjectId(String(batchId)), status: batch.status,
        holdId: batch.holdId ?? { $exists: false } } } },
      { $set: { 'batches.$.status': 'recalled', 'batches.$.holdId': new Types.ObjectId().toHexString(), 'batches.$.holdReason': input.reason.trim(),
        'batches.$.heldAt': new Date(), 'batches.$.heldBy': actor.actorId, ...(reference ? { 'batches.$.recallReference': reference } : {}) },
        ...(reference ? {} : { $unset: { 'batches.$.recallReference': '' } }) });
    if (r.modifiedCount !== 1) throw changed();
    const trace = await this.recallTrace(actor, itemId, batchId);
    return { batch: trace.batch, impactedOrders: trace.openOrders, dispensedTo: trace.dispensedTo, dispensedTruncated: trace.dispensedTruncated };
  }

  /**
   * Where a batch went: open orders still holding its units, and completed orders (customers) it was dispensed to,
   * with the units each customer has already brought back.
   */
  async recallTrace(actor: StaffActor, itemId: unknown, batchId: unknown) {
    const { item, batch } = await this.loadBatch(actor, itemId, batchId);
    const id = String(batchId).toLowerCase();
    const completed = await PharmacyOrderModel.find({ pharmacyId: actor.pharmacyId, status: 'completed',
      'items.batchAllocations.batchId': new Types.ObjectId(id) })
      .select('_id orderNumber customerId items updatedAt').sort({ updatedAt: -1 }).limit(TRACE_LIMIT + 1).lean();
    const orderIds = completed.slice(0, TRACE_LIMIT).map(o => String(o._id));
    const returns = orderIds.length ? await CustomerReturnModel.find({ pharmacyId: actor.pharmacyId, orderId: { $in: orderIds }, 'lines.batchId': id })
      .select('orderId lines').lean() : [];
    const returned = new Map<string, number>();
    for (const r of returns) for (const l of r.lines) if (l.batchId === id) returned.set(r.orderId, (returned.get(r.orderId) ?? 0) + l.quantity);
    const dispensedTo = completed.slice(0, TRACE_LIMIT).map(o => ({
      orderId: String(o._id), orderNumber: o.orderNumber, customerId: o.customerId ? String(o.customerId) : undefined, completedAt: o.updatedAt,
      quantity: (o.items ?? []).filter(it => it.itemStatus === 'active' && String(it.medicineId) === String(item.medicineId))
        .flatMap(it => it.batchAllocations ?? []).filter(a => String(a.batchId) === id).reduce((n, a) => n + a.quantity, 0),
      returnedQty: returned.get(String(o._id)) ?? 0,
    }));
    return { batch: await this.batchView(String(item._id), id) ?? batch, openOrders: await this.impactedOrders(actor, [id]),
      dispensedTo, dispensedTruncated: completed.length > TRACE_LIMIT };
  }

  /**
   * Swap: moves an open order's units off quarantined/recalled/expired batches onto sellable batches of the same
   * medicine (earliest expiry first), in one transaction with the order. The held batches get their units back as
   * held (unsellable) stock. Fails as a whole if there is not enough sellable stock: staff then cancel the order.
   */
  async reallocateHeldUnits(actor: StaffActor, orderId: unknown) {
    if (!isId(orderId) || !isId(actor.pharmacyId)) throw orderNotFound();
    return inTransaction(async s => {
      const order = await PharmacyOrderModel.findOne({ _id: orderId, pharmacyId: actor.pharmacyId }).session(s).lean();
      if (!order) throw orderNotFound();
      if (!REALLOCATABLE_ORDER_STATUSES.includes(order.status)) {
        throw new AppError({ status: 409, code: 'ORDER_NOT_REALLOCATABLE', message: `Stock cannot be swapped on an order that is ${order.status}` });
      }
      const today = todayYyyymmdd();
      const items = (order.items ?? []).map(it => ({ ...it, batchAllocations: (it.batchAllocations ?? []).map(a => ({ ...a })) }));
      const moves: { medicineId: string; quantity: number; from: { batchId: string; quantity: number }[]; to: { batchId: string; quantity: number }[] }[] = [];
      for (const it of items) {
        if (it.itemStatus !== 'active' || !it.batchAllocations.length) continue;
        const doc = await InventoryItemModel.findOne({ pharmacyId: actor.pharmacyId, medicineId: it.medicineId }).session(s);
        if (!doc) throw changed();
        const byId = (bid: unknown) => (doc.batches ?? []).find(b => String((b as { _id?: unknown })._id) === String(bid));
        const sellable = (b: { status: string; expiryDate: string }) => b.status === 'active' && b.expiryDate >= today;
        const keep: typeof it.batchAllocations = [];
        const from: { batchId: string; quantity: number }[] = [];
        for (const a of it.batchAllocations) {
          const b = byId(a.batchId);
          if (!b || b.reservedQty < a.quantity) throw changed();
          if (sellable(b)) { keep.push(a); continue; }
          b.reservedQty -= a.quantity; // back to the held batch as unsellable stock (status unchanged)
          b.availableQty += a.quantity;
          from.push({ batchId: String(a.batchId), quantity: a.quantity });
        }
        const need = from.reduce((n, f) => n + f.quantity, 0);
        if (!need) continue;
        const heldIds = new Set(from.map(f => f.batchId));
        const eligible = (doc.batches ?? []).filter(b => sellable(b) && b.availableQty > 0 && !heldIds.has(String((b as { _id?: unknown })._id)))
          .sort((a, b) => a.expiryDate.localeCompare(b.expiryDate) || a.receivedAt.getTime() - b.receivedAt.getTime()
            || String((a as { _id?: unknown })._id).localeCompare(String((b as { _id?: unknown })._id)));
        if (eligible.reduce((n, b) => n + b.availableQty, 0) < need) {
          throw new AppError({ status: 409, code: 'INSUFFICIENT_SELLABLE_STOCK',
            message: `Not enough sellable stock of ${it.medicineName ?? 'this medicine'} to swap ${need} unit(s); cancel the order instead` });
        }
        let remaining = need;
        const to: { batchId: string; quantity: number }[] = [];
        for (const b of eligible) {
          if (!remaining) break;
          const q = Math.min(remaining, b.availableQty);
          b.availableQty -= q;
          b.reservedQty += q;
          remaining -= q;
          const bid = String((b as { _id?: unknown })._id);
          to.push({ batchId: bid, quantity: q });
          const existing = keep.find(k => String(k.batchId) === bid);
          if (existing) existing.quantity += q;
          else keep.push({ batchId: bid, batchNumber: b.batchNumber, expiryDate: b.expiryDate, quantity: q });
        }
        // Item totals are unchanged: `need` units moved reserved -> available on held batches and back on sellable ones.
        doc.markModified('batches');
        await doc.save({ session: s });
        it.batchAllocations = keep;
        moves.push({ medicineId: String(it.medicineId), quantity: need, from, to });
      }
      if (!moves.length) throw new AppError({ status: 409, code: 'NOTHING_TO_REALLOCATE', message: 'This order holds no units from held batches' });
      const updated = await PharmacyOrderModel.findOneAndUpdate({ _id: orderId, pharmacyId: actor.pharmacyId, status: order.status },
        { $set: { items }, $push: { batchReallocations: { at: new Date(), byActorId: actor.actorId, moves } } }, { new: true, session: s }).lean();
      if (!updated) throw changed();
      return { order: updated, moves };
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
