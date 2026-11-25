/**
 * Assisted booking round 3f (ASSISTED_BOOKING_DESIGN.md §25.9, build record §25.17): the treating window, the read log,
 * records-access approvals and grants. A doctor sees its own consultations with a patient; while treating (the window) and
 * with the account holder's approval in the app (a grant), also the person's other prescriptions and released partner-lab
 * reports, and their full PDFs (DR26). Every history and file read is logged first (503 when it cannot be). A request
 * expires at 24 h or the window's close. A read followed by a cancellation or no-show raises an alert. Real routes over
 * HTTP (configureRoutes) on MongoDB; services wired by hand (tsx emits no decorator metadata).
 *
 * Run (throwaway DB only; the script drops its database):
 *   JWT_SECRET_KEY=local-integration-only SESSION_ORIGINS_CUSTOMER=https://app.jansetu.test SESSION_ORIGINS_WORKSPACE=https://staff.jansetu.test \
 *     MONGODB_URL='mongodb://127.0.0.1:27917/r30_phase3f_check?directConnection=true' npx tsx test/assisted/r30-phase3f.integration.ts
 */
import { removeFixtureDir, UPLOAD_DIR } from '../partners/q3-fixture-dir';
import 'reflect-metadata';
import assert from 'node:assert/strict';
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
import DependentModel from '@/modules/dependents/model';
import BookingModel from '@/modules/bookings/model';
import { BookingRepository } from '@/modules/bookings/repository';
import { BookingService } from '@/modules/bookings/services';
import { WalletModel } from '@/modules/wallet/model';
import { WalletRepository } from '@/modules/wallet/repository';
import SpecialistModel from '@/modules/specialists/model';
import { SpecialistPortalService } from '@/modules/specialistPortal/services';
import PartnerModel from '@/modules/partners/model';
import { PartnerLabBookingModel } from '@/modules/partners/model/labBooking';
import { grantFiles } from '@/modules/file/access';
import { resetIndexChecks } from '@/modules/common/utils/requiredIndex';
import { AssistedAlertModel, AssistedAuditEventModel } from '@/modules/assisted/model';
import { setAssistedNotifier } from '@/modules/assisted/support';
import { RecordAccessGrantModel, RecordAccessRequestModel, RecordReadModel } from '@/modules/recordAccess/model';
import { expireRecordRequests } from '@/modules/recordAccess';
import { InstantConsultService } from '@/modules/doctors/services/instant';
import { InstantRequestModel } from '@/modules/doctors/model/instant';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/r30_phase3f_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const oid = () => new Types.ObjectId().toHexString();
const MIN = 60_000;
const DAY = 86_400_000;
const IST = 330 * MIN;

// ── Services (wired by hand) ──
const notifications = new Proxy({}, { get: () => async () => undefined });
const bookings = Object.assign(Object.create(BookingService.prototype), {
  bookingRepository: new BookingRepository(), walletRepository: new WalletRepository(), notificationService: notifications,
  bookingReminderScheduler: { clearBookingReminders: async () => undefined, scheduleBookingReminders: async () => undefined },
}) as BookingService;
Container.set(BookingService, bookings);
Container.set(SpecialistPortalService, Object.assign(Object.create(SpecialistPortalService.prototype), {
  bookingRepository: new BookingRepository(), userRepository: new UserRepository(), bookingService: bookings, notificationService: notifications,
}) as SpecialistPortalService);
const notices: { audience: string; userId: string; key: string; title: string; message: string }[] = [];
setAssistedNotifier(async (n) => { notices.push({ audience: n.audience, userId: n.userId, key: n.key, title: n.title, message: n.message }); });

