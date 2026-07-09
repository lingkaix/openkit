# Core Architecture

Status: Accepted

This document defines the stable OpenKit architecture boundaries.

This document owns the stable App/Core/Agent layer boundary, the Core coordination boundary, the agent execution boundary, the adapter translation boundary, internal Core role boundaries, workspace-service boundaries, and top-level data ownership rules.

This document does not own package layout, app endpoints, database tables, agent-native protocols, deployment-specific launch commands, protocol record schemas, communication transports, runtime session continuity, or sandbox backend details.

It consolidates the durable architecture from earlier design docs into the core layer.

## Principles

- Core coordinates work; agents execute work; adapters translate between Core semantics and runtime-native protocols.
- Product-visible truth belongs in Core-owned records, item history, artifacts, approvals, knowledge, audit, and stable projections rather than in agent-private state.
- Implementation packages, backends, launch commands, provider payloads, and UI routes are projections of the architecture, not the architecture itself.
- Deployment shapes, containers, release artifacts, and managed runtimes are projections of the architecture. They must not change Core ownership or product-state semantics.
- Internal Core roles are coordination roles. They must not become user-selectable worker agents or hidden execution runtimes by default.
- Workspace services should expose governed Core APIs instead of raw storage, provider, sandbox, or adapter internals.

## Architecture Shape

OpenKit uses an `App + Core + Agent` architecture.

```text
App / Channel
  <-> Core
      <-> Agent Adapter
          <-> Agent Runtime
```

Core owns coordination. Agents own execution. Adapters translate between Core semantics and runtime-native agent protocols.

## Layers

### App And Channels

Apps and channels are user interaction surfaces.

Examples:

- Web UI
- desktop app
- future chat integrations
- future automation integrations

Apps and channels submit user or system input, render item streams, display artifacts, collect approvals, and expose workspace resources.

They must not redefine core concepts.

### Core

Core is the orchestration and coordination layer.

Core owns:

- workspace registry
- thread, turn, and item lifecycle
- agent selection and scheduling
- agent session coordination
- approval flow
- artifact registration
- knowledge retrieval and context injection policy
- permission decisions
- sandbox policy summary
- agent capability routing and gateway projection
- vault reference mediation
- storage coordination
- audit and usage records

Core should remain a coordination plane, not a heavy execution runtime.

### Agent Adapter

Agent adapters translate Core operations into runtime-native operations.

Adapters may own:

- agent startup
- native protocol client
- event translation
- runtime-specific setup materialization
- interruption and cancellation translation
- workspace and artifact plane coordination
- health checks
- diagnostics

Adapter-native details must stay behind the adapter boundary unless intentionally projected into stable Core records.

### Agent Runtime

Agent runtimes execute work.

Runtime families may include coding agents, review agents, browser agents, custom agent processes, containerized agents, and remote managed agents.

Agents produce items, artifacts, approval requests, and status through Core translation. They should not become the source of truth for workspace history.

## Control And Execution Boundary

Core should own coordination:

- intake
- routing
- scheduling
- status tracking
- handoff coordination
- result collection
- review coordination
- knowledge retrieval and context-package coordination
- permission and approval gates

Agents should own execution:

- coding
- research
- browser operation
- shell execution
- long-running tool loops
- domain-specific workflows
- artifact production

This boundary keeps Core stable while allowing agent runtimes to evolve independently.

## Agent Capability

Core may supply agent capabilities through gateway projections for agent access to external systems.

Examples:

- LLM provider gateway
- MCP gateway
- tool gateway
- knowledge-base gateway
- network proxy
- vault-backed credential injection

Gateways let agents use standard SDKs or local endpoints while Core retains audit, routing, metering, rate limiting, credential control, and policy enforcement.

In container or remote deployments, a bridge sidecar may project these gateways into the agent environment.

## Workspace Services

Core may provide workspace services that support human and agent collaboration.

Examples:

- knowledge retrieval
- knowledge base or notebook
- secret vault reference mediation
- provider and tool gateways
- artifact registry
- audit and usage records
- future data-kernel services for user-generated internal tools

Workspace-visible services should expose governed Core APIs rather than raw internal storage.

Provider registries, gateway defaults, diagnostics policy, and resolved server config are Core-controlled server/runtime concerns. Workspaces may receive projections or policy views of those services, but they are not the default ownership boundary for deployment-level config.

