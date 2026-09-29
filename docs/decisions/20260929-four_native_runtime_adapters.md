---
status: Accepted
date: "2026-09-29"
decider: Engineer
supersedes: docs/decisions/20260929-pi_controlled_model_configuration.md
---
# Four Worker Runtimes On Their Native Interfaces

## Decision

OpenKit supports four worker runtimes, each through its own first-party interface:
- **Codex:** App Server v2 over local stdio, with version-matched protocol types.
- **Pi:** the official SDK in a dedicated host process per AgentSession.
- **OpenCode V2:** its native server, driven through the official `@opencode/client`.
- **DeepSeek Harness:** native ACP over local stdio, through the official `@agentclientprotocol/sdk` client.

Native engines, plugins, Extensions, and tool execution run in separately supervised runtime processes, never inside the long-lived Integration and Harness process. One runtime does not keep several permanent production paths as compatibility fallbacks. Until Pi ships official MCP support, Pi reaches MCP through the `nicobailon/pi-mcp-adapter` Extension. Users keep the ability to configure Pi through images, files, and third-party Extensions, such as those of `lingkaix/pi-optimized-agent`.

## Reason

The engineer approved these four choices on 2026-09-29 after official-source research and independent Consultant scrutiny, recorded in the four-runtime proposal. In Round 10 the engineer added, translated from Chinese: "until the official support exists, we will first use https://github.com/nicobailon/pi-mcp-adapter". Agent analysis from the research:
- The inspected Codex TypeScript SDK launches `codex exec` per run, and the ACP bridge adds a process.
- The Pi SDK gives full host control of model, credentials, tools, and resources.
- OpenCode's embedded SDK would need an OpenKit IPC wrapper, which the native server avoids.
- DeepSeek Harness's first-party control interface is ACP, whose session cancel, close, and resume are missing from its SDK wire.

This supersedes the controlled Pi `models.json` decision, whose revisit trigger (a requirement for native-session continuity) has occurred. The SDK host configures the model directly. What ended is that decision's mechanism: the bounded `models.json`, the absence of MCP, and the absence of native session reuse. Its authority constraints survive:
- platform-managed inference stays on the governed Gateway route;
- upstream subscription credentials stay server-side;
- user configuration, packages, and Extensions supply no fallback platform authority and never receive Integration control credentials, and refresh or removal never falls back to stored Provider credentials or another binding's configuration;
- retained workspace and native data are preserved.
Separately authorized runtime-env credentials remain allowed.

## Rejected Alternatives

- The Codex TypeScript or Python SDK, or `codex-acp`, rejected for the reasons above.
- Raw Pi RPC or the unchanged official `RpcClient`, rejected because the client inherits the parent environment and does not establish descendant cleanup.
- The embedded OpenCode SDK hosted behind OpenKit IPC, rejected for the wrapper it needs.
- A mandatory ACP wrapper for every runtime, rejected by the downward-contract decision.

## Revisit When

A deciding qualification probe defeats a selected interface, or Pi ships official MCP support.

## Affected Owners

- docs/specs/20260716-codex_worker_adapter.md
- docs/specs/20260716-pi_worker_adapter.md
- docs/specs/20260716-opencode_worker_adapter.md
- docs/specs/20260930-deepseek_worker_adapter.md
- docs/specs/20260629-worker_runtime_communication_model.md
