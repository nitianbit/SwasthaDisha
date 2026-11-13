import fs from 'fs';
import path from 'path';
import { createHash, createPublicKey, KeyObject, verify } from 'crypto';
import { types } from 'util';
import sourceManifest from './labAuthoritySourceManifest.json';
import { LabAuthorityAction, LabAuthorityError, LabIssuerProof } from './types';

type Data = Record<string, unknown>;
export const labFailure = (code: 'LAB_AUTHORITY_INPUT_INVALID' | 'LAB_AUTHORITY_DENIED' | 'LAB_AUTHORITY_CONFLICT' | 'LAB_AUTHORITY_UNAVAILABLE' = 'LAB_AUTHORITY_UNAVAILABLE'): never => { throw new LabAuthorityError(code); };
export function labCheck(ok: unknown, code?: Parameters<typeof labFailure>[0]): asserts ok { if (!ok) labFailure(code); }
export const labSha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
export const labId = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{24}$/.test(v);
export const labDigest = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
export const labTime = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && !Object.is(v, -0) && v >= 0 && v <= 8640000000000000;
export const labRevision = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
export function labNext(value: number): number { labCheck(labRevision(value), 'LAB_AUTHORITY_UNAVAILABLE'); labCheck(value < Number.MAX_SAFE_INTEGER, 'LAB_AUTHORITY_CONFLICT'); return value + 1; }
export const labSame = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const dateFields = new Set(['createdAt', 'updatedAt', 'decidedAt', 'validFrom', 'expiresAt', 'verificationValidFrom', 'verificationExpiresAt']);
/** Owned data only. Native Dates are admitted only at declared persisted timestamp positions. */
export function labData(value: unknown, dates = false, maxNodes = 8192, maxBytes = 2097152, maxDepth = 16): unknown {
  let nodes = 0, bytes = 0; const active = new Set<object>();
  const copy = (v: unknown, key: string, depth: number): unknown => {
    labCheck(++nodes <= maxNodes && depth <= maxDepth);
    if (v === null || typeof v === 'boolean') return v;
    if (typeof v === 'string') { bytes += Buffer.byteLength(v); labCheck(bytes <= maxBytes); return v; }
    if (typeof v === 'number') { labCheck(Number.isFinite(v) && !Object.is(v, -0)); return v; }
    labCheck(v !== null && typeof v === 'object' && !types.isProxy(v) && !active.has(v));
    const proto = Object.getPrototypeOf(v);
    if (dates && proto === Date.prototype && dateFields.has(key)) {
      labCheck(Reflect.ownKeys(v).length === 0); const n = Reflect.apply(Date.prototype.getTime, v, []); labCheck(labTime(n)); return n;
    }
    active.add(v); const keys = Reflect.ownKeys(v); labCheck(keys.length <= maxNodes - nodes);
    let result: unknown;
    if (Array.isArray(v)) {
      const d = Object.getOwnPropertyDescriptor(v, 'length');
      labCheck(proto === Array.prototype && d && 'value' in d && Number.isSafeInteger(d.value) && d.value >= 0 && keys.length === d.value + 1 && keys[d.value] === 'length');
      const a: unknown[] = [];
      for (let i = 0; i < d.value; i++) { const e = Object.getOwnPropertyDescriptor(v, String(i)); labCheck(keys[i] === String(i) && e && 'value' in e && e.enumerable); a.push(copy(e.value, '', depth + 1)); }
      result = a;
    } else {
      labCheck(proto === Object.prototype || proto === null); const record: Data = {};
      for (const k of keys) { labCheck(typeof k === 'string' && k !== '__proto__' && k !== 'constructor' && k !== 'prototype'); const d = Object.getOwnPropertyDescriptor(v, k); labCheck(d && 'value' in d && d.enumerable); bytes += Buffer.byteLength(k); labCheck(bytes <= maxBytes); record[k] = copy(d.value, k, depth + 1); }
      result = record;
    }
    active.delete(v); return Object.freeze(result);
  };
  return copy(value, '', 0);
}
export function labShape(value: unknown, required: readonly string[], optional: readonly string[] = []): Data {
  labCheck(value !== null && typeof value === 'object' && !types.isProxy(value) && !Array.isArray(value));
  const proto = Object.getPrototypeOf(value), keys = Reflect.ownKeys(value);
  labCheck((proto === Object.prototype || proto === null) && keys.every(k => typeof k === 'string' && [...required, ...optional].includes(k)) && required.every(k => Object.prototype.hasOwnProperty.call(value, k)));
  const out: Data = {};
  for (const k of keys as string[]) { const d = Object.getOwnPropertyDescriptor(value, k); labCheck(d && 'value' in d && d.enumerable); out[k] = d.value; }
  return out;
}
function sortedIds(value: unknown): readonly string[] {
  labCheck(Array.isArray(value) && value.length >= 1 && value.length <= 100);
  labCheck(value.every((v, i) => labId(v) && (i === 0 || value[i - 1] < v))); return value as string[];
}
function text(value: unknown, max: number): value is string { return typeof value === 'string' && Buffer.from(value, 'utf8').toString('utf8') === value && value.trim() === value && value.normalize('NFC') === value && [...value].length >= 1 && [...value].length <= max && !/[\u0000-\u001f\u007f-\u009f]/.test(value); }
function decode64(value: unknown, size: number): Buffer { labCheck(typeof value === 'string'); const b = Buffer.from(value, 'base64'); labCheck(b.length === size && b.toString('base64') === value); return b; }
export interface LabCommand {
  readonly body: readonly unknown[]; readonly commandJson: string; readonly commandSha256: string; readonly signatureBase64: string;
  readonly authorityGeneration: string; readonly keyId: string; readonly issuerUserId: string; readonly organizationId: string;
  readonly operationId: string; readonly decisionId: string; readonly submittedAt: number; readonly notAfter: number;
  readonly action: LabAuthorityAction; readonly payload: readonly unknown[];
}
export function parseLabCommand(raw: unknown): LabCommand {
  try {
    labCheck(typeof raw === 'string' && Buffer.byteLength(raw) <= 16384, 'LAB_AUTHORITY_INPUT_INVALID');
    const envelope = labData(JSON.parse(raw), false, 512, 16384, 8);
    labCheck(Array.isArray(envelope) && envelope.length === 2 && JSON.stringify(envelope) === raw);
    const b = envelope[0], signature = envelope[1]; labCheck(Array.isArray(b) && b.length === 12); decode64(signature, 64);
    labCheck(b[0] === 'sd.lab.authority.command' && b[1] === 1 && labDigest(b[2]) && labDigest(b[3]) && [4, 5, 6, 7].every(i => labId(b[i])) && labTime(b[8]) && labTime(b[9]) && b[8] < b[9] && b[9] <= b[8] + 900000);
    const a = b[10], p = b[11]; labCheck(Array.isArray(p));
    if (a === 'map_lab') {
      labCheck(p.length === 11 && labId(p[0]) && p[0] !== b[5] && p[1] === 0 && p[2] === 0 && text(p[3], 160) && text(p[4], 128) && labTime(p[5]) && labTime(p[6]) && p[5] < p[6] && labId(p[7]) && labDigest(p[8]) && p[10] === 'initial_mapping'); sortedIds(p[9]);
    } else if (a === 'grant_lab_reader') {
      labCheck(p.length === 10 && labId(p[0]) && labId(p[1]) && typeof p[2] === 'number' && Number.isSafeInteger(p[2]) && !Object.is(p[2], -0) && p[2] >= 0 && labRevision(p[3]) && labId(p[4]) && labTime(p[5]) && labTime(p[6]) && p[5] < p[6] && labId(p[7]) && labDigest(p[8]) && p[9] === 'operational_assignment');
    } else if (a === 'revoke_lab_reader') {
      labCheck(p.length === 7 && labId(p[0]) && labId(p[1]) && labRevision(p[2]) && labRevision(p[3]) && labId(p[4]) && labDigest(p[5]) && p[6] === 'access_withdrawn');
    } else labFailure();
    const commandJson = JSON.stringify(b);
    return Object.freeze({ body: b, commandJson, commandSha256: labSha(commandJson), signatureBase64: signature as string,
      authorityGeneration: b[2] as string, keyId: b[3] as string, issuerUserId: b[4] as string, organizationId: b[5] as string,
      operationId: b[6] as string, decisionId: b[7] as string, submittedAt: b[8] as number, notAfter: b[9] as number, action: a as LabAuthorityAction, payload: p });
  } catch { return labFailure('LAB_AUTHORITY_INPUT_INVALID'); }
}
export interface ProtectedRead { readonly bytes: Buffer; check(): void; close(): void }
function protectedRead(filename: string, max: number): ProtectedRead {
  let fd: number | undefined;
  try {
    const absolute = path.resolve(filename); labCheck(absolute === filename && fs.realpathSync(filename) === filename);
    let directory = path.dirname(filename);
    for (;;) { const s = fs.lstatSync(directory, { bigint: true }); labCheck(s.isDirectory() && !s.isSymbolicLink() && (s.mode & 0o022n) === 0n); const parent = path.dirname(directory); if (parent === directory) break; directory = parent; }
    fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const original = fs.fstatSync(fd, { bigint: true }); const uid = BigInt(process.getuid!());
    labCheck(original.isFile() && original.nlink === 1n && original.size > 0n && original.size <= BigInt(max) && (original.uid === 0n || original.uid === uid) && [0o400n, 0o600n].includes(original.mode & 0o777n));
    const held = fd, bounded = Buffer.alloc(max + 1); let used = 0;
    for (;;) { const count = fs.readSync(held, bounded, used, bounded.length - used, used); used += count; labCheck(used <= max); if (count === 0) break; }
    const bytes = Buffer.from(bounded.subarray(0, used)); labCheck(bytes.length === Number(original.size));
    const check = () => {
      const current = fs.fstatSync(held, { bigint: true }), named = fs.lstatSync(filename, { bigint: true });
      labCheck(['dev', 'ino', 'nlink', 'uid', 'mode', 'size', 'mtimeNs', 'ctimeNs'].every(k => current[k as keyof typeof current] === original[k as keyof typeof original] && named[k as keyof typeof named] === original[k as keyof typeof original]) && !named.isSymbolicLink());
    };
    check(); fd = undefined; let closed = false;
    return { bytes, check() { labCheck(!closed); check(); }, close() { if (!closed) { closed = true; fs.closeSync(held); } } };
  } catch { if (fd !== undefined) fs.closeSync(fd); return labFailure(); }
}
export interface LabRoot {
  readonly record: Readonly<Data>; readonly key: KeyObject; readonly file: ProtectedRead;
  readonly authorityGeneration: string; readonly keyId: string; readonly issuerUserId: string;
  readonly state: 'active' | 'verification_only' | 'revoked'; readonly validFrom: number; readonly expiresAt: number;
  readonly scopes: ReadonlyArray<readonly [string, readonly string[]]>;
}
export function readLabRoot(): LabRoot {
  const file = protectedRead('/etc/swasthadisha/lab-authority-root.json', 32768);
  try {
    const text = file.bytes.toString('utf8'); labCheck(Buffer.from(text).equals(file.bytes)); const raw = labData(JSON.parse(text)); labCheck(JSON.stringify(raw) === text);
    const r = labShape(raw, ['schema', 'authorityGeneration', 'writerManifestSha256', 'issuerUserId', 'keyId', 'publicKeySpkiBase64', 'state', 'validFrom', 'expiresAt', 'scopes']);
    const manifestHash = labSha(JSON.stringify(sourceManifest.files));
    labCheck(sourceManifest.files.length > 0 && manifestHash === sourceManifest.aggregateSha256 && r.writerManifestSha256 === manifestHash);
    labCheck(r.schema === 'SD-LAB-AUTHORITY-ROOT-1' && labDigest(r.authorityGeneration) && labId(r.issuerUserId) && labDigest(r.keyId) && ['active', 'verification_only', 'revoked'].includes(r.state as string) && labTime(r.validFrom) && labTime(r.expiresAt) && r.validFrom < r.expiresAt && typeof r.publicKeySpkiBase64 === 'string');
    const der = Buffer.from(r.publicKeySpkiBase64, 'base64'); labCheck(der.length <= 128 && der.toString('base64') === r.publicKeySpkiBase64 && labSha(der) === r.keyId);
    const key = createPublicKey({ key: der, format: 'der', type: 'spki' }); labCheck(key.asymmetricKeyType === 'ed25519' && key.export({ format: 'der', type: 'spki' }).equals(der));
    labCheck(Array.isArray(r.scopes) && r.scopes.length >= 1 && r.scopes.length <= 100);
    const scopes = r.scopes.map((entry: unknown, index: number) => { labCheck(Array.isArray(entry) && entry.length === 2 && labId(entry[0]) && (index === 0 || (r.scopes as unknown[][])[index - 1][0] < entry[0])); return Object.freeze([entry[0], sortedIds(entry[1])] as const); });
    return Object.freeze({ record: Object.freeze(r), key, file, authorityGeneration: r.authorityGeneration as string, keyId: r.keyId as string,
      issuerUserId: r.issuerUserId as string, state: r.state as LabRoot['state'], validFrom: r.validFrom as number, expiresAt: r.expiresAt as number, scopes });
  } catch { file.close(); return labFailure(); }
}
export function checkLabSignature(command: LabCommand, root: LabRoot, callbackTime: number, historical = false): void {
  labCheck(root.state === 'active' || (historical && root.state === 'verification_only'), 'LAB_AUTHORITY_DENIED');
  labCheck(command.authorityGeneration === root.authorityGeneration && command.keyId === root.keyId && command.issuerUserId === root.issuerUserId && root.scopes.some(s => s[0] === command.organizationId), 'LAB_AUTHORITY_DENIED');
  labCheck(root.validFrom <= command.submittedAt && command.notAfter <= root.expiresAt && command.submittedAt <= callbackTime && callbackTime < command.notAfter, 'LAB_AUTHORITY_INPUT_INVALID');
  labCheck(verify(null, Buffer.from(command.commandJson), root.key, decode64(command.signatureBase64, 64)), 'LAB_AUTHORITY_DENIED');
  root.file.check();
}
export function checkLabScope(command: LabCommand, root: LabRoot, branches: readonly string[]): void {
  const scope = root.scopes.find(s => s[0] === command.organizationId); labCheck(scope && branches.every(b => scope[1].includes(b)), 'LAB_AUTHORITY_DENIED');
}
export function labEvidence(command: LabCommand): { evidenceVersionId: string; evidenceSha256: string } {
  const p = command.payload, offset = command.action === 'revoke_lab_reader' ? 4 : 7;
  return { evidenceVersionId: p[offset] as string, evidenceSha256: p[offset + 1] as string };
}
export function readLabEvidence(reference: { evidenceVersionId: string; evidenceSha256: string }): ProtectedRead {
  labCheck(labId(reference.evidenceVersionId) && labDigest(reference.evidenceSha256));
  const file = protectedRead('/var/lib/swasthadisha/lab-authority-evidence/' + reference.evidenceVersionId, 1048576);
  try { labCheck(labSha(file.bytes) === reference.evidenceSha256); return file; } catch { file.close(); return labFailure(); }
}
export function labProof(command: LabCommand): LabIssuerProof {
  return Object.freeze({ schema: 'SD-LAB-AUTHORITY-ISSUER-PROOF-1', keyId: command.keyId, commandJson: command.commandJson,
    commandSha256: command.commandSha256, signatureBase64: command.signatureBase64 });
}
