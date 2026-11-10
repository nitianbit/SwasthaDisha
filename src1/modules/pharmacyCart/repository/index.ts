import { Service } from 'typedi';
import { Model } from 'mongoose';
import PharmacyCartModel from '@/modules/pharmacyCart/model';
import { IPharmacyCart, PharmacyCartActorRole } from '@/modules/pharmacyCart/types';
import { BaseRepository } from '@/modules/common/repository';

@Service()
export class PharmacyCartRepository extends BaseRepository<IPharmacyCart> {
  constructor() {
    super(PharmacyCartModel as Model<IPharmacyCart>);
  }

  async findByActor(
    actorId: string,
    actorRole: PharmacyCartActorRole
  ): Promise<IPharmacyCart | null> {
    return this.findOne({ actorId, actorRole });
  }

  // Optimistic-concurrency update: only writes if the cart has not changed
  // since it was read. Returns null when another request modified it first.
  async updateIfUnchanged(
    cart: IPharmacyCart,
    data: Pick<IPharmacyCart, 'pharmacyId' | 'items' | 'subtotal'>
  ): Promise<IPharmacyCart | null> {
    return PharmacyCartModel.findOneAndUpdate(
      { _id: cart._id, updatedAt: cart.updatedAt },
      { $set: data },
      { new: true }
    ).lean();
  }

  async deleteIfUnchanged(cart: IPharmacyCart): Promise<boolean> {
    const result = await PharmacyCartModel.deleteOne({
      _id: cart._id,
      updatedAt: cart.updatedAt,
    });
    return result.deletedCount === 1;
  }
}
