import { unpaidCardBooking } from '@/modules/assisted/views';
import { claimRequestKey, abandonRequestKey } from '@/modules/requestKeys';
import { InvoiceModel, InvoiceEventModel } from '@/modules/partners/model/invoice';
import PartnerModel from '@/modules/partners/model';
import { Service } from 'typedi';
import { createHash } from 'crypto';
import mongoose from 'mongoose';
import { InvoiceRepository, InvoiceEventRepository, InvoiceCounterRepository } from '@/modules/partners/repository/invoice';
import { PartnerRepository } from '@/modules/partners/repository';
import { BranchRepository } from '@/modules/partners/repository/branch';
import { CatalogueItemRepository } from '@/modules/partners/repository/catalogueItem';
import MemberModel from '@/modules/partners/model/member';
import {
  IInvoice,
  IInvoiceEvent,
  IInvoiceLine,
  IInvoiceTotals,
  IInvoiceSupplier,
  IInvoiceCustomer,
  DocumentKind,
  TaxTreatment,
  PaymentMode,
  InvoiceLifecycleState,
  IPartner,
} from '@/modules/partners/types';
import { AppError } from '@/modules/common/types';
import { resolveCustomerByPhone, normalizePhone } from '@/modules/partners/services/customerResolver';
import { PartnerActor, assertBranchInScope, hasGlobalScope, recordPartnerAudit } from '@/modules/partners/services';
import { SMSService } from '@/modules/sms/services';
import { CONFIG } from '@/config/config';
import { renderInvoicePdf } from '@/modules/partners/services/invoicePdf';
import SpecialistModel from '@/modules/specialists/model';
import BookingModel from '@/modules/bookings/model';
import UserModel from '@/modules/user/model';
import { IBooking } from '@/modules/bookings/types';
import { PartnerLabBookingModel, type IPartnerLabBooking } from '@/modules/partners/model/labBooking';
import { assertUniqueIndex } from '@/modules/common/utils/requiredIndex';

/** Q10: request-key scope of partner bills (claim/abandon). */
export const invoiceKeyScope = (partnerId: string) => `partner_invoice_create:${String(partnerId).toLowerCase()}`;

/** Q9: display names of the doctors named on invoices (not part of the immutable document or its checksum). */
export async function doctorNames(rows: { doctorId?: string }[]): Promise<Record<string, string>> {
  const ids = [...new Set(rows.map((r) => r.doctorId).filter((d): d is string => !!d && /^[0-9a-fA-F]{24}$/.test(d)))];
  if (!ids.length) return {};
  const sps = await SpecialistModel.find({ _id: { $in: ids } }).select({ name: 1 }).lean() as { _id: unknown; name?: string }[];
  const byId = Object.fromEntries(sps.filter((s) => s.name).map((s) => [String(s._id).toLowerCase(), String(s.name)]));
  // Keys in any letter case the invoices carry (ids are case-insensitive hex; the stored invoice is never rewritten).
  return Object.fromEntries(rows.map((r) => r.doctorId).filter((d): d is string => !!d && !!byId[d.toLowerCase()]).map((d) => [d, byId[d.toLowerCase()]!]));
}

export type GstRate = 0 | 5 | 12 | 18 | 28;

export interface CreateInvoiceInput {
  branchId: string;
  customer: { name: string; phone?: string; gstin?: string; age?: number; gender?: string; placeOfSupply?: string };
  doctorId?: string;
  /** Q14: the clinic appointment (booking id) this bill is for. */
  appointmentId?: string;
  /** r12 (§24.6.3): the lab desk booking this bill is for (not together with appointmentId). */
  labBookingId?: string;
  items: { catalogItemId?: string; description: string; hsn?: string; sac?: string; qty: number; unitPriceMinor: number; discountMinor?: number; gstRate: GstRate; taxTreatment?: TaxTreatment }[];
  idempotencyKey: string;
}

const invoiceNotFound = () => new AppError({ status: 404, code: 'INVOICE_NOT_FOUND', message: 'Invoice not found' });
/**
 * Q14 / r12: what a bill can be linked to — a clinic appointment, or a lab desk booking — with at most one open
 * (issued or paid) bill each, held by the unique partial index on the `open` field while the bill is not cancelled.
 */
const BILL_LINKS = {
  appointment: { code: 'APPOINTMENT', noun: 'appointment', field: 'appointmentId', open: 'openAppointmentId' },
  lab_booking: { code: 'LAB_BOOKING', noun: 'lab booking', field: 'labBookingId', open: 'openLabBookingId' },
} as const;
type BillLink = keyof typeof BILL_LINKS;
const alreadyBilled = (k: BillLink) => new AppError({ status: 409, code: `${BILL_LINKS[k].code}_ALREADY_BILLED`,
  message: `This ${BILL_LINKS[k].noun} already has a bill; cancel it first to issue a new one` });
/**
 * Q14: what a bill has been paid. Bills paid before Q14 carry no paidMinor: with their events, each pre-Q14 payment
 * counts as the full total; without them, a paid bill counts as fully paid (a cancelled one as 0).
 */
export function paidOf(inv: Pick<IInvoice, 'paidMinor' | 'lifecycleState' | 'totals'>, events?: IInvoiceEvent[]): number {
  if (typeof inv.paidMinor === 'number') return inv.paidMinor;
  if (events) return events.filter((e) => e.kind === 'payment').reduce((n, e) => n + (typeof e.amountMinor === 'number' ? e.amountMinor : inv.totals.totalMinor), 0);
  return inv.lifecycleState === 'paid' ? inv.totals.totalMinor : 0;
}
/**
 * r38: the bills a member may see — its partner's, at the branches in its scope (or the one named, checked in scope).
 * The one filter of the bill lists and the lab's Today register.
 */
export function invoicesScope(actor: PartnerActor, branchId?: string): Record<string, unknown> {
  const q: Record<string, unknown> = { partnerId: actor.partnerId };
  if (branchId) { assertBranchInScope(actor, branchId); q.branchId = branchId; }
  else if (!hasGlobalScope(actor)) q.branchId = { $in: actor.branchIds };
  return q;
}
/** r38: a payment's parts by method — its splits (Q14), or its one method for its amount (before Q14: the whole bill). */
export const paymentSplitsOf = (e: Pick<IInvoiceEvent, 'splits' | 'mode' | 'amountMinor' | 'reference'>, totalMinor: number) =>
  (e.splits?.length ? e.splits : [{ mode: e.mode, amountMinor: typeof e.amountMinor === 'number' ? e.amountMinor : totalMinor, reference: e.reference }]);
/** Q14: a bill as read: its paid and due amounts (a cancelled bill has nothing due). */
export function withDue<T extends IInvoice>(inv: T, events?: IInvoiceEvent[]): T {
  const paid = paidOf(inv, events);
  return { ...inv, paidMinor: paid, dueMinor: inv.lifecycleState === 'cancelled' ? 0 : Math.max(0, inv.totals.totalMinor - paid) };
}
export type PaymentSplit = { mode: PaymentMode; amountMinor: number; reference?: string };
export interface RecordPaymentInput {
  /** Pre-Q14 form: one method for the whole remaining amount. */
  mode?: PaymentMode; reference?: string; note?: string;
  /** Q14: one or several methods (e.g. cash + UPI); their sum is the payment. */
  splits?: PaymentSplit[];
  /** Q14: required for a part payment; the same key and request answer with the recorded payment. */
  requestKey?: string;
  /** Q14: the bill's lifecycleVersion the cashier decided on (409 LIFECYCLE_VERSION_CONFLICT otherwise). */
  expectedLifecycleVersion?: number;
}
/**
 * Q14 review: the unique `{invoiceId, kind}` index of the events before Q14 (one payment per bill). `sync-indexes` drops
 * it; until then a second payment collides on it. The Q14 cancellation index has the same keys but covers only
 * cancellations, so a duplicate on a payment event (or under the old name) is the old index.
 */
