import MedicineModel from '@/modules/pharmacyMedicines/model';
import logger from '@/services/logger';

export function buildMedicineNameKey(name: string): string {
  return name.trim().toLowerCase();
}

export async function backfillMedicineNameKeys(): Promise<void> {
  const medicines = await MedicineModel.find({}, { _id: 1, name: 1, nameKey: 1 }).lean();
  const grouped = new Map<string, Array<{ _id: unknown; name: string; nameKey?: string }>>();

  for (const medicine of medicines) {
    const name = String(medicine.name || '').trim();
    if (!name) {
      continue;
    }

    const key = buildMedicineNameKey(name);
    const existing = grouped.get(key) ?? [];
    existing.push({
      _id: medicine._id,
      name,
      nameKey: medicine.nameKey,
    });
    grouped.set(key, existing);
  }

  let updatedCount = 0;
  const duplicateGroups: Array<{ key: string; ids: string[]; names: string[] }> = [];

  for (const [key, docs] of grouped.entries()) {
    if (docs.length > 1) {
      duplicateGroups.push({
        key,
        ids: docs.map((doc) => String(doc._id)),
        names: docs.map((doc) => doc.name),
      });
      continue;
    }

    const [doc] = docs;
    if (doc.nameKey === key) {
      continue;
    }

    await MedicineModel.updateOne({ _id: doc._id }, { $set: { nameKey: key } });
    updatedCount += 1;
  }

  if (updatedCount > 0) {
    logger.info('[PharmacyMedicines] backfilled medicine nameKey values', {
      updatedCount,
    });
  }

  if (duplicateGroups.length > 0) {
    logger.error('[PharmacyMedicines] duplicate medicine names need manual cleanup before full nameKey enforcement', {
      duplicateGroups,
    });
  }
}
