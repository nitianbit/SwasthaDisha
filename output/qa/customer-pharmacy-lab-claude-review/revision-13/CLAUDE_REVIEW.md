# SD-CLAUDE-LAB-REFILL-REVIEW-13: source-only review, nothing executed

**What I received.** Session a321d4d7-574f-4cc8-8528-aea6d72002fa. Snapshot 2c09f09858f569f9f0081c6792604dc337fb118a. Challenge msg_1794533678318_d1qenoyo, nonce be6ddf30-74ad-472a-887d-4018bdd2174b. The packetSha256 is c0798e9b975e62288a241a62795d85cafc102b424a6fc44133157a3e8795c6d0; I took it from the challenge. The contractBundleSha256 is 2771d786a23886d5537427c1ead6ffed1be69e4a93c063812033a9c81f109740, the same as the challenge's contractSha256.

**Map and hash check.** All 16 source and 4 contract path-to-hash pairs in the packet match the challenge exactly. I had no hashing tool, so every hash statement here compares supplied strings. I calculated none myself. I can't show that the packet fit my context window; I reviewed every packet file at full length.

**Model.** claude-opus-5-5, taken from this session's environment declaration. Requested effort was xhigh, not max; the effort actually used is unproven.

**Earlier decisions.** I treated earlier Codex and Root decisions as background only, not as part of this review.

## Verdicts
- **R13-LAB: APPROVE_SOURCE_ONLY.** No blocking findings; 5 non-blocking notes.
- **R13-P7: APPROVE_SOURCE_ONLY.** No blocking findings; 2 non-blocking notes.
- **R13-COMPOSITION: APPROVE_SOURCE_ONLY.** No blocking findings; 1 non-blocking note.

**Nothing below was run (NOT_RUN):**
- parsing or TypeScript type-checking
- Node, Ed25519 or other crypto
- reads of the protected root and evidence files
- native BSON handling
- MongoDB queries, index changes, catalogs, or listIndexes by UUID
- transactions, compare-and-swap writes, races, retries, replay or rollback
- HTTP, Joi validation, the Mongoose layer, explain plans or capacity

This review does not mean a business module is complete, does not record owner acceptance, and does not activate anything.

## R13-LAB: checked against the S2-A addendum (dbe33757…)

1. **Command and envelope parsing** (labAuthorityRoot.ts:69-89)
   - The size limit (16384 UTF-8 bytes) is checked before parsing. The copy is bounded to 512 nodes and depth 8.
   - The envelope must have exactly 2 entries and match its own JSON.stringify output byte for byte. That rejects objects, duplicate keys, alternate escapes and number forms, BOM or whitespace, and -0.
   - The signed body B has exactly 12 entries. Each action's payload is checked for exact length and format. The signature must be exactly 64 bytes in canonical base64.
   - Only UTF-8(JSON.stringify(B)) is signed. commandSha256 covers those bytes only; signature bytes are not part of the identity.
2. **Earlier Unicode and size findings: confirmed fixed**
   - text() (Root:61) rejects isolated surrogates with a UTF-8 round trip. This runs before the NFC, trim, code-point and control-character checks. It is the only gate for both free-text fields, on fresh commands and on stored history. Nothing is repaired.
   - For stored proofs (labAuthorityProvisioning.ts:72), commandJson is limited to 16384 bytes and the signature to 88 characters. Both checks run before the inner parse and re-stringify (:74), and canonical decoding still happens there.
   - Reading the code, valid NFC text and paired astral characters still pass.
3. **Root and evidence files** (Root:91-138)
   - Fixed paths. The resolved path must equal the given path. No parent directory may be a symlink or group/other-writable.
   - The file is opened with O_NOFOLLOW and the descriptor is held. It must be a regular file with one link, owned by root or the service user, mode 0400 or 0600. Reads are bounded.
   - Device, inode, link count, uid, mode, size, mtime and ctime are checked again before use.
   - The root holds exactly one Ed25519 public key. keyId = SHA256(DER). writerManifestSha256 must equal the recomputed manifest aggregate.
   - guard() (Prov:33-36) re-reads the root and requires identical bytes around every read and write.
