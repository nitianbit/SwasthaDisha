import { Service } from 'typedi';
import { ClientSession, startSession, Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { getTodayYyyymmdd } from '@/modules/common/utils/dateUtils';
import { InventoryAdjustmentModel, InventoryItemModel } from '@/modules/pharmacyInventory/model';
import { CustomerReturnModel, CustomerReturnDisposition, ICustomerReturn, ICustomerReturnLine } from '@/modules/pharmacyInventory/customerReturnModel';
import { rearmLowStock } from '@/modules/pharmacyInventory/sellable';
import PharmacyOrderModel from '@/modules/pharmacyOrders/model';
import { WalletModel } from '@/modules/wallet/model';
import { WalletRepository } from '@/modules/wallet/repository';
import type { StaffActor } from '@/modules/pharmacyInventory/batchQuality';

export interface CustomerReturnInput {
  requestKey: string;
  reason: string;
  lines: { medicineId: string; batchId: string; quantity: number; disposition: CustomerReturnDisposition }[];
  /** Staff-chosen wallet refund in rupees (0 or omitted = no refund). */
  refundAmount?: number;
}

const isId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-fA-F]{24}$/.test(v);
const orderNotFound = () => new AppError({ status: 404, code: 'ORDER_NOT_FOUND', message: 'Order not found' });
const changed = () => new AppError({ status: 409, code: 'ORDER_STATE_CHANGED', message: 'The order or its stock changed; reload and try again' });
const invalid = (message: string) => new AppError({ status: 400, code: 'VALIDATION_ERROR', message });
const isDuplicateRequest = (e: unknown) => (e as { code?: number })?.code === 11000 && /requestKey/.test(String((e as Error)?.message));

async function inTransaction<T>(work: (s: ClientSession) => Promise<T>): Promise<T> {
  const session = await startSession();
  try {
    let result: T | undefined;
    await session.withTransaction(async () => { result = await work(session); });
    return result as T;
  } finally { await session.endSession(); }
}

/**
 * Customer returns (P3b): staff record medicines a customer brought back from one of the pharmacy's completed orders.
 * Each line names the batch the units were dispensed from; staff choose per line to restock (back into that batch:
 * sellable only if the batch is still active, otherwise held stock, e.g. a recalled batch for return to supplier) or
 * discard. Staff decide the wallet refund (owner policy), capped by the value of the returned units and by what the
 * order has not refunded yet. Stock, the return record, the audit rows and the wallet credit commit in ONE transaction,
 * fenced on the order, so concurrent returns can never return more units than were dispensed or refund more than paid.
 */
@Service()
export class CustomerReturnService {
  constructor(private wallets: WalletRepository = new WalletRepository()) {}

