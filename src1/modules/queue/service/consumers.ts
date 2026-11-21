import bookingReminderConsumer from '@/modules/queue/service/BookingReminderConsumer';
import pharmacyOrderSideEffectConsumer from '@/modules/queue/service/PharmacyOrderSideEffectConsumer';

export { bookingReminderConsumer };
export { pharmacyOrderSideEffectConsumer };

// Assisted booking phase 0: dispensing copies made in the background (lists never convert inline).
export { dispensingCopyConsumer } from '@/modules/assisted/dispensingCopy';
