import { createHash } from 'crypto';
import {
  AuthorityDecision, AuthorityError, AuthorityFacts, AuthorityLookup,
  AuthorityRequest, AuthenticatedPerson, Branch, BusinessScope, Capability, Eligibility,
  EvidenceReference, GrantPayload, MappingPayload, Membership, Organization,
  StaffGrant, VerificationPayload,
} from './types';

type Data = Record<string, unknown>;
const id = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{24}$/.test(v);
const digest = (v: unknown): v is string => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;
const time = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 8640000000000000;
const capability = (v: unknown): v is Capability => v === 'pharmacy.prescription.review' || v === 'lab.report.release';
const state = (v: unknown) => v === 'active' || v === 'suspended' || v === 'revoked';
const deny = (): never => { throw new AuthorityError('AUTHORITY_DENIED'); };
const check = (ok: unknown): void => { if (!ok) deny(); };
const data = (v: unknown): Data => {
  if (!v || typeof v !== 'object' || Array.isArray(v) || ![Object.prototype, null].includes(Object.getPrototypeOf(v))) return deny();
  check(Reflect.ownKeys(v).every(k => typeof k === 'string' && Object.getOwnPropertyDescriptor(v, k)?.enumerable === true && 'value' in Object.getOwnPropertyDescriptor(v, k)!));
  return v as Data;
};
const shape = (v: unknown, keys: readonly string[]): Data => {
  const d = data(v);
  check(Object.keys(d).length === keys.length && keys.every(k => Object.prototype.hasOwnProperty.call(d, k)));
  return d;
};
const list = (v: unknown): readonly unknown[] => {
  if (!Array.isArray(v) || v.length < 1 || v.length > 100) return deny();
  return v;
};
const unique = (values: readonly string[]) => check(new Set(values).size === values.length);
const professionFor = (c: Capability) => c === 'pharmacy.prescription.review' ? 'pharmacist' : 'lab_signatory';
const capabilityFor = (kind: Organization['kind']) => kind === 'pharmacy' ? 'pharmacy.prescription.review' : 'lab.report.release';
const versionKeys = ['_id', 'schemaVersion', 'revision', 'createdAt', 'updatedAt'];
const version = (d: Data, now: number) => {
  check(id(d._id) && d.schemaVersion === 1 && integer(d.revision));
  check(time(d.createdAt) && time(d.updatedAt) && d.createdAt <= d.updatedAt && d.updatedAt <= now);
};
const interval = (d: Data, now: number) => check(time(d.validFrom) && time(d.expiresAt) && d.validFrom <= now && now < d.expiresAt);
const branches = (v: unknown): readonly Branch[] => {
  const entries = list(v).map(raw => {
    const d = shape(raw, ['branchId', 'state', 'revision']);
    check(id(d.branchId) && state(d.state) && integer(d.revision));
    return d as unknown as Branch;
  });
  unique(entries.map(x => x.branchId));
  return entries;
};
const grants = (v: unknown, org: Organization, includeDecision: boolean): readonly Data[] => {
  const entries = list(v).map(raw => {
    const d = shape(raw, includeDecision ? ['branchId', 'capability', 'grantDecisionId'] : ['branchId', 'capability']);
    check(id(d.branchId) && capability(d.capability) && d.capability === capabilityFor(org.kind));
    check(org.branches.some(b => b.branchId === d.branchId));
    if (includeDecision) check(id(d.grantDecisionId));
    return d;
  });
  unique(entries.map(x => `${x.branchId}:${x.capability}`));
  return entries;
};
const evidence = (v: unknown): readonly EvidenceReference[] => {
  const entries = list(v).map(raw => {
    const d = shape(raw, ['evidenceVersionId', 'evidenceSha256']);
    check(id(d.evidenceVersionId) && digest(d.evidenceSha256));
    return d as unknown as EvidenceReference;
  });
  unique(entries.map(x => x.evidenceVersionId));
  return entries;
};
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const sortedBranches = (v: readonly Branch[]) => [...v].sort((a, b) => compare(a.branchId, b.branchId)).map(x => [x.branchId, x.state, x.revision]);
const sortedGrants = (v: readonly Readonly<{ branchId: string; capability: Capability; grantDecisionId?: string }>[]) => [...v]
  .sort((a, b) => compare(`${a.branchId}:${a.capability}`, `${b.branchId}:${b.capability}`))
  .map(x => x.grantDecisionId === undefined ? [x.branchId, x.capability] : [x.branchId, x.capability, x.grantDecisionId]);
const sha256 = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

