# Pharmacy pure fixture source recovery — draft contract

12 November 2026. **DRAFT_AWAITING_TWO_CURRENT_NONAUTHOR_REVIEWS.** Author: internal Codex `/root/pharmacy_recovery_readiness`. This document authorizes no restoration, correction or executable check. It adds only this draft; application/design/contracts and selected R4 Claude inputs at source snapshot `abd1e90` remain untouched. Root controls integration and Git.

## Basis and scope

Use the existing [recovery inventory](../../../output/qa/pharmacy-fixture-recovery/source-data-inventory.json), [inert archive index](../../../output/qa/pharmacy-fixture-recovery/restored/index.json) and [restoration record](../../../output/qa/pharmacy-fixture-recovery/RESTORATION.json). The verified archive has74 mappings/62 unique blobs,1,573,917 unique bytes; index SHA-256 `f8f75a0915a7488ff883c49bc02f04dba341cabbe9573fa1f12a11ce32193151`. This draft uses targeted archived bytes; it does not repeat the74-blob audit. Existing `.txt` blobs remain inert and immutable. Original refs, historical failures and reviews remain provenance, not current execution grants.

The smallest proposed first slice restores only the six committed files below to `test/inventory-runtime/scenario/`, then changes **one creation-time namespace expression** in bootstrap. Do not restore platform/launch/prepare/compiler/scenario/app files or installed packages for this pure slice. Exact-path absence must be checked before restoration; an existing or drifting file requires Root reconciliation, not overwrite.

All baseline bytes survive at ref `58719fdb0e7be542112c0b76f88e19bd33a7364c`, under `output/qa/week2-inventory-snapshot-native-zero-source/bootstrap296-positive-final/`, and by digest in the inert archive:

| Restored basename | Exact baseline SHA-256 |
| --- | --- |
| `bootstrap.cjs` | `f4a49fcbe8be8063091a4a1b9b76ea9e300a96e7eef19d9ed5192a3297b28690` |
| `bootstrap-unit.cjs` | `1ff27be8e21ef9a6357f5cb51c59542cccc9ab3da018921f3bbd499117b1a6b5` |
| `apm-cursor.test.cjs` | `6782511ca9d1db04c2957a9b40ea06c96e07caf99a57b64f11ed4040c236aa1f` |
| `ports-manifest.json` | `12384285263ed68d76ce55fc201faf68222b59db3a415f0f3693ccb73b81503a` |
| `cases.json` | `807c0c5e523788cad4731de7908722e99e969414ef74f3ae35eb1f61bf5023e4` |
| `public-lock.json` | `2b0eecf4f94decd9fda01631b1cef0209a6131ccd226eece5c3265eaa6fde3c5` |

Keep the latter five byte-identical initially. Add only `test/inventory-runtime/scenario/cursor-creation-pure.test.cjs` and a single bounded launcher/evidence surface under `output/qa/pharmacy-pure-fixture-recovery/` (`run-pure.py`, exact manifest/argv/results and new source/control evidence). A fresh lease also receives the exact archived bootstrap as `baseline-bootstrap.cjs`, solely for baseline RED/source comparison. No generic runner or runtime capability is added. These are proposed future owned paths, not files created by this draft.

## Observed test tool; no execution admission yet

The [actual acquisition result](../../../output/qa/pharmacy-node22-recovery/revision-1/ACQUISITION_RESULT.json) hashes to `0b21f467f6e9afca3dccfc6a6ee1ea3bd416a158a7d7516982db0cf42bbff0d1`. [Root independent readback](../../../output/qa/pharmacy-node22-recovery/revision-1/ROOT_READBACK_2.json) hashes to `f91fbffca85a5e03496793a577271cd7cddc0f4ce5a54df09f70f4bab3c0909d`: `/private/tmp/m0-node22/node`,113,002,944 bytes, mode0500, SHA-256 `2cc28a1880d0774616959f2210ee739bffa6ac695c887e8988a496a21271f6c0`, observed file identity `[16777233,54314947,501]`. Archive49,996,369 bytes matched `c9e1dbc748b33ed2d14f42445191ecaf14c56259c7a9a26d0042c49ec2b66428`. Node22.23.4 is byte-provenance, not an executed version assertion: both records report zero Node execution.

