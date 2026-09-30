---
status: Accepted
date: "2026-09-30"
decider: Engineer
---
# Pi Native MCP Discovery

## Decision

The Pi SDK host loads the pinned native tool-search extension and activates `tool_search` additively, so default-exposure local MCP tools (`codemode`, `codemode-deferred`, `deferred`; never `hidden`) are discoverable and callable directly. OpenKit-managed servers keep their exact `direct` projection with one connection owner per server. The host does not load the native codemode extension at the current workspace-patched 0.99.1 pin because open upstream issue [earendil-works/pi#10239](https://github.com/earendil-works/pi/issues/10239) can dispatch a call to the wrong tool or server after identifier normalization. The deployment image preserves the exact built SDK host's patched production dependency closure instead of installing pi-mcp-adapter; search-only operation requires no codemode worker execution, while transitive package assets remain part of the supported closure.

## Reason

The engineer selected 「加载原生发现机制」 (English translation: ‘Load the native discovery mechanism’). After the pinned research, the primary instructed the search-only, no-codemode implementation choice and the image-owner reconciliation under that direction; those details are not a separate engineer ruling. The research finding in temp/research/20260930-pi-codemode-mcp/report.md establishes that the 0.99.1 SDK exports both the codemode and tool-search factories and that tool search alone meets the discovery and direct-call need. Its pinned-source and local-probe evidence supports additive activation and reproduces a codemode identifier collision that can execute the wrong target. The accepted current route therefore loads search without codemode script composition or another configuration/client system. Source and construction probes establish the available mechanism; actual model-visible discovery, native calls, resume and deployed packaging still require their owning qualification.

At the Pi 0.99.1 pin, createAgentSession rebuilds the initial tool selection from current native settings on both new and resumed sessions, not from the transcript's prior declarations, so an exact successor adds tool_search again and the model rediscovers formerly searched tools. The primary settled this pin behavior within the existing decision after verifying the pinned source; it is not a separate engineer ruling. The Pi Worker Adapter owns the resulting criteria.

## Rejected Alternatives

- Direct-only support with a visible limit: it leaves default-exposure user servers unusable despite the pin's available native search mechanism.
- Returning to pi-mcp-adapter: it adds another configuration and connection owner without solving an absent SDK capability and does not replace the required native MCP owner.
- Loading codemode now: open issue #10239 can dispatch a call to the wrong tool or server after identifier normalization; tool search alone meets the current need.
- Waiting for upstream: the needed SDK factories already exist; codemode reliability can be revisited independently of current search-only discovery.

## Revisit When

A released upstream fix for [earendil-works/pi#10239](https://github.com/earendil-works/pi/issues/10239) is qualified against the pin, or the SDK factories are removed.

## Affected Owners

- [Pi Worker Adapter](../specs/20260716-pi_worker_adapter.md)
- [Worker Execution Environment Images](../specs/20260721-worker_execution_environment_images.md)
- [Container Image Packaging And Release Publishing](../specs/20260708-container_image_packaging.md)
- [Worker Runtime Communication Model](../specs/20260629-worker_runtime_communication_model.md)
