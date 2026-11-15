import { Service } from 'typedi';
import { ClientSession, Model } from 'mongoose';
import PartnerModel from '@/modules/partners/model';
import { IPartner } from '@/modules/partners/types';
import { BaseRepository } from '@/modules/common/repository';

@Service()
export class PartnerRepository extends BaseRepository<IPartner> {
  constructor() {
    super(PartnerModel as Model<IPartner>);
  }

  async findByIdWithModel(id: string) {
    return PartnerModel.findById(id);
  }

  async findActiveByKind(kind: string): Promise<IPartner[]> {
    return this.findAll(
      { kind, isActive: true },
      { sort: { name: 1 } }
    );
  }

  async findVerifiedPartners(): Promise<IPartner[]> {
    return this.findAll(
      { 'verification.state': 'verified', isActive: true },
      { sort: { name: 1 } }
    );
  }

  async incrementActiveOwnerCount(
    partnerId: string,
    expectedCount: number,
    session?: ClientSession
  ): Promise<IPartner | null> {
    const opts: any = { new: true };
    if (session) opts.session = session;
    return PartnerModel.findOneAndUpdate(
      { _id: partnerId, activeOwnerCount: expectedCount },
      { $inc: { activeOwnerCount: 1 } },
      opts
    ).lean();
  }

  async decrementActiveOwnerCount(
    partnerId: string,
    expectedCount: number,
    session?: ClientSession
  ): Promise<IPartner | null> {
    if (expectedCount <= 0) return null;
    const opts: any = { new: true };
    if (session) opts.session = session;
    return PartnerModel.findOneAndUpdate(
      { _id: partnerId, activeOwnerCount: expectedCount },
      { $inc: { activeOwnerCount: -1 } },
      opts
    ).lean();
  }
}
