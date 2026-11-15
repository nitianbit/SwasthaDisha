/**
 * Q2 §6a prerequisite: canonical ten-digit customer phones and no duplicate {phone, userType} among phone-bearing users,
 * so `npm run sync-indexes` can build `q2_user_phone_unique`. Run BEFORE sync-indexes.
 *
 *   npm run migrate:q2-user-phones              # dry run: report only
 *   npm run migrate:q2-user-phones -- --commit  # rewrite non-canonical phones that cannot collide
 *
 * Never merges, deletes or re-assigns accounts. Duplicates (existing, or that normalising would create) are listed by
 * user id for an admin to resolve (merge or designate canonical); the index is not built until the list is empty.
 * Phone numbers are not printed.
 */
import mongoose from 'mongoose';
import { CONFIG } from '@/config/config';
import UserModel from '@/modules/user/model';

export function canonicalPhone(raw: string): string | null {
  let p = raw.replace(/[\s-]/g, '');
  if (p.startsWith('+91')) p = p.slice(3);
  else if (p.startsWith('91') && p.length === 12) p = p.slice(2);
  else if (p.startsWith('0') && p.length === 11) p = p.slice(1);
  return /^[0-9]{10}$/.test(p) ? p : null;
}

export interface PhoneMigrationReport {
  inspected: number;
  alreadyCanonical: number;
  rewritable: number;
  rewritten: number;
  invalid: string[];
  duplicateGroups: string[][];
}

export async function runPhoneMigration(commit: boolean): Promise<PhoneMigrationReport> {
  const report: PhoneMigrationReport = { inspected: 0, alreadyCanonical: 0, rewritable: 0, rewritten: 0, invalid: [], duplicateGroups: [] };
  const groups = new Map<string, { id: string; phone: string }[]>();
  const cursor = UserModel.find({ phone: { $type: 'string' } }).select({ _id: 1, phone: 1, userType: 1 }).sort({ _id: 1 }).lean().cursor();
  for await (const u of cursor as AsyncIterable<any>) {
    report.inspected += 1;
    const canonical = canonicalPhone(u.phone);
    if (!canonical) { report.invalid.push(String(u._id)); continue; }
    const key = `${u.userType ?? ''}|${canonical}`;
    const list = groups.get(key) ?? [];
    list.push({ id: String(u._id), phone: u.phone });
    groups.set(key, list);
  }
  for (const [key, rows] of groups) {
    if (rows.length > 1) { report.duplicateGroups.push(rows.map((r) => r.id)); continue; }
    const row = rows[0]!;
    const canonical = key.split('|')[1]!;
    if (row.phone === canonical) { report.alreadyCanonical += 1; continue; }
    report.rewritable += 1;
    if (!commit) continue;
    // Compare-and-set on the value read: a phone changed meanwhile is left for the next run.
    const r = await UserModel.updateOne({ _id: row.id, phone: row.phone }, { $set: { phone: canonical } });
    report.rewritten += r.modifiedCount;
  }
  return report;
}

async function main(): Promise<void> {
  const commit = process.argv.includes('--commit');
  await mongoose.connect(CONFIG.MONGODB_URL, { autoCreate: false, autoIndex: false });
  try {
    const report = await runPhoneMigration(commit);
    console.log(JSON.stringify({ mode: commit ? 'commit' : 'dry-run', ...report }, null, 2));
    if (report.duplicateGroups.length > 0 || report.invalid.length > 0) {
      console.log('NOT READY: resolve the listed users before running sync-indexes (the index build will fail otherwise).');
      process.exitCode = 2;
    } else if (!commit && report.rewritable > 0) {
      console.log('Re-run with --commit to rewrite non-canonical phones.');
      process.exitCode = 3;
    } else {
      console.log('READY: run `npm run sync-indexes` to build q2_user_phone_unique.');
    }
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
