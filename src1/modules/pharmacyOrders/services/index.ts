import { Service } from 'typedi';
import PaymentRecordModel from '@/modules/payment/model';
import { advanceRefillOnPayment } from '@/modules/pharmacySubscriptions/refillCycle';
import { ClientSession, startSession, Types } from 'mongoose';
import { PharmacyOrderRepository } from '@/modules/pharmacyOrders/repository';
import { PharmacyCustomerService } from '@/modules/pharmacyCustomers/services';
import { InventoryService } from '@/modules/pharmacyInventory/services';
import { PaymentService } from '@/modules/payment/services';
import { BookingRepository } from '@/modules/bookings/repository';
import { ExternalBookingRepository } from '@/modules/externalBookings/repository';
import { PharmacyOrderSideEffectService } from '@/modules/pharmacyOrders/services/sideEffects';
import { MedicineRepository } from '@/modules/pharmacyMedicines/repository';
import {
  IPharmacyOrder,
  PharmacyRecoveryReceipt,
  PharmacyRecoveryWorklistPage,
  IOrderItem,
  CreateOrderRequest,
  MarkOrderPaidRequest,
  UpdateOrderRequest,
  UpdateOrderStatusRequest,
  OrderQueryParams,
  OrderStatus,
  PrescriptionReview,
  PrescriptionReviewRequest,
  DeliveryExceptionRecord,
  DeliveryExceptionType,
} from '@/modules/pharmacyOrders/types';
import { AppError } from '@/modules/common/types';
import { assertPrescriptionCommerceAvailable } from '@/modules/pharmacyOrders/prescriptionCommerce';
import { createHash } from 'node:crypto';
import { PrescriptionRefundService } from '@/modules/pharmacyOrders/prescriptionRefund';

/** Fingerprint of the exact ordered document list a pharmacist reviewed (bounded evidence, any list size). */
export function prescriptionDocumentSetSha256(urls: readonly string[]): string {
  return createHash('sha256').update(JSON.stringify(urls)).digest('hex');
}
import logger from '@/services/logger';
import PharmacyModel from '@/modules/pharmacies/model';
import { claimRequestKey, scopeOf } from '@/modules/requestKeys';
import { RequestKeyModel } from '@/modules/requestKeys/model';
import PharmacyOrderModel from '@/modules/pharmacyOrders/model';
import { assertUniqueIndex } from '@/modules/common/utils/requiredIndex';
import { requestHashOf } from '@/modules/common/utils/canonicalJson';
import { assertRxOrderRequest, bindRxOrderFile, prepareRxOrder, type RxOrderTerms } from '@/modules/assisted/rxOrder';
import { AssistedAuditEventModel } from '@/modules/assisted/model';
import { InventoryItemModel } from '@/modules/pharmacyInventory/model';
import { istTodayYyyymmdd } from '@/modules/pharmacyInventory/businessDate';

const TERMINAL_STATUSES: OrderStatus[] = ['completed', 'abandoned', 'cancelled', 'rejected'];
/** The only order states a prescription review accepts; the review queue lists exactly these (W1). */
export const PRESCRIPTION_REVIEWABLE_STATUSES: readonly OrderStatus[] = ['placed', 'accepted'];
const PRESCRIPTION_GATED_STATUSES: OrderStatus[] = [
  'packed',
  'ready_for_pickup',
  'out_for_delivery',
  'completed',
];
const UNPAID_ORDER_ABANDON_WINDOW_MS = 35 * 60 * 1000;
/** D3: statuses from which an order can be cancelled (later ones go through delivery exceptions). */
const CANCELLABLE_STATUSES: OrderStatus[] = ['placed', 'accepted', 'packed'];
export interface CancelActor { userType: 'user' | 'pharmacy' | 'admin'; _id: string; pharmacyId?: string }
const ALLOWED_STATUS_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  placed: ['accepted', 'rejected', 'cancelled', 'abandoned'],
  accepted: ['packed', 'cancelled'],
  packed: ['ready_for_pickup', 'out_for_delivery', 'cancelled'],
  ready_for_pickup: ['completed'],
  out_for_delivery: ['completed'],
  // Only through recordDeliveryException (reasons + stock/refund handling), never the generic status update.
  delivery_failed: [],
  completed: [],
  abandoned: [],
  cancelled: [],
  rejected: [],
  // Only through the cancellation-request decisions (D3), never the generic status update.
  pending_cancel: [],
};

type PricedOrderItem = CreateOrderRequest['items'][number] & {
  unitPrice: number;
  medicineName: string;
  hsnCode?: string;
  gstPercent: number;
  prescriptionRequired: boolean | undefined;
};
/** P9: a priced line whose Rx flag the commerce guard confirmed is an explicit boolean. */
type NonPrescriptionOrderItem = PricedOrderItem & { prescriptionRequired: boolean };

function computeTotals(items: NonPrescriptionOrderItem[]) {
  let subtotalPaise = 0;
  let discountTotalPaise = 0;
  let taxTotalPaise = 0;
  const computed = items.map((item) => {
    const unitPricePaise = Math.round(item.unitPrice * 100);
    const lineSubtotalPaise = unitPricePaise * item.orderedQty;
    const discountPaise = Math.round((item.discount ?? 0) * 100);
    if (discountPaise > lineSubtotalPaise) {
      throw new AppError({
        status: 400,
        code: 'INVALID_ITEM_DISCOUNT',
        message: `Discount cannot exceed subtotal for medicine ${item.medicineId}`,
      });
    }
    const lineTotalPaise = lineSubtotalPaise - discountPaise;
    // Inventory prices are treated as GST-inclusive to preserve current payable totals.
    const taxPaise = item.gstPercent > 0
      ? Math.round((lineTotalPaise * item.gstPercent) / (100 + item.gstPercent))
      : 0;
    subtotalPaise += lineSubtotalPaise;
    discountTotalPaise += discountPaise;
    taxTotalPaise += taxPaise;
    return {
      medicineId: item.medicineId,
      medicineName: item.medicineName,
      orderedQty: item.orderedQty,
      reservedQty: item.orderedQty,
      billedQty: 0,
      freeQty: item.freeQty ?? 0,
      unitPrice: item.unitPrice,
      discount: discountPaise / 100,
      lineTotal: lineTotalPaise / 100,
      hsnCode: item.hsnCode,
      gstPercent: item.gstPercent,
      taxAmount: taxPaise / 100,
      unitPricePaise,
      discountPaise,
      taxPaise,
      lineTotalPaise,
      prescriptionRequired: item.prescriptionRequired,
      recurring: item.recurring ?? false,
      subscriptionFrequency: item.subscriptionFrequency,
      subscriptionIntervalDays: item.subscriptionIntervalDays,
      subscriptionNextRefillDate: item.subscriptionNextRefillDate,
      subscriptionReminderChannel: item.subscriptionReminderChannel,
      itemStatus: 'active' as const,
    };
  });
  const grandTotalPaise = subtotalPaise - discountTotalPaise;
  return {
    items: computed,
    subtotal: subtotalPaise / 100,
    discountTotal: discountTotalPaise / 100,
    taxTotal: taxTotalPaise / 100,
    grandTotal: grandTotalPaise / 100,
    subtotalPaise,
    discountTotalPaise,
    taxTotalPaise,
    grandTotalPaise,
  };
}

/** P8: Razorpay Checkout details for an unpaid pharmacy order (amount in rupees). */
export interface PharmacyPaymentDetails {
  paymentTransactionId: string; razorpayOrderId: string; razorpayKeyId: string; amount: number; currency: string;
  baseAmount: number; discountAmount: number;
}

@Service()
export class PharmacyOrderService {
  constructor(
    private orderRepo: PharmacyOrderRepository,
    private customerService: PharmacyCustomerService,
    private inventoryService: InventoryService,
    private paymentService: PaymentService,
    private bookingRepository: BookingRepository,
    private externalBookingRepository: ExternalBookingRepository,
    private sideEffectService: PharmacyOrderSideEffectService,
    private medicineRepository: MedicineRepository,
    private prescriptionRefundService: PrescriptionRefundService
  ) {}

  private buildInventoryItems(items: Array<{ medicineId: string; orderedQty: number }>) {
    return items.map((item) => ({
      medicineId: String(item.medicineId),
      quantity: item.orderedQty,
    }));
  }

  private buildInventoryDelta(
    previousItems: Array<{ medicineId: unknown; orderedQty: number; itemStatus?: string }>,
    nextItems: Array<{ medicineId: unknown; orderedQty: number; itemStatus?: string }>
  ): {
    toConsume: Array<{ medicineId: string; quantity: number }>;
    toReturn: Array<{ medicineId: string; quantity: number }>;
  } {
    const previousMap = new Map<string, number>();
    const nextMap = new Map<string, number>();

    for (const item of previousItems) {
      if (item.itemStatus && item.itemStatus !== 'active') {
        continue;
      }
      const medicineId = String(item.medicineId);
      previousMap.set(medicineId, (previousMap.get(medicineId) || 0) + item.orderedQty);
    }

    for (const item of nextItems) {
      if (item.itemStatus && item.itemStatus !== 'active') {
        continue;
      }
      const medicineId = String(item.medicineId);
      nextMap.set(medicineId, (nextMap.get(medicineId) || 0) + item.orderedQty);
    }

    const medicineIds = new Set([...previousMap.keys(), ...nextMap.keys()]);
    const toConsume: Array<{ medicineId: string; quantity: number }> = [];
    const toReturn: Array<{ medicineId: string; quantity: number }> = [];

    for (const medicineId of medicineIds) {
      const previousQty = previousMap.get(medicineId) || 0;
      const nextQty = nextMap.get(medicineId) || 0;

      if (nextQty > previousQty) {
        toConsume.push({ medicineId, quantity: nextQty - previousQty });
      } else if (previousQty > nextQty) {
        toReturn.push({ medicineId, quantity: previousQty - nextQty });
      }
    }

    return { toConsume, toReturn };
  }

  private async applyInventoryDelta(
    pharmacyId: string,
    delta: {
      toConsume: Array<{ medicineId: string; quantity: number }>;
      toReturn: Array<{ medicineId: string; quantity: number }>;
    },
    session?: ClientSession
  ): Promise<void> {
    if (delta.toConsume.length) {
      await this.inventoryService.consumeAvailableStockBulk(pharmacyId, delta.toConsume, session);
    }

    if (delta.toReturn.length) {
      try {
        await this.inventoryService.returnStockBulk(pharmacyId, delta.toReturn, session);
      } catch (error) {
        if (delta.toConsume.length) {
          await this.inventoryService.returnStockBulk(pharmacyId, delta.toConsume, session).catch(() => undefined);
        }
        throw error;
      }
    }
  }

  /**
   * Allocation note (P3b): an order's batchAllocations can change while its status stays the same (staff swap units
   * off a recalled/quarantined batch). Callers must pass the items of the order as read or written INSIDE the same
   * transaction (e.g. the document returned by the fenced order update), never a copy read before it: the order
   * write then conflicts with any concurrent swap, so released/consumed allocations are always the current ones.
   */
  private async releaseOrderInventory(
    pharmacyId: string,
    items: IOrderItem[],
    session: ClientSession
  ): Promise<void> {
    const batchItems = items
      .filter((item) => item.itemStatus === 'active' && item.batchAllocations?.length)
      .map((item) => ({
        medicineId: String(item.medicineId),
        batchAllocations: item.batchAllocations,
      }));
    if (batchItems.length) {
      await this.inventoryService.releaseOrderStockBulk(pharmacyId, batchItems, session);
    }

    const legacyItems = items
      .filter((item) => item.itemStatus === 'active' && !item.batchAllocations?.length)
      .map((item) => ({ medicineId: String(item.medicineId), quantity: item.orderedQty }));
    if (legacyItems.length) {
      await this.inventoryService.returnStockBulk(pharmacyId, legacyItems, session);
    }
  }

  private async consumeOrderInventory(
    pharmacyId: string,
    items: IOrderItem[],
    session: ClientSession
  ): Promise<void> {
    const batchItems = items
      .filter((item) => item.itemStatus === 'active' && item.batchAllocations?.length)
      .map((item) => ({
        medicineId: String(item.medicineId),
        batchAllocations: item.batchAllocations,
      }));
    if (batchItems.length) {
      await this.inventoryService.consumeOrderReservedStockBulk(pharmacyId, batchItems, session);
    }
  }

