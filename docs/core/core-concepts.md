# Core Concepts

Status: Accepted

This document owns shared top-level OpenKit core concepts, object boundaries, ownership hierarchy, scope boundaries, protocol ID namespace, and naming rules.

This document does not own specialized aspect terms, complete field lists, API endpoints, database tables, UI read models, adapter payloads, provider-specific configuration, or implementation migration plans.

Aspect documents own specialized canonical terms inside their aspect. This document routes readers to those owners and defines only the shared root concepts that other aspect documents project.

## Principles

- Shared top-level concepts should be stable enough for every aspect document to reference without redefining them.
- Aspect documents may specialize terms, but they must not create competing definitions for shared root concepts.
- Core concepts should describe product-independent semantics, not package layout, UI views, database tables, or provider payloads.
- Workspace scope is the default boundary for work, knowledge, secrets, agent supply, permissions, storage, audit, usage, and runtime resources unless another scope is explicit.
- Implementation projections must preserve the core object model even when file paths, tables, endpoints, packages, or runtime adapters change.

## Concept Map

The primary ownership hierarchy is:

```text
CoreServer
  Identity
    User
    AuthSession
    Token
    Invitation
    AutomationIdentity
    IntegrationIdentity
  User
    Workspace
      WorkspaceMember
      Thread
        Turn
          Item[]
      Channel
      TriggerSource
      Artifact
      ApprovalRequest
      KnowledgeStore
        KnowledgePage
        KnowledgeSource
        KnowledgeProposal
        KnowledgeReview
        ContextPackage
      SecretVault
      AgentCapability
        Capability
        CapabilityCall
      AgentCatalog
        AgentCatalogEntry
          AgentSetupContract
      Skill
      Model
      AgentSession
      Storage
      Permission
      Sandbox
      UsageRecord
      AuditEvent
```

Identity concepts are shown near `CoreServer` because they can exist before a user enters a workspace. `User -> Workspace` remains the ownership path for workspace data.

The primary execution relationship is:

```text
Agent
  described by AgentProfile
  supplied through AgentSetupContract
  selected through AgentCatalog
  executed by Runtime
  connected through AgentSession
  assigned to Turn
  observed through Item[]
```

The primary communication and storage backbone is:

```text
Workspace -> Thread -> Turn -> Item[]
```

Every stable core record must either belong to one workspace or explicitly declare that it is global, built in, or intentionally shared across workspaces.

## Layer Boundary

Core concepts are product-independent semantics that must stay stable across app clients, Core server implementations, agent runtimes, runtime adapters, local containers, remote agents, and future protocol bridges.

Implementation layers may project the core model into concrete endpoints, screens, tables, files, caches, adapters, launch configs, provider payloads, and diagnostics.

Implementation projections must not redefine the core object model.

Examples of implementation projections:

- App API endpoints and response payloads.
- UI read models and UI event names.
- Database tables, file paths, indexes, and cache layouts.
- Runtime-adapter methods and payloads.
- Runtime launch configs, process handles, readiness probes, and native logs.
- Provider-native config files and raw provider payloads.

## Installation Scope

### CoreServer

`CoreServer` is one running OpenKit installation or service instance.

A Core server owns global operational state such as server configuration, global indexes, built-in catalogs, user registry, workspace registry, background jobs, migrations, and server-level diagnostics.

Core server state is not the same thing as workspace state. Workspace records should not be stored only as opaque global server state unless the global record is a rebuildable index, cache, registry entry, or intentionally global object.

### User

`User` is an account-level subject above workspaces.

A user can own or access workspaces. A single-user deployment is a valid specialization of this hierarchy, but user remains part of the core model so storage, ownership, sharing, and audit records have a stable parent scope.

User is not a permission model by itself. Future role, attribute, grant, and policy semantics belong to `Permission`.

### Identity

`Identity` is the core model for users, workspace members, tokens, auth sessions, invitations, automations, and external integrations.

Identity answers who or what is acting. Permission answers whether that identity may perform an action.

