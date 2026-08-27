---
status: Accepted
---
# Communication Model

This document defines OpenKit core communication semantics.

This document owns how clients, channels, Core, agent adapters, agent runtimes, and capability services exchange commands, events, files, artifacts, and capability traffic.

This document owns communication layers, transport projections, communication planes, mediation boundaries, deployment-specific communication mapping, and transport independence.

This document does not own stable protocol records, event envelope shape, event families, the semantics of individual typed commands, lifecycle states, abstract stream replay or terminal-proof semantics, command idempotency semantics, error shape, complete HTTP endpoint lists, app read models, database tables, provider-native payloads, or agent runtime private schemas. It does own the interaction classification that distinguishes conversation, observation, and command before transport projects an owning operation, plus the concrete HTTP and SSE projection of replay semantics.

Normative protocol semantics live in `docs/core/protocol.md`. This document may reference those semantics, but it must only define how they move across participants, planes, transports, and deployment shapes.

## Communication Layers

OpenKit communication is split into two main layers:

```text
Client / Channel <-> Core
Core / Adapter   <-> Agent Runtime
```

`Client / Channel <-> Core` is product protocol communication. It carries Workspace, Thread, Turn, Item, Approval, Artifact, and product-safe runtime-availability events. It does not expose AgentSession identity or lifecycle to an ordinary client.

`Core / Adapter <-> Agent Runtime` is agent control communication. It initializes AgentSessions, starts turns, interrupts work, receives agent events, coordinates workspace and artifact movement, and brokers capabilities.

These layers may use different transports. They share the same core concepts, but they are not the same wire protocol.

## Transport Principles

Transport choices are projections of the protocol, not the protocol itself.

The core protocol MUST NOT depend on whether communication is in-process or crosses a governed local, remote, isolation, or authenticated service boundary.

The transport must preserve stable command semantics, event ordering, IDs, lifecycle states, and error shape.

## Principles

- Within OpenKit, the term `plane` is reserved for logical communication concerns and does not name an OpenKit-owned product, service, host, deployment target, authority, or failure domain. Core's named OpenKit communication planes are Control, Workspace, Artifact, and Capability; qualified external terminology and generic logical data-plane or communication-plane descriptions remain permitted.
- Transport choices are projections of protocol semantics, not protocol semantics themselves.
- Communication should preserve ordering, terminal proof, request correlation, idempotency, and redaction across transports.
- Client/Core communication and Core/agent communication may use different transports, but they share the same core concepts.
- Core-to-agent work MUST preserve separate control, workspace, artifact, and capability semantics even when multiple planes share one physical connection, process, or transport session.
- Runtime mediation components are communication substrate, not business-logic owners.

## Client To Core Projection

The default UI-to-Core projection is:

- HTTP for reads, writes, and commands.
- SSE for ordered live event streaming.

HTTP and SSE are preferred for browser, desktop, embedded local server, and simple remote server scenarios because they are easy to debug, proxy, log, and validate.

NanoCore projects this Client/Core surface through its App HTTP/1.1 listener. The separate NanoHost rendezvous listener accepts only its private native HTTP/2 carriage; it is not a Client/Core endpoint. The App listener rejects that private carriage, and the NanoHost listener rejects App API, Gateway, diagnostics, authentication, and SSE requests. A deployment frontend may proxy the App listener but MUST NOT proxy or synthesize the NanoHost physical connection.

Other client transports MAY be supported as governed projections if they preserve the same command and event semantics.

## Capability Discovery Projection

A client begins by discovering Core capabilities before enabling transport or UI affordances that depend on optional protocol support.

Conceptual flow:

```text
Client -> Core: discover capabilities
Core -> Client: protocolVersion, capabilities, event families, interactive features
```

The capability discovery command, capability flags, response shape, and protocol-version semantics are defined in `docs/core/protocol.md`.

Communication owns when and where discovery is performed, not the fields returned by discovery.

For HTTP/SSE projections, clients SHOULD perform discovery before opening long-lived streams or showing controls for approvals, interrupts, artifacts, knowledge editing, or question/elicitation flows.

The exact endpoint shape belongs to app or transport documentation.

## Workspace And Thread Flow

A client selects or creates a workspace before starting work.

Conceptual flow:

```text
Client -> Core: list or create workspaces
Client -> Core: read workspace
Client -> Core: read workspace resources
Client -> Core: list, create, read, or re-enter threads
```

