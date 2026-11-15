/**
 * P8: customer pharmacy orders - "pay again" (reuses the order's own open Razorpay order; checks earlier attempts first)
 * and once-only keyed checkout (a repeated key answers with the first order), against a real MongoDB replica set.
 * Real PharmacyOrderService / PharmacyCartService / PaymentService code; Razorpay, stock and catalogue are fakes.
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/p8_pay_again_check?directConnection=true' JWT_SECRET_KEY=local-check-only \
 *     npx tsx --tsconfig tsconfig.json test/pharmacy-payments/p8-pay-again.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import UserModel from '@/modules/user/model';
import PharmacyOrderModel from '@/modules/pharmacyOrders/model';
import { PharmacyOrderRepository } from '@/modules/pharmacyOrders/repository';
import { PharmacyOrderService } from '@/modules/pharmacyOrders/services';
import { PrescriptionRefundService } from '@/modules/pharmacyOrders/prescriptionRefund';
import PaymentRecordModel from '@/modules/payment/model';
import { PaymentRepository } from '@/modules/payment/repository';
import { PaymentService } from '@/modules/payment/services';
import { WalletModel, WalletTransactionModel } from '@/modules/wallet/model';
import { WalletRepository, WalletTransactionRepository } from '@/modules/wallet/repository';
import PharmacyCartModel from '@/modules/pharmacyCart/model';
import { PharmacyCartRepository } from '@/modules/pharmacyCart/repository';
import { PharmacyCartService } from '@/modules/pharmacyCart/services';
import { RequestKeyModel } from '@/modules/requestKeys/model';
import { abandonRequestKey, scopeOf } from '@/modules/requestKeys';
import { checkoutCartSchema } from '@/modules/pharmacyCart/validation';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/p8_pay_again_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const PHARMACY = new Types.ObjectId().toHexString();
const MED = new Types.ObjectId().toHexString();

/** Fake Razorpay: orders it created, and which of them are captured. `down` = the gateway cannot be reached. */
const gateway = { n: 0, created: [] as string[], amounts: new Map<string, number>(), captured: new Set<string>(), down: false };
const razorpay = {
  orders: {
    create: async (p: { amount: number; currency: string }) => { gateway.n += 1; const id = `order_fake_${gateway.n}`; gateway.created.push(id); gateway.amounts.set(id, p.amount); return { id, amount: p.amount, currency: p.currency, status: 'created' }; },
    fetchPayments: async (id: string) => {
      if (gateway.down) throw new Error('gateway unreachable');
      return { items: gateway.captured.has(id) ? [{ id: `pay_${id}`, order_id: id, amount: gateway.amounts.get(id) ?? 0, currency: 'INR', status: 'captured' }] : [] };
    },
  },
};

const inventory = {
  getInventoryByMedicine: async () => ({ retailPrice: 50, wholesalePrice: 40 }),
  reserveOrderStockBulk: async (_p: string, items: { medicineId: string }[]) => new Map(items.map((i) => [String(i.medicineId), []])),
  returnStockBulk: async () => [], releaseOrderStockBulk: async () => undefined, consumeOrderReservedStockBulk: async () => undefined,
};
const medicines = {
  findById: async () => ({ _id: MED, name: 'Vitamin D', isActive: true, prescriptionRequired: false, gstPercent: 0 }),
  findAll: async () => [{ _id: MED, name: 'Vitamin D', isActive: true, prescriptionRequired: false }],
};
const sideEffects = { queueNotification: async () => undefined, queueSubscriptionSync: async () => undefined };
const refunds = new PrescriptionRefundService({ listRefunds: async () => [], fetchRefund: async () => { throw new Error('x'); }, refund: async () => { throw new Error('x'); } } as never, new WalletRepository());

