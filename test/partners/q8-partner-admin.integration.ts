/**
 * Q8: partner administration gaps found by the WQ1 web packet — owner-only profile edits, staff branch access, reopening
 * branches, reinstating suspended partners, branch reads for every member, exactly-once partner creation and a paged
 * partner list. Real MongoDB replica set, the real application routes.
 *
 * Run (throwaway DB only):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/q8_partner_admin_check?directConnection=true' JWT_SECRET_KEY=local-integration-only \
 *     npx tsx test/partners/q8-partner-admin.integration.ts
 */
import { removeFixtureDir } from './q8-fixture-dir';
import 'reflect-metadata';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import { Container } from 'typedi';
import { CONFIG } from '@/config/config';
import { errorHandler } from '@/modules/middleware';
import PartnerModel from '@/modules/partners/model';
import MemberModel from '@/modules/partners/model/member';
import BranchModel from '@/modules/partners/model/branch';
import PartnerAuditEventModel from '@/modules/partners/model/audit';
import { SettlementAccountModel } from '@/modules/partners/model/settlement';
import { ScheduleGuardModel } from '@/modules/partners/model/slot';
import { PartnerRepository } from '@/modules/partners/repository';
import { MemberRepository } from '@/modules/partners/repository/member';
import { BranchRepository } from '@/modules/partners/repository/branch';
import { PartnerService, PartnerActor } from '@/modules/partners/services';
import { PharmacyService } from '@/modules/pharmacies/services';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import { UserRepository } from '@/modules/user/repository';
import { BannerService } from '@/modules/banners/services';
import { BannerRepository } from '@/modules/banners/repository';
import { IMember, PartnerPermission } from '@/modules/partners/types';
import SpecialistModel from '@/modules/specialists/model';
import SlotModel from '@/modules/slots/model';
import { DoctorScheduleTemplateModel } from '@/modules/doctors/model/schedule';
import { DoctorScheduleGuardModel, DoctorReservationModel } from '@/modules/doctors/model/reservation';
import { saveTemplate, expandDoctorSlots } from '@/modules/doctors/services/schedule';
import { istDate } from '@/modules/partners/services/slots';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/q8_partner_admin_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const svc = new PartnerService(new PartnerRepository(), new MemberRepository(), new BranchRepository());
Container.set(PartnerService, svc);
let passed = 0;
async function check(name: string, fn: () => Promise<void>) { await fn(); passed++; console.log('ok -', name); }
const code = (c: string) => (e: any) => e?.code === c;
const actorFor = (m: IMember): PartnerActor => ({ memberId: String(m._id), partnerId: String(m.partnerId), role: m.role,
  permissions: m.permissions as PartnerPermission[], branchIds: (m.branchIds ?? []).map(String) });
let ph = 7800000000;
const nextPhone = () => String(ph++);
const branchIn = (name: string) => ({ name, phone: '9876500000', holidays: [], hours: {}, services: { homeCollection: true, inLab: true, inClinic: false },
  address: { line1: 'x', city: 'y', state: 'z', stateCode: '29', pincode: '560001' } }) as any;

