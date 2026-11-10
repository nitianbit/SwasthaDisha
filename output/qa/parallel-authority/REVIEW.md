# Independent reviews: own-recipient notification routes

10 November 2026. Branch `m0/parallel-authority`; baseline `bfb608ea1a89551f6cd72ec5ee1349a3ee7abef7`. Author `/root/parallel_authority`. Lead `/root` reviewed the concrete four-route contract before production edits.

Both final decisions bind manifest `f78ee9674ac27afa6be9c48162ea9c7988762e1a5af8690334bf8e979144ff7c`, its four file hashes and production patch `a7982b039ef359689c0c722b17518d2b323660089155871e9896451f0b059364`. This subsequent review record is excluded from the frozen manifest to avoid circular hashes.

**Standards — internal Codex `/root/parallel_otp`: APPROVE SOURCE-ONLY.** Independently verified the inventory/patch and reversed the exact helper/import/guards/annotations to recover the byte-identical baseline controller. Existing self-success source and other handlers remain unchanged. `AuthRequest` declares a string `_id`; existing `AppError` conventions provide missing-identity 401 and cross-recipient 403. All four guards precede service access. No material Standards finding; the private helper avoids repeated authority logic.

**Spec — internal Codex `/root/parallel_foundation`: APPROVE SOURCE-ONLY.** Independently verified the same inventory/patch and source `37e8a353299cbd69df87cb904c0515061b160e6c73c699e23845349b09723a5c`, recovered the original controller by reversing the amendment and confirmed other production files unchanged. There is no admin exception; specialist `/me` paths remain untouched. Inspected before-edit rejection, post-edit acceptance, twelve negative source controls and actual guard ordering. No material Spec finding.

Both reviews were read-only source/hash inspection. No application/extracted TypeScript, provider, DB, Docker, compiler or runtime suite executed. Source controls are not runtime success/denial, zero-effect or supported-client evidence. Complete C3 admission and mounted-flow fixtures remain required.

General listing, single-ID reads/mutations, creation/broadcast and FCM sender authority remain separate open contracts. This is partial route containment, not complete notification protection or TC-REV-011/F04 acceptance. Scenario statuses, original staged files/archive, root dependency/start and release gates remain unchanged.
