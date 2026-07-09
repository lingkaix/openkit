# NanoCore Lightweight Agents

Status: Superseded

Superseded by `docs/core/architecture.md`, `docs/core/agent-workflow.md`, `docs/specs/20260531-worker_turn_reliability_envelope.md`, and `docs/specs/20260703-worker_context_package.md`.

This document is retained as supporting detail for the early internal-agent design. The active core documents now own Core Assistant, Workflow Coordinator, Knowledge Manager, and future Task Evaluator boundaries.

## Summary

NanoCore should gain a small set of internal lightweight agents that help users and worker agents coordinate real work without turning NanoCore into another heavy execution runtime.

These agents live inside the Core coordination plane.

They may call LLM providers, read governed Core state, summarize work, choose routing, prepare context, propose knowledge updates, and decide when to schedule worker agents.

They must not perform heavy execution such as coding loops, shell work, browser operation, large file edits, external tool workflows, or runtime-native task execution.

Codex and OpenCode remain the only worker agent runtimes needed for the current validation phase.

## Goals / Non-goals

Goals:

- Make NanoCore useful for quick user interaction before a worker agent is required.
- Add a lightweight internal agent framework that can host quick replies, workflow coordination, knowledge management, and future task evaluation.
- Keep the implementation compact, direct, testable, and app-local inside `apps/nanocore`.
- Borrow NanoBot's small-core discipline, registry/factory separation, provider abstraction, and direct runtime flow.
- Preserve the stable `Workspace -> Thread -> Turn -> Item[]` workflow protocol.
- Enable the later Sustained Mode work by giving NanoCore a coordination brain that can route, summarize, evaluate, and hand off worker agent tasks.

Non-goals:

- Do not build a second Codex, OpenCode, Pi Agent, or general-purpose heavy agent runtime.
- Do not add more worker runtime adapters in this phase.
- Do not expose NanoCore internal agent implementation details as stable protocol records.
- Do not introduce a plugin framework, graph runtime, swarm planner, or broad multi-agent topology engine.
- Do not give internal lightweight agents raw filesystem, shell, browser, network, MCP, or secret access by default.
- Do not move provider, gateway, OAuth, or internal-agent schemas into `packages/protocol` while they are still app-level implementation surfaces.

## Background

OpenKit's product vision already states that Core can handle quick answers and lightweight tasks while heavy execution belongs to agents.

`docs/core/architecture.md` also defines the stable internal Core roles: Core Assistant, Workflow Coordinator, Knowledge Manager, and the future Task Evaluator placeholder.

The current codebase already contains a Quick Chat app API that answers through the configured provider without allocating a worker turn.

This is the right seed for internal lightweight agents.

The missing step is to make this pattern explicit so future features do not grow as unrelated route handlers or accidentally turn NanoCore into a heavy runtime.

NanoBot is the reference for implementation posture.

The useful lesson is not that OpenKit should copy NanoBot as a whole.

The useful lesson is that a small system can stay flexible when it has a direct loop, a registry/factory boundary for provider and capability resolution, compact configuration, and edge extension points instead of framework-heavy internals.

## Decision

NanoCore will add an app-local `internal-agents` subsystem.

The subsystem hosts Core-owned lightweight agents that run bounded LLM tasks and Core service calls.

The initial implementation should support exactly these internal agent families:

- `CoreAssistantAgent`: answers simple user questions and workspace status prompts without starting a worker turn.
- `WorkflowCoordinatorAgent`: decides whether a prompt should stay in quick reply or be delegated to a worker agent, selects Codex or OpenCode from the available catalog, assembles the final worker context, and explains the routing decision.
- `KnowledgeManagerAgent`: supports governed knowledge retrieval, source-traceable context material preparation, and proposed knowledge updates from completed work, user preferences, project conventions, and repeated failure patterns.
- `TaskEvaluatorAgent`: future placeholder that will review worker results, errors, artifacts, test evidence, and workflow or Skill updates, then recommend accept, revise, retry, handoff, or escalate.

Only `CoreAssistantAgent` is required in the first slice.

The other agents are design targets that should be added only when their caller and tests are concrete.

### Modes And Agents

Product modes are user-facing work entry points.

Internal agents are implementation roles behind those modes.

They are related, but they are not always one-to-one.

The mode answers what kind of work the user is doing.

The internal agent answers which NanoCore capability performs the coordination work.

Initial mode taxonomy:

