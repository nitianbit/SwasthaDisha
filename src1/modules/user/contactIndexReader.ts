import mongoose, { mongo, Connection } from 'mongoose';
import { performance } from 'perf_hooks';
import { types } from 'util';
import { Buffer } from 'buffer';
import UserModel from './model';
import { USER_CONTACT_INDEX_MANIFEST } from './contactIndexManifest';
import { ContactRecord, ContactIndexReadinessCode, UserContactIndexObservation,
  copyUserContactIndexData, inspectUserContactCollectionSpec, inspectUserContactIndexRow, contactIndexDataFailureCode } from './contactIndexReadiness';

type NativeDb = InstanceType<typeof mongo.Db>;
type NativeClient = InstanceType<typeof mongo.MongoClient>;
type NativeCollection = InstanceType<typeof mongo.Collection>;
type NativeSession = ReturnType<NativeClient['startSession']>;
type NativeLong = InstanceType<typeof mongo.Long>;
type NativeBinary = InstanceType<typeof mongo.Binary>;
interface Bound { connection: Connection; db: NativeDb; client: NativeClient; wrapper: object; native: NativeCollection; database: string }
interface HeldCursor { id: NativeLong; namespace: string; collection: 'users' | '$cmd.listCollections' }
type FailureCode = Exclude<ContactIndexReadinessCode, 'READY'>;
class AcquisitionFailure extends Error { constructor(readonly code: FailureCode) { super(code); } }
function fail(code: FailureCode): never { throw new AcquisitionFailure(code); }
function object(v: unknown): object {
  if (v === null || typeof v !== 'object' || types.isProxy(v)) fail('OBSERVATION_INVALID');
  return v;
}
function own(v: unknown, key: string): unknown {
  const d = Object.getOwnPropertyDescriptor(object(v), key);
  if (!d || !('value' in d)) fail('OBSERVATION_INVALID'); return d.value;
}
function native<T>(v: unknown, proto: object): T {
  if (Object.getPrototypeOf(object(v)) !== proto) fail('UNSUPPORTED_PROFILE'); return v as T;
}
function fields(v: unknown, required: readonly string[], optional: readonly string[] = []): Record<string, unknown> {
  const o = object(v); const proto = Object.getPrototypeOf(o); const keys = Reflect.ownKeys(o);
  if ((proto !== null && proto !== Object.prototype) || keys.length > 8192 ||
    keys.some(k => typeof k !== 'string' || (!required.includes(k) && !optional.includes(k))) ||
    !required.every(k => Object.prototype.hasOwnProperty.call(o, k))) fail('OBSERVATION_INVALID');
  const out: Record<string, unknown> = Object.create(null);
  for (const k of keys as string[]) {
    const d = Object.getOwnPropertyDescriptor(o, k);
    if (!d || !('value' in d) || !d.enumerable) fail('OBSERVATION_INVALID'); out[k] = d.value;
  }
  return out;
}
function signed32(v: unknown): v is number { return typeof v === 'number' && Number.isInteger(v) && v >= -2147483648 && v <= 2147483647; }
function long(v: unknown, timestamp = false): NativeLong {
  const proto = timestamp ? mongo.Timestamp.prototype : mongo.Long.prototype;
  native(v, proto);
  const allowed = ['low', 'high', 'unsigned', '__isLong__', ...(timestamp ? ['_bsontype'] : [])];
  const keys = Reflect.ownKeys(v as object);
  if (keys.length !== allowed.length || keys.some(k => typeof k !== 'string' || !allowed.includes(k))) fail('UNSUPPORTED_PROFILE');
  const low = own(v, 'low'); const high = own(v, 'high');
  if (!signed32(low) || !signed32(high) || own(v, 'unsigned') !== timestamp || own(v, '__isLong__') !== true ||
    (timestamp && own(v, '_bsontype') !== 'Timestamp')) fail('UNSUPPORTED_PROFILE');
  return timestamp ? new mongo.Timestamp(low, high) : new mongo.Long(low, high, false);
}
function zero(v: NativeLong): boolean { return v.low === 0 && v.high === 0; }
function sameLong(a: NativeLong, b: NativeLong): boolean { return a.low === b.low && a.high === b.high && a.unsigned === b.unsigned; }
function buffer(v: unknown, max: number): Buffer {
  object(v);
  if (!Buffer.isBuffer(v) || Object.getPrototypeOf(v) !== Buffer.prototype) fail('UNSUPPORTED_PROFILE');
  const getter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(Uint8Array.prototype), 'byteLength')?.get;
  if (!getter) fail('UNSUPPORTED_PROFILE');
  const length = Reflect.apply(getter, v, []) as unknown;
  if (typeof length !== 'number' || !Number.isSafeInteger(length) || length < 0 || length > max) fail('LIMIT_EXCEEDED');
  const keys = Reflect.ownKeys(v);
  if (keys.length !== length || keys.some((k, i) => k !== String(i))) fail('UNSUPPORTED_PROFILE');
  const copy = Buffer.alloc(length);
  for (let i = 0; i < length; i++) {
    const b = own(v, String(i)); if (typeof b !== 'number' || !Number.isInteger(b) || b < 0 || b > 255) fail('UNSUPPORTED_PROFILE'); copy[i] = b;
  }
  return copy;
}
function binary(v: unknown, uuid = false): NativeBinary {
  const proto = Object.getPrototypeOf(object(v));
  const nativeUuid = uuid && proto === mongo.BSON.UUID.prototype;
  if (proto !== mongo.Binary.prototype && !nativeUuid) fail('UNSUPPORTED_PROFILE');
  const allowed = ['buffer', 'sub_type', 'position', ...(nativeUuid ? ['__id'] : [])];
  const keys = Reflect.ownKeys(v as object);
  if (keys.length !== allowed.length || !keys.every(k => typeof k === 'string' && allowed.includes(k)) ||
    (nativeUuid && own(v, '__id') !== undefined)) fail('UNSUPPORTED_PROFILE');
  const subtype = own(v, 'sub_type'); const position = own(v, 'position');
  if (typeof subtype !== 'number' || !Number.isInteger(subtype) || subtype < 0 || subtype > 255 ||
    typeof position !== 'number' || !Number.isSafeInteger(position) || position < 0 || position > 256 ||
    (uuid && (subtype !== 4 || position !== 16)) || (!uuid && subtype !== 0)) fail('UNSUPPORTED_PROFILE');
  const bytes = buffer(own(v, 'buffer'), uuid ? 16 : 256);
  if (bytes.length !== position) fail('UNSUPPORTED_PROFILE');
  return new mongo.Binary(bytes, subtype);
}
function uuidHex(v: unknown): string {
  const b = binary(v, true);
  return Buffer.prototype.toString.call(b.buffer, 'hex', 0, 16);
}
function dbName(db: NativeDb): string {
  const getter = Object.getOwnPropertyDescriptor(mongo.Db.prototype, 'databaseName')?.get;
  if (!getter) fail('UNSUPPORTED_PROFILE');
  const name: unknown = Reflect.apply(getter, db, []);
  if (typeof name !== 'string' || !name || Buffer.byteLength(name) > 128 || name.includes('\0')) fail('BINDING_UNAVAILABLE');
  return name;
}
function bind(): Bound {
  if (mongoose.version !== '6.13.8' || types.isProxy(UserModel)) fail('UNSUPPORTED_PROFILE');
  if (UserModel.modelName !== 'User') fail('BINDING_UNAVAILABLE');
  const connection = UserModel.db;
  object(connection);
  if (!(connection instanceof mongoose.Connection) || connection.readyState !== 1) fail('BINDING_UNAVAILABLE');
  const db = native<NativeDb>(own(connection, 'db'), mongo.Db.prototype);
  const client = native<NativeClient>(Reflect.apply(mongoose.Connection.prototype.getClient, connection, []), mongo.MongoClient.prototype);
  const wrapper = object(UserModel.collection);
  if (own(wrapper, 'conn') !== connection || own(wrapper, 'name') !== 'users') fail('BINDING_UNAVAILABLE');
  const collection = native<NativeCollection>(own(wrapper, 'collection'), mongo.Collection.prototype);
  if (own(own(collection, 's'), 'db') !== db || own(own(db, 's'), 'client') !== client) fail('BINDING_UNAVAILABLE');
  const nameGetter = Object.getOwnPropertyDescriptor(mongo.Collection.prototype, 'collectionName')?.get;
  if (!nameGetter || Reflect.apply(nameGetter, collection, []) !== 'users') fail('BINDING_UNAVAILABLE');
  const optionsGetter = Object.getOwnPropertyDescriptor(mongo.MongoClient.prototype, 'options')?.get;
  if (!optionsGetter) fail('UNSUPPORTED_PROFILE');
  const options: unknown = Reflect.apply(optionsGetter, client, []);
  if (own(options, 'directConnection') !== true || own(options, 'retryReads') !== false || own(options, 'maxPoolSize') !== 1) fail('UNSUPPORTED_PROFILE');
  for (const key of ['serverSelectionTimeoutMS', 'connectTimeoutMS', 'socketTimeoutMS', 'waitQueueTimeoutMS']) {
    const value = own(options, key); if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > 250) fail('UNSUPPORTED_PROFILE');
  }
  return { connection, db, client, wrapper, native: collection, database: dbName(db) };
}
function bindingUnchanged(b: Bound): void {
  const current = bind();
  if (current.connection !== b.connection || current.db !== b.db || current.client !== b.client || current.wrapper !== b.wrapper ||
    current.native !== b.native || current.database !== b.database) fail('BINDING_UNAVAILABLE');
}
function sessionOwned(session: NativeSession, b: Bound, ended = false): void {
  native(session, mongo.ClientSession.prototype);
  if (own(session, 'client') !== b.client || own(session, 'hasEnded') !== ended ||
    Reflect.apply(mongo.ClientSession.prototype.inTransaction, session, []) !== false) fail('BINDING_UNAVAILABLE');
}

