import { Service } from 'typedi';
import { PharmacyCustomerService } from '@/modules/pharmacyCustomers/services';
import { PharmacyOrderRepository } from '@/modules/pharmacyOrders/repository';
import { PharmacySubscriptionRepository } from '@/modules/pharmacySubscriptions/repository';
import { OrderHealthCheckRepository } from '@/modules/orderHealthChecks/repository';
import { UpdatePharmacyCustomerNotesRequest } from '@/modules/pharmacyCustomers/types';

@Service()
export class PatientTrackingService {
  constructor(
    private customerService: PharmacyCustomerService,
    private orderRepo: PharmacyOrderRepository,
    private subscriptionRepo: PharmacySubscriptionRepository,
    private orderHealthCheckRepo: OrderHealthCheckRepository
  ) {}

  async getSummary(userId: string, pharmacyId: string) {
    // Enforce privacy — only linked pharmacies can see patient data
    const customer = await this.customerService.getLink(pharmacyId, userId);

    const [orders, subscriptions, healthChecks] = await Promise.all([
      this.orderRepo.findWithPagination({ pharmacyId, customerId: userId }, 1, 5),
      this.subscriptionRepo.findWithPagination({ pharmacyId, userId, isActive: true }, 1, 10),
      this.orderHealthCheckRepo.findByUserAndPharmacy(userId, pharmacyId),
    ]);

    const lastOrder = orders.data[0] ?? null;

    return {
      userId,
      pharmacyId,
      relationship: customer,
      recentOrders: orders.data,
      activeSubscriptions: subscriptions.data,
      recentHealthChecks: healthChecks.slice(0, 5),
      lastOrderDate: lastOrder?.createdAt ?? null,
      lastOrderStatus: lastOrder?.status ?? null,
    };
  }

  async updateSummary(
    userId: string,
    pharmacyId: string,
    data: UpdatePharmacyCustomerNotesRequest
  ) {
    return this.customerService.updateNotes(pharmacyId, userId, data);
  }
}
