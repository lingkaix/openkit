# Chat Mode And Core Assistant

Status: Accepted
Implementation: Implemented

## Owns

- Chat Mode as the lightweight user interaction path before delegated worker work starts.
- The Core Assistant runtime contract for quick replies, clarification, simple workspace state lookup, and routing triage.
- The Assistant tool boundary for V1: bounded workspace state reads, optional read-only working-directory inspection, Knowledge Manager query, and future external search.
- The handoff contract from Assistant to Workflow Coordinator.
- Thread and item projection rules for Assistant replies and handoff decisions.

## Does Not Own

- Task Mode worker delegation. `docs/specs/20260704-task_mode_worker_delegation.md` owns that path.
- Goal Mode planning and long-running coordination. `docs/specs/20260704-goal_mode_coordination.md` owns that path.
- Workflow Coordinator internals. `docs/specs/20260704-workflow_coordinator_internal_agent.md` owns the reusable coordinator role.
- Knowledge Store format, retrieval governance, or Knowledge Manager maintenance loops. Those are owned by `docs/core/knowledge.md`, `docs/specs/20260702-knowledge_store_governance_rules.md`, `docs/specs/20260703-knowledge_store_implementation.md`, and `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md`.
- A general web search, browser, shell, filesystem write, MCP tool, or worker execution capability for the Assistant.

## Core References

- `docs/core/work-model.md`
- `docs/core/architecture.md`
- `docs/core/agent-workflow.md`
- `docs/core/communication.md`
- `docs/core/protocol.md`
- `docs/core/agent-capability.md`
- `docs/core/knowledge.md`
- `docs/core/audit.md`

## Summary

Chat Mode is the immediate interaction path for simple answers, clarification, and workspace state lookup. It is implemented by the Core Assistant, an internal NanoCore agent that stays inside the Core coordination plane and must not become a worker runtime.

The Assistant may answer directly only when the request fits its limited tool boundary. If the request needs non-trivial work, long-running execution, file edits, external side effects, broad repository analysis, risky actions, or multi-step planning, the Assistant must hand off explicitly to the Workflow Coordinator. The user-facing transition from Chat Mode to Task Mode or Goal Mode must be visible in thread history.

## Goals / Non-goals

### Goals

- Make the default user entry point fast and low overhead.
- Keep quick replies out of worker scheduling unless delegated work is required.
- Give the Assistant enough governed context to answer simple workspace questions.
- Make every escalation to Task Mode or Goal Mode explicit and explainable.
- Record Assistant replies, clarifying questions, and handoff decisions as normal thread items.

### Non-goals

- Do not let the Assistant run worker agents directly.
- Do not let the Assistant edit files, push commits, call shell commands, browse arbitrarily, or use broad MCP tool supply.
- Do not treat Chat Mode as a hidden autonomous workflow.
- Do not let the Assistant write Knowledge Store records directly.
- Do not require every Chat Mode request to create a plan, goal, task, or worker turn.

## Background

`docs/core/work-model.md` defines Chat Mode as the lightweight path for simple answers, clarification, and state lookup. `docs/core/architecture.md` defines Core Assistant as the lightweight user-facing entry role. `docs/core/agent-workflow.md` states that the Assistant should hand non-trivial worker-agent work to the Workflow Coordinator.

The missing V1 contract is the concrete Assistant boundary: which tools it may use, how it decides to answer or hand off, and how its output appears in the durable thread model.

## Decision

- Chat Mode is served by the Core Assistant.
- The Assistant runs as an internal Core agent, not as a worker agent, agent supply entry, or selectable runtime.
- The Assistant may use only explicitly enabled lightweight tools.
- The Assistant must choose one terminal routing outcome for every user request: answer, clarify, hand off to Task Mode, hand off to Goal Mode, refuse, or fail typed.
- Handoff to Workflow Coordinator is explicit Core state and must be visible through item history or a stable App API projection.
- Assistant calls to the LLM gateway must use the same capability, usage, and audit foundation as other gateway-mediated LLM calls.

