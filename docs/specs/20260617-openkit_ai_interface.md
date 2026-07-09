# OpenKit AI Interface: Skill And MCP Control Surface

Status: Accepted
Implementation: Implemented

## Owns

This spec owns the OpenKit AI Interface as a user-facing channel composed of setup Skills, loop Skills, the `@openkit/mcp` stdio server, MCP resources, MCP prompts, and product-level control verbs over NanoCore App API behavior.

## Does Not Own

This spec does not own worker-side MCP capability routing, worker tool catalogs, agent capability gateways, NanoCore internal workflow mechanisms, App API route schemas, Web UI layout, remote deployment runbooks, or backend supervision.

## Core References

- `docs/core/architecture.md`
- `docs/core/core-concepts.md`
- `docs/core/communication.md`
- `docs/core/protocol.md`
- `docs/core/work-model.md`
- `docs/core/agent-workflow.md`
- `docs/core/agent-capability.md`

## Summary

OpenKit should expose an AI-native user interface alongside the Web UI.

The interface is composed of:

- `openkit-setup`, an end-user setup Skill for connecting a desktop AI application to an existing local or remote NanoCore backend
- `openkit-setup-dev`, a developer setup Skill for preparing this repository for local dogfooding through NanoCore and MCP
- `openkit-loop`, an end-user loop Skill for coordinating bounded workspace work after setup is available
- `openkit-loop-dev`, a developer loop Skill for review-gated OpenKit self-improvement after developer setup is available
- an OpenKit MCP server that exposes a stable, thin, stdio user-facing control surface over NanoCore App API commands and read models
- curated MCP resources and prompts that let AI applications use OpenKit as a product, not as a collection of ad hoc HTTP calls

This interface is a product channel, similar in status to the Web UI.

It is not the worker-side MCP capability plane described in agent runtime and Agent Capability specs.

The first target use case is an operator flow where a user works from Pi Agent, Codex, Claude CoWork, or another MCP-capable AI application, selects the setup or loop Skill that matches the current task, connects that application to local NanoCore or a supplied remote NanoCore endpoint, starts Goal Mode, runs bounded worker steps, reads Action Center rows, reviews artifacts, and optionally uses OpenKit to improve the OpenKit repository itself through `openkit-loop-dev`.

The durable product idea is:

```text
Human
  -> AI application
      -> OpenKit setup or loop Skill
      -> OpenKit MCP stdio server
          -> local or remote NanoCore App API
              -> Goal Mode / Action Center / Threads / Artifacts / Worker Turns
```

## Current Implementation Projection

The current implementation projects this channel through the `@openkit/mcp` package in `mcp/`, the `openkit-mcp` binary, and the four Skills `openkit-setup`, `openkit-setup-dev`, `openkit-loop`, and `openkit-loop-dev`.

The current MCP surface is a thin facade over public NanoCore behavior. It exposes product-level tools and resources for status, storage diagnostics, runtime diagnostics, auth bootstrap consumption, workspace lifecycle, runtime config, repository readiness, Git push approvals and records, threads, Chat Mode, Task Mode, Goal Mode, Action Center, artifacts, evidence bundles, capability usage evidence, Knowledge Manager operations, workspace portability, and workspace synchronization reviews/apply results.

Current dogfooding treats this MCP channel as the primary coordinator interface for AI-native operation. The Web UI remains a product surface, but the MCP channel is the first-class dogfood path for coordinator-led work.

No MCP-internal V1 implementation gap remains for this spec. Managed sign-in UX, local or remote NanoCore discovery, install and supervision, richer desktop credential UX, richer permission UX, full audit-record linkage beyond bearer last-used labels, and multi-user workspace administration are deferred product surfaces that require their own NanoCore public contracts or installer designs before the AI Interface should expose them.

## Goals / Non-goals

### Goals

1. Define OpenKit AI Interface as a first-class user interaction channel.
2. Keep the AI Interface parallel to the Web UI rather than subordinate to worker runtime configuration.
3. Define a small MCP control surface that maps to current NanoCore App API capabilities.
4. Define the Skill responsibilities needed for AI applications to operate the interface reliably.
5. Support a practical self-improvement loop for the OpenKit repository through existing Goal Mode and Human Attention flows.
6. Keep NanoCore as the source of truth for state, execution, review, and audit.
7. Keep the first implementation local-first, single-user, and review-gated.
8. Preserve the `Workspace -> Thread -> Turn -> Item[]` backbone.
9. Avoid exposing adapter-private task graphs, process handles, raw database state, or raw worker checkpoints.
10. Make the interface useful for manual operation, dogfooding, regression discovery, and future automation.
11. Separate repository-developer setup from end-user setup so AI applications do not need monorepo assumptions when operating OpenKit as a product.
12. Keep the stdio MCP layer reusable across local NanoCore and future authenticated remote NanoCore deployments.

### Non-goals

- Do not define worker-side MCP servers, worker tool catalogs, or MCP entries consumed by Codex, Pi Agent, OpenCode, or other worker agents.
- Do not implement the Agent Capability MCP proxy or gateway projection in this spec.
- Do not replace the Web UI.
- Do not expose raw NanoCore storage, SQLite tables, `DATA_ROOT` files, or runtime-private checkpoints through MCP.
- Do not standardize the Core protocol on MCP.
- Do not let the AI Interface bypass Goal Mode, Action Center, approval gates, user-input gates, artifact review, or repository readiness checks.
- Do not introduce full Sustained Mode automation as the first AI Interface milestone.
- Do not allow unattended repository mutation, auto-commit, auto-push, or release publishing in the first milestone.
- Do not require every future AI application to support the same Skill format. The Skill is the preferred authoring artifact, while MCP is the portable operation surface.
- Do not make the MCP server responsible for installing NanoCore, supervising backend processes, or configuring worker runtimes.
- Do not claim production remote NanoCore support until authentication, permission, token storage, workspace membership, and audit behavior are designed and implemented through public NanoCore contracts.

