/**
 * P9: prescription (Rx) medicines online - optional prescription, one-button pharmacist approval bound to the reviewed
 * revision, Rx-aware counter payment, file binding for the pharmacy - against a real MongoDB replica set. Same harness
 * as P8 (real order/cart/payment services; Razorpay, stock and catalogue are fakes).
 *
 * Run (throwaway DB only; the script clears its database):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/p9_rx_online_check?directConnection=true' JWT_SECRET_KEY=local-check-only \
 *     npx tsx --tsconfig tsconfig.json test/pharmacy-prescription/p9-rx-online.integration.ts
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
import PharmacyModel from '@/modules/pharmacies/model';
import { FileGrantModel, FileUploadModel } from '@/modules/file/model/access';
import { decideFileAccess, rebindStored, recordUpload, withFiles } from '@/modules/file/access';
import { prescriptionReviewSchema } from '@/modules/pharmacyOrders/validation';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/p9_rx_online_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const PHARMACY = new Types.ObjectId().toHexString();
const MED = new Types.ObjectId().toHexString();
const RX_MED = new Types.ObjectId().toHexString();
const isRx = (id: unknown) => String(id) === RX_MED;

/** Fake Razorpay: orders it created, and which of them are captured. `down` = the gateway cannot be reached. */
const gateway = { n: 0, created: [] as string[], amounts: new Map<string, number>(), captured: new Set<string>(), down: false,
  /** Runs while Razorpay is creating an order (to interleave an edit). */
  onCreate: undefined as undefined | (() => Promise<void>) };
