/**
 * r10g (ASSISTED_BOOKING_DESIGN.md §23.8), item 1: the Meet retry of paid call / video bookings left without a link
 * (M1 of the r10f review). Each check fails on f81c8f3b (no retry existed). The real `syncBookingMeet` runs against a
 * stubbed Google (token and calendar endpoints of global fetch).
 *  1. Google fails, then recovers: one link, even with two retry runs racing; the booking was a customer booking.
 *  2. A card-paid assisted booking (no patient email) gets its link too.
 *  3. Repeated failure: back-off, and ONE alert after 3 failed attempts.
 *  4. A booking with an active link, or one confirmed under 15 minutes ago, is never touched.
 *  5. Stuck money lists upcoming paid call / video bookings with no working link.
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

/** Google stand-in on global fetch: the token endpoint and calendar event create / update. */
const google = { up: true, creates: 0, patches: 0, slow: 0 };
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input?.url ?? input);
  if (url.startsWith('https://oauth2.googleapis.com/token')) {
    return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
  }
  if (url.startsWith('https://www.googleapis.com/calendar/v3/')) {
    if (google.slow) await new Promise((r) => setTimeout(r, google.slow));
    if (!google.up) return new Response(JSON.stringify({ error: 'backendError' }), { status: 503 });
    const body = JSON.parse(String(init?.body ?? '{}'));
    if (init?.method === 'PATCH') google.patches += 1; else google.creates += 1;
    const id = 'evt_' + oid();
    return new Response(JSON.stringify({ id, hangoutLink: `https://meet.google.com/abc-${id.slice(-4)}-xyz`, start: body.start, end: body.end,
      conferenceData: { conferenceId: 'abc-defg-hij' } }), { status: 200 });
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
  } finally {
    globalThis.fetch = realFetch;
    await mongoose.disconnect();
  }
  console.log(`\n${passed} passed, ${failed.length} failed`);
  if (failed.length) { console.log('Failed:', failed.join('; ')); process.exit(1); }
}

main().catch((e) => { console.error(e); process.exit(1); });
