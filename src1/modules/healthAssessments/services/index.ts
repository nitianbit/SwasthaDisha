import { Service } from 'typedi';
import { AppError } from '@/modules/common/types';
import { UserRepository } from '@/modules/user/repository';
import { LabstackService, LabstackDiagnosticsSlot, LabstackSlot } from '@/modules/bookings/services/labstack';
import { ExternalBookingService } from '@/modules/externalBookings/services';
import { HealthAssessmentRepository } from '@/modules/healthAssessments/repository';
import { MissingOfferingRepository } from '@/modules/healthAssessments/repository/missingOffering';
import {
  HealthAssessmentComputedMetrics,
  HealthAssessmentPackageRecommendation,
  HealthAssessmentQuestionnaire,
  HealthAssessmentSpecialistRecommendation,
  HealthRiskCategory,
  HealthRiskLevel,
  HealthRiskResult,
  IMissingOffering,
  IHealthAssessment,
  MissingOfferingSummary,
  RecommendationUrgency,
  SubmitHealthAssessmentRequest,
} from '@/modules/healthAssessments/types';

type ScoreAccumulator = Record<HealthRiskCategory, { score: number; reasons: string[] }>;

type AssessmentActor = {
  _id: string;
  userType: string;
  corporateId?: string;
};

type ExternalPackageCandidate = {
  id: string;
  name: string;
  category?: string;
  price?: number;
  raw: Record<string, unknown>;
  detailRaw?: Record<string, unknown>;
  score: number;
  matchedCategories: HealthRiskCategory[];
};

const ASSESSMENT_VERSION = '2.0';

const CATEGORY_SPECIALIZATION_MAP: Record<HealthRiskCategory, string[]> = {
  diabetes: ['Endocrinologist', 'Diabetologist', 'General Physician'],
  cardiac: ['Cardiologist', 'General Physician'],
  thyroid: ['Endocrinologist', 'General Physician'],
  women_health: ['Gynecologist', 'Obstetrician', 'Endocrinologist'],
  respiratory: ['Pulmonologist', 'Chest Physician', 'General Physician'],
  liver: ['Gastroenterologist', 'Hepatologist', 'General Physician'],
  kidney: ['Nephrologist', 'General Physician'],
  general_wellness: ['General Physician'],
};

const CATEGORY_PACKAGE_KEYWORDS: Record<HealthRiskCategory, string[]> = {
  diabetes: ['diabetes', 'sugar', 'glucose', 'hba1c', 'insulin', 'fasting sugar', 'pp sugar'],
  cardiac: ['cardiac', 'heart', 'cholesterol', 'lipid', 'ecg', 'troponin', 'blood pressure'],
  thyroid: ['thyroid', 'tsh', 't3', 't4'],
  women_health: ['women', 'gyn', 'gynaec', 'pcos', 'hormone', 'fertility', 'pregnancy'],
  respiratory: ['respiratory', 'lung', 'pulmonary', 'asthma', 'spo2'],
  liver: ['liver', 'hepatic', 'sgpt', 'sgot', 'bilirubin'],
  kidney: ['kidney', 'renal', 'creatinine', 'urea', 'uric acid'],
  general_wellness: ['preventive', 'wellness', 'screening', 'full body', 'health check', 'executive'],
};

const CATEGORY_PACKAGE_FALLBACK_LABEL: Record<HealthRiskCategory, string> = {
  diabetes: 'Diabetes screening package',
  cardiac: 'Cardiac risk screening package',
  thyroid: 'Thyroid profile package',
  women_health: 'Women health screening package',
  respiratory: 'Respiratory screening package',
  liver: 'Liver function screening package',
  kidney: 'Kidney function screening package',
  general_wellness: 'Preventive wellness screening package',
};

@Service()
export class HealthAssessmentService {
  constructor(
    private healthAssessmentRepository: HealthAssessmentRepository,
    private missingOfferingRepository: MissingOfferingRepository,
    private userRepository: UserRepository,
    private externalBookingService: ExternalBookingService,
    private labstackService: LabstackService
  ) {}

