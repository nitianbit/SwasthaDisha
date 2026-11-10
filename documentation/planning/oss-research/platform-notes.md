# Platform, commerce framework and dashboard reuse research

AS_OF: 2026-11-08. Task C. Public primary-source desk review. Confidence is high for the license text and source declarations quoted by reference, medium for integration recommendations, and unverified for production compatibility, security and throughput. No upstream program was installed, executed, imported or merged. This is a bounded ten-project comparison, not an inventory of every public repository.

The Jansetu baseline supplied by the parent review is Express 4, TypeScript 5.4, Mongoose 6.6, TypeDI, Joi, Firebase/JWT, Razorpay and Mongo-backed jobs. It is a comparison input, not independent evidence about an upstream product. Existing pharmacy transactions and booking/payment semantics should remain authoritative unless an explicit migration project replaces them.

## Findings that change the selection

1. **The best direct reuse is a small library or UI framework.** CASL can express record permissions and has a Mongo/Mongoose adapter; Refine Core can supply a React panel shell and data/auth/access-control adapters. These do not supply tenant isolation, lab state transitions, payment correctness or clinical signoff by themselves. Choose one UI framework rather than adopting both Refine and react-admin. [C05–C15]
2. **BullMQ no longer means Redis is the only backend.** Its current default is Redis-compatible storage, while current source/docs include an optional PostgreSQL backend, using the `pg` package and PostgreSQL 13+ (14+ recommended by upstream). The inspected branch manifest says 6.6.1; that is a source declaration, not proof that every published 6.x release includes this backend. Verify the selected release archive before planning PostgreSQL deployment. Either option introduces infrastructure beyond the supplied Mongo baseline. [C01–C04]
3. **TypeScript does not make Medusa or Vendure an Express/Mongo module.** Both have their own commerce model, persistence and framework; Vendure uses NestJS/GraphQL/TypeORM SQL, and Medusa uses its own framework/modules and PostgreSQL. Prefer workflow study or a separately scoped replacement/integration spike rather than copying their order and stock services into Jansetu. [C18–C23]
4. **Several familiar “open source” products have paid subtrees.** Medusa explicitly excludes Enterprise RBAC/SSO materials from MIT. Vendure defaults to GPLv3 with a commercial alternative and a limited separately distributed plugin exception. Novu and Chatwoot have proprietary Enterprise material. A root license badge cannot approve every directory. [C16–C17, C20–C21, C24–C30]
5. **k6 belongs in verification tooling.** Its arrival-rate executor controls iteration starts. A script containing several HTTP requests per iteration does not generate the same numerical RPS as its iteration rate; measure `http_reqs`, errors, latency and dropped iterations. No candidate's upstream claim demonstrates Jansetu's 100 RPS target. [C31–C33]

## Candidate matrix

