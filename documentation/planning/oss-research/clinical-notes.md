# Clinical, hospital and laboratory source review

AS_OF: 2026-11-08. Task A. Public upstream research; official project material only. Baseline supplied by the planning review: Jansetu uses Express/TypeScript/MongoDB and needs private business operations plus optional marketplace participation, OPD/billing first, and both API-connected and panel-managed partner laboratories. These baseline requirements are selection criteria, not independently verified upstream claims.

## Decision

**Engineering recommendation:** evaluate ERPNext plus Marley as one separately deployed business/clinical system, and OpenELIS Global as a separately deployed advanced laboratory system. Neither is a drop-in Express/Mongo module. For the first small lab partner panel, implementing the bounded workflow in Jansetu may cost less than adopting an entire LIS; prove that with a vertical slice. Bahmni is a stronger option if the business deliberately chooses an established integrated hospital distribution and accepts several constituent systems. OpenMRS and OpenEMR are alternatives to that clinical-system choice, not additional mandatory dependencies. [A01–A15]

Confidence: high for upstream language/license and documented scope; medium for suitability, which is an engineering inference. No deployment, security audit, migration rehearsal or 100 RPS benchmark was performed. No external source code was merged or executed. An active repository is not proof of secure operation, tenant isolation, or compatibility with India's billing and clinical workflows.

## Candidate assessment

### 1. ERPNext — business operations reference or separate service

