import mongoose, { isValidObjectId } from 'mongoose';
import { AppError } from '@/modules/common/types';
import type { AuthRequest } from '@/modules/middleware/auth';
import BookingModel from '@/modules/bookings/model';
import PharmacyOrderModel from '@/modules/pharmacyOrders/model';
import ExternalBookingModel from '@/modules/externalBookings/model';
import { FileGrantModel, FileUploadModel, type GrantKind } from './model/access';

/**
 * D1 — one access decision for every legacy upload-dir route (/api/static, /api/v1/file/static, /api/v1/file/fetch).
 * Authority comes only from trusted facts: the recorded uploader, grants written after an attach-time check (or by the
 * curated legacy manifest) and exact server-owned folders. A URL stored in a writable field grants nothing.
 * Nothing is cached: each request reads the facts.
 */
export type Reader = NonNullable<AuthRequest['user']>;
export type Decision = { allow: true; visibility: 'public' | 'private' } | { allow: false; status: 401 | 404 };

const id = (v: unknown) => (v == null ? '' : String(v));
const specialistOf = (r: Reader) => id(r.specialistId ?? r._id);
const pharmacyOf = (r: Reader) => id(r.pharmacyId ?? r._id);

/** Exact server-written folders (never client uploads: those modules are reserved). */
const BOOKING_PRESCRIPTION = /^bookings\/([0-9a-f]{24})\/prescription-\d+\.pdf$/;
const LAB_REPORT = /^external-bookings\/([0-9a-f]{24})\/diagnostics-report-[A-Za-z0-9_-]+\.pdf$/;
export const RESERVED_UPLOAD_MODULES = new Set(['bookings', 'external-bookings', 'payouts']);

