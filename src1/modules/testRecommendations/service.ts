import { AppError } from '@/modules/common/types';
import { canonicalMobile } from '@/modules/common/utils/phone';
import { assertUniqueIndex } from '@/modules/common/utils/requiredIndex';
import { isDuplicateKeyError } from '@/modules/common/utils/mongoErrors';
import BookingModel from '@/modules/bookings/model';
import UserModel from '@/modules/user/model';
import { assistedFlags } from '@/modules/assisted/flags';
import { hitLookup } from '@/modules/assisted/limits';
import { hasPrescription } from '@/modules/assisted/rxAccess';
import { TestRecommendationModel } from '@/modules/testRecommendations/model';
import { newRecommendationCode, normalizeRecommendationCode } from '@/modules/testRecommendations/code';
import logger from '@/services/logger';

/**
 * Phase 3d (ASSISTED_BOOKING_DESIGN.md §25.7): a doctor's recommended tests and their printed code.
 * - Made when the doctor saves the prescription (`recommendTestsAtSave`), from the tests advised, best effort (DR12).
 * - Loaded by a pharmacy, a lab desk or a doctor with the code AND the patient's mobile number (`loadRecommendation`):
 *   test names only, counted as a phone lookup (the one limit the owner kept), audited by the caller (ids only).
 * Linking lab bookings to a recommendation is a later round (the `bookings` seam on the model).
 */
const err = (status: number, code: string, message: string) => new AppError({ status, code, message });
const CODE_TRIES = 3;

/** The test names as recommended and as loaded: trimmed, inner spaces collapsed, empty ones dropped (one rule for both). */
export const testNames = (tests: unknown): string[] =>
  (Array.isArray(tests) ? tests : []).map((t) => String(t ?? '').trim().replace(/\s+/g, ' ')).filter(Boolean);

/**
 * At the prescription save, BEFORE the PDF is written: the consultation's recommendation for `tests` (made, or updated
 * with the same code) and its code; null when there is nothing to print (a prescription saved without tests carries no
 * code, so an earlier code stops loading: R3). Best effort: switched off, a missing index or any database error gives
 * null (logged) and the prescription is saved without a code; the next save tries again. Never throws.
 */
export async function recommendTestsAtSave(consultation: { _id?: unknown; specialistId?: unknown }, tests: string[])
  : Promise<string | null> {
  if (!assistedFlags.recommendations()) return null;
  const consultationId = String(consultation._id).toLowerCase();
  const names = testNames(tests);
  if (!names.length) return null;
  try {
    // Fail closed for the code itself: without the unique indexes two consultations could print one code.
    await assertUniqueIndex(TestRecommendationModel, { code: 1 });
    await assertUniqueIndex(TestRecommendationModel, { consultationId: 1 });
    const items = names.map((name, index) => ({ index, name }));
    for (let attempt = 1; ; attempt++) {
      try {
        // Seam (§25.7.5): once lab bookings link here, `status` is recomputed from `bookings` instead of reset to open.
        const row = await TestRecommendationModel.findOneAndUpdate({ consultationId },
          { $set: { items, status: 'open', specialistId: String(consultation.specialistId ?? '').toLowerCase() },
            $setOnInsert: { code: newRecommendationCode(), consultationId, bookings: [] }, $inc: { version: 1 } },
          { upsert: true, new: true }).lean();
        return row!.code;
      } catch (e) {
        // A code already taken, or a twin save of this consultation inserted first (the retry then updates it).
        if (!isDuplicateKeyError(e) || attempt >= CODE_TRIES) throw e;
      }
    }
  } catch (error) {
    logger.warn('Test recommendation not made at the prescription save', { bookingId: consultationId,
      error: error instanceof Error ? error.message : String(error) });
    return null;
  }
}

/** Who is loading: the organisation the lookup is counted against, and its audit (written before any answer). */
export interface RecommendationLoader {
  orgKey: string;
  audit: (seen: { found: boolean; recommendationId?: string }) => Promise<void>;
}

/**
 * POST …/recommendations/lookup { code, phone } (§25.7.4, D2; r16b: in the body, never in a request line or a logged
 * path): the recommended test names, for the code AND the mobile number of the consultation's account. A code that is
 * unknown, no longer on the consultation's doctor-saved prescription (saved again without it, or cleared by an admin),
 * or whose account has another number: the one 404, so a code alone never reveals anything. The names are those of the
 * prescription itself (r16b: never the recommendation's own copy, which a failed or racing save can leave different).
 * Every well-formed load counts as a phone lookup and is audited.
 */
export async function loadRecommendation(rawCode: unknown, rawPhone: unknown, by: RecommendationLoader) {
  if (!assistedFlags.recommendations()) throw err(503, 'RECOMMENDATIONS_DISABLED', 'Recommended tests are not switched on yet');
  const phone = canonicalMobile(rawPhone);
  if (!phone) throw err(400, 'INVALID_PHONE', 'Enter a valid 10-digit mobile number');
  const code = normalizeRecommendationCode(rawCode);
  if (!code) throw err(400, 'INVALID_CODE', 'This code is not valid; check it on the prescription');
  await hitLookup(by.orgKey);
  const rec = await TestRecommendationModel.findOne({ code }).lean();
  const consultation = rec
    ? await BookingModel.findById(rec.consultationId).select({ userId: 1, specialistId: 1, prescription: 1, 'lifecycle.prescriptionUploaded': 1 }).lean()
    : null;
  const current = !!consultation && hasPrescription(consultation) && consultation.prescription?.recommendationCode === code;
  const holder = current ? await UserModel.findOne({ _id: consultation!.userId, userType: 'user' }).select({ phone: 1 }).lean() : null;
  const found = !!holder && canonicalMobile(holder.phone) === phone;
  await by.audit({ found, ...(found ? { recommendationId: String(rec!._id) } : {}) });
  if (!found) throw err(404, 'RECOMMENDATION_NOT_FOUND', 'No recommended tests match this code and mobile number');
  return { code, status: rec!.status, items: testNames(consultation!.prescription?.testsAdvised).map((name, index) => ({ index, name })) };
}
