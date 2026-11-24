export type DocumentKind = 'tax_invoice' | 'bill_of_supply' | 'commercial_invoice';
/** Q14: 'partly_paid' — some payments recorded, an amount still due (only where the partner allows part payments). */
export type InvoiceLifecycleState = 'issued' | 'partly_paid' | 'paid' | 'cancelled';
export type InvoiceEventKind = 'payment' | 'cancellation';
export type PaymentMode = 'cash' | 'upi' | 'card' | 'bank' | 'other';

export interface IInvoiceSupplier {
  name: string;
  legalName?: string;
  gstin?: string;
  pan?: string;
  address: string;
  /** Two-digit GST state code of the issuing branch. */
  placeOfSupply: string;
}

export interface IInvoiceCustomer {
  name: string;
  phone?: string;
  userId?: string;
  gstin?: string;
  age?: number;
  gender?: string;
  placeOfSupply?: string;
}

export interface IInvoiceLine {
  catalogItemId?: string;
  description: string;
  hsn?: string;
  sac?: string;
  qty: number;
  unitPriceMinor: number;
  discountMinor: number;
  gstRate: 0 | 5 | 12 | 18 | 28;
  amountMinor: number;
}

export interface IInvoiceTotals {
  subtotalMinor: number;
  discountMinor: number;
  taxableMinor: number;
  cgstMinor: number;
  sgstMinor: number;
  igstMinor: number;
  totalMinor: number;
  currency: 'INR';
}

export interface IInvoice {
  _id?: string;
  partnerId: string;
  branchId: string;
  number: number;
  financialYear: string;
  serial: string;
  documentKind: DocumentKind;
  issuedAt: Date;
  supplier: IInvoiceSupplier;
  customer: IInvoiceCustomer;
  doctorId?: string;
  /** Q14: the clinic appointment (booking id, lower-case hex) this bill is for; part of the document and its checksum. */
  appointmentId?: string;
  /**
   * Q14: equals appointmentId while the bill is not cancelled (unset by the cancellation), so at most one open bill per
   * appointment (unique partial index). Bookkeeping only: not part of the checksum.
   */
  openAppointmentId?: string;
  /** r12 (§24.6.3): the lab desk booking (lower-case hex) this bill is for; part of the document and its checksum when set. */
  labBookingId?: string;
  /** r12: equals labBookingId while the bill is not cancelled (unique partial index): at most one open bill per lab booking. */
  openLabBookingId?: string;
  items: IInvoiceLine[];
  totals: IInvoiceTotals;
  lifecycleState: InvoiceLifecycleState;
  lifecycleVersion: number;
  /** Q14: total of the payments recorded (paise). Absent on bills paid before Q14: read as the total when paid, else 0. */
  paidMinor?: number;
  /** Q14 (reads only, never stored): the amount still due. */
  dueMinor?: number;
  createdBy: string;
  checksum: string;
  idempotencyKey: string;
  /** Hash of the request that created the invoice: a reused key with a different request is refused. */
  requestHash: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IInvoiceEvent {
  _id?: string;
  invoiceId: string;
  kind: InvoiceEventKind;
  mode?: PaymentMode;
  reference?: string;
  reason?: string;
  note?: string;
  /** Q10: for the cancellation of a paid bill — how the money was returned (Q14: amountMinor = the amount paid). */
  refund?: { mode: PaymentMode; reference?: string; note?: string; amountMinor?: number };
  /** Q14: a payment's amount and its methods (one or several, e.g. cash + UPI). Absent on pre-Q14 payments (full total). */
  amountMinor?: number;
  splits?: { mode: PaymentMode; amountMinor: number; reference?: string }[];
  /** Q14: the payment's request key and content hash (replay answers with this event). */
  requestKey?: string;
  requestHash?: string;
  /** The invoice's lifecycleVersion this event produced (1, 2): the event order, independent of clocks. */
  version: number;
  at: Date;
  by: string;
  byKind: 'member' | 'admin';
  createdAt?: Date;
}

export interface IInvoiceCounter {
  _id?: string;
  partnerId: string;
  financialYear: string;
  seq: number;
}
