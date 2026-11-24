/**
 * Round 2e (ASSISTED_BOOKING_DESIGN.md §24.8, §7.3, decision G): a LAB member books a doctor consultation for a walk-in
 * patient, paid from the lab wallet (2d) or by card/UPI (the 1b machinery with a lab payer). One code path with the
 * pharmacy's: permission `assisted.book` and the member's branch scope ("nearby" = its branch); the booker wallet
 * dispatcher debits and refunds the LAB store; every cancel path (booker, patient, doctor) refunds the lab, never the
 * customer wallet, and the refund always posts; booker notices go to the booking member; the lab reads the prescription's
 * dispensing copy for 90 days and never the full PDF; a lab never books another lab's tests. Real routes over HTTP
 * (configureRoutes) on MongoDB; Razorpay, the refund gateway and wkhtmltopdf are stand-ins.
 *
 * Every check runs even when an earlier one fails (the run exits 1 if any failed).
 *
 * Run (throwaway DB only; the script drops its database):
 *   JWT_SECRET_KEY=local-integration-only SESSION_ORIGINS_CUSTOMER=https://app.jansetu.test SESSION_ORIGINS_WORKSPACE=https://staff.jansetu.test \
 *     MONGODB_URL='mongodb://127.0.0.1:27917/r21_phase2e_check?directConnection=true' npx tsx test/assisted/r21-phase2e.integration.ts
 */
import { FIXTURE_DIR, UPLOAD_DIR, removeFixtureDir } from '../partners/q3-fixture-dir';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import { Container } from 'typedi';
import { CONFIG } from '@/config/config';
import { errorHandler } from '@/modules/middleware';
import UserModel from '@/modules/user/model';
import { UserRepository } from '@/modules/user/repository';
import BookingModel from '@/modules/bookings/model';
import { BookingRepository } from '@/modules/bookings/repository';
import { BookingService } from '@/modules/bookings/services';
import SlotModel from '@/modules/slots/model';
import { PaymentRepository } from '@/modules/payment/repository';
import { PaymentService } from '@/modules/payment/services';
import PaymentRecordModel from '@/modules/payment/model';
import { WalletModel } from '@/modules/wallet/model';
import { WalletRepository, WalletTransactionRepository } from '@/modules/wallet/repository';
import { CouponService } from '@/modules/coupon/services';
import { CouponRepository } from '@/modules/coupon/repository';
import PharmacyModel from '@/modules/pharmacies/model';
import { PharmacyService } from '@/modules/pharmacies/services';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import { BannerService } from '@/modules/banners/services';
import { BannerRepository } from '@/modules/banners/repository';
import SpecialistModel from '@/modules/specialists/model';
import { SpecialistService } from '@/modules/specialists/services';
import { SpecialistPortalService } from '@/modules/specialistPortal/services';
import PartnerModel from '@/modules/partners/model';
import MemberModel from '@/modules/partners/model/member';
import { PartnerRepository } from '@/modules/partners/repository';
import { MemberRepository } from '@/modules/partners/repository/member';
import { BranchRepository } from '@/modules/partners/repository/branch';
import { CatalogueItemRepository } from '@/modules/partners/repository/catalogueItem';
import { PartnerService, type PartnerActor } from '@/modules/partners/services';
import { CatalogueService } from '@/modules/partners/services/catalogue';
import { LabBookingService } from '@/modules/partners/services/labBookings';
import { PartnerWalletEntryModel, PartnerWalletModel } from '@/modules/partnerWallets/model';
import { AssistedAuditEventModel } from '@/modules/assisted/model';
import { AssistedLinkModel } from '@/modules/assisted/model/links';
import type { IMember, PartnerPermission } from '@/modules/partners/types';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/r21_phase2e_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const oid = () => new Types.ObjectId().toHexString();
const MIN = 60_000;
const DAY = 86_400_000;
const IST = 330 * MIN;
const istParts = (at: Date) => { const s = new Date(at.getTime() + IST).toISOString(); return { date: s.slice(0, 10).replace(/-/g, ''), time: s.slice(11, 16) }; };
const noop = new Proxy({}, { get: () => async () => undefined });

