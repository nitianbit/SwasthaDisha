export interface ISpecialistDocument {
  type:
    | 'medical-degree'
    | 'medical-registration-certificate'
    | 'aadhaar-or-govt-id'
    | 'experience-certificate'
    | 'other';
  url: string;
  fileName?: string;
  uploadedAt?: string;
  status?: 'pending' | 'uploaded' | 'verified' | 'rejected';
}

export interface ISpecialistAvailability {
  workingDays?: Array<
    'monday' | 'tuesday' | 'wednesday' | 'thursday' | 'friday' | 'saturday' | 'sunday'
  >;
  slotDurationMinutes?: number;
  morningSlots?: string[];
  eveningSlots?: string[];
  acceptVideoConsultations?: boolean;
  acceptChatConsultations?: boolean;
}

export interface ISpecialist {
  _id?: string;
  name: string;
  profilePictureUrl?: string;
  rating?: number;
  specialization?: string;
  degree?: string; // e.g., "MDS", "MBBS", "MD"
  experienceYears?: number;
  languages?: string[]; // e.g., ["English", "Hindi"]
  bio?: string;
  consultationFee?: number;
  isConsultationFree?: boolean;
  email?: string;
  phone?: string;
  gender?: 'Male' | 'Female' | 'Other';
  dateOfBirth?: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
  medicalRegistrationNumber?: string;
  hospitalOrClinic?: string;
  documents?: ISpecialistDocument[];
  availability?: ISpecialistAvailability;
  isActive?: boolean;
  isVerified?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface CreateSpecialistRequest {
  name: string;
  profilePictureUrl?: string;
  rating?: number;
  specialization?: string;
  degree?: string;
  experienceYears?: number;
  languages?: string[];
  bio?: string;
  consultationFee?: number;
  isConsultationFree?: boolean;
  email?: string;
  phone?: string;
  gender?: 'Male' | 'Female' | 'Other';
  dateOfBirth?: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
  medicalRegistrationNumber?: string;
  hospitalOrClinic?: string;
  documents?: ISpecialistDocument[];
  availability?: ISpecialistAvailability;
  isActive?: boolean;
  isVerified?: boolean;
}

export interface UpdateSpecialistRequest {
  name?: string;
  profilePictureUrl?: string;
  rating?: number;
  specialization?: string;
  degree?: string;
  experienceYears?: number;
  languages?: string[];
  bio?: string;
  consultationFee?: number;
  isConsultationFree?: boolean;
  email?: string;
  phone?: string;
  gender?: 'Male' | 'Female' | 'Other';
  dateOfBirth?: string;
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
  medicalRegistrationNumber?: string;
  hospitalOrClinic?: string;
  documents?: ISpecialistDocument[];
  availability?: ISpecialistAvailability;
  isActive?: boolean;
  isVerified?: boolean;
}

export interface SpecialistQueryParams {
  name?: string;
  email?: string;
  specialization?: string;
  isActive?: boolean;
  isVerified?: boolean;
  minRating?: number;
  maxRating?: number;
  minExperience?: number;
  maxExperience?: number;
  language?: string;
  search?: string;
  city?: string;
  state?: string;
  page?: number;
  limit?: number;
  sortBy?: string;
  sortOrder?: 'asc' | 'desc';
  forUser?: boolean;
}

export interface ISpecialistConsultationStats {
  totalAppointments: number;
  totalPatients: number;
  totalUniquePatients: number;
  totalFollowUpAppointments: number;
}

export interface ISpecialistConsultationStatsQuery {
  from?: string;
  to?: string;
}
