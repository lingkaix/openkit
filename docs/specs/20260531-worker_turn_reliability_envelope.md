# Worker Turn Reliability Envelope

Status: Accepted
Implementation: Implemented

## Owns

This spec owns the implementation-facing reliability envelope for internal-agent and worker-turn execution, including stop reasons, terminal stream behavior, item-to-LLM projection, internal-agent event loops, hook isolation, runtime checkpoints, pending-user-turn handling, continuation policy, and deferred context-compaction boundaries.

## Does Not Own

This spec does not own stable core workflow vocabulary, user-facing work labels, worker-control wire commands, workspace synchronization, runtime scheduling, agent manifest resolution, Agent Environment Package schemas, or UI recovery layouts.

## Core References

- `docs/core/agent-workflow.md`
- `docs/core/protocol.md`
- `docs/core/communication.md`
- `docs/core/runtime-model.md`
- `docs/core/agent-session.md`
- `docs/core/knowledge.md`

## Summary

OpenKit should harden worker and internal-agent execution through one small reliability envelope instead of growing a heavy multi-agent framework.

The envelope has eight pieces: an evented internal-agent loop, typed internal-agent events, stable stop reasons, an explicit item-to-LLM projection boundary, worker-turn continuation primitives, isolated hooks, runtime checkpoints, and deferred context compaction.

The first implementation should stay app-local in `apps/nanocore`, except for the stable stop-reason enum and terminal stream contract, which should be promoted into `packages/protocol` and `docs/core/protocol.md`.

This spec refines the earlier lightweight-agent and Sustained Mode specs by defining the minimum runtime primitives needed before long-running delegation can be reliable.

## Goals / Non-goals

Goals:

- Preserve the stable `Workspace -> Thread -> Turn -> Item[]` Core model.
- Split `InternalAgentRunner` into an evented loop plus a thin stateful runner shell.
- Make internal-agent calls streamable without changing the existing `run()` API.
- Define a typed internal-agent event vocabulary that maps cleanly to NanoCore SSE events.
- Define stable stop reasons for provider, internal-agent, worker, and gateway streams.
- Introduce a `convertToLlm` boundary so durable item history and provider-visible context are separate.
- Add worker-turn primitives for stop checks, next-turn preparation, steering, follow-up queues, and checkpoint recovery.
- Isolate non-critical hooks so observability or extension failures do not kill the execution loop.
- Defer autonomous context compaction until OpenKit has real long-running sessions and enough history to compact.

Non-goals:

- Do not introduce `AgentRun`, `TaskRun`, or a task graph as stable Core concepts.
- Do not expose NanoCore internal-agent implementation details as protocol records.
- Do not make every internal-agent event a public protocol event.
- Do not require low-level provider clients to never throw.
- Do not force every stream failure to appear as assistant prose.
- Do not implement background context compaction or autonomous Knowledge Store editing in this design slice.
- Do not add new internal-agent personas as part of the envelope.

## Background

OpenKit's Pi and Nanobot review concluded that small agent systems get reliability from explicit loops, context boundaries, save points, event streams, and recovery policy rather than from large agent taxonomies.

Pi's useful contribution is the split between a small loop and a harness shell, plus an event vocabulary that can support streaming, hooks, diagnostics, and future multi-turn behavior.

Nanobot's useful contribution is the product-local state machine, hook isolation, runtime checkpoint, pending-turn recovery, and deferred context compaction.

OpenKit already has the right foundation: the protocol remains a work log of workspaces, threads, turns, and items, while NanoCore can own app-local runtime state.

The current `InternalAgentRunner` is a good first slice, but it mixes provider dispatch, timeout, output parsing, diagnostics, and result aggregation in one method.

That shape is fine for a one-shot QuickChat call, but it becomes awkward when QuickChat streams tokens, WorkerCoordinator evolves beyond deterministic routing, or a worker turn needs to share the same terminal semantics as internal agents.

## Decision

OpenKit will introduce a worker-turn reliability envelope with app-local runtime pieces and a small protocol promotion.

The protocol promotion is limited to a stable `StopReason` enum and a rule that once a stream has started, failures must be encoded as terminal events or terminal items rather than escaping as transport errors.

All other pieces begin in `apps/nanocore`: `internalAgentLoop`, `InternalAgentEvent`, hook composition, runtime checkpoints, pending-user-turn handling, context package projection, and worker-turn continuation policy.

`InternalAgentRunner.run()` remains as a stable facade while the loop underneath becomes evented and stream-capable.

