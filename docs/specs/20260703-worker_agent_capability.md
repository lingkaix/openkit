---
status: Accepted
implementation: Partial
kind: boundary
aspect: mediation
---
# Worker Agent Capability

This specification owns the worker-facing capability plane, its selected MCP projection, the `openkit-work` Tool identities, and the Budget baseline.

## Scope

This specification owns loopback credential mint, attribution, drain, destruction, and digest persistence. It owns the three executable MCP operations and the built-in Work Tools.

It does not own Knowledge semantics or notebook governance. [Knowledge](../core/knowledge.md) and the context-package owner keep them.

It does not own Vault storage or secret bytes. [Vault](../core/vault.md) owns them.

It does not own pending-request lifecycle. [Pending Requests](20260930-pending_requests.md) owns it.

It does not own outer carriage. [NanoHost Runtime And Transport](20260802-nanohost_runtime_and_transport.md) owns RelayStream and route transport.

It does not own runtime-origin provenance. [Worker Runtime Sub-Agent Provenance](20260711-worker_runtime_subagent_provenance.md) owns it.

Core: [Mediation](../core/mediation.md), [Agent Supply](../core/agent-supply.md), [AgentSession](../core/agent-session.md), [Communication](../core/communication.md), [Evidence](../core/evidence.md).

Workers do not install or replace a NanoCore-hosted capability implementation. Gateway-required integrations stay mediated. An admitted public non-LLM grant keeps its network and credential contract under [Agent Manifest And AEP Resolution](20260703-agent_manifest_aep_resolution.md) and [Sandbox](../core/sandbox.md). That direct route creates no NanoCore-managed MCP supply and no upward control route. A Tool or MCP server that the worker configures inside its Sandbox is not a capability call.

## Decision

All privileged worker agent capability access goes through one NanoCore-owned gateway projection.

The worker-visible local APIs and their outer target route families are:

```text
capability.local (logical binding)
  -> /capabilities/*                            # capability token
http://127.0.0.1:17892/inference/v1
  -> /inference/*                               # inference token
/worker-control/*                               # distinct worker-control token
```

The logical `capability.local` binding carries selected OpenKit capability calls, while the logical `inference.local` binding carries OpenAI-compatible inference calls through the fixed loopback URL above. Shared HTTP/2 carriage does not merge their authority or behavior: each family authenticates its own token or reference and preserves its own payload, concurrency, flow-control, retry, failure, usage, and audit contract.

The first route projection may use family-specific routes such as `/knowledge/search` and `/knowledge/read` because they are easier for runtime-native clients and policy schemas to type. A generic `POST /calls` route is not a requirement of this contract.

A resident runtime outlives the per-Turn inference and capability route tokens, so it never receives them ([decision](../decisions/20260930-resident_request_attribution.md)). At `session.open` NanoCore mints one session loopback credential per route family, inference and capability, and delivers them to the Harness, which gives them to the runtime host as bearers for the fixed loopback endpoints. Sandbox Integration authenticates a loopback credential, maps it to its AgentSession and family, and forwards the request under the route token of the Turn bound to that AgentSession when the request arrives; the request is attributed to, and authorized as, that Turn. With no Turn bound, every request is refused. At a Turn's terminal barrier Integration drains that AgentSession's in-flight requests for at most the current default of 10 seconds, cuts the rest and refuses their results, and only then clears the Turn's route tokens. The current default aggregate of resident Worker sessions is 20. Each session remains single-flight. [Runtime Scheduling Scale](20260703-durable_scheduler_design.md#scale-limits) owns scale. This specification does not set one global active slot. `session.close` destroys both loopback credentials. NanoCore persists only the SHA-256 digests of the two loopback credentials with the binding and keeps no raw value after the `session.open` dispatch. A transport loss or a NanoCore restart may adopt the exact surviving binding under the proof contract in [AgentSession Continuity](20260704-agent_session_continuity.md); Integration keeps the credentials, so the resident runtime is untouched. A binding that cannot be proved exactly is closed or fenced, and a successor resumes the native conversation. The collection check compares those digests as [Workspace Synchronization](20260703-workspace_synchronization.md) defines. This specification owns the loopback credentials' mint, attribution, drain, destruction, and the persistence of their digests; other owners link here rather than restate them. Upstream route tokens still rotate every Turn. The scheme does not fence generations: work from an earlier Turn that sends a request after a later Turn binds acts with the later Turn's authority, which the engineer accepted.

