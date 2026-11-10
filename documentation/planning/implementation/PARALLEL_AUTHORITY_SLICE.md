# Parallel authority slice: own-recipient notification routes

Baseline `bfb608ea1a89551f6cd72ec5ee1349a3ee7abef7`; branch `m0/parallel-authority`. Lead `/root` approved the source-only contract before implementation, bound to its preimplementation SHA-256 `12751408b5be67024e063822eab4a65b0d644aa4d9937c94cb7fa7bc54b9d1d5`; final independent review remains pending. This lane owns only `src1/modules/notification/controller/index.ts` in production, this document and `output/qa/parallel-authority/`. Other workers own authentication and foundation files; shared route configuration, dependency/start files and progress/register edits remain with the lead.

## Existing authority and defect

The [M0 command-authority contract](../M0_IMPLEMENTATION_APPROVAL.md#current-command-authority-contract-for-m0-b) requires current actor/resource authority and forbids out-of-scope notification access/mutation. The notification model stores its recipient in `userId`. The central mount authenticates `/api/v1/notifications`, but four generic recipient handlers currently pass caller-selected `req.params.userId` to their service without comparing it with the authenticated principal. The dedicated specialist `/me` handlers already derive their recipient separately; preserve those paths.

Graph project `swasthadisha` reported the original checkout at the same baseline. Graph discovery located the controller/service and `AuthRequest`; exact worktree reads verified current routes, model, repository and request shape because this worktree is a distinct path and inbound graph relationships are incomplete.

## Bounded route contract

| Current route | Allowed actor/result |
| --- | --- |
| `GET /api/v1/notifications/user/:userId` | Authenticated principal whose `_id` exactly matches the recipient parameter; existing result/envelope |
| `GET /api/v1/notifications/user/:userId/unread` | Same own-recipient boundary; existing unread result/envelope |
| `GET /api/v1/notifications/user/:userId/unread-count` | Same own-recipient boundary; existing count/envelope |
| `PATCH /api/v1/notifications/user/:userId/read-all` | Same own-recipient boundary; existing mark-all-read operation/envelope |

For all four: missing principal identity is `401 UNAUTHORIZED`; a different recipient is `403 FORBIDDEN`. Use existing `AppError` conventions and safe fixed messages. Do not query notification/service/provider state before these checks. The outer authentication and parameter validators remain unchanged. No admin exception, new role, sender capability, representative relationship or query-selected authority is introduced. A valid principal may operate only on the recipient ID matching its own `_id` through these handlers. Existing specialized `/specialist/me` identity derivation is unchanged.

Proposed source amendment: add one private `assertOwnRecipient(req: AuthRequest, userId: string): void` method to `NotificationController`; use it immediately after extracting the recipient parameter in `getByUserId`, `getUnreadByUserId`, `getUnreadCount` and `markAllAsRead`. Change those request annotations from `Request` to the already imported `AuthRequest`; import existing `AppError`. Preserve every other source byte, existing four service calls and response envelopes. No route/schema/repository/index/dependency/start changes.

## Evidence and remaining gates

Verification in this lane treats TypeScript only as source data. Retain the exact minimal baseline-to-candidate transform, file hashes, source-check command/receipt and negative source reintroductions for missing/late/incorrect recipient guards. Independently inspect that guards precede service calls and that existing self-success source is unchanged. Do not import/evaluate the controller, an extracted method, application/configuration or provider SDK; no DB/provider/endpoint/Docker/build/install operation is admitted here.

Future runtime fixtures, after complete C3 admission, must exercise own recipient A success and cross-recipient B denial for all four routes, direct missing-principal denial, unchanged B notifications/read state and zero service/provider calls on denial. Include supported non-patient principal shapes without granting cross-recipient capabilities. Reintroducing each corrected guard defect must fail the appropriate mounted-flow regression. Current client revisions remain unverified; source preservation does not establish client/runtime compatibility.

Generic notification listing, single-ID access/update/delete, notification creation/broadcast and FCM test sender policy remain separate defects/contracts. This slice does not close TC-REV-011, TC-SEC-001, F04 or full notification containment. No scenario outcome/automation status changes, runtime acceptance, production deployment or operational log/mail access follow. Preserve the staged Ruflo candidate and handover archive in the original checkout.

## Implemented candidate

The only production diff adds the private helper and invokes it in the four handlers before their original service calls. Amended controller SHA-256: `37e8a353299cbd69df87cb904c0515061b160e6c73c699e23845349b09723a5c`. [Retained source-data recipe](../../../output/qa/parallel-authority/source-check.py) and [exact command receipts](../../../output/qa/parallel-authority/source-verification.json) record a rejected original controller before edits, accepted amended source, twelve rejected source reintroductions and a passing whitespace check. These checks compare source only; they do not establish mounted-route behavior, zero runtime provider effects or client acceptance. No suite, compiler or TypeScript/extracted-method evaluation was performed.
