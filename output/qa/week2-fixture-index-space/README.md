# Fixture index-space verification

The measured attempt-3 error is numeric 14031. Source profile 2 sets only the
new owned mongod startup minimum-free-space threshold to fixed nonzero 64 MB.
Whole argv inspection rejects drift. The database tmpfs remains 512 MiB and Mongo
RAM remains 1 GiB; no new network/file/process grants or model/index changes.
No production parameter or retained-server adoption is included.

Offline command:

```sh
env -i PATH=/usr/bin:/bin TMPDIR=/private/tmp /private/tmp/m0-node22/node test/api-runtime/unit.mjs
```

The inspected runner copies only its six declared sources to a fresh marked
private workspace and launches a Node permissioned fake-only process. It has no
Docker/socket/app/driver access. The gate requires exactly 96 passes, zero failed,
skipped, cancelled or TODO cases. The original platform/profile plus amended
checks actually failed five cases before implementation; that summary is retained.
After amendment all 96 pass. Six dedicated argv mutations cover absent, zero,
changed, malformed, extra and duplicate parameter forms, with cleanup withheld
for changed resource identity/configuration. The positive lifecycle checks exact
full argv and keeps all previous isolation/cleanup checks.

This is source/fake-boundary evidence only. A new frozen source commit, fresh
prepared descriptor and two exact single-run decisions precede actual execution.
No free-byte measurement or guaranteed capacity is claimed.
