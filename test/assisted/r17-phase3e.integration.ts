/**
 * Assisted booking round 3e (ASSISTED_BOOKING_DESIGN.md §25.8): a pharmacy books an instant "Consult now" consultation
 * for a walk-in patient, paid from its wallet. Money (one debit = quote − coupon; the quote difference back once at
 * acceptance, not withdrawable; a refund before acceptance once, lots restored, under racing refund / sweep / accept;
 * a doctor or admin cancel after acceptance refunds the allocation once; frozen wallets still get credits; never the
 * patient's wallet), doctors (only eligible doctors are offered; an unverified doctor's accept is 403; earnings once on
 * completion, none on a no-show), keys (replay, other content, abandoned, by-key, 5-way race), the switch, the index
 * 503, the uniform 404, the patient's commands refused and reads without money, reconciliation. Real routes over HTTP
 * (configureRoutes) on MongoDB; notices are captured.
 *
 * Every check runs even when an earlier one fails (the run exits 1 if any failed).
 *
 * Run (throwaway DB only; the script drops its database):
 *   JWT_SECRET_KEY=local-integration-only SESSION_ORIGINS_CUSTOMER=https://app.jansetu.test SESSION_ORIGINS_WORKSPACE=https://staff.jansetu.test \
 *     MONGODB_URL='mongodb://127.0.0.1:27917/r17_phase3e_check?directConnection=true' npx tsx test/assisted/r17-phase3e.integration.ts
 */
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
import DependentModel from '@/modules/dependents/model';
import SpecialistModel from '@/modules/specialists/model';
import BookingModel from '@/modules/bookings/model';
import { BookingRepository } from '@/modules/bookings/repository';
import { BookingService } from '@/modules/bookings/services';
import { PaymentRepository } from '@/modules/payment/repository';
import { PaymentService } from '@/modules/payment/services';
import { WalletModel } from '@/modules/wallet/model';
import { WalletRepository, WalletTransactionRepository } from '@/modules/wallet/repository';
import { CouponModel } from '@/modules/coupon/model';
import { CouponRedemptionModel } from '@/modules/coupon/model/redemption';
import { CouponService } from '@/modules/coupon/services';
import { CouponRepository } from '@/modules/coupon/repository';
import PharmacyModel from '@/modules/pharmacies/model';
import { PharmacyService } from '@/modules/pharmacies/services';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import PharmacyCustomerModel from '@/modules/pharmacyCustomers/model';
import { PharmacyWalletModel, PharmacyWalletTransactionModel } from '@/modules/pharmacyWallet/model';
import { postPharmacyMovementIn } from '@/modules/pharmacyWallet/ledger';
import { BannerService } from '@/modules/banners/services';
import { BannerRepository } from '@/modules/banners/repository';
import { LedgerEntryModel } from '@/modules/partners/model/settlement';
import { DoctorPresenceModel, InstantRequestModel } from '@/modules/doctors/model/instant';
import { InstantConsultService, allocateFunding } from '@/modules/doctors/services/instant';
import { runLedgerTransaction } from '@/modules/common/utils/bookingWalletFunding';
import { resetIndexChecks } from '@/modules/common/utils/requiredIndex';
import { setAssistedNotifier } from '@/modules/assisted/support';
import { runReconciliation } from '@/modules/assisted/reconciliation';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/r17_phase3e_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const oid = () => new Types.ObjectId().toHexString();
const MIN = 60_000;

// ── Services (tsx emits no decorator metadata: wired by hand) ──
const payments = Object.assign(Object.create(PaymentService.prototype), {
  bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
  walletTransactionRepository: new WalletTransactionRepository(),
  getRazorpayClient: () => ({ orders: { fetchPayments: async () => ({ items: [] }) } }), getRazorpayCredentials: () => ({ keyId: 'k', keySecret: 's' }),
}) as unknown as PaymentService;
const svc = new InstantConsultService(payments, new CouponService(new CouponRepository()), new WalletRepository());
const instantNotices: { userId: string; key: string; title: string; message: string }[] = [];
svc.notify = async (n) => { instantNotices.push({ userId: n.userId, key: n.key, title: n.title, message: n.message }); };
Container.set(InstantConsultService, svc);
Container.set(PaymentService, payments);
Container.set(PharmacyService, new PharmacyService(new PharmacyRepository(), new UserRepository()));
Container.set(BannerService, new BannerService(new BannerRepository()));
const bookings = Object.assign(Object.create(BookingService.prototype), {
  bookingRepository: new BookingRepository(), walletRepository: new WalletRepository(),
  bookingReminderScheduler: { clearBookingReminders: async () => undefined, scheduleBookingReminders: async () => undefined },
  notificationService: { create: async () => undefined, createSpecialistAppointmentCancelledNotification: async () => undefined },
}) as BookingService;
const assistedNotices: { audience: string; userId: string; key: string; title: string; message: string }[] = [];
setAssistedNotifier(async (n) => { assistedNotices.push({ audience: n.audience, userId: n.userId, key: n.key, title: n.title, message: n.message }); });

