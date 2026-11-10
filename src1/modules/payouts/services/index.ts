import { Service } from 'typedi';
import mongoose from 'mongoose';
import fs from 'fs';
import path from 'path';
import { CONFIG } from '@/config/config';
import { BookingRepository } from '@/modules/bookings/repository';
import BookingModel from '@/modules/bookings/model';
import { SpecialistRepository } from '@/modules/specialists/repository';
import {
  PayoutBillingModel,
  PayoutDisbursalModel,
  PayoutSummaryModel,
} from '@/modules/payouts/model';
import {
  CreateAllPayoutsRequest,
  CreatePayoutDisbursalRequest,
  FetchPayoutBillingsRequest,
  GetPayoutInvoiceRequest,
  GetPayoutReceiptRequest,
  IPayoutBilling,
  IPayoutDisbursal,
  IPayoutSummary,
  PayoutActivitySummaryRequest,
  PayoutGridRow,
  PayoutDisbursalHistoryRequest,
  UpdatePayoutDisbursalRequest,
  CalculatePayoutBillingsRequest,
  CalculatePayoutBillingsByYearRequest,
} from '@/modules/payouts/types';
import { AppError } from '@/modules/common/types';

@Service()
export class PayoutService {
  constructor(
    private bookingRepository: BookingRepository,
    private specialistRepository: SpecialistRepository
  ) {}

  private getSpecialistId(body: {
    specialist_id?: string;
    consultant_id?: string;
  }): string {
    const specialistId = body.specialist_id || body.consultant_id;
    if (!specialistId) {
      throw new AppError({
        status: 400,
        code: 'SPECIALIST_ID_REQUIRED',
        message: 'Specialist ID is required',
      });
    }
    return specialistId;
  }

  private monthRange(month: number): { from: string; to: string } {
    const monthStr = String(month);
    const year = parseInt(monthStr.slice(0, 4), 10);
    const monthNumber = parseInt(monthStr.slice(4, 6), 10);
    const start = new Date(year, monthNumber - 1, 1);
    const end = new Date(year, monthNumber, 0);
    const fmt = (d: Date) =>
      `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(
        d.getDate()
      ).padStart(2, '0')}`;
    return { from: fmt(start), to: fmt(end) };
  }

