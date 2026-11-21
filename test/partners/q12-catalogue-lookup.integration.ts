/**
 * Q12: gaps found by the WQ2 web packet — a lost catalogue item create can be looked up or given up by its request key
 * (claimed with the item, so give-up and create exclude each other), the price list can be searched on the server, and
 * a repeated payment carries `replayed` inside `data`. Real MongoDB replica set.
 *
 * Run (throwaway DB only):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/q12_catalogue_check?directConnection=true' JWT_SECRET_KEY=local-integration-only \
 *     npx tsx test/partners/q12-catalogue-lookup.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import { Container } from 'typedi';
import PartnerModel from '@/modules/partners/model';
import MemberModel from '@/modules/partners/model/member';
import BranchModel from '@/modules/partners/model/branch';
import PartnerAuditEventModel from '@/modules/partners/model/audit';
import CatalogueItemModel from '@/modules/partners/model/catalogueItem';
import { SettlementAccountModel } from '@/modules/partners/model/settlement';
import { RequestKeyModel } from '@/modules/requestKeys/model';
import { PartnerRepository } from '@/modules/partners/repository';
import { MemberRepository } from '@/modules/partners/repository/member';
import { BranchRepository } from '@/modules/partners/repository/branch';
import { CatalogueItemRepository } from '@/modules/partners/repository/catalogueItem';
import { PartnerService, PartnerActor } from '@/modules/partners/services';
import { attachAdminActor } from '@/modules/partners/controller';
import { CatalogueService } from '@/modules/partners/services/catalogue';
import { InvoiceService } from '@/modules/partners/services/invoice';
import { recordPayment } from '@/modules/partners/controller/invoice';
import { catalogueListQuerySchema, catalogueKeyParamSchema } from '@/modules/partners/validation/catalogue';
import { IMember, PartnerPermission } from '@/modules/partners/types';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/q12_catalogue_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const partnerSvc = new PartnerService(new PartnerRepository(), new MemberRepository(), new BranchRepository());
const catalogueSvc = new CatalogueService(new CatalogueItemRepository());
Container.set(PartnerService, partnerSvc);

let passed = 0;
async function check(name: string, fn: () => Promise<void>) { await fn(); passed++; console.log('ok -', name); }
const code = (c: string) => (e: any) => e?.code === c;
const actorFor = (m: IMember): PartnerActor => ({ memberId: String(m._id), partnerId: String(m.partnerId), role: m.role,
  permissions: m.permissions as PartnerPermission[], branchIds: (m.branchIds ?? []).map(String) });
let ph = 7960000000;
const nextPhone = () => String(ph++);

async function lab(name: string) {
  const { partner, owner } = await partnerSvc.createPartner({ kind: 'lab', name, contactPhone: nextPhone(), invoiceSeriesPrefix: 'LB',
    firstOwner: { phone: nextPhone(), name: 'Owner' }, taxRegime: 'unregistered' } as any);
  await partnerSvc.verifyPartner(String(partner._id), 'admin');
  return actorFor(owner);
}
const test = (name: string, code?: string) => ({ kind: 'test' as const, name, ...(code ? { code } : {}), priceMinor: 30000, gstRate: 0, visitModes: ['lab' as const] });

async function main() {
  await mongoose.connect(FIXTURE_URL, { autoIndex: false });
  for (const c of await mongoose.connection.db!.collections()) await c.drop().catch(() => {});
  for (const M of [PartnerModel, MemberModel, BranchModel, PartnerAuditEventModel, CatalogueItemModel, SettlementAccountModel, RequestKeyModel] as mongoose.Model<any>[]) {
    await M.createCollection(); await M.createIndexes();
  }
  const a = await lab('Lab A');
  const b = await lab('Lab B');

  await check('a lost item create is found by its key, only in its own partner', async () => {
    const made = await catalogueSvc.createItem(a, { ...test('CBC', 'CBC01'), requestKey: 'item-key-0001' });
    assert.equal(String((await catalogueSvc.findByKey(a, 'item-key-0001'))!._id), String(made._id));
    assert.equal(await catalogueSvc.findByKey(b, 'item-key-0001'), null, 'another partner never sees it');
    assert.equal(await catalogueSvc.findByKey(a, 'item-key-0404'), null);
    assert.ok(await RequestKeyModel.exists({ scope: `partner_catalogue_create:${a.partnerId}`, key: 'item-key-0001', state: 'used' }), 'the key is claimed with the item');
  });

  await check('giving up a key: used (with the item) or abandoned (then it can never make an item)', async () => {
    const used = await catalogueSvc.abandonKey(a, 'item-key-0001');
    assert.equal(used.state, 'used');
    assert.equal(used.item?.name, 'CBC');
    assert.deepEqual(await catalogueSvc.abandonKey(a, 'item-key-0002'), { state: 'abandoned' });
    await assert.rejects(() => catalogueSvc.createItem(a, { ...test('Lipid'), requestKey: 'item-key-0002' }), code('REQUEST_ABANDONED'));
    assert.equal(await CatalogueItemModel.countDocuments({ partnerId: a.partnerId, name: 'Lipid' }), 0);
    // The same key in another partner is its own key.
    const other = await catalogueSvc.createItem(b, { ...test('Lipid'), requestKey: 'item-key-0002' });
    assert.equal(other.name, 'Lipid');
    // An item made under a key before claims existed (no claim row) is used, never abandoned.
    await CatalogueItemModel.collection.insertOne({ partnerId: a.partnerId, kind: 'test', name: 'Legacy', priceMinor: 100, gstRate: 0, visitModes: ['lab'],
      isActive: true, adminDisabled: false, createRequestKey: 'item-key-0003', createdAt: new Date(), updatedAt: new Date() } as never);
    assert.equal((await catalogueSvc.abandonKey(a, 'item-key-0003')).state, 'used');
    assert.equal(await RequestKeyModel.exists({ scope: `partner_catalogue_create:${a.partnerId}`, key: 'item-key-0003' }), null);
  });

  await check('one partner identity whatever the case of the id: found, never falsely abandoned, and fully usable', async () => {
    // Q16b (replaces "an admin URL keeps its spelling"): the admin actor carries the lowercase id whatever the URL's
    // spelling; rows written earlier under an upper-case spelling stay reachable (samePartner).
    let attached: PartnerActor | undefined;
    const req = { user: { _id: 'ad'.repeat(12), userType: 'admin' }, params: { partnerId: a.partnerId.toUpperCase() } } as any;
    await attachAdminActor(req, {} as any, (e?: unknown) => { if (e) throw e; attached = req.partnerActor; });
    const loud = attached!;
    assert.equal(loud.partnerId, a.partnerId.toLowerCase());
    // Legacy keyed items (no claim row), stored lower- and upper-case: either spelling of the actor finds, opens, lists,
    // edits, deactivates and reactivates them; the key is reported used, never abandoned; a replay makes nothing new.
    for (const [stored, k] of [[a.partnerId, 'item-case-0001'], [a.partnerId.toUpperCase(), 'item-case-0002']] as const) {
      await CatalogueItemModel.collection.insertOne({ partnerId: stored, kind: 'test', name: k, priceMinor: 100, gstRate: 0, visitModes: ['lab'],
        isActive: true, adminDisabled: false, createRequestKey: k, createdAt: new Date(), updatedAt: new Date() } as never);
      for (const actor of [a, loud]) {
        const found = await catalogueSvc.findByKey(actor, k);
        assert.equal(found?.name, k);
        assert.equal((await catalogueSvc.abandonKey(actor, k)).state, 'used');
        assert.equal((await catalogueSvc.getItem(actor, String(found!._id))).name, k);
        assert.ok((await catalogueSvc.listItems(actor)).some((x) => x.name === k), 'listed');
        assert.ok((await catalogueSvc.listItems(actor, undefined, false, k)).some((x) => x.name === k), 'searched');
        const current = await catalogueSvc.getItem(actor, String(found!._id));
        const edited = await catalogueSvc.updateItem(actor, String(found!._id), { priceMinor: current.priceMinor + 1, expectedUpdatedAt: current.updatedAt } as any);
        assert.equal(edited.priceMinor, current.priceMinor + 1);
        await catalogueSvc.deactivateItem(actor, String(found!._id));
        assert.equal((await catalogueSvc.reactivateItem(actor, String(found!._id))).isActive, true);
      }
      assert.equal(await RequestKeyModel.exists({ scope: `partner_catalogue_create:${a.partnerId}`, key: k }), null, 'no abandonment written');
      const again = await catalogueSvc.createItem(loud, { ...test(k), priceMinor: 100, requestKey: k } as any).catch((e) => e);
      assert.ok(again?.replayed === true || again?.code === 'REQUEST_KEY_REUSED');
      assert.equal(await CatalogueItemModel.countDocuments({ createRequestKey: k }), 1);
    }
    // Concurrent same-key creates through both spellings of the id: one item, both answered with it.
    for (let i = 0; i < 6; i++) {
      const k = `item-dual-${String(i).padStart(4, '0')}`;
      const both = await Promise.allSettled([catalogueSvc.createItem(a, { ...test(k), requestKey: k }), catalogueSvc.createItem(loud, { ...test(k), requestKey: k })]);
      assert.equal(await CatalogueItemModel.countDocuments({ createRequestKey: k }), 1, 'one item per key');
      const ids = both.filter((x) => x.status === 'fulfilled').map((x) => String((x as PromiseFulfilledResult<any>).value._id));
      assert.ok(ids.length >= 1 && new Set(ids).size === 1, 'every success is the same item');
      assert.equal((await CatalogueItemModel.findOne({ createRequestKey: k }).lean())!.partnerId, a.partnerId, 'stored canonical');
    }
    // Another partner never reaches them, whatever the spelling.
    const stranger = { ...b, partnerId: b.partnerId.toUpperCase() };
    const legacy = await CatalogueItemModel.findOne({ createRequestKey: 'item-case-0002' }).lean();
    await assert.rejects(() => catalogueSvc.getItem(stranger, String(legacy!._id)), code('CATALOGUE_ITEM_NOT_FOUND'));
  });

  await check('a give-up racing the create: exactly one wins', async () => {
    for (let i = 0; i < 6; i++) {
      const k = `item-race-${String(i).padStart(4, '0')}`;
      const [made, gave] = await Promise.allSettled([catalogueSvc.createItem(a, { ...test(`Race ${i}`), requestKey: k }), catalogueSvc.abandonKey(a, k)]);
      const count = await CatalogueItemModel.countDocuments({ partnerId: a.partnerId, createRequestKey: k });
      const state = gave.status === 'fulfilled' ? gave.value.state : 'error';
      if (state === 'abandoned') assert.equal(count, 0, 'abandoned: no item');
      else { assert.equal(state, 'used'); assert.equal(count, 1); assert.equal(made.status, 'fulfilled'); }
    }
  });

  await check('price list search: name or code, case-insensitive, literal text, active only unless asked', async () => {
    await catalogueSvc.createItem(a, test('Thyroid profile (T3+T4)', 'THY-2'));
    const inactive = await catalogueSvc.createItem(a, test('Thyroid old', 'THY-0'));
    await catalogueSvc.deactivateItem(a, String(inactive._id));
    const names = (xs: { name: string }[]) => xs.map((x) => x.name).sort();
    assert.deepEqual(names(await catalogueSvc.listItems(a, undefined, false, 'thyroid')), ['Thyroid profile (T3+T4)']);
    assert.deepEqual(names(await catalogueSvc.listItems(a, undefined, true, 'THYROID')), ['Thyroid old', 'Thyroid profile (T3+T4)']);
    assert.deepEqual(names(await catalogueSvc.listItems(a, undefined, false, 'cbc0')), ['CBC'], 'matches the code');
    assert.deepEqual(names(await catalogueSvc.listItems(a, undefined, false, '(T3+')), ['Thyroid profile (T3+T4)'], 'regex characters are literal');
    assert.deepEqual(await catalogueSvc.listItems(a, undefined, false, '.*'), []);
    assert.deepEqual(names(await catalogueSvc.listItems(b, undefined, false, 'thyroid')), [], 'own partner only');
    assert.equal(catalogueListQuerySchema.validate({ q: 'x'.repeat(61) }).error?.details[0]?.path[0], 'q');
    assert.ok(catalogueKeyParamSchema.validate({ key: 'short' }).error);
  });

  await check('a repeated payment carries replayed inside data (and at the top level as before)', async () => {
    Container.set(InvoiceService, { recordPayment: async () => ({ invoice: { _id: 'i' }, event: { _id: 'e' }, replayed: true }) } as unknown as InvoiceService);
    let body: any;
    const res = { status: () => res, json: (x: unknown) => { body = x; return res; } } as any;
    await recordPayment({ partnerActor: a, params: { invoiceId: 'x' }, body: {} } as any, res, () => undefined);
    assert.equal(body.data.replayed, true);
    assert.equal(body.replayed, true);
  });

  console.log(`\n${passed} checks passed`);
}

main().then(() => mongoose.disconnect()).catch(async (e) => { console.error(e); await mongoose.disconnect(); process.exit(1); });