Because this repository is still in internal development, implementation may break app-local shapes where that gives a cleaner design.

## Accepted Design

### Layer Ownership

The design has three ownership layers.

`packages/protocol` owns stable stop reasons and terminal stream semantics.

`apps/nanocore` owns internal-agent events, worker-turn checkpoints, context packages, hook diagnostics, and worker adapter orchestration.

Worker adapters own runtime-native details such as Codex session ids, OpenCode session ids, provider request ids, tool-call ids, sandbox commands, and process handles.

## Current Implementation Projection

The V1 reliability envelope is implemented. The accepted protocol slice is implemented in `packages/protocol`: `StopReason` is a shared enum and terminal `turn.completed` events carry `stopReason` on the event envelope, not on the durable `Turn` record.

NanoCore has an app-local evented internal-agent loop and `InternalAgentRunner.stream()` path. Internal-agent events now use the accepted app-local event base with `runId`, `agentId`, monotonic `sequence`, and `eventType`; the current `/api/app/quick-chat` product route still exposes the aggregate `run()` response.

NanoCore also has the first app-local worker-turn envelope through `runWorkerTurnLoop()`, worker checkpoint tables, pending user-turn queues, safe-point steering, follow-up queues, `prepareNextTurn()`, interrupted-worker read-model materialization, pending user-turn recovery read models, pending user-turn edit, follow-up conversion, interrupt promotion, and cancellation, terminal checkpoint cleanup, and interrupted-checkpoint retry-to-ready recovery exposed through App API, `@openkit/core-client`, and `@openkit/mcp`. Interrupted-worker read-model rows now advertise the implemented recovery choices directly: inspect evidence, retry the interrupted checkpoint, record terminal worker state, or request human recovery guidance. Checkpoint recovery rows in the Action Center now project only real user actions: open the thread, retry the interrupted checkpoint through the retry endpoint, or record and clear a terminal checkpoint state through the terminal endpoint. They do not project adapter-native checkpoint resume or replay until that contract exists.

The current context-package implementation is a first projection slice: item-to-LLM conversion records deterministic context package digests, included item ids, excluded item decisions, and attachable records, while full file-backed worker package materialization and replay remain owned by `docs/specs/20260703-worker_context_package.md`.

The first real governed worker path is the OpenShell/Codex worker-governance path.
OpenCode can conform through the same worker-turn envelope later, but runtime checkpoints are a NanoCore worker-loop responsibility rather than an adapter-specific contract.

### Stop Reason Contract

The stable stop reason enum should be shared by provider streams, internal-agent streams, worker adapter streams, and gateway streams.

```ts
type StopReason =
  | 'completed'
  | 'error'
  | 'aborted'
  | 'length'
  | 'ask_user'
  | 'budget_exhausted';
```

`completed` means the turn reached a normal terminal state.

`error` means the runtime failed after accepting or starting the operation.

`aborted` means a user, system, or cancellation signal stopped the operation intentionally.

`length` means the model or runtime stopped because an output or context limit was reached.

`ask_user` means the runtime cannot continue without explicit user input or approval.

`budget_exhausted` means the thread or turn budget is exhausted and no new substantive work should start.

Low-level provider clients may still throw.

The stream adapter boundary must catch provider, parser, timeout, and adapter errors after the stream starts and encode them as a terminal event or terminal item with a redacted `errorCode` and `errorMessage`.

Before a stream starts, HTTP validation and auth failures may still use normal HTTP errors.

After a stream starts, the caller should see a well-formed terminal record, never a half-open stream that dies without a stop reason.

NanoCore's LLM Gateway wraps Chat Completions and Responses SSE streams at the route boundary. If a provider or bridge stream throws after the request has been accepted, the wrapper appends a redacted OpenAI-compatible SSE error payload with `stopReason: "error"` and then emits `[DONE]`.

### Internal Agent Event Model

`InternalAgentEvent` is app-local in the first slice.

It should use Pi's event vocabulary and include enough fields to map onto existing SSE projections.

```ts
type InternalAgentEvent =
  | InternalAgentStartedEvent
  | InternalAgentTurnStartedEvent
  | InternalAgentMessageStartedEvent
  | InternalAgentMessageUpdatedEvent
  | InternalAgentMessageEndedEvent
  | InternalAgentTurnEndedEvent
  | InternalAgentEndedEvent
  | InternalAgentToolExecutionStartedEvent
  | InternalAgentToolExecutionUpdatedEvent
  | InternalAgentToolExecutionEndedEvent;
```

