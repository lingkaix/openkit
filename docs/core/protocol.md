---
status: Accepted
---
# Core Protocol

This document defines stable OpenKit core protocol semantics.

This document owns the product-independent protocol model shared by app clients, embedded Core, Core servers, bridge services, agent adapters, local agents, remote agents, and future agent-to-agent transports.

This document owns stable protocol records, command semantics, event families, event envelopes, lifecycle states, stream replay semantics, command idempotency semantics, error shape, protocol versioning, and schema evolution rules.

This document does not own communication topology, transport selection, runtime mediation behavior, app-specific read models, UI convenience endpoints, storage tables, agent-runtime wire formats, provider-native payloads, or complete schema field lists.

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
- Agent definitions and internal AgentSession lineage
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

`docs/core/core-concepts.md` owns the `Workspace -> Thread -> Turn -> Item[]` hierarchy and the canonical definitions of those records. Protocol projects that model into commands, events, lifecycle states, replay, and error semantics without redefining it.

## Agent Control Model

The protocol may carry AgentSession records for authorized internal coordination, persistence replay, audit, and operator diagnostics, but ordinary App API and client projections MUST NOT expose AgentSession as a conversation, navigation object, identifier, history, picker, or action.

`docs/core/runtime-model.md` owns the relationship between Agent, AgentSession, and worker Turn, while `docs/core/agent-session.md` owns AgentSession identity and continuity. Protocol may carry their stable internal records and redacted operator summaries but does not redefine their runtime semantics or expose private task graphs.

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
- runtime mediation behavior
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

`docs/core/core-concepts.md` owns `TriggerSource` as a Turn sub-field and keeps `Channel` outside the current record family. Protocol schemas project that ownership without introducing peer records.

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

`docs/core/core-concepts.md` owns the stable rule that Core identifiers are opaque and must not encode consumer-visible routing, ownership, storage, provider, or time semantics.

The machine-readable protocol schema and accepted design define the concrete ID fields, encodings, allocation, and validation for each record family. Owning record writers implement that contract. The protocol does not impose one universal ID encoding or reserve speculative IDs for concepts that have no current record.

Imported external IDs and provider-native IDs MUST NOT be reused as core protocol IDs. They may be stored under explicit extension namespaces.

Clients MUST NOT infer physical file paths, database table names, routing behavior, timestamps, or ownership from ID shape.

Core MUST assign the IDs of Core-owned durable records according to their owning schema and accepted specification.

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
- AgentSession status

## Thread Semantics

A thread is a long-lived work container inside one workspace.

Threads support create, list, get, resume, and archive semantics.

Thread resume means re-entering an existing durable thread context so a client or channel can read history and submit new turns.

Thread resume MUST NOT mean restoring an AgentSession, Sandbox snapshot, or Agent-private runtime state. AgentSession continuity remains an internal runtime concern.

A Thread may have multiple sequential Turns and historical AgentSessions over time, but it has at most one current AgentSession and one non-terminal Turn.

Thread is not AgentSession and must not be coupled to exactly one runtime handle. An ordinary client continues a Thread or creates a new Thread; it never chooses or creates AgentSession.

## Turn Semantics

`docs/core/core-concepts.md` owns the `Turn` definition. This section owns its protocol lifecycle, command, gate, and stream semantics.

A Turn executed by a worker or other schedulable Agent is assigned internally to exactly one AgentSession. A Core-local service Turn may execute with `agentSessionId=null` only when its owning accepted workflow contract forbids worker, scheduler, Sandbox, and AgentSession effects and names the app-local service and durable result owners; a provider capability call alone does not create an AgentSession.

A turn can be triggered by user input, system input, automation, retry, handoff, approval resolution, or running-work steering.

The complete Turn terminal-state set is:

- `completed`
- `interrupted`
- `failed`

Non-terminal states may include:

- `pending`
- `running`
- `awaiting_human`

The core protocol does not define a `cancelling` turn state.

Interrupt and cancellation commands asynchronously request interruption; cancellation does not create a distinct terminal state. Clients MAY show a local in-flight UI state while waiting for the next authoritative Turn event, but Core emits only the stable Turn states listed above.

New input should use the same core input semantics across web UI, desktop UI, chat channels, and future transports.

If a Thread has an active non-terminal Turn, follow-up user input is accepted only through that Turn's exact human gate or an owning active-work delivery contract. The gate attaches its response to the same Turn. A delivery contract may queue, apply, convert, or reject input only as its accepted specification defines; without either owner, Core returns the typed busy or unavailable error before Item, queue, command, Turn, or scheduler writes.

If a thread has no active turn, new user input starts a new turn.

