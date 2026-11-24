import mongoose, { isValidObjectId } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { doctorIsEligible } from '@/modules/specialists/eligibility';
import type { AuthRequest } from '@/modules/middleware/auth';
import BookingModel from '@/modules/bookings/model';
import PharmacyOrderModel from '@/modules/pharmacyOrders/model';
import ExternalBookingModel from '@/modules/externalBookings/model';
import { PartnerLabBookingModel } from '@/modules/partners/model/labBooking';
import PartnerMemberModel from '@/modules/partners/model/member';
import PartnerOrgModel from '@/modules/partners/model';
import { hasPrescription, isOperationalPharmacy, rxWindowOpenFor } from '@/modules/assisted/rxAccess';
import { bookerReportWindowOpen } from '@/modules/assisted/labViews';
import { notDisputed } from '@/modules/assisted/views';
import { dispensingHashOf, WITH_COPY_STATE } from '@/modules/assisted/dispensingCopy';
import { FileGrantModel, FileUploadModel, type GrantKind } from './model/access';
import { BookingAdminClearModel } from '@/modules/bookings/model/adminClear';

/**
 * D1 — one access decision for every legacy upload-dir route (/api/static, /api/v1/file/static, /api/v1/file/fetch).
 * Authority comes only from trusted facts: the recorded uploader, grants written after an attach-time check (or by the
 * curated legacy manifest) and exact server-owned folders. A URL stored in a writable field grants nothing.
 * Nothing is cached: each request reads the facts.
 */
export type Reader = NonNullable<AuthRequest['user']>;
export type Decision = { allow: true; visibility: 'public' | 'private' } | { allow: false; status: 401 | 404 };

const id = (v: unknown) => (v == null ? '' : String(v));
/** Canonical record id for binding keys: ObjectId hex is lower-cased, so every spelling of a record maps to one slot. */
const canon = (v: unknown): string => { const s = id(v).trim(); return /^[0-9a-fA-F]{24}$/.test(s) ? s.toLowerCase() : s; };
const specialistOf = (r: Reader) => id(r.specialistId ?? r._id);
const pharmacyOf = (r: Reader) => id(r.pharmacyId ?? r._id);

/** Exact server-written folders (never client uploads: those modules are reserved). */
const BOOKING_PRESCRIPTION = /^bookings\/([0-9a-f]{24})\/prescription-\d+\.pdf$/;
/** Assisted booking phase 0 (D15): the server-made dispensing copy of a prescription (no diagnosis). */
const BOOKING_RX_DISPENSE = /^bookings\/([0-9a-f]{24})\/rx-dispense-\d+(?:-[0-9a-f]{16})?\.pdf$/;
const LAB_REPORT = /^external-bookings\/([0-9a-f]{24})\/diagnostics-report-[A-Za-z0-9_-]+\.pdf$/;
export const RESERVED_UPLOAD_MODULES = new Set(['bookings', 'external-bookings', 'payouts', 'partner-lab-reports']);
/** Q3: partner lab report files are readable only through their report bindings (never the uploader shortcut). */
const PARTNER_LAB_REPORT = /^partner-lab-reports\//;

/**
 * A booking's files (full prescription PDF, documents, report): the patient, the booking's doctor and HR of its corporate.
 * Assisted booking phase 0 (§9.2): the pharmacy that booked it no longer reads them — it reads only the dispensing copy
 * (canReadDispensingCopy), never the full PDF, the documents or the report. (Files a pharmacy uploaded itself stay
 * readable to it through the uploader rule.)
 */
async function canReadBooking(r: Reader, bookingId: string): Promise<boolean> {
  if (!isValidObjectId(bookingId)) return false;
  const b = await BookingModel.findById(bookingId).select({ userId: 1, specialistId: 1, corporateId: 1 }).lean();
  if (!b) return false;
  switch (r.userType) {
    case 'user': return id(b.userId) === id(r._id);
    // S5 review: a doctor reads a booking's files only while verified and active (its own profile documents are judged
    // by their 'specialist' binding, not here). Assisted phase 0 (§9.2): the booking pharmacy no longer reads them.
    case 'specialist': return !!b.specialistId && id(b.specialistId) === specialistOf(r) && await doctorIsEligible(specialistOf(r));
    case 'hr': return !!r.corporateId && !!b.corporateId && id(b.corporateId) === id(r.corporateId);
    default: return false;
  }
}

/**
 * S5 review: the server-written prescription PDF of a booking is readable (by the booking's parties) only while the
 * booking's prescription still names it; an admin clear or a newer prescription withdraws it. Admins still read it.
 */
async function bookingStillHoldsPrescription(bookingId: string, rel: string): Promise<boolean> {
  const b = await BookingModel.findById(bookingId).select({ 'prescription.fileUrls': 1 }).lean();
  return !!b && valuesAt(b, 'prescription.fileUrls').some((v) => uploadPathOf(v) === rel);
}

/**
 * Review of fb4063c7 (1): a file an admin clear withdrew (S5) stays withdrawn for everyone but admins, even after the
 * doctor saves a new prescription. Clears record the paths they withdrew (a clear recorded before that has none: its
 * own full PDFs). r9 (owner decision): for every clear, also every dispensing copy made up to the clear (copies are
 * named rx-dispense-<ms>), so the copies of older prescriptions stay hidden too; a copy made after the clear (of a new
 * prescription) is not touched.
 */
