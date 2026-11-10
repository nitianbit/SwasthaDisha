# Third-batch source composition review

10 November 2026. Baseline `eba7e5c82e3ff63af9e9a958fbd100733e1fc439`; source merge candidate `9fc38df8fdda6f238ac24f45468b5374ba3fcf5a`. Lead `/root` authored outbound source and integration records; `/root/wallet_read_contract` authored wallet reads. Both source slices had two independent contract pre-reviews and two nonauthor implementation approvals before local integration.

| Source lane | Frozen commit | Implementation reviewers |
| --- | --- | --- |
| Outbound notification/Meet guards | `2ea38267c361e6b3322459bcd22c2be1dc22e09c` | `/root/batch2_security_check` Standards/security; `/root/outbound_spec_review` Spec; both APPROVE_SOURCE_ONLY |
| Wallet/transaction ID reads | `d3a1f82147c0b3346abab43e6e34d260171b0c25` | The same two independent nonauthors; both APPROVE_SOURCE_ONLY |

## Composition decisions

| Independent nonauthor | Decision | Verified evidence |
| --- | --- | --- |
| `/root/batch2_security_check` | **APPROVE_SOURCE_COMPOSITION** | Independently reran the inspected sanitized composition command; all 14 lane files match commit bytes/modes, exact three-file production union, no overlapping writers/unexplained additions, unrelated harness/dependency/start/register unchanged, original staged/handover preservation and whitespace pass |
| `/root/outbound_spec_review` | **APPROVE_SOURCE_COMPOSITION** | Independently verified actual merged route/middleware/owner/lookup/response ordering, all four frozen candidate hashes, source scope and unchanged root/harness/register; reran composition and confirmed original preservation |

Both reviewed the exact source merge candidate above and working-tree records with these SHA-256 values:

- `verify-source.py`: `244eaf5450404c6b81572435d2c88f63c14e2146f63cd088ce4320ff0b218dbb`.
- `lane-heads.json`: `6172229eb82a10cdbc3527a35de3f43e4279256adf8ac8f3f6325ea126d47b87`.
- `PARALLEL_WORKSTREAMS.md`: `c3b8c154226dddafca47e55f98fc38ccb81f8f179ac6ee7d166a0d17298f7168`.
- `M0_A_PROGRESS.md`: `a378256c167482141d132dd3749eaf344322561d6c19bef0816fca8f895fd54c`.

No material composition findings or source amendments. This provenance record changes none of those reviewed inputs. All are internal Codex technical reviews, not external Review A/B, owner, clinical, finance, security-owner or release approvals. No reviewer executed TypeScript, app, DB, provider or Docker code for these decisions.

## Commands and limits

From integration: `env -i PATH=/usr/bin:/bin TMPDIR=/tmp /opt/homebrew/bin/python3 -I -B output/qa/batch3-integration/verify-source.py`. The [receipt](verification.json) reproduces exact lane/source hashes and original six-staged/eleven-handover preservation. The checker only reads bytes and Git objects. A generated source check does not certify Express dispatch or actual provider effects.

The source changes remain local and are not deployment protection. All new HTTP/JWT/client cases remain NOT_RUN pending complete C3. Current source authority does not prove a secret running JWT key, revoke outstanding tokens, repair rewritten contacts, change a monetary/clinical policy or close other routes. Scenario outcomes remain 0 PASS, 1 FAIL, 1 BLOCKED, 110 NOT_RUN, 3 DEFERRED.

The foundation operator packet is not part of this composition approval. Its initial Spec review requested accurate attempt-versus-invocation bookkeeping; no operator or Docker run occurred before amendment. Any later packet merge, changed lane configuration or real invocation requires its own exact review and truthful result record.

## Foundation follow-up and final composition candidate

The paragraph above records the earlier source-only review boundary. The later foundation lane `aab5188af3c3dc1223a30c7bd767913f80eaee47` adds only 32 files under its evidence prefix. No application/harness source changed. Two nonauthor reviewers separately approved amended operator `8586e6ad4a3482aa033b5d98a3c9da3eae3c81324824df163ea13bb7b4092651` for one exact run, and root executed it once on clean detached `eba7e5c`, with result PASS for the fixed no-DB scope. Both reviewers then returned **ACCEPT_BOUNDED_RUNTIME_EVIDENCE** after independently recomputing the bundle/network summary and checking raw approval/claim/result/source/cleanup evidence. [Actual provenance and archive](../batch3-network-recipe/REVIEW.md).

The archive manifest SHA-256 is `b64ce47ef4a005386db65e47b3fd98b92d0a80f45bff47edc914ab86594379b0`; all 24 archived execution/bookkeeping files remain byte-identical. Approval is consumed. The archive excludes the operator ownership marker and blank Docker configuration. No real provider/DB/domain endpoint was admitted; only the explicitly named pure helper executed.

The final lane configuration includes this evidence-only lane. The composition verifier changes only its status/field wording from generic runtime to **domain runtime** so the independently accepted helper smoke is not described as unexecuted. Its ownership, byte/mode, source-union and original-preservation checks remain the same. The progress records add the measured result and retain every unresolved C2/C3/M0/clinical/finance/security/deployment gate. Final independent review of this bounded configuration/record amendment is pending; the earlier source approvals are not silently extended to it.

### Final decisions (supersede the pending status above)

Both independent nonauthors reviewed source merge HEAD `f47b21dce10a95ec879b0d82dfb2175ecb40d173` and the exact six-record working-tree freeze:

| Reviewer | Final decision | Evidence and limits |
| --- | --- | --- |
| `/root/batch2_security_check` | **APPROVE_FINAL_COMPOSITION** | All 46 lane files match reviewed commits/modes, exact three-file production union retained, all 24 archive files and five frozen packet inputs reverified, original staged/handover preserved; no material finding |
| `/root/outbound_spec_review` | **APPROVE_FINAL_COMPOSITION** | Independently reproduced composition, byte-identical archive and packet/source/summary hashes; checked accurate helper PASS versus unrun domain cases and consumed one-run status; no material finding |

Reviewed hashes: verifier `2b1c047e344f9ab82af4f79d098e0c0a59bf26f4b54757533eef2f126ceea45c`; lane configuration `f3883c378b85fec59551b1cc03519db661df8fe444a8e78eae0f29ed6ef4f69f`; this review before this provenance append `a0b7bee25970fdce32fa2a90547fa7329e28361b12e1aa47f684cda11f16c829`; composition receipt `42013608c861dde7bb86e9be0a2deb909674d539a6c1cb5cdb84ea31b7e005e5`; workstreams `7439003be1f4219e5d0cc2a053554eb10fb2ac7428cf01b79a2cfd815e1cd29e`; progress `5c3af140f403d55868f15b2b5cb54db8afa8de62bb5767be04ce23da6a4804c9`.

Both reviewers ran read-only Git/Python data checks only, with no repeated runtime/unit/Docker/Node/helper execution. These approvals grant no further run, full-C3/domain/backend/DB/provider/M0/deployment or named-owner/release acceptance. This final provenance append changes no reviewed source, packet, archive, verifier, lane configuration, progress record or result receipt.