All events should include `runId`, `agentId`, `sequence`, and `eventType`.

Events that belong to a turn should include `turnId`.

Events that expose errors should include redacted `errorCode` and `errorMessage`.

Tool execution events are reserved in the union so the event surface does not need a breaking reshape when a future internal agent gets Core-owned tools.

Initial QuickChat and WorkerCoordinator loops should emit no tool execution events.

### Internal Agent Loop And Runner Shell

`internalAgentLoop()` is an async generator.

It is "pure" in the practical sense that it does not own registry lookup, provider configuration, diagnostics storage, or process-global state.

It still receives effectful dependencies as parameters.

```ts
async function* internalAgentLoop<TOutput>(
  request: InternalAgentLoopRequest,
  deps: InternalAgentLoopDeps<TOutput>
): AsyncGenerator<InternalAgentEvent, InternalAgentLoopResult<TOutput>, void>;
```

The loop receives a fully resolved agent definition, selected provider, selected model, provider call effect, parser, clock, abort signal, and optional hooks.

The loop emits lifecycle events in order.

For non-streaming providers, the loop still emits `message_start`, one `message_update` containing the assistant text, and `message_end`.

For streaming providers, the loop emits one `message_update` per text delta and keeps the final aggregation internal to the result.

The loop catches errors after the invocation starts and emits terminal events with `stopReason: 'error'` or `stopReason: 'aborted'`.

The loop does not record diagnostics itself.

`InternalAgentRunner` remains the stateful shell.

The shell resolves the definition, provider, model, and defaults.

The shell enforces input limits before the stream starts.

The shell aggregates loop events into the existing `InternalAgentRunResult`.

The shell records recent failures and redacted diagnostics.

The shell exposes an app-local `stream()` method that can consume OpenAI-compatible SSE chunks, normalize them into loop text deltas, dispatch hooks, and return the event generator without changing the aggregate `run()` API.

### Hook Composition

Hooks should be app-local and optional.

Observational hooks are isolated by default.

When a hook throws, the composite hook records a hook failure diagnostic and continues to the next hook.

Critical hooks may opt into `reraise: true`.

`InternalAgentRunner` dispatches loop events into the composite hook chain and retains recent redacted observational hook failures in diagnostics.

Semantic transform hooks should either return a typed `Result` or be explicitly fail-fast.

This distinction prevents telemetry and UI hook failures from killing an internal-agent or worker loop while keeping state-mutating hooks honest.

### Item To LLM Projection

OpenKit's durable history is an item log.

Provider-visible context is a projection of that log, not the log itself.

NanoCore should introduce a `convertToLlm` boundary.

```ts
function convertToLlm(
  items: readonly OpenKitItem[],
  policy: LlmProjectionPolicy
): LlmProjectionResult;
```

The result should include provider messages, referenced item ids, excluded item ids with reasons, token estimates when available, and a context package digest.

The projection policy decides which items are model-visible, summarized, elided, or UI-only.

Examples of UI-only or audit-only items include status rows, artifact pointers, approval markers, protocol diagnostics, and terminal state records.

Examples of model-visible items include user instructions, assistant text, selected tool results, approved knowledge or context injections, and explicit worker handoff context.

The projection must be recorded for worker turns so debugging can answer what the worker saw.

The projection should not mutate the item log.

### Worker Turn Envelope

The worker-turn envelope is the app-local execution state machine for worker delegation and later Sustained Mode.

The minimum states are:

```text
idle
preparing
restoring
building_context
running_internal_agent
running_worker
waiting_for_approval
waiting_for_user
saving
recovering
completed
failed
aborted
```

The envelope owns continuation primitives that should not be buried inside individual agents.

`prepareNextTurn(context)` can return a revised context package, selected model, selected worker, steering message, or continuation prompt.

`shouldStopAfterTurn(context)` can return `continue`, `completed`, `blocked`, `ask_user`, `budget_exhausted`, `error`, or `aborted`.

The steering queue is system-owned and is injected before the next worker or coordinator turn.

The follow-up queue is user-owned or runtime-owned and supports `one_at_a_time` and `all` drain modes.

NanoCore's app-local `runWorkerTurnLoop()` is the first worker-turn envelope shell. It drains safe-point steering and follow-up queues, prepares the next worker-visible context, creates the durable turn, writes the pre-worker checkpoint, starts the worker, observes the terminal worker stop reason, records terminal checkpoint evidence, and evaluates `shouldStopAfterTurn()`.