const COPY_MS = /\/rx-dispense-(\d+)(?:-[0-9a-f]{16})?\.pdf$/;
async function withdrawnByAdminClear(bookingId: string, rel: string): Promise<boolean> {
  const rows = await BookingAdminClearModel.find({ bookingId: { $in: [bookingId, bookingId.toLowerCase(), bookingId.toUpperCase()] }, field: 'prescription' })
    .select({ paths: 1, 'removed.fileUrls': 1, clearedAt: 1 }).lean();
  const copyMs = Number(COPY_MS.exec(rel)?.[1] ?? NaN);
  return rows.some((row) => {
    if (Array.isArray(row.paths) && row.paths.includes(rel)) return true;
    if ((row.removed?.fileUrls ?? []).some((u) => uploadPathOf(u) === rel)) return true;
    return Number.isFinite(copyMs) && copyMs <= new Date(row.clearedAt).getTime();
  });
}

/**
 * Assisted booking phase 0 (§17.2, D15, overnight H): the dispensing copy is read by the patient and the booking's
 * doctor, and by the booking pharmacy while it is operational, inside the 90-day window, and only the copy the booking
 * currently holds for its current doctor-saved prescription (review finding 7: the stored hash must match the
 * prescription now; an older copy is not the pharmacy's to read). After that the pharmacy keeps a copy only through a
 * medicine order dispensed in time (the order's binding, N12).
 */
async function canReadDispensingCopy(r: Reader, bookingId: string, rel: string): Promise<boolean> {
  if (!isValidObjectId(bookingId)) return false;
  const b = await BookingModel.findById(bookingId).select(WITH_COPY_STATE).lean() as Record<string, any> | null;
  if (!b) return false;
  switch (r.userType) {
    // Stage merge (S5 admin clear): once the booking holds no doctor-saved prescription (an admin removed it), no copy is
    // read by anyone but an admin; while it holds one, older copies stay readable to the patient and the doctor.
    case 'user': return id(b.userId) === id(r._id) && hasPrescription(b);
    // S5: an ineligible doctor reads no booking file, the dispensing copy included.
    case 'specialist': return !!b.specialistId && id(b.specialistId) === specialistOf(r) && hasPrescription(b) && await doctorIsEligible(specialistOf(r));
    case 'pharmacy': {
      if (!b.pharmacyId || id(b.pharmacyId) !== pharmacyOf(r)) return false;
      const copy = b.prescription?.dispensingCopy;
      if (uploadPathOf(copy?.url) !== rel || !hasPrescription(b) || copy?.hash !== dispensingHashOf(b)) return false;
      if (!(await isOperationalPharmacy(pharmacyOf(r)))) return false;
      return (await rxWindowOpenFor(b)).open;
    }
    default: return false;
  }
}

/** Order statuses that count as dispensed (N12): the medicines were packed or handed over. */
export const DISPENSED_ORDER_STATUSES = ['packed', 'ready_for_pickup', 'out_for_delivery', 'completed'];
/** An order that ends without dispensing: its binding serves nothing, inside the window or after it (review finding 7). */
const VOID_ORDER_STATUSES = ['cancelled', 'rejected', 'abandoned'];

/**
 * A server binding of a prescription order (assisted booking phase 0, N12; `keepIfDispensed`):
 * - nothing while the order is cancelled, rejected or abandoned;
 * - a pharmacy reads through it only while operational (access ends with authority, review finding 5);
 * - until `expiresAt` otherwise in force; after it only when the order is dispensed AND was dispensed (packed) before
 *   the expiry — packing after the expiry never revives it.
 * Bindings without an expiry are unchanged.
 */
async function grantInForce(r: Reader, g: { expiresAt?: Date | null; keepIfDispensed?: boolean; model: string; resourceId: string }): Promise<boolean> {
  if (!g.keepIfDispensed) return !g.expiresAt || Date.now() < new Date(g.expiresAt).getTime();
  if (g.model !== 'PharmacyOrder' || !isValidObjectId(g.resourceId)) return false;
  const o = await PharmacyOrderModel.findById(g.resourceId).select({ status: 1, pharmacyId: 1, prescriptionFromBooking: 1 }).lean() as Record<string, any> | null;
  if (!o || VOID_ORDER_STATUSES.includes(String(o.status))) return false;
  if (r.userType === 'pharmacy' && !(await isOperationalPharmacy(pharmacyOf(r)))) return false;
  if (!g.expiresAt || Date.now() < new Date(g.expiresAt).getTime()) return true;
  const dispensedAt = o.prescriptionFromBooking?.dispensedAt ? new Date(o.prescriptionFromBooking.dispensedAt).getTime() : NaN;
  return DISPENSED_ORDER_STATUSES.includes(String(o.status)) && Number.isFinite(dispensedAt) && dispensedAt <= new Date(g.expiresAt).getTime();
}

