# Scheduling, subscription billing and interoperability research

Task D. Observed **8 November 2026**. Public official sources only. This is source/documentation review; no upstream code was run. Stack/feature fit is an engineering judgment against Jansetu's existing Express/TypeScript/Mongoose backend and the agreed roadmap.

## Findings

| Candidate | Verified upstream evidence | Jansetu decision and remaining gap |
| --- | --- | --- |
| [Cal.diy](https://github.com/calcom/cal.diy) | MIT LICENSE; TypeScript/Next.js/Prisma scheduling application. Official Cal.com migration article says the production code moved private and the public community repository became Cal.diy; organization/team, workflow and enterprise features were removed. Current README recommends personal/non-production use. | Workflow reference only for initial scope. MIT permits commercial reuse subject to its terms, but that does not supply missing tenant, clinic, billing or audit workflows. Do not describe current commercial Cal.com as a free repository we can merge. |
| [Easy!Appointments](https://github.com/alextselegidis/easyappointments) | GPL-3.0 LICENSE; official installation guide specifies PHP/MySQL; official REST API documents appointment operations. | Optional separate scheduler for a specific external business; otherwise retain Jansetu's existing booking/calendar integration and repair slot concurrency. A second booking authority adds reconciliation; direct TS code reuse is poor. |
| [Lago](https://github.com/getlago/lago) | AGPL-3.0 root LICENSE; deployment repository references API/front submodules. Inspected compose uses PostgreSQL, Redis and Rails API configuration. Product site distinguishes open source and Premium. | Defer until software subscription billing needs exceed a simple plan/invoice/receipt lifecycle. Integrate as a separate billing service if selected. It does not replace payment processing; Razorpay support and required Premium features need proof. Root GitHub language is Go and is not an accurate description of the whole deployed stack. |
| [Kill Bill](https://github.com/killbill/killbill) | Apache-2.0 LICENSE; Java billing/payment platform. Official architecture explains persistent events and database-backed services; MySQL, MariaDB and PostgreSQL support is discussed. | An alternative to Lago for complex recurring subscriptions, separately operated. Avoid adding both. Prove the selected payment plugin, retries, tax/invoice mapping, cancellation and operational ownership; it is not a ready pharmacy POS. |
| [Invoice Ninja](https://github.com/invoiceninja/invoiceninja) | Current v5-stable LICENSE is Elastic License 2.0. It limits providing a hosted/managed service that exposes a substantial set of its features. Official license documentation confirms ELv2. PHP application. | Exclude from the proposed multi-business SaaS merge shortlist under the inspected terms. Publicly visible source is not enough; obtain suitable separate terms before reconsidering. Branding licenses do not themselves prove permission to offer the requested hosted service. |
| [Medplum](https://github.com/medplum/medplum) | Apache-2.0 platform; official open-source page identifies FHIR server, SDKs and React components. Server manifest is TypeScript/Node with its own runtime requirements; configuration documents PostgreSQL/Redis. | A useful optional FHIR/clinical-platform spike if interoperability becomes a concrete requirement. A specific SDK or component may be reusable; full server adoption is a separate service and clinical-record authority decision. It does not automatically implement Jansetu's consent, financial, stock or partner workflows. |
| [HAPI FHIR](https://github.com/hapifhir/hapi-fhir) | Apache-2.0 LICENSE.txt and official docs; Java client/server libraries, including JPA server. | An alternative FHIR service/library for a Java interoperability boundary, not a drop-in Node module or full HMS. Defer until a named partner requires a specific FHIR exchange/profile. Avoid running HAPI and Medplum without a demonstrated division of responsibility. |

Confidence: high for inspected license identities and repository metadata; moderate for documented feature fit; low for untested operating suitability. Counterpoint: a deployment needing complex calendar federation, mature subscription billing or mandated FHIR could justify an external system earlier. The current OPD/counter/panel scope alone does not establish that need.

## Activity observations

These are GitHub API `pushed_at` values, not latest release dates, support commitments, evidence of reviewed human changes or quality scores. All seven repositories returned `archived=false`.

| Repository | Default branch observed | pushed_at UTC |
| --- | --- | --- |
| calcom/cal.diy | main | 2026-11-03T21:35:09Z |
| alextselegidis/easyappointments | main | 2026-11-02T17:15:59Z |
| getlago/lago | main | 2026-11-06T14:32:50Z |
| killbill/killbill | master | 2026-10-28T23:42:44Z |
| invoiceninja/invoiceninja | v5-stable | 2026-11-06T01:34:42Z |
| medplum/medplum | main | 2026-11-08T00:59:47Z |
| hapifhir/hapi-fhir | master | 2026-11-07T03:15:49Z |

Before adoption capture an exact commit plus the complete dependency/notice inventory. No commit is selected for implementation here.

## Approved source records

All records: source_type **official**, accessibility **public**, observed **2026-11-08**, task **D**. Authority 10 for license/source files, 9 for maintainer technical docs, 8 for product/blog statements. Dates are observation dates unless the publication date is explicit.

- [Cal.diy license](https://github.com/calcom/cal.diy/blob/main/LICENSE) — authority 10.
- [Cal.diy README](https://github.com/calcom/cal.diy/blob/main/README.md) — authority 9.
- [Cal.diy PostgreSQL schema](https://github.com/calcom/cal.diy/blob/main/packages/prisma/schema.prisma) — authority 10.
- [Cal.com public/private split](https://cal.com/blog/cal-diy-open-source-to-closed-source) — authority 8; published 15 April 2026.
- [Easy!Appointments license](https://github.com/alextselegidis/easyappointments/blob/main/LICENSE) — authority 10.
- [Easy!Appointments installation](https://easyappointments.org/documentation/installation/) — authority 9.
- [Easy!Appointments REST API](https://easyappointments.org/documentation/rest-api/) — authority 9.
- [Lago license](https://github.com/getlago/lago/blob/main/LICENSE) — authority 10.
- [Lago deployment composition](https://github.com/getlago/lago/blob/main/docker-compose.yml) — authority 10.
- [Lago submodules](https://github.com/getlago/lago/blob/main/.gitmodules) — authority 10.
- [Lago edition and billing FAQ](https://getlago.com/) — authority 8.
- [Kill Bill license](https://github.com/killbill/killbill/blob/master/LICENSE) — authority 10.
- [Kill Bill architecture](https://killbill.io/kill-bill-architecture) — authority 9.
- [Invoice Ninja license](https://github.com/invoiceninja/invoiceninja/blob/v5-stable/LICENSE) — authority 10.
- [Invoice Ninja license documentation](https://invoiceninja.github.io/docs/legal/license) — authority 9.
- [Medplum open source scope](https://www.medplum.com/open-source) — authority 8.
- [Medplum license](https://github.com/medplum/medplum/blob/main/LICENSE.txt) — authority 10.
- [Medplum server manifest](https://github.com/medplum/medplum/blob/main/packages/server/package.json) — authority 10.
- [Medplum configuration](https://www.medplum.com/docs/self-hosting/config-settings) — authority 9; cached documentation, verify against selected release.
- [HAPI FHIR license](https://github.com/hapifhir/hapi-fhir/blob/master/LICENSE.txt) — authority 10.
- [HAPI JPA introduction](https://hapifhir.io/hapi-fhir/docs/server_jpa/introduction.html) — authority 9; version-specific docs, not a selected release.
- [HAPI README](https://github.com/hapifhir/hapi-fhir/blob/master/README.md) — authority 10.

Metadata source for each activity row is `https://api.github.com/repos/{owner}/{repo}` for the exact owner/repo named there (authority 10). Failed lookups: old calcom/cal.com contents API did not resolve its redirect; Medplum `/docs/self-hosting/requirements` was unavailable; HAPI root `LICENSE` was absent, resolved using `LICENSE.txt`. Those failed URLs do not support claims. Search-directory, Reddit and vendor-comparison results were not used as evidence.
