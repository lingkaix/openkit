# Chat Mode And Core Assistant

Status: Accepted
Implementation: Partial

## Owns

- Chat Mode as the lightweight user interaction path before delegated worker work starts.
- The Core Assistant role contract for quick replies, clarification, simple workspace state lookup, and routing triage.
- The Assistant tool boundary for V1: bounded workspace state reads, optional read-only working-directory inspection, and Knowledge Manager query.
- The handoff contract from Assistant to Workflow Coordinator.
- Thread and item projection rules for Assistant replies and handoff decisions.
- Chat command identity, exact replay, and conflict behavior across every routing outcome.

## Does Not Own

- Task Mode worker delegation. `docs/specs/20260704-task_mode_worker_delegation.md` owns that path.
- Goal Mode planning and long-running coordination. `docs/specs/20260704-goal_mode_coordination.md` owns that path.
- Workflow Coordinator internals. `docs/specs/20260704-workflow_coordinator_internal_agent.md` owns the reusable coordinator role.
- Knowledge Store format, retrieval governance, or Knowledge Manager maintenance loops. Those are owned by `docs/core/knowledge.md`, `docs/specs/20260702-knowledge_store_governance_rules.md`, `docs/specs/20260703-knowledge_store_implementation.md`, and `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md`.
- A general web search, browser, shell, filesystem write, MCP tool, or worker execution capability for the Assistant.
- Direct provider error codes, redaction, and retry semantics. `docs/specs/20260531-worker_turn_reliability_envelope.md` owns that exact call-boundary contract.

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

Chat Mode is the immediate interaction path for simple answers, clarification, and workspace state lookup. It is implemented by the Core Assistant, an Internal Core Role that stays inside the Core coordination plane and must not become a worker runtime.

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
- The Assistant is an Internal Core Role, not a worker agent, agent supply entry, selectable runtime, or private agent framework.
- The Assistant may use only explicitly enabled lightweight tools.
- The Assistant must choose one successful routing outcome for every accepted user request: answer, clarify, hand off to Task Mode, hand off to Goal Mode, or refuse. System failure uses the typed App API error contract and is not a success-shaped routing outcome.
- Handoff to Workflow Coordinator is explicit Core state and must be visible through item history or a stable App API projection.
- Assistant calls to the LLM gateway must use the same capability, usage, and audit foundation as other gateway-mediated LLM calls.

## Contract / Expected Behavior

### Assistant tool boundary

V1 Assistant tools are limited to:

- workspace summary reads: current workspace, linked repositories, active threads, recent task state, pending Action Center rows, configured agents, and high-level readiness diagnostics
- thread summary reads for the active thread
- Knowledge Manager query for source-traceable knowledge answers or uncertainty reports
- optional read-only working-directory inspection when workspace policy enables it

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
The outcome must include a short explanation suitable for diagnostics and optional user display.

### Handoff rules

- The Assistant must hand off to Task Mode when the request is a bounded piece of delegated work with a near-term completion path and does not need plan negotiation.
- The Assistant must hand off to Goal Mode when the request is long-running, ambiguous, high-risk, multi-step, multi-agent, or benefits from explicit plan approval.
- The Assistant must not silently start worker execution. It hands off to Workflow Coordinator for the bounded routing, worker, and Goal decision; the owning Task or Goal mode service owns durable state and effects.
- Handoff records must preserve the original user request, Assistant rationale, selected target mode, and relevant context references.

### Thread and item projection

- Direct Assistant replies appear as normal `assistant-message` items.
- Assistant clarifying questions use the human-attention user-input gate when the turn cannot continue without the answer.
- Handoff decisions must be represented by an item-backed status, handoff item, or stable App API read model that maps back to the thread.
- Chat Mode must not create a worker turn unless Workflow Coordinator accepts the handoff into Task Mode or Goal Mode.

### Command identity and replay

Every Chat Mode App API request MUST include a client-visible `requestId`; `@openkit/core-client` may generate it before sending, but NanoCore MUST reject a missing id. Command identity is the command name, authenticated actor id, Workspace id, Thread id, and request id. The canonical input hash covers only the caller-supplied user input. The public request accepts no provider or model selection; provider and model derive exclusively from the Internal Core Role defaults owned by S05 and are not command input. A Coordinator decision or current Thread projection resolved during execution is not command input either.

