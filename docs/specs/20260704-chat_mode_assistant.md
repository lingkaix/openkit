---
status: Accepted
implementation: Partial
---
# Chat Mode And Core Assistant

## Owns

- Chat Mode as the lightweight user interaction path before delegated worker work starts.
- The Core Assistant role contract for quick replies, clarification, simple workspace state lookup, and routing triage.
- The Assistant's ordinary conversational entry path and its complete fixed Tool set: bounded Workspace state reads, bounded read-only working-directory inspection, Knowledge Manager query, Workspace creation, and Task or Goal handoff.
- The Assistant information-source model, request-scoped read selection, output-audience projection, and continuity precedence.
- The narrowed administration entry path that reuses the Assistant role without mixing administration Tools into ordinary conversation.
- The handoff contract from Assistant to Workflow Coordinator.
- Thread and item projection rules for Assistant replies and handoff decisions.
- Assistant-branch result ownership, exact replay, and conflict behavior across every routing outcome.

## Does Not Own

- Task Mode worker delegation. `docs/specs/20260704-task_mode_worker_delegation.md` owns that path.
- Goal Mode planning and long-running coordination. `docs/specs/20260704-goal_mode_coordination.md` owns that path.
- Workflow Coordinator internals. `docs/specs/20260704-workflow_coordinator_internal_agent.md` owns the reusable coordinator role.
- Knowledge Store format, retrieval governance, or Knowledge Manager maintenance loops. Those are owned by `docs/core/knowledge.md`, `docs/specs/20260702-knowledge_store_governance_rules.md`, `docs/specs/20260703-knowledge_store_implementation.md`, and `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md`.
- A general web search, browser, shell, filesystem write, MCP tool, or worker execution capability for the Assistant.
- Direct provider error codes, redaction, and retry semantics. `docs/specs/20260531-worker_turn_reliability_envelope.md` owns that exact call-boundary contract.
- The generic internal Agent loop or Tool contract. `docs/specs/20260813-internal_agent_runtime.md` owns those mechanisms; this specification owns only the Assistant role assembly projected onto them.
- Permission evaluation or disclosure authorization. `docs/core/permissions.md` owns `AssistantReadScope`, `OutputAudience`, per-call authorization, approval strength, and the publication guard; this specification narrows and projects those decisions for Assistant Turns.
- Conversation-target enumeration, structured submission, Artifact references, and public command identity. `docs/specs/20260831-unified_conversation_composer.md` owns that boundary and invokes this Assistant branch.

## Core References

- `docs/core/work-model.md`
- `docs/core/architecture.md`
- `docs/core/agent-workflow.md`
- `docs/core/communication.md`
- `docs/core/protocol.md`
- `docs/core/agent-capability.md`
- `docs/core/knowledge.md`
- `docs/core/audit.md`
- `docs/core/permissions.md`

## Summary

Chat Mode is the immediate interaction path for simple answers, clarification, and workspace state lookup. It is implemented by the Core Assistant, an Internal Core Role that stays inside the Core coordination plane and must not become a worker runtime.

The Assistant may answer directly only when the request fits its limited role boundary. If the request needs non-trivial work, long-running execution, file edits, external side effects, broad repository analysis, risky actions, or multi-step planning, the Assistant must hand off explicitly through the owning Task or Goal path. The user-facing transition from Chat Mode to Task Mode or Goal Mode must be visible in Thread history.

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
- Every ordinary conversational Turn receives the ordinary entry path's complete fixed Tool set in stable deterministic order.
- The Assistant must choose one successful routing outcome for every accepted user request: answer, clarify, hand off to Task Mode, hand off to Goal Mode, or refuse. System failure uses the typed App API error contract and is not a success-shaped routing outcome.
- Handoff to Workflow Coordinator is explicit Core state and must be visible through item history or a stable App API projection.
- Assistant calls to the LLM gateway must use the same capability, usage, and audit foundation as other gateway-mediated LLM calls.

## Contract / Expected Behavior

### Assistant Tool Boundary

The ordinary conversational entry path has this complete fixed semantic Tool set, in this stable order:

1. Bounded Workspace and work-state read for the exact selected resource.
2. Bounded Thread-history read beyond the initial admitted Thread range or summary.
3. Governed Knowledge query for source-traceable answers or uncertainty reports.
4. Bounded read-only working-directory inspection.
5. `workspace.create` for an empty project Workspace required by an accepted handoff.
6. `task.start` for an explicit Task handoff.
7. `goal.start` for an explicit Goal handoff.

These semantic operations MUST map to the Tool contract owned by `docs/specs/20260813-internal_agent_runtime.md`; provider-safe names may be projected by that owner without changing membership or order. No worker-execution, file-write, Git-write, credential, policy, runtime-management, broad MCP, or administration Tool belongs to this entry path.

Rules:

- The Turn carries this entry path's complete fixed Tool set in this stable deterministic order on every ordinary conversational Turn, regardless of what the user said.
- Whether the model would call a Tool is a model decision and is not an admission rule.
- Absence from the set is reserved for an operation that is unreachable from this entry path, never for an operation that is merely rare, currently unavailable, unauthorized for this actor, or unnecessary for this message.
- Tool presence is permission to request an operation, never proof that the current actor, source, target, audience, or effect is authorized.
- Every Tool call MUST reauthorize through its current Core owner. A present Tool that cannot currently execute MUST return its product-safe typed refusal reason as a Tool result rather than disappear from the set.
- A request for an operation belonging to another entry path MUST produce a proposed new Thread for that entry path rather than a refusal or an in-place Tool-array change.
- Read-only working-directory inspection must be bounded by workspace root policy, file size limits, path exclusions, and redaction rules.
- Assistant tools must not expose secrets, raw vault material, bearer tokens, provider-native payloads, raw worker checkpoints, or raw `DATA_ROOT` paths.
- Assistant tools must not mutate workspace files, Knowledge Store records, Git state, runtime state, vault records, or policy configuration.
- Assistant tool results may be summarized into an assistant message, but restricted evidence must stay behind its owning visibility boundary.

Policy-disabled read-only inspection and currently unavailable handoff operations remain present because their worst case is contained by read-only enforcement, typed refusal, or explicit approval. Tool invocation performs no action when authorization, policy, resource state, dependency availability, or the required user decision is missing.

The Tool set is reconstructed from the server-resolved entry path for each new Turn and remains pinned for that Turn. Retry or restart admits a new Turn from current owners; it does not reuse a message-selected array or treat the previous array as authorization. A mid-conversation pivot to a Tool already in the fixed set needs no array change. A pivot to an administration or other distinct entry path proposes a new Thread whose own entry path has its own complete fixed Tool set.

Acceptance is observable when two ordinary conversational Turns with different messages expose the same ordered Tool definitions, a no-Tool answer still exposes that set while calling none of it, a refused present Tool returns a typed Tool result, and a request for another entry path creates a proposed new Thread without mutating the current Turn's set.

### Assistant Information Sources

The Assistant has exactly five semantic information-source classes:

| Source class | Included material | Freshness and persistence rule |
| --- | --- | --- |
| Active Thread history | Durable conversation, accepted user corrections, and decision context from the current Thread. | Use the smallest relevant Item range or a governed source-attributed summary. Durable Thread Items remain truth; a summary is replaced when its source range, authorization, correction, deletion, or retention state makes it stale. |
| Governed Knowledge | Reviewed or directly user-authored reusable understanding eligible for the request and audience. | Query on demand through the Knowledge owner with source, version, scope, freshness, sensitivity, conflict, and exclusion evidence. It is never loaded merely because the Thread belongs to a Workspace. |
| External observation | Current information obtained from an explicitly admitted observation capability. | Retrieve on demand with source identity, observation time, bounds, and provenance. It is untrusted observation, is not promoted into Knowledge automatically, and supplies no instruction or effect authority. |
| Operational context | Current actor-authorized Workspace, Thread, Task, Goal, Worker, readiness, attention, and product-state projections. | Query current read models on demand and retain the observation time and uncertainty. Do not copy complete operational state into a prompt or durable Knowledge. |
| Orchestration interaction | Typed handoff, status request, gate response, promotion, or other coordination result. | Persist through its existing Thread, Item, Task, Goal, gate, command, or audit owner. Hidden role-to-role chat is not an information source. |

