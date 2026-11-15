/**
 * Q2: In-house invoices — immutable invoice creation, lifecycle CAS, tax classification, numbering, customer
 * resolver, catalogue CRUD on a real MongoDB replica set.
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/q2_invoice_check?directConnection=true' JWT_SECRET_KEY=local-check-only \
 *     npx tsx --tsconfig tsconfig.json test/partners/q2-invoices.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import PartnerModel from '@/modules/partners/model';
import MemberModel from '@/modules/partners/model/member';
import BranchModel from '@/modules/partners/model/branch';
import CatalogueItemModel from '@/modules/partners/model/catalogueItem';
import { InvoiceModel, InvoiceEventModel, InvoiceCounterModel } from '@/modules/partners/model/invoice';
import UserModel from '@/modules/user/model';
import { PartnerRepository } from '@/modules/partners/repository';
import { MemberRepository } from '@/modules/partners/repository/member';
import { BranchRepository } from '@/modules/partners/repository/branch';
import { CatalogueItemRepository } from '@/modules/partners/repository/catalogueItem';
import { InvoiceRepository, InvoiceEventRepository, InvoiceCounterRepository } from '@/modules/partners/repository/invoice';
import { PartnerService } from '@/modules/partners/services';
import { CatalogueService } from '@/modules/partners/services/catalogue';
import { InvoiceService } from '@/modules/partners/services/invoice';
import { normalizePhone } from '@/modules/partners/services/customerResolver';
import { ALL_PERMISSIONS } from '@/modules/partners/types';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/q2_invoice_check?directConnection=true';
const url = process.env.MONGODB_URL ?? '';
if (url !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const partnerRepo = new PartnerRepository();
const memberRepo = new MemberRepository();
const branchRepo = new BranchRepository();
const catalogueRepo = new CatalogueItemRepository();
const invoiceRepo = new InvoiceRepository();
const invoiceEventRepo = new InvoiceEventRepository();
const invoiceCounterRepo = new InvoiceCounterRepository();
const partnerSvc = new PartnerService(partnerRepo, memberRepo, branchRepo);
const catalogueSvc = new CatalogueService(catalogueRepo);
const invoiceSvc = new InvoiceService(invoiceRepo, invoiceEventRepo, invoiceCounterRepo, partnerRepo);

let passed = 0;
async function check(name: string, fn: () => Promise<void>) { await fn(); passed++; console.log('ok -', name); }

let partnerId: string;
let ownerId: string;

async function main() {
  await mongoose.connect(url);
  for (const c of await mongoose.connection.db!.collections()) await c.deleteMany({});
  await Promise.all([
    PartnerModel.init(), MemberModel.init(), BranchModel.init(),
    CatalogueItemModel.init(), InvoiceModel.init(), InvoiceEventModel.init(),
    InvoiceCounterModel.init(), UserModel.init(),
  ]);

  // Setup: create a verified lab partner
  const { partner, owner } = await partnerSvc.createPartner({
    kind: 'lab',
    name: 'Metro Diagnostics',
    legalName: 'Metro Diagnostics Pvt Ltd',
    gstin: '29AABCM1234F1ZH',
    contactPhone: '9876543210',
    taxRegime: 'regular',
    invoiceSeriesPrefix: 'MD',
    firstOwner: { phone: '9876543210', name: 'Dr. Metro' },
  });
  await partnerSvc.verifyPartner(partner._id!, 'admin');
  partnerId = String(partner._id);
  ownerId = String(owner._id);

  // ── Catalogue ──

  await check('create catalogue item for lab', async () => {
    const item = await catalogueSvc.createItem(partnerId, {
      kind: 'test',
      name: 'CBC (Complete Blood Count)',
      code: 'CBC',
      priceMinor: 50000,
      gstRate: 5,
      sac: '998931',
      visitModes: ['lab', 'home'],
      reportTatHours: 24,
    });
    assert.equal(item.name, 'CBC (Complete Blood Count)');
    assert.equal(item.priceMinor, 50000);
    assert.equal(item.isActive, true);
  });

  await check('list catalogue items', async () => {
    const items = await catalogueSvc.listItems(partnerId);
    assert.equal(items.length, 1);
    assert.equal(items[0].code, 'CBC');
  });

  await check('update catalogue item price', async () => {
    const items = await catalogueSvc.listItems(partnerId);
    const updated = await catalogueSvc.updateItem(partnerId, items[0]._id!, { priceMinor: 55000 } as any);
    assert.equal(updated.priceMinor, 55000);
  });

  await check('deactivate catalogue item hides it from list', async () => {
    const item = await catalogueSvc.createItem(partnerId, {
      kind: 'test',
      name: 'Lipid Panel',
      priceMinor: 80000,
      gstRate: 5,
      visitModes: ['lab'],
    });
    await catalogueSvc.deactivateItem(partnerId, item._id!);
    const items = await catalogueSvc.listItems(partnerId);
    assert.ok(items.every(i => i.name !== 'Lipid Panel'));
  });

  // ── Phone normalization ──

  await check('normalizePhone strips +91 and 0 prefix', () => {
    assert.equal(normalizePhone('+919876543210'), '9876543210');
    assert.equal(normalizePhone('919876543210'), '9876543210');
    assert.equal(normalizePhone('09876543210'), '9876543210');
    assert.equal(normalizePhone('9876543210'), '9876543210');
    return Promise.resolve();
  });

  // ── Invoice creation with tax classification ──

  await check('tax_invoice for regular + GSTIN + taxable lines', async () => {
    const invoice = await invoiceSvc.createInvoice({
      partnerId,
      customer: { name: 'Ravi Kumar', phone: '8888877777', placeOfSupply: '29' },
      items: [
        { description: 'CBC', qty: 1, unitPriceMinor: 50000, gstRate: 5 },
      ],
      idempotencyKey: 'inv-001',
      createdBy: ownerId,
    });
    assert.equal(invoice.documentKind, 'tax_invoice');
    assert.equal(invoice.totals.taxableMinor, 50000);
    assert.equal(invoice.totals.cgstMinor, 1250);
    assert.equal(invoice.totals.sgstMinor, 1250);
    assert.equal(invoice.totals.igstMinor, 0);
    assert.equal(invoice.totals.totalMinor, 52500);
    assert.equal(invoice.lifecycleState, 'issued');
    assert.equal(invoice.lifecycleVersion, 0);
    assert.ok(invoice.serial.startsWith('MD/'));
    assert.ok(invoice.serial.length <= 16);
    assert.ok(invoice.checksum.length > 0);
  });

  await check('idempotency key returns same invoice', async () => {
    const invoice1 = await invoiceSvc.createInvoice({
      partnerId,
      customer: { name: 'Ravi Kumar', phone: '8888877777' },
      items: [{ description: 'CBC', qty: 1, unitPriceMinor: 50000, gstRate: 5 }],
      idempotencyKey: 'inv-001',
      createdBy: ownerId,
    });
    assert.equal(invoice1.serial, (await invoiceRepo.findByIdempotencyKey(partnerId, 'inv-001'))!.serial);
  });

  await check('IGST when supplier and customer in different states', async () => {
    const invoice = await invoiceSvc.createInvoice({
      partnerId,
      customer: { name: 'Priya S', phone: '7777766666', placeOfSupply: '27' },
      items: [{ description: 'Thyroid Panel', qty: 1, unitPriceMinor: 100000, gstRate: 18 }],
      idempotencyKey: 'inv-002',
      createdBy: ownerId,
    });
    assert.equal(invoice.totals.cgstMinor, 0);
    assert.equal(invoice.totals.sgstMinor, 0);
    assert.equal(invoice.totals.igstMinor, 18000);
    assert.equal(invoice.totals.totalMinor, 118000);
  });

  await check('sequential numbering within same FY', async () => {
    const inv = await invoiceSvc.createInvoice({
      partnerId,
      customer: { name: 'Test Seq' },
      items: [{ description: 'Test', qty: 1, unitPriceMinor: 10000, gstRate: 5 }],
      idempotencyKey: 'inv-003',
      createdBy: ownerId,
    });
    assert.ok(inv.number >= 3);
  });

  // ── Invoice lifecycle CAS ──

  await check('record payment transitions issued → paid', async () => {
    const inv = await invoiceSvc.createInvoice({
      partnerId,
      customer: { name: 'Pay Test' },
      items: [{ description: 'Blood Sugar', qty: 1, unitPriceMinor: 20000, gstRate: 0 }],
      idempotencyKey: 'inv-pay-001',
      createdBy: ownerId,
    });
    const { invoice, event } = await invoiceSvc.recordPayment(inv._id!, { mode: 'cash' }, ownerId);
    assert.equal(invoice.lifecycleState, 'paid');
    assert.equal(invoice.lifecycleVersion, 1);
    assert.equal(event.kind, 'payment');
    assert.equal(event.mode, 'cash');
  });

  await check('cannot pay already-paid invoice', async () => {
    const invoices = await invoiceRepo.findByPartner(partnerId, 'paid');
    const paidInvoice = invoices[0];
    await assert.rejects(
      () => invoiceSvc.recordPayment(paidInvoice._id!, { mode: 'upi' }, ownerId),
      (e: any) => e.code === 'INVOICE_STATE_CONFLICT'
    );
  });

  await check('cancel issued invoice transitions issued → cancelled', async () => {
    const inv = await invoiceSvc.createInvoice({
      partnerId,
      customer: { name: 'Cancel Test' },
      items: [{ description: 'X-Ray', qty: 1, unitPriceMinor: 80000, gstRate: 18 }],
      idempotencyKey: 'inv-cancel-001',
      createdBy: ownerId,
    });
    const { invoice, event } = await invoiceSvc.cancelInvoice(inv._id!, 'Wrong patient', ownerId);
    assert.equal(invoice.lifecycleState, 'cancelled');
    assert.equal(invoice.lifecycleVersion, 1);
    assert.equal(event.kind, 'cancellation');
    assert.equal(event.reason, 'Wrong patient');
  });

  await check('cancel paid invoice transitions paid → cancelled', async () => {
    const inv = await invoiceSvc.createInvoice({
      partnerId,
      customer: { name: 'Cancel Paid' },
      items: [{ description: 'ECG', qty: 1, unitPriceMinor: 30000, gstRate: 0 }],
      idempotencyKey: 'inv-cancel-paid-001',
      createdBy: ownerId,
    });
    await invoiceSvc.recordPayment(inv._id!, { mode: 'card', reference: 'TXN123' }, ownerId);
    const { invoice } = await invoiceSvc.cancelInvoice(inv._id!, 'Duplicate billing', ownerId);
    assert.equal(invoice.lifecycleState, 'cancelled');
    assert.equal(invoice.lifecycleVersion, 2);
  });

  await check('cannot cancel already-cancelled invoice', async () => {
    const invoices = await invoiceRepo.findByPartner(partnerId, 'cancelled');
    await assert.rejects(
      () => invoiceSvc.cancelInvoice(invoices[0]._id!, 'Again', ownerId),
      (e: any) => e.code === 'ALREADY_CANCELLED'
    );
  });

  // ── Tax classification variants ──

  await check('unregistered partner produces commercial_invoice and rejects nonzero tax', async () => {
    const { partner: unreg } = await partnerSvc.createPartner({
      kind: 'lab',
      name: 'Village Clinic',
      contactPhone: '5555544444',
      taxRegime: 'unregistered',
      invoiceSeriesPrefix: 'VC',
      firstOwner: { phone: '5555544444', name: 'Dr. Village' },
    });
    const unregId = String(unreg._id);

    const inv = await invoiceSvc.createInvoice({
      partnerId: unregId,
      customer: { name: 'Walk-in' },
      items: [{ description: 'Consultation', qty: 1, unitPriceMinor: 50000, gstRate: 0 }],
      idempotencyKey: 'unreg-001',
      createdBy: ownerId,
    });
    assert.equal(inv.documentKind, 'commercial_invoice');
    assert.equal(inv.totals.cgstMinor, 0);

    await assert.rejects(
      () => invoiceSvc.createInvoice({
        partnerId: unregId,
        customer: { name: 'Walk-in' },
        items: [{ description: 'Test', qty: 1, unitPriceMinor: 10000, gstRate: 5 }],
        idempotencyKey: 'unreg-002',
        createdBy: ownerId,
      }),
      (e: any) => e.code === 'INVALID_TAX_RATES'
    );
  });

  await check('regular partner with all-exempt lines produces bill_of_supply', async () => {
    const inv = await invoiceSvc.createInvoice({
      partnerId,
      customer: { name: 'Exempt Test' },
      items: [{ description: 'Exempt Service', qty: 1, unitPriceMinor: 40000, gstRate: 0 }],
      idempotencyKey: 'exempt-001',
      createdBy: ownerId,
    });
    assert.equal(inv.documentKind, 'bill_of_supply');
    assert.equal(inv.totals.totalMinor, 40000);
  });

  // ── Checksum verification ──

  await check('getInvoiceWithEvents verifies checksum', async () => {
    const invoices = await invoiceRepo.findByPartner(partnerId);
    const { invoice, events } = await invoiceSvc.getInvoiceWithEvents(invoices[0]._id!);
    assert.ok(invoice.checksum);
    assert.ok(Array.isArray(events));
  });

  // ── Walk-in customer resolver ──

  await check('invoice with phone resolves or creates customer userId', async () => {
    const inv = await invoiceSvc.createInvoice({
      partnerId,
      customer: { name: 'New Customer', phone: '9999988888' },
      items: [{ description: 'HbA1c', qty: 1, unitPriceMinor: 70000, gstRate: 5 }],
      idempotencyKey: 'walkin-001',
      createdBy: ownerId,
    });
    assert.ok(inv.customer.userId);
    const user = await UserModel.findById(inv.customer.userId).lean() as any;
    assert.equal(user?.phone, '9999988888');
  });

  // ── Customer bills ──

  await check('listCustomerBills returns invoices for userId', async () => {
    const inv = await invoiceRepo.findByPartner(partnerId);
    const withUser = inv.find(i => i.customer.userId);
    if (withUser) {
      const bills = await invoiceSvc.listCustomerBills(withUser.customer.userId!);
      assert.ok(bills.length > 0);
    }
  });

  await mongoose.disconnect();
  console.log(`\n${passed} checks passed`);
}

main().catch(async (e) => { console.error(e); await mongoose.disconnect(); process.exit(1); });
