# Offline diagnostic candidate evidence

Final unit evidence is `node22.tap` and `node24.tap`: 185 passes each, no failures/skips/TODOs/cancellations, empty stderr. The initial 180-case run and pre-implementation failing run record earlier stages. All Docker responses/bundle texts in the unit gate are synthetic. No application module is imported.

`gate-canaries.json` records 22 runner controls. `companion-probes.json` records 20 owned synthetic link, entirely replaced launcher-factory and permission-metadata checks. `network-block-probes.json` records ten executions of the actual extracted bootstrap network block with fake readers. `controller-offline-probes.json` records ten extracted emitter/transport-body executions with every sink replaced. These are harness code checks, not real bootstrap initialization or Docker execution.

`old-controller.json` records eight expected early-reporter regression failures. `old-bootstrap-probe.json` detects the missing diagnostic record in the old block. `guard-replay.json` records the original adjacent two-line guard before instrumentation: captured/minimal-extra inputs reject and loopback passes. That historical recipe belongs to the base source; the current block is tested separately. `syntax-checks.json` is parser-only.

The strict guard still rejects the historical real listing. All new flags/state/type/address values used by these tests are synthetic and do not diagnose the actual container. Real metadata/delivery, later permission/HTTP checks, helper/scenario/receipts and full C3/M0 acceptance remain unproved. Any actual retry needs review of the concrete candidate first.
