# Layered User and Workspace Configuration

Status: Superseded

Superseded by: [NanoCore Config And Identity Contract](../../20260628-nanocore_config_identity_contract.md)

Reference status: retained for detailed historical auth, identity, config, and data-layout context after consolidation.

## Summary

OpenKit needs workspace-level configuration in addition to the existing server-owned runtime configuration. User-level configuration is part of the long-term model, but the first implementation should reserve the boundary and skip user config behavior until OpenKit has enough personalization and BYOK surface area to justify it.

The design should keep physical files aligned with ownership while centralizing the logical configuration contract in code. `DATA_ROOT/config` remains the server-owned runtime config root. Workspace config belongs under the owning user's workspace tree. Future user config belongs under the user-owned tree.

The future implementation should introduce a code-owned config contract package that defines schemas, generated JSON Schema, merge policy, override rules, validation, and effective-config resolution. Specs explain intent, but runtime behavior must be enforced by schemas, resolver code, conformance fixtures, and import boundaries.

## Goals / Non-goals

### Goals

1. Define where workspace config files should live and reserve the future user config location.
2. Preserve the existing server-owned `DATA_ROOT/config` boundary.
3. Define the logical precedence and override model for server, workspace, future user, and request-scoped config.
4. Prevent lower-priority layers from expanding privileges beyond server or workspace policy.
5. Give NanoCore one authoritative way to resolve effective config for turns, agent sessions, diagnostics, and reload planning.
6. Make config behavior testable through schema conformance and resolver fixtures.
7. Keep protocol surfaces small and redacted while still exposing useful diagnostics and version tracking.

### Non-goals

- Do not implement the config package in this spec.
- Do not define every final workspace or future user config field.
- Do not move the existing server config files.
- Do not implement user config in V1.
- Do not make repo-local config trusted by default.
- Do not allow user or workspace config to contain raw secret values.
- Do not design or implement sandbox and permission-profile configuration in V1.
- Do not design remote data mounts, cloud bucket mounts, or adapter-specific mount materialization in this spec.
- Do not make `packages/protocol` own the complete runtime config model.
- Do not automatically interrupt active turns or active agent sessions when config changes.

## Background

The current runtime config implementation manages these server-owned authored files:

```text
DATA_ROOT/config/server.jsonc
DATA_ROOT/config/providers/*.provider.jsonc
DATA_ROOT/config/agents/*.agent.jsonc
```

The existing runtime config reload design uses a last-known-good snapshot, diffs new disk state against the active snapshot, and lets new work use the latest successfully applied snapshot while already accepted turns and active agent sessions continue with the snapshot they captured.

Core storage docs already divide durable data into server-owned, user-owned, and workspace-owned areas. The server config and data layout spec reserves `DATA_ROOT/config` for global server config, provider profiles, and agent setup sources, while `DATA_ROOT/users/<user-id>/` and nested workspace folders own user and workspace data.

This means user and workspace config should not be added to `DATA_ROOT/config` just because they are configuration files. The physical path should reflect the owner and lifecycle of the data.

## Decision

Workspace config files are stored under the owning user's workspace data root:

```text
DATA_ROOT/users/<user-id>/workspaces/<workspace-id>/config/workspace.jsonc
```

Local mode uses the same shape with the implicit local user:

```text
DATA_ROOT/users/user_local/workspaces/<workspace-id>/config/workspace.jsonc
```

The future user config path is reserved but not implemented in V1:

```text
DATA_ROOT/users/<user-id>/config/user.jsonc
DATA_ROOT/users/user_local/config/user.jsonc
```

In the first implementation, user-level behavior should remain out of scope except where the resolver needs a reserved layer for future schema evolution. User config is expected to start as personalization and user-owned references, such as theme preferences, editor preferences, notification preferences, and personal `secretRef` values.

`DATA_ROOT/config` remains server-owned:

```text
DATA_ROOT/config/server.jsonc
DATA_ROOT/config/providers/*.provider.jsonc
DATA_ROOT/config/agents/*.agent.jsonc
```

OpenKit should add a config contract package that owns machine-enforced schemas, merge rules, effective-config resolution, generated JSON Schema, and conformance fixtures. The package should be consumed by NanoCore, the config UI schema catalog, tests, and any future tools that need to validate or explain config behavior.

