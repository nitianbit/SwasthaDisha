import { Service } from 'typedi';
import BannerModel from '@/modules/banners/model';
import BookingModel from '@/modules/bookings/model';
import { HRRepository } from '@/modules/hr/repository';
import {
  IHR,
  CreateHRRequest,
  HRCorporateOverviewQueryParams,
  HRCorporateOverviewResponse,
  UpdateHRRequest,
  HRQueryParams,
} from '@/modules/hr/types';
import { AppError } from '@/modules/common/types';
import { compareYyyymmdd } from '@/modules/common/utils/dateUtils';
import { buildContainsRegex } from '@/modules/common/utils/queryUtils';
import CorporateModel from '@/modules/corporates/model';
import CouponModel from '@/modules/coupon/model';
import ExternalBookingModel from '@/modules/externalBookings/model';
import { HRModel } from '@/modules/hr/model';
import SpecialistModel from '@/modules/specialists/model';
import UserModel from '@/modules/user/model';
import WellnessPackageModel from '@/modules/wellnessPackages/model';

@Service()
export class HRService {
  constructor(private hrRepository: HRRepository) {}

  async create(data: CreateHRRequest): Promise<IHR> {
    // Check if employee ID already exists
    const existingEmployee = await this.hrRepository.findByEmployeeId(data.employeeId);

    if (existingEmployee) {
      throw new AppError({
        status: 400,
        code: 'EMPLOYEE_ID_EXISTS',
        message: 'An employee with this employee ID already exists',
      });
    }

    // Validate email uniqueness if provided
    if (data.email) {
      const existing = await this.hrRepository.findOne({
        email: data.email.toLowerCase(),
      });

      if (existing) {
        throw new AppError({
          status: 400,
          code: 'EMAIL_ALREADY_EXISTS',
          message: 'An employee with this email already exists',
        });
      }
    }

    // Validate phone uniqueness if provided
    if (data.phone) {
      const existing = await this.hrRepository.findOne({
        phone: data.phone,
      });

      if (existing) {
        throw new AppError({
          status: 400,
          code: 'PHONE_ALREADY_EXISTS',
          message: 'An employee with this phone already exists',
        });
      }
    }

    // Validate userId uniqueness if provided
    if (data.userId) {
      const existing = await this.hrRepository.findByUserId(data.userId);

      if (existing) {
        throw new AppError({
          status: 400,
          code: 'USER_ID_ALREADY_EXISTS',
          message: 'An employee with this user ID already exists',
        });
      }
    }

    // Validate dates
    if (data.joiningDate && data.leavingDate) {
      if (compareYyyymmdd(data.joiningDate, data.leavingDate) > 0) {
        throw new AppError({
          status: 400,
          code: 'INVALID_DATE_RANGE',
          message: 'Leaving date cannot be earlier than joining date',
        });
      }
    }

    // Validate reporting manager exists if provided
    if (data.reportingManager) {
      const manager = await this.hrRepository.findByEmployeeId(data.reportingManager);
      if (!manager) {
        throw new AppError({
          status: 400,
          code: 'REPORTING_MANAGER_NOT_FOUND',
          message: 'Reporting manager not found',
        });
      }
    }

    const hr: IHR = {
      employeeId: data.employeeId.toUpperCase(),
      userId: data.userId,
      firstName: data.firstName,
      lastName: data.lastName,
      email: data.email?.toLowerCase(),
      phone: data.phone,
      alternatePhone: data.alternatePhone,
      dateOfBirth: data.dateOfBirth,
      gender: data.gender,
      address: data.address,
      city: data.city,
      state: data.state,
      pincode: data.pincode,
      country: data.country,
      department: data.department,
      designation: data.designation,
      employmentType: data.employmentType,
      joiningDate: data.joiningDate,
      leavingDate: data.leavingDate,
      employmentStatus: data.employmentStatus || 'active',
      reportingManager: data.reportingManager?.toUpperCase(),
      corporateId: data.corporateId,
      emergencyContactName: data.emergencyContactName,
      emergencyContactPhone: data.emergencyContactPhone,
      emergencyContactRelation: data.emergencyContactRelation,
      profilePictureUrl: data.profilePictureUrl,
      documents: data.documents || [],
      isActive: data.isActive !== undefined ? data.isActive : true,
      notes: data.notes,
    };

    return this.hrRepository.save(hr);
  }

  async getById(id: string): Promise<IHR> {
    const hr = await this.hrRepository.findById(id);

    if (!hr) {
      throw new AppError({
        status: 404,
        code: 'HR_NOT_FOUND',
        message: 'Employee record not found',
      });
    }

    return hr;
  }