The active Thread is the base conversational source. The other four classes are reachable only by an admitted Tool call or an exact typed result supplied by their owner. A selected Workspace is a scope hint that may narrow defaults or disambiguate a reference; it is not ambient context and does not inject Workspace configuration, files, Knowledge, source catalogs, work history, operational state, credentials, policies, Goal state, Task state, or Worker state.

A general question that can be answered from the current input and admitted Thread context MUST complete with no Workspace, Knowledge, operational, external-observation, Goal, Task, or Worker read. Merely including an unused read Tool retrieves no data and creates no source observation.

For each source used, the Turn input retains its owner, selected revision or observation time, provenance, relevant exclusions, and freshness. Missing, stale, conflicting, unauthorized, deleted, or dependency-failed sources are omitted or returned as explicit uncertainty or a typed Tool failure; the Assistant MUST NOT substitute ambient Workspace data, cached provider material, or another source silently.

On retry or restart, NanoCore rebuilds the source selection from current Thread history and current owners. It does not recover source authority from provider memory, a warm connection, an earlier Tool result, or an earlier read permission.

Acceptance is observable when a general question performs no non-Thread read, Workspace selection alone performs no read, every used source is attributable with freshness, and stale or unavailable source state produces explicit uncertainty or typed failure rather than fabricated or cached fact.

### Read Scope And Output Audience Projection

Every Assistant answer carries one `AssistantReadScope` and one `OutputAudience` resolved under `docs/core/permissions.md`. `AssistantReadScope` determines which exact sources and revisions the Assistant may discover and retrieve for this request. `OutputAudience` independently determines the exact destination and recipients that may receive the result.

The role assembler supplies only source candidates inside the current read scope and excludes material that cannot reach the resolved audience before assembling output-producing context. Every concrete read reauthorizes the current actor, source, Workspace, revision, operation, and audience. Retrieved material retains source, visibility, freshness, provenance, and disclosure restrictions through generation.

The final publication guard reauthorizes the completed result as defense in depth. It may publish to the resolved audience, redirect to an authorized owner-private Thread, require an explicit typed promotion or sharing decision, or fail closed. It MUST NOT use post-generation redaction as the primary boundary, and a summary derived from restricted material MUST NOT be treated as automatically declassified.

Read scope and audience are reconstructed for every new Turn and rechecked for every Tool call and publication attempt. Authorization loss, audience change, source revision, deletion, stale membership, restart, or dependency failure invalidates the affected use immediately; provider memory and prior successful calls cannot restore it.

Acceptance is observable when the same actor can receive a more detailed owner-private answer than a shared audience without leaking protected content or metadata, every broader transfer leaves an explicit typed promotion outcome, and publication fails closed when the audience cannot receive any material used to produce the answer.

### Context And Continuity Precedence

Assistant continuity is reconstructible in this precedence order:

1. NanoCore-owned Thread history, accepted commands, work records, permission records, and terminal evidence are durable product truth.
2. Exact governed source revisions and current operational observations are request-scoped inputs selected from their owners.
3. The bounded Turn input records the admitted Thread range or summary, selected sources, Tool evidence, important exclusions, freshness, and destination audience needed to explain a consequential answer.
4. Provider-native conversation state, prompt caches, and warm connections are replaceable latency caches that add no authority and hold no unique product truth.

A new Turn is assembled from the smallest relevant durable Thread range or governed summary plus current request-scoped sources. A warm provider context may be reused only while its prompt, Tool set, read scope, output audience, source revisions, policy, and retained Thread context remain compatible; otherwise NanoCore discards it and reconstructs from current owners.

User correction, authorization revocation, deletion, retention change, source revision, audience change, policy change, or incompatible role configuration invalidates affected summaries and provider caches for later calls. An in-progress Turn remains pinned to its admitted input, but publication still performs the current audience guard and may fail closed.

Provider loss, process restart, dependency failure, or cache eviction MUST NOT lose authoritative work or require hidden provider memory to continue. Retry creates a new Turn from current durable truth, preserves causation to the failed or interrupted attempt, and never splices a new provider into an already dispatched attempt or blindly replays Tool effects.

