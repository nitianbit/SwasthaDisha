# Test-only index-space profile amendment

Baseline `160e9f7` includes the reviewed numeric diagnostic source. API attempt 3
at `ca404f6` returned DB_INDEX_CREATE_OUT_OF_DISK_SPACE, which maps only strict
numeric MongoDB code 14031. It completed no HTTP case. Its exact two containers
and workspace were removed; the consumed approval and independent readback are
preserved separately.

Both independent internal Codex reviewers, `/root/backend_boot_path` (Standards)
and `/root/local_claude_review_prep` (Spec), approved this concrete source contract
before implementation. Author: `/root`. This is a test fixture profile amendment,
not production or root dependency/build/start adoption.

Set the owned mongod's startup parameter indexBuildMinAvailableDiskSpaceMB to the
fixed nonzero value 64, with no caller option or runtime/admin setParameter call.
Add an explicit profile revision and require that profile before allocation.
Whole executable argv must still match the captured fixed command at every
resource readback. Reject omitted, changed, zero, malformed, extra and duplicate
parameters before start and before any cleanup of a changed resource.

Retain the 512 MiB data tmpfs, 1 GiB Mongo RAM limit, CPU/PID/storage/network/user/
permission controls and exact 12-model/index/domain/provider inputs. Change only
platform.mjs, platform.test.mjs, unit.mjs, profile.json and owned QA. No bootstrap,
launch, scenario, compiler, package, production or original handover bytes change.
Run only the inspected fake transport gate and syntax/whitespace/data checks.
A fresh prepared artifact and two exact single-run decisions remain separate.

MongoDB 8 documents default 500 MB and a nonzero minimum-free-space check. The
actual error measures a capacity rejection, not available bytes or a readback of
the previous effective parameter. Value 64 is a deliberate small-fixture setting;
it is not a capacity guarantee. Preserve every earlier failure and stop/review any
new failed invocation. No automatic retry or production setting change follows.

Primary: https://www.mongodb.com/docs/v8.0/reference/parameters/#mongodb-parameter-param.indexBuildMinAvailableDiskSpaceMB
