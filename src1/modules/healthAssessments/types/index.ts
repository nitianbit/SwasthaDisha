export type HealthRiskLevel = 'low' | 'moderate' | 'high';
export type HealthRiskCategory =
  | 'diabetes'
  | 'cardiac'
  | 'thyroid'
  | 'women_health'
  | 'respiratory'
  | 'liver'
  | 'kidney'
  | 'general_wellness';
export type RecommendationUrgency = 'routine' | 'priority' | 'urgent';
export type MissingOfferingKind = 'doctor' | 'package';
export type HealthAssessmentScale = 0 | 1 | 2 | 3 | 4 | 5;

export interface HealthAssessmentProfileInput {
  age?: number;
  gender?: 'Male' | 'Female' | 'Other';
  heightCm?: number;
  weightKg?: number;
  city?: string;
  state?: string;
  pincode?: string;
}

export interface HealthAssessmentLifestyleInput {
  smoking?: boolean | HealthAssessmentScale;
  alcohol?: boolean | HealthAssessmentScale;
  exerciseDaysPerWeek?: number;
  sleepHours?: number;
  stressLevel?: number;
  waterIntakeLitres?: number;
}

export interface HealthAssessmentMedicalHistoryInput {
  diabetes?: boolean;
  hypertension?: boolean;
  thyroidDisorder?: boolean;
  heartDisease?: boolean;
  kidneyDisease?: boolean;
  liverDisease?: boolean;
  asthmaOrCopd?: boolean;
  pcos?: boolean;
  pregnancy?: boolean;
  currentMedications?: string[];
}

export interface HealthAssessmentFamilyHistoryInput {
  diabetes?: boolean;
  hypertension?: boolean;
  heartDisease?: boolean;
  stroke?: boolean;
  thyroid?: boolean;
  cancer?: boolean;
  kidneyDisease?: boolean;
}

export interface HealthAssessmentSymptomsInput {
  fatigue?: boolean | HealthAssessmentScale;
  frequentUrination?: boolean | HealthAssessmentScale;
  excessiveThirst?: boolean | HealthAssessmentScale;
  unexplainedWeightGain?: boolean | HealthAssessmentScale;
  unexplainedWeightLoss?: boolean | HealthAssessmentScale;
  chestPain?: boolean | HealthAssessmentScale;
  breathlessness?: boolean | HealthAssessmentScale;
  headache?: boolean | HealthAssessmentScale;
  dizziness?: boolean | HealthAssessmentScale;
  swelling?: boolean | HealthAssessmentScale;
  irregularPeriods?: boolean | HealthAssessmentScale;
  heavyBleeding?: boolean | HealthAssessmentScale;
  hairFall?: boolean | HealthAssessmentScale;
  constipation?: boolean | HealthAssessmentScale;
  digestiveIssues?: boolean | HealthAssessmentScale;
}

export interface HealthAssessmentVitalsInput {
  systolicBp?: number;
  diastolicBp?: number;
  fastingSugar?: number;
  postMealSugar?: number;
  hba1c?: number;
  heartRate?: number;
  spo2?: number;
}

export interface SubmitHealthAssessmentRequest {
  dependentId?: string;
  profile?: HealthAssessmentProfileInput;
  lifestyle?: HealthAssessmentLifestyleInput;
  medicalHistory?: HealthAssessmentMedicalHistoryInput;
  familyHistory?: HealthAssessmentFamilyHistoryInput;
  symptoms?: HealthAssessmentSymptomsInput;
  vitals?: HealthAssessmentVitalsInput;
  concerns?: string[];
  goals?: string[];
  notes?: string;
}

export interface HealthRiskResult {
  category: HealthRiskCategory;
  score: number;
  level: HealthRiskLevel;
  reasons: string[];
}

export interface HealthAssessmentComputedMetrics {
  bmi?: number;
  age?: number;
}

export interface HealthAssessmentPackageRecommendation {
  source: 'external';
  packageId?: string;
  name: string;
  category?: string;
  discountedPrice?: number;
  originalPrice?: number;
  availableInNext24Hours: boolean;
  nextAvailableSlot?: {
    bookingDate: string;
    bookingTime: string;
    labId?: string;
    externalProviderId?: string;
  };
  reason: string;
  score: number;
  meta?: Record<string, unknown>;
}

export interface HealthAssessmentSpecialistSummary {
  source: 'external';
  specialistId?: string;
  name: string;
  specialization: string;
  rating?: number;
  consultationFee?: number;
  isConsultationFree?: boolean;
  experienceYears?: number;
  availableInNext24Hours: boolean;
  nextAvailableSlot?: {
    bookingDate: string;
    bookingTime: string;
    appointmentType: string;
    externalProviderId: string;
  };
  meta?: Record<string, unknown>;
}

export interface HealthAssessmentSpecialistRecommendation {
  specialization: string;
  reason: string;
  specialists: HealthAssessmentSpecialistSummary[];
}

export interface HealthAssessmentRecommendations {
  urgency: RecommendationUrgency;
  headline: string;
  summary: string;
  focusAreas: string[];
  primaryCategories: HealthRiskCategory[];
  packageRecommendations: HealthAssessmentPackageRecommendation[];
  specialistRecommendations: HealthAssessmentSpecialistRecommendation[];
  missingOfferings: MissingOfferingSummary[];
  nextSteps: string[];
  disclaimers: string[];
  meta?: Record<string, unknown>;
}

export interface IMissingOffering {
  _id?: string;
  kind: MissingOfferingKind;
  riskCategory: HealthRiskCategory;
  desiredLabel: string;
  reasons: string[];
  occurrenceCount: number;
  firstSuggestedAt?: Date;
  lastSuggestedAt?: Date;
  lastTriggeredByUserId?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface MissingOfferingSummary {
  kind: MissingOfferingKind;
  riskCategory: HealthRiskCategory;
  desiredLabel: string;
  reasons: string[];
}

export interface IHealthAssessment {
  _id?: string;
  userId: string;
  dependentId?: string;
  assessmentVersion: string;
  profileSnapshot: HealthAssessmentProfileInput;
  answers: {
    lifestyle: HealthAssessmentLifestyleInput;
    medicalHistory: HealthAssessmentMedicalHistoryInput;
    familyHistory: HealthAssessmentFamilyHistoryInput;
    symptoms: HealthAssessmentSymptomsInput;
    vitals: HealthAssessmentVitalsInput;
    concerns: string[];
    goals: string[];
    notes?: string;
  };
  computedMetrics: HealthAssessmentComputedMetrics;
  risks: HealthRiskResult[];
  overallRiskLevel: HealthRiskLevel;
  recommendations: HealthAssessmentRecommendations;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface HealthAssessmentListQueryParams {
  page?: number;
  limit?: number;
}

export interface HealthAssessmentQuestionField {
  key: string;
  label: string;
  type: 'boolean' | 'number' | 'multiselect' | 'text' | 'scale';
  helperText?: string;
  options?: string[];
}

export interface HealthAssessmentQuestionSection {
  id: string;
  title: string;
  fields: HealthAssessmentQuestionField[];
}

export interface HealthAssessmentQuestionnaire {
  version: string;
  sections: HealthAssessmentQuestionSection[];
}
