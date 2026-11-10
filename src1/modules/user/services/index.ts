import { Service } from 'typedi';
import { UserRepository } from '@/modules/user/repository';
import { CorporateRepository } from '@/modules/corporates/repository';
import { IUser, CreateUserRequest, UpdateUserRequest, UserQueryParams } from '@/modules/user/types';
import { AppError } from '@/modules/common/types';
import { buildContainsRegex } from '@/modules/common/utils/queryUtils';

@Service()
export class UserService {
  constructor(
    private userRepository: UserRepository,
    private corporateRepository: CorporateRepository
  ) {}

  private normalizeEmail(email?: string): string | undefined {
    return email?.trim().toLowerCase();
  }

  private async assertUserEmailsAvailable(params: {
    email?: string;
    corporateEmail?: string;
    excludeUserId?: string;
    allowSamePair?: boolean;
  }): Promise<void> {
    const email = this.normalizeEmail(params.email);
    const corporateEmail = this.normalizeEmail(params.corporateEmail);

    if (
      email &&
      corporateEmail &&
      email === corporateEmail &&
      !params.allowSamePair
    ) {
      throw new AppError({
        status: 400,
        code: 'EMAILS_MUST_DIFFER',
        message: 'Personal email and corporate email must be different',
      });
    }

    if (email) {
      const existing = await this.userRepository.findByAnyEmail(
        email,
        'user',
        params.excludeUserId
      );
      if (existing) {
        throw new AppError({
          status: 400,
          code: 'EMAIL_ALREADY_IN_USE',
          message: 'Email is already in use by another user',
        });
      }
    }

    if (corporateEmail) {
      const existing = await this.userRepository.findByAnyEmail(
        corporateEmail,
        'user',
        params.excludeUserId
      );
      if (existing) {
        throw new AppError({
          status: 400,
          code: 'CORPORATE_EMAIL_ALREADY_IN_USE',
          message: 'Corporate email is already in use by another user',
        });
      }
    }
  }

  async create(data: CreateUserRequest): Promise<IUser> {
    if (data.userType !== 'user') {
      throw new AppError({
        status: 400,
        code: 'INVALID_USER_TYPE',
        message: 'User module only supports user type',
      });
    }

    await this.assertUserEmailsAvailable({
      email: data.email,
      corporateEmail: data.corporateEmail,
    });

    // Check if user already exists
    const existingUser = await this.userRepository.findByPhoneOrEmail(
      { phone: data.phone, email: data.email },
      'user'
    );

    if (existingUser) {
      throw new AppError({
        status: 400,
        code: 'USER_ALREADY_EXISTS',
        message: 'User already exists',
      });
    }

    return this.userRepository.save(data);
  }

  async getById(id: string): Promise<IUser> {
    const user = await this.userRepository.get(id);
    if (!user) {
      throw new AppError({
        status: 404,
        code: 'USER_NOT_FOUND',
        message: 'User not found',
      });
    }
    return user;
  }

  async update(id: string, data: UpdateUserRequest): Promise<IUser> {
    const user = await this.userRepository.get(id);
    if (!user) {
      throw new AppError({
        status: 404,
        code: 'USER_NOT_FOUND',
        message: 'User not found',
      });
    }

    if (data.userType && data.userType !== 'user') {
      throw new AppError({
        status: 400,
        code: 'INVALID_USER_TYPE',
        message: 'User module only supports user type',
      });
    }

    const nextEmail = data.email ?? user.email;
    const nextCorporateEmail = data.corporateEmail ?? user.corporateEmail;
    const currentEmail = this.normalizeEmail(user.email);
    const currentCorporateEmail = this.normalizeEmail(user.corporateEmail);
    await this.assertUserEmailsAvailable({
      email: nextEmail,
      corporateEmail: nextCorporateEmail,
      excludeUserId: id,
      allowSamePair:
        !!currentEmail &&
        !!currentCorporateEmail &&
        currentEmail === currentCorporateEmail &&
        this.normalizeEmail(nextEmail) === currentEmail &&
        this.normalizeEmail(nextCorporateEmail) === currentCorporateEmail,
    });

    // Verify email domain against corporate domain if email is changing
    if (data.email && data.email !== user.email) {
      const corporateId = data.corporateId || user.corporateId;

      if (corporateId) {
        await this.verifyEmailDomain(data.email, corporateId);
      } else if (data.isCorporateUser) {
        const emailDomain = data.email.split('@')[1]?.toLowerCase();
        if (emailDomain) {
          const corporate = await this.corporateRepository.findOne({
            domain: emailDomain,
            isActive: true,
          });

          if (!corporate) {
            throw new AppError({
              status: 400,
              code: 'CORPORATE_NOT_FOUND',
              message: `No corporate found for domain`,
            });
          }

          data.corporateId = corporate._id?.toString();
        }
      }
    }

    if (
      data.corporateEmail &&
      data.corporateEmail.trim().toLowerCase() !==
        user.corporateEmail?.trim().toLowerCase()
    ) {
      data.isCorporateEmailVerified = false;
    }

    const updated = await this.userRepository.update({ _id: id }, data);
    if (!updated) {
      throw new AppError({
        status: 500,
        code: 'UPDATE_FAILED',
        message: 'Failed to update user',
      });
    }

    return updated;
  }

  private async verifyEmailDomain(email: string, corporateId?: string): Promise<void> {
    if (!corporateId) return;

    const corporate = await this.corporateRepository.findById(corporateId);

    if (!corporate || !corporate.domain) return;

    const emailDomain = email.split('@')[1]?.toLowerCase();

    if (emailDomain !== corporate.domain.toLowerCase()) {
      throw new AppError({
        status: 400,
        code: 'EMAIL_DOMAIN_MISMATCH',
        message: `Email domain does not match corporate domain. Expected @${corporate.domain}`,
      });
    }
  }

  async findAll(queryParams: UserQueryParams): Promise<IUser[]> {
    const filter: any = {};

    if (queryParams.userType) {
      filter.userType = queryParams.userType;
    }
    if (queryParams.name) {
      filter.name = buildContainsRegex(queryParams.name);
    }
    if (queryParams.email) {
      filter.email = buildContainsRegex(queryParams.email);
    }
    if (queryParams.phone) {
      filter.phone = queryParams.phone;
    }
    if (queryParams.forUser) {
      filter.corporateId = { $exists: false };
    } else if (queryParams.corporateId) {
      filter.corporateId = queryParams.corporateId;
    }

    const options: any = {};
    if (queryParams.limit) {
      options.limit = queryParams.limit;
    }
    if (queryParams.page && queryParams.limit) {
      options.skip = (queryParams.page - 1) * queryParams.limit;
    }
    if (queryParams.sortBy) {
      options.sort = { [queryParams.sortBy]: queryParams.sortOrder === 'desc' ? -1 : 1 };
    }

    return this.userRepository.findAll(filter, options);
  }

  async delete(id: string): Promise<void> {
    const user = await this.userRepository.get(id);
    if (!user) {
      throw new AppError({
        status: 404,
        code: 'USER_NOT_FOUND',
        message: 'User not found',
      });
    }

    await this.userRepository.delete({ _id: id });
  }
}
