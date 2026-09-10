---
status: Accepted
updated: 2026-09-10
implementation: Partial
---
# Chat Mode And Core Assistant

## Worker Environment Operations

The private administration entry may prepare and apply an exact Worker environment change under [Persistent Worker Volumes](20260910-persistent_worker_volumes.md), using the same current-authority, candidate/base revision, payload-bound confirmation and owned command paths as Desktop Skill operation. It may propose a Dockerfile/image declaration and inspect build/attachment results; the existing NanoHost image owner executes the build. Preparation does not activate an image or interrupt work. Activation previews the affected sharing group, drains or explicitly interrupts its writers, retains volumes and admits new execution only after checks. This narrow owned operation amends the earlier setup-inspection-only restriction; it grants no internal shell, Docker socket, arbitrary host file operation, service restart or privilege escalation.

## Owns

- Chat Mode as the lightweight user interaction path before delegated worker work starts.
- The Core Assistant role contract for quick replies, clarification, simple workspace state lookup, and routing triage.
- The Assistant's ordinary conversational entry path and its complete fixed Tool set: bounded Workspace state reads, bounded read-only working-directory inspection, Knowledge Manager query, personal Memory commands, Workspace creation, and Task or Goal handoff.
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
- Logical-model context policy and automatic runtime compaction. `docs/specs/20260902-agent_runtime_context_compaction.md` owns those mechanisms; this specification only supplies Assistant context through the shared loop.
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

The Assistant may answer directly only when the request fits its limited role boundary. Exact governed personal Memory, Kernel, UI and owner-admitted MCP-backed internal operations may execute through their existing owners as defined below. Requests requiring long-running execution, arbitrary file edits, unadmitted external capabilities, broad repository analysis or multi-step Worker planning require explicit handoff through the owning Task or Goal path. The user-facing transition from Chat Mode to Task Mode or Goal Mode must be visible in Thread history.

## Personal Assistant And Visibility

Core Assistant is presented as the current user's Personal Assistant. Private continuity and user Memory personalize interaction; they do not create a per-user runtime process, agent supply entry or authorization identity. `20260909-thread_visibility_and_sharing.md` owns private conversation and shared Task/Goal disclosure; `20260909-personal_memory_and_knowledge_learning.md` owns User Memory and scoped Knowledge retrieval. The five existing information-source classes remain unchanged: Memory is governed reusable context, and raw personal conversation remains Thread history. Selected Workspace resources are read on demand under current user and output-audience authority.

## Goals / Non-goals

### Goals

- Make the default user entry point fast and low overhead.
- Keep quick replies out of worker scheduling unless delegated work is required.
- Give the Assistant enough governed context to answer simple workspace questions.
- Make every escalation to Task Mode or Goal Mode explicit and explainable.
- Record Assistant replies, clarifying questions, and handoff decisions as normal thread items.

### Non-goals

- Do not let the Assistant run worker agents directly.
- Do not let the Assistant edit files, push commits, call shell commands, browse arbitrarily, or import the entire installed MCP catalog.
- Do not treat Chat Mode as a hidden autonomous workflow.
- Do not let the Assistant write notebook files directly or publish Workspace/Server Knowledge through ordinary conversation. Explicit User Memory commands delegate to the existing Knowledge Store owner.
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
- Every model-backed Assistant answer, including one in Quick Chat, must use the shared Internal Agent Loop and its resolved logical-model context policy; short answers receive no direct-call exception.

## Contract / Expected Behavior

### Assistant Tool Boundary

The ordinary conversational entry path has this complete Core Tool set in stable order. `20260909-internal_agent_resource_integration.md` permits MCP only as a reviewed implementation of an owner-admitted internal capability; it does not append external server Tools to this set:

1. `workspace.state.read`: bounded Workspace/work-state read for the exact selected resource.
2. `thread.history.read`: bounded Thread history beyond the initially admitted range or summary.
3. `knowledge.search`: governed current-scope Knowledge/Memory query through Knowledge Manager.
4. `repository.content.read`: bounded read-only working-directory inspection.
5. `workspace.create`: create the empty project Workspace required by an accepted handoff.
6. `task.start`: explicit Task handoff through its mode owner.
7. `goal.start`: explicit Goal handoff through its mode owner.
8. `memory.page.read`: exact current-user page inspection through the scoped Knowledge owner.
9. `memory.page.create`: explicit user save under the scoped Memory contract.
10. `memory.page.update`: explicit user edit with exact base revision/digest.
11. `memory.page.delete`: exact forget request with the owner's payload-bound human confirmation.
12. `memory.page.propose`: inferred create/replace candidate through the existing proposal owner; never accept a Review.
13. `skill.read`: progressively read an exact selected Skill version and safe relative text file.
14. The exact native Kernel/UI Tool sequence in `20260909-internal_agent_resource_integration.md`.

