# 100 RPS capacity and reliability plan

**Status:** proposed acceptance plan, 8 November 2026. No benchmark was run. Current install/type/test blockers are in the [repository review](REPOSITORY_REVIEW.md). These targets are engineering assumptions for review, not measured capacity or a hardware guarantee.

Expanded product scope includes [daily business operations](BUSINESS_OPERATIONS.md): private customers/orders, lab/clinic/hospital supplies, invoices/receipts, transfers/consumption and optional marketplace listing. Keep the target at 100 aggregate RPS; broaden the useful-work mix and integrity assertions instead of assuming app-only results cover private business operations.

## Define the target precisely

Target **100 aggregate incoming HTTP requests per second** across the Jansetu API under a representative mixed workload, with correct stock, money, slot and clinical behavior. This is neither 100 concurrent users nor 100 completed patient journeys/s. At 100 RPS, 1,000 ms average response time implies approximately 100 requests in flight; size the generator and application from actual latency, not user-count guesses.

Measure achieved request rate, latency, unexpected failures, scheduled/dropped work and business outcomes. Count every measured incoming HTTP request; browser preflight, polling, retry and webhook traffic must be included if present in the selected workload. Setup/token seeding is outside the steady-state measurement and separately reported. Provider API calls and object-storage bytes are separate downstream metrics. Whole-file transfers, PDF generation and bulk import/export get separate resource tests.

Initial interpretation is **100 RPS total**, not 100 per endpoint, per organization or per service. A later requirement for 100 successful writes/s or 100 fully external provider transactions/s needs its own capacity and provider-quota test.

Lab traffic includes both API-connected third-party labs and panel-managed third-party labs without provider APIs. Count lab-panel worklist/status/report commands as incoming Jansetu API traffic. Provider callbacks apply to API partners; panel report release creates the same downstream event without a provider callback. No lab-owned API is required for the panel scenario.

## Proposed acceptance gates

| Measure | Proposed release threshold | Measurement |
| --- | --- | --- |
| Offered/achieved throughput | Schedule 100 requests/s; at least 99 requests/s completed over steady state, with no dropped scheduled iterations | Report offered, started, completed and successful rates separately, plus per-minute buckets |
| Simple/list reads | p95 ≤ 500 ms, p99 ≤ 1,500 ms | Per endpoint class, bounded page/body sizes and representative filters |
| Local transactional commands | p95 ≤ 1,000 ms, p99 ≤ 2,000 ms | Booking/stock/receipt writes with provider responses stubbed according to the test contract |
| Incoming event acknowledgment | p95 ≤ 300 ms after authentication and durable inbox persistence | Heavy processing tracked separately; do not acknowledge before persistence |
| Unexpected HTTP/transport errors | < 0.1% during the 100 RPS steady run | Include 5xx, unexpected 4xx, timeouts and failed transport; report intentional conflict/denial tests separately |
| Business integrity | Zero oversells, overbookings, unexplained wallet/ledger differences, duplicate financial effects or unauthorized disclosures | Reconcile database and event counts after each run |
| Background processing | Normal-task age p95 < 30 s; no continuously growing backlog at steady load | Submission-to-start and submission-to-completion; clinical escalation deadlines set separately by clinical lead |
| Headroom | No sustained resource/pool saturation or monotonic memory growth; queue drains after load | CPU, RSS/heap, event-loop delay, connection waits, transaction retries, disk/network, queue age |
| Recovery | No loss of durably accepted commands; restart safely replays work | Process crash/restart with before/after reconciliation |

Also record offered/achieved cache-hit and miss ratios per category against a fixed warm/cold acceptance profile and agreed maximum cache ratio; cache-heavy discovery cannot replace required successful local writes.

These thresholds apply to the specified workload and deployment. Do not hide one slow endpoint behind a global percentile. Purposeful 409 stock/slot conflicts and 403 access denials are correctness cases; a load run dominated by them does not prove useful throughput.

Provider-dependent booking/report latency needs a separate SLO using observed provider distributions and quotas. Where a durable command is accepted asynchronously, return an explicit processing state and expose its outcome; a fast HTTP acknowledgment is not a completed external booking.

## Workload and synthetic data

Start with this **100-request/s** expanded mix, then replace weights using pilot traffic. Tag source channel and business type; at least 50 requests/s in this proposed mixed profile should exercise private/direct business operations, including successful writes. Marketplace listing must be disabled for some test organizations. An additional marketplace-focused profile also runs at 100 RPS separately; the profiles are not implicitly added into a 200 RPS target.

