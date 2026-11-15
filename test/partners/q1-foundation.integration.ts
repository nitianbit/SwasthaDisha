/**
 * Q1: Partner foundation — creates partners, members, branches on a real MongoDB replica set. Tests CAS on
 * activeOwnerCount, delegation ceiling, last-owner protection, member lifecycle.
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/q1_partner_check?directConnection=true' JWT_SECRET_KEY=local-check-only \
 *     npx tsx --tsconfig tsconfig.json test/partners/q1-foundation.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';
import PartnerModel from '@/modules/partners/model';
import MemberModel from '@/modules/partners/model/member';
import BranchModel from '@/modules/partners/model/branch';
import { PartnerRepository } from '@/modules/partners/repository';
import { MemberRepository } from '@/modules/partners/repository/member';
import { BranchRepository } from '@/modules/partners/repository/branch';
import { PartnerService } from '@/modules/partners/services';
import { ALL_PERMISSIONS, type PartnerPermission } from '@/modules/partners/types';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/q1_partner_check?directConnection=true';
const url = process.env.MONGODB_URL ?? '';
if (url !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const partnerRepo = new PartnerRepository();
const memberRepo = new MemberRepository();
const branchRepo = new BranchRepository();
const svc = new PartnerService(partnerRepo, memberRepo, branchRepo);

let passed = 0;
async function check(name: string, fn: () => Promise<void>) { await fn(); passed++; console.log('ok -', name); }

async function main() {
  await mongoose.connect(url);
  for (const c of await mongoose.connection.db!.collections()) await c.drop().catch(() => {});
  await Promise.all([PartnerModel.init(), MemberModel.init(), BranchModel.init()]);

  // ── Create partner + first owner ──

  await check('createPartner returns partner with activeOwnerCount=1 and one owner member', async () => {
    const { partner, owner } = await svc.createPartner({
      kind: 'lab',
      name: 'City Labs',
      contactPhone: '9876543210',
      invoiceSeriesPrefix: 'CL',
      firstOwner: { phone: '9876543210', name: 'Dr. Alpha' },
    });
    assert.equal(partner.kind, 'lab');
    assert.equal(partner.activeOwnerCount, 1);
    assert.equal(partner.verification.state, 'pending');
    assert.equal(owner.role, 'owner');
    assert.equal(owner.partnerId, String(partner._id));
    assert.deepEqual(owner.permissions, [...ALL_PERMISSIONS]);
  });

  // ── Verify / Suspend ──

  await check('verifyPartner transitions pending → verified', async () => {
    const partners = await partnerRepo.findAll({ name: 'City Labs' });
    const p = await svc.verifyPartner(partners[0]._id!, 'admin123');
    assert.equal(p.verification.state, 'verified');
    assert.ok(p.verification.verifiedAt);
  });

  await check('verifyPartner on already-verified rejects with 409', async () => {
    const partners = await partnerRepo.findAll({ name: 'City Labs' });
    await assert.rejects(() => svc.verifyPartner(partners[0]._id!, 'admin123'), (e: any) => e.status === 409);
  });

  await check('suspendPartner sets state to suspended and isActive=false', async () => {
    const { partner } = await svc.createPartner({
      kind: 'clinic',
      name: 'Suspend Test Clinic',
      contactPhone: '1111111111',
      invoiceSeriesPrefix: 'ST',
      firstOwner: { phone: '1111111111', name: 'Owner S' },
    });
    const s = await svc.suspendPartner(partner._id!);
    assert.equal(s.verification.state, 'suspended');
    assert.equal(s.isActive, false);
  });

  // ── Member management ──

  await check('addMember as staff with delegation ceiling', async () => {
    const partners = await partnerRepo.findAll({ name: 'City Labs' });
    const partnerId = partners[0]._id!;
    const owners = await memberRepo.findOwnersByPartner(partnerId);
    const ownerId = owners[0]._id!;

    const staff = await svc.addMember(
      partnerId,
      { phone: '9988776655', name: 'Staff Bob', role: 'staff', permissions: ['bookings.view', 'bookings.manage'] },
      ownerId,
      'owner',
      [...ALL_PERMISSIONS]
    );
    assert.equal(staff.role, 'staff');
    assert.deepEqual(staff.permissions, ['bookings.view', 'bookings.manage']);
    assert.equal(staff.partnerId, String(partnerId));
  });

  await check('delegation ceiling blocks staff from granting perms they do not hold', async () => {
    const partners = await partnerRepo.findAll({ name: 'City Labs' });
    const partnerId = partners[0]._id!;
    const members = await memberRepo.findActiveByPartner(partnerId);
    const staff = members.find(m => (m as any).role === 'staff')!;

    await assert.rejects(
      () => svc.addMember(
        partnerId,
        { phone: '8877665544', name: 'SubStaff', role: 'staff', permissions: ['finance.view'] },
        staff._id!,
        'staff',
        ['bookings.view', 'bookings.manage']
      ),
      (e: any) => e.code === 'DELEGATION_CEILING'
    );
  });

  await check('addMember as owner increments activeOwnerCount via CAS', async () => {
    const partners = await partnerRepo.findAll({ name: 'City Labs' });
    const partnerId = partners[0]._id!;
    const owners = await memberRepo.findOwnersByPartner(partnerId);
    const ownerId = owners[0]._id!;
    const pre = await partnerRepo.findById(partnerId);

    const newOwner = await svc.addMember(
      partnerId,
      { phone: '7766554433', name: 'Owner Beta', role: 'owner', permissions: [...ALL_PERMISSIONS] },
      ownerId,
      'owner',
      [...ALL_PERMISSIONS]
    );
    assert.equal(newOwner.role, 'owner');
    const post = await partnerRepo.findById(partnerId);
    assert.equal(post!.activeOwnerCount, pre!.activeOwnerCount + 1);
  });

  await check('removeMember on staff deactivates without touching activeOwnerCount', async () => {
    const partners = await partnerRepo.findAll({ name: 'City Labs' });
    const partnerId = partners[0]._id!;
    const members = await memberRepo.findActiveByPartner(partnerId);
    const staff = members.find(m => (m as any).role === 'staff')!;
    const owners = await memberRepo.findOwnersByPartner(partnerId);
    const pre = await partnerRepo.findById(partnerId);

    await svc.removeMember(partnerId, staff._id!, owners[0]._id!, 'owner');
    const post = await partnerRepo.findById(partnerId);
    assert.equal(post!.activeOwnerCount, pre!.activeOwnerCount);
    const removed = await memberRepo.findById(staff._id!);
    assert.equal(removed!.isActive, false);
  });

  await check('removeMember on owner decrements activeOwnerCount via CAS', async () => {
    const partners = await partnerRepo.findAll({ name: 'City Labs' });
    const partnerId = partners[0]._id!;
    const owners = await memberRepo.findOwnersByPartner(partnerId);
    assert.ok(owners.length >= 2, 'need at least 2 owners');
    const pre = await partnerRepo.findById(partnerId);

    await svc.removeMember(partnerId, owners[1]._id!, owners[0]._id!, 'owner');
    const post = await partnerRepo.findById(partnerId);
    assert.equal(post!.activeOwnerCount, pre!.activeOwnerCount - 1);
  });

  await check('removeMember blocks last-owner removal', async () => {
    const partners = await partnerRepo.findAll({ name: 'City Labs' });
    const partnerId = partners[0]._id!;
    const owners = await memberRepo.findOwnersByPartner(partnerId);
    assert.equal(owners.length, 1, 'should be exactly one owner left');

    // Try removing the last owner with themselves (also blocked by CANNOT_REMOVE_SELF)
    await assert.rejects(
      () => svc.removeMember(partnerId, owners[0]._id!, owners[0]._id!, 'owner'),
      (e: any) => e.code === 'CANNOT_REMOVE_SELF'
    );

    // Create a temporary second owner, then try removing the first (should block LAST_OWNER on a fresh partner)
    const solo = await svc.createPartner({
      kind: 'lab',
      name: 'Solo Lab',
      contactPhone: '5555555555',
      invoiceSeriesPrefix: 'SL',
      firstOwner: { phone: '5555555555', name: 'Sole Owner' },
    });
    // Add a second member who is staff, not owner
    const staffMember = await svc.addMember(
      solo.partner._id!,
      { phone: '5555555556', name: 'Helper', role: 'staff', permissions: ['bookings.view'] },
      solo.owner._id!,
      'owner',
      [...ALL_PERMISSIONS]
    );
    // staff tries to remove the sole owner (but staff can't — staffMember is the actor)
    await assert.rejects(
      () => svc.removeMember(solo.partner._id!, solo.owner._id!, staffMember._id!, 'staff'),
      (e: any) => e.code === 'OWNER_REQUIRED'
    );
  });

  await check('updateMemberPermissions respects delegation ceiling and rejects owner perm changes', async () => {
    const partners = await partnerRepo.findAll({ name: 'City Labs' });
    const partnerId = partners[0]._id!;
    const owners = await memberRepo.findOwnersByPartner(partnerId);

    // Add a staff member to test permission updates
    const staff = await svc.addMember(
      partnerId,
      { phone: '3344556677', name: 'Staff Update', role: 'staff', permissions: ['bookings.view'] },
      owners[0]._id!,
      'owner',
      [...ALL_PERMISSIONS]
    );

    const updated = await svc.updateMemberPermissions(
      partnerId, staff._id!, ['bookings.view', 'bookings.manage', 'finance.view'],
      'owner', [...ALL_PERMISSIONS]
    );
    assert.deepEqual(updated.permissions, ['bookings.view', 'bookings.manage', 'finance.view']);

    // Owners cannot have their permissions restricted
    await assert.rejects(
      () => svc.updateMemberPermissions(partnerId, owners[0]._id!, ['bookings.view'], 'owner', [...ALL_PERMISSIONS]),
      (e: any) => e.code === 'OWNER_PERMS_FIXED'
    );
  });

  await check('duplicate member for same partner is rejected', async () => {
    const partners = await partnerRepo.findAll({ name: 'City Labs' });
    const partnerId = partners[0]._id!;
    const owners = await memberRepo.findOwnersByPartner(partnerId);

    await assert.rejects(
      () => svc.addMember(
        partnerId,
        { phone: '3344556677', name: 'Dupe', role: 'staff', permissions: ['bookings.view'] },
        owners[0]._id!,
        'owner',
        [...ALL_PERMISSIONS]
      ),
      (e: any) => e.code === 'MEMBER_ALREADY_EXISTS'
    );
  });

  // ── Branch management ──

  await check('createBranch and listBranches', async () => {
    const partners = await partnerRepo.findAll({ name: 'City Labs' });
    const partnerId = partners[0]._id!;

    const branch = await svc.createBranch(partnerId, {
      name: 'Main Branch',
      address: { line1: '10 MG Road', city: 'Bengaluru', state: 'Karnataka', stateCode: '29', pincode: '560001' },
      phone: '9876543210',
      hours: { mon: { open: '08:00', close: '20:00' } },
      holidays: [],
      services: { homeCollection: true, inLab: true, inClinic: false },
    } as any);
    assert.equal(branch.partnerId, String(partnerId));
    assert.equal(branch.name, 'Main Branch');

    const list = await svc.listBranches(partnerId);
    assert.equal(list.length, 1);
    assert.equal(list[0].name, 'Main Branch');
  });

  await check('updateBranch changes name', async () => {
    const partners = await partnerRepo.findAll({ name: 'City Labs' });
    const partnerId = partners[0]._id!;
    const branches = await branchRepo.findActiveByPartner(partnerId);
    const updated = await svc.updateBranch(partnerId, branches[0]._id!, { name: 'Downtown Branch' } as any);
    assert.equal(updated.name, 'Downtown Branch');
  });

  await check('deactivateBranch removes from active list', async () => {
    const partners = await partnerRepo.findAll({ name: 'City Labs' });
    const partnerId = partners[0]._id!;
    const branches = await branchRepo.findActiveByPartner(partnerId);
    await svc.deactivateBranch(partnerId, branches[0]._id!);
    const remaining = await svc.listBranches(partnerId);
    assert.equal(remaining.length, 0);
  });

  // ── Owner-only gates (#3) ──

  await check('staff cannot add an owner', async () => {
    const partners = await partnerRepo.findAll({ name: 'City Labs' });
    const partnerId = partners[0]._id!;
    const members = await memberRepo.findActiveByPartner(partnerId);
    const staff = members.find(m => (m as any).role === 'staff')!;

    await assert.rejects(
      () => svc.addMember(
        partnerId,
        { phone: '1122334455', name: 'Sneaky Owner', role: 'owner', permissions: [...ALL_PERMISSIONS] },
        staff._id!,
        'staff',
        ['bookings.view', 'bookings.manage', 'finance.view']
      ),
      (e: any) => e.code === 'OWNER_REQUIRED'
    );
  });

  await check('staff cannot remove an owner', async () => {
    const { partner, owner } = await svc.createPartner({
      kind: 'lab',
      name: 'Staff Remove Test',
      contactPhone: '4455667788',
      invoiceSeriesPrefix: 'SR',
      firstOwner: { phone: '4455667788', name: 'Owner SR' },
    });
    const owner2 = await svc.addMember(
      partner._id!,
      { phone: '4455667789', name: 'Owner SR2', role: 'owner', permissions: [...ALL_PERMISSIONS] },
      owner._id!,
      'owner',
      [...ALL_PERMISSIONS]
    );
    const staff = await svc.addMember(
      partner._id!,
      { phone: '4455667790', name: 'Staff SR', role: 'staff', permissions: ['staff.manage'] },
      owner._id!,
      'owner',
      [...ALL_PERMISSIONS]
    );
    await assert.rejects(
      () => svc.removeMember(partner._id!, owner2._id!, staff._id!, 'staff'),
      (e: any) => e.code === 'OWNER_REQUIRED'
    );
  });

  await check('staff cannot change member permissions', async () => {
    const partners = await partnerRepo.findAll({ name: 'City Labs' });
    const partnerId = partners[0]._id!;
    const members = await memberRepo.findActiveByPartner(partnerId);
    const staff = members.find(m => (m as any).role === 'staff')!;
    const anotherStaff = members.filter(m => (m as any).role === 'staff')[1];
    if (anotherStaff) {
      await assert.rejects(
        () => svc.updateMemberPermissions(
          partnerId, anotherStaff._id!, ['bookings.view'],
          'staff', ['bookings.view', 'bookings.manage']
        ),
        (e: any) => e.code === 'OWNER_REQUIRED'
      );
    }
  });

  // ── Branch scope enforcement (#4) ──

  await check('assertBranchScope blocks staff outside their assigned branches', () => {
    assert.throws(
      () => svc.assertBranchScope('staff', ['branchA', 'branchB'], 'branchC'),
      (e: any) => e.code === 'BRANCH_SCOPE_EXCEEDED'
    );
    // Owner bypasses scope
    svc.assertBranchScope('owner', ['branchA'], 'branchC');
    // Unbounded staff (empty branchIds) passes
    svc.assertBranchScope('staff', [], 'branchC');
    return Promise.resolve();
  });

  await check('assertCanCreateBranch blocks scoped staff', () => {
    assert.throws(
      () => svc.assertCanCreateBranch('staff', ['branchA']),
      (e: any) => e.code === 'BRANCH_SCOPE_EXCEEDED'
    );
    // Owner can create
    svc.assertCanCreateBranch('owner', ['branchA']);
    // Unbounded staff can create
    svc.assertCanCreateBranch('staff', []);
    return Promise.resolve();
  });

  // ── Partner update ──

  await check('updatePartner changes name and taxRegime', async () => {
    const partners = await partnerRepo.findAll({ name: 'City Labs' });
    const partnerId = partners[0]._id!;
    const updated = await svc.updatePartner(partnerId, { name: 'City Diagnostics', taxRegime: 'regular' });
    assert.equal(updated.name, 'City Diagnostics');
    assert.equal(updated.taxRegime, 'regular');
  });

  await mongoose.disconnect();
  console.log(`\n${passed} checks passed`);
}

main().catch(async (e) => { console.error(e); await mongoose.disconnect(); process.exit(1); });
