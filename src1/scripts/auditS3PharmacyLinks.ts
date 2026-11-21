// S3 audit (read-only): access pharmacies were given before S3, for an admin to review.
//
//   npm run audit:s3-pharmacy-links            prints one JSON report to stdout
//
// Lists ids only (no names, phones or notes):
//   - linksWithoutConsent: PharmacyCustomer links with no consent, or consent 'not_recorded' (such a link cannot be
//     used to book until the partner links the customer again with the patient's agreement);
//   - bookingsWithoutLink: bookings carrying a pharmacyId that has no link to the booking's customer;
//   - pharmacyBookingsUsingCustomerBenefits: bookings carrying a pharmacyId that took money from the customer's wallet
//     or used a free follow-up.
// It only reads (find / aggregate); it writes nothing and creates no collection or index.
import mongoose, { Types } from 'mongoose';
import { CONFIG } from '@/config/config';
import BookingModel from '@/modules/bookings/model';
import PharmacyCustomerModel from '@/modules/pharmacyCustomers/model';
import { WalletTransactionModel } from '@/modules/wallet/model';

export interface S3PharmacyLinkAudit {
  generatedAt: string;
  linksWithoutConsent: { linkId: string; pharmacyId: string; userId: string; consent: string | null; createdAt: string | null }[];
  bookingsWithoutLink: { bookingId: string; pharmacyId: string; userId: string; status: string | null; createdAt: string | null }[];
  pharmacyBookingsUsingCustomerBenefits: {
    bookingId: string; pharmacyId: string; userId: string; walletAmount: number; followUpParentId: string | null; createdAt: string | null;
  }[];
}

const iso = (d: unknown) => (d instanceof Date ? d.toISOString() : null);
const hasPharmacy = { pharmacyId: { $type: 'string', $nin: [''] } };

export async function auditS3PharmacyLinks(): Promise<S3PharmacyLinkAudit> {
  const linksWithoutConsent: S3PharmacyLinkAudit['linksWithoutConsent'] = [];
  for await (const l of PharmacyCustomerModel.find({ consent: { $nin: ['patient_agreed', 'customer_order'] } })
    .select({ pharmacyId: 1, userId: 1, consent: 1, createdAt: 1 }).sort({ _id: 1 }).lean().cursor()) {
    linksWithoutConsent.push({ linkId: String(l._id), pharmacyId: String(l.pharmacyId), userId: String(l.userId),
      consent: l.consent ?? null, createdAt: iso(l.createdAt) });
  }

  const bookingsWithoutLink: S3PharmacyLinkAudit['bookingsWithoutLink'] = [];
  const pharmacyBookingsUsingCustomerBenefits: S3PharmacyLinkAudit['pharmacyBookingsUsingCustomerBenefits'] = [];
  const linked = new Map<string, boolean>();
  for await (const b of BookingModel.find(hasPharmacy)
    .select({ pharmacyId: 1, userId: 1, status: 1, createdAt: 1, walletFunding: 1, followUp: 1 }).sort({ _id: 1 }).lean().cursor()) {
    const bookingId = String(b._id); const pharmacyId = String(b.pharmacyId); const userId = String(b.userId);
    const pair = `${pharmacyId}:${userId}`;
    if (!linked.has(pair)) {
      linked.set(pair, Types.ObjectId.isValid(pharmacyId) && Types.ObjectId.isValid(userId) &&
        (await PharmacyCustomerModel.exists({ pharmacyId, userId })) !== null);
    }
    if (!linked.get(pair)) {
      bookingsWithoutLink.push({ bookingId, pharmacyId, userId, status: (b.status as string) ?? null, createdAt: iso(b.createdAt) });
    }
    const funded = Number((b as { walletFunding?: { total?: number } }).walletFunding?.total || 0);
    const [debits] = await WalletTransactionModel.aggregate([
      { $match: { referenceType: 'booking', referenceId: bookingId, transactionType: 'debit' } },
      { $group: { _id: null, total: { $sum: '$amount' } } },
    ]);
    const walletAmount = Math.max(funded, Number(debits?.total || 0));
    const followUpParentId = b.followUp?.isFollowUp ? String(b.followUp.parentConsultationId ?? '') || null : null;
    if (walletAmount > 0 || b.followUp?.isFollowUp) {
      pharmacyBookingsUsingCustomerBenefits.push({ bookingId, pharmacyId, userId, walletAmount, followUpParentId, createdAt: iso(b.createdAt) });
    }
  }
  return { generatedAt: new Date().toISOString(), linksWithoutConsent, bookingsWithoutLink, pharmacyBookingsUsingCustomerBenefits };
}

async function main() {
  await mongoose.connect(CONFIG.MONGODB_URL, { autoCreate: false, autoIndex: false });
  try {
    const report = await auditS3PharmacyLinks();
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
    process.stderr.write(`links without consent: ${report.linksWithoutConsent.length}; bookings without link: ${report.bookingsWithoutLink.length}; ` +
      `pharmacy bookings using customer wallet/follow-up: ${report.pharmacyBookingsUsingCustomerBenefits.length}\n`);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch((error) => { console.error(error); process.exit(1); });
}