Core identities map to existing operation schemas/commands; no broad `memory.manage`, model-callable candidate review, arbitrary file-write, Git-write, credential, runtime-management or administration Tool belongs to this entry. Memory operations require a private Thread owned by the current user and preserve the scoped Memory owner's explicit-save, exact-revision, proposal and confirmation rules. In shared Threads they remain present and return a typed private-entry requirement without reading private pages. Human candidate acceptance/rejection stays on the existing product command surface; model confidence, Skill text and MCP responses cannot produce it. MCP-backed implementations retain Core model-facing identity and semantics, with upstream identities only in dispatch/evidence. The current slice admits no production external adapter; no catalog selection may replace Core Memory, history, Knowledge, Kernel/UI or handoff commands.

Rules:

- The Turn carries this entry path's complete fixed Tool set in this stable deterministic order for each bounded run under the same resolved entry configuration, regardless of what the user said.
- Whether the model would call a Tool is a model decision and is not an admission rule.
- Absence from the set is reserved for an operation that is unreachable from this entry path, never for an operation that is merely rare, currently unavailable, unauthorized for this actor, or unnecessary for this message.
- Tool presence is permission to request an operation, never proof that the current actor, source, target, audience, or effect is authorized.
- Every Tool call MUST reauthorize through its current Core owner. A present Tool that cannot currently execute MUST return its product-safe typed refusal reason as a Tool result rather than disappear from the set.
- A request for an operation belonging to another entry path MUST produce a proposed new Thread for that entry path rather than a refusal or an in-place Tool-array change.
- Read-only working-directory inspection must be bounded by workspace root policy, file size limits, path exclusions, and redaction rules.
- Assistant tools must not expose secrets, raw vault material, bearer tokens, provider-native payloads, raw worker checkpoints, or raw `DATA_ROOT` paths.
- Assistant tools must not mutate Workspace files or Workspace/Server Knowledge, Git state, runtime state, Vault records or Policy configuration. The exact Memory operations are the User Memory exception and never expose filesystem writes; automatic capture and delegated notebook maintenance use trusted bounded Knowledge Manager assembly under the scoped learning/notebook owners, not a model-selected filesystem tool. A request for the separate maintenance entry follows the existing explicit entry handoff; the ordinary Assistant Tool set does not expand in place.
- Assistant tool results may be summarized into an assistant message, but restricted evidence must stay behind its owning visibility boundary.

Policy-disabled read-only inspection and currently unavailable handoff operations remain present because their worst case is contained by read-only enforcement, typed refusal, or explicit approval. Tool invocation performs no action when authorization, policy, resource state, dependency availability, or the required user decision is missing.

The Tool set is reconstructed from the server-resolved entry path and its current selected resource configuration for each bounded run and remains pinned through every provider round trip in that run. Retry or restart admits a new Turn from current owners; it does not reuse a message-selected array or treat the previous array as authorization. A mid-conversation pivot to a Tool already in the fixed set needs no array change. A pivot to an administration or other distinct entry path proposes a new Thread whose own entry path has its own complete fixed Tool set.

Acceptance is observable when two ordinary conversational Turns with different messages and the same resolved entry configuration expose the same ordered Tool definitions, a no-Tool answer still exposes that set while calling none of it, a refused present Tool returns a typed Tool result, and a request for another entry path creates a proposed new Thread without mutating the current Turn's set.

### Assistant Information Sources

The Assistant has exactly five semantic information-source classes:

| Source class | Included material | Freshness and persistence rule |
| --- | --- | --- |
| Active Thread history | Durable conversation, accepted user corrections, and decision context from the current Thread. | Use the smallest relevant Item range or a governed source-attributed summary. Durable Thread Items remain truth; a summary is replaced when its source range, authorization, correction, deletion, or retention state makes it stale. |
| Governed Knowledge | Reviewed or directly user-authored reusable understanding eligible for the request and audience. | Query on demand through the Knowledge owner with source, version, scope, freshness, sensitivity, conflict, and exclusion evidence. It is never loaded merely because the Thread belongs to a Workspace. |
| External observation | Current information obtained from an explicitly admitted observation capability. | Retrieve on demand with source identity, observation time, bounds, and provenance. It is untrusted observation, is not promoted into Knowledge automatically, and supplies no instruction or effect authority. |
| Operational context | Current actor-authorized Workspace, Thread, Task, Goal, Worker, readiness, attention, and product-state projections. | Query current read models on demand and retain the observation time and uncertainty. Do not copy complete operational state into a prompt or durable Knowledge. |
| Orchestration interaction | Typed handoff, status request, gate response, promotion, or other coordination result. | Persist through its existing Thread, Item, Task, Goal, gate, command, or audit owner. Hidden role-to-role chat is not an information source. |

