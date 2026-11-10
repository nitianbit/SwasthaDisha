# Keep a modular Jansetu core with explicit system authorities

**Status: proposed, 8 November 2026.** The reviewed Express/TypeScript/Mongoose backend already contains useful pharmacy, booking, payment and external-lab workflows. The expanded private-business suite and 100 aggregate RPS target do not yet justify replacing that core with several ERPs, clinical servers or microservices.

Retain a modular monolith with separately operated API and worker processes. MongoDB remains the initial transactional authority; clinical files move to private object storage. Modules expose application operations rather than allowing arbitrary cross-module collection writes. Cross-system work uses durable commands/events and compensations. Existing modules migrate incrementally; this is not approval for a directory-wide rewrite.

ERPNext/Marley, InvenTree and OpenELIS remain optional, separately scoped integration candidates. Before enabling one, name the authoritative writer for each patient artifact, order, store, invoice and financial effect; transfer ownership through a deliberate migration instead of allowing two systems to edit the same balance. This trades immediate upstream workflow breadth for a smaller initial operating surface and preserves a later adoption path when a measured trial justifies it.

Shared Mongo collections use mandatory business/branch policy for private records, while patient identity is separate from business membership and app login. Cross-business care access requires an explicit relationship and applicable authorization. The tenant and clinical boundaries, event delivery, payment races and recovery gates are specified in [SYSTEM_DESIGN.md](../SYSTEM_DESIGN.md).

Revisit when measured bottlenecks, an established partner system, an isolation requirement or a demonstrated workflow saving justifies a new service/database. No migration, dependency adoption or measured capacity is implied by this proposed decision.


**Review amendment v1.1:** current platform-configured gateway collections and wallet-credit records are migration facts, not an unmade future assumption. M0 closes existing recovery/report-preservation gaps. Typed scoped repositories enforce business access, with a separate patient/caregiver surface; pharmacy retains embedded medicine batches. The approved future merchant/wallet/account map remains a finance/product gate before M2 posting changes. See [review disposition](../ARCHITECTURE_REVIEW.md).


**Review amendment v1.2:** customer-wallet effects are one guarded balance/movement transaction with stable economic identity. Payment retries resume/reconcile the current obligation before a successor is created. M0 hardening is independent of the M2 doctor hold engine and new financial/clinical policies; accepted M0 completion anchors the schedule. Reconciled financial openings precede M2 ledger posting. Reviewer inputs and evaluator material have separate ownership; exposed examples cannot be claimed as blind holdouts.


## v1.3 amendment: source refund budget and phone channel

All refund destinations reserve/consume one captured-payment budget before any return, including pending external refunds and manual cash/gateway actions. Provider calls remain outside Mongo transactions. New basic-phone consultations use a telephony adapter and application coordinator, while existing patient/consent, booking, wallet and clinical boundaries retain authority. Partner top-ups need an approved funds arrangement; caller identity and transport events are not spending/clinical evidence. F14 is separately estimated after M1/M2; the new channel adds no M0 dependency or ABHA requirement. M1 timing is provisional including financial cutover, and the mobile confirmation contract has an explicit frontend owner.


## v1.4 amendment: phone verification, funding and clinical policy

Keep PIN-bearing provider inputs transient and persist only safe outcomes; use separately protected keyed verification and global abuse budgets. P1 selects sponsorship, consultation-only pocket or general wallet before F14 sizing, preserving one financial owner and the requested top-up option. Reuse the unrouted pharmacy paid-state guard without trusting caller prices or claiming full command idempotency. Available funds exclude authoritative held amounts; reserve/capture/release share atomic state. Clinical owners approve the mode/type prescribing policy and referral-only fee behavior; UI labels cannot bypass backend decisions. These amendments add no M0 dependency or deployment authorization.


## v1.5 amendment: cumulative scope and credential lifecycle

F14 retains its complete original top-up, identity/caregiver, queue/capacity, one-charge/reconnect and outcome scope alongside later controls. Credential setup/recovery belongs to the identity boundary; a printed challenge alone cannot authorize enrolment. Require independent contact proof, private single-use setup, bounded recovery and notices. Global abuse handling preserves bounded authenticated/verified-contact capacity without bypassing authorization. Follow-up requires clinician identity and prior in-person/date/condition evidence under approved policy. P1 uses the three glossary-defined funding labels; no earlier delivery gate is waived.

## v1.6 amendment: independent contact binding (9 November 2026)

The identity authority separates contact possession from approved patient/caregiver binding. Counter entry or a successful callback alone cannot authorize setup, recovery or protected admission; require independently approved evidence and no cashier self-approval. Preserve legitimate shared-phone access, versioned re-verification, masked readback and private reuse-risk review (phone3.4). D8/P2/P3 retain prescribing mode/type and PIN transport/key lifecycle, with security/DevOps and integration/operations approvals before release. No milestone or runtime authority is changed.

## v1.7 amendment after two principal reviews

Retain the modular core and existing authority boundaries. Command-specific fields, trusted catalogue/regulatory facts, quality release and canonical capacity/resource intervals are explicit contracts. Restore admission needs a recovery generation outside the rollback domain plus independently current authority and recoverable local irreversible-effect evidence or frozen exceptions; a restored snapshot cannot prove either. Bound/archive embedded lot history with resolvable original references. D1/D4 precede M1 common finance contract freeze; M0 still hardens current facts independently. Principal findings, qualifications and M0 start/release gates are in the new disposition/approval packet; no application fix or owner approval is implied.
