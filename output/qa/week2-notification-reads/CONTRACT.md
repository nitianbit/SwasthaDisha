# Notification generic reads/state and FCM test sender

11 November 2026. **DRAFT FOR TWO INDEPENDENT PRE-REVIEWS; NO PRODUCTION EDIT OR
EXECUTION AUTHORITY.** Baseline `d91e1a3d37f2b229efc7fc2507d666ddc2576d99`,
branch `m0/week2-notification-reads`, worktree
`/private/tmp/swasthadisha-parallel-p1qom53w/week2-notification-reads`.
Author `/root/auth_api_fixture_contract`. Current ownership is this contract only.
After two pre-reviews and a lead assignment, proposed production ownership is
exactly `src1/modules/notification/controller/index.ts` and
`src1/modules/fcm/routes/index.ts`, plus owned QA. Others share the repository;
preserve all other work, original staged changes, handover and actual API artifacts.

## Selected scope and actual route inventory

The ready queue in `PARALLEL_WORKSTREAMS.md` names general notification listing,
ID operations and the FCM test sender. The lead confirmed a bounded five-generic-
route amendment plus FCM/test, preserving earlier narrower policies. This is
current-path authority containment under M0-B and the direct review workflow,
separate from provider, clinical/product, runtime and release acceptance.

There are **16 notification routes** behind the central `authenticate` mount:

| Group | Routes | This contract |
| --- | --- | --- |
| Existing admin senders (2) | POST / and /send | Entire notification routes file, including requireAdmin before validation, stays byte-identical. Creation/broadcast controller bodies and internal senders unchanged. |
| Existing strict-own recipient paths (4) | GET /user/:userId, /unread, /unread-count; PATCH /user/:userId/read-all | Existing helper and all four bodies stay byte-identical, including their deliberate lack of an admin exception. |
| Existing specialist paths (5) | GET /specialist/me, /unread, /unread-count; PATCH /specialist/me/read-all and /specialist/:id/read | Existing requireSpecialist wiring, alias selection, handlers and service methods unchanged. |
| Generic unguarded paths (5) | GET /; GET /:id; PUT /:id; PATCH /:id/read; DELETE /:id | Add canonical owner-or-exact-admin authority as specified below. |

The FCM router has POST /token and /test behind its existing central authenticate
mount. Add existing requireAdmin only to /test, before its existing body validator.
The /token registration and all FCM controller/service/repository/model/DTO bytes
remain unchanged. Do not apply an admin guard to the whole FCM or notification
router.

## Graph freshness, source callers and client observations

Graph-first discovery used project `swasthadisha`: index status, all 103
notification nodes (including the final three through pagination), 44 FCM nodes,
exact controller/test-sender snippets and inbound traces. The graph is ready at
the correct repository root but original `bfb608ea...` HEAD. Actual byte comparison
finds notification routes/controller and AuthService changed since that graph
baseline; current bytes and the pins below are authoritative. Arrow-method traces
omit service/FCM caller edges. Missing edges are not absence proof.

Read-only source reference/call-site checks identify:

- NotificationController is constructed only by its router; FcmController only by
  its router. Notification generic read/state methods have no other direct source
  caller found. There is no supported notification ownership-transfer command.
- NotificationService internal callers are AuthService (user/specialist login),
  BookingService (created/new-specialist/cancellation alerts), SpecialistPortal
  (cancel/confirm/complete), WalletService (credit), PharmacyOrderSideEffects
  (create plus markFcmSent), and BookingReminderConsumer (patient/specialist alerts).
  These use unchanged service methods, not controller HTTP authorization.
- FcmService send callers include NotificationService broadcast,
  PharmacyOrderSideEffects, BookingReminderConsumer and FcmController's test sender.
  Their source and payload/role filters remain unchanged.
- NotificationService.create/save and createGeneral/insertMany establish userId.
  Existing updates change isRead/readAt or fcmSentAt, never owner. Generic PUT's
  DTO/schema and service accept only isRead. Direct notification model/repository
  references outside that chain were not found in production source. Legacy test
  files reference those classes; they were read, not executed.

Current source client observations, not deployed/supported-client certification:
the local mobile checkout at `db62e8a960a52ee5354d40d696e40924cccd0129` is clean for
the five pinned files below. Its API uses current-user unread list/count and
read-all paths, and PATCH /notifications/:id/read for an item received from its own
list. The screen passes user._id to list/read-all and item._id to mark-read.
These flows remain valid. Its notification API, endpoint constants, slice and
screen do not call /fcm/test; no such literal was found in its src tree or local
backend tests. Absence of a known client call is not permission to remove an API.
The repository's legacy test-api also uses own recipient paths, general list and
single-ID read; its nonadmin create test already conflicts with the earlier
admin-only sender contract and is not new runtime approval.