async function canReadBooking(r: Reader, bookingId: string): Promise<boolean> {
  if (!isValidObjectId(bookingId)) return false;
  const b = await BookingModel.findById(bookingId).select({ userId: 1, specialistId: 1, pharmacyId: 1, corporateId: 1 }).lean();
  if (!b) return false;
  switch (r.userType) {
    case 'user': return id(b.userId) === id(r._id);
    case 'specialist': return !!b.specialistId && id(b.specialistId) === specialistOf(r);
    case 'pharmacy': return !!b.pharmacyId && id(b.pharmacyId) === pharmacyOf(r);
    case 'hr': return !!r.corporateId && !!b.corporateId && id(b.corporateId) === id(r.corporateId);
    default: return false;
  }
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

/** Whether a (non-admin) reader may read the resource a grant names. */
async function canReadResource(r: Reader, kind: GrantKind, resourceId: string): Promise<boolean> {
  switch (kind) {
    case 'booking': return canReadBooking(r, resourceId);
    case 'pharmacy_order': return canReadPharmacyOrder(r, resourceId);
    case 'specialist': return r.userType === 'specialist' && specialistOf(r) === resourceId;
    case 'pharmacy': return r.userType === 'pharmacy' && pharmacyOf(r) === resourceId;
    case 'hr': return r.userType === 'hr' && id(r._id) === resourceId;
    case 'user': return r.userType === 'user' && id(r._id) === resourceId;
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

type Binding = { _id: unknown; path: string; model: string; resourceId: string; field: string };

/**
 * Current, or withdrawn for good: a binding seen to be no longer current is deleted, so restoring the same value later
 * (a stale save by an editor without authority over the file) cannot revive it. Only an authorised attach binds again.
 */
async function currentOrWithdraw(g: Binding): Promise<boolean> {
  if (await bindingIsCurrent(g)) return true;
  await FileGrantModel.deleteOne({ _id: g._id });
  return false;
}

/**
 * Copies a record's current bindings to a copy of that record (e.g. common banners cloned for a new corporate). The
 * authority is the source's own trusted, current binding; the copy's binding is validated against the copy at read.
 */
export async function copyCurrentBindings(actor: Reader | undefined, model: string, fromId: unknown, toId: unknown): Promise<void> {
  for await (const g of FileGrantModel.find({ model, resourceId: id(fromId) }).lean().cursor()) {
    if (await currentOrWithdraw(g as Binding)) {
      await grantFiles(actor, [g.path], g.kind, { model, resourceId: toId, field: g.field });
    }
  }
}

/** The decision. `rel` has already passed `legacyPath` (traversal, symlink and reserved-subtree guard). */
export async function decideFileAccess(reader: Reader | undefined, rel: string): Promise<Decision> {
  // Every binding is examined (no cut-off).
  for await (const g of FileGrantModel.find({ path: rel, kind: 'public' }).lean().cursor()) {
    if (await currentOrWithdraw(g as Binding)) return { allow: true, visibility: 'public' };
  }
  if (!reader) return { allow: false, status: 401 };
  const ok: Decision = { allow: true, visibility: 'private' };
  if (reader.userType === 'admin') return ok;
  const upload = await FileUploadModel.findOne({ path: rel }).lean();
  if (upload) {
    if (upload.uploaderType === reader.userType && upload.uploaderId === id(reader._id)) return ok;
  } else {
    const rx = BOOKING_PRESCRIPTION.exec(rel);
    if (rx && await canReadBooking(reader, rx[1]!)) return ok;
    const lab = LAB_REPORT.exec(rel);
    if (lab && await canReadLabReport(reader, lab[1]!)) return ok;
  }
  for await (const g of FileGrantModel.find({ path: rel, kind: { $ne: 'public' } }).lean().cursor()) {
    if (await canReadResource(reader, g.kind, g.resourceId) && await currentOrWithdraw(g as Binding)) return ok;
  }
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
    let authorised = false;
    if (actor?.userType === 'admin') authorised = true;
    else if (actor) {
      const up = await FileUploadModel.findOne({ path: p }).select({ uploaderType: 1, uploaderId: 1 }).lean();
      authorised = !!up && up.uploaderType === actor.userType && up.uploaderId === id(actor._id);
    }
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

/** Records bindings of files to one field of one record. Idempotent; inert unless the field holds the file. */
export async function grantFiles(actor: Reader | undefined, paths: string[], kind: GrantKind,
  binding: { model: string; resourceId: unknown; field: string }, source: 'attach' | 'legacy_manifest' = 'attach'): Promise<void> {
  if (paths.length === 0) return;
  const rid = id(binding.resourceId);
  if (!rid || !mongoose.models[binding.model] || !binding.field) {
    throw new AppError({ status: 500, code: 'FILE_GRANT_INVALID', message: 'File grant needs a record and field' });
  }
  const now = new Date();
  await FileGrantModel.bulkWrite(paths.map((path) => ({
    updateOne: {
      filter: { path, model: binding.model, resourceId: rid, field: binding.field },
      update: { $setOnInsert: { path, kind, model: binding.model, resourceId: rid, field: binding.field, source,
        createdByType: actor?.userType ?? 'system', createdById: id(actor?._id) || 'system', createdAt: now } },
      upsert: true,
    },
  })), { ordered: false });
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
 * D1 write wrapper: checks every referenced upload BEFORE the save; withdraws the bindings of files this write removes
 * from a field BEFORE the save (so a concurrent stale save that puts one back finds nothing to revive); saves; then binds
 * the authorised files to the saved record's fields. Bindings are validated against the record at read time, so a
 * binding written after a later removal, or for a save that did not keep the value, grants nothing. If binding fails
 * the request fails (fail closed); any authorised re-save of the record binds again.
 */
export async function attachFiles<T>(actor: Reader | undefined, model: string, specs: AttachSpec[], save: () => Promise<T>,
  resourceId: (saved: T) => unknown, existingId?: unknown): Promise<T> {
  const checked: { spec: AttachSpec; paths: string[] }[] = [];
  for (const spec of specs) {
    checked.push({ spec, paths: await checkAttachable(actor, spec.values, spec.previous ?? [], { publicImage: spec.kind === 'public' }) });
  }
  const rid = id(existingId);
  if (rid) {
    for (const spec of specs) {
      const keep = new Set(spec.values.map(uploadPathOf).filter((p): p is string => !!p));
      const removed = [...new Set((spec.previous ?? []).map(uploadPathOf).filter((p): p is string => !!p && !keep.has(p)))];
      if (removed.length) await FileGrantModel.deleteMany({ path: { $in: removed }, model, resourceId: rid, field: spec.field });
    }
  }
  const saved = await save();
  for (const { spec, paths } of checked) {
    if (paths.length) await grantFiles(actor, paths, spec.kind, { model, resourceId: resourceId(saved), field: spec.field });
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
  Banner: [['imageUrl', 'public']],
  Blog: [['heroImage', 'public'], ['sections.image', 'public'], ['seo.ogImage', 'public']],
  News: [['image', 'public']],
  HealthTip: [['icon', 'public'], ['imageUrl', 'public']],
  WellnessPackage: [['imageUrl', 'public']],
  ExternalCatalogItem: [['image', 'public'], ['coverImage', 'public']],
  Booking: [['documents.url', 'booking'], ['prescription.fileUrls', 'booking'], ['report.fileUrls', 'booking']],
  PharmacyOrder: [['prescriptionUrls', 'pharmacy_order']],
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

/**
 * One-line controller wrapper: `withFiles(req.user, 'Pharmacy', body, id, () => service.update(id, body))`.
 * `id` is the record being updated (its current values are the "previous" ones), or undefined for a create, where
 * the saved record's `_id` is used.
 */
export async function withFiles<T>(actor: Reader | undefined, model: string, data: unknown, id: unknown,
  save: () => Promise<T>, savedId: (saved: T) => unknown = (s) => (s as { _id?: unknown; id?: unknown } | null)?._id ?? (s as { id?: unknown } | null)?.id ?? id): Promise<T> {
  const M = mongoose.models[model];
  if (!M) throw new AppError({ status: 500, code: 'FILE_FIELDS_UNKNOWN', message: `Unknown model ${model}` });
  const previous = id != null && isValidObjectId(String(id)) ? await M.findById(String(id)).lean() : null;
  return attachFiles(actor, model, specsFor(model, data, previous), save, savedId, previous ? id : undefined);
}
