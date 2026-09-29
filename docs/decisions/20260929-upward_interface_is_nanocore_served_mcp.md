---
status: Accepted
date: "2026-09-29"
decider: Engineer
---
# The Upward Agent Interface Is NanoCore-Served MCP

## Decision

A worker reaches the Core capabilities it may use through MCP servers that NanoCore serves behind the existing Gateway, and the worker runtime loads them as ordinary MCP supply. A worker runtime must support MCP; a runtime without MCP support is not supported. Sandbox Integration keeps only two duties: establishing and maintaining the link with NanoHost and NanoCore, and doing the work that no standard protocol covers, such as work-data capture, extra Sandbox and worker configuration, and Turn management. Anything a standard interface can do uses the standard.

## Reason

The engineer stated this on 2026-09-29, translated from Chinese. In Round 6: runtime support for MCP is assumed by default, and a runtime without it will not be supported. If installing one MCP into a worker runtime delivers many functions, development and maintenance cost falls greatly, and supporting another runtime needs no extra work. In Round 8, correcting a direction the primary had reversed: the reasonable form is an MCP on the NanoCore side, exposed for example through the existing Gateway and loaded into the worker runtime. Through it a worker can ask to communicate with another worker or deliver information to NanoCore or one of its agents. MCP is a standard protocol and a widely supported way of loading tools, so it can be the exposure interface for such capabilities.

The agent-native premise supplies the design reason: every Core capability is one semantic operation that an agent invokes as naturally as a tool call ([decision](20260929-agent_native_capabilities.md)).

## Rejected Alternatives

- A per-runtime native tool projection for each capability, rejected because it multiplies adapter work for every runtime.
- A Sandbox CLI for Core operations, rejected because it is runtime-specific and sits beside MCP governance.
- Routing NanoCore-internal agents through OpenKit's own MCP endpoint, not adopted: internal agents call the same command implementations natively.
- A worker-hosted MCP server that NanoCore calls, rejected by the engineer in Round 8 as the reversed direction.

## Revisit When

- A supported runtime family cannot load MCP supply.
- A standard other than MCP becomes the widely supported way for agent runtimes to load tools.

## Affected Owners

- docs/core/communication.md
- docs/specs/20260629-worker_runtime_communication_model.md
- docs/specs/20260704-worker_mcp_tool_supply.md
- docs/specs/20260703-worker_agent_capability.md