async function canReadPharmacyOrder(r: Reader, orderId: string): Promise<boolean> {
  if (!isValidObjectId(orderId)) return false;
  const o = await PharmacyOrderModel.findById(orderId).select({ customerId: 1, pharmacyId: 1, buyerPharmacyId: 1 }).lean();
  if (!o) return false;
  if (r.userType === 'user') return !!o.customerId && id(o.customerId) === id(r._id);
  if (r.userType === 'pharmacy') {
    const me = pharmacyOf(r);
    return id(o.pharmacyId) === me || (!!o.buyerPharmacyId && id(o.buyerPharmacyId) === me);
  }
  return false;
}

async function canReadLabReport(r: Reader, bookingId: string): Promise<boolean> {
  if (r.userType !== 'user' || !isValidObjectId(bookingId)) return false;
  const b = await ExternalBookingModel.findById(bookingId).select({ userId: 1 }).lean();
  return !!b && id(b.userId) === id(r._id);
}

/**
 * Q3: a partner member reads a lab booking's report files while admitted (member and partner active), of the same partner,
 * with the branch in scope, and holding one of `perms` (owners hold every permission).
 */
async function partnerMemberMayRead(r: Reader, b: { partnerId?: unknown; branchId?: unknown }, perms: string[]): Promise<boolean> {
  if (r.userType !== 'partner') return false;
  const m = await PartnerMemberModel.findById(id(r.memberId ?? r._id)).select({ partnerId: 1, role: 1, permissions: 1, branchIds: 1, isActive: 1 }).lean();
  if (!m || m.isActive === false || id(m.partnerId) !== id(b.partnerId)) return false;
  const p = await PartnerOrgModel.findById(id(m.partnerId)).select({ isActive: 1 }).lean();
  if (!p || p.isActive === false) return false;
  const scope = (m.branchIds ?? []).map(id);
  if (m.role !== 'owner' && scope.length > 0 && !scope.includes(id(b.branchId))) return false;
  return m.role === 'owner' || (m.permissions ?? []).some((x: string) => perms.includes(x));
}

async function canReadPartnerLabReport(r: Reader, bookingId: string, released: boolean): Promise<boolean> {
  if (!isValidObjectId(bookingId)) return false;
  const b = await PartnerLabBookingModel.findById(bookingId).select({ userId: 1, partnerId: 1, branchId: 1, 'assisted.bookedBy': 1,
    'assisted.identity.disputed': 1, 'report.releases': 1, status: 1 }).lean();
  if (!b) return false;
  // r11b: while the holder's "this isn't mine" report is open, the holder does not read the report (the booker and the
  // lab keep their access); a dismissed report gives it back, a move gives it to the new holder.
  if (released && r.userType === 'user') return id(b.userId) === id(r._id) && notDisputed(b as never);
  // r11 (§24.4.5, owner 23 Nov): the pharmacy that booked an assisted lab test reads its RELEASED report (never a draft)
  // while operational, for 90 days from the first release. Any other pharmacy: the uniform 404.
  if (r.userType === 'pharmacy') {
    const by = (b as { assisted?: { bookedBy?: { kind?: string; id?: string } } }).assisted?.bookedBy;
    if (!released || by?.kind !== 'pharmacy' || id(by.id).toLowerCase() !== pharmacyOf(r).toLowerCase()) return false;
    if (!bookerReportWindowOpen(b as never)) return false;
    return isOperationalPharmacy(pharmacyOf(r));
  }
  // r26 (§25.5.5, owner decision 2): the doctor that BOOKED it reads the released report for 90 days from the first
  // release while it is verified and active; a doctor that only recommended the tests never does (the uniform 404).
  if (r.userType === 'specialist') {
    const by = (b as { assisted?: { bookedBy?: { kind?: string; id?: string } } }).assisted?.bookedBy;
    if (!released || by?.kind !== 'doctor' || id(by.id).toLowerCase() !== specialistOf(r).toLowerCase()) return false;
    if (!bookerReportWindowOpen(b as never)) return false;
    return doctorIsEligible(specialistOf(r));
  }
  return partnerMemberMayRead(r, b, released
    ? ['reports.upload', 'reports.release', 'bookings.view', 'bookings.manage']
    : ['reports.upload', 'reports.release']);
}

/** Whether a (non-admin) reader may read the resource a grant names. */
async function canReadResource(r: Reader, kind: GrantKind, resourceId: string): Promise<boolean> {
  switch (kind) {
    case 'booking': return canReadBooking(r, resourceId);
    case 'pharmacy_order': return canReadPharmacyOrder(r, resourceId);
    case 'specialist': return r.userType === 'specialist' && specialistOf(r) === resourceId;
    case 'pharmacy': return r.userType === 'pharmacy' && pharmacyOf(r) === resourceId;
    case 'hr': return r.userType === 'hr' && id(r._id) === resourceId;
    case 'user': return r.userType === 'user' && id(r._id) === resourceId;
    case 'partner_lab_report_draft': return canReadPartnerLabReport(r, resourceId, false);
    case 'partner_lab_report': return canReadPartnerLabReport(r, resourceId, true);
    default: return false;
  }
}

/** Values at a dotted path, flattening arrays on the way ('documents.url' over an array of documents). */
export function valuesAt(doc: unknown, field: string): unknown[] {
  let cur: unknown[] = [doc];
  for (const key of field.split('.')) {
    const next: unknown[] = [];
    for (const c of cur) {
      const v = c && typeof c === 'object' ? (c as Record<string, unknown>)[key] : undefined;
      if (Array.isArray(v)) next.push(...v); else if (v !== undefined && v !== null) next.push(v);
    }
    cur = next;
  }
  return cur.flatMap((v) => (Array.isArray(v) ? v : [v]));
}

