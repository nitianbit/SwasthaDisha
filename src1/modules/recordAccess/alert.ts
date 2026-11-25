import type { ClientSession } from 'mongoose';
import { raiseAlertIn } from '@/modules/assisted/limits';
import { RecordReadModel } from '@/modules/recordAccess/model';

/**
 * r30 (§25.9.6): a booking cancelled or marked no-show after its doctor read other providers' records under it
 * (`other_history` or `file` read-log rows with this treating booking) raises `read_then_cancel` for admins, in the
 * cancelling transaction. An alert only: the cancellation goes on.
 */
export async function alertReadThenCancelIn(bookingId: string, s: ClientSession): Promise<void> {
  const id = String(bookingId).toLowerCase();
  if (await RecordReadModel.exists({ treatingBookingId: id, scope: { $in: ['other_history', 'file'] } }).session(s)) {
    await raiseAlertIn({ kind: 'read_then_cancel', subject: id, detail: { bookingId: id } }, s);
  }
}