const PRE_Q14_EVENT_INDEX = 'invoiceId_1_kind_1';
function fromPreQ14PaymentIndex(error: any): boolean {
  if (typeof error?.message === 'string' && error.message.includes(`index: ${PRE_Q14_EVENT_INDEX} `)) return true;
  const kp = error?.keyPattern;
  return !!kp && Object.keys(kp).length === 2 && kp.invoiceId === 1 && kp.kind === 1 && error?.keyValue?.kind === 'payment';
}
const paymentKeyScope = (invoiceId: string) => `invoice_payment:${String(invoiceId).toLowerCase()}`;
const lowerId = (v?: unknown) => (v === undefined || v === null ? undefined : String(v).toLowerCase());

/** Q14 / r12: the linked record must take place at the bill's branch. */
function assertLinkBranch(k: BillLink, at: unknown, billBranchId: string): void {
  if (String(at) !== String(billBranchId)) {
    throw new AppError({ status: 400, code: `${BILL_LINKS[k].code}_BRANCH_MISMATCH`, message: `Bill the ${BILL_LINKS[k].noun} from the branch where it takes place` });
  }
}

/**
 * Q14 / r12: the checks every link shares, after the record was admitted. The bill's customer (the account of its phone
 * number) is the record's account holder (a family member's booking belongs to the account holder; a bill without
 * that customer cannot name it); the record is not cancelled; no other bill of it is open.
 */
async function assertLinkable(k: BillLink, id: string, rec: { userId?: unknown; status?: string }, customerUserId: string | null | undefined,
  session?: mongoose.ClientSession): Promise<string> {
  const { code, noun, open } = BILL_LINKS[k];
  if (!customerUserId || lowerId(customerUserId) !== lowerId(rec.userId)) {
    throw new AppError({ status: 409, code: `${code}_CUSTOMER_MISMATCH`, message: `Bill the ${noun} to its patient's account: enter the mobile number it was booked with` });
  }
  if (rec.status === 'cancelled') throw new AppError({ status: 409, code: `${code}_CANCELLED`, message: `A cancelled ${noun} cannot be billed` });
  if (await InvoiceModel.exists({ [open]: id }).session(session ?? null)) throw alreadyBilled(k);
  return id;
}

/**
 * Q14: the appointment a bill names must be an in-clinic consultation at this partner (its desk clinic, or the clinic of
 * its visit), at a branch in the actor's scope and at the bill's branch, with the bill's doctor (when named), not
 * cancelled, and without another open bill. Read again inside the bill's transaction; the unique partial index on
 * `openAppointmentId` decides a race.
 */
async function admitAppointment(actor: PartnerActor, data: Pick<CreateInvoiceInput, 'appointmentId' | 'branchId' | 'doctorId'>,
  customerUserId: string | null | undefined, session?: mongoose.ClientSession): Promise<string> {
  const id = lowerId(data.appointmentId)!;
  const notFound = () => new AppError({ status: 404, code: 'APPOINTMENT_NOT_FOUND', message: 'Appointment not found' });
  if (!/^[0-9a-f]{24}$/.test(id)) throw notFound();
  const b = await BookingModel.findById(id).session(session ?? null).lean() as IBooking | null;
  // r10d: a card-paid assisted booking never confirmed is not the clinic's to bill.
  if (!b || b.bookingType !== 'consultation' || unpaidCardBooking(b as never)) throw notFound();
  // Desk rows belong to their desk clinic only; online rows to the clinic of the visit (as the appointment list reads them).
  const at = b.clinicDesk ?? b.clinicVisit;
  if (!at || lowerId(at.partnerId) !== lowerId(actor.partnerId)) throw notFound();
  if (!hasGlobalScope(actor) && !actor.branchIds.map(String).includes(String(at.branchId))) throw notFound();
  assertLinkBranch('appointment', at.branchId, data.branchId);
  if (data.doctorId && lowerId(data.doctorId) !== lowerId(b.specialistId)) {
    throw new AppError({ status: 400, code: 'APPOINTMENT_DOCTOR_MISMATCH', message: 'The bill names a different doctor than the appointment' });
  }
  return assertLinkable('appointment', id, b, customerUserId, session);
}

/**
 * r12 (§24.6.3, L10): the lab booking a bill names must be a DESK booking of this lab (paid at the lab; an online,
 * Jansetu-paid booking is never billed by the lab: the one 404), at a branch in the actor's scope and at the bill's
 * branch; then the shared checks (customer, not cancelled, no other open bill). The bill's lines are not checked
 * against the booking's tests (L10).
 */
async function admitLabBooking(actor: PartnerActor, data: Pick<CreateInvoiceInput, 'labBookingId' | 'branchId'>,
  customerUserId: string | null | undefined, session?: mongoose.ClientSession): Promise<string> {
  const id = lowerId(data.labBookingId)!;
  const notFound = () => new AppError({ status: 404, code: 'LAB_BOOKING_NOT_FOUND', message: 'Lab booking not found' });
  if (!/^[0-9a-f]{24}$/.test(id)) throw notFound();
  const b = await PartnerLabBookingModel.findById(id).session(session ?? null).lean() as IPartnerLabBooking | null;
  if (!b || b.settlement?.settlementSystem !== 'lab_desk' || lowerId(b.partnerId) !== lowerId(actor.partnerId)) throw notFound();
  if (!hasGlobalScope(actor) && !actor.branchIds.map(String).includes(String(b.branchId))) throw notFound();
  assertLinkBranch('lab_booking', b.branchId, data.branchId);
  return assertLinkable('lab_booking', id, b, customerUserId, session);
}

/**
 * Q14 review: what a customer sees of a bill and its events. Payment request keys and content hashes, the bill's own
 * request key and hash, and staff ids (`by`, `createdBy`) are workspace bookkeeping and are left out; the kind, time,
 * amounts, methods (splits), references, reasons and refund stay.
 */
export type CustomerInvoiceEvent = Omit<IInvoiceEvent, 'requestKey' | 'requestHash' | 'by'>;
export function customerEventView(e: IInvoiceEvent): CustomerInvoiceEvent {
  const { requestKey: _k, requestHash: _h, by: _b, ...rest } = e;
  return rest;
}
export function customerInvoiceView<T extends IInvoice>(inv: T): Omit<T, 'idempotencyKey' | 'requestHash' | 'createdBy'> {
  const { idempotencyKey: _k, requestHash: _h, createdBy: _c, ...rest } = inv;
  return rest;
}

/** Q14 review: the existing customer account of a phone number (none is created); null when there is none. */
async function existingCustomerId(rawPhone?: string): Promise<string | null> {
  if (!rawPhone) return null;
  const u = await UserModel.findOne({ phone: normalizePhone(rawPhone), userType: 'user' }).select({ _id: 1 }).lean() as { _id: unknown } | null;
  return u ? String(u._id) : null;
}