## Concrete authority, field and error boundary

New generic handlers require a verified current JWT principal whose canonical
`req.user._id` is a nonblank string, without string coercion. Missing, empty,
whitespace-only, array/object or other nonstring ID denies 401 UNAUTHORIZED before
service access. Existing route validators still precede these controller checks,
so malformed DTO/ID requests may retain their earlier 400 VALIDATION_ERROR.

Exact lowercase `userType === 'admin'` is the only global generic bypass.
Other authenticated identities use only their canonical _id as recipient:
including user, specialist, pharmacy or HR self-recipient intent already reflected
by role-agnostic strict-own paths and specialist creation helpers. No new role
allowlist, case folding, corporate delegation, caregiver authority or fallback to
specialistId/pharmacyId/corporateId is inferred. A differently cased/unknown role
does not receive global admin authority. The current JWT issuer/role validation,
signature/key, revocation and identity-to-clinical-person mapping remain separate.

| Generic surface | Nonadmin canonical recipient | Exact admin |
| --- | --- | --- |
| GET / | With no recognized userId query, bind the service query to canonical _id. Same query ID remains valid; a different validated query owner denies 403 before lookup. Preserve type/isRead/reference/sort/pagination inputs. | Preserve validated optional query owner or existing unscoped global listing. |
| GET /:id | Validate principal, call existing getById once, then compare stored String userId with canonical _id before serialization; another/malformed legacy owner denies safe 403. | Same existing lookup, any result permitted. |
| PUT /:id | Authorize stored recipient with the existing getter before calling unchanged update(id, validatedIsReadDTO). | Same object-existence check, existing update permitted. |
| PATCH /:id/read | Authorize stored recipient before unchanged markAsRead(id). | Same object-existence check, existing mark-read permitted. |
| DELETE /:id | Authorize stored recipient before unchanged delete(id). | Same object-existence check, existing delete permitted. |

Use existing AppError/error-handler conventions with fixed safe messages:
401 UNAUTHORIZED for a missing/malformed canonical principal, 403 FORBIDDEN for
another recipient or explicit list selector, and unchanged 404
NOTIFICATION_NOT_FOUND / "Notification not found" from the existing getter for
absence. Do not serialize row, payload, reference or provider data before authority.
No new hidden-object lookup policy or record-existence classification query is
introduced. Single-ID query strings such as userId have no declared owner-selector
meaning and must never override stored owner/canonical identity.

ID mutation preflight adds a read; existing update/delete can perform their own
subsequent read, while markAsRead writes directly after preflight. The current
owner is immutable through supported HTTP DTOs and identified production writers;
this bounded patch does not make split read/write authorization atomic against
out-of-band database owner rewrites or introduce owner transfer. Any future
ownership-reassignment writer needs its own state/atomicity contract.

Keep isRead-only PUT, stripUnknown behavior and success envelopes unchanged.
Unknown body owner/content fields cannot change ownership or content: Joi excludes
them and the unchanged service constructs only isRead/readAt updates. Do not
silently introduce writable fields or claim a new complete field-rejection policy.
Preserve current readAt/timestamp behavior, including existing repeated-read and
unread-toggle behavior, hard delete and notification content/reference fields.
No booking/payment/clinical state follows from an alert's read flag.

Preserve general-list service quirks: nonpaginated referenceType/referenceId filters
are currently ignored, while pagination applies them; both rows and total must
still receive the same canonical owner constraint. Existing unread count is capped
at 1000 by its repository helper; do not relabel it as a complete uncapped count.
The four strict-own path guards and five specialist handlers retain their current
responses/count semantics and do not gain a new admin exception.

### FCM test sender

Insert existing requireAdmin only at POST /api/v1/fcm/test before validation and
sendTestNotification. This matches existing admin sender authority: authenticate
verifies JWT; requireAdmin checks req.user and exact admin role, without a new
account lookup or stronger principal-ID policy. Nonadmin signed roles deny 403
even for their own target, before token lookup/provider access; anonymous or invalid
JWT keeps 401. Exact admin's malformed target keeps the existing 400 validator.
Retain the 24-hex userId DTO, fixed test title/body/data and response message.
This is no arbitrary-message API and no permission to send a real provider test.

FCM remains best effort: zero tokens/missing transport can return 200 without a
send, and transport errors are logged/swallowed by the unchanged service.
Its "findActive" repository helpers do not currently filter isActive; token
reassignment/device proof, active-token policy, logging and delivery/retry policy
are outside this patch. No source decision here substitutes for those owners or
for a provider delivery receipt. /token and all internal notification send callers
must remain unchanged.

## Frozen current inputs

