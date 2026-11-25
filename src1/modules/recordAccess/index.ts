import { AppError } from '@/modules/common/types';
import { assertUniqueIndex } from '@/modules/common/utils/requiredIndex';
import { runLedgerTransaction } from '@/modules/common/utils/bookingWalletFunding';
import { isDuplicateKeyError } from '@/modules/common/utils/mongoErrors';
import BookingModel from '@/modules/bookings/model';
import UserModel from '@/modules/user/model';
import DependentModel from '@/modules/dependents/model';
import SpecialistModel from '@/modules/specialists/model';
import PartnerOrgModel from '@/modules/partners/model';
import { PartnerLabBookingModel } from '@/modules/partners/model/labBooking';
import { doctorIsEligible } from '@/modules/specialists/eligibility';
import { assistedFlags } from '@/modules/assisted/flags';
import { auditIn, sendAssistedNotices } from '@/modules/assisted/support';
import { hasPrescription } from '@/modules/assisted/rxAccess';
import { IDENTITY_NOTE, notDisputed, unpaidCardBooking } from '@/modules/assisted/views';
import { LAB_NOT_DISPUTED_QUERY, labNotDisputed } from '@/modules/assisted/labViews';
import { openOwnTreatingBooking, ownTreatingBookings } from '@/modules/assisted/treating';
import {
  RecordAccessGrantModel, RecordAccessRequestModel, RecordReadModel, type IRecordAccessGrant, type IRecordAccessRequest, type IRecordRead,
} from '@/modules/recordAccess/model';

/**
 * r30 (round 3f, §25.9): records access while a doctor treats a patient.
 * - The history of a treating booking: the doctor's own consultations with that person, and — with the account holder's
 *   grant in force, inside the treating window and with RECORDS_ACCESS_ENABLED — other providers' prescriptions and
 *   released partner-lab reports (allowlisted, DR24).
 * - The doctor asks; the holder allows or denies in the app (owner decision Q1). The SMS code is a seam (phase 5, §27.9).
 * - Every history read and every other-provider file read is logged before the answer (DR25, 503 when it cannot be).
 */
type Row = Record<string, any>;
const HEX = /^[0-9a-fA-F]{24}$/;
const DAY = 86_400_000;
const lower = (v: unknown) => String(v ?? '').toLowerCase();
const err = (status: number, code: string, message: string) => new AppError({ status, code, message });
const recordsOff = () => err(503, 'RECORDS_ACCESS_DISABLED', 'Records access is not switched on yet');
const notPending = (state: string) => err(409, 'RECORDS_REQUEST_NOT_PENDING', `This request is already ${state}`);

/** The person of a consultation (§25.9.2): its family member's id, else 'self'. */
export const personKeyOf = (b: Row): string => (b?.dependentId ? lower(b.dependentId) : 'self');
const labPersonKeyOf = (b: Row): string => (b?.patient?.kind === 'dependent' && b.patient.dependentId ? lower(b.patient.dependentId) : 'self');
/** Consultations of one person of the account. */
export const personQuery = (personKey: string) => ({ dependentId: personKey === 'self' ? { $in: [null, ''] } : { $in: [personKey, personKey.toUpperCase()] } });
const labPersonQuery = (personKey: string) => (personKey === 'self' ? { 'patient.kind': { $ne: 'dependent' } }
  : { 'patient.dependentId': { $in: [personKey, personKey.toUpperCase()] } });
/** A pending request past its expiry shows as expired before the sweep marks it. */
const shownState = (r: { state: string; expiresAt: Date }, now: Date) => (r.state === 'pending' && new Date(r.expiresAt) <= now ? 'expired' : r.state);
const yearAfter = (t: Date) => { const d = new Date(t); d.setUTCFullYear(d.getUTCFullYear() + 1); return d; };

/** §25.9.7: the unique indexes every records-access write relies on (503 INDEXES_OUTDATED until sync-indexes). */
async function assertRecordIndexes(): Promise<void> {
  await assertUniqueIndex(RecordAccessRequestModel, { treatingBookingId: 1, specialistId: 1 });
  await assertUniqueIndex(RecordAccessGrantModel, { holderUserId: 1, personKey: 1, specialistId: 1 });
}

