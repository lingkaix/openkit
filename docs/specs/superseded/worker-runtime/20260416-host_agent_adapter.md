# Host Agent Adapter For NanoCore

Status: Superseded

Superseded by `docs/specs/20260629-worker_runtime_communication_model.md`, `docs/specs/20260703-runtime_scheduling_scale.md`, and `docs/specs/20260703-agent_manifest_aep_resolution.md`.

This document is retained only as historical context for the early host-adapter design. Host execution is no longer a current Worker Agent runtime target.

This document is an implementation-layer spec for the first host agent adapter in `apps/nanocore`.

The stable core model lives in `docs/core/runtime-model.md`, `docs/core/agent-session.md`, `docs/core/protocol.md`, and `docs/core/communication.md`. This spec must follow those documents and must not redefine core concepts.

## Summary

This document defines the first real `Core <-> Agent` adapter design for `apps/nanocore`.

`packages/protocol` remains the `UI <-> Core` contract only. The agent adapter layer is a separate internal runtime contract owned by the Core server.

The first implementation target is a `host` adapter where Core starts and supervises a local child process for each agent session. The design must support future `local` and `remote` adapters without making them part of the first implementation scope.

## Goals

- Turn `apps/nanocore` from a deterministic demo into a real agent-backed server architecture.
- Keep `UI <-> Core` and `Core <-> Agent` as separate protocol layers.
- Support long-lived agent sessions to avoid repeated startup and setup cost.
- Keep thread-to-agent affinity so one thread stays on one agent session until released or lost.
- Model agent session lifecycle explicitly with a state machine.
- Make the first adapter simple to implement by using Core-managed local child processes.

## Non-goals

- Defining `Core <-> Agent` schemas inside `packages/protocol`.
- Implementing `local` container or `remote` server adapters in the first iteration.
- Standardizing immediately on ACP or A2A for the first adapter.
- Solving multi-tenant scheduling, authentication, or persistence in this phase.
- Supporting one agent session serving multiple threads concurrently.

## Background

The current repository defines stable `UI <-> Core` semantics in `docs/core/protocol.md` and `docs/core/communication.md`, with the current HTTP/SSE projection summarized in `docs/app-api.md`. That protocol models workspaces, threads, turns, approvals, artifacts, agent sessions, and SSE updates for UI clients.

The missing layer is how Core executes a turn using a real agent runtime. Existing agent products such as Codex, Gemini CLI, Kimi CLI, and others expose different server surfaces and lifecycle models. Those server implementations are useful integration targets, but they should not define the internal truth of this repository.

For this repository, the stable internal model should center on Core-owned lifecycle concepts such as agent definitions, agent sessions, thread bindings, turn execution, interruption, and recovery.

## Proposed Design

### Layering

The runtime is split into three layers:

1. `UI <-> Core` protocol.
2. Core runtime domain.
3. `Core <-> Agent` transport adapters.

Layer 1 remains in `packages/protocol`.

Layer 2 becomes the Core-owned execution model inside `apps/nanocore`.

Layer 3 translates Core runtime operations to a specific agent transport or product integration.

This keeps the UI contract stable even if agent implementations differ heavily.

### Internal Runtime Objects

The nanocore host adapter introduces four internal implementation objects:

- `AgentConfig`: static configuration for an agent, including startup command, environment, supported capabilities, and adapter type.
- `AgentSession`: one live runtime instance created and supervised by Core.
- `ThreadBinding`: an exclusive lease from one thread to one agent session.
- `TurnExecution`: one turn running on one bound agent session.

These names are implementation-layer records, not top-level core concepts.

`AgentConfig` is durable configuration.

`AgentSession` is operational state.

`ThreadBinding` expresses affinity and exclusivity.

`TurnExecution` expresses active work.

### Adapter Model

Core exposes one internal adapter contract and allows multiple transport implementations below it.

The first implementation is `native-host`.

Future implementations may include:

- `acp`
- `a2a`
- `native-local`
- `native-remote`

The recommendation is to keep ACP and A2A as transport adapters, not as the Core runtime domain model.

This avoids forcing Core scheduling, binding, and lifecycle semantics to mirror any single external protocol.

### First Adapter Scope

The first adapter is `native-host`.

Core starts the agent as a local child process from repository or workspace configuration.

The agent session should stay alive after setup whenever possible.

Each agent session can bind to at most one thread at a time.

After a thread is bound, all later turns for that thread should prefer the same agent session until one of these conditions occurs:

- Core explicitly releases the binding.
- The session exits normally.
- The session fails.
- The session becomes unhealthy according to supervisor policy.

### Scheduling And Binding Rules

Agent assignment follows this precedence:

