---
status: Superseded
implementation: N/A
status-changed: 2026-06-28
current-guidance: "`docs/specs/20260628-nanocore_config_identity_contract.md`"
decision-evidence: "`docs/specs/20260628-nanocore_config_identity_contract.md`"
---
# Runtime Config Reload

## Lifecycle Reason

The NanoCore Config And Identity Contract consolidated reload semantics, validation, last-known-good behavior, and authored configuration ownership. This reload-only slice ceased to be authoritative because safe reload behavior now depends on the complete canonical config and identity boundary.

## Retention Reason

This document preserves the original reload state machine, failure handling, and removed compatibility cases so operational regressions can be compared with the first design without treating it as current configuration authority.

Superseded note: The 20260529 cleanup spec keeps last-known-good reload behavior but removes old config compatibility. Current config rejects top-level `dataRoot`, inline provider secrets, `provider.inline`, authored staging `apiKey`, and unknown top-level keys.

## Summary

NanoCore should support reloading user-editable runtime configuration while the Core server keeps running.

Reload must be conservative, versioned, observable, and safe for active user work.

The implementation should not duplicate boot-time config loading.

Startup and reload should share one pipeline: load files, normalize inputs, validate the resolved model, derive runtime state, diff against the current state, and apply an explicit reload plan.

Reload must never partially mutate active runtime state in a way that makes an already accepted turn or agent session observe a different configuration halfway through execution.

## Goals / Non-goals

### Goals

1. Let operators edit `DATA_ROOT/config/server.jsonc`, provider profiles, and agent config files without restarting NanoCore for changes that are safe to apply live.
2. Reuse the same load, merge, validation, and runtime derivation path for server startup and reload.
3. Compare the new resolved config with the active runtime config before applying changes.
4. Classify changes as hot-swappable, session-scoped, restart-required, or rejected.
5. Ensure new requests use the latest successfully applied config snapshot.
6. Ensure already accepted turns and already running agent sessions continue with the config snapshot they started with.
7. Expose reload status, reload errors, config version, and stale session information through diagnostics.
8. Keep the protocol, NanoCore, and web UI structurally aligned.

### Non-goals

- Do not restart active agent sessions by default.
- Do not hot-reload HTTP bind host, bind port, auth mode, data root, or database configuration in the first implementation.
- Do not make file watching the only reload mechanism.
- Do not let invalid edited config replace the last known good config.
- Do not introduce compatibility with removed OpenKit config filenames.
- Do not turn runtime config reload into a general plugin lifecycle system.

## Background

NanoCore currently loads server config at startup from `DATA_ROOT/config/server.jsonc`.

Provider profiles are merged from server-level provider instances and `DATA_ROOT/config/providers/*.provider.jsonc`.

Authored agent configs are loaded from `DATA_ROOT/config/agents/*.agent.jsonc`.

The Hono app currently captures `openKitConfig`, `providerRegistry`, `providerDiagnostics`, `agentConfigs`, and `agentManifests` during `createApp()` construction.

That shape is simple but prevents a running server from observing config edits without process restart.

Runtime reload is more subtle than reading files again because active users may be in the middle of requests, turns, approvals, questions, or long-running agent sessions.

Reload also affects operational safety because some config values are safe to replace atomically while others only make sense at server startup.

## Decision

OpenKit will add a versioned `RuntimeConfigManager` in `apps/nanocore`.

The manager owns the current successfully applied `RuntimeConfigSnapshot`.

Startup and reload use the same `loadRuntimeConfig(dataRoot)` pipeline.

Reload computes `diffRuntimeConfig(previous, next)` before mutating active runtime state.

Reload applies only the portions of the diff that are classified as safe for live use.

Reload keeps the old snapshot active when the new config fails parsing, schema validation, runtime validation, or reload policy validation.

Each accepted turn and each created agent session records the config snapshot version it was accepted with.

Active turns and sessions keep using their captured snapshot until they finish or are explicitly restarted.

New turns, new quick-chat requests, new diagnostics snapshots, new provider routing decisions, and new agent sessions use the latest applied snapshot.

## Proposed Design

### Runtime config snapshot

`RuntimeConfigSnapshot` is the fully resolved runtime input for NanoCore.

