---
status: Accepted
implementation: Partial
kind: boundary
date: "2026-09-10"
---
# Agent Operator Skill

## Persistent Worker Environment Procedure

The packaged operations Skill must project [Persistent Worker Volumes](20260910-persistent_worker_volumes.md): prepare and verify the exact image first, preview and authorize affected work, stop/fence prior writers, reuse whole compatible volumes, observe readiness and preserve failure/unknown outcomes. Routine App update is separate from NanoHost update; neither permits volume deletion. Backup claims state execution-host coverage, and whole-storageRef purge requires its explicit authority. The same owned operations are available to internal administration; the Skill gains no Docker-socket or arbitrary-host privilege.

## Owns

This specification owns the independently distributable `openkit-ops` Skill: its installation, configuration, upgrade, diagnosis and recovery guidance; its host capability boundary; the migration of user manuals into maintained Skill references; and its package completeness and verification requirements.

This specification is the accepted owner of the bundled CLI. The move is not yet implemented. Until it is, the current CLI contract remains recorded in [OpenKit Agent Skill Interface](20260713-openkit_agent_skill_interface.md) and transfers here with the CLI. That recording is not a second semantic definition.

## Does Not Own

The user-facing `openkit` Skill remains owned by [OpenKit Agent Skill Interface](20260713-openkit_agent_skill_interface.md) until the remote MCP endpoint covers it. This specification does not retire that Skill. This specification does not create a general shell API, internal Agent harness, host credential store, deployment supervisor, approval mechanism, release identity or automatic maintenance service. Configuration, backup, authentication, Vault, NanoHost, release and App-update owners retain their contracts. Skill instructions grant no capability or authorization. Credential eligibility stays with [Remote Auth Credential Bootstrap](20260704-remote_auth_credential_bootstrap.md), [Multi-User Workspace System](20260715-multi_user_workspace_system.md), [Workspace Backup, Export, Import, And Data-Root Migration](20260704-workspace_backup_export_import.md), `docs/core/permissions.md`, `docs/core/identity.md`, and [Pending Requests](20260930-pending_requests.md). `docs/core/permissions.md` owns the administrator rule as Administrator Eligibility, and the other listed owners apply it at their boundaries.

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

Use public NanoCore operations for running-product configuration and records. The `openkit` Skill remains the discoverable product client, including public administration, until the remote MCP endpoint covers it. Host inspection, install, process replacement and offline recovery use the operator's separately authorized tools. Move the duplicated stopped-server recovery procedure out of the public Skill administration reference into the operations package; the public reference keeps only the credential-store handoff and discovery pointer. The operations package must not copy the public operation catalog or credential implementation. Missing product Skill availability is reported when a procedure needs it; host-only install and recovery remain usable independently.

The bundled CLI moves under this Skill and is not a separate package. It is used with an administrator token. Its online commands are derived from the operation definitions in [Operation Definition](20261002-operation_definition.md), not copied into a second catalog. It writes one-time secrets to local secret-safe sinks instead of model output. Bootstrap, which uses the bootstrap secret, and offline host procedures, including stopped-server recovery and restore, stay separately authorized. An online route cannot replace them. Covering product operations does not expand this CLI into arbitrary host control.

The accepted target is that a currently usable administrator credential, the administrator's Web session or an administrator bearer, is eligible for every operation, including operations on other users' resources, through one rule in the existing authorizer and not through a second permission model. That eligibility includes recovering a resource another user deleted, reading other users' private Threads and private-derived content, answering approvals raised to other users, archive export and import of any Workspace, and managing the administrator's own access tokens. Attribution stays truthful. The administrator is the recorded actor and does not impersonate the affected user, and a recovered resource returns to its original owner. Per-effect authority objects, such as approval records and Vault grants, still exist and are checked, and the administrator may create or issue them. Credential limits and the sandbox boundary are unchanged. A read-only credential stays read-only, revocation and expiry apply, and the sandbox boundary applies to every actor. The Policy Kernel later refines this authority with fine-grained policy. `docs/core/permissions.md` owns this rule as Administrator Eligibility. [Remote Auth Credential Bootstrap](20260704-remote_auth_credential_bootstrap.md), [Multi-User Workspace System](20260715-multi_user_workspace_system.md), [Workspace Backup, Export, Import, And Data-Root Migration](20260704-workspace_backup_export_import.md), `docs/core/identity.md`, and [Pending Requests](20260930-pending_requests.md) apply it at their boundaries. The rulings are recorded in [Operation Definition Rulings](../decisions/20261002-operation_definition_rulings.md) and [Administrator Authority](../decisions/20261002-administrator_authority.md).

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
