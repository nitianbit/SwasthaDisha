import { Service } from 'typedi';
import { AppError } from '@/modules/common/types';
import { SlotService } from '@/modules/slots/services';
import { SlotRepository } from '@/modules/slots/repository';
import { BookingRepository } from '@/modules/bookings/repository';
import { BookingService } from '@/modules/bookings/services';
import { UserRepository } from '@/modules/user/repository';
import { SpecialistService } from '@/modules/specialists/services';
import { NotificationService } from '@/modules/notification/services';
import {
  CreateSlotRequest,
  ISlot,
  UpdateSlotRequest,
} from '@/modules/slots/types';
import {
  IBooking,
  IBookingPrescription,
  IBookingPrescriptionMedicine,
} from '@/modules/bookings/types';
import { IUser } from '@/modules/user/types';
import {
  ISpecialist,
  UpdateSpecialistRequest,
} from '@/modules/specialists/types';
import { CONFIG } from '@/config/config';
import { execFile } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import { buildBookingLifecyclePatch } from '@/modules/bookings/utils/lifecycle';

export interface SpecialistAppointmentQuery {
  view: 'day' | 'month' | 'all';
  date?: string;
  yearMonth?: string;
  page?: number;
  limit?: number;
}

export interface SpecialistAppointmentDetails {
  booking: IBooking;
  patient: ReturnType<SpecialistPortalService['toPatientSummary']>;
}

interface CreateAppointmentPrescriptionRequest {
  diagnosis: string;
  medicines?: IBookingPrescriptionMedicine[];
  testsAdvised?: string[];
  advice: string;
  message?: string;
}

@Service()
export class SpecialistPortalService {
  constructor(
    private slotService: SlotService,
    private slotRepository: SlotRepository,
    private bookingRepository: BookingRepository,
    private bookingService: BookingService,
    private userRepository: UserRepository,
    private specialistService: SpecialistService,
    private notificationService: NotificationService
  ) {}

  private readonly execFileAsync = promisify(execFile);

  private buildLifecyclePatch(
    current: IBooking['lifecycle'],
    updates: Parameters<typeof buildBookingLifecyclePatch>[1]
  ) {
    return buildBookingLifecyclePatch(current, updates);
  }

  async getProfile(specialistId: string): Promise<ISpecialist> {
    return this.specialistService.getById(specialistId);
  }

  async updateProfile(
    specialistId: string,
    body: UpdateSpecialistRequest
  ): Promise<ISpecialist> {
    if (
      body !== null &&
      typeof body === 'object' &&
      ['isVerified', 'isActive', 'rating'].some((field) =>
        Object.prototype.hasOwnProperty.call(body, field)
      )
    ) {
      await this.specialistService.getById(specialistId);
      throw new AppError({
        status: 422,
        code: 'FORBIDDEN_FIELD',
        message: 'Specialist profile contains fields that cannot be updated',
      });
    }

    return this.specialistService.update(specialistId, body);
  }

  async createSlot(
    specialistId: string,
    body: Omit<CreateSlotRequest, 'specialistId' | 'wellnessPackageId'>
  ): Promise<ISlot[]> {
    const payload: CreateSlotRequest = {
      ...body,
      specialistId,
    };
    return this.slotService.create(payload);
  }

  async listSlots(specialistId: string, date?: string): Promise<ISlot[]> {
    return this.slotRepository.findManagedBySpecialistId(specialistId, date);
  }

  async updateSlot(
    specialistId: string,
    slotId: string,
    body: UpdateSlotRequest
  ): Promise<ISlot> {
    const slot = await this.slotRepository.findById(slotId);
    if (!slot || String(slot.specialistId) !== String(specialistId)) {
      throw new AppError({
        status: 404,
        code: 'SLOT_NOT_FOUND',
        message: 'Slot not found',
      });
    }
    return this.slotService.update(slotId, body);
  }

  async deleteSlot(specialistId: string, slotId: string): Promise<void> {
    const slot = await this.slotRepository.findById(slotId);
    if (!slot || String(slot.specialistId) !== String(specialistId)) {
      throw new AppError({
        status: 404,
        code: 'SLOT_NOT_FOUND',
        message: 'Slot not found',
      });
    }
    const hasBookings = (slot.currentBookings ?? 0) > 0;
    if (hasBookings) {
      throw new AppError({
        status: 400,
        code: 'SLOT_HAS_BOOKINGS',
        message: 'Cannot delete a slot that has active bookings',
      });
    }
    await this.slotService.delete(slotId);
  }

