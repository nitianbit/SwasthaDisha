import { Container } from 'typedi';
import JobConsumer from '@/modules/queue/service/JobConsumer';
import {
  ConsumerType,
  JobPayload,
  PharmacyOrderSideEffectPayload,
} from '@/modules/queue/types';
import { PharmacyOrderSideEffectService } from '@/modules/pharmacyOrders/services/sideEffects';
import logger from '@/services/logger';

class PharmacyOrderSideEffectConsumer extends JobConsumer {
  constructor() {
    super(ConsumerType.PHARMACY_ORDER_SIDE_EFFECT);
  }

  async consume(payload: JobPayload): Promise<boolean> {
    const data = payload as PharmacyOrderSideEffectPayload;
    if (!data.orderId || !data.effect || !data.trigger) {
      return true;
    }

    try {
      const service = Container.get(PharmacyOrderSideEffectService);
      await service.process(data);
      return true;
    } catch (error) {
      logger.error('Failed to process pharmacy order side-effect job', {
        orderId: data.orderId,
        effect: data.effect,
        trigger: data.trigger,
        error: error instanceof Error ? error.message : String(error),
      });
      return false;
    }
  }
}

const pharmacyOrderSideEffectConsumer = new PharmacyOrderSideEffectConsumer();
export default pharmacyOrderSideEffectConsumer;