The active Thread is the base conversational source. The other four classes are reachable only by an admitted Tool call or an exact typed result supplied by their owner. Bounded configuration, owned Core Tool schema and selected Skill index metadata required to assemble that entry are the sole metadata-only exception; they contain no business data, Skill bodies, Memory, secrets or ambient Workspace history. A selected Workspace is a scope hint that may narrow defaults or disambiguate a reference; it is not ambient context and does not inject Workspace files, Knowledge, business-source catalogs, work history, operational state, credentials, policies, Goal state, Task state, or Worker state beyond that explicit resource metadata exception.

A general question that can be answered from the current input and admitted Thread context MUST complete with no Workspace business-data, Knowledge, Skill-body, operational, external-observation, Goal, Task, or Worker read; only the bounded assembly metadata above may be resolved. Merely including an unused read Tool retrieves no data and creates no source observation.

For each source used, the Turn input retains its owner, selected revision or observation time, provenance, relevant exclusions, and freshness. Missing, stale, conflicting, unauthorized, deleted, or dependency-failed sources are omitted or returned as explicit uncertainty or a typed Tool failure; the Assistant MUST NOT substitute ambient Workspace data, cached provider material, or another source silently.

On retry or restart, NanoCore rebuilds the source selection from current Thread history and current owners. It does not recover source authority from provider memory, a warm connection, an earlier Tool result, or an earlier read permission.

Acceptance is observable when a general question performs no business/source-content read beyond the Thread, Workspace selection alone supplies only bounded assembly metadata, every used source is attributable with freshness, and stale or unavailable source state produces explicit uncertainty or typed failure rather than fabricated or cached fact.

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

Administration is a private, narrowed Personal Assistant Turn, not a separate Agent role or runtime and not an extension of the ordinary conversational Tool set. The server resolves the dedicated administration surface and current actor authority; an ordinary administration request proposes a new private administration Thread. R035 conversation and R048 validated forms use the same configuration/command owners. This section owns the finite initial management contract.

The model cannot supply or widen the administration surface or current actor authority. The administration Turn receives no ordinary conversational observation Tools, so retrieved untrusted material and administration operations do not coexist in one Tool array. Direct edits use validated forms; model-backed administration is for drafting, explanation or diagnosis, and application remains the human-confirmed Core command rather than a model Tool. The finite conversational setup scope below deliberately makes R035 usable without creating another configuration owner.

The initial management entry has one complete fixed ordered semantic Tool set: `administration.configuration.read`, `administration.schema.read`, `administration.configuration.propose`. Inspection returns redacted current configuration, revision, validation/readiness failures and whether a change needs reload or restart. Schema returns the allowed fields and constraints for the exact registered target family. Proposal prepares an exact candidate under the command owner. None executes arbitrary code or publishes a configuration effect. These semantic names project through the existing private Tool contract; no new public Tool registry is implied.

#### Scope and action classes

| Class | Initial actions | Authority and outcome |
| --- | --- | --- |
| Automatic | Read eligible redacted configuration/schema/status; explain an existing validation failure; validate a proposed candidate. | Current resource read authority; bounded observation only. |
| Proposal | Draft create/update for a project Workspace, Provider profile or Worker Agent profile; draft a fix for a validation error; preview changes to existing non-secret resource bindings. | Current target mutation eligibility; candidate bytes, base revision, intended effect and rationale; no application. |
| Approval | Apply the exact confirmed candidate through its existing Core command; perform that owner's ordinary configuration reload where supported. | Current user authority and payload-bound confirmation rechecked at application; record actual command and reload outcome. |
| Prohibited in this entry | Read or generate bearer secrets; author administrator grants or Workspace membership; arbitrary shell/file/Git writes; install Plugin hooks; change Policy or Vault grants; start/stop/restart services; force unknown effects; provision NanoHost/OpenShell; delete a Workspace, Provider or Worker profile. | Typed unavailable/denied result; use the appropriate existing authorized product surface, never a hidden Worker bypass. |

Workspace configuration requires current active membership and its existing operation/Policy checks. Workspace creation follows the existing user-scoped creation owner. Deployment Provider and server Worker configuration require current usable deployment-administrator authority. Workspace-local Worker/profile overrides require Workspace configuration authority; selecting an existing Server resource does not permit changing it. User preference changes target only the current user through their owner. The schema/configuration owner, not the selected Thread's Workspace or model, classifies every field and resource.

