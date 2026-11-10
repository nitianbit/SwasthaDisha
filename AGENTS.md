# SwasthaDisha development

Work in this repository (`nitianbit/SwasthaDisha`). The sibling `ewa_backend` checkout is a legacy reference. Read [the transition record](documentation/planning/implementation/REPOSITORY_TRANSITION.md) when interpreting old branch names, commits, reviews or test evidence.

Before implementation, read [current M0-A progress](documentation/planning/implementation/M0_A_PROGRESS.md). Before dependency/runtime/build/start changes, read [C2 conditions](documentation/planning/M0_START_APPROVAL_STATUS.md) and [the compatibility decision packet](documentation/planning/implementation/C2_COMPATIBILITY_REVIEW.md). The new repository does not reset those gates.

For executable checks, read [foundation unit usage](test/foundation/README.md) and the [fixture contract](documentation/planning/implementation/C3_MONGO_FIXTURE_CONTRACT.md). App imports, legacy integration suites and provider effects require complete pre-import admission; the fixed MongoDB smoke check does not supply that admission. Keep local secrets, service-account files, patient records and uploaded documents outside Git.

For parallel implementation or technical-review handoff, follow [the development workflow](documentation/planning/implementation/PARALLEL_DEVELOPMENT_WORKFLOW.md).

## Codebase knowledge graph

Prefer MCP graph tools for code discovery in project `swasthadisha`:

1. `search_graph` for symbols and implementations.
2. `trace_path` for callers/callees.
3. `get_code_snippet` for an exact discovered symbol.
4. `query_graph` for complex relationships.
5. `get_architecture` for an overview.

Use `rg` for literals, config and non-code files, or when graph results are insufficient. Check index freshness and the repository path before relying on a result; the legacy graph project belongs to `ewa_backend`.
