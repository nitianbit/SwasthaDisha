/**
 * Q15 review prerequisite: pharmacy emails must be unique before `npm run sync-indexes` builds `email_unique_1`
 * (unique on `email` where it is a string). Run BEFORE sync-indexes:
 *
 *   npm run migrate:pharmacy-email-duplicates    # dry run only: lists duplicates, writes nothing
 *
 * Emails are compared trimmed and lower-cased (as sign-in compares them, so case variants are listed too, although the
 * index alone would accept them). Each duplicate is printed masked, with the ids of the pharmacies holding it, for an
 * admin to resolve (change or clear the email on all but one with the admin edit). Nothing is ever changed here.
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

async function main(): Promise<void> {
  await mongoose.connect(CONFIG.MONGODB_URL, { autoCreate: false, autoIndex: false });
  try {
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
