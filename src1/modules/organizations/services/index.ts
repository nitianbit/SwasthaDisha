import { AuthorityError, AuthorityReadPort, BusinessScope } from '../types';
import { evaluateAuthority, validateContext, validateReadiness, validateTime } from '../rules';

const issuedScopes = new WeakSet<object>();
export function isBusinessScope(value: unknown): value is BusinessScope {
  return !!value && typeof value === 'object' && issuedScopes.has(value);
}

// This constructor is internal composition. A caller-shaped object is never a grant.
export class BusinessStaffAuthorityService {
  constructor(private readonly port: AuthorityReadPort, private readonly clock: () => number) {}

  async resolve(principal: unknown, request: unknown, transaction: unknown): Promise<BusinessScope> {
    const context = validateContext(principal, request);
    if (!transaction || typeof transaction !== 'object') throw new AuthorityError('INVALID_TRANSACTION');
    const now = this.clock();
    validateTime(now);
    const authorityGeneration = validateReadiness(await this.port.readiness());
    const lookup = Object.freeze({ ...context.request, actorId: context.person.actorId, authorityGeneration });
    const facts = await this.port.loadFacts(lookup, transaction, now);
    const scope = Object.freeze(evaluateAuthority(lookup, facts, now));
    // Scope fields are all immutable scalars: freezing this object is a deep freeze.
    issuedScopes.add(scope);
    return scope;
  }
}
