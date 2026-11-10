# Ruflo local verification

PASS for Ruflo/CLI 3.75.0 using the registered absolute Node command and isolated state directory.

Two clean-environment stdio servers initialized successfully. All 13 Codex-enabled tool names exist in the server registry (393 advertised). Five bounded tool calls proved status, task creation, task persistence after process restart, completion, and readback at 100 percent. Both smoke-owned servers exited zero on stdin EOF; an independent process-table check found neither PID. Other host-managed MCP processes were observed and left untouched.

Protocol requests/responses are retained in protocol.jsonl, tool results and exact process exits in report.json, and full server stderr in the two session files. No provider/API/model credentials were passed. No memory/model/execution tools, project initialization or application code were invoked; the configured model-cache directory was not created. The clean environment and tool allowlist are not a network sandbox.

Team/mailbox calls and host allowlist enforcement were inspected statically; this check did not execute those tools or test Codex's host-side filtering. This result does not prove application correctness, M0 acceptance, deployment readiness or throughput.
