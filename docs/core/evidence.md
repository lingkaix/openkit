---
status: Accepted
---
# Evidence

This document defines OpenKit evidence semantics for what is recorded and with which authority across four record classes: Audit, Usage and metering, Capture Coverage, and Telemetry.

This document owns audit projection semantics, auditable activity categories, audit producer boundaries, `AuditEvent` record areas, audit data safety, audit source-of-truth guidance, `UsageRecord`, capability-call usage units and attribution, system-wide measurement principles (`System-wide measurement`, `Non-gateway measurement`, `Aggregation`, `Cost projection`), `Capture Coverage`, and the non-authoritative diagnostic boundary for `Telemetry`.

This document does not own item history, permission policy, capability-call routing, vault secret storage, sandbox containment, storage layout, protocol schemas, UI audit dashboards, provider usage semantics, billing policy, provider pricing, budget enforcement, runtime implementation details, or persistence, retention windows, deletion, and storage classes of these records (`docs/core/storage.md` Layer 1). `Workflow Evidence`, `EvidenceBundle`, and the `decision-evidence` metadata field keep their owners and are not redefined here.

## Audit

This section defines OpenKit audit semantics.

Audit records are stable projections used to explain what happened, who or what caused it, which policy or gateway path applied, and which workspace objects were affected.

### Audit Purpose

OpenKit coordinates human users, automations, agents, AgentSessions, vault references, capability calls, permissions, sandbox modes, files, artifacts, and knowledge.

Audit gives Core a durable way to answer safety, debugging, review, and governance questions without requiring every product surface to replay raw item logs.

### Audit Principles

- Audit explains actions, actors, policy or gateway paths, affected resources, and outcomes; it does not measure consumption or replace item history.
- Core owns the durable audit projection even when adapters, bridges, gateways, or agents attach audit metadata.
- Audit should store references, summaries, hashes, stable IDs, or redacted excerpts rather than secret values or unrestricted raw payloads.
- Audit should be queryable without becoming a second user conversation log.
- Missing audit producers in early implementations must be explicit scope limits, not ambiguous product promises.

### Audit Boundary

Audit is a projection over core activity.

Audit events may be derived from:

- items
- capability calls
- permission decisions
- vault reference use
- AgentSession lifecycle events
- sandbox lifecycle events
- execution-substrate epoch lifecycle events
- knowledge lifecycle events
- storage migrations or imports

The item log remains the communication history. Audit records are queryable governance records and must not become a second user conversation log.

### Audit Producers

Core is responsible for producing audit events at stable enforcement and coordination boundaries.

Core MUST write or enqueue an audit event for:

- permission decisions
- capability calls
- vault reference use
- approval decisions
- Workspace invitation, membership, role, ownership-transfer, recovery, and deletion decisions
- user disable, deletion, and credential-revocation decisions
- AgentSession lifecycle changes
- sandbox lifecycle changes
- execution-substrate epoch invalidation, and the readiness that returns that substrate's capacity
- knowledge entry creation, archival, supersession, or injection
- artifact publication
- destructive storage operations

Adapters, bridges, gateways, and agents may attach audit metadata, but Core owns the durable audit projection.

If an implementation intentionally omits a class of audit event, it should document that omission in product scope rather than silently presenting audit as complete.

### AuditEvent

`AuditEvent` is the conceptual record for auditable activity.

Minimum stable areas include:

- audit event ID
- `protocolVersion`
- workspace ID
- stable actor reference when an actor exists
- non-secret authenticated credential kind and credential record id when available
- subject reference when the affected subject differs from the actor
- `category`
- action
- resource summary
- outcome
- `severity`
- `summary`
- timestamp
- request ID when available
- optional thread ID
- optional turn ID
- optional item ID
- optional agent ID
- optional AgentSession ID
- optional capability call ID
- optional permission decision ID
- optional invitation or membership ID
- optional error code

For a command-initiated Assistant inference call, an available command request ID is retained in the AuditEvent request ID even when the CapabilityCall per-invocation request ID is null; a Turn link does not replace that available audit value.

These are model areas, not a complete field list. The reason is recorded in [Assistant Inference Request Lineage](../decisions/20261015-assistant_inference_request_lineage.md).

### Audit Data Safety

Audit records must avoid storing secret values, raw provider payloads, sensitive sandbox internals, or unrestricted file contents.

