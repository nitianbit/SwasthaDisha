/**
 * r33 (ASSISTED_BOOKING_DESIGN.md §26.16): the referral API gaps found by the WQ26 screens —
 * - the admin and booker referral answers report the switches (`cutsEnabled`, `payoutsEnabled`);
 * - referral statement lines carry `shortRef` and `category` as fields (a lab booking stays one row, its cut lines listed,
 *   `mixed` when their categories differ); provider rows are unchanged; never a patient name;
 * - the referral statement CSV (the finance CSV: same columns), for pharmacies and labs;
 * - M17: a lab's referral reads (`/partner-workspace/assisted/referral*`): lab members with `finance.view` and partner-wide
 *   scope, admins acting as owner; branch-limited members, members without the permission, clinics and pharmacies are
 *   refused; no doctor routes (doctor cuts stay off).
 *
 * Every check runs even when an earlier one fails (the run exits 1 if any failed).
 *
 * Run (throwaway DB only; the script drops its database):
 *   JWT_SECRET_KEY=local-integration-only SESSION_ORIGINS_CUSTOMER=https://app.jansetu.test SESSION_ORIGINS_WORKSPACE=https://staff.jansetu.test \
 *     MONGODB_URL='mongodb://127.0.0.1:27917/r33_referral_gaps_check?directConnection=true' npx tsx test/assisted/r33-referral-gaps.integration.ts
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
import { UserRepository } from '@/modules/user/repository';
import BookingModel from '@/modules/bookings/model';
import PharmacyModel from '@/modules/pharmacies/model';
import { PharmacyService } from '@/modules/pharmacies/services';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import { BannerService } from '@/modules/banners/services';
import { BannerRepository } from '@/modules/banners/repository';
import { PartnerRepository } from '@/modules/partners/repository';
import { MemberRepository } from '@/modules/partners/repository/member';
import { BranchRepository } from '@/modules/partners/repository/branch';
import { PartnerService, type PartnerActor } from '@/modules/partners/services';
import { PartnerLabBookingModel } from '@/modules/partners/model/labBooking';
import { ensureSettlementAccount, postLedgerEntry } from '@/modules/partners/services/settlement';
import { statementPage } from '@/modules/partners/services/finance';
import { runLedgerTransaction } from '@/modules/common/utils/bookingWalletFunding';
import { postReferralEarningIn } from '@/modules/referralCuts/service';
import type { IMember, PartnerPermission } from '@/modules/partners/types';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/r33_referral_gaps_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const oid = () => new Types.ObjectId().toHexString();
const partnerSvc = new PartnerService(new PartnerRepository(), new MemberRepository(), new BranchRepository());
Container.set(PartnerService, partnerSvc);
Container.set(PharmacyService, new PharmacyService(new PharmacyRepository(), new UserRepository()));
Container.set(BannerService, new BannerService(new BannerRepository()));

let passed = 0;
const failed: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log('ok -', name); } catch (e) { failed.push(name); console.log('FAIL -', name); console.error(e); }
}
const actorFor = (m: IMember): PartnerActor => ({ memberId: String(m._id), partnerId: String(m.partnerId), role: m.role,
  permissions: m.permissions as PartnerPermission[], branchIds: (m.branchIds ?? []).map(String) });
let phoneSeq = 7330000000;
const nextPhone = () => String(phoneSeq++);
const PATIENT = 'Rina Kumari Das';

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
  process.env.ASSISTED_ADMIN_TOOLS_ENABLED = 'true';
  const flag = (name: string, on: boolean) => { if (on) process.env[name] = 'true'; else delete process.env[name]; };
  flag('REFERRAL_CUTS_ENABLED', false);
  flag('REFERRAL_PAYOUTS_ENABLED', false);

  try {
    // ── A pharmacy, a verified lab with a branch and staff, a second lab, a clinic ──
    const P = oid(); const Q = oid(); const ADMIN = oid(); const D = oid();
    await PharmacyModel.collection.insertMany([
      { _id: new Types.ObjectId(P), name: 'Sharma Medicals', phone: '9700003301', city: 'Shillong', isActive: true, isVerified: true },
      { _id: new Types.ObjectId(Q), name: 'Other Pharmacy', phone: '9700003302', city: 'Aizawl', isActive: true, isVerified: true },
    ] as never);
    const mkPartner = async (name: string, gstin: string, kind: 'lab' | 'clinic' = 'lab') => {
      const { partner, owner } = await partnerSvc.createPartner({ kind, name, legalName: name, contactPhone: nextPhone(), invoiceSeriesPrefix: name.slice(0, 2).toUpperCase(),
        firstOwner: { phone: nextPhone(), name: `${name} Owner` }, taxRegime: 'regular', gstin, contactEmail: `${name.toLowerCase().replace(/\s/g, '')}@lab.test` } as never);
      await partnerSvc.verifyPartner(String(partner._id), 'admin');
      return { id: String(partner._id), owner };
    };
    const lab = await mkPartner('Metro Labs', '29AABCM1234F1ZH');
    const L = lab.id;
    const own = actorFor(lab.owner);
    const branch = String((await partnerSvc.createBranch(own, { name: 'Police Bazar', phone: '9876500000', holidays: [], hours: {},
      services: { homeCollection: true, inLab: true, inClinic: false }, address: { line1: '1 Road', city: 'Shillong', state: 'Meghalaya', stateCode: '17', pincode: '793001' } } as never))._id);
    const finance = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Accounts', role: 'staff', permissions: ['finance.view'], branchIds: [] } as never);
    const branchFinance = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Branch Accounts', role: 'staff', permissions: ['finance.view'], branchIds: [branch] } as never);
    const desk = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Desk', role: 'staff', permissions: ['bookings.view'], branchIds: [] } as never);
    const lab2 = await mkPartner('Far Labs', '29AABCM1234F1ZX');
    const clinic = await mkPartner('City Clinic', '29AABCM1234F1ZY', 'clinic');

    const sign = (claims: object) => jwt.sign(claims, CONFIG.JWT_SECRET_KEY, { expiresIn: '1h' });
    const member = (m: { _id: unknown }, partnerId: string) => sign({ _id: String(m._id), memberId: String(m._id), partnerId, userType: 'partner' });
    const tokens: Record<string, string> = {
      P: sign({ _id: P, pharmacyId: P, userType: 'pharmacy' }), Q: sign({ _id: Q, pharmacyId: Q, userType: 'pharmacy' }),
      ADMIN: sign({ _id: ADMIN, userType: 'admin' }), D: sign({ _id: D, specialistId: D, userType: 'specialist' }),
      LO: member(lab.owner, L), LF: member(finance, L), LBF: member(branchFinance, L), LD: member(desk, L),
      L2: member(lab2.owner, lab2.id), C: member(clinic.owner, clinic.id),
    };
    const call = async (who: string | null, method: string, url: string, body?: unknown) => {
      const r = await fetch(base + url, { method, headers: { ...(who ? { authorization: `Bearer ${tokens[who] ?? who}` } : {}), 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      let json: any; try { json = JSON.parse(text); } catch { json = { text }; }
      return { status: r.status, json, text, type: r.headers.get('content-type') ?? '', disposition: r.headers.get('content-disposition') ?? '' };
    };
    const expect = async (who: string | null, method: string, url: string, status: number, body?: unknown, errCode?: string) => {
      const r = await call(who, method, url, body);
      assert.equal(r.status, status, `${who} ${method} ${url}: ${r.status} ${r.text.slice(0, 400)}`);
      if (errCode) assert.equal(r.json.code, errCode, `${who} ${method} ${url}: ${r.text.slice(0, 400)}`);
      return r;
    };
    const RULES = '/api/v1/admin/referral-rules';
    const PA = '/api/v1/pharmacy-assisted';
    const LW = '/api/v1/partner-workspace/assisted';

    // ── Referral earnings, posted as completion posts them (the booking flows are the r24 and 2e suites') ──
    const at = (n: number) => new Date(Date.UTC(2026, 10, 20 + n, 6, 0, 0));
    const earn = async (ownerKind: 'pharmacy_referral' | 'lab_referral', ownerId: string, source: 'referral_consultation' | 'referral_lab_booking',
      bookingId: string, cutMinor: number, baseMinor: number) => {
      const account = await ensureSettlementAccount(ownerKind, ownerId, 'Booker');
      await runLedgerTransaction((s) => postReferralEarningIn({ _id: bookingId, assisted: { referral: { accountId: String(account._id), ownerKind,
        bookerKind: ownerKind === 'lab_referral' ? 'lab' : 'pharmacy', bookerId: ownerId, cutMinor }, split: { baseMinor } } } as never, source, s,
      { by: 'system', byKind: 'system' }));
      return String(account._id);
    };
    const C1 = oid(); const LB1 = oid(); const LB2 = oid(); const C2 = oid();
    await BookingModel.collection.insertMany([
      { _id: new Types.ObjectId(C1), bookingType: 'consultation', bookingKind: 'scheduled', bookingDate: '20261120', bookingTime: '10:00', patientName: PATIENT,
        status: 'completed', assisted: { shortRef: 'ABCD2345' }, createdAt: at(0) },
      { _id: new Types.ObjectId(C2), bookingType: 'consultation', bookingKind: 'instant', bookingDate: '20261122', bookingTime: '11:00', patientName: PATIENT,
        status: 'completed', assisted: { shortRef: 'LABC4444' }, createdAt: at(2) },
    ] as never);
    const line = (category: string | null, baseMinor: number, cutMinor: number) => ({ catalogItemId: oid(), listMinor: baseMinor, discountMinor: 0, baseMinor, cutMinor,
      ...(category ? { category } : {}) });
    await PartnerLabBookingModel.collection.insertMany([
      { _id: new Types.ObjectId(LB1), partnerId: L, slot: { date: '2026-11-23', startTime: '09:00' }, patient: { name: PATIENT }, status: 'completed',
        assisted: { shortRef: 'LMNO2222', split: { baseMinor: 120000, cutMinor: 5500, lines: [line('lab_test', 30000, 1500), line('lab_package', 80000, 4000), line(null, 10000, 0)] } } },
      { _id: new Types.ObjectId(LB2), partnerId: L, slot: { date: '2026-11-24', startTime: '09:00' }, patient: { name: PATIENT }, status: 'completed',
        assisted: { shortRef: 'TEST3333', split: { baseMinor: 30000, cutMinor: 1500, lines: [line('lab_test', 20000, 1000), line('lab_test', 10000, 500)] } } },
    ] as never);
    const pAccount = await earn('pharmacy_referral', P, 'referral_consultation', C1, 5000, 50000);
    await earn('pharmacy_referral', P, 'referral_lab_booking', LB1, 5500, 120000);
    await earn('pharmacy_referral', P, 'referral_lab_booking', LB2, 1500, 30000);
    await earn('lab_referral', L, 'referral_consultation', C2, 3000, 40000);
    // The doctor's own (provider) row for C1: unchanged by r33.
    const dAccount = await ensureSettlementAccount('doctor', D, 'Dr Rao');
    await runLedgerTransaction((s) => postLedgerEntry({ settlementAccountId: String(dAccount._id), kind: 'earning', amountMinor: 45000, grossMinor: 50000,
      commissionMinor: 5000, source: 'consultation', sourceId: C1, by: 'system', byKind: 'system' }, s));

    await check('switches: the admin and booker rule lists report cutsEnabled and payoutsEnabled; the totals carry both', async () => {
      await expect('ADMIN', 'PUT', `${RULES}/pharmacy/${P}/consultation`, 200, { basis: 'percent', percentBasisPoints: 1000, isActive: true, expectedVersion: 0, reason: 'setup' });
      await expect('ADMIN', 'PUT', `${RULES}/lab/${L}/consultation`, 200, { basis: 'fixed', fixedMinor: 3000, isActive: true, expectedVersion: 0, reason: 'setup' });
      const off = await expect('ADMIN', 'GET', `${RULES}?bookerKind=pharmacy&bookerId=${P}`, 200);
      assert.deepEqual(off.json.switches, { cutsEnabled: false, payoutsEnabled: false });
      assert.equal(off.json.data[0].effective, false);
      flag('REFERRAL_CUTS_ENABLED', true);
      assert.deepEqual((await expect('ADMIN', 'GET', `${RULES}?bookerKind=lab&bookerId=${L}`, 200)).json.switches, { cutsEnabled: true, payoutsEnabled: false });
      // With no rule at all, the switch is still told.
      const none = await expect('Q', 'GET', `${PA}/referral-rules`, 200);
      assert.deepEqual(none.json.data, []);
      assert.deepEqual(none.json.switches, { cutsEnabled: true, payoutsEnabled: false });
      flag('REFERRAL_PAYOUTS_ENABLED', true);
      assert.deepEqual((await expect('P', 'GET', `${PA}/referral`, 200)).json.data, { earnedMinor: 12000, paidMinor: 0, dueMinor: 12000, cutsEnabled: true, payoutsEnabled: true });
      flag('REFERRAL_PAYOUTS_ENABLED', false);
      assert.deepEqual((await expect('Q', 'GET', `${PA}/referral`, 200)).json.data, { earnedMinor: 0, paidMinor: 0, dueMinor: 0, cutsEnabled: true, payoutsEnabled: false });
    });

    await check('statement fields: shortRef and category on referral rows; a lab booking stays one row with its cut lines (mixed or one category); no patient name', async () => {
      const lines = (await expect('P', 'GET', `${PA}/referral/statement`, 200)).json.data as any[];
      assert.equal(lines.length, 3);
      const by = (id: string) => lines.find((l) => l.sourceId === id);
      const c = by(C1);
      assert.deepEqual([c.shortRef, c.category, c.grossMinor, c.amountMinor, 'lines' in c], ['ABCD2345', 'consultation', 50000, 5000, false]);
      assert.equal(c.description, 'Referral · consultation · 2026-11-20 · Ref ABCD2345');
      const mixed = by(LB1);
      assert.deepEqual([mixed.shortRef, mixed.category, mixed.amountMinor], ['LMNO2222', 'mixed', 5500]);
      assert.deepEqual(mixed.lines, [{ category: 'lab_test', baseMinor: 30000, cutMinor: 1500 }, { category: 'lab_package', baseMinor: 80000, cutMinor: 4000 }]);
      const tests = by(LB2);
      assert.deepEqual([tests.shortRef, tests.category, tests.lines.length], ['TEST3333', 'lab_test', 2]);
      assert.ok(!JSON.stringify(lines).includes('Rina'), 'no patient name');
      // Provider rows are unchanged (no referral fields).
      const doctorRow = (await statementPage(await mongoose.model('SettlementAccount').findById(dAccount._id).lean() as never, {})).lines[0]!;
      assert.equal(doctorRow.sourceId, C1);
      assert.ok(!('shortRef' in doctorRow) && !('category' in doctorRow) && !('lines' in doctorRow), JSON.stringify(doctorRow));
    });

    await check('pharmacy CSV: the finance CSV (same columns, opening and closing), the period applied, a named file, no patient name; none for another pharmacy', async () => {
      const r = await expect('P', 'GET', `${PA}/referral/statement.csv`, 200);
      assert.match(r.type, /^text\/csv/);
      assert.equal(r.disposition, 'attachment; filename="pharmacy-referral-statement.csv"');
      const rows = r.text.trim().split('\n');
      assert.equal(rows[0], '"Date (IST)","Type","Description","Reference","Note","Amount (INR)","Balance (INR)"');
      assert.equal(rows.length, 1 + 1 + 3 + 1);
      assert.ok(rows.some((x) => x.includes('Ref ABCD2345') && x.includes('"50.00"')), r.text);
      assert.ok(rows[rows.length - 1]!.includes('"Closing balance"') && rows[rows.length - 1]!.includes('"120.00"'), r.text);
      assert.ok(!r.text.includes('Rina'));
      const today = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10);
      const period = await expect('P', 'GET', `${PA}/referral/statement.csv?from=${today}&to=${today}`, 200);
      assert.equal(period.disposition, `attachment; filename="pharmacy-referral-statement-${today}-to-${today}.csv"`);
      await expect('P', 'GET', `${PA}/referral/statement.csv?from=2026-13-01`, 400);
      assert.equal((await expect('Q', 'GET', `${PA}/referral/statement.csv`, 200)).text.trim().split('\n').length, 1);
      assert.ok(pAccount);
    });

    await check('lab reads (M17): finance members and owners read the lab’s rates, totals, statement and CSV; admins as owner too', async () => {
      const rules = await expect('LF', 'GET', `${LW}/referral-rules`, 200);
      assert.equal(rules.json.data.length, 1);
      assert.deepEqual([rules.json.data[0].category, rules.json.data[0].fixedMinor, rules.json.data[0].effective], ['consultation', 3000, true]);
      assert.ok(!('updatedBy' in rules.json.data[0]));
      assert.deepEqual(rules.json.switches, { cutsEnabled: true, payoutsEnabled: false });
      assert.deepEqual((await expect('LO', 'GET', `${LW}/referral`, 200)).json.data, { earnedMinor: 3000, paidMinor: 0, dueMinor: 3000, cutsEnabled: true, payoutsEnabled: false });
      const st = await expect('LF', 'GET', `${LW}/referral/statement?limit=10`, 200);
      assert.equal(st.json.data.length, 1);
      assert.deepEqual([st.json.data[0].shortRef, st.json.data[0].category], ['LABC4444', 'consultation']);
      assert.equal(st.json.data[0].description, 'Referral · instant consultation · 2026-11-22 · Ref LABC4444');
      assert.equal(st.json.pagination.nextCursor, null);
      const csv = await expect('LF', 'GET', `${LW}/referral/statement.csv`, 200);
      assert.equal(csv.disposition, 'attachment; filename="lab-referral-statement.csv"');
      assert.ok(csv.text.includes('Ref LABC4444') && !csv.text.includes('Rina'));
      const admin = await expect('ADMIN', 'GET', `/api/v1/partner-workspace/admin/${L}/workspace/assisted/referral`, 200);
      assert.equal(admin.json.data.earnedMinor, 3000);
      // Another lab sees only its own (nothing yet).
      assert.deepEqual((await expect('L2', 'GET', `${LW}/referral`, 200)).json.data, { earnedMinor: 0, paidMinor: 0, dueMinor: 0, cutsEnabled: true, payoutsEnabled: false });
      assert.deepEqual((await expect('L2', 'GET', `${LW}/referral/statement`, 200)).json.data, []);
    });

    await check('lab reads refused: a branch-limited finance member, a member without finance.view, a clinic, a pharmacy; no doctor routes', async () => {
      await expect('LBF', 'GET', `${LW}/referral`, 403, undefined, 'FINANCE_SCOPE_REQUIRED');
      await expect('LBF', 'GET', `${LW}/referral/statement.csv`, 403, undefined, 'FINANCE_SCOPE_REQUIRED');
      assert.equal((await call('LD', 'GET', `${LW}/referral-rules`)).status, 403);
      assert.equal((await call('LD', 'GET', `${LW}/referral/statement`)).status, 403);
      await expect('C', 'GET', `${LW}/referral`, 403, undefined, 'LAB_PARTNER_REQUIRED');
      await expect('C', 'GET', `${LW}/referral-rules`, 403, undefined, 'LAB_PARTNER_REQUIRED');
      assert.ok([401, 403].includes((await call('P', 'GET', `${LW}/referral`)).status));
      assert.ok([401, 403].includes((await call('LF', 'GET', `${PA}/referral`)).status));
      assert.equal((await call('D', 'GET', '/api/v1/specialists/me/assisted/referral')).status, 404);
      assert.equal((await call('D', 'GET', '/api/v1/specialists/me/finance/referral')).status, 404);
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
