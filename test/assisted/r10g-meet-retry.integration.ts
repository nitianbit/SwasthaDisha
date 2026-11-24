/**
 * r10g (ASSISTED_BOOKING_DESIGN.md §23.8), item 1: the Meet retry of paid call / video bookings left without a link
 * (M1 of the r10f review). Each check fails on f81c8f3b (no retry existed). The real `syncBookingMeet` runs against a
 * stubbed Google (token and calendar endpoints of global fetch).
 *  1. Google fails, then recovers: one link, even with two retry runs racing; the booking was a customer booking.
 *  2. A card-paid assisted booking (no patient email) gets its link too.
 *  3. Repeated failure: back-off, and ONE alert after 3 failed attempts.
 *  4. A booking with an active link, or one confirmed under 15 minutes ago, is never touched.
 *  5. Stuck money lists upcoming paid call / video bookings with no working link.
 * r10h (review of r10g; each fails on 4d2b53a9):
 *  6. an event created without a link, or whose create answer was lost, is reused: exactly ONE event over all retries;
 *  7. S5: no Google call for a booking whose doctor is not verified and active;
 *  8. 120 ended rows do not starve an upcoming booking (retry and stuck money);
 *  9. failures no retry can fix stop after one attempt, with at most one alert (none for a customer without email);
 * 10. a failed attempt never changes the booking's updatedAt; 11. attempts go back to 0 on success.
 * r10i (each fails on a18adba7):
 * 12. Meet not configured closes nothing: no attempt, one alert a day; the bookings are linked once it is back;
 * 13. a reused event still at an older time (a reschedule whose update failed) is moved to the current appointment;
 * 14. a permanent close is cleared by a move to another slot and by a success;
 * 15. a stored bookingTime that is not a string fails neither the retry nor stuck money.
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/assisted_r10g_meet_retry_check?directConnection=true' JWT_SECRET_KEY=local-integration-only \
 *     npx tsx --tsconfig tsconfig.json test/assisted/r10g-meet-retry.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import { CONFIG } from '@/config/config';
import UserModel from '@/modules/user/model';
import BookingModel from '@/modules/bookings/model';
import SlotModel from '@/modules/slots/model';
import SpecialistModel from '@/modules/specialists/model';
import PharmacyModel from '@/modules/pharmacies/model';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/assisted_r10g_meet_retry_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const oid = () => new Types.ObjectId().toHexString();
const MIN = 60_000;
const IST = 330 * MIN;
const istParts = (at: Date) => { const s = new Date(at.getTime() + IST).toISOString(); return { date: s.slice(0, 10).replace(/-/g, ''), time: s.slice(11, 16) }; };

let passed = 0;
const failed: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log('ok -', name); } catch (e) { failed.push(name); console.error('FAIL -', name, '\n  ', (e as Error).message.split('\n').slice(0, 3).join(' | ')); }
}

/**
 * Google stand-in on global fetch: the token endpoint, and calendar events — create (POST), update (PATCH), read (GET by
 * id) and list by the booking's private property. `withoutLink`: events have no Meet link yet (GET shows it once off);
 * `loseAnswer`: a create lands at Google but its answer is lost (503).
 */
const google = { up: true, creates: 0, patches: 0, reads: 0, lists: 0, slow: 0, withoutLink: false, loseAnswer: false,
  events: new Map<string, { id: string; bookingId?: string; start?: unknown; end?: unknown }>() };
