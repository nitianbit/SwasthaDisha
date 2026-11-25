/**
 * Rounds 4c and 4d (ASSISTED_BOOKING_DESIGN.md §26.7, §26.8; build record §26.16).
 * 4c — `provider_coupon_v2` + a top-level `earningSplit` for SELF bookings behind EARNING_RULE_V2_FOR_ALL (off):
 *   off: nothing is written (the rows are as before), the earning is the price; on: a platform coupon makes the provider
 *   earn the list price, a provider coupon list − discount; a booking the ledger does not pay never gets the rule.
 * 4d — wallet withdrawals, built and OFF (WALLET_WITHDRAWALS_ENABLED): the switch, the index 503, the destination, the
 *   minimum, the 7-day card hold (and the lot backfill), the fee only on UNSPENT card money (owner, 25 Nov), a hold
 *   racing a booking debit (never below zero), 5 identical requests (one hold), the weekly limit, cancel / reject / void
 *   posting exactly once, paid as a compare-and-set with a unique UTR, the ₹50,000 cap (top-up refused, a credit alerts),
 *   a chargeback flagged then Recovered, and the lab and doctor routes.
 * Real routes over HTTP (configureRoutes) on MongoDB; a stand-in Razorpay.
 *
 * Run (throwaway DB only; the script drops its database):
 *   JWT_SECRET_KEY=local-integration-only SESSION_ORIGINS_CUSTOMER=https://app.jansetu.test SESSION_ORIGINS_WORKSPACE=https://staff.jansetu.test \
 *     MONGODB_URL='mongodb://127.0.0.1:27917/r32_phase4cd_check?directConnection=true' npx tsx test/assisted/r32-phase4cd.integration.ts
 */
import { removeFixtureDir } from '../partners/q3-fixture-dir';
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
import { UserRepository } from '@/modules/user/repository';
import BookingModel from '@/modules/bookings/model';
import { BookingRepository } from '@/modules/bookings/repository';
import { BookingService } from '@/modules/bookings/services';
import SlotModel from '@/modules/slots/model';
import SpecialistModel from '@/modules/specialists/model';
import PaymentRecordModel from '@/modules/payment/model';
import { PaymentRepository } from '@/modules/payment/repository';
import { PaymentService } from '@/modules/payment/services';
import { WalletModel } from '@/modules/wallet/model';
import { WalletRepository, WalletTransactionRepository } from '@/modules/wallet/repository';
import { CouponModel } from '@/modules/coupon/model';
import { CouponService } from '@/modules/coupon/services';
import { CouponRepository } from '@/modules/coupon/repository';
import PharmacyModel from '@/modules/pharmacies/model';
import { PharmacyService } from '@/modules/pharmacies/services';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import { PharmacyWalletModel, PharmacyWalletTransactionModel } from '@/modules/pharmacyWallet/model';
import { PharmacyWalletRepository, PharmacyWalletTransactionRepository } from '@/modules/pharmacyWallet/repository';
import { PharmacyWalletService } from '@/modules/pharmacyWallet/services';
import { WalletTopupLotModel } from '@/modules/pharmacyWallet/model/lots';
import { pharmacyStore, pharmacyTopups } from '@/modules/pharmacyWallet/ledger';
import { creditTopupIn, postMovementIn, walletTransaction, type TopupKind, type WalletStore } from '@/modules/pharmacyWallet/walletCore';
import { BannerService } from '@/modules/banners/services';
import { BannerRepository } from '@/modules/banners/repository';
import { PartnerSlotModel } from '@/modules/partners/model/slot';
import { PartnerLabBookingModel } from '@/modules/partners/model/labBooking';
import { LedgerEntryModel, SettlementEventModel } from '@/modules/partners/model/settlement';
import { PartnerRepository } from '@/modules/partners/repository';
import { MemberRepository } from '@/modules/partners/repository/member';
import { BranchRepository } from '@/modules/partners/repository/branch';
import { CatalogueItemRepository } from '@/modules/partners/repository/catalogueItem';
import { PartnerService, type PartnerActor } from '@/modules/partners/services';
import { CatalogueService } from '@/modules/partners/services/catalogue';
import { LabBookingService } from '@/modules/partners/services/labBookings';
import { ensureSettlementAccount } from '@/modules/partners/services/settlement';
import { setPayoutDetails } from '@/modules/partners/services/finance';
import { doctorTopups, labTopups, partnerStore } from '@/modules/partnerWallets/ledger';
import { PartnerWalletEntryModel, PartnerWalletModel } from '@/modules/partnerWallets/model';
import { postConsultationEarningIn } from '@/modules/doctors/services/earnings';
import { runLedgerTransaction } from '@/modules/common/utils/bookingWalletFunding';
import { resetIndexChecks } from '@/modules/common/utils/requiredIndex';
import { AssistedAlertModel, AssistedAuditEventModel } from '@/modules/assisted/model';
import { setAssistedNotifier } from '@/modules/assisted/support';
import { selfEarningOf, selfSplitPatchFor } from '@/modules/referralCuts/selfEarning';
import { WalletWithdrawalModel } from '@/modules/walletWithdrawals/model';
import { backfillLotWithdrawableAfter } from '@/scripts/lotWithdrawableAfter';
import type { IMember, PartnerPermission } from '@/modules/partners/types';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/r32_phase4cd_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const oid = () => new Types.ObjectId().toHexString();
const MIN = 60_000;
const DAY = 86_400_000;
const IST = 330 * MIN;
const noop = new Proxy({}, { get: () => async () => undefined });
const istParts = (at: Date) => { const s = new Date(at.getTime() + IST).toISOString(); return { date: s.slice(0, 10).replace(/-/g, ''), time: s.slice(11, 16) }; };

// ── Razorpay stand-in (orders only: nothing here is captured through the gateway) ──
const fakeRazorpay = {
  orders: {
    create: async (o: { amount: number; currency: string }) => ({ id: 'order_r32_' + oid(), amount: o.amount, currency: o.currency, status: 'created' }),
    fetchPayments: async () => ({ items: [] }),
  },
  payments: { fetch: async () => { throw Object.assign(new Error('no such payment'), { statusCode: 400 }); } },
};