let passed = 0;
const failed: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log('ok -', name); } catch (e) { failed.push(name); console.log('FAIL -', name); console.error(e); }
}

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
  process.env.RECORDS_ACCESS_ENABLED = 'true';

  try {
    // ── People: X (signed in) with a daughter, Y (another account), Z (never signed in) ──
    const X = oid(); const Y = oid(); const Z = oid(); const ADMIN = oid();
    await UserModel.collection.insertMany([
      { _id: new Types.ObjectId(X), userType: 'user', phone: '9600000401', name: 'Rina Kumari Das', createdSource: 'self_signup', otpVerified: true },
      { _id: new Types.ObjectId(Y), userType: 'user', phone: '9600000402', name: 'Bikash Thapa', createdSource: 'self_signup', otpVerified: true },
      { _id: new Types.ObjectId(Z), userType: 'user', phone: '9600000403', name: 'Zed Holder', createdSource: 'assisted_booking', otpVerified: false },
    ] as never);
    for (const u of [X, Y, Z]) await WalletModel.create({ userId: u, balance: 0, isActive: true });
    const depX = String((await DependentModel.create({ userId: X, name: 'Mina Das', relationship: 'Daughter', gender: 'Female', isActive: true } as never))._id);
    // ── Doctors: D treats; D2 wrote other prescriptions; D3 another verified doctor; DU unverified ──
    const D = oid(); const D2 = oid(); const D3 = oid(); const DU = oid();
    await SpecialistModel.collection.insertMany([
      { _id: new Types.ObjectId(D), name: 'Asha Menon', email: 'asha@doc.test', specialization: 'General Physician', isActive: true, isVerified: true },
      { _id: new Types.ObjectId(D2), name: 'Dr Two', email: 'two@doc.test', specialization: 'Cardiologist', isActive: true, isVerified: true },
      { _id: new Types.ObjectId(D3), name: 'Dr Three', email: 'three@doc.test', specialization: 'General Physician', isActive: true, isVerified: true },
      { _id: new Types.ObjectId(DU), name: 'Dr New', email: 'new@doc.test', specialization: 'General Physician', isActive: true, isVerified: false },
    ] as never);
    const sign = (claims: object) => jwt.sign(claims, CONFIG.JWT_SECRET_KEY, { expiresIn: '1h' });
    const tokens: Record<string, string> = {
      X: sign({ _id: X, userType: 'user', authVersion: 0 }), Y: sign({ _id: Y, userType: 'user', authVersion: 0 }), Z: sign({ _id: Z, userType: 'user', authVersion: 0 }),
      ADMIN: sign({ _id: ADMIN, userType: 'admin' }),
      D: sign({ _id: D, specialistId: D, userType: 'specialist' }), D2: sign({ _id: D2, specialistId: D2, userType: 'specialist' }),
      D3: sign({ _id: D3, specialistId: D3, userType: 'specialist' }), DU: sign({ _id: DU, specialistId: DU, userType: 'specialist' }),
    };
    const call = async (who: string | null, method: string, url: string, body?: unknown) => {
      const r = await fetch(base + url, { method, headers: { ...(who ? { authorization: `Bearer ${tokens[who] ?? who}` } : {}), 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body) });
      const text = await r.text();
      let json: any; try { json = JSON.parse(text); } catch { json = { text }; }
      return { status: r.status, json, text };
    };
    const expect = async (who: string | null, method: string, url: string, status: number, body?: unknown, code?: string) => {
      const r = await call(who, method, '/api/v1' + url, body);
      assert.equal(r.status, status, `${who} ${method} ${url}: ${r.status} ${r.text.slice(0, 400)}`);
      if (code) assert.equal(r.json.code, code, `${who} ${method} ${url}: ${r.text.slice(0, 400)}`);
      return r;
    };
    const fileStatus = async (rel: string, who: string) => {
      const r = await fetch(`${base}/api/static/${rel}`, { headers: { authorization: `Bearer ${tokens[who]}` } });
      return { status: r.status, body: Buffer.from(await r.arrayBuffer()) };
    };

    // ── Consultations ──
    const ymd = (t: Date) => new Date(t.getTime() + IST).toISOString().slice(0, 10).replace(/-/g, '');
    const hm = (t: Date) => new Date(t.getTime() + IST).toISOString().slice(11, 16);
    const consultation = async (doctor: string, at: Date, extra: Record<string, unknown> = {}) => {
      const id = new Types.ObjectId();
      await BookingModel.collection.insertOne({ _id: id, bookingType: 'consultation', specialistId: doctor, userId: X, bookingDate: ymd(at), bookingTime: hm(at),
        consultationMode: 'video', serviceMode: 'video', status: 'confirmed', paymentStatus: 'paid', price: 500, notes: 'private note',
        documents: [{ url: '/api/static/general/x.pdf' }], contactNo: '9000000000', createdAt: new Date(), updatedAt: new Date(), ...extra } as never);
      return id.toHexString();
    };
    const pdf = Buffer.from('%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n');
    const writeFile = (rel: string) => { fs.mkdirSync(path.dirname(path.join(UPLOAD_DIR, rel)), { recursive: true }); fs.writeFileSync(path.join(UPLOAD_DIR, rel), pdf); };
    /** A consultation of `doctor` with a doctor-saved prescription and its full PDF on disk. */
    const withRx = async (doctor: string, at: Date, extra: Record<string, unknown> = {}) => {
      const id = await consultation(doctor, at, { status: 'completed', lifecycle: { completed: { at: at.toISOString() } }, ...extra });
      const rel = `bookings/${id}/prescription-${Date.now()}${Math.floor(Math.random() * 1000)}.pdf`;
      writeFile(rel);
      await BookingModel.collection.updateOne({ _id: new Types.ObjectId(id) }, { $set: {
        'lifecycle.prescriptionUploaded': { at: at.toISOString() },
        prescription: { diagnosis: 'Viral fever', advice: 'Rest', medicines: [{ name: 'Paracetamol', dosage: '500mg', frequency: 'TDS', duration: '3 days' }],
          testsAdvised: ['CBC'], recommendationCode: 'ABCD-EFGH', prescribedAt: at.toISOString(), prescribedBySpecialistId: doctor, prescribedBySpecialistName: 'Dr Two',
          fileUrls: [`/api/static/${rel}`], message: 'secret message' } } });
      return { id, rel };
    };
    const treat = await consultation(D, new Date(Date.now() - 20 * MIN));                 // D treats X now (video, window open)
    const ownOld = await consultation(D, new Date(Date.now() - 60 * DAY), { status: 'completed', lifecycle: { completed: { at: new Date(Date.now() - 60 * DAY) } } });
    const treatDep = await consultation(D, new Date(Date.now() - 20 * MIN), { dependentId: depX }); // D treats the daughter now
    const rxOther = await withRx(D2, new Date(Date.now() - 30 * DAY));                    // D2's prescription for X
    const rxDep = await withRx(D2, new Date(Date.now() - 25 * DAY), { dependentId: depX }); // D2's prescription for the daughter
    const noRx = await consultation(D2, new Date(Date.now() - 20 * DAY), { status: 'completed' });
    // A released partner-lab report of X (and a draft), with their bindings; one of the daughter.
    const L = oid();
    await PartnerModel.collection.insertOne({ _id: new Types.ObjectId(L), kind: 'lab', name: 'Metro Labs', isActive: true, verification: { state: 'verified' } } as never);
    const labRow = async (patient: Record<string, unknown>) => {
      const id = new Types.ObjectId();
      const rel = `partner-lab-reports/${id.toHexString()}/report-${Date.now()}.pdf`;
      const draft = `partner-lab-reports/${id.toHexString()}/draft-${Date.now()}.pdf`;
      writeFile(rel); writeFile(draft);
      await PartnerLabBookingModel.collection.insertOne({ _id: id, partnerId: L, branchId: oid(), userId: X, source: 'self', patient, visitMode: 'lab',
        slot: { date: '2026-11-01', startTime: '09:00', endTime: '09:30', startsAt: new Date(Date.now() - 10 * DAY) },
        items: [{ catalogItemId: oid(), kind: 'test', name: 'CBC', priceMinor: 50000, gstRate: 0 }], pricing: { subtotalMinor: 50000, discountMinor: 0, payableMinor: 50000 },
        status: 'report_ready', statusVersion: 5, paymentStatus: 'paid',
        report: { draftFiles: [draft], releasedFiles: [rel], releases: [{ path: rel, releasedAt: new Date(Date.now() - 9 * DAY), releasedBy: oid(),
          signer: { memberId: oid(), name: 'Dr Rao', kind: 'pathologist', registrationNumber: 'MMC-12345' } }] },
        createdAt: new Date(), updatedAt: new Date() } as never);
      await grantFiles(undefined, [rel], 'partner_lab_report', { model: 'PartnerLabBooking', resourceId: id, field: 'report.releasedFiles' });
      await grantFiles(undefined, [draft], 'partner_lab_report_draft', { model: 'PartnerLabBooking', resourceId: id, field: 'report.draftFiles' });
      return { id: id.toHexString(), rel, draft };
    };
    const labX = await labRow({ kind: 'self', name: 'Rina' });
    const labDep = await labRow({ kind: 'dependent', dependentId: depX, name: 'Mina' });

    const H = (q = '') => `/specialists/me/patients/${X}/history${q}`;
    const REQ = (b: string) => `/specialists/me/bookings/${b}/records-access/request`;
    const reads = (q: Record<string, unknown> = {}) => RecordReadModel.find(q).lean();

    // ───────────────────────── DR23 and the plain history ─────────────────────────
    await check('DR23: without bookingId the answer is unchanged (own consultations, whole account, the full summaries) and logged own_history', async () => {
      const before = (await reads()).length;
      const r = (await expect('D', 'GET', H(), 200)).json.data;
      assert.deepEqual(Object.keys(r).sort(), ['consultations', 'patient']);
      assert.deepEqual(r.consultations.map((c: any) => c.bookingId).sort(), [treat, ownOld, treatDep].sort());
      assert.equal(r.consultations.find((c: any) => c.bookingId === ownOld).notes, 'private note', 'today\'s summary, unchanged');
      assert.equal(r.patient.phone, '9600000401');
      const rows = await reads();
      assert.equal(rows.length, before + 1);
      const row = rows.at(-1) as any;
      assert.deepEqual([row.doctorId, row.holderUserId, row.personKey, row.treatingBookingId, row.scope], [D, X, 'account', null, 'own_history']);
      // With dependentId: that person only.
      const dep = (await expect('D', 'GET', H(`?dependentId=${depX}`), 200)).json.data;
      assert.deepEqual(dep.consultations.map((c: any) => c.bookingId), [treatDep]);
      assert.equal((await reads()).at(-1)!.personKey, depX);
      // Another doctor without consultations with X: 404 as today (nothing logged).
      await expect('D3', 'GET', H(), 404, undefined, 'PATIENT_HISTORY_NOT_FOUND');
    });

    // ───────────────────────── No grant ─────────────────────────
    await check('no grant: the treating view has the own consultations of that person and the access state only; other files 404', async () => {
      const r = (await expect('D', 'GET', H(`?bookingId=${treat}`), 200)).json.data;
      assert.deepEqual(r.consultations.map((c: any) => c.bookingId).sort(), [treat, ownOld].sort(), 'the daughter\'s consultation is another person');
      assert.equal(r.others, undefined);
      assert.equal(r.access.grant, null); assert.equal(r.access.request, null); assert.ok(r.access.window.opensAt && r.access.window.closesAt);
      assert.equal(r.access.identityNote, undefined);
      const row = (await reads()).at(-1) as any;
      assert.deepEqual([row.scope, row.treatingBookingId, row.personKey], ['own_history', treat, 'self']);
      assert.equal((await fileStatus(rxOther.rel, 'D')).status, 404);
      assert.equal((await fileStatus(labX.rel, 'D')).status, 404);
      assert.equal((await fileStatus(rxOther.rel, 'D2')).status, 200, 'the booking\'s own doctor');
      assert.equal((await fileStatus(rxOther.rel, 'X')).status, 200, 'the patient');
    });

    await check('the treating booking: another doctor\'s or another account\'s 404; another person 404; outside the window 409; partner-booked shows the identity note', async () => {
      await expect('D3', 'GET', H(`?bookingId=${treat}`), 404, undefined, 'BOOKING_NOT_FOUND');
      await expect('D', 'GET', `/specialists/me/patients/${Y}/history?bookingId=${treat}`, 404, undefined, 'BOOKING_NOT_FOUND');
      await expect('D', 'GET', H(`?bookingId=${treat}&dependentId=${depX}`), 404, undefined, 'BOOKING_NOT_FOUND');
      await expect('D', 'GET', H(`?bookingId=${oid()}`), 404, undefined, 'BOOKING_NOT_FOUND');
      const future = await consultation(D, new Date(Date.now() + 2 * DAY));
      await expect('D', 'GET', H(`?bookingId=${future}`), 409, undefined, 'TREATING_WINDOW_CLOSED');
      await expect('D', 'GET', H(`?bookingId=${ownOld}`), 409, undefined, 'TREATING_WINDOW_CLOSED');
      await expect('D', 'POST', REQ(ownOld), 409, {}, 'TREATING_WINDOW_CLOSED');
      await expect('D3', 'POST', REQ(treat), 404, {}, 'BOOKING_NOT_FOUND');
      const partnerBooked = await consultation(D, new Date(Date.now() - 15 * MIN), { assisted: { bookedBy: { kind: 'pharmacy', id: oid(), name: 'Sharma Medicals' }, funding: { method: 'wallet' } } });
      assert.equal((await expect('D', 'GET', H(`?bookingId=${partnerBooked}`), 200)).json.data.access.identityNote, 'Identity attested by the partner, not verified');
    });

    // ───────────────────────── Request ─────────────────────────
    let firstRequest = '';
    await check('request: 201 pending until 24 h, the app channel only; the holder is told the doctor and first name only; a second request replaces the first', async () => {
      const t0 = Date.now();
      const r = (await expect('D', 'POST', REQ(treat), 201, {})).json.data;
      firstRequest = r.requestId;
      assert.equal(r.state, 'pending'); assert.deepEqual(r.channels, { app: true, sms: false });
      assert.ok(Math.abs(new Date(r.expiresAt).getTime() - (t0 + DAY)) < 60_000, 'expires in 24 h');
      const n = notices.filter((x) => x.key === `records_access:${r.requestId}:requested`);
      assert.equal(n.length, 1); assert.equal(n[0]!.userId, X); assert.equal(n[0]!.audience, 'customer');
      assert.equal(n[0]!.message, 'Your doctor, Asha Menon, asks to see Rina\'s past health records. Open Jansetu to allow or deny.');
      const again = (await expect('D', 'POST', REQ(treat), 201, {})).json.data;
      assert.notEqual(again.requestId, r.requestId);
      assert.equal((await RecordAccessRequestModel.findById(r.requestId).lean())!.state, 'replaced');
      assert.equal(await RecordAccessRequestModel.countDocuments({ treatingBookingId: treat, state: 'pending' }), 1);
      firstRequest = again.requestId;
      const h = (await expect('D', 'GET', H(`?bookingId=${treat}`), 200)).json.data;
      assert.equal(h.access.request.state, 'pending');
    });

    await check('race: 5 requests at once leave one pending request', async () => {
      const rs = await Promise.all([1, 2, 3, 4, 5].map(() => call('D', 'POST', '/api/v1' + REQ(treat), {})));
      assert.ok(rs.every((x) => x.status === 200 || x.status === 201), rs.map((x) => `${x.status} ${x.text.slice(0, 120)}`).join(' | '));
      assert.equal(await RecordAccessRequestModel.countDocuments({ treatingBookingId: treat, specialistId: D, state: 'pending' }), 1);
      firstRequest = String((await RecordAccessRequestModel.findOne({ treatingBookingId: treat, state: 'pending' }).lean())!._id);
    });

    await check('a request expires at the window\'s close when that comes before 24 h; a holder who never signed in has no app channel', async () => {
      const closing = await consultation(D, new Date(Date.now() - 7 * DAY + 60 * MIN));   // ends 7 days ago + 90 min: closes in 90 min
      const r = (await expect('D', 'POST', REQ(closing), 201, {})).json.data;
      const h = (await expect('D', 'GET', H(`?bookingId=${closing}`), 200)).json.data;
      assert.equal(new Date(r.expiresAt).getTime(), new Date(h.access.window.closesAt).getTime());
      assert.ok(new Date(r.expiresAt).getTime() < Date.now() + 2 * 3_600_000);
      const zBooking = String((await BookingModel.collection.insertOne({ bookingType: 'consultation', specialistId: D, userId: Z, bookingDate: ymd(new Date(Date.now() - 20 * MIN)),
        bookingTime: hm(new Date(Date.now() - 20 * MIN)), consultationMode: 'video', status: 'confirmed', paymentStatus: 'paid', createdAt: new Date() } as never)).insertedId);
      assert.deepEqual((await expect('D', 'POST', REQ(zBooking), 201, {})).json.data.channels, { app: false, sms: false });
    });

    // ───────────────────────── Holder: list, allow, deny ─────────────────────────
    await check('another account cannot approve or deny (404); a doctor token cannot use the holder routes (403)', async () => {
      await expect('Y', 'POST', `/records-access/requests/${firstRequest}/approve`, 404, {}, 'RECORDS_REQUEST_NOT_FOUND');
      await expect('Y', 'POST', `/records-access/requests/${firstRequest}/deny`, 404, {}, 'RECORDS_REQUEST_NOT_FOUND');
      await expect('D', 'GET', '/records-access/requests', 403, undefined, 'FORBIDDEN');
      assert.equal((await RecordAccessRequestModel.findById(firstRequest).lean())!.state, 'pending');
    });

    let grantId = '';
    await check('allow: the holder lists and approves; the doctor then gets the others (allowlist only), the full PDF and the released report, each logged first', async () => {
      const list = (await expect('X', 'GET', '/records-access/requests?state=pending', 200)).json.data;
      const item = list.find((x: any) => x._id === firstRequest);
      assert.ok(item, JSON.stringify(list).slice(0, 300));
      assert.deepEqual(item.doctor, { id: D, name: 'Asha Menon', specialization: 'General Physician' });
      assert.deepEqual(item.patient, { personKey: 'self', name: null });
      const out = (await expect('X', 'POST', `/records-access/requests/${firstRequest}/approve`, 200, {})).json.data;
      assert.equal(out.request.state, 'approved'); assert.equal(out.grant.state, 'active'); assert.equal(out.grant.via, 'app');
      grantId = out.grant._id;
      const g = await RecordAccessGrantModel.findById(grantId).lean() as any;
      assert.deepEqual([g.holderUserId, g.personKey, g.specialistId, g.via, g.requestId], [X, 'self', D, 'app', firstRequest]);
      assert.ok(Math.abs(new Date(g.expiresAt).getTime() - new Date(g.at).getTime() - 365 * DAY) <= DAY, '12 months');

      const r = (await expect('D', 'GET', H(`?bookingId=${treat}`), 200)).json.data;
      assert.equal(r.access.grant.via, 'app');
      assert.deepEqual(r.others.consultations.map((c: any) => c.bookingId), [rxOther.id], 'only other doctors\' prescriptions of this person');
      const c = r.others.consultations[0];
      assert.deepEqual(Object.keys(c).sort(), ['advice', 'bookingId', 'consultationMode', 'date', 'diagnosis', 'doctorName', 'medicines', 'prescribedAt',
        'prescriptionFile', 'recommendationCode', 'specialization', 'testsAdvised'].sort());
      assert.deepEqual([c.doctorName, c.specialization, c.diagnosis, c.recommendationCode, c.prescriptionFile], ['Dr Two', 'Cardiologist', 'Viral fever', 'ABCD-EFGH', `/api/static/${rxOther.rel}`]);
      assert.ok(!JSON.stringify(r.others).includes('private note') && !JSON.stringify(r.others).includes('9000000000') && !JSON.stringify(r.others).includes('secret message'));
      assert.deepEqual(r.others.labReports.map((l: any) => l.labBookingId), [labX.id]);
      assert.deepEqual(r.others.labReports[0].tests, ['CBC']); assert.equal(r.others.labReports[0].labName, 'Metro Labs');
      assert.deepEqual(r.others.labReports[0].releases.map((x: any) => x.file), [`/api/static/${labX.rel}`]);
      assert.ok(!r.others.consultations.some((x: any) => x.bookingId === noRx), 'no prescription: not included');
      const row = (await reads()).at(-1) as any;
      assert.deepEqual([row.scope, row.treatingBookingId, row.personKey], ['other_history', treat, 'self']);

      const before = (await reads()).length;
      const file = await fileStatus(rxOther.rel, 'D');
      assert.equal(file.status, 200); assert.deepEqual(file.body, pdf, 'DR26: the full PDF');
      const fileRow = (await reads()).at(-1) as any;
      assert.equal((await reads()).length, before + 1);
      assert.deepEqual([fileRow.scope, fileRow.path, fileRow.sourceBookingId, fileRow.treatingBookingId, fileRow.doctorId], ['file', rxOther.rel, rxOther.id, treat, D]);
      assert.equal((await fileStatus(labX.rel, 'D')).status, 200);
      assert.equal(((await reads()).at(-1) as any).sourceBookingId, labX.id);
      assert.equal((await fileStatus(labX.draft, 'D')).status, 404, 'never a draft');
      assert.equal((await fileStatus(rxDep.rel, 'D')).status, 404, 'the daughter has no grant');
      assert.equal((await fileStatus(labDep.rel, 'D')).status, 404);
      assert.equal((await fileStatus(rxOther.rel, 'D3')).status, 404, 'another doctor never');
    });

    await check('a request with the grant in force answers 200 approved and creates nothing', async () => {
      const n = await RecordAccessRequestModel.countDocuments();
      const r = (await expect('D', 'POST', REQ(treat), 200, {})).json.data;
      assert.equal(r.state, 'approved'); assert.equal(r.grant.via, 'app');
      assert.equal(await RecordAccessRequestModel.countDocuments(), n);
    });

    await check('deny: for the daughter; no grant, the request is denied, approving it afterwards 409; the daughter\'s others stay absent', async () => {
      const r = (await expect('D', 'POST', REQ(treatDep), 201, {})).json.data;
      const out = (await expect('X', 'POST', `/records-access/requests/${r.requestId}/deny`, 200, {})).json.data;
      assert.equal(out.request.state, 'denied'); assert.equal(out.grant, null);
      assert.equal(out.request.patient.name, 'Mina Das');
      await expect('X', 'POST', `/records-access/requests/${r.requestId}/approve`, 409, {}, 'RECORDS_REQUEST_NOT_PENDING');
      assert.equal(await RecordAccessGrantModel.countDocuments({ personKey: depX }), 0);
      const h = (await expect('D', 'GET', `/specialists/me/patients/${X}/history?bookingId=${treatDep}`, 200)).json.data;
      assert.equal(h.others, undefined); assert.equal(h.access.request.state, 'denied');
    });

    await check('race: approve against deny gives one outcome', async () => {
      const r = (await expect('D', 'POST', REQ(treatDep), 201, {})).json.data;
      const [a, b] = await Promise.all([call('X', 'POST', `/api/v1/records-access/requests/${r.requestId}/approve`, {}),
        call('X', 'POST', `/api/v1/records-access/requests/${r.requestId}/deny`, {})]);
      assert.deepEqual([a.status, b.status].sort(), [200, 409], `${a.text.slice(0, 200)} | ${b.text.slice(0, 200)}`);
      const state = (await RecordAccessRequestModel.findById(r.requestId).lean())!.state;
      assert.equal(await RecordAccessGrantModel.countDocuments({ personKey: depX, revokedAt: null }), state === 'approved' ? 1 : 0);
      assert.equal(state, a.status === 200 ? 'approved' : 'denied');
      await RecordAccessGrantModel.deleteMany({ personKey: depX });
    });

    // ───────────────────────── Expiry ─────────────────────────
    await check('expiry at 24 h: approve answers 409 RECORDS_REQUEST_EXPIRED and the request is expired; the sweep expires another', async () => {
      const r = (await expect('D', 'POST', REQ(treatDep), 201, {})).json.data;
      await RecordAccessRequestModel.updateOne({ _id: r.requestId }, { $set: { expiresAt: new Date(Date.now() - MIN) } });
      assert.equal((await expect('D', 'GET', H(`?bookingId=${treatDep}`), 200)).json.data.access.request.state, 'expired', 'shown expired before the sweep');
      await expect('X', 'POST', `/records-access/requests/${r.requestId}/approve`, 409, {}, 'RECORDS_REQUEST_EXPIRED');
      assert.equal((await RecordAccessRequestModel.findById(r.requestId).lean())!.state, 'expired');
      const r2 = (await expect('D', 'POST', REQ(treatDep), 201, {})).json.data;
      await RecordAccessRequestModel.updateOne({ _id: r2.requestId }, { $set: { expiresAt: new Date(Date.now() - MIN) } });
      assert.ok(!(await expect('X', 'GET', '/records-access/requests?state=pending', 200)).json.data.some((x: any) => x._id === r2.requestId));
      assert.ok(await expireRecordRequests() >= 1);
      assert.equal((await RecordAccessRequestModel.findById(r2.requestId).lean())!.state, 'expired');
    });

    await check('expiry at the window\'s close: a cancelled treating booking expires its pending request (approve 409, the sweep)', async () => {
      const b = await consultation(D, new Date(Date.now() - 20 * MIN), { dependentId: depX });
      const r = (await expect('D', 'POST', REQ(b), 201, {})).json.data;
      const r2Booking = await consultation(D, new Date(Date.now() - 20 * MIN), { dependentId: depX });
      const r2 = (await expect('D', 'POST', REQ(r2Booking), 201, {})).json.data;
      await BookingModel.updateOne({ _id: b }, { $set: { status: 'cancelled' } });
      await BookingModel.updateOne({ _id: r2Booking }, { $set: { status: 'no_show' } });
      await expect('X', 'POST', `/records-access/requests/${r.requestId}/approve`, 409, {}, 'RECORDS_REQUEST_EXPIRED');
      assert.equal((await RecordAccessRequestModel.findById(r.requestId).lean())!.state, 'expired');
      await expireRecordRequests();
      assert.equal((await RecordAccessRequestModel.findById(r2.requestId).lean())!.state, 'expired');
      assert.equal(await RecordAccessGrantModel.countDocuments({ personKey: depX }), 0);
    });

    // ───────────────────────── Doctors ─────────────────────────
    await check('an unverified doctor: request and the treating view 403; files 404 even under a grant; the plain history reduced and still logged', async () => {
      const ub = await consultation(DU, new Date(Date.now() - 20 * MIN));
      await expect('DU', 'POST', REQ(ub), 403, {}, 'SPECIALIST_NOT_VERIFIED');
      await expect('DU', 'GET', H(`?bookingId=${ub}`), 403, undefined, 'SPECIALIST_NOT_VERIFIED');
      await RecordAccessGrantModel.create({ holderUserId: X, personKey: 'self', specialistId: DU, via: 'app', requestId: oid(), at: new Date(), expiresAt: new Date(Date.now() + DAY) });
      assert.equal((await fileStatus(rxOther.rel, 'DU')).status, 404);
      const before = (await reads()).length;
      const r = (await expect('DU', 'GET', H(), 200)).json.data;
      assert.equal(r.restricted, true); assert.equal(r.consultations[0].notes, undefined);
      assert.equal((await reads()).length, before + 1);
      // Re-verification restores access (S5).
      await SpecialistModel.collection.updateOne({ _id: new Types.ObjectId(DU) }, { $set: { isVerified: true } });
      try { assert.equal((await fileStatus(rxOther.rel, 'DU')).status, 200); }
      finally { await SpecialistModel.collection.updateOne({ _id: new Types.ObjectId(DU) }, { $set: { isVerified: false } }); }
      await RecordAccessGrantModel.deleteMany({ specialistId: DU });
    });

    await check('a grant counts only inside an open treating window: D\'s grant without an open treating booking of X reads no file', async () => {
      // Every consultation of D with X (self) moves 3 days ahead: no window is open (they start later), the grant stays.
      const mine = await BookingModel.find({ specialistId: D, userId: X, dependentId: { $in: [null, ''] } }).select({ bookingDate: 1 }).lean();
      await BookingModel.updateMany({ _id: { $in: mine.map((b) => b._id) } }, { $set: { bookingDate: ymd(new Date(Date.now() + 3 * DAY)) } });
      try {
        assert.equal((await fileStatus(rxOther.rel, 'D')).status, 404);
        await expect('D', 'GET', H(`?bookingId=${treat}`), 409, undefined, 'TREATING_WINDOW_CLOSED');
      } finally { for (const b of mine) await BookingModel.updateOne({ _id: b._id }, { $set: { bookingDate: b.bookingDate } }); }
      assert.equal((await fileStatus(rxOther.rel, 'D')).status, 200);
    });

    // ───────────────────────── Read log fails closed ─────────────────────────
    await check('read log first: when record_reads refuses writes, history (both kinds) and grant file reads answer 503 READ_LOG_UNAVAILABLE with no data', async () => {
      const db = mongoose.connection.db!;
      await db.command({ collMod: 'record_reads', validator: { $expr: { $eq: [1, 0] } }, validationLevel: 'strict', validationAction: 'error' });
      try {
        const a = await expect('D', 'GET', H(`?bookingId=${treat}`), 503, undefined, 'READ_LOG_UNAVAILABLE');
        assert.equal(a.json.data, undefined); assert.ok(!a.text.includes('Viral fever') && !a.text.includes('9600000401'));
        const b = await expect('D', 'GET', H(), 503, undefined, 'READ_LOG_UNAVAILABLE');
        assert.equal(b.json.data, undefined);
        const f = await fileStatus(rxOther.rel, 'D');
        assert.equal(f.status, 503); assert.ok(!f.body.equals(pdf));
        assert.equal((await fileStatus(rxOther.rel, 'D2')).status, 200, 'the booking\'s own doctor is not a logged read');
      } finally {
        await db.command({ collMod: 'record_reads', validator: {}, validationLevel: 'off' });
      }
      assert.equal((await fileStatus(rxOther.rel, 'D')).status, 200);
    });

    // ───────────────────────── Read-then-cancel ─────────────────────────
    await check('read-then-cancel: a cancel, a no-show or an instant cancel after an other-providers read raises one alert; after own reads only, none', async () => {
      const t2 = await consultation(D, new Date(Date.now() - 20 * MIN));
      await expect('D', 'GET', H(`?bookingId=${t2}`), 200);                     // grant in force: other_history
      await bookings.cancelByDoctor(t2, { _id: D, userType: 'specialist' }, 'Doctor unavailable');
      assert.equal(await AssistedAlertModel.countDocuments({ kind: 'read_then_cancel', 'detail.bookingId': t2 }), 1);
      await bookings.cancelByDoctor(t2, { _id: D, userType: 'specialist' }, 'Doctor unavailable');  // a repeat raises nothing new
      assert.equal(await AssistedAlertModel.countDocuments({ kind: 'read_then_cancel', 'detail.bookingId': t2 }), 1);
      const t3 = await consultation(D, new Date(Date.now() - 20 * MIN), { dependentId: depX });
      await expect('D', 'GET', `/specialists/me/patients/${X}/history?bookingId=${t3}`, 200);   // no grant for the daughter: own only
      await bookings.cancelByDoctor(t3, { _id: D, userType: 'specialist' }, 'Doctor unavailable');
      assert.equal(await AssistedAlertModel.countDocuments({ kind: 'read_then_cancel', 'detail.bookingId': t3 }), 0);
      const t4 = await consultation(D, new Date(Date.now() - 20 * MIN));
      assert.equal((await fileStatus(labX.rel, 'D')).status, 200);                // a file read under t4's or treat's window
      await RecordReadModel.updateMany({ scope: 'file', path: labX.rel }, { $set: { treatingBookingId: t4 } });
      await bookings.markNoShow(t4, { _id: D, userType: 'specialist' }, new Date(Date.now() + DAY));
      assert.equal(await AssistedAlertModel.countDocuments({ kind: 'read_then_cancel', 'detail.bookingId': t4 }), 1);
      // An accepted instant consultation (its window opened at acceptance) cancelled by the doctor after a read.
      const reqId = new Types.ObjectId(); const ib = new Types.ObjectId(); const at = new Date(Date.now() - 5 * MIN);
      await InstantRequestModel.collection.insertOne({ _id: reqId, userId: X, bookingId: ib.toHexString(), status: 'accepted', statusVersion: 3, fundingState: 'allocated',
        allocated: { walletMinor: 0, gatewayMinor: 0, couponMinor: 0, totalMinor: 0 }, createdAt: at } as never);
      await BookingModel.collection.insertOne({ _id: ib, bookingType: 'consultation', bookingKind: 'instant', instantRequestId: reqId.toHexString(), specialistId: D, userId: X,
        consultationMode: 'video', status: 'confirmed', paymentStatus: 'paid', bookingDate: ymd(at), bookingTime: hm(at), createdAt: at } as never);
      await expect('D', 'GET', H(`?bookingId=${ib.toHexString()}`), 200);
      const instant = Object.assign(Object.create(InstantConsultService.prototype), { notify: async () => undefined }) as InstantConsultService;
      await instant.cancelAccepted(ib.toHexString(), { _id: D, userType: 'specialist' }, 'Doctor unavailable');
      assert.equal(await AssistedAlertModel.countDocuments({ kind: 'read_then_cancel', 'detail.bookingId': ib.toHexString() }), 1);
    });

    // ───────────────────────── Revoke, renew, 12 months, move ─────────────────────────
    await check('revoke: others and files stop; a new approval renews the same grant; after 12 months nothing', async () => {
      const out = (await expect('X', 'POST', `/records-access/grants/${grantId}/revoke`, 200, {})).json.data;
      assert.equal(out.grant.state, 'revoked'); assert.equal(out.alreadyRevoked, false);
      assert.equal((await expect('X', 'POST', `/records-access/grants/${grantId}/revoke`, 200, {})).json.data.alreadyRevoked, true);
      await expect('Y', 'POST', `/records-access/grants/${grantId}/revoke`, 404, {}, 'RECORDS_GRANT_NOT_FOUND');
      assert.equal((await expect('D', 'GET', H(`?bookingId=${treat}`), 200)).json.data.others, undefined);
      assert.equal((await fileStatus(rxOther.rel, 'D')).status, 404);
      const r = (await expect('D', 'POST', REQ(treat), 201, {})).json.data;
      const again = (await expect('X', 'POST', `/records-access/requests/${r.requestId}/approve`, 200, {})).json.data;
      assert.equal(again.grant._id, grantId, 'renewed in place'); assert.equal(again.grant.state, 'active');
      assert.equal(await RecordAccessGrantModel.countDocuments({ holderUserId: X, personKey: 'self', specialistId: D }), 1);
      assert.ok((await expect('D', 'GET', H(`?bookingId=${treat}`), 200)).json.data.others);
      const grants = (await expect('X', 'GET', '/records-access/grants', 200)).json.data;
      assert.ok(grants.some((x: any) => x._id === grantId && x.state === 'active' && x.doctor.name === 'Asha Menon'));
      await RecordAccessGrantModel.updateOne({ _id: grantId }, { $set: { expiresAt: new Date(Date.now() - MIN) } });
      try {
        assert.equal((await expect('D', 'GET', H(`?bookingId=${treat}`), 200)).json.data.others, undefined, 'after 12 months');
        assert.equal((await fileStatus(rxOther.rel, 'D')).status, 404);
      } finally { await RecordAccessGrantModel.updateOne({ _id: grantId }, { $set: { expiresAt: new Date(Date.now() + 300 * DAY) } }); }
    });

    await check('a moved booking follows its new account: the old holder\'s grant never applies and its pending request expires', async () => {
      const moved = await consultation(D, new Date(Date.now() - 20 * MIN));
      const r = (await expect('D', 'POST', REQ(moved), 200, {})).json.data;
      assert.equal(r.state, 'approved', 'X\'s grant');
      const t = await consultation(D, new Date(Date.now() - 20 * MIN), { dependentId: depX });
      const pending = (await expect('D', 'POST', REQ(t), 201, {})).json.data;
      await BookingModel.updateOne({ _id: moved }, { $set: { userId: Y } });   // the admin move (§17.5)
      await BookingModel.updateOne({ _id: t }, { $set: { userId: Y }, $unset: { dependentId: 1 } });
      const h = (await expect('D', 'GET', `/specialists/me/patients/${Y}/history?bookingId=${moved}`, 200)).json.data;
      assert.equal(h.others, undefined); assert.equal(h.access.grant, null);
      await expect('D', 'GET', H(`?bookingId=${moved}`), 404, undefined, 'BOOKING_NOT_FOUND');
      await expect('X', 'POST', `/records-access/requests/${pending.requestId}/approve`, 409, {}, 'RECORDS_REQUEST_EXPIRED');
    });

    // ───────────────────────── Admin ─────────────────────────
    await check('admin: the read log by holder and doctor (ids only), grants search and an audited revoke with a reason', async () => {
      const rows = (await expect('ADMIN', 'GET', `/admin/records-access/reads?holderUserId=${X}&doctorId=${D}&limit=500`, 200)).json.data;
      assert.ok(rows.length >= 5 && rows.every((x: any) => x.holderUserId === X && x.doctorId === D));
      const keys = new Set(rows.flatMap((x: any) => Object.keys(x)));
      assert.ok([...keys].every((k) => ['_id', 'doctorId', 'holderUserId', 'personKey', 'treatingBookingId', 'scope', 'path', 'sourceBookingId', 'at'].includes(k)), [...keys].join());
      assert.ok(rows.some((x: any) => x.scope === 'file') && rows.some((x: any) => x.scope === 'other_history'));
      const future = new Date(Date.now() + DAY).toISOString();
      assert.equal((await expect('ADMIN', 'GET', `/admin/records-access/reads?doctorId=${D}&from=${future}`, 200)).json.data.length, 0);
      await expect('X', 'GET', '/admin/records-access/reads', 403);
      const g = (await expect('ADMIN', 'GET', `/admin/records-access/grants?holderUserId=${X}&specialistId=${D}`, 200)).json.data;
      assert.deepEqual(g.map((x: any) => String(x._id)), [grantId]);
      await expect('ADMIN', 'POST', `/admin/records-access/grants/${grantId}/revoke`, 400, {}, 'VALIDATION_ERROR');
      const out = (await expect('ADMIN', 'POST', `/admin/records-access/grants/${grantId}/revoke`, 200, { reason: 'Holder asked by phone' })).json.data;
      assert.equal(out.grant.revokedByKind, 'admin'); assert.equal(out.grant.revokeReason, 'Holder asked by phone');
      const audit = await AssistedAuditEventModel.findOne({ action: 'records.grant_revoked' }).lean() as any;
      assert.deepEqual([audit.actorKind, audit.actorId, audit.orgKind, audit.orgId, audit.detail.grantId], ['admin', ADMIN, 'doctor', D, grantId]);
      assert.equal((await fileStatus(rxOther.rel, 'D')).status, 404);
    });

    // ───────────────────────── Switch and indexes ─────────────────────────
    await check('switch off: request, approve and deny 503; no others (history still logged); grant files 404; revoke and the lists work', async () => {
      const r = (await expect('D', 'POST', REQ(treat), 201, {})).json.data;
      const ok = (await expect('X', 'POST', `/records-access/requests/${r.requestId}/approve`, 200, {})).json.data;
      process.env.RECORDS_ACCESS_ENABLED = 'false';
      try {
        await expect('D', 'POST', REQ(treatDep), 503, {}, 'RECORDS_ACCESS_DISABLED');
        await expect('X', 'POST', `/records-access/requests/${oid()}/approve`, 503, {}, 'RECORDS_ACCESS_DISABLED');
        await expect('X', 'POST', `/records-access/requests/${oid()}/deny`, 503, {}, 'RECORDS_ACCESS_DISABLED');
        const before = (await reads()).length;
        const h = (await expect('D', 'GET', H(`?bookingId=${treat}`), 200)).json.data;
        assert.equal(h.others, undefined); assert.equal(h.access.grant.via, 'app');
        assert.equal(((await reads()).at(-1) as any).scope, 'own_history'); assert.equal((await reads()).length, before + 1);
        assert.equal((await fileStatus(rxOther.rel, 'D')).status, 404);
        await expect('X', 'GET', '/records-access/requests', 200);
        await expect('X', 'GET', '/records-access/grants', 200);
        assert.equal((await expect('X', 'POST', `/records-access/grants/${ok.grant._id}/revoke`, 200, {})).json.data.grant.state, 'revoked');
      } finally { process.env.RECORDS_ACCESS_ENABLED = 'true'; }
    });

    await check('indexes: without the grants or pending-request unique index, request and approve answer 503 INDEXES_OUTDATED', async () => {
      const r = (await expect('D', 'POST', REQ(treat), 201, {})).json.data;
      await RecordAccessGrantModel.collection.dropIndex('holderUserId_1_personKey_1_specialistId_1');
      resetIndexChecks();
      try {
        await expect('D', 'POST', REQ(treat), 503, {}, 'INDEXES_OUTDATED');
        await expect('X', 'POST', `/records-access/requests/${r.requestId}/approve`, 503, {}, 'INDEXES_OUTDATED');
      } finally { await RecordAccessGrantModel.syncIndexes(); resetIndexChecks(); }
      await RecordAccessRequestModel.collection.dropIndex('treatingBookingId_1_specialistId_1');
      resetIndexChecks();
      try { await expect('D', 'POST', REQ(treat), 503, {}, 'INDEXES_OUTDATED'); }
      finally { await RecordAccessRequestModel.syncIndexes(); resetIndexChecks(); }
      assert.equal((await RecordAccessRequestModel.findById(r.requestId).lean())!.state, 'pending', 'nothing was written');
      await expect('X', 'POST', `/records-access/requests/${r.requestId}/approve`, 200, {});
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