/**
 * Q14 / r12: the open bill of each linked record, else its latest cancelled one (of one partner, or of the rows' partners).
 * r19b: with `customerUserId`, only bills naming that customer (a patient never sees a bill made out to another account).
 */
async function billsOf(k: BillLink, ids0: string[], partnerId: string | string[], customerUserId?: string) {
  const field = BILL_LINKS[k].field;
  const ids = [...new Set(ids0.map((a) => String(a).toLowerCase()))];
  const out = new Map<string, { invoiceId: string; serial: string; number: number; state: InvoiceLifecycleState }>();
  if (!ids.length) return out;
  const rows = await InvoiceModel.find({ partnerId: Array.isArray(partnerId) ? { $in: partnerId } : partnerId, [field]: { $in: ids },
    ...(customerUserId !== undefined ? { 'customer.userId': { $eq: String(customerUserId) } } : {}) }).sort({ issuedAt: -1, _id: -1 })
    .select({ [field]: 1, serial: 1, number: 1, lifecycleState: 1 }).lean() as unknown as IInvoice[];
  for (const r of rows) {
    const key = String(r[field]);
    const cur = out.get(key);
    if (cur && (cur.state !== 'cancelled' || r.lifecycleState === 'cancelled')) continue;
    out.set(key, { invoiceId: String(r._id), serial: r.serial, number: r.number, state: r.lifecycleState });
  }
  return out;
}
/** Q14: for the clinic appointment rows. */
export const billsForAppointments = (partnerId: string, appointmentIds: string[]) => billsOf('appointment', appointmentIds, partnerId);
/** r12 (§24.6.3): for the lab and patient views of lab desk rows (r19b: the patient's, only bills naming the reader). */
export const billsForLabBookings = (labBookingIds: string[], partnerId: string | string[], customerUserId?: string) =>
  billsOf('lab_booking', labBookingIds, partnerId, customerUserId);

/** Stable JSON (moved to common in Q15; re-exported for existing importers). */
export { canonicalJson } from '@/modules/common/utils/canonicalJson';
import { canonicalJson } from '@/modules/common/utils/canonicalJson';

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Every field of the issued document (identity, parties, lines, totals, provenance). */
export function invoiceChecksum(inv: Pick<IInvoice, 'partnerId' | 'branchId' | 'number' | 'financialYear' | 'serial' | 'documentKind'
  | 'issuedAt' | 'supplier' | 'customer' | 'doctorId' | 'appointmentId' | 'labBookingId' | 'items' | 'totals' | 'createdBy' | 'idempotencyKey' | 'requestHash'>): string {
  return sha256(canonicalJson({
    v: 1,
    partnerId: String(inv.partnerId), branchId: String(inv.branchId), number: inv.number, financialYear: inv.financialYear,
    serial: inv.serial, documentKind: inv.documentKind, issuedAt: new Date(inv.issuedAt), supplier: inv.supplier,
    // r12: labBookingId only when set (canonicalJson drops absent keys, so bills issued before keep their checksum).
    customer: inv.customer, doctorId: inv.doctorId, appointmentId: inv.appointmentId, labBookingId: inv.labBookingId, items: inv.items, totals: inv.totals, createdBy: inv.createdBy,
    idempotencyKey: inv.idempotencyKey, requestHash: inv.requestHash,
  }));
}

/** Financial year (April–March) in India time, as `YYZZ` (e.g. 2627 for 2026-27). */
export function financialYearOf(at: Date): string {
  const ist = new Date(at.getTime() + 330 * 60_000);
  const y = ist.getUTCMonth() >= 3 ? ist.getUTCFullYear() : ist.getUTCFullYear() - 1;
  return `${String(y % 100).padStart(2, '0')}${String((y + 1) % 100).padStart(2, '0')}`;
}

/** `<PREFIX>/<YYZZ>/<NNNN>` — at most 16 characters (CBIC Rule 46). */
export function formatSerial(prefix: string, fy: string, seq: number): string {
  const serial = `${prefix}/${fy}/${String(seq).padStart(4, '0')}`;
  if (serial.length > 16) {
    throw new AppError({ status: 409, code: 'SERIAL_EXHAUSTED', message: 'The invoice series is full for this financial year; ask an admin for a shorter prefix' });
  }
  return serial;
}

/** §6 classification from the supplier's regime, GSTIN and line rates. */
export function classifyDocument(taxRegime: string, gstin: string | undefined, lines: { gstRate: number }[]): DocumentKind {
  const taxable = lines.some((l) => l.gstRate > 0);
  if (taxRegime === 'regular' && gstin) return taxable ? 'tax_invoice' : 'bill_of_supply';
  if (taxRegime === 'composition' && gstin) return 'bill_of_supply';
  return 'commercial_invoice';
}

/** r42: an exempt supply (bill line or catalogue item) is at GST rate 0. */
export function assertExemptRate(taxTreatment: TaxTreatment | undefined, gstRate: number): void {
  if (taxTreatment === 'exempt' && gstRate !== 0) {
    throw new AppError({ status: 400, code: 'EXEMPT_RATE_NOT_ZERO', message: 'An exempt supply has GST rate 0: set the rate to 0, or mark the item taxable to charge GST' });
  }
}

/** What a bill line takes from the catalogue item it links to. */
export type CatalogueLink = { name: string; sac?: string; taxTreatment?: TaxTreatment };

/**
 * r42 (§26.25): a line is exempt when it says so, or when it names no treatment and links to an exempt catalogue item
 * (then it also takes the item's SAC if it has none). Exempt lines have rate 0 and are marked only on a tax invoice;
 * on a bill of supply or a commercial invoice no treatment is stored. r42b: on a bill of supply every linked line takes
 * the item's SAC when it has none (Rule 49 asks for the HSN/SAC there).
 */
export function computeLines(items: CreateInvoiceInput['items'], catalogue: Map<string, CatalogueLink>, kind: DocumentKind): IInvoiceLine[] {
  return items.map((item) => {
    const linked = item.catalogItemId ? catalogue.get(String(item.catalogItemId)) : undefined;
    const exempt = (item.taxTreatment ?? linked?.taxTreatment) === 'exempt';
    assertExemptRate(exempt ? 'exempt' : 'taxable', item.gstRate);
    const marked = exempt && kind === 'tax_invoice';
    const discount = item.discountMinor ?? 0;
    const gross = item.unitPriceMinor * item.qty;
    if (!Number.isSafeInteger(gross) || gross > MAX_BILL_MINOR) {
      throw new AppError({ status: 400, code: 'AMOUNT_TOO_LARGE', message: 'This line is larger than a single bill can be' });
    }
    if (discount > gross) {
      throw new AppError({ status: 400, code: 'INVALID_LINE_AMOUNT', message: 'A line discount cannot exceed the line amount' });
    }
    if (item.catalogItemId && !catalogue.has(String(item.catalogItemId))) {
      throw new AppError({ status: 400, code: 'CATALOGUE_ITEM_NOT_FOUND', message: 'A catalogue item on this bill is not available' });
    }
    return {
      catalogItemId: item.catalogItemId,
      description: item.description,
      hsn: item.hsn,
      sac: item.sac ?? (marked || kind === 'bill_of_supply' ? linked?.sac : undefined),
      qty: item.qty,
      unitPriceMinor: item.unitPriceMinor,
      discountMinor: discount,
      gstRate: item.gstRate,
      ...(marked ? { taxTreatment: 'exempt' as const } : {}),
      amountMinor: gross - discount,
    };
  });
}