/** Copies only declared BSON transport positions; no server object's toJSON/toBSON/overridden method is called. */
function replyCopy(raw: unknown, remaining: number, deadline: number, kind: 'collections' | 'indexes' | 'more' | 'kill'): { value: Record<string, unknown>; size: number } {
  let nodes = 0; let size = 0; const active = new Set<object>();
  const take = (n: number) => { size += n; if (size > remaining) fail('LIMIT_EXCEEDED'); };
  const copy = (v: unknown, parts: string[], depth: number): unknown => {
    if (++nodes > 8192 || depth > 16) fail('LIMIT_EXCEEDED');
    if (performance.now() >= deadline) fail('DEADLINE_EXCEEDED');
    if (v === null) return null;
    if (typeof v === 'boolean') { take(1); return v; }
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) fail('OBSERVATION_INVALID');
      take(mongo.BSON.calculateObjectSize({ x: v }) - 8); return v;
    }
    if (typeof v === 'string') { take(5 + Buffer.byteLength(v)); return v; }
    const o = object(v); if (active.has(o)) fail('OBSERVATION_INVALID');
    const p = parts.join('/'); const proto = Object.getPrototypeOf(o);
    if (proto === mongo.Long.prototype) {
      if (!(p === 'cursor/id' || p === '$clusterTime/signature/keyId' || /^cursors(?:Killed|NotFound|Alive|Unknown)\/[0-9]+$/.test(p))) fail('UNSUPPORTED_PROFILE');
      take(8); return long(o);
    }
    if (proto === mongo.Timestamp.prototype) {
      if (p !== 'operationTime' && p !== '$clusterTime/clusterTime') fail('UNSUPPORTED_PROFILE'); take(8); return long(o, true);
    }
    if (proto === mongo.Binary.prototype || proto === mongo.BSON.UUID.prototype) {
      const isUuid = kind === 'collections' && /^cursor\/firstBatch\/[0-9]+\/info\/uuid$/.test(p);
      if (!isUuid && p !== '$clusterTime/signature/hash') fail('UNSUPPORTED_PROFILE');
      const b = binary(o, isUuid); take(5 + b.position); return b;
    }
    const keys = Reflect.ownKeys(o);
    if (keys.length > 8192 - nodes) fail('LIMIT_EXCEEDED');
    if (keys.some(k => typeof k !== 'string')) fail('OBSERVATION_INVALID');
    active.add(o); take(5);
    let out: unknown;
    if (Array.isArray(o)) {
      const n = own(o, 'length');
      if (proto !== Array.prototype || typeof n !== 'number' || !Number.isSafeInteger(n) || n < 0 || n > 8192 || keys.length !== n + 1) fail('OBSERVATION_INVALID');
      const a: unknown[] = [];
      for (let i = 0; i < n; i++) {
        if (keys[i] !== String(i)) fail('OBSERVATION_INVALID');
        take(2 + Buffer.byteLength(String(i))); a.push(copy(own(o, String(i)), [...parts, String(i)], depth + 1));
      }
      out = a;
    } else {
      if (proto !== null && proto !== Object.prototype) fail('UNSUPPORTED_PROFILE');
      const data: Record<string, unknown> = Object.create(null);
      for (const key of keys as string[]) {
        const d = Object.getOwnPropertyDescriptor(o, key);
        if (!d || !('value' in d) || !d.enumerable || key.includes('\0')) fail('OBSERVATION_INVALID');
        if ((kind === 'indexes' || kind === 'more') && /(?:^|\/)cursor\/(?:firstBatch|nextBatch)\/[0-9]+(?:\/spec)?$/.test(p) &&
          (key === 'indexBuildInfo' || key === 'buildUUID')) fail('INDEX_BUILDING');
        take(2 + Buffer.byteLength(key)); data[key] = copy(d.value, [...parts, key], depth + 1);
      }
      out = data;
    }
    active.delete(o); return out;
  };
  const value = copy(raw, [], 0) as Record<string, unknown>;
  const actual = mongo.BSON.calculateObjectSize(value);
  if (!Number.isSafeInteger(actual) || actual > remaining || actual !== size) fail('LIMIT_EXCEEDED');
  return { value, size: actual };
}
function header(raw: unknown, expected: string, batch: 'firstBatch' | 'nextBatch'): { id: NativeLong; values: unknown[] } {
  const outer = fields(raw, ['ok', 'cursor'], ['operationTime', '$clusterTime']); if (outer.ok !== 1) fail('OBSERVATION_FAILED');
  const cursor = fields(outer.cursor, ['id', 'ns', batch]);
  if (cursor.ns !== expected || !Array.isArray(cursor[batch]) || types.isProxy(cursor[batch])) fail('CURSOR_INCOMPLETE');
  return { id: long(cursor.id), values: cursor[batch] as unknown[] };
}
function validateTransport(reply: Record<string, unknown>): void {
  if (Object.prototype.hasOwnProperty.call(reply, '$clusterTime')) {
    const c = fields(reply.$clusterTime, ['clusterTime', 'signature']);
    long(c.clusterTime, true); const signature = fields(c.signature, ['hash', 'keyId']); binary(signature.hash); long(signature.keyId);
  }
  if (Object.prototype.hasOwnProperty.call(reply, 'operationTime')) long(reply.operationTime, true);
}
function freezeData<T>(value: T): T {
  if (value && typeof value === 'object') { for (const v of Object.values(value)) freezeData(v); Object.freeze(value); }
  return value;
}

