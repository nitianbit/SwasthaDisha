/**
 * Partner members sign in by email as well as by phone: the member's optional `email` (lower-cased, unique among a
 * partner's active members, 409 EMAIL_IN_USE), set on add (staff.manage) and changed by an owner with the
 * expectedUpdatedAt fence; the email OTP send/verify for partners (exact lower-cased match, active members only, the
 * same multi-membership choice as by phone, no answer that the phone path does not already give); the doctor's email
 * copied onto clinic memberships only when free; and admin, doctor, pharmacy and customer email OTP end to end
 * (lookup, case normalisation, the email sender called). Real AuthService, partner services and MongoDB; only the SMS
 * and email senders are stubbed.
 *
 * Every check runs even when an earlier one fails (the run exits 1 if any failed).
 *
 * Run (throwaway DB only; the script drops its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/partner_email_otp_check?directConnection=true' JWT_SECRET_KEY=local-integration-only \
 *   SESSION_ORIGINS_CUSTOMER=https://app.jansetu.test SESSION_ORIGINS_WORKSPACE=https://staff.jansetu.test \
 *     npx tsx test/auth-sessions/partner-email-otp.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import { Container } from 'typedi';
import { CONFIG } from '@/config/config';
import { AuthService } from '@/modules/auth/services';
import { AdminRepository } from '@/modules/admin/repository';
import { HRRepository } from '@/modules/hr/repository';
import { UserRepository } from '@/modules/user/repository';
import { SpecialistRepository } from '@/modules/specialists/repository';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import { MemberRepository } from '@/modules/partners/repository/member';
import { PartnerRepository } from '@/modules/partners/repository';
import { BranchRepository } from '@/modules/partners/repository/branch';
import { NotificationRepository } from '@/modules/notification/repository';
import { NotificationService } from '@/modules/notification/services';
import { OTPRepository } from '@/modules/otp/repository';
import { OTPService } from '@/modules/otp/services';
import { OtpThrottleModel } from '@/modules/otp/model/throttle';
import AdminModel from '@/modules/admin/model';
import UserModel from '@/modules/user/model';
import SpecialistModel from '@/modules/specialists/model';
import PharmacyModel from '@/modules/pharmacies/model';
import MemberModel from '@/modules/partners/model/member';
import { PartnerSelectionTicketModel } from '@/modules/auth/model/partnerSelection';
import { AuthSessionModel } from '@/modules/auth/model/session';
import { UserService } from '@/modules/user/services';
import { CorporateRepository } from '@/modules/corporates/repository';
import { createNativeSession, refreshNativeSession } from '@/modules/auth/sessions';
import { PartnerService, PartnerActor, adminActor } from '@/modules/partners/services';
import * as clinic from '@/modules/partners/services/clinic';
import { addMemberSchema, createPartnerSchema, updateMemberEmailSchema } from '@/modules/partners/validation';
import { IMember, PartnerPermission } from '@/modules/partners/types';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/partner_email_otp_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const sms: { to: string; text: string }[] = [];
const mails: { to: string[]; textBody: string; subject: string }[] = [];
const smsService = { buildSMSContent: (_t: string, p: { otp: string }) => ({ text: 'OTP ' + p.otp }),
  sendSMS: async (m: { to: string; text: string }) => { sms.push(m); return { success: true, data: null }; } };
const emailService = { sendEmail: async (m: { to: string[]; textBody: string; subject: string }) => { mails.push(m); return { success: true }; } };
const users = new UserRepository();
const auth = new (AuthService as unknown as new (...a: unknown[]) => AuthService)(users, new AdminRepository(), new HRRepository(),
  new SpecialistRepository(), new PharmacyRepository(), {}, new OTPService(new OTPRepository()), { getByUserId: async () => ({}) },
  new NotificationService(new NotificationRepository(), users, {} as never), emailService, smsService, new MemberRepository());
const partners = new PartnerService(new PartnerRepository(), new MemberRepository(), new BranchRepository());
Container.set(PartnerService, partners);
clinic.setClinicNotifier(async () => undefined); // the doctor-link notice is not under test here

let passed = 0;
const failed: string[] = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log('ok -', name); }
  catch (e) { failed.push(name); console.log('FAIL -', name); console.error(e); }
}
const code = (c: string) => (e: any) => { if (e?.code !== c) throw e; return true; };
const actorFor = (m: IMember): PartnerActor => ({ memberId: String(m._id), partnerId: String(m.partnerId), role: m.role,
  permissions: m.permissions as PartnerPermission[], branchIds: (m.branchIds ?? []).map(String) });
let seq = 0;
const nextPhone = () => '96' + String(10_000_000 + ++seq).padStart(8, '0');
const ADMIN = new Types.ObjectId().toHexString();
const lastMailCode = () => /(\d{6})/.exec(mails[mails.length - 1]!.textBody)![1]!;
const decode = (t: string) => jwt.verify(t, CONFIG.JWT_SECRET_KEY) as Record<string, any>;
async function send(userType: string, body: Record<string, string>) {
  await OtpThrottleModel.deleteMany({});
  await auth.sendOTP({ userType, ...body } as never);
}
async function emailSignIn(userType: string, sendAs: string, verifyAs: string, extra: Record<string, string> = {}) {
  const smsN = sms.length;
  await send(userType, { email: sendAs, ...extra });
  assert.equal(sms.length, smsN, 'no SMS for an email sign-in');
  assert.deepEqual(mails[mails.length - 1]!.to, [sendAs.trim().toLowerCase()]);
  return auth.verifyOTP({ userType, email: verifyAs, otp: lastMailCode(), ...extra } as never);
}
const partnerOf = async (name: string, ownerEmail?: string) => {
  const { partner, owner } = await partners.createPartner({ kind: 'lab', name, contactPhone: nextPhone(), invoiceSeriesPrefix: 'PE',
    firstOwner: { phone: nextPhone(), name: 'Owner', ...(ownerEmail ? { email: ownerEmail } : {}) } } as any);
  await partners.verifyPartner(String(partner._id), ADMIN);
  return { partnerId: String(partner._id), owner };
};

async function main() {
  await mongoose.connect(FIXTURE_URL, { autoIndex: false });
  await mongoose.connection.dropDatabase();
  for (const name of mongoose.modelNames().sort()) { const M = mongoose.model(name); await M.createCollection(); await M.syncIndexes(); }

  const A = await partnerOf('Alpha Labs', '  Owner.Alpha@Example.COM ');
  const B = await partnerOf('Beta Labs');

  await check('admin partner creation takes an optional owner email (validated, stored lower-cased)', async () => {
    assert.equal(A.owner.email, 'owner.alpha@example.com');
    assert.equal(B.owner.email, undefined);
    const base = { kind: 'lab', name: 'X', contactPhone: '9000000000', invoiceSeriesPrefix: 'X', firstOwner: { phone: '9000000001', name: 'O' } };
    assert.ok(createPartnerSchema.validate({ ...base, firstOwner: { ...base.firstOwner, email: 'not-an-email' } }).error);
    assert.equal(createPartnerSchema.validate({ ...base, firstOwner: { ...base.firstOwner, email: 'A@B.CO' } }).value.firstOwner.email, 'a@b.co');
  });

  const ownerA = actorFor(A.owner);
  let staffA!: IMember;
  await check('staff add takes an email; a second active member of the partner with it is refused (409 EMAIL_IN_USE)', async () => {
    staffA = await partners.addMember(ownerA, { phone: nextPhone(), name: 'Desk', role: 'staff', email: 'Desk@Example.com',
      permissions: ['bookings.view', 'staff.manage'] } as any);
    assert.equal(staffA.email, 'desk@example.com');
    await assert.rejects(partners.addMember(ownerA, { phone: nextPhone(), name: 'Dup', role: 'staff', email: 'DESK@example.com', permissions: [] } as any),
      code('EMAIL_IN_USE'));
    await assert.rejects(partners.addMember(ownerA, { phone: nextPhone(), name: 'Dup owner', role: 'owner', email: 'owner.alpha@example.com', permissions: [] } as any),
      code('EMAIL_IN_USE'));
    // The same email at another partner is fine (one person, several workspaces).
    const other = await partners.addMember(actorFor(B.owner), { phone: nextPhone(), name: 'Desk at B', role: 'staff', email: 'desk@example.com', permissions: [] } as any);
    assert.equal(other.email, 'desk@example.com');
    assert.ok(addMemberSchema.validate({ phone: '9000000000', name: 'x', role: 'staff', permissions: [], email: 'bad@' }).error);
    assert.equal(addMemberSchema.validate({ phone: '9000000000', name: 'x', role: 'staff', permissions: [], email: ' Y@Z.IN ' }).value.email, 'y@z.in');
  });

  await check('only an owner (or an admin acting as owner) gives a new member a sign-in email (403 OWNER_REQUIRED otherwise)', async () => {
    const manager = actorFor(staffA); // staff with staff.manage
    await assert.rejects(partners.addMember(manager, { phone: nextPhone(), name: 'Mine', role: 'staff', email: 'manager.pick@example.com', permissions: [] } as any),
      code('OWNER_REQUIRED'));
    assert.equal(await MemberModel.countDocuments({ email: 'manager.pick@example.com' }), 0);
    const plain = await partners.addMember(manager, { phone: nextPhone(), name: 'No email', role: 'staff', permissions: [] } as any);
    assert.equal(plain.email, undefined);
    const byAdmin = await partners.addMember(adminActor(ADMIN, A.partnerId), { phone: nextPhone(), name: 'By admin', role: 'staff', email: 'by.admin@example.com',
      permissions: [] } as any);
    assert.equal(byAdmin.email, 'by.admin@example.com');
  });

  await check('a changed or removed sign-in email ends the member\'s web and app sessions; refreshed tokens carry the email', async () => {
    const m = await partners.addMember(ownerA, { phone: nextPhone(), name: 'Sessions', role: 'staff', email: 'sess@example.com', permissions: [] } as any);
    const claims = { _id: String(m._id), memberId: String(m._id), partnerId: A.partnerId, phone: m.phone, email: 'sess@example.com', userType: 'partner' };
    const app = await createNativeSession('native_workspace', claims);
    const req = (refreshToken: string) => ({ headers: { 'x-jansetu-native': '1', 'content-type': 'application/json' }, body: { app: 'workspace', refreshToken } }) as any;
    const refreshed = await refreshNativeSession(req(app.refreshToken));
    assert.equal(decode(refreshed.token).email, 'sess@example.com');
    await AuthSessionModel.create({ _id: 'web-' + String(m._id), audience: 'workspace', userType: 'partner', userId: String(m._id), authTime: new Date(),
      absoluteExpiresAt: new Date(Date.now() + 86_400_000), idleExpiresAt: new Date(Date.now() + 86_400_000), gen: 1, createdAt: new Date() } as any);
    // Unchanged email: nothing ends.
    await partners.updateMemberEmail(ownerA, String(m._id), 'SESS@example.com');
    assert.equal(await AuthSessionModel.countDocuments({ userId: String(m._id), revokedAt: { $exists: false } }), 2);
    await partners.updateMemberEmail(ownerA, String(m._id), 'sess.new@example.com');
    assert.equal(await AuthSessionModel.countDocuments({ userId: String(m._id), revokedAt: { $exists: false } }), 0);
    await assert.rejects(refreshNativeSession(req(refreshed.refreshToken)));
    const again = await createNativeSession('native_workspace', { ...claims, email: 'sess.new@example.com' });
    await partners.updateMemberEmail(ownerA, String(m._id), null);
    assert.equal((await AuthSessionModel.findOne({ userId: String(m._id), revokedAt: { $exists: false } }).lean()), null);
    await assert.rejects(refreshNativeSession(req(again.refreshToken)));
  });

  await check('a first sign-in email ends no session (they were opened by phone); a later change does', async () => {
    const m = await partners.addMember(ownerA, { phone: nextPhone(), name: 'First email', role: 'staff', permissions: [] } as any);
    await createNativeSession('native_workspace', { _id: String(m._id), memberId: String(m._id), partnerId: A.partnerId, phone: m.phone, userType: 'partner' });
    await partners.updateMemberEmail(ownerA, String(m._id), 'first.email@example.com');
    assert.equal(await AuthSessionModel.countDocuments({ userId: String(m._id), revokedAt: { $exists: false } }), 1);
    await partners.updateMemberEmail(ownerA, String(m._id), 'second.email@example.com');
    assert.equal(await AuthSessionModel.countDocuments({ userId: String(m._id), revokedAt: { $exists: false } }), 0);
  });

  await check('the email change and the session revocation are saved together (a failed revocation leaves the old email)', async () => {
    const m = await partners.addMember(ownerA, { phone: nextPhone(), name: 'Atomic', role: 'staff', email: 'atomic.old@example.com', permissions: [] } as any);
    await createNativeSession('native_workspace', { _id: String(m._id), memberId: String(m._id), partnerId: A.partnerId, phone: m.phone, email: 'atomic.old@example.com', userType: 'partner' });
    const coll = AuthSessionModel.collection.collectionName;
    // Every revocation write is refused by the database.
    await mongoose.connection.db.command({ collMod: coll, validator: { revokedAt: { $exists: false } }, validationLevel: 'strict', validationAction: 'error' });
    try {
      await assert.rejects(partners.updateMemberEmail(ownerA, String(m._id), 'atomic.new@example.com'));
    } finally {
      await mongoose.connection.db.command({ collMod: coll, validator: {}, validationLevel: 'off' });
    }
    assert.equal((await MemberModel.findById(m._id).lean() as any).email, 'atomic.old@example.com');
    assert.equal(await AuthSessionModel.countDocuments({ userId: String(m._id), revokedAt: { $exists: false } }), 1);
    // And with the database accepting it, both happen.
    await partners.updateMemberEmail(ownerA, String(m._id), 'atomic.new@example.com');
    assert.equal(await AuthSessionModel.countDocuments({ userId: String(m._id), revokedAt: { $exists: false } }), 0);
  });

  await check('only an owner (or an admin acting as owner) changes a member email, with the expectedUpdatedAt fence; null removes it', async () => {
    const staffActor = actorFor(staffA);
    await assert.rejects(partners.updateMemberEmail(staffActor, String(A.owner._id), 'mine@example.com'), code('OWNER_REQUIRED'));
    await assert.rejects(partners.updateMemberEmail(ownerA, String(staffA._id), 'owner.alpha@example.com'), code('EMAIL_IN_USE'));
    await assert.rejects(partners.updateMemberEmail(ownerA, String(staffA._id), 'new@example.com', new Date(0)), code('RECORD_CHANGED'));
    const cur = await MemberModel.findById(staffA._id).lean() as IMember;
    const changed = await partners.updateMemberEmail(ownerA, String(staffA._id), 'New.Desk@Example.com', cur.updatedAt);
    assert.equal(changed.email, 'new.desk@example.com');
    const removed = await partners.updateMemberEmail(adminActor(ADMIN, A.partnerId), String(staffA._id), null);
    assert.equal(removed.email, undefined);
    await partners.updateMemberEmail(adminActor(ADMIN, A.partnerId), String(staffA._id), 'desk@example.com');
    assert.equal(updateMemberEmailSchema.validate({ email: null }).error, undefined);
    assert.ok(updateMemberEmailSchema.validate({ email: 'nope' }).error);
    assert.ok(updateMemberEmailSchema.validate({}).error);
  });

  await check('partner OTP by email: sent by email to the lower-cased address, verified case-insensitively, token names the membership', async () => {
    const r = await emailSignIn('partner', 'OWNER.ALPHA@example.com', 'Owner.Alpha@Example.com');
    assert.ok(!r.selection);
    const claims = decode(r.accessToken);
    assert.deepEqual([claims.userType, claims.memberId, claims.partnerId, claims.email], ['partner', String(A.owner._id), A.partnerId, 'owner.alpha@example.com']);
    assert.match(mails[mails.length - 1]!.subject, /OTP/);
  });

  await check('partner OTP by email with several memberships: the code proves the email, then the person chooses (one-use ticket)', async () => {
    const r = await emailSignIn('partner', 'Desk@Example.com', 'desk@example.com');
    assert.ok(r.selection, 'selection expected');
    assert.deepEqual(r.selection!.choices.map((c) => c.partnerId).sort(), [A.partnerId, B.partnerId].sort());
    const ticketRow = await PartnerSelectionTicketModel.findOne({}).sort({ _id: -1 }).lean() as any;
    assert.deepEqual([ticketRow.email, ticketRow.phone], ['desk@example.com', undefined]);
    const chosen = await auth.selectPartner({ ticket: r.selection!.ticket, partnerId: B.partnerId });
    const claims = decode(chosen.accessToken);
    const memberB = await MemberModel.findOne({ partnerId: B.partnerId, email: 'desk@example.com', isActive: true }).lean() as any;
    assert.deepEqual([claims.partnerId, claims.memberId], [B.partnerId, String(memberB._id)]);
    await assert.rejects(auth.selectPartner({ ticket: r.selection!.ticket, partnerId: B.partnerId }), code('SELECTION_EXPIRED'));
    // With the partner named up front the code is bound to that membership and no choice is needed.
    const direct = await emailSignIn('partner', 'desk@example.com', 'desk@example.com', { partnerId: A.partnerId });
    assert.equal(decode(direct.accessToken).memberId, String(staffA._id));
  });

  await check('unknown email: the same answer as an unknown phone (404 PARTNER_MEMBER_NOT_FOUND), nothing sent', async () => {
    const n = mails.length + sms.length;
    const msg = 'No active partner membership found for this mobile number or email.';
    await assert.rejects(send('partner', { email: 'nobody@example.com' }), (e: any) => e.code === 'PARTNER_MEMBER_NOT_FOUND' && e.message === msg);
    await assert.rejects(send('partner', { phone: nextPhone() }), (e: any) => e.code === 'PARTNER_MEMBER_NOT_FOUND' && e.message === msg);
    assert.equal(mails.length + sms.length, n);
  });

  await check('a removed member cannot sign in by email; the email can then be given to someone else', async () => {
    const m = await partners.addMember(ownerA, { phone: nextPhone(), name: 'Temp', role: 'staff', email: 'temp@example.com', permissions: [] } as any);
    await partners.removeMember(ownerA, String(m._id));
    await assert.rejects(send('partner', { email: 'temp@example.com' }), code('PARTNER_MEMBER_NOT_FOUND'));
    const again = await partners.addMember(ownerA, { phone: nextPhone(), name: 'Next', role: 'staff', email: 'temp@example.com', permissions: [] } as any);
    assert.equal(again.email, 'temp@example.com');
  });

  await check('a code sent to an email does not verify for another email or a phone', async () => {
    await send('partner', { email: 'owner.alpha@example.com' });
    const otp = lastMailCode();
    await assert.rejects(auth.verifyOTP({ userType: 'partner', email: 'desk@example.com', otp } as never));
    await assert.rejects(auth.verifyOTP({ userType: 'partner', phone: A.owner.phone, otp } as never));
  });

  await check('clinic memberships never copy the doctor\'s profile email (sign-in by mobile; the owner can add an email)', async () => {
    const { partner: cp, owner: cOwner } = await partners.createPartner({ kind: 'clinic', name: 'Gamma Clinic', contactPhone: nextPhone(), invoiceSeriesPrefix: 'GC',
      firstOwner: { phone: nextPhone(), name: 'Owner', email: 'taken@example.com' } } as any);
    const cid = String(cp._id);
    await partners.verifyPartner(cid, ADMIN);
    const branch = await partners.createBranch(actorFor(cOwner), { name: 'Main', phone: nextPhone(), holidays: [], hours: {},
      services: { homeCollection: false, inLab: false, inClinic: true }, address: { line1: '1', city: 'Pune', state: 'MH', stateCode: '27', pincode: '411001' } } as any);
    const doctor = async (email: string) => String((await SpecialistModel.create({ name: 'Dr ' + email, phone: nextPhone(), email, isActive: true, isVerified: true }))._id);
    const free = await doctor('Free.Doc@Example.com');
    const taken = await doctor('taken@example.com');
    const l1 = await clinic.linkDoctor(adminActor(ADMIN, cid), { doctorId: free, branchIds: [String(branch._id)], requestKey: 'pe-link-0001' });
    const l2 = await clinic.linkDoctor(adminActor(ADMIN, cid), { doctorId: taken, branchIds: [String(branch._id)], requestKey: 'pe-link-0002' });
    assert.equal((await MemberModel.findById(l1.memberId).lean() as any).email, undefined);
    assert.equal((await MemberModel.findById(l2.memberId).lean() as any).email, undefined);
    await assert.rejects(send('partner', { email: 'free.doc@example.com' }), code('PARTNER_MEMBER_NOT_FOUND'));
    // The doctor-created clinic: the owner signs in by mobile, and as owner sets their own sign-in email.
    const solo = await doctor('solo@example.com');
    const r = await clinic.createSoloPractice(solo, { name: 'Solo Clinic', invoiceSeriesPrefix: 'SOLO', requestKey: 'pe-solo-0001',
      branch: { name: 'Main', phone: nextPhone(), address: { line1: '1', city: 'Pune', state: 'MH', stateCode: '27', pincode: '411001' } } });
    const soloOwner = await MemberModel.findOne({ partnerId: String(r.partner._id), role: 'owner' }).lean() as any;
    assert.equal(soloOwner.email, undefined);
    await partners.updateMemberEmail(actorFor(soloOwner), String(soloOwner._id), 'solo@example.com');
    const signIn = await emailSignIn('partner', 'SOLO@example.com', 'solo@example.com');
    assert.equal(decode(signIn.accessToken).partnerId, String(r.partner._id));
  });

  await check('admin, doctor, pharmacy and customer email OTP work end to end (case-insensitive, email sender called)', async () => {
    const admin = await AdminModel.create({ name: 'Admin', email: 'Admin.One@Example.com', userType: 'admin', isActive: true });
    assert.equal(admin.email, 'admin.one@example.com');
    const a = decode((await emailSignIn('admin', 'ADMIN.ONE@example.com', 'admin.one@EXAMPLE.com')).accessToken);
    assert.deepEqual([a.userType, a._id], ['admin', String(admin._id)]);

    const sp = await SpecialistModel.create({ name: 'Dr Mail', email: 'dr.mail@example.com', isActive: true, isVerified: true });
    const s = decode((await emailSignIn('specialist', 'Dr.Mail@Example.com', 'DR.MAIL@example.com')).accessToken);
    assert.deepEqual([s.userType, s.specialistId], ['specialist', String(sp._id)]);

    const ph = await PharmacyModel.create({ name: 'Mail Pharmacy', phone: nextPhone(), email: 'shop@example.com', isActive: true, isVerified: true });
    const p = decode((await emailSignIn('pharmacy', 'Shop@Example.com', 'SHOP@example.com')).accessToken);
    assert.deepEqual([p.userType, p.pharmacyId], ['pharmacy', String(ph._id)]);

    const u = await UserModel.create({ name: 'Mail Customer', email: 'cust@example.com', userType: 'user' });
    const c = decode((await emailSignIn('user', 'Cust@Example.com', 'CUST@example.com')).accessToken);
    assert.deepEqual([c.userType, c._id], ['user', String(u._id)]);
    assert.equal(await UserModel.countDocuments({ email: 'cust@example.com' }), 1, 'no second customer created');
  });

  await check('an email no account uses creates nothing for customers, doctors and pharmacies (404 EMAIL_NOT_REGISTERED); phone sign-up unchanged', async () => {
    const msg = 'No account uses this email. Sign in with your mobile number, then add this email to your profile.';
    const before = [await UserModel.countDocuments(), await SpecialistModel.countDocuments(), await PharmacyModel.countDocuments()];
    const sent = mails.length;
    for (const role of ['user', 'specialist', 'pharmacy']) {
      await assert.rejects(send(role, { email: `nobody.${role}@example.com` }), (e: any) => e.code === 'EMAIL_NOT_REGISTERED' && e.status === 404 && e.message === msg);
    }
    assert.deepEqual([await UserModel.countDocuments(), await SpecialistModel.countDocuments(), await PharmacyModel.countDocuments(), mails.length], [...before, sent]);
    // Phone sign-up still creates the account (customer) and the sign-up rows (doctor, pharmacy).
    const phone = nextPhone();
    for (const role of ['user', 'specialist', 'pharmacy']) await send(role, { phone });
    assert.deepEqual([await UserModel.countDocuments(), await SpecialistModel.countDocuments(), await PharmacyModel.countDocuments()], before.map((n) => n + 1));
  });

  await check('a phone sign-up with an email in the same request never stores that email; phone wins at verify', async () => {
    for (const role of ['specialist', 'pharmacy'] as const) {
      const phone = nextPhone();
      const victim = `victim.${role}@example.com`;
      await send(role, { phone, email: victim });
      assert.deepEqual(sms[sms.length - 1]!.to, phone);
      const M = (role === 'specialist' ? SpecialistModel : PharmacyModel) as mongoose.Model<any>;
      const row = await M.findOne({ phone }).lean() as any;
      assert.ok(row, 'sign-up row made by phone');
      assert.equal(row.email, undefined);
      assert.equal(await M.countDocuments({ email: victim }), 0);
      // The victim's address reaches nobody's account.
      await assert.rejects(send(role, { email: victim }), code('EMAIL_NOT_REGISTERED'));
      // Verify with both binds to the phone the code went to.
      const r = await auth.verifyOTP({ userType: role, phone, email: victim, otp: /(\d{6})/.exec(sms[sms.length - 1]!.text)![1]! } as never);
      assert.equal(decode(r.accessToken)[role === 'specialist' ? 'specialistId' : 'pharmacyId'], String(row._id));
    }
    // An existing account found by phone keeps its email; the other email in the request is written nowhere.
    const sp = await SpecialistModel.create({ name: 'Dr Has Mail', phone: nextPhone(), email: 'has.mail@example.com', isActive: true, isVerified: true });
    await send('specialist', { phone: sp.phone!, email: 'intruder@example.com' });
    assert.equal((await SpecialistModel.findById(sp._id).lean() as any).email, 'has.mail@example.com');
    for (const M of [SpecialistModel, PharmacyModel, UserModel, AdminModel, MemberModel] as mongoose.Model<any>[]) {
      assert.equal(await M.countDocuments({ email: 'intruder@example.com' }), 0);
    }
  });

  await check('a customer cannot put an unproven email on their profile (422 EMAIL_VERIFICATION_REQUIRED); admin edits unchanged', async () => {
    const users = new UserService(new UserRepository(), new CorporateRepository());
    const me = await UserModel.create({ phone: nextPhone(), userType: 'user', name: 'Squatter' });
    const id = String(me._id);
    const self = { _id: id, userType: 'user' };
    const msg = "Add your email from your profile; we'll send a code to confirm it.";
    for (const body of [{ email: 'victim.person@example.com' }, { name: 'X', email: 'Victim.Person@example.com' }, { corporateEmail: 'victim.person@example.com' }]) {
      await assert.rejects(users.update(id, body as never, self), (e: any) => e.code === 'EMAIL_VERIFICATION_REQUIRED' && e.status === 422 && e.message === msg);
    }
    const stored = await UserModel.findById(id).lean() as any;
    assert.deepEqual([stored.email, stored.corporateEmail, stored.name], [undefined, undefined, 'Squatter']);
    // The victim's address is still nobody's: their email sign-in is not taken over.
    await assert.rejects(send('user', { email: 'victim.person@example.com' }), code('EMAIL_NOT_REGISTERED'));
    // Absent, null or empty: other edits go through as before.
    assert.equal((await users.update(id, { name: 'Renamed', email: null } as never, self)).name, 'Renamed');
    // An admin may still set it (unverified), and the customer may then send the same value again (no-op).
    await users.update(id, { email: 'Admin.Set@example.com' } as never, { _id: new Types.ObjectId().toHexString(), userType: 'admin' });
    assert.equal((await UserModel.findById(id).lean() as any).email, 'admin.set@example.com');
    assert.equal((await users.update(id, { name: 'Again', email: 'ADMIN.SET@example.com' } as never, self)).name, 'Again');
  });

  await check('a customer cannot set or change their phone on the profile (422 PHONE_VERIFICATION_REQUIRED); admin edits unchanged', async () => {
    const users = new UserService(new UserRepository(), new CorporateRepository());
    const msg = "Your mobile number can't be changed here. Sign in with your mobile number to use it; contact support to change it.";
    const phone = nextPhone();
    const me = await UserModel.create({ phone, userType: 'user', name: 'Has Phone' });
    const id = String(me._id);
    const self = { _id: id, userType: 'user' };
    const other = nextPhone();
    await assert.rejects(users.update(id, { name: 'X', phone: other } as never, self),
      (e: any) => e.code === 'PHONE_VERIFICATION_REQUIRED' && e.status === 422 && e.message === msg);
    assert.deepEqual([(await UserModel.findById(id).lean() as any).phone, (await UserModel.findById(id).lean() as any).name], [phone, 'Has Phone']);
    // The stored number again (any supported spelling) is a no-op; absent, null and empty are ignored.
    assert.equal((await users.update(id, { name: 'Same', phone: `+91 ${phone}` } as never, self)).name, 'Same');
    assert.equal((await users.update(id, { name: 'Empty', phone: '' } as never, self)).name, 'Empty');
    assert.equal((await users.update(id, { name: 'Null', phone: null } as never, self)).name, 'Null');
    // A legacy email-only account cannot claim someone's phone here (support adds one).
    const legacy = await UserModel.create({ email: 'legacy.only@example.com', userType: 'user', name: 'Legacy' });
    await assert.rejects(users.update(String(legacy._id), { phone: other } as never, { _id: String(legacy._id), userType: 'user' }), code('PHONE_VERIFICATION_REQUIRED'));
    assert.equal((await UserModel.findById(legacy._id).lean() as any).phone, undefined);
    assert.equal(await UserModel.countDocuments({ phone: other }), 0);
    // An admin still sets it.
    await users.update(String(legacy._id), { phone: other } as never, { _id: new Types.ObjectId().toHexString(), userType: 'admin' });
    assert.equal((await UserModel.findById(legacy._id).lean() as any).phone, other);
  });

  await check('a customer adds an email from their profile (verification), then signs in by it to the same account', async () => {
    const phone = nextPhone();
    await send('user', { phone });
    const first = await auth.verifyOTP({ userType: 'user', phone, otp: /(\d{6})/.exec(sms[sms.length - 1]!.text)![1]! } as never);
    const userId = String(decode(first.accessToken)._id);
    await OtpThrottleModel.deleteMany({});
    await auth.sendEmailVerificationOTP(userId, { email: 'Added.Later@Example.com' } as never);
    assert.deepEqual(mails[mails.length - 1]!.to, ['added.later@example.com']);
    await auth.verifyEmailVerificationOTP(userId, { email: 'added.later@example.com', otp: lastMailCode() } as never);
    assert.equal((await UserModel.findById(userId).lean() as any).email, 'added.later@example.com');
    const r = await emailSignIn('user', 'ADDED.LATER@example.com', 'added.later@example.com');
    assert.equal(decode(r.accessToken)._id, userId);
    assert.equal(await UserModel.countDocuments({ $or: [{ phone }, { email: 'added.later@example.com' }] }), 1);
  });

  console.log(`\n${passed} checks passed${failed.length ? `, ${failed.length} FAILED: ${failed.join(' | ')}` : ''}`);
  if (failed.length) throw new Error(`${failed.length} checks failed`);
}

main().then(() => mongoose.disconnect()).catch(async (e) => { console.error(e?.message ?? e); await mongoose.disconnect(); process.exit(1); });
