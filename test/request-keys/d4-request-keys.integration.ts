/**
 * D4 admission fence for once-only operations: a key is either performed ('used', claimed inside the operation's
 * transaction) or abandoned (POST /request-keys/abandon), never both, whatever the timing.
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/d4_keys_check?directConnection=true' JWT_SECRET_KEY=local-check-only \
 *     npx tsx --tsconfig tsconfig.json test/request-keys/d4-request-keys.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose, { Types } from 'mongoose';
import { CONFIG } from '@/config/config';
import { authenticate } from '@/modules/middleware/auth';
import { errorHandler } from '@/modules/middleware';
import UserModel from '@/modules/user/model';
import PharmacyModel from '@/modules/pharmacies/model';
import { abandonRequestKey, claimRequestKey, requestKeyRouter, scopeOf } from '@/modules/requestKeys';
import { RequestKeyModel } from '@/modules/requestKeys/model';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/d4_keys_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const Effect = mongoose.model('D4Effect', new mongoose.Schema({ key: String }, { collection: 'd4_effects' }));

/** A stand-in for a once-only operation: claims its key and writes its effect in one transaction. */
async function perform(scope: string, key: string, beforeClaim?: () => Promise<void>): Promise<'done' | string> {
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      if (beforeClaim) await beforeClaim();
      await claimRequestKey(scope, key, session);
      await Effect.create([{ key }], { session });
    });
    return 'done';
  } catch (e) {
    return (e as { code?: string }).code ?? 'ERROR';
  } finally {
    await session.endSession();
  }
}

let passed = 0;
async function check(name: string, fn: () => Promise<void>) { await fn(); passed++; console.log('ok -', name); }

async function main() {
  await mongoose.connect(FIXTURE_URL);
  await mongoose.connection.dropDatabase();
  await RequestKeyModel.createCollection(); await RequestKeyModel.syncIndexes();
  await Effect.createCollection();

  await check('a performed key cannot be abandoned; an abandoned key is never performed', async () => {
    assert.equal(await perform('s', 'k-used-0001'), 'done');
    assert.equal(await abandonRequestKey('s', 'k-used-0001'), 'used');
    assert.equal(await abandonRequestKey('s', 'k-gone-0001'), 'abandoned');
    assert.equal(await abandonRequestKey('s', 'k-gone-0001'), 'abandoned', 'idempotent');
    assert.equal(await perform('s', 'k-gone-0001'), 'REQUEST_ABANDONED');
    assert.equal(await Effect.countDocuments({ key: 'k-gone-0001' }), 0);
    assert.equal(await perform('other-scope', 'k-gone-0001'), 'done', 'keys are scoped');
  });

  await check('a request delayed before its transaction (reload, then abandon) is refused when it finally runs', async () => {
    // The original request is still on its way; the reloaded client abandons its key; the request then arrives.
    assert.equal(await abandonRequestKey('s', 'k-late-0001'), 'abandoned');
    assert.equal(await perform('s', 'k-late-0001'), 'REQUEST_ABANDONED');
    assert.equal(await Effect.countDocuments({ key: 'k-late-0001' }), 0);
  });

  await check('a concurrent perform and abandon: exactly one wins, every time', async () => {
    for (let i = 0; i < 25; i++) {
      const key = `k-race-${String(i).padStart(4, '0')}`;
      let abandonResult: string | undefined;
      // The abandon runs while the operation's transaction is open (after its first read, before its claim).
      const outcome = await perform('race', key, async () => { abandonResult ??= await abandonRequestKey('race', key); });
      const effects = await Effect.countDocuments({ key });
      const claim = await RequestKeyModel.findOne({ scope: 'race', key }).lean();
      if (claim?.state === 'abandoned') { assert.equal(effects, 0); assert.notEqual(outcome, 'done'); }
      else { assert.equal(claim?.state, 'used'); assert.equal(effects, 1); assert.equal(outcome, 'done'); }
      assert.ok(abandonResult === 'abandoned' || abandonResult === 'used');
      assert.equal(abandonResult === 'abandoned', claim?.state === 'abandoned');
    }
  });

  await check('POST /request-keys/abandon is scoped to the caller (pharmacy returns, customer bookings)', async () => {
    const user = await UserModel.create({ phone: '9500000001', userType: 'user', isActive: true });
    const ph = await PharmacyModel.collection.insertOne({ phone: '9500000002', email: 'k@example.in', isActive: true, isVerified: true } as never);
    const pharmacyId = ph.insertedId.toHexString();
    const app = express(); app.use(express.json());
    app.use('/api/v1/request-keys', authenticate, requestKeyRouter); app.use(errorHandler);
    const server = app.listen(0);
    try {
      const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/v1/request-keys/abandon`;
      const tok = (c: object) => jwt.sign(c, CONFIG.JWT_SECRET_KEY, { expiresIn: '1h' });
      const call = async (token: string, body: object) => {
        const r = await fetch(base, { method: 'POST', headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' }, body: JSON.stringify(body) });
        return { status: r.status, body: await r.json() as { data?: { state?: string } } };
      };
      const customer = tok({ _id: String(user._id), userType: 'user' });
      const pharmacy = tok({ _id: pharmacyId, userType: 'pharmacy', pharmacyId });
      const b = await call(customer, { kind: 'booking_create', key: 'bk-key-0001' });
      assert.equal(b.status, 200); assert.equal(b.body.data?.state, 'abandoned');
      assert.ok(await RequestKeyModel.exists({ scope: scopeOf('booking_create', String(user._id)), key: 'bk-key-0001' }));
      assert.equal((await call(customer, { kind: 'customer_return', key: 'rt-key-0001' })).status, 403);
      assert.equal((await call(pharmacy, { kind: 'booking_create', key: 'bk-key-0002' })).status, 403);
      const r = await call(pharmacy, { kind: 'customer_return', key: 'rt-key-0001' });
      assert.equal(r.status, 200);
      assert.ok(await RequestKeyModel.exists({ scope: scopeOf('customer_return', pharmacyId), key: 'rt-key-0001' }));
      assert.equal((await call(pharmacy, { kind: 'customer_return', key: 'x' })).status, 400);
      // A used key: the abandon answers with the exact record (caller-scoped), however old it is.
      const bk = new Types.ObjectId();
      await mongoose.connection.collection('bookings').insertOne({ _id: bk, userId: String(user._id), createRequestKey: 'bk-used-0003', status: 'pending', paymentStatus: 'pending' });
      await RequestKeyModel.create({ scope: scopeOf('booking_create', String(user._id)), key: 'bk-used-0003', state: 'used', at: new Date() });
      const used = await call(customer, { kind: 'booking_create', key: 'bk-used-0003' }) as { status: number; body: { data?: { state?: string; record?: { _id?: string } } } };
      assert.equal(used.body.data?.state, 'used'); assert.equal(used.body.data?.record?._id, bk.toHexString());
    } finally {
      server.close();
    }
  });

  await mongoose.disconnect();
  console.log(`${passed} checks passed`);
}

main().catch(async (e) => { console.error(e); await mongoose.disconnect(); process.exit(1); });
