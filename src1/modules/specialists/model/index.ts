import { Schema, model, Model } from 'mongoose';
import { ISpecialist } from '@/modules/specialists/types';

const specialistDocumentSchema = new Schema(
  {
    type: {
      type: String,
      enum: [
        'medical-degree',
        'medical-registration-certificate',
        'aadhaar-or-govt-id',
        'experience-certificate',
        'other',
      ],
      required: true,
      trim: true,
    },
    url: {
      type: String,
      required: true,
      trim: true,
    },
    fileName: {
      type: String,
      trim: true,
    },
    uploadedAt: {
      type: String,
      match: /^\d{8}$/,
    },
    status: {
      type: String,
      enum: ['pending', 'uploaded', 'verified', 'rejected'],
      default: 'uploaded',
    },
  },
  { _id: false }
);

const specialistAvailabilitySchema = new Schema(
  {
    workingDays: {
      type: [String],
      enum: [
        'monday',
        'tuesday',
        'wednesday',
        'thursday',
        'friday',
        'saturday',
        'sunday',
      ],
      default: [],
    },
    slotDurationMinutes: {
      type: Number,
      min: 1,
    },
    morningSlots: {
      type: [String],
      default: [],
    },
    eveningSlots: {
      type: [String],
      default: [],
    },
    acceptVideoConsultations: {
      type: Boolean,
      default: false,
    },
    acceptChatConsultations: {
      type: Boolean,
      default: false,
    },
  },
  { _id: false }
);

const specialistSchema = new Schema<ISpecialist>(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    profilePictureUrl: {
      type: String,
      trim: true,
    },
    rating: {
      type: Number,
      min: 0,
      max: 5,
      default: 0,
      index: true,
    },
    specialization: {
      type: String,
      trim: true,
      index: true,
    },
    degree: {
      type: String,
      trim: true,
    },
    experienceYears: {
      type: Number,
      min: 0,
      max: 100,
      index: true,
    },
    languages: {
      type: [String],
      default: [],
    },
    bio: {
      type: String,
      trim: true,
    },
    consultationFee: {
      type: Number,
      min: 0,
      default: 0,
      index: true,
    },
    isConsultationFree: {
      type: Boolean,
      default: false,
      index: true,
    },
    email: {
      type: String,
      trim: true,
      lowercase: true,
      sparse: true,
      index: true,
    },
    phone: {
      type: String,
      trim: true,
      sparse: true,
      index: true,
    },
    gender: {
      type: String,
      enum: ['Male', 'Female', 'Other'],
      trim: true,
    },
    dateOfBirth: {
      type: String,
      match: /^\d{8}$/,
    },
    address: {
      type: String,
      trim: true,
    },
    city: {
      type: String,
      trim: true,
      index: true,
    },
    state: {
      type: String,
      trim: true,
      index: true,
    },
    pincode: {
      type: String,
      trim: true,
    },
    medicalRegistrationNumber: {
      type: String,
      trim: true,
      sparse: true,
      index: true,
    },
    hospitalOrClinic: {
      type: String,
      trim: true,
    },
    documents: {
      type: [specialistDocumentSchema],
      default: [],
    },
    availability: {
      type: specialistAvailabilitySchema,
      default: {},
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    isVerified: {
      type: Boolean,
      default: false,
      index: true,
    },
  },
  {
    timestamps: true,
  }
);

// Indexes for better query performance
specialistSchema.index({ specialization: 1, isActive: 1 });
specialistSchema.index({ specialization: 1, isVerified: 1 });
specialistSchema.index({ city: 1, state: 1 });
specialistSchema.index({ rating: -1 });
specialistSchema.index({ experienceYears: -1 });
specialistSchema.index({ name: 'text', specialization: 'text', bio: 'text' }); // Text search index

const SpecialistModel: Model<ISpecialist> = model<ISpecialist>(
  'Specialist',
  specialistSchema
);

export default SpecialistModel;
