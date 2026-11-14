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

type Key = { path: string; model: string; resourceId: string; field: string };
type Binding = Key & { _id: unknown; kind: GrantKind; state: 'active' | 'revoked'; gen: number };
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
 * Withdraws for good: marks the slot revoked and moves its generation on, creating a tombstone if nothing was bound yet
 * (so a grant still in flight from before cannot land). With `onlyGen`, only that exact active generation is revoked.
 */
async function revoke(k: Key, kind: GrantKind, onlyGen?: number): Promise<void> {
  const update = { $set: { state: 'revoked' as const }, $inc: { gen: 1 } };
  if (onlyGen !== undefined) { await FileGrantModel.updateOne({ ...k, gen: onlyGen, state: 'active' }, update); return; }
  const insert = { kind, source: 'attach', createdByType: 'system', createdById: 'withdrawal', createdAt: new Date() };
  try {
    await FileGrantModel.updateOne(k, { ...update, $setOnInsert: insert }, { upsert: true });
  } catch (e) {
    if (!isDuplicate(e)) throw e;
    await FileGrantModel.updateOne(k, update); // the slot was created concurrently: revoke it
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
 * read before and after the record; if any active slot changed in between, it is read again (3 tries). Returns null when
 * the source keeps changing or is gone - the caller then skips the copy rather than produce a mismatched one.
 */
export async function snapshotWithBindings(model: string, recordId: unknown): Promise<{ doc: Record<string, unknown>; bindings: SlotView[] } | null> {
  const M = mongoose.models[model];
  const rid = id(recordId);
  if (!M || !isValidObjectId(rid)) return null;
  const sig = (xs: SlotView[]) => xs.map((x) => `${x.field}|${x.path}|${x.gen}`).sort().join(',');
  for (let attempt = 0; attempt < 3; attempt++) {
    const before = await activeSlots(model, rid);
    const doc = await M.findById(rid).lean() as Record<string, unknown> | null;
    if (!doc) return null;
    const after = await activeSlots(model, rid);
    if (sig(before) !== sig(after)) continue;
    const bindings = after.filter((b) => valuesAt(doc, b.field).some((v) => uploadPathOf(v) === b.path));
    return { doc, bindings };
  }
  return null;
}

/** Binds a freshly created copy with the bindings taken from its source snapshot (new record: nothing to fence). */
export async function bindCopy(actor: Reader | undefined, model: string, copyId: unknown, bindings: SlotView[]): Promise<void> {
  for (const b of bindings) await activate(actor, { path: b.path, model, resourceId: id(copyId), field: b.field }, b.kind, 0, 'attach');
}

/** The decision. `rel` has already passed `legacyPath` (traversal, symlink and reserved-subtree guard). */
export async function decideFileAccess(reader: Reader | undefined, rel: string): Promise<Decision> {
  // Every active binding is examined (no cut-off); cursors are always closed.
  if (await firstMatch(FileGrantModel.find({ path: rel, kind: 'public', state: 'active' }).lean().cursor() as never,
    (g: Binding) => currentOrWithdraw(g))) return { allow: true, visibility: 'public' };
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
  if (await firstMatch(FileGrantModel.find({ path: rel, kind: { $ne: 'public' }, state: 'active' }).lean().cursor() as never,
    async (g: Binding) => await canReadResource(reader, g.kind, g.resourceId) && await currentOrWithdraw(g))) return ok;
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

/**
 * Binds files to one field of one record with the authority of THIS moment (manifest import, tests): reads each slot's
 * generation and activates at it. Idempotent; inert unless the field holds the file.
 */
export async function grantFiles(actor: Reader | undefined, paths: string[], kind: GrantKind,
  binding: { model: string; resourceId: unknown; field: string }, source: 'attach' | 'legacy_manifest' = 'attach'): Promise<void> {
  const rid = id(binding.resourceId);
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
    if (paths.length) await grantFiles(actor, paths, kind, { model, resourceId: String(recordId), field });
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
 * D1 write wrapper.
 * 1. Before the save: check every referenced upload (uploader or admin; public fields take images) and note the
 *    generation of each binding slot this write may activate.
 * 2. Save (the service authorises and validates; nothing has been changed if it throws).
 * 3. After a successful save: activate the authorised bindings at the generations noted in 1 (a withdrawal in between
 *    wins), and withdraw - permanently, as tombstones - the bindings of files the SAVED record no longer holds in that
 *    field (judged from the saved record, so a field the service ignored, or a rejected write, withdraws nothing).
 * Reads validate bindings against the record, so a binding never grants more than the record currently shows.
 */
export async function attachFiles<T>(actor: Reader | undefined, model: string, specs: AttachSpec[], save: () => Promise<T>,
  resourceId: (saved: T) => unknown, existingId?: unknown): Promise<T> {
  const rid = id(existingId);
  const checked: { spec: AttachSpec; paths: string[]; gens: number[] }[] = [];
  for (const spec of specs) {
    const paths = await checkAttachable(actor, spec.values, spec.previous ?? [], { publicImage: spec.kind === 'public' });
    const gens = await Promise.all(paths.map((path) => (rid ? generationOf({ path, model, resourceId: rid, field: spec.field }) : 0)));
    checked.push({ spec, paths, gens });
  }
  const saved = await save();
  const savedRid = id(resourceId(saved));
  if (!savedRid) return saved;
  for (const { spec, paths, gens } of checked) {
    for (let i = 0; i < paths.length; i++) {
      await activate(actor, { path: paths[i]!, model, resourceId: savedRid, field: spec.field }, spec.kind,
        savedRid === rid ? gens[i]! : 0, 'attach');
    }
  }
  if (rid && savedRid === rid) {
    const top = (field: string) => field.split('.')[0]!;
    let fresh: unknown;
    for (const spec of specs) {
      const keep = new Set(spec.values.map(uploadPathOf).filter((p): p is string => !!p));
      const removed = [...new Set((spec.previous ?? []).map(uploadPathOf).filter((p): p is string => !!p && !keep.has(p)))];
      if (!removed.length) continue;
      // What the save actually wrote: the returned record when it carries the field, else the record as stored now.
      let source: unknown = saved && typeof saved === 'object' && top(spec.field) in (saved as object) ? saved : undefined;
      if (source === undefined) fresh ??= await mongoose.models[model]!.findById(rid).lean();
      source ??= fresh;
      const held = new Set(valuesAt(source, spec.field).map(uploadPathOf).filter((p): p is string => !!p));
      for (const path of removed) if (!held.has(path)) await revoke({ path, model, resourceId: rid, field: spec.field }, spec.kind);
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
