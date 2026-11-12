import 'reflect-metadata';
import assert from 'node:assert/strict';
import { before, test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import mongoose, { Types, startSession } from 'mongoose';
import * as XLSX from 'xlsx';
import PharmacyModel from '@/modules/pharmacies/model';
import MedicineModel from '@/modules/pharmacyMedicines/model';
import PharmacyOrderModel from '@/modules/pharmacyOrders/model';
import {
  InventoryItemModel,
} from '@/modules/pharmacyInventory/model';
import {
  InventoryAdjustmentRepository,
  InventoryItemRepository,
  InventoryReservationRepository,
} from '@/modules/pharmacyInventory/repository';
import { InventoryService } from '@/modules/pharmacyInventory/services';
import { MedicineRepository } from '@/modules/pharmacyMedicines/repository';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import { PharmacyOrderRepository } from '@/modules/pharmacyOrders/repository';
import { PharmacyOrderService } from '@/modules/pharmacyOrders/services';
import { InventoryImportService } from '@/modules/pharmacyInventoryImports/services';
import { requireOperationalPharmacy, AuthRequest } from '@/modules/middleware/auth';
import { PharmacyCartRepository } from '@/modules/pharmacyCart/repository';
import { PharmacyCartService } from '@/modules/pharmacyCart/services';
import { PharmacyWalletRepository, PharmacyWalletTransactionRepository } from '@/modules/pharmacyWallet/repository';
import { PharmacyWalletService } from '@/modules/pharmacyWallet/services';
import { PharmacyWalletModel, PharmacyWalletTransactionModel } from '@/modules/pharmacyWallet/model';
import { PharmacyService } from '@/modules/pharmacies/services';
import { MedicineService } from '@/modules/pharmacyMedicines/services';
import { NotificationRepository } from '@/modules/notification/repository';
import { NotificationService } from '@/modules/notification/services';
import NotificationModel from '@/modules/notification/model';
import { PharmacyCustomerRepository } from '@/modules/pharmacyCustomers/repository';
import PharmacyCustomerModel from '@/modules/pharmacyCustomers/model';
import UserModel from '@/modules/user/model';
import { PaymentService } from '@/modules/payment/services';
import { PaymentRepository } from '@/modules/payment/repository';
import PaymentRecordModel from '@/modules/payment/model';

const mongoUri = process.env.PHARMACY_TEST_MONGODB_URI;
const integrationTest = mongoUri ? test : test.skip;
let temporaryDirectory: string | undefined;

before(async () => {
  if (!mongoUri) return;
  await mongoose.connect(mongoUri);
  if (!/test/i.test(mongoose.connection.name)) {
    throw new Error('PHARMACY_TEST_MONGODB_URI must point to a database whose name contains "test"');
  }
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), 'ewa-pharmacy-test-'));
});

async function createPharmacy(active = true, verified = true) {
  const suffix = new Types.ObjectId().toHexString().slice(-10);
  const pharmacy = await PharmacyModel.create({
    name: `Integration Pharmacy ${suffix}`,
    phone: suffix,
    isActive: active,
    isVerified: verified,
  });
  return pharmacy;
}

async function createMedicine(namePrefix: string) {
  const medicine = await MedicineModel.create({
    name: `${namePrefix} ${new Types.ObjectId().toHexString()}`,
    isActive: true,
  });
  return medicine;
}

function futureDate(days = 30): string {
  return new Date(Date.now() + days * 86400000).toISOString().slice(0, 10).replace(/-/g, '');
}

function expiredDate(): string {
  return new Date(Date.now() - 86400000).toISOString().slice(0, 10).replace(/-/g, '');
}

integrationTest('FEFO stock reservation is safe under a concurrent stock race', async () => {
  const pharmacy = await createPharmacy();
  const medicine = await createMedicine('Race');
  await InventoryItemModel.create({
    pharmacyId: pharmacy._id,
    medicineId: medicine._id,
    availableQty: 5,
    reservedQty: 0,
    batches: [{
      batchNumber: 'RACE-1',
      expiryDate: futureDate(),
      receivedAt: new Date(),
      availableQty: 5,
      reservedQty: 0,
      freeQty: 0,
      status: 'active',
    }],
  });

  const repository = new InventoryItemRepository();
  const reserve = async () => {
    const session = await startSession();
    try {
      let reserved = false;
      await session.withTransaction(async () => {
        reserved = Boolean(await repository.reserveBatches(
          String(pharmacy._id),
          String(medicine._id),
          4,
          session
        ));
      });
      return reserved;
    } finally {
      await session.endSession();
    }
  };

  const outcomes = await Promise.all([reserve(), reserve()]);
  assert.equal(outcomes.filter(Boolean).length, 1);
  const item = await InventoryItemModel.findOne({ pharmacyId: pharmacy._id, medicineId: medicine._id }).lean();
  assert.equal(item?.availableQty, 1);
  assert.equal(item?.reservedQty, 4);
});

