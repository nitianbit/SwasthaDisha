import { Service } from 'typedi';
import { createHash } from 'crypto';
import mongoose from 'mongoose';
import { InvoiceRepository, InvoiceEventRepository, InvoiceCounterRepository } from '@/modules/partners/repository/invoice';
import { PartnerRepository } from '@/modules/partners/repository';
import {
  IInvoice,
  IInvoiceEvent,
  IInvoiceLine,
  IInvoiceTotals,
  IInvoiceSupplier,
  IInvoiceCustomer,
  DocumentKind,
  PaymentMode,
} from '@/modules/partners/types';
import { AppError } from '@/modules/common/types';
import { resolveCustomerByPhone } from '@/modules/partners/services/customerResolver';

@Service()
export class InvoiceService {
  constructor(
    private invoiceRepository: InvoiceRepository,
    private invoiceEventRepository: InvoiceEventRepository,
    private invoiceCounterRepository: InvoiceCounterRepository,
    private partnerRepository: PartnerRepository
  ) {}

  async createInvoice(data: {
    partnerId: string;
    branchId?: string;
    customer: { name: string; phone?: string; gstin?: string; age?: number; gender?: string; placeOfSupply?: string };
    doctorId?: string;
    items: { catalogItemId?: string; description: string; hsn?: string; sac?: string; qty: number; unitPriceMinor: number; discountMinor?: number; gstRate: 0 | 5 | 12 | 18 | 28 }[];
    idempotencyKey: string;
    createdBy: string;
  }): Promise<IInvoice> {
    const existing = await this.invoiceRepository.findByIdempotencyKey(data.partnerId, data.idempotencyKey);
    if (existing) return existing;

    const partner = await this.partnerRepository.findById(data.partnerId);
    if (!partner) {
      throw new AppError({ status: 404, code: 'PARTNER_NOT_FOUND', message: 'Partner not found' });
    }

    const lines = this.computeLines(data.items);
    const documentKind = this.classifyDocument(partner.taxRegime, partner.gstin, lines);
    this.validateLinesForDocumentKind(documentKind, lines);

    const supplierPlaceOfSupply = await this.getSupplierPlaceOfSupply(data.partnerId, data.branchId);
    const sameState = data.customer.placeOfSupply
      ? data.customer.placeOfSupply === supplierPlaceOfSupply
      : true;
    const totals = this.computeTotals(lines, sameState);

    this.validateTotalsForDocumentKind(documentKind, totals);

    const supplier: IInvoiceSupplier = {
      name: partner.name,
      legalName: partner.legalName,
      gstin: partner.gstin,
      pan: partner.pan,
      placeOfSupply: supplierPlaceOfSupply,
    };

    let userId: string | undefined;
    if (data.customer.phone) {
      const resolved = await resolveCustomerByPhone(data.customer.phone, 'partner_invoice');
      userId = resolved?._id ? String(resolved._id) : undefined;
    }

    const customer: IInvoiceCustomer = {
      name: data.customer.name,
      phone: data.customer.phone,
      userId,
      gstin: data.customer.gstin,
      age: data.customer.age,
      gender: data.customer.gender,
      placeOfSupply: data.customer.placeOfSupply,
    };

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const fy = this.currentFinancialYear();
      const seq = await this.invoiceCounterRepository.nextSequence(data.partnerId, fy, session);
      const serial = this.formatSerial(partner.invoiceSeries.prefix, fy, seq);

      const invoiceData: Partial<IInvoice> = {
        partnerId: data.partnerId,
        branchId: data.branchId,
        number: seq,
        financialYear: fy,
        serial,
        documentKind,
        issuedAt: new Date(),
        supplier,
        customer,
        doctorId: data.doctorId,
        items: lines,
        totals,
        lifecycleState: 'issued',
        lifecycleVersion: 0,
        createdBy: data.createdBy,
        checksum: '',
        idempotencyKey: data.idempotencyKey,
      };

      invoiceData.checksum = this.computeChecksum(invoiceData as IInvoice);

      const invoice = await this.invoiceRepository.save(invoiceData, { session });
      await session.commitTransaction();
      return invoice;
    } catch (error: any) {
      await session.abortTransaction();
      if (error.code === 11000 && error.keyPattern?.idempotencyKey) {
        const existing = await this.invoiceRepository.findByIdempotencyKey(data.partnerId, data.idempotencyKey);
        if (existing) return existing;
      }
      throw error;
    } finally {
      session.endSession();
    }
  }

  async recordPayment(
    invoiceId: string,
    data: { mode: PaymentMode; reference?: string; note?: string },
    actorId: string
  ): Promise<{ invoice: IInvoice; event: IInvoiceEvent }> {
    const invoice = await this.invoiceRepository.findById(invoiceId);
    if (!invoice) {
      throw new AppError({ status: 404, code: 'INVOICE_NOT_FOUND', message: 'Invoice not found' });
    }
    if (invoice.lifecycleState !== 'issued') {
      throw new AppError({ status: 409, code: 'INVOICE_STATE_CONFLICT', message: `Cannot record payment on ${invoice.lifecycleState} invoice` });
    }

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const updated = await this.invoiceRepository.casLifecycleVersion(
        invoiceId, invoice.lifecycleVersion, 'paid', session
      );
      if (!updated) {
        throw new AppError({ status: 409, code: 'LIFECYCLE_VERSION_CONFLICT', message: 'Invoice was modified concurrently, please retry' });
      }

      const event = await this.invoiceEventRepository.save(
        {
          invoiceId,
          kind: 'payment',
          mode: data.mode,
          reference: data.reference,
          note: data.note,
          at: new Date(),
          by: actorId,
        } as Partial<IInvoiceEvent>,
        { session }
      );

      await session.commitTransaction();
      return { invoice: updated, event };
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  async cancelInvoice(
    invoiceId: string,
    reason: string,
    actorId: string
  ): Promise<{ invoice: IInvoice; event: IInvoiceEvent }> {
    const invoice = await this.invoiceRepository.findById(invoiceId);
    if (!invoice) {
      throw new AppError({ status: 404, code: 'INVOICE_NOT_FOUND', message: 'Invoice not found' });
    }
    if (invoice.lifecycleState === 'cancelled') {
      throw new AppError({ status: 409, code: 'ALREADY_CANCELLED', message: 'Invoice is already cancelled' });
    }

    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const updated = await this.invoiceRepository.casLifecycleVersion(
        invoiceId, invoice.lifecycleVersion, 'cancelled', session
      );
      if (!updated) {
        throw new AppError({ status: 409, code: 'LIFECYCLE_VERSION_CONFLICT', message: 'Invoice was modified concurrently, please retry' });
      }

      const event = await this.invoiceEventRepository.save(
        {
          invoiceId,
          kind: 'cancellation',
          reason,
          at: new Date(),
          by: actorId,
        } as Partial<IInvoiceEvent>,
        { session }
      );

      await session.commitTransaction();
      return { invoice: updated, event };
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  async getInvoiceWithEvents(invoiceId: string): Promise<{ invoice: IInvoice; events: IInvoiceEvent[] }> {
    const invoice = await this.invoiceRepository.findById(invoiceId);
    if (!invoice) {
      throw new AppError({ status: 404, code: 'INVOICE_NOT_FOUND', message: 'Invoice not found' });
    }
    this.verifyChecksum(invoice);
    const events = await this.invoiceEventRepository.findByInvoice(invoiceId);
    return { invoice, events };
  }

  async listPartnerInvoices(partnerId: string, state?: string): Promise<IInvoice[]> {
    return this.invoiceRepository.findByPartner(partnerId, state);
  }

  async listCustomerBills(userId: string): Promise<IInvoice[]> {
    return this.invoiceRepository.findByCustomerUserId(userId);
  }

  // ── Tax classification (§6) ──

  private classifyDocument(
    taxRegime: string,
    gstin: string | undefined,
    lines: IInvoiceLine[]
  ): DocumentKind {
    const hasVerifiedGstin = !!gstin;
    const hasTaxableLines = lines.some(l => l.gstRate > 0);

    if (taxRegime === 'regular' && hasVerifiedGstin) {
      return hasTaxableLines ? 'tax_invoice' : 'bill_of_supply';
    }
    if (taxRegime === 'composition' && hasVerifiedGstin) {
      return 'bill_of_supply';
    }
    return 'commercial_invoice';
  }

  private validateLinesForDocumentKind(kind: DocumentKind, lines: IInvoiceLine[]): void {
    if (kind === 'commercial_invoice') {
      const hasNonZeroRate = lines.some(l => l.gstRate > 0);
      if (hasNonZeroRate) {
        throw new AppError({
          status: 400,
          code: 'INVALID_TAX_RATES',
          message: 'Unregistered suppliers cannot have nonzero GST rates',
        });
      }
    }
    if (kind === 'bill_of_supply') {
      const hasNonZeroRate = lines.some(l => l.gstRate > 0);
      if (hasNonZeroRate) {
        throw new AppError({
          status: 400,
          code: 'INVALID_TAX_RATES',
          message: 'Composition dealers / exempt-only invoices cannot have nonzero GST rates on a bill of supply',
        });
      }
    }
  }

  private validateTotalsForDocumentKind(kind: DocumentKind, totals: IInvoiceTotals): void {
    if ((kind === 'bill_of_supply' || kind === 'commercial_invoice') &&
        (totals.cgstMinor !== 0 || totals.sgstMinor !== 0 || totals.igstMinor !== 0)) {
      throw new AppError({
        status: 400,
        code: 'TAX_TOTAL_MISMATCH',
        message: 'Bill of supply / commercial invoice cannot have nonzero tax totals',
      });
    }
  }

  // ── Line computation (integer paise) ──

  private computeLines(
    items: { catalogItemId?: string; description: string; hsn?: string; sac?: string; qty: number; unitPriceMinor: number; discountMinor?: number; gstRate: 0 | 5 | 12 | 18 | 28 }[]
  ): IInvoiceLine[] {
    return items.map(item => {
      const discount = item.discountMinor ?? 0;
      const amountMinor = (item.unitPriceMinor * item.qty) - discount;
      return {
        catalogItemId: item.catalogItemId,
        description: item.description,
        hsn: item.hsn,
        sac: item.sac,
        qty: item.qty,
        unitPriceMinor: item.unitPriceMinor,
        discountMinor: discount,
        gstRate: item.gstRate,
        amountMinor,
      };
    });
  }

  private computeTotals(lines: IInvoiceLine[], sameState: boolean): IInvoiceTotals {
    let subtotalMinor = 0;
    let discountMinor = 0;
    let taxableMinor = 0;
    let cgstMinor = 0;
    let sgstMinor = 0;
    let igstMinor = 0;

    for (const line of lines) {
      subtotalMinor += line.unitPriceMinor * line.qty;
      discountMinor += line.discountMinor;
      const lineTaxable = line.amountMinor;
      taxableMinor += lineTaxable;

      const tax = Math.round(lineTaxable * line.gstRate / 100);
      if (sameState) {
        const half = Math.floor(tax / 2);
        cgstMinor += half;
        sgstMinor += tax - half;
      } else {
        igstMinor += tax;
      }
    }

    const totalMinor = taxableMinor + cgstMinor + sgstMinor + igstMinor;

    return {
      subtotalMinor,
      discountMinor,
      taxableMinor,
      cgstMinor,
      sgstMinor,
      igstMinor,
      totalMinor,
      currency: 'INR',
    };
  }

  // ── Financial year & serial ──

  private currentFinancialYear(): string {
    const now = new Date();
    const year = now.getMonth() >= 3 ? now.getFullYear() : now.getFullYear() - 1;
    const nextYear = year + 1;
    return `${String(year).slice(2)}-${String(nextYear).slice(2)}`;
  }

  private formatSerial(prefix: string, fy: string, seq: number): string {
    const serial = `${prefix}/${fy}/${String(seq).padStart(4, '0')}`;
    if (serial.length > 16) {
      throw new AppError({ status: 400, code: 'SERIAL_TOO_LONG', message: 'Invoice serial exceeds 16 characters (CBIC Rule 46)' });
    }
    return serial;
  }

  // ── Checksum ──

  private computeChecksum(invoice: IInvoice): string {
    const payload = JSON.stringify({
      partnerId: invoice.partnerId,
      number: invoice.number,
      financialYear: invoice.financialYear,
      items: invoice.items,
      totals: invoice.totals,
      documentKind: invoice.documentKind,
    });
    return createHash('sha256').update(payload).digest('hex').slice(0, 16);
  }

  private verifyChecksum(invoice: IInvoice): void {
    const expected = this.computeChecksum(invoice);
    if (invoice.checksum !== expected) {
      throw new AppError({ status: 500, code: 'CHECKSUM_MISMATCH', message: 'Invoice integrity check failed' });
    }
  }

  // ── Supplier place of supply ──

  private async getSupplierPlaceOfSupply(_partnerId: string, branchId?: string): Promise<string> {
    if (branchId) {
      const { BranchRepository } = await import('@/modules/partners/repository/branch');
      const branchRepo = new BranchRepository();
      const branch = await branchRepo.findById(branchId);
      if (branch?.address?.stateCode) return branch.address.stateCode;
    }
    return '29';
  }
}
