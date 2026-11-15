/**
 * Q3: settlement accounts + ledger, doctor payout cutover, server-owned lab slots, partner-lab bookings (creation before
 * payment, gateway and wallet payment, pay again, expiry, cancellation, reschedule entitlement, staff state machine,
 * report draft/release with D1 access), completion earnings, customer discovery and HTTP routes. Real MongoDB replica
 * set; the Razorpay client is a fake (as in the W3b tests); payments settle through the real reconcile path.
 *
 * Run (throwaway DB only; the script drops its collections):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/q3_lab_check?directConnection=true' JWT_SECRET_KEY=local-check-only \
 *     npx tsx --tsconfig tsconfig.json test/partners/q3-lab-bookings.integration.ts
 */
import { removeFixtureDir } from './q3-fixture-dir';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import { Container } from 'typedi';
import { CONFIG } from '@/config/config';
import { errorHandler } from '@/modules/middleware';
import UserModel from '@/modules/user/model';
import BookingModel from '@/modules/bookings/model';
import { BookingRepository } from '@/modules/bookings/repository';
import { createBookingWithHolds } from '@/modules/bookings/holds';
import { PayoutBillingModel, PayoutDisbursalModel } from '@/modules/payouts/model';
import { PayoutService } from '@/modules/payouts/services';
import SpecialistModel from '@/modules/specialists/model';
import PaymentRecordModel from '@/modules/payment/model';
import { PaymentRepository } from '@/modules/payment/repository';
import { PaymentService } from '@/modules/payment/services';
import { WalletModel, WalletTransactionModel } from '@/modules/wallet/model';
import { WalletRepository, WalletTransactionRepository } from '@/modules/wallet/repository';
import { CouponService } from '@/modules/coupon/services';
import { CouponRepository } from '@/modules/coupon/repository';
import { RequestKeyModel } from '@/modules/requestKeys/model';
import { abandonRequestKey, scopeOf } from '@/modules/requestKeys';
import { FileUploadModel, FileGrantModel } from '@/modules/file/model/access';
import { decideFileAccess } from '@/modules/file/access';
import PartnerModel from '@/modules/partners/model';
import MemberModel from '@/modules/partners/model/member';
import BranchModel from '@/modules/partners/model/branch';
import PartnerAuditEventModel from '@/modules/partners/model/audit';
import CatalogueItemModel from '@/modules/partners/model/catalogueItem';
import { SettlementAccountModel, LedgerEntryModel, LedgerHistoryRefModel } from '@/modules/partners/model/settlement';
import { PartnerSlotModel, PartnerSlotTemplateModel, ScheduleGuardModel } from '@/modules/partners/model/slot';
import fs from 'node:fs';
import nodePath from 'node:path';
import { PharmacyService } from '@/modules/pharmacies/services';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import { UserRepository } from '@/modules/user/repository';
import { BannerService } from '@/modules/banners/services';
import { BannerRepository } from '@/modules/banners/repository';
import { PartnerLabBookingModel } from '@/modules/partners/model/labBooking';
import { PartnerRepository } from '@/modules/partners/repository';
import { MemberRepository } from '@/modules/partners/repository/member';
import { BranchRepository } from '@/modules/partners/repository/branch';
import { CatalogueItemRepository } from '@/modules/partners/repository/catalogueItem';
import { PartnerService, PartnerActor, adminActor } from '@/modules/partners/services';
import { CatalogueService } from '@/modules/partners/services/catalogue';
import { ensureSettlementAccount, postLedgerEntry, ledgerBalance } from '@/modules/partners/services/settlement';
import { saveSlotTemplate, expandSlots, setSlotCapacity, setSlotClosed, addManualSlot, istDate, addDays, listSlotsForPartner } from '@/modules/partners/services/slots';
import { LabBookingService, registerLabBookingPayments, LAB_CANCEL_CUTOFF_MS } from '@/modules/partners/services/labBookings';
import { settlementSystemFor } from '@/modules/partners/services/cutover';
import { runSettlementCutover } from '@/scripts/q3SettlementCutover';
import { IMember, PartnerPermission } from '@/modules/partners/types';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/q3_lab_check?directConnection=true';
const url = process.env.MONGODB_URL ?? '';
if (url !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

// ── Fake Razorpay (orders.create / orders.fetchPayments), as in W3b ──
const gateway = new Map<string, { id: string; order_id: string; amount: number; currency: string; status: string }[]>();
const unreachable = new Set<string>();
let orders = 0;
const fakeRazorpay = {
  orders: {
    create: async (o: { amount: number; currency: string }) => ({ id: `order_${++orders}_${new Types.ObjectId().toHexString()}`, amount: o.amount, currency: o.currency, status: 'created' }),
    fetchPayments: async (orderId: string) => {
      if (unreachable.has(orderId)) throw new Error('gateway timeout');
      return { items: gateway.get(orderId) ?? [] };
    },
  },
  payments: { fetch: async () => { throw new Error('not used'); } },
};
const payments = Object.assign(Object.create(PaymentService.prototype), {
  bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
  walletTransactionRepository: new WalletTransactionRepository(),
  getRazorpayClient: () => fakeRazorpay,
  getRazorpayCredentials: () => ({ keyId: 'rzp_test_key', keySecret: 'secret' }),
}) as unknown as PaymentService;
const capture = async (paymentTransactionId: string) => {
  const r = await PaymentRecordModel.findById(paymentTransactionId).lean();
  gateway.set(r!.razorpayOrderId, [{ id: `pay_${new Types.ObjectId().toHexString()}`, order_id: r!.razorpayOrderId, amount: Math.round(r!.finalAmount * 100), currency: 'INR', status: 'captured' }]);
};

const partnerRepo = new PartnerRepository();
const memberRepo = new MemberRepository();
const branchRepo = new BranchRepository();
const partnerSvc = new PartnerService(partnerRepo, memberRepo, branchRepo);
const catalogueSvc = new CatalogueService(new CatalogueItemRepository());
const labSvc = new LabBookingService(payments, new CouponService(new CouponRepository()), new WalletRepository());
const notices: { userId: string; key: string; title: string }[] = [];
labSvc.notify = async (n) => { notices.push({ userId: n.userId, key: n.key, title: n.title }); };
Container.set(PartnerService, partnerSvc);
Container.set(CatalogueService, catalogueSvc);
Container.set(LabBookingService, labSvc);
Container.set(PaymentService, payments);
registerLabBookingPayments(() => labSvc);

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) { await fn(); passed++; console.log('ok -', name); }
const code = (c: string) => (e: any) => e?.code === c;
const actorFor = (m: IMember): PartnerActor => ({ memberId: String(m._id), partnerId: String(m.partnerId), role: m.role,
  permissions: m.permissions as PartnerPermission[], branchIds: (m.branchIds ?? []).map(String) });
let phone = 7000000000;
const nextPhone = () => String(phone++);
let keySeq = 0;
const rk = () => `req-key-${String(++keySeq).padStart(4, '0')}`;

async function customer(walletRupees = 0) {
  const u = await UserModel.create({ phone: nextPhone(), name: 'Asha', userType: 'user', otpVerified: true } as any);
  await WalletModel.create({ userId: String(u._id), balance: walletRupees, isActive: true });
  return String(u._id);
}
const balanceOf = async (userId: string) => Number((await WalletModel.findOne({ userId }).lean())!.balance);

