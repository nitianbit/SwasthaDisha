import { Service } from 'typedi';
import { CatalogueItemRepository } from '@/modules/partners/repository/catalogueItem';
import { ICatalogueItem, CatalogueItemKind } from '@/modules/partners/types';
import { AppError } from '@/modules/common/types';

@Service()
export class CatalogueService {
  constructor(private catalogueRepo: CatalogueItemRepository) {}

  async createItem(partnerId: string, data: {
    kind: CatalogueItemKind;
    name: string;
    code?: string;
    description?: string;
    preparation?: string;
    sampleType?: string;
    includes?: string[];
    priceMinor: number;
    mrpMinor?: number;
    gstRate: 0 | 5 | 12 | 18 | 28;
    sac?: string;
    visitModes: ('home' | 'lab')[];
    reportTatHours?: number;
  }): Promise<ICatalogueItem> {
    return this.catalogueRepo.save({
      ...data,
      partnerId,
      isActive: true,
      adminDisabled: false,
    } as Partial<ICatalogueItem>);
  }

  async updateItem(partnerId: string, itemId: string, data: Partial<ICatalogueItem>): Promise<ICatalogueItem> {
    const item = await this.catalogueRepo.findById(itemId);
    if (!item || String(item.partnerId) !== String(partnerId)) {
      throw new AppError({ status: 404, code: 'CATALOGUE_ITEM_NOT_FOUND', message: 'Catalogue item not found' });
    }
    const { _id, partnerId: _p, isActive: _a, adminDisabled: _d, createdAt: _c, updatedAt: _u, ...safe } = data;
    const updated = await this.catalogueRepo.update({ _id: itemId }, safe);
    if (!updated) {
      throw new AppError({ status: 404, code: 'CATALOGUE_ITEM_NOT_FOUND', message: 'Catalogue item not found' });
    }
    return updated;
  }

  async deactivateItem(partnerId: string, itemId: string): Promise<void> {
    const item = await this.catalogueRepo.findById(itemId);
    if (!item || String(item.partnerId) !== String(partnerId)) {
      throw new AppError({ status: 404, code: 'CATALOGUE_ITEM_NOT_FOUND', message: 'Catalogue item not found' });
    }
    await this.catalogueRepo.update({ _id: itemId }, { isActive: false });
  }

  async adminDisableItem(itemId: string): Promise<void> {
    await this.catalogueRepo.update({ _id: itemId }, { adminDisabled: true });
  }

  async listItems(partnerId: string, kind?: CatalogueItemKind): Promise<ICatalogueItem[]> {
    if (kind) {
      return this.catalogueRepo.findActiveByPartnerAndKind(partnerId, kind);
    }
    return this.catalogueRepo.findActiveByPartner(partnerId);
  }

  async getItem(partnerId: string, itemId: string): Promise<ICatalogueItem> {
    const item = await this.catalogueRepo.findById(itemId);
    if (!item || String(item.partnerId) !== String(partnerId)) {
      throw new AppError({ status: 404, code: 'CATALOGUE_ITEM_NOT_FOUND', message: 'Catalogue item not found' });
    }
    return item;
  }
}