## Background

OpenKit already has the right architectural slot for this feature.

`docs/core/architecture.md` defines Apps and channels as user interaction surfaces. It lists the Web UI, desktop app, future chat integrations, and future automation integrations as examples. OpenKit AI Interface is a new channel in that layer.

`docs/core/core-concepts.md` defines `Channel` as an origin surface that can submit work to Core. The AI Interface is a channel because the user still acts through an external AI application, but the commands are routed into Core-owned product workflows.

`docs/core/communication.md` separates `Client / Channel <-> Core` communication from `Core / Adapter <-> Agent Runtime` communication. The AI Interface belongs to `Client / Channel <-> Core`.

`docs/core/protocol.md` explicitly says ACP, A2A, MCP, Codex app-server JSON-RPC, provider SDK payloads, shell internals, and adapter-native launch payloads are outside the core protocol unless intentionally projected into stable OpenKit concepts. This spec follows that boundary: MCP is a transport and interface projection, not the canonical protocol.

`docs/core/agent-capability.md` defines a separate Core-owned gateway for agents to use LLM providers, MCP servers, network access, external APIs, knowledge-base retrieval, vault-mediated credentials, and other privileged services. The implemented capability today is the LLM gateway. MCP capability routing is not implemented. The AI Interface must not be confused with that future worker capability plane.

`apps/nanocore` already exposes the product operations needed for the first AI Interface milestone:

- repository resource linking
- thread and turn operation
- Goal Mode start, plan, approval, steering, and bounded worker step
- unified Human Attention Action Center
- artifact inventory and content
- Codex host-adapter coordination
- local-mode operation through `127.0.0.1`

The AI Interface should expose those capabilities to AI applications through stable product verbs.

## Decision

OpenKit defines an AI-native user interface named **OpenKit AI Interface**.

The interface has two authored artifact families:

1. **OpenKit Skills**: four installable instruction packages for AI applications. `openkit-setup` covers end-user connection setup, `openkit-setup-dev` covers repository developer setup, `openkit-loop` covers bounded end-user workspace loops, and `openkit-loop-dev` covers review-gated OpenKit self-improvement.
2. **OpenKit MCP server**: a stdio MCP server that exposes high-level tools, resources, and prompts backed by NanoCore App API calls.

The MCP server is a controlled facade over NanoCore.

It must call public App API, protocol API, or future documented channel APIs. It must not read or mutate NanoCore internals directly.

The MCP server is the same thin process for developer, local-user, and remote-user flows:

```text
AI app process
  -> MCP stdio process
      -> configured NanoCore HTTP API endpoint
```

The default target is the local development NanoCore instance at `http://127.0.0.1:3000`.

`ws_demo` may remain a local development default, but workspace listing, creation, selection, and update are product operations exposed through the public MCP surface. Remote endpoints are allowed as configuration targets only when a deployment supplies the required server URL and auth model; managed production remote auth is outside the current implementation.

## Terminology

`OpenKit AI Interface` is the product-facing name for the Skill plus MCP user interface.

`AI application` is the host application where the user is working, such as Pi Agent, Codex, Claude CoWork, or another MCP-capable tool.

`openkit-setup` is the end-user setup Skill for connecting a desktop AI application to an existing local or remote NanoCore backend.

`openkit-setup-dev` is the developer setup Skill for preparing an OpenKit repository checkout for local NanoCore and MCP dogfooding.

`openkit-loop` is the end-user loop Skill for coordinating bounded workspace work after setup is available.

`openkit-loop-dev` is the developer loop Skill for using OpenKit to improve OpenKit itself after developer setup is available.

`OpenKit MCP server` is the stdio MCP control facade that calls NanoCore product APIs.

`Control MCP` is a shorthand for the user-facing MCP server defined here.

`Worker MCP` or `capability MCP` refers to MCP servers available to worker agents inside an execution environment. That is a different plane and is out of scope for this spec.

`Self-improvement loop` is the review-gated process of using OpenKit Goal Mode to improve OpenKit itself, then feeding lessons back into specs, change records, tests, or implementation.

## Interface Boundary

### Channel Layer

The AI Interface is a channel.

It can submit user intent, read product state, request Goal Mode operations, and surface human attention.

It should follow the same product semantics as Web UI:

- work belongs to a workspace
- related work happens inside a thread
- execution happens as turns
- visible history is represented by items
- durable outputs are artifacts
- human decisions are approval, elicitation, steering, or review flows

### NanoCore Ownership

NanoCore owns:

- workspace, thread, turn, item, artifact, goal, and action-center state
- worker step orchestration
- repository readiness checks
- App API request validation
- idempotency behavior
- human attention projection
- artifact review and Goal Review decisions
- host-adapter execution and diagnostics

The MCP server owns:

- transport translation between MCP and NanoCore HTTP APIs
- endpoint connection diagnostics
- high-level tool argument validation before calling NanoCore
- prompt and resource packaging for AI applications
- redaction and user-facing error normalization for the MCP client

The Skills own:

- operating guidance
- safe workflow policy
- recommended tool order
- self-improvement playbooks
- failure recovery instructions
- expected review behavior

### Separation From Worker Capability Plane

The AI Interface must not be modeled as an agent supply field.

It is not an entry in `AgentEnvironmentPackage.supply.mcpServers`.

It is not a tool made available to worker agents.

It is an external user channel that calls NanoCore like Web UI does.

Future worker-side MCP support can still be implemented under Agent Capability or the agent environment package without changing the product role of this interface.

