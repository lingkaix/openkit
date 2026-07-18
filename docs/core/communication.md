# Communication Model

Status: Accepted

This document defines OpenKit core communication semantics.

This document owns how clients, channels, Core, agent adapters, agent runtimes, and capability services exchange commands, events, files, artifacts, and capability traffic.

This document owns communication layers, transport projections, communication planes, mediation boundaries, deployment-specific communication mapping, and transport independence.

This document does not own stable protocol records, event envelope shape, event families, command semantics, lifecycle states, stream replay semantics, command idempotency semantics, error shape, complete HTTP endpoint lists, app read models, database tables, provider-native payloads, or agent runtime private schemas.

Normative protocol semantics live in `docs/core/protocol.md`. This document may reference those semantics, but it must only define how they move across participants, planes, transports, and deployment shapes.

## Communication Layers

OpenKit communication is split into two main layers:

```text
Client / Channel <-> Core
Core / Adapter   <-> Agent Runtime
```

`Client / Channel <-> Core` is product protocol communication. It carries workspace, thread, turn, item, approval, artifact, and app-visible agent session events.

`Core / Adapter <-> Agent Runtime` is agent control communication. It initializes agent sessions, starts turns, interrupts work, receives agent events, coordinates workspace and artifact movement, and brokers capabilities.

These layers may use different transports. They share the same core concepts, but they are not the same wire protocol.

## Transport Principles

Transport choices are projections of the protocol, not the protocol itself.

The core protocol must not depend on whether a message crosses:

- HTTP
- SSE
- WebSocket
- stdio
- JSON-RPC
- Unix socket
- container exec
- SSH
- mutually authenticated service transport
- in-process function calls

The transport must preserve stable command semantics, event ordering, IDs, lifecycle states, and error shape.

## Principles

- Transport choices are projections of protocol semantics, not protocol semantics themselves.
- Communication should preserve ordering, terminal proof, request correlation, idempotency, and redaction across transports.
- Client/Core communication and Core/agent communication may use different transports, but they share the same core concepts.
- Core-to-agent work should use separate control, workspace, artifact, and capability planes rather than forcing every byte through one stream.
- Runtime mediation components are communication substrate, not business-logic owners.

## Client To Core Projection

The default UI-to-Core projection is:

- HTTP for reads, writes, and commands.
- SSE for ordered live event streaming.

HTTP and SSE are preferred for browser, desktop, embedded local server, and simple remote server scenarios because they are easy to debug, proxy, log, and validate.

WebSocket, stdio, and JSON-RPC are not the default UI-to-Core transport. They may be supported later as transport projections if they preserve the same command and event semantics.

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

All threads, turns, items, artifacts, knowledge records, agent sessions, and workspace resources are scoped by workspace.

Thread selection brings the user or channel into a durable work container. It does not imply that an agent session already exists.

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

If an HTTP request, SSE reconnect, bridge retry, agent retry, or client retry repeats the same command with the same `requestId`, Core must not create duplicate turns, items, approvals, artifacts, knowledge records, or agent sessions.

Transport-specific retry behavior is allowed only when the semantic command result remains idempotent.

## Ordering Projection

A live event stream must define an ordering scope. The protocol owns the ordering guarantees for protocol streams.

For a turn-scoped stream:

- `sequence` is monotonic within the stream
- events are emitted in causal order
- duplicate or stale events can be ignored by sequence
- `turn.completed` is terminal for that turn stream

Clients should close a turn stream only after receiving a terminal event or after a reconnect/replay path confirms the terminal state.

The normative cursor, reconnect, `204 No Content`, and opaque-close rules live in `docs/core/protocol.md`.

Reconnect and missed-event recovery should use sequence-aware replay when supported.

## Stream Cursor Projection

Streams have separate cursor scopes by stream kind.

| Stream kind | Stable cursor | Status |
| --- | --- | --- |
| Workspace stream | `(workspaceId, sequence)` | Conceptual cursor scope |
| Thread stream | `(workspaceId, threadId, sequence)` | Conceptual cursor scope |
| Turn stream | `(workspaceId, threadId, turnId, sequence)` | Conceptual cursor scope |
| Agent session stream | `(workspaceId, agentSessionId, sequence)` | Conceptual cursor scope |

Concrete live stream availability belongs in protocol and communication specs.

The protocol owns sequence semantics, replay semantics, cursor-expired errors, and terminal replay rules.

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
Core -> Client: turn.updated running | failed | cancelled
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

These planes have different shapes and should not be forced through one transport.

The adapter chooses a transport per plane based on agent setup contract, deployment mode, runtime capability, and workspace policy.

## Control Plane

The control plane starts agent sessions, starts turns, interrupts turns, receives agent events, and tracks lifecycle state.

Governed workers use an authenticated direct NanoCore control connection. A capability gateway, proxy, backend relay, or sandbox-local alias MUST NOT become an alternative worker-control path.

Inside a governed Codex-like worker, the shim may adapt NanoCore control into a runtime-native structured protocol such as JSON-RPC over stdio. Container exec, SSH, sockets, or backend APIs may support lifecycle and diagnostics, but they do not replace the direct worker-control contract.

For ACP-native, A2A-native, SDK-native, or future runtimes, the adapter may use that runtime's structured control protocol directly.

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

Capability calls should carry audit metadata such as agent session ID, workspace ID, thread ID, turn ID, and request ID where practical.

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
- persisting sensitive responses
- implementing business logic

## Deployment Projections

The same communication planes can map to different deployment modes.

### Local Container

In local-container mode, the agent runs in a container on the same machine as Core.

Typical mapping:

- Control: authenticated direct NanoCore worker control.
- Workspace: bind mount.
- Artifact: bind mount.
- Capability: disabled unless the Agent Environment Package explicitly projects a governed gateway route.

### Remote Agent

In remote-agent mode, the agent runs in a different controlled environment.

Typical mapping:

- Control: authenticated direct NanoCore worker control over an explicitly reachable endpoint.
- Workspace: remote bind mount, rsync, object store, or workspace service.
- Artifact: remote bind mount, rsync back, object store, or artifact pointers.
- Capability: disabled unless the Agent Environment Package explicitly projects a governed gateway route.

Remote placement may use deployment-managed tunnels or routing to make the direct NanoCore control endpoint reachable. Those deployment mechanisms do not become a second control protocol or product-state owner.

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
- which agent session executed it
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
- Capability mediation components MUST NOT carry worker-control traffic, choose models, decide provider fallback, own rate limits, decide tool visibility, persist sensitive responses, or implement business logic.

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
