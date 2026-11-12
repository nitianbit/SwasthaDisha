# Customer enrollment — focused executable verification contract

13 November 2026. Author: internal Codex `/root/milestone_composition_r9`. DRAFT FOR TWO INDEPENDENT NONAUTHOR REVIEWS. This document permits preparation of the named test candidate after contract review; it does not authorize a compiler, package install, container or application invocation. Root freezes each exact preparation/run candidate and obtains the workflow's actual bounded decisions before execution. The author cannot approve this contract or its authored test implementation.

## Result and honest boundary

Verify C3 at actual `AuthService.sendOTP` and `AuthService.verifyOTP`, calling the actual Joi-backed `selectCustomerLoginContact`. This is one focused service run in the existing owned Node/no-network fixture, with eleven explicitly replaced constructor dependencies. It must exercise a useful new-phone/new-email enrollment and login sequence, meaningful denied operations and actual-source defect controls. Pure selector tests, source-string checks and rewritten miniature service implementations do not establish this result.

Successful evidence establishes actual service selection, save payload shape, destination dispatch, current-row OTP binding, signing and unchanged staff branch behavior under recording ports. It does not establish HTTP/controller behavior, MongoDB storage/uniqueness/transactions, actual OTP consumption/expiry, TypeDI dependency resolution, provider delivery, deployed security, clean project typecheck or the full contact-change milestone. Those remain separately visible. The new customer contact contract is `CUSTOMER_CONTACT_CHANGE_CONTRACT_DRAFT.md` SHA `8826f45a11651dc117ccb3119b6b9093405889324545a1679cf2efe8630e387a`; only its C3 enrollment sub-slice is tested here. The design's remaining identity migration, purpose/generation, session revocation, index/backfill and activation gates are retained.

Source baseline is `99cc098ede0a3cb1124f294ef4c9b660b8d9f61d`; production candidate is `e6334e8767ab4384e2e85e5540d5952024c8bee5`. Later approval/evidence commits do not change these source pins. Use the original baseline AuthService for the old-source counterfactual; never overwrite the candidate checkout.

## Reuse and owned files

Reuse the fixed-source manifest, owned-directory identity, exact Docker endpoint/engine/image, read-only bind, environment, permission/network pre-import admission, bounded executor and identity-checked cleanup of `test/application/{app-bundle,app-container,bootstrap}.mjs`. Extend them with exactly one fixed role, `customer-enrollment-service`, and no caller-selected source/command/image/options/URI. Existing role branches and their accepted evidence remain unchanged. Reuse the AST/emitted-require audit and scripts-disabled dependency-preparation mechanisms of `test/api-runtime/scenario/{compile.cjs,prepare.py}` as narrowly copied mechanisms, not their old source-count/model/package admission. Their old fixed roles cannot admit this new one unchanged.

New test ownership after review is only `test/customer-enrollment-runtime/{README.md,profile.json,package-plan.json,prepare.py,emit.cjs,scenario.mjs,ports-plan.json,run.mjs}` and the three existing application files above for the fixed role. Root owns exact evidence under `output/qa/customer-enrollment-focused/` and shared integration/progress. No production/package/lock/start/provider/index/Mongo controller changes. No new generic test platform, application DI registry or global control plane.

The role bundle has a closed named-file set: existing `app-bundle.mjs`, `app-ports.mjs`, `bootstrap.mjs`, fixed `package.json`; new role `scenario.mjs`, `ports-plan.json`, `emitted-modules.json`, `runtime-modules.json`. The two JSON maps contain immutable source data, not serialized functions or filesystem paths to import. `emitted-modules.json` includes the exact nominal, baseline and four control whole-module emissions. `runtime-modules.json` contains only the audited transitive CommonJS file closure of the four packages below. Their exact file keys/lengths/hashes are frozen by preparation before run review. Each map is at most 8MiB, 512 entries, and each entry at most 1MiB; the total staged bundle is at most 12MiB. Other files retain existing limits. No arbitrary recursive directory staging, unexpected files, symlinks, native addons, executables, host node_modules or implicit package discovery.

## Actual code and compiler closure

The following complete actual modules are compiler inputs; none may be extracted, rewritten, mocked or copied into a test implementation:

| Path | SHA-256 |
| --- | --- |
| `src1/modules/auth/services/index.ts` | `c522444ef80133c136a50d276ae64cdbaca8333049cca9723ff36d9f20bf3c48` |
| `src1/modules/auth/validation/index.ts` | `752f049481df9de2587c386f8c44e5dc1548073295f36149a3974a3a9513af4c` |
| `src1/modules/auth/types/index.ts` | `f6cbff24776d23b029244526d07d6a9af290aec66020d414469388c6f11118e9` |
| `src1/modules/common/types/index.ts` | `63ad3821027150d368e993903e954b4a80b776ff223caf322c104008239d4cbd` |
| `src1/modules/common/types/error.ts` | `3f69860897913c1d8467e3f8aaca7d083e9d50a841553adce33ec6421a0fda07` |
| `src1/modules/common/types/response.ts` | `44c5dbcf38ea117eaa13f3a715143ea147a7abf25c3491b61817e67b5f3d6f93` |

Compile whole modules with separately installed, integrity-locked TypeScript5.9.3 using `createProgram`/`emit`, CommonJS, ES2022, esModuleInterop, experimentalDecorators and emitDecoratorMetadata, sourceMap/declaration false; no source transformations, `transpileModule`, app evaluation or constructor invocation during preparation. Root must freeze the exact compiler options, all compiler-read files and returned diagnostics. `noEmitOnError:false` may be used for this source-only emission, with a closed compiler host serving only these six modules and exact compiler standard libraries. External type-only imports and port class declarations are not resolved to the real repositories/models. Any resulting missing-type/declaration diagnostics must be individually recorded and reviewed; emit is never called a successful typecheck. Unexpected source reads/imports/diagnostics halt preparation. The emitted runtime edge auditor must prove all type-only edges are absent and every remaining require belongs to the exact cuts, actual selected modules or audited package closure. Do not expand into Mongoose/models/SDKs to silence a diagnostic.

Prepare controls as four reviewed, unique AST-targeted edits to copies of actual source. Freeze their input/output hashes and exact source patches before emission; reject zero or multiple edit matches. Emit each complete mutated module under identical options and audit each emitted graph. Original source and emitted nominal artifacts remain immutable. No runtime eval of snippets supplied by a scenario, source-regex pass predicate or source-hash mismatch is an acceptable defect detection.

## Dependencies, synthetic configuration and exact runtime cuts

The only package roots in the runtime are Joi17.13.3, jsonwebtoken9.0.2, reflect-metadata0.2.2 and typedi0.10.0, with the complete exact transitive file/require closure frozen from a reviewed generated lock. TypeScript5.9.3 exists only in the separate preparation workspace. No runtime Express, dotenv, axios, mongoose/MongoDB driver, moment, cloud client, provider SDK or application config. New test-only package metadata does not change the application dependency graph or adopt a production runtime.

Follow the existing separate resolve-lock then install/emit preparation stages: exact scripts-disabled public dependency resolution produces a lock; Root reviews it before any `npm ci --ignore-scripts --omit=optional` in a new owned empty workspace. Do not silently download, use `npx`, reuse arbitrary cache/host node_modules, or install dependencies while running the scenario. Freeze dependency versions, tarball integrity, exact regular-file inventory and emitted JSON maps; deny symlinks, native addons, scripts/bin execution and unlisted file reads. Cache existence is not artifact availability or integrity. Each new executable preparation step requires its exact bounded review and one consumed receipt; old preparation receipts are not reusable.

Load actual reflect-metadata before actual TypeDI-decorated service. Instantiate the actual class directly, in its existing constructor order, with these eleven recording objects. Each corresponding runtime class import resolves to a named inert placeholder class, never the real module:

1. `@/modules/user/repository` — UserRepository.
2. `@/modules/admin/repository` — AdminRepository.
3. `@/modules/hr/repository` — HRRepository.
4. `@/modules/specialists/repository` — SpecialistRepository.
5. `@/modules/pharmacies/repository` — PharmacyRepository.
6. `@/modules/corporates/repository` — CorporateRepository.
7. `@/modules/otp/services` — OTPService.
8. `@/modules/wallet/services` — WalletService.
9. `@/modules/notification/services` — NotificationService.
10. `@/modules/email/services` — EmailService.
11. `@/modules/sms/services` — SMSService.