A Turn is created after its command, Thread, trigger, and required dependencies are accepted. Item appends and lifecycle transitions update it until exactly one terminal state is recorded. A terminal Turn is never reopened or rewritten; retry or recovery creates a new Turn under fresh admission and preserves the earlier terminal record. Missing dependencies fail before creation, and stale, replayed, conflicting, or wrong-owner commands MUST NOT create, retarget, duplicate, or terminalize a Turn. After restart, Core reconstructs current status and single-flight admission from durable Turn and Item records; runtime memory or a transport close is not authority.

### Turn Interruption

Interruption is append-only. Every finalized Item remains unchanged, the Turn becomes terminal `interrupted`, and no Item or effect is rolled back, rewritten, or deleted. The Item in flight is finalized from content already accumulated by Core and marked truncated rather than discarded.

For a media channel, truncation records what Core generated, not what the user heard, saw, or otherwise perceived. The durable record MUST NOT assert delivery beyond the channel's own authoritative evidence.

An interrupt request conflicts with an already terminal Turn and MUST NOT alter it. Missing, stale, duplicated, or dependency-failed interrupt requests follow ordinary command idempotency and error semantics and MUST NOT manufacture a terminal outcome. After restart, Core may finish interruption only from the durable request and exact Turn lineage; otherwise it preserves the existing state or reports recovery required instead of inferring success. Observable completion requires the exact terminal Turn and finalized Item history, including the truncated marker when an Item was in flight.

### Terminal Stream Failures

Once a turn stream has started, the canonical exact-owner terminal-affiliated envelope defined by Stream Cursor And Replay MUST carry a `stopReason` in its `turn-completed` payload. `stopReason` is carried on that envelope, not as a field on the durable `Turn` record.

Failures after stream start MUST be represented by that canonical exact-owner terminal-affiliated envelope or an equivalent terminal record with `stopReason: "error"` or `stopReason: "aborted"` as appropriate.

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
approval-request item -> turn awaiting_human approval gate -> approval-decision item -> owning contract chooses continuation or terminal closeout
```

When a turn waits on approval, `Turn.humanGate` MUST be `{ kind: "approval", approvalRequestId, itemId }`.

Approval decisions should be explicit and auditable.

Approval decisions transition the Turn only through the owning accepted contract; protocol does not infer resume, cancellation, or failure from the status alone.

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
user-input-request item -> turn awaiting_human user-input gate -> user-input-response item -> owning contract chooses continuation or terminal closeout
```

When a turn waits on a question or elicitation, `Turn.humanGate` MUST be `{ kind: "user-input", userInputRequestId, itemId }`.

`awaiting_human` is the only core turn state for human-gated pauses. Clients MUST choose approval UI or user-input UI from `humanGate.kind` and the referenced item type, not from the turn status string alone.

When Core receives user input for a Turn that is paused on `user-input-request`, Core MUST attach that input to the same Turn instead of creating a new Turn. The owning accepted contract then decides whether that Turn continues `running` or closes as `completed`, `interrupted`, or `failed`.

Implementations MAY support only a subset of approval statuses, but clients should tolerate the full status family once advertised by protocol version or capability flag.

## Artifact Semantics

Artifacts are durable user-visible outputs associated with a Workspace and, when produced or communicated through work, an exact Thread, Turn, and Item lineage.

Work-produced Artifact creation, every work-produced mutation, and every Thread communication MUST be represented by the exact Item-backed lineage defined by the owning specification. A governed Workspace-only import or registration MAY initially keep Thread and Turn null only when the Artifact carries the explicit immutable provenance defined by that specification; it MUST NOT masquerade as user or agent work output.

Artifact records may be fetched independently through app or protocol APIs. Workspace identity and immutable origin remain authoritative before communication, while the first Thread introduction and every later work-produced mutation create exact Item-backed lineage without rewriting the Workspace-only origin.

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
- only the canonical exact-owner terminal-affiliated envelope defined by Stream Cursor And Replay is terminal proof for the turn stream

## Stream Cursor And Replay

Reconnect, replay, missed-event recovery, and backpressure rules are core protocol semantics.

For a turn stream, a `since=N` cursor means the client has processed every event through sequence `N`. Core MUST replay retained events with `sequence > N`.

If the requested cursor is older than the retained replay window, Core MUST return `core.stream.cursor_expired`.

A turn-stream envelope is terminal-affiliated when either its event marker is `turn.completed` or its payload discriminator is `turn-completed`.

Terminal affiliation and its disposition MUST NOT create a protocol schema, protocol record, durable state, or independent creation, update, recovery, or termination lifecycle; the existing Turn lifecycle remains authoritative, and this rule classifies only validation, cursor, delivery, and stream-processing behavior.