/** A binding counts only while its record's field still holds the file (removal, replacement, deletion withdraw it). */
async function bindingIsCurrent(g: { path: string; model: string; resourceId: string; field: string }): Promise<boolean> {
  const M = mongoose.models[g.model];
  if (!M || !isValidObjectId(g.resourceId)) return false;
  const doc = await M.findById(g.resourceId).select({ [g.field.split('.')[0]!]: 1 }).lean();
  return !!doc && valuesAt(doc, g.field).some((v) => uploadPathOf(v) === g.path);
}

type Key = { path: string; model: string; resourceId: string; field: string };
type Binding = Key & { _id: unknown; kind: GrantKind; state: 'active' | 'revoked'; gen: number; expiresAt?: Date | null; keepIfDispensed?: boolean };
const keyOf = (g: Key): Key => ({ path: g.path, model: g.model, resourceId: g.resourceId, field: g.field });
const isDuplicate = (e: unknown) => (e as { code?: number })?.code === 11000;

/** The generation of a binding slot as seen now (0 = never bound). Read when authority is checked. */
async function generationOf(k: Key): Promise<number> {
  const g = await FileGrantModel.findOne(k).select({ gen: 1 }).lean();
  return g ? Number(g.gen) : 0;
}

/**
 * Activates a binding only if its slot is still at `expectedGen` (the generation seen when the actor's authority was
 * checked). A withdrawal in between moved the generation on, so a delayed grant changes nothing. Returns whether it applied.
 */
async function activate(actor: Reader | undefined, k: Key, kind: GrantKind, expectedGen: number,
  source: 'attach' | 'legacy_manifest'): Promise<boolean> {
  try {
    if (expectedGen === 0) {
      const r = await FileGrantModel.updateOne(k, { $setOnInsert: { ...k, kind, source, state: 'active', gen: 1,
        createdByType: actor?.userType ?? 'system', createdById: id(actor?._id) || 'system', createdAt: new Date() } }, { upsert: true });
      return r.upsertedCount === 1;
    }
    const r = await FileGrantModel.updateOne({ ...k, gen: expectedGen }, { $set: { state: 'active' }, $inc: { gen: 1 } });
    return r.modifiedCount === 1;
  } catch (e) {
    if (isDuplicate(e)) return false; // a concurrent change took the slot first
    throw e;
  }
}

/**
 * Withdraws the slot exactly at `expectedGen` (the generation seen when the withdrawing write was checked): an active
 * slot there is revoked and its generation moved on; a slot that did not exist gets a revoked tombstone so a grant still
 * in flight from before cannot land. A NEWER generation (a later authorised re-attach) is never touched.
 */
async function revoke(k: Key, kind: GrantKind, expectedGen: number): Promise<void> {
  if (expectedGen > 0) {
    await FileGrantModel.updateOne({ ...k, gen: expectedGen, state: 'active' }, { $set: { state: 'revoked' }, $inc: { gen: 1 } });
    return;
  }
  try {
    await FileGrantModel.updateOne(k, { $setOnInsert: { ...k, kind, source: 'attach', state: 'revoked', gen: 1,
      createdByType: 'system', createdById: 'withdrawal', createdAt: new Date() } }, { upsert: true });
  } catch (e) {
    if (!isDuplicate(e)) throw e; // created concurrently by a newer attach: leave it
  }
}

/** Current, or withdrawn for good (a binding seen no longer current is revoked at the generation that was read). */
async function currentOrWithdraw(g: Binding): Promise<boolean> {
  if (await bindingIsCurrent(g)) return true;
  await revoke(keyOf(g), g.kind, g.gen);
  return false;
}

/** Iterates a query cursor and always closes it (early return and errors included). */
async function firstMatch<T>(cursor: { next(): Promise<T | null>; close(): Promise<unknown> }, test: (doc: T) => Promise<boolean>): Promise<boolean> {
  try {
    for (let doc = await cursor.next(); doc; doc = await cursor.next()) if (await test(doc)) return true;
    return false;
  } finally {
    await cursor.close();
  }
}

type SlotView = { path: string; field: string; kind: GrantKind; gen: number };

async function activeSlots(model: string, recordId: string): Promise<SlotView[]> {
  const rows = await FileGrantModel.find({ model, resourceId: recordId, state: 'active' }).select({ path: 1, field: 1, kind: 1, gen: 1 }).lean();
  return rows.map((r) => ({ path: r.path, field: r.field, kind: r.kind, gen: Number(r.gen) }));
}

/**
 * A consistent copy source: the record and the bindings that were current for exactly that record state. Bindings are
 * read before and after the record; if any active slot changed in between, or a post-D1 file the record holds has no
 * binding yet (publication in progress), it is read again (3 tries). Returns null when the source keeps changing or is
 * gone - the caller then skips the copy rather than produce an unbound or mismatched one.
 */
