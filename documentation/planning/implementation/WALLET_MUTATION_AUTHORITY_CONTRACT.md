# Wallet mutation and read authority slice: contract

10 November 2026, branch `m0/money-provider-clinical`, baseline `9ea963f`. This is amendment 2. Amendment 1 followed an internal Claude subagent pre-review of `80da7ff` (APPROVE WITH REQUIRED AMENDMENTS) and the lead's wider scope. Amendment 2 follows the nonauthor internal Claude final reviews of `6facb0f` (Standards: APPROVE WITH NITS; Spec: REQUEST CHANGES, documentation only). Production code is unchanged from `6facb0f`. Runtime is **NOT RUN**.

The production change touches only `src1/modules/wallet/routes/index.ts` (baseline SHA-256 `18261ce7a70a8e870d5cabbb675732aa0a424800fe44986ddbec0ec653c83f85`). It adds a local own-or-admin helper and imports the existing `requireAdmin`. Shared middleware is not edited.

## Precondition: deployment JWT key

When `JWT_SECRET_KEY` is unset, it falls back to the literal `'your-secret-key'` (`src1/config/config.ts:23`). The repository is public, so anyone could then sign an admin token.

- Every guard below holds **only if a strong `JWT_SECRET_KEY` is set in the deployment**. The denial is therefore not unconditional.
- Removing the fallback is an auth/security follow-up owned by the lead.

## Actor and routes

All routes are mounted under `authenticate` (`src1/routes/index.ts:72`). Each guard is the first route handler, before `validate` and the controller.

| Route (fields) | Guard | Allowed | Denied |
| --- | --- | --- | --- |
| `POST /api/v1/wallet` (`userId`, `initialBalance`, `isActive`) | `requireAdmin` | admin | any other `userType` |
| `POST /api/v1/wallet/transactions` (`userId`, `transactionType`, `amount`, `reference*`, `description`, `notes`, `transactionDate`) | `requireAdmin` | admin | non-admin |
| `PUT /api/v1/wallet/:id` (`isActive`) | `requireAdmin` | admin | non-admin |
| `GET /api/v1/wallet` (`userId`, `isActive`, paging, sort) | `requireAdmin` | admin | non-admin |
| `GET /api/v1/wallet/user/:userId` | `requireOwnWalletOrAdmin` | admin, or `req.user._id === req.params.userId` | anyone else |
| `GET /api/v1/wallet/user/:userId/transactions` (filters) | `requireOwnWalletOrAdmin` | same | same |

## Current behaviour

Line numbers in this section are baseline `9ea963f` line numbers.

**No route checks the caller's role** (`src1/modules/wallet/routes/index.ts:22-56`, `:65-78`).

**Creating and removing money.** The validators accept any `userId`, credit type and `initialBalance` (`validation/index.ts:9-12`, `:46-69`), and the controllers forward the body verbatim (`controller/index.ts:22-31`, `:101-114`). The service then:
- adds funds for credit types and removes them for debits (`services/index.ts:176-186`);
- overwrites the balance (`:206`);
- books an opening credit in `create` (`:44-66`).

**Freezing a wallet.** `PUT /:id` sets `isActive` on any wallet (`validation:53-57`, `services:131-153`). Wallet IDs leak through the open `GET /` (`controller:53-87`). An inactive wallet:
- blocks spending (`bookings/services/index.ts:379-385`);
- makes refunds throw (`bookings/services:439-457`, `payment/services/index.ts:1207-1224,1307`);
- loses booking-cancel refunds silently, because the cancel path has already set `refunded` and swallows the error (`bookings/services:1629-1659`).

This violates AR-26 (`documentation/planning/SYSTEM_DESIGN.md:445`).

**Reading other users' data.**
- `GET /` returns every wallet.
- `GET /user/:userId` reads, and auto-creates, any user's wallet (`services:71-80`).
- The transactions route lists any user's history (`controller:116-156`).

Together these break the M0-B wallet row "No caller-chosen initialBalance/credit/refund/paid state … read their own result" (`documentation/planning/M0_IMPLEMENTATION_APPROVAL.md:42`), and fail TC-REV-003.

## Required behaviour