integrationTest('expired batches are never reserved', async () => {
  const pharmacy = await createPharmacy();
  const medicine = await createMedicine('Expiry');
  await InventoryItemModel.create({
    pharmacyId: pharmacy._id,
    medicineId: medicine._id,
    availableQty: 12,
    reservedQty: 0,
    batches: [
      { batchNumber: 'OLD', expiryDate: expiredDate(), receivedAt: new Date(), availableQty: 10, reservedQty: 0, freeQty: 0, status: 'active' },
      { batchNumber: 'NEW', expiryDate: futureDate(), receivedAt: new Date(), availableQty: 2, reservedQty: 0, freeQty: 0, status: 'active' },
    ],
  });

  const session = await startSession();
  try {
    let result: unknown;
    await session.withTransaction(async () => {
      result = await new InventoryItemRepository().reserveBatches(
        String(pharmacy._id), String(medicine._id), 3, session
      );
    });
    assert.equal(result, null);
  } finally {
    await session.endSession();
  }
});

function createInventoryService() {
  const inventoryItemRepository = new InventoryItemRepository();
  return new InventoryService(
    inventoryItemRepository,
    new InventoryAdjustmentRepository(),
    new InventoryReservationRepository(),
    new PharmacyRepository(),
    new MedicineRepository()
  );
}

function createOrderService() {
  const inventoryService = createInventoryService();
  const sideEffects = {
    queueSubscriptionSync: async () => undefined,
    queueNotification: async () => undefined,
  };
  return new PharmacyOrderService(
    new PharmacyOrderRepository(),
    {} as never,
    inventoryService,
    {} as never,
    {} as never,
    {} as never,
    sideEffects as never,
    new MedicineRepository()
  );
}

integrationTest('cancellation releases the exact reserved batch quantity', async () => {
  const pharmacy = await createPharmacy();
  const medicine = await createMedicine('Cancellation');
  const inventory = await InventoryItemModel.create({
    pharmacyId: pharmacy._id,
    medicineId: medicine._id,
    availableQty: 2,
    reservedQty: 3,
    batches: [{ batchNumber: 'CANCEL-1', expiryDate: futureDate(), receivedAt: new Date(), availableQty: 2, reservedQty: 3, freeQty: 0, status: 'active' }],
  });
  const batchId = String(inventory.batches?.[0]._id);
  const order = await PharmacyOrderModel.create({
    pharmacyId: pharmacy._id,
    orderType: 'online',
    status: 'placed',
    createdById: new Types.ObjectId(),
    createdByRole: 'user',
    items: [{ medicineId: medicine._id, orderedQty: 3, unitPrice: 10, lineTotal: 30, itemStatus: 'active', batchAllocations: [{ batchId, batchNumber: 'CANCEL-1', expiryDate: futureDate(), quantity: 3 }] }],
    paymentMode: 'online_payment',
    paymentStatus: 'pending',
  });

  await createOrderService().updateStatus(String(order._id), String(pharmacy._id), { status: 'cancelled' });
  const updated = await InventoryItemModel.findById(inventory._id).lean();
  assert.equal(updated?.availableQty, 5);
  assert.equal(updated?.reservedQty, 0);
});

integrationTest('only one concurrent manual payment claim succeeds', async () => {
  const pharmacy = await createPharmacy();
  const order = await PharmacyOrderModel.create({
    pharmacyId: pharmacy._id,
    orderType: 'in_store',
    status: 'placed',
    createdById: new Types.ObjectId(),
    createdByRole: 'pharmacy',
    items: [],
    paymentMode: 'in_store_payment',
    paymentStatus: 'pending',
  });
  const service = createOrderService();
  const request = {
    userType: 'pharmacy',
    pharmacyId: String(pharmacy._id),
    userId: new Types.ObjectId().toHexString(),
    data: {},
  };
  const results = await Promise.allSettled([
    service.markPaid(String(order._id), request),
    service.markPaid(String(order._id), request),
  ]);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
});

