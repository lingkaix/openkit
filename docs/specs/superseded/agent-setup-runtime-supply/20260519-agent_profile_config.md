# Agent Profile Config

Status: Superseded
Implementation: N/A
Status Changed: 2026-06-28
Current Guidance: `docs/specs/20260628-agent_setup_runtime_supply_contract.md`
Decision Evidence: `docs/changes/202607111650190001-spec_lifecycle_governance.md`

## Lifecycle Reason

The Agent Setup And Runtime Supply Contract absorbed profile selection, provider references, runtime supply, and readiness into one active contract. This profile-only document no longer owns those rules because independent evolution would recreate conflicting agent configuration authorities.

## Retention Reason

This document preserves the earlier profile fields, provider-reference migration, and rejected inline-provider assumptions so future audits can explain why the consolidated contract chose its current configuration boundary.

Updated 2026-05-29: [Remove Historical Compatibility Layers](../../superseded/20260529-remove_legacy_compatibility.md) removed `agent.provider.inline`. Current agent config must reference provider registry entries with `provider.ref`; fallback policy remains a separate current capability.

## Summary

OpenKit v0.0.4 should define a stable agent/profile setup config that Core can use when it boots an agent runtime.

The config describes agent identity, runtime adapter, deployment mode, provider assignment, profiles, MCP, skills, filesystem access, workspace materialization, sandbox policy, lifecycle policy, resources, observability, readiness, and runtime-specific options.

The config is open to future fields through explicit extension blocks, but the top-level structure is stable enough for Codex, OpenCode, local containers, remote agents, and future A2A-style agents.

This spec refines [Unified Agent Setup Manifest](./20260416-unified_agent_setup_manifest.md) and [Agent Manifest Loader](./20260517-agent_manifest_loader.md).

## Goals / Non-goals

Goals:

- Define one canonical agent config format for Core-managed agent startup.
- Keep agent setup separate from server config and from `packages/protocol` workflow semantics.
- Support `host`, `local`, `remote`, and future `a2a` deployment modes.
- Let an agent reference a provider from the server provider registry.
- Represent MCP, skills, filesystems, workspace inputs, permissions, and sandbox policy as typed sections.
- Preserve runtime-specific options for Codex, OpenCode, and future adapters without making them top-level product concepts.
- Snapshot the resolved config used by an agent session for diagnostics and reproducibility.

Non-goals:

- Implement agent orchestration in this planning phase.
- Define every possible runtime-specific field.
- Standardize every future agent runtime on one external transport.
- Expose raw agent config through the public workflow protocol.
- Replace existing host adapter behavior during the v0.0.4 review phase.

## Background

OpenKit already has file-backed agent manifests under `data/config/agents/*.agent.jsonc`.

The current manifest loader establishes a skeleton, but production polish needs a more explicit setup model.

OpenKit's server and agent configuration review found the same durable pattern across OpenCode, OpenFang, and OpenAI sandbox agents: keep agent setup, MCP permissions, provider assignment, and workspace materialization explicit instead of relying on ambient runtime state.

The durable OpenKit split should be:

- `AgentConfig`: the human-authored durable config.
- `ResolvedAgentSetup`: the merged and validated setup used for one boot or session.
- `MaterializedAgentSetup`: runtime-native files, environment, launch arguments, and mounts generated for one adapter.

Native runtime files such as `.codex/config.toml` or OpenCode config fragments are generated materialization outputs, not the canonical source of truth.

## Decision

### Canonical path

Agent configs live under:

```text
DATA_ROOT/config/agents/<agent-id>.agent.jsonc
```

Reusable profiles live inside the agent config unless a later spec introduces a separate profile file format.

The server config selects a default agent through `defaults.agentId`.

### Stable top-level sections

The authored agent config uses JSONC and has this stable top-level structure:

```jsonc
{
  "schemaVersion": 1,
  "id": "agent_codex_host",
  "displayName": "Codex Host Agent",
  "runtime": {
    "kind": "codex",
    "adapter": "codex-app-server",
    "version": "0.130.0"
  },
  "mode": "host",
  "transport": {
    "kind": "stdio"
  },
  "deployment": {
    "host": {
      "command": "codex",
      "args": ["app-server", "--listen", "stdio://"],
      "cwdPolicy": "workspace"
    },
    "local": {
      "image": "openkit/codex-agent:0.0.4"
    },
    "remote": {
      "endpointRef": "env:CODEX_REMOTE_ENDPOINT"
    },
    "a2a": {
      "enabled": false
    }
  },
  "provider": {
    "ref": "agent-openrouter",
    "model": "openai/gpt-5.1",
    "fallbacks": []
  },
  "agents": [
    {
      "id": "agent_codex_default",
      "mode": "primary",
      "instructionsRef": "codex-default",
      "skills": ["repo-guidelines"],
      "mcp": ["github"],
      "permissionsRef": "default-coder"
    }
  ],
  "workspace": {
    "root": "workspace/",
    "inputs": [
      {
        "kind": "git_repo",
        "urlRef": "env:USER_SOURCE_GIT_URL",
        "target": "repo/",
        "snapshotPolicy": "materialized"
      }
    ],
    "filesystems": [
      {
        "id": "workspace",
        "scope": "workspace",
        "mount": "workspace/",
        "access": "read_write"
      },
      {
        "id": "shared",
        "scope": "user",
        "mount": "shared/",
        "access": "read_only"
      }
    ],
    "env": {},
    "ephemeralEnv": {}
  },
  "mcp": [
    {
      "id": "github",
      "mode": "bridge.spawned"
    },
    {
      "id": "playwright",
      "mode": "agent.local",
      "command": "npx",
      "args": ["@playwright/mcp@latest"]
    }
  ],
  "skills": [
    {
      "id": "repo-guidelines",
      "source": "server:skills/repo-guidelines"
    }
  ],
  "permissions": {
    "shell": ["git *", "pnpm *", "npm *"],
    "filesystem": [
      {
        "path": "workspace/**",
        "access": "read_write"
      }
    ],
    "network": ["api.openrouter.ai", "openrouter.ai"]
  },
  "sandbox": {
    "kind": "codex",
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
    "maxToolCallsPerTurn": 100,
    "maxLlmTokensPerHour": 200000
  },
  "observability": {
    "logs": {
      "level": "info"
    },
    "dashboard": {
      "metrics": []
    }
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
  "runtimeConfig": {
    "codex": {
      "sandboxMode": "workspace-write",
      "approvalPolicy": "on-request"
    }
  },
  "extensions": {}
}
```

Top-level unknown fields are invalid.

Experimental fields must live under `extensions` or `runtimeConfig.<runtime>`.

### Agent identity and runtime

`id` is the stable agent ID used by server defaults, selection, diagnostics, and resolved setup snapshots.

`runtime.kind` names the agent family such as `codex`, `opencode`, `simulator`, or a future adapter.

`runtime.adapter` names the Core adapter that knows how to materialize and communicate with the runtime.

`runtime.version` records the expected runtime version and should be used by readiness checks when practical.

### Mode and deployment

`mode` supports:

- `host`: Core starts or connects to a process on the same host.
- `local`: Core starts or connects to a local container or local isolated agent service.
- `remote`: Core connects to an agent service outside the Core host.
- `a2a`: reserved for future Agent-to-Agent style agents.

`deployment` contains mode-specific blocks.

Only the block for the selected `mode` is consumed during resolution.

The presence of other deployment blocks does not make them active.

This keeps the agent definition mode-agnostic while still allowing a single file to carry multiple launch strategies.

### Transport

`transport.kind` is an optional advanced override for the Core-to-agent communication shape. NanoCore normally derives it from `runtime.kind`, `runtime.adapter`, and agent `mode`.

Initial values are:

- `stdio`: process transport for host agents.
- `http`: loopback or remote HTTP transport.
- `websocket`: long-lived bidirectional remote transport.
- `a2a`: future A2A transport.
- `simulated`: internal-only deterministic self-check transport; it is not accepted in user agent config.

Adapters own the exact transport materialization.

The config should describe intent and constraints, not native client internals.

### Provider assignment

The default provider block references a server provider instance:

```jsonc
{
  "provider": {
    "ref": "agent-openrouter",
    "model": "openai/gpt-5.1"
  }
}
```

`ref` must match a provider ID in `DATA_ROOT/config/server.jsonc`.

This allows Codex and OpenCode to use a different OpenRouter key from NanoCore while still keeping provider policy centralized.

Agent configs must not declare inline providers. Local and custom provider instances belong in the server provider registry, where Core can validate references, route consistently, and keep credential policy centralized.

### Agent entries

`agents` describes primary agents, subagents, handoff targets, and future agent-as-tool shapes.

Each agent entry should support:

- stable `id`.
- `mode`, with values such as `primary`, `subagent`, `handoff`, and `tool`.
- provider/model override.
- instruction reference.
- skill references.
- MCP visibility.
- permission reference or inline permission delta.
- runtime-specific options.

The agent config may embed simple agent entries.

Large prompts or reusable agent definitions should move into `DATA_ROOT/config/agents/`.

### MCP modes

`mcp` supports three execution modes:

- `bridge.spawned`: Core or the OpenKit bridge starts the MCP server and proxies it to agents.
- `bridge.remote`: Core or the bridge proxies a remote MCP endpoint to agents.
- `agent.local`: the MCP server runs inside the agent execution domain.

`agent.local` is required for tools that need agent-local resources such as a browser display, local checkout, or agent-local filesystem.

`agent.local` MCP entries must not receive vault credentials.

If an MCP needs a secret, it should use a bridge-mediated mode so Core can resolve and redact the credential.

### Skills and instruction files

`skills` declares skill packages visible to the agent.

Skill sources can be:

- `server:<path>` for server-owned skill material.
- `user:<path>` for user-owned skill material.
- `workspace:<path>` for workspace-owned skill material.
- `runtime:<id>` for runtime-native built-ins.

The materializer writes runtime-native instruction files at session start.

Generated instruction files are disposable outputs.

The authored agent config remains the provenance source.

### Workspace and filesystems

`workspace` uses a manifest-like vocabulary inspired by OpenAI sandbox manifests.

`workspace.inputs` may include:

- `file`.
- `dir`.
- `local`.
- `git_repo`.
- `s3_mount`.
- `gcs_mount`.
- `r2_mount`.
- `azure_blob_mount`.

Every `target` must be workspace-relative.

Absolute paths and `..` escapes are invalid.

Targets must not overlap.

`snapshotPolicy` supports:

- `materialized`: copied or checked out into the workspace and eligible for snapshots.
- `ephemeral`: mounted or generated for the session and excluded from durable snapshots.

`workspace.filesystems` defines the mounts and access grants that the agent receives.

The first implementation can map these to local directories, but the config shape must support remote mounts and managed sandboxes later.

### Sandbox and permissions

`sandbox` captures runtime-level safety posture.

For Codex, the key fields are `mode` and `approvalPolicy`.

For future runtimes, adapter-specific details belong in `runtimeConfig.<runtime>`.

`permissions` uses allowlists and scoped access rules instead of booleans.

At minimum, permissions should cover:

- shell command patterns.
- filesystem path grants.
- network host grants.
- MCP tool grants.
- memory read/write grants when memory is implemented.

The materializer must reject config that requests broader access than the server deployment policy allows.

### Lifecycle, resources, and observability

`lifecycle` controls agent startup, idle, heartbeat, interruption, and shutdown behavior.

`resources` controls scheduling and quota boundaries.

`observability` controls agent logs, metrics, dashboard hints, and diagnostic snapshots.

These sections are mode-agnostic and should be interpreted by Core before adapter materialization.

### Readiness

Readiness is structured and explainable.

Requirement results should support:

- `ready`.
- `degraded`.
- `blocked`.
- `disabled`.

Each failed requirement must explain:

- what was checked.
- why it failed.
- whether it blocks startup.
- how the operator or user can fix it.

Examples include missing CLI binary, failed runtime version check, unresolved provider reference, missing MCP command, missing prompt file, unavailable remote endpoint, and unsupported runtime section.

### Runtime-specific config

`runtimeConfig` is the sanctioned escape hatch for adapter-specific settings.

Examples:

```jsonc
{
  "runtimeConfig": {
    "codex": {
      "sandboxMode": "workspace-write",
      "approvalPolicy": "on-request",
      "nativeConfig": {
        "model_reasoning_effort": "high"
      }
    },
    "opencode": {
      "agent": "build",
      "permission": {
        "edit": "allow"
      }
    }
  }
}
```

Adapters must emit warnings for unsupported runtime-specific fields.

Unsupported fields must not be silently ignored.

## Resolution and materialization

Core resolves an agent setup through these layers:

1. built-in adapter defaults.
2. server deployment policy.
3. server provider registry.
4. agent config file.
5. referenced agent files.
6. user or workspace overrides when allowed.
7. late-bound secret refs and runtime values.

The output is `ResolvedAgentSetup`.

`ResolvedAgentSetup` must include:

- effective agent fields.
- origin metadata for major sections.
- provider IDs and model IDs, with secrets redacted.
- readiness results.
- warnings for unsupported fields.
- a content hash or monotonic setup version.

The adapter converts `ResolvedAgentSetup` into `MaterializedAgentSetup`.

`MaterializedAgentSetup` includes:

- command or endpoint details.
- environment variables.
- generated runtime-native files.
- temporary runtime directory.
- mounts and workspace paths.
- capability warnings.

Resolved snapshots should be stored under the data root:

```text
DATA_ROOT/server/runtime/agents/<agent-id>/resolved/<timestamp>.json
DATA_ROOT/users/<user-id>/workspaces/<workspace-id>/runtime/agents/<agent-id>/resolved/<timestamp>.json
```

Snapshots must redact secrets and should include enough origin metadata to explain why an agent booted with a specific provider, sandbox mode, MCP set, and workspace grant.

## Boundary with docs/core

This config is a Core runtime setup contract.

It must not redefine workflow protocol concepts such as threads, turns, item deltas, approvals, or artifacts.

`packages/protocol` may expose product-visible agent summaries, readiness summaries, and setup diagnostics, but it should not expose raw agent config, raw provider secrets, or adapter-native materialization details.

## Rollout / Migration Plan

1. Add this spec beside the server config and data layout spec.
2. Audit the existing agent manifest schema against this top-level shape.
3. Add schema tests before changing loader behavior.
4. Add resolver tests for provider refs, mode selection, and runtime extension warnings.
5. Add materializer tests for Codex host mode without changing behavior.
6. Add diagnostics that explain outdated manifest fields and suggested v0.0.4 replacements.
7. Only after review, promote the new agent config shape into NanoCore implementation stories.

## Testing Strategy

Required implementation tests:

- Agent schema accepts the example shape.
- Agent schema rejects unknown top-level fields outside `extensions`.
- Agent schema rejects unresolved provider references.
- Agent schema rejects inline provider definitions.
- Mode resolution consumes only the selected deployment block.
- Workspace target validation rejects absolute paths and `..` escapes.
- Workspace target validation rejects overlapping targets.
- `agent.local` MCP entries reject credential references.
- Runtime-specific unsupported fields produce diagnostics.
- Resolved setup snapshots redact all secret values.
- Codex materialization preserves existing host adapter behavior.

## Risks & Mitigations

Risk: the agent config becomes a second workflow protocol.

Mitigation: keep it focused on setup, boot, policy, and materialization.

Risk: the stable structure is too narrow for future agents.

Mitigation: keep top-level lifecycle and capability sections stable while allowing namespaced `runtimeConfig` and `extensions`.

Risk: agent-local provider definitions bypass central provider policy.

Mitigation: reject inline provider definitions in all agent configs and require `provider.ref`.

Risk: runtime-specific fields are silently ignored.

Mitigation: adapters must emit unsupported-field diagnostics.

Risk: workspace mounts can escape user or workspace ownership boundaries.

Mitigation: validate relative paths, reject `..`, reject overlap, and enforce server policy before materialization.

## Open Questions

- Should agent entries be embedded by default or split into `config/agents/*.agent.jsonc` immediately?
- Which agent modes should become closed enums in the first implementation?
- Should A2A remain a reserved deployment block or get a separate transport model when the first A2A agent lands?
- How much origin metadata is needed in the first resolved snapshot?
- Should user-scoped agent configs be allowed, or should all agent configs remain server-owned until the security model is stronger?

## Links

- [Server Config and Data Layout](../nanocore-config-identity/20260519-server_config_data_layout.md)
- [OpenCode Config](https://opencode.ai/docs/config/)
- [OpenCode Providers](https://opencode.ai/docs/providers/)
- [OpenCode Agents](https://opencode.ai/docs/agents/)
- [RightNow-AI/openfang](https://github.com/RightNow-AI/openfang)
- [OpenAI Agents SDK Sandbox Agents](https://developers.openai.com/api/docs/guides/agents/sandboxes)
- [Unified Agent Setup Manifest](./20260416-unified_agent_setup_manifest.md)
- [Agent Manifest Loader](./20260517-agent_manifest_loader.md)
- [OpenAI-Compatible Internal Facade](../../superseded/20260517-openai_compat_facade.md)
- [Core Agent Supply](../../../core/agent-supply.md)
- [Core Runtime Model](../../../core/runtime-model.md)
- [Core Agent Session](../../../core/agent-session.md)