1. Explicit thread or request configuration.
2. Workspace default agent.
3. Scheduler fallback among compatible idle agents.

Once assigned, the thread becomes sticky to that agent session.

A session that is bound to one thread must not accept work for any other thread until the binding is released.

This design prefers reuse and warm state over maximal agent utilization.

### Agent Session State Machine

`AgentSession` should be represented as an explicit state machine.

The initial state set is:

- `starting`
- `idle`
- `bound`
- `running`
- `awaiting_input`
- `stopping`
- `exited`
- `failed`

Meaning of each state:

- `starting`: Core has launched the agent process and is waiting for successful readiness or handshake.
- `idle`: The agent session is healthy and unbound.
- `bound`: The agent session is healthy, bound to one thread, and currently not executing a turn.
- `running`: The agent session is actively executing a turn.
- `awaiting_input`: The agent session is paused on approval, human input, or another resumable external dependency.
- `stopping`: Core is draining or shutting down the session.
- `exited`: The process ended cleanly and the session is no longer live.
- `failed`: The process crashed, became unreachable, or violated protocol expectations.

Expected transitions:

- `starting -> idle`
- `idle -> bound`
- `bound -> running`
- `running -> bound`
- `running -> awaiting_input`
- `awaiting_input -> running`
- `bound -> idle`
- `any live state -> stopping -> exited`
- `any live state -> failed`

The distinction between `idle` and `bound` is important. A session in `bound` is not globally available, even though it is not currently running a turn.

### Internal Adapter Contract

The Core runtime should program against an internal interface rather than against any external protocol directly.

The first contract should cover these operations:

- `startSession(definition)`
- `stopSession(sessionId, reason)`
- `getSessionHealth(sessionId)`
- `bindThread(sessionId, threadId)`
- `releaseThread(sessionId, threadId)`
- `startTurn(sessionId, turnContext)`
- `sendFollowUp(sessionId, turnId, input)`
- `interruptTurn(sessionId, turnId)`
- `resumeTurn(sessionId, turnId, input)`
- `subscribeEvents(sessionId, listener)`

The exact method names may change during implementation, but the semantic surface should stay close to this list.

Core owns scheduling, session supervision, and thread binding policy.

The adapter owns process control, agent communication, event translation, and low-level transport recovery.

### Event Translation

The agent adapter may receive product-specific events from Codex, Gemini CLI, Kimi CLI, or future runtimes.

Core should translate those events into the repository's internal execution events first, then into `UI <-> Core` protocol events only where needed.

This prevents external event names and lifecycle quirks from leaking directly into the UI contract.

### Why Not Standardize Immediately On ACP Or A2A

ACP and A2A are useful, but they solve different boundaries.

ACP is closer to `client <-> coding agent` integration and is a strong future candidate for `host` or `local` agent adapters.

A2A is closer to `agent <-> agent` or `server <-> remote agent` integration and is a stronger candidate for future `remote` adapters.

Neither should become the internal truth for Core scheduling and agent session lifecycle in the first iteration.

The first iteration needs a simple Core-managed local child process path more than it needs standards compliance.

## Alternatives Considered

### Alternative A: Use Native Product Servers Directly Without A Shared Runtime Contract

This is the fastest short-term route.

It was rejected because each product surface has different lifecycle semantics, which would leak vendor-specific behavior into Core and make later `local` or `remote` support harder.

### Alternative B: Make ACP The Core Runtime Contract

This would align with a growing coding-agent standard.

It was rejected for the first iteration because the current need is Core-managed local child processes with explicit sticky bindings and supervisor-owned lifecycle semantics. Those concerns are broader than ACP method shapes.

### Alternative C: Make A2A The Core Runtime Contract

This would provide a standard path for future remote agents.

It was rejected for the first iteration because A2A is a worse fit for the first `host` adapter than a simple local child-process runtime.

## Rollout Plan

1. Write the runtime spec and validate the state machine and binding model.
2. Add internal runtime types for agent definitions, sessions, bindings, and execution state.
3. Implement the `native-host` adapter behind the internal contract.
4. Replace the deterministic simulator path in `apps/nanocore` with the adapter-driven execution path.
5. Preserve the existing `UI <-> Core` protocol surface unless implementation reveals a real protocol gap.
6. Revisit ACP and A2A adapters after the host adapter proves the runtime boundaries.

## Testing Strategy

- Unit tests for agent session state transitions.
- Unit tests for scheduler precedence and sticky thread binding.
- Unit tests for supervisor behavior on clean exit, failed exit, and interrupted turns.
- Integration tests for Core launching a host agent child process and driving one thread across multiple turns.
- Regression tests to confirm UI-facing turn and SSE behavior still matches the documented communication flow.

