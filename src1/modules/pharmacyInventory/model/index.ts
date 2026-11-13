import { Schema, model, Model } from 'mongoose';
import {
  IInventoryItem,
  IInventoryAdjustment,
  IInventoryReservation,
} from '@/modules/pharmacyInventory/types';

const inventoryBatchSchema = new Schema(
  {
    batchNumber: { type: String, required: true, trim: true },
    expiryDate: { type: String, required: true, match: /^\d{8}$/, index: true },
    receivedAt: { type: Date, required: true, default: Date.now },
    availableQty: { type: Number, required: true, min: 0, default: 0 },
    reservedQty: { type: Number, required: true, min: 0, default: 0 },
    freeQty: { type: Number, required: true, min: 0, default: 0 },
    purchasePrice: { type: Number, min: 0 },
    mrp: { type: Number, min: 0 },
    retailPrice: { type: Number, min: 0 },
    wholesalePrice: { type: Number, min: 0 },
    status: {
      type: String,
      enum: ['active', 'depleted', 'expired', 'recalled', 'quarantined'],
      default: 'active',
      index: true,
    },
    depletedAt: { type: Date },
    // Quality hold (P3): why/when/who put the batch in quarantine; cleared on release.
    holdId: { type: String },
    holdReason: { type: String, trim: true, maxlength: 500 },
    heldAt: { type: Date },
    heldBy: { type: String },
  },
  { _id: true }
);

const inventoryItemSchema = new Schema<IInventoryItem>(
  {
    pharmacyId: {
      type: Schema.Types.ObjectId as any,
      ref: 'Pharmacy',
      required: true,
      index: true,
    },
    medicineId: {
      type: Schema.Types.ObjectId as any,
      ref: 'Medicine',
      required: true,
      index: true,
    },
    availableQty: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    reservedQty: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    freeQty: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    batches: {
      type: [inventoryBatchSchema],
      default: [],
    },
    // Set when the pharmacy was notified of this item's current drop below reorderThreshold (P7c).
    lowStockNotifiedAt: { type: Date },
    reorderThreshold: {
      type: Number,
      min: 0,
      default: 0,
    },
    rackLocation: {
      type: String,
      trim: true,
    },
    purchasePrice: {
      type: Number,
      min: 0,
    },
    retailPrice: {
      type: Number,
      min: 0,
    },
    wholesalePrice: {
      type: Number,
      min: 0,
    },
    batchNumber: {
      type: String,
      trim: true,
    },
    expiryDate: {
      type: String,
      match: /^\d{8}$/,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
  },
  { timestamps: true }
);

inventoryItemSchema.index({ pharmacyId: 1, medicineId: 1 }, { unique: true });
inventoryItemSchema.index({ pharmacyId: 1, isActive: 1 });
inventoryItemSchema.index({ pharmacyId: 1, availableQty: 1 });

const inventoryAdjustmentSchema = new Schema<IInventoryAdjustment>(
  {
    pharmacyId: {
      type: Schema.Types.ObjectId as any,
      ref: 'Pharmacy',
      required: true,
      index: true,
    },
    medicineId: {
      type: Schema.Types.ObjectId as any,
      ref: 'Medicine',
      required: true,
    },
    inventoryItemId: {
      type: Schema.Types.ObjectId as any,
      ref: 'InventoryItem',
      required: true,
      index: true,
    },
    adjustmentType: {
      type: String,
      enum: ['add', 'remove', 'correction'],
      required: true,
    },
    quantity: {
      type: Number,
      required: true,
    },
    batchId: { type: Schema.Types.ObjectId as any },
    batchNumber: { type: String, trim: true },
    expiryDate: { type: String, match: /^\d{8}$/ },
    availableQtyBefore: { type: Number, min: 0 },
    availableQtyAfter: { type: Number, min: 0 },
    sourceType: {
      type: String,
      enum: ['manual', 'inventory_import', 'order'],
      default: 'manual',
      index: true,
    },
    sourceId: { type: String, trim: true, index: true },
    sourceRowIndex: { type: Number },
    reason: {
      type: String,
      enum: ['purchase', 'return', 'damage', 'expiry', 'correction', 'transfer', 'other'],
      required: true,
    },
    notes: {
      type: String,
      trim: true,
    },
    adjustedBy: {
      type: Schema.Types.ObjectId as any,
      ref: 'User',
      required: true,
    },
    adjustedByRole: {
      type: String,
      required: true,
      trim: true,
    },
  },
  { timestamps: true }
);

inventoryAdjustmentSchema.index({ pharmacyId: 1, createdAt: -1 });
inventoryAdjustmentSchema.index(
  { pharmacyId: 1, sourceType: 1, sourceId: 1, sourceRowIndex: 1 },
  {
    unique: true,
    partialFilterExpression: {
      sourceId: { $exists: true, $type: 'string' },
      sourceRowIndex: { $exists: true, $type: 'number' },
    },
  }
);

const inventoryReservationSchema = new Schema<IInventoryReservation>(
  {
    pharmacyId: {
      type: Schema.Types.ObjectId as any,
      ref: 'Pharmacy',
      required: true,
      index: true,
    },
    medicineId: {
      type: Schema.Types.ObjectId as any,
      ref: 'Medicine',
      required: true,
      index: true,
    },
    orderId: {
      type: Schema.Types.ObjectId as any,
      ref: 'PharmacyOrder',
      index: true,
    },
    reservationType: {
      type: String,
      enum: ['order', 'manual'],
      required: true,
      index: true,
    },
    quantity: {
      type: Number,
      required: true,
      min: 1,
    },
    remainingQty: {
      type: Number,
      required: true,
      min: 0,
    },
    consumedQty: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    releasedQty: {
      type: Number,
      required: true,
      min: 0,
      default: 0,
    },
    reason: {
      type: String,
      trim: true,
    },
    notes: {
      type: String,
      trim: true,
    },
    createdBy: {
      type: Schema.Types.ObjectId as any,
      ref: 'User',
    },
    createdByRole: {
      type: String,
      trim: true,
    },
    status: {
      type: String,
      enum: ['active', 'closed'],
      required: true,
      default: 'active',
      index: true,
    },
  },
  { timestamps: true }
);

inventoryReservationSchema.index({ pharmacyId: 1, reservationType: 1, status: 1, createdAt: 1 });
inventoryReservationSchema.index({ orderId: 1, status: 1, createdAt: 1 });
inventoryReservationSchema.index({ pharmacyId: 1, medicineId: 1, status: 1, createdAt: 1 });

export const InventoryItemModel: Model<IInventoryItem> = model<IInventoryItem>(
  'InventoryItem',
  inventoryItemSchema
);

export const InventoryAdjustmentModel: Model<IInventoryAdjustment> = model<IInventoryAdjustment>(
  'InventoryAdjustment',
  inventoryAdjustmentSchema
);

export const InventoryReservationModel: Model<IInventoryReservation> = model<IInventoryReservation>(
  'InventoryReservation',
  inventoryReservationSchema
);
