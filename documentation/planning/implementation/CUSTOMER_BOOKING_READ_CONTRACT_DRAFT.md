# Customer booking read containment — draft

12 November 2026. DRAFT; no implementation or execution authority. Root condensed the read-only proposal from internal native worker /root/focus_customer_audit. This draft is excluded from the two scope-plan approvals. Freeze exact contract and obtain two independent nonauthor Standards/Spec decisions before editing application source.

Baseline:7df9121440813dec14cd4c57d347ee20982c3ec7, durable branchm0/customer-pharmacy-lab-focus; planning-only successor12c2a17. Read AGENTS, current progress, focused scope/gaps, USER_ROUTE_AUTHORITY_CONTRACT, parallel workflow and current C2/C3 conditions. The graph indexes originalbfb608e; exact durable source is authoritative.

## Source ownership and compatibility

Change ONLY src1/modules/bookings/controller/index.ts, limited to GET /api/v1/bookings/:id and GET /api/v1/bookings/user/:userId and an optional private helper invoked only there. Shared service/repository/model/auth/routes/Joi signatures/behavior and unrelated handlers stay unchanged. Review any required broader change before implementing it. Preserve the original checkout six staged files, patch and eleven handover files.

Ordinary customer means exact authenticated userType string `user`; account owner is the signed `_id`. Both handlers reject missing/null principal, absent/nonstring/whitespace-only `_id` or userType BEFORE any BookingService call, with proposed existing AppError convention401/UNAUTHORIZED/Authentication is required. Use trimming only to detect blank principal strings; never rewrite signed IDs or impose new ObjectId validation.

Well-shaped noncustomer behavior stays: detail ensureHRCanAccessBooking then original query-owner forwarding; by-user resolveHRBookingReadScope then existing corporate-scoped HR getAll or existing non-HR getByUserId. This preservation does not approve other-role access. Unknown nonempty roles are a residual auth issue, not new accepted customer authority. Missing/malformed actors cannot fall through to preserved branches.

## Ordinary customer contract

Foreign/malformed owner hints produce proposed403/FORBIDDEN/Access to bookings owned by another user is not permitted, before any booking/user/service lookup. Do not reveal owner/resource existence.

Detail preserves authenticate → idParamSchema → bookingQuerySchema → controller. Omitted or validated self query userId uses signed owner. Every other supplied owner is403 before service. Existing Joi malformed400 remains. Call existing getById(requestedBookingId,signedOwnerId) exactly once, without initial unscoped read, fallback or retry. Existing service predicate combines _id and userId. Missing own and existing foreign-resource IDs both retain404/BOOKING_NOT_FOUND/Booking not found.

By-user preserves authenticate → userIdParamSchema → controller. Validated path owner MUST equal signed owner. Optional query owner must be a string whose trimmed value equals signed owner; array/object/null/blank/foreign values403, omitted/self accepted. A self query cannot override foreign path. This route has no query Joi validator; do not add a global one or conflate its customer403 with detail's existing validator400. Call getByUserId(signedOwnerId) exactly once. Preserve existing ordering and own empty200 list; no extra existence lookup/paging/projection.

Success remains200 {success:true,data:bookingOrBookings}; existing error middleware serializes {error:statusCode,message,code}. Upstream missing/invalid/expired JWT and malformed route/Joi failures retain current semantics. A booking's dependent reference does not grant access to another account's booking. Client revisions/compatibility remain unverified and require their own evidence.

## Callers requiring unchanged service APIs

BookingService.getById is also called by ensureHRCanAccessBooking, getPaymentDetails, update, delete, cancelBooking, rescheduleBooking and retryBookingPayment. getByUserId's direct production caller is the controller. SpecialistPortalService imports BookingService for update, not these reads. ExternalBookingService is a distinct class. Therefore no global tightening of service methods is admitted in this slice. Real read paths use BookingRepository.findOne → BaseRepository.findOne/model.findOne.lean and findByUserId → ordered findAll/model.find.lean.

## Verification and separate execution gate

Source checks prove only exact controller scope, signed-owner forwarding, early denial/no fallback, unchanged signatures/noncustomer paths and preservation of unrelated source. Actual behavior is NOT_RUN. Historical90/33 excludes real BookingService/controller; its substitute exposes update only. Do not refresh/reuse that artifact or consumed approvals for these endpoints.

Before any application import, separately prepare/review complete C3 real router/controller/service/repository/model closure, fixed dependencies/config/source hashes, owned Mongo resources/indexes, provider/file/network denials, recording ports/counters and exact one-run profile. Expanded import closure is currently UNKNOWN; this draft admits no compiler/install/app import/Docker/provider/DB execution.

Required future actual controls: ownersA/B; own/dependent-linked/foreign/missing bookings; omitted/self/foreign/conflicting owner hints; both routes' actual malformed path/query/Joi behavior; missing/malformed principals and upstream JWT failures; own detail200/exact one combined scope read; foreign/missing detail404/no unscoped read; by-user exact ordered own list or empty200; early403/401 with zero service/read dispatch; preserved well-shaped noncustomer cases without globally accepting those roles. Assert exact counters, unchanged sibling/all documents, zero writes/JWT signing/queue/provider/file/payment effects, and separately bounded existing logging. Reintroduced owner omission/query/path trust/unscoped fallback variants must fail; fresh restored positive controls must pass. Own-resource cleanup and independent post-execution decisions remain mandatory; failures do not authorize retries.

Generic booking writes/paid/clinical fields, contact verification/revocation, report privacy/versioning, shared money/stock and patient/consent/client gaps stay open. This contract can close only two ordinary-customer read boundaries after their actual evidence; it cannot certify CUSTOMER, M0, production or release.

## Baseline hashes

- src1/modules/bookings/controller/index.ts: aec2b074981bfee5361b29b5f86ebed4e20c1837deadc75a9cc0766360be0f44
- src1/modules/bookings/routes/index.ts: b2ed40c971e35ceb28eeccb8b491bcf7c4b2dcaf35a7267c783a8345760e3cfb
- src1/modules/bookings/services/index.ts: d32c2a8a7e0af52d6e062e29c82e7fee87dcb6dcdfe4488e89e7d09c4cc2c8cf
- src1/modules/bookings/repository/index.ts: d54ebba522cd290589296918eb2dcb4f7609e42d836ef3f23dfb89114b375713
- src1/modules/bookings/validation/index.ts: ce9743b4cc50af6b230089c0ff0523f490f8685c6fbb48cc475f4b8e52e6f728

Reconcile all drift before implementation; never overwrite another worker or silently refresh pins.
