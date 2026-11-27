import { claimRequestKey, abandonRequestKey } from '@/modules/requestKeys';
import { createHash } from 'crypto';
import { canonicalJson, assertExemptRate } from '@/modules/partners/services/invoice';
import { Service } from 'typedi';
import { CatalogueItemRepository } from '@/modules/partners/repository/catalogueItem';
import { ICatalogueItem, CatalogueItemKind } from '@/modules/partners/types';
import { AppError } from '@/modules/common/types';
import { PartnerActor, adminActor, inTransaction, recordPartnerAudit } from '@/modules/partners/services';
import PartnerOrgModel from '@/modules/partners/model';
import CatalogueItemModel from '@/modules/partners/model/catalogueItem';

const LAB_KINDS = ['test', 'package'];
/** Whether `kind` is one this partner type takes (legacy items with another kind may be converted once). */
async function kindFits(partnerId: string, kind: string): Promise<boolean> {
  const p = await PartnerOrgModel.findById(partnerId).select({ kind: 1 }).lean() as { kind?: string } | null;
  return (p?.kind === 'clinic' ? ['consultation', 'procedure', 'package', 'other'] : ['test', 'package']).includes(kind);
}
const CLINIC_KINDS = ['consultation', 'procedure', 'package', 'other'];

/**
 * Q10: what a partner may put in its catalogue — kinds by partner type (labs: tests/packages with visit modes; clinics:
 * consultations/procedures/packages/other, no visit modes) and GST only when the partner can charge it (a regular
 * registration with a GSTIN; otherwise 0%).
 */
async function assertItemFits(partnerId: string, item: { kind?: string; gstRate?: number; visitModes?: string[] }, _current?: { kind: string }) {
  const p = await PartnerOrgModel.findById(partnerId).select({ kind: 1, taxRegime: 1, gstin: 1 }).lean() as { kind?: string; taxRegime?: string; gstin?: string } | null;
  if (!p) throw new AppError({ status: 404, code: 'PARTNER_NOT_FOUND', message: 'Partner not found' });
  const kind = item.kind;
  const allowed = p.kind === 'clinic' ? CLINIC_KINDS : LAB_KINDS;
  if (kind && !allowed.includes(kind)) throw new AppError({ status: 400, code: 'ITEM_KIND_NOT_ALLOWED', message: `A ${p.kind} catalogue takes: ${allowed.join(', ')}` });
  // Legacy items (created before these rules) stay editable: the kind is checked only when it is being set (create or
  // an explicit conversion), never against the item's existing kind.
  if (p.kind === 'lab' && item.visitModes !== undefined && item.visitModes.length === 0) {
    throw new AppError({ status: 400, code: 'VISIT_MODES_REQUIRED', message: 'Choose home collection and/or visit the lab' });
  }
  if (p.kind === 'clinic' && item.visitModes && item.visitModes.length > 0) {
    throw new AppError({ status: 400, code: 'VISIT_MODES_NOT_ALLOWED', message: 'Clinic items have no visit modes' });
  }
  if (item.gstRate !== undefined && item.gstRate !== 0 && !(p.taxRegime === 'regular' && p.gstin)) {
    throw new AppError({ status: 400, code: 'GST_RATE_NOT_ALLOWED', message: 'Only 0% GST can be billed without a regular GST registration' });
  }
  return p;
}

/** r42 (§26.25): healthcare by a clinical establishment is exempt (SAC 9993), so a clinic's 0% consultation is by default. */
export const EXEMPT_HEALTHCARE_SAC = '9993';

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
  taxTreatment?: 'taxable' | 'exempt';
  visitModes?: ('home' | 'lab')[];
  reportTatHours?: number;
};

/** Q12: the admission scope of item-create request keys (claimed with the item; abandon makes a key unusable). */
export const catalogueKeyScope = (partnerId: string) => `partner_catalogue_create:${String(partnerId).toLowerCase()}`;
/**
 * Q12: the partner's catalogue rows whatever the case of the stored id (ids are ObjectId hex; an admin write keeps the
 * case of its URL). Every catalogue read, lookup and write filter uses it, so the item a key lookup returns can also be
 * opened, edited, deactivated and reactivated, and lists show it, from either spelling of the id.
 */
const samePartner = (partnerId: string) => {
  const pid = String(partnerId);
  return /^[0-9a-fA-F]{24}$/.test(pid) ? { $regex: `^${pid}$`, $options: 'i' } : { $eq: pid };
};
const escapeRegex = (x: string) => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** §4: the partner sets its menu and prices (live at once); admins can disable an item. Catalogue is partner-wide. */
@Service()
export class CatalogueService {
  constructor(private catalogueRepo: CatalogueItemRepository) {}

