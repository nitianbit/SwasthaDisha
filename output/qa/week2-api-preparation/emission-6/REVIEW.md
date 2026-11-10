# Sixth prepared artifact and accepted execution

Two nonauthor internal Codex reviewers approved one locked install/emission at
clean `1543658`, with fresh receipt `4a5801be…` after preserving consumed prep 5.
Preparation succeeded with descriptor `067c3c39…`, 2,829 regular files,
44,630,815 bytes and 72 source inputs. All domain/dependency/bootstrap/mutant
bytes match the preceding accepted artifact; only runtime-plan source commit
changed. The separately reviewed parent uses test-only profile 2.

Both reviewers independently verified every runtime file/source pin, 12-model/
51-module AST audit and four rejected metadata controls, retaining zero transpile
and 703 semantic diagnostics. The result is not a clean root typecheck/build.
They separately approved one exact API invocation, which subsequently passed all
36 required cases and detected all four real-source variants. Actual execution,
consumed approval and independent postreviews are preserved in
`../../week2-api-runtime/execution-4/`. The original preparation NOT_EXECUTED
record describes its stage before that invocation; no reuse or retry follows.