Acquisition/once receipts are consumed and authorize no test. The operator reports stage removal/zero cleanup exceptions; Root found no stage-prefix matches but explicitly lacked the original exact stage path for independent held-identity readback. Preserve that limit. Before any future pure command, revalidate the canonical regular file, hash/identity/mode and exact reviewed launcher; do not execute `--version`, reinstall, substitute a runtime, infer ownership from markers, or retire the retained tool as part of unit cleanup.

## One-expression source change and closed callers

Historical contract: `5abb1a9987eaa9cab2105cc6a50029692013f63d:output/qa/week2-cursor-creation-contract/` (freeze SHA `516b4ca4da13d0c143c52b7fc1e4926204fb1ffcb0f0cbe596b25121986935a4`). Its original two implementation-only decisions are historical. Archived driver7.8.0 text shows a new listCollections cursor starts DB-only; command APM callbacks precede adoption of the special reply namespace. No driver is imported to inspect this.

Inside `createDatabaseBoundary` → nested `trackCursor`, replace only:

```js
cursor.namespace?.toString() === manifest.database + '.' + collection
```

with:

```js
cursor.namespace?.toString() === (command === 'listCollections'
  ? manifest.database : manifest.database + '.' + collection)
```

Preserve short-circuit/property-read order, held client/session membership, duplicate-lease check, `leases.add`, `wire.expectCursor`, close wrapper and every other source byte. Exact inverse must recover `f4a49…`. No ports/data/hash refresh, post-init assertion/wrapper, namespace union, prefix match, coercion, new command or exported helper is included.

The three closed actual callers remain:

- `Db.prototype.listCollections`: INDEX_SETUP, exact owned DB/client, empty filter, held control and exact nameOnly/batchSize/maxTimeMS → literal `listCollections` / `$cmd.listCollections`, row limit3.
- `Collection.prototype.listIndexes`: owned collection, INDEX_SETUP and exact control/options → literal `listIndexes` / full collection namespace, row limit32.
- `Collection.prototype.find`: unchanged phase/filter/options/session admission → literal `find` / full collection namespace, existing row limits1/16.

Lease collection stays `$cmd.listCollections`. Actual `createWireBoundary` must still accept only the paired special reply `<ownedDb>.$cmd.listCollections`, numeric positive zero, unchanged command/session/request shape and row/byte/deadline caps. Native Long0 remains distinct from APM number0; no getMore/killCursors permission or alternate reply is introduced.

## Exact pure import/effect closure to review

Existing unit/APM entries require only `node:assert/strict`, `node:fs`, `node:path`, `node:crypto` and sibling `bootstrap.cjs`; their JSON/lock inputs are data. Bootstrap imports only Node fs/path/crypto/os/net/tls/dns/http/https/timers/module/v8/diagnostics_channel/url at module evaluation. It initializes constants/state and exports helpers; `if (require.main === module)` prevents `main()` when required by a pure entry.

The new lifecycle entry may additionally require only `node:vm`. It can use existing exported `createWireBoundary`, `collectReadCursor`, `createReadBudget`, `withCleanup` and fake BSON observations. Since `trackCursor` is nested/unexported, the proposed minimum test access is **explicitly reviewed, byte-bound evaluation of that exact fixture source slice and the three unchanged caller-wrapper slices**, with explicit fake lexical bindings. No production helper extraction/export is needed. Require unique literal start/end delimiters, full baseline/candidate hash/inverse checks and exact slice bytes; no broad regex discovery, arbitrary source selection or package/app evaluation. Baseline slice hashes are:

| Slice | Bytes / SHA-256 |
| --- | --- |
| `function trackCursor…` to before `const array =` | 851 / `3d0eeb64e6459481674bfb2d5e4ee400b1068a66049bce8d696cbc6166f4492e` |
| `const listCollections =…` to before `const bulkWrite =…` | 609 / `a2dbc6f5639c86df6dda6b5a462369c06849b365393fea3b7ecba1dd46281002` |
| `const listIndexes =…` to before `const find =…` | 470 / `b21869de0dda399270ad122199d2757b95aeed1ff4a467d39b4b7684f5047e6d` |
| `const find =…` to before insertOne/insertMany/updateOne/deleteMany loop | 1126 / `5282c5a3784a41e030e1b10f3de64dfff9e2d5edecab93222b6200c0c7bcf17d` |

