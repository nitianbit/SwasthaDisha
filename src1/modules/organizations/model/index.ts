import { Connection, Model, Schema } from 'mongoose';
import { AuthorityError } from '../types';

// Approved authority adapters and the protected lab writer share this factory; import registers no model.
const canonicalId = { type: String, required: true, match: /^[0-9a-f]{24}$/, immutable: true };
const digest = { type: String, required: true, match: /^[0-9a-f]{64}$/ };
const positive = { type: Number, required: true, min: 1, validate: Number.isSafeInteger };
const date = { type: Date, required: true };
const capability = { type: String, required: true, enum: ['pharmacy.prescription.review', 'lab.report.release', 'lab.worklist.read'] };
const state = { type: String, required: true, enum: ['active', 'suspended', 'revoked'] };
const embedded = { _id: false, strict: 'throw' as const };
const options = { timestamps: true, strict: 'throw' as const, versionKey: false as const, autoIndex: false, autoCreate: false };
const bounded = (values: unknown[]) => Array.isArray(values) && values.length >= 1 && values.length <= 100;
const base = { _id: canonicalId, schemaVersion: { type: Number, required: true, enum: [1], immutable: true }, revision: positive };

export interface AuthorityModels {
  readonly organization: Model<Record<string, unknown>>;
  readonly membership: Model<Record<string, unknown>>;
  readonly eligibility: Model<Record<string, unknown>>;
  readonly decision: Model<Record<string, unknown>>;
}
const registered = new WeakMap<Connection, AuthorityModels>();
export function createAuthorityModels(connection: Connection): AuthorityModels {
  const previous = registered.get(connection);
  if (previous) return previous;
  const names = ['BusinessAuthorityOrganization', 'BusinessStaffMembership', 'BusinessProfessionalEligibility', 'BusinessAuthorityDecision'];
  if (names.some(name => connection.models[name])) throw new AuthorityError('AUTHORITY_NOT_READY');
  const branch = new Schema({ branchId: canonicalId, state, revision: positive }, embedded);
  const grant = new Schema({ branchId: canonicalId, capability, grantDecisionId: canonicalId }, embedded);
  const evidence = new Schema({ evidenceVersionId: canonicalId, evidenceSha256: digest }, embedded);
  const organization = new Schema<Record<string, unknown>>({
    ...base, kind: { type: String, required: true, enum: ['pharmacy', 'lab'] },
    sourceBusinessId: canonicalId, state, sourceFingerprint: digest, mappingDecisionId: canonicalId,
    branches: { type: [branch], required: true, validate: bounded },
    operationalFence: { type: Number, min: 1,
      required: function (this: { kind?: string }) { return this.kind === 'lab'; },
      validate: function (this: { kind?: string }, value: unknown) { return this.kind === 'lab' ? typeof value === 'number' && Number.isSafeInteger(value) && value > 0 : value === undefined; } },
  }, options);
  organization.index({ kind: 1, sourceBusinessId: 1 }, { unique: true });
  const membership = new Schema<Record<string, unknown>>({
    ...base, organizationId: canonicalId, actorId: canonicalId, state, validFrom: date, expiresAt: date,
    grants: { type: [grant], required: true, validate: bounded },
  }, options);
  membership.index({ organizationId: 1, actorId: 1 }, { unique: true });
  const eligibility = new Schema<Record<string, unknown>>({
    ...base, organizationId: canonicalId, actorId: canonicalId,
    profession: { type: String, required: true, enum: ['pharmacist', 'lab_signatory'] },
    state: { type: String, required: true, enum: ['verified', 'suspended', 'revoked'] },
    validFrom: date, expiresAt: date, verificationDecisionId: canonicalId,
    evidenceVersionId: canonicalId, evidenceSha256: digest,
  }, options);
  eligibility.index({ organizationId: 1, actorId: 1, profession: 1 }, { unique: true });
  // Explicit optional union fields, with exact decision-kind validation in the sole rule evaluator.
  const payload = new Schema({
    organizationId: canonicalId,
    organizationRevision: { type: Number, min: 1, validate: Number.isSafeInteger },
    kind: { type: String, enum: ['pharmacy', 'lab'] },
    sourceBusinessId: { type: String, match: /^[0-9a-f]{24}$/ },
    sourceFingerprint: { type: String, match: /^[0-9a-f]{64}$/ },
    branches: { type: [branch], default: undefined, validate: bounded },
    actorId: { type: String, match: /^[0-9a-f]{24}$/ },
    membershipId: { type: String, match: /^[0-9a-f]{24}$/ },
    membershipRevision: { type: Number, min: 1, validate: Number.isSafeInteger },
    eligibilityId: { type: String, match: /^[0-9a-f]{24}$/ },
    eligibilityRevision: { type: Number, min: 1, validate: Number.isSafeInteger },
    validFrom: { type: Date }, expiresAt: { type: Date },
    // Grant entries have an optional decision ID for the professional scope payload.
    grants: { type: [new Schema({ branchId: canonicalId, capability, grantDecisionId: { type: String, match: /^[0-9a-f]{24}$/ } }, embedded)], default: undefined, validate: bounded },
    branchId: { type: String, match: /^[0-9a-f]{24}$/ },
    capability: { type: String, enum: ['pharmacy.prescription.review', 'lab.report.release', 'lab.worklist.read'] },
    profession: { type: String, enum: ['pharmacist', 'lab_signatory'] },
    evidenceVersionId: { type: String, match: /^[0-9a-f]{24}$/ },
    evidenceSha256: { type: String, match: /^[0-9a-f]{64}$/ },
    previousMembershipRevision: { type: Number, min: 1, validate: Number.isSafeInteger },
    previousGrantDecisionId: { type: String, match: /^[0-9a-f]{24}$/ },
    operationalFence: { type: Number, min: 1, validate: Number.isSafeInteger },
    reasonCode: { type: String, enum: ['access_withdrawn'] },
  }, embedded);
  // No mutation API is exposed. Immutability is defense in depth, not grant authenticity.
  const decision = new Schema<Record<string, unknown>>({
    _id: canonicalId, schemaVersion: { type: Number, required: true, enum: [1], immutable: true },
    organizationId: canonicalId, operationId: canonicalId,
    decisionKind: { type: String, required: true, enum: ['business_mapped', 'membership_granted', 'professional_verified', 'lab_membership_revoked'], immutable: true },
    subjectActorId: { type: String, match: /^[0-9a-f]{24}$/, immutable: true },
    decidingActorId: canonicalId, decidedAt: { ...date, immutable: true },
    authorityGeneration: { ...digest, immutable: true }, payloadSha256: { ...digest, immutable: true },
    issuerProof: { type: new Schema({
      schema: { type: String, required: true, enum: ['SD-LAB-AUTHORITY-ISSUER-PROOF-1'] },
      keyId: digest, commandJson: { type: String, required: true, maxlength: 16384 },
      commandSha256: digest, signatureBase64: { type: String, required: true, maxlength: 88 },
    }, embedded), default: undefined, immutable: true },
    payload: { type: payload, required: true, immutable: true },
    evidence: { type: [evidence], required: true, validate: bounded, immutable: true },
  }, options);
  decision.index({ organizationId: 1, operationId: 1 }, { unique: true });
  const models = Object.freeze({
    organization: connection.model(names[0], organization, 'business_authority_organizations'),
    membership: connection.model(names[1], membership, 'business_staff_memberships'),
    eligibility: connection.model(names[2], eligibility, 'business_professional_eligibility'),
    decision: connection.model(names[3], decision, 'business_authority_decisions'),
  });
  registered.set(connection, models);
  return models;
}
