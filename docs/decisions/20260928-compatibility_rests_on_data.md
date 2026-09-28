---
status: Accepted
date: "2026-09-28"
decider: Engineer
supersedes: docs/decisions/20260709-no_backward_compatibility.md
---
# Compatibility Obligations Rest On Data

## Decision

Compatibility obligations rest on retained data, not on the surfaces that ship with each release. Retained canonical data, including persisted protocol records and retained evidence, and authored configuration stay usable while features and implementation change: they evolve additively or move forward through a one-way migration under an accepted design, never through a permanent legacy reader or dual write, and removing them requires an explicit data-retirement decision. SQLite source-of-truth records carry this obligation from the first release and keep the pre-release consolidation rule of the release schema migration decision until then. The first-party App API, protocol wire shapes, clients, CLI, Skill, Web, and implementation carry no compatibility obligation unless a separately accepted contract creates one, so refactoring deletes obsolete implementation instead of adding compatibility layers, deprecated shims, or dual writes. Core semantics stay Durable while their projections change. Protocol minor versions may carry breaking schema changes whenever an accepted specification records the decision, at any stage of the project. The obligation is prospective, and it relaxes no strict validation, execution contract, or retention rule. Root AGENTS.md NONNEG-001 and COMPAT-001 state the rule, and the Retained Data Continuity section of docs/core/contract-evolution.md owns it.

## Reason

The engineer's words, translated from Chinese on 2026-09-28: the API has no compatibility obligation now "because it ships with our system and is not used by external systems"; "what we must guarantee first is that our server's data format is stable, so that in later changes the system's features can change and its methods can migrate, but all data, including configuration files, can still be used"; platform data will later be backed up and restored through S3 or a similar mechanism, so "everything above data needs no compatibility, and only data itself carries a stability requirement". Configuration files tolerate unknown future fields: an older system reads a newer configuration file and does not act on the new keys. Asked when the rule reaches SQLite, the engineer chose to keep pre-release schema consolidation until the first release. Asked whether protocol minor versions may still break after internal development, the engineer answered, translated from Chinese: given agent-related research and the drastic changes in underlying models and protocols, the project has always stayed open to breaking changes, not only during internal development before the first release; between compatibility and a better solution, it chooses the better solution.

The earlier rule removed every compatibility obligation because the project was in internal development. That premise expires with the phase, and it never separated data, which must survive, from release-coupled surfaces, which need not.

## Rejected Alternatives

- Remove every compatibility obligation during internal development: rejected because server data must stay usable regardless of phase.
- Exempt only stable external interfaces and database migrations, the engineer's first draft on 2026-09-28: rejected in review because it mixed a stability class with a stabilization mechanism, named no current external interface, and left out file-backed retained data and configuration.
- Treat everything on disk as Durable: rejected in review because rebuildable derivatives, caches, operational telemetry, opaque Worker volume bytes, and generated execution contracts already have owners with other rules.
- Keep compatibility for the App API and other release-coupled surfaces: rejected because they ship with the system and serve no external consumer.
- Keep permanent legacy readers or dual writes to preserve data: rejected in favor of additive evolution and one-way migration.
- Start SQLite continuity immediately: the engineer kept pre-release consolidation until the first release.
- Limit breaking protocol minor versions to development before the first release: rejected because model and protocol change favors the better solution over compatibility.

## Revisit When

A consumer that ships on its own schedule starts depending on a release-coupled surface, the first release ends SQLite consolidation, or the backup and restore design changes what server data must survive.

## Affected Owners

- AGENTS.md
- docs/core/contract-evolution.md
- docs/core/protocol.md
- docs/specs/README.md
- docs/specs/AGENTS.md
- docs/specs/20260703-storage_layout_record_ownership.md
- docs/specs/20260703-schema_evolution_record_envelope.md
- docs/specs/20260715-contract_stability_baseline.md
- docs/specs/20260628-nanocore_config_identity_contract.md
- docs/specs/20260616-agent_environment_package.md
- docs/specs/20260703-agent_manifest_aep_resolution.md
- docs/specs/20260529-test_strategy.md
