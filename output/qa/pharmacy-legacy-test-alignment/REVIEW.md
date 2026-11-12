# Pharmacy legacy test alignment — source candidate

Baseline: `72361527824cd6e3cd61c7853b718ca7fc35ce57`. Author: internal Codex `/root/lab_remaining_audit`. The two actual nonauthor contract decisions are in `CONTRACT_DECISIONS.json`. Source decisions remain pending; the author does not approve this candidate.

Only two existing case bodies change. The manual-payment case now creates a real active non-Rx medicine and supplies explicit admissible stored-order fields, retaining both concurrent calls and exactly-one-success/one-rejection assertions. The prescription case now expects the current 503 commerce-unavailable code and compares the complete inventory snapshot, retaining quantity totals. No case is skipped, renamed or removed.

Static source checks passed: every byte outside the two bodies unchanged; all production/provenance pins unchanged; exact source diff and whitespace checks. `SOURCE_CANDIDATE.json` binds the full candidate, patch and input hashes. Existing helpers, imports, nineteenth actual MedicineRepository constructor argument, suite admission and cleanup are untouched.

Type validity, real catalogue/ODM behavior, runtime denials, concurrent scheduling and financial effects remain NOT_RUN. The legacy suite still imports effect-capable modules before its weak configured-database guard and can drop that database; this source candidate authorizes no suite/application/Node/compiler/Docker/database/provider execution. Existing C2/C3 and clinical/finance/privacy/client/module/M0/release gates remain open. Final cross-module integration and corporate/HR/hospital expansion remain deferred.

The initial full-context SOURCE.patch triggered three whitespace diagnostics on literal diff-context markers. The archived patch is now zero-context with full-index hashes; its manifest is rebound without changing test source. Reconstruction, if separately needed, requires git apply --unidiff-zero. No reconstruction ran. The initial artifact formatting failure remains recorded here and in Git history.