const payments = Object.assign(Object.create(PaymentService.prototype), {
  pharmacyOrderRepository: new PharmacyOrderRepository(), paymentRepository: new PaymentRepository(), inventoryService: inventory,
  pharmacyOrderSideEffectService: sideEffects, couponService: {}, incrementCouponUsageAfterProcessing: async () => undefined,
  walletRepository: new WalletRepository(), walletTransactionRepository: new WalletTransactionRepository(), medicineRepository: medicines,
  getRazorpayCredentials: () => ({ keyId: 'rzp_test_key', keySecret: 'secret' }),
  getRazorpayClient: () => razorpay,
}) as PaymentService;

const orders = new (PharmacyOrderService as unknown as new (...a: unknown[]) => PharmacyOrderService)(
  new PharmacyOrderRepository(), { ensureLinked: async () => undefined }, inventory, payments, {}, {}, sideEffects, medicines, refunds);
(orders as unknown as { validateLinkedReferences: () => Promise<void> }).validateLinkedReferences = async () => undefined;

const cartService = new (PharmacyCartService as unknown as new (...a: unknown[]) => PharmacyCartService)(
  new PharmacyCartRepository(), inventory, {}, medicines, orders);
Object.assign(cartService as unknown as Record<string, unknown>, {
  ensureTargetPharmacyAccessible: async () => undefined,
  buildCartItem: async (_role: string, _p: string, medicineId: string, quantity: number) =>
    ({ medicineId, medicineName: 'Vitamin D', quantity, unitPrice: 50, lineTotal: 50 * quantity, prescriptionRequired: false }),
});

async function customer() {
  const u = await UserModel.create({ phone: '9' + String(Math.floor(Math.random() * 1e9)).padStart(9, '0'), userType: 'user', isActive: true });
  await WalletModel.create({ userId: u._id, balance: 0, isActive: true });
  return { _id: String(u._id), userType: 'user' };
}
async function fillCart(actor: { _id: string; userType: string }, qty = 2) {
  await PharmacyCartModel.deleteMany({ actorId: actor._id });
  await PharmacyCartModel.create({ actorId: actor._id, actorRole: actor.userType, pharmacyId: PHARMACY,
    items: [{ medicineId: MED, medicineName: 'Vitamin D', quantity: qty, unitPrice: 50, lineTotal: 50 * qty, prescriptionRequired: false }], subtotal: 50 * qty });
}
const checkout = (actor: { _id: string; userType: string }, extra: Record<string, unknown> = {}) =>
  cartService.checkout(actor, { paymentMode: 'online_payment', deliveryMode: 'pickup', ...extra } as never) as Promise<{
    order: { _id: unknown; status: string; paymentStatus: string; paymentTransactionId?: string; createdAt?: Date }; paymentRequired: boolean;
    payment?: { paymentTransactionId: string; razorpayOrderId?: string; amount: number }; replayed?: boolean }>;
const records = (orderId: unknown) => PaymentRecordModel.countDocuments({ context: 'pharmacy_order', contextId: String(orderId) });
async function rejects(p: Promise<unknown>, code: string) { await assert.rejects(p, (e: { code?: string }) => { assert.equal(e.code, code); return true; }); }

let passed = 0;
async function check(name: string, fn: () => Promise<void>) { await fn(); passed++; console.log('ok -', name); }

