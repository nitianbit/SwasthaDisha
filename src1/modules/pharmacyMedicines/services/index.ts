import { Service } from 'typedi';
import { MedicineRepository } from '@/modules/pharmacyMedicines/repository';
import {
  IMedicine,
  CreateMedicineRequest,
  UpdateMedicineRequest,
  MedicineQueryParams,
  NearbyMedicineDto,
  NearbyMedicineQueryParams,
} from '@/modules/pharmacyMedicines/types';
import { AppError } from '@/modules/common/types';
import { buildMedicineNameKey } from '@/modules/pharmacyMedicines/services/nameKeyMigration';

@Service()
export class MedicineService {
  constructor(private medicineRepository: MedicineRepository) {}

  private normalizeName(name: string): string {
    return name.trim();
  }

  private buildNameKey(name: string): string {
    return buildMedicineNameKey(name);
  }

  async create(data: CreateMedicineRequest): Promise<IMedicine> {
    const name = this.normalizeName(data.name);
    const nameKey = this.buildNameKey(name);
    const existing = await this.medicineRepository.findByNormalizedName(name);
    if (existing.length > 1) {
      throw new AppError({
        status: 409,
        code: 'MEDICINE_DUPLICATE_DATA',
        message: 'Multiple medicines already exist with this normalized name. Resolve duplicates before creating more.',
      });
    }
    if (existing.length === 1) {
      throw new AppError({
        status: 400,
        code: 'MEDICINE_ALREADY_EXISTS',
        message: 'Medicine with this name already exists',
      });
    }

    return this.medicineRepository.save({ ...data, name, nameKey });
  }

  async getById(id: string): Promise<IMedicine> {
    const medicine = await this.medicineRepository.findById(id);
    if (!medicine) {
      throw new AppError({ status: 404, code: 'MEDICINE_NOT_FOUND', message: 'Medicine not found' });
    }
    return medicine;
  }

  async getAll(queryParams: MedicineQueryParams = {}): Promise<{
    data: IMedicine[];
    total?: number;
    page?: number;
    totalPages?: number;
  }> {
    if (queryParams.page && queryParams.limit) {
      return this.medicineRepository.findWithPagination(
        queryParams,
        queryParams.page,
        queryParams.limit
      );
    }

    const filter = this.medicineRepository.buildFilterFromParams(queryParams);
    const sort = this.medicineRepository.buildSortFromParams(queryParams);
    const data = await this.medicineRepository.findAll(filter, { sort });
    return { data };
  }

  async getNearbyAvailableMedicines(
    queryParams: NearbyMedicineQueryParams,
    includeWholesalePrice: boolean
  ): Promise<{
    data: NearbyMedicineDto[];
    total: number;
    page: number;
    totalPages: number;
  }> {
    return this.medicineRepository.findNearbyAvailableMedicines(
      queryParams,
      includeWholesalePrice
    );
  }

  async update(id: string, data: UpdateMedicineRequest, actorUserType?: string): Promise<IMedicine> {
    const medicine = await this.medicineRepository.findById(id);
    if (!medicine) {
      throw new AppError({ status: 404, code: 'MEDICINE_NOT_FOUND', message: 'Medicine not found' });
    }

    if (
      actorUserType !== 'admin' &&
      data !== null &&
      typeof data === 'object' &&
      Object.prototype.hasOwnProperty.call(data, 'prescriptionRequired')
    ) {
      throw new AppError({
        status: 422,
        code: 'FORBIDDEN_FIELD',
        message: 'Medicine prescription requirement cannot be updated by this actor',
      });
    }

    if (data.name && this.normalizeName(data.name) !== medicine.name) {
      const normalizedName = this.normalizeName(data.name);
      const nameKey = this.buildNameKey(normalizedName);
      const existing = (await this.medicineRepository.findByNormalizedName(normalizedName))
        .filter((item) => String(item._id) !== id);
      if (existing.length > 1) {
        throw new AppError({
          status: 409,
          code: 'MEDICINE_DUPLICATE_DATA',
          message: 'Multiple medicines already exist with this normalized name. Resolve duplicates before renaming.',
        });
      }
      if (existing.length === 1) {
        throw new AppError({
          status: 400,
          code: 'MEDICINE_ALREADY_EXISTS',
          message: 'Medicine with this name already exists',
        });
      }
      data.name = normalizedName;
      data.nameKey = nameKey;
    }

    const updated = await this.medicineRepository.update({ _id: id }, data);
    if (!updated) {
      throw new AppError({ status: 500, code: 'UPDATE_FAILED', message: 'Failed to update medicine' });
    }
    return updated;
  }

  async delete(id: string, archivedBy?: string, archiveReason?: string): Promise<void> {
    const medicine = await this.medicineRepository.findById(id);
    if (!medicine) {
      throw new AppError({ status: 404, code: 'MEDICINE_NOT_FOUND', message: 'Medicine not found' });
    }
    await this.medicineRepository.update(
      { _id: id },
      { isActive: false, archivedAt: new Date(), archivedBy, archiveReason }
    );
  }
}
