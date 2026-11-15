/**
 * Q5: ledger statements (running balance, cursor pages, CSV), payout destinations (owner/doctor set, admin verifies,
 * masked for owners), admin payout recording (verified destination version, balance ceiling, exactly-once request
 * keys, unique references, concurrency), voids and adjustments, the admin payout queue, and the HTTP routes for
 * partners (members and admins-as-owner), doctors and admins. Real MongoDB replica set, the real application routes.
 *
 * Run (throwaway DB only; the script drops its collections):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/q5_finance_check?directConnection=true' JWT_SECRET_KEY=local-integration-only \
 *     npx tsx test/partners/q5-finance.integration.ts
 */
import { removeFixtureDir } from './q5-fixture-dir';
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
import SpecialistModel from '@/modules/specialists/model';
import BookingModel from '@/modules/bookings/model';
import PartnerModel from '@/modules/partners/model';
import MemberModel from '@/modules/partners/model/member';
import BranchModel from '@/modules/partners/model/branch';
import PartnerAuditEventModel from '@/modules/partners/model/audit';
import { PartnerLabBookingModel } from '@/modules/partners/model/labBooking';
import {
  SettlementAccountModel, LedgerEntryModel, LedgerHistoryRefModel, SettlementPayoutModel, SettlementEventModel,
} from '@/modules/partners/model/settlement';
import { PartnerRepository } from '@/modules/partners/repository';
import { MemberRepository } from '@/modules/partners/repository/member';
import { BranchRepository } from '@/modules/partners/repository/branch';
import { PartnerService, PartnerActor } from '@/modules/partners/services';
import { ensureSettlementAccount, postLedgerEntry, ledgerBalance } from '@/modules/partners/services/settlement';
import * as fin from '@/modules/partners/services/finance';
import { istDate, addDays } from '@/modules/partners/services/slots';
import { PharmacyService } from '@/modules/pharmacies/services';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import { UserRepository } from '@/modules/user/repository';
import { BannerService } from '@/modules/banners/services';
import { BannerRepository } from '@/modules/banners/repository';
import { IMember, PartnerPermission } from '@/modules/partners/types';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/q5_finance_check?directConnection=true';
const url = process.env.MONGODB_URL ?? '';
if (url !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const partnerSvc = new PartnerService(new PartnerRepository(), new MemberRepository(), new BranchRepository());
Container.set(PartnerService, partnerSvc);

let passed = 0;
async function check(name: string, fn: () => Promise<void> | void) { await fn(); passed++; console.log('ok -', name); }
const code = (c: string) => (e: any) => e?.code === c;
const actorFor = (m: IMember): PartnerActor => ({ memberId: String(m._id), partnerId: String(m.partnerId), role: m.role,
  permissions: m.permissions as PartnerPermission[], branchIds: (m.branchIds ?? []).map(String) });
let phone = 7300000000;
const nextPhone = () => String(phone++);
let keySeq = 0;
const rk = () => `payout-key-${String(++keySeq).padStart(4, '0')}`;
const today = istDate(new Date());
const ADMIN = new Types.ObjectId().toString();
const admin: fin.FinanceActor = { kind: 'admin', id: ADMIN };
const bank = { method: 'bank' as const, accountName: 'Metro Labs Pvt Ltd', accountNumber: '123456789012', ifsc: 'hdfc0001234', bankName: 'HDFC Bank' };

let earningSeq = 0;
async function earn(accountId: string, minor: number, source = 'test_earning', sourceId = `e${++earningSeq}`) {
  return postLedgerEntry({ settlementAccountId: accountId, kind: 'earning', amountMinor: minor, source, sourceId, by: 'system', byKind: 'system' });
}
const pay = (accountId: string, amountMinor: number, over: Partial<fin.RecordPayoutInput> = {}, detailsVersion?: number) =>
  SettlementAccountModel.findById(accountId).lean().then((a) => fin.recordPayout(ADMIN, accountId, {
    amountMinor, method: 'bank_transfer', reference: `UTR${Math.random().toString(36).slice(2, 12).toUpperCase()}`, paidOn: today,
    detailsVersion: detailsVersion ?? a!.payoutDetailsVersion, requestKey: rk(), ...over }));

async function main() {
  await mongoose.connect(url, { autoIndex: false });
  for (const c of await mongoose.connection.db!.collections()) await c.drop().catch(() => {});
  for (const M of [UserModel, SpecialistModel, BookingModel, PartnerModel, MemberModel, BranchModel, PartnerAuditEventModel, PartnerLabBookingModel,
    SettlementAccountModel, LedgerEntryModel, LedgerHistoryRefModel, SettlementPayoutModel, SettlementEventModel] as mongoose.Model<any>[]) {
    await M.createCollection(); await M.createIndexes();
  }

  // ── Fixtures: a verified lab (account created with the partner), staff of several kinds ──
  const { partner, owner } = await partnerSvc.createPartner({ kind: 'lab', name: 'Metro Labs', legalName: 'Metro Labs Pvt Ltd', contactPhone: nextPhone(),
    invoiceSeriesPrefix: 'ML', firstOwner: { phone: nextPhone(), name: 'Owner' } } as any);
  const partnerId = String(partner._id);
  await partnerSvc.verifyPartner(partnerId, 'admin');
  const own = actorFor(owner);
  const branch = await partnerSvc.createBranch(own, { name: 'Main', phone: '9876500000', holidays: [], hours: {},
    services: { homeCollection: true, inLab: true, inClinic: false }, address: { line1: 'x', city: 'y', state: 'z', stateCode: '29', pincode: '560001' } } as any);
  const accountant = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Accounts', role: 'staff', permissions: ['finance.view'] } as any);
  const branchFinance = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Branch accounts', role: 'staff', branchIds: [String(branch._id)], permissions: ['finance.view'] } as any);
  const desk = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Desk', role: 'staff', permissions: ['bookings.view'] } as any);
  const labAccount = (await fin.findOwnerAccount('partner', partnerId))!;
  assert.ok(labAccount, 'partner account exists from creation');
  const L = String(labAccount._id);

  await check('payout destination: owner sets it (validated, masked for owners, full for admins); others cannot; any change needs re-verification', async () => {
    await assert.rejects(() => fin.setPayoutDetails({ ownerKind: 'partner', ownerId: partnerId }, { ...bank, ifsc: 'HDFC1234' }, { kind: 'member', partner: own }), code('INVALID_IFSC'));
    await assert.rejects(() => fin.setPayoutDetails({ ownerKind: 'partner', ownerId: partnerId }, { ...bank, accountNumber: '12ab' }, { kind: 'member', partner: own }), code('INVALID_ACCOUNT_NUMBER'));
    await assert.rejects(() => fin.setPayoutDetails({ ownerKind: 'partner', ownerId: partnerId }, bank, { kind: 'member', partner: actorFor(accountant) }), code('OWNER_REQUIRED'));
    const v = await fin.setPayoutDetails({ ownerKind: 'partner', ownerId: partnerId }, bank, { kind: 'member', partner: own });
    assert.equal(v.payoutDetailsState, 'unverified');
    assert.equal(v.payoutDetailsVersion, 1);
    assert.equal((v.payoutDetails as any).accountNumber, undefined, 'owner view never carries the full number');
    assert.equal((v.payoutDetails as any).accountNumberMasked, 'XXXX9012');
    assert.equal((v.payoutDetails as any).ifsc, 'HDFC0001234');
    const full = await fin.financeSummary(await fin.accountById(L), true);
    assert.equal((full.account!.payoutDetails as any).accountNumber, '123456789012');
    assert.ok(await PartnerAuditEventModel.exists({ partnerId, action: 'finance.payout_details_changed' }), 'who/what in the partner audit');
    const event = await SettlementEventModel.findOne({ settlementAccountId: L, action: 'finance.payout_details_changed' }).lean();
    assert.equal((event!.detail as any).last4, '9012');
    assert.ok(!JSON.stringify(event).includes('123456789012'), 'the finance events never store the full number');
  });

  await check('admin verification is for the version they saw; a later change clears it', async () => {
    await assert.rejects(() => fin.verifyPayoutDetails(L, 0, ADMIN), code('PAYOUT_DETAILS_CHANGED'));
    const v = await fin.verifyPayoutDetails(L, 1, ADMIN);
    assert.equal(v.payoutDetailsState, 'verified');
    assert.equal((await fin.verifyPayoutDetails(L, 1, ADMIN)).payoutDetailsState, 'verified', 'repeat is a no-op');
    const changed = await fin.setPayoutDetails({ ownerKind: 'partner', ownerId: partnerId }, { method: 'upi', upiId: 'MetroLabs@HDFC' }, { kind: 'member', partner: own });
    assert.deepEqual([changed.payoutDetailsState, changed.payoutDetailsVersion], ['unverified', 2]);
    assert.equal((changed.payoutDetails as any).upiId, 'metrolabs@hdfc');
    await assert.rejects(() => fin.verifyPayoutDetails(L, 1, ADMIN), code('PAYOUT_DETAILS_CHANGED'));
    await fin.setPayoutDetails({ ownerKind: 'partner', ownerId: partnerId }, bank, { kind: 'member', partner: own });
    await fin.verifyPayoutDetails(L, 3, ADMIN);
  });

  await check('a payout needs the verified destination version, never exceeds the balance and moves it by a ledger entry', async () => {
    await earn(L, 150000);
    await assert.rejects(() => pay(L, 10000, {}, 2), code('PAYOUT_DETAILS_CHANGED'));
    await assert.rejects(() => pay(L, 150001), code('INSUFFICIENT_BALANCE'));
    await assert.rejects(() => pay(L, 1000, { paidOn: addDays(today, 1) }), code('INVALID_DATE'));
    await assert.rejects(() => pay(L, 1000, { paidOn: '2026-02-30' }), code('INVALID_DATE'));
    const r = await pay(L, 100000, { reference: 'UTR-HDFC-0001', note: 'November' });
    assert.equal(r.replayed, false);
    assert.equal(await ledgerBalance(L), 50000);
    const e = await LedgerEntryModel.findOne({ settlementAccountId: L, kind: 'payout', sourceId: String(r.payout._id) }).lean();
    assert.equal(e!.amountMinor, -100000);
    assert.equal(e!.reference, 'UTR-HDFC-0001');
    assert.match((r.payout as any).destination.label, /HDFC0001234 XXXX9012/);
    assert.equal((r.payout as any).requestKey, undefined);
    assert.ok(await PartnerAuditEventModel.exists({ partnerId, action: 'finance.payout_recorded', actorKind: 'admin' }));
    await assert.rejects(() => pay(L, 1000, { reference: 'UTR-HDFC-0001' }), code('PAYOUT_REFERENCE_EXISTS'));
    // Unverified destination: refused.
    await fin.setPayoutDetails({ ownerKind: 'partner', ownerId: partnerId }, bank, { kind: 'member', partner: own });
    await assert.rejects(() => pay(L, 1000), code('PAYOUT_DETAILS_NOT_VERIFIED'));
    await fin.verifyPayoutDetails(L, 4, ADMIN);
  });

  await check('exactly once per request key: a replay returns the original, other content under the key is refused, racing replays make one', async () => {
    const before = await ledgerBalance(L);
    const input = { amountMinor: 5000, method: 'upi' as const, reference: 'UPI-REF-77', paidOn: today, detailsVersion: 4, requestKey: 'same-key-0001' };
    const a = await fin.recordPayout(ADMIN, L, input);
    const b = await fin.recordPayout(ADMIN, L, input);
    assert.equal(b.replayed, true);
    assert.equal(String(b.payout._id), String(a.payout._id));
    await assert.rejects(() => fin.recordPayout(ADMIN, L, { ...input, amountMinor: 6000 }), code('REQUEST_KEY_REUSED'));
    const racing = { ...input, reference: 'UPI-REF-78', requestKey: 'same-key-0002' };
    const all = await Promise.all(Array.from({ length: 5 }, () => fin.recordPayout(ADMIN, L, racing)));
    assert.equal(new Set(all.map((x) => String(x.payout._id))).size, 1);
    assert.equal(await SettlementPayoutModel.countDocuments({ requestKey: 'same-key-0002' }), 1);
    assert.equal(await ledgerBalance(L), before - 10000);
  });

  await check('concurrent payouts never overdraw: the account serializes them on the balance', async () => {
    const { account } = await (async () => ({ account: await ensureSettlementAccount('partner', new Types.ObjectId().toString(), 'Race Labs') }))();
    const A = String(account._id);
    await fin.setPayoutDetails({ accountId: A }, bank, admin);
    await fin.verifyPayoutDetails(A, 1, ADMIN);
    await earn(A, 100000);
    const r = await Promise.allSettled(Array.from({ length: 6 }, () => pay(A, 40000, {}, 1)));
    assert.equal(r.filter((x) => x.status === 'fulfilled').length, 2);
    assert.ok(r.filter((x) => x.status === 'rejected').every((x: any) => x.reason?.code === 'INSUFFICIENT_BALANCE'));
    assert.equal(await ledgerBalance(A), 20000);
    // A destination change racing payouts: each payout either committed before it or is refused after it.
    await earn(A, 100000);
    const mixed = await Promise.allSettled([pay(A, 10000, {}, 1), fin.setPayoutDetails({ accountId: A }, { method: 'upi', upiId: 'race@upi' }, admin), pay(A, 10000, {}, 1)]);
    const paid = await SettlementPayoutModel.find({ settlementAccountId: A, state: 'recorded' }).lean();
    assert.ok(paid.every((p) => p.destination.detailsVersion === 1 && p.destination.method === 'bank'));
    assert.ok(mixed.filter((x) => x.status === 'rejected').every((x: any) => x.reason?.code === 'PAYOUT_DETAILS_NOT_VERIFIED'));
  });

  await check('void: once, compensated by an adjustment (nothing deleted); its reference can be used again', async () => {
    const before = await ledgerBalance(L);
    const r = await pay(L, 20000, { reference: 'UTR-WRONG-01' });
    assert.equal(await ledgerBalance(L), before - 20000);
    await assert.rejects(() => fin.voidPayout(ADMIN, String(r.payout._id), 'x'), code('INVALID_REASON'));
    const v = await fin.voidPayout(ADMIN, String(r.payout._id), 'Recorded against the wrong account');
    assert.equal(v.state, 'voided');
    await fin.voidPayout(ADMIN, String(r.payout._id), 'again');
    assert.equal(await LedgerEntryModel.countDocuments({ settlementAccountId: L, source: 'payout_void', sourceId: String(r.payout._id) }), 1);
    assert.equal(await ledgerBalance(L), before);
    assert.equal(await LedgerEntryModel.countDocuments({ settlementAccountId: L, sourceId: String(r.payout._id) }), 2, 'payout entry kept');
    await pay(L, 20000, { reference: 'UTR-WRONG-01' });
  });

  await check('adjustments: signed, with a reason, exactly once per key; a recovery may take the balance below zero', async () => {
    const before = await ledgerBalance(L);
    await assert.rejects(() => fin.postAdjustment(ADMIN, L, { amountMinor: 0, reason: 'zero', requestKey: rk() }), code('INVALID_AMOUNT'));
    const key = rk();
    const a = await fin.postAdjustment(ADMIN, L, { amountMinor: 2500, reason: 'Home collection fee owed', requestKey: key });
    assert.equal((await fin.postAdjustment(ADMIN, L, { amountMinor: 2500, reason: 'Home collection fee owed', requestKey: key })).replayed, true);
    await assert.rejects(() => fin.postAdjustment(ADMIN, L, { amountMinor: 3000, reason: 'Home collection fee owed', requestKey: key }), code('REQUEST_KEY_REUSED'));
    assert.equal(a.entry.amountMinor, 2500);
    const recovery = before + 2500 + 1000;
    await fin.postAdjustment(ADMIN, L, { amountMinor: -recovery, reason: 'Recovery of an overpayment', requestKey: rk() });
    assert.equal(await ledgerBalance(L), -1000);
    await assert.rejects(() => pay(L, 100), code('INSUFFICIENT_BALANCE'));
    await fin.postAdjustment(ADMIN, L, { amountMinor: recovery, reason: 'Recovery reversed (test)', requestKey: rk() });
  });

  // A lab booking and a consultation for statement descriptions.
  const labBookingId = new Types.ObjectId();
  await PartnerLabBookingModel.collection.insertOne({ _id: labBookingId, partnerId, branchId: String(branch._id), patient: { kind: 'self', name: 'Asha Kumar' },
    slot: { slotId: 'x', date: '2026-11-20', startTime: '09:00', endTime: '09:30', startsAt: new Date() }, visitMode: 'lab', status: 'completed' } as never);
  await earn(L, 45000, 'partner_lab_booking', String(labBookingId));

  await check('statement: newest first with the running balance, cursor pages agree with the total, readable descriptions', async () => {
    const total = await ledgerBalance(L);
    const p1 = await fin.statementPage(await fin.accountById(L), { limit: 3 });
    assert.equal(p1.lines[0]!.balanceAfterMinor, total);
    assert.match(p1.lines[0]!.description, /^Lab booking · 2026-11-20 09:00 · Asha$/);
    assert.ok(p1.nextCursor);
    const all: fin.StatementLine[] = [...p1.lines];
    let cursor = p1.nextCursor;
    while (cursor) { const p = await fin.statementPage(await fin.accountById(L), { limit: 3, before: cursor }); all.push(...p.lines); cursor = p.nextCursor; }
    assert.equal(all.length, await LedgerEntryModel.countDocuments({ settlementAccountId: L }));
    for (let i = 0; i < all.length - 1; i++) assert.equal(all[i]!.balanceAfterMinor - all[i]!.amountMinor, all[i + 1]!.balanceAfterMinor, `line ${i}`);
    assert.equal(all[all.length - 1]!.balanceAfterMinor, all[all.length - 1]!.amountMinor, 'oldest line starts from zero');
    assert.ok(all.some((l) => /^Payout · \d{4}-\d{2}-\d{2} · /.test(l.description)));
    assert.ok(all.some((l) => l.description.startsWith('Payout voided')));
    await assert.rejects(async () => fin.statementPage(await fin.accountById(L), { before: 'bogus' }), code('INVALID_CURSOR'));
    const none = await fin.statementPage(await fin.accountById(L), { from: addDays(today, 5) });
    assert.equal(none.lines.length, 0);
  });

  await check('CSV: opening/closing balances, rupees, formula-leading text neutralised', async () => {
    await fin.postAdjustment(ADMIN, L, { amountMinor: 100, reason: '=HYPERLINK("http://evil")', requestKey: rk() });
    const csv = await fin.statementCsv(await fin.accountById(L), {});
    const lines = csv.trim().split('\n');
    assert.match(lines[0]!, /^"Date \(IST\)","Type"/);
    assert.match(lines[1]!, /"Opening balance".*"0\.00"$/);
    assert.ok(lines[lines.length - 1]!.endsWith(`"${((await ledgerBalance(L)) / 100).toFixed(2)}"`));
    assert.ok(csv.includes(`"'=HYPERLINK(""http://evil"")"`), 'formula cell neutralised');
    const empty = await fin.statementCsv(null, {});
    assert.equal(empty.trim().split('\n').length, 1);
  });

  // ── Doctor account ──
  const doctorId = new Types.ObjectId().toString();
  await SpecialistModel.collection.insertOne({ _id: new Types.ObjectId(doctorId), name: 'Dr Iyer', phone: nextPhone(), specialization: 'GP',
    consultationFee: 500, isActive: true, isVerified: true } as never);

  await check('admin payout queue: balances across partners and doctors, due only, largest first', async () => {
    const d = await ensureSettlementAccount('doctor', doctorId, 'Dr Iyer');
    const consult = new Types.ObjectId();
    await BookingModel.collection.insertOne({ _id: consult, bookingType: 'consultation', userId: 'u', specialistId: doctorId, bookingDate: '20261118',
      bookingTime: '10:00', consultationMode: 'video', serviceMode: 'video', price: 500, status: 'completed', paymentStatus: 'paid', settlementSystem: 'ledger' } as never);
    await earn(String(d._id), 999999, 'consultation', String(consult));
    await LedgerHistoryRefModel.create({ settlementAccountId: String(d._id), source: 'legacy_import', legacyKind: 'billing', legacyId: 'bill-1', periodLabel: '2026-10', amountMinor: 120000, at: new Date('2026-10-31') });
    const q = await fin.adminListAccounts({ due: true });
    assert.equal(q.rows[0]!._id, String(d._id));
    assert.equal(q.rows[0]!.balanceMinor, 999999);
    assert.ok(q.rows.every((r) => r.balanceMinor > 0));
    assert.equal(q.totalDueMinor, q.rows.reduce((t, r) => t + r.balanceMinor, 0));
    assert.ok(q.rows.every((r) => !(r.payoutDetails as any)?.accountNumber), 'the queue list never carries full numbers');
    assert.equal((await fin.adminListAccounts({ ownerKind: 'partner', search: 'metro' })).rows.length, 1);
    const st = await fin.statementPage(d, {});
    assert.match(st.lines[0]!.description, /^Consultation · 2026-11-18 10:00 · video$/);
    assert.equal((await fin.historyRefs(d)).length, 1);
    assert.equal(await ledgerBalance(String(d._id)), 999999, 'history refs are never part of the balance');
  });

  // ── Review findings (Q5 round 1) ──
  await check('the general partner audit carries no finance detail; the finance event stream does', async () => {
    const rows = await PartnerAuditEventModel.find({ partnerId, action: /^finance\./ }).lean();
    assert.ok(rows.length >= 5);
    assert.ok(rows.every((r) => r.detail === undefined || r.detail === null), 'no amounts, references or destinations in the partner audit');
    const ev = await fin.financeEvents(await fin.accountById(L));
    assert.ok(ev.some((e: any) => e.action === 'finance.payout_recorded' && typeof e.detail?.amountMinor === 'number'));
  });

  await check('a statement page and its balances come from one snapshot (backdated rows committing meanwhile)', async () => {
    const acct = String((await ensureSettlementAccount('partner', new Types.ObjectId().toString(), 'Snapshot Labs'))._id);
    const t0 = Date.now() - 3_600_000;
    for (let i = 0; i < 10; i++) {
      await LedgerEntryModel.create({ settlementAccountId: acct, kind: 'earning', amountMinor: 100, grossMinor: 100, commissionMinor: 0, source: 'snap',
        sourceId: `base${i}`, at: new Date(t0 + i * 60_000), by: 'system', byKind: 'system' });
    }
    let seq = 0;
    for (let round = 0; round < 25; round++) {
      const insert = LedgerEntryModel.create({ settlementAccountId: acct, kind: 'earning', amountMinor: 7, grossMinor: 7, commissionMinor: 0, source: 'snap',
        sourceId: `late${seq++}`, at: new Date(t0 + 30_000 + (round % 9) * 60_000), by: 'system', byKind: 'system' });
      const page = await fin.statementPage(await fin.accountById(acct), { limit: 200 });
      await insert;
      const oldest = page.lines[page.lines.length - 1]!;
      assert.equal(oldest.balanceAfterMinor, oldest.amountMinor, `round ${round}: the full history starts from zero`);
      assert.equal(page.lines[0]!.balanceAfterMinor, page.lines.reduce((s, l) => s + l.amountMinor, 0), `round ${round}`);
    }
  });

  await check('CSV: a quiet period carries the balance in (opening = closing = prior balance); an oversized period is refused, never cut', async () => {
    const before = await ledgerBalance(L);
    const quiet = await fin.statementCsv(await fin.accountById(L), { from: addDays(today, 10), to: addDays(today, 12) });
    const lines = quiet.trim().split('\n');
    assert.equal(lines.length, 3);
    assert.ok(lines[1]!.endsWith(`"${(before / 100).toFixed(2)}"`) && lines[2]!.endsWith(`"${(before / 100).toFixed(2)}"`));
    const big = String((await ensureSettlementAccount('partner', new Types.ObjectId().toString(), 'Big Labs'))._id);
    const at = new Date(Date.now() - 86_400_000);
    await LedgerEntryModel.insertMany(Array.from({ length: fin.CSV_MAX_LINES + 1 }, (_, i) => ({ settlementAccountId: big, kind: 'earning', amountMinor: 100,
      grossMinor: 100, commissionMinor: 0, source: 'bulk', sourceId: `b${i}`, at: new Date(at.getTime() + i), by: 'system', byKind: 'system' })));
    const bigAccount = await fin.accountById(big);
    await assert.rejects(() => fin.statementCsv(bigAccount, {}), code('EXPORT_TOO_LARGE'));
    await LedgerEntryModel.deleteOne({ settlementAccountId: big, sourceId: 'b0' });
    const ok = await fin.statementCsv(await fin.accountById(big), {});
    assert.ok(ok.trim().split('\n').pop()!.endsWith(`"${(fin.CSV_MAX_LINES * 100 / 100).toFixed(2)}"`));
  });

  await check('payout queue covers every account (beyond any candidate cap): totals, ordering and pages over all of them', async () => {
    await SettlementAccountModel.insertMany(Array.from({ length: 5001 }, (_, i) => ({ ownerKind: 'partner', ownerId: `bulk-${i}`, beneficiaryName: `Bulk ${i}`,
      payoutDetailsVersion: 0, payoutDetailsState: 'none', financeVersion: 0, isActive: true })));
    const last = await SettlementAccountModel.findOne({ ownerId: 'bulk-5000' }).lean();
    await earn(String(last!._id), 12345);
    const q = await fin.adminListAccounts({ due: true, search: 'Bulk' });
    assert.deepEqual([q.total, q.totalDueMinor, q.rows[0]!._id], [1, 12345, String(last!._id)]);
    const page2 = await fin.adminListAccounts({ search: 'Bulk', skip: 5000, limit: 10 });
    assert.equal(page2.total, 5001);
    assert.equal(page2.rows.length, 1);
  });

  await check('ids are canonical at every boundary: an upper-case account id cannot slip a changed adjustment past its key', async () => {
    const key = rk();
    await fin.postAdjustment(ADMIN, L, { amountMinor: 300, reason: 'Original reason', requestKey: key });
    await assert.rejects(() => fin.postAdjustment(ADMIN, L.toUpperCase(), { amountMinor: 300, reason: 'Changed reason', requestKey: key }), code('REQUEST_KEY_REUSED'));
    assert.equal((await fin.postAdjustment(ADMIN, L.toUpperCase(), { amountMinor: 300, reason: 'Original reason', requestKey: key })).replayed, true);
    assert.equal(await SettlementEventModel.countDocuments({ settlementAccountId: L, action: 'finance.adjustment_posted', 'detail.reason': { $in: ['Original reason', 'Changed reason'] } }), 1);
    assert.equal((await fin.adminListPayouts({ accountId: L.toUpperCase() })).length, (await fin.adminListPayouts({ accountId: L })).length);
  });

  // ── HTTP: the real application routes ──
  Container.set(PharmacyService, new PharmacyService(new PharmacyRepository(), new UserRepository()));
  Container.set(BannerService, new BannerService(new BannerRepository()));
  const { configureRoutes } = await import('@/routes');
  const app = express();
  app.use(express.json());
  configureRoutes(app);
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const partnerToken = (m: IMember) => jwt.sign({ _id: String(m._id), memberId: String(m._id), partnerId: String(m.partnerId), userType: 'partner' }, CONFIG.JWT_SECRET_KEY);
  const adminToken = jwt.sign({ _id: ADMIN, userType: 'admin' }, CONFIG.JWT_SECRET_KEY);
  const doctorToken = jwt.sign({ _id: doctorId, specialistId: doctorId, userType: 'specialist' }, CONFIG.JWT_SECRET_KEY);
  const u = await UserModel.create({ phone: nextPhone(), name: 'Asha', userType: 'user', otpVerified: true } as any);
  const userToken = jwt.sign({ _id: String(u._id), userType: 'user', authVersion: 0 }, CONFIG.JWT_SECRET_KEY);
  const call = async (method: string, p: string, token: string, body?: unknown) => {
    const r = await fetch(base + p, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json: any = {};
    try { json = JSON.parse(text); } catch { /* csv */ }
    return { status: r.status, json, text, type: r.headers.get('content-type') ?? '', disposition: r.headers.get('content-disposition') ?? '' };
  };

  try {
    await check('HTTP partner workspace: finance readers see balance/statement/CSV masked; branch-limited and non-finance staff cannot; owner sets the destination', async () => {
      const s = await call('GET', '/api/v1/partner-workspace/finance', partnerToken(accountant));
      assert.equal(s.status, 200);
      assert.equal(s.json.data.balanceMinor, await ledgerBalance(L));
      assert.equal(s.json.data.account.payoutDetails.accountNumber, undefined);
      assert.equal((await call('GET', '/api/v1/partner-workspace/finance/statement?limit=2', partnerToken(accountant))).json.data.lines.length, 2);
      const c = await call('GET', `/api/v1/partner-workspace/finance/statement.csv?from=${addDays(today, -1)}&to=${today}`, partnerToken(accountant));
      assert.equal(c.status, 200);
      assert.match(c.type, /text\/csv/);
      assert.match(c.disposition, /attachment; filename="partner-statement-/);
      assert.equal((await call('GET', '/api/v1/partner-workspace/finance/payouts', partnerToken(accountant))).status, 200);
      assert.ok((await call('GET', '/api/v1/partner-workspace/finance/events', partnerToken(accountant))).json.data.length > 0);
      assert.equal((await call('GET', '/api/v1/partner-workspace/finance/events', partnerToken(desk))).status, 403);
      assert.equal((await call('GET', '/api/v1/partner-workspace/finance', partnerToken(branchFinance))).status, 403);
      assert.equal((await call('GET', '/api/v1/partner-workspace/finance', partnerToken(desk))).status, 403);
      assert.equal((await call('PUT', '/api/v1/partner-workspace/finance/payout-details', partnerToken(accountant), bank)).status, 403);
      assert.equal((await call('PUT', '/api/v1/partner-workspace/finance/payout-details', partnerToken(owner), { method: 'upi', upiId: 'x' })).status, 400);
      assert.equal((await call('PUT', '/api/v1/partner-workspace/finance/payout-details', partnerToken(owner), { method: 'upi', upiId: 'metro@icici', ifsc: 'X' })).status, 400, 'bank fields refused for UPI');
      const put = await call('PUT', '/api/v1/partner-workspace/finance/payout-details', partnerToken(owner), bank);
      assert.equal(put.status, 200);
      assert.equal(put.json.data.payoutDetailsState, 'unverified');
      assert.equal((await call('GET', '/api/v1/settlements/accounts', partnerToken(owner))).status, 403, 'partners never reach admin finance');
    });

    await check('HTTP admin as owner: the workspace finance routes for any partner (full destination for the admin)', async () => {
      const s = await call('GET', `/api/v1/partner-workspace/admin/${partnerId}/workspace/finance`, adminToken);
      assert.equal(s.status, 200);
      assert.equal(s.json.data.account.payoutDetails.accountNumber, '123456789012');
      const put = await call('PUT', `/api/v1/partner-workspace/admin/${partnerId}/workspace/finance/payout-details`, adminToken, { ...bank, bankName: 'HDFC' });
      assert.equal(put.status, 200);
      assert.ok(await PartnerAuditEventModel.exists({ partnerId, action: 'finance.payout_details_changed', actorKind: 'admin' }));
    });

    await check('HTTP admin: queue, account (full), verify, record (201, replay 200), void, adjust, payouts list, events; customers and doctors refused', async () => {
      const q = await call('GET', '/api/v1/settlements/accounts?due=true&ownerKind=partner', adminToken);
      assert.equal(q.status, 200);
      assert.ok(q.json.data.rows.some((r: any) => r._id === L));
      const acct = await call('GET', `/api/v1/settlements/accounts/${L}`, adminToken);
      const version = acct.json.data.account.payoutDetailsVersion;
      assert.equal((await call('POST', `/api/v1/settlements/accounts/${L}/payout-details/verify`, adminToken, { version })).status, 200);
      const body = { amountMinor: 1000, method: 'bank_transfer', reference: 'UTR-HTTP-01', paidOn: today, detailsVersion: version, requestKey: 'http-key-0001' };
      const r1 = await call('POST', `/api/v1/settlements/accounts/${L}/payouts`, adminToken, body);
      assert.equal(r1.status, 201);
      assert.equal((await call('POST', `/api/v1/settlements/accounts/${L}/payouts`, adminToken, body)).status, 200);
      assert.equal((await call('POST', `/api/v1/settlements/accounts/${L}/payouts`, adminToken, { ...body, amountMinor: 0, requestKey: 'http-key-0002' })).status, 400);
      assert.equal((await call('POST', `/api/v1/settlements/payouts/${r1.json.data.payout._id}/void`, adminToken, { reason: 'Duplicate entry' })).status, 200);
      assert.equal((await call('POST', `/api/v1/settlements/accounts/${L}/adjustments`, adminToken, { amountMinor: -500, reason: 'Courier charge', requestKey: 'http-adj-0001' })).status, 201);
      const list = await call('GET', `/api/v1/settlements/payouts?accountId=${L}&state=voided`, adminToken);
      assert.ok(list.json.data.some((p: any) => p.reference === 'UTR-HTTP-01'));
      assert.ok(list.json.data.every((p: any) => p.requestKey === undefined));
      assert.ok((await call('GET', `/api/v1/settlements/accounts/${L}/events`, adminToken)).json.data.length >= 5);
      const csv = await call('GET', `/api/v1/settlements/accounts/${L}/statement.csv`, adminToken);
      assert.equal(csv.status, 200);
      assert.equal((await call('GET', `/api/v1/settlements/accounts/${new Types.ObjectId()}`, adminToken)).status, 404);
      assert.equal((await call('GET', '/api/v1/settlements/accounts', userToken)).status, 403);
      assert.equal((await call('GET', '/api/v1/settlements/accounts', doctorToken)).status, 403);
    });

    await check('HTTP doctor: own balance/statement/history/payouts; setting the destination; nothing is created by reading', async () => {
      const other = new Types.ObjectId().toString();
      await SpecialistModel.collection.insertOne({ _id: new Types.ObjectId(other), name: 'Dr New', phone: nextPhone(), specialization: 'GP', isActive: true, isVerified: true } as never);
      const newToken = jwt.sign({ _id: other, specialistId: other, userType: 'specialist' }, CONFIG.JWT_SECRET_KEY);
      const empty = await call('GET', '/api/v1/specialists/me/finance', newToken);
      assert.equal(empty.status, 200);
      assert.equal(empty.json.data.account, null);
      assert.equal(await SettlementAccountModel.countDocuments({ ownerKind: 'doctor', ownerId: other }), 0);
      const set = await call('PUT', '/api/v1/specialists/me/finance/payout-details', newToken, { method: 'upi', upiId: 'dr.new@okaxis' });
      assert.equal(set.status, 200);
      assert.equal(await SettlementAccountModel.countDocuments({ ownerKind: 'doctor', ownerId: other }), 1);

      const mine = await call('GET', '/api/v1/specialists/me/finance', doctorToken);
      assert.equal(mine.json.data.balanceMinor, 999999);
      assert.equal(mine.json.data.totals.earnedMinor, 999999);
      assert.match((await call('GET', '/api/v1/specialists/me/finance/statement', doctorToken)).json.data.lines[0].description, /^Consultation/);
      assert.equal((await call('GET', '/api/v1/specialists/me/finance/history', doctorToken)).json.data.length, 1);
      assert.equal((await call('GET', '/api/v1/specialists/me/finance/payouts', doctorToken)).status, 200);
      assert.equal((await call('GET', '/api/v1/specialists/me/finance/statement.csv', doctorToken)).status, 200);
      assert.equal((await call('GET', '/api/v1/specialists/me/finance', userToken)).status, 403);
      assert.equal((await call('GET', '/api/v1/specialists/me/finance', partnerToken(owner))).status, 403);
    });
  } finally {
    server.close();
  }

  await mongoose.disconnect();
  removeFixtureDir();
  console.log(`\n${passed} checks passed`);
}

main().catch(async (e) => { console.error(e); await mongoose.disconnect(); try { removeFixtureDir(); } catch { /* already gone */ } process.exit(1); });
