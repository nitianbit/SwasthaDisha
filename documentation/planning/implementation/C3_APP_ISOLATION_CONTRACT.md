# C3 application import sandbox: activation contract

**10 November 2026. READY FOR REVIEW; real activation NOT RUN.** Branch `m0/f01-app-isolation`, base `555bec4b4729fb14487bcfc48c40c53b6f85421f`. This is the next bounded F01/C3 slice after static compatibility investigation. The requested review covers a first isolated smoke only, not backend startup or full C3 acceptance.

## Scope and authority

Actor: the local test-harness operator, using the recorded Docker Desktop profile. Input: only its explicit Unix endpoint. No supplied image, directory, container ID, DB URI or real-provider payload is accepted. Trusted test seams supply fake transports/text/profile only to unit tests; they are not authority for real admission.

The target profile is checked against the independently recorded earlier local engine ID before create. It is an allowlisted target, not ownership proof. Resource ownership requires the fresh filesystem identity held in memory and the full ID acknowledged by this create operation, plus current daemon/labels/configuration checks. A copied marker/manifest, matching name or existing container is insufficient.

The old MongoDB fixture contract is unchanged. Its no-host-mount rule remains true for that controller. This new candidate proposes exactly one **read-only bind of a newly owned, sanitized six-file bundle**, never the repository, home, credentials, clinical documents or Docker socket. This exception is part of the review scope. [Docker bind-mount behavior](https://docs.docker.com/engine/storage/bind-mounts/).

## Admission and lifecycle

1. Snapshot the input once. Reject operational/Docker/preload overrides and non-profile endpoints before Docker calls. Load only fixed regular source files, bound as text. Create a fresh temporary directory, run marker, bundle inode identity and empty Docker auth configuration; capture source hashes and a manifest.
2. Use explicit socket/config and clean subprocess environment. Read the known Linux engine and cached pinned image; verify image ID/digest, platform, no inherited volumes and only approved image environment fields. No implicit image pull or login.
3. Create one uniquely named/labelled container; capture its full ID privately. Network none, read-only root, UID/GID 1000, no capabilities/privilege/devices/host namespaces, bounded memory/CPU/PIDs, disabled healthchecks/log retention, one exact read-only private bind, and bounded tmpfs /tmp are required.
4. Before start, revalidate filesystem identity/source hashes and current daemon/container identity, image, command, environment, declared/effective mounts, networks and resource/security limits. Drift prevents execution. Kernel/network/mount behavior remains unverified until the first real run.
5. Node runs with filesystem reads limited to /workspace and the interface-name directory /sys/class/net, writes limited to /tmp, and no child/worker/addon grants. Bootstrap validates expected environment, manifest and source files, loopback-only interface names and denied filesystem/process capabilities before dynamic scenario imports. A documentation-address HTTP rejection supplements the parent network-none and in-container interface checks. [Docker none networking](https://docs.docker.com/engine/network/drivers/none/), [Node permission limits](https://nodejs.org/docs/latest-v22.x/api/permissions.html).
6. Install recording ports before importing the scenario. The only production code proposed for execution is the unchanged search-escaping helper, using Node's built-in type stripping; no decorators, aliases or whole TypeScript backend support is implied. [Node type stripping](https://nodejs.org/docs/latest-v22.x/api/typescript.html).
7. Require the captured container to have exited with code zero and no OOM, plus matching run/role/hash, observed loopback-only interfaces, assertions and seven unique configured recording receipts. The role is explicitly no-database; a field declaring it is not a measured DB transaction result. Recording receipts have status recorded/effect false and cannot certify successful payments or domain effects.
8. Revalidate current resource/config identity before removing only that ID. After acknowledged removal, remove only the original owned workspace. Duplicate successful cleanup is idempotent; a workspace-cleanup retry does not re-adopt a removed container. Unknown creates/IDs or post-create admission failures retain an explicit unresolved resource/workspace exception. Before-create failures clean their exact new filesystem allocation.

The daemon/host and reviewed code are trusted infrastructure; this is not a malicious-code sandbox. Read-only host files can still be altered by a trusted host process; hashes are rechecked at the relevant boundaries. No operational resource is a fallback.

## Executed evidence versus pending proof

- **Executed:** 127 dependency-free unit cases pass on Node 22.23.4 and 24.19.0. Docker and application bundles are simulated. They cover ownership, environment/source/mount/network/limit drift, false evidence, exit/OOM states, unknown operations and ambiguous create handling.
- **Executed:** two positive runner controls and twenty expected negative rejections cover four independent empty entries, all-empty, failure/skip/TODO, source symlink and bypassed preflight on both runtimes.
- **Read-only metadata:** the public Node image index digest was verified against its response bytes. The local runtime profile references previous committed engine observation.
- **NOT RUN:** image pull, any new real Docker call/container, bootstrap/scenario execution, production-helper runtime import, real network/interface/permission/mount assertions, and real cleanup readback for this candidate.

## Retained gates and requested decision

Review **APPROVE FIRST ISOLATED SMOKE / REQUEST CHANGES / HOLD**. Approval, if granted, covers only public image caching on the recorded local profile, the fixed synthetic/no-DB smoke and exact-ID/workspace cleanup verification. First-run infrastructure failures remain failures; adjust neither mount/permission/network grants nor scope silently.

The owner retains the existing pre-launch server. [DevOps facts](DEVOPS_BASELINE_REQUEST.md), supported root dependencies/build/start and C2 adoption remain pending. Legacy pharmacy/API suites, real Mongoose/DB sessions, SDK adapters, background jobs, financial/clinical/stock correctness, full C3, M0 acceptance and 100 RPS remain outside this activation. The selected 115-scenario register is unchanged.
