# Core Protocol

Status: Accepted

This document defines stable OpenKit core protocol semantics.

This document owns the product-independent protocol model shared by app clients, embedded Core, Core servers, bridge services, agent adapters, local agents, remote agents, and future agent-to-agent transports.

This document owns stable protocol records, command semantics, event families, event envelopes, lifecycle states, stream replay semantics, command idempotency semantics, error shape, protocol versioning, and schema evolution rules.

This document does not own communication topology, transport selection, bridge sidecar behavior, app-specific read models, UI convenience endpoints, storage tables, agent-runtime wire formats, provider-native payloads, or complete schema field lists.

## Purpose

The core protocol exists to represent and manage agent work regardless of which parties communicate over it.

It must support:

- explicit protocol version negotiation
- workspace lifecycle
- thread lifecycle
- turn lifecycle
- item streaming
- approval requests and decisions
- artifact events and artifact references
- agent definitions and agent session visibility
- cancellation and interruption
- resume where supported
- readable errors
- ordered event streams
- additive schema evolution

The protocol is not a raw agent-runtime protocol. ACP, A2A, MCP, Codex app-server JSON-RPC, provider SDK payloads, shell internals, and adapter-native launch payloads are outside this protocol unless intentionally projected into stable OpenKit concepts.

## Principles

- Protocol records should represent product-independent Core semantics, not transport choices or runtime-native payloads.
- Protocol messages that cross process, transport, storage replay, or package boundaries must carry enough version and ID information to be validated and replayed.
- Commands are semantic operations; endpoints, SDK names, and transport mechanics are projections.
- Live events should use one explicit envelope so clients can reason about ordering, replay, request correlation, and terminal proof.
- Strict current schemas are preferred during internal development; removed old wire shapes should fail clearly instead of being silently accepted.

## Primary Model

The primary protocol hierarchy is:

```text
Workspace
  Thread
    Turn
      Item[]
```

This hierarchy is the product model, communication model, and storage backbone.

`Workspace` is the top-level work environment and execution boundary.

`Thread` is a durable work container inside a workspace.

`Turn` is one agent-bound execution unit inside a thread.

`Item` is the append-only communication and storage atom inside a turn.

## Agent Control Model

The protocol may expose agent and agent session summaries, but it must not expose runtime-private task graphs as required core objects.

The agent control model is:

```text
Agent
  AgentSession
    Turn
      Item[]
```

`Agent` is a schedulable supply unit available in a workspace.

`AgentSession` is an initialized, reusable communication and scheduling handle between Core and an agent runtime.

OpenKit does not use `AgentRun` or `TaskRun` as core protocol objects. Execution metadata belongs on `Turn`, `AgentSession`, `Item` payloads, or implementation-specific telemetry.

## Protocol Boundary

The protocol should own:

- stable object names and IDs
- lifecycle states
- command semantics
- event families
- event envelopes
- error shape
- cancellation and interruption semantics
- resume semantics where supported
- ordering guarantees
- stream replay semantics
- command idempotency semantics
- compatibility rules

The protocol should not own:

- communication topology
- transport selection
- bridge sidecar behavior
- app-only dashboards and sidebar read models
- database table layouts
- filesystem layouts
- runtime adapter private APIs
- provider-native model payloads
- secret values
- raw tool payloads unless intentionally surfaced as product-visible items
- local process handles or container handles

## Core Records

The first stable protocol family should define records for:

- `Workspace`
- `Thread`
- `Turn`
- `Item`
- `Artifact`
- `ApprovalRequest`
- `Agent`
- `AgentSession`
- `KnowledgePage`
- `CapabilityCall`
- `UsageRecord`
- `AuditEvent`
- `ApiError`
- `EventEnvelope`
- `ServerEvent`

`TriggerSource` is not a peer Core Record; it is a `Turn` sub-field modeled as `TurnTriggerSourceSchema`. `Channel` is deferred to a future protocol family and has no schema yet.

