# Focused implementation programme — owner direction, 12 November 2026

Objective: complete individual-customer, pharmacy and lab modules against the existing standard design, using parallel local workers, minimal nonredundant code and reviewed milestones. Corporate/HR/hospital expansion stays deferred. This addendum records the latest owner instruction; historical scope reviews retain their original meaning.

## Verification boundary

The owner excludes the final cross-module integration-testing campaign from this development pass. Record it as DEFERRED_BY_OWNER; do not mark it PASS or claim release acceptance. Continue focused source/unit/component checks needed to substantiate each change, with complete existing C3 admission before application imports or DB/provider execution. No release, clinical/finance/privacy-owner or deployment gate is waived. Implementation-complete pending integration is a distinct disposition from runtime-verified, supported-client-accepted and release-ready.

## Code discipline

Reuse current controllers/services/repositories, validation, AppError and trusted identity primitives. Keep one authoritative implementation of a rule; extract a helper only when it removes real repeated logic. Prefer a small change at the responsible boundary over wrappers, duplicate DTOs, copied business algorithms or a new generic framework. Preserve public API and existing legitimate behavior except reviewed intentional containment. Do not remove useful assertions or ownership checks to reduce line count. No new runtime/dependency/start changes without C2. Keep each worktree durable and commit coherent evidence locally; never treat missing uncommitted work as recovered.

## Milestones and parallel lanes

1. Customer authority: two booking read endpoints first, then separately contracted generic writable-field and identity/contact safety. Read/field/clinical/money authority are separate contracts. Own successful and cross-owner denied behavior is required; source-only evidence stays labeled.
2. Pharmacy safety and fulfilment: recover committed inventory fixture sources with honest missing-artifact provenance; validate catalogue restrictions and quantity/quality preservation. Contract prescription review/dispensing, reservation/return and paid cancellation effects before dependent writers. Retain direct/counter/approved wholesale requirements.
3. Lab integrity: individual booking association/dependent containment; provider-specific authenticated/deduplicated callbacks and recovery; private immutable report versions and signatory/sample roles. Both API and panel/direct business modes and critical-result acknowledgment remain included.
4. Customer-to-business implementation: close original requirement coverage and supported client/UI gaps, including receipts, notifications, private/direct operations and basic lab supplies. Freeze shared patient/consent, money, stock and report interfaces before independent domain writers.
5. Completion review: provide exact candidate commit, requirement coverage, changed-source and focused-check evidence, unresolved owner/client decisions and a distinct final integration-test backlog. Do not claim a module complete while required implementation is missing.

Four native agents total: lead plus three workers. Root owns shared contracts, booking/payment/document changes and merges; domain writers own disjoint assigned surfaces. Rotate slots for independent Standards and Spec decisions before and after bounded source changes. Advance a ready lane while another waits; do not repeat unchanged discovery or already consumed experiments. No hosted workers.

## Claude/Ruflo provenance

Normal macOS account access confirms the existing VS Code bundled Claude client signed into claude.ai/Max. A sandboxed auth check returned false and is not authoritative for that account. Ruflo MCP connects from both hosts. A genuine VS Code model session must read/respond to the existing shared challenge before extension connection is claimed. A CLI model request is a separate route and cannot prove an extension session. Neither queued metadata nor account sign-in is a review. Observe actual model/effort/session and findings; never substitute requested flags for effective settings. Keep ordinary client permissions, no hidden submit/account mechanism and no owner-relayed review prompts. Existing old fixed-operator receipts/packets do not authorize a new source review.

Initial assignments: /root/booking_read_spec and /root/booking_read_standards independently inspect CUSTOMER_BOOKING_READ_CONTRACT_DRAFT.md; /root/claude_extension_route prepares the supported genuine extension route without model launch. Root records actual decisions before authoring source. Continue the next ready reviewed milestone without requiring repeated development-start confirmation.
