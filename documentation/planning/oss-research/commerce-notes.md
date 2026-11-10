# Commerce, inventory and counter-sales reuse research

Task B. Observed 2026-11-08. Public primary sources only. This is engineering selection research; no upstream project was installed, imported, run, security-audited or load-tested. The user wants connected counter sales first, optional marketplace sales, retail/wholesale pricing and private business operations for pharmacies, labs, clinics and hospitals. Existing Jansetu pharmacy FEFO/reservation code remains the comparison baseline supplied by the parent audit; upstream sources below are independent evidence about candidates.

## Recommendation

**Trial ERPNext as a separately operated purchasing/stock/accounting engine if the team is willing to adopt Frappe and its data ownership model. Trial InvenTree for non-medicine supplies where permissive licensing and stock traceability matter. Keep Odoo Community as an alternative to ERPNext, rather than adopting both.** These are integration candidates, not packages that drop into Express/Mongo. No full commerce application in this review has enough evidence for a direct merge recommendation. Confidence: high on stack/license mismatch; medium on operational fit because no proof of workflow or tenant isolation was run. [B01–B12, B14–B18]

There is a credible opposing view: implementing Jansetu's missing purchases/returns/ledger workflows on the existing stock model could cost less than running an ERP integration. Our stock code already covers useful reservations and consumption. The spike must compare total adaptation, reconciliation, deployment and upgrade cost against completing that code. Upstream popularity or a stock module is insufficient evidence of savings.

## Nine-candidate comparison

