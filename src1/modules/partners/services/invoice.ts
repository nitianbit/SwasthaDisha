import { InvoiceModel } from '@/modules/partners/model/invoice';
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

/** Q9: display names of the doctors named on invoices (not part of the immutable document or its checksum). */
async function doctorNames(rows: { doctorId?: string }[]): Promise<Record<string, string>> {
  const ids = [...new Set(rows.map((r) => r.doctorId).filter((d): d is string => !!d && /^[0-9a-fA-F]{24}$/.test(d)))];
  if (!ids.length) return {};
  const sps = await SpecialistModel.find({ _id: { $in: ids } }).select({ name: 1 }).lean() as { _id: unknown; name?: string }[];
  return Object.fromEntries(sps.filter((s) => s.name).map((s) => [String(s._id), String(s.name)]));
}

export type GstRate = 0 | 5 | 12 | 18 | 28;

export interface CreateInvoiceInput {
  branchId: string;
  customer: { name: string; phone?: string; gstin?: string; age?: number; gender?: string; placeOfSupply?: string };
  doctorId?: string;
  items: { catalogItemId?: string; description: string; hsn?: string; sac?: string; qty: number; unitPriceMinor: number; discountMinor?: number; gstRate: GstRate }[];
  idempotencyKey: string;
}

const invoiceNotFound = () => new AppError({ status: 404, code: 'INVOICE_NOT_FOUND', message: 'Invoice not found' });

/** Stable JSON: sorted keys, no undefined/null, dates as ISO strings. */
export function canonicalJson(value: unknown): string {
  const norm = (v: unknown): unknown => {
    if (v instanceof Date) return v.toISOString();
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(v as object).sort()) {
        const x = (v as Record<string, unknown>)[k];
        if (x === undefined || x === null) continue;
        out[k] = norm(x);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(value));
}

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

