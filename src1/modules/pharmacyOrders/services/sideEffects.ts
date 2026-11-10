import { Service } from 'typedi';
import { PharmacyOrderRepository } from '@/modules/pharmacyOrders/repository';
import { PharmacySubscriptionService } from '@/modules/pharmacySubscriptions/services';
import { NotificationService } from '@/modules/notification/services';
import { FcmService } from '@/modules/fcm/services';
import TaskQueue from '@/modules/queue/service/TaskQueue';
import {
  ConsumerType,
  PharmacyOrderSideEffectPayload,
} from '@/modules/queue/types';
import {
  IPharmacyOrder,
  PharmacyOrderSideEffectStatus,
  PharmacyOrderSideEffectTrigger,
} from '@/modules/pharmacyOrders/types';

@Service()
export class PharmacyOrderSideEffectService {
  constructor(
    private orderRepo: PharmacyOrderRepository,
    private subscriptionService: PharmacySubscriptionService,
    private notificationService: NotificationService,
    private fcmService: FcmService
  ) {}

  private async updateEffectState(
    orderId: string,
    effect: 'subscriptionSync' | 'notification',
    status: PharmacyOrderSideEffectStatus,
    lastError?: string
  ): Promise<void> {
    const setPayload: Record<string, unknown> = {
      [`sideEffects.${effect}.status`]: status,
      [`sideEffects.${effect}.updatedAt`]: new Date(),
    };

    if (lastError !== undefined) {
      setPayload[`sideEffects.${effect}.lastError`] = lastError;
    }

    const updatePayload: Record<string, unknown> = {
      $set: setPayload,
    };

    if (lastError === undefined) {
      updatePayload.$unset = {
        [`sideEffects.${effect}.lastError`]: 1,
      };
    }

    await this.orderRepo.update(
      { _id: orderId },
      updatePayload
    );
  }

  private buildRecurringItems(order: IPharmacyOrder) {
    return order.items
      .filter((item) => item.recurring)
      .map((item) => ({
        medicineId: String(item.medicineId),
        medicineName: item.medicineName,
        frequency: item.subscriptionFrequency,
        intervalDays: item.subscriptionIntervalDays!,
        nextRefillDate: item.subscriptionNextRefillDate,
        reminderChannel: item.subscriptionReminderChannel,
      }));
  }

  private buildNotificationContent(
    order: IPharmacyOrder,
    trigger: PharmacyOrderSideEffectTrigger
  ): { title: string; message: string } {
    if (trigger === 'payment_completed' || trigger === 'order_marked_paid') {
      return {
        title: 'Pharmacy Order Paid',
        message: 'Your pharmacy order payment has been confirmed.',
      };
    }

    if (trigger === 'order_abandoned') {
      return {
        title: 'Pharmacy Order Expired',
        message: 'Your pharmacy order was cancelled because payment was not completed in time.',
      };
    }

    if (trigger === 'order_created') {
      return {
        title: 'Pharmacy Order Placed',
        message: 'Your pharmacy order has been placed successfully.',
      };
    }

    if (trigger === 'order_updated') {
      return {
        title: 'Pharmacy Order Updated',
        message: 'Your pharmacy order details were updated.',
      };
    }

    const statusLabels: Record<string, string> = {
      accepted: 'accepted',
      packed: 'packed',
      ready_for_pickup: 'ready for pickup',
      out_for_delivery: 'out for delivery',
      completed: 'completed',
      cancelled: 'cancelled',
      rejected: 'rejected',
      abandoned: 'cancelled',
      placed: 'placed',
    };

    const statusLabel = statusLabels[order.status] || 'updated';
    return {
      title: 'Pharmacy Order Status Updated',
      message: `Your pharmacy order is now ${statusLabel}.`,
    };
  }

