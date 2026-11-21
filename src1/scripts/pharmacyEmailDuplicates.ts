/**
 * Q15 review prerequisite: pharmacy emails must be unique before `npm run sync-indexes` builds `email_unique_1`
 * (unique on `email` where it is a string). Run BEFORE sync-indexes:
 *
 *   npm run migrate:pharmacy-email-duplicates    # dry run only: lists duplicates, writes nothing
 *
 * Emails are compared trimmed and lower-cased (as sign-in compares them, so case variants are listed too, although the
 * index alone would accept them). Each duplicate is printed masked, with the ids of the pharmacies holding it, for an
 * admin to resolve (change or clear the email on all but one with the admin edit). Nothing is ever changed here,
 * except with Q16c's option:
 *
 *   npm run migrate:pharmacy-email-duplicates -- --clear-empty           # dry run: counts the empty emails
 *   npm run migrate:pharmacy-email-duplicates -- --clear-empty --apply   # removes `email` where it is "" (or spaces)
 *
 * An empty email is no address: every one of them is a "duplicate" for `email_unique_1` (it indexes every string), so
 * they are cleared (the field is removed) rather than resolved one by one. Only pharmacies whose email is empty are
 * written; the run reports the ids it cleared.
 */
import mongoose from 'mongoose';
import { CONFIG } from '@/config/config';
import PharmacyModel from '@/modules/pharmacies/model';

export interface PharmacyEmailDuplicate { email: string; pharmacyIds: string[] }
export interface PharmacyEmailReport { inspected: number; duplicates: PharmacyEmailDuplicate[] }

/** "ravi.k@example.com" -> "r***@e***.com"; anything without an "@" -> "***". */
export function maskEmail(email: string): string {
  const e = email.trim().toLowerCase();
  const at = e.lastIndexOf('@');
  if (at < 1) return '***';
  const domain = e.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  const host = dot > 0 ? domain.slice(0, dot) : domain;
  const tld = dot > 0 ? domain.slice(dot) : '';
  return `${e[0]}***@${host ? host[0] : ''}***${tld}`;
}

export async function findPharmacyEmailDuplicates(): Promise<PharmacyEmailReport> {
  const groups = new Map<string, string[]>();
  let inspected = 0;
  // Raw driver read: the values as stored (the schema lower-cases only what it writes).
  const cursor = PharmacyModel.collection.find({ email: { $type: 'string' } }, { projection: { _id: 1, email: 1 } }).sort({ _id: 1 });
  for await (const p of cursor as AsyncIterable<{ _id: unknown; email: string }>) {
    inspected += 1;
    const key = p.email.trim().toLowerCase();
    groups.set(key, [...(groups.get(key) ?? []), String(p._id)]);
  }
  const duplicates = [...groups].filter(([, ids]) => ids.length > 1).map(([email, pharmacyIds]) => ({ email: maskEmail(email), pharmacyIds }));
  return { inspected, duplicates };
}

/** Q16c: an email that is "" or only spaces. */
const EMPTY_EMAIL = { email: { $type: 'string', $regex: /^\s*$/ } };

/** Q16c: the pharmacies whose email is empty; with `apply`, their `email` field is removed. */
export async function clearEmptyPharmacyEmails(apply: boolean): Promise<{ mode: 'dry-run' | 'apply'; pharmacyIds: string[]; cleared: number }> {
  const rows = await PharmacyModel.collection.find(EMPTY_EMAIL, { projection: { _id: 1 } }).sort({ _id: 1 }).toArray();
  const pharmacyIds = rows.map((r) => String(r._id));
  if (!apply || !pharmacyIds.length) return { mode: apply ? 'apply' : 'dry-run', pharmacyIds, cleared: 0 };
  // Raw driver write, fenced on the email still being empty (a concurrent edit that set an address is kept).
  const res = await PharmacyModel.collection.updateMany({ _id: { $in: rows.map((r) => r._id) }, ...EMPTY_EMAIL }, { $unset: { email: '' } });
  return { mode: 'apply', pharmacyIds, cleared: res.modifiedCount };
}

async function main(): Promise<void> {
  await mongoose.connect(CONFIG.MONGODB_URL, { autoCreate: false, autoIndex: false });
  try {
    if (process.argv.includes('--clear-empty')) {
      const result = await clearEmptyPharmacyEmails(process.argv.includes('--apply'));
      console.log(JSON.stringify(result, null, 2));
      if (result.mode === 'dry-run' && result.pharmacyIds.length) {
        console.log('Dry run: nothing changed. Add --apply to remove these empty emails.');
      }
    }
    const report = await findPharmacyEmailDuplicates();
    console.log(JSON.stringify({ mode: 'dry-run', ...report }, null, 2));
    if (report.duplicates.length > 0) {
      console.log('NOT READY: an admin must resolve the listed pharmacies (one email per pharmacy) before `npm run sync-indexes`.');
      process.exitCode = 2;
    } else {
      console.log('READY: run `npm run sync-indexes` to build email_unique_1 on pharmacies.');
    }
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