export async function snapshotWithBindings(model: string, recordId: unknown): Promise<{ doc: Record<string, unknown>; bindings: SlotView[] } | null> {
  const M = mongoose.models[model];
  const rid = canon(recordId);
  if (!M || !isValidObjectId(rid)) return null;
  const sig = (xs: SlotView[]) => xs.map((x) => `${x.field}|${x.path}|${x.gen}`).sort().join(',');
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await activeSlots(model, rid);
    const doc = await M.findById(rid).lean() as Record<string, unknown> | null;
    if (!doc) return null;
    const after = await activeSlots(model, rid);
    if (sig(before) !== sig(after)) continue;
    const bindings = after.filter((b) => valuesAt(doc, b.field).some((v) => uploadPathOf(v) === b.path));
    // Every post-D1 file (one with a recorded uploader) the record holds must come with its binding: a missing one means
    // a publication still in progress (the record was saved, its binding not yet written), so read again or give up.
    // A legacy file (no uploader record) has no binding on the source either and is copied as it is.
    const fields = FILE_FIELDS[model] ?? [];
    let incomplete = false;
    for (const [field] of fields) {
      for (const p of new Set(valuesAt(doc, field).map(uploadPathOf).filter((x): x is string => !!x))) {
        if (bindings.some((b) => b.field === field && b.path === p)) continue;
        if (await FileUploadModel.exists({ path: p })) { incomplete = true; break; }
      }
      if (incomplete) break;
    }
    if (incomplete) { await new Promise((r) => setTimeout(r, 50 * (attempt + 1))); continue; }
    return { doc, bindings };
  }
  return null;
}

/** Binds a freshly created copy with the bindings taken from its source snapshot (new record: nothing to fence). */
export async function bindCopy(actor: Reader | undefined, model: string, copyId: unknown, bindings: SlotView[]): Promise<void> {
  for (const b of bindings) await activate(actor, { path: b.path, model, resourceId: canon(copyId), field: b.field }, b.kind, 0, 'attach');
}

/** The decision. `rel` has already passed `legacyPath` (traversal, symlink and reserved-subtree guard). */
export async function decideFileAccess(reader: Reader | undefined, rel: string): Promise<Decision> {
  // Every active binding is examined (no cut-off); cursors are always closed.
  if (await firstMatch(FileGrantModel.find({ path: rel, kind: 'public', state: 'active' }).lean().cursor() as never,
    (g: Binding) => currentOrWithdraw(g))) return { allow: true, visibility: 'public' };
  if (!reader) return { allow: false, status: 401 };
  const ok: Decision = { allow: true, visibility: 'private' };
  if (reader.userType === 'admin') return ok;
  // r9 (owner decision): a prescription file an admin clear withdrew is refused to everyone but admins by every route,
  // the binding of a medicine order made from that prescription included (the order itself stays).
  const rxFile = BOOKING_PRESCRIPTION.exec(rel) ?? BOOKING_RX_DISPENSE.exec(rel);
  if (rxFile && await withdrawnByAdminClear(rxFile[1]!, rel)) return { allow: false, status: 404 };
  const upload = await FileUploadModel.findOne({ path: rel }).lean();
  if (upload) {
    // A partner lab report is judged by its binding (current permission + branch), so a member whose report rights were
    // removed cannot keep reading files they once uploaded.
    if (!PARTNER_LAB_REPORT.test(rel) && upload.uploaderType === reader.userType && upload.uploaderId === id(reader._id)) return ok;
  } else {
    const rx = BOOKING_PRESCRIPTION.exec(rel);
    if (rx && await canReadBooking(reader, rx[1]!) && await bookingStillHoldsPrescription(rx[1]!, rel)) return ok;
    const copy = BOOKING_RX_DISPENSE.exec(rel);
    if (copy && await canReadDispensingCopy(reader, copy[1]!, rel)) return ok;
    const lab = LAB_REPORT.exec(rel);
    if (lab && await canReadLabReport(reader, lab[1]!)) return ok;
  }
  if (await firstMatch(FileGrantModel.find({ path: rel, kind: { $ne: 'public' }, state: 'active' }).lean().cursor() as never,
    async (g: Binding) => await canReadResource(reader, g.kind, g.resourceId) && await grantInForce(reader, g) && await currentOrWithdraw(g))) return ok;
  return { allow: false, status: 404 };
}

const STATIC_PREFIXES = ['/api/static/', '/api/v1/file/static/'];

/**
 * The upload-dir relative path a stored value points to, or null when the value is not one of our files (an external
 * image URL, an icon name …). Absolute URLs are judged by their path; `/api/v1/file/fetch?url=` is unwrapped.
 */
export function uploadPathOf(value: unknown): string | null {
  if (typeof value !== 'string' || !value) return null;
  let p = value.trim();
  if (/^https?:\/\//i.test(p)) {
    try { p = new URL(p).pathname + new URL(p).search; } catch { return null; }
  }
  if (p.startsWith('/api/v1/file/fetch?')) {
    const inner = new URLSearchParams(p.slice('/api/v1/file/fetch?'.length)).get('url');
    return inner ? uploadPathOf(inner.startsWith('/') || /^https?:/i.test(inner) ? inner : `/api/static/${inner}`) : null;
  }
  for (const prefix of STATIC_PREFIXES) if (p.startsWith(prefix)) return p.slice(prefix.length);
  // A bare relative path ("general/x.pdf") is what /file/fetch accepts, so it is treated as ours too.
  if (!p.startsWith('/') && !/^[a-z][a-z0-9+.-]*:/i.test(p) && p.includes('/')) return p;
  return null;
}

