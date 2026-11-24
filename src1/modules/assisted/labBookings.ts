import { randomBytes } from 'crypto';
import { ClientSession, Types } from 'mongoose';
import { Container } from 'typedi';
import { AppError } from '@/modules/common/types';
import { requestHashOf } from '@/modules/common/utils/canonicalJson';
import { canonicalMobile } from '@/modules/common/utils/phone';
import { assertUniqueIndex } from '@/modules/common/utils/requiredIndex';
import { runLedgerTransaction } from '@/modules/common/utils/bookingWalletFunding';
import UserModel from '@/modules/user/model';
import PharmacyModel from '@/modules/pharmacies/model';
import { CouponRedemptionModel } from '@/modules/coupon/model/redemption';
import { CouponService } from '@/modules/coupon/services';
import { CouponRepository } from '@/modules/coupon/repository';
import { PharmacyWalletTransactionModel } from '@/modules/pharmacyWallet/model';
import { postPharmacyMovementIn } from '@/modules/pharmacyWallet/ledger';
import { RequestKeyModel } from '@/modules/requestKeys/model';
import { abandonRequestKey, claimRequestKey } from '@/modules/requestKeys';
import PartnerOrgModel from '@/modules/partners/model';
import BranchModel from '@/modules/partners/model/branch';
import { PartnerLabBookingModel, type IPartnerLabBooking } from '@/modules/partners/model/labBooking';
import type { VisitMode } from '@/modules/partners/model/slot';
import { ensureSettlementAccount } from '@/modules/partners/services/settlement';
import { takeSeat } from '@/modules/partners/services/slots';
import { LAB_MIN_LEAD_MS, LAB_PAYMENT_WINDOW_MS, LabBookingService, admitLabItems, branchOffers, itemSnapshot } from '@/modules/partners/services/labBookings';
import { assertPharmacyLabOn } from '@/modules/assisted/flags';
import { countPairBookingIn } from '@/modules/assisted/limits';
import { auditIn } from '@/modules/assisted/support';
import { assistedBookerFilter } from '@/modules/assisted/refunds';
import { labDebitKey } from '@/modules/assisted/labRefunds';
import { bookerNames } from '@/modules/assisted/names';
import { bookerReportWindowOpen, labSourceOf } from '@/modules/assisted/labViews';
import { ASSISTED_KEY, type PharmacyActor } from '@/modules/assisted/consultations';
import { assertCardPaymentAvailable, bookerPayments, openCardOrderOf, type CardPaymentView } from '@/modules/assisted/cardPayments';
import { cancellationRefundOf, kickCardRefunds } from '@/modules/assisted/cardRefunds';
import {
  cleanName, countPhoneUse, linkPharmacyCustomerIn, patientIdentity, preparePatient, redeemCouponIn, spreadByPrice, writePatientIn,
  type AssistedPatientInput,
} from '@/modules/assisted/patient';
import { labCategoryOf, snapshotCuts } from '@/modules/referralCuts/service';
import type { AssistedBlock } from '@/modules/assisted/types';

/**
 * Assisted booking round 2a (ASSISTED_BOOKING_DESIGN.md §24.4): a PHARMACY books a partner-lab test for a walk-in patient
 * and pays from its Jansetu wallet. Mirrors the 1a consultation create (`createPharmacyConsultation`): validate →
 * replay → count the lookup → abandoned key → every refusable check (lab, branch, tests, family member, coupon, price
 * fence) with one answer for known and unknown numbers → ONE transaction (request key claim, the account of a new
 * number, family member, pharmacy-customer link, coupon redemption, seat, the booking with its `assisted` block, the
 * wallet debit with lots, the audit). Exactly once per (pharmacy, actor, request key) with a content hash.
 *
 * Owner, 23 Nov: no blocking limits except the hourly phone lookups (no per-number, new-account, cancellation-block or
 * pending-payment cap); the same booker–lab pair still raises an alert (never refuses).
 *
 * r14 (§24.5): `paymentMethod: 'razorpay'` books the same way but pays by card/UPI through the phase 1b card machinery
 * (assisted/cardPayments.ts, generalised by booking kind): the row is inserted `pending_payment` with its seat held and
 * ONE payment record id chosen before the insert (context `assisted_lab_booking`), no wallet debit; its Razorpay order is
 * made after the commit. Verify, reconcile and the sweeps confirm it once; the lab sweep expires it after 30 minutes.
 * Until it is paid it is the booker's alone (hidden from the patient and the lab). No pending-card cap (owner, 23 Nov).
 */
const LANGUAGE = /^[a-z]{2,3}$/;
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;
const err = (status: number, code: string, message: string, extra: Record<string, unknown> = {}) =>
  Object.assign(new AppError({ status, code, message }), extra);
const notFound = () => err(404, 'LAB_BOOKING_NOT_FOUND', 'Booking not found');
const lower = (v: unknown) => String(v ?? '').toLowerCase();
const orgKey = (pharmacyId: string) => `pharmacy:${lower(pharmacyId)}`;
const labService = () => Container.get(LabBookingService);

type Address = { line1: string; line2?: string; city: string; state?: string; pincode: string; landmark?: string };
export interface AssistedLabInput {
  requestKey: string;
  phone: string;
  patient: AssistedPatientInput;
  holderName?: string;
  consent: { agreed: boolean; statementVersion: string; statementLanguage: string };
  preferredLanguage: string;
  partnerId: string;
  branchId: string;
  visitMode: VisitMode;
  slotId: string;
  itemIds: string[];
  address?: Address;
  couponCode?: string;
  /** Price fence (§6.3): what the pharmacy pays, after the coupon, in paise. */
  acceptedPriceMinor: number;
  notes?: string;
  paymentMethod: 'wallet' | 'razorpay';
}

