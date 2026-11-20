/**
 * Q15 (pharmacy web packet gaps): keyed inventory saves and supplier creates (exactly once per pharmacy and key, replay
 * by content, by-key lookups scoped to the pharmacy) and the inventory import fixes (headers in any case and spacing,
 * spreadsheet dates as expiry, importMode validated, no server file path in answers). Real MongoDB replica set and the
 * real inventory, supplier and import routers.
 *
 * Every check runs even when an earlier one fails (the run exits 1 if any failed), so the suite can be run against the
 * code before Q15 to see each check fail.
 *
 * Run (throwaway DB only; the script drops its collections):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/q15_pharmacy_keys_check?directConnection=true' JWT_SECRET_KEY=local-integration-only \
 *     npx tsx test/pharmacy-inventory/q15-pharmacy-keys.integration.ts
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
import { addDaysToYyyymmdd, getTodayYyyymmdd } from '@/modules/common/utils/dateUtils';
import PharmacyModel from '@/modules/pharmacies/model';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import { PharmacyService } from '@/modules/pharmacies/services';
import { UserRepository } from '@/modules/user/repository';
import { InventoryItemModel, InventoryAdjustmentModel, InventoryReservationModel } from '@/modules/pharmacyInventory/model';
import { InventoryAdjustmentRepository, InventoryItemRepository, InventoryReservationRepository } from '@/modules/pharmacyInventory/repository';
import { InventoryService } from '@/modules/pharmacyInventory/services';
import MedicineModel from '@/modules/pharmacyMedicines/model';
import { MedicineRepository } from '@/modules/pharmacyMedicines/repository';
import PharmacySupplierModel from '@/modules/pharmacySuppliers/model';
import { PharmacySupplierRepository } from '@/modules/pharmacySuppliers/repository';
import { PharmacySupplierService } from '@/modules/pharmacySuppliers/services';
import InventoryImportModel from '@/modules/pharmacyInventoryImports/model';
import { InventoryImportService } from '@/modules/pharmacyInventoryImports/services';
import { RequestKeyModel } from '@/modules/requestKeys/model';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/q15_pharmacy_keys_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

let passed = 0;
const failed: string[] = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log('ok -', name); }
  catch (e) { failed.push(name); console.log('FAIL -', name); console.error(e); }
}
const today = getTodayYyyymmdd();
const future = addDaysToYyyymmdd(today, 400);
const uploadDir = path.resolve(process.cwd(), 'uploads', 'inventory-imports');
const filesNow = () => (fs.existsSync(uploadDir) ? fs.readdirSync(uploadDir).length : 0);

async function main() {
  await mongoose.connect(FIXTURE_URL, { autoIndex: false });
  for (const c of await mongoose.connection.db!.collections()) await c.drop().catch(() => {});
  const { PharmacyCreateRequestModel } = await import('@/modules/pharmacyInventory/model/createRequest').catch(() => ({ PharmacyCreateRequestModel: null }));
  for (const M of [PharmacyModel, InventoryItemModel, InventoryAdjustmentModel, InventoryReservationModel, MedicineModel, PharmacySupplierModel,
    InventoryImportModel, RequestKeyModel, ...(PharmacyCreateRequestModel ? [PharmacyCreateRequestModel] : [])] as mongoose.Model<any>[]) {
    await M.createCollection(); await M.createIndexes();
  }
  const [pA, pB] = [new Types.ObjectId(), new Types.ObjectId()];
  for (const [n, id] of [pA, pB].entries()) {
    await PharmacyModel.collection.insertOne({ _id: id, name: `Pharmacy ${n}`, isActive: true, isVerified: true, phone: `900000010${n}` } as never);
  }
  const med = async (name: string) => String((await MedicineModel.collection.insertOne({ name, isActive: true, prescriptionRequired: false } as never)).insertedId);
  const m1 = await med('Paracetamol 500');
  const m2 = await med('Cetirizine 10');

  const inventory = new (InventoryService as unknown as new (...a: unknown[]) => InventoryService)(new InventoryItemRepository(),
    new InventoryAdjustmentRepository(), new InventoryReservationRepository(), new PharmacyRepository(), new MedicineRepository());
  Container.set(InventoryService, inventory);
  Container.set(PharmacyService, new PharmacyService(new PharmacyRepository(), new UserRepository()));
  Container.set(PharmacySupplierService, new PharmacySupplierService(new PharmacySupplierRepository()));
  Container.set(InventoryImportService, new InventoryImportService(new InventoryItemRepository(), new MedicineRepository(), new InventoryAdjustmentRepository()));
  const [{ default: invRouter }, { default: supRouter }, { default: impRouter }] = await Promise.all([import('@/modules/pharmacyInventory/routes'),
    import('@/modules/pharmacySuppliers/routes'), import('@/modules/pharmacyInventoryImports/routes')]);
  const { authenticate } = await import('@/modules/middleware/auth');
  const { errorHandler } = await import('@/modules/middleware');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/pharmacy-inventory', authenticate, invRouter);
  app.use('/api/v1/pharmacy-suppliers', authenticate, supRouter);
  app.use('/api/v1/pharmacy-inventory-imports', authenticate, impRouter);
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const tokenOf = (id: Types.ObjectId) => jwt.sign({ _id: id.toHexString(), pharmacyId: id.toHexString(), userType: 'pharmacy' }, CONFIG.JWT_SECRET_KEY);
  const [tA, tB] = [tokenOf(pA), tokenOf(pB)];
  const call = async (method: string, p: string, token: string, body?: unknown) => {
    const r = await fetch(base + p, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  const upload = async (file: string, token: string, fields: Record<string, string> = {}) => {
    const form = new FormData();
    form.append('file', new Blob([fs.readFileSync(file)]), path.basename(file));
    for (const [k, v] of Object.entries(fields)) form.append(k, v);
    const r = await fetch(`${base}/api/v1/pharmacy-inventory-imports/preview`, { method: 'POST', headers: { authorization: `Bearer ${token}` }, body: form });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'q15-import-'));
  const sheetFile = (name: string, rows: unknown[][]) => {
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Stock');
    const file = path.join(tmp, name);
    XLSX.writeFile(wb, file);
    return file;
  };

  try {
    // ───────────────────────────── 7. Keyed inventory save ─────────────────────────────
    await check('7: POST /pharmacy-inventory with requestKey saves once; the same request replays (200); other content 409 REQUEST_KEY_REUSED', async () => {
      const body = { items: [{ medicineId: m1, quantity: 10, batchNumber: 'b-100', expiryDate: future }, { medicineId: m2, reorderThreshold: 5 }],
        requestKey: 'inv-save-q15-0001' };
      const first = await call('POST', '/api/v1/pharmacy-inventory', tA, body);
      assert.equal(first.status, 201, JSON.stringify(first.json));
      const again = await call('POST', '/api/v1/pharmacy-inventory', tA, body);
      assert.deepEqual([again.status, again.json.replayed], [200, true], JSON.stringify(again.json));
      assert.deepEqual(again.json.data.map((i: any) => String(i._id)), first.json.data.map((i: any) => String(i._id)));
      const stock = await InventoryItemModel.findOne({ pharmacyId: pA, medicineId: m1 }).lean();
      assert.equal(stock!.availableQty, 10, 'the replay added nothing');
      assert.equal(await InventoryAdjustmentModel.countDocuments({ pharmacyId: pA }), 1);
      const other = await call('POST', '/api/v1/pharmacy-inventory', tA, { ...body, items: [{ ...body.items[0], quantity: 11 }] });
      assert.deepEqual([other.status, other.json.code], [409, 'REQUEST_KEY_REUSED']);
      assert.equal((await InventoryItemModel.findOne({ pharmacyId: pA, medicineId: m1 }).lean())!.availableQty, 10);
      // Another pharmacy may use the same key for its own save.
      assert.equal((await call('POST', '/api/v1/pharmacy-inventory', tB, body)).status, 201);
    });

    await check('7: GET /pharmacy-inventory/by-key/:key finds the pharmacy\'s own saved items (current state); others and unknown keys 404', async () => {
      const found = await call('GET', '/api/v1/pharmacy-inventory/by-key/inv-save-q15-0001', tA);
      assert.equal(found.status, 200, JSON.stringify(found.json));
      assert.deepEqual(found.json.data.map((i: any) => String(i.medicineId)), [m1, m2]);
      assert.equal(found.json.data[0].availableQty, 10);
      const b = await call('GET', '/api/v1/pharmacy-inventory/by-key/inv-save-q15-0001', tB);
      assert.ok(b.json.data.every((i: any) => String(i.pharmacyId) === pB.toHexString()), 'pharmacy B sees only its own save under that key');
      assert.equal((await call('GET', '/api/v1/pharmacy-inventory/by-key/inv-save-q15-9999', tA)).status, 404);
    });

    // ───────────────────────────── 8. Keyed supplier create ─────────────────────────────
    await check('8: POST /pharmacy-suppliers with requestKey creates once; replay 200; other content 409; by-key for the pharmacy only', async () => {
      const body = { displayName: 'Mehta Distributors', phone: '+91 98765 43210', requestKey: 'sup-create-q15-0001' };
      const first = await call('POST', '/api/v1/pharmacy-suppliers', tA, body);
      assert.equal(first.status, 201, JSON.stringify(first.json));
      const again = await call('POST', '/api/v1/pharmacy-suppliers', tA, { ...body, displayName: '  Mehta Distributors ' });
      assert.deepEqual([again.status, again.json.replayed, again.json.data.supplierId], [200, true, first.json.data.supplierId]);
      assert.equal(await PharmacySupplierModel.countDocuments({ pharmacyId: pA }), 1);
      const other = await call('POST', '/api/v1/pharmacy-suppliers', tA, { ...body, displayName: 'Someone Else' });
      assert.deepEqual([other.status, other.json.code], [409, 'REQUEST_KEY_REUSED']);
      const found = await call('GET', '/api/v1/pharmacy-suppliers/by-key/sup-create-q15-0001', tA);
      assert.deepEqual([found.status, found.json.data.supplierId], [200, first.json.data.supplierId]);
      assert.equal((await call('GET', '/api/v1/pharmacy-suppliers/by-key/sup-create-q15-0001', tB)).status, 404);
      const bad = await call('POST', '/api/v1/pharmacy-suppliers', tA, { displayName: 'X', requestKey: 'short' });
      assert.deepEqual([bad.status, bad.json.code], [400, 'VALIDATION_ERROR']);
      assert.equal((await call('POST', '/api/v1/pharmacy-suppliers', tA, { displayName: 'Unkeyed' })).status, 201, 'unkeyed create unchanged');
    });

    // ───────────────────────────── 9. Inventory imports ─────────────────────────────
    await check('9: import headers match in any case and spacing; spreadsheet dates (date cells and serial numbers) and text dates are read as expiry', async () => {
      const serial = (y: number, m: number, d: number) => (Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000;
      const file = sheetFile('stock.xlsx', [
        [' Medicine Name ', 'QUANTITY TO ADD', 'Batch Number ', ' expiry date', 'Retail Price'],
        ['Paracetamol 500', 5, 'b-1', new Date(2028, 5, 30), 12.5],
        ['Cetirizine 10', 3, 'b-2', serial(2029, 1, 15), 8],
        ['Vitamin C', 2, 'b-3', '2030-03-01', 4],
        ['Iron Tabs', 1, 'b-4', 20310102, 4],
      ]);
      const r = await upload(file, tA);
      assert.equal(r.status, 200, JSON.stringify(r.json));
      const rows = r.json.data.previewRows;
      assert.deepEqual(rows.map((x: any) => x.status), ['valid', 'valid', 'valid', 'valid'], JSON.stringify(rows.map((x: any) => x.errors)));
      assert.deepEqual(rows.map((x: any) => x.data.expiryDate), ['20280630', '20290115', '20300301', '20310102']);
      assert.deepEqual(rows.map((x: any) => [x.data.name, x.data.quantityToAdd, x.data.batchNumber]),
        [['Paracetamol 500', 5, 'B-1'], ['Cetirizine 10', 3, 'B-2'], ['Vitamin C', 2, 'B-3'], ['Iron Tabs', 1, 'B-4']]);
      assert.equal(rows[0].data.retailPrice, 12.5);
    });

    await check('9: the import answers never carry the server file path (preview, record, list)', async () => {
      const r = await upload(sheetFile('one.xlsx', [['name', 'quantity to add'], ['Paracetamol 500', 0]]), tA);
      assert.equal(r.status, 200, JSON.stringify(r.json));
      const id = String(r.json.data._id);
      assert.ok((await InventoryImportModel.findById(id).lean())!.filePath, 'the path is still stored for cleanup');
      assert.equal(JSON.stringify(r.json).includes(uploadDir), false);
      assert.equal('filePath' in r.json.data, false);
      const one = await call('GET', `/api/v1/pharmacy-inventory-imports/${id}`, tA);
      assert.deepEqual([one.status, 'filePath' in one.json.data], [200, false]);
      const list = await call('GET', '/api/v1/pharmacy-inventory-imports', tA);
      assert.equal(list.status, 200);
      assert.ok(list.json.data.length > 0 && list.json.data.every((x: any) => !('filePath' in x)));
    });

    await check('9: an unknown importMode is 400 VALIDATION_ERROR, nothing is recorded and the uploaded file is removed; the allowed modes work', async () => {
      const file = sheetFile('mode.xlsx', [['name', 'quantity to add'], ['Paracetamol 500', 0]]);
      const records = await InventoryImportModel.countDocuments();
      const files = filesNow();
      const bad = await upload(file, tA, { importMode: 'replace_everything' });
      assert.deepEqual([bad.status, bad.json.code], [400, 'VALIDATION_ERROR']);
      assert.equal(await InventoryImportModel.countDocuments(), records);
      assert.equal(filesNow(), files, 'the uploaded file was removed');
      const ok = await upload(file, tA, { importMode: 'update_only' });
      assert.deepEqual([ok.status, ok.json.data.importMode], [200, 'update_only']);
    });
  } finally {
    server.close();
    // The previews of this run leave their uploads behind until commit/cleanup; remove them (this run's records only).
    for (const r of await InventoryImportModel.find({}).select({ filePath: 1 }).lean()) {
      if (r.filePath) fs.rmSync(String(r.filePath), { force: true });
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  console.log(`\n${passed} checks passed${failed.length ? `, ${failed.length} FAILED: ${failed.join(' | ')}` : ''}`);
  if (failed.length) throw new Error(`${failed.length} checks failed`);
}

main().then(() => mongoose.disconnect()).catch(async (e) => { console.error(e?.message ?? e); await mongoose.disconnect(); process.exit(1); });