4. **Who may act**
   - The issuer is the root's issuer and must be a current, active personal User. The lookup projects only _id, userType and isActive, and inspects the native ObjectId directly (Readiness requireLabIssuer).
   - Grant and revoke cannot target the issuer (Prov:142, :79).
   - Only grant requires the subject to be active (:159). Revoke never reads the subject.
5. **Fresh commands versus history and replay**
   - :131 checks the submitted bytes with historical=true, but only so an exact replay can be admitted.
   - Before anything new happens, :141 checks again with historical=false, which requires an active root.
   - History checks (:77) are made at the stored createdAt and also accept a verification_only root.
6. **Mapping is create-only**
   - The lab and organization must both be absent (:146). Then three inserts run.
   - _id and unique-index collisions (duplicate key 11000) become 409 (:198).
7. **Grant, revoke and regrant**
   - **Mapping check.** The mapping is checked in both directions. The lab fields must equal the signed map payload (:98-112).
   - **Pre-checks.** The org fence is compared before any write (:152), then membership identity and revision (:155).
   - **Regrant (revision 2 to 3).** The code authenticates exactly D at R and G at R-1, using bounded filters and a full reconstruction (:89-97). G's validity is checked at G.createdAt. createdAt values must be in order. G's fence + 1 must be below D's fence, and D's fence must not exceed the current fence.
   - **Vectors.** The 1→2→3 sequence with fences 2→3→4 reconstructs consistently.
   - **Revoke** ignores lab and membership expiry and the subject's state, and binds the prior grant (:166-170).
8. **Writes**
   - Membership and organization updates compare the whole stored document ($$ROOT) before writing; the org write also increments the fence (:117-123). Decisions are append-only.
   - Everything runs in one owned session: snapshot reads, majority writes. Server time is read once per callback, and every guard runs again on each retry.
   - The receipt is exact, frozen, and contains no user or evidence data.
9. **Replay**
   - The organization + operationId lookup runs inside the transaction.
   - A different commandSha256 or commandJson → 409 (:135).
   - An identical command → full history re-authentication, including evidence and the prior grant. The receipt describes the committed operation only, not current authority.
10. **Pharmacy authority unchanged**
    - **rules.ts** only adds the lab_membership_revoked serializer branch, before the professional branch.
    - **Unchanged by text comparison with b846486:** the three original serializer branches, capability() (which still excludes lab.worklist.read), the evaluator and the fingerprint.
    - **Repository and services:** hashes match the R7 values (14532bf2…, ccac5254…).
    - **Types and model:** changes are additive only. A lab BusinessScope still cannot be created.

### LAB notes (no change required for source-only approval)

**LAB-N1 (LOW, contract alignment): labAuthorityReadiness.ts:67-71**
- **Trigger:** the default connection differs from exactly this profile:
  - directConnection=true
  - retryReads=false
  - maxPoolSize 1 or 2
  - timeouts of 5000 ms or less
  - no credentials
  - tls not true
- **Effect:**
  - Every action fails with 503, including on any authenticated or TLS deployment.
  - This transport profile is not in the S2-A addendum; it mirrors the refill fixture draft. Failing closed is safe, but the only profile the writer can run on is unauthenticated plaintext.
- **Minimal correction:** state this exact diagnostic profile in the addendum or manifest scope, or name it as a blocker for activation.
- **Focused verification:** one negative test per option (default retryReads, pool 100, credentials present, tls true). Each must return 503 with no effects.