## Contract / Expected Behavior

### Assistant tool boundary

V1 Assistant tools are limited to:

- workspace summary reads: current workspace, linked repositories, active threads, recent task state, pending Action Center rows, configured agents, and high-level readiness diagnostics
- thread summary reads for the active thread
- Knowledge Manager query for source-traceable knowledge answers or uncertainty reports
- optional read-only working-directory inspection when workspace policy enables it
- future external search through a separate accepted external-search capability, not arbitrary network access

Rules:

- Read-only working-directory inspection must be bounded by workspace root policy, file size limits, path exclusions, and redaction rules.
- Assistant tools must not expose secrets, raw vault material, bearer tokens, provider-native payloads, raw worker checkpoints, or raw `DATA_ROOT` paths.
- Assistant tools must not mutate workspace files, Knowledge Store records, Git state, runtime state, vault records, or policy configuration.
- Assistant tool results may be summarized into an assistant message, but restricted evidence must stay behind its owning visibility boundary.

### Routing outcomes

The Assistant must produce exactly one routing outcome:

- `answered`: the Assistant returned a direct response.
- `clarification-needed`: the Assistant asked a bounded question and the turn waits for user input.
- `task-handoff`: the request should become Task Mode and be handed to Workflow Coordinator.
- `goal-handoff`: the request should become Goal Mode and be handed to Workflow Coordinator for planning.
- `refused`: the request is outside allowed policy or product boundary.
- `failed`: the Assistant could not complete due to a typed system failure.

The outcome must include a short explanation suitable for diagnostics and optional user display.

### Handoff rules

- The Assistant must hand off to Task Mode when the request is a bounded piece of delegated work with a near-term completion path and does not need plan negotiation.
- The Assistant must hand off to Goal Mode when the request is long-running, ambiguous, high-risk, multi-step, multi-agent, or benefits from explicit plan approval.
- The Assistant must not silently start worker execution. It hands off to Workflow Coordinator, which owns worker delegation and Goal Mode coordination.
- Handoff records must preserve the original user request, Assistant rationale, selected target mode, and relevant context references.

### Thread and item projection

- Direct Assistant replies appear as normal `assistant-message` items.
- Assistant clarifying questions use the human-attention user-input gate when the turn cannot continue without the answer.
- Handoff decisions must be represented by an item-backed status, handoff item, or stable App API read model that maps back to the thread.
- Chat Mode must not create a worker turn unless Workflow Coordinator accepts the handoff into Task Mode or Goal Mode.

### Usage and audit

- Assistant LLM calls must emit durable `CapabilityCall` and `UsageRecord` rows once the shared capability usage foundation is implemented.
- Tool reads that touch privileged workspace state must be auditable at the appropriate level of detail without storing secret values or unrestricted file contents.

## Accepted Design

NanoCore adds a `CoreAssistant` service with three direct dependencies: a bounded workspace-state reader, a Knowledge Manager query client, and the LLM gateway. The service builds a compact prompt from the user request and allowed context summaries, asks the model for a structured routing outcome plus optional response text, validates the outcome, and either writes an assistant item, opens a user-input gate, or creates a handoff record for Workflow Coordinator.

The service should stay app-local in `apps/nanocore` until the internal-agent runtime proves stable. Do not introduce a general multi-agent framework for this slice.

## Current Implementation Projection

NanoCore now exposes the first thread-scoped Chat Mode Assistant slice at `POST /api/app/workspaces/:workspaceId/threads/:threadId/chat`. `@openkit/app-api-schemas` owns `StartChatModeRequestSchema`, `ChatModeOutcomeSchema`, `ChatModeHandoffSchema`, and `StartChatModeResponseSchema`; `@openkit/core-client` exposes `client.app.startChatMode`; and `@openkit/mcp` exposes `openkit.start_chat` for AI Interface clients.