integrationTest('import retry resumes failed rows without adding committed rows twice', async () => {
  const pharmacy = await createPharmacy();
  const inventoryRepository = new InventoryItemRepository();
  const originalAdjust = inventoryRepository.adjustBatchStock.bind(inventoryRepository);
  let failBatchTwoOnce = true;
  inventoryRepository.adjustBatchStock = (async (...args: Parameters<typeof originalAdjust>) => {
    if (args[2].batchNumber === 'IMPORT-2' && failBatchTwoOnce) {
      failBatchTwoOnce = false;
      throw new Error('Temporary import failure');
    }
    return originalAdjust(...args);
  }) as typeof inventoryRepository.adjustBatchStock;

  const importService = new InventoryImportService(
    inventoryRepository,
    new MedicineRepository(),
    new InventoryAdjustmentRepository()
  );
  const filePath = path.join(temporaryDirectory!, `inventory-${new Types.ObjectId()}.xlsx`);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet([
    { 'medicine name': `Import Medicine ${new Types.ObjectId()}`, 'quantity to add': 3, 'batch number': 'IMPORT-1', 'expiry date': futureDate(), 'retail price': 10 },
    { 'medicine name': `Import Medicine ${new Types.ObjectId()}`, 'quantity to add': 4, 'batch number': 'IMPORT-2', 'expiry date': futureDate(), 'retail price': 11 },
  ]), 'Inventory');
  XLSX.writeFile(workbook, filePath);

  const preview = await importService.preview(
    String(pharmacy._id),
    new Types.ObjectId().toHexString(),
    'pharmacy',
    path.basename(filePath),
    filePath
  );
  const partial = await importService.commit(String(preview._id), String(pharmacy._id));
  assert.equal(partial.status, 'partially_committed');
  assert.ok((await importService.buildFailedRowsWorkbook(String(preview._id), String(pharmacy._id))).length > 0);

  const completed = await importService.retry(String(preview._id), String(pharmacy._id));
  assert.equal(completed.status, 'committed');
  const inventory = await InventoryItemModel.find({ pharmacyId: pharmacy._id }).lean();
  assert.equal(inventory.reduce((total, item) => total + item.availableQty, 0), 7);
});

integrationTest('unverified or inactive pharmacies fail operational authorization', async () => {
  const pharmacy = await createPharmacy(true, false);
  const request = {
    user: {
      _id: new Types.ObjectId().toHexString(),
      pharmacyId: String(pharmacy._id),
      userType: 'pharmacy',
    },
  } as AuthRequest;
  const invoke = () => new Promise<unknown>((resolve) => {
    void requireOperationalPharmacy(request, {} as never, (error?: unknown) => resolve(error));
  });

  const unverifiedError = await invoke();
  assert.equal((unverifiedError as { code?: string }).code, 'PHARMACY_NOT_VERIFIED');
  await PharmacyModel.updateOne({ _id: pharmacy._id }, { isVerified: true, isActive: false });
  const inactiveError = await invoke();
  assert.equal((inactiveError as { code?: string }).code, 'PHARMACY_INACTIVE');
});

integrationTest('prescription medicines cannot be ordered without a prescription', async () => {
  const seller = await createPharmacy();
  const buyer = await createPharmacy();
  const medicine = await createMedicine('Prescription');
  await MedicineModel.updateOne({ _id: medicine._id }, { prescriptionRequired: true });
  await InventoryItemModel.create({
    pharmacyId: seller._id,
    medicineId: medicine._id,
    availableQty: 3,
    reservedQty: 0,
    wholesalePrice: 25,
    retailPrice: 30,
    batches: [{
      batchNumber: 'RX-1',
      expiryDate: futureDate(),
      receivedAt: new Date(),
      availableQty: 3,
      reservedQty: 0,
      freeQty: 0,
      status: 'active',
    }],
  });

  await assert.rejects(
    () => createOrderService().create(
      String(seller._id),
      {
        orderType: 'online',
        buyerPharmacyId: String(buyer._id),
        items: [{ medicineId: String(medicine._id), orderedQty: 1 }],
        paymentMode: 'online_payment',
      },
      String(buyer._id),
      'pharmacy'
    ),
    (error: unknown) => (error as { code?: string }).code === 'PRESCRIPTION_REQUIRED'
  );

  const inventory = await InventoryItemModel.findOne({ pharmacyId: seller._id, medicineId: medicine._id }).lean();
  assert.equal(inventory?.availableQty, 3);
  assert.equal(inventory?.reservedQty, 0);
});