Early local deployments may use one implicit user and one implicit workspace member, but the core model keeps identity explicit so multi-user workspaces can be added without redefining ownership, audit, usage, or permission records.

## Workspace

`Workspace` is the top-level OpenKit work environment.

A workspace is similar to a Slack workspace in product shape: it is the durable place where people, agents, profiles, knowledge, credentials, policies, conversations, work history, and outputs belong together.

Workspace is not just a folder, repository, chat thread, runtime session, or deployment target. It is the core ownership, namespace, storage, permission, collaboration, and execution boundary.

A workspace owns or scopes:

- threads, turns, and items
- artifacts and approval records
- workspace knowledge, notebook pages, source references, context packages, and reviewed learning
- secret vault references and credential grants
- agent catalog entries and agent setup contracts
- model profiles, skill references, MCP or tool references, and capability supply
- permission policies, sandbox defaults, and approval gates
- agent sessions and runtime state created for workspace work
- audit logs, usage records, cost records, and operational diagnostics
- workspace configuration and user or team preferences
- future members and sharing rules

Workspace is the default scope for knowledge. Knowledge may be personal, shared, project-specific, source-derived, task-derived, thread-derived, or agent-relevant inside a workspace, but it must not silently leak across workspace boundaries.

Workspace is the default scope for the secret vault. Workspace records may hold secret references, grants, injection rules, and audit metadata, while secret material stays inside the vault backend.

Workspace is the default scope for agent supply. Agent manifests, catalog entries, profiles, model choices, skills, MCP or tool configuration, resource limits, and runtime defaults are resolved relative to the workspace before an agent session is initialized.

Workspace is the default scope for permission and sandbox policy. Multi-user workspaces should later support roles, attributes, grants, approval policies, and audit trails without changing the lower-level `Thread -> Turn -> Item` model.

Workspace is the default storage partition. Durable records should be queryable by `workspaceId`, and physical storage should keep workspace data separable for backup, export, deletion, and migration.

Cross-workspace execution, knowledge sharing, vault sharing, and artifact movement are explicit features. They must not happen implicitly through agent sessions, manifests, context packages, or adapter shortcuts.

## Work Log

### Thread

`Thread` is a durable work container inside one workspace.

A thread groups related user requests, turns, items, artifacts, approvals, and agent activity over time.

Thread is the scheduling boundary for multi-agent work. A single thread may involve many agents, parallel turns, handoffs, implementation and review loops, long-running work, steering, redo, and refinement.

Thread is not a runtime session. It may use multiple agent sessions over time.

### Turn

`Turn` is one user or system initiated execution unit inside a thread.

A turn is assigned to one agent session when it executes. An agent session may execute multiple turns over time.

A turn starts from a trigger drawn from the closed trigger-source set: user-input, system-input, automation, retry, handoff, approval-resolution, or running-work-steering. Cron and webhook causes fold into automation, and redo/refinement fold into retry or user-input. A turn ends in a terminal state such as completed, interrupted, cancelled, or failed.

Turn replaces the need for a separate `AgentRun` core object. Execution metadata such as assigned agent, agent session, status, timing, usage, and error summary belongs on the turn, the agent session, item payloads, or implementation-specific telemetry.

### Channel

`Channel` is an origin surface that can submit work to Core.

Examples include web UI, desktop UI, CLI, API client, webhook, cron, automation, integration, and future chat surfaces.

A channel is not the user, not the agent, and not the transport. It is a product-facing source and routing context for commands and events.

Channel definitions may be CoreServer-level. Workspace-scoped channel records represent which channels are enabled, visible, or bound for that workspace.

### TriggerSource

`TriggerSource` is the auditable cause that starts a turn or submits input to an active turn.

The trigger source kind is a closed set: user-input, system-input, automation, retry, handoff, approval-resolution, and running-work-steering. Cron schedules and webhooks fold into automation, and redo and refinement fold into retry or user-input rather than being first-class kinds.

Turn records should preserve enough trigger source context for audit, routing, and product explanation.

Trigger source is an event cause, not an actor. User, automation, and integration identities describe who or what acted.