/** The stored key (unique `assisted.requestKey` on `partner_lab_bookings`) and the claim scope of a pharmacy's lab create. */
export const storedLabKey = (a: PharmacyActor, key: string) => `assisted_lab:pharmacy:${lower(a.pharmacyId)}:${lower(a.actorId)}:${key}`;
export const labKeyScope = (a: PharmacyActor) => `assisted_lab_create:${lower(a.pharmacyId)}:${lower(a.actorId)}`;

/** §5.1: 8 characters, RFC 4648 base32 (upper case, no padding). */
function newShortRef(): string {
  const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  return Array.from(randomBytes(8)).map((b) => ALPHABET[b & 31]).join('');
}

const cleanAddress = (x?: Address) => (x ? { line1: cleanName(x.line1), line2: cleanName(x.line2) || null, city: cleanName(x.city),
  state: cleanName(x.state) || null, pincode: cleanName(x.pincode), landmark: cleanName(x.landmark) || null } : null);
const uniqueIds = (ids: string[]) => [...new Set((ids ?? []).map(lower))].sort();

/** The content every partner-made lab booking binds its request key to (§24.3): patient, service and notes. */
export function labRequestContent(input: Pick<AssistedLabInput, 'phone' | 'patient' | 'holderName' | 'branchId' | 'visitMode' | 'itemIds' | 'address'
  | 'preferredLanguage' | 'notes'> & { slotId?: string }) {
  return {
    phone: canonicalMobile(input.phone) ?? input.phone,
    patient: patientIdentity(input.patient),
    holderName: input.holderName ? cleanName(input.holderName) : null,
    service: { branchId: lower(input.branchId), visitMode: input.visitMode, slotId: input.slotId ? lower(input.slotId) : null,
      itemIds: uniqueIds(input.itemIds), address: cleanAddress(input.address) },
    preferredLanguage: input.preferredLanguage,
    notes: input.notes?.trim() || null,
  };
}

/** The content a request key is bound to (§24.3): the payment method is excluded. */
export function assistedLabRequestHash(input: AssistedLabInput): string {
  const c = labRequestContent(input);
  return requestHashOf({ ...c, service: { ...c.service, partnerId: lower(input.partnerId) },
    couponCode: input.couponCode ? input.couponCode.trim().toUpperCase() : null, acceptedPriceMinor: input.acceptedPriceMinor });
}

/** §24.4.7: writers rely on these unique indexes (fail closed: 503 INDEXES_OUTDATED until sync-indexes has run). */
export async function assertAssistedLabIndexes(withCoupon: boolean): Promise<void> {
  await assertUniqueIndex(PartnerLabBookingModel, { 'assisted.requestKey': 1 });
  await assertUniqueIndex(PartnerLabBookingModel, { 'assisted.shortRef': 1 });
  await assertUniqueIndex(PharmacyWalletTransactionModel, { pharmacyId: 1, operationKey: 1 });
  await assertUniqueIndex(RequestKeyModel, { scope: 1, key: 1 });
  if (withCoupon) await assertUniqueIndex(CouponRedemptionModel, { couponCode: 1, bookingKind: 1, bookingId: 1 });
}

/**
 * The request rules every partner-made lab booking shares (pharmacy 2a, lab desk 2c): consent ticked, a request key, the
 * language, the phone, the visit mode with its address rule (home needs one, a lab visit has none), 1–20 different tests.
 */
export function validateLabRequest(input: Pick<AssistedLabInput, 'consent' | 'requestKey' | 'preferredLanguage' | 'phone' | 'visitMode' | 'address' | 'itemIds'>): void {
  if (!input.consent || input.consent.agreed !== true) throw err(400, 'CONSENT_REQUIRED', 'Tick "patient agreed" before booking for the patient');
  if (!ASSISTED_KEY.test(String(input.requestKey ?? ''))) throw err(400, 'REQUEST_KEY_REQUIRED', 'requestKey is required');
  if (!LANGUAGE.test(String(input.preferredLanguage ?? ''))) throw err(400, 'VALIDATION_ERROR', 'preferredLanguage must be a language code');
  if (!canonicalMobile(input.phone)) throw err(400, 'INVALID_PHONE', 'Enter a valid 10-digit mobile number');
  if (input.visitMode !== 'lab' && input.visitMode !== 'home') throw err(400, 'VALIDATION_ERROR', 'visitMode must be lab or home');
  if (input.visitMode === 'home' && !input.address) throw err(400, 'ADDRESS_REQUIRED', 'A home collection needs an address');
  if (input.visitMode === 'lab' && input.address) throw err(400, 'VALIDATION_ERROR', 'A lab visit has no address');
  const ids = input.itemIds ?? [];
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > 20 || ids.some((x) => !OBJECT_ID.test(String(x))) || uniqueIds(ids).length !== ids.length) {
    throw err(400, 'VALIDATION_ERROR', 'Choose 1 to 20 different tests');
  }
}

function validate(input: AssistedLabInput): void {
  validateLabRequest(input);
  if (input.paymentMethod !== 'wallet' && input.paymentMethod !== 'razorpay') {
    throw err(400, 'PAYMENT_METHOD_UNAVAILABLE', 'Lab tests booked for a patient are paid from the Jansetu wallet or by card/UPI');
  }
}