  /** Q10: exactly once per (partner, requestKey): a replay returns the item; other content under the key is refused. */
  async createItem(actor: PartnerActor, input: CatalogueItemInput & { requestKey?: string }): Promise<ICatalogueItem & { replayed?: boolean }> {
    const { requestKey, ...data } = input;
    const requestHash = requestKey ? createHash('sha256').update(canonicalJson(data)).digest('hex') : undefined;
    const replay = async () => {
      if (!requestKey) return null;
      const prior = await CatalogueItemModel.findOne({ partnerId: samePartner(actor.partnerId), createRequestKey: { $eq: requestKey, $type: 'string' } }).lean() as (ICatalogueItem & { createRequestHash?: string }) | null;
      if (!prior) return null;
      if (prior.createRequestHash !== requestHash) throw new AppError({ status: 409, code: 'REQUEST_KEY_REUSED', message: 'This request key was already used for a different item' });
      return { ...prior, replayed: true };
    };
    const prior = await replay();
    if (prior) return prior;
    try {
      return await this.createItemOnce(actor, data, requestKey, requestHash);
    } catch (e: any) {
      if (e?.code !== 11000) throw e;
      const raced = await replay();
      if (!raced) throw e;
      return raced;
    }
  }

  private async createItemOnce(actor: PartnerActor, data: CatalogueItemInput, requestKey?: string, requestHash?: string): Promise<ICatalogueItem> {
    if (data.mrpMinor !== undefined && data.mrpMinor < data.priceMinor) {
      throw new AppError({ status: 400, code: 'INVALID_MRP', message: 'MRP cannot be below the price' });
    }
    const partner = await assertItemFits(actor.partnerId, { kind: data.kind, gstRate: data.gstRate, visitModes: data.visitModes ?? [] });
    assertExemptRate(data.taxTreatment, data.gstRate);
    const exemptByDefault = partner.kind === 'clinic' && data.kind === 'consultation' && data.gstRate === 0 && data.taxTreatment === undefined;
    return inTransaction(async (session) => {
      // Q12: the key is claimed with the item, so an abandon either wins (no item can follow) or finds it used.
      if (requestKey) await claimRequestKey(catalogueKeyScope(actor.partnerId), requestKey, session);
      const item = await this.catalogueRepo.save({
        ...data,
        ...(exemptByDefault ? { taxTreatment: 'exempt', sac: data.sac ?? EXEMPT_HEALTHCARE_SAC } : {}),
        visitModes: data.visitModes ?? [],
        ...(requestKey ? { createRequestKey: requestKey, createRequestHash: requestHash } : {}),
        // Q12: new rows store the canonical (lowercase) id, so the unique (partnerId, createRequestKey) index holds one
        // item per key whatever spelling of the id the request came through (older rows are read via samePartner).
        partnerId: String(actor.partnerId).toLowerCase(),
        isActive: true,
        adminDisabled: false,
      } as Partial<ICatalogueItem>, { session });
      await recordPartnerAudit(actor, 'catalogue.create', { kind: 'catalogue_item', id: String(item._id) }, { priceMinor: data.priceMinor }, session);
      return item;
    });
  }

  async updateItem(actor: PartnerActor, itemId: string, data: Partial<CatalogueItemInput>): Promise<ICatalogueItem> {
    const before = await this.getItem(actor, itemId);
    const { kind, expectedUpdatedAt, ...rest } = data as Partial<CatalogueItemInput> & { expectedUpdatedAt?: Date };
    // Q10: a kind change is only a conversion of a legacy item into a kind this partner type takes.
    const safe: Partial<CatalogueItemInput> = { ...rest, ...(kind !== undefined && kind !== before.kind ? { kind } : {}) };
    await assertItemFits(actor.partnerId, { kind: safe.kind, gstRate: safe.gstRate, visitModes: safe.visitModes }, before);
    if (safe.kind !== undefined && await kindFits(actor.partnerId, before.kind)) {
      throw new AppError({ status: 400, code: 'KIND_FIXED', message: 'An item’s kind cannot be changed; add a new item instead' });
    }
    // The price/MRP pair is validated on the state read in this transaction attempt and written with a compare-and-set
    // on exactly that pair, so two concurrent edits can never combine into an invalid pair.
    return inTransaction(async (session) => {
      const item = await this.catalogueRepo.findOne({ _id: itemId, partnerId: samePartner(actor.partnerId) } as any, session);
      if (!item) throw notFound();
      const price = safe.priceMinor ?? item.priceMinor;
      const mrp = safe.mrpMinor ?? item.mrpMinor;
      if (mrp !== undefined && mrp !== null && mrp < price) {
        throw new AppError({ status: 400, code: 'INVALID_MRP', message: 'MRP cannot be below the price' });
      }
      // r42: checked on the item as this attempt reads it (the write below is fenced on its updatedAt).
      assertExemptRate(safe.taxTreatment ?? item.taxTreatment, safe.gstRate ?? item.gstRate);
      // A conversion is admitted on the item as THIS attempt reads it (a concurrent conversion makes it KIND_FIXED), and the
      // write below is fenced on that kind.
      if (safe.kind !== undefined && await kindFits(actor.partnerId, item.kind)) {
        throw new AppError({ status: 400, code: 'KIND_FIXED', message: 'An item’s kind cannot be changed; add a new item instead' });
      }
      if (expectedUpdatedAt && new Date(item.updatedAt as Date).getTime() !== new Date(expectedUpdatedAt).getTime()) {
        throw new AppError({ status: 409, code: 'CATALOGUE_ITEM_CHANGED', message: 'The item changed since you opened it; reload and review' });
      }
      const updated = await this.catalogueRepo.update(
        { _id: itemId, partnerId: samePartner(actor.partnerId), kind: item.kind, priceMinor: item.priceMinor, mrpMinor: item.mrpMinor ?? null, updatedAt: item.updatedAt },
        { $set: safe }, { new: true, session } as any);
      if (!updated) throw Object.assign(new AppError({ status: 409, code: 'CATALOGUE_ITEM_CHANGED', message: 'The item changed meanwhile; reload and try again' }), { retryable: true });
      await recordPartnerAudit(actor, 'catalogue.update', { kind: 'catalogue_item', id: itemId }, { fields: Object.keys(safe) }, session);
      return updated;
    });
  }