integrationTest('paid order financials are locked and invalid status jumps are rejected', async () => {
  const pharmacy = await createPharmacy();
  const customerId = new Types.ObjectId();
  const order = await PharmacyOrderModel.create({
    pharmacyId: pharmacy._id,
    orderType: 'online',
    status: 'placed',
    customerId,
    createdById: customerId,
    createdByRole: 'user',
    items: [],
    paymentMode: 'online_payment',
    paymentStatus: 'paid',
  });
  const service = createOrderService();

  await assert.rejects(
    () => service.update(String(order._id), String(pharmacy._id), { deliveryAddress: 'Changed address' }),
    (error: unknown) => (error as { code?: string }).code === 'ORDER_FINANCIALS_LOCKED'
  );
  await assert.rejects(
    () => service.updateStatus(String(order._id), String(pharmacy._id), { status: 'packed' }),
    (error: unknown) => (error as { code?: string }).code === 'INVALID_ORDER_STATUS_TRANSITION'
  );
});

integrationTest('cart checkout refreshes changed prices and then checks out without a cart id', async () => {
  const pharmacy = await createPharmacy();
  const medicine = await createMedicine('Cart');
  const actorId = new Types.ObjectId().toHexString();
  await InventoryItemModel.create({
    pharmacyId: pharmacy._id,
    medicineId: medicine._id,
    availableQty: 5,
    reservedQty: 0,
    retailPrice: 10,
    wholesalePrice: 8,
    batches: [{
      batchNumber: 'CART-1',
      expiryDate: futureDate(),
      receivedAt: new Date(),
      availableQty: 5,
      reservedQty: 0,
      freeQty: 0,
      status: 'active',
    }],
  });

  const cartRepository = new PharmacyCartRepository();
  let orderCreateArgs: unknown[] | undefined;
  const orderService = {
    create: async (...args: unknown[]) => {
      orderCreateArgs = args;
      return { order: { _id: new Types.ObjectId() }, paymentRequired: false };
    },
  };
  const service = new PharmacyCartService(
    cartRepository,
    createInventoryService(),
    new PharmacyRepository(),
    new MedicineRepository(),
    orderService as never
  );
  const actor = { _id: actorId, userType: 'user' };
  await service.addItem(actor, {
    pharmacyId: String(pharmacy._id),
    medicineId: String(medicine._id),
    quantity: 2,
  });
  await InventoryItemModel.updateOne(
    { pharmacyId: pharmacy._id, medicineId: medicine._id },
    { retailPrice: 12 }
  );

  await assert.rejects(
    () => service.checkout(actor, { paymentMode: 'cash_on_delivery' }),
    (error: unknown) => (error as { code?: string }).code === 'CART_PRICE_CHANGED'
  );
  const refreshed = await service.getCart(actor);
  assert.equal(refreshed.items[0].unitPrice, 12);

  await service.checkout(actor, { paymentMode: 'cash_on_delivery' });
  assert.ok(orderCreateArgs);
  assert.equal((orderCreateArgs?.[1] as { customerId?: string }).customerId, actorId);
  assert.equal(await cartRepository.findByActor(actorId, 'user'), null);
});

integrationTest('wallet top-up is transactional and idempotent', async () => {
  await Promise.all([
    PharmacyWalletModel.syncIndexes(),
    PharmacyWalletTransactionModel.syncIndexes(),
  ]);
  const pharmacy = await createPharmacy();
  const service = new PharmacyWalletService(
    new PharmacyWalletRepository(),
    new PharmacyWalletTransactionRepository(),
    {} as never,
    {} as never
  );

  await Promise.all([
    service.topup(String(pharmacy._id), { amount: 50 }, 'topup-test-key'),
    service.topup(String(pharmacy._id), { amount: 50 }, 'topup-test-key'),
  ]);
  const wallet = await PharmacyWalletModel.findOne({ pharmacyId: pharmacy._id }).lean();
  assert.equal(wallet?.balance, 50);
  assert.equal(wallet?.balancePaise, 5000);
  assert.equal(await PharmacyWalletTransactionModel.countDocuments({ pharmacyId: pharmacy._id }), 1);

  const rollbackPharmacy = await createPharmacy();
  const failingTxRepository = new PharmacyWalletTransactionRepository();
  failingTxRepository.save = (async () => {
    throw new Error('Simulated ledger failure');
  }) as typeof failingTxRepository.save;
  const rollbackService = new PharmacyWalletService(
    new PharmacyWalletRepository(),
    failingTxRepository,
    {} as never,
    {} as never
  );
  await assert.rejects(() => rollbackService.topup(String(rollbackPharmacy._id), { amount: 25 }));
  const rolledBackWallet = await PharmacyWalletModel.findOne({ pharmacyId: rollbackPharmacy._id }).lean();
  assert.equal(rolledBackWallet?.balance, 0);
  assert.equal(await PharmacyWalletTransactionModel.countDocuments({ pharmacyId: rollbackPharmacy._id }), 0);
});

