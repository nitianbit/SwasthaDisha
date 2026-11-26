/**
 * r38 (ASSISTED_BOOKING_DESIGN.md §26.22): the lab front desk's Today register, its search and the lab's to-dos.
 * - GET /partner-workspace/today?date: one India day's lab bookings (desk, home, app, pharmacy), bills and their payments,
 *   the consultations the lab booked, its top-ups; branch scope; each source by its own permission; money received that
 *   day by method (bank too); what is due; the waiting work.
 * - POST /partner-workspace/today/search: the lab-facing names, refs, line text and phones.
 * - /partner-workspace/todos: the r37 module for owner kind `lab`, shared within the lab.
 * Real routes over HTTP (configureRoutes) on MongoDB.
 *
 * Run (throwaway DB only; the script drops its database):
 *   JWT_SECRET_KEY=local-integration-only SESSION_ORIGINS_CUSTOMER=https://app.jansetu.test SESSION_ORIGINS_WORKSPACE=https://staff.jansetu.test \
 *     MONGODB_URL='mongodb://127.0.0.1:27917/r38_lab_today_check?directConnection=true' npx tsx test/partners/r38-lab-today.integration.ts
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
import { LedgerEntryModel, SettlementAccountModel } from '@/modules/partners/model/settlement';
import { InvoiceEventModel, InvoiceModel } from '@/modules/partners/model/invoice';
import { PartnerLabBookingModel } from '@/modules/partners/model/labBooking';
import { PartnerWalletEntryModel } from '@/modules/partnerWallets/model';
import BookingModel from '@/modules/bookings/model';
import UserModel from '@/modules/user/model';
import { TodoModel } from '@/modules/todos/model';
import MemberModel from '@/modules/partners/model/member';
import { PartnerRepository } from '@/modules/partners/repository';
import { MemberRepository } from '@/modules/partners/repository/member';
import { BranchRepository } from '@/modules/partners/repository/branch';
import { CatalogueItemRepository } from '@/modules/partners/repository/catalogueItem';
import { PartnerService } from '@/modules/partners/services';
import { CatalogueService } from '@/modules/partners/services/catalogue';
import { LabBookingService } from '@/modules/partners/services/labBookings';
import { ensureSettlementAccount, postLedgerEntry } from '@/modules/partners/services/settlement';
import { setPayoutDetails, statementCsvOf } from '@/modules/partners/services/finance';
import { doctorTopups, labTopups, partnerStore } from '@/modules/partnerWallets/ledger';
import { PartnerWalletModel } from '@/modules/partnerWallets/model';
import { runLedgerTransaction } from '@/modules/common/utils/bookingWalletFunding';
import { AssistedAuditEventModel } from '@/modules/assisted/model';
import { setAssistedNotifier } from '@/modules/assisted/support';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/r38_lab_today_check?directConnection=true';
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
let phoneSeq = 7380000000;
const nextPhone = () => String(phoneSeq++);

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
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/partner-workspace`;

  try {
    const { partner, owner } = await partnerSvc.createPartner({
      kind: 'lab', name: 'Metro Labs', legalName: 'Metro Labs Pvt Ltd', contactPhone: nextPhone(), invoiceSeriesPrefix: 'ML',
      firstOwner: { phone: nextPhone(), name: 'Lab Owner' }, taxRegime: 'regular', gstin: '29AABCM1234F1ZH',
    } as never);
    const L = String(partner._id);
    await partnerSvc.verifyPartner(L, 'admin');
    const own = { memberId: String(owner._id), partnerId: L, role: 'owner', permissions: [], branchIds: [] } as never;
    const branch = (name: string) => partnerSvc.createBranch(own, { name, phone: nextPhone(), holidays: [], hours: {},
      services: { homeCollection: true, inLab: true, inClinic: false }, address: { line1: '1 Road', city: 'Shillong', state: 'Meghalaya', stateCode: '17', pincode: '793001' } } as never);
    const B1 = String((await branch('Main'))._id); const B2 = String((await branch('Second'))._id);
    const staff = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Desk B1', role: 'staff', permissions: ['bookings.view'], branchIds: [B1] } as never);
    const biller = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Biller', role: 'staff', permissions: ['invoices.create'], branchIds: [] } as never);
    const cat = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Catalogue', role: 'staff', permissions: ['catalogue.manage'], branchIds: [] } as never);
    const staff2 = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Desk B2', role: 'staff', permissions: ['bookings.view'], branchIds: [B2] } as never);
    const { partner: other, owner: otherOwner } = await partnerSvc.createPartner({ kind: 'lab', name: 'Other Labs', contactPhone: nextPhone(), invoiceSeriesPrefix: 'OL',
      firstOwner: { phone: nextPhone(), name: 'Other Owner' }, taxRegime: 'unregistered' } as never);
    const O = String(other._id);
    await partnerSvc.verifyPartner(O, 'admin');
    const sign = (claims: object) => jwt.sign(claims, CONFIG.JWT_SECRET_KEY, { expiresIn: '1h' });
    const member = (m: { _id: unknown }, p = L) => sign({ _id: String(m._id), memberId: String(m._id), partnerId: p, userType: 'partner' });
    const tokens: Record<string, string> = { OWN: member(owner), STAFF: member(staff), STAFF2: member(staff2), BILL: member(biller), CAT: member(cat),
      OTHER: member(otherOwner, O) };
    const call = async (who: string, method: string, url: string, body?: unknown) => {
      const r = await fetch(base + url, { method, headers: { authorization: `Bearer ${tokens[who]}`, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      let json: any; try { json = JSON.parse(text); } catch { json = { text }; }
      return { status: r.status, json, text, headers: r.headers };
    };
    const expect = async (who: string, method: string, url: string, status: number, body?: unknown, code?: string) => {
      const r = await call(who, method, url, body);
      assert.equal(r.status, status, `${who} ${method} ${url}: ${r.status} ${r.text.slice(0, 400)}`);
      if (code) assert.equal(r.json.code, code, r.text.slice(0, 300));
      return r;
    };

    const DAY = '2026-11-20';
    const at = (hm: string, d = DAY) => new Date(`${d}T${hm}:00+05:30`);
    const U1 = oid(); const U2 = oid();
    await UserModel.collection.insertMany([{ _id: new Types.ObjectId(U1), userType: 'user', phone: '9855550001', name: 'Ravi Das' },
      { _id: new Types.ObjectId(U2), userType: 'user', phone: '9866660002', name: 'Moved Away' }] as never);
    const labRow = (x: Record<string, unknown>) => ({ partnerId: L, branchId: B1, userId: U1, visitMode: 'lab', status: 'confirmed', statusVersion: 0,
      paymentStatus: 'paid', pricing: { subtotalMinor: 0, discountMinor: 0, payableMinor: 0, commissionMinor: 0, currency: 'INR' }, items: [{ name: 'CBC', kind: 'test' },
        { name: 'Lipid profile', kind: 'test' }], slot: { date: DAY, startsAt: at('09:00') }, patient: { kind: 'self', name: 'Patient' }, settlement: { settlementSystem: 'ledger' },
      report: { draftFiles: [], releasedFiles: [], releases: [] }, lifecycle: {}, ...x });
    const labs = await PartnerLabBookingModel.collection.insertMany([
      labRow({ source: 'lab_desk', settlement: { settlementSystem: 'lab_desk' }, paymentStatus: 'pending', pricing: { payableMinor: 50_000 },
        patient: { kind: 'self', name: 'Ravi Das' }, createdAt: at('10:00'), updatedAt: at('10:00') }), // 0 desk walk-in (its bill pays)
      labRow({ branchId: B2, visitMode: 'home', pricing: { payableMinor: 80_000 }, patient: { kind: 'self', name: 'Meera' }, address: { line1: 'x', city: 'y',
        pincode: '793001', phone: '9811112222' }, lifecycle: { paidAt: at('10:31') }, createdAt: at('10:30'), updatedAt: at('10:31') }), // 1 app home collection
      labRow({ source: 'pharmacy_assisted', status: 'sample_collected', pricing: { payableMinor: 60_000 }, patient: { kind: 'self', name: 'Asha' },
        assisted: { shortRef: 'JS-PH01', bookedBy: { kind: 'pharmacy', id: oid(), name: 'Demo Pharmacy' }, funding: { method: 'wallet', state: 'captured' } },
        lifecycle: { paidAt: at('11:00') }, createdAt: at('11:00'), updatedAt: at('11:00') }), // 2 pharmacy booking (report to upload)
      labRow({ pricing: { payableMinor: 30_000 }, slot: { date: '2026-11-22', startsAt: at('09:00', '2026-11-22') }, lifecycle: { paidAt: at('12:00') }, createdAt: at('18:00', '2026-11-18'),
        updatedAt: at('12:00') }), // 3 made earlier, paid this day
      labRow({ partnerId: O, createdAt: at('10:00'), updatedAt: at('10:00') }), // 4 another lab
      labRow({ source: 'lab_desk', settlement: { settlementSystem: 'lab_desk' }, paymentStatus: 'pending', slot: { date: '2026-11-19', startsAt: at('09:00', '2026-11-19') }, createdAt: at('09:00', '2026-11-19'),
        updatedAt: at('09:00', '2026-11-19') }), // 5 desk, earlier, never billed
      labRow({ source: 'lab_desk', settlement: { settlementSystem: 'lab_desk' }, status: 'completed', paymentStatus: 'pending', userId: U2,
        desk: { identity: { disputed: { state: 'moved', at: at('17:30') } } }, createdAt: at('17:00'), updatedAt: at('17:30') }), // 6 desk, identity moved
    ] as never);
    const labIds = Object.values(labs.insertedIds).map(String);
    let billNo = 0;
    const bill = (x: Record<string, unknown>) => ({ partnerId: L, branchId: B1, number: ++billNo, financialYear: '2026-27', serial: `ML/${oid().slice(-4)}`, documentKind: 'tax_invoice',
      supplier: { name: 'Metro', address: 'x', placeOfSupply: '17' }, customer: { name: 'Ravi Das', phone: '9822223333' }, items: [{ description: 'CBC', qty: 1, unitPriceMinor: 50_000,
        discountMinor: 0, amountMinor: 50_000 }], totals: { subtotalMinor: 50_000, discountMinor: 0, taxableMinor: 50_000, cgstMinor: 0, sgstMinor: 0, igstMinor: 0, totalMinor: 50_000,
        currency: 'INR' }, lifecycleState: 'issued', lifecycleVersion: 0, createdBy: 'x', checksum: 'x', idempotencyKey: oid(), requestHash: 'x', ...x });
    const bills = await InvoiceModel.collection.insertMany([
      bill({ labBookingId: labIds[0], lifecycleState: 'paid', paidMinor: 50_000, issuedAt: at('10:05'), createdAt: at('10:05'), updatedAt: at('10:06') }), // 0
      bill({ branchId: B2, serial: 'ML/B2-1', customer: { name: 'Kiran', phone: '9833334444' }, totals: { totalMinor: 40_000 }, lifecycleState: 'partly_paid', paidMinor: 10_000,
        issuedAt: at('13:00'), createdAt: at('13:00'), updatedAt: at('13:01') }), // 1 part-paid
      bill({ customer: { name: 'Old Bill' }, totals: { totalMinor: 20_000 }, lifecycleState: 'paid', paidMinor: 20_000, issuedAt: at('17:00', '2026-11-19'),
        createdAt: at('17:00', '2026-11-19'), updatedAt: at('14:00') }), // 2 made the day before, paid this day by bank
      bill({ customer: { name: 'Unpaid Old' }, totals: { totalMinor: 9_000 }, issuedAt: at('17:00', '2026-11-19'), createdAt: at('17:00', '2026-11-19'),
        updatedAt: at('17:00', '2026-11-19') }), // 3 unpaid, earlier: pending only
      bill({ customer: { name: 'Cancel Me' }, totals: { totalMinor: 15_000 }, lifecycleState: 'cancelled', paidMinor: 15_000, issuedAt: at('16:00'), createdAt: at('16:00'),
        updatedAt: at('16:30') }), // 4 paid in cash and refunded in cash this day
      bill({ customer: { name: 'Old Cancel' }, totals: { totalMinor: 5_000 }, lifecycleState: 'cancelled', paidMinor: 5_000, issuedAt: at('11:00', '2026-11-19'),
        createdAt: at('11:00', '2026-11-19'), updatedAt: at('16:45') }), // 5 paid by UPI the day before, refunded by UPI this day
    ] as never);
    const billIds = Object.values(bills.insertedIds).map(String);
    await InvoiceEventModel.collection.insertMany([
      { invoiceId: billIds[0], kind: 'payment', amountMinor: 50_000, splits: [{ mode: 'cash', amountMinor: 30_000 }, { mode: 'upi', amountMinor: 20_000 }], version: 1, at: at('10:06'),
        by: 'x', byKind: 'member' },
      { invoiceId: billIds[1], kind: 'payment', amountMinor: 10_000, splits: [{ mode: 'card', amountMinor: 10_000 }], version: 1, at: at('13:01'), by: 'x', byKind: 'member' },
      { invoiceId: billIds[2], kind: 'payment', amountMinor: 20_000, mode: 'bank', version: 1, at: at('14:00'), by: 'x', byKind: 'member' },
      { invoiceId: billIds[4], kind: 'payment', amountMinor: 15_000, mode: 'cash', version: 1, at: at('16:00'), by: 'x', byKind: 'member' },
      { invoiceId: billIds[4], kind: 'cancellation', reason: 'wrong test', refund: { mode: 'cash', amountMinor: 15_000 }, version: 2, at: at('16:30'), by: 'x', byKind: 'member' },
      { invoiceId: billIds[5], kind: 'payment', amountMinor: 5_000, mode: 'upi', version: 1, at: at('11:05', '2026-11-19'), by: 'x', byKind: 'member' },
      { invoiceId: billIds[5], kind: 'cancellation', reason: 'duplicate', refund: { mode: 'upi', amountMinor: 5_000 }, version: 2, at: at('16:45'), by: 'x', byKind: 'member' },
    ] as never);
    const consult = (x: Record<string, unknown>) => ({ userId: U1, specialistId: oid(), doctorName: 'Dr Kavya', bookingKind: 'scheduled', consultationMode: 'video',
      bookingDate: '20261120', bookingTime: '16:00', contactNo: '9844445555', ...x });
    const consults = await BookingModel.collection.insertMany([
      consult({ status: 'confirmed', paymentStatus: 'paid', price: 500, createdAt: at('15:00'), updatedAt: at('15:00'),
        assisted: { shortRef: 'JS-LC01', bookedBy: { kind: 'lab', id: L.toLowerCase(), branchId: B1, name: 'Metro Labs' }, funding: { method: 'wallet', state: 'captured' } } }),
      consult({ status: 'pending', paymentStatus: 'pending', price: 300, createdAt: at('15:30'), updatedAt: at('15:30'),
        assisted: { shortRef: 'JS-LC02', bookedBy: { kind: 'lab', id: L.toLowerCase(), branchId: B2, name: 'Metro Labs' }, funding: { method: 'razorpay', state: 'pending' } } }),
    ] as never);
    const consultIds = Object.values(consults.insertedIds).map(String);
    const topup = await PartnerWalletEntryModel.collection.insertOne({ ownerKind: 'lab', ownerId: L.toLowerCase(), kind: 'credit', amountMinor: 100_000, balanceAfterMinor: 100_000,
      withdrawableDeltaMinor: 0, receivableDeltaMinor: 0, description: 'Top-up', referenceType: 'wallet_recharge', referenceId: oid(), operationKey: oid(), at: at('09:00'),
      createdAt: at('09:00'), updatedAt: at('09:00') } as never);

    await check('GET /today (owner): every source oldest first; desk money on its bill; money received that day by method (bank too); due; whatParts; pending', async () => {
      const r = await expect('OWN', 'GET', `/today?date=${DAY}`, 200);
      assert.equal(r.headers.get('cache-control'), 'private, no-store');
      const d = r.json.data;
      assert.deepEqual(d.items.map((i: any) => [i.kind, i.id]), [['wallet_topup', String(topup.insertedId)], ['lab_booking', labIds[0]], ['bill', billIds[0]],
        ['lab_booking', labIds[1]], ['lab_booking', labIds[2]], ['lab_booking', labIds[3]], ['bill', billIds[1]], ['bill', billIds[2]], ['consultation', consultIds[0]],
        ['consultation', consultIds[1]], ['bill', billIds[4]], ['bill', billIds[5]], ['lab_booking', labIds[6]]]);
      const by = (id: string) => d.items.find((i: any) => i.id === id);
      assert.deepEqual(Object.keys(by(labIds[0])).sort(), ['amountMinor', 'at', 'id', 'kind', 'link', 'madeOn', 'method', 'paid', 'paidToday', 'patientName', 'shortRef',
        'status', 'what', 'whatParts']);
      assert.deepEqual([by(labIds[0]).patientName, by(labIds[0]).paid, by(labIds[0]).whatParts], ['Ravi Das', true,
        { code: 'lab.tests', values: { first: 'CBC', more: 1, source: 'lab_desk', visit: 'lab' } }]);
      assert.deepEqual([by(labIds[1]).whatParts.values.visit, by(labIds[1]).method, by(labIds[2]).shortRef, by(labIds[2]).whatParts.values.source],
        ['home', 'online', 'JS-PH01', 'pharmacy_assisted']);
      assert.deepEqual([by(labIds[3]).paidToday, by(labIds[3]).madeOn], [true, '2026-11-18']);
      assert.deepEqual([by(billIds[0]).patientName, by(billIds[0]).method, by(billIds[0]).whatParts, by(billIds[0]).link], ['Ravi Das', 'other',
        { code: 'bill.items', values: { first: 'CBC', more: 0 } }, { kind: 'invoice', id: billIds[0] }]);
      assert.deepEqual([by(billIds[1]).method, by(billIds[1]).paid, by(billIds[2]).method, by(billIds[2]).paidToday, by(billIds[2]).madeOn], ['card', false, 'bank', true, '2026-11-19']);
      // r38c: a bill names its desk booking (null when it has none); only bills carry the field.
      assert.deepEqual([by(billIds[0]).labBookingId, by(billIds[1]).labBookingId, 'labBookingId' in by(labIds[0])], [labIds[0], null, false]);
      assert.deepEqual([by(consultIds[0]).method, by(consultIds[0]).whatParts.code], ['wallet', 'consult.scheduled']);
      // r38b: money that went back this day, by its method (the drawer: collected cash − refunded cash).
      assert.deepEqual(d.totals, { collectedMinor: 80_000 + 60_000 + 30_000 + 30_000 + 20_000 + 10_000 + 20_000 + 50_000 + 15_000,
        byMethod: { cash: 45_000, upi: 20_000, card: 10_000, bank: 20_000, wallet: 50_000, online: 170_000, other: 0 }, unpaidMinor: 30_000, count: 13,
        refundedMinor: 20_000, refundsByMethod: { cash: 15_000, upi: 5_000, card: 0, bank: 0, wallet: 0, online: 0, other: 0 } });
      assert.deepEqual([by(billIds[5]).madeOn, new Date(by(billIds[5]).at).toISOString()], ['2026-11-19', at('16:45').toISOString()], 'listed for its refund this day');
      assert.deepEqual(d.pending, {
        samplesToCollect: { count: 2, visitCount: 1, homeCount: 1, visitIds: [labIds[0]], homeIds: [labIds[1]] },
        reportsDue: { count: 1, toUploadCount: 1, toReleaseCount: 0, toUploadIds: [labIds[2]], toReleaseIds: [] },
        deskUnbilled: { count: 2, ids: [labIds[6], labIds[5]] },
        unpaidBills: { count: 2, ids: [billIds[1], billIds[3]] },
        bookingsAwaitingPayment: { count: 1, ids: [consultIds[1]] },
        consultationsWaiting: { count: 1, ids: [consultIds[0]] },
      });
      assert.ok(!d.items.some((i: any) => i.id === labIds[4]), 'another lab never');
      const desc = (await expect('OWN', 'GET', `/today?date=${DAY}&order=desc&limit=3`, 200)).json.data;
      assert.deepEqual([desc.items.map((i: any) => i.id), !!desc.nextCursor], [[labIds[6], billIds[5], billIds[4]], true]);
    });

    await check('scope and permissions: a branch-limited bookings reader sees its branch\'s bookings only; a biller the bills; no reader 403; another lab its own', async () => {
      const s = (await expect('STAFF', 'GET', `/today?date=${DAY}`, 200)).json.data;
      assert.deepEqual(s.items.map((i: any) => i.id), [labIds[0], labIds[2], labIds[3], labIds[6]]);
      assert.deepEqual([s.totals.collectedMinor, s.totals.byMethod.online], [90_000, 90_000]);
      assert.deepEqual(Object.keys(s.pending).sort(), ['deskUnbilled', 'reportsDue', 'samplesToCollect']);
      assert.deepEqual([s.pending.samplesToCollect.count, s.pending.reportsDue.toUploadCount], [1, 1]);
      const b = (await expect('BILL', 'GET', `/today?date=${DAY}`, 200)).json.data;
      assert.deepEqual([b.items.map((i: any) => i.id), b.pending.unpaidBills.count, Object.keys(b.pending)], [[billIds[0], billIds[1], billIds[2], billIds[4], billIds[5]], 2,
        ['unpaidBills']]);
      // r38c: a member who cannot read lab bookings is never told which booking a bill is for.
      assert.ok(b.items.every((i: any) => i.labBookingId === null));
      const bs = (await expect('BILL', 'POST', '/today/search', 200, { date: DAY, q: 'ravi' })).json.data.items;
      assert.deepEqual(bs.map((i: any) => [i.id, i.labBookingId]), [[billIds[0], null]]);
      await expect('CAT', 'GET', `/today?date=${DAY}`, 403);
      const o = (await expect('OTHER', 'GET', `/today?date=${DAY}`, 200)).json.data;
      assert.deepEqual(o.items.map((i: any) => i.id), [labIds[4]]);
    });

    await check('POST /today/search: the lab-facing name, bill serial, short ref and phones (4+ digits); scope applies; no-store; 400 on a short q', async () => {
      const q = async (who: string, text: string) => (await expect(who, 'POST', '/today/search', 200, { date: DAY, q: text })).json.data.items.map((i: any) => i.id);
      // The consultations' patient is the account holder, named as the lab is shown him (masked or typed).
      assert.deepEqual(await q('OWN', 'ravi'), [labIds[0], billIds[0], ...consultIds]);
      assert.deepEqual(await q('OWN', '98222'), [billIds[0]]);
      assert.deepEqual(await q('OWN', '98111'), [labIds[1]]);
      assert.deepEqual(await q('OWN', 'js-ph01'), [labIds[2]]);
      assert.deepEqual(await q('OWN', 'ML/B2-1'), [billIds[1]]);
      // r38c: the search's bill rows carry the desk booking too.
      assert.equal((await expect('OWN', 'POST', '/today/search', 200, { date: DAY, q: 'ravi' })).json.data.items.find((i: any) => i.id === billIds[0]).labBookingId, labIds[0]);
      assert.deepEqual(await q('OWN', '98444'), consultIds);
      assert.deepEqual(await q('STAFF', 'ravi'), [labIds[0]]);
      assert.deepEqual(await q('STAFF', 'meera'), []);
      // r38b: a desk booking's account holder phone matches while the identity stands; never once it was moved.
      assert.deepEqual(await q('OWN', '98555'), [labIds[0], ...consultIds], 'the desk booking and the consultations it made for that holder');
      assert.deepEqual(await q('OWN', '98666'), []);
      const raw = await call('OWN', 'POST', '/today/search', { date: DAY, q: 'cbc' });
      assert.equal(raw.headers.get('cache-control'), 'private, no-store');
      await expect('OWN', 'POST', '/today/search', 400, { date: DAY, q: 'x' });
    });

    await check('to-dos for the lab: shared within the lab (a branch-limited member sees them all), createdBy the member\'s name; another lab 404', async () => {
      const t = (await expect('OWN', 'POST', '/todos', 201, { text: 'Order reagent kits', requestKey: 'lab-todo-0001' })).json.data.todo;
      assert.deepEqual([t.createdBy.kind, t.createdBy.name], ['member', 'Lab Owner']);
      const s = (await expect('STAFF', 'POST', '/todos', 201, { text: 'Call Meera about her sample', requestKey: 'lab-todo-0002' })).json.data.todo;
      assert.equal(s.createdBy.name, 'Desk B1');
      assert.deepEqual((await expect('STAFF', 'GET', '/todos', 200)).json.data.map((x: any) => x.text), ['Call Meera about her sample', 'Order reagent kits']);
      // r38b: a branch-limited member's to-do belongs to its branch: another branch's member sees only the lab-wide ones.
      assert.deepEqual([s.branchIds, t.branchIds], [[B1], []]);
      assert.deepEqual((await expect('STAFF2', 'GET', '/todos', 200)).json.data.map((x: any) => x.text), ['Order reagent kits']);
      await expect('STAFF2', 'PATCH', `/todos/${s._id}`, 404, { done: true, expectedVersion: 0 }, 'TODO_NOT_FOUND');
      await expect('STAFF2', 'DELETE', `/todos/${s._id}`, 404, undefined, 'TODO_NOT_FOUND');
      assert.equal((await expect('OWN', 'GET', '/todos', 200)).json.data.length, 2, 'the owner sees every branch');
      assert.deepEqual((await expect('OTHER', 'GET', '/todos', 200)).json.data, []);
      await expect('OTHER', 'PATCH', `/todos/${t._id}`, 404, { done: true, expectedVersion: 0 }, 'TODO_NOT_FOUND');
      assert.equal((await expect('CAT', 'PATCH', `/todos/${t._id}`, 200, { done: true, expectedVersion: 0 })).json.data.done, true, 'any member of the lab');
      assert.equal(await TodoModel.countDocuments({ 'owner.kind': 'lab', 'owner.id': L.toLowerCase() }), 2);
      assert.ok(await MemberModel.exists({ _id: staff._id }));
    });
    await check('r40b: a consultation the lab booked earlier and paid on this day is listed (paidToday) and counted on this day (lifecycle.paid.at is an ISO string)', async () => {
      const PAID = '2026-11-25';
      const b = await BookingModel.collection.insertOne({ userId: U1, specialistId: oid(), doctorName: 'Dr Mehta', bookingKind: 'scheduled', consultationMode: 'video',
        bookingDate: '20261126', bookingTime: '10:00', status: 'confirmed', paymentStatus: 'paid', price: 400,
        lifecycle: { paid: { at: new Date(`${PAID}T10:30:00+05:30`).toISOString() } }, createdAt: new Date('2026-11-23T18:00:00+05:30'), updatedAt: new Date(`${PAID}T10:30:00+05:30`),
        assisted: { shortRef: 'JS-R40B', bookedBy: { kind: 'lab', id: L.toLowerCase(), branchId: B1, name: 'Metro Labs' }, funding: { method: 'wallet', state: 'captured' } } } as never);
      const d = (await expect('OWN', 'GET', `/today?date=${PAID}`, 200)).json.data;
      const item = d.items.find((i: any) => i.id === String(b.insertedId));
      assert.ok(item, JSON.stringify(d.items).slice(0, 300));
      assert.deepEqual([item.kind, item.paidToday, item.madeOn, item.method], ['consultation', true, '2026-11-23', 'wallet']);
      assert.deepEqual([d.totals.collectedMinor, d.totals.byMethod.wallet], [40_000, 40_000]);
    });
    await check('r40c: a desk booking for a later day is not yet to bill (deskUnbilled counts visits up to the register\'s day)', async () => {
      const later = await PartnerLabBookingModel.collection.insertOne(labRow({ source: 'lab_desk', settlement: { settlementSystem: 'lab_desk' }, paymentStatus: 'pending',
        slot: { date: '2026-11-25', startsAt: at('09:00', '2026-11-25') }, createdAt: at('09:30'), updatedAt: at('09:30') }) as never);
      const d = (await expect('OWN', 'GET', `/today?date=${DAY}`, 200)).json.data;
      assert.ok(!d.pending.deskUnbilled.ids.includes(String(later.insertedId)));
      const after = (await expect('OWN', 'GET', '/today?date=2026-11-25', 200)).json.data;
      assert.ok(after.pending.deskUnbilled.ids.includes(String(later.insertedId)));
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