### Item

`Item` is the append-only communication and storage atom inside a turn.

Items form the stable event log for visible messages, reasoning summaries, tool summaries, command summaries, file changes, approval requests, approval decisions, handoffs, artifact events, status updates, and other observable work.

The item log is the source of truth for communication history and replay. Query-friendly records such as artifact indexes and approval indexes may be materialized from items, but they must not become a separate competing communication log.

OpenKit does not use `TaskRun` as a core concept. Agent-private task graphs, tool chains, retries, and telemetry should be represented as items only when they must be communicated or stored in the stable protocol.

### Artifact

`Artifact` is a durable user-visible output associated with a workspace and optionally a thread or turn.

Examples include reports, diffs, file bundles, generated assets, structured summaries, and exported documents.

Artifact records are materialized from item-backed artifact events. Artifact bytes may live in files, object storage, or another artifact backend, but artifact identity and lineage must remain workspace-scoped.

### ApprovalRequest

`ApprovalRequest` is a human-in-the-loop decision required before work continues or before a sensitive result is accepted.

Examples include permission escalation, destructive action confirmation, irreversible operation confirmation, credential-use approval, or user choice required to continue.

Approval records are materialized from item-backed approval request and approval decision events.

## Workspace Resources

### Knowledge Store

`Knowledge Store` is the workspace-owned boundary for reusable knowledge, notebook pages, source references, proposal lifecycle, review decisions, retrieval indexes, and context-package selection.

Knowledge is not runtime session state, hidden agent memory, a prompt dump, raw source storage, or a replacement for external systems of record.

`knowledge.md` owns the detailed canonical terms for Knowledge Store, Knowledge Page, Knowledge Source, Knowledge Proposal, Knowledge Review, Notebook, Agent-Near Context, Observation, and Context Package.

### SecretVault

`SecretVault` is the secure credential boundary for a workspace.

The vault stores or references secret material and exposes secret references, grants, injection rules, and audit records to Core.

Agents should receive credentials only through approved proxy, bridge, or adapter injection paths. Secret values must not appear in prompts, agent setup contracts, knowledge pages, context packages, item payloads, protocol records, or normal workspace files.

### AgentCapability

`AgentCapability` is the Core-owned runtime capability supply boundary for worker agent access to LLM providers, MCP servers, tools, external APIs, network access, knowledge bases, context retrieval, and vault-mediated credentials.

It owns the gateway projection, routing, transformer pipeline selection, credential injection contracts, context access paths, usage metering, audit metadata, rate-limit hooks, and upstream error normalization.

Agent capability is not the same thing as capability. Capability describes what can be supplied or used; agent capability defines the controlled runtime paths through which selected capabilities are supplied to worker agents. The gateway is the default implementation projection for those paths.

### CapabilityCall

`CapabilityCall` is one auditable call through an agent capability route or gateway projection.

Capability calls should preserve workspace, thread, turn, agent session, request, route, usage, vault-reference, transformer, and error context where applicable.

### Skill

`Skill` is reusable procedural guidance available inside a workspace.

Skills may be built in, installed globally, imported from packages, or defined in workspace-local configuration. An agent setup contract may request skills, and Core resolves the effective skill supply relative to the workspace.

### Model

`Model` is a workspace-visible model profile or model reference.

A model may point to a provider model, a gateway route, a local model, or a future managed model pool. Provider secrets and raw provider payloads are not part of the model concept.

### AgentCatalog

`AgentCatalog` is the workspace-visible inventory of available agent supply.

The catalog lets Core and product surfaces discover, select, route, and explain available agents without embedding adapter-native setup details into product code.

### AgentCatalogEntry

`AgentCatalogEntry` is one discovery record in an agent catalog.

It points to an agent setup contract and exposes only the summary needed for selection, routing, readiness, and UI display.

### AgentSetupContract

`AgentSetupContract` is the declarative setup file or document used to initialize and operate one agent supply unit inside a workspace.

