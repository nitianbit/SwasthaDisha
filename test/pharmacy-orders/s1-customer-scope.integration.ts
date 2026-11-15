/**
 * S1: a customer's order list is their own, whatever they put in the query (?userId= / ?customerId= of someone else).
 * Real PharmacyOrderService.getAll + repository against MongoDB.
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/s1_scope_check?directConnection=true' JWT_SECRET_KEY=local-check-only \
 *     npx tsx --tsconfig tsconfig.json test/pharmacy-orders/s1-customer-scope.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import '@/modules/user/model';
import '@/modules/pharmacies/model';
import PharmacyOrderModel from '@/modules/pharmacyOrders/model';
import { PharmacyOrderRepository } from '@/modules/pharmacyOrders/repository';
import { PharmacyOrderService } from '@/modules/pharmacyOrders/services';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/s1_scope_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const service = new (PharmacyOrderService as unknown as new (...a: unknown[]) => PharmacyOrderService)(
  new PharmacyOrderRepository(), {}, {}, {}, {}, {}, {}, {}, {});

async function main() {
  await mongoose.connect(FIXTURE_URL);
  await mongoose.connection.dropDatabase();
  const me = new Types.ObjectId(); const other = new Types.ObjectId();
  const pharmacy = new Types.ObjectId(); const otherPharmacy = new Types.ObjectId();
  const base = { orderType: 'online', status: 'placed', items: [], grandTotal: 100, createdAt: new Date(), updatedAt: new Date() };
  await PharmacyOrderModel.collection.insertMany([
    { ...base, orderNumber: 'MINE-1', customerId: me, pharmacyId: pharmacy },
    { ...base, orderNumber: 'OTHER-1', customerId: other, pharmacyId: pharmacy },
    { ...base, orderNumber: 'OTHER-2', customerId: other, pharmacyId: otherPharmacy },
  ]);
  const numbers = async (filter: Record<string, unknown>, role = 'user', id = String(me)) =>
    (await service.getAll({ ...filter } as never, 1, 20, role, id)).data.map((o) => o.orderNumber).sort();

  assert.deepEqual(await numbers({}), ['MINE-1']);
  assert.deepEqual(await numbers({ userId: String(other) }), ['MINE-1'], '?userId= of another customer');
  assert.deepEqual(await numbers({ customerId: String(other) }), ['MINE-1'], '?customerId= of another customer');
  assert.deepEqual(await numbers({ userId: String(other), customerId: String(other) }), ['MINE-1']);
  assert.deepEqual(await numbers({ pharmacyId: String(otherPharmacy), userId: String(other) }), ['MINE-1']);
  console.log('ok - a customer lists only their own orders whatever the query says');

  // Admins keep the userId alias; a pharmacy stays within its own orders.
  assert.deepEqual(await numbers({ userId: String(other) }, 'admin', String(new Types.ObjectId())), ['OTHER-1', 'OTHER-2']);
  assert.deepEqual(await numbers({ userId: String(other) }, 'pharmacy', String(pharmacy)), ['OTHER-1']);
  console.log('ok - admins may filter by customer; a pharmacy only within its own orders');
  await mongoose.disconnect();
  console.log('2 checks passed');
}

main().catch(async (err) => { console.error(err); await mongoose.disconnect().catch(() => undefined); process.exit(1); });