  private unixRangeToYyyymmdd(
    fromDate?: number,
    tillDate?: number
  ): { from?: string; to?: string } {
    const fmt = (value: number) => {
      const d = new Date(value * 1000);
      return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(
        d.getDate()
      ).padStart(2, '0')}`;
    };

    return {
      from: fromDate ? fmt(fromDate) : undefined,
      to: tillDate ? fmt(tillDate) : undefined,
    };
  }

  private sanitizeFileName(name: string): string {
    return name.replace(/[^a-zA-Z0-9-_]/g, '-');
  }

  private ensureDir(dirPath: string): void {
    fs.mkdirSync(dirPath, { recursive: true });
  }

  private async ensureSpecialistExists(specialistId: string) {
    const specialist = await this.specialistRepository.findById(specialistId);
    if (!specialist) {
      throw new AppError({
        status: 404,
        code: 'SPECIALIST_NOT_FOUND',
        message: 'Specialist not found',
      });
    }
    return specialist;
  }

  private async calculateBillingSnapshot(
    specialistId: string,
    month: number
  ): Promise<Pick<
    IPayoutBilling,
    | 'totalAppointments'
    | 'totalPatients'
    | 'totalUniquePatients'
    | 'totalFollowUpAppointments'
    | 'total'
  >> {
    const { from, to } = this.monthRange(month);

    const stats = await this.bookingRepository.getConsultationStatsBySpecialistId(
      specialistId,
      { from, to }
    );

    const [amount] = await BookingModel.aggregate([
      {
        $match: {
          specialistId,
          bookingType: 'consultation',
          paymentStatus: 'paid',
          status: { $ne: 'cancelled' },
          bookingDate: {
            $gte: from,
            $lte: to,
          },
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$price' },
        },
      },
    ]);

    return {
      totalAppointments: stats.totalAppointments,
      totalPatients: stats.totalPatients,
      totalUniquePatients: stats.totalUniquePatients,
      totalFollowUpAppointments: stats.totalFollowUpAppointments,
      total: amount?.total || 0,
    };
  }

  private async syncSummaryForSpecialist(
    specialistId: string
  ): Promise<IPayoutSummary> {
    const [billingTotal] = await PayoutBillingModel.aggregate([
      {
        $match: {
          specialistId,
        },
      },
      {
        $group: {
          _id: null,
          total: { $sum: '$total' },
          paid: { $sum: '$paid' },
          due: { $sum: '$due' },
        },
      },
    ]);

    const latestDisbursal = await PayoutDisbursalModel.findOne({ specialistId })
      .sort({ disbursalDate: -1 })
      .lean();

    const summary = await PayoutSummaryModel.findOneAndUpdate(
      { specialistId },
      {
        $set: {
          total: billingTotal?.total || 0,
          paid: billingTotal?.paid || 0,
          due: billingTotal?.due || 0,
          lastDisbursalDate: latestDisbursal?.disbursalDate,
        },
      },
      { upsert: true, new: true }
    ).lean();

    return summary as IPayoutSummary;
  }

  private buildReceiptMonths(billings: Array<Pick<IPayoutBilling, 'month'>>) {
    return billings
      .map((billing) => {
        const month = String(billing.month);
        return `${month.slice(0, 4)}-${month.slice(4, 6)}`;
      })
      .join(', ');
  }

  private writeHtmlAsset(
    relativePath: string,
    html: string
  ): string {
    const uploadDir = CONFIG.UPLOAD_DIR || path.join(process.cwd(), 'files');
    const fullPath = path.join(uploadDir, relativePath);
    this.ensureDir(path.dirname(fullPath));
    fs.writeFileSync(fullPath, html, 'utf8');
    return `/api/static/${relativePath}`;
  }

  private buildInvoiceHtml(input: {
    specialistName: string;
    month: number;
    billing: IPayoutBilling;
  }): string {
    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Payout Invoice ${input.month}</title>
    <style>
      body { font-family: Arial, sans-serif; padding: 24px; color: #1f2937; }
      h1 { margin: 0 0 16px; }
      table { width: 100%; border-collapse: collapse; margin-top: 16px; }
      td, th { border: 1px solid #d1d5db; padding: 10px; text-align: left; }
      .muted { color: #6b7280; }
    </style>
  </head>
  <body>
    <h1>Specialist Billing Invoice</h1>
    <p class="muted">Specialist: ${input.specialistName}</p>
    <p class="muted">Month: ${input.month}</p>
    <table>
      <tr><th>Total Appointments</th><td>${input.billing.totalAppointments}</td></tr>
      <tr><th>Total Patients</th><td>${input.billing.totalPatients}</td></tr>
      <tr><th>Total Unique Patients</th><td>${input.billing.totalUniquePatients}</td></tr>
      <tr><th>Total Follow Up Appointments</th><td>${input.billing.totalFollowUpAppointments}</td></tr>
      <tr><th>Total Amount</th><td>${input.billing.total}</td></tr>
      <tr><th>Paid</th><td>${input.billing.paid}</td></tr>
      <tr><th>Due</th><td>${input.billing.due}</td></tr>
      <tr><th>Status</th><td>${input.billing.status}</td></tr>
    </table>
  </body>
</html>`;
  }

