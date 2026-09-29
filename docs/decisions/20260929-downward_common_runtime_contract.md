---
status: Accepted
date: "2026-09-29"
decider: Engineer
---
# The Downward Standard Is The Common Runtime Contract, With ACP Only Where It Is First-Party

## Decision

Core controls worker runtimes through one downward standard: OpenKit's common runtime contract between the in-Sandbox Harness and each runtime adapter. The contract covers starting a new conversation, starting by resuming, submitting a Turn, cancelling, inspecting or reconnecting, closing, and observing.
- Each adapter uses the runtime's most capable, maintained, first-party interface that can satisfy the contract.
- ACP is used only where that first-party interface is ACP. No third-party translation bridge sits beside a first-party native interface.
- A non-ACP adapter uses no partial ACP, not even as an internal event model.
- ACP is the default path for long-tail runtimes that speak it natively and have no richer first-party interface.

Inside an ACP adapter, native permission requests, client filesystem and terminal callbacks, and every network transport stay outside the supported profile. NanoCore controls agents and is not an agent harness; "Harness" names only the in-Sandbox worker-shim component.

## Reason

In Round 11 on 2026-09-29, the engineer asked whether ACP should be the only downward path to worker runtimes, or an option used partly inside some adapters, as the four-runtime proposal had it. In Round 12 the engineer approved the primary's answer, translated from Chinese: "I agree with the principle you set, what to use and what not to use, not using ACP only partially inside an adapter, and ACP as the possible future support path for long-tail runtimes." In the same round the engineer corrected the positioning: "our system is not an agent harness but the agent control plane." In OpenKit documents the word plane names only logical communication concerns, so the owners state this as NanoCore controlling agents, not as a product named plane.

Agent analysis, approved with the principle: upward, OpenKit is the MCP server and defines the tools, which every supported runtime must support through its admitted integration. Downward, OpenKit is the client of each runtime's own lifecycle, and ACP v1 leaves out or makes optional the obligations that direction needs: exact identity, compaction evidence, per-Turn route rotation and draining, binding release, and recovery admission. The earlier analysis also counted native-generation isolation among them; the engineer later relaxed that to request-arrival attribution (see the resident request attribution decision of 2026-09-30). Forcing ACP everywhere would keep all that adapter work and add lossy bridges.

## Rejected Alternatives

- ACP as the only downward interface for every runtime, rejected because it adds bridges without removing adapter obligations.
- Third-party ACP bridges (`codex-acp`, `pi-acp`, OpenCode's ACP mode) beside first-party native interfaces, rejected because they add a process and a translation policy.
- Partial ACP inside native adapters, for example as the internal event model, rejected because native events map directly onto the common contract.
- ACP over the network between NanoCore and the worker, rejected because ACP's stable transport is stdio and NanoHost already owns carriage.

## Revisit When

A later ACP version standardizes identity, compaction, credentials, quiescence, and recovery admission, and vendors ship and maintain first-party ACP interfaces at parity with their native ones. The adapter-selection rule then selects ACP for every runtime without a policy change.

## Affected Owners

- docs/core/communication.md
- docs/specs/20260629-worker_runtime_communication_model.md
- docs/specs/20260703-worker_control_protocol.md
- docs/specs/20260716-codex_worker_adapter.md
- docs/specs/20260716-pi_worker_adapter.md
- docs/specs/20260716-opencode_worker_adapter.md
- docs/specs/20260930-deepseek_worker_adapter.md