Canonical repository: [frappe/erpnext](https://github.com/frappe/erpnext). GPL-3.0 verified in `license.txt`. Python/Frappe with a relational database; Frappe's default documented stack uses MariaDB/MySQL and Redis. Its site model provides separate tenant databases, unlike merely adding a company field. Marley explicitly integrates ERPNext purchasing, pharmacy/supplies, accounts, assets and HR. This gives a coherent option for in-house sales and stores across the four business types. It would create another billing/stock authority if connected carelessly: choose which system owns each store and invoice before adding an adapter. Verdict: **separate-service spike or workflow reference; no direct source merge**. [A01–A04]

### 2. Marley Health — strongest combined clinical/business spike

Canonical repository: [earthians/marley](https://github.com/earthians/marley); avoid treating the historical `frappe/health` namespace as a separate candidate. GPL-3.0 verified in `license.txt`; Python/Frappe app integrated with ERPNext. README documents patient management, OPD/IPD, laboratory and procedures. Current v16 patient-portal documentation describes appointments/payments and diagnostics invoices/reports; payment collection depends on configuring the Payments app. Appointment documentation links booking to sales invoices. This is close to doctor/clinic and hospital OPD plus daily operations. It is not evidence of Jansetu's marketplace commission, partner onboarding or cross-business patient-access rules. Verdict: **separate-service spike**, tested alongside ERPNext rather than counted as an independent replacement. [A02, A05–A07]

### 3. Bahmni — integrated hospital distribution, larger operational footprint

Canonical distribution repository: [Bahmni/bahmni-docker](https://github.com/Bahmni/bahmni-docker). Its own `LICENSE` is MIT, while `NOTICE` explicitly says independently deployed constituent software has its own licenses. Bahmni's official license page lists MPL-2.0 with healthcare disclaimer, AGPL-3.0, MIT and other licenses across components; it describes a migration still in progress. Do not label the whole distribution MIT. Its documented architecture combines OpenMRS clinical records, OpenELIS laboratory, Odoo ERP and imaging integrations using HTTP/REST and feeds. This covers substantial hospital workflow but adds several service/database/upgrade boundaries. Verdict: **alternative complete hospital-system integration**, with component-by-component provenance review; too broad for automatic merger into an OPD-first backend. [A08–A10]

### 4. OpenMRS — clinical record authority, not complete business software

Canonical repository: [openmrs/openmrs-core](https://github.com/openmrs/openmrs-core). Java application deployed to an application server; relational persistence rather than Mongo models. `LICENSE` contains MPL-2.0 plus a healthcare disclaimer. The core is a customizable patient medical-record platform, and official REST documentation exposes patients, encounters and observations. Choose a supported distribution and modules, not core alone, if evaluating an operational clinic/hospital. The reviewed core/API evidence does not establish retail/wholesale POS, pharmacy stock/accounting or Jansetu settlement workflows. Verdict: **API integration as an alternative clinical authority**, or clinical-model reference. Do not deploy it together with Marley/OpenEMR merely because all three manage patients. [A11–A13]

### 5. OpenEMR — practice-management alternative

Canonical repository: [openemr/openemr](https://github.com/openemr/openemr). GPL-3.0 verified in `LICENSE`; PHP with MariaDB/MySQL, corroborated by its production Compose configuration. README documents EHR, scheduling, practice management and electronic billing. API documentation describes REST/FHIR plus OAuth, and some API material specifically targets US Core. This makes it useful for clinic operation or existing OpenEMR partners, but does not establish suitability of its billing configuration for Jansetu's target businesses or marketplace payouts. Verdict: **separate-service/API alternative for clinic partners**, with a local workflow trial; do not port PHP billing code into TypeScript and assume the license or workflow constraints disappear. [A14–A16, A38]

### 6. OpenELIS Global — strongest specialist LIS candidate

Current canonical repository: [DIGI-UW/OpenELIS-Global-2](https://github.com/DIGI-UW/OpenELIS-Global-2). The older `I-TECH-UW` URL redirects here. Root `LICENSE` is MPL-2.0. Current source uses Java 21/Spring, React and PostgreSQL; the Java build file confirms Spring and PostgreSQL dependencies. Official features cover sample lifecycle, validation, reports, analyzer interoperability, FEFO stock, reorder/equipment functions and optional Odoo billing. These are upstream feature claims, not acceptance-test results. The current README describes a light deployment where internal lab workflows run without the optional FHIR/analyzer sidecars; those sidecars are needed for relevant external exchanges. Verdict: **separate LIS integration spike for advanced labs**. A Jansetu-branded small partner panel still needs a decision on UI ownership and commercial order/report contract. Native webhook authentication/replay semantics, branch/tenant isolation and exact released-feature availability remain unverified. [A17–A20]

Important license distinction: Bahmni's license page describes its bundled/forked OpenELIS component under AGPL; that does not override the current OpenELIS Global repository's MPL root license. Determine the exact fork and release before choosing either distribution. [A09, A18]

### 7. SENAITE — strong LIMS workflow, substantial runtime constraint

Canonical repositories: [senaite/senaite.core](https://github.com/senaite/senaite.core) and [senaite/senaite.lims](https://github.com/senaite/senaite.lims). Core GPL-2.0 verified in `LICENSE`; the README says core must be used with the LIMS UI. Python/Plone application, not an Express library. The official site documents intake, result entry, second-person verification, publishing and an audit trail; the JSON API can expose lab data. However, the current official installation guide explicitly says SENAITE 2.x requires Python 2.7 and notes that runtime no longer receives security fixes. Verdict: **workflow reference or integration with an existing partner**, lower priority for a new Jansetu-operated service until a supported runtime path is proven. Recent commits alone do not remove this constraint. [A21–A24]

### 8. GNU Health — hospital/LIMS alternative; source-version check still needed

Canonical HIS repository: [codeberg.org/gnuhealth/his](https://codeberg.org/gnuhealth/his), established by GNU Health's official developer documentation. Python/Tryton with PostgreSQL, documented in current installation requirements. The official download page describes EMR, hospital and health-information functions and a hospital/lab component. A historical project GitLab `COPYING` page reports GPL-3.0, but current Codeberg `COPYING` could not be retrieved by the research tool. Thus exact current license expression and notices are **unverified at the candidate source version**; do not approve code import based on the older mirror. Current repository activity was also not verified. Verdict: **hospital workflow reference or future separate-system evaluation**, behind the better-evidenced first spikes. [A25–A28]

### 9. Open Hospital — practical hospital reference, separate Java system

Distribution repository: [informatici/openhospital](https://github.com/informatici/openhospital); logic: [informatici/openhospital-core](https://github.com/informatici/openhospital-core). GPL-3.0 verified in both `LICENSE` files. Core Java with MariaDB; the distribution supports desktop/client-server use without internet. The distribution README separates Java Swing GUI, core, documentation and an API/web component explicitly described as work in progress. This is useful evidence for counter-operation and eventual offline workflow design, but does not prove a production-ready multi-tenant web partner dashboard. Verdict: **workflow reference; existing-partner integration only after API maturity is demonstrated**. [A29–A31]

### 10. HospitalRun — exclude as new production foundation

Canonical umbrella: [HospitalRun/hospitalrun](https://github.com/HospitalRun/hospitalrun); linked frontend/server repositories are also archived. Umbrella MIT license verified. Source includes a Node/TypeScript server with Fastify, GraphQL, Nano/PouchDB-related dependencies and a TypeScript frontend; it is not an Express/Mongoose module despite language overlap. Umbrella API metadata says archived, last pushed 2021-02-05; frontend and server archived, last pushed 2023-01-09. Verdict: **historical UI/workflow reference only**, with dependency/provenance review before any isolated reuse. Do not interpret the appealing offline concept or MIT label as readiness for a clinical SaaS launch. [A32–A34]

## Activity snapshot and version discipline

These are GitHub API `pushed_at` observations, not release dates, support promises or security ratings. Default branches are development branches in several candidates; select supported releases during a spike.

| Repository | Archived | Last push observed (UTC date) | Additional pin recorded |
| --- | --- | --- | --- |
| frappe/erpnext | No | 2026-11-08 | No release selected |
| earthians/marley | No | 2026-11-07 | Default-branch commit `7710866b69e86943edefe11e99c2cef2262337cc`, committer date 2026-11-06 |
| Bahmni/bahmni-docker | No | 2026-11-04 | Constituent versions not audited |
| openmrs/openmrs-core | No | 2026-11-07 | Default-branch commit `862af652ae69ef872d37190654ff763cf6633391`, committer date 2026-11-07 |
| openemr/openemr | No | 2026-11-07 | No release selected |
| DIGI-UW/OpenELIS-Global-2 | No | 2026-11-08 | Default-branch commit `57c19b655dd07af02c2e62dbf33fe30735cba235`, committer date 2026-11-07 |
| senaite/senaite.core | No | 2026-11-05 | 2.x branch reviewed |
| senaite/senaite.lims | No | 2026-07-27 | 2.x branch metadata |
| informatici/openhospital | No | 2026-10-14 | Core last push 2026-11-05 |
| HospitalRun/hospitalrun | Yes | 2021-02-05 | Frontend/server archived; last push 2023-01-09 |

Evidence: public API endpoints `https://api.github.com/repos/{owner}/{repository}` for the repositories linked above; first-commit responses from their `/commits?per_page=1` collections for the three pins. Push and commit timestamps describe different events and need not match. GNU Health Codeberg metadata was not available. [A35]

## Integration gates and counter-interpretations

1. **First spike: ERPNext + Marley.** Demonstrate one tenant, branch/store, direct walk-in appointment, OPD invoice/payment, pharmacy stock consumption/return and lab order/report. Then demonstrate a second isolated business. Frappe's site tenancy is a starting mechanism; authorize patient sharing and marketplace publication explicitly. REST and signed-webhook facilities are documented at framework level, but delivery/retry/idempotency and per-event payloads must be verified for the selected releases. [A03–A07, A36–A37]
2. **Second spike: OpenELIS only if advanced labs require it.** Demonstrate Jansetu order ID/patient-ID mapping, sample registration, rejection/recollection, reviewer approval, corrected-report version, private report retrieval and consumable effect. Prove the actual available API/event contract and absence of duplicate events; do not promise a generic webhook merely from FHIR support. [A17–A20]
3. **One authoritative writer per resource.** Define stock-store ownership, invoice issuer, payment/refund ledger and clinical-record authority. Synchronization needs durable event IDs, tenant mappings, reconciliation and a recoverable failure queue. A separate service is still maintained software with license and operational obligations.
4. **Opposing interpretation:** a mature upstream system may save substantial clinical workflow work, while adding database operations, upgrades and adapters. Conversely, a native small lab panel avoids LIS operations but requires us to build and validate signoff, audit and report amendments. No days/weeks saved are claimed before the spikes.
5. **100 RPS:** test the selected end-to-end workload, including the upstream system and timeout/retry behavior. Repository activity, national deployment claims and marketing performance statements are not a benchmark for Jansetu.

## Source registry

All approved records below: source_type **official**, accessibility **public**, observed_date **2026-11-08**, task **A**. Dates are observation dates unless an explicit publication date is stated. Authority is provenance confidence (1–10), not product quality. GitHub hosts most primary source files; many URLs here therefore are not independent organizations or domains. No private-account material was used.

| ID | Source / exact URL | Authority | Scope/date caveat |
| --- | --- | --- | --- |
| A01 | [ERPNext root license](https://github.com/frappe/erpnext/blob/develop/license.txt) | 10 | License text fetched |
| A02 | [Marley README](https://github.com/earthians/marley/blob/develop/README.md) | 9 | Documented scope, not tested behavior |
| A03 | [Frappe stack](https://frappe.io/framework) | 8 | Vendor framework description |
| A04 | [Frappe sites](https://docs.frappe.io/framework/user/en/guides/basics/sites) | 9 | Framework tenancy mechanism |
| A05 | [Marley root license](https://github.com/earthians/marley/blob/develop/license.txt) | 10 | License text fetched |
| A06 | [Marley patient portal](https://marley.frappe.cloud/wiki/patient-portal) | 8 | Page identifies feature as introduced in v16 |
| A07 | [Marley patient appointment](https://marley.frappe.cloud/wiki/patient-appointment) | 8 | Invoice/appointment workflow |
| A08 | [Bahmni Docker license](https://github.com/Bahmni/bahmni-docker/blob/master/LICENSE) | 10 | MIT applies to this repository |
| A09 | [Bahmni license policy](https://www.bahmni.org/license) | 9 | Mixed-component policy; ongoing migration |
| A10 | [Bahmni architecture/community](https://www.bahmni.org/community/) | 8 | Architecture; component versions require pinning |
| A11 | [OpenMRS root license](https://github.com/openmrs/openmrs-core/blob/master/LICENSE) | 10 | Full healthcare disclaimer inspected |
| A12 | [OpenMRS README](https://github.com/openmrs/openmrs-core/blob/master/README.md) | 9 | Core scope and Java deployment |
| A13 | [OpenMRS REST reference](https://rest.openmrs.org/) | 9 | Verify supported resources on selected installation |
| A14 | [OpenEMR root license](https://github.com/openemr/openemr/blob/master/LICENSE) | 10 | GPL v3 text fetched |
| A15 | [OpenEMR README](https://github.com/openemr/openemr/blob/master/README.md) | 9 | Practice-management scope |
| A16 | [OpenEMR API guide](https://github.com/openemr/openemr/blob/master/API_README.md) | 9 | API documentation; US Core context |
| A17 | [OpenELIS canonical README](https://github.com/DIGI-UW/OpenELIS-Global-2/blob/develop/README.md) | 9 | Legacy namespace redirect verified; light deployment |
| A18 | [OpenELIS root license](https://github.com/DIGI-UW/OpenELIS-Global-2/blob/develop/LICENSE) | 10 | MPL 2.0 text fetched |
| A19 | [OpenELIS Java build](https://github.com/DIGI-UW/OpenELIS-Global-2/blob/develop/pom.xml) | 10 | Java/Spring/PostgreSQL source evidence |
| A20 | [OpenELIS capabilities](https://openelis-global.org/features-and-functionality/) | 8 | Product claims, not shipped-version acceptance evidence |
| A21 | [SENAITE core README](https://github.com/senaite/senaite.core/blob/2.x/README.rst) | 9 | Plone/core-to-UI dependency |
| A22 | [SENAITE core license](https://github.com/senaite/senaite.core/blob/2.x/LICENSE) | 10 | GPL v2 text fetched |
| A23 | [SENAITE workflow](https://www.senaite.com/) | 8 | Sample/verification/publishing product description |
| A24 | [SENAITE installation](https://www.senaite.com/docs/installation/) and [JSON API](https://www.senaite.com/docs/json-api/) | 9 | Explicit 2.x/Python 2.7 constraint; two documents |
| A25 | [GNU Health coding](https://docs.gnuhealth.org/his/techguide/development/coding.html) | 9 | Canonical Codeberg repository and Python/Tryton |
| A26 | [GNU Health installation](https://docs.gnuhealth.org/his/techguide/installation/vanilla.html) | 9 | PostgreSQL and runtime requirements |
| A27 | [GNU Health downloads](https://www.gnuhealth.org/download.html) | 8 | Hospital/lab scope |
| A28 | [Historical GNU Health COPYING](https://gitlab.com/gnuhealth/gnuhealth/-/blob/master/COPYING) | 6 | Historical source location; insufficient to approve current import |
| A29 | [Open Hospital distribution README](https://github.com/informatici/openhospital) | 9 | Desktop/offline and web API WIP |
| A30 | [Open Hospital core README](https://github.com/informatici/openhospital-core/blob/develop/README.md) | 9 | Java/MariaDB and component split |
| A31 | [Distribution license](https://github.com/informatici/openhospital/blob/master/LICENSE) and [core license](https://github.com/informatici/openhospital-core/blob/develop/LICENSE) | 10 | Both GPL v3 texts fetched; two files |
| A32 | [HospitalRun root license](https://github.com/HospitalRun/hospitalrun/blob/master/LICENSE) | 10 | Umbrella MIT text fetched |
| A33 | [HospitalRun README](https://github.com/HospitalRun/hospitalrun/blob/master/README.md) | 9 | Links to subprojects |
| A34 | [HospitalRun server manifest](https://github.com/HospitalRun/hospitalrun-server/blob/master/package.json) | 10 | Actual dependency/language evidence |
| A35 | [GitHub repository metadata exemplar](https://api.github.com/repos/DIGI-UW/OpenELIS-Global-2) | 10 | Corresponding public API endpoint fetched for each GitHub row |
| A36 | [Frappe REST API](https://docs.frappe.io/framework/user/en/api/rest) | 9 | Framework integration facility |
| A37 | [Frappe webhooks](https://docs.frappe.io/framework/user/en/guides/integration/webhooks) | 9 | Framework signature facility, not proof of end-to-end delivery |
| A38 | [OpenEMR production Compose](https://github.com/openemr/openemr/blob/master/docker/production/docker-compose.yml) | 10 | MariaDB/MySQL configuration evidence |

Rejected/limited sources: search results from Wikipedia, Reddit and self-hosting directories were not used as evidence. GNU Health current Codeberg `COPYING` raw and HTML URLs were inaccessible through the web tool; current source-version license verification remains open. An obsolete Marley v13 lab-test page was found but not used to establish current v16 behavior. No business is inferred from private credentials or local files.