Fake bindings supply client, sessions, leases, control/phase/options, fake prototypes and recorded callbacks; no ambient require/process/real driver is supplied to the VM. The assertion primitive is a recording fake. This tests actual guard/wrapper bytes in a synthetic closure, not invocation of complete createDatabaseBoundary or its module-global failure bookkeeping. The actual exported wire/budget/cleanup helpers and existing corpora separately check their real pure logic. VM and Node permissions are not hostile-code sandboxes; only reviewed fixed bytes are admitted. Reviewers must explicitly approve this test-only slice technique and its exact implementation before execution; otherwise request changes rather than silently adding runtime access.

Never call bootstrap main/direct entry, nativeSurface/installers with real capabilities, scenario.run, package loaders or DB constructors. Main contains dynamic network-admission import, egress canary, reflect-metadata/TypeDI/Mongoose loads, model/common/repository imports and connect/index work; all remain unreachable/unadmitted. Public driver sources are reference data only. No node_modules, compiled files, src1, .env, providers, network/DB/Docker, compiler or package installer enters the lease.

## Focused proof and future admission

After two current contract decisions, implement/restore the exact slice, then freeze source and obtain two exact source/launcher/execution decisions before running Node. Proposed launcher: pinned Python3.14.7, one owned fresh regular-file lease containing exactly the six files plus new lifecycle entry and `baseline-bootstrap.cjs`; Node argv per entry is the pinned absolute binary, `--permission`, `--allow-fs-read=<exact-owned-lease>`, fixed entry path. No child/worker/addon or filesystem-write grant, preload or permission expansion. Sanitized environment; only reviewed runtime-added public encoding metadata can be classified, never operational overrides. Parent owns identity-bound creation/removal. Bound each process to30s and1MiB output; preserve first failure, full raw outputs/exit/source/argv/tool pins and fresh exact-lease absence. No automatic cap increase/retry or removal of another process's directory. Foundation runner/README provide the pattern, not authorization for unstaged inventory entries.

Run only existing296 bootstrap and95 APM entries plus the new lifecycle corpus; require complete exact summaries, no skip/TODO/empty fallbacks. Do not replay the unchanged parent454/scenario371/import272/sites154/type44 campaigns. Planned new cases (NOT_RUN):

1. Bound baseline DB-only listCollections creation rejects; amended actual slice accepts exactly once and records one unchanged special lease. Special-at-creation, foreign/missing namespace, wrong client/session, duplicate lease and actual wrapper wrong phase/filter/options/control reject. Full-namespace find/listIndexes remain positive; DB-only/foreign full values reject.
2. Fake lazy initialization keeps object DB-only through started/succeeded; actual wire validation accepts only special replies with exact pairing. Reject database-only/foreign replies, nonzero/-0/Long/Timestamp APM IDs and extra cursor fields without normalization. Only fake successful initialization adopts ID then namespace then initialized; cover empty/buffered batch and close-before-init.
3. Preserve exact observed `undefined/null/false/0/''/Error` failure values before/after adoption and first failure when cleanup also fails, using actual cleanup/budget helpers. Required latches/deadline/row/byte/close denials persist. This is fake lifecycle evidence, not pinned driver's execution.
4. Named copied-source weakening controls must fail: premature full creation expectation; DB-or-special union; DB-only-for-every-command/ignored namespace; ignored client/session; changed special lease; relaxed actual reply; swallowed cursor failure. Preserve byte copies/diffs and actual failed named checks, not a self-reported sensitivity flag.

The missing uncommitted candidate `df37a3a8…`, lost final296 raw records and57-case lifecycle corpus stay missing. Fresh evidence gets its actual count/new hashes; never recreate old PASS or target57 to match memory. The surviving pre-correction296 record is historical, not this candidate's result.

Inventory runtime3 remains failed (`OWNED_DATABASE_CONNECT` / `INVENTORY_CURSOR`, null case/variant/phase), reviewed/cleaned with consumed source/artifact/once approvals. Its exact cause is not established by this source mismatch. Pure checks cannot retry it, prepare an artifact or certify MongoDB/Mongoose compatibility, stock correctness or pharmacy flows. Full [C3](C3_MONGO_FIXTURE_CONTRACT.md) pre-import admission and [C2](C2_COMPATIBILITY_REVIEW.md) root/runtime/build/start gates remain. Final cross-module integration remains DEFERRED_BY_OWNER, not PASS; focused checks remain required.

Stop for two nonauthor contract reviews. No Node/--version/package/TS/application/database/Docker/provider/network/model-auth call, fixture implementation, Git change or selected R4 input change was performed for this draft.
