# Specialist self-profile source candidate

Baseline b33a9daac01628a48043e85764819a5f855431ed; final governing contract
output/qa/week2-specialist-profile/CONTRACT.md SHA2a49c33b... and freezeb20a62c4....
Both actual preimplementation decisions APPROVE_IMPLEMENTATION_ONLY were received
by Root from independent internal Codex Standards/index_standards_fresh and
Spec/index_spec_fresh before assignment. This author does not supply approval.

Production change: exactly15 inserted lines in PortalService.updateProfile;
no new import or other method/admin/router/schema edit. A nonnull object with any
own isVerified/isActive/rating field first awaits existing getById, then throws
fixed422 FORBIDDEN_FIELD. Own false/0/undefined are included by presence. Other
inputs take the unchanged delegate, including null/nonobjects outside admitted
typed requests. Ordinary updates acquire no extra read. Existing Joi400 precedes
this service, while a valid forbidden request preserves missing-object404.

Executed only sanitized Python source-data checks, plus source diff whitespace:

    env -i PATH=/usr/bin:/bin /opt/homebrew/bin/python3 -I -B output/qa/week2-specialist-profile-source/verify-source.py --baseline
    env -i PATH=/usr/bin:/bin /opt/homebrew/bin/python3 -I -B output/qa/week2-specialist-profile-source/verify-source.py
    git diff --check -- src1/modules/specialistPortal/services/index.ts

The actual pre-edit source was pinned and rejected before production editing;
--baseline exited0, then ordinary gate exited1 as intended. After15-line insertion
the same frozen checker98962ddf... exits0. It verifies exact whole-file transform,
31 frozen inputs (30 unchanged current pins), source mode and sole tracked-file
scope.21 weakened source-text controls and4 scope controls are rejected. They
verify source transformation, NOT JavaScript/TypeScript control flow, values,
Joi conversion, HTTP status, actual DB reads or zero effects. No source extraction,
AST/TS parsing, eval, transpilation, service/Joi import, compiler, package, DB,
Docker, model, provider or auth/client action occurred. No Git metadata writes.

Checker authoring history: first actual baseline proof succeeded, then one
control anchor matched several existing AppError throws and failed. The exact
old checker/proof and safe disposition are retained under checker-authoring-1/;
the anchor was narrowed and final checker frozen BEFORE production edits. This
is a source-checker authoring correction, not an application failure/review.

Future real evidence requires a separate complete C3 contract admitting the
actual Portal/Booking/slot/execFile/fs dependency closure; existing83/27 receipt
is consumed and does not admit it. Required predicates: valid descriptive update
unchanged; each protected field/combination/false/0/valid Joi conversions denied;
malformed protected400 before DB; absent valid-protected404; existing422 with
one read and no update/uniqueness/provider/JWT;401/403 precedence; unchanged admin
route and exact all-row/effect snapshots; actual missing-key/truthiness/lookup-
ordering source variants must fail same predicates with fresh nominal restore.
Normal HTTP errors retain existing errorHandler logger; direct service adds none.
Current accepted83/27, original115 outcomes, fullF04/F15/M0/Week2, clients,
rootC2/deployment/production key and named-owner/release gates are not promoted.