/** §24.1 item 12: a lab takes assisted bookings only while it is an active, verified lab (the S5 pattern for providers). */
export const labAdmissible = (p: Record<string, any> | null | undefined) => !!p && p.kind === 'lab' && p.isActive !== false && p.verification?.state === 'verified';

/**
 * §24.4.3 step 10, L24: lab coupons follow the diagnostics rules (against the PATIENT) plus the assisted rules — never a
 * per-user-limited coupon, a platform-funded one only when an admin allowed it on partner bookings. Provider-funded by
 * default (the lab bears it).
 */
async function labCouponFor(code: string | undefined, ctx: { userId: string; dependentId?: string; partnerId: string; items: { _id: unknown; kind: string }[]; listMinor: number }) {
  if (!code || !(ctx.listMinor > 0)) return null;
  const repo = new CouponRepository();
  const notForAssisted = () => err(400, 'COUPON_NOT_FOR_ASSISTED', 'This coupon cannot be used on a booking made for a patient');
  const fundedByOf = (c: { fundedBy?: string; corporateIds?: string[] }) => c.fundedBy ?? ((c.corporateIds ?? []).length > 0 ? 'platform' : 'provider');
  const known = await repo.findByCode(code);
  if (known && (known.usageLimitPerUser || (fundedByOf(known) === 'platform' && known.partnerUsable !== true))) throw notForAssisted();
  const patient = await UserModel.findById(ctx.userId).select({ corporateId: 1 }).lean() as { corporateId?: string } | null;
  const v = await new CouponService(repo).validateCoupon({ code, userId: ctx.userId, bookingType: 'external_diagnostics', bookingId: ctx.partnerId,
    dependentId: ctx.dependentId, ...(patient?.corporateId ? { corporateId: String(patient.corporateId) } : {}), purchaseAmount: ctx.listMinor / 100,
    testIds: ctx.items.filter((i) => i.kind === 'test').map((i) => String(i._id)),
    packageIds: ctx.items.filter((i) => i.kind === 'package').map((i) => String(i._id)) });
  if (!v.isValid || !v.coupon) throw err(400, 'INVALID_COUPON', v.message || 'Invalid coupon code');
  const c = v.coupon;
  if (c.usageLimitPerUser || (fundedByOf(c) === 'platform' && c.partnerUsable !== true)) throw notForAssisted();
  return { code: c.code, fundedBy: fundedByOf(c) as 'provider' | 'platform', discountMinor: Math.min(ctx.listMinor, Math.round(Number(v.discountAmount || 0) * 100)) };
}

// ───────────────────────────── The booker lab view (§24.4.2 allowlist) ─────────────────────────────

type Row = Record<string, any>;

/**
 * §24.4.2: the booker view of lab bookings THIS pharmacy made — the allowlist, raw field names. `patientName` is the
 * family member's name, else the holder as this pharmacy may see them (typed, else masked; the real name only on a
 * `customer_order` link). Released reports only while the booker may read them (released, operational — the routes
 * require it — and within 90 days of the first release, L3); never drafts, prices, keys or the funding internals.
 */
export async function bookerLabViews(rows: Row[], pharmacyId: string, now: Date = new Date()): Promise<Row[]> {
  const list = rows.filter((r) => r && typeof r === 'object');
  if (!list.length) return [];
  const [partners, branches, names, payments] = await Promise.all([
    PartnerOrgModel.find({ _id: { $in: [...new Set(list.map((r) => String(r.partnerId)))].filter((x) => OBJECT_ID.test(x)) } }).select({ name: 1 }).lean() as unknown as Promise<Row[]>,
    BranchModel.find({ _id: { $in: [...new Set(list.map((r) => String(r.branchId)))].filter((x) => OBJECT_ID.test(x)) } }).select({ name: 1, address: 1, phone: 1 }).lean() as unknown as Promise<Row[]>,
    bookerNames(list.map((r) => ({ _id: r._id, userId: r.userId, dependentId: r.patient?.dependentId })), pharmacyId),
    bookerPayments('lab_booking', list, pharmacyId),
  ]);
  const pBy = new Map(partners.map((x) => [String(x._id), x]));
  const bBy = new Map(branches.map((x) => [String(x._id), x]));
  return list.map((b) => {
    const a = (b.assisted ?? {}) as Row;
    const mine = a.bookedBy?.kind === 'pharmacy' && lower(a.bookedBy.id) === lower(pharmacyId);
    const branch = bBy.get(String(b.branchId));
    const holder = names.holders.get(lower(b.userId));
    const v: Row = {
      _id: String(b._id), source: labSourceOf(b), partnerId: b.partnerId, lab: { name: pBy.get(String(b.partnerId))?.name ?? null }, branchId: b.branchId,
      branch: branch ? { name: branch.name, address: branch.address, phone: branch.phone } : null,
      visitMode: b.visitMode, ...(b.address ? { address: b.address } : {}), slot: b.slot,
      items: (b.items ?? []).map((i: Row) => ({ name: i.name, kind: i.kind, code: i.code })),
      status: b.status, statusVersion: b.statusVersion,
      reschedule: b.reschedule ? { pending: !!b.reschedule.pending, version: b.reschedule.version, previousSlot: b.reschedule.previousSlot,
        reason: b.reschedule.reason, at: b.reschedule.at } : null,
      collector: b.collector?.name ? { name: b.collector.name } : null,
      cancellation: b.cancellation ? { reason: b.cancellation.reason, byKind: b.cancellation.byKind, at: b.cancellation.at } : null,
      lifecycle: b.lifecycle ?? {},
      patientName: names.patients.get(lower(b._id)) ?? null,
      holder: { pharmacyCustomerId: holder?.linkId ?? null, name: holder?.name ?? null, typedName: holder?.typedName ?? null },
      userId: b.userId,
      assisted: { shortRef: a.shortRef, bookedBy: { name: a.bookedBy?.name }, preferredLanguage: a.preferredLanguage,
        ...(a.identity?.disputed?.state ? { disputed: { state: a.identity.disputed.state } } : {}) },
      createdAt: b.createdAt, updatedAt: b.updatedAt,
    };
    // r10c / r10d / r14: how it is paid, this booker only (pay now and the refund choice on any device).
    const payment = payments.get(String(b._id));
    if (payment) v.payment = payment;
    const open = mine && bookerReportWindowOpen(b, now);
    v.report = { releases: open ? (b.report?.releases ?? []).map((r: Row) => ({ file: `/api/static/${r.path}`, releasedAt: r.releasedAt,
      signer: { name: r.signer?.name, kind: r.signer?.kind, registrationNumber: r.signer?.registrationNumber } })) : [] };
    return v;
  });
}
export async function bookerLabView(row: Row, pharmacyId: string, now?: Date): Promise<Row> {
  return (await bookerLabViews([row], pharmacyId, now))[0]!;
}

