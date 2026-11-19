/**
 * D1: uploaded files need a login. Real route mounts (configureRoutes) over HTTP on a MongoDB replica set and a
 * throwaway upload directory: the one access decision on /api/static, /api/v1/file/static and /api/v1/file/fetch,
 * uploader provenance, server folders, grants, headers, and the attach-time check.
 *
 * Run (throwaway DB; the test creates and removes its own upload directory):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/d1_files_check?directConnection=true' \
 *     JWT_SECRET_KEY=local-check-only npx tsx --tsconfig tsconfig.json test/file-access/d1-private-files.integration.ts
 */
import { removeFixtureDir, UPLOAD_DIR } from './d1-fixture-dir';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import fs from 'node:fs';
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
import { attachFiles, checkAttachable, grantFiles, withFiles } from '@/modules/file/access';
import PharmacyModel from '@/modules/pharmacies/model';
import { Container } from 'typedi';
import { PharmacyService } from '@/modules/pharmacies/services';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import { UserRepository } from '@/modules/user/repository';
import { BannerService } from '@/modules/banners/services';
import { BannerRepository } from '@/modules/banners/repository';
import BannerModel from '@/modules/banners/model';
import { CorporateService } from '@/modules/corporates/services';
import { CorporateRepository } from '@/modules/corporates/repository';
import { SpecialistRepository } from '@/modules/specialists/repository';
import { apply as applyManifest, loadAllModels, propose as proposeManifest } from '@/scripts/d1LegacyFileManifest';
import { errorHandler } from '@/modules/middleware';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/d1_files_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);
const UPLOAD = CONFIG.UPLOAD_DIR;
if (UPLOAD !== UPLOAD_DIR) throw new Error('Refusing to run: configuration did not pick up the fixture directory');

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

  // tsx emits no decorator metadata, so constructor-injected services are wired by hand before the routes load.
  Container.set(PharmacyService, new PharmacyService(new PharmacyRepository(), new UserRepository()));
  Container.set(BannerService, new BannerService(new BannerRepository()));
  const { configureRoutes } = await import('@/routes');
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

    await check('a stale save that restores a removed file cannot revive its old binding (remove-then-stale-resave)', async () => {
      const ph = new Types.ObjectId();
      await PharmacyModel.collection.insertOne({ _id: ph, phone: '9123400101', email: 'p101@example.in' } as never);
      const img = (await upload(admin.token, 'stale.png')).body.data!.files[0]!.url;
      const set = (v: string | null) => PharmacyModel.collection.updateOne({ _id: ph }, v ? { $set: { profilePictureUrl: v } } : { $unset: { profilePictureUrl: 1 } });
      await attachFiles(admin.claims, 'Pharmacy', [{ field: 'profilePictureUrl', values: [img], previous: [], kind: 'public' }],
        async () => { await set(img); return { _id: ph }; }, (x) => x._id, ph);
      assert.equal((await get(img)).status, 200);
      const editor = { _id: ph.toHexString(), userType: 'pharmacy', pharmacyId: ph.toHexString() };
      // The editor (not the uploader) read the record while it held the image; the admin's removal commits before the
      // editor's save, which writes the old value back.
      await attachFiles(editor, 'Pharmacy', [{ field: 'profilePictureUrl', values: [img], previous: [img], kind: 'public' }],
        async () => {
          await attachFiles(admin.claims, 'Pharmacy', [{ field: 'profilePictureUrl', values: [], previous: [img], kind: 'public' }],
            async () => { await set(null); return { _id: ph }; }, (x) => x._id, ph);
          assert.equal((await get(img)).status, 401);
          await set(img);
          return { _id: ph };
        }, (x) => x._id, ph);
      assert.equal((await PharmacyModel.collection.findOne({ _id: ph }))!.profilePictureUrl, img, 'the stale value is back');
      assert.equal((await get(img)).status, 401, 'but not published again');
      assert.equal(await FileGrantModel.countDocuments({ path: img.slice('/api/static/'.length), state: 'active' }), 0);

      // A removal outside the wrappers is withdrawn when a read sees it; a later restore stays unpublished.
      await attachFiles(admin.claims, 'Pharmacy', [{ field: 'profilePictureUrl', values: [img], previous: [img], kind: 'public' }],
        async () => ({ _id: ph }), (x) => x._id, ph);
      assert.equal((await get(img)).status, 200, 'an authorised re-save binds again');
      await set(null);
      assert.equal((await get(img)).status, 401);
      await set(img);
      assert.equal((await get(img)).status, 401);
    });

    await check('every binding is examined: 100 stale bindings do not hide the current one', async () => {
      const img = (await upload(admin.token, 'many.png')).body.data!.files[0]!.url;
      const rel = img.slice('/api/static/'.length);
      await FileGrantModel.insertMany(Array.from({ length: 100 }, () => ({ path: rel, kind: 'public', model: 'Pharmacy',
        resourceId: oid(), field: 'profilePictureUrl', source: 'attach', state: 'active', gen: 1, createdByType: 'admin', createdById: admin._id, createdAt: new Date() })));
      const ph = new Types.ObjectId();
      await PharmacyModel.collection.insertOne({ _id: ph, phone: '9123400102', email: 'p102@example.in', profilePictureUrl: img } as never);
      await grantFiles(admin.claims, [rel], 'public', { model: 'Pharmacy', resourceId: ph, field: 'profilePictureUrl' });
      assert.equal((await get(img)).status, 200);
      assert.equal(await FileGrantModel.countDocuments({ path: rel, state: 'active' }), 1, 'the stale ones seen on the way were withdrawn');
    });

    await check('a grant delayed past a removal and a stale restore stays inert (generation fence)', async () => {
      const ph = new Types.ObjectId();
      await PharmacyModel.collection.insertOne({ _id: ph, phone: '9123400103', email: 'p103@example.in' } as never);
      const img = (await upload(admin.token, 'delayed.png')).body.data!.files[0]!.url;
      const set = (v: string | null) => PharmacyModel.collection.updateOne({ _id: ph }, v ? { $set: { profilePictureUrl: v } } : { $unset: { profilePictureUrl: 1 } });
      const editor = { _id: ph.toHexString(), userType: 'pharmacy', pharmacyId: ph.toHexString() };
      // A (admin, authorised) saves P and is delayed before its grant; meanwhile B removes P and C (no authority) restores it.
      await attachFiles(admin.claims, 'Pharmacy', [{ field: 'profilePictureUrl', values: [img], previous: [], kind: 'public' }],
        async () => {
          await set(img);
          await attachFiles(admin.claims, 'Pharmacy', [{ field: 'profilePictureUrl', values: [], previous: [img], kind: 'public' }],
            async () => { await set(null); return { _id: ph, profilePictureUrl: undefined }; }, (x) => x._id, ph);
          await attachFiles(editor, 'Pharmacy', [{ field: 'profilePictureUrl', values: [img], previous: [img], kind: 'public' }],
            async () => { await set(img); return { _id: ph, profilePictureUrl: img }; }, (x) => x._id, ph);
          return { _id: ph, profilePictureUrl: img };
        }, (x) => x._id, ph);
      assert.equal((await PharmacyModel.collection.findOne({ _id: ph }))!.profilePictureUrl, img);
      assert.equal((await get(img)).status, 401, 'the delayed grant did not republish it');
      const slot = await FileGrantModel.findOne({ path: img.slice('/api/static/'.length) }).lean();
      assert.equal(slot?.state, 'revoked');
      // A later authorised attach (fresh authority) binds again.
      await attachFiles(admin.claims, 'Pharmacy', [{ field: 'profilePictureUrl', values: [img], previous: [img], kind: 'public' }],
        async () => ({ _id: ph, profilePictureUrl: img }), (x) => x._id, ph);
      assert.equal((await get(img)).status, 200);
    });

    await check('a rejected write, or a field the service ignored, withdraws nothing', async () => {
      const r1 = await upload(a.token, 'kept.pdf');
      const url = r1.body.data!.files[0]!.url;
      const bk = new Types.ObjectId();
      await BookingModel.collection.insertOne({ _id: bk, userId: a._id, specialistId: new Types.ObjectId(spec._id), documents: [{ url }] } as never);
      await grantFiles(a.claims, [url.slice('/api/static/'.length)], 'booking', { model: 'Booking', resourceId: bk, field: 'documents.url' });
      assert.equal((await get(url, spec.token)).status, 200);
      const specs = [{ field: 'documents.url', values: [], previous: [url], kind: 'booking' as const }];
      // Another customer's update of this booking is refused by the service (404): bindings unchanged.
      await assert.rejects(attachFiles(b.claims, 'Booking', specs, async () => { throw Object.assign(new Error('nf'), { status: 404 }); }, () => bk, bk));
      assert.equal((await get(url, spec.token)).status, 200);
      // The owner's notes-only update ignores documents: the saved booking still holds the file, nothing withdrawn.
      await attachFiles(a.claims, 'Booking', specs, async () => ({ _id: bk, documents: [{ url }] }), (x) => x._id, bk);
      assert.equal((await get(url, spec.token)).status, 200);
    });

    await check('withFiles never writes back a file the actor does not own: unchanged → dropped, mixed change → refused', async () => {
      const ph = new Types.ObjectId();
      const adminImg = (await upload(admin.token, 'by-admin.png')).body.data!.files[0]!.url;
      await PharmacyModel.collection.insertOne({ _id: ph, phone: '9123400104', email: 'p104@example.in', name: 'Old', profilePictureUrl: adminImg } as never);
      const me = { _id: ph.toHexString(), userType: 'pharmacy', pharmacyId: ph.toHexString() };
      const body: Record<string, unknown> = { name: 'New', profilePictureUrl: adminImg };
      await withFiles(me, 'Pharmacy', body, ph.toHexString(), async () => {
        await PharmacyModel.collection.updateOne({ _id: ph }, { $set: body });
        return PharmacyModel.collection.findOne({ _id: ph });
      });
      assert.deepEqual(Object.keys(body), ['name'], 'the unchanged unowned avatar was not re-sent');
      const spec2 = new Types.ObjectId();
      const adminDoc = (await upload(admin.token, 'degree.pdf')).body.data!.files[0]!.url;
      const ownDoc = (await upload(sign({ _id: spec2.toHexString(), userType: 'specialist' }), 'own.pdf')).body.data!.files[0]!.url;
      await mongoose.models.Specialist!.collection.insertOne({ _id: spec2, documents: [{ name: 'Degree', url: adminDoc }] } as never);
      await assert.rejects(withFiles({ _id: spec2.toHexString(), userType: 'specialist' }, 'Specialist',
        { documents: [{ name: 'Degree', url: adminDoc }, { name: 'Mine', url: ownDoc }] }, spec2, async () => ({ _id: spec2 })),
        (e: { code?: string }) => e.code === 'FILE_NOT_ATTACHABLE');
    });

    await check('a stale self-save during an interrupted replacement cannot restore the old public image', async () => {
      const ph = new Types.ObjectId();
      await PharmacyModel.collection.insertOne({ _id: ph, phone: '9123400105', email: 'p105@example.in' } as never);
      const P = (await upload(admin.token, 'p.png')).body.data!.files[0]!.url;
      const Q = (await upload(admin.token, 'q.png')).body.data!.files[0]!.url;
      const write = (body: Record<string, unknown>) => async () => { await PharmacyModel.collection.updateOne({ _id: ph }, { $set: body }); return PharmacyModel.collection.findOne({ _id: ph }); };
      const adminBody = { profilePictureUrl: P };
      await withFiles(admin.claims, 'Pharmacy', adminBody, ph, write(adminBody));
      assert.equal((await get(P)).status, 200);
      const me = { _id: ph.toHexString(), userType: 'pharmacy', pharmacyId: ph.toHexString() };
      const stale: Record<string, unknown> = { name: 'x', profilePictureUrl: P }; // the editor loaded P
      await withFiles(me, 'Pharmacy', stale, ph, async () => {
        // The admin's replacement P→Q commits but crashes before any binding work (P's binding stays active).
        await PharmacyModel.collection.updateOne({ _id: ph }, { $set: { profilePictureUrl: Q } });
        return write(stale)();
      });
      assert.equal((await PharmacyModel.collection.findOne({ _id: ph }))!.profilePictureUrl, Q, 'the stale copy did not restore P');
      assert.equal((await get(P)).status, 401);
    });

    await check('an uppercase record id withdraws the canonical slot; an older removal never revokes a newer re-attach', async () => {
      const ph = new Types.ObjectId();
      await PharmacyModel.collection.insertOne({ _id: ph, phone: '9123400106', email: 'p106@example.in' } as never);
      const P = (await upload(admin.token, 'u1.png')).body.data!.files[0]!.url;
      const Q = (await upload(admin.token, 'u2.png')).body.data!.files[0]!.url;
      const write = (body: Record<string, unknown>) => async () => { await PharmacyModel.collection.updateOne({ _id: ph }, { $set: body }); return PharmacyModel.collection.findOne({ _id: ph }); };
      const up = ph.toHexString().toUpperCase();
      const b1 = { profilePictureUrl: P }; await withFiles(admin.claims, 'Pharmacy', b1, up, write(b1));
      const b2 = { profilePictureUrl: Q }; await withFiles(admin.claims, 'Pharmacy', b2, up, write(b2));
      const slotP = await FileGrantModel.findOne({ path: P.slice('/api/static/'.length) }).lean();
      assert.equal(slotP?.resourceId, ph.toHexString()); assert.equal(slotP?.state, 'revoked');
      assert.equal((await get(P)).status, 401); assert.equal((await get(Q)).status, 200);
      // Older A replaces Q→P' and pauses after its save; newer B (authorised) re-attaches Q; then A withdraws.
      const R = (await upload(admin.token, 'u3.png')).body.data!.files[0]!.url;
      const a1: Record<string, unknown> = { profilePictureUrl: R };
      await withFiles(admin.claims, 'Pharmacy', a1, ph, async () => {
        await write(a1)();
        const b3 = { profilePictureUrl: Q };
        await withFiles(admin.claims, 'Pharmacy', b3, ph, write(b3));
        return { _id: ph, profilePictureUrl: R }; // A's own (older) view of what it saved
      });
      assert.equal((await PharmacyModel.collection.findOne({ _id: ph }))!.profilePictureUrl, Q);
      assert.equal((await get(Q)).status, 200, 'the newer re-attach survives the older withdrawal');
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
    await check('HTTP: a pharmacy cannot launder a customer file into its public avatar; its own image is published', async () => {
      const ph = new Types.ObjectId();
      await PharmacyModel.collection.insertOne({ _id: ph, name: 'Test Pharmacy', phone: '9123400001', email: 'p1@example.in', isActive: true } as never);
      const me = sign({ _id: ph.toHexString(), userType: 'pharmacy', pharmacyId: ph.toHexString() });
      const send = (body: object, token = me, url = '/api/v1/pharmacies/me/profile') => fetch(base + url, { method: 'PUT',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const victim = (await upload(a.token, 'victim2.png')).body.data!.files[0]!.url;
      const r = await send({ profilePictureUrl: victim });
      assert.equal(r.status, 400); assert.equal((await r.json() as { code?: string }).code, 'FILE_NOT_ATTACHABLE');
      assert.equal((await PharmacyModel.collection.findOne({ _id: ph }))!.profilePictureUrl, undefined);
      assert.equal((await get(victim)).status, 401);

      const own = (await upload(me, 'logo.png')).body.data!.files[0]!.url;
      // Q14 review N7: a contact change in the same save is left out and named; the rest (the avatar) is saved.
      const withContact = await send({ profilePictureUrl: own, phone: '9123400099' });
      assert.equal(withContact.status, 200);
      const answer = await withContact.json() as { message?: string; ignoredContacts?: string[]; data?: { phone?: string; profilePictureUrl?: string } };
      assert.deepEqual(answer.ignoredContacts, ['phone']);
      assert.equal(answer.message, "Contact details weren't changed here; ask the Jansetu team to update them.");
      assert.equal((await PharmacyModel.collection.findOne({ _id: ph }))!.phone, '9123400001');
      assert.equal((await get(own)).status, 200, 'published');
      const next = (await upload(me, 'logo2.png')).body.data!.files[0]!.url;
      assert.equal((await send({ profilePictureUrl: next })).status, 200);
      assert.equal((await get(own)).status, 401, 'the replaced avatar is no longer public');
      assert.equal((await get(next)).status, 200);

      // KYC documents attached by an admin are read by that pharmacy (not the uploader) and nobody else.
      const kyc = (await upload(admin.token, 'gst.pdf')).body.data!.files[0]!.url;
      const ar = await send({ gstCertificateUrl: kyc }, admin.token, `/api/v1/pharmacies/${ph.toHexString()}`);
      assert.equal(ar.status, 200, await ar.text());
      assert.equal((await get(kyc, me)).status, 200);
      assert.equal((await get(kyc, otherPharmacy.token)).status, 404);
      assert.equal((await get(kyc)).status, 401);
      // A PDF can never become a public avatar.
      const pdf = (await upload(me, 'menu.pdf')).body.data!.files[0]!.url;
      assert.equal((await send({ profilePictureUrl: pdf })).status, 400);

      // Owner decision (19 Nov 2026): only admins create pharmacies. Even a verified, operational pharmacy cannot create
      // one (it could pick any mobile number, which would then sign in to it); an admin can.
      await PharmacyModel.collection.updateOne({ _id: ph }, { $set: { isVerified: true } });
      const create = (token: string, phone: string) => fetch(base + '/api/v1/pharmacies', { method: 'POST',
        headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'New Pharmacy', phone }) });
      const before = await PharmacyModel.countDocuments();
      const byPharmacy = await create(me, '9123400077');
      assert.equal(byPharmacy.status, 403, await byPharmacy.text());
      assert.equal(await PharmacyModel.countDocuments({ phone: '9123400077' }), 0);
      const byAdmin = await create(admin.token, '9123400078');
      assert.equal(byAdmin.status, 201, await byAdmin.text());
      assert.equal(await PharmacyModel.countDocuments(), before + 1);
    });

    await check('HTTP: an admin banner publishes its image', async () => {
      const img = (await upload(admin.token, 'banner.webp')).body.data!.files[0]!.url;
      assert.equal((await get(img)).status, 401);
      const r = await fetch(base + '/api/v1/banners', { method: 'POST', headers: { authorization: 'Bearer ' + admin.token,
        'content-type': 'application/json' }, body: JSON.stringify({ title: 'Hello', imageUrl: img }) });
      assert.equal(r.status, 201, await r.text());
      assert.equal((await get(img)).status, 200);
    });
    await check('legacy manifest: proposals flag shared/public-PDF/server paths; apply binds only approved, unflagged, current entries', async () => {
      const bk1 = new Types.ObjectId(); const bk2 = new Types.ObjectId();
      put('general/legacy-rx.pdf'); put('general/legacy-shared.pdf'); put('general/legacy-card.pdf');
      await BookingModel.collection.insertMany([
        { _id: bk1, userId: new Types.ObjectId(b._id), specialistId: new Types.ObjectId(otherSpec._id),
          documents: [{ url: '/api/static/general/legacy-rx.pdf' }, { url: '/api/static/general/legacy-shared.pdf' }] },
        { _id: bk2, userId: new Types.ObjectId(a._id), documents: [{ url: '/api/static/general/legacy-shared.pdf' }] },
      ] as never);
      await PharmacyModel.collection.insertOne({ _id: new Types.ObjectId(), phone: '9123400099', email: 'p99@example.in', profilePictureUrl: '/api/static/general/legacy-card.pdf' } as never);
      await loadAllModels();
      const entries = await proposeManifest();
      const find = (p: string) => entries.filter((e) => e.path === p);
      assert.deepEqual(find('general/legacy-rx.pdf').map((e) => e.flags), [[]]);
      assert.ok(find('general/legacy-shared.pdf').every((e) => e.flags.includes('referenced_by_several_private_records')));
      assert.ok(find('general/legacy-card.pdf').every((e) => e.flags.includes('public_but_not_an_image')));
      assert.ok(entries.filter((e) => e.path.startsWith('bookings/')).every((e) => e.flags.includes('server_folder')));
      assert.equal(entries.some((e) => e.path === urlA.slice('/api/static/'.length)), false, 'uploads with a recorded uploader are never proposed');
      assert.equal((await get('/api/static/general/legacy-rx.pdf', otherSpec.token)).status, 404, 'admin-only until curated');

      const rx = find('general/legacy-rx.pdf')[0]!;
      const counts = await applyManifest([
        { ...rx, approved: true },
        ...find('general/legacy-shared.pdf').map((e) => ({ ...e, approved: true })), // flagged: never applied
        { ...rx, approved: true, kind: 'public' as const }, // a reviewer cannot widen the audience
        { ...rx, approved: true, resourceId: bk2.toHexString() }, // bk2 does not hold it: stale
        { ...find('general/legacy-card.pdf')[0]!, approved: false },
      ]);
      assert.deepEqual(counts, { applied: 1, not_approved: 1, flagged: 2, invalid: 1, stale: 1 });
      assert.equal((await get('/api/static/general/legacy-rx.pdf', otherSpec.token)).status, 200);
      assert.equal((await get('/api/static/general/legacy-rx.pdf', b.token)).status, 200);
      assert.equal((await get('/api/static/general/legacy-rx.pdf', a.token)).status, 404);
      assert.equal((await get('/api/static/general/legacy-shared.pdf', a.token)).status, 404);
      assert.equal(await FileGrantModel.countDocuments({ path: 'general/legacy-rx.pdf', source: 'legacy_manifest' }), 1);
      assert.deepEqual(await applyManifest([{ ...rx, approved: true }]), { applied: 1, not_approved: 0, flagged: 0, invalid: 0, stale: 0 });
      assert.equal(await FileGrantModel.countDocuments({ path: 'general/legacy-rx.pdf' }), 1, 'idempotent');
    });
    await check('keyed replays: a consultation resend is not re-checked and repairs bindings; a package insert with that key is checked', async () => {
      const { BookingController } = await import('@/modules/bookings/controller');
      const ctl = new BookingController() as unknown as {
        createWithFiles: (req: object, data: object, replays: boolean, create: () => Promise<unknown>) => Promise<unknown> };
      const legacy = '/api/static/general/legacy-old-request.pdf';
      await BookingModel.collection.insertOne({ _id: new Types.ObjectId(), userId: a._id, createRequestKey: 'pre-d1-key-0001',
        documents: [{ url: legacy }] } as never);
      const body = { userId: a._id, requestKey: ' pre-d1-key-0001 ', documents: [{ url: legacy }] };
      assert.equal(await ctl.createWithFiles({ user: a.claims }, body, true, async () => 'replayed'), 'replayed');
      await assert.rejects(ctl.createWithFiles({ user: a.claims }, { ...body, requestKey: 'new-key-0002' }, true, async () => 'inserted'),
        (e: { code?: string }) => e.code === 'FILE_NOT_ATTACHABLE');
      await assert.rejects(ctl.createWithFiles({ user: b.claims }, { ...body, userId: b._id }, true, async () => 'inserted'),
        (e: { code?: string }) => e.code === 'FILE_NOT_ATTACHABLE', 'another customer\'s key is not a replay');
      await assert.rejects(ctl.createWithFiles({ user: a.claims }, body, false, async () => 'package inserted'),
        (e: { code?: string }) => e.code === 'FILE_NOT_ATTACHABLE', 'package/surgery never replay keys, so they are always checked');

      // First attempt saved the booking but its binding failed; the same-key retry repairs it from the stored booking.
      const doc = (await upload(a.token, 'retry.pdf')).body.data!.files[0]!.url;
      const bk = new Types.ObjectId();
      await BookingModel.collection.insertOne({ _id: bk, userId: a._id, specialistId: new Types.ObjectId(spec._id), createRequestKey: 'retry-key-0003',
        documents: [{ url: doc }, { url: legacy }] } as never);
      assert.equal((await get(doc, spec.token)).status, 404);
      await ctl.createWithFiles({ user: a.claims }, { userId: a._id, requestKey: 'retry-key-0003', documents: [] }, true,
        async () => ({ booking: { _id: bk }, replayed: true }));
      assert.equal((await get(doc, spec.token)).status, 200, 'repaired');
      assert.equal(await FileGrantModel.countDocuments({ path: legacy.slice('/api/static/'.length), state: 'active' }), 0, 'legacy stays inert');
    });

    await check('common banners cloned for a new corporate keep their image after the source banner changes', async () => {
      const img = (await upload(admin.token, 'common.png')).body.data!.files[0]!.url;
      const src = await BannerModel.create({ title: 'Common', imageUrl: img } as never);
      await grantFiles(admin.claims, [img.slice('/api/static/'.length)], 'public', { model: 'Banner', resourceId: src._id, field: 'imageUrl' });
      const corp = new CorporateService(new CorporateRepository(), new BannerRepository(), new SpecialistRepository());
      const corporateId = oid();
      await (corp as unknown as { cloneCommonBannersForCorporate: (id: string) => Promise<void> }).cloneCommonBannersForCorporate(corporateId);
      const clone = await BannerModel.findOne({ corporateId, imageUrl: img }).lean();
      assert.ok(clone);
      await BannerModel.updateOne({ _id: src._id }, { $set: { imageUrl: '/api/static/general/other.png' } });
      assert.equal((await get(img)).status, 200, 'the clone still publishes it');
      await BannerModel.deleteOne({ _id: clone!._id });
      assert.equal((await get(img)).status, 401);
    });
    await check('a banner caught mid-publication (saved, binding not yet written) is not cloned unbound', async () => {
      const B = (await upload(admin.token, 'midway.png')).body.data!.files[0]!.url;
      const src = await BannerModel.create({ title: 'Midway', imageUrl: B } as never); // saved; its binding not written yet
      const corp = new CorporateService(new CorporateRepository(), new BannerRepository(), new SpecialistRepository());
      const corporateId = oid();
      await (corp as unknown as { cloneCommonBannersForCorporate: (id: string) => Promise<void> }).cloneCommonBannersForCorporate(corporateId);
      assert.equal(await BannerModel.countDocuments({ corporateId, imageUrl: B }), 0, 'skipped, not cloned without its binding');
      // Once the publication completes, a clone is made with the binding.
      await grantFiles(admin.claims, [B.slice('/api/static/'.length)], 'public', { model: 'Banner', resourceId: src._id, field: 'imageUrl' });
      const corporate2 = oid();
      await (corp as unknown as { cloneCommonBannersForCorporate: (id: string) => Promise<void> }).cloneCommonBannersForCorporate(corporate2);
      const clone = await BannerModel.findOne({ corporateId: corporate2, imageUrl: B }).lean();
      assert.ok(clone);
      assert.equal(await FileGrantModel.countDocuments({ model: 'Banner', resourceId: String(clone!._id), state: 'active' }), 1);
    });
  } finally {
    server.close();
    await mongoose.disconnect();
    removeFixtureDir();
  }
  console.log(`${passed} checks passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
