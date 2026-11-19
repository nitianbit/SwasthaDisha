/**
 * Demo/test accounts for a STAGE server: one of every account type, each signing in exactly as a real one does
 * (mobile number + SMS OTP, or email + emailed OTP; there is no bypass, fixed code or password, so every phone and email
 * must be one you control).
 *
 *   SEED_DEMO_ALLOWED=true SEED_DEMO_HOST=<host:port> SEED_DEMO_DATABASE=<db> npm run seed:demo -- demo-accounts.json   # dry run
 *   ... the same ... -- demo-accounts.json --commit                                                                  # creates what is missing
 *
 * SEED_DEMO_HOST and SEED_DEMO_DATABASE must equal the connected host and database (printed first; for a replica set the
 * host is the first one in MONGODB_URL); a database name containing "prod" is always refused.
 *
 * Input: see demo-accounts.example.json (copy it to demo-accounts.json, which git ignores, and put in real numbers).
 *
 * - Uses the app's own services wherever one exists (partner creation, branches, staff, catalogue, lab slot templates,
 *   doctor schedules, admin doctor-to-clinic linking, the doctor-created clinic, specialist/pharmacy/dependent creation),
 *   so audit rows, settlement accounts, schedule guards, slots and request keys are made exactly as the app makes them.
 *   Raw rows only where the app has no service: the admin account and the customer account (as the OTP sign-up writes it).
 * - Idempotent: every account is found by its phone or email, exactly as its sign-in finds it (partners by name + owner)
 *   and reused; an existing account's name or role is never changed, a missing phone/email is added, a different one is
 *   kept, and a phone and email belonging to two different accounts are refused (never merged). A re-run creates nothing.
 * - Phones and emails are printed masked (98xxxxxx10, sh***@gmail.com); OTPs are never involved. Nothing is written to disk.
 * - Needs `npm run sync-indexes` to have been run (production/stage run with autoIndex off); it checks and stops otherwise.
 */
import 'reflect-metadata';
import fs from 'fs';
import path from 'path';
import { createHash } from 'crypto';
import Joi from 'joi';
import mongoose from 'mongoose';
import { Container } from 'typedi';
import { CONFIG } from '@/config/config';
import { canonicalMobile } from '@/modules/common/utils/phone';
import AdminModel from '@/modules/admin/model';
import UserModel from '@/modules/user/model';
import SpecialistModel from '@/modules/specialists/model';
import PharmacyModel from '@/modules/pharmacies/model';
import DependentModel from '@/modules/dependents/model';
import OTPModel from '@/modules/otp/model';
import { OtpThrottleModel } from '@/modules/otp/model/throttle';
import { WalletModel } from '@/modules/wallet/model';
import NotificationModel from '@/modules/notification/model';
import SlotModel from '@/modules/slots/model';
import PartnerModel from '@/modules/partners/model';
import MemberModel from '@/modules/partners/model/member';
import BranchModel from '@/modules/partners/model/branch';
import CatalogueItemModel from '@/modules/partners/model/catalogueItem';
import PartnerAuditEventModel from '@/modules/partners/model/audit';
import { ClinicDoctorInviteModel } from '@/modules/partners/model/clinicDoctor';
import { SettlementAccountModel } from '@/modules/partners/model/settlement';
import { PartnerSlotModel, PartnerSlotTemplateModel, ScheduleGuardModel, VisitMode } from '@/modules/partners/model/slot';
import { RequestKeyModel } from '@/modules/requestKeys/model';
import { DoctorScheduleTemplateModel, IScheduleWindow, Weekday } from '@/modules/doctors/model/schedule';
import { DoctorReservationModel, DoctorScheduleGuardModel } from '@/modules/doctors/model/reservation';
import { SpecialistRepository } from '@/modules/specialists/repository';
import { CorporateRepository } from '@/modules/corporates/repository';
import { BookingRepository } from '@/modules/bookings/repository';
import { UserRepository } from '@/modules/user/repository';
import { DependentRepository } from '@/modules/dependents/repository';
import { NotificationRepository } from '@/modules/notification/repository';
import { NotificationService } from '@/modules/notification/services';
import { PartnerRepository } from '@/modules/partners/repository';
import { MemberRepository } from '@/modules/partners/repository/member';
import { BranchRepository } from '@/modules/partners/repository/branch';
import { CatalogueItemRepository } from '@/modules/partners/repository/catalogueItem';
import { SpecialistService } from '@/modules/specialists/services';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import { PharmacyService } from '@/modules/pharmacies/services';
import { DependentService } from '@/modules/dependents/services';
import { PartnerService, adminActor } from '@/modules/partners/services';
import { CatalogueService, CatalogueItemInput } from '@/modules/partners/services/catalogue';
import { saveSlotTemplate } from '@/modules/partners/services/slots';
import { linkDoctor, createSoloPractice } from '@/modules/partners/services/clinic';
import { customerPhoneIndexReady } from '@/modules/partners/services/customerResolver';
import { saveTemplate as saveDoctorSchedule, getTemplate as getDoctorSchedule, clinicBranchAllowed } from '@/modules/doctors/services/schedule';
import { createPartnerSchema, addMemberSchema, createBranchSchema, createCatalogueItemSchema } from '@/modules/partners/validation';
import { linkDoctorSchema, doctorClinicSchema } from '@/modules/partners/validation/clinic';
import { slotTemplateSchema } from '@/modules/partners/validation/labBooking';
import { scheduleTemplateSchema } from '@/modules/doctors/validation';
import { createSpecialistSchema } from '@/modules/specialists/validation';
import { createPharmacySchema } from '@/modules/pharmacies/validation';
import { createDependentSchema } from '@/modules/dependents/validation';
import { ALL_PERMISSIONS, MemberRole, PartnerPermission } from '@/modules/partners/types';

// ───────────────────────────── Input ─────────────────────────────

/** A sign-in identity: a mobile number, an email, or both (at least one). */
export interface Contact { phone?: string; email?: string }
export interface DemoAddress { line1: string; line2?: string; city: string; state: string; stateCode: string; pincode: string }
export interface DemoBranch { name: string; phone: string; address: DemoAddress; hours?: Record<string, { open: string; close: string }>; services?: Record<string, boolean> }
/** Partner members: the member model requires a phone; the email is an optional second sign-in. */
export interface DemoStaff { name: string; phone: string; email?: string; role?: MemberRole; permissions?: PartnerPermission[] }
export interface DemoPartner {
  name: string; ownerName: string; ownerPhone: string; ownerEmail?: string; invoiceSeriesPrefix?: string; legalName?: string; contactEmail?: string;
  branch: DemoBranch; staff?: DemoStaff[];
}
export interface DemoDoctor extends Contact {
  name: string; specialization: string; fee: number; modes?: ('video' | 'call' | 'chat')[]; degree?: string; experienceYears?: number;
  languages?: string[]; medicalRegistrationNumber?: string;
}
export interface DemoInput {
  admin?: Contact & { name: string };
  customers?: (Contact & { name: string; family?: { name: string; relation: string; gender?: 'Male' | 'Female' | 'Other'; dateOfBirth?: string }[] })[];
  doctors?: DemoDoctor[];
  pharmacy?: Contact & { name: string; ownerName?: string; address?: string; city?: string; state?: string; pincode?: string;
    drugLicenseNumber?: string; gstNumber?: string; pickupAvailable?: boolean; deliveryAvailable?: boolean };
  lab?: DemoPartner;
  /**
   * `doctors`: entries of the top-level "doctors" list (by phone or email), linked at the clinic branch by the admin; as
   * `{doctor, signInEmail}` the membership also gets that sign-in email (set by the admin as owner; linked doctors
   * otherwise sign in to the clinic with their mobile number).
   */
  clinic?: DemoPartner & { doctors?: (string | { doctor: string; signInEmail?: string })[]; allowPartPayments?: boolean };
  /** The doctor (by the phone and/or email of a "doctors" entry) who creates their own clinic; `signInEmail` as above. */
  doctorClinic?: Contact & { name?: string; invoiceSeriesPrefix?: string; signInEmail?: string; branch?: { name: string; phone: string; address: DemoAddress } };
  [comment: `_${string}`]: unknown;
}