Initial create/update scope includes ordinary Workspace name and authored configuration, Provider non-secret profile and logical-model bindings, and Worker profile/runtime/AEP selections admitted by their respective configuration schemas. References must resolve to currently available, authorized resources. Repository or data-source attachment, credential binding and execution-environment setup may be inspected and explained; actual privileged setup, new secret entry and provisioning remain with their existing forms and owning commands. Unsupported fields are rejected rather than written as raw JSONC.

#### Candidate, confirmation and application

Use existing Item-backed human attention and command records. A proposal Item carries target family/id/scope, operation, expected current revision (or verified absence for create), exact normalized candidate, before/after preview, validation results, impact/reload classification, request lineage, and the existing owner command to invoke. It contains no secret, executable expression or model-selected filesystem path. The command owner derives storage targets and permits only its registered schema fields.

Every write receives a confirmation bound to that exact candidate and target. A revised candidate requires new confirmation. The model cannot answer its own gate, and an earlier broad request is not a reusable grant to apply an unseen diff. Where a form submits the same candidate, it uses the same validation, revision and confirmation semantics without invoking a model.

After confirmation, Core rechecks user identity, current token restrictions, target authority, base revision, schema, dependency availability and applicable Policy. It calls the existing target command once with the accepted request identity. The result distinguishes persisted configuration, validated/reloaded configuration, restart-required configuration and failure. A successful file write alone cannot mean the Provider is usable or a Worker can launch; verification returns only the actual readiness evidence obtained.

A management proposal terminates as accepted/applied, rejected, stale, expired or failed through its existing gate/command owner. No management proposal table or private approval lifecycle is added. Exact replay returns the owning command's verified outcome; different input under the request id conflicts. If configuration persisted but reload failed, show both facts, keep the prior running snapshot where the configuration owner prescribes it, and allow an explicitly proposed correction. Do not blindly repeat a write, restart a service, or roll back later user changes. An unknown external result stays unknown and uses the owning inspection/recovery path.

#### Personal scope and audit

This Thread is private to its initiating user under the visibility specification. The Assistant never receives the administrator token secret. NanoCore derives request authority from the authenticated bearer or eligible session and checks it at each effect. Removing a token or membership prevents later application even after approval; a reconnect or provider cache cannot resurrect the grant.

Record current user/responsible actor, target scope, operation, exact change/base identities, confirmation, command, request and outcome through existing AuditEvent/CapabilityCall owners. Redacted configuration effects may be visible to their resource audience; private reasoning/dialogue and credential contents are not audit payloads. Shared cards or summaries do not transfer the originating user's permissions.

#### MCP, Skills and the runtime seam

Internal roles may consume selected Skill context and admitted MCP Tools through trusted entry-path assembly. This is a reusable runtime capability, not permission to expose every installed Plugin to every role. Pin selected resource versions for each admitted run; reassemble only at the safe boundary owned by the internal-runtime contract. Resource text cannot widen the tools, actor, audience or authority. MCP calls use the existing capability Gateway and current effect authorization; Reading a Skill does not execute its scripts. This management entry exposes no shell or Skill-script execution; a procedure requiring such execution must use a separately admitted Worker Task under the existing Task Mode, AgentSession and AEP owners, never trusted NanoCore code.

For the ordinary Assistant entry, `20260909-internal_agent_resource_integration.md` owns internal-capability admission, selected Skill context, frozen assembly, internal MCP lineage, approval interruption and native Kernel/UI projection. MCP adapter eligibility requires an exact accepted internal contract and reviewed implementation; the former generic read-adapter permission is not a production adapter profile. It does not import arbitrary server schemas, allow message-selected admission or replace Core commands. Resource metadata is not authority. A required MCP approval stops the bounded run and publishes the exact existing Gate; neither the model nor a generic loop state owns its continuation.

The management entry remains exactly the three Core-backed Tools above, with no third-party MCP or Skill body in its model context. It may inspect allowed redacted resource-selection configuration and propose a revision through the existing configuration owner, but cannot activate a stdio server or change its own admitted Tool array. Personalization influences explanations, not management Policy.

Management acceptance requires an ordinary member to configure an eligible Workspace while being denied deployment Provider mutation; an administrator may configure a Provider without exposing a token to the model. A user who did not develop OpenKit must complete ordinary Workspace/Provider/Worker-profile setup through conversation and the existing secret/setup forms, observe actual validation and readiness evidence, and never edit server files manually. Model and form paths must produce the same admitted configuration and audit result. Stale revisions, revoked credentials, changed candidates and unsupported fields cause no new write; retry must not repeat an uncertain effect. Private management and shared-resource effect audit retain their separate audiences.

