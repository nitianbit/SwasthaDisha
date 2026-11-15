import { Service } from 'typedi';
import { CatalogueItemRepository } from '@/modules/partners/repository/catalogueItem';
import { ICatalogueItem, CatalogueItemKind } from '@/modules/partners/types';
import { AppError } from '@/modules/common/types';
import { PartnerActor, adminActor, inTransaction, recordPartnerAudit } from '@/modules/partners/services';

const notFound = () => new AppError({ status: 404, code: 'CATALOGUE_ITEM_NOT_FOUND', message: 'Catalogue item not found' });

export type CatalogueItemInput = {
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
};

/** §4: the partner sets its menu and prices (live at once); admins can disable an item. Catalogue is partner-wide. */
@Service()
export class CatalogueService {
  constructor(private catalogueRepo: CatalogueItemRepository) {}

  async createItem(actor: PartnerActor, data: CatalogueItemInput): Promise<ICatalogueItem> {
    if (data.mrpMinor !== undefined && data.mrpMinor < data.priceMinor) {
      throw new AppError({ status: 400, code: 'INVALID_MRP', message: 'MRP cannot be below the price' });
    }
    return inTransaction(async (session) => {
      const item = await this.catalogueRepo.save({
        ...data,
        partnerId: actor.partnerId,
        isActive: true,
        adminDisabled: false,
      } as Partial<ICatalogueItem>, { session });
      await recordPartnerAudit(actor, 'catalogue.create', { kind: 'catalogue_item', id: String(item._id) }, { priceMinor: data.priceMinor }, session);
      return item;
    });
  }

  async updateItem(actor: PartnerActor, itemId: string, data: Partial<CatalogueItemInput>): Promise<ICatalogueItem> {
    await this.getItem(actor, itemId);
    const { kind: _k, ...safe } = data as Partial<CatalogueItemInput>;
    // The price/MRP pair is validated on the state read in this transaction attempt and written with a compare-and-set
    // on exactly that pair, so two concurrent edits can never combine into an invalid pair.
    return inTransaction(async (session) => {
      const item = await this.catalogueRepo.findOne({ _id: itemId, partnerId: actor.partnerId }, session);
      if (!item) throw notFound();
      const price = safe.priceMinor ?? item.priceMinor;
      const mrp = safe.mrpMinor ?? item.mrpMinor;
      if (mrp !== undefined && mrp !== null && mrp < price) {
        throw new AppError({ status: 400, code: 'INVALID_MRP', message: 'MRP cannot be below the price' });
      }
      const updated = await this.catalogueRepo.update(
        { _id: itemId, partnerId: actor.partnerId, priceMinor: item.priceMinor, mrpMinor: item.mrpMinor ?? null },
        { $set: safe }, { new: true, session } as any);
      if (!updated) throw Object.assign(new AppError({ status: 409, code: 'CATALOGUE_ITEM_CHANGED', message: 'The item changed meanwhile; reload and try again' }), { retryable: true });
      await recordPartnerAudit(actor, 'catalogue.update', { kind: 'catalogue_item', id: itemId }, { fields: Object.keys(safe) }, session);
      return updated;
    });
  }

  async deactivateItem(actor: PartnerActor, itemId: string): Promise<void> {
    await this.getItem(actor, itemId);
    await inTransaction(async (session) => {
      const done = await this.catalogueRepo.update({ _id: itemId, partnerId: actor.partnerId, isActive: true }, { isActive: false }, { new: true, session } as any);
      if (done) await recordPartnerAudit(actor, 'catalogue.deactivate', { kind: 'catalogue_item', id: itemId }, undefined, session);
    });
  }

  async listItems(actor: PartnerActor, kind?: CatalogueItemKind): Promise<ICatalogueItem[]> {
    return kind
      ? this.catalogueRepo.findActiveByPartnerAndKind(actor.partnerId, kind)
      : this.catalogueRepo.findActiveByPartner(actor.partnerId);
  }

  async getItem(actor: PartnerActor, itemId: string): Promise<ICatalogueItem> {
    const item = await this.catalogueRepo.findById(itemId);
    if (!item || String(item.partnerId) !== actor.partnerId) throw notFound();
    return item;
  }

  /** Admin-only switch the partner cannot undo. */
  async setAdminDisabled(adminId: string, itemId: string, disabled: boolean): Promise<ICatalogueItem> {
    const item = await this.catalogueRepo.findById(itemId);
    if (!item) throw notFound();
    return inTransaction(async (session) => {
      const updated = await this.catalogueRepo.update({ _id: itemId }, { adminDisabled: disabled }, { new: true, session } as any);
      await recordPartnerAudit(adminActor(adminId, String(item.partnerId)),
        disabled ? 'catalogue.admin_disable' : 'catalogue.admin_enable', { kind: 'catalogue_item', id: itemId }, undefined, session);
      return updated!;
    });
  }
}