## Generative Kernel

OpenKit may later include a generative kernel for building and operating user-generated internal tools.

The kernel concept means Core can provide durable data contracts, storage, governance, and agent-accessible interfaces so humans and agents can co-create small workspace applications such as internal CRMs, trackers, notebooks, or follow-up systems.

This is a future workspace service area, not part of the current core runtime boundary.

The kernel should follow the same boundaries:

- humans use product or generative UI surfaces
- agents use skills, CLI tools, or governed APIs
- Core owns data contracts, storage, audit, and policy
- agents execute heavy generation or automation work
- secret values stay in the vault boundary
- knowledge and context injection remain governed by Core

## Data Boundary

Workspace history uses the `Workspace -> Thread -> Turn -> Item[]` backbone.

Durable data should be assigned to an explicit server-owned, user-owned, or workspace-owned boundary.

Artifacts, approvals, knowledge, item logs, and workspace-local indexes are normally workspace-owned. Provider config, gateway defaults, agent setup sources, resolved server config, scheduler diagnostics, and other control-plane records are server-owned unless a later core model introduces a user- or workspace-owned variant.

Storage is file-system first with SQLite as a companion for indexes and structured query.

Secret values do not belong in normal workspace files, item payloads, manifests, knowledge pages, context packages, or protocol records.

## Internal Core Agents

Core may use internal lightweight agents for coordination tasks.

Internal Core agents stay inside the coordination plane. They do not become worker agents, agent supply entries, agent runtimes, or user-selectable execution tools by default.

The stable internal role set is:

| Role | Responsibility | Boundary |
| --- | --- | --- |
| Core Assistant | Provides the lightweight user-facing entry role for quick replies, clarification, simple state queries, and triage. | It must not silently become the workflow coordinator, directly call worker agents, or own long-running task progress. |
| Workflow Coordinator | Coordinates non-trivial worker-agent work by selecting workflow modes or recipes, preparing plans, advancing bounded steps, choosing worker agents, composing final worker prompts, handling gates, collecting evidence, and closing or refining work. | It must not maintain the Knowledge Store directly, bypass Core workflow records, or become the heavy execution runtime. |
| Knowledge Manager | Projects the internal knowledge-maintenance role owned by `docs/core/knowledge.md` into the Core coordination plane. | It must not own the whole task workflow or compose the final worker prompt by itself. |
| Task Evaluator | Future internal role for evaluating task outcomes, workflow or Skill updates, verification evidence, and measurable improvement before changes are accepted. | This role is a placeholder until the evaluation, test, verification, and measurement model is designed. |

The Core Assistant may route a request into a workflow, but the handoff to the Workflow Coordinator must be explicit in Core state when the request becomes non-trivial worker-agent work.

The Workflow Coordinator may request relevant knowledge material from the Knowledge Manager before a task starts, then combine that material with task instructions, workflow state, constraints, available capabilities, stop conditions, and review policy into the worker prompt or worker context.

Worker agents may request relevant knowledge while running, but those requests should go through Core-governed capability and knowledge boundaries. The Knowledge Manager responds with governed, source-traceable material or proposals; the worker does not read the Knowledge Store directly.

`Context Package` is a data projection owned by `docs/core/knowledge.md`, not a separate internal agent role. The Knowledge Manager selects, filters, cites, and prepares knowledge-derived material, while the Workflow Coordinator decides how that material is assembled into the final worker context for a specific step.

Workflow orchestration is a Core coordination subsystem, not an internal-agent concept by itself. It stays inside the coordination plane and delegates heavy execution to agents.

## Invariants

- Apps and channels MUST NOT redefine Core concepts or become the source of truth for workspace history.
- Core MUST remain the coordination plane for workspace, thread, turn, item, approval, artifact, knowledge, permission, vault, agent capability, audit, and usage boundaries.
- Worker agents MUST NOT become the durable source of truth for product state merely because they execute work.
- Adapter-native details MUST stay behind adapter boundaries unless a core aspect intentionally promotes a stable projection.
- Secret values MUST NOT be stored in normal workspace files, item payloads, manifests, knowledge pages, context packages, or protocol records.
- Internal Core roles MUST remain inside Core coordination unless a future accepted design promotes a new user-visible agent supply concept.
- Deployment placement and release artifacts MUST NOT change Core ownership of product state, policy decisions, vault boundaries, audit records, or usage records.
