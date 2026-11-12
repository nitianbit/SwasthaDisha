# Focused staff-authority runtime contract — candidate

12 November 2026. Author `/root/claude_review_5_packet`. **DRAFT, IMPLEMENTATION/EXECUTION NOT YET APPROVED.** Baseline focus `ea48a35cce0c010bbbe6a112795a090931d6fd8c`. Scope: execute exactly three complete organizations modules against recording read ports after the existing Docker C3 admission. No production edits, clinical expansion, real database, providers, root build/runtime adoption or final cross-module campaign. Read [readiness](AUTHORITY_PURE_RUNTIME_READINESS.md), [authority source contract](BUSINESS_STAFF_AUTHORITY_CONTRACT.md), [C2](C2_COMPATIBILITY_REVIEW.md) and [C3](C3_APP_ISOLATION_CONTRACT.md).

## Ownership and fixed changes

Root owns shared interfaces, integration, source freezes and invocation receipts. One assigned harness worker owns ONLY these files after two nonauthor preimplementation decisions:

- Amend `test/application/app-bundle.mjs`, `app-container.mjs`, `bootstrap.mjs` and their existing `app-bundle.test.mjs`/`app-container.test.mjs` tests; update the application README's bounded-role description.
- Add `test/application/authority-scenario.mjs` and the small fixed `run-authority.mjs` entry. No new generic loader/VM/compiler package/operator. No foundation staging-list, root scripts/package/lock/start, production, network-framework or Mongo fixture changes.

Keep existing SOURCE_NAMES, ROLE, six-file128KiB limits, endpoint-only default factory/entry, seven recording ports and default success schema unchanged. Internally factor only the controller's source/profile/acceptance selection needed for a second fixed role. Export `createAuthorityFixture(input,seams={})` alongside the existing factory; both use the same ownership/create/start/inspect/cleanup implementation and accept only `{endpoint}` as real input. No public role/path/compiler/command selector. Nonempty simulated seams require an own callable executor before allocation or real transport; synthetic texts/expectations remain simulation-only and cannot change real pins or fall through to native operations.

## Role, bundle and boundary

Fixed role: `business-staff-authority-pure`. Fixed sorted nine-file bundle:

| Staged name | Sole source |
| --- | --- |
| `app-bundle.mjs` | Shared reviewed harness file |
| `authority-rules.ts` | `src1/modules/organizations/rules.ts` |
| `authority-scenario.mjs` | New fixed harness scenario |
| `authority-service.ts` | `src1/modules/organizations/services/index.ts` |
| `authority-types.ts` | `src1/modules/organizations/types/index.ts` |
| `authority-vectors.json` | `output/qa/business-staff-authority/SERIALIZATION_VECTORS.json` |
| `bootstrap.mjs` | Shared reviewed bootstrap |
| `package.json` | Exactly existing generated `{"type":"module"}\n` |
| `typescript.cjs` | Existing pinned compiler artifact below |

Reuse manifest schema `{runId,role,files}` and `.admission.json`. Existing two-key assertBundle expectations keep default meaning; an explicit authority-role expectation permits only this closed profile. Unknown role/files, symlinks, hard links, malformed metadata or drift reject. Compiler alone must be under10MiB; every other file under128KiB; total bundle under12MiB; manifest under64KiB. No global limit widening. Root's exact source freeze checks full committed source and installed compiler bytes before staging, before launch and after exit. Child repeats manifest/regular-file/whole-file hashes before compilation and production evaluation.

Keep the known local endpoint/engine and cached Node22 image; no pull/daemon start/target fallback. Retain network:none, read-only root, UID/GID1000, cap-drop ALL, no-new-privileges, no device/host namespace/port/extra mount,512MiB/one CPU/64PIDs, one exact owned read-only bundle and existing64MiB tmpfs. Node grants remain read `/workspace` and `/sys/class/net`, write `/tmp`, no child/worker/addon. No host repository/home/socket/read grant. Retain configured20-second controller Docker-command timeout and300-second outer invocation timeout; case phase at most10seconds, result at most16KiB and diagnostics32KiB. These configured limits do not justify a retry or widening if exceeded.

Shared bootstrap validates environment/role/manifest and completes parent isolation, semantic network admission, filesystem/process canaries and ENETUNREACH-only documentation-address canary before **any compiler or authority evaluation**. Add only the fixed post-admission authority branch. Default branch and imports remain intact; authority branch imports only authority-scenario and returns its distinct result. It must not fabricate seven provider receipts. Existing instant Docker metadata success supplies no container execution authority.

