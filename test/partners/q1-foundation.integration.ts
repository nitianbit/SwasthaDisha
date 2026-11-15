/**
 * Q1: Partner foundation — partners, members, branches, delegation and branch ceilings, admin-as-owner, audit, legacy
 * directory compatibility; service-level and HTTP-level (real authenticate → guards → controllers) on a real MongoDB
 * replica set.
 *
 * Run (throwaway DB only; the script drops its collections):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/q1_partner_check?directConnection=true' JWT_SECRET_KEY=local-check-only \
 *     npx tsx --tsconfig tsconfig.json test/partners/q1-foundation.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { Container } from 'typedi';
import jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import { CONFIG } from '@/config/config';
import { authenticate, denyRoles } from '@/modules/middleware/auth';
import { errorHandler } from '@/modules/middleware';
import PartnerModel from '@/modules/partners/model';
import MemberModel from '@/modules/partners/model/member';
import BranchModel from '@/modules/partners/model/branch';
import PartnerAuditEventModel from '@/modules/partners/model/audit';
import { PartnerRepository } from '@/modules/partners/repository';
import { MemberRepository } from '@/modules/partners/repository/member';
import { BranchRepository } from '@/modules/partners/repository/branch';
import { PartnerService, PartnerActor, adminActor } from '@/modules/partners/services';
import { ALL_PERMISSIONS, IMember, PartnerPermission } from '@/modules/partners/types';
import partnerWorkspaceRouter from '@/modules/partners/routes';
import { PartnerService as DirectoryService } from '@/modules/partnerDirectory/services';
import { PartnerRepository as DirectoryRepository } from '@/modules/partnerDirectory/repository';
import LegacyDirectoryModel from '@/modules/partnerDirectory/model';
import UserModel from '@/modules/user/model';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/q1_partner_check?directConnection=true';
const url = process.env.MONGODB_URL ?? '';
if (url !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const partnerRepo = new PartnerRepository();
const memberRepo = new MemberRepository();
const branchRepo = new BranchRepository();
const svc = new PartnerService(partnerRepo, memberRepo, branchRepo);
// tsx emits no decorator metadata; production (tsc) resolves this through typedi.
Container.set(PartnerService, svc);
Container.set(DirectoryService, new DirectoryService(new DirectoryRepository()));

let passed = 0;
async function check(name: string, fn: () => Promise<void>) { await fn(); passed++; console.log('ok -', name); }
const code = (c: string) => (e: any) => e?.code === c;

function actorFor(m: IMember): PartnerActor {
  return { memberId: String(m._id), partnerId: String(m.partnerId), role: m.role, permissions: m.permissions as PartnerPermission[],
    branchIds: (m.branchIds ?? []).map(String) };
}
const branchInput = (name: string) => ({
  name,
  address: { line1: '1 Road', city: 'Bengaluru', state: 'Karnataka', stateCode: '29', pincode: '560001' },
  phone: '9876500000',
  hours: { mon: { open: '08:00', close: '20:00' } },
  holidays: [],
  services: { homeCollection: true, inLab: true, inClinic: false },
}) as any;

let phoneSeq = 6000000000;
const nextPhone = () => String(phoneSeq++);

async function main() {
  await mongoose.connect(url, { autoIndex: false });
  for (const c of await mongoose.connection.db!.collections()) await c.drop().catch(() => {});
  for (const M of [PartnerModel, MemberModel, BranchModel, PartnerAuditEventModel, LegacyDirectoryModel, UserModel] as mongoose.Model<any>[]) {
    await M.createCollection();
    await M.createIndexes();
  }

  // ── Partner lifecycle ──
  const { partner, owner } = await svc.createPartner({
    kind: 'lab', name: 'City Labs', contactPhone: '9876543210', invoiceSeriesPrefix: 'CL',
    firstOwner: { phone: '9876543210', name: 'Dr. Alpha' },
  });
  const partnerId = String(partner._id);
  const ownerActor = actorFor(owner);

  await check('createPartner: activeOwnerCount=1, owner holds every permission, stored in partner_orgs', async () => {
    assert.equal(partner.activeOwnerCount, 1);
    assert.equal(partner.verification.state, 'pending');
    assert.equal(owner.role, 'owner');
    assert.deepEqual(owner.permissions, [...ALL_PERMISSIONS]);
    assert.equal(PartnerModel.collection.collectionName, 'partner_orgs');
    assert.equal(MemberModel.collection.collectionName, 'partner_members');
    assert.equal(BranchModel.collection.collectionName, 'partner_branches');
  });

  await check('verify pending → verified; second verify 409', async () => {
    const p = await svc.verifyPartner(partnerId, 'admin123');
    assert.equal(p.verification.state, 'verified');
    await assert.rejects(() => svc.verifyPartner(partnerId, 'admin123'), (e: any) => e.status === 409);
  });

  await check('suspend sets suspended + inactive', async () => {
    const { partner: p2 } = await svc.createPartner({
      kind: 'clinic', name: 'Suspend Clinic', contactPhone: '1111111111', invoiceSeriesPrefix: 'ST',
      firstOwner: { phone: '1111111111', name: 'Owner S' },
    });
    const s = await svc.suspendPartner(String(p2._id));
    assert.equal(s.verification.state, 'suspended');
    assert.equal(s.isActive, false);
  });

  // ── Branches (owner) ──
  const branchA = await svc.createBranch(ownerActor, branchInput('Branch A'));
  const branchB = await svc.createBranch(ownerActor, branchInput('Branch B'));
  const A = String(branchA._id); const B = String(branchB._id);

  await check('owner branch CRUD', async () => {
    assert.equal((await svc.listBranches(ownerActor)).length, 2);
    const u = await svc.updateBranch(ownerActor, A, { name: 'Branch A1' } as any);
    assert.equal(u.name, 'Branch A1');
    const tmp = await svc.createBranch(ownerActor, branchInput('Temp'));
    await svc.deactivateBranch(ownerActor, String(tmp._id));
    assert.equal((await svc.listBranches(ownerActor)).length, 2);
  });

  // ── Members: delegation ceiling and owner-only gates ──
  const globalStaff = await svc.addMember(ownerActor, {
    phone: nextPhone(), name: 'Global Manager', role: 'staff', permissions: ['staff.manage', 'bookings.view'],
  });

  await check('staff invite respects the permission ceiling', async () => {
    await assert.rejects(() => svc.addMember(actorFor(globalStaff), {
      phone: nextPhone(), name: 'X', role: 'staff', permissions: ['finance.view'],
    }), code('DELEGATION_CEILING'));
  });

  await check('staff cannot add an owner', async () => {
    await assert.rejects(() => svc.addMember(actorFor(globalStaff), {
      phone: nextPhone(), name: 'X', role: 'owner', permissions: [],
    }), code('OWNER_REQUIRED'));
  });

  let owner2: IMember;
  await check('owner adds owner (CAS on activeOwnerCount)', async () => {
    owner2 = await svc.addMember(ownerActor, { phone: nextPhone(), name: 'Owner Beta', role: 'owner', permissions: [] });
    assert.equal(owner2.role, 'owner');
    assert.deepEqual(owner2.permissions, [...ALL_PERMISSIONS]);
    assert.equal((await partnerRepo.findById(partnerId))!.activeOwnerCount, 2);
  });

  await check('staff cannot remove an owner; owner can; last owner protected; no self removal', async () => {
    await assert.rejects(() => svc.removeMember(actorFor(globalStaff), String(owner2._id)), code('OWNER_REQUIRED'));
    await svc.removeMember(ownerActor, String(owner2._id));
    assert.equal((await partnerRepo.findById(partnerId))!.activeOwnerCount, 1);
    assert.equal((await memberRepo.findById(String(owner2._id)))!.isActive, false);
    await assert.rejects(() => svc.removeMember(ownerActor, String(owner._id)), code('CANNOT_REMOVE_SELF'));
    const solo = await svc.createPartner({
      kind: 'lab', name: 'Solo Lab', contactPhone: '5555555555', invoiceSeriesPrefix: 'SL',
      firstOwner: { phone: '5555555555', name: 'Sole Owner' },
    });
    await assert.rejects(() => svc.removeMember(adminActor('adm1', String(solo.partner._id)), String(solo.owner._id)), code('LAST_OWNER'));
  });

  await check('permission changes are owner-only; owner permissions fixed', async () => {
    await assert.rejects(() => svc.updateMemberPermissions(actorFor(globalStaff), String(globalStaff._id), ['bookings.view']), code('OWNER_REQUIRED'));
    const u = await svc.updateMemberPermissions(ownerActor, String(globalStaff._id), ['staff.manage', 'bookings.view', 'finance.view']);
    assert.deepEqual(u.permissions, ['staff.manage', 'bookings.view', 'finance.view']);
    await assert.rejects(() => svc.updateMemberPermissions(ownerActor, String(owner._id), ['bookings.view']), code('OWNER_PERMS_FIXED'));
  });

  await check('one active membership per phone and partner (service check and unique index)', async () => {
    await assert.rejects(() => svc.addMember(ownerActor, {
      phone: globalStaff.phone, name: 'Dupe', role: 'staff', permissions: [],
    }), code('MEMBER_ALREADY_EXISTS'));
    await assert.rejects(() => MemberModel.create({
      partnerId, phone: globalStaff.phone, name: 'Raw dupe', role: 'staff', permissions: [], branchIds: [], isActive: true,
    }), (e: any) => e?.code === 11000);
    // an inactive row for the same phone does not block
    await MemberModel.create({ partnerId, phone: globalStaff.phone, name: 'Old', role: 'staff', permissions: [], branchIds: [], isActive: false });
  });

  // ── Branch ceiling for a branch-restricted manager ──
  const managerA = await svc.addMember(ownerActor, {
    phone: nextPhone(), name: 'Manager A', role: 'staff', branchIds: [A],
    permissions: ['staff.manage', 'branches.manage', 'bookings.view'],
  });
  const staffB = await svc.addMember(ownerActor, {
    phone: nextPhone(), name: 'Staff B', role: 'staff', branchIds: [B], permissions: ['bookings.view'],
  });
  const mA = actorFor(managerA);

  await check('restricted manager cannot invite with omitted/empty scope (would be every branch)', async () => {
    await assert.rejects(() => svc.addMember(mA, { phone: nextPhone(), name: 'X', role: 'staff', permissions: ['bookings.view'] }),
      code('BRANCH_SCOPE_EXCEEDED'));
    await assert.rejects(() => svc.addMember(mA, { phone: nextPhone(), name: 'X', role: 'staff', permissions: ['bookings.view'], branchIds: [] }),
      code('BRANCH_SCOPE_EXCEEDED'));
  });

  await check('restricted manager cannot invite into a branch outside its scope', async () => {
    await assert.rejects(() => svc.addMember(mA, { phone: nextPhone(), name: 'X', role: 'staff', permissions: ['bookings.view'], branchIds: [B] }),
      code('BRANCH_SCOPE_EXCEEDED'));
    await assert.rejects(() => svc.addMember(mA, { phone: nextPhone(), name: 'X', role: 'staff', permissions: ['bookings.view'], branchIds: [A, B] }),
      code('BRANCH_SCOPE_EXCEEDED'));
  });

  let staffA: IMember;
  await check('restricted manager invites inside its scope', async () => {
    staffA = await svc.addMember(mA, { phone: nextPhone(), name: 'Staff A', role: 'staff', permissions: ['bookings.view'], branchIds: [A] });
    assert.deepEqual(staffA.branchIds.map(String), [A]);
  });

  await check('restricted manager sees only in-scope members (no owners, no global or branch-B staff)', async () => {
    const ids = (await svc.listMembers(mA)).map((m) => String(m._id)).sort();
    assert.deepEqual(ids, [String(managerA._id), String(staffA._id)].sort());
    await assert.rejects(() => svc.getMember(mA, String(staffB._id)), code('MEMBER_NOT_FOUND'));
    await assert.rejects(() => svc.getMember(mA, String(owner._id)), code('MEMBER_NOT_FOUND'));
    await assert.rejects(() => svc.getMember(mA, String(globalStaff._id)), code('MEMBER_NOT_FOUND'));
  });

  await check('restricted manager cannot deactivate out-of-scope staff; can deactivate in-scope staff', async () => {
    await assert.rejects(() => svc.removeMember(mA, String(staffB._id)), code('MEMBER_NOT_FOUND'));
    assert.equal((await memberRepo.findById(String(staffB._id)))!.isActive, true);
    await assert.rejects(() => svc.removeMember(mA, String(globalStaff._id)), code('MEMBER_NOT_FOUND'));
    await svc.removeMember(mA, String(staffA._id));
    assert.equal((await memberRepo.findById(String(staffA._id)))!.isActive, false);
  });

  await check('restricted manager branch operations are confined to its branches', async () => {
    assert.deepEqual((await svc.listBranches(mA)).map((b) => String(b._id)), [A]);
    await svc.getBranch(mA, A);
    await assert.rejects(() => svc.getBranch(mA, B), code('BRANCH_SCOPE_EXCEEDED'));
    await assert.rejects(() => svc.updateBranch(mA, B, { name: 'Hijack' } as any), code('BRANCH_SCOPE_EXCEEDED'));
    await assert.rejects(() => svc.deactivateBranch(mA, B), code('BRANCH_SCOPE_EXCEEDED'));
    await assert.rejects(() => svc.createBranch(mA, branchInput('New')), code('BRANCH_SCOPE_EXCEEDED'));
    assert.equal((await branchRepo.findById(B))!.name, 'Branch B');
  });

  // ── Admin acts as owner on any partner (even unverified) ──
  await check('admin manages an unverified partner with owner authority; audit names the admin', async () => {
    const { partner: p3 } = await svc.createPartner({
      kind: 'clinic', name: 'Admin Managed', contactPhone: '2222222222', invoiceSeriesPrefix: 'AM',
      firstOwner: { phone: '2222222222', name: 'Owner AM' },
    });
    const admin = adminActor('admin-42', String(p3._id));
    const br = await svc.createBranch(admin, branchInput('AM Main'));
    const o2 = await svc.addMember(admin, { phone: nextPhone(), name: 'Owner Two', role: 'owner', permissions: [] });
    const st = await svc.addMember(admin, { phone: nextPhone(), name: 'Desk', role: 'staff', permissions: ['bookings.view'], branchIds: [String(br._id)] });
    await svc.updateMemberPermissions(admin, String(st._id), ['bookings.view', 'bookings.manage']);
    await svc.removeMember(admin, String(o2._id));
    const audit = await PartnerAuditEventModel.find({ partnerId: String(p3._id) }).lean();
    assert.equal(audit.length, 5);
    assert.ok(audit.every((a) => a.actorKind === 'admin' && a.actorId === 'admin-42'));
    assert.deepEqual(audit.map((a) => a.action).sort(),
      ['branch.create', 'member.add', 'member.add', 'member.permissions', 'member.remove'].sort());
    const inv = await memberRepo.findById(String(st._id));
    assert.equal(inv!.invitedBy, 'admin:admin-42');
  });

  await check('member actions are audited with the member id', async () => {
    const own = await PartnerAuditEventModel.find({ partnerId, actorKind: 'member', action: 'member.remove', targetId: String(staffA._id) }).lean();
    assert.equal(own.length, 1);
    assert.equal(own[0]!.actorId, String(managerA._id));
  });

  await check('activity log: owners and all-branch staff only (it names grants on every branch)', async () => {
    await assert.rejects(() => svc.listAudit(mA), code('BRANCH_SCOPE_EXCEEDED'));
    const all = await svc.listAudit(ownerActor);
    assert.ok(all.some((a) => a.targetId === String(staffB._id)), 'the log does contain branch-B events');
    await svc.listAudit(actorFor(globalStaff));
  });

  await check('a failed audit write leaves no unaudited change (each mutation and its audit commit together)', async () => {
    const original = PartnerAuditEventModel.create.bind(PartnerAuditEventModel);
    const victim = await svc.addMember(ownerActor, { phone: nextPhone(), name: 'Audit victim', role: 'staff', permissions: ['bookings.view'] });
    const before = await partnerRepo.findById(partnerId);
    const membersBefore = await MemberModel.countDocuments({ partnerId });
    const branchesBefore = await BranchModel.countDocuments({ partnerId });
    const auditBefore = await PartnerAuditEventModel.countDocuments({ partnerId });
    (PartnerAuditEventModel as any).create = async () => { throw new Error('audit store down'); };
    try {
      await assert.rejects(() => svc.updateMemberPermissions(ownerActor, String(victim._id), ['bookings.view', 'finance.view']));
      await assert.rejects(() => svc.addMember(ownerActor, { phone: nextPhone(), name: 'Ghost', role: 'staff', permissions: [] }));
      await assert.rejects(() => svc.addMember(ownerActor, { phone: nextPhone(), name: 'Ghost owner', role: 'owner', permissions: [] }));
      await assert.rejects(() => svc.removeMember(ownerActor, String(victim._id)));
      await assert.rejects(() => svc.createBranch(ownerActor, branchInput('Ghost branch')));
      await assert.rejects(() => svc.updateBranch(ownerActor, A, { name: 'Ghost name' } as any));
      await assert.rejects(() => svc.deactivateBranch(ownerActor, B));
      await assert.rejects(() => svc.updateOwnProfile(ownerActor, { name: 'Ghost profile' }));
    } finally {
      (PartnerAuditEventModel as any).create = original;
    }
    const v = await memberRepo.findById(String(victim._id));
    assert.deepEqual(v!.permissions, ['bookings.view']);
    assert.equal(v!.isActive, true);
    assert.equal(await MemberModel.countDocuments({ partnerId }), membersBefore);
    assert.equal(await BranchModel.countDocuments({ partnerId }), branchesBefore);
    assert.equal((await branchRepo.findById(A))!.name, 'Branch A1');
    assert.equal((await branchRepo.findById(B))!.isActive, true);
    const after = await partnerRepo.findById(partnerId);
    assert.equal(after!.name, before!.name);
    assert.equal(after!.activeOwnerCount, before!.activeOwnerCount);
    assert.equal(await PartnerAuditEventModel.countDocuments({ partnerId }), auditBefore);
    await svc.updateMemberPermissions(ownerActor, String(victim._id), ['bookings.view', 'finance.view']);
    assert.equal(await PartnerAuditEventModel.countDocuments({ partnerId }), auditBefore + 1, 'one audit row per successful mutation');
  });

  await check('own-profile update cannot change tax identity', async () => {
    const before = await partnerRepo.findById(partnerId);
    await svc.updateOwnProfile(ownerActor, { name: 'City Diagnostics', taxRegime: 'regular', gstin: 'X', pan: 'Y' } as any);
    const after = await partnerRepo.findById(partnerId);
    assert.equal(after!.name, 'City Diagnostics');
    assert.equal(after!.taxRegime, before!.taxRegime);
    assert.equal(after!.gstin, before!.gstin);
  });

  // ── HTTP: real authenticate → guards → controllers ──
  // The directory controller resolves its service at import time, so import it after registration.
  const { default: partnerDirectoryRouter } = await import('@/modules/partnerDirectory/routes');
  const app = express();
  app.use(express.json());
  app.use('/api/v1/partners', authenticate, partnerDirectoryRouter);
  app.use('/api/v1/partner-workspace', authenticate, partnerWorkspaceRouter);
  app.use('/api/v1/customer-only', authenticate, denyRoles('partner'), (_req, res) => { res.json({ ok: true }); });
  app.use(errorHandler);
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const tokenFor = (m: IMember) => jwt.sign({ _id: String(m._id), memberId: String(m._id), partnerId: String(m.partnerId), phone: m.phone, userType: 'partner' }, CONFIG.JWT_SECRET_KEY);
  const adminToken = jwt.sign({ _id: new Types.ObjectId().toString(), userType: 'admin' }, CONFIG.JWT_SECRET_KEY);
  const customer = await UserModel.create({ phone: '9000000001', userType: 'user', createdSource: 'self_signup' } as any);
  const userToken = jwt.sign({ _id: String(customer._id), userType: 'user', authVersion: 0 }, CONFIG.JWT_SECRET_KEY);
  const call = async (method: string, path: string, token: string, body?: unknown) => {
    const r = await fetch(base + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, json: await r.json().catch(() => ({})) as any };
  };

  try {
    await check('HTTP: restricted manager inviting without scope gets 403 BRANCH_SCOPE_EXCEEDED; in-scope invite 201', async () => {
      const t = tokenFor(managerA);
      const bad = await call('POST', '/api/v1/partner-workspace/members', t, { phone: nextPhone(), name: 'Y', role: 'staff', permissions: ['bookings.view'] });
      assert.equal(bad.status, 403);
      assert.equal(bad.json.code ?? bad.json.error?.code, 'BRANCH_SCOPE_EXCEEDED');
      const good = await call('POST', '/api/v1/partner-workspace/members', t, { phone: nextPhone(), name: 'Y', role: 'staff', permissions: ['bookings.view'], branchIds: [A] });
      assert.equal(good.status, 201);
      const del = await call('DELETE', `/api/v1/partner-workspace/members/${staffB._id}`, t);
      assert.equal(del.status, 404);
    });

    await check('HTTP: admin acts on any partner via /admin/:partnerId/workspace; members/customers cannot', async () => {
      const add = await call('POST', `/api/v1/partner-workspace/admin/${partnerId}/workspace/members`, adminToken,
        { phone: nextPhone(), name: 'Owner via admin', role: 'owner', permissions: [] });
      assert.equal(add.status, 201);
      assert.equal(add.json.data.role, 'owner');
      const list = await call('GET', `/api/v1/partner-workspace/admin/${partnerId}/workspace/branches`, adminToken);
      assert.equal(list.status, 200);
      assert.equal(list.json.data.length, 2);
      assert.equal((await call('GET', `/api/v1/partner-workspace/admin/${partnerId}/workspace/members`, tokenFor(owner))).status, 403);
      assert.equal((await call('GET', `/api/v1/partner-workspace/admin/${partnerId}/workspace/members`, userToken)).status, 403);
      assert.equal((await call('GET', '/api/v1/partner-workspace/members', adminToken)).status, 403);
      assert.equal((await call('GET', `/api/v1/partner-workspace/admin/${new Types.ObjectId()}/workspace/members`, adminToken)).status, 404);
    });

    await check('HTTP: activity log refused to a branch-restricted manager, served to the owner', async () => {
      assert.equal((await call('GET', '/api/v1/partner-workspace/audit', tokenFor(managerA))).status, 403);
      const r = await call('GET', '/api/v1/partner-workspace/audit', tokenFor(owner));
      assert.equal(r.status, 200);
      assert.ok(r.json.data.length > 0);
    });

    await check('HTTP: a removed member is refused at authentication (401) on any route', async () => {
      const victim = await svc.addMember(ownerActor, { phone: nextPhone(), name: 'Soon gone', role: 'staff', permissions: ['bookings.view'] });
      const t = tokenFor(victim);
      assert.equal((await call('GET', '/api/v1/partner-workspace/me', t)).status, 200);
      await svc.removeMember(ownerActor, String(victim._id));
      const after = await call('GET', '/api/v1/partner-workspace/me', t);
      assert.equal(after.status, 401);
      assert.equal((await call('GET', '/api/v1/partners/verified', t)).status, 401);
    });

    await check('HTTP: partner tokens are refused on customer routes', async () => {
      assert.equal((await call('GET', '/api/v1/customer-only', tokenFor(owner))).status, 403);
      assert.equal((await call('GET', '/api/v1/customer-only', userToken)).status, 200);
    });

    await check('HTTP: legacy directory contract unchanged (root, /verified, /type/:t, /:id) on the partners collection', async () => {
      const legacy = await LegacyDirectoryModel.create({ name: 'Apollo Hospital', partnerType: 'hospital', city: 'Mumbai', isVerified: true, isActive: true });
      assert.equal(LegacyDirectoryModel.collection.collectionName, 'partners');
      const all = await call('GET', '/api/v1/partners', userToken);
      assert.equal(all.status, 200);
      assert.ok(JSON.stringify(all.json).includes('Apollo Hospital'));
      assert.ok(!JSON.stringify(all.json).includes('City Diagnostics'), 'operational partners do not leak into the directory');
      const verified = await call('GET', '/api/v1/partners/verified', userToken);
      assert.equal(verified.status, 200);
      assert.ok(JSON.stringify(verified.json).includes('Apollo Hospital'));
      const byType = await call('GET', '/api/v1/partners/type/hospital', userToken);
      assert.equal(byType.status, 200);
      assert.ok(JSON.stringify(byType.json).includes('Apollo Hospital'));
      const one = await call('GET', `/api/v1/partners/${legacy._id}`, userToken);
      assert.equal(one.status, 200);
      assert.equal(one.json.data.name, 'Apollo Hospital');
    });
  } finally {
    server.close();
  }

  await mongoose.disconnect();
  console.log(`\n${passed} checks passed`);
}

main().catch(async (e) => { console.error(e); await mongoose.disconnect(); process.exit(1); });