export function validateContext(principal: unknown, request: unknown): { person: AuthenticatedPerson; request: AuthorityRequest } {
  try {
    const p = shape(principal, ['actorId', 'userType', 'purpose']);
    const r = shape(request, ['organizationId', 'branchId', 'capability']);
    check(id(p.actorId) && p.userType === 'user' && p.purpose === 'staff');
    check(id(r.organizationId) && id(r.branchId) && capability(r.capability));
    return {
      person: Object.freeze({ actorId: p.actorId as string, userType: 'user', purpose: 'staff' }),
      request: Object.freeze({ organizationId: r.organizationId as string, branchId: r.branchId as string, capability: r.capability as Capability }),
    };
  } catch (error) {
    if (error instanceof AuthorityError) throw new AuthorityError('INVALID_CONTEXT');
    throw error;
  }
}
export function validateTime(now: number): void { check(time(now)); }
export function validateReadiness(value: unknown): string {
  try {
    const r = shape(value, ['ready', 'authorityGeneration', 'indexesVerified', 'provenanceVerified', 'snapshotTransactionsVerified']);
    check(r.ready === true && digest(r.authorityGeneration) && r.indexesVerified === true && r.provenanceVerified === true && r.snapshotTransactionsVerified === true);
    return r.authorityGeneration as string;
  } catch (error) {
    if (error instanceof AuthorityError) throw new AuthorityError('AUTHORITY_NOT_READY');
    throw error;
  }
}
export function validateLookup(value: AuthorityLookup, now: number): void {
  shape(value, ['actorId', 'organizationId', 'branchId', 'capability', 'authorityGeneration']);
  check(id(value.actorId) && id(value.organizationId) && id(value.branchId) && capability(value.capability) && digest(value.authorityGeneration));
  validateTime(now);
}
export function validateUser(value: unknown, lookup: AuthorityLookup): void {
  const u = shape(value, ['_id', 'userType', 'isActive']);
  check(u._id === lookup.actorId && u.userType === 'user' && u.isActive === true);
}
export function validateOrganization(value: unknown, lookup: AuthorityLookup, now: number): Organization {
  const d = shape(value, [...versionKeys, 'kind', 'sourceBusinessId', 'state', 'sourceFingerprint', 'mappingDecisionId', 'branches']);
  version(d, now);
  check(d._id === lookup.organizationId && (d.kind === 'pharmacy' || d.kind === 'lab') && id(d.sourceBusinessId));
  check(d.state === 'active' && digest(d.sourceFingerprint) && id(d.mappingDecisionId));
  const bs = branches(d.branches);
  check(bs.filter(b => b.branchId === lookup.branchId && b.state === 'active').length === 1);
  check(lookup.capability === capabilityFor(d.kind as Organization['kind']));
  return d as unknown as Organization;
}
export function pharmacyFingerprint(value: unknown): string {
  const p = shape(value, ['_id', 'isActive', 'isVerified', 'drugLicenseNumber', 'drugLicenseDocumentUrl']);
  check(id(p._id) && p.isActive === true && p.isVerified === true);
  check(typeof p.drugLicenseNumber === 'string' && p.drugLicenseNumber.length > 0 && p.drugLicenseNumber.length <= 512);
  check(typeof p.drugLicenseDocumentUrl === 'string' && p.drugLicenseDocumentUrl.length > 0 && p.drugLicenseDocumentUrl.length <= 2048);
  return sha256(JSON.stringify(['business-source', 1, 'pharmacy', ['sourceBusinessId', p._id], ['drugLicenseNumber', p.drugLicenseNumber], ['drugLicenseDocumentUrl', p.drugLicenseDocumentUrl]]));
}

