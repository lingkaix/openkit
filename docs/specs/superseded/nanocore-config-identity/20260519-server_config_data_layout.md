---
status: Superseded
implementation: N/A
status-changed: 2026-06-28
current-guidance: "`docs/specs/20260628-nanocore_config_identity_contract.md`"
decision-evidence: "`docs/specs/20260628-nanocore_config_identity_contract.md`"
---
# Server Config and Data Layout

## Lifecycle Reason

The NanoCore Config And Identity Contract absorbed server configuration, data-root layout, credential references, and ownership scoping into one current authority. The earlier layout document lost authority because its paths and defaults cannot evolve separately from identity and runtime configuration semantics.

## Retention Reason

This document preserves the initial server layout, configuration fields, and credential migration constraints so maintainers can explain historical storage decisions while following only the consolidated contract for current behavior.

Updated 2026-05-29: [Remove Historical Compatibility Layers](../../superseded/20260529-remove_legacy_compatibility.md) made `secretRef` the only supported provider credential form. Current authored server config rejects `apiKey`, `token`, `secret`, and `clientSecret`, while `defaultProviderId` remains current for gateway and facade routing.

## Summary

OpenKit v0.0.4 should replace ad hoc server defaults with one canonical server-level config model and one canonical data-root layout.

The server config owns deployment mode, auth posture, provider instances, Core defaults, gateway defaults, feature flags, diagnostics policy, and the path to durable data.

The data-root layout is identical across development, staging, and production.

`local` mode uses the same layout as `server` mode, with `users/user_local/` as the implicit user folder.

This spec refines and supersedes the v0.0.3 staging config shape from [Staging Docker Distribution](../20260518-staging_docker_distribution.md).

## Goals / Non-goals

Goals:

- Define one server-level config model that can drive local, staging, and production deployments.
- Support multiple configured provider instances, including multiple OpenRouter entries with separate keys and policies.
- Make the Core default provider and OpenAI-compatible gateway default provider explicit.
- Require provider credentials to be authored by `secretRef`.
- Preserve JSONC as the human-authored config format for v0.0.4.
- Define a data-root layout that separates server-owned, user-owned, and workspace-owned files.
- Align the layout with [Core Storage](../../../core/storage.md), [Core Architecture](../../../core/architecture.md), and [Deployment](../../../deployment.md).
- Keep the server config as a runtime concern and avoid leaking provider or auth internals into `packages/protocol`.

Non-goals:

- Implement the loader or migration in this planning phase.
- Implement a secret vault backend.
- Implement remote agent orchestration.
- Replace Better Auth or Drizzle decisions.
- Define the agent setup schema in this document.

## Background

Earlier staging work introduced file-backed provider templates and a longer OpenKit-specific config filename.

That was sufficient for the staging image, but production polish needs a clearer split:

- server-level config should be one resolved model, even when operators author it through split files.
- provider metadata should be separated from configured provider instances and secrets.
- agent setup should be separated from server setup.
- every environment should use the same data-root hierarchy.

OpenKit's server and agent configuration review found a consistent pattern across Chatbox, Nanobot, OpenCode, and OpenFang.

The durable design is a server config that owns provider policy and deployment posture, plus agent configs that reference server provider instances when they need LLM access.

## Decision

### Canonical config path

The canonical server config file is:

```text
DATA_ROOT/config/server.jsonc
```

NanoCore does not read removed OpenKit-specific config filenames.

### Server config shape

The authored config uses JSONC and has this stable top-level structure:

```jsonc
{
  "schemaVersion": 1,
  "mode": "server",
  "server": {
    "publicBaseUrl": "https://openkit.example.com",
    "bind": {
      "host": "127.0.0.1",
      "port": 3000
    },
    "trustedProxies": [],
    "cors": {
      "origins": []
    }
  },
  "auth": {
    "enabled": true,
    "provider": "better-auth",
    "localModeUserId": "user_local",
    "signup": {
      "enabled": false
    }
  },
  "data": {
    "root": "/data/openkit",
    "layoutVersion": 1
  },
  "providers": [
    {
      "id": "core-openrouter",
      "vendor": "openrouter",
      "kind": "gateway",
      "displayName": "OpenRouter for Core",
      "baseUrl": "https://openrouter.ai/api/v1",
      "models": ["openai/gpt-5.1"],
      "defaultModel": "openai/gpt-5.1",
      "secretRef": "env:CORE_OPENROUTER_API_KEY",
      "extraHeaders": {},
      "extraBody": {},
      "metadata": {
        "modelsDevProviderId": "openrouter"
      }
    },
    {
      "id": "agent-openrouter",
      "vendor": "openrouter",
      "kind": "gateway",
      "displayName": "OpenRouter for Agents",
      "baseUrl": "https://openrouter.ai/api/v1",
      "models": ["openai/gpt-5.1"],
      "defaultModel": "openai/gpt-5.1",
      "secretRef": "env:AGENT_OPENROUTER_API_KEY",
      "metadata": {
        "modelsDevProviderId": "openrouter"
      }
    }
  ],
  "defaults": {
    "coreProviderId": "core-openrouter",
    "coreModel": "openai/gpt-5.1",
    "gatewayProviderId": "agent-openrouter",
    "gatewayModel": "openai/gpt-5.1",
    "agentId": "agent_codex_host"
  },
  "gateway": {
    "openaiCompatible": {
      "enabled": true,
      "route": "/v1",
      "defaultProviderId": "agent-openrouter",
      "defaultModel": "openai/gpt-5.1",
      "allowedProviderIds": ["agent-openrouter"],
      "auth": "agent-session"
    }
  },
  "features": {
    "internalOpenAICompatFacade": {
      "enabled": false
    }
  },
  "diagnostics": {
    "redactSecrets": true,
    "emitConfigOrigins": true
  },
  "extensions": {}
}
```