  async record(actor: StaffActor, orderId: unknown, input: CustomerReturnInput): Promise<ICustomerReturn & { duplicate?: boolean }> {
    if (!isId(orderId) || !isId(actor.pharmacyId)) throw orderNotFound();
    const id = orderId.toLowerCase();
    const requestKey = input.requestKey?.trim();
    if (!requestKey) throw invalid('requestKey is required');
    const prior = await CustomerReturnModel.findOne({ pharmacyId: actor.pharmacyId, requestKey }).lean();
    if (prior) return this.replay(prior, id);

    const order = await PharmacyOrderModel.findOne({ _id: id, pharmacyId: actor.pharmacyId }).lean();
    if (!order) throw orderNotFound();
    if (order.status !== 'completed') throw new AppError({ status: 409, code: 'ORDER_NOT_COMPLETED', message: 'Only a completed order can take a return' });
    if (!input.lines?.length) throw invalid('At least one line is required');
    const refundPaise = Math.round(Number(input.refundAmount ?? 0) * 100);
    if (!Number.isSafeInteger(refundPaise) || refundPaise < 0 || Math.abs(Number(input.refundAmount ?? 0) * 100 - refundPaise) > 1e-6) {
      throw invalid('refundAmount must be a non-negative amount in rupees with at most 2 decimals');
    }
    const payer = order.customerId ? String(order.customerId) : undefined;
    if (refundPaise > 0) {
      if (!payer) throw new AppError({ status: 409, code: 'REFUND_NOT_AVAILABLE', message: 'This order has no customer account to refund' });
      if (order.paymentStatus !== 'paid') throw new AppError({ status: 409, code: 'REFUND_NOT_AVAILABLE', message: 'Only a paid order can be refunded' });
      await WalletModel.updateOne({ userId: payer }, { $setOnInsert: { userId: payer, balance: 0, isActive: true } }, { upsert: true });
    }

    const returnId = new Types.ObjectId();
    try {
      const outcome = await inTransaction<{ record: ICustomerReturn; replayed: boolean }>(async s => {
        // Same key already committed (checked again on EVERY attempt, in this transaction's snapshot): a concurrent
        // twin that won must be answered with its receipt, not judged against the units it already took back.
        const seen = await CustomerReturnModel.findOne({ pharmacyId: actor.pharmacyId, requestKey }).session(s).lean();
        if (seen) return { record: seen as ICustomerReturn, replayed: true };
        // Write the order FIRST: every concurrent return (or other order write) now conflicts with this transaction,
        // so the checks below see all committed returns and refunds of the order.
        const fresh = await PharmacyOrderModel.findOneAndUpdate({ _id: id, pharmacyId: actor.pharmacyId, status: 'completed' },
          { $inc: { 'customerReturns.count': 1, 'customerReturns.refundedPaise': refundPaise }, $set: { 'customerReturns.lastReturnAt': new Date() } },
          { new: true, session: s }).lean();
        if (!fresh) throw changed();

        // Units dispensed per medicine+batch on this order, minus what earlier returns took back.
        const dispensed = new Map<string, { qty: number; valuePaise: number; name?: string; batchNumber: string; expiryDate: string }>();
        for (const it of (fresh.items ?? []).filter(i => i.itemStatus === 'active')) {
          const linePaise = Number.isSafeInteger(it.lineTotalPaise) ? Number(it.lineTotalPaise) : Math.round(Number(it.lineTotal || 0) * 100);
          const units = (it.batchAllocations ?? []).reduce((n, a) => n + a.quantity, 0);
          for (const a of it.batchAllocations ?? []) {
            const key = `${String(it.medicineId)}:${String(a.batchId)}`;
            const cur = dispensed.get(key) ?? { qty: 0, valuePaise: 0, name: it.medicineName, batchNumber: a.batchNumber, expiryDate: a.expiryDate };
            cur.qty += a.quantity;
            cur.valuePaise += units ? Math.floor(linePaise * a.quantity / units) : 0;
            dispensed.set(key, cur);
          }
        }
        const returned = new Map<string, number>();
        for (const r of await CustomerReturnModel.find({ orderId: id }).session(s).lean()) {
          for (const l of r.lines) returned.set(`${l.medicineId}:${l.batchId}`, (returned.get(`${l.medicineId}:${l.batchId}`) ?? 0) + l.quantity);
        }

        const lines: ICustomerReturnLine[] = [];
        for (const [index, line] of input.lines.entries()) {
          if (!isId(line.medicineId) || !isId(line.batchId)) throw invalid(`Line ${index + 1}: unknown medicine or batch`);
          if (!Number.isSafeInteger(line.quantity) || line.quantity < 1) throw invalid(`Line ${index + 1}: quantity must be a positive whole number`);
          if (line.disposition !== 'restock' && line.disposition !== 'discard') throw invalid(`Line ${index + 1}: disposition must be restock or discard`);
          const medicineId = line.medicineId.toLowerCase(), batchId = line.batchId.toLowerCase();
          const key = `${medicineId}:${batchId}`;
          const sold = dispensed.get(key);
          if (!sold) throw invalid(`Line ${index + 1}: this batch was not dispensed on this order`);
          const already = returned.get(key) ?? 0;
          if (already + line.quantity > sold.qty) {
            throw new AppError({ status: 409, code: 'RETURN_EXCEEDS_DISPENSED',
              message: `Line ${index + 1}: only ${sold.qty - already} unit(s) of batch ${sold.batchNumber} can still be returned` });
          }
          returned.set(key, already + line.quantity);
          const valuePaise = Math.floor(sold.valuePaise * line.quantity / sold.qty);

          let batchStatusAtReturn: string | undefined;
          if (line.disposition === 'restock') {
            // Into the same batch; pre-image = the exact state this write changed (audit + status decision).
            const pre = await InventoryItemModel.findOneAndUpdate(
              { pharmacyId: actor.pharmacyId, medicineId, 'batches._id': new Types.ObjectId(batchId) },
              { $inc: { availableQty: line.quantity, 'batches.$.availableQty': line.quantity } }, { new: false, session: s }).lean();
            if (!pre) throw new AppError({ status: 409, code: 'BATCH_NOT_FOUND', message: `Line ${index + 1}: the batch is no longer in inventory; record it as discarded` });
            const was = pre.batches!.find(b => String((b as { _id?: unknown })._id) === batchId)!;
            batchStatusAtReturn = was.status;
            if (was.status === 'depleted') {
              // Sold-out batch takes units back: sellable again unless past its date. Held batches keep their status.
              const next = was.expiryDate < getTodayYyyymmdd() ? 'expired' : 'active';
              const r = await InventoryItemModel.updateOne({ _id: pre._id, batches: { $elemMatch: { _id: new Types.ObjectId(batchId), status: 'depleted' } } },
                { $set: { 'batches.$.status': next }, $unset: { 'batches.$.depletedAt': '' } }, { session: s });
              if (r.modifiedCount !== 1) throw changed();
            }
            await InventoryAdjustmentModel.create([{ pharmacyId: actor.pharmacyId, medicineId, inventoryItemId: pre._id, adjustmentType: 'add',
              quantity: line.quantity, batchId: was._id, batchNumber: was.batchNumber, expiryDate: was.expiryDate, availableQtyBefore: was.availableQty,
              availableQtyAfter: was.availableQty + line.quantity, sourceType: 'order', sourceId: `customer_return:${returnId.toHexString()}`,
              sourceRowIndex: index, reason: 'return', notes: `Customer return on order ${fresh.orderNumber ?? id}`,
              adjustedBy: actor.actorId, adjustedByRole: 'pharmacy' }], { session: s });
            await rearmLowStock(actor.pharmacyId, medicineId, s);
          } else {
            const inv = await InventoryItemModel.findOne({ pharmacyId: actor.pharmacyId, medicineId }).select('batches._id batches.status').session(s).lean();
            batchStatusAtReturn = inv?.batches?.find(b => String((b as { _id?: unknown })._id) === batchId)?.status;
          }
          lines.push({ medicineId, ...(sold.name ? { medicineName: sold.name } : {}), batchId, batchNumber: sold.batchNumber, expiryDate: sold.expiryDate,
            quantity: line.quantity, disposition: line.disposition, ...(batchStatusAtReturn ? { batchStatusAtReturn } : {}), valuePaise });
        }

        const returnValuePaise = lines.reduce((n, l) => n + l.valuePaise, 0);
        if (refundPaise > returnValuePaise) {
          throw new AppError({ status: 409, code: 'REFUND_EXCEEDS_RETURN_VALUE', message: `The refund cannot exceed ₹${(returnValuePaise / 100).toFixed(2)} for these units` });
        }
        const paidPaise = Number.isSafeInteger(fresh.grandTotalPaise) ? Number(fresh.grandTotalPaise) : Math.round(Number(fresh.grandTotal || 0) * 100);
        if (refundPaise > 0 && (fresh.paymentStatus !== 'paid' || fresh.customerReturns!.refundedPaise > paidPaise)) {
          throw new AppError({ status: 409, code: 'REFUND_EXCEEDS_PAID', message: 'This would refund more than was paid for the order' });
        }

        let walletTransactionId: string | undefined;
        if (refundPaise > 0) {
          const wallet = await WalletModel.findOne({ userId: payer }).session(s).lean();
          if (!wallet?.isActive) throw new AppError({ status: 409, code: 'WALLET_INACTIVE', message: 'Customer wallet is not active' });
          const posted = await this.wallets.postEntry({ userId: payer!, walletId: wallet._id, transactionType: 'refund', amount: refundPaise / 100,
            referenceType: 'pharmacy_customer_return', referenceId: returnId.toHexString(), operationKey: `pharmacy_customer_return:${returnId.toHexString()}`,
            description: `Refund for medicines returned (order ${fresh.orderNumber ?? id})`, transactionDate: getTodayYyyymmdd() }, s);
          if (!posted) throw new AppError({ status: 500, code: 'WALLET_CREDIT_FAILED', message: 'Wallet could not be credited' });
          walletTransactionId = String(posted.transaction._id);
        }
        const [record] = await CustomerReturnModel.create([{ _id: returnId, pharmacyId: actor.pharmacyId, orderId: id, orderNumber: fresh.orderNumber,
          ...(payer ? { customerId: payer } : {}), requestKey, lines, reason: input.reason.trim(), returnValuePaise, refundPaise,
          ...(walletTransactionId ? { walletTransactionId } : {}), createdBy: actor.actorId }], { session: s });
        return { record: record.toObject() as ICustomerReturn, replayed: false };
      });
      return outcome.replayed ? this.replay(outcome.record, id) : outcome.record;
    } catch (error) {
      if (isDuplicateRequest(error)) {
        const existing = await CustomerReturnModel.findOne({ pharmacyId: actor.pharmacyId, requestKey }).lean();
        if (existing) return this.replay(existing, id);
      }
      throw error;
    }
  }

  /** The same requestKey is the same return: answer with the first record (only for the same order). */
  private replay(existing: ICustomerReturn, orderId: string) {
    if (existing.orderId !== orderId) {
      throw new AppError({ status: 409, code: 'REQUEST_KEY_REUSED', message: 'This request key was already used for another order' });
    }
    return { ...existing, duplicate: true };
  }

  async list(actor: StaffActor, query: { orderId?: string; page?: number; limit?: number } = {}) {
    const p = Math.max(1, Math.floor(query.page ?? 1)), l = Math.min(100, Math.max(1, Math.floor(query.limit ?? 20)));
    const filter = { pharmacyId: actor.pharmacyId, ...(isId(query.orderId) ? { orderId: query.orderId.toLowerCase() } : {}) };
    const [data, total] = await Promise.all([
      CustomerReturnModel.find(filter).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l).lean(),
      CustomerReturnModel.countDocuments(filter),
    ]);
    return { data, total, page: p, totalPages: Math.ceil(total / l) };
  }
}
