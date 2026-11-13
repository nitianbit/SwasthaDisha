# Existing customer flows — resumed scope

The owner explicitly resumed this customer milestone on 13 November 2026 after reviewing the stopped checkpoint. This authorizes the following local implementation and focused verification; it does not resume every older queued module or authorize deployment/push/provider operations.

Base: `m0/customer-pharmacy-lab-focus` at `9c8d1d8f6ecda8d0832f9294c4b1b7a6fdf7077c`. Local working branch: `customer/milestone-2026-11-13`. Legacy reference: sibling `ewa_backend`, locally saved `origin/integration/perks-v2-combined` at `2347787e312721d89652913f9d36adf11a9be251`. The legacy checkout remains read-only and its untracked files are preserved.

## Owner requirements

- Signup/login needs either phone or email. Leave the existing enrollment increment unchanged for now; broader checks and identity work can follow later.
- A customer edits their own profile; an admin can edit it. A customer cannot replace an existing phone/email, but a mixed payload must still save its other valid editable fields. A missing contact may be filled; only an admin replaces one. Do not make self-service contact replacement/recovery or the isolated seven-writer contact branch a prerequisite.
- Customers can change their own addresses; reuse the existing address implementation.
- Use the legacy branch as the reference for existing booking creation/read/list/status/cancellation behavior, preserving current signed owner/field/privacy checks and correcting concrete gaps.
- The owner's explicit scope answer: **Finish existing customer flows first; add BetaCura/hybrid later.** CRM/events, new provider integrations, certificate/report feature expansion and autonomous jobs are not added by this milestone.

## Delivery units

1. Profile: ignore existing contact replacements before validation, permit validated missing contacts, preserve signed actor/privilege checks, protect simultaneous fills and retain duplicate prechecks. No claim that nonunique deployed indexes enforce global contact uniqueness.
2. Booking authority/read behavior: signed owner and association on creation, owned active dependent where used, no synthetic unauthenticated actor, preserve filters with owner scoping, retained current diagnostics progress/history.
3. Cancellation/local effects: truthful internal-wallet settlement and retry, payment/setup writer fences, recorded slot-hold movement/release, retained history and no fabricated financial/clinical/provider facts. Exact contract is in `CUSTOMER_CANCELLATION_MILESTONE_CONTRACT_2026-11-13.md`.
4. Focused changed-behavior checks and independent source reviews, with actual scope and limitations recorded. Existing infrastructure is reused; unrelated historical campaigns are not repeated.

## Completion reporting

Report implemented source, executed recording-port behavior, genuine native HTTP/database evidence and remaining external/client acceptance separately. A review prompt must bind exact commits, source hashes, contracts, raw checks, review decisions and limitations. Neither local commit nor passing mock behavior constitutes full customer-module or production acceptance. All previous failures, consumed approvals, protected clinical files, saved branches and original tooling/handover archive retain their historical meaning.
