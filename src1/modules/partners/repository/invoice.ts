import { Service } from 'typedi';
import { ClientSession, Model } from 'mongoose';
import { InvoiceModel, InvoiceEventModel, InvoiceCounterModel } from '@/modules/partners/model/invoice';
import { IInvoice, IInvoiceEvent, IInvoiceCounter } from '@/modules/partners/types';
import { BaseRepository } from '@/modules/common/repository';

@Service()
export class InvoiceRepository extends BaseRepository<IInvoice> {
  constructor() {
    super(InvoiceModel as Model<IInvoice>);
  }

  async findByPartner(partnerId: string, state?: string): Promise<IInvoice[]> {
    const query: any = { partnerId };
    if (state) query.lifecycleState = state;
    return this.findAll(query, { sort: { issuedAt: -1 } });
  }

  async findByCustomerUserId(userId: string): Promise<IInvoice[]> {
    return this.findAll(
      { 'customer.userId': userId },
      { sort: { issuedAt: -1 }, limit: 200 }
    );
  }

  async findByIdempotencyKey(partnerId: string, key: string): Promise<IInvoice | null> {
    return this.findOne({ partnerId, idempotencyKey: key });
  }

  /** Compare-and-set on partner, lifecycle version and state. */
  async casLifecycle(
    partnerId: string,
    invoiceId: string,
    expectedVersion: number,
    expectedState: string,
    newState: string,
    session: ClientSession,
    extraSet: Record<string, unknown> = {}
  ): Promise<IInvoice | null> {
    return InvoiceModel.findOneAndUpdate(
      { _id: invoiceId, partnerId, lifecycleVersion: expectedVersion, lifecycleState: expectedState },
      // Q14: a cancelled bill no longer holds its appointment (a new bill may be issued for it); payments set paidMinor.
      // r12: nor its lab desk booking.
      { $set: { lifecycleVersion: expectedVersion + 1, lifecycleState: newState, ...extraSet },
        ...(newState === 'cancelled' ? { $unset: { openAppointmentId: 1, openLabBookingId: 1 } } : {}) },
      { new: true, session }
    ).lean();
  }
}

@Service()
export class InvoiceEventRepository extends BaseRepository<IInvoiceEvent> {
  constructor() {
    super(InvoiceEventModel as Model<IInvoiceEvent>);
  }

  async findByInvoice(invoiceId: string): Promise<IInvoiceEvent[]> {
    return this.findAll({ invoiceId }, { sort: { version: 1 } });
  }
}

@Service()
export class InvoiceCounterRepository {
  async nextSequence(partnerId: string, financialYear: string, session: ClientSession): Promise<number> {
    const result = await InvoiceCounterModel.findOneAndUpdate(
      { partnerId, financialYear },
      { $inc: { seq: 1 } },
      { upsert: true, new: true, session }
    ).lean() as IInvoiceCounter;
    return result.seq;
  }
}
