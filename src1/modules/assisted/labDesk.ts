import { ClientSession, Types } from 'mongoose';
import { Container } from 'typedi';
import { AppError } from '@/modules/common/types';
import { requestHashOf } from '@/modules/common/utils/canonicalJson';
import { canonicalMobile } from '@/modules/common/utils/phone';
import { istDateIso, istTimeHhmm } from '@/modules/common/utils/istDate';
import { assertUniqueIndex } from '@/modules/common/utils/requiredIndex';
import { runLedgerTransaction } from '@/modules/common/utils/bookingWalletFunding';
import { RequestKeyModel } from '@/modules/requestKeys/model';
import { abandonRequestKey, claimRequestKey } from '@/modules/requestKeys';
import PartnerOrgModel from '@/modules/partners/model';
import BranchModel from '@/modules/partners/model/branch';
import MemberModel from '@/modules/partners/model/member';
import { PartnerLabBookingModel, type IPartnerLabBooking, type ILabDeskBlock } from '@/modules/partners/model/labBooking';
import type { VisitMode } from '@/modules/partners/model/slot';
import { type PartnerActor, assertBranchInScope, hasGlobalScope, recordPartnerAudit } from '@/modules/partners/services';
import { ensureSettlementAccount } from '@/modules/partners/services/settlement';
import { takeSeat } from '@/modules/partners/services/slots';
import { LabBookingService, admitLabItems, branchOffers, itemSnapshot, partnerView, withDeskBills } from '@/modules/partners/services/labBookings';
import { assertLabDeskOn } from '@/modules/assisted/flags';
import { maskName } from '@/modules/assisted/names';
import { ASSISTED_KEY } from '@/modules/assisted/consultations';
import { AssistedLinkModel } from '@/modules/assisted/model/links';
import { labAdmissible, labRequestContent, validateLabRequest, type AssistedLabInput } from '@/modules/assisted/labBookings';
import { cleanName, countPhoneUse, deskPhoneLookup, linkLabIn, preparePatient, writePatientIn } from '@/modules/assisted/patient';
import { smsBooked } from '@/modules/smsNotices/events';

/**
 * Assisted booking round 2c (ASSISTED_BOOKING_DESIGN.md §24.6, §5.5, §7.5): the LAB FRONT DESK books the lab's own tests
 * for a walk-in patient — a walk-in tested now (no seat), a lab visit on a slot, or a home collection (address, home
 * slot, collector). Paid at the lab: no Jansetu payment, wallet, earning or cut; the lab bills it with its own Q2 bill
 * (`labBookingId`). The report goes to the patient's app through the existing release.
 *
 * Order (§24.3): validate → lab admission → indexes → same-content replay (uncounted) → count the lookup and audit the
 * attempt → abandoned key → branch, tests, collector, price fence → patient pre-checks (one answer for known and
 * unknown numbers) → ONE transaction (key claim, lab re-admitted, the account of a new number, family member, the
 * lab's `assisted_links` row with the typed name, the seat, the row, the audit). Exactly once per (lab, desk member,
 * request key) with a content hash.
 *
 * Owner, 23 Nov: no blocking limits except the hourly phone lookups (no per-number, new-account or cancellation cap).
 * Labs only ever see typed or masked names. Phase 5b: the patient's SMS (scheduled rows; a walk-in hears only of its report).
 */
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const err = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new AppError({ status, code, message }), extra);
const notFound = () => err(404, 'LAB_BOOKING_NOT_FOUND', 'Booking not found');
const lower = (v: unknown) => String(v ?? '').toLowerCase();
const orgKey = (partnerId: string) => `lab:${lower(partnerId)}`;
const labService = () => Container.get(LabBookingService);

/** The pharmacy lab create's fields (2a) without the lab (the desk's own), coupon, price and payment method. */
export type LabDeskInput = Omit<AssistedLabInput, 'partnerId' | 'slotId' | 'couponCode' | 'acceptedPriceMinor' | 'paymentMethod'> & {
  /** Required for home; optional for a lab visit (absent = a walk-in tested now). */
  slotId?: string;
  collector?: { memberId?: string; name: string; phone?: string };
  /** Price fence: Σ the lab's catalogue prices (paise) the desk showed. No coupon on desk rows. */
  acceptedTotalMinor: number;
  /** The desk's own notes (stored on `desk.notes`; r11b took `notes` off the pharmacy create). */
  notes?: string;
};