const PUBLIC_IMAGE = /\.(jpe?g|png|webp)$/i;

export function notAttachable(message: string): AppError {
  return new AppError({ status: 400, code: 'FILE_NOT_ATTACHABLE', message });
}

/** Authority over a file: an admin, or the recorded uploader. */
async function hasAuthority(actor: Reader | undefined, path: string): Promise<boolean> {
  if (!actor) return false;
  if (actor.userType === 'admin') return true;
  const up = await FileUploadModel.findOne({ path }).select({ uploaderType: 1, uploaderId: 1 }).lean();
  return !!up && up.uploaderType === actor.userType && up.uploaderId === id(actor._id);
}

/**
 * Attach-time check, run BEFORE the record is saved. Returns the upload paths the actor may BIND to the record:
 * every referenced upload that the actor uploaded (or any, for an admin). A reference the actor has no authority over is
 * refused when it is new, and passes WITHOUT a binding when the same field already held it (an old or legacy value
 * resent unchanged never becomes a grant; only the curated manifest can bind legacy files). Public fields take images.
 */
export async function checkAttachable(actor: Reader | undefined, values: unknown[], previous: unknown[] = [],
  opts: { publicImage?: boolean } = {}): Promise<string[]> {
  const before = new Set(previous.map(uploadPathOf).filter((p): p is string => !!p));
  const paths = [...new Set(values.map(uploadPathOf).filter((p): p is string => !!p))];
  const bind: string[] = [];
  for (const p of paths) {
    const unchanged = before.has(p);
    const authorised = await hasAuthority(actor, p);
    if (!authorised) {
      if (unchanged) continue;
      throw notAttachable(actor ? 'A file can only be attached by the account that uploaded it' : 'Sign in to attach files');
    }
    if (opts.publicImage && !PUBLIC_IMAGE.test(p)) {
      if (unchanged) continue;
      throw notAttachable('Only a JPEG, PNG or WebP image can be used here');
    }
    bind.push(p);
  }
  return bind;
}

/**
 * Binds files to one field of one record with the authority of THIS moment (manifest import, tests): reads each slot's
 * generation and activates at it. Idempotent; inert unless the field holds the file.
 */
export async function grantFiles(actor: Reader | undefined, paths: string[], kind: GrantKind,
  binding: { model: string; resourceId: unknown; field: string }, source: 'attach' | 'legacy_manifest' = 'attach'): Promise<void> {
  const rid = canon(binding.resourceId);
  if (!rid || !mongoose.models[binding.model] || !binding.field) {
    throw new AppError({ status: 500, code: 'FILE_GRANT_INVALID', message: 'File grant needs a record and field' });
  }
  for (const path of new Set(paths)) {
    const k = { path, model: binding.model, resourceId: rid, field: binding.field };
    const current = await FileGrantModel.findOne(k).select({ gen: 1, state: 1 }).lean();
    if (current?.state === 'active') continue;
    await activate(actor, k, kind, current ? Number(current.gen) : 0, source);
  }
}

/**
 * Assisted booking phase 0 (§9.3): binds a SERVER-made file (no uploader: the dispensing copy) to one field of a record
 * the server itself just wrote, with an expiry (N12: `keepIfDispensed` keeps it after the expiry while the order is
 * dispensed). Never called with a client-supplied value; the uploader rule for client values is unchanged. Idempotent:
 * an existing active binding is kept as it is.
 */
export async function bindServerFile(path: string, kind: GrantKind, binding: { model: string; resourceId: unknown; field: string },
  terms: { expiresAt: Date; keepIfDispensed: boolean }): Promise<void> {
  const rid = canon(binding.resourceId);
  if (!rid || !mongoose.models[binding.model] || !binding.field || !path) {
    throw new AppError({ status: 500, code: 'FILE_GRANT_INVALID', message: 'File grant needs a record and field' });
  }
  const k = { path, model: binding.model, resourceId: rid, field: binding.field };
  const current = await FileGrantModel.findOne(k).select({ gen: 1, state: 1 }).lean();
  if (current?.state === 'active') return;
  try {
    if (!current) {
      await FileGrantModel.updateOne(k, { $setOnInsert: { ...k, kind, source: 'server', state: 'active', gen: 1, expiresAt: terms.expiresAt,
        keepIfDispensed: terms.keepIfDispensed, createdByType: 'system', createdById: 'server', createdAt: new Date() } }, { upsert: true });
    } else {
      await FileGrantModel.updateOne({ ...k, gen: current.gen }, { $set: { state: 'active', expiresAt: terms.expiresAt,
        keepIfDispensed: terms.keepIfDispensed }, $inc: { gen: 1 } });
    }
  } catch (e) {
    if (!isDuplicate(e)) throw e;
  }
}

/**
 * Repairs the bindings of a stored record for the files `actor` has authority over (uploader, or admin): binds each
 * such file the record currently holds, at the authority of now. Files without that authority are left as they are
 * (never refused, never bound). Used where a request re-presents a record without changing it (a keyed replay).
 */