A terminal-affiliated envelope is the canonical exact-owner terminal only when both markers are present, its embedded `Turn` passes the applicable protocol schema with status `completed`, `interrupted`, or `failed`, and both the envelope and embedded `Turn` match the subscribed Workspace, Thread, and Turn exactly. A canonical exact-owner terminal is authoritative proof that the turn stream is complete.

A terminal-affiliated envelope is valid but semantically noncanonical when it passes the forward-compatible outer-envelope schema and every applicable embedded-record schema but does not satisfy every canonical exact-owner terminal condition. A client MUST validate the outer envelope and every applicable embedded record before advancing the cursor or deciding delivery.

After validation, the existing sequence rule remains unchanged: a client MAY ignore a stale or duplicate envelope whose sequence is at or below the current cursor. A valid semantically noncanonical terminal-affiliated envelope above the cursor MUST advance the cursor, MUST be withheld from consumer delivery, MUST NOT count as terminal proof, and MUST allow processing to continue or reconnect from the latest cursor so a later canonical exact-owner terminal can be delivered.

An invalid outer envelope or applicable embedded record MUST NOT advance the cursor, be delivered, or be treated as a semantically withheld event. The validation failure MUST terminate the current subscription's active stream attempt and all automatic reconnect or further transport processing for that subscription, and it MUST NOT terminalize the Turn.

After such a validation failure, the failed subscription exposes no private cursor as recovery authority, performs no automatic recovery, and adds no public recovery shape. A later caller-created subscription supplies only a caller-owned `since` value or no `since`, and it may fail again until an authoritative read establishes usable state or a compatible client-server upgrade is installed.

Observable conformance branches are:

- A canonical exact-owner terminal above the cursor advances the cursor, is delivered once as terminal proof, and ends subscription processing.
- A valid semantically noncanonical terminal-affiliated envelope above the cursor advances the cursor, produces no consumer event or terminal proof, and permits a later canonical exact-owner terminal through continued processing or replay from that advanced cursor.
- An invalid outer envelope or applicable embedded record leaves the cursor unchanged, produces a validation failure rather than a delivered or silently withheld event, stops automatic reconnect and further processing, and leaves Turn terminality to an authoritative record.
- A validated stale or duplicate envelope remains ignorable under the existing sequence rule and does not alter terminal proof.

When the client cursor is already at or beyond a retained canonical exact-owner terminal, a transport MAY project terminal replay without sending another event, but only as an explicit status-aware confirmation. An opaque connection close, transport error, or callback is never terminal proof by itself. Core Protocol owns the classification, cursor, delivery, termination, and recovery semantics above; `docs/core/communication.md` and client contracts own only their concrete projections and MUST preserve them.

## Commands

Core commands are semantic operations, not transport-specific endpoints.

Required command families include:

- discover server capabilities
- create or update workspace
- list or read workspace resources
- create, list, read, or archive threads
- start a turn
- submit input through an exact user-input human gate or an active-work delivery command defined by an accepted owning specification
- interrupt or cancel a turn
- respond to an approval request
- list or read artifacts
- invoke an Artifact mutation command only where an accepted owning specification defines it
- list or read item history

Concrete HTTP endpoints, app-specific commands, and SDK method names belong to their accepted owning specifications and executable projections in shared schemas, route registrations, and generated clients. `docs/core/communication.md` retains transport semantics.

## Command Idempotency

Mutating commands and asynchronous commands MUST carry a caller-provided `requestId`.

Required `requestId` command families include:

- create or update workspace
- create, update, or archive thread
- start turn
- submit input through an exact user-input human gate or an accepted active-work delivery command
- interrupt or cancel turn
- respond to approval request
- create, update, or delete knowledge
- invoke an Artifact mutation command only where an accepted owning specification defines it

Core MUST deduplicate commands by request ID within a documented deduplication scope and retention window.

The deduplication key MUST include the command name, `requestId`, and the smallest stable non-secret resource scope that identifies where the command applies.

The scope SHOULD include `workspaceId` when the command is workspace-bound.

For turn-scoped commands, Core SHOULD also include `threadId` and `turnId` in the deduplication key when they are present.

For workspace creation, where no workspace ID exists before the command is accepted, Core MAY use a server-local global scope.

A completed command receipt is the default replay authority. Replay projects current state from the authoritative result owners rather than reconstructing an earlier response byte for byte, and callers may re-query those owners.

If a duplicate command is received while an explicit accepted in-progress owner exists, Core MAY return that owner's current status rather than creating duplicate turns, approvals, artifacts, or items. An in-progress owner does not authorize Core to infer a completed receipt.