  private buildReceiptHtml(input: {
    specialistName: string;
    disbursal: IPayoutDisbursal;
    billings: IPayoutBilling[];
  }): string {
    const notes = String(input.disbursal.extraDetails?.notes || '');
    const receipts = Array.isArray(input.disbursal.extraDetails?.receipts)
      ? (input.disbursal.extraDetails?.receipts as string[])
      : [];
    return `<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>Payout Receipt ${input.disbursal._id}</title>
    <style>
      body { font-family: Arial, sans-serif; padding: 24px; color: #1f2937; }
      h1 { margin: 0 0 16px; }
      ul { padding-left: 20px; }
      .muted { color: #6b7280; }
    </style>
  </head>
  <body>
    <h1>Specialist Payout Receipt</h1>
    <p class="muted">Specialist: ${input.specialistName}</p>
    <p class="muted">Amount: ${input.disbursal.disbursalAmount}</p>
    <p class="muted">Date: ${input.disbursal.disbursalDate}</p>
    <p class="muted">Months: ${this.buildReceiptMonths(input.billings)}</p>
    <h2>Notes</h2>
    <p>${notes || 'No notes'}</p>
    <h2>Receipts</h2>
    <ul>
      ${receipts.map((url) => `<li><a href="${url}">${url}</a></li>`).join('') || '<li>No receipts attached</li>'}
    </ul>
  </body>
</html>`;
  }

  async getActivitySummaryAll(body: PayoutActivitySummaryRequest) {
    const isConsultant = body.isConsultant !== false;
    const range = this.unixRangeToYyyymmdd(body.fromDate, body.tillDate);

    if (isConsultant) {
      const specialists = await this.specialistRepository.findAll(
        { isActive: true },
        { sort: { name: 1 } }
      );

      const rows = await Promise.all(
        specialists.map(async (specialist) => {
          const stats =
            await this.bookingRepository.getConsultationStatsBySpecialistId(
              String(specialist._id),
              {
                from: range.from,
                to: range.to,
              }
            );
          const snapshot = await this.calculateBillingSnapshot(
            String(specialist._id),
            parseInt(
              `${range.from?.slice(0, 6) || new Date().getFullYear() * 100 + 1}`,
              10
            )
          ).catch(() => null);
          return {
            id: specialist._id,
            name: specialist.name,
            email: specialist.email,
            phone: specialist.phone,
            totalTransactions: stats.totalAppointments,
            totalPatients: stats.totalPatients,
            totalUniquePatients: stats.totalUniquePatients,
            totalFollowUpAppointments: stats.totalFollowUpAppointments,
            amount: snapshot?.total || 0,
          };
        })
      );

      return rows;
    }

    const query: Record<string, unknown> = {
      bookingType: 'consultation',
    };

    if (range.from || range.to) {
      query.bookingDate = {} as Record<string, string>;
      if (range.from) (query.bookingDate as Record<string, string>).$gte = range.from;
      if (range.to) (query.bookingDate as Record<string, string>).$lte = range.to;
    }

    return BookingModel.aggregate([
      { $match: query },
      {
        $group: {
          _id: '$userId',
          totalTransactions: { $sum: 1 },
          totalAmount: { $sum: '$price' },
        },
      },
      {
        $project: {
          _id: 0,
          id: '$_id',
          totalTransactions: 1,
          amount: '$totalAmount',
        },
      },
    ]);
  }

  async fetchBillings(body: FetchPayoutBillingsRequest) {
    const specialistId = this.getSpecialistId(body);
    await this.ensureSpecialistExists(specialistId);
    const startMonth = Number(`${body.year}01`);
    const endMonth = Number(`${body.year}12`);
    return PayoutBillingModel.find({
      specialistId,
      month: { $gte: startMonth, $lte: endMonth },
    })
      .sort({ month: 1 })
      .lean();
  }

  async calculateBillings(body: CalculatePayoutBillingsRequest) {
    const specialistId = this.getSpecialistId(body);
    await this.ensureSpecialistExists(specialistId);

    const results: IPayoutBilling[] = [];

    for (const month of body.months) {
      const snapshot = await this.calculateBillingSnapshot(specialistId, month);
      const existing = await PayoutBillingModel.findOne({ specialistId, month }).lean();
      const paid = existing?.paid || 0;
      const effectiveTotal = Math.max(snapshot.total, paid);
      const due = Math.max(effectiveTotal - paid, 0);
      const status = due === 0 ? 'Paid' : paid > 0 ? 'Partially Paid' : 'Unpaid';

      const updated = await PayoutBillingModel.findOneAndUpdate(
        { specialistId, month },
        {
          $set: {
            specialistId,
            month,
            totalAppointments: snapshot.totalAppointments,
            totalPatients: snapshot.totalPatients,
            totalUniquePatients: snapshot.totalUniquePatients,
            totalFollowUpAppointments: snapshot.totalFollowUpAppointments,
            total: effectiveTotal,
            paid,
            due,
            status,
          },
        },
        { upsert: true, new: true }
      ).lean();

      results.push(updated as IPayoutBilling);
    }

    await this.syncSummaryForSpecialist(specialistId);
    return results;
  }

