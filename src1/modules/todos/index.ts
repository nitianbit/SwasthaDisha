import { Router, type RequestHandler, type Response } from 'express';
import Joi from 'joi';
import { Types } from 'mongoose';
import { AppError } from '@/modules/common/types';
import { catchAsync } from '@/modules/common/utils/asyncHandler';
import { validate } from '@/modules/common/middleware/validation';
import { requestHashOf } from '@/modules/common/utils/canonicalJson';
import { assertUniqueIndex } from '@/modules/common/utils/requiredIndex';
import { isDuplicateKeyError } from '@/modules/common/utils/mongoErrors';
import type { AuthRequest } from '@/modules/middleware/auth';
import { ASSISTED_KEY } from '@/modules/assisted/consultations';
import { TodoModel, type ITodo, type TodoOwnerKind } from '@/modules/todos/model';
import { RequestKeyModel } from '@/modules/requestKeys/model';
import { runLedgerTransaction } from '@/modules/common/utils/bookingWalletFunding';

/**
 * r37 (§26.20): to-dos for an owner (pharmacy now; lab, clinic and doctor later, mounted with their own `ownerOf`). Every
 * member of the owner sees and edits the owner's list (`createdBy` says who added each); a doctor's list is private
 * because the doctor is the owner. The text is the user's own words: it is never logged or audited.
 */
/**
 * The owner whose list it is. r38b: `branchIds` = a branch-limited member's branches: it sees the owner-wide to-dos and
 * its branches' ones, and what it adds belongs to its branches. Absent = an owner-wide member (sees all, adds owner-wide).
 */
export interface TodoOwner { kind: TodoOwnerKind; id: string; branchIds?: string[] }
export interface TodoActor { kind: string; id: string; name: string | null }
/** r37b: at most this many open to-dos per owner (409 TODO_LIMIT). */
export const TODO_OPEN_LIMIT = 500;
/** r37b: the request-key store's scope of an owner's to-do keys (a used key stays used after its to-do is deleted). */
const keyScope = (o: TodoOwner) => `todo:${o.kind}:${lower(o.id)}`;

const err = (status: number, code: string, message: string) => new AppError({ status, code, message });
const lower = (v: unknown) => String(v ?? '').toLowerCase();
const notFound = () => err(404, 'TODO_NOT_FOUND', 'To-do not found');
const ownerOnly = (o: TodoOwner) => ({ 'owner.kind': o.kind, 'owner.id': lower(o.id) });
/** The to-dos this member may see and change: the owner's, and for a branch-limited member only owner-wide or its branches'. */
const ownerFilter = (o: TodoOwner): Record<string, unknown> => (o.branchIds?.length
  ? { ...ownerOnly(o), $or: [{ branchIds: { $size: 0 } }, { branchIds: { $exists: false } }, { branchIds: { $in: o.branchIds.map(String) } }] }
  : ownerOnly(o));

export function todoView(t: ITodo) {
  return { _id: String(t._id), text: t.text, dueAt: t.dueAt ?? null, done: t.done === true, doneAt: t.doneAt ?? null,
    createdBy: { kind: t.createdBy.kind, id: t.createdBy.id, name: t.createdBy.name ?? null }, branchIds: t.branchIds ?? [], version: t.version,
    createdAt: t.createdAt, updatedAt: t.updatedAt };
}

