/**
 * HR Module Types
 * 
 * Human Resources Management System
 * 
 * Key Concepts:
 * 
 * 1. Employee Management: Track employee information, employment details, and status
 * 2. Department & Designation: Organize employees by department and role
 * 3. Employment Status: Track active, inactive, terminated employees
 * 4. Documents: Store employee documents (contracts, certificates, etc.)
 */

export type EmploymentStatus = 'active' | 'inactive' | 'terminated' | 'on-leave';
export type EmploymentType = 'full-time' | 'part-time' | 'contract' | 'intern';

export interface IHR {
  _id?: string;
  employeeId: string; // Unique employee ID (e.g., "EMP001", "HR-2024-001")
  userId?: string; // Reference to user account if employee has login access
  firstName: string; // Employee first name
  lastName: string; // Employee last name
  email?: string; // Employee email address
  phone?: string; // Employee phone number (10 digits)
  alternatePhone?: string; // Alternate phone number
  dateOfBirth?: string; // YYYYMMDD format
  gender?: 'male' | 'female' | 'other';
  address?: string; // Residential address
  city?: string;
  state?: string;
  pincode?: string;
  country?: string;
  
  // Employment Details
  department?: string; // Department name (e.g., "HR", "Finance", "Operations", "Medical")
  designation?: string; // Job title/designation (e.g., "Manager", "Developer", "Nurse")
  employmentType?: EmploymentType; // Type of employment
  joiningDate?: string; // YYYYMMDD format - Date of joining
  leavingDate?: string; // YYYYMMDD format - Date of leaving (if terminated)
  employmentStatus: EmploymentStatus; // Current employment status
  reportingManager?: string; // Employee ID of reporting manager
  corporateId?: string; // Corporate ID if employee belongs to a corporate
  
  // Additional Information
  emergencyContactName?: string; // Emergency contact person name
  emergencyContactPhone?: string; // Emergency contact phone number
  emergencyContactRelation?: string; // Relationship with emergency contact
  profilePictureUrl?: string; // Profile picture URL (relative path)
  documents?: Array<{
    type: string; // Document type (e.g., "contract", "certificate", "id-proof", "resume")
    url: string; // Document URL (relative path)
    fileName?: string; // Original file name
    uploadedAt?: string; // YYYYMMDD format
  }>;
  
  // Status
  isActive: boolean; // Whether employee record is active
  notes?: string; // Additional notes/comments
  
  createdAt?: Date;
  updatedAt?: Date;
}

export interface CreateHRRequest {
  employeeId: string; // Unique employee ID
  userId?: string; // Reference to user account
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  alternatePhone?: string;
  dateOfBirth?: string; // YYYYMMDD format
  gender?: 'male' | 'female' | 'other';
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
  country?: string;
  department?: string;
  designation?: string;
  employmentType?: EmploymentType;
  joiningDate?: string; // YYYYMMDD format
  leavingDate?: string; // YYYYMMDD format
  employmentStatus?: EmploymentStatus; // Default: 'active'
  reportingManager?: string; // Employee ID of reporting manager
  corporateId?: string; // Corporate ID
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  emergencyContactRelation?: string;
  profilePictureUrl?: string; // Relative path
  documents?: Array<{
    type: string;
    url: string; // Relative path
    fileName?: string;
    uploadedAt?: string; // YYYYMMDD format
  }>;
  isActive?: boolean; // Default: true
  notes?: string;
}

export interface UpdateHRRequest {
  userId?: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  phone?: string;
  alternatePhone?: string;
  dateOfBirth?: string; // YYYYMMDD format
  gender?: 'male' | 'female' | 'other';
  address?: string;
  city?: string;
  state?: string;
  pincode?: string;
  country?: string;
  department?: string;
  designation?: string;
  employmentType?: EmploymentType;
  joiningDate?: string; // YYYYMMDD format
  leavingDate?: string; // YYYYMMDD format
  employmentStatus?: EmploymentStatus;
  reportingManager?: string; // Employee ID of reporting manager
  corporateId?: string; // Corporate ID
  emergencyContactName?: string;
  emergencyContactPhone?: string;
  emergencyContactRelation?: string;
  profilePictureUrl?: string; // Relative path
  documents?: Array<{
    type: string;
    url: string; // Relative path
    fileName?: string;
    uploadedAt?: string; // YYYYMMDD format
  }>;
  isActive?: boolean;
  notes?: string;
}

export interface HRQueryParams {
  employeeId?: string; // Filter by employee ID
  firstName?: string;
  lastName?: string;
  email?: string;
  userId?: string; // Filter by user ID
  department?: string; // Filter by department
  designation?: string; // Filter by designation
  employmentType?: EmploymentType; // Filter by employment type
  employmentStatus?: EmploymentStatus; // Filter by employment status
  corporateId?: string; // Filter by corporate ID
  reportingManager?: string; // Filter by reporting manager employee ID
  isActive?: boolean; // Filter by active status
  joiningDateFrom?: string; // YYYYMMDD format
  joiningDateTo?: string; // YYYYMMDD format
  search?: string; // Search by name, email, employeeId
  page?: number; // Page number for pagination
  limit?: number; // Number of items per page (max 100)
  sortBy?: string; // Field to sort by: 'employeeId', 'firstName', 'joiningDate', 'createdAt', 'updatedAt'
  sortOrder?: 'asc' | 'desc'; // Sort direction
}

export interface HRCorporateOverviewQueryParams {
  limit?: number;
  dateFrom?: string; // YYYYMMDD format
  dateTo?: string; // YYYYMMDD format
}

export interface HRCorporateOverviewResponse {
  corporate: Record<string, unknown>;
  dashboard: {
    totals: {
      users: number;
      hrEmployees: number;
      bookings: number;
      externalBookings: number;
      banners: number;
      coupons: number;
      specialists: number;
      wellnessPackages: number;
    };
    bookingStatusCounts: Record<string, number>;
    externalBookingStatusCounts: Record<string, number>;
    dateRange?: {
      dateFrom: string;
      dateTo: string;
      newUsers: number;
      bookings: number;
      externalBookings: number;
    };
  };
  data: {
    users: Record<string, unknown>[];
    hrEmployees: Record<string, unknown>[];
    bookings: Record<string, unknown>[];
    externalBookings: Record<string, unknown>[];
    banners: Record<string, unknown>[];
    coupons: Record<string, unknown>[];
    specialists: Record<string, unknown>[];
    wellnessPackages: Record<string, unknown>[];
  };
}