## Accepted Design

### High-Level Flow

```text
User asks an AI application to use OpenKit
  -> AI application selects openkit-setup, openkit-setup-dev, openkit-loop, or openkit-loop-dev
  -> user or deployment provides a local or remote NanoCore endpoint
  -> AI application calls OpenKit MCP status
  -> MCP server connects to NanoCore through public API
  -> user selects workspace and repository
  -> AI application starts or resumes a thread
  -> AI application starts Goal Mode
  -> AI application drafts and presents a plan
  -> human approves the plan
  -> AI application runs one bounded worker step
  -> AI application reads Action Center, thread items, and artifacts
  -> human accepts, refines, rejects, or steers
```

### Implementation Shape

The durable implementation location is a dedicated MCP package because the server is a channel facade rather than an OpenKit app:

```text
mcp/
  AGENTS.md
  README.md
  package.json
  src/
    index.ts
    mcp-protocol.ts
    nanocore-client.ts
    registry.ts
    redaction.ts
    stdio-server.ts
  scripts/
    smoke-nanocore-mcp.mjs
```

The package name is `@openkit/mcp` and the command filter is `pnpm --filter @openkit/mcp`.

Skill artifacts live outside the MCP package:

```text
skills/
  AGENTS.md
  README.md
  openkit-setup/
    SKILL.md
    agents/
      openai.yaml
  openkit-setup-dev/
    SKILL.md
    agents/
      openai.yaml
  openkit-loop/
    SKILL.md
    agents/
      openai.yaml
  openkit-loop-dev/
    SKILL.md
    agents/
      openai.yaml
```

The four Skills split audience and task phase:

| Skill | Audience | Phase | Use when |
|---|---|---|---|
| `openkit-setup` | end user | setup | an AI application needs to connect to an existing NanoCore backend and verify workspace readiness |
| `openkit-setup-dev` | repository developer | setup | an AI application needs to prepare this checkout, local NanoCore, and MCP for dogfooding |
| `openkit-loop` | end user | loop | setup is available and the AI application should coordinate bounded workspace work |
| `openkit-loop-dev` | repository developer | loop | developer setup is available and the AI application should coordinate review-gated OpenKit self-improvement |

The implementation should reuse existing schemas and clients when possible:

- `@openkit/core-client` for App API calls
- `@openkit/app-api-schemas` for payload parsing
- `@openkit/protocol` only for stable protocol records already exposed by public APIs

The first implementation should not create a new shared schema package unless MCP-specific payloads become reusable outside this package.

The first implementation may implement the MCP stdio transport directly as newline-delimited JSON-RPC when doing so avoids adding a new dependency and the adapter is covered by tests.

If a future version needs advanced MCP behavior such as subscriptions, cancellation, progress notifications, or richer schema generation, it should either adopt the official MCP SDK or promote the direct adapter into a better-tested shared protocol layer.

### Configuration

The MCP server should support these configuration inputs:

| name | default | purpose |
|---|---:|---|
| `OPENKIT_NANOCORE_URL` | `http://127.0.0.1:3000` | NanoCore base URL. |
| `OPENKIT_NANOCORE_TOKEN` | unset | Scoped NanoCore token for authenticated server-mode NanoCore. |

The MCP server must treat `OPENKIT_NANOCORE_URL` as a configured NanoCore API endpoint.

Local development and end-user local setup normally use `http://127.0.0.1:3000`.

Remote setup may use another URL only when a deployment has supplied the server, workspace, and auth contract. The MCP server must not invent private credential or permission behavior that NanoCore does not expose publicly.

For server-mode dogfooding, the MCP auth contract is `Authorization: Bearer <token>` sourced from `OPENKIT_NANOCORE_TOKEN` or the client credential store, per `docs/specs/20260704-remote_auth_credential_bootstrap.md`. The MCP surface also exposes `openkit.consume_bootstrap_token` for the one-time server bootstrap ceremony. The older raw `OPENKIT_NANOCORE_COOKIE` and `OPENKIT_NANOCORE_AUTHORIZATION` passthrough variables are not supported. Token values are credential material and must not be echoed in tool responses, logs, artifacts, change records, or Skills examples.

Workspace, thread, repository, and runtime-config selection should be explicit tool input, resource selection, or Skill-guided user choice. They should not be hidden process-global defaults unless a later accepted design adds a safe profile mechanism.

### Startup Model

The AI application starts the MCP server through its MCP configuration.

The MCP server may then:

1. connect to an already running NanoCore instance
2. report that NanoCore is missing and provide setup instructions through the relevant Skill
3. return diagnostic status from `openkit.start_nanocore` without acting as a general launcher

`openkit.start_nanocore` must not be a generic shell tool.

If a later change gives it real launch behavior, it should only support an allowlisted startup mode such as:

```text
pnpm --filter @openkit/nanocore dev
mise exec -- pnpm --filter @openkit/nanocore dev
```

The command should run from a configured OpenKit checkout path, not from arbitrary user input.

The tool should return a process status summary and the URL it is waiting on.

The first implementation exposes `openkit.start_nanocore` as a diagnostic tool only. It reports whether startup is disabled or allowed-but-not-configured and does not execute a shell command. Productized local backend installation or daemon supervision belongs outside the MCP layer.

### Tool Naming

Tool names should be stable, product-oriented, and high-level.

They should not expose HTTP paths as tool names.

The preferred naming convention is:

```text
openkit.<verb>_<object>
```

Examples:

```text
openkit.read_status
openkit.start_goal
openkit.step_goal
openkit.read_action_center
```

### Tool Contract

All mutating tools must accept an optional `requestId`.

If the caller omits `requestId`, the MCP server should generate one and return it.

Caller-provided `requestId` values must be valid UUID request IDs that match `@openkit/protocol` `RequestIdSchema`.