NanoCore looks up that command identity before resolving a current mutable projection or invoking Coordinator or a provider. Once a completed command record or complete deterministic result tuple exists, the same identity and input MUST replay the original `answered`, `clarification-needed`, `task-handoff`, `goal-handoff`, or `refused` lineage and MUST NOT invoke a provider, create another Turn or Item, open another gate, start another worker, create another Goal, or enqueue another scheduler admission. Reusing the identity with different caller input returns `409 idempotency_key_conflict` before effects.

Chat-owned Turn and Item identifiers and handoff status identifiers derive deterministically from the immutable command scope and request id. The completed command record is published only after one complete owner tuple is durable: an answered or refused terminal Chat Turn with its user Item and exact result Item; a clarification Turn at `awaiting_human` with the exact `user-input-request` Item and matching human gate; a complete Task handoff tuple; or a complete Goal handoff tuple. The clarification tuple is an acknowledged command result even though the Turn is nonterminal, so replay returns that gate and never opens another one. If no deterministic Chat or handoff owner is durable, the same command may perform its first attempt. A handled failure leaves either no tuple or one terminal failed Chat tuple. If only part of a tuple is durable, inspection and exact replay return `recovery_required`; they do not rerun the provider, complete the missing business write by inference, or start the handoff again. A user-requested new attempt after a terminal failure uses a new `requestId`; no command reservation state, Chat settlement workflow, or recovery lifecycle is introduced.

For `task-handoff` and `goal-handoff`, the initiating Chat command is the only command-ledger owner. It calls the Task or Goal mode service with the immutable outer command scope and causation, and that service creates the deterministic downstream Turn, Goal, Item, checkpoint, and scheduler tuple without publishing a second `task.start` or `goal.start` receipt. Direct public Task or Goal requests retain their own command identity. A half-state is therefore evaluated against one outer receipt and one downstream business tuple, not two nested command records.

A Chat command may publish `task-handoff` or `goal-handoff` only after the complete downstream tuple is durable. If the downstream mode rejects before accepting a command or effect, the Assistant must complete the same Chat Turn as `clarification-needed` when one bounded answer can make the request executable or as `refused` otherwise; it MUST NOT publish a handoff Item or receipt that names nonexistent downstream work.

When the owning Workspace is Quick Chat and the Assistant selects `task-handoff` or `goal-handoff`, the project-eligibility guard converts that result before downstream effects into the Chat-owned `refused` tuple with stable reason code `project_workspace_required`. The same terminal Chat Turn, initiating user Item, refusal Item, and outer command receipt own replay; no Task or Goal tuple, nested receipt, checkpoint, or scheduler admission exists. This is a product-boundary outcome, not a system error.

The exact `turn.input.submit` command owns continuation of a Chat clarification. After validating the active gate, it stores the matching response Item and returns the same Chat Turn to `running`, then invokes the same bounded Chat decision path over the original input plus that response. Its accepted result is one answer, refusal, handoff, or replacement clarification tuple in the same Turn. The input command acknowledges only after that tuple is durable; identical replay returns it, changed answers conflict, and a response/outcome half-state returns `recovery_required`. It does not resume a worker Session or require a second `chat.start` request.

### Usage and audit

- Assistant LLM calls must emit durable `CapabilityCall` and `UsageRecord` rows once the shared capability usage foundation is implemented.
- Tool reads that touch privileged workspace state must be auditable at the appropriate level of detail without storing secret values or unrestricted file contents.

### Command receipt authority

`chat.start` is the narrow multi-owner exception to current-resource replay because a clarification Item and its Turn may advance after the original command was accepted. Its command receipt MAY retain only `resultKind`, the accepted HTTP success status, and the stable downstream Task Turn or Goal and Goal Turn identifiers required by a handoff. The normal receipt resource identifier names the original Chat Turn. NanoCore derives the initiating user Item and result Item identifiers from that Turn identifier and the closed `resultKind` mapping, which distinguishes knowledge, repository, or provider answers, clarification, Task handoff, Goal handoff, and refusal. The receipt MUST NOT contain Item identifiers that are already derivable, the prompt, explanation text, Turn or Item bodies, assistant content, Coordinator output, provider output, or a full response body.

