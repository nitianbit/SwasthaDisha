import { ClientSession } from 'mongoose';
import { AppError } from '@/modules/common/types';
import PharmacyModel from '@/modules/pharmacies/model';
import PartnerOrgModel from '@/modules/partners/model';
import BranchModel from '@/modules/partners/model/branch';
import { hasGlobalScope, type PartnerActor } from '@/modules/partners/services';
import { assistedFlags, disabled } from '@/modules/assisted/flags';
import { auditIn } from '@/modules/assisted/support';
import type { AssistedAuditAction } from '@/modules/assisted/model';
import { linkLabIn, linkPharmacyCustomerIn } from '@/modules/assisted/patient';
import { assistedBookerFilter } from '@/modules/assisted/refunds';
import { labAdmissible } from '@/modules/assisted/labViews';

/**
 * Round 2e (ASSISTED_BOOKING_DESIGN.md §24.8.1): WHO books an assisted consultation — a pharmacy (1a) or a lab member
 * (2e). Everything that differs between the two lives here: the request keys, the switch, the admission and "nearby"
 * origin, the `bookedBy` block, the audit, the link to the account holder, who hears booker notices and which bookings
 * a booker may act on. The consultation create, commands and views take a `BookerActor` and are one code path.
 * The pharmacy strings (keys, scopes, org keys) are byte-identical to 1a.
 */
const err = (status: number, code: string, message: string) => new AppError({ status, code, message });
const lower = (v: unknown) => String(v ?? '').toLowerCase();
const OBJECT_ID = /^[0-9a-fA-F]{24}$/;


/** Phase 1a's pharmacy actor (kept for its callers). */
export interface PharmacyActor { pharmacyId: string; actorId: string }
export interface PharmacyBooker extends PharmacyActor { kind: 'pharmacy' }
/** A lab member booking for its lab, at one of its branches (`branchId`: where "nearby" is measured; in its scope). */
export interface LabBooker { kind: 'lab'; partnerId: string; memberId: string; branchId: string; actor: PartnerActor }
export type BookerActor = PharmacyBooker | LabBooker;

/** The booking organisation (a pharmacy or a lab partner), as stored in `assisted.bookedBy`. */
export interface BookerRef { kind: 'pharmacy' | 'lab'; id: string }
/** A booker organisation, or a pharmacy id as phase 0–2 callers pass it. */
export type BookerLike = string | BookerRef;
export const refOf = (b: BookerLike): BookerRef => (typeof b === 'string' ? { kind: 'pharmacy', id: lower(b) } : { kind: b.kind, id: lower(b.id) });

/** Phase 1a callers pass a pharmacy actor without `kind`. */
export const asBooker = (a: PharmacyActor | BookerActor): BookerActor => ('kind' in a ? a : { kind: 'pharmacy', pharmacyId: a.pharmacyId, actorId: a.actorId });
export const bookerRefOf = (b: BookerActor): BookerRef => (b.kind === 'pharmacy' ? { kind: 'pharmacy', id: lower(b.pharmacyId) } : { kind: 'lab', id: lower(b.partnerId) });
export const bookerActorIdOf = (b: BookerActor): string => lower(b.kind === 'pharmacy' ? b.actorId : b.memberId);
/** The organisation key of the hourly lookup limit and the alerts: `pharmacy:<id>` (as 1a) or `lab:<partnerId>` (as 2c). */
export const orgKeyOf = (b: BookerActor | BookerRef): string => {
  const r = 'id' in b ? b : bookerRefOf(b);
  return `${r.kind}:${r.id}`;
};

/** The stored request key of a consultation create (unique `assisted.requestKey`) and its claim scope. */
export const storedConsultKey = (b: BookerActor, key: string) => `assisted:${b.kind}:${bookerRefOf(b).id}:${bookerActorIdOf(b)}:${key}`;
export const consultKeyScope = (b: BookerActor) => (b.kind === 'pharmacy'
  ? `assisted_consult_create:${lower(b.pharmacyId)}:${lower(b.actorId)}` : `assisted_consult_create:lab:${lower(b.partnerId)}:${lower(b.memberId)}`);
export const rescheduleKeyScope = (b: BookerActor, bookingId: string) => (b.kind === 'pharmacy'
  ? `assisted_reschedule:${lower(b.pharmacyId)}:${lower(bookingId)}` : `assisted_reschedule:lab:${lower(b.partnerId)}:${lower(bookingId)}`);

/**
 * New assisted work of this booker kind (lookups, doctor reads, new consultations): ASSISTED_BOOKING_ENABLED_PHARMACY or
 * ASSISTED_BOOKING_ENABLED_LAB (2d's lab switch, which §24.8.3 extends to lab-made consultations). Off: 503.
 */