export async function rebindStored(actor: Reader | undefined, model: string, recordId: unknown): Promise<void> {
  const M = mongoose.models[model];
  const fields = FILE_FIELDS[model];
  if (!M || !fields || !actor || !isValidObjectId(String(recordId ?? ''))) return;
  const doc = await M.findById(String(recordId)).lean();
  if (!doc) return;
  for (const [field, kind] of fields) {
    const values = valuesAt(doc, field);
    // Every value counts as "unchanged", so a value without authority is skipped rather than refused.
    const paths = await checkAttachable(actor, values, values, { publicImage: kind === 'public' });
    if (paths.length) await grantFiles(actor, paths, kind, { model, resourceId: doc._id, field });
  }
}

/** Records the uploader of a newly written legacy upload (same request as the bytes). */
export async function recordUpload(actor: Reader, path: string): Promise<void> {
  await FileUploadModel.create({ path, uploaderType: actor.userType, uploaderId: id(actor._id), createdAt: new Date() });
}

/** One field of a record: the values it will hold, the values it held before (updates), and its grant kind. */
export interface AttachSpec { field: string; values: unknown[]; previous?: unknown[]; kind: GrantKind }

/** Flattens url-bearing values: strings, arrays of strings and arrays of `{ url }`. */
export function fileValues(...xs: unknown[]): unknown[] {
  const out: unknown[] = [];
  const walk = (x: unknown) => {
    if (x == null) return;
    if (Array.isArray(x)) { x.forEach(walk); return; }
    if (typeof x === 'object' && 'url' in (x as object)) { out.push((x as { url: unknown }).url); return; }
    out.push(x);
  };
  xs.forEach(walk);
  return out;
}

/**
 * D1 write wrapper (use `withFiles`, which prepares the body first).
 * 1. Before the save: check every referenced upload (uploader or admin; public fields take images) and read the
 *    generation of each slot this write may activate or withdraw.
 * 2. Save (the service authorises and validates; nothing has been changed if it throws).
 * 3. After a successful save: activate the authorised bindings at the generations read in 1, and withdraw, at the
 *    generations read in 1, the files the SAVED record no longer holds in that field. A withdrawal or re-attach in
 *    between always wins over this write's older view; a field the service ignored, or a rejected write, changes nothing.
 * `withFiles` never writes a file value back on behalf of someone without authority over it, so a stale save cannot
 * restore a removed file; reads validate bindings against the record.
 */
export async function attachFiles<T>(actor: Reader | undefined, model: string, specs: AttachSpec[], save: () => Promise<T>,
  resourceId: (saved: T) => unknown, existingId?: unknown): Promise<T> {
  const rid = canon(existingId);
  const slot = (path: string, field: string, r = rid) => ({ path, model, resourceId: r, field });
  const checked: { spec: AttachSpec; paths: string[]; gens: number[]; removed: string[]; removedGens: number[] }[] = [];
  for (const spec of specs) {
    const paths = await checkAttachable(actor, spec.values, spec.previous ?? [], { publicImage: spec.kind === 'public' });
    const keep = new Set(spec.values.map(uploadPathOf).filter((p): p is string => !!p));
    const removed = rid ? [...new Set((spec.previous ?? []).map(uploadPathOf).filter((p): p is string => !!p && !keep.has(p)))] : [];
    const gens = await Promise.all(paths.map((p) => (rid ? generationOf(slot(p, spec.field)) : 0)));
    const removedGens = await Promise.all(removed.map((p) => generationOf(slot(p, spec.field))));
    checked.push({ spec, paths, gens, removed, removedGens });
  }
  const saved = await save();
  const savedRid = canon(resourceId(saved));
  if (!savedRid) return saved;
  const same = !!rid && savedRid === rid;
  for (const { spec, paths, gens } of checked) {
    for (let i = 0; i < paths.length; i++) {
      await activate(actor, slot(paths[i]!, spec.field, savedRid), spec.kind, same ? gens[i]! : 0, 'attach');
    }
  }
  if (same) {
    const top = (field: string) => field.split('.')[0]!;
    let fresh: unknown;
    for (const { spec, removed, removedGens } of checked) {
      if (!removed.length) continue;
      // What the save actually wrote: the returned record when it carries the field, else the record as stored now.
      let source: unknown = saved && typeof saved === 'object' && top(spec.field) in (saved as object) ? saved : undefined;
      if (source === undefined) fresh ??= await mongoose.models[model]!.findById(rid).lean();
      source ??= fresh;
      const held = new Set(valuesAt(source, spec.field).map(uploadPathOf).filter((p): p is string => !!p));
      for (let i = 0; i < removed.length; i++) {
        if (!held.has(removed[i]!)) await revoke(slot(removed[i]!, spec.field), spec.kind, removedGens[i]!);
      }
    }
  }
  return saved;
}

/**
 * D1 field table: every stored field that can reference an uploaded file, per model, with the grant kind its binding
 * gets. Public fields are images shown to everyone; the others are read by the record's own reader set.
 */