Replay reconstructs the original accepted Chat projection from durable owners. It reads the first durable revisions of the initiating user Item and result Item, derives the accepted Turn status, timestamps, duration, and human gate from those Items and `resultKind`, derives fixed explanations from `resultKind` or the result status Item, and validates every derived or stored identifier against the receipt Workspace, Thread, and Turn. A terminal result additionally requires the current Turn to remain completed with the same completion timestamp; a clarification may replay its original accepted gate after the current Item and Turn legitimately advance. A Task handoff also requires the named downstream Turn; a Goal handoff requires the named Goal, its completed creation Item, and completed Goal Turn lineage. Missing, malformed, wrong-kind, or contradictory owners return `409 recovery_required`. The receipt is evidence only and cannot mutate a Turn, Item, Goal, checkpoint, scheduler admission, or provider lifecycle.

This bounded receipt does not solve a crash before receipt publication. Deterministic request-derived owner identities and the existing downstream business owners must address that half-state later; the implementation MUST NOT add a Chat reservation, settlement, recovery workflow, or private lifecycle to compensate.

### Provider and persistence failure

The provider response is not an `answered` Chat Mode outcome until the same Thread owns a durable Turn, its user-message Item, its assistant-message Item, and terminal completed status. The deterministic Turn and initiating user Item MUST be durable before provider dispatch; they are the ordinary narrative owner proving that this Chat attempt began, not a separate reservation. Failure before that pair leaves no Chat records.

After that pair is durable, provider rate limit, request failure, timeout, caller abort, or invalid content MUST terminalize the same Turn with the exact `provider_rate_limited`, `provider_request_failed`, `provider_call_timeout`, `provider_call_aborted`, or `provider_response_invalid` code defined by S05. Caller abort makes the Turn `cancelled`; the other provider failures make it `failed`. The command receipt preserves that typed failure lineage, exact replay does not redispatch, and failure to persist the required terminal tuple returns `recovery_required`.

`chat_mode_persistence_failed` is reserved for a valid provider response whose assistant Item and completed Turn tuple could not be committed. The implementation MUST terminalize the same Turn as failed when that deterministic failure tuple can be written; it MUST NOT redispatch the provider under the same request, publish a completed assistant Item, or claim `answered`. A partial or contradictory assistant/Turn tuple, or failure to persist terminalization, returns `recovery_required`. The bounded availability compromise is that the user must use a new request id for another provider attempt rather than adding a settlement owner.

Chat Mode does not resume the provider invocation after process failure. The caller reads the command and Thread state; replay of a completed request returns the original lineage, a started but incomplete provider attempt returns its terminal failure or `recovery_required`, and a user-requested new attempt uses a new request id and creates a new provider invocation. This deliberately favors no hidden duplicate call over automatic recovery and is not authorization for a Chat settlement or recovery workflow.

## Accepted Design

NanoCore implements Core Assistant as a direct app-local service over bounded workspace reads, Knowledge Manager query, deterministic Workflow Coordinator routing, and one direct Quick Chat provider call for the remaining direct-answer fallback. The service either writes an assistant item, opens a user-input gate, or creates a handoff record; it does not own a private execution lifecycle.

The service stays app-local in `apps/nanocore`. Do not introduce a generic internal-agent runtime, registry, event protocol, hook framework, or multi-agent framework for this role.

## Current Implementation Projection

NanoCore now exposes the first thread-scoped Chat Mode Assistant slice at `POST /api/app/workspaces/:workspaceId/threads/:threadId/chat`. `@openkit/app-api-schemas` owns `StartChatModeRequestSchema`, `ChatModeOutcomeSchema`, `ChatModeHandoffSchema`, and `StartChatModeResponseSchema`; `@openkit/core-client` exposes `client.app.startChatMode`; and the unified `openkit` Skill exposes the `chat.start` bundled-CLI operation for AI Interface clients.