**`requireAdmin`** (`src1/modules/middleware/auth.ts:89-115`):
- no `req.user`: `401 UNAUTHORIZED`;
- otherwise non-admin: `403 {error:403, code:'FORBIDDEN', message:'Admin access is required'}`, through the existing `errorHandler`.

**`requireOwnWalletOrAdmin`:**
- no `req.user?._id`: `401 UNAUTHORIZED`;
- a non-admin whose `req.user._id !== req.params.userId`: `403 FORBIDDEN`, fixed message `'Access to another wallet is not permitted'`;
- the comparison is strict, with no type cast, and the message never echoes an identifier.

**Both guards:**
- a missing or invalid token still gets the outer `authenticate` 401;
- denial runs no validation, service, repository, notification, provider or wallet-auto-creation code;
- a malformed non-admin body also gets 403, because the guard runs before `validate`;
- allowed requests behave byte-for-byte as at baseline.

## Unchanged surfaces and follow-ups

**Unchanged:**
- `POST /recharge/initiate`;
- pharmacy-wallet routes, which are already guarded;
- automatic wallet creation at login (`auth/services/index.ts:340`);
- in-process `WalletService` and wallet-repository callers: `referral/services/index.ts:223`, `externalBookings/services/index.ts:215-235,273-323,497-548`, and the bookings, payment and pharmacy services.

**Follow-ups:**
- `GET /:id` and `GET /transactions/:id` need an ownership check after the fetch;
- atomic wallet effects and keys (F11/F13);
- narrow, audited admin adjustments. Admin raw writes are **not** approved as funded or audited authority (`M0_START_APPROVAL_STATUS.md:32`); this stays with D2/AR-26 finance.

## Residual non-admin value paths

This slice does **not** fully contain the wallet. Known remaining paths include the following; the list is not claimed to be exhaustive:
1. A forged webhook cancellation triggers a refund (`externalBookings/services/index.ts:3203-3212`).
2. Concurrent refunds can be paid twice (`bookings/services/index.ts:460-514`; `externalBookings/services:273-323`; `payment/services:1392-1433`).
3. A recharge coupon credits more than was collected (`wallet/services/index.ts:305-347`; `payment/services:1318`).
4. Referral rewards can be farmed (`referral/services/index.ts:194-232`; D2).
5. The JWT key fallback.
6. The ID-based reads listed under follow-ups.
7. **Pharmacy debit of any patient's wallet through bookings.** Pharmacy self-signup is public (`auth/services/index.ts:147-150`). A pharmacy principal can then `POST /api/v1/bookings` with any body `userId` and `useWalletBalance: true` (`bookings/controller/index.ts:34-45`). That debits the patient's wallet (`bookings/services/index.ts:745,800-807,363-415`); the bookings router has no pharmacy guard. Whether pharmacy-assisted bookings may spend a customer's wallet is a product and finance decision, which backend then implements.
8. **Refund forfeiture through booking PUT.** Any non-HR principal can send `PUT /api/v1/bookings/:id {status:'cancelled'}` for any booking, because `userId` is optional (`bookings/controller/index.ts:296`). This sets `paymentStatus:'refunded'` without a wallet refund (`bookings/services/index.ts:1479-1481`). A later `cancelBooking` then returns early (`:1623-1625`), so the money is silently lost. The fix needs a per-role field allow-list owned by product and clinical, which backend then implements.

Paths 1–6 are owned as stated above: integration/operations (1), backend/DevOps (2), finance (3, 4) and the lead for auth/security (5). Path 6 is a follow-up for this lane's backend.

## Compatibility

These calls will now get 403:
- `test/test-api.ts:1666`, the patient-token `GET /api/v1/wallet`;
- the patient-token credit and debit calls at `:1601-1615` and `:1932-1947`;
- any patient `POST /api/v1/wallet`.

It is unverified whether HR, doctor or pharmacy clients read other users' wallets. The specific risk is a pharmacy-assisted booking client that reads `GET /api/v1/wallet/user/:customerId`: it now receives 403. No supported client revision was inspected.

**Considered, not adopted:** limiting own-ID reads to `userType === 'user'`. It is recorded as a follow-up, not a containment defect.

## Decisions

