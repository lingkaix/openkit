---
status: Accepted
updated: "2026-10-15"
implementation: Partial
kind: concept
---
# Chat Mode And Core Assistant

## Worker Environment Operations

The private administration entry may prepare and apply an exact Worker environment change under [Persistent Worker Volumes](20260910-persistent_worker_volumes.md), using the same current-authority, candidate/base revision, payload-bound confirmation and owned command paths as Desktop Skill operation. It may propose a Dockerfile/image declaration and inspect build/attachment results; the existing NanoHost image owner executes the build. Preparation does not activate an image or interrupt work. Activation previews the affected sharing group, drains or explicitly interrupts its writers, retains volumes and admits new execution only after checks. This narrow owned operation amends the earlier setup-inspection-only restriction; it grants no internal shell, Docker socket, arbitrary host file operation, service restart or privilege escalation.

## Owns

- Chat Mode as the lightweight user interaction path before delegated worker work starts.
- The Core Assistant role contract for quick replies, clarification, simple workspace state lookup, and routing triage.
- The Assistant's ordinary conversational entry path and its complete fixed Tool set: bounded Workspace state reads, Knowledge Manager query, personal Memory commands, Workspace creation, and Task or Goal handoff. Repository inspection uses a selected Gateway vendor MCP read tool or a Task handoff.
- The Assistant information-source model, request-scoped read selection, output-audience projection, and continuity precedence.
- The narrowed administration entry path that reuses the Assistant role without mixing administration Tools into ordinary conversation.
- The handoff contract from Assistant to Task through Workflow Coordinator, and to a Goal through the Goal owner's create operation.
- Thread and item projection rules for Assistant replies and handoff decisions.
- Assistant-branch result ownership, exact replay, and conflict behavior across every routing outcome.

## Does Not Own