The route records one user-message item plus either a direct `assistant-message` answer, an item-backed `user-input-request` clarification gate, or an item-backed `status` handoff projection. Clearly vague requests such as bare "Help", "Can you help with this?", or "What should I do?" create a bounded clarification question, mark the turn `awaiting_human`, and surface the question through the existing Action Center protocol-item projection without calling Quick Chat or starting a worker. Direct answers first consult Knowledge Manager for source-traceable workspace knowledge and return a knowledge-backed assistant message when matching accepted knowledge exists. Narrow linked-repository inspection questions then use read-only working-directory inspection when `workspace.assistant.repositoryInspection.enabled` is not `false`: NanoCore reads only the default linked repository root entries, one safe repository-relative directory named in the prompt, or one explicitly named safe text file. Directory listings skip hidden entries such as `.git`, apply exact-or-prefix `excludedPaths`, and return redacted names without absolute paths. File reads refuse hidden path segments, dot-segment traversal, policy-excluded paths, unsupported file extensions, files over the bounded preview size, and binary-looking content; the answer includes only a redacted preview and never an absolute local path. Repository inspection records an `assistant.repository.read` capability call and finish audit row with `repository.root_list`, `repository.directory_list`, or `repository.file_read`, and it does not recurse, call shell, mutate files, or start a worker. Mutating repository or file requests such as delete/remove are classified as bounded delegated work before repository inspection, so they create a visible Task Mode handoff instead of using the Assistant's read-only file preview path. If Knowledge Manager and bounded repository inspection return insufficient evidence, direct answers use one concrete, bounded Quick Chat provider call with no tools, registry, private lifecycle, hook chain, or internal event stream; provider/model resolution, Gateway dispatch, cache scope, cancellation, timeout, output validation, redaction, and the shared LLM usage recorder remain with their existing owners. Provider-backed fallback calls emit `inference.local.quick_chat` capability and usage rows with Workspace, request, Thread, and Turn lineage when durable storage is available. Requests classified as bounded worker work create a `task-handoff` status Item and start one bounded Task Mode attempt through the same Workflow Coordinator, durable scheduler, worker startup, AEP, repository workspace, sourceRef, and Turn evidence path as the public Task Mode route. Requests classified as longer-running planning work create a durable Goal Mode objective through the same Goal Mode service, then create a `goal-handoff` status Item without starting a worker Turn. Unsupported Coordinator decisions create a refused status projection.

Historical deterministic L6 evidence covered the accepted V1 Chat Mode backbone: a knowledge-backed direct answer with source evidence, a bounded clarification gate projected into Action Center, linked-repository file-list and file-read answers from read-only inspection, a visible Task Mode handoff that starts bounded worker progress through Workflow Coordinator, and a visible Goal Mode handoff that creates a durable goal. The retired MCP-only story is not an active release gate; the unified Skill contract covers `chat.start`, while L1 and L3 route coverage prove that a mutating repository-file request is not answered by the read-only repository inspection tool and does not create an `assistant.repository.read` capability row.

The accepted V1 routing and projection path is implemented. Explicit external search or browsing requests are refused until a separate accepted external-search capability exists, so Chat Mode does not imply arbitrary network access through the Assistant. `StartChatModeRequestSchema` now requires `requestId`, `@openkit/core-client` generates one when its caller omits it, and the route consults the existing `chat.start` command ledger before Workspace-state reads, Coordinator, provider, or downstream mode effects. The rejected first replay correction stored a prompt-free but otherwise nearly complete accepted response, including Turn and result Item bodies. NanoCore now stores only the closed result kind, HTTP success status, and required downstream owner identifiers, derives both Chat Item identifiers from the response Turn, and reconstructs exact accepted answers, refusals, handoffs, and mutable clarification gates from first Item revisions and validated downstream owners. Contradictory terminal Turn, Item, Task Turn, Goal, or Goal Turn owners return `409 recovery_required`; identical replay does not rerun Coordinator, provider, worker launch, or Goal creation. This correction still does not reconstruct a crash between downstream effects and receipt publication because the response Turn and complete downstream tuple are not yet established as request-derived pre-effect owners. The provider-backed fallback is now the direct S05 role call and its public timeout, abort, invalid-content, typed-provider, unexpected-error, and redaction mapping is aligned. It still dispatches before the required Chat failure Turn, user Item, terminal error Item, and receipt are durable, so a failed call has no replayable owner tuple. `ChatModeOutcomeSchema` now excludes the rejected success-shaped `failed` value, while crash half-tuple handling, clarification continuation, provider-failure persistence, and post-provider success persistence remain unaligned. These remaining command-boundary and persistence gaps keep this specification Partial; their correction must reuse the existing command-idempotency and business owners and add no reservation or settlement workflow.