const phoneReq = Joi.string().trim().min(10).max(16).required();
const phoneOpt = Joi.string().trim().min(10).max(16).optional();
const emailOpt = Joi.string().trim().lowercase().email().max(254).optional();
const address = Joi.object({
  line1: Joi.string().trim().required(), line2: Joi.string().trim().allow('').optional(), city: Joi.string().trim().required(),
  state: Joi.string().trim().required(), stateCode: Joi.string().trim().required(), pincode: Joi.string().trim().required(),
});
const branch = Joi.object({
  name: Joi.string().trim().required(), phone: phoneReq, address: address.required(),
  hours: Joi.object().pattern(/^(mon|tue|wed|thu|fri|sat|sun)$/, Joi.object({ open: Joi.string().required(), close: Joi.string().required() })).optional(),
  services: Joi.object({ homeCollection: Joi.boolean(), inLab: Joi.boolean(), inClinic: Joi.boolean() }).optional(),
});
const staff = Joi.object({
  name: Joi.string().trim().required(), phone: phoneReq, email: emailOpt, role: Joi.string().valid('owner', 'staff').optional(),
  permissions: Joi.array().items(Joi.string().valid(...ALL_PERMISSIONS)).optional(),
});
const partner = {
  name: Joi.string().trim().required(), ownerName: Joi.string().trim().required(), ownerPhone: phoneReq, ownerEmail: emailOpt,
  invoiceSeriesPrefix: Joi.string().trim().optional(), legalName: Joi.string().trim().optional(), contactEmail: emailOpt,
  branch: branch.required(), staff: Joi.array().items(staff).optional(),
};
const inputSchema = Joi.object({
  admin: Joi.object({ name: Joi.string().trim().required(), phone: phoneOpt, email: emailOpt }).or('phone', 'email').optional(),
  customers: Joi.array().items(Joi.object({
    name: Joi.string().trim().required(), phone: phoneOpt, email: emailOpt,
    family: Joi.array().items(Joi.object({
      name: Joi.string().trim().required(), relation: Joi.string().trim().required(),
      gender: Joi.string().valid('Male', 'Female', 'Other').optional(), dateOfBirth: Joi.string().trim().optional(),
    })).optional(),
  }).or('phone', 'email')).optional(),
  doctors: Joi.array().items(Joi.object({
    name: Joi.string().trim().required(), phone: phoneOpt, email: emailOpt, specialization: Joi.string().trim().required(), fee: Joi.number().min(0).required(),
    modes: Joi.array().items(Joi.string().valid('video', 'call', 'chat')).min(1).unique().optional(),
    degree: Joi.string().trim().optional(), experienceYears: Joi.number().integer().min(0).optional(),
    languages: Joi.array().items(Joi.string().trim()).optional(), medicalRegistrationNumber: Joi.string().trim().optional(),
  }).or('phone', 'email')).optional(),
  pharmacy: Joi.object({ name: Joi.string().trim().required(), phone: phoneOpt, email: emailOpt }).or('phone', 'email').unknown(true).optional(),
  lab: Joi.object(partner).optional(),
  clinic: Joi.object({ ...partner, allowPartPayments: Joi.boolean().optional(),
    doctors: Joi.array().items(Joi.alternatives(Joi.string().trim(), Joi.object({ doctor: Joi.string().trim().required(), signInEmail: emailOpt }))).optional(),
  }).optional(),
  doctorClinic: Joi.object({
    phone: phoneOpt, email: emailOpt, signInEmail: emailOpt, name: Joi.string().trim().optional(), invoiceSeriesPrefix: Joi.string().trim().optional(),
    branch: Joi.object({ name: Joi.string().trim().required(), phone: phoneReq, address: address.required() }).optional(),
  }).or('phone', 'email').optional(),
}).pattern(/^_/, Joi.any());

// ───────────────────────────── Demo defaults ─────────────────────────────