All threads, turns, items, artifacts, knowledge records, AgentSessions, and workspace resources are scoped by workspace.

Thread selection brings the user or channel into a durable work container. It does not imply that an AgentSession already exists.

## Turn Communication Flow

A turn is the active execution unit inside a thread. Stable turn semantics and lifecycle states are defined in `docs/core/protocol.md`.

Conceptual start flow:

```text
Client -> Core: start turn with input and requestId
Core -> Client: turn accepted
Client -> Core: subscribe to turn event stream
Core -> Client: ordered events until terminal turn event
```

Communication projections MUST preserve the protocol distinction between command acceptance and terminal turn proof.

Interrupt and cancellation commands may be accepted before the turn is terminal. Clients should treat the turn as terminal only after a terminal turn event or equivalent read-model state appears.

## Interaction Semantics

Every accepted user interaction MUST be projected as exactly one of three semantic classes before it can affect product or external state:

- `conversation` produces advice, explanation, drafting, or clarification and has no work-state or external effect by itself.
- `observation` reads actor-authorized durable state or source observations and has no mutation authority.
- `command` invokes an exact typed operation with an authenticated actor, exact target, expected effect, current authorization, current-state preconditions, request and causation identity, required decision strength, delivery rule, and authoritative outcome.

These classes describe the interaction boundary, not three durable entities or three new lifecycle machines. The typed command's owner remains the unique authority for its operation, resource lifecycle, idempotency, conflict handling, delivery, and result. A channel, client, Assistant, model, or parser may propose the class and exact command, but it cannot create command authority from natural language.

### Classification Lifecycle

Classification is created for one accepted input and terminates when that input produces conversation output, an observation result, a typed command preview or outcome, or a bounded clarification. It is not updated in place after an effect begins. A materially changed request, clarified answer, replacement target, or retry is classified again against current state and retains causation to the earlier interaction where applicable.

Conversation and observation terminate without mutation. A command proposal terminates without effect when the user rejects it, the required decision is absent, or its owner refuses it. An accepted command follows its owning lifecycle and MUST NOT be reported as applied, completed, or recovered until that owner returns the corresponding authoritative outcome.

Progress questions MUST use observation rather than injecting a message into active work. Conversation may recommend a command but MUST NOT imply that the recommendation changed state. Ambiguous consequential language MUST produce a preview or clarification rather than a guessed mutation.

### Conflict, Failure, And Recovery

Missing actor, target, effect, authorization, current-state precondition, request identity, confirmation, delivery contract, or owning command prevents command acceptance. A stale, incompatible, terminal, busy, conflicted, rejected, failed, interrupted, or unknown result is preserved exactly; a client or model MUST NOT retarget the command, infer application, or translate it into success.

Transport loss after command submission is not evidence that no effect occurred. Retry uses the same request identity when seeking exact replay and a new request identity only when the user requests a genuinely new attempt under the owning command contract. Restart reconstructs classification context from durable Items, current resource state, and accepted command lineage rather than channel memory or provider memory.

Contradictory human intent is not a communication arbitration problem. The authenticated human who supplied the accepted input is the actor of its Item or command, and that actor plus request lineage MUST be preserved through every projection. NanoCore serializes accepted transitions and applies authorization, stale-state, safe-point, revision, and effect rules, but it does not decide which human is socially correct, distinguish disagreement from a change of mind, or introduce consensus, priority, or veto semantics.

### Observable Acceptance

- Asking for an explanation or status MUST NOT change a Plan, priority, Worker context, scheduler state, resource lifecycle, or external system.
- A consequential natural-language request MUST expose its exact target and effect through the decision form required by `docs/core/permissions.md` before admission.
- Every accepted command MUST preserve actor and request lineage and expose the owning accepted, queued, delivered, applied, rejected, stale, conflicted, failed, interrupted, unknown, or otherwise typed outcome without client inference.
- Reconnect, retry, and channel replacement MUST reconstruct from durable owners and MUST NOT duplicate an effect or rely on hidden channel or provider state.

## Active-Turn Input Projection

Communication does not define a generic active-turn input route or safe-point policy. A transport may carry input to an active Turn only through that Turn's exact human gate or an active-work delivery contract defined by an accepted owning specification.