/** Cursor `<0 open | 1 done>_<createdAt ms>_<id>` (r37b: the list is open first, then newest). */
const CURSOR = /^([01])_(\d{1,15})_([0-9a-fA-F]{24})$/;
/** GET …/todos?done&cursor&limit — open first, then newest (the list index's order); `done` filters (absent: all). */
export async function listTodos(o: TodoOwner, q: { done?: boolean; cursor?: string; limit?: number }) {
  const limit = Math.min(Math.max(Number(q.limit) || 50, 1), 100);
  const m = q.cursor ? CURSOR.exec(q.cursor) : null;
  if (q.cursor && !m) throw err(400, 'INVALID_CURSOR', 'Invalid cursor');
  const filter: Record<string, unknown> = { ...ownerFilter(o), ...(q.done === undefined ? {} : { done: q.done }) };
  const after = m ? (() => {
    const done = m[1] === '1'; const at = new Date(Number(m[2])); const id = new Types.ObjectId(m[3]);
    return { $or: [...(done ? [] : [{ done: true }]), { done, createdAt: { $lt: at } }, { done, createdAt: at, _id: { $lt: id } }] };
  })() : {};
  const rows = await TodoModel.find(m ? { $and: [filter, after] } : filter).sort({ done: 1, createdAt: -1, _id: -1 }).limit(limit + 1).lean() as ITodo[];
  const items = rows.slice(0, limit);
  const last = items[items.length - 1];
  return { items: items.map(todoView),
    nextCursor: rows.length > limit && last ? `${last.done ? 1 : 0}_${new Date(last.createdAt!).getTime()}_${String(last._id)}` : null };
}

/**
 * POST …/todos { text, dueAt?, requestKey } — once per key: the same key and body answer it again, another body 409.
 * r37b: the key is recorded in the request-key store with the to-do (one transaction), so a key whose to-do was deleted
 * is still used (409 IDEMPOTENCY_KEY_REUSED); at most TODO_OPEN_LIMIT open to-dos (409 TODO_LIMIT).
 */
export async function createTodo(o: TodoOwner, actor: TodoActor | (() => Promise<TodoActor>), body: { text: string; dueAt?: string | null; requestKey: string }) {
  await assertUniqueIndex(TodoModel, { 'owner.kind': 1, 'owner.id': 1, requestKey: 1 });
  await assertUniqueIndex(RequestKeyModel, { scope: 1, key: 1 });
  const text = String(body.text).trim();
  const dueAt = body.dueAt ? new Date(body.dueAt) : null;
  const requestHash = requestHashOf({ kind: 'todo', text, dueAt: dueAt ? dueAt.toISOString() : null });
  const replay = async () => {
    const t = await TodoModel.findOne({ ...ownerFilter(o), requestKey: { $eq: body.requestKey } }).lean() as ITodo | null;
    if (!t) return null;
    if (t.requestHash !== requestHash) throw err(409, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a different to-do');
    return { todo: todoView(t), replayed: true };
  };
  const prior = await replay();
  if (prior) return prior;
  const by = typeof actor === 'function' ? await actor() : actor;
  try {
    return await runLedgerTransaction(async (s) => {
      if (await RequestKeyModel.exists({ scope: keyScope(o), key: body.requestKey }).session(s)) {
        throw err(409, 'IDEMPOTENCY_KEY_REUSED', 'This request key was already used for a to-do');
      }
      if (await TodoModel.countDocuments({ ...ownerOnly(o), done: false }).session(s) >= TODO_OPEN_LIMIT) {
        throw err(409, 'TODO_LIMIT', `At most ${TODO_OPEN_LIMIT} open to-dos; tick or delete some first`);
      }
      await RequestKeyModel.create([{ scope: keyScope(o), key: body.requestKey, state: 'used', at: new Date() }], { session: s });
      const [t] = await TodoModel.create([{ owner: { kind: o.kind, id: lower(o.id) }, text, dueAt, done: false, doneAt: null,
        createdBy: { kind: by.kind, id: lower(by.id), name: by.name }, branchIds: (o.branchIds ?? []).map(String), requestKey: body.requestKey, requestHash,
        version: 0 }], { session: s });
      return { todo: todoView(t!.toObject() as ITodo), replayed: false };
    });
  } catch (e) {
    if (isDuplicateKeyError(e)) {
      const raced = await replay();
      if (raced) return raced;
    }
    throw e;
  }
}

/** PATCH …/todos/:id { done?, text?, dueAt? (null clears), expectedVersion } — 409 TODO_CHANGED on another version. */
export async function updateTodo(o: TodoOwner, id: string, body: { done?: boolean; text?: string; dueAt?: string | null; expectedVersion: number }) {
  if (!Types.ObjectId.isValid(id)) throw notFound();
  const set: Record<string, unknown> = {};
  if (body.text !== undefined) set.text = String(body.text).trim();
  if (body.dueAt !== undefined) set.dueAt = body.dueAt ? new Date(body.dueAt) : null;
  if (body.done !== undefined) {
    // r37b: ticking an already-done to-do keeps its first `doneAt` (read at the version the update is fenced on).
    const cur = await TodoModel.findOne({ _id: id, ...ownerFilter(o), version: body.expectedVersion }).select({ done: 1, doneAt: 1 }).lean() as ITodo | null;
    set.done = body.done;
    set.doneAt = body.done ? (cur?.done && cur.doneAt ? cur.doneAt : new Date()) : null;
  }
  const t = await TodoModel.findOneAndUpdate({ _id: id, ...ownerFilter(o), version: body.expectedVersion }, { $set: set, $inc: { version: 1 } },
    { new: true }).lean() as ITodo | null;
  if (t) return todoView(t);
  if (await TodoModel.exists({ _id: id, ...ownerFilter(o) })) throw err(409, 'TODO_CHANGED', 'This to-do changed since it was loaded; review it again');
  throw notFound();
}

/** DELETE …/todos/:id — another owner's to-do is the one 404. */
export async function deleteTodo(o: TodoOwner, id: string) {
  if (!Types.ObjectId.isValid(id)) throw notFound();
  const r = await TodoModel.deleteOne({ _id: id, ...ownerFilter(o) });
  if (r.deletedCount !== 1) throw notFound();
  return { deleted: true };
}

// ── Routes ──
const text = Joi.string().trim().min(1).max(200);
const dueAt = Joi.date().iso().allow(null);
const idParam = Joi.object({ id: Joi.string().pattern(/^[0-9a-fA-F]{24}$/).required() });
const listQuery = Joi.object({ done: Joi.boolean(), cursor: Joi.string().pattern(CURSOR), limit: Joi.number().integer().min(1).max(100) });
const createBody = Joi.object({ text: text.required(), dueAt, requestKey: Joi.string().pattern(ASSISTED_KEY).required() });
const patchBody = Joi.object({ done: Joi.boolean(), text, dueAt, expectedVersion: Joi.number().integer().min(0).required() })
  .or('done', 'text', 'dueAt');

const send = (res: Response, data: unknown, status = 200, extra: Record<string, unknown> = {}) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.status(status).json({ success: true, data, ...extra });
};