  private async runOrderInventoryTransaction<T>(work: (session: ClientSession) => Promise<T>): Promise<T> {
    const session = await startSession();
    try {
      let result: T | undefined;
      await session.withTransaction(async () => {
        result = await work(session);
      });

      if (result === undefined) {
        throw new AppError({
          status: 500,
          code: 'ORDER_INVENTORY_TRANSACTION_FAILED',
          message: 'Failed to complete order and inventory update',
        });
      }

      return result;
    } finally {
      await session.endSession();
    }
  }

  // Compensation for payment-setup failures after the order/stock transaction
  // committed: keep the order visible as abandoned and return its stock in one
  // transaction. Best-effort — if this also fails, the stale-unpaid-order
  // sweep (abandonStaleUnpaidOrders) picks the order up later.
  private async abandonOrderAfterPaymentSetupFailure(
    pharmacyId: string,
    order: IPharmacyOrder,
    _inventoryItems: Array<{ medicineId: string; quantity: number }>
  ): Promise<void> {
    const failureNote = 'Payment setup failed; order was abandoned and stock returned automatically';
    const priorNotes = order.notes?.trim();

    await this.runOrderInventoryTransaction(async (session) => {
      const updated = await this.orderRepo.update(
        // Only an order still without any payment link: a refill resume may have linked a valid checkout meanwhile.
        { _id: order._id, status: 'placed', $or: [{ paymentTransactionId: { $exists: false } }, { paymentTransactionId: null }] } as never,
        {
          status: 'abandoned',
          paymentStatus: 'failed',
          notes: priorNotes ? `${priorNotes}\n${failureNote}` : failureNote,
        },
        { new: true, session }
      );

      if (updated && order.items.length) {
        await this.releaseOrderInventory(pharmacyId, updated.items, session);
      }

      return updated ?? order;
    }).catch(() => undefined);
  }

  private hasRecurringItems(
    items: Array<{
      recurring?: boolean;
    }>
  ): boolean {
    return items.some((item) => item.recurring);
  }