/** Every field of the issued document (identity, parties, lines, totals, provenance). */
export function invoiceChecksum(inv: Pick<IInvoice, 'partnerId' | 'branchId' | 'number' | 'financialYear' | 'serial' | 'documentKind'
  | 'issuedAt' | 'supplier' | 'customer' | 'doctorId' | 'items' | 'totals' | 'createdBy' | 'idempotencyKey' | 'requestHash'>): string {
  return sha256(canonicalJson({
    v: 1,
    partnerId: String(inv.partnerId), branchId: String(inv.branchId), number: inv.number, financialYear: inv.financialYear,
    serial: inv.serial, documentKind: inv.documentKind, issuedAt: new Date(inv.issuedAt), supplier: inv.supplier,
    customer: inv.customer, doctorId: inv.doctorId, items: inv.items, totals: inv.totals, createdBy: inv.createdBy,
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

export function computeLines(items: CreateInvoiceInput['items'], catalogue: Map<string, { name: string }>): IInvoiceLine[] {
  return items.map((item) => {
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
      sac: item.sac,
      qty: item.qty,
      unitPriceMinor: item.unitPriceMinor,
      discountMinor: discount,
      gstRate: item.gstRate,
      amountMinor: gross - discount,
    };
  });
}

/** Per-line tax rounded to the paisa; totals are sums of rounded line amounts. CGST/SGST split puts the odd paisa in SGST. */
export function computeTotals(lines: IInvoiceLine[], sameState: boolean): IInvoiceTotals {
  const t = { subtotalMinor: 0, discountMinor: 0, taxableMinor: 0, cgstMinor: 0, sgstMinor: 0, igstMinor: 0 };
  for (const line of lines) {
    t.subtotalMinor += line.unitPriceMinor * line.qty;
    t.discountMinor += line.discountMinor;
    t.taxableMinor += line.amountMinor;
    const tax = Math.round((line.amountMinor * line.gstRate) / 100);
    if (sameState) {
      const half = Math.floor(tax / 2);
      t.cgstMinor += half;
      t.sgstMinor += tax - half;
    } else {
      t.igstMinor += tax;
    }
  }
  const totals = { ...t, totalMinor: t.taxableMinor + t.cgstMinor + t.sgstMinor + t.igstMinor, currency: 'INR' as const };
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
    }));
    const replay = await this.replayed(actor, data.idempotencyKey, requestHash);
    if (replay) return replay;

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
      const doctorHere = await MemberModel.exists({ partnerId: actor.partnerId, doctorId: data.doctorId, isActive: true });
      if (!doctorHere) throw new AppError({ status: 400, code: 'DOCTOR_NOT_IN_PARTNER', message: 'The doctor does not work at this partner' });
    }

    const catalogueIds = [...new Set(data.items.map((i) => i.catalogItemId).filter(Boolean).map(String))];
    const catalogue = new Map<string, { name: string }>();
    if (catalogueIds.length > 0) {
      const rows = await this.catalogueRepository.findAll({ _id: { $in: catalogueIds }, partnerId: actor.partnerId, isActive: true, adminDisabled: { $ne: true } });
      for (const r of rows) catalogue.set(String(r._id), { name: r.name });
    }

    const lines = computeLines(data.items, catalogue);
    const documentKind = classifyDocument(partner.taxRegime, partner.gstin, lines);
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
          { serial: doc.serial, totalMinor: totals.totalMinor }, session);
      });
    } catch (error: any) {
      if (error?.code === 11000 && error?.keyPattern?.idempotencyKey) {
        const again = await this.replayed(actor, data.idempotencyKey, requestHash);
        if (again) return again;
      }
      throw error;
    } finally {
      await session.endSession();
    }

    if (resolved?.neverSignedIn) await this.sendBillNotice(resolved.phone, partner, invoice!.serial);
    return invoice!;
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

  async recordPayment(
    actor: PartnerActor,
    invoiceId: string,
    data: { mode: PaymentMode; reference?: string; note?: string }
  ): Promise<{ invoice: IInvoice; event: IInvoiceEvent }> {
    return this.transition(actor, invoiceId, ['issued'], 'paid', {
      kind: 'payment', mode: data.mode, reference: data.reference, note: data.note,
    }, 'invoice.pay');
  }

  async cancelInvoice(actor: PartnerActor, invoiceId: string, reason: string): Promise<{ invoice: IInvoice; event: IInvoiceEvent }> {
    return this.transition(actor, invoiceId, ['issued', 'paid'], 'cancelled', { kind: 'cancellation', reason }, 'invoice.cancel');
  }

  /** §6 lifecycle fence: CAS on lifecycleVersion + state, then the event, in one transaction. */
  private async transition(
    actor: PartnerActor,
    invoiceId: string,
    from: InvoiceLifecycleState[],
    to: InvoiceLifecycleState,
    payload: Partial<IInvoiceEvent>,
    action: string
  ): Promise<{ invoice: IInvoice; event: IInvoiceEvent }> {
    const current = await this.loadForActor(actor, invoiceId);
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
        const updated = await this.invoiceRepository.casLifecycle(actor.partnerId, invoiceId, current.lifecycleVersion, current.lifecycleState, to, session);
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
    return { invoice, events };
  }

  async listInvoices(actor: PartnerActor, filter: { state?: InvoiceLifecycleState; branchId?: string; limit?: number; before?: Date }): Promise<IInvoice[]> {
    const query: any = { partnerId: actor.partnerId };
    if (filter.state) query.lifecycleState = filter.state;
    if (filter.branchId) {
      assertBranchInScope(actor, filter.branchId);
      query.branchId = filter.branchId;
    } else if (!hasGlobalScope(actor)) {
      query.branchId = { $in: actor.branchIds };
    }
    if (filter.before) query.issuedAt = { $lt: filter.before };
    const rows = await this.invoiceRepository.findAll(query, { sort: { issuedAt: -1, _id: -1 }, limit: Math.min(filter.limit ?? 50, 200) });
    rows.forEach((r) => this.verifyChecksum(r));
    return rows;
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
    return { items: rows.map((r) => ({ ...r, doctorName: r.doctorId ? names[String(r.doctorId)] : undefined })), page: pg, limit: lim, total,
      totalPages: Math.max(1, Math.ceil(total / lim)) };
  }

  async getCustomerBill(userId: string, invoiceId: string): Promise<{ invoice: IInvoice; events: IInvoiceEvent[] }> {
    const invoice = await this.invoiceRepository.findById(invoiceId);
    if (!invoice || !invoice.customer?.userId || String(invoice.customer.userId) !== String(userId)) throw invoiceNotFound();
    this.verifyChecksum(invoice);
    const doctorName = invoice.doctorId ? (await doctorNames([invoice]))[String(invoice.doctorId)] : undefined;
    return { invoice: { ...invoice, ...(doctorName ? { doctorName } : {}) } as IInvoice, events: await this.invoiceEventRepository.findByInvoice(invoiceId) };
  }

  /** PDF of the bill as of lifecycle `version` (0 = as issued; default = current). */
  async pdfForActor(actor: PartnerActor, invoiceId: string, version?: number): Promise<{ pdf: Buffer; fileName: string }> {
    const { invoice, events } = await this.getInvoice(actor, invoiceId);
    return this.pdf(invoice, events, version);
  }

  async pdfForCustomer(userId: string, invoiceId: string, version?: number): Promise<{ pdf: Buffer; fileName: string }> {
    const { invoice, events } = await this.getCustomerBill(userId, invoiceId);
    return this.pdf(invoice, events, version);
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

