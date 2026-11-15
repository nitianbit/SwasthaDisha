import { Service } from 'typedi';
import { ClientSession, Model } from 'mongoose';
import MemberModel from '@/modules/partners/model/member';
import { IMember } from '@/modules/partners/types';
import { BaseRepository } from '@/modules/common/repository';

@Service()
export class MemberRepository extends BaseRepository<IMember> {
  constructor() {
    super(MemberModel as Model<IMember>);
  }

  async findByPhone(phone: string, partnerId: string): Promise<IMember | null> {
    return this.findOne({ phone, partnerId });
  }

  async findActiveByPartner(partnerId: string): Promise<IMember[]> {
    return this.findAll(
      { partnerId, isActive: true },
      { sort: { role: 1, name: 1 } }
    );
  }

  async findOwnersByPartner(partnerId: string): Promise<IMember[]> {
    return this.findAll(
      { partnerId, role: 'owner', isActive: true },
      { sort: { name: 1 } }
    );
  }

  async countActiveOwners(partnerId: string, session?: ClientSession): Promise<number> {
    const query = MemberModel.countDocuments({ partnerId, role: 'owner', isActive: true });
    if (session) query.session(session);
    return query;
  }

  async findActiveByPhoneAcrossPartners(phone: string): Promise<IMember[]> {
    return this.findAll(
      { phone, isActive: true },
      { sort: { partnerId: 1 } }
    );
  }
}