It contains the parsed server config, provider registry, provider diagnostics, authored agent configs, agent manifests, resolved defaults, internal facade options, source metadata, validation diagnostics, a monotonic version, and a content hash.

Example shape:

```ts
interface RuntimeConfigSnapshot {
  version: number;
  loadedAt: string;
  contentHash: string;
  sources: RuntimeConfigSource[];
  openKitConfig: OpenKitConfig;
  providerRegistry: ProviderRegistry;
  providerDiagnostics: ProviderDiagnosticsSnapshot;
  agentConfigs: AuthoredAgentConfig[];
  agentManifests: AgentManifest[];
  internalOpenAICompatFacade: OpenAICompatFacadeOptions;
  diagnostics: RuntimeConfigDiagnostic[];
}
```

The snapshot is immutable after creation.

The manager swaps the whole snapshot reference atomically.

Route handlers read the current snapshot at the point they need runtime config rather than closing over startup-time constants.

### Shared loading pipeline

The shared loader should be the only place that knows how to turn `DATA_ROOT/config` into runtime state.

The pipeline is:

1. Read and parse `server.jsonc`.
2. Load provider profile files.
3. Merge server-level provider instances and provider profile files into one provider registry.
4. Load authored agent config files and derive agent manifests.
5. Resolve defaults and internal facade options.
6. Validate cross-resource references.
7. Redact source diagnostics that may contain secrets.
8. Build an immutable `RuntimeConfigSnapshot`.

Startup calls the loader once and applies the result as version `1`.

Reload calls the same loader, diffs the result against the active snapshot, and applies a reload plan only if the plan is acceptable.

### Diff and reload plan

`diffRuntimeConfig(previous, next)` returns structured changes.

The diff should compare resolved runtime semantics, not raw file text.

Comment-only JSONC edits must not produce a meaningful runtime change.

Secret-bearing values must never be emitted in diff details.

Example shape:

```ts
interface RuntimeConfigReloadPlan {
  previousVersion: number;
  nextVersion: number;
  applied: RuntimeConfigChange[];
  deferred: RuntimeConfigChange[];
  requiresRestart: RuntimeConfigChange[];
  rejected: RuntimeConfigChange[];
  warnings: RuntimeConfigReloadWarning[];
}
```

The reload endpoint should return the plan even when no changes are applied.

`applied` means the new snapshot can become current for new work.

`deferred` means existing sessions keep old behavior but future sessions use the new snapshot.

`requiresRestart` means the edited value cannot take effect until process restart.

`rejected` means the new snapshot must not become current.

### Change classes

Hot-swappable changes are applied to the current snapshot for new work immediately.

Examples:

- Provider display names, model lists, readiness, retry policy, endpoint URLs, and credentials.
- Core default provider and default model.
- Gateway default provider, default model, and allowlist when the route already exists.
- Diagnostics redact and origin flags.
- Agent display metadata and non-running agent setup.

Session-scoped changes are applied only to future agent sessions and future turns.

Examples:

- Agent command, args, cwd, environment, runtime adapter, transport, provider reference, model, deployment payload, and runtime config.
- Provider credential or endpoint changes for an agent session that already has a live worker process.
- Default agent changes when a thread already has an active session.

Restart-required changes are accepted as diagnostics but not applied live in the first implementation.

Examples:

- `mode`.
- `auth.enabled`, `auth.provider`, signup policy, and local-mode user identity.
- `server.bind.host`, `server.bind.port`, trusted proxy posture, and public base URL if route construction depends on it.
- `data.root` and storage layout version.
- Internal facade route enablement or route path when route registration has already happened.
- Database path and migration state.

Rejected changes fail the reload and keep the previous snapshot active.

Examples:

- Invalid JSONC.
- Schema validation failure.
- Duplicate provider IDs after merge.
- Agent config validation failure.
- Default provider, default model, or default agent references that point to missing or disabled resources when the field is required for active behavior.
- A restart-required change submitted with a strict reload mode that disallows pending restart items.

### Active request, turn, and session behavior

An HTTP request reads the active snapshot when request handling begins or when a route needs config.

The request should not observe multiple snapshot versions within the same high-level operation.