  getQuestionnaire(): HealthAssessmentQuestionnaire {
    return {
      version: ASSESSMENT_VERSION,
      sections: [
        {
          id: 'profile',
          title: 'Basic Profile',
          fields: [
            { key: 'profile.age', label: 'Age', type: 'number' },
            { key: 'profile.gender', label: 'Gender', type: 'text' },
            { key: 'profile.heightCm', label: 'Height in cm', type: 'number' },
            { key: 'profile.weightKg', label: 'Weight in kg', type: 'number' },
            { key: 'profile.city', label: 'City', type: 'text' },
            { key: 'profile.state', label: 'State', type: 'text' },
            { key: 'profile.pincode', label: 'Pincode', type: 'text' },
          ],
        },
        {
          id: 'lifestyle',
          title: 'Everyday Habits',
          fields: [
            {
              key: 'lifestyle.smoking',
              label: 'How often do you smoke or vape?',
              type: 'scale',
              helperText: '0 = never, 5 = very often',
            },
            {
              key: 'lifestyle.alcohol',
              label: 'How often do you drink alcohol?',
              type: 'scale',
              helperText: '0 = never, 5 = very often',
            },
            { key: 'lifestyle.exerciseDaysPerWeek', label: 'Exercise days per week', type: 'number' },
            { key: 'lifestyle.sleepHours', label: 'Sleep hours per day', type: 'number' },
            {
              key: 'lifestyle.stressLevel',
              label: 'How stressed have you felt lately?',
              type: 'scale',
              helperText: '0 = very calm, 5 = very stressed',
            },
          ],
        },
        {
          id: 'history',
          title: 'Medical and Family History',
          fields: [
            { key: 'medicalHistory.diabetes', label: 'History of diabetes', type: 'boolean' },
            { key: 'medicalHistory.hypertension', label: 'History of hypertension', type: 'boolean' },
            { key: 'medicalHistory.thyroidDisorder', label: 'History of thyroid disorder', type: 'boolean' },
            { key: 'medicalHistory.heartDisease', label: 'History of heart disease', type: 'boolean' },
            { key: 'medicalHistory.kidneyDisease', label: 'History of kidney disease', type: 'boolean' },
            { key: 'medicalHistory.liverDisease', label: 'History of liver disease', type: 'boolean' },
            { key: 'familyHistory.diabetes', label: 'Family history of diabetes', type: 'boolean' },
            { key: 'familyHistory.heartDisease', label: 'Family history of heart disease', type: 'boolean' },
          ],
        },
        {
          id: 'symptoms',
          title: 'How You Have Been Feeling',
          fields: [
            { key: 'symptoms.fatigue', label: 'Low energy or tiredness', type: 'scale', helperText: '0 = not at all, 5 = very often' },
            { key: 'symptoms.frequentUrination', label: 'Frequent urination', type: 'scale', helperText: '0 = not at all, 5 = very often' },
            { key: 'symptoms.excessiveThirst', label: 'Excessive thirst', type: 'scale', helperText: '0 = not at all, 5 = very often' },
            { key: 'symptoms.chestPain', label: 'Chest discomfort', type: 'scale', helperText: '0 = not at all, 5 = very often' },
            { key: 'symptoms.breathlessness', label: 'Shortness of breath', type: 'scale', helperText: '0 = not at all, 5 = very often' },
            { key: 'symptoms.irregularPeriods', label: 'Irregular periods', type: 'scale', helperText: '0 = not at all, 5 = very often' },
            { key: 'symptoms.hairFall', label: 'Hair fall', type: 'scale', helperText: '0 = not at all, 5 = very often' },
          ],
        },
        {
          id: 'vitals',
          title: 'Recent Vitals or Lab Values',
          fields: [
            { key: 'vitals.systolicBp', label: 'Systolic BP', type: 'number' },
            { key: 'vitals.diastolicBp', label: 'Diastolic BP', type: 'number' },
            { key: 'vitals.fastingSugar', label: 'Fasting sugar', type: 'number' },
            { key: 'vitals.hba1c', label: 'HbA1c', type: 'number' },
            { key: 'vitals.spo2', label: 'SpO2', type: 'number' },
          ],
        },
      ],
    };
  }

  async submitAssessment(
    user: AssessmentActor,
    data: SubmitHealthAssessmentRequest
  ): Promise<IHealthAssessment> {
    const userRecord = await this.userRepository.findById(user._id);
    if (!userRecord) {
      throw new AppError({
        status: 404,
        code: 'USER_NOT_FOUND',
        message: 'User not found',
      });
    }

    const profileSnapshot = this.buildProfileSnapshot(userRecord, data);
    const computedMetrics = this.computeMetrics(profileSnapshot);
    const risks = this.calculateRisks(data, computedMetrics);
    const overallRiskLevel = this.getOverallRiskLevel(risks);

    const saved = await this.healthAssessmentRepository.save({
      userId: user._id,
      dependentId: data.dependentId,
      assessmentVersion: ASSESSMENT_VERSION,
      profileSnapshot,
      answers: {
        lifestyle: data.lifestyle || {},
        medicalHistory: data.medicalHistory || {},
        familyHistory: data.familyHistory || {},
        symptoms: data.symptoms || {},
        vitals: data.vitals || {},
        concerns: data.concerns || [],
        goals: data.goals || [],
        notes: data.notes,
      },
      computedMetrics,
      risks,
      overallRiskLevel,
      recommendations: {
        urgency: 'routine',
        headline: '',
        summary: '',
        focusAreas: [],
        primaryCategories: [],
        packageRecommendations: [],
        specialistRecommendations: [],
        missingOfferings: [],
        nextSteps: [],
        disclaimers: [],
      },
    });

    const recommendations = await this.buildRecommendations(
      risks,
      profileSnapshot.pincode,
      saved.userId,
      saved._id
    );

    const updated = await this.healthAssessmentRepository.update(
      { _id: saved._id },
      {
        recommendations,
      }
    );

    if (!updated) {
      throw new AppError({
        status: 500,
        code: 'HEALTH_ASSESSMENT_UPDATE_FAILED',
        message: 'Failed to persist recommendations',
      });
    }

    return updated;
  }