async function main() {
  await mongoose.connect(FIXTURE_URL, { autoIndex: false });
  for (const c of await mongoose.connection.db!.collections()) await c.drop().catch(() => {});
  for (const M of [PartnerModel, MemberModel, BranchModel, PartnerAuditEventModel, SettlementAccountModel, ScheduleGuardModel, SpecialistModel, SlotModel, DoctorScheduleTemplateModel, DoctorScheduleGuardModel, DoctorReservationModel] as mongoose.Model<any>[]) {
    await M.createCollection(); await M.createIndexes();
  }
  const { partner, owner } = await svc.createPartner({ kind: 'lab', name: 'Alpha Labs', contactPhone: nextPhone(), invoiceSeriesPrefix: 'AL',
    firstOwner: { phone: nextPhone(), name: 'Owner' } } as any);
  const partnerId = String(partner._id);
  await svc.verifyPartner(partnerId, 'admin');
  const own = actorFor(owner);
  const A = String((await svc.createBranch(own, branchIn('A')))._id);
  const B = String((await svc.createBranch(own, branchIn('B')))._id);
  const manager = await svc.addMember(own, { phone: nextPhone(), name: 'Manager A', role: 'staff', branchIds: [A], permissions: ['staff.manage', 'bookings.view'] } as any);
  const staff = await svc.addMember(actorFor(manager), { phone: nextPhone(), name: 'Desk', role: 'staff', branchIds: [A], permissions: ['bookings.view'] } as any);
  const plain = await svc.addMember(own, { phone: nextPhone(), name: 'No perms', role: 'staff', permissions: [] } as any);

  await check('only owners (and admins as owner) change the partner profile', async () => {
    await assert.rejects(() => svc.updateOwnProfile(actorFor(plain), { name: 'Hijacked' }), code('OWNER_REQUIRED'));
    await assert.rejects(() => svc.updateOwnProfile(actorFor(manager), { contactEmail: 'x@y.z' }), code('OWNER_REQUIRED'));
    assert.equal((await svc.updateOwnProfile(own, { name: 'Alpha Labs Pvt' })).name, 'Alpha Labs Pvt');
  });

  await check('staff branch access: within the actor\'s own scope, never self, never an owner, never "all" from a restricted actor', async () => {
    const m = actorFor(manager);
    await assert.rejects(() => svc.updateMemberBranches(m, String(staff._id), [B]), code('BRANCH_SCOPE_EXCEEDED'));
    await assert.rejects(() => svc.updateMemberBranches(m, String(staff._id), []), code('BRANCH_SCOPE_EXCEEDED'));
    await assert.rejects(() => svc.updateMemberBranches(m, String(manager._id), [A]), code('SELF_SCOPE_CHANGE'));
    await assert.rejects(() => svc.updateMemberBranches(own, String(owner._id), [A]), code('OWNER_SCOPE_FIXED'));
    await assert.rejects(() => svc.updateMemberBranches(own, String(staff._id), [String(new Types.ObjectId())]));
    const moved = await svc.updateMemberBranches(own, String(staff._id), [B]);
    assert.deepEqual(moved.branchIds.map(String), [B]);
    await assert.rejects(() => svc.updateMemberBranches(m, String(staff._id), [A]), code('MEMBER_NOT_FOUND'), 'now outside the manager\'s view');
    assert.ok(await PartnerAuditEventModel.exists({ partnerId, action: 'member.branches', targetId: String(staff._id) }));
  });

  await check('a closed branch reopens (all-branch actors), listed only for branch managers', async () => {
    await svc.deactivateBranch(own, B);
    assert.ok(!(await svc.listBranches(own)).some((b) => String(b._id) === B));
    assert.ok((await svc.listBranches(own, true)).some((b) => String(b._id) === B));
    assert.ok(!(await svc.listBranches(actorFor(plain), true)).some((b) => String(b._id) === B), 'no branches.manage → no closed ones');
    await assert.rejects(() => svc.reactivateBranch(actorFor(manager), B), code('BRANCH_SCOPE_EXCEEDED'));
    assert.equal((await svc.reactivateBranch(own, B)).isActive, true);
    await assert.rejects(() => svc.reactivateBranch(own, B), code('BRANCH_ALREADY_ACTIVE'));
  });

  await check('a suspended partner is reinstated (audited); only from suspended', async () => {
    await assert.rejects(() => svc.reinstatePartner(partnerId, 'adm'), code('NOT_SUSPENDED'));
    await svc.suspendPartner(partnerId);
    const back = await svc.reinstatePartner(partnerId, String(new Types.ObjectId()));
    assert.deepEqual([back.verification.state, back.isActive], ['verified', true]);
    assert.ok(await PartnerAuditEventModel.exists({ partnerId, action: 'partner.reinstate', actorKind: 'admin' }));
  });

  await check('partner creation is exactly once per admin request key; the list is paged and searchable', async () => {
    const body = { kind: 'clinic', name: 'Beta Clinic', contactPhone: nextPhone(), invoiceSeriesPrefix: 'BC', firstOwner: { phone: nextPhone(), name: 'B' } } as any;
    const admin = String(new Types.ObjectId());
    const all = await Promise.all([1, 2, 3].map(() => svc.createPartner({ ...body, requestKey: 'create-key-0001', createdBy: admin })));
    assert.equal(new Set(all.map((x) => String(x.partner._id))).size, 1);
    assert.equal(await PartnerModel.countDocuments({ name: 'Beta Clinic' }), 1);
    assert.equal(await SettlementAccountModel.countDocuments({ ownerKind: 'partner', ownerId: String(all[0]!.partner._id) }), 1);
    await assert.rejects(() => svc.createPartner({ ...body, name: 'Other', requestKey: 'create-key-0001', createdBy: admin }), code('REQUEST_KEY_REUSED'));
    for (let i = 0; i < 5; i++) await svc.createPartner({ kind: 'lab', name: `Gamma ${i}`, contactPhone: nextPhone(), invoiceSeriesPrefix: 'G', firstOwner: { phone: nextPhone(), name: 'G' } } as any);
    const p1 = await svc.listPartners({ q: 'gamma', limit: 2 });
    assert.deepEqual([p1.total, p1.items.length, p1.totalPages], [5, 2, 3]);
    assert.equal((await svc.listPartners({ q: 'gamma', limit: 2, page: 3 })).items.length, 1);
  });

  // ── Review findings (Q8 round 1) ──
  await check('a branch-access change is re-admitted inside its transaction (a concurrent move out of scope is never undone)', async () => {
    const target = await svc.addMember(own, { phone: nextPhone(), name: 'Moving', role: 'staff', branchIds: [A], permissions: [] } as any);
    const stale = await MemberModel.findById(target._id).lean();
    await svc.updateMemberBranches(own, String(target._id), [B]); // the owner moves them to B
    // The manager's request read the member while still at A (outer check passes on the stale snapshot).
    const racing = Object.create(svc);
    racing.memberRepository = Object.assign(Object.create(Object.getPrototypeOf((svc as any).memberRepository)), (svc as any).memberRepository, { findById: async () => stale });
    await assert.rejects(() => racing.updateMemberBranches(actorFor(manager), String(target._id), [A]), code('MEMBER_NOT_FOUND'));
    assert.deepEqual((await MemberModel.findById(target._id).lean())!.branchIds.map(String), [B]);
  });

  await check('a keyed create retried with the same values in another field order is the same request', async () => {
    const admin = String(new Types.ObjectId());
    const a = await svc.createPartner({ kind: 'lab', name: 'Order Labs', contactPhone: '9700000001', invoiceSeriesPrefix: 'OL',
      firstOwner: { phone: '9700000002', name: 'O' }, requestKey: 'order-key-0001', createdBy: admin } as any);
    const b = await svc.createPartner({ firstOwner: { name: 'O', phone: '9700000002' }, invoiceSeriesPrefix: 'OL', contactPhone: '9700000001',
      name: 'Order Labs', kind: 'lab', requestKey: 'order-key-0001', createdBy: admin } as any);
    assert.equal(String(b.partner._id), String(a.partner._id));
    assert.equal(b.replayed, true);
  });

  await check('reopening a clinic branch or reinstating its partner brings the doctors\' generated slots back at once', async () => {
    const { partner: cp, owner: co } = await svc.createPartner({ kind: 'clinic', name: 'Reopen Clinic', contactPhone: nextPhone(), invoiceSeriesPrefix: 'RC',
      firstOwner: { phone: nextPhone(), name: 'C' } } as any);
    const cid = String(cp._id);
    await svc.verifyPartner(cid, 'admin');
    const cb = String((await svc.createBranch(actorFor(co), { ...branchIn('Clinic'), services: { homeCollection: false, inLab: false, inClinic: true } }))._id);
    const doc = new Types.ObjectId();
    await SpecialistModel.collection.insertOne({ _id: doc, name: 'Dr R', phone: nextPhone(), specialization: 'GP', isActive: true, isVerified: true } as never);
    await MemberModel.create({ partnerId: cid, phone: nextPhone(), name: 'Dr R', role: 'staff', permissions: [], branchIds: [], doctorId: String(doc), isActive: true });
    const every = Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [{ start: '10:00', end: '11:00', modes: ['in-person'], branchId: cb }]]));
    await saveTemplate(String(doc), { slotMinutes: 30, days: every as any });
    const open = () => SlotModel.countDocuments({ specialistId: String(doc), branchId: cb, isActive: true });
    const full = await open();
    assert.ok(full > 0);
    await svc.deactivateBranch(actorFor(co), cb);
    await expandDoctorSlots(String(doc), istDate(new Date()), 30);
    assert.equal(await open(), 0);
    await svc.reactivateBranch(actorFor(co), cb);
    assert.equal(await open(), full, 'branch reopened: slots back');
    await svc.suspendPartner(cid);
    await expandDoctorSlots(String(doc), istDate(new Date()), 30);
    assert.equal(await open(), 0);
    await svc.reinstatePartner(cid, String(new Types.ObjectId()));
    assert.equal(await open(), full, 'partner reinstated: slots back');
  });

  // ── HTTP ──
  Container.set(PharmacyService, new PharmacyService(new PharmacyRepository(), new UserRepository()));
  Container.set(BannerService, new BannerService(new BannerRepository()));
  const { configureRoutes } = await import('@/routes');
  const app = express();
  app.use(express.json());
  configureRoutes(app);
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const tok = (m: IMember) => jwt.sign({ _id: String(m._id), memberId: String(m._id), partnerId: String(m.partnerId), userType: 'partner' }, CONFIG.JWT_SECRET_KEY);
  const adminTok = jwt.sign({ _id: String(new Types.ObjectId()), userType: 'admin' }, CONFIG.JWT_SECRET_KEY);
  const call = async (method: string, p: string, token: string, body?: unknown) => {
    const r = await fetch(base + p, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: (await r.json().catch(() => ({}))) as any };
  };
  try {
    await check('HTTP: routes and guards', async () => {
      assert.equal((await call('PUT', '/api/v1/partner-workspace/me', tok(plain), { name: 'x' })).status, 403);
      assert.equal((await call('GET', '/api/v1/partner-workspace/branches', tok(plain))).status, 200, 'any member reads branches');
      assert.equal((await call('PUT', `/api/v1/partner-workspace/members/${staff._id}/branches`, tok(owner), { branchIds: [A] })).status, 200);
      assert.equal((await call('PUT', `/api/v1/partner-workspace/members/${staff._id}/branches`, tok(plain), { branchIds: [A] })).status, 403);
      await svc.deactivateBranch(own, B);
      assert.equal((await call('POST', `/api/v1/partner-workspace/branches/${B}/reactivate`, tok(owner))).status, 200);
      assert.equal((await call('GET', '/api/v1/partner-workspace/branches?includeInactive=true', tok(owner))).status, 200);
      const list = await call('GET', '/api/v1/partner-workspace/admin?q=gamma&limit=2', adminTok);
      assert.deepEqual([list.json.data.length, list.json.pagination.total], [2, 5]);
      const body = { kind: 'lab', name: 'Delta', contactPhone: nextPhone(), invoiceSeriesPrefix: 'D', firstOwner: { phone: nextPhone(), name: 'D' }, requestKey: 'http-create-01' };
      assert.equal((await call('POST', '/api/v1/partner-workspace/admin', adminTok, body)).status, 201);
      assert.equal((await call('POST', '/api/v1/partner-workspace/admin', adminTok, body)).status, 200);
      await svc.suspendPartner(partnerId);
      assert.equal((await call('POST', `/api/v1/partner-workspace/admin/${partnerId}/reinstate`, adminTok)).status, 200);
      assert.equal((await call('POST', `/api/v1/partner-workspace/admin/${partnerId}/reinstate`, tok(owner))).status, 403);
    });
  } finally { server.close(); }
  await mongoose.disconnect();
  removeFixtureDir();
  console.log(`\n${passed} checks passed`);
}
main().catch(async (e) => { console.error(e); await mongoose.disconnect(); try { removeFixtureDir(); } catch { /* gone */ } process.exit(1); });
