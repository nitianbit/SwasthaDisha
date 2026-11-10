import { Service } from 'typedi';
import { DependentRepository } from '@/modules/dependents/repository';
import {
  IDependent,
  CreateDependentRequest,
  UpdateDependentRequest,
  DependentQueryParams,
} from '@/modules/dependents/types';
import { AppError } from '@/modules/common/types';

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

@Service()
export class DependentService {
  constructor(private dependentRepository: DependentRepository) {}

  private async assertNoActiveDuplicateDependent(params: {
    userId: string;
    name: string;
    relationship: string;
    excludeId?: string;
  }): Promise<void> {
    const existing = await this.dependentRepository.findOne({
      userId: params.userId,
      relationship: params.relationship,
      isActive: true,
      name: {
        $regex: `^${escapeRegex(params.name.trim())}$`,
        $options: 'i',
      },
      ...(params.excludeId ? { _id: { $ne: params.excludeId } } : {}),
    } as any);

    if (existing) {
      throw new AppError({
        status: 400,
        code: 'DEPENDENT_ALREADY_EXISTS',
        message:
          'An active dependent with the same name and relationship already exists for this user',
      });
    }
  }

  async create(data: CreateDependentRequest): Promise<IDependent> {
    // Validate that userId is provided
    if (!data.userId) {
      throw new AppError({
        status: 400,
        code: 'USER_ID_REQUIRED',
        message: 'User ID is required',
      });
    }

    // Check if user already has a dependent with "Me" relationship (only one allowed)
    if (data.relationship === 'Me') {
      const existingMe = await this.dependentRepository.findOne({
        userId: data.userId,
        relationship: 'Me',
        isActive: true,
      });

      if (existingMe) {
        throw new AppError({
          status: 400,
          code: 'ME_DEPENDENT_EXISTS',
          message: 'User already has a "Me" dependent. Only one is allowed.',
        });
      }
    }

    await this.assertNoActiveDuplicateDependent({
      userId: data.userId,
      name: data.name,
      relationship: data.relationship,
    });

    return this.dependentRepository.save(data);
  }

  async getById(id: string, userId?: string): Promise<IDependent> {
    const query: any = { _id: id };
    
    // If userId is provided, ensure the dependent belongs to that user
    if (userId) {
      query.userId = userId;
    }

    const dependent = await this.dependentRepository.findOne(query);

    if (!dependent) {
      throw new AppError({
        status: 404,
        code: 'DEPENDENT_NOT_FOUND',
        message: 'Dependent not found',
      });
    }

    return dependent;
  }

  async getAll(
    queryParams: DependentQueryParams = {}
  ): Promise<{
    data: IDependent[];
    total?: number;
    page?: number;
    totalPages?: number;
  }> {
    // If pagination params are provided, use pagination
    if (queryParams.page && queryParams.limit) {
      return this.dependentRepository.findWithPagination(
        queryParams,
        queryParams.page,
        queryParams.limit
      );
    }

    // Otherwise return all matching records
    const filter: any = {};

    if (queryParams.userId) {
      filter.userId = queryParams.userId;
    }

    if (queryParams.relationship) {
      filter.relationship = queryParams.relationship;
    }

    if (queryParams.isActive !== undefined) {
      filter.isActive = queryParams.isActive;
    }

    const sort: any = {};
    if (queryParams.sortBy) {
      sort[queryParams.sortBy] = queryParams.sortOrder === 'desc' ? -1 : 1;
    } else {
      sort.createdAt = -1;
    }

    let data: IDependent[];

    if (queryParams.userId) {
      if (queryParams.relationship) {
        data = await this.dependentRepository.findByUserIdAndRelationship(
          queryParams.userId,
          queryParams.relationship
        );
      } else {
        data = await this.dependentRepository.findByUserId(queryParams.userId);
      }
    } else {
      data = await this.dependentRepository.findAll(filter, { sort });
    }

    return { data };
  }

  async update(
    id: string,
    data: UpdateDependentRequest,
    userId?: string
  ): Promise<IDependent> {
    // First verify the dependent exists and belongs to the user if userId is provided
    const existing = await this.getById(id, userId);

    // If trying to update relationship to "Me", check if another "Me" exists
    if (data.relationship === 'Me' && existing.relationship !== 'Me') {
      const existingMe = await this.dependentRepository.findOne({
        userId: existing.userId,
        relationship: 'Me',
        isActive: true,
        _id: { $ne: id },
      });

      if (existingMe) {
        throw new AppError({
          status: 400,
          code: 'ME_DEPENDENT_EXISTS',
          message: 'User already has a "Me" dependent. Only one is allowed.',
        });
      }
    }

    const nextName = data.name ?? existing.name;
    const nextRelationship = data.relationship ?? existing.relationship;
    const nextIsActive = data.isActive ?? existing.isActive ?? true;

    if (nextIsActive) {
      await this.assertNoActiveDuplicateDependent({
        userId: existing.userId,
        name: nextName,
        relationship: nextRelationship,
        excludeId: id,
      });
    }

    const updated = await this.dependentRepository.update({ _id: id }, data);

    if (!updated) {
      throw new AppError({
        status: 500,
        code: 'UPDATE_FAILED',
        message: 'Failed to update dependent',
      });
    }

    return updated;
  }

  async delete(id: string, userId?: string): Promise<void> {
    // Verify the dependent exists and belongs to the user if userId is provided
    await this.getById(id, userId);

    await this.dependentRepository.delete({ _id: id });
  }

  async getByUserId(userId: string): Promise<IDependent[]> {
    return this.dependentRepository.findByUserId(userId);
  }

  async getActiveDependents(userId: string): Promise<IDependent[]> {
    return this.dependentRepository.findActiveDependents(userId);
  }
}