  async getMyAssessments(
    userId: string,
    filter: { page?: number; limit?: number } = {}
  ): Promise<{
    data: IHealthAssessment[];
    total?: number;
    page?: number;
    totalPages?: number;
  }> {
    return this.healthAssessmentRepository.findByUserId(userId, filter);
  }

  async getAssessmentById(userId: string, id: string): Promise<IHealthAssessment> {
    const assessment = await this.healthAssessmentRepository.findById(id);
    if (!assessment || assessment.userId !== userId) {
      throw new AppError({
        status: 404,
        code: 'HEALTH_ASSESSMENT_NOT_FOUND',
        message: 'Health assessment not found',
      });
    }

    return assessment;
  }

  async getMissingOfferings(): Promise<IMissingOffering[]> {
    return this.missingOfferingRepository.findAll(
      {},
      { sort: { occurrenceCount: -1, lastSuggestedAt: -1 } }
    );
  }

  private buildProfileSnapshot(userRecord: any, data: SubmitHealthAssessmentRequest) {
    return {
      age: data.profile?.age ?? this.getAgeFromDob(userRecord.dateOfBirth),
      gender: data.profile?.gender ?? userRecord.gender,
      heightCm: data.profile?.heightCm ?? userRecord.height,
      weightKg: data.profile?.weightKg ?? userRecord.weight,
      city: data.profile?.city ?? userRecord.city,
      state: data.profile?.state ?? userRecord.state,
      pincode: data.profile?.pincode ?? userRecord.pincode,
    };
  }

  private computeMetrics(profileSnapshot: {
    age?: number;
    heightCm?: number;
    weightKg?: number;
  }): HealthAssessmentComputedMetrics {
    const metrics: HealthAssessmentComputedMetrics = {
      age: profileSnapshot.age,
    };

    if (profileSnapshot.heightCm && profileSnapshot.weightKg) {
      const heightInMetres = profileSnapshot.heightCm / 100;
      if (heightInMetres > 0) {
        metrics.bmi = Number(
          (profileSnapshot.weightKg / (heightInMetres * heightInMetres)).toFixed(1)
        );
      }
    }

    return metrics;
  }

