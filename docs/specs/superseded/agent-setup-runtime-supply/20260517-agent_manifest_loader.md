# Agent Config Loader

Status: Superseded
Implementation: N/A
Status Changed: 2026-06-28
Current Guidance: `docs/specs/20260628-agent_setup_runtime_supply_contract.md`
Decision Evidence: `docs/changes/202607111650190001-spec_lifecycle_governance.md`

## Lifecycle Reason

The Agent Setup And Runtime Supply Contract absorbed the loader's file format, validation, identity, and readiness responsibilities into the single active supply contract. The standalone loader slice ceased to be authoritative because those rules must evolve together with manifest resolution and package assembly.

## Retention Reason

This document preserves the first file-backed loader behavior, validation cases, and implementation mapping so regressions can be compared with the original slice while all current decisions remain owned by the consolidated contract.

## Summary

NanoCore now has one file-backed agent config contract and JSONC loader for `data/config/agents/*.agent.jsonc`.

The loader establishes the agent and agent-shape setup skeleton needed by later readiness, selection, and orchestration stories.

## Goals / Non-goals

Goals:

- Define the authored `schemaVersion: 1` agent config schema for agent identity, runtime, adapter, mode, deployment, provider/model references, skills, agents, workspace policy, readiness, and extensions.
- Define an embedded `AgentProfileSchema`.
- Load committed agent templates into the live data root without overwriting operator edits.
- Return typed diagnostics for invalid manifests instead of throwing.

Non-goals:

- Compute agent readiness.
- Select agents for turn execution.
- Replace the existing host adapter or internal self-check executor paths.

## Background

Provider profiles were moved into file-backed JSONC config in US-015.

US-018 applies the same pattern to agent supply so later stories can reason about agent readiness and selection without hard-coded agent assumptions.

## Proposed Design

Agent configs live under `data/config/agents/*.agent.jsonc`.

`apps/nanocore/src/agents/manifest.ts` defines the authored agent config schema and the runtime-facing manifest type derived from it.

`apps/nanocore/src/agents/agent-shape.ts` defines profiles that can be embedded in manifests.

`apps/nanocore/src/config/agents-loader.ts` loads agent configs in sorted order and returns:

- `configs`: valid authored agent configs.
- `manifests`: runtime-facing agent manifests derived from valid configs.
- `diagnostics`: typed `agent.invalid_manifest` errors for invalid files.

`ensureLayout(root)` copies committed templates from `apps/nanocore/data-templates/config/agents/` into `data/config/agents/` only when the target file is missing.

## Template Configs

`codex.agent.jsonc` describes the host `codex app-server` agent.

`opencode-server.agent.jsonc` describes the host OpenCode server agent.

These templates are bootstrapping defaults, not an exhaustive agent catalog.

## Alternatives Considered

Hard-code agent supply in TypeScript:

- Rejected because the release goal is inspectable file-backed configuration.

Throw on invalid agent configs:

- Rejected because diagnostics should be able to report config problems while keeping the process able to surface actionable state.

## Rollout / Migration Plan

No data migration is required.

New data roots receive the Codex and OpenCode templates on `ensureLayout`.

Existing data roots receive missing template files but local edits are preserved.

## Testing Strategy

- Loader tests cover Codex and OpenCode templates copied by `ensureLayout`.
- Loader tests cover rejection for compact agent manifests, user-configured simulator agents, and unsupported transport overrides.
- Loader tests cover optional extension preservation.
- Layout tests cover non-overwrite template copy behavior.

## Risks & Mitigations

Risk: future readiness logic depends on fields that the initial schema leaves too permissive.

Mitigation: the schema captures all planned top-level fields while keeping extension sections for provider-specific and agent-specific details.

## Open Questions

- Whether profiles should eventually support separate `data/config/agents/*.agent.jsonc` files in addition to embedded manifest shapes.
- Whether agent runtime and adapter values should become closed enums after more real agent adapters exist.
