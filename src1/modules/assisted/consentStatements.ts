import { BOOKER_REPORT_DAYS } from '@/modules/assisted/labViews';

/**
 * r37d (§26.21): the versioned consent statement a pharmacy or a doctor attests when it books LAB TESTS for a patient
 * (`consent: { agreed: true, statementVersion, statementLanguage }`). The version names these exact words: a change of
 * words is a new version, and the booking records the version agreed (`assisted.consent.statementVersion`). The text is
 * kept in English, as the other statements are (round 6f, Q2); the web shows it next to the tick under this version.
 *
 * Lab bookings keep accepting the consultation statements sent so far (the pharmacy's `web-pharmacy-v2`, the lab's and
 * the doctor's), so released clients and requests in flight are not refused; the server never rejected a version, and
 * it still does not.
 *
 * NOT FOR PRODUCTION until the owner approves these words (GATE-DPDP, §26.21).
 */
export const LAB_TEST_STATEMENT_VERSION = 'web-lab-test-v1';
export const LAB_TEST_STATEMENT_LANGUAGE = 'en';
export const LAB_TEST_STATEMENT =
  'The patient (or a family member with them) agreed that we book these lab tests for them on Jansetu; that Jansetu keeps ' +
  'their details, and makes a Jansetu account for this mobile number if it has none; that the lab sees their name, mobile ' +
  'number and the tests booked, to do these tests; that the report reaches the patient in their Jansetu app; and that we ' +
  `can see the report for ${BOOKER_REPORT_DAYS} days after the lab first releases it.`;

/** Whether a booking's recorded consent is the lab-test statement (any version of it). */
export const isLabTestStatement = (version: unknown): boolean => typeof version === 'string' && /^web-lab-test-v\d+$/.test(version);
