# Parallel OTP slice: cryptographic generation

10 November 2026. Branch `m0/parallel-otp`; common baseline `bfb608ea1a89551f6cd72ec5ee1349a3ee7abef7`. Author `/root/parallel_otp` owns only this contract, lane evidence and `src1/modules/auth/services/index.ts`. Other branches own application isolation and command authorization; the lead owns integration and shared progress/package/start files.

## Bounded contract

Replace the three non-cryptographic `Math.random` OTP generators in `AuthService.sendOTP`, `sendEmailVerificationOTP` and `sendCorporateEmailVerificationOTP` with the standard-library `randomInt(100000, 1000000).toString()`. Import `randomInt` from `node:crypto` once. Preserve every other production byte, including the existing OTP-generation comment, caller-selected channel/contact, six-digit decimal range, string type, persistence, expiry, provider dispatch, results and errors. No helper or dependency is needed. If cryptographic generation fails, no insecure fallback is introduced.

The Node 22 API uses an inclusive lower bound and exclusive upper bound; this preserves `100000` through `999999` without modulo mapping. Omitting a callback retains synchronous generation. [Official Node 22 crypto documentation](https://nodejs.org/docs/latest-v22.x/api/crypto.html#cryptorandomintmin-max-callback). This is an existing-runtime API choice, not a runtime pin or root dependency adoption.

Before source edits the lead must review this exact scope. Original source SHA-256 is `cfdc147df14c4bb9f9974d7211a8cabc3b3af5af2a4ec562a71c2bcaadbe03ad`; the proposed minimal source is `58323c9324411ab48e69d06e4e84ed76e9e01690a9200ac416a937d9a6836390`.

## Verification and acceptance boundary

Retain a standard-library source-data verifier that constructs the exact amendment from the fixed baseline and requires byte equality. Record a pre-edit rejection, post-edit acceptance and negative source controls for the original code, each independently restored generator, incorrect range, missing import and insecure fallback. These controls inspect source text; they neither execute an extracted generator nor demonstrate OTP delivery, entropy quality, backend compatibility or authentication behavior.

Complete C3 admission remains required before importing/evaluating application code or extracted methods. No compiler/install/build/start, provider/DB/Docker action, real OTP or deployment is part of this slice. Source-only verification cannot close TC-REV-001 or TC-SEC-001. Preserve scenario statuses, the original checkout's six staged Ruflo files and handover archive. No production environment details are requested.

Purpose/target binding, protected challenge storage, attempt/resend controls, atomic consumption, contact/corporate authority, credential/session recovery and outstanding-challenge invalidation remain separate contracts/operating decisions. This patch improves the generation source only; it does not declare the OTP lifecycle or running service safe.

## Review and integration

The lead `/root` approved source-only implementation against preimplementation contract SHA-256 `80bf6dba8165080e1f67ec7252067b2e7f715c2a007c97f8112d7693b2bbe1db` before production edits. The exact minimal source amendment is implemented; [retained commands and receipts](../../../output/qa/parallel-otp/verification.json) record pre-edit rejection, post-edit acceptance and nine rejected source controls. No TypeScript was evaluated. The completed lane is frozen for independent Standards and Spec review. Commit/push/integration occurs only when directed by the lead; this branch grants no release approval.