The concrete conversational management integration is Not Started. The existing role runtime and configuration owner are dependencies, not evidence that R035 already works.

### Routing outcomes

The Assistant must produce exactly one routing outcome:

- `answered`: the Assistant returned a direct response.
- `clarification-needed`: the Assistant asked a bounded question and the turn waits for user input.
- `approval-required`: an exact governed Tool effect awaits the existing human Approval Gate, with no upstream contact; this is not an elicitation question.
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

NanoCore looks up that command identity before resolving a current mutable projection or invoking Coordinator or a provider. Once a completed command record or complete deterministic result tuple exists, the same identity and input MUST replay the original `answered`, `clarification-needed`, `approval-required`, `task-handoff`, `goal-handoff`, or `refused` lineage and MUST NOT invoke a provider, create another Turn or Item, open another gate, start another worker, create another Goal, or enqueue another scheduler admission. Reusing the identity with different caller input returns `409 idempotency_key_conflict` before effects.

Chat-owned Turn and Item identifiers and handoff status identifiers derive deterministically from the immutable command scope and request id. The completed command record is published only after one complete owner tuple is durable: an answered or refused terminal Chat Turn with its user Item and exact result Item; a clarification Turn at `awaiting_human` with the exact `user-input-request` Item and matching human gate; an approval Turn at `awaiting_human` with its exact approval-request Item, Approval and no-contact denied call; a complete Task handoff tuple; or a complete Goal handoff tuple. Clarification and approval tuples are acknowledged command results even though the Turn is nonterminal, so replay returns that gate and never opens another one. An approval result requires the exact completed approval-request Item, pending Approval and denied no-contact CapabilityCall plus the stopped internal run; publish the invoking input command receipt (`conversation.submit` or the current `turn.input.submit`) only after those facts hold. The receipt is the durable proof that this internal invocation has returned, and a missing receipt leaves that Gate inspect-only recovery-required. No new internal-run record is introduced. If no deterministic Chat or handoff owner is durable, the same command may perform its first attempt. A handled failure leaves either no tuple or one terminal failed Chat tuple. If only part of a tuple is durable, inspection and exact replay return `recovery_required`; they do not rerun the provider, complete the missing business write by inference, or start the handoff again. A user-requested new attempt after a terminal failure uses a new `requestId`; no command reservation state, Chat settlement workflow, or recovery lifecycle is introduced.

For `task-handoff` and `goal-handoff`, the initiating `conversation.submit` command is the only command-ledger owner. It calls the Task or Goal mode service with the immutable outer command scope and causation, and that service creates the deterministic downstream Thread, Turn, Goal, Item, checkpoint, and scheduler tuple without publishing a second `task.start` or `goal.start` receipt. Direct public Task or Goal requests retain their own command identity. A half-state is therefore evaluated against one outer receipt and one downstream business tuple, not two nested command records.

An Assistant-targeted conversation command may publish `task-handoff` or `goal-handoff` only after the complete downstream tuple is durable. If the downstream mode rejects before accepting a command or effect, the Assistant must complete the same Turn as `clarification-needed` when one bounded answer can make the request executable or as `refused` otherwise; it MUST NOT publish a handoff Item or receipt that names nonexistent downstream work.

When the owning Workspace is Quick Chat and the Assistant selects `task-handoff` or `goal-handoff`, the project-eligibility guard keeps Quick Chat ineligible and resolves or proposes an eligible executing Workspace inside the one handoff confirmation. An accepted confirmation creates or selects that Workspace and creates the downstream execution Thread there while the originating Quick Chat Thread retains the handoff Item and causation. Only when exact Workspace resolution or creation authority is unavailable does the conversation command complete with a durable refusal Item naming that missing authorization; no Task, Goal, Worker Turn, checkpoint, or scheduler admission exists in that refusal case.

The exact `turn.input.submit` command owns continuation of an Assistant clarification. After validating the active gate, it stores the matching response Item and returns the same Assistant Turn to `running`, then invokes the same bounded decision path over the original input plus that response. Its accepted result is one answer, refusal, handoff, replacement clarification or approval-required tuple in the same Turn. The input command acknowledges only after that tuple is durable; identical replay returns it, changed answers conflict, and a response/outcome half-state returns `recovery_required`. It does not resume a worker AgentSession or require a second `conversation.submit` request. When this invocation reaches an Approval Gate, its own input-command receipt acknowledges the exact approval-required tuple only after the new bounded run returns. That receipt, identified by the Gate/request causation, supplies stop proof; the original conversation receipt remains clarification-needed and is never rewritten. Replay of each input command reconstructs its own acknowledged tuple without starting another run.