An execution substrate's private epoch identity, process identifiers, roots, sockets, and backend handles are sensitive runtime internals under `docs/core/runtime-model.md`. An audit record for an epoch boundary carries the classification, the outcome, the elapsed time, and redacted lineage; it must not promote private substrate identity into a product-visible field or make an epoch a user-facing lifecycle.

Audit should store references, summaries, hashes, stable IDs, or redacted excerpts where needed.

An audit actor uses the `ActorRef` semantics from `docs/core/identity.md`. Display names and email addresses may appear only as redacted point-in-time summaries; they are not durable actor identifiers. The optional `authentication` summary retains `credentialKind` (`local`, `session` or `token`) and a nullable `credentialId`. The id identifies the presented access Token or canonical authentication Session record. If session authentication supplies no canonical Session record id, an available resolved administrative Token id is retained; otherwise the id is null. A local identity uses null. Actor identity does not replace credential identity: incident review must still identify actions made through a revoked credential. The summary contains no entry channel, secret material, authorization headers, cookies, Token hashes, or invitation secrets. Historical credential identity grants no authority and remains historical during Workspace export and import.

### Audit Source Of Truth

`docs/core/storage.md` owns persistence and source-of-truth placement. Audit owns the semantic projection, query, filtering, and retention requirements independently of the storage mechanism.

Where possible, audit events should retain links back to item IDs, capability call IDs, permission decision IDs, vault reference IDs, and other related core records.

Every admitted interception participant invocation MUST leave durable evidence through existing Audit, Policy and linked effect owners, including observation, advice, failure and timeout. Evidence identifies the binding/provider versions, actor/delegation, safe input/output references and actual outcome; a transformation retains safe references to both versions without storing secrets. No second transcript or interception ledger is required.

Decision Trace is a derived read-only view over retained identifier edges, with current permission checks per node and explicit missing links. It MUST NOT invent provenance from text, time or model rationale, or become another record authority. The [BWM support decision](../decisions/20261018-bwm_support_and_information_consolidation.md) records this later view and the pre-stable provenance direction; implementation is Not Started.

### Audit Invariants

- Audit records MUST NOT store secret values, raw provider payloads, sensitive sandbox internals, or unrestricted file contents.
- Audit MUST remain a governance projection over core activity, not a second user conversation log.
- Product surfaces MUST NOT claim complete audit coverage when an implementation intentionally omits an audit producer class.
- Audit events SHOULD retain stable links back to item IDs, capability call IDs, permission decision IDs, vault reference IDs, AgentSession IDs, or related core records when those records exist.
- Auditable shared mutations and terminal human decisions MUST preserve the winning actor reference, responsible user when applicable, target resource, request ID, outcome, and timestamp.
- Membership, ownership, credential, and permission changes MUST be auditable even when the affected user later becomes disabled, removed, or deleted.
- Core MUST own durable audit projection; adapters, bridges, gateways, and agents may only provide metadata or source events.
- An execution substrate's own private failure or diagnostic record is a source input, never the durable audit projection, and MUST NOT be treated as an audit record or as authority for a recovery, readiness, or capacity decision.
- An audit record for an execution-substrate epoch boundary MUST NOT make private substrate identity a product-visible field or substitute for AgentSession identity.

## Usage And Metering

This section owns `UsageRecord`, capability-call usage units and attribution, and the system-wide principles for measuring resource consumption, including runtime, storage, and network usage that is not naturally defined by one agent-capability-mediated call.

### Metering Purpose

OpenKit needs to explain resource consumption across agent work without confusing measurement with billing, audit, or policy.

`mediation.md` owns the capability gateway boundary and the gateway's obligation to produce usage for a `CapabilityCall`. This section owns the canonical `UsageRecord`, capability-call usage units and attribution, the measurement policy applied across capability and non-gateway producers, how runtime, storage, and network measurements join that record family, cross-producer aggregation, and cost projection.

### Metering Principles

- Measurements represent observed consumption in explicit units. They are not inferred prices or independent billing truth.
- Every measurement should retain the narrowest available work and actor attribution without inventing identity that the producer cannot prove.
- Capability-mediated usage is produced at the Mediation boundary; Metering extends the same attribution and record principles to non-gateway resources.
- Coarse units must not be presented as finer measurements they did not observe.
- Audit remains separate from metering. Metering measures consumption; Audit explains actions, actors, policy paths, affected resources, and outcomes.
- Cost and budget decisions must be derived from measured units and explicit policy or pricing inputs.

### Metering Canonical Terms

`UsageRecord` is the conceptual record for measured consumption.

