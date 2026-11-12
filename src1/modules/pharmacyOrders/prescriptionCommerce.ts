import { AppError } from '@/modules/common/types';

type PrescriptionCommerceInput =
  | { kind: 'new_items'; items: unknown; prescriptionUrls?: unknown }
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

function requireNonPrescriptionItems(items: unknown): asserts items is Record<string, unknown>[] {
  if (!Array.isArray(items) || !items.length) unavailable();
  for (const item of items) {
    if (!isRecord(item) ||
        !Object.prototype.hasOwnProperty.call(item, 'prescriptionRequired') ||
        item.prescriptionRequired !== false) unavailable();
  }
}

function requireNoPrescriptionDocuments(value: unknown): void {
  if (value !== undefined && (!Array.isArray(value) || value.length !== 0)) unavailable();
}

/** Prospective commerce only. Existing capture recording must not call this gate. */
export async function assertPrescriptionCommerceAvailable(input: PrescriptionCommerceInput): Promise<void> {
  if (input.kind === 'new_items') {
    requireNonPrescriptionItems(input.items);
    requireNoPrescriptionDocuments(input.prescriptionUrls);
    return;
  }
  if (input.kind !== 'stored_order' || !isRecord(input.order)) unavailable();
  const order = input.order;
  if (canonicalId(order._id) !== canonicalId(input.expectedOrderId) ||
      !Object.prototype.hasOwnProperty.call(order, 'prescriptionStatus') ||
      order.prescriptionStatus !== 'not_required' ||
      !Object.prototype.hasOwnProperty.call(order, 'prescriptionUrls') ||
      !Array.isArray(order.prescriptionUrls) || order.prescriptionUrls.length !== 0) unavailable();
  const items = order.items;
  requireNonPrescriptionItems(items);
  if (items.some(item => item.itemStatus !== 'active')) unavailable();
  const ids = items.map(item => canonicalId(item.medicineId));
  const remaining = new Set(ids);
  if (remaining.size !== ids.length) unavailable();

  const medicines = await input.readMedicines([...ids]);
  requireNonPrescriptionItems(medicines);
  if (medicines.length !== ids.length) unavailable();
  for (const medicine of medicines) {
    const id = canonicalId(medicine._id);
    if (!remaining.delete(id) || medicine.isActive === false || medicine.archivedAt) unavailable();
  }
  if (remaining.size) unavailable();
}