- Task Mode worker delegation. `docs/specs/20260704-task_mode_worker_delegation.md` owns that path.
- The Goal, its cards, its Plan versions, and the Coordinator role. `docs/specs/20261002-goal.md` owns that path. Chat calls create Goal for a handoff and may call the same intent and card operations when the user delegates that work.
- Workflow Coordinator internals. `docs/specs/20260704-workflow_coordinator_internal_agent.md` owns the reusable coordinator role.
- Knowledge Store format, retrieval governance, or Knowledge Manager maintenance loops. Those are owned by `docs/core/knowledge.md`, `docs/specs/20260702-knowledge_store_governance_rules.md`, `docs/specs/20260703-knowledge_store_implementation.md`, and `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md`.
- A general web search, browser, shell, filesystem write, MCP tool, or worker execution capability for the Assistant.
- Direct provider error codes, redaction, and retry semantics. `docs/specs/20260531-worker_turn_reliability_envelope.md` owns that exact call-boundary contract.
- The generic internal Agent loop or Tool contract. `docs/specs/20260813-internal_agent_runtime.md` owns those mechanisms; this specification owns only the Assistant role assembly projected onto them.
- The shared durable rolling context mechanism. [Context Management](20260902-agent_runtime_context_compaction.md#internal-durable-rolling-context) owns it; this specification binds Assistant context to its private Timeline or shared conversation.
- Permission evaluation or disclosure authorization. `docs/core/permissions.md` owns `AssistantReadScope`, `OutputAudience`, per-call authorization, approval strength, and the publication guard; this specification narrows and projects those decisions for Assistant Turns. When an administration resource family is cut over, the per-call administrator check is invocation's, as Derived internal tools states, and this specification still keeps revocation and provenance.
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

The Assistant may answer directly only when the request fits its limited role boundary. Exact governed personal Memory, Kernel, UI and owner-admitted MCP-backed internal operations may execute through their existing owners as defined below. Requests requiring long-running execution, arbitrary file edits, unadmitted external capabilities, broad repository analysis or multi-step Worker planning require explicit handoff through the owning Task or Goal path. Repository code inspection uses a selected Gateway vendor MCP read tool or a Task and does not read a NanoCore host checkout. The user-facing transition from Chat Mode to Task Mode or Goal Mode must be visible in Thread history.

## Personal Assistant And Visibility

Core Assistant is presented as the current user's Personal Assistant. Private continuity and user Memory personalize interaction; they do not create a per-user runtime process, agent supply entry or authorization identity. `20260909-thread_visibility_and_sharing.md` owns private conversation and shared Task/Goal disclosure; `20260909-personal_memory_and_knowledge_learning.md` owns User Memory and scoped Knowledge retrieval. The five existing information-source classes remain unchanged: Memory is governed reusable context, and raw personal conversation remains Thread history. Selected Workspace resources are read on demand under current user and output-audience authority.

### Private Timeline and response triggering

Each `(User, Workspace)` has exactly one private Assistant Timeline. It uses the existing Thread, Turn, and Item owners, not a second conversation store. Users cannot create additional private chat Threads. The separate private administration entry retains its own fixed Tool set and current administrator checks; it is not another ordinary Assistant Timeline. These are the [accepted Chat Mode rulings](../decisions/20261015-private_assistant_timeline_and_rolling_context.md).

Private `thread.create` opens the current User's Timeline in the selected Workspace. It creates the first private conversation when none exists; a different command then returns the same Thread without renaming or reopening it. The existing command owner still rejects changed input under the same request identity. Selection derives from canonical private conversation Threads, ordered by creation time and then exact Thread id. Administration and Workspace-shared work are excluded. No durable pointer or parallel history is added.

For retained Workspaces with several earlier private conversations, the earliest is the continuing Timeline. Other retained Threads keep their identities, Items and references as readable history; a fresh ordinary Assistant submission uses the Timeline. A completed historical command remains replayable on its original Thread. An archived Timeline stays archived until an explicit `thread.update` reopens it; opening the Timeline does not create a replacement or revive it implicitly. Workspace and Thread access checks still apply before creation, reads, submission and publication.

The default personal Workspace is an ordinary `personal` Workspace with Task, Goal, Artifact, and Sandbox capability. It cannot add members. Memory exists only in User scope and follows the User; Workspace and Server personalization stays in Knowledge. Workspace selection grants no ambient source access. The private administration entry moves to the personal Workspace without gaining ordinary conversational Tools.

The Assistant responds to user-triggered requests. Dispatching a Task or Goal creates no separate result-card mechanism and no proactive completion reply. The Thread list exposes the related work. When the User asks for status or results, the Assistant queries the existing work owner and answers through ordinary Items. Existing pending-request outcome delivery remains governed by Pending Requests; it is not a proactive result-card channel.

### Shared conversations after v0.1.0

Shared conversation implementation waits until after `v0.1.0` and the private Timeline, under [Shared Conversations And Single-Agent Chat Threads](../decisions/20261015-shared_conversation_and_single_agent_threads.md). Team Workspace members may then create a Workspace-shared Chat Thread directly, without first publishing a private snapshot. Personal Workspaces cannot provide this shared conversation.

The Core Assistant is the only agent in every private or shared Chat Thread. In a shared conversation, it acts as a Workspace role. It reads no participant's Memory or private Timeline and exposes no administration Tools. Each shared conversation has its own rolling context window. Knowledge and history sources must be eligible for the whole current output audience. The addressing member is the Actor for that Turn and every Tool call or handoff; another participant's prior authority grants nothing.

The Assistant replies only when a member addresses it. One Turn per Thread applies; simultaneous requests queue. A shared query trace belongs to its querying shared Turn, or its Thread when no Turn exists, and remains visible only to that audience. It never enters a participant's private Timeline. Explicit `thread.share` publishes only its selected private snapshot through the sharing owner.

Addressing a Worker from Chat requires a confirmed Task handoff that creates a linked Task execution Thread. The Worker does not join Chat. Task and Goal execution Threads retain their Workspace-shared audience and existing AgentSession continuity. Multi-agent work uses Goal Mode under the Coordinator and an approved Plan. Ordinary Items show work state and results without a special result-card channel.

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
- Every model-backed Assistant answer, including one in a personal Workspace, uses the shared Internal Agent Loop and its durable rolling context; short answers receive no direct-call exception.

## Contract / Expected Behavior

### Derived internal tools

Until a resource family is cut over, the fixed Tool sets and the per-call checks in this specification remain that family's contract.

When that resource family is cut over, the accepted target applies. Internal Tools are derived from the definitions and execute through invocation. [Operation Definition](20261002-operation_definition.md) owns that mechanism. This specification does not restate it. Trusted entry assembly keeps the ordinary entry and the administration entry, their immutable ordered selections, and the separation of those two Tool sets. Administration Tools move their per-call administrator check into invocation. `docs/core/permissions.md` remains the authority for what administrator authority means. This specification keeps revocation and provenance. Loss of the current authority required for the effect prevents a later effect. Membership loss alone does not remove eligibility supplied by a currently usable administrator credential under [Core Permissions](../core/permissions.md#administrator-eligibility). The audit record still names the current user, the target, the operation, and the outcome. Model-facing schemas omit bound fields, and a conflicting argument is rejected before any effect, under the same definition.

### Assistant Tool Boundary

The ordinary Assistant and Administration entry paths use the centralized fixed prompt source and fixed-text limit owned by [Internal Agent Runtime](20260813-internal_agent_runtime.md#prompt-contract), including any direct provider-call implementation. Dynamic context does not carry additional fixed role instructions.

The ordinary conversational entry path has this complete Core Tool set in stable order. Separately selected Gateway vendor MCP repository read tools are admitted by the repository-inspection rule below and do not replace or reorder the Core set. MCP implementations of Core capabilities remain subject to the reviewed-adapter rules in `20260909-internal_agent_resource_integration.md`.

1. `workspace.state.read`: bounded Workspace/work-state read for the exact selected resource.
2. `thread.history.read`: bounded authorized Item search through the conversation-history adapter, including eligible past Threads in the current Workspace.
3. `knowledge.search`: governed current-scope Knowledge/Memory query through Knowledge Manager.
4. `workspace.create`: create the empty project Workspace required by an accepted handoff.
5. `task.start`: explicit Task handoff through its mode owner.
6. Goal create, revise intent, and card operations: the same operations the Coordinator calls, used when the handoff creates a Goal or when the user delegates that work.
7. `memory.page.read`: exact current-user page inspection through the scoped Knowledge owner.
8. `memory.page.create`: explicit user save under the scoped Memory contract.
9. `memory.page.update`: explicit user edit with exact base revision/digest.
10. `memory.page.delete`: exact forget request with the owner's payload-bound human confirmation.
11. `memory.page.propose`: inferred create/replace candidate through the existing proposal owner; never accept a Review.
12. `skill.read`: progressively read an exact selected Skill version and safe relative text file.
13. The exact native Kernel/UI Tool sequence in `20260909-internal_agent_resource_integration.md`.

Repository code inspection is not a Core tool in this set. The Assistant inspects repository code through a selected Gateway vendor MCP read tool under [Worker MCP Tool Supply](20260704-worker_mcp_tool_supply.md), or by handing the work to a Task. NanoCore reads no host repository for that inspection. A vendor read tool does not replace or reorder this Core set.

Until a resource family is cut over, Core identities map to existing operation schemas and commands. When the family is cut over, those Tools follow Derived internal tools. No broad `memory.manage`, model-callable candidate review, arbitrary file-write, Git-write, credential, runtime-management or administration Tool belongs to this entry. Memory operations require a private Thread owned by the current user and preserve the scoped Memory owner's explicit-save, exact-revision, proposal and confirmation rules. In shared Threads they remain present and return a typed private-entry requirement without reading private pages. Human candidate acceptance/rejection stays on the existing product command surface; model confidence, Skill text and MCP responses cannot produce it. MCP implementations of Core capabilities retain Core model-facing identity and semantics, with upstream identities only in dispatch/evidence. Selected vendor repository read tools retain their vendor schema and Gateway ownership; they create no Core repository operation or Git-specific adapter. No catalog selection may replace Core Memory, history, Knowledge, Kernel/UI or handoff commands. Production support for the vendor-read path is reported separately in Current Implementation Projection.

Rules:

- The Turn carries this entry path's complete fixed Tool set in this stable deterministic order for each bounded run under the same resolved entry configuration, regardless of what the user said.
- Whether the model would call a Tool is a model decision and is not an admission rule.
- Absence from the set is reserved for an operation that is unreachable from this entry path, never for an operation that is merely rare, currently unavailable, unauthorized for this actor, or unnecessary for this message.
- Tool presence is permission to request an operation, never proof that the current actor, source, target, audience, or effect is authorized.
- Every Tool call MUST reauthorize through its current Core owner. For a cut-over administration Tool, the per-call administrator check in that reauthorization is invocation's, under Derived internal tools. Publication guarding and the other owner rechecks stay. A present Tool that cannot currently execute MUST return its product-safe typed refusal reason as a Tool result rather than disappear from the set.
- A request for an operation belonging to another entry path MUST produce a proposed new Thread for that entry path rather than a refusal or an in-place Tool-array change.
- Repository code inspection uses a selected Gateway vendor MCP read tool or a Task. The retired host reader's workspace-root, file-size, path-exclusion, and hidden-path bounds end with that reader. The MCP owner bounds the vendor read call.
- Assistant tools must not expose secrets, raw vault material, bearer tokens, provider-native payloads, raw worker checkpoints, or raw `DATA_ROOT` paths.
- Assistant tools must not mutate Workspace files or Workspace/Server Knowledge, Git state, runtime state, Vault records or Policy configuration. The exact Memory operations are the User Memory exception and never expose filesystem writes; automatic capture and delegated notebook maintenance use trusted bounded Knowledge Manager assembly under the scoped learning/notebook owners, not a model-selected filesystem tool. A request for the separate maintenance entry follows the existing explicit entry handoff; the ordinary Assistant Tool set does not expand in place.
- Assistant tool results may be summarized into an assistant message, but restricted evidence must stay behind its owning visibility boundary.

Currently unavailable handoff operations remain present and return a typed refusal. The retired host repository reader is not kept in this Tool set. Tool invocation performs no action when authorization, policy, resource state, dependency availability, or the required user decision is missing.

The Tool set is reconstructed from the server-resolved entry path and its current selected resource configuration for each bounded run and remains pinned through every provider round trip in that run. Retry or restart admits a new Turn from current owners; it does not reuse a message-selected array or treat the previous array as authorization. A mid-conversation pivot to a Tool already in the fixed set needs no array change. A pivot to an administration or other distinct entry path proposes a new Thread whose own entry path has its own complete fixed Tool set.

Acceptance is observable when two ordinary conversational Turns with different messages and the same resolved entry configuration expose the same ordered Tool definitions, a no-Tool answer still exposes that set while calling none of it, a refused present Tool returns a typed Tool result, and a request for another entry path creates a proposed new Thread without mutating the current Turn's set.

### Assistant history Tool

`thread.history.read` retains its Core Tool identity and binds its effect to the [Retrieval Kernel conversation-history adapter](20261014-retrieval_kernel.md#source-adapter-registry). It searches retained user-visible Items beyond the active context window, including eligible past Threads in the current Workspace. It creates no second history store or operation identity ([accepted binding](../decisions/20261015-assistant_history_tool_binding.md)).

Eligible Threads are those the addressing User can read now under current Thread visibility. That User's private Assistant Timeline is eligible for that User only. Another User's private Timeline is never eligible. This Tool admits no administrator override and no cross-Workspace reach. Trusted assembly binds the User, Workspace, querying Thread, and Turn; model input cannot replace those bindings.

Source and output-audience checks run at query time and again when the result is shown. A readable source does not authorize disclosure to a broader audience. Revocation, deletion, changed source revisions, or changed audience must withhold affected content and references. Missing or contradictory authority fails closed; cached index eligibility never authorizes a result.

The same `thread.history.read` Tool accepts either text search or an exact range read. A range names the source Thread, first and last Item ids and the aggregate source digest supplied by a summary. The containing Workspace and current actor remain server-bound. A returned Item has a qualified reference, revision and full-body digest, bounded text bytes, start/end byte offsets and an optional next cursor. Continue with that cursor to retrieve a large Item or the remaining range without lost or repeated bytes. Range validation covers unread Items too, so a source change before later dispatch or publication withholds the old result. Control and effect Items are inert canonical observations; hidden reasoning and unaccepted partial message text are excluded.

Results are bounded in count and bytes. Each hit carries qualified Workspace, Thread, Turn, and Item references plus the source revision or digest. The adapter retains its exclusions for hidden reasoning, credentials, raw Provider payloads, and unadmitted diagnostics. Neither snippets nor qualified references may reveal an ineligible source. Incomplete or stale results retain the Retrieval Kernel's completeness and uncertainty semantics; an empty incomplete result cannot prove absence.

For search, the history Tool accepts only `query`, `mode` (`lexical`, `exact`, or `regex`) and `limit`; the exact-range alternative is defined above. The query is at most 4096 characters and the result admits at most 20 hits, defaulting to five. Each snippet is a preview of at most 4096 UTF-8 bytes. The complete serialized model Tool result, including its text envelope and qualified trace reference, is at most 64 KiB. Omitting hits to meet that bound sets `complete: false`; a preview never claims to contain the complete source Item. Trusted assembly binds all source and querying coordinates. The conversation variant uses the existing query-owned trace file and publisher, with source kind, query context, request digest, normalized mode/limit, selected qualified references and revision/digests, completeness and timestamp. It contains no query or source text. Portability verifies exact canonical Items and remints their coordinates and revision digests through the existing import owner.

A query inside a Turn publishes one write-once, content-free trace on that querying Turn under the accepted Retrieval Kernel trace rule. The trace retains qualified references and selection evidence, never query text, source text, snippets, or matched terms. Trace access rechecks current containing-record and source audiences. This Tool adds no durable record beyond that trace and the existing owned Items. A missing required trace cannot be hidden by omitting known Turn lineage. Restart rebuilds derived search state from canonical Items and current visibility; retry never reuses a prior read as authority.

Acceptance covers retrieval from another eligible past Thread and outside the context window, current-User private Timeline access, denial of another User's Timeline, and no administrator or cross-Workspace bypass. It also covers count/byte bounds, qualified references, one immutable content-free trace per Turn query, and revocation between query and display. Hidden reasoning, credentials, raw Provider payloads, and unadmitted diagnostics remain absent from results and traces.

### Assistant Information Sources

The Assistant has exactly five semantic information-source classes:

| Source class | Included material | Freshness and persistence rule |
| --- | --- | --- |
| Thread history | Durable conversation, accepted user corrections, and decision context from the active Thread; eligible past-Thread Items are retrieved only through the history Tool. | Use the smallest relevant Item range or a governed source-attributed summary. Durable Thread Items remain truth; a summary is replaced when its source range, authorization, correction, deletion, or retention state makes it stale. |
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

All NanoCore internal roles use the shared [durable rolling context](20260902-agent_runtime_context_compaction.md#internal-durable-rolling-context), replacing the unimplemented Gateway compactor. Each Assistant Timeline or shared conversation has one continuing window isolated by its owning audience. A new Turn continues that window from durable authorized context plus current request-scoped sources. A warm provider context may be reused only while its prompt, Tool set, read scope, output audience, source revisions, policy, and retained Thread context remain compatible; otherwise NanoCore discards it and reconstructs from current owners.

User correction, authorization revocation, deletion, retention change, source revision, audience change, policy change, or incompatible role configuration invalidates affected summaries and provider caches for later calls. An in-progress Turn remains pinned to its admitted input, but publication still performs the current audience guard and may fail closed.

Provider loss, process restart, dependency failure, or cache eviction MUST NOT lose authoritative work or require hidden provider memory to continue. Retry creates a new Turn from current durable truth, preserves causation to the failed or interrupted attempt, and never splices a new provider into an already dispatched attempt or blindly replays Tool effects.

Acceptance is observable when replacing the provider or deleting all provider-side conversation state changes latency at most, a user correction or authorization change affects the next admitted Turn, and a consequential answer can identify the material Thread range or summary, sources, observations, Tools, exclusions, freshness, and audience that grounded it.

### Administration Entry Path

Administration is a private, narrowed Personal Assistant Turn, not a separate Agent role or runtime and not an extension of the ordinary conversational Tool set. The server resolves the dedicated private administration surface and the initiating user's current usable administrator authority under Permissions Core; an ordinary administration request proposes a new private administration Thread. R035 conversation and R048 validated forms use the same configuration/command owners. This section owns the finite initial management contract. Resolving this administration surface is entry admission and stays in this specification. Until the administration family is cut over, the usable administrator authority named here is also the per-call check. When the family is cut over, that per-call administrator check moves into invocation under Derived internal tools, and entry admission stays.

The Thread's immutable server-authored `entryPath` distinguishes administration from ordinary conversation under `20260909-thread_visibility_and_sharing.md`. The administration entry uses the real user's personal Workspace and a dedicated administration endpoint; subsequent requests retain that Thread identity. Entry classification never substitutes for current administrator authorization. Ordinary and administration submissions reject the other entry's Threads instead of changing their Tool sets or interpreting an id prefix or prose marker as routing authority.

The model cannot supply or widen the administration surface or current actor authority. The administration Turn receives no ordinary conversational observation Tools, so retrieved untrusted material and administration operations do not coexist in one Tool array. Direct edits use validated forms; model-backed administration is for drafting, explanation or diagnosis, and application remains the human-confirmed Core command except for the finite delegated Git-read correction below. The finite conversational setup scope below deliberately makes R035 usable without creating another configuration owner.

The management entry has one complete fixed ordered semantic Tool set: `administration.configuration.read`, `administration.schema.read`, `administration.configuration.propose`, the bounded `administration.configuration.apply` projection below, `worker_environment.list`, `worker_environment.status`, `worker_environment.prepare`, `worker_environment.recover`, `nanohost.runtime-target`. The environment operations use the exact preparation/status owner in `20260910-persistent_worker_volumes.md`; preparing an image does not activate it or interrupt the existing Worker. Activation and purge remain human-confirmed commands, never model-callable Tools. Inspection returns redacted current configuration, revision, validation/readiness failures and whether a change needs reload or restart. Schema returns the allowed fields and constraints for the exact registered target family. Proposal prepares an exact candidate under the command owner. The configuration read, schema, and proposal Tools execute no arbitrary code and publish no configuration effect. The bounded delegated apply Tool publishes only its admitted Git-read correction; image preparation uses only the admitted image-build owner and its bounded declaration. These semantic names project through the existing private Tool contract; no new public Tool registry is implied.

The only model-callable configuration application is the [delegated Git-read correction](20260922-delegated_worker_policy_maintenance.md#first-registered-target-and-action), accepted by [D06](../decisions/20261015-cleanup_pinning_and_delegated_apply_rulings.md). Its exact input contains the command request identity and immutable `candidate: { artifactId, artifactVersion, contentDigest }`; target, action, base revision, correction, and intended reload effect come from that candidate. Trusted invocation supplies actor, internal entry/Thread/Turn lineage, affected scope, and current Policy delegation. The [executable Policy-assignment dependency](20260922-delegated_worker_policy_maintenance.md#executable-policy-assignment-dependency) must be satisfied before delegated execution. It accepts only a registered Worker network-policy target and a Git-read correction inside the responsible administrator's current ceiling. It cannot change that ceiling, add push/write access, alter credentials or TLS, recover a service, or act on another configuration family.

This Tool is part of the fixed administration set, never the ordinary Assistant set. Without exact current delegation it returns the owning typed refusal. The existing configuration command rechecks administrator/Policy authority, candidate/base revision, source/output audience, expiry and revocation, and records its ordinary receipt and Audit evidence. It reports persistence separately from reload. Unknown execution is inspected through that same receipt, never reapplied. Other application, activation, and purge remain human-confirmed.

#### Scope and action classes

| Class | Initial actions | Authority and outcome |
| --- | --- | --- |
| Automatic | Read eligible redacted configuration/schema/status; explain an existing validation failure; validate a proposed candidate. | Current resource read authority; bounded observation only. |
| Proposal | Draft create/update for a project Workspace, Provider profile or Worker Agent profile; draft a fix for a validation error; preview changes to existing non-secret resource bindings. | Current target mutation eligibility; candidate bytes, base revision, intended effect and rationale; no application. |
| Delegated apply | Apply only the registered Worker network-policy Git-read candidate inside the current delegated ceiling. | Current administrator and delegated target/action authority; exact candidate/base; ordinary receipt/Audit; persistence and reload reported separately. |
| Approval | Apply every other exact confirmed candidate through its existing Core command; perform that owner's ordinary configuration reload where supported. | Current user authority and payload-bound confirmation rechecked at application; record actual command and reload outcome. |
| Prohibited in this entry | Read or generate bearer secrets; author administrator grants or Workspace membership; arbitrary shell/file/Git writes; install Plugin hooks; change authority Policy or Vault grants, or Worker network policy outside the finite delegated Git-read correction; start/stop/restart services; force unknown effects; provision NanoHost/OpenShell; delete a Workspace, Provider or Worker profile. | Typed unavailable/denied result; use the appropriate existing authorized product surface, never a hidden Worker bypass. |

System operations and technical configuration affecting system behavior require the current user's usable administrator authority under Permissions Core, including Workspace-local Worker/profile, runtime/capability configuration and Provider setup. Workspace targets keep their existing Policy checks. A currently usable administrator credential is eligible for their content, including other users' private content, under Administrator Eligibility in `docs/core/permissions.md`. Attribution stays truthful. Per-effect authority objects are still checked. Workspace creation and ordinary business metadata retain their user/Workspace owners, and personal preferences target only the current user. Selecting an already approved resource for ordinary work is distinct from modifying its technical configuration. The schema/configuration owner, not the selected Thread, model or ordinary member's confirmation, classifies the target. The management entry is for the team's technical administrator; a non-admin request receives an administrator-required result without management discovery or effects. Until that family is cut over, this entry applies the administrator-required result. When the family is cut over, invocation performs the per-call administrator check, and this entry still returns that result without management discovery or effects.

Initial create/update scope includes ordinary Workspace name and authored configuration, Provider non-secret profile and logical-model bindings, and Worker profile/runtime/AEP selections admitted by their respective configuration schemas. References must resolve to currently available, authorized resources. Data-source catalog attachment, credential binding and execution-environment setup may be inspected and explained. The Workspace host repository resource and the Repositories screen are retired. Actual privileged setup, new secret entry and provisioning remain with their existing forms and owning commands. Unsupported fields are rejected rather than written as raw JSONC.

#### Candidate, confirmation and application

Use existing Item-backed human attention and command records. An immutable candidate Artifact version carries target family/id/scope, operation, expected current revision (or verified absence for create), exact normalized candidate, before/after preview, validation results, impact/reload classification, request lineage, and the existing owner command to invoke. An artifact-reference Item presents that exact version in the private administration Thread. The human-issued command binds confirmation to its exact identity/digest, target, expected revisions and impact under the operation owner. Except for the finite delegated Git-read application, application is not model-callable. The human form/command flow creates no paused model run or new ApprovalRequest action. Delegated application uses current Policy authority rather than fabricating a human confirmation. Image preparation retains separate immutable authored and resolved output Artifacts under the persistent-volume owner. The enclosing private administration Turn requires no Worker execution lease. It contains no secret, executable expression or model-selected filesystem path. The command owner derives storage targets and permits only its registered schema fields.

Every write outside the finite delegated Git-read contract receives a confirmation bound to that exact candidate and target. Within that contract, the exact current Policy allow replaces human confirmation and is recorded as delegated authority, never a human approval. A revised candidate requires a new exact confirmation or, only in the finite delegated scope, a fresh current Policy evaluation. The model cannot answer its own gate, and an earlier broad request is not a reusable grant to apply an unseen diff. Where a form submits the same candidate, it uses the same validation, revision and confirmation semantics without invoking a model.

After the exact confirmation or finite delegated Policy allow, Core rechecks user identity, current token restrictions, target authority, base revision, schema, dependency availability and applicable Policy. It calls the existing target command once with the accepted request identity. The result distinguishes persisted configuration, validated/reloaded configuration, restart-required configuration and failure. A successful file write alone cannot mean the Provider is usable or a Worker can launch; verification returns only the actual readiness evidence obtained.

A management proposal terminates as accepted/applied, rejected, stale, expired or failed through its existing gate/command owner. No management proposal table or private approval lifecycle is added. Exact replay returns the owning command's verified outcome; different input under the request id conflicts. If configuration persisted but reload failed, show both facts, keep the prior running snapshot where the configuration owner prescribes it, and allow an explicitly proposed correction. Do not blindly repeat a write, restart a service, or roll back later user changes. An unknown external result stays unknown and uses the owning inspection/recovery path.

Retained application outcomes and their descriptive candidate references ignore unknown descriptive fields when read or replayed, while their original Artifact bytes remain digest attributable. Configuration candidates, requested changes, confirmations and application authority remain exact; an ignored result annotation cannot change the confirmed effect or cause replay to apply it again.

The read-only `nanohost.runtime-target` Tool uses the same configured-target observation and redacted response as the public NanoHost RuntimeTarget read used by Web and remote MCP. It accepts only an empty object: the model cannot select another host, deployment or scope. Until this operation's resource family is cut over, it rechecks current deployment-administrator authority on each call. When the family is cut over, that per-call administrator check moves into invocation under Derived internal tools. It returns only identity, deployment, connection generation, predecessor-fenced, ready, fresh-empty and observed-at fields. Missing server mode, storage, configuration or a matching target retains the public operation's explicit failure semantics; absence is not evidence that the host was never configured. The observation is Core's current stored projection at its timestamp, not a new live host probe or a guarantee of future readiness. NanoHost is an execution host, not an LLM Provider; Provider and Worker-environment inventory cannot establish its readiness. This Tool creates no durable lifecycle, performs no enrollment, restart, activation or repair, and gains no credential or host-path access. After restart or on a new call it reads the existing owner again; it never caches a result as authority or retries a host effect. Acceptance requires matching Web/MCP/Agent observations for ready, unready and unavailable targets, rejection of model-selected target input, and denial after administrator authority is revoked.

#### Personal scope and audit

This Thread has private visibility with its initiating user as private owner; [Thread Visibility](20260909-thread_visibility_and_sharing.md#admission-read-and-publication) owns its audience admission, including administrator eligibility. The Assistant never receives the administrator token secret. Until the administration family is cut over, NanoCore derives request authority from the authenticated bearer or eligible session and checks it at each effect. When the family is cut over, that per-call administrator check moves into invocation under Derived internal tools. Loss of the current authority required for the effect prevents later application even after approval; a reconnect or provider cache cannot resurrect that authority. Membership loss alone does not remove eligibility supplied by a currently usable administrator credential under [Core Permissions](../core/permissions.md#administrator-eligibility). That revocation rule stays in this specification.

Record current user/responsible actor, target scope, operation, exact change/base identities, required confirmation or delegated Policy decision, command, request and outcome through existing AuditEvent/CapabilityCall owners. Redacted configuration effects may be visible to their resource audience; private reasoning/dialogue and credential contents are not audit payloads. Shared cards or summaries do not transfer the originating user's permissions.

#### MCP, Skills and the runtime seam

Internal roles may consume selected Skill context and admitted MCP Tools through trusted entry-path assembly. This is a reusable runtime capability, not permission to expose every installed Plugin to every role. Pin selected resource versions for each admitted run; reassemble only at the safe boundary owned by the internal-runtime contract. Resource text cannot widen the tools, actor, audience or authority. MCP calls use the existing capability Gateway and current effect authorization; Reading a Skill does not execute its scripts. This management entry exposes no shell or Skill-script execution; a procedure requiring such execution must use a separately admitted Worker Task under the existing Task Mode, AgentSession and AEP owners, never trusted NanoCore code.

For the ordinary Assistant entry, `20260909-internal_agent_resource_integration.md` owns internal-capability admission, selected Skill context, frozen assembly, internal MCP lineage, pending approval and native Kernel/UI projection. MCP adapter eligibility requires an exact accepted internal contract and reviewed implementation; the former generic read-adapter permission is not a production adapter profile. It does not import arbitrary server schemas, allow message-selected admission or replace Core commands. Resource metadata is not authority. A required MCP approval returns a pending result under [Pending Requests](20260930-pending_requests.md) and the bounded run continues; that run's ordinary result coexists with the independently owned request, and neither the model nor a generic loop state claims or re-issues the call.

The management entry contains the nine fixed Core-backed Tools above, including the finite delegated apply projection, with no third-party MCP or Skill body in its model context. It may inspect allowed redacted resource-selection configuration and propose a revision through the existing configuration owner, but cannot activate a stdio server or change its own admitted Tool array. Personalization influences explanations, not management Policy.

Management acceptance requires an ordinary member to be denied system and technical configuration changes, including Workspace-local Worker/runtime changes; a currently authorized technical administrator may configure admitted targets without exposing a Token to the model. A technical administrator who did not develop OpenKit must complete Workspace/Provider/Worker-profile setup through conversation and the existing secret/setup forms, observe actual validation and readiness evidence, and never edit server files manually. Model and form paths must produce the same admitted configuration and audit result. Stale revisions, revoked credentials, changed candidates and unsupported fields cause no new write; retry must not repeat an uncertain effect. Private management and shared-resource effect audit retain their separate audiences.

The concrete conversational management integration is Partial. The private entry supports Agent inspection and Worker-image preparation plus updates to existing Provider catalog metadata and Gateway logical-model bindings. Catalog proposals publish immutable private Artifact previews; the separate human-confirmed application command rechecks current administrator authority, exact candidate/source identities and dependencies, and reports persistence separately from reload and restart requirements. Target creation, credential or endpoint changes, broader Workspace configuration and the remaining R035 setup scope are not implemented by this slice.

#### Administration Identifier Names

The existing administration entry uses these exact JSON names in [Core Protocol's kind-specific UUIDv5 namespaces](../core/protocol.md#ids), under the [accepted complete-name declaration](../decisions/20261015-identifier_owner_declarations.md):

| Output | Prefix | Exact JSON name |
| --- | --- | --- |
| Request-owned administration Thread | `th` | `["administration", userId, requestId]` |
| Administration Turn | `tu` | `["administration", userId, threadId, requestId]` |
| Initiating administration user Item | `it` | `["administration_user", turnId]` |
| Administration answer Item | `it` | `["administration_answer", turnId]` |
| Administration refusal Item | `it` | `["administration_refused", turnId]` |

`userId` is the exact authenticated human admitted for administration. `threadId` is the Thread selected by the existing entry; subsequent requests retain it. `requestId` and `turnId` are the exact admitted or recorded values. Purpose literals preserve existing output-role distinctions. Replay uses the same allocating owner and complete name; consumers must not infer authority or replay state by parsing the UUID.

Names change no entry admission, personal audience, per-call authority, refusal, receipt or partial-owner semantics. Ordinary Chat command, handoff, user, result and pending-outcome names remain the accepted tables below. Full ActorRef and frozen scope requirements remain binding. Pending Requests owns its single request Item. Thread, Turn and Item owners retain lifecycle and retention. Acceptance requires exact replay after restart, distinct administration roles, and no duplicate ordinary private Timeline or additional Tool.

### Routing outcomes

The Assistant must produce exactly one routing outcome:

- `answered`: the Assistant returned a direct response.
- `clarification-needed`: the Assistant asked a bounded question as a pending user-input request; the raising Turn completes, and the answer is delivered on a later Assistant Turn.
- `approval-required`: the command's published result is a pending approval for an exact governed Tool effect, with no upstream contact; the raising Turn has completed. This is not an elicitation question. A pending approval raised during a run does not replace that run's ordinary result.
- `task-handoff`: the request should become Task Mode and be handed to Workflow Coordinator.
- `goal-handoff`: the request should become a Goal. The Assistant calls the Goal owner's create operation. The handoff stays visible in Thread history.
- `refused`: the request is outside allowed policy or product boundary.
The outcome must include a short explanation suitable for diagnostics and optional user display.

### Handoff rules

- The Assistant must hand off to Task Mode when the request is a bounded piece of delegated work with a near-term completion path and does not need plan negotiation.
- The Assistant must hand off to a Goal when the request is long-running, ambiguous, high-risk, multi-step, multi-agent, or benefits from an approved Plan version.
- The Assistant must not silently start worker execution. It hands bounded worker work to Workflow Coordinator. A Goal handoff calls the Goal owner's create operation. The Task owner or the Goal owner keeps the durable state and effects.
- Handoff records must preserve the original user request, Assistant rationale, selected target mode, and relevant context references.
- The Assistant owns semantic choice among an answer, clarification, refusal, Task handoff, and Goal handoff within its admitted Tools and authority. Ordinary conversation is not explicit Task delegation. Once the Assistant invokes an authorized explicit Task handoff, it uses the same explicit-delegation admission and worker-request composition as direct `task.start`; Core must not run a second keyword vote on its instruction. The handoff still requires the existing Workspace, audience, source, actor, request, and durable-admission evidence, including current receiving-Workspace and disclosure admission. A failed downstream admission produces the existing truthful clarification or refusal outcome, not a handoff to nonexistent work. No nested Task receipt is added.
- A personal Workspace may own the receiving Task or Goal execution. A handoff creates a linked execution Thread under the same current-authority and disclosure rules as any other Workspace. Personal placement requires no forced move to another Workspace.
- If no executing Workspace can be resolved or created because exact authorization is missing, the Assistant MUST create a durable refusal Item naming the exact missing authorization and MUST create no Task, Goal, Worker Turn, or execution Thread.

### Exact Handoff Selection

A model-called `task.start` or `goal.create` first proposes exact work through the existing Pending Request owner. The descriptor contains the receiving Workspace and exact Task brief with selected Agent/model, or exact Goal intent. The brief includes any constraints or selected input text that will enter shared work. No ambient private transcript, Memory, private request Item reference or unrestricted source link enters the receiving work. The inline question displays the complete descriptor and offers exact confirmation or no execution. One run may propose one handoff; another proposal returns a typed pending-selection result. Model completion must succeed before this proposal becomes a canonical request, and the command returns `clarification-needed`. A later Provider failure cannot create an execution.

An exact affirmative human answer selects those bytes; it does not grant permission, satisfy a Policy Approval or widen disclosure. The existing outcome admission freezes that request on a later Assistant Turn. Its native continuation verifies the canonical request and descriptor, the deciding credential, current source access, receiving execution authority, current Worker selection and exact source lineage. It then uses explicit Task admission or the Goal create effect without a second semantic or keyword vote and without a narration call after the effect. A declined, withdrawn or invalidated selection starts nothing and leaves a visible result. A failure or partial downstream tuple remains with the existing truthful refusal or recovery rules. The original conversation and answer receipts stay unchanged. Explicit selected-Worker submission already selects its exact payload and retains its existing work confirmation; it does not add this proposal step.

### Thread and item projection

- Direct Assistant replies appear as normal `assistant-message` items.
- Assistant clarifying questions are pending user-input requests in the human-attention projection; the raising Turn completes, and the answer arrives on a later Assistant Turn.
- Handoff decisions must be represented by an item-backed status, handoff item, or stable App API read model that maps back to the thread.
- Chat Mode must not create a worker turn unless Workflow Coordinator accepts a Task handoff. A Goal handoff calls create Goal and creates no worker turn.

### Unified-command branch and replay

An externally submitted Assistant conversation is invoked by an accepted `conversation.submit` command. An Assistant Turn that delivers a pending-request outcome is admitted by [Pending Requests](20260930-pending_requests.md), is not a `conversation.submit`, and does not rewrite that command's receipt. Its immutable identity and canonical input hash are owned by `docs/specs/20260831-unified_conversation_composer.md` and include the selected target, logical-model preference, and Artifact references as well as user input. The Assistant receives the already accepted logical-model contract and admitted Artifact context; it never receives or selects a Provider profile, provider-native model, account slot, or private route. A Coordinator decision or mutable Thread projection resolved during execution remains an execution result rather than command input.

NanoCore looks up that command identity before resolving a current mutable projection or invoking Coordinator or a provider. Once a completed command record or complete deterministic result tuple exists, the same identity and input MUST replay the original `answered`, `clarification-needed`, `approval-required`, `task-handoff`, `goal-handoff`, or `refused` lineage and MUST NOT invoke a provider, create another Turn or Item, open another gate, start another worker, create another Goal, or enqueue another scheduler admission. That replay does not forbid a later Assistant Turn admitted by [Pending Requests](20260930-pending_requests.md) to deliver an outcome, and it does not rewrite a completed receipt. Reusing the identity with different caller input returns `409 idempotency_key_conflict` before effects.

For the #144 selected-Skills family, reuse of the original admission preserves the selected resources only and does not authorize replay of completed, interrupted or unknown inference effects under the same command.

The reason is recorded in [Assistant Inference Request Lineage](../decisions/20261015-assistant_inference_request_lineage.md).

Derived Thread, Turn, and Item outputs use their kind prefixes plus canonical lowercase UUIDv5 text under [Core Protocol](../core/protocol.md#ids). Each exact name is the UTF-8 RFC 8785 JSON Canonicalization Scheme output for the JSON value below. Arrays preserve the listed order, and JCS canonicalizes nested objects. Each kind uses its fixed OpenKit namespace. The output-encoding decision is recorded in [One Identifier Mechanism](../decisions/20261014-one_identifier_mechanism.md).

`commandScope` is exactly `{ "command": "conversation.submit", "actor": actor, "workspaceId": workspaceId, "threadId": originatingThreadId, "requestId": requestId }`. `actor` is the complete immutable authenticated `ActorRef` in the closed shapes of [Core Identity](../core/identity.md#core-concepts); identifiers and `requestId` are the exact admitted strings. This is the immutable identity scope defined by [Unified Conversation Composer](20260831-unified_conversation_composer.md#structured-submission). User text, target selection, model preference, effort, storage choice, and Artifact references remain in the separate canonical input hash; they are not added to the identity scope.

`outcomeScope` is exactly `{ "workspaceId": workspaceId, "threadId": originatingThreadId, "turnId": assistantTurnId, "responsibleUserId": responsibleUserId, "input": frozenOutcomes }`. `responsibleUserId` is the original recorded responsibility binding of the admitted Assistant source. `frozenOutcomes` retains the exact readiness order admitted by Pending Requests. Each element is exactly `{ "requestId": requestId, "requestItemId": requestItemId, "publicationTurnId": publicationTurnId, "resolution": resolution, "ending": ending, "disposition": disposition, "answerMap": answerMap, "decidedAt": decidedAt, "endedAt": endedAt }`. Every value comes from that durably accepted frozen association. Absent nullable facts remain JSON `null`, and answer-map strings and array order remain exact. Recorded decision and ending times remain their original strings; derivation never reads a new clock or random value.

| Derived output | Prefix | JSON name value, in fixed array order |
| --- | --- | --- |
| Command-initiated Assistant Turn | `tu` | `commandScope` |
| Command-initiated handoff Thread | `th` | `[actor, workspaceId, originatingThreadId, requestId]` |
| Command-initiated first handoff Task Turn | `tu` | `[actor, workspaceId, originatingThreadId, receivingThreadId, requestId]` |
| Outcome-initiated handoff Thread | `th` | `outcomeScope` |
| Outcome-initiated first handoff Task Turn | `tu` | `outcomeScope` |
| Initiating Chat user Item | `it` | `["chat-user", assistantTurnId]` |
| Chat-owned result Item or handoff status Item | `it` | `[resultRole, assistantTurnId]` |
| Initiating downstream Task user Item | `it` | `["task-user", downstreamTurnId]` |

`receivingThreadId` is the exact downstream Thread reserved or selected by the existing handoff owner. `assistantTurnId` and `downstreamTurnId` are the exact admitted Turn identifiers. The literal user roles distinguish the existing Chat and Task Item purposes. `resultRole` is the existing result-purpose discriminator selected by the recorded result kind, using this closed mapping. The answer-source distinctions keep the same answer Item purpose. Clarification and approval results reference the Pending Requests request Item instead of creating a Chat-owned result Item. Neither has a `resultRole` in this mapping.

| Recorded result kind or public outcome | Exact `resultRole` |
| --- | --- |
| `knowledge-answer`, `provider-answer`, or an answered Knowledge/repository/provider result | `chat-answer` |
| `task-handoff` | `chat-task` |
| `goal-handoff` | `chat-goal` |
| `worker-turn` | `worker-result` |
| `goal-intent` | `chat-goal-intent` |
| `goal-steering` | `steering-result` |
| `refused` | `chat-refused` |

A handoff status identifier is that result Item's id, not a separate entity. The `user-input-request` clarification result and the approval-request result use only the request Item name defined by [Pending Requests](20260930-pending_requests.md#deliver). Its JSON value is `[requestId, "request"]`. Here `requestId` is the exact durable `userInputRequestId` or `approvalRequestId`, respectively, not the conversation command's request id. The existing durable association on the raising Turn identifies the original request and its request Item. No name is derived from `assistantTurnId` and `resultKind` for either request Item; this table creates no second Item. The existing inputs, allocation triggers, and replay rules remain unchanged.

Chat-owned Turn and Item identifiers and handoff status identifiers derive deterministically from the immutable command scope and request id. The completed command record is published only after one complete owner tuple is durable: an answered or refused terminal Chat Turn with its user Item and exact result Item; a completed clarification Turn with the exact `user-input-request` Item and its pending request record; a completed approval Turn with its exact approval-request Item, pending request record, Approval and no-contact denied call; a complete Task handoff tuple; or a complete Goal handoff tuple. Clarification and approval results are acknowledged command results whose Turn has completed, so replay returns that request and never opens another one. When that command's published result is `approval-required`, the result still requires the exact completed approval-request Item, pending request, pending Approval, and denied no-contact CapabilityCall. The command receipt replays that original result and is not what makes the request actionable. Actionability follows [Pending Requests](20260930-pending_requests.md): the durable request, captured binding, request Item, no-contact evidence, and current authority. A pending request raised during a run whose ordinary result is `answered` or another non-approval kind, or raised by an Assistant Turn the pending owner admitted, has no `approval-required` conversation receipt and remains actionable under those predicates. A missing or contradictory pending-request owner is inspect-only `recovery_required`. No conversation command is fabricated for a delivery Turn, and a completed receipt is never rewritten. An ordinary command result may be published while pending requests from the same run stay independently owned. No new internal-run record is introduced. If no deterministic Chat or handoff owner is durable, the same command may perform its first attempt. A handled failure leaves either no tuple or one terminal failed Chat tuple. If only part of a tuple is durable, inspection and exact replay return `recovery_required`; they do not rerun the provider, complete the missing business write by inference, or start the handoff again. A user-requested new attempt after a terminal failure uses a new `requestId`; no command reservation state, Chat settlement workflow, or recovery lifecycle is introduced.

For a `task-handoff` or `goal-handoff` produced by a command-initiated Assistant Turn, the initiating `conversation.submit` command is the only command-ledger owner. It calls the Task owner or the Goal owner with the immutable outer command scope and causation. A Task handoff creates the deterministic downstream Thread, Turn, Item, checkpoint, and scheduler tuple without publishing a second `task.start` receipt. A Goal handoff calls create Goal, keeps a handoff Item on the originating Thread, and does not copy that history into the Coordinator Thread. Direct public Task or Goal requests retain their own command identity. A half-state is therefore evaluated against one outer receipt and one downstream business tuple, not two nested command records.

A Task handoff produced by an outcome-initiated Assistant Turn, which [Pending Requests](20260930-pending_requests.md) admits to deliver a clarification answer or an approval outcome, has no conversation command. That admitted Assistant Turn and its durably accepted frozen input association are the immutable source scope, and the pending request's responsible user is the handoff's actor. The receiving Thread, first Task Turn, handoff Item, and checkpoint identities derive from that scope. The completed handoff Item on that Assistant Turn and the exact downstream Thread, parent, Turn, checkpoint, and evidence tuple prove the handoff. No `conversation.submit` or nested `task.start` receipt is fabricated, and neither the original conversation receipt nor the `user_input.answer` or approval response receipt is rewritten. Missing, conflicting, or partial lineage returns `recovery_required` without rerunning the Assistant, Coordinator, or worker. A Goal handoff from that Turn calls create Goal under the same source scope, keeps the handoff Item on the originating Thread, and copies no history into the Coordinator Thread. A Goal removed by the accepted deletion is known absence, not `recovery_required`. Replay does not recreate a Goal.

An Assistant-targeted conversation command may publish `task-handoff` or `goal-handoff` only after the complete downstream tuple is durable. For a Task handoff, that tuple is the Task owner's validated durable queued acceptance: the exact pending Turn, idempotent admission, immutable input, request-bound checkpoint/context facts, and ordinary outer receipt; the command returns HTTP 202, preserving the completed original Assistant Turn and handoff Item plus exact downstream lineage in the outer receipt before response delivery. The downstream pending worker reads queued with no completion and may lack an AgentSession until dispatch. Capacity deferral preserves that same Turn and admission; later preparation failure lands on it. One nonterminal Turn per receiving Thread still holds. A caller told of a real failure has its queued admission cancelled. Downstream dispatch, worker completion and terminal cleanup proceed independently of that connection. Exact replay validates a live downstream Task against its request-bound checkpoint context and scheduler admission; it validates any initiating Item already present without requiring that later Item or a terminal StopReason at admission. Terminal closeout retains the Task owner's full existing proof and applicable receipt requirements. If the downstream mode rejects before accepting a command or effect, the Assistant must complete the same Turn as `clarification-needed` when one bounded answer can make the request executable or as `refused` otherwise; it MUST NOT publish a handoff Item or receipt that names nonexistent downstream work. The admission response boundary and its rationale are recorded in [Execution Backend Port In NanoCore](../decisions/20261006-execution_backend_port_in_nanocore.md).

When the Assistant selects `task-handoff` or `goal-handoff` in a personal Workspace, the existing handoff confirmation may keep execution in that Workspace. It creates a linked downstream execution Thread while the originating Timeline retains the handoff Item and causation. Any explicitly selected different Workspace requires current placement and disclosure authority. Missing exact authority completes the conversation command with a durable refusal Item naming it; no Task, Goal, Worker Turn, checkpoint, or scheduler admission exists in that refusal case.

The command `user_input.answer`, as [Pending Requests](20260930-pending_requests.md) defines it, records a Chat clarification answer on the pending request and does not change the raising Turn. An exact replay returns the recorded answer, a different answer map returns `409 idempotency_key_conflict`, and a missing or contradictory request, Item, or projection returns `409 recovery_required` before any write. The answer is delivered on a later Assistant Turn that the pending owner admits, using the answer as the clarified input. That Turn is not a replay of the original `conversation.submit`, does not reopen the raising Turn, and does not resume a worker AgentSession. The original conversation command replays its historical result.

An Assistant approval is resolved through the approval response command, never through `turn.input.submit` or `user_input.answer`. While the request is pending, that command applies the pending owner's single synchronous re-evaluation, grant, and claim, executes the captured call inside the response command, and records the disposition; a denial records `denied-not-executed` and executes nothing. The command invokes no model. The outcome is delivered on a later Assistant Turn, and the model does not re-issue the call. The original conversation command replays its historical result. A missing or contradictory owner returns `409 recovery_required` and accepts no response.

### Usage and audit

- Assistant LLM calls must emit durable `CapabilityCall` and `UsageRecord` rows once the shared capability usage foundation is implemented.
- Tool reads that touch privileged workspace state must be auditable at the appropriate level of detail without storing secret values or unrestricted file contents.

### Command receipt authority

The Assistant branch of `conversation.submit` is the narrow multi-owner exception to current-resource replay because a clarification or approval Item and its Turn may advance after the original command was accepted. Its command receipt MAY retain only `resultKind`, the accepted HTTP success status, and the stable downstream Task Thread and Turn or Goal and Goal Turn identifiers required by a handoff. The normal receipt resource identifier names the original Assistant Turn. NanoCore derives the initiating user Item and Chat-owned result Item identifiers from that Turn identifier using the name table above. The closed `resultKind` still distinguishes knowledge, repository, or provider answers, clarification, approval-required, Task handoff, Goal handoff, and refusal. For clarification or approval, NanoCore reads the original request through the existing durable association with the raising Turn and uses only the Pending Requests request Item name. `resultKind` selects the result family; it supplies no second derivation for a pending-request Item. The receipt MUST NOT contain Item identifiers that are already derivable, the prompt, explanation text, Turn or Item bodies, assistant content, Coordinator output, provider output, or a full response body.

Replay reconstructs the original accepted Chat projection from durable owners. It reads the first durable revisions of the initiating user Item and result Item. From those Items and `resultKind`, it derives the accepted Turn status, timestamps, and duration. It reads any original pending request through its existing durable association with the raising Turn. It derives fixed explanations from `resultKind` or the result status Item and validates every derived or stored identifier against the receipt Workspace, Thread, and Turn. A terminal result additionally requires the current Turn to remain completed with the same completion timestamp; a clarification or approval may replay its original accepted request after the request is later resolved and a later Turn delivers it. When the original command's result kind is `approval-required`, replay reads the exact pending request and its Approval projection through that original association. For that result, it derives the request Item name only from the recorded pending-request id with role `request`. It verifies the linked no-contact denied call and returns the original approval result without authorizing another effect or rewriting the receipt. That replay is not what makes the request actionable, and an Assistant delivery Turn admitted by [Pending Requests](20260930-pending_requests.md) has no conversation command to replay. A Task handoff also requires the named downstream Turn. A Goal handoff requires the named Goal and the handoff Item when the Goal still exists. A Goal removed by the accepted deletion is known absence, not `recovery_required`, and replay does not recreate it. A missing, malformed, wrong-kind, or contradictory non-Goal owner still returns `409 recovery_required`. The receipt is evidence only and cannot mutate a Turn, Item, Goal, checkpoint, scheduler admission, or provider lifecycle.

This bounded receipt does not solve a crash before receipt publication. Deterministic request-derived owner identities and the existing downstream business owners must address that half-state later; the implementation MUST NOT add a Chat reservation, settlement, recovery workflow, or private lifecycle to compensate.

### Provider and persistence failure

The provider response is not an `answered` Chat Mode outcome until the same Thread owns a durable Turn, its user-message Item, its assistant-message Item, and terminal completed status. The deterministic Turn and initiating user Item MUST be durable before provider dispatch; they are the ordinary narrative owner proving that this Chat attempt began, not a separate reservation. Failure before that pair leaves no Chat records.

Raising a pending approval is not a provider abort and does not change the Turn's failure classification; a later provider failure preserves the independently durable pending request and follows the ordinary failure rules below. After that pair is durable, provider rate limit, request failure, timeout, caller abort, or invalid content MUST terminalize the same Turn with the exact `provider_rate_limited`, `provider_request_failed`, `provider_call_timeout`, `provider_call_aborted`, or `provider_response_invalid` code defined by S05. Caller abort makes the Turn `interrupted`, and the existing `provider_call_aborted` code preserves the cause; the other provider failures make it `failed`. The command receipt preserves that typed failure lineage, exact replay does not redispatch, and failure to persist the required terminal tuple returns `recovery_required`.

`chat_mode_persistence_failed` is reserved for a valid provider response whose assistant Item and completed Turn tuple could not be committed. The implementation MUST terminalize the same Turn as failed when that deterministic failure tuple can be written; it MUST NOT redispatch the provider under the same request, publish a completed assistant Item, or claim `answered`. A partial or contradictory assistant/Turn tuple, or failure to persist terminalization, returns `recovery_required`. The bounded availability compromise is that the user must use a new request id for another provider attempt rather than adding a settlement owner.

Chat Mode does not resume the provider invocation after process failure. The caller reads the command and Thread state; replay of a completed request returns the original lineage, a started but incomplete provider attempt returns its terminal failure or `recovery_required`, and a user-requested new attempt uses a new request id and creates a new provider invocation. This deliberately favors no hidden duplicate call over automatic recovery and is not authorization for a Chat settlement or recovery workflow.

### Bounded Source Context

Assistant input and Tool observations follow [Internal Agent Runtime's bounded model projection](20260813-internal_agent_runtime.md#minimal-tool-contract). Large files remain with their source owners; the Assistant receives descriptors, previews, and exact requested ranges. Current source and output-audience checks apply to all metadata and excerpts before model use. Failed storage or retrieval returns a bounded unavailable descriptor, never the full body. This grants no new Tool, shell, host reader, or broader history effect.


## Accepted Design

NanoCore implements Core Assistant as one role assembly over the bounded internal Agent runtime owned by `docs/specs/20260813-internal_agent_runtime.md`. The Assistant supplies its role prompt, bounded current Thread input, entry-path-fixed Core Tools and selected Skill metadata (including exact personal Memory operations), request-scoped sources, and output audience; the generic loop supplies no Assistant authority or product lifecycle.

The Assistant remains app-local in `apps/nanocore`, owns no private execution lifecycle, and must not introduce a second loop, registry, event protocol, hook framework, or multi-agent framework for this role.

## Predecessor Execution At The Identifier Cutover

This prerelease joins the accepted P14 identifier cutover. Predecessor receipt-free Assistant Task admissions have no exact-selection descriptor or current receiving lineage and are not automatically resumed by this implementation. Any retained tuple remains inspectable as `recovery_required`; no confirmation, receipt or replacement effect is inferred. The separately authorized P14 deployment reset and its protected-account verification belong to their existing operator owner. This feature grants no reset and changes no ordinary retained pending-request lifecycle.

## Current Implementation Projection

NanoCore exposes the Assistant through `conversation.targets` and `conversation.submit`. The stateless `chat.quick` operation is removed. New private conversation admission selects the User's single Timeline in the selected Workspace. Retained extra private Threads stay readable and their completed command receipts stay replayable; new Assistant work uses the Timeline. The personal Workspace can own shared Task and Goal execution while remaining owner-only.

Command and ordinary pending-outcome inference use the shared Internal Agent Loop, fixed Assistant Tool factory and source-bound rolling assembler. Tools follow the ordered contract above. Native resource families reuse their current operation schemas, admission and receipts until their internal invocation cutover. Goal mutations expose `targetThreadId` for the selected Goal Thread, separate from the server-bound querying Thread; native invocation verifies that target against the selected Goal and current authority. UI publication binds its Thread and Turn to the current admitted source. The selected Skill engine stays command-only; an outcome Turn retains the same present Skill definition with a typed unavailable result rather than fabricating a conversation command. Scoped Memory operations remain present with typed unavailable or private-entry-required results until their lifecycle implementation. Vendor repository inspection remains outside the Core Tool set and has no host-reader fallback.

Task and Goal Tool calls propose exact canonical Pending Request selections. Confirmed native outcomes create linked shared receiving Threads, preserve original receipts and do not rerun the model or keyword classification. Exact retained history remains retrievable through bounded history search and revision-bound range reads. Shared summary generation uses the ordinary captured Provider path with usage, audit and failure accounting inside the same budget. Web displays the summary range and CLI Item reads expose its exact source fields.

Current evidence is local integration with injected Provider and Worker boundaries, including exact replay, restart at pending confirmation, retained history and archive portability. It is not live Provider, host or browser acceptance. Historical host-reader and keyword-routing results do not prove this implementation. The accepted contracts above remain the acceptance criteria; generated contracts and full exact-head gates are completed at landing.

## Alternatives Considered

- Let Chat Mode directly start worker agents. Rejected: it collapses Assistant and Coordinator responsibilities and hides delegated work from the workflow model.
- Make every user request go through Goal Mode. Rejected: it adds planning overhead to simple questions and makes the product feel slow.
- Give Assistant the full worker MCP tool catalog. Rejected: owned internal capability contracts provide the required functionality without importing arbitrary MCP schemas; arbitrary code and long-running work retain the Worker path.

## Consequences

- Users get a fast entry point without losing the ability to escalate into tracked work.
- The Assistant is an explicit Internal Core Role with one small role assembly over the accepted generic internal Agent runtime.
- Some requests will require visible handoff instead of a direct answer; this is intentional and keeps work traceable.

## Testing Strategy / Acceptance Criteria

- One private Timeline exists per `(User, Workspace)`; ordinary private chat creation cannot allocate a second one. Restart retains the same continuity and current audience rules.
- A personal Workspace can own Task, Goal, Artifact, and Sandbox work but refuses member addition. Memory remains User-scoped.
- Dispatch produces no result card or proactive completion reply. A user-requested status read returns current owner evidence through ordinary Items.
- All internal roles use the same durable rolling-context mechanism and no Gateway compactor. Shared conversation implementation remains after `v0.1.0`; its later checks cover whole-audience source filtering, current Actor authority, queued Turns, private-window isolation, and one Core Assistant.
- L1: routing classification tests for answer, clarify, approval-required, Task handoff, Goal handoff, and refusal.
- L3: a direct Assistant run and an outcome-initiated Assistant Turn can each raise an actionable pending approval without stopping the run or requiring an `approval-required` conversation receipt; the ordinary result and any existing conversation receipt remain independently replayable; grant executes the captured call once inside the approval response command, and a later Assistant Turn receives the outcome without reissuing the call. Missing or contradictory request owners remain inspect-only.
- L3: a conversation completes with `clarification-needed`; its answer admits an Assistant Turn that hands off a bounded Task; that Task's worker raises a user-input request. The handoff lineage derives from the admitted Assistant Turn, no conversation or `task.start` receipt is created or rewritten, the worker's request validates against the pending request's responsible user and that source tuple, and a missing or conflicting source tuple is `recovery_required` without rerunning the Assistant, Coordinator, or worker.
- L1: typed provider and persistence error tests proving system failure never returns a success-shaped routing outcome.
- L1: schema tests requiring `requestId` and rejecting changed input under a reused id.
- L1: tool-boundary tests proving disallowed file writes, shell, direct worker calls, unadmitted MCP calls, and secret reads cannot be requested through Assistant tools.
- L2: contract tests for item projection and handoff record shape.
- L3: NanoCore black-box tests for a direct answer, a clarification gate, a Task Mode handoff, a Goal handoff that calls create Goal, exact provider-error mapping, and post-provider persistence failure with no false `answered` outcome.
- L3: same-id replay for every successful routing outcome returns the original Chat, Task-handoff, or Goal-handoff owner tuple without duplicate provider, gate, worker, Goal, admission, or usage effects; changed input returns `idempotency_key_conflict` before effects.
- L3: a user-requested retry after a failed provider or persistence attempt uses a new request id, is visibly a new invocation, and does not resume hidden Chat state.
- L6: story acceptance where a user asks a simple workspace question and gets an immediate answer, then asks for a larger change and sees a visible handoff to tracked work.

Acceptance: Assistant never directly starts a worker, never mutates arbitrary files or Workspace/Server Knowledge, emits visible thread history, routes bounded worker work to Workflow Coordinator, and routes a Goal handoff through the Goal owner's create operation.

Acceptance also requires identical ordered ordinary-entry Tool definitions across message classes under the same resolved configuration, metadata-only assembly with zero ambient business or operational reads for a general question, per-call authorization and publication guarding, with an administration Tool's per-call administrator check located as Derived internal tools states, reconstructible continuity, a separate administration Thread whose only delegated application is the admitted Git-read correction, and a personal-Workspace work request that reaches the confirmed Task or Goal or leaves an exact durable missing-authorization refusal.

## Risks & Mitigations

- Risk: Assistant over-answers tasks that should be delegated. Mitigation: conservative routing tests and explicit handoff outcomes.
- Risk: a vendor repository read returns more than the caller should see. Mitigation: vendor reads follow the MCP owner's authentication, current authorization, per-tool approval, and audit. A Task is the path beyond a selected read. The retired host working-directory reader is not this contract.
- Risk: Chat Mode becomes another workflow engine. Mitigation: Assistant performs bounded admitted calls and leaves execution, gates and durable effects with existing owners.

## Resolved Decisions

Previously open questions are resolved as follows. The Workspace host repository resource is retired, and the Assistant does not inspect code by reading a NanoCore host checkout. Repository code inspection uses a selected Gateway vendor MCP read tool or a Task. Chat-to-Task and Chat-to-Goal handoff is represented as an App API projection over a status item, not a dedicated protocol item type. The decision and its reason are recorded in [a decision record](../decisions/20261002-hosting_through_gateway_mcp.md).

## Deferred / Future Work

The stateless `chat.quick` operation is removed under [Retire Stateless Quick Chat](../decisions/20261016-retire_stateless_quick_chat.md). Ordinary Assistant entry uses `conversation.submit` on the private Timeline, including one-shot CLI and Skill use. The former direct-call entry and any sections that describe it as current are superseded by this rule. No compatibility alias is provided.

- Rich UI for Assistant routing explanations.

## Links

- `docs/core/work-model.md`
- `docs/core/architecture.md`
- `docs/core/agent-workflow.md`
- `docs/core/knowledge.md`
- `docs/specs/20260704-task_mode_worker_delegation.md`
- `docs/specs/20261002-operation_definition.md`
- `docs/specs/20261002-goal.md`
- `docs/specs/20260704-workflow_coordinator_internal_agent.md`
- `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md`
- `docs/specs/20260704-capability_usage_gateway_foundation.md`
- `docs/specs/20260531-worker_turn_reliability_envelope.md`