Typical ownership areas include:

- workspace ID
- thread ID
- turn ID
- item ID
- capability call ID
- agent ID
- AgentSession ID

Concrete usage schema fields belong in protocol specs and audit or usage specs, not in this core concept document.

`System-wide measurement` means an observed quantity of runtime, storage, network, or capability consumption recorded in an explicit unit with available work attribution.

`Non-gateway measurement` means measured consumption whose natural producer is a runtime, storage workflow, repository workflow, scheduler, or other governed subsystem rather than an external capability gateway call.

`Aggregation` means combining compatible measured units across attributable scopes without changing their meaning or losing their source lineage.

`Cost projection` means a derived estimate that applies explicit pricing or allocation rules to measured usage. It is not an independent source-of-truth record, and a provider-reported monetary value such as USD does not by itself constitute a full cost projection.

### Usage Metering

Agent-capability-mediated calls are the current owner boundary for OpenKit usage records.

The gateway projection should be able to explain what resources were consumed by a capability call and which workspace, thread, turn, item, agent, and AgentSession caused that consumption.

Agent capability usage units should be explicit.

Common agent capability units include:

- tokens
- requests
- bytes
- tool calls
- capability calls
- network requests
- provider-native billable units

Provider-native units may be preserved under extension namespaces, but normalized units should be available for product surfaces.

### Usage Attribution

Usage should be attributable to the smallest stable scope available.

Preferred attribution order:

1. capability call
2. item
3. turn
4. AgentSession
5. thread
6. workspace

Records may carry multiple IDs so usage can be aggregated at different levels.

Capability usage is not the same thing as audit.

Usage measures resource consumption. Audit explains who caused an action, which policy or gateway path applied, which resource was affected, and what outcome resulted. The agent capability path may emit both usage and audit metadata, but the Audit section above owns the durable governance projection across Core.

### Metering Boundaries And Non-Goals

Metering does not decide whether an action is authorized, whether a budget permits work, how a provider prices tokens, or whether a measured event is billable.

Metering does not replace Audit, Runtime, Storage, Sandbox, Scheduler, or Mediation ownership. Each subsystem remains responsible for the lifecycle and meaning of the event it measures.

Metering does not require all resources to share one unit. Aggregation must preserve unit meaning and must not combine incompatible quantities into a misleading total.

Metering does not store secret values, raw provider payloads, unrestricted file contents, or backend-private runtime handles.

### Metering Invariants

- Every measurement MUST use an explicit unit and MUST preserve its producer and available work attribution.
- Measurements with incompatible units MUST NOT be summed as one quantity.
- Coarse measurements MUST NOT be presented as duration, compute, traffic, or retained-storage measurements they did not observe.
- Capability-call producer semantics MUST remain canonically defined by `mediation.md`; this document MUST own `UsageRecord`, usage attribution, cross-producer measurement policy, and aggregation.
- Metering MUST remain separate from Audit, authorization, budget enforcement, and billing.
- Cost projections MUST derive from measured usage plus explicit pricing or allocation inputs; provider-reported monetary values MUST NOT be presented as a full pricing or allocation projection on their own.
- Metering records MUST NOT store secret values, raw provider payloads, unrestricted file contents, or backend-private runtime handles.
- Retries and replay MUST NOT double count the same measured consumption when the producer declares an idempotent identity.
- New measurement families SHOULD preserve attribution to workspace, thread, turn, item, AgentSession, capability call, user, automation, or external effect when those scopes are provable.

### Metering Abstract Realization Notes

An implementation may use one shared durable usage ledger for gateway and non-gateway producers, provided every producer preserves its own category, unit, source, attribution, and idempotent identity.

System-wide reporting may aggregate compatible records by workspace, actor, workflow lineage, capability, provider, or time window. Reports should keep raw measured units inspectable and label every derived cost or allocation separately.

Budget enforcement should consume accepted measurements through a policy boundary. It should not mutate historical quantities or turn estimated cost into observed usage.

## Capture Coverage

