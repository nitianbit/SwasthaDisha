export interface ICampContact {
  name?: string;
  mobile?: string;
  altMobile?: string | null;
  email?: string | null;
}

export interface ICamp {
  campLsId: string;
  corporateName?: string;
  dates?: string[];
  numOrders?: number;
  labName?: string;
  labLogo?: string | null;
  lsLabId?: number | string;
  lsChainId?: number | string | null;
  campStatus?: string;
  meta?: Record<string, unknown>;
}

export interface ICampDetails extends ICamp {
  orders?: Array<number | string>;
  address?: string;
  locality?: string | null;
  city?: string;
  state?: string;
  pincode?: string;
  phlebos?: ICampContact[];
  labCoordinators?: ICampContact[];
  labEscalators?: ICampContact[];
  notes?: string;
}

export interface ICampSlot {
  date: string;
  time: string;
  meta?: Record<string, unknown>;
}

export interface CampListQuery {
  startDate?: string;
  endDate?: string;
  test?: boolean;
}

export interface PlaceCampOrderRequest {
  campLsId: string;
  orderType?: string;
  userId: string;
  corporateId?: string;
  appointment: string;
  name: string;
  mobile: string;
  gender: string;
  packageIds?: string[];
  testIds?: string[];
  uniqueId?: string;
  referenceId?: string;
  isVip?: boolean;
  labId?: string;
  pincode?: string;
  labName?: string;
  notes?: string;
  email?: string;
  dateOfBirth?: string;
  age?: string;
  altContact?: string;
  mainUserUniqueId?: string;
  relationship?: string;
}

export interface CampBulkUserRow {
  rowNumber: number;
  userId?: string;
  uniqueId?: string;
  referenceId?: string;
  name?: string;
  mobile?: string;
  gender?: string;
  email?: string;
  dateOfBirth?: string;
  age?: string;
  altContact?: string;
  mainUserUniqueId?: string;
  relationship?: string;
}

export interface BulkPlaceCampOrderRequest {
  campLsId: string;
  orderType?: string;
  appointment: string;
  corporateId?: string;
  packageIds?: string[];
  testIds?: string[];
  isVip?: boolean;
  labId?: string;
  pincode?: string;
  labName?: string;
  notes?: string;
  rows: CampBulkUserRow[];
}

export interface BulkCampOrderResult {
  totalRows: number;
  createdCount: number;
  failedCount: number;
  created: Array<{
    rowNumber: number;
    bookingId?: string;
    externalBookingId?: string;
    mobile?: string;
    name?: string;
  }>;
  failed: Array<{
    rowNumber: number;
    mobile?: string;
    name?: string;
    error: string;
  }>;
}
