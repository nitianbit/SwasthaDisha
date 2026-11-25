/**
 * Rounds 4e and 4f (ASSISTED_BOOKING_DESIGN.md §26.9, §26.10; build record §26.18).
 * 4e — referral payouts behind REFERRAL_PAYOUTS_ENABLED (off): refused while off; allowed when on to the HOME account's
 *   verified destination, version-fenced; an owed wallet amount paid from the referral earnings (paired once, racing
 *   requests never below zero, capped by both balances, by-key); statements show payouts; the admin accounts list filters
 *   the referral kinds and says payouts are paused.
 * 4f — finance reads: the pharmacy's `/finance` blocks and its statement (wallet rows as `transactionView`, the referral
 *   statement) with the one CSV; the lab's and doctor's `/finance` blocks; the admin disputes list, the top-ups credited
 *   without a lot, the withdrawal quote's reason; another owner's data never shows.
 * Real routes over HTTP (configureRoutes) on MongoDB.
 *
 * Run (throwaway DB only; the script drops its database):
 *   JWT_SECRET_KEY=local-integration-only SESSION_ORIGINS_CUSTOMER=https://app.jansetu.test SESSION_ORIGINS_WORKSPACE=https://staff.jansetu.test \
 *     MONGODB_URL='mongodb://127.0.0.1:27917/r35_phase4ef_check?directConnection=true' npx tsx test/assisted/r35-phase4ef.integration.ts
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
import { UserRepository } from '@/modules/user/repository';
import { BookingRepository } from '@/modules/bookings/repository';
import SpecialistModel from '@/modules/specialists/model';
import PaymentRecordModel from '@/modules/payment/model';
import { PaymentRepository } from '@/modules/payment/repository';
import { PaymentService } from '@/modules/payment/services';
import { WalletRepository, WalletTransactionRepository } from '@/modules/wallet/repository';
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
import { creditTopupIn, postMovementIn, walletTransaction, type TopupKind } from '@/modules/pharmacyWallet/walletCore';
import { BannerService } from '@/modules/banners/services';
import { BannerRepository } from '@/modules/banners/repository';
import { LedgerEntryModel } from '@/modules/partners/model/settlement';
import { PartnerRepository } from '@/modules/partners/repository';
import { MemberRepository } from '@/modules/partners/repository/member';
import { BranchRepository } from '@/modules/partners/repository/branch';
import { CatalogueItemRepository } from '@/modules/partners/repository/catalogueItem';
import { PartnerService } from '@/modules/partners/services';
import { CatalogueService } from '@/modules/partners/services/catalogue';
import { LabBookingService } from '@/modules/partners/services/labBookings';
import { ensureSettlementAccount, postLedgerEntry } from '@/modules/partners/services/settlement';
import { setPayoutDetails } from '@/modules/partners/services/finance';
import { doctorTopups, labTopups, partnerStore } from '@/modules/partnerWallets/ledger';
import { PartnerWalletModel } from '@/modules/partnerWallets/model';
import { runLedgerTransaction } from '@/modules/common/utils/bookingWalletFunding';
import { AssistedAuditEventModel } from '@/modules/assisted/model';
import { setAssistedNotifier } from '@/modules/assisted/support';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/r35_phase4ef_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const oid = () => new Types.ObjectId().toHexString();
const DAY = 86_400_000;
const IST = 330 * 60_000;
const noop = new Proxy({}, { get: () => async () => undefined });

const payments = Object.assign(Object.create(PaymentService.prototype), {
  bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
  walletTransactionRepository: new WalletTransactionRepository(), pharmacyWalletRepository: new PharmacyWalletRepository(),
  pharmacyWalletTransactionRepository: new PharmacyWalletTransactionRepository(), bookingReminderScheduler: noop,
  getRazorpayClient: () => ({ orders: { fetchPayments: async () => ({ items: [] }) } }), getRazorpayCredentials: () => ({ keyId: 'k', keySecret: 's' }),
}) as unknown as PaymentService;
const partnerSvc = new PartnerService(new PartnerRepository(), new MemberRepository(), new BranchRepository());
Container.set(PartnerService, partnerSvc);
Container.set(CatalogueService, new CatalogueService(new CatalogueItemRepository()));
Container.set(LabBookingService, new LabBookingService(payments, new CouponService(new CouponRepository()), new WalletRepository()));
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
let phoneSeq = 7350000000;
const nextPhone = () => String(phoneSeq++);
let keySeq = 0;
const newKey = () => `r35-key-${String(++keySeq).padStart(4, '0')}-${oid().slice(-6)}`;

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
  process.env.ASSISTED_BOOKING_ENABLED_PHARMACY = 'true';
  process.env.ASSISTED_ADMIN_TOOLS_ENABLED = 'true';
  delete process.env.REFERRAL_PAYOUTS_ENABLED;
  delete process.env.WALLET_WITHDRAWALS_ENABLED;

  try {
    const P = oid(); const P2 = oid(); const D = oid(); const ADMIN = oid();
    await PharmacyModel.collection.insertMany([
      { _id: new Types.ObjectId(P), name: 'Sharma Medicals', phone: '9700003501', city: 'Shillong', isActive: true, isVerified: true },
      { _id: new Types.ObjectId(P2), name: 'Other Pharmacy', phone: '9700003502', city: 'Shillong', isActive: true, isVerified: true },
    ] as never);
    await SpecialistModel.collection.insertOne({ _id: new Types.ObjectId(D), name: 'Dr Asha Menon', email: 'asha35@doc.test', specialization: 'General Physician',
      consultationFee: 500, isActive: true, isVerified: true } as never);
    const { partner, owner } = await partnerSvc.createPartner({
      kind: 'lab', name: 'Metro Labs', legalName: 'Metro Labs Pvt Ltd', contactPhone: nextPhone(), invoiceSeriesPrefix: 'ML',
      firstOwner: { phone: nextPhone(), name: 'Owner' }, taxRegime: 'regular', gstin: '29AABCM1234F1ZH',
    } as never);
    const L = String(partner._id);
    await partnerSvc.verifyPartner(L, 'admin');
    const sign = (claims: object) => jwt.sign(claims, CONFIG.JWT_SECRET_KEY, { expiresIn: '1h' });
    const tokens: Record<string, string> = {
      P: sign({ _id: P, pharmacyId: P, userType: 'pharmacy' }), P2: sign({ _id: P2, pharmacyId: P2, userType: 'pharmacy' }),
      D: sign({ _id: D, specialistId: D, userType: 'specialist' }), ADMIN: sign({ _id: ADMIN, userType: 'admin' }),
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
    const today = new Date(Date.now() + IST).toISOString().slice(0, 10);
    /** Referral earnings on the owner's referral account (as completion would post them). */
    const earnReferral = async (ownerKind: 'pharmacy_referral' | 'lab_referral' | 'doctor_referral', ownerId: string, amountMinor: number) => {
      const a = await ensureSettlementAccount(ownerKind, ownerId, 'Holder');
      await runLedgerTransaction((s) => postLedgerEntry({ settlementAccountId: String(a._id), kind: 'earning', amountMinor, grossMinor: amountMinor * 10,
        source: 'referral_consultation', sourceId: oid(), by: 'system', byKind: 'system' }, s));
      return String(a._id);
    };
    /** An account's destination set and verified by an admin; answers the version. */
    const verified = async (ownerKind: 'pharmacy_referral' | 'partner' | 'doctor', ownerId: string, accountNumber = '123456789012') => {
      const a = await ensureSettlementAccount(ownerKind, ownerId, 'Holder');
      const set = await setPayoutDetails({ accountId: String(a._id) }, { method: 'bank', accountName: 'Holder', accountNumber, ifsc: 'HDFC0001234', bankName: 'HDFC' },
        { kind: 'admin', id: ADMIN });
      await expect('ADMIN', 'POST', `/api/v1/settlements/accounts/${String(a._id)}/payout-details/verify`, 200, { version: set.payoutDetailsVersion });
      return { accountId: String(a._id), version: set.payoutDetailsVersion };
    };
    const payout = (accountId: string, detailsVersion: number, amountMinor: number) => call('ADMIN', 'POST', `/api/v1/settlements/accounts/${accountId}/payouts`,
      { amountMinor, method: 'bank_transfer', reference: `UTR${oid().slice(-10)}`, paidOn: today, detailsVersion, requestKey: newKey() });
    const KIND: Record<string, TopupKind> = { pharmacy: pharmacyTopups, lab: labTopups, doctor: doctorTopups };
    const FIELD: Record<string, string> = { pharmacy: 'payerPharmacyId', lab: 'payerPartnerId', doctor: 'payerSpecialistId' };
    const FLOW: Record<string, string> = { pharmacy: 'pharmacy_wallet_recharge', lab: 'lab_wallet_recharge', doctor: 'doctor_wallet_recharge' };
    /** A captured card top-up record; credited with a lot unless `lot: false` (then credited without one, as before phase 1a). */
    const cardTopup = async (walletKind: 'pharmacy' | 'lab' | 'doctor', ownerId: string, amountMinor: number, opts: { lot?: boolean; daysAgo?: number } = {}) => {
      const rec = await PaymentRecordModel.create({ userId: ownerId, payerUserId: ownerId, [FIELD[walletKind]!]: ownerId, context: 'wallet_recharge', contextId: `t_${oid()}`,
        baseAmount: amountMinor / 100, finalAmount: amountMinor / 100, baseAmountPaise: amountMinor, finalAmountPaise: amountMinor, discountAmount: 0,
        currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: `order_${oid()}`, razorpayPaymentId: `pay_${oid().slice(-14)}`, status: 'paid',
        isProcessed: false, paidAt: new Date(Date.now() - (opts.daysAgo ?? 8) * DAY), gatewayFeeMinor: 0, notes: { flow: FLOW[walletKind] } } as never);
      const id = String(rec._id);
      if (opts.lot === false) {
        const store = walletKind === 'pharmacy' ? pharmacyStore(ownerId) : partnerStore(walletKind, ownerId);
        await walletTransaction(async (s) => {
          await PaymentRecordModel.updateOne({ _id: id }, { $set: { walletCreditedAt: new Date() } }, { session: s });
          await postMovementIn(store, { kind: 'credit', amountMinor, operationKey: `wallet_recharge:${id}`, referenceType: 'wallet_recharge', referenceId: id,
            description: 'Recharge without a lot' }, s);
        });
      } else await walletTransaction((s) => creditTopupIn(KIND[walletKind]!, rec.toObject() as never, { lots: true }, s));
      return id;
    };

    // ───────────────────────── 4e ─────────────────────────
    await check('4e: a referral payout is refused while REFERRAL_PAYOUTS_ENABLED is off (409); partner payouts are unchanged', async () => {
      const acc = await earnReferral('pharmacy_referral', P, 50_000);
      const v = await verified('pharmacy_referral', P);
      assert.equal(v.accountId, acc);
      const r = await payout(acc, v.version, 10_000);
      assert.deepEqual([r.status, r.json.code], [409, 'REFERRAL_PAYOUTS_DISABLED']);
      // A lab's own (partner) account still pays out as before.
      const home = await verified('partner', L);
      await runLedgerTransaction((s) => postLedgerEntry({ settlementAccountId: home.accountId, kind: 'earning', amountMinor: 20_000, grossMinor: 20_000,
        source: 'partner_lab_booking', sourceId: oid(), by: 'system', byKind: 'system' }, s));
      assert.equal((await payout(home.accountId, home.version, 10_000)).status, 201);
    });

    await check('4e on: a lab\'s referral payout goes to its HOME (partner) destination, fenced on the home version; a pharmacy\'s referral account is its own home; statements show the payout', async () => {
      process.env.REFERRAL_PAYOUTS_ENABLED = 'true';
      try {
        const labRef = await earnReferral('lab_referral', L, 40_000);
        const home = await ensureSettlementAccount('partner', L, 'Metro');
        const homeVersion = (home as any).payoutDetailsVersion;
        // The referral account has no details of its own: its home's verified version decides.
        await expect('ADMIN', 'POST', `/api/v1/settlements/accounts/${labRef}/payouts`, 409, { amountMinor: 1000, method: 'upi', reference: 'UTR-R35-OLD', paidOn: today,
          detailsVersion: homeVersion + 1, requestKey: newKey() }, 'PAYOUT_DETAILS_CHANGED');
        const ok = await payout(labRef, homeVersion, 15_000);
        assert.equal(ok.status, 201, ok.text);
        assert.equal(ok.json.data.payout.destination.label, 'HDFC HDFC0001234 XXXX9012', 'the home account\'s destination');
        // The home changes its details: unverified now, so the referral payout waits.
        const changed = await setPayoutDetails({ accountId: String(home._id) }, { method: 'upi', upiId: 'metro@okbank' }, { kind: 'admin', id: ADMIN });
        await expect('ADMIN', 'POST', `/api/v1/settlements/accounts/${labRef}/payouts`, 409, { amountMinor: 1000, method: 'upi', reference: 'UTR-R35-UNV', paidOn: today,
          detailsVersion: changed.payoutDetailsVersion, requestKey: newKey() }, 'PAYOUT_DETAILS_NOT_VERIFIED');
        // The pharmacy's referral account is its own home.
        const acc = (await ensureSettlementAccount('pharmacy_referral', P, 'x')) as any;
        const p = await payout(String(acc._id), acc.payoutDetailsVersion, 10_000);
        assert.equal(p.status, 201, p.text);
        const st = (await expect('P', 'GET', '/api/v1/pharmacy-assisted/referral/statement', 200)).json.data;
        assert.ok(st.some((l: any) => l.kind === 'payout' && l.amountMinor === -10_000 && /^Payout · /.test(l.description)), JSON.stringify(st).slice(0, 300));
        const ls = (await expect('LAB', 'GET', '/api/v1/partner-workspace/assisted/referral/statement', 200)).json.data;
        assert.ok(ls.some((l: any) => l.kind === 'payout' && l.amountMinor === -15_000));
      } finally { delete process.env.REFERRAL_PAYOUTS_ENABLED; }
    });

    await check('4e set-off: off 409; on, paired once (referral −A, wallet receivable −A, balance unchanged), capped by both balances, by-key and abandon', async () => {
      const W = oid();
      await PharmacyModel.collection.insertOne({ _id: new Types.ObjectId(W), name: 'Owing Pharmacy', phone: '9700003503', isActive: true, isVerified: true } as never);
      await pharmacyStore(W).ensure();
      await PharmacyWalletModel.updateOne({ pharmacyId: W }, { $set: { receivableMinor: 30_000, frozen: true, frozenReason: 'dispute', balance: 0, balancePaise: 0, version: 0 } });
      const acc = await earnReferral('pharmacy_referral', W, 20_000);
      const url = `/api/v1/admin/wallets/pharmacy/${W}/receivable/setoff-from-referral`;
      await expect('ADMIN', 'POST', url, 409, { amountMinor: 10_000, requestKey: newKey() }, 'REFERRAL_PAYOUTS_DISABLED');
      process.env.REFERRAL_PAYOUTS_ENABLED = 'true';
      try {
        const over = await expect('ADMIN', 'POST', url, 409, { amountMinor: 25_000, requestKey: newKey() }, 'SETOFF_ABOVE_AVAILABLE');
        assert.equal(over.json.details.referralDueMinor, 20_000, 'above the referral balance');
        const key = newKey();
        const rs = await Promise.all([1, 2, 3].map(() => call('ADMIN', 'POST', url, { amountMinor: 12_000, requestKey: key })));
        assert.ok(rs.every((r) => r.status === 200 || r.status === 201), rs.map((r) => r.text.slice(0, 150)).join(' | '));
        assert.equal(rs.filter((r) => r.json.data.replayed === false).length, 1);
        const d = rs.find((r) => r.status === 201)!.json.data;
        assert.deepEqual([d.setoff.amountMinor, d.setoff.referralAccountId, d.wallet.receivableMinor, d.wallet.frozen], [12_000, acc, 18_000, true]);
        assert.equal(await LedgerEntryModel.countDocuments({ settlementAccountId: acc, source: 'receivable_setoff', kind: 'adjustment' }), 1);
        const we = await PharmacyWalletTransactionModel.find({ pharmacyId: W, transactionType: 'receivable_setoff' }).lean() as any[];
        assert.deepEqual(we.map((x) => [x.amountPaise, x.signedAmountPaise, x.receivableDeltaPaise]), [[12_000, 0, -12_000]]);
        assert.equal((await PharmacyWalletModel.findOne({ pharmacyId: W }).lean() as any).balancePaise, 0, 'the balance does not move');
        await expect('ADMIN', 'POST', url, 409, { amountMinor: 13_000, requestKey: key }, 'IDEMPOTENCY_KEY_REUSED');
        // Race: two set-offs that together pass the referral balance (8,000 left): one wins, nothing goes below zero.
        const race = await Promise.all([call('ADMIN', 'POST', url, { amountMinor: 6000, requestKey: newKey() }), call('ADMIN', 'POST', url, { amountMinor: 6000, requestKey: newKey() })]);
        assert.deepEqual(race.map((r) => r.status).sort(), [201, 409], race.map((r) => r.text.slice(0, 150)).join(' | '));
        const dueRow = (await expect('ADMIN', 'GET', `/api/v1/settlements/accounts/${acc}`, 200)).json.data;
        assert.equal(dueRow.balanceMinor, 2000);
        assert.equal((await PharmacyWalletModel.findOne({ pharmacyId: W }).lean() as any).receivableMinor, 12_000);
        // Above the receivable: refused.
        await earnReferral('pharmacy_referral', W, 50_000);
        const big = await expect('ADMIN', 'POST', url, 409, { amountMinor: 20_000, requestKey: newKey() }, 'SETOFF_ABOVE_AVAILABLE');
        assert.equal(big.json.details.receivableMinor, 12_000);
        assert.deepEqual((await expect('ADMIN', 'GET', `${url}/by-key/${key}`, 200)).json.data.state, 'used');
        const lost = newKey();
        assert.equal((await expect('ADMIN', 'POST', `${url}/by-key/${lost}/abandon`, 200)).json.data.state, 'abandoned');
        await expect('ADMIN', 'POST', url, 409, { amountMinor: 1000, requestKey: lost }, 'REQUEST_ABANDONED');
        assert.equal(await AssistedAuditEventModel.countDocuments({ orgId: W, action: 'wallet.referral_setoff' }), 2);
        const st = (await expect('ADMIN', 'GET', `/api/v1/settlements/accounts/${acc}/statement`, 200)).json.data.lines;
        assert.ok(st.some((l: any) => l.source === 'receivable_setoff' && l.description === 'Owed wallet amount paid from referral earnings'));
        await expect('ADMIN', 'POST', `/api/v1/admin/wallets/pharmacy/${oid()}/receivable/setoff-from-referral`, 404, { amountMinor: 100, requestKey: newKey() }, 'WALLET_NOT_FOUND');
      } finally { delete process.env.REFERRAL_PAYOUTS_ENABLED; }
    });

    await check('4e admin: the settlement accounts list filters the referral kinds (`referral` = all three) and says payouts are paused while off', async () => {
      await earnReferral('doctor_referral', D, 7000);
      const all = (await expect('ADMIN', 'GET', '/api/v1/settlements/accounts?ownerKind=referral&due=true', 200)).json.data;
      assert.ok(all.rows.length >= 3 && all.rows.every((r: any) => ['pharmacy_referral', 'lab_referral', 'doctor_referral'].includes(r.ownerKind) && r.payoutsPaused === true));
      const ph = (await expect('ADMIN', 'GET', '/api/v1/settlements/accounts?ownerKind=pharmacy_referral', 200)).json.data;
      assert.ok(ph.rows.length >= 2 && ph.rows.every((r: any) => r.ownerKind === 'pharmacy_referral'));
      const partners = (await expect('ADMIN', 'GET', '/api/v1/settlements/accounts?ownerKind=partner', 200)).json.data;
      assert.ok(partners.rows.every((r: any) => r.payoutsPaused === undefined), 'partner rows unchanged');
      process.env.REFERRAL_PAYOUTS_ENABLED = 'true';
      try { assert.ok((await expect('ADMIN', 'GET', '/api/v1/settlements/accounts?ownerKind=referral', 200)).json.data.rows.every((r: any) => r.payoutsPaused === false)); }
      finally { delete process.env.REFERRAL_PAYOUTS_ENABLED; }
    });

    // ───────────────────────── 4f ─────────────────────────
    await check('4f pharmacy GET /finance: wallet, referral, withdrawals and payout-details blocks (the form\'s details masked); another pharmacy sees its own', async () => {
      await cardTopup('pharmacy', P, 80_000);
      const f = (await expect('P', 'GET', '/api/v1/pharmacy-assisted/finance', 200)).json.data;
      assert.deepEqual(Object.keys(f).sort(), ['payoutDetails', 'referral', 'wallet', 'withdrawals']);
      assert.deepEqual(Object.keys(f.wallet).sort(), ['availableLater', 'balanceMinor', 'frozen', 'receivableMinor', 'withdrawableNowMinor']);
      assert.deepEqual([f.wallet.balanceMinor, f.wallet.withdrawableNowMinor, f.wallet.receivableMinor, f.wallet.frozen], [80_000, 80_000, 0, false]);
      assert.deepEqual(f.referral, { earnedMinor: 50_000, paidMinor: 10_000, dueMinor: 40_000, cutsEnabled: false, payoutsEnabled: false });
      assert.deepEqual(f.withdrawals, { openCount: 0, lastPaidAt: null, enabled: false });
      assert.deepEqual([f.payoutDetails.state, f.payoutDetails.masked, f.payoutDetails.detailsVersion], ['verified', 'HDFC HDFC0001234 XXXX9012', 1]);
      assert.deepEqual(f.payoutDetails.details, { method: 'bank', accountName: 'Holder', ifsc: 'HDFC0001234', bankName: 'HDFC', accountNumberLast4: '9012',
        accountNumberMasked: 'XXXX9012' });
      assert.ok(!JSON.stringify(f).includes('123456789012'), 'never the full account number');
      const other = (await expect('P2', 'GET', '/api/v1/pharmacy-assisted/finance', 200)).json.data;
      assert.deepEqual([other.wallet.balanceMinor, other.referral.earnedMinor, other.payoutDetails.state, other.payoutDetails.details], [0, 0, 'none', null]);
    });

    await check('4f pharmacy statement: kind=wallet rows as transactionView (newest first, cursor, from/to), kind=referral the referral statement; the one CSV for either', async () => {
      await walletTransaction((s) => postMovementIn(pharmacyStore(P), { kind: 'booking_debit', amountMinor: 30_000, operationKey: `spend:${oid()}`, referenceType: 'test',
        referenceId: oid(), description: 'Booking payment' }, s));
      const w = await expect('P', 'GET', '/api/v1/pharmacy-assisted/finance/statement?kind=wallet&limit=1', 200);
      assert.equal(w.json.data.length, 1);
      assert.deepEqual([w.json.data[0].transactionType, w.json.data[0].movementType, w.json.data[0].signedAmountPaise], ['debit', 'booking_debit', -30_000]);
      assert.ok(w.json.pagination.nextCursor);
      const next = await expect('P', 'GET', `/api/v1/pharmacy-assisted/finance/statement?kind=wallet&before=${w.json.pagination.nextCursor}`, 200);
      assert.deepEqual([next.json.data[0].transactionType, next.json.data[0].movementType], ['credit', 'credit']);
      assert.equal((await expect('P', 'GET', '/api/v1/pharmacy-assisted/finance/statement', 200)).json.data.length, 2, 'wallet is the default kind');
      assert.equal((await expect('P', 'GET', '/api/v1/pharmacy-assisted/finance/statement?kind=wallet&to=2020-01-01', 200)).json.data.length, 0);
      const ref = (await expect('P', 'GET', '/api/v1/pharmacy-assisted/finance/statement?kind=referral', 200)).json.data;
      assert.ok(ref.some((l: any) => l.kind === 'payout') && ref.some((l: any) => l.kind === 'earning'));
      const csv = await call('P', 'GET', '/api/v1/pharmacy-assisted/finance/statement.csv?kind=wallet');
      assert.equal(csv.status, 200);
      const lines = csv.text.trim().split('\n');
      assert.equal(lines[0], '"Date (IST)","Type","Description","Reference","Note","Amount (INR)","Balance (INR)"');
      assert.match(lines[1]!, /"Opening balance".*"0\.00"/);
      assert.match(lines[lines.length - 1]!, /"Closing balance".*"500\.00"/);
      const rcsv = await call('P', 'GET', '/api/v1/pharmacy-assisted/finance/statement.csv?kind=referral');
      assert.match(rcsv.text.trim().split('\n').pop()!, /"Closing balance".*"400\.00"/);
      assert.equal((await expect('P2', 'GET', '/api/v1/pharmacy-assisted/finance/statement?kind=wallet', 200)).json.data.length, 0, 'never another pharmacy\'s rows');
      await expect('P', 'GET', '/api/v1/pharmacy-assisted/finance/statement?kind=other', 400);
    });

    await check('4f lab /finance and doctor /me/finance add the referral and withdrawals blocks; the existing fields stay', async () => {
      const lab = (await expect('LAB', 'GET', '/api/v1/partner-workspace/finance', 200)).json.data;
      assert.ok('balanceMinor' in lab && 'totals' in lab && 'account' in lab, 'the existing summary');
      assert.deepEqual(lab.referral, { earnedMinor: 40_000, paidMinor: 15_000, dueMinor: 25_000, cutsEnabled: false, payoutsEnabled: false });
      assert.deepEqual(lab.withdrawals, { openCount: 0, lastPaidAt: null, enabled: false });
      const doc = (await expect('D', 'GET', '/api/v1/specialists/me/finance', 200)).json.data;
      assert.ok('balanceMinor' in doc && 'totals' in doc);
      assert.deepEqual([doc.referral.earnedMinor, doc.referral.dueMinor, doc.withdrawals.openCount], [7000, 7000, 0]);
      assert.ok([401, 403].includes((await call('P', 'GET', '/api/v1/partner-workspace/finance')).status), 'a pharmacy has no partner finance');
    });

    await check('4f admin disputes: flagged, recovered and blocked top-ups (state and wallet filters); top-ups credited without a lot are listed per wallet', async () => {
      process.env.WALLET_CHARGEBACK_FLAG_ONLY = 'true';
      try {
        const X1 = oid(); const X2 = oid();
        await PharmacyModel.collection.insertMany([{ _id: new Types.ObjectId(X1), name: 'D1', phone: nextPhone(), isActive: true, isVerified: true },
          { _id: new Types.ObjectId(X2), name: 'D2', phone: nextPhone(), isActive: true, isVerified: true }] as never);
        const flagged = await cardTopup('pharmacy', X1, 20_000);
        const recovered = await cardTopup('pharmacy', X2, 20_000);
        const lotless = await cardTopup('pharmacy', X2, 9000, { lot: false });
        await expect('ADMIN', 'POST', `/api/v1/admin/wallet-payments/${flagged}/chargeback`, 200, { reason: 'dispute lost' });
        await expect('ADMIN', 'POST', `/api/v1/admin/wallet-payments/${recovered}/chargeback`, 200, { reason: 'dispute lost' });
        await expect('ADMIN', 'POST', `/api/v1/admin/wallet-payments/${recovered}/recover`, 200, { reason: 'recover it now', requestKey: newKey() });
        const never = await PaymentRecordModel.create({ userId: X1, payerUserId: X1, payerPharmacyId: X1, context: 'wallet_recharge', contextId: `t_${oid()}`, baseAmount: 50,
          finalAmount: 50, baseAmountPaise: 5000, finalAmountPaise: 5000, discountAmount: 0, currency: 'INR', paymentGateway: 'razorpay', razorpayOrderId: `order_${oid()}`,
          status: 'paid', notes: { flow: 'pharmacy_wallet_recharge' } } as never);
        await expect('ADMIN', 'POST', `/api/v1/admin/wallet-payments/${String(never._id)}/chargeback`, 200, { reason: 'dispute lost early' });
        const rows = (await expect('ADMIN', 'GET', '/api/v1/admin/wallet-disputes', 200)).json.data;
        const byId = new Map(rows.map((r: any) => [r.paymentRecordId, r]));
        assert.deepEqual([(byId.get(flagged) as any).state, (byId.get(recovered) as any).state, (byId.get(String(never._id)) as any).state], ['flagged', 'recovered', 'blocked']);
        assert.deepEqual(Object.keys(byId.get(flagged) as object).sort(), ['amountMinor', 'at', 'chargebackAt', 'lotId', 'ownerId', 'paymentRecordId', 'recoveredAt',
          'remainingMinor', 'state', 'walletKind']);
        assert.ok((await expect('ADMIN', 'GET', '/api/v1/admin/wallet-disputes?state=recovered', 200)).json.data.every((r: any) => r.state === 'recovered'));
        assert.equal((await expect('ADMIN', 'GET', '/api/v1/admin/wallet-disputes?walletKind=lab', 200)).json.data.length, 0);
        const lots = (await expect('ADMIN', 'GET', `/api/v1/admin/wallets/pharmacy/${X2}/topups-without-lot`, 200)).json.data;
        assert.deepEqual(lots.map((r: any) => [r.paymentRecordId, r.amountMinor, r.walletKind, r.ownerId]), [[lotless, 9000, 'pharmacy', X2]]);
        assert.deepEqual(Object.keys(lots[0]).sort(), ['amountMinor', 'chargebackAt', 'creditedAt', 'ownerId', 'paidAt', 'paymentRecordId', 'razorpayPaymentId', 'walletKind']);
        assert.equal(await WalletTopupLotModel.countDocuments({ paymentRecordId: lotless }), 0);
        await expect('P', 'GET', '/api/v1/admin/wallet-disputes', 403);
      } finally { delete process.env.WALLET_CHARGEBACK_FLAG_ONLY; }
    });

    await check('4f withdrawal quote says why: WITHDRAWALS_DISABLED, DESTINATION_NOT_VERIFIED, BELOW_MINIMUM, ABOVE_WITHDRAWABLE, WEEKLY_LIMIT, else null', async () => {
      const q = async (who: string, amount: number) => (await expect(who, 'GET', `/api/v1/pharmacy-assisted/wallet/withdrawable?amountMinor=${amount}`, 200)).json.data.quote;
      assert.deepEqual([(await q('P', 60_000)).reason, (await q('P', 60_000)).available], ['WITHDRAWALS_DISABLED', false]);
      process.env.WALLET_WITHDRAWALS_ENABLED = 'true';
      try {
        assert.equal((await q('P2', 60_000)).reason, 'DESTINATION_NOT_VERIFIED');
        assert.equal((await q('P', 40_000)).reason, 'BELOW_MINIMUM');
        assert.equal((await q('P', 60_000)).reason, 'ABOVE_WITHDRAWABLE', 'only ₹500 of card money is left after the booking');
        const ok = await q('P', 50_000);
        assert.deepEqual([ok.reason, ok.available, ok.feeMinor], [null, true, 0]);
        const acc = (await ensureSettlementAccount('pharmacy_referral', P, 'x')) as any;
        await expect('P', 'POST', '/api/v1/pharmacy-assisted/wallet/withdrawals', 201, { amountMinor: 50_000, requestKey: newKey(), detailsVersion: acc.payoutDetailsVersion });
        assert.equal((await q('P', 50_000)).reason, 'WEEKLY_LIMIT');
        const f = (await expect('P', 'GET', '/api/v1/pharmacy-assisted/finance', 200)).json.data;
        assert.deepEqual([f.withdrawals.openCount, f.withdrawals.enabled], [1, true]);
      } finally { delete process.env.WALLET_WITHDRAWALS_ENABLED; }
    });

    // ───────────────────────── WQ29 withdrawal risks ─────────────────────────
    const freshPharmacy = async (fee = 0, amount = 100_000) => {
      const id = oid();
      await PharmacyModel.collection.insertOne({ _id: new Types.ObjectId(id), name: `Pharmacy ${id.slice(-4)}`, phone: nextPhone(), isActive: true, isVerified: true } as never);
      tokens[id] = sign({ _id: id, pharmacyId: id, userType: 'pharmacy' });
      const v = await verified('pharmacy_referral', id);
      const rid = await cardTopup('pharmacy', id, amount);
      await PaymentRecordModel.updateOne({ _id: rid }, { $set: { gatewayFeeMinor: fee } });
      await WalletTopupLotModel.updateOne({ paymentRecordId: rid }, { $set: { gatewayFeeMinor: fee } });
      return { id, version: v.version, rid, accountId: v.accountId };
    };

    await check('WQ29 fee fence: expectedTransferMinor that no longer matches → 409 WITHDRAWAL_QUOTE_CHANGED with the new quote; a match goes through and replays', async () => {
      process.env.WALLET_WITHDRAWALS_ENABLED = 'true';
      try {
        const ph = await freshPharmacy(2000);
        const r = await expect(ph.id, 'POST', '/api/v1/pharmacy-assisted/wallet/withdrawals', 409,
          { amountMinor: 60_000, requestKey: newKey(), detailsVersion: ph.version, expectedTransferMinor: 60_000 }, 'WITHDRAWAL_QUOTE_CHANGED');
        assert.deepEqual(r.json.details, { grossMinor: 60_000, feeMinor: 1200, transferMinor: 58_800 });
        const body = { amountMinor: 60_000, requestKey: newKey(), detailsVersion: ph.version, expectedTransferMinor: 58_800 };
        assert.equal((await expect(ph.id, 'POST', '/api/v1/pharmacy-assisted/wallet/withdrawals', 201, body)).json.data.withdrawal.transferMinor, 58_800);
        assert.equal((await expect(ph.id, 'POST', '/api/v1/pharmacy-assisted/wallet/withdrawals', 200, body)).json.data.replayed, true);
        await expect(ph.id, 'POST', '/api/v1/pharmacy-assisted/wallet/withdrawals', 409, { ...body, expectedTransferMinor: undefined }, 'IDEMPOTENCY_KEY_REUSED');
      } finally { delete process.env.WALLET_WITHDRAWALS_ENABLED; }
    });

    await check('WQ29 details lock: while a withdrawal is requested the payout details cannot change (owner and admin, 409 WITHDRAWAL_OPEN); after a cancel they can', async () => {
      const acc = (await ensureSettlementAccount('pharmacy_referral', P, 'x')) as any;
      await expect('P', 'PUT', '/api/v1/pharmacy-assisted/finance/payout-details', 409, { method: 'upi', upiId: 'shop@okbank' }, 'WITHDRAWAL_OPEN');
      await expect('ADMIN', 'PUT', `/api/v1/settlements/accounts/${String(acc._id)}/payout-details`, 409, { method: 'upi', upiId: 'shop@okbank' }, 'WITHDRAWAL_OPEN');
      const w = (await expect('P', 'GET', '/api/v1/pharmacy-assisted/wallet/withdrawals?state=requested', 200)).json.data[0];
      await expect('P', 'POST', `/api/v1/pharmacy-assisted/wallet/withdrawals/${w._id}/cancel`, 200, { expectedVersion: w.version });
      const put = await expect('P', 'PUT', '/api/v1/pharmacy-assisted/finance/payout-details', 200, { method: 'upi', upiId: 'shop@okbank' });
      assert.deepEqual([put.json.data.payoutDetailsState, put.json.data.payoutDetailsVersion], ['unverified', acc.payoutDetailsVersion + 1]);
      // The lab's own (partner) details are locked the same way while a lab withdrawal waits — covered by the shared check.
    });

    await check('WQ29 paid after a dispute: refused without acknowledgement; with disputeAcknowledged it is paid (audited), nothing taken twice, and Recover leaves the withdrawn money owed', async () => {
      process.env.WALLET_WITHDRAWALS_ENABLED = 'true';
      process.env.WALLET_CHARGEBACK_FLAG_ONLY = 'true';
      try {
        const ph = await freshPharmacy();
        const w = (await expect(ph.id, 'POST', '/api/v1/pharmacy-assisted/wallet/withdrawals', 201, { amountMinor: 60_000, requestKey: newKey(), detailsVersion: ph.version }))
          .json.data.withdrawal;
        await expect('ADMIN', 'POST', `/api/v1/admin/wallet-payments/${ph.rid}/chargeback`, 200, { reason: 'dispute lost after transfer' });
        const body = { method: 'bank_transfer', reference: `UTR${oid().slice(-10)}`, paidOn: today, detailsVersion: ph.version, expectedVersion: 0, requestKey: newKey() };
        await expect('ADMIN', 'POST', `/api/v1/admin/wallet-withdrawals/${w._id}/paid`, 409, body, 'WITHDRAWAL_LOT_DISPUTED');
        const paid = await expect('ADMIN', 'POST', `/api/v1/admin/wallet-withdrawals/${w._id}/paid`, 200, { ...body, disputeAcknowledged: true });
        assert.deepEqual([paid.json.data.withdrawal.state, paid.json.data.withdrawal.paid.disputeAcknowledged, paid.json.data.withdrawal.paid.disputedMinor], ['paid', true, 60_000]);
        const audit = await AssistedAuditEventModel.findOne({ orgId: ph.id, action: 'withdrawal.paid' }).lean() as any;
        assert.deepEqual([audit.detail.disputeAcknowledged, audit.detail.disputedMinor], [true, 60_000]);
        let wal = await PharmacyWalletModel.findOne({ pharmacyId: ph.id }).lean() as any;
        assert.deepEqual([wal.balancePaise, wal.receivableMinor ?? 0], [40_000, 0], 'paid moves nothing');
        // Recover the disputed top-up: the balance pays what it can; the withdrawn ₹600 is owed.
        await expect('ADMIN', 'POST', `/api/v1/admin/wallet-payments/${ph.rid}/recover`, 200, { reason: 'recover after the transfer', requestKey: newKey() });
        wal = await PharmacyWalletModel.findOne({ pharmacyId: ph.id }).lean() as any;
        assert.deepEqual([wal.balancePaise, wal.receivableMinor, wal.frozen], [0, 60_000, true]);
        assert.equal(await PharmacyWalletTransactionModel.countDocuments({ pharmacyId: ph.id, transactionType: 'chargeback' }), 1, 'taken once');
        const lot = await WalletTopupLotModel.findOne({ paymentRecordId: ph.rid }).lean() as any;
        assert.deepEqual([lot.closed, lot.remainingMinor], [true, 0]);
        // The owed amount can then be paid from referral earnings (set-off).
        await earnReferral('pharmacy_referral', ph.id, 60_000);
        process.env.REFERRAL_PAYOUTS_ENABLED = 'true';
        try {
          const so = await expect('ADMIN', 'POST', `/api/v1/admin/wallets/pharmacy/${ph.id}/receivable/setoff-from-referral`, 201, { amountMinor: 60_000, requestKey: newKey() });
          assert.equal(so.json.data.wallet.receivableMinor, 0);
        } finally { delete process.env.REFERRAL_PAYOUTS_ENABLED; }
      } finally { delete process.env.WALLET_WITHDRAWALS_ENABLED; delete process.env.WALLET_CHARGEBACK_FLAG_ONLY; }
    });

    await check('WQ29 lab scope: a branch-limited member with wallet.manage cannot request or cancel a withdrawal (403 FINANCE_SCOPE_REQUIRED); the owner can', async () => {
      process.env.WALLET_WITHDRAWALS_ENABLED = 'true';
      try {
        const own = { memberId: String(owner._id), partnerId: L, role: 'owner', permissions: [], branchIds: [] } as never;
        const branch = await partnerSvc.createBranch(own, { name: 'Branch One', phone: '9876500000', holidays: [], hours: {},
          services: { homeCollection: true, inLab: true, inClinic: false }, address: { line1: '1 Road', city: 'Shillong', state: 'Meghalaya', stateCode: '17', pincode: '793001' } } as never);
        const staff = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Branch Staff', role: 'staff', permissions: ['wallet.view', 'wallet.manage'],
          branchIds: [String(branch._id)] } as never);
        tokens.STAFF = sign({ _id: String(staff._id), memberId: String(staff._id), partnerId: L, userType: 'partner' });
        await cardTopup('lab', L, 100_000);
        const lv = await verified('partner', L, '998877665544');
        const body = { amountMinor: 50_000, requestKey: newKey(), detailsVersion: lv.version };
        await expect('STAFF', 'POST', '/api/v1/partner-workspace/assisted/wallet/withdrawals', 403, body, 'FINANCE_SCOPE_REQUIRED');
        assert.equal((await expect('STAFF', 'GET', '/api/v1/partner-workspace/assisted/wallet/withdrawable', 200)).json.data.enabled, true, 'reads stay with wallet.view');
        const w = (await expect('LAB', 'POST', '/api/v1/partner-workspace/assisted/wallet/withdrawals', 201, body)).json.data.withdrawal;
        await expect('STAFF', 'POST', `/api/v1/partner-workspace/assisted/wallet/withdrawals/${w._id}/cancel`, 403, { expectedVersion: 0 }, 'FINANCE_SCOPE_REQUIRED');
        await expect('LAB', 'PUT', '/api/v1/partner-workspace/finance/payout-details', 409, { method: 'upi', upiId: 'metro@okbank' }, 'WITHDRAWAL_OPEN');
        await expect('LAB', 'POST', `/api/v1/partner-workspace/assisted/wallet/withdrawals/${w._id}/cancel`, 200, { expectedVersion: 0 });
      } finally { delete process.env.WALLET_WITHDRAWALS_ENABLED; }
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
