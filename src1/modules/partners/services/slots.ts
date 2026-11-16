import { ClientSession } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { runLedgerTransaction } from '@/modules/common/utils/bookingWalletFunding';
import BranchModel from '@/modules/partners/model/branch';
import {
  PartnerSlotModel,
  PartnerSlotTemplateModel,
  ScheduleGuardModel,
  IPartnerSlot,
  IPartnerSlotTemplate,
  ISlotWindow,
  VisitMode,
  Weekday,
  WEEKDAYS,
} from '@/modules/partners/model/slot';
import { PartnerActor, assertBranchInScope, inTransaction, recordPartnerAudit } from '@/modules/partners/services';

const IST_OFFSET_MIN = 330;
export const ROLLING_DAYS = 30;

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const toHHMM = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

/** A real calendar date YYYY-MM-DD (2027-02-31 is not one: it would silently become 3 March). */
export function isRealDate(date: unknown): date is string {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y!, m! - 1, d!));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m! - 1 && t.getUTCDate() === d;
}

export function assertRealDate(date: unknown, field = 'date'): asserts date is string {
  if (!isRealDate(date)) throw new AppError({ status: 400, code: 'INVALID_DATE', message: `${field} must be a real date (YYYY-MM-DD)` });
}

/** Creates the guard once, outside any transaction (two transactions creating it together would clash on the key). */
export async function ensureScheduleGuard(key: string): Promise<void> {
  try {
    await ScheduleGuardModel.updateOne({ key }, { $setOnInsert: { key, version: 0 } }, { upsert: true });
  } catch (e: any) {
    if (e?.code !== 11000) throw e;
  }
}

/** Bumps a schedule's guard inside the caller's transaction (see ScheduleGuardModel); ensureScheduleGuard first. */
export async function bumpScheduleGuard(key: string, s: ClientSession): Promise<void> {
  const r = await ScheduleGuardModel.updateOne({ key }, { $inc: { version: 1 } }, { session: s });
  if (r.matchedCount !== 1) throw Object.assign(new AppError({ status: 409, code: 'SCHEDULE_GUARD_MISSING', message: 'Schedule not ready; retry' }), { retryable: true });
}
export const labScheduleKey = (branchId: string, visitMode: VisitMode) => `partner-slots:${branchId}:${visitMode}`;

/** UTC instant of an India-time date + HH:mm. */
export function istInstant(date: string, hhmm: string): Date {
  const [y, mo, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y!, mo! - 1, d!, 0, 0) + (toMinutes(hhmm) - IST_OFFSET_MIN) * 60_000);
}

/** India-time calendar date of an instant, YYYY-MM-DD. */
export function istDate(at: Date): string {
  return new Date(at.getTime() + IST_OFFSET_MIN * 60_000).toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
  const t = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10))) + n * 86_400_000;
  return new Date(t).toISOString().slice(0, 10);
}

function weekdayOf(date: string): Weekday {
  const t = Date.UTC(Number(date.slice(0, 4)), Number(date.slice(5, 7)) - 1, Number(date.slice(8, 10)));
  return WEEKDAYS[new Date(t).getUTCDay()]!;
}

/** Slot start/end times a template gives for one weekday (whole slots only, windows may not overlap). */
export function slotTimesFor(template: Pick<IPartnerSlotTemplate, 'slotMinutes' | 'days'>, day: Weekday): { start: string; end: string }[] {
  const out: { start: string; end: string }[] = [];
  for (const w of template.days[day] ?? []) {
    for (let m = toMinutes(w.start); m + template.slotMinutes <= toMinutes(w.end); m += template.slotMinutes) {
      out.push({ start: toHHMM(m), end: toHHMM(m + template.slotMinutes) });
    }
  }
  return out;
}

