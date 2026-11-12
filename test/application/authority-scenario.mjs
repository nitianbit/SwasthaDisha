import assert from 'node:assert/strict';
import { AssertionError } from 'node:assert';
import { readFileSync, writeSync } from 'node:fs';
import { compileFunction } from 'node:vm';
import { createHash } from 'node:crypto';
import {
  assertBundle, AUTHORITY_CASE_IDS, AUTHORITY_COMPILER_SHA, AUTHORITY_CONTROLS, AUTHORITY_EMIT_OPTIONS,
  AUTHORITY_INPUTS, AUTHORITY_ROLE, AUTHORITY_SOURCE_HASHES, AUTHORITY_VECTORS_SHA, sha256,
} from './app-bundle.mjs';

const ids = Object.keys(AUTHORITY_INPUTS);
const [TYPES, RULES, SERVICE] = ids;
const copy = (value) => JSON.parse(JSON.stringify(value));
const independentHash = (value) => createHash('sha256').update(value, 'utf8').digest('hex');
const sameKeys = (value, keys) => assert.deepEqual(Object.keys(value).sort(), [...keys].sort());
const controlMarker = (id) => id === 'M5' ? 'FORGED_SCOPE_ACCEPTED' : 'EXPECTED_AUTHORITY_DENIAL_MISSING';

