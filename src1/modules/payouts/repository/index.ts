import { Service } from 'typedi';
import { Model } from 'mongoose';
import BaseRepository from '@/modules/common/repository/BaseRepository';
import {
  PayoutBillingModel,
  PayoutDisbursalModel,
  PayoutSummaryModel,
} from '@/modules/payouts/model';
import {
  IPayoutBilling,
  IPayoutDisbursal,
  IPayoutSummary,
} from '@/modules/payouts/types';

@Service()
export class PayoutBillingRepository extends BaseRepository<IPayoutBilling> {
  constructor() {
    super(PayoutBillingModel as Model<IPayoutBilling>);
  }
}

@Service()
export class PayoutDisbursalRepository extends BaseRepository<IPayoutDisbursal> {
  constructor() {
    super(PayoutDisbursalModel as Model<IPayoutDisbursal>);
  }
}

@Service()
export class PayoutSummaryRepository extends BaseRepository<IPayoutSummary> {
  constructor() {
    super(PayoutSummaryModel as Model<IPayoutSummary>);
  }
}