| Category | Requests/s | Examples / prerequisites |
| --- | ---: | --- |
| Catalogue/provider/stock discovery | 20 | Private item/tariff and public pharmacy/service discovery, price entitlement; cache-hit and miss cases |
| Patient/clinical reads | 15 | Authorized private/direct patient summary, timeline and report metadata, without requiring patient app login |
| Staff worklists/dashboard | 20 | Doctor appointments, direct/app lab orders, hospital stores and business/vendor worklists; trusted branch/location filters |
| Bookings and appointment changes | 10 | App/walk-in capacity holds and changes; synthetic available capacity |
| Sales/service billing and POS commands | 10 | Pharmacy checkout, private consultation/test invoices, counter sales and permitted fulfilment; source/tariff snapshots |
| Purchasing and stock/consumption commands | 10 | Receive, reserve/consume, waste, count and issue/receive transfer; pharmacy versus non-medicine item/UOM rules |
| Collection verification/receipts | 5 | Stubbed gateway verification and connected cash receipt recording |
| Inbound provider events | 5 | Authenticated events with deliberate replay in a separately tagged subcase |
| Follow-up/service updates | 5 | Task completion, lab transitions or vendor order updates |
| **Total** | **100** | Multi-request journeys must allocate each request within these rates |

Some categories refer to proposed APIs. Do not build a benchmark around invented endpoint paths before contracts exist. Baseline current endpoints first and report the reduced scope explicitly; rerun the full mix when the missing modules ship.

Suggested starting dataset, to be adjusted to actual first-year projections: 100 organizations with multiple branches and staff roles; 100,000 synthetic patients including shared caregiver phones/no-phone/dependents; 500,000 historical bookings and 500,000 pharmacy orders; 5,000 medicines and 100,000 pharmacy/medicine stock records with a realistic batch distribution; released/amended report metadata and pending care tasks. Include aged data, busy organizations, sparse filters and hot medicines. Avoid unrepresentative tests consisting only of fresh indexed records in a tiny database. Log actual counts and bytes.

Include both lab partner modes in that dataset. Demonstrate an API-supplied report and a panel-uploaded report creating one release/review outcome each, repeated-click/callback safety, cross-lab/branch denials, and explicit handover without a second booking. Report upload byte throughput remains a separate test; panel worklist and status commands remain in the 100 RPS mix.

Add representative lab reagents/kits/consumables, clinic supplies and hospital department locations, including fractional stock units, lots/expiry and in-transit transfers. Seed private tariffs, direct patients without app accounts, supplier purchases, opening balances and software-plan records. Test publication off/on, unauthorized private discovery, concurrent stock consumption/sales, transfer replay and financial source attribution. A test/procedure/report retry must not duplicate consumption, receipts or commission; business invoices and platform subscription/settlement records reconcile separately.

Keep normal JSON responses bounded, for example a documented maximum page size and a representative 10–50 KiB response distribution. Test 1–10 MiB uploads/downloads separately using private object storage with authorization; document concurrency and MB/s. Large reports and exports must not silently share the same tiny-payload latency claim.

## Architecture starting point

Retain the modular backend. Start staging with two independently restartable API instances, one dedicated worker process with a supervised spare/recovery strategy, a managed MongoDB replica set, private object storage and a TLS load balancer/reverse proxy. Place components across failure domains if availability requires it. A two-process deployment on one VM does not provide host-failure resilience.

For an initial experiment, allocate roughly 2 vCPU/4 GiB per API process and worker, and an appropriately sized database tier with measured IOPS/memory; this is a benchmark starting point, not a production recommendation without results and cost review. Document actual hardware, region, network, DB topology/storage, container limits, runtime versions and worker concurrency. Redis is optional: introduce it for a selected queue/cache need after comparing it with hardening the existing persisted Mongo queue.

Budget connections across every process. Example starting ceiling: two API pools of 20 plus worker pool of 10, with additional space for monitoring, migrations, standby processes and failover. Tune from wait-time and server limits rather than multiplying default pools as replicas increase. Set bounded server-selection/socket/request timeouts and backpressure; never allow unlimited provider calls, queues or file parsing in API memory.

Before multi-instance API deployment:

1. Remove local-file ownership assumptions; all clinical documents need shared private storage and audited access.
2. Move startup backfills/index changes into controlled deployment jobs. Existing `syncIndexes()` can drop undeclared indexes and must be reviewed.
3. Move cron/consumer ownership out of API startup or use a tested leader/lease strategy. Ensure timeout and cleanup jobs remain idempotent with overlapping workers.
4. Add liveness/readiness, in-flight drain and SIGTERM shutdown for HTTP, workers and DB connections. Readiness must remain false until required dependencies initialize.
5. Add ingress/auth/provider-client rate limits, request-size limits and timeouts. A fast 429 response to useful offered traffic is not a 100 RPS capacity pass.

## Code-specific bottlenecks to investigate first