/**
 * Per-line tax rounded to the paisa; totals are sums of rounded line amounts. Q16a: within a state, CGST and SGST are
 * each charged at half the rate and rounded on their own, so they are always equal and the line's tax is CGST + SGST
 * (it can differ by a paisa from rounding the full rate once — the earlier rule, which put the odd paisa in SGST).
 * Only new bills use this: an issued bill is never recomputed (its stored totals are part of its checksum).
 * r42: exempt lines add to exemptMinor (present only when there is one) instead of taxableMinor, and carry no tax.
 */
export function computeTotals(lines: IInvoiceLine[], sameState: boolean): IInvoiceTotals {
  const t: Omit<IInvoiceTotals, 'totalMinor' | 'currency'> = { subtotalMinor: 0, discountMinor: 0, taxableMinor: 0, cgstMinor: 0, sgstMinor: 0, igstMinor: 0 };
  for (const line of lines) {
    t.subtotalMinor += line.unitPriceMinor * line.qty;
    t.discountMinor += line.discountMinor;
    if (line.taxTreatment === 'exempt') {
      t.exemptMinor = (t.exemptMinor ?? 0) + line.amountMinor;
      continue;
    }
    t.taxableMinor += line.amountMinor;
    if (sameState) {
      const half = Math.round((line.amountMinor * line.gstRate) / 200);
      t.cgstMinor += half;
      t.sgstMinor += half;
    } else {
      t.igstMinor += Math.round((line.amountMinor * line.gstRate) / 100);
    }
  }
  const totals = { ...t, totalMinor: t.taxableMinor + (t.exemptMinor ?? 0) + t.cgstMinor + t.sgstMinor + t.igstMinor, currency: 'INR' as const };
  if (!Object.values(totals).every((v) => typeof v !== 'number' || (Number.isSafeInteger(v) && v >= 0 && v <= MAX_BILL_MINOR))) {
    throw new AppError({ status: 400, code: 'AMOUNT_TOO_LARGE', message: 'This bill is larger than a single bill can be' });
  }
  return totals;
}

function assertTaxConsistent(kind: DocumentKind, lines: IInvoiceLine[], totals: IInvoiceTotals): void {
  if (kind === 'tax_invoice') return;
  if (lines.some((l) => l.gstRate > 0)) {
    throw new AppError({
      status: 400,
      code: 'INVALID_TAX_RATES',
      message: kind === 'commercial_invoice'
        ? 'This partner is not GST-registered: every line must have GST rate 0'
        : 'A bill of supply cannot charge GST: every line must have GST rate 0',
    });
  }
  if (totals.cgstMinor || totals.sgstMinor || totals.igstMinor) {
    throw new AppError({ status: 400, code: 'TAX_TOTAL_MISMATCH', message: 'A bill of supply / commercial invoice cannot have tax totals' });
  }
}

/** The events that made lifecycle version `v`, in version order (never clock order). */
export function eventsAsOf(events: IInvoiceEvent[], v: number): IInvoiceEvent[] {
  return events.filter((e) => e.version <= v).sort((a, b) => a.version - b.version);
}

/** ₹1,000 crore: far above any real bill, far below Number.MAX_SAFE_INTEGER paise even before tax. */
export const MAX_BILL_MINOR = 10_000_000_000_00;

/**
 * GST registrations are state-specific: a bill that prints a GSTIN (tax invoice / bill of supply) must be issued from a
 * branch in that GSTIN's state (its first two digits). Other states need their own registration.
 */
export function assertRegistrationCovers(kind: DocumentKind, gstin: string | undefined, branchStateCode: string): void {
  if (kind === 'commercial_invoice' || !gstin) return;
  if (gstin.slice(0, 2) !== branchStateCode) {
    throw new AppError({
      status: 409,
      code: 'GST_REGISTRATION_STATE_MISMATCH',
      message: `The partner's GST registration (state ${gstin.slice(0, 2)}) does not cover this branch (state ${branchStateCode}); this branch cannot issue GST bills yet`,
    });
  }
}

const addressLine = (a: any) => [a?.line1, a?.line2, a?.city, a?.state, a?.pincode].filter(Boolean).join(', ');

@Service()
export class InvoiceService {
  constructor(
    private invoiceRepository: InvoiceRepository,
    private invoiceEventRepository: InvoiceEventRepository,
    private invoiceCounterRepository: InvoiceCounterRepository,
    private partnerRepository: PartnerRepository,
    private branchRepository: BranchRepository,
    private catalogueRepository: CatalogueItemRepository,
    private smsService: SMSService
  ) {}

