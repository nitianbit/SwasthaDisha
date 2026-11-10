# Static Mongoose compatibility investigation

This is the reviewed C2 investigation, not a root dependency upgrade or application test. It compares exact Mongoose 6.13.8 and 9.12.0 types with the same TypeScript 5.9.3, Node 20 declaration package 20.19.31 and TypeDI 0.10.0. It uses the verified local Node 22.23.4 executable.

The probe downloads public npm metadata/packages into a newly owned temporary workspace and cache. It supplies explicit blank user/global npm configuration, no inherited HOME/configuration/credentials, and disables lifecycle scripts. It resolves and validates registry-only lock entries before installing with `npm ci --ignore-scripts`. This is an intentional public-network install step; no root dependencies are installed or changed.

Only eight fixed application source files are staged as compiler input: the shared repository, blog model/repository/types, common regex helper and medicine model/types. The medicine normalizer's three-line function is extracted into a workspace-only module because its original containing module imports the model cyclically and constructs a logger. The report records the original source hash and extracted text. That substitution prevents any claim of full module/runtime compatibility.

The compiler runs directly under Node filesystem permissions with explicit source files and noEmit. It has no subprocess, addon or worker permissions. A source file that throws if evaluated is included; an independent invalid-type check must be rejected. Node 22 permissions do not deny networking; this boundary relies on the trusted compiler and never evaluates application modules, decorators, model validation, queries or generated JavaScript.

After reviewing the probe and verifying the two local tool paths:

```sh
python3 test/compatibility/static_mongoose.py /absolute/path/to/verified-node22 /absolute/path/to/trusted-npm/bin/npm-cli.js
```

Each run creates a new UUID evidence directory under `output/qa/m0-a/c2-static/`, preserving exact package locks, metadata, config, diagnostics and source/tool hashes. A successful probe may report type errors: baseline and candidate diagnostics are evidence, not a full build result. Infrastructure errors remain failures and cannot be counted as library incompatibility. Cleanup verifies ownership before removing only the temporary workspace; source/root hashes must remain unchanged.

Root adoption still requires the C2 target facts and reviewed migration diff. The owner chose to retain the existing server; DevOps will provide hosting, MongoDB version/topology and exact build/PM2 details. No MongoDB 8 production target is selected. Complete C3 admission still precedes application runtime and integration checks.

## Offline controller regressions

```sh
python3 -B -m unittest discover -s test/compatibility -p test_static_mongoose.py -v
```

These five cases simulate every npm/network/compiler call. They validate controller failure handling; the separate real comparison supplies actual compiler evidence. The saved historical-controller canary demonstrates that the regressions reject the initial defects. [Results and remaining gates](../../documentation/planning/implementation/C2_STATIC_RESULTS.md).