Record schemas should be authored in the active machine-readable protocol schema package.

Skill, model, and provider routing references are deferred from the first stable protocol family until the abstract product-visible model is settled. Runtime config details belong in agent setup and server config specs, not protocol records.

## Protocol Version

Protocol messages that cross a process, transport, storage replay, or package boundary MUST carry `protocolVersion`.

`protocolVersion` is a semver string for the OpenKit core protocol, not an application release version.

Accepted protocol specs may define breaking schema changes during internal development. Core protocol docs define the versioning rules, while concrete version deltas belong in specs and schema package change records.

Required version surfaces:

- capability discovery responses
- command request envelopes
- command response envelopes
- event envelopes
- API error records
- conformance fixtures

Readers MUST reject unsupported versions and missing required version fields.

Readers SHOULD preserve unknown optional fields for the same major version only when the target schema explicitly supports forward-compatible parsing.

Patch versions MUST NOT change schema semantics.

Minor versions MAY make breaking schema changes while OpenKit remains in internal development, when an accepted spec records the decision.

## IDs

The canonical protocol ID list and ID shape rules live in `docs/core/core-concepts.md`.

Protocol IDs are opaque strings.

New Core-issued durable protocol IDs MUST be UUIDv7 strings.

Imported external IDs and provider-native IDs MUST NOT be reused as core protocol IDs. They may be stored under explicit extension namespaces.

Clients MUST NOT infer physical file paths, database table names, routing behavior, timestamps, or ownership from ID shape.

Core MUST assign durable workspace, thread, turn, item, artifact, approval, agent session, usage, audit, and capability call IDs.

Clients and channel adapters MUST assign `requestId` values for mutating commands.

Protocol timestamps MUST be RFC3339 strings assigned by Core for Core-created records and events. Event ordering MUST use `sequence`; timestamps are for human time, indexing, and cross-system correlation.

## Status Values

Lifecycle state fields should use closed enums.

Closed enums make UI behavior, storage indexes, and generated schemas stable.

Adding an enum value is a compatibility event and must be documented.

Required lifecycle families include:

- workspace status
- thread status
- turn status
- item status
- approval status
- agent session status

## Thread Semantics

A thread is a long-lived work container inside one workspace.

Threads support create, list, get, resume, and archive semantics.

Thread resume means re-entering an existing durable thread context so a client or channel can read history and submit new turns.

Thread resume MUST NOT mean restoring an agent session, sandbox snapshot, or agent-private runtime state. Runtime resume belongs to `AgentSession`.

A thread may have multiple turns over time and may involve multiple agents or agent sessions.

Thread is not an agent session and must not be coupled to exactly one runtime handle.

## Turn Semantics

A turn is one execution unit inside a thread.

A turn is assigned to one agent session when it executes.

A turn can be triggered by user input, system input, automation, retry, handoff, approval resolution, or running-work steering.

Typical terminal states are:

- `completed`
- `interrupted`
- `cancelled`
- `failed`

Non-terminal states may include:

- `pending`
- `running`
- `awaiting_human`

The core protocol does not define a `cancelling` turn state.

Interrupt and cancellation commands are asynchronous commands. Clients MAY show a local in-flight UI state while waiting for the next authoritative turn event, but Core should emit only the stable turn states listed above unless a future protocol version adds another state.

New input should use the same core input semantics across web UI, desktop UI, chat channels, and future transports.

If a thread has an active non-terminal turn, follow-up user input belongs to that turn by default unless Core or the agent adapter explicitly closes the turn first.

If a thread has no active turn, new user input starts a new turn.

### Terminal Stream Failures

Once a turn stream has started, the terminal `turn.completed` event MUST carry a `stopReason`. `stopReason` is carried on the terminal turn-completed event envelope, not as a field on the durable `Turn` record.

Failures after stream start MUST be represented as a terminal `turn.completed` event or equivalent terminal record with `stopReason: "error"` or `stopReason: "aborted"` as appropriate.