  async getByEmployeeId(employeeId: string): Promise<IHR> {
    const hr = await this.hrRepository.findByEmployeeId(employeeId);

    if (!hr) {
      throw new AppError({
        status: 404,
        code: 'HR_NOT_FOUND',
        message: 'Employee record not found',
      });
    }

    return hr;
  }

  async getAll(
    queryParams: HRQueryParams = {}
  ): Promise<{
    data: IHR[];
    total?: number;
    page?: number;
    totalPages?: number;
  }> {
    // If pagination params are provided, use pagination
    if (queryParams.page && queryParams.limit) {
      return this.hrRepository.findWithPagination(
        queryParams,
        queryParams.page,
        queryParams.limit
      );
    }

    // Otherwise return all matching records
    const filter: any = {};

    if (queryParams.employeeId) {
      filter.employeeId = buildContainsRegex(queryParams.employeeId.toUpperCase());
    }

    if (queryParams.firstName) {
      filter.firstName = buildContainsRegex(queryParams.firstName);
    }

    if (queryParams.lastName) {
      filter.lastName = buildContainsRegex(queryParams.lastName);
    }

    if (queryParams.email) {
      filter.email = buildContainsRegex(queryParams.email);
    }

    if (queryParams.userId) {
      filter.userId = queryParams.userId;
    }

    if (queryParams.department) {
      filter.department = buildContainsRegex(queryParams.department);
    }

    if (queryParams.designation) {
      filter.designation = buildContainsRegex(queryParams.designation);
    }

    if (queryParams.employmentType) {
      filter.employmentType = queryParams.employmentType;
    }

    if (queryParams.employmentStatus) {
      filter.employmentStatus = queryParams.employmentStatus;
    }

    if (queryParams.corporateId) {
      filter.corporateId = queryParams.corporateId;
    }

    if (queryParams.reportingManager) {
      filter.reportingManager = buildContainsRegex(queryParams.reportingManager.toUpperCase());
    }

    if (queryParams.isActive !== undefined) {
      filter.isActive = queryParams.isActive;
    }

    const sort: any = {};
    if (queryParams.sortBy) {
      sort[queryParams.sortBy] = queryParams.sortOrder === 'desc' ? -1 : 1;
    } else {
      sort.firstName = 1;
      sort.lastName = 1;
    }

    let data: IHR[];

    if (queryParams.search) {
      data = await this.hrRepository.searchEmployees(queryParams.search);
    } else if (queryParams.employmentStatus && !queryParams.department && !queryParams.firstName && !queryParams.lastName && !queryParams.email && !queryParams.designation && !queryParams.employeeId && !queryParams.reportingManager) {
      data = await this.hrRepository.findByEmploymentStatus(
        queryParams.employmentStatus
      );
    } else if (queryParams.corporateId && !queryParams.department && !queryParams.firstName && !queryParams.lastName && !queryParams.email && !queryParams.designation && !queryParams.employeeId && !queryParams.reportingManager) {
      data = await this.hrRepository.findByCorporateId(queryParams.corporateId);
    } else {
      data = await this.hrRepository.findAll(filter, { sort });
    }

    return { data };
  }

  async update(id: string, data: UpdateHRRequest): Promise<IHR> {
    const hr = await this.hrRepository.findById(id);

    if (!hr) {
      throw new AppError({
        status: 404,
        code: 'HR_NOT_FOUND',
        message: 'Employee record not found',
      });
    }

    // Validate email uniqueness if being updated
    if (data.email && data.email.toLowerCase() !== hr.email?.toLowerCase()) {
      const existing = await this.hrRepository.findOne({
        email: data.email.toLowerCase(),
        _id: { $ne: id },
      });

      if (existing) {
        throw new AppError({
          status: 400,
          code: 'EMAIL_ALREADY_EXISTS',
          message: 'An employee with this email already exists',
        });
      }
    }

    // Validate phone uniqueness if being updated
    if (data.phone && data.phone !== hr.phone) {
      const existing = await this.hrRepository.findOne({
        phone: data.phone,
        _id: { $ne: id },
      });

      if (existing) {
        throw new AppError({
          status: 400,
          code: 'PHONE_ALREADY_EXISTS',
          message: 'An employee with this phone already exists',
        });
      }
    }

    // Validate userId uniqueness if being updated
    if (data.userId && data.userId !== hr.userId) {
      const existing = await this.hrRepository.findByUserId(data.userId);

      if (existing && existing._id !== id) {
        throw new AppError({
          status: 400,
          code: 'USER_ID_ALREADY_EXISTS',
          message: 'An employee with this user ID already exists',
        });
      }
    }

    // Validate dates
    const joiningDate = data.joiningDate || hr.joiningDate;
    const leavingDate = data.leavingDate || hr.leavingDate;
    if (joiningDate && leavingDate) {
      if (compareYyyymmdd(joiningDate, leavingDate) > 0) {
        throw new AppError({
          status: 400,
          code: 'INVALID_DATE_RANGE',
          message: 'Leaving date cannot be earlier than joining date',
        });
      }
    }

    // Validate reporting manager exists if being updated
    if (data.reportingManager) {
      const manager = await this.hrRepository.findByEmployeeId(data.reportingManager);
      if (!manager) {
        throw new AppError({
          status: 400,
          code: 'REPORTING_MANAGER_NOT_FOUND',
          message: 'Reporting manager not found',
        });
      }
      data.reportingManager = data.reportingManager.toUpperCase();
    }

    // Normalize email to lowercase
    if (data.email) {
      data.email = data.email.toLowerCase();
    }

    const updated = await this.hrRepository.update({ _id: id }, data);

    if (!updated) {
      throw new AppError({
        status: 500,
        code: 'UPDATE_FAILED',
        message: 'Failed to update employee record',
      });
    }

    return updated;
  }