## Capability Families

The accepted target capability routes and supply categories are listed below. They are not the retained `CapabilityCall.family` enum; [Audit, Usage, And Evidence Records](20260703-audit_usage_evidence_records.md#gatewaycallcontext) owns that closed vocabulary.

- `mcp`: call an MCP tool exposed through NanoCore.
- `knowledge.retrieval`: search governed knowledge and source indexes.
- `knowledge.read`: read selected knowledge pages, source summaries, or derived representations.
- `external-api`: call a configured external API through a provider profile. This family is not callable.
- `network`: access an allowed network target through a proxy policy. This family is not callable.
- `vault.use`: use a vault-mediated credential without exposing the secret value where possible. Logical provider declarations and the Codex auth JSON runtime-file reference are separate implementation mechanisms; non-transient OpenShell provider materialization is currently fail-closed, persistent Worker images reject runtime-file materialization, and none of these paths makes this future gateway route active.
- `llm`: call an LLM through the AEP-resolved backend-local or trusted worker-inference gateway path.
- `artifact.read`: read declared artifacts as context.
- `artifact.write-notice`: announce an artifact that must be collected through the data plane.

Filesystem mutation is not a gateway family. Workspace writes belong to workspace change sets and review gates.

## Catalog Model

NanoCore owns a workspace-visible `CapabilityCatalog`.

Catalog entries include:

- capability id
- family
- display name
- description
- provider or service reference
- required policy domain
- required vault grant category
- input schema reference
- output schema reference
- rate limit class
- usage unit class
- audit category
- redaction policy
- availability state
- degraded reason when applicable

The catalog is resolved into the AEP snapshot. A worker sees only the catalog entries selected for that session.

Catalog source records should be file-system-first or manifest-backed where possible. SQLite may index catalog availability and runtime diagnostics. The AEP contains the resolved per-session snapshot, not the canonical catalog source.

## Request Envelope

The accepted future non-MCP generic capability envelope supplies a capability request through the separately authenticated capability route:

- capability call id or idempotency key
- worker sequence when emitted by the shim
- operation
- input payload
- content digests for large payload references
- request timestamp

Selected MCP uses its admitted MCP request artifacts. Server listing accepts exactly `{}` and rejects any other property. Server Tools use MCP requests. Their request identity comes from the native MCP id. This list does not add fields to those requests. A generic `POST /calls` route is not mandatory.

NanoCore derives authoritative workspace, thread, turn, AgentSession, package-snapshot, capability-id, and family context from the authenticated package session, selected route, and resolved catalog. Worker-supplied lineage is never authority.

The mediated MCP CapabilityCall producers derive `cap` UUIDv5 from exact JSON name `["mcp", packageSnapshotId, serverId, operation, protocolRequestId]`. `packageSnapshotId` is the authenticated frozen AEP snapshot. `serverId` is the exact admitted catalog binding. `operation` is the complete admitted native operation discriminator. Captured approval execution instead derives its `cap` UUIDv5 from `["pending", requestId]` under [Pending Requests](20260930-pending_requests.md); it does not use this native MCP request derivation. `protocolRequestId` is the exact admitted native JSON-RPC string or number. Preserve these input types and the literal `mcp` purpose ([accepted allocation decision](../decisions/20261016-identifier_derivation_and_import_allocations.md)). Fix identity at existing call admission and retain it through update, termination and reopen. Identity never substitutes for current AEP, policy, claim, recorder-key or immutable-attribution checks. Missing, stale, contradictory or unknown proof follows existing refusal/unknown rules without another contact. Retention and import stay with the call owner. Acceptance requires distinct native types and package/server/operation scopes, unchanged attribution conflict, retained-call reuse on permitted replay and zero replacement contact after uncertain work.

## CapabilityCall Record

`CapabilityCall` is the durable record for one call through an agent capability route or gateway projection.

It should store:

- call id
- lineage ids
- capability id and family
- operation
- policy decision id
- vault grant ids used
- upstream provider summary
- request redaction summary
- response redaction summary
- status: one terminal value of the closed [Core `CapabilityCall` status vocabulary](../core/mediation.md#capability-call), with upstream-contact knowledge for `unknown`
- normalized error code when failed
- for the execution of an approved call, the pending request id it executes; the full arguments stay in that request's captured binding, not in this record
- usage record ids
- audit event ids
- start and finish timestamps
- digest of large request or response references when retained

Raw provider payloads should not be stored by default.

## MCP Gateway

NanoCore is the mediator for catalog and built-in MCP servers. It exposes `mcp.list-servers`, `mcp.list-tools`, and `mcp.call-tool` through the separately authenticated fixed Integration capability route, for the servers the immutable AEP selects plus the always-supplied built-ins; the built-ins include `openkit-work`. The direct Knowledge capability family and every other capability family remain non-callable. The existing `work_source_read` Tool can read already selected S39 Knowledge paths. The admitted `knowledge_ask` and `knowledge_tell` Tools use `openkit-work` under [Worker MCP Tool Supply](20260704-worker_mcp_tool_supply.md); they do not enable that direct capability family. Tools and MCP servers the worker configures inside its own Sandbox are not capability calls.

MCP catalog entries may represent:

- a NanoCore-spawned local MCP server
- a remote MCP server NanoCore connects to
- a built-in OpenKit capability exposed through an MCP-compatible adapter

Through the gateway, workers do not receive MCP server command lines, tokens, or remote URLs of catalog or external servers. They receive a capability id and a gateway route. A server the worker configures inside its own Sandbox is its own configuration, not something the gateway hands out.

MCP tool calls must produce `CapabilityCall`, `UsageRecord` where measurable, and `AuditEvent` records.

### MCP Item Identifier Name

An existing product-visible MCP tool-call Item uses `it` UUIDv5 with exact JSON name `["mcp", packageSnapshotId, serverId, toolName, protocolRequestId]`. Inputs are the authenticated frozen AEP snapshot, exact bound catalog server, complete tool name and native JSON-RPC request ID. Preserve the admitted string or number type of that request ID. [Protocol Identifiers And Enums](20261021-protocol_identifiers_and_enums.md#ids) supplies canonical name bytes under the [accepted complete-name declaration](../decisions/20261015-identifier_owner_declarations.md).

An approval or `work_input_request` request Item instead uses only [Pending Requests' name](20260930-pending_requests.md#deliver): `[durableRequestId, "request"]`. No nested digest, Turn-derived or MCP-specific alias supplies another product request Item. Item identity supplies neither call-start idempotency nor captured-call authority; those remain with Capability Usage Gateway Foundation and Pending Requests.

Existing Item publication, current package/declaration/authorization checks, persistence, retention, termination and unknown-effect rules remain binding. No new publication or contact trigger is added. Acceptance requires numeric/string request distinction, distinct package/server/tool inputs, one Item per durable Pending Request and unchanged at-most-once contact. Native identifiers remain opaque input values; prefixing them grants no Core identity or authority.

### Built-In Tool Derivation

Until a resource family is cut over, the descriptor, direct command dispatch, and claimed-scope agreement in the following two targets remain that family's contract.

When that resource family is cut over, the accepted target applies. Built-in worker MCP Tools are derived from the definitions and execute through invocation. [Operation Definition](20261002-operation_definition.md) owns that mechanism. This specification does not restate it. Worker supply assembly keeps capability admission and its immutable selections. Those selections include the reserved target identity and the refusal of a Workspace command, remote URL, or Plugin to replace it. Actor, execution lineage, entry scope, the private Turn, and command identities an owner derives come from the invocation context. Model-facing schemas omit those bound fields. A conflicting argument is rejected before any effect. This specification keeps the identity and semantics of the `openkit-work` tools, and it keeps the generative effect boundary its owning document already states. The family's hand-maintained descriptor is deleted in that cutover. It is not a second contract.

### Built-In Generative Target

The initial Kernel/native-UI profile selects one built-in `openkit-generative` MCP descriptor through the existing immutable AEP supply boundary. This identity is reserved for the Core-owned adapter and cannot be replaced by a Workspace command, arbitrary remote URL, or Plugin with the same display name. It offers only implemented selected operation-specific tools derived from the [Kernel](20260908-generative_kernel_data_operations.md) definitions, including its Light App catalog definitions, the [Generative UI](20260908-generative_ui_interaction.md) definitions and the supported Vault request definitions, using their shared strict request/result schemas. MCP tool names follow the [Operation Definition naming rule](20261002-operation_definition.md#names) of the [Agent-Facing Naming decision](../decisions/20261017-agent_facing_naming.md): each dot becomes an underscore and hyphens remain hyphens; the descriptor checks uniqueness. This resource family is cut over, so the accepted target under Built-In Tool Derivation applies.

Until this resource family is cut over, the authenticated package session resolves actor, Workspace, Thread, Turn, AgentSession and selected tools, claimed scope must agree and cannot override this context, and the gateway invokes the owning Core command directly. Before and after cutover, the built-in projection preserves request ID, exact operation authorization, Audit and CapabilityCall lineage, limits, and result admission, and never recursively calls its own MCP HTTP endpoint. When the family is cut over, those bound inputs and the execution seam follow Built-In Tool Derivation. No data-root mount, SQLite handle, shell command, capability family, per-app MCP process, or revival of the deleted user-facing stdio MCP package is introduced. Native UI resources are resolved by the authenticated Core/Web resource path; this slice does not add a Worker `resources/read` family. Missing implementation/selection is unavailable and is not advertised as callable. The accepted user-facing agent channel is remote MCP over the same operations under [Remote MCP Interface](20261002-remote_mcp_interface.md). The first-release user-facing Skill package is retired; the retained administrator CLI is generated at `skills/openkit-ops/scripts/openkit` and ships inside `openkit-ops` under [Agent Operator Skill](20260910-agent_operator_skill.md). Remote MCP and this administrator CLI are separate projections of the shared operations, distinct from selected Worker MCP supply. Arbitrary internal-agent MCP loading is outside this contract.

### Scheduled Poll Event Admission

A live scheduled poll Worker may call the external-event admission operation owned by [Scheduler Recurring Triggers](20260711-scheduler_recurring_event_triggers.md#external-events-through-scheduled-pull). Its built-in Tool follows Operation Definition and binds the exact schedule, actor, Workspace and source Turn from authenticated execution context. Model arguments supply only the opaque event key and bounded handling input. An ordinary unscheduled Worker, a different schedule or a stale execution cannot acquire that admission authority. The operation starts isolated ordinary Worker work; it grants no arbitrary operation invocation, self-retry, Goal creation or approval authority. The scheduler owner defines duplicate handling and retains the event-to-admission join. The existing Gateway and Pending Request owners retain all source-read and effect approval checks.

### Built-In Work Target

The reserved built-in `openkit-work` target is supplied to every worker AgentSession without manifest selection. This supply includes `automation.event-admit` and the two Knowledge Manager Tools under their existing owners. `automation.event-admit` remains callable only by a currently authorized live scheduled poll; Tool presence grants no admission. No catalog entry or Plugin can take its id or replace it with a command or URL. Until this resource family is cut over, it is dispatched in process against the authenticated package session, whose actor, Workspace, Thread, Turn, and AgentSession claimed scope cannot override. When the family is cut over, the tools execute through invocation under Built-In Tool Derivation, and this unconditional supply stays. Its seven Work-owned canonical IDs are `work.input.request`, `work.peer.list`, `work.peer.read`, `work.source.read`, `work.source.search`, `work.source.view` and `work.artifact.submit`. Their model names follow [Operation Definition](20261002-operation_definition.md#names). Its tools:
- **`work_input_request`** asks the responsible user one or more questions, using the existing `UserInputQuestionSchema`. It raises a pending user-input request under [Pending Requests](20260930-pending_requests.md) and returns at once with `isError: false`, because recording the question is its function; the structured and text content carry `status: "pending-input"`, the request id, and a next step saying that the answer arrives on a later Turn. It is not an approval and authorizes nothing. A question with `isSecret: true` is refused as `secret_input_not_supported` before any write.
- **`work_peer_list`** lists the other AgentSessions currently in the worker's own Sandbox, as opaque peer handles with their Agent and runtime, and, where the calling Turn's responsible user may read the peer's Thread, its title and whether a Turn is active. Handles are not AgentSession ids and are valid only within the calling Turn.
- **`work_peer_read`** reads one peer's bounded, product-safe projection: its recent Turns with their status and trigger, and its recent product Items (messages, plans, tool-call summaries, and status), paged and redacted as an ordinary product read. It returns only what the calling Turn's responsible user may currently read of that Thread; a peer whose Thread that user cannot read is listed only by handle, Agent, and runtime, and reading it fails `peer_not_found`. It never returns native runtime state, AgentSession identity, restricted raw evidence, or credentials, and it creates no control edge: it does not wake, steer, answer, or cancel the peer.

**`work_source_read`** previews or reads one exact `sourceFiles` or `knowledgeSelections` entry in the current accepted [Worker Context Package](20260703-worker_context_package.md#bounded-model-projection), selected only by its stable inventory `packagePath`. It reads the retained UTF-8 original or retained PDF text representation. A selected Knowledge path reads the exact selected Notebook commit through the canonical authorized Notebook reader, with its separate page digest. It never reads a caller-selected host path or current replacement body. The context-package owner sets byte and line defaults, representation and revision-bound range continuation, source size, omitted ranges, UTF-8 boundaries, coverage, and serialized envelope bounds. A descriptor or unavailable representation has no usable read cursor. Each call rechecks the live Turn, current scheduler credential, source access and receiving audience before disclosure. This projection creates no source identity, access grant, receipt or delivery lifecycle.

**`work_source_search`** searches one exact retained PDF text representation selected through the same current source admission as `work_source_read`. Lexical, exact and line-bounded regex results preserve original and representation identity, processor and PDF-page locators. Search opens no unselected source and includes at most the current default of 20 bounded snippets within the complete result envelope. The `openkit-work` argument schemas own search, peer-read, and source-path bounds. Those bounds are not Budget counters. Incomplete text-layer coverage remains incomplete; no hit count proves absence in images or unprocessed pages. The domain-free Retrieval Kernel owns matching, not source authorization or PDF parsing.

**`work_source_view`** explicitly requests one bounded image from the same accepted source inventory and current authority. It admits static PNG/JPEG originals or one explicitly selected, one-based PDF page. An optional integer crop uses original image pixels or the rotated selected-page raster at 72 dpi. The bounded processor returns one JPEG and truthful original, page, crop, processor configuration and delivered-digest facts. Success uses standard MCP text and image content blocks. It must preserve the image through the stock runtime carrier; metadata-only structured content must not replace it. Current Worker, source and destination authority are checked again after processing and before disclosure. Missing, corrupt, unsupported or revoked sources return a value-free unavailable result. The operation creates no durable source, cache, grant, receipt or new lifecycle. [Bounded Media Processors](20260713-work_resource_interaction_model.md#bounded-media-processors) owns processor bounds; complete request media admission remains separate.

**`work_artifact_submit`** intentionally submits one finished eligible file with `requestId`, canonical absolute `path`, existing Artifact `kind`, non-empty `title`, syntactically valid `mediaType`, and optional existing `materialProposal`. Workspace, Thread, Turn, AgentSession, package, physical target, slot, relative path, capture identity, digest, byte count, audience, and Artifact id come from trusted context and cannot be selected or overridden by model input. Its guidance identifies the authenticated package's eligible roots and asks the agent to finish writing before calling. It uses the existing independent NanoHost file effect during the active Turn, without a Harness operation or terminal inspection. [Worker Runtime Communication Model](20260629-worker_runtime_communication_model.md#workspace-and-artifact-plane-projections) owns capture validation, credential checks, published-byte quota, and per-call failure; [Work Resource Interaction Model](20260713-work_resource_interaction_model.md#artifact-and-item-lineage) owns publication and receipt recovery.

Success is `isError: false` with the durable Artifact id in structured and text content, after the Artifact, its exact reference Item, version-1 Review, and command receipt exist. The ordinary Artifact read can immediately inspect the committed result while the Turn remains active. It records neither pending declaration nor completion acceptance. Exact accepted request replay returns the same id without capture; changed input returns `idempotency_key_conflict`. Proved missing or invalid paths, malformed media type, invalid UTF-8 or JSON, credential matches, and size refusals return actionable product-safe Tool errors without publication for that call. A later corrected call uses a new request and may succeed in the same healthy Turn. Busy capture admission is a typed bounded refusal, not a durable queue. Missing comparison evidence, uncertain capture, or incomplete publication fails closed as `recovery_required` or the existing effect's unknown outcome, never fabricated success. Cancellation or sealing rechecks admission before publication; committed Artifacts remain, and uncommitted captures write nothing. Capability timeouts do not establish absence of an Artifact; exact receipt and public read establish the outcome. The existing Integration drain and independent heartbeat/cancellation continue unchanged.

Same-Sandbox relatedness is the boundary. Relatedness that crosses Sandboxes, or that depends on another permission, is outside this contract. Asking a peer a question is outside this contract. Each call records one `CapabilityCall`. Errors are `secret_input_not_supported`, `request_limit_reached`, `turn_not_active`, `capability_denied`, `idempotency_key_conflict`, and `peer_not_found` when the handle does not name a current co-resident. Acceptance requires the seven Work-owned Tools plus the two Knowledge Manager Tools supplied under [Worker MCP Tool Supply](20260704-worker_mcp_tool_supply.md) in discovery. Explicit image viewing must preserve actual cropped pixels, selected PDF-page pixels, provenance and the image carrier. Revocation before disclosure must withhold image and identity; processor refusal must clean staging before storage release. Synchronous submission must return only after its complete durable tuple and receipt and preserve replay, corrected-call, quota, credential, and seal predicates. A peer read must have no effect on the peer. `work_input_request` must neither stop the Turn nor close the AgentSession.

## MCP Schema Retention Baseline

MCP catalog entries should preserve enough schema evidence for replay and debugging without storing raw privileged payloads by default.

Catalog entries should retain:

- tool name or operation id
- input schema reference
- output schema reference when available
- schema version or source revision
- schema digest
- redaction policy
- replay retention policy

Capability calls should retain:

- capability id
- MCP server or adapter summary
- tool name or operation id
- input digest
- output digest when available
- redacted input summary
- redacted output summary
- schema reference and digest used for validation
- artifact or evidence references when policy retains payload evidence

Raw MCP request or response payloads should not be durable by default. If a task, policy, or debugging mode requires payload retention, the payload must be stored as governed evidence or artifact material with sensitivity labels, retention policy, and audit linkage.

## Knowledge Gateway

Under the accepted target, Knowledge capability calls are retrieval and read operations, not direct notebook access. Current Workflow Coordinator paths can record selected Knowledge references in delegation metadata, but they do not automatically bind those references or material into the AEP or worker turn. The direct `knowledge.retrieval` and `knowledge.read` families are not callable. `knowledge_ask`, `knowledge_tell`, and a selected source read are separate `openkit-work` operations.

`knowledge.retrieval` returns ranked, redacted candidates with source references and reasons.

`knowledge.read` returns selected pages, snippets, or derived representations only when policy allows the worker to see them.

Every injected or read knowledge item must be linkable to the context package trace or to a capability call record.

Knowledge retrieval is infrastructure by default. It should become item-visible only when NanoCore creates a `knowledge-injection` Item, a user-visible tool-call item, or a worker output cites the retrieved material.

## External API And Network Gateway

Gateway-mediated external API calls must use provider profiles. Independently admitted public endpoints follow [Agent Manifest And AEP Resolution](20260703-agent_manifest_aep_resolution.md), as recorded in [Public Endpoints By Admitted Grant](../decisions/20260930-public_endpoints_by_admitted_grant.md), and do not become Gateway capability calls. Provider profiles define endpoint families, credential references, allowed operations, and redaction rules.

Network gateway access is deny-by-default. It should support allowlisted hosts, methods, ports, and purpose labels.

Network gateway records should store target summaries and policy decisions, not unrestricted payloads.

## Vault-Mediated Use

The agent capability gateway projection may inject a credential into an upstream call without exposing it to the worker.

If the worker must see credential material, the injection path must be explicit, time-bounded, audited, and linked to a vault grant.

## Routing Pipeline

Each call follows this pipeline:

```text
receive request
  -> authenticate sandbox session
  -> verify lineage and package snapshot
  -> validate capability id against resolved AEP catalog
  -> validate input schema
  -> evaluate permission and policy
  -> when approval is required: capture the call, record the pending request, return a pending result
  -> resolve vault grants
  -> select upstream provider or service
  -> apply request transformers
  -> execute upstream call
  -> normalize response or error
  -> record usage and audit
  -> return redacted response
```

Failures before policy evaluation are security failures and should be redacted.

## Rate Limit And Budget Baseline

The first useful rate-limit and budget model should be gateway-local but record-shaped enough to become durable.

Minimum dimensions:

- workspace id
- thread id when available
- turn id when available
- AgentSession id
- package snapshot id
- capability id
- capability family
- provider or upstream route summary when applicable

Minimum unit classes:

- request count
- token count for LLM or text-transforming calls
- byte count for artifact, source, or network movement
- tool call count for MCP and tool routes
- normalized cost estimate when provider pricing is known

A denied call that reached authenticated policy evaluation returns `capability_rate_limited` or `capability_budget_exceeded` and records a denied CapabilityCall plus audit evidence. That enforcement is the baseline. It is not implemented. The raw-output bound does not implement it.

Request count is one baseline unit. Durable CapabilityCall rows record calls. One internal successful unmetered LLM fallback emits one request UsageRecord. That record is not an all-calls limiter. A committed row survives restart. No request-rate gate exists. A missing measurement is neither zero use nor unused quota.

LLM input, output, and total tokens are adapter-reported measurements. Total is a fallback and is not added to detailed input and output. A recorded attributed UsageRecord survives restart. Unreported generation before a crash is not recovered. No pre-dispatch token gate exists. Missing reported usage is not zero use and is not exhaustion.

Cache-read and cache-write tokens are optional provider-reported values on that same UsageRecord. An explicit reported zero may be retained. An absent value stays absent. A written record survives restart. Cache-lineage equality proves routing intent only. It does not prove a cache hit. No cache-lineage Budget gate exists.

Normalized cost is the adapter-reported cost total, emitted in USD when the provider reports it. A recorded attributed measurement survives restart. An unknown price or an unobserved generation has no reconstructed cost row. The measurement is not billing settlement. No cost gate exists.

A contacted MCP Tool emits quantity 1, category `tool`, unit `tool_calls`, and source `mcp-gateway-request-dispatched`. The shared recorder writes that measurement only when the Tool is contacted. A committed equivalent measurement survives restart. A denial before contact is not a measured Tool effect. A pending approval is not a contacted call. Missing usage is not unused quota. No tool-call allowance gate exists.

Source, artifact, and network byte movement have no single retained Budget counter. Raw-output bytes, per-file publication bounds, and per-operation caps keep their own owners. No generic byte Budget survives restart. Independently retained sizes survive under those owners.

Gateway diagnostics keep request counts and token totals per provider, model, and endpoint in process memory. The map is rebuilt empty after restart. It is not a UsageRecord and not a Budget counter. Its reset does not restore capacity. A retained UsageRecord stores the resolved provider model separately from the logical model id. An equivalent usage lookup preserves the record id. A complete ledger does not prove Budget enforcement or unobserved billed output.


## Error Model

The deferred capability routes target the following stable OpenKit codes; current MCP and built-in operation errors remain owned by Worker MCP Tool Supply and their Operation contracts:

- `capability_not_in_package`
- `capability_unavailable`
- `capability_policy_denied`
- `capability_input_invalid`
- `capability_vault_grant_missing`
- `capability_rate_limited`
- `capability_budget_exceeded`
- `capability_upstream_failed`
- `capability_unsupported_operation`

The worker receives an actionable error without raw upstream secrets or backend internals. A call that requires approval is not an error code: it returns a pending result under [Pending Requests](20260930-pending_requests.md), with `isError: true` because the tool has not executed. A current MCP call that cannot be approved returns `mcp-denied`; the deferred capability routes target `capability_policy_denied`.

## Worker Turn Trigger Source

A native Worker admission retains its known cause in the existing Protocol Turn trigger source. Direct Worker input uses user-input, a mode-selected Task handoff uses handoff, and recurring or scheduled-event admission uses automation. These values describe the entry mechanism, not the acting identity. Actor attribution, authorization, scheduler identity and event lineage retain their existing owners.

Only native admission context supplies this metadata. A model or public input cannot select it. Reusing a canonical Turn preserves its recorded trigger source, including absence; replay and restart do not infer or rewrite missing history. This adds no record, source value, execution state, repair or recovery lifecycle.


## Implementation

- `apps/nanocore/src/runtime/`
- `apps/nanocore/src/llm/`
- `apps/nanocore/src/capability/`
- `packages/worker-protocol/src/`
- `packages/worker-shim/src/`
- `packages/protocol/src/`
- `packages/config-schema/src/`

## Implementation Gaps

- Gateway request-rate and concurrency Budget - No gate consumes request measurements - #282
- Gateway token Budget - No pre-dispatch token gate exists - #283
- Gateway byte, tool-call, and cost Budgets - No gate consumes those measurements - #774
- A generalized Capability Catalog across families - Selected MCP supply is not that catalog - #330
- Policy-bound request transformers - Schema checks are not a transformer stage - #285
- `external-api` capability family - The family is not callable - #323
- Metered network capability family - The family is not callable - #284
- Generic Vault capability route - No such route is active - #774
- Diagnostic capability family - No separate diagnostic route is active - #774

## Decisions

- [Resident Request Attribution](../decisions/20260930-resident_request_attribution.md)
- [Public Endpoints By Admitted Grant](../decisions/20260930-public_endpoints_by_admitted_grant.md)
- [Identifier Derivation And Import Allocations](../decisions/20261016-identifier_derivation_and_import_allocations.md)
- [Identifier Owner Declarations](../decisions/20261015-identifier_owner_declarations.md)
- [Agent-Facing Naming](../decisions/20261017-agent_facing_naming.md)