/**
 * The answer of a create (and of a replay): the booker's own receipt with its funding and split. r14: a card booking adds
 * its funding's `paymentTransactionId` and `payment` — the open Razorpay order while the booking waits for it (made
 * again here after a failed order call), else null.
 */
async function labReceipt(b: IPartnerLabBooking, pharmacyId: string, replayed: boolean, order?: CardPaymentView | null) {
  const a = b.assisted!;
  const card = a.funding.method === 'razorpay';
  // The order first, so the booking view below shows the same open order.
  const payment = card ? (order !== undefined ? order : await openCardOrderOf('lab_booking', b as never)) : undefined;
  return {
    booking: await bookerLabView(b as never, pharmacyId),
    funding: { method: a.funding.method, amountMinor: a.funding.amountMinor, state: a.funding.state, walletEntryId: a.funding.walletEntryId ?? null,
      ...(card ? { paymentTransactionId: a.funding.paymentRecordId ?? null } : {}) },
    split: { listMinor: a.split.listMinor, discountMinor: a.split.discountMinor, couponCode: a.split.couponCode ?? null },
    ...(card ? { payment } : {}),
    newAccount: !!a.identity?.newAccount,
    replayed,
  };
}

/**
 * After a lab booking is booked and paid (a wallet create; r14: the confirmation of a card payment), best effort: the
 * patient is told who booked and paid. The lab sees the row in its list (L18).
 */
export async function notifyLabBooked(b: IPartnerLabBooking): Promise<void> {
  // SMS phase 5: "<pharmacy> booked a lab test (lab visit / home collection) on <date time>. Ref <ref>"
  try {
    await labService().notify({ userId: b.userId, type: 'booking_confirmed', title: 'Lab test booked',
      message: `${b.assisted!.bookedBy.name} booked a lab test (${b.visitMode === 'home' ? 'home collection' : 'lab visit'}) on ${b.slot.date} at ${b.slot.startTime}. Ref ${b.assisted!.shortRef}.`,
      bookingId: String(b._id), key: `assisted:lab:${b._id}:booked:customer` });
  } catch { /* best effort */ }
}

