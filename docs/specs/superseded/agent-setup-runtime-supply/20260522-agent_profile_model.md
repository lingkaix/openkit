# Agent Profile Model

Status: Superseded
Implementation: N/A
Status Changed: 2026-06-28
Current Guidance: `docs/specs/20260628-agent_setup_runtime_supply_contract.md`
Decision Evidence: `docs/changes/202607111650190001-spec_lifecycle_governance.md`

## Lifecycle Reason

The Agent Setup And Runtime Supply Contract incorporated the Agent, AgentProfile, and AgentSession supply relationships into the current manifest and package contract. The earlier profile-model document lost authority because its object boundaries now require the consolidated resolution and runtime-supply context.

## Retention Reason

This document preserves the original profile-model vocabulary, scheduling assumptions, and alternatives considered so maintainers can trace how the active supply contract evolved without reviving an independent model owner.

## Summary

OpenKit should model schedulable AI execution through `Agent`, `AgentProfile`, and `AgentSession`.

`Agent` is the execution unit that Core can select, configure, start, supervise, and observe.

`AgentProfile` is a behavior profile inside an agent.

`AgentSession` is initialized runtime continuity for an agent in one workspace.

The model separates execution supply from behavior selection while keeping the product language centered on agents.

## Goals / Non-goals

Goals:

- Define the durable object model for agent setup and execution.
- Make `Agent` the schedulable unit selected by Core.
- Make `AgentProfile` the behavior layer used for instructions, skills, model preference, capability subset, and routing hints.
- Make `AgentSession` the continuity layer for running, pausing, resuming, and observing execution.
- Keep user-visible work represented through turns, items, artifacts, approvals, and usage records.
- Keep runtime-specific details explicit without leaking them into the user-facing work model.

Non-goals:

- Define every runtime-specific configuration field.
- Define marketplace, billing, or organization-level publishing semantics.
- Make profile selection a replacement for permission, sandbox, or provider policy.
- Expose runtime-private task graphs as core product objects.

## Concept Model

The core execution model is:

```text
Agent
  AgentProfile[]
  AgentSession
    Turn
      Item[]
```

`Agent` describes a schedulable AI execution unit.

`AgentProfile` describes a behavior configuration available inside that agent.

`AgentSession` describes initialized runtime continuity for that agent.

`Turn` describes one user-visible execution request.

`Item` describes streamed or completed work records produced during a turn.

## Agent

An `Agent` is the execution supply that Core can schedule.

An agent owns:

- stable identity
- display metadata
- runtime family and adapter
- deployment placement
- transport contract
- provider and model policy
- workspace materialization policy
- capability bridge policy
- sandbox and permission policy
- lifecycle and readiness policy
- observability policy
- available profiles
- runtime-specific configuration

An agent must be concrete enough for Core to answer these questions before starting a session:

- Which runtime implementation handles execution?
- Where does the runtime live?
- How does Core communicate with it?
- Which provider policy applies?
- Which workspace inputs and mounts are allowed?
- Which capabilities can be exposed?
- Which permissions and sandbox rules constrain execution?
- Which readiness checks must pass?
- Which profiles may be selected for turns?

An agent is not only a prompt or persona.

An agent is also not a user-visible conversation. Conversations are represented by threads and turns.

## AgentProfile

An `AgentProfile` is a behavior profile inside an agent.

A profile may define:

- profile identity
- display metadata
- instructions or instruction references
- model preference within agent policy
- skill set
- capability subset
- tool routing hints
- review or approval preferences
- output style hints
- default context injection hints

A profile must not grant capabilities that the parent agent does not allow.

A profile must not bypass provider policy, sandbox policy, permission policy, or workspace boundaries.

Core resolves a selected profile against the parent agent before creating or reusing an agent session.

If a turn does not select a profile, Core uses the agent default profile.

## AgentSession

An `AgentSession` is runtime continuity for one agent in one workspace.

An agent session may include:

- warm process or service state
- runtime handles
- selected profile state
- workspace mount state
- sandbox state
- provider session state
- resume tokens
- health metadata
- active turn metadata

An agent session belongs to one workspace.

An agent session is assigned to one agent.