The twelfth cut is `@/config/config`: a frozen fixture-only CONFIG containing only a fresh in-memory JWT secret and OTP_EXPIRY_MINUTES10. No actual config, dotenv, credential, .env or service account is read. Obtain the secret through admitted native crypto, keep it private, and destroy references after the run. Retain native crypto `randomInt`; a counting facade may call the real function, without replacing its result. Real jsonwebtoken must sign and verify each positive token under the fixture secret; validate claim identity/role and 30-day expiry privately. Never print tokens, codes, the secret, addresses or synthetic row bodies.

Recording repositories expose only methods actually reached by these fixed scenarios. User lookup/save/update use a private synthetic row map, capture the exact own-key save payload and produce explicit controlled rows; they are not a simulated Mongo/Mongoose implementation. Staff repositories expose actual corresponding find/save methods. Corporate and every unplanned method latch failure. OTP create/verify record exact call arguments and controlled proof outcomes; generated OTP is private and must agree across create/message/verify within each positive fixture. Wallet and notification ports record intent. Email/SMS ports record exact selected recipient/template intent; they do not prove actual template rendering or provider behavior. An unexpected port access/call is a final latched failure even if production catches the thrown error. Captured console messages must be bounded/sanitized; a notification failure cannot hide an unplanned dependency call.

A closed in-memory CommonJS linker serves only these maps/cuts and exact package resolution entries. Freeze allowed builtin edges from the actual closure before approval: crypto/buffer/stream/util/events/string_decoder may be admitted only if required and audited. Application/package code cannot receive generic host require, module/createRequire, fs, net, tls, http, https, dns, child_process, workers or addons. Dynamic/unknown requires fail before import. Use existing trusted bootstrap filesystem/VM capabilities solely to validate and load the immutable bundle; a VM linker is not claimed as a hostile-code sandbox. Linux network isolation remains the independent egress barrier.

## Environment, resource and effect admission before first domain import

Use existing fixed Node22.23.4 arm64/Linux image `node@sha256:5ec23b7c622b00547753bc6ffd78085dd868a68aeb41c8e0a1418f033e13d96d`, endpoint `unix:///Users/shubham/.docker/run/docker.sock`, engine `16ab25f6-88c7-4687-a431-b119b6ab9319`. Keep `--pull=never`, network none, read-only root/bind, nonroot1000:1000, cap-drop ALL, no-new-privileges, memory512MiB, CPU1, pids64, tmpfs64MiB/noexec/nosuid, no healthcheck/log driver, existing permissions and bounded command/executor/cleanup. No published ports, listener, database, mounted socket, host service or provider credentials in the child. One owned Node container only; no Mongo container/network/volume. Keep the existing twenty-second executor bound; if it is insufficient, report the failed/unfinished result and obtain a reviewed change rather than relaxing it at runtime.

Use the exact existing constructed child environment allowlist (PATH, NODE_VERSION, YARN_VERSION, HOME, HOSTNAME, NODE_ENV, APP_RUN_ID, APP_ROLE, APP_MANIFEST_SHA), NODE_ENV=test, fixed role, and fresh run identity. No inherited preload, NODE_OPTIONS, provider/application variables or alternate URI. Before loading the scenario/domain/package maps, verify exact manifest/files/role/runtime/cwd/environment, existing filesystem deny canaries, permission flags, loopback-up/other-devices-down admission and egress canary failure specifically ENETUNREACH. Preserve control-file handling and diagnostics. A canary/admission failure produces no domain import and is not a skipped successful test. No writes to production/worktree except Root's public safe evidence; private fixture data lives only in owned temporary storage and memory.

## Fixed arrange–act–assert scenarios

Create fresh module caches/TypeDI metadata/ports/state per nominal/control phase; each case starts with explicit fresh rows and expected exact call order/arguments. Call the actual service, not a scenario reimplementation. Validate local random-code equality and token validity before reducing nondeterministic data for trace comparison. No patient or operational data.

