# Index failure diagnostic amendment

Baseline: `d91e1a3d37f2b229efc7fc2507d666ddc2576d99`.
Author: `/root`. Independent Standards: `/root/backend_boot_path`.
Independent Spec: `/root/local_claude_review_prep`.
Both directly approved this bounded source contract before implementation.

Actual API attempt 2 stopped with `DB_INDEX_CREATE_SERVER`. Connect and hello
completed. The numeric server error, affected index and available capacity were
not retained. All 36 HTTP and four sensitivity cases remain NOT_RUN. The failed
attempt and consumed approval are preserved; its exact resources were removed.

Add only three strictly numeric classifications to the existing bounded,
descriptor-only setup classifier, before its generic SERVER fallback:

| Exact numeric code | Category |
| --- | --- |
| 14031 | OUT_OF_DISK_SPACE |
| 67 | CANNOT_CREATE_INDEX |
| 72 | INVALID_OPTIONS |

Each of the existing four setup steps receives fixed literal codes for these
categories. Preserve known fixture-guard priority, existing classifications,
three-object cause bound, accessor exclusion, private original causes, once-only
actions, return values and seven-field output. Numeric strings do not match.
Add pure tests of direct and nested codes, generic-wrapper precedence, guard
priority and numeric-string fallback. No app/package import or connection occurs
in these tests.

Only bootstrap, its pure unit file, scenario README and owned QA may change.
No index/model/domain/dependency/parent/runtime profile, grant, argument, capacity
or server parameter change is authorized. New exact source/artifact reviews and
a fresh single-run decision are required before another actual API run.

MongoDB's default 500 MB index-build free-space threshold and the fixture's
512 MiB tmpfs ceiling support a capacity hypothesis, not a measured cause.
Do not repair capacity without measured evidence and a reviewed fixture change.

Primary references:
- https://raw.githubusercontent.com/mongodb/mongo/r8.0.34/src/mongo/base/error_codes.yml
- https://www.mongodb.com/docs/v8.0/reference/parameters/#mongodb-parameter-param.indexBuildMinAvailableDiskSpaceMB
