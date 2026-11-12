# Pharmacy authority and recovery — source baseline

12 November 2026. Two independent read-only explorers inspected the focus checkout at3f8de1a: /root/pharmacist_identity_fields and /root/pharmacy_refund_primitives. Graph discovery indexed original bfb608e; exact current source, call paths and targeted literal scans supplied these findings. This is discovery evidence, not runtime proof or an exhaustive deployed-system audit. No app import, operational data, provider call or mutation occurred.

## Individual reviewer authority

| Current primitive | Guarantee / gap |
| --- | --- |
| auth/types and auth/services | Personal User login exists. Pharmacy JWT _id and pharmacyId both identify the business, not an individual reviewer. Tokens last30days. |
| middleware/auth | JWT payload is trusted after signature validation; no common per-request active-person/membership/credential/revocation reload. Operational-pharmacy guard reloads active/verified/archive business state, not pharmacist qualification. |
| user/model; auth/services | User.isVerified is OTP/contact verification, not a professional credential. Existing patient controller denies self-update of verification/activity flags. |
| pharmacyCustomers linkage | linkedPharmacyId/createdSource/creator metadata describe assisted customer creation, not employment or review authority. |
| pharmacies model/update | Business license/document fields and verified flag exist; no individual owner/staff/branch/professional registry. Self-profile may replace license evidence without resetting business verification. |
| admin/profile | Admin.permissions is self-editable and currently not enforced by requireAdmin. It cannot safely become credential-verifier authority as-is. |
| pharmacyOrders | URLs and pending/not_required/approved/rejected values exist, but no first-party review command, person/evidence/version audit or professional qualification writer was found. |

No implemented shared business membership/capability/branch/qualification/protected-audit primitive was found in these targeted current TypeScript scans. HR employee records and specialist registration are different domains and must not be promoted into pharmacy authority by inference.

## Money and reservation primitives

| Current primitive | Reuse boundary / hazard |
| --- | --- |
| PharmacyOrderService.updateStatus cancellation | Owning operational pharmacy; status CAS then reservation release in one Mongo transaction. No refund obligation is created. |
| releaseOrderInventory / releaseBatchAllocations | Session-aware batch reservation return preserves quality status; legacy items use aggregate return. This is not proof of physical return and lacks a separate order-reservation identity. |
| PaymentService.verifyAndMarkPaid / terminal handler | Accepts authorized and captured gateway states as paid; cached paid rows skip fresh verification. Durable capture facts are absent. |
| processPharmacyOrderPayment | Transactionally applies an order's paid state after its claim; timeout handling and later queue/coupon effects have separate boundaries. |
| refundAbandonedPharmacyOrderToWallet | Credits the user wallet; no gateway refund API call. Wallet credit and later order/payment/stock state use separate transactions. Payer-pharmacy funding is not fully reconciled by this helper. |
| WalletTransaction refund uniqueness | Declared whole-order/payer partial key includes pending/failed rows, but helper checks completed rows only and swallows duplicate-key errors without verifying a completed winner. Actual index installation is unverified. A refund label alone is not proof. |
| PharmacyOrderService.markPaid | Admin/owning pharmacy can mark COD/in-store paid from supplied source/date/notes; no immutable collection-ledger fact is created. |
| createDirectPaidTransaction | Generic internal paid method does not itself enforce zero amount, although the observed pharmacy zero-payable caller passes zero. |
| Units | Orders/payments retain legacy decimal rupees plus paise projections; user-wallet amounts are decimal and have no currency field; pharmacy wallets keep both representations. New intents need explicit conversion contracts. |
| Other authority paths | Authenticated payments/verify does not reload operational-pharmacy status. Admin wallet transaction creation can forge refund-labelled references and uses a read/set balance path. Client module can influence non-wallet fulfillment routing. These cannot bypass new canonical proof/authority. |

No gateway refund call, durable refund intent/outbox, partial-refund budget or handover/return evidence aggregate was found in the inspected sources and targeted scans. Missing primitive findings do not prove absence in external/deployed systems.

## Selected exact source bindings

Paths below are under src1/modules. Unchanged source was checked by the explorers; revalidate before an implementation contract.

| Path | SHA-256 |
| --- | --- |
| auth/services/index.ts | d59d5ea23df586fbbdb5b9c4615bcbe0b716f649bdc02f3738088f87b0fbae56 |
| middleware/auth.ts | db0f9bb4307e46e3cd05968a9de8f7777f5de0c6ca1894254491e9d855f893a2 |
| user/model/index.ts | 8ab08c867008d9788fd2105b6ac840794fcd5d8b2c518de500119aa2536cf5c4 |
| pharmacies/model/index.ts | beda95d89a9773a8d5851dd923c363c83123a573f7391836dec69b13e5cfa177 |
| pharmacies/services/index.ts | 5976d374e9fcbf7118464b52b35488f39db7cef6e8cc457ef62f7422d7e58313 |
| pharmacies/validation/index.ts | 27ccd145bd6cf87a1f0322f3e3f8e2624c0ae25c0d488c07cc1ff2c7a9d84133 |
| admin/services/index.ts | 50faaaedfb50f132d3a03e55c5af24d85b992d0748fc428c872273b6d30de1ca |
| admin/validation/index.ts | 4491d536462bb2062b64fc8edac8609933b29844b851200c546bdfde2929cc49 |
| pharmacyOrders/services/index.ts | 75df8dffb4ead5043ab5f7c131302063068ea6b7c79e9b55fb582bd0481c71f5 |
| pharmacyOrders/model/index.ts | 86b2bb62e2e2191aff1f624f8dc344e97f519add9bd9ba02cfd2fffb37c7a2b8 |
| payment/services/index.ts | 39c29b050dbca15db431f5415ebaa5dec8bbf77c31637ee13112796cf13ab5a0 |
| payment/model/index.ts | 0824a3efc2f3056ca4817e16359881769bf4728563b2eb2bed0fb04dbc3ec1fb |
| payment/controller/index.ts | 07f4f2e750e1a11c5357cf8f01b813ff535ebadd5204bb7abbe97c7f4731ddeb |
| payment/validation/index.ts | fb0a7d46057efbcba85cf4c6aa59e8dc819a7888ebc717de03a1a84af8c1cdb0 |
| pharmacyInventory/services/index.ts | bb02c3bf808ad4101a156be755bb39d26e6585ee1fcfaa5d12cb0000f5efee06 |
| pharmacyInventory/repository/index.ts | 2cc825908777950cbfcf1cf4dea6cc12f0e6e97a41660fb413565db3fdd6e659 |
| wallet/repository/index.ts | 4db66107afa4ecb7db99a91c3d9216488a514145187e56bc0d589677e344b726 |
| wallet/model/index.ts | 18757f38145a2ebab378cd1d00c423170a00fd3b136b1229105244fb1a540538 |
| wallet/services/index.ts | 938433ca68e0481bf86d2b69f5d56106fba04f913c94e326947bbd617fbc13ff |
| pharmacyWallet/services/index.ts | 59513bb95f74e7b8e48911c2d48f400604d7d1d82cdfe3cdcb5bed0d2d168b61 |
| pharmacyWallet/model/index.ts | 2d7ce772916208f52b8febf27ad0442e2bd70f41b7ec9e3d9be3c2083d224b73 |

F1 and these prerequisite gaps remain open. Product policy is selected in the [delegation record](PHARMACY_DELEGATED_POLICY_DECISIONS.md); separately frozen authority, capture/refund and stock contracts must address them. No source mutation, clinical approval, money effect or release follows from this discovery record.