async function replayOf(storedKey: string, hash: string, s?: ClientSession): Promise<IPartnerLabBooking | null> {
  const prior = await PartnerLabBookingModel.findOne({ 'assisted.requestKey': { $eq: storedKey } }).session(s ?? null).lean() as IPartnerLabBooking | null;
  if (!prior) return null;
  if (prior.assisted?.requestHash !== hash) throw err(409, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different booking');
  return prior;
}

// ───────────────────────────── Create (§24.4.3) ─────────────────────────────

/** POST /pharmacy-assisted/lab-bookings — 201 with the receipt; a replay of the same key and content is 200 `replayed`. */
export async function createPharmacyLabBooking(actor: PharmacyActor, input: AssistedLabInput, clock: () => Date = () => new Date(), attempt = 0)
  : Promise<Awaited<ReturnType<typeof labReceipt>>> {
  assertPharmacyLabOn();
  validate(input);
  const phone = canonicalMobile(input.phone)!;
  const storedKey = storedLabKey(actor, input.requestKey);
  const hash = assistedLabRequestHash(input);
  const pharmacyId = lower(actor.pharmacyId);
  await assertAssistedLabIndexes(!!input.couponCode);
  // The same key with the same content answers its receipt first, uncounted.
  const replay = await PartnerLabBookingModel.findOne({ 'assisted.requestKey': { $eq: storedKey } }).lean() as IPartnerLabBooking | null;
  if (replay && replay.assisted?.requestHash === hash) return labReceipt(replay, pharmacyId, true);
  // r14: card/UPI only while ASSISTED_CARD_PAYMENT_ENABLED is on, the gateway has keys and the card refunds' index is built
  // (decided before anything is counted or held, the same answer for every number).
  const card = input.paymentMethod === 'razorpay';
  if (card) await assertCardPaymentAvailable();
  // Every other create names a phone like a lookup does: counted (the one limit the owner kept) and audited (ids only).
  if (attempt === 0) {
    await countPhoneUse(orgKey(pharmacyId), phone, (seen) => auditIn({ actorKind: 'pharmacy', actorId: lower(actor.actorId), orgKind: 'pharmacy', orgId: pharmacyId,
      action: 'booking.attempted', requestKey: input.requestKey, detail: { kind: 'lab_booking', ...seen } }, null));
  }
  const prior = await replayOf(storedKey, hash);
  if (prior) return labReceipt(prior, pharmacyId, true);
  if (await RequestKeyModel.exists({ scope: labKeyScope(actor), key: input.requestKey, state: 'abandoned' })) {
    throw err(409, 'REQUEST_ABANDONED', 'This request was cancelled before it was recorded; make a new one');
  }

  // The service (§24.1 item 12): an active, verified lab; an active branch of it offering the visit mode; active tests
  // of that lab, not disabled by an admin, offered for the visit mode. Refused before any account is touched.
  if (!OBJECT_ID.test(input.partnerId)) throw err(404, 'LAB_NOT_FOUND', 'This lab is not available');
  const partner = await PartnerOrgModel.findById(input.partnerId).lean() as Record<string, any> | null;
  if (!labAdmissible(partner)) throw err(404, 'LAB_NOT_FOUND', 'This lab is not available');
  const branch = OBJECT_ID.test(input.branchId) ? await BranchModel.findById(input.branchId).lean() as Record<string, any> | null : null;
  if (!branch || String(branch.partnerId) !== String(partner!._id) || branch.isActive === false || !branchOffers(branch, input.visitMode)) {
    throw err(404, 'BRANCH_NOT_AVAILABLE', 'This branch does not offer that visit type');
  }
  // Stable line order: the order the pharmacy listed the tests in.
  const ordered = await admitLabItems(String(partner!._id), input.itemIds, input.visitMode) as (Row & { _id: unknown; kind: string })[];

  // The patient (review 4 of 1a: no create is an existence test): every refusable step runs BEFORE any account is
  // opened and answers the same for a known and an unknown number; a new number's account opens only in the transaction.
  const pp = await preparePatient({ phone, patient: input.patient, holderName: input.holderName, preferredLanguage: input.preferredLanguage });
  const customer = { _id: pp.userId, created: pp.created };
  const { dependentId, newDependent, holderTyped } = pp;
  // The names rule (§24.3): the stored patient name is the family member's or the TYPED holder name, never the account name.
  const patientName = pp.patientName;

  const listMinor = ordered.reduce((x, i) => x + Number(i.priceMinor || 0), 0);
  const coupon = await labCouponFor(input.couponCode, { userId: customer._id, dependentId, partnerId: String(partner!._id), items: ordered, listMinor });
  const discountMinor = coupon?.discountMinor ?? 0;
  const payMinor = Math.max(0, listMinor - discountMinor);
  if (input.acceptedPriceMinor !== payMinor) {
    throw err(409, 'PRICE_CHANGED', 'The price changed; check it with the patient and book again', { details: { priceMinor: payMinor, listMinor, discountMinor } });
  }
  // r14: a card payment needs an amount (Razorpay refuses 0); free tests (a 100 % coupon) are booked with the wallet method.
  if (card && payMinor <= 0) throw err(400, 'NOTHING_TO_PAY', 'Nothing to pay for these tests; book them with paymentMethod "wallet"');
  // provider_coupon_v2 (§8.3): coupon first, then the cut (0 in phase 2). Provider-funded: the base is what was paid.
  const platformFunded = coupon?.fundedBy === 'platform';
  const baseMinor = platformFunded ? listMinor : payMinor;
  const lineDiscounts = spreadByPrice(ordered.map((i) => Number(i.priceMinor || 0)), discountMinor);
  const pharmacy = await PharmacyModel.findById(pharmacyId).select({ name: 1 }).lean() as { name?: string } | null;
  // Phase 4a (§26.5.3): each test or package line's referral cut, snapshotted now (0 while the switch is off).
  const lineBases = ordered.map((i, n) => (platformFunded ? Number(i.priceMinor || 0) : Number(i.priceMinor || 0) - lineDiscounts[n]!));
  const cut = await snapshotCuts({ kind: 'pharmacy', id: pharmacyId, name: pharmacy?.name ?? 'Pharmacy' },
    ordered.map((i, n) => ({ category: labCategoryOf(i.kind), baseMinor: lineBases[n]! })));
  const lines = ordered.map((i, n) => ({ catalogItemId: String(i._id), listMinor: Number(i.priceMinor || 0), discountMinor: lineDiscounts[n]!,
    baseMinor: lineBases[n]!, cutMinor: cut.lines[n]?.cutMinor ?? 0, ...(cut.lines[n] ? { category: cut.lines[n]!.category, referral: cut.lines[n]! } : {}) }));
  const account = await ensureSettlementAccount('partner', String(partner!._id), partner!.legalName || partner!.name);
  const now = clock();
  const bookingId = new Types.ObjectId().toHexString();
  const entryId = new Types.ObjectId();
  // r14: a card booking's one payment record id, stored on the funding before the order exists.
  const paymentRecordId = card ? new Types.ObjectId().toHexString() : undefined;
  const assisted: Omit<AssistedBlock, 'join'> = {
    bookedBy: { kind: 'pharmacy', id: pharmacyId, actorKind: 'pharmacy', actorId: lower(actor.actorId), name: pharmacy?.name ?? 'Pharmacy' },
    consent: { method: 'partner_attested', statementVersion: input.consent.statementVersion, statementLanguage: input.consent.statementLanguage,
      at: now, actorId: lower(actor.actorId) },
    preferredLanguage: input.preferredLanguage,
    identity: { attested: true, newAccount: customer.created },
    funding: card
      ? { method: 'razorpay', payerKind: 'pharmacy', payerId: pharmacyId, amountMinor: payMinor, state: 'pending', paymentRecordId, refunds: [] }
      : { method: 'wallet', payerKind: 'pharmacy', payerId: pharmacyId, amountMinor: payMinor, state: 'captured',
        ...(payMinor > 0 ? { walletEntryId: String(entryId) } : {}), refunds: [] },
    split: { listMinor, ...(coupon ? { couponCode: coupon.code, couponFundedBy: coupon.fundedBy } : {}), discountMinor, baseMinor,
      cutMinor: cut.totalCutMinor, providerMinor: baseMinor - cut.totalCutMinor, rule: 'provider_coupon_v2', lines },
    referral: cut.referral,
    shortRef: newShortRef(),
    requestKey: storedKey,
    requestHash: hash,
  };

  let made: { booking: IPartnerLabBooking; replayed: boolean };
  try {
    made = await runLedgerTransaction(async (s) => {
      // A racing identical request that committed first answers with its booking (and other content with 409).
      const again = await replayOf(storedKey, hash, s);
      if (again) return { booking: again, replayed: true };
      await claimRequestKey(labKeyScope(actor), input.requestKey, s);
      await writePatientIn(pp, { preferredLanguage: input.preferredLanguage }, s);
      await linkPharmacyCustomerIn(actor, customer._id, holderTyped, s);
      // P10, alert only: the same pharmacy–lab pair at N bookings a day.
      await countPairBookingIn('pharmacy', pharmacyId, `lab:${lower(partner!._id)}`, s);
      if (coupon) {
        await redeemCouponIn(coupon, { bookingKind: 'lab_booking', payerKind: 'pharmacy', bookingId, patientUserId: customer._id, dependentId, payerId: pharmacyId }, s);
      }
      // The S5 pattern: the lab is re-read in the transaction (suspended or unverified meanwhile: the same 404).
      if (!labAdmissible(await PartnerOrgModel.findById(partner!._id).session(s).lean() as Row | null)) throw err(404, 'LAB_NOT_FOUND', 'This lab is not available');
      const slot = await takeSeat(input.slotId, { partnerId: String(partner!._id), branchId: String(branch._id), visitMode: input.visitMode,
        minStart: new Date(now.getTime() + LAB_MIN_LEAD_MS) }, s);
      const [created] = await PartnerLabBookingModel.create([{
        _id: bookingId, partnerId: String(partner!._id), branchId: String(branch._id), userId: customer._id,
        source: 'pharmacy_assisted', assisted,
        patient: { kind: dependentId ? 'dependent' : 'self', ...(dependentId ? { dependentId } : {}), name: patientName || 'Patient' },
        visitMode: input.visitMode, ...(input.visitMode === 'home' ? { address: input.address } : {}),
        slot: { slotId: String(slot._id), date: slot.date, startTime: slot.startTime, endTime: slot.endTime, startsAt: slot.startsAt },
        items: ordered.map(itemSnapshot),
        pricing: { subtotalMinor: listMinor, ...(coupon ? { couponCode: coupon.code } : {}), discountMinor, payableMinor: payMinor, commissionMinor: 0, currency: 'INR' },
        settlement: { settlementAccountId: String(account._id), beneficiaryName: account.beneficiaryName, settlementSystem: 'ledger' },
        // A wallet row is never pending_payment, so the unpaid sweep never sees it (§24.4.1). r14: a card row waits for its
        // payment for 30 minutes (its seat held); the lab sweep then expires it, after asking Razorpay.
        status: card ? 'pending_payment' : 'confirmed', statusVersion: 0, paymentStatus: card ? 'pending' : 'paid',
        paymentDeadline: card ? new Date(now.getTime() + LAB_PAYMENT_WINDOW_MS) : now,
        reschedule: { version: 0, pending: false },
        report: { draftFiles: [], releasedFiles: [], releases: [] },
        lifecycle: card ? {} : { paidAt: now, confirmedAt: now },
      }], { session: s });
      if (payMinor > 0 && !card) {
        await postPharmacyMovementIn({ pharmacyId, kind: 'booking_debit', amountPaise: payMinor, operationKey: labDebitKey(bookingId),
          referenceType: 'assisted_lab_booking', referenceId: `${bookingId}:debit`, description: 'Assisted lab test booking', entryId }, s);
      }
      await auditIn({ actorKind: 'pharmacy', actorId: lower(actor.actorId), orgKind: 'pharmacy', orgId: pharmacyId, action: 'booking.created',
        bookingId, requestKey: input.requestKey,
        detail: { kind: 'lab_booking', partnerId: lower(partner!._id), branchId: lower(branch._id), itemCount: ordered.length, amountMinor: payMinor,
          method: card ? 'razorpay' : 'wallet',
          accountCreated: customer.created, ...(dependentId ? { dependentId, dependentCreated: !!newDependent } : {}), ...(coupon ? { couponCode: coupon.code } : {}) } }, s);
      return { booking: created!.toObject() as IPartnerLabBooking, replayed: false };
    });
  } catch (e) {
    const raced = await replayOf(storedKey, hash);
    if (raced) return labReceipt(raced, pharmacyId, true);
    // Another booking or desk opened this number's account meanwhile: book again once, on that account.
    if ((e as { code?: string }).code === 'ACCOUNT_OPENED_MEANWHILE' && attempt === 0) return createPharmacyLabBooking(actor, input, clock, 1);
    throw e;
  }
  if (made.replayed) return labReceipt(made.booking, pharmacyId, true);
  const b = made.booking;
  // r14: a card booking opens its Razorpay order now; the patient hears of it only once it is paid (C7).
  if (card) return labReceipt(b, pharmacyId, false, await openCardOrderOf('lab_booking', b as never));
  await notifyLabBooked(b);
  return labReceipt(b, pharmacyId, false);
}

// ───────────────────────────── Reads, by-key, cancel, accept (§24.4.2) ─────────────────────────────

/** GET /pharmacy-assisted/labs — verified, active labs with active branches, nearest first (pincode, then city). */
export async function listLabsForPharmacy(actor: PharmacyActor, q: { visitMode?: VisitMode; limit?: number }) {
  assertPharmacyLabOn();
  const pharmacy = await PharmacyModel.findById(actor.pharmacyId).select({ city: 1, pincode: 1 }).lean() as { city?: string; pincode?: string } | null;
  const labs = await labService().listLabs({ ...(q.visitMode ? { visitMode: q.visitMode } : {}) });
  const same = (a?: string, b?: string) => !!a && !!b && a.trim().toLowerCase() === b.trim().toLowerCase();
  const rows = labs.map((l) => {
    const branches = l.branches.map((b) => ({ branchId: b.branchId, name: b.name, address: b.address, phone: b.phone, homeCollection: b.homeCollection, inLab: b.inLab }));
    const nearby = branches.some((b) => same((b.address as Row | undefined)?.pincode, pharmacy?.pincode)) ? 'pincode' as const
      : branches.some((b) => same((b.address as Row | undefined)?.city, pharmacy?.city)) ? 'city' as const : null;
    return { partnerId: l.partnerId, name: l.name, nearby, branches };
  });
  const rank = (n: string | null) => (n === 'pincode' ? 0 : n === 'city' ? 1 : 2);
  rows.sort((a, b) => rank(a.nearby) - rank(b.nearby) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return rows.slice(0, Math.min(Math.max(Number(q.limit) || 50, 1), 100));
}

/** GET /pharmacy-assisted/labs/:partnerId/catalogue — the lab's bookable tests (the customer catalogue read). */
export async function labCatalogueForPharmacy(_actor: PharmacyActor, partnerId: string, visitMode?: VisitMode) {
  assertPharmacyLabOn();
  return labService().labCatalogue(partnerId, visitMode);
}

/** GET /pharmacy-assisted/labs/branches/:branchId/slots — bookable slots starting at least 60 min ahead, at most 14 days. */
export async function branchSlotsForPharmacy(_actor: PharmacyActor, branchId: string, q: { visitMode: VisitMode; from?: string; days?: number }) {
  assertPharmacyLabOn();
  return labService().branchSlots(branchId, q.visitMode, q.from, Math.min(Math.max(Number(q.days) || 7, 1), 14));
}

const ownFilter = (actor: PharmacyActor) => assistedBookerFilter('pharmacy', actor.pharmacyId);

async function ownLab(actor: PharmacyActor, bookingId: unknown): Promise<IPartnerLabBooking> {
  if (typeof bookingId !== 'string' || !OBJECT_ID.test(bookingId)) throw notFound();
  const b = await PartnerLabBookingModel.findOne({ _id: bookingId, ...ownFilter(actor) }).lean() as IPartnerLabBooking | null;
  if (!b) throw notFound();
  return b;
}

/** GET /pharmacy-assisted/lab-bookings/:id — the booker view; any booking this pharmacy did not book is the one 404. */
export async function getLabBookingForPharmacy(actor: PharmacyActor, bookingId: string) {
  return bookerLabView(await ownLab(actor, bookingId) as never, lower(actor.pharmacyId));
}

type Cursor = { at: Date; id: Types.ObjectId };
function parseCursor(c?: string): Cursor | null {
  if (c === undefined || c === '') return null;
  const [ms, cid, extra] = c.split('_');
  if (extra !== undefined || !/^\d{1,15}$/.test(ms ?? '') || !OBJECT_ID.test(cid ?? '')) throw err(400, 'INVALID_CURSOR', 'Invalid cursor');
  return { at: new Date(Number(ms)), id: new Types.ObjectId(cid) };
}

/** GET /pharmacy-assisted/lab-bookings — this pharmacy's lab bookings, newest first; cursor `<createdAt ms>_<id>`; slot-date range. */
export async function listLabBookingsForPharmacy(actor: PharmacyActor, q: { status?: string; from?: string; to?: string; cursor?: string; limit?: number }) {
  const filter: Row = { ...ownFilter(actor) };
  if (q.status) filter.status = { $eq: q.status };
  if (q.from || q.to) {
    if (q.from && q.to && q.from > q.to) throw err(400, 'INVALID_DATE_RANGE', 'from must not be after to');
    filter['slot.date'] = { ...(q.from ? { $gte: q.from } : {}), ...(q.to ? { $lte: q.to } : {}) };
  }
  const limit = Math.min(Math.max(Number(q.limit) || 20, 1), 50);
  const cur = parseCursor(q.cursor);
  const page = cur ? { $and: [filter, { $or: [{ createdAt: { $lt: cur.at } }, { createdAt: cur.at, _id: { $lt: cur.id } }] }] } : filter;
  const [total, rows] = await Promise.all([
    PartnerLabBookingModel.countDocuments(filter),
    PartnerLabBookingModel.find(page).sort({ createdAt: -1, _id: -1 }).limit(limit + 1).lean() as unknown as Promise<Row[]>,
  ]);
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items: await bookerLabViews(items, lower(actor.pharmacyId)), total,
    nextCursor: rows.length > limit && last ? `${new Date(last.createdAt).getTime()}_${String(last._id)}` : null };
}

/**
 * GET /pharmacy-assisted/lab-bookings/by-key/:key — 'used' (with the booking), 'abandoned' or 'unknown' (Q13). r14: a card
 * booking adds `payment` (its open order, or null; read only), as the consultation by-key does.
 */
export async function findLabByKey(actor: PharmacyActor, key: string) {
  if (!ASSISTED_KEY.test(String(key ?? ''))) throw err(400, 'VALIDATION_ERROR', 'A valid key is required');
  const b = await PartnerLabBookingModel.findOne({ 'assisted.requestKey': { $eq: storedLabKey(actor, key) } }).lean() as IPartnerLabBooking | null;
  if (b) {
    return { state: 'used' as const, booking: await bookerLabView(b as never, lower(actor.pharmacyId)),
      ...(b.assisted?.funding?.method === 'razorpay' ? { payment: await openCardOrderOf('lab_booking', b as never, { create: false }) } : {}) };
  }
  const row = await RequestKeyModel.findOne({ scope: labKeyScope(actor), key }).lean();
  return { state: row?.state === 'abandoned' ? 'abandoned' as const : 'unknown' as const };
}

/** POST /pharmacy-assisted/lab-bookings/by-key/:key/abandon — abandoned (it can never be booked) or used (here it is). */
export async function abandonLabByKey(actor: PharmacyActor, key: string) {
  if (!ASSISTED_KEY.test(String(key ?? ''))) throw err(400, 'VALIDATION_ERROR', 'A valid key is required');
  if (await PartnerLabBookingModel.exists({ 'assisted.requestKey': { $eq: storedLabKey(actor, key) } })) return findLabByKey(actor, key);
  const state = await abandonRequestKey(labKeyScope(actor), key);
  return state === 'abandoned' ? { state } : findLabByKey(actor, key);
}

/**
 * POST /pharmacy-assisted/lab-bookings/:id/cancel — the booker cancels its own lab booking (§24.4.4, L6): up to 1 hour
 * before the slot, or any time while a lab reschedule is unanswered; never after the sample or visit. Full refund once;
 * audited in the same transaction. Owner, 23 Nov: no cancellation cap (nothing is counted).
 * r14 (§24.5.3): a card-paid booking goes back to the card (default) or, on `refundTo: 'wallet'`, to the wallet (not
 * withdrawable, C3); the answer adds `refund` (its card refund row, null when cancelled before payment). A card booking
 * still waiting for its payment may be cancelled at any time (nothing was paid; its seat is released).
 */
export async function cancelLabByBooker(actor: PharmacyActor, bookingId: string, input: { reason?: string; expectedVersion?: number; refundTo?: 'card' | 'wallet' },
  clock: () => Date = () => new Date()) {
  await ownLab(actor, bookingId);
  const reason = String(input.reason ?? '').trim() || 'Cancelled by the booking partner';
  const r = await labService().cancelAsBooker(ownFilter(actor), lower(actor.pharmacyId), bookingId,
    { note: reason, expectedVersion: input.expectedVersion, ...(input.refundTo ? { refundTo: input.refundTo } : {}) }, clock(),
    async (b, s) => {
      await auditIn({ actorKind: 'pharmacy', actorId: lower(actor.actorId), orgKind: 'pharmacy', orgId: lower(actor.pharmacyId), action: 'booking.cancelled',
        bookingId: lower(b._id), detail: { kind: 'lab_booking', reason, cause: 'booker' } }, s);
    });
  const card = r.booking.assisted?.funding?.method === 'razorpay';
  // A card refund queued by this cancellation is sent now (best effort; the worker retries it).
  if (card && !r.alreadyCancelled) await kickCardRefunds(lower(bookingId));
  return { booking: await bookerLabView(r.booking as never, lower(actor.pharmacyId)), refundedMinor: Math.round(r.refunded * 100), alreadyCancelled: r.alreadyCancelled,
    ...(card ? { refund: await cancellationRefundOf(lower(bookingId)) } : {}) };
}

/** POST /pharmacy-assisted/lab-bookings/:id/accept-reschedule { version } — the booker accepts the lab's new time (L7). */
export async function acceptLabRescheduleByBooker(actor: PharmacyActor, bookingId: string, version: number) {
  const b = await labService().acceptRescheduleAsBooker(ownFilter(actor), bookingId, Number(version), async (x, s) => {
    await auditIn({ actorKind: 'pharmacy', actorId: lower(actor.actorId), orgKind: 'pharmacy', orgId: lower(actor.pharmacyId), action: 'booking.reschedule_accepted',
      bookingId: lower(x._id), detail: { kind: 'lab_booking', version: Number(version) } }, s);
  });
  try {
    await labService().notify({ userId: b.userId, type: 'general', title: 'New lab time accepted',
      message: `${b.assisted?.bookedBy.name ?? 'Your partner'} accepted the new time for your lab test: ${b.slot.date} at ${b.slot.startTime}. Ref ${b.assisted?.shortRef}.`,
      bookingId: String(b._id), key: `assisted:lab:${b._id}:reschedule:${b.reschedule.version}:accepted` });
  } catch { /* best effort */ }
  return bookerLabView(b as never, lower(actor.pharmacyId));
}