  private calculateRisks(
    data: SubmitHealthAssessmentRequest,
    metrics: HealthAssessmentComputedMetrics
  ): HealthRiskResult[] {
    const scores: ScoreAccumulator = {
      diabetes: { score: 0, reasons: [] },
      cardiac: { score: 0, reasons: [] },
      thyroid: { score: 0, reasons: [] },
      women_health: { score: 0, reasons: [] },
      respiratory: { score: 0, reasons: [] },
      liver: { score: 0, reasons: [] },
      kidney: { score: 0, reasons: [] },
      general_wellness: { score: 0, reasons: [] },
    };

    const addScore = (category: HealthRiskCategory, points: number, reason: string) => {
      scores[category].score += points;
      if (!scores[category].reasons.includes(reason)) {
        scores[category].reasons.push(reason);
      }
    };

    const age = metrics.age;
    const bmi = metrics.bmi;
    const lifestyle = data.lifestyle || {};
    const history = data.medicalHistory || {};
    const family = data.familyHistory || {};
    const symptoms = data.symptoms || {};
    const vitals = data.vitals || {};
    const gender = data.profile?.gender;
    const symptomLevel = (value?: boolean | number) => this.toScale(value);
    const moderateOrMore = (value?: boolean | number) => symptomLevel(value) >= 3;
    const high = (value?: boolean | number) => symptomLevel(value) >= 4;

    addScore('general_wellness', 1, 'A general wellness check-in was completed');

    if (age !== undefined && age >= 40) {
      addScore('general_wellness', 2, 'Age is 40 or above');
      addScore('diabetes', 1, 'Age increases metabolic risk');
      addScore('cardiac', 1, 'Age increases cardiac screening need');
    }

    if (bmi !== undefined) {
      if (bmi >= 25) {
        addScore('general_wellness', 1, 'Weight and height suggest some room to improve overall fitness');
        addScore('diabetes', 2, 'Body weight may be worth keeping an eye on for sugar health');
        addScore('cardiac', 2, 'Body weight may be worth keeping an eye on for heart health');
      }
      if (bmi >= 30) {
        addScore('diabetes', 2, 'Current body weight suggests extra support may be helpful');
        addScore('cardiac', 2, 'Current body weight suggests extra support may be helpful');
      }
    }

    if (history.diabetes) addScore('diabetes', 4, 'You shared a history of diabetes');
    if (family.diabetes) addScore('diabetes', 2, 'There is a family history of diabetes');
    if (moderateOrMore(symptoms.frequentUrination)) addScore('diabetes', high(symptoms.frequentUrination) ? 2 : 1, 'Frequent urination may be worth checking further');
    if (moderateOrMore(symptoms.excessiveThirst)) addScore('diabetes', high(symptoms.excessiveThirst) ? 2 : 1, 'Increased thirst may be worth checking further');
    if (moderateOrMore(symptoms.fatigue)) addScore('diabetes', 1, 'Lower energy can sometimes go along with sugar imbalance');
    if (vitals.fastingSugar !== undefined && vitals.fastingSugar >= 100) {
      addScore('diabetes', vitals.fastingSugar >= 126 ? 4 : 2, 'Recent fasting sugar reading looks higher than ideal');
    }
    if (vitals.hba1c !== undefined && vitals.hba1c >= 5.7) {
      addScore('diabetes', vitals.hba1c >= 6.5 ? 4 : 2, 'Recent HbA1c reading looks higher than ideal');
    }

    if (history.hypertension) addScore('cardiac', 3, 'You shared a history of high blood pressure');
    if (history.heartDisease) addScore('cardiac', 4, 'You shared a history of heart-related care');
    if (family.heartDisease) addScore('cardiac', 2, 'There is a family history of heart disease');
    if (family.stroke) addScore('cardiac', 2, 'There is a family history of stroke');
    if (moderateOrMore(symptoms.chestPain)) addScore('cardiac', high(symptoms.chestPain) ? 5 : 3, 'Chest discomfort deserves a closer look');
    if (moderateOrMore(symptoms.breathlessness)) addScore('cardiac', high(symptoms.breathlessness) ? 3 : 2, 'Shortness of breath may be worth discussing with a doctor');
    if (vitals.systolicBp !== undefined && vitals.systolicBp >= 140) {
      addScore('cardiac', 3, 'Recent blood pressure reading looks above the ideal range');
    }
    if (vitals.diastolicBp !== undefined && vitals.diastolicBp >= 90) {
      addScore('cardiac', 2, 'Recent blood pressure reading looks above the ideal range');
    }

    if (history.thyroidDisorder) addScore('thyroid', 4, 'You shared a history of thyroid imbalance');
    if (family.thyroid) addScore('thyroid', 2, 'There is a family history of thyroid imbalance');
    if (moderateOrMore(symptoms.hairFall)) addScore('thyroid', high(symptoms.hairFall) ? 2 : 1, 'Hair fall may be worth reviewing alongside thyroid health');
    if (moderateOrMore(symptoms.constipation)) addScore('thyroid', high(symptoms.constipation) ? 2 : 1, 'Digestion slowdown can sometimes overlap with thyroid concerns');
    if (moderateOrMore(symptoms.unexplainedWeightGain) || moderateOrMore(symptoms.unexplainedWeightLoss)) {
      addScore('thyroid', 2, 'Recent weight changes may be worth checking further');
    }

    if (gender === 'Female' || history.pcos || history.pregnancy) {
      addScore('women_health', 1, 'Women health screening may be relevant here');
    }
    if (history.pcos) addScore('women_health', 4, 'You shared a history of PCOS');
    if (history.pregnancy) addScore('women_health', 3, 'Pregnancy-related support may be relevant');
    if (moderateOrMore(symptoms.irregularPeriods)) addScore('women_health', high(symptoms.irregularPeriods) ? 3 : 2, 'Cycle irregularity may be worth reviewing');
    if (moderateOrMore(symptoms.heavyBleeding)) addScore('women_health', high(symptoms.heavyBleeding) ? 3 : 2, 'Heavy bleeding may be worth reviewing');

    if (history.asthmaOrCopd) addScore('respiratory', 4, 'You shared a history of breathing-related care');
    if (this.toScale(lifestyle.smoking) >= 3) addScore('respiratory', this.toScale(lifestyle.smoking) >= 4 ? 3 : 2, 'Smoking or vaping may be affecting breathing health');
    if (moderateOrMore(symptoms.breathlessness)) addScore('respiratory', high(symptoms.breathlessness) ? 4 : 2, 'Shortness of breath may be worth a closer review');
    if (vitals.spo2 !== undefined && vitals.spo2 < 95) {
      addScore('respiratory', vitals.spo2 < 92 ? 5 : 3, 'Recent oxygen saturation looks lower than ideal');
    }

    if (history.liverDisease) addScore('liver', 4, 'You shared a history of liver-related care');
    if (this.toScale(lifestyle.alcohol) >= 3) addScore('liver', this.toScale(lifestyle.alcohol) >= 4 ? 2 : 1, 'Alcohol intake may be worth keeping in mind for liver health');
    if (moderateOrMore(symptoms.digestiveIssues)) addScore('liver', high(symptoms.digestiveIssues) ? 2 : 1, 'Digestive discomfort may be worth reviewing further');

    if (history.kidneyDisease) addScore('kidney', 4, 'You shared a history of kidney-related care');
    if (family.kidneyDisease) addScore('kidney', 2, 'There is a family history of kidney disease');
    if (moderateOrMore(symptoms.swelling)) addScore('kidney', high(symptoms.swelling) ? 3 : 2, 'Swelling may be worth checking further');
    if (history.hypertension || history.diabetes) {
      addScore('kidney', 1, 'Blood pressure or sugar history can affect kidney health over time');
    }

    if ((lifestyle.exerciseDaysPerWeek ?? 0) < 3) addScore('general_wellness', 2, 'A little more regular movement may be helpful');
    if ((lifestyle.sleepHours ?? 8) < 6) addScore('general_wellness', 2, 'Sleep quantity looks lower than ideal');
    if ((lifestyle.stressLevel ?? 0) >= 4) addScore('general_wellness', lifestyle.stressLevel === 5 ? 2 : 1, 'Stress seems to be running a bit high lately');

    return (Object.keys(scores) as HealthRiskCategory[])
      .map((category) => ({
        category,
        score: scores[category].score,
        level: this.getRiskLevel(scores[category].score),
        reasons: scores[category].reasons,
      }))
      .filter((risk) => risk.score > 0)
      .sort((a, b) => b.score - a.score);
  }

