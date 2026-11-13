import {
  IBookingLifecycle,
  IBookingLifecycleEvent,
} from '@/modules/bookings/types';

export type BookingLifecycleEventKey = keyof IBookingLifecycle;

type BookingLifecycleUpdate =
  | true
  | (Omit<IBookingLifecycleEvent, 'at'> & { at?: string });

export function buildBookingLifecyclePatch(
  current: IBookingLifecycle | undefined,
  updates: Partial<Record<BookingLifecycleEventKey, BookingLifecycleUpdate>>
): IBookingLifecycle | undefined {
  const lifecycle: IBookingLifecycle = { ...(current || {}) };
  let changed = false;

  for (const [rawKey, rawValue] of Object.entries(updates)) {
    const key = rawKey as BookingLifecycleEventKey;
    const value = rawValue as BookingLifecycleUpdate | undefined;

    if (!value || lifecycle[key]?.at) {
      continue;
    }

    if (value === true) {
      lifecycle[key] = { at: new Date().toISOString() };
    } else {
      lifecycle[key] = {
        at: value.at || new Date().toISOString(),
        ...value,
      };
    }
    changed = true;
  }

  return changed ? lifecycle : undefined;
}