When NanoCore exposes idempotency for the underlying command, the MCP server must pass the request ID through.

If a public NanoCore route does not yet accept request IDs, the MCP response should still return the MCP request ID for audit continuity, but the implementation must not invent a private idempotency layer inside the MCP server.

Every tool response should include:

- `ok`
- `requestId` when applicable
- `workspaceId` when applicable
- `threadId` when applicable
- `summary`
- `nextSuggestedActions`
- `raw` only when the payload is already public and schema-validated

Tool responses should avoid leaking raw local paths, credentials, environment variables, OAuth state, or process internals.

### MCP Tool Surface Contract

This section names the core first-generation tool families. The current implementation also includes workspace lifecycle, runtime config, workspace synchronization review, workspace sync record, and workspace apply-result tools; `mcp/README.md` and registry tests are the implementation projection for the exact current tool inventory.

#### `openkit.read_status`

Reads AI Interface and NanoCore readiness.

Inputs:

- optional `workspaceId`

Returns:

- MCP server version
- configured NanoCore URL
- NanoCore health
- protocol or App API capability summary
- default workspace ID
- repository readiness summary
- active goal summary when available
- Action Center counts by row kind

This should be the first tool the Skill instructs the AI application to call.

#### `openkit.start_nanocore`

Reports local NanoCore startup status and whether startup is allowed or configured.

Inputs:

- optional `dataRoot`
- optional `port`
- optional `workspaceRoot`

Returns:

- diagnostic startup status
- NanoCore URL
- process status summary when available
- diagnostics when startup is unavailable or disabled

This tool is diagnostic-only in the current implementation. Real start, stop, restart, upgrade, or service supervision behavior belongs to a separate trusted installer or service-management contract, not a generic MCP shell.

#### `openkit.link_repository`

Creates or updates the default repository resource for a workspace.

Inputs:

- `workspaceId`
- `displayName`
- `localPath`
- optional `requestId`

Maps to:

```text
PUT /api/app/workspaces/:workspaceId/repositories/default
```

Returns:

- redacted repository read model
- repository readiness summary

This tool is required before real host-mode worker steps.

#### `openkit.read_repositories`

Reads redacted repository resources and diagnostics for a workspace.

Inputs:

- `workspaceId`

Maps to:

```text
GET /api/app/workspaces/:workspaceId/repositories
GET /api/app/workspaces/:workspaceId/repositories/diagnostics
```

Returns:

- redacted repository summaries
- readiness diagnostics
- next suggested fix when repository setup is not ready

#### `openkit.create_thread`

Creates or selects a thread for AI Interface work.

Inputs:

- `workspaceId`
- `title`
- optional `initialMessage`
- optional `requestId`

Maps to existing thread App API or protocol command surfaces.

If the current App API does not have a dedicated thread creation client for the MCP server, the first implementation may require an existing thread ID and defer this tool.

#### `openkit.read_thread`

Reads a thread summary and recent item history.

Inputs:

- `workspaceId`
- `threadId`
- optional `limit`

Returns:

- thread summary
- active turn summary
- recent items
- artifact refs
- pending human attention refs

The tool should be optimized for AI operation and may summarize large histories.

The full item stream should remain available through resources or paginated reads.

#### `openkit.start_chat`

Starts one thread-scoped Chat Mode Assistant turn.

Inputs:

- `workspaceId`
- `threadId`
- `input`
- optional `providerId`
- optional `model`
- optional `requestId`

Maps to:

```text
POST /api/app/workspaces/:workspaceId/threads/:threadId/chat
```

Returns:

- Chat Mode outcome
- Assistant reply, clarification, refusal, or handoff status projection
- Task Mode or Goal Mode handoff metadata when the Assistant escalates through Workflow Coordinator

#### `openkit.start_goal`

Starts Goal Mode for one thread.

Inputs:

- `workspaceId`
- `threadId`
- `objective`
- optional `requestId`

Maps to:

```text
POST /api/app/workspaces/:workspaceId/threads/:threadId/goal
```

Returns:

- goal summary
- planning state
- next suggested action to draft a plan

#### `openkit.read_goal`

Reads the active or latest Goal Mode summary for one thread.

Inputs:

- `workspaceId`
- `threadId`

Maps to:

```text
GET /api/app/workspaces/:workspaceId/threads/:threadId/goal
```

Returns:

- goal status
- plan status
- task summaries
- review status
- terminal closeout if available
- next suggested actions

#### `openkit.draft_goal_plan`

Creates a Goal Mode plan draft.

Inputs:

- `workspaceId`
- `threadId`
- optional `requestId`

Maps to:

```text
POST /api/app/workspaces/:workspaceId/threads/:threadId/goal/plan
```

Returns:

- reviewable plan
- plan item ID
- task list
- review policy
- suggested human review wording

The Skill must instruct the AI application to present this plan to the user before approval.

#### `openkit.approve_goal_plan`

Approves a specific Goal Mode plan.

Inputs:

- `workspaceId`
- `threadId`
- `planItemId`
- `plan`
- optional `requestId`

Maps to:

```text
POST /api/app/workspaces/:workspaceId/threads/:threadId/goal/plan/approve
```

Returns:

- approved goal summary
- ready tasks
- next suggested action to run one bounded step

The tool should reject empty or missing plan payloads.

#### `openkit.step_goal`

Runs exactly one real bounded worker step.

Inputs:

- `workspaceId`
- `threadId`
- optional `followUpDrainMode`
- optional `reviewPolicyOverride`
- optional `requestId`

Maps to:

```text
POST /api/app/workspaces/:workspaceId/threads/:threadId/goal/step
```

Defaults:

- `followUpDrainMode`: `one_at_a_time`
- `reviewPolicyOverride`: default review behavior, not `none`

Returns:

- worker turn ID
- worker session summary when available
- stop decision
- evidence refs
- pending attention
- refreshed goal summary
- next suggested review actions

The first AI Interface milestone must not expose a "run until done" tool.

Repeated steps should be explicit and review-aware.

#### `openkit.submit_steering`

Queues or submits steering input to an active Goal Mode thread.

Inputs:

- `workspaceId`
- `threadId`
- `message`
- optional `requestId`

Maps to:

```text
POST /api/app/workspaces/:workspaceId/threads/:threadId/goal/steering
```

Returns:

- steering summary
- active or queued delivery status

#### `openkit.read_action_center`

Reads unified Human Attention rows.

Inputs:

- `workspaceId`
- optional `kind`
- optional `limit`

Maps to:

```text
GET /api/app/workspaces/:workspaceId/action-center
```

Returns:

- rows grouped by kind and severity
- row summaries
- available actions
- source references
- suggested next tool calls

This should be the main way an AI application discovers whether human review is needed.

#### `openkit.resolve_action_center_item`

Executes one approved Action Center action.

Inputs:

- `workspaceId`
- `rowId`
- `actionId`
- `decision`
- optional `comment`
- optional `requestId`

Maps to the specific App API action declared by the Action Center row.

Examples:

- artifact review decision
- Goal Review decision
- approval decision
- user-input answer

For `answer_question` rows backed by a protocol `user-input-request` item, the MCP server should pass `comment` as the human answer through the public turn resume route.

The tool must not guess a decision.

The Skill must require the AI application to ask the human before resolving rows that accept, reject, approve, deny, retry, extend budget, or trigger external side effects.

#### `openkit.read_artifact`

Reads artifact metadata and content when available.

Inputs:

- `workspaceId`
- `artifactId`
- optional `threadId`

Returns:

- artifact summary
- content or content URL when allowed
- source item refs
- review status when available

Large artifacts should be summarized unless the AI application asks for exact content.

#### `openkit.create_evidence_bundle`

Creates a compact evidence summary for a thread, goal, or worker step.

Inputs:

- `workspaceId`
- optional `threadId`
- optional `goalId`
- optional `turnId`

Returns:

- item refs
- artifact refs
- command/test summaries when present
- pending attention summary
- recommended next review action

This tool can be deferred if existing read tools are enough for the first implementation.

### MCP Resources

Resources should provide read-only state snapshots.

Initial resource URI patterns:

```text
openkit://status
openkit://workspaces/{workspaceId}/repositories
openkit://workspaces/{workspaceId}/action-center
openkit://workspaces/{workspaceId}/threads/{threadId}
openkit://workspaces/{workspaceId}/threads/{threadId}/goal
openkit://workspaces/{workspaceId}/threads/{threadId}/items
openkit://workspaces/{workspaceId}/artifacts/{artifactId}
```

Resource payloads should be schema-validated public read models or summaries derived from public read models.

Resources must not expose raw local repository paths unless the user explicitly supplied them in the current AI application session and the resource is scoped to that session.

### MCP Prompts

Prompts should be stable playbooks that combine tool use, review policy, and expected interaction style.

Initial prompts:

#### `operate_openkit`

Purpose:

Guide an AI application through connecting to OpenKit, reading status, selecting a workspace, and explaining available operations.

Inputs:

- optional `workspaceId`
- optional `threadId`

#### `run_goal_mode_step`

Purpose:

Guide an AI application through starting or resuming a Goal Mode task and running exactly one bounded worker step.

Inputs:

- `workspaceId`
- `threadId`
- optional `objective`

#### `self_improve_openkit`

Purpose:

Guide an AI application through using OpenKit to improve the OpenKit repository itself.

Inputs:

- `workspaceId`
- `repositoryPath`
- `objective`
- optional `scopeLimit`

Required behavior:

- read status first
- link repository if needed
- start or resume a thread
- start Task Mode or Goal Mode if needed
- draft a plan
- present the plan for human approval
- approve only after explicit human approval
- run one bounded worker step
- read Action Center
- summarize evidence
- ask the human to accept, refine, reject, or continue

#### `review_openkit_goal_result`

Purpose:

Guide an AI application through reviewing one worker result, artifact, or Action Center row.

Inputs:

- `workspaceId`
- `threadId`
- optional `artifactId`
- optional `rowId`

#### `write_openkit_change_record`

Purpose:

Guide an AI application through deciding whether a completed OpenKit self-improvement cycle needs a spec update, change record, working log, or no durable doc update.

Inputs:

- `workspaceId`
- `threadId`
- `summary`

This prompt should reference `docs/change-tracking.md` and the repository `AGENTS.md` rules.

## App API Mapping

The AI Interface should be a facade over current App API routes.

| AI Interface operation | NanoCore route or surface |
|---|---|
| read status | `/api/meta`, diagnostics routes, repository diagnostics, Action Center read model |
| link repository | `PUT /api/app/workspaces/:workspaceId/repositories/default` |
| read repositories | `GET /api/app/workspaces/:workspaceId/repositories`, `GET /api/app/workspaces/:workspaceId/repositories/diagnostics` |
| start goal | `POST /api/app/workspaces/:workspaceId/threads/:threadId/goal` |
| read goal | `GET /api/app/workspaces/:workspaceId/threads/:threadId/goal` |
| draft goal plan | `POST /api/app/workspaces/:workspaceId/threads/:threadId/goal/plan` |
| approve goal plan | `POST /api/app/workspaces/:workspaceId/threads/:threadId/goal/plan/approve` |
| step goal | `POST /api/app/workspaces/:workspaceId/threads/:threadId/goal/step` |
| submit steering | `POST /api/app/workspaces/:workspaceId/threads/:threadId/goal/steering` |
| read action center | `GET /api/app/workspaces/:workspaceId/action-center` |
| resolve attention | action declared by the Action Center row |
| read artifact | existing artifact inventory and content routes |
| read thread | existing thread, item, and stream read routes |