  private getRiskLevel(score: number): HealthRiskLevel {
    if (score >= 10) return 'high';
    if (score >= 5) return 'moderate';
    return 'low';
  }

  private getOverallRiskLevel(risks: HealthRiskResult[]): HealthRiskLevel {
    if (risks.some((risk) => risk.level === 'high')) return 'high';
    if (risks.some((risk) => risk.level === 'moderate')) return 'moderate';
    return 'low';
  }

  private async buildRecommendations(
    risks: HealthRiskResult[],
    pincode: string | undefined,
    userId: string,
    assessmentId?: string
  ) {
    const urgency = this.getUrgency(risks);
    const primaryCategories = risks.slice(0, 3).map((risk) => risk.category);

    const [packageRecommendations, specialistRecommendations] = await Promise.all([
      this.buildExternalPackageRecommendations(risks, pincode),
      this.buildExternalDoctorRecommendations(risks, pincode),
    ]);

    await this.captureMissingOfferings(
      risks,
      packageRecommendations,
      specialistRecommendations,
      userId
    );

    return {
      urgency,
      headline: this.getHeadline(urgency),
      summary: this.getSummary(risks),
      focusAreas: this.getFocusAreas(risks),
      primaryCategories,
      packageRecommendations,
      specialistRecommendations,
      missingOfferings: [],
      nextSteps: this.getNextSteps(urgency, risks, pincode),
      disclaimers: [
        'This check-in is meant to guide next steps and is not a diagnosis.',
        'Recommendations are based on live partner availability at the time of assessment.',
        'If you have severe symptoms or feel suddenly worse, please seek urgent medical care.',
      ],
      meta: {
        assessmentId,
      },
    };
  }

  private async buildExternalPackageRecommendations(
    risks: HealthRiskResult[],
    pincode?: string
  ): Promise<HealthAssessmentPackageRecommendation[]> {
    const externalPackages = await this.labstackService.getPackages();
    const candidates = externalPackages.packages.map((item) => this.mapExternalPackageCandidate(item, risks));
    const topCandidates = candidates
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, 8);

    const enriched = await Promise.all(
      topCandidates.map(async (candidate) => {
        try {
          const detail = await this.labstackService.getPackageById(candidate.id);
          const detailRaw = detail.packageItem || ((detail.raw || {}) as Record<string, unknown>);
          return {
            ...candidate,
            detailRaw,
            score: candidate.score + this.scorePackageText(detailRaw, risks).score,
          };
        } catch (_error) {
          return candidate;
        }
      })
    );

    const finalRanked = enriched
      .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
      .slice(0, 4);

    const results = await Promise.all(
      finalRanked.map(async (candidate) => {
        const availability = pincode
          ? await this.findPackageAvailabilityWithin24Hours(candidate.id, pincode)
          : undefined;

        return {
          source: 'external' as const,
          packageId: candidate.id,
          name: candidate.name,
          category: candidate.category,
          discountedPrice: candidate.price,
          originalPrice: candidate.price,
          availableInNext24Hours: Boolean(availability),
          nextAvailableSlot: availability,
          reason: `Matched ${candidate.matchedCategories.map((item) => this.humanizeCategory(item)).join(', ') || 'screening'} risk profile`,
          score: candidate.score + (availability ? 2 : 0),
        };
      })
    );

