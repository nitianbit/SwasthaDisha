# Repository migration review

**10 November 2026.** Internal coding-agent reviews under the Code Review skill. These are migration reviews, not external Claude/Review-A/Review-B approval. Source and evidence inputs are frozen in [review-input.json](review-input.json); inventory SHA-256 `46a9cfd8bf266704ab5ea2bdec57e50212bdbdc055ae098084e18f4cc2aeaa3f`.

## Standards

**Standards verdict: APPROVE** for the repository migration.

**Violations:** None remaining. Utility instructions consistently require `DEV_AUTH_TOKEN`; the unreachable duplicate check is removed. README guidance preserves C2/C3 gates, labels historical results and removes the broken specialist link.

**Code smells:** No actionable smells introduced by the migration.

**Verification:** Independently checked all 545 destination hashes, ten frozen review inputs, four evidence hashes and ten fixture hashes; all match. Inventory SHA is `46a9cfd8…2aeaa3f`. All 41 excluded paths are absent and ignored; `.env.example` remains available. The manifest preserves 357 `src1` source hashes.

Inspected the revised utility, documentation, ignore rules, manifests, scan report and saved TAP showing 56 passes. The recorded secret scan reports zero blocking patterns; pattern scanning cannot establish the absence of every secret or personal record.

Reran only read-only hash and ignore checks. No tests, utilities, application, network or legacy credential/data access occurred. No files changed. This is migration approval only; C2/C3 and M0 acceptance remain unchanged.

## Spec

**Spec verdict: APPROVE — repository migration only.**

**Spec misses:** None outstanding. All three findings are closed: the active README preserves C2/C3 gates and provides only the admitted foundation command; the excluded specialist-guide link is removed; utility documentation consistently requires `DEV_AUTH_TOKEN`, with execution restrictions and corrected help.

Fresh-history provenance is explicit. The new repository retains its README seed history, identifies the legacy source separately, and distinguishes historical reviews from current evidence. The portable C2 prompt preserves those boundaries.

**Overbuild:** None found. The import, documented exclusions, credential removal, ignore rules and handoff instructions fit the requested transition.

**Inspected / reran:** Independently verified the final inventory SHA `46a9cfd8…aeaa3f`, all 545 destination hashes, permitted legacy-source hashes, ten frozen fixture hashes, and all source/evidence hashes in `review-input.json`. All 357 `src1` files remain unchanged. All 41 excluded paths are absent and ignored; `.env.example` remains available. Checked authoritative entry-document links with no broken targets. The saved relocated TAP records 56 passes and zero failures, cancellations, skips or TODOs.

No files changed and no tests, installs, application/Docker commands, network operations, or raw legacy credential/patient reads were performed during review.

This approval covers the repository transition; C2, full C3, application compatibility and M0 acceptance remain open.

## Correction cycle

| Axis | Initial finding | Closure |
| --- | --- | --- |
| Standards | P2 token-variable change incomplete across instructions; P3 unreachable duplicate check/help | Utility guide consistently uses DEV_AUTH_TOKEN; one early guard remains |
| Standards | Excluded exports/archives not all ignored | All 41 exclusions now absent and ignored; environment example remains available |
| Spec | P2 legacy active README commands conflicted with C2/C3 gates | Replaced with current gate sequence and the admitted unit command |
| Spec | P2 utility guide named the wrong variable | Corrected examples and fixture/token guidance |
| Spec | P3 stale specialist guide link | Removed without restoring the excluded artifact |

Final outstanding findings: Standards **0**; Spec **0**. Approvals cover this transition only.