All backend paths are relative to this baseline checkout. Future source-data
verification must permit only the two proposed production files plus owned QA;
all other inputs below stay byte-identical.

| Input | SHA-256 |
| --- | --- |
| `src1/modules/notification/routes/index.ts` | `d9fe35d82ebda24be5a1f9dd5dcd0d957dbe08bccc81969dac1eb2d834649d6b` |
| `src1/modules/notification/controller/index.ts` | `37e8a353299cbd69df87cb904c0515061b160e6c73c699e23845349b09723a5c` |
| `src1/modules/notification/services/index.ts` | `dd343357282c5c80fb02da2913d9eaf1ec772e7df0daa39f9a4b0bfc87c9311d` |
| `src1/modules/notification/repository/index.ts` | `418749c02dbd5844003b355fb6e79f66846377146e708f816ffb7426bc42e897` |
| `src1/modules/notification/model/index.ts` | `ef6c56aec1cecaac2c0248b76faf1dd4721f4c00a45b2fa8f45c8b79836c1ca9` |
| `src1/modules/notification/types/index.ts` | `7c755170cacc5ce208c1522b152543ccbbefba3cc03a9f28f99a3d6d325a6b68` |
| `src1/modules/notification/validation/index.ts` | `11d7286fb287e5a51282da6b025896871d048ca4b58086a40e8fc61b58bd9c9b` |
| `src1/modules/fcm/routes/index.ts` | `929100f79360f48e1c049fbb98c1e496f0690b653cdd7ed72e316e624dcab1ef` |
| `src1/modules/fcm/controller/index.ts` | `53544029ca0616db46a326d9f1414c91252178f5ddfd2e15a6c337328335b464` |
| `src1/modules/fcm/services/index.ts` | `5721b5de514461bdc1197cb721bf99440b79df9bf8c889087b691ba47d6c55ec` |
| `src1/modules/fcm/repository/index.ts` | `8c472a507a1ae97ba683db83bb8e6d07112f243f91eb0b7eb39ea36abb74baca` |
| `src1/modules/fcm/model/index.ts` | `7082276e9d66a64ad7dc510dcc37782bb1a4e7ee80accbd1322f5c2d8a6f6b37` |
| `src1/modules/fcm/types/index.ts` | `f1beb58d08a91b5c6797d177a21be55cb6d79813f2a510cd164532fa723a6f2c` |
| `src1/modules/fcm/validation/index.ts` | `80fe3ca9f6cdd0f20afe689852cdafb3ae915ff8f2e0334c345084571f69fc7b` |
| `src1/routes/index.ts` | `50620efcc0d48d32fb573e2a1e3d0b74d01333a209ffea6c401550a576b63056` |
| `src1/modules/middleware/auth.ts` | `db0f9bb4307e46e3cd05968a9de8f7777f5de0c6ca1894254491e9d855f893a2` |
| `src1/modules/common/middleware/validation.ts` | `8be55cee7485531491ff095ed1d9f36af443987690f22d04dd67ef9318a0a5ef` |
| `src1/modules/common/utils/asyncHandler.ts` | `59fe49db58678ef81242a654f7457f74b067b2583a3f8dc70918b61f50228bd9` |
| `src1/modules/common/repository/BaseRepository.ts` | `14a0fe5fdc9abd7a54b913bca4816a631b4bb263c11ad21ec37da0ee6c3f723a` |
| `src1/modules/middleware/errorHandler.ts` | `1e06885f2c5b8df8ed186dba28cd975aaf4f4d5233a2daa277e6b7f7b15fad51` |
| `src1/modules/auth/services/index.ts` | `d59d5ea23df586fbbdb5b9c4615bcbe0b716f649bdc02f3738088f87b0fbae56` |
| `src1/modules/bookings/services/index.ts` | `f239aa5a35b56c96b483a7ed009ef0e2a9e8b5ec2cd43d796fc72c6d853c6508` |
| `src1/modules/wallet/services/index.ts` | `938433ca68e0481bf86d2b69f5d56106fba04f913c94e326947bbd617fbc13ff` |
| `src1/modules/specialistPortal/services/index.ts` | `f5d90a49987bcc312b7b4acd614ba6833e5551b601f17ff5097d4d1ef9351ed4` |
| `src1/modules/pharmacyOrders/services/sideEffects.ts` | `db2a2527a2b31151973dee0fe9728bb386f6bfc1e0950f14c7b1c45088a79211` |
| `src1/modules/queue/service/BookingReminderConsumer.ts` | `520a39a9d2a73da4f6ac0ff6b0fa14585e98d71790e7d5c61ac3275088ef76ac` |
| `test/test-api.ts` | `bdd96484db4d3c0da5d75c6f01626c758580ba4103a43a60e9b8aeafa99a95f7` |
| `test/pharmacy.integration.test.ts` | `49f97bb67d22423e58412b291d8019c0eb52ab0232a49e0909dd55b1b52565c3` |

