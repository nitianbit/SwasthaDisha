# Application import sandbox candidate

**Amended review pending. The supplied REQUEST CHANGES verdict governs; an earlier conditional approval at `00f30fc` does not authorize this revision. Do not cache the image or activate the real launcher until the amended commit and hashes are approved.** [Review prompt](../../documentation/planning/implementation/APP_ISOLATION_REVIEW_PROMPT.md); [contract and limits](../../documentation/planning/implementation/C3_APP_ISOLATION_CONTRACT.md).

This candidate prepares one local Docker Desktop container to run a fixed, synthetic scenario and one unchanged production search-escaping helper. It provides no backend startup, database connection or legacy integration admission.

- `app-container.mjs`: owns a fresh filesystem bundle and newly created full container ID; validates the recorded local daemon, image, environment, resource limits and read-only bind before start and removal.
- `app-bundle.mjs`: hashes/validates the fixed six-source-file bundle and admission record. Matching metadata alone never proves resource ownership.
- `bootstrap.mjs`: checks environment, bundle integrity, permissions and loopback-only interfaces before dynamic imports. The rejected HTTP canary is supplementary evidence, not sole proof of network isolation.
- `app-ports.mjs`: records only the seven fixed synthetic requests; no SDK/transport, payment success, funds movement or queue consumer is provided.
- `scenario.mjs`: calls the unchanged `src1/modules/common/utils/queryUtils.ts` helper and records synthetic port requests. This helper is not imported by unit tests.
- `app-image.json`: verified public Node 22.23.4 manifest digest. No image pull has been performed for this slice.
- `app-runtime.json`: the previously observed local Docker Desktop socket/engine profile. It is unrelated to the retained pre-launch server, whose DevOps baseline remains pending.

Run the dependency-free unit gate from the repository root with a clean verified Node invocation:

```sh
UNIT_NODE="$(command -v node)"
env -i TMPDIR=/tmp "$UNIT_NODE" test/foundation/run.mjs
```

The 161 unit cases pass on Node 22.23.4 and 24.19.0, using fake Docker and synthetic text fixtures. Any non-empty test-seam object must own an explicit callable executor, captured once; real transport always uses the committed profile and fixed repository sources. Invalid overrides are rejected before allocation or socket/process access. Real bootstrap, scenario and application imports are excluded. Twenty executable negative canaries plus two synthetic positive controls exercise the runner itself.

`verify_local_admission.py` supplies separate offline companion probes: regular/link bundle identity with owned synthetic files, a copy of the launcher with its entire factory replaced by simulation, and addon permission metadata (no addon loaded). All 16 checks pass across the two runtimes. The launcher emits the exact created ID/run ID/workspace to stderr before execution. This record supports recovery after interruption; it is not ownership proof by itself. [Revised evidence and dispositions](../../output/review/app-isolation/revision-1/DISPOSITION.md).

After approval only, cache the exact public image using an owned blank Docker configuration and the approved local endpoint. The controller uses `--pull=never`. The proposed activation command is:

```sh
# REVIEW PENDING: this is not an instruction to run before approval.
env -i /absolute/path/to/verified-node22 test/application/run.mjs unix:///Users/shubham/.docker/run/docker.sock
```

Before that approved run, use a clean checkout of the newly approved commit and verify every revised source hash plus the production-helper hash. Through a fresh blank Docker configuration on the recorded engine, cache only the pinned digest and record its image ID/RepoDigests. Record zero existing application-isolation labels before create; listing by label is diagnostic only. Capture stdout and stderr, including the early exact-ID/workspace record.

The launcher must report a successful exited container, all required assertions and recording receipts, then acknowledged cleanup. Independently verify the same engine, exact returned container ID absent, workspace absent and zero application-isolation labels. An interruption or unknown create acknowledgement is UNRESOLVED. The printed ID is not enough to authorize removal: revalidate engine, name, labels and the controller's full current ownership/configuration checks before any exact-ID recovery. An ownership/configuration loss preserves an explicit cleanup exception; do not adopt resources by label or prune broadly. Unit-only intentional exceptions are contained in the unit runner's owned temporary parent and involve no real Docker resources.

No root package/lock/start/source changes, full C3 acceptance, domain-scenario passes, production deployment or 100 RPS evidence are implied.
