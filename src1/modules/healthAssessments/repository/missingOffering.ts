import { Service } from 'typedi';
import { Model } from 'mongoose';
import { BaseRepository } from '@/modules/common/repository';
import MissingOfferingModel from '@/modules/healthAssessments/model/missingOffering';
import {
  IMissingOffering,
  MissingOfferingKind,
  HealthRiskCategory,
} from '@/modules/healthAssessments/types';

@Service()
export class MissingOfferingRepository extends BaseRepository<IMissingOffering> {
  constructor() {
    super(MissingOfferingModel as Model<IMissingOffering>);
  }

  async incrementSuggestion(input: {
    kind: MissingOfferingKind;
    riskCategory: HealthRiskCategory;
    desiredLabel: string;
    reasons: string[];
    userId?: string;
  }): Promise<IMissingOffering | null> {
    return this.update(
      {
        kind: input.kind,
        riskCategory: input.riskCategory,
        desiredLabel: input.desiredLabel,
      },
      {
        $setOnInsert: {
          firstSuggestedAt: new Date(),
        },
        $set: {
          lastSuggestedAt: new Date(),
          lastTriggeredByUserId: input.userId,
          reasons: input.reasons,
        },
        $inc: {
          occurrenceCount: 1,
        },
      } as any,
      { new: true, upsert: true }
    );
  }
}
