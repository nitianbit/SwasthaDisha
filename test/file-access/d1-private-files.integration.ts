/**
 * D1: uploaded files need a login. Real route mounts (configureRoutes) over HTTP on a MongoDB replica set and a
 * throwaway upload directory: the one access decision on /api/static, /api/v1/file/static and /api/v1/file/fetch,
 * uploader provenance, server folders, grants, headers, and the attach-time check.
 *
 * Run (throwaway DB and directory only):
 *   UPLOAD_DIR="$(mktemp -d)/files" MONGODB_URL='mongodb://127.0.0.1:27917/d1_files_check?directConnection=true' \
 *     JWT_SECRET_KEY=local-check-only npx tsx --tsconfig tsconfig.json test/file-access/d1-private-files.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import { CONFIG } from '@/config/config';
import UserModel from '@/modules/user/model';
import BookingModel from '@/modules/bookings/model';
import PharmacyOrderModel from '@/modules/pharmacyOrders/model';
import ExternalBookingModel from '@/modules/externalBookings/model';
import { FileGrantModel, FileUploadModel } from '@/modules/file/model/access';
import { attachFiles, checkAttachable, grantFiles } from '@/modules/file/access';
import PharmacyModel from '@/modules/pharmacies/model';
import { configureRoutes } from '@/routes';
import { errorHandler } from '@/modules/middleware';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/d1_files_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);
const UPLOAD = CONFIG.UPLOAD_DIR;
if (!path.resolve(UPLOAD).startsWith(fs.realpathSync(os.tmpdir())) && !path.resolve(UPLOAD).startsWith(os.tmpdir())
  && !UPLOAD.startsWith('/var/folders/') && !UPLOAD.startsWith('/tmp/')) {
  throw new Error('Refusing to run: UPLOAD_DIR must be a temporary directory, got ' + UPLOAD);
}

const sign = (claims: object) => jwt.sign(claims, CONFIG.JWT_SECRET_KEY, { expiresIn: '1h' });
let phoneSeq = 0;
async function customer() {
  const u = await UserModel.create({ phone: '97' + String(10_000_000 + ++phoneSeq).padStart(8, '0'), userType: 'user', isActive: true });
  const _id = String(u._id);
  return { _id, token: sign({ _id, userType: 'user' }), claims: { _id, userType: 'user' } };
}
const oid = () => new Types.ObjectId().toHexString();
const staff = (userType: string, extra: object = {}) => {
  const _id = oid();
  const claims = { _id, userType, ...extra };
  return { _id, token: sign(claims), claims };
};
function put(rel: string, body = 'bytes') {
  const full = path.join(UPLOAD, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, body);
}

let passed = 0;
async function check(name: string, fn: () => Promise<void>) {
  try { await fn(); passed++; console.log('ok -', name); } catch (e) { console.error('FAIL -', name); throw e; }
}

async function main() {
  await mongoose.connect(FIXTURE_URL);
  await mongoose.connection.dropDatabase();
  for (const m of [FileUploadModel, FileGrantModel]) { await m.createCollection(); await m.syncIndexes(); }
  fs.rmSync(UPLOAD, { recursive: true, force: true });
  fs.mkdirSync(UPLOAD, { recursive: true });

  const app = express();
  app.use(express.json());
  configureRoutes(app);
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const get = (p: string, token?: string) => fetch(base + p, { headers: token ? { authorization: 'Bearer ' + token } : {} });
  async function upload(token: string, name: string, module = '') {
    const form = new FormData();
    form.append('files', new Blob([`content of ${name}`], { type: 'application/pdf' }), name);
    const r = await fetch(`${base}/api/v1/file/upload${module ? '/' + module : ''}`, { method: 'POST', body: form, headers: { authorization: 'Bearer ' + token } });
    return { status: r.status, body: await r.json() as { data?: { files: { url: string }[] }; code?: string } };
  }

  const a = await customer();
  const b = await customer();
  const admin = staff('admin');

  try {
    let urlA = '';
    await check('an upload records its uploader; anonymous gets 401, another customer 404, the uploader and admin 200', async () => {
      const r = await upload(a.token, 'rx.pdf');
      assert.equal(r.status, 200);
      urlA = r.body.data!.files[0]!.url;
      assert.match(urlA, /^\/api\/static\/general\/\d+-.+\.pdf$/);
      const row = await FileUploadModel.findOne({ path: urlA.slice('/api/static/'.length) }).lean();
      assert.equal(row?.uploaderType, 'user'); assert.equal(row?.uploaderId, a._id);
      const anon = await get(urlA);
      assert.equal(anon.status, 401);
      assert.match(anon.headers.get('cache-control') ?? '', /no-store/);
      assert.equal((await get(urlA, b.token)).status, 404);
      const own = await get(urlA, a.token);
      assert.equal(own.status, 200);
      assert.equal(await own.text(), 'content of rx.pdf');
      assert.match(own.headers.get('cache-control') ?? '', /private, no-store/);
      assert.equal(own.headers.get('etag'), null);
      assert.equal(own.headers.get('last-modified'), null);
      assert.equal((await get(urlA, admin.token)).status, 200);
    });

    await check('the same decision on /api/v1/file/static and /api/v1/file/fetch (which now accepts /api/static URLs)', async () => {
      const rel = urlA.slice('/api/static/'.length);
      assert.equal((await get('/api/v1/file/static/' + rel, a.token)).status, 200);
      assert.equal((await get('/api/v1/file/static/' + rel, b.token)).status, 404);
      assert.equal((await get('/api/v1/file/fetch?url=' + encodeURIComponent(urlA), a.token)).status, 200);
      assert.equal((await get('/api/v1/file/fetch?url=' + encodeURIComponent(urlA), b.token)).status, 404);
      assert.equal((await get('/api/v1/file/fetch?url=' + encodeURIComponent(rel), b.token)).status, 404);
      assert.equal((await get('/api/v1/file/fetch?url=' + encodeURIComponent(urlA))).status, 401);
    });

    await check('a missing file looks the same as a forbidden one (no existence oracle)', async () => {
      const missing = await get('/api/static/general/does-not-exist.pdf', b.token);
      assert.equal(missing.status, 404);
      assert.equal((await get('/api/static/general/does-not-exist.pdf')).status, 401);
      assert.equal((await get('/api/static/general/../general/x.pdf', a.token)).status === 200, false);
    });

    await check('uploads to the server folders are refused', async () => {
      for (const m of ['bookings', 'external-bookings', 'payouts', 'Bookings']) {
        const r = await upload(a.token, 'x.pdf', m);
        assert.equal(r.status, 400, m); assert.equal(r.body.code, 'UPLOAD_MODULE_RESERVED');
      }
      assert.equal(fs.existsSync(path.join(UPLOAD, 'bookings')), false);
    });

    const spec = staff('specialist'); const otherSpec = staff('specialist');
    const pharmacy = staff('pharmacy'); const otherPharmacy = staff('pharmacy');
    const hr = staff('hr', { corporateId: oid() }); const otherHr = staff('hr', { corporateId: oid() });
    const bookingId = new Types.ObjectId();
    await BookingModel.collection.insertOne({ _id: bookingId, userId: new Types.ObjectId(a._id), specialistId: new Types.ObjectId(spec._id),
      pharmacyId: new Types.ObjectId(pharmacy._id), corporateId: new Types.ObjectId((hr.claims as { corporateId: string }).corporateId),
      status: 'confirmed', paymentStatus: 'paid' } as never);

    await check('a server-written prescription is read by the booking’s customer, specialist, pharmacy and HR only', async () => {
      const rel = `bookings/${bookingId.toHexString()}/prescription-1700000000000.pdf`;
      put(rel, 'rx');
      for (const who of [a, spec, pharmacy, hr, admin]) assert.equal((await get('/api/static/' + rel, who.token)).status, 200);
      for (const who of [b, otherSpec, otherPharmacy, otherHr]) assert.equal((await get('/api/static/' + rel, who.token)).status, 404);
      // Only the exact server pattern: another file in that folder is admin-only.
      put(`bookings/${bookingId.toHexString()}/notes.pdf`);
      assert.equal((await get(`/api/static/bookings/${bookingId.toHexString()}/notes.pdf`, a.token)).status, 404);
    });

    await check('a lab report is read by the external booking’s customer only; payout HTML by admin only, as a sandboxed download', async () => {
      const ext = new Types.ObjectId();
      await ExternalBookingModel.collection.insertOne({ _id: ext, userId: new Types.ObjectId(a._id) } as never);
      const rel = `external-bookings/${ext.toHexString()}/diagnostics-report-R1.pdf`;
      put(rel);
      assert.equal((await get('/api/static/' + rel, a.token)).status, 200);
      assert.equal((await get('/api/static/' + rel, b.token)).status, 404);
      put('payouts/invoices/Dr_X/202611.html', '<script>alert(1)</script>');
      assert.equal((await get('/api/static/payouts/invoices/Dr_X/202611.html', a.token)).status, 404);
      const inv = await get('/api/static/payouts/invoices/Dr_X/202611.html', admin.token);
      assert.equal(inv.status, 200);
      assert.match(inv.headers.get('content-disposition') ?? '', /^attachment;/);
      assert.equal(inv.headers.get('content-security-policy'), 'sandbox');
    });

    await check('bindings: booking and pharmacy-order readers while the record holds the file; public anonymously, short cache', async () => {
      const r1 = await upload(a.token, 'doc.pdf');
      const url = r1.body.data!.files[0]!.url;
      const rel = url.slice('/api/static/'.length);
      assert.equal((await get(url, spec.token)).status, 404);
      await BookingModel.collection.updateOne({ _id: bookingId }, { $set: { documents: [{ url, name: 'doc' }] } });
      assert.equal((await get(url, spec.token)).status, 404, 'a reference alone grants nothing');
      await grantFiles(a.claims, [rel], 'booking', { model: 'Booking', resourceId: bookingId, field: 'documents.url' });
      assert.equal((await get(url, spec.token)).status, 200);
      assert.equal((await get(url, otherSpec.token)).status, 404);
      const order = new Types.ObjectId();
      await PharmacyOrderModel.collection.insertOne({ _id: order, customerId: new Types.ObjectId(a._id),
        pharmacyId: new Types.ObjectId(otherPharmacy._id), buyerPharmacyId: null, prescriptionUrls: [url] } as never);
      await grantFiles(a.claims, [rel], 'pharmacy_order', { model: 'PharmacyOrder', resourceId: order, field: 'prescriptionUrls' });
      assert.equal((await get(url, otherPharmacy.token)).status, 200);
      assert.equal((await get(url, b.token)).status, 404);
      assert.equal((await get(url)).status, 401);

      put('general/logo.png', 'png');
      assert.equal((await get('/api/static/general/logo.png')).status, 401);
      const ph = new Types.ObjectId();
      await PharmacyModel.collection.insertOne({ _id: ph, profilePictureUrl: '/api/static/general/logo.png' } as never);
      await grantFiles(admin.claims, ['general/logo.png'], 'public', { model: 'Pharmacy', resourceId: ph, field: 'profilePictureUrl' });
      await grantFiles(admin.claims, ['general/logo.png'], 'public', { model: 'Pharmacy', resourceId: ph, field: 'profilePictureUrl' });
      assert.equal(await FileGrantModel.countDocuments({ path: 'general/logo.png' }), 1, 'idempotent');
      const pub = await get('/api/static/general/logo.png');
      assert.equal(pub.status, 200);
      assert.equal(pub.headers.get('cache-control'), 'public, max-age=3600');
    });

    await check('removing or replacing the file withdraws the binding; a binding written after a removal is inert', async () => {
      const ph = await PharmacyModel.collection.findOne({ profilePictureUrl: '/api/static/general/logo.png' });
      await PharmacyModel.collection.updateOne({ _id: ph!._id }, { $set: { profilePictureUrl: '/api/static/general/other.png' } });
      assert.equal((await get('/api/static/general/logo.png')).status, 401, 'no longer public after replacement');
      await PharmacyModel.collection.deleteOne({ _id: ph!._id });
      // Delayed add after a newer removal: the booking no longer lists this document.
      const r = await upload(a.token, 'late.pdf');
      const url = r.body.data!.files[0]!.url;
      await grantFiles(a.claims, [url.slice('/api/static/'.length)], 'booking', { model: 'Booking', resourceId: bookingId, field: 'documents.url' });
      assert.equal((await get(url, spec.token)).status, 404);
      // The other binding on the same booking still counts while its document stays.
      const docs = (await BookingModel.collection.findOne({ _id: bookingId }))!.documents as { url: string }[];
      assert.equal((await get(docs[0]!.url, spec.token)).status, 200);
      await BookingModel.collection.updateOne({ _id: bookingId }, { $set: { documents: [] } });
      assert.equal((await get(docs[0]!.url, spec.token)).status, 404, 'removed from the booking');
    });

    await check('a poisoned pre-D1 reference resent unchanged grants nothing (pharmacy avatar → a customer file)', async () => {
      const r = await upload(a.token, 'victim.png');
      const url = r.body.data!.files[0]!.url;
      const ph = new Types.ObjectId();
      await PharmacyModel.collection.insertOne({ _id: ph, profilePictureUrl: url } as never); // written before D1
      const me = { _id: ph.toHexString(), userType: 'pharmacy', pharmacyId: ph.toHexString() };
      await attachFiles(me, 'Pharmacy', [{ field: 'profilePictureUrl', values: [url], previous: [url], kind: 'public' }],
        async () => ({ _id: ph }), (x) => x._id);
      assert.equal(await FileGrantModel.countDocuments({ path: url.slice('/api/static/'.length) }), 0);
      assert.equal((await get(url)).status, 401);
      assert.equal((await get(url, sign(me))).status, 404);
      await assert.rejects(attachFiles(me, 'Pharmacy', [{ field: 'profilePictureUrl', values: [url], previous: [], kind: 'public' }],
        async () => ({ _id: ph }), (x) => x._id), (e: { code?: string }) => e.code === 'FILE_NOT_ATTACHABLE');
    });

    await check('attach check: only the uploader (or admin) may bind a file; unchanged values and external URLs pass', async () => {
      const r = await upload(a.token, 'mine.pdf');
      const url = r.body.data!.files[0]!.url;
      const rel = url.slice('/api/static/'.length);
      const refused = async (p: Promise<unknown>) => assert.equal(await p.then(() => 'ok', (e: { code?: string }) => e.code), 'FILE_NOT_ATTACHABLE');
      assert.deepEqual(await checkAttachable(a.claims, [url]), [rel]);
      assert.deepEqual(await checkAttachable(a.claims, [url], [url]), [rel], 'an authorised re-save binds again (repair)');
      await refused(checkAttachable(b.claims, [url]));
      await refused(checkAttachable(b.claims, ['https://api.example.in' + url]));
      await refused(checkAttachable(b.claims, ['/api/v1/file/fetch?url=' + encodeURIComponent(url)]));
      await refused(checkAttachable(b.claims, [rel]));
      await refused(checkAttachable(pharmacy.claims, [url], [], { publicImage: true }));
      await refused(checkAttachable(b.claims, [`/api/static/bookings/${bookingId.toHexString()}/prescription-1700000000000.pdf`]));
      await refused(checkAttachable(undefined, [url]));
      assert.deepEqual(await checkAttachable(b.claims, [url], [url]), [], 'unchanged without authority: kept, not bound');
      assert.deepEqual(await checkAttachable(b.claims, ['https://cdn.example.com/photo.jpg', 'heart', '']), []);
      assert.deepEqual(await checkAttachable(admin.claims, ['/api/static/general/logo.png'], [], { publicImage: true }), ['general/logo.png']);
      await refused(checkAttachable(a.claims, [url], [], { publicImage: true })); // a PDF can never be public
    });
  } finally {
    server.close();
    await mongoose.disconnect();
  }
  console.log(`${passed} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