Mobile files are read-only observations in a separate checkout and remain outside
implementation ownership:

| Client input | SHA-256 |
| --- | --- |
| `src/features/notifications/notificationApi.ts` | `ab0f85c0489973919e7fb19cc9308809491ead2bd5d4bd24df220a31bbeaef19` |
| `src/features/notifications/notificationSlice.ts` | `663f9bef0dbdcc2db332840adad11d7b643acc43f1aeeb24bbd2c8aeb832c6e8` |
| `src/features/notifications/notificationTypes.ts` | `dcba2a56d8b5aac965f3d28c05b0b8dfacbdfb00e4d069ede4e608dae9326feb` |
| `src/api/endpoints.ts` | `0337a76adedd66e0a99112b4bd82ac20a7eb796385a54eef8846577d84c6dab5` |
| `src/screens/Other/NotificationsScreen.tsx` | `332c11d24838e0c0cc34168ee5075ad2521974aca70f4a99c7482a8dce022274` |

## Source-only proof plan after two pre-reviews

Prepare an inspected stdlib-only byte checker and retain actual rejection against
the unchanged baseline before production edits. Then verify the exact two-file
transformation, contract/input pins, original sender/strict-own/specialist/token
registrations and bodies, whole-tree scope/modes and protected artifacts.
Retain negative source controls for missing/coerced principal, request-selected or
unscoped list owner, weak/case-folded admin bypass, missing/misordered stored-owner
check, serialization or mutation before authorization in each ID handler, changed
legacy handlers/internal callers/DTOs, removed or delayed /test admin guard, and
accidental /token restriction. A byte/source control is not an executed authority
or provider assertion; no extracted/copied TypeScript evaluator or fake repository
may count as application evidence.

## Later required actual HTTP/DB/provider-recording evidence

All cases are NOT_RUN now. A separate reviewed C3 extension must mount the actual
notification/FCM routers with real JWT/Joi/TypeDI/service/repository/models and
owned DB. Install recording Firebase/logger ports before eager imports; never load
operational credentials, tokens or service-account files. Current core API imports
some services/models but does not admit these routers/cases. No profile/source/
case extension or invocation authority follows from this contract.

| Required group | Assertions |
| --- | --- |
| Generic owner/admin success | Own list with absent/same query; ID read, isRead true/false, mark-read/repeat and delete. Admin global/filtered list and other-recipient ID actions preserve exact envelopes and intended single-row effects. |
| Other recipients | Nonadmin other query owner denies 403 before list/count lookup; existing other-recipient ID GET/PUT/read/DELETE denies 403 before serialization/mutator/provider. Extra body/query IDs and alias/corporate claims cannot grant access. |
| Principal/errors | Signed missing/empty/blank/object/array canonical ID denies on new generic handlers; anonymous/invalid/expired JWT and malformed/absent IDs retain defined 401/400/404 behavior. Exact error envelope has no record/token data. |
| Filters/counts | Two owners with read/unread and reference/type variants: pagination rows and total exclude the other owner; preserve documented reference-filter and unread-cap quirks without claiming their repair. |
| Existing secure surfaces | All four strict-own paths still deny other recipients, including an admin aimed elsewhere; own counts/read-all remain valid. All five specialist paths retain original role/alias scope. Prior POST / and /send guards stay admin-only; internal login/booking/wallet/order/reminder source/behavior stays intact. |
| Update fields/state | Only authorized recipient isRead/readAt/timestamps change. Unknown owner/content fields never transfer owner or rewrite content. Denials leave all notification, FCM-token and unrelated rows/timestamps unchanged and make zero forbidden provider calls. |
| FCM test guard | Nonadmin /test denies before validation/token lookup/recorded transport, including malformed bodies and own target. Admin valid target calls the real sender with only intended fixture tokens and unchanged fixed payload; absent tokens preserves no-send 200. /token registration still accepts legitimate nonadmin self flow unchanged. Recording intent is not provider delivery. |
| Sensitivity | Manifested real-source variants restoring unscoped list, missing stored-owner/early-write check and removed/moved FCM admin guard must fail actual assertions. Fresh nominal source instances restore between phases; no production test bypass. |

No clinical/product decision is required to restrict these five previously open
generic actions to recipient/admin and /test to admin under the existing queue.
Broader recipient-role namespaces, HR/caregiver delegation, ownership transfer,
clinical retention/acknowledgement, token registration/device proof and provider
policy remain separate. C2 production facts, full C3/M0, release/deployment and
capacity/owner gates stay open. No application, TS/compiler, npm, client, DB,
provider or Docker execution is authorized by this draft or its source-only review.
