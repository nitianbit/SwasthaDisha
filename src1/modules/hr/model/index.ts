import { Schema, model, Model } from 'mongoose';
import { IHR } from '@/modules/hr/types';

const documentSchema = new Schema(
  {
    type: {
      type: String,
      required: true,
      trim: true,
    }, // Document type (e.g., "contract", "certificate", "id-proof", "resume")
    url: {
      type: String,
      required: true,
      trim: true,
    }, // Document URL (relative path)
    fileName: {
      type: String,
      trim: true,
    }, // Original file name
    uploadedAt: {
      type: String,
      match: /^\d{8}$/, // YYYYMMDD format
    }, // Upload date
  },
  { _id: false }
);

const hrSchema = new Schema<IHR>(
  {
    employeeId: {
      type: String,
      required: true,
      unique: true,
      trim: true,
      uppercase: true,
      index: true,
    }, // Unique employee ID (e.g., "EMP001", "HR-2024-001")
    userId: {
      type: String,
      sparse: true,
      index: true,
    }, // Reference to user account if employee has login access
    firstName: {
      type: String,
      required: true,
      trim: true,
      index: true,
    }, // Employee first name
    lastName: {
      type: String,
      required: true,
      trim: true,
      index: true,
    }, // Employee last name
    email: {
      type: String,
      trim: true,
      lowercase: true,
      sparse: true,
      index: true,
    }, // Employee email address
    phone: {
      type: String,
      trim: true,
      match: /^\d{10}$/, // Exactly 10 digits
      sparse: true,
      index: true,
    }, // Employee phone number
    alternatePhone: {
      type: String,
      trim: true,
      match: /^\d{10}$/, // Exactly 10 digits
    }, // Alternate phone number
    dateOfBirth: {
      type: String,
      match: /^\d{8}$/, // YYYYMMDD format
    }, // Date of birth
    gender: {
      type: String,
      enum: ['male', 'female', 'other'],
    },
    address: {
      type: String,
      trim: true,
    }, // Residential address
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
    country: {
      type: String,
      trim: true,
      index: true,
    },
    
    // Employment Details
    department: {
      type: String,
      trim: true,
      index: true,
    }, // Department name (e.g., "HR", "Finance", "Operations", "Medical")
    designation: {
      type: String,
      trim: true,
      index: true,
    }, // Job title/designation (e.g., "Manager", "Developer", "Nurse")
    employmentType: {
      type: String,
      enum: ['full-time', 'part-time', 'contract', 'intern'],
      index: true,
    }, // Type of employment
    joiningDate: {
      type: String,
      match: /^\d{8}$/, // YYYYMMDD format
      index: true,
    }, // Date of joining
    leavingDate: {
      type: String,
      match: /^\d{8}$/, // YYYYMMDD format
    }, // Date of leaving (if terminated)
    employmentStatus: {
      type: String,
      enum: ['active', 'inactive', 'terminated', 'on-leave'],
      required: true,
      default: 'active',
      index: true,
    }, // Current employment status
    reportingManager: {
      type: String,
      trim: true,
      index: true,
    }, // Employee ID of reporting manager
    corporateId: {
      type: String,
      index: true,
    }, // Corporate ID if employee belongs to a corporate
    
    // Additional Information
    emergencyContactName: {
      type: String,
      trim: true,
    }, // Emergency contact person name
    emergencyContactPhone: {
      type: String,
      trim: true,
      match: /^\d{10}$/, // Exactly 10 digits
    }, // Emergency contact phone number
    emergencyContactRelation: {
      type: String,
      trim: true,
    }, // Relationship with emergency contact
    profilePictureUrl: {
      type: String,
      trim: true,
    }, // Profile picture URL (relative path)
    documents: {
      type: [documentSchema],
      default: [],
    }, // Employee documents
    
    // Status
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    }, // Whether employee record is active
    notes: {
      type: String,
      trim: true,
    }, // Additional notes/comments
  },
  {
    timestamps: true,
  }
);

// Indexes for better query performance
hrSchema.index({ employeeId: 1, isActive: 1 });
hrSchema.index({ department: 1, employmentStatus: 1 });
hrSchema.index({ department: 1, isActive: 1 });
hrSchema.index({ corporateId: 1, employmentStatus: 1 });
hrSchema.index({ corporateId: 1, isActive: 1 });
hrSchema.index({ reportingManager: 1, employmentStatus: 1 });
hrSchema.index({ employmentStatus: 1, isActive: 1 });
hrSchema.index({ joiningDate: 1, employmentStatus: 1 });
hrSchema.index({ firstName: 'text', lastName: 'text', email: 'text', employeeId: 'text' }); // Text search index

const HRModel: Model<IHR> = model<IHR>('HR', hrSchema);

export { HRModel };
export default HRModel;