## Proposed Design

### Ownership model

Configuration is split by owner, not by convenience of discovery:

| Layer | Owner | Physical source | Primary purpose |
| --- | --- | --- | --- |
| Built-in defaults | OpenKit release | package source | safe defaults and documented schema defaults |
| Server config | Core operator | `DATA_ROOT/config/*` | deployment posture, provider instances, global agent setup sources, server defaults, gateway and diagnostics policy |
| Workspace config | workspace owner or authorized member | `DATA_ROOT/users/<user-id>/workspaces/<workspace-id>/config/workspace.jsonc` | shared workspace policy, defaults, context rules, workflow commands, and workspace-scoped references |
| Future user config | user | `DATA_ROOT/users/<user-id>/config/user.jsonc` | personal preferences, personal defaults, editor settings, notification policy, and personal references |
| Request/session input | caller | API request or UI action | explicit per-turn or per-session choices |

The physical path is not the trust model by itself. NanoCore still authorizes reads and writes through app APIs, membership checks, admin checks, and future permission policy.

### Server-owned config boundary

Server config owns fields that affect the Core process, global routing surface, or deployment security posture.

Examples:

- `mode`
- HTTP bind host and port
- auth provider and signup posture
- data root and layout version
- global provider instances
- internal OpenAI-compatible gateway route and auth policy
- server diagnostics and redaction policy
- server-projected agent setup sources

Workspace config and future user config must not redefine these fields.

### Workspace config boundary

Workspace config owns shared behavior for one workspace.

Expected areas include:

- default agent and profile selection within server-projected or workspace-authorized supply
- model allowlist or default model references within server-visible provider policy
- simple host-accessible workspace data directories for V1
- context include and exclude rules
- repository workflow commands such as test, lint, build, release, and commit checks
- workspace memory and retrieval preferences
- long-running task defaults such as max iterations, timeout, and budget policy
- workspace-level secret references, grants, and non-secret metadata
- workspace-specific UI defaults that should be shared by members

Workspace config may tighten policy or choose within server-provided options. It must not expand beyond server policy.

### Future user config boundary

User config is deferred from V1. When implemented, it should own personal behavior and preferences.

Expected areas include:

- UI theme, density, language, timezone, and accessibility preferences
- editor preferences such as font size, wrapping, diagnostics visibility, and source editor behavior
- personal default agent, profile, model, and reasoning preference within workspace policy
- personal tool consent preferences where policy allows prompting
- notification, automation follow-up, and heartbeat preferences
- personal provider or integration references through `secretRef`
- per-workspace personal overrides that do not affect other members

Future user config may restrict or select within workspace and server policy. It must not grant capabilities, providers, tools, workspace paths, or sandbox levels that the workspace or server does not allow.

### Effective config resolution

Runtime code should not read raw server, workspace, or future user config directly after loading. It should resolve an `EffectiveConfig` for the operation being accepted.

Conceptual order:

```text
built-in defaults
  -> server deployment policy
  -> server provider and agent supply
  -> workspace config
  -> future user config
  -> request or session explicit input
  -> late-bound vault, memory, and runtime values
```

This order is not a simple object spread. Each field has an explicit merge and override policy.

Example policies:

| Field area | Merge policy | User override rule |
| --- | --- | --- |
| server bind/auth/data root | server fixed | forbidden |
| provider registry | server owned with future projected views | forbidden unless a future BYOK policy grants a user-scoped provider |
| model default | workspace selects within server policy | user may select within workspace allowlist |
| model allowlist | server and workspace intersection | user may restrict only |
| workspace data directories | workspace owned with server path validation | user cannot expand silently |
| editor theme | user preference | user owns |
| test command | workspace owned | user cannot silently override shared workflow behavior |
| notification preference | user preference | user owns |

Sandbox, permission-profile, shell, browser, network, and filesystem-policy configuration is intentionally out of V1. OpenKit currently treats workers as already running in an isolated controlled environment, whether the worker is host-based, local-container-based, or remote-container-based. V1 workspace config should not duplicate that isolation boundary.