Acceptance is observable when replacing the provider or deleting all provider-side conversation state changes latency at most, a user correction or authorization change affects the next admitted Turn, and a consequential answer can identify the material Thread range or summary, sources, observations, Tools, exclusions, freshness, and audience that grounded it.

### Administration Entry Path

Administration is a narrowed Assistant Turn, not a separate Agent role and not an extension of the ordinary conversational Tool set. Workspace configuration beyond creating an empty project Workspace, Worker Agent supply, execution-environment setup, capability or credential binding, and policy authoring belong only to an administration entry path.

The server admits that entry path only when the arriving surface is the administration surface and the current actor holds the required administration authority. Both facts are server-resolved and model input cannot supply or widen either one. The entry path opens its own Thread and carries its own complete fixed Tool set; an ordinary conversational request for administration produces a proposed administration Thread rather than a refusal, role switch, or in-place Tool-array mutation.

Every administration mutation Tool is `propose`-shaped. The Assistant may produce a candidate with intended effect and rationale, but the product MUST show the exact diff or preview and the owning Core command applies it only after the human decision required by `docs/core/permissions.md`. The administration Turn receives no ordinary conversational observation Tools, so retrieved untrusted material and administration operations do not coexist in one Tool array.

Most administration remains direct validated forms. A model-backed administration Turn is admitted only for drafting, explanation, or diagnosis that benefits from semantic assistance; this does not add authority or bypass the form and command owners.

An administration proposal terminates when it is accepted, rejected, expires, becomes stale, conflicts, or fails. Retry or recovery starts a new Turn against current actor authority and current resource state; it never treats a prior proposal, approval, provider cache, or Tool presence as authority. Missing actor role, wrong surface, stale target, authorization loss, dependency failure, or absent human decision fails closed without applying the proposal.

Acceptance is observable when ordinary conversational Turns contain no administration Tool, an administration request opens a proposed separate Thread, every administration effect has an exact human-approved Core command outcome, and a stale or unauthorized proposal cannot apply after retry or restart.

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
- When the current conversation is owned by Quick Chat, the one handoff confirmation MUST also resolve an existing eligible executing Workspace or propose creation of an empty project Workspace. Acceptance creates or resolves the executing Workspace, creates the new execution Thread there, and submits the Task or Goal handoff as one visible user decision; Quick Chat itself gains no worker capability.
- If no executing Workspace can be resolved or created because exact authorization is missing, the Assistant MUST create a durable refusal Item naming the exact missing authorization and MUST create no Task, Goal, Worker Turn, or execution Thread.

### Thread and item projection

- Direct Assistant replies appear as normal `assistant-message` items.
- Assistant clarifying questions use the human-attention user-input gate when the turn cannot continue without the answer.
- Handoff decisions must be represented by an item-backed status, handoff item, or stable App API read model that maps back to the thread.
- Chat Mode must not create a worker turn unless Workflow Coordinator accepts the handoff into Task Mode or Goal Mode.

### Unified-command branch and replay

The Assistant branch is invoked only by an accepted `conversation.submit` command. Its immutable identity and canonical input hash are owned by `docs/specs/20260831-unified_conversation_composer.md` and include the selected target, logical-model preference, and Artifact references as well as user input. The Assistant receives the already accepted logical-model contract and admitted Artifact context; it never receives or selects a Provider profile, provider-native model, account slot, or private route. A Coordinator decision or mutable Thread projection resolved during execution remains an execution result rather than command input.

NanoCore looks up that command identity before resolving a current mutable projection or invoking Coordinator or a provider. Once a completed command record or complete deterministic result tuple exists, the same identity and input MUST replay the original `answered`, `clarification-needed`, `task-handoff`, `goal-handoff`, or `refused` lineage and MUST NOT invoke a provider, create another Turn or Item, open another gate, start another worker, create another Goal, or enqueue another scheduler admission. Reusing the identity with different caller input returns `409 idempotency_key_conflict` before effects.

