# Second parallel batch: review provenance

10 November 2026. Baseline `9ea963f1f7b51aadedcfa7fc9918eb39a2fd737d`, integration branch `m0/parallel-integration`. The lead (main Claude session) owned slice selection, branch setup, integration and these records, and wrote none of the four lane candidates. Workers and reviewers were internal Claude subagents working read-only on exact commits and hashes.

These are technical reviews only. They are not named-owner, clinical, finance, security, external Review A/B, deployment or release approvals. No reviewer ran TypeScript, the application, a database, a provider or Docker. Reviewers re-ran the retained Python source checks, the offline unit gate and the probe where allowed. Reported deviations: some scratch output went to `/tmp` and was deleted; one reviewer evaluated edited candidates in memory with the check's own Python functions.

## Users route authority (`m0/authority-next`)

| Stage | Commit | Decision | Material findings and disposition |
| --- | --- | --- | --- |
| Contract pre-review | `ad6d69d` | APPROVE WITH REQUIRED AMENDMENTS | P1: HR without `corporateId` skipped scoping on list/create; now denied with 403 `HR_CORPORATE_REQUIRED`. P2: dependence on Joi field stripping stated and pinned; negative controls now rejected by named checks; open takeover risks recorded. P3 wording fixed |
| Standards final | `45966f3` | APPROVE WITH NITS | No controller defects. P3: inserted user-type branch caught only by exact comparison, so a closed `userType` vocabulary was added; `intended` recorded per control; KeyError replaced by a named rejection |
| Spec final | `45966f3` | APPROVE WITH NITS | P2: JWT precondition and unrevoked tokens/contacts residuals added. P3: phone/email pre-hijack, check order after Joi, pharmacy client citation |
| Amendment confirmation (Spec reviewer) | `ea0710c` | AMENDMENT CONFIRMED | Controller unchanged; 42 controls re-run, matching the receipt |

## Wallet mutation authority (`m0/money-provider-clinical`)

| Stage | Commit | Decision | Material findings and disposition |
| --- | --- | --- | --- |
| Contract pre-review | `80da7ff` | APPROVE WITH REQUIRED AMENDMENTS | P1: `PUT /:id` let anyone freeze any wallet (lost refunds), so it is now admin-only. P1: guards depend on the JWT key. P2: `GET /` dumped every wallet, so it is now admin-only, with own-or-admin by-user reads added |
| Standards final | `6facb0f` | APPROVE WITH NITS | No code defects. P3: semantic checks are substring lints, so the binding gate (exact transform plus scope) is now stated honestly; bypasses added as controls; root config files added to scope |
| Spec final | `6facb0f` | REQUEST CHANGES (contract only) | P1: residual list missed pharmacy wallet debit via bookings and refund forfeiture via booking PUT; both added with owners. P3 fixture gaps closed |
| Amendment confirmation (Spec reviewer) | `8409858` | AMENDMENT CONFIRMED | Routes unchanged; 36 controls re-run, matching the receipt |

Open P3: `fixture-spec.json:125` names own-or-admin as an example of an admin-denying guard, which is wrong because it admits admins. Left unedited because the receipt records the file's hash; to fix in the next fixture revision.

## JWT secret fail-closed (`m0/authority-jwt-secret`)

| Stage | Commit | Decision | Material findings and disposition |
| --- | --- | --- | --- |
| Contract pre-review (Spec reviewer of the users slice) | `e82c31c` | APPROVE WITH REQUIRED AMENDMENTS | P2: dotenv-before-validation check and operator key-source precondition. P2: import blast radius (25 modules, integration suite, scripts, future harness admission with a synthetic key). P3: non-placeholder is not secret; deployed entry point unknown |
| Standards final | `7e4dd52` | APPROVE WITH NITS | No code defects. P3: scope check now whole-tree including untracked files; raw-byte comparison; ECMAScript trim set; case variants stated |
| Spec/security final | `7e4dd52` | APPROVE WITH NITS | P3: label renamed; dotenv precedence stated; integration-suite import failure; sharpened owner question about PM2 cwd and compiled `./src` |
| Amendment confirmation (Standards reviewer) | `843bdb0` | AMENDMENT CONFIRMED | `config.ts` unchanged; 23 controls re-run, matching the receipt |

## Network admission (`m0/foundation-network-admission`)

| Stage | Commit | Decision | Material findings and disposition |
| --- | --- | --- | --- |
| Contract pre-review | `32fdf77` | APPROVE WITH REQUIRED AMENDMENTS | Core capability argument confirmed against controller lines 164-178. P2: evaluator must throw; the old canary measured nothing, so `ENETUNREACH`-only was adopted; prior "Measured limits" explicitly superseded; 14 fixture groups added. P3: logic moved into the unit gate; stricter flags parsing; `127.0.0.1` required |
| Spec/containment final | `a609a60` | APPROVE WITH NITS | No fail-open input found. P3: five surviving mutations closed by isolating fixtures; canary wording no longer claims independent route proof; residuals generalised |
| Standards final | `33cabbe` | APPROVE WITH NITS | No code defects; 324/324 and probe reproduced. P3: exact rejection reasons pinned; complete list of pre-record throws; hash copies bound |
| Amendment confirmation (Standards reviewer) | `baaf071` | AMENDMENT CONFIRMED | Harness modules unchanged since `a609a60` (tests changed only in `33cabbe` and `baaf071`); 324/324 on both runtimes; probe 9/9 |

Open P3: in the application README and contract header, a sentence that follows a list was merged into its last bullet (formatting only). Kernel and libuv facts behind the capability argument remain unverified from memory; the next real run measures `ENETUNREACH` and the observed device state.

## Integration

The retained per-lane source checks are lane-scoped. Run on the integrated tree, two of them reject it, because they pin files a sibling lane changed: the wallet check pins `config.ts` (changed by the JWT lane), and the JWT check pins `bootstrap.mjs` (changed by the network lane). This is benign. The bootstrap environment allowlist still excludes `JWT_SECRET_KEY` (now `bootstrap.mjs:8-11`, cited as `:6-9` in the JWT contract), and removing the key fallback only strengthens the wallet guards. The combined verifier replaces these lane-scoped checks for the integrated tree.

Additional open P3: `fixture-spec.json:141` and DEN-21 still list removing the key fallback as excluded, although the integrated tree now includes it. Fix together with the `:125` label.

The lead merged the four reviewed heads without conflicts (`57a1b23`, `6e482a3`, `92ef4e5`, `790f276`) and ran the unit gate on the combined tree: 324/324 on Node 22.23.4 and 24.19.0, with empty stderr. The combined verifier and its receipt are in this directory.

## Integration reviews

| Reviewer | Candidate | Decision | Findings and disposition |
| --- | --- | --- | --- |
| Internal Claude subagent, Standards/composition, nonauthor | `4720062` | APPROVE WITH NITS | Independently confirmed all 36 lane files (content and mode), conflict-free merge trees, verifier output, unit gate and preservation. P2: rename detection could hide a deletion, so the verifier now uses `--no-renames`. P3: mode comparison added; clean-tree check without exemption; preservation hashes pinned from the committed receipt, with the handover file set asserted; sibling-pin note; wording fixes |
| Internal Claude subagent, Spec/composition, nonauthor | `4720062` | APPROVE WITH NITS | Composition sound and strictly safer than the isolated lanes. P2: Meet containment needs admin plus callback handling; notification broadcast added as the top decision-free item; contact-takeover residuals added to open decisions. P3: progress wording narrowed to the wallet router; dependents role rule stated; fixture DEN-21 note |

The amended records and verifier are confirmed by a nonauthor reviewer before the batch is reported complete.
