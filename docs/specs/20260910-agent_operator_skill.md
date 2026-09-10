---
status: Accepted
implementation: Partial
date: "2026-09-10"
---
# Agent Operator Skill

## Owns

This specification owns the independently distributable `openkit-ops` Skill: its installation, configuration, upgrade, diagnosis and recovery guidance; its host capability boundary; the migration of user manuals into maintained Skill references; and its package completeness and verification requirements.

## Does Not Own

The `openkit` Skill and bundled public client remain owned by `20260713-openkit_agent_skill_interface.md`. This specification does not create a general shell API, internal Agent harness, host credential store, deployment supervisor, approval mechanism, release identity or automatic maintenance service. Configuration, backup, authentication, Vault, NanoHost, release and App-update owners retain their contracts. Skill instructions grant no capability or authorization.

## Core References

- `docs/core/architecture.md`
- `docs/core/agent-capability.md`
- `docs/core/permissions.md`
- `docs/core/audit.md`
- `docs/core/vault.md`

## Summary And Decision

Installation and offline recovery require a client that can operate when NanoCore cannot answer. Supply one operations Skill alongside the existing public-product Skill. It serves the same operator whether their Agent runs on a desktop or performs explicitly authorized operations for the deployed product. It is not a development-only product client or another workflow engine.

The operations Skill is a concise router to directly linked references and repeatable supported scripts. It teaches the Agent to establish the requested target and effect scope, inspect current facts, choose the existing procedure, perform authorized work and verify its result. It must work outside the source checkout. Source builds may explicitly acquire the selected source snapshot; an installed Skill must not silently depend on the author's checkout, private SSH alias, credentials, temporary investigation files or network-accessible documentation to recover an offline deployment.

## Contract

`skills/openkit-ops/SKILL.md` is the entrypoint. Canonical English operator material lives in its `references/` directory. Scripts exist only for demonstrated repeatable operations; the package has no daemon, dependency manager, fleet inventory or runtime-specific agent implementation. The installed Agent supplies supported shell/SSH/network tools and current authority. An internal Agent without the required host tools delegates to an authorized execution capability or reports it unavailable; loading this Skill must not pierce Worker containment or supply a Docker socket to NanoCore.

Use public NanoCore operations for running-product configuration and records. The `openkit` Skill remains the discoverable product client, including public administration. Host inspection, install, process replacement and offline recovery use the operator's separately authorized tools. Move the duplicated stopped-server recovery procedure out of the public Skill administration reference into the operations package; the public reference keeps only the credential-store handoff and discovery pointer. The operations package must not copy the public operation catalog or credential implementation. Missing product Skill availability is reported when a procedure needs it; host-only install and recovery remain usable independently.

Routine update guidance targets NanoCore and Web together. NanoHost installation, image supply and recovery are clearly separate procedures requiring their own task scope. A single persistent deployment is the normal target; no second instance or second machine is required. Additional staging is optional when a particular destructive, isolated or container-owning check needs it.

Every executable procedure states its prerequisites, target identity, effects, success observation and failure/recovery action. Offline recovery through the existing release-image `openkit-operator` executable requires a working container runtime and the selected compatible App image already available locally or explicitly acquired; it does not require the target NanoCore process to run. Source procedures explicitly acquire the selected checkout and its toolchain. Current credentials and data are reused; credential material stays in protected files or existing secure stores, never prompts, argv, logs or evidence. Recovery does not mean bootstrap replay, direct live database mutation, Vault key regeneration or silent loss of user work. A changed image is not proof that data migration is reversible. A procedure that cannot establish safe preconditions stops before its dependent effect and retains the deciding non-secret observation.

Procedures retain exact source/image and current boot identity where relevant. Existing public Audit, Usage, Task and Artifact records remain product evidence. Host observations remain external evidence until explicitly recorded through an existing public owner; neither a successful shell exit nor a receipt rewrites interrupted product work as completed.

## Manual Migration And Maintenance

Move maintained user/operator instructions from `docs/manual/` into Skill references and update current inbound links. The old manual directory retains its discovery README and any single-source pointers needed by frozen historical links, not parallel instruction pages or placeholders claiming implementation. All migrated manuals, including the product-use overview, belong to `skills/openkit-ops/references/`. Detailed public-client operation guidance remains in the existing `openkit` Skill; the operations package explains that handoff without copying the client catalog. A topic has one maintained source. Unsupported roadmap behavior is identified as unavailable, not presented as an executable procedure.

`docs/documentation-model.md` owns the resulting non-authoritative operator-reference type and localization rules. Repository cookbooks retain developer procedure ownership. A release packager may copy a required cookbook into the Skill as a generated projection with explicit provenance, but it must not introduce another independently maintained copy or require unresolved repository-relative links in the installed archive. Generated files are recreated from their source, never hand-maintained. Product Vision is unchanged.

A relevant runtime, CLI, configuration or deployment change updates the affected Skill reference in the same slice. Replacing the installed complete package is the upgrade lifecycle; there is no in-place self-modifying Skill code, installed-source merge, compatibility alias or automatic rollback of user data. Unknown versions, missing files or an unsupported host yield a specific unmet prerequisite, not a speculative repair.

## Release And Acceptance

The release-management owner distributes a separate `openkit-ops-skill-<tag>.tar.gz` containing the complete Skill tree and repository license, under the same source tag and checksum verification as other portable assets. Local source packaging uses the same tree and verification. Packaging or installation does not start a service, enroll NanoHost, acquire privileges or mutate product state.

Acceptance requires a complete archive used from outside the checkout, resolvable internal reference links, current commands and declared runtime requirements, and a fresh Skill-capable Agent completing a bounded authorized operator task using only that package and normal host tools. An offline recovery procedure must remain readable and executable without the target NanoCore. Validate secret handling and the actual effects of any supplied script using the lowest sufficient regression; do not treat Skill metadata validation as behavioral proof.

## Current Implementation Projection

The operations Skill entrypoint and six maintained references are present, and current user manuals have moved into that tree. The old manual directory retains discovery pointers for existing and frozen links. The release packager produces the separate archive, and both packaging and post-publication verification use the same extracted-reference check. Local archive verification and a fresh Agent's bounded read-only deployment diagnosis have passed. Release publication and actual offline recovery execution were not demonstrated by that diagnosis. App-triggered host updates follow the separately accepted `20260910-app_update_delivery.md`; this Skill does not independently authorize that effect path.

## Alternatives And Deferred Work

Keeping another manual corpus duplicates maintenance. Expanding the product CLI into arbitrary host control breaks its public-contract boundary. A co-deployed coding Agent, autonomous customer optimization and mandatory dual-instance operation are not required. New procedures may be added when their existing owners and working commands can be projected; unsupported operations remain explicit rather than triggering speculative infrastructure.
