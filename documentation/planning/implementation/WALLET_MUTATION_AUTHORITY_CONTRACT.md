# Wallet mutation authority slice: contract

10 November 2026. Branch `m0/money-provider-clinical`, baseline `9ea963f`. Status: **CONTRACT ONLY, NOT IMPLEMENTED, RUNTIME NOT RUN.**

The implementation touches only `src1/modules/wallet/routes/index.ts` (baseline SHA-256 `18261ce7a70a8e870d5cabbb675732aa0a424800fe44986ddbec0ec653c83f85`). It imports the existing `requireAdmin` guard and edits no file owned by the auth lane.

## Actor and routes

Both routes sit under `authenticate` (`src1/routes/index.ts:72`).

| Route and body fields | Allowed | Denied |
| --- | --- | --- |
| `POST /api/v1/wallet/transactions`: `userId`, `transactionType` (`credit`/`debit`/`refund`/`cashback`/`promotion`), `amount`, `referenceType`, `referenceId`, `description`, `notes`, `transactionDate` | `userType === 'admin'`, unchanged | `user`, `hr`, `specialist`, `pharmacy`, any other type |
| `POST /api/v1/wallet`: `userId`, `initialBalance`, `isActive` | Admin, unchanged | Every non-admin |

## Current behaviour

- **No role check.** The routes run only validation and then the controller (`src1/modules/wallet/routes/index.ts:22-26`, `:65-69`).
- **Permissive validation.** The validators accept any `userId`, any credit type and `initialBalance >= 0` (`src1/modules/wallet/validation/index.ts:9-12`, `:16-22`, `:46-50`, `:60-69`).
- **Body passed through.** The controllers forward `req.body` verbatim (`src1/modules/wallet/controller/index.ts:22-31`, `:101-114`).
- **Effects in the service** (`src1/modules/wallet/services/index.ts`):
  - credit types add `amount` (`:176-177`);
  - a debit drains any named wallet (`:178-186`);
  - each call saves a completed transaction (`:190-203`), overwrites the balance (`:206`) and writes a credit notification (`:209-228`);
  - `create` books a completed opening credit (`:44-66`).

So any patient can add or remove money in any wallet. This contradicts the M0 rule "No caller-chosen initialBalance/credit/refund/paid state" (`documentation/planning/M0_IMPLEMENTATION_APPROVAL.md:42`) and test scenario TC-REV-003.

## Required behaviour

- **Placement:** `requireAdmin` (`src1/modules/middleware/auth.ts:89-115`) becomes the first handler on both routes, before `validate` and the controller.
- **Denial responses:**
  - a non-admin gets `403 {error:403, code:'FORBIDDEN', message:'Admin access is required'}` from the existing `errorHandler`;
  - an absent principal gets `401 UNAUTHORIZED`;
  - a missing or invalid token still gets the outer `authenticate` 401.
- **Denial has no effects:** no validation, service, repository, notification or provider code runs (malformed non-admin bodies also get 403).
- **Admin success:** the request path and its effects are byte-identical to the baseline.
- **Diff:** one import line, plus one `requireAdmin,` line per route.

## Surfaces that stay unchanged

- **Preserved:**
  - patient-funded recharge, `POST /recharge/initiate` (`routes:59-63`, `controller:172-193`);
  - automatic wallet creation at login (`src1/modules/auth/services/index.ts:340`) and through `GET /user/:userId` (`wallet/services:71-80`);
  - in-process callers: the referral reward (`src1/modules/referral/services/index.ts:223`) and server-side booking, payment and pharmacy wallet effects.
- **Out of scope:**
  - read IDOR (any authenticated user can read any wallet) on the `GET` routes;
  - cross-user deactivation through `PUT /:id`;
  - non-atomic balances and missing unique effect keys (F11/F13);
  - admin adjustments that are neither narrow nor audited. Admin-only raw writes are **not** approved funded or audited authority (`M0_START_APPROVAL_STATUS.md:32`); this stays a D2/AR-26 finance item.
- **Clients:** legacy patient-token calls (`test/test-api.ts:1602`, `:1934`) fail as intended; clients in use are unverified.