The product-facing Goal Mode command is `POST /api/app/workspaces/:workspaceId/threads/:threadId/goal/step`. It runs exactly one bounded worker envelope iteration and returns the refreshed goal summary, worker turn metadata, stop decision, evidence refs, and pending attention. The deterministic supervise flow lives under `/goal/test/supervise/step` and is limited to tests, smoke fixtures, and local demos.

Future tool batches should follow Pi's conservative termination semantics: a batch should stop the loop only when every finalized tool result in the batch requests termination.

### Runtime Checkpoint

NanoCore should persist a runtime checkpoint before non-idempotent or long-running boundaries.

The first checkpoint shape should be app-local.

```ts
interface RuntimeCheckpoint {
  schemaVersion: 1;
  workspaceId: string;
  threadId: string;
  turnId: string;
  runId: string;
  stage: WorkerTurnStage;
  iteration: number;
  workerSessionId?: string;
  providerRequestId?: string;
  contextPackageDigest?: string;
  pendingApprovalId?: string;
  pendingToolCallIds?: string[];
  stopReason?: StopReason;
  createdAt: string;
  updatedAt: string;
}
```

The checkpoint is not a promise that in-flight streams can resume.

It is a recovery record that tells NanoCore where the turn stopped and what can safely happen next.

On restart, NanoCore should materialize an explicit interrupted item or state update into the thread.

The user or coordinator can then choose retry, resume from a worker session when safe, review partial artifacts, or abort.

Checkpoints are cleared only after terminal turn state, goal task state, evidence refs, read-model state, stop reason, and terminal checkpoint stage are durably saved.

### Pending User Turn

When a user submits input while a thread is already busy, NanoCore should preserve that input as a pending user turn instead of racing a second worker execution.

The pending record should carry the request id, thread id, content item id or digest, received time, and queue mode.

If the active turn completes normally, the pending input enters the follow-up queue according to policy.

If the active turn crashes, recovery should show that a pending user turn exists and avoid silently dropping it.

### Context Compaction

Autonomous context compaction should not ship in the first implementation.

The envelope should reserve context package summaries and item projection metadata so context compaction has a place to attach later.

The first knowledge-adjacent behavior should remain human-visible context summaries or Knowledge Store proposals, not autonomous long-term knowledge editing.

## Data And Protocol Changes

Protocol changes:

- Maintain `StopReason` in `packages/protocol`.
- Maintain stop reasons and terminal stream behavior in `docs/core/protocol.md`.
- Maintain generated JSON Schema and protocol tests for the enum.
- Ensure terminal SSE events continue to carry the stop reason consistently.

NanoCore app-local changes:

- Add `apps/nanocore/src/internal-agents/events.ts`.
- Add `internalAgentLoop()` below the current definitions and above the stateful runner shell.
- Keep `InternalAgentRunner.run()` as the first aggregation caller.
- Add app-local checkpoint storage for worker turns.
- Add context package projection records for worker turns.
- Add hook diagnostics.
- Add the app-local `runWorkerTurnLoop()` shell that composes queue draining, next-turn preparation, checkpointing, worker start, terminal outcome recording, and stop-after-turn policy.
- Normalize Gateway streaming read failures into terminal SSE error payloads with stable stop reasons.

No public App API route is required for the first internal loop split.

Streaming QuickChat can become the first caller that exposes event flow to Web after the loop is stable.

## Alternatives Considered

Alternative: keep `InternalAgentRunner` monolithic.

This is simpler today but makes streaming, multi-turn routing, event diagnostics, and test isolation harder.

Alternative: promote every internal-agent event to the Core protocol.

This leaks NanoCore implementation details and conflicts with the existing boundary that keeps product modes and runtime internals out of protocol.

Alternative: require low-level provider stream functions to never throw.

This is too strict for HTTP clients and SDK boundaries; the practical contract belongs at the adapter boundary after the stream starts.

Alternative: encode every error as a final assistant message.

This works for Pi's message model but is too narrow for OpenKit because the thread log has authoritative items and terminal events that do not need to pretend to be assistant prose.

Alternative: implement autonomous context compaction now.

This would mix context-compaction and Knowledge Store policy with worker reliability before there are enough long sessions to validate the compaction behavior.

## Consequences

Internal-agent tests become more focused because event sequences can be tested independently from diagnostics persistence.

QuickChat can stream later without changing the runner facade.

