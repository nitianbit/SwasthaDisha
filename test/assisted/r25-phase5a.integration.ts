/**
 * Phase 5a (ASSISTED_BOOKING_DESIGN.md §27.5): the SMS outbox, its drain loop, the provider-neutral sender around the
 * existing gateway, the switches and the admin test send. A local HTTP server stands in for the gateway (it records
 * every request). 5a has no event hooks yet (5b): the checks enqueue directly and register a test composer.
 *  1. Sign-in code SMS unchanged: the same text, and byte for byte the same gateway request as the code before 5a
 *     (template fallback included); unconfigured still throws.
 *  2. The notice sender: the request shape, the notices header, no template fallback, the Unicode flag only for
 *     non-Latin text, every gateway answer classified, never a throw.
 *  3. Double enqueue: 10 at once → one row; again after it was sent → still one.
 *  4. Two drains at once over 20 rows → 20 gateway calls, each row sent once.
 *  5. A row held by a live lease is left alone; once the lease is past it is taken over and sent once.
 *  6. Retry and give-up: 5xx → back after 2 then 10 minutes; the third failure is final with ONE alert for the day; a
 *     4xx is final at once; success after two failures is sent.
 *  7. Gateway down or hanging: every call is cut at SMS_SEND_TIMEOUT_MS; a tick stops after 3 failures in a row and the
 *     rows it did not claim keep 0 attempts.
 *  8. Switches: master off → nothing queued, due rows skipped without a call; pair off → English fallback, then
 *     no_template; no template id → no call; non-Latin text needs SMS_UNICODE_PARAM; recipient checks.
 *  9. A missing index (or any outbox error) never affects a booking: the enqueue after a committed booking returns
 *     normally and writes nothing; the drain does not run.
 * 10. Admin summary and test send (503 / 409 / 429, admins only, recorded without the phone).
 * 11. No phone number, text or template id in any log line or outbox row.
 *
 * Run (throwaway DB only; the script drops its database):
 *   JWT_SECRET_KEY=local-integration-only MONGODB_URL='mongodb://127.0.0.1:27917/r25_phase5a_check?directConnection=true' \
 *     npx tsx test/assisted/r25-phase5a.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import axios from 'axios';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import { CONFIG } from '@/config/config';
import logger from '@/services/logger';
import { errorHandler } from '@/modules/middleware';
import { authenticate, denyRoles } from '@/modules/middleware/auth';
import UserModel from '@/modules/user/model';
import BookingModel from '@/modules/bookings/model';
import { AssistedAlertModel } from '@/modules/assisted/model';
import { SMSService } from '@/modules/sms/services';
import { runLedgerTransaction } from '@/modules/common/utils/bookingWalletFunding';
import { resetIndexChecks } from '@/modules/common/utils/requiredIndex';
import { SmsNoticeModel } from '@/modules/smsNotices/model';
import { enqueueSms, setSmsComposer, type SmsComposition } from '@/modules/smsNotices/outbox';
import { drainSmsOnce } from '@/modules/smsNotices/drain';
import { gatewayProvider, setSmsProvider } from '@/modules/smsNotices/provider';
import { smsAdminRouter } from '@/modules/smsNotices/admin';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/r25_phase5a_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const oid = () => new Types.ObjectId().toHexString();
const MIN = 60_000;
let passed = 0;
const failed: string[] = [];
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log('ok -', name); } catch (e) { failed.push(name); console.log('FAIL -', name); console.error(e); }
}

// ── Every log line of the run, to prove no personal data reaches the logs ──
const logged: string[] = [];
for (const level of ['info', 'warn', 'error'] as const) {
  const real = (logger as any)[level].bind(logger);
  (logger as any)[level] = (...a: unknown[]) => { logged.push(JSON.stringify(a)); return real(...a); };
}
for (const level of ['log', 'warn', 'error'] as const) {
  const real = console[level].bind(console);
  console[level] = (...a: unknown[]) => { logged.push(a.map(String).join(' ')); real(...a); };
}

// ── The gateway stand-in: records each request; answers by `gw.script` (then `gw.mode`) ──
type Mode = 'ok' | 'hang' | number;
const gw = { mode: 'ok' as Mode, script: [] as Mode[], requests: [] as { url: string; cookie?: string }[] };
const gateway = http.createServer((req, res) => {
  gw.requests.push({ url: String(req.url), cookie: req.headers.cookie });
  const m = gw.script.length ? gw.script.shift()! : gw.mode;
  if (m === 'hang') return; // never answers
  res.writeHead(m === 'ok' ? 200 : m, { 'content-type': 'text/plain' });
  res.end(m === 'ok' ? 'OK 12345' : 'ERR');
});
const query = (i: number) => Object.fromEntries(new URL('http://x' + gw.requests[i]!.url).searchParams);

const PHONE = '9876500001';
const TEXT_START = 'Jansetu:';
const T_BOOKED = 'T-BOOKED-EN';
const env = (vars: Record<string, string | undefined>) => {
  for (const [k, v] of Object.entries(vars)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
};
const SMS_ON = { SMS_NOTICES_ENABLED: 'true', SMS_BOOKED_EN_ENABLED: 'true', SMS_BOOKED_EN_TEMPLATE: T_BOOKED, SMS_SEND_TIMEOUT_MS: '300' };

async function main() {
  await mongoose.connect(FIXTURE_URL);
  await mongoose.connection.dropDatabase();
  for (const name of mongoose.modelNames()) { const m = mongoose.model(name); await m.createCollection().catch(() => undefined); await m.syncIndexes(); }
  await new Promise<void>((r) => gateway.listen(0, '127.0.0.1', () => r()));
  const GW = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}/send`;
  Object.assign(CONFIG as Record<string, unknown>, { SMS_API_BASE_URL: GW, SMS_USERNAME: 'gw-user', SMS_PASSWORD: 'gw-secret-pw', SMS_FROM: 'EWACRE',
    SMS_TEMPLATE_ID: 'T-OTP', SMS_PE_ID: 'PE-1', SMS_COOKIE: 'sid=1' });

  const app = express();
  app.use(express.json());
  app.use('/api/v1/admin/sms-notices', authenticate, denyRoles('partner'), smsAdminRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ADMIN = oid();
  const sign = (claims: object) => jwt.sign(claims, CONFIG.JWT_SECRET_KEY, { expiresIn: '1h' });
  const tokens: Record<string, string> = { ADMIN: sign({ _id: ADMIN, userType: 'admin' }), P: sign({ _id: oid(), pharmacyId: oid(), userType: 'pharmacy' }) };
  const call = async (who: string, method: string, url: string, body?: unknown) => {
    const r = await fetch(base + url, { method, headers: { authorization: `Bearer ${tokens[who]}`, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: r.status, body: await r.json() as any };
  };

  // The holder and a test composer (5b registers the real ones): the booking id picks the composition.
  const U = oid(); const NOPHONE = oid(); const INACTIVE = oid();
  await UserModel.collection.insertMany([
    { _id: new Types.ObjectId(U), userType: 'user', phone: PHONE, name: 'Rina Das' },
    { _id: new Types.ObjectId(NOPHONE), userType: 'user', name: 'No Phone' },
    { _id: new Types.ObjectId(INACTIVE), userType: 'user', phone: '9876500002', name: 'Gone', isActive: false },
  ] as never);
  const plan = new Map<string, Partial<SmsComposition> | { skip: string }>();
  setSmsComposer('booked', async (row) => {
    const p = plan.get(row.bookingId) ?? {};
    if ('skip' in p) return p as { skip: string };
    return { userId: U, lang: 'en', messages: ['BOOKED'], values: { name: 'Rina', service: 'video consultation', date: '01-12-2026', time: '10:30',
      place: 'Rten Medicals', ref: 'ABCD2345' }, ...p } as SmsComposition;
  });
  const rows = () => SmsNoticeModel.find({ bookingKind: { $ne: 'admin_test' } }).lean() as Promise<any[]>;
  const rowOf = async (bookingId: string) => SmsNoticeModel.findOne({ bookingId }).lean() as Promise<any>;
  const reset = async () => { await SmsNoticeModel.deleteMany({}); await AssistedAlertModel.deleteMany({}); gw.requests = []; gw.script = []; gw.mode = 'ok';
    setSmsProvider(); env(SMS_ON); };
  const queue = async (n = 1) => {
    const ids: string[] = [];
    for (let i = 0; i < n; i++) { const id = oid(); ids.push(id); await enqueueSms({ bookingKind: 'booking', bookingId: id, event: 'booked', version: '1' }); }
    return ids;
  };

  try {
    await check('1. sign-in code SMS unchanged: same text; byte for byte the same request as before 5a (fallbacks included); unconfigured throws', async () => {
      await reset();
      const sms = new SMSService();
      const otp = sms.buildSMSContent('otp', { otp: '482913', expiryMinutes: 10 });
      assert.equal(otp.text, 'Your OTP for verification on MyEwaCare, a service of EWA Healthcare Solutions, is 482913. This OTP is valid for 10 minutes. Do not share this OTP with anyone.');
      assert.equal(otp.templateId, 'T-OTP');
      // The request exactly as the code before 5a built it (sms/services/index.ts at f5f171c9, copied verbatim).
      const oldNormalize = (phone: string) => { const d = phone.replace(/\D/g, ''); if (d.length === 10) return `91${d}`; if (d.length === 12 && d.startsWith('91')) return d; return d; };
      const oldSend = (p: { to: string; text: string; templateId?: string; peId?: string }) => axios.get(CONFIG.SMS_API_BASE_URL as string, {
        params: { username: CONFIG.SMS_USERNAME, password: CONFIG.SMS_PASSWORD, from: CONFIG.SMS_FROM, to: oldNormalize(p.to), text: p.text,
          tmplId: p.templateId || CONFIG.SMS_TEMPLATE_ID, peId: p.peId || CONFIG.SMS_PE_ID },
        headers: { ...(CONFIG.SMS_COOKIE ? { Cookie: CONFIG.SMS_COOKIE } : {}) } });
      const cases = [{ to: '+91 98765 00001', text: otp.text, templateId: otp.templateId }, { to: '9876500001', text: 'no template given' },
        { to: '919876500001', text: 'Bill & more: ₹50 / 2', templateId: 'T-BILL', peId: 'PE-OTHER' }];
      for (const c of cases) {
        gw.requests = [];
        await oldSend(c);
        const r = await sms.sendSMS(c);
        assert.equal(r.success, true);
        assert.equal(gw.requests.length, 2);
        assert.deepEqual(gw.requests[1], gw.requests[0]);
      }
      assert.equal(query(1).tmplId, 'T-BILL');
      // The notices switch and header never touch sign-in codes.
      env({ SMS_NOTICES_FROM: 'JNSETU' });
      gw.requests = [];
      await sms.sendSMS({ to: PHONE, text: otp.text, templateId: otp.templateId });
      assert.equal(query(0).from, 'EWACRE');
      env({ SMS_NOTICES_FROM: undefined });
      const saved = CONFIG.SMS_API_BASE_URL;
      (CONFIG as any).SMS_API_BASE_URL = undefined;
      await assert.rejects(sms.sendSMS({ to: PHONE, text: 'x' }), (e: any) => e.code === 'SMS_PROVIDER_NOT_CONFIGURED');
      (CONFIG as any).SMS_API_BASE_URL = saved;
    });

    await check('2. notice sender: request shape, notices header, no template fallback, Unicode flag only for non-Latin, answers classified, never throws', async () => {
      await reset();
      const go = (m: Partial<{ to: string; text: string; templateId: string; unicode: boolean }> = {}) =>
        gatewayProvider.send({ to: PHONE, text: 'Jansetu: hello', templateId: T_BOOKED, unicode: false, ...m }, AbortSignal.timeout(2000));
      assert.equal(gatewayProvider.configured(), true);
      assert.deepEqual(await go(), { ok: true, status: 200 });
      assert.deepEqual(query(0), { username: 'gw-user', password: 'gw-secret-pw', from: 'EWACRE', to: '919876500001', text: 'Jansetu: hello', tmplId: T_BOOKED, peId: 'PE-1' });
      assert.equal(gw.requests[0]!.cookie, 'sid=1');
      env({ SMS_NOTICES_FROM: 'JNSETU', SMS_UNICODE_PARAM: 'coding=3' });
      await go({ text: 'जनसेतु', unicode: true });
      assert.equal(query(1).from, 'JNSETU');
      assert.equal(query(1).coding, '3');
      await go();
      assert.equal(query(2).coding, undefined);
      env({ SMS_NOTICES_FROM: undefined, SMS_UNICODE_PARAM: undefined });
      // No fallback to the sign-in template: the id given is the id sent, even an empty one.
      await go({ templateId: '' });
      assert.notEqual(query(3).tmplId, 'T-OTP');
      gw.mode = 500; assert.deepEqual(await go(), { ok: false, retryable: true, code: 'http_5xx', status: 500 });
      gw.mode = 429; assert.deepEqual(await go(), { ok: false, retryable: true, code: 'http_429', status: 429 });
      gw.mode = 400; assert.deepEqual(await go(), { ok: false, retryable: false, code: 'http_4xx', status: 400 });
      gw.mode = 'hang';
      const t0 = Date.now();
      assert.deepEqual(await gatewayProvider.send({ to: PHONE, text: 'x', templateId: T_BOOKED, unicode: false }, AbortSignal.timeout(200)),
        { ok: false, retryable: true, code: 'timeout' });
      assert.ok(Date.now() - t0 < 1500);
      const saved = CONFIG.SMS_API_BASE_URL;
      (CONFIG as any).SMS_API_BASE_URL = 'http://127.0.0.1:9/send'; // nothing listens there
      assert.deepEqual(await go(), { ok: false, retryable: true, code: 'network' });
      (CONFIG as any).SMS_API_BASE_URL = saved;
    });

    await check('3. double enqueue: 10 at once → one row; again after it was sent → still one row and one SMS', async () => {
      await reset();
      const id = oid();
      await Promise.all(Array.from({ length: 10 }, () => enqueueSms({ bookingKind: 'booking', bookingId: id, event: 'booked', version: '1' })));
      assert.equal((await rows()).length, 1);
      assert.equal((await drainSmsOnce()).sent, 1);
      await enqueueSms({ bookingKind: 'booking', bookingId: id, event: 'booked', version: '1' });
      await drainSmsOnce();
      const all = await rows();
      assert.equal(all.length, 1);
      assert.equal(all[0].state, 'sent');
      assert.equal(gw.requests.length, 1);
      // Another version is another SMS.
      await enqueueSms({ bookingKind: 'booking', bookingId: id, event: 'booked', version: 'move:1' });
      assert.equal((await rows()).length, 2);
    });

    await check('4. two drains at once over 20 rows → 20 gateway calls, each row sent once with one attempt', async () => {
      await reset();
      const ids = await queue(20);
      const [a, b] = await Promise.all([drainSmsOnce(), drainSmsOnce()]);
      assert.equal(a.sent + b.sent, 20);
      assert.equal(a.claimed + b.claimed, 20);
      assert.equal(gw.requests.length, 20);
      const all = await rows();
      assert.deepEqual(new Set(all.map((r) => r.state)), new Set(['sent']));
      assert.ok(all.every((r) => r.attempts === 1 && r.message === 'BOOKED' && r.lang === 'en' && r.sentAt && r.expireAt && !r.leaseUntil));
      assert.equal(new Set(gw.requests.map((r) => r.url)).size, 1); // same composition for every row
      assert.equal(ids.length, 20);
      assert.equal((await drainSmsOnce()).claimed, 0);
    });

    await check('5. a row held by a live lease is left alone; once its lease is past it is taken over and sent once', async () => {
      await reset();
      const [id] = await queue(1);
      await SmsNoticeModel.updateOne({ bookingId: id }, { $set: { state: 'sending', leaseUntil: new Date(Date.now() + MIN), attempts: 1 } });
      assert.equal((await drainSmsOnce()).claimed, 0);
      assert.equal(gw.requests.length, 0);
      await SmsNoticeModel.updateOne({ bookingId: id }, { $set: { leaseUntil: new Date(Date.now() - 1000) } });
      const [a, b] = await Promise.all([drainSmsOnce(), drainSmsOnce()]);
      assert.equal(a.sent + b.sent, 1);
      assert.equal(gw.requests.length, 1);
      const r = await rowOf(id!);
      assert.equal(r.state, 'sent');
      assert.equal(r.attempts, 2);
    });

    await check('6. retry and give-up: 5xx back after 2 then 10 min; third failure final with ONE alert a day; 4xx final at once; success after two failures', async () => {
      await reset();
      const [x, y] = await queue(2);
      const t = Date.now();
      gw.mode = 500;
      // Both rows are claimed in the same tick; both fail.
      await drainSmsOnce(new Date(t));
      let r = await rowOf(x!);
      assert.equal(r.state, 'queued'); assert.equal(r.attempts, 1); assert.equal(r.reason, 'http_5xx'); assert.equal(r.providerStatus, 500);
      assert.equal(new Date(r.dueAt).getTime(), t + 2 * MIN);
      assert.equal((await drainSmsOnce(new Date(t + 2 * MIN - 1000))).claimed, 0); // not before its time
      await drainSmsOnce(new Date(t + 2 * MIN));
      r = await rowOf(x!);
      assert.equal(r.attempts, 2); assert.equal(new Date(r.dueAt).getTime(), t + 12 * MIN);
      await drainSmsOnce(new Date(t + 12 * MIN));
      r = await rowOf(x!);
      assert.equal(r.state, 'failed'); assert.equal(r.attempts, 3); assert.equal(r.reason, 'http_5xx'); assert.ok(r.expireAt);
      assert.equal((await rowOf(y!)).state, 'failed');
      const alerts = await AssistedAlertModel.find({ kind: 'sms_failed' }).lean();
      assert.equal(alerts.length, 1, 'two failed rows, one alert for the day');
      assert.equal(JSON.stringify(alerts).includes(x!), false);
      assert.equal(gw.requests.length, 6);
      // A 4xx is final at once.
      const [z] = await queue(1);
      gw.mode = 400;
      await drainSmsOnce();
      assert.equal((await rowOf(z!)).state, 'failed');
      assert.equal((await rowOf(z!)).attempts, 1);
      // Success after two failures.
      const [w] = await queue(1);
      const t2 = Date.now();
      gw.mode = 'ok'; gw.script = [503, 503];
      await drainSmsOnce(new Date(t2)); await drainSmsOnce(new Date(t2 + 2 * MIN)); await drainSmsOnce(new Date(t2 + 12 * MIN));
      r = await rowOf(w!);
      assert.equal(r.state, 'sent'); assert.equal(r.attempts, 3); assert.equal(r.reason, undefined);
    });

    await check('7. gateway down or hanging: each call cut at the timeout; a tick stops after 3 failures in a row; unclaimed rows keep 0 attempts', async () => {
      await reset();
      const ids = await queue(6);
      gw.mode = 'hang';
      const t0 = Date.now();
      const out = await drainSmsOnce();
      const took = Date.now() - t0;
      assert.equal(out.stopped, true); assert.equal(out.claimed, 3); assert.equal(out.retry, 3);
      assert.ok(took < 3 * 300 + 1500, `tick took ${took} ms`);
      const all = await SmsNoticeModel.find({ bookingId: { $in: ids } }).lean() as any[];
      assert.equal(all.filter((r) => r.attempts === 1 && r.reason === 'timeout' && r.state === 'queued').length, 3);
      assert.equal(all.filter((r) => r.attempts === 0 && r.state === 'queued').length, 3);
      // A sender that never answers and ignores its signal is still cut at SMS_SEND_TIMEOUT_MS.
      await reset();
      await queue(1);
      setSmsProvider({ configured: () => true, send: () => new Promise(() => undefined) });
      const t1 = Date.now();
      const o2 = await drainSmsOnce();
      assert.equal(o2.retry, 1);
      assert.ok(Date.now() - t1 < 1500);
      setSmsProvider();
    });

    await check('8. switches: master off; pair off → English fallback, then no_template; no template id → no call; Unicode flag; recipient checks', async () => {
      await reset();
      env({ SMS_NOTICES_ENABLED: undefined });
      await queue(1);
      assert.equal((await rows()).length, 0, 'master off: nothing queued');
      env({ SMS_NOTICES_ENABLED: 'true' });
      const [due] = await queue(1);
      env({ SMS_NOTICES_ENABLED: 'false' });
      await drainSmsOnce();
      assert.equal((await rowOf(due!)).state, 'skipped'); assert.equal((await rowOf(due!)).reason, 'switched_off');
      env({ SMS_NOTICES_ENABLED: 'true' });
      // The patient's language has no sendable template: English is the fallback; with English off too, nothing is sent.
      const [hi] = await queue(1); plan.set(hi!, { lang: 'hi' });
      await drainSmsOnce();
      assert.equal((await rowOf(hi!)).state, 'sent'); assert.equal((await rowOf(hi!)).lang, 'en');
      env({ SMS_BOOKED_EN_ENABLED: 'false' });
      const [off] = await queue(1);
      await drainSmsOnce();
      assert.equal((await rowOf(off!)).reason, 'no_template');
      env({ SMS_BOOKED_EN_ENABLED: 'true', SMS_BOOKED_EN_TEMPLATE: undefined });
      const [noId] = await queue(1);
      await drainSmsOnce();
      assert.equal((await rowOf(noId!)).reason, 'no_template');
      assert.equal(gw.requests.length, 1, 'only the fallback row reached the gateway');
      env(SMS_ON);
      // Non-Latin text needs the gateway's Unicode flag.
      const [uni] = await queue(1); plan.set(uni!, { values: { name: 'रीना', service: 'video consultation', date: '01-12-2026', time: '10:30', place: 'Rten', ref: 'ABCD2345' } });
      await drainSmsOnce();
      assert.equal((await rowOf(uni!)).reason, 'unicode_not_configured');
      env({ SMS_UNICODE_PARAM: 'coding=3' });
      const [uni2] = await queue(1); plan.set(uni2!, plan.get(uni!)!);
      await drainSmsOnce();
      assert.equal((await rowOf(uni2!)).state, 'sent');
      assert.equal(query(gw.requests.length - 1).coding, '3');
      env({ SMS_UNICODE_PARAM: undefined });
      // Recipients, a stale event, no composer, the gateway not configured.
      const [np, ia, st] = await queue(3);
      plan.set(np!, { userId: NOPHONE }); plan.set(ia!, { userId: INACTIVE }); plan.set(st!, { skip: 'stale' });
      await drainSmsOnce();
      assert.equal((await rowOf(np!)).reason, 'no_phone'); assert.equal((await rowOf(ia!)).reason, 'recipient_inactive');
      assert.equal((await rowOf(st!)).reason, 'stale');
      await enqueueSms({ bookingKind: 'booking', bookingId: oid(), event: 'rx_ready', version: '1' });
      await drainSmsOnce();
      assert.equal((await SmsNoticeModel.findOne({ event: 'rx_ready' }).lean() as any).reason, 'no_composer');
      const saved = CONFIG.SMS_PE_ID; (CONFIG as any).SMS_PE_ID = undefined;
      const [npe] = await queue(1);
      await drainSmsOnce();
      assert.equal((await rowOf(npe!)).reason, 'provider_not_configured');
      (CONFIG as any).SMS_PE_ID = saved;
    });

    await check('9. a missing index or any outbox error never affects a booking: the enqueue after the commit returns and writes nothing; no drain', async () => {
      await reset();
      const book = async () => {
        const _id = new Types.ObjectId();
        await runLedgerTransaction(async (s) => { await BookingModel.collection.insertOne({ _id, bookingType: 'consultation', userId: U, status: 'confirmed' } as never, { session: s }); });
        // As the 5b hooks will do: after the commit, awaited, never inside the transaction.
        await enqueueSms({ bookingKind: 'booking', bookingId: String(_id), event: 'booked', version: '1' });
        return BookingModel.findById(_id).lean();
      };
      await SmsNoticeModel.collection.dropIndex('bookingKind_1_bookingId_1_event_1_version_1');
      resetIndexChecks();
      const b1 = await book();
      assert.equal((b1 as any).status, 'confirmed');
      assert.equal((await rows()).length, 0, 'no row without the unique index');
      await assert.rejects(drainSmsOnce(), (e: any) => e.code === 'INDEXES_OUTDATED');
      assert.equal(gw.requests.length, 0);
      await SmsNoticeModel.syncIndexes();
      resetIndexChecks();
      // A failing insert (a write the schema refuses) is swallowed too.
      await enqueueSms({ bookingKind: 'booking', bookingId: oid(), event: 'nope' as never, version: '1' });
      // The collection gone entirely.
      await SmsNoticeModel.collection.drop();
      resetIndexChecks();
      const b2 = await book();
      assert.equal((b2 as any).status, 'confirmed');
      await SmsNoticeModel.createCollection(); await SmsNoticeModel.syncIndexes(); resetIndexChecks();
      assert.equal((await rows()).length, 0);
      assert.ok(logged.some((l) => l.includes('sms enqueue skipped') && l.includes('indexes_outdated')));
    });

    await check('10. admin: summary (no secret, DLT text) and test send (503 off, 409 no id, sent with the pair switch off, recorded without the phone, 429 after 20)', async () => {
      await reset();
      assert.equal((await call('P', 'GET', '/api/v1/admin/sms-notices/summary')).status, 403);
      const s = await call('ADMIN', 'GET', '/api/v1/admin/sms-notices/summary');
      assert.equal(s.status, 200);
      assert.equal(s.body.data.enabled, true);
      assert.equal(s.body.data.provider.configured, true);
      const pair = s.body.data.pairs.find((p: any) => p.message === 'BOOKED' && p.lang === 'en');
      assert.deepEqual(pair, { message: 'BOOKED', lang: 'en', enabled: true, templateSet: true,
        dltText: "Jansetu: {#var#}'s {#var#} is booked for {#var#} at {#var#} via {#var#}. Ref {#var#}. Sign in to the Jansetu app with this number for details." });
      assert.equal(s.body.data.pairs.find((p: any) => p.message === 'BOOKED' && p.lang === 'hi').dltText, null);
      assert.equal(s.body.data.pairs.length, 8 * 5);
      for (const secret of ['gw-secret-pw', 'gw-user', T_BOOKED, 'PE-1']) assert.equal(JSON.stringify(s.body).includes(secret), false);

      env({ SMS_NOTICES_ENABLED: undefined });
      const off = await call('ADMIN', 'POST', '/api/v1/admin/sms-notices/test', { message: 'BOOKED', lang: 'en', phone: PHONE });
      assert.equal(off.status, 503);
      assert.ok(JSON.stringify(off.body).includes('SMS_NOTICES_DISABLED'));
      env(SMS_ON);
      const noId = await call('ADMIN', 'POST', '/api/v1/admin/sms-notices/test', { message: 'RX_READY', lang: 'en', phone: PHONE });
      assert.equal(noId.status, 409);
      assert.equal((await call('ADMIN', 'POST', '/api/v1/admin/sms-notices/test', { message: 'BOOKED', lang: 'en', phone: '12' })).status, 400);
      assert.equal((await call('P', 'POST', '/api/v1/admin/sms-notices/test', { message: 'BOOKED', lang: 'en', phone: PHONE })).status, 403);
      gw.requests = [];
      env({ SMS_BOOKED_EN_ENABLED: 'false' }); // checking a template before it goes live
      const ok = await call('ADMIN', 'POST', '/api/v1/admin/sms-notices/test', { message: 'BOOKED', lang: 'en', phone: PHONE });
      assert.equal(ok.status, 200); assert.deepEqual(ok.body.data, { ok: true });
      assert.equal(gw.requests.length, 1);
      assert.equal(query(0).tmplId, T_BOOKED); assert.equal(query(0).to, '91' + PHONE);
      assert.ok(query(0).text!.startsWith("Jansetu: Rina's video consultation is booked"));
      const test = await SmsNoticeModel.findOne({ bookingKind: 'admin_test' }).lean() as any;
      assert.equal(test.bookingId, ADMIN.toLowerCase()); assert.equal(test.state, 'sent'); assert.equal(test.message, 'BOOKED');
      assert.equal(JSON.stringify(test).includes(PHONE), false);
      gw.mode = 500;
      const bad = await call('ADMIN', 'POST', '/api/v1/admin/sms-notices/test', { message: 'BOOKED', lang: 'en', phone: PHONE });
      assert.deepEqual(bad.body.data, { ok: false, code: 'http_5xx' });
      gw.mode = 'ok';
      let last = 0;
      for (let i = 0; i < 19; i++) last = (await call('ADMIN', 'POST', '/api/v1/admin/sms-notices/test', { message: 'BOOKED', lang: 'en', phone: PHONE })).status;
      assert.equal(last, 429);
      assert.equal(gw.requests.length, 20);
      env(SMS_ON);
      // Test sends are not counted as notices.
      const s2 = await call('ADMIN', 'GET', '/api/v1/admin/sms-notices/summary');
      assert.equal(s2.body.data.last24h.sent, 0);
    });

    await check('11. no phone number, text or template id in any log line or outbox row', async () => {
      const all = JSON.stringify(await SmsNoticeModel.find({}).lean());
      const rowsAndLogs = [all, ...logged];
      for (const s of rowsAndLogs) {
        for (const needle of [PHONE, '9876500002', TEXT_START, "Rina's", T_BOOKED, 'gw-secret-pw']) {
          assert.equal(s.includes(needle), false, `found ${needle} in: ${s.slice(0, 160)}`);
        }
      }
    });
  } finally {
    setSmsProvider();
    server.close(); gateway.close(); gateway.closeAllConnections?.();
    await mongoose.disconnect();
  }
  console.log(`\n${passed} passed, ${failed.length} failed`);
  if (failed.length) { console.log('Failed:\n - ' + failed.join('\n - ')); process.exit(1); }
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