  async listAppointments(
    specialistId: string,
    query: SpecialistAppointmentQuery
  ): Promise<{
    data: IBooking[];
    total: number;
    page?: number;
    totalPages?: number;
  }> {
    if (query.view === 'day') {
      return this.bookingRepository.findConsultationsForSpecialist(
        specialistId,
        { bookingDate: query.date! }
      );
    }
    if (query.view === 'month') {
      return this.bookingRepository.findConsultationsForSpecialist(
        specialistId,
        { yearMonth: query.yearMonth! }
      );
    }
    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    return this.bookingRepository.findConsultationsForSpecialist(specialistId, {
      page,
      limit,
    });
  }

  async getAppointmentById(
    specialistId: string,
    bookingId: string
  ): Promise<SpecialistAppointmentDetails> {
    const booking = await this.bookingRepository.findById(bookingId);
    if (
      !booking ||
      booking.bookingType !== 'consultation' ||
      String(booking.specialistId) !== String(specialistId)
    ) {
      throw new AppError({
        status: 404,
        code: 'BOOKING_NOT_FOUND',
        message: 'Booking not found',
      });
    }

    const patient = await this.userRepository.findById(booking.userId);
    if (!patient) {
      throw new AppError({
        status: 404,
        code: 'USER_NOT_FOUND',
        message: 'Patient not found',
      });
    }

    return {
      booking,
      patient: this.toPatientSummary(patient),
    };
  }

  async updateAppointmentStatus(
    specialistId: string,
    bookingId: string,
    status: IBooking['status']
  ): Promise<IBooking> {
    const booking = await this.bookingRepository.findById(bookingId);
    if (
      !booking ||
      booking.bookingType !== 'consultation' ||
      String(booking.specialistId) !== String(specialistId)
    ) {
      throw new AppError({
        status: 404,
        code: 'BOOKING_NOT_FOUND',
        message: 'Booking not found',
      });
    }

    if (booking.status === 'cancelled' && status !== 'cancelled') {
      throw new AppError({
        status: 400,
        code: 'BOOKING_ALREADY_CANCELLED',
        message: 'Cancelled booking status cannot be changed',
      });
    }

    const updated = await this.bookingService.update(bookingId, {
      status,
      cancellationReason:
        status === 'cancelled' ? 'Cancelled by specialist' : undefined,
    });

    if (status === 'cancelled') {
      try {
        await this.notificationService.createSpecialistAppointmentCancelledNotification(
          specialistId,
          bookingId,
          {
            bookingType: booking.bookingType,
            bookingDate: booking.bookingDate,
            bookingTime: booking.bookingTime,
            userId: booking.userId,
          }
        );
      } catch (error) {
        console.error(
          'Failed to create specialist cancellation notification:',
          error
        );
      }
      return updated;
    }

    if (status === 'confirmed') {
      try {
        await this.notificationService.createSpecialistAppointmentConfirmedNotification(
          specialistId,
          bookingId,
          {
            bookingType: booking.bookingType,
            bookingDate: booking.bookingDate,
            bookingTime: booking.bookingTime,
            userId: booking.userId,
          }
        );
      } catch (error) {
        console.error(
          'Failed to create specialist confirmed notification:',
          error
        );
      }
    }

    if (status === 'completed') {
      try {
        await this.notificationService.createSpecialistAppointmentCompletedNotification(
          specialistId,
          bookingId,
          {
            bookingType: booking.bookingType,
            bookingDate: booking.bookingDate,
            bookingTime: booking.bookingTime,
            userId: booking.userId,
          }
        );
      } catch (error) {
        console.error(
          'Failed to create specialist completed notification:',
          error
        );
      }
    }

    return updated;
  }