integrationTest('pharmacy self top-up initiates payment and credits only after verification', async () => {
  const pharmacy = await createPharmacy();
  const actorUserId = new Types.ObjectId().toHexString();
  let createPaymentPayload: Record<string, unknown> | undefined;
  const paymentInitiationStub = {
    createOrder: async (payload: Record<string, unknown>) => {
      createPaymentPayload = payload;
      return {
        paymentRecord: { _id: new Types.ObjectId().toHexString() },
        razorpayOrder: { id: 'order_pharmacy_test', currency: 'INR' },
        razorpayKeyId: 'rzp_test_key',
      };
    },
  };
  const walletService = new PharmacyWalletService(
    new PharmacyWalletRepository(),
    new PharmacyWalletTransactionRepository(),
    {} as never,
    {} as never,
    paymentInitiationStub as never
  );

  const initiated = await walletService.initiateTopupPayment(
    String(pharmacy._id),
    actorUserId,
    { amount: 75, notes: 'Self recharge' }
  );
  assert.equal(initiated.paymentRequired, true);
  assert.equal(initiated.razorpayOrderId, 'order_pharmacy_test');
  assert.equal(createPaymentPayload?.payerPharmacyId, String(pharmacy._id));
  assert.equal((createPaymentPayload?.notes as { flow?: string }).flow, 'pharmacy_wallet_recharge');
  const beforeVerification = await PharmacyWalletModel.findOne({ pharmacyId: pharmacy._id }).lean();
  assert.equal(beforeVerification?.balance, 0);

  const paymentRepository = new PaymentRepository();
  const paymentRecord = await PaymentRecordModel.create({
    userId: actorUserId,
    payerUserId: actorUserId,
    payerPharmacyId: String(pharmacy._id),
    context: 'wallet_recharge',
    contextId: `pharmacy_${pharmacy._id}`,
    baseAmount: 75,
    discountAmount: 0,
    finalAmount: 75,
    baseAmountPaise: 7500,
    discountAmountPaise: 0,
    finalAmountPaise: 7500,
    currency: 'INR',
    paymentGateway: 'razorpay',
    razorpayOrderId: `order_${new Types.ObjectId()}`,
    razorpayPaymentId: `pay_${new Types.ObjectId()}`,
    status: 'paid',
    isProcessed: false,
    notes: { flow: 'pharmacy_wallet_recharge', pharmacyId: String(pharmacy._id) },
  });
  const paymentService = new PaymentService(
    paymentRepository,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    new PharmacyWalletRepository(),
    new PharmacyWalletTransactionRepository(),
    new MedicineRepository()
  );
  (paymentService as unknown as { verifyAndMarkPaid: () => Promise<unknown> }).verifyAndMarkPaid =
    async () => paymentRepository.findById(String(paymentRecord._id));
  const verifyRequest = {
    paymentTransactionId: String(paymentRecord._id),
    userId: actorUserId,
    requesterUserType: 'pharmacy',
    requesterPharmacyId: String(pharmacy._id),
    razorpayOrderId: paymentRecord.razorpayOrderId,
    razorpayPaymentId: paymentRecord.razorpayPaymentId!,
    razorpaySignature: 'verified-in-test',
  };

  await paymentService.verifyPaymentAndProcess(verifyRequest);
  await paymentService.verifyPaymentAndProcess(verifyRequest);
  const creditedWallet = await PharmacyWalletModel.findOne({ pharmacyId: pharmacy._id }).lean();
  assert.equal(creditedWallet?.balance, 75);
  assert.equal(creditedWallet?.balancePaise, 7500);
  assert.equal(await PharmacyWalletTransactionModel.countDocuments({
    pharmacyId: pharmacy._id,
    referenceType: 'wallet_recharge',
    referenceId: String(paymentRecord._id),
  }), 1);
});