| Candidate and canonical repository | Stack and license checked | Useful reuse and limits | Verdict for this plan |
| --- | --- | --- | --- |
| [BullMQ](https://github.com/taskforcesh/bullmq) | TypeScript/Node; MIT core. Default Redis-compatible backend; current source also provides optional PostgreSQL/`pg`. Commercial Pro features are separate. [C01–C04] | Retries, worker lifecycle and job processing could replace fragile dispatch plumbing. Durable acceptance, Mongo-to-queue delivery, idempotency, webhook signatures and financial invariants still belong to Jansetu. Do not add a queue merely to claim scale. | **Conditional library adoption.** First compare with hardening the existing Mongo queue; select one queue backend after a recovery spike. |
| [CASL](https://github.com/stalniy/casl) | TypeScript/JavaScript; MIT. Inspected `@casl/mongoose` package declares Mongoose `^6.0.13`, 7, 8 or 9 and `@casl/ability ^7.0.0`. Existing 6.6 is in that declared range; a build/runtime test is still required. [C05–C07] | Object/action/field conditions plus query filtering fit organization, branch, lab technician, signatory and vendor access. Its README warns against combining permission conditions with object spreads that can overwrite them; use restrictive conjunction. Aggregations, updates, exports and document delivery need their own checked paths. | **First backend library spike.** Preserve existing authentication; centralize policy and fail closed. |
| [OpenFGA](https://github.com/openfga/openfga) | Go service, Apache-2.0; Node SDK available. Persistent PostgreSQL/MySQL options; SQLite is described as beta in README; default in-memory data is ephemeral. [C08–C09] | Relationship authorization suits complex shared patient/team access across independent organizations. Adds an authorization service, tuple lifecycle, migrations, consistency and availability concerns. It does not replace Mongo query scoping. | **Defer separate service.** Revisit only if measured relationship complexity outgrows local policies. Avoid two independent policy authorities. |
| [Refine Core](https://github.com/refinedev/refine) | React/TypeScript; repository MIT. Headless UI framework with data, auth and access-control provider interfaces; current Refine commercial product/site is distinct from MIT Core. [C10–C12] | Good panel foundation for lab orders/report uploads, stock screens, appointments and branch settings over Jansetu APIs. Core `can` integration is policy-agnostic. UI access checks are convenience; server enforcement remains mandatory. No assumption that a commercial Refine service or every external template is included. | **Preferred panel spike** if frontend stack agrees. Build custom clinical flows on top of ordinary CRUD. |
| [react-admin](https://github.com/marmelab/react-admin) | React/TypeScript, REST/GraphQL data providers; MIT core. `ra-rbac` is a paid Enterprise package. [C13–C15] | Alternative for forms, tables, filtering and staff CRUD. Existing auth/policy can be adapted without buying `ra-rbac`; do not count paid scheduler/RBAC features as free scope. Complex clinical workflows require custom routes/components. | **Alternative to Refine.** Pick after the same one-flow comparison; do not maintain two dashboard frameworks. |
| [Medusa](https://github.com/medusajs/medusa) | TypeScript/Node, own framework and PostgreSQL. MIT except paths identified by proprietary Enterprise license, notably RBAC/SSO. Installation and Cloud pages show differing runtime prerequisites, so pin a release before choosing Node. [C16–C19] | Modules and commerce workflows are useful reference material. A commerce service might be viable if Jansetu deliberately replaces catalog/cart/order authority. No reviewed evidence establishes pharmacy FEFO, prescription release or clinical tenancy suitable for Jansetu. | **No direct backend merge.** Defer a separate commerce replacement spike; Enterprise subtree excluded absent a valid commercial agreement. |
| [Vendure](https://github.com/vendurehq/vendure) | TypeScript/Node/NestJS/GraphQL; TypeORM-compatible SQL. Default GPLv3 (text permits later versions), or commercial license; limited separate-plugin exception. [C20–C23] | Channels provide multi-store/multi-vendor building blocks. Their presence is not proof of Jansetu clinical isolation, pharmacy batch controls or financial settlement correctness. Plugin exception does not make copied framework code permissively licensed. | **No direct backend merge.** Consider separate commerce service only after license and full replacement decision. |
| [Novu](https://github.com/novuhq/novu) | TypeScript/Node services; self-host docs include MongoDB, Redis, worker/API/WS/dashboard and object storage. MIT core with proprietary Enterprise packages/paths; those terms restrict commercial hosting and modification. [C24–C27] | Notification orchestration/provider integration could help later reminders and report-ready messages. Email/SMS providers, consent, template approval, delivery economics and sensitive data minimization remain separate requirements. Adds a second operations platform. | **Later optional API service.** Native outbox plus existing providers is the simpler initial baseline unless notification workflow needs justify it. |
| [Chatwoot](https://github.com/chatwoot/chatwoot) | Ruby/Rails service and frontend; PostgreSQL, Redis and Sidekiq. MIT outside Enterprise/other listed exceptions; Enterprise production use needs valid entitlement. [C28–C30] | Customer-support conversations and omnichannel tickets could help a support team. It is not the lab/doctor/vendor operational panel and should not become a clinical record store. Attachment retention, staff scope and integration secrets need explicit handling. | **Later separate support service.** No backend source merge. |
| [k6](https://github.com/grafana/k6) | Go CLI with JavaScript test scripts; AGPL-3.0. [C31–C33] | Useful for reproducible API workload, latency/error thresholds and reported HTTP throughput. Clinical/payment correctness assertions must accompany load; run synthetic data and provider sandboxes/stubs. Running this standalone tool does not require replacing the application runtime. | **Adopt as a development/CI tool candidate**, after the build/install baseline is repaired. No app code merge. |

## Three initial spikes and exit criteria

These are proposed experiments, not implementation authorization or promised savings. Estimated elapsed time is deliberately omitted until the owning developers scope the sample flows.

1. **CASL policy proof.** Model two organizations, two branches, doctor, reception, lab technician, signatory and vendor roles. Exercise list/detail/update/export/report-download boundaries using real backend query paths. Pass only when cross-organization access is denied, branch limits hold, signoff roles cannot be bypassed and the existing TypeScript/Mongoose build passes with pinned package versions. Field visibility and revocation must be explicit. A compatible peer-dependency range alone is insufficient. [C05–C07]
2. **One lab panel in Refine, compared with react-admin only if necessary.** Show order inbox, sample status, report upload/version/finalize and appointment/cashier navigation using the existing API contract. Pass only when pagination/filtering, uploads, failed save recovery, role-specific actions and tenant switching work with server-enforced access. Test keyboard use and mobile counter operation. Keep the same backend authority and measure custom code required; reject a framework that forces API rewrites or paid components for the agreed MVP. [C10–C15]
3. **Queue recovery proof with BullMQ versus hardened Mongo baseline.** Use the same outbox/job contract for report-ready webhooks and booking reminders. Kill a worker after a side effect, replay deliveries, restart the queue store and make a downstream endpoint time out. Pass when jobs recover, attempts are observable, retry/replay is safe, no duplicate financial mutation occurs and HTTP acknowledgement does not wait for provider work. Choose Redis-compatible storage or PostgreSQL only after pinning a release that contains the chosen backend and testing backup/restore. Add k6 as an independent workload harness; verify actual HTTP RPS and zero integrity failures. [C01–C04, C31–C33]

Counter-view: a dedicated ERP/commerce service may save more time than native development if its exact workflow already fits and its operators can sustain upgrades, integration and reconciliation. These sources do not establish that fit. Conversely, a small local policy module and a hardened Mongo queue may suffice initially; introducing CASL/BullMQ should be justified by the measured spike, not repository popularity.

## Activity snapshot and reproducibility

All ten repository metadata responses reported `archived: false`. The default-branch commit responses below were observed on 2026-11-08; commit date is not a release date, support promise, vulnerability assessment or proof of ongoing maintenance. License files were inspected on each default branch during the same review. Before reuse, fetch the chosen immutable commit/tag again, record all third-party notices, package lock/dependency licenses and source modifications. A repository-wide dependency/SBOM audit was not performed.

| Repository | Observed default-branch SHA | Committer date UTC | Evidence |
| --- | --- | --- | --- |
| taskforcesh/bullmq | `4d5e6931e1309640a186f76c7029e21a4fc217b5` | 2026-11-07 | C34 |
| stalniy/casl | `bc853d7dbbb66d331789a574cba5cff2e231673f` | 2026-11-07 | C35 |
| openfga/openfga | `4b09dafb027d839e6c42073e6e288f5ea6881d4d` | 2026-11-07 | C36 |
| refinedev/refine | `2352eb5b6539e2f39ad9aef652279ad1dcf2c467` | 2026-09-10 | C37 |
| marmelab/react-admin | `c1526acdd163686351b9b99e369721ec2c56bd6c` | 2026-11-07 | C38 |
| medusajs/medusa | `0f9014650066193280e0cbc4f3898c02319fffc6` | 2026-11-06 | C39 |
| vendurehq/vendure | `aebec39ba62d805870ef135396fd2fd63d60a58a` | 2026-11-06 | C40 |
| novuhq/novu | `46ff54befda2a5174bd2016cdff00326d9f3921a` | 2026-11-07 | C41 |
| chatwoot/chatwoot | `625d5964e3cb3f1d917b43c3b8332219e525a4b8` | 2026-11-06 | C42 |
| grafana/k6 | `4ac4745707bcf432bca392f13c4248e9924a04ed` | 2026-11-06 | C43 |

## Source registry

All approved sources below are **source_type: official; accessibility: public; observed: 2026-11-08; task: C; authority: 9/10** for their own code/license/API declarations. Publication dates are not inferred where absent; the activity table records dates supplied by commit metadata. Official product descriptions alone do not substantiate production suitability. Source range notation in this note is shorthand for the listed individual IDs.

| ID | Title / role | URL |
| --- | --- | --- |
| C01 | BullMQ license | https://github.com/taskforcesh/bullmq/blob/master/LICENSE |
| C02 | BullMQ connections | https://docs.bullmq.io/guide/connections |
| C03 | BullMQ PostgreSQL backend, cross-checked source | https://docs.bullmq.io/guide/postgresql |
| C04 | BullMQ package/runtime/optional peers | https://github.com/taskforcesh/bullmq/blob/master/package.json |
| C05 | CASL license | https://github.com/stalniy/casl/blob/main/LICENSE |
| C06 | CASL Mongo/Mongoose conditions and caveats | https://github.com/stalniy/casl/blob/main/packages/casl-mongoose/README.md |
| C07 | CASL Mongoose peer compatibility | https://github.com/stalniy/casl/blob/main/packages/casl-mongoose/package.json |
| C08 | OpenFGA license | https://github.com/openfga/openfga/blob/main/LICENSE |
| C09 | OpenFGA storage/server configuration | https://openfga.dev/docs/getting-started/setup-openfga/configure-openfga |
| C10 | Refine Core license | https://github.com/refinedev/refine/blob/main/LICENSE |
| C11 | Refine access-control provider | https://refine.dev/core/docs/advanced-tutorials/access-control/ |
| C12 | Refine Core role and framework boundaries | https://github.com/refinedev/refine/blob/main/README.md |
| C13 | react-admin license | https://github.com/marmelab/react-admin/blob/master/LICENSE.md |
| C14 | react-admin framework/edition documentation | https://marmelab.com/react-admin/Readme.html |
| C15 | Paid ra-rbac package boundary | https://ra-enterprise.marmelab.com/documentation/ra-rbac/latest |
| C16 | Medusa MIT exceptions | https://github.com/medusajs/medusa/blob/develop/LICENSE |
| C17 | Medusa proprietary RBAC/SSO materials | https://github.com/medusajs/medusa/blob/develop/ENTERPRISE-LICENSE.md |
| C18 | Medusa local installation/persistence/runtime | https://docs.medusajs.com/learn/installation |
| C19 | Medusa module architecture | https://docs.medusajs.com/learn/fundamentals/modules |
| C20 | Vendure dual license | https://github.com/vendurehq/vendure/blob/master/LICENSE.md |
| C21 | Vendure plugin exception | https://github.com/vendurehq/vendure/blob/master/license/plugin-exception.txt |
| C22 | Vendure stack overview | https://docs.vendure.io/current/framework/developer-guide/overview |
| C23 | Vendure channels | https://docs.vendure.io/current/framework/core-concepts/channels |
| C24 | Novu core MIT license | https://github.com/novuhq/novu/blob/next/LICENSE-MIT |
| C25 | Novu proprietary package restrictions | https://github.com/novuhq/novu/blob/next/EE-PACKAGES-LICENSE |
| C26 | Novu open-core declaration | https://github.com/novuhq/novu |
| C27 | Novu self-hosted services/dependencies | https://docs.novu.co/community/self-hosting-novu/overview |
| C28 | Chatwoot MIT exceptions | https://github.com/chatwoot/chatwoot/blob/develop/LICENSE |
| C29 | Chatwoot Enterprise license | https://github.com/chatwoot/chatwoot/blob/develop/enterprise/LICENSE |
| C30 | Chatwoot runtime/storage/worker requirements | https://developers.chatwoot.com/self-hosted/deployment/requirements |
| C31 | k6 AGPL license | https://github.com/grafana/k6/blob/master/LICENSE.md |
| C32 | k6 arrival-rate executor semantics | https://grafana.com/docs/k6/latest/using-k6/scenarios/executors/constant-arrival-rate/ |
| C33 | k6 HTTP/dropped-iteration metrics | https://grafana.com/docs/k6/latest/using-k6/metrics/reference/ |
| C34 | BullMQ head metadata | https://api.github.com/repos/taskforcesh/bullmq/commits?per_page=1 |
| C35 | CASL head metadata | https://api.github.com/repos/stalniy/casl/commits?per_page=1 |
| C36 | OpenFGA head metadata | https://api.github.com/repos/openfga/openfga/commits?per_page=1 |
| C37 | Refine head metadata | https://api.github.com/repos/refinedev/refine/commits?per_page=1 |
| C38 | react-admin head metadata | https://api.github.com/repos/marmelab/react-admin/commits?per_page=1 |
| C39 | Medusa head metadata | https://api.github.com/repos/medusajs/medusa/commits?per_page=1 |
| C40 | Vendure head metadata | https://api.github.com/repos/vendurehq/vendure/commits?per_page=1 |
| C41 | Novu head metadata | https://api.github.com/repos/novuhq/novu/commits?per_page=1 |
| C42 | Chatwoot head metadata | https://api.github.com/repos/chatwoot/chatwoot/commits?per_page=1 |
| C43 | k6 head metadata | https://api.github.com/repos/grafana/k6/commits?per_page=1 |

Additional corroborating sources read: BullMQ `src/postgres/index.ts`, `src/postgres/migrator.ts`, `src/postgres/create-postgres-backend.ts` and `docs/gitbook/guide/postgresql.md` at master; OpenFGA README at main; Novu `LICENSE-ENTERPRISE` at next. Medusa [Cloud prerequisites](https://docs.medusajs.com/cloud/projects/prerequisites) were also read and differ from the local installation page's current Node prerequisite; selected-release requirements remain unresolved. CASL's rendered website returned no readable text, so the source adapter README and package manifest were used. Guessed old Novu `LICENSE`/`LICENSE.md` and `ee/LICENSE` paths returned 404 and were replaced by actual root filenames. Old Vendure guide URL timed out; the current docs path succeeded. These failed URLs are not evidence of a missing feature or product abandonment. No community/secondary source supports the recommendations.