/** The stored key (unique `desk.requestKey`) and the claim scope of a desk member's create at this lab. */
export const storedDeskKey = (a: PartnerActor, key: string) => `lab_desk:${lower(a.partnerId)}:${lower(a.memberId)}:${key}`;
export const deskKeyScope = (a: PartnerActor) => `lab_desk_create:${lower(a.partnerId)}:${lower(a.memberId)}`;

const cleanCollector = (c?: LabDeskInput['collector']) => (c ? { memberId: c.memberId ? lower(c.memberId) : null, name: cleanName(c.name),
  phone: c.phone ? String(c.phone).trim() : null } : null);

/** The content a desk request key is bound to (§24.3): the shared lab request content, the collector and the price fence. */
export function labDeskRequestHash(input: LabDeskInput): string {
  const c = labRequestContent(input);
  return requestHashOf({ ...c, service: { ...c.service, collector: cleanCollector(input.collector) }, acceptedTotalMinor: input.acceptedTotalMinor });
}

/** §24.6.4: the desk relies on these unique indexes (fail closed: 503 INDEXES_OUTDATED until sync-indexes has run). */
export async function assertLabDeskIndexes(): Promise<void> {
  await assertUniqueIndex(PartnerLabBookingModel, { 'desk.requestKey': 1 });
  await assertUniqueIndex(RequestKeyModel, { scope: 1, key: 1 });
  await assertUniqueIndex(AssistedLinkModel, { bookerKind: 1, bookerId: 1, userId: 1 });
}

/** The shared lab request rules, then the desk's own: home needs a slot; a collector only for home; no coupon or payment method. */
function validate(input: LabDeskInput): void {
  validateLabRequest(input);
  if (input.visitMode === 'home' && !input.slotId) throw err(400, 'SLOT_REQUIRED', 'A home collection needs a home-collection slot');
  if (input.visitMode === 'lab' && input.collector) throw err(400, 'VALIDATION_ERROR', 'A collector is for home collections only');
  if (input.slotId !== undefined && !OBJECT_ID.test(String(input.slotId))) throw err(400, 'VALIDATION_ERROR', 'slotId is not valid');
}

/**
 * Every desk route acts for a LAB (403 LAB_PARTNER_REQUIRED otherwise). New work (lookup, create)
 * also needs the S5 eligibility: an active, verified lab (members are refused earlier by their admission; this holds
 * for admins acting as the owner too, and is read again inside the booking transaction).
 */
async function labOf(actor: PartnerActor, opts: { eligible: boolean }, s?: ClientSession): Promise<Record<string, any>> {
  const p = OBJECT_ID.test(String(actor.partnerId))
    ? await PartnerOrgModel.findById(actor.partnerId).session(s ?? null).lean() as Record<string, any> | null : null;
  if (!p) throw err(404, 'PARTNER_NOT_FOUND', 'Partner not found');
  if (p.kind !== 'lab') throw err(403, 'LAB_PARTNER_REQUIRED', 'The front desk is for labs');
  if (opts.eligible && !labAdmissible(p)) throw err(403, 'PARTNER_NOT_VERIFIED', 'Partner verification is required for this operation');
  return p;
}

/** A branch of this lab: unknown or another lab's → 404; outside the actor's branches → 403; closed or not offering the visit mode → 404. */
async function deskBranch(actor: PartnerActor, branchId: string, visitMode: VisitMode, s?: ClientSession): Promise<Record<string, any>> {
  const unavailable = () => err(404, 'BRANCH_NOT_AVAILABLE', 'This branch does not offer that visit type');
  const b = OBJECT_ID.test(String(branchId)) ? await BranchModel.findById(branchId).session(s ?? null).lean() as Record<string, any> | null : null;
  if (!b || lower(b.partnerId) !== lower(actor.partnerId)) throw unavailable();
  assertBranchInScope(actor, String(b._id));
  if (b.isActive === false || !branchOffers(b, visitMode)) throw unavailable();
  return b;
}

/** A row the member may see: at a branch in scope (the boolean form of `assertBranchInScope`). */
const inScope = (actor: PartnerActor, b: { branchId?: unknown }) => hasGlobalScope(actor) || actor.branchIds.includes(String(b.branchId));