function validateWindows(days: Partial<Record<Weekday, ISlotWindow[]>>): void {
  for (const [day, windows] of Object.entries(days)) {
    const sorted = [...(windows ?? [])].sort((a, b) => toMinutes(a.start) - toMinutes(b.start));
    for (let i = 0; i < sorted.length; i++) {
      if (toMinutes(sorted[i]!.end) <= toMinutes(sorted[i]!.start)) {
        throw new AppError({ status: 400, code: 'INVALID_WINDOW', message: `${day}: a window must end after it starts` });
      }
      if (i > 0 && toMinutes(sorted[i]!.start) < toMinutes(sorted[i - 1]!.end)) {
        throw new AppError({ status: 400, code: 'OVERLAPPING_WINDOWS', message: `${day}: windows overlap` });
      }
    }
  }
}

async function branchFor(actor: PartnerActor, branchId: string, visitMode: VisitMode) {
  const branch = await BranchModel.findById(branchId).lean();
  if (!branch || String(branch.partnerId) !== actor.partnerId || branch.isActive === false) {
    throw new AppError({ status: 404, code: 'BRANCH_NOT_FOUND', message: 'Branch not found' });
  }
  assertBranchInScope(actor, branchId);
  const offered = visitMode === 'home' ? branch.services?.homeCollection : branch.services?.inLab;
  if (!offered) {
    throw new AppError({ status: 409, code: 'VISIT_MODE_NOT_OFFERED', message: `This branch does not offer ${visitMode === 'home' ? 'home collection' : 'lab visits'}` });
  }
  return branch;
}

export async function saveSlotTemplate(
  actor: PartnerActor,
  branchId: string,
  visitMode: VisitMode,
  input: { slotMinutes: number; capacity: number; days: Partial<Record<Weekday, ISlotWindow[]>>; expectedUpdatedAt?: Date | string | null },
  now = new Date()
): Promise<{ template: IPartnerSlotTemplate; expansion: ExpansionResult }> {
  await branchFor(actor, branchId, visitMode);
  validateWindows(input.days);
  await ensureScheduleGuard(labScheduleKey(branchId, visitMode));
  const { expectedUpdatedAt, ...content } = input;
  const template = await inTransaction(async (session) => {
    // Q11: optimistic version — `expectedUpdatedAt` is the saved template's updatedAt the editor started from (null when
    // it started from no template); a different current state refuses the save.
    if (expectedUpdatedAt !== undefined) {
      const cur = await PartnerSlotTemplateModel.findOne({ branchId, visitMode }).session(session).lean() as IPartnerSlotTemplate | null;
      const curAt = cur?.updatedAt ? new Date(cur.updatedAt).getTime() : null;
      const expAt = expectedUpdatedAt === null ? null : new Date(expectedUpdatedAt).getTime();
      if (curAt !== expAt) throw new AppError({ status: 409, code: 'TEMPLATE_CHANGED', message: 'The weekly template changed since you opened it; review it again' });
    }
    const t = await PartnerSlotTemplateModel.findOneAndUpdate(
      { branchId, visitMode },
      { $set: { partnerId: actor.partnerId, slotMinutes: content.slotMinutes, capacity: content.capacity, days: content.days, isActive: true } },
      { upsert: true, new: true, session }
    ).lean();
    await bumpScheduleGuard(labScheduleKey(branchId, visitMode), session);
    await recordPartnerAudit(actor, 'slots.template.save', { kind: 'branch', id: branchId }, { visitMode, ...content }, session);
    return t as IPartnerSlotTemplate;
  });
  const expansion = await expandSlots(branchId, visitMode, istDate(now), ROLLING_DAYS);
  return { template, expansion };
}

export interface ExpansionResult { inserted: number; updated: number; closed: number; reopened: number }

/**
 * Brings slots for [fromDate, fromDate+days) in line with the template and the branch holidays, under a per-schedule
 * lease (the template and branch are read after acquiring it, so a concurrent older run can never publish a stale
 * snapshot after a newer one). It inserts missing slots; makes unbooked generated slots match the template again
 * (end time, capacity); raises a booked slot's capacity to the template's but never below its bookings, and keeps its
 * time; closes holiday dates and generated slots no longer wanted (holds kept); reopens holiday closures (any slot) once
 * the holiday is gone and template closures that are wanted again. Never deletes a slot, never changes `booked`, never
 * reopens a manual closure. Idempotent.
 */