If request-owned effects exist without a completed receipt, Core MUST return `recovery_required` without repeating an effect, inferring a winner, synthesizing a receipt, or adding a settlement, repair, or recovery workflow. An accepted owning contract MAY permit the identical request to resume only an explicit in-progress operation whose complete immutable request-owned proof that contract defines is present. Missing, partial, or contradictory proof returns `recovery_required`. A bounded resume does not extend receipt metadata or establish precedent for another command.

The idempotency ledger MUST store only non-secret metadata needed to bind the immutable command identity and semantic input to authoritative result owners. It MUST NOT store business content or a response-body snapshot, drive a business transition, replace an owning record, or become a command lifecycle.

Baseline completed-receipt metadata is a closed set: command name, caller `requestId`, the smallest stable non-secret scope identifiers, canonical semantic-input hash, response resource kind and id, `createdAt`, and `expiresAt`. It MUST NOT contain an arbitrary result, request body, or HTTP response snapshot. An accepted command-specific owner MAY define only a closed non-authoritative replay-metadata exception that creates no precedent for another command.

By default, `expiresAt` MUST be exactly seven days after `createdAt`. An accepted bounded exception MAY instead tie retention to an exact explicit in-progress owner. While that exact owner exists, the retained receipt remains valid replay authority. When no such exception is active, a receipt is replay authority only before expiry; at `referenceTime >= expiresAt`, it MUST be treated as absent and MAY be pruned. Ordinary expiry absence and pruning resume after the in-progress owner terminates. Expiry, or the end of the bounded exception, MUST NOT authorize inferred success or response reconstruction: existing request-owned effects without a valid completed receipt follow `recovery_required`.

If the same command, scope, and `requestId` are reused with different semantic input, Core MUST reject the request with `idempotency_key_conflict`.

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
- product-safe runtime availability support

Capability discovery is a protocol concern; the exact endpoint is a transport projection.

Capability flags SHOULD be stable strings grouped by namespace.

Examples:

- `core.approvals`
- `core.artifacts`
- `core.interrupt`
- `core.knowledge.edit`
- `core.questions`
- `core.runtime.availability`
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
- Core-issued durable protocol IDs MUST conform to their owning schema and remain opaque to consumers.
- Clients MUST NOT infer routing, storage paths, timestamps, ownership, or provider identity from ID shape.
- Raw heterogeneous live events without the core event envelope MUST NOT be part of the core protocol.
- Mutating and asynchronous commands MUST carry a caller-provided `requestId`.
- Command replay MUST use the central receipt-and-current-owner policy; without a completed receipt, Core MUST NOT repeat completed effects or infer or synthesize success, and only an explicit accepted in-progress owner may resume its exact request. Every other incomplete or contradictory state MUST fail as `recovery_required`.
- A Thread MUST NOT have more than one non-terminal Turn.
- A Turn MUST terminate only as `completed`, `interrupted`, or `failed`, and a terminal Turn MUST NOT be reopened or rewritten.
- Interruption MUST preserve finalized Items and finalize server-accumulated in-flight content as truncated without claiming unsupported media delivery.
- Protocol errors MUST use stable machine-readable codes and MUST NOT leak secret values or provider-native sensitive payloads.

## Schema Source Of Truth

The active protocol schema package MUST hold the machine-readable protocol source of truth.

Schema authoring rules:

- use discriminated unions for major union types
- use stable discriminator fields such as `type`, `kind`, `status`, or `event`
- keep durable records, mutation requests, mutation responses, and event payloads as separate named schemas
- use string timestamps on the wire

## Compatibility

OpenKit is currently in internal development, so protocol evolution optimizes for a strict current contract instead of retaining old wire shapes.

Current protocol validators MUST reject removed wire shapes rather than silently accepting them. Concrete retired shapes belong in their owning specifications, change records, and conformance fixtures.

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

AgentSession status:

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

`created`, `initializing`, `ready`, `busy`, `idle`, `degraded`, and `suspended` are non-terminal AgentSession statuses and therefore identify current continuity for the bound Thread. `interrupted`, `failed`, and `closed` are terminal and historical; a terminal AgentSession MUST NOT transition back to a non-terminal status. Successor creation requires no non-terminal AgentSession for that Thread.

## Related Docs

- `docs/core/core-concepts.md`
- `docs/core/communication.md`
- `docs/core/storage.md`
- `docs/core/identity.md`
- `docs/core/agent-capability.md`
- `docs/core/audit.md`
- `docs/core/contract-evolution.md`
- `docs/app-api.md`
