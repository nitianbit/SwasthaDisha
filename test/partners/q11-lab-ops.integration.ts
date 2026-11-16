/**
 * Q11: lab operations gaps found by the WQ3 web packet — weekly template read + version, staff reopen only of staff
 * closures, keyed manual slots, expected status versions on booking steps, collector only for home collections,
 * keyed report uploads and draft removal, paged partner/admin lists, and professional registrations for signers.
 * Real MongoDB replica set.
 *
 * Run (throwaway DB only):
 *   MONGODB_URL='mongodb://127.0.0.1:27917/q11_lab_ops_check?directConnection=true' JWT_SECRET_KEY=local-integration-only \
 *     npx tsx test/partners/q11-lab-ops.integration.ts
 */
import 'reflect-metadata';
import assert from 'node:assert/strict';
import mongoose, { Types } from 'mongoose';
import { Container } from 'typedi';
import PartnerModel from '@/modules/partners/model';
import MemberModel from '@/modules/partners/model/member';
import BranchModel from '@/modules/partners/model/branch';
import PartnerAuditEventModel from '@/modules/partners/model/audit';
import { SettlementAccountModel, LedgerEntryModel } from '@/modules/partners/model/settlement';
import { PartnerSlotModel, PartnerSlotTemplateModel, ScheduleGuardModel } from '@/modules/partners/model/slot';
import { PartnerLabBookingModel } from '@/modules/partners/model/labBooking';
import { PartnerRepository } from '@/modules/partners/repository';
import { MemberRepository } from '@/modules/partners/repository/member';
import { BranchRepository } from '@/modules/partners/repository/branch';
import { PartnerService, PartnerActor, adminActor } from '@/modules/partners/services';
import { saveSlotTemplate, getSlotTemplate, setSlotClosed, addManualSlot, istDate, addDays } from '@/modules/partners/services/slots';
import { LabBookingService } from '@/modules/partners/services/labBookings';
import { FileUploadModel, FileGrantModel } from '@/modules/file/model/access';
import { IMember, PartnerPermission } from '@/modules/partners/types';

const FIXTURE_URL = 'mongodb://127.0.0.1:27917/q11_lab_ops_check?directConnection=true';
if (process.env.MONGODB_URL !== FIXTURE_URL) throw new Error('Refusing to run: MONGODB_URL must be exactly ' + FIXTURE_URL);

const partnerSvc = new PartnerService(new PartnerRepository(), new MemberRepository(), new BranchRepository());
Container.set(PartnerService, partnerSvc);
const labSvc = Object.create(LabBookingService.prototype) as LabBookingService;
(labSvc as any).notify = async () => undefined;
let uploaderId = '';
(labSvc as any).uploadFilesFor = async (_req: unknown, module: string, id: string) => {
  const path = `${module}/${id}/r-${Math.random().toString(36).slice(2)}.pdf`;
  await FileUploadModel.create({ path, uploaderType: 'partner', uploaderId, createdAt: new Date() });
  return [{ url: `/api/static/${path}` }];
};

let passed = 0;
async function check(name: string, fn: () => Promise<void>) { await fn(); passed++; console.log('ok -', name); }
const code = (c: string) => (e: any) => e?.code === c;
const actorFor = (m: IMember): PartnerActor => ({ memberId: String(m._id), partnerId: String(m.partnerId), role: m.role,
  permissions: m.permissions as PartnerPermission[], branchIds: (m.branchIds ?? []).map(String) });
let ph = 7950000000;
const nextPhone = () => String(ph++);
const today = istDate(new Date());

