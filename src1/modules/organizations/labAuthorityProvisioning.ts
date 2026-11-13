import { ClientSession, Model } from 'mongoose';
import { AuthorityDecision, LabAuthorityError, LabAuthorityReceipt } from './types';
import { decisionDigest } from './rules';
import { assertLabAuthoritySnapshot, LabAuthoritySnapshot, observeLabAuthorityReadiness, requireLabIssuer, startLabAuthoritySession } from './labAuthorityReadiness';
import { checkLabScope, checkLabSignature, LabCommand, LabRoot, ProtectedRead, labCheck, labData, labDigest, labEvidence, labFailure, labId, labNext, labProof, labRevision, labSame, labSha, labShape, labTime, parseLabCommand, readLabEvidence, readLabRoot } from './labAuthorityRoot';

type Data = Record<string, unknown>;
const base = ['_id', 'schemaVersion', 'revision', 'createdAt', 'updatedAt'];
const decisionFields = ['_id', 'schemaVersion', 'organizationId', 'operationId', 'decisionKind', 'decidingActorId', 'decidedAt', 'authorityGeneration', 'payloadSha256', 'payload', 'evidence', 'createdAt', 'updatedAt', 'issuerProof'];
const timestamps = new Set(['createdAt', 'updatedAt', 'decidedAt', 'validFrom', 'expiresAt', 'verificationValidFrom', 'verificationExpiresAt']);
const toDatabase = (value: unknown, key = ''): unknown => {
  if (typeof value === 'number' && timestamps.has(key)) return new Date(value);
  if (Array.isArray(value)) return value.map(v => toDatabase(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toDatabase(v, k)]));
  return value;
};
const fingerprint = (c: LabCommand): string => {
  const p = c.payload;
  return labSha(JSON.stringify(['business-source', 1, 'lab', ['_id', p[0]], ['organizationId', c.organizationId], ['revision', 1], ['legalName', p[3]], ['registrationReference', p[4]], ['state', 'active'], ['verificationValidFrom', p[5]], ['verificationExpiresAt', p[6]], ['evidenceVersionId', p[7]], ['evidenceSha256', p[8]]]));
};
function version(row: Data, now: number): void {
  labCheck(labId(row._id) && row.schemaVersion === 1 && labRevision(row.revision) && labTime(row.createdAt) && labTime(row.updatedAt) && row.createdAt <= row.updatedAt && row.updatedAt <= now);
}
interface Work {
  readonly snapshot: LabAuthoritySnapshot; readonly session: ClientSession; readonly root: LabRoot; readonly now: number;
  readonly files: Map<string, ProtectedRead>;
}
function evidence(work: Work, command: LabCommand): void {
  const ref = labEvidence(command), key = ref.evidenceVersionId + ':' + ref.evidenceSha256;
  if (!work.files.has(key)) { labCheck(work.files.size < 8); work.files.set(key, readLabEvidence(ref)); }
  work.files.get(key)!.check();
}
function guard(work: Work): void {
  assertLabAuthoritySnapshot(work.snapshot, work.session); work.root.file.check(); for (const file of work.files.values()) file.check();
  const fresh = readLabRoot(); try { labCheck(fresh.file.bytes.equals(work.root.file.bytes)); } finally { fresh.file.close(); }
}
async function rows(work: Work, model: Model<Record<string, unknown>>, filter: Data): Promise<Data[]> {
  guard(work); labCheck(model.db === work.snapshot.connection);
  // Fixed whole protected-authority document projection: retain unknown fields so closed validation cannot hide them.
  // These exact-ID/org-scoped records contain authority provenance only, never a User profile.
  const raw = await model.find(filter).select({}).session(work.session).collation({ locale: 'simple' }).limit(2).maxTimeMS(2000).lean().exec();
  guard(work); const copied = labData(raw, true); labCheck(Array.isArray(copied) && copied.length <= 2); return copied as Data[];
}
function one(values: Data[]): Data { labCheck(values.length === 1); return values[0]; }
function member(raw: Data, now: number): Data {
  const m = labShape(raw, [...base, 'organizationId', 'actorId', 'state', 'validFrom', 'expiresAt', 'grants']); version(m, now);
  labCheck(labId(m.organizationId) && labId(m.actorId) && ['active', 'suspended', 'revoked'].includes(m.state as string) && labTime(m.validFrom) && labTime(m.expiresAt) && m.validFrom < m.expiresAt && Array.isArray(m.grants) && m.grants.length === 1);
  const g = labShape(m.grants[0], ['branchId', 'capability', 'grantDecisionId']); labCheck(labId(g.branchId) && labId(g.grantDecisionId) && g.capability === 'lab.worklist.read'); return m;
}
function derive(c: LabCommand, at: number, previousGrant?: Data): Data {
  const p = c.payload; let payload: Data, kind: string;
  if (c.action === 'map_lab') {
    kind = 'business_mapped'; payload = { organizationId: c.organizationId, organizationRevision: 1, kind: 'lab', sourceBusinessId: p[0], sourceFingerprint: fingerprint(c), branches: (p[9] as string[]).map(branchId => ({ branchId, state: 'active', revision: 1 })) };
  } else if (c.action === 'grant_lab_reader') {
    kind = 'membership_granted'; const revision = p[2] === 0 ? 1 : labNext(p[2] as number);
    payload = { organizationId: c.organizationId, actorId: p[0], membershipId: p[1], membershipRevision: revision, validFrom: p[5], expiresAt: p[6], grants: [{ branchId: p[4], capability: 'lab.worklist.read', grantDecisionId: c.decisionId }], branchId: p[4], capability: 'lab.worklist.read' };
  } else {
    labCheck(previousGrant); const g = previousGrant.payload as Data;
    labCheck(g.organizationId === c.organizationId && g.actorId === p[0] && g.membershipId === p[1] && g.membershipRevision === p[2]);
    kind = 'lab_membership_revoked'; payload = { organizationId: c.organizationId, actorId: p[0], membershipId: p[1], membershipRevision: labNext(p[2] as number), previousMembershipRevision: p[2], previousGrantDecisionId: previousGrant._id, branchId: g.branchId, capability: 'lab.worklist.read', operationalFence: labNext(p[3] as number), reasonCode: 'access_withdrawn' };
  }
  const d: Data = { _id: c.decisionId, schemaVersion: 1, organizationId: c.organizationId, operationId: c.operationId, decisionKind: kind,
    ...(c.action !== 'map_lab' ? { subjectActorId: p[0] } : {}), decidingActorId: c.issuerUserId, decidedAt: c.submittedAt,
    authorityGeneration: c.authorityGeneration, payloadSha256: '', payload, evidence: [labEvidence(c)], createdAt: at, updatedAt: at, issuerProof: labProof(c) };
  d.payloadSha256 = decisionDigest(d as unknown as AuthorityDecision); return d;
}
/** Authenticates a historical decision and reconstructs its entire signed derivation. */
async function history(work: Work, raw: Data, expected: 'business_mapped' | 'membership_granted' | 'lab_membership_revoked', revokeGrant?: Data): Promise<{ decision: Data; command: LabCommand }> {
  const d = labShape(raw, [...decisionFields, ...(expected === 'business_mapped' ? [] : ['subjectActorId'])]);
  labCheck(d.schemaVersion === 1 && d.decisionKind === expected && labId(d._id) && labId(d.organizationId) && labId(d.operationId) && labId(d.decidingActorId) && labDigest(d.authorityGeneration) && labDigest(d.payloadSha256) && labTime(d.createdAt) && labTime(d.updatedAt) && d.createdAt === d.updatedAt && d.updatedAt <= work.now);
  const proof = labShape(d.issuerProof, ['schema', 'keyId', 'commandJson', 'commandSha256', 'signatureBase64']);
  labCheck(proof.schema === 'SD-LAB-AUTHORITY-ISSUER-PROOF-1' && typeof proof.commandJson === 'string' && labDigest(proof.commandSha256) && typeof proof.signatureBase64 === 'string');
  let command: LabCommand;
  try { command = parseLabCommand(JSON.stringify([JSON.parse(proof.commandJson), proof.signatureBase64])); }
  catch { return labFailure(); }
  labCheck(command.commandJson === proof.commandJson && command.commandSha256 === proof.commandSha256 && command.keyId === proof.keyId && command.organizationId === d.organizationId && command.decisionId === d._id && command.operationId === d.operationId && command.issuerUserId === d.decidingActorId && command.submittedAt === d.decidedAt);
  try { checkLabSignature(command, work.root, d.createdAt, true); }
  catch (error) { if (error instanceof LabAuthorityError && error.code === 'LAB_AUTHORITY_DENIED') throw error; return labFailure(); }
  if (command.action !== 'map_lab') labCheck(command.issuerUserId !== command.payload[0], 'LAB_AUTHORITY_DENIED');
  if (command.action !== 'revoke_lab_reader') labCheck((command.payload[5] as number) <= d.createdAt && d.createdAt < (command.payload[6] as number) && (command.payload[6] as number) <= work.root.expiresAt);
  const branches = command.action === 'map_lab' ? command.payload[9] as string[] : command.action === 'grant_lab_reader' ? [command.payload[4] as string] : [(revokeGrant?.payload as Data)?.branchId as string];
  checkLabScope(command, work.root, branches); evidence(work, command);
  labCheck(labSame(d, derive(command, d.createdAt, revokeGrant))); return { decision: d, command };
}
async function priorGrant(work: Work, grantId: string, organizationId: string): Promise<{ decision: Data; command: LabCommand }> {
  const raw = one(await rows(work, work.snapshot.models.decision, { _id: { $eq: grantId }, organizationId: { $eq: organizationId }, decisionKind: { $eq: 'membership_granted' } }));
  const result = await history(work, raw, 'membership_granted'); labCheck(result.decision._id === grantId && result.decision.organizationId === organizationId); return result;
}
async function authenticateRevoked(work: Work, m: Data, org: Data): Promise<void> {
  const r = m.revision as number, grant = (m.grants as Data[])[0]; labCheck(r >= 2);
  const d = one(await rows(work, work.snapshot.models.decision, { organizationId: { $eq: m.organizationId }, decisionKind: { $eq: 'lab_membership_revoked' }, 'payload.membershipId': { $eq: m._id }, 'payload.membershipRevision': { $eq: r } }));
  const g = await priorGrant(work, grant.grantDecisionId as string, m.organizationId as string); const revoked = await history(work, d, 'lab_membership_revoked', g.decision);
  const dp = revoked.decision.payload as Data, gp = g.decision.payload as Data;
  labCheck(d.organizationId === m.organizationId && dp.organizationId === m.organizationId && (org.branches as Data[]).some(b => b.branchId === grant.branchId) && dp.actorId === m.actorId && dp.membershipId === m._id && dp.membershipRevision === r && dp.previousMembershipRevision === r - 1 && dp.previousGrantDecisionId === grant.grantDecisionId && gp.actorId === m.actorId && gp.membershipId === m._id && gp.membershipRevision === r - 1 && gp.validFrom === m.validFrom && gp.expiresAt === m.expiresAt && labSame(gp.grants, m.grants));
  labCheck((m.createdAt as number) <= (g.decision.createdAt as number) && (g.decision.createdAt as number) <= (d.createdAt as number) && m.updatedAt === d.createdAt && d.createdAt === d.updatedAt);
  labCheck((g.command.payload[3] as number) + 1 < (dp.operationalFence as number) && (dp.operationalFence as number) <= (org.operationalFence as number) && g.decision._id !== d._id && g.decision.operationId !== d.operationId);
}
async function business(work: Work, c: LabCommand): Promise<{ org: Data; lab: Data }> {
  const org = labShape(one(await rows(work, work.snapshot.models.organization, { _id: { $eq: c.organizationId } })), [...base, 'kind', 'sourceBusinessId', 'state', 'sourceFingerprint', 'mappingDecisionId', 'branches', 'operationalFence']); version(org, work.now);
  labCheck(org._id === c.organizationId && org.kind === 'lab' && org.revision === 1 && labId(org.sourceBusinessId) && org.sourceBusinessId !== org._id && labDigest(org.sourceFingerprint) && labId(org.mappingDecisionId) && labRevision(org.operationalFence) && ['active', 'suspended', 'revoked'].includes(org.state as string));
  const lab = labShape(one(await rows(work, work.snapshot.lab, { _id: { $eq: org.sourceBusinessId } })), [...base, 'organizationId', 'legalName', 'registrationReference', 'state', 'verificationValidFrom', 'verificationExpiresAt', 'verificationEvidence']); version(lab, work.now);
  labCheck(lab._id === org.sourceBusinessId && lab.revision === 1 && lab.organizationId === org._id && ['active', 'suspended', 'revoked'].includes(lab.state as string));
  const mapped = await history(work, one(await rows(work, work.snapshot.models.decision, { _id: { $eq: org.mappingDecisionId }, organizationId: { $eq: org._id }, decisionKind: { $eq: 'business_mapped' } })), 'business_mapped');
  const mp = mapped.decision.payload as Data, p = mapped.command.payload;
  labCheck(mapped.decision._id === org.mappingDecisionId && mapped.decision.organizationId === org._id && mp.organizationId === org._id && mp.organizationRevision === org.revision && mp.kind === 'lab' && mp.sourceBusinessId === lab._id && mp.sourceFingerprint === org.sourceFingerprint && labSame(mp.branches, org.branches) && org.createdAt === mapped.decision.createdAt && lab.createdAt === mapped.decision.createdAt);
  labCheck(lab.legalName === p[3] && lab.registrationReference === p[4] && lab.verificationValidFrom === p[5] && lab.verificationExpiresAt === p[6] && labSame(lab.verificationEvidence, labEvidence(mapped.command)));
  if (c.action === 'grant_lab_reader') {
    labCheck(org.state === 'active' && lab.state === 'active' && (lab.verificationValidFrom as number) <= work.now && work.now < (lab.verificationExpiresAt as number), 'LAB_AUTHORITY_DENIED');
    labCheck((org.branches as Data[]).some(b => b.branchId === c.payload[4] && b.state === 'active'), 'LAB_AUTHORITY_DENIED');
  }
  return { org, lab };
}
async function insert(work: Work, model: Model<Record<string, unknown>>, doc: Data): Promise<void> {
  guard(work); const result = await model.collection.insertOne(toDatabase(doc) as Record<string, unknown>, { session: work.session });
  labCheck(result.acknowledged && (result.insertedId as unknown) === doc._id); guard(work);
}
async function replace(work: Work, model: Model<Record<string, unknown>>, before: Data, patch: Data, fence = false): Promise<void> {
  guard(work);
  // $$ROOT equality compares the COMPLETE snapshot (including array shape and all fields), not array-matching query equality.
  const filter = { _id: { $eq: before._id }, $expr: { $eq: ['$$ROOT', { $literal: toDatabase(before) }] } };
  const result = await model.collection.updateOne(filter, { $set: toDatabase(patch) as Record<string, unknown>, ...(fence ? { $inc: { operationalFence: 1 } } : {}) }, { session: work.session, maxTimeMS: 2000 });
  labCheck(result.acknowledged && result.matchedCount === 1 && result.modifiedCount === 1, 'LAB_AUTHORITY_CONFLICT'); guard(work);
}
function receipt(c: LabCommand, replayed: boolean): LabAuthorityReceipt {
  return Object.freeze({ status: 'COMMITTED', operationId: c.operationId, decisionId: c.decisionId, action: c.action, organizationId: c.organizationId,
    recordId: c.payload[c.action === 'map_lab' ? 0 : 1] as string, recordRevision: c.action === 'map_lab' ? 1 : c.payload[2] === 0 ? 1 : labNext(c.payload[2] as number),
    operationalFence: c.action === 'map_lab' ? 1 : labNext(c.payload[3] as number), commandSha256: c.commandSha256, replayed });
}
async function apply(work: Work, c: LabCommand): Promise<LabAuthorityReceipt> {
  // Verify the submitted bytes even for replay; expired exact committed replay is checked at its historical callback time below.
  checkLabSignature(c, work.root, c.submittedAt, true); await requireLabIssuer(work.snapshot, c.issuerUserId, work.session);
  const replay = await rows(work, work.snapshot.models.decision, { organizationId: { $eq: c.organizationId }, operationId: { $eq: c.operationId } });
  if (replay.length) {
    labCheck(replay.length === 1); const proof = labShape(replay[0].issuerProof, ['schema', 'keyId', 'commandJson', 'commandSha256', 'signatureBase64']);
    labCheck(proof.commandSha256 === c.commandSha256 && proof.commandJson === c.commandJson, 'LAB_AUTHORITY_CONFLICT');
    let oldGrant: Data | undefined;
    if (c.action === 'revoke_lab_reader') { const payload = labShape(replay[0].payload, ['organizationId', 'actorId', 'membershipId', 'membershipRevision', 'previousMembershipRevision', 'previousGrantDecisionId', 'branchId', 'capability', 'operationalFence', 'reasonCode']); labCheck(labId(payload.previousGrantDecisionId)); oldGrant = (await priorGrant(work, payload.previousGrantDecisionId, c.organizationId)).decision; }
    await history(work, replay[0], c.action === 'map_lab' ? 'business_mapped' : c.action === 'grant_lab_reader' ? 'membership_granted' : 'lab_membership_revoked', oldGrant);
    guard(work); return receipt(c, true);
  }
  checkLabSignature(c, work.root, work.now); evidence(work, c);
  if (c.action !== 'map_lab') labCheck(c.issuerUserId !== c.payload[0], 'LAB_AUTHORITY_DENIED');
  const p = c.payload;
  if (c.action === 'map_lab') {
    checkLabScope(c, work.root, p[9] as string[]); labCheck((p[5] as number) <= work.now && work.now < (p[6] as number) && (p[6] as number) <= work.root.expiresAt, 'LAB_AUTHORITY_DENIED');
    labCheck((await rows(work, work.snapshot.lab, { _id: { $eq: p[0] } })).length === 0 && (await rows(work, work.snapshot.models.organization, { _id: { $eq: c.organizationId } })).length === 0, 'LAB_AUTHORITY_CONFLICT');
    const decision = derive(c, work.now), payload = decision.payload as Data;
    await insert(work, work.snapshot.lab, { _id: p[0], schemaVersion: 1, revision: 1, organizationId: c.organizationId, legalName: p[3], registrationReference: p[4], state: 'active', verificationValidFrom: p[5], verificationExpiresAt: p[6], verificationEvidence: labEvidence(c), createdAt: work.now, updatedAt: work.now });
    await insert(work, work.snapshot.models.organization, { _id: c.organizationId, schemaVersion: 1, revision: 1, kind: 'lab', sourceBusinessId: p[0], state: 'active', sourceFingerprint: payload.sourceFingerprint, mappingDecisionId: c.decisionId, branches: payload.branches, operationalFence: 1, createdAt: work.now, updatedAt: work.now });
    await insert(work, work.snapshot.models.decision, decision);
  } else {
    const { org, lab } = await business(work, c); labCheck(org.operationalFence === p[3], 'LAB_AUTHORITY_CONFLICT'); labNext(org.operationalFence as number);
    const found = await rows(work, work.snapshot.models.membership, { organizationId: { $eq: c.organizationId }, actorId: { $eq: p[0] } }); labCheck(found.length <= 1); let m = found.length ? member(found[0], work.now) : undefined;
    if (m) labCheck(m.organizationId === c.organizationId && m.actorId === p[0]);
    if (m) labCheck(m._id === p[1] && m.revision === p[2], 'LAB_AUTHORITY_CONFLICT'); else labCheck(c.action === 'grant_lab_reader' && p[2] === 0, 'LAB_AUTHORITY_CONFLICT');
    let decision: Data;
    if (c.action === 'grant_lab_reader') {
      checkLabScope(c, work.root, [p[4] as string]); labCheck((p[5] as number) <= work.now && work.now < (p[6] as number) && (p[6] as number) <= Math.min(lab.verificationExpiresAt as number, work.root.expiresAt), 'LAB_AUTHORITY_DENIED');
      await requireLabIssuer(work.snapshot, p[0] as string, work.session);
      if (m) { labCheck(m.state === 'revoked', 'LAB_AUTHORITY_CONFLICT'); await authenticateRevoked(work, m, org); }
      decision = derive(c, work.now); const payload = decision.payload as Data;
      const next = { state: 'active', revision: payload.membershipRevision, validFrom: p[5], expiresAt: p[6], grants: payload.grants, updatedAt: work.now };
      if (m) await replace(work, work.snapshot.models.membership, m, next);
      else await insert(work, work.snapshot.models.membership, { _id: p[1], schemaVersion: 1, organizationId: c.organizationId, actorId: p[0], ...next, createdAt: work.now });
    } else {
      labCheck(m && ['active', 'suspended'].includes(m.state as string), 'LAB_AUTHORITY_CONFLICT');
      const grant = (m.grants as Data[])[0]; labCheck((org.branches as Data[]).some(b => b.branchId === grant.branchId)); checkLabScope(c, work.root, [grant.branchId as string]);
      const prior = await priorGrant(work, grant.grantDecisionId as string, c.organizationId), gp = prior.decision.payload as Data;
      labCheck(gp.actorId === m.actorId && gp.membershipId === m._id && gp.membershipRevision === m.revision && gp.validFrom === m.validFrom && gp.expiresAt === m.expiresAt && labSame(gp.grants, m.grants));
      decision = derive(c, work.now, prior.decision); await replace(work, work.snapshot.models.membership, m, { state: 'revoked', revision: labNext(m.revision as number), updatedAt: work.now });
    }
    await replace(work, work.snapshot.models.organization, org, { updatedAt: work.now }, true);
    await insert(work, work.snapshot.models.decision, decision);
  }
  guard(work); return receipt(c, false);
}
/** No startup/HTTP entry. The only argument is signed canonical text, never a caller connection or ready flag. */
export async function provisionLabAuthority(commandJson: string): Promise<LabAuthorityReceipt> {
  const command = parseLabCommand(commandJson);
  let session: ClientSession | undefined, result: LabAuthorityReceipt | undefined, primary: unknown; let acknowledged = false;
  try {
    session = startLabAuthoritySession(); const ownedSession = session;
    await ownedSession.withTransaction(async () => {
      const snapshot = await observeLabAuthorityReadiness(), root = readLabRoot(), files = new Map<string, ProtectedRead>();
      const work: Work = { snapshot, session: ownedSession, root, now: Date.now(), files }; let first: unknown;
      try { labCheck(labTime(work.now)); result = await apply(work, command); }
      catch (error) { first = error; throw error; }
      finally {
        let cleanup: unknown;
        for (const file of [...files.values(), root.file]) { try { file.close(); } catch (error) { cleanup ??= error; } }
        if (!first && cleanup) throw new LabAuthorityError('LAB_AUTHORITY_UNAVAILABLE');
      }
    }, { readConcern: { level: 'snapshot' }, writeConcern: { w: 'majority', wtimeout: 2000 }, maxCommitTimeMS: 2000 });
    acknowledged = true; labCheck(result); return result;
  } catch (error) {
    if (error instanceof LabAuthorityError) { primary = error; throw error; }
    const code = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error, 'code') : undefined;
    if (code && 'value' in code && code.value === 11000) { primary = new LabAuthorityError('LAB_AUTHORITY_CONFLICT'); throw primary; }
    // Driver/transport commit failures are not represented as a known rollback or automatically retried by this facade.
    primary = new LabAuthorityError('LAB_AUTHORITY_UNAVAILABLE', 'UNKNOWN'); throw primary;
  } finally {
    try { if (session) await session.endSession(); }
    catch { if (!primary) throw new LabAuthorityError('LAB_AUTHORITY_UNAVAILABLE', acknowledged ? 'UNKNOWN' : undefined); }
  }
}
