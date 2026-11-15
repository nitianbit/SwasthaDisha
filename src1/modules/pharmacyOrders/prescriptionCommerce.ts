import { AppError } from '@/modules/common/types';

/**
 * P9 (owner decision 15 Nov 2026): prescription (Rx) medicines may be ordered online; the pharmacist reviews them before
 * packing (P1 gates) and a rejection refunds (P2). This guard keeps every admission check that is not about Rx -
 * order identity, unique medicine ids, active non-archived catalogue membership, active line shape, a boolean Rx flag
 * per line - and allows Rx lines and prescription documents, except where `rx: 'forbid'` (refill orders: an Rx refill
 * would consume its cycle on payment even if the pharmacist later rejects it).
 */
type PrescriptionCommerceInput =
  | { kind: 'new_items'; items: unknown; prescriptionUrls?: unknown; rx?: 'allow' | 'forbid' }
  | {
      kind: 'stored_order';
      order: unknown;
      expectedOrderId: string;
      readMedicines: (ids: string[]) => Promise<readonly unknown[]>;
    };

function unavailable(): never {
  throw new AppError({
    status: 503,
    code: 'PRESCRIPTION_CHECKOUT_UNAVAILABLE',
    message: 'Prescription checkout is currently unavailable.',
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function canonicalId(value: unknown): string {
  const id = typeof value === 'string'
    ? value
    : isRecord(value) && (value._bsontype === 'ObjectID' || value._bsontype === 'ObjectId') &&
        typeof value.toHexString === 'function'
      ? value.toHexString()
      : undefined;
  if (typeof id !== 'string' || !/^[0-9a-fA-F]{24}$/.test(id)) unavailable();
  return id.toLowerCase();
}

/** Every line carries an explicit boolean Rx flag; with `forbid`, every flag must be false. */
function requireFlaggedItems(items: unknown, rx: 'allow' | 'forbid'): asserts items is Record<string, unknown>[] {
  if (!Array.isArray(items) || !items.length) unavailable();
  for (const item of items) {
    if (!isRecord(item) || !Object.prototype.hasOwnProperty.call(item, 'prescriptionRequired') ||
        typeof item.prescriptionRequired !== 'boolean') unavailable();
    if (rx === 'forbid' && item.prescriptionRequired !== false) unavailable();
  }
}

function requireDocumentList(value: unknown, rx: 'allow' | 'forbid'): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string')) unavailable();
  if (rx === 'forbid' && value.length !== 0) unavailable();
}

/** Prospective commerce only. Existing capture recording must not call this gate. */
export async function assertPrescriptionCommerceAvailable(input: PrescriptionCommerceInput): Promise<void> {
  if (input.kind === 'new_items') {
    const rx = input.rx ?? 'allow';
    requireFlaggedItems(input.items, rx);
    requireDocumentList(input.prescriptionUrls, rx);
    return;
  }
  if (input.kind !== 'stored_order' || !isRecord(input.order)) unavailable();
  const order = input.order;
  // Refill orders stay non-Rx (see above).
  const rx: 'allow' | 'forbid' = isRecord(order.refill) ? 'forbid' : 'allow';
  if (canonicalId(order._id) !== canonicalId(input.expectedOrderId) ||
      !Object.prototype.hasOwnProperty.call(order, 'prescriptionStatus') ||
      !Object.prototype.hasOwnProperty.call(order, 'prescriptionUrls')) unavailable();
  requireDocumentList(order.prescriptionUrls, rx);
  const items = order.items;
  requireFlaggedItems(items, rx);
  // An order with an Rx line is under review (pending) or reviewed; never "not required".
  if (items.some(item => item.prescriptionRequired === true) && order.prescriptionStatus === 'not_required') unavailable();
  if (rx === 'forbid' && order.prescriptionStatus !== 'not_required') unavailable();
  if (items.some(item => item.itemStatus !== 'active')) unavailable();
  const ids = items.map(item => canonicalId(item.medicineId));
  const remaining = new Set(ids);
  if (remaining.size !== ids.length) unavailable();

  const medicines = await input.readMedicines([...ids]);
  if (!Array.isArray(medicines) || medicines.length !== ids.length) unavailable();
  for (const medicine of medicines) {
    if (!isRecord(medicine)) unavailable();
    const id = canonicalId(medicine._id);
    if (!remaining.delete(id) || medicine.isActive === false || medicine.archivedAt) unavailable();
    if (rx === 'forbid' && medicine.prescriptionRequired !== false) unavailable();
  }
  if (remaining.size) unavailable();
}