Provider, parser, timeout, and adapter failures after stream start MUST NOT leave the caller with only a half-open stream, opaque transport close, or client-side stream error.

When failure details are exposed through protocol records, they MUST be redacted and use existing stable error shapes such as `code` and `message`, or be carried on the terminal turn's existing error payload.

Pre-stream validation failures, authentication failures, authorization failures, and malformed request failures MAY remain normal request errors because the turn stream has not started.

Low-level provider clients MAY still throw provider-native or SDK-native errors.

Core adapters MUST normalize provider, parser, timeout, and adapter throws into terminal state when the stream has already started.

## Item Semantics

Items are typed units emitted during a turn.

Item events should support this lifecycle:

```text
item.created -> item.delta* -> item.completed
```

Instant items may be created and completed without deltas.

Item types may include:

- `user-message`
- `assistant-message`
- `plan`
- `reasoning`
- `command-execution`
- `file-change`
- `tool-call`
- `context-injection`
- `approval-request`
- `approval-decision`
- `user-input-request`
- `user-input-response`
- `agent-handoff`
- `artifact-reference`
- `status`

Items MAY carry `parentItemId` when an item is structurally nested under or derived from another item.

Items MAY carry `causationId` when an item was caused by a prior item, command, approval decision, handoff, retry, refinement, or capability call.

`parentItemId` describes containment or lineage. `causationId` describes cause. They are intentionally separate.

The item log is the stable replay source for user-visible and protocol-visible work.

Approval and artifact records may be materialized for query and UI convenience, but their communication source should be item-backed.

## Item Delta Kinds

OpenKit separates item lifecycle events from item-type-specific streaming updates.

Each item type MUST declare which item delta kinds it supports.

The OpenKit delta taxonomy should be easy for runtime adapters to project from native event streams while remaining OpenKit-owned.

Core item delta kinds are a closed enum:

| Delta kind | Source shape category | Meaning |
| --- | --- |
| `text-delta` | Text stream append | Append ordinary text to a text-bearing item. |
| `indexed-text-delta` | Named content-part text stream | Append text to a named or indexed content part inside an item. |
| `part-started` | Section or part boundary | Mark a new streamed part or section boundary inside an item. |
| `output-delta` | Execution output stream | Append stdout, stderr, terminal, or log output to an execution-like item. |
| `snapshot-updated` | Structured snapshot replacement | Replace a structured preview or aggregate snapshot for an item or turn-visible view. |
| `progress-updated` | Progress notification | Update non-terminal progress or review state for an item. |
| `request-started` | Pending request creation | Attach a pending request to an item while the item remains in progress. |
| `request-resolved` | Pending request resolution | Resolve or clear an item-scoped request. |
| `interaction-delta` | Interactive or realtime stream | Stream interactive terminal, voice, media, or realtime interaction content. |
| `artifact-updated` | Artifact projection update | Update artifact metadata, preview, or pointer associated with an item. |
| `context-injection-updated` | Context projection update | Record knowledge-derived context selected or injected for the turn. |

Low-level payload operations such as append, replace, and patch MAY appear inside a typed delta payload, but they are not the top-level item delta kind.

Agents and adapters MUST NOT introduce vendor-specific streaming modes by hiding them inside an existing delta kind. A new streaming mode requires a new item delta kind, a protocol compatibility note, and conformance fixtures.

Initial item-to-delta guidance:

| Item type | Delta kinds |
| --- | --- |
| `user-message` | `snapshot-updated` |
| `assistant-message` | `text-delta`, `indexed-text-delta`, `part-started`, `progress-updated`, `request-started`, `request-resolved`, `snapshot-updated` |
| `plan` | `text-delta`, `progress-updated`, `snapshot-updated` |
| `reasoning` | `text-delta`, `indexed-text-delta`, `part-started`, `progress-updated`, `snapshot-updated` |
| `command-execution` | `output-delta`, `interaction-delta`, `progress-updated`, `request-started`, `request-resolved`, `snapshot-updated` |
| `file-change` | `progress-updated`, `snapshot-updated` |
| `tool-call` | `request-started`, `request-resolved`, `progress-updated`, `snapshot-updated` |
| `context-injection` | `context-injection-updated`, `snapshot-updated` |
| `approval-request` | `progress-updated`, `snapshot-updated` |
| `approval-decision` | `snapshot-updated` |
| `user-input-request` | `progress-updated`, `snapshot-updated` |
| `user-input-response` | `snapshot-updated` |
| `agent-handoff` | `progress-updated`, `snapshot-updated` |
| `artifact-reference` | `artifact-updated`, `snapshot-updated` |
| `status` | `progress-updated`, `snapshot-updated` |

`item.delta` events MUST include `deltaKind`.

Delta payloads are selected by `deltaKind`, not by a generic string field.

Text-like delta kinds carry `delta`, `indexed-text-delta` and `part-started` carry `partId`, request delta kinds carry `requestRefId`, and artifact, context, progress, and snapshot updates carry bounded structured payloads.

`item.completed` remains authoritative. Clients MAY render streamed deltas optimistically, but they MUST reconcile the item with the completed payload.

`artifact-reference` is the canonical artifact item type. It is used when the item log needs to anchor a durable artifact record in workspace, thread, and turn history.

Adding an item delta kind is a compatibility-sensitive protocol change.

### Delta Correlation Fields

`request-started` deltas MUST include `requestRefId`.

`request-resolved` deltas MUST include the same `requestRefId` as the request they resolve.

`part-started` deltas MUST include `partId`.

`indexed-text-delta` deltas MUST include `partId` or another item-type-defined part reference that was previously introduced by `part-started` or by the initial item payload.

`requestRefId` and `partId` are item-local identifiers unless a future schema explicitly declares them as core durable IDs.

### Request Modeling Rules

Independent `approval-request` items are for session-level, permission-level, workspace-level, or cross-tool approvals.

`request-started` deltas on `tool-call`, `command-execution`, `file-change`, or similar items are for inline approval, elicitation, or review requests that belong to that specific item.

Core and adapters SHOULD avoid representing the same human decision as both an independent `approval-request` item and an inline `request-started` delta.

### Snapshot Size Rules

`snapshot-updated` is intended for bounded structured previews and aggregate state that are reasonable to resend as a whole.

Large diffs, long terminal output, long files, media, and other high-volume content SHOULD use `output-delta`, `part-started` plus indexed deltas, workspace-plane pointers, or artifact-plane pointers instead of repeated full snapshots.

If OpenKit needs fine-grained structured patching later, it should add a new explicit item delta kind instead of overloading `snapshot-updated`.

### Interaction Framing Rules

`interaction-delta` may carry text, structured interaction events, base64 payloads for small binary fragments, or pointers to workspace-plane or artifact-plane content.

Large binary content such as screenshots, audio, video, browser captures, or terminal recordings SHOULD travel through the workspace plane or artifact plane and be referenced from the delta payload.

Control-plane streams SHOULD NOT carry large binary blobs inline.

### Context Injection Rules

A turn should use at most one `context-injection` item for Core-mediated knowledge or context unless there is a clear product reason to split it.

Multiple context selections or injections during the same turn should be represented as `context-injection-updated` deltas on that item so UI clients can fold worker context cleanly.

### Delta Validation

Core MUST validate each `item.delta` against the declared item type and delta kind table for the active protocol version.

If an agent emits an undeclared item type and delta kind combination, Core MUST treat it as a protocol violation.

Protocol violations SHOULD be dropped from the product item log, recorded as audit events, and reported through a stable `core.protocol.*` error code where feedback to the caller or adapter is available.

## Approval Semantics