The resolved effective capture setting is fixed at Turn admission, before any work governed by that setting starts ([Protocol](protocol.md#turn-semantics)). A later change of the setting takes effect at the next Turn. An already-started Turn is never interrupted for an ordinary capture-setting change, and no mid-Turn interrupt path for that change exists or may be introduced.

Capture Coverage defaults to on as the decided target under [Storage](storage.md#agent-data-retention-and-deletion) and the [retention completeness decision](../decisions/20261019-work_data_retention_completeness.md). Today the implementation defaults are off until the final activation ([full model I/O switch decision](../decisions/20260921-full_model_io_switch_default_off.md)): earlier default-off capture conserved storage, and the current implementation remains partial with explicit named completeness gaps across default-on resolution, gateway native exchanges and streaming chunks, shared message/prompt/tool deduplication, default verbatim worker transcripts and bounded stderr/logs, context delivery lineage, judgment lineage, and journal step facts. Default-on intent never proves complete delivery, and neither a new default nor a new collector backfills or reconstructs an absent historical fact.

The resolved setting is a system-level effective setting resolved across `server -> workspace -> task` to `off` or `on`, with an explicit lower setting remaining possible. The admission-time pair `{scope, value}` MUST be stored as immutable historical content on the control-store Turn record owned by [Storage](storage.md#source-of-truth) before governed work starts. Even under an explicit `off` override, required configuration identity and metadata remain mandatory, while missing or unsupported collectors and failed captures are recorded as explicit gaps rather than silently omitted or treated as non-occurrence.

## Telemetry

`Telemetry` is diagnostic, non-authoritative, and lossy operational information—traces, metrics, and correlated logs—built on OpenTelemetry under the [telemetry as internal logs decision](../decisions/20261019-telemetry_as_internal_logs.md) and the [durable execution decision](../decisions/20261019-durable_execution_and_control_store.md).

Operational telemetry is optional, potentially incomplete diagnostic information; it never becomes product state, permission, audit or acceptance authority ([Architecture](architecture.md#observation-and-agent-assisted-improvement)). Telemetry is never an authority for work state. Execution history retains lifecycle timing, outcomes and failed checks through the existing work-data owners; operational spans are projections of those facts, journal correlation identifiers grant no execution, access or cleanup authority, and telemetry loss cannot erase work history or determine retry ([Fault Tolerance](fault-tolerance.md#durable-execution)).

Runtime-private task graphs, retries, and telemetry remain private unless an owning document promotes a stable projection ([Core Concepts](core-concepts.md#turn), [Runtime Model](runtime-model.md#turn)). Execution metadata belongs on the turn, AgentSession, item payloads, artifact records, approval records, or implementation telemetry ([Runtime Model](runtime-model.md#turn)). Dropping or disabling the diagnostic sink changes no retained work record, and product work remains functional when telemetry capture is disabled, local diagnostic files are deleted, a Collector is absent, or export fails.

## Relationships To Other Core Aspects

`mediation.md` owns the capability gateway boundary, provider and tool usage production, and the gateway's obligation to produce usage and audit metadata for a `CapabilityCall`. This document owns `UsageRecord`, capability-call usage units and attribution, system-wide aggregation with other producers, every cost projection derived from them, and the `AuditEvent` accountability projection and action history.

`protocol.md` owns when the resolved Capture Coverage setting is fixed at Turn admission.

`runtime-model.md`, `agent-session.md`, and `sandbox.md` own execution and isolation lifecycles that may produce runtime measurements and audit events.

`storage.md` Layer 1 owns persistence, source-of-truth placement, retention classes, retention windows, and deletion of these records; this document owns only measured storage consumption and the semantic record definitions.

`communication.md` and `mediation.md` own network and external-call semantics; this document owns only measured consumption and audit projections derived from those effects.

`policy.md` owns authority and `PermissionDecision`, while budget enforcement remains a policy projection over measured usage rather than a Metering decision.

## Related Docs

- `docs/core/core-concepts.md`
- `docs/core/architecture.md`
- `docs/core/fault-tolerance.md`
- `docs/core/runtime-model.md`
- `docs/core/agent-session.md`
- `docs/core/agent-workflow.md`
- `docs/core/protocol.md`
- `docs/core/communication.md`
- `docs/core/storage.md`
- `docs/core/identity.md`
- `docs/core/policy.md`
- `docs/core/vault.md`
- `docs/core/mediation.md`
- `docs/core/sandbox.md`
- `docs/core/knowledge.md`
- `docs/decisions/20260921-full_model_io_switch_default_off.md`
- `docs/decisions/20261015-assistant_inference_request_lineage.md`
- `docs/decisions/20261018-bwm_support_and_information_consolidation.md`
- `docs/decisions/20261019-work_data_retention_completeness.md`
- `docs/decisions/20261019-durable_execution_and_control_store.md`
- `docs/decisions/20261019-telemetry_as_internal_logs.md`