## Risks And Mitigations

### Risk: Session Warmth Creates Hidden State Coupling

Mitigation: make thread binding explicit and observable, and define clear release rules.

### Risk: Different Agent Products Expose Incompatible Lifecycle Semantics

Mitigation: keep the internal runtime contract smaller and more stable than any single external protocol.

### Risk: Host Child Process Management Becomes Platform-Specific

Mitigation: isolate process supervision inside the adapter and keep Core policy independent from OS details.

### Risk: Future `local` And `remote` Adapters Need Different Scheduling Rules

Mitigation: keep scheduling policy in Core, but keep transport-specific health and capability checks in adapters.

## Open Questions

- How should agent readiness handshake be defined for the first `native-host` adapter.
- Whether follow-up input should always map to `sendFollowUp`, or sometimes create a new turn at the agent layer.
- How much agent capability metadata should be surfaced to the UI versus kept internal to Core.
- Whether thread bindings should survive Core restart in a later persistent architecture.

## Decisions Locked In (2026-05-13)

These are constraints fixed in design discussion and supported by external source review of multi-agent CLI harnesses such as emdash, t3code, multica, cc-connect, and tday. Update this section, not the prose above, when revising; keep it short and decisive.

### D1. Adapter shape: structured only, no PTY+classifier

The first-class adapter shape is **structured**: the adapter speaks the agent's native typed protocol (JSON-RPC over stdio for Codex, ACP JSON-RPC for ACP-native runtimes such as Hermes/Kimi/Kiro, vendor SDK or `--output-format stream-json` for runtimes that ship one). PTY screen-scraping and output-classifier adapters (the emdash/tday shape) are explicitly rejected as the default because approval/interrupt/handoff control events recovered from screen text are too lossy to satisfy the four-plane separation in [20260507-codex_agent_communication_modes.md](../../retired/worker-runtime/20260507-codex_agent_communication_modes.md). Manifest validation rejects any agent runtime that does not declare a structured control surface; we do not fall back to keystroke injection.

### D2. Internal adapter event contract

`subscribeEvents(sessionId, listener)` returns a typed event union plus a single terminal `Result`. This shape is borrowed from multica's `Backend` interface (see the related research) and is the same across every adapter implementation:

```ts
type AgentEvent =
  | { type: "text"; content: string }
  | { type: "thinking"; content: string }
  | { type: "tool-use"; tool: string; callId: string; input: Record<string, unknown> }
  | { type: "tool-result"; tool: string; callId: string; output: string }
  | { type: "status"; status: string; sessionId?: string }
  | { type: "error"; content: string }
  | { type: "log"; level: string; content: string };

type AgentResult = {
  status: "completed" | "failed" | "aborted" | "timeout" | "cancelled";
  output: string;
  durationMs: number;
  sessionId: string;
  usage: Record<string, TokenUsage>;       // keyed by model name
  usageSource: "bridge_proxy" | "agent_otel" | "pty_scrape" | "none";
};
```

`usageSource` records the fidelity of the `usage` numbers so audit consumers do not assume precise token counts when the adapter could only estimate (deferred until non-Codex agents ship; Codex uses `bridge_proxy`).

### D3. Adapter-owned `FrozenArg` contract

Each runtime adapter declares a static array of arguments it owns: subcommands that must appear, flags that must appear with a required value, and flags users must not set. The current [Agent Setup And Runtime Supply Contract](./20260628-agent_setup_runtime_supply_contract.md) keeps the same resolver rule: config resolution errors when user `custom_args` conflicts with the frozen set; never silently merges. Frozen list lives in adapter code; the resolved package may mirror it for diagnostics only.

```ts
type FrozenArg =
  | { kind: "subcommand"; value: string }
  | { kind: "flag_required"; name: string; value?: string }
  | { kind: "flag_forbidden"; name: string };
```

For Codex: `[{ kind: "subcommand", value: "app-server" }, { kind: "flag_required", name: "--listen", value: "stdio://" }]`. For Hermes (future): `[{ kind: "subcommand", value: "acp" }]`.

### D4. Sub-agent vs cross-agent handoff semantics

Sub-agent handoffs **inside** one agent session collapse to assistant-message + tool-call items in the thread; only **cross-agent** handoffs become first-class `agent-handoff` items. Mirroring the OpenAI Agents SDK distinction, an agent manifest declares both `composition.can_be_handed_off_to` (control transfer for the next turn) and `composition.can_be_invoked_as_tool` (nested call returning a result, parent stays active). Cross-profile-as-tool spawns a child agent session whose lineage, vault scope, and timeout accounting is owned by Core.
