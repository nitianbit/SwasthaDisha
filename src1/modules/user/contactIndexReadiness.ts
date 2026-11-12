import { types } from 'util';
import { Buffer } from 'buffer';
import { USER_CONTACT_INDEX_MANIFEST } from './contactIndexManifest';

export type ContactIndexReadinessCode = 'READY' | 'MANIFEST_INVALID' | 'OBSERVATION_INVALID' | 'BINDING_UNAVAILABLE' |
  'UNSUPPORTED_PROFILE' | 'COLLECTION_UNAVAILABLE' | 'CURSOR_INCOMPLETE' | 'INDEX_BUILDING' | 'INDEX_UNSATISFIED' |
  'COLLATION_UNSATISFIED' | 'LIMIT_EXCEEDED' | 'DEADLINE_EXCEEDED' | 'OBSERVATION_FAILED' | 'CLEANUP_UNCONFIRMED';
export type ContactData = null | boolean | number | string | ContactData[] | ContactRecord;
export interface ContactRecord { [key: string]: ContactData }
export interface UserContactIndexObservation {
  schema: 'SD-USER-CONTACT-INDEX-OBSERVATION-1'; mode: 'MONGODB_8_INCLUDE_INDEX_BUILD_INFO';
  binding: { databaseName: string; collectionName: 'users'; namespace: string; collectionUuid: string } | null;
  status: 'COMPLETE' | 'INCOMPLETE' | 'FAILED' | 'UNSUPPORTED';
  collectionSpec: ContactRecord | null; indexes: ContactRecord[];
  completion: { indexRows: number; logicalMetadataBytes: number; commandCount: number; elapsedMs: number;
    collectionCursorExhausted: boolean; indexCursorExhausted: boolean; sessionEnded: boolean; cleanupConfirmed: boolean };
  failure: Exclude<ContactIndexReadinessCode, 'READY'> | null;
}
export interface ContactIndexReadinessResult { readonly metadataReady: boolean; readonly code: ContactIndexReadinessCode }
const CODES: readonly ContactIndexReadinessCode[] = ['READY', 'MANIFEST_INVALID', 'OBSERVATION_INVALID', 'BINDING_UNAVAILABLE',
  'UNSUPPORTED_PROFILE', 'COLLECTION_UNAVAILABLE', 'CURSOR_INCOMPLETE', 'INDEX_BUILDING', 'INDEX_UNSATISFIED',
  'COLLATION_UNSATISFIED', 'LIMIT_EXCEEDED', 'DEADLINE_EXCEEDED', 'OBSERVATION_FAILED', 'CLEANUP_UNCONFIRMED'];