Chat-owned Turn and Item identifiers and handoff status identifiers derive deterministically from the immutable command scope and request id. The completed command record is published only after one complete owner tuple is durable: an answered or refused terminal Chat Turn with its user Item and exact result Item; a clarification Turn at `awaiting_human` with the exact `user-input-request` Item and matching human gate; a complete Task handoff tuple; or a complete Goal handoff tuple. The clarification tuple is an acknowledged command result even though the Turn is nonterminal, so replay returns that gate and never opens another one. If no deterministic Chat or handoff owner is durable, the same command may perform its first attempt. A handled failure leaves either no tuple or one terminal failed Chat tuple. If only part of a tuple is durable, inspection and exact replay return `recovery_required`; they do not rerun the provider, complete the missing business write by inference, or start the handoff again. A user-requested new attempt after a terminal failure uses a new `requestId`; no command reservation state, Chat settlement workflow, or recovery lifecycle is introduced.

For `task-handoff` and `goal-handoff`, the initiating `conversation.submit` command is the only command-ledger owner. It calls the Task or Goal mode service with the immutable outer command scope and causation, and that service creates the deterministic downstream Thread, Turn, Goal, Item, checkpoint, and scheduler tuple without publishing a second `task.start` or `goal.start` receipt. Direct public Task or Goal requests retain their own command identity. A half-state is therefore evaluated against one outer receipt and one downstream business tuple, not two nested command records.

An Assistant-targeted conversation command may publish `task-handoff` or `goal-handoff` only after the complete downstream tuple is durable. If the downstream mode rejects before accepting a command or effect, the Assistant must complete the same Turn as `clarification-needed` when one bounded answer can make the request executable or as `refused` otherwise; it MUST NOT publish a handoff Item or receipt that names nonexistent downstream work.

When the owning Workspace is Quick Chat and the Assistant selects `task-handoff` or `goal-handoff`, the project-eligibility guard keeps Quick Chat ineligible and resolves or proposes an eligible executing Workspace inside the one handoff confirmation. An accepted confirmation creates or selects that Workspace and creates the downstream execution Thread there while the originating Quick Chat Thread retains the handoff Item and causation. Only when exact Workspace resolution or creation authority is unavailable does the conversation command complete with a durable refusal Item naming that missing authorization; no Task, Goal, Worker Turn, checkpoint, or scheduler admission exists in that refusal case.

The exact `turn.input.submit` command owns continuation of an Assistant clarification. After validating the active gate, it stores the matching response Item and returns the same Assistant Turn to `running`, then invokes the same bounded decision path over the original input plus that response. Its accepted result is one answer, refusal, handoff, or replacement clarification tuple in the same Turn. The input command acknowledges only after that tuple is durable; identical replay returns it, changed answers conflict, and a response/outcome half-state returns `recovery_required`. It does not resume a worker AgentSession or require a second `conversation.submit` request.

### Usage and audit

- Assistant LLM calls must emit durable `CapabilityCall` and `UsageRecord` rows once the shared capability usage foundation is implemented.
- Tool reads that touch privileged workspace state must be auditable at the appropriate level of detail without storing secret values or unrestricted file contents.

### Command receipt authority

The Assistant branch of `conversation.submit` is the narrow multi-owner exception to current-resource replay because a clarification Item and its Turn may advance after the original command was accepted. Its command receipt MAY retain only `resultKind`, the accepted HTTP success status, and the stable downstream Task Thread and Turn or Goal and Goal Turn identifiers required by a handoff. The normal receipt resource identifier names the original Assistant Turn. NanoCore derives the initiating user Item and result Item identifiers from that Turn identifier and the closed `resultKind` mapping, which distinguishes knowledge, repository, or provider answers, clarification, Task handoff, Goal handoff, and refusal. The receipt MUST NOT contain Item identifiers that are already derivable, the prompt, explanation text, Turn or Item bodies, assistant content, Coordinator output, provider output, or a full response body.