If a needed operation lacks a stable App API route, the implementation should add that route and schema first rather than reaching into NanoCore internals from MCP.

## Self-Improvement Loop

### Purpose

The self-improvement loop is a dogfooding workflow.

It should let users use OpenKit's own Goal Mode, worker turns, Action Center, artifacts, tests, and review gates to improve OpenKit itself.

The loop is not an unattended recursive rewrite system.

It is a review-gated way to create evidence from real usage and feed that evidence back into specs, tests, implementation, and product design.

### First Proof Point

The first proof point should be a small documentation or test-focused OpenKit improvement.

Recommended first objective:

```text
Use OpenKit Goal Mode through the OpenKit AI Interface to identify one small gap in the AI Interface spec, propose a patch, and produce evidence for human review.
```

This avoids starting with high-risk code mutation while still proving the interface loop.

### Required Flow

```text
1. AI application loads OpenKit Skill.
2. AI application calls openkit.read_status.
3. AI application starts NanoCore or asks the user to start it.
4. AI application links /Users/m5pro/Documents/AI/openkit as the workspace repository.
5. AI application creates or selects a thread.
6. AI application starts Goal Mode with a narrow objective.
7. AI application drafts a plan.
8. Human reviews and approves the plan.
9. AI application calls openkit.approve_goal_plan.
10. AI application calls openkit.step_goal once.
11. AI application reads Action Center, goal summary, thread items, and artifacts.
12. AI application presents evidence and asks the human for a decision.
13. Human accepts, asks for refinement, rejects, or continues with another bounded step.
14. Lessons are written back to the appropriate spec, change record, test, or implementation only after review.
```

### Review Rules

All self-improvement runs must default to review-required behavior.

The AI application must not:

- approve its own plan without human consent
- resolve acceptance rows without human consent
- commit or push without explicit user request
- run unbounded steps
- hide failing tests
- treat "worker completed" as equivalent to "work accepted"

### Learning Capture

The loop should capture two kinds of learning.

1. Product learning: where the AI Interface was confusing, missing a tool, over-broad, or hard to operate.
2. System learning: where Goal Mode, Action Center, worker steps, artifact review, or repository linking failed under realistic use.

Durable learning should be promoted through normal repository mechanisms:

- specs for design decisions
- tests for regressions
- change records for material implementation history
- README or cookbook updates for operator workflows

The AI Interface should not write to the Knowledge Store or documentation automatically just because a worker says something is useful.

## Human Attention And Safety

The AI Interface must treat Action Center as the primary attention surface.

When `openkit.step_goal` returns pending attention, the AI application should read the Action Center before continuing.

The interface should preserve the distinction between:

- approval gates
- user-input gates
- steering input
- review and acceptance

The MCP server should not collapse all human attention into a generic "confirm" tool.

Different rows need different decision payloads, different audit meaning, and different user wording.

The Skill should train AI applications to say which decision is being requested and why it matters.

## Security And Permission Model

### Local-First Trust Boundary

The first implementation should assume a local single-user developer machine.

The default NanoCore URL must be loopback.

Remote NanoCore URLs require explicit configuration.

### No Secret Exposure

The MCP server must not expose:

- OAuth tokens
- provider API keys
- vault secret values
- raw process environment
- raw `CODEX_HOME`
- raw server config files
- raw `DATA_ROOT`

### Repository Paths

`openkit.link_repository` necessarily accepts a local path.

The tool response should use existing redacted repository read models.

The MCP server should avoid echoing absolute paths except when asking the user to confirm the exact path they provided.

### No Generic Shell

The MCP server must not expose a generic command execution tool.

The only process-management-shaped tool in the current AI Interface is the diagnostic NanoCore startup status helper.

Worker execution remains mediated by NanoCore Goal Mode and host adapters.

### Review Before Side Effects

The Skill should require human confirmation before:

- resolving approvals
- accepting artifacts
- approving Goal Review rows
- running another worker step after a failure
- changing repository configuration
- starting long-running or quota-consuming work
- committing, pushing, tagging, publishing, or deploying

The first MCP implementation should not include commit, push, tag, publish, or deploy tools.

## Observability And Audit

NanoCore remains the authoritative audit and work-history source.

The MCP server should add channel metadata to requests when supported:

```json
{
  "channel": "openkit-mcp",
  "client": "mcp",
  "aiApplication": "claude-code-or-codex",
  "requestId": "..."
}
```

If the current App API does not support this metadata yet, the first implementation may log it locally and later promote it to App API request metadata.

Useful audit questions:

- Which AI application requested the action?
- Which MCP tool was called?
- Which workspace and thread were affected?
- Which human decision authorized the action?
- Which NanoCore request ID maps to the MCP request?
- Which artifact or Action Center row was resolved?

## User Experience Principles

The AI Interface should feel like a capable operator, not a low-level API client.

The Skill should instruct the AI application to:

- start with status
- explain current system state before acting
- ask for missing workspace, repository, or thread context
- run one bounded step at a time
- present plans before approval
- read Action Center before continuing after worker execution
- summarize evidence with links to items and artifacts
- distinguish "completed", "needs review", "blocked", and "accepted"

The MCP server should return concise, structured next actions so AI applications can avoid guessing the workflow.

## Alternatives Considered

### Use Web UI Only

Rejected.

The Web UI remains important, but it does not serve users who already work inside an AI application and want conversational operation, system testing, or dogfooding through an agentic interface.