/** The grant in force for this doctor and person (not revoked, not past its 12 months). */
const grantInForce = (holderUserId: string, personKey: string, specialistId: string, now: Date) =>
  RecordAccessGrantModel.findOne({ holderUserId, personKey, specialistId: lower(specialistId), revokedAt: null, expiresAt: { $gt: now } }).lean();

/** DR25: written before the answer, with no switch; when it cannot be written the read is refused (503, nothing sent). */
export async function logRecordRead(row: Omit<IRecordRead, 'at'>): Promise<void> {
  try {
    await RecordReadModel.create([{ ...row, at: new Date() }]);
  } catch {
    throw err(503, 'READ_LOG_UNAVAILABLE', 'Records cannot be shown right now; please try again');
  }
}

/**
 * §25.9.3: the doctor's treating booking for the history (its eligibility is checked by the route): its own consultation
 * of this account and person (404), inside its window (409), with the grant in force and the booking's latest request.
 */
export async function treatingAccess(specialistId: string, userId: string, bookingId: string, dependentId: string | undefined, now = new Date()) {
  const { booking: b, window } = await openOwnTreatingBooking(specialistId, bookingId, now,
    (x) => lower(x.userId) === lower(userId) && (!dependentId || lower(dependentId) === personKeyOf(x)));
  const holderUserId = lower(b.userId);
  const personKey = personKeyOf(b);
  const [grant, request] = await Promise.all([
    grantInForce(holderUserId, personKey, specialistId, now),
    RecordAccessRequestModel.findOne({ treatingBookingId: lower(b._id), specialistId: lower(specialistId) }).sort({ createdAt: -1 }).lean(),
  ]);
  return {
    holderUserId, personKey, treatingBookingId: lower(b._id), granted: !!grant,
    access: {
      window: { opensAt: window.opensAt, closesAt: window.closesAt },
      grant: grant ? { at: grant.at, expiresAt: grant.expiresAt, via: grant.via } : null,
      request: request ? { state: shownState(request, now), createdAt: request.createdAt, expiresAt: request.expiresAt } : null,
      ...(b.assisted ? { identityNote: IDENTITY_NOTE } : {}),
    },
  };
}

/**
 * DR24: other providers' records of the person, allowlisted — consultations of other doctors with a doctor-saved
 * prescription (an admin clear removes it), and released partner-lab reports (drafts never). Never notes, documents,
 * contact details, price, payment, meeting links or the `assisted` block. A row under an open "not mine" report is left out.
 */
export async function othersOf(specialistId: string, holderUserId: string, personKey: string) {
  const sid = lower(specialistId);
  const [rx, labs] = await Promise.all([
    BookingModel.find({ userId: holderUserId, bookingType: 'consultation', specialistId: { $nin: [sid, sid.toUpperCase()] },
      'lifecycle.prescriptionUploaded.at': { $exists: true }, ...personQuery(personKey) }).sort({ bookingDate: -1, createdAt: -1 }).lean() as unknown as Promise<Row[]>,
    PartnerLabBookingModel.find({ userId: holderUserId, 'report.releases.0': { $exists: true }, ...LAB_NOT_DISPUTED_QUERY, ...labPersonQuery(personKey) })
      .sort({ 'slot.startsAt': -1 }).lean() as unknown as Promise<Row[]>,
  ]);
  const consultations = rx.filter((b) => hasPrescription(b) && notDisputed(b) && !unpaidCardBooking(b));
  const ids = (xs: unknown[]) => [...new Set(xs.map(lower))].filter((x) => HEX.test(x));
  const [doctors, partners] = await Promise.all([
    SpecialistModel.find({ _id: { $in: ids(consultations.map((b) => b.specialistId)) } }).select({ name: 1, specialization: 1 }).lean(),
    PartnerOrgModel.find({ _id: { $in: ids(labs.map((b) => b.partnerId)) } }).select({ name: 1 }).lean(),
  ]);
  const doctorBy = new Map(doctors.map((d) => [lower(d._id), d as Row]));
  const partnerBy = new Map(partners.map((p) => [lower(p._id), p as Row]));
  return {
    consultations: consultations.map((b) => {
      const p = b.prescription as Row;
      const d = doctorBy.get(lower(b.specialistId));
      return {
        bookingId: String(b._id), date: b.bookingDate ?? null, doctorName: d?.name ?? p.prescribedBySpecialistName ?? null,
        specialization: d?.specialization ?? null, consultationMode: b.consultationMode ?? null, diagnosis: p.diagnosis ?? null,
        advice: p.advice ?? null,
        medicines: (p.medicines ?? []).map((m: Row) => ({ name: m.name, dosage: m.dosage, frequency: m.frequency, instructions: m.instructions, duration: m.duration })),
        testsAdvised: p.testsAdvised ?? [], recommendationCode: p.recommendationCode ?? null, prescribedAt: p.prescribedAt ?? null,
        // DR26: the full PDF (readable under the grant), never the dispensing copy.
        prescriptionFile: (p.fileUrls ?? []).slice(-1)[0] ?? null,
      };
    }),
    labReports: labs.map((b) => ({
      labBookingId: String(b._id), labName: partnerBy.get(lower(b.partnerId))?.name ?? null, date: b.slot?.date ?? null,
      tests: (b.items ?? []).map((i: Row) => i.name),
      releases: (b.report?.releases ?? []).map((r: Row) => ({ file: `/api/static/${r.path}`, releasedAt: r.releasedAt,
        signer: { name: r.signer?.name, kind: r.signer?.kind, registrationNumber: r.signer?.registrationNumber } })),
    })),
  };
}

