# Customer, pharmacy and lab programme — current progress

12 November 2026. Active aim: complete the individual customer, pharmacy and lab modules against the existing design with parallel local workers, minimum nonredundant code, independent technical reviews and genuine Claude Opus 5.5/xhigh review through the existing local connection where available. Corporate, HR and hospital expansion and the final cross-module integration campaign remain deferred. Focused verification and application/owner/release gates remain required.

This is a living implementation-status note, not module acceptance. Worktree: `SwasthaDisha-worktrees/customer-pharmacy-lab`, branch `m0/customer-pharmacy-lab-focus`. Latest committed source candidate is `abd1e90be9dfd7012dd20b9646ed4f494778726a`; context `161537a34b9cfecf3499b39e2d8624d641009cf7` adds only tooling/evidence. Read the [execution direction](CUSTOMER_PHARMACY_LAB_EXECUTION.md), [scope](CUSTOMER_PHARMACY_LAB_PLAN.md) and [gaps](CUSTOMER_PHARMACY_LAB_GAPS.md) together.

| Reviewed source milestone | Commit | Actual evidence | Remaining verification |
| --- | --- | --- | --- |
| Customer booking detail/by-user ownership | `11e9c8bf` | Two independent contract and source decisions; signed owner and early denials | Actual focused HTTP/service behavior and type validity NOT_RUN |
| Individual lab booking association | `37b798d` | Two independent contract and source decisions; two client-association fallbacks removed | Actual focused behavior/type validity NOT_RUN; coupon/provider effects not rolled back by this slice |
| Customer generic booking write ownership | `c6a0b7ca6d90a1d55712178e02ad41767c23db6c` | Two independent contract/source decisions; shared actor/owner resolver for detail/update/delete; 21 lexical weakening controls rejected | Runtime/type validity NOT_RUN; final ownerless mutation race, privileged own fields and deletion policies remain P0 |
| Pharmacy completion prescription state | `abd1e90be9dfd7012dd20b9646ed4f494778726a` | Two independent contract/source decisions; completion-only guard after payment; exact observed-state CAS before same-session consumption | Runtime/type/rollback/race checks NOT_RUN; authenticated clinical approval/versioning and earlier fulfilment remain open |

The write-owner change reuses the existing actor guard and one owner-scope helper; the pharmacy change adds one guard and one completion-only CAS predicate. No new business framework, DTO, duplicate stock algorithm or corporate/HR/hospital expansion was added.

## Direct independent reviews

Customer write-owner: Spec `/root/booking_read_spec`, Standards `/root` (both nonauthors). See [decisions](../../../output/qa/customer-booking-write-owner/SOURCE_DECISIONS.json).

Pharmacy completion: Spec `/root/booking_read_spec`, Standards `/root/customer_booking_writer` (neither implemented this candidate; the latter authored its contract but did not approve that contract). See [decisions](../../../output/qa/pharmacy-prescription-consumption/SOURCE_DECISIONS.json). These native Codex decisions are not Claude, clinical, finance, owner or release approvals.

## Claude/Ruflo and focused tooling

Existing account sign-in and Ruflo metadata connection are confirmed. Revision2 failed authentication with zero model inference because its clean environment lacked public macOS identity context. Revision3 restored that context, obtained actual `claude-opus-5-5` inference and one successful Ruflo inbox peek, then failed in process observation. No substantive Claude review completed. Its supervisor cleanup remained unresolved; Root separately verified and cleaned its exact three process identities and recorded all absent/group empty. Failed receipts and captures remain preserved. Requested effort is xhigh; effective effort remains UNPROVEN. Native VS Code webview acknowledgment remains false; bundled CLI activity is not relabeled extension activity.

The single observer/cleanup implementation is being amended under two actual failure/implementation reviews. A fresh combined source packet is in preparation; consumed approvals are not reused. See the [actual failure](../../../output/qa/customer-pharmacy-lab-claude-review/operator/ACTUAL_FAILURE_3.json) and [failure decisions](../../../output/qa/customer-pharmacy-lab-claude-review/operator/FAILURE_DECISIONS_3.json).

Historical pharmacy fixture source bytes were recovered from Git as inert data at `cc66925`; missing uncommitted cursor corrections and their raw QA remain missing. Node22 tool bytes are now recovered and independently hash/identity/mode verified; Node has not been executed. The first reviewed invocation refused before allocation/network because macOS supplied a public text-encoding key; that denial is preserved at `161537a`. The narrowly amended operator obtained two fresh exact acquisition decisions, fetched the fixed official archive (49,996,369 bytes), verified both archive and binary hashes and retained only the isolated 0500 tool. No cleanup exception or residual stage prefix was observed. [Actual result](../../../output/qa/pharmacy-node22-recovery/revision-1/ACQUISITION_RESULT.json) and [independent readback](../../../output/qa/pharmacy-node22-recovery/revision-1/ROOT_READBACK_2.json) distinguish bytes-only recovery, accepted installed-stdlib/native-deadline assurance limits and the stage-path readback limit. Fake Python checks are not pharmacy runtime evidence.

## Next ready work and completion limits

1. Finish the genuine combined Claude source review, preserve actual model/tool/findings/cleanup evidence and address any findings.
2. Complete the reviewed isolated-tool recovery; separately admit focused checks and reconstruct the missing inventory cursor correction without inventing old PASS records.
3. Review the individual lab dependent-ownership draft, then implement only its approved bounded scope.
4. Contract remaining customer privileged writes/contact changes and pharmacy/lab clinical, financial and provider boundaries against the original design and applicable named owners.
5. Continue original-scope coverage, including pharmacy app/counter/direct/approved-wholesale and API/panel/direct labs; supported client sources and owner decisions remain explicit gaps.

No included module, calendar week, M0, deployment or release is complete. Final integration campaign is DEFERRED_BY_OWNER, separate from required focused verification. No push, deployment, protected-log access, real payment or provider action occurred.

Original checkout preservation was independently rechecked after the source work: branch/HEAD unchanged, all six staged and working bytes unchanged, exact full-index staged patch SHA-256 `00b2ad0daae9ac54adda82e8a7eb1450ca25340be4412ac76f226bfd6c45ff9a`, all eleven handover files unchanged.
