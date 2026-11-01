---
status: Accepted
date: "2026-11-01"
decider: Engineer
---
# OpenKit Adopts MCP Standards Ahead Of Protocol Releases

## Decision

OpenKit follows the Model Context Protocol ahead of its dated releases, under two rules.

The first rule covers the MCP Gateway, the Worker face, and internal Operation and Tool exposure. They move to a new standard as soon as it is released, or as soon as a published release of the official SDK supports it, even when no dated protocol revision contains it yet. [Worker MCP Tool Supply](../specs/20260704-worker_mcp_tool_supply.md) owns this rule.

The second rule covers the MCP that OpenKit exposes to user agents. It changes to a new form as soon as the Claude Code, Codex, and Grok MCP clients all support that technique. [Remote MCP Interface](../specs/20261002-remote_mcp_interface.md) owns this rule.

A client supports a technique when a stable client release has it on by default. A disabled or under-development flag does not count. The change replaces the old form. OpenKit does not keep two remote tool surfaces, as NONNEG-001 already requires.

A released protocol revision that the official SDK negotiates beside the older one falls under the first rule on every face, including the remote endpoint, because no existing client loses anything. Retiring the older revision, or replacing the four meta-tools, falls under the second rule.

A draft that no official SDK release supports triggers neither rule. OpenKit may shape internal models after it, and retained contracts do not take its wire shape.

## Reason

The engineer stated this on 2026-11-01, translated from Chinese: "Once a new standard is released, or the standard is not released yet but the SDK supports it, we switch to the new standard as soon as possible. For the MCP OpenKit exposes, as soon as the mainstream Claude Code, Codex, and Grok clients support a technique in the new standard, we immediately switch our exposed MCP to the new form."

Earlier the same day, also translated: "Our support for the new MCP standards should be ahead, because they contain valuable parts we need."

The dated release is a poor signal. SEP-3398 moved the next revision to March 2027, while capabilities such as Skills (SEP-2640) and Tasks (SEP-2663) are already Final and new capabilities now ship as extensions with their own lifecycle. The SDK and the three clients show what is usable today.

The record reads the engineer's "Claude Code & Codex & Grok" as all three clients, and "Grok bot" as the MCP client in Grok Build.

## Rejected Alternatives

- Waiting for the next dated protocol revision, rejected because it delays capabilities that are already final and shipped by the SDK.
- Keeping an old and a new remote tool surface side by side, rejected under NONNEG-001.

## Revisit When

One of the three clients stops being a mainstream client of the exposed MCP, or an SDK-supported technique is withdrawn from the standard after OpenKit adopts it.

## Affected Owners

- docs/specs/20260704-worker_mcp_tool_supply.md
- docs/specs/20261002-remote_mcp_interface.md
- docs/specs/20261002-operation_definition.md
