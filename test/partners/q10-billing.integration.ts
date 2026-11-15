/**
 * Q10: billing and edit hardening found by the WQ1/WQ2 web packets — catalogue rules per partner kind and tax
 * registration, inactive items and reactivation, catalogue-priced bill lines, the doctor's branch on clinic bills,
 * lost bill answers (lookup / abandon by key), payment receipts on repeat, refunds on cancelling paid bills, exact
 * bill paging with search, and version-checked edits. Real MongoDB replica set.
 *
 * Run (throwaway DB only):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/q10_billing_check?directConnection=true' JWT_SECRET_KEY=local-integration-only \
 *     npx tsx test/partners/q10-billing.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import { Container } from 'typedi';
import UserModel from '@/modules/user/model';
import SpecialistModel from '@/modules/specialists/model';
import PartnerModel from '@/modules/partners/model';
import MemberModel from '@/modules/partners/model/member';
import BranchModel from '@/modules/partners/model/branch';
import PartnerAuditEventModel from '@/modules/partners/model/audit';
import CatalogueItemModel from '@/modules/partners/model/catalogueItem';
import { InvoiceModel, InvoiceEventModel, InvoiceCounterModel } from '@/modules/partners/model/invoice';
import { SettlementAccountModel } from '@/modules/partners/model/settlement';
import { RequestKeyModel } from '@/modules/requestKeys/model';
import { PartnerRepository } from '@/modules/partners/repository';
import { MemberRepository } from '@/modules/partners/repository/member';
import { BranchRepository } from '@/modules/partners/repository/branch';
import { CatalogueItemRepository } from '@/modules/partners/repository/catalogueItem';
import { InvoiceRepository, InvoiceEventRepository, InvoiceCounterRepository } from '@/modules/partners/repository/invoice';
import { PartnerService, PartnerActor } from '@/modules/partners/services';
import { CatalogueService } from '@/modules/partners/services/catalogue';
import { InvoiceService } from '@/modules/partners/services/invoice';
import { SMSService } from '@/modules/sms/services';
import { IMember, PartnerPermission } from '@/modules/partners/types';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/q10_billing_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const partnerRepo = new PartnerRepository();
const branchRepo = new BranchRepository();
const catalogueRepo = new CatalogueItemRepository();
const partnerSvc = new PartnerService(partnerRepo, new MemberRepository(), branchRepo);
const catalogueSvc = new CatalogueService(catalogueRepo);
const sms = new SMSService();
sms.sendSMS = async () => ({ success: true, data: null });
const invoiceSvc = new InvoiceService(new InvoiceRepository(), new InvoiceEventRepository(), new InvoiceCounterRepository(), partnerRepo, branchRepo, catalogueRepo, sms);
Container.set(PartnerService, partnerSvc);

let passed = 0;
async function check(name: string, fn: () => Promise<void>) { await fn(); passed++; console.log('ok -', name); }
const code = (c: string) => (e: any) => e?.code === c;
const actorFor = (m: IMember): PartnerActor => ({ memberId: String(m._id), partnerId: String(m.partnerId), role: m.role,
  permissions: m.permissions as PartnerPermission[], branchIds: (m.branchIds ?? []).map(String) });
let ph = 7900000000;
const nextPhone = () => String(ph++);
let k = 0;
const key = () => `q10-key-${String(++k).padStart(4, '0')}`;
const branchIn = (name: string, services: Record<string, boolean>) => ({ name, phone: '9876500000', holidays: [], hours: {}, services,
  address: { line1: 'x', city: 'y', state: 'Karnataka', stateCode: '29', pincode: '560001' } }) as any;

async function partner(kind: 'lab' | 'clinic', tax: { taxRegime: 'regular' | 'unregistered'; gstin?: string }) {
  const { partner: p, owner } = await partnerSvc.createPartner({ kind, name: `${kind} ${k}`, contactPhone: nextPhone(), invoiceSeriesPrefix: kind === 'lab' ? 'LB' : 'CL',
    firstOwner: { phone: nextPhone(), name: 'Owner' }, taxRegime: tax.taxRegime, gstin: tax.gstin } as any);
  await partnerSvc.verifyPartner(String(p._id), 'admin');
  const actor = actorFor(owner);
  const services = kind === 'lab' ? { homeCollection: true, inLab: true, inClinic: false } : { homeCollection: false, inLab: false, inClinic: true };
  const A = String((await partnerSvc.createBranch(actor, branchIn('A', services)))._id);
  const B = String((await partnerSvc.createBranch(actor, branchIn('B', services)))._id);
  return { partnerId: String(p._id), actor, owner, A, B };
}

async function main() {
  await mongoose.connect(FIXTURE_URL, { autoIndex: false });
  for (const c of await mongoose.connection.db!.collections()) await c.drop().catch(() => {});
  for (const M of [UserModel, SpecialistModel, PartnerModel, MemberModel, BranchModel, PartnerAuditEventModel, CatalogueItemModel, InvoiceModel, InvoiceEventModel,
    InvoiceCounterModel, SettlementAccountModel, RequestKeyModel] as mongoose.Model<any>[]) { await M.createCollection(); await M.createIndexes(); }

  const lab = await partner('lab', { taxRegime: 'regular', gstin: '29AABCM1234F1ZH' });
  const plainLab = await partner('lab', { taxRegime: 'unregistered' });
  const clinic = await partner('clinic', { taxRegime: 'unregistered' });

  await check('catalogue rules: kinds per partner type, visit modes only for labs, GST only with a regular registration', async () => {
    await assert.rejects(() => catalogueSvc.createItem(plainLab.actor, { kind: 'test', name: 'CBC', priceMinor: 30000, gstRate: 5, visitModes: ['lab'] }), code('GST_RATE_NOT_ALLOWED'));
    await catalogueSvc.createItem(plainLab.actor, { kind: 'test', name: 'CBC', priceMinor: 30000, gstRate: 0, visitModes: ['lab'] });
    await assert.rejects(() => catalogueSvc.createItem(lab.actor, { kind: 'consultation', name: 'OPD', priceMinor: 50000, gstRate: 0 } as any), code('ITEM_KIND_NOT_ALLOWED'));
    await assert.rejects(() => catalogueSvc.createItem(lab.actor, { kind: 'test', name: 'X', priceMinor: 1, gstRate: 0, visitModes: [] }), code('VISIT_MODES_REQUIRED'));
    const opd = await catalogueSvc.createItem(clinic.actor, { kind: 'consultation', name: 'OPD visit', priceMinor: 50000, gstRate: 0 } as any);
    assert.deepEqual(opd.visitModes, []);
    await assert.rejects(() => catalogueSvc.createItem(clinic.actor, { kind: 'procedure', name: 'Dressing', priceMinor: 20000, gstRate: 0, visitModes: ['home'] }), code('VISIT_MODES_NOT_ALLOWED'));
    await assert.rejects(() => catalogueSvc.createItem(clinic.actor, { kind: 'test', name: 'CBC', priceMinor: 1, gstRate: 0, visitModes: ['lab'] }), code('ITEM_KIND_NOT_ALLOWED'));
    await assert.rejects(() => catalogueSvc.updateItem(clinic.actor, String(opd._id), { gstRate: 18 }), code('GST_RATE_NOT_ALLOWED'));
  });

  let cbc = '';
  await check('deactivated items are listed for catalogue managers and can be reactivated; edits are version-checked', async () => {
    const item = await catalogueSvc.createItem(lab.actor, { kind: 'test', name: 'Lipid', priceMinor: 80000, gstRate: 5, visitModes: ['lab'] });
    cbc = String(item._id);
    await catalogueSvc.deactivateItem(lab.actor, cbc);
    assert.ok(!(await catalogueSvc.listItems(lab.actor)).some((i) => String(i._id) === cbc));
    assert.ok((await catalogueSvc.listItems(lab.actor, undefined, true)).some((i) => String(i._id) === cbc));
    assert.equal((await catalogueSvc.reactivateItem(lab.actor, cbc)).isActive, true);
    await assert.rejects(() => catalogueSvc.reactivateItem(lab.actor, cbc), code('ITEM_ALREADY_ACTIVE'));
    const fresh = await CatalogueItemModel.findById(cbc).lean();
    const stale = new Date(new Date(fresh!.updatedAt as any).getTime() - 1000);
    await assert.rejects(() => catalogueSvc.updateItem(lab.actor, cbc, { name: 'Lipid profile', expectedUpdatedAt: stale } as any), code('CATALOGUE_ITEM_CHANGED'));
    assert.equal((await catalogueSvc.updateItem(lab.actor, cbc, { name: 'Lipid profile', expectedUpdatedAt: fresh!.updatedAt } as any)).name, 'Lipid profile');
  });

  await check('catalogue item create is exactly once per request key (any field order); other content under the key is refused', async () => {
    const body = { kind: 'test' as const, name: 'HbA1c', priceMinor: 60000, gstRate: 5 as const, visitModes: ['lab' as const] };
    const all = await Promise.all([1, 2, 3].map(() => catalogueSvc.createItem(lab.actor, { ...body, requestKey: 'item-key-0001' })));
    assert.equal(new Set(all.map((x) => String(x._id))).size, 1);
    const reordered = await catalogueSvc.createItem(lab.actor, { visitModes: ['lab'], gstRate: 5, priceMinor: 60000, name: 'HbA1c', kind: 'test', requestKey: 'item-key-0001' });
    assert.equal(reordered.replayed, true);
    await assert.rejects(() => catalogueSvc.createItem(lab.actor, { ...body, priceMinor: 1, requestKey: 'item-key-0001' }), code('REQUEST_KEY_REUSED'));
    assert.equal(await CatalogueItemModel.countDocuments({ partnerId: lab.partnerId, name: 'HbA1c' }), 1);
  });

  await check('a catalogue-linked bill line bills the catalogue price and GST (else refused)', async () => {
    await assert.rejects(() => invoiceSvc.createInvoice(lab.actor, { branchId: lab.A, customer: { name: 'X' },
      items: [{ catalogItemId: cbc, description: 'Lipid', qty: 1, unitPriceMinor: 1000, gstRate: 5 }], idempotencyKey: key() }), code('CATALOGUE_PRICE_CHANGED'));
    const ok = await invoiceSvc.createInvoice(lab.actor, { branchId: lab.A, customer: { name: 'X' },
      items: [{ catalogItemId: cbc, description: 'Lipid', qty: 2, unitPriceMinor: 80000, gstRate: 5, discountMinor: 1000 }], idempotencyKey: key() });
    assert.equal(ok.totals.taxableMinor, 159000);
  });

  await check('the doctor on a clinic bill must consult at that branch and be an active, verified doctor', async () => {
    const doc = new Types.ObjectId();
    await SpecialistModel.collection.insertOne({ _id: doc, name: 'Dr Q', phone: nextPhone(), isActive: true, isVerified: true } as never);
    await MemberModel.create({ partnerId: clinic.partnerId, phone: nextPhone(), name: 'Dr Q', role: 'staff', permissions: [], branchIds: [], doctorId: String(doc),
      doctorBranchIds: [clinic.A], isActive: true });
    const free = { description: 'Consultation', qty: 1, unitPriceMinor: 50000, gstRate: 0 as const };
    await assert.rejects(() => invoiceSvc.createInvoice(clinic.actor, { branchId: clinic.B, customer: { name: 'P' }, doctorId: String(doc), items: [free], idempotencyKey: key() }),
      code('DOCTOR_NOT_AT_BRANCH'));
    await invoiceSvc.createInvoice(clinic.actor, { branchId: clinic.A, customer: { name: 'P' }, doctorId: String(doc), items: [free], idempotencyKey: key() });
    await SpecialistModel.updateOne({ _id: doc }, { $set: { isVerified: false } });
    await assert.rejects(() => invoiceSvc.createInvoice(clinic.actor, { branchId: clinic.A, customer: { name: 'P' }, doctorId: String(doc), items: [free], idempotencyKey: key() }),
      code('DOCTOR_NOT_AT_BRANCH'));
  });

  const free = { description: 'Service', qty: 1, unitPriceMinor: 10000, gstRate: 0 as const };
  await check('a lost bill answer: look it up by key, or abandon the key (then it can never be issued); used keys return the bill', async () => {
    const k1 = key();
    const inv = await invoiceSvc.createInvoice(plainLab.actor, { branchId: plainLab.A, customer: { name: 'L' }, items: [free], idempotencyKey: k1 });
    assert.equal(String((await invoiceSvc.findByKey(plainLab.actor, k1))!._id), String(inv._id));
    const used = await invoiceSvc.abandonKey(plainLab.actor, k1);
    assert.deepEqual([used.state, String(used.invoice!._id)], ['used', String(inv._id)]);
    const k2 = key();
    assert.equal(await invoiceSvc.findByKey(plainLab.actor, k2), null);
    assert.equal((await invoiceSvc.abandonKey(plainLab.actor, k2)).state, 'abandoned');
    await assert.rejects(() => invoiceSvc.createInvoice(plainLab.actor, { branchId: plainLab.A, customer: { name: 'L' }, items: [free], idempotencyKey: k2 }), code('REQUEST_ABANDONED'));
    // Another partner's key space is separate.
    assert.equal(await invoiceSvc.findByKey(lab.actor, k1), null);
  });

  await check('a repeated payment answers with its receipt; a paid bill is cancelled only with its refund recorded', async () => {
    const inv = await invoiceSvc.createInvoice(plainLab.actor, { branchId: plainLab.A, customer: { name: 'Pay' }, items: [free], idempotencyKey: key() });
    const p1 = await invoiceSvc.recordPayment(plainLab.actor, String(inv._id), { mode: 'cash', reference: 'R1' });
    const p2 = await invoiceSvc.recordPayment(plainLab.actor, String(inv._id), { mode: 'cash', reference: 'R1' });
    assert.equal(p2.replayed, true);
    assert.equal(String(p2.event._id), String(p1.event._id));
    await assert.rejects(() => invoiceSvc.recordPayment(plainLab.actor, String(inv._id), { mode: 'upi', reference: 'R2' }), code('INVOICE_STATE_CONFLICT'));
    await assert.rejects(() => invoiceSvc.cancelInvoice(plainLab.actor, String(inv._id), 'Wrong'), code('REFUND_REQUIRED'));
    const c = await invoiceSvc.cancelInvoice(plainLab.actor, String(inv._id), 'Wrong', { mode: 'cash', note: 'Handed back at desk' });
    assert.deepEqual(c.event.refund, { mode: 'cash', note: 'Handed back at desk' });
    const issued = await invoiceSvc.createInvoice(plainLab.actor, { branchId: plainLab.A, customer: { name: 'NotPaid' }, items: [free], idempotencyKey: key() });
    await assert.rejects(() => invoiceSvc.cancelInvoice(plainLab.actor, String(issued._id), 'x', { mode: 'cash' }), code('NOTHING_TO_REFUND'));
  });

  await check('bills page exactly (no lost or repeated bills), with date range, search and total', async () => {
    for (let i = 0; i < 7; i++) await invoiceSvc.createInvoice(plainLab.actor, { branchId: plainLab.B, customer: { name: `Search ${i}`, phone: undefined }, items: [free], idempotencyKey: key() });
    const seen: string[] = [];
    let cursor: string | undefined;
    let total = 0;
    do {
      const p = await invoiceSvc.listInvoicesPage(plainLab.actor, { branchId: plainLab.B, limit: 2, cursor });
      total = p.total;
      seen.push(...p.items.map((x) => String(x._id)));
      cursor = p.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(total, 7);
    assert.equal(new Set(seen).size, 7);
    assert.equal((await invoiceSvc.listInvoicesPage(plainLab.actor, { q: 'search 3' })).total, 1);
    const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
    assert.equal((await invoiceSvc.listInvoicesPage(plainLab.actor, { branchId: plainLab.B, from: today, to: today })).total, 7);
    assert.equal((await invoiceSvc.listInvoicesPage(plainLab.actor, { branchId: plainLab.B, from: '2020-01-01', to: '2020-01-02' })).total, 0);
    await assert.rejects(() => invoiceSvc.listInvoicesPage(plainLab.actor, { cursor: 'bad' }), code('INVALID_CURSOR'));
  });

  await check('a lost partner create: an admin looks up or abandons their own key; an abandoned key never creates', async () => {
    const admin = String(new Types.ObjectId());
    const body = { kind: 'lab', name: 'Keyed Lab', contactPhone: nextPhone(), invoiceSeriesPrefix: 'KL', firstOwner: { phone: nextPhone(), name: 'K' } } as any;
    const made = await partnerSvc.createPartner({ ...body, requestKey: 'pcreate-0001', createdBy: admin });
    assert.equal(String((await partnerSvc.findCreatedByKey(admin, 'pcreate-0001'))!.partner._id), String(made.partner._id));
    assert.equal(await partnerSvc.findCreatedByKey(String(new Types.ObjectId()), 'pcreate-0001'), null, 'another admin sees nothing');
    const used = await partnerSvc.abandonCreateKey(admin, 'pcreate-0001');
    assert.deepEqual([used.state, String(used.partner!._id)], ['used', String(made.partner._id)]);
    assert.equal((await partnerSvc.abandonCreateKey(admin, 'pcreate-0002')).state, 'abandoned');
    await assert.rejects(() => partnerSvc.createPartner({ ...body, name: 'Late', requestKey: 'pcreate-0002', createdBy: admin }), code('REQUEST_ABANDONED'));
    assert.equal(await PartnerModel.countDocuments({ name: 'Late' }), 0);
  });

  await check('Q10 r1: legacy keys reconcile to used; legacy clinic items stay editable and convert once; real dates only', async () => {
    // A bill and a partner made under keys before claims existed (no RequestKey row).
    const k1 = key();
    const inv = await invoiceSvc.createInvoice(plainLab.actor, { branchId: plainLab.A, customer: { name: 'Legacy' }, items: [free], idempotencyKey: k1 });
    await RequestKeyModel.deleteMany({ key: k1 });
    const r = await invoiceSvc.abandonKey(plainLab.actor, k1);
    assert.deepEqual([r.state, String(r.invoice!._id)], ['used', String(inv._id)]);
    const admin = String(new Types.ObjectId());
    const p = await partnerSvc.createPartner({ kind: 'lab', name: 'Legacy Partner', contactPhone: nextPhone(), invoiceSeriesPrefix: 'LP',
      firstOwner: { phone: nextPhone(), name: 'L' }, requestKey: 'legacy-pk-0001', createdBy: admin } as any);
    await RequestKeyModel.deleteMany({ key: 'legacy-pk-0001' });
    const rp = await partnerSvc.abandonCreateKey(admin, 'legacy-pk-0001');
    assert.deepEqual([rp.state, String(rp.partner!._id)], ['used', String(p.partner._id)]);
    // A clinic 'test' item with visit modes from before Q10.
    const legacy = await CatalogueItemModel.create({ partnerId: clinic.partnerId, kind: 'test', name: 'Old CBC', priceMinor: 30000, gstRate: 0, visitModes: ['lab'], isActive: true });
    assert.equal((await catalogueSvc.updateItem(clinic.actor, String(legacy._id), { priceMinor: 35000 })).priceMinor, 35000, 'still editable');
    assert.deepEqual((await catalogueSvc.updateItem(clinic.actor, String(legacy._id), { visitModes: [] })).visitModes, [], 'visit modes can be cleared');
    assert.equal((await catalogueSvc.updateItem(clinic.actor, String(legacy._id), { kind: 'procedure' } as any)).kind, 'procedure', 'converted once');
    await assert.rejects(() => catalogueSvc.updateItem(clinic.actor, String(legacy._id), { kind: 'other' } as any), code('KIND_FIXED'));
    await assert.rejects(() => catalogueSvc.updateItem(lab.actor, cbc, { visitModes: [] }), code('VISIT_MODES_REQUIRED'));
    await assert.rejects(() => invoiceSvc.listInvoicesPage(plainLab.actor, { from: '2026-99-99' }), code('INVALID_DATE'));
    await assert.rejects(() => invoiceSvc.listInvoicesPage(plainLab.actor, { to: '2026-02-30' }), code('INVALID_DATE'));
    const { invoiceQuerySchema } = await import('@/modules/partners/validation/invoice');
    assert.ok(invoiceQuerySchema.validate({ from: '2026-02-30' }).error);
    assert.equal(invoiceQuerySchema.validate({ from: '2026-02-28' }).error, undefined);
  });

  await check('profile, branch and member edits refuse a stale version (RECORD_CHANGED) and accept the current one', async () => {
    const p = await PartnerModel.findById(lab.partnerId).lean();
    const old = new Date(new Date(p!.updatedAt as any).getTime() - 5000);
    await assert.rejects(() => partnerSvc.updateOwnProfile(lab.actor, { name: 'Renamed', expectedUpdatedAt: old }), code('RECORD_CHANGED'));
    assert.equal((await partnerSvc.updateOwnProfile(lab.actor, { name: 'Renamed', expectedUpdatedAt: p!.updatedAt })).name, 'Renamed');
    const b = await BranchModel.findById(lab.A).lean();
    await assert.rejects(() => partnerSvc.updateBranch(lab.actor, lab.A, { name: 'A2', expectedUpdatedAt: new Date(0) } as any), code('RECORD_CHANGED'));
    assert.equal((await partnerSvc.updateBranch(lab.actor, lab.A, { name: 'A2', expectedUpdatedAt: b!.updatedAt } as any)).name, 'A2');
    const m = await partnerSvc.addMember(lab.actor, { phone: nextPhone(), name: 'Staff', role: 'staff', permissions: ['bookings.view'] } as any);
    const fresh = await MemberModel.findById(m._id).lean();
    await assert.rejects(() => partnerSvc.updateMemberPermissions(lab.actor, String(m._id), ['bookings.view', 'finance.view'], new Date(0)), code('RECORD_CHANGED'));
    await partnerSvc.updateMemberPermissions(lab.actor, String(m._id), ['finance.view'], fresh!.updatedAt);
    await assert.rejects(() => partnerSvc.updateMemberBranches(lab.actor, String(m._id), [lab.A], fresh!.updatedAt), code('RECORD_CHANGED'), 'the permission change moved its version');
  });

  await mongoose.disconnect();
  console.log(`\n${passed} checks passed`);
}
main().catch(async (e) => { console.error(e); await mongoose.disconnect(); process.exit(1); });