An Assistant Approval Gate is answered through the approval response command, never `turn.input.submit`. That command verifies the exact actionable tuple and current responsible user, records grant/deny, and closes the waiting source Turn through the Human Attention owner. It invokes no model or Tool. A separately requested new Assistant Turn may claim an exact granted effect once under `20260909-internal_agent_resource_integration.md`; the original conversation command always replays its historical gate result. Clarification retains the existing same-Turn elicitation continuation and is not changed into approval.

### Usage and audit

- Assistant LLM calls must emit durable `CapabilityCall` and `UsageRecord` rows once the shared capability usage foundation is implemented.
- Tool reads that touch privileged workspace state must be auditable at the appropriate level of detail without storing secret values or unrestricted file contents.

### Command receipt authority

The Assistant branch of `conversation.submit` is the narrow multi-owner exception to current-resource replay because a clarification or approval Item and its Turn may advance after the original command was accepted. Its command receipt MAY retain only `resultKind`, the accepted HTTP success status, and the stable downstream Task Thread and Turn or Goal and Goal Turn identifiers required by a handoff. The normal receipt resource identifier names the original Assistant Turn. NanoCore derives the initiating user Item and result Item identifiers from that Turn identifier and the closed `resultKind` mapping, which distinguishes knowledge, repository, or provider answers, clarification, approval-required, Task handoff, Goal handoff, and refusal. The receipt MUST NOT contain Item identifiers that are already derivable, the prompt, explanation text, Turn or Item bodies, assistant content, Coordinator output, provider output, or a full response body.

Replay reconstructs the original accepted Chat projection from durable owners. It reads the first durable revisions of the initiating user Item and result Item, derives the accepted Turn status, timestamps, duration, and human gate from those Items and `resultKind`, derives fixed explanations from `resultKind` or the result status Item, and validates every derived or stored identifier against the receipt Workspace, Thread, and Turn. A terminal result additionally requires the current Turn to remain completed with the same completion timestamp; a clarification or approval may replay its original accepted gate after the current Item and Turn legitimately advance. Approval replay derives the exact request Item and Approval identity from the original Turn/result kind, links the actual invoking input command through request causation, verifies its first acknowledged revision and linked no-contact denied call, and returns that original approval-required result without authorizing another effect. A Task handoff also requires the named downstream Turn; a Goal handoff requires the named Goal, its completed creation Item, and completed Goal Turn lineage. Missing, malformed, wrong-kind, or contradictory owners return `409 recovery_required`. The receipt is evidence only and cannot mutate a Turn, Item, Goal, checkpoint, scheduler admission, or provider lifecycle.

This bounded receipt does not solve a crash before receipt publication. Deterministic request-derived owner identities and the existing downstream business owners must address that half-state later; the implementation MUST NOT add a Chat reservation, settlement, recovery workflow, or private lifecycle to compensate.

### Provider and persistence failure

The provider response is not an `answered` Chat Mode outcome until the same Thread owns a durable Turn, its user-message Item, its assistant-message Item, and terminal completed status. The deterministic Turn and initiating user Item MUST be durable before provider dispatch; they are the ordinary narrative owner proving that this Chat attempt began, not a separate reservation. Failure before that pair leaves no Chat records.

An owner-confirmed approval abort is mapped to the exact approval-required tuple above, not provider failure. Otherwise, after that pair is durable, provider rate limit, request failure, timeout, caller abort, or invalid content MUST terminalize the same Turn with the exact `provider_rate_limited`, `provider_request_failed`, `provider_call_timeout`, `provider_call_aborted`, or `provider_response_invalid` code defined by S05. Caller abort makes the Turn `interrupted`, and the existing `provider_call_aborted` code preserves the cause; the other provider failures make it `failed`. The command receipt preserves that typed failure lineage, exact replay does not redispatch, and failure to persist the required terminal tuple returns `recovery_required`.

`chat_mode_persistence_failed` is reserved for a valid provider response whose assistant Item and completed Turn tuple could not be committed. The implementation MUST terminalize the same Turn as failed when that deterministic failure tuple can be written; it MUST NOT redispatch the provider under the same request, publish a completed assistant Item, or claim `answered`. A partial or contradictory assistant/Turn tuple, or failure to persist terminalization, returns `recovery_required`. The bounded availability compromise is that the user must use a new request id for another provider attempt rather than adding a settlement owner.