  async deactivateItem(actor: PartnerActor, itemId: string): Promise<void> {
    await this.getItem(actor, itemId);
    await inTransaction(async (session) => {
      const done = await this.catalogueRepo.update({ _id: itemId, partnerId: samePartner(actor.partnerId), isActive: true } as any, { isActive: false }, { new: true, session } as any);
      if (done) await recordPartnerAudit(actor, 'catalogue.deactivate', { kind: 'catalogue_item', id: itemId }, undefined, session);
    });
  }

  /** Q10: deactivated items too (to reactivate them) — for catalogue managers only. */
  /** Q10: a deactivated item comes back (admin-disabled stays disabled). */
  async reactivateItem(actor: PartnerActor, itemId: string): Promise<ICatalogueItem> {
    await this.getItem(actor, itemId);
    return inTransaction(async (session) => {
      const done = await this.catalogueRepo.update({ _id: itemId, partnerId: samePartner(actor.partnerId), isActive: false } as any, { isActive: true }, { new: true, session } as any);
      if (!done) throw new AppError({ status: 409, code: 'ITEM_ALREADY_ACTIVE', message: 'This item is already active' });
      await recordPartnerAudit(actor, 'catalogue.reactivate', { kind: 'catalogue_item', id: itemId }, undefined, session);
      return done;
    });
  }

  async listItems(actor: PartnerActor, kind?: CatalogueItemKind, includeInactive = false, q?: string): Promise<ICatalogueItem[]> {
    const all = includeInactive && (actor.role === 'owner' || actor.permissions.includes('catalogue.manage'));
    // Q12: optional search on name or code (case-insensitive, literal text).
    const text = q?.trim();
    const match = text ? { $or: [{ name: { $regex: escapeRegex(text), $options: 'i' } }, { code: { $regex: escapeRegex(text), $options: 'i' } }] } : {};
    return CatalogueItemModel.find({ partnerId: samePartner(actor.partnerId), ...(all ? {} : { isActive: true }), ...(kind ? { kind } : {}), ...match })
      .sort({ name: 1 }).lean() as unknown as Promise<ICatalogueItem[]>;
  }

  /** Q12: the item a create request key made in this partner, or null (not made yet, never, or abandoned). */
  async findByKey(actor: PartnerActor, key: string): Promise<ICatalogueItem | null> {
    return CatalogueItemModel.findOne({ partnerId: samePartner(actor.partnerId), createRequestKey: { $eq: key, $type: 'string' } }).lean() as unknown as Promise<ICatalogueItem | null>;
  }

  /** Q12: give up an item create whose answer was lost: abandoned (it can never be made) or used (here is the item). */
  async abandonKey(actor: PartnerActor, key: string): Promise<{ state: 'abandoned' | 'used'; item?: ICatalogueItem | null }> {
    // An item made under this key before claims existed (no claim row) is used, never abandoned.
    const made = await this.findByKey(actor, key);
    if (made) return { state: 'used', item: made };
    const state = await abandonRequestKey(catalogueKeyScope(actor.partnerId), key);
    return state === 'abandoned' ? { state } : { state, item: await this.findByKey(actor, key) };
  }

  async getItem(actor: PartnerActor, itemId: string): Promise<ICatalogueItem> {
    const item = await this.catalogueRepo.findById(itemId);
    if (!item || String(item.partnerId).toLowerCase() !== String(actor.partnerId).toLowerCase()) throw notFound();
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