Worker and internal-agent terminal semantics become consistent.

The Web UI can render small truthful runtime states before OpenKit has a larger task graph.

The codebase gains one more runtime boundary, so naming and ownership must stay strict.

## Rollout / Migration Plan

1. Keep protocol `StopReason` tests and generated schema coverage current as the enum evolves.

2. Update `docs/core/protocol.md` with terminal stream behavior.

3. Add `InternalAgentEvent` and loop tests before changing `InternalAgentRunner`.

4. Refactor `InternalAgentRunner.run()` to consume `internalAgentLoop()` while preserving existing tests and public behavior.

5. Add hook composition with isolated observational hooks and hook failure diagnostics.

6. Add a non-public `stream()` path for QuickChat and keep the existing aggregate path.

7. Add `convertToLlm` and context package recording for worker turns.

8. Add runtime checkpoint and pending-user-turn persistence for worker turns.

9. Move `prepareNextTurn`, `shouldStopAfterTurn`, steering queue, and follow-up queue into the worker-turn envelope.

10. Defer autonomous context compaction until a later workflow, Knowledge Store, or long-session spec.

## Testing Strategy

L1 internal-agent unit tests should cover event order, non-streaming success, streaming success, schema validation failure, provider failure, timeout, abort, hook failure isolation, and diagnostics redaction.

L1 protocol tests should cover `StopReason` enum validation and generated JSON Schema parity.

L2 contract tests should verify that once a stream starts, provider or adapter failures are emitted as terminal records with stop reasons.

L3 NanoCore black-box tests should cover interrupted worker turn recovery, pending user input preservation, and checkpoint clearing after successful terminal save.

L4 Web tests should wait until QuickChat streaming is exposed and then verify that message deltas, terminal stop reasons, and error states render without corrupting thread history.

No build-time behavior change is required for the spec-only step.

## Risks & Mitigations

Risk: event names become public protocol accidentally.

Mitigation: keep internal-agent events in `apps/nanocore` and map them explicitly into existing Core SSE records.

Risk: stop reasons are too coarse for debugging.

Mitigation: pair the stable enum with app-local redacted error codes and diagnostics.

Risk: context projection hides important information from the model.

Mitigation: record excluded item ids and exclusion reasons in the context package.

Risk: checkpoints create duplicate side effects after restart.

Mitigation: checkpoints should describe recovery state, while retry or resume actions must pass through idempotent command ids and adapter-specific safety checks.

Risk: hook isolation hides important failures.

Mitigation: every isolated hook failure must emit a diagnostic event and appear in server diagnostics.

## Resolved Decisions

- `StopReason` belongs on the terminal `turn.completed` event envelope, not on the durable `Turn` record.
- Context package traces are file-system-first workspace records with digests and manifests; SQLite or read-model rows may index or attach them but must not become the only source of truth.
- `InternalAgentRunner.stream()` is an app-local NanoCore path, not a public Core protocol contract; QuickChat can project streaming later through an App API route after the product surface is ready.
- The minimum interrupted-worker recovery surface is an item-backed or App API read-model row with checkpoint id, turn id, stage, context digest, stop reason when known, redacted diagnostics, and explicit user or coordinator choices such as retry, resume when adapter-safe, review partial artifacts, or abort.
- Runtime checkpoints belong to the NanoCore worker-turn loop first; the OpenShell/Codex worker-governance path is the first exercised governed backend, and OpenCode should conform through the same envelope later.

## Deferred Work

- Define the full file-backed worker context package materialization and replay flow in `docs/specs/20260703-worker_context_package.md`.
- Expose QuickChat streaming through a product App API route when the Web projection needs it.
- Define autonomous context compaction only after long-running sessions create enough evidence to validate compaction quality and governance.
- Define adapter-safe in-flight checkpoint resume only after checkpoint records carry explicit replay-safe resume instructions.

## Links

- [earendil-works/pi](https://github.com/earendil-works/pi)
- [HKUDS/nanobot](https://github.com/HKUDS/nanobot)
- [NanoCore Lightweight Agents](./superseded/agent-workflow/20260526-nano_core_lightweight_agents.md)
- [Sustained Mode: Long-Running, Self-Correcting, Token-Efficient Agent Operation](./superseded/agent-workflow/20260525-sustained_mode_long_running_agent.md)
- [Core Protocol Hardening](./20260628-protocol_contract_consolidation.md)
- [Core Protocol](../core/protocol.md)