The transport MUST preserve the contract's target identifiers, request correlation, result, and typed failure. Clients, channel adapters, and transport bridges MUST NOT infer queueing, application, follow-up creation, or safe points.

## Item Streaming Projection

The item lifecycle, item types, delta kinds, and validation rules are defined in `docs/core/protocol.md`.

Communication owns how item events are delivered over live streams and how stream clients reconcile live state with durable reads.

Transport projections MUST preserve item event order within the relevant stream scope.

Transport projections SHOULD carry high-frequency item deltas without forcing large workspace files, media, or artifacts through the control stream.

Clients should reconcile optimistic streaming state with the authoritative completed item payload defined by the protocol.

## Event Envelope Projection

All live events use the core event envelope defined in `docs/core/protocol.md`.

The envelope is required across transport projections.

Raw heterogeneous streaming payloads are not part of the core communication model.

Strict protocol schemas remain the conformance source of truth. Browser and SDK live-stream parsers MAY use a forward-compatible envelope parser that accepts unknown event names or unknown event payloads as bounded inspectable data so additive stream extensions do not crash the client.

## Command Reliability Projection

Transport projections MUST preserve command idempotency semantics from `docs/core/protocol.md`.

Communication owns retry placement and transport failure handling, not the idempotency ledger definition.

If an HTTP request, SSE reconnect, bridge retry, agent retry, or client retry repeats the same command with the same `requestId`, Core must not create duplicate turns, items, approvals, artifacts, knowledge records, or AgentSessions.

Transport-specific retry behavior is allowed only when the semantic command result remains idempotent.

## Ordering Projection

A live event stream must define an ordering scope. The protocol owns the ordering guarantees for protocol streams.

For a turn-scoped stream:

- `sequence` is monotonic within the stream
- events are emitted in causal order
- duplicate or stale events can be ignored by sequence
- only the canonical exact-owner terminal-affiliated envelope defined by Core Protocol Stream Cursor And Replay is terminal proof for that turn stream

Clients should close a turn stream only after receiving that canonical exact-owner terminal-affiliated envelope or after a reconnect/replay path confirms the same terminal state.

Status-aware HTTP replay MAY return `204 No Content` only when the reconnect cursor is already at or beyond a retained canonical exact-owner terminal-affiliated envelope. In the HTTP/SSE projection, that status is the only silent terminal replay signal. Opaque SSE close events, transport errors, or EventSource error callbacks are not terminal proof unless the client has already observed that canonical envelope.

Clients that cannot observe HTTP status MUST rely on the canonical exact-owner terminal-affiliated envelope or a surfaced stream failure. A status-aware replay client may also rely on the explicit HTTP response above. A protocol-validation failure closes the active transport and makes that subscription hard-incompatible: it exposes no private recovery cursor, performs no automatic recovery, and adds no public recovery shape. A later caller-created subscription supplies only a caller-owned `since` value or no `since`, and it may fail again until an authoritative read establishes usable state or a compatible client-server upgrade is installed.

## Stream Cursor Projection

Streams have separate cursor scopes by stream kind.

| Stream kind | Stable cursor | Status |
| --- | --- | --- |
| Workspace stream | `(workspaceId, sequence)` | Conceptual cursor scope |
| Thread stream | `(workspaceId, threadId, sequence)` | Conceptual cursor scope |
| Turn stream | `(workspaceId, threadId, turnId, sequence)` | Conceptual cursor scope |
| Internal or operator AgentSession stream | `(workspaceId, agentSessionId, sequence)` | Conceptual cursor scope; never ordinary App API discovery or navigation |

Concrete live stream availability belongs in protocol and communication specs.

The protocol owns sequence semantics, abstract replay semantics, cursor-expired errors, and terminal-proof rules. Communication owns only their transport projection, including the HTTP `204 No Content` confirmation and the rule that an opaque SSE close is not proof.

Transport projections SHOULD expose replay as a `since` cursor or equivalent field when retained events are available.

Compaction MUST NOT change the meaning of already emitted item IDs, turn IDs, or completed item payloads.

Compaction MAY replace fine-grained deltas with a completed item snapshot when the resulting item state is equivalent for replay.

## Approval Communication Flow

Approvals are item-backed protocol records defined in `docs/core/protocol.md`.

Conceptual flow:

```text
Core -> Client: item.created approval-request
Core -> Client: turn.updated awaiting_human with approval gate
Client -> Core: respond to approval
Core -> Client: item.created approval-decision
Core -> Client: turn.updated running | failed | interrupted; denial remains distinguishable through the approval-decision Item and terminal stopReason
```

Approval decisions must be auditable.

Communication projections MUST deliver approval requests and decisions through the same ordered item stream used for the surrounding turn.

## Artifact Communication Flow

Artifacts are item-backed durable outputs defined in `docs/core/protocol.md`.

Conceptual flow:

```text
Agent/Core produces artifact
Core records artifact event item
Core materializes artifact record
Client reads artifact list or artifact detail when needed
```

Artifacts may be transferred or stored through a separate artifact plane, but the product-visible event remains item-backed.

## Error Handling

HTTP-style commands, streaming transports, agent control streams, and bridge calls should normalize user-visible failures into the protocol error shape.

Stream errors do not necessarily terminate a turn. The turn is terminal only when a terminal turn event or read-model state says so.

Error payloads must not leak secrets, provider-native sensitive payloads, raw credentials, or sandbox internals.

## Core To Agent Planes

Core-to-agent communication is split into four planes:

```text
Control    - small streaming control messages, turn events, approvals, interrupts
Workspace  - user files, source trees, data inputs, attachments
Artifact   - generated outputs, reports, diffs, bundles, assets
Capability - LLM, MCP, vault, knowledge base, external APIs, network proxy
```

These planes have different owners, authorization scopes, payload bounds, ordering needs, retry rules, and failure semantics. They MUST remain logically distinct, but two or more planes MAY share one physical connection, process, or transport session when the projection preserves those differences and prevents traffic from being interpreted under another plane's authority.

The adapter chooses a transport projection for each plane based on the owning `AgentManifest` defined by `docs/core/agent-supply.md`, deployment mode, runtime capability, and workspace policy. One projection MAY carry multiple planes, but shared carriage MUST NOT create a shared token, permission scope, payload limit, retry rule, failure meaning, or protocol owner.

## Control Plane

The control plane starts AgentSessions, starts turns, interrupts turns, receives agent events, and tracks lifecycle state.

Governed workers use one authenticated end-to-end worker-control contract. A transport intermediary MAY carry that contract over a shared connection, but it MUST preserve the worker-control identity, ordering, correlation, replay, and failure semantics and MUST NOT create an alternative worker-control contract or authority.

An adapter MAY project worker control into a governed runtime-native structured interface. Deployment, lifecycle, capability, and diagnostic mechanisms MUST NOT replace or reinterpret the worker-control contract.

Screen scraping and keystroke-only adapters are not the default communication model because they cannot reliably preserve approvals, interrupts, item boundaries, and lifecycle events.

## Workspace Plane

The workspace plane moves or exposes source files, data files, attachments, and other agent inputs.

Workspace data should not travel through the control stream.

Deployment-specific strategies may include:

- direct filesystem access
- bind mount
- rsync
- object store
- remote workspace service

Workspace ingress should be coordinated at turn boundaries or session setup boundaries.

## Artifact Plane

The artifact plane moves generated outputs back to Core and the app.

Artifact bytes should not travel through the control stream unless they are intentionally small inline previews.

Deployment-specific strategies may include:

- direct filesystem access
- bind mount
- rsync back
- object store
- artifact pointer stream

Artifact egress should produce item-backed artifact events in the product protocol.

## Capability Plane

The capability plane lets agents access LLM providers, MCP servers, external APIs, vault-mediated credentials, knowledge bases, and network proxy services.

Agents should use standard local interfaces where possible, such as OpenAI-compatible endpoints, MCP endpoints, HTTP proxy endpoints, or KB endpoints.

Vault credentials should be injected outside the agent's prompt context and should not become visible to agent memory, files, manifests, or item payloads.

Capability calls should carry audit metadata such as AgentSession ID, workspace ID, thread ID, turn ID, and request ID where practical.

Detailed gateway semantics belong to `docs/core/agent-capability.md`.

## Capability Mediation Boundary

A future capability mediation component may project Core capability services into a worker environment when the runtime cannot call those services directly.

The component is communication substrate, not the agent runtime, worker-control path, or business-logic owner.

Mediation responsibilities may include:

- expose local capability endpoints to the agent
- establish or accept a secure connection according to the deployment strategy
- forward capability requests
- apply Core-owned transformer pipeline decisions
- support vault credential injection outside agent context
- forward audit metadata
- surface upstream failures as standard errors

