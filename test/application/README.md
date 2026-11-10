# Application import sandbox candidate

**Review pending. Do not activate the real launcher until the scoped review approves its first smoke run.** [Review prompt](../../documentation/planning/implementation/APP_ISOLATION_REVIEW_PROMPT.md); [contract and limits](../../documentation/planning/implementation/C3_APP_ISOLATION_CONTRACT.md).

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

The application cases use fake Docker and synthetic text fixtures. Real bootstrap, scenario and application imports are excluded. Twenty executable negative canaries plus two synthetic positive controls exercise the runner itself.

After approval only, cache the exact public image using an owned blank Docker configuration and the approved local endpoint. The controller uses `--pull=never`. The proposed activation command is:

```sh
# REVIEW PENDING: this is not an instruction to run before approval.
env -i /absolute/path/to/verified-node22 test/application/run.mjs unix:///Users/shubham/.docker/run/docker.sock
```

The launcher must report a successful exited container, all required assertions and recording receipts, then acknowledged cleanup. Independently check the exact returned container ID and workspace are absent. An unknown create acknowledgement or ownership/configuration loss preserves an explicit cleanup exception; do not adopt resources by label or prune broadly. Unit-only intentional exceptions are contained in the unit runner's owned temporary parent and involve no real Docker resources.

No root package/lock/start/source changes, full C3 acceptance, domain-scenario passes, production deployment or 100 RPS evidence are implied.