The route records one user-message item plus either a direct `assistant-message` answer, an item-backed `user-input-request` clarification gate, or an item-backed `status` handoff projection. Clearly vague requests such as bare "Help", "Can you help with this?", or "What should I do?" create a bounded clarification question, mark the turn `awaiting_human`, and surface the question through the existing Action Center protocol-item projection without calling `QuickChatAgent` or starting a worker. Direct answers first consult Knowledge Manager for source-traceable workspace knowledge and return a knowledge-backed assistant message when matching accepted knowledge exists. Narrow linked-repository inspection questions then use read-only working-directory inspection when `workspace.assistant.repositoryInspection.enabled` is not `false`: NanoCore reads only the default linked repository root entries, one safe repository-relative directory named in the prompt, or one explicitly named safe text file. Directory listings skip hidden entries such as `.git`, apply exact-or-prefix `excludedPaths`, and return redacted names without absolute paths. File reads refuse hidden path segments, dot-segment traversal, policy-excluded paths, unsupported file extensions, files over the bounded preview size, and binary-looking content; the answer includes only a redacted preview and never an absolute local path. Repository inspection records an `assistant.repository.read` capability call and finish audit row with `repository.root_list`, `repository.directory_list`, or `repository.file_read`, and it does not recurse, call shell, mutate files, or start a worker. Mutating repository or file requests such as delete/remove are classified as bounded delegated work before repository inspection, so they create a visible Task Mode handoff instead of using the Assistant's read-only file preview path. If Knowledge Manager and the bounded repository inspection path return insufficient evidence, direct answers fall back to `QuickChatAgent`, the existing limited internal-agent tool boundary, provider/model selection, and the shared LLM usage recorder; provider-backed fallback calls now emit `inference.local.quick_chat` capability and usage rows with workspace, request, thread, and turn lineage when durable storage is available. Requests classified as bounded worker work create a `task-handoff` status item and start one bounded Task Mode attempt through the same Workflow Coordinator, durable scheduler, worker startup, AEP, repository workspace, sourceRef, and turn evidence path as the public Task Mode route. Requests classified as longer-running planning work create a durable Goal Mode objective through the same Goal Mode start path as the public Goal route, then create a `goal-handoff` status item without starting a worker turn. Unsupported coordinator decisions create a refused status projection.

The deterministic L6 MCP story `tests/stories/chat-mode-mcp-smoke.story.md` now covers the accepted V1 Chat Mode backbone through `openkit.start_chat`: a knowledge-backed direct answer with source evidence, a bounded clarification gate projected into Action Center, linked-repository file-list and file-read answers from read-only inspection, a visible Task Mode handoff that starts bounded worker progress through Workflow Coordinator, and a visible Goal Mode handoff that creates a durable goal readable through `openkit.read_goal`. L1 and L3 route coverage also prove that a mutating repository-file request is not answered by the read-only repository inspection tool and does not create an `assistant.repository.read` capability row.

The accepted V1 Chat Mode contract is implemented. Explicit external search or browsing requests are refused until a separate accepted external-search capability exists, so Chat Mode does not imply arbitrary network access through the Assistant. Broader real-provider acceptance coverage, richer inspection controls beyond exact path prefixes, and capability/audit linkage for future Assistant-specific tools beyond repository inspection and provider-backed fallback remain future hardening work, not blockers for the accepted V1 Assistant boundary.

## Alternatives Considered

- Let Chat Mode directly start worker agents. Rejected: it collapses Assistant and Coordinator responsibilities and hides delegated work from the workflow model.
- Make every user request go through Goal Mode. Rejected: it adds planning overhead to simple questions and makes the product feel slow.
- Give Assistant the full worker MCP tool catalog. Rejected: Chat Mode is intentionally low-risk and low-latency; broad tool use belongs to worker capability and Workflow Coordinator paths.