// The converter stand-in: copies its HTML input to the PDF path (the dispensing copy's content can be read back).
const CONVERTER = path.join(FIXTURE_DIR, 'fake-wkhtmltopdf.sh');
fs.writeFileSync(CONVERTER, '#!/bin/sh\ncp "$1" "$2"\n', { mode: 0o755 });
process.env.WKHTMLTOPDF_BINARY = CONVERTER;
const read = (url: string) => fs.readFileSync(path.join(UPLOAD_DIR, url.replace(/^\/api\/static\//, '')), 'utf8');

/** Razorpay stand-in: orders, the captures each order holds (set per check), refunds. */
const gateway = {
  orders: [] as { id: string; amount: number }[],
  payments: {} as Record<string, { id: string; order_id: string; amount: number; currency: string; status: string; fee?: number }[]>,
  refunds: [] as { id: string; paymentId: string; amount: number; status: string }[],
};
const fakeRazorpay = {
  orders: {
    create: async (o: { amount: number; currency: string }) => {
      const id = 'order_r21_' + oid();
      gateway.orders.push({ id, amount: o.amount });
      return { id, amount: o.amount, currency: o.currency, status: 'created' };
    },
    fetchPayments: async (orderId: string) => ({ items: gateway.payments[orderId] ?? [] }),
  },
  payments: { fetch: async (id: string) => {
    const p = Object.values(gateway.payments).flat().find((x) => x.id === id);
    if (!p) throw Object.assign(new Error('The id provided does not exist'), { statusCode: 400, error: { code: 'BAD_REQUEST_ERROR' } });
    return p;
  } },
};
const refundGateway = {
  listRefunds: async (paymentId: string) => gateway.refunds.filter((r) => r.paymentId === paymentId),
  fetchRefund: async (_p: string, refundId: string) => gateway.refunds.find((x) => x.id === refundId),
  refund: async (paymentId: string, body: { amount: number }) => {
    const r = { id: 'rfnd_' + oid(), paymentId, amount: body.amount, status: 'processed' };
    gateway.refunds.push(r);
    return r;
  },
};

// ── Services (tsx emits no decorator metadata: wired by hand before the routers load) ──
const payments = Object.assign(Object.create(PaymentService.prototype), {
  bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
  walletTransactionRepository: new WalletTransactionRepository(), bookingReminderScheduler: noop,
  getRazorpayClient: () => fakeRazorpay, getRazorpayCredentials: () => ({ keyId: 'rzp_test_key', keySecret: 'secret' }),
}) as unknown as PaymentService;
const specialists = { getById: async (id: string) => SpecialistModel.findById(id).lean() };
const bookingService = Object.assign(Object.create(BookingService.prototype), {
  bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
  walletTransactionRepository: new WalletTransactionRepository(), userRepository: new UserRepository(),
  notificationService: noop, paymentService: payments, couponService: {}, emailService: {}, bookingReminderScheduler: noop,
  specialistService: specialists, slotService: { getById: async (id: string) => SlotModel.findById(id).lean() },
}) as BookingService;
const partnerSvc = new PartnerService(new PartnerRepository(), new MemberRepository(), new BranchRepository());
const labSvc = new LabBookingService(payments, new CouponService(new CouponRepository()), new WalletRepository());
labSvc.notify = async () => undefined;
Container.set(BookingService, bookingService);
Container.set(PaymentService, payments);
Container.set(PartnerService, partnerSvc);
Container.set(CatalogueService, new CatalogueService(new CatalogueItemRepository()));
Container.set(LabBookingService, labSvc);
Container.set(PharmacyService, new PharmacyService(new PharmacyRepository(), new UserRepository()));
Container.set(BannerService, new BannerService(new BannerRepository()));
Container.set(SpecialistService, specialists as never);
Container.set(SpecialistPortalService, Object.assign(Object.create(SpecialistPortalService.prototype), {
  bookingRepository: new BookingRepository(), userRepository: new UserRepository(), bookingService, notificationService: noop, specialistService: specialists,
}));

let passed = 0;
const failed: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log('ok -', name); } catch (e) { failed.push(name); console.log('FAIL -', name); console.error(e); }
}
const actorFor = (m: IMember): PartnerActor => ({ memberId: String(m._id), partnerId: String(m.partnerId), role: m.role,
  permissions: m.permissions as PartnerPermission[], branchIds: (m.branchIds ?? []).map(String) });
let phoneSeq = 7210000000;
const nextPhone = () => String(phoneSeq++);
let keySeq = 0;
const newKey = () => `r21-key-${String(++keySeq).padStart(4, '0')}-${oid().slice(-6)}`;

async function main() {
  await mongoose.connect(FIXTURE_URL);
  await mongoose.connection.dropDatabase();
  const support = await import('@/modules/assisted/support');
  const notices: { audience: string; userId: string; key: string; message: string }[] = [];
  support.setAssistedNotifier(async (n) => { notices.push({ audience: n.audience, userId: n.userId, key: n.key, message: n.message }); });
  support.setAssistedEffects({ meet: async (b: any) => b, cancelMeet: async (b: any) => b, reminders: async () => undefined, clearReminders: async () => undefined } as never);
  (await import('@/modules/assisted/cardRefunds')).setAssistedRefundGateway(refundGateway as never);
  const { configureRoutes } = await import('@/routes');
  for (const name of mongoose.modelNames()) {
    const m = mongoose.model(name);
    await m.createCollection().catch(() => undefined);
    await m.syncIndexes();
  }
  const app = express();
  app.use(express.json());
  configureRoutes(app);
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.ASSISTED_LIMIT_LOOKUPS_PER_HOUR = '100000';
  process.env.ASSISTED_BOOKING_ENABLED_PHARMACY = 'true';
  process.env.ASSISTED_BOOKING_ENABLED_LAB = 'true';
  process.env.ASSISTED_ADMIN_TOOLS_ENABLED = 'true';
  process.env.ASSISTED_CARD_PAYMENT_ENABLED = 'true';

  try {
    // ── A verified lab with two branches and staff; a second lab; an unverified lab; a clinic ──
    const branchIn = (name: string, pincode: string, city: string) => ({ name, phone: '9876500000', holidays: [], hours: {},
      services: { homeCollection: true, inLab: true, inClinic: false }, address: { line1: '1 Road', city, state: 'Meghalaya', stateCode: '17', pincode } }) as never;
    const mkLab = async (name: string, gstin: string, kind: 'lab' | 'clinic' = 'lab', verify = true) => {
      const { partner, owner } = await partnerSvc.createPartner({ kind, name, legalName: name, contactPhone: nextPhone(), invoiceSeriesPrefix: name.slice(0, 2).toUpperCase(),
        firstOwner: { phone: nextPhone(), name: `${name} Owner` }, taxRegime: 'regular', gstin, contactEmail: `${name.toLowerCase().replace(/\s/g, '')}@lab.test` } as never);
      if (verify) await partnerSvc.verifyPartner(String(partner._id), 'admin');
      return { id: String(partner._id), owner };
    };
    const lab = await mkLab('Metro Labs', '29AABCM1234F1ZH');
    const L = lab.id;
    const own = actorFor(lab.owner);
    const A = String((await partnerSvc.createBranch(own, branchIn('Police Bazar', '793001', 'Shillong')))._id);
    const B = String((await partnerSvc.createBranch(own, branchIn('Laitumkhrah', '793003', 'Shillong')))._id);
    const booker = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Desk A', role: 'staff', permissions: ['assisted.book'], branchIds: [A] } as never);
    const otherBranch = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Desk B', role: 'staff', permissions: ['assisted.book'], branchIds: [B] } as never);
    const noPerm = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Viewer', role: 'staff', permissions: ['bookings.view'], branchIds: [A] } as never);
    const lab2 = await mkLab('Far Labs', '29AABCM1234F1ZX');
    const lab3 = await mkLab('New Labs', '29AABCM1234F1ZY', 'lab', false);
    const P = oid(); const X = oid(); const ADMIN = oid(); const D = oid(); const D2 = oid(); const DU = oid();
    await PharmacyModel.collection.insertOne({ _id: new Types.ObjectId(P), name: 'Sharma Medicals', phone: '9700002101', city: 'Shillong', pincode: '793001',
      isActive: true, isVerified: true } as never);
    const PHONE_X = '9600002101';
    await UserModel.collection.insertOne({ _id: new Types.ObjectId(X), userType: 'user', phone: PHONE_X, name: 'Rina Kumari Das', createdSource: 'self_signup',
      otpVerified: true } as never);
    await WalletModel.create({ userId: X, balance: 0, isActive: true });
    await SpecialistModel.collection.insertMany([
      { _id: new Types.ObjectId(D), name: 'Dr Asha Menon', specialization: 'General Physician', city: 'Shillong', pincode: '793003', consultationFee: 500,
        medicalRegistrationNumber: 'KMC-1', isActive: true, isVerified: true },
      { _id: new Types.ObjectId(D2), name: 'Dr Far Away', specialization: 'General Physician', city: 'Delhi', pincode: '110001', consultationFee: 500,
        isActive: true, isVerified: true },
      { _id: new Types.ObjectId(DU), name: 'Dr Pending', specialization: 'General Physician', city: 'Shillong', pincode: '793003', consultationFee: 500,
        isActive: true, isVerified: false },
    ] as never);
    const sign = (claims: object) => jwt.sign(claims, CONFIG.JWT_SECRET_KEY, { expiresIn: '1h' });
    const member = (m: { _id: unknown }, partnerId: string) => sign({ _id: String(m._id), memberId: String(m._id), partnerId, userType: 'partner' });
    const tokens: Record<string, string> = {
      LB: member(booker, L), LB2: member(otherBranch, L), LV: member(noPerm, L), LO: member(lab.owner, L),
      L2: member(lab2.owner, lab2.id), L3: member(lab3.owner, lab3.id),
      P: sign({ _id: P, pharmacyId: P, userType: 'pharmacy' }), X: sign({ _id: X, userType: 'user', authVersion: 0 }),
      ADMIN: sign({ _id: ADMIN, userType: 'admin' }), D: sign({ _id: D, specialistId: D, userType: 'specialist' }),
    };
    const call = async (who: string | null, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) => {
      const r = await fetch(base + url, { method, headers: { ...(who ? { authorization: `Bearer ${tokens[who] ?? who}` } : {}), 'content-type': 'application/json', ...headers },
        body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      let json: any; try { json = JSON.parse(text); } catch { json = { text }; }
      return { status: r.status, json, text };
    };
    const expect = async (who: string | null, method: string, url: string, status: number, body?: unknown, code?: string) => {
      const r = await call(who, method, url, body);
      assert.equal(r.status, status, `${who} ${method} ${url}: ${r.status} ${r.text.slice(0, 400)}`);
      if (code) assert.equal(r.json.code, code, `${who} ${method} ${url}: ${r.text.slice(0, 400)}`);
      return r;
    };
    const WS = '/api/v1/partner-workspace/assisted';
    let slotSeq = 0;
    const slot = async (doctor = D, at = new Date(Date.now() + 5 * DAY + (++slotSeq) * 20 * MIN)) => {
      const s = istParts(at); const e = istParts(new Date(at.getTime() + 15 * MIN));
      return String((await SlotModel.create({ specialistId: doctor, date: s.date, startTime: s.time, endTime: e.time, duration: 15, maxBookings: 1,
        currentBookings: 0, isActive: true, isAvailable: true, slotType: 'consultation' } as never))._id);
    };
    const consult = (slotId: string, extra: Record<string, unknown> = {}) => ({
      requestKey: newKey(), phone: PHONE_X, patient: { relation: 'self', name: 'Rina D' }, consent: { agreed: true, statementVersion: 'v1', statementLanguage: 'en' },
      preferredLanguage: 'en', slotId, consultationMode: 'video', join: { on: 'partner_device' }, acceptedPriceMinor: 50000, primaryConcern: 'fever',
      paymentMethod: 'wallet', branchId: A, ...extra,
    });
    const book = async (who = 'LB', extra: Record<string, unknown> = {}) => (await expect(who, 'POST', `${WS}/consultations`, 201, consult(await slot(), extra))).json.data;
    const labBalance = async (partnerId = L) => Number((await PartnerWalletModel.findOne({ ownerKind: 'lab', ownerId: partnerId }).lean() as any)?.balanceMinor ?? 0);
    const entries = (key: string) => PartnerWalletEntryModel.find({ operationKey: key }).lean();
    const customerBalance = async () => Number((await WalletModel.findOne({ userId: X }).lean() as any)?.balance ?? 0);
    for (const [pid, amt] of [[L, 1_000_000], [lab2.id, 1_000_000]] as const) {
      const r = await call('ADMIN', 'POST', `/api/v1/admin/labs/${pid}/wallet/topup`, { amountMinor: amt }, { 'Idempotency-Key': `seed-${pid}` });
      assert.equal(r.status, 200, r.text);
    }

    // ───────────────────────── Create ─────────────────────────
    let first: any;
    await check('lab create (wallet): one lab-wallet debit, source lab_assisted, bookedBy = the member at its branch, no pharmacyId, the lab\'s typed-name link, member audit', async () => {
      const before = await labBalance();
      first = await book();
      const id = first.booking._id;
      assert.equal(first.booking.status, 'confirmed');
      assert.equal(first.funding.method, 'wallet');
      assert.equal(await labBalance(), before - 50000);
      const debits = await entries(`assisted:${id}:debit`);
      assert.equal(debits.length, 1);
      assert.equal(debits[0]!.ownerId, L);
      const b = await BookingModel.findById(id).lean() as any;
      assert.equal(b.source, 'lab_assisted');
      assert.equal(b.pharmacyId, undefined);
      assert.deepEqual({ ...b.assisted.bookedBy }, { kind: 'lab', id: L, branchId: A, actorKind: 'member', actorId: String(booker._id), name: 'Metro Labs' });
      assert.equal(b.assisted.funding.payerKind, 'lab');
      assert.equal(b.assisted.requestKey.startsWith(`assisted:lab:${L}:${String(booker._id)}:`), true);
      const link = await AssistedLinkModel.findOne({ bookerKind: 'lab', bookerId: L, userId: X }).lean() as any;
      assert.equal(link.typedName, 'Rina D');
      const audit = await AssistedAuditEventModel.findOne({ action: 'booking.created', bookingId: id }).lean() as any;
      assert.equal(audit.actorKind, 'member');
      assert.equal(audit.orgKind, 'lab');
      assert.ok(notices.some((n) => n.audience === 'doctor' && n.key === `assisted:${id}:booked:doctor`));
      // The lab's view: the typed name, never the account name; its own payment field; no pharmacy link id.
      const v = (await expect('LB', 'GET', `${WS}/bookings/${id}`, 200)).json.data;
      assert.equal(v.patientName, 'Rina D');
      assert.deepEqual(v.holder, { name: 'Rina D', typedName: 'Rina D' });
      assert.equal(v.payment.method, 'wallet');
      assert.equal(JSON.stringify(v).includes('Rina Kumari'), false);
    });

    await check('admission: no assisted.book 403; a branch outside the member\'s scope 403; missing branchId 400; an unverified lab 403; a clinic 403; a pharmacy token 403; switch off 503', async () => {
      await expect('LV', 'POST', `${WS}/consultations`, 403, consult(await slot()), 'INSUFFICIENT_PERMISSIONS');
      await expect('LB', 'POST', `${WS}/consultations`, 403, consult(await slot(), { branchId: B }), 'BRANCH_SCOPE_EXCEEDED');
      const { branchId: _b, ...noBranch } = consult(await slot());
      await expect('LB', 'POST', `${WS}/consultations`, 400, noBranch, 'VALIDATION_ERROR');
      const r3 = await call('L3', 'POST', `${WS}/consultations`, consult(await slot(), { branchId: B }));
      assert.equal(r3.status, 403, r3.text);
      const clinic = await mkLab('A Clinic', '29AABCM1234F1ZQ', 'clinic');
      const rc = await call('ADMIN', 'POST', `/api/v1/partner-workspace/admin/${clinic.id}/workspace/assisted/consultations`, consult(await slot(), { branchId: B }));
      assert.equal(rc.json.code, 'LAB_PARTNER_REQUIRED', rc.text);
      assert.equal((await call('P', 'POST', `${WS}/consultations`, consult(await slot()))).status, 403);
      delete process.env.ASSISTED_BOOKING_ENABLED_LAB;
      try { await expect('LB', 'POST', `${WS}/consultations`, 503, consult(await slot()), 'ASSISTED_BOOKING_DISABLED'); }
      finally { process.env.ASSISTED_BOOKING_ENABLED_LAB = 'true'; }
      // The pharmacy's own create is not gated by the lab switch.
      assert.equal((await BookingModel.countDocuments({ 'assisted.bookedBy.kind': 'lab' })), 1);
    });

    await check('a lab never books another lab\'s tests: the lab-test booking routes are the pharmacy\'s (403 to a lab member)', async () => {
      const r = await call('LO', 'POST', '/api/v1/pharmacy-assisted/lab-bookings', { requestKey: newKey() });
      assert.equal(r.status, 403, r.text);
    });

    await check('keys: same key and body → 200 replayed, one debit; other content → 409; race: 5 identical creates → one booking, one debit', async () => {
      const body = consult(await slot());
      const a = await expect('LB', 'POST', `${WS}/consultations`, 201, body);
      const r = await expect('LB', 'POST', `${WS}/consultations`, 200, body);
      assert.equal(r.json.data.replayed, true);
      assert.equal(r.json.data.booking._id, a.json.data.booking._id);
      await expect('LB', 'POST', `${WS}/consultations`, 409, { ...body, slotId: await slot() }, 'IDEMPOTENCY_KEY_REUSED');
      assert.equal((await entries(`assisted:${a.json.data.booking._id}:debit`)).length, 1);
      const race = consult(await slot());
      const outs = await Promise.all(Array.from({ length: 5 }, () => call('LB', 'POST', `${WS}/consultations`, race)));
      assert.ok(outs.every((o) => o.status === 201 || o.status === 200), outs.map((o) => o.status).join(','));
      const ids = new Set(outs.map((o) => o.json.data.booking._id));
      assert.equal(ids.size, 1);
      assert.equal((await entries(`assisted:${[...ids][0]}:debit`)).length, 1);
    });

    await check('race: two creates that together exceed the lab balance — one 409 INSUFFICIENT_BALANCE, the balance never negative', async () => {
      const lab4 = await mkLab('Small Labs', '29AABCM1234F1ZR');
      const b4 = String((await partnerSvc.createBranch(actorFor(lab4.owner), branchIn('Small', '793001', 'Shillong')))._id);
      const r = await call('ADMIN', 'POST', `/api/v1/admin/labs/${lab4.id}/wallet/topup`, { amountMinor: 80000 }, { 'Idempotency-Key': `seed-${lab4.id}` });
      assert.equal(r.status, 200, r.text);
      tokens.L4 = member(lab4.owner, lab4.id);
      const outs = await Promise.all([consult(await slot(), { branchId: b4 }), consult(await slot(), { branchId: b4 })].map((b) => call('L4', 'POST', `${WS}/consultations`, b)));
      assert.deepEqual(outs.map((o) => o.status).sort(), [201, 409], outs.map((o) => o.text.slice(0, 120)).join(' | '));
      assert.equal(outs.find((o) => o.status === 409)!.json.code, 'INSUFFICIENT_BALANCE');
      assert.equal(await labBalance(lab4.id), 30000);
    });

    await check('an unverified doctor: 409 DOCTOR_NOT_AVAILABLE, nothing debited; doctors listed nearby the member\'s BRANCH (pincode)', async () => {
      const before = await labBalance();
      await expect('LB', 'POST', `${WS}/consultations`, 409, consult(await slot(DU)), 'DOCTOR_NOT_AVAILABLE');
      assert.equal(await labBalance(), before);
      // Branch A is 793001 (Dr Asha is 793003, same city): city. Branch B is 793003: pincode.
      const inA = (await expect('LB', 'GET', `${WS}/doctors?branchId=${A}`, 200)).json.data;
      assert.equal(inA.find((d: any) => d.doctorId === D).nearby, 'city');
      assert.equal(inA.some((d: any) => d.doctorId === DU), false, 'unverified doctors are never listed');
      const inB = (await expect('LB2', 'GET', `${WS}/doctors?branchId=${B}`, 200)).json.data;
      assert.equal(inB[0].doctorId, D);
      assert.equal(inB[0].nearby, 'pincode');
      await expect('LB', 'GET', `${WS}/doctors?branchId=${B}`, 403, undefined, 'BRANCH_SCOPE_EXCEEDED');
      const slots = (await expect('LB', 'GET', `${WS}/doctors/${D}/slots?branchId=${A}&days=14`, 200)).json.data;
      assert.ok(slots.slots.length >= 1);
    });

    // ───────────────────────── Lists and scope ─────────────────────────
    await check('lists: the lab sees its bookings; a member scoped to another branch, another lab and the pharmacy do not (one 404)', async () => {
      const id = first.booking._id;
      const list = (await expect('LB', 'GET', `${WS}/bookings`, 200)).json;
      assert.ok(list.data.some((x: any) => x._id === id));
      assert.ok(list.pagination.total >= 1);
      assert.equal((await expect('LB2', 'GET', `${WS}/bookings`, 200)).json.data.some((x: any) => x._id === id), false);
      await expect('LB2', 'GET', `${WS}/bookings/${id}`, 404);
      await expect('L2', 'GET', `${WS}/bookings/${id}`, 404);
      await expect('L2', 'POST', `${WS}/bookings/${id}/cancel`, 404, {});
      await expect('P', 'GET', `/api/v1/pharmacy-bookings/${id}`, 404);
      // The owner (every branch) sees it.
      await expect('LO', 'GET', `${WS}/bookings/${id}`, 200);
    });

    // ───────────────────────── Cancel, refunds, reschedule ─────────────────────────
    await check('booker cancel before the start refunds the LAB wallet once (lots restored); the customer wallet is untouched', async () => {
      const b = await book();
      const before = await labBalance();
      const c = (await expect('LB', 'POST', `${WS}/bookings/${b.booking._id}/cancel`, 200, { reason: 'patient left' })).json.data;
      assert.equal(c.refundedMinor, 50000);
      assert.equal(await labBalance(), before + 50000);
      assert.equal((await entries(`assisted:${b.booking._id}:refund`)).length, 1);
      assert.equal(await customerBalance(), 0);
      const again = (await expect('LB', 'POST', `${WS}/bookings/${b.booking._id}/cancel`, 200, {})).json.data;
      assert.equal(again.alreadyCancelled, true);
      assert.equal(await labBalance(), before + 50000);
    });

    await check('patient cancel refunds the LAB (never the customer wallet); the booking MEMBER is told', async () => {
      const b = await book();
      const before = await labBalance();
      await expect('X', 'POST', `/api/v1/bookings/${b.booking._id}/cancel`, 200, { reason: 'not needed' });
      assert.equal(await labBalance(), before + 50000);
      assert.equal(await customerBalance(), 0);
      const n = notices.find((x) => x.key === `assisted:${b.booking._id}:cancelled:booker`);
      assert.ok(n, 'booker notice');
      assert.equal(n!.userId, String(booker._id), 'partner notices are per member');
    });

    await check('race: booker cancel against patient cancel — one refund', async () => {
      const b = await book();
      const before = await labBalance();
      await Promise.all([call('LB', 'POST', `${WS}/bookings/${b.booking._id}/cancel`, {}), call('X', 'POST', `/api/v1/bookings/${b.booking._id}/cancel`, {})]);
      assert.equal(await labBalance(), before + 50000);
      assert.equal((await entries(`assisted:${b.booking._id}:refund`)).length, 1);
    });

    await check('a refund to a frozen lab wallet, and for a lab no longer verified, still posts', async () => {
      const b1 = await book();
      const b2 = await book();
      await expect('ADMIN', 'PUT', `/api/v1/admin/labs/${L}/wallet/freeze`, 200, { frozen: true, reason: 'check' });
      const before = await labBalance();
      await expect('X', 'POST', `/api/v1/bookings/${b1.booking._id}/cancel`, 200, {});
      assert.equal(await labBalance(), before + 50000);
      await expect('ADMIN', 'PUT', `/api/v1/admin/labs/${L}/wallet/freeze`, 200, { frozen: false, reason: 'done' });
      await PartnerModel.updateOne({ _id: L }, { $set: { 'verification.state': 'pending' } });
      try {
        await expect('X', 'POST', `/api/v1/bookings/${b2.booking._id}/cancel`, 200, {});
        assert.equal(await labBalance(), before + 100000);
      } finally { await PartnerModel.updateOne({ _id: L }, { $set: { 'verification.state': 'verified' } }); }
    });

    await check('reschedule by the lab: same doctor, new slot, once per key; another lab 404', async () => {
      const b = await book();
      const to = await slot();
      const key = newKey();
      const r = (await expect('LB', 'POST', `${WS}/bookings/${b.booking._id}/reschedule`, 200, { slotId: to, requestKey: key })).json.data;
      assert.equal(r.booking.slotId, to);
      assert.equal((await expect('LB', 'POST', `${WS}/bookings/${b.booking._id}/reschedule`, 200, { slotId: to, requestKey: key })).json.data.replayed, true);
      await expect('L2', 'POST', `${WS}/bookings/${b.booking._id}/reschedule`, 404, { slotId: await slot(), requestKey: newKey() });
    });

    // ───────────────────────── Prescription (decision G) ─────────────────────────
    await check('the lab reads the dispensing copy (90 days, current, member with assisted.book in scope); never the full PDF; others 404', async () => {
      const id = first.booking._id;
      await expect('D', 'POST', `/api/v1/specialists/me/appointments/${id}/prescription`, 200,
        { diagnosis: 'SECRET-DIAGNOSIS', advice: 'Rest', medicines: [{ name: 'Paracetamol 500' }], testsAdvised: ['CBC'] });
      const b = await BookingModel.findById(id).select('+prescription.dispensingCopy.hash').lean() as any;
      const copy = b.prescription.dispensingCopy.url as string;
      assert.match(copy, new RegExp(`^/api/static/bookings/${id}/rx-dispense-`));
      assert.ok(read(copy).includes('Rina D') && !read(copy).includes('SECRET-DIAGNOSIS'), 'the copy names the typed patient, no diagnosis');
      const fileStatus = async (url: string, who: string) => (await fetch(base + url, { headers: { authorization: `Bearer ${tokens[who]}` } })).status;
      assert.equal(await fileStatus(copy, 'LB'), 200);
      assert.equal(await fileStatus(copy, 'LO'), 200);
      for (const who of ['LB2', 'LV', 'L2', 'P']) assert.equal(await fileStatus(copy, who), 404, who);
      assert.equal(await fileStatus(b.prescription.fileUrls[0], 'LB'), 404, 'never the full PDF');
      const v = (await expect('LB', 'GET', `${WS}/bookings/${id}`, 200)).json.data;
      assert.deepEqual(v.prescription.fileUrls, [copy]);
      assert.equal(JSON.stringify(v).includes('SECRET-DIAGNOSIS'), false);
      // Not while the lab is suspended; not after 90 days.
      await PartnerModel.updateOne({ _id: L }, { $set: { isActive: false } });
      // A suspended lab's members are refused at sign-in already (401); either way nothing is served.
      try { assert.ok([401, 404].includes(await fileStatus(copy, 'LB'))); } finally { await PartnerModel.updateOne({ _id: L }, { $set: { isActive: true } }); }
      assert.equal(await fileStatus(copy, 'LB'), 200);
      const old = istParts(new Date(Date.now() - 91 * DAY));
      await BookingModel.updateOne({ _id: id }, { $set: { bookingDate: old.date, bookingTime: '10:00 AM' }, $unset: { slotId: 1 } });
      assert.equal(await fileStatus(copy, 'LB'), 404, 'after 90 days');
    });

    // ───────────────────────── Card ─────────────────────────
    await check('card: the lab is the payer (payerPartnerId); a member of the lab verifies on the workspace route; refund to the lab wallet on the booker\'s choice', async () => {
      const before = await labBalance();
      const r = (await expect('LB', 'POST', `${WS}/consultations`, 201, consult(await slot(), { paymentMethod: 'razorpay' }))).json.data;
      assert.equal(r.booking.status, 'pending');
      assert.equal(await labBalance(), before, 'no debit for a card booking');
      const rec = await PaymentRecordModel.findById(r.payment.paymentTransactionId).lean() as any;
      assert.equal(rec.payerPartnerId, L);
      assert.equal(rec.payerMemberId, String(booker._id));
      assert.equal(rec.payerPharmacyId, undefined);
      const orderId = r.payment.razorpayOrderId;
      const payId = 'pay_r21_' + oid();
      gateway.payments[orderId] = [{ id: payId, order_id: orderId, amount: 50000, currency: 'INR', status: 'captured', fee: 1180 }];
      const verify = { paymentTransactionId: r.payment.paymentTransactionId, razorpayOrderId: orderId, razorpayPaymentId: payId,
        razorpaySignature: crypto.createHmac('sha256', 'secret').update(`${orderId}|${payId}`).digest('hex') };
      await expect('L2', 'POST', `${WS}/payments/verify`, 404, verify, 'PAYMENT_RECORD_NOT_FOUND');
      await expect('P', 'POST', '/api/v1/payments/verify', 404, verify, 'PAYMENT_RECORD_NOT_FOUND');
      const v = (await expect('LO', 'POST', `${WS}/payments/verify`, 200, verify)).json.data;
      assert.equal(v.context, 'assisted_booking');
      assert.equal(v.entity.status, 'confirmed');
      assert.equal((await BookingModel.findById(r.booking._id).lean() as any).lifecycle.paid.by, 'lab_card', 'r21b: the lab card label');
      assert.equal(v.entity.payment.method, 'razorpay');
      const c = (await expect('LB', 'POST', `${WS}/bookings/${r.booking._id}/cancel`, 200, { refundTo: 'wallet' })).json.data;
      assert.equal(c.refund.method, 'wallet');
      assert.equal(await labBalance(), before + 50000);
      const credit = await PartnerWalletEntryModel.findOne({ operationKey: `assisted_card:${r.payment.paymentTransactionId}:refund` }).lean() as any;
      assert.equal(credit.ownerId, L);
      assert.equal(credit.withdrawableDeltaMinor, 0, 'card money back to the wallet is not withdrawable (C3)');
      const rows = (await expect('ADMIN', 'GET', '/api/v1/admin/assisted/card-refunds?state=processed', 200)).json.data;
      const row = rows.find((x: any) => x.bookingId === r.booking._id);
      assert.equal(row.payerKind, 'lab');
      assert.equal(row.payerName, 'Metro Labs');
    });

    await check('r21b: the payment answer shows a booking only in the member\'s branch scope, and its prescription only while the lab is verified', async () => {
      // A card booking at branch A, with a prescription on the row (written directly: the doctor saves only on paid
      // bookings), paid at Razorpay; `who` reconciles it.
      const paidVia = async (who: string, beforeReconcile: () => Promise<void> = async () => undefined) => {
        const r = (await expect('LB', 'POST', `${WS}/consultations`, 201, consult(await slot(), { paymentMethod: 'razorpay' }))).json.data;
        await BookingModel.updateOne({ _id: r.booking._id }, { $set: { 'lifecycle.prescriptionUploaded': { at: new Date().toISOString() },
          prescription: { advice: 'SECRET-ADVICE', medicines: [{ name: 'Secretamol' }], testsAdvised: ['CBC'], prescribedAt: new Date(),
            prescribedBySpecialistId: D, diagnosis: 'SECRET-DIAGNOSIS' } } });
        const orderId = r.payment.razorpayOrderId;
        gateway.payments[orderId] = [{ id: 'pay_r21b_' + oid(), order_id: orderId, amount: 50000, currency: 'INR', status: 'captured', fee: 1180 }];
        await beforeReconcile();
        const out = (await expect(who, 'POST', `${WS}/payments/reconcile`, 200, { paymentTransactionId: r.payment.paymentTransactionId })).json.data;
        assert.equal(out.state, 'paid');
        return { id: r.booking._id, out };
      };
      // A member scoped to another branch settles the payment but sees only its state.
      const other = await paidVia('LB2');
      assert.deepEqual(Object.keys(other.out.entity).sort(), ['_id', 'paymentStatus', 'status']);
      assert.equal(other.out.entity.status, 'confirmed');
      // In scope and verified: the booker view with its prescription (never the diagnosis).
      const mine = await paidVia('LB');
      assert.equal(mine.out.entity.prescription.advice, 'SECRET-ADVICE');
      assert.equal(JSON.stringify(mine.out).includes('SECRET-DIAGNOSIS'), false);
      // The lab's verification revoked before the answer: the booking, never its prescription.
      try {
        const revoked = await paidVia('LO', async () => { await PartnerModel.updateOne({ _id: L }, { $set: { 'verification.state': 'pending' } }); });
        assert.equal(revoked.out.entity._id, revoked.id);
        assert.equal(revoked.out.entity.prescription, undefined);
        assert.equal(JSON.stringify(revoked.out).includes('SECRET'), false);
      } finally { await PartnerModel.updateOne({ _id: L }, { $set: { 'verification.state': 'verified' } }); }
    });

    await check('r21b: a clinic is refused (403 LAB_PARTNER_REQUIRED) on the lookup and the create before any phone is counted or audited; the link index fails closed', async () => {
      const clinic = await mkLab('B Clinic', '29AABCM1234F1ZR', 'clinic');
      const audits = () => AssistedAuditEventModel.countDocuments({ orgId: clinic.id });
      const ws = `/api/v1/partner-workspace/admin/${clinic.id}/workspace/assisted`;
      await expect('ADMIN', 'POST', `${ws}/patients/lookup`, 403, { phone: PHONE_X }, 'LAB_PARTNER_REQUIRED');
      await expect('ADMIN', 'POST', `${ws}/consultations`, 403, consult(await slot()), 'LAB_PARTNER_REQUIRED');
      assert.equal(await audits(), 0, 'nothing counted or audited for a clinic');
      // An unverified lab: refused the same way (403 PARTNER_NOT_VERIFIED) before counting.
      await expect('L3', 'POST', `${WS}/patients/lookup`, 403, { phone: PHONE_X }, 'PARTNER_NOT_VERIFIED');
      // The lab link's unique index missing: a lab create answers 503 INDEXES_OUTDATED and writes nothing.
      const before = await BookingModel.countDocuments({ 'assisted.bookedBy.kind': 'lab' });
      const { resetIndexChecks } = await import('@/modules/common/utils/requiredIndex');
      await AssistedLinkModel.collection.dropIndex('bookerKind_1_bookerId_1_userId_1');
      resetIndexChecks();
      try {
        await expect('LB', 'POST', `${WS}/consultations`, 503, consult(await slot()), 'INDEXES_OUTDATED');
        assert.equal(await BookingModel.countDocuments({ 'assisted.bookedBy.kind': 'lab' }), before);
      } finally { await AssistedLinkModel.syncIndexes(); }
      await book();
    });

    // ───────────────────────── Reconciliation ─────────────────────────
    await check('reconciliation is clean on lab-paid rows and flags a cancelled lab row left unrefunded', async () => {
      const clean = (await expect('ADMIN', 'GET', '/api/v1/admin/assisted/reconciliation?full=true', 200)).json.data;
      const labIds = new Set((await BookingModel.find({ 'assisted.bookedBy.kind': 'lab' }).select({ _id: 1 }).lean()).map((b) => String(b._id)));
      assert.deepEqual(clean.checks.mismatches.filter((m: any) => labIds.has(m.ref)), []);
      const b = await book();
      await BookingModel.updateOne({ _id: b.booking._id }, { $set: { status: 'cancelled' } });
      const bad = (await expect('ADMIN', 'GET', '/api/v1/admin/assisted/reconciliation?full=true', 200)).json.data;
      assert.ok(bad.checks.mismatches.some((m: any) => m.check === 'cancelled_not_refunded' && m.ref === b.booking._id));
      await BookingModel.updateOne({ _id: b.booking._id }, { $set: { status: 'confirmed' } });
    });

    await check('pharmacy unchanged: a pharmacy wallet booking keeps the 1a key, scope and pharmacyId', async () => {
      const { PharmacyWalletTransactionModel } = await import('@/modules/pharmacyWallet/model');
      const { postPharmacyMovementIn } = await import('@/modules/pharmacyWallet/ledger');
      const { runLedgerTransaction } = await import('@/modules/common/utils/bookingWalletFunding');
      await runLedgerTransaction((s) => postPharmacyMovementIn({ pharmacyId: P, kind: 'credit', amountPaise: 100000, operationKey: `seed:${oid()}`,
        referenceType: 'admin_topup', referenceId: oid(), description: 'seed' }, s));
      const { branchId: _b, ...body } = consult(await slot());
      const r = (await expect('P', 'POST', '/api/v1/pharmacy-assisted/consultations', 201, body)).json.data;
      const b = await BookingModel.findById(r.booking._id).lean() as any;
      assert.equal(b.pharmacyId, P);
      assert.equal(b.source, 'pharmacy_assisted');
      assert.equal(b.assisted.requestKey, `assisted:pharmacy:${P}:${P}:${body.requestKey}`);
      assert.equal(await PharmacyWalletTransactionModel.countDocuments({ operationKey: `assisted:${r.booking._id}:debit` }), 1);
      const audit = await AssistedAuditEventModel.findOne({ action: 'booking.created', bookingId: r.booking._id }).lean() as any;
      assert.equal(audit.actorKind, 'pharmacy');
    });
  } finally {
    server.close();
    await mongoose.disconnect();
    removeFixtureDir();
  }
  console.log(`\n${passed} passed, ${failed.length} failed`);
  if (failed.length) { console.log('failed:', failed); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
