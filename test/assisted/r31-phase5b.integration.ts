/**
 * Phase 5b (ASSISTED_BOOKING_DESIGN.md §27.6): the SMS of every booking event, queued after the booking's commit and
 * composed at send time. Real routes over HTTP (configureRoutes) on MongoDB; Razorpay, wkhtmltopdf and the SMS gateway
 * are stand-ins (the gateway: a fake sender through setSmsProvider that records each message).
 *  1. Each event queues exactly one row, a repeat (replay, second save, second release, racing calls) none, and the
 *     drain sends the composed English text with the event's template: pharmacy consultation (wallet 1a, card 1b), lab
 *     consultation (2e), pharmacy lab booking (wallet 2a, card 2b), lab desk (2c), doctor lab booking (3b), partner
 *     Consult now (3e); prescription ready, report ready; every cancel; every move; the admin account move.
 *  2. No SMS: a customer's own booking, the patient acting in the app (cancel, accept a new time), a lab's proposal, an
 *     unpaid card booking cancelled, a desk walk-in "booked"; an open "not mine" report skips later notices (`disputed`).
 *  3. Checked again at send: booked then cancelled → `stale`; moved twice → the first `stale`; prescription withdrawn →
 *     `stale`; a booking moved to another account → the old "booked" is stale, the new holder gets theirs.
 *  4. SMS never affects a booking: the answers and stored bookings are the same with SMS on and off, a hanging gateway
 *     is never called by a request, a slow outbox never delays an answer (the hooks are fire and forget), a missing
 *     outbox index queues nothing and the booking still answers 201.
 *  r31b: a move back to an earlier time (B → C → B) is told; several moves before a tick send only the latest.
 *  5. Switch off: nothing queued. The admin per-booking read. No phone, name or text in any row or log line.
 *
 * Every check runs even when an earlier one fails (the run exits 1 if any failed).
 *
 * Run (throwaway DB only; the script drops its database):
 *   JWT_SECRET_KEY=local-integration-only SESSION_ORIGINS_CUSTOMER=https://app.jansetu.test SESSION_ORIGINS_WORKSPACE=https://staff.jansetu.test \
 *     MONGODB_URL='mongodb://127.0.0.1:27917/r31_phase5b_check?directConnection=true' npx tsx test/assisted/r31-phase5b.integration.ts
 */
import { FIXTURE_DIR, removeFixtureDir } from '../partners/q3-fixture-dir';
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
import logger from '@/services/logger';
import { errorHandler } from '@/modules/middleware';
import UserModel from '@/modules/user/model';
import { UserRepository } from '@/modules/user/repository';
import DependentModel from '@/modules/dependents/model';
import BookingModel from '@/modules/bookings/model';
import { BookingRepository } from '@/modules/bookings/repository';
import { BookingService } from '@/modules/bookings/services';
import SlotModel from '@/modules/slots/model';
import { PaymentRepository } from '@/modules/payment/repository';
import { PaymentService } from '@/modules/payment/services';
import { WalletModel } from '@/modules/wallet/model';
import { WalletRepository, WalletTransactionRepository } from '@/modules/wallet/repository';
import { CouponService } from '@/modules/coupon/services';
import { CouponRepository } from '@/modules/coupon/repository';
import PharmacyModel from '@/modules/pharmacies/model';
import { PharmacyService } from '@/modules/pharmacies/services';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import { postPharmacyMovementIn } from '@/modules/pharmacyWallet/ledger';
import { BannerService } from '@/modules/banners/services';
import { BannerRepository } from '@/modules/banners/repository';
import SpecialistModel from '@/modules/specialists/model';
import { SpecialistService } from '@/modules/specialists/services';
import { SpecialistPortalService } from '@/modules/specialistPortal/services';
import MemberModel from '@/modules/partners/model/member';
import { PartnerSlotModel } from '@/modules/partners/model/slot';
import { PartnerLabBookingModel } from '@/modules/partners/model/labBooking';
import { PartnerRepository } from '@/modules/partners/repository';
import { MemberRepository } from '@/modules/partners/repository/member';
import { BranchRepository } from '@/modules/partners/repository/branch';
import { CatalogueItemRepository } from '@/modules/partners/repository/catalogueItem';
import { PartnerService, type PartnerActor } from '@/modules/partners/services';
import { CatalogueService } from '@/modules/partners/services/catalogue';
import { LabBookingService } from '@/modules/partners/services/labBookings';
import { partnerStore } from '@/modules/partnerWallets/ledger';
import { postMovementIn } from '@/modules/pharmacyWallet/walletCore';
import { InstantConsultService } from '@/modules/doctors/services/instant';
import { runLedgerTransaction } from '@/modules/common/utils/bookingWalletFunding';
import { resetIndexChecks } from '@/modules/common/utils/requiredIndex';
import { SmsNoticeModel } from '@/modules/smsNotices/model';
import { drainSmsOnce } from '@/modules/smsNotices/drain';
import { setSmsProvider } from '@/modules/smsNotices/provider';
import { registerSmsComposers, smsBooked, smsHooksSettled } from '@/modules/smsNotices/events';
import type { IMember, PartnerPermission } from '@/modules/partners/types';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/r31_phase5b_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const oid = () => new Types.ObjectId().toHexString();
const MIN = 60_000;
const DAY = 86_400_000;
const IST = 330 * MIN;
const istParts = (at: Date) => { const s = new Date(at.getTime() + IST).toISOString(); return { date: s.slice(0, 10).replace(/-/g, ''), time: s.slice(11, 16) }; };
const noop = new Proxy({}, { get: () => async () => undefined });

// ── Every log line of the run, to prove no personal data reaches the logs ──
const logged: string[] = [];
for (const level of ['info', 'warn', 'error'] as const) {
  const real = (logger as any)[level].bind(logger);
  (logger as any)[level] = (...a: unknown[]) => { logged.push(JSON.stringify(a)); return real(...a); };
}
for (const level of ['log', 'warn', 'error'] as const) {
  const real = console[level].bind(console);
  console[level] = (...a: unknown[]) => { logged.push(a.map((x) => (x instanceof Error ? `${x.message} ${x.stack}` : String(x))).join(' ')); real(...a); };
}

// The converter stand-in (the prescription PDF): copies its HTML input to the PDF path.
const CONVERTER = path.join(FIXTURE_DIR, 'fake-wkhtmltopdf.sh');
fs.writeFileSync(CONVERTER, '#!/bin/sh\ncp "$1" "$2"\n', { mode: 0o755 });
process.env.WKHTMLTOPDF_BINARY = CONVERTER;

