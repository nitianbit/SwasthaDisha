# Controlled TypeDI reset probe in the isolated specialist fixture

11 November 2026. Root candidate for two independent implementation-only reviews.
Baseline c0d1985 (resolve the full commit in inputs.json). This is fixture source
work only. A failed invocation never authorizes another attempt.

## Evidence

Run 10 at source bc3233bb/template 01cd7969 consumed receipt 7243689f and failed
with API_SCENARIOS/SPECIALIST_PROFILE_CAPABILITY_EXCLUDED. Its raw report
2ae585df4e75acc53b7bb1ab44dbbef9685bb8438e27c534a0ddb15247a6cf43, claim,
initial/final archive and both direct failed-run reviews are retained under
output/qa/week2-api-runtime/execution-10/. Root and both reviewers independently
queried the recorded engine and verified exact two-ID absence, empty purpose
filter and workspace ENOENT. They requested changes and approved no retry.

The exact public TypeDI 0.10 source pinned in inputs.json performs a synchronous
value['destroy'] read outside its try during resetServices. The current fixture
calls that reset between phases; its four instantiated excluded-class proxies
permit only constructor and declared methods. A destroy lookup therefore reaches
the same deny() fixed code. This is a strong source inference, not a retained
stack/member/phase or counter observation. Do not infer completion of nominal
90/33, HTTP requests or warning accounting from the failed run. The last accepted
historical API evidence remains 83/27. Preserve both failed runs and all old proof.

## Exact amendment

Only bootstrap.cjs and bootstrap-unit.cjs may change, plus new owned QA under
output/qa/week2-profile-lifecycle-source/. No scenario/README/ports/compiler,
application, package, model, index, permission or resource change is authorized.
The author is not alone and must preserve other workers and the original checkout.
Root owns Git, shared contract, integration and receipts.

Add a private synchronous reset-window flag in createProfileBoundary. Add a
fixture method withContainerReset(reset) that requires a function and a closed
window, opens the window, invokes that callback exactly once synchronously, and
closes it unconditionally in finally. It need not expose the callback return.
Reject reentrancy with a fixed safe fixture code. No promise may extend the
window; the actual call site remains a synchronous owned callback. Do not export
the flag or expose a new scenario/ctx/provider/result capability.

Only during that window, get of the exact primitive property name 'destroy' on
each of the four already pinned excluded-class instances returns undefined.
This explicitly represents absence of a lifecycle hook: no callable, property
mutation, prototype lookup, raw argument retention, TypeDI/native/provider/domain
delegation or effect occurs. It adds no destroy business method. Outside the
window destroy still follows the current deny(name) path and increments the
same private class attempt, excluded and unexpected counters. Symbol keys,
near matches, then/toString/unknowns and all declared business methods retain
existing behavior even inside the window. Existing set/define/delete traps,
registration checks and eight-key immutable lifetime attempt snapshots remain.
No counter/latch resets, swallowed sentinel, generalized metadata whitelist or
suppressed cleanup error is allowed.

Expose only a fixture-loader forwarding method withProfileContainerReset(reset)
to the actual boundary method. In phase(), wrap exactly the existing
Container.of().reset({strategy:'resetServices'}) call with that method and a
synchronous callback. Preserve reset arguments/order, currentMeet phase, server
closed check, loader resetCompiled and all registration/router/listen operations.
Do not open a window around HTTP, imports, router construction or other cleanup.
Other TypeDI destruction/probe behavior remains unadmitted unless separately
identified and contracted. Failed reset propagates its original error after the
window closes; caught forbidden effects remain latched and assertClean rejects.

## Source and builtins-only checks

First retain a real prepatch rejection of the missing reset-window behavior.
Use the actual createProfileBoundary seam and actual loader forwarding, not
copied/evaluated application or TypeDI code. A small handwritten fixture fake
may model the documented typeof destroy/call probe, labelled as a fake. Do not
execute the package on the host or imply that a fake is genuine TypeDI evidence.
All previous 645 fixture units and 49 parser checks must remain; append meaningful
checks covering all four pinned classes and the actual production fixture path:

- Fresh instance constructor and exactly absent destroy inside the window;
  no method/delegate call or counter change. Repeat resets over fresh phases.
- destroy before/after reset denies; failed and nested reset close or retain the
  correct outer window, invoke the callback at most once, and propagate errors.
- Any asynchronous continuation observes a closed window. Throwing callbacks
  cannot leave a window open. The callback return cannot confer reset authority.
- Declared business methods, other unknown/near/symbol reads and all mutations
  still deny inside the window; catch them and require the existing latch check
  to fail. Existing provider/FS/child/static module restrictions remain exact.
- Actual loader forwarding calls the same boundary; source audit pins the one
  actual TypeDI reset call inside that wrapper, in unchanged phase order.
- Meaningful executable weakened fixture variants must fail the new checks:
  missing window closure, permanent destroy exception, broad unknown exemption,
  business-method bypass or swallowed forbidden effects. Keep every initial
  failure and exact weakened source/hash/command/output.

Allowed now: source bytes/Python/JSON/Git readback, CJS syntax, the already bounded
builtins-only fixture tests using the pinned Node and existing read/permission
profile. No application/TypeScript parse/import/evaluation/extraction, Mongoose,
Joi, TypeDI package execution, compiler/npm/Docker/provider/auth/model request or
business helper execution is granted. Source audits must remain valid after
commit/composition with an exact file union and owned QA prefix. Freeze initial
and final candidates, commands, truthful results and all review evidence.

## Subsequent gates

Two independent nonauthor internal Codex implementation-only decisions precede
edits. Root commits/composes the exact two-source union. Two source decisions and
separately scoped one-emission decisions precede a new clean exact source and
exclusive receipt. Preserve the consumed previous receipt by the reviewed
single-link/owned/hash identity and exclusive archive procedure. One new locked
public install/emit uses unchanged preparation/compiler/profile and 123 lock
entries. Review its actual artifact with both independent reviewers: same 2891
file set and 105 source bindings, only bootstrap and runtime-plan sourceCommit/
bootstrap hash may differ. All dependency/97 nominal compiled/33 source variant
bytes, scenario, ports and selected-index/strict/TDZ/library diagnostic evidence
must remain exact. Any unpredicted delta needs review before proceeding.

Only after actual artifact acceptance, two distinct exact one-run decisions,
fresh same-engine readiness and a new exclusive runtime receipt/claim may one
new invocation occur. The 180-second limit, sole owned readonly bundle bind,
network/profile/images/resource/UID/ownership/Node-then-Mongo cleanup are unchanged.
Any failure requires review; no automatic retry. A successful 90/33 result needs
exact cleanup and both postreviews before acceptance. No root C2 adoption, full
Week2/M0/F13/original115, client, owner, production or release acceptance follows.
Medicine/inventory and HR remain separately reviewed source branches; this
contract changes none of them. Claude authentication is deferred without polling.