An approval request is represented by an item-backed `ApprovalRequest` record.

Approval flow:

```text
approval-request item -> turn awaiting_human approval gate -> approval-decision item -> turn resumes or fails
```

When a turn waits on approval, `Turn.humanGate` MUST be `{ kind: "approval", approvalRequestId, itemId }`.

Approval decisions should be explicit and auditable.

Rejected approvals should transition the turn to a safe terminal or recoverable state according to the command semantics defined by the implementation.

Approval status values should include:

- `pending`
- `granted`
- `denied`
- `expired`
- `superseded`
- `withdrawn`

## User Input Semantics

Agent questions and elicitations are represented by `user-input-request` items followed by `user-input-response` items.

Question flow:

```text
user-input-request item -> turn awaiting_human user-input gate -> user-input-response item -> turn resumes or fails
```

When a turn waits on a question or elicitation, `Turn.humanGate` MUST be `{ kind: "user-input", userInputRequestId, itemId }`.

`awaiting_human` is the only core turn state for human-gated pauses. Clients MUST choose approval UI or user-input UI from `humanGate.kind` and the referenced item type, not from the turn status string alone.

When Core receives user input for a turn that is paused on `user-input-request`, Core MUST attach that input to the active turn instead of creating a new turn.

Implementations MAY support only a subset of approval statuses, but clients should tolerate the full status family once advertised by protocol version or capability flag.

## Artifact Semantics

Artifacts are durable user-visible outputs associated with a workspace and optionally a thread or turn.

Artifact creation, updates, and references should be represented by item-backed artifact events.

Artifact records may be fetched independently through app or protocol APIs, but artifact identity and lineage must remain anchored in workspace, thread, turn, and item history.

## Event Envelope

All live protocol events should use one explicit envelope shape.

Conceptual envelope:

```ts
{
  protocolVersion: string;
  event: string;
  sequence: number;
  timestamp: string;
  workspaceId: string;
  threadId?: string;
  turnId?: string;
  requestId: string | null;
  data: unknown;
}
```

`protocolVersion` is the core protocol version used by the envelope.

`event` is the event family name.

`sequence` is monotonic within the stream scope and is assigned by Core.

`timestamp` is an RFC3339/ISO timestamp string.

`requestId` links the event to the command that caused it when such a command exists. Command-caused events MUST carry the initiating UUID request ID, while system, replay, migration, or no-clear-cause events MUST carry `null`.

`data` validates against the event-specific schema.

Raw heterogeneous events without an envelope are not part of the core protocol.

## Event Families

Core event families include:

- `workspace.updated`
- `thread.created`
- `thread.updated`
- `turn.started`
- `turn.updated`
- `turn.completed`
- `item.created`
- `item.delta`
- `item.completed`
- `approval.requested`
- `approval.resolved`
- `artifact.created`
- `artifact.updated`
- `agent.session.updated`
- `error`

Approval and artifact changes should also remain visible through item history when they affect the user-facing turn narrative.

## Ordering Guarantees

Event streams must define ordering scope.

Minimum turn-stream guarantees:

- every envelope has a monotonic `sequence` value for that stream
- events are emitted in causal order
- clients may ignore duplicate or stale events by sequence
- `turn.completed` is terminal for the turn stream

## Stream Cursor And Replay

Reconnect, replay, missed-event recovery, and backpressure rules are core protocol semantics.

For a turn stream, a `since=N` cursor means the client has processed every event through sequence `N`. Core MUST replay retained events with `sequence > N`.

If the requested cursor is older than the retained replay window, Core MUST return `core.stream.cursor_expired`.

A terminal turn event is authoritative proof that the turn stream is complete.

Status-aware HTTP replay MAY return `204 No Content` only when the reconnect cursor is already at or beyond a retained terminal event.

`204 No Content` is the only silent terminal replay signal. Opaque SSE close events, transport errors, or EventSource error callbacks are not terminal proof unless the client has already observed a terminal event.

