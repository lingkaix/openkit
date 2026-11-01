---
status: Accepted
date: "2026-11-01"
decider: Engineer
---
# OpenKit Adopts MCP Standards Ahead Of Protocol Releases

## Decision

OpenKit follows the Model Context Protocol ahead of its dated releases, under two rules.

The first rule is internal. The MCP Gateway serves a new standard, beside the older revision, as soon as the standard is released or a published release of the official SDK supports it, even when no dated protocol revision contains it yet. The reference clients are the harnesses of the current four Worker adapters: Pi, Codex, OpenCode, and DeepSeek. One harness is enough: each adapter turns a technique on for its harness as soon as the pinned harness release supports it through a documented option, without waiting for the other three. An under-development flag does not count. Removing an older form from the Worker face waits until all four harnesses support the new one. [Worker MCP Tool Supply](../specs/20260704-worker_mcp_tool_supply.md) owns this rule.

The second rule is external. The MCP that OpenKit exposes to user agents changes to a new form as soon as Claude Code, Codex, and Grok all support that technique. Grok here is the Grok assistant, which reaches MCP servers through custom connectors. It is a separate product from Grok Build, which this rule does not consider. A client supports a technique when its stable release has it on by default. A disabled or under-development flag does not count. The change replaces the old form. OpenKit does not keep two remote tool surfaces, as NONNEG-001 already requires. [Remote MCP Interface](../specs/20261002-remote_mcp_interface.md) owns this rule.

A released protocol revision that the official SDK negotiates beside the older one falls under the first rule on every face, including the remote endpoint, because no existing client loses anything. Retiring the older revision, or replacing the four meta-tools, falls under the second rule.

A draft that no official SDK release supports triggers neither rule. OpenKit may shape internal models after it, and retained contracts do not take its wire shape.

## Reason

The engineer stated this on 2026-11-01, translated from Chinese: "Once a new standard is released, or the standard is not released yet but the SDK supports it, we switch to the new standard as soon as possible. For the MCP OpenKit exposes, as soon as the mainstream Claude Code, Codex, and Grok bot support a technique in the new standard, we immediately switch our exposed MCP to the new form."

The engineer then clarified, also translated: "Grok bot is a separate, independent product; we do not consider Grok Build. Internally, we look at the worker harnesses the current four adapters support."

The engineer confirmed the internal reading, also translated: "As soon as one harness supports it, we enable support quickly, which also tests the new standard, the new technique, and our new interface."

Earlier the same day, also translated: "Our support for the new MCP standards should be ahead, because they contain valuable parts we need."

The dated release is a poor signal. SEP-3398 moved the next revision to March 2027, while capabilities such as Skills (SEP-2640) and Tasks (SEP-2663) are already Final and new capabilities now ship as extensions with their own lifecycle. The SDK and the clients show what is usable today.

The record reads "Claude Code & Codex & Grok bot" as all three clients. Internally the adapters can switch one at a time because OpenKit owns their configuration and the Gateway negotiates both revisions.

## Rejected Alternatives

- Waiting for the next dated protocol revision, rejected because it delays capabilities that are already final and shipped by the SDK.
- Keeping an old and a new remote tool surface side by side, rejected under NONNEG-001.

## Revisit When

One of the three external clients stops being a mainstream client of the exposed MCP, the set of Worker adapters changes, or an SDK-supported technique is withdrawn from the standard after OpenKit adopts it.

## Affected Owners

- docs/specs/20260704-worker_mcp_tool_supply.md
- docs/specs/20261002-remote_mcp_interface.md
- docs/specs/20261002-operation_definition.md