  async delete(id: string): Promise<void> {
    const hr = await this.hrRepository.findById(id);

    if (!hr) {
      throw new AppError({
        status: 404,
        code: 'HR_NOT_FOUND',
        message: 'Employee record not found',
      });
    }

    await this.hrRepository.delete({ _id: id });
  }

  async getByDepartment(department: string): Promise<IHR[]> {
    return this.hrRepository.findByDepartment(department);
  }

  async getByEmploymentStatus(status: string): Promise<IHR[]> {
    return this.hrRepository.findByEmploymentStatus(status);
  }

  async getByCorporateId(corporateId: string): Promise<IHR[]> {
    return this.hrRepository.findByCorporateId(corporateId);
  }

  async getCorporateOverview(
    corporateId: string,
    queryParams: HRCorporateOverviewQueryParams = {}
  ): Promise<HRCorporateOverviewResponse> {
    const corporate = await CorporateModel.findById(corporateId).lean();

    if (!corporate) {
      throw new AppError({
        status: 404,
        code: 'CORPORATE_NOT_FOUND',
        message: 'Corporate not found',
      });
    }

    const limit = queryParams.limit || 20;
    const specialistIds = Array.isArray(corporate.specialistIds)
      ? corporate.specialistIds.filter(Boolean)
      : [];
    const wellnessPackageIds = Array.isArray(corporate.wellnessPackageIds)
      ? corporate.wellnessPackageIds.filter(Boolean)
      : [];
    const bookingStatuses = ['pending', 'confirmed', 'completed', 'cancelled'];
    const externalBookingStatuses = [
      'created',
      'pending',
      'pending_payment',
      'confirmed',
      'completed',
      'cancelled',
      'rescheduled',
      'report_delivered',
    ];

    const createdAtRange =
      queryParams.dateFrom || queryParams.dateTo
        ? {
            ...(queryParams.dateFrom
              ? { $gte: this.getStartOfDayUtc(queryParams.dateFrom) }
              : {}),
            ...(queryParams.dateTo
              ? { $lte: this.getEndOfDayUtc(queryParams.dateTo) }
              : {}),
          }
        : undefined;
    const bookingDateRange =
      queryParams.dateFrom || queryParams.dateTo
        ? {
            ...(queryParams.dateFrom ? { $gte: queryParams.dateFrom } : {}),
            ...(queryParams.dateTo ? { $lte: queryParams.dateTo } : {}),
          }
        : undefined;

    const [
      usersCount,
      hrEmployeesCount,
      bookingsCount,
      externalBookingsCount,
      bannersCount,
      couponsCount,
      users,
      hrEmployees,
      bookings,
      externalBookings,
      banners,
      coupons,
      specialists,
      wellnessPackages,
      bookingsByStatus,
      externalBookingsByStatus,
      dateRangeCounts,
    ] = await Promise.all([
      UserModel.countDocuments({ corporateId }),
      HRModel.countDocuments({ corporateId }),
      BookingModel.countDocuments({ corporateId }),
      ExternalBookingModel.countDocuments({ corporateId }),
      BannerModel.countDocuments({ corporateId }),
      CouponModel.countDocuments({ corporateIds: corporateId }),
      UserModel.find({ corporateId })
        .select('_id name email phone city state corporateId createdAt updatedAt')
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean(),
      this.hrRepository.findAll(
        { corporateId },
        { sort: { createdAt: -1 }, limit }
      ),
      BookingModel.find({ corporateId })
        .select(
          '_id userId bookingType bookingDate bookingTime status paymentStatus price corporateId createdAt updatedAt'
        )
        .sort({ bookingDate: -1, createdAt: -1 })
        .limit(limit)
        .lean(),
      ExternalBookingModel.find({ corporateId })
        .select(
          '_id userId providerType appointmentType bookingDate bookingTime status paymentStatus price corporateId integration createdAt updatedAt'
        )
        .sort({ bookingDate: -1, createdAt: -1 })
        .limit(limit)
        .lean(),
      BannerModel.find({ corporateId })
        .select(
          '_id title bannerType target targetId isActive startDate endDate corporateId createdAt updatedAt'
        )
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean(),
      CouponModel.find({ corporateIds: corporateId })
        .select(
          '_id code title discountType discountValue applicableTo eligibleFor startDate endDate isActive corporateIds createdAt updatedAt'
        )
        .sort({ createdAt: -1 })
        .limit(limit)
        .lean(),
      specialistIds.length
        ? SpecialistModel.find({ _id: { $in: specialistIds } })
            .select(
              '_id name specialization consultationFee isConsultationFree rating isActive isVerified createdAt updatedAt'
            )
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean()
        : Promise.resolve([]),
      wellnessPackageIds.length
        ? WellnessPackageModel.find({ _id: { $in: wellnessPackageIds } })
            .select(
              '_id name category originalPrice discountedPrice isActive isPopular createdAt updatedAt'
            )
            .sort({ createdAt: -1 })
            .limit(limit)
            .lean()
        : Promise.resolve([]),
      Promise.all(
        bookingStatuses.map(async (status) => [
          status,
          await BookingModel.countDocuments({ corporateId, status }),
        ] as const)
      ),
      Promise.all(
        externalBookingStatuses.map(async (status) => [
          status,
          await ExternalBookingModel.countDocuments({ corporateId, status }),
        ] as const)
      ),
      createdAtRange || bookingDateRange
        ? Promise.all([
            UserModel.countDocuments({
              corporateId,
              ...(createdAtRange ? { createdAt: createdAtRange } : {}),
            }),
            BookingModel.countDocuments({
              corporateId,
              ...(bookingDateRange ? { bookingDate: bookingDateRange } : {}),
            }),
            ExternalBookingModel.countDocuments({
              corporateId,
              ...(bookingDateRange ? { bookingDate: bookingDateRange } : {}),
            }),
          ])
        : Promise.resolve(null),
    ]);

    return {
      corporate: {
        _id: corporate._id,
        name: corporate.name,
        companyName: corporate.companyName,
        email: corporate.email,
        phone: corporate.phone,
        contactPerson: corporate.contactPerson,
        city: corporate.city,
        state: corporate.state,
        country: corporate.country,
        isActive: corporate.isActive,
        isVerified: corporate.isVerified,
        specialistIds: corporate.specialistIds || [],
        wellnessPackageIds: corporate.wellnessPackageIds || [],
        createdAt: corporate.createdAt,
        updatedAt: corporate.updatedAt,
      },
      dashboard: {
        totals: {
          users: usersCount,
          hrEmployees: hrEmployeesCount,
          bookings: bookingsCount,
          externalBookings: externalBookingsCount,
          banners: bannersCount,
          coupons: couponsCount,
          specialists: specialistIds.length,
          wellnessPackages: wellnessPackageIds.length,
        },
        bookingStatusCounts: Object.fromEntries(bookingsByStatus),
        externalBookingStatusCounts: Object.fromEntries(
          externalBookingsByStatus
        ),
        ...(dateRangeCounts && queryParams.dateFrom && queryParams.dateTo
          ? {
              dateRange: {
                dateFrom: queryParams.dateFrom,
                dateTo: queryParams.dateTo,
                newUsers: dateRangeCounts[0],
                bookings: dateRangeCounts[1],
                externalBookings: dateRangeCounts[2],
              },
            }
          : {}),
      },
      data: {
        users: users as Record<string, unknown>[],
        hrEmployees: hrEmployees as Record<string, unknown>[],
        bookings: bookings as Record<string, unknown>[],
        externalBookings: externalBookings as Record<string, unknown>[],
        banners: banners as Record<string, unknown>[],
        coupons: coupons as Record<string, unknown>[],
        specialists: specialists as Record<string, unknown>[],
        wellnessPackages: wellnessPackages as Record<string, unknown>[],
      },
    };
  }

  async getByReportingManager(reportingManager: string): Promise<IHR[]> {
    return this.hrRepository.findByReportingManager(reportingManager);
  }

  private getStartOfDayUtc(yyyymmdd: string): Date {
    const year = Number(yyyymmdd.slice(0, 4));
    const month = Number(yyyymmdd.slice(4, 6));
    const day = Number(yyyymmdd.slice(6, 8));
    return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  }

  private getEndOfDayUtc(yyyymmdd: string): Date {
    const year = Number(yyyymmdd.slice(0, 4));
    const month = Number(yyyymmdd.slice(4, 6));
    const day = Number(yyyymmdd.slice(6, 8));
    return new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
  }
}