`POST /api/turns` captures the current snapshot before selecting providers, agents, and models.

The accepted turn stores `configVersion` in durable metadata.

The created agent session stores `configVersion` in durable or runtime-visible session metadata.

If reload happens while a turn is running, the running turn continues with its captured provider registry, agent config, and launch payload.

If reload removes or disables the provider or agent used by an active session, the session is marked stale but not interrupted.

If a user sends follow-up input to a thread with an active stale session, NanoCore should route it to the existing session unless policy or user action asks to restart.

If a user starts a new turn on a thread without an active session, NanoCore uses the latest snapshot.

### Stale session reporting

Diagnostics should report active sessions whose `configVersion` is older than the current snapshot.

The report should include session ID, thread ID, agent ID, captured config version, current config version, and a redacted reason summary.

The reason summary should say whether the difference touches the session's agent, provider, model, environment, command, or only unrelated config.

The UI can render a non-blocking stale marker and offer a future explicit restart action.

### Reload triggers

The first implementation should provide an explicit admin reload endpoint.

File watching can be added after manual reload is stable.

Manual reload avoids ambiguity around partially written files, editor save behavior, and accidental reload loops.

Recommended endpoint:

```text
POST /api/admin/config/reload
```

The route requires server-admin authorization in server mode.

In local mode, the route can be available behind the existing local-mode trust boundary.

The request may accept a dry-run flag:

```json
{
  "dryRun": false,
  "mode": "safe"
}
```

`dryRun: true` computes the snapshot and plan without applying it.

`mode: "safe"` applies hot-swappable and session-scoped changes but reports restart-required changes as pending.

`mode: "strict"` rejects the reload if any restart-required change is present.

### File watcher follow-up

Watcher-based reload should be opt-in.

It should debounce config changes and reload only after the file tree is quiet for a short interval.

It should watch the canonical config inputs: `server.jsonc`, `providers/*.provider.jsonc`, and `agents/*.agent.jsonc`.

It should surface the same reload plan and failure diagnostics as manual reload.

It should never apply a new snapshot when any watched file is temporarily invalid during editor save.

### App API impact

The 2026-05-27 core protocol hardening cleanup moved runtime config reload results and diagnostics out of `@openkit/protocol`.

The current owner is the App API schema pair in `apps/nanocore/src/app-api/runtime-config.ts` and `packages/core-client/src/app-api/runtime-config.ts`.

The App API payloads remain small:

- `RuntimeConfigReloadRequest`.
- `RuntimeConfigReloadResponse`.
- `RuntimeConfigChange`.
- `RuntimeConfigReloadPlan`.
- `RuntimeConfigStatus`.

The response should include only redacted paths, field identifiers, change class, action, and messages.

Core protocol records may expose only a product-safe sandbox summary or workspace root references. They must not expose materialized host paths, worker paths, launch commands, environment variables, provider config, or runtime config payloads.

It must not include raw provider secrets, inline API keys, environment variable values, or full agent environment payloads.

### NanoCore impact

`apps/nanocore` should add the shared loader, diff, manager, and endpoint.

`createApp()` should depend on a manager instead of static config objects.

Routes that currently use startup-captured config should read from `runtimeConfig.current()`.

`startTurn()` should receive a snapshot or a snapshot-derived runtime context instead of independently receiving loose config pieces.

Diagnostics should include `runtimeConfig.currentVersion`, `runtimeConfig.lastReload`, `runtimeConfig.lastFailedReload`, and pending restart items.

The internal OpenAI-compatible facade needs special handling because route registration currently happens when the app is built.

The first implementation can treat facade enablement and route path changes as restart-required while still allowing default provider, default model, and allowlist changes to be hot-swappable if the facade reads provider policy from the current snapshot.

### Web impact

`apps/web` should eventually show runtime config status in diagnostics.

The UI should support manual reload, dry-run preview, current config version, last reload result, and stale session markers.

The UI should not imply that restart-required changes are live.

### Data and audit trail

NanoCore should keep the last successful reload result and the last failed reload result in runtime memory.

Persisting a redacted resolved snapshot under `DATA_ROOT/server/runtime/config/` can be useful but should not be required for the first implementation.

