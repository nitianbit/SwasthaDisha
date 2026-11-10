import { Service } from 'typedi';
import { Model } from 'mongoose';
import UserModel from '@/modules/user/model';
import { IUser } from '@/modules/user/types';
import { BaseRepository } from '@/modules/common/repository';

@Service()
export class UserRepository extends BaseRepository<IUser> {
  constructor() {
    super(UserModel as Model<IUser>);
  }

  findByPhone = async (phone: string, userType: string): Promise<IUser | null> => {
    return this.findOne({ phone, userType });
  };

  findByEmail = async (email: string, userType: string): Promise<IUser | null> => {
    return this.findOne({ email, userType });
  };

  findByCorporateEmail = async (
    corporateEmail: string,
    userType: string
  ): Promise<IUser | null> => {
    return this.findOne({ corporateEmail, userType });
  };

  findByPhoneOrEmail = async (
    phoneOrEmail: { phone?: string; email?: string },
    userType: string
  ): Promise<IUser | null> => {
    const query: any = { userType };
    if (phoneOrEmail.phone) {
      query.phone = phoneOrEmail.phone;
    } else if (phoneOrEmail.email) {
      query.email = phoneOrEmail.email;
    }
    return this.findOne(query);
  };

  findByAnyEmail = async (
    email: string,
    userType: string,
    excludeUserId?: string
  ): Promise<IUser | null> => {
    return this.findOne({
      userType,
      ...(excludeUserId ? { _id: { $ne: excludeUserId } } : {}),
      $or: [{ email }, { corporateEmail: email }],
    } as any);
  };

  findByReferralCode = async (referralCode: string): Promise<IUser | null> => {
    return this.findOne({ referralCode: referralCode.toUpperCase() });
  };
}