// Ordered schema-versioned arrays, not object insertion order. Metadata and evidence are bound too.
export function serializeDecision(decision: AuthorityDecision): string {
  const common: unknown[] = ['business-authority-decision', 1, decision.decisionKind,
    ['_id', decision._id], ['organizationId', decision.organizationId], ['operationId', decision.operationId],
    ['decidingActorId', decision.decidingActorId], ['decidedAt', decision.decidedAt], ['authorityGeneration', decision.authorityGeneration],
    ['evidence', [...decision.evidence].sort((a, b) => compare(a.evidenceVersionId, b.evidenceVersionId)).map(e => [e.evidenceVersionId, e.evidenceSha256])]];
  if (decision.decisionKind === 'business_mapped') {
    const p = decision.payload;
    common.push(['payload', ['organizationId', p.organizationId], ['organizationRevision', p.organizationRevision], ['kind', p.kind], ['sourceBusinessId', p.sourceBusinessId], ['sourceFingerprint', p.sourceFingerprint], ['branches', sortedBranches(p.branches)]]);
  } else if (decision.decisionKind === 'membership_granted') {
    const p = decision.payload;
    common.push(['subjectActorId', decision.subjectActorId], ['payload', ['organizationId', p.organizationId], ['actorId', p.actorId], ['membershipId', p.membershipId], ['membershipRevision', p.membershipRevision], ['validFrom', p.validFrom], ['expiresAt', p.expiresAt], ['grants', sortedGrants(p.grants)], ['branchId', p.branchId], ['capability', p.capability]]);
  } else if (decision.decisionKind === 'lab_membership_revoked') {
    const p = decision.payload;
    common.push(['subjectActorId', decision.subjectActorId], ['payload', ['organizationId', p.organizationId], ['actorId', p.actorId], ['membershipId', p.membershipId], ['membershipRevision', p.membershipRevision], ['previousMembershipRevision', p.previousMembershipRevision], ['previousGrantDecisionId', p.previousGrantDecisionId], ['branchId', p.branchId], ['capability', p.capability], ['operationalFence', p.operationalFence], ['reasonCode', p.reasonCode]]);
  } else {
    const p = decision.payload;
    common.push(['subjectActorId', decision.subjectActorId], ['payload', ['organizationId', p.organizationId], ['actorId', p.actorId], ['eligibilityId', p.eligibilityId], ['eligibilityRevision', p.eligibilityRevision], ['profession', p.profession], ['validFrom', p.validFrom], ['expiresAt', p.expiresAt], ['evidenceVersionId', p.evidenceVersionId], ['evidenceSha256', p.evidenceSha256], ['grants', sortedGrants(p.grants)]]);
  }
  return JSON.stringify(common);
}
export function decisionDigest(decision: AuthorityDecision): string { return sha256(serializeDecision(decision)); }
const one = <T>(v: readonly unknown[]): T => { check(Array.isArray(v) && v.length === 1); return v[0] as T; };
export const validateMembership = (v: unknown, lookup: AuthorityLookup, org: Organization, now: number): Membership => {
  const d = shape(v, [...versionKeys, 'organizationId', 'actorId', 'state', 'validFrom', 'expiresAt', 'grants']);
  version(d, now); interval(d, now);
  check(d.organizationId === lookup.organizationId && d.actorId === lookup.actorId && d.state === 'active');
  grants(d.grants, org, true);
  return d as unknown as Membership;
};
export const validateEligibility = (v: unknown, lookup: AuthorityLookup, now: number): Eligibility => {
  const d = shape(v, [...versionKeys, 'organizationId', 'actorId', 'profession', 'state', 'validFrom', 'expiresAt', 'verificationDecisionId', 'evidenceVersionId', 'evidenceSha256']);
  version(d, now); interval(d, now);
  check(d.organizationId === lookup.organizationId && d.actorId === lookup.actorId && d.state === 'verified' && d.profession === professionFor(lookup.capability));
  check(id(d.verificationDecisionId) && id(d.evidenceVersionId) && digest(d.evidenceSha256));
  return d as unknown as Eligibility;
};
const currentDecision = (v: unknown, kind: AuthorityDecision['decisionKind'], lookup: AuthorityLookup, org: Organization, now: number): AuthorityDecision => {
  const keys = ['_id', 'schemaVersion', 'organizationId', 'operationId', 'decisionKind', 'decidingActorId', 'decidedAt', 'authorityGeneration', 'payloadSha256', 'payload', 'evidence', 'createdAt', 'updatedAt'];
  if (kind !== 'business_mapped') keys.push('subjectActorId');
  const d = shape(v, keys);
  check(id(d._id) && d.schemaVersion === 1 && d.organizationId === lookup.organizationId && id(d.operationId) && d.decisionKind === kind && id(d.decidingActorId));
  check(time(d.decidedAt) && d.decidedAt <= now && time(d.createdAt) && time(d.updatedAt) && d.createdAt <= d.updatedAt && d.updatedAt <= now);
  check(d.authorityGeneration === lookup.authorityGeneration && digest(d.payloadSha256));
  evidence(d.evidence);
  if (kind !== 'business_mapped') check(d.subjectActorId === lookup.actorId && d.decidingActorId !== d.subjectActorId);
  if (kind === 'business_mapped') {
    const p = shape(d.payload, ['organizationId', 'organizationRevision', 'kind', 'sourceBusinessId', 'sourceFingerprint', 'branches']);
    check(id(p.organizationId) && integer(p.organizationRevision) && (p.kind === 'pharmacy' || p.kind === 'lab') && id(p.sourceBusinessId) && digest(p.sourceFingerprint));
    branches(p.branches);
  } else if (kind === 'membership_granted') {
    const p = shape(d.payload, ['organizationId', 'actorId', 'membershipId', 'membershipRevision', 'validFrom', 'expiresAt', 'grants', 'branchId', 'capability']);
    check(id(p.organizationId) && id(p.actorId) && id(p.membershipId) && integer(p.membershipRevision));
    interval(p, now); grants(p.grants, org, true);
    check(id(p.branchId) && capability(p.capability));
  } else {
    const p = shape(d.payload, ['organizationId', 'actorId', 'eligibilityId', 'eligibilityRevision', 'profession', 'validFrom', 'expiresAt', 'evidenceVersionId', 'evidenceSha256', 'grants']);
    check(id(p.organizationId) && id(p.actorId) && id(p.eligibilityId) && integer(p.eligibilityRevision) && p.profession === professionFor(lookup.capability));
    interval(p, now); grants(p.grants, org, false);
    check(id(p.evidenceVersionId) && digest(p.evidenceSha256));
  }
  const decision = d as unknown as AuthorityDecision;
  check(decisionDigest(decision) === decision.payloadSha256);
  return decision;
};