integrationTest('pharmacy and medicine deletion archives records instead of removing them', async () => {
  const pharmacy = await createPharmacy();
  const medicine = await createMedicine('Archive');
  const archivedBy = new Types.ObjectId().toHexString();

  await new PharmacyService(new PharmacyRepository(), {} as never)
    .delete(String(pharmacy._id), archivedBy, 'integration test');
  await new MedicineService(new MedicineRepository())
    .delete(String(medicine._id), archivedBy, 'integration test');

  const [archivedPharmacy, archivedMedicine] = await Promise.all([
    PharmacyModel.findById(pharmacy._id).lean(),
    MedicineModel.findById(medicine._id).lean(),
  ]);
  assert.equal(archivedPharmacy?.isActive, false);
  assert.ok(archivedPharmacy?.archivedAt);
  assert.equal(archivedMedicine?.isActive, false);
  assert.ok(archivedMedicine?.archivedAt);
});

integrationTest('notification creation is idempotent under concurrent delivery attempts', async () => {
  await NotificationModel.syncIndexes();
  const service = new NotificationService(
    new NotificationRepository(),
    {} as never,
    {} as never
  );
  const payload = {
    userId: new Types.ObjectId().toHexString(),
    type: 'general' as const,
    title: 'Order update',
    message: 'Your order changed',
    idempotencyKey: `notification-${new Types.ObjectId()}`,
  };
  const notifications = await Promise.all([service.create(payload), service.create(payload)]);
  assert.equal(String(notifications[0]._id), String(notifications[1]._id));
  assert.equal(await NotificationModel.countDocuments({ idempotencyKey: payload.idempotencyKey }), 1);
});

integrationTest('nearby pharmacy search uses great-circle distance', async () => {
  const origin = await createPharmacy();
  const oneDegreeEast = await createPharmacy();
  await Promise.all([
    PharmacyModel.updateOne({ _id: origin._id }, { latitude: 60, longitude: 0 }),
    PharmacyModel.updateOne({ _id: oneDegreeEast._id }, { latitude: 60, longitude: 1 }),
  ]);
  const repository = new PharmacyRepository();

  const withinSixty = await repository.findNearby({
    latitude: 60,
    longitude: 0,
    radiusKm: 60,
    isActive: true,
    isVerified: true,
  });
  const idsWithinSixty = new Set(withinSixty.data.map((item) => String(item._id)));
  assert.ok(idsWithinSixty.has(String(origin._id)));
  assert.ok(idsWithinSixty.has(String(oneDegreeEast._id)));

  const withinFifty = await repository.findNearby({
    latitude: 60,
    longitude: 0,
    radiusKm: 50,
    isActive: true,
    isVerified: true,
  });
  const idsWithinFifty = new Set(withinFifty.data.map((item) => String(item._id)));
  assert.ok(idsWithinFifty.has(String(origin._id)));
  assert.equal(idsWithinFifty.has(String(oneDegreeEast._id)), false);
});

integrationTest('pharmacy customer search paginates after matching joined user fields', async () => {
  const pharmacy = await createPharmacy();
  const creatorId = new Types.ObjectId();
  const users = await UserModel.create([
    { phone: `91${new Types.ObjectId().toHexString().slice(-8)}`, name: 'Search Person Alpha', userType: 'user', isActive: true, isVerified: true },
    { phone: `92${new Types.ObjectId().toHexString().slice(-8)}`, name: 'Search Person Beta', userType: 'user', isActive: true, isVerified: true },
    { phone: `93${new Types.ObjectId().toHexString().slice(-8)}`, name: 'Search Person Gamma', userType: 'user', isActive: true, isVerified: true },
  ]);
  await PharmacyCustomerModel.create(users.map((user) => ({
    pharmacyId: pharmacy._id,
    userId: user._id,
    createdByRole: 'pharmacy',
    createdById: creatorId,
  })));
  const repository = new PharmacyCustomerRepository();
  const firstPage = await repository.findWithPagination(
    { pharmacyId: String(pharmacy._id), search: 'Search Person' },
    1,
    2
  );
  const secondPage = await repository.findWithPagination(
    { pharmacyId: String(pharmacy._id), search: 'Search Person' },
    2,
    2
  );
  assert.equal(firstPage.total, 3);
  assert.equal(firstPage.totalPages, 2);
  assert.equal(firstPage.data.length, 2);
  assert.equal(secondPage.data.length, 1);
});

integrationTest('cleans the isolated pharmacy integration database', async () => {
  await mongoose.connection.dropDatabase();
  await mongoose.connection.close(true);
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
});