export function assertBookerOn(kind: BookerActor['kind']): void {
  if (kind === 'pharmacy' ? !assistedFlags.pharmacy() : !assistedFlags.lab()) throw disabled();
}

/**
 * The booker's name and where "nearby" is measured from. A pharmacy: its own address (its admission is the route's
 * `requireOperationalPharmacy`). A lab: an active, verified lab (S5, 403 otherwise; a clinic 403 LAB_PARTNER_REQUIRED) and
 * the member's branch: an active branch of this lab (404 BRANCH_NOT_AVAILABLE) inside the member's scope (403).
 */
export async function bookerOrigin(b: BookerActor, s?: ClientSession): Promise<{ name: string; pincode?: string; city?: string }> {
  if (b.kind === 'pharmacy') {
    const p = await PharmacyModel.findById(b.pharmacyId).select({ name: 1, city: 1, pincode: 1 }).session(s ?? null).lean() as Record<string, any> | null;
    return { name: p?.name ?? 'Pharmacy', pincode: p?.pincode, city: p?.city };
  }
  const p = OBJECT_ID.test(b.partnerId) ? await PartnerOrgModel.findById(b.partnerId).session(s ?? null).lean() as Record<string, any> | null : null;
  if (!p || p.kind !== 'lab') throw err(403, 'LAB_PARTNER_REQUIRED', 'Booking doctors for patients is for labs');
  if (!labAdmissible(p)) throw err(403, 'PARTNER_NOT_VERIFIED', 'Partner verification is required for this operation');
  if (!hasGlobalScope(b.actor) && !b.actor.branchIds.map(lower).includes(lower(b.branchId))) {
    throw err(403, 'BRANCH_SCOPE_EXCEEDED', 'Operation not allowed for this branch');
  }
  const branch = OBJECT_ID.test(b.branchId) ? await BranchModel.findById(b.branchId).session(s ?? null).lean() as Record<string, any> | null : null;
  if (!branch || lower(branch.partnerId) !== lower(b.partnerId) || branch.isActive === false) throw err(404, 'BRANCH_NOT_AVAILABLE', 'This branch is not available');
  return { name: p.name ?? 'Lab', pincode: branch.address?.pincode, city: branch.address?.city };
}

/** The `assisted.bookedBy` block (§5.1): from the admitted actor only. */
export const bookedByOf = (b: BookerActor, name: string) => (b.kind === 'pharmacy'
  ? { kind: 'pharmacy' as const, id: lower(b.pharmacyId), actorKind: 'pharmacy', actorId: lower(b.actorId), name }
  : { kind: 'lab' as const, id: lower(b.partnerId), branchId: lower(b.branchId), actorKind: 'member', actorId: lower(b.memberId), name });

/** The booker's audit (§6.1), in the action's transaction, ids and codes only: one trail (`assisted_audit_events`) for both kinds. */
export function auditBookerIn(b: BookerActor, action: AssistedAuditAction, fields: { bookingId?: string; requestKey?: string; detail?: Record<string, unknown> },
  s: ClientSession | null): Promise<void> {
  const ref = bookerRefOf(b);
  return auditIn({ actorKind: b.kind === 'pharmacy' ? 'pharmacy' : 'member', actorId: bookerActorIdOf(b), orgKind: ref.kind, orgId: ref.id, action, ...fields }, s);
}

/** §17.4: the booker's link to the account holder, with consent and the first typed name (pharmacy: S3 link; lab: `assisted_links`). */
export function linkBookerIn(b: BookerActor, userId: string, typedName: string, s: ClientSession): Promise<void> {
  if (b.kind === 'pharmacy') return linkPharmacyCustomerIn(b, userId, typedName, s);
  return linkLabIn({ partnerId: b.partnerId, userId, typedName, recordedById: lower(b.memberId), at: new Date() }, s);
}

/** Who reads a booker notice: the pharmacy (one account), or the lab member who booked (partner notices are per member). */
export const bookerNoticeUserId = (bookedBy: { kind: string; id: string; actorId?: string }): string =>
  (bookedBy.kind === 'pharmacy' ? bookedBy.id : String(bookedBy.actorId ?? bookedBy.id));

/** The assisted bookings this booker may act on: the pharmacy's; a lab's, at a branch in the member's scope. */
export function bookerBookingsFilter(b: BookerActor): Record<string, unknown> {
  if (b.kind === 'pharmacy') return assistedBookerFilter('pharmacy', b.pharmacyId);
  return { ...assistedBookerFilter('lab', b.partnerId),
    ...(hasGlobalScope(b.actor) ? {} : { 'assisted.bookedBy.branchId': { $in: b.actor.branchIds.map(lower) } }) };
}
