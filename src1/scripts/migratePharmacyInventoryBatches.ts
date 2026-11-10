import mongoose from 'mongoose';
import { CONFIG } from '@/config/config';
import { InventoryItemModel } from '@/modules/pharmacyInventory/model';

function validYyyymmdd(value?: string): value is string {
  if (!value || !/^\d{8}$/.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(4, 6));
  const day = Number(value.slice(6, 8));
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

async function run(): Promise<void> {
  const commit = process.argv.includes('--commit');
  const limitArgument = process.argv.find((argument) => argument.startsWith('--limit='));
  const limit = limitArgument ? Number(limitArgument.split('=')[1]) : 0;
  if (limitArgument && (!Number.isInteger(limit) || limit < 1)) {
    throw new Error('--limit must be a positive integer');
  }

  await mongoose.connect(CONFIG.MONGODB_URL);
  const query = {
    $or: [{ batches: { $exists: false } }, { batches: { $size: 0 } }],
  };
  const cursor = InventoryItemModel.find(query).sort({ _id: 1 }).cursor();
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  let inspected = 0;
  let eligible = 0;
  let migrated = 0;
  const unresolved: Array<{ inventoryItemId: string; reason: string }> = [];

  for await (const item of cursor) {
    if (limit > 0 && inspected >= limit) break;
    inspected += 1;
    const totalQuantity = item.availableQty + item.reservedQty + item.freeQty;
    if (totalQuantity === 0) continue;
    if (!item.batchNumber?.trim()) {
      unresolved.push({ inventoryItemId: String(item._id), reason: 'missing batchNumber' });
      continue;
    }
    if (!validYyyymmdd(item.expiryDate)) {
      unresolved.push({ inventoryItemId: String(item._id), reason: 'missing or invalid expiryDate' });
      continue;
    }

    eligible += 1;
    if (!commit) continue;
    const status = item.expiryDate < today
      ? 'expired'
      : item.availableQty === 0 && item.reservedQty === 0
        ? 'depleted'
        : 'active';
    const result = await InventoryItemModel.updateOne(
      {
        _id: item._id,
        $or: [{ batches: { $exists: false } }, { batches: { $size: 0 } }],
      },
      {
        $set: {
          batches: [{
            batchNumber: item.batchNumber.trim().toUpperCase(),
            expiryDate: item.expiryDate,
            receivedAt: item.createdAt || new Date(),
            availableQty: item.availableQty,
            reservedQty: item.reservedQty,
            freeQty: item.freeQty,
            purchasePrice: item.purchasePrice,
            retailPrice: item.retailPrice,
            wholesalePrice: item.wholesalePrice,
            status,
            ...(status === 'depleted' ? { depletedAt: new Date() } : {}),
          }],
        },
      }
    );
    migrated += result.modifiedCount;
  }

  console.log(JSON.stringify({
    mode: commit ? 'commit' : 'dry-run',
    inspected,
    eligible,
    migrated,
    unresolvedCount: unresolved.length,
    unresolved: unresolved.slice(0, 100),
  }, null, 2));
  await mongoose.disconnect();

  if (commit && unresolved.length > 0) {
    process.exitCode = 2;
  }
}

run().catch(async (error) => {
  console.error(error instanceof Error ? error.message : error);
  await mongoose.disconnect().catch(() => undefined);
  process.exit(1);
});