export const FILE_FIELDS: Record<string, [field: string, kind: GrantKind][]> = {
  Pharmacy: [['profilePictureUrl', 'public'], ['gstCertificateUrl', 'pharmacy'], ['drugLicenseDocumentUrl', 'pharmacy'],
    ['ownerIdProofUrl', 'pharmacy'], ['shopFrontPhotoUrl', 'pharmacy']],
  Specialist: [['profilePictureUrl', 'public'], ['documents.url', 'specialist']],
  Medicine: [['imageUrl', 'public']],
  User: [['profilePictureUrl', 'public']],
  Admin: [['profilePictureUrl', 'public']],
  HR: [['profilePictureUrl', 'public'], ['documents.url', 'hr']],
  Corporate: [['logoUrl', 'public']],
  Partner: [['logoUrl', 'public']],
  // Q16b: an operational partner's logo (partner_orgs) is shown to customers.
  PartnerOrg: [['logo', 'public']],
  Banner: [['imageUrl', 'public']],
  Blog: [['heroImage', 'public'], ['sections.image', 'public'], ['seo.ogImage', 'public']],
  News: [['image', 'public']],
  HealthTip: [['icon', 'public'], ['imageUrl', 'public']],
  WellnessPackage: [['imageUrl', 'public']],
  ExternalCatalogItem: [['image', 'public'], ['coverImage', 'public']],
  Booking: [['documents.url', 'booking'], ['prescription.fileUrls', 'booking'], ['report.fileUrls', 'booking']],
  PharmacyOrder: [['prescriptionUrls', 'pharmacy_order']],
  // Q3: drafts are partner-only; a released file moves to releasedFiles (the draft binding then no longer counts).
  PartnerLabBooking: [['report.draftFiles', 'partner_lab_report_draft'], ['report.releasedFiles', 'partner_lab_report']],
};

/** Specs for the fields this write touches (a field absent from a partial update is not changed, so not checked). */
export function specsFor(model: string, data: unknown, previous: unknown): AttachSpec[] {
  const fields = FILE_FIELDS[model];
  if (!fields) throw new AppError({ status: 500, code: 'FILE_FIELDS_UNKNOWN', message: `No file fields for ${model}` });
  if (!data || typeof data !== 'object') return [];
  return fields
    .filter(([field]) => (field.split('.')[0]! in (data as object)))
    .map(([field, kind]) => ({ field, kind, values: valuesAt(data, field), previous: previous ? valuesAt(previous, field) : [] }));
}

/** Deep comparison of stored and submitted values, ignoring Mongo-managed keys and Date/ObjectId spellings. */
function sameValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown): unknown => {
    if (v instanceof Date) return v.toISOString();
    if (v && typeof v === 'object' && typeof (v as { toHexString?: unknown }).toHexString === 'function') return String(v);
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object') {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>)
        .filter(([k, x]) => !['_id', 'createdAt', 'updatedAt'].includes(k) && x !== undefined)
        .sort(([x], [y]) => x.localeCompare(y)).map(([k, x]) => [k, norm(x)]));
    }
    return v;
  };
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
}

/**
 * One-line controller wrapper: `withFiles(req.user, 'Pharmacy', body, id, () => service.update(id, body))`.
 * `id` is the record being updated (its current values are the "previous" ones), or undefined for a create, where
 * the saved record's `_id` is used.
 *
 * A file value is never written back by someone without authority over it: when a submitted key keeps a file the
 * actor did not upload (and is not admin), the key is removed from `data` if it is unchanged (nothing is lost; the
 * stored value stays as it is, so a stale copy cannot restore a removed file), and the request is refused if the key
 * also changes something else (ask the uploader or an admin).
 */
export async function withFiles<T>(actor: Reader | undefined, model: string, data: unknown, id: unknown,
  save: () => Promise<T>, savedId: (saved: T) => unknown = (s) => (s as { _id?: unknown; id?: unknown } | null)?._id ?? (s as { id?: unknown } | null)?.id ?? id): Promise<T> {
  const M = mongoose.models[model];
  const fields = FILE_FIELDS[model];
  if (!M || !fields) throw new AppError({ status: 500, code: 'FILE_FIELDS_UNKNOWN', message: `Unknown model ${model}` });
  const previous = id != null && isValidObjectId(String(id)) ? await M.findById(String(id)).lean() as Record<string, unknown> | null : null;
  if (previous && data && typeof data === 'object') {
    const body = data as Record<string, unknown>;
    const pathsOf = (doc: unknown, top: string) => new Set(fields.filter(([f]) => f.split('.')[0] === top)
      .flatMap(([f]) => valuesAt(doc, f).map(uploadPathOf)).filter((p): p is string => !!p));
    for (const top of [...new Set(fields.map(([f]) => f.split('.')[0]!))]) {
      if (!(top in body)) continue;
      const now = pathsOf(body, top);
      const before = pathsOf(previous, top);
      const retained = [...now].filter((p) => before.has(p));
      const unowned: string[] = [];
      for (const p of retained) if (!(await hasAuthority(actor, p))) unowned.push(p);
      if (!unowned.length) continue;
      const unchangedFiles = now.size === before.size && retained.length === now.size;
      const pureFileKey = fields.some(([f]) => f === top);
      if (unchangedFiles && (pureFileKey || sameValue(body[top], previous[top]))) { delete body[top]; continue; }
      throw notAttachable('This change keeps files that only their uploader or an admin can keep; ask an admin to make it');
    }
  }
  return attachFiles(actor, model, specsFor(model, data, previous), save, savedId, previous ? previous._id : undefined);
}