async function main() {
  await mongoose.connect(url, { autoIndex: false });
  for (const c of await mongoose.connection.db!.collections()) await c.drop().catch(() => {});
  for (const M of [PartnerModel, MemberModel, BranchModel, PartnerAuditEventModel, CatalogueItemModel, SettlementAccountModel, LedgerEntryModel,
    LedgerHistoryRefModel, PartnerSlotModel, PartnerSlotTemplateModel, PartnerLabBookingModel, UserModel, BookingModel, PaymentRecordModel,
    WalletModel, WalletTransactionModel, RequestKeyModel, FileUploadModel, FileGrantModel, PayoutBillingModel, PayoutDisbursalModel, SpecialistModel, ScheduleGuardModel] as mongoose.Model<any>[]) {
    await M.createCollection(); await M.createIndexes();
  }

  // ── Fixtures: a verified lab with two branches and staff ──
  const { partner, owner } = await partnerSvc.createPartner({
    kind: 'lab', name: 'Metro Labs', legalName: 'Metro Labs Pvt Ltd', contactPhone: nextPhone(), invoiceSeriesPrefix: 'ML',
    firstOwner: { phone: nextPhone(), name: 'Owner' }, taxRegime: 'regular', gstin: '29AABCM1234F1ZH',
  });
  const partnerId = String(partner._id);
  await partnerSvc.verifyPartner(partnerId, 'admin');
  const own = actorFor(owner);
  const branchIn = (name: string) => ({ name, phone: '9876500000', holidays: [], hours: {}, services: { homeCollection: true, inLab: true, inClinic: false },
    address: { line1: '1 Road', city: 'Bengaluru', state: 'Karnataka', stateCode: '29', pincode: '560001' } }) as any;
  const A = String((await partnerSvc.createBranch(own, branchIn('Indiranagar')))._id);
  const B = String((await partnerSvc.createBranch(own, branchIn('Jayanagar')))._id);
  const desk = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Desk A', role: 'staff', branchIds: [A], permissions: ['bookings.view', 'bookings.manage', 'slots.manage', 'reports.upload'] });
  const pathologist = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Dr Rao', role: 'staff', permissions: ['bookings.view', 'reports.upload', 'reports.release'] });
  await MemberModel.updateOne({ _id: pathologist._id }, { $set: { professional: { kind: 'pathologist', registrationNumber: 'KMC-12345' } } });
  const deskA = actorFor(desk);
  const path = actorFor(pathologist);
  const cbc = await catalogueSvc.createItem(own, { kind: 'test', name: 'CBC', priceMinor: 50000, gstRate: 0, visitModes: ['home', 'lab'], reportTatHours: 24 });
  const lipid = await catalogueSvc.createItem(own, { kind: 'test', name: 'Lipid', priceMinor: 80000, gstRate: 0, visitModes: ['lab'] });
  const hidden = await catalogueSvc.createItem(own, { kind: 'test', name: 'Hidden', priceMinor: 10000, gstRate: 0, visitModes: ['lab', 'home'] });
  await catalogueSvc.setAdminDisabled('adm', String(hidden._id), true);

  // ── The real application routes (content aliases, uploads, workspace, customer APIs) ──
  Container.set(PharmacyService, new PharmacyService(new PharmacyRepository(), new UserRepository()));
  Container.set(BannerService, new BannerService(new BannerRepository()));
  const { configureRoutes } = await import('@/routes');
  registerLabBookingPayments(() => labSvc);
  const app = express();
  app.use(express.json());
  configureRoutes(app);
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const partnerToken = (m: IMember) => jwt.sign({ _id: String(m._id), memberId: String(m._id), partnerId: String(m.partnerId), userType: 'partner' }, CONFIG.JWT_SECRET_KEY);
  const userToken = (id: string) => jwt.sign({ _id: id, userType: 'user', authVersion: 0 }, CONFIG.JWT_SECRET_KEY);
  const adminId = new Types.ObjectId().toString();
  const adminToken = jwt.sign({ _id: adminId, userType: 'admin' }, CONFIG.JWT_SECRET_KEY);
  const call = async (method: string, p: string, token: string, body?: unknown) => {
    const r = await fetch(base + p, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
  const uploadVia = async (token: string, p: string, name = 'report.pdf') => {
    const fd = new FormData();
    fd.append('files', new Blob([pdf], { type: 'application/pdf' }), name);
    const r = await fetch(base + p, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: fd });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  const fetchStatus = async (p: string, token?: string) =>
    (await fetch(base + p, { headers: token ? { authorization: `Bearer ${token}` } : {} })).status;

  // ── Settlement accounts and ledger ──
  await check('a partner gets its settlement account at creation; doctor accounts are find-or-create under concurrency', async () => {
    const acct = await SettlementAccountModel.findOne({ ownerKind: 'partner', ownerId: partnerId }).lean();
    assert.equal(acct!.beneficiaryName, 'Metro Labs Pvt Ltd');
    const sp = new Types.ObjectId().toHexString();
    const made = await Promise.all(Array.from({ length: 6 }, () => ensureSettlementAccount('doctor', sp, 'Dr X')));
    assert.equal(new Set(made.map((a) => String(a._id))).size, 1);
    assert.equal(await SettlementAccountModel.countDocuments({ ownerKind: 'doctor', ownerId: sp }), 1);
  });

  await check('ledger entries are exactly once per source; a different amount for the same source is refused; signs enforced', async () => {
    const acct = await ensureSettlementAccount('doctor', new Types.ObjectId().toHexString(), 'Dr L');
    const id = String(acct._id);
    const e = { settlementAccountId: id, kind: 'earning' as const, amountMinor: 10000, source: 'test', sourceId: 's1', by: 'system', byKind: 'system' as const };
    await Promise.all([postLedgerEntry(e), postLedgerEntry(e), postLedgerEntry(e)]);
    assert.equal(await LedgerEntryModel.countDocuments({ settlementAccountId: id }), 1);
    await assert.rejects(() => postLedgerEntry({ ...e, amountMinor: 9999 }), code('LEDGER_SOURCE_CONFLICT'));
    await assert.rejects(() => postLedgerEntry({ ...e, kind: 'payout', amountMinor: 500, sourceId: 'p1' }), code('INVALID_AMOUNT_SIGN'));
    await postLedgerEntry({ ...e, kind: 'payout', amountMinor: -4000, sourceId: 'p1', byKind: 'admin', by: 'adm' });
    assert.equal(await ledgerBalance(id), 6000);
  });

  // ── Slots ──
  const today = istDate(new Date());
  await check('template expansion is idempotent; holidays and template changes close slots without losing holds; manual closures stay', async () => {
    const t = await saveSlotTemplate(deskA, A, 'lab', { slotMinutes: 30, capacity: 2, days: Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [{ start: '08:00', end: '10:00' }]])) });
    assert.equal(t.expansion.inserted, 30 * 4);
    assert.equal((await expandSlots(A, 'lab', today, 30)).inserted, 0);
    await saveSlotTemplate(own, A, 'home', { slotMinutes: 60, capacity: 3, days: Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [{ start: '07:00', end: '09:00' }]])) });
    const holiday = addDays(today, 10);
    const slot = await PartnerSlotModel.findOne({ branchId: A, visitMode: 'lab', date: holiday, startTime: '08:00' }).lean();
    await PartnerSlotModel.updateOne({ _id: slot!._id }, { $set: { booked: 1 } }); // a held seat
    await BranchModel.updateOne({ _id: A }, { $push: { holidays: holiday } });
    await expandSlots(A, 'lab', today, 30);
    const closed = await PartnerSlotModel.find({ branchId: A, visitMode: 'lab', date: holiday }).lean();
    assert.ok(closed.every((s) => s.closed === 'holiday'));
    assert.equal(closed.find((s) => s.startTime === '08:00')!.booked, 1, 'holds kept');
    await setSlotClosed(own, String(closed.find((s) => s.startTime === '09:30')!._id), true);
    await BranchModel.updateOne({ _id: A }, { $pull: { holidays: holiday } });
    await expandSlots(A, 'lab', today, 30);
    const reopened = await PartnerSlotModel.find({ branchId: A, visitMode: 'lab', date: holiday }).lean();
    assert.equal(reopened.filter((s) => s.closed === null).length, 3);
    assert.equal(reopened.find((s) => s.startTime === '09:30')!.closed, 'manual');
    await PartnerSlotModel.updateOne({ _id: slot!._id }, { $set: { booked: 0 } });
    await assert.rejects(() => saveSlotTemplate(deskA, B, 'lab', { slotMinutes: 30, capacity: 2, days: {} }), code('BRANCH_SCOPE_EXCEEDED'));
    await assert.rejects(() => saveSlotTemplate(own, A, 'lab', { slotMinutes: 30, capacity: 2, days: { mon: [{ start: '08:00', end: '09:00' }, { start: '08:30', end: '10:00' }] } }), code('OVERLAPPING_WINDOWS'));
  });

  await check('capacity never drops below held seats; manual slot identity is unique', async () => {
    const s = await PartnerSlotModel.findOne({ branchId: A, visitMode: 'lab', date: addDays(today, 3), startTime: '08:00' }).lean();
    await PartnerSlotModel.updateOne({ _id: s!._id }, { $set: { booked: 2 } });
    await assert.rejects(() => setSlotCapacity(own, String(s!._id), 1), code('SLOT_CAPACITY_BELOW_BOOKED'));
    assert.equal((await setSlotCapacity(own, String(s!._id), 4)).capacity, 4);
    await PartnerSlotModel.updateOne({ _id: s!._id }, { $set: { booked: 0, capacity: 2 } });
    await addManualSlot(own, { branchId: A, visitMode: 'lab', date: addDays(today, 3), startTime: '18:00', endTime: '18:30', capacity: 1 });
    await assert.rejects(() => addManualSlot(own, { branchId: A, visitMode: 'lab', date: addDays(today, 3), startTime: '18:00', endTime: '18:30', capacity: 1 }), code('SLOT_EXISTS'));
  });

  await check('template edits reconcile generated slots: unbooked rows follow the template, booked rows keep time and holds', async () => {
    const d = addDays(today, 20);
    const every = (w: { start: string; end: string }[]) => Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((x) => [x, w]));
    await saveSlotTemplate(own, B, 'home', { slotMinutes: 60, capacity: 5, days: every([{ start: '09:00', end: '11:00' }]) });
    const booked = await PartnerSlotModel.findOne({ branchId: B, visitMode: 'home', date: d, startTime: '10:00' }).lean();
    await PartnerSlotModel.updateOne({ _id: booked!._id }, { $set: { booked: 3 } });
    await saveSlotTemplate(own, B, 'home', { slotMinutes: 30, capacity: 1, days: every([{ start: '09:00', end: '11:00' }]) });
    const rows = await PartnerSlotModel.find({ branchId: B, visitMode: 'home', date: d }).sort({ startTime: 1 }).lean();
    const by = (t: string) => rows.find((r) => r.startTime === t)!;
    assert.deepEqual([by('09:00').endTime, by('09:00').capacity], ['09:30', 1], 'unbooked generated row now matches the template');
    assert.ok(by('09:30') && by('10:30'));
    assert.deepEqual([by('10:00').endTime, by('10:00').booked, by('10:00').capacity], ['11:00', 3, 3], 'booked row keeps its time; capacity never below bookings');
  });

  await check('removing a holiday reopens every slot the holiday closed (also extra manual ones), not manual closures', async () => {
    const d = addDays(today, 21);
    const extra = await addManualSlot(own, { branchId: A, visitMode: 'lab', date: d, startTime: '18:00', endTime: '18:30', capacity: 1 });
    const closedByHand = await addManualSlot(own, { branchId: A, visitMode: 'lab', date: d, startTime: '19:00', endTime: '19:30', capacity: 1 });
    await setSlotClosed(own, String(closedByHand._id), true);
    await partnerSvc.updateBranch(own, A, { holidays: [d] } as any);
    assert.equal((await PartnerSlotModel.findById(extra._id).lean())!.closed, 'holiday');
    await partnerSvc.updateBranch(own, A, { holidays: [] } as any);
    assert.equal((await PartnerSlotModel.findById(extra._id).lean())!.closed, null);
    assert.equal((await PartnerSlotModel.findById(closedByHand._id).lean())!.closed, 'manual');
    assert.ok((await PartnerSlotModel.find({ branchId: A, visitMode: 'lab', date: d, source: 'template' }).lean()).every((x) => x.closed === null));
  });

  await check('concurrent expansions never publish a stale template (each runs as one guarded transaction)', async () => {
    const d = addDays(today, 22);
    const every = (w: { start: string; end: string }[]) => Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((x) => [x, w]));
    for (let round = 0; round < 3; round++) {
      await saveSlotTemplate(own, B, 'lab', { slotMinutes: 30, capacity: 2, days: every([{ start: '08:00', end: '09:00' }]) });
      await Promise.all([
        expandSlots(B, 'lab', today, 30),
        saveSlotTemplate(own, B, 'lab', { slotMinutes: 30, capacity: 2, days: every([{ start: '15:00', end: '16:00' }]) }),
        expandSlots(B, 'lab', today, 30),
      ]);
      const open = (await PartnerSlotModel.find({ branchId: B, visitMode: 'lab', date: d, closed: null }).lean()).map((x) => x.startTime).sort();
      assert.deepEqual(open, ['15:00', '15:30'], `round ${round}`);
    }
  });

  await check('a slow stale expansion cannot overwrite a newer template: its transaction holds the guard, the save waits and wins', async () => {
    const d = addDays(today, 23);
    const every = (w: { start: string; end: string }[]) => Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((x) => [x, w]));
    await saveSlotTemplate(own, B, 'lab', { slotMinutes: 30, capacity: 2, days: every([{ start: '15:00', end: '16:00' }]) });
    // A stale run (it read the old 08:00 template) takes the guard and is paused before writing.
    const stale = await mongoose.startSession();
    stale.startTransaction();
    await ScheduleGuardModel.updateOne({ key: `partner-slots:${B}:lab` }, { $inc: { version: 1 } }, { session: stale });
    const saving = saveSlotTemplate(own, B, 'lab', { slotMinutes: 30, capacity: 2, days: every([{ start: '11:00', end: '12:00' }]) });
    await new Promise((r) => setTimeout(r, 400));
    // The stale run now publishes its old view, long "after expiry" in the old lease design, and commits.
    await PartnerSlotModel.updateMany({ branchId: B, visitMode: 'lab', date: d, startTime: { $in: ['15:00', '15:30'] } }, { $set: { closed: null } }, { session: stale });
    await PartnerSlotModel.updateMany({ branchId: B, visitMode: 'lab', date: d, startTime: { $in: ['11:00', '11:30'] } }, { $set: { closed: 'template' } }, { session: stale });
    await stale.commitTransaction();
    await stale.endSession();
    await saving;
    const open = (await PartnerSlotModel.find({ branchId: B, visitMode: 'lab', date: d, closed: null }).lean()).map((x) => x.startTime).sort();
    assert.deepEqual(open, ['11:00', '11:30'], 'the newest template is what is published');
  });

  await check('a branch with manual slots only still gets holidays; booking refuses a holiday even on a slot left open', async () => {
    const C = String((await partnerSvc.createBranch(own, branchIn('Manual only')))._id);
    const d = addDays(today, 24);
    const m = await addManualSlot(own, { branchId: C, visitMode: 'lab', date: d, startTime: '10:00', endTime: '10:30', capacity: 1 });
    await partnerSvc.updateBranch(own, C, { holidays: [d] } as any);
    assert.equal((await PartnerSlotModel.findById(m._id).lean())!.closed, 'holiday');
    await PartnerSlotModel.updateOne({ _id: m._id }, { $set: { closed: null } }); // as if no expansion had run
    await assert.rejects(async () => labSvc.create(await customer(), ({ partnerId, branchId: C, visitMode: 'lab', itemIds: [String(cbc._id)], patient: { kind: 'self' }, requestKey: rk(), slotId: String(m._id) } as any)), code('SLOT_UNAVAILABLE'));
    await partnerSvc.updateBranch(own, C, { holidays: [] } as any);
    assert.equal((await PartnerSlotModel.findById(m._id).lean())!.closed, null);
    await labSvc.create(await customer(), ({ partnerId, branchId: C, visitMode: 'lab', itemIds: [String(cbc._id)], patient: { kind: 'self' }, requestKey: rk(), slotId: String(m._id) } as any));
  });

  await check('the schedule guard is discovered by deploy-time index setup (modules/*/model) with its unique key', async () => {
    const modulesDir = nodePath.join(process.cwd(), 'src1', 'modules');
    for (const entry of fs.readdirSync(modulesDir, { withFileTypes: true })) {
      const dir = nodePath.join(modulesDir, entry.name, 'model');
      if (!entry.isDirectory() || !fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.ts') && !x.endsWith('.d.ts'))) await import(nodePath.join(dir, f));
    }
    const guard = mongoose.models.ScheduleGuard;
    assert.ok(guard, 'ScheduleGuard is defined in a model directory');
    assert.ok(guard.schema.indexes().some(([k, o]) => JSON.stringify(k) === '{"key":1}' && (o as any)?.unique === true));
  });

  await check('impossible calendar dates are refused, never rolled over to another day', async () => {
    await assert.rejects(() => addManualSlot(own, { branchId: A, visitMode: 'lab', date: '2027-02-31', startTime: '10:00', endTime: '10:30', capacity: 1 }), code('INVALID_DATE'));
    await assert.rejects(() => listSlotsForPartner(own, A, 'lab', '2027-02-30', '2027-03-05'), code('INVALID_DATE'));
    const r = await call('PUT', `/api/v1/partner-workspace/branches/${A}`, partnerToken(owner), { holidays: ['2027-02-29'] });
    assert.equal(r.status, 400);
    const ok = await call('GET', `/api/v1/partner-workspace/slots?branchId=${A}&visitMode=lab&from=2027-02-28&to=2027-03-01`, partnerToken(owner));
    assert.equal(ok.status, 200);
    assert.equal((await call('GET', `/api/v1/partner-workspace/slots?branchId=${A}&visitMode=lab&from=2027-02-31&to=2027-03-01`, partnerToken(owner))).status, 400);
  });

  const slotOn = async (dayOffset: number, start: string, mode: 'lab' | 'home' = 'lab') =>
    String((await PartnerSlotModel.findOne({ branchId: A, visitMode: mode, date: addDays(today, dayOffset), startTime: start }).lean())!._id);
  const input = (over: Record<string, unknown> = {}) => ({
    partnerId, branchId: A, visitMode: 'lab' as const, itemIds: [String(cbc._id), String(lipid._id)],
    patient: { kind: 'self' as const }, requestKey: rk(), ...over,
  }) as any;

  // ── Create and pay ──
  await check('parallel bookings for one slot: exactly capacity succeed, the rest are refused', async () => {
    const slotId = await slotOn(4, '08:30');
    const users = await Promise.all(Array.from({ length: 5 }, () => customer()));
    const r = await Promise.allSettled(users.map((u) => labSvc.create(u, input({ slotId }))));
    assert.equal(r.filter((x) => x.status === 'fulfilled').length, 2);
    assert.ok(r.filter((x) => x.status === 'rejected').every((x: any) => x.reason?.code === 'SLOT_UNAVAILABLE'));
    assert.equal((await PartnerSlotModel.findById(slotId).lean())!.booked, 2);
  });

  await check('create: pending payment with frozen terms and one gateway order; a resent create resumes the same booking and order', async () => {
    const u = await customer();
    const key = rk();
    const req = input({ slotId: await slotOn(5, '08:00'), requestKey: key });
    const first = await labSvc.create(u, req);
    assert.equal(first.paymentRequired, true);
    assert.equal(first.payment!.amount, 1300);
    const b = await PartnerLabBookingModel.findOne({ userId: u }).lean();
    assert.equal(b!.status, 'pending_payment');
    assert.deepEqual(b!.items.map((i) => i.priceMinor), [50000, 80000]);
    assert.equal(b!.settlement.settlementSystem, 'ledger');
    const again = await labSvc.create(u, { ...req, itemIds: [...req.itemIds].reverse(), useWalletBalance: false });
    assert.equal(again.payment!.razorpayOrderId, first.payment!.razorpayOrderId);
    await assert.rejects(async () => labSvc.create(u, input({ slotId: await slotOn(6, '08:00'), requestKey: key, itemIds: [String(cbc._id)] })),
      code('IDEMPOTENCY_KEY_REUSED'));
    assert.equal(await PartnerLabBookingModel.countDocuments({ userId: u }), 1);
    assert.equal(await PaymentRecordModel.countDocuments({ context: 'lab_booking', contextId: String(b!._id) }), 1);
  });

  await check('an abandoned request key can never create a booking', async () => {
    const u = await customer();
    const key = rk();
    assert.equal(await abandonRequestKey(scopeOf('lab_booking_create', u), key), 'abandoned');
    await assert.rejects(async () => labSvc.create(u, input({ slotId: await slotOn(5, '08:30'), requestKey: key })), code('REQUEST_ABANDONED'));
    assert.equal(await PartnerLabBookingModel.countDocuments({ userId: u }), 0);
  });

  await check('items must be offered (not admin-disabled) and support the visit type; home needs an address', async () => {
    const u = await customer();
    await assert.rejects(async () => labSvc.create(u, input({ slotId: await slotOn(5, '09:00'), itemIds: [String(hidden._id)] })), code('CATALOGUE_ITEM_NOT_AVAILABLE'));
    await assert.rejects(async () => labSvc.create(u, input({ slotId: await slotOn(5, '07:00', 'home'), visitMode: 'home', address: { line1: '1 Lane', city: 'Bengaluru', pincode: '560001' } })),
      code('VISIT_MODE_NOT_SUPPORTED'));
    await assert.rejects(async () => labSvc.create(u, input({ slotId: await slotOn(5, '07:00', 'home'), visitMode: 'home', itemIds: [String(cbc._id)] })), code('ADDRESS_REQUIRED'));
  });

  let paid: any; let paidUser = '';
  await check('a captured gateway payment confirms the booking exactly once (wallet part + gateway part)', async () => {
    paidUser = await customer(300);
    const init = await labSvc.create(paidUser, input({ slotId: await slotOn(7, '08:00'), useWalletBalance: true }));
    assert.equal(init.walletDeductedAmount, 300);
    assert.equal(init.payment!.amount, 1000);
    await capture(init.payment!.paymentTransactionId);
    await payments.reconcileContextPayments('lab_booking', String((init.booking as any)._id));
    await payments.reconcileContextPayments('lab_booking', String((init.booking as any)._id));
    paid = await PartnerLabBookingModel.findById((init.booking as any)._id).lean();
    assert.equal(paid.status, 'confirmed');
    assert.equal(paid.paymentStatus, 'paid');
    assert.equal(paid.statusVersion, 1);
    assert.equal(await balanceOf(paidUser), 0);
    assert.equal(notices.filter((n) => n.key === `plb:${paid._id}:confirmed`).length, 1);
    const rec = await PaymentRecordModel.findById(paid.paymentTransactionId).lean();
    assert.equal(rec!.isProcessed, true);
  });

  await check('wallet-covered booking is confirmed at once with an internal paid record', async () => {
    const u = await customer(2000);
    const init = await labSvc.create(u, input({ slotId: await slotOn(7, '08:30'), useWalletBalance: true }));
    assert.equal(init.paymentRequired, false);
    const b = await PartnerLabBookingModel.findOne({ userId: u }).lean();
    assert.equal(b!.status, 'confirmed');
    assert.equal(await balanceOf(u), 700);
    const rec = await PaymentRecordModel.findById(b!.paymentTransactionId).lean();
    assert.equal(rec!.paymentGateway, 'internal');
  });

  // ── Expiry and pay again ──
  await check('pay again reuses the open order inside the window and is refused after it', async () => {
    const u = await customer();
    const init = await labSvc.create(u, input({ slotId: await slotOn(8, '08:00') }));
    const id = String((init.booking as any)._id);
    const again = await labSvc.retryPayment(u, id, false);
    assert.equal(again.payment!.razorpayOrderId, init.payment!.razorpayOrderId);
    await assert.rejects(() => labSvc.retryPayment(u, id, false, new Date(Date.now() + 31 * 60_000)), code('LAB_BOOKING_PAYMENT_EXPIRED'));
  });

  await check('a resent create is admitted like pay again: never a new checkout after expiry or beside an unsettled attempt', async () => {
    const u = await customer();
    const req = input({ slotId: await slotOn(8, '09:00') });
    const init = await labSvc.create(u, req);
    const id = String((init.booking as any)._id);
    const rec = await PaymentRecordModel.findById(init.payment!.paymentTransactionId).lean();
    await PaymentRecordModel.updateOne({ _id: rec!._id }, { $set: { status: 'failed' } }); // not resumable any more
    unreachable.add(rec!.razorpayOrderId);
    await PaymentRecordModel.create({ userId: u, context: 'lab_booking', contextId: id, baseAmount: 1300, discountAmount: 0, finalAmount: 1300,
      currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: rec!.razorpayOrderId + '_b', status: 'created', notes: { walletDeductedAmount: 0 } });
    unreachable.add(rec!.razorpayOrderId + '_b');
    try {
      await assert.rejects(() => labSvc.create(u, req), code('PAYMENT_STATE_UNKNOWN'));
    } finally { unreachable.delete(rec!.razorpayOrderId); unreachable.delete(rec!.razorpayOrderId + '_b'); }
    const before = await PaymentRecordModel.countDocuments({ context: 'lab_booking', contextId: id });
    await assert.rejects(() => labSvc.create(u, req, new Date(Date.now() + 31 * 60_000)), code('LAB_BOOKING_PAYMENT_EXPIRED'));
    assert.equal(await PaymentRecordModel.countDocuments({ context: 'lab_booking', contextId: id }), before, 'no checkout after expiry');
    // A capture on the earlier attempt is settled first; the resend then only returns the receipt.
    gateway.set(rec!.razorpayOrderId + '_b', [{ id: 'pay_resend', order_id: rec!.razorpayOrderId + '_b', amount: 130000, currency: 'INR', status: 'captured' }]);
    const again = await labSvc.create(u, req);
    assert.equal(again.paymentRequired, false);
    assert.equal((await PartnerLabBookingModel.findById(id).lean())!.status, 'confirmed');
    assert.equal(await PaymentRecordModel.countDocuments({ context: 'lab_booking', contextId: id }), before);
  });

  await check('unpaid bookings expire after 30 minutes: seat and wallet money returned; a later capture goes back to the wallet', async () => {
    const u = await customer(200);
    const slotId = await slotOn(8, '08:30');
    const init = await labSvc.create(u, input({ slotId, useWalletBalance: true }));
    const id = String((init.booking as any)._id);
    assert.equal(await balanceOf(u), 0);
    assert.equal((await labSvc.expireDue(new Date())).expired, 0, 'not due yet');
    const later = new Date(Date.now() + 31 * 60_000);
    const r = await labSvc.expireDue(later);
    assert.ok(r.expired >= 1);
    const b = await PartnerLabBookingModel.findById(id).lean();
    assert.equal(b!.status, 'cancelled');
    assert.equal(b!.cancellation!.reason, 'timeout');
    assert.equal(await balanceOf(u), 200);
    assert.equal((await PartnerSlotModel.findById(slotId).lean())!.booked, 0);
    await capture(init.payment!.paymentTransactionId);
    await payments.reconcileContextPayments('lab_booking', id);
    assert.equal(await balanceOf(u), 200 + 1100, 'late capture returned to the wallet');
    assert.equal((await PaymentRecordModel.findById(init.payment!.paymentTransactionId).lean())!.status, 'refunded');
    assert.equal((await PartnerLabBookingModel.findById(id).lean())!.status, 'cancelled');
  });

  await check('expiry waits while the gateway cannot be asked', async () => {
    const u = await customer();
    const init = await labSvc.create(u, input({ slotId: await slotOn(9, '08:00') }));
    const rec = await PaymentRecordModel.findById(init.payment!.paymentTransactionId).lean();
    unreachable.add(rec!.razorpayOrderId);
    try {
      const r = await labSvc.expireDue(new Date(Date.now() + 31 * 60_000));
      assert.ok(r.deferred >= 1);
      const b = await PartnerLabBookingModel.findById((init.booking as any)._id).lean();
      assert.equal(b!.status, 'pending_payment');
      assert.ok(b!.expiryNextAt);
    } finally { unreachable.delete(rec!.razorpayOrderId); }
  });

  // ── Cancellation and reschedule ──
  const confirmedBooking = async (dayOffset: number, start: string, walletRupees = 1300) => {
    const u = await customer(walletRupees);
    const init = await labSvc.create(u, input({ slotId: await slotOn(dayOffset, start), useWalletBalance: true }));
    return { u, id: String((init.booking as any)._id) };
  };

  await check('customer cancel before the cutoff refunds everything once and frees the seat; inside 2 hours it is refused', async () => {
    const { u, id } = await confirmedBooking(10, '08:00');
    const b = await PartnerLabBookingModel.findById(id).lean();
    await assert.rejects(() => labSvc.customerCancel(u, id, 'late', new Date(new Date(b!.slot.startsAt).getTime() - LAB_CANCEL_CUTOFF_MS + 60_000)),
      code('CANCELLATION_WINDOW_CLOSED'));
    const r = await labSvc.customerCancel(u, id, 'plans changed');
    assert.equal(r.refunded, 1300);
    assert.equal(await balanceOf(u), 1300);
    assert.equal((await PartnerSlotModel.findById(b!.slot.slotId).lean())!.booked, 0);
    await assert.rejects(() => labSvc.customerCancel(u, id, 'again'), code('LAB_BOOKING_NOT_CANCELLABLE'));
    assert.equal(await balanceOf(u), 1300);
  });

  await check('lab reschedule: staff progress blocked until the customer answers; the entitlement allows a late full refund', async () => {
    const { u, id } = await confirmedBooking(11, '08:00');
    const newSlot = await slotOn(11, '09:00');
    const after = await labSvc.labReschedule(deskA, id, newSlot, 'Phlebotomist unavailable') as any;
    assert.equal(after.reschedule.pending, true);
    assert.equal(after.reschedule.version, 1);
    await assert.rejects(() => labSvc.markVisited(deskA, id), code('RESCHEDULE_PENDING'));
    const b = await PartnerLabBookingModel.findById(id).lean();
    const insideCutoff = new Date(new Date(b!.slot.startsAt).getTime() - 30 * 60_000);
    const r = await labSvc.customerCancel(u, id, 'new time does not suit me', insideCutoff);
    assert.equal(r.refunded, 1300);
    assert.equal((await PartnerSlotModel.findById(newSlot).lean())!.booked, 0);
    assert.equal((await PartnerSlotModel.findById(b!.reschedule.previousSlot!.slotId).lean())!.booked, 0);
  });

  let flow: { u: string; id: string };
  await check('accepting a reschedule is a compare-and-set on its version; then the visit can be recorded', async () => {
    flow = await confirmedBooking(12, '08:00');
    await labSvc.labReschedule(deskA, flow.id, await slotOn(12, '09:00'), 'Machine maintenance');
    await labSvc.labReschedule(deskA, flow.id, await slotOn(12, '09:30'), 'Moved again');
    await assert.rejects(() => labSvc.acceptReschedule(flow.u, flow.id, 1), code('RESCHEDULE_CHANGED'));
    const ok = await labSvc.acceptReschedule(flow.u, flow.id, 2) as any;
    assert.equal(ok.reschedule.pending, false);
    await assert.rejects(() => labSvc.markCollected(deskA, flow.id), code('WRONG_VISIT_MODE'));
    await assert.rejects(() => labSvc.startProcessing(deskA, flow.id), code('LAB_BOOKING_STATE_CONFLICT'));
    await assert.rejects(() => labSvc.markNoShow(deskA, flow.id), code('SLOT_NOT_STARTED'));
    assert.equal(((await labSvc.markVisited(deskA, flow.id)) as any).status, 'visited');
    assert.equal(((await labSvc.startProcessing(deskA, flow.id)) as any).status, 'processing');
  });

  await check('branch scope: staff of branch A cannot see or act on a branch-B booking', async () => {
    await saveSlotTemplate(own, B, 'lab', { slotMinutes: 60, capacity: 1, days: { [['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(Date.parse(addDays(today, 13))).getUTCDay()]!]: [{ start: '10:00', end: '11:00' }] } });
    const u = await customer(1300);
    const slotB = String((await PartnerSlotModel.findOne({ branchId: B, visitMode: 'lab', date: addDays(today, 13), startTime: '10:00' }).lean())!._id);
    const init = await labSvc.create(u, input({ branchId: B, slotId: slotB, useWalletBalance: true }));
    const id = String((init.booking as any)._id);
    await assert.rejects(() => labSvc.getForPartner(deskA, id), code('LAB_BOOKING_NOT_FOUND'));
    await assert.rejects(() => labSvc.markVisited(deskA, id), code('LAB_BOOKING_NOT_FOUND'));
    assert.ok((await labSvc.listForPartner(deskA, {})).every((b: any) => b.branchId === A));
    const rej = await labSvc.labReject(own, id, 'Reagent out of stock');
    assert.equal(rej.refunded, 1300);
    assert.equal(await balanceOf(u), 1300);
    assert.equal((await PartnerLabBookingModel.findById(id).lean())!.cancellation!.reason, 'lab_reject');
  });

  // ── Reports (real multipart upload → draft → release; every content alias) ──
  async function customerView(u: string, id: string) { return labSvc.getForCustomer(u, id) as Promise<any>; }
  const rel = (url: string) => url.replace(/^\/api\/static\//, '');
  const aliases = (p: string) => [`/api/static/${p}`, `/api/v1/file/static/${p}`, `/api/v1/file/fetch?url=${encodeURIComponent(p)}`];
  let releasedPath = '';
  await check('report upload is booking-scoped HTTP only: generic uploads cannot write report folders; drafts are partner-only', async () => {
    const generic = await uploadVia(partnerToken(desk), '/api/v1/file/upload/partner-lab-reports');
    assert.equal(generic.status, 400);
    assert.equal(generic.json.code ?? generic.json.error?.code, 'UPLOAD_MODULE_RESERVED');
    const noPerm = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'No reports', role: 'staff', permissions: ['bookings.view'] });
    assert.equal((await uploadVia(partnerToken(noPerm), `/api/v1/partner-workspace/lab-bookings/${flow.id}/reports`)).status, 403);
    const up = await uploadVia(partnerToken(desk), `/api/v1/partner-workspace/lab-bookings/${flow.id}/reports`, 'cbc.pdf');
    assert.equal(up.status, 201);
    const draftUrl = up.json.data.report.draftFiles[0] as string;
    const draft = rel(draftUrl);
    assert.ok(draft.startsWith(`partner-lab-reports/${flow.id}/`));
    for (const a of aliases(draft)) {
      assert.equal(await fetchStatus(a, userToken(flow.u)), 404, `customer cannot read a draft via ${a.split('?')[0]}`);
      assert.equal(await fetchStatus(a, partnerToken(pathologist)), 200, `releaser reads the draft via ${a.split('?')[0]}`);
    }
    assert.equal((await customerView(flow.u, flow.id)).report.files.length, 0);
    releasedPath = draft;
  });

  await check('the uploader loses draft access with the permission or the branch (no uploader shortcut for reports)', async () => {
    for (const a of aliases(releasedPath)) assert.equal(await fetchStatus(a, partnerToken(desk)), 200);
    await MemberModel.updateOne({ _id: desk._id }, { $set: { permissions: ['bookings.view', 'bookings.manage', 'slots.manage'] } });
    for (const a of aliases(releasedPath)) assert.equal(await fetchStatus(a, partnerToken(desk)), 404, `revoked permission via ${a.split('?')[0]}`);
    await MemberModel.updateOne({ _id: desk._id }, { $set: { permissions: ['bookings.view', 'bookings.manage', 'slots.manage', 'reports.upload'], branchIds: [B] } });
    for (const a of aliases(releasedPath)) assert.equal(await fetchStatus(a, partnerToken(desk)), 404, `other branch via ${a.split('?')[0]}`);
    await MemberModel.updateOne({ _id: desk._id }, { $set: { branchIds: [A] } });
    assert.equal(await fetchStatus(`/api/static/${releasedPath}`, partnerToken(desk)), 200);
  });

  await check('release needs a registered professional who also covers the booking\'s branch; then only the customer (and staff) read it', async () => {
    await assert.rejects(() => labSvc.releaseReport(own, flow.id, releasedPath), code('SIGNER_REGISTRATION_MISSING'));
    await assert.rejects(() => labSvc.releaseReport(adminActor('adm9', partnerId), flow.id, releasedPath), code('SIGNER_REQUIRED'));
    const bSigner = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Dr B', role: 'staff', branchIds: [B], permissions: ['reports.release'] });
    await MemberModel.updateOne({ _id: bSigner._id }, { $set: { professional: { kind: 'pathologist', registrationNumber: 'KMC-B' } } });
    await assert.rejects(() => labSvc.releaseReport(adminActor('adm9', partnerId), flow.id, releasedPath, String(bSigner._id)), code('SIGNER_NOT_AUTHORISED'));
    const r = await call('POST', `/api/v1/partner-workspace/lab-bookings/${flow.id}/reports/release`, partnerToken(pathologist), { file: `/api/static/${releasedPath}` });
    assert.equal(r.status, 200);
    assert.equal(r.json.data.status, 'report_ready');
    assert.equal(r.json.data.report.releases[0].signer.registrationNumber, 'KMC-12345');
    const cv = await customerView(flow.u, flow.id);
    assert.deepEqual(cv.report.files, [`/api/static/${releasedPath}`]);
    // Q9: each release names its file; the lab and branch are named; the list is paged; one lab can be read.
    assert.equal(cv.report.releases[0].file, `/api/static/${releasedPath}`);
    assert.equal(cv.report.releases[0].signer.registrationNumber, 'KMC-12345');
    assert.ok(cv.lab?.name && cv.branch?.name);
    const page = await labSvc.listForCustomer(flow.u, 1, 1);
    assert.equal(page.items.length, 1);
    assert.ok(page.total >= 1 && page.totalPages >= page.total);
    assert.equal((await labSvc.labProfile(partnerId)).name, 'Metro Labs');
    await assert.rejects(() => labSvc.labProfile(String(new Types.ObjectId())), code('LAB_NOT_FOUND'));
    const prof = await call('GET', `/api/v1/partner-labs/${partnerId}`, userToken(flow.u));
    assert.equal(prof.status, 200);
    const lst = await call('GET', '/api/v1/lab-bookings?limit=1', userToken(flow.u));
    assert.ok(Array.isArray(lst.json.data) && lst.json.pagination.limit === 1);
    for (const a of aliases(releasedPath)) {
      assert.equal(await fetchStatus(a, userToken(flow.u)), 200, `customer reads the release via ${a.split('?')[0]}`);
      assert.equal(await fetchStatus(a, userToken(await customer())), 404);
    }
    const again = await labSvc.releaseReport(path, flow.id, releasedPath) as any;
    assert.equal(again.report.releases.length, 1, 'idempotent');
  });

  await check('completion posts the partner earning exactly once (its own price, commission 0)', async () => {
    const done = await labSvc.complete(deskA, flow.id) as any;
    assert.equal(done.status, 'completed');
    await assert.rejects(() => labSvc.complete(deskA, flow.id), code('LAB_BOOKING_STATE_CONFLICT'));
    const acct = await SettlementAccountModel.findOne({ ownerKind: 'partner', ownerId: partnerId }).lean();
    const entries = await LedgerEntryModel.find({ settlementAccountId: String(acct!._id), source: 'partner_lab_booking' }).lean();
    assert.equal(entries.length, 1);
    assert.equal(entries[0]!.amountMinor, 130000);
    assert.equal(entries[0]!.commissionMinor, 0);
    const audit = await PartnerAuditEventModel.find({ targetId: flow.id }).lean();
    assert.ok(['lab_booking.visit', 'lab_booking.process', 'lab_booking.report_upload', 'lab_booking.report_release', 'lab_booking.complete']
      .every((a) => audit.some((x) => x.action === a)));
  });

  await check('a no-show is not refunded and the partner earns it once; customers never see staff ids', async () => {
    const { u, id } = await confirmedBooking(16, '08:00');
    await labSvc.assignCollector(deskA, id, { memberId: String(desk._id), name: 'Ravi', phone: '9000011111' });
    const b = await PartnerLabBookingModel.findById(id).lean();
    const after = new Date(new Date(b!.slot.startsAt).getTime() + 60_000);
    assert.equal(((await labSvc.markNoShow(deskA, id, after)) as any).status, 'no_show');
    const acct = await SettlementAccountModel.findOne({ ownerKind: 'partner', ownerId: partnerId }).lean();
    const e = await LedgerEntryModel.find({ settlementAccountId: String(acct!._id), source: 'partner_lab_booking', sourceId: id }).lean();
    assert.deepEqual(e.map((x) => [x.kind, x.amountMinor]), [['earning', 130000]]);
    assert.equal(await balanceOf(u), 0, 'no refund');
    const cv = await labSvc.getForCustomer(u, id) as any;
    assert.deepEqual(cv.collector, { name: 'Ravi', phone: '9000011111' });
    assert.ok(!JSON.stringify(cv).includes(String(desk._id)));
  });

  await check('admin acts as owner on lab bookings (releases under a named member)', async () => {
    const { id } = await confirmedBooking(14, '08:00');
    const adm = adminActor('adm1', partnerId);
    await labSvc.markVisited(adm, id);
    await labSvc.startProcessing(adm, id);
    const up = await uploadVia(adminToken, `/api/v1/partner-workspace/admin/${partnerId}/workspace/lab-bookings/${id}/reports`, 'admin.pdf');
    assert.equal(up.status, 201);
    const draft = rel(up.json.data.report.draftFiles[0]);
    const v = await labSvc.releaseReport(adm, id, draft, String(pathologist._id)) as any;
    assert.equal(v.report.releases[0].releasedBy, 'admin:adm1');
    assert.equal(v.report.releases[0].signer.memberId, String(pathologist._id));
  });

  // ── Discovery ──
  await check('customers see verified labs, offered items and bookable slots only', async () => {
    await partnerSvc.createPartner({ kind: 'lab', name: 'Unverified Lab', contactPhone: nextPhone(), invoiceSeriesPrefix: 'UL', firstOwner: { phone: nextPhone(), name: 'x' } });
    const labs = await labSvc.listLabs({ city: 'bengaluru' });
    assert.deepEqual(labs.map((l) => l.name), ['Metro Labs']);
    assert.ok([A, B].every((b) => labs[0]!.branches.some((x) => x.branchId === b)));
    const items = await labSvc.labCatalogue(partnerId, 'home');
    assert.deepEqual(items.map((i) => i.name), ['CBC']);
    await PartnerSlotModel.updateOne({ branchId: A, visitMode: 'lab', date: addDays(today, 4), startTime: '09:00' }, { $set: { booked: 2 } });
    await PartnerSlotModel.updateOne({ branchId: A, visitMode: 'lab', date: addDays(today, 4), startTime: '09:30' }, { $set: { closed: 'manual' } });
    const slots = await labSvc.branchSlots(A, 'lab', addDays(today, 4), 1);
    assert.ok(!slots.some((s) => s.startTime === '09:00'), 'a full slot is not offered');
    assert.ok(!slots.some((s) => s.startTime === '09:30'), 'a closed slot is not offered');
    assert.ok(slots.some((s) => s.startTime === '08:30'), 'seats freed by expired bookings are offered again');
    assert.ok(slots.every((s) => s.seatsLeft > 0));
  });

  // ── Cutover ──
  await check('cutover: new bookings stamped by date; legacy payouts never bill ledger bookings; history imported once in paise', async () => {
    (CONFIG as any).SETTLEMENT_CUTOVER_AT = undefined;
    assert.equal(settlementSystemFor(new Date()), 'legacy');
    (CONFIG as any).SETTLEMENT_CUTOVER_AT = new Date(Date.now() - 1000).toISOString();
    assert.equal(settlementSystemFor(new Date()), 'ledger');
    assert.equal(settlementSystemFor(new Date(Date.now() - 86_400_000)), 'legacy');
    const sp = new Types.ObjectId().toHexString();
    await SpecialistModel.collection.insertOne({ _id: new Types.ObjectId(sp), name: 'Dr Legacy' } as never);
    const created = await createBookingWithHolds({ userId: new Types.ObjectId().toHexString(), specialistId: sp, bookingType: 'surgery',
      bookingDate: '20261201', bookingTime: '10:00', serviceMode: 'in-person', price: 999, status: 'confirmed', paymentStatus: 'paid' } as any);
    assert.equal(created.settlementSystem, 'ledger', 'Q4a: with the doctor ledger earnings in place, the cutover applies to ordinary bookings');
    (CONFIG as any).SETTLEMENT_CUTOVER_AT = undefined;
    const base = { specialistId: sp, bookingType: 'consultation', bookingDate: '20261210', status: 'confirmed', paymentStatus: 'paid' };
    await BookingModel.collection.insertMany([{ ...base, price: 500 }, { ...base, price: 700, settlementSystem: 'legacy' }, { ...base, price: 900, settlementSystem: 'ledger' }] as never);
    const payout = new PayoutService(new BookingRepository(), {} as any) as any;
    const snap = await payout.calculateBillingSnapshot(sp, 202612);
    assert.equal(snap.total, 1200, 'the ledger booking is not billed by the legacy system');
    assert.equal(snap.totalAppointments, 2);
    await PayoutBillingModel.create({ specialistId: sp, month: 202611, total: 1234.5, paid: 1000, due: 234.5, status: 'Partially Paid',
      totalAppointments: 3, totalPatients: 3, totalUniquePatients: 3, totalFollowUpAppointments: 0 } as any);
    await PayoutDisbursalModel.create({ specialistId: sp, billingIds: [], disbursalAmount: 1000, disbursalDate: Math.floor(Date.now() / 1000), createdByAdminId: 'adm' } as any);
    const dry = await runSettlementCutover(false);
    assert.ok(dry.unstampedBefore >= 1);
    assert.equal(dry.imported, 0);
    const r1 = await runSettlementCutover(true);
    assert.equal(r1.unstampedAfter, 0);
    assert.equal(r1.imported, 2);
    const r2 = await runSettlementCutover(true);
    assert.equal(r2.stamped, 0);
    assert.equal(r2.imported, 0);
    const acct = await SettlementAccountModel.findOne({ ownerKind: 'doctor', ownerId: sp }).lean();
    const refs = await LedgerHistoryRefModel.find({ settlementAccountId: String(acct!._id) }).lean();
    assert.deepEqual(refs.map((x) => [x.legacyKind, x.amountMinor]).sort(), [['billing', 123450], ['disbursal', 100000]].sort());
    assert.equal(await ledgerBalance(String(acct!._id)), 0, 'history never posts to the balance');
    assert.equal(await BookingModel.countDocuments({ specialistId: sp, settlementSystem: 'legacy' }), 2);
  });

  // ── HTTP ──
  try {
    await check('HTTP: customer discovers, books (201) and sees no draft files; partner tokens are refused on customer routes', async () => {
      const u = await customer(1300);
      const t = userToken(u);
      assert.equal((await call('GET', '/api/v1/partner-labs', t)).status, 200);
      const slots = await call('GET', `/api/v1/partner-labs/branches/${A}/slots?visitMode=lab&from=${addDays(today, 15)}&days=1`, t);
      assert.equal(slots.status, 200);
      const made = await call('POST', '/api/v1/lab-bookings', t, input({ slotId: slots.json.data[0].slotId, useWalletBalance: true }));
      assert.equal(made.status, 201);
      assert.equal(made.json.data.paymentRequired, false);
      const mine = await call('GET', `/api/v1/lab-bookings/${made.json.data.booking._id}`, t);
      assert.equal(mine.status, 200);
      assert.ok(!('draftFiles' in mine.json.data.report) && !('walletFunding' in mine.json.data));
      assert.equal((await call('GET', '/api/v1/lab-bookings', partnerToken(owner))).status, 403);
      const bad = await call('POST', '/api/v1/lab-bookings', t, input({ slotId: slots.json.data[0].slotId, visitMode: 'home' }));
      assert.equal(bad.status, 400, 'home without address refused by validation');
    });

    await check('HTTP: members and admins manage lab bookings through the workspace', async () => {
      const list = await call('GET', '/api/v1/partner-workspace/lab-bookings', partnerToken(desk));
      assert.equal(list.status, 200);
      assert.ok(list.json.data.every((b: any) => b.branchId === A));
      const adminList = await call('GET', `/api/v1/partner-workspace/admin/${partnerId}/workspace/lab-bookings`, adminToken);
      assert.equal(adminList.status, 200);
      assert.ok(adminList.json.data.length >= list.json.data.length);
      const all = await call('GET', '/api/v1/partner-workspace/admin/lab-bookings', adminToken);
      assert.equal(all.status, 200);
      const noPerm = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Billing only', role: 'staff', permissions: ['invoices.create'] });
      assert.equal((await call('GET', '/api/v1/partner-workspace/lab-bookings', partnerToken(noPerm))).status, 403);
    });
  } finally {
    server.close();
  }

  await mongoose.disconnect();
  removeFixtureDir();
  console.log(`\n${passed} checks passed`);
}

main().catch(async (e) => { console.error(e); await mongoose.disconnect(); process.exit(1); });