- **Relies on:** the M0-B command-authority table, C1 step 2 ("block untrusted wallet mutation"), and AR-26.
- **Does not need:** D1/D4, D2 (admin behaviour is preserved, not approved), D3, D5, D9, or any provider contract.
- **Introduces:** no numeric policy, migration or dependency.

## Source-data verification

`output/qa/money-provider-clinical/source-check.py` uses only the Python standard library. It reads TypeScript as text and never imports or evaluates it. Run it with `/opt/homebrew/bin/python3 -I` if present, otherwise `python3 -I`.

**Named checks, in order (1–14 diagnostic; 15 binding):**

| # | Check |
| --- | --- |
| 1 | `required_imports` |
| 2 | `route_inventory`: the nine baseline registrations, parsed from the standard `walletRouter.<method>(` layout |
| 3 | `admin_guard_first` |
| 4 | `own_guard_first` |
| 5 | `unguarded_routes_unchanged` |
| 6 | `own_helper_present` |
| 7 | `own_helper_strict_comparison` |
| 8 | `own_helper_no_cast` |
| 9 | `own_helper_no_service_access` |
| 10 | `own_helper_identity_guard` |
| 11 | `own_helper_condition` |
| 12 | `own_helper_check_before_next` |
| 13 | `own_helper_fixed_message` |
| 14 | `require_admin_semantics` (on `auth.ts`) |
| 15 | `exact_transform` |

The real tree must also pass three file checks:
- `pinned_files`: byte equality for `common/middleware/validation.ts`, `middleware/errorHandler.ts`, `middleware/index.ts`, `middleware/auth.ts` and `config/config.ts`;
- `diff_scope`: `git diff --name-only 9ea963f -- src1 test tsconfig.json package.json package-lock.json` lists only the wallet routes file;
- `untracked_scope`: no untracked files appear in the same paths.

**Binding gate.** `exact_transform` and `diff_scope` together are the binding gate; `pinned_files` and `untracked_scope` are also mandatory. The named semantic checks are **diagnostic substring lints**: they explain why a defect fails, but they do not prove the file safe by themselves. Known semantic bypasses are retained as binding-gate controls.

**Expected outcomes:**
- The baseline file is rejected before the edit, and the amendment is accepted after it.
- There are 30 diagnostic controls: 29 edited controls plus the baseline. Each must be rejected by a named semantic check before `exact_transform`.
- There are 6 binding-gate controls, listed at the end of the control list. Each must be rejected, and the receipt records which check rejected it.

**Diagnostic controls** (beyond the baseline):
- each guard removed (including `GET /` left open);
- each guard placed after `validate`;
- the wrong guard: `requireAdminOrOperationalPharmacy`, `authenticate` or `requireAdminOrHR`;
- guards on only some routes;
- a loose `!=` comparison or an ObjectId cast;
- the ownership check placed after the service call;
- `next()` called before the comparison;
- an inverted check, or one without the identity guard;
- the identifier echoed in the message;
- a guard added to the recharge route;
- a duplicate unguarded route;
- the import path changed;
- `requireAdmin` weakened.

**Binding-gate controls**, which reproduce bypasses found in review:
- an unguarded chained `.get`;
- a duplicate `(walletRouter as any).post`;
- `setImmediate(next)` in the helper;
- `Object.assign(req.params, req.query)` after the owner check;
- a shadowed `requireAdmin`;
- a different exported router.

**Evidence:** `source-verification.json` records the command, cwd, argv, environment, exit code, stdout, stderr and hashes, followed by `git diff --check`. These checks prove neither mounted behaviour, zero runtime effects nor client compatibility.

## Runtime fixtures

The [fixture specification](../../../output/qa/money-provider-clinical/fixture-spec.json) holds the synthetic cases. They run only after full C3 admission, with an owned replica-set namespace and recording provider ports. Reintroducing each defect must make its mounted case fail.

## Traced candidates not selected

Recorded with file:line evidence and blocking owners in the `80da7ff` version of this file: public `/api/static/*` clinical files (F05/C1), unsigned provider webhook (provider callback auth/F06), booking PUT/DELETE overposting (per-actor allow-list), non-atomic balances/duplicate refunds (F11/F13, C2), `authorized`-as-paid (D3), recharge coupon (D2) and upload path escape (F05).