/** No caller destination/session/options and no shared-client lifecycle mutation. Invocation still requires full C3/C2 admission. */
export async function readUserContactIndexMetadata(): Promise<UserContactIndexObservation> {
  const started = performance.now(); const acquireEnd = started + 4000; const end = started + 5000;
  const observation: UserContactIndexObservation = {
    schema: 'SD-USER-CONTACT-INDEX-OBSERVATION-1', mode: 'MONGODB_8_INCLUDE_INDEX_BUILD_INFO', binding: null,
    status: 'INCOMPLETE', collectionSpec: null, indexes: [],
    completion: { indexRows: 0, logicalMetadataBytes: 0, commandCount: 0, elapsedMs: 0,
      collectionCursorExhausted: false, indexCursorExhausted: false, sessionEnded: false, cleanupConfirmed: false }, failure: 'BINDING_UNAVAILABLE',
  };
  let bound: Bound | undefined; let session: NativeSession | undefined; let held: HeldCursor | undefined;
  let bsonBytes = 0; let uncertain = false; let reason: FailureCode | null = null;
  const settleBytes = () => {
    observation.completion.indexRows = observation.indexes.length;
    for (let i = 0; i < 8; i++) {
      const size = Buffer.byteLength(JSON.stringify(observation)); const next = Math.max(bsonBytes, size);
      if (observation.completion.logicalMetadataBytes === next) return;
      observation.completion.logicalMetadataBytes = next;
    }
    fail('LIMIT_EXCEEDED');
  };
  const checkpoint = (cleanup = false) => {
    if (!bound || !session) fail('BINDING_UNAVAILABLE');
    bindingUnchanged(bound); sessionOwned(session, bound);
    if (performance.now() >= (cleanup ? end : acquireEnd)) fail('DEADLINE_EXCEEDED');
  };
  const command = async (literal: Record<string, unknown>, cleanup = false): Promise<unknown> => {
    checkpoint(cleanup);
    if (!cleanup && acquireEnd - performance.now() < 1000) fail('DEADLINE_EXCEEDED');
    if (cleanup && end - performance.now() < 500) fail('DEADLINE_EXCEEDED');
    observation.completion.commandCount += 1;
    try {
      const response = await Reflect.apply(mongo.Db.prototype.command, bound!.db, [literal, {
        session: session!, readPreference: 'primary', promoteLongs: false, promoteBuffers: false, enableUtf8Validation: true,
      }]) as unknown;
      // Do not lose a returned cursor to a deadline check: callers first validate/capture its header.
      return response;
    } catch { uncertain = true; fail('OBSERVATION_FAILED'); }
  };
  const consume = (raw: unknown, namespace: string, initial: boolean, kind: 'collections' | 'indexes' | 'more') => {
    let h: ReturnType<typeof header>;
    try { h = header(raw, namespace, initial ? 'firstBatch' : 'nextBatch'); }
    catch (error) { uncertain = true; throw error; }
    if (held && (held.namespace !== namespace || (!zero(h.id) && !sameLong(held.id, h.id)))) { uncertain = true; fail('CURSOR_INCOMPLETE'); }
    if (zero(h.id)) held = undefined;
    else held = { id: h.id, namespace, collection: kind === 'collections' ? '$cmd.listCollections' : 'users' };
    if (kind === 'collections') observation.completion.collectionCursorExhausted = zero(h.id);
    else observation.completion.indexCursorExhausted = zero(h.id);
    checkpoint();
    const copied = replyCopy(raw, 262144 - bsonBytes, acquireEnd, kind); bsonBytes += copied.size; validateTransport(copied.value);
    return fields(copied.value.cursor, ['id', 'ns', initial ? 'firstBatch' : 'nextBatch'])[initial ? 'firstBatch' : 'nextBatch'] as unknown[];
  };
  const append = (rows: unknown[]) => {
    for (const row of rows) {
      if (observation.indexes.length >= 64) fail('LIMIT_EXCEEDED');
      const code = inspectUserContactIndexRow(row, bound!.database + '.users'); if (code !== 'READY') fail(code as FailureCode);
      const data = copyUserContactIndexData(row) as ContactRecord;
      const spec = data.spec as ContactRecord;
      if (observation.indexes.some(x => (x.spec as ContactRecord).name === spec.name)) fail('OBSERVATION_INVALID');
      const candidate = { ...observation, indexes: [...observation.indexes, data] };
      copyUserContactIndexData(candidate); // Budget before retaining another row; not readiness authority.
      observation.indexes.push(data); observation.completion.indexRows = observation.indexes.length;
      if (performance.now() >= acquireEnd) fail('DEADLINE_EXCEEDED');
    }
  };
  try {
    if (arguments.length !== 0) fail('OBSERVATION_INVALID');
    bound = bind();
    if (performance.now() >= acquireEnd) fail('DEADLINE_EXCEEDED');
    session = Reflect.apply(mongo.MongoClient.prototype.startSession, bound.client, [{ causalConsistency: false }]) as NativeSession;
    sessionOwned(session, bound);
    const collectionNs = bound.database + '.$cmd.listCollections';
    const rawCollection = await command({ listCollections: 1, filter: { name: 'users' }, nameOnly: false, authorizedCollections: false,
      cursor: { batchSize: 2 }, maxTimeMS: 500 });
    const collectionRows = consume(rawCollection, collectionNs, true, 'collections');
    if (!observation.completion.collectionCursorExhausted) fail('CURSOR_INCOMPLETE');
    if (collectionRows.length === 0) fail('COLLECTION_UNAVAILABLE');
    if (collectionRows.length !== 1) fail('OBSERVATION_INVALID');
    const row = fields(collectionRows[0], ['name', 'type', 'options', 'info', 'idIndex']);
    const info = fields(row.info, ['readOnly', 'uuid']); const uuid = uuidHex(info.uuid);
    const plain = copyUserContactIndexData({ ...row, info: { ...info, uuid } }) as ContactRecord;
    const collectionCode = inspectUserContactCollectionSpec(plain, bound.database + '.users', uuid);
    if (collectionCode !== 'READY') fail(collectionCode as FailureCode);
    observation.collectionSpec = plain;
    observation.binding = { databaseName: bound.database, collectionName: 'users', namespace: bound.database + '.users', collectionUuid: uuid };
    const rawIndexes = await command({ listIndexes: binary(info.uuid, true), includeIndexBuildInfo: true, cursor: { batchSize: 16 }, maxTimeMS: 500 });
    const first = consume(rawIndexes, bound.database + '.users', true, 'indexes');
    if (first.length > 16 || (first.length === 0 && held)) fail('CURSOR_INCOMPLETE'); append(first);
    for (let count = 0; held && count < 4; count++) {
      const previous = held; const batchSize = Math.min(16, 65 - observation.indexes.length);
      const more = await command({ getMore: previous.id, collection: 'users', batchSize });
      const rows = consume(more, bound.database + '.users', false, 'more');
      if (rows.length > batchSize || (rows.length === 0 && held)) fail('CURSOR_INCOMPLETE'); append(rows);
    }
    if (held || !observation.completion.indexCursorExhausted) fail('CURSOR_INCOMPLETE');
    checkpoint(); observation.status = 'COMPLETE'; observation.failure = null;
  } catch (error) {
    const ownedFailure = error !== null && typeof error === 'object' && !types.isProxy(error) && Object.getPrototypeOf(error) === AcquisitionFailure.prototype;
    const dataFailure = contactIndexDataFailureCode(error);
    reason = ownedFailure ? (error as AcquisitionFailure).code : dataFailure && dataFailure !== 'READY' ? dataFailure : 'OBSERVATION_FAILED';
    observation.status = ['UNSUPPORTED_PROFILE', 'INDEX_BUILDING'].includes(reason) ? 'UNSUPPORTED' : 'INCOMPLETE'; observation.failure = reason;
  } finally {
    let cleaned = !uncertain;
    if (bound && session && held) {
      try {
        checkpoint(true);
        const target = held;
        const raw = await command({ killCursors: target.collection, cursors: [target.id] }, true);
        const response = replyCopy(raw, 262144 - bsonBytes, end, 'kill'); bsonBytes += response.size;
        const r = fields(response.value, ['ok', 'cursorsKilled', 'cursorsNotFound', 'cursorsAlive', 'cursorsUnknown'], ['operationTime', '$clusterTime']);
        validateTransport(response.value);
        if (r.ok !== 1 || !Array.isArray(r.cursorsKilled) || !Array.isArray(r.cursorsNotFound) || !Array.isArray(r.cursorsAlive) ||
          !Array.isArray(r.cursorsUnknown) || r.cursorsAlive.length || r.cursorsUnknown.length || r.cursorsKilled.length + r.cursorsNotFound.length !== 1) fail('CLEANUP_UNCONFIRMED');
        const confirmed = long([...r.cursorsKilled, ...r.cursorsNotFound][0]); if (!sameLong(confirmed, target.id)) fail('CLEANUP_UNCONFIRMED');
        checkpoint(true); held = undefined;
      } catch { cleaned = false; }
    }
    if (session && bound) {
      try {
        // Only this privately created session may end. Drift forbids further metadata commands;
        // the held session can still end if its own client/identity is unchanged.
        try { bindingUnchanged(bound); } catch { cleaned = false; }
        sessionOwned(session, bound);
        if (performance.now() >= end) fail('DEADLINE_EXCEEDED');
        await Reflect.apply(mongo.ClientSession.prototype.endSession, session, []);
        sessionOwned(session, bound, true); observation.completion.sessionEnded = true;
        if (performance.now() >= end) cleaned = false;
      } catch { cleaned = false; }
    } else cleaned = false;
    observation.completion.cleanupConfirmed = cleaned && !held && observation.completion.sessionEnded;
    observation.completion.elapsedMs = Math.max(0, performance.now() - started);
    if (!observation.completion.cleanupConfirmed && session) {
      observation.status = 'FAILED'; observation.failure = 'CLEANUP_UNCONFIRMED';
    } else if (observation.completion.elapsedMs > 5000) { observation.status = 'INCOMPLETE'; observation.failure = 'DEADLINE_EXCEEDED'; }
    settleBytes();
    while (observation.completion.logicalMetadataBytes > USER_CONTACT_INDEX_MANIFEST.maxLogicalMetadataBytes && observation.indexes.length) {
      observation.status = 'INCOMPLETE'; observation.failure = 'LIMIT_EXCEEDED'; observation.indexes.pop(); settleBytes();
    }
    if (observation.completion.logicalMetadataBytes > 262144) {
      observation.status = 'INCOMPLETE'; observation.failure = 'LIMIT_EXCEEDED';
    }
  }
  return freezeData(observation);
}
