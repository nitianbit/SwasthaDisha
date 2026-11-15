import { Service } from 'typedi';
import { Model } from 'mongoose';
import CatalogueItemModel from '@/modules/partners/model/catalogueItem';
import { ICatalogueItem } from '@/modules/partners/types';
import { BaseRepository } from '@/modules/common/repository';

@Service()
export class CatalogueItemRepository extends BaseRepository<ICatalogueItem> {
  constructor() {
    super(CatalogueItemModel as Model<ICatalogueItem>);
  }

  /** The partner's own view: active items, including any an admin disabled (shown flagged). */
  async findActiveByPartner(partnerId: string, kind?: string): Promise<ICatalogueItem[]> {
    return this.findAll({ partnerId, isActive: true, ...(kind ? { kind } : {}) }, { sort: { name: 1 } });
  }

  async findActiveByPartnerAndKind(partnerId: string, kind: string): Promise<ICatalogueItem[]> {
    return this.findActiveByPartner(partnerId, kind);
  }

  /** What customers may book or be billed for: active and not admin-disabled. */
  async findOfferedByPartner(partnerId: string, kind?: string): Promise<ICatalogueItem[]> {
    return this.findAll({ partnerId, isActive: true, adminDisabled: { $ne: true }, ...(kind ? { kind } : {}) }, { sort: { name: 1 } });
  }
}
