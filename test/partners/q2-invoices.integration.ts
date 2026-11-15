/**
 * Q2: in-house invoices — catalogue, tax classification, IST financial year and CBIC serials, idempotency, lifecycle
 * fence under concurrency, partner/branch scope, checksum, walk-in linking (index-gated resolver, migration script),
 * bill notice, admin-as-owner, PDF/HTML rendering, customer Bills over HTTP. Real MongoDB replica set.
 *
 * Run (throwaway DB only; the script drops its collections):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/q2_invoice_check?directConnection=true' JWT_SECRET_KEY=local-check-only \
 *     npx tsx --tsconfig tsconfig.json test/partners/q2-invoices.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import { Container } from 'typedi';
import { CONFIG } from '@/config/config';
import { authenticate, denyRoles } from '@/modules/middleware/auth';
import { errorHandler } from '@/modules/middleware';
import PartnerModel from '@/modules/partners/model';
import MemberModel from '@/modules/partners/model/member';
import BranchModel from '@/modules/partners/model/branch';
import PartnerAuditEventModel from '@/modules/partners/model/audit';
import CatalogueItemModel from '@/modules/partners/model/catalogueItem';
import { InvoiceModel, InvoiceEventModel, InvoiceCounterModel } from '@/modules/partners/model/invoice';
import UserModel from '@/modules/user/model';
import { PartnerRepository } from '@/modules/partners/repository';
import { MemberRepository } from '@/modules/partners/repository/member';
import { BranchRepository } from '@/modules/partners/repository/branch';
import { CatalogueItemRepository } from '@/modules/partners/repository/catalogueItem';
import { InvoiceRepository, InvoiceEventRepository, InvoiceCounterRepository } from '@/modules/partners/repository/invoice';
import { PartnerService, PartnerActor, adminActor } from '@/modules/partners/services';
import { CatalogueService } from '@/modules/partners/services/catalogue';
import { InvoiceService, financialYearOf, formatSerial, eventsAsOf, doctorNames } from '@/modules/partners/services/invoice';
import { renderInvoiceHtml, renderInvoicePdf, indiaDate } from '@/modules/partners/services/invoicePdf';
import { normalizePhone, resetCustomerPhoneIndexCache } from '@/modules/partners/services/customerResolver';
import { SMSService } from '@/modules/sms/services';
import { runPhoneMigration } from '@/scripts/q2UserPhoneIndex';
import { IMember, PartnerPermission } from '@/modules/partners/types';
import partnerWorkspaceRouter, { customerBillsRouter } from '@/modules/partners/routes';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/q2_invoice_check?directConnection=true';
const url = process.env.MONGODB_URL ?? '';
if (url !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const partnerRepo = new PartnerRepository();
const memberRepo = new MemberRepository();
const branchRepo = new BranchRepository();
const catalogueRepo = new CatalogueItemRepository();
const invoiceRepo = new InvoiceRepository();
const partnerSvc = new PartnerService(partnerRepo, memberRepo, branchRepo);
const catalogueSvc = new CatalogueService(catalogueRepo);
const sent: { to: string; text: string; templateId?: string }[] = [];
const sms = new SMSService();
sms.sendSMS = async (p) => { sent.push(p); return { success: true, data: null }; };
const invoiceSvc = new InvoiceService(invoiceRepo, new InvoiceEventRepository(), new InvoiceCounterRepository(), partnerRepo, branchRepo, catalogueRepo, sms);
// tsx emits no decorator metadata; production (tsc) resolves these through typedi.
Container.set(PartnerService, partnerSvc);
Container.set(CatalogueService, catalogueSvc);
Container.set(InvoiceService, invoiceSvc);

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) { await fn(); passed++; console.log('ok -', name); }
const code = (c: string) => (e: any) => e?.code === c;
const actorFor = (m: IMember): PartnerActor => ({ memberId: String(m._id), partnerId: String(m.partnerId), role: m.role,
  permissions: m.permissions as PartnerPermission[], branchIds: (m.branchIds ?? []).map(String) });
const branchInput = (name: string, stateCode: string, state: string) => ({
  name, phone: '9876500000', holidays: [], hours: {}, services: { homeCollection: true, inLab: true, inClinic: false },
  address: { line1: `1 ${name} Road`, city: 'City', state, stateCode, pincode: '560001' },
}) as any;
let keySeq = 0;
const key = () => `k-${++keySeq}`;
const line = (over: Partial<{ description: string; qty: number; unitPriceMinor: number; gstRate: 0 | 5 | 12 | 18 | 28; discountMinor: number; catalogItemId: string }> = {}) =>
  ({ description: 'CBC', qty: 1, unitPriceMinor: 50000, gstRate: 5 as const, ...over });

async function setupPartner(name: string, prefix: string, ownerPhone: string, tax: { taxRegime: 'regular' | 'composition' | 'unregistered'; gstin?: string }) {
  const { partner, owner } = await partnerSvc.createPartner({
    kind: 'lab', name, contactPhone: ownerPhone, invoiceSeriesPrefix: prefix, firstOwner: { phone: ownerPhone, name: `${name} owner` },
    taxRegime: tax.taxRegime, gstin: tax.gstin,
  });
  await partnerSvc.verifyPartner(String(partner._id), 'admin');
  const actor = actorFor(owner);
  const branch = await partnerSvc.createBranch(actor, branchInput(`${name} Main`, '29', 'Karnataka'));
  return { partnerId: String(partner._id), owner, actor, branchId: String(branch._id) };
}

async function main() {
  await mongoose.connect(url, { autoIndex: false });
  for (const c of await mongoose.connection.db!.collections()) await c.drop().catch(() => {});
  const models = [PartnerModel, MemberModel, BranchModel, PartnerAuditEventModel, CatalogueItemModel, InvoiceModel, InvoiceEventModel, InvoiceCounterModel] as mongoose.Model<any>[];
  for (const M of models) { await M.createCollection(); await M.createIndexes(); }
  await UserModel.createCollection();

  // ── §6a migration script, before the unique index exists ──
  await check('phone migration: dry run reports, commit rewrites only non-colliding rows, duplicates listed by id', async () => {
    // Legacy rows as stored before Q2 (raw: the model now canonicalises every phone it writes).
    const raw = async (doc: Record<string, unknown>) => ({ _id: (await UserModel.collection.insertOne({ ...doc } as never)).insertedId });
    const plain = await raw({ phone: '+91 98450 00001', userType: 'user' });
    const dupA = await raw({ phone: '9845000002', userType: 'user' });
    const dupB = await raw({ phone: '09845000002', userType: 'user' });
    await raw({ email: 'only@example.com', userType: 'user' });
    const dry = await runPhoneMigration(false);
    assert.equal(dry.rewritable, 1);
    assert.equal(dry.rewritten, 0);
    assert.deepEqual(dry.duplicateGroups.map((g) => g.sort()), [[String(dupA._id), String(dupB._id)].sort()]);
    const committed = await runPhoneMigration(true);
    assert.equal(committed.rewritten, 1);
    assert.equal((await UserModel.collection.findOne({ _id: plain._id }) as any).phone, '9845000001');
    assert.equal((await UserModel.collection.findOne({ _id: dupB._id }) as any).phone, '09845000002', 'duplicates are never rewritten');
    await UserModel.deleteMany({ _id: { $in: [dupA._id, dupB._id] } }); // "admin resolution" for the fixture
    const clean = await runPhoneMigration(false);
    assert.equal(clean.duplicateGroups.length, 0);
    assert.equal(clean.rewritable, 0);
  });

  const lab = await setupPartner('Metro Diagnostics', 'MD', '9876543210', { taxRegime: 'regular', gstin: '29AABCM1234F1ZH' });
  const branchB = await partnerSvc.createBranch(lab.actor, branchInput('Mysuru Centre', '29', 'Karnataka'));
  const B = String(branchB._id);
  const P = String((await partnerSvc.createBranch(lab.actor, branchInput('Pune Centre', '27', 'Maharashtra')))._id);

  await check('resolver refuses to run until the unique phone index is ready (503); bills without a phone still work', async () => {
    resetCustomerPhoneIndexCache();
    await assert.rejects(() => invoiceSvc.createInvoice(lab.actor, {
      branchId: lab.branchId, customer: { name: 'Walk-in', phone: '9811100001' }, items: [line()], idempotencyKey: key(),
    }), code('CUSTOMER_LINKING_UNAVAILABLE'));
    const noPhone = await invoiceSvc.createInvoice(lab.actor, { branchId: lab.branchId, customer: { name: 'Anon' }, items: [line()], idempotencyKey: key() });
    assert.equal(noPhone.customer.userId, undefined);
    await UserModel.createIndexes();
    resetCustomerPhoneIndexCache();
  });

  // ── Catalogue ──
  let cbcId = '';
  await check('catalogue CRUD, MRP rule, admin disable visible to partner but not billable, admin enable', async () => {
    const item = await catalogueSvc.createItem(lab.actor, { kind: 'test', name: 'CBC', code: 'CBC', priceMinor: 50000, mrpMinor: 60000, gstRate: 5, visitModes: ['lab', 'home'] });
    cbcId = String(item._id);
    await assert.rejects(() => catalogueSvc.createItem(lab.actor, { kind: 'test', name: 'Bad', priceMinor: 500, mrpMinor: 100, gstRate: 0, visitModes: ['lab'] }), code('INVALID_MRP'));
    const upd = await catalogueSvc.updateItem(lab.actor, cbcId, { priceMinor: 55000 });
    assert.equal(upd.priceMinor, 55000);
    const lipid = await catalogueSvc.createItem(lab.actor, { kind: 'test', name: 'Lipid', priceMinor: 80000, gstRate: 5, visitModes: ['lab'] });
    await catalogueSvc.deactivateItem(lab.actor, String(lipid._id));
    assert.deepEqual((await catalogueSvc.listItems(lab.actor)).map((i) => i.name), ['CBC']);
    await catalogueSvc.setAdminDisabled('adm', cbcId, true);
    const seen = await catalogueSvc.listItems(lab.actor);
    assert.equal(seen[0]!.adminDisabled, true, 'partner still sees the item, flagged');
    await assert.rejects(() => invoiceSvc.createInvoice(lab.actor, {
      branchId: lab.branchId, customer: { name: 'X' }, items: [line({ catalogItemId: cbcId })], idempotencyKey: key(),
    }), code('CATALOGUE_ITEM_NOT_FOUND'));
    await catalogueSvc.setAdminDisabled('adm', cbcId, false);
    const other = await setupPartner('Other Lab', 'OL', '9000000099', { taxRegime: 'unregistered' });
    await assert.rejects(() => catalogueSvc.getItem(other.actor, cbcId), code('CATALOGUE_ITEM_NOT_FOUND'));
    await assert.rejects(() => invoiceSvc.createInvoice(other.actor, {
      branchId: other.branchId, customer: { name: 'X' }, items: [line({ catalogItemId: cbcId, gstRate: 0 })], idempotencyKey: key(),
    }), code('CATALOGUE_ITEM_NOT_FOUND'));
  });

  await check('catalogue writes roll back when their audit write fails', async () => {
    const original = PartnerAuditEventModel.create.bind(PartnerAuditEventModel);
    const before = await CatalogueItemModel.find({ partnerId: lab.partnerId }).lean();
    (PartnerAuditEventModel as any).create = async () => { throw new Error('audit store down'); };
    try {
      await assert.rejects(() => catalogueSvc.createItem(lab.actor, { kind: 'test', name: 'Ghost', priceMinor: 1, gstRate: 0, visitModes: ['lab'] }));
      await assert.rejects(() => catalogueSvc.updateItem(lab.actor, cbcId, { priceMinor: 1 }));
      await assert.rejects(() => catalogueSvc.deactivateItem(lab.actor, cbcId));
      await assert.rejects(() => catalogueSvc.setAdminDisabled('adm', cbcId, true));
    } finally {
      (PartnerAuditEventModel as any).create = original;
    }
    const after = await CatalogueItemModel.find({ partnerId: lab.partnerId }).lean();
    assert.deepEqual(after.map((i) => [String(i._id), i.priceMinor, i.isActive, i.adminDisabled]),
      before.map((i) => [String(i._id), i.priceMinor, i.isActive, i.adminDisabled]));
  });

  // ── Pure rules ──
  await check('phone normalisation and IST financial-year boundary; serial ≤ 16 chars', () => {
    for (const p of ['+919876543210', '919876543210', '09876543210', '98765 43210', '9876543210']) assert.equal(normalizePhone(p), '9876543210');
    assert.throws(() => normalizePhone('12345'), code('INVALID_PHONE'));
    assert.equal(financialYearOf(new Date('2027-03-31T18:29:00Z')), '2627'); // 23:59 IST on 31 March
    assert.equal(financialYearOf(new Date('2027-03-31T18:31:00Z')), '2728'); // 00:01 IST on 1 April
    assert.equal(formatSerial('ABCDEF', '2627', 9999), 'ABCDEF/2627/9999');
    assert.throws(() => formatSerial('ABCDEF', '2627', 10000), code('SERIAL_EXHAUSTED'));
  });

  // ── Classification and totals ──
  let first: any;
  await check('regular + GSTIN + taxable → tax invoice; CGST/SGST intra-state; supplier from the branch', async () => {
    first = await invoiceSvc.createInvoice(lab.actor, {
      branchId: lab.branchId, customer: { name: 'Ravi Kumar' },
      items: [line({ catalogItemId: cbcId, unitPriceMinor: 50001 }), line({ description: 'Consult', unitPriceMinor: 30000, gstRate: 0 })],
      idempotencyKey: 'inv-001',
    });
    assert.equal(first.documentKind, 'tax_invoice');
    assert.equal(first.totals.taxableMinor, 80001);
    assert.equal(first.totals.cgstMinor + first.totals.sgstMinor, 2500); // round(50001*5/100)=2500
    assert.equal(first.totals.igstMinor, 0);
    assert.equal(first.totals.totalMinor, 82501);
    assert.equal(first.supplier.placeOfSupply, '29');
    assert.ok(first.supplier.address.includes('Metro Diagnostics Main Road'));
    assert.equal(first.supplier.gstin, '29AABCM1234F1ZH');
    assert.match(first.serial, /^MD\/\d{4}\/\d{4}$/);
    assert.ok(first.serial.length <= 16);
    assert.equal(first.checksum.length, 64);
  });

  await check('IGST when the customer state differs; a branch outside the GSTIN\'s state cannot issue GST bills', async () => {
    const inter = await invoiceSvc.createInvoice(lab.actor, {
      branchId: lab.branchId, customer: { name: 'Priya', placeOfSupply: '27' }, items: [line({ unitPriceMinor: 100000, gstRate: 18 })], idempotencyKey: key(),
    });
    assert.deepEqual([inter.totals.cgstMinor, inter.totals.sgstMinor, inter.totals.igstMinor], [0, 0, 18000]);
    await assert.rejects(() => invoiceSvc.createInvoice(lab.actor, {
      branchId: P, customer: { name: 'Pune walk-in' }, items: [line({ unitPriceMinor: 100000, gstRate: 18 })], idempotencyKey: key(),
    }), code('GST_REGISTRATION_STATE_MISMATCH'));
    await assert.rejects(() => invoiceSvc.createInvoice(lab.actor, {
      branchId: P, customer: { name: 'Pune exempt' }, items: [line({ gstRate: 0 })], idempotencyKey: key(),
    }), code('GST_REGISTRATION_STATE_MISMATCH'), 'a bill of supply prints the GSTIN too');
    const unreg = await setupPartner('Two State Clinic', 'TS', '9000000020', { taxRegime: 'unregistered' });
    const pune2 = await partnerSvc.createBranch(unreg.actor, branchInput('TS Pune', '27', 'Maharashtra'));
    const c = await invoiceSvc.createInvoice(unreg.actor, { branchId: String(pune2._id), customer: { name: 'P' }, items: [line({ gstRate: 0 })], idempotencyKey: key() });
    assert.equal(c.supplier.placeOfSupply, '27', 'an unregistered supplier bills from any state');
  });

  await check('regular all-exempt → bill of supply; composition → bill of supply; unregistered → commercial invoice; nonzero GST refused', async () => {
    const exempt = await invoiceSvc.createInvoice(lab.actor, { branchId: lab.branchId, customer: { name: 'E' }, items: [line({ gstRate: 0 })], idempotencyKey: key() });
    assert.equal(exempt.documentKind, 'bill_of_supply');
    const comp = await setupPartner('Comp Clinic', 'CC', '9000000011', { taxRegime: 'composition', gstin: '29AABCC1234F1ZH' });
    const c = await invoiceSvc.createInvoice(comp.actor, { branchId: comp.branchId, customer: { name: 'C' }, items: [line({ gstRate: 0 })], idempotencyKey: key() });
    assert.equal(c.documentKind, 'bill_of_supply');
    await assert.rejects(() => invoiceSvc.createInvoice(comp.actor, { branchId: comp.branchId, customer: { name: 'C' }, items: [line()], idempotencyKey: key() }), code('INVALID_TAX_RATES'));
    const unreg = await setupPartner('Village Lab', 'VL', '9000000012', { taxRegime: 'unregistered', gstin: '29AABCV1234F1ZH' });
    const u = await invoiceSvc.createInvoice(unreg.actor, { branchId: unreg.branchId, customer: { name: 'U' }, items: [line({ gstRate: 0 })], idempotencyKey: key() });
    assert.equal(u.documentKind, 'commercial_invoice');
    assert.equal(u.supplier.gstin, undefined, 'no GSTIN on a commercial invoice');
    await assert.rejects(() => invoiceSvc.createInvoice(unreg.actor, { branchId: unreg.branchId, customer: { name: 'U' }, items: [line()], idempotencyKey: key() }), code('INVALID_TAX_RATES'));
  });

  await check('line and reference validation: discount ≤ amount; doctor must work at the partner', async () => {
    await assert.rejects(() => invoiceSvc.createInvoice(lab.actor, { branchId: lab.branchId, customer: { name: 'D' }, items: [line({ discountMinor: 50001 })], idempotencyKey: key() }), code('INVALID_LINE_AMOUNT'));
    await assert.rejects(() => invoiceSvc.createInvoice(lab.actor, { branchId: lab.branchId, customer: { name: 'D' }, doctorId: new Types.ObjectId().toString(), items: [line()], idempotencyKey: key() }), code('DOCTOR_NOT_IN_PARTNER'));
  });

  // ── Idempotency and numbering under concurrency ──
  await check('same key + same request → same invoice; same key + different request → 409', async () => {
    const again = await invoiceSvc.createInvoice(lab.actor, {
      branchId: lab.branchId, customer: { name: 'Ravi Kumar' },
      items: [line({ catalogItemId: cbcId, unitPriceMinor: 50001 }), line({ description: 'Consult', unitPriceMinor: 30000, gstRate: 0 })],
      idempotencyKey: 'inv-001',
    });
    assert.equal(String(again._id), String(first._id));
    await assert.rejects(() => invoiceSvc.createInvoice(lab.actor, { branchId: lab.branchId, customer: { name: 'Someone else' }, items: [line()], idempotencyKey: 'inv-001' }),
      code('IDEMPOTENCY_KEY_REUSED'));
  });

  await check('parallel creates: gap-free unique numbers; parallel same-key creates: one invoice', async () => {
    const seq = await setupPartner('Busy Lab', 'BL', '9000000013', { taxRegime: 'unregistered' });
    const made = await Promise.all(Array.from({ length: 12 }, (_, i) =>
      invoiceSvc.createInvoice(seq.actor, { branchId: seq.branchId, customer: { name: `P${i}` }, items: [line({ gstRate: 0 })], idempotencyKey: `p-${i}` })));
    assert.deepEqual(made.map((m) => m.number).sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => i + 1));
    const same = await Promise.allSettled(Array.from({ length: 6 }, () =>
      invoiceSvc.createInvoice(seq.actor, { branchId: seq.branchId, customer: { name: 'Same' }, items: [line({ gstRate: 0 })], idempotencyKey: 'same-key' })));
    const ids = new Set(same.filter((r) => r.status === 'fulfilled').map((r: any) => String(r.value._id)));
    assert.equal(ids.size, 1);
    assert.equal(await InvoiceModel.countDocuments({ partnerId: seq.partnerId, idempotencyKey: 'same-key' }), 1);
    assert.equal((await InvoiceCounterModel.findOne({ partnerId: seq.partnerId }).lean())!.seq, 13, 'losing transactions leave no gaps');
  });

  await check('a full series is refused and the counter does not move', async () => {
    const full = await setupPartner('Full Series', 'FULLSR', '9000000014', { taxRegime: 'unregistered' });
    const fy = financialYearOf(new Date());
    await InvoiceCounterModel.create({ partnerId: full.partnerId, financialYear: fy, seq: 9999 });
    await assert.rejects(() => invoiceSvc.createInvoice(full.actor, { branchId: full.branchId, customer: { name: 'F' }, items: [line({ gstRate: 0 })], idempotencyKey: key() }), code('SERIAL_EXHAUSTED'));
    assert.equal((await InvoiceCounterModel.findOne({ partnerId: full.partnerId }).lean())!.seq, 9999);
  });

  // ── Lifecycle fence ──
  await check('issued → paid → cancelled; repeats refused; events record the member', async () => {
    const inv = await invoiceSvc.createInvoice(lab.actor, { branchId: lab.branchId, customer: { name: 'Pay' }, items: [line()], idempotencyKey: key() });
    const paid = await invoiceSvc.recordPayment(lab.actor, String(inv._id), { mode: 'upi', reference: 'UPI123' });
    assert.equal(paid.invoice.lifecycleState, 'paid');
    assert.equal(paid.invoice.lifecycleVersion, 1);
    assert.equal(paid.event.byKind, 'member');
    assert.equal(paid.event.by, lab.actor.memberId);
    await assert.rejects(() => invoiceSvc.recordPayment(lab.actor, String(inv._id), { mode: 'cash' }), code('INVOICE_STATE_CONFLICT'));
    const cancelled = await invoiceSvc.cancelInvoice(lab.actor, String(inv._id), 'Duplicate billing');
    assert.equal(cancelled.invoice.lifecycleVersion, 2);
    await assert.rejects(() => invoiceSvc.cancelInvoice(lab.actor, String(inv._id), 'again'), code('ALREADY_CANCELLED'));
    const { events } = await invoiceSvc.getInvoice(lab.actor, String(inv._id));
    assert.deepEqual(events.map((e) => e.kind), ['payment', 'cancellation']);
  });

  await check('concurrent payment vs cancellation: one event per lifecycle version, never two at the same version', async () => {
    for (let i = 0; i < 5; i++) {
      const inv = await invoiceSvc.createInvoice(lab.actor, { branchId: lab.branchId, customer: { name: `Race ${i}` }, items: [line()], idempotencyKey: key() });
      const id = String(inv._id);
      const r = await Promise.allSettled([invoiceSvc.recordPayment(lab.actor, id, { mode: 'cash' }), invoiceSvc.cancelInvoice(lab.actor, id, 'race')]);
      const ok = r.filter((x) => x.status === 'fulfilled').length;
      const events = await InvoiceEventModel.countDocuments({ invoiceId: id });
      const after = await InvoiceModel.findById(id).lean();
      assert.ok(ok >= 1 && ok <= 2);
      assert.equal(events, after!.lifecycleVersion, 'one event per version step');
      if (ok === 1) assert.ok(r.some((x) => x.status === 'rejected' && ['LIFECYCLE_VERSION_CONFLICT', 'INVOICE_STATE_CONFLICT', 'ALREADY_CANCELLED'].includes((x as any).reason?.code)));
    }
  });

  // ── Tenancy and branch scope ──
  await check('another partner cannot read, pay or cancel this partner\'s bill (404)', async () => {
    const other = await setupPartner('Rival Lab', 'RL', '9000000015', { taxRegime: 'unregistered' });
    const id = String(first._id);
    await assert.rejects(() => invoiceSvc.getInvoice(other.actor, id), code('INVOICE_NOT_FOUND'));
    await assert.rejects(() => invoiceSvc.recordPayment(other.actor, id, { mode: 'cash' }), code('INVOICE_NOT_FOUND'));
    await assert.rejects(() => invoiceSvc.cancelInvoice(other.actor, id, 'x'), code('INVOICE_NOT_FOUND'));
    await assert.rejects(() => invoiceSvc.createInvoice(other.actor, { branchId: lab.branchId, customer: { name: 'x' }, items: [line({ gstRate: 0 })], idempotencyKey: key() }), code('BRANCH_NOT_FOUND'));
    assert.equal((await InvoiceModel.findById(id).lean())!.lifecycleState, 'issued');
  });

  let deskA: IMember;
  await check('branch-restricted staff bill and see only their branches', async () => {
    deskA = await partnerSvc.addMember(lab.actor, { phone: '9000000016', name: 'Desk A', role: 'staff', branchIds: [lab.branchId],
      permissions: ['invoices.create', 'payments.record', 'invoices.cancel'] });
    const a = actorFor(deskA);
    await assert.rejects(() => invoiceSvc.createInvoice(a, { branchId: B, customer: { name: 'x' }, items: [line()], idempotencyKey: key() }), code('BRANCH_SCOPE_EXCEEDED'));
    await invoiceSvc.createInvoice(lab.actor, { branchId: B, customer: { name: 'Mysuru walk-in' }, items: [line()], idempotencyKey: key() });
    const puneBill = await InvoiceModel.findOne({ partnerId: lab.partnerId, branchId: B }).lean();
    await assert.rejects(() => invoiceSvc.getInvoice(a, String(puneBill!._id)), code('INVOICE_NOT_FOUND'));
    await assert.rejects(() => invoiceSvc.recordPayment(a, String(puneBill!._id), { mode: 'cash' }), code('INVOICE_NOT_FOUND'));
    const list = await invoiceSvc.listInvoices(a, {});
    assert.ok(list.length > 0 && list.every((i) => String(i.branchId) === lab.branchId));
    await assert.rejects(() => invoiceSvc.listInvoices(a, { branchId: B }), code('BRANCH_SCOPE_EXCEEDED'));
  });

  await check('a stored bill altered outside the service fails its checksum on read', async () => {
    const inv = await invoiceSvc.createInvoice(lab.actor, { branchId: lab.branchId, customer: { name: 'Tamper' }, items: [line()], idempotencyKey: key() });
    await InvoiceModel.updateOne({ _id: inv._id }, { $set: { 'totals.totalMinor': 1 } });
    await assert.rejects(() => invoiceSvc.getInvoice(lab.actor, String(inv._id)), code('CHECKSUM_MISMATCH'));
    await InvoiceModel.deleteOne({ _id: inv._id });
  });

  // ── Walk-in linking and the bill notice ──
  let linkedUserId = '';
  await check('walk-in phone links an existing account without changing it; new phone creates one (valid source)', async () => {
    const existing = await UserModel.create({ phone: '9822200001', name: 'Asha (own name)', userType: 'user', otpVerified: true } as any);
    const inv = await invoiceSvc.createInvoice(lab.actor, { branchId: lab.branchId, customer: { name: 'Typed Differently', phone: '+91 98222 00001' }, items: [line()], idempotencyKey: key() });
    assert.equal(inv.customer.userId, String(existing._id));
    assert.equal((await UserModel.findById(existing._id).lean() as any).name, 'Asha (own name)');
    const fresh = await invoiceSvc.createInvoice(lab.actor, { branchId: lab.branchId, customer: { name: 'New', phone: '9822200002' }, items: [line()], idempotencyKey: key() });
    const u = await UserModel.findById(fresh.customer.userId);
    assert.equal(u!.get('createdSource'), 'partner_invoice');
    await u!.validate(); // the stored source is a valid enum value
    linkedUserId = String(existing._id);
    const parallel = await Promise.all(['9822200003', '9822200003', '09822200003'].map((p) =>
      invoiceSvc.createInvoice(lab.actor, { branchId: lab.branchId, customer: { name: 'Par', phone: p }, items: [line()], idempotencyKey: key() })));
    assert.equal(new Set(parallel.map((p) => p.customer.userId)).size, 1);
    assert.equal(await UserModel.countDocuments({ phone: '9822200003' }), 1);
  });

  await check('bill notice: sent only with a registered template, only to never-signed-in customers, not on replay', async () => {
    sent.length = 0;
    const k = key();
    await invoiceSvc.createInvoice(lab.actor, { branchId: lab.branchId, customer: { name: 'N', phone: '9822200010' }, items: [line()], idempotencyKey: k });
    assert.equal(sent.length, 0, 'no template configured');
    (CONFIG as any).SMS_TEMPLATE_ID_PARTNER_BILL = 'TPL-1';
    try {
      const k2 = key();
      const inv = await invoiceSvc.createInvoice(lab.actor, { branchId: lab.branchId, customer: { name: 'N', phone: '9822200011' }, items: [line()], idempotencyKey: k2 });
      assert.equal(sent.length, 1);
      assert.equal(sent[0]!.to, '9822200011');
      assert.equal(sent[0]!.templateId, 'TPL-1');
      assert.ok(sent[0]!.text.includes(inv.serial) && !sent[0]!.text.includes('http'));
      await invoiceSvc.createInvoice(lab.actor, { branchId: lab.branchId, customer: { name: 'N', phone: '9822200011' }, items: [line()], idempotencyKey: k2 });
      assert.equal(sent.length, 1, 'replay sends nothing');
      await invoiceSvc.createInvoice(lab.actor, { branchId: lab.branchId, customer: { name: 'A', phone: '9822200001' }, items: [line()], idempotencyKey: key() });
      assert.equal(sent.length, 1, 'signed-in customers are not texted');
    } finally {
      (CONFIG as any).SMS_TEMPLATE_ID_PARTNER_BILL = undefined;
    }
  });

  await check('replay is a read: a member whose scope no longer covers the bill\'s branch gets 404, not the bill', async () => {
    const roamer = await partnerSvc.addMember(lab.actor, { phone: '9000000030', name: 'Roamer', role: 'staff', permissions: ['invoices.create'] });
    const req = { branchId: B, customer: { name: 'Replay target', phone: '9822200041' }, items: [line()], idempotencyKey: 'replay-scope-1' };
    const made = await invoiceSvc.createInvoice(actorFor(roamer), req);
    await MemberModel.updateOne({ _id: roamer._id }, { $set: { branchIds: [lab.branchId] } }); // narrowed to branch A
    const narrowed = actorFor((await MemberModel.findById(roamer._id).lean()) as any);
    await assert.rejects(() => invoiceSvc.createInvoice(narrowed, req), code('INVOICE_NOT_FOUND'));
    await assert.rejects(() => invoiceSvc.createInvoice(actorFor(deskA), req), code('INVOICE_NOT_FOUND'));
    const again = await invoiceSvc.createInvoice(lab.actor, req);
    assert.equal(String(again._id), String(made._id), 'an actor with scope still replays');
  });

  await check('every model writer stores the canonical phone; billing and OTP lookup find that one account', async () => {
    const u = await UserModel.create({ phone: '+91 98111 55555', userType: 'user', name: 'Admin-created' } as any);
    assert.equal((await UserModel.collection.findOne({ _id: u._id }) as any).phone, '9811155555');
    await UserModel.updateOne({ _id: u._id }, { $set: { phone: '09811155555' } });
    assert.equal((await UserModel.collection.findOne({ _id: u._id }) as any).phone, '9811155555');
    const inv = await invoiceSvc.createInvoice(lab.actor, { branchId: lab.branchId, customer: { name: 'Walk-in', phone: '9811155555' }, items: [line()], idempotencyKey: key() });
    assert.equal(inv.customer.userId, String(u._id));
    assert.equal(String((await UserModel.findOne({ phone: '9811155555', userType: 'user' }).lean())!._id), String(u._id));
    await assert.rejects(() => UserModel.create({ phone: '+919811155555', userType: 'user' } as any), (e: any) => e?.code === 11000);
    await UserModel.create({ email: 'no-phone@example.com', userType: 'user' } as any);
  });

  await check('event order is the lifecycle version, not the clock (skewed timestamps do not reorder history)', async () => {
    const inv = await invoiceSvc.createInvoice(lab.actor, { branchId: lab.branchId, customer: { name: 'Skew' }, items: [line()], idempotencyKey: key() });
    await invoiceSvc.recordPayment(lab.actor, String(inv._id), { mode: 'cash' });
    await invoiceSvc.cancelInvoice(lab.actor, String(inv._id), 'Wrong patient');
    // The payment's node clock was ahead: its timestamp is later than the cancellation's.
    await InvoiceEventModel.updateOne({ invoiceId: String(inv._id), kind: 'payment' }, { $set: { at: new Date(Date.now() + 3_600_000) } });
    const { invoice, events } = await invoiceSvc.getInvoice(lab.actor, String(inv._id));
    assert.deepEqual(events.map((e) => [e.version, e.kind]), [[1, 'payment'], [2, 'cancellation']]);
    assert.ok(renderInvoiceHtml(invoice, eventsAsOf(events, 1)).includes('>Paid<'));
    assert.ok(renderInvoiceHtml(invoice, eventsAsOf(events, 2)).includes('>Cancelled<'));
    await assert.rejects(() => InvoiceEventModel.create({ invoiceId: String(inv._id), kind: 'payment' as any, version: 2, at: new Date(), by: 'x', byKind: 'member' }),
      (e: any) => e?.code === 11000);
  });

  await check('concurrent price and MRP edits never commit an invalid pair', async () => {
    for (let i = 0; i < 8; i++) {
      const item = await catalogueSvc.createItem(lab.actor, { kind: 'test', name: `Pair ${i}`, priceMinor: 10000, mrpMinor: 20000, gstRate: 0, visitModes: ['lab'] });
      await Promise.allSettled([
        catalogueSvc.updateItem(lab.actor, String(item._id), { priceMinor: 18000 }),
        catalogueSvc.updateItem(lab.actor, String(item._id), { mrpMinor: 15000 }),
      ]);
      const after = await CatalogueItemModel.findById(item._id).lean();
      assert.ok(after!.mrpMinor! >= after!.priceMinor, `pair ${after!.priceMinor}/${after!.mrpMinor}`);
    }
  });

  await check('printed dates are India dates (same clock as numbering); amounts beyond a single bill are refused', async () => {
    const boundary = new Date('2027-03-31T19:00:00Z'); // 00:30 on 1 April in India
    assert.equal(indiaDate(boundary), '01-04-2027');
    assert.equal(financialYearOf(boundary), '2728');
    const inv = await invoiceSvc.createInvoice(lab.actor, { branchId: lab.branchId, customer: { name: 'Date' }, items: [line()], idempotencyKey: key() });
    const html = renderInvoiceHtml({ ...inv, issuedAt: boundary } as any, []);
    assert.ok(html.includes('01-04-2027') && !html.includes('2027-03-31'));
    await assert.rejects(() => invoiceSvc.createInvoice(lab.actor, { branchId: lab.branchId, customer: { name: 'Big' },
      items: [line({ unitPriceMinor: 100_000_000_00, qty: 101 })], idempotencyKey: key() }), code('AMOUNT_TOO_LARGE'));
    await assert.rejects(() => invoiceSvc.createInvoice(lab.actor, { branchId: lab.branchId, customer: { name: 'Big' },
      items: Array.from({ length: 100 }, () => line({ unitPriceMinor: 100_000_000_00, qty: 99, gstRate: 28 })), idempotencyKey: key() }), code('AMOUNT_TOO_LARGE'));
  });

  // ── Admin as owner ──
  await check('admin bills, records payment and cancels for any partner; events and audit name the admin', async () => {
    const admin = adminActor('admin-7', lab.partnerId);
    const inv = await invoiceSvc.createInvoice(admin, { branchId: B, customer: { name: 'Admin desk' }, items: [line()], idempotencyKey: key() });
    assert.equal(inv.createdBy, 'admin:admin-7');
    const paid = await invoiceSvc.recordPayment(admin, String(inv._id), { mode: 'bank', reference: 'NEFT1' });
    assert.equal(paid.event.byKind, 'admin');
    const audit = await PartnerAuditEventModel.find({ targetId: String(inv._id) }).lean();
    assert.deepEqual(audit.map((a) => [a.action, a.actorKind, a.actorId]).sort(),
      [['invoice.create', 'admin', 'admin-7'], ['invoice.pay', 'admin', 'admin-7']].sort());
  });

  // ── Rendering ──
  await check('HTML: values escaped, GST split shown, status by version; PDF renders or reports the missing renderer', async () => {
    const inv = await invoiceSvc.createInvoice(lab.actor, { branchId: lab.branchId, customer: { name: '<script>alert(1)</script>' }, items: [line({ description: 'A & B <i>' })], idempotencyKey: key() });
    await invoiceSvc.recordPayment(lab.actor, String(inv._id), { mode: 'cash', reference: 'R"1' });
    const { invoice, events } = await invoiceSvc.getInvoice(lab.actor, String(inv._id));
    const v0 = renderInvoiceHtml(invoice, events.slice(0, 0));
    const v1 = renderInvoiceHtml(invoice, events.slice(0, 1));
    assert.ok(!v0.includes('<script>') && v0.includes('&lt;script&gt;') && v0.includes('A &amp; B &lt;i&gt;'));
    assert.ok(v0.includes('Tax Invoice') && v0.includes('CGST') && v0.includes('SGST'));
    assert.ok(v0.includes('Unpaid') && v1.includes('Paid') && v1.includes('R&quot;1'));
    await assert.rejects(() => invoiceSvc.pdfForActor(lab.actor, String(inv._id), 5), code('INVALID_VERSION'));
    try {
      const pdf = await renderInvoicePdf(invoice, events);
      assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
    } catch (e: any) {
      assert.equal(e.code, 'PDF_RENDERER_UNAVAILABLE');
    }
  });

  // ── HTTP ──
  const app = express();
  app.use(express.json());
  app.use('/api/v1/partner-workspace', authenticate, partnerWorkspaceRouter);
  app.use('/api/v1/bills', authenticate, denyRoles('partner'), customerBillsRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const partnerToken = (m: IMember) => jwt.sign({ _id: String(m._id), memberId: String(m._id), partnerId: String(m.partnerId), userType: 'partner' }, CONFIG.JWT_SECRET_KEY);
  const userToken = (id: string) => jwt.sign({ _id: id, userType: 'user', authVersion: 0 }, CONFIG.JWT_SECRET_KEY);
  const adminToken = jwt.sign({ _id: new Types.ObjectId().toString(), userType: 'admin' }, CONFIG.JWT_SECRET_KEY);
  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };

  try {
    await check('HTTP: member bills (201); finance-only staff can list but not bill; desk staff cannot open the other branch', async () => {
      const ownerT = partnerToken(lab.owner);
      const made = await call('POST', '/api/v1/partner-workspace/invoices', ownerT,
        { branchId: lab.branchId, customer: { name: 'HTTP', phone: '9822200001' }, items: [line()], idempotencyKey: key() });
      assert.equal(made.status, 201);
      const fin = await partnerSvc.addMember(lab.actor, { phone: '9000000017', name: 'Accounts', role: 'staff', permissions: ['finance.view'] });
      assert.equal((await call('GET', '/api/v1/partner-workspace/invoices', partnerToken(fin))).status, 200);
      assert.equal((await call('POST', '/api/v1/partner-workspace/invoices', partnerToken(fin),
        { branchId: lab.branchId, customer: { name: 'x' }, items: [line()], idempotencyKey: key() })).status, 403);
      const puneBill = await InvoiceModel.findOne({ partnerId: lab.partnerId, branchId: B }).lean();
      assert.equal((await call('GET', `/api/v1/partner-workspace/invoices/${puneBill!._id}`, partnerToken(deskA))).status, 404);
      assert.equal((await call('POST', '/api/v1/partner-workspace/invoices', ownerT,
        { customer: { name: 'no branch' }, items: [line()], idempotencyKey: key() })).status, 400);
    });

    await check('HTTP: admin bills through /admin/:partnerId/workspace', async () => {
      const r = await call('POST', `/api/v1/partner-workspace/admin/${lab.partnerId}/workspace/invoices`, adminToken,
        { branchId: lab.branchId, customer: { name: 'Admin HTTP' }, items: [line()], idempotencyKey: key() });
      assert.equal(r.status, 201);
      assert.equal(r.json.data.createdBy.startsWith('admin:'), true);
    });

    await check('HTTP: customer Bills shows only the customer\'s own bills; other roles refused', async () => {
      const mine = await call('GET', '/api/v1/bills', userToken(linkedUserId));
      assert.equal(mine.status, 200);
      assert.ok(mine.json.data.length >= 2);
      assert.ok(mine.json.data.every((b: any) => b.customer.userId === linkedUserId));
      // Q9: paged (data stays an array) and the doctor named on a clinic bill shows by name (not part of the checksum).
      const paged = await call('GET', '/api/v1/bills?limit=1&page=2', userToken(linkedUserId));
      assert.equal(paged.json.data.length, 1);
      assert.deepEqual([paged.json.pagination.page, paged.json.pagination.limit, paged.json.pagination.total], [2, 1, mine.json.pagination.total]);
      assert.ok(renderInvoiceHtml({ ...(mine.json.data[0] as any), issuedAt: new Date() }, [], { doctorName: 'Dr Bill Name' }).includes('Doctor:</strong> Dr Bill Name'));
      const docId = new Types.ObjectId();
      await mongoose.connection.collection('specialists').insertOne({ _id: docId, name: 'Dr Case' } as never);
      const names = await doctorNames([{ doctorId: docId.toHexString().toUpperCase() }, { doctorId: docId.toHexString() }]);
      assert.deepEqual([names[docId.toHexString().toUpperCase()], names[docId.toHexString()]], ['Dr Case', 'Dr Case'], 'either letter case');
      const one = await call('GET', `/api/v1/bills/${mine.json.data[0]._id}`, userToken(linkedUserId));
      assert.equal(one.status, 200);
      const stranger = await UserModel.create({ phone: '9822200099', userType: 'user' } as any);
      assert.equal((await call('GET', `/api/v1/bills/${mine.json.data[0]._id}`, userToken(String(stranger._id)))).status, 404);
      assert.equal((await call('GET', '/api/v1/bills', partnerToken(lab.owner))).status, 403);
      assert.equal((await call('GET', '/api/v1/bills', adminToken)).status, 403);
    });
  } finally {
    server.close();
  }

  await mongoose.disconnect();
  console.log(`\n${passed} checks passed`);
}

main().catch(async (e) => { console.error(e); await mongoose.disconnect(); process.exit(1); });
