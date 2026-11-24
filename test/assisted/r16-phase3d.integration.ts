/**
 * Phase 3d (ASSISTED_BOOKING_DESIGN.md §25.7, decided 25 Nov): a doctor's recommended tests get an 8-character code with
 * a check character when the prescription is saved (best effort), printed in a Jansetu box on the PDF and on the
 * dispensing copy; `testsAdvised` stays filled. Pharmacies, lab desks and doctors load the test names by the code AND the
 * patient's mobile number (counted as a lookup, audited, one 404 for everything else). The recommending doctor never
 * reads the report of a lab test someone else booked. Real routes over HTTP (configureRoutes) on MongoDB; wkhtmltopdf is
 * replaced by a script that copies its HTML input, so the "PDF" can be read back.
 *
 * Every check runs even when an earlier one fails (the run exits 1 if any failed).
 *
 * Run (throwaway DB only; the script drops its database):
 *   JWT_SECRET_KEY=local-integration-only SESSION_ORIGINS_CUSTOMER=https://app.jansetu.test SESSION_ORIGINS_WORKSPACE=https://staff.jansetu.test \
 *     MONGODB_URL='mongodb://127.0.0.1:27917/r16_phase3d_check?directConnection=true' npx tsx test/assisted/r16-phase3d.integration.ts
 */