  async createAppointmentPrescription(
    specialistId: string,
    bookingId: string,
    body: CreateAppointmentPrescriptionRequest
  ): Promise<IBooking> {
    const booking = await this.bookingRepository.findById(bookingId);
    if (
      !booking ||
      booking.bookingType !== 'consultation' ||
      String(booking.specialistId) !== String(specialistId)
    ) {
      throw new AppError({
        status: 404,
        code: 'BOOKING_NOT_FOUND',
        message: 'Booking not found',
      });
    }

    const specialist = await this.specialistService.getById(specialistId);
    const patient = await this.userRepository.findById(booking.userId);
    if (!patient) {
      throw new AppError({
        status: 404,
        code: 'USER_NOT_FOUND',
        message: 'Patient not found',
      });
    }

    const pdfUrl = await this.generatePrescriptionPdf({
      booking,
      patient,
      specialist,
      diagnosis: body.diagnosis,
      medicines: body.medicines || [],
      testsAdvised: body.testsAdvised || [],
      advice: body.advice,
    });

    const prescription: IBookingPrescription = {
      ...(booking.prescription || {}),
      fileUrls: [pdfUrl],
      message: body.message,
      diagnosis: body.diagnosis,
      advice: body.advice,
      medicines: body.medicines || [],
      testsAdvised: body.testsAdvised || [],
      prescribedAt: new Date().toISOString(),
      prescribedBySpecialistId: specialistId,
      prescribedBySpecialistName: specialist.name,
    };

    const updated = await this.bookingRepository.update(
      { _id: bookingId },
      {
        prescription,
        lifecycle: this.buildLifecyclePatch(booking.lifecycle, {
          prescriptionUploaded: true,
        }),
      }
    );
    if (!updated) {
      throw new AppError({
        status: 500,
        code: 'UPDATE_FAILED',
        message: 'Failed to save prescription',
      });
    }

    return updated;
  }

  async getPatientHistory(specialistId: string, patientUserId: string) {
    const bookings =
      await this.bookingRepository.findConsultationsBySpecialistAndUserId(
        specialistId,
        patientUserId
      );

    if (bookings.length === 0) {
      throw new AppError({
        status: 404,
        code: 'PATIENT_HISTORY_NOT_FOUND',
        message: 'No consultations with this patient',
      });
    }

    const user = await this.userRepository.findById(patientUserId);
    if (!user) {
      throw new AppError({
        status: 404,
        code: 'USER_NOT_FOUND',
        message: 'Patient not found',
      });
    }

    const patient = this.toPatientSummary(user);
    const consultations = bookings.map((b) =>
      this.toConsultationSummary(b)
    );

    return { patient, consultations };
  }

  private toPatientSummary(user: IUser) {
    return {
      userId: user._id,
      name: user.name,
      phone: user.phone,
      email: user.email,
      dateOfBirth: user.dateOfBirth,
      gender: user.gender,
      bloodGroup: user.bloodGroup,
      height: user.height,
      weight: user.weight,
      city: user.city,
      state: user.state,
      country: user.country,
      profilePictureUrl: user.profilePictureUrl,
    };
  }

  private toConsultationSummary(b: IBooking) {
    return {
      bookingId: b._id,
      bookingDate: b.bookingDate,
      bookingTime: b.bookingTime,
      status: b.status,
      paymentStatus: b.paymentStatus,
      primaryConcern: b.primaryConcern,
      consultationMode: b.consultationMode,
      serviceMode: b.serviceMode,
      price: b.price,
      notes: b.notes,
      prescription: b.prescription,
      report: b.report,
      documents: b.documents,
      followUp: b.followUp,
      virtualMeeting: b.virtualMeeting,
      dependentId: b.dependentId,
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
    };
  }

