import { Service } from 'typedi';
import { PharmacySupplierRepository } from '@/modules/pharmacySuppliers/repository';

@Service()
export class PharmacySupplierService {
  constructor(private supplierRepository: PharmacySupplierRepository) {}

  create(pharmacyId: unknown, actorId: unknown, body: unknown) {
    return this.supplierRepository.create(pharmacyId, actorId, body);
  }

  update(pharmacyId: unknown, actorId: unknown, id: unknown, body: unknown) {
    return this.supplierRepository.update(pharmacyId, actorId, id, body);
  }

  archive(pharmacyId: unknown, actorId: unknown, id: unknown, body: unknown) {
    return this.supplierRepository.archive(pharmacyId, actorId, id, body);
  }

  list(pharmacyId: unknown, query: unknown) {
    return this.supplierRepository.list(pharmacyId, query);
  }
}
