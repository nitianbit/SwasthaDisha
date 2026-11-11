# HR booking read scope source candidate

This is the bounded two-file implementation of frozen contract
`09136c8f661435e36897f80949dfc4e1f88e2665737b228c843b14affb398edd`
(inputs `7f491685d222feecaeafdaeeb30a2c95e853bcc232b2277259efa4431975e7b9`,
contract freeze `fb1bb37b0e95c8ec4d6f06d7b6fabf7b329a1b94f65f211343044858dd8d48de`).
Actual nonauthor preimplementation decisions are retained in
[PRE_REVIEW.md](../week2-hr-booking-scope/PRE_REVIEW.md).
Source baseline: `a3f3b922c29da03b8244246dd9e271f90d8b9ee3`.

The new read resolver is first in only LIST, USER and UPCOMING. Exact HR needs a
primitive 24-hex corporate; missing/malformed scope yields403 HR_CORPORATE_REQUIRED.
Conflicting corporate or any present forUser except false/'false' yields403
FORBIDDEN before booking reads. Existing route Joi and error ordering remain.
The service validates a provided optional second scalar before DB; its trusted
path adds corporate intersection while retaining ordinary shortcut precedence,
implicit booking types/fixed sorts, general filters and paginated behavior. The
original service body remains the undefined-scope path; non-HR controller calls
remain one-argument. Shared helper/fourth caller and all other methods are exact.

## Source-only evidence

- `baseline-rejection.json`: captured before any production edit; command exited1,
  actual baseline source hashes matched, gate rejected unchanged source.
- `amendment.json`: nine literal byte transformations, authority and source pins.
- `declarations.json`:32 independent literal declaration requirements.
- `source-controls.json`:36 inert source declaration/inverse variants. Each is
  rejected by its named declaration or full-file identity check; hashes/failures
  are in `source-verification.json`. This is source-string sensitivity, not a
  parser/compiler validity check or proof of runtime exploit detection.
- `verify-source.py --controls`: actual SOURCE_ONLY_PASS, full exact transformation
  and inverse, unchanged dependency/client pins and modes, exact Git-visible
  two-source union plus explicit owned QA directory. Scope remains valid after
  files are committed; it does not assume untracked state. Ignored/outside-Git
  operational state is not scanned or certified.
- `candidate.diff`: exact full-index production patch; `git diff --check` exited0.

To repeat only this source/data gate from this source worktree:

```sh
python3 output/qa/week2-hr-booking-scope-source/verify-source.py --controls
```

The script reads Git blobs/status, Python/JSON and source bytes only. It never
parses, compiles, imports, extracts/evaluates or executes TypeScript/domain code.
No executable foundation/app/Joi/provider/DB/Docker/package/auth/native-child
check occurred. Zero runtime effects are required by the contract but are not
measured by these source checks. The103 future HTTP rows and eight runtime source
variants remain NOT_ADMITTED/NOT_RUN; no full TC-REV-002 or Week2/M0 acceptance.

## Review/integration hold

This author makes no implementation self-approval. Root obtains two independent
nonauthor SOURCE_ONLY implementation decisions and handles Git. Integration
remains held until actual specialist90 acceptance and Root's explicit review of
the changed excluded BookingService source hash/provenance and any required
artifact/admission refresh. It is not among actual105 template source inputs;
this change does not authorize silent fixture/sourcebinding/section/compiler
updates or an unnecessary identical runtime rerun. Active warning/profile
candidate and all existing contract/fixture/grant files remain unchanged.

Membership freshness,30-day claims, broader detail/create/external/non-HR scope,
date/filter limitations and clinical/finance/contact/deployment/release gates
remain open. Original six staged changes and eleven handover files were outside
this isolated source worktree and were not modified or re-certified here.