  async queueSubscriptionSync(
    orderId: string,
    trigger: PharmacyOrderSideEffectTrigger
  ): Promise<void> {
    const processAfter = Math.floor(Date.now() / 1000);
    await this.updateEffectState(orderId, 'subscriptionSync', 'pending');
    await TaskQueue.publishUniqueLater(
      ConsumerType.PHARMACY_ORDER_SIDE_EFFECT,
      `subscription-sync:${orderId}`,
      processAfter,
      {
        orderId,
        effect: 'subscription_sync',
        trigger,
      }
    );
  }

  async queueNotification(
    orderId: string,
    trigger: PharmacyOrderSideEffectTrigger
  ): Promise<void> {
    const processAfter = Math.floor(Date.now() / 1000);
    const order = await this.orderRepo.findById(orderId);
    const eventKey = `${trigger}:${order?.status || 'unknown'}:${order?.paymentStatus || 'unknown'}`;
    await this.updateEffectState(orderId, 'notification', 'pending');
    await TaskQueue.publishUniqueLater(
      ConsumerType.PHARMACY_ORDER_SIDE_EFFECT,
      `notification:${orderId}:${eventKey}`,
      processAfter,
      { orderId, effect: 'notification', trigger }
    );
  }

  async processSubscriptionSync(orderId: string): Promise<void> {
    const order = await this.orderRepo.findById(orderId);
    if (!order) {
      return;
    }

    if (!order.customerId) {
      await this.updateEffectState(orderId, 'subscriptionSync', 'success');
      return;
    }

    const recurringItems = this.buildRecurringItems(order);
    if (order.paymentStatus === 'paid') {
      await this.subscriptionService.reconcileForOrder(
        String(order.pharmacyId),
        String(order.customerId),
        String(order._id),
        order.status,
        recurringItems,
        String(order.createdById)
      );
    } else {
      await this.subscriptionService.syncOrderLinkage(
        String(order._id),
        order.status,
        'synced'
      );
    }

    await this.updateEffectState(orderId, 'subscriptionSync', 'success');
  }

  async processNotification(
    orderId: string,
    trigger: PharmacyOrderSideEffectTrigger
  ): Promise<void> {
    const order = await this.orderRepo.findById(orderId);
    if (!order || !order.customerId) {
      await this.updateEffectState(orderId, 'notification', 'success').catch(() => undefined);
      return;
    }

    const content = this.buildNotificationContent(order, trigger);

    const idempotencyKey = `pharmacy-order:${order._id}:${trigger}:${order.status}:${order.paymentStatus || 'pending'}`;
    const notification = await this.notificationService.create({
      userId: String(order.customerId),
      type: 'general',
      title: content.title,
      message: content.message,
      data: {
        orderId: String(order._id),
        orderStatus: order.status,
        paymentStatus: order.paymentStatus || 'pending',
        trigger,
      },
      referenceType: 'pharmacy_order',
      referenceId: String(order._id),
      idempotencyKey,
    });

    if (!notification.fcmSentAt) {
      await this.fcmService.sendNotificationToUser(
        String(order.customerId),
        {
          title: content.title,
          body: content.message,
          data: {
            type: 'pharmacy_order',
            orderId: String(order._id),
            trigger,
            orderStatus: order.status,
            paymentStatus: order.paymentStatus || 'pending',
          },
        },
        'user'
      );
      await this.notificationService.markFcmSent(String(notification._id));
    }

    await this.updateEffectState(orderId, 'notification', 'success');
  }

  async process(payload: PharmacyOrderSideEffectPayload): Promise<void> {
    if (payload.effect === 'subscription_sync') {
      try {
        await this.processSubscriptionSync(payload.orderId);
      } catch (error) {
        await this.updateEffectState(
          payload.orderId,
          'subscriptionSync',
          'failed',
          error instanceof Error ? error.message : String(error)
        ).catch(() => undefined);
        throw error;
      }
      return;
    }

    try {
      await this.processNotification(payload.orderId, payload.trigger);
    } catch (error) {
      await this.updateEffectState(
        payload.orderId,
        'notification',
        'failed',
        error instanceof Error ? error.message : String(error)
      ).catch(() => undefined);
      throw error;
    }
  }
}