import { FIXTURE_DIR, UPLOAD_DIR, removeFixtureDir } from '../partners/q3-fixture-dir';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
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
import { PaymentRepository } from '@/modules/payment/repository';
import { PaymentService } from '@/modules/payment/services';
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
import PartnerModel from '@/modules/partners/model';
import { PartnerSlotModel } from '@/modules/partners/model/slot';
import PartnerAuditEventModel from '@/modules/partners/model/audit';
import MemberModel from '@/modules/partners/model/member';
import { PartnerRepository } from '@/modules/partners/repository';
import { MemberRepository } from '@/modules/partners/repository/member';
import { BranchRepository } from '@/modules/partners/repository/branch';
import { CatalogueItemRepository } from '@/modules/partners/repository/catalogueItem';
import { PartnerService, type PartnerActor } from '@/modules/partners/services';
import { CatalogueService } from '@/modules/partners/services/catalogue';
import { LabBookingService } from '@/modules/partners/services/labBookings';
import { runLedgerTransaction } from '@/modules/common/utils/bookingWalletFunding';
import { canonicalJson } from '@/modules/common/utils/canonicalJson';
import { resetIndexChecks } from '@/modules/common/utils/requiredIndex';
import { AssistedAuditEventModel, AssistedCounterModel } from '@/modules/assisted/model';
import { setAssistedNotifier } from '@/modules/assisted/support';
import { dispensingHashOf } from '@/modules/assisted/dispensingCopy';
import { TestRecommendationModel } from '@/modules/testRecommendations/model';
import { formatRecommendationCode, newRecommendationCode, normalizeRecommendationCode } from '@/modules/testRecommendations/code';
import type { IMember, PartnerPermission } from '@/modules/partners/types';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/r16_phase3d_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const oid = () => new Types.ObjectId().toHexString();
const MIN = 60_000;
const IST = 330 * MIN;
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Today in India, YYYYMMDD (the consultations below happen today, inside the booker's 90-day prescription window). */
const TODAY = new Date(Date.now() + 330 * 60_000).toISOString().slice(0, 10).replace(/-/g, '');

// The converter stand-in: copies its HTML input to the PDF path, so the printed content can be read back.
const CONVERTER = path.join(FIXTURE_DIR, 'fake-wkhtmltopdf.sh');
/** While this file exists the converter fails (a PDF that cannot be written). */
const FAIL_MARK = path.join(FIXTURE_DIR, 'converter-fails');
fs.writeFileSync(CONVERTER, `#!/bin/sh\n[ -f '${FAIL_MARK}' ] && exit 3\ncp "$1" "$2"\n`, { mode: 0o755 });
process.env.WKHTMLTOPDF_BINARY = CONVERTER;
const read = (url: string) => fs.readFileSync(path.join(UPLOAD_DIR, url.replace(/^\/api\/static\//, '')), 'utf8');

// ── Services (tsx emits no decorator metadata: wired by hand before the routers load) ──
const payments = Object.assign(Object.create(PaymentService.prototype), {
  bookingRepository: new BookingRepository(), paymentRepository: new PaymentRepository(), walletRepository: new WalletRepository(),
  walletTransactionRepository: new WalletTransactionRepository(),
  getRazorpayClient: () => ({ orders: { fetchPayments: async () => ({ items: [] }) } }), getRazorpayCredentials: () => ({ keyId: 'k', keySecret: 's' }),
}) as unknown as PaymentService;
const partnerSvc = new PartnerService(new PartnerRepository(), new MemberRepository(), new BranchRepository());
const catalogueSvc = new CatalogueService(new CatalogueItemRepository());
const labSvc = new LabBookingService(payments, new CouponService(new CouponRepository()), new WalletRepository());
labSvc.notify = async () => undefined;
const specialists = { getById: async (id: string) => SpecialistModel.findById(id).lean() };
Container.set(PartnerService, partnerSvc);
Container.set(CatalogueService, catalogueSvc);
Container.set(LabBookingService, labSvc);
Container.set(PaymentService, payments);
Container.set(PharmacyService, new PharmacyService(new PharmacyRepository(), new UserRepository()));
Container.set(BannerService, new BannerService(new BannerRepository()));
Container.set(SpecialistService, specialists as never);
Container.set(SpecialistPortalService, Object.assign(Object.create(SpecialistPortalService.prototype), {
  bookingRepository: new BookingRepository(), userRepository: new UserRepository(), specialistService: specialists,
  notificationService: new Proxy({}, { get: () => async () => undefined }),
}));
setAssistedNotifier(async () => undefined);

let passed = 0;
const failed: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log('ok -', name); } catch (e) { failed.push(name); console.log('FAIL -', name); console.error(e); }
}
const actorFor = (m: IMember): PartnerActor => ({ memberId: String(m._id), partnerId: String(m.partnerId), role: m.role,
  permissions: m.permissions as PartnerPermission[], branchIds: (m.branchIds ?? []).map(String) });
let phoneSeq = 7160000000;
const nextPhone = () => String(phoneSeq++);
let keySeq = 0;
const newKey = () => `r16-key-${String(++keySeq).padStart(4, '0')}-${oid().slice(-6)}`;

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
  process.env.ASSISTED_LAB_BOOKING_ENABLED_PHARMACY = 'true';
  const on = () => { process.env.TEST_RECOMMENDATIONS_ENABLED = 'true'; };
  const off = () => { delete process.env.TEST_RECOMMENDATIONS_ENABLED; };

  try {
    // ── A lab (verified) with a branch and a test, an unverified lab, a clinic ──
    const { partner, owner } = await partnerSvc.createPartner({
      kind: 'lab', name: 'Metro Labs', legalName: 'Metro Labs Pvt Ltd', contactPhone: nextPhone(), invoiceSeriesPrefix: 'ML',
      firstOwner: { phone: nextPhone(), name: 'Owner' }, taxRegime: 'regular', gstin: '29AABCM1234F1ZH',
    } as never);
    const L = String(partner._id);
    await partnerSvc.verifyPartner(L, 'admin');
    const own = actorFor(owner);
    const A = String((await partnerSvc.createBranch(own, { name: 'Police Bazar', phone: '9876500000', holidays: [], hours: {},
      services: { homeCollection: true, inLab: true, inClinic: false }, address: { line1: '1 Road', city: 'Shillong', state: 'Meghalaya', stateCode: '17', pincode: '793001' } } as never))._id);
    // The owner releases reports under its own registration.
    await MemberModel.updateOne({ _id: owner._id }, { $set: { professional: { kind: 'pathologist', registrationNumber: 'MMC-1' } } });
    const frontDesk = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Desk', role: 'staff', permissions: ['bookings.manage'] } as never);
    const viewer = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Viewer', role: 'staff', permissions: ['bookings.view'] } as never);
    const cbc = String((await catalogueSvc.createItem(own, { kind: 'test', name: 'CBC', priceMinor: 50000, gstRate: 0, visitModes: ['lab'], reportTatHours: 24 } as never))._id);
    const unverified = await partnerSvc.createPartner({ kind: 'lab', name: 'New Labs', legalName: 'New Labs', contactPhone: nextPhone(), invoiceSeriesPrefix: 'NL',
      firstOwner: { phone: nextPhone(), name: 'Owner Two' }, taxRegime: 'regular', gstin: '29AABCM1234F1ZY' } as never);
    const LU = String(unverified.partner._id);
    const CL = oid();
    await PartnerModel.collection.insertOne({ _id: new Types.ObjectId(CL), kind: 'clinic', name: 'A Clinic', isActive: true, verification: { state: 'verified' } } as never);

    // ── Pharmacies, the patient's account, doctors ──
    const P = oid(); const Q = oid(); const U = oid();
    await PharmacyModel.collection.insertMany([
      { _id: new Types.ObjectId(P), name: 'Sharma Medicals', phone: '9700000501', city: 'Shillong', pincode: '793001', isActive: true, isVerified: true },
      { _id: new Types.ObjectId(Q), name: 'Other Pharmacy', phone: '9700000502', city: 'Aizawl', isActive: true, isVerified: true },
      { _id: new Types.ObjectId(U), name: 'Unverified Pharmacy', phone: '9700000503', isActive: true, isVerified: false },
    ] as never);
    const X = oid(); const Y = oid(); const ADMIN = oid();
    const PHONE_X = '9600000501';
    await UserModel.collection.insertMany([
      { _id: new Types.ObjectId(X), userType: 'user', phone: PHONE_X, name: 'Rina Kumari Das', createdSource: 'self_signup', otpVerified: true },
      { _id: new Types.ObjectId(Y), userType: 'user', phone: '9600000502', name: 'Bikash Thapa', createdSource: 'self_signup', otpVerified: true },
    ] as never);
    const D = oid(); const E = oid(); const DU = oid();
    await SpecialistModel.collection.insertMany([
      { _id: new Types.ObjectId(D), name: 'Dr Asha Menon', phone: '9800000501', medicalRegistrationNumber: 'KMC-1', isActive: true, isVerified: true },
      { _id: new Types.ObjectId(E), name: 'Dr Other', phone: '9800000502', isActive: true, isVerified: true },
      { _id: new Types.ObjectId(DU), name: 'Dr Pending', phone: '9800000503', isActive: true, isVerified: false },
    ] as never);
    await runLedgerTransaction((s) => postPharmacyMovementIn({ pharmacyId: P, kind: 'credit', amountPaise: 1_000_000, operationKey: `seed:${oid()}`,
      referenceType: 'admin_topup', referenceId: oid(), description: 'seed' }, s));

    const sign = (claims: object) => jwt.sign(claims, CONFIG.JWT_SECRET_KEY, { expiresIn: '1h' });
    const tokens: Record<string, string> = {
      P: sign({ _id: P, pharmacyId: P, userType: 'pharmacy' }), Q: sign({ _id: Q, pharmacyId: Q, userType: 'pharmacy' }),
      U: sign({ _id: U, pharmacyId: U, userType: 'pharmacy' }),
      X: sign({ _id: X, userType: 'user', authVersion: 0 }), ADMIN: sign({ _id: ADMIN, userType: 'admin' }),
      D: sign({ _id: D, specialistId: D, userType: 'specialist' }), E: sign({ _id: E, specialistId: E, userType: 'specialist' }),
      DU: sign({ _id: DU, specialistId: DU, userType: 'specialist' }),
      OWNER: sign({ _id: String(owner._id), memberId: String(owner._id), partnerId: L, userType: 'partner' }),
      DESK: sign({ _id: String(frontDesk._id), memberId: String(frontDesk._id), partnerId: L, userType: 'partner' }),
      VIEWER: sign({ _id: String(viewer._id), memberId: String(viewer._id), partnerId: L, userType: 'partner' }),
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
    const PA = '/api/v1/pharmacy-assisted';
    const SP = '/api/v1/specialists';
    const WS = '/api/v1/partner-workspace';
    const loadUrl = { P: `${PA}/recommendations/lookup`, Q: `${PA}/recommendations/lookup`, U: `${PA}/recommendations/lookup`,
      D: `${SP}/me/assisted/recommendations/lookup`, E: `${SP}/me/assisted/recommendations/lookup`, DU: `${SP}/me/assisted/recommendations/lookup`,
      DESK: `${WS}/lab-desk/recommendations/lookup`, OWNER: `${WS}/lab-desk/recommendations/lookup`, VIEWER: `${WS}/lab-desk/recommendations/lookup` } as Record<string, string>;
    // r16b: the code and the phone travel in the body (never in a logged request line or path).
    const load = (who: string, code: string, phone: string | null = PHONE_X) =>
      call(who, 'POST', loadUrl[who]!, { code, ...(phone === null ? {} : { phone }) });
    const lookups = async (orgKey: string) => (await AssistedCounterModel.find({ _id: { $regex: `^lookups:\\d+:${orgKey}$` } }).lean())
      .reduce((a, r) => a + Number(r.count), 0);

    // Consultations of doctor D with the patient (one booked by pharmacy P, so it has a dispensing copy).
    let seq = 0;
    const consultation = async (f: Record<string, unknown> = {}) => {
      const _id = new Types.ObjectId();
      const at = new Date(Date.now() - 60 * MIN + (++seq) * 1000);
      await BookingModel.collection.insertOne({ _id, bookingType: 'consultation', specialistId: D, doctorName: 'Dr Asha Menon', userId: X,
        bookingDate: TODAY, bookingTime: '10:00 AM', serviceMode: 'video', consultationMode: 'video', price: 300, originalPrice: 300,
        status: 'confirmed', paymentStatus: 'paid', createdAt: at, updatedAt: at, ...f } as never);
      return String(_id);
    };
    const RX = { diagnosis: 'SECRET-DIAGNOSIS', advice: 'Rest', medicines: [{ name: 'Paracetamol 500' }] };
    const save = (bookingId: string, testsAdvised: string[], who = 'D') =>
      expect(who, 'POST', `${SP}/me/appointments/${bookingId}/prescription`, 200, { ...RX, testsAdvised });
    const stored = async (id: string) => await BookingModel.findById(id).select('+prescription.dispensingCopy.hash').lean() as any;

    // ───────────────────────── The code ─────────────────────────
    await check('code: 8 Crockford characters with a Luhn mod 32 check; typed forms normalise; every single wrong character fails; every neighbour swap fails except 0<->Z', async () => {
      for (let i = 0; i < 2000; i++) {
        const c = newRecommendationCode();
        assert.match(c, /^[0-9A-HJKMNP-TV-Z]{8}$/);
        assert.equal(normalizeRecommendationCode(c), c);
      }
      const c = newRecommendationCode();
      const typed = formatRecommendationCode(c).toLowerCase();
      assert.match(formatRecommendationCode(c), /^.{4}-.{4}$/);
      assert.equal(normalizeRecommendationCode(` ${typed} `), c, 'lower case, hyphen and spaces');
      const withO = c.replace(/0/g, 'O').replace(/1/g, 'I');
      assert.equal(normalizeRecommendationCode(withO), c, 'O read as 0, I as 1');
      for (const bad of ['', 'ABC', `${c}0`, 'UUUUUUUU', 12345678 as unknown as string, null as unknown as string]) assert.equal(normalizeRecommendationCode(bad), null);
      // Exhaustive over a sample of codes: substitutions and adjacent swaps.
      for (let n = 0; n < 50; n++) {
        const code = newRecommendationCode();
        for (let i = 0; i < 8; i++) {
          for (const ch of ALPHABET) {
            if (ch === code[i]) continue;
            const sub = code.slice(0, i) + ch + code.slice(i + 1);
            assert.equal(normalizeRecommendationCode(sub), null, `substitution ${code} -> ${sub}`);
          }
          if (i < 7 && code[i] !== code[i + 1]) {
            const swap = code.slice(0, i) + code[i + 1] + code[i] + code.slice(i + 2);
            const blind = new Set([code[i], code[i + 1]]).size === 2 && [code[i], code[i + 1]].sort().join('') === '0Z';
            assert.equal(normalizeRecommendationCode(swap) === null, !blind, `swap ${code} -> ${swap}`);
          }
        }
      }
    });

    // ───────────────────────── Switch off ─────────────────────────
    await check('switch off: the save makes no recommendation and prints no code; every load answers 503 RECOMMENDATIONS_DISABLED', async () => {
      off();
      const b = await consultation();
      const r = await save(b, ['CBC', 'Lipid profile']);
      assert.deepEqual(r.json.data.prescription.testsAdvised, ['CBC', 'Lipid profile']);
      assert.equal(r.json.data.prescription.recommendationCode, undefined);
      assert.equal(await TestRecommendationModel.countDocuments({ consultationId: b }), 0);
      assert.equal(read((await stored(b)).prescription.fileUrls[0]).includes('Recommended tests code'), false);
      const c = newRecommendationCode();
      for (const who of ['P', 'D', 'DESK']) {
        const x = await load(who, c);
        assert.equal(x.status, 503, `${who} ${x.text}`);
        assert.equal(x.json.code, 'RECOMMENDATIONS_DISABLED');
      }
      on();
    });

    // ───────────────────────── The save ─────────────────────────
    let code = ''; let rxBooking = '';
    await check('save: one recommendation from testsAdvised (kept filled); the code is on the prescription, in a Jansetu box on the PDF and on the dispensing copy; the booker view carries it', async () => {
      rxBooking = await consultation({ pharmacyId: P });
      const r = await save(rxBooking, ['CBC', '  Lipid   profile ']);
      code = r.json.data.prescription.recommendationCode;
      assert.equal(normalizeRecommendationCode(code), code);
      assert.deepEqual(r.json.data.prescription.testsAdvised, ['CBC', 'Lipid   profile'], 'testsAdvised as the doctor sent it (trimmed)');
      const rec = await TestRecommendationModel.findOne({ consultationId: rxBooking }).lean() as any;
      assert.equal(rec.code, code);
      assert.equal(rec.status, 'open');
      assert.equal(rec.specialistId, D);
      assert.deepEqual(rec.items, [{ index: 0, name: 'CBC' }, { index: 1, name: 'Lipid profile' }]);
      assert.deepEqual(rec.bookings, []);
      assert.equal(rec.userId, undefined, 'the person is read from the consultation, never stored');
      const b = await stored(rxBooking);
      const pdf = read(b.prescription.fileUrls[0]);
      assert.ok(pdf.includes('Jansetu') && pdf.includes(formatRecommendationCode(code)), 'the full PDF prints the code in the Jansetu box');
      assert.ok(pdf.includes('MyEwaCare'), 'the header brand is unchanged (DR13)');
      const copy = read(b.prescription.dispensingCopy.url);
      assert.ok(copy.includes(formatRecommendationCode(code)) && !copy.includes('SECRET-DIAGNOSIS'), 'the dispensing copy prints the code, never the diagnosis');
      const view = (await expect('P', 'GET', `/api/v1/pharmacy-bookings/${rxBooking}`, 200)).json.data;
      assert.equal(view.prescription.recommendationCode, code);
      assert.deepEqual(view.prescription.testsAdvised, ['CBC', 'Lipid   profile']);
    });

    await check('dispensing copy hash: unchanged for a prescription without a code (copies made before 3d stay current); a code changes it', async () => {
      const row = { specialistId: D, prescription: { medicines: [{ name: 'M' }], advice: 'a', testsAdvised: ['CBC'], prescribedAt: 't', prescribedBySpecialistName: 'Dr' } };
      const before3d = createHash('sha256').update(canonicalJson({ v: 1, specialistId: D, medicines: [{ name: 'M' }], advice: 'a', testsAdvised: ['CBC'],
        prescribedAt: 't', prescribedBy: 'Dr' })).digest('hex');
      assert.equal(dispensingHashOf(row), before3d);
      assert.notEqual(dispensingHashOf({ ...row, prescription: { ...row.prescription, recommendationCode: code } }), before3d);
    });

    await check('re-save keeps the code and replaces the tests; without tests no code is printed and the code stops loading (404); tests again bring the same code back', async () => {
      const r = await save(rxBooking, ['HbA1c']);
      assert.equal(r.json.data.prescription.recommendationCode, code);
      const rec = await TestRecommendationModel.findOne({ consultationId: rxBooking }).lean() as any;
      assert.deepEqual(rec.items, [{ index: 0, name: 'HbA1c' }]);
      assert.equal(rec.version, 2);
      const none = await save(rxBooking, []);
      assert.equal(none.json.data.prescription.recommendationCode, undefined);
      assert.equal(read((await stored(rxBooking)).prescription.fileUrls[0]).includes('Recommended tests code'), false);
      assert.equal((await load('P', code)).status, 404, 'the prescription no longer carries it (R3)');
      const again = await save(rxBooking, ['CBC', 'Lipid profile']);
      assert.equal(again.json.data.prescription.recommendationCode, code, 'the same code comes back');
      assert.equal((await TestRecommendationModel.findOne({ consultationId: rxBooking }).lean() as any).status, 'open');
    });

    await check('r16b: a re-save whose PDF fails leaves the prescription as it was, and a load shows ITS tests (never the recommendation\'s own copy); no stale 404', async () => {
      const b = await consultation();
      const c = (await save(b, ['CBC', 'Lipid profile'])).json.data.prescription.recommendationCode;
      fs.writeFileSync(FAIL_MARK, '');
      try {
        await expect('D', 'POST', `${SP}/me/appointments/${b}/prescription`, 500, { ...RX, testsAdvised: ['X-ray chest'] });
        await expect('D', 'POST', `${SP}/me/appointments/${b}/prescription`, 500, { ...RX, testsAdvised: [] });
      } finally { fs.rmSync(FAIL_MARK, { force: true }); }
      assert.deepEqual((await stored(b)).prescription.testsAdvised, ['CBC', 'Lipid profile'], 'the stored prescription is unchanged');
      assert.deepEqual((await TestRecommendationModel.findOne({ consultationId: b }).lean() as any).items, [{ index: 0, name: 'X-ray chest' }],
        'the recommendation was updated before the PDF failed');
      const r = await load('P', c);
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.json.data.items, [{ index: 0, name: 'CBC' }, { index: 1, name: 'Lipid profile' }]);
    });

    await check('race: two saves of one consultation at once make one recommendation with one code', async () => {
      const b = await consultation();
      const [r1, r2] = await Promise.all([save(b, ['CBC']), save(b, ['CBC', 'TSH'])]);
      assert.equal(await TestRecommendationModel.countDocuments({ consultationId: b }), 1);
      const c = (await TestRecommendationModel.findOne({ consultationId: b }).lean() as any).code;
      assert.equal(r1.json.data.prescription.recommendationCode, c);
      assert.equal(r2.json.data.prescription.recommendationCode, c);
      assert.equal((await stored(b)).prescription.recommendationCode, c);
    });

    await check('best effort: without the unique code index the prescription is still saved (200), with no code and no box; nothing is written', async () => {
      const col = mongoose.connection.collection('test_recommendations');
      await col.dropIndex('code_1');
      resetIndexChecks();
      const b = await consultation();
      try {
        const r = await save(b, ['CBC']);
        assert.equal(r.json.data.prescription.recommendationCode, undefined);
        assert.deepEqual(r.json.data.prescription.testsAdvised, ['CBC']);
        assert.equal(read((await stored(b)).prescription.fileUrls[0]).includes('Recommended tests code'), false);
        assert.equal(await TestRecommendationModel.countDocuments({ consultationId: b }), 0);
      } finally {
        await col.createIndex({ code: 1 }, { unique: true });
        resetIndexChecks();
      }
      assert.ok((await save(b, ['CBC'])).json.data.prescription.recommendationCode, 'the next save makes it');
    });

    // ───────────────────────── Loading by code and phone ─────────────────────────
    await check('pharmacy load: the right code and phone give test names only; typed forms work; counted and audited (ids only)', async () => {
      const before = await lookups(`pharmacy:${P}`);
      const r = await load('P', formatRecommendationCode(code).toLowerCase());
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(Object.keys(r.json.data).sort(), ['code', 'items', 'status']);
      assert.deepEqual(r.json.data, { code, status: 'open', items: [{ index: 0, name: 'CBC' }, { index: 1, name: 'Lipid profile' }] });
      assert.equal(r.text.includes('SECRET') || r.text.includes('Rina') || r.text.includes('Asha'), false, 'no diagnosis, patient or doctor');
      assert.equal(await lookups(`pharmacy:${P}`), before + 1);
      const audit = await AssistedAuditEventModel.findOne({ action: 'recommendation.lookup', orgId: P }).sort({ at: -1 }).lean() as any;
      assert.equal(audit.detail.found, true);
      assert.equal(audit.actorKind, 'pharmacy');
      assert.equal(JSON.stringify(audit).includes(PHONE_X), false, 'no phone in the audit');
      // Any operational pharmacy with the code and the phone (the patient handed both over).
      assert.equal((await load('Q', code)).status, 200);
    });

    await check('one 404 for a wrong phone, an unknown code, and a code no longer on the prescription; malformed input is 400 and not counted', async () => {
      const before = await lookups(`pharmacy:${P}`);
      const wrongPhone = await load('P', code, '9600000502');
      const unknown = await load('P', newRecommendationCode());
      for (const x of [wrongPhone, unknown]) {
        assert.equal(x.status, 404, x.text);
        assert.equal(x.json.code, 'RECOMMENDATION_NOT_FOUND');
      }
      assert.equal(wrongPhone.json.message, unknown.json.message);
      assert.equal(await lookups(`pharmacy:${P}`), before + 2, 'well-formed loads are counted');
      const audit = await AssistedAuditEventModel.findOne({ action: 'recommendation.lookup', orgId: P }).sort({ at: -1 }).lean() as any;
      assert.equal(audit.detail.found, false);
      const typo = code.slice(0, 7) + (code[7] === 'A' ? 'B' : 'A');
      assert.equal((await load('P', typo)).json.code, 'INVALID_CODE');
      assert.equal((await load('P', code, '12')).json.code, 'INVALID_PHONE');
      assert.equal((await load('P', code, null)).json.code, 'VALIDATION_ERROR');
      assert.equal(await lookups(`pharmacy:${P}`), before + 2, 'malformed input is not counted');
      // r16b: the old GET form (code and phone in the request line) no longer exists.
      assert.equal((await call('P', 'GET', `${PA}/recommendations/${code}?phone=${PHONE_X}`)).status, 404);
      assert.equal((await load('U', code)).status, 403);
      assert.equal((await call('X', 'POST', `${PA}/recommendations/lookup`, { code, phone: PHONE_X })).status, 403);
    });

    await check('the hourly lookup limit (the one limit kept) refuses loads with 429 lookups', async () => {
      process.env.ASSISTED_LIMIT_LOOKUPS_PER_HOUR = String(await lookups(`pharmacy:${Q}`));
      try {
        const r = await load('Q', code);
        assert.equal(r.status, 429, r.text);
        assert.equal(r.json.code, 'ASSISTED_LIMIT_REACHED');
        assert.equal(r.json.limit, 'lookups');
      } finally { process.env.ASSISTED_LIMIT_LOOKUPS_PER_HOUR = '100000'; }
    });

    await check('doctor load: a verified doctor (counted and audited as the doctor); an unverified doctor 403 SPECIALIST_NOT_VERIFIED', async () => {
      const before = await lookups(`doctor:${E}`);
      const r = await load('E', code);
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(r.json.data.items.map((i: any) => i.name), ['CBC', 'Lipid profile']);
      assert.equal(await lookups(`doctor:${E}`), before + 1);
      assert.ok(await AssistedAuditEventModel.exists({ action: 'recommendation.lookup', actorKind: 'doctor', orgKind: 'doctor', orgId: E }));
      const u = await load('DU', code);
      assert.equal(u.status, 403);
      assert.equal(u.json.code, 'SPECIALIST_NOT_VERIFIED');
    });

    await check('lab desk load: bookings.manage at a verified lab (counted per lab, partner audit); no permission 403; a clinic or an unverified lab 403', async () => {
      const before = await lookups(`lab:${L}`);
      const r = await load('DESK', code);
      assert.equal(r.status, 200, r.text);
      assert.deepEqual(Object.keys(r.json.data).sort(), ['code', 'items', 'status']);
      assert.equal(await lookups(`lab:${L}`), before + 1);
      const audit = await PartnerAuditEventModel.findOne({ partnerId: L, action: 'lab_desk.recommendation_lookup' }).lean() as any;
      assert.equal(audit.detail.found, true);
      assert.equal(audit.targetKind, 'test_recommendation');
      assert.equal((await load('VIEWER', code)).status, 403);
      const admin = (partnerId: string) => call('ADMIN', 'POST', `${WS}/admin/${partnerId}/workspace/lab-desk/recommendations/lookup`, { code, phone: PHONE_X });
      assert.equal((await admin(L)).status, 200);
      assert.equal((await admin(CL)).json.code, 'LAB_PARTNER_REQUIRED');
      assert.equal((await admin(LU)).json.code, 'PARTNER_NOT_VERIFIED');
    });

    await check('an admin clear of the prescription makes its code unloadable (404)', async () => {
      const b = await consultation();
      const c = (await save(b, ['Urine routine'])).json.data.prescription.recommendationCode;
      assert.equal((await load('P', c)).status, 200);
      await expect('ADMIN', 'DELETE', `/api/v1/bookings/${b}/prescription`, 200, { reason: 'planted prescription' });
      assert.equal((await load('P', c)).status, 404);
    });

    // ───────────────────────── The recommending doctor and the report ─────────────────────────
    await check('the recommending doctor never reads the report of a lab test the pharmacy booked from the recommendation; the pharmacy and the patient do', async () => {
      const startsAt = new Date(Math.floor(Date.now() / MIN) * MIN + 30 * 3_600_000);
      const s = new Date(startsAt.getTime() + IST).toISOString();
      const e = new Date(startsAt.getTime() + 30 * MIN + IST).toISOString();
      const slotId = String((await PartnerSlotModel.create({ partnerId: L, branchId: A, visitMode: 'lab', date: s.slice(0, 10), startTime: s.slice(11, 16),
        endTime: e.slice(11, 16), startsAt, endsAt: new Date(startsAt.getTime() + 30 * MIN), capacity: 5, booked: 0, closed: null, source: 'manual' } as never))._id);
      const names = (await load('P', code)).json.data.items.map((i: any) => i.name);
      assert.ok(names.includes('CBC'));
      const booked = (await expect('P', 'POST', `${PA}/lab-bookings`, 201, {
        requestKey: newKey(), phone: PHONE_X, patient: { relation: 'self', name: 'Rina D' }, consent: { agreed: true, statementVersion: 'v1', statementLanguage: 'en' },
        preferredLanguage: 'en', partnerId: L, branchId: A, visitMode: 'lab', slotId, itemIds: [cbc], acceptedPriceMinor: 50000, paymentMethod: 'wallet',
      })).json.data.booking._id;
      await expect('OWNER', 'POST', `${WS}/lab-bookings/${booked}/visit`, 200, {});
      await expect('OWNER', 'POST', `${WS}/lab-bookings/${booked}/process`, 200, {});
      const fd = new FormData();
      fd.append('files', new Blob([Buffer.from('%PDF-1.4\n%%EOF\n')], { type: 'application/pdf' }), 'report.pdf');
      const up = await fetch(`${base}${WS}/lab-bookings/${booked}/reports`, { method: 'POST', headers: { authorization: `Bearer ${tokens.OWNER}` }, body: fd });
      const upJson = await up.json() as any;
      assert.equal(up.status, 201, JSON.stringify(upJson).slice(0, 300));
      const file = String(upJson.data.report.draftFiles[0]);
      await expect('OWNER', 'POST', `${WS}/lab-bookings/${booked}/reports/release`, 200, { file });
      const status = async (who: string) => (await fetch(`${base}${file}`, { headers: { authorization: `Bearer ${tokens[who]}` } })).status;
      assert.equal(await status('P'), 200, 'the booking pharmacy');
      assert.equal(await status('X'), 200, 'the patient');
      assert.equal(await status('D'), 404, 'the recommending doctor');
      assert.equal(await status('E'), 404, 'another doctor');
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