Top-level keys are intentionally stable.

New experimental data must live under `extensions` or a namespaced object until the field is promoted into the schema.

### Mode semantics

`mode` supports:

- `local`: one implicit local user, no auth wall by default, same data-root layout.
- `server`: authenticated multi-user server mode, Better Auth enabled by default.

Future modes must not create a different data-root hierarchy.

Mode changes affect auth, routing, agent selection, and user resolution, not durable storage shape.

### Auth config

`auth.enabled` decides whether user-facing routes require authentication.

`auth.provider` is `better-auth` for the current product direction.

`auth.localModeUserId` is only used when `mode` is `local`.

Server mode must not silently fall back to `user_local` when auth is enabled and a request is anonymous.

### Provider instances

`providers` is an array of configured provider instances.

It is not keyed by vendor because one vendor can appear multiple times with different secrets, base URLs, limits, or operational policy.

`id` is the stable routing key used by Core defaults, gateway defaults, agent configs, diagnostics, and future UI forms.

`vendor` identifies the catalog source or built-in provider family.

`kind` supports:

- `direct`: direct provider integration.
- `gateway`: OpenAI-compatible or gateway-style provider such as OpenRouter.
- `local`: local model server with no external secret.
- `oauth`: provider that resolves credentials through an OAuth flow.
- `custom`: operator-defined provider with explicit base URL and model list.

Provider credentials must be authored indirectly with `secretRef`. Inline credential fields such as `apiKey`, `token`, `secret`, and `clientSecret` are invalid.

Allowed reference forms are:

- `env:NAME`
- `vault://path`
- `user://<user-id>/secret/<name>`
- `workspace://<workspace-id>/secret/<name>`

Only `env:` is required for the first implementation.

Other forms reserve the shape for future Secret Vault and per-user provider work.

### Defaults

`defaults.coreProviderId` selects the provider instance used by NanoCore's own LLM tasks.

`defaults.gatewayProviderId` selects the provider instance used by the internal OpenAI-compatible gateway when a request omits an explicit provider.

These can intentionally point to different OpenRouter entries so NanoCore and Codex/OpenCode agents can use different keys.

If a default provider ID is missing or points to a disabled provider, boot diagnostics must report the exact missing ID.

### Gateway config

`gateway.openaiCompatible` owns the OpenAI-compatible facade route and routing policy.

The gateway must never pick a provider by vendor name alone when multiple provider instances share the same vendor.

The route should use provider instance IDs for routing and allowlists.

The gateway config is runtime-internal and should not redefine workflow protocol concepts.

### Split files and resolved config

The canonical resolved model is the object shape above.

Operators may eventually author split files under:

```text
DATA_ROOT/config/providers/*.provider.jsonc
DATA_ROOT/config/agents/*.agent.jsonc
```

Split files are input fragments.

They must be merged into a resolved config object with origin metadata for diagnostics.

The resolved server config snapshot should be written without raw credential values under:

```text
DATA_ROOT/server/runtime/config/config.resolved.json
```

The snapshot is diagnostic output and is not the authoring source.

## Data-root layout

The canonical data root is:

```text
DATA_ROOT/
  core.sqlite
  config/
    server.jsonc
    providers/
      *.provider.jsonc
    agents/
      *.agent.jsonc
  server/
    files/
    logs/
    runtime/
      config/
      agents/
      sessions/
    migrations/
    vendor/
      models.dev/
  users/
    <user-id>/
      user.sqlite
      files/
      data/
      logs/
      config/
      workspaces/
        <workspace-id>/
          workspace.sqlite
          files/
          data/
          logs/
          artifacts/
          memory/
          threads/
          runtime/
```