| Existing path / observation | Experiment and smallest appropriate change |
| --- | --- |
| `file/controller.serveFileByPath`: synchronous disk read/public cache | Move private data off public static serving; use controlled object access/streaming and measure event-loop delay and transfer memory |
| `specialistPortal.generatePrescriptionPdf`: local filesystem and external `wkhtmltopdf` per request | Dedicated bounded document jobs; retain pending/failure status and version identity, measure PDF throughput separately |
| `pharmacyOrders.resolveOrderItemsPricing`: sequential inventory and medicine lookups per line | Profile query counts; fetch needed medicines/inventory in bounded batches and preserve authoritative pricing/availability checks |
| `externalBookings.syncBookingFromWebhook`: report/provider/email work on callback path | Persist verified inbox first, process with worker, track processing failure and safe replay |
| `TaskQueue`/`JobConsumer`: one claim per init, ten-second scheduler, inline publish consumption | Measure queue growth; add bounded draining, independent worker concurrency and retry/lease recovery before adding queue technology |
| Large service classes and provider fan-out in bookings/assessments | Trace dependency latency and cap provider concurrency/timeouts; cache only safe catalogue data with a defined staleness policy |
| Discovery/summary queries and embedded batches | Run `explain('executionStats')` on representative filters, sorting and tenant scope; measure geo queries and hot-stock write contention before selecting indexes/data changes |
| Root request logging/startup behavior | Use structured sampled request logs without PHI and remove per-request console noise; readiness gates and migrations outside API start |

Candidate index patterns must come from the actual query plan: organization/branch + state + created/due date for worklists; patient + encounter time for timeline; provider + external ID for mappings; organization + operation + idempotency key; event/delivery state + next attempt. Some current indexes already exist. Deduplicate declarations and review uniqueness/partial filters before changes. Add a geospatial representation/index only if measured discovery queries warrant it; the current latitude/longitude fields alone do not establish an indexed spherical search.

Catalogue caches may tolerate bounded staleness; checkout revalidates price/stock. Do not use a shared cache as the authority for balances, reservations, clinical access grants or report release. Keep clinical response caches private and permission-aware.

## Test stages and evidence

1. **Reproducible build and functional gate:** repair lock/install, type/build checks, real replica-set integration tests, seeded test organizations and role tokens. Record all skipped cases; no production credentials or live payment actions.
2. **Single-instance baseline:** use current APIs and controlled provider stubs, profile DB plans/queries, event-loop delay, CPU/memory and queue age. Fix correctness before tuning throughput.
3. **Ramped steady test:** 5-minute warm-up, short 25/50/75 RPS steps, then **30 minutes at 100 RPS**. At the target, approximately 180,000 measured requests should be scheduled. Retain per-endpoint/role/organization results and business reconciliations.
4. **Soak:** 2 hours at 100 RPS after the steady gate passes, about 720,000 scheduled requests. Include normal task/import/report worker traffic and check memory, storage and backlog trends.
5. **Contention/correctness:** at least 100 concurrent attempts for last stock/appointment capacity; mixed sale/procedure consumption; transfer dispatch/receipt replay; fractional UOM conversion; invoice/receipt/refund retries; private/public access; reordered/amended reports. Assert exact quantities/capacity, source/commission and business/platform ledger balances. These races do not replace the useful-work mix.
6. **Recovery:** stop one API, restart a worker during provider delivery, delay provider responses and simulate a failed storage/DB connection. Reconcile accepted writes and queue replay. Run cluster failover only in an isolated authorized staging environment.
7. **Provider contract:** low-rate sandbox checks for LabStack, Healthians, Razorpay and notification services with agreed payloads/signatures/quotas/timeouts. Report these independently from stubbed throughput. Replay duplicate/stale events and validate allowed state changes. Include authorization without capture, capture/expiry and cancellation races, bad then valid client signature, unknown gateway-order creation, second captures, preliminary/final/corrected reports and explicit wallet-credit versus original-method refund reconciliation.
8. **Optional headroom test:** briefly increase to 150–200 RPS to observe controlled overload/backpressure and recovery. This characterizes limits; it does not change the 100 RPS release target.

Use k6 or an equivalent arrival-rate tool. In k6, an arrival rate sets **iterations**, not intrinsically HTTP requests/s. Allocate one measured request per iteration or explicitly calculate aggregate request counts across scenarios, including retries. Supply enough VUs for measured latency and fail the run on dropped iterations. [Official constant-arrival-rate documentation](https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/constant-arrival-rate/).

Each run must retain: application commit/config, dataset seed/counts, hardware/topology, test script revision, provider mode, offered/started/completed/successful rate, p50/p95/p99 per endpoint, failures/timeouts/conflicts, dropped work, DB explain/profiling summary, CPU/heap/event-loop/connection/queue metrics, stock/slot/money reconciliation and exact pass/fail reasons. Do not attach patient data or secrets to results.