const OPEN_HOURS = Object.fromEntries((['mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const).map((d) => [d, { open: '08:00', close: '20:00' }]));
const DEFAULT_ADDRESS: DemoAddress = { line1: '12 Demo Road', city: 'Pune', state: 'Maharashtra', stateCode: '27', pincode: '411038' };
const LAB_STAFF_PERMISSIONS: PartnerPermission[] = ['bookings.view', 'bookings.manage', 'slots.manage', 'reports.upload', 'reports.release', 'invoices.create', 'payments.record'];
const DESK_PERMISSIONS: PartnerPermission[] = ['bookings.view', 'bookings.manage', 'invoices.create', 'invoices.cancel', 'payments.record'];
const LAB_CATALOGUE: CatalogueItemInput[] = [
  { kind: 'test', name: 'Complete Blood Count (CBC)', code: 'CBC', sampleType: 'Blood', preparation: 'No fasting needed', priceMinor: 35000, mrpMinor: 45000,
    gstRate: 0, visitModes: ['home', 'lab'], reportTatHours: 24 },
  { kind: 'test', name: 'Lipid Profile', code: 'LIPID', sampleType: 'Blood', preparation: 'Fast for 10 to 12 hours', priceMinor: 60000, mrpMinor: 80000,
    gstRate: 0, visitModes: ['home', 'lab'], reportTatHours: 24 },
  { kind: 'package', name: 'Basic Health Check', code: 'BHC', sampleType: 'Blood and urine', priceMinor: 120000, mrpMinor: 160000, gstRate: 0,
    includes: ['Complete Blood Count (CBC)', 'Lipid Profile', 'Fasting Blood Sugar', 'Urine Routine'], visitModes: ['home', 'lab'], reportTatHours: 36 },
];
const CLINIC_CATALOGUE: CatalogueItemInput[] = [
  { kind: 'consultation', name: 'General consultation', code: 'CONS', description: 'In-clinic consultation with a doctor', priceMinor: 50000, gstRate: 0 },
  { kind: 'procedure', name: 'Wound dressing', code: 'DRESS', priceMinor: 30000, gstRate: 0 },
];
const SIX_DAYS: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const LAB_TEMPLATES: Record<VisitMode, { slotMinutes: number; capacity: number; days: Partial<Record<Weekday, { start: string; end: string }[]>> }> = {
  lab: { slotMinutes: 30, capacity: 4, days: { ...Object.fromEntries(SIX_DAYS.map((d) => [d, [{ start: '07:00', end: '11:00' }, { start: '16:00', end: '19:00' }]])),
    sun: [{ start: '08:00', end: '11:00' }] } },
  home: { slotMinutes: 60, capacity: 2, days: Object.fromEntries(SIX_DAYS.map((d) => [d, [{ start: '07:00', end: '11:00' }]])) },
};

// ───────────────────────────── Output helpers ─────────────────────────────

/** "9876543210" -> "98xxxxxx10". */
export function maskPhone(p: string): string {
  const s = String(p ?? '');
  return s.length >= 6 ? `${s.slice(0, 2)}${'x'.repeat(s.length - 4)}${s.slice(-2)}` : 'xxxx';
}
/** "shubham@gmail.com" -> "sh***@gmail.com". */
export function maskEmail(e: string): string {
  const [local = '', domain = ''] = String(e ?? '').split('@');
  return `${local.slice(0, 2)}***@${domain || '***'}`;
}
/** Masked sign-in identity: "98xxxxxx10 / sh***@gmail.com". */
export const maskContact = (c: Contact) => [c.phone && maskPhone(c.phone), c.email && maskEmail(c.email)].filter(Boolean).join(' / ') || '-';
/** Runs of 10+ digits and email addresses in a message (e.g. a duplicate-key error) are masked. */
export const redact = (s: string) => String(s)
  .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, (m) => maskEmail(m))
  .replace(/\d{10,}/g, (m) => maskPhone(m));

export class SeedError extends Error {}

export type Status = 'created' | 'found' | 'updated' | 'would create' | 'would update' | 'skipped';
/** `signIn` is the masked phone and/or email. */
export interface AccountRow { role: string; name: string; signIn: string; loginAs: string; belongsTo: string; status: Status }
export interface SeedReport {
  mode: 'dry-run' | 'commit';
  database: string;
  steps: { what: string; status: Status; note?: string }[];
  accounts: AccountRow[];
  warnings: string[];
  counts: Record<Status, number>;
}

const LOGIN = { admin: 'Admin', partner: 'Lab or clinic staff', doctor: 'Doctor', pharmacy: 'Pharmacy staff', customer: 'Customer app' } as const;
const key = (prefix: string, ...parts: string[]) => `seed-demo-${prefix}-${createHash('sha256').update(parts.join('|')).digest('hex').slice(0, 20)}`;
const normDob = (d?: string) => (d ? d.replace(/-/g, '') : undefined);
const escapeRegex = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Rows a code request (AuthService.sendOTP) creates for an unknown phone before anyone completes a profile:
 * buildSpecialistSignupPayload ({name: 'demoName', isVerified: false}), buildPharmacySignupPayload ({name: 'Demo',
 * isVerified: false, nothing else}) and the customer sign-up row (no name, never verified, `createdSource` 'self_signup'
 * — absent on rows from before that field — and not linked to a pharmacy). Customers made by a clinic desk, a bill or a
 * pharmacy (other `createdSource`, or a pharmacy link) can own bills and orders: they are never placeholders. The seeder
 * completes placeholders with the file's profile instead of only verifying them.
 */
export const isSpecialistPlaceholder = (sp: any) => !!sp && sp.name === 'demoName' && sp.isVerified !== true && !sp.specialization;
export const isPharmacyPlaceholder = (p: any) => !!p && p.name === 'Demo' && p.isVerified !== true && !p.ownerName && !p.address;
export const isCustomerPlaceholder = (u: any) => !!u && !u.name && u.otpVerified !== true
  && (u.createdSource === undefined || u.createdSource === null || u.createdSource === 'self_signup') && !u.linkedPharmacyId;

/** Same options as the request validation middleware (abortEarly off, unknown keys stripped); returns the converted value. */
function validated<T>(schema: Joi.Schema, value: unknown, where: string): T {
  const { error, value: out } = schema.validate(value, { abortEarly: false, stripUnknown: true });
  if (error) throw new SeedError(`${where}: ${redact(error.details.map((d) => d.message).join(', '))}`);
  return out as T;
}

// ───────────────────────────── Preflight ─────────────────────────────

/** Every collection the seeding (and the first sign-ins) writes to; each must exist with its declared indexes. */
const NEEDED_MODELS: mongoose.Model<any>[] = [
  AdminModel, UserModel, SpecialistModel, PharmacyModel, DependentModel, OTPModel, OtpThrottleModel, WalletModel, NotificationModel, SlotModel,
  PartnerModel, MemberModel, BranchModel, CatalogueItemModel, PartnerAuditEventModel, ClinicDoctorInviteModel, SettlementAccountModel,
  PartnerSlotModel, PartnerSlotTemplateModel, ScheduleGuardModel, RequestKeyModel, DoctorScheduleTemplateModel, DoctorReservationModel,
  DoctorScheduleGuardModel,
];

export async function preflight(needCustomerIndex: boolean): Promise<void> {
  const db = mongoose.connection.db;
  const hello = await db.admin().command({ hello: 1 });
  if (!hello.setName && hello.msg !== 'isdbgrid') {
    throw new SeedError('This MongoDB is not a replica set: partner, slot and schedule writes need transactions.');
  }
  const present = new Set((await db.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
  const problems: string[] = [];
  for (const M of NEEDED_MODELS) {
    const name = M.collection.collectionName;
    if (!present.has(name)) { problems.push(`collection "${name}" does not exist`); continue; }
    const diff = await M.diffIndexes();
    if (diff.toCreate.length) {
      problems.push(`"${name}" is missing ${diff.toCreate.length} index(es): ${diff.toCreate.map((k) => Object.keys(k as object).join('+')).join(', ')}`);
    }
  }
  if (needCustomerIndex && !problems.some((p) => p.includes('"users"')) && !(await customerPhoneIndexReady())) {
    problems.push('"users": the unique phone index q2_user_phone_unique is not built (or still building)');
  }
  if (problems.length) {
    throw new SeedError(`Collections/indexes are not ready:\n  - ${problems.join('\n  - ')}\nRun \`npm run sync-indexes\` on this server first, then run this again.`);
  }
}

// ───────────────────────────── Seeder ─────────────────────────────

/**
 * The services, built explicitly: `tsx` (esbuild) does not emit decorator metadata, so typedi cannot inject constructor
 * parameters here (the integration tests build them the same way). The partner and notification services are also
 * registered, because the clinic service resolves them from the container (doctor-link notice).
 */
function buildServices() {
  const users = new UserRepository();
  const partner = new PartnerService(new PartnerRepository(), new MemberRepository(), new BranchRepository());
  Container.set(PartnerService, partner);
  Container.set(NotificationService, new NotificationService(new NotificationRepository(), users, {} as never));
  return {
    partner,
    catalogue: new CatalogueService(new CatalogueItemRepository()),
    specialistRepo: new SpecialistRepository(),
    specialist: new SpecialistService(new SpecialistRepository(), new CorporateRepository(), new BookingRepository()),
    pharmacyRepo: new PharmacyRepository(),
    pharmacy: new PharmacyService(new PharmacyRepository(), users),
    dependent: new DependentService(new DependentRepository()),
  };
}

interface DoctorRef extends Contact {
  id?: string; name: string; eligible: boolean; status: Status; modes: ('video' | 'call' | 'chat')[];
  clinic?: { partnerId?: string; branchId?: string; label: string };
}

class Seeder {
  readonly report: SeedReport;
  private adminId?: string;
  /** One per "doctors" entry, at the entry's index (clinic links refer to the index, never to a phone). */
  private doctors: DoctorRef[] = [];
  private clinicDoctorRefs: { index: number; signInEmail?: string }[] = [];
  private doctorClinicIndex?: number;
  /** Raw identities of the partner-workspace rows (never printed), for the multi-workspace note. */
  private partnerRows: { row: AccountRow; contact: Contact }[] = [];

  constructor(private input: DemoInput, private commit: boolean, private log: (line: string) => void) {
    this.report = { mode: commit ? 'commit' : 'dry-run', database: mongoose.connection.db.databaseName, steps: [], accounts: [], warnings: [],
      counts: { created: 0, found: 0, updated: 0, 'would create': 0, 'would update': 0, skipped: 0 } };
  }

  private step(what: string, status: Status, note?: string) {
    this.report.steps.push({ what, status, note });
    this.report.counts[status] += 1;
    this.log(`  [${status}] ${what}${note ? ` — ${note}` : ''}`);
  }
  private warn(msg: string) { this.report.warnings.push(msg); this.log(`  WARNING: ${msg}`); }
  private account(role: string, name: string, contact: Contact, loginAs: string, belongsTo: string, status: Status) {
    const row: AccountRow = { role, name, signIn: maskContact(contact), loginAs, belongsTo, status };
    this.report.accounts.push(row);
    if (loginAs === LOGIN.partner) this.partnerRows.push({ row, contact });
  }
  private readonly svc = buildServices();
  private get partnerSvc() { return this.svc.partner; }

  /**
   * The existing account for a phone and/or email (each looked up exactly as its sign-in does). Refuses when the phone
   * and the email belong to two different accounts: they are never merged.
   */
  private async resolve(label: string, c: Contact, byPhone: (p: string) => PromiseLike<any>, byEmail: (e: string) => PromiseLike<any>,
    isPlaceholder: (row: any) => boolean = () => false): Promise<any | null> {
    const p = c.phone ? await byPhone(c.phone) : null;
    const e = c.email ? await byEmail(c.email) : null;
    if (p && e && String(p._id) !== String(e._id)) {
      const which = isPlaceholder(p) ? 'the one found by phone' : isPlaceholder(e) ? 'the one found by email' : null;
      throw new SeedError(`${label} ${maskContact(c)}: the phone and the email belong to two different existing accounts; refusing to merge them. `
        + (which
          ? `Fix: ${which} is an unverified placeholder created by an earlier code request; remove the unverified placeholder row created by an earlier code request (after checking in the admin app that it has no bookings, bills or orders), then run again.`
          : 'Fix: if one of them is an unverified placeholder created by an earlier code request, remove that row; otherwise list only one of the two (or fix the accounts in the admin app).'));
    }
    return p ?? e;
  }

  /**
   * The identity fields an existing account lacks are added (so both sign-ins work); a different stored value is never
   * replaced. Returns the fields to set (empty: nothing to add).
   */
  private missing(label: string, existing: { phone?: string; email?: string }, c: Contact, canAddPhone = true): Record<string, string> {
    const set: Record<string, string> = {};
    if (c.phone && existing.phone && existing.phone !== c.phone) this.warn(`${label}: found by email with another phone on record (${maskPhone(existing.phone)}); kept`);
    if (c.phone && !existing.phone && canAddPhone) set.phone = c.phone;
    const stored = existing.email?.trim().toLowerCase();
    if (c.email && stored && stored !== c.email) this.warn(`${label}: found by phone with another email on record (${maskEmail(stored)}); kept`);
    if (c.email && !stored) set.email = c.email;
    return set;
  }
  private added = (set: Record<string, string>) => `added ${Object.keys(set).join(' and ')} so both sign-ins work`;

  /** The doctor of a "doctors" entry (by index); a reference that cannot be resolved stops the run with a clear message. */
  private doctorAt(index: number, where: string): DoctorRef {
    const d = this.doctors[index];
    if (!d) throw new SeedError(`${where}: the doctor (doctors[${index}]) could not be resolved to an account`);
    return d;
  }

  // ── Input checks (no database access) ──
  canonical(raw: string, where: string): string {
    const p = canonicalMobile(raw);
    if (!p) throw new SeedError(`${where}: not a 10-digit Indian mobile number (${maskPhone(String(raw))})`);
    return p;
  }
  private contact(c: Contact, where: string): void {
    if (c.phone) c.phone = this.canonical(c.phone, `${where}.phone`);
    if (c.email) c.email = c.email.trim().toLowerCase();
  }

  normalise(): void {
    const i = this.input;
    if ((i.lab || i.clinic) && !i.admin) throw new SeedError('"admin" is required when "lab" or "clinic" is given (partners are created and verified by the admin)');
    if (i.doctorClinic?.signInEmail && !i.admin) throw new SeedError('"admin" is required for doctorClinic.signInEmail (the admin sets it as the clinic owner would)');
    if (i.admin) this.contact(i.admin, 'admin');
    const unique = (list: (string | undefined)[], where: string) => {
      const seen = new Set<string>();
      for (const v of list) {
        if (!v) continue;
        if (seen.has(v)) throw new SeedError(`${where}: ${v.includes('@') ? maskEmail(v) : maskPhone(v)} is listed twice`);
        seen.add(v);
      }
    };
    for (const [n, c] of (i.customers ?? []).entries()) {
      this.contact(c, `customers[${n}]`);
      for (const [m, f] of (c.family ?? []).entries()) {
        f.dateOfBirth = normDob(f.dateOfBirth);
        validated(createDependentSchema, { userId: '000000000000000000000000', name: f.name, relationship: f.relation, gender: f.gender, dateOfBirth: f.dateOfBirth },
          `customers[${n}].family[${m}]`);
      }
    }
    unique((i.customers ?? []).map((c) => c.phone), 'customers');
    unique((i.customers ?? []).map((c) => c.email), 'customers');
    for (const [n, d] of (i.doctors ?? []).entries()) {
      this.contact(d, `doctors[${n}]`);
      validated(createSpecialistSchema, this.doctorPayload(d), `doctors[${n}]`);
    }
    unique((i.doctors ?? []).map((d) => d.phone), 'doctors');
    unique((i.doctors ?? []).map((d) => d.email), 'doctors');
    if (i.pharmacy) {
      this.contact(i.pharmacy, 'pharmacy');
      if (i.pharmacy.phone) validated(createPharmacySchema, this.pharmacyPayload(), 'pharmacy');
    }
    for (const kind of ['lab', 'clinic'] as const) {
      const p = i[kind];
      if (!p) continue;
      p.ownerPhone = this.canonical(p.ownerPhone, `${kind}.ownerPhone`);
      if (p.ownerEmail) p.ownerEmail = p.ownerEmail.trim().toLowerCase();
      p.branch.phone = this.canonical(p.branch.phone, `${kind}.branch.phone`);
      for (const [n, s] of (p.staff ?? []).entries()) this.contact(s, `${kind}.staff[${n}]`);
      unique([p.ownerPhone, ...(p.staff ?? []).map((s) => s.phone)], `${kind} owner and staff phones`);
      unique([p.ownerEmail, ...(p.staff ?? []).map((s) => s.email)], `${kind} owner and staff emails`);
      validated(createPartnerSchema, this.partnerPayload(kind, p), kind);
      validated(createBranchSchema, this.branchPayload(kind, p.branch), `${kind}.branch`);
      for (const [n, s] of (p.staff ?? []).entries()) validated(addMemberSchema, this.staffPayload(kind, s, '000000000000000000000000'), `${kind}.staff[${n}]`);
    }
    /** The index of the "doctors" entry a reference names (by phone or email). */
    const doctorIndex = (ref: Contact, where: string): number => {
      const n = (i.doctors ?? []).findIndex((x) => (ref.phone && x.phone === ref.phone) || (ref.email && x.email === ref.email));
      if (n < 0) throw new SeedError(`${where}: ${maskContact(ref)} is not one of "doctors"`);
      // The services require the doctor's mobile number: it is their clinic-workspace sign-in.
      if (!i.doctors![n]!.phone) throw new SeedError(`${where}: the doctor ${maskContact(ref)} needs a phone in "doctors" (the clinic link uses it as the workspace sign-in)`);
      return n;
    };
    if (i.clinic) {
      this.clinicDoctorRefs = (i.clinic.doctors ?? []).map((item, n) => {
        const ref = typeof item === 'string' ? item : item.doctor;
        const c: Contact = ref.includes('@') ? { email: ref.trim().toLowerCase() } : { phone: this.canonical(ref, `clinic.doctors[${n}]`) };
        return { index: doctorIndex(c, `clinic.doctors[${n}]`), signInEmail: typeof item === 'string' ? undefined : item.signInEmail };
      });
    }
    if (i.doctorClinic) {
      this.contact(i.doctorClinic, 'doctorClinic');
      this.doctorClinicIndex = doctorIndex(i.doctorClinic, 'doctorClinic');
      const d = i.doctors![this.doctorClinicIndex]!;
      i.doctorClinic.phone = d.phone;
      i.doctorClinic.email = d.email;
      if (i.doctorClinic.branch) i.doctorClinic.branch.phone = this.canonical(i.doctorClinic.branch.phone, 'doctorClinic.branch.phone');
      validated(doctorClinicSchema, this.doctorClinicPayload(), 'doctorClinic');
    }
  }

  // ── Payloads (exactly what the admin/app forms send) ──
  private doctorPayload(d: DemoDoctor) {
    const modes = d.modes ?? ['video', 'call', 'chat'];
    return {
      name: d.name, ...(d.phone ? { phone: d.phone } : {}), ...(d.email ? { email: d.email } : {}), specialization: d.specialization, consultationFee: d.fee,
      degree: d.degree ?? 'MBBS', experienceYears: d.experienceYears ?? 8, languages: d.languages ?? ['English', 'Hindi'],
      ...(d.medicalRegistrationNumber ? { medicalRegistrationNumber: d.medicalRegistrationNumber } : {}),
      bio: 'Demo doctor account for testing.', city: DEFAULT_ADDRESS.city, state: DEFAULT_ADDRESS.state,
      availability: { acceptVideoConsultations: modes.includes('video'), acceptChatConsultations: modes.includes('chat') },
      isActive: true, isVerified: true,
    };
  }
  private pharmacyPayload() {
    const p = this.input.pharmacy!;
    return {
      ownerName: 'Demo Pharmacist', address: DEFAULT_ADDRESS.line1, city: DEFAULT_ADDRESS.city, state: DEFAULT_ADDRESS.state, pincode: DEFAULT_ADDRESS.pincode,
      pickupAvailable: true, deliveryAvailable: true, ...p, isActive: true, isVerified: true, walletEnabled: false,
    };
  }
  private partnerPayload(kind: 'lab' | 'clinic', p: DemoPartner) {
    return {
      kind, name: p.name, ...(p.legalName ? { legalName: p.legalName } : {}), contactPhone: p.ownerPhone, ...(p.contactEmail ? { contactEmail: p.contactEmail } : {}),
      taxRegime: 'unregistered', invoiceSeriesPrefix: p.invoiceSeriesPrefix ?? (kind === 'lab' ? 'DLAB' : 'DCLN'),
      firstOwner: { phone: p.ownerPhone, name: p.ownerName, ...(p.ownerEmail ? { email: p.ownerEmail } : {}) },
    };
  }
  private branchPayload(kind: 'lab' | 'clinic', b: DemoBranch) {
    const services = kind === 'lab' ? { homeCollection: true, inLab: true, inClinic: false } : { homeCollection: false, inLab: false, inClinic: true };
    return { name: b.name, phone: b.phone, address: b.address, hours: b.hours ?? OPEN_HOURS, holidays: [], services: { ...services, ...(b.services ?? {}) } };
  }
  private staffPayload(kind: 'lab' | 'clinic', s: DemoStaff, branchId: string) {
    const role = s.role ?? 'staff';
    return {
      phone: s.phone, ...(s.email ? { email: s.email } : {}), name: s.name, role,
      permissions: role === 'owner' ? [...ALL_PERMISSIONS] : (s.permissions ?? (kind === 'lab' ? LAB_STAFF_PERMISSIONS : DESK_PERMISSIONS)),
      ...(role === 'staff' ? { branchIds: [branchId] } : {}),
    };
  }
  private doctorClinicPayload() {
    const dc = this.input.doctorClinic!;
    const doctor = this.input.doctors![this.doctorClinicIndex!]!;
    const name = dc.name ?? `${doctor.name} Clinic`;
    return {
      name, invoiceSeriesPrefix: dc.invoiceSeriesPrefix ?? 'DRC',
      branch: dc.branch ?? { name: `${name} Main`, phone: dc.phone, address: this.input.clinic?.branch.address ?? DEFAULT_ADDRESS },
      requestKey: key('doctor-clinic', dc.phone!),
    };
  }

  // ── Admin ──
  async admin(): Promise<void> {
    const a = this.input.admin;
    if (!a) return;
    this.log('Admin');
    const what = `admin ${maskContact(a)}`;
    // The admin sign-in looks the account up by phone, or by email (AdminRepository.findByPhoneOrEmail).
    const existing = await this.resolve('admin', a, (phone) => AdminModel.findOne({ phone }).lean(), (email) => AdminModel.findOne({ email }).lean()) as any;
    if (existing) {
      this.adminId = String(existing._id);
      if (existing.isActive === false) this.warn(`${what} exists but is inactive: it cannot sign in until reactivated`);
      const set = this.missing(what, existing, a);
      let status: Status = 'found';
      if (Object.keys(set).length) {
        if (this.commit) await AdminModel.updateOne({ _id: existing._id }, { $set: set });
        status = this.commit ? 'updated' : 'would update';
      }
      this.step(what, status, status === 'found' ? undefined : this.added(set));
      this.account('Admin', existing.name ?? '(no name)', { phone: existing.phone ?? set.phone, email: existing.email ?? set.email }, LOGIN.admin, 'Platform', status);
      return;
    }
    if (!this.commit) { this.step(what, 'would create'); this.account('Admin', a.name, a, LOGIN.admin, 'Platform', 'would create'); return; }
    // No admin-creation service exists; the row matches the schema defaults the sign-in checks (userType, isActive).
    const row = await AdminModel.create({ ...(a.phone ? { phone: a.phone } : {}), ...(a.email ? { email: a.email } : {}), name: a.name, userType: 'admin',
      isActive: true, isVerified: true, permissions: [] });
    this.adminId = String(row._id);
    this.step(what, 'created');
    this.account('Admin', row.name ?? a.name, a, LOGIN.admin, 'Platform', 'created');
  }

  // ── Customers and their family ──
  async customers(): Promise<void> {
    if (!this.input.customers?.length) return;
    this.log('Customers');
    for (const c of this.input.customers) {
      const what = `customer ${maskContact(c)}`;
      // The customer sign-in looks up {phone, userType: 'user'} or {email, userType: 'user'} (UserRepository.findByPhoneOrEmail).
      const existing = await this.resolve('customer', c, (phone) => UserModel.findOne({ phone, userType: 'user' }).lean(),
        (email) => UserModel.findOne({ email, userType: 'user' }).lean(), isCustomerPlaceholder) as any;
      // An email that is another customer's corporate email cannot become this one's (as the email-verification rule).
      if (c.email && await UserModel.exists({ userType: 'user', corporateEmail: c.email, ...(existing ? { _id: { $ne: existing._id } } : {}) })) {
        throw new SeedError(`${what}: the email is another customer's corporate email`);
      }
      let userId: string | undefined;
      let status: Status;
      let name = c.name;
      let contact: Contact = c;
      if (existing) {
        userId = String(existing._id);
        name = existing.name || c.name;
        if (existing.isActive === false) this.warn(`${what} exists but is inactive`);
        const set = this.missing(what, existing, c);
        // A code request's sign-up placeholder gets the file's name; an existing name is never changed, and a nameless
        // customer made by a desk, bill or pharmacy is left as it is (it may own bills or orders).
        if (!existing.name && isCustomerPlaceholder(existing)) set.name = c.name;
        else if (!existing.name) { name = '(no name)'; this.warn(`${what}: a nameless customer not made by sign-up (${existing.createdSource ?? 'linked to a pharmacy'}); left as it is`); }
        status = 'found';
        if (Object.keys(set).length) {
          if (this.commit) await UserModel.updateOne({ _id: existing._id }, { $set: set });
          status = this.commit ? 'updated' : 'would update';
        }
        contact = { phone: existing.phone ?? set.phone, email: existing.email ?? set.email };
        this.step(what, status, status === 'found' ? undefined
          : isCustomerPlaceholder(existing) ? `completed a sign-up placeholder (${Object.keys(set).join(', ')})` : `added ${Object.keys(set).join(', ')}`);
      } else if (this.commit) {
        // As the OTP sign-up writes it (self_signup, otpVerified false); the wallet is made at the first sign-in.
        const filter = c.phone ? { phone: c.phone, userType: 'user' } : { email: c.email, userType: 'user' };
        const raw: any = await UserModel.findOneAndUpdate(filter,
          { $setOnInsert: { ...(c.phone ? { phone: c.phone } : {}), ...(c.email ? { email: c.email } : {}), userType: 'user', name: c.name,
            createdSource: 'self_signup', otpVerified: false } },
          { upsert: true, new: true, rawResult: true, runValidators: true });
        userId = String(raw.value._id);
        status = raw.lastErrorObject?.updatedExisting === false ? 'created' : 'found';
        this.step(what, status);
      } else {
        status = 'would create';
        this.step(what, status);
      }
      const family: string[] = [];
      for (const f of c.family ?? []) {
        family.push(`${f.name} (${f.relation})`);
        const fw = `  family member "${f.name}" (${f.relation}) of ${maskContact(c)}`;
        const dep = userId ? await DependentModel.findOne({ userId, relationship: f.relation, isActive: true,
          name: { $regex: `^${escapeRegex(f.name.trim())}$`, $options: 'i' } }).lean() : null;
        if (dep) { this.step(fw, 'found'); continue; }
        if (!this.commit || !userId) { this.step(fw, 'would create'); continue; }
        await this.svc.dependent.create(validated(createDependentSchema,
          { userId, name: f.name, relationship: f.relation, gender: f.gender, dateOfBirth: f.dateOfBirth }, 'family'));
        this.step(fw, 'created');
      }
      this.account('Customer', name, contact, LOGIN.customer, family.length ? `family: ${family.join(', ')}` : '-', status);
    }
  }

  // ── Doctors ──
  async doctorAccounts(): Promise<void> {
    if (!this.input.doctors?.length) return;
    this.log('Doctors');
    const repo = this.svc.specialistRepo;
    const svc = this.svc.specialist;
    for (const [index, d] of this.input.doctors.entries()) {
      const modes = d.modes ?? ['video', 'call', 'chat'];
      const what = `doctor ${maskContact(d)}`;
      // The doctor sign-in looks up the specialist by phone or by email (SpecialistRepository.findByPhoneOrEmail).
      const existing = await this.resolve('doctor', d, (phone) => repo.findByPhoneOrEmail({ phone }), (email) => repo.findByPhoneOrEmail({ email }),
        isSpecialistPlaceholder) as any;
      if (existing) {
        const ref: DoctorRef = { id: String(existing._id), name: existing.name, phone: existing.phone ?? d.phone, email: existing.email ?? d.email,
          eligible: existing.isActive !== false, status: 'found', modes };
        if (existing.isActive === false) {
          this.warn(`${what} exists but is inactive: it cannot sign in, and is not linked or scheduled`);
          ref.status = 'skipped';
        } else {
          const placeholder = isSpecialistPlaceholder(existing);
          // A code request's sign-up placeholder gets the file's whole profile (name, specialization, fee, modes,
          // address); a real profile keeps its own and is only verified (what the admin "verify doctor" action does).
          const { phone: _p, email: _e, ...profile } = this.doctorPayload(d);
          const set: Record<string, unknown> = { ...(placeholder ? profile : {}), ...this.missing(what, existing, d) };
          if (existing.isVerified !== true) set.isVerified = true;
          if (Object.keys(set).length) {
            if (this.commit) await svc.update(String(existing._id), set);
            else if (set.isVerified) ref.eligible = false;
            ref.status = this.commit ? 'updated' : 'would update';
            if (placeholder) ref.name = d.name;
          }
          this.step(what, ref.status, ref.status === 'found' ? undefined : placeholder ? 'completed a sign-up placeholder with the profile from the file'
            : `${set.isVerified ? 'verified (was unverified); ' : ''}${Object.keys(set).filter((k) => k !== 'isVerified').length ? 'added contact' : ''} (name kept)`);
        }
        if (ref.status === 'skipped') this.step(what, 'skipped', 'inactive');
        this.doctors[index] = ref;
        continue;
      }
      if (!this.commit) {
        this.step(what, 'would create');
        this.doctors[index] = { name: d.name, phone: d.phone, email: d.email, eligible: true, status: 'would create', modes };
        continue;
      }
      const created = await svc.create(validated(createSpecialistSchema, this.doctorPayload(d), 'doctor'));
      this.step(what, 'created');
      this.doctors[index] = { id: String(created._id), name: created.name, phone: d.phone, email: d.email, eligible: true, status: 'created', modes };
    }
  }

  // ── Pharmacy ──
  async pharmacy(): Promise<void> {
    const p = this.input.pharmacy;
    if (!p) return;
    this.log('Pharmacy');
    const what = `pharmacy ${maskContact(p)}`;
    const repo = this.svc.pharmacyRepo;
    // The pharmacy sign-in looks it up by phone, or by email (PharmacyRepository.findByPhone / findByEmail).
    const existing = await this.resolve('pharmacy', p, (phone) => repo.findByPhone(phone), (email) => repo.findByEmail(email), isPharmacyPlaceholder) as any;
    if (existing) {
      let status: Status = 'found';
      const placeholder = isPharmacyPlaceholder(existing);
      // A code request's sign-up placeholder gets the file's profile (name, owner, address, services); a real one keeps its own.
      // Checked with the create form's own validation (with the stored phone) before anything is written.
      const { phone: _p, email: _e, ...profile } = placeholder
        ? validated<Record<string, unknown>>(createPharmacySchema, { ...this.pharmacyPayload(), phone: existing.phone }, 'pharmacy') : {};
      const set: Record<string, unknown> = { ...(placeholder ? profile : {}), ...this.missing(what, existing, p) };
      if (existing.isActive === false || existing.archivedAt) {
        this.warn(`${what} exists but is inactive/archived: it cannot sign in until an admin restores it`);
      } else {
        if (existing.isVerified !== true) set.isVerified = true;
        if (Object.keys(set).length) {
          if (this.commit) await this.svc.pharmacy.update(String(existing._id), set);
          status = this.commit ? 'updated' : 'would update';
        }
      }
      this.step(what, status, status === 'found' ? undefined : placeholder ? 'completed a sign-up placeholder with the profile from the file'
        : `${set.isVerified ? 'verified (was unverified) ' : ''}(name kept)`);
      const name = placeholder && status !== 'found' ? p.name : existing.name;
      this.account('Pharmacy', name, { phone: existing.phone, email: existing.email ?? (set.email as string | undefined) }, LOGIN.pharmacy, name, status);
      return;
    }
    // The pharmacy model requires a phone (unique); a new pharmacy cannot be email-only.
    if (!p.phone) throw new SeedError(`${what}: no pharmacy has this email, and a new pharmacy needs a phone (the pharmacy record requires one)`);
    if (!this.commit) { this.step(what, 'would create'); this.account('Pharmacy', p.name, p, LOGIN.pharmacy, p.name, 'would create'); return; }
    const created = await this.svc.pharmacy.create(validated(createPharmacySchema, this.pharmacyPayload(), 'pharmacy'), 'admin');
    this.step(what, 'created');
    this.account('Pharmacy', created.name, p, LOGIN.pharmacy, created.name, 'created');
  }

  // ── Partner members (found by phone or email within the partner, exactly as the sign-in finds memberships) ──
  private async member(partnerId: string | undefined, label: string, c: Contact): Promise<{ m: any | null; status?: Status }> {
    if (!partnerId) return { m: null };
    const m = await this.resolve(label, c, (phone) => MemberModel.findOne({ partnerId, phone, isActive: true }).lean(),
      (email) => MemberModel.findOne({ partnerId, email, isActive: true }).lean()) as any;
    if (!m) return { m: null };
    // A member's phone is never changed here (no service changes it); a missing email is added through the owner's edit.
    const set = this.missing(label, m, c, false);
    if (!set.email) return { m, status: 'found' };
    if (this.commit) await this.partnerSvc.updateMemberEmail(adminActor(this.adminId!, partnerId), String(m._id), set.email, m.updatedAt);
    return { m: { ...m, email: set.email }, status: this.commit ? 'updated' : 'would update' };
  }

  // ── Lab / clinic partner ──
  private async partner(kind: 'lab' | 'clinic', spec: DemoPartner): Promise<{ partnerId?: string; branchId?: string; branchName: string; partnerName: string }> {
    this.log(kind === 'lab' ? 'Lab' : 'Clinic');
    const label = kind === 'lab' ? 'Lab' : 'Clinic';
    const ownerContact: Contact = { phone: spec.ownerPhone, email: spec.ownerEmail };
    const createKey = key(kind, spec.name.toLowerCase(), spec.ownerPhone);
    // Found by name + owner (an active owner membership with the owner phone or email), else by the seeder's create key.
    let partner: any = null;
    for (const p of await PartnerModel.find({ kind, name: spec.name }).sort({ _id: 1 }).lean()) {
      const or: Record<string, string>[] = [{ phone: spec.ownerPhone }, ...(spec.ownerEmail ? [{ email: spec.ownerEmail }] : [])];
      if (await MemberModel.exists({ partnerId: String(p._id), role: 'owner', isActive: true, $or: or })) { partner = p; break; }
    }
    if (!partner && this.adminId) partner = (await this.partnerSvc.findCreatedByKey(this.adminId, createKey))?.partner ?? null;
    const what = `${kind} "${spec.name}" (owner ${maskContact(ownerContact)})`;
    let status: Status;
    if (partner) status = 'found';
    else if (!this.commit) status = 'would create';
    else {
      const body = validated<any>(createPartnerSchema, { ...this.partnerPayload(kind, spec), requestKey: createKey }, kind);
      const r = await this.partnerSvc.createPartner({ ...body, createdBy: this.adminId! });
      partner = r.partner;
      status = r.replayed ? 'found' : 'created';
    }
    this.step(what, status);
    const partnerId = partner ? String(partner._id) : undefined;
    const partnerName = partner?.name ?? spec.name;

    // Verified by the admin, so the workspace, bookings and in-clinic slots work.
    if (partner) {
      const state = partner.verification?.state;
      if (partner.isActive === false || state === 'suspended') this.warn(`${what} is suspended/inactive; it was left as it is (reinstate it in the admin app)`);
      else if (state !== 'verified') {
        if (this.commit) await this.partnerSvc.verifyPartner(partnerId!, this.adminId!);
        this.step(`  verify ${kind}`, this.commit ? 'updated' : 'would update');
      }
    } else this.step(`  verify ${kind}`, 'would update');

    // Owner (made with the partner).
    const { m: owner, status: ownerStatus } = await this.member(partnerId, `${kind} owner`, ownerContact);
    if (partnerId && !owner) this.warn(`${what}: the owner has no active membership (the partner was found by its create key)`);
    if (owner && owner.role !== 'owner') this.warn(`${what}: ${maskContact(ownerContact)} is a ${owner.role} there; kept as it is`);
    if (ownerStatus && ownerStatus !== 'found') this.step(`  owner ${maskContact(ownerContact)}`, ownerStatus, 'added email so both sign-ins work');
    this.account(`${label} owner`, owner?.name ?? spec.ownerName, owner ? { phone: owner.phone, email: owner.email } : ownerContact, LOGIN.partner,
      `${partnerName} (all branches)`, status === 'created' ? 'created' : (owner ? (ownerStatus ?? 'found') : status));

    // Branch.
    const branchBody = validated<any>(createBranchSchema, this.branchPayload(kind, spec.branch), `${kind}.branch`);
    let branch: any = partnerId ? await BranchModel.findOne({ partnerId, name: spec.branch.name, isActive: true }).lean() : null;
    if (branch) this.step(`  branch "${spec.branch.name}"`, 'found');
    else if (!this.commit || !partnerId) this.step(`  branch "${spec.branch.name}"`, 'would create');
    else {
      branch = await this.partnerSvc.createBranch(adminActor(this.adminId!, partnerId), branchBody);
      this.step(`  branch "${spec.branch.name}"`, 'created');
    }
    const branchId = branch ? String(branch._id) : undefined;

    // Staff.
    for (const s of spec.staff ?? []) {
      const sw = `  ${s.role === 'owner' ? 'owner' : 'staff'} ${maskContact(s)}`;
      const found = await this.member(partnerId, sw.trim(), s);
      let st: Status;
      let m = found.m;
      if (m) {
        st = found.status ?? 'found';
        if (m.role !== (s.role ?? 'staff')) this.warn(`${label} member ${maskContact(s)} is a ${m.role} there; kept as it is`);
      } else if (!this.commit || !partnerId || !branchId) st = 'would create';
      else {
        m = await this.partnerSvc.addMember(adminActor(this.adminId!, partnerId), validated(addMemberSchema, this.staffPayload(kind, s, branchId), `${kind}.staff`));
        st = 'created';
      }
      this.step(sw, st, st === 'updated' || st === 'would update' ? 'added email so both sign-ins work' : undefined);
      const role = m?.role ?? s.role ?? 'staff';
      this.account(`${label} ${role === 'owner' ? 'owner' : 'staff'}`, m?.name ?? s.name, m ? { phone: m.phone, email: m.email } : s, LOGIN.partner,
        role === 'owner' ? `${partnerName} (all branches)` : `${partnerName} / ${branch?.name ?? spec.branch.name}`, st);
    }

    // Catalogue (found by its seeder key or by kind + name).
    for (const item of kind === 'lab' ? LAB_CATALOGUE : CLINIC_CATALOGUE) {
      const itemKey = key('item', item.kind, item.name.toLowerCase());
      const cw = `  catalogue ${item.kind} "${item.name}"`;
      const found = partnerId ? await CatalogueItemModel.exists({ partnerId: partnerId.toLowerCase(), $or: [{ createRequestKey: itemKey }, { kind: item.kind, name: item.name }] }) : null;
      if (found) { this.step(cw, 'found'); continue; }
      if (!this.commit || !partnerId) { this.step(cw, 'would create'); continue; }
      await this.svc.catalogue.createItem(adminActor(this.adminId!, partnerId), validated(createCatalogueItemSchema, { ...item, requestKey: itemKey }, 'catalogue'));
      this.step(cw, 'created');
    }
    return { partnerId, branchId, branchName: branch?.name ?? spec.branch.name, partnerName };
  }

  async lab(): Promise<void> {
    const spec = this.input.lab;
    if (!spec) return;
    const { partnerId, branchId } = await this.partner('lab', spec);
    const services = this.branchPayload('lab', spec.branch).services;
    // Weekly slot templates for every visit mode the branch offers (never replacing a saved one).
    for (const mode of ['lab', 'home'] as VisitMode[]) {
      if (!(mode === 'lab' ? services.inLab : services.homeCollection)) continue;
      const tw = `  weekly ${mode === 'lab' ? 'lab-visit' : 'home-collection'} slot template`;
      const existing = branchId ? await PartnerSlotTemplateModel.exists({ branchId, visitMode: mode }) : null;
      if (existing) { this.step(tw, 'found'); continue; }
      if (!this.commit || !partnerId || !branchId) { this.step(tw, 'would create'); continue; }
      const body = validated<any>(slotTemplateSchema, LAB_TEMPLATES[mode], 'slot template');
      const r = await saveSlotTemplate(adminActor(this.adminId!, partnerId), branchId, mode, body);
      this.step(tw, 'created', `${r.expansion.inserted} slots for the next 30 days`);
    }
  }

  async clinic(): Promise<void> {
    const spec = this.input.clinic;
    if (!spec) return;
    const { partnerId, branchId, branchName, partnerName } = await this.partner('clinic', spec);
    // Part payments on in-house bills (Q14), through the same owner-profile change the admin workspace makes.
    const want = spec.allowPartPayments !== false;
    const current = partnerId ? (await PartnerModel.findById(partnerId).select({ allowPartPayments: 1 }).lean() as any)?.allowPartPayments === true : false;
    if (want && current) this.step('  part payments allowed', 'found');
    else if (want) {
      if (this.commit && partnerId) await this.partnerSvc.updateOwnProfile(adminActor(this.adminId!, partnerId), { allowPartPayments: true });
      this.step('  part payments allowed', this.commit ? 'updated' : 'would update');
    }
    // Doctors linked by the admin at the clinic branch (Q14; no invitation step).
    for (const [n, ref] of this.clinicDoctorRefs.entries()) {
      const doc = this.doctorAt(ref.index, `clinic.doctors[${n}]`);
      const lw = `  link doctor ${maskContact(doc)} at "${branchName}"`;
      doc.clinic = { partnerId, branchId, label: `${partnerName} / ${branchName}` };
      const member = doc.id && partnerId ? await MemberModel.findOne({ partnerId, doctorId: doc.id, isActive: true }).lean() as any : null;
      let st: Status;
      let linked = member;
      if (member) st = 'found';
      else if (!this.commit || !doc.id || !partnerId || !branchId) st = 'would create';
      else if (!doc.eligible) { st = 'skipped'; this.warn(`doctor ${maskContact(doc)} is not active and verified; not linked`); }
      else {
        // A new key after each earlier admin link of this doctor here (so a doctor unlinked meanwhile is linked again).
        const n = await ClinicDoctorInviteModel.countDocuments({ partnerId, doctorId: doc.id, via: 'admin_link' });
        const body = validated<any>(linkDoctorSchema, { doctorId: doc.id, branchIds: [branchId], requestKey: key('link', doc.id, String(n)) }, 'link doctor');
        const r = await linkDoctor(adminActor(this.adminId!, partnerId), body);
        linked = await MemberModel.findById(r.memberId).lean();
        st = 'created';
      }
      this.step(lw, st);
      if (st !== 'skipped') {
        // The membership signs in with the doctor's mobile number; a sign-in email only when the file gives one.
        linked = await this.memberSignInEmail(partnerId, linked, ref.signInEmail, `clinic doctor ${maskContact(doc)}`);
        this.account('Clinic doctor', linked?.name ?? doc.name, linked ? { phone: linked.phone, email: linked.email } : { phone: doc.phone, email: ref.signInEmail },
          LOGIN.partner, `${partnerName} / ${branchName} (consults here)`, st);
      }
    }
  }

  async doctorClinic(): Promise<void> {
    const dc = this.input.doctorClinic;
    if (!dc) return;
    this.log("Doctor's own clinic");
    const doc = this.doctorAt(this.doctorClinicIndex!, 'doctorClinic');
    const body = validated<any>(doctorClinicSchema, this.doctorClinicPayload(), 'doctorClinic');
    const what = `clinic of doctor ${maskContact(doc)}`;
    const existing = doc.id ? await PartnerModel.findOne({ soloDoctorId: doc.id }).lean() as any : null;
    let partner: any = existing;
    let st: Status;
    if (existing) st = 'found';
    else if (!this.commit || !doc.id) st = 'would create';
    else if (!doc.eligible) { st = 'skipped'; this.warn(`doctor ${maskContact(doc)} is not active and verified; no clinic created`); }
    else {
      const r = await createSoloPractice(doc.id, body);
      partner = r.partner;
      st = r.created ? 'created' : 'found';
    }
    this.step(what, st, partner ? `verification: ${partner.verification?.state}` : 'starts pending admin verification');
    if (st === 'skipped') return;
    let owner = partner ? await MemberModel.findOne({ partnerId: String(partner._id), doctorId: doc.id, isActive: true }).lean() as any : null;
    owner = await this.memberSignInEmail(partner ? String(partner._id) : undefined, owner, dc.signInEmail, `owner of ${what}`);
    const state = partner?.verification?.state ?? 'pending';
    this.account("Doctor's clinic owner", doc.name, owner ? { phone: owner.phone, email: owner.email } : { phone: doc.phone, email: dc.signInEmail }, LOGIN.partner,
      `${partner?.name ?? body.name}${state === 'verified' ? '' : ' (pending: verify it in the admin app)'}`, st);
  }

  /**
   * A doctor membership's sign-in email, set only when the file gives one, through the owner's member edit (the admin
   * acts as owner). A different stored email is kept; an email another member of the clinic uses is reported, not taken.
   */
  private async memberSignInEmail(partnerId: string | undefined, member: any, email: string | undefined, label: string): Promise<any> {
    if (!email || !member || !partnerId) {
      if (email && !member) this.step(`  sign-in email for ${label}`, 'would update');
      return member;
    }
    if (member.email === email) return member;
    if (member.email) { this.warn(`${label}: has another sign-in email (${maskEmail(member.email)}); kept`); return member; }
    if (!this.commit) { this.step(`  sign-in email for ${label}`, 'would update'); return { ...member, email }; }
    try {
      const updated = await this.partnerSvc.updateMemberEmail(adminActor(this.adminId!, partnerId), String(member._id), email, member.updatedAt);
      this.step(`  sign-in email for ${label}`, 'updated');
      return updated;
    } catch (e: any) {
      if (e?.code !== 'EMAIL_IN_USE') throw e;
      this.warn(`${label}: ${maskEmail(email)} is another member's sign-in email in that clinic; not set`);
      return member;
    }
  }

  /** The in-clinic window the seeder plans, on the six working days. */
  private static readonly CLINIC_WINDOW = { start: '17:00', end: '19:00' };

  // ── Doctor weekly schedules (after the clinic links, so in-clinic windows pass the schedule guard) ──
  async doctorSchedules(): Promise<void> {
    if (!this.doctors.length) return;
    this.log('Doctor schedules');
    for (const doc of this.doctors) {
      const what = `weekly schedule of doctor ${maskContact(doc)}`;
      const saved = doc.id ? await getDoctorSchedule(doc.id) : null;
      if (saved) { await this.completeSchedule(doc, saved, what); this.doctorRow(doc); continue; }
      const inClinic = !!(doc.clinic?.branchId && doc.id && await clinicBranchAllowed(doc.id, doc.clinic.branchId));
      const plannedClinic = !!doc.clinic;
      if (!this.commit || !doc.id) {
        this.step(what, doc.status === 'skipped' ? 'skipped' : 'would create', plannedClinic ? `online + in-clinic at ${doc.clinic!.label}` : 'online');
        this.doctorRow(doc);
        continue;
      }
      if (!doc.eligible) { this.step(what, 'skipped', 'doctor not active and verified'); this.doctorRow(doc); continue; }
      if (plannedClinic && !inClinic) this.warn(`doctor ${maskContact(doc)}: in-clinic windows left out (the clinic link or verification is missing)`);
      const days: Partial<Record<Weekday, IScheduleWindow[]>> = {};
      for (const d of SIX_DAYS) {
        days[d] = [
          { start: '10:00', end: '13:00', modes: doc.modes },
          ...(inClinic ? [{ ...Seeder.CLINIC_WINDOW, modes: ['in-person'] as IScheduleWindow['modes'], branchId: doc.clinic!.branchId! }] : []),
        ];
      }
      const body = validated<any>(scheduleTemplateSchema, { slotMinutes: 30, days }, 'doctor schedule');
      const r = await saveDoctorSchedule(doc.id, body);
      this.step(what, 'created', `${inClinic ? `online + in-clinic at ${doc.clinic!.label}` : 'online'}; ${r.expansion.inserted} slots for the next 30 days`);
      this.doctorRow(doc);
    }
  }

  /**
   * A saved schedule is kept; only the in-clinic windows at a clinic the doctor is now linked to are added (on working
   * days that have none there and no window overlapping it), through the schedule service with its version fence.
   * Windows are never removed or changed.
   */
  private async completeSchedule(doc: DoctorRef, saved: any, what: string): Promise<void> {
    const branchId = doc.clinic?.branchId;
    if (!doc.clinic || !doc.id) { this.step(what, 'found', 'kept as saved'); return; }
    const toMin = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
    const W = Seeder.CLINIC_WINDOW;
    const days: Partial<Record<Weekday, IScheduleWindow[]>> = {};
    for (const [d, list] of Object.entries(saved.days ?? {}) as [Weekday, any[]][]) {
      days[d] = (list ?? []).map((w) => ({ start: w.start, end: w.end, modes: [...w.modes], ...(w.branchId ? { branchId: String(w.branchId) } : {}) }));
    }
    const added: Weekday[] = [];
    for (const d of SIX_DAYS) {
      const list = days[d] ?? [];
      if (branchId && list.some((w) => w.branchId === branchId)) continue;
      if (list.some((w) => toMin(w.start) < toMin(W.end) && toMin(W.start) < toMin(w.end))) continue;
      added.push(d);
    }
    if (!added.length) {
      this.step(what, 'found', 'kept as saved');
      return;
    }
    if (!this.commit || !branchId) { this.step(what, 'would update', `add in-clinic windows at ${doc.clinic.label} (${added.join(', ')})`); return; }
    if (!(await clinicBranchAllowed(doc.id, branchId))) {
      this.warn(`doctor ${maskContact(doc)}: in-clinic windows not added (the clinic link or verification is missing)`);
      this.step(what, 'found', 'kept as saved');
      return;
    }
    for (const d of added) days[d] = [...(days[d] ?? []), { ...W, modes: ['in-person'], branchId }];
    const body = validated<any>(scheduleTemplateSchema, { slotMinutes: saved.slotMinutes, days, expectedUpdatedAt: saved.updatedAt ?? null }, 'doctor schedule');
    const r = await saveDoctorSchedule(doc.id, body);
    this.step(what, 'updated', `added in-clinic windows at ${doc.clinic.label} (${added.join(', ')}); ${r.expansion.inserted} new slots`);
  }

  private doctorRow(doc: DoctorRef) {
    this.account('Doctor', doc.name, doc, LOGIN.doctor, doc.clinic ? `online (${doc.modes.join(', ')}) + ${doc.clinic.label}` : `online (${doc.modes.join(', ')})`, doc.status);
  }

  /** A phone or email with several active workspace memberships chooses the workspace after the code. */
  async markMultiWorkspace(): Promise<void> {
    for (const { row, contact } of this.partnerRows) {
      for (const field of ['phone', 'email'] as const) {
        const v = contact[field];
        if (!v) continue;
        const inDb = await MemberModel.countDocuments({ [field]: v, isActive: true });
        const planned = this.partnerRows.filter((x) => x.contact[field] === v).length;
        if (Math.max(inDb, planned) > 1) { row.loginAs = `${LOGIN.partner} (then choose this workspace)`; break; }
      }
    }
  }
}

/** Runs the whole seeding on the current connection. Dry run unless `commit`. */
export async function runSeed(rawInput: unknown, opts: { commit: boolean; log?: (line: string) => void }): Promise<SeedReport> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const input = validated<DemoInput>(inputSchema, rawInput, 'input file');
  const seeder = new Seeder(input, opts.commit, log);
  seeder.normalise();
  log('Checking collections and indexes…');
  await preflight(!!input.customers?.length);
  log(opts.commit ? 'Writing (re-running is safe: existing records are found and reused).' : 'DRY RUN: nothing is written. Plan:');
  try {
    await seeder.admin();
    await seeder.customers();
    await seeder.doctorAccounts();
    await seeder.pharmacy();
    await seeder.lab();
    await seeder.clinic();
    await seeder.doctorClinic();
    await seeder.doctorSchedules();
    await seeder.markMultiWorkspace();
  } catch (e) {
    // What was done before the failure is still reported (counts, warnings, the accounts so far).
    if (e && typeof e === 'object') (e as { partialReport?: SeedReport }).partialReport = seeder.report;
    throw e;
  }
  return seeder.report;
}

/**
 * Production guard: the operator names the target host and database. SEED_DEMO_HOST must equal the connected host as
 * printed (`host:port`, or `host` alone to match any port) — for a replica-set URI this is the FIRST host listed in
 * MONGODB_URL (what the driver connection reports), not whichever member is primary. SEED_DEMO_DATABASE must equal the
 * connected database exactly. A database whose name contains "prod" is always refused. Returns the refusal, or null.
 */
export function targetRefusal(env: NodeJS.ProcessEnv, databaseName: string, host: string, port?: number | string): string | null {
  if (/prod/i.test(databaseName)) return `REFUSED: database "${databaseName}" looks like production; the demo seeder never writes there.`;
  const hostPort = `${host}:${port ?? '?'}`;
  const wantHost = String(env.SEED_DEMO_HOST ?? '').trim();
  if (!wantHost || (wantHost !== hostPort && wantHost !== host)) {
    return `REFUSED: set SEED_DEMO_HOST=${hostPort} to confirm this is the server to seed (it must match the connected host shown above).`;
  }
  if (env.SEED_DEMO_DATABASE !== databaseName) {
    return `REFUSED: set SEED_DEMO_DATABASE=${databaseName} to confirm this is the database to seed (it must match the connected database exactly).`;
  }
  return null;
}

function printSummary(report: SeedReport, commit: boolean, out: (line: string) => void, partial: boolean) {
  const c = report.counts;
  out(`\n${partial ? 'Before the failure' : commit ? 'Done' : 'Plan'}: ${c.created} created, ${c.found} found, ${c.updated} updated, ${c['would create']} would be created, ${c['would update']} would be updated, ${c.skipped} skipped.`);
  if (report.warnings.length) out(`Warnings:\n  - ${report.warnings.join('\n  - ')}`);
  out(`\nAccounts${partial ? ' so far' : ''} (sign in with the phone number or the email; the code arrives by SMS or by email):\n${formatTable(report)}`);
}

export function formatTable(report: SeedReport): string {
  const head = ['Role', 'Name', 'Phone / email', 'Sign in as', 'Belongs to', 'Status'];
  const rows = report.accounts.map((a) => [a.role, a.name, a.signIn, a.loginAs, a.belongsTo, a.status]);
  const width = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i]!.length)));
  const line = (r: string[]) => r.map((c, i) => c.padEnd(width[i]!)).join(' | ');
  return [line(head), width.map((w) => '-'.repeat(w)).join('-+-'), ...rows.map(line)].join('\n');
}

