/**
 * Q16c (pre-production review, pharmacy area): import dates (day first, month-first files, month-year and ISO date
 * cells), the IST business date for every expiry check, blank import prices kept, unpriced items off the shelf, the
 * prescription default for imported medicines, GST percent cells, quantity and expiry bounds, upload refusals, import
 * ids and the stale-commit claim, the import template, supplier per delivery, the index-check cache and the keyed
 * pharmacy create, pharmacies with a non-date updatedAt, and the safe sync-indexes for pharmacy emails.
 * Real MongoDB replica set and the real inventory, supplier, import and pharmacy routers.
 *
 * Every check runs even when an earlier one fails (the run exits 1 if any failed), so the suite can be run against the
 * code before Q16c to see each check fail.
 *
 * Run (throwaway DB only; the script drops its collections):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/q16c_pharmacy_check?directConnection=true' JWT_SECRET_KEY=local-integration-only \
 *     npx tsx test/pharmacy-inventory/q16c-pharmacy.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import { Container } from 'typedi';
import * as XLSX from 'xlsx';
import { CONFIG } from '@/config/config';
import PharmacyModel from '@/modules/pharmacies/model';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import { PharmacyService } from '@/modules/pharmacies/services';
import { UserRepository } from '@/modules/user/repository';
import { InventoryItemModel, InventoryAdjustmentModel, InventoryReservationModel } from '@/modules/pharmacyInventory/model';
import { InventoryAdjustmentRepository, InventoryItemRepository, InventoryReservationRepository } from '@/modules/pharmacyInventory/repository';
import { InventoryService } from '@/modules/pharmacyInventory/services';
import { PharmacyCreateRequestModel } from '@/modules/pharmacyInventory/model/createRequest';
import MedicineModel from '@/modules/pharmacyMedicines/model';
import { MedicineRepository } from '@/modules/pharmacyMedicines/repository';
import PharmacySupplierModel from '@/modules/pharmacySuppliers/model';
import { PharmacySupplierRepository } from '@/modules/pharmacySuppliers/repository';
import { PharmacySupplierService } from '@/modules/pharmacySuppliers/services';
import InventoryImportModel from '@/modules/pharmacyInventoryImports/model';
import { InventoryImportService } from '@/modules/pharmacyInventoryImports/services';
import { PharmacyCartService } from '@/modules/pharmacyCart/services';
import { PharmacyCartRepository } from '@/modules/pharmacyCart/repository';
import { RequestKeyModel } from '@/modules/requestKeys/model';
import { AuthSessionModel } from '@/modules/auth/model/session';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/q16c_pharmacy_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

let passed = 0;
const failed: string[] = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log('ok -', name); }
  catch (e) { failed.push(name); console.log('FAIL -', name); console.error(e); }
}
const code = (c: string) => (e: any) => { assert.equal(e?.code, c, `${e?.code}: ${e?.message}`); return true; };
const uploadDir = path.resolve(process.cwd(), 'uploads', 'inventory-imports');
const filesNow = () => (fs.existsSync(uploadDir) ? fs.readdirSync(uploadDir).length : 0);
const utcToday = () => new Date().toISOString().slice(0, 10).replace(/-/g, '');
const FUTURE = '20301231';
const FUTURE_DMY = '31-12-2030';

async function main() {
  await mongoose.connect(FIXTURE_URL, { autoIndex: false });
  for (const c of await mongoose.connection.db!.collections()) await c.drop().catch(() => {});
  for (const M of [PharmacyModel, InventoryItemModel, InventoryAdjustmentModel, InventoryReservationModel, MedicineModel, PharmacySupplierModel,
    InventoryImportModel, RequestKeyModel, PharmacyCreateRequestModel, AuthSessionModel] as mongoose.Model<any>[]) {
    await M.createCollection(); await M.createIndexes();
  }
  const [pA, pB] = [new Types.ObjectId(), new Types.ObjectId()];
  for (const [n, id] of [pA, pB].entries()) {
    await PharmacyModel.collection.insertOne({ _id: id, name: `Pharmacy ${n}`, isActive: true, isVerified: true, phone: `900000020${n}`,
      latitude: 19.07, longitude: 72.87, createdAt: new Date(), updatedAt: new Date() } as never);
  }
  const med = async (name: string) => String((await MedicineModel.collection.insertOne({ name, nameKey: name.toLowerCase(), isActive: true, prescriptionRequired: false } as never)).insertedId);
  const ACTOR = new Types.ObjectId().toHexString();
  const supplier = async (pharmacyId: Types.ObjectId, displayName: string, state: 'active' | 'archived' = 'active') =>
    String((await PharmacySupplierModel.collection.insertOne({ schemaVersion: 1, pharmacyId, displayName, contactName: null, phone: null,
      email: null, address: null, state, revision: 1, createdByActorId: ACTOR, updatedByActorId: ACTOR,
      archivedAt: state === 'archived' ? new Date() : null, createdAt: new Date(), updatedAt: new Date() } as never)).insertedId);
  const sMehta = await supplier(pA, 'Mehta Traders');
  const sRoy = await supplier(pA, 'Roy Distributors');
  const sOld = await supplier(pA, 'Old Pharma', 'archived');
  const sOther = await supplier(pB, 'B Supplies');

  const inventory = new (InventoryService as unknown as new (...a: unknown[]) => InventoryService)(new InventoryItemRepository(),
    new InventoryAdjustmentRepository(), new InventoryReservationRepository(), new PharmacyRepository(), new MedicineRepository());
  Container.set(InventoryService, inventory);
  Container.set(PharmacyService, new PharmacyService(new PharmacyRepository(), new UserRepository()));
  Container.set(PharmacySupplierService, new PharmacySupplierService(new PharmacySupplierRepository()));
  const importSvc = new InventoryImportService(new InventoryItemRepository(), new MedicineRepository(), new InventoryAdjustmentRepository());
  Container.set(InventoryImportService, importSvc);
  const cart = new PharmacyCartService(new PharmacyCartRepository(), inventory, new PharmacyRepository(), new MedicineRepository(), {} as never);
  const [{ default: invRouter }, { default: supRouter }, { default: impRouter }, pharmacyRoutes] = await Promise.all([import('@/modules/pharmacyInventory/routes'),
    import('@/modules/pharmacySuppliers/routes'), import('@/modules/pharmacyInventoryImports/routes'), import('@/modules/pharmacies/routes')]);
  const { authenticate, authenticateOptional } = await import('@/modules/middleware/auth');
  const { errorHandler } = await import('@/modules/middleware');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/pharmacy-inventory', authenticate, invRouter);
  app.use('/api/v1/pharmacy-suppliers', authenticate, supRouter);
  app.use('/api/v1/pharmacy-inventory-imports', authenticate, impRouter);
  app.use('/api/v1/pharmacies', authenticateOptional, pharmacyRoutes.publicPharmacyRouter);
  app.use('/api/v1/pharmacies', authenticate, pharmacyRoutes.default);
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const tokenOf = (id: Types.ObjectId) => jwt.sign({ _id: id.toHexString(), pharmacyId: id.toHexString(), userType: 'pharmacy' }, CONFIG.JWT_SECRET_KEY);
  const [tA, tB] = [tokenOf(pA), tokenOf(pB)];
  const customer = new Types.ObjectId();
  await mongoose.connection.collection('users').insertOne({ _id: customer, userType: 'user', phone: '9811100099', isVerified: true, otpVerified: true, isActive: true } as never);
  const userToken = jwt.sign({ _id: customer.toHexString(), userType: 'user', authVersion: 0 }, CONFIG.JWT_SECRET_KEY);
  const adminToken = jwt.sign({ _id: new Types.ObjectId().toHexString(), userType: 'admin' }, CONFIG.JWT_SECRET_KEY);
  const call = async (method: string, p: string, token: string, body?: unknown) => {
    const r = await fetch(base + p, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  const upload = async (file: string, token: string, fields: Record<string, string> = {}, field = 'file') => {
    const form = new FormData();
    form.append(field, new Blob([fs.readFileSync(file)]), path.basename(file));
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    const r = await fetch(`${base}/api/v1/pharmacy-inventory-imports/preview`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  const commit = (importId: string, token = tA) => call('POST', '/api/v1/pharmacy-inventory-imports/commit', token, { importId });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'q16c-import-'));
  const csvFile = (name: string, lines: string[]) => { const f = path.join(tmp, name); fs.writeFileSync(f, lines.join('\n')); return f; };
  const sheetFile = (name: string, ws: XLSX.WorkSheet, wbProps?: unknown) => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Stock');
    if (wbProps) wb.Workbook = wbProps as never;
    const file = path.join(tmp, name);
    XLSX.writeFile(wb, file);
    return file;
  };
  const rowsOf = (r: { json: any }) => r.json.data.previewRows as any[];
  const { businessClock, istTodayYyyymmdd } = await import('@/modules/pharmacyInventory/businessDate').catch(() => ({} as any));

  try {
    // ───────────────────────────── 12. xlsx upgrade ─────────────────────────────
    await check('12: the SheetJS build is the maintained 0.20.3 (CVE-2023-30533, CVE-2024-22363 fixed)', () => {
      assert.equal(XLSX.version, '0.20.3');
      const pkg = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'));
      assert.equal(pkg.dependencies.xlsx, 'https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz');
    });

    // ───────────────────────────── 2. IST business date ─────────────────────────────
    await check('2: "today" for expiry is the IST date, whatever the server time zone', () => {
      assert.equal(typeof istTodayYyyymmdd, 'function', 'shared helper exists');
      const before = process.env.TZ;
      try {
        for (const tz of ['UTC', 'America/Los_Angeles', 'Asia/Kolkata']) {
          process.env.TZ = tz;
          assert.equal(istTodayYyyymmdd(Date.UTC(2026, 10, 22, 20, 0)), '20261123', tz); // 01:30 IST on the 23rd
          assert.equal(istTodayYyyymmdd(Date.UTC(2026, 10, 22, 18, 29)), '20261122', tz); // 23:59 IST on the 22nd
        }
      } finally { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; }
    });

    await check('2: between 00:00 and 05:30 IST a batch that expired "yesterday" (IST) is not added, imported, shown, carted or reserved', async () => {
      assert.equal(typeof businessClock?.now, 'function', 'business clock exists');
      const d = utcToday(); // the UTC date now; we move the business clock to 23:00 UTC of it (04:30 IST the next day)
      const fake = Date.UTC(Number(d.slice(0, 4)), Number(d.slice(4, 6)) - 1, Number(d.slice(6, 8)), 23, 0);
      const real = businessClock.now;
      const m = await med('IST Edge Med');
      await InventoryItemModel.collection.insertOne({ pharmacyId: pA, medicineId: new Types.ObjectId(m), availableQty: 6, reservedQty: 0, freeQty: 0,
        reorderThreshold: 0, retailPrice: 10, wholesalePrice: 9, isActive: true, createdAt: new Date(), updatedAt: new Date(),
        batches: [{ _id: new Types.ObjectId(), batchNumber: 'IST1', expiryDate: d, receivedAt: new Date(), availableQty: 6, reservedQty: 0, freeQty: 0, status: 'active' }] } as never);
      businessClock.now = () => fake;
      try {
        const add = await call('POST', '/api/v1/pharmacy-inventory', tA, { items: [{ medicineId: m, quantity: 5, batchNumber: 'IST2', expiryDate: d }] });
        assert.deepEqual([add.status, add.json.code], [400, 'BATCH_ALREADY_EXPIRED'], JSON.stringify(add.json));
        const imp = await upload(csvFile('ist.csv', ['Medicine Name,Quantity To Add,Batch Number,Expiry Date', `IST Edge Med,1,IST3,${d}`]), tA);
        assert.equal(imp.status, 200, JSON.stringify(imp.json));
        assert.match(rowsOf(imp)[0].errors.join(' '), /expired stock cannot be imported/);
        const repo = new InventoryItemRepository();
        const shelf = await repo.findPublicInventoryByPharmacy({ pharmacyId: pA.toHexString() } as never, false);
        assert.equal(shelf.data.some((x: any) => x.medicineId === m), false, 'not on the pharmacy shelf');
        const avail = await repo.findMedicineAvailability({ medicineId: m }, false);
        assert.equal(avail.total, 0, 'no pharmacy offers it');
        const nearby = await new MedicineRepository().findNearbyAvailableMedicines({ latitude: 19.07, longitude: 72.87, radiusKm: 5 } as never, false);
        assert.equal(nearby.data.some((x: any) => x.medicineId === m), false, 'not in the nearby search');
        await assert.rejects(() => (cart as any).buildCartItem('user', pA.toHexString(), m, 1), code('MEDICINE_OUT_OF_STOCK'));
        const session = await mongoose.startSession();
        try { assert.equal(await repo.reserveBatches(pA.toHexString(), m, 1, session), null, 'not reservable'); } finally { await session.endSession(); }
      } finally { businessClock.now = real; }
    });

    // ───────────────────────────── 11. Blank prices; unpriced items ─────────────────────────────
    await check('11: blank import price cells keep the stored prices (item and batch; with and without stock added)', async () => {
      const m = await med('Kept Price Med');
      await InventoryItemModel.collection.insertOne({ pharmacyId: pA, medicineId: new Types.ObjectId(m), availableQty: 5, reservedQty: 0, freeQty: 0,
        reorderThreshold: 0, retailPrice: 50, wholesalePrice: 45, purchasePrice: 30, isActive: true, createdAt: new Date(), updatedAt: new Date(),
        batches: [{ _id: new Types.ObjectId(), batchNumber: 'KP1', expiryDate: FUTURE, receivedAt: new Date(), availableQty: 5, reservedQty: 0, freeQty: 0,
          mrp: 60, retailPrice: 50, wholesalePrice: 45, purchasePrice: 30, status: 'active' }] } as never);
      const file = csvFile('blank-prices.csv', ['Medicine Name,Quantity To Add,Batch Number,Expiry Date,Retail Price,Wholesale Price,Purchase Price,MRP,GST Percent',
        'Kept Price Med,0,,,,,,,', `Kept Price Med,3,KP1,${FUTURE_DMY},,,,,`]);
      const r = await upload(file, tA);
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.deepEqual(rowsOf(r).map((x) => [x.status, x.data?.retailPrice, x.data?.mrp]), [['valid', undefined, undefined], ['valid', undefined, undefined]]);
      const c = await commit(String(r.json.data._id));
      assert.equal(c.status, 200, JSON.stringify(c.json));
      const item = await InventoryItemModel.findOne({ pharmacyId: pA, medicineId: m }).lean();
      assert.deepEqual([item!.retailPrice, item!.wholesalePrice, item!.purchasePrice, item!.availableQty], [50, 45, 30, 8]);
      const b = item!.batches!.find((x) => x.batchNumber === 'KP1')!;
      assert.deepEqual([b.mrp, b.retailPrice, b.wholesalePrice, b.purchasePrice], [60, 50, 45, 30]);
      // A typed 0 is a price given (it still overwrites).
      const zero = await upload(csvFile('zero.csv', ['Medicine Name,Quantity To Add,Wholesale Price', 'Kept Price Med,0,0']), tA);
      assert.equal(rowsOf(zero)[0].data.wholesalePrice, 0);
    });

    await check('11: a new medicine imported without a retail price is created but not sellable until priced (shelf and cart agree)', async () => {
      const r = await upload(csvFile('unpriced.csv', ['Medicine Name,Quantity To Add,Batch Number,Expiry Date,Retail Price', `Unpriced New Med,4,NB1,${FUTURE_DMY},`]), tA);
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.equal((await commit(String(r.json.data._id))).status, 200);
      const medicine = await MedicineModel.findOne({ name: 'Unpriced New Med' }).lean();
      assert.ok(medicine, 'medicine created');
      const item = await InventoryItemModel.findOne({ pharmacyId: pA, medicineId: medicine!._id }).lean();
      assert.deepEqual([item!.availableQty, item!.retailPrice ?? null], [4, null], 'stock added, no price');
      const repo = new InventoryItemRepository();
      const mid = String(medicine!._id);
      assert.equal((await repo.findPublicInventoryByPharmacy({ pharmacyId: pA.toHexString() } as never, false)).data.some((x: any) => x.medicineId === mid), false);
      assert.equal((await repo.findMedicineAvailability({ medicineId: mid }, false)).total, 0);
      const nearby = await new MedicineRepository().findNearbyAvailableMedicines({ latitude: 19.07, longitude: 72.87, radiusKm: 5 } as never, false);
      assert.equal(nearby.data.some((x: any) => x.medicineId === mid), false);
      await assert.rejects(() => (cart as any).buildCartItem('user', pA.toHexString(), mid, 1), code('MEDICINE_PRICE_NOT_AVAILABLE'));
      const listed = async () => {
        const r = await call('GET', `/api/v1/pharmacy-inventory?pharmacyId=${pA}&limit=100`, userToken);
        assert.equal(r.status, 200, JSON.stringify(r.json));
        return r.json.data.some((x: any) => String(x.medicineId) === mid);
      };
      assert.equal(await listed(), false, 'not in a customer\'s inventory listing');
      assert.equal((await call('GET', `/api/v1/pharmacy-inventory?limit=100`, tA)).json.data.some((x: any) => String(x.medicineId?._id ?? x.medicineId) === mid), true, 'the pharmacy still sees it');
      // Priced: on the shelf.
      await InventoryItemModel.updateOne({ _id: item!._id }, { $set: { retailPrice: 12 } });
      assert.equal((await repo.findPublicInventoryByPharmacy({ pharmacyId: pA.toHexString() } as never, false)).data.some((x: any) => x.medicineId === mid), true);
      assert.equal(await listed(), true);
      // A pharmacy buyer pays wholesale, else retail: an item with only a wholesale price is listed for pharmacies only.
      await InventoryItemModel.updateOne({ _id: item!._id }, { $set: { wholesalePrice: 9 }, $unset: { retailPrice: '' } });
      assert.equal((await repo.findMedicineAvailability({ medicineId: mid }, true)).total, 1);
      assert.equal((await repo.findMedicineAvailability({ medicineId: mid }, false)).total, 0);
    });

    // ───────────────────────────── Owner decision: prescription default ─────────────────────────────
    await check('decision: a medicine created by an import needs a prescription unless the file says "no"', async () => {
      const r = await upload(csvFile('rx.csv', ['Medicine Name,Quantity To Add,Prescription Required', 'Rx Default Med,0,', 'Rx No Med,0,no', 'Rx Yes Med,0,Yes', 'Rx Junk Med,0,maybe']), tA);
      assert.equal(r.status, 200, JSON.stringify(r.json));
      const rows = rowsOf(r);
      assert.deepEqual(rows.map((x) => [x.status, x.data?.prescriptionRequired]), [['valid', true], ['valid', false], ['valid', true], ['error', undefined]]);
      assert.match(rows[3].errors.join(' '), /prescription required must be yes or no/);
      assert.equal((await commit(String(r.json.data._id))).status, 200);
      const rx = async (name: string) => (await MedicineModel.findOne({ name }).lean())?.prescriptionRequired;
      assert.deepEqual([await rx('Rx Default Med'), await rx('Rx No Med'), await rx('Rx Yes Med')], [true, false, true]);
    });

    // ───────────────────────────── 1. Slash dates ─────────────────────────────
    await check('1: slash dates stay day first; a file whose other rows prove month first refuses its ambiguous slash dates', async () => {
      const dayFirst = await upload(csvFile('day-first.csv', ['Medicine Name,Quantity To Add,Batch Number,Expiry Date', 'A,1,B1,05/06/2030', 'B,1,B2,25/06/2030']), tA);
      assert.deepEqual(rowsOf(dayFirst).map((x) => [x.status, x.data?.expiryDate]), [['valid', '20300605'], ['valid', '20300625']]);
      const mixed = await upload(csvFile('month-first.csv', ['Medicine Name,Quantity To Add,Batch Number,Expiry Date',
        'A,1,B1,12/31/2030', 'B,1,B2,05/06/2030', 'C,1,B3,05/05/2030', 'D,1,B4,05-06-2030', 'E,1,B5,2030-06-05', 'F,1,B6,25/06/2030']), tA);
      const rows = rowsOf(mixed);
      assert.deepEqual(rows.map((x) => x.status), ['error', 'error', 'valid', 'valid', 'valid', 'valid'], JSON.stringify(rows.map((x) => x.errors)));
      assert.match(rows[0].errors.join(' '), /12\/31\/2030 is written month first; dates are read day first/);
      assert.match(rows[1].errors.join(' '), /this file writes dates month first \(row 2: 12\/31\/2030\), so 05\/06\/2030 cannot be read safely/);
      assert.deepEqual(rows.slice(2).map((x) => x.data.expiryDate), ['20300505', '20300605', '20300605', '20300625']);
    });

    // ───────────────────────────── 4. Month-year date cells ─────────────────────────────
    await check('4 + N4: a month-year date cell (mmm-yy, mm/yyyy) storing the 1st is the LAST day of that month; another stored day is that day; full dates unchanged', async () => {
      const ws = XLSX.utils.aoa_to_sheet([['Medicine Name', 'Quantity To Add', 'Batch Number', 'Expiry Date'], ['A', 1, 'B1', 0], ['B', 1, 'B2', 0], ['C', 1, 'B3', 0], ['D', 1, 'B4', 0], ['E', 1, 'B5', 0]]);
      ws['D6'] = { t: 'n', v: 47467, z: 'mmm-yy' }; // a real 15 Dec 2029 shown as Dec-29
      ws['D2'] = { t: 'n', v: 47453, z: 'mmm-yy' }; // 2029-12-01
      ws['D3'] = { t: 'n', v: 47515, z: 'mm/yyyy' }; // 2030-02-01
      ws['D4'] = { t: 'n', v: 47453, z: '[$-409]mmmm yyyy;@' };
      ws['D5'] = { t: 'n', v: 47453, z: 'dd/mm/yyyy' };
      const r = await upload(sheetFile('month-year.xlsx', ws), tA);
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.deepEqual(rowsOf(r).map((x) => [x.status, x.data?.expiryDate]), [['valid', '20291231'], ['valid', '20300228'], ['valid', '20291231'], ['valid', '20291201'], ['valid', '20291215']]);
    });

    // ───────────────────────────── 5. ISO date cells (re-review: no scanner) ─────────────────────────────
    const patchedSheet = (name: string, ws: XLSX.WorkSheet, patch: (xml: string) => string, writeOpts: XLSX.WritingOptions = {}) => {
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Stock');
      const cfb = XLSX.CFB.read(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx', ...writeOpts }), { type: 'buffer' });
      const i = cfb.FullPaths.findIndex((p: string) => p.endsWith('xl/worksheets/sheet1.xml'));
      cfb.FileIndex[i].content = Buffer.from(patch(Buffer.from(cfb.FileIndex[i].content as Uint8Array).toString('utf8'))) as never;
      const file = path.join(tmp, name);
      fs.writeFileSync(file, XLSX.CFB.write(cfb, { fileType: 'zip', type: 'buffer' }) as Buffer);
      return file;
    };
    await check('5 + N1: ISO date cells (t="d") with a date style read the library\'s UTC serial (an offset converted to UTC) in any server time zone; without a style they are plain numbers', async () => {
      const ws = XLSX.utils.aoa_to_sheet([['Medicine Name', 'Quantity To Add', 'Batch Number', 'Expiry Date'], ['A', 1, 'B1', 'x'], ['B', 1, 'B2', 'x'], ['C', 1, 'B3', 'x'], ['D', 1, 'B4', 'x']]);
      for (const a of ['D2', 'D3', 'D4']) ws[a] = { t: 'd', v: '2030-12-31T00:00:00' } as never; // written t="d" with a date style
      const file = patchedSheet('iso.xlsx', ws, (xml) => xml
        .replace(/(<c r="D3"[^>]*>)<v>[^<]*<\/v>/, '$1<v>2030-12-31T00:00:00+05:30</v>')
        .replace(/(<c r="D4"[^>]*>)<v>[^<]*<\/v>/, '$1<v>2030-12-31</v>')
        .replace(/<c r="D5"[^>]*>.*?<\/c>/, '<c r="D5" t="d"><v>2030-12-31T00:00:00</v></c>'), { cellDates: true });
      const { readSheetRows } = await import('@/modules/pharmacyInventoryImports/services');
      const before = process.env.TZ;
      const seen: string[] = [];
      try {
        for (const tz of ['UTC', 'Asia/Kolkata', 'America/Los_Angeles']) {
          process.env.TZ = tz;
          seen.push(JSON.stringify(readSheetRows(file).map((r: any) => r['expiry date'])));
        }
      } finally { if (before === undefined) delete process.env.TZ; else process.env.TZ = before; }
      assert.deepEqual(seen, Array(3).fill(JSON.stringify(['2030-12-31', '2030-12-30', '2030-12-31', 47848])));
      const r = await upload(file, tA);
      assert.deepEqual(rowsOf(r).map((x) => [x.status, x.data?.expiryDate]), [['valid', '20301231'], ['valid', '20301230'], ['valid', '20301231'], ['error', undefined]]);
    });

    await check('N1: a crafted sheet of 64,000 unclosed cells parses in well under a second (no quadratic scan)', async () => {
      const file = patchedSheet('crafted.xlsx', XLSX.utils.aoa_to_sheet([['Medicine Name'], ['A']]), (xml) =>
        xml.replace(/<sheetData>[\s\S]*<\/sheetData>/, `<sheetData><row r="1"><c r="A1" t="str"><v>Medicine Name</v></c></row><row r="2">${'<c r="A2" t="d">'.repeat(64000)}</row></sheetData>`));
      const { readSheetRows } = await import('@/modules/pharmacyInventoryImports/services');
      const t0 = Date.now();
      try { readSheetRows(file); } catch { /* refused or unreadable: either is fine, only the time matters */ }
      assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
    });

    await check('N1: a file of more than 200,000 cells is refused before parsing (400 IMPORT_FILE_TOO_BIG, file removed): .xlsx and .csv', async () => {
      const files = filesNow();
      const xlsx = patchedSheet('many-cells.xlsx', XLSX.utils.aoa_to_sheet([['Medicine Name'], ['A']]), (xml) =>
        xml.replace(/<sheetData>[\s\S]*<\/sheetData>/, `<sheetData><row r="1"><c r="A1" t="str"><v>Medicine Name</v></c></row>${
          Array.from({ length: 1000 }, (_, r) => `<row r="${r + 2}">${'<c><v>1</v></c>'.repeat(201)}</row>`).join('')}</sheetData>`));
      const a = await upload(xlsx, tA);
      assert.deepEqual([a.status, a.json.code], [400, 'IMPORT_FILE_TOO_BIG'], JSON.stringify(a.json).slice(0, 300));
      const csv = csvFile('many-cells.csv', ['Medicine Name,Quantity To Add,Batch Number,Expiry Date', ...Array.from({ length: 50001 }, (_, i) => `M${i},0,,`)]);
      const b = await upload(csv, tA);
      assert.deepEqual([b.status, b.json.code], [400, 'IMPORT_FILE_TOO_BIG'], JSON.stringify(b.json).slice(0, 300));
      assert.equal(filesNow(), files, 'both uploads removed');
      const ok = await upload(csvFile('fewer-cells.csv', ['Medicine Name,Quantity To Add,Batch Number,Expiry Date', ...Array.from({ length: 1000 }, (_, i) => `M${i},0,,`)]), tA);
      assert.equal(ok.status, 200, 'a normal file is read');
    });

    await check('N2: text and boolean cells that carry a date format stay text (no "Invalid Date" names, batches or expiries)', async () => {
      const ws = XLSX.utils.aoa_to_sheet([['Medicine Name', 'Quantity To Add', 'Batch Number', 'Expiry Date', 'Active Status'],
        ['Amox 500', 5, 'B-100', '31-12-2030', true], ['Dolo 650', 5, 'B-200', '12/2030', 'yes'], ['Cefix 200', 5, '2030-01', '20301231', 'yes']]);
      for (const a of ['D2', 'D3', 'D4', 'E2']) ws[a].z = 'm/d/yy';
      ws.C2.z = 'd-mmm-yy'; ws.A3.z = 'dd/mm/yyyy'; ws.C4.z = 'mmm-yy';
      for (const [name, bookType] of [['textdate.xlsx', 'xlsx'], ['textdate.xls', 'biff8']] as const) {
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Stock');
        const file = path.join(tmp, name);
        XLSX.writeFile(wb, file, { bookType });
        const r = await upload(file, tA);
        assert.equal(r.status, 200, JSON.stringify(r.json));
        assert.deepEqual(rowsOf(r).map((x) => [x.status, x.medicineName, x.data?.batchNumber, x.data?.expiryDate]),
          [['valid', 'Amox 500', 'B-100', '20301231'], ['valid', 'Dolo 650', 'B-200', '20301231'], ['valid', 'Cefix 200', '2030-01', '20301231']], name);
      }
      // Safety net: a name or batch that reads "Invalid Date" is refused.
      const net = await upload(csvFile('invalid-date.csv', ['Medicine Name,Quantity To Add,Batch Number,Expiry Date', `Invalid Date,1,B1,${FUTURE_DMY}`, `Good Med,1,Invalid Date,${FUTURE_DMY}`]), tA);
      const rows = rowsOf(net);
      assert.deepEqual(rows.map((x) => x.status), ['error', 'error']);
      assert.match(rows[0].errors.join(' '), /medicine name could not be read as text/);
      assert.match(rows[1].errors.join(' '), /batch number could not be read as text/);
    });

    await check('N3: an empty "quantity to add" cell is 0 even when the sheet also has an "available quantity" column (which is read only without one)', async () => {
      const r = await upload(csvFile('both-qty.csv', ['Medicine Name,Available Quantity,Quantity To Add,Batch Number,Expiry Date',
        `Both Qty A,50,,B1,${FUTURE_DMY}`, `Both Qty B,80,5,B2,${FUTURE_DMY}`]), tA);
      assert.deepEqual(rowsOf(r).map((x) => [x.status, x.data?.quantityToAdd]), [['valid', 0], ['valid', 5]]);
      const legacy = await upload(csvFile('legacy-qty.csv', ['Medicine Name,Available Quantity,Batch Number,Expiry Date', `Legacy Qty,7,B1,${FUTURE_DMY}`]), tA);
      assert.deepEqual(rowsOf(legacy).map((x) => [x.status, x.data?.quantityToAdd]), [['valid', 7]]);
    });

    await check('N5: dash dates too: a file with a month-first-only dash date (12-31-2030) refuses its ambiguous dash dates; slash dates judged separately', async () => {
      const r = await upload(csvFile('dash-month-first.csv', ['Medicine Name,Quantity To Add,Batch Number,Expiry Date',
        'A,1,B1,1-12-2030', 'B,1,B2,12-31-2030', 'C,1,B3,05-05-2030', 'D,1,B4,05/06/2030', 'E,1,B5,25-06-2030']), tA);
      const rows = rowsOf(r);
      assert.deepEqual(rows.map((x) => [x.status, x.data?.expiryDate]), [['error', undefined], ['error', undefined], ['valid', '20300505'], ['valid', '20300605'], ['valid', '20300625']]);
      assert.match(rows[0].errors.join(' '), /this file writes dates month first \(row 3: 12-31-2030\), so 1-12-2030 cannot be read safely/);
      assert.match(rows[1].errors.join(' '), /12-31-2030 is written month first/);
    });

    // ───────────────────────────── Web review: stock info, update_only ─────────────────────────────
    await check('web: preview rows carry inMyStock and currentPrices (null when the pharmacy does not stock the medicine)', async () => {
      const m = await med('Stock Info Med');
      await med('Catalogue Only Med');
      await InventoryItemModel.collection.insertOne({ pharmacyId: pA, medicineId: new Types.ObjectId(m), availableQty: 2, reservedQty: 0, freeQty: 0,
        reorderThreshold: 0, retailPrice: 40, purchasePrice: 25, isActive: true, createdAt: new Date(), updatedAt: new Date(),
        batches: [{ _id: new Types.ObjectId(), batchNumber: 'SI1', expiryDate: FUTURE, receivedAt: new Date(), availableQty: 2, reservedQty: 0, freeQty: 0, mrp: 55, status: 'active' }] } as never);
      const r = await upload(csvFile('stock-info.csv', ['Medicine Name,Quantity To Add,Batch Number,Expiry Date,Retail Price',
        `Stock Info Med,1,SI1,${FUTURE_DMY},`, 'Catalogue Only Med,0,,,', 'Brand New Med,0,,,', 'Stock Info Med,1e3,,,']), tA);
      assert.equal(r.status, 200, JSON.stringify(r.json));
      assert.deepEqual(rowsOf(r).map((x) => [x.status, x.inMyStock, x.currentPrices]), [
        ['valid', true, { mrp: 55, retailPrice: 40, wholesalePrice: null, purchasePrice: 25 }],
        ['valid', false, null], ['valid', false, null],
        ['error', true, { mrp: 55, retailPrice: 40, wholesalePrice: null, purchasePrice: 25 }]]);
      const other = await upload(csvFile('stock-info-b.csv', ['Medicine Name,Quantity To Add', 'Stock Info Med,0']), tB);
      assert.deepEqual(rowsOf(other).map((x) => [x.inMyStock, x.currentPrices]), [[false, null]], 'another pharmacy\'s stock is not mine');
    });

    await check('web: "only medicines already in my stock" (update_only) creates nothing for a row it skips: no medicine, no stock', async () => {
      const inCatalogue = await med('Update Only Catalogue Med');
      const r = await upload(csvFile('update-only.csv', ['Medicine Name,Quantity To Add,Batch Number,Expiry Date,Retail Price',
        `Update Only Unknown Med,5,U1,${FUTURE_DMY},10`, `Update Only Catalogue Med,5,U2,${FUTURE_DMY},10`, `Kept Price Med,1,KP9,${FUTURE_DMY},`]), tA, { importMode: 'update_only' });
      assert.equal(r.status, 200, JSON.stringify(r.json));
      const meds = await MedicineModel.countDocuments();
      const c = await commit(String(r.json.data._id));
      assert.equal(c.status, 200, JSON.stringify(c.json));
      assert.deepEqual(c.json.data.previewRows.map((x: any) => x.status), ['skipped', 'skipped', 'committed']);
      assert.equal(await MedicineModel.countDocuments({ name: 'Update Only Unknown Med' }), 0, 'no medicine created');
      assert.equal(await MedicineModel.countDocuments(), meds);
      assert.equal(await InventoryItemModel.countDocuments({ pharmacyId: pA, medicineId: new Types.ObjectId(inCatalogue) }), 0, 'no stock created');
      // create_only: a medicine already stocked is skipped without changes; a new one is created with its stock.
      const k = await upload(csvFile('create-only.csv', ['Medicine Name,Quantity To Add,Batch Number,Expiry Date', `Kept Price Med,1,KP8,${FUTURE_DMY}`, `Create Only New Med,2,C1,${FUTURE_DMY}`]), tA, { importMode: 'create_only' });
      const before = (await InventoryItemModel.findOne({ pharmacyId: pA, medicineId: (await MedicineModel.findOne({ name: 'Kept Price Med' }).lean())!._id }).lean())!.availableQty;
      const kc = await commit(String(k.json.data._id));
      assert.deepEqual(kc.json.data.previewRows.map((x: any) => x.status), ['skipped', 'committed']);
      assert.equal((await InventoryItemModel.findOne({ pharmacyId: pA, medicineId: (await MedicineModel.findOne({ name: 'Kept Price Med' }).lean())!._id }).lean())!.availableQty, before);
    });

    // ───────────────────────────── 9. GST percent ─────────────────────────────
    await check('9: GST percent accepts a percent cell (0.18 shown as 18%) and text "18%" as 18; over 100 is refused', async () => {
      const ws = XLSX.utils.aoa_to_sheet([['Medicine Name', 'Quantity To Add', 'GST Percent'], ['A', 0, 0], ['B', 0, 0], ['C', 0, 0], ['D', 0, 0]]);
      ws['C2'] = { t: 'n', v: 0.18, z: '0%' };
      ws['C3'] = { t: 'n', v: 0.05, z: '0.00%' };
      ws['C4'] = { t: 'n', v: 12 };
      ws['C5'] = { t: 'n', v: 1.5, z: '0%' }; // 150%
      const r = await upload(sheetFile('gst.xlsx', ws), tA);
      assert.deepEqual(rowsOf(r).map((x) => [x.status, x.data?.gstPercent]), [['valid', 18], ['valid', 5], ['valid', 12], ['error', undefined]]);
      const t = await upload(csvFile('gst.csv', ['Medicine Name,Quantity To Add,GST Percent', 'A,0,18%', 'B,0,5 %', 'C,0,18', 'D,0,118', 'E,0,101%']), tA);
      const rows = rowsOf(t);
      assert.deepEqual(rows.map((x) => [x.status, x.data?.gstPercent]), [['valid', 18], ['valid', 5], ['valid', 18], ['error', undefined], ['error', undefined]]);
      assert.match(rows[3].errors.join(' '), /gst percent must be between 0 and 100/);
    });

    // ───────────────────────────── 10. Quantity, bounds ─────────────────────────────
    await check('10: quantity is a plain whole number (1e3, 0x10, +5, 5.5, booleans refused) of at most 1,000,000 per row', async () => {
      const r = await upload(csvFile('qty.csv', ['Medicine Name,Quantity To Add,Batch Number,Expiry Date',
        `A,1e3,B1,${FUTURE_DMY}`, `B,0x10,B2,${FUTURE_DMY}`, `C,+5,B3,${FUTURE_DMY}`, `D,5.5,B4,${FUTURE_DMY}`, `E,true,B5,${FUTURE_DMY}`,
        `F,1000001,B6,${FUTURE_DMY}`, `G,1000000,B7,${FUTURE_DMY}`, `H,"1,000",B8,${FUTURE_DMY}`]), tA);
      const rows = rowsOf(r);
      assert.deepEqual(rows.map((x) => x.status), ['error', 'error', 'error', 'error', 'error', 'error', 'valid', 'valid']);
      assert.match(rows[0].errors.join(' '), /quantity to add must be a whole number from 0 to/);
      assert.deepEqual([rows[6].data.quantityToAdd, rows[7].data.quantityToAdd], [1000000, 1000]);
      const ws = XLSX.utils.aoa_to_sheet([['Medicine Name', 'Quantity To Add', 'Batch Number', 'Expiry Date'], ['A', true, 'B1', FUTURE_DMY], ['B', 7, 'B2', FUTURE_DMY]]);
      assert.deepEqual(rowsOf(await upload(sheetFile('qty.xlsx', ws), tA)).map((x) => x.status), ['error', 'valid']);
    });

    await check('10: an expiry more than 15 years ahead (IST year) is refused', async () => {
      const y = new Date(Date.now() + 330 * 60 * 1000).getUTCFullYear(); // the IST year
      const r = await upload(csvFile('far.csv', ['Medicine Name,Quantity To Add,Batch Number,Expiry Date', `A,1,B1,31-12-${y + 15}`, `B,1,B2,01-01-${y + 16}`, `C,0,,${y + 40}0101`]), tA);
      const rows = rowsOf(r);
      assert.deepEqual(rows.map((x) => x.status), ['valid', 'error', 'error']);
      assert.match(rows[1].errors.join(' '), /expiry date must be within 15 years/);
    });

    await check('10: refused uploads answer 400 with their own code and leave no file: wrong extension, too large, wrong field, junk, empty', async () => {
      const files = filesNow();
      const txt = await upload(csvFile('stock.txt', ['Medicine Name', 'A']), tA);
      assert.deepEqual([txt.status, txt.json.code], [400, 'UNSUPPORTED_FILE_TYPE']);
      const big = path.join(tmp, 'big.csv');
      fs.writeFileSync(big, `Medicine Name\n${'x'.repeat(10 * 1024 * 1024 + 10)}\n`);
      const tooBig = await upload(big, tA);
      assert.deepEqual([tooBig.status, tooBig.json.code], [400, 'FILE_TOO_LARGE']);
      const field = await upload(csvFile('field.csv', ['Medicine Name', 'A']), tA, {}, 'upload');
      assert.deepEqual([field.status, field.json.code], [400, 'UNEXPECTED_FILE_FIELD']);
      const junk = path.join(tmp, 'junk.xlsx');
      fs.writeFileSync(junk, Buffer.from(Array.from({ length: 3000 }, (_, i) => (i * 7919 + 13) % 256)));
      const j = await upload(junk, tA);
      assert.deepEqual([j.status, ['IMPORT_COLUMNS_MISSING', 'PARSE_FAILED'].includes(j.json.code)], [400, true], JSON.stringify(j.json));
      const zipJunk = path.join(tmp, 'zipjunk.xlsx');
      fs.writeFileSync(zipJunk, Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('garbage')]));
      assert.equal((await upload(zipJunk, tA)).status, 400);
      const text = await upload(csvFile('letter.csv', ['hello world', 'this is not a stock sheet']), tA);
      assert.deepEqual([text.status, text.json.code], [400, 'IMPORT_COLUMNS_MISSING']);
      const empty = await upload(csvFile('empty.csv', ['']), tA);
      assert.deepEqual([empty.status, empty.json.code], [400, 'IMPORT_FILE_EMPTY']);
      const headerOnly = await upload(sheetFile('header-only.xlsx', XLSX.utils.aoa_to_sheet([['Medicine Name', 'Quantity To Add']])), tA);
      assert.deepEqual([headerOnly.status, headerOnly.json.code], [400, 'IMPORT_FILE_EMPTY']);
      assert.equal(filesNow(), files, 'every refused upload was removed');
    });

    // ───────────────────────────── 8. Import ids; stale claim ─────────────────────────────
    await check('8: a malformed import id is 400 VALIDATION_ERROR at the route (commit, retry, get, failed rows)', async () => {
      for (const [method, p, body] of [['POST', '/api/v1/pharmacy-inventory-imports/commit', { importId: 'not-an-id' }],
        ['POST', '/api/v1/pharmacy-inventory-imports/commit', { importId: { $gt: '' } }], ['POST', '/api/v1/pharmacy-inventory-imports/commit', {}],
        ['POST', '/api/v1/pharmacy-inventory-imports/zzz/retry', undefined], ['GET', '/api/v1/pharmacy-inventory-imports/zzz', undefined],
        ['GET', '/api/v1/pharmacy-inventory-imports/zzz/failed-rows/download', undefined]] as const) {
        const r = await call(method, p, tA, body);
        assert.deepEqual([r.status, r.json.code], [400, 'VALIDATION_ERROR'], `${method} ${p} ${JSON.stringify(r.json)}`);
      }
    });

    await check('8: two retries of the same stale "committing" import arriving together: exactly one takes it over', async () => {
      const old = new Date(Date.now() - 20 * 60 * 1000);
      const { insertedId } = await InventoryImportModel.collection.insertOne({ pharmacyId: pA, uploadedBy: pA, uploadedByRole: 'pharmacy', fileName: 's.csv',
        filePath: path.join(tmp, 'gone.csv'), importMode: 'upsert', status: 'committing', totalRows: 1, validRows: 1, errorRows: 0,
        previewRows: [{ rowIndex: 2, medicineName: 'Stale Claim Med', status: 'valid', errors: [], data: { name: 'Stale Claim Med', quantityToAdd: 0, isActive: true, prescriptionRequired: true } }],
        commitErrors: [], createdAt: old, updatedAt: old } as never);
      const repo = (importSvc as any).importRepo;
      const findById = repo.findById;
      let seen = 0;
      let open!: () => void;
      const gate = new Promise<void>((r) => { open = r; });
      repo.findById = async (...a: unknown[]) => { const rec = await findById(...a); if (++seen === 2) open(); await gate; return rec; };
      try {
        const results = await Promise.allSettled([importSvc.retry(String(insertedId), pA.toHexString()), importSvc.retry(String(insertedId), pA.toHexString())]);
        assert.deepEqual(results.map((x) => x.status).sort(), ['fulfilled', 'rejected']);
        const refused = results.find((x) => x.status === 'rejected') as PromiseRejectedResult;
        assert.equal(refused.reason?.code, 'IMPORT_ALREADY_PROCESSING');
      } finally { repo.findById = findById; }
    });

    // ───────────────────────────── Template ─────────────────────────────
    await check('decision: GET /pharmacy-inventory-imports/template gives the exact columns, an example row (31-12-2027) and how to fill it', async () => {
      const { IMPORT_COLUMNS } = await import('@/modules/pharmacyInventoryImports/services') as any;
      const r = await fetch(`${base}/api/v1/pharmacy-inventory-imports/template`, { headers: { authorization: `Bearer ${tA}` } });
      assert.equal(r.status, 200);
      assert.match(String(r.headers.get('content-disposition')), /inventory-import-template\.xlsx/);
      const wb = XLSX.read(Buffer.from(await r.arrayBuffer()), { type: 'buffer' });
      assert.deepEqual(wb.SheetNames, ['Stock', 'How to fill']);
      const rows = XLSX.utils.sheet_to_json<any[]>(wb.Sheets.Stock, { header: 1, raw: true });
      assert.deepEqual(rows[0], IMPORT_COLUMNS);
      assert.equal(rows.length, 2, 'one example row');
      const expiry = wb.Sheets.Stock[XLSX.utils.encode_cell({ r: 1, c: IMPORT_COLUMNS.indexOf('expiry date') })];
      assert.deepEqual([expiry.t, expiry.v], ['s', '31-12-2027']);
      const notes = XLSX.utils.sheet_to_json<any[]>(wb.Sheets['How to fill'], { header: 1 }).flat().join('\n');
      assert.match(notes, /DD-MM-YYYY \(31-12-2027\)/);
      assert.match(notes, /month-first date \(12\/31\/2027\) is refused/);
      // Filled in (the example's name changed), every template column is read by the importer.
      const filled = path.join(tmp, 'filled.xlsx');
      wb.Sheets.Stock.A2 = { t: 's', v: 'Template Filled Med' };
      XLSX.writeFile(wb, filled);
      const up = await upload(filled, tA);
      assert.equal(up.status, 200, JSON.stringify(up.json));
      const d = rowsOf(up)[0];
      assert.equal(d.status, 'valid', JSON.stringify(d.errors));
      assert.deepEqual([d.data.quantityToAdd, d.data.batchNumber, d.data.expiryDate, d.data.mrp, d.data.retailPrice, d.data.wholesalePrice, d.data.purchasePrice,
        d.data.gstPercent, d.data.hsnCode, d.data.prescriptionRequired, d.data.genericName, d.data.brandName, d.data.rackLocation, d.data.isActive],
        [100, 'PCM2412', '20271231', 30, 28, 25, 20, 12, '3004', false, 'Paracetamol', 'Example brand', 'A-3', true]);
      // The CSV template uploaded unchanged: the example row is refused, the "#" notes are not rows.
      const csv = await fetch(`${base}/api/v1/pharmacy-inventory-imports/template?format=csv`, { headers: { authorization: `Bearer ${tA}` } });
      assert.equal(csv.status, 200);
      const text = await csv.text();
      assert.equal(text.split('\r\n')[0], IMPORT_COLUMNS.join(','));
      assert.match(text, /31-12-2027/);
      const asIs = await upload(csvFile('template.csv', [text]), tA);
      assert.equal(asIs.status, 200, JSON.stringify(asIs.json));
      assert.equal(asIs.json.data.totalRows, 1);
      assert.match(rowsOf(asIs)[0].errors.join(' '), /template's example row; delete it/);
      assert.equal((await call('GET', '/api/v1/pharmacy-inventory-imports/template?format=pdf', tA)).status, 400);
    });

    // ───────────────────────────── Supplier per delivery ─────────────────────────────
    await check('supplier: Add stock records the delivery\'s supplier on its adjustment (not the batch); the history names it', async () => {
      const m = await med('Supplier Stock Med');
      const one = await call('POST', '/api/v1/pharmacy-inventory', tA, { items: [{ medicineId: m, quantity: 5, batchNumber: 'SUP1', expiryDate: FUTURE, supplierId: sMehta }] });
      assert.equal(one.status, 201, JSON.stringify(one.json));
      const two = await call('POST', '/api/v1/pharmacy-inventory', tA, { items: [{ medicineId: m, quantity: 2, batchNumber: 'SUP1', expiryDate: FUTURE, supplierId: sRoy.toUpperCase() }] });
      assert.equal(two.status, 201, JSON.stringify(two.json));
      const adj = await InventoryAdjustmentModel.find({ pharmacyId: pA, medicineId: m }).sort({ createdAt: 1 }).lean();
      assert.deepEqual(adj.map((a: any) => String(a.supplierId)), [sMehta, sRoy], 'one batch, topped up from two suppliers');
      const item = await InventoryItemModel.findOne({ pharmacyId: pA, medicineId: m }).lean();
      assert.equal(item!.batches!.length, 1);
      assert.equal('supplierId' in (item!.batches![0] as object), false, 'no supplier on the batch');
      const hist = await call('GET', '/api/v1/pharmacy-inventory/adjustments?limit=50', tA);
      assert.equal(hist.status, 200, JSON.stringify(hist.json));
      const mine = hist.json.data.filter((a: any) => String(a.medicineId?._id ?? a.medicineId) === m);
      assert.deepEqual(mine.map((a: any) => a.supplier?.displayName).sort(), ['Mehta Traders', 'Roy Distributors']);
      assert.ok(hist.json.data.filter((a: any) => !a.supplierId).every((a: any) => a.supplier === null), 'rows without a supplier say null');
    });

    await check('supplier: Add stock refuses another pharmacy\'s supplier (404), an archived one (409), a supplier without received stock (400); nothing saved', async () => {
      const m = await med('Supplier Refusal Med');
      const other = await call('POST', '/api/v1/pharmacy-inventory', tA, { items: [{ medicineId: m, quantity: 5, batchNumber: 'R1', expiryDate: FUTURE, supplierId: sOther }] });
      assert.deepEqual([other.status, other.json.code], [404, 'SUPPLIER_NOT_FOUND']);
      const archived = await call('POST', '/api/v1/pharmacy-inventory', tA, { items: [{ medicineId: m, quantity: 5, batchNumber: 'R1', expiryDate: FUTURE, supplierId: sOld }] });
      assert.deepEqual([archived.status, archived.json.code], [409, 'SUPPLIER_ARCHIVED']);
      const noStock = await call('POST', '/api/v1/pharmacy-inventory', tA, { items: [{ medicineId: m, reorderThreshold: 3, supplierId: sMehta }] });
      assert.deepEqual([noStock.status, noStock.json.code], [400, 'VALIDATION_ERROR']);
      const bad = await call('POST', '/api/v1/pharmacy-inventory', tA, { items: [{ medicineId: m, quantity: 5, batchNumber: 'R1', expiryDate: FUTURE, supplierId: 'nope' }] });
      assert.deepEqual([bad.status, bad.json.code], [400, 'VALIDATION_ERROR']);
      assert.equal(await InventoryItemModel.countDocuments({ pharmacyId: pA, medicineId: m }), 0);
      assert.equal(await InventoryAdjustmentModel.countDocuments({ pharmacyId: pA, medicineId: m }), 0);
    });

    await check('supplier: supplierId is part of the request key content (same key, other supplier: 409 REQUEST_KEY_REUSED)', async () => {
      const m = await med('Supplier Key Med');
      const body = { items: [{ medicineId: m, quantity: 3, batchNumber: 'K1', expiryDate: FUTURE, supplierId: sMehta }], requestKey: 'q16c-supplier-key-01' };
      assert.equal((await call('POST', '/api/v1/pharmacy-inventory', tA, body)).status, 201);
      const again = await call('POST', '/api/v1/pharmacy-inventory', tA, body);
      assert.deepEqual([again.status, again.json.replayed], [200, true]);
      const other = await call('POST', '/api/v1/pharmacy-inventory', tA, { ...body, items: [{ ...body.items[0], supplierId: sRoy }] });
      assert.deepEqual([other.status, other.json.code], [409, 'REQUEST_KEY_REUSED']);
      assert.equal((await InventoryItemModel.findOne({ pharmacyId: pA, medicineId: m }).lean())!.availableQty, 3);
    });

    await check('supplier: an import takes one supplier for the file or a "supplier" column (name or id); deliveries record it; refusals are clear', async () => {
      const files = filesNow();
      const foreign = await upload(csvFile('sup-foreign.csv', ['Medicine Name,Quantity To Add,Batch Number,Expiry Date', `Imp Sup A,1,IS1,${FUTURE_DMY}`]), tA, { supplierId: sOther });
      assert.deepEqual([foreign.status, foreign.json.code], [404, 'SUPPLIER_NOT_FOUND']);
      const archived = await upload(csvFile('sup-archived.csv', ['Medicine Name,Quantity To Add,Batch Number,Expiry Date', `Imp Sup A,1,IS1,${FUTURE_DMY}`]), tA, { supplierId: sOld });
      assert.deepEqual([archived.status, archived.json.code], [409, 'SUPPLIER_ARCHIVED']);
      const malformed = await upload(csvFile('sup-bad.csv', ['Medicine Name,Quantity To Add', 'Imp Sup A,1']), tA, { supplierId: 'xyz' });
      assert.deepEqual([malformed.status, malformed.json.code], [400, 'VALIDATION_ERROR']);
      assert.equal(filesNow(), files, 'refused uploads removed');

      const perFile = await upload(csvFile('sup-file.csv', ['Medicine Name,Quantity To Add,Batch Number,Expiry Date,Retail Price,Supplier',
        `Imp Sup A,4,IS1,${FUTURE_DMY},10,`, `Imp Sup B,2,IS2,${FUTURE_DMY},10,MEHTA  traders`, `Imp Sup C,2,IS3,${FUTURE_DMY},10,Roy Distributors`]), tA, { supplierId: sMehta });
      assert.equal(perFile.status, 200, JSON.stringify(perFile.json));
      assert.equal(String(perFile.json.data.supplierId), sMehta);
      const rows = rowsOf(perFile);
      assert.deepEqual(rows.map((x) => [x.status, x.data?.supplierId]), [['valid', sMehta], ['valid', sMehta], ['error', undefined]]);
      assert.match(rows[2].errors.join(' '), /differs from the supplier chosen for this file/);
      assert.equal((await commit(String(perFile.json.data._id))).status, 200);
      const adj = await InventoryAdjustmentModel.find({ sourceId: String(perFile.json.data._id) }).lean();
      assert.deepEqual(adj.map((a: any) => String(a.supplierId)), [sMehta, sMehta]);

      const perRow = await upload(csvFile('sup-rows.csv', ['Medicine Name,Quantity To Add,Batch Number,Expiry Date,Supplier',
        `Imp Sup D,1,IS4,${FUTURE_DMY},roy distributors`, `Imp Sup E,1,IS5,${FUTURE_DMY},${sMehta}`, `Imp Sup F,1,IS6,${FUTURE_DMY},Nobody Ltd`,
        `Imp Sup G,1,IS7,${FUTURE_DMY},Old Pharma`, `Imp Sup H,1,IS8,${FUTURE_DMY},B Supplies`, `Imp Sup I,1,IS9,${FUTURE_DMY},`]), tA);
      const pr = rowsOf(perRow);
      assert.deepEqual(pr.map((x) => [x.status, x.data?.supplierId]), [['valid', sRoy], ['valid', sMehta], ['error', undefined], ['error', undefined], ['error', undefined], ['valid', undefined]]);
      assert.match(pr[2].errors.join(' '), /"Nobody Ltd" is not one of your suppliers/);
      assert.match(pr[3].errors.join(' '), /"Old Pharma" is archived/);
      assert.match(pr[4].errors.join(' '), /not one of your suppliers/, 'another pharmacy\'s supplier is not found by name');
      // Archived between preview and commit: that row fails (not retryable), the others commit.
      await PharmacySupplierModel.collection.updateOne({ _id: new Types.ObjectId(sRoy) }, { $set: { state: 'archived', archivedAt: new Date() } });
      try {
        const c = await commit(String(perRow.json.data._id));
        assert.equal(c.status, 200, JSON.stringify(c.json));
        assert.deepEqual(c.json.data.commitErrors.map((e: any) => [e.rowIndex, e.code, e.retryable]), [[2, 'SUPPLIER_ARCHIVED', false]]);
        const made = await InventoryAdjustmentModel.find({ sourceId: String(perRow.json.data._id) }).sort({ sourceRowIndex: 1 }).lean();
        assert.deepEqual(made.map((a: any) => [a.sourceRowIndex, a.supplierId ? String(a.supplierId) : null]), [[3, sMehta], [7, null]]);
      } finally {
        await PharmacySupplierModel.collection.updateOne({ _id: new Types.ObjectId(sRoy) }, { $set: { state: 'active', archivedAt: null } });
      }
    });

    // ───────────────────────────── 6. Index checks ─────────────────────────────
    await check('6: a passed index check is trusted for at most 5 minutes (a dropped index is then noticed: 503)', async () => {
      const ri = await import('@/modules/common/utils/requiredIndex') as any;
      assert.equal(typeof ri.indexCheckClock?.now, 'function', 'the cache has a clock');
      const realNow = ri.indexCheckClock.now;
      ri.resetIndexChecks();
      try {
        await ri.assertUniqueIndex(RequestKeyModel, { scope: 1, key: 1 });
        await RequestKeyModel.collection.dropIndexes();
        await ri.assertUniqueIndex(RequestKeyModel, { scope: 1, key: 1 }); // cached pass
        ri.indexCheckClock.now = () => Date.now() + 5 * 60 * 1000 + 1000;
        await assert.rejects(() => ri.assertUniqueIndex(RequestKeyModel, { scope: 1, key: 1 }), code('INDEXES_OUTDATED'));
      } finally {
        ri.indexCheckClock.now = realNow;
        await RequestKeyModel.createIndexes();
        ri.resetIndexChecks();
      }
    });

    await check('6: the keyed admin pharmacy create and its abandon require the request_keys {scope, key} index (503; nothing made)', async () => {
      const ri = await import('@/modules/common/utils/requiredIndex') as any;
      await RequestKeyModel.collection.dropIndexes();
      ri.resetIndexChecks();
      try {
        const phone = '9811100001';
        const made = await call('POST', '/api/v1/pharmacies', adminToken, { name: 'Keyed Without Index', phone, requestKey: 'q16c-pharm-noidx-01' });
        assert.deepEqual([made.status, made.json.code], [503, 'INDEXES_OUTDATED'], JSON.stringify(made.json));
        assert.equal(await PharmacyModel.countDocuments({ phone }), 0);
        const ab = await call('POST', '/api/v1/pharmacies/by-key/q16c-pharm-noidx-02/abandon', adminToken);
        assert.deepEqual([ab.status, ab.json.code], [503, 'INDEXES_OUTDATED'], JSON.stringify(ab.json));
        assert.equal(await RequestKeyModel.countDocuments({ key: 'q16c-pharm-noidx-02' }), 0);
      } finally {
        await RequestKeyModel.createIndexes();
        ri.resetIndexChecks();
      }
      const ok = await call('POST', '/api/v1/pharmacies', adminToken, { name: 'Keyed With Index', phone: '9811100002', requestKey: 'q16c-pharm-idx-01' });
      assert.equal(ok.status, 201, JSON.stringify(ok.json));
    });

    // ───────────────────────────── 7. Non-date updatedAt ─────────────────────────────
    await check('7: a pharmacy whose updatedAt is not a date (text, or missing) can be edited ("no version"); afterwards it is fenced again', async () => {
      const ids = [new Types.ObjectId(), new Types.ObjectId()];
      await PharmacyModel.collection.insertOne({ _id: ids[0], name: 'Text Version', phone: '9811100011', isActive: true, isVerified: true, updatedAt: '2025-01-01T00:00:00Z' } as never);
      await PharmacyModel.collection.insertOne({ _id: ids[1], name: 'No Version', phone: '9811100012', isActive: true, isVerified: true } as never);
      for (const id of ids) {
        const r = await call('PUT', `/api/v1/pharmacies/${id}`, adminToken, { name: 'Edited', expectedUpdatedAt: '2025-01-01T00:00:00Z' });
        assert.equal(r.status, 200, JSON.stringify(r.json));
        const now = await PharmacyModel.collection.findOne({ _id: id });
        assert.equal(now!.name, 'Edited');
        assert.ok(now!.updatedAt instanceof Date, 'the edit wrote a real date');
        const stale = await call('PUT', `/api/v1/pharmacies/${id}`, adminToken, { name: 'Again', expectedUpdatedAt: '2025-01-01T00:00:00Z' });
        assert.deepEqual([stale.status, stale.json.code], [409, 'RECORD_CHANGED'], 'versioned now');
      }
    });

    // ───────────────────────────── 3. sync-indexes and pharmacy emails (last: rebuilds pharmacies) ─────────────────────────────
    await check('3: sync-indexes refuses to touch pharmacies while emails are duplicated (email_1 kept); --clear-empty clears "" emails (dry run first)', async () => {
      const sync = await import('@/scripts/syncIndexes').catch(() => ({})) as any;
      const emails = await import('@/scripts/pharmacyEmailDuplicates') as any;
      assert.equal(typeof sync.syncModelIndexes, 'function', 'sync-indexes is importable and has the per-model sync');
      assert.equal(typeof emails.clearEmptyPharmacyEmails, 'function', 'the --clear-empty migration exists');
      await PharmacyModel.collection.drop();
      await PharmacyModel.createCollection();
      await PharmacyModel.collection.createIndex({ email: 1 }, { sparse: true, name: 'email_1' }); // the pre-Q15 index
      const doc = (n: number, email: unknown) => ({ name: `Dup ${n}`, phone: `98222000${String(n).padStart(2, '0')}`, isActive: true, ...(email === undefined ? {} : { email }) });
      const ins = await PharmacyModel.collection.insertMany([doc(1, 'dup@example.com'), doc(2, 'DUP@example.com '), doc(3, ''), doc(4, '  '), doc(5, 'solo@example.com')] as never[]);
      const names = async () => (await PharmacyModel.collection.listIndexes().toArray()).map((ix) => ix.name).sort();
      await assert.rejects(() => sync.syncModelIndexes(PharmacyModel), /migrate:pharmacy-email-duplicates/);
      assert.deepEqual(await names(), ['_id_', 'email_1'], 'nothing dropped or built');
      const dry = await emails.clearEmptyPharmacyEmails(false);
      assert.deepEqual([dry.mode, dry.pharmacyIds, dry.cleared], ['dry-run', [String(ins.insertedIds[2]), String(ins.insertedIds[3])], 0]);
      assert.equal(await PharmacyModel.collection.countDocuments({ email: { $in: ['', '  '] } }), 2, 'the dry run changed nothing');
      const applied = await emails.clearEmptyPharmacyEmails(true);
      assert.deepEqual([applied.mode, applied.cleared], ['apply', 2]);
      assert.equal(await PharmacyModel.collection.countDocuments({ _id: { $in: [ins.insertedIds[2], ins.insertedIds[3]] }, email: { $exists: true } }), 0);
      await assert.rejects(() => sync.syncModelIndexes(PharmacyModel), /pharmacies left untouched/, 'the real duplicate still blocks');
      await PharmacyModel.collection.updateOne({ _id: ins.insertedIds[1] }, { $set: { email: 'other@example.com' } });
      await sync.syncModelIndexes(PharmacyModel);
      const after = await names();
      assert.ok(after.includes('email_unique_1') && !after.includes('email_1'), JSON.stringify(after));
      // Other models are not held back by the pharmacy check.
      await sync.syncModelIndexes(MedicineModel);
    });
  } finally {
    server.close();
    for (const r of await InventoryImportModel.find({}).select({ filePath: 1 }).lean()) {
      if (r.filePath) fs.rmSync(String(r.filePath), { force: true });
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${passed} checks passed${failed.length ? `, ${failed.length} FAILED: ${failed.join(' | ')}` : ''}`);
  if (failed.length) throw new Error(`${failed.length} checks failed`);
}

main().then(() => mongoose.disconnect()).catch(async (e) => { console.error(e?.message ?? e); await mongoose.disconnect(); process.exit(1); });