Chat Mode does not resume the provider invocation after process failure. The caller reads the command and Thread state; replay of a completed request returns the original lineage, a started but incomplete provider attempt returns its terminal failure or `recovery_required`, and a user-requested new attempt uses a new request id and creates a new provider invocation. This deliberately favors no hidden duplicate call over automatic recovery and is not authorization for a Chat settlement or recovery workflow.

## Accepted Design

NanoCore implements Core Assistant as one role assembly over the bounded internal Agent runtime owned by `docs/specs/20260813-internal_agent_runtime.md`. The Assistant supplies its role prompt, bounded current Thread input, entry-path-fixed Core Tools and selected Skill metadata (including exact personal Memory operations), request-scoped sources, and output audience; the generic loop supplies no Assistant authority or product lifecycle.

The Assistant remains app-local in `apps/nanocore`, owns no private execution lifecycle, and must not introduce a second loop, registry, event protocol, hook framework, or multi-agent framework for this role.

## Current Implementation Projection

NanoCore exposes the Assistant as one target of `GET /api/app/workspaces/:workspaceId/conversation-targets` and `POST /api/app/workspaces/:workspaceId/threads/:threadId/conversation-turns`. `@openkit/app-api-schemas` owns the strict shared conversation contracts, `@openkit/core-client` exposes `client.app.getConversationTargets` and `client.app.submitConversation`, and the retired `StartChatMode*`, `client.app.startChatMode`, `/chat` App route, and `chat.start` operation have no compatibility surface.

The route records one user-message item plus either a direct `assistant-message` answer, an item-backed `user-input-request` clarification gate, or an item-backed `status` handoff projection. Clearly vague requests such as bare "Help", "Can you help with this?", or "What should I do?" create a bounded clarification question, mark the turn `awaiting_human`, and surface the question through the existing Action Center protocol-item projection without calling Quick Chat or starting a worker. Direct answers first consult Knowledge Manager for source-traceable workspace knowledge and return a knowledge-backed assistant message when matching accepted knowledge exists. Narrow linked-repository inspection questions then use read-only working-directory inspection when `workspace.assistant.repositoryInspection.enabled` is not `false`: NanoCore reads only the default linked repository root entries, one safe repository-relative directory named in the prompt, or one explicitly named safe text file. Directory listings skip hidden entries such as `.git`, apply exact-or-prefix `excludedPaths`, and return redacted names without absolute paths. File reads refuse hidden path segments, dot-segment traversal, policy-excluded paths, unsupported file extensions, files over the bounded preview size, and binary-looking content; the answer includes only a redacted preview and never an absolute local path. Repository inspection records an `assistant.repository.read` capability call and finish audit row with `repository.root_list`, `repository.directory_list`, or `repository.file_read`, and it does not recurse, call shell, mutate files, or start a worker. Mutating repository or file requests such as delete/remove are classified as bounded delegated work before repository inspection, so they create a visible Task Mode handoff instead of using the Assistant's read-only file preview path. If Knowledge Manager and bounded repository inspection return insufficient evidence, the accepted design routes the provider-backed answer through the shared Internal Agent Loop with the Assistant's fixed role assembly and no Assistant-specific runtime, registry, hook chain, or event stream; provider/model resolution, context management, Gateway dispatch, cache scope, cancellation, timeout, output validation, redaction, and the shared LLM usage recorder remain with their existing owners. The current implementation still calls the concrete bounded `callQuickChatProvider` function directly, which is a known divergence to delete when the shared loop is implemented. Provider-backed fallback calls emit `inference.local.quick_chat` capability and usage rows with Workspace, request, Thread, and Turn lineage when durable storage is available. Requests classified as bounded worker work create a `task-handoff` status Item and start one bounded Task Mode attempt through the same Workflow Coordinator, durable scheduler, worker startup, AEP, repository workspace, sourceRef, and Turn evidence path as the public Task Mode route. Requests classified as longer-running planning work create a durable Goal Mode objective through the same Goal Mode service, then create a `goal-handoff` status Item without starting a worker Turn. Unsupported Coordinator decisions create a refused status projection.

Historical deterministic L6 evidence covered the accepted V1 Assistant backbone: a knowledge-backed direct answer with source evidence, a bounded clarification gate projected into Action Center, linked-repository file-list and file-read answers from read-only inspection, a visible Task Mode handoff that starts bounded worker progress through Workflow Coordinator, and a visible Goal Mode handoff that creates a durable goal. The retired MCP-only and `chat.start` stories are not active release gates; current L1 and L3 unified-route coverage proves that a mutating repository-file request is not answered by the read-only repository inspection tool and does not create an `assistant.repository.read` capability row.