/**
 * Phase 5 seam (§25.9.4, §27.9): sends the holder a records code by SMS and says whether the gateway accepted it. Phase 3
 * has none ("unavailable"): approval is in the app only (Q1). The follow-up after 5a makes the 6-digit code, stores its
 * HMAC on the request (`codeHash`, `codeExpiresAt` = +10 min) and adds `…/records-access/confirm`.
 */
export type RecordsCodeSender = (r: { requestId: string; holderUserId: string; patientFirstName: string }) => Promise<boolean>;
const noCodeSender: RecordsCodeSender = async () => false;
let codeSender: RecordsCodeSender = noCodeSender;
export function setRecordsCodeSender(s?: RecordsCodeSender): RecordsCodeSender {
  const prev = codeSender;
  codeSender = s ?? noCodeSender;
  return prev;
}

/**
 * POST /specialists/me/bookings/:id/records-access/request (§25.9.4): inside the treating window, a pending request to the
 * account holder; an older pending one of this booking is `replaced`. It expires at the earlier of 24 hours and the
 * window's close (DR21). A grant already in force answers it and creates nothing. Two requests at once: the unique pending
 * index lets one in at a time (the transaction retries the other, or it answers the pending one).
 */
export async function requestRecordsAccess(specialistId: string, bookingId: string, now = new Date()) {
  if (!assistedFlags.records()) throw recordsOff();
  await assertRecordIndexes();
  const { booking: b, window } = await openOwnTreatingBooking(specialistId, bookingId, now);
  const sid = lower(specialistId);
  const holderUserId = lower(b.userId);
  const personKey = personKeyOf(b);
  const treatingBookingId = lower(b._id);
  const grant = await grantInForce(holderUserId, personKey, sid, now);
  if (grant) return { created: false, data: { state: 'approved' as const, grant: { at: grant.at, expiresAt: grant.expiresAt, via: grant.via } } };
  const [holder, dependent, doctor] = await Promise.all([
    UserModel.findById(holderUserId).select({ name: 1, otpVerified: 1 }).lean(),
    personKey === 'self' ? null : DependentModel.findById(personKey).select({ name: 1 }).lean(),
    SpecialistModel.findById(sid).select({ name: 1 }).lean(),
  ]);
  const answer = (r: { _id?: unknown; expiresAt: Date }, sms: boolean) => ({ requestId: String(r._id), state: 'pending' as const, expiresAt: r.expiresAt,
    channels: { app: holder?.otpVerified === true, sms } });
  let row: IRecordAccessRequest;
  try {
    // The older pending request is replaced and the new one inserted together (racing requests retry in turn).
    row = await runLedgerTransaction(async (s) => {
      await RecordAccessRequestModel.updateMany({ treatingBookingId, specialistId: sid, state: 'pending' }, { $set: { state: 'replaced', decidedAt: now } }, { session: s });
      const [created] = await RecordAccessRequestModel.create([{ holderUserId, personKey, ...(personKey === 'self' ? {} : { dependentId: personKey }), specialistId: sid,
        treatingBookingId, state: 'pending', wrongTries: 0, expiresAt: new Date(Math.min(now.getTime() + DAY, window.closesAt!.getTime())), createdAt: now }], { session: s });
      return created!;
    });
  } catch (e) {
    if (!isDuplicateKeyError(e)) throw e;
    const open = await RecordAccessRequestModel.findOne({ treatingBookingId, specialistId: sid, state: 'pending' }).lean();
    if (!open) throw err(409, 'RECORDS_REQUEST_CHANGED', 'The request changed meanwhile; please try again');
    return { created: false, data: answer(open, false) };
  }
  const firstName = String((dependent ?? holder)?.name ?? '').trim().split(/\s+/)[0] || 'your family member';
  // The holder's notice names the doctor and the patient's first name only, never health details.
  await sendAssistedNotices([{ audience: 'customer', userId: holderUserId, type: 'general', title: 'A doctor asks to see past health records',
    message: `Your doctor, ${String(doctor?.name ?? '').trim() || 'a Jansetu doctor'}, asks to see ${firstName}'s past health records. Open Jansetu to allow or deny.`,
    bookingId: treatingBookingId, key: `records_access:${String(row._id)}:requested`, data: { kind: 'records_access_request', requestId: String(row._id) } }]);
  // SMS phase 5: the records code (§10.6), sent at once through the code sender when one exists.
  const sms = await codeSender({ requestId: String(row._id), holderUserId, patientFirstName: firstName }).catch(() => false);
  return { created: true, data: answer(row, sms === true) };
}