## Alternatives Considered

- Let Chat Mode directly start worker agents. Rejected: it collapses Assistant and Coordinator responsibilities and hides delegated work from the workflow model.
- Make every user request go through Goal Mode. Rejected: it adds planning overhead to simple questions and makes the product feel slow.
- Give Assistant the full worker MCP tool catalog. Rejected: Chat Mode is intentionally low-risk and low-latency; broad tool use belongs to worker capability and Workflow Coordinator paths.

## Consequences

- Users get a fast entry point without losing the ability to escalate into tracked work.
- The Assistant is an explicit Internal Core Role with a small governed service boundary instead of an ad hoc route handler or generic agent runtime.
- Some requests will require visible handoff instead of a direct answer; this is intentional and keeps work traceable.

## Testing Strategy / Acceptance Criteria

- L1: routing classification tests for answer, clarify, Task handoff, Goal handoff, and refusal.
- L1: typed provider and persistence error tests proving system failure never returns a success-shaped routing outcome.
- L1: schema tests requiring `requestId` and rejecting changed input under a reused id.
- L1: tool-boundary tests proving disallowed file writes, shell, worker calls, MCP calls, and secret reads cannot be requested through Assistant tools.
- L2: contract tests for item projection and handoff record shape.
- L3: NanoCore black-box tests for a direct answer, a clarification gate, a Task Mode handoff, a Goal Mode handoff, exact provider-error mapping, and post-provider persistence failure with no false `answered` outcome.
- L3: same-id replay for every successful routing outcome returns the original Chat, Task-handoff, or Goal-handoff owner tuple without duplicate provider, gate, worker, Goal, admission, or usage effects; changed input returns `idempotency_key_conflict` before effects.
- L3: a user-requested retry after a failed provider or persistence attempt uses a new request id, is visibly a new invocation, and does not resume hidden Chat state.
- L6: story acceptance where a user asks a simple workspace question and gets an immediate answer, then asks for a larger change and sees a visible handoff to tracked work.

Acceptance: Assistant never directly starts a worker, never mutates files or knowledge, emits visible thread history, and routes non-trivial work to Workflow Coordinator.

## Risks & Mitigations

- Risk: Assistant over-answers tasks that should be delegated. Mitigation: conservative routing tests and explicit handoff outcomes.
- Risk: read-only working-directory access leaks sensitive files. Mitigation: workspace policy can disable repository inspection or exclude sensitive path prefixes, and the implemented reader uses hidden-path refusal, traversal refusal, extension limits, size limits, binary checks, and redaction before returning previews.
- Risk: Chat Mode becomes another workflow engine. Mitigation: Assistant only answers, clarifies, or hands off.

## Resolved Decisions

Previously open questions are resolved by accepted V1 defaults: Assistant read-only working-directory inspection starts with linked-repository root file names, one safe repository-relative directory listing, and one explicitly named safe repository-relative text-file preview. It skips or refuses hidden entries such as `.git`, applies workspace-configured exact-or-prefix `excludedPaths`, returns no absolute paths, does not recurse, and broadens only after stronger path filters, size limits, redaction, and audit linkage are proven; Chat-to-Task and Chat-to-Goal handoff is represented as an App API projection over a status item, not a dedicated protocol item type.

## Deferred / Future Work

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
- `docs/specs/20260531-worker_turn_reliability_envelope.md`