An agent setup contract can declare identity, runtime binding, deployment options, workspace inputs, model and provider wiring, MCP or tool supply, skill or instruction supply, future knowledge or context references, future vault secret references, requirements, settings, lifecycle hints, resource limits, observability declarations, composition hints, and extension namespaces.

These are open catalog areas, not a closed field list.

### AgentProfile

`AgentProfile` is an optional setup-local profile for selecting behavior inside an agent setup contract.

If an agent setup contract declares no profile, it has one implicit default profile.

Agent profile is not a top-level core object. It exists inside the agent setup contract and is selected by turn or agent setup resolution when needed.

## Execution

### Agent

`Agent` is the schedulable supply unit that makes an agent setup contract available to OpenKit.

Agent answers what Core can select and schedule. It references setup, setup contracts, profiles, capabilities, and policy summaries, but it is not the raw runtime adapter, process, container, remote service, thread, or user-visible conversation.

### Runtime

`Runtime` is the execution substrate that materializes and manages agent sessions, resources, and isolation.

A runtime may execute agents inside a local process, local container, WASM environment, microVM, remote agent service, or remote sandbox service.

Runtime is not the agent, not the agent catalog, and not the product protocol.

### AgentSession

`AgentSession` is an initialized, reusable communication and scheduling handle between Core and an agent runtime.

An agent session can represent a local runtime process, a container-local agent connection, a remote agent connection, or a resumable runtime handle.

Agent session owns runtime liveness, health, setup snapshot identity, resume handle, effective sandbox summary, effective capability summary, and thread or workspace affinity when applicable.

Agent session belongs to the Core-to-agent control plane. It is not the bottom-level agent-running model and does not require the agent to expose its private task graph.

## Control And Safety

### Capability

`Capability` describes possible actions.

Capability answers what an agent, profile, runtime, tool, adapter, or bridge can do.

Capability is a declaration or discovered property. It does not by itself authorize the action.

### Permission

`Permission` authorizes requested actions.

Permission answers whether a subject may perform an action on a resource under current policy and context.

Permission is separate from capability and sandbox. An agent may be capable of an action, denied permission to perform it, and still be technically isolated by sandbox boundaries.

### Sandbox

`Sandbox` constrains execution.

Sandbox answers where execution runs and which filesystem, network, process, display, browser, credential, and resource boundaries apply.

Sandbox is separate from permission. Permission decides whether an action is allowed; sandbox limits what the runtime can actually reach.

## Persistence And Protocol

### Storage

`Storage` is the durable persistence model for core records, indexes, files, logs, and generated outputs.

OpenKit is file-system first. Most durable data should be stored as files or directories so workspace data remains inspectable, portable, easy to back up, easy to archive, and easy to migrate.

SQLite is a companion store for structured indexes, full-text search, vector or embedding metadata, pagination, constraints, transactions, materialized read models, and operational summaries.

The logical storage hierarchy is `CoreServer -> User -> Workspace`.

Detailed storage principles are recorded in `docs/core/storage.md`.

### UsageRecord

`UsageRecord` is a durable measurement of resource consumption.

Usage can measure tokens, requests, seconds, bytes, tool calls, capability calls, sandbox sessions, and other units.

Usage should be attributable to workspace, thread, turn, agent session, item, capability call, user, or automation context where available.

### AuditEvent

`AuditEvent` is a stable governance projection over item history, permission decisions, capability calls, vault reference use, agent session lifecycle, sandbox lifecycle, knowledge changes, and storage operations.

Audit events explain what happened, who or what caused it, which resource was affected, which policy or gateway path applied, and what the outcome was.

### Protocol

`Protocol` is the stable communication contract for core objects, commands, events, envelopes, lifecycle states, errors, cancellation, resume, ordering, and compatibility.

The protocol must not depend on whether the communicating parties are the Web UI, desktop app, Core server, runtime adapter, agent process, remote agent, ACP bridge, A2A bridge, or managed-agent service.

Concrete transport choices, event envelopes, schema names, HTTP endpoints, SSE semantics, and generated schema rules belong in `docs/core/protocol.md`, `docs/core/communication.md`, `docs/app-api.md`, or the active protocol schema package.

