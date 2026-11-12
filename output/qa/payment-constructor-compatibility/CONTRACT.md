# PaymentService manual-constructor compatibility contract

Status: PREIMPLEMENTATION; two actual independent nonauthor contract votes are required before the test edit. Author: internal Codex worker `/root/payment_ctor_contract`, 12 November 2026. No author self-approval or external/Claude decision on this amendment is claimed.

## Purpose and source pins

Repair the known manual PaymentService construction after its new required nineteenth MedicineRepository parameter. This follows genuine R7 Opus 5.5 finding F5-3 and is source-only compatibility work.

Worktree: `/Users/shubham/Desktop/SwasthaDisha/SwasthaDisha-worktrees/customer-pharmacy-lab`; HEAD `5c66d43de645e8beaa6105fde9bb7a6f58431f0b`.

| Input | SHA-256 |
| --- | --- |
| `src1/modules/payment/services/index.ts` | `9c1086e3aa9239855ed3d73a02f941015d869bdb36a689a5294dea367ee7457d` |
| `test/pharmacy.integration.test.ts` | `49f97bb67d22423e58412b291d8019c0eb52ab0232a49e0909dd55b1b52565c3` |
| `src1/modules/pharmacyMedicines/repository/index.ts` | `2d3f1cc7e21804546bbdaa68d8316c9f3f4ae176f6cebc26626960908a02c2f3` |
| `output/qa/customer-pharmacy-lab-claude-review/operator/CLAUDE_REVIEW_7.md` | `ae72d9142373441cae8f0ebf19594134aef703f129ae33e1ee55c7ba822b576a` |

The lead's earlier independent discovery found one manual construction among 395 tracked code files: this test call. Production callers use TypeDI; the previously inspected ten-module MedicineRepository closure showed no PaymentService cycle. This is inherited source discovery, not repeated independent discovery or runtime DI evidence here. The graph was stale for this worktree; preparation uses that narrow discovery and directly inspected pinned sources.

## Exact delta after approval

Only `test/pharmacy.integration.test.ts` changes, in `pharmacy self top-up initiates payment and credits only after verification`, at the call beginning baseline line 528:

```diff
     new PharmacyWalletRepository(),
-    new PharmacyWalletTransactionRepository()
+    new PharmacyWalletTransactionRepository(),
+    new MedicineRepository()
   );
```

Arguments 1–18 retain their order and bytes. The nineteenth argument is a genuine instance of the already imported MedicineRepository (baseline line 21). Its zero-argument constructor wraps the existing MedicineModel. Existing createInventoryService/createOrderService helpers use this same construction pattern and test-context model. No additional import, setup hook, or fixture port is needed for this source repair.

Prospective complete test SHA-256: `e123eab6f5bde08475605f8ed47a1f3830cd97ecdd9c8fe2dd0f2aa49507d35e`, calculated in memory from the pinned original; no test edit has occurred at preparation. Changed inputs/delta require fresh binding and review.

No empty object, cast substitute, noop repository, optional/default production dependency or fallback container lookup. Preserve existing unrelated test substitutes and verifyAndMarkPaid override unchanged. Production PaymentService and MedicineRepository remain byte-identical.

## Source acceptance and review order

1. Obtain two actual independent nonauthor contract decisions on this document and pins before implementation; record reviewer identity, decision, scope and contract hash. This author supplies no vote.
2. Apply only the exact delta. Read source/bytes to verify the prospective full test hash, unique changed call, existing import, genuine nineteenth argument and unchanged first eighteen arguments. Verify the production pins and complete Git diff; preserve others' files and the original staged six/archive.
3. Obtain two actual independent nonauthor source decisions on the exact candidate and evidence before calling this repair source-ready.

Source inspection establishes that the argument is supplied. It does not establish complete TypeScript validity or runtime resolution. No new runtime test or lexical negative variant is required for this call-site adjustment.

## Execution limits and remaining evidence

The existing case uses wallet_recharge, then calls verifyPaymentAndProcess with a substituted verifyAndMarkPaid. It does not invoke the new pharmacy_order creation guard/catalogue-read closure. The repaired argument does not prove that gate succeeds, denies with 503, or avoids a runtime TypeError. TypeDI resolution and the pharmacy-order branch remain runtime-unproven.

This contract authorizes no Node/compiler/application import, SDK, Docker, database, provider, model-worker action, integration execution, commit, push or deployment. The suite imports application modules before its weak database-name check; its optional URI/skip convention is not C3 admission. Future focused execution requires its own fully reviewed pre-import application/provider/file/network/database isolation contract; the fixed MongoDB smoke is insufficient. C2/root dependency/build/runtime/start gates remain unchanged.

Final cross-module integration remains DEFERRED_BY_OWNER; focused checks retain their separate admission. No root build, module completion, clinical/financial/security-owner, M0, production or release acceptance follows.