Clients that cannot observe HTTP status MUST rely on a terminal event, a status-aware replay response, or a surfaced stream failure.

## Commands

Core commands are semantic operations, not transport-specific endpoints.

Required command families include:

- discover server capabilities
- create or update workspace
- list or read workspace resources
- create, list, read, or archive threads
- start a turn
- submit follow-up input to an active thread or turn
- interrupt or cancel a turn
- respond to an approval request
- list or read artifacts
- update artifact metadata
- list or read item history

HTTP endpoints, SDK method names, and app-specific convenience commands belong in `docs/app-api.md`, `docs/core/communication.md`, or generated client packages.

## Command Idempotency

Mutating commands and asynchronous commands MUST carry a caller-provided `requestId`.

Required `requestId` command families include:

- create or update workspace
- create, update, or archive thread
- start turn
- submit follow-up input
- interrupt or cancel turn
- respond to approval request
- create, update, or delete knowledge
- create or update artifact metadata

Core MUST deduplicate commands by request ID within a documented deduplication scope and retention window.

The deduplication key MUST include the command name, `requestId`, and the smallest stable non-secret resource scope that identifies where the command applies.

The scope SHOULD include `workspaceId` when the command is workspace-bound.

For turn-scoped commands, Core SHOULD also include `threadId` and `turnId` in the deduplication key when they are present.

For workspace creation, where no workspace ID exists before the command is accepted, Core MAY use a server-local global scope.

If a duplicate command is received while the original command is still active, Core MUST return the same accepted command result or current command status rather than creating duplicate turns, approvals, artifacts, or items.

If a duplicate command is received after the original command completed and the idempotency record is still retained, Core MUST return the current resource snapshot for the original response resource when that resource still exists.

The idempotency ledger MUST store only non-secret metadata: command name, request ID, scope IDs, a canonical input hash, response resource kind and ID, creation timestamp, and expiry timestamp.

It MUST NOT store prompts, knowledge content, context package content, provider config, OAuth state, secrets, full request bodies, or full response bodies.

If the same command, scope, and `requestId` are reused with different semantic input, Core MUST reject the request with `409` and `idempotency_key_conflict`.

## Capability Discovery

Clients should discover server capabilities before enabling interactive features.

Capability metadata may include:

- `protocolVersion`
- capability flags
- supported event families
- approval support
- interrupt support
- artifact support
- workspace resource support
- knowledge editing support
- question or elicitation support
- agent session visibility support

Capability discovery is a protocol concern; the exact endpoint is a transport projection.

Capability flags SHOULD be stable strings grouped by namespace.

Examples:

- `core.approvals`
- `core.artifacts`
- `core.interrupt`
- `core.knowledge.edit`
- `core.questions`
- `core.agent_session.visible`
- `core.stream.replay`
- `core.item_delta.snapshot_updated`
- `core.item_delta.request_started`
- `core.item_delta.interaction_delta`
- `capability.gateway`
- `vault.references`

The `core.item_delta.*`, `capability.gateway`, and `vault.references` entries are forward-looking namespace examples. Concrete implementations should advertise only the stable capability flags they actually support.

Unknown capability flags MUST be ignored by clients that do not understand them.

Conceptual discovery response:

```ts
{
  protocolVersion: string;
  capabilities: string[];
  eventFamilies: string[];
  itemTypes?: string[];
  itemDeltaKinds?: string[];
}
```

## Error Shape

Errors must be first-class protocol records.

Conceptual shape:

```ts
{
  protocolVersion: string;
  code: string;
  message: string;
  path?: string[];
  details?: unknown;
  requestId?: string;
}
```

Error codes MUST be stable namespaced strings.

Reserved namespaces include:

- `core.workspace.*`
- `core.thread.*`
- `core.turn.*`
- `core.item.*`
- `core.stream.*`
- `core.permission.*`
- `core.protocol.*`
- `agent.session.*`
- `capability.gateway.*`
- `vault.*`
- `storage.*`