- `chat`: low-latency user conversation, similar to ChatGPT.
- `automation`: a bounded worker-agent task with clear user instruction and near-term completion.
- `plan`: a discussion and planning surface for shaping a larger delegated task before execution.
- `review`: a focused evaluation surface for recent work, artifacts, diffs, failures, or plans.
- `organize`: a workspace maintenance surface for knowledge, task summaries, artifact cleanup, and project context hygiene.
- `delegation`: a long-running delegated work mode where NanoCore coordinates planning, worker execution, review, handoff, and progress until the task is complete or blocked.

Mode-to-agent mapping should stay explicit:

```text
chat
  -> CoreAssistantAgent

automation
  -> WorkflowCoordinatorAgent
  -> worker runtime

plan
  -> WorkflowCoordinatorAgent
  -> KnowledgeManagerAgent when source-traceable context material is needed

review
  -> TaskEvaluatorAgent

organize
  -> KnowledgeManagerAgent

delegation
  -> WorkflowCoordinatorAgent
  -> KnowledgeManagerAgent when knowledge-derived context is needed
  -> worker runtime
  -> TaskEvaluatorAgent in a future review slice
  -> KnowledgeManagerAgent after accepted completion when knowledge updates are proposed
```

The v0.0.5 implementation keeps this mapping in `apps/nanocore/src/internal-agents/modes.ts` so product mode names and internal-agent paths remain typed and testable.

`delegation` is the product-facing shape of future Sustained Mode.

It is not a single internal agent.

It is a composition of NanoCore internal agents plus one or more worker turns.

`plan`, `review`, and `organize` can ship independently before full delegation because they are useful standalone slices and later become reusable phases inside delegation.

## Proposed Design

### Architecture Shape

```text
Web UI / App API
  -> NanoCore route or orchestrator
      -> InternalAgentRegistry
          -> InternalAgentRunner
              -> Provider dispatcher
              -> Bounded Core tools
      -> Worker scheduler when delegation is required
          -> Codex or OpenCode worker runtime
```

Internal agents consume Core state and provider output.

Worker agents execute external work.

The boundary is deliberately strict:

```text
Internal lightweight agent:
  route, summarize, evaluate, prepare, propose

Worker agent:
  code, browse, shell, use tools, create artifacts, run long loops
```

### Module Layout

The first implementation should stay app-local:

```text
apps/nanocore/src/internal-agents/
  delegation.ts
  registry.ts
  runner.ts
  types.ts
  core-assistant.ts
  workflow-coordinator.ts
  knowledge-manager.ts
  task-evaluator.ts
```

`registry.ts` is the single source of internal agent metadata.

`runner.ts` owns common invocation, timeout, provider selection, structured-output parsing, telemetry hooks, and error normalization.

Individual agent files own prompt construction, input/output schemas, and allowed Core tools.

No shared package should be created until app-level needs stabilize.

### Internal Agent Definition

The conceptual definition is:

```ts
interface InternalAgentDefinition<Input, Output> {
  id: string;
  displayName: string;
  purpose: string;
  category: 'conversation' | 'workflow' | 'knowledge' | 'evaluation';
  supportedModes: InternalAgentMode[];
  defaultProviderUse: 'quickChat' | 'internalTask';
  inputSchema: ZodSchema<Input>;
  outputSchema: ZodSchema<Output>;
  contextPolicy: InternalAgentContextPolicy;
  allowedTools: InternalCoreToolId[];
  limits: InternalAgentLimits;
}
```

`defaultProviderUse` reuses the existing provider default split for quick chat and internal tasks.

`allowedTools` references NanoCore-owned read or write operations, not arbitrary MCP tools or shell commands.

The first agent definitions should keep `allowedTools` empty or read-only.

### Internal Agent Runner

The runner should be a small service, not an autonomous framework.

It should:

- Resolve provider and model through the existing LLM provider config store and dispatcher.
- Build a short prompt from the agent definition and caller input.
- Optionally attach bounded Core context selected by `contextPolicy`.
- Request structured JSON when the caller needs a decision instead of prose.
- Validate output through the agent output schema.
- Return normalized `InternalAgentResult` with usage, provider, model, duration, and error shape.
- Emit diagnostics without prompts, secrets, raw provider tokens, or sensitive knowledge content.

The runner should not:

- Start worker turns directly unless called by the orchestrator path that already owns scheduling.
- Execute shell, browser, filesystem, remote network, or MCP calls.
- Persist knowledge entries without a review or policy gate.
- Introduce hidden state that bypasses thread, item, knowledge, usage, or audit records.

