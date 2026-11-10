# Application import sandbox candidate

**First approved smoke: FAIL at `de1693e`; cleanup independently verified. Do not retry or change interface/mount/permission/network rules before the required failure review.** [Current diagnostic-candidate review](../../documentation/planning/implementation/APP_NETWORK_DIAGNOSTIC_REVIEW_PROMPT.md); [execution evidence](../../output/qa/m0-a/app-isolation/activation-1/verification.json); [contract and limits](../../documentation/planning/implementation/C3_APP_ISOLATION_CONTRACT.md). The earlier [activation prompt](../../documentation/planning/implementation/APP_ISOLATION_REVIEW_PROMPT.md) is historical at the approved commit.

This candidate prepares one local Docker Desktop container to run a fixed, synthetic scenario and one unchanged production search-escaping helper. It provides no backend startup, database connection or legacy integration admission.

- `app-container.mjs`: owns a fresh filesystem bundle and newly created full container ID; validates the recorded local daemon, image, environment, resource limits and read-only bind before start and removal.
- `app-bundle.mjs`: hashes/validates the fixed six-source-file bundle and admission record. Matching metadata alone never proves resource ownership.
- `bootstrap.mjs`: checks environment, bundle integrity, permissions and loopback-only interfaces before dynamic imports. The rejected HTTP canary is supplementary evidence, not sole proof of network isolation.
- `app-ports.mjs`: records only the seven fixed synthetic requests; no SDK/transport, payment success, funds movement or queue consumer is provided.
- `scenario.mjs`: calls the unchanged `src1/modules/common/utils/queryUtils.ts` helper and records synthetic port requests. This helper is not imported by unit tests.
- `app-image.json`: verified public Node 22.23.4 manifest digest, cached by digest during the single approved smoke. Its JSON observation text is a historical snapshot, not a new grant of authority.
- `app-runtime.json`: the previously observed local Docker Desktop socket/engine profile. It is unrelated to the retained pre-launch server, whose DevOps baseline remains pending.

Run the dependency-free unit gate from the repository root with a clean verified Node invocation:

```sh
UNIT_NODE="$(command -v node)"
env -i TMPDIR=/tmp "$UNIT_NODE" test/foundation/run.mjs
```

The 185 unit cases pass on Node 22.23.4 and 24.19.0, using fake Docker and synthetic text fixtures. Any non-empty test-seam object must own an explicit callable executor, captured once; real transport always uses the committed profile and fixed repository sources. Invalid overrides are rejected before allocation or socket/process access. Real bootstrap, scenario and application imports are excluded. Twenty executable negative canaries plus two synthetic positive controls exercise the runner itself.

`verify_local_admission.py` supplies separate offline companion probes: regular/link bundle identity with owned synthetic files, a copy of the launcher with its entire factory replaced by simulation, and addon permission metadata (no addon loaded). All 20 companion checks pass across the two runtimes, including factory failure/interruption after the captured ID. The controller now synchronously emits the exact create-acknowledged ID/run ID/workspace before its post-create Docker checks; the launcher no longer duplicates that record. This record supports recovery after interruption; it is not ownership proof by itself. [Current offline evidence](../../output/qa/m0-a/app-isolation/revision-2/verification.json) and [candidate contract](../../documentation/planning/implementation/APP_NETWORK_DIAGNOSTIC_CONTRACT.md).

The pending diagnostic candidate records bounded entry kind/flags/state/type and assigned-address evidence before the unchanged assertion. It reads only beneath the existing sysfs grant and uses Node's OS metadata API. Access-denied/unavailable data remain explicit; no `/proc` or new permission grants are added. It does not implement a network-policy repair or prove routes absent. The candidate has not run against Docker.

The single approved invocation cached the exact image through an owned blank Docker config, then failed at `bootstrap.mjs:16` because the sysfs directory listing contained extra entries. The helper/scenario, seven receipts, HTTP canary and subsequent permission assertions were not reached. Extra names alone do not prove inactive or harmless interfaces. The controller cleaned the exact container/workspace; independent same-engine/exact-ID/workspace/label checks confirmed absence. No second container was created.

The controller uses `--pull=never`. The following command is retained as the historical entry point; the consumed approval does not authorize another invocation:

```sh
# POST-CREATE FAILURE: no retry without a new review decision.
env -i /absolute/path/to/verified-node22 test/application/run.mjs unix:///Users/shubham/.docker/run/docker.sock
```

For any future specifically approved run, use a clean checkout of that newly approved commit and verify its source hashes plus the production-helper hash. Through a fresh blank Docker configuration on the recorded engine, cache only the pinned digest and record its image ID/RepoDigests. Record zero existing application-isolation labels before create; listing by label is diagnostic only. Capture stdout and stderr, including the early exact-ID/workspace record.

The launcher must report a successful exited container, all required assertions and recording receipts, then acknowledged cleanup. Independently verify the same engine, exact returned container ID absent, workspace absent and zero application-isolation labels. An interruption or unknown create acknowledgement is UNRESOLVED. The printed ID is not enough to authorize removal: revalidate engine, name, labels and the controller's full current ownership/configuration checks before any exact-ID recovery. An ownership/configuration loss preserves an explicit cleanup exception; do not adopt resources by label or prune broadly. Unit-only intentional exceptions are contained in the unit runner's owned temporary parent and involve no real Docker resources.

No root package/lock/start/source changes, full C3 acceptance, domain-scenario passes, production deployment or 100 RPS evidence are implied.
