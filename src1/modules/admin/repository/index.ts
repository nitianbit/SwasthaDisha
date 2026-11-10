import { Service } from 'typedi';
import { Model } from 'mongoose';
import { BaseRepository } from '@/modules/common/repository';
import AdminModel from '@/modules/admin/model';
import { IAdmin } from '@/modules/admin/types';

@Service()
export class AdminRepository extends BaseRepository<IAdmin> {
  constructor() {
    super(AdminModel as Model<IAdmin>);
  }

  findByPhone = async (phone: string): Promise<IAdmin | null> => {
    return this.findOne({ phone });
  };

  findByEmail = async (email: string): Promise<IAdmin | null> => {
    return this.findOne({ email });
  };

  findByPhoneOrEmail = async (
    phoneOrEmail: { phone?: string; email?: string }
  ): Promise<IAdmin | null> => {
    const query: any = {};
    if (phoneOrEmail.phone) {
      query.phone = phoneOrEmail.phone;
    } else if (phoneOrEmail.email) {
      query.email = phoneOrEmail.email;
    }
    return this.findOne(query);
  };
}