export async function expandSlots(branchId: string, visitMode: VisitMode, fromDate: string, days: number): Promise<ExpansionResult> {
  assertRealDate(fromDate, 'from');
  await ensureScheduleGuard(labScheduleKey(branchId, visitMode));
  // One transaction for the whole window: it bumps the schedule's guard first, so a concurrent expansion or a
  // configuration change (which bumps it too) can never commit interleaved with it — whichever loses is retried and
  // re-reads the configuration that won. No lease, nothing to expire.
  return runLedgerTransaction(async (s) => {
    await bumpScheduleGuard(labScheduleKey(branchId, visitMode), s);
    const result: ExpansionResult = { inserted: 0, updated: 0, closed: 0, reopened: 0 };
    const [template, branch] = await Promise.all([
      PartnerSlotTemplateModel.findOne({ branchId, visitMode }).session(s).lean(),
      BranchModel.findById(branchId).session(s).lean(),
    ]);
    if (!branch) return result;
    const holidays = new Set((branch.holidays ?? []).map(String).filter(isRealDate));
    // Without a template (manual slots only) nothing is generated, but holidays still close and reopen slots.
    const live = !!template?.isActive && branch.isActive !== false;
    for (let i = 0; i < days; i++) {
      const date = addDays(fromDate, i);
      const holiday = holidays.has(date);
      const wanted = template && live && !holiday ? slotTimesFor(template, weekdayOf(date)) : [];
      const starts = wanted.map((w) => w.start);
      if (wanted.length > 0 && template) {
        const ops = wanted.flatMap((w) => [
          { updateOne: {
            filter: { branchId, visitMode, date, startTime: w.start },
            update: { $setOnInsert: {
              partnerId: String(branch.partnerId), branchId, visitMode, date, startTime: w.start, endTime: w.end,
              startsAt: istInstant(date, w.start), endsAt: istInstant(date, w.end),
              capacity: template.capacity, booked: 0, closed: null, source: 'template',
            } },
            upsert: true,
          } },
          { updateOne: {
            filter: { branchId, visitMode, date, startTime: w.start, source: 'template', booked: 0,
              $or: [{ endTime: { $ne: w.end } }, { capacity: { $ne: template.capacity } }] },
            update: { $set: { endTime: w.end, endsAt: istInstant(date, w.end), capacity: template.capacity } },
          } },
          { updateOne: {
            filter: { branchId, visitMode, date, startTime: w.start, source: 'template', booked: { $gt: 0 }, capacity: { $ne: template.capacity } },
            update: [{ $set: { capacity: { $max: ['$booked', template.capacity] } } }],
          } },
        ]);
        const r = await PartnerSlotModel.bulkWrite(ops as any, { ordered: true, session: s });
        result.inserted += r.upsertedCount;
        result.updated += r.modifiedCount;
      }
      if (!holiday) {
        const reopened = await PartnerSlotModel.updateMany(
          { branchId, visitMode, date, $or: [{ closed: 'holiday' }, { closed: 'template', source: 'template', startTime: { $in: starts } }] },
          { $set: { closed: null } }, { session: s }
        );
        result.reopened += reopened.modifiedCount;
      }
      const closed = await PartnerSlotModel.updateMany(
        { branchId, visitMode, date, closed: null, ...(holiday ? {} : { source: 'template', startTime: { $nin: starts } }) },
        { $set: { closed: holiday ? 'holiday' : 'template' } }, { session: s }
      );
      result.closed += closed.modifiedCount;
    }
    return result;
  });
}

/** Re-expands both visit modes of a branch (after its holidays, services or active state changed) — with or without a template. */
export async function expandBranchTemplates(branchId: string, now = new Date()): Promise<void> {
  for (const mode of ['lab', 'home'] as VisitMode[]) await expandSlots(branchId, mode, istDate(now), ROLLING_DAYS);
}

/** Daily rolling expansion for every active template (run by the scheduler). */
export async function expandAllRolling(now = new Date()): Promise<number> {
  let n = 0;
  for await (const t of PartnerSlotTemplateModel.find({ isActive: true }).lean().cursor() as AsyncIterable<IPartnerSlotTemplate>) {
    const r = await expandSlots(t.branchId, t.visitMode, istDate(now), ROLLING_DAYS);
    n += r.inserted;
  }
  return n;
}