/** Whether a pending request may still be answered: before its expiry, and its booking still treats this holder's person. */
async function requestStillOpen(r: IRecordAccessRequest, now: Date): Promise<boolean> {
  if (new Date(r.expiresAt).getTime() <= now.getTime()) return false;
  const own = (await ownTreatingBookings(r.specialistId, { _id: r.treatingBookingId }, now))[0];
  // §17.5 item 3: a booking moved to another account no longer carries the old holder's request.
  return !!own && own.window.open && lower(own.booking.userId) === r.holderUserId && personKeyOf(own.booking) === r.personKey;
}
const expireRequest = async (r: IRecordAccessRequest, now: Date) =>
  (await RecordAccessRequestModel.updateOne({ _id: r._id, state: 'pending' }, { $set: { state: 'expired', decidedAt: now } })).modifiedCount === 1;

/** DR21: the expiry sweep — pending requests past 24 h, or whose treating window closed (cancelled, no-show, moved, ended). */
export async function expireRecordRequests(now = new Date()): Promise<number> {
  let expired = 0;
  for await (const r of RecordAccessRequestModel.find({ state: 'pending' }).lean().cursor()) {
    if (!(await requestStillOpen(r as IRecordAccessRequest, now)) && await expireRequest(r as IRecordAccessRequest, now)) expired++;
  }
  return expired;
}

/** Names for the holder's lists: the doctor and the family member (null for the holder themself). */
async function holderViews<T extends { _id?: unknown; specialistId: string; personKey: string }>(rows: T[], shape: (r: T) => Row) {
  const [doctors, deps] = await Promise.all([
    SpecialistModel.find({ _id: { $in: [...new Set(rows.map((r) => r.specialistId))].filter((x) => HEX.test(x)) } }).select({ name: 1, specialization: 1 }).lean(),
    DependentModel.find({ _id: { $in: [...new Set(rows.map((r) => r.personKey))].filter((x) => HEX.test(x)) } }).select({ name: 1 }).lean(),
  ]);
  const doctorBy = new Map(doctors.map((d) => [lower(d._id), d as Row]));
  const depBy = new Map(deps.map((d) => [lower(d._id), d as Row]));
  return rows.map((r) => ({ _id: String(r._id), ...shape(r),
    doctor: { id: r.specialistId, name: doctorBy.get(r.specialistId)?.name ?? null, specialization: doctorBy.get(r.specialistId)?.specialization ?? null },
    patient: { personKey: r.personKey, name: r.personKey === 'self' ? null : depBy.get(r.personKey)?.name ?? null } }));
}
const requestShape = (now: Date) => (r: IRecordAccessRequest) => ({ state: shownState(r, now), treatingBookingId: r.treatingBookingId, createdAt: r.createdAt,
  expiresAt: r.expiresAt, decidedAt: r.decidedAt ?? null });