Examples:

- `core.turn.not_found`
- `core.permission.denied`
- `core.protocol.version_unsupported`
- `agent.session.unavailable`
- `capability.gateway.upstream_error`

Error messages should be readable.

Clients MUST branch on `code`, not on `message`.

Secret values and provider-native sensitive payloads must not appear in protocol errors.

## Invariants

- Protocol messages that cross process, transport, storage replay, or package boundaries MUST carry `protocolVersion`.
- Core-issued durable protocol IDs MUST be opaque UUIDv7 strings.
- Clients MUST NOT infer routing, storage paths, timestamps, ownership, or provider identity from ID shape.
- Raw heterogeneous live events without the core event envelope MUST NOT be part of the core protocol.
- Mutating and asynchronous commands MUST carry a caller-provided `requestId`.
- Protocol errors MUST use stable machine-readable codes and MUST NOT leak secret values or provider-native sensitive payloads.

## Schema Source Of Truth

The machine-readable protocol source of truth should live in the active protocol schema package.

The preferred authoring stack is TypeScript and Zod, with generated JSON Schema for non-TypeScript consumers.

Schema authoring rules:

- use discriminated unions for major union types
- use stable discriminator fields such as `type`, `kind`, `status`, or `event`
- keep durable records, mutation requests, mutation responses, and event payloads as separate named schemas
- use string timestamps on the wire
- avoid schema transforms or validators that cannot be represented in JSON Schema

## Compatibility

OpenKit is currently in internal development, so protocol evolution optimizes for a strict current contract instead of retaining old wire shapes.

Current protocol validators must reject old records that omit required fields, old item deltas that omit `itemType`, old event envelopes and API error records that omit `protocolVersion`, and old command-execution items that omit `output`.

Protocol changes that alter public records, events, commands, generated schemas, conformance fixtures, or client-facing semantics require an accepted spec and a protocol version bump.

Provider-native and adapter-native fields must live under explicit extension namespaces.

Unknown optional extension sections should be ignored or preserved by readers only when the schema marks the namespace as optional.

Agent setup extension namespaces are runtime-config evolution concerns. They should be documented in agent setup specs unless a future core protocol revision promotes a stable protocol concept.

## Evolution Rules

| Change | Compatibility rule |
| --- | --- |
| Add optional field | Requires schema, fixture, and docs updates. |
| Add required field | Breaking; requires an accepted spec and version bump. |
| Add event family | Compatible only when advertised by capability discovery. |
| Add command family | Compatible only when advertised by capability discovery. |
| Add closed enum value | Breaking unless an accepted spec defines a current-client handling path. |
| Rename field | Breaking change. |
| Change field meaning | Breaking change. |
| Change ID shape | Breaking change. |
| Change timestamp semantics | Breaking change. |
| Change event ordering | Breaking change. |
| Add extension namespace | Allowed when optional and ignorable, or when an accepted spec makes it required. |

## Canonical Enums

This section is the human-readable source for core closed enum families. Generated machine-readable schemas remain the validation source for concrete implementations.

Turn status:

```text
pending
running
awaiting_human
completed
interrupted
cancelled
failed
```

Approval status:

```text
pending
granted
denied
expired
superseded
withdrawn
```

Item delta kind:

```text
text-delta
indexed-text-delta
part-started
output-delta
snapshot-updated
progress-updated
request-started
request-resolved
interaction-delta
artifact-updated
context-injection-updated
```

Agent session status:

```text
created
initializing
ready
busy
idle
degraded
suspended
interrupted
failed
closed
```

## Related Docs

- `docs/core/core-concepts.md`
- `docs/core/communication.md`
- `docs/core/storage.md`
- `docs/core/identity.md`
- `docs/core/agent-capability.md`
- `docs/core/audit.md`
- `docs/core/contract-evolution.md`
- `docs/app-api.md`
