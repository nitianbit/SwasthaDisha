import { Schema, model, Model } from 'mongoose';
import { IPharmacyOrder } from '@/modules/pharmacyOrders/types';

const batchAllocationSchema = new Schema(
  {
    batchId: { type: Schema.Types.ObjectId as any, required: true },
    batchNumber: { type: String, required: true, trim: true },
    expiryDate: { type: String, required: true, match: /^\d{8}$/ },
    quantity: { type: Number, required: true, min: 1 },
  },
  { _id: false }
);

const orderItemSchema = new Schema(
  {
    medicineId: { type: Schema.Types.ObjectId as any, ref: 'Medicine', required: true },
    medicineName: { type: String, trim: true },
    orderedQty: { type: Number, required: true, min: 1 },
    reservedQty: { type: Number, default: 0, min: 0 },
    billedQty: { type: Number, default: 0, min: 0 },
    freeQty: { type: Number, default: 0, min: 0 },
    unitPrice: { type: Number, required: true, min: 0 },
    discount: { type: Number, default: 0, min: 0 },
    lineTotal: { type: Number, required: true, min: 0 },
    hsnCode: { type: String, trim: true },
    gstPercent: { type: Number, min: 0, max: 100 },
    taxAmount: { type: Number, min: 0 },
    unitPricePaise: { type: Number, min: 0 },
    discountPaise: { type: Number, min: 0 },
    taxPaise: { type: Number, min: 0 },
    lineTotalPaise: { type: Number, min: 0 },
    prescriptionRequired: { type: Boolean, default: false },
    batchAllocations: { type: [batchAllocationSchema], default: [] },
    recurring: { type: Boolean, default: false },
    subscriptionFrequency: { type: String, trim: true },
    subscriptionIntervalDays: { type: Number, min: 1 },
    subscriptionNextRefillDate: { type: String, match: /^\d{8}$/ },
    subscriptionReminderChannel: {
      type: String,
      enum: ['sms', 'push', 'both', 'none'],
    },
    itemStatus: {
      type: String,
      enum: ['active', 'replaced', 'removed'],
      default: 'active',
    },
  },
  { _id: false }
);

const sideEffectStateSchema = new Schema(
  {
    status: {
      type: String,
      enum: ['pending', 'success', 'failed'],
      required: true,
    },
    lastError: { type: String, trim: true },
    updatedAt: { type: Date },
  },
  { _id: false }
);

const pharmacyOrderSchema = new Schema<IPharmacyOrder>(
  {
    orderNumber: { type: String, trim: true, sparse: true, index: true },
    pharmacyId: { type: Schema.Types.ObjectId as any, ref: 'Pharmacy', required: true, index: true },
    orderType: {
      type: String,
      enum: ['in_store', 'online'],
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: [
        'placed', 'accepted', 'packed',
        'ready_for_pickup', 'out_for_delivery',
        'completed', 'abandoned', 'cancelled', 'rejected',
      ],
      default: 'placed',
      index: true,
    },
    customerId: { type: Schema.Types.ObjectId as any, ref: 'User', index: true },
    buyerPharmacyId: { type: Schema.Types.ObjectId as any, ref: 'Pharmacy', index: true },
    createdById: { type: Schema.Types.ObjectId as any, required: true },
    createdByRole: { type: String, required: true, trim: true },
    items: { type: [orderItemSchema], default: [] },
    subtotal: { type: Number, min: 0 },
    discountTotal: { type: Number, min: 0, default: 0 },
    taxTotal: { type: Number, min: 0, default: 0 },
    grandTotal: { type: Number, min: 0 },
    subtotalPaise: { type: Number, min: 0 },
    discountTotalPaise: { type: Number, min: 0 },
    taxTotalPaise: { type: Number, min: 0 },
    grandTotalPaise: { type: Number, min: 0 },
    paymentMode: {
      type: String,
      enum: ['online_payment', 'in_store_payment', 'cash_on_delivery'],
    },
    paymentStatus: {
      type: String,
      enum: ['pending', 'authorized', 'paid', 'failed', 'refunded', 'partially_paid'],
      default: 'pending',
      index: true,
    },
    paymentSource: { type: String, trim: true },
    paymentTransactionId: { type: String, trim: true },
    paidAt: { type: Date },
    sideEffects: {
      subscriptionSync: { type: sideEffectStateSchema },
      notification: { type: sideEffectStateSchema },
    },
    deliveryMode: { type: String, enum: ['pickup', 'delivery'] },
    deliveryAddress: { type: String, trim: true },
    isWalkIn: { type: Boolean, default: false },
    prescriptionUrls: { type: [String], default: [] },
    prescriptionStatus: {
      type: String,
      enum: ['not_required', 'pending', 'approved', 'rejected'],
      default: 'not_required',
      index: true,
    },
    notes: { type: String, trim: true },
    linkedConsultationId: { type: Schema.Types.ObjectId as any, ref: 'Booking', index: true },
    linkedDiagnosticOrderId: { type: String, index: true },
    linkedHealthCheckId: { type: Schema.Types.ObjectId as any, ref: 'OrderHealthCheck' },
  },
  { timestamps: true }
);

pharmacyOrderSchema.index({ pharmacyId: 1, status: 1 });
pharmacyOrderSchema.index({ pharmacyId: 1, orderType: 1 });
pharmacyOrderSchema.index({ customerId: 1, status: 1 });
pharmacyOrderSchema.index({ pharmacyId: 1, createdAt: -1 });

const PharmacyOrderModel: Model<IPharmacyOrder> = model<IPharmacyOrder>(
  'PharmacyOrder',
  pharmacyOrderSchema
);

export default PharmacyOrderModel;
