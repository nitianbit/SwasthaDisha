# Actual API attempt 2: failed index setup

At clean `d91e1a3d37f2b229efc7fc2507d666ddc2576d99`, two direct internal
Codex reviewers approved exactly one run with template `75cf55be…` and launch
`9c6d1c80…`. That invocation returned exit 1 and FAILED_REVIEW_REQUIRED.
The receipt and exclusive claim are consumed and preserved. No retry occurred.

The closed diagnostic is `OWNED_DATABASE_CONNECT / DB_INDEX_CREATE_SERVER`.
Frozen control flow proves successful connection and explicit replica handshake,
then failure of an index creation action. The numeric error and affected index
were not measured. All 36 HTTP and four sensitivity cases are NOT_RUN.

Cleanup passed in the executable parent. A separate read-only root query verified
the same recorded engine before and after, both exact captured container IDs
absent, zero purpose-labelled resources and workspace ENOENT. The query outputs
are retained in `root-independent-readback.json`; no resource was adopted or
mutated. The raw created-array removed flags are historical capture values;
the later cleanup receipt and independent queries establish absence.

Both independent nonauthors reviewed the actual report, exact approval/claim,
source control flow, artifact pins and cleanup records:

| Internal reviewer | Decision |
| --- | --- |
| `/root/backend_boot_path` | ACCEPT_FAILED_ATTEMPT2_EVIDENCE |
| `/root/local_claude_review_prep` | ACCEPT_FAILED_ATTEMPT2_EVIDENCE_AND_CLEANUP_RECORD |

Their own child Docker queries were unavailable; they do not claim personal live
socket observations. Both independently confirmed the workspace was absent.
These are internal Codex decisions, not a Claude-model, owner or release approval.

The fixture's 512 MiB database tmpfs and MongoDB's documented 500 MB default
index-build free-space threshold support an UNPROVEN capacity hypothesis.
A separately reviewed diagnostic contract adds only fixed known numeric error
categories. No capacity, parameter, grant, index or application change is
justified by this run alone. Root build/start, full M0 and Week 2 remain open.