class InvalidData extends Error { constructor(readonly code: ContactIndexReadinessCode) { super(code); } }
/** Recognize only this module's own bounded-data failure, never a supplied error code/getter. */
export function contactIndexDataFailureCode(error: unknown): ContactIndexReadinessCode | null {
  return error !== null && typeof error === 'object' && !types.isProxy(error) &&
    Object.getPrototypeOf(error) === InvalidData.prototype ? (error as InvalidData).code : null;
}
function bad(code: ContactIndexReadinessCode = 'OBSERVATION_INVALID'): never { throw new InvalidData(code); }
function result(code: ContactIndexReadinessCode): ContactIndexReadinessResult { return Object.freeze({ metadataReady: code === 'READY', code }); }
function has(o: ContactRecord, k: string): boolean { return Object.prototype.hasOwnProperty.call(o, k); }
function record(v: ContactData): v is ContactRecord { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function fields(o: ContactRecord, required: readonly string[], optional: readonly string[] = []): boolean {
  return required.every(k => has(o, k)) && Object.keys(o).every(k => required.includes(k) || optional.includes(k));
}
function name(v: ContactData, max = 256): v is string {
  return typeof v === 'string' && Buffer.byteLength(v, 'utf8') > 0 && Buffer.byteLength(v, 'utf8') <= max && !v.includes('\0');
}
function integer(v: ContactData, max = Number.MAX_SAFE_INTEGER): v is number {
  return typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= max;
}
function jsonStringBytes(s: string): number {
  let n = 2;
  for (const c of s) {
    const p = c.codePointAt(0)!;
    n += p < 32 || (p >= 0xd800 && p <= 0xdfff) ? 6 : c === '"' || c === '\\' ? 2 : Buffer.byteLength(c, 'utf8');
  }
  return n;
}

/** Shared only by this purpose-specific evaluator/reader; invokes no supplied methods or callbacks. */
export function copyUserContactIndexData(value: unknown): ContactData {
  const active = new Set<object>(); let nodes = 0; let bytes = 0;
  const take = (n: number) => { bytes += n; if (bytes > 262144) bad('LIMIT_EXCEEDED'); };
  const copy = (v: unknown, depth: number): ContactData => {
    if (++nodes > 8192 || depth > 16) bad('LIMIT_EXCEEDED');
    if (v === null) { take(4); return null; }
    if (typeof v === 'boolean') { take(v ? 4 : 5); return v; }
    if (typeof v === 'number') { if (!Number.isFinite(v)) bad(); take(JSON.stringify(v).length); return v; }
    if (typeof v === 'string') { take(jsonStringBytes(v)); return v; }
    if (typeof v !== 'object' || types.isProxy(v) || active.has(v)) bad();
    const proto = Object.getPrototypeOf(v); const keys = Reflect.ownKeys(v);
    if (keys.length > 8192 - nodes) bad('LIMIT_EXCEEDED');
    if (keys.some(k => typeof k !== 'string')) bad();
    active.add(v); take(2);
    let out: ContactData;
    if (Array.isArray(v)) {
      const length = Object.getOwnPropertyDescriptor(v, 'length');
      if (proto !== Array.prototype || !length || !('value' in length) || !Number.isSafeInteger(length.value) ||
        length.value < 0 || length.value > 8192 || keys.length !== length.value + 1) bad();
      const a: ContactData[] = [];
      for (let i = 0; i < length.value; i++) {
        const d = Object.getOwnPropertyDescriptor(v, String(i));
        if (!d || !('value' in d) || !d.enumerable || keys[i] !== String(i)) bad();
        if (i) take(1); a.push(copy(d.value, depth + 1));
      }
      out = a;
    } else {
      if (proto !== Object.prototype && proto !== null) bad();
      const o: ContactRecord = Object.create(null) as ContactRecord;
      for (let i = 0; i < keys.length; i++) {
        const k = keys[i] as string; const d = Object.getOwnPropertyDescriptor(v, k);
        if (!d || !('value' in d) || !d.enumerable || k.includes('\0')) bad();
        take(jsonStringBytes(k) + 1 + (i ? 1 : 0)); o[k] = copy(d.value, depth + 1);
      }
      out = o;
    }
    active.delete(v); return out;
  };
  return copy(value, 0);
}
function equal(a: ContactData, b: ContactData): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((v, i) => equal(v, b[i]));
  return record(a) && record(b) && Object.keys(a).length === Object.keys(b).length && Object.keys(a).every(k => has(b, k) && equal(a[k], b[k]));
}
function depthOK(v: ContactData, depth = 0): boolean {
  return depth <= 6 && (Array.isArray(v) ? v.every(x => depthOK(x, depth + 1)) : record(v) ? Object.values(v).every(x => depthOK(x, depth + 1)) : true);
}
function collation(v: ContactData): boolean {
  if (!record(v) || !fields(v, ['locale'], ['caseLevel', 'caseFirst', 'strength', 'numericOrdering', 'alternate', 'maxVariable', 'normalization', 'backwards', 'version']) || !name(v.locale)) return false;
  for (const key of ['caseLevel', 'numericOrdering', 'normalization', 'backwards']) if (has(v, key) && typeof v[key] !== 'boolean') return false;
  return (!has(v, 'caseFirst') || ['upper', 'lower', 'off'].includes(v.caseFirst as string)) &&
    (!has(v, 'strength') || (integer(v.strength, 5) && v.strength >= 1)) &&
    (!has(v, 'alternate') || ['non-ignorable', 'shifted'].includes(v.alternate as string)) &&
    (!has(v, 'maxVariable') || ['punct', 'space'].includes(v.maxVariable as string)) && (!has(v, 'version') || name(v.version, 32));
}
function simple(v: ContactData): boolean { return record(v) && fields(v, ['locale']) && v.locale === 'simple'; }
function key(v: ContactData, expected?: readonly [string, number | string][]): boolean {
  if (!record(v) || !Object.keys(v).length || Object.keys(v).length > 16 || !Object.keys(v).every(k => name(k))) return false;
  if (expected) return Object.keys(v).length === expected.length && expected.every(([k, n], i) => Object.keys(v)[i] === k && v[k] === n);
  return Object.values(v).every(n => n === 1 || n === -1);
}
function parseSpec(s: ContactData, namespace: string): ContactRecord {
  if (!record(s)) bad('UNSUPPORTED_PROFILE');
  if (has(s, 'indexBuildInfo') || has(s, 'buildUUID')) bad('INDEX_BUILDING');
  const text = record(s.key) && Object.values(s.key).some(v => typeof v === 'string');
  if (!fields(s, ['v', 'key', 'name'], ['ns', 'unique', 'sparse', 'hidden', 'background', 'expireAfterSeconds', 'partialFilterExpression', 'collation',
    ...(text ? ['weights', 'textIndexVersion', 'default_language', 'language_override'] : [])]) || (s.v !== 1 && s.v !== 2) || !name(s.name) ||
    (has(s, 'ns') && s.ns !== namespace)) bad('UNSUPPORTED_PROFILE');
  for (const k of ['unique', 'sparse', 'hidden', 'background']) if (has(s, k) && typeof s[k] !== 'boolean') bad('UNSUPPORTED_PROFILE');
  if (has(s, 'expireAfterSeconds') && !integer(s.expireAfterSeconds, 2147483647)) bad('UNSUPPORTED_PROFILE');
  if (has(s, 'partialFilterExpression') && (!record(s.partialFilterExpression) || !depthOK(s.partialFilterExpression))) bad('UNSUPPORTED_PROFILE');
  if (has(s, 'collation') && !collation(s.collation)) bad('UNSUPPORTED_PROFILE');
  if (text) {
    if (s.name !== 'name_text' || !key(s.key, [['_fts', 'text'], ['_ftsx', 1]]) || !record(s.weights) ||
      !fields(s.weights, ['name']) || s.weights.name !== 1 || s.textIndexVersion !== 3 ||
      (has(s, 'default_language') && s.default_language !== 'english') || (has(s, 'language_override') && s.language_override !== 'language') ||
      has(s, 'expireAfterSeconds') || has(s, 'partialFilterExpression') || s.unique === true || s.sparse === true || s.hidden === true) bad('UNSUPPORTED_PROFILE');
  } else if (!key(s.key)) bad('UNSUPPORTED_PROFILE');
  return s;
}
function idSpec(s: ContactRecord): boolean {
  return s.name === '_id_' && key(s.key, [['_id', 1]]) && (!has(s, 'unique') || s.unique === true) && s.sparse !== true && s.hidden !== true &&
    !has(s, 'expireAfterSeconds') && !has(s, 'partialFilterExpression');
}
function parseCollection(v: ContactData, namespace: string, uuid: string): { value: ContactRecord; id: ContactRecord; defaultCollation: ContactData } {
  if (!record(v) || !fields(v, ['name', 'type', 'options', 'info', 'idIndex']) || v.name !== 'users' || v.type !== 'collection' ||
    !record(v.options) || !fields(v.options, [], ['collation']) || !record(v.info) || !fields(v.info, ['readOnly', 'uuid']) ||
    v.info.readOnly !== false || v.info.uuid !== uuid || (has(v.options, 'collation') && !collation(v.options.collation))) bad('UNSUPPORTED_PROFILE');
  const id = parseSpec(v.idIndex, namespace); if (!idSpec(id)) bad('INDEX_UNSATISFIED');
  return { value: v, id, defaultCollation: has(v.options, 'collation') ? v.options.collation : { locale: 'simple' } };
}
/** Reader's shared structural checks do not constitute whole-observation readiness. */
export function inspectUserContactCollectionSpec(value: unknown, namespace: string, uuid: string): ContactIndexReadinessCode {
  try { parseCollection(copyUserContactIndexData(value), namespace, uuid); return 'READY'; }
  catch (e) { return e instanceof InvalidData ? e.code : 'OBSERVATION_INVALID'; }
}
export function inspectUserContactIndexRow(value: unknown, namespace: string): ContactIndexReadinessCode {
  try {
    const row = copyUserContactIndexData(value);
    if (!record(row)) bad('UNSUPPORTED_PROFILE');
    if (has(row, 'indexBuildInfo') || has(row, 'buildUUID')) bad('INDEX_BUILDING');
    if (!fields(row, ['spec'])) bad('UNSUPPORTED_PROFILE'); parseSpec(row.spec, namespace); return 'READY';
  } catch (e) { return e instanceof InvalidData ? e.code : 'OBSERVATION_INVALID'; }
}

