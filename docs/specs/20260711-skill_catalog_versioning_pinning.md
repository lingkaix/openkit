---
status: Draft
implementation: Not Started
---
# Skill Catalog Versioning And Pinning

## Owns

- The entry conditions and minimum integrity boundaries for a possible future worker Skill catalog.
- The future minimum of immutable content identity, one current pointer, one workspace pin, exact package-snapshot lineage, verified materialization, and pointer-only rollback.

## Does Not Own

- Any current V1 capability, implementation, schema, route, operation catalog entry, runner, test obligation, or release gate.
- The current Knowledge and self-improvement flows. Neither depends on a Skill Catalog.
- The end-user `openkit` Skill, worker Skill authoring UX, Skill execution semantics, allowed-tool enforcement, or sandbox behavior.
- A registry, marketplace, import/export service, deprecation lifecycle, garbage collector, backup format, dependency resolver, or cross-deployment distribution platform.
- Agent Environment Package resolution or materialization mechanics beyond the future integrity constraints stated here.

## Core References

- `docs/core/foundation.md`
- `docs/core/agent-supply.md`
- `docs/core/permissions.md`
- `docs/core/audit.md`

## Summary

This Draft is a non-authorizing future boundary. OpenKit does not currently materialize a real worker Skill for a real worker consumer, so a catalog, version store, pinning API, and promotion platform have no demonstrated present owner. The static worker-supply metadata in NanoCore is not a materialized Skill catalog and must not be used to justify building one.

Design work may resume only when a real worker Skill is supplied as files to a real consumer and a concrete need exists to advance that Skill while one workspace remains on an exact earlier version. Until then, current static metadata may remain a narrow implementation detail, and this Draft authorizes no production or test work.

## Goals / Non-goals

### Goals

- Preserve the minimum content-integrity, authority, pinning, rollback, failure, and observability decisions required before a catalog could be accepted.
- Prevent package snapshots or worker materialization from silently resolving mutable or unverified Skill content.
- Avoid turning a future version-selection need into a general Skill platform.

### Non-goals

- Do not authorize catalog APIs, persistence, bootstrap seeding, repository import, Git integration, export, backup, deprecation, garbage collection, labels, semantic versions, version ranges, dependencies, or discovery.
- Do not create a prerequisite for current Knowledge, self-improvement, reflection, evaluation, or proposal workflows.
- Do not preserve or replace the hardcoded metadata table through a compatibility layer.

## Decision

No implementation may be derived from this Draft. Promotion to an accepted, implementation-ready contract requires all of the following evidence:

- at least one real worker Skill is materialized as a bounded file tree and consumed by a supported worker path;
- at least two distinct contents for that Skill create a real selection or rollback need;
- at least one workspace needs to remain on an exact version while the default advances;
- the accepted change plan names the responsible authority, current consumer, storage owner, and smallest public or private mutation surface.

The first accepted slice must implement only identity, immutable versions, one current pointer, one workspace pin, exact AEP lineage, verified materialization, and pointer rollback. Any broader catalog concern requires separate accepted scope.

## Contract / Expected Behavior Before Promotion

### Content identity and security

- Version identity must be a deterministic, algorithm-versioned digest computed locally over the bounded Skill tree's root-relative paths and exact regular-file bytes in a canonical order with unambiguous framing.
- Path traversal, path escape, symbolic links, and non-regular files must be rejected before identity or materialization. The same verified tree must not be able to write outside its assigned materialization root.
- Version content is immutable. Changing, adding, deleting, or renaming a file creates a different digest; timestamps and host-specific traversal order do not affect identity.
- The exact digest framing and string form are blocking decisions for a future accepted spec and must be fixed before implementation, not improvised in code.

### Authority, pointer, and pin

- An immutable version record is the authority for content identified by a digest. One catalog entry pointer is the sole authority for the current default digest.
- One workspace pin per entry is the sole authority for that workspace's selected digest. A pin names an exact existing version; it is not a range, label, or mutable alias.
- Resolution uses the workspace pin when present and otherwise the entry's current pointer. Moving the current pointer must never mutate or release workspace pins.
- Promotion and rollback are compare-and-set pointer moves to existing verified versions. They never mutate version content. Rollback may select an explicitly named prior digest; it does not require a second rollback workflow or mutable response history.
- Current authority must govern every pointer and pin mutation, and every successful behavior-changing mutation must produce the existing audit evidence with actor, entry, prior digest, and resulting digest. No ambient-system or inferred-owner fallback is allowed.

### Package snapshot and materialization

- A resolved Agent Environment Package snapshot records the exact entry identity and version digest. It never records `current`, a mutable source path, or a host-provided revision as the executable identity.
- Materialization recomputes and verifies the version digest before exposing Skill files to the worker. Missing or mismatched content fails launch typed and closed; it must not fall back to a static catalog row, repository working tree, another version, or unverified files.
- After restart, durable pointers and pins remain the only selection authority. Materialization may be retried from the same exact digest, but catalog code must not auto-repair, republish, or advance selection.

## Current Implementation Projection

`apps/nanocore/src/runtime/agent-environment.ts` contains a static `WORKER_SKILL_CATALOG` metadata row, and the worker shim projects inert supply metadata rather than materializing a worker Skill tree. The repository's `skills/openkit/SKILL.md` is the end-user Agent Skill interface, not proof of a worker Skill catalog consumer. No current record, pin, content store, digest-verified worker Skill materialization, or catalog mutation surface implements this Draft.

## Testing Strategy / Acceptance Criteria

This Draft creates no current test obligation. When the entry gate is met, the accepted first slice must prove only the promoted boundary:

- identical safe trees produce the same digest, every material content or path change changes it, and unsafe paths or file types are rejected;
- an authorized current-pointer move changes unpinned resolution while an existing workspace pin remains unchanged;
- rollback moves only the current pointer to an existing verified digest;
- an AEP snapshot names the exact resolved digest and materialization rejects missing or tampered content;
- unauthorized pointer or pin mutation fails closed and successful mutations emit the required audit evidence;
- restart preserves selection from the durable pointer and pin without repair or fallback.

The accepted change should use the lowest sufficient unit and contract tests plus one real worker-path integration proof. It must not create a dedicated catalog runner, import/export harness, exhaustive storage matrix, or self-improvement acceptance platform.

## Open Questions

- [Blocking] Which first real worker Skill and supported consumer establish the catalog's present need?
- [Blocking] What exact digest framing and string form will be the immutable identity contract?
- [Blocking] Which existing authority operation governs the first current-pointer and workspace-pin mutations?
- [Blocking] Where will the minimum immutable content and pointer records live without introducing a second storage authority?

## Deferred / Future Work

Public discovery and mutation APIs, registries, marketplaces, source import, export, backup integration, provenance enrichment, deprecation, garbage collection, semantic labels, dependency resolution, cross-deployment distribution, signing, shared-content deduplication, and self-improvement proposal integration remain unapproved possibilities. None is implied by the minimum future contract.

## Links


- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260703-agent_manifest_aep_resolution.md`
- `docs/specs/20260713-openkit_agent_skill_interface.md`
- `docs/specs/20260529-test_strategy.md`