  async calculateBillingsByYear(body: CalculatePayoutBillingsByYearRequest) {
    const specialistId = this.getSpecialistId(body);
    await this.ensureSpecialistExists(specialistId);
    const months = Array.from({ length: 12 }, (_, index) =>
      Number(`${body.year}${String(index + 1).padStart(2, '0')}`)
    );
    const existing = await PayoutBillingModel.find({
      specialistId,
      month: { $gte: Number(`${body.year}01`), $lte: Number(`${body.year}12`) },
    })
      .select('month')
      .lean();
    const existingMonths = new Set(existing.map((item) => item.month));
    const missingMonths = months.filter((month) => !existingMonths.has(month));

    if (missingMonths.length === 0) {
      return [];
    }

    return this.calculateBillings({
      specialist_id: specialistId,
      months: missingMonths,
    });
  }

  async createDisbursal(
    body: CreatePayoutDisbursalRequest,
    actor: { _id: string }
  ) {
    const specialistId = this.getSpecialistId(body);
    await this.ensureSpecialistExists(specialistId);

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      const billings = await PayoutBillingModel.find({
        _id: { $in: body.billing_ids },
        specialistId,
      })
        .sort({ month: 1 })
        .session(session);

      if (billings.length !== body.billing_ids.length) {
        throw new AppError({
          status: 404,
          code: 'INVALID_BILLING_SELECTION',
          message: 'Invalid billing selection',
        });
      }

      const totalDue = billings.reduce((sum, billing) => sum + billing.due, 0);
      if (body.disbursal_amount > totalDue) {
        throw new AppError({
          status: 400,
          code: 'DISBURSAL_AMOUNT_EXCEEDS_DUE',
          message: 'Disbursal amount exceeds selected billings total due',
        });
      }

      let remaining = body.disbursal_amount;
      for (const billing of billings) {
        if (remaining <= 0) {
          break;
        }
        const currentDue = billing.due;
        const pay = Math.min(currentDue, remaining);
        remaining -= pay;
        billing.paid += pay;
        billing.due = currentDue - pay;
        billing.status =
          billing.due === 0 ? 'Paid' : billing.paid > 0 ? 'Partially Paid' : 'Unpaid';
        await billing.save({ session });
      }

      const [disbursal] = await PayoutDisbursalModel.create(
        [
          {
            billingIds: body.billing_ids,
            specialistId,
            disbursalAmount: body.disbursal_amount,
            disbursalDate:
              body.disbursal_date || Math.floor(Date.now() / 1000),
            extraDetails: body.extra_details || {},
            createdByAdminId: actor._id,
          },
        ],
        { session }
      );

      await session.commitTransaction();
      await this.syncSummaryForSpecialist(specialistId);
      return disbursal.toObject();
    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  async getDisbursalHistory(body: PayoutDisbursalHistoryRequest) {
    const specialistId = this.getSpecialistId(body);
    await this.ensureSpecialistExists(specialistId);
    return PayoutDisbursalModel.find({ specialistId })
      .populate({
        path: 'billingIds',
        model: 'PayoutBilling',
      })
      .sort({ disbursalDate: -1 })
      .lean();
  }

  async updateDisbursal(body: UpdatePayoutDisbursalRequest) {
    const existing = await PayoutDisbursalModel.findById(body._id).lean();
    if (!existing) {
      throw new AppError({
        status: 404,
        code: 'DISBURSAL_NOT_FOUND',
        message: 'Disbursal not found',
      });
    }

    const mergedExtraDetails = {
      ...(existing.extraDetails || {}),
      ...(body.extra_details || {}),
    };

    return PayoutDisbursalModel.findByIdAndUpdate(
      body._id,
      {
        $set: {
          extraDetails: mergedExtraDetails,
        },
      },
      { new: true }
    ).lean();
  }

  async getGrid(search?: string): Promise<PayoutGridRow[]> {
    const summaries = await PayoutSummaryModel.find({})
      .sort({ updatedAt: -1 })
      .lean();

    const specialistIds = summaries.map((item) => item.specialistId);
    const specialists = await this.specialistRepository.findAll(
      { _id: { $in: specialistIds } as any },
      {}
    );
    const specialistMap = new Map(
      specialists.map((specialist) => [String(specialist._id), specialist])
    );

    const rows = summaries
      .map((summary) => {
        const specialist = specialistMap.get(summary.specialistId);
        if (!specialist) {
          return null;
        }
        return {
          specialistId: summary.specialistId,
          name: specialist.name,
          email: specialist.email,
          phone: specialist.phone,
          specialization: specialist.specialization,
          total: summary.total,
          paid: summary.paid,
          due: summary.due,
          lastDisbursalDate: summary.lastDisbursalDate,
        };
      })
      .filter(Boolean) as PayoutGridRow[];

    if (!search?.trim()) {
      return rows;
    }

    const q = search.trim().toLowerCase();
    return rows.filter((row) =>
      [row.name, row.email, row.phone, row.specialization]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q))
    );
  }

  async createAll(body: CreateAllPayoutsRequest) {
    const specialists = await this.specialistRepository.findAll(
      { isActive: true, isVerified: true },
      {}
    );
    const results = await Promise.all(
      specialists.map((specialist) =>
        this.calculateBillings({
          specialist_id: String(specialist._id),
          months: [body.month],
        })
      )
    );
    return {
      processed: specialists.length,
      results,
    };
  }

  async getInvoice(body: GetPayoutInvoiceRequest) {
    const specialistId = this.getSpecialistId(body);
    const specialist = await this.ensureSpecialistExists(specialistId);
    const billing = await PayoutBillingModel.findOne({
      specialistId,
      month: body.month,
    }).lean();

    if (!billing) {
      throw new AppError({
        status: 404,
        code: 'BILLING_NOT_FOUND',
        message: 'Billing not found',
      });
    }

    if (billing.invoiceUrl) {
      return { invoice_url: billing.invoiceUrl };
    }

    const safeName = this.sanitizeFileName(specialist.name || specialistId);
    const relativePath = `payouts/invoices/${safeName}/${body.month}.html`;
    const invoiceUrl = this.writeHtmlAsset(
      relativePath,
      this.buildInvoiceHtml({
        specialistName: specialist.name || 'Specialist',
        month: body.month,
        billing,
      })
    );

    await PayoutBillingModel.updateOne(
      { _id: billing._id },
      { $set: { invoiceUrl } }
    );

    return { invoice_url: invoiceUrl };
  }

  async getReceipt(body: GetPayoutReceiptRequest) {
    const disbursal = await PayoutDisbursalModel.findById(body.disbursal_id).lean();
    if (!disbursal) {
      throw new AppError({
        status: 404,
        code: 'DISBURSAL_NOT_FOUND',
        message: 'Disbursal not found',
      });
    }

    if (disbursal.receiptUrl) {
      return { invoice_url: disbursal.receiptUrl };
    }

    const specialist = await this.ensureSpecialistExists(disbursal.specialistId);
    const billings = await PayoutBillingModel.find({
      _id: { $in: disbursal.billingIds },
    }).lean();
    const relativePath = `payouts/receipts/${disbursal._id}.html`;
    const receiptUrl = this.writeHtmlAsset(
      relativePath,
      this.buildReceiptHtml({
        specialistName: specialist.name || 'Specialist',
        disbursal: disbursal as IPayoutDisbursal,
        billings: billings as IPayoutBilling[],
      })
    );

    await PayoutDisbursalModel.updateOne(
      { _id: disbursal._id },
      { $set: { receiptUrl } }
    );

    return { invoice_url: receiptUrl };
  }
}