  private generateOrderNumber(): string {
    const now = new Date();
    const datePart = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(
      now.getDate()
    ).padStart(2, '0')}`;
    const randomPart = Math.random().toString(36).slice(2, 8).toUpperCase();
    return `PO-${datePart}-${randomPart}`;
  }

  private resolvePaymentPayer(data: {
    customerId?: string;
    buyerPharmacyId?: string;
    createdById: string;
  }): { payerUserId: string; payerPharmacyId?: string } {
    if (data.customerId) {
      return {
        payerUserId: data.customerId,
      };
    }

    return {
      payerUserId: data.createdById,
      payerPharmacyId: data.buyerPharmacyId,
    };
  }

  private validateOrderParty(data: CreateOrderRequest): void {
    const hasCustomer = Boolean(data.customerId);
    const hasBuyerPharmacy = Boolean(data.buyerPharmacyId);

    if (!hasCustomer && !hasBuyerPharmacy) {
      throw new AppError({
        status: 400,
        code: 'ORDER_PARTY_REQUIRED',
        message: 'Either customerId or buyerPharmacyId is required',
      });
    }

    if (hasCustomer && hasBuyerPharmacy) {
      throw new AppError({
        status: 400,
        code: 'MULTIPLE_ORDER_PARTIES_NOT_ALLOWED',
        message: 'Provide either customerId or buyerPharmacyId, not both',
      });
    }
  }

  private ensureLinkedOrderAllowed(data: {
    customerId?: string;
    buyerPharmacyId?: string;
    linkedConsultationId?: string;
    linkedDiagnosticOrderId?: string;
  }): void {
    if (data.buyerPharmacyId && (data.linkedConsultationId || data.linkedDiagnosticOrderId)) {
      throw new AppError({
        status: 400,
        code: 'LINKED_ORDER_REQUIRES_USER',
        message: 'Consultation or diagnostic linked orders require customerId, not buyerPharmacyId',
      });
    }
  }

  private async validateLinkedReferences(
    customerId: string | undefined,
    data: Pick<CreateOrderRequest, 'linkedConsultationId' | 'linkedDiagnosticOrderId'>
  ): Promise<void> {
    if (data.linkedConsultationId) {
      const consultation = await this.bookingRepository.findById(data.linkedConsultationId);
      // S3: missing and someone else's look the same (404), so the lookup reveals nothing about other customers.
      if (!consultation || consultation.bookingType !== 'consultation' ||
          (customerId && String(consultation.userId) !== String(customerId))) {
        throw new AppError({
          status: 404,
          code: 'CONSULTATION_NOT_FOUND',
          message: 'Consultation booking not found',
        });
      }
    }

    if (data.linkedDiagnosticOrderId) {
      const diagnosticBooking = await this.externalBookingRepository.findById(data.linkedDiagnosticOrderId);
      if (!diagnosticBooking || diagnosticBooking.appointmentType !== 'diagnostics' ||
          (customerId && String(diagnosticBooking.userId) !== String(customerId))) {
        throw new AppError({
          status: 404,
          code: 'DIAGNOSTIC_BOOKING_NOT_FOUND',
          message: 'Diagnostic booking not found',
        });
      }
    }
  }

  private async resolveOrderItemsPricing(
    pharmacyId: string,
    buyerPharmacyId: string | undefined,
    items: CreateOrderRequest['items'],
    allowPriceOverride = true
  ): Promise<PricedOrderItem[]> {
    const pricedItems: PricedOrderItem[] = [];

    for (const item of items) {
      const inventoryItem = await this.inventoryService.getInventoryByMedicine(pharmacyId, item.medicineId);
      const medicine = await this.medicineRepository.findById(item.medicineId);
      if (!medicine || medicine.isActive === false || medicine.archivedAt) {
        throw new AppError({
          status: 404,
          code: 'MEDICINE_NOT_AVAILABLE',
          message: `Medicine ${item.medicineId} is not available`,
        });
      }
      const preferredPrice =
        buyerPharmacyId ? inventoryItem.wholesalePrice : inventoryItem.retailPrice;
      const fallbackPrice =
        buyerPharmacyId ? inventoryItem.retailPrice : inventoryItem.wholesalePrice;
      const unitPrice = allowPriceOverride && item.unitPrice !== undefined
        ? item.unitPrice
        : preferredPrice ?? fallbackPrice;

      if (unitPrice === undefined) {
        throw new AppError({
          status: 400,
          code: 'PRICE_NOT_AVAILABLE',
          message: `Price not available in inventory for medicine ${item.medicineId}`,
        });
      }

      pricedItems.push({
        ...item,
        medicineName: medicine.name,
        unitPrice,
        hsnCode: medicine.hsnCode,
        gstPercent: medicine.gstPercent ?? 0,
        prescriptionRequired: medicine.prescriptionRequired,
      });
    }

    return pricedItems;
  }

  private assertNewCommerceForOrder(order: IPharmacyOrder, expectedOrderId: string): Promise<void> {
    return assertPrescriptionCommerceAvailable({
      kind: 'stored_order',
      order,
      expectedOrderId,
      readMedicines: ids => this.medicineRepository.findAll(
        { _id: { $in: ids } },
        { select: '_id prescriptionRequired isActive archivedAt' }
      ),
    });
  }

  private assertUniqueMedicines(items: CreateOrderRequest['items']): void {
    const seen = new Set<string>();
    for (const item of items) {
      const medicineId = String(item.medicineId);
      if (seen.has(medicineId)) {
        throw new AppError({
          status: 400,
          code: 'DUPLICATE_ORDER_MEDICINE',
          message: `Medicine ${medicineId} can appear only once in an order`,
        });
      }
      seen.add(medicineId);
    }
  }

  private assertPrescriptionProvided(
    items: PricedOrderItem[],
    prescriptionUrls?: string[]
  ): 'not_required' | 'pending' {
    // P9 (owner decision): attaching a prescription is optional; any Rx line puts the order under pharmacist review.
    void prescriptionUrls;
    return items.some((item) => item.prescriptionRequired) ? 'pending' : 'not_required';
  }

  private async queueSubscriptionSyncSafely(
    orderId: string,
    trigger:
      | 'order_created'
      | 'order_updated'
      | 'payment_completed'
      | 'status_changed'
      | 'order_marked_paid'
      | 'order_abandoned'
  ): Promise<void> {
    try {
      await this.sideEffectService.queueSubscriptionSync(orderId, trigger);
    } catch (error) {
      logger.error('Failed to queue pharmacy order subscription sync', {
        orderId,
        trigger,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async queueNotificationSafely(
    orderId: string,
    trigger:
      | 'order_created'
      | 'order_updated'
      | 'payment_completed'
      | 'status_changed'
      | 'order_marked_paid'
      | 'order_abandoned'
  ): Promise<void> {
    try {
      await this.sideEffectService.queueNotification(orderId, trigger);
    } catch (error) {
      logger.error('Failed to queue pharmacy order notification', {
        orderId,
        trigger,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async create(
    pharmacyId: string,
    data: CreateOrderRequest,
    createdById: string,
    createdByRole: string,
    options: {
      allowPriceOverride?: boolean;
      /** Refill orders (P7): the order id allocated on the subscription beforehand, and its cycle binding. */
      orderId?: string;
      refill?: { subscriptionId: string; cycleDate: string; paymentDueBy: Date };
      /** P8: the customer's checkout request key; claimed in the order's transaction (once-only). */
      checkoutRequestKey?: string;
      /** P8: the cart this checkout came from (id + version), so a replay can finish emptying exactly that cart. */
      checkoutCart?: { id: string; updatedAt: Date };
      /** Assisted booking phase 0: an order from a booking's prescription (checked terms, key and content hash). */
      rxOrder?: RxOrderTerms & { requestKey: string; requestHash: string };
    } = {}
  ): Promise<{
    order: IPharmacyOrder;
    paymentRequired: boolean;
    payment?: {
      paymentTransactionId: string;
      razorpayOrderId?: string;
      razorpayKeyId?: string;
      amount: number;
      currency: string;
      baseAmount: number;
      discountAmount: number;
    };
  }> {
    if (data.prescriptionFromBookingId !== undefined && !options.rxOrder) {
      return this.createFromPrescription(pharmacyId, data, createdById, createdByRole);
    }
    if (data.requestKey !== undefined && !options.rxOrder) {
      throw new AppError({ status: 400, code: 'REQUEST_KEY_UNSUPPORTED', message: 'A requestKey is for orders made from a prescription' });
    }
    this.validateOrderParty(data);
    this.assertUniqueMedicines(data.items);

    const recurringItems = data.items.filter((item) => item.recurring);
    if (recurringItems.length && !data.customerId) {
      throw new AppError({
        status: 400,
        code: 'CUSTOMER_ID_REQUIRED_FOR_SUBSCRIPTION',
        message: 'customerId is required when recurring items are included',
      });
    }

    // S3: a pharmacy's link to the customer (and the order's party rules) are checked before any linked booking is
    // looked up, so an unlinked caller learns nothing about that customer's bookings. A customer's own order links
    // the pharmacy only after the order passes its checks (below).
    this.ensureLinkedOrderAllowed(data);
    const linkCheckedFirst = Boolean(data.customerId) && createdByRole !== 'user';
    if (linkCheckedFirst) {
      await this.customerService.ensureLinked(pharmacyId, data.customerId!, createdById, createdByRole);
    }
    await this.validateLinkedReferences(data.customerId, data);

    const pricedItems = await this.resolveOrderItemsPricing(
      pharmacyId,
      data.buyerPharmacyId,
      data.items,
      options.allowPriceOverride ?? true
    );
    await assertPrescriptionCommerceAvailable({
      kind: 'new_items',
      items: pricedItems,
      prescriptionUrls: data.prescriptionUrls,
      // P9: refill orders stay non-Rx (a paid refill consumes its cycle before any pharmacist review).
      rx: options.refill ? 'forbid' : 'allow',
    });
    // Only explicit boolean flags survive the shared guard.
    const admittedItems = pricedItems as NonPrescriptionOrderItem[];
    if (data.customerId && !linkCheckedFirst) {
      await this.customerService.ensureLinked(
        pharmacyId,
        data.customerId,
        createdById,
        createdByRole
      );
    }

    const { payerUserId, payerPharmacyId } = this.resolvePaymentPayer({
      customerId: data.customerId,
      buyerPharmacyId: data.buyerPharmacyId,
      createdById,
    });
    const prescriptionStatus = this.assertPrescriptionProvided(admittedItems, data.prescriptionUrls);
    const {
      items,
      subtotal,
      discountTotal,
      taxTotal,
      grandTotal,
      subtotalPaise,
      discountTotalPaise,
      taxTotalPaise,
      grandTotalPaise,
    } = computeTotals(admittedItems);
    const inventoryItems = this.buildInventoryItems(items);

    // Create the order and consume stock as one unit: either both are
    // committed or neither is, so no orphan order or lost stock on failure.
    const savedOrder = await this.runOrderInventoryTransaction(async (session) => {
      // P8: a keyed checkout claims its key in the same transaction as the order: a key abandoned meanwhile refuses
      // (REQUEST_ABANDONED), and a second order under the same key is impossible (unique {customerId, key}).
      if (options.checkoutRequestKey) {
        if (!data.customerId) throw new AppError({ status: 400, code: 'REQUEST_KEY_UNSUPPORTED', message: 'Request keys are for customer orders' });
        await claimRequestKey(scopeOf('pharmacy_checkout', String(data.customerId)), options.checkoutRequestKey, session);
      }
      // Assisted booking phase 0: the prescription order's key is claimed with the order (abandoned keys refuse); the
      // unique {pharmacyId, prescriptionFromBooking.requestKey} makes a second order under it impossible.
      if (options.rxOrder) await claimRequestKey(scopeOf('pharmacy_rx_order', pharmacyId), options.rxOrder.requestKey, session);
      const allocations = await this.inventoryService.reserveOrderStockBulk(
        pharmacyId,
        inventoryItems,
        session
      );
      const reservedItems = items.map((item) => ({
        ...item,
        batchAllocations: allocations.get(String(item.medicineId)) || [],
      }));
      const created = await this.orderRepo.save(
        {
          // Refill orders are inserted under their pre-allocated id together with the cycle binding, so the order
          // can never exist (or be paid) unbound, and a retry can only ever produce this same order (E11000).
          ...(options.orderId ? { _id: options.orderId } : {}),
          ...(options.refill ? { refill: options.refill } : {}),
          ...(options.checkoutRequestKey ? { checkoutRequestKey: options.checkoutRequestKey } : {}),
          ...(options.checkoutCart ? { checkoutCart: options.checkoutCart } : {}),
          orderNumber: this.generateOrderNumber(),
          pharmacyId,
          orderType: data.orderType,
          status: 'placed',
          customerId: data.customerId,
          buyerPharmacyId: data.buyerPharmacyId,
          createdById,
          createdByRole,
          items: reservedItems,
          subtotal,
          discountTotal,
          taxTotal,
          grandTotal,
          subtotalPaise,
          discountTotalPaise,
          taxTotalPaise,
          grandTotalPaise,
          paymentMode: data.paymentMode,
          // A zero-priced REFILL stays pending until completeZeroPayableRefill commits paid + cycle advance together.
          paymentStatus: grandTotal <= 0 && !options.refill ? 'paid' : 'pending',
          deliveryMode: data.deliveryMode,
          deliveryAddress: data.deliveryAddress,
          isWalkIn: data.isWalkIn ?? false,
          // Assisted booking phase 0: the dispensing copy, put here by the server (bound after the commit).
          prescriptionUrls: options.rxOrder ? [options.rxOrder.fileUrl] : data.prescriptionUrls ?? [],
          prescriptionStatus,
          notes: data.notes,
          linkedConsultationId: data.linkedConsultationId,
          linkedDiagnosticOrderId: data.linkedDiagnosticOrderId,
          ...(options.rxOrder ? { prescriptionFromBooking: { bookingId: options.rxOrder.bookingId, fileUrl: options.rxOrder.fileUrl,
            bindingExpiresAt: options.rxOrder.bindingExpiresAt, requestKey: options.rxOrder.requestKey, requestHash: options.rxOrder.requestHash } } : {}),
        },
        { session }
      );
      if (options.rxOrder) {
        await AssistedAuditEventModel.create([{ at: new Date(), actorKind: 'pharmacy', actorId: String(createdById), orgKind: 'pharmacy',
          orgId: pharmacyId, action: 'rx_order.created', bookingId: options.rxOrder.bookingId, orderId: String(created._id),
          requestKey: options.rxOrder.requestKey, detail: { items: reservedItems.length, prescriptionStatus } }], { session });
      }

      return created;
    });

    let order = savedOrder;

    if (grandTotal <= 0) {
      let paymentRecord;
      try {
        paymentRecord = await this.paymentService.createDirectPaidTransaction({
          userId: createdById,
          payerUserId,
          payerPharmacyId,
          context: 'pharmacy_order',
          contextId: String(savedOrder._id),
          baseAmount: subtotal,
          discountAmount: discountTotal,
          finalAmount: 0,
          notes: {
            reason: 'zero_payable_amount',
            orderChannel: savedOrder.orderType,
            orderType: savedOrder.orderType,
          },
        });
      } catch (error) {
        await this.abandonOrderAfterPaymentSetupFailure(pharmacyId, savedOrder, inventoryItems);
        throw error;
      }

      const paidPatch = { status: 'accepted' as const, paymentStatus: 'paid' as const, paymentTransactionId: paymentRecord._id! };
      const paidOrder = options.refill
        ? await this.commitZeroPayableRefill(String(savedOrder._id), String(paymentRecord._id))
        // Inserted paid (zero total) and not yet linked: accepted + linked exactly once; a cancellation that froze or
        // closed the order meanwhile wins (the status no longer matches).
        : await this.orderRepo.update({ _id: savedOrder._id, status: 'placed', paymentStatus: 'paid', paymentTransactionId: { $in: [null] } }, paidPatch);
      order = paidOrder || order;

      await this.queueNotificationSafely(String(order._id), 'order_created');
      if (data.customerId && recurringItems.length) {
        await this.queueSubscriptionSyncSafely(String(order._id), 'payment_completed');
      }

      return {
        order,
        paymentRequired: false,
        payment: {
          paymentTransactionId: paymentRecord._id!,
          amount: 0,
          currency: paymentRecord.currency,
          baseAmount: subtotal,
          discountAmount: discountTotal,
        },
      };
    }

    if (data.paymentMode === 'online_payment') {
      let createdPaymentOrder;
      try {
        createdPaymentOrder = await this.paymentService.createOrder({
          userId: createdById,
          payerUserId,
          payerPharmacyId,
          context: 'pharmacy_order',
          contextId: String(savedOrder._id),
          baseAmount: subtotal,
          discountAmount: discountTotal,
          finalAmount: grandTotal,
          notes: {
            orderChannel: savedOrder.orderType,
            orderType: savedOrder.orderType,
            pharmacyId,
          },
        });
      } catch (error) {
        await this.abandonOrderAfterPaymentSetupFailure(pharmacyId, savedOrder, inventoryItems);
        throw error;
      }

      const orderWithPayment = await this.orderRepo.update(
        // Fenced: link only while no payment is linked (a refill resume may have linked one first), and only at the total
        // the payment was created for (P8: a financial edit in between makes this payment unusable, never attached).
        { _id: savedOrder._id, grandTotal: savedOrder.grandTotal, paymentStatus: 'pending', $or: [{ paymentTransactionId: { $exists: false } }, { paymentTransactionId: null }] } as never,
        { paymentTransactionId: createdPaymentOrder.paymentRecord._id! }
      );
      if (!orderWithPayment) {
        // Lost the link race: our payment order stays unlinked and is never exposed; return the canonical one.
        const current = (await this.orderRepo.findById(String(savedOrder._id))) as IPharmacyOrder;
        const linked = current?.paymentTransactionId ? await PaymentRecordModel.findById(String(current.paymentTransactionId)).lean() : null;
        return {
          order: current,
          paymentRequired: current?.paymentStatus !== 'paid',
          ...(linked && linked.status === 'created' ? { payment: {
            paymentTransactionId: String(linked._id), razorpayOrderId: linked.razorpayOrderId, razorpayKeyId: createdPaymentOrder.razorpayKeyId,
            amount: linked.finalAmount, currency: linked.currency, baseAmount: linked.baseAmount, discountAmount: linked.discountAmount } } : {}),
        };
      }
      order = orderWithPayment;

      await this.queueNotificationSafely(String(order._id), 'order_created');

      return {
        order,
        paymentRequired: true,
        payment: {
          paymentTransactionId: createdPaymentOrder.paymentRecord._id!,
          razorpayOrderId: createdPaymentOrder.razorpayOrder.id,
          razorpayKeyId: createdPaymentOrder.razorpayKeyId,
          amount: grandTotal,
          currency: createdPaymentOrder.razorpayOrder.currency,
          baseAmount: subtotal,
          discountAmount: discountTotal,
        },
      };
    }

    await this.queueNotificationSafely(String(order._id), 'order_created');

    return {
      order,
      paymentRequired: false,
    };
  }

  /**
   * P8: how an unpaid online customer order can be paid now. Reuses the order's own open Razorpay order (never a second
   * one: late-capture refunds are keyed per order). If the original request was interrupted before its payment was
   * set up (no payment linked), sets it up now, linking it only while nothing is linked. null when it cannot be paid.
   */
  private async payableDetails(first: IPharmacyOrder, customerId: string): Promise<PharmacyPaymentDetails | null> {
    let order: IPharmacyOrder | null = first;
    // At most two set-ups: one more if a financial edit (or a concurrent set-up) changed the order meanwhile. Every
    // read must still belong to the customer who asked: a party change is refused, never followed.
    for (let attempt = 0; attempt < 2 && order; attempt++) {
      if (!order.customerId || String(order.customerId) !== customerId) return null;
      if (order.paymentMode !== 'online_payment' || order.status !== 'placed' || order.paymentStatus !== 'pending') return null;
      if (!this.paymentService.pharmacyPaymentWindowOpen(order)) return null;
      if (order.paymentTransactionId) return this.paymentService.resumablePharmacyPayment(order);
      if (!order.customerId || !(Number(order.grandTotal) > 0)) return null;
      const created = await this.paymentService.createOrder({
        userId: String(order.createdById ?? order.customerId), payerUserId: String(order.customerId),
        context: 'pharmacy_order', contextId: String(order._id),
        baseAmount: Number(order.subtotal), discountAmount: Number(order.discountTotal ?? 0), finalAmount: Number(order.grandTotal),
        notes: { orderChannel: order.orderType, orderType: order.orderType, pharmacyId: String(order.pharmacyId), resumedSetup: true },
      });
      // Linked only while the order is exactly what the payment was created for: party, payment mode, total, unlinked.
      // A financial edit while Razorpay answered makes this payment unusable (never exposed, and a capture of it would
      // be returned: its amount no longer matches).
      const linked = await this.orderRepo.update(
        { _id: order._id, status: 'placed', paymentStatus: 'pending', paymentMode: 'online_payment', grandTotal: order.grandTotal,
          customerId: order.customerId, $or: [{ paymentTransactionId: { $exists: false } }, { paymentTransactionId: null }] } as never,
        { paymentTransactionId: created.paymentRecord._id! },
      );
      if (linked) {
        return {
          paymentTransactionId: String(created.paymentRecord._id), razorpayOrderId: created.razorpayOrder.id, razorpayKeyId: created.razorpayKeyId,
          amount: Number(order.grandTotal), currency: created.razorpayOrder.currency, baseAmount: Number(order.subtotal), discountAmount: Number(order.discountTotal ?? 0),
        };
      }
      order = (await this.orderRepo.findById(String(order._id))) as IPharmacyOrder | null;
    }
    return null;
  }

  /**
   * P8: "pay again" for the customer's unpaid online order. Every earlier attempt is checked with Razorpay first (a
   * capture whose confirmation was lost is applied: then the order is simply paid); while any cannot be checked no
   * payment is offered (503 PAYMENT_STATE_UNKNOWN). Within the payment window the order's own open Razorpay order is
   * handed back for Checkout.
   */
  async retryPayment(orderId: string, actor: { _id?: string; userType?: string } | undefined): Promise<{
    order: IPharmacyOrder; paymentRequired: boolean; payment?: PharmacyPaymentDetails;
  }> {
    if (typeof orderId !== 'string' || !/^[0-9a-fA-F]{24}$/.test(orderId)) {
      throw new AppError({ status: 400, code: 'VALIDATION_ERROR', message: 'Invalid pharmacy order ID' });
    }
    if (actor?.userType !== 'user' || !actor._id) throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Access denied' });
    const owned = async () => {
      const o = (await this.orderRepo.findById(orderId)) as IPharmacyOrder | null;
      if (!o || String(o.customerId) !== String(actor._id)) throw new AppError({ status: 404, code: 'ORDER_NOT_FOUND', message: 'Order not found' });
      return o;
    };
    let order = await owned();
    if (order.paymentMode !== 'online_payment') {
      throw new AppError({ status: 409, code: 'PAYMENT_NOT_ONLINE', message: 'This order is paid at the pharmacy or on delivery' });
    }
    // Payment records name the order by its canonical id (lowercase hex), whatever case the request used.
    const settled = await this.paymentService.reconcilePharmacyOrderPayments(String(order._id));
    order = await owned();
    if (order.paymentStatus === 'paid' || order.paymentStatus === 'authorized') return { order, paymentRequired: false };
    if (settled.unknown > 0) {
      throw new AppError({ status: 503, code: 'PAYMENT_STATE_UNKNOWN', message: 'We could not check your earlier payment just now. Please try again in a few minutes.' });
    }
    if (order.status !== 'placed' || order.paymentStatus !== 'pending') {
      throw new AppError({ status: 409, code: 'ORDER_NOT_PAYABLE', message: 'This order can no longer be paid' });
    }
    if (!this.paymentService.pharmacyPaymentWindowOpen(order)) {
      throw new AppError({ status: 409, code: 'ORDER_PAYMENT_EXPIRED', message: 'The time to pay for this order has passed. Please place a new order.' });
    }
    const payment = await this.payableDetails(order, String(actor._id));
    // The answer names the order as it is now, and only if it is still this customer's.
    const now = await owned();
    if (!payment) {
      throw new AppError({ status: 409, code: 'PAYMENT_NOT_RESUMABLE', message: 'This order cannot be paid again. Please cancel it and place a new order.' });
    }
    return { order: now, paymentRequired: true, payment };
  }

  /**
   * Assisted booking phase 0 (§9.3): a medicine order from the prescription of a booking this pharmacy made, exactly
   * once per (pharmacy, requestKey). The same key and content answer the first order again (`replayed: true`); other
   * content under the key is 409 IDEMPOTENCY_KEY_REUSED; an abandoned key is 409 REQUEST_ABANDONED.
   */
  private async createFromPrescription(pharmacyId: string, data: CreateOrderRequest, createdById: string, createdByRole: string) {
    if (createdByRole !== 'pharmacy' || !/^[0-9a-fA-F]{24}$/.test(pharmacyId)) {
      throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Pharmacy access is required' });
    }
    const requestKey = assertRxOrderRequest(data);
    const { requestKey: _key, ...content } = data;
    const requestHash = requestHashOf({ kind: 'rx_order', ...content });
    await assertUniqueIndex(PharmacyOrderModel, { pharmacyId: 1, 'prescriptionFromBooking.requestKey': 1 });
    await assertUniqueIndex(RequestKeyModel, { scope: 1, key: 1 });
    const replay = async () => {
      const prior = await PharmacyOrderModel.findOne({ pharmacyId: new Types.ObjectId(pharmacyId),
        'prescriptionFromBooking.requestKey': { $eq: requestKey } }).lean() as IPharmacyOrder | null;
      if (!prior) return null;
      if (prior.prescriptionFromBooking?.requestHash !== requestHash) {
        throw new AppError({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED', message: 'This request key was already used for a different order' });
      }
      await bindRxOrderFile(prior);
      return this.checkoutReplay(prior);
    };
    const prior = await replay();
    if (prior) return prior;
    const terms = await prepareRxOrder(pharmacyId, data);
    try {
      const result = await this.create(pharmacyId, { ...content, prescriptionFromBookingId: undefined, prescriptionUrls: [],
        customerId: terms.customerId, linkedConsultationId: terms.bookingId }, createdById, createdByRole,
      { rxOrder: { ...terms, requestKey, requestHash } });
      await bindRxOrderFile(result.order);
      return result;
    } catch (error) {
      // A concurrent first request under the same key committed first: answer with its order.
      if ((error as { code?: number })?.code === 11000) {
        const again = await replay();
        if (again) return again;
      }
      throw error;
    }
  }

  /** P8: the answer to a repeated keyed checkout: the order the key produced, payable again if it is still unpaid. */
  async checkoutReplay(order: IPharmacyOrder): Promise<{ order: IPharmacyOrder; paymentRequired: boolean; payment?: PharmacyPaymentDetails; replayed: true }> {
    // A keyed order's customer is locked (ORDER_CHECKOUT_PARTY_LOCKED), so it is still the customer who placed it.
    const payment = order.paymentMode === 'online_payment' && order.customerId ? await this.payableDetails(order, String(order.customerId)) : null;
    return { order, paymentRequired: !!payment, ...(payment ? { payment } : {}), replayed: true };
  }

  private async customerRecovery(actor: unknown, id: unknown, create: boolean): Promise<PharmacyRecoveryReceipt | null> {
    if (!actor || typeof actor !== 'object' || Array.isArray(actor)) {
      throw new AppError({ status: 401, code: 'UNAUTHORIZED', message: 'Authentication is required' });
    }
    const principal = actor as Record<string, unknown>;
    if (principal.userType !== 'user') {
      throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Individual customer access is required' });
    }
    const customerId = principal._id;
    if (typeof customerId !== 'string' || !/^[0-9a-f]{24}$/.test(customerId)) {
      throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Access denied' });
    }
    if (typeof id !== 'string' || !/^[0-9a-f]{24}$/.test(id)) {
      throw new AppError({ status: 400, code: 'VALIDATION_ERROR', message: 'Invalid pharmacy order ID' });
    }
    const session = await startSession();
    const attempt: { candidate: PharmacyRecoveryReceipt | null | undefined; completed: boolean; transaction: unknown } = {
      candidate: undefined, completed: false, transaction: undefined,
    };
    try {
      // Driver4 withTransaction returns the commit response, never this callback's DTO.
      await session.withTransaction(async () => {
        attempt.candidate = undefined;
        attempt.completed = false;
        attempt.transaction = undefined;
        attempt.candidate = create
          ? await this.orderRepo.requestCustomerRecovery(id, customerId, session)
          : await this.orderRepo.getCustomerRecovery(id, customerId, session);
        attempt.transaction = (session as unknown as { transaction?: unknown }).transaction;
        attempt.completed = true;
      }, { readConcern: { level: 'snapshot' } });
      const transaction = (session as unknown as { transaction?: { state?: unknown } }).transaction;
      if (!attempt.completed || attempt.candidate === undefined || transaction !== attempt.transaction || transaction?.state !== 'TRANSACTION_COMMITTED') {
        throw new AppError({ status: 503, code: 'PHARMACY_RECOVERY_UNAVAILABLE', message: 'Pharmacy recovery is unavailable' });
      }
      return attempt.candidate;
    } finally {
      await session.endSession();
    }
  }

  async requestCustomerRecovery(actor: unknown, id: unknown): Promise<PharmacyRecoveryReceipt> {
    const receipt = await this.customerRecovery(actor, id, true);
    if (!receipt) throw new AppError({ status: 503, code: 'PHARMACY_RECOVERY_UNAVAILABLE', message: 'Pharmacy recovery is unavailable' });
    return receipt;
  }

  async getCustomerRecovery(actor: unknown, id: unknown): Promise<PharmacyRecoveryReceipt | null> {
    return this.customerRecovery(actor, id, false);
  }

  async getPrescriptionReviewQueue(pharmacyId: unknown, page = 1, limit = 20) {
    if (typeof pharmacyId !== 'string' || !/^[0-9a-fA-F]{24}$/.test(pharmacyId)) {
      throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Pharmacy access is required' });
    }
    return this.orderRepo.findPrescriptionReviewQueue(pharmacyId, PRESCRIPTION_REVIEWABLE_STATUSES, page, limit);
  }

  async getRecoveryRequests(pharmacyId: unknown, query: unknown): Promise<PharmacyRecoveryWorklistPage> {
    return this.orderRepo.findRecoveryRequests(pharmacyId, query);
  }

  async getById(id: string, requesterId: string, requesterRole: string): Promise<IPharmacyOrder> {
    const order = await this.orderRepo.findById(id);
    if (!order) {
      throw new AppError({ status: 404, code: 'ORDER_NOT_FOUND', message: 'Order not found' });
    }

    const isAdmin = requesterRole === 'admin';
    const isPharmacy = requesterRole === 'pharmacy' && String(order.pharmacyId) === requesterId;
    const isBuyerPharmacy =
      requesterRole === 'pharmacy' && String(order.buyerPharmacyId) === requesterId;
    const isCustomer = requesterRole === 'user' && String(order.customerId) === requesterId;

    if (!isAdmin && !isPharmacy && !isBuyerPharmacy && !isCustomer) {
      throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Access denied' });
    }

    return order;
  }

  async getAll(
    filter: OrderQueryParams,
    page = 1,
    limit = 20,
    requesterRole: string,
    requesterId: string
  ): Promise<{ data: IPharmacyOrder[]; total: number; page: number; totalPages: number }> {
    if (requesterRole === 'pharmacy') {
      filter.viewerPharmacyId = requesterId;
      delete filter.pharmacyId;
    } else if (requesterRole === 'user') {
      // S1: a customer sees only their own orders. `userId` is an alias the repository honours, so it must go too
      // (before this fix `?userId=<someone else>` listed another customer's orders).
      filter.customerId = requesterId;
      delete filter.userId;
      delete filter.pharmacyId;
      delete filter.buyerPharmacyId;
      delete filter.viewerPharmacyId;
    } else if (requesterRole !== 'admin') {
      throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Access denied' });
    }

    return this.orderRepo.findWithPagination(filter, page, limit);
  }

  async update(id: string, pharmacyId: string, data: UpdateOrderRequest): Promise<IPharmacyOrder> {
    if (typeof id !== 'string' || !/^[0-9a-fA-F]{24}$/.test(id)) {
      throw new AppError({ status: 400, code: 'VALIDATION_ERROR', message: 'Invalid pharmacy order ID' });
    }
    const order = await this.orderRepo.findById(id);
    if (!order) {
      throw new AppError({ status: 404, code: 'ORDER_NOT_FOUND', message: 'Order not found' });
    }
    if (
      typeof pharmacyId !== 'string' || !/^[0-9a-fA-F]{24}$/.test(pharmacyId) ||
      String(order.pharmacyId) !== pharmacyId
    ) {
      throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Access denied' });
    }
    if (TERMINAL_STATUSES.includes(order.status)) {
      throw new AppError({ status: 400, code: 'ORDER_TERMINAL', message: 'Cannot update a completed/cancelled order' });
    }

    const partyFields = ['customerId', 'buyerPharmacyId', 'orderType'] as const;
    const changesOrderParty = partyFields.some((field) => Object.prototype.hasOwnProperty.call(data, field));
    // P8: a customer's keyed checkout order keeps its customer (the key's identity; replay and recovery find it by it).
    if (changesOrderParty && order.checkoutRequestKey) {
      throw new AppError({ status: 409, code: 'ORDER_CHECKOUT_PARTY_LOCKED', message: 'The customer of an app order cannot be changed' });
    }
    // Assisted booking phase 0: an order made from a booking's prescription keeps that booking's patient (the bound
    // dispensing copy is readable by the order's customer).
    if ((changesOrderParty || Object.prototype.hasOwnProperty.call(data, 'linkedConsultationId')) && order.prescriptionFromBooking) {
      throw new AppError({ status: 409, code: 'ORDER_PRESCRIPTION_PARTY_LOCKED',
        message: "The patient of an order made from a booking's prescription cannot be changed" });
    }
    // Review finding 9: the bound dispensing copy stays the order's prescription (it cannot be removed or replaced).
    if (order.prescriptionFromBooking && Object.prototype.hasOwnProperty.call(data, 'prescriptionUrls')) {
      const sent = Array.isArray(data.prescriptionUrls) ? data.prescriptionUrls : [];
      const kept = sent.length === (order.prescriptionUrls ?? []).length && sent.every((u, i) => u === order.prescriptionUrls?.[i]);
      if (!kept) {
        throw new AppError({ status: 409, code: 'ORDER_PRESCRIPTION_LOCKED',
          message: "The prescription of an order made from a booking's prescription cannot be changed" });
      }
    }
    if (changesOrderParty && Object.prototype.hasOwnProperty.call(order, 'recoveryRequest')) {
      throw new AppError({
        status: 409,
        code: 'ORDER_RECOVERY_PARTY_LOCKED',
        message: 'Order party details are locked after a recovery request',
      });
    }

    const financialFields: Array<keyof UpdateOrderRequest> = [
      'orderType',
      'customerId',
      'buyerPharmacyId',
      'items',
      'deliveryAddress',
      'paymentMode',
      'deliveryMode',
      'isWalkIn',
      'linkedConsultationId',
      'linkedDiagnosticOrderId',
    ];
    const changesFinancialData = financialFields.some((field) => data[field] !== undefined);
    const financialEditAllowed =
      order.status === 'placed' &&
      order.paymentStatus === 'pending' &&
      !order.paymentTransactionId;
    if (changesFinancialData && !financialEditAllowed) {
      throw new AppError({
        status: 409,
        code: 'ORDER_FINANCIALS_LOCKED',
        message: 'Order items and financial details are locked after payment initiation or order acceptance',
      });
    }

    // P9: what the pharmacist reviewed is fixed once reviewed: no item or prescription-document edits afterwards.
    const changesReviewedEvidence = data.items !== undefined || data.prescriptionUrls !== undefined;
    if (changesReviewedEvidence && (order.prescriptionStatus === 'approved' || order.prescriptionStatus === 'rejected')) {
      throw new AppError({ status: 409, code: 'PRESCRIPTION_REVIEWED_LOCKED', message: 'The medicines and prescription were already reviewed and can no longer change' });
    }

    const enrichesCommerce = Reflect.ownKeys(data).some(key => key !== 'notes');
    if (enrichesCommerce) {
      await this.assertNewCommerceForOrder(order, id);
      if (!data.items) {
        await assertPrescriptionCommerceAvailable({
          kind: 'new_items',
          items: order.items,
          prescriptionUrls: data.prescriptionUrls !== undefined ? data.prescriptionUrls : order.prescriptionUrls,
          rx: order.refill ? 'forbid' : 'allow', // P9: refills stay non-Rx on every edit
        });
      }
    }

    const nextCustomerId =
      data.customerId !== undefined
        ? data.customerId
        : order.customerId
          ? String(order.customerId)
          : undefined;
    const nextBuyerPharmacyId =
      data.buyerPharmacyId !== undefined
        ? data.buyerPharmacyId
        : order.buyerPharmacyId
          ? String(order.buyerPharmacyId)
          : undefined;
    const nextOrderType = data.orderType ?? order.orderType;
    const hasExistingRecurring = this.hasRecurringItems(order.items);
    const hasRequestedRecurring = data.items ? this.hasRecurringItems(data.items) : false;

    if (hasRequestedRecurring && !nextCustomerId) {
      throw new AppError({
        status: 400,
        code: 'CUSTOMER_ID_REQUIRED_FOR_SUBSCRIPTION',
        message: 'customerId is required when recurring items are included',
      });
    }

    this.validateOrderParty({
      orderType: nextOrderType,
      customerId: nextCustomerId,
      buyerPharmacyId: nextBuyerPharmacyId,
      items:
        data.items ||
        order.items.map((item) => ({
          medicineId: String(item.medicineId),
          medicineName: item.medicineName,
          orderedQty: item.orderedQty,
          unitPrice: item.unitPrice,
          discount: item.discount,
          freeQty: item.freeQty,
          recurring: item.recurring,
          subscriptionFrequency: item.subscriptionFrequency,
          subscriptionIntervalDays: item.subscriptionIntervalDays,
          subscriptionNextRefillDate: item.subscriptionNextRefillDate,
          subscriptionReminderChannel: item.subscriptionReminderChannel,
        })),
    });

    const nextLinkedConsultationId =
      data.linkedConsultationId !== undefined
        ? data.linkedConsultationId
        : order.linkedConsultationId
          ? String(order.linkedConsultationId)
          : undefined;
    const nextLinkedDiagnosticOrderId =
      data.linkedDiagnosticOrderId !== undefined
        ? data.linkedDiagnosticOrderId
        : order.linkedDiagnosticOrderId;

    // S3: party rules and the link to a new customer first, before any linked booking is looked up.
    this.ensureLinkedOrderAllowed({
      customerId: nextCustomerId,
      buyerPharmacyId: nextBuyerPharmacyId,
      linkedConsultationId: nextLinkedConsultationId,
      linkedDiagnosticOrderId: nextLinkedDiagnosticOrderId,
    });
    if (nextCustomerId && String(order.customerId || '') !== nextCustomerId) {
      await this.customerService.ensureLinked(pharmacyId, nextCustomerId, pharmacyId, 'pharmacy');
    }
    await this.validateLinkedReferences(nextCustomerId, {
      linkedConsultationId: nextLinkedConsultationId,
      linkedDiagnosticOrderId: nextLinkedDiagnosticOrderId,
    });

    let updatePayload: Record<string, unknown> = {
      ...data,
      ...(Object.prototype.hasOwnProperty.call(data, 'customerId') ? { customerId: nextCustomerId } : {}),
      ...(Object.prototype.hasOwnProperty.call(data, 'buyerPharmacyId') ? { buyerPharmacyId: nextBuyerPharmacyId } : {}),
      ...(Object.prototype.hasOwnProperty.call(data, 'orderType') ? { orderType: nextOrderType } : {}),
    };

    const shouldRepriceItems = Boolean(data.items);

    if (shouldRepriceItems) {
      const incomingItems = data.items as CreateOrderRequest['items'];
      this.assertUniqueMedicines(incomingItems);
      const pricedItems = await this.resolveOrderItemsPricing(
        pharmacyId,
        nextBuyerPharmacyId,
        incomingItems
      );
      const nextPrescriptionUrls = data.prescriptionUrls !== undefined ? data.prescriptionUrls : order.prescriptionUrls;
      await assertPrescriptionCommerceAvailable({
        kind: 'new_items',
        items: pricedItems,
        prescriptionUrls: nextPrescriptionUrls,
        rx: order.refill ? 'forbid' : 'allow', // P9: refills stay non-Rx on every edit
      });
      const admittedItems = pricedItems as NonPrescriptionOrderItem[];
      const totals = computeTotals(admittedItems);
      const prescriptionStatus = this.assertPrescriptionProvided(admittedItems, nextPrescriptionUrls);
      updatePayload = {
        ...updatePayload,
        items: totals.items,
        subtotal: totals.subtotal,
        discountTotal: totals.discountTotal,
        taxTotal: totals.taxTotal,
        grandTotal: totals.grandTotal,
        subtotalPaise: totals.subtotalPaise,
        discountTotalPaise: totals.discountTotalPaise,
        taxTotalPaise: totals.taxTotalPaise,
        grandTotalPaise: totals.grandTotalPaise,
        prescriptionStatus,
      };
    }

    const nextItemsForInventory = (updatePayload.items as IPharmacyOrder['items'] | undefined) || order.items;
    const usesBatchReservations = order.items.some((item) => item.batchAllocations?.length);
    const inventoryDelta = shouldRepriceItems && !usesBatchReservations
      ? this.buildInventoryDelta(order.items, nextItemsForInventory)
      : { toConsume: [], toReturn: [] };

    if (order.status === 'pending_cancel') {
      throw new AppError({ status: 409, code: 'ORDER_CANCEL_PENDING', message: 'A cancellation is waiting for a decision; decide it first' });
    }
    const updateFilter = {
      _id: new Types.ObjectId(id),
      pharmacyId: { $eq: new Types.ObjectId(pharmacyId) },
      // D3: the status this update was validated against (a cancellation request freezes the order).
      status: { $eq: order.status },
      $expr: { $and: [
        { $eq: [{ $type: '$_id' }, 'objectId'] },
        { $eq: [{ $type: '$pharmacyId' }, 'objectId'] },
      ] },
      ...(changesOrderParty ? { recoveryRequest: { $exists: false }, checkoutRequestKey: { $exists: false }, prescriptionFromBooking: { $exists: false } } : {}),
      // P8: a financial edit commits only while no payment is admitted (pending, nothing linked) - checked at write time,
      // so an edit validated before a payment was linked cannot change the order afterwards.
      ...(changesFinancialData ? { paymentStatus: { $eq: 'pending' }, $or: [{ paymentTransactionId: { $exists: false } }, { paymentTransactionId: null }] } : {}),
    };

    try {
      const updated = await this.runOrderInventoryTransaction(async (session) => {
        if (shouldRepriceItems && usesBatchReservations) {
          // Release the allocations as they are NOW (read in this transaction; a concurrent batch swap conflicts on
          // the order write below), never the copy read before the transaction.
          const current = await this.orderRepo.findById(id, session);
          if (!current) throw new AppError({ status: 409, code: 'ORDER_UPDATE_CONFLICT', message: 'Order changed before the update could be completed' });
          await this.releaseOrderInventory(pharmacyId, current.items, session);
          const nextItems = updatePayload.items as IOrderItem[];
          const allocations = await this.inventoryService.reserveOrderStockBulk(
            pharmacyId,
            this.buildInventoryItems(nextItems),
            session
          );
          updatePayload.items = nextItems.map((item) => ({
            ...item,
            reservedQty: item.orderedQty,
            batchAllocations: allocations.get(String(item.medicineId)) || [],
          }));
        } else if (inventoryDelta.toConsume.length || inventoryDelta.toReturn.length) {
          await this.applyInventoryDelta(pharmacyId, inventoryDelta, session);
        }

        // P9: every edit moves the order's revision; a review is accepted only for the revision it saw.
        const updatedOrder = await this.orderRepo.update(
          { ...updateFilter, ...(changesReviewedEvidence ? { prescriptionStatus: { $in: ['not_required', 'pending'] } } : {}) },
          { $set: updatePayload, $inc: { revision: 1 } }, { new: true, session });
        if (!updatedOrder) {
          throw new AppError({
            status: 409,
            code: 'ORDER_UPDATE_CONFLICT',
            message: 'Order changed before the update could be completed',
          });
        }
        return updatedOrder;
      });

      if ((hasExistingRecurring || hasRequestedRecurring) && nextCustomerId) {
        await this.queueSubscriptionSyncSafely(id, 'order_updated');
      }

      return updated;
    } catch (error) {
      throw error;
    }
  }

  async updateStatus(
    id: string,
    pharmacyId: string,
    payload: UpdateOrderStatusRequest
  ): Promise<IPharmacyOrder> {
    const order = await this.orderRepo.findById(id);
    if (!order) {
      throw new AppError({ status: 404, code: 'ORDER_NOT_FOUND', message: 'Order not found' });
    }
    if (String(order.pharmacyId) !== pharmacyId) {
      throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Access denied' });
    }
    if (TERMINAL_STATUSES.includes(order.status)) {
      throw new AppError({ status: 400, code: 'ORDER_TERMINAL', message: 'Order is already in a terminal state' });
    }

    if (!ALLOWED_STATUS_TRANSITIONS[order.status].includes(payload.status)) {
      throw new AppError({
        status: 409,
        code: 'INVALID_ORDER_STATUS_TRANSITION',
        message: `Order cannot move from ${order.status} to ${payload.status}`,
      });
    }

    if (
      ['packed', 'ready_for_pickup', 'out_for_delivery'].includes(payload.status) &&
      order.paymentMode !== 'cash_on_delivery' &&
      order.paymentStatus !== 'paid'
    ) {
      throw new AppError({
        status: 409,
        code: 'ORDER_PAYMENT_REQUIRED',
        message: 'Payment must be completed before this order can progress',
      });
    }
    if (order.refill && payload.status === 'accepted' && order.paymentStatus !== 'paid') {
      // Refill orders are confirmed only by the customer's payment (P7).
      throw new AppError({ status: 409, code: 'ORDER_PAYMENT_REQUIRED', message: 'A refill order is confirmed only after the customer pays' });
    }
    if (payload.status === 'completed' && order.paymentStatus !== 'paid') {
      throw new AppError({
        status: 409,
        code: 'ORDER_PAYMENT_REQUIRED',
        message: 'Payment must be completed before the order can be completed',
      });
    }

    const requiresPrescriptionCheck = PRESCRIPTION_GATED_STATUSES.includes(payload.status);
    if (
      requiresPrescriptionCheck &&
      order.prescriptionStatus !== 'approved' &&
      order.prescriptionStatus !== 'not_required'
    ) {
      throw new AppError({
        status: 409,
        code: 'ORDER_PRESCRIPTION_APPROVAL_REQUIRED',
        message: 'Prescription approval is required before the order can be completed',
      });
    }

    const inventoryItems = this.buildInventoryItems(
      order.items.filter((item) => item.itemStatus === 'active')
    );
    const shouldReturnInventory = ['abandoned', 'cancelled', 'rejected'].includes(payload.status);
    // D3: the generic status update never closes an order that holds money (it would not refund it): a paid order is
    // cancelled through a cancellation request. Checked here and again atomically in the write below.
    if (shouldReturnInventory && !['pending', 'failed', undefined].includes(order.paymentStatus)) {
      throw new AppError({ status: 409, code: 'ORDER_PAID_USE_CANCEL_REQUEST',
        message: 'This order is paid: request its cancellation instead, so the customer is refunded' });
    }

    const updated = await this.runOrderInventoryTransaction(async (session) => {
      const nextOrder = await this.orderRepo.update(
        {
          _id: id,
          status: order.status,
          ...(requiresPrescriptionCheck
            ? { prescriptionStatus: order.prescriptionStatus }
            : {}),
          ...(shouldReturnInventory ? { paymentStatus: { $in: ['pending', 'failed', null] } } : {}),
        },
        { status: payload.status, ...(payload.notes ? { notes: payload.notes } : {}),
          // Assisted booking phase 0 (N12, review finding 7): when an order made from a prescription was dispensed.
          ...(payload.status === 'packed' && order.prescriptionFromBooking && !order.prescriptionFromBooking.dispensedAt
            ? { 'prescriptionFromBooking.dispensedAt': new Date() } : {}) },
        { new: true, session }
      );

      if (!nextOrder) {
        throw new AppError({ status: 500, code: 'UPDATE_FAILED', message: 'Failed to update status' });
      }

      if (shouldReturnInventory && inventoryItems.length) {
        await this.releaseOrderInventory(pharmacyId, nextOrder.items, session);
      }

      if (payload.status === 'completed') {
        // nextOrder is this transaction's write of the order: its allocations are current (see allocation note).
        await this.consumeOrderInventory(pharmacyId, nextOrder.items, session);
      }

      return nextOrder;
    });

    if (!updated) {
      throw new AppError({ status: 500, code: 'UPDATE_FAILED', message: 'Failed to update status' });
    }

    await this.queueSubscriptionSyncSafely(id, 'status_changed');
    if (updated.customerId) {
      await this.queueNotificationSafely(id, 'status_changed');
    }

    return updated;
  }

  /**
   * Pharmacist approves or rejects a pending prescription on the pharmacy's own order.
   * - The pharmacist must name the exact prescription documents reviewed; if the order's documents differ, the
   *   review is refused so nobody approves documents they did not see.
   * - Approve: prescriptionStatus -> approved; the order can then be packed/dispatched via the normal status flow.
   * - Reject: placed -> rejected, accepted -> cancelled; reserved stock is released in the same transaction.
   *   Paid/authorized money is NOT moved here: the review records refundRequired=true for finance to settle.
   * All writes are compare-and-set on the state that was read (status, payment, prescription and documents).
   */
  async reviewPrescription(id: string, pharmacyId: string, data: PrescriptionReviewRequest): Promise<IPharmacyOrder> {
    if (typeof id !== 'string' || !/^[0-9a-fA-F]{24}$/.test(id)) {
      throw new AppError({ status: 400, code: 'VALIDATION_ERROR', message: 'Invalid order ID' });
    }
    const order = await this.orderRepo.findById(id);
    if (!order) throw new AppError({ status: 404, code: 'ORDER_NOT_FOUND', message: 'Order not found' });
    if (!pharmacyId || String(order.pharmacyId) !== pharmacyId) {
      throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Access denied' });
    }
    if (TERMINAL_STATUSES.includes(order.status)) {
      throw new AppError({ status: 409, code: 'ORDER_TERMINAL', message: 'Order is already in a terminal state' });
    }
    if (order.prescriptionStatus !== 'pending') {
      throw new AppError({ status: 409, code: 'PRESCRIPTION_NOT_PENDING', message: 'This order has no prescription awaiting review' });
    }
    if (!PRESCRIPTION_REVIEWABLE_STATUSES.includes(order.status)) {
      // Packing/dispatch already requires approval, so a pending prescription can only be on placed/accepted.
      throw new AppError({ status: 409, code: 'ORDER_STATE_INCONSISTENT', message: 'Order state does not allow prescription review' });
    }
    const urls = Array.isArray(order.prescriptionUrls) ? order.prescriptionUrls.map(String) : [];
    const reviewed = data.reviewedPrescriptionUrls;
    if (reviewed.length !== urls.length || reviewed.some((url, i) => url !== urls[i])) {
      throw new AppError({ status: 409, code: 'PRESCRIPTION_CHANGED', message: 'Prescription documents changed; reload the order and review again' });
    }
    // P9: the decision is about the version the pharmacist was shown, not whatever the server reads now.
    const shownRevision = Number(data.expectedRevision);
    if (!Number.isInteger(shownRevision) || shownRevision < 0 || shownRevision !== Number(order.revision ?? 0)) {
      throw new AppError({ status: 409, code: 'ORDER_STATE_CHANGED', message: 'Order changed since it was opened; reload and review again' });
    }
    const approve = data.decision === 'approve';
    // P9 (owner decision): approval without an attached prescription is allowed; the record says none was attached.
    const reason = data.reason?.trim();
    // P9: the pharmacist named in the request, else the pharmacy's registered pharmacist (one-button approval).
    let pharmacistName = data.pharmacistName?.trim();
    let pharmacistRegistrationNumber = data.pharmacistRegistrationNumber?.trim();
    if (!pharmacistName || !pharmacistRegistrationNumber) {
      const pharmacy = await PharmacyModel.findById(pharmacyId).select({ pharmacist: 1 }).lean() as { pharmacist?: { name?: string; registrationNumber?: string } } | null;
      pharmacistName = pharmacy?.pharmacist?.name?.trim();
      pharmacistRegistrationNumber = pharmacy?.pharmacist?.registrationNumber?.trim();
      if (!pharmacistName || !pharmacistRegistrationNumber) {
        throw new AppError({ status: 409, code: 'PHARMACIST_PROFILE_REQUIRED', message: "Add your pharmacist's name and registration number first" });
      }
    }
    if (!approve && !reason) {
      throw new AppError({ status: 400, code: 'VALIDATION_ERROR', message: 'A reason is required to reject a prescription' });
    }

    const paymentStatus = order.paymentStatus ?? 'pending';
    const review: PrescriptionReview = {
      decision: approve ? 'approved' : 'rejected',
      pharmacistName,
      pharmacistRegistrationNumber,
      ...(reason ? { reason } : {}),
      reviewedDocumentSetSha256: prescriptionDocumentSetSha256(urls),
      reviewedDocumentCount: urls.length,
      prescriptionAttached: urls.length > 0,
      reviewedRevision: shownRevision,
      reviewedByPharmacyId: pharmacyId,
      reviewedAt: new Date(),
      orderStatusAtReview: order.status,
      paymentStatusAtReview: paymentStatus,
      refundRequired: !approve && ['paid', 'partially_paid', 'authorized'].includes(paymentStatus),
    };
    const fence = {
      _id: id,
      pharmacyId: order.pharmacyId,
      status: order.status,
      prescriptionStatus: 'pending',
      prescriptionUrls: { $eq: [...urls] },
      prescriptionReview: { $exists: false },
      // P9: exactly the revision reviewed (items, documents, totals): any edit in between makes this decision fail.
      ...(shownRevision === 0 ? { revision: { $in: [null, 0] } } : { revision: shownRevision }),
      ...(order.paymentStatus === undefined ? { paymentStatus: { $exists: false } } : { paymentStatus: order.paymentStatus }),
    };
    const stateChanged = () => new AppError({ status: 409, code: 'ORDER_STATE_CHANGED', message: 'Order changed while it was being reviewed; reload and try again' });

    if (approve) {
      const updated = await this.orderRepo.update(fence, { $set: { prescriptionStatus: 'approved', prescriptionReview: review } }, { new: true });
      if (!updated) throw stateChanged();
      if (updated.customerId) await this.queueNotificationSafely(id, 'order_updated');
      return updated;
    }

    const nextStatus: OrderStatus = order.status === 'placed' ? 'rejected' : 'cancelled';
    const rejectNote = `Prescription rejected by pharmacist: ${reason}`;
    const priorNotes = order.notes?.trim();
    const updated = await this.runOrderInventoryTransaction(async (session) => {
      // Paid order: the refund intent commits atomically with the rejection, so it can never be lost.
      const refundIntent = review.refundRequired ? await this.prescriptionRefundService.buildIntent(order, session) : undefined;
      const next = await this.orderRepo.update(fence, {
        $set: { prescriptionStatus: 'rejected', prescriptionReview: review, status: nextStatus,
          notes: priorNotes ? `${priorNotes}\n${rejectNote}` : rejectNote, ...(refundIntent ? { prescriptionRefund: refundIntent } : {}) },
      }, { new: true, session });
      if (!next) throw stateChanged();
      await this.releaseOrderInventory(pharmacyId, next.items, session);
      return next;
    });
    // Credit the payer's wallet now; if that fails the intent stays wallet_pending for the scheduled reconciler.
    let result = updated;
    if (review.refundRequired) {
      await this.prescriptionRefundService.settleAfterRejection(id);
      result = (await this.orderRepo.findById(id)) ?? updated;
    }
    await this.queueSubscriptionSyncSafely(id, 'status_changed');
    if (updated.customerId) await this.queueNotificationSafely(id, 'status_changed');
    return result;
  }

  /**
   * Finishes a refill order whose creation was interrupted (P7): a paid refill whose cycle did not advance is advanced
   * (fenced, exactly once); an unpaid online refill with no payment record gets its payment set up, without
   * re-creating the order or its stock reservation. Safe to call repeatedly.
   */
  async resumeRefillOrder(orderId: string): Promise<IPharmacyOrder | null> {
    const order = await this.orderRepo.findById(orderId);
    if (!order?.refill) return order;
    if (order.paymentStatus === 'paid') {
      await advanceRefillOnPayment(order);
      return this.orderRepo.findById(orderId);
    }
    if (order.status !== 'placed' || order.paymentStatus !== 'pending' || order.paymentMode !== 'online_payment' || order.paymentTransactionId) {
      return order;
    }
    const { payerUserId, payerPharmacyId } = this.resolvePaymentPayer({
      customerId: order.customerId ? String(order.customerId) : undefined,
      buyerPharmacyId: order.buyerPharmacyId ? String(order.buyerPharmacyId) : undefined,
      createdById: String(order.createdById),
    });
    if (Number(order.grandTotal || 0) <= 0) {
      // Interrupted zero-priced refill: finish it through the same completion as creation.
      const direct = await this.paymentService.createDirectPaidTransaction({
        userId: String(order.createdById), payerUserId, payerPharmacyId, context: 'pharmacy_order', contextId: String(order._id),
        baseAmount: Number(order.subtotal || 0), discountAmount: Number(order.discountTotal || 0), finalAmount: 0,
        notes: { reason: 'zero_payable_amount', orderChannel: order.orderType, orderType: order.orderType, resumedRefill: true },
      });
      return (await this.commitZeroPayableRefill(orderId, String(direct._id))) ?? this.orderRepo.findById(orderId);
    }
    const created = await this.paymentService.createOrder({
      userId: String(order.createdById),
      payerUserId,
      payerPharmacyId,
      context: 'pharmacy_order',
      contextId: String(order._id),
      baseAmount: Number(order.subtotal || 0),
      discountAmount: Number(order.discountTotal || 0),
      finalAmount: Number(order.grandTotal || 0),
      notes: { orderChannel: order.orderType, orderType: order.orderType, pharmacyId: String(order.pharmacyId), resumedRefillPaymentSetup: true },
    });
    // Link only if nobody linked one meanwhile; a losing payment order stays unlinked and unpaid.
    await this.orderRepo.update(
      { _id: order._id, $or: [{ paymentTransactionId: { $exists: false } }, { paymentTransactionId: null }] } as never,
      { paymentTransactionId: created.paymentRecord._id! }
    );
    return this.orderRepo.findById(orderId);
  }

  /**
   * The ONLY place a zero-priced refill becomes paid: still placed + pending → accepted + paid + linked, and the
   * subscription cycle advances, in one transaction. Losing concurrent completions change nothing.
   */
  private async commitZeroPayableRefill(orderId: string, paymentRecordId: string): Promise<IPharmacyOrder | null> {
    return this.runOrderInventoryTransaction(async (session) => {
      const paid = await this.orderRepo.update({ _id: orderId, status: 'placed', paymentStatus: 'pending' },
        { status: 'accepted', paymentStatus: 'paid', paymentTransactionId: paymentRecordId }, { new: true, session });
      if (paid) await advanceRefillOnPayment(paid, session);
      return paid ?? ((await this.orderRepo.findById(orderId)) as IPharmacyOrder);
    });
  }

  /**
   * Delivery/pickup exceptions (P7b). One CAS transaction on the observed status and payment state, with a recorded
   * reason. Cancelling exceptions (not_collected, refused_at_door) release reserved stock and, for a paid order,
   * write the refund intent in the same transaction; the wallet credit follows (P2 refund service + reconciler).
   */
  async recordDeliveryException(
    id: string,
    pharmacyId: string,
    data: { type: DeliveryExceptionType; reason?: string }
  ): Promise<IPharmacyOrder> {
    const rules: Record<DeliveryExceptionType, { from: OrderStatus[]; to: OrderStatus; pickup?: boolean; cancel?: boolean }> = {
      delivery_failed: { from: ['out_for_delivery'], to: 'delivery_failed' },
      retry_delivery: { from: ['delivery_failed'], to: 'out_for_delivery' },
      switch_to_pickup: { from: ['out_for_delivery', 'delivery_failed'], to: 'ready_for_pickup', pickup: true },
      not_collected: { from: ['ready_for_pickup'], to: 'cancelled', cancel: true },
      refused_at_door: { from: ['out_for_delivery', 'delivery_failed'], to: 'cancelled', cancel: true },
    };
    const rule = rules[data.type];
    if (!rule) throw new AppError({ status: 400, code: 'VALIDATION_ERROR', message: 'Unknown delivery exception' });
    if (typeof id !== 'string' || !/^[0-9a-fA-F]{24}$/.test(id)) {
      throw new AppError({ status: 400, code: 'VALIDATION_ERROR', message: 'Invalid order ID' });
    }
    const order = await this.orderRepo.findById(id);
    if (!order) throw new AppError({ status: 404, code: 'ORDER_NOT_FOUND', message: 'Order not found' });
    if (!pharmacyId || String(order.pharmacyId) !== pharmacyId) throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Access denied' });
    if (!rule.from.includes(order.status)) {
      throw new AppError({ status: 409, code: 'INVALID_ORDER_STATUS_TRANSITION',
        message: `"${data.type}" is not possible for an order that is ${order.status}` });
    }
    const reason = data.reason?.trim();
    if (data.type !== 'retry_delivery' && !reason) {
      throw new AppError({ status: 400, code: 'VALIDATION_ERROR', message: 'A reason is required' });
    }
    const paymentStatus = order.paymentStatus ?? 'pending';
    const refundRequired = !!rule.cancel && ['paid', 'partially_paid', 'authorized'].includes(paymentStatus) && !order.prescriptionRefund;
    const record: DeliveryExceptionRecord = { type: data.type, ...(reason ? { reason } : {}), at: new Date(), byPharmacyId: pharmacyId,
      fromStatus: order.status, toStatus: rule.to, refundRequired };
    const fence = { _id: id, pharmacyId: order.pharmacyId, status: order.status,
      ...(order.paymentStatus === undefined ? { paymentStatus: { $exists: false } } : { paymentStatus: order.paymentStatus }),
      prescriptionRefund: order.prescriptionRefund ? { $exists: true } : { $exists: false } };

    const updated = await this.runOrderInventoryTransaction(async (session) => {
      const refundIntent = refundRequired ? await this.prescriptionRefundService.buildIntent(order, session,
        data.type === 'not_collected' ? 'delivery_not_collected' : 'delivery_refused') : undefined;
      const next = await this.orderRepo.update(fence, {
        $set: { status: rule.to, ...(rule.pickup ? { deliveryMode: 'pickup' } : {}), ...(refundIntent ? { prescriptionRefund: refundIntent } : {}) },
        $push: { deliveryExceptions: record },
      }, { new: true, session });
      if (!next) {
        throw new AppError({ status: 409, code: 'ORDER_STATE_CHANGED', message: 'Order changed while this was being recorded; reload and try again' });
      }
      if (rule.cancel) await this.releaseOrderInventory(pharmacyId, next.items, session);
      return next;
    });

    let result = updated;
    if (refundRequired) {
      await this.prescriptionRefundService.settleAfterRejection(id); // wallet credit; reconciler retries on failure
      result = (await this.orderRepo.findById(id)) ?? updated;
    }
    await this.queueSubscriptionSyncSafely(id, 'status_changed');
    if (updated.customerId) await this.queueNotificationSafely(id, 'status_changed');
    return result;
  }

  /**
   * Staff cancel an open order because units reserved for it came from a quarantined, recalled or expired batch and
   * cannot be swapped (P3b recall worklist). Stock goes back to its batches (held batches stay held); a paid order
   * gets its refund intent in the same transaction and is credited to the wallet (P2 refund service + reconciler).
   */
  async cancelForStockHold(id: string, pharmacyId: string, data: { reason: string }): Promise<IPharmacyOrder> {
    if (typeof id !== 'string' || !/^[0-9a-fA-F]{24}$/.test(id)) {
      throw new AppError({ status: 400, code: 'VALIDATION_ERROR', message: 'Invalid order ID' });
    }
    const reason = data.reason?.trim();
    if (!reason) throw new AppError({ status: 400, code: 'VALIDATION_ERROR', message: 'A reason is required' });
    const order = await this.orderRepo.findById(id);
    if (!order) throw new AppError({ status: 404, code: 'ORDER_NOT_FOUND', message: 'Order not found' });
    if (!pharmacyId || String(order.pharmacyId) !== pharmacyId) throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Access denied' });
    if (!['placed', 'accepted', 'packed', 'ready_for_pickup', 'out_for_delivery', 'delivery_failed'].includes(order.status)) {
      throw new AppError({ status: 409, code: 'INVALID_ORDER_STATUS_TRANSITION', message: `An order that is ${order.status} cannot be cancelled` });
    }
    const paymentStatus = order.paymentStatus ?? 'pending';
    const refundRequired = ['paid', 'partially_paid', 'authorized'].includes(paymentStatus) && !order.prescriptionRefund;
    const fence = { _id: id, pharmacyId: order.pharmacyId, status: order.status,
      ...(order.paymentStatus === undefined ? { paymentStatus: { $exists: false } } : { paymentStatus: order.paymentStatus }),
      prescriptionRefund: order.prescriptionRefund ? { $exists: true } : { $exists: false } };

    const updated = await this.runOrderInventoryTransaction(async (session) => {
      // Only an order that really holds units of a withdrawn batch (checked in the transaction snapshot).
      const today = istTodayYyyymmdd();
      let held = false;
      const current = await this.orderRepo.findById(id, session);
      for (const item of (current?.items ?? []).filter(i => i.itemStatus === 'active' && i.batchAllocations?.length)) {
        const inv = await InventoryItemModel.findOne({ pharmacyId, medicineId: item.medicineId }).select('batches._id batches.status batches.expiryDate').session(session).lean();
        held ||= (item.batchAllocations ?? []).some(a => {
          const b = inv?.batches?.find(x => String((x as { _id?: unknown })._id) === String(a.batchId));
          return !b || b.status !== 'active' || b.expiryDate < today;
        });
      }
      if (!held) throw new AppError({ status: 409, code: 'NO_HELD_STOCK', message: 'This order holds no units from quarantined, recalled or expired batches' });
      const refundIntent = refundRequired ? await this.prescriptionRefundService.buildIntent(order, session, 'stock_hold_cancelled') : undefined;
      const next = await this.orderRepo.update(fence, {
        $set: { status: 'cancelled', stockHoldCancellation: { reason, at: new Date(), byPharmacyId: pharmacyId, fromStatus: order.status, refundRequired },
          ...(refundIntent ? { prescriptionRefund: refundIntent } : {}) },
      }, { new: true, session });
      if (!next) throw new AppError({ status: 409, code: 'ORDER_STATE_CHANGED', message: 'Order changed while it was being cancelled; reload and try again' });
      await this.releaseOrderInventory(pharmacyId, next.items, session);
      return next;
    });

    let result = updated;
    if (refundRequired) {
      await this.prescriptionRefundService.settleAfterRejection(id);
      result = (await this.orderRepo.findById(id)) ?? updated;
    }
    await this.queueSubscriptionSyncSafely(id, 'status_changed');
    if (updated.customerId) await this.queueNotificationSafely(id, 'status_changed');
    return result;
  }

  // ---------------------------------------------------------------------------------------------------------------
  // D3: cancellation of pharmacy orders. Unpaid → cancelled at once; paid → `pending_cancel`, decided by an admin or the
  // order's pharmacy. The request and every decision are exact compare-and-sets on what was read; decisions name the
  // requestId they reviewed and run in a transaction with a fresh read.
  // ---------------------------------------------------------------------------------------------------------------

  private assertCancelActor(order: IPharmacyOrder, actor: CancelActor, deciding: boolean): void {
    if (actor.userType === 'admin') return;
    if (actor.userType === 'pharmacy' && actor.pharmacyId && String(order.pharmacyId) === String(actor.pharmacyId)) return;
    if (!deciding && actor.userType === 'user' && order.customerId && String(order.customerId) === String(actor._id)) return;
    throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Access denied' });
  }

  async requestCancel(id: string, actor: CancelActor, data: { reason?: string } = {}): Promise<IPharmacyOrder> {
    if (typeof id !== 'string' || !/^[0-9a-fA-F]{24}$/.test(id)) {
      throw new AppError({ status: 400, code: 'VALIDATION_ERROR', message: 'Invalid order ID' });
    }
    const reason = typeof data.reason === 'string' ? data.reason.trim().slice(0, 500) : undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      const order = await this.orderRepo.findById(id);
      if (!order) throw new AppError({ status: 404, code: 'ORDER_NOT_FOUND', message: 'Order not found' });
      this.assertCancelActor(order as IPharmacyOrder, actor, false);
      const status = order.status;
      if (status === 'pending_cancel') {
        throw new AppError({ status: 409, code: 'CANCEL_ALREADY_REQUESTED', message: 'A cancellation is already waiting for a decision' });
      }
      if (!CANCELLABLE_STATUSES.includes(status)) {
        throw new AppError({ status: 409, code: 'INVALID_ORDER_STATUS_TRANSITION', message: `An order that is ${status} cannot be cancelled` });
      }
      const payment = order.paymentStatus;
      const unpaid = payment === undefined || payment === 'pending' || payment === 'failed';
      const paid = payment === 'paid' || payment === 'authorized' || payment === 'partially_paid';
      if (!unpaid && !paid) {
        throw new AppError({ status: 409, code: 'INVALID_ORDER_STATUS_TRANSITION', message: 'This order cannot be cancelled' });
      }
      // Exact snapshot: the stored fromStatus / paymentStatusAtRequest are exactly what this write matched.
      // The authority this request was checked against is part of the write: a reassigned customer or pharmacy fails it.
      const fence = { _id: id, status, ...(payment === undefined ? { paymentStatus: { $exists: false } } : { paymentStatus: payment }),
        pharmacyId: order.pharmacyId, customerId: order.customerId ?? { $exists: false } };
      const request = { requestId: new Types.ObjectId().toHexString(), fromStatus: status, paymentStatusAtRequest: payment ?? 'pending',
        requestedByType: actor.userType, requestedById: String(actor._id), ...(reason ? { reason } : {}), requestedAt: new Date() };
      let next: IPharmacyOrder | null;
      if (unpaid) {
        // No money involved: cancelled at once, stock released in the same transaction (the status CAS is the once-only fence).
        next = await this.runOrderInventoryTransaction(async (session) => {
          const done = await this.orderRepo.update(fence, { $set: { status: 'cancelled',
            cancelRequest: { ...request, state: 'approved', decidedAt: new Date(), decisionNote: 'Unpaid order: cancelled at once' } } },
          { new: true, session });
          if (done) await this.releaseOrderInventory(String(done.pharmacyId), done.items, session);
          return done as IPharmacyOrder | null;
        });
      } else {
        next = await this.orderRepo.update(fence, { $set: { status: 'pending_cancel', cancelRequest: { ...request, state: 'pending' } } },
          { new: true }) as IPharmacyOrder | null;
      }
      if (next) {
        await this.queueSubscriptionSyncSafely(id, 'status_changed');
        if (next.customerId) await this.queueNotificationSafely(id, 'status_changed');
        return next;
      }
      // The order changed between the read and the write (progressed, or a COD order became paid): read again.
    }
    throw new AppError({ status: 409, code: 'ORDER_CHANGED', message: 'The order changed while it was being cancelled; reload and try again' });
  }

  private requestChanged(): AppError {
    return new AppError({ status: 409, code: 'CANCEL_REQUEST_CHANGED', message: 'This cancellation request changed; reload the order and decide again' });
  }

  async approveCancel(id: string, actor: CancelActor, data: { requestId?: string; note?: string }): Promise<IPharmacyOrder> {
    const requestId = typeof data.requestId === 'string' ? data.requestId : '';
    if (!/^[0-9a-f]{24}$/.test(requestId)) throw new AppError({ status: 400, code: 'VALIDATION_ERROR', message: 'requestId is required' });
    const note = typeof data.note === 'string' ? data.note.trim().slice(0, 500) : undefined;
    const outcome = await this.runOrderInventoryTransaction(async (session) => {
      const order = await this.orderRepo.findById(id, session) as IPharmacyOrder | null;
      if (!order) throw new AppError({ status: 404, code: 'ORDER_NOT_FOUND', message: 'Order not found' });
      this.assertCancelActor(order, actor, true);
      if (order.status !== 'pending_cancel' || order.cancelRequest?.state !== 'pending' || order.cancelRequest.requestId !== requestId) {
        throw this.requestChanged();
      }
      const payment = order.paymentStatus;
      if (payment === 'authorized') {
        throw new AppError({ status: 409, code: 'PAYMENT_IN_PROGRESS', message: 'The payment is still being confirmed; try again in a few minutes' });
      }
      const refundRequired = (payment === 'paid' || payment === 'partially_paid') && !order.prescriptionRefund;
      const intent = refundRequired ? await this.prescriptionRefundService.buildIntent(order, session, 'order_cancelled') : undefined;
      const next = await this.orderRepo.update({
        _id: id, status: 'pending_cancel', 'cancelRequest.requestId': requestId, 'cancelRequest.state': 'pending', pharmacyId: order.pharmacyId,
        ...(payment === undefined ? { paymentStatus: { $exists: false } } : { paymentStatus: payment }),
        prescriptionRefund: order.prescriptionRefund ? { $exists: true } : { $exists: false },
      }, { $set: { status: 'cancelled', 'cancelRequest.state': 'approved', 'cancelRequest.decidedByType': actor.userType,
        'cancelRequest.decidedById': String(actor._id), 'cancelRequest.decidedAt': new Date(),
        ...(note ? { 'cancelRequest.decisionNote': note } : {}), ...(intent ? { prescriptionRefund: intent } : {}) } },
      { new: true, session }) as IPharmacyOrder | null;
      if (!next) throw this.requestChanged();
      await this.releaseOrderInventory(String(next.pharmacyId), next.items, session);
      return { next, refundRequired };
    });
    let result = outcome.next;
    if (outcome.refundRequired) {
      await this.prescriptionRefundService.settleAfterRejection(id);
      result = (await this.orderRepo.findById(id) as IPharmacyOrder | null) ?? result;
    }
    await this.queueSubscriptionSyncSafely(id, 'status_changed');
    if (result.customerId) await this.queueNotificationSafely(id, 'status_changed');
    return result;
  }

  async rejectCancel(id: string, actor: CancelActor, data: { requestId?: string; note?: string }): Promise<IPharmacyOrder> {
    const requestId = typeof data.requestId === 'string' ? data.requestId : '';
    if (!/^[0-9a-f]{24}$/.test(requestId)) throw new AppError({ status: 400, code: 'VALIDATION_ERROR', message: 'requestId is required' });
    const note = typeof data.note === 'string' ? data.note.trim().slice(0, 500) : undefined;
    const next = await this.runOrderInventoryTransaction(async (session) => {
      const order = await this.orderRepo.findById(id, session) as IPharmacyOrder | null;
      if (!order) throw new AppError({ status: 404, code: 'ORDER_NOT_FOUND', message: 'Order not found' });
      this.assertCancelActor(order, actor, true);
      const request = order.cancelRequest;
      if (order.status !== 'pending_cancel' || request?.state !== 'pending' || request.requestId !== requestId) throw this.requestChanged();
      const payment = order.paymentStatus;
      // The payment was returned to the customer while the order was frozen: it can no longer resume - the
      // cancellation must be completed (approve releases its stock once, with no second refund).
      if (payment === 'refunded') {
        throw new AppError({ status: 409, code: 'CANCEL_MUST_COMPLETE',
          message: 'The payment for this order was already returned to the customer; approve the cancellation to complete it' });
      }
      // From the same fresh read: a capture recorded while frozen confirms a placed order (as the payment would have).
      const restored: OrderStatus = request.fromStatus === 'placed' && payment === 'paid' ? 'accepted' : request.fromStatus;
      const updated = await this.orderRepo.update({
        _id: id, status: 'pending_cancel', 'cancelRequest.requestId': requestId, 'cancelRequest.state': 'pending', pharmacyId: order.pharmacyId,
        ...(payment === undefined ? { paymentStatus: { $exists: false } } : { paymentStatus: payment }),
      }, { $set: { status: restored, 'cancelRequest.state': 'rejected', 'cancelRequest.decidedByType': actor.userType,
        'cancelRequest.decidedById': String(actor._id), 'cancelRequest.decidedAt': new Date(), 'cancelRequest.restoredStatus': restored,
        ...(note ? { 'cancelRequest.decisionNote': note } : {}) } }, { new: true, session }) as IPharmacyOrder | null;
      if (!updated) throw this.requestChanged();
      // P7: a refill capture recorded while frozen moves the subscription on now that the order resumes (idempotent).
      if (payment === 'paid') await advanceRefillOnPayment(updated, session);
      return updated;
    });
    await this.queueSubscriptionSyncSafely(id, 'status_changed');
    if (next.customerId) await this.queueNotificationSafely(id, 'status_changed');
    return next;
  }

  async markPaid(
    id: string,
    payload: {
      userType: string;
      pharmacyId?: string;
      userId: string;
      data: MarkOrderPaidRequest;
    }
  ): Promise<IPharmacyOrder> {
    const order = await this.orderRepo.findById(id);
    if (!order) {
      throw new AppError({ status: 404, code: 'ORDER_NOT_FOUND', message: 'Order not found' });
    }

    const isAdmin = payload.userType === 'admin';
    const isOwningPharmacy =
      payload.userType === 'pharmacy' && payload.pharmacyId && String(order.pharmacyId) === payload.pharmacyId;

    if (!isAdmin && !isOwningPharmacy) {
      throw new AppError({ status: 403, code: 'FORBIDDEN', message: 'Access denied' });
    }

    if (!order.paymentMode || !['cash_on_delivery', 'in_store_payment'].includes(order.paymentMode)) {
      throw new AppError({
        status: 400,
        code: 'MARK_PAID_NOT_ALLOWED',
        message: 'Only cash on delivery or in-store payment orders can be marked paid manually',
      });
    }

    if (order.paymentStatus === 'paid') {
      throw new AppError({
        status: 400,
        code: 'ORDER_ALREADY_PAID',
        message: 'This order is already marked as paid',
      });
    }

    if (order.paymentStatus === 'refunded') {
      throw new AppError({
        status: 400,
        code: 'ORDER_ALREADY_REFUNDED',
        message: 'A refunded order cannot be marked as paid',
      });
    }

    if (TERMINAL_STATUSES.includes(order.status)) {
      throw new AppError({
        status: 409,
        code: 'ORDER_TERMINAL',
        message: `A ${order.status} order cannot be marked as paid`,
      });
    }
    // D3: a frozen order is decided first (its status CAS below also fails if a request arrives meanwhile).
    if (order.status === 'pending_cancel') {
      throw new AppError({ status: 409, code: 'ORDER_CANCEL_PENDING', message: 'A cancellation is waiting for a decision; decide it first' });
    }

    // A pharmacist-approved prescription order is already reviewed; recording its cash/in-store payment is not new
    // prescription commerce. Every other order keeps the prospective-commerce gate.
    const pharmacistApproved = order.prescriptionStatus === 'approved' && order.prescriptionReview?.decision === 'approved';
    // P9: an order with prescription medicines is paid at the counter / on delivery only after the pharmacist approved
    // it (checked again at write time below), so a rejection never has to return cash that has no gateway record.
    const needsReview = order.prescriptionStatus !== 'not_required' || order.items.some((item) => item.prescriptionRequired === true);
    if (needsReview && !pharmacistApproved) {
      throw new AppError({ status: 409, code: 'PRESCRIPTION_REVIEW_REQUIRED', message: 'The pharmacist must approve the prescription before this order is paid' });
    }
    if (!pharmacistApproved) await this.assertNewCommerceForOrder(order, id);

    const paidAt =
      payload.data.paidDate && payload.data.paidTime
        ? new Date(
            `${payload.data.paidDate.slice(0, 4)}-${payload.data.paidDate.slice(4, 6)}-${payload.data.paidDate.slice(
              6,
              8
            )}T${payload.data.paidTime}:00`
          )
        : new Date();

    if (Number.isNaN(paidAt.getTime())) {
      throw new AppError({
        status: 400,
        code: 'INVALID_PAID_AT',
        message: 'Invalid payment date or time',
      });
    }

    const existingNotes = order.notes?.trim();
    const paymentNote = payload.data.notes?.trim();
    const mergedNotes = paymentNote ? (existingNotes ? `${existingNotes}\n${paymentNote}` : paymentNote) : order.notes;

    const updated = await this.orderRepo.update(
      {
        _id: id,
        paymentStatus: { $nin: ['paid', 'refunded'] },
        // Exact observed status: the write below derives status from this read, so a concurrent status change
        // (e.g. accepted -> packed) must fail the compare-and-set rather than be overwritten with a stale value.
        status: { $eq: order.status, $nin: TERMINAL_STATUSES },
        // P9: exactly the version checked (any edit, e.g. an OTC order changed to Rx, moves the revision) and its
        // prescription classification: approved for an order that needs review, unchanged otherwise.
        ...(order.revision === undefined || order.revision === 0 ? { revision: { $in: [null, 0] } } : { revision: order.revision }),
        ...(needsReview ? { prescriptionStatus: 'approved', 'prescriptionReview.decision': 'approved' }
          : { prescriptionStatus: order.prescriptionStatus ?? 'not_required' }),
      },
      {
        paymentStatus: 'paid',
        paymentSource: payload.data.paymentSource?.trim() || order.paymentMode,
        paidAt,
        status: order.status === 'placed' ? 'accepted' : order.status,
        ...(mergedNotes !== undefined ? { notes: mergedNotes } : {}),
      }
    );

    if (!updated) {
      throw new AppError({
        status: 409,
        code: 'ORDER_PAYMENT_STATE_CHANGED',
        message: 'Order payment state changed while this request was being processed',
      });
    }

    await this.queueSubscriptionSyncSafely(id, 'order_marked_paid');
    if (updated.customerId) {
      await this.queueNotificationSafely(id, 'order_marked_paid');
    }

    return updated;
  }

  async linkHealthCheck(orderId: string, healthCheckId: string): Promise<void> {
    await this.orderRepo.update({ _id: orderId }, { linkedHealthCheckId: healthCheckId });
  }

  async abandonStaleUnpaidOrders(): Promise<void> {
    const cutoff = new Date(Date.now() - UNPAID_ORDER_ABANDON_WINDOW_MS);
    const staleOrders = await this.orderRepo.findStalePendingOnlineOrders(cutoff);

    for (const order of staleOrders) {
      const priorNotes = order.notes?.trim();
      const timeoutNote = 'Order auto-abandoned after 35 minutes because payment was not completed in time';
      const inventoryItems = this.buildInventoryItems(
        order.items.filter((item) => item.itemStatus === 'active')
      );

      const markedAbandoned = await this.runOrderInventoryTransaction(async (session) => {
        const nextOrder = await this.orderRepo.update(
          { _id: order._id, status: 'placed', paymentStatus: 'pending' },
          {
            status: 'abandoned',
            notes: priorNotes ? `${priorNotes}\n${timeoutNote}` : timeoutNote,
          },
          { new: true, session }
        );

        if (!nextOrder) {
          return null;
        }

        if (inventoryItems.length) {
          await this.releaseOrderInventory(String(order.pharmacyId), nextOrder.items, session);
        }

        return nextOrder;
      });

      if (!markedAbandoned) {
        continue;
      }

      await this.queueSubscriptionSyncSafely(String(order._id), 'order_abandoned');
      if (markedAbandoned.customerId) {
        await this.queueNotificationSafely(String(order._id), 'order_abandoned');
      }
    }
  }
}