Replay reconstructs the original accepted Chat projection from durable owners. It reads the first durable revisions of the initiating user Item and result Item, derives the accepted Turn status, timestamps, duration, and human gate from those Items and `resultKind`, derives fixed explanations from `resultKind` or the result status Item, and validates every derived or stored identifier against the receipt Workspace, Thread, and Turn. A terminal result additionally requires the current Turn to remain completed with the same completion timestamp; a clarification may replay its original accepted gate after the current Item and Turn legitimately advance. A Task handoff also requires the named downstream Turn; a Goal handoff requires the named Goal, its completed creation Item, and completed Goal Turn lineage. Missing, malformed, wrong-kind, or contradictory owners return `409 recovery_required`. The receipt is evidence only and cannot mutate a Turn, Item, Goal, checkpoint, scheduler admission, or provider lifecycle.

This bounded receipt does not solve a crash before receipt publication. Deterministic request-derived owner identities and the existing downstream business owners must address that half-state later; the implementation MUST NOT add a Chat reservation, settlement, recovery workflow, or private lifecycle to compensate.

### Provider and persistence failure

The provider response is not an `answered` Chat Mode outcome until the same Thread owns a durable Turn, its user-message Item, its assistant-message Item, and terminal completed status. The deterministic Turn and initiating user Item MUST be durable before provider dispatch; they are the ordinary narrative owner proving that this Chat attempt began, not a separate reservation. Failure before that pair leaves no Chat records.

After that pair is durable, provider rate limit, request failure, timeout, caller abort, or invalid content MUST terminalize the same Turn with the exact `provider_rate_limited`, `provider_request_failed`, `provider_call_timeout`, `provider_call_aborted`, or `provider_response_invalid` code defined by S05. Caller abort makes the Turn `interrupted`, and the existing `provider_call_aborted` code preserves the cause; the other provider failures make it `failed`. The command receipt preserves that typed failure lineage, exact replay does not redispatch, and failure to persist the required terminal tuple returns `recovery_required`.

`chat_mode_persistence_failed` is reserved for a valid provider response whose assistant Item and completed Turn tuple could not be committed. The implementation MUST terminalize the same Turn as failed when that deterministic failure tuple can be written; it MUST NOT redispatch the provider under the same request, publish a completed assistant Item, or claim `answered`. A partial or contradictory assistant/Turn tuple, or failure to persist terminalization, returns `recovery_required`. The bounded availability compromise is that the user must use a new request id for another provider attempt rather than adding a settlement owner.

Chat Mode does not resume the provider invocation after process failure. The caller reads the command and Thread state; replay of a completed request returns the original lineage, a started but incomplete provider attempt returns its terminal failure or `recovery_required`, and a user-requested new attempt uses a new request id and creates a new provider invocation. This deliberately favors no hidden duplicate call over automatic recovery and is not authorization for a Chat settlement or recovery workflow.

## Accepted Design

NanoCore implements Core Assistant as one role assembly over the bounded internal Agent runtime owned by `docs/specs/20260813-internal_agent_runtime.md`. The Assistant supplies its role prompt, bounded current Thread input, entry-path-fixed Tool definitions, request-scoped sources, and output audience; the generic loop supplies no Assistant authority or product lifecycle.

The Assistant remains app-local in `apps/nanocore`, owns no private execution lifecycle, and must not introduce a second loop, registry, event protocol, hook framework, or multi-agent framework for this role.

## Current Implementation Projection

NanoCore exposes the Assistant as one target of `GET /api/app/workspaces/:workspaceId/conversation-targets` and `POST /api/app/workspaces/:workspaceId/threads/:threadId/conversation-turns`. `@openkit/app-api-schemas` owns the strict shared conversation contracts, `@openkit/core-client` exposes `client.app.getConversationTargets` and `client.app.submitConversation`, and the retired `StartChatMode*`, `client.app.startChatMode`, `/chat` App route, and `chat.start` operation have no compatibility surface.

