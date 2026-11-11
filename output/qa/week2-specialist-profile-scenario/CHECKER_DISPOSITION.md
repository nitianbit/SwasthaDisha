# Source-checker sensitivity finding

The first source-data check retained as source-check-initial.json returned FAIL:
all34 candidate source predicates passed, but UNSAFE_PROOF_REMOVED survived. Its
ordering predicate used string.find; absence returned -1 and incorrectly passed
a less-than comparison. This was a checker defect, not executable fixture evidence.

Exact initial checker/result and hashes remain in initial-checker/. The amended
checker requires a nonnegative anchor before checking order, both for that unsafe
proof and compiler data-binding ordering. No fixture/application source changed
to satisfy this check; no application/TypeScript/Joi/compiler/HTTP/DB run occurred.
The new source-data result must retain this failure and demonstrate rejection of
all18 deliberate text variants. Source-data sensitivities do not prove runtime.