/** Razorpay stand-in: orders and the captures each order holds. */
const gateway = { payments: {} as Record<string, { id: string; order_id: string; amount: number; currency: string; status: string; fee?: number }[]> };
const fakeRazorpay = {
  orders: {
    create: async (o: { amount: number; currency: string }) => ({ id: 'order_r31_' + oid(), amount: o.amount, currency: o.currency, status: 'created' }),
    fetchPayments: async (orderId: string) => ({ items: gateway.payments[orderId] ?? [] }),
  },
  payments: { fetch: async (id: string) => {
    const p = Object.values(gateway.payments).flat().find((x) => x.id === id);
    if (!p) throw Object.assign(new Error('The id provided does not exist'), { statusCode: 400, error: { code: 'BAD_REQUEST_ERROR' } });
    return p;
  } },
};
const refundGateway = {
  listRefunds: async () => [], fetchRefund: async () => undefined,
  refund: async (paymentId: string, body: { amount: number }) => ({ id: 'rfnd_' + oid(), paymentId, amount: body.amount, status: 'processed' }),
};

// ── The SMS gateway stand-in: records each message; `hang` never answers (cut by the drain's timeout) ──
const sms = { mode: 'ok' as 'ok' | 'hang', sent: [] as { to: string; text: string; templateId: string }[], calls: 0 };
const fakeSender = {
  configured: () => true,
  send: async (m: { to: string; text: string; templateId: string }) => {
    sms.calls += 1;
    if (sms.mode === 'hang') return new Promise<never>(() => undefined);
    sms.sent.push({ to: m.to, text: m.text, templateId: m.templateId });
    return { ok: true as const, status: 200 };
  },
};
const T = { BOOKED: 'T-R31-BOOKED', RX_READY: 'T-R31-RX', REPORT_READY: 'T-R31-REPORT', CANCELLED_MOVED: 'T-R31-CANCELLED' };
const SMS_ON: Record<string, string> = { SMS_NOTICES_ENABLED: 'true', SMS_SEND_TIMEOUT_MS: '300' };
for (const [m, id] of Object.entries(T)) { SMS_ON[`SMS_${m}_EN_ENABLED`] = 'true'; SMS_ON[`SMS_${m}_EN_TEMPLATE`] = id; }
const smsOn = () => Object.assign(process.env, SMS_ON);
const smsOff = () => { delete process.env.SMS_NOTICES_ENABLED; };

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
const catalogueSvc = new CatalogueService(new CatalogueItemRepository());
const labSvc = new LabBookingService(payments, new CouponService(new CouponRepository()), new WalletRepository());
labSvc.notify = async () => undefined;
const instantSvc = new InstantConsultService(payments, new CouponService(new CouponRepository()), new WalletRepository());
instantSvc.notify = async () => undefined;
Container.set(BookingService, bookingService);
Container.set(PaymentService, payments);
Container.set(PartnerService, partnerSvc);
Container.set(CatalogueService, catalogueSvc);
Container.set(LabBookingService, labSvc);
Container.set(InstantConsultService, instantSvc);
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
let phoneSeq = 7310000000;
const nextPhone = () => String(phoneSeq++);
let keySeq = 0;
const newKey = () => `r31-key-${String(++keySeq).padStart(4, '0')}-${oid().slice(-6)}`;

