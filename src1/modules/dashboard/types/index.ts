export interface DashboardAnalyticsQueryParams {
  dateFrom: string; // YYYYMMDD
  dateTo: string; // YYYYMMDD
}

export interface DashboardAnalyticsResponse {
  dateRange: {
    dateFrom: string;
    dateTo: string;
  };
  overview: {
    totalBookings: number;
    paidBookings: number;
    cancelledBookings: number;
    newUsers: number;
    totalRevenue: number;
    walletRechargeAmount: number;
    walletUsageAmount: number;
  };
  bookings: {
    byType: Array<{ bookingType: string; count: number; amount: number }>;
    byStatus: Array<{ status: string; count: number; amount: number }>;
    totalValue: number;
    paidValue: number;
    pendingValue: number;
  };
  payments: {
    booking: {
      totalTransactions: number;
      paidTransactions: number;
      totalCollected: number;
      totalDiscount: number;
    };
    walletRecharge: {
      totalTransactions: number;
      paidTransactions: number;
      totalCollected: number;
    };
  };
  trends: {
    bookingsByDate: Array<{ date: string; count: number; amount: number }>;
    revenueByDate: Array<{ date: string; amount: number; transactions: number }>;
  };
}