### Tell AI Applications To Curl NanoCore Directly

Rejected.

Raw HTTP calls make the AI application rediscover workflow rules every session, increase accidental misuse, and bypass curated review guidance.

The Skill and MCP server provide reusable operating knowledge and a narrower control surface.

### Make This The Worker Capability MCP

Rejected.

Worker capability MCP is a different plane.

Mixing it with the user-facing control interface would blur audit, permissions, and ownership.

### Build A New Chat UI Instead

Rejected for the first milestone.

The point of this design is to let existing AI applications become an OpenKit user interface.

Building a new chat client would duplicate the Web UI direction instead of testing the channel idea.

### Expose A Generic NanoCore Admin MCP

Rejected.

The interface should be product-oriented and high-level.

Admin-style access to internals would make it easier to bypass Core semantics and harder to preserve auditability.

## Consequences

Positive consequences:

- OpenKit gains a second first-class UX surface.
- Dogfooding becomes faster because AI applications can operate Goal Mode directly.
- The self-improvement loop can expose real product friction earlier than Web-only testing.
- The MCP surface becomes a contract for future CLI, chat, and automation channels.
- Workflow knowledge moves from ad hoc prompts into a reusable Skill.

Costs:

- OpenKit must maintain Web UI and AI Interface behavior alignment.
- MCP tool contracts need tests like any other App API facade.
- Human review semantics must be explicit or AI applications will over-automate.
- Startup and local process management can become fragile if not kept narrow.
- The Skill can drift from implementation unless updated with feature changes.

## Implementation Roadmap

### Baseline: Contract Review

Keep this spec reviewed against:

- `docs/core/architecture.md`
- `docs/core/core-concepts.md`
- `docs/core/communication.md`
- `docs/core/protocol.md`
- `docs/core/work-model.md`
- `docs/core/agent-capability.md`
- `docs/specs/20260531-human_attention_intervention_model.md`
- `docs/specs/20260531-worker_turn_reliability_envelope.md`
- `docs/specs/20260616-agent_environment_package.md`

### Phase 1: Read-Only MCP

Keep these read-only capabilities covered:

- `openkit.read_status`
- `openkit.read_repositories`
- `openkit.read_goal`
- `openkit.read_action_center`
- read-only resources
- `operate_openkit` prompt
- initial Skill

Success criteria:

- an AI application can connect and explain current NanoCore state without editing anything
- malformed NanoCore responses are rejected by schemas
- local startup and connection failures produce actionable diagnostics

### Phase 2: Controlled Goal Mode Operations

Keep controlled Goal Mode operations covered:

- `openkit.link_repository`
- `openkit.start_goal`
- `openkit.draft_goal_plan`
- `openkit.approve_goal_plan`
- `openkit.step_goal`
- `openkit.submit_steering`
- `run_goal_mode_step` prompt

Success criteria:

- an AI application can drive one bounded Goal Mode step through NanoCore
- plan approval is explicit
- worker step output leads to Action Center or review evidence

### Phase 3: Self-Improvement Dogfood

Keep self-improvement dogfood support covered:

- `self_improve_openkit` prompt
- `review_openkit_goal_result` prompt
- artifact read support required by the dogfood story
- evidence bundle if needed

Success criteria:

- OpenKit can use the AI Interface to run a documentation or test-focused self-improvement goal on the OpenKit repository
- the loop produces reviewable evidence
- lessons are captured in docs, tests, or a change record only after review

### Phase 4: Packaging

Package the Skills and MCP server for common AI applications.

The packaging should include:

- MCP configuration examples
- setup Skill install instructions
- loop Skill install instructions
- local NanoCore backend setup instructions
- remote NanoCore backend connection instructions
- troubleshooting guide
- version compatibility notes

### Phase 5: Remote And Multi-User Server Mode

Only after local dogfooding works, extend the interface to production server-mode auth and remote NanoCore URLs.

This phase needs explicit auth, permission, audit, and workspace membership design.

## Testing Strategy

### L0 Static Checks

- Markdown formatting passes repository checks.
- Tool definitions are documented and examples are valid JSON.
- All Skills contain no repository-text language outside English.

### L1 Unit Tests

- MCP tool argument validation.
- NanoCore client route mapping.
- request ID pass-through.
- redaction helpers.
- error normalization.
- prompt rendering with required inputs.
- setup and loop Skill path coverage.

### L2 Contract Tests

- MCP tool responses parse existing `@openkit/app-api-schemas` payloads.
- mocked NanoCore failures map to stable MCP errors.
- Action Center action execution rejects unknown row IDs, unknown action IDs, and missing human decisions.

### L3 NanoCore Black-Box E2E

- start NanoCore with a fresh data root
- connect MCP server
- link a repository
- start Goal Mode
- draft and approve a plan
- run one bounded worker step using deterministic or fake worker support where appropriate
- read Action Center

The implementation includes `pnpm --filter @openkit/mcp smoke:nanocore` for this path. It expects `nanocore` and `@openkit/mcp` to be built first, starts temporary NanoCore and MCP stdio processes, links a disposable git repository, creates a thread, starts Goal Mode, drafts and approves a plan, runs one bounded step, resolves deterministic approval and question rows, reads evidence, and reads an artifact without real provider quota. The MCP implementation lives directly under `mcp/`.

## MCP Setup Surface

The MCP server should be complete enough for a user to connect a desktop AI application to an already reachable NanoCore endpoint and set up productive work without switching to a separate UI for every step.

Current MCP setup coverage:

- Server connection: `OPENKIT_NANOCORE_URL` configures the endpoint, and `OPENKIT_NANOCORE_TOKEN` or the client credential store supplies server-mode auth.
- Status discovery: `openkit.read_status` checks NanoCore readiness and selected workspace/thread context.
- Workspace lifecycle: `openkit.list_workspaces`, `openkit.create_workspace`, `openkit.update_workspace`, and `openkit.read_workspace_resources` map to public Core workspace routes.
- Runtime config setup: `openkit.list_runtime_config_files`, `openkit.read_runtime_config_file`, `openkit.validate_runtime_config`, `openkit.update_runtime_config_file`, and `openkit.reload_runtime_config` map to public NanoCore runtime config routes.
- Repository and loop setup: repository linking, thread creation, Chat Mode, Task Mode, Goal Mode, Action Center, workspace sync reviews, artifacts, and evidence bundles are exposed as product-level MCP tools and resources.

Remaining product gaps are not MCP-internal implementation gaps. They require stable NanoCore public contracts first and are deferred out of the accepted V1 AI Interface boundary:

- Remote auth bootstrap and desktop credential storage per `docs/specs/20260704-remote_auth_credential_bootstrap.md`.
- Local or remote NanoCore discovery.
- Trusted NanoCore install, start, stop, restart, upgrade, and service supervision.
- Productized config diff preview, restart-required warnings, rollback, secret-slot selection, and staged approval.
- Workspace templates, membership, permissions, deletion policy, richer default provider/model selection, and server-side audit labels for MCP-originated operations.
- Remote repository path mapping for mounted server-side workspaces.

### L6 Story Acceptance

Story: "Use OpenKit AI Interface to run one self-improvement loop."

Acceptance flow:

- AI application reads the setup or loop Skill that matches the current task
- calls status
- links repository
- starts a goal
- presents plan for approval
- runs one bounded step
- reads evidence
- asks human for final decision

Real Codex or provider-quota stories should remain opt-in.

## Risks And Mitigations

### Risk: Interface Blurs User Channel And Worker Capability

Mitigation:

Keep this spec, implementation names, tool descriptions, and Skill wording explicit that the AI Interface is a channel and not worker supply.

### Risk: AI Application Over-Automates Review

Mitigation:

Default to one bounded step at a time, read Action Center after each step, and require human confirmation for acceptance, approval, retry, commit, push, or external side effects.

### Risk: MCP Server Becomes An Internal Admin API

Mitigation:

Expose product verbs only. Add missing App API routes instead of reading storage internals.

### Risk: Skills Drift From Tool Surface

Mitigation:

Treat all four Skills as part of the same release gate as the MCP server. Add tests or fixtures that validate prompt/tool names against implementation metadata and setup or loop path expectations.

### Risk: Local Startup Is Fragile

Mitigation:

Keep startup outside the MCP layer except for diagnostic status. The user or deployment can start NanoCore manually with documented commands or a future productized installer.

### Risk: Self-Improvement Becomes Recursive Slop

Mitigation:

Require human review, bounded steps, evidence bundles, and normal repository verification. Capture lessons through specs and tests, not unreviewed Knowledge Store writes.

## Resolved Decisions

- `openkit.start_nanocore` remains diagnostic-only in the AI Interface. Real launch, stop, restart, upgrade, or daemon supervision belongs to a separate trusted installer or service-management contract.
- MCP-originated bearer-token operations carry `mcp` / `desktop-agent` channel metadata into NanoCore token last-used summaries. Full per-tool audit-record linkage remains a NanoCore audit contract, not an MCP private ledger.
- The current MCP server relies on polling read tools and resources. Subscription-like event streams require a separate accepted transport design over NanoCore-supported stream semantics.
- The minimum artifact content API for AI-side review is artifact metadata plus product-safe content or content URL when allowed by NanoCore. Large or restricted artifacts may return summaries, refs, or access-denied diagnostics instead of raw content.
- Server-mode MCP auth uses the bearer-token contract from `docs/specs/20260704-remote_auth_credential_bootstrap.md`; MCP can consume the one-time bootstrap token and store the returned token in its encrypted fallback when explicitly requested, while managed login, account selection, token refresh, and richer desktop credential UX remain future work.
- Repository-local Skills are the current canonical authored Skills. Codex plugin, Claude skill, or other packaged distributions may be generated later, but they must preserve the same canonical Skill content and tests.
- Productized local NanoCore installation belongs to a future installer or service-management design, not to the AI Interface MCP server.

## Deferred / Future Work

- Managed login, account selection, token refresh, and richer desktop credential UX for server-mode MCP use.
- Local and remote NanoCore discovery.
- Trusted installer, service supervision, upgrade, restart, and uninstall flows for end users without a repository checkout.
- Subscription-style event resources after NanoCore exposes a stable stream contract for this channel.
- Packaged Skill distributions for specific AI applications.

## Links

- [Core Architecture](../core/architecture.md)
- [Core Concepts](../core/core-concepts.md)
- [Communication Model](../core/communication.md)
- [Core Protocol](../core/protocol.md)
- [Work Model](../core/work-model.md)
- [Agent Capability](../core/agent-capability.md)
- [Human Attention And Intervention Model](./20260531-human_attention_intervention_model.md)
- [Worker Turn Reliability Envelope](./20260531-worker_turn_reliability_envelope.md)
- [Agent Environment Package And Worker Governance Backends](./20260616-agent_environment_package.md)
- [Remote Auth Credential Bootstrap](./20260704-remote_auth_credential_bootstrap.md)
- [Chat Mode And Core Assistant](./20260704-chat_mode_assistant.md)
- [Task Mode Worker Delegation](./20260704-task_mode_worker_delegation.md)
- [Goal Mode Coordination](./20260704-goal_mode_coordination.md)
- [Codex Agent Communication Modes](./retired/worker-runtime/20260507-codex_agent_communication_modes.md)
- [Change Tracking](../change-tracking.md)
