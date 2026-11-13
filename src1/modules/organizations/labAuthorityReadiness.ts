import mongoose, { ClientSession, Connection, mongo, Types } from 'mongoose';
import { performance } from 'perf_hooks';
import { types } from 'util';
import UserModel from '@/modules/user/model';
import { createAuthorityModels, AuthorityModels } from './model';
import { createLabBusinessModel } from './model/lab';
import { evaluateIndexReadiness } from '@/modules/common/utils/indexReadiness';
import { labCheck, labFailure, labShape } from './labAuthorityRoot';

type Client = ReturnType<Connection['getClient']>;
type Db = NonNullable<Connection['db']>;
type NativeLong = InstanceType<typeof mongo.Long>;
const indexes = Object.freeze([
  { collection: 'business_authority_organizations', name: 'kind_1_sourceBusinessId_1', key: [['kind', 1], ['sourceBusinessId', 1]] },
  { collection: 'business_staff_memberships', name: 'organizationId_1_actorId_1', key: [['organizationId', 1], ['actorId', 1]] },
  { collection: 'business_professional_eligibility', name: 'organizationId_1_actorId_1_profession_1', key: [['organizationId', 1], ['actorId', 1], ['profession', 1]] },
  { collection: 'business_authority_decisions', name: 'organizationId_1_operationId_1', key: [['organizationId', 1], ['operationId', 1]] },
  { collection: 'labs', name: 'organizationId_1', key: [['organizationId', 1]] },
]);
export interface LabAuthoritySnapshot {
  readonly connection: Connection; readonly client: Client; readonly db: Db; readonly database: string;
  readonly models: AuthorityModels; readonly lab: ReturnType<typeof createLabBusinessModel>;
  readonly metadataReady: true; readonly observedAt: number; readonly expiresAt: number;
  readonly collectionUuids: Readonly<Record<string, string>>;
}
const issued = new WeakSet<object>();
function object(value: unknown): object { labCheck(value !== null && typeof value === 'object' && !types.isProxy(value)); return value; }
function own(value: unknown, key: string): unknown { const d = Object.getOwnPropertyDescriptor(object(value), key); labCheck(d && 'value' in d); return d.value; }
function prototype(value: unknown, expected: object): void { labCheck(Object.getPrototypeOf(object(value)) === expected); }
function nativeLong(value: unknown, timestamp = false): NativeLong {
  prototype(value, timestamp ? mongo.Timestamp.prototype : mongo.Long.prototype);
  const keys = Reflect.ownKeys(value as object), allowed = ['low', 'high', 'unsigned', '__isLong__', ...(timestamp ? ['_bsontype'] : [])];
  labCheck(keys.length === allowed.length && keys.every(k => typeof k === 'string' && allowed.includes(k)));
  const low = own(value, 'low'), high = own(value, 'high');
  labCheck([low, high].every(v => typeof v === 'number' && Number.isInteger(v) && v >= -2147483648 && v <= 2147483647) && own(value, 'unsigned') === timestamp && own(value, '__isLong__') === true && (!timestamp || own(value, '_bsontype') === 'Timestamp'));
  return timestamp ? new mongo.Timestamp(low as number, high as number) : new mongo.Long(low as number, high as number, false);
}
const zero = (v: NativeLong): boolean => v.low === 0 && v.high === 0;
const sameLong = (a: NativeLong, b: NativeLong): boolean => a.low === b.low && a.high === b.high && a.unsigned === b.unsigned;
function nativeBuffer(value: unknown, max: number): Buffer {
  prototype(value, Buffer.prototype); labCheck(Buffer.isBuffer(value));
  const get = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')!.get!;
  const length = Reflect.apply(get, value, []); labCheck(Number.isSafeInteger(length) && length >= 0 && length <= max);
  const keys = Reflect.ownKeys(value as object); labCheck(keys.length === length && keys.every((key, i) => key === String(i)));
  const bytes = Buffer.alloc(length);
  for (let i = 0; i < length; i++) { const b = own(value, String(i)); labCheck(typeof b === 'number' && Number.isInteger(b) && b >= 0 && b <= 255); bytes[i] = b; }
  return bytes;
}
function nativeBinary(value: unknown, uuid: boolean): InstanceType<typeof mongo.Binary> {
  const proto = Object.getPrototypeOf(object(value)), isUuid = uuid && proto === mongo.BSON.UUID.prototype;
  labCheck(proto === mongo.Binary.prototype || isUuid);
  const keys = Reflect.ownKeys(value as object), allowed = ['buffer', 'sub_type', 'position', ...(isUuid ? ['__id'] : [])];
  labCheck(keys.length === allowed.length && keys.every(k => typeof k === 'string' && allowed.includes(k)) && (!isUuid || own(value, '__id') === undefined));
  const subtype = own(value, 'sub_type'), position = own(value, 'position');
  labCheck(subtype === (uuid ? 4 : 0) && typeof position === 'number' && Number.isSafeInteger(position) && position >= 0 && position <= 256 && (!uuid || position === 16));
  const bytes = nativeBuffer(own(value, 'buffer'), uuid ? 16 : 256); labCheck(bytes.length === position); return new mongo.Binary(bytes, subtype as number);
}
function binding(): { connection: Connection; client: Client; db: Db; database: string } {
  labCheck(mongoose.version === '6.13.8' && UserModel.modelName === 'User');
  const connection = UserModel.db; labCheck(connection instanceof mongoose.Connection && connection.readyState === 1);
  const client = Reflect.apply(mongoose.Connection.prototype.getClient, connection, []) as Client, db = own(connection, 'db') as Db;
  prototype(client, mongo.MongoClient.prototype); prototype(db, mongo.Db.prototype);
  labCheck(own(own(db, 's'), 'client') === client && own(UserModel.collection, 'conn') === connection && own(UserModel.collection, 'name') === 'users');
  const native = own(UserModel.collection, 'collection'); prototype(native, mongo.Collection.prototype); labCheck(own(own(native, 's'), 'db') === db);
  const getter = Object.getOwnPropertyDescriptor(mongo.Db.prototype, 'databaseName')!.get!, database = Reflect.apply(getter, db, []);
  labCheck(typeof database === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(database));
  const options = Reflect.apply(Object.getOwnPropertyDescriptor(mongo.MongoClient.prototype, 'options')!.get!, client, []);
  labCheck(own(options, 'directConnection') === true && own(options, 'retryReads') === false && [1, 2].includes(own(options, 'maxPoolSize') as number));
  for (const k of ['serverSelectionTimeoutMS', 'connectTimeoutMS', 'socketTimeoutMS', 'waitQueueTimeoutMS']) { const v = own(options, k); labCheck(typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= 5000); }
  for (const k of ['credentials', 'autoEncryption', 'proxyHost', 'proxyPort']) labCheck(!Object.prototype.hasOwnProperty.call(options, k) || own(options, k) === undefined);
  labCheck((!Object.prototype.hasOwnProperty.call(options, 'tls') || own(options, 'tls') !== true) && (!Object.prototype.hasOwnProperty.call(options, 'dbName') || own(options, 'dbName') === database));
  return { connection, client, db, database };
}
function modelBindings(connection: Connection, db: Db, models: AuthorityModels, lab: ReturnType<typeof createLabBusinessModel>): void {
  const entries: Array<[ModelLike, string, string]> = [
    [models.organization, 'BusinessAuthorityOrganization', 'business_authority_organizations'],
    [models.membership, 'BusinessStaffMembership', 'business_staff_memberships'],
    [models.eligibility, 'BusinessProfessionalEligibility', 'business_professional_eligibility'],
    [models.decision, 'BusinessAuthorityDecision', 'business_authority_decisions'], [lab, 'LabBusiness', 'labs'],
  ];
  for (const [model, name, collection] of entries) {
    labCheck(model.db === connection && model.modelName === name);
    const wrapper = object(model.collection); labCheck(own(wrapper, 'conn') === connection && own(wrapper, 'name') === collection);
    const native = own(wrapper, 'collection'); prototype(native, mongo.Collection.prototype); labCheck(own(own(native, 's'), 'db') === db);
    labCheck(Reflect.apply(Object.getOwnPropertyDescriptor(mongo.Collection.prototype, 'collectionName')!.get!, native, []) === collection);
  }
}
type ModelLike = AuthorityModels['organization'];
export function assertLabAuthoritySnapshot(snapshot: LabAuthoritySnapshot, session?: ClientSession): void {
  labCheck(issued.has(snapshot) && performance.now() < snapshot.expiresAt);
  const b = binding(); labCheck(b.connection === snapshot.connection && b.client === snapshot.client && b.db === snapshot.db && b.database === snapshot.database);
  modelBindings(b.connection, b.db, snapshot.models, snapshot.lab);
  if (session) { prototype(session, mongo.ClientSession.prototype); labCheck(own(session, 'client') === b.client && own(session, 'hasEnded') === false && session.inTransaction() && (session as unknown as { transaction: { options: { readConcern?: { level?: string } } } }).transaction.options.readConcern?.level === 'snapshot'); }
}
/** Creates only the internally owned native session; never opens another connection. */
export function startLabAuthoritySession(): ClientSession {
  const b = binding(); const session = Reflect.apply(mongo.MongoClient.prototype.startSession, b.client, []) as ClientSession;
  prototype(session, mongo.ClientSession.prototype); labCheck(own(session, 'client') === b.client && own(session, 'hasEnded') === false && !session.inTransaction()); return session;
}
/** Complete catalog acquisition, not deployment/all-writer provenance or production activation. */
export async function observeLabAuthorityReadiness(): Promise<LabAuthoritySnapshot> {
  const b = binding(), started = performance.now(), end = started + 5000, acquireEnd = end - 500;
  const models = createAuthorityModels(b.connection), lab = createLabBusinessModel(b.connection);
  modelBindings(b.connection, b.db, models, lab);
  const session = Reflect.apply(mongo.MongoClient.prototype.startSession, b.client, [{ causalConsistency: false }]) as ClientSession;
  let held: { id: NativeLong; collection: string } | undefined, uncertain = false, bytes = 0, commands = 0, totalRows = 0;
  const checkpoint = (cleanup = false) => {
    const fresh = binding(); labCheck(fresh.client === b.client && fresh.db === b.db && fresh.connection === b.connection && fresh.database === b.database);
    prototype(session, mongo.ClientSession.prototype); labCheck(own(session, 'client') === b.client && own(session, 'hasEnded') === false && !session.inTransaction() && performance.now() < (cleanup ? end : acquireEnd));
  };
  const command = async (literal: Record<string, unknown>, cleanup = false): Promise<unknown> => {
    checkpoint(cleanup); labCheck(++commands <= 32);
    try { return await Reflect.apply(mongo.Db.prototype.command, b.db, [literal, { session, readPreference: 'primary', promoteLongs: false, promoteBuffers: false, enableUtf8Validation: true }]); }
    catch { uncertain = true; return labFailure(); }
  };
  const copyReply = (raw: unknown): Record<string, unknown> => {
    let nodes = 0, logical = bytes; const active = new Set<object>();
    const take = (n: number) => { logical += n; labCheck(logical <= 1048576); };
    const copy = (v: unknown, parts: string[], depth: number): unknown => {
      labCheck(++nodes <= 8192 && depth <= 16 && performance.now() < end);
      if (v === null) { take(1); return v; }
      if (typeof v === 'string') { take(5 + Buffer.byteLength(v)); return v; }
      if (typeof v === 'boolean') { take(1); return v; }
      if (typeof v === 'number' && Number.isFinite(v)) { take(8); return v; }
      const o = object(v), proto = Object.getPrototypeOf(o), p = parts.join('/'); labCheck(!active.has(o));
      if (proto === mongo.Long.prototype) { labCheck(p === 'cursor/id' || p === '$clusterTime/signature/keyId' || /^cursors(?:Killed|NotFound|Alive|Unknown)\/[0-9]+$/.test(p)); take(8); return nativeLong(o); }
      if (proto === mongo.Timestamp.prototype) { labCheck(p === 'operationTime' || p === '$clusterTime/clusterTime'); take(8); return nativeLong(o, true); }
      if (proto === mongo.Binary.prototype || proto === mongo.BSON.UUID.prototype) { const uuid = /^cursor\/(?:firstBatch|nextBatch)\/[0-9]+\/info\/uuid$/.test(p); labCheck(uuid || p === '$clusterTime/signature/hash'); const owned = nativeBinary(o, uuid); take(5 + owned.position); return owned; }
      active.add(o); take(5); let out: unknown;
      if (Array.isArray(o)) { const n = own(o, 'length'), keys = Reflect.ownKeys(o); labCheck(proto === Array.prototype && typeof n === 'number' && Number.isSafeInteger(n) && n >= 0 && n <= 8192 && keys.length === n + 1); const a: unknown[] = []; for (let i = 0; i < n; i++) { labCheck(keys[i] === String(i)); const d = Object.getOwnPropertyDescriptor(o, String(i)); labCheck(d && 'value' in d && d.enumerable); take(2 + Buffer.byteLength(String(i))); a.push(copy(d.value, [...parts, String(i)], depth + 1)); } out = a; }
      else { labCheck(proto === Object.prototype || proto === null); const r: Record<string, unknown> = {}; for (const k of Reflect.ownKeys(o)) { labCheck(typeof k === 'string' && !['__proto__', 'constructor', 'prototype'].includes(k)); const d = Object.getOwnPropertyDescriptor(o, k); labCheck(d && 'value' in d && d.enumerable); take(2 + Buffer.byteLength(k)); r[k] = copy(d.value, [...parts, k], depth + 1); } out = r; }
      active.delete(o); return out;
    };
    const result = copy(raw, [], 0) as Record<string, unknown>; const size = mongo.BSON.calculateObjectSize(result); labCheck(Number.isSafeInteger(size)); bytes += size; labCheck(bytes <= 1048576); return result;
  };
  const transport = (r: Record<string, unknown>) => {
    if (Object.prototype.hasOwnProperty.call(r, 'operationTime')) nativeLong(r.operationTime, true);
    if (Object.prototype.hasOwnProperty.call(r, '$clusterTime')) { const c = labShape(r.$clusterTime, ['clusterTime', 'signature']), s = labShape(c.signature, ['hash', 'keyId']); nativeLong(c.clusterTime, true); nativeBinary(s.hash, false); nativeLong(s.keyId); }
  };
  const list = async (literal: Record<string, unknown>, collection: string): Promise<unknown[]> => {
    let raw = await command(literal), first = true, rows: unknown[] = [];
    for (let n = 0; n < 5; n++) {
      try { const outer = labShape(raw, ['ok', 'cursor'], ['operationTime', '$clusterTime']), c = labShape(outer.cursor, ['id', 'ns', first ? 'firstBatch' : 'nextBatch']); labCheck(outer.ok === 1 && c.ns === b.database + '.' + collection); const id = nativeLong(c.id); labCheck(!held || zero(id) || sameLong(held.id, id)); held = zero(id) ? undefined : { id, collection }; }
      catch { uncertain = true; return labFailure(); }
      const r = copyReply(raw); transport(r); const c = r.cursor as Record<string, unknown>; const batch = c[first ? 'firstBatch' : 'nextBatch']; labCheck(Array.isArray(batch) && batch.length <= 16 && (batch.length > 0 || !held)); rows = [...rows, ...batch]; labCheck(rows.length <= 64); checkpoint();
      if (!held) return rows;
      raw = await command({ getMore: held.id, collection, batchSize: 16 }); first = false;
    }
    return labFailure();
  };
  const collectionList = async () => {
    const rows = await list({ listCollections: 1, filter: { name: { $in: indexes.map(x => x.collection) } }, nameOnly: false, authorizedCollections: false, cursor: { batchSize: 16 }, maxTimeMS: 500 }, '$cmd.listCollections');
    labCheck(rows.length === 5); const result = new Map<string, { uuid: string; native: InstanceType<typeof mongo.Binary> }>();
    for (const raw of rows) {
      const r = labShape(raw, ['name', 'type', 'options', 'info', 'idIndex']), info = labShape(r.info, ['readOnly', 'uuid']); labCheck(typeof r.name === 'string' && indexes.some(i => i.collection === r.name) && !result.has(r.name) && r.type === 'collection' && info.readOnly === false);
      const options = labShape(r.options, [], ['collation']); if (Object.prototype.hasOwnProperty.call(options, 'collation')) labCheck(JSON.stringify(labShape(options.collation, ['locale'])) === '{"locale":"simple"}');
      const id = labShape(r.idIndex, ['v', 'key', 'name'], ['ns']); labCheck([1, 2].includes(id.v as number) && id.name === '_id_' && JSON.stringify(labShape(id.key, ['_id'])) === '{"_id":1}');
      const uuid = nativeBinary(info.uuid, true); result.set(r.name, { uuid: Reflect.apply(Buffer.prototype.toString, uuid.buffer, ['hex']), native: uuid });
    }
    return result;
  };
  let failure: unknown, uuids: Record<string, string> = {};
  try {
    const before = await collectionList(), observations: unknown[] = [];
    for (const expected of indexes) {
      const source = before.get(expected.collection)!; const rows = await list({ listIndexes: source.native, includeIndexBuildInfo: true, cursor: { batchSize: 16 }, maxTimeMS: 500 }, expected.collection);
      totalRows += rows.length; labCheck(totalRows <= 256);
      const copied = rows.map(raw => {
        const wrapper = labShape(raw, ['spec']), spec = labShape(wrapper.spec, ['name', 'key'], ['v', 'ns', 'unique', 'sparse', 'hidden', 'background', 'collation']);
        labCheck(typeof spec.name === 'string' && spec.sparse !== true && spec.hidden !== true && (!Object.prototype.hasOwnProperty.call(spec, 'ns') || spec.ns === b.database + '.' + expected.collection));
        const key = labShape(spec.key, [] , Reflect.ownKeys(object(spec.key)).filter((k): k is string => typeof k === 'string'));
        labCheck(Object.keys(key).length > 0 && Object.keys(key).every(k => /^[A-Za-z_][A-Za-z0-9_.]*$/.test(k) && (key[k] === 1 || key[k] === -1)));
        if (spec.name === expected.name) labCheck(JSON.stringify(Object.entries(key)) === JSON.stringify(expected.key) && spec.unique === true);
        return { spec: { ...spec, key: Object.entries(key) } };
      });
      labCheck(copied.some(r => r.spec.name === expected.name)); observations.push({ collection: expected.collection, status: 'COMPLETE', mode: 'MONGODB_8_INCLUDE_INDEX_BUILD_INFO', indexes: copied });
      uuids[expected.collection] = source.uuid;
    }
    const manifest = indexes.map(x => ({ collection: x.collection, indexes: [{ key: x.key, options: { unique: true, collation: { locale: 'simple' } } }] }));
    labCheck(evaluateIndexReadiness(manifest, observations).ready);
    const after = await collectionList(); labCheck(indexes.every(x => after.get(x.collection)!.uuid === before.get(x.collection)!.uuid));
    const logical = Buffer.byteLength(JSON.stringify({ observations, uuids })); labCheck(Math.max(bytes, logical) <= 1048576); checkpoint();
  } catch (error) { failure = error; }
  finally {
    try { if (held) { const target = held; const raw = copyReply(await command({ killCursors: target.collection, cursors: [target.id] }, true)); transport(raw); const r = labShape(raw, ['ok', 'cursorsKilled', 'cursorsNotFound', 'cursorsAlive', 'cursorsUnknown'], ['operationTime', '$clusterTime']); labCheck(r.ok === 1 && Array.isArray(r.cursorsKilled) && Array.isArray(r.cursorsNotFound) && Array.isArray(r.cursorsAlive) && Array.isArray(r.cursorsUnknown) && r.cursorsAlive.length === 0 && r.cursorsUnknown.length === 0 && r.cursorsKilled.length + r.cursorsNotFound.length === 1 && sameLong(nativeLong([...r.cursorsKilled, ...r.cursorsNotFound][0]), target.id)); held = undefined; } }
    catch (error) { failure ??= error; }
    try { labCheck(own(session, 'client') === b.client && own(session, 'hasEnded') === false && performance.now() < end); await Reflect.apply(mongo.ClientSession.prototype.endSession, session, []); labCheck(own(session, 'hasEnded') === true && performance.now() < end); }
    catch (error) { failure ??= error; }
  }
  if (failure || uncertain || held) return labFailure();
  const observedAt = performance.now(); const snapshot = Object.freeze({ ...b, models, lab, metadataReady: true as const, observedAt, expiresAt: observedAt + 5000, collectionUuids: Object.freeze(uuids) }); issued.add(snapshot); return snapshot;
}
/** Minimal current personal identity, not a patient/profile reader. */
export async function requireLabIssuer(snapshot: LabAuthoritySnapshot, id: string, session: ClientSession): Promise<void> {
  assertLabAuthoritySnapshot(snapshot, session);
  const rows = await UserModel.find({ _id: { $eq: new Types.ObjectId(id) }, userType: { $eq: 'user' }, isActive: { $eq: true } }).select({ _id: 1, userType: 1, isActive: 1 }).session(session).collation({ locale: 'simple' }).maxTimeMS(2000).limit(2).lean().exec();
  const array = object(rows); prototype(array, Array.prototype); labCheck(own(array, 'length') !== 0, 'LAB_AUTHORITY_DENIED'); labCheck(own(array, 'length') === 1 && JSON.stringify(Reflect.ownKeys(array)) === '["0","length"]' && Object.getOwnPropertyDescriptor(array, '0')?.enumerable === true);
  const row = labShape(own(array, '0'), ['_id', 'userType', 'isActive']); labCheck(typeof row.userType === 'string' && typeof row.isActive === 'boolean'); prototype(row._id, Types.ObjectId.prototype);
  const probe = new Types.ObjectId('000000000000000000000000'), symbols = Object.getOwnPropertySymbols(probe); labCheck(symbols.length === 1); const keys = Reflect.ownKeys(row._id as object); labCheck(keys.every(k => k === symbols[0] || k === '__id') && keys.includes(symbols[0]));
  for (const k of keys) { const d = Object.getOwnPropertyDescriptor(row._id as object, k); labCheck(d && 'value' in d); }
  const bytes = nativeBuffer(Object.getOwnPropertyDescriptor(row._id as object, symbols[0])!.value, 12); labCheck(bytes.length === 12); const value = Reflect.apply(Buffer.prototype.toString, bytes, ['hex']);
  labCheck((!keys.includes('__id') || own(row._id, '__id') === value) && value === id && row.userType === 'user' && row.isActive === true, 'LAB_AUTHORITY_DENIED'); assertLabAuthoritySnapshot(snapshot, session);
}