| Candidate and canonical source | Stack and license evidence | Relevant reuse | Fit and material gap |
|---|---|---|---|
| [ERPNext](https://github.com/frappe/erpnext) | Python/Frappe; ERPNext GPLv3. Current `develop` manifest targets Frappe 17 development and Python >=3.14; do not use that as an assumed production baseline. [B01–B03] | **First broad back-office spike: separate deployment plus adapter**, or workflow reference. | Official docs cover warehouse-aware batches, expiry filtering, multiple buying/selling prices and quantity/customer pricing rules. These overlap purchasing, inventory and wholesale needs. Frappe REST documents provide an integration surface. They do not prove one shared Jansetu tenant model, pharmacy release rules, returns correctness or marketplace financial attribution. [B04–B07] |
| [Odoo Community](https://github.com/odoo/odoo) | Python/PostgreSQL. Root LGPLv3 with bundled-file exceptions. Public 19.0 `product_expiry` explicitly declares LGPL-3; public POS source exists. Default branch observed is **20.0**, while the feature sources here are explicitly 19.0. [B08–B12] | **Alternative back-office spike: separate deployment/API adapter.** | Public `product_expiry` implements dates and FEFO, making the inventory capability stronger evidence than a generic marketing claim. POS brings checkout, payments and its own sessions/accounting dependencies. Inspect all selected add-on licenses and Community/Enterprise boundaries. Platform docs can span paid editions; no promise that every screenshot/API/service is free or available in our chosen deployment. Do not import its Python/Owl stack into Express/Mongo. |
| [Dolibarr](https://github.com/Dolibarr/dolibarr) | PHP with SQL databases; GPLv3-or-later; bundled dependencies carry other licenses. [B13–B14] | **Second-tier standalone ERP integration or workflow reference.** | Official sources cover TakePOS, lot/date data and extensible REST services. This makes it a plausible smaller back-office candidate. Lot expiry fields do not establish automatic pharmacy-safe FEFO, quarantine/recall, batch-correct return handling or clinical authorization. Marketplace multi-tenant isolation and all needed modules remain unverified. [B15–B17] |
| [InvenTree](https://github.com/inventree/InvenTree) | Python/Django/DRF backend, React UI, SQL database choices, REST/plugin interfaces; MIT. [B18–B19] | **Best permissively licensed stock-engine spike; separate service first. Selected code only after file/dependency review.** | Suits purchase receipts, locations, quantity movements, traceability and consumables. Stock API schema includes expiry. Audit documentation says tracking requires the audit-log setting; this must be enabled and tested. Hardware/parts and assembly vocabulary needs adaptation. A pharmacy POS, clinical sample reagent consumption, billing/tax engine and tenant isolation are not established by the examined sources. Do not replace one-stock-owner design with bidirectional quantity edits. [B20–B22] |
| [Open Source POS / OSPOS](https://github.com/opensourcepos/opensourcepos) | PHP/CodeIgniter 4 + MySQL, Bootstrap UI. **MIT text plus a mandatory visible, unchanged footer on every page**; not plain MIT. Composer's `MIT` label alone misses that clause. [B23–B25] | **Counter workflow reference; conditional standalone pilot. No white-label merge recommendation.** | Documented receiving, cash-up, barcodes, sales register, invoices, customers and permissions are useful counter requirements. The README's GST field/support does not establish India compliance. Batch/expiry dispensing, full wholesale contracts, medical records, offline sync and tenant isolation were not verified. Every-page footer condition conflicts with an assumption of freely rebranding the panel. |
| [uniCenta oPOS official source route](https://unicenta.com/downloads/sources/) | Official FAQ says Java and GPLv3; official versioned release material describes MariaDB migration. **Source archive license and dependency bundle were not downloaded/verified.** No official GitHub repository established. [B26–B29] | **Desktop counter/hardware reference; defer integration.** | Official source index lists 5.5.1 dated 2026-09-26 and release notes describe integration changes. This disproves an assumption of abandonment from a stale GitHub mirror. But official pages include version-dependent MySQL/MariaDB advice; API entitlement/access and current source package need a dedicated check. A release-linked Gitea issue URL returned 404. No authenticated access was attempted. Do not equate this with API absence or import an unofficial fork. |
| [IDURAR ERP CRM](https://github.com/idurar/idurar-erp-crm) | Closest language fit: Node/Express/Mongo + React/AntD/Redux. Root LICENSE and README say **AGPLv3**; `backend/package.json` says **Fair-code License**. Manifest uses Mongoose 8 versus Jansetu's audited Mongoose 6.6. [B30–B32] | **Invoice/quote/payment workflow reference; conditional code spike only after license clarification.** | README explicitly lists invoices, payments, quotations and customers. Generic ERP/inventory wording is not evidence of batch stock, purchasing, clinical billing, reconciliation, SaaS tenant isolation or robust GST. The matching stack does not remove model/auth/version migration cost. AGPL source obligations and the inconsistent manifest must be resolved before commercial code reuse. |
| [Akaunting](https://github.com/akaunting/akaunting) | Laravel/PHP + SQL; current README and LICENSE specify **Business Source License 1.1**, with version-specific GPLv3 change after four years. [B33–B34] | **Exclude current code from Jansetu's unrestricted OSS SaaS shortlist.** | Current production grant limits more than two users, one company or 1,000 invoices, prohibits removing branding, and excludes an accounting service offered to third parties. That directly conflicts with the intended multiple-business accounting panel under the stated grant. An alternative commercial agreement or separately audited older version could change selection, but was not evaluated. Do not call current head GPL or assume an older license applies. |
| [Tryton](https://github.com/tryton/tryton), official upstream [code.tryton.org](https://code.tryton.org/tryton) | Python server/modules, SQL backend; `trytond/COPYRIGHT` says GPLv3-or-later. GitHub is a mirror, not the sole canonical activity source. [B35–B37] | **Modular ERP workflow reference; alternative separate-engine candidate.** | Official stock documentation lists warehouses, lots, expiration dates and secondary units. Lot-shelf-life documentation describes forecast-quantity exclusion near expiry. That is useful modeling evidence but does not establish pharmacy FEFO allocation or regulatory suitability. It adds a second Python platform and mapping/upgrade work; lower priority than a focused ERPNext/InvenTree trial. [B38–B39] |

## Maintenance snapshot, not a quality score

All eight successfully queried GitHub repository metadata responses reported `archived=false`. The table records the observed default-branch commit, not a stable release recommendation. A recent translation or profile change does not prove feature maintenance, security response or support capacity. uniCenta uses the official source archive route instead of the failed guessed GitHub path. API endpoint evidence is recorded in B40. Confidence: high on captured metadata, low on security/support inference.

| Repository | Observed head (short SHA) | Committer date UTC | Interpretation limit |
|---|---|---|---|
| frappe/erpnext | `fee9cb4b0e61` | 2026-11-08 | `develop`, includes v17 development requirements |
| odoo/odoo | `41f91eb726dd` | 2026-11-08 | 20.0 head; 19.0 features checked separately |
| Dolibarr/dolibarr | `80eb087226f0` | 2026-11-08 | Development head, not release certification |
| inventree/InvenTree | `35428bcb9fca` | 2026-11-07 | Default branch, no workload measurements |
| opensourcepos/opensourcepos | `603b2c7c8fd5` | 2026-11-07 | Spanish translation commit |
| idurar/idurar-erp-crm | `e935dec13cf8` | 2026-08-14 | Maintainer profile change |
| akaunting/akaunting | `a02f4dab4fad` | 2026-11-07 | Language-text update; license exclusion remains |
| tryton/tryton | `fafeee9999a5` | 2026-11-06 | Mirror head; inspect official upstream too |

## Concrete spike and adoption gates

1. **Choose one authority per aggregate.** If ERPNext/InvenTree owns stock, Jansetu cannot independently decrement the same units. Use a command/reservation adapter, durable event/outbox delivery, external-ID mapping, idempotent processing and reconciliation. Define whether each purchase, invoice, payment/refund and stock movement is owned by Jansetu or the external engine. This is proposed architecture, not an already verified candidate feature.
2. **Replay the same acceptance fixture on the two strongest candidates and native Jansetu.** Include box-to-strip-to-tablet conversion and rounding, two batches with differing expiries, quarantine/expired exclusion, purchase partial receipt, branch transfer, simultaneous counter/app last-unit sale, wholesale eligibility and price snapshot, partial customer return to the original batch, supplier return, debit/credit note, partial refund and repeated delivery of the same event. Include lab/clinic consumable issue to a service with wastage and reversal.
3. **Keep business boundaries explicit.** Test business A attempting to read/edit business B's customers, invoices, vendor prices, stock and exports. Test a standalone private business with no public listing and an opted-in marketplace seller. Do not infer tenant isolation from multi-company labels or multiple users.
4. **Pin an exact supported release and inspect its whole dependency/license set.** Preserve required notices, record source provenance and local modifications, check redistribution/network-use obligations for the proposed deployment, and test upgrade/rollback/export. Service separation does not automatically settle all license obligations. Porting Python/PHP code to TypeScript does not remove its copyright/license provenance.
5. **Measure cost and load after correctness.** Record deployment resources, integration code, retry/reconciliation operations, staff workflow steps and migration effort; then measure the actual mixed workload at 100 RPS with the chosen stock owner and concurrent counter/app writes. No repository here has been shown to satisfy Jansetu's 100 RPS objective. Do not reduce the existing roadmap estimate before these results.

## Approved evidence registry

All records below are **Source-Type: official; Accessibility: public; Observed: 2026-11-08; Task: B**. Authority 9 denotes actual upstream license/source/API metadata, 8 denotes official product documentation (which can span editions/versions). Publication dates are unknown unless stated in the text; observation dates are not publication dates. These sources establish technical/product statements, not independent proof of deployment quality.

- B01 (9): ERPNext license — https://github.com/frappe/erpnext/blob/develop/license.txt
- B02 (9): ERPNext Python/Frappe development requirements — https://github.com/frappe/erpnext/blob/develop/pyproject.toml
- B03 (9): ERPNext repository — https://github.com/frappe/erpnext
- B04 (8): Batch and expiry filtering — https://docs.frappe.io/erpnext/batch
- B05 (8): Item Price, multiple price lists and batch prices — https://docs.frappe.io/erpnext/item-price
- B06 (8): Pricing rules — https://docs.frappe.io/erpnext/pricing-rule
- B07 (8): Frappe REST document API — https://docs.frappe.io/framework/user/en/api/rest
- B08 (9): Odoo root LGPL license and bundled exceptions — https://github.com/odoo/odoo/blob/20.0/LICENSE
- B09 (9): Odoo 19 public product-expiry module and LGPL declaration — https://github.com/odoo/odoo/blob/19.0/addons/product_expiry/__manifest__.py
- B10 (9): Odoo 19 public POS manifest/dependencies — https://github.com/odoo/odoo/blob/19.0/addons/point_of_sale/__manifest__.py
- B11 (8): Odoo 19 FEFO documentation — https://www.odoo.com/documentation/19.0/applications/inventory_and_mrp/inventory/shipping_receiving/removal_strategies/fefo.html
- B12 (8): Odoo 19 source installation, Python/PostgreSQL — https://www.odoo.com/documentation/19.0/administration/on_premise/source.html
- B13 (9): Dolibarr GPLv3 license — https://github.com/Dolibarr/dolibarr/blob/develop/COPYING
- B14 (9): Dolibarr README, GPLv3-or-later/dependency notice — https://github.com/Dolibarr/dolibarr/blob/develop/README.md
- B15 (8): TakePOS — https://wiki.dolibarr.org/index.php/Module_Point_of_sale_%28TakePOS%29
- B16 (8): Lot/Serial module — https://wiki.dolibarr.org/index.php/Module_Lot_/_Serial_%28developer%29
- B17 (8): REST service module — https://wiki.dolibarr.org/index.php/Module_Web_Services_REST
- B18 (9): InvenTree MIT license — https://github.com/inventree/InvenTree/blob/master/LICENSE
- B19 (9): InvenTree architecture/integration/SQL choices — https://github.com/inventree/InvenTree/blob/master/README.md
- B20 (8): InvenTree stock traceability, audit-log dependency — https://docs.inventree.org/en/stable/stock/tracking/
- B21 (8): InvenTree stock API schema, expiry field — https://docs.inventree.org/en/stable/api/schema/stock/
- B22 (8): InvenTree purchase orders — https://docs.inventree.org/en/stable/purchasing/purchase_order/
- B23 (9): OSPOS license, including mandatory visible footer clause — https://github.com/opensourcepos/opensourcepos/blob/master/LICENSE
- B24 (9): OSPOS capabilities and framework — https://github.com/opensourcepos/opensourcepos/blob/master/README.md
- B25 (9): OSPOS PHP/CodeIgniter/MySQL manifest — https://github.com/opensourcepos/opensourcepos/blob/master/composer.json
- B26 (8): uniCenta official source archive index, 5.5.1 entry dated 2026-09-26 — https://unicenta.com/downloads/sources/
- B27 (8): uniCenta official FAQ, GPLv3/Java declaration — https://unicenta.com/faqs/
- B28 (8): uniCenta official 5.5.1 release notes; no year assumed from that page alone — https://unicenta.com/unicenta-opos-release-5-5-1/
- B29 (8): uniCenta versioned installation/database transition — https://unicenta.com/unicenta-opos-release-5-0/
- B30 (9): IDURAR root AGPLv3 — https://github.com/idurar/idurar-erp-crm/blob/master/LICENSE
- B31 (9): IDURAR features and README AGPL declaration — https://github.com/idurar/idurar-erp-crm/blob/master/README.md
- B32 (9): IDURAR dependencies and inconsistent license label — https://github.com/idurar/idurar-erp-crm/blob/master/backend/package.json
- B33 (9): Akaunting BSL production restrictions and change license — https://github.com/akaunting/akaunting/blob/master/LICENSE.txt
- B34 (9): Akaunting Laravel/SQL/BSL README — https://github.com/akaunting/akaunting/blob/master/README.md
- B35 (9): Tryton server GPLv3-or-later copyright notice — https://github.com/tryton/tryton/blob/main/trytond/COPYRIGHT
- B36 (9): Tryton server GPLv3 text — https://github.com/tryton/tryton/blob/main/trytond/LICENSE
- B37 (9): Tryton package/mirror overview — https://github.com/tryton/tryton/blob/main/README.rst
- B38 (8): Tryton versioned stock modules — https://docs.tryton.org/7.8/stock.html
- B39 (8): Tryton lot expiration behavior — https://docs.tryton.org/7.8/modules-stock-lot-sled/index.html
- B40 (9): Repository metadata and commit snapshots: `https://api.github.com/repos/{owner}/{repo}` and `https://api.github.com/repos/{owner}/{repo}/commits?per_page=1`, for the eight repository names in the maintenance table. Full head hashes: ERPNext `fee9cb4b0e614261a9d0138d444f2654daf5d27c`; Odoo `41f91eb726dd354dbbf193e724fce4e4d9a34971`; Dolibarr `80eb087226f07475e4df1026b4cb048c7181e90e`; InvenTree `35428bcb9fca49504864ba2d60accdc22ae4ccf4`; OSPOS `603b2c7c8fd5f3b2d64a3730e0f7ea38c82872ea`; IDURAR `e935dec13cf8b6082a7e7fc4736669e5151a80a3`; Akaunting `a02f4dab4fad115400738be11cae96efc9846bad`; Tryton `fafeee9999a541cf99957cda181e5b3605dde3c2`.

Dropped/limited evidence: guessed `unicenta/unicentaopos` GitHub path was not established; a release-linked `https://repo.unicenta.io/unicenta-base/unicenta-opos/issues/21` returned 404; Tryton `/latest/modules-stock-lot-sled/index.html` was inaccessible, so versioned 7.8 documentation was used; guessed InvenTree `/stock/stock/` returned 404, so actual schema and tracking pages were used. No forum, comparison blog, private account or unverified mirror supports a selection conclusion. uniCenta source-archive LICENSE remains unverified, not passed.