  async createInvoice(actor: PartnerActor, data: CreateInvoiceInput): Promise<IInvoice> {
    const requestHash = sha256(canonicalJson({
      branchId: data.branchId, customer: { ...data.customer, phone: data.customer.phone ? normalizePhone(data.customer.phone) : undefined },
      doctorId: data.doctorId, items: data.items,
      // Q14: the appointment is part of the request identity (absent = as before, so older keys keep their hash).
      appointmentId: lowerId(data.appointmentId),
      // r12: the lab desk booking likewise (absent = as before).
      labBookingId: lowerId(data.labBookingId),
    }));
    const replay = await this.replayed(actor, data.idempotencyKey, requestHash);
    if (replay) return withDue(replay);

    const partner = await this.partnerRepository.findById(actor.partnerId);
    if (!partner) throw new AppError({ status: 404, code: 'PARTNER_NOT_FOUND', message: 'Partner not found' });

    const branch = await this.branchRepository.findById(data.branchId);
    if (!branch || String(branch.partnerId) !== actor.partnerId || branch.isActive === false) {
      throw new AppError({ status: 404, code: 'BRANCH_NOT_FOUND', message: 'Branch not found' });
    }
    assertBranchInScope(actor, data.branchId);
    const stateCode = branch.address?.stateCode;
    if (!stateCode) throw new AppError({ status: 409, code: 'BRANCH_STATE_CODE_MISSING', message: 'Set the branch GST state code before billing' });

    if (data.doctorId) {
      const doctorHere = await MemberModel.findOne({ partnerId: actor.partnerId, doctorId: data.doctorId, isActive: true }).lean();
      if (!doctorHere) throw new AppError({ status: 400, code: 'DOCTOR_NOT_IN_PARTNER', message: 'The doctor does not work at this partner' });
      // Q10: the named doctor consults at this branch and is an active, verified doctor now.
      const { doctorScopeOf } = await import('@/modules/doctors/services/schedule');
      const scope = doctorScopeOf(doctorHere as any);
      const sp = await SpecialistModel.findById(data.doctorId).select({ isActive: 1, isVerified: 1 }).lean() as { isActive?: boolean; isVerified?: boolean } | null;
      if ((scope.length > 0 && !scope.includes(String(data.branchId))) || !sp || sp.isActive === false || sp.isVerified === false) {
        throw new AppError({ status: 400, code: 'DOCTOR_NOT_AT_BRANCH', message: 'The doctor does not consult at this branch' });
      }
    }

    // Q14: refused early here (the customer looked up, never created, so a refused bill leaves no account behind);
    // admitted again inside the transaction with the resolved customer.
    if (data.appointmentId && data.labBookingId) {
      throw new AppError({ status: 400, code: 'VALIDATION_ERROR', message: 'A bill is for an appointment or a lab booking, not both' });
    }
    if (data.appointmentId) await admitAppointment(actor, data, await existingCustomerId(data.customer.phone));
    // r12 (§24.6.3): a lab desk booking is billed at most once at a time (fail closed until sync-indexes built the index).
    if (data.labBookingId) {
      await assertUniqueIndex(InvoiceModel, { openLabBookingId: 1 });
      await admitLabBooking(actor, data, await existingCustomerId(data.customer.phone));
    }

    const catalogueIds = [...new Set(data.items.map((i) => i.catalogItemId).filter(Boolean).map(String))];
    const catalogue = new Map<string, CatalogueLink>();
    if (catalogueIds.length > 0) {
      const rows = await this.catalogueRepository.findAll({ _id: { $in: catalogueIds }, partnerId: actor.partnerId, isActive: true, adminDisabled: { $ne: true } });
      for (const r of rows) catalogue.set(String(r._id), { name: r.name, sac: r.sac, taxTreatment: r.taxTreatment });
      // Q10: a line linked to the catalogue bills the catalogue's own price and GST (only qty and discount vary).
      const byId = new Map(rows.map((r) => [String(r._id), r]));
      for (const line of data.items) {
        const item = line.catalogItemId ? byId.get(String(line.catalogItemId)) : undefined;
        if (item && (line.unitPriceMinor !== item.priceMinor || line.gstRate !== item.gstRate)) {
          throw new AppError({ status: 409, code: 'CATALOGUE_PRICE_CHANGED', message: `${item.name} is now ₹${(item.priceMinor / 100).toFixed(2)} at ${item.gstRate}% GST; review the bill` });
        }
        // r42: and its tax treatment when the item names one (a line that names none takes the item's). r42b: the same
        // code (the web already reloads the catalogue on it), with a message naming the treatment.
        if (item?.taxTreatment && line.taxTreatment && line.taxTreatment !== item.taxTreatment) {
          throw new AppError({ status: 409, code: 'CATALOGUE_PRICE_CHANGED', message: `${item.name} is billed as ${item.taxTreatment}; review the bill` });
        }
      }
    }

    const documentKind = classifyDocument(partner.taxRegime, partner.gstin, data.items);
    const lines = computeLines(data.items, catalogue, documentKind);
    assertRegistrationCovers(documentKind, partner.gstin, stateCode);
    // B2C with no customer state: place of supply is the supplier's location (intra-state).
    const sameState = !data.customer.placeOfSupply || data.customer.placeOfSupply === stateCode;
    const totals = computeTotals(lines, sameState);
    assertTaxConsistent(documentKind, lines, totals);

    const supplier: IInvoiceSupplier = {
      name: partner.name,
      legalName: partner.legalName,
      gstin: documentKind === 'commercial_invoice' ? undefined : partner.gstin,
      pan: partner.pan,
      address: addressLine(branch.address),
      placeOfSupply: stateCode,
      // r42b: a bill of supply names its regime, so it prints the right note (absent on earlier bills and other kinds).
      ...(documentKind === 'bill_of_supply' ? { taxRegime: partner.taxRegime === 'composition' ? 'composition' as const : 'regular' as const } : {}),
    };

    let resolved: Awaited<ReturnType<typeof resolveCustomerByPhone>> | null = null;
    if (data.customer.phone) resolved = await resolveCustomerByPhone(data.customer.phone, 'partner_invoice');

    const customer: IInvoiceCustomer = {
      name: data.customer.name,
      phone: resolved?.phone,
      userId: resolved?._id,
      gstin: data.customer.gstin,
      age: data.customer.age,
      gender: data.customer.gender,
      placeOfSupply: data.customer.placeOfSupply,
    };

    let invoice: IInvoice;
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        // Q10: the key is claimed with the bill, so a reloaded client's abandon and this create cannot both win.
        await claimRequestKey(invoiceKeyScope(actor.partnerId), data.idempotencyKey, session);
        const appointmentId = data.appointmentId ? await admitAppointment(actor, data, resolved?._id, session) : undefined;
        const labBookingId = data.labBookingId ? await admitLabBooking(actor, data, resolved?._id, session) : undefined;
        const issuedAt = new Date();
        const fy = financialYearOf(issuedAt);
        const seq = await this.invoiceCounterRepository.nextSequence(actor.partnerId, fy, session);
        const doc: Partial<IInvoice> = {
          partnerId: actor.partnerId,
          branchId: data.branchId,
          number: seq,
          financialYear: fy,
          serial: formatSerial(partner.invoiceSeries.prefix, fy, seq),
          documentKind,
          issuedAt,
          supplier,
          customer,
          doctorId: data.doctorId,
          ...(appointmentId ? { appointmentId, openAppointmentId: appointmentId } : {}),
          ...(labBookingId ? { labBookingId, openLabBookingId: labBookingId } : {}),
          items: lines,
          totals,
          lifecycleState: 'issued',
          lifecycleVersion: 0,
          createdBy: actor.memberId,
          idempotencyKey: data.idempotencyKey,
          requestHash,
        };
        doc.checksum = invoiceChecksum(doc as IInvoice);
        invoice = await this.invoiceRepository.save(doc, { session });
        await recordPartnerAudit(actor, 'invoice.create', { kind: 'invoice', id: String(invoice._id) },
          { serial: doc.serial, totalMinor: totals.totalMinor, ...(appointmentId ? { appointmentId } : {}), ...(labBookingId ? { labBookingId } : {}) }, session);
      });
    } catch (error: any) {
      // A racing identical request may have committed first (key, or the appointment's open bill): answer with its bill.
      // (r12: the lab booking's open bill likewise.)
      const billedRace = (Object.keys(BILL_LINKS) as BillLink[]).find((k) => error?.code === `${BILL_LINKS[k].code}_ALREADY_BILLED`
        || (error?.code === 11000 && error?.keyPattern?.[BILL_LINKS[k].open]));
      if ((error?.code === 11000 && error?.keyPattern?.idempotencyKey) || billedRace) {
        const again = await this.replayed(actor, data.idempotencyKey, requestHash);
        if (again) return withDue(again);
      }
      if (billedRace) throw alreadyBilled(billedRace);
      throw error;
    } finally {
      await session.endSession();
    }

    if (resolved?.neverSignedIn) await this.sendBillNotice(resolved.phone, partner, invoice!.serial);
    return withDue(invoice!);
  }

  /**
   * The invoice already created under this key, if the request is the same and the actor may still see its branch now
   * (a replay is a read: the same admission as getInvoice). The old branch/catalogue need not still be active.
   */
  private async replayed(actor: PartnerActor, key: string, requestHash: string): Promise<IInvoice | null> {
    const existing = await this.invoiceRepository.findByIdempotencyKey(actor.partnerId, key);
    if (!existing) return null;
    if (!hasGlobalScope(actor) && !actor.branchIds.includes(String(existing.branchId))) throw invoiceNotFound();
    if (existing.requestHash !== requestHash) {
      throw new AppError({ status: 409, code: 'IDEMPOTENCY_KEY_REUSED', message: 'This request key was already used for a different bill' });
    }
    this.verifyChecksum(existing);
    return existing;
  }

  private async sendBillNotice(phone: string, partner: IPartner, serial: string): Promise<void> {
    if (!CONFIG.SMS_TEMPLATE_ID_PARTNER_BILL) return; // DLT template not registered yet: no notice
    try {
      const sms = this.smsService.buildSMSContent('partner_bill', { supplierName: partner.name.slice(0, 30), serial });
      await this.smsService.sendSMS({ to: phone, text: sms.text, templateId: sms.templateId });
    } catch (error) {
      console.error('partner bill notice failed', (error as Error)?.message); // the bill is issued either way
    }
  }

  /**
   * Q14: a payment of an in-house bill — one or several methods (always allowed), for the whole remaining amount or,
   * where the partner allows part payments, a part of it (then `partly_paid` until the total is reached). Never more
   * than is due. A keyed payment happens once per (bill, key) with a content hash; every payment is a CAS on the bill's
   * lifecycle version (so concurrent payments, or a payment and a cancellation, cannot both apply to the same state).
   */
  async recordPayment(actor: PartnerActor, invoiceId: string, data: RecordPaymentInput): Promise<{ invoice: IInvoice; event: IInvoiceEvent; replayed?: boolean }> {
    const bad = (code: string, message: string, status = 400) => new AppError({ status, code, message });
    const splitsIn: { mode: PaymentMode; amountMinor?: number; reference?: string }[] = data.splits?.length
      ? data.splits.map((x) => ({ mode: x.mode, amountMinor: x.amountMinor, reference: x.reference?.trim() || undefined }))
      : data.mode ? [{ mode: data.mode, reference: data.reference?.trim() || undefined }] : [];
    if (!splitsIn.length) throw bad('PAYMENT_METHOD_REQUIRED', 'Name how the bill was paid');
    if (data.splits?.length && data.splits.some((x) => !Number.isSafeInteger(x.amountMinor) || x.amountMinor <= 0)) {
      throw bad('INVALID_AMOUNT', 'Each part of a payment is a positive amount in paise');
    }
    const requestHash = sha256(canonicalJson({ splits: splitsIn, note: data.note?.trim() || undefined }));
    const current = await this.loadForActor(actor, invoiceId);
    const events = await this.invoiceEventRepository.findByInvoice(invoiceId);
    if (data.requestKey) {
      const prior = events.find((e) => e.kind === 'payment' && e.requestKey === data.requestKey);
      if (prior) {
        if (prior.requestHash !== requestHash) throw bad('IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different payment', 409);
        return { invoice: withDue(current, events), event: prior, replayed: true };
      }
    } else if (current.lifecycleState === 'paid' && !data.splits?.length) {
      // Q10: an unkeyed repeat of the full payment already recorded (same method and reference) answers with that receipt.
      const ev = events.find((e) => e.kind === 'payment' && !e.requestKey && (e.splits?.length || 1) === 1);
      if (ev && (ev.mode ?? ev.splits?.[0]?.mode) === data.mode && (ev.reference ?? ev.splits?.[0]?.reference ?? '') === (data.reference?.trim() ?? '')) {
        return { invoice: withDue(current, events), event: ev, replayed: true };
      }
    }
    let result!: { invoice: IInvoice; event: IInvoiceEvent; replayed?: boolean };
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const cur = await InvoiceModel.findOne({ _id: invoiceId, partnerId: actor.partnerId }).session(session).lean() as unknown as IInvoice | null;
        if (!cur) throw invoiceNotFound();
        const curEvents = await InvoiceEventModel.find({ invoiceId }).sort({ version: 1 }).session(session).lean() as unknown as IInvoiceEvent[];
        if (data.requestKey) {
          const raced = curEvents.find((e) => e.kind === 'payment' && e.requestKey === data.requestKey);
          if (raced) {
            if (raced.requestHash !== requestHash) throw bad('IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different payment', 409);
            result = { invoice: withDue(cur, curEvents), event: raced, replayed: true };
            return;
          }
        }
        if (cur.lifecycleState === 'cancelled') throw bad('ALREADY_CANCELLED', 'This bill is cancelled', 409);
        if (cur.lifecycleState === 'paid') throw bad('INVOICE_STATE_CONFLICT', 'This bill is paid', 409);
        if (data.expectedLifecycleVersion !== undefined && data.expectedLifecycleVersion !== null && Number(data.expectedLifecycleVersion) !== cur.lifecycleVersion) {
          throw bad('LIFECYCLE_VERSION_CONFLICT', 'The bill changed meanwhile; reload and try again', 409);
        }
        const total = cur.totals.totalMinor;
        const paid = paidOf(cur, curEvents);
        const due = total - paid;
        // A single method without an amount pays everything still due.
        const splits: PaymentSplit[] = splitsIn.length === 1 && splitsIn[0]!.amountMinor === undefined
          ? [{ ...splitsIn[0]!, amountMinor: due }] : splitsIn as PaymentSplit[];
        const amount = splits.reduce((n, x) => n + x.amountMinor, 0);
        if (amount > due) throw bad('AMOUNT_EXCEEDS_DUE', `Only ${(due / 100).toFixed(2)} is due on this bill`, 409);
        if (amount <= 0 && due > 0) throw bad('INVALID_AMOUNT', 'A payment is a positive amount');
        if (amount < due) {
          const p = await PartnerModel.findById(actor.partnerId).select({ allowPartPayments: 1 }).session(session).lean() as { allowPartPayments?: boolean } | null;
          if (!p?.allowPartPayments) throw bad('PART_PAYMENTS_NOT_ALLOWED', `This partner takes full payment only: ${(due / 100).toFixed(2)} is due`, 409);
          if (!data.requestKey) throw bad('REQUEST_KEY_REQUIRED', 'A part payment needs a request key');
        }
        if (data.requestKey) await claimRequestKey(paymentKeyScope(invoiceId), data.requestKey, session);
        const to: InvoiceLifecycleState = paid + amount >= total ? 'paid' : 'partly_paid';
        const updated = await this.invoiceRepository.casLifecycle(actor.partnerId, invoiceId, cur.lifecycleVersion, cur.lifecycleState, to, session,
          { paidMinor: paid + amount });
        if (!updated) throw bad('LIFECYCLE_VERSION_CONFLICT', 'The bill changed meanwhile; reload and try again', 409);
        const one = splits.length === 1 ? splits[0]! : undefined;
        const event = await this.invoiceEventRepository.save({
          invoiceId, kind: 'payment', ...(one ? { mode: one.mode, reference: one.reference } : {}), note: data.note,
          // Q14 review: a bill with nothing due (a zero total) is marked paid by its method alone, without a zero split
          // (a recorded split is always a positive amount).
          amountMinor: amount, splits: splits.filter((x) => x.amountMinor > 0), ...(data.requestKey ? { requestKey: data.requestKey, requestHash } : {}),
          version: cur.lifecycleVersion + 1, at: new Date(), by: actor.memberId, byKind: actor.actorKind === 'admin' ? 'admin' : 'member',
        } as Partial<IInvoiceEvent>, { session });
        await recordPartnerAudit(actor, 'invoice.pay', { kind: 'invoice', id: invoiceId },
          { serial: cur.serial, amountMinor: amount, methods: splits.map((x) => x.mode), state: to }, session);
        result = { invoice: withDue(updated), event };
      });
    } catch (error: any) {
      if (error?.code === 11000 && data.requestKey) {
        const ev = await InvoiceEventModel.findOne({ invoiceId, requestKey: data.requestKey }).lean() as unknown as IInvoiceEvent | null;
        if (ev && ev.requestHash === requestHash) return { invoice: withDue(await this.loadForActor(actor, invoiceId)), event: ev, replayed: true };
      }
      if (error?.code === 11000 && fromPreQ14PaymentIndex(error)) {
        // Q14 review: the database still has the old one-event-per-kind index (sync-indexes has not run), so a second
        // payment of a bill cannot be stored. Not a version race: say so, and leave one warning (no bill or patient data).
        console.warn(`partner_invoice_events still has the pre-Q14 unique index ${PRE_Q14_EVENT_INDEX}; run npm run sync-indexes before part payments are used`);
        throw new AppError({ status: 503, code: 'INVOICE_INDEXES_OUTDATED', message: 'Bills need a database update (sync-indexes) before a second payment' });
      }
      if (error?.code === 11000) throw new AppError({ status: 409, code: 'LIFECYCLE_VERSION_CONFLICT', message: 'The bill changed meanwhile; reload and try again' });
      throw error;
    } finally {
      await session.endSession();
    }
    return result;
  }

  /**
   * Q10: cancelling a PAID bill records how the money went back (the partner returns it themselves); an issued bill
   * needs none. The refund is part of the cancellation event and printed with it.
   */
  async cancelInvoice(actor: PartnerActor, invoiceId: string, reason: string,
    refund?: { mode: PaymentMode; reference?: string; note?: string; amountMinor?: number }): Promise<{ invoice: IInvoice; event: IInvoiceEvent }> {
    const current = await this.loadForActor(actor, invoiceId);
    if (current.lifecycleState === 'cancelled') throw new AppError({ status: 409, code: 'ALREADY_CANCELLED', message: 'This bill is cancelled' });
    // Q14: whatever was paid (in full or in parts) goes back, and the refund record names exactly that amount. The
    // cancellation is a CAS on the version read here, so a payment landing in between refuses it.
    const paid = paidOf(current, await this.invoiceEventRepository.findByInvoice(invoiceId));
    if (paid > 0 && !refund) {
      throw new AppError({ status: 400, code: 'REFUND_REQUIRED', message: 'This bill was paid: record how the money was returned' });
    }
    if (paid === 0 && refund) {
      throw new AppError({ status: 400, code: 'NOTHING_TO_REFUND', message: 'This bill was not paid' });
    }
    if (refund && refund.amountMinor !== undefined && refund.amountMinor !== paid) {
      throw new AppError({ status: 400, code: 'REFUND_AMOUNT_MISMATCH', message: `The refund must be the amount paid (${(paid / 100).toFixed(2)})` });
    }
    const out = await this.transition(actor, invoiceId, [current.lifecycleState], 'cancelled',
      { kind: 'cancellation', reason, ...(refund ? { refund: { ...refund, amountMinor: paid } } : {}) }, 'invoice.cancel', current, { paidMinor: paid });
    return { ...out, invoice: withDue(out.invoice) };
  }

  /** Q10: the bill a request key produced (a lost answer), within the actor's branch scope; null when none. */
  async findByKey(actor: PartnerActor, key: string): Promise<IInvoice | null> {
    const inv = await this.invoiceRepository.findByIdempotencyKey(actor.partnerId, key);
    if (!inv) return null;
    if (!hasGlobalScope(actor) && !actor.branchIds.includes(String(inv.branchId))) return null;
    this.verifyChecksum(inv);
    return withDue(inv);
  }

  /** Q10: give up a bill whose answer was lost: abandoned (it can never be issued) or used (here is the bill). */
  async abandonKey(actor: PartnerActor, key: string): Promise<{ state: 'abandoned' | 'used'; invoice?: IInvoice | null }> {
    // A bill issued under this key before claims existed (no claim row) is reconciled first: it is used, never abandoned.
    if (await this.invoiceRepository.findByIdempotencyKey(actor.partnerId, key)) return { state: 'used', invoice: await this.findByKey(actor, key) };
    const state = await abandonRequestKey(invoiceKeyScope(actor.partnerId), key);
    return state === 'abandoned' ? { state } : { state, invoice: await this.findByKey(actor, key) };
  }

  /** §6 lifecycle fence: CAS on lifecycleVersion + state, then the event, in one transaction. */
  private async transition(
    actor: PartnerActor,
    invoiceId: string,
    from: InvoiceLifecycleState[],
    to: InvoiceLifecycleState,
    payload: Partial<IInvoiceEvent>,
    action: string,
    loaded?: IInvoice,
    extraSet: Record<string, unknown> = {}
  ): Promise<{ invoice: IInvoice; event: IInvoiceEvent }> {
    const current = loaded ?? await this.loadForActor(actor, invoiceId);
    if (!from.includes(current.lifecycleState)) {
      throw new AppError({
        status: 409,
        code: current.lifecycleState === 'cancelled' ? 'ALREADY_CANCELLED' : 'INVOICE_STATE_CONFLICT',
        message: `This bill is ${current.lifecycleState}`,
      });
    }
    let result!: { invoice: IInvoice; event: IInvoiceEvent };
    const session = await mongoose.startSession();
    try {
      await session.withTransaction(async () => {
        const updated = await this.invoiceRepository.casLifecycle(actor.partnerId, invoiceId, current.lifecycleVersion, current.lifecycleState, to, session, extraSet);
        if (!updated) {
          throw new AppError({ status: 409, code: 'LIFECYCLE_VERSION_CONFLICT', message: 'The bill changed meanwhile; reload and try again' });
        }
        const event = await this.invoiceEventRepository.save({
          ...payload,
          invoiceId,
          version: current.lifecycleVersion + 1,
          at: new Date(),
          by: actor.memberId,
          byKind: actor.actorKind === 'admin' ? 'admin' : 'member',
        } as Partial<IInvoiceEvent>, { session });
        await recordPartnerAudit(actor, action, { kind: 'invoice', id: invoiceId }, { serial: current.serial }, session);
        result = { invoice: updated, event };
      });
    } catch (error: any) {
      if (error?.code === 11000) {
        throw new AppError({ status: 409, code: 'INVOICE_STATE_CONFLICT', message: 'This bill already has that event' });
      }
      throw error;
    } finally {
      await session.endSession();
    }
    return result;
  }

  /** Partner + branch scope; the stored document must still match its checksum. */
  private async loadForActor(actor: PartnerActor, invoiceId: string): Promise<IInvoice> {
    const invoice = await this.invoiceRepository.findById(invoiceId);
    if (!invoice || String(invoice.partnerId) !== actor.partnerId) throw invoiceNotFound();
    if (!hasGlobalScope(actor) && !actor.branchIds.includes(String(invoice.branchId))) throw invoiceNotFound();
    this.verifyChecksum(invoice);
    return invoice;
  }

  async getInvoice(actor: PartnerActor, invoiceId: string): Promise<{ invoice: IInvoice; events: IInvoiceEvent[] }> {
    const invoice = await this.loadForActor(actor, invoiceId);
    const events = await this.invoiceEventRepository.findByInvoice(invoiceId);
    return { invoice: withDue(invoice, events), events };
  }

  /**
   * Q10: newest first with an exact cursor `<issuedAt ms>_<id>` (no rounding, ties broken by id), IST date range,
   * search on serial / customer name / phone, and the total matching count.
   */
  async listInvoicesPage(actor: PartnerActor, filter: { state?: InvoiceLifecycleState; branchId?: string; limit?: number; cursor?: string;
    from?: string; to?: string; q?: string; appointmentId?: string }): Promise<{ items: IInvoice[]; nextCursor: string | null; total: number }> {
    const query: any = invoicesScope(actor, filter.branchId);
    if (filter.state) query.lifecycleState = filter.state;
    if (filter.appointmentId) query.appointmentId = lowerId(filter.appointmentId);
    if (filter.from || filter.to) {
      const real = (d?: string) => { if (!d) return true; const x = new Date(`${d}T00:00:00Z`); return /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(x.getTime()) && x.toISOString().slice(0, 10) === d; };
      if (!real(filter.from) || !real(filter.to)) throw new AppError({ status: 400, code: 'INVALID_DATE', message: 'Dates must be real calendar dates (YYYY-MM-DD)' });
      query.issuedAt = { ...(filter.from ? { $gte: new Date(`${filter.from}T00:00:00+05:30`) } : {}),
        ...(filter.to ? { $lt: new Date(new Date(`${filter.to}T00:00:00+05:30`).getTime() + 86_400_000) } : {}) };
    }
    if (filter.q?.trim()) {
      const rx = { $regex: filter.q.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), $options: 'i' };
      query.$or = [{ serial: rx }, { 'customer.name': rx }, { 'customer.phone': rx }];
    }
    const total = await InvoiceModel.countDocuments(query);
    const page: any = { ...query };
    if (filter.cursor) {
      const [ms, id] = filter.cursor.split('_');
      if (!/^\d{1,15}$/.test(ms ?? '') || !/^[0-9a-fA-F]{24}$/.test(id ?? '')) throw new AppError({ status: 400, code: 'INVALID_CURSOR', message: 'Invalid cursor' });
      const at = new Date(Number(ms));
      page.$and = [...(page.$and ?? []), { $or: [{ issuedAt: { $lt: at } }, { issuedAt: at, _id: { $lt: new mongoose.Types.ObjectId(id) } }] }];
    }
    const limit = Math.min(Math.max(Number(filter.limit) || 50, 1), 200);
    const rows = await InvoiceModel.find(page).sort({ issuedAt: -1, _id: -1 }).limit(limit + 1).lean() as unknown as IInvoice[];
    const items = rows.slice(0, limit);
    items.forEach((r) => this.verifyChecksum(r));
    const last = items[items.length - 1];
    return { items: items.map((r) => withDue(r)), total, nextCursor: rows.length > limit && last ? `${new Date(last.issuedAt).getTime()}_${String(last._id)}` : null };
  }

  async listInvoices(actor: PartnerActor, filter: { state?: InvoiceLifecycleState; branchId?: string; limit?: number; before?: Date;
    appointmentId?: string }): Promise<IInvoice[]> {
    const query: any = invoicesScope(actor, filter.branchId);
    if (filter.state) query.lifecycleState = filter.state;
    if (filter.appointmentId) query.appointmentId = lowerId(filter.appointmentId);
    if (filter.before) query.issuedAt = { $lt: filter.before };
    const rows = await this.invoiceRepository.findAll(query, { sort: { issuedAt: -1, _id: -1 }, limit: Math.min(filter.limit ?? 50, 200) });
    rows.forEach((r) => this.verifyChecksum(r));
    return rows.map((r) => withDue(r));
  }

  /** Q9: paged, newest first; each bill names its doctor (clinic bills) from the doctor's current profile. */
  async listCustomerBills(userId: string, page = 1, limit = 20) {
    const lim = Math.min(Math.max(Number(limit) || 20, 1), 100);
    const pg = Math.max(Number(page) || 1, 1);
    const q = { 'customer.userId': userId };
    const [rows, total] = await Promise.all([
      InvoiceModel.find(q).sort({ issuedAt: -1, _id: -1 }).skip((pg - 1) * lim).limit(lim).lean() as unknown as Promise<IInvoice[]>,
      InvoiceModel.countDocuments(q),
    ]);
    rows.forEach((r) => this.verifyChecksum(r));
    const names = await doctorNames(rows);
    return { items: rows.map((r) => ({ ...customerInvoiceView(withDue(r)), doctorName: r.doctorId ? names[String(r.doctorId)] : undefined })), page: pg, limit: lim, total,
      totalPages: Math.max(1, Math.ceil(total / lim)) };
  }

  /** The customer's own bill as stored (checksum verified), with its events. */
  private async loadCustomerBill(userId: string, invoiceId: string): Promise<{ invoice: IInvoice; events: IInvoiceEvent[] }> {
    const invoice = await this.invoiceRepository.findById(invoiceId);
    if (!invoice || !invoice.customer?.userId || String(invoice.customer.userId) !== String(userId)) throw invoiceNotFound();
    this.verifyChecksum(invoice);
    return { invoice, events: await this.invoiceEventRepository.findByInvoice(invoiceId) };
  }

  /** GET /bills/:invoiceId — the customer view: no request keys or hashes and no staff ids (Q14 review). */
  async getCustomerBill(userId: string, invoiceId: string): Promise<{ invoice: IInvoice; events: CustomerInvoiceEvent[] }> {
    const { invoice, events } = await this.loadCustomerBill(userId, invoiceId);
    const doctorName = invoice.doctorId ? (await doctorNames([invoice]))[String(invoice.doctorId)] : undefined;
    return { invoice: { ...customerInvoiceView(withDue(invoice, events)), ...(doctorName ? { doctorName } : {}) } as IInvoice, events: events.map(customerEventView) };
  }

  /** PDF of the bill as of lifecycle `version` (0 = as issued; default = current). */
  async pdfForActor(actor: PartnerActor, invoiceId: string, version?: number): Promise<{ pdf: Buffer; fileName: string }> {
    const { invoice, events } = await this.getInvoice(actor, invoiceId);
    return this.pdf(invoice, events, version);
  }

  async pdfForCustomer(userId: string, invoiceId: string, version?: number): Promise<{ pdf: Buffer; fileName: string }> {
    const { invoice, events } = await this.loadCustomerBill(userId, invoiceId);
    return this.pdf(withDue(invoice, events), events, version);
  }

  private async pdf(invoice: IInvoice, events: IInvoiceEvent[], version?: number) {
    const v = version ?? invoice.lifecycleVersion;
    if (!Number.isInteger(v) || v < 0 || v > invoice.lifecycleVersion) {
      throw new AppError({ status: 400, code: 'INVALID_VERSION', message: `Version must be between 0 and ${invoice.lifecycleVersion}` });
    }
    const pdf = await renderInvoicePdf(invoice, eventsAsOf(events, v), { doctorName: (await doctorNames([invoice]))[String(invoice.doctorId)] });
    return { pdf, fileName: `${invoice.serial.replace(/\//g, '-')}-v${v}.pdf` };
  }

  private verifyChecksum(invoice: IInvoice): void {
    if (invoice.checksum !== invoiceChecksum(invoice)) {
      throw new AppError({ status: 500, code: 'CHECKSUM_MISMATCH', message: 'Invoice integrity check failed' });
    }
  }
}

