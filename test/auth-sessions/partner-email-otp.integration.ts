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
    await assert.rejects(send('partner', { email: 'nobody@example.com' }), code('PARTNER_MEMBER_NOT_FOUND'));
    await assert.rejects(send('partner', { phone: nextPhone() }), code('PARTNER_MEMBER_NOT_FOUND'));
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

  await check('clinic memberships copy the doctor email only when it is free in that clinic', async () => {
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
    assert.equal((await MemberModel.findById(l1.memberId).lean() as any).email, 'free.doc@example.com');
    assert.equal((await MemberModel.findById(l2.memberId).lean() as any).email, undefined);
    // The doctor-created clinic: the doctor's email is the owner's second sign-in.
    const solo = await doctor('solo@example.com');
    const r = await clinic.createSoloPractice(solo, { name: 'Solo Clinic', invoiceSeriesPrefix: 'SOLO', requestKey: 'pe-solo-0001',
      branch: { name: 'Main', phone: nextPhone(), address: { line1: '1', city: 'Pune', state: 'MH', stateCode: '27', pincode: '411001' } } });
    const soloOwner = await MemberModel.findOne({ partnerId: String(r.partner._id), role: 'owner' }).lean() as any;
    assert.equal(soloOwner.email, 'solo@example.com');
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

    // An unknown pharmacy email: sign-up needs the mobile number (it used to fail with a 500); nothing is created or sent.
    const before = await PharmacyModel.countDocuments();
    const sent = mails.length;
    await assert.rejects(send('pharmacy', { email: 'unknown.shop@example.com' }), code('PHARMACY_PHONE_REQUIRED'));
    assert.deepEqual([await PharmacyModel.countDocuments(), mails.length], [before, sent]);

    const u = await UserModel.create({ name: 'Mail Customer', email: 'cust@example.com', userType: 'user' });
    const c = decode((await emailSignIn('user', 'Cust@Example.com', 'CUST@example.com')).accessToken);
    assert.deepEqual([c.userType, c._id], ['user', String(u._id)]);
    assert.equal(await UserModel.countDocuments({ email: 'cust@example.com' }), 1, 'no second customer created');
  });

  console.log(`\n${passed} checks passed${failed.length ? `, ${failed.length} FAILED: ${failed.join(' | ')}` : ''}`);
  if (failed.length) throw new Error(`${failed.length} checks failed`);
}

main().then(() => mongoose.disconnect()).catch(async (e) => { console.error(e?.message ?? e); await mongoose.disconnect(); process.exit(1); });