The accepted Assistant routing and projection path is implemented behind `conversation.submit`. Explicit external search or browsing requests remain refused until a separate accepted external-search capability exists. The strict request requires `requestId`, the Core Client generates one when omitted, and NanoCore stores only bounded branch metadata plus downstream owner identifiers. Identical replay reconstructs from canonical Thread, Turn, Item, Task, and Goal owners without rerunning Coordinator, Provider, worker launch, or Goal creation; missing or contradictory owners return `409 recovery_required`. This specification remains `Partial`: private project visibility, personal Memory operations, conversational management and trusted selected MCP/Skill assembly remain unimplemented alongside the named recovery and external-capability gaps. The retired Chat-specific transport is not an implementation gap.

## Alternatives Considered

- Let Chat Mode directly start worker agents. Rejected: it collapses Assistant and Coordinator responsibilities and hides delegated work from the workflow model.
- Make every user request go through Goal Mode. Rejected: it adds planning overhead to simple questions and makes the product feel slow.
- Give Assistant the full worker MCP tool catalog. Rejected: owned internal capability contracts provide the required functionality without importing arbitrary MCP schemas; arbitrary code and long-running work retain the Worker path.

## Consequences

- Users get a fast entry point without losing the ability to escalate into tracked work.
- The Assistant is an explicit Internal Core Role with one small role assembly over the accepted generic internal Agent runtime.
- Some requests will require visible handoff instead of a direct answer; this is intentional and keeps work traceable.

## Testing Strategy / Acceptance Criteria

- L1: routing classification tests for answer, clarify, approval-required, Task handoff, Goal handoff, and refusal.
- L3: direct conversation and clarification-continuation MCP approvals acknowledge their own invoking command receipts after loop exit; original clarification replay stays unchanged, incomplete tuples remain inspect-only, and grant invokes no provider.
- L1: typed provider and persistence error tests proving system failure never returns a success-shaped routing outcome.
- L1: schema tests requiring `requestId` and rejecting changed input under a reused id.
- L1: tool-boundary tests proving disallowed file writes, shell, direct worker calls, unadmitted MCP calls, and secret reads cannot be requested through Assistant tools.
- L2: contract tests for item projection and handoff record shape.
- L3: NanoCore black-box tests for a direct answer, a clarification gate, a Task Mode handoff, a Goal Mode handoff, exact provider-error mapping, and post-provider persistence failure with no false `answered` outcome.
- L3: same-id replay for every successful routing outcome returns the original Chat, Task-handoff, or Goal-handoff owner tuple without duplicate provider, gate, worker, Goal, admission, or usage effects; changed input returns `idempotency_key_conflict` before effects.
- L3: a user-requested retry after a failed provider or persistence attempt uses a new request id, is visibly a new invocation, and does not resume hidden Chat state.
- L6: story acceptance where a user asks a simple workspace question and gets an immediate answer, then asks for a larger change and sees a visible handoff to tracked work.

Acceptance: Assistant never directly starts a worker, never mutates arbitrary files or Workspace/Server Knowledge, emits visible thread history, and routes non-trivial work to Workflow Coordinator.

Acceptance also requires identical ordered ordinary-entry Tool definitions across message classes under the same resolved configuration, metadata-only assembly with zero ambient business or operational reads for a general question, current per-call authorization and publication guarding, reconstructible continuity, a separate propose-only administration Thread, and a Quick Chat work request that reaches one confirmed executing Workspace and Task or Goal or leaves an exact durable missing-authorization refusal.

## Risks & Mitigations

- Risk: Assistant over-answers tasks that should be delegated. Mitigation: conservative routing tests and explicit handoff outcomes.
- Risk: read-only working-directory access leaks sensitive files. Mitigation: workspace policy can disable repository inspection or exclude sensitive path prefixes, and the implemented reader uses hidden-path refusal, traversal refusal, extension limits, size limits, binary checks, and redaction before returning previews.
- Risk: Chat Mode becomes another workflow engine. Mitigation: Assistant performs bounded admitted calls and leaves execution, gates and durable effects with existing owners.

## Resolved Decisions

Previously open questions are resolved by accepted V1 defaults: Assistant read-only working-directory inspection starts with linked-repository root file names, one safe repository-relative directory listing, and one explicitly named safe repository-relative text-file preview. It skips or refuses hidden entries such as `.git`, applies workspace-configured exact-or-prefix `excludedPaths`, returns no absolute paths, does not recurse, and broadens only after stronger path filters, size limits, redaction, and audit linkage are proven; Chat-to-Task and Chat-to-Goal handoff is represented as an App API projection over a status item, not a dedicated protocol item type.

## Deferred / Future Work

- Rich UI for Assistant routing explanations.

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