const razorpay = {
  orders: {
    create: async (p: { amount: number; currency: string }) => {
      if (gateway.onCreate) { const h = gateway.onCreate; gateway.onCreate = undefined; await h(); }
      gateway.n += 1; const id = `order_fake_${gateway.n}`; gateway.created.push(id); gateway.amounts.set(id, p.amount); return { id, amount: p.amount, currency: p.currency, status: 'created' }; },
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
  consumeAvailableStockBulk: async () => undefined, returnAvailableStockBulk: async () => undefined,
};
const medicines = {
  findById: async (id: unknown) => ({ _id: String(id), name: isRx(id) ? 'Amoxicillin 500' : 'Vitamin D', isActive: true, prescriptionRequired: isRx(id), gstPercent: 0 }),
  findAll: async (q?: { _id?: { $in?: unknown[] } }) => (q?._id?.$in ?? [MED, RX_MED]).map((id) => ({ _id: String(id), name: 'x', isActive: true, prescriptionRequired: isRx(id) })),
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

const orderRepo = new PharmacyOrderRepository();
const orders = new (PharmacyOrderService as unknown as new (...a: unknown[]) => PharmacyOrderService)(
  orderRepo, { ensureLinked: async () => undefined }, inventory, payments, {}, {}, sideEffects, medicines, refunds);
(orders as unknown as { validateLinkedReferences: () => Promise<void> }).validateLinkedReferences = async () => undefined;

const cartService = new (PharmacyCartService as unknown as new (...a: unknown[]) => PharmacyCartService)(
  new PharmacyCartRepository(), inventory, {}, medicines, orders);
Object.assign(cartService as unknown as Record<string, unknown>, {
  ensureTargetPharmacyAccessible: async () => undefined,
  buildCartItem: async (_role: string, _p: string, medicineId: string, quantity: number) =>
    ({ medicineId, medicineName: isRx(medicineId) ? 'Amoxicillin 500' : 'Vitamin D', quantity, unitPrice: 50, lineTotal: 50 * quantity, prescriptionRequired: isRx(medicineId) }),
});

async function customer() {
  const u = await UserModel.create({ phone: '9' + String(Math.floor(Math.random() * 1e9)).padStart(9, '0'), userType: 'user', isActive: true });
  await WalletModel.create({ userId: u._id, balance: 0, isActive: true });
  return { _id: String(u._id), userType: 'user' };
}
async function fillCart(actor: { _id: string; userType: string }, qty = 2, medicineId = RX_MED) {
  await PharmacyCartModel.deleteMany({ actorId: actor._id });
  await PharmacyCartModel.create({ actorId: actor._id, actorRole: actor.userType, pharmacyId: PHARMACY,
    items: [{ medicineId, medicineName: 'x', quantity: qty, unitPrice: 50, lineTotal: 50 * qty, prescriptionRequired: isRx(medicineId) }], subtotal: 50 * qty });
}
const checkout = (actor: { _id: string; userType: string }, extra: Record<string, unknown> = {}) =>
  cartService.checkout(actor, { paymentMode: 'online_payment', deliveryMode: 'pickup', ...extra } as never) as Promise<{
    order: { _id: unknown; status: string; paymentStatus: string; paymentTransactionId?: string; createdAt?: Date }; paymentRequired: boolean;
    payment?: { paymentTransactionId: string; razorpayOrderId?: string; amount: number }; replayed?: boolean }>;
const records = (orderId: unknown) => PaymentRecordModel.countDocuments({ context: 'pharmacy_order', contextId: String(orderId) });
async function rejects(p: Promise<unknown>, code: string) { await assert.rejects(p, (e: { code?: string }) => { assert.equal(e.code, code); return true; }); }

let passed = 0;
async function check(name: string, fn: () => Promise<void>) { await fn(); passed++; console.log('ok -', name); }
const pharmacyActor = { _id: PHARMACY, userType: 'pharmacy', pharmacyId: PHARMACY } as never;
const get = async (id: unknown) => (await PharmacyOrderModel.findById(id).lean())!;
const setPharmacist = () => PharmacyModel.collection.updateOne({ _id: new Types.ObjectId(PHARMACY) },
  { $set: { pharmacist: { name: 'Ravi Kumar', registrationNumber: 'MH/RPH/12345', updatedAt: new Date() } } }, { upsert: true });
/** Makes the next order read return `stale` (an edit or review that read the order before a concurrent write). */
function staleNextRead(stale: unknown) {
  const real = orderRepo.findById.bind(orderRepo);
  (orderRepo as unknown as { findById: unknown }).findById = async () => {
    (orderRepo as unknown as { findById: unknown }).findById = real; return stale;
  };
}

async function main() {
  await mongoose.connect(FIXTURE_URL);
  await mongoose.connection.dropDatabase();
  await Promise.all([PharmacyOrderModel.syncIndexes(), PaymentRecordModel.init(), WalletModel.init(), WalletTransactionModel.init(),
    PharmacyCartModel.init(), RequestKeyModel.createCollection().then(() => RequestKeyModel.syncIndexes())]);
  for (const m of [FileUploadModel, FileGrantModel]) { await m.createCollection(); await m.syncIndexes(); }

  await check('a customer orders a prescription medicine online without a prescription: pending review, payment set up', async () => {
    const me = await customer();
    await fillCart(me);
    const r = await checkout(me);
    assert.equal(r.paymentRequired, true); assert.ok(r.payment?.razorpayOrderId);
    const o = await get(r.order._id);
    assert.equal(o.prescriptionStatus, 'pending'); assert.deepEqual(o.prescriptionUrls, []);
    // A non-Rx order stays "not required".
    await fillCart(me, 1, MED);
    const plain = await checkout(me);
    assert.equal((await get(plain.order._id)).prescriptionStatus, 'not_required');
  });

  await check('packing waits for the pharmacist; one-button approval needs the pharmacist on file and records them', async () => {
    const me = await customer();
    await fillCart(me);
    const r = await checkout(me);
    const id = String(r.order._id);
    await PharmacyOrderModel.updateOne({ _id: id }, { $set: { status: 'accepted', paymentStatus: 'paid' } });
    await rejects(orders.updateStatus(id, PHARMACY, { status: 'packed' }), 'ORDER_PRESCRIPTION_APPROVAL_REQUIRED');
    await PharmacyModel.collection.updateOne({ _id: new Types.ObjectId(PHARMACY) }, { $unset: { pharmacist: 1 } }, { upsert: true });
    await rejects(orders.reviewPrescription(id, PHARMACY, { decision: 'approve', expectedRevision: 0, reviewedPrescriptionUrls: [] }), 'PHARMACIST_PROFILE_REQUIRED');
    await setPharmacist();
    const approved = await orders.reviewPrescription(id, PHARMACY, { decision: 'approve', expectedRevision: 0, reviewedPrescriptionUrls: [] });
    assert.equal(approved.prescriptionStatus, 'approved');
    assert.equal(approved.prescriptionReview?.pharmacistName, 'Ravi Kumar');
    assert.equal(approved.prescriptionReview?.pharmacistRegistrationNumber, 'MH/RPH/12345');
    assert.equal(approved.prescriptionReview?.prescriptionAttached, false);
    assert.equal(approved.prescriptionReview?.reviewedRevision, 0);
    await orders.updateStatus(id, PHARMACY, { status: 'packed' });
    // Name and number come together or not at all.
    assert.ok(prescriptionReviewSchema.validate({ decision: 'approve', expectedRevision: 0, pharmacistName: 'Only Name', reviewedPrescriptionUrls: [] }).error);
    assert.equal(prescriptionReviewSchema.validate({ decision: 'approve', expectedRevision: 0, reviewedPrescriptionUrls: [] }).error, undefined);
  });

  await check('an approval is accepted only for the revision it saw: an edit in between makes it fail', async () => {
    await setPharmacist();
    const me = await customer();
    await fillCart(me);
    const r = await checkout(me, { paymentMode: 'cash_on_delivery', deliveryMode: 'delivery', deliveryAddress: '1 Lane, Pune' });
    const id = String(r.order._id);
    const seen = await get(id); // the pharmacist opens the order (revision 0)
    await orders.update(id, PHARMACY, { deliveryAddress: '2 Lane, Pune' } as never); // the order is edited (revision 1)
    assert.equal((await get(id)).revision, 1);
    // The pharmacist decides on the version they were shown (0): refused, nothing approved.
    await rejects(orders.reviewPrescription(id, PHARMACY, { decision: 'approve', expectedRevision: 0, reviewedPrescriptionUrls: [] }), 'ORDER_STATE_CHANGED');
    assert.equal((await get(id)).prescriptionStatus, 'pending');
    // An edit after the server's own read (the decision attested the current version): the write fence refuses it too.
    const now = await get(id);
    await orders.update(id, PHARMACY, { deliveryAddress: '3 Lane, Pune' } as never); // revision 2
    staleNextRead(now);
    await rejects(orders.reviewPrescription(id, PHARMACY, { decision: 'approve', expectedRevision: 1, reviewedPrescriptionUrls: [] }), 'ORDER_STATE_CHANGED');
    void seen;
    const ok = await orders.reviewPrescription(id, PHARMACY, { decision: 'approve', expectedRevision: 2, reviewedPrescriptionUrls: [] });
    assert.equal(ok.prescriptionReview?.reviewedRevision, 2);
  });

  await check('after review, medicines and prescription documents cannot change (also an edit that read before the review)', async () => {
    await setPharmacist();
    const me = await customer();
    await fillCart(me);
    const r = await checkout(me, { paymentMode: 'cash_on_delivery', deliveryMode: 'delivery', deliveryAddress: '1 Lane, Pune' });
    const id = String(r.order._id);
    const before = await get(id);
    await orders.reviewPrescription(id, PHARMACY, { decision: 'approve', expectedRevision: 0, reviewedPrescriptionUrls: [] });
    await rejects(orders.update(id, PHARMACY, { prescriptionUrls: ['general/other.pdf'] } as never), 'PRESCRIPTION_REVIEWED_LOCKED');
    await rejects(orders.update(id, PHARMACY, { items: [{ medicineId: RX_MED, orderedQty: 5 }] } as never), 'PRESCRIPTION_REVIEWED_LOCKED');
    staleNextRead(before); // an edit validated against the pre-review order commits after the review: refused
    await rejects(orders.update(id, PHARMACY, { prescriptionUrls: [] } as never), 'ORDER_UPDATE_CONFLICT');
    assert.equal((await get(id)).prescriptionReview?.decision, 'approved');
  });

  await check('cash / counter payment of a prescription order only after approval (checked again when written)', async () => {
    await setPharmacist();
    const me = await customer();
    await fillCart(me);
    const r = await checkout(me, { paymentMode: 'cash_on_delivery', deliveryMode: 'delivery', deliveryAddress: '1 Lane, Pune' });
    const id = String(r.order._id);
    const markPaid = () => orders.markPaid(id, { userType: 'pharmacy', pharmacyId: PHARMACY, userId: PHARMACY, data: {} as never });
    await rejects(markPaid(), 'PRESCRIPTION_REVIEW_REQUIRED');
    // A mark-paid that read an "approved" copy while the order is still pending in the database is refused at write.
    const pending = await get(id);
    staleNextRead({ ...pending, prescriptionStatus: 'approved', prescriptionReview: { decision: 'approved' } });
    await rejects(markPaid(), 'ORDER_PAYMENT_STATE_CHANGED');
    await orders.reviewPrescription(id, PHARMACY, { decision: 'approve', expectedRevision: 0, reviewedPrescriptionUrls: [] });
    await markPaid();
    assert.equal((await get(id)).paymentStatus, 'paid');
  });

  await check('the customer\'s prescription file is bound to the order: its pharmacy can open it; replay and pay again re-bind', async () => {
    await setPharmacist();
    const me = await customer();
    const reader = { _id: me._id, userType: 'user' } as never;
    await recordUpload(reader, 'general/rx-scan-1.pdf');
    await fillCart(me);
    // As the cart controller does: withFiles around the checkout, the saved id taken from {order}.
    const body = { paymentMode: 'online_payment', deliveryMode: 'pickup', prescriptionUrls: ['/api/static/general/rx-scan-1.pdf'], requestKey: 'rx-checkout-001' };
    const r = await withFiles(reader, 'PharmacyOrder', body, undefined, () => cartService.checkout(me, body as never),
      (x) => (x as { order?: { _id?: unknown } }).order?._id) as { order: { _id: unknown } };
    assert.equal((await get(r.order._id)).prescriptionStatus, 'pending');
    assert.equal((await decideFileAccess(pharmacyActor, 'general/rx-scan-1.pdf')).allow, true, 'the pharmacy can open it');
    const stranger = await customer();
    assert.equal((await decideFileAccess({ _id: stranger._id, userType: 'user' } as never, 'general/rx-scan-1.pdf')).allow, false);
    // The first request died before binding: grants gone; the keyed replay / pay again bind again.
    await FileGrantModel.deleteMany({ path: 'general/rx-scan-1.pdf' });
    assert.equal((await decideFileAccess(pharmacyActor, 'general/rx-scan-1.pdf')).allow, false);
    await rebindStored(reader, 'PharmacyOrder', r.order._id);
    assert.equal((await decideFileAccess(pharmacyActor, 'general/rx-scan-1.pdf')).allow, true);
    // Someone else's upload is never bound by a customer.
    const other = await customer();
    await recordUpload({ _id: other._id, userType: 'user' } as never, 'general/not-mine.pdf');
    await fillCart(me);
    await assert.rejects(withFiles(reader, 'PharmacyOrder', { prescriptionUrls: ['/api/static/general/not-mine.pdf'] }, undefined,
      () => cartService.checkout(me, { paymentMode: 'online_payment', deliveryMode: 'pickup', prescriptionUrls: ['/api/static/general/not-mine.pdf'] } as never),
      (x) => (x as { order?: { _id?: unknown } }).order?._id));
  });

  await check('a rejected paid prescription order is refunded to the wallet, with card/UPI on request (P2 path)', async () => {
    await setPharmacist();
    const me = await customer();
    await fillCart(me);
    const r = await checkout(me);
    gateway.captured.add(r.payment!.razorpayOrderId!);
    await orders.retryPayment(String(r.order._id), me); // applies the capture: paid, accepted
    const paid = await get(r.order._id);
    assert.equal(paid.paymentStatus, 'paid');
    const out = await orders.reviewPrescription(String(r.order._id), PHARMACY, { decision: 'reject', expectedRevision: 0, reason: 'Antibiotic needs a doctor\'s prescription', reviewedPrescriptionUrls: [] });
    assert.equal(out.status, 'cancelled');
    const o = await get(r.order._id);
    assert.ok(o.prescriptionRefund, 'refund recorded with the rejection');
    assert.ok(['wallet_pending', 'wallet_credited'].includes(String(o.prescriptionRefund?.status)));
  });

  await check('the decision needs the version shown; it is validated as a whole number', async () => {
    assert.ok(prescriptionReviewSchema.validate({ decision: 'approve', reviewedPrescriptionUrls: [] }).error, 'required');
    assert.ok(prescriptionReviewSchema.validate({ decision: 'approve', expectedRevision: -1, reviewedPrescriptionUrls: [] }).error);
    assert.ok(prescriptionReviewSchema.validate({ decision: 'approve', expectedRevision: 1.5, reviewedPrescriptionUrls: [] }).error);
  });

  await check('a counter payment checked as a non-prescription order cannot land after it became one', async () => {
    await setPharmacist();
    const me = await customer();
    await fillCart(me, 1, MED);
    const r = await checkout(me, { paymentMode: 'cash_on_delivery', deliveryMode: 'delivery', deliveryAddress: '1 Lane, Pune' });
    const id = String(r.order._id);
    const otc = await get(id);
    assert.equal(otc.prescriptionStatus, 'not_required');
    // Meanwhile the order is changed to a prescription medicine (revision 1, pending review).
    await orders.update(id, PHARMACY, { items: [{ medicineId: RX_MED, orderedQty: 1 }] } as never);
    assert.equal((await get(id)).prescriptionStatus, 'pending');
    staleNextRead(otc); // mark-paid validated the old OTC copy
    await rejects(orders.markPaid(id, { userType: 'pharmacy', pharmacyId: PHARMACY, userId: PHARMACY, data: {} as never }), 'ORDER_PAYMENT_STATE_CHANGED');
    assert.notEqual((await get(id)).paymentStatus, 'paid');
  });

  await check('a refill order stays non-prescription on every edit (items or documents)', async () => {
    const me = await customer();
    await fillCart(me, 1, MED);
    const r = await checkout(me, { paymentMode: 'cash_on_delivery', deliveryMode: 'delivery', deliveryAddress: '1 Lane, Pune' });
    const id = String(r.order._id);
    await PharmacyOrderModel.updateOne({ _id: id }, { $set: { refill: { subscriptionId: new Types.ObjectId().toHexString(), cycleDate: '20261115', paymentDueBy: new Date(Date.now() + 86400000) } } });
    await rejects(orders.update(id, PHARMACY, { items: [{ medicineId: RX_MED, orderedQty: 1 }] } as never), 'PRESCRIPTION_CHECKOUT_UNAVAILABLE');
    await rejects(orders.update(id, PHARMACY, { prescriptionUrls: ['general/x.pdf'] } as never), 'PRESCRIPTION_CHECKOUT_UNAVAILABLE');
    assert.equal((await get(id)).prescriptionStatus, 'not_required');
  });

  await check('prescriptions go only to the pharmacy whose cart was shown: a cart replaced meanwhile is refused', async () => {
    const me = await customer();
    const reader = { _id: me._id, userType: 'user' } as never;
    await recordUpload(reader, 'general/rx-for-a.pdf');
    await fillCart(me); // pharmacy A
    // Elsewhere the cart is replaced by one from pharmacy B before this screen refreshes.
    const B = new Types.ObjectId().toHexString();
    await PharmacyCartModel.updateOne({ actorId: me._id }, { $set: { pharmacyId: B } });
    const body = { paymentMode: 'online_payment', deliveryMode: 'pickup', prescriptionUrls: ['/api/static/general/rx-for-a.pdf'], expectedPharmacyId: PHARMACY };
    await rejects(withFiles(reader, 'PharmacyOrder', body, undefined, () => cartService.checkout(me, body as never),
      (x) => (x as { order?: { _id?: unknown } }).order?._id), 'CART_CHANGED');
    assert.equal(await PharmacyOrderModel.countDocuments({ customerId: me._id }), 0, 'no order');
    assert.equal(await FileGrantModel.countDocuments({ path: 'general/rx-for-a.pdf', state: 'active' }), 0, 'nothing bound');
    // Sending prescriptions requires naming the pharmacy; without documents it stays optional.
    assert.ok(checkoutCartSchema.validate({ paymentMode: 'online_payment', prescriptionUrls: ['x/y.pdf'] }).error);
    assert.equal(checkoutCartSchema.validate({ paymentMode: 'online_payment' }).error, undefined);
    // The same request for the cart actually shown succeeds.
    await fillCart(me);
    const ok = await withFiles(reader, 'PharmacyOrder', body, undefined, () => cartService.checkout(me, body as never),
      (x) => (x as { order?: { _id?: unknown } }).order?._id) as { order: { _id: unknown } };
    assert.equal(String((await get(ok.order._id)).pharmacyId), PHARMACY);
  });

  await mongoose.disconnect();
  console.log(`${passed} checks passed`);
}

main().catch(async (err) => { console.error(err); await mongoose.disconnect().catch(() => undefined); process.exit(1); });
