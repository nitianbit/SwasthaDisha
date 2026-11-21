/**
 * Demo-account seeder (src1/scripts/seedDemoAccounts.ts) against a real MongoDB replica set, with the repository's
 * demo-accounts.example.json: every account and link exists with the right role, a second run creates nothing, a dry run
 * writes nothing, it refuses without SEED_DEMO_ALLOWED (and the example file with --commit), refuses a phone and an email
 * of two different accounts, stops when an index is missing, never prints a full phone or email, and every seeded
 * account is found by the real OTP sign-in (AuthService.sendOTP + verifyOTP) by phone AND by email. Only the SMS and
 * email senders are stubbed.
 *
 * Every check runs even when an earlier one fails (the run exits 1 if any failed).
 *
 * Run (throwaway DB only; the script drops its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/seed_demo_accounts_check?directConnection=true' JWT_SECRET_KEY=local-integration-only \
 *   SESSION_ORIGINS_CUSTOMER=https://app.jansetu.test SESSION_ORIGINS_WORKSPACE=https://staff.jansetu.test \
 *     npx tsx test/scripts/seed-demo-accounts.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { cli, runSeed, maskPhone, maskEmail, targetRefusal, DemoInput, SeedReport } from '../../src1/scripts/seedDemoAccounts';
import { saveTemplate as saveDoctorSchedule } from '@/modules/doctors/services/schedule';
import { AuthService } from '@/modules/auth/services';
import { AdminRepository } from '@/modules/admin/repository';
import { HRRepository } from '@/modules/hr/repository';
import { UserRepository } from '@/modules/user/repository';
import { SpecialistRepository } from '@/modules/specialists/repository';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import { MemberRepository } from '@/modules/partners/repository/member';
import { NotificationRepository } from '@/modules/notification/repository';
import { NotificationService } from '@/modules/notification/services';
import { OTPRepository } from '@/modules/otp/repository';
import { OTPService } from '@/modules/otp/services';
import { OtpThrottleModel } from '@/modules/otp/model/throttle';
import AdminModel from '@/modules/admin/model';
import UserModel from '@/modules/user/model';
import SpecialistModel from '@/modules/specialists/model';
import PharmacyModel from '@/modules/pharmacies/model';
import DependentModel from '@/modules/dependents/model';
import PartnerModel from '@/modules/partners/model';
import MemberModel from '@/modules/partners/model/member';
import BranchModel from '@/modules/partners/model/branch';
import CatalogueItemModel from '@/modules/partners/model/catalogueItem';
import PartnerAuditEventModel from '@/modules/partners/model/audit';
import { ClinicDoctorInviteModel } from '@/modules/partners/model/clinicDoctor';
import { SettlementAccountModel } from '@/modules/partners/model/settlement';
import { PartnerSlotTemplateModel, PartnerSlotModel } from '@/modules/partners/model/slot';
import { DoctorScheduleTemplateModel } from '@/modules/doctors/model/schedule';
import SlotModel from '@/modules/slots/model';
import { clinicBranchAllowed } from '@/modules/doctors/services/schedule';
import { CONFIG } from '@/config/config';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/seed_demo_accounts_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const sms: { to: string; text: string }[] = [];
const mails: { to: string[]; textBody: string }[] = [];
const smsService = { buildSMSContent: (_t: string, p: { otp: string }) => ({ text: 'OTP ' + p.otp }),
  sendSMS: async (m: { to: string; text: string }) => { sms.push(m); return { success: true, data: null }; } };
const emailService = { sendEmail: async (m: { to: string[]; textBody: string }) => { mails.push(m); return { success: true }; } };
const users = new UserRepository();
const auth = new (AuthService as unknown as new (...a: unknown[]) => AuthService)(users, new AdminRepository(), new HRRepository(),
  new SpecialistRepository(), new PharmacyRepository(), {}, new OTPService(new OTPRepository()), { getByUserId: async () => ({}) },
  new NotificationService(new NotificationRepository(), users, {} as never), emailService, smsService, new MemberRepository());

let passed = 0;
const failed: string[] = [];
async function check(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed++; console.log('ok -', name); }
  catch (e) { failed.push(name); console.log('FAIL -', name); console.error(e); }
}

const example = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'demo-accounts.example.json'), 'utf8'));
const input: DemoInput = (() => { const { _example: _x, ...rest } = example; return rest as DemoInput; })();
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'seed-demo-'));
const inputFile = path.join(dir, 'demo-accounts.json');
fs.writeFileSync(inputFile, JSON.stringify(input));
const exampleFile = path.join(__dirname, '..', '..', 'demo-accounts.example.json');
const DB = 'seed_demo_accounts_check';
const HOST = '127.0.0.1:27917';
// Q16b: the positive stage marker (created once by an operator on the stage database; inserted by this test below).
const STAGE_MARKER = 'q16b-test-stage-marker-0123456789';
const ALLOWED = { SEED_DEMO_ALLOWED: 'true', SEED_DEMO_HOST: HOST, SEED_DEMO_DATABASE: DB, SEED_DEMO_STAGE_MARKER: STAGE_MARKER, NODE_ENV: 'production' } as NodeJS.ProcessEnv;
const clone = () => JSON.parse(JSON.stringify(input)) as DemoInput;

async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const c of await mongoose.connection.db.collections()) {
    if (['otps', 'otpthrottles', 'notifications', 'wallets'].includes(c.collectionName)) continue; // sign-in side effects
    if (c.collectionName === 'stage_marker') continue; // Q16b: the operator's one-time marker, not seeded data
    out[c.collectionName] = await c.countDocuments();
  }
  return out;
}
const total = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);

/** Every raw phone and email of the input (none may ever be printed). */
function secrets(i: DemoInput): string[] {
  const out = new Set<string>();
  JSON.stringify(i, (_k, v) => { if (typeof v === 'string' && (/^\d{10}$/.test(v) || /@/.test(v))) out.add(v); return v; });
  return [...out];
}