| Group | Arrange and act | Required behavioral assertions |
| --- | --- | --- |
| C3-01 | No row, phone-only customer SEND then successful VERIFY | Lookup/save/OTP/SMS use the one admitted phone; save has no own email key; exactly one save, intended six-digit OTP and no email; verify yields matching customer claims, expected update/wallet/notification intents. |
| C3-02 | No row, mixed-case/outer-space email-only direct customer SEND then VERIFY | Canonical email only at lookup/save/OTP/email; no own phone key or SMS. Successful signed claims and expected customer intents. |
| C3-03 | Existing phone/email customer, including an existing legitimate secondary alias | No signup save or alias append; dispatch only selected destination. Response may retain existing row aliases; this is not a legacy-ownership certification. |
| C3-04 | Single contact with the other property explicitly undefined, SEND and VERIFY | Valid controller-shaped direct input; no rejection and no unselected property in signup payload. |
| C3-05 | Both valid contacts defined, SEND and VERIFY independently |400 VALIDATION_ERROR before all eleven port calls, crypto generation, signing, updates, notices and provider intent. Empty recording state is checked, not only error text. |
| C3-06 | Neither contact; null/array/object/number/empty/invalid phone or email; verify OTP absent/null/number/object | Each invalid direct request with userType=user returns400 before lookup or every later effect. Freeze vector table in candidate; explicit undefined is distinguished from null. Non-object selector calls are checked separately; do not claim service null input is400 if the service dereferences it first. |
| C3-07 | Controlled returned current row has changed selected value; another fixture has missing selected value | OTP verification uses the actual returned current normalized row value, not caller value or alternate alias. Missing value gives OTP_UNAVAILABLE before OTP/update/wallet/sign. This is dataflow evidence, not a real DB concurrency proof. |
| C3-08 | Lookup not found; separately OTP verify throws a fixed AppError | USER_NOT_FOUND or exact proof failure propagates; no later customer update, wallet, notice or JWT. No signup in VERIFY. |
| C3-09 | Admin/HR/specialist/pharmacy, existing active rows; phone-only/email-only/both request shapes | Actual candidate and baseline produce equivalent safe ordered port traces/response role claims, after privately validating code/token then normalizing their values/times. Both-contact legacy preference stays unchanged outside customer role. |
| C3-10 | Staff missing/inactive rows and specialist/pharmacy signup branches | Baseline/candidate equivalence for each supported branch and error; no invented authorization guarantees. Preserve actual preexisting staff signup payload behavior even where it permits both contacts. |
| C3-11 | Actual Joi selector direct positives/negatives and unknown extra harmless input | Confirms customer-only XOR/strict primitive values/canonical email/shared OTP rules and unchanged generic schemas. Whole-service groups remain required; helper success alone cannot pass the run. |

Record case IDs individually; any missing vector, skip/TODO, empty phase, unexpected call, swallowed latch, timeout, unresolved dependency, invalid token or process failure fails the run. Exact vector count is frozen in scenario/descriptor before approval, not invented from this draft. Public evidence contains IDs/counts/hashes and bounded reasons, not codes/tokens/record contents.

## Defect controls: same predicates, concrete alternate effects

Run an immutable baseline-source counterfactual plus these four source controls, in fresh fixture state. Do not treat an exception/loader/hash failure as detection. Each must reach the intended altered actual service behavior and fail its named nominal assertion; preserve a bounded safe finding containing case ID, control ID and failed predicate.

- OLD: actual99cc098 AuthService with baseline validation, two genuinely defined aliases A/B. The recording map receives both in new-user save, dispatches only A, then successful A proof returns a token containing B. This demonstrates prior service payload/dataflow, not actual Mongo/provider exploitation. Candidate C3-05 rejects the same request without effects.
- NC1: change only customer schema `.xor('phone','email')` to `.or(...)`. C3-05 actual service reaches lookup/OTP/send; zero-effect denial must fail. Shared staff schemas are untouched.
- NC2: bypass only SEND's call to the actual customer selector, restoring its raw fallback path. C3-05 SEND reaches a concrete lookup/create/send; direct helper tests still pass, proving service coverage matters.
- NC3: bypass only VERIFY's selector, leaving helper and SEND correct. C3-05 VERIFY reaches a concrete lookup/proof/sign path; the zero-effect predicate fails.
- NC4: restore the old raw `{phone:data.phone,email:data.email,...}` new-user contact fields while leaving selector admission correct. C3-01/02/04 detect an unselected own key even if its value is undefined. This control proves save payload minimization, not a two-valued persistence exploit by itself; OLD supplies the two-valued counterfactual.