    return results
      .sort((a, b) => {
        if (a.availableInNext24Hours !== b.availableInNext24Hours) {
          return Number(b.availableInNext24Hours) - Number(a.availableInNext24Hours);
        }
        return b.score - a.score || a.name.localeCompare(b.name);
      })
      .slice(0, 3);
  }

  private async buildExternalDoctorRecommendations(
    risks: HealthRiskResult[],
    pincode?: string
  ): Promise<HealthAssessmentSpecialistRecommendation[]> {
    const topRisks = risks.filter((risk) => risk.level !== 'low').slice(0, 3);
    const results: HealthAssessmentSpecialistRecommendation[] = [];

    for (const risk of topRisks) {
      const targetSpecializations = CATEGORY_SPECIALIZATION_MAP[risk.category] || [];
      const specialists = await this.fetchSpecialistsForRisk(targetSpecializations, pincode);

      const providerSummaries = await Promise.all(
        specialists.slice(0, 6).map(async (specialist) => {
          const availability = await this.findDoctorAvailabilityWithin24Hours(
            specialist.id,
            pincode
          );

          return {
            source: 'external' as const,
            specialistId: specialist.id,
            name: specialist.name,
            specialization: specialist.specialization || targetSpecializations[0] || 'General Physician',
            rating: specialist.rating,
            consultationFee: specialist.fee,
            isConsultationFree: specialist.fee === 0,
            experienceYears: specialist.experienceYears,
            availableInNext24Hours: Boolean(availability),
            nextAvailableSlot: availability,
          };
        })
      );

      const ranked = providerSummaries
        .sort((a, b) => {
          if (a.availableInNext24Hours !== b.availableInNext24Hours) {
            return Number(b.availableInNext24Hours) - Number(a.availableInNext24Hours);
          }
          return (b.rating || 0) - (a.rating || 0) || (b.experienceYears || 0) - (a.experienceYears || 0);
        })
        .slice(0, 3);

      if (ranked.length > 0) {
        results.push({
          specialization: targetSpecializations[0] || 'General Physician',
          reason: `Live external providers matched for ${this.humanizeCategory(risk.category)} risk`,
          specialists: ranked,
        });
      }
    }

    return results;
  }

  private async captureMissingOfferings(
    risks: HealthRiskResult[],
    packageRecommendations: HealthAssessmentPackageRecommendation[],
    specialistRecommendations: HealthAssessmentSpecialistRecommendation[],
    userId: string
  ): Promise<MissingOfferingSummary[]> {
    const summaries: MissingOfferingSummary[] = [];

    for (const risk of risks.filter((item) => item.level !== 'low').slice(0, 3)) {
      const hasPackage = packageRecommendations.some(
        (item) => (item.score > 0) && item.reason.toLowerCase().includes(this.humanizeCategory(risk.category).toLowerCase().split(' ')[0])
      );

      if (!hasPackage) {
        const desiredLabel = CATEGORY_PACKAGE_FALLBACK_LABEL[risk.category];
        await this.missingOfferingRepository.incrementSuggestion({
          kind: 'package',
          riskCategory: risk.category,
          desiredLabel,
          reasons: risk.reasons,
          userId,
        });
        summaries.push({
          kind: 'package',
          riskCategory: risk.category,
          desiredLabel,
          reasons: risk.reasons,
        });
      }

      const desiredSpecialization = (CATEGORY_SPECIALIZATION_MAP[risk.category] || [])[0];
      const hasDoctor = specialistRecommendations.some(
        (item) => item.specialization.toLowerCase() === (desiredSpecialization || '').toLowerCase()
      );

      if (!hasDoctor && desiredSpecialization) {
        await this.missingOfferingRepository.incrementSuggestion({
          kind: 'doctor',
          riskCategory: risk.category,
          desiredLabel: desiredSpecialization,
          reasons: risk.reasons,
          userId,
        });
        summaries.push({
          kind: 'doctor',
          riskCategory: risk.category,
          desiredLabel: desiredSpecialization,
          reasons: risk.reasons,
        });
      }
    }

    return summaries;
  }

  private async fetchSpecialistsForRisk(
    specializations: string[],
    pincode?: string
  ): Promise<any[]> {
    const results = await Promise.all(
      specializations.map(async (speciality) => {
        try {
          return await this.externalBookingService.getSpecialists({
            providerType: 'DOCTOR',
            appointmentType: 'ONLINE',
            speciality,
            pincode,
          });
        } catch (_error) {
          return [];
        }
      })
    );

    const flattened = results.flat();
    const seen = new Set<string>();
    return flattened.filter((item) => {
      if (!item.id || seen.has(item.id)) return false;
      seen.add(item.id);
      return true;
    });
  }

  private mapExternalPackageCandidate(
    source: Record<string, unknown>,
    risks: HealthRiskResult[]
  ): ExternalPackageCandidate {
    const id = this.getFirstString(source, ['lsPackageId', 'packageId', 'id', 'code', 'packageCode']) || 'unknown';
    const name = this.getFirstString(source, ['packageName', 'name', 'title', 'displayName']) || 'Package';
    const category = this.getFirstString(source, ['category', 'categoryName', 'type']);
    const price = this.getFirstNumber(source, ['offerPrice', 'discountedPrice', 'price', 'mrp', 'amount']);
    const scoreResult = this.scorePackageText(source, risks);

    return {
      id,
      name,
      category,
      price,
      raw: source,
      score: scoreResult.score,
      matchedCategories: scoreResult.matchedCategories,
    };
  }

  private scorePackageText(
    source: Record<string, unknown>,
    risks: HealthRiskResult[]
  ): { score: number; matchedCategories: HealthRiskCategory[] } {
    const haystack = this.flattenObjectText(source).toLowerCase();
    let score = 0;
    const matchedCategories = new Set<HealthRiskCategory>();

    for (const risk of risks) {
      const keywords = CATEGORY_PACKAGE_KEYWORDS[risk.category] || [];
      const matches = keywords.filter((keyword) => haystack.includes(keyword.toLowerCase())).length;
      if (matches > 0) {
        matchedCategories.add(risk.category);
        score += matches * (risk.level === 'high' ? 4 : risk.level === 'moderate' ? 3 : 1);
      }
    }

    return {
      score,
      matchedCategories: Array.from(matchedCategories),
    };
  }

  private async findPackageAvailabilityWithin24Hours(
    packageId: string,
    pincode: string
  ): Promise<
    | {
        bookingDate: string;
        bookingTime: string;
        labId?: string;
        externalProviderId?: string;
      }
    | undefined
  > {
    const slots = await this.getDiagnosticsSlotsForNext24Hours(packageId, pincode);
    const earliest = this.findEarliestDiagnosticSlot(slots);
    if (!earliest) return undefined;

    return {
      bookingDate: earliest.date,
      bookingTime: earliest.startTime24h,
      labId: earliest.labId,
      externalProviderId: earliest.externalProviderId,
    };
  }

  private async findDoctorAvailabilityWithin24Hours(
    externalProviderId: string,
    pincode?: string
  ): Promise<
    | {
        bookingDate: string;
        bookingTime: string;
        appointmentType: string;
        externalProviderId: string;
      }
    | undefined
  > {
    const appointments: Array<{ appointmentType: string; slot: LabstackSlot }> = [];

    for (const appointmentType of ['ONLINE', 'CENTER_VISIT']) {
      const dates = this.getNext24HourDates();
      const responses = await Promise.all(
        dates.map(async (bookingDate) => {
          try {
            const result = await this.labstackService.getGenericSlots({
              providerType: 'DOCTOR',
              appointmentType,
              externalProviderId,
              bookingDate,
              pincode,
            });
            return result.slots;
          } catch (_error) {
            return [];
          }
        })
      );

      responses.flat().forEach((slot) => {
        if (this.isWithinNext24Hours(slot.date, slot.startTime24h)) {
          appointments.push({
            appointmentType,
            slot,
          });
        }
      });
    }

    const earliest = appointments.sort((a, b) => {
      const aDate = this.toDateTime(a.slot.date, a.slot.startTime24h).getTime();
      const bDate = this.toDateTime(b.slot.date, b.slot.startTime24h).getTime();
      return aDate - bDate;
    })[0];

    if (!earliest) return undefined;

    return {
      bookingDate: earliest.slot.date,
      bookingTime: earliest.slot.startTime24h,
      appointmentType: earliest.appointmentType,
      externalProviderId,
    };
  }

  private async getDiagnosticsSlotsForNext24Hours(
    packageId: string,
    pincode: string
  ): Promise<LabstackDiagnosticsSlot[]> {
    const dates = this.getNext24HourDates();
    const responses = await Promise.all(
      dates.map(async (bookingDate) => {
        try {
          const result = await this.labstackService.getDiagnosticsSlots({
            bookingDate,
            pincode,
            packageIds: [packageId],
          });
          return result.slots;
        } catch (_error) {
          return [];
        }
      })
    );

    return responses.flat().filter((slot) =>
      this.isWithinNext24Hours(slot.date, slot.startTime24h)
    );
  }

  private findEarliestDiagnosticSlot(
    slots: LabstackDiagnosticsSlot[]
  ): LabstackDiagnosticsSlot | undefined {
    return slots.sort((a, b) => {
      const aDate = this.toDateTime(a.date, a.startTime24h).getTime();
      const bDate = this.toDateTime(b.date, b.startTime24h).getTime();
      return aDate - bDate;
    })[0];
  }

  private getUrgency(risks: HealthRiskResult[]): RecommendationUrgency {
    const severeCardiac = risks.some(
      (risk) => risk.category === 'cardiac' && risk.level === 'high'
    );
    const severeResp = risks.some(
      (risk) => risk.category === 'respiratory' && risk.level === 'high'
    );
    if (severeCardiac || severeResp) {
      return 'urgent';
    }

    if (risks.some((risk) => risk.level === 'high')) {
      return 'priority';
    }

    return 'routine';
  }

  private getNextSteps(
    urgency: RecommendationUrgency,
    risks: HealthRiskResult[],
    pincode?: string
  ): string[] {
    const steps: string[] = [];

    if (urgency === 'urgent') {
      steps.push('Seek immediate medical attention or the earliest available doctor consultation.');
    } else if (urgency === 'priority') {
      steps.push('A doctor visit or screening in the next few days would be a good idea.');
    } else {
      steps.push('A preventive health package would be a practical next step.');
    }

    steps.push('If something is available in the next 24 hours, you can choose that for faster action.');
    if (!pincode) {
      steps.push('Adding your pincode can improve availability and slot suggestions.');
    }
    if (risks.some((risk) => risk.category === 'diabetes')) {
      steps.push('If you have recent sugar or HbA1c reports, keep them handy for a doctor visit.');
    }

    return steps;
  }

  private getHeadline(urgency: RecommendationUrgency): string {
    if (urgency === 'urgent') {
      return 'A closer medical review would be helpful soon';
    }
    if (urgency === 'priority') {
      return 'A health check in the next few days would be a good idea';
    }
    return 'A simple preventive health check looks like a good next step';
  }

  private getSummary(risks: HealthRiskResult[]): string {
    const moderateOrHigh = risks.filter((risk) => risk.level !== 'low');
    if (moderateOrHigh.length === 0) {
      return 'Your responses do not point to any major concerns right now. A routine wellness check can still be helpful.';
    }

    const topCategories = moderateOrHigh
      .slice(0, 2)
      .map((risk) => this.humanizeCategory(risk.category))
      .join(' and ');

    return `Your responses suggest that ${topCategories} may be worth a little extra attention. This is not a diagnosis, just a helpful guide for what to look at next.`;
  }

  private getFocusAreas(risks: HealthRiskResult[]): string[] {
    return risks
      .filter((risk) => risk.level !== 'low')
      .slice(0, 3)
      .map((risk) => this.humanizeCategory(risk.category));
  }

  private flattenObjectText(value: unknown): string {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return String(value);
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.flattenObjectText(item)).join(' ');
    }
    if (typeof value === 'object') {
      return Object.values(value as Record<string, unknown>)
        .map((item) => this.flattenObjectText(item))
        .join(' ');
    }
    return '';
  }

  private getNext24HourDates(): string[] {
    const now = new Date();
    const nextDay = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const dates = [this.formatYyyymmdd(now)];
    const nextDayFormatted = this.formatYyyymmdd(nextDay);
    if (nextDayFormatted !== dates[0]) {
      dates.push(nextDayFormatted);
    }
    return dates;
  }

  private isWithinNext24Hours(yyyymmdd: string, time24h: string): boolean {
    const slotDate = this.toDateTime(yyyymmdd, time24h);
    const now = new Date();
    const in24Hours = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    return slotDate >= now && slotDate <= in24Hours;
  }

  private toDateTime(yyyymmdd: string, time24h: string): Date {
    const year = Number(yyyymmdd.slice(0, 4));
    const month = Number(yyyymmdd.slice(4, 6)) - 1;
    const day = Number(yyyymmdd.slice(6, 8));
    const [hours, minutes] = time24h.split(':').map(Number);
    return new Date(year, month, day, hours || 0, minutes || 0, 0, 0);
  }

  private formatYyyymmdd(date: Date): string {
    const yyyy = String(date.getFullYear());
    const mm = String(date.getMonth() + 1).padStart(2, '0');
    const dd = String(date.getDate()).padStart(2, '0');
    return `${yyyy}${mm}${dd}`;
  }

  private humanizeCategory(category: HealthRiskCategory): string {
    const label = category.replace(/_/g, ' ');
    return label.charAt(0).toUpperCase() + label.slice(1);
  }

  private toScale(value?: boolean | number): number {
    if (typeof value === 'number') {
      return Math.max(0, Math.min(5, Math.round(value)));
    }
    if (value === true) {
      return 4;
    }
    return 0;
  }

  private getFirstString(
    source: Record<string, unknown>,
    keys: string[]
  ): string | undefined {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (typeof value === 'number') return String(value);
    }
    return undefined;
  }

  private getFirstNumber(
    source: Record<string, unknown>,
    keys: string[]
  ): number | undefined {
    for (const key of keys) {
      const value = source[key];
      if (typeof value === 'number') return value;
      if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value);
        if (!Number.isNaN(parsed)) return parsed;
      }
    }
    return undefined;
  }

  private getAgeFromDob(dateOfBirth?: string): number | undefined {
    if (!dateOfBirth || dateOfBirth.length !== 8) return undefined;

    const year = Number(dateOfBirth.slice(0, 4));
    const month = Number(dateOfBirth.slice(4, 6)) - 1;
    const day = Number(dateOfBirth.slice(6, 8));
    const dob = new Date(year, month, day);
    if (Number.isNaN(dob.getTime())) return undefined;

    const today = new Date();
    let age = today.getFullYear() - dob.getFullYear();
    const monthDiff = today.getMonth() - dob.getMonth();
    if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < dob.getDate())) {
      age -= 1;
    }
    return age;
  }
}