async function slotFor(actor: PartnerActor, slotId: string): Promise<IPartnerSlot> {
  const slot = await PartnerSlotModel.findById(slotId).lean();
  if (!slot || slot.partnerId !== actor.partnerId) throw new AppError({ status: 404, code: 'SLOT_NOT_FOUND', message: 'Slot not found' });
  assertBranchInScope(actor, slot.branchId);
  return slot;
}

/** Capacity may change, but never below the seats already held. */
export async function setSlotCapacity(actor: PartnerActor, slotId: string, capacity: number): Promise<IPartnerSlot> {
  await slotFor(actor, slotId);
  return inTransaction(async (session) => {
    const updated = await PartnerSlotModel.findOneAndUpdate(
      { _id: slotId, partnerId: actor.partnerId, booked: { $lte: capacity } },
      { $set: { capacity } },
      { new: true, session }
    ).lean();
    if (!updated) throw new AppError({ status: 409, code: 'SLOT_CAPACITY_BELOW_BOOKED', message: 'Capacity cannot be lower than the seats already booked' });
    await recordPartnerAudit(actor, 'slots.capacity', { kind: 'slot', id: slotId }, { capacity }, session);
    return updated as IPartnerSlot;
  });
}

/** Q11: the saved weekly template of a branch and visit mode (null when none was saved). */
export async function getSlotTemplate(actor: PartnerActor, branchId: string, visitMode: VisitMode): Promise<IPartnerSlotTemplate | null> {
  await branchFor(actor, branchId, visitMode);
  return (await PartnerSlotTemplateModel.findOne({ branchId, visitMode, partnerId: actor.partnerId }).lean()) as IPartnerSlotTemplate | null;
}

/** Closing stops new bookings; existing holds stay. */
export async function setSlotClosed(actor: PartnerActor, slotId: string, close: boolean): Promise<IPartnerSlot> {
  await slotFor(actor, slotId);
  return inTransaction(async (session) => {
    // Q11: staff may close any slot (a staff closure outlasts a holiday), but reopen only what staff closed;
    // holiday/template closures follow the branch and template.
    const updated = await PartnerSlotModel.findOneAndUpdate(
      close ? { _id: slotId, partnerId: actor.partnerId } : { _id: slotId, partnerId: actor.partnerId, closed: 'manual' },
      { $set: { closed: close ? 'manual' : null } },
      { new: true, session }
    ).lean();
    if (!updated) {
      if (close) throw new AppError({ status: 404, code: 'SLOT_NOT_FOUND', message: 'Slot not found' });
      throw new AppError({ status: 409, code: 'SLOT_CLOSED_BY_SCHEDULE', message: 'Only slots closed by staff can be reopened here; holidays and the weekly template decide the others' });
    }
    await recordPartnerAudit(actor, close ? 'slots.close' : 'slots.reopen', { kind: 'slot', id: slotId }, undefined, session);
    return updated as IPartnerSlot;
  });
}

