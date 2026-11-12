# Failed first metadata preflight

Exact failed recipe/code are preserved inertly. ROOT_REPORTED_FAILURE.json distinguishes Root-reported actual output/accounting from this worker's read-only filesystem observations; it is not a fabricated raw capture. The original private area is retained unchanged. The attempt stopped before any Docker query, but its exact-once recipe decision is not reused for a retry. The defect was directory st_nlink changing during owned child-directory creation.