/** The lab view of desk rows, with their bill. */
async function deskViews(actor: PartnerActor, rows: IPartnerLabBooking[]) {
  return withDeskBills(actor.partnerId, rows, rows.map((r) => partnerView(r)));
}

async function receipt(actor: PartnerActor, b: IPartnerLabBooking, replayed: boolean) {
  return { booking: (await deskViews(actor, [b]))[0]!, patient: { name: b.patient?.name ?? null }, newAccount: !!b.desk?.newAccount, replayed };
}

async function replayOf(actor: PartnerActor, storedKey: string, hash: string, s?: ClientSession): Promise<IPartnerLabBooking | null> {
  const prior = await PartnerLabBookingModel.findOne({ 'desk.requestKey': { $eq: storedKey, $type: 'string' } }).session(s ?? null).lean() as IPartnerLabBooking | null;
  if (!prior) return null;
  if (prior.desk?.requestHash !== hash) throw err(409, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different booking');
  // A receipt is shown only while the booking is at a branch in this member's scope.
  if (!inScope(actor, prior)) throw notFound();
  return prior;
}

// ───────────────────────────── Lookup ─────────────────────────────

/** POST /partner-workspace/lab-desk/patients/lookup — `{ exists, holderNameMasked }` only; the hourly limit per lab; audited (ids only). */
export async function lookupDeskPatient(actor: PartnerActor, rawPhone: unknown) {
  assertLabDeskOn();
  await labOf(actor, { eligible: true });
  return deskPhoneLookup(orgKey(actor.partnerId), rawPhone, (seen) => recordPartnerAudit(actor, 'lab_desk.patient_lookup', undefined, seen));
}

// ───────────────────────────── Create (§24.6.3) ─────────────────────────────

/** POST /partner-workspace/lab-desk/bookings — 201 `{ booking, patient, newAccount, replayed }`; a replay is 200. */
export async function createDeskBooking(actor: PartnerActor, input: LabDeskInput, clock: () => Date = () => new Date(), attempt = 0)
  : Promise<Awaited<ReturnType<typeof receipt>>> {
  assertLabDeskOn();
  validate(input);
  const partner = await labOf(actor, { eligible: true });
  const partnerId = lower(partner._id);
  const phone = canonicalMobile(input.phone)!;
  const storedKey = storedDeskKey(actor, input.requestKey);
  const hash = labDeskRequestHash(input);
  await assertLabDeskIndexes();
  // The same key with the same content answers its receipt first, uncounted.
  const replay = await PartnerLabBookingModel.findOne({ 'desk.requestKey': { $eq: storedKey, $type: 'string' } }).lean() as IPartnerLabBooking | null;
  if (replay && replay.desk?.requestHash === hash && inScope(actor, replay)) return receipt(actor, replay, true);
  // Every other create names a phone like a lookup does: counted (the one limit the owner kept) and audited (ids only).
  if (attempt === 0) await countPhoneUse(orgKey(partnerId), phone, (seen) => recordPartnerAudit(actor, 'lab_desk.attempted', undefined, seen));
  const prior = await replayOf(actor, storedKey, hash);
  if (prior) return receipt(actor, prior, true);
  if (await RequestKeyModel.exists({ scope: deskKeyScope(actor), key: input.requestKey, state: 'abandoned' })) {
    throw err(409, 'REQUEST_ABANDONED', 'This request was cancelled before it was recorded; make a new one');
  }

  // The service: a branch of this lab in scope offering the visit mode; this lab's own tests (a lab never books another
  // lab's tests); a collector who is an active member. Refused before any account is touched.
  const branch = await deskBranch(actor, input.branchId, input.visitMode);
  const ordered = await admitLabItems(partnerId, input.itemIds, input.visitMode);
  const c = cleanCollector(input.collector);
  if (c?.memberId && !(await MemberModel.exists({ _id: c.memberId, partnerId, isActive: true }))) {
    throw err(400, 'COLLECTOR_NOT_MEMBER', 'The collector must be an active member of this lab');
  }
  const collector = c ? { ...(c.memberId ? { memberId: c.memberId } : {}), name: c.name, ...(c.phone ? { phone: c.phone } : {}) } : undefined;
  const totalMinor = ordered.reduce((x, i) => x + Number(i.priceMinor || 0), 0);
  if (input.acceptedTotalMinor !== totalMinor) {
    throw err(409, 'PRICE_CHANGED', 'The price changed; check it with the patient and book again', { details: { priceMinor: totalMinor, listMinor: totalMinor, discountMinor: 0 } });
  }
  // The patient: refusable steps before any account opens, one answer for known and unknown numbers.
  const pp = await preparePatient({ phone, patient: input.patient, holderName: input.holderName, preferredLanguage: input.preferredLanguage });
  // L15: the lab sees only names it typed, or masked ones: a family member chosen by id (not typed) is stored masked.
  const patientName = (pp.chosenById ? maskName(pp.patientName) : pp.patientName) || 'Patient';

  // §5.5: the lab's own `partner` account fills the settlement block (harmless); `lab_desk` stops every earning.
  const account = await ensureSettlementAccount('partner', partnerId, partner.legalName || partner.name);
  const now = clock();
  const bookingId = new Types.ObjectId().toHexString();
  const walkIn = input.visitMode === 'lab' && !input.slotId;
  const desk: ILabDeskBlock = {
    memberId: lower(actor.memberId), branchId: lower(branch._id), requestKey: storedKey, requestHash: hash, ...(walkIn ? { arrivedAt: now } : {}),
    consent: { method: 'partner_attested', statementVersion: input.consent.statementVersion, statementLanguage: input.consent.statementLanguage,
      at: now, actorId: lower(actor.memberId) },
    preferredLanguage: input.preferredLanguage, payAtLab: true, ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
    newAccount: pp.created,
  };

  let made: { booking: IPartnerLabBooking; replayed: boolean };
  try {
    made = await runLedgerTransaction(async (s) => {
      // A racing identical request that committed first answers with its booking (and other content with 409).
      const again = await replayOf(actor, storedKey, hash, s);
      if (again) return { booking: again, replayed: true };
      await claimRequestKey(deskKeyScope(actor), input.requestKey, s);
      // The S5 pattern: the lab and the branch are read again in the transaction (suspended, unverified or closed meanwhile: refused).
      await labOf(actor, { eligible: true }, s);
      await deskBranch(actor, String(branch._id), input.visitMode, s);
      await writePatientIn(pp, { preferredLanguage: input.preferredLanguage, createdSource: 'lab_desk' }, s);
      await linkLabIn({ partnerId, userId: pp.userId, typedName: pp.holderTyped, recordedById: lower(actor.memberId), at: now }, s);
      // The desk may book a slot starting now (the 60-minute lead is for online bookings); a walk-in takes no seat (L11).
      const seat = walkIn ? null
        : await takeSeat(String(input.slotId), { partnerId, branchId: String(branch._id), visitMode: input.visitMode, minStart: now }, s);
      const slot = seat ? { slotId: String(seat._id), date: seat.date, startTime: seat.startTime, endTime: seat.endTime, startsAt: seat.startsAt }
        : { walkIn: true, startsAt: now, date: istDateIso(now), startTime: istTimeHhmm(now) };
      const [created] = await PartnerLabBookingModel.create([{
        _id: bookingId, partnerId, branchId: String(branch._id), userId: pp.userId,
        source: 'lab_desk', desk,
        patient: { kind: pp.dependentId ? 'dependent' : 'self', ...(pp.dependentId ? { dependentId: pp.dependentId } : {}), name: patientName },
        visitMode: input.visitMode, ...(input.visitMode === 'home' ? { address: input.address } : {}),
        slot,
        items: ordered.map(itemSnapshot),
        // The lab's catalogue price, for its bill and the patient's information; nothing is collected through Jansetu.
        pricing: { subtotalMinor: totalMinor, discountMinor: 0, payableMinor: totalMinor, commissionMinor: 0, currency: 'INR' },
        settlement: { settlementAccountId: String(account._id), beneficiaryName: account.beneficiaryName, settlementSystem: 'lab_desk' },
        status: 'confirmed', statusVersion: 0, paymentStatus: 'pending',
        ...(collector ? { collector } : {}),
        reschedule: { version: 0, pending: false },
        report: { draftFiles: [], releasedFiles: [], releases: [] },
        lifecycle: { confirmedAt: now },
      }], { session: s });
      await recordPartnerAudit(actor, 'lab_desk.booked', { kind: 'lab_booking', id: bookingId }, {
        branchId: lower(branch._id), visitMode: input.visitMode, walkIn, itemCount: ordered.length, totalMinor, accountCreated: pp.created,
        ...(pp.dependentId ? { dependentId: pp.dependentId, dependentCreated: !!pp.newDependent } : {}), ...(collector?.memberId ? { collectorMemberId: collector.memberId } : {}),
      }, s);
      return { booking: created!.toObject() as IPartnerLabBooking, replayed: false };
    });
  } catch (e) {
    // A racing request under the same key committed first: its receipt (other content: 409; out of scope: 404).
    const raced = await replayOf(actor, storedKey, hash);
    if (raced) return receipt(actor, raced, true);
    // Another booking or desk opened this number's account meanwhile: book again once, on that account.
    if ((e as { code?: string }).code === 'ACCOUNT_OPENED_MEANWHILE' && attempt === 0) return createDeskBooking(actor, input, clock, 1);
    throw e;
  }
  if (made.replayed) return receipt(actor, made.booking, true);
  const b = made.booking;
  // After the commit, best effort: the patient is told where, and that they pay at the lab.
  try {
    await labService().notify({ userId: b.userId, type: 'booking_confirmed', title: 'Lab test booked',
      message: walkIn ? `Booked at ${partner.name}. Pay at the lab.`
        : `Booked at ${partner.name}: ${b.visitMode === 'home' ? 'home collection' : 'lab visit'} on ${b.slot.date} at ${b.slot.startTime}. Pay at the lab.`,
      bookingId: String(b._id), key: `labdesk:${b._id}:booked:customer` });
  } catch { /* best effort */ }
  void smsBooked('lab_booking', b);
  return receipt(actor, b, false);
}

// ───────────────────────────── By-key, abandon, cancel ─────────────────────────────

/** GET /partner-workspace/lab-desk/bookings/by-key/:key — the member's own key: 'used' (booking, or null once out of scope), 'abandoned', 'unknown'. */
export async function findDeskByKey(actor: PartnerActor, key: string) {
  await labOf(actor, { eligible: false });
  if (!ASSISTED_KEY.test(String(key ?? ''))) throw err(400, 'VALIDATION_ERROR', 'A valid key is required');
  const b = await PartnerLabBookingModel.findOne({ 'desk.requestKey': { $eq: storedDeskKey(actor, key), $type: 'string' } }).lean() as IPartnerLabBooking | null;
  if (b) return { state: 'used' as const, booking: inScope(actor, b) ? (await deskViews(actor, [b]))[0]! : null };
  const row = await RequestKeyModel.findOne({ scope: deskKeyScope(actor), key }).lean();
  return { state: row?.state === 'abandoned' ? 'abandoned' as const : 'unknown' as const };
}

/** POST /partner-workspace/lab-desk/bookings/by-key/:key/abandon — abandoned (it can never be booked) or used (here it is). */
export async function abandonDeskByKey(actor: PartnerActor, key: string) {
  await labOf(actor, { eligible: false });
  if (!ASSISTED_KEY.test(String(key ?? ''))) throw err(400, 'VALIDATION_ERROR', 'A valid key is required');
  if (await PartnerLabBookingModel.exists({ 'desk.requestKey': { $eq: storedDeskKey(actor, key), $type: 'string' } })) return findDeskByKey(actor, key);
  const state = await abandonRequestKey(deskKeyScope(actor), key);
  return state === 'abandoned' ? { state } : findDeskByKey(actor, key);
}

/** POST /partner-workspace/lab-desk/bookings/:id/cancel — desk rows of this lab in scope, while confirmed; nothing refunded. */
export async function cancelDeskBooking(actor: PartnerActor, bookingId: string, input: { reason?: string; expectedVersion?: number }) {
  await labOf(actor, { eligible: false });
  if (!OBJECT_ID.test(String(bookingId))) throw notFound();
  const reason = String(input.reason ?? '').trim() || 'Cancelled at the lab desk';
  return labService().cancelDeskBooking(actor, bookingId, { note: reason, expectedVersion: input.expectedVersion });
}
