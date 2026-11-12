import { ClientSession, Connection, Model, Types, mongo } from 'mongoose';
import { createAuthorityModels } from '../model';
import { AuthorityError, AuthorityFacts, AuthorityLookup, AuthorityReadiness, AuthorityReadPort } from '../types';
import { pharmacyFingerprint, validateEligibility, validateLookup, validateMembership, validateOrganization, validateReadiness, validateUser } from '../rules';

const version = { _id: 1, schemaVersion: 1, revision: 1, createdAt: 1, updatedAt: 1 };
const organizationProjection = { ...version, kind: 1, sourceBusinessId: 1, state: 1, sourceFingerprint: 1, mappingDecisionId: 1, branches: 1 };
const membershipProjection = { ...version, organizationId: 1, actorId: 1, state: 1, validFrom: 1, expiresAt: 1, grants: 1 };
const eligibilityProjection = { ...version, organizationId: 1, actorId: 1, profession: 1, state: 1, validFrom: 1, expiresAt: 1, verificationDecisionId: 1, evidenceVersionId: 1, evidenceSha256: 1 };
const decisionProjection = { _id: 1, schemaVersion: 1, organizationId: 1, operationId: 1, decisionKind: 1, subjectActorId: 1, decidingActorId: 1, decidedAt: 1, authorityGeneration: 1, payloadSha256: 1, payload: 1, evidence: 1, createdAt: 1, updatedAt: 1 };
const closed = async (): Promise<AuthorityReadiness> => Object.freeze({ ready: false });
const denied = (): never => { throw new AuthorityError('AUTHORITY_DENIED'); };
const single = (rows: readonly unknown[]): unknown => rows.length === 1 ? rows[0] : denied();

type ProjectionKind = 'legacyUser' | 'legacyPharmacy' | 'organization' | 'membership' | 'eligibility' | 'decision';
const timestampPath = (kind: ProjectionKind, path: string): boolean => {
  if (kind === 'legacyUser' || kind === 'legacyPharmacy') return false;
  if (path === 'createdAt' || path === 'updatedAt') return true;
  if ((kind === 'membership' || kind === 'eligibility') && (path === 'validFrom' || path === 'expiresAt')) return true;
  return kind === 'decision' && (path === 'decidedAt' || path === 'payload.validFrom' || path === 'payload.expiresAt');
};

// Closed projection paths only: never repair an authority ID/revision with BSON coercion.
function immutableProjection(value: unknown, kind: ProjectionKind, path = '', depth = 0): unknown {
  if (depth > 10) return denied();
  if (timestampPath(kind, path)) {
    if (!(value instanceof Date)) return denied();
    const epoch = value.getTime();
    if (!Number.isSafeInteger(epoch) || epoch < 0) return denied();
    return epoch;
  }
  if ((kind === 'legacyUser' || kind === 'legacyPharmacy') && path === '_id') {
    if (!(value instanceof Types.ObjectId)) return denied();
    return value.toHexString();
  }
  if (value instanceof Date || value instanceof Types.ObjectId) return denied();
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) {
    if (value.length > 100) return denied();
    return Object.freeze(value.map(v => immutableProjection(v, kind, `${path}[]`, depth + 1)));
  }
  if (!value || typeof value !== 'object' || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return denied();
  const entries = Object.entries(value);
  if (entries.length > 32) return denied();
  return Object.freeze(Object.fromEntries(entries.map(([k, v]) => [k, immutableProjection(v, kind, path ? `${path}.${k}` : k, depth + 1)])));
}

export class MongoBusinessAuthorityReadPort implements AuthorityReadPort {
  constructor(private readonly connection: Connection, private readonly readinessProvider: () => Promise<AuthorityReadiness> = closed) {}

  readiness(): Promise<AuthorityReadiness> { return this.readinessProvider(); }

  private snapshotSession(value: unknown): ClientSession {
    // Structural lookalikes never qualify. The instance must belong to this exact connection's driver/client.
    const DriverSession = mongo.ClientSession;
    if (typeof DriverSession !== 'function' || !(value instanceof DriverSession)) throw new AuthorityError('INVALID_TRANSACTION');
    const session = value as ClientSession;
    const internals = session as unknown as { client?: unknown; transaction?: { options?: { readConcern?: { level?: unknown } } } };
    if (internals.client !== this.connection.getClient() || !session.inTransaction() || internals.transaction?.options?.readConcern?.level !== 'snapshot') throw new AuthorityError('INVALID_TRANSACTION');
    return session;
  }