### Bounded Core Tools

Internal agents may eventually use a small tool registry that exposes Core services.

Initial candidates:

- `readWorkspaceSummary`
- `readThreadSummary`
- `searchWorkspaceItems`
- `searchMemory`
- `readAgentReadiness`
- `draftWorkerDelegation`
- `proposeMemoryEntry`
- `summarizeArtifacts`

These tools are Core APIs, not runtime tools.

They must return redacted, scoped data.

They must be audited when they influence user-visible behavior.

They must never expose raw secrets or unbounded workspace files.

### CoreAssistantAgent

`CoreAssistantAgent` is the first lightweight internal agent.

It replaces the current quick-chat route implementation internally while preserving the existing App API response shape.

Responsibilities:

- Answer simple user questions.
- Answer workspace status prompts using bounded workspace context when provided.
- Use the quick-chat provider/model default.
- Avoid creating a worker turn.
- Return a short assistant response and usage metadata.

Non-responsibilities:

- No code execution.
- No external browsing.
- No file edits.
- No worker scheduling.
- No automatic knowledge writes.

The current test invariant should remain: quick chat must not call `startTurn` or `interruptTurn` on a worker executor.

### WorkflowCoordinatorAgent

`WorkflowCoordinatorAgent` is the second internal agent once CoreAssistantAgent is stable.

Responsibilities:

- Classify whether a user request is quick reply, worker work, review, refinement, handoff, or unsupported.
- Select Codex or OpenCode using the current agent catalog, readiness, runtime capability, workspace roots, and provider/model context.
- Produce a structured routing decision with explanation, confidence, and required user approvals.
- Request source-traceable knowledge material from KnowledgeManagerAgent when worker context needs it.
- Assemble the final worker prompt and context package from task instructions, workflow state, user constraints, capability policy, and knowledge-derived material.
- Prepare a stable app-level worker delegation draft for the existing orchestrator to execute.

Non-responsibilities:

- It does not run the worker itself.
- It does not bypass Core scheduling.
- It does not invent adapter-native launch payloads.
- It does not override user-selected agent choices without explanation.
- It does not directly maintain the Knowledge Store.

v0.0.5 defines the delegation draft shape in `apps/nanocore/src/internal-agents/delegation.ts`.

The draft is versioned and contains:

- `schemaVersion`
- `source`
- `mode`
- `prompt`
- `workspaceId`
- `threadId`
- selected worker `target`
- confirmation and single-worker-iteration constraints
- explicit context references

It intentionally does not contain `runMode`, loop state, iteration state, producer/critic topology, or any adapter-native launch payload.

### Context Package Preparation Boundary

Context package preparation is not a separate internal agent role.

It is a shared responsibility between KnowledgeManagerAgent, which selects and prepares source-traceable knowledge material, and WorkflowCoordinatorAgent, which assembles the final worker context for a worker turn or a Sustained Mode iteration.

Responsibilities:

- Select relevant thread history, knowledge, artifacts, workspace config, and explicit user instructions.
- Produce a bounded context package with source references.
- Keep context engineering explicit and reviewable.

Non-responsibilities:

- It does not read the full filesystem.
- It does not silently inject all knowledge.
- It does not synthesize long-term knowledge.
- It does not own workflow routing or worker selection.

### TaskEvaluatorAgent

`TaskEvaluatorAgent` reviews worker output after a turn.

Responsibilities:

- Summarize what the worker did.
- Review artifacts, errors, command summaries, and test evidence exposed through Core records.
- Recommend accept, revise, retry, handoff, or escalate.
- Feed future Producer/Critic review in Sustained Mode.

Non-responsibilities:

- It does not claim correctness without evidence.
- It does not run hidden verification commands.
- It does not commit, revert, or edit user files.

v0.0.5 reserves the task evaluation note shape in `apps/nanocore/src/internal-agents/delegation.ts`.

The reserved note has a schema version, `task-evaluator` source, `reserved` status, outcome, evidence references, summary, and recommended next action.

It does not yet schedule review loops or perform hidden verification.

### KnowledgeManagerAgent

`KnowledgeManagerAgent` starts as a retrieval and proposal engine, not an automatic knowledge writer.

Responsibilities:

- Identify candidate user preferences, project facts, task summaries, repository conventions, and failure patterns.
- Retrieve relevant knowledge and prepare source-traceable material for WorkflowCoordinatorAgent.
- Produce proposed knowledge entries with source traceability, confidence, freshness, and scope.
- Mark conflicts with existing knowledge.