// ── Services (tsx emits no decorator metadata: wired by hand) ──
const payments = Object.assign(Object.create(PaymentService.prototype), {
  bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
  walletTransactionRepository: new WalletTransactionRepository(), pharmacyWalletRepository: new PharmacyWalletRepository(),
  pharmacyWalletTransactionRepository: new PharmacyWalletTransactionRepository(), bookingReminderScheduler: noop,
  getRazorpayClient: () => fakeRazorpay, getRazorpayCredentials: () => ({ keyId: 'rzp_test_key', keySecret: 'secret' }),
}) as unknown as PaymentService;
/** The customer's coupon check: CORP (platform) and PROV (provider) take ₹100 off. */
const couponStub = { validateCoupon: async (q: { code: string }) => ({ isValid: true, coupon: { code: q.code }, discountAmount: 100 }) };
const bookingService = Object.assign(Object.create(BookingService.prototype), {
  bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
  walletTransactionRepository: new WalletTransactionRepository(), userRepository: new UserRepository(),
  notificationService: noop, paymentService: payments, couponService: couponStub, emailService: {}, bookingReminderScheduler: noop,
  specialistService: { getById: async (id: string) => SpecialistModel.findById(id).lean() },
  slotService: { getById: async (id: string) => SlotModel.findById(id).lean() },
}) as BookingService;
const partnerSvc = new PartnerService(new PartnerRepository(), new MemberRepository(), new BranchRepository());
const catalogueSvc = new CatalogueService(new CatalogueItemRepository());
const labCoupons = Object.assign(Object.create(CouponService.prototype), {
  validateCoupon: async (q: { code: string }) => ({ isValid: true, coupon: { code: q.code }, discountAmount: 100 }) }) as CouponService;
const labSvc = new LabBookingService(payments, labCoupons, new WalletRepository());
labSvc.notify = async () => undefined;
Container.set(BookingService, bookingService);
Container.set(PartnerService, partnerSvc);
Container.set(CatalogueService, catalogueSvc);
Container.set(LabBookingService, labSvc);
Container.set(PaymentService, payments);
Container.set(PharmacyService, new PharmacyService(new PharmacyRepository(), new UserRepository()));
Container.set(PharmacyWalletService, new PharmacyWalletService(new PharmacyWalletRepository(), new PharmacyWalletTransactionRepository(), new BookingRepository(),
  undefined as never, payments));
Container.set(BannerService, new BannerService(new BannerRepository()));
setAssistedNotifier(async () => undefined);

let passed = 0;
const failed: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log('ok -', name); } catch (e) { failed.push(name); console.log('FAIL -', name); console.error(e); }
}
const actorFor = (m: IMember): PartnerActor => ({ memberId: String(m._id), partnerId: String(m.partnerId), role: m.role,
  permissions: m.permissions as PartnerPermission[], branchIds: (m.branchIds ?? []).map(String) });
let phoneSeq = 7320000000;
const nextPhone = () => String(phoneSeq++);
let keySeq = 0;
const newKey = () => `r32-key-${String(++keySeq).padStart(4, '0')}-${oid().slice(-6)}`;