Instead, OpenKit should provide each worker agent with an OpenKit-owned default runtime policy. The local repository's `.codex/config.toml` is a useful example of this pattern: it sets worker defaults such as `sandbox_mode = "danger-full-access"`, `approval_policy = "on-request"`, and `approvals_reviewer = "auto_review"` outside the workspace config authored by users. OpenKit may later expose a small set of admin-owned defaults per worker adapter, but V1 should not let workspace users build arbitrary sandbox or permission profiles.

### Workspace materialization V1

Workspace config must be able to describe the directories a worker needs before it starts.

For V1, materialization is intentionally minimal:

- only host-local directories are supported
- the directory must be resolved and validated by NanoCore before the worker starts
- the directory is exposed to the worker as a workspace root or named path
- the worker receives a concrete host path or adapter-native path only after validation
- the config must not use `..`, absolute paths, symlink escapes, or paths outside the workspace storage boundary
- `access` is a declared intent in host-worker V1, not a promise of OS-level read-only enforcement
- `createIfMissing` is allowed only for `read-write` roots and is intended for output directories
- worker launch receives a generic `workspaceRoots` array
- reload does not mutate already-running worker sessions

Example:

```jsonc
{
  "workspace": {
    "roots": [
      {
        "id": "repo",
        "kind": "host-dir",
        "path": "files/repo",
        "access": "read-write"
      },
      {
        "id": "data",
        "kind": "host-dir",
        "path": "files/data",
        "access": "read-only"
      },
      {
        "id": "outputs",
        "kind": "host-dir",
        "path": "artifacts",
        "access": "read-write",
        "createIfMissing": true
      }
    ]
  }
}
```

This is enough for the first host-worker path: a data analysis workspace can point the worker at a host-accessible data directory without introducing cloud mount adapters.

Remote data sources such as S3, R2, GCS, Azure Blob, Box, Git checkouts, remote snapshots, and adapter-specific mount behavior require a separate workspace materialization spec. That future spec should define how each adapter turns declarative data sources into worker-visible directories, how credentials are injected, how read/write modes are enforced, and how outputs are collected.

### Config contract package

The implementation should add a package dedicated to config contract logic, tentatively:

```text
packages/config-schema/
```

The package should own:

```text
src/server.ts
src/provider.ts
src/agent.ts
src/workspace.ts
src/user.ts
src/effective.ts
src/policy.ts
src/resolver.ts
generated/json-schema/
fixtures/
```

Responsibilities:

- Zod schemas for authored config files. `UserConfigSchema` may be a reserved minimal schema in V1 if no user config APIs are implemented.
- Generated JSON Schema for UI hints and external validation.
- Field-level policy metadata for ownership, merge behavior, override permissions, and reload classification.
- `resolveEffectiveConfig()` as the only supported resolver.
- Redacted diagnostics and origin metadata.
- Fixtures that assert resolved output for representative server, workspace, and request combinations. Future user fixtures should be added when user config behavior is enabled.
- A redacted policy catalog keyed by config kind and JSON path.

NanoCore should consume this package instead of duplicating config rules in route handlers, orchestrator code, agent setup code, or UI-specific services.

### Field policy metadata

Each promoted config field should have policy metadata that is executable by the resolver.

Example shape:

```ts
interface ConfigFieldPolicy {
  path: string;
  owner: 'server' | 'workspace' | 'user' | 'request';
  merge: 'replace' | 'deep-merge' | 'append' | 'intersection' | 'deny-wins' | 'min-privilege';
  workspaceOverride: 'allowed' | 'restrict-only' | 'forbidden';
  userOverride: 'allowed' | 'within-workspace-policy' | 'restrict-only' | 'forbidden';
  requestOverride: 'allowed' | 'within-effective-policy' | 'forbidden';
  reloadClass: 'hot-swappable' | 'session-scoped' | 'restart-required';
  secretPolicy: 'no-secret' | 'secret-ref-only';
}
```

This table becomes the hard rule source for resolver behavior, validation diagnostics, reload diff classification, UI explanations, and tests.

### Schema and policy catalogs

Generated JSON Schema should stay focused on source shape, editor hints, and external validation.

Field policy metadata should be served as a separate catalog generated from the same config contract package:

```ts
interface ConfigPolicyCatalogEntry {
  kind: 'server' | 'provider' | 'agent' | 'workspace' | 'user' | 'effective';
  path: string;
  owner: ConfigFieldPolicy['owner'];
  merge: ConfigFieldPolicy['merge'];
  workspaceOverride: ConfigFieldPolicy['workspaceOverride'];
  userOverride: ConfigFieldPolicy['userOverride'];
  requestOverride: ConfigFieldPolicy['requestOverride'];
  reloadClass: ConfigFieldPolicy['reloadClass'];
  secretPolicy: ConfigFieldPolicy['secretPolicy'];
  summary: string;
}
```

JSON Schema may include lightweight non-authoritative annotations such as `$id`, `title`, `description`, and `x-openkit-policyRef`, but the policy catalog remains the authority for UI explanations and runtime validation. This keeps editor integration simple without turning JSON Schema into the merge-policy engine.

### Origin tracking

Resolved values should be explainable.

`EffectiveConfig` should retain redacted origin metadata for fields that affect runtime behavior:

```ts
interface ConfigValueOrigin {
  layer: 'default' | 'server' | 'workspace' | 'user' | 'request' | 'late-bound';
  fileId?: string;
  jsonPath?: string;
  revision?: string;
}
```

Diagnostics and UI can show where a value came from without exposing secret values.

### Import boundary

Runtime code should not be able to bypass effective-config resolution by importing raw authored schemas or hand-merging config objects.

The first implementation should enforce this with package exports and a focused architecture test:

- `packages/config-schema` exposes public resolver, schema catalog, policy catalog, and generated types.
- Raw authored schemas are exported only through an authoring entry point used by NanoCore loader and file-validation services.
- NanoCore route handlers, orchestrator code, provider routing, and agent session creation consume `EffectiveConfig` or explicit resolver projections.
- A test scans source imports and fails if forbidden runtime areas import raw authored config modules directly.

This avoids a new lint dependency in V1 while still making the boundary enforceable. A later repo-wide dependency rule tool can replace the scan test if the package graph grows.

### Version tracking

Runtime snapshots should track the config layers that contributed to accepted work.

The first implementation should expose a single `effectiveConfigVersion` for turns and agent sessions while internally tracking component versions:

```text
serverConfigVersion
workspaceConfigVersion
effectiveConfigVersion
```

`userConfigVersion` should be added later when user config behavior is implemented. Keeping the protocol-visible field to one effective version avoids leaking internal layering into early UI and protocol surfaces while still letting diagnostics explain component versions when needed.

Turns and agent sessions capture the effective version at acceptance or creation time. Active work is not mutated mid-flight.

### Reload and stale runtime behavior

Server runtime config reload keeps the existing last-known-good semantics.

Workspace config changes should use the same snapshot discipline:

- saved config changes do not mutate active turns
- new turns use the latest effective config for the requesting user and workspace
- active agent sessions keep the effective config they captured
- stale sessions are reported through diagnostics and thread dashboard read models

Changed workspace roots or data directories apply only to new worker sessions. V1 does not define sandbox or permission-policy reload behavior.

### Admin and app API projection

Protocol should not own the complete authored config model.

Protocol can own stable wrappers and redacted projections:

- config file summaries
- validation diagnostics
- schema catalog response wrappers
- redacted effective config summaries
- version and stale-session status
- reload or re-resolution plans

The complete authored config schemas and resolver logic belong in the config contract package.

### UI management

The existing runtime config UI can grow into a layered config editor, but each file surface should retain its ownership boundary:

- server runtime config editor for authorized operators
- workspace config editor for authorized workspace members
- future user config editor for the current user

The UI should use generated JSON Schema for hints and server-backed validation for authority. It should show origin, effective value, conflicts, and policy restrictions where possible.

### Secret handling

Workspace config and future user config must use secret references instead of raw secret values.

Allowed future reference forms may include:

- `env:NAME`
- `vault://path`
- `user://<user-id>/secret/<name>`
- `workspace://<workspace-id>/secret/<name>`

Cross-scope secret use must be explicit, authorized, and auditable.

## Alternatives Considered

### Put every config file under `DATA_ROOT/config`

Rejected.

This makes discovery simple but breaks the ownership model. User deletion, workspace export, workspace backup, membership checks, per-user privacy, and future organization-owned workspaces all become harder when user and workspace files are physically owned by the server config root.

### Store workspace and future user config only in SQLite

Rejected for the first design.

