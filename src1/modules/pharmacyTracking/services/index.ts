import { Service } from 'typedi';
import { PharmacyRepository } from '@/modules/pharmacies/repository';
import PharmacyOrderModel from '@/modules/pharmacyOrders/model';
import PharmacyCustomerModel from '@/modules/pharmacyCustomers/model';
import PharmacySubscriptionModel from '@/modules/pharmacySubscriptions/model';
import { AppError } from '@/modules/common/types';

@Service()
export class PharmacyTrackingService {
  constructor(
    private pharmacyRepo: PharmacyRepository
  ) {}

  private async assertPharmacyExists(pharmacyId: string) {
    const pharmacy = await this.pharmacyRepo.findById(pharmacyId);
    if (!pharmacy) {
      throw new AppError({ status: 404, code: 'PHARMACY_NOT_FOUND', message: 'Pharmacy not found' });
    }
    return pharmacy;
  }

  async getSummary(pharmacyId: string) {
    await this.assertPharmacyExists(pharmacyId);

    const [totalOrders, linkedCustomers, activeSubscriptions, inStoreOrders, onlineOrders, buyerOrders, customerOrders] = await Promise.all([
      PharmacyOrderModel.countDocuments({ pharmacyId }),
      PharmacyCustomerModel.countDocuments({ pharmacyId }),
      PharmacySubscriptionModel.countDocuments({ pharmacyId, isActive: true }),
      PharmacyOrderModel.countDocuments({ pharmacyId, orderType: 'in_store' }),
      PharmacyOrderModel.countDocuments({ pharmacyId, orderType: 'online' }),
      PharmacyOrderModel.countDocuments({
        pharmacyId,
        buyerPharmacyId: { $exists: true, $ne: null },
      }),
      PharmacyOrderModel.countDocuments({
        pharmacyId,
        customerId: { $exists: true, $ne: null },
      }),
    ]);

    return {
      pharmacyId,
      totalOrders,
      totalLinkedCustomers: linkedCustomers,
      activeRecurringSubscriptions: activeSubscriptions,
      channelBreakdown: {
        inStore: inStoreOrders,
        online: onlineOrders,
      },
      partyBreakdown: {
        pharmacyToPharmacy: buyerOrders,
        customerOrders,
      },
    };
  }

}