  private async generatePrescriptionPdf(input: {
    booking: IBooking;
    patient: IUser;
    specialist: ISpecialist;
    diagnosis: string;
    medicines: IBookingPrescriptionMedicine[];
    testsAdvised: string[];
    advice: string;
  }): Promise<string> {
    const uploadDir =
      CONFIG.UPLOAD_DIR || path.join(process.cwd(), 'files');
    const bookingId = String(input.booking._id);
    const bookingDir = path.join(uploadDir, 'bookings', bookingId);
    fs.mkdirSync(bookingDir, { recursive: true });

    const timestamp = Date.now();
    const htmlPath = path.join(
      os.tmpdir(),
      `prescription-${bookingId}-${timestamp}.html`
    );
    const pdfFileName = `prescription-${timestamp}.pdf`;
    const pdfPath = path.join(bookingDir, pdfFileName);

    try {
      fs.writeFileSync(htmlPath, this.buildPrescriptionHtml(input), 'utf8');
      await this.execFileAsync(
        process.env.WKHTMLTOPDF_BINARY || 'wkhtmltopdf',
        [htmlPath, pdfPath]
      );
      return `/api/static/bookings/${bookingId}/${pdfFileName}`;
    } catch (error: any) {
      throw new AppError({
        status: 500,
        code: 'PRESCRIPTION_PDF_GENERATION_FAILED',
        message:
          error?.message ||
          'Failed to generate prescription PDF',
      });
    } finally {
      try {
        fs.unlinkSync(htmlPath);
      } catch (_error) {
        // Ignore temp cleanup errors.
      }
    }
  }