export function evaluateAuthority(lookup: AuthorityLookup, facts: AuthorityFacts, now: number): BusinessScope {
  validateLookup(lookup, now);
  shape(facts, ['user', 'organization', 'pharmacy', 'memberships', 'eligibility', 'mappingDecisions', 'grantDecisions', 'verificationDecisions']);
  validateUser(facts.user, lookup);
  const org = validateOrganization(facts.organization, lookup, now);
  if (org.kind !== 'pharmacy') throw new AuthorityError('AUTHORITY_MAPPING_UNAVAILABLE');
  const pharmacy = data(facts.pharmacy);
  check(pharmacy._id === org.sourceBusinessId && pharmacyFingerprint(pharmacy) === org.sourceFingerprint);
  const member = validateMembership(one(facts.memberships), lookup, org, now);
  const eligible = validateEligibility(one(facts.eligibility), lookup, now);
  const grant = one<StaffGrant>(member.grants.filter(g => g.branchId === lookup.branchId && g.capability === lookup.capability));
  const mapping = currentDecision(one(facts.mappingDecisions), 'business_mapped', lookup, org, now);
  const granted = currentDecision(one(facts.grantDecisions), 'membership_granted', lookup, org, now);
  const verified = currentDecision(one(facts.verificationDecisions), 'professional_verified', lookup, org, now);
  unique([mapping._id, granted._id, verified._id]);
  unique([mapping.operationId, granted.operationId, verified.operationId]);
  check(mapping._id === org.mappingDecisionId && granted._id === grant.grantDecisionId && verified._id === eligible.verificationDecisionId);
  const mp = mapping.payload as MappingPayload;
  check(mp.organizationId === org._id && mp.organizationRevision === org.revision && mp.kind === org.kind && mp.sourceBusinessId === org.sourceBusinessId && mp.sourceFingerprint === org.sourceFingerprint);
  check(JSON.stringify(sortedBranches(mp.branches)) === JSON.stringify(sortedBranches(org.branches)));
  const gp = granted.payload as GrantPayload;
  check(gp.organizationId === org._id && gp.actorId === lookup.actorId && gp.membershipId === member._id && gp.membershipRevision === member.revision && gp.validFrom === member.validFrom && gp.expiresAt === member.expiresAt && gp.branchId === lookup.branchId && gp.capability === lookup.capability);
  check(JSON.stringify(sortedGrants(gp.grants)) === JSON.stringify(sortedGrants(member.grants)));
  const vp = verified.payload as VerificationPayload;
  check(vp.organizationId === org._id && vp.actorId === lookup.actorId && vp.eligibilityId === eligible._id && vp.eligibilityRevision === eligible.revision && vp.profession === eligible.profession && vp.validFrom === eligible.validFrom && vp.expiresAt === eligible.expiresAt && vp.evidenceVersionId === eligible.evidenceVersionId && vp.evidenceSha256 === eligible.evidenceSha256);
  check(vp.grants.filter(g => g.branchId === lookup.branchId && g.capability === lookup.capability).length === 1);
  check(verified.evidence.some(e => e.evidenceVersionId === eligible.evidenceVersionId && e.evidenceSha256 === eligible.evidenceSha256));
  return {
    ...lookup, purpose: 'staff', kind: 'pharmacy', sourceBusinessId: org.sourceBusinessId,
    organizationRevision: org.revision, branchRevision: org.branches.find(b => b.branchId === lookup.branchId)!.revision,
    membershipId: member._id, membershipRevision: member.revision, eligibilityId: eligible._id, eligibilityRevision: eligible.revision,
    mappingDecisionId: mapping._id, grantDecisionId: granted._id, verificationDecisionId: verified._id,
    evidenceVersionId: eligible.evidenceVersionId, evidenceSha256: eligible.evidenceSha256,
    checkedAt: now, expiresAt: Math.min(member.expiresAt, eligible.expiresAt),
  };
}
