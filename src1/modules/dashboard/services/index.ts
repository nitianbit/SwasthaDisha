import { Service } from 'typedi';
import BookingModel from '@/modules/bookings/model';
import PaymentRecordModel from '@/modules/payment/model';
import UserModel from '@/modules/user/model';
import { WalletTransactionModel } from '@/modules/wallet/model';
import InventoryImportModel from '@/modules/pharmacyInventoryImports/model';
import PharmacyOrderModel from '@/modules/pharmacyOrders/model';
import { Job } from '@/modules/queue/model';
import {
  DashboardAnalyticsQueryParams,
  DashboardAnalyticsResponse,
} from '@/modules/dashboard/types';

type AggregateRow = {
  _id: string;
  count: number;
  amount: number;
};

@Service()
export class DashboardService {
  private readonly bookingTypes = [
    'package',
    'consultation',
    'second-opinion',
    'surgery',
  ];

  private readonly bookingStatuses = [
    'pending',
    'confirmed',
    'completed',
    'cancelled',
  ];

  private getDateBounds(yyyymmdd: string): { start: Date; end: Date } {
    const year = Number(yyyymmdd.slice(0, 4));
    const month = Number(yyyymmdd.slice(4, 6));
    const day = Number(yyyymmdd.slice(6, 8));

    return {
      start: new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0)),
      end: new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999)),
    };
  }

  private toAmount(value: unknown): number {
    return Number(value || 0);
  }

  async getPharmacyOperationsHealth() {
    const now = new Date();
    const fifteenMinutesAgo = new Date(now.getTime() - 15 * 60 * 1000);
    const tenMinutesAgo = new Date(now.getTime() - 10 * 60 * 1000);
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const [
      failedPayments,
      stuckPayments,
      failedImports,
      stuckImports,
      failedNotifications,
      stuckNotifications,
      overdueNotificationJobs,
      pendingFileCleanup,
    ] = await Promise.all([
      PaymentRecordModel.countDocuments({ context: 'pharmacy_order', status: 'failed' }),
      PaymentRecordModel.countDocuments({
        context: 'pharmacy_order',
        status: 'paid',
        isProcessed: false,
        updatedAt: { $lt: fifteenMinutesAgo },
      }),
      InventoryImportModel.countDocuments({ status: { $in: ['failed', 'partially_committed'] } }),
      InventoryImportModel.countDocuments({ status: 'committing', updatedAt: { $lt: fifteenMinutesAgo } }),
      PharmacyOrderModel.countDocuments({ 'sideEffects.notification.status': 'failed' }),
      PharmacyOrderModel.countDocuments({
        'sideEffects.notification.status': 'pending',
        'sideEffects.notification.updatedAt': { $lt: tenMinutesAgo },
      }),
      Job.countDocuments({
        consumer: 'pharmacyOrderSideEffect',
        processAfter: { $lt: nowSeconds - 120 },
        'payload.effect': 'notification',
      }),
      InventoryImportModel.countDocuments({
        status: { $in: ['committed', 'partially_committed', 'failed'] },
        sourceFileDeletedAt: { $exists: false },
      }),
    ]);

    return {
      checkedAt: now.toISOString(),
      payment: { failed: failedPayments, stuckProcessing: stuckPayments },
      imports: { failedOrPartial: failedImports, stuckCommitting: stuckImports, pendingFileCleanup },
      notifications: {
        failed: failedNotifications,
        stuckPending: stuckNotifications,
        overdueJobs: overdueNotificationJobs,
      },
      healthy:
        stuckPayments === 0 &&
        stuckImports === 0 &&
        stuckNotifications === 0 &&
        overdueNotificationJobs === 0,
    };
  }

  async getAnalytics(
    query: DashboardAnalyticsQueryParams
  ): Promise<DashboardAnalyticsResponse> {
    const fromBounds = this.getDateBounds(query.dateFrom);
    const toBounds = this.getDateBounds(query.dateTo);

    const bookingMatch = {
      bookingDate: { $gte: query.dateFrom, $lte: query.dateTo },
    };
    const createdAtMatch = {
      createdAt: { $gte: fromBounds.start, $lte: toBounds.end },
    };
    const transactionDateMatch = {
      transactionDate: { $gte: query.dateFrom, $lte: query.dateTo },
    };

    const [
      totalBookings,
      paidBookings,
      cancelledBookings,
      newUsers,
      bookingsByTypeRaw,
      bookingsByStatusRaw,
      bookingValueSummaryRaw,
      bookingPaymentsRaw,
      walletRechargeRaw,
      walletUsageRaw,
      bookingsTrendRaw,
      revenueTrendRaw,
    ] = await Promise.all([
      BookingModel.countDocuments(bookingMatch),
      BookingModel.countDocuments({
        ...bookingMatch,
        paymentStatus: 'paid',
      }),
      BookingModel.countDocuments({
        ...bookingMatch,
        status: 'cancelled',
      }),
      UserModel.countDocuments({
        ...createdAtMatch,
        userType: 'user',
      }),
      BookingModel.aggregate<AggregateRow>([
        { $match: bookingMatch },
        {
          $group: {
            _id: '$bookingType',
            count: { $sum: 1 },
            amount: { $sum: '$price' },
          },
        },
      ]),
      BookingModel.aggregate<AggregateRow>([
        { $match: bookingMatch },
        {
          $group: {
            _id: '$status',
            count: { $sum: 1 },
            amount: { $sum: '$price' },
          },
        },
      ]),
      BookingModel.aggregate([
        { $match: bookingMatch },
        {
          $group: {
            _id: null,
            totalValue: { $sum: '$price' },
            paidValue: {
              $sum: {
                $cond: [{ $eq: ['$paymentStatus', 'paid'] }, '$price', 0],
              },
            },
            pendingValue: {
              $sum: {
                $cond: [{ $eq: ['$paymentStatus', 'pending'] }, '$price', 0],
              },
            },
          },
        },
      ]),
      PaymentRecordModel.aggregate([
        {
          $match: {
            ...createdAtMatch,
            context: 'booking',
          },
        },
        {
          $group: {
            _id: null,
            totalTransactions: { $sum: 1 },
            paidTransactions: {
              $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] },
            },
            totalCollected: {
              $sum: {
                $cond: [{ $eq: ['$status', 'paid'] }, '$finalAmount', 0],
              },
            },
            totalDiscount: {
              $sum: {
                $cond: [{ $eq: ['$status', 'paid'] }, '$discountAmount', 0],
              },
            },
          },
        },
      ]),
      PaymentRecordModel.aggregate([
        {
          $match: {
            ...createdAtMatch,
            context: 'wallet_recharge',
          },
        },
        {
          $group: {
            _id: null,
            totalTransactions: { $sum: 1 },
            paidTransactions: {
              $sum: { $cond: [{ $eq: ['$status', 'paid'] }, 1, 0] },
            },
            totalCollected: {
              $sum: {
                $cond: [{ $eq: ['$status', 'paid'] }, '$finalAmount', 0],
              },
            },
          },
        },
      ]),
      WalletTransactionModel.aggregate([
        {
          $match: {
            ...transactionDateMatch,
            transactionType: 'debit',
            status: 'completed',
            referenceType: 'booking',
          },
        },
        {
          $group: {
            _id: null,
            amount: { $sum: '$amount' },
          },
        },
      ]),
      BookingModel.aggregate([
        { $match: bookingMatch },
        {
          $group: {
            _id: '$bookingDate',
            count: { $sum: 1 },
            amount: { $sum: '$price' },
          },
        },
        { $sort: { _id: 1 } },
      ]),
      PaymentRecordModel.aggregate([
        {
          $match: {
            ...createdAtMatch,
            context: 'booking',
            status: 'paid',
          },
        },
        {
          $group: {
            _id: {
              $dateToString: {
                format: '%Y%m%d',
                date: { $ifNull: ['$paidAt', '$createdAt'] },
              },
            },
            amount: { $sum: '$finalAmount' },
            transactions: { $sum: 1 },
          },
        },
        { $sort: { _id: 1 } },
      ]),
    ]);

    const bookingsByType = this.bookingTypes.map((type) => {
      const row = bookingsByTypeRaw.find((item) => item._id === type);
      return {
        bookingType: type,
        count: row?.count || 0,
        amount: this.toAmount(row?.amount),
      };
    });

    const bookingsByStatus = this.bookingStatuses.map((status) => {
      const row = bookingsByStatusRaw.find((item) => item._id === status);
      return {
        status,
        count: row?.count || 0,
        amount: this.toAmount(row?.amount),
      };
    });

    const bookingValueSummary = bookingValueSummaryRaw[0] || {};
    const bookingPaymentSummary = bookingPaymentsRaw[0] || {};
    const walletRechargeSummary = walletRechargeRaw[0] || {};
    const walletUsageSummary = walletUsageRaw[0] || {};

    return {
      dateRange: {
        dateFrom: query.dateFrom,
        dateTo: query.dateTo,
      },
      overview: {
        totalBookings,
        paidBookings,
        cancelledBookings,
        newUsers,
        totalRevenue: this.toAmount(bookingPaymentSummary.totalCollected),
        walletRechargeAmount: this.toAmount(walletRechargeSummary.totalCollected),
        walletUsageAmount: this.toAmount(walletUsageSummary.amount),
      },
      bookings: {
        byType: bookingsByType,
        byStatus: bookingsByStatus,
        totalValue: this.toAmount(bookingValueSummary.totalValue),
        paidValue: this.toAmount(bookingValueSummary.paidValue),
        pendingValue: this.toAmount(bookingValueSummary.pendingValue),
      },
      payments: {
        booking: {
          totalTransactions: Number(bookingPaymentSummary.totalTransactions || 0),
          paidTransactions: Number(bookingPaymentSummary.paidTransactions || 0),
          totalCollected: this.toAmount(bookingPaymentSummary.totalCollected),
          totalDiscount: this.toAmount(bookingPaymentSummary.totalDiscount),
        },
        walletRecharge: {
          totalTransactions: Number(walletRechargeSummary.totalTransactions || 0),
          paidTransactions: Number(walletRechargeSummary.paidTransactions || 0),
          totalCollected: this.toAmount(walletRechargeSummary.totalCollected),
        },
      },
      trends: {
        bookingsByDate: bookingsTrendRaw.map((row) => ({
          date: row._id,
          count: Number(row.count || 0),
          amount: this.toAmount(row.amount),
        })),
        revenueByDate: revenueTrendRaw.map((row) => ({
          date: row._id,
          amount: this.toAmount(row.amount),
          transactions: Number(row.transactions || 0),
        })),
      },
    };
  }
}