const grantShape = (now: Date) => (g: IRecordAccessGrant) => ({ state: g.revokedAt ? 'revoked' : new Date(g.expiresAt) <= now ? 'expired' : 'active',
  via: g.via, at: g.at, expiresAt: g.expiresAt, revokedAt: g.revokedAt ?? null });

/** GET /records-access/requests?state= — the holder's requests, newest first (50). */
export async function holderRequests(holderUserId: string, state: string | undefined, now = new Date()) {
  const q = { holderUserId: lower(holderUserId), ...(state ? { state } : {}), ...(state === 'pending' ? { expiresAt: { $gt: now } } : {}) };
  return holderViews(await RecordAccessRequestModel.find(q).sort({ createdAt: -1 }).limit(50).lean() as IRecordAccessRequest[], requestShape(now));
}

/**
 * POST /records-access/requests/:id/approve | deny — the account holder only (another account: 404). CAS on `pending`;
 * an expired request (24 h, a closed window, a moved booking) is marked so and answers 409. Approve upserts the grant
 * (`via: 'app'`, 12 months; a revoked one is renewed).
 */
export async function decideRecordsRequest(holderUserId: string, requestId: string, decision: 'approve' | 'deny', now = new Date()) {
  if (!assistedFlags.records()) throw recordsOff();
  await assertRecordIndexes();
  const r = HEX.test(requestId) ? await RecordAccessRequestModel.findOne({ _id: requestId, holderUserId: lower(holderUserId) }).lean() as IRecordAccessRequest | null : null;
  if (!r) throw err(404, 'RECORDS_REQUEST_NOT_FOUND', 'Request not found');
  if (r.state !== 'pending') throw notPending(r.state);
  if (!(await requestStillOpen(r, now))) {
    await expireRequest(r, now);
    throw err(409, 'RECORDS_REQUEST_EXPIRED', 'This request has expired');
  }
  const state = decision === 'approve' ? 'approved' : 'denied';
  const grant = await runLedgerTransaction(async (s) => {
    const done = await RecordAccessRequestModel.updateOne({ _id: r._id, state: 'pending' },
      { $set: { state, decidedAt: now, ...(decision === 'approve' ? { via: 'app' } : {}) } }, { session: s });
    if (done.modifiedCount !== 1) throw notPending('answered');
    if (decision === 'deny') return null;
    return RecordAccessGrantModel.findOneAndUpdate({ holderUserId: r.holderUserId, personKey: r.personKey, specialistId: r.specialistId },
      { $set: { ...(r.dependentId ? { dependentId: r.dependentId } : {}), via: 'app', requestId: String(r._id), at: now, expiresAt: yearAfter(now), revokedAt: null },
        $unset: { revokedBy: 1, revokedByKind: 1, revokeReason: 1 } }, { upsert: true, new: true, session: s }).lean() as unknown as Promise<IRecordAccessGrant>;
  });
  const [request] = await holderViews([{ ...r, state, decidedAt: now }], requestShape(now));
  return { request, grant: grant ? (await holderViews([grant], grantShape(now)))[0] : null };
}

/** GET /records-access/grants — who can see the holder's records (newest first). */
export async function holderGrants(holderUserId: string, now = new Date()) {
  return holderViews(await RecordAccessGrantModel.find({ holderUserId: lower(holderUserId) }).sort({ at: -1 }).limit(100).lean() as IRecordAccessGrant[], grantShape(now));
}

/**
 * Revoke (holder: its own grants, 404 otherwise; admin: any, with a reason, audited). CAS on `revokedAt: null`; a grant
 * already revoked answers `alreadyRevoked`. Works whatever the switch says.
 */
