# Owned MongoDB fixture smoke check

This checks the disposable Docker fixture independently of the application and its Mongoose dependencies. It creates a new single-node replica set, measures a synthetic transaction commit and rollback, and removes only its own revalidated container. It does not open a host database port or run the legacy integration tests.

Use Node 22.13+ and a local Linux Docker engine available through a Unix socket. This local adapter expects the Docker CLI at `/usr/local/bin/docker`. The image in [image.json](image.json) must already be cached; the controller uses `--pull=never`. Fetching that public digest is a separate install step. No Docker context, remote daemon, operational database URI, `.env`, credentials or provider configuration is accepted.

Resolve the Node executable and explicitly identify the local Docker socket before invoking:

```sh
FIXTURE_NODE="$(command -v node)"
env -i "$FIXTURE_NODE" test/mongo/smoke.mjs unix:///absolute/path/to/docker.sock
```

The command prints generated resource identifiers and measured counts (`committed: 1`, `aborted: 0`) after successful cleanup. On failure, it attempts cleanup only with current ownership and isolation evidence. Admission failure, an unknown create acknowledgement or ownership drift can require manual investigation; errors identify the captured ID or generated name. Do not use a broad prune or adopt an existing container to resolve an exception. Independently verify the reported ID is absent after the run.

The container has network `none`, loopback-only MongoDB, no published ports or host mounts, a read-only root, a non-root user, bounded resources and explicit tmpfs paths. tmpfs can use host swap and does not establish secure erasure. The daemon and executable are trusted local infrastructure; this is not a sandbox for hostile host code. The image digest is a test fixture selection, not an approved production database target.

See the [fixture contract](../../documentation/planning/implementation/C3_MONGO_FIXTURE_CONTRACT.md) for admission requirements. Passing this smoke check does not establish application-driver compatibility, complete C3, pass the 115 domain scenarios, or accept M0-A.