Non-responsibilities:

- It does not store secrets.
- It does not infer broad user personality traits.
- It does not overwrite accepted knowledge without a supersession path.
- It does not inject knowledge into worker turns directly.
- It does not compose the final worker prompt.

### Relationship To Sustained Mode

Sustained Mode should be treated as `delegation` mode at the product level.

It should build on these internal agents instead of starting as a separate runtime or one oversized internal agent.

The expected mapping is:

- `WorkflowCoordinatorAgent` chooses worker delegation targets and assembles each iteration's worker context.
- `KnowledgeManagerAgent` supplies source-traceable knowledge material and proposes lessons after stable completion.
- `TaskEvaluatorAgent` may later perform critic-style review, verification measurement, and stop recommendations.
- `CoreAssistantAgent` remains the low-latency user interaction path outside heavy work.

This keeps the flagship long-running work feature grounded in the same Core coordination model.

v0.0.5 adds preparation hooks only:

- a versioned worker delegation draft
- a routing decision summary that can be projected as a read model or later item-backed record
- a delegation preparation snapshot with `fullLoopEnabled: false`
- a reserved task evaluation note shape

The future full loop supporting detail lives in `docs/specs/retired/agent-workflow/20260525-sustained_mode_long_running_agent.md`.

The standalone `plan`, `review`, and `organize` modes should be implemented before or alongside the first delegation slice when they are smaller and independently useful.

They are not detours.

They are extracted phases of delegation that can be validated earlier.

### App API And Protocol Boundary

The first implementation should keep existing endpoints stable:

- `POST /api/app/quick-chat`
- `GET /api/app/diagnostics`
- existing workspace, thread, turn, item, artifact, knowledge, and approval endpoints

New internal-agent outputs may be surfaced through app-level read models or item-backed summaries.

They should not become new protocol records until the product concept is stable.

When an internal agent decision changes workflow state, the visible result should be item-backed, audit-backed, or diagnostics-backed.

Examples:

- A routing decision may become a status item or turn metadata.
- A task evaluation may become a review item.
- A proposed knowledge entry may become a pending knowledge record.
- A context package may be recorded as a context-injection item if it affects a worker turn.

## NanoBot Lessons To Borrow

Borrow:

- A small direct loop instead of a broad framework.
- A registry as the source of metadata.
- A factory/runner boundary between configuration and runtime execution.
- Provider behavior behind interfaces rather than route-level conditionals.
- Explicit config and diagnostics for local, gateway, direct, and OAuth provider cases.
- Compact tool/service exposure at the edge.

Do not borrow:

- NanoBot's full agent runtime as NanoCore's runtime.
- A general-purpose tool loop for every internal agent.
- A wide tool registry that can mutate the host environment.
- A multi-channel product scope before the web internal dogfooding loop is stable.

## Alternatives Considered

### Keep Quick Chat As A Route Handler

This is simplest for the current code.

It does not scale well when workflow coordination, knowledge retrieval, context preparation, and task evaluation start to share provider resolution, structured output, limits, diagnostics, and redaction.

The route handler should become a caller of `CoreAssistantAgent` rather than the long-term abstraction.

### Build A Full Core Agent Runtime

This would allow NanoCore to run arbitrary agent loops internally.

It conflicts with the Core boundary and duplicates Codex/OpenCode.

It also increases security, knowledge, tool, and product complexity before the internal dogfooding loop proves value.

### Make Every Mode A Separate Runtime

This would make `chat`, `automation`, `plan`, `review`, `organize`, and `delegation` independent implementations.

It would duplicate provider calls, tool policy, diagnostics, redaction, and structured-output handling.

OpenKit should instead use one internal-agent runner and explicit mode-to-agent orchestration.

### Add More Worker Adapters First

More adapters would test abstraction breadth.

Codex and OpenCode already provide enough runtime diversity for the current stage.

The product risk is now the work surface and coordination loop, not adapter count.

## Consequences

Positive consequences:

- NanoCore can answer, route, summarize, and evaluate without spawning heavyweight worker sessions.
- The Web UI can become an internal work surface sooner.
- Sustained Mode gets a concrete coordination substrate.
- Provider and gateway work is reused instead of duplicated.
- Runtime adapter expansion stays deferred until product value is validated.

Negative consequences:

