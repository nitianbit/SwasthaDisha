/**
 * r40 (ASSISTED_BOOKING_DESIGN.md §26.24, P3): server support for the clinic reception.
 * - GET /partner-workspace/clinic/appointments: `data` as before, and `busy[]` beside it — when each clinic doctor the member
 *   sees is taken elsewhere ({ doctorId, from, to } only; this clinic's own appointments the member reads are not busy).
 * - GET /partner-workspace/today and POST …/today/search for a CLINIC: its appointments (desk and online) and its bills,
 *   branch scope and permissions, the day's money (bills only; online appointments shown paid, not counted), pending.
 * - /partner-workspace/todos for a clinic (owner kind `clinic`, shared, branch-scoped). A lab keeps its own register.
 * Real routes over HTTP (configureRoutes) on MongoDB.
 *
 * Run (throwaway DB only; the script drops its database):
 *   JWT_SECRET_KEY=local-integration-only SESSION_ORIGINS_CUSTOMER=https://app.jansetu.test SESSION_ORIGINS_WORKSPACE=https://staff.jansetu.test \
 *     MONGODB_URL='mongodb://127.0.0.1:27917/r40_clinic_reception_check?directConnection=true' npx tsx test/partners/r40-clinic-reception.integration.ts
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
import SpecialistModel from '@/modules/specialists/model';
import BookingModel from '@/modules/bookings/model';
import UserModel from '@/modules/user/model';
import DependentModel from '@/modules/dependents/model';
import { DoctorReservationModel } from '@/modules/doctors/model/reservation';
import { InvoiceEventModel, InvoiceModel } from '@/modules/partners/model/invoice';
import { TodoModel } from '@/modules/todos/model';
import { PartnerRepository } from '@/modules/partners/repository';
import { MemberRepository } from '@/modules/partners/repository/member';
import { BranchRepository } from '@/modules/partners/repository/branch';
import { PartnerService, adminActor } from '@/modules/partners/services';
import * as clinic from '@/modules/partners/services/clinic';
import { setAssistedNotifier } from '@/modules/assisted/support';
import { maskName } from '@/modules/assisted/names';
import PartnerAuditEventModel from '@/modules/partners/model/audit';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/r40_clinic_reception_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const oid = () => new Types.ObjectId().toHexString();
const partnerSvc = new PartnerService(new PartnerRepository(), new MemberRepository(), new BranchRepository());
Container.set(PartnerService, partnerSvc);
setAssistedNotifier(async () => undefined);

let passed = 0;
const failed: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log('ok -', name); } catch (e) { failed.push(name); console.log('FAIL -', name); console.error(e); }
}
let phoneSeq = 7400000000;
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
    // ── A clinic with two branches; a desk per branch, a biller, a staff manager; another clinic; a lab ──
    const { partner, owner } = await partnerSvc.createPartner({ kind: 'clinic', name: 'Care Clinic', contactPhone: nextPhone(), invoiceSeriesPrefix: 'CC',
      firstOwner: { phone: nextPhone(), name: 'Clinic Owner' } } as never);
    const C = String(partner._id);
    await partnerSvc.verifyPartner(C, 'admin');
    const own = { memberId: String(owner._id), partnerId: C, role: 'owner', permissions: [], branchIds: [] } as never;
    const branch = (name: string) => partnerSvc.createBranch(own, { name, phone: nextPhone(), holidays: [], hours: {},
      services: { homeCollection: false, inLab: false, inClinic: true }, address: { line1: '1 Road', city: 'Pune', state: 'Maharashtra', stateCode: '27', pincode: '411001' } } as never);
    const A = String((await branch('Kothrud'))._id); const B = String((await branch('Baner'))._id);
    const deskA = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Desk A', role: 'staff', permissions: ['bookings.manage'], branchIds: [A] } as never);
    const deskB = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Desk B', role: 'staff', permissions: ['bookings.view'], branchIds: [B] } as never);
    const biller = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Biller', role: 'staff', permissions: ['invoices.create'], branchIds: [] } as never);
    const manager = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Manager', role: 'staff', permissions: ['staff.manage'], branchIds: [] } as never);
    const { partner: other, owner: otherOwner } = await partnerSvc.createPartner({ kind: 'clinic', name: 'Other Clinic', contactPhone: nextPhone(), invoiceSeriesPrefix: 'OC',
      firstOwner: { phone: nextPhone(), name: 'Other Owner' } } as never);
    const OC = String(other._id);
    await partnerSvc.verifyPartner(OC, 'admin');
    const OCB = String((await partnerSvc.createBranch({ memberId: String(otherOwner._id), partnerId: OC, role: 'owner', permissions: [], branchIds: [] } as never,
      { name: 'Other Main', phone: nextPhone(), holidays: [], hours: {}, services: { homeCollection: false, inLab: false, inClinic: true },
        address: { line1: '2 Road', city: 'Pune', state: 'Maharashtra', stateCode: '27', pincode: '411002' } } as never))._id);
    const { partner: lab, owner: labOwner } = await partnerSvc.createPartner({ kind: 'lab', name: 'Metro Labs', contactPhone: nextPhone(), invoiceSeriesPrefix: 'ML',
      firstOwner: { phone: nextPhone(), name: 'Lab Owner' }, taxRegime: 'unregistered' } as never);
    const L = String(lab._id);
    await partnerSvc.verifyPartner(L, 'admin');

    // ── Doctors: D1 at every branch, D2 at Baner only, D3 not at this clinic ──
    const doctor = async (name: string) => {
      const id = new Types.ObjectId();
      await SpecialistModel.collection.insertOne({ _id: id, name, phone: nextPhone(), email: `${name.replace(/\W/g, '')}@x.test`, specialization: 'General Physician',
        consultationFee: 500, isActive: true, isVerified: true } as never);
      return id.toHexString();
    };
    const D1 = await doctor('Dr Anil'); const D2 = await doctor('Dr Bela'); const D3 = await doctor('Dr Chand');
    await clinic.linkDoctor(adminActor('r40-admin', C), { doctorId: D1, branchIds: [], requestKey: 'r40-link-0001' });
    await clinic.linkDoctor(adminActor('r40-admin', C), { doctorId: D2, branchIds: [B], requestKey: 'r40-link-0002' });

    const sign = (claims: object) => jwt.sign(claims, CONFIG.JWT_SECRET_KEY, { expiresIn: '1h' });
    const member = (m: { _id: unknown }, p = C) => sign({ _id: String(m._id), memberId: String(m._id), partnerId: p, userType: 'partner' });
    const tokens: Record<string, string> = { OWN: member(owner), DESKA: member(deskA), DESKB: member(deskB), BILL: member(biller), MGR: member(manager),
      OTHER: member(otherOwner, OC), LAB: member(labOwner, L) };
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

    // ── The day: appointments, bills, held intervals ──
    const DAY = '2026-11-20';
    const at = (hm: string, d = DAY) => new Date(`${d}T${hm}:00+05:30`);
    const U1 = oid(); const U2 = oid();
    await UserModel.collection.insertMany([{ _id: new Types.ObjectId(U1), userType: 'user', phone: '9855550001', name: 'Ravi Das' },
      { _id: new Types.ObjectId(U2), userType: 'user', phone: '9866660002', name: 'Sita Rao' }] as never);
    const mina = String((await DependentModel.create({ userId: U1, name: 'Mina Das', relationship: 'Daughter', gender: 'Female', isActive: true } as never))._id);
    const appt = (x: Record<string, unknown>) => ({ bookingType: 'consultation', userId: U1, specialistId: D1, doctorName: 'Dr Anil', consultationMode: 'in-person',
      serviceMode: 'in-person', bookingDate: '20261120', status: 'confirmed', paymentStatus: 'pending', price: 500, ...x });
    const desk = (branchId: string, extra: Record<string, unknown> = {}) => ({ clinicDesk: { partnerId: C, branchId, arrivedAt: null, ...extra },
      clinicVisit: { partnerId: C, branchId }, settlementSystem: 'clinic' });
    const visit = (branchId: string) => ({ clinicVisit: { partnerId: C, branchId }, settlementSystem: 'ledger' });
    const rows = await BookingModel.collection.insertMany([
      appt({ ...desk(A), bookingTime: '11:00', createdAt: at('10:00'), updatedAt: at('10:00') }), // 0 desk, billed and paid in cash
      appt({ ...desk(A, { arrivedAt: at('11:50') }), dependentId: mina, bookingTime: '12:00', createdAt: at('10:30'), updatedAt: at('11:50') }), // 1 desk, family member, arrived, no bill
      appt({ ...visit(B), userId: U2, specialistId: D2, doctorName: 'Dr Bela', consultationMode: 'video', paymentStatus: 'paid', price: 700, bookingTime: '15:00',
        lifecycle: { paid: { at: at('09:01').toISOString() } }, contactNo: '9877770003', createdAt: at('09:00'), updatedAt: at('09:01') }), // 2 online at Baner, paid online
      appt({ ...visit(A), paymentStatus: 'paid', bookingDate: '20261122', bookingTime: '10:00', lifecycle: { paid: { at: at('12:30').toISOString() } }, createdAt: at('18:00', '2026-11-18'),
        updatedAt: at('12:30') }), // 3 online, made earlier, paid this day (for the 22nd)
      appt({ ...visit(A), status: 'pending', bookingTime: '18:00', createdAt: at('13:00'), updatedAt: at('13:00') }), // 4 online, waiting for its payment
      appt({ ...desk(B), specialistId: D2, doctorName: 'Dr Bela', bookingTime: '16:00', createdAt: at('17:00', '2026-11-19'), updatedAt: at('17:00', '2026-11-19') }), // 5 desk at Baner, made earlier
      appt({ ...desk(B), bookingTime: '17:00', createdAt: at('17:10', '2026-11-19'), updatedAt: at('17:10', '2026-11-19') }), // 6 D1 at Baner, made earlier
      appt({ clinicDesk: { partnerId: OC, branchId: OCB, arrivedAt: null }, settlementSystem: 'clinic', bookingTime: '14:30', createdAt: at('10:00'), updatedAt: at('10:00') }), // 7 another clinic
      appt({ consultationMode: 'video', paymentStatus: 'paid', bookingTime: '14:00', createdAt: at('08:00'), updatedAt: at('08:00') }), // 8 D1 online, no clinic
      appt({ ...desk(A), bookingDate: '20261125', bookingTime: '10:00', createdAt: at('09:00', '2026-11-19'), updatedAt: at('09:00', '2026-11-19') }), // 9 desk, a later visit, no bill yet
    ] as never);
    const ids = Object.values(rows.insertedIds).map(String);
    let billNo = 0;
    const bill = (x: Record<string, unknown>) => ({ partnerId: C, branchId: A, number: ++billNo, financialYear: '2026-27', serial: `CC/${oid().slice(-4)}`, documentKind: 'bill_of_supply',
      supplier: { name: 'Care', address: 'x', placeOfSupply: '27' }, customer: { name: 'Ravi Das', phone: '9822223333' }, items: [{ description: 'Consultation', qty: 1,
        unitPriceMinor: 50_000, discountMinor: 0, amountMinor: 50_000 }], totals: { subtotalMinor: 50_000, discountMinor: 0, taxableMinor: 50_000, cgstMinor: 0, sgstMinor: 0,
        igstMinor: 0, totalMinor: 50_000, currency: 'INR' }, lifecycleState: 'issued', lifecycleVersion: 0, createdBy: 'x', checksum: 'x', idempotencyKey: oid(),
      requestHash: 'x', ...x });
    const bills = await InvoiceModel.collection.insertMany([
      bill({ appointmentId: ids[0], doctorId: D1, lifecycleState: 'paid', paidMinor: 50_000, issuedAt: at('11:30'), createdAt: at('11:30'), updatedAt: at('11:31') }), // 0 appt 0, cash
      bill({ branchId: B, serial: 'CC/B-1', customer: { name: 'Kiran', phone: '9833334444' }, totals: { totalMinor: 30_000 }, issuedAt: at('13:30'), createdAt: at('13:30'),
        updatedAt: at('13:30') }), // 1 unpaid
      bill({ customer: { name: 'Old Bill' }, totals: { totalMinor: 20_000 }, lifecycleState: 'paid', paidMinor: 20_000, issuedAt: at('17:00', '2026-11-19'),
        createdAt: at('17:00', '2026-11-19'), updatedAt: at('14:00') }), // 2 made earlier, paid this day by UPI
      bill({ customer: { name: 'Cancel Me' }, totals: { totalMinor: 15_000 }, lifecycleState: 'cancelled', paidMinor: 15_000, issuedAt: at('16:00'), createdAt: at('16:00'),
        updatedAt: at('16:30') }), // 3 paid in cash and refunded in cash
      bill({ partnerId: OC, issuedAt: at('11:00'), createdAt: at('11:00'), updatedAt: at('11:00') }), // 4 another clinic
    ] as never);
    const billIds = Object.values(bills.insertedIds).map(String);
    await InvoiceEventModel.collection.insertMany([
      { invoiceId: billIds[0], kind: 'payment', amountMinor: 50_000, mode: 'cash', version: 1, at: at('11:31'), by: 'x', byKind: 'member' },
      { invoiceId: billIds[2], kind: 'payment', amountMinor: 20_000, mode: 'upi', version: 1, at: at('14:00'), by: 'x', byKind: 'member' },
      { invoiceId: billIds[3], kind: 'payment', amountMinor: 15_000, mode: 'cash', version: 1, at: at('16:00'), by: 'x', byKind: 'member' },
      { invoiceId: billIds[3], kind: 'cancellation', reason: 'wrong', refund: { mode: 'cash', amountMinor: 15_000 }, version: 2, at: at('16:30'), by: 'x', byKind: 'member' },
    ] as never);
    const held = (doctorId: string, refId: string, from: string, to: string, extra: Record<string, unknown> = {}) => ({ doctorId, kind: 'scheduled', refId,
      startTime: at(from), endTime: at(to), isActive: true, ...extra });
    await DoctorReservationModel.collection.insertMany([
      held(D1, ids[0], '11:00', '11:15'), // this clinic's appointment (listed): not busy
      held(D1, ids[8], '14:00', '14:30', { kind: 'instant' }), // online elsewhere
      held(D1, ids[7], '14:30', '15:00'), // another clinic, touching: merged with the one above
      held(D1, oid(), '09:00', '09:30', { isActive: false }), // released: not busy
      held(D2, ids[5], '16:00', '16:15'), // this clinic at Baner
      held(D1, ids[6], '17:00', '17:15'), // this clinic at Baner: busy only for a member who cannot see Baner
      held(D3, oid(), '10:00', '11:00'), // a doctor not at this clinic
      held(D1, oid(), '08:37', '09:07', { kind: 'instant', startTime: new Date(`${DAY}T08:37:12+05:30`), endTime: new Date(`${DAY}T09:07:12+05:30`) }), // r40c: an odd instant start
      held(D2, oid(), '00:00', '00:20', { startTime: at('23:50', '2026-11-19') }), // r40c: across midnight: clipped to the asked day
      held(D1, oid(), '10:00', '10:30', { startTime: at('10:00', '2026-11-21'), endTime: at('10:30', '2026-11-21') }), // another day
    ] as never);

    // ───────────────────────── 1. The day view's busy blocks ─────────────────────────
    await check('clinic appointments: `data` as before, `busy[]` beside it — other work only as { doctorId, from, to }, merged, this clinic\'s own appointments never busy', async () => {
      const r = await expect('OWN', 'GET', `/clinic/appointments?from=${DAY}&to=${DAY}`, 200);
      assert.deepEqual(Object.keys(r.json).sort(), ['busy', 'data', 'success']);
      assert.deepEqual(r.json.data.map((a: any) => a.bookingId).sort(), [ids[0], ids[1], ids[2], ids[4], ids[5], ids[6]].sort());
      const row = r.json.data.find((a: any) => a.bookingId === ids[1]);
      assert.deepEqual([row.source, row.patient.name, row.patient.accountName, row.bill], ['desk', 'Mina Das', 'Ravi Das', null]);
      const sorted = (xs: any[]) => [...xs].sort((a, b) => (a.doctorId + a.from).localeCompare(b.doctorId + b.from));
      const blk = (d: string, f: string, t: string) => ({ doctorId: d, from: at(f).toISOString(), to: at(t).toISOString() });
      // r40c (C3b): 08:37:12–09:07:12 shows as 08:30–09:15; 23:50 the day before–00:20 is clipped to 00:00–00:30.
      assert.deepEqual(sorted(r.json.busy), sorted([blk(D1, '08:30', '09:15'), blk(D1, '14:00', '15:00'), blk(D2, '00:00', '00:30')]));
      for (const b of r.json.busy) assert.deepEqual(Object.keys(b).sort(), ['doctorId', 'from', 'to']);
      // Desk A cannot see Baner: D1's Baner appointment is busy for it; D2 (Baner only) is not its doctor.
      const a = await expect('DESKA', 'GET', `/clinic/appointments?from=${DAY}&to=${DAY}`, 200);
      assert.deepEqual(a.json.busy, [blk(D1, '08:30', '09:15'), blk(D1, '14:00', '15:00'), blk(D1, '17:00', '17:15')]);
      assert.ok(!a.json.data.some((x: any) => x.bookingId === ids[6]));
      // The list's branch filter: Baner only → D1's Kothrud appointment is busy there.
      const b = await expect('OWN', 'GET', `/clinic/appointments?from=${DAY}&to=${DAY}&branchId=${B}`, 200);
      assert.ok(b.json.busy.some((x: any) => x.doctorId === D1 && x.from === at('11:00').toISOString()));
      // One doctor.
      const d2 = await expect('OWN', 'GET', `/clinic/appointments?from=${DAY}&to=${DAY}&doctorId=${D2}`, 200);
      assert.deepEqual(d2.json.busy, [blk(D2, '00:00', '00:30')]);
      await expect('OWN', 'GET', `/clinic/appointments?from=${DAY}&to=2026-11-01`, 400, undefined, 'INVALID_DATE');
      const text = JSON.stringify(r.json.busy);
      assert.ok(!text.includes('Ravi') && !text.includes(ids[8]) && !text.includes(OC), 'no patient, booking or place');
    });

    // ───────────────────────── 2. The clinic's Today ─────────────────────────
    await check('GET /today (clinic owner): appointments and bills oldest first; a desk appointment paid by its bill; online paid, not counted; money by method with refunds; pending', async () => {
      const r = await expect('OWN', 'GET', `/today?date=${DAY}`, 200);
      assert.equal(r.headers.get('cache-control'), 'private, no-store');
      const d = r.json.data;
      assert.deepEqual(d.items.map((i: any) => [i.kind, i.id]), [['appointment', ids[2]], ['appointment', ids[0]], ['appointment', ids[1]], ['bill', billIds[0]],
        ['appointment', ids[3]], ['appointment', ids[4]], ['bill', billIds[1]], ['bill', billIds[2]], ['bill', billIds[3]]]);
      const by = (id: string) => d.items.find((i: any) => i.id === id);
      assert.deepEqual(Object.keys(by(ids[0])).sort(), ['amountMinor', 'at', 'id', 'kind', 'link', 'madeOn', 'method', 'paid', 'paidToday', 'patientName', 'shortRef',
        'status', 'what', 'whatParts']);
      assert.deepEqual([by(ids[0]).patientName, by(ids[0]).paid, by(ids[0]).method, by(ids[0]).amountMinor, by(ids[0]).link], ['Ravi Das', true, null, 50_000,
        { kind: 'booking', id: ids[0] }]);
      assert.deepEqual(by(ids[0]).whatParts, { code: 'clinic.appointment', values: { doctor: 'Dr Anil', date: DAY, time: '11:00', mode: 'in-person', source: 'desk' } });
      assert.equal(by(ids[0]).what, `Dr Anil · ${DAY} 11:00 · in-person`);
      assert.deepEqual([by(ids[1]).patientName, by(ids[1]).paid], ['Mina Das', false]);
      assert.deepEqual([by(ids[2]).paid, by(ids[2]).method, by(ids[2]).whatParts.values.source, by(ids[2]).patientName], [true, 'online', 'online', 'Sita Rao']);
      assert.deepEqual([by(ids[3]).paidToday, by(ids[3]).madeOn, by(ids[3]).at], [true, '2026-11-18', at('12:30').toISOString()]);
      assert.deepEqual([by(billIds[0]).appointmentId, by(billIds[0]).shortRef !== null, by(billIds[0]).method, by(billIds[0]).link.kind], [ids[0], true, 'cash', 'invoice']);
      assert.equal(by(billIds[1]).appointmentId, null);
      assert.deepEqual([by(billIds[2]).paidToday, by(billIds[2]).method], [true, 'upi']);
      assert.deepEqual(d.totals, { collectedMinor: 85_000, byMethod: { cash: 65_000, upi: 20_000, card: 0, bank: 0, wallet: 0, online: 0, other: 0 }, unpaidMinor: 30_000,
        count: 9, refundedMinor: 15_000, refundsByMethod: { cash: 15_000, upi: 0, card: 0, bank: 0, wallet: 0, online: 0, other: 0 } });
      const t = d.pending.appointmentsToday;
      assert.deepEqual([t.count, t.toCheckInCount, t.toConfirmCount, t.toConfirmIds], [4, 3, 1, [ids[4]]]);
      assert.deepEqual([...d.pending.appointmentsToday.toCheckInIds].sort(), [ids[0], ids[5], ids[6]].sort());
      // r40c: the later visit (the 25th) is not yet to bill.
      assert.deepEqual([d.pending.deskUnbilled.count, [...d.pending.deskUnbilled.ids].sort(), d.pending.deskUnbilled.truncated], [3, [ids[1], ids[5], ids[6]].sort(), undefined]);
      assert.deepEqual(d.pending.unpaidBills, { count: 1, ids: [billIds[1]] });
      assert.ok(!JSON.stringify(d).includes(ids[7]) && !JSON.stringify(d).includes(billIds[4]), 'never another clinic\'s rows');
      // Paging and order as the lab's.
      const p1 = (await expect('OWN', 'GET', `/today?date=${DAY}&limit=4&order=desc`, 200)).json.data;
      assert.deepEqual(p1.items.map((i: any) => i.id), [billIds[3], billIds[2], billIds[1], ids[4]]);
      const p2 = (await expect('OWN', 'GET', `/today?date=${DAY}&limit=4&order=desc&cursor=${p1.nextCursor}`, 200)).json.data;
      assert.equal(p2.pending, undefined); assert.deepEqual(p2.totals, d.totals);
    });

    await check('scope and permissions: a Baner desk sees Baner appointments and its queues, no bills; a biller only bills (no appointment link); a staff manager 403; another clinic only its own', async () => {
      const b = (await expect('DESKB', 'GET', `/today?date=${DAY}`, 200)).json.data;
      assert.deepEqual(b.items.map((i: any) => i.id), [ids[2]]);
      assert.deepEqual(Object.keys(b.pending).sort(), ['appointmentsToday', 'deskUnbilled']);
      assert.deepEqual([...b.pending.appointmentsToday.toCheckInIds].sort(), [ids[5], ids[6]].sort());
      assert.equal(b.totals.collectedMinor, 0);
      const bill = (await expect('BILL', 'GET', `/today?date=${DAY}`, 200)).json.data;
      assert.deepEqual(bill.items.map((i: any) => i.kind), ['bill', 'bill', 'bill', 'bill']);
      assert.equal(bill.items[0].appointmentId, null, 'the appointment is not the biller\'s to read');
      assert.deepEqual(Object.keys(bill.pending), ['unpaidBills']);
      await expect('MGR', 'GET', `/today?date=${DAY}`, 403);
      const o = (await expect('OTHER', 'GET', `/today?date=${DAY}`, 200)).json.data;
      assert.deepEqual(o.items.map((i: any) => i.id).sort(), [ids[7], billIds[4]].sort());
    });

    await check('POST /today/search (clinic): the person seen, the account holder, the doctor, the contact and account phones, bill serial and customer phone; scope', async () => {
      const s = async (who: string, q: string) => (await expect(who, 'POST', '/today/search', 200, { date: DAY, q })).json.data.items.map((i: any) => i.id).sort();
      assert.deepEqual(await s('OWN', 'mina'), [ids[1]]);
      assert.deepEqual(await s('OWN', 'Ravi'), [ids[0], ids[1], ids[3], ids[4], billIds[0]].sort());
      assert.deepEqual(await s('OWN', 'dr bela'), [ids[2]]);
      assert.deepEqual(await s('OWN', '0003'), [ids[2]]);
      assert.deepEqual(await s('OWN', '55550001'), [ids[0], ids[1], ids[3], ids[4]].sort());
      assert.deepEqual(await s('OWN', 'CC/B-1'), [billIds[1]]);
      assert.deepEqual(await s('OWN', '33334444'), [billIds[1]]);
      assert.deepEqual(await s('DESKB', 'Ravi'), []);
      await expect('OWN', 'POST', '/today/search', 400, { date: DAY, q: 'x' });
    });

    await check('r40c: an earlier appointment paid and refunded on the day sorts at its payment time; deskUnbilled says when its 2000 cap was hit', async () => {
      const D24 = '2026-11-24';
      const r = await BookingModel.collection.insertMany([
        appt({ ...visit(A), bookingDate: '20261124', bookingTime: '09:00', createdAt: at('10:00', D24), updatedAt: at('10:00', D24) }),
        appt({ ...visit(A), status: 'cancelled', paymentStatus: 'refunded', bookingDate: '20261126', bookingTime: '09:00',
          lifecycle: { paid: { at: at('15:30', D24).toISOString() } }, createdAt: at('12:00', '2026-11-22'), updatedAt: at('16:00', D24) }),
        appt({ ...visit(A), bookingDate: '20261124', bookingTime: '19:00', createdAt: at('18:00', D24), updatedAt: at('18:00', D24) }),
      ] as never);
      const rid = Object.values(r.insertedIds).map(String);
      const d = (await expect('OWN', 'GET', `/today?date=${D24}`, 200)).json.data;
      assert.deepEqual(d.items.map((i: any) => i.id), [rid[0], rid[1], rid[2]]);
      assert.deepEqual([d.items[1].at, d.items[1].paid, d.items[1].madeOn], [at('15:30', D24).toISOString(), false, '2026-11-22']);
      // Another clinic with more than 2000 unbilled desk visits: the count stops at the cap and says so.
      await BookingModel.collection.insertMany(Array.from({ length: 2001 }, (_, i) => appt({ clinicDesk: { partnerId: OC, branchId: OCB, arrivedAt: null },
        clinicVisit: { partnerId: OC, branchId: OCB }, settlementSystem: 'clinic', bookingDate: '20261110', bookingTime: '10:00',
        createdAt: new Date(at('10:00', '2026-11-10').getTime() + i * 1000), updatedAt: at('10:00', '2026-11-10') })) as never);
      const o = (await expect('OTHER', 'GET', `/today?date=${DAY}`, 200)).json.data;
      assert.deepEqual([o.pending.deskUnbilled.count, o.pending.deskUnbilled.truncated, o.pending.deskUnbilled.ids.length], [2000, true, 20]);
    });

    await check('r40d: POST /clinic/patients/lookup — { exists, holderNameMasked } (masked only), counted against the clinic\'s hourly limit, audited with ids only; bookings.manage at a clinic', async () => {
      const r = await expect('DESKA', 'POST', '/clinic/patients/lookup', 200, { phone: '9855550001' });
      assert.deepEqual(r.json.data, { exists: true, holderNameMasked: maskName('Ravi Das') });
      assert.notEqual(r.json.data.holderNameMasked, 'Ravi Das');
      assert.deepEqual((await expect('DESKA', 'POST', '/clinic/patients/lookup', 200, { phone: '+91 98111 00000' })).json.data, { exists: false, holderNameMasked: null });
      await expect('DESKA', 'POST', '/clinic/patients/lookup', 400, { phone: '12' });
      await expect('DESKB', 'POST', '/clinic/patients/lookup', 403, { phone: '9855550001' });
      await expect('BILL', 'POST', '/clinic/patients/lookup', 403, { phone: '9855550001' });
      await expect('LAB', 'POST', '/clinic/patients/lookup', 409, { phone: '9855550001' }, 'NOT_A_CLINIC');
      const audits = await PartnerAuditEventModel.find({ partnerId: C, action: 'clinic.patient_lookup' }).lean() as any[];
      assert.equal(audits.length, 2);
      assert.ok(!JSON.stringify(audits).includes('9855550001') && !JSON.stringify(audits).includes('Ravi'), 'ids only');
      assert.deepEqual(audits.map((a) => a.detail.exists).sort(), [false, true]);
      // The hourly limit per clinic (the lab desk's rule).
      process.env.ASSISTED_LIMIT_LOOKUPS_PER_HOUR = '3';
      try {
        await expect('OWN', 'POST', '/clinic/patients/lookup', 200, { phone: '9866660002' });
        await expect('OWN', 'POST', '/clinic/patients/lookup', 429, { phone: '9866660002' }, 'ASSISTED_LIMIT_REACHED');
        await expect('OTHER', 'POST', '/clinic/patients/lookup', 200, { phone: '9866660002' });
      } finally { delete process.env.ASSISTED_LIMIT_LOOKUPS_PER_HOUR; }
    });

    await check('a lab keeps its own register (an empty lab day answers the lab\'s shape)', async () => {
      const d = (await expect('LAB', 'GET', `/today?date=${DAY}`, 200)).json.data;
      assert.deepEqual(d.items, []);
      assert.deepEqual(Object.keys(d.pending).sort(), ['bookingsAwaitingPayment', 'consultationsWaiting', 'deskUnbilled', 'reportsDue', 'samplesToCollect', 'unpaidBills']);
    });

    // ───────────────────────── 3. Clinic to-dos ─────────────────────────
    await check('clinic to-dos: owner kind clinic, shared with the team, branch-scoped; another clinic 404; a lab\'s to-dos stay the lab\'s', async () => {
      const t = (await expect('DESKA', 'POST', '/todos', 201, { text: 'Call Mrs Das about the report', requestKey: 'r40-todo-0001' })).json.data.todo;
      assert.deepEqual([t.createdBy.kind, t.createdBy.name, t.branchIds], ['member', 'Desk A', [A]]);
      const stored = await TodoModel.findById(t._id).lean() as any;
      assert.deepEqual([stored.owner.kind, stored.owner.id], ['clinic', C.toLowerCase()]);
      const wide = (await expect('OWN', 'POST', '/todos', 201, { text: 'Order gloves', requestKey: 'r40-todo-0002' })).json.data.todo;
      assert.deepEqual(wide.branchIds, []);
      assert.deepEqual((await expect('OWN', 'GET', '/todos', 200)).json.data.map((x: any) => x._id).sort(), [t._id, wide._id].sort());
      assert.deepEqual((await expect('DESKB', 'GET', '/todos', 200)).json.data.map((x: any) => x._id), [wide._id], 'another branch: only the clinic-wide one');
      await expect('DESKB', 'PATCH', `/todos/${t._id}`, 404, { done: true, expectedVersion: t.version }, 'TODO_NOT_FOUND');
      await expect('OTHER', 'PATCH', `/todos/${wide._id}`, 404, { done: true, expectedVersion: wide.version }, 'TODO_NOT_FOUND');
      assert.equal((await expect('DESKA', 'PATCH', `/todos/${t._id}`, 200, { done: true, expectedVersion: t.version })).json.data.done, true);
      const lt = (await expect('LAB', 'POST', '/todos', 201, { text: 'Calibrate', requestKey: 'r40-todo-0003' })).json.data.todo;
      assert.equal((await TodoModel.findById(lt._id).lean() as any).owner.kind, 'lab');
      assert.ok(!(await expect('OWN', 'GET', '/todos', 200)).json.data.some((x: any) => x._id === lt._id));
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