## Protocol IDs

This section is the canonical list of core protocol ID names. It is the reserved ID namespace, including IDs for concepts that may be promoted later.

New Core-issued durable protocol IDs MUST be UUIDv7 strings.

Protocol IDs are opaque strings. Clients MUST NOT parse IDs for timestamps, routing, storage paths, ownership, provider names, or database locations.

Common ID fields:

- `workspaceId`
- `userId`
- `workspaceMemberId`
- `authSessionId`
- `tokenId`
- `threadId`
- `turnId`
- `itemId`
- `userInputRequestId`
- `artifactId`
- `approvalRequestId`
- `agentId`
- `agentProfileId`
- `agentSessionId`
- `knowledgePageId`
- `knowledgeSourceId`
- `knowledgeProposalId`
- `knowledgeReviewId`
- `contextPackageId`
- `vaultReferenceId`
- `capabilityCallId`
- `usageRecordId`
- `auditEventId`
- `permissionDecisionId`
- `sandboxSessionId`
- `channelId`
- `triggerSourceId`
- `skillId`
- `modelId`
- `requestId`

`requestId` is caller-provided for command idempotency. Durable object IDs are Core-issued.

## Naming Rules

Product surfaces may present `Task`, `Job`, or `Deliverable` read models, but those names are projections over thread, turn, item, artifact, approval, and agent session records unless a future core document promotes one of them.

OpenKit does not use `AgentRun` or `TaskRun` as core concepts. `Turn` is the agent-bound execution unit, and `Item` is the communication and storage atom.

The bare word `Session` MUST refer only to `AgentSession` in core protocol and runtime docs.

Other session-like concepts MUST use a prefix, such as `UserSession`, `AuthSession`, `ChannelSession`, or `SandboxSession`.

Use `AgentSession` for type names, `agent session` in prose, and `agent-session` in path fragments, event families, and package filenames.

Provider-native and adapter-native fields must live under explicit extension namespaces.

Runtime config, Settings/Admin schema, diagnostics, provider config, OAuth, internal-agent diagnostics, dashboard read models, absolute local paths, worker-private paths, launch commands, and environment variables are not core protocol fields.

If they need product visibility, they must be projected as App API records, redacted summaries, sandbox summaries, workspace root references, or future promoted Core concepts.

Unknown optional manifest sections should be ignored or preserved by readers that do not understand them.

Workspace paths and manifest workspace targets should remain portable and workspace-relative where applicable.

Core concepts should evolve additively. New fields should be optional unless introduced through a new schema version, and adding closed-enum values is a compatibility event.

## Invariants

- Every stable core record MUST belong to one workspace or explicitly declare that it is global, built in, user-scoped, server-scoped, or intentionally shared.
- Workspace, thread, turn, and item MUST remain the default communication and storage backbone unless a later core revision replaces it.
- `Turn` MUST remain the agent-bound execution unit; OpenKit MUST NOT introduce `AgentRun` or `TaskRun` as default core concepts.
- `Item` MUST remain the append-only communication and storage atom inside a turn.
- The bare word `Session` MUST NOT be used for OpenKit-authored core concepts; session-like concepts need explicit prefixes.
- Provider-native and adapter-native fields MUST stay under explicit extension namespaces or implementation projections.

## Related Docs

- `docs/core/work-model.md`
- `docs/core/architecture.md`
- `docs/core/runtime-model.md`
- `docs/core/protocol.md`
- `docs/core/communication.md`
- `docs/core/storage.md`
- `docs/core/identity.md`
- `docs/core/vault.md`
- `docs/core/agent-capability.md`
- `docs/core/metering.md`
- `docs/core/audit.md`
- `docs/core/agent-supply.md`
- `docs/core/permissions.md`
- `docs/core/sandbox.md`
- `docs/core/knowledge.md`
- `docs/core/agent-session.md`
- `docs/core/agent-workflow.md`
- `docs/core/contract-evolution.md`