`core.sqlite` stores server-owned structured state.

`server/` stores server-owned files that are not owned by a user or workspace.

`users/<user-id>/` stores user-owned files, user-local data, user logs, and user-scoped config.

`users/<user-id>/workspaces/<workspace-id>/` stores workspace-owned data and runtime outputs.

The `runtime/` folders hold rebuildable or inspectable runtime outputs.

Runtime outputs may be deleted without deleting the durable source of truth, but logs and resolved snapshots should be retained according to retention policy.

### Local mode layout

Local mode uses:

```text
DATA_ROOT/users/user_local/
```

The same path shape remains valid if a local data root is later migrated to server mode.

The migration must not rewrite workspace paths into a separate local-only tree.

### Server-owned versus user-owned data

Server-owned data includes:

- global config.
- global provider templates.
- vendored provider metadata.
- global migration state.
- process logs.
- core scheduler and diagnostics records.
- resolved server config snapshots.

User-owned data includes:

- user uploads.
- user-scoped settings.
- user-scoped provider references when supported.
- user logs that are not workspace-specific.

Workspace-owned data includes:

- repository checkouts or workspace files.
- task artifacts.
- turn and item materialization.
- workspace memory.
- agent runtime snapshots.
- workspace-specific logs.

### SQLite ownership

`core.sqlite` remains the global database for server-level state.

Per-user and per-workspace SQLite files are allowed only when the corresponding feature needs local ownership or export boundaries.

The first implementation may keep all structured state in `core.sqlite`, but the filesystem layout reserves the future split.

### Path invariants

NanoCore must reject resolved paths that escape `DATA_ROOT`.

Workspace paths must reject absolute path input and `..` escapes when they are derived from agent or user config.

No agent runtime may receive a writable mount to `DATA_ROOT/config/` or `DATA_ROOT/server/` unless that runtime is explicitly a trusted Core-managed maintenance agent.

## Rollout / Migration Plan

1. Add this spec and the matching agent config spec.
2. Audit `docs/core/storage.md`, `docs/deployment.md`, and `docs/core/architecture.md` against this layout.
3. Add schema tests before changing NanoCore loader behavior.
4. Update `ensureLayout(root)` to create the new tree without moving existing user data.
5. Only after tests pass, switch new data roots to seed `server.jsonc`.

## Testing Strategy

Required implementation tests:

- Server config schema accepts the example shape.
- Server config schema accepts `secretRef` provider credentials.
- Server config schema rejects inline provider credential fields such as `apiKey`, `token`, `secret`, and `clientSecret`.
- Server config schema rejects duplicate provider IDs.
- Default provider resolution uses provider instance IDs, not vendor IDs.
- Removed OpenKit-specific config filenames do not participate in config resolution.
- `ensureLayout(root)` creates the canonical data-root tree.
- `ensureLayout(root)` preserves existing operator-edited files.
- Path resolution rejects escapes outside `DATA_ROOT`.
- Diagnostics redact `secretRef` resolution results and URL auth components.
- Docker persistence tests verify data survives restart under one mounted data root.

## Risks & Mitigations

Risk: one large server config becomes hard to edit.

Mitigation: allow split input files while keeping one resolved server config model.

Risk: multiple provider instances for one vendor create routing ambiguity.

Mitigation: all runtime routing uses provider instance IDs.

Risk: local and server modes drift into separate storage trees.

Mitigation: require the same data-root layout and reserve `user_local` as a normal user folder.

Risk: provider credentials leak into diagnostics, logs, or resolved snapshots.

Mitigation: reject inline credential fields and keep redaction tests around provider summaries, setup diagnostics, and resolved snapshots.

Risk: data-root migration accidentally moves user files.

Mitigation: first migration pass creates missing folders and emits diagnostics; destructive cleanup is out of scope.

## Open Questions

- Should per-user provider references live under user config or always in the Secret Vault model?
- Which `server/runtime/` artifacts need retention policy in the first production-ready release?
- Should resolved config snapshots be content-addressed or timestamped?

## Links

- [chatboxai/chatbox](https://github.com/chatboxai/chatbox)
- [HKUDS/nanobot](https://github.com/HKUDS/nanobot)
- [OpenCode Config](https://opencode.ai/docs/config/)
- [RightNow-AI/openfang](https://github.com/RightNow-AI/openfang)
- [Agent Profile Config](../agent-setup-runtime-supply/20260519-agent_profile_config.md)
- [Core Storage](../../../core/storage.md)
- [Core Architecture](../../../core/architecture.md)
- [Deployment](../../../deployment.md)
- [Staging Docker Distribution](../20260518-staging_docker_distribution.md)
- [OpenAI-Compatible Internal Facade](../../superseded/20260517-openai_compat_facade.md)
