import { Schema, model, Model } from 'mongoose';
import { IInvoice, IInvoiceEvent, IInvoiceCounter } from '@/modules/partners/types';

const invoiceLineSchema = new Schema(
  {
    catalogItemId: { type: String },
    description: { type: String, required: true, trim: true },
    hsn: { type: String, trim: true },
    sac: { type: String, trim: true },
    qty: { type: Number, required: true, min: 1 },
    unitPriceMinor: { type: Number, required: true, min: 0 },
    discountMinor: { type: Number, required: true, default: 0, min: 0 },
    gstRate: { type: Number, required: true, enum: [0, 5, 12, 18, 28] },
    amountMinor: { type: Number, required: true },
  },
  { _id: false }
);

const invoiceSchema = new Schema<IInvoice>(
  {
    partnerId: { type: String, required: true, index: true },
    branchId: { type: String, required: true },
    number: { type: Number, required: true },
    financialYear: { type: String, required: true },
    serial: { type: String, required: true },
    documentKind: {
      type: String,
      required: true,
      enum: ['tax_invoice', 'bill_of_supply', 'commercial_invoice'],
    },
    issuedAt: { type: Date, required: true },
    supplier: {
      name: { type: String, required: true, trim: true },
      legalName: { type: String, trim: true },
      gstin: { type: String, trim: true },
      pan: { type: String, trim: true },
      address: { type: String, required: true, trim: true },
      placeOfSupply: { type: String, required: true, trim: true },
    },
    customer: {
      name: { type: String, required: true, trim: true },
      phone: { type: String, trim: true },
      userId: { type: String },
      gstin: { type: String, trim: true },
      age: { type: Number },
      gender: { type: String, trim: true },
      placeOfSupply: { type: String, trim: true },
    },
    doctorId: { type: String },
    items: { type: [invoiceLineSchema], required: true },
    totals: {
      subtotalMinor: { type: Number, required: true },
      discountMinor: { type: Number, required: true },
      taxableMinor: { type: Number, required: true },
      cgstMinor: { type: Number, required: true },
      sgstMinor: { type: Number, required: true },
      igstMinor: { type: Number, required: true },
      totalMinor: { type: Number, required: true },
      currency: { type: String, required: true, default: 'INR' },
    },
    lifecycleState: {
      type: String,
      required: true,
      enum: ['issued', 'paid', 'cancelled'],
      default: 'issued',
    },
    lifecycleVersion: { type: Number, required: true, default: 0 },
    createdBy: { type: String, required: true },
    checksum: { type: String, required: true },
    idempotencyKey: { type: String, required: true },
    requestHash: { type: String, required: true },
  },
  { timestamps: true }
);

invoiceSchema.index({ partnerId: 1, financialYear: 1, number: 1 }, { unique: true });
invoiceSchema.index({ partnerId: 1, idempotencyKey: 1 }, { unique: true });
invoiceSchema.index({ partnerId: 1, lifecycleState: 1, issuedAt: -1 });
invoiceSchema.index({ partnerId: 1, branchId: 1, issuedAt: -1 });
invoiceSchema.index({ 'customer.userId': 1, issuedAt: -1 });
invoiceSchema.index({ 'customer.phone': 1, lifecycleState: 1 });

export const InvoiceModel: Model<IInvoice> = model<IInvoice>('PartnerInvoice', invoiceSchema, 'partner_invoices');

// ── InvoiceEvent ──

const invoiceEventSchema = new Schema<IInvoiceEvent>(
  {
    invoiceId: { type: String, required: true, index: true },
    kind: { type: String, required: true, enum: ['payment', 'cancellation'] },
    mode: { type: String, enum: ['cash', 'upi', 'card', 'bank', 'other'] },
    reference: { type: String, trim: true },
    reason: { type: String, trim: true },
    note: { type: String, trim: true },
    version: { type: Number, required: true, min: 1 },
    at: { type: Date, required: true },
    by: { type: String, required: true },
    byKind: { type: String, required: true, enum: ['member', 'admin'] },
  },
  { timestamps: true }
);

invoiceEventSchema.index({ invoiceId: 1, kind: 1 }, { unique: true });
invoiceEventSchema.index({ invoiceId: 1, version: 1 }, { unique: true });

export const InvoiceEventModel: Model<IInvoiceEvent> = model<IInvoiceEvent>('PartnerInvoiceEvent', invoiceEventSchema, 'partner_invoice_events');

// ── InvoiceCounter ──

const invoiceCounterSchema = new Schema<IInvoiceCounter>(
  {
    partnerId: { type: String, required: true },
    financialYear: { type: String, required: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { timestamps: true }
);

invoiceCounterSchema.index({ partnerId: 1, financialYear: 1 }, { unique: true });

export const InvoiceCounterModel: Model<IInvoiceCounter> = model<IInvoiceCounter>('PartnerInvoiceCounter', invoiceCounterSchema, 'partner_invoice_counters');
