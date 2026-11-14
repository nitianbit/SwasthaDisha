// D1 legacy file manifest. Files uploaded before D1 have no recorded uploader, so nothing but this curated manifest
// can make them readable to anyone but admins. A stored reference is NOT authority (it may have been planted), so:
//
//   npm run d1-manifest -- propose <out.jsonl>   scan every file field, write one proposal per reference, FLAG risky ones
//   (operator reviews the file and sets "approved": true on entries they accept)
//   npm run d1-manifest -- apply <in.jsonl>      bind only approved, unflagged entries that still hold the file
//
// Bindings are record + field bindings like attach-time ones, so they are honoured only while the record holds the file.
import fs from 'fs';
import path from 'path';
import mongoose from 'mongoose';
import { CONFIG } from '@/config/config';
import { FILE_FIELDS, grantFiles, uploadPathOf, valuesAt } from '@/modules/file/access';
import { FileUploadModel, type GrantKind } from '@/modules/file/model/access';

export interface ManifestEntry {
  path: string;
  kind: GrantKind;
  model: string;
  resourceId: string;
  field: string;
  /** Reasons an operator must not approve this entry as it stands. Flagged entries are never applied. */
  flags: string[];
  approved: boolean;
}

const PUBLIC_IMAGE = /\.(jpe?g|png|webp)$/i;
const SERVER_FOLDER = /^(bookings|external-bookings|payouts)\//i;

export const loadAllModels = async (): Promise<void> => {
  const modulesDir = path.join(__dirname, '..', 'modules');
  for (const entry of fs.readdirSync(modulesDir, { withFileTypes: true })) {
    const modelDir = path.join(modulesDir, entry.name, 'model');
    if (!entry.isDirectory() || !fs.existsSync(modelDir)) continue;
    for (const file of fs.readdirSync(modelDir).filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'))) {
      await import(path.join(modelDir, file));
    }
  }
};

/** Builds the proposal from the current database (exported for tests). */
export async function propose(): Promise<ManifestEntry[]> {
  const refs = new Map<string, Omit<ManifestEntry, 'flags' | 'approved'>[]>();
  for (const [model, fields] of Object.entries(FILE_FIELDS)) {
    const M = mongoose.models[model];
    if (!M) throw new Error(`Model ${model} is not loaded`);
    const projection = Object.fromEntries([...new Set(fields.map(([f]) => f.split('.')[0]!))].map((k) => [k, 1]));
    for await (const doc of M.find({}, projection).lean().cursor()) {
      for (const [field, kind] of fields) {
        for (const value of valuesAt(doc, field)) {
          const p = uploadPathOf(value);
          if (!p) continue;
          const list = refs.get(p) ?? [];
          if (!list.some((r) => r.model === model && r.resourceId === String(doc._id) && r.field === field)) {
            list.push({ path: p, kind, model, resourceId: String(doc._id), field });
          }
          refs.set(p, list);
        }
      }
    }
  }
  const recorded = new Set((await FileUploadModel.find({ path: { $in: [...refs.keys()] } }).select({ path: 1 }).lean()).map((u) => u.path));
  const out: ManifestEntry[] = [];
  for (const [p, list] of refs) {
    if (recorded.has(p)) continue; // uploaded after D1: bound at attach time, never through the manifest
    const privateOwners = new Set(list.filter((r) => r.kind !== 'public').map((r) => `${r.model}:${r.resourceId}`));
    const hasPublic = list.some((r) => r.kind === 'public');
    const shared: string[] = [];
    if (privateOwners.size > 1) shared.push('referenced_by_several_private_records');
    if (hasPublic && privateOwners.size > 0) shared.push('referenced_by_public_and_private_fields');
    if (SERVER_FOLDER.test(p)) shared.push('server_folder');
    for (const r of list) {
      const flags = [...shared];
      if (r.kind === 'public' && !PUBLIC_IMAGE.test(p)) flags.push('public_but_not_an_image');
      if (!fs.existsSync(path.join(CONFIG.UPLOAD_DIR, p))) flags.push('file_missing');
      out.push({ ...r, flags, approved: false });
    }
  }
  return out.sort((a, b) => a.path.localeCompare(b.path) || a.model.localeCompare(b.model));
}

/** Applies reviewed entries; returns counts (exported for tests). */
export async function apply(entries: ManifestEntry[]): Promise<Record<string, number>> {
  const counts = { applied: 0, not_approved: 0, flagged: 0, invalid: 0, stale: 0 };
  for (const e of entries) {
    if (e.approved !== true) { counts.not_approved++; continue; }
    if (!Array.isArray(e.flags) || e.flags.length > 0) { counts.flagged++; continue; }
    // The kind comes from the field table, never from the file, so a reviewer cannot widen a field's audience.
    const kind = FILE_FIELDS[e.model]?.find(([f]) => f === e.field)?.[1];
    if (!kind || kind !== e.kind || typeof e.path !== 'string' || !mongoose.isValidObjectId(e.resourceId)) { counts.invalid++; continue; }
    if (kind === 'public' && !PUBLIC_IMAGE.test(e.path)) { counts.invalid++; continue; }
    const doc = await mongoose.models[e.model]!.findById(e.resourceId).lean();
    if (!doc || !valuesAt(doc, e.field).some((v) => uploadPathOf(v) === e.path)) { counts.stale++; continue; }
    await grantFiles({ _id: 'legacy-manifest', userType: 'system' }, [e.path], kind,
      { model: e.model, resourceId: e.resourceId, field: e.field }, 'legacy_manifest');
    counts.applied++;
  }
  return counts;
}

const main = async (): Promise<void> => {
  const [mode, file] = process.argv.slice(2);
  if ((mode !== 'propose' && mode !== 'apply') || !file) {
    console.error('Usage: d1-manifest propose <out.jsonl> | apply <in.jsonl>');
    process.exit(2);
  }
  await loadAllModels();
  await mongoose.connect(CONFIG.MONGODB_URL, { autoCreate: false, autoIndex: false });
  try {
    if (mode === 'propose') {
      if (fs.existsSync(file)) throw new Error(`${file} exists; refusing to overwrite a reviewed manifest`);
      const entries = await propose();
      fs.writeFileSync(file, entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : ''), { mode: 0o600 });
      const flagged = entries.filter((e) => e.flags.length).length;
      console.log(`proposed ${entries.length} bindings (${flagged} flagged) to ${file}; review and set "approved": true`);
    } else {
      const entries = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l) as ManifestEntry);
      console.log(JSON.stringify(await apply(entries)));
    }
  } finally {
    await mongoose.disconnect();
  }
};

if (require.main === module) {
  main().catch((error) => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
}