**LAB-N2 (LOW, availability design): Prov:82 reached from :103; Root:141 and :134**
- **Trigger:** the root is reissued (same generation and key) with any mapped branch removed from its scopes, or it moves to verification_only or expires.
- **Effect:**
  - The mapping-proof check applies the scope check to all mapped branches against the current root, and a fresh revoke requires an active root.
  - So no member of that lab can be revoked (403 or 400) until the root is restored.
  - This matches the contract, but it ties incident response (narrowing scope or quarantining the key) to losing the ability to revoke.
- **Minimal correction:** none in this increment. The required key-rotation, reauthorization and lifecycle contract should define a revoke-only path before activation.
- **Focused verification:** a negative test recording revoke denial under a narrowed scope as expected behavior, plus that later contract's positive test.

**LAB-N3 (INFO): Prov:196-200**
- **Trigger:** any failure that is neither a LabAuthorityError nor duplicate key 11000, including read or network failures before commit.
- **Effect:** reported as 503 with commit outcome UNKNOWN. This over-reports safely and matches "UNKNOWN until the same operation is read back", but callers must always resend the identical envelope to learn the outcome.
- **Verification:** inject a fault before the first write → UNKNOWN; the identical retry then commits fresh.

**LAB-N4 (INFO, platform): Root:94**
- **Trigger:** running on macOS, where /etc resolves to /private/etc and /var to /private/var.
- **Effect:** the resolved-path check fails, so root and evidence reads always return 503 there. This review's host is darwin; the fixture must use Linux paths. No change needed.

**LAB-N5 (INFO, native dependency): Readiness:166**
- **Dependency:** the code runs listIndexes against the collection UUID and expects cursor.ns to be "db.collection".
- **Status:** that MongoDB 8 behavior was not exercised (NOT_RUN). It must be proven in the admitted fixture, together with UUID stability (before and after listCollections) and cursor cleanup.

## R13-P7: due-refill read and resume

1. **Route** (routes:24-26)
   - Order is cache header, then the operational guard, then the handler. /due is registered before the parameter routes; there is no conflicting GET /:id.
   - The controller (:20-24) passes only the guard-resolved pharmacyId and the raw req.query, and sets the header again.
2. **Scope order**
   - The service (:169-172) returns 403 for a bad scope before parsing, and parses before calling the repository.
   - The repository checks scope again (repository:74).
3. **Query parser** (validation:72-95)
   - **Accepted input:** only the three own, enumerable data keys, on an Object or null prototype; proxies are rejected.
   - **through:** required calendar date. setUTCFullYear keeps years below 100 correct; year 0000 is rejected.
   - **limit:** canonical 1 to 50.
   - **cursor:** base64url alphabet, at most 384 characters, decoded size at most 288 bytes. Canonical re-encoding, UTF-8 round trip, exactly 6 keys, and binding to owner, cutoff and limit. The cursor date must not be after through, the ID must be lowercase, and a fixed-order re-serialization must match (rejects duplicate, reordered or alternative JSON).
4. **Database query** (repository:76-83)
   - Owner via $eq ObjectId, isActive via $eq true, cutoff via $lte.
   - $expr requires scalar types for _id, pharmacyId, isActive and nextRefillDate, so array-valued rows are excluded.
   - Keyset continuation via $or. Fixed 7-field projection, simple collation, sort by date then _id. limit+1 (at most 51), maxTimeMS 2000, lean. No populate, count or skip.
5. **Raw result handling** (repository:84-103)
   - The result array is checked: Array prototype, not a proxy, length as a data descriptor and at most limit+1.
   - Indexes are read through descriptors only: dense, own, enumerable data entries. No supplied map or iterator is called.
   - Every row is validated, including the lookahead row, and must be strictly ordered after the cursor.
   - nextCursor comes from the last returned row, and only when a lookahead row exists. Any error → 503 with no raw text.
6. **ObjectId handling** (repository:14-43)
   - The prototype must be exact.
   - The module-private Symbol is taken from a fixed-string probe, not from its description. Only that symbol and __id may be own data keys.
   - Bytes are copied by descriptor into an owned buffer, and hex comes from the built-in Buffer.prototype.toString. The cache must match.
   - No supplied getter, toString or toHexString is ever called.