export async function runAuthorityScenario() {
  let diagnosticBytes = 0;
  const record = (value) => {
    const line = JSON.stringify(value) + '\n'; diagnosticBytes += Buffer.byteLength(line);
    assert.ok(diagnosticBytes < 32 * 1024, 'Authority diagnostics limit');
    assert.equal(writeSync(2, line), Buffer.byteLength(line), 'Authority diagnostic write was incomplete');
  };
  const admitted = () => assertBundle('/workspace', {
    runId: process.env.APP_RUN_ID, manifestSha: process.env.APP_MANIFEST_SHA, role: AUTHORITY_ROLE,
  });
  const manifest = admitted();
  for (const id of ids) assert.equal(manifest.files[AUTHORITY_INPUTS[id]], AUTHORITY_SOURCE_HASHES[id]);
  assert.equal(manifest.files['typescript.cjs'], AUTHORITY_COMPILER_SHA);
  assert.equal(manifest.files['authority-vectors.json'], AUTHORITY_VECTORS_SHA);
  const sources = Object.fromEntries(ids.map((id) => [id, readFileSync('/workspace/' + AUTHORITY_INPUTS[id], 'utf8')]));
  const vectors = JSON.parse(readFileSync('/workspace/authority-vectors.json', 'utf8'));
  const state = { compilerLoads: 0, compilerRequests: [], emits: { nominal: 0, mutant: 0 }, graphs: 0,
    evaluations: Object.fromEntries(ids.map((id) => [id, 0])), probes: 0, nominalEdges: null,
    effects: { database: 0, provider: 0, sourceWrites: 0, domainNativeImports: 0 } };
  const denied = (kind) => { const error = new Error('AUTHORITY_LINKER_DENIED:' + kind); error.code = 'AUTHORITY_LINKER_DENIED'; throw error; };
  const rejectCompilerImport = (request, attempts) => { attempts.push(request); return denied('compiler'); };
  const compilerRequire = (request) => rejectCompilerImport(request, state.compilerRequests);
  const compilerText = readFileSync('/workspace/typescript.cjs', 'utf8');
  assert.equal(sha256(compilerText), AUTHORITY_COMPILER_SHA);
  const tool = { exports: {} }; state.compilerLoads++;
  // Full standard compiler bytes, but no Node-system discovery/import host.
  compileFunction(compilerText, ['module', 'exports', 'require', 'process', 'performance'], {
    filename: '/workspace/typescript.cjs',
  })(tool, tool.exports, compilerRequire, undefined, undefined);
  const ts = tool.exports;
  assert.equal(ts.version, '5.9.3'); assert.equal(ts.sys, undefined); assert.equal(state.compilerRequests.length, 0);
  assert.equal(ts.ScriptTarget.ES2020, AUTHORITY_EMIT_OPTIONS.target);
  assert.equal(ts.ModuleKind.CommonJS, AUTHORITY_EMIT_OPTIONS.module);
  function emit(id, source, phase) {
    state.emits[phase]++;
    const result = ts.transpileModule(source, { fileName: id, compilerOptions: { ...AUTHORITY_EMIT_OPTIONS }, reportDiagnostics: true });
    assert.deepEqual(result.diagnostics ?? [], [], 'Compiler reported diagnostics');
    assert.equal(ts.sys, undefined); assert.equal(state.compilerRequests.length, 0);
    assert.equal(typeof result.outputText, 'string'); assert.ok(result.outputText.length > 0);
    assert.ok(Buffer.byteLength(result.outputText) < 128 * 1024, 'Emitted module limit');
    record({ tag: 'AUTHORITY_EMIT', phase, id, sha256: sha256(result.outputText) });
    return result.outputText;
  }
  const nominalEmit = Object.fromEntries(ids.map((id) => [id, emit(id, sources[id], 'nominal')]));
  assert.ok(Object.values(nominalEmit).reduce((n, text) => n + Buffer.byteLength(text), 0) < 384 * 1024);
  function graph(code, phase) {
    admitted(); for (const id of ids) assert.equal(sha256(readFileSync('/workspace/' + AUTHORITY_INPUTS[id])), AUTHORITY_SOURCE_HASHES[id]);
    state.graphs++; const cache = new Map(); const edges = [];
    function request(name, parent, probe = false) {
      if (!probe) edges.push([parent, name]);
      const target = parent === RULES && name === './types' ? TYPES
        : parent === SERVICE && name === '../types' ? TYPES : parent === SERVICE && name === '../rules' ? RULES : undefined;
      if (target) return load(target);
      if (parent === RULES && name === 'crypto') return Object.freeze({ createHash });
      if (probe) state.probes++;
      return denied('domain');
    }
    function load(id) {
      assert.ok(ids.includes(id), 'Unknown fixed module');
      if (cache.has(id)) return cache.get(id).exports;
      const module = { exports: {} }; cache.set(id, module); state.evaluations[id]++;
      compileFunction(code[id], ['exports', 'require', 'module'], { filename: id })(module.exports, (name) => request(name, id), module);
      return module.exports;
    }
    const types = load(TYPES); const rules = load(RULES); const service = load(SERVICE);
    sameKeys(types, ['AuthorityError']); // __esModule is non-enumerable compiler metadata.
    sameKeys(rules, ['validateContext', 'validateTime', 'validateReadiness', 'validateLookup', 'validateUser',
      'validateOrganization', 'pharmacyFingerprint', 'serializeDecision', 'decisionDigest', 'validateMembership',
      'validateEligibility', 'evaluateAuthority']);
    sameKeys(service, ['isBusinessScope', 'BusinessStaffAuthorityService']);
    assert.deepEqual(edges, [[RULES, 'crypto'], [RULES, './types'], [SERVICE, '../types'], [SERVICE, '../rules']]);
    if (phase === 'nominal') state.nominalEdges = edges;
    return { types, rules, service, probe: (name) => request(name, RULES, true) };
  }
  const principal = () => ({ actorId: '1'.repeat(24), userType: 'user', purpose: 'staff' });
  const request = () => ({ organizationId: '2'.repeat(24), branchId: '3'.repeat(24), capability: 'pharmacy.prescription.review' });
  function fixture() {
    const rows = copy(vectors.decisions); const trees = Object.fromEntries(rows.map((row) => [row.kind, JSON.parse(row.expected_serialization_utf8)]));
    const mapping = rows.find((r) => r.kind === 'business_mapped').record;
    const grant = rows.find((r) => r.kind === 'membership_granted').record;
    const verified = rows.find((r) => r.kind === 'professional_verified').record;
    const facts = { user: { _id: '1'.repeat(24), userType: 'user', isActive: true },
      organization: { _id: '2'.repeat(24), schemaVersion: 1, revision: 1, createdAt: 100, updatedAt: 100,
        kind: 'pharmacy', sourceBusinessId: '4'.repeat(24), state: 'active', sourceFingerprint: vectors.fingerprint.expected_sha256,
        mappingDecisionId: mapping._id, branches: copy(mapping.payload.branches) },
      pharmacy: copy(vectors.fingerprint.input),
      memberships: [{ _id: '5'.repeat(24), schemaVersion: 1, revision: 1, createdAt: 100, updatedAt: 100,
        organizationId: '2'.repeat(24), actorId: '1'.repeat(24), state: 'active', validFrom: 100, expiresAt: 2000,
        grants: copy(grant.payload.grants) }],
      eligibility: [{ _id: '6'.repeat(24), schemaVersion: 1, revision: 1, createdAt: 100, updatedAt: 100,
        organizationId: '2'.repeat(24), actorId: '1'.repeat(24), profession: 'pharmacist', state: 'verified', validFrom: 100,
        expiresAt: 2000, verificationDecisionId: verified._id, evidenceVersionId: verified.payload.evidenceVersionId,
        evidenceSha256: verified.payload.evidenceSha256 }],
      mappingDecisions: [mapping], grantDecisions: [grant], verificationDecisions: [verified] };
    // Modify declared canonical fixture arrays, not the production serializer.
    const proof = (kind, path, value, serialized = value) => {
      const record = kind === 'business_mapped' ? mapping : kind === 'membership_granted' ? grant : verified;
      const tree = trees[kind]; const tuples = path.length === 1 ? tree : tree.find((x) => Array.isArray(x) && x[0] === 'payload').slice(1);
      const field = tuples.find((x) => Array.isArray(x) && x[0] === path.at(-1)); assert.ok(field, 'Unknown declared fixture field');
      if (path.length === 1) record[path[0]] = value; else record[path[0]][path[1]] = value;
      field[1] = serialized; record.payloadSha256 = independentHash(JSON.stringify(tree));
    };
    return { facts, trees, mapping, grant, verified, proof, now: 1000, principal: principal(), request: request(), transaction: Object.freeze({ fixture: 'transaction' }),
      ready: { ready: true, authorityGeneration: '1'.repeat(64), indexesVerified: true, provenanceVerified: true, snapshotTransactionsVerified: true } };
  }
  const traces = []; let activePhase;
  const phaseStart = process.hrtime.bigint();
  const withinPhase = () => assert.ok(Number(process.hrtime.bigint() - phaseStart) < 10_000_000_000, 'Authority case phase limit');
  async function invoke(g, f, id, category, options = {}) {
    const calls = []; let scope; let error; let thrown = false;
    const ownValue = (object, key) => Object.getOwnPropertyDescriptor(object, key)?.value;
    const expectedLookup = { organizationId: ownValue(f.request, 'organizationId'), branchId: ownValue(f.request, 'branchId'),
      capability: ownValue(f.request, 'capability'), actorId: ownValue(f.principal, 'actorId'),
      authorityGeneration: ownValue(f.ready, 'authorityGeneration') };
    const clock = () => { calls.push('clock'); if (Object.hasOwn(options, 'clockThrow')) throw options.clockThrow; return f.now; };
    const port = {
      async readiness() {
        calls.push('readiness'); if (Object.hasOwn(options, 'readyThrow')) throw options.readyThrow;
        if (options.defer) return new Promise((resolve) => { options.defer(); resolve(f.ready); });
        return f.ready;
      },
      async loadFacts(lookup, transaction, now) {
        calls.push('facts');
        assert.deepEqual(lookup, expectedLookup);
        assert.equal(Object.isFrozen(lookup), true); assert.equal(transaction, f.transaction); assert.equal(now, f.now);
        if (Object.hasOwn(options, 'factsThrow')) throw options.factsThrow;
        return f.facts;
      },
    };
    const service = new g.service.BusinessStaffAuthorityService(port, clock);
    try { scope = await service.resolve(f.principal, f.request, Object.hasOwn(options, 'transaction') ? options.transaction : f.transaction); }
    catch (value) { thrown = true; error = value; }
    const expectedCalls = options.calls ?? ['clock', 'readiness', 'facts'];
    const row = { phase: activePhase, id, calls, expected: category ?? 'SUCCESS', thrown };
    traces.push(row); assert.deepEqual(calls, expectedCalls, id + ': PORT_CALLS');
    if (category === 'PROPAGATED') {
      assert.equal(thrown, true, id + ': EXPECTED_PROPAGATION_MISSING'); assert.equal(error, options.expectedError, id + ': ERROR_IDENTITY');
    } else if (category) {
      if (!thrown) assert.fail(id + ': EXPECTED_AUTHORITY_DENIAL_MISSING');
      assert.equal(error instanceof g.types.AuthorityError, true, id + ': WRONG_ERROR_CLASS');
      assert.equal(error.category, category, id + ': WRONG_ERROR_CATEGORY');
    } else { if (thrown) throw error; assert.equal(g.service.isBusinessScope(scope), true); }
    return scope;
  }
  async function leaf(id, g) {
    withinPhase(); const [group, variant] = id.split('.'); const f = fixture();
    const run = (category, options) => invoke(g, f, id, category, options);
    const D = 'AUTHORITY_DENIED';
    switch (group) {
      case 'A01': {
        const scope = await run(); assert.equal(Object.isFrozen(scope), true);
        assert.deepEqual(scope, { ...request(), actorId: principal().actorId, authorityGeneration: '1'.repeat(64), purpose: 'staff', kind: 'pharmacy',
          sourceBusinessId: '4'.repeat(24), organizationRevision: 1, branchRevision: 1, membershipId: '5'.repeat(24), membershipRevision: 1,
          eligibilityId: '6'.repeat(24), eligibilityRevision: 1, mappingDecisionId: f.mapping._id, grantDecisionId: f.grant._id,
          verificationDecisionId: f.verified._id, evidenceVersionId: f.facts.eligibility[0].evidenceVersionId,
          evidenceSha256: f.facts.eligibility[0].evidenceSha256, checkedAt: 1000, expiresAt: 2000 }); break;
      }
      case 'A02': { const error = new g.types.AuthorityError(D); assert.equal(error.category, D); assert.equal(error.name, 'AuthorityError'); assert.ok(error instanceof Error); break; }
      case 'A03': {
        let getters = 0;
        if (variant === 'bad-id') f.principal.actorId = 'A'.repeat(24);
        if (variant === 'business-login') f.principal.userType = 'pharmacy';
        if (variant === 'missing-purpose') delete f.principal.purpose;
        if (variant === 'extra-key') f.principal.extra = true;
        if (variant === 'accessor') Object.defineProperty(f.principal, 'actorId', { enumerable: true, get() { getters++; return '1'.repeat(24); } });
        await run('INVALID_CONTEXT', { calls: [] }); assert.equal(getters, 0); break;
      }
      case 'A04': {
        if (variant === 'bad-org-id') f.request.organizationId = 'invalid';
        if (variant === 'unknown-capability') f.request.capability = 'admin';
        if (variant === 'extra-key') f.request.extra = true;
        await run('INVALID_CONTEXT', { calls: [] }); break;
      }
      case 'A05': await run('INVALID_TRANSACTION', { calls: [], transaction: variant === 'null' ? null : variant === 'number' ? 1 : 'transaction' }); break;
      case 'A06': f.now = { nan: NaN, infinity: Infinity, negative: -1, unsafe: Number.MAX_SAFE_INTEGER + 1, 'out-of-range': 8640000000000001 }[variant]; await run(D, { calls: ['clock'] }); break;
      case 'A07': { const value = variant === 'error' ? new Error('synthetic-clock') : variant === 'false' ? false : undefined; await run('PROPAGATED', { clockThrow: value, expectedError: value, calls: ['clock'] }); break; }
      case 'A08': {
        if (variant === 'false') f.ready = { ready: false };
        if (variant === 'missing-flag') delete f.ready.indexesVerified;
        if (variant === 'false-flag') f.ready.snapshotTransactionsVerified = false;
        if (variant === 'bad-generation') f.ready.authorityGeneration = 'not-a-digest';
        await run('AUTHORITY_NOT_READY', { calls: ['clock', 'readiness'] }); break;
      }
      case 'A09': case 'A10': {
        const value = variant === 'error' ? new Error('synthetic-port') : variant === 'false' ? false : undefined;
        await run('PROPAGATED', { [group === 'A09' ? 'readyThrow' : 'factsThrow']: value, expectedError: value,
          calls: group === 'A09' ? ['clock', 'readiness'] : ['clock', 'readiness', 'facts'] }); break;
      }
      case 'A11': await run(undefined, { defer() { f.principal.actorId = 'e'.repeat(24); f.request.organizationId = 'f'.repeat(24); } }); break;
      case 'A12': if (variant === 'inactive') f.facts.user.isActive = false; else f.facts.user._id = 'e'.repeat(24); await run(D); break;
      case 'A13': {
        if (variant === 'membership-tenant') f.facts.memberships[0].organizationId = 'e'.repeat(24);
        if (variant === 'eligibility-actor') f.facts.eligibility[0].actorId = 'e'.repeat(24);
        if (variant === 'organization-id') f.facts.organization._id = 'e'.repeat(24);
        await run(D); break;
      }
      case 'A14': if (variant === 'organization-suspended') f.facts.organization.state = 'suspended'; else f.facts.organization.branches[0].state = 'revoked'; await run(D); break;
      case 'A15': if (variant === 'license-number') f.facts.pharmacy.drugLicenseNumber += '-changed'; else if (variant === 'license-document') f.facts.pharmacy.drugLicenseDocumentUrl += ':changed'; else f.facts.pharmacy.isVerified = false; await run(D); break;
      case 'A16': f.facts.organization.kind = 'lab'; f.request.capability = 'lab.report.release'; await run('AUTHORITY_MAPPING_UNAVAILABLE'); break;
      case 'A17': if (variant === 'missing-member') f.facts.memberships = []; else if (variant === 'duplicate-member') f.facts.memberships.push(copy(f.facts.memberships[0])); else f.facts.mappingDecisions = []; await run(D); break;
      case 'A18': if (variant === 'schema') f.facts.memberships[0].schemaVersion = 2; else f.facts.memberships[0].revision = variant === 'zero-revision' ? 0 : Number.MAX_SAFE_INTEGER + 1; await run(D); break;
      case 'A19': {
        if (variant === 'validfrom-equal') { f.now = 100; const scope = await run(); assert.equal(scope.checkedAt, 100); break; }
        if (variant === 'validfrom-future') { f.facts.memberships[0].validFrom = 1001; f.proof('membership_granted', ['payload', 'validFrom'], 1001); }
        if (variant === 'expiry-equal') f.now = 2000;
        if (variant === 'created-after-updated') f.facts.memberships[0].updatedAt = 50;
        await run(D); break;
      }
      case 'A20': f.facts.eligibility[0].expiresAt = 1500; f.proof('professional_verified', ['payload', 'expiresAt'], 1500); assert.equal((await run()).expiresAt, 1500); break;
      case 'A21': {
        if (variant === 'fingerprint') assert.equal(g.rules.pharmacyFingerprint(copy(vectors.fingerprint.input)), vectors.fingerprint.expected_sha256);
        else {
          const kind = { mapping: 'business_mapped', grant: 'membership_granted', verification: 'professional_verified' }[variant];
          const row = vectors.decisions.find((x) => x.kind === kind);
          assert.equal(g.rules.serializeDecision(copy(row.record)), row.expected_serialization_utf8);
          assert.equal(g.rules.decisionDigest(copy(row.record)), row.expected_sha256);
        } break;
      }
      case 'A22': {
        for (const row of vectors.decisions) {
          const value = copy(row.record); const expected = JSON.parse(row.expected_serialization_utf8);
          if (variant === 'object-keys') {
            const reordered = Object.fromEntries(Object.entries(value).reverse());
            assert.equal(g.rules.serializeDecision(reordered), row.expected_serialization_utf8);
          } else {
            const extra = { evidenceVersionId: '0'.repeat(23) + '2', evidenceSha256: 'a'.repeat(64) };
            value.evidence.push(extra);
            expected.find((x) => Array.isArray(x) && x[0] === 'evidence')[1].unshift([extra.evidenceVersionId, extra.evidenceSha256]);
            const payload = expected.find((x) => Array.isArray(x) && x[0] === 'payload').slice(1);
            if (row.kind === 'business_mapped') {
              const second = { branchId: '0'.repeat(23) + '3', state: 'active', revision: 1 };
              value.payload.branches.push(second);
              payload.find((x) => x[0] === 'branches')[1].unshift([second.branchId, second.state, second.revision]);
            } else {
              const second = { branchId: '0'.repeat(23) + '3', capability: 'pharmacy.prescription.review',
                ...(row.kind === 'membership_granted' ? { grantDecisionId: '9'.repeat(24) } : {}) };
              value.payload.grants.push(second);
              payload.find((x) => x[0] === 'grants')[1].unshift(row.kind === 'membership_granted'
                ? [second.branchId, second.capability, second.grantDecisionId] : [second.branchId, second.capability]);
            }
            assert.equal(g.rules.serializeDecision(value), JSON.stringify(expected));
            value.evidence.reverse();
            if (row.kind === 'business_mapped') value.payload.branches.reverse(); else value.payload.grants.reverse();
            assert.equal(g.rules.serializeDecision(value), JSON.stringify(expected));
            assert.equal(g.rules.decisionDigest(value), independentHash(JSON.stringify(expected)));
          }
        } break;
      }
      case 'A23': if (variant === 'metadata-operation') f.mapping.operationId = '0'.repeat(23) + '2'; else if (variant === 'payload-fingerprint') f.mapping.payload.sourceFingerprint = 'a'.repeat(64); else f.verified.evidence[0].evidenceSha256 = 'a'.repeat(64); await run(D); break;
      case 'A24': f.ready.authorityGeneration = '2'.repeat(64); await run(D); break;
      case 'A25': if (variant === 'organization-revision') f.facts.organization.revision = 2; else if (variant === 'membership-revision') f.facts.memberships[0].revision = 2; else f.facts.eligibility[0].revision = 2; await run(D); break;
      case 'A26': {
        if (variant === 'self-grant') f.proof('membership_granted', ['decidingActorId'], principal().actorId);
        if (variant === 'self-verification') f.proof('professional_verified', ['decidingActorId'], principal().actorId);
        if (variant === 'evidence-version') { f.proof('professional_verified', ['payload', 'evidenceVersionId'], 'e'.repeat(24)); f.facts.eligibility[0].evidenceVersionId = 'e'.repeat(24); }
        await run(D); break;
      }
      case 'A27': {
        if (variant === 'decision-id') { f.proof('membership_granted', ['_id'], f.mapping._id); f.facts.memberships[0].grants[0].grantDecisionId = f.mapping._id;
          const grants = copy(f.facts.memberships[0].grants); f.proof('membership_granted', ['payload', 'grants'], grants, grants.map((x) => [x.branchId, x.capability, x.grantDecisionId]));
        } else f.proof('membership_granted', ['operationId'], f.mapping.operationId);
        await run(D); break;
      }
      case 'A28': {
        let value;
        if (variant === 'raw-evaluator') value = g.rules.evaluateAuthority({ ...request(), actorId: principal().actorId, authorityGeneration: '1'.repeat(64) }, f.facts, 1000);
        else {
          const scope = await run(); value = variant === 'spread-clone' ? Object.freeze({ ...scope })
            : variant === 'json-clone' ? JSON.parse(JSON.stringify(scope)) : Object.create(scope);
        }
        assert.equal(g.service.isBusinessScope(value), false, id + ': FORGED_SCOPE_ACCEPTED'); break;
      }
      case 'A29': { const scope = await run(); const before = JSON.stringify(scope); f.facts.memberships[0].revision = 99; f.facts.organization.sourceBusinessId = 'e'.repeat(24); assert.equal(JSON.stringify(scope), before); assert.equal(Object.isFrozen(scope), true); break; }
      case 'A30': { const scope = await run(); f.facts.memberships[0].state = 'revoked'; await run(D); assert.equal(g.service.isBusinessScope(scope), true); break; }
      case 'A31': {
        if (variant === 'domain-fs') assert.throws(() => g.probe('fs'), { code: 'AUTHORITY_LINKER_DENIED' });
        else { const attempts = []; state.probes++; assert.throws(() => rejectCompilerImport('fs', attempts), { code: 'AUTHORITY_LINKER_DENIED' }); assert.deepEqual(attempts, ['fs']); }
        break;
      }
      case 'A32': {
        let getters = 0;
        if (variant === 'facts-extra-key') f.facts.extra = true;
        if (variant === 'nested-accessor') Object.defineProperty(f.facts.memberships[0], 'state', { enumerable: true, get() { getters++; return 'active'; } });
        if (variant === 'empty-branches') f.facts.organization.branches = [];
        if (variant === 'over100-branches') f.facts.organization.branches = [f.facts.organization.branches[0], ...Array.from({ length: 100 }, (_, i) => ({ branchId: (1000 + i).toString(16).padStart(24, '0'), state: 'active', revision: 1 }))];
        await run(D); assert.equal(getters, 0); break;
      }
      default: assert.fail('Unregistered authority case');
    }
    withinPhase();
  }
  async function checkedLeaf(id, g, phase) {
    activePhase = phase; const before = traces.length; let failed = false; let failure;
    try { await leaf(id, g); } catch (value) { failed = true; failure = value; }
    const observations = traces.slice(before);
    const count = (name) => observations.reduce((total, row) => total + row.calls.filter((call) => call === name).length, 0);
    try {
      record({ tag: 'AUTHORITY_LEAF', phase, id, completed: !failed,
        calls: { clock: count('clock'), readiness: count('readiness'), facts: count('facts') },
        order: observations.map((row) => row.calls.join(',')).join('|'),
        expected: observations.map((row) => row.expected) });
    } catch (recordingError) {
      if (failed) throw new AggregateError([failure, recordingError], 'Authority leaf and recording failed');
      throw recordingError;
    }
    if (failed) throw failure;
  }
  const nominal = graph(nominalEmit, 'nominal'); const completed = [];
  for (const id of AUTHORITY_CASE_IDS) { await checkedLeaf(id, nominal, 'nominal'); completed.push(id); }
  assert.deepEqual(completed, AUTHORITY_CASE_IDS);
  const mutations = [
    { id: 'M1', module: RULES, old: 'now < d.expiresAt', replacement: 'true' },
    { id: 'M2', module: RULES, old: 'check(decisionDigest(decision) === decision.payloadSha256);', replacement: 'check(true);' },
    { id: 'M3', module: RULES, old: "check(d.organizationId === lookup.organizationId && d.actorId === lookup.actorId && d.state === 'active');", replacement: "check(true && d.actorId === lookup.actorId && d.state === 'active');" },
    { id: 'M4', module: RULES, old: 'gp.membershipRevision === member.revision', replacement: 'true' },
    { id: 'M5', module: SERVICE, old: 'issuedScopes.has(value)', replacement: 'true' },
  ];
  const controls = []; const mutantHashes = {};
  for (const mutation of mutations) {
    withinPhase(); const target = AUTHORITY_CONTROLS.find(([id]) => id === mutation.id)[1];
    const source = sources[mutation.module]; assert.equal(source.split(mutation.old).length, 2, 'Mutation must affect one exact source occurrence');
    const changed = source.replace(mutation.old, mutation.replacement);
    const output = emit(mutation.module, changed, 'mutant'); mutantHashes[mutation.id] = sha256(output);
    assert.notEqual(mutantHashes[mutation.id], sha256(nominalEmit[mutation.module]));
    const altered = graph({ ...nominalEmit, [mutation.module]: output }, 'mutant'); let detected = false;
    try { await checkedLeaf(target, altered, 'mutant'); }
    catch (error) {
      assert.ok(error instanceof AssertionError && error.message.includes(target + ': ' + controlMarker(mutation.id)), 'Wrong control failure');
      detected = true;
    }
    assert.equal(detected, true, 'Weakened source was not detected');
    await checkedLeaf(target, graph(nominalEmit, 'restoration'), 'restoration');
    controls.push({ id: mutation.id, target, mutantDetected: detected, restored: true });
  }
  const phaseMs = Number(process.hrtime.bigint() - phaseStart) / 1e6; assert.ok(phaseMs < 10000);
  assert.equal(state.compilerLoads, 1); assert.equal(state.compilerRequests.length, 0); assert.equal(ts.sys, undefined);
  assert.equal(state.emits.nominal, 3); assert.equal(state.emits.mutant, 5); assert.equal(state.graphs, 11);
  for (const id of ids) assert.equal(state.evaluations[id], 11); assert.equal(state.probes, 2);
  admitted();
  const observedSourceHashes = Object.fromEntries(ids.map((id) => [id, sha256(readFileSync('/workspace/' + AUTHORITY_INPUTS[id]))]));
  assert.deepEqual(observedSourceHashes, AUTHORITY_SOURCE_HASHES);
  record({ tag: 'AUTHORITY_PHASE', elapsedMs: phaseMs, nominalLeaves: completed.length, controls: controls.length,
    compilerLoads: state.compilerLoads, emits: state.emits, graphs: state.graphs, moduleEvaluations: state.evaluations });
  return {
    schema: 'SD-AUTHORITY-PURE-1', sourceHashes: observedSourceHashes,
    compiler: { version: ts.version, sha256: sha256(compilerText), loads: state.compilerLoads, requireAttempts: state.compilerRequests.length, sysAbsent: ts.sys === undefined },
    emit: { optionsSha256: sha256(JSON.stringify(AUTHORITY_EMIT_OPTIONS)), nominalHashes: Object.fromEntries(ids.map((id) => [id, sha256(nominalEmit[id])])),
      mutantHashes, nominalCount: state.emits.nominal, mutantCount: state.emits.mutant },
    nominal: { caseIds: completed, passed: completed.length, failed: 0, skipped: 0 }, controls,
    evaluations: { graphs: state.graphs, types: state.evaluations[TYPES], rules: state.evaluations[RULES], service: state.evaluations[SERVICE], total: Object.values(state.evaluations).reduce((a, b) => a + b, 0) },
    effects: { ...state.effects, boundaryProbeRejections: state.probes },
  };
}
