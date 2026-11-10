# C3 disposable MongoDB fixture contract

**10 November 2026. Bounded F01 infrastructure increment, before application integration.** This implements the resource-ownership part of C3 without changing application dependencies, adopting a production database version or running existing integration suites.

## Admission and lifecycle

1. Accept only an explicit local Unix Docker endpoint and a digest-pinned Docker Official Image reference `mongo@sha256:...`. Reject ambient Docker overrides, remote endpoints, supplied database URIs/container IDs and unknown options before any Docker call. The real executor checks that the endpoint resolves to a local Unix socket.
2. Read the Linux daemon's ID. Create one uniquely named container with a per-run label and namespace, capturing its full returned container ID in a private closure. Never adopt arbitrary existing containers based on labels or names.
3. Before start, each database execution and removal, recheck daemon identity and inspect that exact ID. Require matching name, run label, image, entrypoint, command and isolation configuration. An ownership or configuration mismatch prevents mutation and cleanup.
4. Require network `none`, no published ports, no host/named mounts or inherited volumes, read-only root, non-root user, dropped capabilities, no-new-privileges, CPU/memory/PID bounds and explicit tmpfs paths. tmpfs is disposable storage, not a secure-erasure guarantee; it can be backed by host swap.
5. Bind MongoDB only to container-local loopback. Initialize a single-node replica set with an owned name and use only its generated database namespace. Run a fixed synthetic transaction probe through `docker exec` inside the container. No application module, URI override or arbitrary executable/script is admitted.
6. Remove only the created and freshly revalidated container. Repeated successful cleanup is idempotent. If ownership/daemon identity is lost, refuse removal and retain an explicit cleanup exception. A failed create with no acknowledged ID is reported with its generated name; do not guess ownership or prune resources.

The image must already be cached (`--pull=never`). Fetching a reviewed image is a separate local-install step. The controller uses an explicit endpoint and clean subprocess environment; no operational `.env`, credentials or default Docker resource overrides are forwarded.

## Required evidence for this increment

- Positive lifecycle and transaction-probe contract; only the captured ID is mutated.
- Rejection before Docker invocation for remote endpoints, unpinned images, ambient overrides and unknown/resource-override fields.
- No start/exec/removal after identity, ownership or isolation drift; duplicate cleanup cannot affect other resources.
- A real test-only replica-set probe verifies transaction commit and rollback plus successful cleanup. Mock transport results alone cannot establish MongoDB runtime behavior.

## Gates retained

The first candidate is MongoDB 8.x in a local test fixture. This is not a production selection and does not establish compatibility with Mongoose 6/driver 4.17. C2 and the separately reviewed runtime/ODM decision still precede application startup/package/dependency edits. This controller does not expose a host database port or admit the legacy pharmacy suite; provider/file stubs and full application pre-import isolation remain unfinished C3 work.

The reviewed v1.7 scope and [M0-A progress](M0_A_PROGRESS.md) remain authoritative for completion. No deployment, external provider or operational database access is included.
