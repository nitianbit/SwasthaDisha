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
    // r42 (§26.25): no default — an absent value is taxable and keeps earlier bills (and their checksums) as they were.
    taxTreatment: { type: String, enum: ['taxable', 'exempt'] },
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
    // Q14: the appointment this bill is for; openAppointmentId is set only while the bill is not cancelled.
    appointmentId: { type: String },
    openAppointmentId: { type: String },
    // r12 (§24.6.3): the lab desk booking this bill is for; openLabBookingId is set only while the bill is not cancelled.
    labBookingId: { type: String },
    openLabBookingId: { type: String },
    items: { type: [invoiceLineSchema], required: true },
    totals: {
      subtotalMinor: { type: Number, required: true },
      discountMinor: { type: Number, required: true },
      taxableMinor: { type: Number, required: true },
      exemptMinor: { type: Number },
      cgstMinor: { type: Number, required: true },
      sgstMinor: { type: Number, required: true },
      igstMinor: { type: Number, required: true },
      totalMinor: { type: Number, required: true },
      currency: { type: String, required: true, default: 'INR' },
    },
    lifecycleState: {
      type: String,
      required: true,
      enum: ['issued', 'partly_paid', 'paid', 'cancelled'],
      default: 'issued',
    },
    lifecycleVersion: { type: Number, required: true, default: 0 },
    // Q14: payments recorded so far (paise); absent on pre-Q14 bills (paid = the total).
    paidMinor: { type: Number, min: 0 },
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
// r38b (§26.22): the lab's Today register finds earlier bills changed on a day (a payment or a cancellation that day).
invoiceSchema.index({ partnerId: 1, updatedAt: 1 });
invoiceSchema.index({ partnerId: 1, branchId: 1, issuedAt: -1 });
invoiceSchema.index({ 'customer.userId': 1, issuedAt: -1 });
invoiceSchema.index({ 'customer.phone': 1, lifecycleState: 1 });
// Q14: one open (issued or paid) bill per appointment; bills of an appointment are listed by partner.
invoiceSchema.index({ openAppointmentId: 1 }, { unique: true, partialFilterExpression: { openAppointmentId: { $type: 'string' } } });
invoiceSchema.index({ partnerId: 1, appointmentId: 1, issuedAt: -1 }, { partialFilterExpression: { appointmentId: { $type: 'string' } } });
// r12 (§24.6.1): one open bill per lab desk booking; the bills of a lab booking by partner.
invoiceSchema.index({ openLabBookingId: 1 }, { unique: true, partialFilterExpression: { openLabBookingId: { $type: 'string' } } });
invoiceSchema.index({ partnerId: 1, labBookingId: 1, issuedAt: -1 }, { partialFilterExpression: { labBookingId: { $type: 'string' } } });

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
    // Q10: how the money of a cancelled paid bill went back.
    refund: {
      type: new Schema({ mode: { type: String, required: true, enum: ['cash', 'upi', 'card', 'bank', 'other'] },
        reference: { type: String, trim: true }, note: { type: String, trim: true }, amountMinor: { type: Number, min: 0 } }, { _id: false }),
      default: undefined,
    },
    // Q14: a payment's amount, its methods, and its request identity.
    amountMinor: { type: Number, min: 0 },
    splits: {
      type: [new Schema({ mode: { type: String, required: true, enum: ['cash', 'upi', 'card', 'bank', 'other'] },
        amountMinor: { type: Number, required: true, min: 1 }, reference: { type: String, trim: true } }, { _id: false })],
      default: undefined,
    },
    requestKey: { type: String },
    requestHash: { type: String },
    version: { type: Number, required: true, min: 1 },
    at: { type: Date, required: true },
    by: { type: String, required: true },
    byKind: { type: String, required: true, enum: ['member', 'admin'] },
  },
  { timestamps: true }
);

// Q14: a bill has many payments but at most one cancellation; a payment request key is used once per bill.
invoiceEventSchema.index({ invoiceId: 1, kind: 1 }, { name: 'q14_one_cancellation', unique: true, partialFilterExpression: { kind: 'cancellation' } });
invoiceEventSchema.index({ invoiceId: 1, requestKey: 1 }, { name: 'q14_payment_request_key', unique: true, partialFilterExpression: { requestKey: { $type: 'string' } } });
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
