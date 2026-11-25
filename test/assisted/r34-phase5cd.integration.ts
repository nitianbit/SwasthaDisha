/**
 * Phase 5c and 5d (ASSISTED_BOOKING_DESIGN.md §27.7, §27.8; build record §27.14): visit reminders and the SMS video link.
 *  - 5c: a reminder 2 h before the visit; a due time between 21:00 and 07:00 India time moves to 20:00 the evening
 *    before; none within 60 minutes; never sent before it is due; a move queues a new one and the old one is stale; a
 *    cancel makes it stale; one row for racing enqueues; none for instant consultations or desk walk-ins; `place`.
 *  - 5d: the 29-character signed token (nothing stored); `GET /j/:token` redirects to Meet only inside the visit window,
 *    and every other case gets the same neutral page (200); 30 a minute per IP (429), 503 when the counter store fails;
 *    the request logger never prints the token; the link variants (BOOKED_LINK, REMINDER_LINK) only for a video
 *    consultation on the patient's phone, to the account phone (SM15), else the plain text.
 *  - Switches off: nothing queued, no link, the page.
 * The hooks are called as the booking commands call them (5b's suite covers every command path); the gateway is a fake
 * sender through setSmsProvider. Every check runs even when an earlier one fails (the run exits 1 if any failed).
 *
 * Run (throwaway DB only; the script drops its database):
 *   JWT_SECRET_KEY=local-integration-only SESSION_ORIGINS_CUSTOMER=https://app.jansetu.test SESSION_ORIGINS_WORKSPACE=https://staff.jansetu.test \
 *     MONGODB_URL='mongodb://127.0.0.1:27917/r34_phase5cd_check?directConnection=true' npx tsx test/assisted/r34-phase5cd.integration.ts
 */
import { removeFixtureDir } from '../partners/q3-fixture-dir';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import express from 'express';
import mongoose, { Types } from 'mongoose';
import logger from '@/services/logger';
import { errorHandler } from '@/modules/middleware';
import { requestLogger } from '@/modules/middleware/requestLogger';
import UserModel from '@/modules/user/model';
import BookingModel from '@/modules/bookings/model';
import SpecialistModel from '@/modules/specialists/model';
import PartnerModel from '@/modules/partners/model';
import { PartnerLabBookingModel } from '@/modules/partners/model/labBooking';
import { SmsNoticeModel } from '@/modules/smsNotices/model';
import { drainSmsOnce } from '@/modules/smsNotices/drain';
import { setSmsProvider } from '@/modules/smsNotices/provider';
import { registerSmsComposers, reminderDueAt, smsBooked, smsCancelled, smsMoved } from '@/modules/smsNotices/events';
import { joinTokenOf, joinUrlFor } from '@/modules/smsNotices/joinLink';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/r34_phase5cd_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const oid = () => new Types.ObjectId().toHexString();
const MIN = 60_000;
const DAY = 86_400_000;
const IST = 330 * MIN;
/** India time: a Date for `YYYY-MM-DD` at `HH:MM`, and the booking fields of a Date. */
const istAt = (ymd: string, hm: string) => new Date(`${ymd}T${hm}:00+05:30`);
const istYmd = (t: Date) => new Date(t.getTime() + IST).toISOString().slice(0, 10);
const fields = (t: Date) => ({ bookingDate: istYmd(t).replace(/-/g, ''), bookingTime: new Date(t.getTime() + IST).toISOString().slice(11, 16) });
const dmy = (t: Date) => istYmd(t).split('-').reverse().join('-');
const hhmm = (t: Date) => new Date(t.getTime() + IST).toISOString().slice(11, 16);

// ── Every log line of the run (the token must never be in one) ──
const logged: string[] = [];
for (const level of ['info', 'warn', 'error'] as const) {
  const real = (logger as any)[level].bind(logger);
  (logger as any)[level] = (...a: unknown[]) => { logged.push(JSON.stringify(a)); return real(...a); };
}