## Source/tool pins and faithful evaluation

| Input | SHA-256 |
| --- | --- |
| Organizations types,5660bytes | `e873884e69db46d7de70d3120a5ac30809fe8dc526d118a4640463233c9633ff` |
| Rules,17283bytes | `b404c00381b5bf642aa648105cefb353a97c7ea7283c680059c426b5e4307942` |
| Service,1390bytes | `ccac5254a6e61c8cce4f14c58005cb39349689e3d0cbafc8ab551ca339397c73` |
| Reference vectors | `9f2ab5e192c9eb4a1332680a77f0ed5d94eb28502af3fc9a426f68be350ea382` |
| TypeScript5.9.3 compiler,9,112,572bytes | `3ae902c92cc44dace175c0e69e13a4b0899f6983c6121d76b9ab8dd5795e7675` |

Compiler source is `/Users/shubham/.codex/runtimes/ruflo/3.75.0/node_modules/typescript/lib/typescript.js`: regular/nlink1/owner501/mode0644. Copy those bytes only; no download, node_modules/home mount or root dependency change. Source disappearance/drift blocks; never substitute VS Code6.0.3 or another compiler.

Use the same small, slice-local CommonJS wrapper mechanism for the full compiler and full emitted modules: `vm.compileFunction` in the current realm with explicit exports/require/module arguments, no default dynamic-import callback, no custom context, no source extraction or generic VM framework. **Compiler initialization additionally shadows process and performance with undefined**, and its supplied require records and rejects every request. The pinned compiler gates Node-system/perf imports on isNodeLikeSystem. Require actual `ts.version==='5.9.3'`, `ts.sys===undefined` and zero compiler require attempts before and after emit; do not call setSys/createCompilerHost or enable filesystem discovery. Unexpected access/import fails closed rather than enabling fs/path/os/inspector/source-map-support. This fixed browser-style tool host is not a dummy production type export, semantic type checker or malicious-code sandbox. Compatibility must be measured in the admitted container.

Call real `transpileModule` with `reportDiagnostics:true`, targetES2020/moduleCommonJS/esModuleInterop:true/verbatimModuleSyntax:false/importHelpers:false/declaration:false/sourceMap:false, original logical filenames, no renamed dependencies or custom transforms. Reject any reported diagnostic, missing/empty output or emission over128KiB; nominal combined emit under384KiB. Record exact options and emitted hashes. No post-emit rewrite. Standard type-import elision and constructor parameter-property assignments must be observed through actual module behavior. There is no semantic type-check claim.

Domain linker has exactly three logical module IDs (`src1/modules/organizations/types/index.ts`, `src1/modules/organizations/rules.ts`, `src1/modules/organizations/services/index.ts`), also the exact sourceHashes/nominalHashes keys, and the existing relative edges: rules→types and `crypto`; service→types/rules. Its only builtin is a frozen `{createHash}` from real Node crypto. All other requests reject before resolution/evaluation. Cache the three complete modules once per graph; share actual AuthorityError/WeakSet identities. No Mongoose/model/repository/Express/TypeDI/provider or config import. Opaque transaction and readiness/provenance/index booleans are fixture facts only; no real-session/readiness/human-qualification claim.

## Frozen behavior cases and expected effects

There are exactly **84 nominal leaf cases**, grouped below. Each row defines leaf IDs `Axx.<variant>`; a row with `only` has leaf `Axx.only`. Freeze these exact IDs in one shared AUTHORITY_CASE_IDS constant for scenario/parent acceptance. No optional/skipped/TODO case, inferred success from source text or empty fallback. Run every nominal leaf exactly once, recording completion only after all actual assertions pass. C/R/F denote actual clock/readiness/loadFacts calls per leaf; other effects are zero. `D`=AuthorityError AUTHORITY_DENIED, `I`=INVALID_CONTEXT, `T`=INVALID_TRANSACTION, `N`=AUTHORITY_NOT_READY, `M`=AUTHORITY_MAPPING_UNAVAILABLE, `P`=identical supplied rejection propagated.