/** CLI entry (exported for the integration test). Returns the exit code; never throws. */
export async function cli(argv: string[], env: NodeJS.ProcessEnv = process.env, out: (line: string) => void = (l) => console.log(l)):
  Promise<{ code: number; report?: SeedReport }> {
  const commit = argv.includes('--commit');
  const file = argv.find((a) => !a.startsWith('--'));
  if (env.SEED_DEMO_ALLOWED !== 'true') {
    out('REFUSED: set SEED_DEMO_ALLOWED=true to run the demo-account seeder (stage runs with NODE_ENV=production, so this is the explicit opt-in).');
    return { code: 2 };
  }
  if (!file) { out('Usage: SEED_DEMO_ALLOWED=true SEED_DEMO_HOST=<host:port> SEED_DEMO_DATABASE=<database> npm run seed:demo -- <demo-accounts.json> [--commit]'); return { code: 2 }; }
  let input: any;
  try { input = JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')); }
  catch (e) { out(`Cannot read ${path.basename(file)}: ${redact((e as Error).message)}`); return { code: 2 }; }
  if (commit && input?._example) {
    out('REFUSED: this is the example file. Copy it to demo-accounts.json, put in phone numbers you control and remove the "_example" line.');
    return { code: 2 };
  }
  const connectHere = mongoose.connection.readyState !== 1;
  try {
    if (connectHere) await mongoose.connect(CONFIG.MONGODB_URL, { autoCreate: false, autoIndex: false });
    const conn = mongoose.connection;
    const databaseName = conn.db.databaseName;
    // Host and database only (never the connection string, which may carry credentials).
    out(`Target: host ${conn.host ?? '?'}:${conn.port ?? '?'}   database ${databaseName}   NODE_ENV=${env.NODE_ENV ?? '(unset)'}   mode: ${commit ? 'COMMIT (writes)' : 'DRY RUN (no writes)'}`);
    const refusal = targetRefusal(env, databaseName, String(conn.host ?? '?'), conn.port);
    if (refusal) { out(refusal); return { code: 2 }; }
    const report = await runSeed(input, { commit, log: out });
    printSummary(report, commit, out, false);
    if (!commit) out('\nNothing was written. Re-run with --commit to create what is missing.');
    return { code: 0, report };
  } catch (e) {
    const partial = (e as { partialReport?: SeedReport })?.partialReport;
    if (partial) printSummary(partial, commit, out, true);
    out(`FAILED: ${redact(e instanceof Error ? e.message : String(e))}`);
    if (commit) out('Whatever was completed before the failure is kept; fix the cause and run again (existing records are reused).');
    return { code: 1 };
  } finally {
    if (connectHere) await mongoose.disconnect();
  }
}

if (require.main === module) {
  cli(process.argv.slice(2)).then((r) => { process.exitCode = r.code; }).catch((e) => { console.error(redact(String(e?.message ?? e))); process.exit(1); });
}
