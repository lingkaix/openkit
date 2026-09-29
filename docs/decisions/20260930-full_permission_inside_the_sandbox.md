---
status: Accepted
date: "2026-09-30"
decider: Engineer
---
# Full Permission Inside The Sandbox, Restrictions At Its Boundary

## Decision

Inside its Sandbox a worker agent has full permission. Restrictions sit only at the Sandbox boundary: storage and network policy, and external systems or tools reached only through the MCP Gateway, where approval and audit apply. Worker adapters disable native runtime permission prompts. A native permission request that arrives anyway is rejected, or its prompt is cancelled, and it is never allowed. Turning native prompts off grants nothing beyond what the Sandbox enforces. In-Sandbox configuration, tools, and MCP servers, such as CodeGraph configured in a software-development Sandbox, are Sandbox execution and are not restricted by OpenKit; approval and audit apply only to the worker's interaction with external systems.

## Reason

In Round 10 on 2026-09-29 the engineer stated, translated from Chinese: the purpose of putting agents in a Sandbox is to give them maximum permission within it, that is, full permission inside the Sandbox. Restrictions are mainly at the Sandbox boundary, such as storage and network policy, and third-party systems or tools exposed through the MCP Gateway, where audit and approval come naturally without configuring or operating the worker inside the Sandbox. In Round 13 on 2026-09-30 the engineer added: the parts that need approval or authentication are the worker's interactions with external systems; any configuration or function inside the Sandbox, for example CodeGraph in a software-development Sandbox, is there for the worker to use, and we should not restrict it.

## Rejected Alternatives

- Mapping native runtime permission requests onto OpenKit approvals, rejected because an approval cannot be bound to an exact native effect, and because the Sandbox is the containment boundary.
- Prohibiting direct connections from workers to every MCP server, including in-Sandbox ones, rejected for in-Sandbox servers by the Round 13 ruling. External systems remain Gateway-only.

## Revisit When

A native effect needs approval but has no Gateway operation, or a Sandbox profile must contain untrusted in-Sandbox tools more tightly than its boundary allows.

## Affected Owners

- docs/core/sandbox.md
- docs/specs/20260704-worker_mcp_tool_supply.md
- docs/specs/20260629-worker_runtime_communication_model.md
- docs/specs/20260716-codex_worker_adapter.md
- docs/specs/20260716-pi_worker_adapter.md
- docs/specs/20260716-opencode_worker_adapter.md
- docs/specs/20260930-deepseek_worker_adapter.md