If persisted later, the snapshot must be redacted and should be treated as diagnostic output, not as an authoring source.

## Alternatives Considered

### Restart-only

Restart-only is operationally simple but creates a poor local and staging experience.

It also pushes users toward unnecessary process restarts for provider, model, and agent setup changes that can safely affect only new work.

### Blind reload without diff

Blind reload is easier to implement but unsafe.

It cannot explain which changes took effect, which were deferred, and which require restart.

It also makes active session behavior ambiguous.

### Mutate existing registries in place

In-place mutation avoids swapping references but increases race risk and makes request-level consistency harder.

Immutable snapshots plus atomic manager replacement are easier to reason about and test.

### Automatically restart active sessions

Automatic restart makes config edits feel immediate but can destroy in-progress user work.

The default should be non-interrupting.

Explicit user-initiated restart can be added later.

## Rollout Plan

1. Add protocol schemas for reload request, reload response, reload plan, and redacted status.
2. Add `loadRuntimeConfig(dataRoot)` in `apps/nanocore` and move startup config derivation behind it.
3. Add diff and plan generation tests before implementation.
4. Add `RuntimeConfigManager` and route handlers that read current snapshots.
5. Add manual reload and dry-run endpoint.
6. Thread `configVersion` through turn acceptance and agent session read models.
7. Add diagnostics for current config status, failed reloads, pending restart changes, and stale sessions.
8. Add web diagnostics and manual reload UI.
9. Consider opt-in file watching after manual reload has settled.

## Testing Strategy

Unit tests should cover loading the same resolved snapshot through startup and reload.

Diff tests should cover no-op comment changes, provider additions, provider updates, agent config changes, default changes, restart-required changes, invalid config, and duplicate provider IDs.

Manager tests should prove failed reload keeps the previous snapshot active.

Manager tests should prove successful reload increments config version atomically.

Turn orchestration tests should prove a turn captures one config version and keeps using it when reload happens afterward.

Session tests should prove active sessions are marked stale instead of being interrupted.

API tests should cover manual reload, dry-run reload, strict reload rejection, safe reload with pending restart items, and redaction.

Web tests should cover display of current version, failed reload status, pending restart items, and stale session markers once the UI exists.

## Risks & Mitigations

Risk: A route accidentally closes over startup config and ignores reload.

Mitigation: Make the manager the only app dependency and remove loose static config fields from `CreateAppOptions` where practical.

Risk: A secret leaks through diff or diagnostics.

Mitigation: Diff only redacted semantic fields and add regression tests that prove inline `apiKey`, `token`, `secret`, and `clientSecret` inputs are rejected before diff details are emitted.

Risk: Reload changes route topology that Hono registered at startup.

Mitigation: Classify route topology as restart-required until those routes are explicitly made dynamic.

Risk: File watcher reload sees a partially written config file.

Mitigation: Start with manual reload and make watcher reload opt-in with debounce and last-known-good semantics.

Risk: Active sessions behave differently after provider or agent changes.

Mitigation: Capture config snapshots at turn and session creation and mark stale sessions rather than mutating them.

Risk: The diff becomes too implementation-specific.

Mitigation: Diff resolved runtime semantics and keep raw file paths and parse details as diagnostics only.

## Open Questions

Should reload status be visible through `/api/app/diagnostics`, `/api/setup/diagnostics`, a new admin endpoint, or all three?

Should strict reload reject any restart-required change, or only restart-required changes that differ from the active snapshot?

Should `configVersion` be persisted on turn records in the protocol model, or stored only as NanoCore runtime metadata first?

Should provider credential changes mark active sessions stale even when the provider ID and model list are unchanged?

What admin authorization shape should protect reload in server mode before a full role model exists?

When file watching is added, should it be enabled by config, environment variable, or local mode only?

## Links

- [Server Config and Data Layout](./20260519-server_config_data_layout.md)
- [Agent Profile Config](../agent-setup-runtime-supply/20260519-agent_profile_config.md)
- [Agent Profile Model](../agent-setup-runtime-supply/20260522-agent_profile_model.md)
- [NanoCore DATA_ROOT Config Guide](../../../manual/nanocore-data-root-config.en.md)
- [Change Execution Governance](../../../change-execution.md)