  private buildPrescriptionHtml(input: {
    booking: IBooking;
    patient: IUser;
    specialist: ISpecialist;
    diagnosis: string;
    medicines: IBookingPrescriptionMedicine[];
    testsAdvised: string[];
    advice: string;
  }): string {
    const patientName = this.escapeHtml(input.patient.name || 'Patient');
    const specialistName = this.escapeHtml(input.specialist.name || 'Specialist');
    const age = this.calculateAge(input.patient.dateOfBirth);
    const ageText = age !== null ? `Age ${age}` : 'Age N/A';
    const appointmentId = this.escapeHtml(`APT-${String(input.booking._id).slice(-4).toUpperCase()}`);
    const appointmentDate = this.escapeHtml(this.formatDisplayDate(input.booking.bookingDate));
    const diagnosis = this.escapeHtml(input.diagnosis);
    const advice = this.escapeHtml(input.advice).replace(/\n/g, '<br />');

    const medicinesHtml =
      input.medicines.length > 0
        ? input.medicines
            .map((medicine) => {
              const name = this.escapeHtml(medicine.name);
              const details = [
                medicine.dosage ? `Dosage: ${this.escapeHtml(medicine.dosage)}` : '',
                medicine.frequency
                  ? `Frequency: ${this.escapeHtml(medicine.frequency)}`
                  : '',
                medicine.instructions
                  ? `Instructions: ${this.escapeHtml(medicine.instructions)}`
                  : '',
                medicine.duration
                  ? `Duration: ${this.escapeHtml(medicine.duration)}`
                  : '',
              ]
                .filter(Boolean)
                .join('<br />');

              return `
                <div class="medicine">
                  <div class="medicine-name">${name}</div>
                  <div class="medicine-meta">${details || 'No additional instructions'}</div>
                </div>
              `;
            })
            .join('')
        : '<div class="card">No medicines prescribed.</div>';

    const testsHtml =
      input.testsAdvised.length > 0
        ? input.testsAdvised
            .map((test) => `<span class="tag">${this.escapeHtml(test)}</span>`)
            .join('')
        : '<div class="card">No tests advised.</div>';

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>Prescription</title>
  <style>
    body { margin: 0; padding: 32px; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; color: #1f2937; background: #f3f7fb; }
    .page { max-width: 760px; margin: 0 auto; background: #ffffff; border: 1px solid #dbe7f3; border-radius: 20px; overflow: hidden; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.08); }
    .header { padding: 28px 32px 20px; background: linear-gradient(135deg, #2b6cb0, #3b82f6); color: #ffffff; }
    .brand { font-size: 14px; letter-spacing: 0.12em; text-transform: uppercase; opacity: 0.92; margin-bottom: 10px; }
    .title { font-size: 30px; font-weight: 700; margin: 0 0 8px; }
    .subtitle { font-size: 15px; margin: 0; opacity: 0.9; }
    .meta { display: table; width: 100%; table-layout: fixed; border-bottom: 1px solid #e5edf5; background: #f8fbff; }
    .meta-row { display: table-row; }
    .meta-cell { display: table-cell; padding: 18px 24px; vertical-align: top; border-right: 1px solid #e5edf5; }
    .meta-cell:last-child { border-right: 0; }
    .label { font-size: 11px; letter-spacing: 0.08em; text-transform: uppercase; color: #64748b; margin-bottom: 6px; font-weight: 700; }
    .value { font-size: 17px; font-weight: 600; color: #0f172a; }
    .content { padding: 28px 32px 18px; }
    .section { margin-bottom: 28px; }
    .section h2 { margin: 0 0 12px; font-size: 18px; color: #1d4ed8; }
    .card { background: #f8fbff; border: 1px solid #dbe7f3; border-radius: 14px; padding: 16px 18px; line-height: 1.6; font-size: 15px; }
    .medicine { border: 1px solid #dbe7f3; border-radius: 14px; padding: 16px 18px; margin-bottom: 12px; background: #ffffff; }
    .medicine-name { font-size: 17px; font-weight: 700; margin-bottom: 6px; color: #111827; }
    .medicine-meta { font-size: 14px; color: #475569; line-height: 1.6; }
    .tags { margin: 0; padding: 0; }
    .tag { display: inline-block; margin: 0 8px 8px 0; padding: 8px 12px; border-radius: 999px; background: #edf9ef; color: #1f7a35; border: 1px solid #b7e4c0; font-size: 14px; font-weight: 600; }
    .footer { border-top: 1px solid #e5edf5; padding: 20px 32px 28px; font-size: 13px; color: #64748b; }
    .footer strong { color: #334155; }
  </style>
</head>
<body>
  <div class="page">
    <div class="header">
      <div class="brand">MyEwaCare</div>
      <h1 class="title">Medical Prescription</h1>
      <p class="subtitle">Consultation booking prescription summary</p>
    </div>
    <div class="meta">
      <div class="meta-row">
        <div class="meta-cell">
          <div class="label">Patient</div>
          <div class="value">${patientName}</div>
        </div>
        <div class="meta-cell">
          <div class="label">${age !== null ? 'Age' : 'Patient Age'}</div>
          <div class="value">${this.escapeHtml(ageText)}</div>
        </div>
        <div class="meta-cell">
          <div class="label">Appointment</div>
          <div class="value">${appointmentId}</div>
        </div>
        <div class="meta-cell">
          <div class="label">Date</div>
          <div class="value">${appointmentDate}</div>
        </div>
      </div>
    </div>
    <div class="content">
      <div class="section">
        <h2>Diagnosis / Chief Complaint</h2>
        <div class="card">${diagnosis}</div>
      </div>
      <div class="section">
        <h2>Medicines</h2>
        ${medicinesHtml}
      </div>
      <div class="section">
        <h2>Tests Advised</h2>
        <div class="tags">${testsHtml}</div>
      </div>
      <div class="section">
        <h2>Doctor's Advice / Follow-up</h2>
        <div class="card">${advice}</div>
      </div>
    </div>
    <div class="footer">
      <strong>Prescribed by:</strong> ${specialistName}<br />
      Booking Time: ${this.escapeHtml(input.booking.bookingTime)}
    </div>
  </div>
</body>
</html>`;
  }

  private formatDisplayDate(date: string): string {
    if (!date || date.length !== 8) {
      return date || 'N/A';
    }

    const year = Number(date.slice(0, 4));
    const month = Number(date.slice(4, 6));
    const day = Number(date.slice(6, 8));
    const value = new Date(year, month - 1, day);
    if (Number.isNaN(value.getTime())) {
      return date;
    }

    return value.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  }

  private calculateAge(dateOfBirth?: string): number | null {
    if (!dateOfBirth || dateOfBirth.length !== 8) {
      return null;
    }

    const year = Number(dateOfBirth.slice(0, 4));
    const month = Number(dateOfBirth.slice(4, 6));
    const day = Number(dateOfBirth.slice(6, 8));
    const dob = new Date(year, month - 1, day);
    if (Number.isNaN(dob.getTime())) {
      return null;
    }

    const today = new Date();
    let age = today.getFullYear() - dob.getFullYear();
    const monthDiff = today.getMonth() - dob.getMonth();
    if (
      monthDiff < 0 ||
      (monthDiff === 0 && today.getDate() < dob.getDate())
    ) {
      age -= 1;
    }

    return age;
  }

  private escapeHtml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
}
