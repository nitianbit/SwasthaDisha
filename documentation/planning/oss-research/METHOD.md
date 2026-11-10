# Open source reuse research method

AS_OF: **8 November 2026**. Mode: standard, multi-entity technical comparison. This is a bounded search, not an inventory of every public repository. The purpose is to decide which projects merit a compatibility spike for Jansetu's agreed roadmap.

The public-source investigation uses official project repositories, license files, source manifests and maintainer documentation. Repository credentials are used only to fetch public upstream material. Jansetu's local code and existing review establish the integration baseline; they are not independent evidence of an upstream feature. Community lists and search results are discovery aids, not approved evidence. No candidate is installed, imported, executed or merged.

## Work packages

| Task | Research question | Owner/output | Search depth |
| --- | --- | --- | --- |
| A | Which clinical, hospital and laboratory systems are practical integration candidates? | Clinical researcher, clinical-notes.md | Canonical repositories, license files, official workflow/API documentation |
| B | Which ERP, inventory and POS systems improve connected direct/wholesale operations? | Commerce researcher, commerce-notes.md | Commercial workflow fit, licensing, runtime and stock authority |
| C | Which libraries, panel frameworks and platform services fit this backend? | Platform researcher, platform-notes.md | Package boundaries, edition limitations, persistence and operating costs |
| D | Which scheduling, SaaS billing and interoperability options are useful? | Lead, supplementary-notes.md | Current upstream identity, licenses, APIs and duplication of existing code |
| E | What should Jansetu adopt, integrate or leave out? | Lead, ../OPEN_SOURCE_OPTIONS.md | Synthesis against existing capabilities and delivery dependencies |
| F | Which recommendations fail an opposite-view check? | Independent researcher after synthesis, counter-review.md | Claims, source coverage, recency, licensing and overconfidence |

Tasks A–C run in parallel; D runs independently on the lead. Synthesis and counter-review follow the research. Detailed notes preserve uncertainty, failed lookups and official source URLs. Final selection separates direct library reuse, separately operated API integration, workflow reference and exclusion.

## Evidence and acceptance

Sources carry official/public labels, observed date and an authority score. The unified citation registry deduplicates URLs and records approved versus excluded sources; domain diversity reflects hosting diversity, not independent corroboration. Exact releases and head commits are observations, never proof of support or release quality. A license observation applies to the inspected file/version and does not certify every dependency or edition.

Before adoption: pin a commit/version; inventory licenses, notices and dependencies; prove compatible runtime/build; demonstrate organization/branch isolation; decide the patient/order/stock/money authorities; test retries, concurrent writes, corrections and rollback; then test the released workload at 100 RPS. No upstream benchmark establishes Jansetu's capacity. No schedule reduction is assumed until a spike passes.

Research confidence is high for directly inspected license statements and repository metadata, moderate for feature fit from official documentation, and low for untested operational suitability. At least three potential errors or opposing interpretations must be recorded during counter-review and resolved or retained as limitations.