7. **Response shape:** exactly the six documented keys. An absent channel or pause date becomes null. A present null, undefined or invalid value → 503.
8. **Resume** (services:191-198)
   - When isActive===true, the same findOneAndUpdate does $set (the payload without pausedUntil) and $unset pausedUntil.
   - A pausedUntil sent at the same time by a direct caller cannot override the resume. Repeating it is idempotent.
   - By text comparison with e192, the only service changes are :13, :169-172 and :191-198. The 404 and 403 order is unchanged.
9. **API_SCHEMAS:** the new section matches the source.

### P7 notes (no change required for source-only approval)

**P7-N1 (INFO, capacity): repository:82-83 with model:36**
- **Trigger:** the only matching index is {pharmacyId:1, isActive:1}.
- **Effect:** each page does an in-memory top-k sort over all of that pharmacy's active rows. For large pharmacies, maxTimeMS turns this into a 503 instead of a slow page. The contract acknowledges this.
- **Correction:** later, a separate create-only contract for an {pharmacyId:1, isActive:1, nextRefillDate:1, _id:1} index.
- **Verification:** the owned explain/executionStats with 80 rows that is already planned, plus a representative-volume run before activation.

**P7-N2 (INFO, adjacent behavior): services:123**
- **Trigger:** reconcileForOrder sets isActive back to true without clearing pausedUntil.
- **Effect:** those rows appear in /due with the old pause date and pauseEvaluation "not_evaluated". The contract limits this fix to an explicit PUT resume, so this is not a defect here. Record it for the P7 dispatcher contract so a stale pause date is not treated as authoritative.
- **Verification:** a fixture case where reconcile reactivates a paused subscription; the row is listed with its pause date kept.

## R13-COMPOSITION
- **No overlap:** the two increments share no files. API_SCHEMAS changes only for P7.
- **No wiring:**
  - The src1/routes/index.ts hash (9be84117…) matches R11, so the lab operator has no route, start or job wiring.
  - operators/labAuthority.ts only re-exports. Root, file and catalog reads happen only inside provisionLabAuthority.
  - Models register on first use only, with autoCreate and autoIndex off, so there is no index creation or other DDL.
- **Shared models:** createAuthorityModels keeps one set per connection (WeakMap), so the pharmacy read port and the lab writer use the same models.
  - The additive model fields do not change whether pharmacy rows are valid, and pharmacy projections exclude them.
  - The evaluator still rejects the lab kind and lab capabilities.
- **Not production adoption:** Mongoose 6.13.8, driver 4.17.2, BSON 4.7.2 and local Mongo 8 are a diagnostic profile only; the writer hard-requires 6.13.8 (Readiness:59).
- **COMP-N1 (INFO): Root:122-123.** At runtime the manifest aggregate is checked only against the imported JSON, so the manifest attests to itself. Whether deployed bytes match remains C2/C3 build and release evidence. Recorded only.

**Gates that remain open (none waived; I did not ask the owner):**
- withheld C2 deployment facts
- root build/start, compatibility, owner, clinical, finance, security, release and capacity gates
- real root, evidence and key custody, MFA, all-writer exclusion, restore, lifecycle and reauthorization
- S2-B and L2
- full P7: no reminder dispatcher exists; preparing the real fixture is on HOLD
- F1 HIGH, F5-1 MEDIUM and R10-F2-2 are still open
- the latest private focused run failed in API_SCENARIOS/OBSERVED_CATALOG; cleanup was verified, the cause is unknown, and no cases were accepted
- the customer-contact full flow is not reviewed here
- R12 approved only the older private-core corrections
- corporate, HR and hospital work and the final cross-module campaign are deferred by the owner; the original eight-week total target is not reset

**Method:** I read the supplied packet as inert text, peeked the inbox once and sent twice. No shell, filesystem, hashing, parsing, compiling or code execution.