/**
 * Mounts `GET/POST /todos`, `PATCH/DELETE /todos/:id` on an owner's router (behind its own guards). `ownerOf` names the
 * owner and, as a function (r37b: read only by a create), the acting person with the name shown on each to-do.
 */
export function mountTodoRoutes(r: Router, ownerOf: (req: AuthRequest) => { owner: TodoOwner; actor: () => Promise<TodoActor> },
  /** r38: guards placed before each route (a router without a router-level guard, as the partner workspace). */
  guards: RequestHandler[] = []): void {
  r.get('/todos', ...guards, validate(listQuery, 'query'), catchAsync(async (req: AuthRequest, res) => {
    const { owner } = ownerOf(req);
    const q = req.query as Record<string, unknown>;
    const out = await listTodos(owner, { done: q.done === undefined ? undefined : String(q.done) === 'true', cursor: q.cursor as string | undefined,
      limit: q.limit === undefined ? undefined : Number(q.limit) });
    send(res, out.items, 200, { pagination: { nextCursor: out.nextCursor } });
  }));
  r.post('/todos', ...guards, validate(createBody, 'body'), catchAsync(async (req: AuthRequest, res) => {
    const { owner, actor } = ownerOf(req);
    const out = await createTodo(owner, actor, req.body);
    send(res, out, out.replayed ? 200 : 201);
  }));
  r.patch('/todos/:id', ...guards, validate(idParam, 'params'), validate(patchBody, 'body'), catchAsync(async (req: AuthRequest, res) => {
    const { owner } = ownerOf(req);
    send(res, await updateTodo(owner, req.params.id, req.body));
  }));
  r.delete('/todos/:id', ...guards, validate(idParam, 'params'), catchAsync(async (req: AuthRequest, res) => {
    const { owner } = ownerOf(req);
    send(res, await deleteTodo(owner, req.params.id));
  }));
}