Mediation non-responsibilities:

- choosing models
- deciding provider fallback
- owning rate limits
- deciding which tools are visible
- deciding which capabilities exist or remain available
- persisting sensitive responses
- owning product, workflow, or approval state
- deciding permission policy
- owning credentials, metering, or usage attribution
- implementing business logic

A capability mediation responsibility is not a worker-control owner and not a worker agent. The same outer transport projection or process MAY also carry a separately authenticated worker-control plane, but the capability mediation responsibility MUST NOT inspect, authorize, synthesize, retry, or reinterpret worker-control messages. Co-location and shared carriage MUST NOT change which participant owns a decision.

## Deployment Projections

The same communication planes can map to different deployment modes.

Deployment chooses transports; `docs/core/architecture.md` owns the invariant that deployment does not change Core semantics. The communication consequence is that the control, workspace, artifact, and capability planes MUST stay distinct in every mode even when they share one physical network path, one host, one container network, or one tunnel. Sharing infrastructure is a transport decision; merging planes is a semantic change and is not one.

### Local Container

In local-container mode, the agent runs in a container on the same machine as Core.

Typical mapping:

- Control: authenticated end-to-end worker control over the deployment-selected projection.
- Workspace: bind mount.
- Artifact: bind mount.
- Capability: disabled unless the Agent Environment Package explicitly projects a governed gateway route.

### Remote Agent

In remote-agent mode, the agent runs in a different controlled environment.

Typical mapping:

- Control: authenticated end-to-end worker control over the deployment-selected projection.
- Workspace: remote bind mount, rsync, object store, or workspace service.
- Artifact: remote bind mount, rsync back, object store, or artifact pointers.
- Capability: disabled unless the Agent Environment Package explicitly projects a governed gateway route.

Remote placement may use deployment-managed transport infrastructure to carry worker control. That infrastructure does not become a second control protocol or product-state owner.

## Transport Independence

The agent process should be as deployment-mode agnostic as practical.

A well-adapted agent should see stable local conventions such as:

- a workspace directory
- model or LLM endpoint environment variables
- MCP endpoint configuration
- proxy endpoint configuration
- structured control input and output

Whether Core is server-side, desktop-embedded, local, or remote should be absorbed by adapter and bridge layers.

## Audit

Communication should be auditable across planes.

Audit records should be able to answer:

- which workspace initiated the action
- which thread and turn caused it
- which AgentSession executed it
- which capability or external resource was used
- whether a vault reference was used
- which transformer or policy path applied
- which artifact or item resulted

Audit is a cross-cutting communication requirement, not a separate transport.

## Invariants

- Communication transports MUST preserve stable command semantics, event ordering, IDs, lifecycle states, error shape, and redaction requirements.
- Raw heterogeneous streaming payloads MUST NOT replace the core event envelope for live product events.
- Client and channel adapters MUST NOT infer active-turn delivery outcomes beyond the exact human-gate or accepted active-work delivery result returned by Core.
- Workspace bytes and artifact bytes SHOULD NOT travel through the control stream except for intentionally small inline previews.
- Capability mediation responsibilities MUST NOT own, inspect, authorize, synthesize, retry, or reinterpret worker-control traffic; choose models; decide provider fallback; own rate limits; decide tool visibility or capability availability; persist sensitive responses; own credentials, metering, or usage attribution; decide permission policy; own product or workflow state; or implement business logic. A shared outer transport or process may carry the separately authenticated control plane without transferring those responsibilities.
- Transport and deployment-mode choices MUST preserve the deployment-semantic invariant owned by `docs/core/architecture.md`.
- Control, workspace, artifact, and capability planes MUST remain distinct in every deployment shape, including shapes where they share physical network infrastructure.
- Sharing one connection, process, or transport session MUST NOT merge plane tokens, permission scopes, payload limits, ordering, retry rules, failure semantics, or protocol ownership.

## Related Docs

- `docs/core/core-concepts.md`
- `docs/core/protocol.md`
- `docs/core/runtime-model.md`
- `docs/core/storage.md`
- `docs/core/agent-supply.md`
- `docs/core/agent-capability.md`
- `docs/core/vault.md`
- `docs/core/audit.md`
- `docs/app-api.md`
