# M0-A foundation unit gate

This F01 unit gate runs dependency-free filesystem admission, MongoDB fixture-controller and application-sandbox controller/protocol tests. All Docker responses and application bundles are simulated in this gate; it does not import the application, contact Docker or MongoDB, admit a database URI, or run the pharmacy/API suites. A separate [real fixture smoke check](../mongo/README.md) verifies the controller against local Docker.

Use Node 22.13 or later. Resolve the executable before clearing the environment:

```sh
FOUNDATION_NODE="$(command -v node)"
env -i TMPDIR=/tmp "$FOUNDATION_NODE" test/foundation/run.mjs
```

The runner:

1. Creates a fresh temporary workspace with in-memory ownership, directory identity and a per-run marker. A supplied path, copied marker or matching database name cannot confer ownership.
2. Copies eleven approved regular files: the existing four foundation/MongoDB files, application controller/protocol/recording-port modules and their two tests, plus public image/runtime profile JSON. The fixed list is in `run.mjs`. Application bootstrap/scenario files and `src1` are not staged. No application, `.env`, credentials or `node_modules` are staged. It checks for unexpected files and symlinks before executing the child.
3. Constructs a fresh child environment instead of forwarding the shell's configuration. Resource/preload/provider overrides are rejected by the preflight.
4. Runs four fixed test entries with filesystem reads/writes limited to the owned workspace. Child processes, workers and native addons receive no permissions; both unit controllers use fake executors. A bootstrap assertion proves that a pre-existing symlink is denied before the test entries run.
5. Returns failure for test failure, cancellation, skips, TODOs, any empty entry, timeout or abnormal exit. Node's passing empty-file fallback is rejected for each required entry. Cleanup requires the original ownership evidence and touches only that workspace.

Node and macOS can add test-worker/text-encoding metadata after process creation; the tests distinguish these observed runtime fields from the exact environment supplied at launch. They do not allow operational configuration through the parent preflight.

## Boundary and remaining work

This is a filesystem/environment guard for reviewed unit code, not a security sandbox for hostile JavaScript. Node 22's permission model does not provide a network-denial boundary. No application/database-driver/provider clients are included in this staged suite. The fixture module's real Docker executor is not used by the unit tests and cannot spawn Docker with the child's permissions. Application/integration tests must still wait for provider/file stubs and their own pre-import admission proof; this unit gate and the separate MongoDB smoke check cannot authorize them. [Official Node permission model and limitations](https://nodejs.org/docs/latest-v22.x/api/permissions.html).

The existing `npm test` placeholder and legacy integration entry points are unchanged. Do not treat this command as M0 acceptance, a production start check, database-library compatibility evidence or a replacement for required domain regressions. Startup/package/dependency edits remain gated on Review-B C2 and the separate compatibility decision.

Node 22 uses `--experimental-test-isolation=none`; later versions retain the alias. Running tests in one child process avoids granting that child permission to spawn more test workers. [Node 22 test-runner flag](https://nodejs.org/download/release/v22.23.0/docs/api/cli.html#--experimental-test-isolationmode).

## Application-sandbox activation gate

The amended unit gate passes 161 cases on Node 22 and Node 24. Non-empty application test seams require an explicit callable executor before any workspace allocation or Docker access. The prior 127-case artifacts remain historical evidence at `00f30fc`; revised evidence lives under `output/qa/m0-a/app-isolation/revision-1/`. These results do not execute `test/application/bootstrap.mjs`, its scenario, the real Docker adapter or application modules. The application sandbox is a review candidate; read its [contract](../../documentation/planning/implementation/C3_APP_ISOLATION_CONTRACT.md) and [activation-review prompt](../../documentation/planning/implementation/APP_ISOLATION_REVIEW_PROMPT.md) before the first real run. The MongoDB controller is unchanged. Earlier frozen fixture snapshots are historical evidence at their recorded commits; this slice intentionally updates the standalone unit runner/preflight.