export async function revokeRecordsGrant(by: { kind: 'holder' | 'admin'; id: string }, grantId: string, reason?: string, now = new Date()) {
  const g = HEX.test(grantId)
    ? await RecordAccessGrantModel.findOne({ _id: grantId, ...(by.kind === 'holder' ? { holderUserId: lower(by.id) } : {}) }).lean() as IRecordAccessGrant | null : null;
  if (!g) throw err(404, 'RECORDS_GRANT_NOT_FOUND', 'Grant not found');
  const after = g.revokedAt ? null : await runLedgerTransaction(async (s) => {
    const u = await RecordAccessGrantModel.findOneAndUpdate({ _id: g._id, revokedAt: null },
      { $set: { revokedAt: now, revokedBy: lower(by.id), revokedByKind: by.kind, ...(reason ? { revokeReason: reason } : {}) } }, { new: true, session: s }).lean();
    if (u && by.kind === 'admin') {
      await auditIn({ actorKind: 'admin', actorId: lower(by.id), orgKind: 'doctor', orgId: g.specialistId, action: 'records.grant_revoked',
        detail: { grantId: String(g._id), holderUserId: g.holderUserId, personKey: g.personKey } }, s);
    }
    return u as IRecordAccessGrant | null;
  });
  const grant = after ?? await RecordAccessGrantModel.findById(g._id).lean() as IRecordAccessGrant;
  return { grant: by.kind === 'holder' ? (await holderViews([grant], grantShape(now)))[0] : grant, alreadyRevoked: !after };
}

/** Admin: grants by holder and/or doctor (newest first). */
export function adminGrants(q: { holderUserId?: string; specialistId?: string; limit?: number }) {
  return RecordAccessGrantModel.find({ ...(q.holderUserId ? { holderUserId: lower(q.holderUserId) } : {}), ...(q.specialistId ? { specialistId: lower(q.specialistId) } : {}) })
    .sort({ at: -1 }).limit(q.limit ?? 50).lean();
}

/** Admin: the read log by holder and/or doctor and time (newest first; ids only). */
export function adminReads(q: { holderUserId?: string; doctorId?: string; from?: Date; to?: Date; limit?: number }) {
  return RecordReadModel.find({ ...(q.holderUserId ? { holderUserId: lower(q.holderUserId) } : {}), ...(q.doctorId ? { doctorId: lower(q.doctorId) } : {}),
    ...(q.from || q.to ? { at: { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lt: q.to } : {}) } } : {}) }).sort({ at: -1 }).limit(q.limit ?? 100).lean();
}

/**
 * §25.9.5 (DR26): whether a treating doctor reads this file of ANOTHER booking under the holder's grant — the full
 * prescription PDF of a consultation with a doctor-saved prescription, or a released partner-lab report — and the read-log
 * row to write first. Needs the switch, a verified and active doctor, the grant in force for the file's person and an
 * open treating booking of this doctor for that person. (The admin-clear and "still holds the file" checks are the
 * caller's, `file/access.ts`.)
 */
export async function grantedFileRead(doctorId: string, f: { kind: 'booking' | 'lab_booking'; id: string; path: string }, now = new Date())
  : Promise<Omit<IRecordRead, 'at'> | null> {
  if (!assistedFlags.records() || !HEX.test(f.id) || !(await doctorIsEligible(doctorId))) return null;
  const source = (f.kind === 'booking'
    ? await BookingModel.findById(f.id).select({ userId: 1, dependentId: 1, specialistId: 1, prescription: 1, lifecycle: 1, assisted: 1 }).lean()
    : await PartnerLabBookingModel.findById(f.id).select({ userId: 1, patient: 1, 'report.releases': 1, 'assisted.identity': 1, 'desk.identity': 1 }).lean()) as Row | null;
  if (!source) return null;
  const readable = f.kind === 'booking' ? hasPrescription(source) && notDisputed(source) && !unpaidCardBooking(source)
    : labNotDisputed(source) && (source.report?.releases ?? []).some((r: Row) => r.path === f.path);
  if (!readable) return null;
  const holderUserId = lower(source.userId);
  const personKey = f.kind === 'booking' ? personKeyOf(source) : labPersonKeyOf(source);
  if (!(await grantInForce(holderUserId, personKey, doctorId, now))) return null;
  const treating = (await ownTreatingBookings(doctorId, { userId: holderUserId, status: { $nin: ['cancelled', 'no_show'] }, ...personQuery(personKey) }, now))
    .find((t) => t.window.open);
  return treating ? { doctorId: lower(doctorId), holderUserId, personKey, treatingBookingId: lower(treating.booking._id), scope: 'file', path: f.path,
    sourceBookingId: lower(f.id) } : null;
}