Wallet/payment contention fixtures include two concurrent spends against funds for one, duplicate and distinct partial refunds, crash between balance/movement writes, capture then failed client verification then Pay Now, and authorized/unknown-attempt retry. Require no duplicate gateway order or wallet effect, no negative balance and exact movement reconciliation. Test finance cutover with known opening balances and post-cutoff replay before M2 posting; these are not executed results.

Cross-destination refund fixtures race a full wallet credit against a gateway/cash refund on one captured payment. They must contend on one guarded source budget, with exactly one full claim; pending/unknown external refunds retain reserved headroom through timeout/restart and partial returns never exceed the source total.

F14 adds a separate basic-phone/provider trial: simultaneous top-ups against limited partner funding, app/phone balance and slot races, shared-number/PIN denial, missing/duplicate/reordered call events, no-answer, reconnect and uncertain completion. Agree concurrent-call count, setup/queue/reconnect SLO, consent/access checks and per-consultation cost before the live pilot. The canonical 100 HTTP RPS profile is unchanged and does not establish simultaneous-call capacity; tag phone control/callback tests separately and rebase any future representative workload explicitly. [Phone acceptance](PHONE_CONSULTATIONS.md).

F14 security/money/clinical fixtures add a synthetic PIN canary across provider/local logs and persistence, a database-only copy without its separate key, a 1,000-reference spray within the configured abuse window across replicas, Partner-paid consultation server-price/underpayment/duplicate commands, and an ordinary debit racing active held funds. Validate selected funding-purpose restrictions, mutually exclusive hold capture/release, actual-mode/eligible-follow-up prescribing and referral-only charge/refund outcomes. These are unexecuted scenarios and do not change the canonical workload.

Cumulative F14 acceptance additionally covers the original basic-phone/no-SMS, funded-top-up race, shared-phone/caregiver denial, queue/shared doctor capacity, one-charge/reconnect, authorized outcome and callback-replay journey. Test private enrolment with a copied slip failing without independent contact proof; single-use/expired/concurrent challenge consumption; setup/reset/issuance/recovery throttling; completed-change notification and replay revocation. A reset request alone must not lock out a valid patient.

Under a defined cross-account spray at tested capacity, staged controls must throttle abusive traffic while a legitimate verified-contact caller completes PIN verification through reserved capacity; keep authorized encounters and urgent/assisted routes available without bypassing identity/spending checks. Add same/changed practitioner, prior in-person versus remote-only encounter, six-month boundary and changed-condition/context fixtures. These are unexecuted acceptance requirements; global throttling is not a blanket availability guarantee.

## Reliability and release ownership

Proposed recovery starting objectives are **RPO ≤ 15 minutes and RTO ≤ 2 hours**, subject to clinical/operations and budget approval. They are not existing guarantees. Back up encrypted database and object data with integrity/version metadata, align retention/legal holds, and restore into a clean isolated environment. Check patient/document links, invoice/ledger totals and pending event recovery. After restoring, re-pull gateway and lab-provider facts across an overlapping recovery window; reconcile captures, wallet liabilities, business dues and report versions newer than the backup without duplicate effects. A successful backup job without a demonstrated restore does not satisfy the gate.

DevOps owns deployment, backup/restore and metrics; backend owns transactional correctness and bounded dependency behavior; QA owns the repeatable harness and evidence; clinical/operations own urgent escalation and service-continuity procedures. Release only when the agreed functional and performance gates pass together. If one instance meets the target, extra services/databases are unnecessary; if it does not, fix measured bottlenecks and remeasure before a technology migration.

**F14 contact-binding abuse acceptance (AR-25):** include unverified contact possession probes, setup/recovery/protected-lane denials, cashier-owned-number self-approval attempts, shared-family exceptions and concurrent contact-version changes in the separately sized phone workload. Staff-number/unrelated-patient reuse checks and key outage/rotation/compromise-reset drills need bounded queues and named P3 approval; unauthenticated proposals cannot lock out valid patients. These are unexecuted scenarios and do not alter the canonical 100 HTTP RPS table.

**v1.7 restore acceptance:** system15.1–15.2/D9 distinguish generic RPO/RTO from recovery of acknowledged cash, dispensing, manual returns and clinical finalization. Test post-backup revocation/challenge consumption, fresh-login attempts against stale restored authority, and replay of local irreversible effects with independently recoverable evidence or explicit frozen exceptions. A database-local outbox or provider re-pull alone is insufficient. Choose/test the protected recovery generation, per-effect evidence and admission runbook before pilot; no zero-loss or zero-RPO claim is made. The canonical HTTP workload and thresholds remain unchanged.
