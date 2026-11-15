export type PartnerKind = 'lab' | 'clinic';

export type TaxRegime = 'regular' | 'composition' | 'unregistered';

export type VerificationState = 'pending' | 'verified' | 'suspended';

export interface IPartnerVerification {
  state: VerificationState;
  documents: string[];
  verifiedAt?: Date;
  verifiedBy?: string;
}

export interface IPartner {
  _id?: string;
  kind: PartnerKind;
  name: string;
  legalName?: string;
  gstin?: string;
  pan?: string;
  contact: { phone: string; email?: string };
  logo?: string;
  verification: IPartnerVerification;
  taxRegime: TaxRegime;
  invoiceSeries: { prefix: string };
  activeOwnerCount: number;
  solo?: boolean;
  soloDoctorId?: string;
  isActive: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export type MemberRole = 'owner' | 'staff';

export type PartnerPermission =
  | 'staff.manage'
  | 'branches.manage'
  | 'catalogue.manage'
  | 'slots.manage'
  | 'bookings.view'
  | 'bookings.manage'
  | 'reports.upload'
  | 'reports.release'
  | 'invoices.create'
  | 'invoices.cancel'
  | 'payments.record'
  | 'finance.view';

export const ALL_PERMISSIONS: readonly PartnerPermission[] = [
  'staff.manage',
  'branches.manage',
  'catalogue.manage',
  'slots.manage',
  'bookings.view',
  'bookings.manage',
  'reports.upload',
  'reports.release',
  'invoices.create',
  'invoices.cancel',
  'payments.record',
  'finance.view',
] as const;

export type ProfessionalKind = 'pathologist' | 'pharmacist' | 'doctor';

export interface IMemberProfessional {
  kind: ProfessionalKind;
  registrationNumber: string;
}

export interface IMember {
  _id?: string;
  partnerId: string;
  phone: string;
  name: string;
  role: MemberRole;
  permissions: PartnerPermission[];
  branchIds: string[];
  doctorId?: string;
  professional?: IMemberProfessional;
  isActive: boolean;
  invitedBy?: string;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IBranch {
  _id?: string;
  partnerId: string;
  name: string;
  address: { line1: string; line2?: string; city: string; state: string; stateCode: string; pincode: string };
  geo?: { type: 'Point'; coordinates: [number, number] };
  phone: string;
  hours: IWeeklyHours;
  holidays: string[];
  services: { homeCollection: boolean; inLab: boolean; inClinic: boolean };
  isActive: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface IWeeklyHours {
  mon?: IDayHours;
  tue?: IDayHours;
  wed?: IDayHours;
  thu?: IDayHours;
  fri?: IDayHours;
  sat?: IDayHours;
  sun?: IDayHours;
}

export interface IDayHours {
  open: string;
  close: string;
}

export * from './catalogue';
export * from './invoice';