async function main() {
  await mongoose.connect(FIXTURE_URL, { autoIndex: false });
  for (const c of await mongoose.connection.db!.collections()) await c.drop().catch(() => {});
  for (const M of [PartnerModel, MemberModel, BranchModel, PartnerAuditEventModel, SettlementAccountModel, LedgerEntryModel, PartnerSlotModel,
    PartnerSlotTemplateModel, ScheduleGuardModel, PartnerLabBookingModel, FileUploadModel, FileGrantModel] as mongoose.Model<any>[]) { await M.createCollection(); await M.createIndexes(); }

  const { partner, owner } = await partnerSvc.createPartner({ kind: 'lab', name: 'Ops Lab', contactPhone: nextPhone(), invoiceSeriesPrefix: 'OL',
    firstOwner: { phone: nextPhone(), name: 'Owner' } } as any);
  const partnerId = String(partner._id);
  await partnerSvc.verifyPartner(partnerId, 'admin');
  const own = actorFor(owner);
  const A = String((await partnerSvc.createBranch(own, { name: 'A', phone: '9876500000', holidays: [], hours: {}, services: { homeCollection: true, inLab: true, inClinic: false },
    address: { line1: 'x', city: 'y', state: 'z', stateCode: '29', pincode: '560001' } } as any))._id);
  const desk = await partnerSvc.addMember(own, { phone: nextPhone(), name: 'Desk', role: 'staff', permissions: ['bookings.view', 'bookings.manage', 'reports.upload', 'reports.release', 'staff.manage'] } as any);
  const deskA = actorFor(desk);
  uploaderId = String(desk._id);
  const every = (start: string, end: string) => Object.fromEntries(['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'].map((d) => [d, [{ start, end }]]));

  await check('weekly template: readable, and a save from a stale version is refused', async () => {
    assert.equal(await getSlotTemplate(own, A, 'lab'), null);
    await assert.rejects(() => saveSlotTemplate(own, A, 'lab', { slotMinutes: 30, capacity: 2, days: every('08:00', '09:00'), expectedUpdatedAt: new Date() }), code('TEMPLATE_CHANGED'));
    const first = await saveSlotTemplate(own, A, 'lab', { slotMinutes: 30, capacity: 2, days: every('08:00', '09:00'), expectedUpdatedAt: null });
    const read = await getSlotTemplate(own, A, 'lab');
    assert.equal(read!.slotMinutes, 30);
    await assert.rejects(() => saveSlotTemplate(own, A, 'lab', { slotMinutes: 30, capacity: 3, days: every('08:00', '10:00'), expectedUpdatedAt: null }), code('TEMPLATE_CHANGED'));
    await saveSlotTemplate(own, A, 'lab', { slotMinutes: 30, capacity: 3, days: every('08:00', '10:00'), expectedUpdatedAt: first.template.updatedAt });
    assert.equal((await getSlotTemplate(own, A, 'lab'))!.capacity, 3);
  });

  await check('staff close any slot but reopen only staff closures; manual slots are keyed', async () => {
    const d = addDays(today, 3);
    const s = await PartnerSlotModel.findOne({ branchId: A, visitMode: 'lab', date: d, startTime: '08:00' }).lean();
    await PartnerSlotModel.updateOne({ _id: s!._id }, { $set: { closed: 'holiday' } });
    await assert.rejects(() => setSlotClosed(own, String(s!._id), false), code('SLOT_CLOSED_BY_SCHEDULE'));
    assert.equal((await setSlotClosed(own, String(s!._id), true)).closed, 'manual', 'a staff closure may sit over a holiday');
    assert.equal((await setSlotClosed(own, String(s!._id), false)).closed, null);
    const input = { branchId: A, visitMode: 'lab' as const, date: addDays(today, 4), startTime: '15:00', endTime: '15:30', capacity: 1, requestKey: 'slot-key-0001' };
    const made = await addManualSlot(own, input);
    const again = await addManualSlot(own, input);
    assert.deepEqual([String(again._id), again.replayed], [String(made._id), true]);
    await assert.rejects(() => addManualSlot(own, { ...input, requestKey: 'slot-key-0002' }), code('SLOT_EXISTS'));
  });

  const slot = await PartnerSlotModel.findOne({ branchId: A, visitMode: 'lab', date: addDays(today, 5), startTime: '08:00' }).lean();
  const acct = await SettlementAccountModel.findOne({ ownerKind: 'partner', ownerId: partnerId }).lean();
  const booking = async (visitMode: 'lab' | 'home', status = 'confirmed') => {
    const _id = new Types.ObjectId();
    await PartnerLabBookingModel.collection.insertOne({ _id, partnerId, branchId: A, userId: 'u1', createRequestKey: `k${_id}`, createRequestHash: 'h',
      patient: { kind: 'self', name: 'Asha' }, visitMode, slot: { slotId: String(slot!._id), date: slot!.date, startTime: '08:00', endTime: '08:30', startsAt: slot!.startsAt },
      items: [{ itemId: 'i', name: 'CBC', priceMinor: 50000, kind: 'test' }], pricing: { subtotalMinor: 50000, discountMinor: 0, payableMinor: 50000, commissionMinor: 0, currency: 'INR' },
      settlement: { settlementAccountId: String(acct!._id), beneficiaryName: 'Ops Lab', settlementSystem: 'ledger' }, status, statusVersion: 3, paymentStatus: 'paid',
      paymentDeadline: new Date(), report: { draftFiles: [], releasedFiles: [], releases: [] }, reschedule: { version: 0, pending: false }, lifecycle: {},
      createdAt: new Date(), updatedAt: new Date() } as never);
    return String(_id);
  };

  await check('booking steps refuse a stale expected version; a collector is for home collections only', async () => {
    const lab = await booking('lab');
    await assert.rejects(() => labSvc.markVisited(deskA, lab, 2), code('LAB_BOOKING_CHANGED'));
    assert.equal(((await labSvc.markVisited(deskA, lab, 3)) as any).status, 'visited');
    const labB = await booking('lab');
    await assert.rejects(() => labSvc.assignCollector(deskA, labB, { name: 'Ravi' }), code('WRONG_VISIT_MODE'));
    const home = await booking('home');
    await assert.rejects(() => labSvc.assignCollector(deskA, home, { name: 'Ravi' }, 9), code('LAB_BOOKING_CHANGED'));
    assert.deepEqual(((await labSvc.assignCollector(deskA, home, { name: 'Ravi' }, 3)) as any).collector, { name: 'Ravi' });
  });

  await check('keyed report uploads replay; a draft can be removed (released ones cannot)', async () => {
    const id = await booking('lab', 'processing');
    const a = await labSvc.uploadReportFiles(deskA, id, {}, 'upload-key-0001') as any;
    const b = await labSvc.uploadReportFiles(deskA, id, {}, 'upload-key-0001') as any;
    assert.equal(b.replayed, true);
    assert.equal(b.report.draftFiles.length, 1);
    assert.equal(a.report.draftFiles.length, 1);
    const draft = a.report.draftFiles[0] as string;
    const removed = await labSvc.removeDraftReport(deskA, id, draft) as any;
    assert.equal(removed.report.draftFiles.length, 0);
    await assert.rejects(() => labSvc.removeDraftReport(deskA, id, draft), code('REPORT_NOT_FOUND'));
  });

  await check('signers: owners record a professional registration (audited); members read their own record', async () => {
    await assert.rejects(() => partnerSvc.setMemberProfessional(deskA, String(desk._id), { kind: 'pathologist', registrationNumber: 'KMC-1' }), code('OWNER_REQUIRED'));
    const m = await partnerSvc.setMemberProfessional(own, String(desk._id), { kind: 'pathologist', registrationNumber: ' KMC-12345 ' });
    assert.deepEqual(m.professional, { kind: 'pathologist', registrationNumber: 'KMC-12345' });
    assert.equal((await partnerSvc.getOwnMember(deskA)).professional?.registrationNumber, 'KMC-12345');
    await assert.rejects(() => partnerSvc.setMemberProfessional(own, String(desk._id), null, new Date(0)), code('RECORD_CHANGED'));
    assert.ok(await PartnerAuditEventModel.exists({ partnerId, action: 'member.professional' }));
    // A member with a registration can now release under it.
    const id = await booking('lab', 'processing');
    const up = await labSvc.uploadReportFiles(deskA, id, {}) as any;
    const rel = await labSvc.releaseReport(deskA, id, up.report.draftFiles[0]) as any;
    assert.equal(rel.status, 'report_ready');
    assert.equal(rel.report.releases[0].signer.registrationNumber, 'KMC-12345');
  });

  await check('partner and admin lists page exactly', async () => {
    const seen: string[] = [];
    let cursor: string | undefined;
    let total = 0;
    do {
      const p = await labSvc.listForPartnerPage(own, { limit: 2, cursor });
      total = p.total;
      seen.push(...p.items.map((x: any) => String(x._id)));
      cursor = p.nextCursor ?? undefined;
    } while (cursor);
    assert.equal(new Set(seen).size, total);
    assert.equal(total, await PartnerLabBookingModel.countDocuments({ partnerId }));
    const adm = await labSvc.adminList({ partnerId, limit: 2, page: 1 });
    assert.equal(adm.total, total);
    assert.ok(adm.items.every((x: any) => !('walletFunding' in x) && !('createRequestKey' in x)));
    assert.ok(adminActor('adm', partnerId));
  });

  await mongoose.disconnect();
  console.log(`\n${passed} checks passed`);
}
main().catch(async (e) => { console.error(e); await mongoose.disconnect(); process.exit(1); });