type Role = 'admin' | 'user' | 'specialist' | 'pharmacy' | 'partner';
/** The real sign-in: send a code (by phone or email), read it from the stubbed sender, verify it. */
async function signIn(userType: Role, contact: { phone?: string; email?: string }) {
  await OtpThrottleModel.deleteMany({});
  const before = { s: await SpecialistModel.countDocuments(), p: await PharmacyModel.countDocuments(), u: await UserModel.countDocuments() };
  const smsN = sms.length;
  const mailN = mails.length;
  await auth.sendOTP({ userType, ...contact } as never);
  // No sign-up row was made: the seeded account was found.
  assert.deepEqual({ s: await SpecialistModel.countDocuments(), p: await PharmacyModel.countDocuments(), u: await UserModel.countDocuments() }, before);
  let code: string;
  if (contact.phone) {
    assert.equal(sms.length, smsN + 1);
    assert.equal(sms[sms.length - 1]!.to, contact.phone);
    code = /(\d{6})/.exec(sms[sms.length - 1]!.text)![1]!;
  } else {
    assert.equal(mails.length, mailN + 1);
    assert.deepEqual(mails[mails.length - 1]!.to, [contact.email!.toLowerCase()]);
    code = /(\d{6})/.exec(mails[mails.length - 1]!.textBody)![1]!;
  }
  const r = await auth.verifyOTP({ userType, ...contact, otp: code } as never);
  assert.ok(!r.selection, 'no workspace choice expected');
  return { claims: jwt.verify(r.accessToken, CONFIG.JWT_SECRET_KEY) as Record<string, any>, user: r.userData };
}

/** A code request to an unknown phone (the sign-up placeholder AuthService.sendOTP creates). */
async function signUpPlaceholder(userType: 'specialist' | 'pharmacy' | 'user', phone: string) {
  await OtpThrottleModel.deleteMany({});
  await auth.sendOTP({ userType, phone } as never);
}