// ── The SMS gateway stand-in ──
const sent: { to: string; text: string; templateId: string }[] = [];
setSmsProvider({ configured: () => true, send: async (m) => { sent.push({ to: m.to, text: m.text, templateId: m.templateId }); return { ok: true as const, status: 200 }; } });
const BASE = 'https://app.jansetu.test/j';
const SECRET = 'r34-join-link-secret-0123456789-abcdefghijklmnop';
const T: Record<string, string> = { BOOKED: 'T-BOOKED', BOOKED_LINK: 'T-BOOKED-LINK', REMINDER: 'T-REMINDER', REMINDER_LINK: 'T-REMINDER-LINK', CANCELLED_MOVED: 'T-CANCELLED' };
const SMS_ON: Record<string, string> = { SMS_NOTICES_ENABLED: 'true', SMS_JOIN_LINK_BASE_URL: BASE, JOIN_LINK_SECRET: SECRET, SMS_JOIN_RATE_PER_MINUTE: '100000' };
for (const [m, id] of Object.entries(T)) { SMS_ON[`SMS_${m}_EN_ENABLED`] = 'true'; SMS_ON[`SMS_${m}_EN_TEMPLATE`] = id; }
const smsOn = () => Object.assign(process.env, SMS_ON);

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
  app.set('trust proxy', 1); // as TRUST_PROXY behind the proxy: the client address counts
  app.use(requestLogger);
  app.use(express.json());
  configureRoutes(app);
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  registerSmsComposers();
  smsOn();

  try {
    const X = oid(); const P = oid(); const D = oid(); const DU = oid(); const L = oid();
    const PHONE_X = '9600003401';
    await UserModel.collection.insertOne({ _id: new Types.ObjectId(X), userType: 'user', phone: PHONE_X, name: 'Rina Kumari Das', createdSource: 'assisted_booking' } as never);
    await SpecialistModel.collection.insertMany([
      { _id: new Types.ObjectId(D), name: 'Asha Menon', email: 'asha@doc.test', specialization: 'General Physician', isActive: true, isVerified: true },
      { _id: new Types.ObjectId(DU), name: 'Dr New', email: 'new@doc.test', specialization: 'General Physician', isActive: true, isVerified: false },
    ] as never);
    await PartnerModel.collection.insertOne({ _id: new Types.ObjectId(L), kind: 'lab', name: 'Metro Labs', isActive: true, verification: { state: 'verified' } } as never);
    let refSeq = 0;
    const newRef = () => `R34${'ABCDEFGHJKMNPQRSTUVWXYZ234567'[refSeq++ % 29]}${'ABCDEFGH'[Math.floor(refSeq / 29) % 8]}AAA`.slice(0, 8);
    const MEET = 'https://meet.google.com/abc-defg-hij';
    /** A paid, confirmed partner-made consultation of X starting at `start` (video, on the patient's phone, unless overridden). */
    const consult = async (start: Date, extra: Record<string, unknown> = {}, assisted: Record<string, unknown> = {}) => {
      const id = new Types.ObjectId();
      await BookingModel.collection.insertOne({ _id: id, bookingType: 'consultation', specialistId: D, userId: X, ...fields(start), consultationMode: 'video',
        serviceMode: 'video', status: 'confirmed', paymentStatus: 'paid', source: 'pharmacy_assisted', createdAt: new Date(), updatedAt: new Date(),
        virtualMeeting: { provider: 'google_meet', status: 'active', joinUrl: MEET },
        assisted: { shortRef: newRef(), bookedBy: { kind: 'pharmacy', id: P, name: 'Sharma Medicals' }, preferredLanguage: 'en',
          join: { on: 'patient_phone', phone: '9123400000', linkVersion: 1 }, funding: { method: 'wallet', state: 'captured' }, ...assisted }, ...extra } as never);
      return id.toHexString();
    };
    const labRow = async (start: Date, extra: Record<string, unknown> = {}) => {
      const id = new Types.ObjectId();
      await PartnerLabBookingModel.collection.insertOne({ _id: id, partnerId: L, branchId: oid(), userId: X, source: 'pharmacy_assisted',
        patient: { kind: 'self', name: 'Rina' }, visitMode: 'lab', slot: { date: istYmd(start), startTime: hhmm(start), endTime: hhmm(new Date(start.getTime() + 30 * MIN)), startsAt: start },
        items: [{ catalogItemId: oid(), kind: 'test', name: 'CBC', priceMinor: 50000, gstRate: 0 }], status: 'confirmed', statusVersion: 1, paymentStatus: 'paid',
        report: { draftFiles: [], releasedFiles: [], releases: [] }, settlement: { settlementSystem: 'ledger' },
        assisted: { shortRef: newRef(), bookedBy: { kind: 'pharmacy', id: P, name: 'Sharma Medicals' }, preferredLanguage: 'en', funding: { method: 'wallet' } },
        createdAt: new Date(), updatedAt: new Date(), ...extra } as never);
      return id.toHexString();
    };
    const doc = async (id: string) => await BookingModel.findById(id).lean() as any;
    const labDoc = async (id: string) => await PartnerLabBookingModel.findById(id).lean() as any;
    const rowsOf = async (id: string) => await SmsNoticeModel.find({ bookingId: id }).sort({ createdAt: 1, _id: 1 }).lean() as any[];
    const reminderOf = async (id: string) => (await rowsOf(id)).filter((r) => r.event === 'reminder');
    const drain = async (now?: Date) => { const before = sent.length; const out = await drainSmsOnce(now); return { out, sent: sent.slice(before) }; };
    const day = istYmd(new Date(Date.now() + 3 * DAY));            // three days ahead, India date
    const dayBefore = istYmd(new Date(Date.now() + 2 * DAY));

    // ───────────────────────── 5c: when the reminder is due ─────────────────────────
    await check('due times: 10:00 → 08:00; 07:30 → 20:00 the evening before; 23:30 → 20:00 the same day; 21:00 and 06:59 are quiet, 07:00 and 20:59 are not', async () => {
      const now = new Date();
      const due = (hm: string) => { const d = reminderDueAt(istAt(day, hm), now); return d ? `${istYmd(d)} ${hhmm(d)}` : null; };
      assert.equal(due('10:00'), `${day} 08:00`);
      assert.equal(due('07:30'), `${dayBefore} 20:00`);
      assert.equal(due('23:30'), `${day} 20:00`);
      assert.equal(due('23:00'), `${day} 20:00`, 'due 21:00 is quiet');
      assert.equal(due('09:00'), `${day} 07:00`, 'due 07:00 is not');
      assert.equal(due('08:59'), `${dayBefore} 20:00`, 'due 06:59 is quiet');
      assert.equal(due('22:59'), `${day} 20:59`);
      // SMS_VISIT_REMINDER_MINUTES_BEFORE: 30–1440, else 120.
      process.env.SMS_VISIT_REMINDER_MINUTES_BEFORE = '60';
      try { assert.equal(due('10:00'), `${day} 09:00`); } finally { delete process.env.SMS_VISIT_REMINDER_MINUTES_BEFORE; }
      process.env.SMS_VISIT_REMINDER_MINUTES_BEFORE = '5';
      try { assert.equal(due('10:00'), `${day} 08:00`, 'out of range: the default'); } finally { delete process.env.SMS_VISIT_REMINDER_MINUTES_BEFORE; }
    });

    await check('none within 60 minutes: booked 50 minutes or 2.5 hours before the visit → no reminder (the "booked" row only)', async () => {
      for (const ahead of [50 * MIN, 150 * MIN]) {
        const start = new Date(Math.ceil((Date.now() + ahead) / MIN) * MIN);   // the night rule only moves a due time earlier
        const id = await consult(start);
        await smsBooked('booking', await doc(id));
        assert.deepEqual((await rowsOf(id)).map((r) => r.event), ['booked']);
      }
      assert.equal(reminderDueAt(new Date(Date.now() + 179 * MIN), new Date()), null);
      assert.ok(reminderDueAt(new Date(Date.now() + 181 * MIN), new Date()) || hhmm(new Date(Date.now() + 61 * MIN)) >= '21:00' || hhmm(new Date(Date.now() + 61 * MIN)) < '07:00');
    });

    let tokenBooking = '';
    await check('a video consultation on the patient\'s phone: one reminder, never sent before it is due; at 08:00 REMINDER_LINK to the account phone (never join.phone)', async () => {
      const start = istAt(day, '10:00');
      const id = await consult(start);
      tokenBooking = id;
      const b = await doc(id);
      await Promise.all([smsBooked('booking', b), smsBooked('booking', b), smsBooked('booking', b)]);
      const rows = await rowsOf(id);
      assert.deepEqual(rows.map((r) => `${r.event}:${r.version}`).sort(), ['booked:1', `reminder:${Math.floor(start.getTime() / MIN)}`].sort(), 'one reminder for racing enqueues');
      const r = rows.find((x) => x.event === 'reminder');
      assert.equal(new Date(r.dueAt).getTime(), istAt(day, '08:00').getTime());
      assert.deepEqual(Object.keys(r).filter((k) => !['_id', 'bookingKind', 'bookingId', 'event', 'version', 'state', 'dueAt', 'attempts', 'createdAt', 'updatedAt'].includes(k)), [],
        'ids and codes only');
      const first = await drain();
      assert.ok(first.sent.every((s) => s.templateId !== T.REMINDER_LINK && s.templateId !== T.REMINDER), 'nothing before it is due');
      assert.equal((await reminderOf(id))[0].state, 'queued');
      await drain(new Date(istAt(day, '08:00').getTime() - MIN));
      assert.equal((await reminderOf(id))[0].state, 'queued');
      const out = await drain(istAt(day, '08:00'));
      const msg = out.sent.find((s) => s.templateId === T.REMINDER_LINK)!;
      assert.ok(msg, JSON.stringify(out));
      const token = joinTokenOf(b)!;
      assert.equal(msg.text, `Jansetu reminder: Rina's video consultation on ${dmy(start)} at 10:00, Jansetu app. Join: ${BASE}/${token}`);
      assert.equal(msg.to, PHONE_X, 'SM15: the account phone');
      const booked = first.sent.find((s) => s.templateId === T.BOOKED_LINK && s.text.includes(`Ref ${b.assisted.shortRef}.`))!;
      assert.equal(booked.text, `Jansetu: Rina's video consultation is booked for ${dmy(start)} at 10:00 via Sharma Medicals. Ref ${b.assisted.shortRef}. `
        + `Join the video call at ${BASE}/${token} at the booked time.`);
      assert.equal(booked.to, PHONE_X);
      assert.deepEqual([(await reminderOf(id))[0].state, (await reminderOf(id))[0].message], ['sent', 'REMINDER_LINK']);
    });

    await check('a move queues the new time\'s reminder and the old one is stale; a cancel makes it stale', async () => {
      const start = istAt(day, '11:00');
      const id = await consult(start);
      await smsBooked('booking', await doc(id));
      const moved = istAt(day, '15:00');
      await BookingModel.updateOne({ _id: id }, { $set: fields(moved) });
      await smsMoved('booking', await doc(id));
      const reminders = await reminderOf(id);
      assert.deepEqual(reminders.map((r) => r.version), [String(Math.floor(start.getTime() / MIN)), String(Math.floor(moved.getTime() / MIN))]);
      await drain(istAt(day, '09:00'));
      assert.deepEqual((await reminderOf(id)).map((r) => [r.state, r.reason ?? null]), [['skipped', 'stale'], ['queued', null]]);
      const out = await drain(istAt(day, '13:00'));
      assert.ok(out.sent.some((s) => s.templateId === T.REMINDER_LINK && s.text.includes(`at 15:00, Jansetu app.`)));
      assert.equal((await reminderOf(id))[1].state, 'sent');

      const c = await consult(istAt(day, '12:00'));
      await smsBooked('booking', await doc(c));
      await BookingModel.updateOne({ _id: c }, { $set: { status: 'cancelled', paymentStatus: 'refunded' } });
      await smsCancelled('booking', await doc(c));
      await drain(istAt(day, '10:00'));
      assert.deepEqual((await reminderOf(c)).map((r) => [r.state, r.reason]), [['skipped', 'stale']]);
    });

    await check('none for an instant consultation or a desk walk-in; place: the booker (partner device), "the clinic", the lab, "home"', async () => {
      const inst = await consult(istAt(day, '10:00'), { bookingKind: 'instant', instantRequestId: oid() });
      await smsBooked('booking', await doc(inst));
      assert.deepEqual((await rowsOf(inst)).map((r) => r.event), ['booked']);
      const walkIn = await labRow(istAt(day, '10:00'), { source: 'lab_desk', assisted: undefined, settlement: { settlementSystem: 'lab_desk' },
        desk: { memberId: oid(), branchId: oid(), preferredLanguage: 'en' }, slot: { walkIn: true, startsAt: istAt(day, '10:00') } });
      await smsBooked('lab_booking', await labDoc(walkIn));
      assert.deepEqual(await rowsOf(walkIn), []);

      const device = await consult(istAt(day, '16:00'), {}, { join: { on: 'partner_device', linkVersion: 1 } });
      const clinic = await consult(istAt(day, '16:30'), { consultationMode: 'in-person', serviceMode: 'in-person' });
      const lab = await labRow(istAt(day, '17:00'));
      const home = await labRow(istAt(day, '17:30'), { visitMode: 'home' });
      for (const id of [device, clinic]) await smsBooked('booking', await doc(id));
      for (const id of [lab, home]) await smsBooked('lab_booking', await labDoc(id));
      const out = await drain(istAt(day, '15:45'));
      const reminders = out.sent.filter((s) => s.templateId === T.REMINDER).map((s) => s.text);
      assert.deepEqual(reminders.sort(), [
        `Jansetu reminder: Rina's video consultation on ${dmy(istAt(day, '16:00'))} at 16:00, Sharma Medicals.`,
        `Jansetu reminder: Rina's clinic consultation on ${dmy(istAt(day, '16:30'))} at 16:30, the clinic.`,
        `Jansetu reminder: Rina's lab test on ${dmy(istAt(day, '17:00'))} at 17:00, Metro Labs.`,
        `Jansetu reminder: Rina's home sample collection on ${dmy(istAt(day, '17:30'))} at 17:30, home.`,
      ].sort());
      assert.ok(!out.sent.some((s) => s.templateId === T.REMINDER_LINK || s.templateId === T.BOOKED_LINK), 'no link for the partner device or other modes');
    });

    await check('variants: REMINDER_LINK off → the plain REMINDER; no secret or no link address → plain texts and no token', async () => {
      const a = await consult(istAt(day, '18:00'));
      await smsBooked('booking', await doc(a));
      delete process.env.SMS_REMINDER_LINK_EN_ENABLED;
      try {
        const out = await drain(istAt(day, '16:00'));
        const m = out.sent.find((s) => s.text.startsWith('Jansetu reminder') && s.text.includes('18:00'))!;
        assert.equal(m.templateId, T.REMINDER); assert.ok(!m.text.includes(BASE));
      } finally { smsOn(); }
      for (const unset of ['JOIN_LINK_SECRET', 'SMS_JOIN_LINK_BASE_URL']) {
        const b = await consult(istAt(day, '18:30'));
        delete process.env[unset];
        try {
          await smsBooked('booking', await doc(b));
          const out = await drain(istAt(day, '16:30'));
          const mine = out.sent.filter((s) => s.text.includes('18:30'));
          assert.deepEqual(mine.map((s) => s.templateId).sort(), [T.BOOKED, T.REMINDER].sort(), unset);
          assert.equal(joinTokenOf(await doc(b)) === null, unset === 'JOIN_LINK_SECRET');
        } finally { smsOn(); }
      }
      process.env.JOIN_LINK_SECRET = 'too-short-secret';
      try { assert.equal(joinTokenOf(await doc(a)), null, 'a secret under 32 bytes is no secret'); } finally { smsOn(); }
    });

    await check('switch off: smsBooked and smsMoved queue nothing (no reminder)', async () => {
      delete process.env.SMS_NOTICES_ENABLED;
      try {
        const id = await consult(istAt(day, '19:00'));
        await smsBooked('booking', await doc(id));
        await smsMoved('booking', await doc(id));
        assert.deepEqual(await rowsOf(id), []);
      } finally { smsOn(); }
    });

    // ───────────────────────── 5d: the token and /j/ ─────────────────────────
    let ipSeq = 1;
    const nextIp = () => `203.0.113.${ipSeq++ % 250}`;
    const hitJ = async (path: string, opts: { method?: string; ip?: string } = {}) => {
      const r = await fetch(`${base}/j/${path}`, { method: opts.method ?? 'GET', redirect: 'manual', headers: { 'x-forwarded-for': opts.ip ?? nextIp() } });
      return { status: r.status, location: r.headers.get('location'), body: await r.text(), headers: r.headers };
    };

    await check('the token: 29 characters <ref>-<100-bit mac>, nothing stored, stable, a new one after the account move bumps linkVersion', async () => {
      const b = await doc(tokenBooking);
      const t = joinTokenOf(b)!;
      assert.match(t, /^[A-Z2-7]{8}-[A-Z2-7]{20}$/); assert.equal(t.length, 29);
      assert.equal(t.slice(0, 8), b.assisted.shortRef);
      // The MAC: HMAC-SHA256(secret, "<id>:<linkVersion>"), first 100 bits in RFC 4648 base32.
      const bits = [...createHmac('sha256', SECRET).update(`${tokenBooking}:1`).digest()].map((x) => x.toString(2).padStart(8, '0')).join('').slice(0, 100);
      assert.equal(t.slice(9), bits.match(/.{5}/g)!.map((g) => 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'[parseInt(g, 2)]).join(''));
      assert.equal(joinTokenOf(await doc(tokenBooking)), t, 'stable');
      assert.notEqual(joinTokenOf({ ...b, assisted: { ...b.assisted, join: { ...b.assisted.join, linkVersion: 2 } } }), t);
      assert.ok(!(JSON.stringify(await doc(tokenBooking))).includes(t.slice(9)), 'nothing stored');
    });

    await check('/j/: a redirect only inside the window (start − 10 min to the end); early, late, cancelled, tampered, unknown, old link version and malformed all get the same page (200)', async () => {
      const soon = await consult(new Date(Math.floor(Date.now() / MIN) * MIN + 5 * MIN));
      const tok = joinTokenOf(await doc(soon))!;
      const ok = await hitJ(tok);
      assert.equal(ok.status, 302); assert.equal(ok.location, MEET);
      assert.equal(ok.headers.get('cache-control'), 'no-store'); assert.equal(ok.headers.get('referrer-policy'), 'no-referrer'); assert.equal(ok.headers.get('x-robots-tag'), 'noindex');
      assert.equal((await hitJ(tok, { method: 'HEAD' })).status, 302, 'HEAD as GET');
      const page = await hitJ('AAAAAAAA-AAAAAAAAAAAAAAAAAAAA');
      assert.equal(page.status, 200);
      assert.ok(page.body.includes('This Jansetu link is not open now. It opens 10 minutes before the booked time.') && page.body.includes('lang="hi"'));
      assert.equal(page.headers.get('cache-control'), 'no-store'); assert.equal(page.headers.get('x-robots-tag'), 'noindex');
      const head = await hitJ('AAAAAAAA-AAAAAAAAAAAAAAAAAAAA', { method: 'HEAD' });
      assert.deepEqual([head.status, head.body], [200, ''], 'HEAD: no body');
      const closed: Record<string, string> = {};
      const early = await consult(new Date(Math.floor(Date.now() / MIN) * MIN + 12 * MIN));
      closed.early = joinTokenOf(await doc(early))!;
      const late = await consult(new Date(Math.floor(Date.now() / MIN) * MIN - 31 * MIN));
      closed.late = joinTokenOf(await doc(late))!;
      const cancelled = await consult(new Date(Date.now() - 5 * MIN), { status: 'cancelled' });
      closed.cancelled = joinTokenOf(await doc(cancelled))!;
      closed.tampered = tok.slice(0, 9) + (tok[9] === 'A' ? 'B' : 'A') + tok.slice(10);
      closed.otherRef = 'ZZZZZZZZ' + tok.slice(8);
      closed.malformed = tok.toLowerCase();
      closed.short = tok.slice(0, 28);
      const movedAway = await consult(new Date(Date.now() - 5 * MIN));
      closed.oldVersion = joinTokenOf(await doc(movedAway))!;
      await BookingModel.updateOne({ _id: movedAway }, { $inc: { 'assisted.join.linkVersion': 1 } });   // the admin account move
      for (const [why, t] of Object.entries(closed)) {
        const r = await hitJ(t);
        assert.deepEqual([r.status, r.body], [200, page.body], why);
      }
      assert.equal((await hitJ(joinTokenOf(await doc(movedAway))!)).status, 302, 'the new link of the moved booking');
      // A booker move keeps the token; the window follows the new slot.
      await BookingModel.updateOne({ _id: soon }, { $set: fields(new Date(Date.now() + 3 * DAY)) });
      assert.equal((await hitJ(tok)).status, 200);
      await BookingModel.updateOne({ _id: soon }, { $set: fields(new Date(Math.floor(Date.now() / MIN) * MIN + 5 * MIN)) });
      assert.equal((await hitJ(tok)).status, 302);
    });

    await check('/j/: never for the partner device, a call, an unpaid or disputed booking, an ineligible doctor, a Meet link not active or not Google; an instant one from acceptance to +60 min or its last extension', async () => {
      const now = () => new Date(Math.floor(Date.now() / MIN) * MIN + 2 * MIN);
      const cases: [string, Record<string, unknown>, Record<string, unknown>][] = [
        ['partner device', {}, { join: { on: 'partner_device', linkVersion: 1 } }],
        ['call', { consultationMode: 'call' }, {}],
        ['unpaid', { paymentStatus: 'pending' }, {}],
        ['disputed', {}, { identity: { disputed: { state: 'open', at: new Date() } } }],
        ['ineligible doctor', { specialistId: DU }, {}],
        ['meet not active', { virtualMeeting: { provider: 'google_meet', status: 'failed', joinUrl: MEET } }, {}],
        ['not google', { virtualMeeting: { provider: 'google_meet', status: 'active', joinUrl: 'https://evil.example/meet' } }, {}],
      ];
      for (const [why, extra, assisted] of cases) {
        const id = await consult(now(), extra, assisted);
        assert.equal((await hitJ(joinTokenOf(await doc(id))!)).status, 200, why);
      }
      const accepted = new Date(Date.now() - 50 * MIN);
      const inst = await consult(accepted, { bookingKind: 'instant', instantRequestId: oid(), createdAt: accepted });
      const it = joinTokenOf(await doc(inst))!;
      assert.equal((await hitJ(it)).status, 302, 'within 60 minutes of acceptance');
      await BookingModel.collection.updateOne({ _id: new Types.ObjectId(inst) }, { $set: { createdAt: new Date(Date.now() - 70 * MIN) } });
      assert.equal((await hitJ(it)).status, 200, 'after 60 minutes');
      await BookingModel.updateOne({ _id: inst }, { $set: { instantExtensions: [{ minutes: 20, endTime: new Date(Date.now() + 5 * MIN), at: new Date() }] } });
      assert.equal((await hitJ(it)).status, 302, 'extended');
      assert.equal(await joinUrlFor(it, new Date(Date.now() + 6 * MIN)), null, 'after the extension');
    });

    await check('/j/: the 31st request in a minute from one IP → 429 with the page and Retry-After; another IP is not affected; a failing counter store → 503', async () => {
      delete process.env.SMS_JOIN_RATE_PER_MINUTE;   // the default, 30
      try {
        const s = new Date().getUTCSeconds();
        if (s > 45) await new Promise((r) => setTimeout(r, (61 - s) * 1000));   // the whole burst inside one minute window
        const ip = '198.51.100.7';
        const answers: number[] = [];
        for (let i = 0; i < 31; i++) answers.push((await hitJ('AAAAAAAA-AAAAAAAAAAAAAAAAAAAA', { ip })).status);
        assert.deepEqual(answers.slice(0, 30), Array(30).fill(200));
        const limited = await hitJ('AAAAAAAA-AAAAAAAAAAAAAAAAAAAA', { ip });
        assert.equal(answers[30], 429); assert.equal(limited.status, 429);
        assert.ok(Number(limited.headers.get('retry-after')) >= 1); assert.ok(limited.body.includes('This Jansetu link is not open now'));
        assert.equal((await hitJ('AAAAAAAA-AAAAAAAAAAAAAAAAAAAA', { ip: '198.51.100.8' })).status, 200);
      } finally { smsOn(); }
      const db = mongoose.connection.db!;
      await db.command({ collMod: 'otp_throttles', validator: { $expr: { $eq: [1, 0] } }, validationLevel: 'strict', validationAction: 'error' });
      try {
        const r = await hitJ('AAAAAAAA-AAAAAAAAAAAAAAAAAAAA', { ip: '198.51.100.9' });
        assert.equal(r.status, 503); assert.ok(r.body.includes('This Jansetu link is not open now'));
      } finally { await db.command({ collMod: 'otp_throttles', validator: {}, validationLevel: 'off' }); }
    });

    await check('switch off: without JOIN_LINK_SECRET a valid token gets the page', async () => {
      const id = await consult(new Date(Math.floor(Date.now() / MIN) * MIN + 5 * MIN));
      const t = joinTokenOf(await doc(id))!;
      assert.equal((await hitJ(t)).status, 302);
      delete process.env.JOIN_LINK_SECRET;
      try { assert.equal((await hitJ(t)).status, 200); } finally { smsOn(); }
    });

    await check('logs: the request logger prints /j/:token (any case), the route logs its outcome only; no token, phone or text in any log line or outbox row', async () => {
      const id = await consult(new Date(Math.floor(Date.now() / MIN) * MIN + 5 * MIN));
      const t = joinTokenOf(await doc(id))!;
      const before = logged.length;
      await hitJ(t);
      await fetch(`${base}/J/${t}`, { redirect: 'manual', headers: { 'x-forwarded-for': nextIp() } });
      const lines = logged.slice(before);
      assert.ok(lines.some((l) => l.includes('GET /j/:token')), lines.join('\n'));
      assert.ok(lines.some((l) => l.includes('"outcome":"redirect"')));
      const tokens = new Set<string>();
      for (const b of await BookingModel.find({ 'assisted.shortRef': { $exists: true } }).lean()) { const x = joinTokenOf(b); if (x) tokens.add(x.slice(9)); }
      for (const l of logged) {
        for (const x of tokens) assert.ok(!l.includes(x), 'a token in a log line');
        assert.ok(!l.includes(PHONE_X) && !l.includes('Jansetu reminder'), l);
      }
      const rows = JSON.stringify(await SmsNoticeModel.find({}).lean());
      for (const x of tokens) assert.ok(!rows.includes(x));
      assert.ok(!rows.includes(PHONE_X) && !rows.includes('Rina'));
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