An agent session may be associated with a current profile, but Core may create separate sessions when profile switching would make runtime state ambiguous.

The default execution rule is one active turn at a time per agent session.

Common session states are:

- `starting`
- `idle`
- `bound`
- `running`
- `awaiting_input`
- `suspending`
- `suspended`
- `resuming`
- `failed`
- `closed`

The item log must remain coherent even if an agent session fails.

Core may replace a failed session and continue a thread by replaying durable thread context into a new session.

## Turn Assignment

Each turn is assigned to one agent session when it executes.

Turn assignment uses this input:

- workspace ID
- thread ID
- requested agent ID
- requested profile ID
- user and organization policy
- agent readiness
- session availability
- capability requirements
- resource limits

Core should prefer an existing matching session when doing so preserves routing clarity and runtime safety.

Core should create a new session when no matching session exists.

Core should reject assignment when the requested agent, profile, capability, provider, sandbox mode, or workspace boundary violates policy.

The turn records which agent and agent session executed it.

The profile used for the turn is recorded as resolved execution metadata.

## Catalog

The agent catalog is the workspace-visible inventory of selectable execution supply.

An `AgentCatalogEntry` should include:

- agent ID
- display name
- description
- runtime family
- readiness status
- supported profiles
- default profile ID
- high-level capabilities
- policy summary
- diagnostic status

Catalog entries are read models.

They should not expose secrets, raw provider credentials, runtime-native files, or private launch arguments.

## Setup Contract

Agent setup is authored as JSONC.

The canonical path is:

```text
DATA_ROOT/config/agents/<agent-id>.agent.jsonc
```

Example:

```jsonc
{
  "schemaVersion": 1,
  "id": "agent_codex_host",
  "displayName": "Codex Agent",
  "description": "A local coding agent backed by the Codex runtime.",
  "runtime": {
    "kind": "codex",
    "adapter": "codex-app-server",
    "version": "0.0.2"
  },
  "deployment": {
    "mode": "host",
    "host": {
      "command": "codex",
      "args": ["app-server", "--listen", "stdio://"],
      "cwdPolicy": "workspace"
    }
  },
  "transport": {
    "kind": "stdio"
  },
  "provider": {
    "ref": "openai",
    "model": "gpt-5.1"
  },
  "profiles": [
    {
      "id": "default",
      "displayName": "Default Coding Profile",
      "instructionsRef": "codex-default",
      "skills": ["repo-guidelines"],
      "capabilities": ["shell", "patch", "browser"]
    },
    {
      "id": "review",
      "displayName": "Code Review Profile",
      "instructionsRef": "codex-review",
      "skills": ["repo-guidelines"],
      "capabilities": ["read", "comment"]
    }
  ],
  "defaultProfileId": "default",
  "workspace": {
    "root": ".",
    "inputs": [],
    "filesystems": []
  },
  "capabilities": {
    "mcp": [
      {
        "id": "github",
        "mode": "bridge.spawned"
      }
    ]
  },
  "permissions": {
    "filesystem": [
      {
        "path": "workspace/**",
        "access": "read_write"
      }
    ],
    "shell": ["git *", "pnpm *", "npm *"],
    "network": ["api.openai.com"]
  },
  "sandbox": {
    "mode": "workspace-write",
    "approvalPolicy": "on-request"
  },
  "lifecycle": {
    "initTimeoutMs": 30000,
    "idleTimeoutMs": 600000,
    "heartbeatIntervalMs": 30000
  },
  "resources": {
    "maxConcurrentTurns": 1,
    "maxToolCallsPerTurn": 100
  },
  "readiness": {
    "requirements": [
      {
        "id": "codex-cli",
        "kind": "command",
        "command": ["codex", "--version"],
        "severity": "blocking"
      }
    ]
  },
  "observability": {
    "logs": {
      "level": "info"
    }
  },
  "runtimeConfig": {
    "codex": {}
  },
  "extensions": {}
}
```

Top-level unknown fields are invalid.

Experimental fields must live under `extensions` or `runtimeConfig.<runtime>`.

## Resolution

Before creating or reusing an agent session, Core resolves an authored agent setup into a concrete session setup.

Resolution order:

1. Load the agent setup.
2. Validate schema version and top-level fields.
3. Validate agent identity and display metadata.
4. Validate runtime, deployment, and transport consistency.
5. Resolve provider references and model policy.
6. Validate workspace paths, mounts, and environment values.
7. Validate permissions, sandbox mode, and capability declarations.
8. Validate profiles and default profile selection.
9. Apply user and organization policy.
10. Produce an immutable resolved setup snapshot for diagnostics.

The resolved setup snapshot is attached to the agent session metadata.

Runtime-native launch files, environment values, arguments, and bridge payloads are materialized from the resolved setup.

## Profile Resolution

Profile resolution starts with the selected profile ID.

If no profile is selected, Core uses `defaultProfileId`.

Core rejects a turn if:

- the profile does not exist
- the profile requests a capability outside the agent policy
- the profile requests a model outside provider policy
- the profile references unavailable instructions or skills
- the profile conflicts with sandbox or permission policy

The resolved profile is recorded on the turn execution metadata.

The runtime receives only the materialized profile fields that it needs.

## Product Surface

Product surfaces should present agents as selectable execution options.

Profile selection should be available when it changes user intent in a meaningful way.

The default product flow should be:

1. Select workspace.
2. Select or accept default agent.
3. Select or accept default profile.
4. Submit a turn.
5. Watch item stream, approvals, artifacts, usage, and session state.

Users should not need to understand runtime placement, transport, or materialization details in normal usage.

Diagnostics surfaces may expose sanitized agent setup, resolved setup, and session health.

## Protocol Shape

The workflow protocol should expose stable read models for:

- agent catalog
- agent detail
- agent session summary
- turn assignment metadata
- item stream
- approval requests
- artifacts
- usage
- audit events

The workflow protocol should not expose runtime-private internal task graphs as required objects.

Runtime-specific payloads should appear only in explicit extension namespaces.

## Storage Model

Core persists:

- authored agent setup references
- agent catalog projections
- agent session records
- resolved setup snapshots
- turn assignment metadata
- item logs
- artifacts
- approvals
- usage records
- audit events

Item logs are append-only.

Replay must preserve stream sequence order.

Resolved setup snapshots are immutable once attached to an agent session.

## Invariants

- Every agent has one stable ID.
- Every profile belongs to exactly one agent setup.
- Every agent has one default profile.
- Every agent session belongs to exactly one workspace.
- Every agent session is created from one resolved agent setup.
- Every executing turn is assigned to one agent session.
- Every executing turn records the resolved profile used for execution.
- Profile policy cannot expand parent agent policy.
- Runtime-private state is never the source of truth for thread history.
- Durable item history remains valid when a session is closed or replaced.

## Testing Strategy

Agent model implementation should include:

- schema validation tests for authored setup files
- profile validation tests
- provider and model policy resolution tests
- workspace path safety tests
- permission and sandbox policy tests
- session assignment tests
- resolved setup snapshot tests
- catalog read model tests
- protocol projection tests
- audit event tests for setup resolution and session lifecycle

Fixtures should include at least:

- one local coding agent
- one remote service agent
- one agent with multiple profiles
- one blocked agent with failed readiness
- one profile that violates parent agent policy

## Risks & Mitigations

Risk: `Agent` becomes too vague.

Mitigation: Require every agent setup to define runtime, deployment, transport, provider, workspace, permission, sandbox, lifecycle, readiness, and profile sections.

Risk: profiles become hidden permission bypasses.

Mitigation: Resolve profiles strictly under parent agent policy and reject any expansion.

Risk: product surfaces expose too much runtime detail.

Mitigation: Keep catalog entries compact and move detailed setup diagnostics into explicit diagnostics surfaces.

Risk: one session with multiple profiles creates ambiguous runtime state.

Mitigation: Allow Core to create separate sessions when profile switching would make state unclear.

## Open Questions

- Should reusable profiles become separately addressable files, or should profiles remain embedded in agent setup?
- Should a profile be allowed to specify a narrower provider model than the parent agent default?
- Which session state transitions require explicit audit events?
- Which profile fields should be visible in the public catalog read model?
- How should Core represent profile-specific usage and cost attribution?
