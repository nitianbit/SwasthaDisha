import { Service } from 'typedi';
import { AddressRepository } from '@/modules/addresses/repository';
import {
  IAddress,
  CreateAddressRequest,
  UpdateAddressRequest,
  AddressQueryParams,
} from '@/modules/addresses/types';
import { UserRepository } from '@/modules/user/repository';
import { AuthRequest } from '@/modules/middleware/auth';
import { AppError } from '@/modules/common/types';

@Service()
export class AddressService {
  constructor(
    private addressRepository: AddressRepository,
    private userRepository: UserRepository
  ) {}

  private resolveUserId(
    requester?: AuthRequest['user'],
    requestedUserId?: string
  ): string {
    if (!requester?._id) {
      throw new AppError({
        status: 401,
        code: 'UNAUTHORIZED',
        message: 'Authentication is required',
      });
    }

    if (requester.userType === 'admin' && requestedUserId) {
      return requestedUserId;
    }

    return requester._id;
  }

  private async ensureUserExists(userId: string): Promise<void> {
    const user = await this.userRepository.get(userId);

    if (!user) {
      throw new AppError({
        status: 404,
        code: 'USER_NOT_FOUND',
        message: 'User not found',
      });
    }
  }

  private async syncPrimaryAddressToUserProfile(
    userId: string,
    address: IAddress | null
  ): Promise<void> {
    if (address) {
      await this.userRepository.update(
        { _id: userId },
        {
          $set: {
            address: address.address,
            city: address.city,
            state: address.state,
            pincode: address.pincode,
            country: address.country,
            latitude: address.latitude,
            longitude: address.longitude,
          },
        } as any
      );
      return;
    }

    await this.userRepository.update(
      { _id: userId },
      {
        $unset: {
          address: 1,
          city: 1,
          state: 1,
          pincode: 1,
          country: 1,
          latitude: 1,
          longitude: 1,
        },
      } as any
    );
  }

  async create(
    data: CreateAddressRequest,
    requester?: AuthRequest['user']
  ): Promise<IAddress> {
    const userId = this.resolveUserId(requester, data.userId);
    await this.ensureUserExists(userId);

    const existingAddresses = await this.addressRepository.findByUserId(userId);
    const shouldBeDefault = data.isDefault === true || existingAddresses.length === 0;

    if (shouldBeDefault) {
      await this.addressRepository.unsetDefaultForUser(userId);
    }

    const createdAddress = await this.addressRepository.save({
      ...data,
      userId,
      isDefault: shouldBeDefault,
    });

    if (createdAddress.isDefault) {
      await this.syncPrimaryAddressToUserProfile(userId, createdAddress);
    }

    return createdAddress;
  }

  async getById(
    id: string,
    requester?: AuthRequest['user'],
    requestedUserId?: string
  ): Promise<IAddress> {
    const userId = this.resolveUserId(requester, requestedUserId);

    const address = await this.addressRepository.findOne({ _id: id, userId });

    if (!address) {
      throw new AppError({
        status: 404,
        code: 'ADDRESS_NOT_FOUND',
        message: 'Address not found',
      });
    }

    return address;
  }

  async getAll(
    queryParams: AddressQueryParams,
    requester?: AuthRequest['user']
  ): Promise<{
    data: IAddress[];
    total?: number;
    page?: number;
    totalPages?: number;
  }> {
    const effectiveQuery: AddressQueryParams = {
      ...queryParams,
      userId: this.resolveUserId(requester, queryParams.userId),
    };

    if (effectiveQuery.page && effectiveQuery.limit) {
      return this.addressRepository.findWithPagination(
        effectiveQuery,
        effectiveQuery.page,
        effectiveQuery.limit
      );
    }

    const filter: any = {
      userId: effectiveQuery.userId,
    };

    if (effectiveQuery.type) {
      filter.type = effectiveQuery.type;
    }

    if (effectiveQuery.isDefault !== undefined) {
      filter.isDefault = effectiveQuery.isDefault;
    }

    if (effectiveQuery.isActive !== undefined) {
      filter.isActive = effectiveQuery.isActive;
    }

    const sort: any = {};
    if (effectiveQuery.sortBy) {
      sort[effectiveQuery.sortBy] =
        effectiveQuery.sortOrder === 'desc' ? -1 : 1;
    } else {
      sort.isDefault = -1;
      sort.createdAt = -1;
    }

    const data = await this.addressRepository.findAll(filter, { sort });

    return { data };
  }

  async update(
    id: string,
    data: UpdateAddressRequest,
    requester?: AuthRequest['user'],
    requestedUserId?: string
  ): Promise<IAddress> {
    const existing = await this.getById(id, requester, requestedUserId);

    if (data.isDefault === true) {
      await this.addressRepository.unsetDefaultForUser(existing.userId, id);
    }

    const updated = await this.addressRepository.update(
      { _id: id, userId: existing.userId },
      data
    );

    if (!updated) {
      throw new AppError({
        status: 500,
        code: 'UPDATE_FAILED',
        message: 'Failed to update address',
      });
    }

    if (updated.isDefault) {
      await this.syncPrimaryAddressToUserProfile(existing.userId, updated);
    } else if (existing.isDefault) {
      const currentDefault = await this.addressRepository.findDefaultByUserId(
        existing.userId
      );
      await this.syncPrimaryAddressToUserProfile(existing.userId, currentDefault);
    }

    return updated;
  }

  async delete(
    id: string,
    requester?: AuthRequest['user'],
    requestedUserId?: string
  ): Promise<void> {
    const existing = await this.getById(id, requester, requestedUserId);

    await this.addressRepository.delete({ _id: id, userId: existing.userId });

    if (existing.isDefault) {
      const currentDefault = await this.addressRepository.findDefaultByUserId(
        existing.userId
      );
      await this.syncPrimaryAddressToUserProfile(existing.userId, currentDefault);
    }
  }
}
