/**
 * Q16b: before Q16b an admin acting as owner through a URL with an upper-case partner id wrote rows under that
 * spelling (members, branches, catalogue items, invoices and their counters, slots, settlement accounts, audit …), next
 * to the lowercase spelling every member request uses. From Q16b the admin actor always carries the lowercase id. This
 * report lists the rows still stored under another spelling, so an operator can review them (invoice counters and
 * settlement accounts in particular: a second spelling means a second serial counter or a second balance). Read only:
 *
 *   npm run migrate:q16b-partner-id-case     # dry run only: counts per collection and field, writes nothing
 *
 * Exit code 2 when any row is found (resolve with a reviewed one-off fix), 0 when none.
 */
import mongoose from 'mongoose';
import { CONFIG } from '@/config/config';

/** Fields that hold a partner id somewhere in the partner/booking/finance collections. */
export const PARTNER_ID_FIELDS = ['partnerId', 'ownerId', 'clinicVisit.partnerId', 'clinicDesk.partnerId'];
/** 24 hex characters with at least one upper-case letter: an ObjectId hex in a non-canonical spelling. */
const NON_CANONICAL = /^(?=.*[A-F])[0-9a-fA-F]{24}$/;

export interface PartnerIdCaseReport { collections: { collection: string; field: string; rows: number; sampleIds: string[] }[]; total: number }

export async function findNonCanonicalPartnerIds(db = mongoose.connection.db): Promise<PartnerIdCaseReport> {
  const out: PartnerIdCaseReport = { collections: [], total: 0 };
  for (const info of await db.listCollections({}, { nameOnly: true }).toArray()) {
    if (info.name.startsWith('system.')) continue;
    const c = db.collection(info.name);
    for (const field of PARTNER_ID_FIELDS) {
      // Q16d (F9): `ownerId` is a partner id only on partner-owned rows; a doctor's settlement account (ownerKind
      // 'doctor') holds a doctor id there, reported by `npm run audit:q16a-doctor-id-case`, not here.
      const filter = field === 'ownerId'
        ? { ownerId: { $regex: NON_CANONICAL }, ownerKind: { $ne: 'doctor' } }
        : { [field]: { $regex: NON_CANONICAL } };
      const rows = await c.countDocuments(filter);
      if (!rows) continue;
      const sample = await c.find(filter, { projection: { _id: 1 } }).limit(5).toArray();
      out.collections.push({ collection: info.name, field, rows, sampleIds: sample.map((d) => String(d._id)) });
      out.total += rows;
    }
  }
  return out;
}

async function main(): Promise<void> {
  await mongoose.connect(CONFIG.MONGODB_URL, { autoCreate: false, autoIndex: false });
  try {
    const report = await findNonCanonicalPartnerIds();
    console.log(JSON.stringify({ mode: 'dry-run', ...report }, null, 2));
    if (report.total > 0) {
      console.log('REVIEW: rows above are stored under an upper-case partner id; merge them into the lowercase spelling with a reviewed one-off fix.');
      process.exitCode = 2;
    } else {
      console.log('OK: every partner id is stored in its lowercase spelling.');
    }
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e?.message ?? e); process.exit(1); });
}