async function main() {
  await mongoose.connect(FIXTURE_URL, { autoCreate: false, autoIndex: false });
  await mongoose.connection.dropDatabase();
  // What `npm run sync-indexes` does on the server, for every model loaded.
  for (const name of mongoose.modelNames().sort()) {
    const M = mongoose.model(name);
    await M.createCollection();
    await M.syncIndexes();
  }

  await check('refuses without SEED_DEMO_ALLOWED (nothing read or written)', async () => {
    const out: string[] = [];
    const r = await cli([inputFile, '--commit'], { NODE_ENV: 'production' } as NodeJS.ProcessEnv, (l) => out.push(l));
    assert.equal(r.code, 2);
    assert.match(out.join('\n'), /REFUSED: set SEED_DEMO_ALLOWED=true/);
    assert.equal((await cli([inputFile, '--commit'], { SEED_DEMO_ALLOWED: '1' } as NodeJS.ProcessEnv, () => {})).code, 2);
    assert.equal(total(await counts()), 0);
  });

  await check('refuses to commit the example file itself', async () => {
    const out: string[] = [];
    assert.equal((await cli([exampleFile, '--commit'], ALLOWED, (l) => out.push(l))).code, 2);
    assert.match(out.join('\n'), /this is the example file/);
    assert.equal(total(await counts()), 0);
  });

  await check('production guard: SEED_DEMO_HOST and SEED_DEMO_DATABASE must name the connected server (dry run included); "prod" refused', async () => {
    const cases: [Record<string, string>, RegExp][] = [
      [{ SEED_DEMO_ALLOWED: 'true' }, /REFUSED: set SEED_DEMO_HOST=127\.0\.0\.1:27917/],
      [{ SEED_DEMO_ALLOWED: 'true', SEED_DEMO_HOST: 'stage.example.com:27017', SEED_DEMO_DATABASE: DB }, /REFUSED: set SEED_DEMO_HOST=127\.0\.0\.1:27917/],
      [{ SEED_DEMO_ALLOWED: 'true', SEED_DEMO_HOST: HOST }, /REFUSED: set SEED_DEMO_DATABASE=seed_demo_accounts_check/],
      [{ SEED_DEMO_ALLOWED: 'true', SEED_DEMO_HOST: HOST, SEED_DEMO_DATABASE: 'other_db' }, /REFUSED: set SEED_DEMO_DATABASE=seed_demo_accounts_check/],
    ];
    for (const [env, refused] of cases) {
      for (const argv of [[inputFile], [inputFile, '--commit']]) {
        const out: string[] = [];
        const r = await cli(argv, env as NodeJS.ProcessEnv, (l) => out.push(l));
        assert.equal(r.code, 2);
        assert.match(out.join('\n'), /^Target: host 127\.0\.0\.1:27917 +database seed_demo_accounts_check/);
        assert.match(out.join('\n'), refused);
      }
    }
    assert.equal(total(await counts()), 0);
    const env = (db: string, host = HOST) => ({ SEED_DEMO_DATABASE: db, SEED_DEMO_HOST: host }) as NodeJS.ProcessEnv;
    assert.match(targetRefusal(env('jansetu_PROD'), 'jansetu_PROD', '127.0.0.1', 27917)!, /looks like production/);
    assert.match(targetRefusal(env('prodcopy'), 'prodcopy', '127.0.0.1', 27917)!, /looks like production/);
    assert.equal(targetRefusal(env(DB), DB, '127.0.0.1', 27917), null);
    assert.equal(targetRefusal(env(DB, '127.0.0.1'), DB, '127.0.0.1', 27917), null);
    assert.match(targetRefusal(env(DB, '127.0.0.1:27018'), DB, '127.0.0.1', 27917)!, /SEED_DEMO_HOST/);
  });

  await check('Q16b stage marker: without the database marker, or with another value, every run is refused (dry run included)', async () => {
    const run = async (env: NodeJS.ProcessEnv) => {
      const out: string[] = [];
      const results = [await cli([inputFile], env, (l) => out.push(l)), await cli([inputFile, '--commit'], env, (l) => out.push(l))];
      return { codes: results.map((r) => r.code), out: out.join('\n') };
    };
    let r = await run(ALLOWED);
    assert.deepEqual(r.codes, [2, 2]);
    assert.match(r.out, /REFUSED: this database has no single stage marker/);
    assert.match(r.out, /db\.stage_marker\.insertOne\(\{ environment: "stage", marker: /);
    await mongoose.connection.db.collection('stage_marker').insertOne({ environment: 'stage', marker: STAGE_MARKER, createdAt: new Date() });
    r = await run({ ...ALLOWED, SEED_DEMO_STAGE_MARKER: 'q16b-wrong-marker-value-000000' });
    assert.deepEqual(r.codes, [2, 2]);
    assert.match(r.out, /SEED_DEMO_STAGE_MARKER does not match/);
    r = await run({ ...ALLOWED, SEED_DEMO_STAGE_MARKER: '' });
    assert.deepEqual(r.codes, [2, 2]);
    assert.match(r.out, /set SEED_DEMO_STAGE_MARKER/);
    // A second marker document (ambiguous) is refused as well.
    const extra = await mongoose.connection.db.collection('stage_marker').insertOne({ environment: 'stage', marker: STAGE_MARKER });
    assert.deepEqual((await run(ALLOWED)).codes, [2, 2]);
    await mongoose.connection.db.collection('stage_marker').deleteOne({ _id: extra.insertedId });
    assert.equal(total(await counts()), 0);
  });

  const allOutput: string[] = [];
  await check('dry run prints the plan and the database name, and writes nothing', async () => {
    const out: string[] = [];
    const r = await cli([inputFile], ALLOWED, (l) => out.push(l));
    allOutput.push(...out);
    assert.equal(r.code, 0);
    assert.match(out[0]!, /^Target: host 127\.0\.0\.1:27917 +database seed_demo_accounts_check .*DRY RUN/);
    assert.equal(out.join('\n').includes('mongodb://'), false);
    assert.equal(r.report!.counts.created, 0);
    assert.ok(r.report!.counts['would create'] > 20);
    assert.equal(total(await counts()), 0);
    assert.ok(r.report!.accounts.every((a) => a.status === 'would create'));
  });

  let first: SeedReport | undefined;
  await check('commit creates every account and link', async () => {
    const out: string[] = [];
    const r = await cli([inputFile, '--commit'], ALLOWED, (l) => out.push(l));
    allOutput.push(...out);
    assert.equal(r.code, 0, out.join('\n'));
    first = r.report!;
    assert.ok(first.counts.created >= 25);
    assert.deepEqual(first.warnings, []);

    const admin = await AdminModel.findOne({ phone: input.admin!.phone }).lean() as any;
    assert.deepEqual([admin.userType, admin.isActive, admin.email], ['admin', true, input.admin!.email]);

    const [asha, imran, lata] = input.customers!;
    const a = await UserModel.findOne({ phone: asha!.phone, userType: 'user' }).lean() as any;
    assert.deepEqual([a.name, a.email, a.createdSource, a.otpVerified], [asha!.name, asha!.email, 'self_signup', false]);
    const fam = await DependentModel.find({ userId: String(a._id), isActive: true }).sort({ name: 1 }).lean() as any[];
    assert.deepEqual(fam.map((f) => [f.name, f.relationship, f.dateOfBirth]), [['Meera Demo', 'Daughter', '20150620'], ['Ravi Demo', 'Father', '19600115']]);
    assert.ok(await UserModel.exists({ email: imran!.email, userType: 'user', phone: { $exists: false } }));
    assert.ok(await UserModel.exists({ phone: lata!.phone, userType: 'user', email: { $exists: false } }));

    for (const d of input.doctors!) {
      const sp = await SpecialistModel.findOne(d.phone ? { phone: d.phone } : { email: d.email }).lean() as any;
      assert.deepEqual([sp.isActive, sp.isVerified, sp.specialization, sp.consultationFee, sp.email], [true, true, d.specialization, d.fee, d.email]);
    }
    const ph = await PharmacyModel.findOne({ phone: input.pharmacy!.phone }).lean() as any;
    assert.deepEqual([ph.isVerified, ph.isActive, ph.email], [true, true, input.pharmacy!.email]);

    // Lab: verified, owner + staff (branch-scoped), catalogue, slot templates, settlement account, audit trail.
    const lab = await PartnerModel.findOne({ kind: 'lab', name: input.lab!.name }).lean() as any;
    assert.equal(lab.verification.state, 'verified');
    assert.equal(lab.taxRegime, 'unregistered');
    const labBranch = await BranchModel.findOne({ partnerId: String(lab._id) }).lean() as any;
    const labOwner = await MemberModel.findOne({ partnerId: String(lab._id), phone: input.lab!.ownerPhone }).lean() as any;
    assert.deepEqual([labOwner.role, labOwner.email, labOwner.isActive], ['owner', input.lab!.ownerEmail, true]);
    const labStaff = await MemberModel.findOne({ partnerId: String(lab._id), phone: input.lab!.staff![0]!.phone }).lean() as any;
    assert.deepEqual([labStaff.role, labStaff.email, labStaff.branchIds], ['staff', input.lab!.staff![0]!.email, [String(labBranch._id)]]);
    assert.ok(labStaff.permissions.includes('reports.release'));
    assert.equal(await CatalogueItemModel.countDocuments({ partnerId: String(lab._id), isActive: true }), 3);
    assert.deepEqual((await PartnerSlotTemplateModel.find({ branchId: String(labBranch._id) }).lean()).map((t: any) => t.visitMode).sort(), ['home', 'lab']);
    assert.ok(await PartnerSlotModel.countDocuments({ branchId: String(labBranch._id) }) > 0);
    assert.ok(await SettlementAccountModel.exists({ ownerKind: 'partner', ownerId: String(lab._id) }));
    assert.ok(await PartnerAuditEventModel.exists({ partnerId: String(lab._id), action: 'member.add', actorKind: 'admin' }));
    assert.equal(lab.createdBy, String(admin._id));

    // Clinic: verified, part payments, desk staff, catalogue, the doctor linked by the admin at the branch.
    const clinic = await PartnerModel.findOne({ kind: 'clinic', name: input.clinic!.name }).lean() as any;
    assert.deepEqual([clinic.verification.state, clinic.allowPartPayments], ['verified', true]);
    const cBranch = await BranchModel.findOne({ partnerId: String(clinic._id) }).lean() as any;
    assert.equal(cBranch.services.inClinic, true);
    const cOwner = await MemberModel.findOne({ partnerId: String(clinic._id), phone: input.clinic!.ownerPhone }).lean() as any;
    assert.deepEqual([cOwner.role, cOwner.email], ['owner', input.clinic!.ownerEmail]);
    const desk = await MemberModel.findOne({ partnerId: String(clinic._id), phone: input.clinic!.staff![0]!.phone }).lean() as any;
    assert.deepEqual([desk.role, desk.branchIds], ['staff', [String(cBranch._id)]]);
    assert.deepEqual((await CatalogueItemModel.find({ partnerId: String(clinic._id) }).lean()).map((i: any) => i.kind).sort(), ['consultation', 'procedure']);
    const kavyaRef = input.clinic!.doctors![0] as { doctor: string; signInEmail: string };
    const kavya = await SpecialistModel.findOne({ phone: kavyaRef.doctor }).lean() as any;
    const kMember = await MemberModel.findOne({ partnerId: String(clinic._id), doctorId: String(kavya._id), isActive: true }).lean() as any;
    // The sign-in email on the clinic membership comes from the file's signInEmail (set by the admin as owner).
    assert.deepEqual([kMember.role, kMember.doctorBranchIds, kMember.phone, kMember.email], ['staff', [String(cBranch._id)], kavya.phone, kavyaRef.signInEmail]);
    assert.ok(await PartnerAuditEventModel.exists({ partnerId: String(clinic._id), action: 'member.email', actorKind: 'admin' }));
    assert.ok(await ClinicDoctorInviteModel.exists({ partnerId: String(clinic._id), doctorId: String(kavya._id), state: 'accepted', via: 'admin_link' }));
    assert.equal(await clinicBranchAllowed(String(kavya._id), String(cBranch._id)), true);
    const kSchedule = await DoctorScheduleTemplateModel.findOne({ doctorId: String(kavya._id) }).lean() as any;
    assert.ok(kSchedule.days.mon.some((w: any) => w.branchId === String(cBranch._id) && w.modes.join() === 'in-person'));
    assert.ok(await SlotModel.exists({ specialistId: String(kavya._id), branchId: String(cBranch._id) }));

    // The doctor's own clinic: pending, owned by the doctor (with the doctor's email as a second sign-in).
    const arjun = await SpecialistModel.findOne({ email: input.doctorClinic!.email }).lean() as any;
    const own = await PartnerModel.findOne({ soloDoctorId: String(arjun._id) }).lean() as any;
    assert.deepEqual([own.verification.state, own.solo, own.name], ['pending', true, input.doctorClinic!.name]);
    const ownOwner = await MemberModel.findOne({ partnerId: String(own._id), doctorId: String(arjun._id) }).lean() as any;
    assert.deepEqual([ownOwner.role, ownOwner.phone, ownOwner.email], ['owner', arjun.phone, input.doctorClinic!.signInEmail]);
    // Every doctor has a weekly schedule.
    assert.equal(await DoctorScheduleTemplateModel.countDocuments(), input.doctors!.length);

    // The final table: one row per sign-in, masked.
    const rows = first.accounts.map((x) => `${x.role}|${x.loginAs}`);
    for (const want of ['Admin|Admin', 'Customer|Customer app', 'Doctor|Doctor', 'Pharmacy|Pharmacy staff', 'Lab owner|Lab or clinic staff',
      'Lab staff|Lab or clinic staff', 'Clinic owner|Lab or clinic staff', 'Clinic staff|Lab or clinic staff', 'Clinic doctor|Lab or clinic staff',
      "Doctor's clinic owner|Lab or clinic staff"]) assert.ok(rows.includes(want), want);
    const ashaRow = first.accounts.find((x) => x.name === asha!.name)!;
    assert.equal(ashaRow.signIn, `${maskPhone(asha!.phone!)} / ${maskEmail(asha!.email!)}`);
    assert.match(ashaRow.signIn, /^90x{6}02 \/ as\*\*\*@example\.com$/);
  });

  await check('a second run creates nothing (every record found, collections unchanged)', async () => {
    const before = await counts();
    const out: string[] = [];
    const r = await cli([inputFile, '--commit'], ALLOWED, (l) => out.push(l));
    allOutput.push(...out);
    assert.equal(r.code, 0, out.join('\n'));
    assert.deepEqual([r.report!.counts.created, r.report!.counts.updated, r.report!.counts['would create']], [0, 0, 0]);
    assert.deepEqual(await counts(), before);
  });

  await check('a dry run after the commit reports everything found and writes nothing', async () => {
    const before = await counts();
    const r = await cli([inputFile], ALLOWED, (l) => allOutput.push(l));
    assert.equal(r.code, 0);
    assert.deepEqual([r.report!.counts['would create'], r.report!.counts['would update']], [0, 0]);
    assert.deepEqual(await counts(), before);
  });

  await check('never prints a full phone number or email', () => {
    const text = allOutput.join('\n');
    for (const s of secrets(input)) assert.equal(text.includes(s), false, `printed ${maskPhone(s)}`);
  });

  await check('an existing account found by phone gets a missing email added; name and role are kept', async () => {
    const i = clone();
    const lata = i.customers!.find((c) => c.name === 'Lata Demo')!;
    lata.email = 'lata.demo@example.com';
    lata.name = 'Renamed';
    const staff = i.lab!.staff![0]!;
    const labId = String((await PartnerModel.findOne({ name: i.lab!.name }).lean() as any)._id);
    await MemberModel.updateOne({ partnerId: labId, phone: staff.phone }, { $unset: { email: 1 } });
    staff.role = 'owner';
    const r = await runSeed(i, { commit: true, log: () => {} });
    const u = await UserModel.findOne({ phone: lata.phone, userType: 'user' }).lean() as any;
    assert.deepEqual([u.name, u.email], ['Lata Demo', 'lata.demo@example.com']);
    const m = await MemberModel.findOne({ partnerId: labId, phone: staff.phone, isActive: true }).lean() as any;
    assert.deepEqual([m.role, m.email], ['staff', staff.email]);
    assert.ok(r.warnings.some((w) => /is a staff there; kept/.test(w)));
    assert.equal(r.counts.created, 0);
  });

  await check('a phone and an email of two different existing accounts are refused, nothing merged or written', async () => {
    const i = clone();
    const asha = i.customers!.find((c) => c.name === 'Asha Demo')!;
    asha.email = i.customers!.find((c) => c.name === 'Imran Demo')!.email;
    i.customers = [asha];
    const before = await counts();
    await assert.rejects(runSeed(i, { commit: true, log: () => {} }), /two different existing accounts; refusing to merge/);
    assert.deepEqual(await counts(), before);
  });

  await check('a doctor found by email with another stored phone is linked by its entry (no crash), with the stored phone', async () => {
    const stored = await SpecialistModel.create({ name: 'Dr Moved', phone: '9100000101', email: 'dr.moved@example.com', specialization: 'ENT',
      isActive: true, isVerified: true });
    const i = clone();
    i.doctors = [{ name: 'Dr Moved', phone: '9100000102', email: 'dr.moved@example.com', specialization: 'ENT', fee: 400 }];
    i.clinic!.doctors = ['9100000102'];
    delete i.doctorClinic; delete i.lab; delete i.customers; delete i.pharmacy;
    const r = await runSeed(i, { commit: true, log: () => {} });
    const clinicId = String(((await PartnerModel.findOne({ name: i.clinic!.name }).lean()) as any)._id);
    const m = await MemberModel.findOne({ partnerId: clinicId, doctorId: String(stored._id), isActive: true }).lean() as any;
    assert.equal(m.phone, '9100000101');
    assert.ok(r.warnings.some((w) => /another phone on record \(91x{6}01\); kept/.test(w)));
    // Without the email sign-in key a linked doctor's membership has no sign-in email.
    assert.equal(m.email, undefined);
  });

  await check('a failure partway prints what was done before it (counts, warnings, accounts so far)', async () => {
    const i = clone();
    delete i.lab; delete i.clinic; delete i.doctorClinic; delete i.pharmacy;
    // Admin and customers are found, then a doctor whose phone and email are two different accounts stops the run.
    await SpecialistModel.create({ name: 'Dr A', phone: '9100000201', isActive: true, isVerified: true, specialization: 'X' });
    await SpecialistModel.create({ name: 'Dr B', email: 'dr.b@example.com', isActive: true, isVerified: true, specialization: 'X' });
    i.doctors = [{ name: 'Dr AB', phone: '9100000201', email: 'dr.b@example.com', specialization: 'X', fee: 1 }];
    const file = path.join(dir, 'partial.json');
    fs.writeFileSync(file, JSON.stringify(i));
    const out: string[] = [];
    const r = await cli([file, '--commit'], ALLOWED, (l) => out.push(l));
    const text = out.join('\n');
    assert.equal(r.code, 1);
    assert.match(text, /Before the failure: 0 created, \d+ found/);
    assert.match(text, /Accounts so far[\s\S]*Demo Admin[\s\S]*Asha Demo/);
    assert.match(text, /FAILED: doctor 91x{6}01 \/ dr\*\*\*@example\.com: the phone and the email belong to two different existing accounts/);
  });

  await check('sign-up placeholders (made by an earlier code request) are completed with the file profile; conflicts name the fix', async () => {
    // What a code request to an unknown phone creates for each role.
    await signUpPlaceholder('specialist', '9100000301');
    // A code request no longer signs a pharmacy up (only admins create pharmacies, owner decision 19 Nov 2026), but rows it
    // made before that decision still exist: insert one exactly as the old sign-up wrote it.
    await assert.rejects(signUpPlaceholder('pharmacy', '9100000302'), (e: any) => e.code === 'PHARMACY_NOT_FOUND');
    assert.equal(await PharmacyModel.countDocuments({ phone: '9100000302' }), 0);
    await PharmacyModel.create({ name: 'Demo', phone: '9100000302', isActive: true, isVerified: false, walletEnabled: false,
      pickupAvailable: false, deliveryAvailable: false } as any);
    await signUpPlaceholder('user', '9100000303');
    const sp0 = await SpecialistModel.findOne({ phone: '9100000301' }).lean() as any;
    const ph0 = await PharmacyModel.findOne({ phone: '9100000302' }).lean() as any;
    assert.deepEqual([sp0.name, sp0.isVerified, ph0.name, ph0.isVerified], ['demoName', false, 'Demo', false]);
    const r = await runSeed({
      doctors: [{ name: 'Dr Real', phone: '9100000301', email: 'dr.real@example.com', specialization: 'Cardiologist', fee: 900, modes: ['video'] }],
      pharmacy: { name: 'Real Pharmacy', phone: '9100000302', ownerName: 'Owner', address: '1 Road', city: 'Pune', state: 'MH', pincode: '411001' },
      customers: [{ name: 'Real Customer', phone: '9100000303' }],
    } as DemoInput, { commit: true, log: () => {} });
    const sp = await SpecialistModel.findOne({ phone: '9100000301' }).lean() as any;
    assert.deepEqual([sp.name, sp.specialization, sp.consultationFee, sp.email, sp.isVerified, sp.availability.acceptVideoConsultations, sp.availability.acceptChatConsultations, sp.city],
      ['Dr Real', 'Cardiologist', 900, 'dr.real@example.com', true, true, false, 'Pune']);
    const ph = await PharmacyModel.findOne({ phone: '9100000302' }).lean() as any;
    assert.deepEqual([ph.name, ph.ownerName, ph.address, ph.isVerified, ph.pickupAvailable], ['Real Pharmacy', 'Owner', '1 Road', true, true]);
    assert.equal((await UserModel.findOne({ phone: '9100000303', userType: 'user' }).lean() as any).name, 'Real Customer');
    assert.equal(await SpecialistModel.countDocuments({ phone: '9100000301' }), 1);
    assert.ok(r.steps.filter((x) => /completed a sign-up placeholder/.test(x.note ?? '')).length === 3);
    // A placeholder by phone and a real doctor by email: refused, and the message names the fix.
    await signUpPlaceholder('specialist', '9100000304');
    await SpecialistModel.create({ name: 'Dr Mail', email: 'dr.mail2@example.com', isActive: true, isVerified: true, specialization: 'X' });
    await assert.rejects(runSeed({ doctors: [{ name: 'Dr X', phone: '9100000304', email: 'dr.mail2@example.com', specialization: 'X', fee: 1 }] } as DemoInput,
      { commit: true, log: () => {} }), /the one found by phone is an unverified placeholder[\s\S]*remove the unverified placeholder row created by an earlier code request/);
  });

  await check('a nameless customer made by a desk, bill or pharmacy is not a placeholder: name not filled, conflict hint not given', async () => {
    const desk = await UserModel.create({ phone: '9100000501', userType: 'user', createdSource: 'clinic_desk', otpVerified: false } as any);
    const linked = await UserModel.create({ phone: '9100000502', userType: 'user', createdSource: 'self_signup', otpVerified: false, linkedPharmacyId: 'p1' } as any);
    const r = await runSeed({ customers: [{ name: 'Desk Person', phone: '9100000501' }, { name: 'Linked Person', phone: '9100000502' }] } as DemoInput,
      { commit: true, log: () => {} });
    assert.equal((await UserModel.findById(desk._id).lean() as any).name, undefined);
    assert.equal((await UserModel.findById(linked._id).lean() as any).name, undefined);
    assert.equal(r.warnings.filter((w) => /nameless customer not made by sign-up/.test(w)).length, 2);
    await UserModel.create({ email: 'someone.else@example.com', userType: 'user', name: 'Someone' } as any);
    await assert.rejects(runSeed({ customers: [{ name: 'X', phone: '9100000501', email: 'someone.else@example.com' }] } as DemoInput, { commit: true, log: () => {} }),
      (e: any) => /two different existing accounts/.test(e.message) && !/the one found by phone is an unverified placeholder/.test(e.message));
  });

  await check('a pharmacy placeholder is completed only with fields the create form accepts (checked before writing)', async () => {
    // A placeholder from before sign-up rows stopped storing an email (found here by that email).
    const row = await PharmacyModel.create({ name: 'Demo', phone: '9100000601', email: 'old.shop@example.com', isActive: true, isVerified: false });
    await assert.rejects(runSeed({ pharmacy: { name: 'Shop', email: 'old.shop@example.com', pincode: '41' } } as DemoInput, { commit: true, log: () => {} }),
      /pharmacy: .*[Pp]incode/);
    const after = await PharmacyModel.findById(row._id).lean() as any;
    assert.deepEqual([after.name, after.pincode, after.isVerified], ['Demo', undefined, false]);
    await runSeed({ pharmacy: { name: 'Shop', email: 'old.shop@example.com', pincode: '411001' } } as DemoInput, { commit: true, log: () => {} });
    const done = await PharmacyModel.findById(row._id).lean() as any;
    assert.deepEqual([done.name, done.pincode, done.isVerified], ['Shop', '411001', true]);
  });

  await check('a re-run adds the in-clinic windows to a saved schedule of a now-linked doctor (never removing windows)', async () => {
    const i = clone();
    delete i.lab; delete i.customers; delete i.pharmacy; delete i.doctorClinic;
    i.doctors = [{ name: 'Dr Later', phone: '9100000401', specialization: 'GP', fee: 300, modes: ['chat'] }];
    i.clinic!.doctors = [];
    await runSeed(i, { commit: true, log: () => {} });
    const sp = await SpecialistModel.findOne({ phone: '9100000401' }).lean() as any;
    // The doctor's own extra window (Sunday) must survive.
    const t0 = await DoctorScheduleTemplateModel.findOne({ doctorId: String(sp._id) }).lean() as any;
    await saveDoctorSchedule(String(sp._id), { slotMinutes: 30, days: { ...t0.days, sun: [{ start: '08:00', end: '09:00', modes: ['call'] }] },
      expectedUpdatedAt: t0.updatedAt });
    i.clinic!.doctors = ['9100000401'];
    const r = await runSeed(i, { commit: true, log: () => {} });
    const clinicId = String(((await PartnerModel.findOne({ name: i.clinic!.name }).lean()) as any)._id);
    const branchId = String(((await BranchModel.findOne({ partnerId: clinicId }).lean()) as any)._id);
    const t = await DoctorScheduleTemplateModel.findOne({ doctorId: String(sp._id) }).lean() as any;
    for (const d of ['mon', 'tue', 'wed', 'thu', 'fri', 'sat']) {
      assert.deepEqual(t.days[d].map((w: any) => [w.start, w.end, w.branchId ?? null]), [['10:00', '13:00', null], ['17:00', '19:00', branchId]], d);
    }
    assert.deepEqual(t.days.sun.map((w: any) => [w.start, w.modes.join()]), [['08:00', 'call']]);
    assert.ok(r.steps.some((x) => x.status === 'updated' && /added in-clinic windows/.test(x.note ?? '')));
    assert.ok(await SlotModel.exists({ specialistId: String(sp._id), branchId }));
    // And once more: nothing to add.
    const again = await runSeed(i, { commit: true, log: () => {} });
    assert.deepEqual([again.counts.created, again.counts.updated], [0, 0]);
  });

  await check('stops before writing when an index is missing, naming sync-indexes', async () => {
    await MemberModel.collection.dropIndex('email_1_partnerId_1');
    try {
      const out: string[] = [];
      const r = await cli([inputFile, '--commit'], ALLOWED, (l) => out.push(l));
      assert.equal(r.code, 1);
      assert.match(out.join('\n'), /"partner_members" is missing 1 index\(es\): email\+partnerId[\s\S]*npm run sync-indexes/);
    } finally {
      await MemberModel.syncIndexes();
    }
  });

  // ── Sign-in: each seeded account is found by the real OTP path, by phone and by email ──
  const idOf = async (M: mongoose.Model<any>, q: object) => String(((await M.findOne(q).lean()) as any)._id);
  await check('admin signs in by phone and by email', async () => {
    const id = await idOf(AdminModel, { phone: input.admin!.phone });
    for (const c of [{ phone: input.admin!.phone }, { email: input.admin!.email!.toUpperCase() }]) {
      const { claims } = await signIn('admin', c);
      assert.deepEqual([claims.userType, claims._id], ['admin', id]);
    }
  });
  await check('customers sign in by phone and by email (the customer app)', async () => {
    for (const cu of input.customers!) {
      const id = await idOf(UserModel, cu.phone ? { phone: cu.phone, userType: 'user' } : { email: cu.email, userType: 'user' });
      for (const c of [cu.phone ? { phone: cu.phone } : null, cu.email ? { email: cu.email } : null].filter(Boolean) as object[]) {
        const { claims } = await signIn('user', c);
        assert.deepEqual([claims.userType, claims._id], ['user', id]);
      }
    }
    assert.ok(input.customers!.some((c) => c.phone && c.email));
  });
  await check('doctors sign in by phone and by email', async () => {
    for (const d of input.doctors!) {
      const id = await idOf(SpecialistModel, d.phone ? { phone: d.phone } : { email: d.email });
      for (const c of [d.phone ? { phone: d.phone } : null, d.email ? { email: d.email } : null].filter(Boolean) as object[]) {
        const { claims } = await signIn('specialist', c);
        assert.deepEqual([claims.userType, claims.specialistId], ['specialist', id]);
      }
    }
  });
  await check('pharmacy signs in by phone and by email', async () => {
    const id = await idOf(PharmacyModel, { phone: input.pharmacy!.phone });
    for (const c of [{ phone: input.pharmacy!.phone }, { email: input.pharmacy!.email }]) {
      const { claims } = await signIn('pharmacy', c);
      assert.deepEqual([claims.userType, claims.pharmacyId], ['pharmacy', id]);
    }
  });
  await check('lab and clinic owners, staff, the clinic doctor and the doctor-clinic owner sign in by phone and by email', async () => {
    const people: { partner: string; phone: string; email?: string }[] = [];
    for (const kind of ['lab', 'clinic'] as const) {
      const p = input[kind]!;
      people.push({ partner: p.name, phone: p.ownerPhone, email: p.ownerEmail }, ...p.staff!.map((s) => ({ partner: p.name, phone: s.phone, email: s.email })));
    }
    const kavyaRef = input.clinic!.doctors![0] as { doctor: string; signInEmail: string };
    const kavya = input.doctors!.find((d) => d.phone === kavyaRef.doctor)!;
    people.push({ partner: input.clinic!.name, phone: kavya.phone!, email: kavyaRef.signInEmail });
    const arjun = input.doctors!.find((d) => d.email === input.doctorClinic!.email)!;
    people.push({ partner: input.doctorClinic!.name!, phone: arjun.phone!, email: input.doctorClinic!.signInEmail });
    for (const who of people) {
      const partnerId = String(((await PartnerModel.findOne({ name: who.partner }).lean()) as any)._id);
      const memberId = await idOf(MemberModel, { partnerId, phone: who.phone, isActive: true });
      assert.ok(who.email, 'every member in the example has an email');
      for (const c of [{ phone: who.phone }, { email: who.email!.toUpperCase() }]) {
        const { claims } = await signIn('partner', c);
        assert.deepEqual([claims.userType, claims.memberId, claims.partnerId], ['partner', memberId, partnerId]);
      }
    }
  });

  console.log(`\n${passed} checks passed${failed.length ? `, ${failed.length} FAILED: ${failed.join(' | ')}` : ''}`);
  if (failed.length) throw new Error(`${failed.length} checks failed`);
}

main().then(() => mongoose.disconnect()).then(() => fs.rmSync(dir, { recursive: true, force: true }))
  .catch(async (e) => { console.error(e?.message ?? e); await mongoose.disconnect(); fs.rmSync(dir, { recursive: true, force: true }); process.exit(1); });
