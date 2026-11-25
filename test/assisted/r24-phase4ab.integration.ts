/**
 * Phase 4a + 4b (ASSISTED_BOOKING_DESIGN.md §26.5–§26.6): referral rules (admin writes fenced by version, history,
 * partner reads), the cut snapshotted at create (instant: at accept, on the fee), coupon first then the cut, the
 * switches (master off, doctor cuts off), the cut posted at completion out of the provider's earning — once, under
 * racing completions and a completion racing a cancel — never on a no-show or a cancel, a rule edit racing a create,
 * referral payouts refused (O1), the pharmacy's referral reads and statements (short refs, no patient names), and
 * reconciliation. Lab lines are checked at the snapshot and posting functions (the HTTP lab flow is the 2a suite's).
 *
 * Every check runs even when an earlier one fails (the run exits 1 if any failed).
 *
 * Run (throwaway DB only; the script drops its database):
 *   JWT_SECRET_KEY=local-integration-only SESSION_ORIGINS_CUSTOMER=https://app.jansetu.test SESSION_ORIGINS_WORKSPACE=https://staff.jansetu.test \
 *     MONGODB_URL='mongodb://127.0.0.1:27917/r24_phase4ab_check?directConnection=true' npx tsx test/assisted/r24-phase4ab.integration.ts
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
import SpecialistModel from '@/modules/specialists/model';
import SlotModel from '@/modules/slots/model';
import BookingModel from '@/modules/bookings/model';
import { BookingRepository } from '@/modules/bookings/repository';
import { BookingService } from '@/modules/bookings/services';
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
import { postPharmacyMovementIn } from '@/modules/pharmacyWallet/ledger';
import { BannerService } from '@/modules/banners/services';
import { BannerRepository } from '@/modules/banners/repository';
import { LedgerEntryModel, SettlementAccountModel } from '@/modules/partners/model/settlement';
import { recordPayout, statementPage } from '@/modules/partners/services/finance';
import { DoctorPresenceModel } from '@/modules/doctors/model/instant';
import { InstantConsultService } from '@/modules/doctors/services/instant';
import { runLedgerTransaction } from '@/modules/common/utils/bookingWalletFunding';
import { setAssistedNotifier } from '@/modules/assisted/support';
import { runReconciliation } from '@/modules/assisted/reconciliation';
import { cutFor, labCategoryOf, postReferralEarningIn, snapshotCuts } from '@/modules/referralCuts/service';
import { ReferralRuleModel } from '@/modules/referralCuts/model';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/r24_phase4ab_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const oid = () => new Types.ObjectId().toHexString();
const MIN = 60_000;
const DAY = 86_400_000;

// ── Services (tsx emits no decorator metadata: wired by hand) ──
const payments = Object.assign(Object.create(PaymentService.prototype), {
  bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
  walletTransactionRepository: new WalletTransactionRepository(),
  getRazorpayClient: () => ({ orders: { fetchPayments: async () => ({ items: [] }) } }), getRazorpayCredentials: () => ({ keyId: 'k', keySecret: 's' }),
}) as unknown as PaymentService;
const instant = new InstantConsultService(payments, new CouponService(new CouponRepository()), new WalletRepository());
instant.notify = async () => undefined;
Container.set(InstantConsultService, instant);
Container.set(PaymentService, payments);
Container.set(PharmacyService, new PharmacyService(new PharmacyRepository(), new UserRepository()));
Container.set(BannerService, new BannerService(new BannerRepository()));
const bookings = Object.assign(Object.create(BookingService.prototype), {
  bookingRepository: new BookingRepository(), walletRepository: new WalletRepository(),
  bookingReminderScheduler: { clearBookingReminders: async () => undefined, scheduleBookingReminders: async () => undefined },
  notificationService: { create: async () => undefined, createSpecialistAppointmentCancelledNotification: async () => undefined },
}) as BookingService;
setAssistedNotifier(async () => undefined);

let passed = 0;
const failed: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log('ok -', name); } catch (e) { failed.push(name); console.log('FAIL -', name); console.error(e); }
}
let keySeq = 0;
const newKey = () => `r24-key-${String(++keySeq).padStart(4, '0')}-${oid().slice(-6)}`;
const istParts = (at: Date) => {
  const ist = new Date(at.getTime() + 330 * MIN).toISOString();
  return { date: `${ist.slice(0, 4)}${ist.slice(5, 7)}${ist.slice(8, 10)}`, time: ist.slice(11, 16) };
};

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
  process.env.ASSISTED_BOOKING_ENABLED_PHARMACY = 'true';
  process.env.ASSISTED_INSTANT_ENABLED = 'true';
  process.env.ASSISTED_ADMIN_TOOLS_ENABLED = 'true';
  const cutsOn = (on: boolean) => { if (on) process.env.REFERRAL_CUTS_ENABLED = 'true'; else delete process.env.REFERRAL_CUTS_ENABLED; };
  // New bookings settle by the ledger (their earnings post at completion).
  (CONFIG as any).SETTLEMENT_CUTOVER_AT = new Date(Date.now() - DAY).toISOString();

  try {
    // ── People ──
    const D = oid(); const INST = oid();
    await SpecialistModel.collection.insertMany([
      { _id: new Types.ObjectId(D), name: 'Dr Rao', phone: '9500000501', email: 'rao@x.test', specialization: 'General Physician', consultationFee: 500,
        isActive: true, isVerified: true },
      { _id: new Types.ObjectId(INST), name: 'Dr Now', phone: '9500000502', email: 'now@x.test', specialization: 'Dermatologist', consultationFee: 500,
        isActive: true, isVerified: true },
    ] as never);
    await instant.setPresence(INST, { available: true, modes: ['video', 'call'] });
    const P = oid(); const Q = oid();
    await PharmacyModel.collection.insertMany([
      { _id: new Types.ObjectId(P), name: 'Sharma Medicals', phone: '9700000501', city: 'Shillong', pincode: '793001', isActive: true, isVerified: true },
      { _id: new Types.ObjectId(Q), name: 'Other Pharmacy', phone: '9700000502', city: 'Aizawl', isActive: true, isVerified: true },
    ] as never);
    const X = oid(); const ADMIN = oid();
    await UserModel.collection.insertOne({ _id: new Types.ObjectId(X), userType: 'user', phone: '9600000501', name: 'Rina Kumari Das',
      createdSource: 'self_signup', otpVerified: true } as never);
    await WalletModel.create({ userId: X, balance: 0, isActive: true });
    for (const ph of [P, Q]) {
      await runLedgerTransaction((s) => postPharmacyMovementIn({ pharmacyId: ph, kind: 'credit', amountPaise: 5_000_000, operationKey: `seed:${oid()}`,
        referenceType: 'admin_topup', referenceId: oid(), description: 'seed' }, s));
    }
    const sign = (claims: object) => jwt.sign(claims, CONFIG.JWT_SECRET_KEY, { expiresIn: '1h' });
    const tokens: Record<string, string> = {
      P: sign({ _id: P, pharmacyId: P, userType: 'pharmacy' }), Q: sign({ _id: Q, pharmacyId: Q, userType: 'pharmacy' }),
      ADMIN: sign({ _id: ADMIN, userType: 'admin' }),
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
    const RULES = '/api/v1/admin/referral-rules';
    const PA = '/api/v1/pharmacy-assisted';
    let dayOffset = 0;
    const futureSlot = async () => {
      dayOffset += 1;
      const at = new Date(Date.now() + (4 + dayOffset) * DAY + 7 * 3600_000);
      const s = istParts(at); const e = istParts(new Date(at.getTime() + 15 * MIN));
      return String((await SlotModel.create({ specialistId: D, date: s.date, startTime: s.time, endTime: e.time, duration: 15, maxBookings: 1, currentBookings: 0,
        isActive: true, isAvailable: true, slotType: 'consultation' } as never))._id);
    };
    const consult = async (who: string, extra: Record<string, unknown> = {}) => (await expect(who, 'POST', `${PA}/consultations`, 201, {
      requestKey: newKey(), phone: '9600000501', patient: { relation: 'self', name: 'Rina D' }, consent: { agreed: true, statementVersion: 'v1', statementLanguage: 'en' },
      preferredLanguage: 'kha', slotId: await futureSlot(), consultationMode: 'video', join: { on: 'partner_device' }, acceptedPriceMinor: 50000,
      paymentMethod: 'wallet', ...extra })).json.data.booking;
    const stored = async (id: string) => await BookingModel.findById(id).lean() as any;
    // A scheduled consultation can be completed only after it starts (Q16a): the doctor completes it with a later clock.
    const complete = (id: string) => bookings.update(id, { status: 'completed' } as any, undefined, new Date(Date.now() + 30 * DAY));
    const ledger = (source: string, id: string) => LedgerEntryModel.find({ source, sourceId: id, kind: 'earning' }).lean() as Promise<any[]>;
    const rule = (category: string, body: Record<string, unknown>, who = 'ADMIN') => call(who, 'PUT', `${RULES}/pharmacy/${P}/${category}`, { isActive: true, reason: 'setup', ...body });
    const versionOf = async (category: string) => Number((await ReferralRuleModel.findOne({ bookerKind: 'pharmacy', bookerId: P, category }).lean() as any)?.version ?? 0);

    // ───────────────────────── 4a: rules ─────────────────────────
    await check('rules: admin creates (v1) and changes (v2) with history; stale 409 RECORD_CHANGED; bad terms 400; unknown booker 404; tools off 503', async () => {
      delete process.env.ASSISTED_ADMIN_TOOLS_ENABLED;
      assert.equal((await rule('consultation', { basis: 'percent', percentBasisPoints: 1000, expectedVersion: 0 })).json.code, 'ASSISTED_BOOKING_DISABLED');
      process.env.ASSISTED_ADMIN_TOOLS_ENABLED = 'true';
      const v1 = await rule('consultation', { basis: 'percent', percentBasisPoints: 500, expectedVersion: 0 });
      assert.equal(v1.status, 200, v1.text);
      assert.equal(v1.json.data.version, 1);
      assert.equal((await rule('consultation', { basis: 'percent', percentBasisPoints: 500, expectedVersion: 0 })).json.code, 'RECORD_CHANGED');
      const v2 = await rule('consultation', { basis: 'percent', percentBasisPoints: 1000, expectedVersion: 1 });
      assert.equal(v2.json.data.version, 2);
      assert.equal(v2.json.data.percentBasisPoints, 1000);
      assert.equal((await rule('consultation', { basis: 'percent', percentBasisPoints: 900, expectedVersion: 1 })).json.code, 'RECORD_CHANGED');
      assert.equal((await rule('consultation', { basis: 'percent', expectedVersion: 2 })).status, 400);
      assert.equal((await call('ADMIN', 'PUT', `${RULES}/pharmacy/${oid()}/consultation`, { basis: 'fixed', fixedMinor: 100, isActive: true, expectedVersion: 0,
        reason: 'x' })).json.code, 'BOOKER_NOT_FOUND');
      const events = (await expect('ADMIN', 'GET', `${RULES}/pharmacy/${P}/consultation/events`, 200)).json.data as any[];
      assert.deepEqual(events.map((e) => e.version), [2, 1]);
      assert.equal(events[0].before.percentBasisPoints, 500);
      assert.equal(events[0].after.percentBasisPoints, 1000);
    });

    await check('rules race: two edits at the same version — exactly one wins, one history row per version', async () => {
      const v = await versionOf('consultation');
      const rs = await Promise.all([1000, 1000].map((bp) => rule('consultation', { basis: 'percent', percentBasisPoints: bp, expectedVersion: v })));
      assert.deepEqual(rs.map((r) => r.status).sort(), [200, 409]);
      assert.equal(await versionOf('consultation'), v + 1);
    });

    await check('partner read: the pharmacy sees its rates read-only (effective follows the switch); another pharmacy sees none; it cannot write', async () => {
      cutsOn(false);
      const off = (await expect('P', 'GET', `${PA}/referral-rules`, 200)).json.data as any[];
      assert.equal(off.length, 1);
      assert.equal(off[0].effective, false);
      assert.ok(!('updatedBy' in off[0]));
      cutsOn(true);
      assert.equal((await expect('P', 'GET', `${PA}/referral-rules`, 200)).json.data[0].effective, true);
      assert.deepEqual((await expect('Q', 'GET', `${PA}/referral-rules`, 200)).json.data, []);
      assert.equal((await call('P', 'PUT', `${RULES}/pharmacy/${P}/consultation`, { basis: 'fixed', fixedMinor: 1, isActive: true, expectedVersion: 9, reason: 'x' })).status, 403);
    });

    await check('cutFor: percent floors, fixed per line, the cap, never above the base; provider + cut = base for 10 000 random lines', async () => {
      const ctx = { category: 'consultation' as const, bookerKind: 'pharmacy' as const, cutsOn: true, doctorCutsOn: false };
      assert.equal(cutFor(49999, { basis: 'percent', percentBasisPoints: 1000 }, ctx).cutMinor, 4999);
      assert.equal(cutFor(3000, { basis: 'fixed', fixedMinor: 4000 }, ctx).cutMinor, 3000);
      assert.equal(cutFor(100000, { basis: 'percent', percentBasisPoints: 5000, capMinor: 7000 }, ctx).cutMinor, 7000);
      assert.equal(cutFor(50000, { basis: 'percent', percentBasisPoints: 1000 }, { ...ctx, cutsOn: false }).disabledReason, 'cuts_off');
      assert.equal(cutFor(50000, { basis: 'percent', percentBasisPoints: 1000 }, { ...ctx, bookerKind: 'doctor' }).disabledReason, 'doctor_cuts_off');
      assert.equal(cutFor(50000, null, ctx).disabledReason, 'no_rule');
      assert.equal(cutFor(50000, { basis: 'fixed', fixedMinor: 10 }, { ...ctx, category: null }).disabledReason, 'category_not_cut');
      let seed = 7;
      const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
      for (let i = 0; i < 10_000; i++) {
        const b = rnd(500_000);
        const r = rnd(2) ? { basis: 'percent' as const, percentBasisPoints: 1 + rnd(5000), ...(rnd(2) ? { capMinor: 1 + rnd(50_000) } : {}) }
          : { basis: 'fixed' as const, fixedMinor: 1 + rnd(200_000), ...(rnd(2) ? { capMinor: 1 + rnd(50_000) } : {}) };
        const c = cutFor(b, r, ctx).cutMinor;
        assert.ok(Number.isInteger(c) && c >= 0 && c <= b, `cut ${c} of ${b}`);
      }
    });

    // ───────────────────────── 4a: the snapshot ─────────────────────────
    let firstId = '';
    await check('snapshot: switch off → cut 0 (cuts_off), no referral account; switch on → 10% out of the base, the pharmacy referral account opened once', async () => {
      cutsOn(false);
      const off = await stored((await consult('P'))._id);
      assert.equal(off.assisted.split.cutMinor, 0);
      assert.equal(off.assisted.split.providerMinor, 50000);
      assert.equal(off.assisted.split.referral, undefined, 'switch off: stored exactly as before phase 4 (no snapshot)');
      assert.equal(off.assisted.referral, null);
      assert.equal(await SettlementAccountModel.countDocuments({ ownerKind: 'pharmacy_referral' }), 0);
      cutsOn(true);
      const made = await Promise.all([consult('P'), consult('P'), consult('P')]);
      firstId = made[0]._id;
      const b = await stored(firstId);
      assert.equal(b.assisted.split.cutMinor, 5000);
      assert.equal(b.assisted.split.providerMinor, 45000);
      assert.equal(b.assisted.split.referral.category, 'consultation');
      assert.equal(b.assisted.split.referral.percentBasisPoints, 1000);
      assert.equal(b.assisted.split.referral.ruleVersion, await versionOf('consultation'));
      assert.equal(await SettlementAccountModel.countDocuments({ ownerKind: 'pharmacy_referral', ownerId: P }), 1);
      const account = await SettlementAccountModel.findOne({ ownerKind: 'pharmacy_referral', ownerId: P }).lean() as any;
      assert.deepEqual(b.assisted.referral, { accountId: String(account._id), ownerKind: 'pharmacy_referral', bookerKind: 'pharmacy', bookerId: P, cutMinor: 5000 });
      // Another pharmacy without rules: cut 0 (no_rule), no account.
      const other = await stored((await consult('Q'))._id);
      assert.equal(other.assisted.split.referral.disabledReason, 'no_rule');
      assert.equal(await SettlementAccountModel.countDocuments({ ownerKind: 'pharmacy_referral', ownerId: Q }), 0);
    });

    await check('coupon first, then the cut: provider-funded ₹100 → base 400, cut 40, doctor 360; platform-funded → base 500, cut 50, doctor 450', async () => {
      await CouponModel.create({ code: 'PROV100', discountType: 'fixed', discountValue: 100, applicableTo: 'all', eligibleFor: 'all', startDate: '20200101',
        endDate: '20991231', currentUsageCount: 0, isActive: true } as never);
      await CouponModel.create({ code: 'PLAT100', discountType: 'fixed', discountValue: 100, applicableTo: 'all', eligibleFor: 'all', startDate: '20200101',
        endDate: '20991231', currentUsageCount: 0, isActive: true, fundedBy: 'platform', partnerUsable: true } as never);
      const prov = await stored((await consult('P', { couponCode: 'PROV100', acceptedPriceMinor: 40000 }))._id);
      assert.deepEqual([prov.assisted.split.baseMinor, prov.assisted.split.cutMinor, prov.assisted.split.providerMinor], [40000, 4000, 36000]);
      const plat = await stored((await consult('P', { couponCode: 'PLAT100', acceptedPriceMinor: 40000 }))._id);
      assert.deepEqual([plat.assisted.split.baseMinor, plat.assisted.split.cutMinor, plat.assisted.split.providerMinor], [50000, 5000, 45000]);
    });

    await check('race: a rule edit racing a create — the booking snapshots one consistent version (10% at v, or 20% at v+1)', async () => {
      const v = await versionOf('consultation');
      const [created, edited] = await Promise.all([consult('P'), rule('consultation', { basis: 'percent', percentBasisPoints: 2000, expectedVersion: v })]);
      assert.equal(edited.status, 200);
      const b = await stored(created._id);
      const snap = b.assisted.split.referral;
      assert.ok((snap.ruleVersion === v && b.assisted.split.cutMinor === 5000) || (snap.ruleVersion === v + 1 && b.assisted.split.cutMinor === 10000),
        JSON.stringify(snap));
      // An edit after the booking never changes its stored cut.
      await rule('consultation', { basis: 'percent', percentBasisPoints: 1000, expectedVersion: v + 1 });
      assert.equal((await stored(created._id)).assisted.split.cutMinor, b.assisted.split.cutMinor);
    });

    // ───────────────────────── 4b: posting ─────────────────────────
    await check('completion posts the doctor (base − cut, commission = cut) and the pharmacy referral (the cut), once; racing completions post once', async () => {
      const id = firstId;
      const rs = await Promise.allSettled([complete(id), complete(id)]);
      assert.ok(rs.some((r) => r.status === 'fulfilled'), JSON.stringify(rs.map((r) => (r as any).reason?.code)));
      const doc = await ledger('consultation', id);
      assert.equal(doc.length, 1);
      assert.deepEqual([doc[0].amountMinor, doc[0].grossMinor, doc[0].commissionMinor], [45000, 50000, 5000]);
      const ref = await ledger('referral_consultation', id);
      assert.equal(ref.length, 1);
      assert.equal(ref[0].amountMinor, 5000);
      assert.equal(String(ref[0].settlementAccountId), (await stored(id)).assisted.referral.accountId);
    });

    await check('race: completion against the pharmacy cancel — one outcome; the cut posts only with a completion, the refund only with a cancel', async () => {
      for (let i = 0; i < 3; i++) {
        const id = (await consult('P'))._id;
        await Promise.allSettled([complete(id), call('P', 'POST', `${PA}/bookings/${id}/cancel`, { reason: 'test' })]);
        const b = await stored(id);
        const ref = await ledger('referral_consultation', id);
        if (b.status === 'completed') {
          assert.equal(ref.length, 1);
          assert.equal(b.assisted.funding.state, 'captured');
        } else {
          assert.equal(b.status, 'cancelled');
          assert.equal(ref.length, 0);
          assert.equal((await ledger('consultation', id)).length, 0);
          assert.equal(b.assisted.funding.state, 'refunded');
        }
      }
    });

    await check('a no-show posts nothing (no doctor earning, no cut)', async () => {
      const id = (await consult('P'))._id;
      const b = await stored(id);
      await BookingModel.updateOne({ _id: id }, { $set: { status: 'no_show' } });
      assert.equal((await ledger('referral_consultation', id)).length, 0);
      assert.equal((await ledger('consultation', id)).length, 0);
      assert.ok(b.assisted.split.cutMinor > 0);
    });

    await check('instant: the cut is snapshotted at accept on the fee charged, and posts at completion', async () => {
      await rule('consultation', { basis: 'fixed', fixedMinor: 3000, expectedVersion: await versionOf('consultation') });
      const created = (await expect('P', 'POST', `${PA}/instant/requests`, 201, {
        requestKey: newKey(), phone: '9600000501', patient: { relation: 'self', name: 'Rina D' }, consent: { agreed: true, statementVersion: 'v1', statementLanguage: 'en' },
        preferredLanguage: 'kha', specialization: 'Dermatologist', mode: 'video', target: { kind: 'any' }, join: { on: 'partner_device' },
        acceptedQuoteMinor: 50000, acceptedPayableMinor: 50000, paymentMethod: 'wallet' })).json.data.request;
      await DoctorPresenceModel.updateOne({ doctorId: INST }, { $set: { instantFeeMinor: 40000, lastSeenAt: new Date() } });
      const acc = await instant.accept(INST, created._id);
      const b = await stored(String(acc.booking._id));
      assert.deepEqual([b.assisted.split.listMinor, b.assisted.split.baseMinor, b.assisted.split.cutMinor, b.assisted.split.providerMinor], [40000, 40000, 3000, 37000]);
      assert.equal(b.assisted.referral.cutMinor, 3000);
      await bookings.update(String(acc.booking._id), { status: 'completed' } as any);
      assert.equal((await ledger('referral_consultation', String(acc.booking._id)))[0]?.amountMinor, 3000);
      assert.equal((await ledger('consultation', String(acc.booking._id)))[0]?.amountMinor, 37000);
    });

    await check('lab lines: tests and packages cut per line (5% and ₹40 fixed), other kinds never; doctor bookers stay 0 while doctor cuts are off', async () => {
      await rule('lab_test', { basis: 'percent', percentBasisPoints: 500, expectedVersion: 0 });
      await rule('lab_package', { basis: 'fixed', fixedMinor: 4000, expectedVersion: 0 });
      const lines = [{ category: labCategoryOf('test'), baseMinor: 30000 }, { category: labCategoryOf('package'), baseMinor: 80000 },
        { category: labCategoryOf('procedure'), baseMinor: 10000 }];
      const snap = await snapshotCuts({ kind: 'pharmacy', id: P, name: 'Sharma Medicals' }, lines);
      assert.deepEqual(snap.lines.map((l) => l!.cutMinor), [1500, 4000, 0]);
      assert.equal(snap.lines[2]!.disabledReason, 'category_not_cut');
      assert.equal(snap.totalCutMinor, 5500);
      // The §8.1 example: the lab earns 1 100 − 15 − 40 = ₹1 045 on the two lines; Sharma ₹55.
      assert.equal(30000 + 80000 - (1500 + 4000), 104500);
      const doctorSnap = await snapshotCuts({ kind: 'doctor', id: D, name: 'Dr Rao' }, lines);
      assert.equal(doctorSnap.totalCutMinor, 0);
      assert.equal(doctorSnap.lines[0]!.disabledReason, 'doctor_cuts_off');
      // Posting a lab booking's cut: once, whatever the retries.
      const labId = oid();
      const fake = { _id: labId, assisted: { referral: snap.referral, split: { baseMinor: 120000 } } };
      for (let i = 0; i < 2; i++) await runLedgerTransaction((s) => postReferralEarningIn(fake, 'referral_lab_booking', s, { by: 'system', byKind: 'system' }));
      const rows = await ledger('referral_lab_booking', labId);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].amountMinor, 5500);
    });

    // ───────────────────────── Reads, payouts, reconciliation ─────────────────────────
    await check('pharmacy reads: earned / paid / due and the statement (short refs, no patient name); the doctor statement shows base and cut', async () => {
      const sum = (await expect('P', 'GET', `${PA}/referral`, 200)).json.data;
      assert.equal(sum.payoutsEnabled, false);
      assert.equal(sum.paidMinor, 0);
      assert.ok(sum.earnedMinor >= 5000 + 3000 + 5500);
      assert.equal(sum.dueMinor, sum.earnedMinor);
      const st = await expect('P', 'GET', `${PA}/referral/statement?limit=50`, 200);
      const lines = st.json.data as any[];
      assert.ok(lines.some((l) => /^Referral · consultation · .* · Ref [A-Z2-7]{8}$/.test(l.description)), JSON.stringify(lines.map((l) => l.description)));
      assert.ok(!JSON.stringify(lines).includes('Rina'));
      // r33: the totals also report the cut switch.
      assert.deepEqual((await expect('Q', 'GET', `${PA}/referral`, 200)).json.data, { earnedMinor: 0, paidMinor: 0, dueMinor: 0, cutsEnabled: true, payoutsEnabled: false });
      const doctorAccount = await SettlementAccountModel.findOne({ ownerKind: 'doctor', ownerId: D }).lean() as any;
      const docLines = (await statementPage(doctorAccount, {})).lines;
      const row = docLines.find((l) => l.sourceId === firstId)!;
      assert.deepEqual([row.amountMinor, row.grossMinor, row.commissionMinor], [45000, 50000, 5000]);
    });

    await check('payouts from a referral account are refused while REFERRAL_PAYOUTS_ENABLED is off (O1)', async () => {
      const account = await SettlementAccountModel.findOne({ ownerKind: 'pharmacy_referral', ownerId: P }).lean() as any;
      await assert.rejects(() => recordPayout(ADMIN, String(account._id), { amountMinor: 1000, method: 'upi', reference: 'UTR12345', paidOn: '2026-11-01',
        detailsVersion: 1, requestKey: newKey() }), (e: any) => e?.code === 'REFERRAL_PAYOUTS_DISABLED');
      assert.equal(await LedgerEntryModel.countDocuments({ settlementAccountId: String(account._id), kind: 'payout' }), 0);
    });

    await check('reconciliation: clean; a missing referral earning on a completed booking is flagged referral_posted', async () => {
      const report = await runReconciliation(new Date(), { full: true });
      const ours = report.checks.mismatches.filter((m: any) => ['referral_posted', 'split_sum', 'provider_earning'].includes(m.check));
      assert.deepEqual(ours, []);
      await LedgerEntryModel.deleteOne({ source: 'referral_consultation', sourceId: firstId });
      const flagged = await runReconciliation(new Date(), { full: true });
      assert.ok(flagged.checks.mismatches.some((m: any) => m.check === 'referral_posted' && m.ref === firstId));
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