async function main() {
  await mongoose.connect(FIXTURE_URL);
  await mongoose.connection.dropDatabase();
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

  const flagsOn = () => {
    process.env.ASSISTED_BOOKING_ENABLED_PHARMACY = 'true';
    process.env.ASSISTED_ADMIN_TOOLS_ENABLED = 'true';
    process.env.ASSISTED_BOOKING_ENABLED_LAB = 'true';
    process.env.ASSISTED_BOOKING_ENABLED_DOCTOR = 'true';
    process.env.WALLET_WITHDRAWALS_ENABLED = 'true';
    delete process.env.EARNING_RULE_V2_FOR_ALL;
  };
  flagsOn();

  try {
    // ── People: a pharmacy, a customer, a doctor; a verified lab with its owner; coupons ──
    const P = oid(); const P2 = oid(); const X = oid(); const D = oid(); const ADMIN = oid();
    await PharmacyModel.collection.insertMany([
      { _id: new Types.ObjectId(P), name: 'Sharma Medicals', phone: '9700003201', city: 'Shillong', pincode: '793001', isActive: true, isVerified: true },
      { _id: new Types.ObjectId(P2), name: 'Second Pharmacy', phone: '9700003202', city: 'Shillong', pincode: '793001', isActive: true, isVerified: true },
    ] as never);
    await UserModel.collection.insertOne({ _id: new Types.ObjectId(X), userType: 'user', phone: '9600003201', name: 'Rina Das', createdSource: 'self_signup',
      otpVerified: true } as never);
    await WalletModel.create({ userId: X, balance: 0, isActive: true });
    await SpecialistModel.collection.insertOne({ _id: new Types.ObjectId(D), name: 'Dr Asha Menon', email: 'asha@doc.test', specialization: 'General Physician',
      consultationFee: 500, isActive: true, isVerified: true } as never);
    const coupon = (code: string, fundedBy: 'platform' | 'provider') => CouponModel.create({ code, discountType: 'fixed', discountValue: 100, applicableTo: 'all',
      eligibleFor: 'all', startDate: '20200101', endDate: '20991231', currentUsageCount: 0, totalUsageLimit: 1000, isActive: true, fundedBy } as never);
    await coupon('CORP', 'platform'); await coupon('PROV', 'provider');
    const { partner, owner } = await partnerSvc.createPartner({
      kind: 'lab', name: 'Metro Labs', legalName: 'Metro Labs Pvt Ltd', contactPhone: nextPhone(), invoiceSeriesPrefix: 'ML',
      firstOwner: { phone: nextPhone(), name: 'Owner' }, taxRegime: 'regular', gstin: '29AABCM1234F1ZH',
    } as never);
    const L = String(partner._id);
    await partnerSvc.verifyPartner(L, 'admin');
    const own = actorFor(owner);
    const A = String((await partnerSvc.createBranch(own, { name: 'Police Bazar', phone: '9876500000', holidays: [], hours: {},
      services: { homeCollection: true, inLab: true, inClinic: false }, address: { line1: '1 Road', city: 'Shillong', state: 'Meghalaya', stateCode: '17', pincode: '793001' } } as never))._id);
    const cbc = String((await catalogueSvc.createItem(own, { kind: 'test', name: 'CBC', priceMinor: 50000, gstRate: 0, visitModes: ['lab'], reportTatHours: 24 } as never))._id);
    let labMinute = 0;
    /** A lab slot 30 h ahead (a distinct minute each time). */
    const labSlot = async () => {
      labMinute += 1;
      const startsAt = new Date(Math.floor(Date.now() / MIN) * MIN + 30 * 3_600_000 + labMinute * MIN);
      const s = new Date(startsAt.getTime() + IST).toISOString();
      const e = new Date(startsAt.getTime() + 30 * MIN + IST).toISOString();
      const row = await PartnerSlotModel.create({ partnerId: L, branchId: A, visitMode: 'lab', date: s.slice(0, 10), startTime: s.slice(11, 16), endTime: e.slice(11, 16),
        startsAt, endsAt: new Date(startsAt.getTime() + 30 * MIN), capacity: 5, booked: 0, closed: null, source: 'manual' } as never);
      return String(row._id);
    };

    const sign = (claims: object) => jwt.sign(claims, CONFIG.JWT_SECRET_KEY, { expiresIn: '1h' });
    const tokens: Record<string, string> = {
      P: sign({ _id: P, pharmacyId: P, userType: 'pharmacy' }), P2: sign({ _id: P2, pharmacyId: P2, userType: 'pharmacy' }),
      X: sign({ _id: X, userType: 'user', authVersion: 0 }), ADMIN: sign({ _id: ADMIN, userType: 'admin' }),
      D: sign({ _id: D, specialistId: D, userType: 'specialist' }),
      LAB: sign({ _id: String(owner._id), memberId: String(owner._id), partnerId: L, userType: 'partner' }),
    };
    const call = async (who: string | null, method: string, url: string, body?: unknown) => {
      const r = await fetch(base + url, { method, headers: { ...(who ? { authorization: `Bearer ${tokens[who] ?? who}` } : {}), 'content-type': 'application/json' },
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

    // ───────────────────────── 4c ─────────────────────────
    let dayOffset = 0;
    const consultSlot = async () => {
      dayOffset += 1;
      const at = new Date(Date.now() + (4 + dayOffset) * DAY + 7 * 3_600_000);
      const s = istParts(at); const e = istParts(new Date(at.getTime() + 15 * MIN));
      const slot = await SlotModel.create({ specialistId: D, date: s.date, startTime: s.time, endTime: e.time, duration: 15, maxBookings: 1,
        currentBookings: 0, isActive: true, isAvailable: true, slotType: 'consultation' } as never);
      return { slotId: String(slot._id), date: s.date, time: s.time };
    };
    const consult = async (couponCode?: string) => {
      const sl = await consultSlot();
      const out = await bookingService.createSpecialistBooking({ userId: X, specialistId: D, slotId: sl.slotId, bookingDate: sl.date, bookingTime: sl.time,
        consultationMode: 'video', primaryConcern: 'fever', requestKey: newKey(), ...(couponCode ? { couponCode } : {}) } as never);
      return await BookingModel.findById((out as any).booking?._id ?? (out as any).bookingId ?? (out as any)._id).lean() as any;
    };
    /** Completion's earning for a stored booking (paid), in its own transaction; answers the doctor's earning row. */
    const earn = async (b: any) => {
      await BookingModel.updateOne({ _id: b._id }, { $set: { paymentStatus: 'paid', status: 'completed' } });
      const paid = await BookingModel.findById(b._id).lean() as any;
      await runLedgerTransaction((s) => postConsultationEarningIn(paid, s, { by: 'system', byKind: 'system' }));
      return await LedgerEntryModel.findOne({ source: 'consultation', sourceId: String(b._id), kind: 'earning' }).lean() as any;
    };
    const cutoverBefore = CONFIG.SETTLEMENT_CUTOVER_AT;
    (CONFIG as any).SETTLEMENT_CUTOVER_AT = '2020-01-01';

    await check('4c switch off: self consultations and lab bookings are stored exactly as before (no rule, no split); the earning is the price charged', async () => {
      const b = await consult('CORP');
      assert.equal(b.settlementSystem, 'ledger');
      assert.deepEqual([b.price, b.originalPrice, 'earningRule' in b, 'earningSplit' in b], [400, 500, false, false]);
      const e = await earn(b);
      assert.deepEqual([e.amountMinor, e.grossMinor, e.commissionMinor], [40000, 40000, 0], 'off: the platform coupon still lowers the earning (as today)');
      const lab = await labSvc.create(X, { requestKey: newKey(), partnerId: L, branchId: A, visitMode: 'lab', slotId: await labSlot(), itemIds: [cbc],
        patient: { kind: 'self' }, couponCode: 'CORP' } as never);
      const row = await PartnerLabBookingModel.findById((lab as any).booking._id).lean() as any;
      assert.deepEqual(['earningRule' in row, 'earningSplit' in row], [false, false]);
      assert.deepEqual(await selfEarningOf({ listMinor: 50000, discountMinor: 10000, couponCode: 'CORP' }), {}, 'off: nothing at all');
    });

    await check('4c on: a platform (corporate) coupon makes the doctor and the lab earn the LIST price; a provider coupon earns list − discount; cut 0', async () => {
      process.env.EARNING_RULE_V2_FOR_ALL = 'true';
      try {
        const corp = await consult('CORP');
        assert.equal(corp.earningRule, 'provider_coupon_v2');
        assert.deepEqual(corp.earningSplit, { listMinor: 50000, couponCode: 'CORP', couponFundedBy: 'platform', discountMinor: 10000, baseMinor: 50000, cutMinor: 0,
          providerMinor: 50000, rule: 'provider_coupon_v2' });
        assert.equal(corp.price, 400, 'the patient still pays the discounted price');
        const e1 = await earn(corp);
        assert.deepEqual([e1.amountMinor, e1.grossMinor, e1.commissionMinor], [50000, 50000, 0], 'Jansetu bears the platform coupon');
        const prov = await consult('PROV');
        assert.deepEqual([prov.earningSplit.couponFundedBy, prov.earningSplit.baseMinor], ['provider', 40000]);
        assert.equal((await earn(prov)).amountMinor, 40000, 'a provider coupon earns list − discount, as today');
        const none = await consult();
        assert.equal((await earn(none)).amountMinor, 50000);
        // A lab booking: the split per test, the list price earned on a platform coupon.
        const lab = await labSvc.create(X, { requestKey: newKey(), partnerId: L, branchId: A, visitMode: 'lab', slotId: await labSlot(), itemIds: [cbc],
          patient: { kind: 'self' }, couponCode: 'CORP' } as never);
        const row = await PartnerLabBookingModel.findById((lab as any).booking._id).lean() as any;
        assert.equal(row.earningRule, 'provider_coupon_v2');
        assert.deepEqual([row.earningSplit.baseMinor, row.earningSplit.lines.map((l: any) => [l.catalogItemId, l.baseMinor, l.cutMinor])], [50000, [[cbc, 50000, 0]]]);
        await PartnerLabBookingModel.updateOne({ _id: row._id }, { $set: { paymentStatus: 'paid' } });
        const paidRow = await PartnerLabBookingModel.findById(row._id).lean() as any;
        await runLedgerTransaction((s) => (labSvc as any).postEarning({ memberId: 'system', actorKind: 'member' }, paidRow, s));
        const le = await LedgerEntryModel.findOne({ source: 'partner_lab_booking', sourceId: String(row._id), kind: 'earning' }).lean() as any;
        assert.deepEqual([le.amountMinor, le.grossMinor], [50000, 50000]);
        // Pay-again with another coupon: the split follows the winning record's terms (Q16a).
        assert.deepEqual((await selfSplitPatchFor(corp, { baseAmount: 500, discountAmount: 100, couponCode: 'PROV' })).earningSplit?.baseMinor, 40000);
        assert.deepEqual(await selfSplitPatchFor({ assisted: {}, earningRule: 'provider_coupon_v2' }, { baseAmount: 500 }), {}, 'assisted rows keep their own split');
      } finally { delete process.env.EARNING_RULE_V2_FOR_ALL; }
    });

    await check('4c: old rows and rows the ledger does not pay are untouched — a legacy booking made with the switch on gets no rule', async () => {
      process.env.EARNING_RULE_V2_FOR_ALL = 'true';
      (CONFIG as any).SETTLEMENT_CUTOVER_AT = '';
      try {
        const legacy = await consult('CORP');
        assert.deepEqual([legacy.settlementSystem, 'earningRule' in legacy, 'earningSplit' in legacy], ['legacy', false, false]);
      } finally { delete process.env.EARNING_RULE_V2_FOR_ALL; (CONFIG as any).SETTLEMENT_CUTOVER_AT = '2020-01-01'; }
      // A row made before (no rule) keeps the old earning even while the switch is on.
      const old = await consult('CORP');
      process.env.EARNING_RULE_V2_FOR_ALL = 'true';
      try { assert.equal((await earn(old)).amountMinor, 40000); } finally { delete process.env.EARNING_RULE_V2_FOR_ALL; }
    });
    (CONFIG as any).SETTLEMENT_CUTOVER_AT = cutoverBefore;

    // ───────────────────────── 4d fixtures ─────────────────────────
    const PAY_KIND: Record<string, { kind: TopupKind; field: string; flow: string }> = {
      pharmacy: { kind: pharmacyTopups, field: 'payerPharmacyId', flow: 'pharmacy_wallet_recharge' },
      lab: { kind: labTopups, field: 'payerPartnerId', flow: 'lab_wallet_recharge' },
      doctor: { kind: doctorTopups, field: 'payerSpecialistId', flow: 'doctor_wallet_recharge' },
    };
    /** A captured card top-up credited with its lot (fee known), paid `daysAgo` days ago. */
    const cardTopup = async (walletKind: 'pharmacy' | 'lab' | 'doctor', ownerId: string, amountMinor: number, feeMinor: number, daysAgo: number) => {
      const k = PAY_KIND[walletKind]!;
      const rec = await PaymentRecordModel.create({ userId: ownerId, payerUserId: ownerId, [k.field]: ownerId, context: 'wallet_recharge', contextId: `t_${oid()}`,
        baseAmount: amountMinor / 100, finalAmount: amountMinor / 100, baseAmountPaise: amountMinor, finalAmountPaise: amountMinor, discountAmount: 0,
        currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: `order_${oid()}`, razorpayPaymentId: `pay_${oid().slice(-14)}`, status: 'paid',
        isProcessed: false, paidAt: new Date(Date.now() - daysAgo * DAY), gatewayFeeMinor: feeMinor, notes: { flow: k.flow } } as never);
      await walletTransaction((s) => creditTopupIn(k.kind, rec.toObject() as never, { lots: true }, s));
      return String(rec._id);
    };
    const storeOf = (walletKind: 'pharmacy' | 'lab' | 'doctor', id: string): WalletStore => (walletKind === 'pharmacy' ? pharmacyStore(id) : partnerStore(walletKind, id));
    const balanceOf = async (walletKind: 'pharmacy' | 'lab' | 'doctor', id: string) => {
      const st = storeOf(walletKind, id);
      const w = await st.findIn(null);
      return w ? st.state(w) : { balanceMinor: 0, withdrawableMinor: 0, receivableMinor: 0, frozen: false, isActive: true };
    };
    const spend = (walletKind: 'pharmacy' | 'lab' | 'doctor', id: string, amountMinor: number) => walletTransaction((s) => postMovementIn(storeOf(walletKind, id),
      { kind: 'booking_debit', amountMinor, operationKey: `test_spend:${oid()}`, referenceType: 'test', referenceId: oid(), description: 'A booking' }, s));
    /** The home account's destination set and verified (admin); answers its details version. */
    const verifiedDestination = async (ownerKind: 'pharmacy_referral' | 'partner' | 'doctor', ownerId: string) => {
      const a = await ensureSettlementAccount(ownerKind, ownerId, 'Holder');
      const set = await setPayoutDetails({ accountId: String(a._id) }, { method: 'bank', accountName: 'Holder', accountNumber: '123456789012', ifsc: 'HDFC0001234' },
        { kind: 'admin', id: ADMIN });
      await expect('ADMIN', 'POST', `/api/v1/settlements/accounts/${String(a._id)}/payout-details/verify`, 200, { version: set.payoutDetailsVersion });
      return set.payoutDetailsVersion;
    };
    const PW = '/api/v1/pharmacy-assisted/wallet';
    const ADMW = '/api/v1/admin/wallet-withdrawals';
    const holdsOf = async (id: string) => PharmacyWalletTransactionModel.countDocuments({ operationKey: `withdrawal:${id}:hold` });
    const releasesOf = async (id: string) => PharmacyWalletTransactionModel.countDocuments({ operationKey: `withdrawal:${id}:release` });
    const voidsOf = async (id: string) => PharmacyWalletTransactionModel.countDocuments({ operationKey: `withdrawal:${id}:void` });
    /** Each withdrawal check uses a fresh pharmacy (one withdrawal a week per wallet). */
    const freshPharmacy = async () => {
      const id = oid();
      await PharmacyModel.collection.insertOne({ _id: new Types.ObjectId(id), name: `Pharmacy ${id.slice(-4)}`, phone: nextPhone(), city: 'Shillong', isActive: true, isVerified: true } as never);
      tokens[id] = sign({ _id: id, pharmacyId: id, userType: 'pharmacy' });
      return { id, version: await verifiedDestination('pharmacy_referral', id) };
    };
    const withdraw = (who: string, version: number, amountMinor: number, requestKey = newKey()) => call(who, 'POST', `${PW}/withdrawals`, { amountMinor, requestKey, detailsVersion: version });

    // ───────────────────────── 4d ─────────────────────────
    await check('4d switch off: new requests answer 503 WITHDRAWALS_DISABLED; reads work (enabled: false)', async () => {
      const ph = await freshPharmacy();
      await cardTopup('pharmacy', ph.id, 100_000, 2000, 8);
      process.env.WALLET_WITHDRAWALS_ENABLED = 'false';
      try {
        const r = await withdraw(ph.id, ph.version, 60_000);
        assert.deepEqual([r.status, r.json.code], [503, 'WITHDRAWALS_DISABLED']);
        const w = (await expect(ph.id, 'GET', `${PW}/withdrawable`, 200)).json.data;
        assert.deepEqual([w.enabled, w.withdrawableNowMinor, w.minimumMinor], [false, 100_000, 50_000]);
      } finally { flagsOn(); }
      assert.equal(await WalletWithdrawalModel.countDocuments({ 'walletRef.id': ph.id }), 0);
    });

    await check('4d index 503: without the unique request-key index a request answers 503 INDEXES_OUTDATED; nothing is held', async () => {
      const ph = await freshPharmacy();
      await cardTopup('pharmacy', ph.id, 100_000, 2000, 8);
      const col = mongoose.connection.collection('wallet_withdrawals');
      await col.dropIndex('walletRef.kind_1_walletRef.id_1_requestKey_1');
      resetIndexChecks();
      try {
        const r = await withdraw(ph.id, ph.version, 60_000);
        assert.deepEqual([r.status, r.json.code], [503, 'INDEXES_OUTDATED']);
      } finally {
        await col.createIndex({ 'walletRef.kind': 1, 'walletRef.id': 1, requestKey: 1 }, { unique: true });
        resetIndexChecks();
      }
      assert.equal((await balanceOf('pharmacy', ph.id)).balanceMinor, 100_000);
    });

    await check('4d destination and minimum: unverified 409; a changed version 409; below ₹500 400 WITHDRAWAL_BELOW_MINIMUM; the pharmacy PUT needs a fresh admin verification', async () => {
      const id = oid();
      await PharmacyModel.collection.insertOne({ _id: new Types.ObjectId(id), name: 'New Pharmacy', phone: nextPhone(), isActive: true, isVerified: true } as never);
      tokens[id] = sign({ _id: id, pharmacyId: id, userType: 'pharmacy' });
      await cardTopup('pharmacy', id, 100_000, 2000, 8);
      assert.equal((await withdraw(id, 0, 60_000)).json.code, 'PAYOUT_DESTINATION_NOT_VERIFIED');
      const put = await expect(id, 'PUT', '/api/v1/pharmacy-assisted/finance/payout-details', 200, { method: 'upi', upiId: 'shop@okbank' });
      assert.deepEqual([put.json.data.ownerKind, put.json.data.payoutDetailsState, put.json.data.payoutDetailsVersion], ['pharmacy_referral', 'unverified', 1]);
      assert.equal((await withdraw(id, 1, 60_000)).json.code, 'PAYOUT_DESTINATION_NOT_VERIFIED', 'unverified until an admin checks it');
      await expect('ADMIN', 'POST', `/api/v1/settlements/accounts/${put.json.data._id}/payout-details/verify`, 200, { version: 1 });
      assert.equal((await withdraw(id, 0, 60_000)).json.code, 'PAYOUT_DETAILS_CHANGED');
      const low = await withdraw(id, 1, 49_999);
      assert.deepEqual([low.status, low.json.code], [400, 'WITHDRAWAL_BELOW_MINIMUM']);
      const ok = await withdraw(id, 1, 50_000);
      assert.equal(ok.status, 201, ok.text);
      assert.equal(ok.json.data.withdrawal.destination.masked, 'UPI shop@okbank');
      const ev = await SettlementEventModel.findOne({ settlementAccountId: put.json.data._id, action: 'finance.payout_details_changed' }).lean() as any;
      assert.deepEqual([ev.byKind, ev.by], ['pharmacy', id]);
    });

    await check('4d 7-day card hold: card money younger than 7 days is not withdrawable (409), at day 7 it is; admin credits never; an old lot without the field counts, and the backfill fills it', async () => {
      const ph = await freshPharmacy();
      await cardTopup('pharmacy', ph.id, 80_000, 1600, 3);
      await runLedgerTransaction((s) => postMovementIn(pharmacyStore(ph.id), { kind: 'credit', amountMinor: 200_000, operationKey: `admin_topup:${oid()}`,
        referenceType: 'topup', referenceId: oid(), description: 'Admin top-up' }, s));
      let w = (await expect(ph.id, 'GET', `${PW}/withdrawable`, 200)).json.data;
      assert.equal(w.withdrawableNowMinor, 0, 'neither the young card money nor the admin credit');
      assert.equal(w.availableLater.length, 1);
      assert.equal(w.availableLater[0].amountMinor, 80_000);
      assert.ok(Math.abs(new Date(w.availableLater[0].availableAt).getTime() - (Date.now() + 4 * DAY)) < 60_000, 'available 7 days after payment');
      const r = await withdraw(ph.id, ph.version, 60_000);
      assert.deepEqual([r.status, r.json.code, r.json.details?.withdrawableNowMinor], [409, 'WITHDRAWAL_ABOVE_AVAILABLE', 0]);
      // The lot reaches day 7.
      await WalletTopupLotModel.updateOne({ 'walletRef.id': ph.id }, { $set: { withdrawableAfter: new Date(Date.now() - MIN) } });
      w = (await expect(ph.id, 'GET', `${PW}/withdrawable`, 200)).json.data;
      assert.equal(w.withdrawableNowMinor, 80_000);
      // An old lot written before the field existed counts from its creation; the backfill writes createdAt + 7 days.
      const ph2 = await freshPharmacy();
      await cardTopup('pharmacy', ph2.id, 70_000, 1400, 0);
      const lot = await WalletTopupLotModel.findOne({ 'walletRef.id': ph2.id }).lean() as any;
      const created = new Date(Date.now() - 10 * DAY);
      await WalletTopupLotModel.collection.updateOne({ _id: lot._id }, { $unset: { withdrawableAfter: '' }, $set: { createdAt: created } });
      assert.equal((await expect(ph2.id, 'GET', `${PW}/withdrawable`, 200)).json.data.withdrawableNowMinor, 70_000);
      const dry = await backfillLotWithdrawableAfter({ commit: false });
      assert.ok(dry.missing.pharmacy >= 1 && dry.filled === 0);
      const done = await backfillLotWithdrawableAfter({ commit: true });
      assert.ok(done.filled >= 1);
      const after = await WalletTopupLotModel.findById(lot._id).lean() as any;
      assert.equal(new Date(after.withdrawableAfter).getTime(), created.getTime() + 7 * DAY);
      assert.equal((await backfillLotWithdrawableAfter({ commit: true })).filled, 0, 'rerunnable');
      // New pharmacy lots carry the hold (cardHoldDays 7).
      assert.ok((await WalletTopupLotModel.findOne({ 'walletRef.id': ph.id }).lean() as any).withdrawableAfter);
    });

    await check('4d fee only on UNSPENT card money: ₹2,000 top-up (₹40 fee), ₹1,000 spent on bookings, ₹1,000 withdrawn → fee ₹20, transfer ₹980; spent money paid none', async () => {
      const ph = await freshPharmacy();
      await cardTopup('pharmacy', ph.id, 200_000, 4000, 8);
      await spend('pharmacy', ph.id, 100_000);
      const q = (await expect(ph.id, 'GET', `${PW}/withdrawable?amountMinor=100000`, 200)).json.data;
      assert.deepEqual(q.quote, { grossMinor: 100_000, feeMinor: 2000, transferMinor: 98_000, available: true });
      const r = await withdraw(ph.id, ph.version, 100_000);
      assert.equal(r.status, 201, r.text);
      const w = r.json.data.withdrawal;
      assert.deepEqual([w.state, w.grossMinor, w.feeMinor, w.transferMinor], ['requested', 100_000, 2000, 98_000]);
      assert.equal(w.lots.length, 1);
      assert.equal(w.feeLine, 'Card fee on unspent card money: ₹20.00. You receive ₹980.00 of ₹1000.00.');
      assert.equal(r.json.data.wallet.balanceMinor, 0);
      const hold = await PharmacyWalletTransactionModel.findOne({ operationKey: `withdrawal:${w._id}:hold` }).lean() as any;
      assert.equal(hold.transactionType, 'withdrawal_hold');
      assert.match(hold.description, /card fee ₹20\.00 on unspent card money; you receive ₹980\.00/);
      // Money never spent on a booking and withdrawn whole pays its lot's whole fee; admin money never pays one (never withdrawable).
      const ph2 = await freshPharmacy();
      await cardTopup('pharmacy', ph2.id, 100_000, 2360, 8);
      const all = (await withdraw(ph2.id, ph2.version, 100_000)).json.data.withdrawal;
      assert.deepEqual([all.feeMinor, all.transferMinor], [2360, 97_640]);
    });

    await check('4d race: a withdrawal hold against a booking debit — at most what the wallet holds goes out; it never goes below zero (3 runs)', async () => {
      for (let i = 0; i < 3; i++) {
        const ph = await freshPharmacy();
        await cardTopup('pharmacy', ph.id, 100_000, 2000, 8);
        const [wr, sp] = await Promise.allSettled([withdraw(ph.id, ph.version, 80_000), spend('pharmacy', ph.id, 50_000)]);
        const held = wr.status === 'fulfilled' && (wr.value as any).status === 201;
        const spent = sp.status === 'fulfilled';
        assert.ok(held !== spent, `exactly one fits: held ${held}, spent ${spent} ${wr.status === 'fulfilled' ? (wr.value as any).text : ''}`);
        const b = await balanceOf('pharmacy', ph.id);
        assert.equal(b.balanceMinor, 100_000 - (held ? 80_000 : 50_000));
        assert.ok(b.balanceMinor >= 0);
        const lot = await WalletTopupLotModel.findOne({ 'walletRef.id': ph.id }).lean() as any;
        assert.equal(lot.remainingMinor, b.balanceMinor, 'the lot and the balance agree');
      }
    });

    await check('4d race: 5 identical requests → one withdrawal, one hold; another amount on the key 409; by-key; another pharmacy 404', async () => {
      const ph = await freshPharmacy();
      await cardTopup('pharmacy', ph.id, 100_000, 2000, 8);
      const key = newKey();
      const rs = await Promise.all([1, 2, 3, 4, 5].map(() => withdraw(ph.id, ph.version, 60_000, key)));
      assert.ok(rs.every((r) => r.status === 200 || r.status === 201), rs.map((r) => `${r.status} ${r.text.slice(0, 120)}`).join(' | '));
      assert.equal(rs.filter((r) => r.json.data.replayed === false).length, 1);
      const ids = new Set(rs.map((r) => r.json.data.withdrawal._id));
      assert.equal(ids.size, 1);
      const id = [...ids][0]!;
      assert.equal(await holdsOf(id), 1);
      assert.equal((await balanceOf('pharmacy', ph.id)).balanceMinor, 40_000);
      assert.equal((await withdraw(ph.id, ph.version, 70_000, key)).json.code, 'IDEMPOTENCY_KEY_REUSED');
      assert.equal((await expect(ph.id, 'GET', `${PW}/withdrawals/by-key/${key}`, 200)).json.data.withdrawal._id, id);
      assert.equal((await expect(ph.id, 'POST', `${PW}/withdrawals/by-key/${newKey()}/abandon`, 200)).json.data.state, 'abandoned');
      await expect('P2', 'GET', `${PW}/withdrawals/${id}`, 404, undefined, 'WITHDRAWAL_NOT_FOUND');
      await expect('P2', 'POST', `${PW}/withdrawals/${id}/cancel`, 404, { expectedVersion: 0 }, 'WITHDRAWAL_NOT_FOUND');
      assert.equal((await expect(ph.id, 'GET', `${PW}/withdrawals`, 200)).json.data.length, 1);
    });

    await check('4d weekly limit: a second request within 7 days 409 with nextAllowedAt; after a cancel a new one is allowed; cancel releases once', async () => {
      const ph = await freshPharmacy();
      await cardTopup('pharmacy', ph.id, 200_000, 4000, 8);
      const first = (await withdraw(ph.id, ph.version, 60_000)).json.data.withdrawal;
      const second = await withdraw(ph.id, ph.version, 60_000);
      assert.deepEqual([second.status, second.json.code], [409, 'WITHDRAWAL_WEEKLY_LIMIT']);
      assert.ok(Math.abs(new Date(second.json.details.nextAllowedAt).getTime() - (new Date(first.createdAt).getTime() + 7 * DAY)) < 1000);
      assert.equal((await expect(ph.id, 'GET', `${PW}/withdrawable`, 200)).json.data.nextAllowedAt, second.json.details.nextAllowedAt);
      await expect(ph.id, 'POST', `${PW}/withdrawals/${first._id}/cancel`, 409, { expectedVersion: 5 }, 'WITHDRAWAL_CHANGED');
      const c = await expect(ph.id, 'POST', `${PW}/withdrawals/${first._id}/cancel`, 200, { expectedVersion: 0 });
      assert.deepEqual([c.json.data.withdrawal.state, c.json.data.wallet.balanceMinor], ['cancelled', 200_000]);
      const again = await expect(ph.id, 'POST', `${PW}/withdrawals/${first._id}/cancel`, 200, { expectedVersion: 0 });
      assert.equal(again.json.data.replayed, true);
      assert.equal(await releasesOf(first._id), 1, 'released once');
      const lot = await WalletTopupLotModel.findOne({ 'walletRef.id': ph.id }).lean() as any;
      assert.equal(lot.remainingMinor, 200_000, 'the held lot is restored exactly');
      assert.equal((await withdraw(ph.id, ph.version, 60_000)).status, 201, 'a cancelled one does not count');
    });

    await check('4d admin: reject releases once; paid is a compare-and-set (cancel vs paid: one wins, money once); the UTR is unique per home account; void restores once', async () => {
      // Reject.
      const a = await freshPharmacy();
      await cardTopup('pharmacy', a.id, 100_000, 2000, 8);
      const wa = (await withdraw(a.id, a.version, 60_000)).json.data.withdrawal;
      const q = (await expect('ADMIN', 'GET', `${ADMW}?state=requested`, 200)).json.data;
      assert.ok(q.some((x: any) => x._id === wa._id && x.walletRef.id === a.id && x.destination.homeAccountId));
      await expect('ADMIN', 'POST', `${ADMW}/${wa._id}/reject`, 200, { reason: 'wrong account holder', expectedVersion: 0 });
      await expect('ADMIN', 'POST', `${ADMW}/${wa._id}/reject`, 200, { reason: 'wrong account holder', expectedVersion: 0 });
      assert.equal(await releasesOf(wa._id), 1);
      assert.equal((await balanceOf('pharmacy', a.id)).balanceMinor, 100_000);
      // Cancel vs paid racing (3 runs): exactly one wins; the money moves once.
      for (let i = 0; i < 3; i++) {
        const b = await freshPharmacy();
        await cardTopup('pharmacy', b.id, 100_000, 2000, 8);
        const wb = (await withdraw(b.id, b.version, 60_000)).json.data.withdrawal;
        const today = new Date(Date.now() + IST).toISOString().slice(0, 10);
        const [c, p] = await Promise.all([call(b.id, 'POST', `${PW}/withdrawals/${wb._id}/cancel`, { expectedVersion: 0 }),
          call('ADMIN', 'POST', `${ADMW}/${wb._id}/paid`, { method: 'bank_transfer', reference: `UTR${oid().slice(-10)}`, paidOn: today, detailsVersion: b.version,
            expectedVersion: 0, requestKey: newKey() })]);
        const wins = [c, p].filter((r) => r.status === 200);
        assert.equal(wins.length, 1, `${c.status} ${c.text.slice(0, 120)} | ${p.status} ${p.text.slice(0, 120)}`);
        const row = await WalletWithdrawalModel.findById(wb._id).lean() as any;
        assert.equal(await releasesOf(wb._id), row.state === 'cancelled' ? 1 : 0);
        assert.equal((await balanceOf('pharmacy', b.id)).balanceMinor, row.state === 'cancelled' ? 100_000 : 40_000);
      }
      // Paid: replay with its key, the UTR unique per home account, the SettlementEvent; then void.
      const v = await freshPharmacy();
      await cardTopup('pharmacy', v.id, 200_000, 4000, 8);
      const w1 = (await withdraw(v.id, v.version, 60_000)).json.data.withdrawal;
      const today = new Date(Date.now() + IST).toISOString().slice(0, 10);
      const paidBody = { method: 'upi', reference: 'UTR-R32-0001', paidOn: today, detailsVersion: v.version, expectedVersion: 0, requestKey: newKey() };
      await expect('ADMIN', 'POST', `${ADMW}/${w1._id}/paid`, 409, { ...paidBody, detailsVersion: v.version + 1 }, 'PAYOUT_DETAILS_CHANGED');
      const paid = await expect('ADMIN', 'POST', `${ADMW}/${w1._id}/paid`, 200, paidBody);
      assert.deepEqual([paid.json.data.withdrawal.state, paid.json.data.withdrawal.paid.reference], ['paid', 'UTR-R32-0001']);
      assert.equal((await expect('ADMIN', 'POST', `${ADMW}/${w1._id}/paid`, 200, paidBody)).json.data.replayed, true);
      await expect('ADMIN', 'POST', `${ADMW}/${w1._id}/paid`, 409, { ...paidBody, requestKey: newKey() }, 'WITHDRAWAL_NOT_REQUESTED');
      await expect(v.id, 'POST', `${PW}/withdrawals/${w1._id}/cancel`, 409, { expectedVersion: 1 }, 'WITHDRAWAL_NOT_REQUESTED');
      assert.equal(await SettlementEventModel.countDocuments({ action: 'withdrawal_paid', 'detail.withdrawalId': w1._id }), 1);
      assert.equal((await balanceOf('pharmacy', v.id)).balanceMinor, 140_000, 'paid moves nothing');
      // A second withdrawal of the same home account (next week) paid with the same UTR: refused.
      await WalletWithdrawalModel.collection.updateOne({ _id: new Types.ObjectId(w1._id) }, { $set: { createdAt: new Date(Date.now() - 8 * DAY) } });
      const w2 = (await withdraw(v.id, v.version, 60_000)).json.data.withdrawal;
      await expect('ADMIN', 'POST', `${ADMW}/${w2._id}/paid`, 409, { ...paidBody, expectedVersion: 0, requestKey: newKey() }, 'REFERENCE_REUSED');
      // Void (the transfer bounced): the gross and the lots come back, once.
      await expect('ADMIN', 'POST', `${ADMW}/${w1._id}/void`, 409, { reason: 'bounced', expectedVersion: 0 }, 'WITHDRAWAL_CHANGED');
      const vd = await expect('ADMIN', 'POST', `${ADMW}/${w1._id}/void`, 200, { reason: 'bank returned it', expectedVersion: 1 });
      assert.equal(vd.json.data.withdrawal.state, 'voided');
      await expect('ADMIN', 'POST', `${ADMW}/${w1._id}/void`, 200, { reason: 'bank returned it', expectedVersion: 1 });
      assert.equal(await voidsOf(w1._id), 1);
      assert.equal((await balanceOf('pharmacy', v.id)).balanceMinor, 140_000 - 60_000 + 60_000);
      await expect('ADMIN', 'POST', `${ADMW}/${w2._id}/void`, 409, { reason: 'x not paid', expectedVersion: 0 }, 'WITHDRAWAL_NOT_PAID');
      const audits = await AssistedAuditEventModel.find({ orgId: v.id, action: { $regex: '^withdrawal\\.' } }).lean() as any[];
      assert.deepEqual(audits.map((x) => x.action).sort(), ['withdrawal.paid', 'withdrawal.requested', 'withdrawal.requested', 'withdrawal.voided']);
      assert.ok(!JSON.stringify(audits).includes('123456789012'), 'no account number in the audit');
    });

    await check('4d cap ₹50,000: a pharmacy card top-up above it 409 WALLET_LIMIT_REACHED; a credit above it posts and raises wallet_over_limit', async () => {
      const ph = await freshPharmacy();
      await cardTopup('pharmacy', ph.id, 4_000_000, 0, 8);
      const r = await call(ph.id, 'POST', '/api/v1/pharmacy-wallet/topup', { amount: 15_000 });
      assert.deepEqual([r.status, r.json.code], [409, 'WALLET_LIMIT_REACHED']);
      assert.equal(r.json.details.allowedMinor, 1_000_000);
      const ok = await call(ph.id, 'POST', '/api/v1/pharmacy-wallet/topup', { amount: 10_000 });
      assert.equal(ok.status, 200, ok.text);
      const again = await call(ph.id, 'POST', '/api/v1/pharmacy-wallet/topup', { amount: 1 });
      assert.equal(again.json.code, 'WALLET_LIMIT_REACHED', 'an unpaid top-up of the last 30 minutes counts');
      // A refund / admin credit beyond the cap posts and alerts (money is never stranded).
      await runLedgerTransaction((s) => postMovementIn(pharmacyStore(ph.id), { kind: 'refund_credit', amountMinor: 2_000_000, operationKey: `refund:${oid()}`,
        referenceType: 'test', referenceId: oid(), description: 'A refund' }, s));
      assert.equal((await balanceOf('pharmacy', ph.id)).balanceMinor, 6_000_000);
      const alert = await AssistedAlertModel.findOne({ kind: 'wallet_over_limit', bookerId: ph.id }).lean() as any;
      assert.deepEqual([alert.bookerKind, alert.detail.balanceMinor, alert.detail.maxBalanceMinor], ['pharmacy', 6_000_000, 5_000_000]);
    });

    await check('4d chargeback then Recover: the dispute is flagged only (no debit, no freeze, not withdrawable); Recover debits, owes the shortfall, freezes — once; withdrawals then refused', async () => {
      const ph = await freshPharmacy();
      const rid = await cardTopup('pharmacy', ph.id, 100_000, 2000, 8);
      await spend('pharmacy', ph.id, 70_000);
      const lot = await WalletTopupLotModel.findOne({ paymentRecordId: rid }).lean() as any;
      await expect('ADMIN', 'POST', `/api/v1/admin/wallet-lots/${String(lot._id)}/recover`, 409, { reason: 'too early', requestKey: newKey() }, 'DISPUTE_NOT_RECORDED');
      const cb = await expect('ADMIN', 'POST', `/api/v1/admin/wallet-lots/${String(lot._id)}/chargeback`, 200, { reason: 'Razorpay dispute lost' });
      assert.deepEqual([cb.json.data.flagged, cb.json.data.pharmacyId, cb.json.data.walletKind], [true, ph.id, 'pharmacy']);
      let b = await balanceOf('pharmacy', ph.id);
      assert.deepEqual([b.balanceMinor, b.frozen, b.withdrawableMinor, b.receivableMinor], [30_000, false, 0, 0], 'flag only');
      assert.equal(await PharmacyWalletTransactionModel.countDocuments({ pharmacyId: ph.id, transactionType: 'chargeback' }), 0);
      const rec = await expect('ADMIN', 'POST', `/api/v1/admin/wallet-payments/${rid}/recover`, 200, { reason: 'recovering the disputed top-up', requestKey: newKey() });
      assert.deepEqual([rec.json.data.recovered, rec.json.data.replayed, rec.json.data.lotId], [true, false, String(lot._id)]);
      b = await balanceOf('pharmacy', ph.id);
      assert.deepEqual([b.balanceMinor, b.receivableMinor, b.frozen], [0, 70_000, true], 'debited what it could; the rest owed; frozen');
      const twice = await expect('ADMIN', 'POST', `/api/v1/admin/wallet-lots/${String(lot._id)}/recover`, 200, { reason: 'again please', requestKey: newKey() });
      assert.equal(twice.json.data.replayed, true);
      assert.equal(await PharmacyWalletTransactionModel.countDocuments({ pharmacyId: ph.id, transactionType: 'chargeback' }), 1, 'once');
      assert.equal(await AssistedAuditEventModel.countDocuments({ orgId: ph.id, action: 'wallet.recovered' }), 1);
      // A wallet owing money withdraws nothing; a later credit clears the receivable first.
      await cardTopup('pharmacy', ph.id, 100_000, 2000, 8);
      b = await balanceOf('pharmacy', ph.id);
      assert.deepEqual([b.balanceMinor, b.receivableMinor], [30_000, 0]);
      assert.equal((await withdraw(ph.id, ph.version, 50_000)).json.code, 'WALLET_FROZEN');
    });

    await check('4d lab and doctor: the same withdrawal on their own routes (lab member with wallet.manage; eligible doctor), to their home accounts', async () => {
      await cardTopup('lab', L, 100_000, 2000, 8);
      const lv = await verifiedDestination('partner', L);
      const lr = await expect('LAB', 'POST', '/api/v1/partner-workspace/assisted/wallet/withdrawals', 201, { amountMinor: 60_000, requestKey: newKey(), detailsVersion: lv });
      assert.deepEqual([lr.json.data.withdrawal.walletKind, lr.json.data.withdrawal.feeMinor, lr.json.data.wallet.balanceMinor], ['lab', 1200, 40_000]);
      assert.equal(await PartnerWalletEntryModel.countDocuments({ ownerKind: 'lab', kind: 'withdrawal_hold' }), 1);
      const lw = (await expect('LAB', 'GET', '/api/v1/partner-workspace/assisted/wallet/withdrawable', 200)).json.data;
      assert.ok(lw.nextAllowedAt);
      await expect('LAB', 'POST', `/api/v1/partner-workspace/assisted/wallet/withdrawals/${lr.json.data.withdrawal._id}/cancel`, 200, { expectedVersion: 0 });
      assert.equal((await PartnerWalletModel.findOne({ ownerKind: 'lab', ownerId: L }).lean() as any).balanceMinor, 100_000);
      await cardTopup('doctor', D, 100_000, 2000, 8);
      const dv = await verifiedDestination('doctor', D);
      const dr = await expect('D', 'POST', '/api/v1/specialists/me/assisted/wallet/withdrawals', 201, { amountMinor: 50_000, requestKey: newKey(), detailsVersion: dv });
      assert.deepEqual([dr.json.data.withdrawal.walletKind, dr.json.data.withdrawal.transferMinor], ['doctor', 49_000]);
      assert.equal((await expect('ADMIN', 'GET', `${ADMW}/${dr.json.data.withdrawal._id}`, 200)).json.data.requestedBy.kind, 'doctor');
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