async function main() {
  await mongoose.connect(FIXTURE_URL);
  await mongoose.connection.dropDatabase();
  await Promise.all([PharmacyOrderModel.syncIndexes(), PaymentRecordModel.init(), WalletModel.init(), WalletTransactionModel.init(),
    PharmacyCartModel.init(), RequestKeyModel.createCollection().then(() => RequestKeyModel.syncIndexes())]);

  await check('the checkout key is validated (8-64 safe characters) and optional', async () => {
    assert.equal(checkoutCartSchema.validate({ paymentMode: 'online_payment', requestKey: 'abcDEF12_-' }).error, undefined);
    assert.equal(checkoutCartSchema.validate({ paymentMode: 'online_payment' }).error, undefined);
    assert.ok(checkoutCartSchema.validate({ paymentMode: 'online_payment', requestKey: 'short' }).error);
    assert.ok(checkoutCartSchema.validate({ paymentMode: 'online_payment', requestKey: 'bad key!!' }).error);
  });

  await check('a repeated keyed checkout answers with the first order and its same open payment; never a second order', async () => {
    const me = await customer();
    await fillCart(me);
    const first = await checkout(me, { requestKey: 'checkout-key-0001' });
    assert.equal(first.paymentRequired, true); assert.ok(first.payment?.razorpayOrderId);
    assert.equal(await PharmacyCartModel.countDocuments({ actorId: me._id }), 0, 'the cart is emptied');
    const again = await checkout(me, { requestKey: 'checkout-key-0001' }); // answer lost; the app repeats the same key
    assert.equal(String(again.order._id), String(first.order._id)); assert.equal(again.replayed, true);
    assert.equal(again.payment?.razorpayOrderId, first.payment?.razorpayOrderId, 'the same Razorpay order');
    assert.equal(await PharmacyOrderModel.countDocuments({ customerId: me._id }), 1);
    assert.equal(await records(first.order._id), 1, 'no second payment record');
    assert.equal(await RequestKeyModel.countDocuments({ scope: scopeOf('pharmacy_checkout', me._id), state: 'used' }), 1);
    // A different customer's identical key is their own.
    const other = await customer();
    await fillCart(other);
    const theirs = await checkout(other, { requestKey: 'checkout-key-0001' });
    assert.notEqual(String(theirs.order._id), String(first.order._id));
  });

  await check('two concurrent checkouts with one key make one order; both answers name it', async () => {
    const me = await customer();
    await fillCart(me);
    const [a, b] = await Promise.all([checkout(me, { requestKey: 'checkout-race-001' }), checkout(me, { requestKey: 'checkout-race-001' })]);
    assert.equal(String(a.order._id), String(b.order._id));
    assert.equal(await PharmacyOrderModel.countDocuments({ customerId: me._id }), 1);
  });

  await check('an abandoned key never places an order later; a pharmacy cannot use customer keys', async () => {
    const me = await customer();
    await fillCart(me);
    assert.equal(await abandonRequestKey(scopeOf('pharmacy_checkout', me._id), 'checkout-gone-01'), 'abandoned');
    await rejects(checkout(me, { requestKey: 'checkout-gone-01' }), 'REQUEST_ABANDONED');
    assert.equal(await PharmacyOrderModel.countDocuments({ customerId: me._id }), 0);
    await rejects(cartService.checkout({ _id: new Types.ObjectId().toHexString(), userType: 'pharmacy', pharmacyId: new Types.ObjectId().toHexString() },
      { paymentMode: 'online_payment', requestKey: 'checkout-pharm-01' } as never), 'REQUEST_KEY_UNSUPPORTED');
  });

  await check('a used key cannot be abandoned: abandon answers "used"', async () => {
    const me = await customer();
    await fillCart(me);
    await checkout(me, { requestKey: 'checkout-used-02' });
    assert.equal(await abandonRequestKey(scopeOf('pharmacy_checkout', me._id), 'checkout-used-02'), 'used');
  });

  await check('pay again hands back the order\'s own open Razorpay order (no new one)', async () => {
    const me = await customer();
    await fillCart(me);
    const placed = await checkout(me);
    const before = gateway.created.length;
    const r = await orders.retryPayment(String(placed.order._id), me);
    assert.equal(r.paymentRequired, true);
    assert.equal(r.payment?.razorpayOrderId, placed.payment?.razorpayOrderId);
    assert.equal(r.payment?.amount, 100);
    assert.equal(gateway.created.length, before, 'no new Razorpay order');
    assert.equal(await records(placed.order._id), 1);
  });

  await check('pay again first checks earlier attempts: a capture whose confirmation was lost makes the order paid', async () => {
    const me = await customer();
    await fillCart(me);
    const placed = await checkout(me);
    gateway.captured.add(placed.payment!.razorpayOrderId!);
    const r = await orders.retryPayment(String(placed.order._id), me);
    assert.equal(r.paymentRequired, false);
    assert.equal(r.order.paymentStatus, 'paid');
    assert.equal((await PharmacyOrderModel.findById(placed.order._id).lean())!.status, 'accepted');
  });

  await check('while an earlier attempt cannot be checked, no payment is offered (503)', async () => {
    const me = await customer();
    await fillCart(me);
    const placed = await checkout(me);
    gateway.down = true;
    try { await rejects(orders.retryPayment(String(placed.order._id), me), 'PAYMENT_STATE_UNKNOWN'); } finally { gateway.down = false; }
  });

  await check('after the payment window, or for a closed / offline / someone else\'s order, pay again is refused', async () => {
    const me = await customer();
    await fillCart(me);
    const late = await checkout(me);
    await PharmacyOrderModel.collection.updateOne({ _id: new Types.ObjectId(String(late.order._id)) }, { $set: { createdAt: new Date(Date.now() - 31 * 60_000) } });
    await rejects(orders.retryPayment(String(late.order._id), me), 'ORDER_PAYMENT_EXPIRED');
    await fillCart(me);
    const closed = await checkout(me);
    await PharmacyOrderModel.updateOne({ _id: closed.order._id }, { $set: { status: 'cancelled' } });
    await rejects(orders.retryPayment(String(closed.order._id), me), 'ORDER_NOT_PAYABLE');
    await fillCart(me);
    const cod = await checkout(me, { paymentMode: 'cash_on_delivery', deliveryMode: 'delivery', deliveryAddress: '1 Lane, Pune' });
    await rejects(orders.retryPayment(String(cod.order._id), me), 'PAYMENT_NOT_ONLINE');
    const stranger = await customer();
    await fillCart(me);
    const mine = await checkout(me);
    await rejects(orders.retryPayment(String(mine.order._id), stranger), 'ORDER_NOT_FOUND');
    await rejects(orders.retryPayment(String(mine.order._id), { _id: PHARMACY, userType: 'pharmacy' }), 'FORBIDDEN');
  });

  await check('an order whose payment setup was interrupted gets it set up once (linked only while none is)', async () => {
    const me = await customer();
    await fillCart(me);
    const placed = await checkout(me, { requestKey: 'checkout-intr-001' });
    // The request died after the order committed but before its payment was linked.
    await PharmacyOrderModel.updateOne({ _id: placed.order._id }, { $unset: { paymentTransactionId: 1 } });
    await PaymentRecordModel.deleteMany({ contextId: String(placed.order._id) });
    const [a, b] = await Promise.all([orders.retryPayment(String(placed.order._id), me), orders.retryPayment(String(placed.order._id), me)]);
    assert.equal(a.payment?.razorpayOrderId, b.payment?.razorpayOrderId, 'both answers name the one linked order');
    const linked = (await PharmacyOrderModel.findById(placed.order._id).lean())!.paymentTransactionId;
    assert.equal(a.payment?.paymentTransactionId, String(linked));
    // The keyed replay names it too.
    const replay = await checkout(me, { requestKey: 'checkout-intr-001' });
    assert.equal(replay.payment?.paymentTransactionId, String(linked));
  });

  await check('a replay of an order that was paid or closed meanwhile offers no payment', async () => {
    const me = await customer();
    await fillCart(me);
    const placed = await checkout(me, { requestKey: 'checkout-paid-001' });
    gateway.captured.add(placed.payment!.razorpayOrderId!);
    await orders.retryPayment(String(placed.order._id), me); // applies the capture
    const replay = await checkout(me, { requestKey: 'checkout-paid-001' });
    assert.equal(replay.replayed, true); assert.equal(replay.paymentRequired, false); assert.equal(replay.payment, undefined);
  });

  await mongoose.disconnect();
  console.log(`${passed} checks passed`);
}

main().catch(async (err) => { console.error(err); await mongoose.disconnect().catch(() => undefined); process.exit(1); });