async function main() {
  await mongoose.connect(FIXTURE_URL);
  await mongoose.connection.dropDatabase();
  const support = await import('@/modules/assisted/support');
  support.setAssistedNotifier(async () => undefined);
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
  for (const k of ['ASSISTED_BOOKING_ENABLED_PHARMACY', 'ASSISTED_BOOKING_ENABLED_LAB', 'ASSISTED_LAB_BOOKING_ENABLED_PHARMACY', 'LAB_DESK_ENABLED',
    'ASSISTED_BOOKING_ENABLED_DOCTOR', 'ASSISTED_LAB_BOOKING_ENABLED_DOCTOR', 'ASSISTED_INSTANT_ENABLED', 'ASSISTED_ADMIN_TOOLS_ENABLED', 'ASSISTED_CARD_PAYMENT_ENABLED']) {
    process.env[k] = 'true';
  }
  process.env.ASSISTED_LIMIT_LOOKUPS_PER_HOUR = '100000';
  (CONFIG as any).SETTLEMENT_CUTOVER_AT = undefined;
  setSmsProvider(fakeSender);
  registerSmsComposers();
  smsOn();

  try {
    // ── A verified lab (branch A; a booking member, a desk member, a pathologist; one test), a pharmacy, a doctor ──
    const { partner, owner } = await partnerSvc.createPartner({ kind: 'lab', name: 'Metro Labs', legalName: 'Metro Labs Pvt Ltd', contactPhone: nextPhone(),
      invoiceSeriesPrefix: 'ML', firstOwner: { phone: nextPhone(), name: 'Owner' }, taxRegime: 'regular', gstin: '29AABCM1234F1ZH',
      contactEmail: 'metro@lab.test' } as never);
    const L = String(partner._id);
    await partnerSvc.verifyPartner(L, 'admin');
    const own = actorFor(owner);
    const A = String((await partnerSvc.createBranch(own, { name: 'Police Bazar', phone: '9876500000', holidays: [], hours: {},
      services: { homeCollection: true, inLab: true, inClinic: false }, address: { line1: '1 Road', city: 'Shillong', state: 'Meghalaya', stateCode: '17', pincode: '793001' } } as never))._id);
    const booker = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Booker', role: 'staff', permissions: ['assisted.book'], branchIds: [A] } as never);
    const desk = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Desk', role: 'staff', permissions: ['bookings.view', 'bookings.manage'], branchIds: [A] } as never);
    const pathologist = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Pathologist', role: 'staff',
      permissions: ['bookings.view', 'bookings.manage', 'reports.upload', 'reports.release'] } as never);
    await MemberModel.updateOne({ _id: pathologist._id }, { $set: { professional: { kind: 'pathologist', registrationNumber: 'MMC-12345' } } });
    const cbc = String((await catalogueSvc.createItem(own, { kind: 'test', name: 'CBC', priceMinor: 50000, gstRate: 0, visitModes: ['home', 'lab'], reportTatHours: 24 } as never))._id);

    const P = oid(); const ADMIN = oid(); const D = oid(); const X = oid(); const Y = oid(); const S = oid();
    const PHONE_X = '9600003101'; const PHONE_Y = '9600003102'; const PHONE_S = '9600003103';
    await PharmacyModel.collection.insertOne({ _id: new Types.ObjectId(P), name: 'Sharma Medicals', phone: '9700003101', city: 'Shillong', pincode: '793001',
      isActive: true, isVerified: true } as never);
    await UserModel.collection.insertMany([
      { _id: new Types.ObjectId(X), userType: 'user', phone: PHONE_X, name: 'Rina Kumari Das', createdSource: 'self_signup', otpVerified: true },
      { _id: new Types.ObjectId(Y), userType: 'user', phone: PHONE_Y, name: 'Bikash Thapa', createdSource: 'self_signup', otpVerified: true },
      { _id: new Types.ObjectId(S), userType: 'user', phone: PHONE_S, name: 'Selma Self', createdSource: 'self_signup', otpVerified: true },
    ] as never);
    for (const u of [X, Y, S]) await WalletModel.create({ userId: u, balance: 0, isActive: true });
    const depX = String((await DependentModel.create({ userId: X, name: 'Mina Das', relationship: 'Daughter', gender: 'Female', isActive: true } as never))._id);
    await SpecialistModel.collection.insertOne({ _id: new Types.ObjectId(D), name: 'Asha Menon', email: 'asha@doc.test', phone: nextPhone(), specialization: 'General Physician',
      city: 'Shillong', pincode: '793001', consultationFee: 500, medicalRegistrationNumber: 'KMC-1', isActive: true, isVerified: true } as never);
    await runLedgerTransaction((s) => postPharmacyMovementIn({ pharmacyId: P, kind: 'credit', amountPaise: 5_000_000, operationKey: `seed:${oid()}`,
      referenceType: 'admin_topup', referenceId: oid(), description: 'seed' }, s));
    const doctorStore = partnerStore('doctor', D); await doctorStore.ensure();
    await runLedgerTransaction((s) => postMovementIn(doctorStore, { kind: 'credit', amountMinor: 2_000_000, operationKey: `seed:${oid()}`, referenceType: 'seed',
      referenceId: oid(), description: 'seed' }, s));

    const sign = (claims: object) => jwt.sign(claims, CONFIG.JWT_SECRET_KEY, { expiresIn: '1h' });
    const member = (m: { _id: unknown }) => sign({ _id: String(m._id), memberId: String(m._id), partnerId: L, userType: 'partner' });
    const tokens: Record<string, string> = {
      P: sign({ _id: P, pharmacyId: P, userType: 'pharmacy' }), LB: member(booker), DESK: member(desk), PATH: member(pathologist),
      X: sign({ _id: X, userType: 'user', authVersion: 0 }), Y: sign({ _id: Y, userType: 'user', authVersion: 0 }),
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
    assert.equal((await call('ADMIN', 'POST', `/api/v1/admin/labs/${L}/wallet/topup`, { amountMinor: 5_000_000 }, { 'Idempotency-Key': `seed-${L}` })).status, 200);

    const PA = '/api/v1/pharmacy-assisted';
    const WS = '/api/v1/partner-workspace';
    const DESK = `${WS}/lab-desk`;
    const ME = '/api/v1/specialists/me/assisted';

    // ── Slots: the doctor's (5+ days ahead, a distinct 20-minute step each), the lab's (30+ hours ahead) ──
    let slotSeq = 0;
    const docSlot = async () => {
      const at = new Date(Date.now() + 5 * DAY + (++slotSeq) * 20 * MIN);
      const s = istParts(at); const e = istParts(new Date(at.getTime() + 15 * MIN));
      return String((await SlotModel.create({ specialistId: D, date: s.date, startTime: s.time, endTime: e.time, duration: 15, maxBookings: 1,
        currentBookings: 0, isActive: true, isAvailable: true, slotType: 'consultation' } as never))._id);
    };
    let minute = 0;
    const labSlot = async (hours = 30) => {
      const startsAt = new Date(Math.floor(Date.now() / MIN) * MIN + hours * 3_600_000 + (++minute) * MIN);
      const s = new Date(startsAt.getTime() + IST).toISOString(); const e = new Date(startsAt.getTime() + 30 * MIN + IST).toISOString();
      return String((await PartnerSlotModel.create({ partnerId: L, branchId: A, visitMode: 'lab', date: s.slice(0, 10), startTime: s.slice(11, 16), endTime: e.slice(11, 16),
        startsAt, endsAt: new Date(startsAt.getTime() + 30 * MIN), capacity: 5, booked: 0, closed: null, source: 'manual' } as never))._id);
    };

    // ── Request bodies and creates ──
    const patientX = { phone: PHONE_X, patient: { relation: 'self', name: 'Rina D' }, consent: { agreed: true, statementVersion: 'v1', statementLanguage: 'en' } };
    const consultBody = (slotId: string, extra: Record<string, unknown> = {}) => ({ requestKey: newKey(), ...patientX, preferredLanguage: 'en', slotId,
      consultationMode: 'video', join: { on: 'partner_device' }, acceptedPriceMinor: 50000, primaryConcern: 'fever', paymentMethod: 'wallet', ...extra });
    const labBody = (slotId: string, extra: Record<string, unknown> = {}) => ({ requestKey: newKey(), ...patientX, preferredLanguage: 'kha', partnerId: L, branchId: A,
      visitMode: 'lab', slotId, itemIds: [cbc], acceptedPriceMinor: 50000, paymentMethod: 'wallet', ...extra });
    const deskBody = (extra: Record<string, unknown> = {}) => ({ requestKey: newKey(), ...patientX, preferredLanguage: 'en', branchId: A, visitMode: 'lab',
      itemIds: [cbc], acceptedTotalMinor: 50000, ...extra });
    const consultP = async (extra: Record<string, unknown> = {}) => (await expect('P', 'POST', `${PA}/consultations`, 201, consultBody(await docSlot(), extra))).json.data;
    const labP = async (extra: Record<string, unknown> = {}) => (await expect('P', 'POST', `${PA}/lab-bookings`, 201, labBody(await labSlot(), extra))).json.data;
    const deskBook = async (extra: Record<string, unknown> = {}) => (await expect('DESK', 'POST', `${DESK}/bookings`, 201, deskBody(extra))).json.data;
    /** The gateway reports a capture on a card booking's order; returns what verify needs. */
    const capture = (data: any) => {
      const orderId = data.payment.razorpayOrderId as string;
      const payId = 'pay_r31' + oid().slice(-12);
      gateway.payments[orderId] = [{ id: payId, order_id: orderId, amount: data.payment.amountMinor, currency: 'INR', status: 'captured', fee: 1180 }];
      const signature = crypto.createHmac('sha256', 'secret').update(`${orderId}|${payId}`).digest('hex');
      return { paymentTransactionId: data.payment.paymentTransactionId, razorpayOrderId: orderId, razorpayPaymentId: payId, razorpaySignature: signature };
    };

    // ── The outbox and the drain ──
    // The hooks are fire and forget: every read of the outbox first waits for the enqueues still running.
    const rowsOf = async (id: string) => { await smsHooksSettled();
      return await SmsNoticeModel.find({ bookingId: String(id).toLowerCase() }).sort({ createdAt: 1, _id: 1 }).lean() as any[]; };
    const events = async (id: string) => (await rowsOf(id)).map((r) => `${r.event}:${r.version}`);
    /** One drain tick; the messages the gateway received in it. */
    const drain = async (now?: Date) => { await smsHooksSettled(); const before = sms.sent.length; const out = await drainSmsOnce(now); return { out, sent: sms.sent.slice(before) }; };
    /** A move's version: the new start in epoch minutes, then the move's write (ms). */
    const startMinutes = (version: string) => version.split(':')[0];
    const dmy = (d: string) => (/^\d{8}$/.test(d) ? `${d.slice(6, 8)}-${d.slice(4, 6)}-${d.slice(0, 4)}` : d.split('-').reverse().join('-'));
    const BOOKED = (name: string, service: string, date: string, time: string, place: string, ref: string) =>
      `Jansetu: ${name}'s ${service} is booked for ${date} at ${time} via ${place}. Ref ${ref}. Sign in to the Jansetu app with this number for details.`;
    const CANCELLED_MOVED = (name: string, service: string, what: string) =>
      `Jansetu: ${name}'s ${service} has been ${what}. Sign in to the Jansetu app with this number for details.`;
    const deskRef = (id: string) => String(id).slice(-8).toUpperCase();
    const sentTexts: string[] = [];
    const record = (s: { text: string }[]) => { for (const x of s) sentTexts.push(x.text); return s; };
    await drain(); // nothing is due yet

    // ───────────────────────── 1. Booked, at every create path ─────────────────────────
    await check('1a pharmacy wallet consultation: one "booked" row; a replay and three racing identical creates add none; the drain sends the BOOKED text', async () => {
      const body = consultBody(await docSlot());
      const r = (await expect('P', 'POST', `${PA}/consultations`, 201, body)).json.data;
      const id = r.booking._id;
      assert.deepEqual(await events(id), ['booked:1']);
      assert.equal((await expect('P', 'POST', `${PA}/consultations`, 200, body)).json.data.replayed, true);
      const race = consultBody(await docSlot());
      const outs = await Promise.all([1, 2, 3].map(() => call('P', 'POST', `${PA}/consultations`, race)));
      const raced = new Set(outs.map((o) => o.json.data.booking._id));
      assert.equal(raced.size, 1);
      assert.deepEqual(await events(id), ['booked:1']);
      assert.deepEqual(await events([...raced][0] as string), ['booked:1']);
      const { sent } = await drain();
      record(sent);
      assert.equal(sent.length, 2);
      const mine = sent.find((x) => x.text.includes(r.booking.assisted.shortRef))!;
      assert.equal(mine.to, PHONE_X);
      assert.equal(mine.templateId, T.BOOKED);
      assert.equal(mine.text, BOOKED('Rina', 'video consultation', dmy(r.booking.bookingDate), r.booking.bookingTime, 'Sharma Medicals', r.booking.assisted.shortRef));
      const row = (await rowsOf(id))[0];
      assert.deepEqual([row.state, row.message, row.lang, row.attempts], ['sent', 'BOOKED', 'en', 1]);
      // Sent once: another tick sends nothing.
      assert.equal((await drain()).sent.length, 0);
    });

    await check('1b card consultation: nothing while it waits for payment; verify and reconcile racing → one "booked" row; a repeat verify adds none', async () => {
      const r = await consultP({ paymentMethod: 'razorpay' });
      const id = r.booking._id;
      assert.deepEqual(await events(id), []);
      const v = capture(r);
      await Promise.all([call('P', 'POST', '/api/v1/payments/verify', v), call('P', 'POST', '/api/v1/payments/reconcile', { paymentTransactionId: v.paymentTransactionId })]);
      await call('P', 'POST', '/api/v1/payments/verify', v);
      assert.equal((await BookingModel.findById(id).lean() as any).status, 'confirmed');
      assert.deepEqual(await events(id), ['booked:1']);
      const { sent } = await drain();
      record(sent);
      assert.equal(sent.length, 1);
      assert.equal(sent[0]!.text, BOOKED('Rina', 'video consultation', dmy(r.booking.bookingDate), r.booking.bookingTime, 'Sharma Medicals', r.booking.assisted.shortRef));
    });

    await check('2e lab-booked consultation: one "booked" row; the place is the lab', async () => {
      const r = (await expect('LB', 'POST', `${WS}/assisted/consultations`, 201, consultBody(await docSlot(), { branchId: A, consultationMode: 'call' }))).json.data;
      assert.deepEqual(await events(r.booking._id), ['booked:1']);
      const { sent } = await drain();
      record(sent);
      assert.equal(sent[0]!.text, BOOKED('Rina', 'phone consultation', dmy(r.booking.bookingDate), r.booking.bookingTime, 'Metro Labs', r.booking.assisted.shortRef));
    });

    await check('2a/2b pharmacy lab booking: wallet → one "booked" (a family member\'s first name; "kha" falls back to English); card → none until paid, then one', async () => {
      const w = await labP({ patient: { dependentId: depX } });
      assert.deepEqual(await events(w.booking._id), ['booked:1']);
      const c = await labP({ paymentMethod: 'razorpay' });
      assert.deepEqual(await events(c.booking._id), []);
      const v = capture(c);
      await expect('P', 'POST', '/api/v1/payments/verify', 200, v);
      await call('P', 'POST', '/api/v1/payments/verify', v);
      assert.deepEqual(await events(c.booking._id), ['booked:1']);
      const { sent } = await drain();
      record(sent);
      assert.equal(sent.length, 2);
      const ws = w.booking.slot;
      assert.ok(sent.some((x) => x.text === BOOKED('Mina', 'lab test', dmy(ws.date), ws.startTime, 'Sharma Medicals', w.booking.assisted.shortRef)), JSON.stringify(sent));
      const cs = c.booking.slot;
      assert.ok(sent.some((x) => x.text === BOOKED('Rina', 'lab test', dmy(cs.date), cs.startTime, 'Sharma Medicals', c.booking.assisted.shortRef)), JSON.stringify(sent));
      const row = (await rowsOf(w.booking._id))[0];
      assert.equal(row.lang, 'en');
    });

    await check('2c lab desk: a scheduled row → one "booked" (place = the lab, Ref = the last 8 of its id); a walk-in → none', async () => {
      const s = await deskBook({ slotId: await labSlot() });
      const id = s.booking._id;
      assert.deepEqual(await events(id), ['booked:1']);
      const walkIn = await deskBook();
      assert.deepEqual(await events(walkIn.booking._id), []);
      const { sent } = await drain();
      record(sent);
      const b = await PartnerLabBookingModel.findById(id).lean() as any;
      assert.equal(sent.length, 1);
      assert.equal(sent[0]!.text, BOOKED('Rina', 'lab test', dmy(b.slot.date), b.slot.startTime, 'Metro Labs', deskRef(id)));
    });

    await check('3b doctor lab booking: one "booked"; the place is the lab, never the doctor', async () => {
      const r = (await expect('D', 'POST', `${ME}/lab-bookings`, 201, labBody(await labSlot()))).json.data;
      assert.deepEqual(await events(r.booking._id), ['booked:1']);
      const { sent } = await drain();
      record(sent);
      assert.equal(sent[0]!.text, BOOKED('Rina', 'lab test', dmy(r.booking.slot.date), r.booking.slot.startTime, 'Metro Labs', r.booking.assisted.shortRef));
      assert.ok(!/Asha|Menon/.test(sent[0]!.text));
    });

    await check('3e partner Consult now: no row before a doctor accepts; accept → one "booked" (acceptance time); doctor cancel → one "cancelled"', async () => {
      await instantSvc.setPresence(D, { available: true, modes: ['video', 'call'] });
      const t0 = new Date();
      const created = (await expect('P', 'POST', `${PA}/instant/requests`, 201, { requestKey: newKey(), ...patientX, preferredLanguage: 'en',
        specialization: 'General Physician', mode: 'video', target: { kind: 'any' }, join: { on: 'partner_device' }, acceptedQuoteMinor: 50000,
        acceptedPayableMinor: 50000, paymentMethod: 'wallet' })).json.data;
      await smsHooksSettled();
      assert.equal(await SmsNoticeModel.countDocuments({ createdAt: { $gte: t0 } }), 0, 'nothing queued for a request');
      const acc = await instantSvc.accept(D, created.request._id);
      const id = String(acc.booking._id);
      assert.deepEqual(await events(id), ['booked:1']);
      await instantSvc.accept(D, created.request._id); // the doctor's replay
      assert.deepEqual(await events(id), ['booked:1']);
      const b = await BookingModel.findById(id).lean() as any;
      const { sent } = await drain();
      record(sent);
      assert.equal(sent[0]!.text, BOOKED('Rina', 'video consultation', dmy(b.bookingDate), b.bookingTime, 'Sharma Medicals', b.assisted.shortRef));
      await bookingService.cancelByDoctor(id, { _id: D, userType: 'specialist' }, 'Doctor unwell');
      assert.deepEqual(await events(id), ['booked:1', 'cancelled:1']);
      const c = await drain();
      record(c.sent);
      assert.deepEqual(c.sent.map((x) => [x.templateId, x.text]), [[T.CANCELLED_MOVED, CANCELLED_MOVED('Rina', 'video consultation', 'cancelled')]]);
      await instantSvc.setPresence(D, { available: false });
    });

    // ───────────────────────── Prescription ready, report ready ─────────────────────────
    await check('rx_ready: two racing first saves → one row; a later save → none; the text names the booker; withdrawn before the tick → stale', async () => {
      const r = await consultP();
      const id = r.booking._id;
      await drain();
      const rx = { diagnosis: 'SECRET-DIAGNOSIS', advice: 'Rest', medicines: [{ name: 'Paracetamol 500' }], testsAdvised: ['CBC'] };
      const outs = await Promise.all([1, 2].map(() => call('D', 'POST', `/api/v1/specialists/me/appointments/${id}/prescription`, rx)));
      assert.ok(outs.every((o) => o.status === 200), outs.map((o) => o.text.slice(0, 200)).join(' | '));
      await expect('D', 'POST', `/api/v1/specialists/me/appointments/${id}/prescription`, 200, rx);
      assert.deepEqual(await events(id), ['booked:1', 'rx_ready:1']);
      const { sent } = await drain();
      record(sent);
      assert.deepEqual(sent.map((x) => [x.templateId, x.text]), [[T.RX_READY,
        `Jansetu: the prescription for Rina from the consultation on ${dmy(r.booking.bookingDate)} is ready. Sign in to the Jansetu app with this number, or ask Sharma Medicals.`]]);
      assert.ok(!sent[0]!.text.includes('SECRET'));
      // Withdrawn (an admin clear) before the tick: skipped.
      const r2 = await consultP();
      await drain();
      await expect('D', 'POST', `/api/v1/specialists/me/appointments/${r2.booking._id}/prescription`, 200, rx);
      await BookingModel.updateOne({ _id: r2.booking._id }, { $unset: { 'lifecycle.prescriptionUploaded': '' } });
      assert.equal((await drain()).sent.length, 0);
      assert.equal((await rowsOf(r2.booking._id)).find((x) => x.event === 'rx_ready').reason, 'stale');
    });

    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
    const upload = async (id: string) => {
      const fd = new FormData();
      fd.append('files', new Blob([pdf], { type: 'application/pdf' }), 'report.pdf');
      const r = await fetch(`${base}${WS}/lab-bookings/${id}/reports`, { method: 'POST', headers: { authorization: `Bearer ${tokens.PATH}` }, body: fd });
      const json = await r.json() as any;
      assert.equal(r.status, 201, JSON.stringify(json).slice(0, 300));
      return (json.data.report.draftFiles as string[]).map((f) => String(f));
    };
    await check('report_ready: two racing first releases → one row; a later release → none; partner-made and desk rows (a desk walk-in too); the text names the lab', async () => {
      const r = await labP();
      const w = await deskBook();
      await drain();
      for (const id of [r.booking._id, w.booking._id]) {
        await expect('PATH', 'POST', `${WS}/lab-bookings/${id}/visit`, 200, {});
        await expect('PATH', 'POST', `${WS}/lab-bookings/${id}/process`, 200, {});
      }
      const [d1] = await upload(r.booking._id);
      const drafts = await upload(r.booking._id);
      const d2 = drafts.find((f) => f !== d1)!;
      const rel = await Promise.all([d1, d2].map((file) => call('PATH', 'POST', `${WS}/lab-bookings/${r.booking._id}/reports/release`, { file })));
      assert.ok(rel.some((x) => x.status === 200), rel.map((x) => x.text.slice(0, 200)).join(' | '));
      for (const x of rel) if (x.status !== 200) await expect('PATH', 'POST', `${WS}/lab-bookings/${r.booking._id}/reports/release`, 200, { file: x === rel[0] ? d1 : d2 });
      const [dw] = await upload(w.booking._id);
      await expect('PATH', 'POST', `${WS}/lab-bookings/${w.booking._id}/reports/release`, 200, { file: dw });
      assert.deepEqual(await events(r.booking._id), ['booked:1', 'report_ready:1']);
      assert.deepEqual(await events(w.booking._id), ['report_ready:1']);
      const { sent } = await drain();
      record(sent);
      assert.equal(sent.length, 2);
      assert.ok(sent.every((x) => x.templateId === T.REPORT_READY));
      assert.ok(sent.some((x) => x.text === `Jansetu: the lab report for Rina from ${dmy(r.booking.slot.date)} (Metro Labs) is ready. Sign in to the Jansetu app with this number to see it.`),
        JSON.stringify(sent));
      assert.ok(!sent.some((x) => x.text.includes('CBC')));
    });

    // ───────────────────────── Cancelled ─────────────────────────
    await check('cancelled: booker, doctor and admin cancels of a consultation; lab reject (partner-made and desk), booker and desk cancels of lab rows — one row each, repeats none', async () => {
      const byBooker = await consultP(); const byDoctor = await consultP(); const byAdmin = await consultP();
      const rejected = await labP(); const deskRejected = await deskBook({ slotId: await labSlot() });
      const labByBooker = await labP(); const byDesk = await deskBook({ slotId: await labSlot() });
      await drain();
      await expect('P', 'POST', `${PA}/bookings/${byBooker.booking._id}/cancel`, 200, {});
      await expect('P', 'POST', `${PA}/bookings/${byBooker.booking._id}/cancel`, 200, {});
      await bookingService.cancelByDoctor(byDoctor.booking._id, { _id: D, userType: 'specialist' }, 'Doctor unwell');
      await bookingService.cancelByDoctor(byAdmin.booking._id, { _id: ADMIN, userType: 'admin' }, 'Closed', { asAdmin: true });
      await expect('PATH', 'POST', `${WS}/lab-bookings/${rejected.booking._id}/reject`, 200, { reason: 'Machine down' });
      await expect('PATH', 'POST', `${WS}/lab-bookings/${deskRejected.booking._id}/reject`, 200, { reason: 'Machine down' });
      await expect('P', 'POST', `${PA}/lab-bookings/${labByBooker.booking._id}/cancel`, 200, {});
      await expect('P', 'POST', `${PA}/lab-bookings/${labByBooker.booking._id}/cancel`, 200, {});
      await expect('DESK', 'POST', `${DESK}/bookings/${byDesk.booking._id}/cancel`, 200, {});
      await expect('DESK', 'POST', `${DESK}/bookings/${byDesk.booking._id}/cancel`, 200, {});
      for (const x of [byBooker, byDoctor, byAdmin, rejected, deskRejected, labByBooker, byDesk]) {
        assert.deepEqual(await events(x.booking._id), ['booked:1', 'cancelled:1'], x.booking._id);
      }
      const { sent } = await drain();
      record(sent);
      assert.equal(sent.length, 7);
      assert.equal(sent.filter((x) => x.templateId === T.CANCELLED_MOVED && x.text === CANCELLED_MOVED('Rina', 'video consultation', 'cancelled')).length, 3);
      assert.equal(sent.filter((x) => x.text === CANCELLED_MOVED('Rina', 'lab test', 'cancelled')).length, 4);
    });

    // ───────────────────────── Moved ─────────────────────────
    await check('moved: the booker moves a consultation (version = the new start in minutes); the booker accepts a lab\'s new time; the lab rebooks a no-show', async () => {
      const c = await consultP();
      const l = await labP();
      const n = await labP();
      await drain();
      const to = await docSlot();
      const moved = (await expect('P', 'POST', `${PA}/bookings/${c.booking._id}/reschedule`, 200, { slotId: to, requestKey: newKey() })).json.data.booking;
      const slot = await SlotModel.findById(to).lean() as any;
      const start = Date.parse(`${slot.date.slice(0, 4)}-${slot.date.slice(4, 6)}-${slot.date.slice(6, 8)}T${slot.startTime}:00+05:30`);
      const cm = (await rowsOf(c.booking._id)).map((r) => [r.event, r.event === 'moved' ? startMinutes(r.version) : r.version]);
      assert.deepEqual(cm, [['booked', '1'], ['moved', String(Math.floor(start / MIN))]]);
      assert.match((await rowsOf(c.booking._id))[1].version, /^\d+:\d{13}$/);
      // A lab proposal sends nothing; the booker's accept does.
      const ls = await labSlot();
      await expect('PATH', 'POST', `${WS}/lab-bookings/${l.booking._id}/reschedule`, 200, { slotId: ls, reason: 'Machine down' });
      assert.deepEqual(await events(l.booking._id), ['booked:1']);
      const version = (await PartnerLabBookingModel.findById(l.booking._id).lean() as any).reschedule.version;
      const acc = (await expect('P', 'POST', `${PA}/lab-bookings/${l.booking._id}/accept-reschedule`, 200, { version })).json.data;
      const lStart = new Date(acc.slot.startsAt).getTime();
      assert.deepEqual((await rowsOf(l.booking._id)).map((r) => [r.event, r.event === 'moved' ? startMinutes(r.version) : r.version]),
        [['booked', '1'], ['moved', String(Math.floor(lStart / MIN))]]);
      // The lab rebooks a no-show (once; its replay adds nothing).
      await PartnerLabBookingModel.updateOne({ _id: n.booking._id }, { $set: { status: 'no_show', 'lifecycle.noShowAt': new Date() }, $inc: { statusVersion: 1 } });
      const ns = await labSlot(); const key = newKey();
      await expect('PATH', 'POST', `${WS}/lab-bookings/${n.booking._id}/reschedule-no-show`, 200, { slotId: ns, requestKey: key });
      await expect('PATH', 'POST', `${WS}/lab-bookings/${n.booking._id}/reschedule-no-show`, 200, { slotId: ns, requestKey: key });
      assert.equal((await rowsOf(n.booking._id)).filter((r) => r.event === 'moved').length, 1);
      const { sent } = await drain();
      record(sent);
      assert.equal(sent.length, 3);
      assert.ok(sent.some((x) => x.text === CANCELLED_MOVED('Rina', 'video consultation', `moved to ${dmy(moved.bookingDate)} ${moved.bookingTime}`)), JSON.stringify(sent));
      assert.ok(sent.some((x) => x.text === CANCELLED_MOVED('Rina', 'lab test', `moved to ${dmy(acc.slot.date)} ${acc.slot.startTime}`)), JSON.stringify(sent));
    });

    await check('stale at send: booked then cancelled before the tick → "booked" skipped, "cancelled" sent; moved twice → the first skipped, the second sent', async () => {
      const c = await consultP();
      await expect('P', 'POST', `${PA}/bookings/${c.booking._id}/cancel`, 200, {});
      const m = await consultP();
      await expect('P', 'POST', `${PA}/bookings/${m.booking._id}/reschedule`, 200, { slotId: await docSlot(), requestKey: newKey() });
      const second = (await expect('P', 'POST', `${PA}/bookings/${m.booking._id}/reschedule`, 200, { slotId: await docSlot(), requestKey: newKey() })).json.data.booking;
      const { sent } = await drain();
      record(sent);
      const rc = await rowsOf(c.booking._id);
      assert.deepEqual(rc.map((r) => [r.event, r.state, r.reason ?? null]), [['booked', 'skipped', 'stale'], ['cancelled', 'sent', null]]);
      const rm = await rowsOf(m.booking._id);
      assert.deepEqual(rm.map((r) => [r.event, r.state, r.reason ?? null]), [['booked', 'sent', null], ['moved', 'skipped', 'stale'], ['moved', 'sent', null]]);
      assert.ok(sent.some((x) => x.text === CANCELLED_MOVED('Rina', 'video consultation', `moved to ${dmy(second.bookingDate)} ${second.bookingTime}`)));
    });

    await check('r31b: a move back to an earlier time is told (B → C, then back to B); C → D → C before a tick sends one SMS, the latest', async () => {
      const B = await docSlot();
      const c = (await expect('P', 'POST', `${PA}/consultations`, 201, consultBody(B))).json.data;
      const id = c.booking._id;
      await drain();
      const C = await docSlot();
      const toC = (await expect('P', 'POST', `${PA}/bookings/${id}/reschedule`, 200, { slotId: C, requestKey: newKey() })).json.data.booking;
      const first = await drain();
      assert.deepEqual(first.sent.map((x) => x.text), [CANCELLED_MOVED('Rina', 'video consultation', `moved to ${dmy(toC.bookingDate)} ${toC.bookingTime}`)]);
      const backToB = (await expect('P', 'POST', `${PA}/bookings/${id}/reschedule`, 200, { slotId: B, requestKey: newKey() })).json.data.booking;
      assert.equal(backToB.slotId, B);
      const moves = (await rowsOf(id)).filter((r) => r.event === 'moved');
      assert.equal(moves.length, 2, 'the move back to B has its own row');
      const second = await drain();
      record(second.sent);
      assert.deepEqual(second.sent.map((x) => x.text), [CANCELLED_MOVED('Rina', 'video consultation', `moved to ${dmy(backToB.bookingDate)} ${backToB.bookingTime}`)]);
      // Three moves before one tick (C → D → C): only the latest is sent; the earlier two are stale.
      const D = await docSlot();
      await expect('P', 'POST', `${PA}/bookings/${id}/reschedule`, 200, { slotId: C, requestKey: newKey() });
      await expect('P', 'POST', `${PA}/bookings/${id}/reschedule`, 200, { slotId: D, requestKey: newKey() });
      const lastC = (await expect('P', 'POST', `${PA}/bookings/${id}/reschedule`, 200, { slotId: C, requestKey: newKey() })).json.data.booking;
      const third = await drain();
      record(third.sent);
      assert.deepEqual(third.sent.map((x) => x.text), [CANCELLED_MOVED('Rina', 'video consultation', `moved to ${dmy(lastC.bookingDate)} ${lastC.bookingTime}`)]);
      const last3 = (await rowsOf(id)).filter((r) => r.event === 'moved').slice(-3);
      assert.deepEqual(last3.map((r) => [r.state, r.reason ?? null]), [['skipped', 'stale'], ['skipped', 'stale'], ['sent', null]]);
      assert.equal(new Set((await rowsOf(id)).map((r) => r.version)).size, (await rowsOf(id)).length);
    });

    // ───────────────────────── The admin account move ─────────────────────────
    await check('account move: the old number gets "moved to another number" (its own name, nothing of the new holder); the new number gets "booked" move:1; the old "booked" is stale', async () => {
      const c = await consultP();
      const l = await labP();
      // The consultation's "booked" is still queued when it moves.
      for (const x of [c, l]) {
        await expect('ADMIN', 'POST', `/api/v1/admin/assisted-bookings/${x.booking._id}/move`, 200, { toPhone: PHONE_Y, reason: 'Wrong number typed', requestKey: newKey() });
      }
      assert.deepEqual((await rowsOf(c.booking._id)).map((r) => [r.event, r.version, r.recipientUserId ?? null]), [['booked', '1', null], ['moved_off', 'move:1', X], ['booked', 'move:1', null]]);
      const { sent } = await drain();
      record(sent);
      const rc = await rowsOf(c.booking._id);
      assert.deepEqual(rc.map((r) => [r.event, r.state, r.reason ?? null]), [['booked', 'skipped', 'stale'], ['moved_off', 'sent', null], ['booked', 'sent', null]]);
      const toX = sent.filter((x) => x.to === PHONE_X);
      const toY = sent.filter((x) => x.to === PHONE_Y);
      assert.deepEqual(toX.map((x) => x.text), [CANCELLED_MOVED('Rina', 'video consultation', 'moved to another number'), CANCELLED_MOVED('Rina', 'lab test', 'moved to another number')]);
      // The new holder: the consultation names its account holder; the lab booking keeps the patient name the partner typed.
      assert.deepEqual(toY.map((x) => [x.templateId, x.text.split("'s ")[0]]), [[T.BOOKED, 'Jansetu: Bikash'], [T.BOOKED, 'Jansetu: Rina']]);
      assert.ok(!toX.some((x) => x.text.includes('Bikash')));
    });

    // ───────────────────────── 2. No SMS ─────────────────────────
    await check('no SMS: the patient cancels in the app (consultation and lab); the patient accepts a lab\'s new time; a lab\'s proposal; an unpaid card booking cancelled; a customer\'s own booking', async () => {
      const c = await consultP(); const l = await labP(); const p = await labP();
      await drain();
      await expect('X', 'POST', `/api/v1/bookings/${c.booking._id}/cancel`, 200, {});
      await expect('X', 'POST', `/api/v1/lab-bookings/${l.booking._id}/cancel`, 200, {});
      await expect('PATH', 'POST', `${WS}/lab-bookings/${p.booking._id}/reschedule`, 200, { slotId: await labSlot(), reason: 'Machine down' });
      const version = (await PartnerLabBookingModel.findById(p.booking._id).lean() as any).reschedule.version;
      await expect('X', 'POST', `/api/v1/lab-bookings/${p.booking._id}/accept-reschedule`, 200, { version });
      for (const x of [c, l, p]) assert.deepEqual(await events(x.booking._id), ['booked:1'], x.booking._id);
      // Unpaid card bookings, cancelled by the booker: never announced.
      const cc = await consultP({ paymentMethod: 'razorpay' }); const lc = await labP({ paymentMethod: 'razorpay' });
      await expect('P', 'POST', `${PA}/bookings/${cc.booking._id}/cancel`, 200, {});
      await expect('P', 'POST', `${PA}/lab-bookings/${lc.booking._id}/cancel`, 200, {});
      assert.deepEqual(await events(cc.booking._id), []);
      assert.deepEqual(await events(lc.booking._id), []);
      // A customer's own booking (no `assisted` block): out of scope even when a hook is called with it.
      const own = (await BookingModel.collection.insertOne({ bookingType: 'consultation', specialistId: D, userId: S, bookingDate: '20991231', bookingTime: '10:00',
        consultationMode: 'video', status: 'confirmed', paymentStatus: 'paid', createdAt: new Date(), updatedAt: new Date() } as never)).insertedId;
      await smsBooked('booking', await BookingModel.findById(own).lean());
      assert.deepEqual(await events(String(own)), []);
      assert.equal((await drain()).sent.length, 0);
    });

    await check('not mine: an open report skips later notices ("disputed"), the move then sends "moved to another number"', async () => {
      const c = await consultP();
      await drain();
      await expect('X', 'POST', `/api/v1/bookings/${c.booking._id}/not-mine`, 200, {});
      await expect('P', 'POST', `${PA}/bookings/${c.booking._id}/reschedule`, 200, { slotId: await docSlot(), requestKey: newKey() });
      const l = await labP();
      await expect('X', 'POST', `/api/v1/lab-bookings/${l.booking._id}/not-mine`, 200, {});
      const { sent } = await drain();
      record(sent);
      assert.deepEqual((await rowsOf(c.booking._id)).map((r) => [r.event, r.state, r.reason ?? null]), [['booked', 'sent', null], ['moved', 'skipped', 'disputed']]);
      assert.deepEqual((await rowsOf(l.booking._id)).map((r) => [r.event, r.state, r.reason ?? null]), [['booked', 'skipped', 'disputed']]);
      await expect('ADMIN', 'POST', `/api/v1/admin/assisted-bookings/${c.booking._id}/move`, 200, { toPhone: PHONE_Y, reason: 'Not theirs', requestKey: newKey() });
      const after = await drain();
      record(after.sent);
      assert.ok(after.sent.some((x) => x.to === PHONE_X && x.text === CANCELLED_MOVED('Rina', 'video consultation', 'moved to another number')));
    });

    // ───────────────────────── 4. SMS never affects a booking ─────────────────────────
    const shape = (v: any): any => {
      if (Array.isArray(v)) return v.map(shape);
      if (v instanceof Date) return '<time>';
      if (v instanceof Types.ObjectId) return '<id>';
      if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape(v[k])]));
      if (typeof v === 'string') {
        return v.replace(/[0-9a-fA-F]{64}/g, '<hash>').replace(/[0-9a-fA-F]{24}/g, '<id>').replace(/r31-key-\d+-[0-9a-f]+/g, '<key>')
          .replace(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/, '<time>').replace(/^\d{8}$|^\d{4}-\d{2}-\d{2}$/, '<date>').replace(/^\d{2}:\d{2}$/, '<hm>')
          .replace(/^[A-Z2-7]{8}$/, '<ref>').replace(/^order_r31_.*/, '<order>');
      }
      return v;
    };
    const stripVolatile = (doc: any) => { const { __v: _v, ...rest } = doc ?? {}; return rest; };
    await check('SMS on and off: the same answers and stored bookings (consultation create, move and cancel; lab create and cancel; desk create)', async () => {
      const run = async () => {
        const c = await expect('P', 'POST', `${PA}/consultations`, 201, consultBody(await docSlot()));
        const id = c.json.data.booking._id;
        const mv = await expect('P', 'POST', `${PA}/bookings/${id}/reschedule`, 200, { slotId: await docSlot(), requestKey: newKey() });
        const cx = await expect('P', 'POST', `${PA}/bookings/${id}/cancel`, 200, {});
        const l = await expect('P', 'POST', `${PA}/lab-bookings`, 201, labBody(await labSlot()));
        const lx = await expect('P', 'POST', `${PA}/lab-bookings/${l.json.data.booking._id}/cancel`, 200, {});
        const d = await expect('DESK', 'POST', `${DESK}/bookings`, 201, deskBody({ slotId: await labSlot() }));
        const docs = [await BookingModel.findById(id).lean(), await PartnerLabBookingModel.findById(l.json.data.booking._id).lean(),
          await PartnerLabBookingModel.findById(d.json.data.booking._id).lean()].map(stripVolatile);
        return { answers: shape([c.json, mv.json, cx.json, l.json, lx.json, d.json]), docs: shape(docs), ids: [id, l.json.data.booking._id, d.json.data.booking._id] };
      };
      const on = await run();
      smsOff();
      const off = await run();
      smsOn();
      assert.deepEqual(off.answers, on.answers);
      assert.deepEqual(off.docs, on.docs);
      for (const id of off.ids) assert.deepEqual(await events(id), [], 'switch off: nothing queued');
      assert.ok((await events(on.ids[0]!)).length === 3);
      record((await drain()).sent);
    });

    await check('a hanging gateway is never called by a request; a slow outbox never delays an answer; a missing outbox index queues nothing and the booking still answers 201', async () => {
      sms.mode = 'hang';
      const calls = sms.calls;
      const t0 = Date.now();
      const r = await consultP();
      assert.equal(sms.calls, calls, 'the request never calls the gateway');
      assert.ok(Date.now() - t0 < 5000);
      assert.deepEqual(await events(r.booking._id), ['booked:1']);
      const out = (await drain()).out; // cut at SMS_SEND_TIMEOUT_MS, retried later
      assert.equal(out.retry, 1);
      sms.mode = 'ok';
      await SmsNoticeModel.updateMany({ state: 'queued' }, { $set: { dueAt: new Date() } });
      record((await drain()).sent);
      // A slow outbox (each insert 3 s) never delays an answer: the hooks are fire and forget.
      const realCreate = (SmsNoticeModel as any).create.bind(SmsNoticeModel);
      (SmsNoticeModel as any).create = async (...a: unknown[]) => { await new Promise((res) => setTimeout(res, 3000)); return realCreate(...a); };
      try {
        const t1 = Date.now();
        const slow = await consultP();
        const answered = Date.now() - t1;
        assert.ok(answered < 3000, `answered in ${answered} ms`);
        assert.deepEqual(await events(slow.booking._id), ['booked:1'], 'queued once the slow insert finished');
      } finally { (SmsNoticeModel as any).create = realCreate; }
      record((await drain()).sent);
      await SmsNoticeModel.collection.dropIndex('bookingKind_1_bookingId_1_event_1_version_1');
      resetIndexChecks();
      try {
        const n = await consultP();
        assert.equal(n.booking.status, 'confirmed');
        assert.deepEqual(await events(n.booking._id), []);
        assert.ok(logged.some((l) => l.includes('indexes_outdated')));
      } finally {
        await SmsNoticeModel.syncIndexes();
        resetIndexChecks();
      }
    });

    // ───────────────────────── 5. Admin read, no personal data ─────────────────────────
    await check('admin per-booking read: codes and times only; admins only; a bad query is 400', async () => {
      const r = await consultP();
      record((await drain()).sent);
      const list = (await expect('ADMIN', 'GET', `/api/v1/admin/sms-notices?bookingKind=booking&bookingId=${r.booking._id}`, 200)).json.data;
      // r34: the pharmacy create also queued the visit reminder (5c), due 2 h before the slot.
      assert.deepEqual(list.map((x: any) => [x.event, x.state]), [['booked', 'sent'], ['reminder', 'queued']]);
      assert.deepEqual(Object.keys(list[0]).sort(), ['attempts', 'createdAt', 'dueAt', 'event', 'lang', 'message', 'reason', 'sentAt', 'state', 'version']);
      assert.deepEqual([list[0].event, list[0].state, list[0].message], ['booked', 'sent', 'BOOKED']);
      await expect('ADMIN', 'GET', '/api/v1/admin/sms-notices?bookingKind=booking&bookingId=nope', 400, undefined, 'VALIDATION_ERROR');
      await expect('P', 'GET', `/api/v1/admin/sms-notices?bookingKind=booking&bookingId=${r.booking._id}`, 403);
    });

    await check('no phone number, name, text or template id in any outbox row or log line', async () => {
      assert.ok(sentTexts.length >= 25, `texts sent: ${sentTexts.length}`);
      await smsHooksSettled();
      const rows = JSON.stringify(await SmsNoticeModel.find({}).lean());
      const secrets = [PHONE_X, PHONE_Y, PHONE_S, 'Rina', 'Bikash', 'Mina', 'Selma', ...Object.values(T)];
      for (const s of secrets) assert.ok(!rows.includes(s), `outbox holds ${s}`);
      const sms5 = logged.filter((l) => /sms/i.test(l));
      assert.ok(sms5.length > 0);
      for (const l of logged) {
        for (const s of [PHONE_X, PHONE_Y, PHONE_S, ...Object.values(T)]) assert.ok(!l.includes(s), `a log line holds ${s}: ${l.slice(0, 200)}`);
        for (const t of sentTexts) assert.ok(!l.includes(t.slice(0, 40)), `a log line holds a text: ${l.slice(0, 200)}`);
      }
      for (const l of sms5) for (const n of ['Rina', 'Bikash', 'Mina', 'Sharma', 'Metro']) assert.ok(!l.includes(n), `an SMS log line holds ${n}`);
    });
  } finally {
    server.close();
    await mongoose.disconnect();
    removeFixtureDir();
  }
  console.log(`\n${passed} passed, ${failed.length} failed`);
  if (failed.length) { console.log('FAILED:\n - ' + failed.join('\n - ')); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