The route records one user-message item plus either a direct `assistant-message` answer, an item-backed `user-input-request` clarification gate, or an item-backed `status` handoff projection. Clearly vague requests such as bare "Help", "Can you help with this?", or "What should I do?" create a bounded clarification question, mark the turn `awaiting_human`, and surface the question through the existing Action Center protocol-item projection without calling Quick Chat or starting a worker. Direct answers first consult Knowledge Manager for source-traceable workspace knowledge and return a knowledge-backed assistant message when matching accepted knowledge exists. Narrow linked-repository inspection questions then use read-only working-directory inspection when `workspace.assistant.repositoryInspection.enabled` is not `false`: NanoCore reads only the default linked repository root entries, one safe repository-relative directory named in the prompt, or one explicitly named safe text file. Directory listings skip hidden entries such as `.git`, apply exact-or-prefix `excludedPaths`, and return redacted names without absolute paths. File reads refuse hidden path segments, dot-segment traversal, policy-excluded paths, unsupported file extensions, files over the bounded preview size, and binary-looking content; the answer includes only a redacted preview and never an absolute local path. Repository inspection records an `assistant.repository.read` capability call and finish audit row with `repository.root_list`, `repository.directory_list`, or `repository.file_read`, and it does not recurse, call shell, mutate files, or start a worker. Mutating repository or file requests such as delete/remove are classified as bounded delegated work before repository inspection, so they create a visible Task Mode handoff instead of using the Assistant's read-only file preview path. If Knowledge Manager and bounded repository inspection return insufficient evidence, direct answers use one concrete, bounded Quick Chat provider call with no tools, registry, private lifecycle, hook chain, or internal event stream; provider/model resolution, Gateway dispatch, cache scope, cancellation, timeout, output validation, redaction, and the shared LLM usage recorder remain with their existing owners. Provider-backed fallback calls emit `inference.local.quick_chat` capability and usage rows with Workspace, request, Thread, and Turn lineage when durable storage is available. Requests classified as bounded worker work create a `task-handoff` status Item and start one bounded Task Mode attempt through the same Workflow Coordinator, durable scheduler, worker startup, AEP, repository workspace, sourceRef, and Turn evidence path as the public Task Mode route. Requests classified as longer-running planning work create a durable Goal Mode objective through the same Goal Mode service, then create a `goal-handoff` status Item without starting a worker Turn. Unsupported Coordinator decisions create a refused status projection.

Historical deterministic L6 evidence covered the accepted V1 Assistant backbone: a knowledge-backed direct answer with source evidence, a bounded clarification gate projected into Action Center, linked-repository file-list and file-read answers from read-only inspection, a visible Task Mode handoff that starts bounded worker progress through Workflow Coordinator, and a visible Goal Mode handoff that creates a durable goal. The retired MCP-only and `chat.start` stories are not active release gates; current L1 and L3 unified-route coverage proves that a mutating repository-file request is not answered by the read-only repository inspection tool and does not create an `assistant.repository.read` capability row.

The accepted Assistant routing and projection path is implemented behind `conversation.submit`. Explicit external search or browsing requests remain refused until a separate accepted external-search capability exists. The strict request requires `requestId`, the Core Client generates one when omitted, and NanoCore stores only bounded branch metadata plus downstream owner identifiers. Identical replay reconstructs from canonical Thread, Turn, Item, Task, and Goal owners without rerunning Coordinator, Provider, worker launch, or Goal creation; missing or contradictory owners return `409 recovery_required`. This specification remains `Partial` only for the recovery and external-capability cases still named by its acceptance criteria, not for the retired Chat-specific transport.

## Alternatives Considered

- Let Chat Mode directly start worker agents. Rejected: it collapses Assistant and Coordinator responsibilities and hides delegated work from the workflow model.
- Make every user request go through Goal Mode. Rejected: it adds planning overhead to simple questions and makes the product feel slow.
- Give Assistant the full worker MCP tool catalog. Rejected: Chat Mode is intentionally low-risk and low-latency; broad tool use belongs to worker capability and Workflow Coordinator paths.

## Consequences

- Users get a fast entry point without losing the ability to escalate into tracked work.
- The Assistant is an explicit Internal Core Role with one small role assembly over the accepted generic internal Agent runtime.
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

Acceptance also requires identical ordered ordinary-entry Tool definitions across message classes, zero ambient Workspace or operational reads for a general question, current per-call authorization and publication guarding, reconstructible continuity, a separate propose-only administration Thread, and a Quick Chat work request that reaches one confirmed executing Workspace and Task or Goal or leaves an exact durable missing-authorization refusal.

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