Fresh restored nominal phase must pass after controls. Baseline/control differences and all unexpected outputs are privately checked; evidence may not claim4or5 successful controls merely because five child processes exited nonzero. The candidate descriptor identifies each actual source edit and failing behavioral assertion. No blanket security/mutation score claim.

## Current evidence and next gates

Historical accepted broad auth API evidence is `output/qa/week2-api-runtime/execution-11/REVIEW.md`:90groups/33controls at source `5901bc20e8def58f023b9ef4fe43c8e80fec1f1e`, descriptor `0753c30bcf7a1a46eff1abad69009b070d848e5090aab6435270897010c5ed50`. Its consumed approval does not run or prove C3. Historical `emission-14/REVIEW.md` records97TS/76reachable/13models and broader diagnostics, not a clean typecheck. The historical runtime path `/private/tmp/sd-auth-api-build-36d0c87d-59bb-4742-9615-4c933aeb7acb/runtime`, current `test/api-runtime/scenario/runtime-template.json`, and old `/private/tmp/m0-node22/node` were read-only observed absent. Host Node24.19.0 tool exists but was not executed for this draft. No usable dependency closure is claimed.

Root's current read-only Docker readiness record `output/qa/customer-enrollment-contact/READONLY_DOCKER_READINESS.json` SHA `dcfe7f0f32fa5920f2cc11100c7c65cd25e2a4b628efe6d3a562c638aa728a2a` records exact engine reachable and fixed image cached arm64/Linux, no create/start/pull/run, and no run authorization. Rebind current endpoint/engine/image before the reviewed invocation; historical/read-only readiness does not waive pre-import admission or supply new-source evidence.

Sequence: two nonauthor contract decisions; implement only named test candidate; source review and exact lock-resolution preparation vote; review exact produced lock then separately bounded scripts-disabled install/emit; review actual emitted source/package/port closure, diagnostics, fixture-role changes, nonempty scenario/control list and frozen invocation; obtain two actual nonauthor one-invocation decisions; run once and preserve result/cleanup; independently review actual output and disposition before marking focused C3 verification passed. Stop only dependent execution on a mismatch; no automatic rerun, install, profile repin or adoption. Fake controller/loader checks may be prepared and separately admitted without claiming real-domain results.

All new compiler/runtime/Joi/service/control/container checks are NOT_RUN at draft freeze. Do not mark the full contact feature, HTTP migration, production exposure, final integration or release complete from this service result. C2/C3, owner/clinical/security/release requirements and deferred modules remain as recorded. Codebase Memory MCP remains disabled; original six staged changes and handover archive are outside ownership and preserved.

## Reuse context pins

These are read-only reuse context, not an executable closure or permission to run old profiles:

| Path | SHA-256 |
| --- | --- |
| `test/application/app-bundle.mjs` | `993634db7d05213208ddda434d8d4c21f679ae342f46a1836dda115c7d3b5817` |
| `test/application/app-container.mjs` | `4c2a061a45a30478d4fc04d6cd28bb88aa2fd679e4346136b7714f29142948aa` |
| `test/application/bootstrap.mjs` | `b9016bbddd345ed562e7820ae391f96180397a6ae84c20fc92c1d36a74467b4c` |
| `test/application/app-runtime.json` | `e4e0b67677e084dce5d65d958763057c5ca1b257232b5f007545a327fb40f0b3` |
| `test/application/app-image.json` | `4f1390608939a823788010499cc810801d01fd8ee44248da5424776c816a8611` |
| `test/api-runtime/scenario/compile.cjs` | `8d25c7d7c8291fd02b179750dd761db4129750043c3501eb02ea0f759bfa1b6f` |
| `test/api-runtime/scenario/prepare.py` | `39b4085370a09a34069b9f1c4f45cfd8fa38a3a1f0e380abcef9c469a5add598` |
| `test/api-runtime/scenario/package-plan.json` | `d7830a9ce688235bb64f3f9f7ac3d5dd604bb63641cdae97b8b7250bfd957227` |
