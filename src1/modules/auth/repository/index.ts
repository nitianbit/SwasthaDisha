import { Service } from 'typedi';
import { UserRepository } from '@/modules/user/repository';
import { IUser } from '@/modules/user/types';

// AuthRepository is now a wrapper around UserRepository
// Auth module focuses on authentication/authorization logic only
@Service()
export class AuthRepository {
  constructor(private userRepository: UserRepository) {}

  findByPhone = async (phone: string, userType: string): Promise<IUser | null> => {
    return this.userRepository.findByPhone(phone, userType);
  };

  findByEmail = async (email: string, userType: string): Promise<IUser | null> => {
    return this.userRepository.findByEmail(email, userType);
  };

  findByPhoneOrEmail = async (
    phoneOrEmail: { phone?: string; email?: string },
    userType: string
  ): Promise<IUser | null> => {
    return this.userRepository.findByPhoneOrEmail(phoneOrEmail, userType);
  };

  save = async (data: Partial<IUser>): Promise<IUser> => {
    return this.userRepository.save(data);
  };
}
