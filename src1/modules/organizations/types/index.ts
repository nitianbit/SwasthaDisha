export type BusinessKind = 'pharmacy' | 'lab';
export type Capability = 'pharmacy.prescription.review' | 'lab.report.release';
export type Profession = 'pharmacist' | 'lab_signatory';
export type AuthorityState = 'active' | 'suspended' | 'revoked';
export type DecisionKind = 'business_mapped' | 'membership_granted' | 'professional_verified';
export type DenialCategory = 'INVALID_CONTEXT' | 'AUTHORITY_DENIED' | 'AUTHORITY_NOT_READY' | 'AUTHORITY_MAPPING_UNAVAILABLE' | 'INVALID_TRANSACTION';

export class AuthorityError extends Error {
  constructor(readonly category: DenialCategory) {
    super(category);
    this.name = 'AuthorityError';
  }
}

export interface AuthenticatedPerson {
  readonly actorId: string;
  readonly userType: 'user';
  readonly purpose: 'staff';
}
export interface AuthorityRequest {
  readonly organizationId: string;
  readonly branchId: string;
  readonly capability: Capability;
}
export interface AuthorityLookup extends AuthorityRequest {
  readonly actorId: string;
  readonly authorityGeneration: string;
}
export type AuthorityReadiness = Readonly<{ ready: false }> | Readonly<{
  ready: true;
  authorityGeneration: string;
  indexesVerified: true;
  provenanceVerified: true;
  snapshotTransactionsVerified: true;
}>;
export interface RecordVersion {
  readonly _id: string;
  readonly schemaVersion: 1;
  readonly revision: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}
export interface Branch {
  readonly branchId: string;
  readonly state: AuthorityState;
  readonly revision: number;
}
export interface Organization extends RecordVersion {
  readonly kind: BusinessKind;
  readonly sourceBusinessId: string;
  readonly state: AuthorityState;
  readonly sourceFingerprint: string;
  readonly mappingDecisionId: string;
  readonly branches: readonly Branch[];
}
export interface StaffGrant {
  readonly branchId: string;
  readonly capability: Capability;
  readonly grantDecisionId: string;
}
export interface Membership extends RecordVersion {
  readonly organizationId: string;
  readonly actorId: string;
  readonly state: AuthorityState;
  readonly validFrom: number;
  readonly expiresAt: number;
  readonly grants: readonly StaffGrant[];
}
export interface Eligibility extends RecordVersion {
  readonly organizationId: string;
  readonly actorId: string;
  readonly profession: Profession;
  readonly state: 'verified' | 'suspended' | 'revoked';
  readonly validFrom: number;
  readonly expiresAt: number;
  readonly verificationDecisionId: string;
  readonly evidenceVersionId: string;
  readonly evidenceSha256: string;
}
export interface EvidenceReference {
  readonly evidenceVersionId: string;
  readonly evidenceSha256: string;
}
export interface DecisionMetadata {
  readonly _id: string;
  readonly schemaVersion: 1;
  readonly organizationId: string;
  readonly operationId: string;
  readonly decidingActorId: string;
  readonly decidedAt: number;
  readonly authorityGeneration: string;
  readonly payloadSha256: string;
  readonly evidence: readonly EvidenceReference[];
  readonly createdAt: number;
  readonly updatedAt: number;
}
export interface MappingPayload {
  readonly organizationId: string;
  readonly organizationRevision: number;
  readonly kind: BusinessKind;
  readonly sourceBusinessId: string;
  readonly sourceFingerprint: string;
  readonly branches: readonly Branch[];
}
export interface GrantPayload {
  readonly organizationId: string;
  readonly actorId: string;
  readonly membershipId: string;
  readonly membershipRevision: number;
  readonly validFrom: number;
  readonly expiresAt: number;
  readonly grants: readonly StaffGrant[];
  readonly branchId: string;
  readonly capability: Capability;
}
export interface VerificationPayload {
  readonly organizationId: string;
  readonly actorId: string;
  readonly eligibilityId: string;
  readonly eligibilityRevision: number;
  readonly profession: Profession;
  readonly validFrom: number;
  readonly expiresAt: number;
  readonly evidenceVersionId: string;
  readonly evidenceSha256: string;
  readonly grants: readonly Readonly<{ branchId: string; capability: Capability }>[];
}
export type AuthorityDecision = DecisionMetadata & (
  | Readonly<{ decisionKind: 'business_mapped'; payload: MappingPayload }>
  | Readonly<{ decisionKind: 'membership_granted'; subjectActorId: string; payload: GrantPayload }>
  | Readonly<{ decisionKind: 'professional_verified'; subjectActorId: string; payload: VerificationPayload }>
);
export interface AuthorityFacts {
  readonly user: unknown;
  readonly organization: unknown;
  readonly pharmacy: unknown;
  readonly memberships: readonly unknown[];
  readonly eligibility: readonly unknown[];
  readonly mappingDecisions: readonly unknown[];
  readonly grantDecisions: readonly unknown[];
  readonly verificationDecisions: readonly unknown[];
}
export interface AuthorityReadPort {
  readiness(): Promise<AuthorityReadiness>;
  loadFacts(lookup: AuthorityLookup, transaction: unknown, now: number): Promise<AuthorityFacts>;
}
export interface BusinessScope extends AuthorityLookup {
  readonly purpose: 'staff';
  readonly kind: 'pharmacy';
  readonly sourceBusinessId: string;
  readonly organizationRevision: number;
  readonly branchRevision: number;
  readonly membershipId: string;
  readonly membershipRevision: number;
  readonly eligibilityId: string;
  readonly eligibilityRevision: number;
  readonly mappingDecisionId: string;
  readonly grantDecisionId: string;
  readonly verificationDecisionId: string;
  readonly evidenceVersionId: string;
  readonly evidenceSha256: string;
  readonly checkedAt: number;
  readonly expiresAt: number;
}