const calls = () => google.creates + google.patches + google.reads + google.lists;
/** Events Google holds for one booking (the retry runs over every due booking, so totals mix bookings). */
const eventsOf = (bookingId: string) => [...google.events.values()].filter((e) => e.bookingId === bookingId).length;
const realFetch = globalThis.fetch;
/** Google answers date-times with their offset (ours are sent as India wall-clock). */
const withOffset = (t: any) => (t?.dateTime && !/[+-]\d{2}:\d{2}$|Z$/.test(t.dateTime) ? { ...t, dateTime: `${t.dateTime}+05:30` } : t);
const shown = (e: { id: string; start?: unknown; end?: unknown }) => ({ id: e.id, status: 'confirmed', start: withOffset(e.start), end: withOffset(e.end),
  ...(google.withoutLink ? {} : { hangoutLink: `https://meet.google.com/abc-${e.id.slice(-4)}-xyz`, conferenceData: { conferenceId: 'abc-defg-hij' } }) });
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input?.url ?? input);
  if (url.startsWith('https://oauth2.googleapis.com/token')) {
    return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
  }
  if (url.startsWith('https://www.googleapis.com/calendar/v3/')) {
    if (google.slow) await new Promise((r) => setTimeout(r, google.slow));
    if (!google.up) return new Response(JSON.stringify({ error: 'backendError' }), { status: 503 });
    const method = String(init?.method ?? 'GET').toUpperCase();
    const u = new URL(url);
    const id = decodeURIComponent(u.pathname.split('/events/')[1] ?? '');
    if (method === 'GET' && !id) {
      google.lists += 1;
      const wanted = String(u.searchParams.get('privateExtendedProperty') ?? '').replace('jansetuBookingId=', '');
      return new Response(JSON.stringify({ items: [...google.events.values()].filter((e) => e.bookingId === wanted).map(shown) }), { status: 200 });
    }
    if (method === 'GET') {
      google.reads += 1;
      const e = google.events.get(id);
      return e ? new Response(JSON.stringify(shown(e)), { status: 200 }) : new Response('{"error":"notFound"}', { status: 404 });
    }
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (method === 'PATCH') {
      google.patches += 1;
      const e = google.events.get(id) ?? { id };
      if (body.start) Object.assign(e, { start: body.start, end: body.end });
      return new Response(JSON.stringify(shown(e)), { status: 200 });
    }
    google.creates += 1;
    const e = { id: 'evt' + oid(), bookingId: body.extendedProperties?.private?.jansetuBookingId, start: body.start, end: body.end };
    google.events.set(e.id, e);
    if (google.loseAnswer) return new Response('{"error":"backendError"}', { status: 503 });
    return new Response(JSON.stringify(shown(e)), { status: 200 });
  }
  return realFetch(input, init);
}) as typeof fetch;