| Group | Exact variants | Expected decision / C,R,F |
| --- | --- | --- |
| A01 valid scope | only | Success, all exact scalar fields/generation/time/minimum expiry/frozen/brand;1,1,1 |
| A02 error constructor | only | Actual AuthorityError.category/name/instance behavior;0,0,0 |
| A03 principal | bad-id,business-login,missing-purpose,extra-key,accessor | I;0,0,0; accessor getter count0 |
| A04 request | bad-org-id,unknown-capability,extra-key | I;0,0,0 |
| A05 transaction | null,number,string | T;0,0,0; no claim that an object is a real session |
| A06 clock | nan,infinity,negative,unsafe,out-of-range | D;1,0,0 |
| A07 clock throw | error,undefined,false | P by identity/value;1,0,0 |
| A08 readiness | false,missing-flag,false-flag,bad-generation | N;1,1,0 |
| A09 readiness rejection | error,undefined,false | P;1,1,0 |
| A10 facts rejection | error,undefined,false | P;1,1,1 |
| A11 captured context | only | Success after deferred readiness/caller mutation; original frozen lookup/same opaque transaction/time forwarded;1,1,1 |
| A12 user | inactive,foreign-id | D;1,1,1 |
| A13 tenancy | membership-tenant,eligibility-actor,organization-id | D;1,1,1 |
| A14 state | organization-suspended,branch-revoked | D;1,1,1 |
| A15 fingerprint | license-number,license-document,unverified | D;1,1,1 |
| A16 lab mapping | only | M for consistent lab-kind/capability context;1,1,1; no lab activation |
| A17 cardinality | missing-member,duplicate-member,missing-proof | D;1,1,1 |
| A18 schema/revision | schema,zero-revision,unsafe-revision | D;1,1,1 |
| A19 time | validfrom-equal,validfrom-future,expiry-equal,created-after-updated | First succeeds, others D; each1,1,1 |
| A20 minimum expiry | only | Success with professional expiry1500/member2000/now1000 and exact expiresAt1500;1,1,1 |
| A21 declared vectors | fingerprint,mapping,grant,verification | Actual serializer/hash equals independent declared UTF-8/hash;0,0,0 |
| A22 canonical order | object-keys,array-order | Same declared serialization/digest under reordering, arrays contain at least2 distinct items;0,0,0 |
| A23 digest | metadata-operation,payload-fingerprint,evidence | D for valid-shape corruption with unchanged checksum;1,1,1 |
| A24 generation | only | D;1,1,1 |
| A25 versions | organization-revision,membership-revision,eligibility-revision | D with valid digests and mismatched current revisions;1,1,1 |
| A26 proof authority | self-grant,self-verification,evidence-version | D with independently valid proof digest;1,1,1 |
| A27 duplicates | decision-id,operation-id | D with valid digest and otherwise consistent references;1,1,1 |
| A28 issued scope | spread-clone,json-clone,prototype-clone,raw-evaluator | Real issued object true; each lookalike false. First3:1,1,1; raw evaluateAuthority object unbranded:0,0,0 |
| A29 facts mutation | only | Issued scalar scope remains unchanged/frozen after source facts mutate;1,1,1 |
| A30 subsequent revocation | only | First resolve succeeds, second denies revoked facts; old scope remains WeakSet-branded;2,2,2. Predicate is not a revocation fence. |
| A31 import boundary | domain-fs,compiler-fs | LINKER_DENIED, no native load or added module evaluation;0,0,0. These two explicit probes are separate from nominal import trace. |
| A32 shape/bounds | facts-extra-key,nested-accessor,empty-branches,over100-branches | D;1,1,1; accessor getter0 |

Use safe now1000ms and the reference data as the base. A19.validfrom-equal may use now100 with consistent current/proof timestamps. Other boundary/positive fixtures must change all dependent fields coherently and retain independently declared serialized proof strings/hashes, so a stale digest or unrelated invalid timestamp does not mask the intended relation. A20 and multi-item ordering fixtures need explicit frozen data. Do not create every checksum with the production function and then treat its own roundtrip as an oracle. Serializers are checked on valid typed fixture data; malformed authorization inputs go through resolve/evaluate.

Freeze exact fixture objects and expected port traces in the reviewed scenario before execution. Only synthetic IDs/URNs/data are allowed. Each port records lookup/time/transaction identity; clock and ports are supplied directly, never provider clients. Normal success/rejection cases must assert call ordering and exact counts, not merely catch any error. Preserve falsy rejection values without `error || fallback`. A denied case after loadFacts has one recorded fake read, not zero.

## Full-copy sensitivity and accounting

Five fixed weakening controls, in order, target ONE negative leaf each. Each source substitution is scoped to its exact original full-file hash and unique literal before standard emit; never modify production or nominal bytes. Freeze actual mutation patches/hashes before the source/invocation review:

| Control | Exact weakened behavior | Required target |
| --- | --- | --- |
| M1 | In rules interval check replace sole `now < d.expiresAt` with true | A19.expiry-equal |
| M2 | Remove currentDecision's one decisionDigest===payloadSha256 check | A23.metadata-operation |
| M3 | In validateMembership only remove organizationId equality, retaining actor/state | A13.membership-tenant |
| M4 | Remove membershipRevision equality in granted-proof/current-member comparison | A25.membership-revision |
| M5 | Replace issuedScopes.has(value) with true | A28.spread-clone |

Nominal graph executes every leaf. Each mutant then uses a fresh complete three-module graph with ONE changed emitted module and unchanged cached nominal emit for the other two. Run only its named target leaf; require its intended assertion to fail, not an import/compile/fixture error. Every graph uses its own actual exported AuthorityError/brand; cross-graph class identity failure is not a detected mutant. Restore a fresh all-nominal graph and require that same target leaf to pass before the next control. Do not count mutant failures as nominal passes.

Accounting is exact: one real compiler initialization;3 nominal standard emissions plus5 mutated-file emissions=8;11 complete domain graphs (1 nominal +5 mutant +5 restoration), each module evaluated once per graph=33 total,11 per module. Nominal denied compiler imports0 and domain require edges exactly rules→types/crypto and service→types/rules; explicit A31 probe denials are counted separately. All counts remain observations to verify, never hardcoded replacements for executed work. Any mismatched import/emit/evaluation/restoration accounting rejects the run.

## Result schema and acceptance

Default role schema is unchanged. Authority child result retains the common fixed fields `runId,role,manifestSha,admissionPassed,egressBlocked,filesystemCanariesPassed,databaseMode,networkAdmission`; role is the authority literal and databaseMode is `not-admitted`. Instead of default calls/scenario, it adds ONLY `authority`:

- `schema:'SD-AUTHORITY-PURE-1'`;
- `sourceHashes` exact three keys and pins above; `compiler:{version,sha256,loads:1,requireAttempts:0,sysAbsent:true}`;
- `emit:{optionsSha256,nominalHashes,mutantHashes,nominalCount:3,mutantCount:5}` with exact module/control keys and64-hex hashes;
- `nominal:{caseIds,passed,failed:0,skipped:0}` with exact unique AUTHORITY_CASE_IDS in execution order and passed equal length;
- `controls` exactly five ordered `{id,target,mutantDetected:true,restored:true}` rows;
- `evaluations:{graphs:11,types:11,rules:11,service:11,total:33}`;
- `effects:{database:0,provider:0,sourceWrites:0,domainNativeImports:0,boundaryProbeRejections:2}`.

The parent adds its existing exact container/directory/image/cleanupAcknowledged fields only after lifecycle verification. It recomputes the network summary, role/file manifest, source/compiler pins, complete IDs/counts/hashes/control rows and absence of default calls/scenario. Keep per-leaf port traces and compile diagnostics as compact bounded raw evidence; final summaries must match those observations. There is no success for skipped or partial controls. Unsupported runtime API, attempted compiler import or emitted graph drift fails before production evaluation/remaining cases.

## Review and execution gates

Two actual independent nonauthor contract decisions precede harness edits. Root separately admits only existing offline fake-executor/shared-harness checks at exact reviewed hashes; these never evaluate the compiler/production modules or contact Docker. Preserve existing default gate cases and verify new role rejects source/profile/size/transport fallback with zero native calls. No new generic framework or root test gate is needed.

After implementation, freeze the clean candidate, all source/tool/fixture/mutation hashes, complete case IDs/traces/schema, environment, endpoint/image, exact one-invocation command and ownership/cleanup readback. TWO actual independent nonauthor source plus **ONE_FIXED_AUTHORITY_PURE_RUN** decisions are required before any container/compiler/production execution. Root records their real provenance and invokes once; no old smoke/preflight receipt grants this run. Capture early exact create identity, before-import admission, actual emits/assertions and both raw streams. Any post-create failure requires review before another attempt, without widening grants, changing compiler or introducing dummy exports.

Independent same-engine/exact-container/workspace absence and unchanged sources precede acceptance. A pass establishes only this complete three-module pure behavior under injected read ports. Mongo adapter/session/index/provenance/qualification/provisioning, HTTP/JWT/Joi, cross-module races, real grants/clinical commands/refund/stock/F1 recovery and release gates remain unproved. Owner delegation does not turn synthetic professional facts into real clinical approval. No code or runtime was executed to author this contract.