export function evaluateUserContactIndexReadiness(manifest: unknown, observation: unknown): ContactIndexReadinessResult {
  let m: ContactData;
  try { m = copyUserContactIndexData(manifest); if (!equal(m, USER_CONTACT_INDEX_MANIFEST as unknown as ContactData)) return result('MANIFEST_INVALID'); }
  catch { return result('MANIFEST_INVALID'); }
  try {
    const o = copyUserContactIndexData(observation);
    if (!record(o) || !fields(o, ['schema', 'mode', 'binding', 'status', 'collectionSpec', 'indexes', 'completion', 'failure']) ||
      o.schema !== 'SD-USER-CONTACT-INDEX-OBSERVATION-1' || o.mode !== 'MONGODB_8_INCLUDE_INDEX_BUILD_INFO' ||
      !['COMPLETE', 'INCOMPLETE', 'FAILED', 'UNSUPPORTED'].includes(o.status as string) || !Array.isArray(o.indexes) || !record(o.completion)) bad();
    const c = o.completion;
    if (!fields(c, ['indexRows', 'logicalMetadataBytes', 'commandCount', 'elapsedMs', 'collectionCursorExhausted', 'indexCursorExhausted', 'sessionEnded', 'cleanupConfirmed']) ||
      !integer(c.indexRows) || c.indexRows !== o.indexes.length || !integer(c.logicalMetadataBytes) || !integer(c.commandCount, 7) ||
      typeof c.elapsedMs !== 'number' || !Number.isFinite(c.elapsedMs) || c.elapsedMs < 0 ||
      !['collectionCursorExhausted', 'indexCursorExhausted', 'sessionEnded', 'cleanupConfirmed'].every(k => typeof c[k] === 'boolean')) bad();
    if (o.indexes.length > 64 || c.logicalMetadataBytes > 262144 || Buffer.byteLength(JSON.stringify(o)) > c.logicalMetadataBytes) bad('LIMIT_EXCEEDED');
    if (c.elapsedMs > 5000) bad('DEADLINE_EXCEEDED');
    const b = o.binding;
    if (b !== null && (!record(b) || !fields(b, ['databaseName', 'collectionName', 'namespace', 'collectionUuid']) || !name(b.databaseName, 128) ||
      b.collectionName !== 'users' || b.namespace !== b.databaseName + '.users' || typeof b.collectionUuid !== 'string' || !/^[a-f0-9]{32}$/.test(b.collectionUuid))) bad('BINDING_UNAVAILABLE');
    if (o.status !== 'COMPLETE') {
      if (typeof o.failure !== 'string' || !CODES.includes(o.failure as ContactIndexReadinessCode) || o.failure === 'READY') bad();
      return result(o.failure as ContactIndexReadinessCode);
    }
    if (b === null) bad('BINDING_UNAVAILABLE');
    if (!record(b) || o.failure !== null || c.commandCount < 2 || c.commandCount > 6) bad();
    if (!c.cleanupConfirmed || !c.sessionEnded) bad('CLEANUP_UNCONFIRMED');
    if (!c.collectionCursorExhausted || !c.indexCursorExhausted) bad('CURSOR_INCOMPLETE');
    const collection = parseCollection(o.collectionSpec, b.namespace as string, b.collectionUuid as string);
    const names = new Set<string>(); const specs: ContactRecord[] = [];
    for (const item of o.indexes) {
      if (!record(item)) bad('UNSUPPORTED_PROFILE');
      if (has(item, 'indexBuildInfo') || has(item, 'buildUUID')) bad('INDEX_BUILDING');
      if (!fields(item, ['spec'])) bad('UNSUPPORTED_PROFILE');
      const s = parseSpec(item.spec, b.namespace as string); if (names.has(s.name as string)) bad('OBSERVATION_INVALID');
      names.add(s.name as string); specs.push(s);
    }
    const id = specs.find(s => s.name === '_id_');
    if (!id || !idSpec(id) || !specs.some(s => s.name === 'name_text' && key(s.key, [['_fts', 'text'], ['_ftsx', 1]])) || id.v !== collection.id.v) bad('INDEX_UNSATISFIED');
    for (const option of ['unique', 'sparse', 'hidden', 'background']) {
      const implicit = option === 'unique';
      if ((has(id, option) ? id[option] : implicit) !== (has(collection.id, option) ? collection.id[option] : implicit)) bad('INDEX_UNSATISFIED');
    }
    const idCollation = has(id, 'collation') ? id.collation : collection.defaultCollation;
    const collectionIdCollation = has(collection.id, 'collation') ? collection.id.collation : collection.defaultCollation;
    if (!equal(idCollation, collectionIdCollation)) bad('INDEX_UNSATISFIED');
    const contact = specs.find(s => s.name === 'user_contact_keys_v1');
    if (!contact || !key(contact.key, [['contactKeys', 1]]) || contact.unique !== true || contact.sparse === true || contact.hidden === true ||
      has(contact, 'expireAfterSeconds') || !record(contact.partialFilterExpression) || !fields(contact.partialFilterExpression, ['contactKeys']) ||
      !record(contact.partialFilterExpression.contactKeys) || !fields(contact.partialFilterExpression.contactKeys, ['$type']) ||
      contact.partialFilterExpression.contactKeys.$type !== 'array') bad('INDEX_UNSATISFIED');
    if (!simple(has(contact, 'collation') ? contact.collation : collection.defaultCollation)) bad('COLLATION_UNSATISFIED');
    return result('READY');
  } catch (e) { return result(e instanceof InvalidData ? e.code : 'OBSERVATION_INVALID'); }
}