## Consequences

- Users get a fast entry point without losing the ability to escalate into tracked work.
- The Assistant becomes an explicit internal agent with a small tool boundary instead of an ad hoc route handler.
- Some requests will require visible handoff instead of a direct answer; this is intentional and keeps work traceable.

## Rollout / Migration Plan

1. Add the Assistant routing outcome schema and tests. Done for the first App API slice.
2. Route the existing quick-chat path through Core Assistant without adding new tools. Done for the thread-scoped Chat Mode route; `/api/app/quick-chat` remains a standalone lightweight API surface for callers that intentionally use that narrower route.
3. Add bounded workspace-state reads. Done for linked-repository root file-list inspection, one safe repository-relative directory listing, and one safe repository-relative text-file preview.
4. Add Knowledge Manager query support after the Knowledge Manager runtime interface exists. Done for direct source-traceable Chat Mode answers.
5. Add explicit Task Mode and Goal Mode handoff records after the coordinator specs are implemented. Done for the first status-item-backed App API projection; Task Mode handoff execution now starts the accepted bounded Task Mode path and Goal Mode handoff execution now creates the accepted durable Goal Mode objective.
6. Add bounded clarification gates. Done for the first deterministic vague-request slice.
7. Keep external search deferred until an accepted external-search capability exists. Done by refusing explicit external-search requests through Chat Mode.

## Testing Strategy / Acceptance Criteria

- L1: routing classification tests for answer, clarify, task handoff, goal handoff, refusal, and failure.
- L1: tool-boundary tests proving disallowed file writes, shell, worker calls, MCP calls, and secret reads cannot be requested through Assistant tools.
- L2: contract tests for item projection and handoff record shape.
- L3: NanoCore black-box tests for a direct answer, a clarification gate, a Task Mode handoff, and a Goal Mode handoff.
- L6: story acceptance where a user asks a simple workspace question and gets an immediate answer, then asks for a larger change and sees a visible handoff to tracked work.

Acceptance: Assistant never directly starts a worker, never mutates files or knowledge, emits visible thread history, and routes non-trivial work to Workflow Coordinator.

## Risks & Mitigations

- Risk: Assistant over-answers tasks that should be delegated. Mitigation: conservative routing tests and explicit handoff outcomes.
- Risk: read-only working-directory access leaks sensitive files. Mitigation: workspace policy can disable repository inspection or exclude sensitive path prefixes, and the implemented reader uses hidden-path refusal, traversal refusal, extension limits, size limits, binary checks, and redaction before returning previews.
- Risk: Chat Mode becomes another workflow engine. Mitigation: Assistant only answers, clarifies, or hands off.

## Resolved Decisions

Previously open questions are resolved by accepted V1 defaults: Assistant read-only working-directory inspection starts with linked-repository root file names, one safe repository-relative directory listing, and one explicitly named safe repository-relative text-file preview. It skips or refuses hidden entries such as `.git`, applies workspace-configured exact-or-prefix `excludedPaths`, returns no absolute paths, does not recurse, and broadens only after stronger path filters, size limits, redaction, and audit linkage are proven; Chat-to-Task and Chat-to-Goal handoff is represented as an App API projection over a status item, not a dedicated protocol item type.

## Deferred / Future Work

- External search capability.
- Rich UI for Assistant routing explanations.
- Assistant personalization from accepted Knowledge Store preferences.
- Multi-user Assistant behavior and per-member visibility rules.

## Links

- `docs/core/work-model.md`
- `docs/core/architecture.md`
- `docs/core/agent-workflow.md`
- `docs/core/knowledge.md`
- `docs/specs/20260704-task_mode_worker_delegation.md`
- `docs/specs/20260704-goal_mode_coordination.md`
- `docs/specs/20260704-workflow_coordinator_internal_agent.md`
- `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md`
- `docs/specs/20260704-capability_usage_gateway_foundation.md`