## Decisions

- **Relies on:** the M0-B command-authority table and C1 step 2, "block untrusted wallet mutation".
- **Does not need:** D1/D4, D2 (admin behaviour preserved, not approved), D3, D5, D9 or any provider contract.
- **Introduces:** no numeric policy, migration or dependency.

## Source-data verification plan

`output/qa/money-provider-clinical/source-check.py` follows the `parallel-authority` precedent. It uses only the Python standard library, reads TypeScript as plain text and records `typescript_evaluations: 0`.

1. **Expected file.** Read the baseline with `git show 9ea963f:<routes file>` and assert its hash. Build the expected file with three insertions:
   - `import { requireAdmin } from '@/modules/middleware/auth';` after the `validate` import;
   - `  requireAdmin,` after `  '/',` in the first `walletRouter.post`;
   - the same line after `  '/transactions',`.
2. **Checks:**
   - the import is present;
   - each guarded registration contains `requireAdmin` once, before `validate(` and `catchAsync(`;
   - no other registration gains it;
   - `candidate == expected`.
3. **Protected files** stay byte-identical: other wallet files, `middleware/auth.ts`, `src1/routes/index.ts`, `src1/index.ts`, and the referral/payment/bookings/externalBookings services.
4. **Receipts:** baseline rejected before the edit; amendment accepted after it.
5. **Negative controls** (each rejected): original file; import removed; guard removed or placed after `validate`, per route; guard after `catchAsync`; `requireAdminOrPharmacy` substituted; guard moved to `/recharge/initiate`; unguarded duplicate `/transactions` registered first; import from another path; altered `middleware/auth.ts`.
6. **Whitespace check.** These source checks do not prove mounted behaviour, zero runtime effects or client compatibility.

## Runtime fixtures

[`fixture-spec.json`](../../../output/qa/money-provider-clinical/fixture-spec.json) holds the synthetic success, denial, replay and race cases. They run only after full C3 admission: an owned replica-set namespace and recording provider ports. Reintroducing each defect must make its mounted case fail.

## Traced candidates not selected

| Candidate | Location | Blocked on | Owners |
| --- | --- | --- | --- |
| Public clinical files | `/api/static/*` needs no login (`src1/routes/index.ts:54`) and is cached publicly for a year (`file/controller/index.ts:180`). It serves prescriptions (`specialistPortal/services/index.ts:467`) and lab reports (`externalBookings/services/index.ts:2943`). Logged-in fetch is not owner-scoped (`file/routes/index.ts:13-16`, `:37-40`) | F05 owner mapping, C1 risk decision, link migration | Security, clinical/privacy, mobile |
| Unsigned provider webhook | `src1/routes/index.ts:102`; `webhooks/routes/index.ts:11-21`. A forged cancel credits the wallet (`externalBookings/services/index.ts:3203-3212`) and rewrites status and report (`:3124-3142`) | Documented LabStack/Healthians callback authentication; F06 raw-body inbox | Integration/operations |
| Generic booking update and delete | Any authenticated non-HR principal can mark any booking paid or completed and forge clinical authorship (`bookings/validation/index.ts:130-131`, `:386-399`; `bookings/services/index.ts:1233-1238`, `:1461-1523`) | Per-actor field allow-list checked against the clients in use | Product, clinical |
| Non-atomic balances and duplicate refunds | `bookings/services/index.ts:460-514`; `externalBookings/services/index.ts:273-323`; `payment/services/index.ts:1306-1338`. A unique key exists only for `pharmacy_order` refunds (`wallet/model/index.ts:108-117`) | F11/F13 index manifest; C2 MongoDB topology | Backend, DevOps |
| `authorized` payments accepted as paid | `payment/services/index.ts:753` | D3 | Finance, backend |
| Recharge coupon | Credits `baseAmount` while collecting the discounted amount (`wallet/services/index.ts:305-347`; `payment/services/index.ts:1318`) | D2 promotion source | Finance |
| Upload path escape | `file/controller/index.ts:19-20`; `file/services/index.ts:87-90` | F05 | Security |
