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

  async findActiveByPartner(partnerId: string): Promise<ICatalogueItem[]> {
    return this.findAll(
      { partnerId, isActive: true, adminDisabled: false },
      { sort: { name: 1 } }
    );
  }

  async findActiveByPartnerAndKind(partnerId: string, kind: string): Promise<ICatalogueItem[]> {
    return this.findAll(
      { partnerId, kind, isActive: true, adminDisabled: false },
      { sort: { name: 1 } }
    );
  }
}
