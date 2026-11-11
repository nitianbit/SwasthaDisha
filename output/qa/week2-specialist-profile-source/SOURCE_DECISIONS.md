# Actual source decisions, 11 November 2026

Standards `/root/index_standards_fresh` and Spec `/root/index_spec_fresh` each
returned **APPROVE_SOURCE_ONLY** for specialist source631a2bc6, freeze6212e259
and composition `b26012c2001aa562fa40b4e08e855ade421d7f78`, with no material
application-source finding. They independently verified the exact fifteen-line
whole-file transformation, all three own fields/false/0, lookup before fixed422,
preserved absent404/malformed400, unchanged ordinary delegation and admin paths,
31 contract pins and all24 combined component pins.

The frozen checker passed before commit as recorded. Both reviewers reproduced
its later **WHOLE_TRACKED_TREE_SCOPE failure**: it treats committed QA additions
and the other composed lane as unexpected production changes. That failed rerun
is retained here and must not be labelled PASS. Neither reviewer changed the
frozen checker. Each independently verified the whole-file transform and ran
the same21 text sensitivities; Standards also checked four scope controls. Root
and both reviewers verified the exact composed three-file non-QA change union
and explicitly declared QA directories. This replaces the precommit tracking
assumption for composition; it supplies no runtime behavior proof.

Source check authoring history and original prepatch checker/proofs remain
preserved. Original six staged/working files, full-index patch00b2ad0d and all
eleven handover files match. Source-data proof cannot establish actual Joi,
controller/service, client or database behavior.

No portal/Joi/application/TypeScript extraction or evaluation occurred. The
later compiler-only emission11 excludes PortalService from its unchanged97-input
runtime closure; it is no test of this guard. Separate full portal C3 admission,
genuine success/denial/source-regression evidence and client/release gates remain.
No fullF04/F15, M0/Week2, rootC2, owner or production acceptance is claimed.
