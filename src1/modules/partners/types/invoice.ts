export type DocumentKind = 'tax_invoice' | 'bill_of_supply' | 'commercial_invoice';
export type InvoiceLifecycleState = 'issued' | 'paid' | 'cancelled';
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
  items: IInvoiceLine[];
  totals: IInvoiceTotals;
  lifecycleState: InvoiceLifecycleState;
  lifecycleVersion: number;
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