- NanoCore gains more LLM-dependent behavior, so tests must isolate provider calls.
- The internal agent boundary must be enforced consistently or Core will drift into heavy execution.
- Structured-output failures become a product reliability concern.
- Diagnostics and audit surfaces must distinguish internal agent decisions from worker agent execution.

## Rollout Plan

1. Add the internal-agent registry, types, and runner with fake provider tests.
2. Move `/api/app/quick-chat` behind `CoreAssistantAgent` without changing its public response shape.
3. Add diagnostics for internal agent availability, provider/model selection, and recent non-secret failures.
4. Add `WorkflowCoordinatorAgent` only after the Web UI needs worker routing or routing explanations.
5. Add `plan` mode through `WorkflowCoordinatorAgent` with `KnowledgeManagerAgent` support when worker delegation needs explicit, source-traceable context material.
6. Add `review` mode through `TaskEvaluatorAgent` before the first sustained review loop.
7. Add `organize` mode through `KnowledgeManagerAgent` only when proposed knowledge review and source traceability are implemented.
8. Compose `delegation` mode from workflow coordination, Knowledge Manager material selection, worker execution, future evaluation, and knowledge proposal once the smaller modes are validated.

## Testing Strategy

- Unit test each internal agent definition and output schema.
- Unit test provider selection for quick-chat and internal-task defaults.
- Unit test that `CoreAssistantAgent` never calls worker `startTurn` or `interruptTurn`.
- Unit test structured-output parsing and validation failures.
- Unit test redaction of prompts, secrets, account IDs, auth headers, and knowledge content from diagnostics.
- Integration test `/api/app/quick-chat` for unchanged public behavior.
- Integration test worker routing decisions with fake agent readiness and fake provider output.
- Integration test mode-to-agent routing so `chat`, `automation`, `plan`, `review`, `organize`, and future `delegation` remain explicit.
- Browser test the UI path that uses quick chat and later worker routing explanation.
- Keep real provider and real subscription tests opt-in.

## Risks & Mitigations

Risk: Internal agents become a hidden heavy runtime.

Mitigation: Keep allowed tools bounded, keep worker scheduling in the orchestrator, and keep shell/browser/filesystem execution outside internal agents.

Risk: Internal agent decisions become invisible product magic.

Mitigation: Record user-visible routing, evaluation, knowledge, and context decisions as item-backed or diagnostics-backed records.

Risk: Provider calls make tests flaky or expensive.

Mitigation: Use fake providers by default and keep real provider tests opt-in.

Risk: KnowledgeManagerAgent generates low-quality or invasive knowledge.

Mitigation: Treat generated knowledge as proposed until reviewed by policy or a human.

Risk: The implementation grows into a generic framework too early.

Mitigation: Add only the agents that have concrete callers and tests.

## Open Questions

- Should internal agent invocations be persisted as their own audit records from the first slice, or only once they affect user-visible state?
- Should `WorkflowCoordinatorAgent` produce a status item before scheduling a worker turn, or should routing explanation live on the turn summary?
- Should context package preparation write visible context-injection items for every worker turn, or only for long-running and sustained turns?
- Which internal agent decisions should be user-steerable in the first Web UI iteration?
- Should internal agents share the quick-chat provider default, or should `defaults.internalTask` become mandatory before the second agent is added?
- Should `plan`, `review`, and `organize` be visible composer modes in v0.0.5, or should only `chat` and `automation` be exposed first?
- Should `delegation` be the user-facing name for Sustained Mode, with `sustained` kept as an implementation/run-state term?

## Links

- `docs/product-vision.md`
- `docs/core/architecture.md`
- `docs/core/knowledge.md`
- `docs/core/agent-capability.md`
- `docs/specs/retired/agent-workflow/20260525-sustained_mode_long_running_agent.md`
- `apps/nanocore/src/quick-chat.test.ts`
- `apps/nanocore/src/app.ts`
- [HKUDS/nanobot `agent/loop.py`](https://github.com/HKUDS/nanobot/blob/main/nanobot/agent/loop.py)
- [HKUDS/nanobot `agent/runner.py`](https://github.com/HKUDS/nanobot/blob/main/nanobot/agent/runner.py)
- [HKUDS/nanobot `providers/registry.py`](https://github.com/HKUDS/nanobot/blob/main/nanobot/providers/registry.py)
- [HKUDS/nanobot `providers/factory.py`](https://github.com/HKUDS/nanobot/blob/main/nanobot/providers/factory.py)