SQLite is useful for indexes, query, and operational state, but OpenKit's storage model is file-system first. JSONC files keep config inspectable, portable, diffable, and easy to back up. SQLite may index config metadata or hold derived read models.

### Put complete config schemas in `packages/protocol`

Rejected.

Protocol owns stable object names, lifecycle states, command semantics, events, errors, and compatibility rules. Full runtime config includes filesystem layout, provider details, adapter setup, secret references, and UI editing concerns. Those are implementation and config-contract concerns, not core protocol records.

### Let each subsystem merge its own config

Rejected.

Independent merging would make precedence rules drift across turns, agent setup, provider routing, UI diagnostics, and reload plans. Effective config must be resolved by one code path.

## Consequences

- The data layout stays aligned with server, user, and workspace ownership.
- Config resolution becomes a first-class code contract instead of prose-only guidance.
- Tests can assert exact precedence behavior.
- UI and NanoCore can share generated schema and diagnostics vocabulary.
- New config fields require both schema changes and policy metadata.
- The first implementation has more upfront structure, but less hidden drift over time.

## Rollout / Migration Plan

1. Accept this spec after open questions are resolved.
2. Add a minimal config contract package with workspace and effective config schemas, plus a reserved minimal user config schema if useful for future schema evolution.
3. Move existing server, provider, and agent schemas into or behind the package without changing authored file paths.
4. Add field policy metadata and resolver fixtures for the first workspace fields.
5. Update NanoCore loaders to produce layer snapshots and call `resolveEffectiveConfig()` before accepting turns or creating agent sessions.
6. Extend diagnostics with redacted effective config origin and version data.
7. Extend the Settings UI to edit workspace config through authorized Core APIs.
8. Add import restrictions so runtime code cannot bypass the resolver.

## Testing Strategy

Required tests:

- Authored schema conformance for server, provider, agent, and workspace config examples.
- Generated JSON Schema freshness tests.
- Resolver fixtures for default, server-only, workspace override, and request override cases.
- Security tests proving workspace and request input cannot expand model, host path, or provider permissions beyond server policy.
- Origin metadata tests for fields resolved from each layer.
- Version capture tests for turns and agent sessions.
- Reload and stale-session tests for workspace config changes.
- UI tests for file placement, validation, conflict handling, and effective value display.
- Import boundary tests or lint rules that prevent route and orchestrator code from reading raw authored config directly.

## Risks & Mitigations

Risk: Field policy metadata becomes verbose.

Mitigation: Require metadata only for promoted fields. Experimental data must live under `extensions` and cannot affect runtime behavior until promoted.

Risk: Resolver behavior becomes too abstract.

Mitigation: Keep V1 field coverage small and fixture-driven. Every non-obvious merge rule must have a readable fixture.

Risk: Workspace config is confused with repo-local config.

Mitigation: V1 stores workspace config in `DATA_ROOT`, not in the repository checkout. Repo-local config requires a separate trust design.

Risk: Future user preferences accidentally change shared behavior.

Mitigation: Treat user overrides as preference or restriction by default. Shared workflow behavior remains workspace-owned unless a field policy explicitly allows user selection.

Risk: Secrets leak through config editing or diagnostics.

Mitigation: Workspace config and future user config accept only `secretRef` forms. Diagnostics and effective summaries remain redacted. Source editors may show raw file text only to authorized users, and templates should prefer references.

Risk: V1 host directory roots are too limited for data-heavy agent work.

Mitigation: Keep the V1 shape compatible with future mount kinds, but implement only `host-dir`. Write a separate materialization spec before adding cloud buckets, remote snapshots, or adapter-specific mount behavior.

## Open Questions

None for this draft. Future work should create a dedicated workspace materialization spec before adding remote data mount kinds.

## Links

- [Core Storage](../core/storage.md)
- [Core Architecture](../core/architecture.md)
- [Core Protocol](../core/protocol.md)
- [Core Permissions](../core/permissions.md)
- [Core Vault](../core/vault.md)
- [Agent Supply](../core/agent-supply.md)
- [Server Config and Data Layout](./20260519-server_config_data_layout.md)
- [Runtime Config Reload](./20260525-runtime_config_reload.md)
- [Runtime Config UI Management](./20260526-runtime_config_ui.md)