let passed = 0;
const failed: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log('ok -', name); } catch (e) { failed.push(name); console.log('FAIL -', name); console.error(e); }
}
let phoneSeq = 7170000000;
const nextPhone = () => String(phoneSeq++);
let keySeq = 0;
const newKey = () => `r17-key-${String(++keySeq).padStart(4, '0')}-${oid().slice(-6)}`;
const code = (c: string) => (e: any) => e?.code === c;

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

  process.env.ASSISTED_LIMIT_LOOKUPS_PER_HOUR = '100000';
  const flagsOn = () => {
    process.env.ASSISTED_BOOKING_ENABLED_PHARMACY = 'true';
    process.env.ASSISTED_INSTANT_ENABLED = 'true';
    process.env.ASSISTED_ADMIN_TOOLS_ENABLED = 'true';
  };
  flagsOn();
  // A booking made from a partner's request settles by the ledger whatever the cutover says.
  (CONFIG as any).SETTLEMENT_CUTOVER_AT = undefined;

  try {
    // ── Doctors: online in General Physician (two fees), a Dermatologist, an unverified one (online but not eligible) ──
    const doctor = async (name: string, feeRupees: number, specialization = 'General Physician', extra: Record<string, unknown> = {}) => {
      const id = new Types.ObjectId();
      await SpecialistModel.collection.insertOne({ _id: id, name, phone: nextPhone(), email: `${name.replace(/\W/g, '')}${oid().slice(-4)}@x.test`, specialization,
        consultationFee: feeRupees, isActive: true, isVerified: true, rating: 4.5, city: 'Shillong', pincode: '793001', ...extra } as never);
      await svc.setPresence(String(id), { available: true, modes: ['video', 'call'] });
      return String(id);
    };
    // Presence written directly: the presence switch itself refuses an unverified doctor, which this suite keeps "online".
    const online = async (doctorId: string) => DoctorPresenceModel.updateOne({ doctorId }, { $set: { available: true, modes: ['video', 'call'], lastSeenAt: new Date() } });
    const offline = async (doctorId: string) => DoctorPresenceModel.updateOne({ doctorId }, { $set: { available: false } });
    const cheap = await doctor('Dr Cheap', 300);
    const dear = await doctor('Dr Dear', 500, 'General Physician', { city: 'Aizawl', pincode: '796001' });
    const derm = await doctor('Dr Skin', 400, 'Dermatologist');
    const unverified = await doctor('Dr Unverified', 200);
    await SpecialistModel.updateOne({ _id: unverified }, { $set: { isVerified: false } });

    // ── Pharmacies, people, wallets ──
    const P = oid(); const Q = oid(); const W = oid(); const F = oid();
    await PharmacyModel.collection.insertMany([
      { _id: new Types.ObjectId(P), name: 'Sharma Medicals', phone: '9700000401', city: 'Shillong', pincode: '793001', isActive: true, isVerified: true },
      { _id: new Types.ObjectId(Q), name: 'Other Pharmacy', phone: '9700000402', city: 'Aizawl', pincode: '796001', isActive: true, isVerified: true },
      { _id: new Types.ObjectId(W), name: 'Small Wallet', phone: '9700000403', city: 'Shillong', isActive: true, isVerified: true },
      { _id: new Types.ObjectId(F), name: 'Frozen Later', phone: '9700000404', city: 'Shillong', isActive: true, isVerified: true },
    ] as never);
    const X = oid(); const ADMIN = oid();
    await UserModel.collection.insertMany([
      { _id: new Types.ObjectId(X), userType: 'user', phone: '9600000401', name: 'Rina Kumari Das', createdSource: 'self_signup', otpVerified: true },
    ] as never);
    await WalletModel.create({ userId: X, balance: 0, isActive: true });
    const depX = String((await DependentModel.create({ userId: X, name: 'Mina Das', relationship: 'Daughter', gender: 'Female', isActive: true } as never))._id);
    const credit = (pharmacyId: string, paise: number, lot?: string) => runLedgerTransaction((s) => postPharmacyMovementIn({ pharmacyId, kind: 'credit',
      amountPaise: paise, operationKey: `seed:${oid()}`, referenceType: 'admin_topup', referenceId: oid(), description: 'seed',
      ...(lot ? { lot: { paymentRecordId: lot, gatewayFeeMinor: 0 } } : {}) }, s));
    await credit(P, 1_000_000); await credit(Q, 1_000_000); await credit(W, 45_000); await credit(F, 1_000_000);
    const wallet = async (pharmacyId: string) => await PharmacyWalletModel.findOne({ pharmacyId }).lean() as any;
    const balance = async (pharmacyId: string) => Number((await wallet(pharmacyId))?.balancePaise ?? 0);
    const customerBalance = async (u: string) => Number((await WalletModel.findOne({ userId: u }).lean() as any)?.balance ?? 0);

    const sign = (claims: object) => jwt.sign(claims, CONFIG.JWT_SECRET_KEY, { expiresIn: '1h' });
    const tokens: Record<string, string> = {
      P: sign({ _id: P, pharmacyId: P, userType: 'pharmacy' }), Q: sign({ _id: Q, pharmacyId: Q, userType: 'pharmacy' }),
      W: sign({ _id: W, pharmacyId: W, userType: 'pharmacy' }), F: sign({ _id: F, pharmacyId: F, userType: 'pharmacy' }),
      X: sign({ _id: X, userType: 'user', authVersion: 0 }), ADMIN: sign({ _id: ADMIN, userType: 'admin' }),
    };
    const call = async (who: string | null, method: string, url: string, body?: unknown) => {
      const r = await fetch(base + url, { method, headers: { ...(who ? { authorization: `Bearer ${tokens[who] ?? who}` } : {}), 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      let json: any; try { json = JSON.parse(text); } catch { json = { text }; }
      return { status: r.status, json, text };
    };
    const expect = async (who: string | null, method: string, url: string, status: number, body?: unknown, errCode?: string) => {
      const r = await call(who, method, url, body);
      assert.equal(r.status, status, `${who} ${method} ${url}: ${r.status} ${r.text.slice(0, 400)}`);
      if (errCode) assert.equal(r.json.code, errCode, `${who} ${method} ${url}: ${r.text.slice(0, 400)}`);
      return r;
    };
    const PA = '/api/v1/pharmacy-assisted/instant';
    const order = (extra: Record<string, unknown> = {}) => ({
      requestKey: newKey(), phone: '9600000401', patient: { relation: 'self', name: 'Rina D' }, consent: { agreed: true, statementVersion: 'v1', statementLanguage: 'en' },
      preferredLanguage: 'kha', specialization: 'General Physician', mode: 'video', target: { kind: 'any' }, join: { on: 'partner_device' },
      acceptedQuoteMinor: 50000, acceptedPayableMinor: 50000, paymentMethod: 'wallet', ...extra,
    });
    const create = async (who: string, body: Record<string, unknown>, status = 201) => (await expect(who, 'POST', `${PA}/requests`, status, body)).json.data;
    const stored = async (id: string) => await InstantRequestModel.findById(id).lean() as any;
    const entries = (id: string, kind: string) => PharmacyWalletTransactionModel.find({ operationKey: `assisted_instant:${id}:${kind}` }).lean();
    // Only the two general physicians we expect: other doctors of the speciality go offline between checks.
    const onlyOnline = async (...ids: string[]) => {
      for (const d of [cheap, dear, unverified]) if (!ids.includes(d)) await offline(d);
      for (const d of ids) await online(d);
    };

    // ───────────────────────── Switch, indexes, validation ─────────────────────────
    await check('switch off: discovery reads and new requests answer 503 ASSISTED_BOOKING_DISABLED (each switch alone); nothing is debited', async () => {
      for (const off of ['ASSISTED_INSTANT_ENABLED', 'ASSISTED_BOOKING_ENABLED_PHARMACY']) {
        flagsOn(); delete process.env[off];
        await expect('P', 'GET', `${PA}/specialities?mode=video`, 503, undefined, 'ASSISTED_BOOKING_DISABLED');
        await expect('P', 'GET', `${PA}/doctors?speciality=General%20Physician&mode=video`, 503, undefined, 'ASSISTED_BOOKING_DISABLED');
        await expect('P', 'GET', `${PA}/quote?speciality=General%20Physician&mode=video`, 503, undefined, 'ASSISTED_BOOKING_DISABLED');
        await expect('P', 'POST', `${PA}/requests`, 503, order(), 'ASSISTED_BOOKING_DISABLED');
      }
      flagsOn();
      assert.equal(await InstantRequestModel.countDocuments({}), 0);
      assert.equal(await balance(P), 1_000_000);
    });

    await check('index 503: without the unique assisted.requestKey index a create answers 503 INDEXES_OUTDATED and nothing is written', async () => {
      const col = mongoose.connection.collection('instant_requests');
      await col.dropIndex('assisted.requestKey_1');
      resetIndexChecks();
      try {
        await expect('P', 'POST', `${PA}/requests`, 503, order(), 'INDEXES_OUTDATED');
      } finally {
        await col.createIndex({ 'assisted.requestKey': 1 }, { unique: true, partialFilterExpression: { 'assisted.requestKey': { $type: 'string' } } });
        resetIndexChecks();
      }
      assert.equal(await InstantRequestModel.countDocuments({}), 0);
      assert.equal(await balance(P), 1_000_000);
    });

    await check('validation: card 400 PAYMENT_METHOD_UNAVAILABLE, chat 400, no consent 400, specific without doctor 400 DOCTOR_REQUIRED, wrong price 409 QUOTE_CHANGED', async () => {
      await onlyOnline(cheap, dear);
      await expect('P', 'POST', `${PA}/requests`, 400, order({ paymentMethod: 'razorpay' }), 'PAYMENT_METHOD_UNAVAILABLE');
      await expect('P', 'POST', `${PA}/requests`, 400, order({ mode: 'chat' }), 'VALIDATION_ERROR');
      await expect('P', 'POST', `${PA}/requests`, 400, order({ consent: { agreed: false, statementVersion: 'v1', statementLanguage: 'en' } }), 'CONSENT_REQUIRED');
      await expect('P', 'POST', `${PA}/requests`, 400, order({ target: { kind: 'specific' } }), 'DOCTOR_REQUIRED');
      const r = await expect('P', 'POST', `${PA}/requests`, 409, order({ acceptedQuoteMinor: 40000, acceptedPayableMinor: 40000 }), 'QUOTE_CHANGED');
      assert.equal(r.json.details?.quotedAmountMinor, 50000);
      await expect('P', 'POST', `${PA}/requests`, 409, order({ specialization: 'Cardiology' }), 'NO_DOCTOR_ONLINE');
      assert.equal(await InstantRequestModel.countDocuments({}), 0);
    });

    await check('discovery: specialities count only eligible online doctors; doctors list nearest first (pincode, city, fee) without the unverified one; quote', async () => {
      await onlyOnline(cheap, dear, unverified);
      const spec = (await expect('P', 'GET', `${PA}/specialities?mode=video`, 200)).json.data as any[];
      assert.equal(spec.find((x) => x.specialization === 'General Physician')?.onlineNow, 2);
      const docs = (await expect('Q', 'GET', `${PA}/doctors?speciality=General%20Physician&mode=video`, 200)).json.data as any[];
      assert.deepEqual(docs.map((d) => d.doctorId), [dear, cheap], 'Q (Aizawl 796001) sees Dr Dear first');
      assert.equal(docs[0].nearby, 'pincode');
      assert.ok(!docs.some((d) => d.doctorId === unverified));
      const docsP = (await expect('P', 'GET', `${PA}/doctors?speciality=General%20Physician&mode=video`, 200)).json.data as any[];
      assert.deepEqual(docsP.map((d) => d.doctorId), [cheap, dear]);
      const q = (await expect('P', 'GET', `${PA}/quote?speciality=General%20Physician&mode=video`, 200)).json.data;
      assert.deepEqual(q, { quotedAmountMinor: 50000, doctors: 2 });
      await offline(unverified);
    });

    // ───────────────────────── Create ─────────────────────────
    let firstId = '';
    let firstKey = '';
    await check('create: one debit = quote − coupon, offered/held, offers to eligible doctors only, the typed-name link, no patient-wallet movement', async () => {
      await onlyOnline(cheap, dear, unverified);
      const before = await balance(P);
      const body = order({ primaryConcern: 'Fever for two days' });
      firstKey = body.requestKey;
      const out = await create('P', body);
      firstId = out.request._id;
      assert.equal(out.replayed, false);
      assert.equal(out.newAccount, false);
      assert.deepEqual(out.funding, { method: 'wallet', amountMinor: 50000, state: 'held', walletEntryId: out.funding.walletEntryId });
      assert.equal(out.request.status, 'offered');
      assert.equal(out.request.money.paidMinor, 50000);
      assert.equal(out.request.patientName, 'Rina D');
      assert.ok(!('requestKey' in out.request.assisted) && !JSON.stringify(out.request).includes(firstKey), 'no keys in the booker view');
      const r = await stored(firstId);
      assert.equal(r.fundingState, 'held');
      assert.deepEqual(r.funding, { couponMinor: 0, walletMinor: 0, partnerMinor: 50000, gatewayMinor: 0, totalMinor: 50000 });
      assert.deepEqual([...r.offeredTo].sort(), [cheap, dear].sort(), 'the unverified doctor gets no offer');
      assert.equal(r.source, 'pharmacy_assisted');
      assert.equal(r.userId, X);
      assert.equal(r.paymentStatus, 'paid');
      assert.equal(await balance(P), before - 50000);
      assert.equal((await entries(firstId, 'debit')).length, 1);
      assert.equal(await customerBalance(X), 0);
      const link = await PharmacyCustomerModel.findOne({ pharmacyId: new Types.ObjectId(P), userId: new Types.ObjectId(X) }).lean() as any;
      assert.equal(link?.consent, 'patient_agreed');
      assert.ok(instantNotices.some((n) => n.userId === cheap && n.key.startsWith(`instant:${firstId}:offer:1`) && n.message.includes('Booked by Sharma Medicals')));
      assert.ok(!instantNotices.some((n) => n.userId === unverified));
    });

    await check('keys: same key + content → 200 replayed (no second debit); other content → 409; by-key used / unknown; abandoned → 409 REQUEST_ABANDONED', async () => {
      const body = { ...order(), requestKey: firstKey, primaryConcern: 'Fever for two days' };
      const again = await create('P', body, 200);
      assert.equal(again.replayed, true);
      assert.equal(again.request._id, firstId);
      assert.equal((await entries(firstId, 'debit')).length, 1);
      await expect('P', 'POST', `${PA}/requests`, 409, { ...body, mode: 'call' }, 'IDEMPOTENCY_KEY_REUSED');
      const used = (await expect('P', 'GET', `${PA}/requests/by-key/${firstKey}`, 200)).json.data;
      assert.equal(used.state, 'used');
      assert.equal(used.request._id, firstId);
      // The same key of ANOTHER pharmacy is a different key.
      assert.equal((await expect('Q', 'GET', `${PA}/requests/by-key/${firstKey}`, 200)).json.data.state, 'unknown');
      const k = newKey();
      assert.equal((await expect('P', 'POST', `${PA}/requests/by-key/${k}/abandon`, 200)).json.data.state, 'abandoned');
      await expect('P', 'POST', `${PA}/requests`, 409, order({ requestKey: k }), 'REQUEST_ABANDONED');
    });

    await check('race: 5 identical creates make one request and one debit', async () => {
      const body = order();
      const before = await balance(P);
      const rs = await Promise.all(Array.from({ length: 5 }, () => call('P', 'POST', `${PA}/requests`, body)));
      assert.ok(rs.every((r) => r.status === 201 || r.status === 200), rs.map((r) => `${r.status} ${r.text.slice(0, 120)}`).join(' | '));
      const ids = new Set(rs.map((r) => r.json.data.request._id));
      assert.equal(ids.size, 1);
      const [id] = [...ids] as string[];
      assert.equal((await entries(id!, 'debit')).length, 1);
      assert.equal(await balance(P), before - 50000);
      await svc.refundAsBooker(await stored(id!), (await stored(id!)).statusVersion, async () => undefined);
    });

    await check('race: two creates beyond the balance — one is 409 INSUFFICIENT_BALANCE, the other is held; nothing else moves', async () => {
      await onlyOnline(cheap);
      const a = order({ acceptedQuoteMinor: 30000, acceptedPayableMinor: 30000 });
      const b = order({ acceptedQuoteMinor: 30000, acceptedPayableMinor: 30000, phone: nextPhone(), patient: { relation: 'self', name: 'Walk In' } });
      const rs = await Promise.all([call('W', 'POST', `${PA}/requests`, a), call('W', 'POST', `${PA}/requests`, b)]);
      assert.deepEqual(rs.map((r) => r.status).sort(), [201, 409], rs.map((r) => r.text.slice(0, 160)).join(' | '));
      assert.equal(rs.find((r) => r.status === 409)!.json.code, 'INSUFFICIENT_BALANCE');
      assert.equal(await balance(W), 15_000);
      assert.equal(await InstantRequestModel.countDocuments({ 'assisted.bookedBy.id': W }), 1);
      // The refused number's account was never opened (the account opens only in the committed transaction).
      const refused = rs.find((r) => r.status === 409)!;
      const refusedPhone = refused === rs[0] ? a.phone : b.phone;
      if (refusedPhone !== '9600000401') assert.equal(await UserModel.countDocuments({ phone: refusedPhone }), 0);
      const held = rs.find((r) => r.status === 201)!.json.data.request;
      await svc.refundAsBooker(await stored(held._id), held.statusVersion, async () => undefined);
      assert.equal(await balance(W), 45_000);
    });

    // ───────────────────────── Accept ─────────────────────────
    let acceptedBookingId = '';
    await check('accept: the booking has source, the funding pointer, the frozen split, pharmacyId and the ledger; the quote difference comes back once', async () => {
      await onlyOnline(cheap, dear);
      const before = await balance(P);
      const out = await svc.accept(cheap, firstId);
      acceptedBookingId = String(out.booking._id);
      const b = await BookingModel.findById(acceptedBookingId).lean() as any;
      assert.equal(b.source, 'pharmacy_assisted');
      assert.deepEqual(b.assisted.funding, { instantRequestId: firstId });
      assert.equal(b.assisted.shortRef, (await stored(firstId)).assisted.shortRef);
      assert.equal(b.earningRule, 'provider_coupon_v2');
      assert.deepEqual(b.assisted.split, { listMinor: 30000, discountMinor: 0, baseMinor: 30000, cutMinor: 0, providerMinor: 30000, rule: 'provider_coupon_v2' });
      assert.equal(b.pharmacyId, P);
      assert.equal(b.settlementSystem, 'ledger');
      assert.equal(b.primaryConcern, 'Fever for two days');
      assert.equal(b.contactNo, '9600000401');
      const r = await stored(firstId);
      assert.equal(r.status, 'accepted');
      assert.equal(r.assisted.funding.state, 'allocated');
      assert.deepEqual(r.allocated, { couponMinor: 0, walletMinor: 0, partnerMinor: 30000, gatewayMinor: 0, totalMinor: 30000 });
      assert.equal(r.returned.partnerMinor, 20000);
      const back = await entries(firstId, 'quote_return');
      assert.equal(back.length, 1);
      assert.equal(back[0]!.amountPaise, 20000);
      assert.equal(await balance(P), before + 20000);
      assert.equal(await customerBalance(X), 0, 'never the patient wallet');
      assert.equal(r.walletFunding, undefined, 'no customer ledger on a partner request');
      // Accepting again (a lost answer) is the same booking; nothing moves again.
      const again = await svc.accept(cheap, firstId);
      assert.equal(again.replayed, true);
      assert.equal((await entries(firstId, 'quote_return')).length, 1);
      assert.ok(instantNotices.some((n) => n.userId === X && n.message.includes('Sharma Medicals booked an instant consultation')));
      assert.ok(assistedNotices.some((n) => n.audience === 'booker' && n.userId === P && n.message.includes(`Ref ${r.assisted.shortRef}`)));
      const view = (await expect('P', 'GET', `${PA}/requests/${firstId}`, 200)).json.data;
      assert.equal(view.acceptedDoctorName, 'Dr Cheap');
      assert.equal(view.bookingId, acceptedBookingId);
      assert.equal(view.money.returnedMinor, 20000);
      // The booking shows in the pharmacy's own list with the pointer to its request.
      const list = (await expect('P', 'GET', '/api/v1/pharmacy-bookings', 200)).json.data as any[];
      const mine = list.find((x) => x._id === acceptedBookingId);
      assert.equal(mine?.instantRequestId, firstId);
      assert.equal(mine?.payment, undefined);
      // The consultation is done: it earns once (checked below) and the doctor is free again.
      await bookings.update(acceptedBookingId, { status: 'completed' } as any);
    });

    await check('a percentage coupon is computed again on the fee: the redemption keeps that discount; the split takes it (provider-funded)', async () => {
      await onlyOnline(cheap, dear);
      await CouponModel.create({ code: 'TENOFF', discountType: 'percentage', discountValue: 10, maximumDiscountAmount: 1000, isActive: true,
        applicableTo: 'all', eligibleFor: 'all', startDate: '20200101', endDate: '20991231', currentUsageCount: 0 } as never);
      const out = await create('P', order({ couponCode: 'TENOFF', acceptedQuoteMinor: 50000, acceptedPayableMinor: 45000 }));
      const id = out.request._id;
      assert.equal(out.funding.amountMinor, 45000);
      assert.equal((await CouponRedemptionModel.findOne({ bookingKind: 'instant_request', bookingId: id }).lean() as any)?.discountMinor, 5000);
      const accepted = await svc.accept(cheap, id);
      const red = await CouponRedemptionModel.findOne({ bookingKind: 'instant_request', bookingId: id }).lean() as any;
      assert.equal(red.state, 'counted');
      assert.equal(red.discountMinor, 3000, '10 % of the 300-rupee fee');
      const r = await stored(id);
      assert.deepEqual(r.allocated, { couponMinor: 3000, walletMinor: 0, partnerMinor: 27000, gatewayMinor: 0, totalMinor: 30000 });
      assert.equal(r.returned.partnerMinor, 18000);
      const b = await BookingModel.findById(accepted.booking._id).lean() as any;
      assert.deepEqual(b.assisted.split, { listMinor: 30000, couponCode: 'TENOFF', couponFundedBy: 'provider', discountMinor: 3000, baseMinor: 27000, cutMinor: 0,
        providerMinor: 27000, rule: 'provider_coupon_v2' });
      await svc.cancelAccepted(String(accepted.booking._id), { _id: cheap, userType: 'specialist' }, 'Clean up');
    });

    await check('race: two doctors accept at once — one booking and one quote return', async () => {
      await onlyOnline(cheap, dear);
      const id = (await create('P', order())).request._id;
      const rs = await Promise.allSettled([svc.accept(cheap, id), svc.accept(dear, id)]);
      assert.equal(rs.filter((x) => x.status === 'fulfilled').length, 1);
      assert.equal(await BookingModel.countDocuments({ instantRequestId: id }), 1);
      assert.ok((await entries(id, 'quote_return')).length <= 1);
      const r = await stored(id);
      const won = (rs.find((x) => x.status === 'fulfilled') as PromiseFulfilledResult<any>).value;
      await svc.cancelAccepted(String(won.booking._id), { _id: r.acceptedBy, userType: 'specialist' }, 'Clean up');
    });

    await check('race: accept against the booker refund, and against the inactivity sweep — one outcome, the money moves once', async () => {
      for (const rival of ['refund', 'sweep'] as const) {
        await onlyOnline(cheap);
        const before = await balance(P);
        const created = (await create('P', order({ acceptedQuoteMinor: 30000, acceptedPayableMinor: 30000 }))).request;
        const id = created._id;
        if (rival === 'sweep') await InstantRequestModel.updateOne({ _id: id }, { $set: { inactivityRefundAt: new Date(Date.now() - MIN) } });
        const other = rival === 'refund'
          ? call('P', 'POST', `${PA}/requests/${id}/refund`, { expectedStatusVersion: created.statusVersion })
          : svc.refundInactive(new Date());
        const [acc] = await Promise.allSettled([svc.accept(cheap, id), other]);
        const r = await stored(id);
        if (r.status === 'accepted') {
          assert.equal(acc.status, 'fulfilled');
          assert.equal((await entries(id, 'refund')).length, 0);
          assert.equal(await balance(P), before - 30000);
          await svc.cancelAccepted(String(r.bookingId), { _id: cheap, userType: 'specialist' }, 'Clean up');
        } else {
          assert.equal(r.status, 'refunded');
          assert.equal(await BookingModel.countDocuments({ instantRequestId: id }), 0);
          assert.equal((await entries(id, 'refund')).length, 1);
          assert.equal(await balance(P), before);
        }
      }
    });

    // ───────────────────────── Refunds and commands ─────────────────────────
    await check('booker activity moves the inactivity refund; the inactivity refund credits the partner once with its lots restored', async () => {
      await onlyOnline(cheap);
      const L = oid();
      await credit(F, 60_000, oid()); // a card top-up lot (withdrawable)
      const lotBefore = Number((await wallet(F)).withdrawableMinor ?? 0);
      // Spend most of F so the instant debit consumes the card lot first (oldest-first, D9) — here: the only lot.
      const created = (await create('F', order({ acceptedQuoteMinor: 30000, acceptedPayableMinor: 30000 }))).request;
      const id = created._id;
      void L;
      const afterDebit = Number((await wallet(F)).withdrawableMinor ?? 0);
      assert.equal(afterDebit, lotBefore - 30000, 'the debit consumed the lot');
      const at0 = new Date((await stored(id)).inactivityRefundAt).getTime();
      await new Promise((res) => setTimeout(res, 20));
      const v = (await expect('F', 'POST', `${PA}/requests/${id}/activity`, 200)).json.data;
      assert.ok(new Date(v.inactivityRefundAt).getTime() >= at0);
      // Not due yet: the sweep does nothing.
      assert.equal((await svc.refundInactive(new Date())).refunded, 0);
      await InstantRequestModel.updateOne({ _id: id }, { $set: { inactivityRefundAt: new Date(Date.now() - MIN) } });
      const before = await balance(F);
      assert.equal((await svc.refundInactive(new Date())).refunded, 1);
      assert.equal((await svc.refundInactive(new Date())).refunded, 0, 'once');
      const r = await stored(id);
      assert.equal(r.status, 'refunded');
      assert.equal(r.refundReason, 'inactivity');
      assert.equal(r.assisted.funding.state, 'refunded');
      assert.equal(await balance(F), before + 30000);
      assert.equal(Number((await wallet(F)).withdrawableMinor ?? 0), lotBefore, 'lots restored: withdrawable again (DR20)');
      await expect('F', 'POST', `${PA}/requests/${id}/activity`, 409, undefined, 'REQUEST_NOT_OPEN');
      await expect('F', 'POST', `${PA}/requests/${id}/refund`, 409, { expectedStatusVersion: r.statusVersion }, 'REQUEST_NOT_REFUNDABLE');
    });

    await check('booker refund: a stale version is 409 INSTANT_REQUEST_CHANGED; the right one refunds once; racing refunds move the money once', async () => {
      await onlyOnline(cheap);
      const created = (await create('P', order({ acceptedQuoteMinor: 30000, acceptedPayableMinor: 30000 }))).request;
      const id = created._id;
      await expect('P', 'POST', `${PA}/requests/${id}/refund`, 409, { expectedStatusVersion: created.statusVersion + 5 }, 'INSTANT_REQUEST_CHANGED');
      const before = await balance(P);
      const rs = await Promise.all(Array.from({ length: 4 }, () => call('P', 'POST', `${PA}/requests/${id}/refund`, { expectedStatusVersion: created.statusVersion })));
      assert.equal(rs.filter((x) => x.status === 200).length, 1, rs.map((x) => `${x.status} ${x.json.code ?? ''}`).join(' '));
      assert.equal(rs.find((x) => x.status === 200)!.json.data.refundedMinor, 30000);
      assert.equal((await entries(id, 'refund')).length, 1);
      assert.equal(await balance(P), before + 30000);
    });

    await check('re-offer: to a chosen online doctor (fenced by statusVersion), to any; offline doctor 409 DOCTOR_NOT_ONLINE', async () => {
      await onlyOnline(cheap);
      const created = (await create('P', order({ acceptedQuoteMinor: 30000, acceptedPayableMinor: 30000 }))).request;
      const id = created._id;
      await expect('P', 'POST', `${PA}/requests/${id}/reoffer`, 409, { target: { kind: 'specific', doctorId: dear }, expectedStatusVersion: created.statusVersion }, 'DOCTOR_NOT_ONLINE');
      await expect('P', 'POST', `${PA}/requests/${id}/reoffer`, 409, { target: { kind: 'any' }, expectedStatusVersion: created.statusVersion + 1 }, 'INSTANT_REQUEST_CHANGED');
      const v = (await expect('P', 'POST', `${PA}/requests/${id}/reoffer`, 200, { target: { kind: 'specific', doctorId: cheap }, expectedStatusVersion: created.statusVersion })).json.data;
      assert.equal(v.offerGeneration, 2);
      assert.equal(v.offeredCount, 1);
      await svc.refundAsBooker(await stored(id), v.statusVersion, async () => undefined);
    });

    let cancelId = '';
    await check('a doctor cancel after acceptance refunds the allocation to the partner once; the patient wallet is untouched; the redemption is reversed', async () => {
      await onlyOnline(cheap);
      await CouponModel.create({ code: 'FLAT50', discountType: 'fixed', discountValue: 50, isActive: true, applicableTo: 'all',
        eligibleFor: 'all', startDate: '20200101', endDate: '20991231', currentUsageCount: 0 } as never);
      const created = (await create('P', order({ couponCode: 'FLAT50', acceptedQuoteMinor: 30000, acceptedPayableMinor: 25000 }))).request;
      cancelId = created._id;
      const acc = await svc.accept(cheap, cancelId);
      const before = await balance(P);
      const rs = await Promise.allSettled([
        svc.cancelAccepted(String(acc.booking._id), { _id: cheap, userType: 'specialist' }, 'Doctor unwell'),
        svc.cancelAccepted(String(acc.booking._id), { _id: ADMIN, userType: 'admin' }, 'Closed by the team'),
      ]);
      assert.equal(rs.filter((x) => x.status === 'fulfilled').length, 1);
      const back = await entries(cancelId, 'cancel_refund');
      assert.equal(back.length, 1);
      assert.equal(back[0]!.amountPaise, 25000);
      assert.equal(await balance(P), before + 25000);
      assert.equal(await customerBalance(X), 0);
      const red = await CouponRedemptionModel.findOne({ bookingKind: 'instant_request', bookingId: cancelId }).lean() as any;
      assert.equal(red.state, 'reversed');
      const b = await BookingModel.findById(acc.booking._id).lean() as any;
      assert.equal(b.status, 'cancelled');
      assert.equal(b.assisted.join.linkVersion, 2, 'the join link dies');
      const r = await stored(cancelId);
      assert.equal(r.refunded.partnerMinor, 25000);
      assert.equal(r.assisted.funding.state, 'refunded');
    });

    await check('the patient cannot pay, re-offer, refund or send activity on a partner-paid request (409 PARTNER_PAID_BOOKING); reads show paidBy, no money', async () => {
      await onlyOnline(cheap);
      const id = (await create('P', order({ acceptedQuoteMinor: 30000, acceptedPayableMinor: 30000 }))).request._id;
      await expect('X', 'POST', `/api/v1/instant/requests/${id}/pay`, 409, { useWalletBalance: true }, 'PARTNER_PAID_BOOKING');
      await expect('X', 'POST', `/api/v1/instant/requests/${id}/reoffer`, 409, { target: { kind: 'any' } }, 'PARTNER_PAID_BOOKING');
      await expect('X', 'POST', `/api/v1/instant/requests/${id}/refund`, 409, undefined, 'PARTNER_PAID_BOOKING');
      await expect('X', 'POST', `/api/v1/instant/requests/${id}/activity`, 409, undefined, 'PARTNER_PAID_BOOKING');
      const mine = (await expect('X', 'GET', `/api/v1/instant/requests/${id}`, 200)).json.data;
      assert.equal(mine.paidBy, 'Sharma Medicals');
      for (const k of ['quotedAmountMinor', 'discountMinor', 'funding', 'allocated', 'returned', 'refunded', 'acceptedFeeMinor', 'couponTerms', 'offerFees']) {
        assert.ok(!(k in mine), `no ${k}`);
      }
      assert.ok(!('funding' in mine.assisted) && !('requestKey' in mine.assisted) && !('requestHash' in mine.assisted));
      const list = (await expect('X', 'GET', '/api/v1/instant/requests', 200)).json.data;
      const row = (list.items ?? list).find((x: any) => x._id === id);
      assert.equal(row.paidBy, 'Sharma Medicals');
      assert.ok(!('quotedAmountMinor' in row));
      await svc.refundAsBooker(await stored(id), (await stored(id)).statusVersion, async () => undefined);
    });

    await check('refunds always post: a frozen and an inactive booker wallet still get the refund', async () => {
      await onlyOnline(cheap);
      for (const state of [{ frozen: true }, { isActive: false }]) {
        const created = (await create('F', order({ acceptedQuoteMinor: 30000, acceptedPayableMinor: 30000 }))).request;
        await PharmacyWalletModel.updateOne({ pharmacyId: F }, { $set: state });
        const before = await balance(F);
        await expect('F', 'POST', `${PA}/requests/${created._id}/refund`, 200, { expectedStatusVersion: created.statusVersion });
        assert.equal(await balance(F), before + 30000);
        await PharmacyWalletModel.updateOne({ pharmacyId: F }, { $set: { frozen: false, isActive: true } });
      }
    });

    // ───────────────────────── Doctors and earnings ─────────────────────────
    await check('an unverified doctor gets no offer and its accept is 403; a specific unverified doctor cannot be quoted', async () => {
      await onlyOnline(cheap, unverified);
      const created = (await create('P', order({ acceptedQuoteMinor: 30000, acceptedPayableMinor: 30000 }))).request;
      const r = await stored(created._id);
      assert.ok(!r.offeredTo.includes(unverified));
      // Even if it had been offered (made eligible later, then unverified): the accept re-reads the doctor.
      await InstantRequestModel.updateOne({ _id: created._id }, { $addToSet: { offeredTo: unverified } });
      await assert.rejects(() => svc.accept(unverified, created._id), code('SPECIALIST_NOT_ACTIVE'));
      await expect('P', 'POST', `${PA}/requests`, 409, order({ target: { kind: 'specific', doctorId: unverified }, acceptedQuoteMinor: 20000, acceptedPayableMinor: 20000 }),
        'DOCTOR_NOT_ONLINE');
      await svc.refundAsBooker(await stored(created._id), (await stored(created._id)).statusVersion, async () => undefined);
      await offline(unverified);
    });

    await check('completion earns split.providerMinor once; a no-show earns nothing and returns nothing', async () => {
      const e = () => LedgerEntryModel.find({ source: 'consultation', sourceId: { $in: [acceptedBookingId] }, kind: 'earning' }).lean();
      assert.deepEqual((await e()).map((x) => x.amountMinor), [30000]);
      await bookings.update(acceptedBookingId, { status: 'completed' } as any).catch(() => undefined);
      assert.equal((await e()).length, 1, 'once');
      await onlyOnline(dear);
      const id = (await create('P', order())).request._id;
      const acc = await svc.accept(dear, id);
      const before = await balance(P);
      await bookings.markNoShow(String(acc.booking._id), { _id: ADMIN, userType: 'admin' }, new Date(Date.now() + 20 * MIN));
      assert.equal(await LedgerEntryModel.countDocuments({ source: 'consultation', sourceId: String(acc.booking._id), kind: 'earning' }), 0);
      assert.equal(await balance(P), before);
      assert.equal((await entries(id, 'cancel_refund')).length, 0);
    });

    // ───────────────────────── Scope ─────────────────────────
    await check('scope: another pharmacy, a customer\'s own request and an unknown id all get the one 404', async () => {
      await expect('Q', 'GET', `${PA}/requests/${firstId}`, 404, undefined, 'INSTANT_REQUEST_NOT_FOUND');
      await expect('Q', 'POST', `${PA}/requests/${firstId}/refund`, 404, { expectedStatusVersion: 1 }, 'INSTANT_REQUEST_NOT_FOUND');
      await expect('Q', 'POST', `${PA}/requests/${firstId}/reoffer`, 404, { target: { kind: 'any' }, expectedStatusVersion: 1 }, 'INSTANT_REQUEST_NOT_FOUND');
      await expect('Q', 'POST', `${PA}/requests/${firstId}/activity`, 404, undefined, 'INSTANT_REQUEST_NOT_FOUND');
      await expect('P', 'GET', `${PA}/requests/${oid()}`, 404, undefined, 'INSTANT_REQUEST_NOT_FOUND');
      await onlyOnline(cheap);
      await WalletModel.updateOne({ userId: X }, { $set: { balance: 1000 } });
      const own = await svc.create(X, { target: { kind: 'any' }, specialization: 'General Physician', mode: 'video', patient: { kind: 'self' },
        requestKey: newKey(), useWalletBalance: true } as never);
      const ownId = String((own.request as any)._id);
      await expect('P', 'GET', `${PA}/requests/${ownId}`, 404, undefined, 'INSTANT_REQUEST_NOT_FOUND');
      const qList = (await expect('Q', 'GET', `${PA}/requests`, 200)).json.data as any[];
      assert.equal(qList.length, 0);
      const pList = await expect('P', 'GET', `${PA}/requests?limit=2`, 200);
      assert.equal(pList.json.data.length, 2);
      assert.ok(pList.json.pagination.nextCursor);
      const page2 = await expect('P', 'GET', `${PA}/requests?limit=2&cursor=${pList.json.pagination.nextCursor}`, 200);
      assert.ok(page2.json.data.every((x: any) => !pList.json.data.some((y: any) => y._id === x._id)));
      await svc.requestRefund(X, ownId);
    });

    await check('family member: a new one is created in the transaction with the typed name; the doctor\'s offer shows that name and the identity note', async () => {
      await onlyOnline(cheap);
      const created = (await create('P', order({ patient: { relation: 'Son', name: 'Arun Das' }, holderName: 'Rina Das', acceptedQuoteMinor: 30000, acceptedPayableMinor: 30000 }))).request;
      const r = await stored(created._id);
      assert.equal(r.patient.kind, 'dependent');
      assert.equal(r.patient.name, 'Arun Das');
      assert.ok(await DependentModel.exists({ _id: r.patient.dependentId, userId: X, name: 'Arun Das' }));
      const offers = await svc.myOffers(cheap);
      const mine = offers.find((o) => o.requestId === created._id) as any;
      assert.equal(mine.patient.name, 'Arun Das');
      assert.equal(mine.bookedBy?.name, 'Sharma Medicals');
      assert.equal(mine.identityNote, 'Identity attested by the partner, not verified');
      assert.equal(mine.source, 'pharmacy_assisted');
      // An existing family member by id keeps its own name.
      const byId = (await create('P', order({ patient: { dependentId: depX }, acceptedQuoteMinor: 30000, acceptedPayableMinor: 30000 }))).request;
      assert.equal(byId.patientName, 'Mina Das');
      for (const id of [created._id, byId._id]) await svc.refundAsBooker(await stored(id), (await stored(id)).statusVersion, async () => undefined);
    });

    // ───────────────────────── Reconciliation ─────────────────────────
    await check('reconciliation: instantChecks are clean; a tampered request is flagged; stuck offered requests are listed', async () => {
      const report = await runReconciliation(new Date(), { full: true });
      const instantMismatches = report.checks.mismatches.filter((m: any) => String(m.check).startsWith('instant_') || m.check === 'split_sum' || m.check === 'provider_earning');
      assert.deepEqual(instantMismatches, []);
      assert.ok(report.checks.instantRequests.checked > 5);
      await InstantRequestModel.updateOne({ _id: firstId }, { $set: { 'returned.partnerMinor': 19999 } });
      const flagged = await runReconciliation(new Date(), { full: true });
      assert.ok(flagged.checks.mismatches.some((m: any) => m.check === 'instant_quote_return' && m.ref === firstId));
      await InstantRequestModel.updateOne({ _id: firstId }, { $set: { 'returned.partnerMinor': 20000 } });
      await onlyOnline(cheap);
      const created = (await create('P', order({ acceptedQuoteMinor: 30000, acceptedPayableMinor: 30000 }))).request;
      await InstantRequestModel.updateOne({ _id: created._id }, { $set: { inactivityRefundAt: new Date(Date.now() - 2 * 3_600_000) } });
      const stuck = (await runReconciliation(new Date(), { full: true })).stuck as any;
      assert.ok(stuck.instantOfferedPastRefund.some((x: any) => x.requestId === created._id));
      await svc.refundAsBooker(await stored(created._id), (await stored(created._id)).statusVersion, async () => undefined);
    });

    await check('allocateFunding: a customer split keeps its shape; a partner split adds up for every fee', async () => {
      assert.deepEqual(allocateFunding({ couponMinor: 0, walletMinor: 100, gatewayMinor: 200, totalMinor: 300 }, 250).allocated,
        { couponMinor: 0, walletMinor: 100, gatewayMinor: 150, totalMinor: 250 });
      const f = { couponMinor: 5000, walletMinor: 0, partnerMinor: 45000, gatewayMinor: 0, totalMinor: 50000 };
      for (let fee = 0; fee <= 50000; fee += 2500) {
        const x = allocateFunding(f, fee, Math.min(5000, Math.round(fee / 10)));
        assert.equal(x.allocated.totalMinor + x.returned.totalMinor, f.totalMinor);
        assert.equal((x.allocated.partnerMinor ?? 0) + (x.returned.partnerMinor ?? 0), 45000);
      }
    });
  } finally {
    server.close();
    await mongoose.disconnect();
  }
  console.log(`\n${passed} passed, ${failed.length} failed`);
  if (failed.length) { console.log('Failed:\n - ' + failed.join('\n - ')); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
