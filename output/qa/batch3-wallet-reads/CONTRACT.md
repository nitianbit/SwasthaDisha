# Wallet and transaction ID-read authority contract

10 November 2026. Branch `m0/batch3-wallet-reads`; baseline `eba7e5c82e3ff63af9e9a958fbd100733e1fc439`. Status: **DRAFT FOR TWO DIRECT PRE-REVIEWS; no production edits or application execution admitted yet**.

## Bounded source scope

Only `src1/modules/wallet/controller/index.ts` may change in production: add the existing `AppError` import, use its existing `AuthRequest` import for the two handlers, and add principal/owner checks in `getById` and `getTransactionById`. Keep both success envelopes and all other controller bytes unchanged. Routes, validation, services, repositories, models, shared authentication, dependency/start/harness files and scenario outcomes remain unchanged. Evidence for this slice stays in this directory.

| Frozen source | Baseline SHA-256 |
| --- | --- |
| Wallet controller | `16c44f56c7c3962af0d70dbb01ad6e2fe0b174df612e58764948364454245471` |
| Wallet routes | `5ce3fc7bdd72140348df94787b0c4e47a19190ada5137a2971be84cbe584197c` |
| Wallet services | `938433ca68e0481bf86d2b69f5d56106fba04f913c94e326947bbd617fbc13ff` |
| Wallet model | `18757f38145a2ebab378cd1d00c423170a00fd3b136b1229105244fb1a540538` |
| Authentication middleware | `db0f9bb4307e46e3cd05968a9de8f7777f5de0c6ca1894254491e9d855f893a2` |
| Integrated configuration | `e879b0f9c635283d7c9a271128605c6d8583995356e30f5f1c318d23270d09f6` |

## Authoritative resources and actors

`GET /api/v1/wallet/:id` returns one wallet selected by wallet document ID. `GET /api/v1/wallet/transactions/:id` returns one transaction selected by transaction document ID; it is not a wallet transaction-list endpoint. The respective `WalletService` methods each perform one `findById` lookup and throw their existing 404 when absent. `BaseRepository.findById` returns `query.lean()` without population.

Both model schemas define `userId` as required **String**, and both TypeScript interfaces define it as the owning user's string identifier. A transaction's optional `walletId` is not the authority for reading that transaction. Do not query a second wallet, call the auto-creating `getByUserId`, or infer authority from the resource ID, request body, query, reference fields, corporate membership or an ID supplied by the caller.

| Principal | Access to existing resource |
| --- | --- |
| Exact `userType === 'admin'`, with a nonempty string principal `_id` | Allowed |
| Any other authenticated principal with nonempty string `_id` strictly equal to the fetched resource's `userId` | Allowed |
| Other patient, HR, specialist, pharmacy or unknown role | 403; no role/corporate bypass |
| Missing principal or missing/empty/non-string principal `_id` | 401 at the controller checkpoint before lookup |

This retains the actor rule already adopted for user-ID wallet reads. It does not newly restrict ownership reads to `userType === 'user'` or approve assisted access to another patient's finances. Case folding, trimming, ObjectId conversion and loose equality must not grant ownership. A missing/non-string stored `userId` cannot match a legitimate string principal, so non-admins fail closed. Admin reads preserve the existing response, including inactive wallets.

## Exact request/error order

1. Existing outer `authenticate` remains first: absent, invalid and expired tokens retain their 401 behavior. The JWT key must meet the existing fail-closed configuration contract; source changes do not establish the deployed key or invalidate old tokens.
2. Existing route `idParamSchema` validation remains unchanged: a malformed document ID returns 400 `VALIDATION_ERROR` before a controller lookup. A validly signed malformed principal combined with an invalid ID therefore still reaches this earlier validation error; no middleware-order change is claimed.
3. In each selected controller, require `typeof req.user?._id === 'string'` and a nonempty `_id` before its service call. Otherwise throw `AppError({status:401, code:'UNAUTHORIZED', message:'Authentication is required'})`.
4. Fetch the resource once using the existing service and path `id`. Preserve 404 `WALLET_NOT_FOUND` / `TRANSACTION_NOT_FOUND` when no record exists. No wallet is auto-created.
5. Before any response serialization, deny unless the principal has exact admin role or `result.userId === req.user._id`. Throw `AppError({status:403, code:'FORBIDDEN', message:'Access to another wallet is not permitted'})`; never echo identifiers, amounts or reference details. Never send a response or continue after denial.
6. Allowed requests retain the exact current 200 `{success:true, data:result}` envelope and data. Exceptions continue through existing `catchAsync` and `errorHandler`.

The necessary first resource lookup precedes object authorization. This contract promises no unauthorized data release and no state/provider effects, not zero database reads for an existing-other-object denial. Existing-object 403 versus absent-object 404 is explicit; no hidden-object policy or extra lookup is introduced.

## Verification and future admitted runtime evidence

Before production edits, obtain two direct independent nonauthor contract decisions. Source-only verification may read TypeScript as data using Python standard-library checks; it must reject the baseline, accept the exact reviewed transformation, reject removed/inverted/late/loose/request-derived owner checks and admin overblocking, and bind the production scope to this single controller. These checks do not execute TypeScript or certify HTTP behavior.

Mounted runtime cases remain **NOT_RUN** until complete C3 pre-import admission, owned disposable MongoDB namespace, sanitized configuration with a per-run ephemeral JWT key and all recording provider ports are established. Required cases include:

- Own wallet and own transaction return their unchanged response; admin can read each other owner's resource; inactive wallets remain readable. Verify the schema's actual stored string owner and decoded JWT principal representation.
- Patient A reading patient B's wallet or transaction gets fixed 403 with no protected data. HR, pharmacy and specialist principals receive no other-user bypass. A token's body/query `userId`, `userType`, `isAdmin` or `walletId` cannot alter this.
- Transaction ownership uses its stored `userId` even when `walletId` is absent; another user's transaction cannot be authorized by a caller-selected wallet/reference. Corrupt or inconsistent historical ownership data is not repaired by this slice.
- Missing/wrong-key/expired tokens retain 401; validly signed missing/empty/non-string `_id` fails before resource lookup for a valid document ID. Missing or non-string stored owner fails closed for non-admin.
- Malformed IDs retain validation 400 with zero lookups; valid absent IDs retain the respective 404; existing other-owner IDs get 403. Uppercase document IDs may resolve normally without case-normalizing the owner/principal comparison.
- Repeated and concurrent denied reads do not disclose data, auto-create wallets or change balances, activity, transactions, notifications, task rows or timestamps. Recording provider calls remain zero. Denied existing-object requests may perform only the required record read.
- Reintroducing either removed check, checking after response, trusting request owner fields, loosening equality or denying admin makes its real success/denial case fail. Source-negative controls alone cannot close these cases.

Known local usage in `test/test-api.ts:1645` and `:1657` reads IDs obtained for the test user, so own-user intent remains supported. That legacy test is unexecuted and its earlier patient credit setup is already incompatible with batch-two admin guards. Supported deployed/mobile client revisions remain unverified; callers relying on other-user data will now receive 403.

This slice implements the existing M0-B read-own-result boundary. It needs no new monetary, unit, settlement or commercial decision. Existing admin mutations, wallet races/refunds/coupons, contact authority, exposed files/webhooks, credential/session response, C2/C3, named-owner acceptance and deployment/release gates remain outside this change. No application, DB, provider, Docker or protected operational access is authorized by this contract.