export async function addManualSlot(
  actor: PartnerActor,
  input: { branchId: string; visitMode: VisitMode; date: string; startTime: string; endTime: string; capacity: number; requestKey?: string }
): Promise<IPartnerSlot & { replayed?: boolean }> {
  const { requestKey, ...slotInput } = input;
  const keyed = async (): Promise<IPartnerSlot | null> => (requestKey ? await PartnerSlotModel.findOne({ partnerId: actor.partnerId, branchId: input.branchId,
    visitMode: input.visitMode, date: input.date, startTime: input.startTime, createRequestKey: requestKey }).lean() as IPartnerSlot | null : null);
  if (requestKey) {
    // Q11: an unchanged keyed retry gets its receipt under today's read authority (branch scope), even if the branch or
    // visit mode was turned off after the slot was made; the availability checks below apply to new slots only.
    assertBranchInScope(actor, input.branchId);
    const same = await keyed();
    if (same) return { ...same, replayed: true };
  }
  await branchFor(actor, input.branchId, input.visitMode);
  assertRealDate(input.date);
  if (toMinutes(input.endTime) <= toMinutes(input.startTime)) {
    throw new AppError({ status: 400, code: 'INVALID_WINDOW', message: 'A slot must end after it starts' });
  }
  try {
    return await inTransaction(async (session) => {
      const [slot] = await PartnerSlotModel.create([{
        partnerId: actor.partnerId, ...slotInput, ...(requestKey ? { createRequestKey: requestKey } : {}),
        startsAt: istInstant(input.date, input.startTime), endsAt: istInstant(input.date, input.endTime),
        booked: 0, closed: null, source: 'manual',
      }], { session });
      await recordPartnerAudit(actor, 'slots.add', { kind: 'slot', id: String(slot!._id) }, slotInput, session);
      return slot!.toObject() as IPartnerSlot;
    });
  } catch (e: any) {
    if (e?.code === 11000) {
      // Q11: the same keyed request again (its answer was lost) is answered with the slot it made.
      const same = await keyed();
      if (same) return { ...same, replayed: true };
      throw new AppError({ status: 409, code: 'SLOT_EXISTS', message: 'A slot already starts at that time' });
    }
    throw e;
  }
}

export async function listSlotsForPartner(actor: PartnerActor, branchId: string, visitMode: VisitMode, from: string, to: string): Promise<IPartnerSlot[]> {
  assertBranchInScope(actor, branchId);
  assertRealDate(from, 'from');
  assertRealDate(to, 'to');
  return PartnerSlotModel.find({ partnerId: actor.partnerId, branchId, visitMode, date: { $gte: from, $lte: to } })
    .sort({ startsAt: 1 }).limit(2000).lean();
}

/** What a customer can pick: open, not full, starting after `minStart`. */
export async function listBookableSlots(branchId: string, visitMode: VisitMode, from: string, to: string, minStart: Date): Promise<IPartnerSlot[]> {
  assertRealDate(from, 'from');
  assertRealDate(to, 'to');
  return PartnerSlotModel.find({
    branchId, visitMode, date: { $gte: from, $lte: to }, closed: null, startsAt: { $gt: minStart },
    $expr: { $lt: ['$booked', '$capacity'] },
  }).sort({ startsAt: 1 }).limit(500).lean();
}

/** Takes one seat inside the caller's transaction, or fails (closed, full, or starting too soon). */
export async function takeSeat(slotId: string, expect: { partnerId: string; branchId: string; visitMode: VisitMode; minStart: Date }, session: ClientSession): Promise<IPartnerSlot> {
  // The branch's current holidays are enforced here too, whatever any expansion has (or has not yet) closed.
  const branch = await BranchModel.findById(expect.branchId).select({ holidays: 1, isActive: 1 }).session(session).lean();
  if (!branch || branch.isActive === false) throw new AppError({ status: 409, code: 'SLOT_UNAVAILABLE', message: 'That slot is no longer available; pick another' });
  const slot = await PartnerSlotModel.findOneAndUpdate(
    {
      _id: slotId, partnerId: expect.partnerId, branchId: expect.branchId, visitMode: expect.visitMode, closed: null,
      date: { $nin: (branch.holidays ?? []).map(String) },
      startsAt: { $gt: expect.minStart }, $expr: { $lt: ['$booked', '$capacity'] },
    },
    { $inc: { booked: 1 } },
    { new: true, session }
  ).lean();
  if (!slot) throw new AppError({ status: 409, code: 'SLOT_UNAVAILABLE', message: 'That slot is no longer available; pick another' });
  return slot as IPartnerSlot;
}

/** Returns a seat inside the caller's transaction; callers guarantee once-only by a state CAS in the same transaction. */
export async function releaseSeat(slotId: string, session: ClientSession): Promise<void> {
  const r = await PartnerSlotModel.updateOne({ _id: slotId, booked: { $gt: 0 } }, { $inc: { booked: -1 } }, { session });
  if (r.modifiedCount !== 1) throw new AppError({ status: 500, code: 'SEAT_RELEASE_FAILED', message: 'Slot seat accounting is inconsistent' });
}