async function main() {
  await mongoose.connect(FIXTURE_URL);
  await mongoose.connection.dropDatabase();
  Object.assign(CONFIG as Record<string, unknown>, { GOOGLE_OAUTH_CLIENT_ID: 'cid', GOOGLE_OAUTH_CLIENT_SECRET: 'csecret', GOOGLE_OAUTH_REFRESH_TOKEN: 'rt',
    GOOGLE_CALENDAR_ID: 'cal@test' });
  const retryModule = await import('@/modules/meet/retry').catch(() => null) as any;
  const retry = async (at: Date) => { if (!retryModule) throw new Error('no Meet retry'); return retryModule.retryMissingMeets(at); };
  const { AssistedAlertModel } = await import('@/modules/assisted/model');
  for (const name of mongoose.modelNames()) { const m = mongoose.model(name); await m.createCollection().catch(() => undefined); await m.syncIndexes(); }

  try {
    const X = oid(); const D = oid(); const P = oid();
    await UserModel.collection.insertOne({ _id: new Types.ObjectId(X), userType: 'user', phone: '9600009001', name: 'Rina Das', email: 'rina@test.in' } as never);
    await SpecialistModel.collection.insertOne({ _id: new Types.ObjectId(D), name: 'Dr Asha Menon', email: 'asha@doc.test', isActive: true, isVerified: true } as never);
    await PharmacyModel.collection.insertOne({ _id: new Types.ObjectId(P), name: 'Rten Medicals', email: 'rten@pharm.test', isActive: true, isVerified: true } as never);
    let k = 0;
    /** A paid, confirmed video booking starting in 2 h (+k quarter hours), confirmed `ago` ms ago, with the given Meet state. */
    const booking = async (vm: Record<string, unknown> | null, extra: Record<string, unknown> = {}, ago = 60 * MIN) => {
      const at = new Date(Date.now() + 2 * 60 * MIN + (++k) * 15 * MIN);
      const s = istParts(at); const e = istParts(new Date(at.getTime() + 15 * MIN));
      const slot = await SlotModel.create({ specialistId: D, date: s.date, startTime: s.time, endTime: e.time, duration: 15, maxBookings: 1, currentBookings: 1,
        isActive: true, isAvailable: false, slotType: 'consultation' } as never);
      const _id = new Types.ObjectId();
      const confirmedAt = new Date(Date.now() - ago).toISOString();
      await BookingModel.collection.insertOne({ _id, bookingType: 'consultation', userId: X, specialistId: D, slotId: String(slot._id), bookingDate: s.date,
        bookingTime: s.time, consultationMode: 'video', status: 'confirmed', paymentStatus: 'paid', price: 500, createdAt: new Date(Date.now() - ago),
        updatedAt: new Date(Date.now() - ago), lifecycle: { confirmed: { at: confirmedAt } }, ...(vm ? { virtualMeeting: vm } : {}), ...extra } as never);
      return String(_id);
    };
    const failedVm = { provider: 'google_meet', status: 'failed', error: 'Google Calendar request failed: backendError', createdAt: new Date(), updatedAt: new Date() };
    const read = async (id: string) => BookingModel.findById(id).lean() as Promise<any>;

    await check('1: Google fails, then recovers: the retry makes exactly ONE link, even with two retry runs racing', async () => {
      const id = await booking(failedVm);
      google.up = false;
      const r1 = await retry(new Date());
      assert.ok(r1.failed >= 1);
      let b = await read(id);
      assert.equal(b.virtualMeeting.status, 'failed');
      assert.equal(b.meetRetry.attempts, 1);
      assert.ok(new Date(b.meetRetry.nextAt).getTime() > Date.now(), 'backs off');
      assert.equal(b.meetRetry.leaseUntil, undefined, 'lease released');
      google.up = true; google.slow = 150;
      const creates0 = google.creates;
      const later = new Date(Date.now() + 6 * MIN);
      await Promise.all([retry(later), retry(later)]);
      google.slow = 0;
      b = await read(id);
      assert.equal(b.virtualMeeting.status, 'active');
      assert.match(b.virtualMeeting.joinUrl, /^https:\/\/meet\.google\.com\//);
      assert.equal(google.creates - creates0, 1, 'one event created');
      assert.ok(b.meetRetry.doneAt);
      // Further runs leave it alone.
      await retry(new Date(Date.now() + 60 * MIN));
      assert.equal(google.creates - creates0, 1);
    });

    await check('2: a card-paid assisted booking (no patient email) gets its link the same way', async () => {
      const id = await booking(null, { pharmacyId: P, userId: oid(), assisted: { bookedBy: { kind: 'pharmacy', id: P, name: 'Rten Medicals', actorKind: 'pharmacy', actorId: P },
        join: { on: 'partner_device', linkVersion: 1 }, shortRef: 'ABCD2345', funding: { method: 'razorpay', state: 'captured', payerId: P } } });
      const creates0 = google.creates;
      await retry(new Date());
      const b = await read(id);
      assert.equal(b.virtualMeeting?.status, 'active', JSON.stringify(b.virtualMeeting));
      assert.equal(google.creates - creates0, 1);
    });

    await check('3: repeated failure backs off and raises ONE alert after 3 failed attempts', async () => {
      const id = await booking(failedVm);
      google.up = false;
      let at = Date.now();
      for (let i = 0; i < 5; i++) {
        await retry(new Date(at));
        const b = await read(id);
        at = Math.max(at, new Date(b.meetRetry.nextAt).getTime()) + 1000;
      }
      google.up = true;
      const b = await read(id);
      assert.equal(b.meetRetry.attempts, 5);
      assert.ok(b.meetRetry.alertedAt);
      assert.equal(await AssistedAlertModel.countDocuments({ kind: 'meet_link_missing', 'detail.bookingId': id }), 1, 'one alert');
    });

    await check('4: a booking with an active link (or confirmed under 15 minutes ago) is never touched', async () => {
      const active = { provider: 'google_meet', status: 'active', joinUrl: 'https://meet.google.com/aaa-bbbb-ccc', calendarEventId: 'evt_keep',
        createdAt: new Date(), updatedAt: new Date() };
      const a = await booking(active);
      const fresh = await booking(null, {}, 2 * MIN);
      const before = await read(a);
      const calls0 = google.creates + google.patches;
      await retry(new Date());
      await retry(new Date(Date.now() + 3 * MIN));
      const after = await read(a);
      assert.deepEqual(after.virtualMeeting, before.virtualMeeting);
      assert.equal(after.meetRetry, undefined);
      assert.equal(new Date(after.updatedAt).getTime(), new Date(before.updatedAt).getTime());
      assert.equal((await read(fresh)).meetRetry, undefined, 'the payment follow-up still has it');
      assert.equal(google.creates + google.patches, calls0, 'no Google call');
    });

    await check('5: stuck money lists upcoming paid call / video bookings with no working link', async () => {
      const id = await booking(failedVm);
      const { stuckMoney } = await import('@/modules/assisted/reconciliation');
      const stuck = await stuckMoney(new Date()) as any;
      const row = (stuck.upcomingMeetsMissing ?? []).find((r: any) => r.bookingId === id);
      assert.ok(row, 'listed');
      assert.deepEqual([row.meetStatus, row.assisted], ['failed', false]);
    });
    // ───────────────────────── r10h ─────────────────────────
    await check('6 (r10h): an event created without a link (and one whose create answer was lost) is reused: exactly ONE event over all retries', async () => {
      // (a) Created without a link; the link comes later.
      const a = await booking(null);
      const patches0 = google.patches;
      google.withoutLink = true;
      let at = Date.now();
      const step = async () => { await retry(new Date(at)); const b = await read(a); at = Math.max(at, new Date(b.meetRetry?.nextAt ?? at).getTime()) + 1000; return b; };
      let b = await step();
      assert.equal(b.virtualMeeting.status, 'failed');
      assert.ok(b.virtualMeeting.calendarEventId, 'the event made is kept');
      for (let i = 0; i < 4; i++) b = await step();
      google.withoutLink = false;
      b = await step();
      assert.equal(b.virtualMeeting.status, 'active');
      assert.equal(eventsOf(a), 1, 'one event');
      assert.equal(google.patches - patches0, 0, 'never updated (no new emails)');
      // (b) The create landed at Google but its answer was lost: the next retry finds the booking's own event.
      const c = await booking(null);
      google.loseAnswer = true;
      await retry(new Date());
      google.loseAnswer = false;
      assert.equal((await read(c)).virtualMeeting.status, 'failed');
      await retry(new Date(Date.now() + 6 * 60_000));
      assert.equal((await read(c)).virtualMeeting.status, 'active');
      assert.equal(eventsOf(c), 1, 'found, not created again');
    });

    await check('7 (r10h): S5 — a booking whose doctor is not verified and active gets no Google call at all', async () => {
      const id = await booking(failedVm);
      await SpecialistModel.updateOne({ _id: D }, { $set: { isVerified: false } });
      try {
        const calls0 = calls();
        await retry(new Date());
        assert.equal(calls() - calls0, 0);
        assert.equal((await read(id)).meetRetry, undefined, 'not even claimed');
      } finally { await SpecialistModel.updateOne({ _id: D }, { $set: { isVerified: true } }); }
      await retry(new Date());
      assert.equal((await read(id)).virtualMeeting.status, 'active', 'retried once the doctor is eligible again');
    });

    await check('8 (r10h): 120 ended rows do not starve an upcoming booking (the retry and stuck money)', async () => {
      const today = istParts(new Date()).date;
      const rows = Array.from({ length: 120 }, () => ({ _id: new Types.ObjectId(), bookingType: 'consultation', bookingKind: 'instant', userId: X, specialistId: D,
        bookingDate: today, bookingTime: '00:00', consultationMode: 'video', status: 'confirmed', paymentStatus: 'paid', price: 500,
        createdAt: new Date(Date.now() - 3 * 60 * MIN), updatedAt: new Date(), virtualMeeting: failedVm }));
      await BookingModel.collection.insertMany(rows as never);
      const up = await booking(failedVm);
      const { upcomingMeetsMissing } = await import('@/modules/meet/retry');
      assert.ok((await upcomingMeetsMissing(new Date(), 1)).some((r: any) => r.bookingId === up), 'stuck money finds it');
      await retry(new Date());
      assert.equal((await read(up)).virtualMeeting.status, 'active', 'attempted on the first run');
      assert.equal(await BookingModel.countDocuments({ _id: { $in: rows.map((r) => r._id) }, 'meetRetry.endedFor': `${today} 00:00` }), 120, 'ended rows leave the set');
      // A booking moved to another (upcoming) slot comes back.
      const moved = String(rows[0]!._id); const at = new Date(Date.now() + 3 * 60 * MIN); const p2 = istParts(at);
      await BookingModel.collection.updateOne({ _id: rows[0]!._id }, { $set: { bookingKind: 'scheduled', bookingDate: p2.date, bookingTime: p2.time } });
      assert.ok((await upcomingMeetsMissing(new Date(), 50)).some((r: any) => r.bookingId === moved), 'back in the set after a move');
    });

    await check('9 (r10h): failures no retry can fix stop after one attempt; one alert at most (none for a customer without email)', async () => {
      const NOEMAIL = oid();
      await UserModel.collection.insertOne({ _id: new Types.ObjectId(NOEMAIL), userType: 'user', phone: '9600009002', name: 'Phone Only' } as never);
      const customer = await booking(null, { userId: NOEMAIL });
      const D2 = oid();
      await SpecialistModel.collection.insertOne({ _id: new Types.ObjectId(D2), name: 'Dr No Mail', isActive: true, isVerified: true } as never);
      const assisted = await booking(null, { specialistId: D2, pharmacyId: P, assisted: { bookedBy: { kind: 'pharmacy', id: P, name: 'Rten Medicals', actorKind: 'pharmacy', actorId: P },
        join: { on: 'partner_device', linkVersion: 1 }, shortRef: 'ABCD2346', funding: { method: 'wallet', state: 'captured', payerId: P } } });
      const calls0 = calls();
      for (let i = 0; i < 3; i++) await retry(new Date(Date.now() + i * 3 * 60 * MIN));
      const c = await read(customer); const a = await read(assisted);
      assert.deepEqual([c.meetRetry.closed, c.meetRetry.closedReason, c.meetRetry.attempts], ['permanent', 'patient_email_missing', 1]);
      assert.deepEqual([a.meetRetry.closed, a.meetRetry.closedReason, a.meetRetry.attempts], ['permanent', 'doctor_email_missing', 1]);
      assert.equal(calls() - calls0, 0, 'no Google call for either');
      assert.equal(await AssistedAlertModel.countDocuments({ kind: 'meet_link_missing', 'detail.bookingId': customer }), 0, 'phone-only customer: no alert');
      assert.equal(await AssistedAlertModel.countDocuments({ kind: 'meet_link_missing', 'detail.bookingId': assisted }), 1, 'one alert');
      // Meet not configured: one alert a day for every booking.
      const cal = (CONFIG as any).GOOGLE_CALENDAR_ID;
      (CONFIG as any).GOOGLE_CALENDAR_ID = '';
      try {
        await booking(null); await booking(null);
        await retry(new Date());
      } finally { (CONFIG as any).GOOGLE_CALENDAR_ID = cal; }
      assert.equal(await AssistedAlertModel.countDocuments({ kind: 'meet_link_missing', 'detail.permanent': 'meet_not_configured' }), 1);
    });

    await check('10–11 (r10h): a failed attempt never changes updatedAt; attempts go back to 0 on success', async () => {
      const id = await booking(failedVm);
      const before = (await read(id)).updatedAt;
      google.up = false;
      await retry(new Date());
      await retry(new Date(Date.now() + 6 * 60_000));
      google.up = true;
      const failedOnce = await read(id);
      assert.equal(failedOnce.meetRetry.attempts, 2);
      assert.equal(new Date(failedOnce.updatedAt).getTime(), new Date(before).getTime(), 'updatedAt unchanged');
      await retry(new Date(Date.now() + 30 * 60_000));
      const ok = await read(id);
      assert.equal(ok.virtualMeeting.status, 'active');
      assert.equal(ok.meetRetry.attempts, 0);
    });
    // ───────────────────────── r10i ─────────────────────────
    const { upcomingMeetsMissing } = await import('@/modules/meet/retry');
    await check('12 (r10i): Meet not configured closes nothing — no attempt, one alert a day; once configured again the bookings are linked', async () => {
      const id = await booking(null);
      const cal = (CONFIG as any).GOOGLE_CALENDAR_ID;
      (CONFIG as any).GOOGLE_CALENDAR_ID = '';
      const calls0 = calls();
      try {
        await retry(new Date()); await retry(new Date(Date.now() + 30 * MIN));
      } finally { (CONFIG as any).GOOGLE_CALENDAR_ID = cal; }
      assert.equal(calls() - calls0, 0);
      const b = await read(id);
      assert.equal(b.meetRetry, undefined, 'not attempted, not closed');
      assert.equal(await AssistedAlertModel.countDocuments({ kind: 'meet_link_missing', 'detail.permanent': 'meet_not_configured' }), 1, 'one alert a day');
      await retry(new Date());
      assert.equal((await read(id)).virtualMeeting?.status, 'active');
    });

    await check('13 (r10i): a reused event still at an older time is moved to the booking\'s current appointment (one update), then the link is active', async () => {
      const id = await booking(null);
      const b0 = await read(id);
      const evId = 'evt' + oid();
      google.events.set(evId, { id: evId, bookingId: id, start: { dateTime: '2030-01-01T09:00:00', timeZone: 'Asia/Kolkata' }, end: { dateTime: '2030-01-01T09:15:00' } });
      await BookingModel.collection.updateOne({ _id: new Types.ObjectId(id) }, { $set: { virtualMeeting: { ...failedVm, calendarEventId: evId } } });
      const patches0 = google.patches;
      await retry(new Date());
      const b = await read(id);
      assert.equal(b.virtualMeeting.status, 'active');
      assert.equal(google.patches - patches0, 1, 'moved once');
      const want = `${b0.bookingDate.slice(0, 4)}-${b0.bookingDate.slice(4, 6)}-${b0.bookingDate.slice(6, 8)}T${b0.bookingTime}`;
      assert.ok(String((google.events.get(evId) as any).start.dateTime).startsWith(want), JSON.stringify((google.events.get(evId) as any).start));
      // An event already at the right time is never updated.
      const again = await booking(null);
      const p1 = google.patches;
      await retry(new Date());
      assert.equal((await read(again)).virtualMeeting.status, 'active');
      assert.equal(google.patches, p1);
    });

    await check('14 (r10i): a permanent close is cleared by a move to another slot and by a success', async () => {
      const D3 = oid();
      await SpecialistModel.collection.insertOne({ _id: new Types.ObjectId(D3), name: 'Dr Late Mail', isActive: true, isVerified: true } as never);
      const id = await booking(null, { specialistId: D3 });
      await retry(new Date());
      assert.equal((await read(id)).meetRetry.closed, 'permanent');
      // The doctor adds an email; the same appointment stays closed …
      await SpecialistModel.updateOne({ _id: D3 }, { $set: { email: 'late@doc.test' } });
      await retry(new Date(Date.now() + 3 * 60 * MIN));
      assert.equal((await read(id)).meetRetry.closed, 'permanent');
      // … until the booking moves to another slot; then it is linked and the close is cleared.
      const at = istParts(new Date(Date.now() + 20 * 60 * MIN));
      await BookingModel.collection.updateOne({ _id: new Types.ObjectId(id) }, { $set: { bookingDate: at.date, bookingTime: at.time } });
      await SlotModel.updateOne({ _id: (await read(id)).slotId }, { $set: { date: at.date, startTime: at.time, endTime: istParts(new Date(Date.now() + 20 * 60 * MIN + 15 * MIN)).time } });
      await retry(new Date());
      const b = await read(id);
      assert.equal(b.virtualMeeting.status, 'active');
      assert.equal(b.meetRetry.closed, undefined); assert.equal(b.meetRetry.closedReason, undefined); assert.equal(b.meetRetry.closedFor, undefined);
    });

    await check('15 (r10i): a stored bookingTime that is not a string fails neither the retry nor stuck money', async () => {
      const today = istParts(new Date()).date;
      await BookingModel.collection.insertOne({ _id: new Types.ObjectId(), bookingType: 'consultation', userId: X, specialistId: D, bookingDate: today, bookingTime: 1030,
        consultationMode: 'video', status: 'confirmed', paymentStatus: 'paid', price: 500, createdAt: new Date(Date.now() - 60 * MIN), updatedAt: new Date(),
        virtualMeeting: failedVm } as never);
      const up = await booking(failedVm);
      await retry(new Date());
      assert.equal((await read(up)).virtualMeeting.status, 'active', 'the run went on');
      await upcomingMeetsMissing(new Date());
    });
  } finally {
    globalThis.fetch = realFetch;
    await mongoose.disconnect();
  }
  console.log(`\n${passed} passed, ${failed.length} failed`);
  if (failed.length) { console.log('Failed:', failed.join('; ')); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