  private existingModel(name: 'User' | 'Pharmacy', collection: 'users' | 'pharmacies'): Model<unknown> {
    const result = this.connection.models[name];
    if (!result || result.db !== this.connection || result.collection.name !== collection) throw new AuthorityError('AUTHORITY_NOT_READY');
    return result as Model<unknown>;
  }

  async loadFacts(lookup: AuthorityLookup, transaction: unknown, now: number): Promise<AuthorityFacts> {
    validateLookup(lookup, now);
    const session = this.snapshotSession(transaction);
    const heldTransaction = (session as unknown as { transaction: unknown }).transaction;
    const acceptedGeneration = validateReadiness(await this.readiness());
    if (acceptedGeneration !== lookup.authorityGeneration) throw new AuthorityError('AUTHORITY_NOT_READY');
    const models = createAuthorityModels(this.connection);
    const read = async (model: Model<unknown>, filter: Record<string, unknown>, projection: Record<string, number>, kind: ProjectionKind): Promise<readonly unknown[]> => {
      this.snapshotSession(session);
      if ((session as unknown as { transaction: unknown }).transaction !== heldTransaction) throw new AuthorityError('INVALID_TRANSACTION');
      const rows = await model.find(filter).select(projection).session(session).limit(2).lean().exec();
      this.snapshotSession(session);
      if ((session as unknown as { transaction: unknown }).transaction !== heldTransaction) throw new AuthorityError('INVALID_TRANSACTION');
      if (!Array.isArray(rows) || rows.length > 2) return denied();
      return Object.freeze(rows.map(row => immutableProjection(row, kind)));
    };
    const user = single(await read(this.existingModel('User', 'users'), { _id: lookup.actorId, userType: 'user', isActive: true }, { _id: 1, userType: 1, isActive: 1 }, 'legacyUser'));
    validateUser(user, lookup);
    const organization = single(await read(models.organization, {
      _id: lookup.organizationId, state: 'active', branches: { $elemMatch: { branchId: lookup.branchId, state: 'active' } },
    }, organizationProjection, 'organization'));
    const org = validateOrganization(organization, lookup, now);
    if (org.kind !== 'pharmacy') throw new AuthorityError('AUTHORITY_MAPPING_UNAVAILABLE');
    const pharmacy = single(await read(this.existingModel('Pharmacy', 'pharmacies'), {
      _id: org.sourceBusinessId, isActive: true, isVerified: true, archivedAt: { $exists: false },
    }, { _id: 1, isActive: 1, isVerified: 1, archivedAt: 1, drugLicenseNumber: 1, drugLicenseDocumentUrl: 1 }, 'legacyPharmacy'));
    if (pharmacyFingerprint(pharmacy) !== org.sourceFingerprint) return denied();
    const memberships = await read(models.membership, {
      organizationId: lookup.organizationId, actorId: lookup.actorId, state: 'active', validFrom: { $lte: new Date(now) }, expiresAt: { $gt: new Date(now) },
      grants: { $elemMatch: { branchId: lookup.branchId, capability: lookup.capability } },
    }, membershipProjection, 'membership');
    const member = validateMembership(single(memberships), lookup, org, now);
    const selected = member.grants.filter(g => g.branchId === lookup.branchId && g.capability === lookup.capability);
    if (selected.length !== 1) return denied();
    const eligibility = await read(models.eligibility, {
      organizationId: lookup.organizationId, actorId: lookup.actorId, profession: 'pharmacist', state: 'verified',
      validFrom: { $lte: new Date(now) }, expiresAt: { $gt: new Date(now) },
    }, eligibilityProjection, 'eligibility');
    const eligible = validateEligibility(single(eligibility), lookup, now);
    const decision = (decisionId: string, decisionKind: string, subject = false) => read(models.decision, {
      _id: decisionId, organizationId: lookup.organizationId, decisionKind, authorityGeneration: acceptedGeneration,
      ...(subject ? { subjectActorId: lookup.actorId } : {}),
    }, decisionProjection, 'decision');
    const mappingDecisions = await decision(org.mappingDecisionId, 'business_mapped');
    const grantDecisions = await decision(selected[0].grantDecisionId, 'membership_granted', true);
    const verificationDecisions = await decision(eligible.verificationDecisionId, 'professional_verified', true);
    return Object.freeze({ user, organization, pharmacy, memberships, eligibility, mappingDecisions, grantDecisions, verificationDecisions });
  }
}
