# Contract Stability And Single-Deployment Multi-User Workspaces

Type: change-plan
Status: verified
Canonical Specs: `docs/specs/20260715-contract_stability_baseline.md`, `docs/specs/20260715-multi_user_workspace_system.md`

## Intent

Establish the pre-release stability boundary for OpenKit and implement the smallest complete multi-user Workspace system for one personal or small-team NanoCore deployment.

The work preserves durable Core meaning, data, authority, audit, and portability while keeping App API, Core Client, bundled CLI, and unified Skill projections free to evolve as one exact release. It replaces the current physically user-owned Workspace model with one canonical owner-independent Workspace root and completes the bounded membership, authorization, attribution, concurrency, lifecycle, and portability kernel. The rebuilt Web projection follows in post-program S10.

This record begins with a documentation-only checkpoint. No protocol schema, database migration, storage move, application behavior, test implementation, generated artifact, or user-facing product surface is changed by that checkpoint.

## Inherited Audit Responsibility (2026-07-17)

This plan is work package WP-5 of the [OpenKit Execution Program](./202607172152230001-openkit_execution_program.md) and absorbs audit group G06 from the [alignment audit](./202607111941330001-core_spec_implementation_alignment_audit.md). The G06 document set (C10 Identity, C11 Vault, C15 Permissions, S52-S58, S63, and their supporting projections) and the G06 exit criteria in the audit ledger are inherited inputs. The program's convergence rules bind all work here; when verifying S62 gates, reflect the central idempotency default promoted into C07/S62 during WP-0, and apply the "two independent implementers" bar only to Durable contract families.

The bounded G06 review-only preamble is recorded below. It freezes only the five implementation lines named there and authorizes no additional recovery workflow, authorization engine, migration state machine, concurrency framework, product surface, reusable migration runner, or harness. The Stage 3 stopped-process CLI is only the narrow invocation owner for this one migration.

### G06 Review-Only Preamble (2026-07-19)

- Authority map: C10/S52-S53 own user, credential, token, and actor identity while Core registry/member/invitation rows own Workspace relationships; C15/S55 own policy semantics, S56 owns product mapping and durable decisions, and S63 owns the fixed role plus central-resolver contract.
- Authority map: C09/S46/S51 own storage and portability, S63 owns the top-level migration target, C11/S57-S58 own Vault references, grants, injection and backend boundaries, C17/S59 own audit projection, and S54 plus the existing layout marker own boot admission; none becomes a second owner in WP-5.
- `SECURITY-GAP`: freeze removal of implicit `server-admin` content access, authorization before any Workspace opener, owner-only policy for Workspace Vault list/rebind, restrictive user foreign keys before deletion, and one current-authority check at admission and governed-effect boundaries.
- `IMPLEMENTATION-DEFECT`: freeze owner-independent openers and migration, atomic schema migration plus ledger publication, hot-backup exclusion of the process lock and SQLite transient siblings, receipt-backed `workspace.import`, and truthful post-publication restore cleanup semantics.
- `OWNERSHIP-CONFLICT` / `DOC-DRIFT`: S46/S49 now name `workspace.sqlite` as the synchronization authority; S63/S55/S56 keep policy evaluation separate from product decisions; Vault grant export and organization scope, stale Git wording, obsolete Artifact registration language, and S62 Skill/CLI status are corrected before code.
- `NO-ACTION`: imported unbound Vault-reference re-export already has exact source-shape conversion and round-trip coverage, so its stale Backlog entry is removed without implementation.
- `DESIGN-DEFECT`: delete the global pre-test phase, migration journal and special boot mode, open-ended CAS families, gate takeover, runtime quarantine workflow, Cartesian restart/concurrency matrices, and the second L6 story; retain one representative publish-window, resolver-shape, restart, and agent-first proof.
- Frozen implementation scope: owner-independent storage plus one-way migration; membership/invitation/owner lifecycle; one central resolver plus fixed policy roles; bounded ActorRef/CAS/first-writer semantics; current-authority corrections on existing runtime, search, Action Center, Vault, backup, and portability surfaces. Web remains with post-program S10.
- Exit criteria confirmed: one-deployment trust domain, fail-closed actor/membership/policy resolution, secure existing bootstrap/token behavior at touched interfaces, Vault isolation, redaction, and existing cleanup-contract regression at touched interfaces, durable attribution, no implicit administrator bypass, and no second tenancy, RBAC, workflow, or test platform. No finding is dispatched outside the existing program Backlog.

## Decision Summary

- Use the four Core stability classes: `Durable`, `Release-coupled`, `Experimental`, and `Private`.
- Treat promoted Core semantics, persisted and portable truth, identity, authority, audit, storage ownership, and shared-write correctness as durable contract families once their gates pass.
- Treat NanoCore App API, `@openkit/core-client`, operation catalog, bundled CLI, and unified Skill as one current release-coupled set with an exact contract identity and no cross-release compatibility promise; S10 later projects the same owners into the rebuilt Web.
- Treat one NanoCore deployment as one personal or small-team trust domain, not a tenant or organization host.
- Keep Better Auth as the authentication and session provider while OpenKit Core owns users, Workspace relationships, authorization facts, and product policy.
- Give every Workspace one canonical owner and one owner-independent physical root at `DATA_ROOT/workspaces/<workspaceId>`.
- Use fixed effective product roles `owner`, `editor`, and `viewer`, projected into the existing NGAC-aligned policy kernel rather than enforced by a second RBAC engine.
- Use registered-user invitations bound to canonical user IDs for V1; do not add outbound email, pre-account bearer invitation links, or a user directory.
- Resolve every Workspace operation through one central operation-metadata and policy path before opening storage.
- Preserve stable actor and responsible-user attribution on shared history and governed decisions.
- Add compare-and-swap only to ownership-transfer or administrator-recovery registry writes, membership writes, and invitation writes, plus durable first-writer claims to named one-shot decisions; keep every other Workspace registry command, Artifact Review, Material, Workspace apply, and immutable history on its current owner-local contract.
- Keep portable Workspace exports free of memberships, invitations, credentials, and personal state; the importing user becomes the new owner and only active member.
- Migrate once from user-nested Workspace roots without dual readers, aliases, symlinks, hard links, or compatibility folders.

## Scope

### Documentation and contract authority

- Maintain the accepted Core stability model and current stability baseline.
- Keep Core concepts, storage, identity, permissions, audit, work model, App API boundary, roadmap, storage layout, auth, policy, AEP, export/import, Quick Chat, vault, audit/usage, and schema-evolution guidance aligned with the accepted target.
- Keep this change record as the implementation lifecycle owner and update it only at material checkpoints.
- Update implementation-alignment values and current projections only when the corresponding behavior actually lands.

### Durable protocol and record contracts

- Add the smallest shared `ActorRef` contract required by user-authored Items, Turn trigger context, decisions, permission and audit records, and governed effects.
- Separate responsible-user accountability from Workspace storage resolution in AEP, scheduler, worker-control, and the currently implemented capability and usage paths; automation execution remains with the [S35 recurring-trigger specification](../specs/20260711-scheduler_recurring_event_triggers.md).
- Add or update durable identity, audit, invitation, membership, lifecycle, revision, and lineage schemas only where the accepted invariants require them.
- Remove unused organization placeholders from OpenKit-owned schemas and generated projections.

### Core database and storage

- Replace cascading owner deletion with restrictive ownership and membership references.
- Add fixed membership access, invitation lifecycle, revisions, transition constraints, and required indexes to the Core database.
- Preserve one active owner membership and derive effective owner authority from the registry.
- Move canonical Workspace trees and `workspace.sqlite` databases from `users/<ownerUserId>/workspaces/<workspaceId>` to `workspaces/<workspaceId>`.
- Make every Workspace store opener, recovery scanner, index rebuilder, importer, exporter, scheduler, and runtime path independent from authenticated user storage.
- Add a one-way offline migration invoked by one thin dedicated stopped-process operator CLI, with preflight, one-root same-filesystem staging and publication, exact verification, marker-last publication, an evidence-only report, and predecessor retention in a complete verified `DATA_ROOT` cold backup outside `DATA_ROOT`.

### Identity, authorization, and recovery

- Add registered-user invitation creation, acceptance, decline, revocation, expiry, and re-invitation behavior.
- Add owner/editor/viewer effective access, member removal and leave, access change, ownership transfer, user disable, guarded deletion, and explicit administrator recovery.
- Add one central Workspace access resolver driven by canonical operation metadata, resolved resource lineage, current membership, token intersection, and the policy kernel.
- Remove path/body authorization heuristics, filesystem-discovery authorization, handler-local role tables, and implicit `server-admin` Workspace content bypass.
- Re-evaluate membership and policy at request admission and before governed effects or approved apply.

### Shared work correctness and accountability

- Add actor attribution to the bounded record and decision families named by the multi-user spec.
- Add expected-revision compare-and-swap only to ownership-transfer or administrator-recovery registry writes, membership writes, and invitation writes; do not move another registry command or add generic mutable Artifact, Review, Knowledge, or cross-family revision machinery.
- Make invitation accept/decline/revoke, membership remove/leave, ownership transfer, and Approval decisions durable first-writer transitions before retryable runtime delivery; another family requires explicit authorization from its own specification.
- Preserve append sequence and request-id idempotency for immutable history.
- Preserve the existing staged-review, expected-base, conflict-preflight, and approved-apply contract for Workspace files.

### Runtime, search, and attention

- Keep AEP `triggerActor` as the sole runtime actor authority, make scheduler, worker control, Gateway, policy, usage, audit, and approval paths derive only the minimum required responsible-user attribution from it, and never use either identity as a storage owner.
- Leave the current in-memory non-executing automation facade unchanged in Stage 7. Workspace-owned automation, responsibility reassignment, schedule/fire records, and their current-authority check remain wholly owned by the [S35 recurring-trigger specification](../specs/20260711-scheduler_recurring_event_triggers.md).
- Build Workspace lists and global search from the authorized Workspace set before loading results.
- Filter Action Center rows by current visibility and eligible decision principal.
- Keep personal preferences, recent selection, notifications, and credentials in user scope while shared work remains in Workspace scope.
- Give every server user one independent owner-only Quick Chat Workspace and reject every Quick Chat sharing or transfer operation in V1.

### Portability and product projections

- Update portable export/import coverage in the same slice as the storage and identity change.
- Preserve historical actor references only as non-authority lineage across portable import.
- Preserve users, owners, memberships, invitations, and token metadata only in full same-deployment backups.
- Add the supported sharing lifecycle to shared App API schemas, Core Client, operation catalog, bundled CLI, and unified Skill without adding a second contract owner; defer the Web projection to S10.
- Advance one exact release contract identity and update all first-party producers and consumers together.

## Non-Goals And Cut List

- No multi-tenancy, legal tenant isolation, organization model, team hierarchy, `tenantId`, or `organizationId` placeholder.
- No Better Auth Organization, Team, Admin, or custom access-control plugin as the Workspace model.
- No custom roles, role hierarchy, groups, departments, delegated role administration, or separation-of-duty system.
- No Federation, P2P, cross-deployment collaboration, or external collaboration protocol.
- No real-time coediting, CRDT, operational transformation, presence, cursor, or general merge substrate.
- No `share/` directory, per-user reference tree, symlink, hard link, alias, Workspace copy, or dual-path reader.
- No public links, guest access, anonymous sharing, pre-account invitations, outbound invitation email, or bearer invitation secrets.
- No implicit deployment-administrator content access and no unreviewed break-glass path.
- No authorization cache until measurements prove the central resolver needs one.
- No BWM, Meta-Skill, or domain Skill type in Core protocol, storage, identity, or policy.
- No independently versioned third-party App API or SDK support policy.
- No compatibility aliases, deprecated routes, old field readers, parallel schemas, or migration shims after the one-way migration is accepted.

## Related Context

- [Core Architecture](../core/architecture.md)
- [Core Concepts](../core/core-concepts.md)
- [Work Model](../core/work-model.md)
- [Storage Model](../core/storage.md)
- [Identity Model](../core/identity.md)
- [Permissions Model](../core/permissions.md)
- [Audit Model](../core/audit.md)
- [Contract Evolution Model](../core/contract-evolution.md)
- [Product Vision](../product-vision.md)
- [Design Roadmap](../roadmap.md)
- [App API Boundary](../app-api.md)
- [Contract Stability Baseline](../specs/20260715-contract_stability_baseline.md)
- [Single-Deployment Multi-User Workspace System](../specs/20260715-multi_user_workspace_system.md)
- [NanoCore Config And Identity Contract](../specs/20260628-nanocore_config_identity_contract.md)
- [Agent Environment Package](../specs/20260616-agent_environment_package.md)
- [OpenKit Policy Model](../specs/20260629-openkit_policy_model.md)
- [Policy Enforcement Mapping](../specs/20260703-policy_enforcement_mapping.md)
- [Storage Layout And Record Ownership](../specs/20260703-storage_layout_record_ownership.md)
- [Schema Evolution And Record Envelope](../specs/20260703-schema_evolution_record_envelope.md)
- [Audit, Usage, And Evidence Records](../specs/20260703-audit_usage_evidence_records.md)
- [Workspace Synchronization](../specs/20260703-workspace_synchronization.md)
- [Workspace Backup, Export, Import, And Data-Root Migration](../specs/20260704-workspace_backup_export_import.md)
- [Remote Auth Credential Bootstrap](../specs/20260704-remote_auth_credential_bootstrap.md)
- [Vault Backend Implementation](../specs/20260704-vault_backend_implementation.md)
- [Quick Chat Workspace](../specs/20260709-quick_chat_workspace.md)
- [App API OpenAPI Projection](../specs/20260704-app_api_openapi_projection.md)
- [OpenKit Agent Skill Interface](../specs/20260713-openkit_agent_skill_interface.md)
- [OpenKit Test Strategy](../specs/20260529-test_strategy.md)
- [Core And Spec Alignment Audit](./202607111941330001-core_spec_implementation_alignment_audit.md)
- [OpenKit Agent Skill Interface Change Plan](./202607131935040001-openkit_agent_skill_interface.md)

## Verified Entry Baseline (2026-07-15)

This section preserves the implementation snapshot used to enter the plan. Current implementation facts and final evidence are recorded in the owning specifications and the checkpoints below.

- Better Auth email/password users and server-mode sessions exist.
- Opaque `okt_` bearer tokens, workspace bindings, read-only scope gating, first-boot bootstrap, and token administration exist.
- The Core database has a global Workspace registry, one recorded owner, active/removed membership rows, and owner-membership creation.
- Current server-mode route middleware checks active membership for Better Auth and Workspace-token actors but exempts `server-admin` and resolves Workspace scope through route and request heuristics.
- Canonical Workspace storage, Workspace databases, `FsStore`, recovery scanning, scheduler admission, and several runtime paths still depend on `users/<userId>/workspaces/<workspaceId>`.
- The owner foreign key currently cascades deletion.
- No editor/viewer access, invitation lifecycle, transfer, leave, or owner-safe user deletion contract is implemented.
- The policy kernel already provides NGAC-aligned elements, assignments, associations, operations, and fail-closed evaluation, but complete product-role and operation mapping is absent.
- The general audit schema and several protocol records lack complete human actor and responsible-user attribution.
- Request idempotency, immutable history sequencing, and Workspace apply conflict checks exist; general mutable record revisions and durable first-writer approval claims do not.
- Portable Workspace export/import and data-root backup foundations exist, but the multi-user access-exclusion and target-owner behavior is not yet verified.
- OpenKit-owned AEP scope still contains an unused organization placeholder, and current `userId` usage conflates accountability with physical store ownership.
- Generated OpenAPI and Core Client projections exist; the accepted bundled CLI and unified Skill remain governed by their separate active change plan.

## Impacted Surfaces

| Surface | Planned responsibility |
| --- | --- |
| `packages/protocol` | Durable `ActorRef`, responsible-user and decision attribution, strict schemas, generated schemas, fixtures, and migration identity. |
| `packages/app-api-schemas` | Release-coupled member, invitation, role, transfer, leave, recovery, revision, conflict, and authorized Workspace read models. |
| `packages/policy-kernel` and NanoCore policy mapping | Reuse the existing kernel and add fixed product-role and operation mappings without new policy semantics. |
| `packages/config-schema` | Replace AEP `userId`/`automationId`/`organizationId` scope ambiguity with the accepted trigger actor contract. |
| NanoCore Core DB | Restrictive foreign keys, registry revision, access levels, invitation records, lifecycle transitions, indexes, and transaction helpers. |
| NanoCore storage | Top-level Workspace roots, owner-independent openers, recovery, index rebuild, migration, cleanup, backup, export, and import. |
| NanoCore auth and public routes | Central access resolver, operation metadata, membership/token/policy intersection, sharing operations, safe errors, and administrator separation. |
| Scheduler, AEP, worker control, Gateway | AEP-owned runtime actor lineage, responsible-user derivation, current-authority rechecks, and storage-owner removal without duplicating ActorRef. |
| Audit, usage, permission, approval, Action Center | Actor attribution, eligible principals, lifecycle producers, atomic terminal claims, redaction, and historical lineage. |
| Search, Workspace lists, notifications, Quick Chat | Authorized candidate sets, personal projections, per-user Quick Chat, and non-shareability. |
| Core Client, operation catalog, CLI, Skill | One exact-release projection of every supported sharing operation and typed conflict. |
| Existing Web baseline and rebuilt Web | Minimum same-release compile/runtime alignment for changed shared schemas only; the role-aware multi-user projection remains deferred to S10. |
| L0-L6 verification | Boundary, schema, policy, migration, process, artifact, and one representative agent-first team story; browser acceptance remains with S10. |

## Execution Principles

- Follow test-first development for every behavior slice: land focused failing tests before production changes.
- Prefer a test commit followed by an implementation commit for each coherent behavior slice.
- Update packages in dependency order and keep commits independently reviewable: protocol and shared schemas, policy/config packages, NanoCore, Core Client and operation catalog, then CLI and Skill; Web remains with S10.
- Do not use the Web or Skill as the source of business rules; complete the kernel and public contract first.
- Keep one central Workspace resolver and one policy decision path. Do not scatter role predicates across handlers.
- Add only fields, records, routes, and helpers required by the accepted V1 behavior.
- Prove each invariant once at the lowest sufficient layer; add a higher-layer check only for a distinct integration risk and reuse existing runners.
- Update generated schemas and OpenAPI only from their owning source packages.
- Preserve unrelated worktree changes and coordinate with the active Agent Skill Interface and broad alignment-audit plans at their named ownership boundaries.

## Execution Plan

### Stage 0 — Documentation Authority

- Replace the old root freeze report with the accepted stability-baseline spec.
- Update the Core contract-evolution model and affected Core ownership, identity, permission, audit, storage, and work guidance.
- Accept the single-deployment multi-user Workspace spec based on current code/storage verification and primary-source research.
- Align active storage, auth, policy, AEP, schema evolution, audit/usage, export/import, vault, Quick Chat, OpenAPI, App API, roadmap, and spec-index guidance.
- Create this change plan without changing behavior.

Exit condition: active documentation has one stability vocabulary, one shared-Workspace target, no organization placeholder in the target schema, no filesystem-sharing proposal, and no claim that App API compatibility or multi-tenancy is required.

### Stage 1 — Freeze Boundary Guards And Migration Fixtures

- Add L0 coverage that enumerates every Workspace-scoped public operation and requires canonical scope resolution and a policy operation.
- Add one table-driven migration preflight fixture covering the normal path, duplicate ID, contradictory or missing owner/member facts, unsafe links or paths, authoritative database corruption, and mixed layout.
- Add the minimum Core DB constraint fixture needed to prove the current cascade and owner-membership shape fail the target.
- Stage protocol, App API, lifecycle, and multi-user process tests immediately before their owning implementation slices rather than creating one global fixture platform.

Exit condition: the intended target fails for explicit reasons while unchanged unrelated package tests remain green.

### Stage 2 — Land Durable Shared Schemas

- Add `ActorRef`, canonicalize the existing durable imported-Artifact actor field, and update `@openkit/protocol` generated schemas, conformance fixtures, and exact protocol identity.
- Add release-coupled sharing and conflict schemas to `@openkit/app-api-schemas`.
- Classify every changed field as durable or release-coupled and advance the exact contract identity where required.
- Update all current producers and consumers in the same package slice; do not add permissive compatibility unions.

Exit condition: the changed shared packages strictly express the accepted target, generated artifacts match, and no changed public schema introduces an organization placeholder, actor alias, or user-owned Workspace path.

### Stage 3 — Migrate Core Identity And Workspace Storage

- Add Core DB migrations for restrictive owner/member references, registry revision, membership access and revision, invitations, uniqueness, and lifecycle indexes.
- Implement transaction helpers that preserve one owner and active owner membership.
- Add a thin offline storage migration invoked only by one dedicated stopped-process operator CLI; the CLI is not boot, restore, a reusable runner, or a test harness, and the migration reuses existing preflight, staging, digest, layout-marker, normal boot-integrity, index-rebuild, report, and source-retention owners without a journal or special boot mode.
- Retain the complete predecessor `DATA_ROOT`, including Core DB, layout marker, and owner-nested trees, in one verified cold backup outside `DATA_ROOT`; stage the complete future `workspaces/` tree and publish that root through one same-filesystem rename so an accepted v2 `DATA_ROOT` contains no owner-nested Workspace tree.
- Reuse the ordinary integrity and index-rebuild functions directly from the stopped-process CLI without running the boot phase runner, binding a listener, or creating a verification-boot mode; the later ordinary boot only validates the accepted v2 layout.
- Change AEP scope from physical-owner and organization fields to one required `triggerActor`, advance its exact schema identity, and update persisted snapshots only after Workspace resolution no longer depends on a responsible user.
- Add one representative partial-publication regression to this thin migration path without creating a crash matrix or fault-injection platform.
- Refactor Workspace database and file openers, recovery, layout reporting, derived-index rebuild, export/import staging, and store construction to use `workspaces/<workspaceId>` without a user parameter.
- Remove old-path readers only after the migration fixture passes; do not add fallback lookup.

Exit condition: a migrated fixture boots only on the top-level layout, owner transfer changes no path, every Workspace has one canonical root, the reviewed external cold backup keeps the predecessor recoverable, and failure leaves no mixed-layout product boot.

### Stage 4 — Centralize Workspace Authorization

- Define one server authorization metadata registry for server, user, and Workspace scope, resource resolution, mutation posture, and policy operation; bind App entries to OpenAPI operation ids and Core/Gateway entries to explicit route keys without reusing the Agent Skill catalog.
- Implement one fail-closed Workspace access resolver shared by Core and App API route families.
- Project owner/editor/viewer into the NGAC-aligned kernel and register the complete operation mapping.
- Intersect Better Auth actor or token owner, active membership, effective role, token binding and scope, responsible user, policy, and approval context.
- Remove route path/body heuristics, handler-local role decisions, user-directory discovery, and implicit `server-admin` content bypass.
- Add uniform non-enumerating access errors, one complete mechanical operation-coverage gate, one table-driven policy matrix, and one representative IDOR test per distinct resource-lineage resolver shape.

Exit condition: every Workspace-addressed operation is mechanically covered, missing facts deny, and no route can perform request-specific Workspace content lookup, mutation, or handler consumption before authorization; ordinary process boot may retain the shared eager `FsStore`.

### Stage 5 — Implement Sharing And User Lifecycle

- Implement invitation create, list, accept, decline, revoke, expiry, and re-invitation transitions for existing active users.
- Add the user-scoped authenticated invitee collection so an invitee can discover only their own invitation IDs without membership, a user filter, email delivery, or a bearer invitation secret.
- Implement member list, access change, removal, leave, ownership transfer, Quick Chat rejection, and explicit administrator recovery.
- Add direct SQL compare-and-swap only to ownership-transfer or administrator-recovery registry writes, membership writes, and invitation writes, and make invitation response/revoke, membership change/remove/leave, ownership transfer, and administrator recovery durable conditional first-writer transitions.
- Extend the existing general `AuditEvent` with the minimum lifecycle `ActorRef` and subject projection, then write the Core authority mutation, Core-owned lifecycle audit event, and existing command receipt in one `core.sqlite` transaction; do not dual-write Workspace audit or require cross-database atomicity.
- Revoke credentials and active product access through the one-way canonical `active -> disabled` user transition while preserving history, ownership, membership, invitation, and actor lineage for resolution. Keep re-enable and hard deletion unavailable in V1.
- Reuse one central lifecycle idempotency template: receipt projects current owner state, changed input conflicts, and a request-owned effect without its receipt returns `recovery_required` without reconstruction, synthesis, settlement, or repair.

Exit condition: one L1 policy/lifecycle table, one test per direct conditional-write primitive, one shared receipt test template, and one representative L3 restart path prove durable sharing lifecycle, credential revocation, and fail-closed rejection at the next request without a Cartesian matrix. Stage 7 owns reauthorization immediately before runtime and background governed effects.

### Stage 6 — Add Shared Attribution And Concurrency

- Add exact `triggerActor` only to the durable Turn, exact `actor` only to user-message, approval-decision, and user-input-response Items, and exact `responsibleUserId` only to user-input-request Items; do not add actor to every Item or sweep unrelated producers.
- Add the Workspace audit actor/subject/revision columns already present in the protocol and Core audit, then use the linked Workspace AuditEvent as the sole actor/request projection for the named Approval winner.
- Make only policy-originated Approval decisions durable conditional transitions through the existing terminal PermissionDecision owner and same-transaction linked AuditEvent before any product projection. Require an exact match to the originating `require_approval` tuple and bidirectional decision/audit linkage; keep a non-policy path disabled or fail closed until an owning specification names its durable claim, and do not add an Approval or delivery ledger.
- Preserve existing Artifact Review, Goal Review, Material, and Workspace Sync owner-local contracts without refactoring them.
- Finish only deterministic Approval, decision Item, Turn, command-receipt, and already-idempotent notification projections after the winner transaction. An unprovable delivery returns `recovery_required` without redelivery or boot scanning; Stage 6 performs no governed runtime or external effect and preserves the existing append-only and Workspace apply models.
- Add one distinct-request concurrency regression for the remaining Approval transition shape; do not create a generic concurrency framework or cross-family harness.

Exit condition: the four named attribution families persist across reload, two contrary policy Approval requests produce one terminal PermissionDecision and one winning actor/request before at-most-once product delivery, and no Stage 7/8 family or generic decision owner enters the slice.

### Stage 7 — Rebind Runtime And Background Work

- Implement the exact stateless S63 current-authority predicate from current Core user, membership, fixed-role, policy, and existing effect-owner facts; a null responsible user or any missing, stale, disabled, removed, or denied fact fails closed without a new decision record or cache.
- Keep `AEP.scope.triggerActor` as the sole runtime actor authority. Scheduler, lease, worker-control, CapabilityCall, AuditEvent, and RuntimeEvidence reuse existing Turn, Agent Session, request, and package-snapshot links rather than adding ActorRef; only the exact [S59 UsageRecord](../specs/20260703-audit_usage_evidence_records.md) responsible-user projection and transient Gateway enforcement context enter this slice.
- Apply the S63 boundary table at admission and immediately before implemented NanoCore-mediated capability, LLM, network, Vault, Artifact/Workspace publication, Workspace Sync apply, and Git-push effects. A fresh authenticated apply or push command uses its own current actor and existing target-matching authority; the worker origin remains non-authorizing lineage.
- On denial, invoke no governed effect and use only the existing access-denied, `interrupted`, failed VaultUse/Audit, non-authorizing Workspace Sync evidence, or `refused-policy` owner outcome applicable to that boundary. Add no state, quarantine, redelivery, settlement, recovery workflow, or replacement execution.
- Preserve the explicit worker-native compromise: an external request already invoked may finish and an immutable-AEP sandbox may act until the next NanoCore or worker-control check detects lost authority. From that detection forward, use existing interrupt and whole-Cell cleanup, accept only non-authorizing evidence, and publish no stale-authority output; do not claim dynamic revocation or retroactive cancellation.
- Do not implement automation in Stage 7. The current facade has no executor and cannot prove this slice; the [S35 recurring-trigger specification](../specs/20260711-scheduler_recurring_event_triggers.md) exclusively owns Workspace automation, durable schedules/fires, responsibility reassignment, and its eventual current-authority check.
- Verify one L1 table for the exact predicate and boundary mapping plus one representative stale-authority runtime path proving no post-detection NanoCore-mediated effect or publication. Reuse existing test infrastructure and do not add a restart matrix, runner, harness, automation scheduler, state, or compatibility path.

Exit condition: every implemented NanoCore-mediated runtime or background effect uses the exact current-authority predicate, no post-detection governed effect or Workspace publication uses stale user authority, no Workspace root is inferred from user identity, and the bounded in-flight worker-native race remains truthful rather than hidden behind new machinery.

### Stage 8 — Align Search, Attention, Vault, And Portability

- Correct only existing Workspace list and search candidates to use current authorization before reading result content.
- Add eligible-principal filtering to Action Center, approvals, user-input requests, and reviews.
- Keep existing personal notification projections in user scope; do not add a notification subsystem for this package.
- Require the Workspace owner through `vault.admin` for the existing Workspace Vault reference list/rebind and non-secret grant, injection-plan, and injection-receipt lists; keep redacted VaultUse history under `audit.read`; add no Workspace grant issue/revoke operation. An editor may trigger use only under current `vault.use` policy plus the exact active target-issued grant, while a viewer has no Vault authority. Deployment-level Vault administration remains separate and grants no Workspace content access.
- Update export/import to exclude deployment-local memberships, invitations, token authority, and personal access state; preserve actor and reminted Vault/effect rows only as non-authorizing history; and create the importing user as sole owner/member.
- Verify full data-root backup and restore preserve same-deployment users and relationships.

Exit condition: removed users disappear from lists, search, attention, and Vault access on the next request; portable import grants no source-deployment authority.

### Stage 9 — Project The Exact-Release Agent Interface

- Add all fifteen sharing operations to the Core Client from the same schemas and operation owners.
- Project the owner-side invitation, membership, role, transfer, conflict, and recovery operations reachable through the existing bearer-token credential contract into the transport-neutral operation catalog, bundled CLI, and unified Skill owned by the Agent Skill Interface plan.
- Keep the session-capable own-invitation list, accept, decline, and exact own-receipt leave operations as an explicit CLI/Skill known-partial; do not add Better Auth bearer support, session-cookie persistence, or another user-token system in WP-5.
- Keep invitation secrets absent and accept sensitive lookup input only through the established secret-safe CLI input posture.
- Replace any removal-only MCP parity tests for this feature with CLI/Skill contract and story coverage; do not add new MCP capabilities.
- Verify every generated artifact carries the same exact contract identity.

Exit condition: an agent using only the unified Skill can complete the sharing lifecycle reachable through the existing bearer-token contract without loading private routes or implementing policy in prompts, and the four session-capable operations remain explicitly documented rather than silently claimed complete.

### Stage 10 — Rebuilt Web Projection — deferred to S10

- Project authorized Workspace switching, membership lifecycle, actor labels, typed conflicts, and role-aware controls through the rebuilt Web after the execution program and G09.
- Do not add a temporary Solid implementation or keep WP-5 open on browser-dependent acceptance.

Exit condition: owned by S10; WP-5 exits on the settled kernel, public contract, CLI, and Skill without claiming Web completion.

### Stage 11 — Release Verification And Documentation Closure

- Run focused affected-package gates, one representative migration and authorization process path, exact-release artifact checks, the existing real-Agent Skill reachability story, and the deterministic authority regressions named by S63; do not combine them into another story or duplicate each invariant across L0-L6.
- Run the one-way migration against representative internal fixtures and retain a reviewed migration report.
- Remove obsolete organization fields, user-owned Workspace paths, authorization heuristics, current-implementation bypass notes, and old status claims from active docs only after implementation evidence exists.
- Update local READMEs, cookbooks, App API maps, generated artifacts, deployment guidance, specs, and this record.
- Close this record with commits, verification evidence, migration evidence, remaining hardening gaps, and links to the completed Agent Skill projection plus deferred S10 Web owner.

Exit condition: the durable kernel and implemented release-coupled gates named by the stability baseline pass, no compatibility layer remains, deterministic migration/transfer/removal/export/import checks pass, and the composed release acceptance bundle proves real-Agent Skill reachability, two-user next-request denial, exact actor lineage, zero post-detection publication, and zero post-denial governed effect. Each predicate remains owned by its lowest sufficient evidence layer rather than a combined story.

## Verification Plan

### Documentation checkpoint

- `git diff --check`
- `CI=true pnpm run check:repo`
- Spec lifecycle and relative-link validation through the repository check.
- Search proving the old root freeze path has no inbound reference.
- Search proving active target schemas reserve no tenant or organization field.
- Search distinguishing factual current user-nested paths from accepted top-level target paths.

### L0-L2 contract checkpoint

- Protocol, App API, config schema, policy mapping, generated schema, OpenAPI drift, and operation-coverage tests.
- One table-driven storage migration preflight fixture and focused schema constraint tests.
- Actor redaction, safe error, private-field boundary, export exclusion, and exact contract identity tests.

### L3-L5 implementation checkpoint

- One representative NanoCore lifecycle covers owner, editor, viewer, removal on the next request, and `server-admin` separation without repeating the L1 matrix.
- One representative process test covers a stale conditional write and contrary terminal decision.
- Migration, backup, restore, export, import, and packaged-server smoke using representative Workspace history.
- CLI/Skill operation coverage, redaction, and exact-release artifact checks.
- Browser lifecycle and conflict handling remain with the deferred S10 rebuilt-Web projection.

### Composed release acceptance checkpoint

- The existing progressive-discovery L6 story proves only real-Agent reachability through Skill search, describe, call, and durable readback; no new or materially revised L6 story enters WP-5.
- Exact-release catalog and artifact checks prove the bearer-reachable sharing projection, the Core-backed two-user L3 path proves invitation, acceptance, restart, removal, and typed next-request denial, and deterministic authority/runtime checks prove actor lineage plus zero post-detection governed effect or Workspace publication. Every deterministic gate MUST execute and pass on the closing HEAD; the already accepted progressive-discovery evidence remains only the real-Agent reachability proof, and no evidence class may substitute for another.
- An already-submitted worker-native request remains the documented bounded compromise. Ownership transfer, migration, export, import, and importer-only authority stay in deterministic L1-L5 coverage.

## Migration Safety And Stop Rules

- Stop before publication if any Workspace ID maps to zero or multiple source trees, any source owner conflicts with the registry, any owner membership is absent, any link or unsafe path appears, or any authoritative database fails integrity verification.
- Never advance the layout marker until all staged Workspace trees, databases, Core constraints, and registry mappings verify.
- If failure occurs before the one root rename, keep NanoCore closed to product work, preserve the original source and verified external cold backup, remove only migration-owned staging, and record the failed stage as evidence.
- If publication or the Core transaction fails after the one root rename, leave the predecessor marker unadvanced when applicable, preserve the published target and verified external cold backup, and require explicit repair or restore; do not compensate through a fallback reader or infer recovery from the report.
- If normal post-publication boot integrity or derived-index verification fails, do not enable a dual reader. Repair the target or restore the verified external cold backup and retry the migration from a clean preflight.
- Never accept a v2 layout marker while an owner-nested Workspace tree remains inside `DATA_ROOT`; do not delete the external cold backup until representative L3 and L5 checks pass on the published layout and the evidence-only migration report has been reviewed.
- If the central resolver cannot cover every public Workspace operation, do not expose partial sharing; fail the coverage gate and finish the resolver inventory first.
- If a background path cannot re-evaluate current authority before an effect, disable that effect path for shared Workspaces until the check exists.
- If a named transition cannot make its durable first-writer claim before runtime delivery, keep that transition disabled rather than relying on process-local checks.

## Expected Handoff Points

- Stage 0 is the documentation-only checkpoint and the handoff into implementation authorization.
- Stage 1 must complete before any production schema, migration, or behavior change.
- Stage 2 lands shared contracts before NanoCore implementation and must be reviewed for durable versus release-coupled classification.
- Stage 3 requires a dedicated migration review before old-path cleanup is enabled.
- Stage 4 must finish before any sharing route is considered usable.
- Stage 5 closes the complete sharing and user lifecycle, including its lifecycle CAS, first-writer, ActorRef audit, and Core receipt boundary. Stage 6 then closes only the remaining shared attribution and Approval concurrency before runtime and product projections expand.
- Stage 9 coordinates with `202607131935040001-openkit_agent_skill_interface.md` and must reuse its CLI and operation-catalog owners.
- Stage 10 is handed to post-program S10 after G09 and is not a WP-5 exit gate.
- Stage 11 closes WP-5 only after the kernel, CLI/Skill projection, migration, and composed release acceptance bundle pass; S10 retains the Web follow-up.

## Known Risks

- Authorization coverage may drift across the large route surface. Mitigation: one resolver, operation metadata, closed exclusions, a mechanical L0 gate, and one IDOR test per resolver shape.
- The storage migration can create split authority between Core rows and files. Mitigation: offline execution, exact staging, marker-last publication, source retention, no mixed-layout boot, and a reviewed migration report.
- Owner and membership state may drift. Mitigation: one owner field, active owner membership invariant, restrictive deletion, revisions, and transactional transfer.
- Actor fields may spread into every schema and create duplicated identity. Mitigation: use `ActorRef` only on the accepted attribution families and keep display and credential data in redacted projections.
- General optimistic concurrency may become framework overhead. Mitigation: use direct SQL revisions only on ownership-transfer or administrator-recovery registry writes, membership writes, and invitation writes while keeping every other owner-local contract unchanged.
- Removed users may retain authority through tokens, workers, or Vault grants. Mitigation: one current-authority predicate at request and implemented NanoCore effect boundaries, explicit interruption and whole-Cell cleanup at the next detection point, rejection of stale publication, and one representative path; the [S35 recurring-trigger specification](../specs/20260711-scheduler_recurring_event_triggers.md) owns future automation execution and reassignment.
- Invitation lookup may enumerate users. Mitigation: owner-only exact-email input, no directory endpoint, one safe unavailable result for every ineligible target, and no durable email authority; V1 adds no invitation rate-limit subsystem.
- Deployment administration may remain a hidden content bypass in less-visible routes. Mitigation: explicit server-versus-Workspace operation classes and representative denial fixtures over each resolver shape.
- The feature may drift from the unified Skill. Mitigation: finish the public NanoCore and Core Client contract first, then reuse the implemented operation catalog and CLI without adding MCP or another client.
- Existing broad alignment work may edit the same specs. Mitigation: this record owns the focused multi-user target; coordinate checkpoints and preserve unrelated concurrent edits.

## Checkpoints

### 2026-07-19 — Stage 4 design authority closed before implementation

- Froze the V1 product-operation to NGAC access-right registry in the policy enforcement specification and made the multi-user specification the unique exact fixed-role-to-right authority rather than a second grant engine.
- Defined the seven exact Workspace resolution shapes, including actor-derived Quick Chat, candidate-first Workspace collections, route-owned body input, optional Gateway metadata attribution, opaque-child lineage, and path-first child validation; unattributed public Gateway calls retain their accepted user-scope behavior.
- Classified invitation response and portable import as user-scoped, with exact invitee validation for the former and an additional source-Workspace read check only for same-deployment exports for the latter; kept bootstrap consumption under its route-owned secret check and prohibited `server-admin` credentials from ordinary Workspace content access.
- Kept Approval and UserInput eligible-principal checks with their durable lifecycle owners, while the central resolver owns role and policy eligibility. Ordinary resolver decisions remain transient fail-closed allow or deny checks and do not create `defer`, another PermissionDecision, access ledger, or approval workflow.
- Implementation may now proceed through tests first. It must reuse the existing membership records, OpenAPI catalog, resource owners, and policy kernel; it may not add a cache, durable lineage index, authorization framework, or per-route role table.

### 2026-07-19 — Stage 4 centralized Workspace authorization exited

- Replaced authentication-middleware path and body heuristics with one exact operation-access registry and a central pre-handler resolver that intersects the authenticated actor, token scope and Workspace binding, active membership, fixed role, mutation posture, and the existing policy kernel.
- Kept collections candidate-first, derived Quick Chat only from the authenticated user, retained optional Gateway attribution only at `metadata.openkit.workspaceId`, denied `server-admin` credentials on ordinary Workspace content, and moved same-deployment import membership checks before collision or content reads.
- Required every `workspace-child-lineage` handler family to consult its existing Thread, Turn, Artifact, Knowledge, Material, review, scheduler, runtime, repository, or Vault owner. Globally resolvable absence retains normal not-found; scoped missing and mismatch use the documented uniform access denial without a lineage index or cross-Workspace scan.
- Kept UserInput responsible-user enforcement on the existing scheduler/checkpoint human command owner and denied a different Workspace editor before command execution. A legacy input path with no durable responsible-user authority was not given an invented owner.
- The exact metadata coverage gate, role matrix, resolver tests, representative IDOR table, affected route suites, NanoCore typecheck, generated OpenAPI drift check, Biome, and diff check pass. The implementation added no authorization cache, durable access ledger, recovery workflow, second policy engine, runner, or harness; Stage 5 sharing lifecycle is now the active boundary.

### 2026-07-19 — Stage 5 lifecycle contract rehydrated before implementation

- Moved only the lifecycle CAS, first-writer, Core audit, and Core command-receipt prerequisites needed by sharing from Stage 6 into Stage 5; Stage 6 retains the remaining shared attribution and Approval transition.
- Closed the release projection at fifteen named operations, added the user-scoped own-invitation collection, positive membership revision for `leave`, and one content-free administrator recovery state; no user directory, invitation secret, or generic administrator mutation entered scope.
- Restricted the new Core transaction boundary to invitation, membership, ownership transfer, administrator recovery, and user disable. Existing Workspace create, import, metadata, archive, and delete owners remain unchanged.
- Defined already-disabled as a receipt-only successful no-op, exact request-owned missing receipt as `recovery_required`, and terminal/expired-before-stale invitation conflict precedence so independent implementations cannot diverge.
- Defined the sole post-revocation authorization exception: an exact `leave` receipt may replay only the same user's removed membership tombstone without opening Workspace content; every different request still requires current `workspace.leave` authority.
- Accepted one presentation-layer compromise: all fifteen operations remain App API and Core Client contracts, while the current bearer-token-only CLI and Skill omit own-invitation list, accept, decline, and exact own-receipt leave rather than gaining a second user credential system in WP-5.
- Implementation then proceeded through the existing Core ledger, direct conditional SQL, one canonical active-user predicate, and the existing policy kernel; no second middleware, CAS framework, recovery workflow, runner, or harness was authorized.

### 2026-07-19 — Stage 5 sharing and user lifecycle exited

- Added Core receipt ownership, lifecycle audit attribution, one-way user disable fields, and stock Better Auth active-user enforcement without a provider patch, second token system, re-enable path, or hard-delete path.
- Implemented the direct invitation, membership, leave, transfer, recovery, and disable domain transitions with exact no-op, terminal-before-stale, inactive-Workspace, disabled-user, recovery/invitation interleaving, and Quick Chat rejection semantics.
- Registered the exact fifteen App API operations, their central access metadata, three OpenAPI security postures, typed public projections and conflicts, and one Core mutation-audit-receipt transaction per accepted state change.
- Kept only one bounded post-authority receipt exception for session/local leave, let current authorization supersede historical transfer replay, and retained the four session-capable operations as an explicit CLI/Skill known-partial instead of adding another credential system.
- Reused the existing server-mode process harness for one invite/accept/restart/remove/next-request-denial proof. Focused sharing, route, auth, OpenAPI, schema, migration, ledger, audit, and type checks pass; the final deletion review found no second workflow, recovery owner, service layer, runner, harness, OpenShell patch, or further safe deletion.

### 2026-07-19 — Stage 6 attribution contract narrowed before implementation

- Froze Stage 6 to four named durable families: Turn `triggerActor`, actor on three human-authored Item variants, user-input `responsibleUserId`, and the policy-originated Approval terminal PermissionDecision plus linked actor audit.
- Closed the remaining Stage 6 attribution ambiguities without adding a compatibility path: responsible-user derivation is immutable and exact, human decisions require a user actor, copied user messages retain their source actor, invalid required attribution rejects the complete Workspace load, and a null responsible user creates no input gate.
- Chose the bounded portable-history rule instead of a new gate state: portable export preflight rejects unresolved user-input gates, while completed history keeps non-authorizing source attribution.
- Left governed-effect authority with Stage 7, automation execution and reassignment with the [S35 recurring-trigger specification](../specs/20260711-scheduler_recurring_event_triggers.md), eligible-principal projections with Stage 8, and existing Artifact Review, Goal Review, Material, and Workspace Sync owners unchanged.
- Required one terminal PermissionDecision per policy Approval before projection or delivery, same-request idempotent completion, distinct-request `stale`, and fail-closed behavior for any Approval path lacking a named durable claim owner; no Approval ledger, concurrency framework, or delivery workflow is authorized.

### 2026-07-19 — Stage 6 shared attribution and Approval concurrency exited

- Added required immutable `Turn.triggerActor`, actor only on the three named human-authored Item families, exact user-input responsibility, and winning-command causation without a default actor, compatibility reader, generic attribution sweep, or second identity owner. Chat, Goal, Task, Artifact introduction, worker, simulator, reload, export, and import paths now preserve those fields exactly.
- Made only policy-originated Approval responses conditional on one terminal Workspace PermissionDecision plus one bidirectionally linked AuditEvent with exact Workspace, Thread, Turn, actor, request, action, resource, subject, and outcome lineage. Same-request replay finishes only deterministic projections, changed input conflicts, a different request is `stale`, and non-policy Approval remains `501` fail closed; no external effect, delivery retry, generic executor, Approval ledger, or recovery workflow entered the slice.
- Reused one immutable-attribution check across Store writes and both canonical revision-history readers, rejected foreign or ambiguous user-input responses, and made portable writer, V2 verifier, and importer independently reject unresolved requests before export-root creation or target publication. User-input response causation remains the source command request id across portable import rather than being reminted as Item lineage.
- Closed the four stale test fixtures exposed by owner-independent storage and centralized Workspace authorization without changing production behavior or adding a helper platform. The deletion review removed the duplicate Store attribution check and found no new state machine, durable owner, middleware, runner, harness, compatibility path, OpenShell patch, or Stage 7/8 behavior.
- Final focused evidence is Protocol 162/162 and NanoCore 409/409 across the affected Approval, policy, audit, migration, Store, portability, Chat, Goal, Task, Artifact, worker, and simulator owners. NanoCore and Protocol typechecks, Protocol generation/build, Biome over 536 affected source and schema files, all documentation validators, and `git diff --check` pass; the independent final review reports no remaining P0-P2 Stage 6 finding.

### 2026-07-19 — Stage 7 current-authority contract closed before implementation

- Defined one stateless current-authority predicate over the immutable authority actor, active canonical user, active Workspace membership, current fixed-role right, current policy, and the concrete effect owner's existing target tuple; null or missing authority fails closed and adds no cache, ledger, state, or workflow.
- Closed the effect table for admission, NanoCore-mediated capability and external calls, worker publication, Workspace Sync apply, Vault use, and Git push. Fresh apply and push commands use their own current authenticated actors, while stale worker origin remains immutable non-authorizing lineage and evidence.
- Recorded the bounded runtime compromise: an already-submitted worker-native request may finish until the next governed boundary detects lost authority, after which existing interrupt and whole-Cell cleanup permit no new NanoCore-mediated effect or publication. Dynamic revocation, mutable AEP, quarantine, settlement, and recovery machinery remain absent.
- Kept AEP `triggerActor` as the sole runtime actor authority, limited new attribution to the exact UsageRecord responsible-user projection and transient Gateway context, deferred all executable automation and reassignment work to the [S35 recurring-trigger specification](../specs/20260711-scheduler_recurring_event_triggers.md), and limited acceptance to one predicate table plus one representative stale-authority path on existing infrastructure.

### 2026-07-19 — Stage 7 governed-effect reauthorization exited

- Added one stateless `currentWorkspaceAuthority` composition over the immutable authority actor, current canonical user and membership, fixed role, current policy, and a caller-validated existing effect tuple. Scheduler admission and dispatch, product Turn start, worker materialization and launch, public and worker Gateway calls, AEP Vault injection, worker publication, fresh Workspace Sync apply handoff, and Git push now fail closed at their documented NanoCore boundary.
- Kept `AEP.scope.triggerActor` as the sole runtime actor, added only the required Workspace UsageRecord responsible-user projection and transient Gateway actor context, and reused existing Turn, Agent Session, CapabilityCall, AuditEvent, VaultGrant, Review, Git decision, lease, and worker-control owners. No durable decision cache, revocation protocol, quarantine, settlement, recovery workflow, automation executor, runner, harness, compatibility path, or OpenShell patch entered the slice.
- Corrected two design-owner ambiguities found during final review: S49 now defines the existing serialized apply-owner handoff as the bounded effect boundary, and S57/S51 agree that redacted Vault and injection history remains portable but permanently non-authorizing under imported identities. A target-issued VaultGrant remains the use-time effect owner; optional Approval and policy-decision identifiers are issuance lineage rather than a reconstructed use-time workflow.
- Focused evidence includes 127 passing authorization, usage, governed-worker, and Workspace-apply tests; the complete governed-worker executor file passes 86 tests; existing Git executor and route-focused checks pass; and three independent stale-authority regressions prove zero materialization, Vault injection, or Git credential effect after denial. NanoCore typecheck, targeted Biome, documentation validators, and `git diff --check` pass. The independent final review reports no remaining P0-P2 Stage 7 finding.

### 2026-07-19 — Stage 8 authorized projections and portability exited

- Reused candidate-first Workspace collections and existing search, Action Center, dashboard, review, Vault, portable-file, export/import, and full-backup owners; no new notification, assignment, grant, or portability mechanism entered the slice.
- Request-time eligibility now exposes only current policy Approval actors, exact responsible users, and currently authorized Artifact, Goal, Knowledge, and Workspace Synchronization reviewers while retaining shared status and inspection rows under their existing owners. Final review also aligned `composer.disabled` with `turn.run` and required active exact Approval sources plus completed exact Gates.
- Workspace Vault metadata and rebind stay owner-only under `vault.admin`, redacted use history stays under `audit.read`, and actual use requires current `vault.use` plus the exact active target-issued grant. Portable import treats every source relationship as non-authorizing and creates only the importer as owner/member; full backup preserves the same-deployment relationship graph.
- The eight focused Stage 8 files pass 88 tests, NanoCore typecheck and Biome pass, documentation and whitespace gates pass, and independent final review reports no remaining P0-P2 finding.

### 2026-07-19 — Stage 9 exact-release Agent interface exited

- Added all fifteen sharing operations directly to the existing Core Client with the App API schemas, request-id propagation, typed conflicts, and the existing API error owner; no client hierarchy or compatibility layer was added.
- Projected the eleven bearer-reachable operations through the existing transport-neutral catalog, bundled CLI, and unified Skill. Own-invitation list, accept, decline, and exact own-receipt leave remain the four explicit session-only known-partials instead of adding persisted session cookies or another credential system.
- Added the two already-implemented version-keyed Artifact Review operations to their existing catalog owner as a separate exact-release coverage correction; they are not counted as sharing operations or new Stage 9 scope.
- Core Client passes 30 tests, the full Skill interface passes 11 tests, all 169 catalog operations are unique with 11 explicit exclusions, generated artifacts are byte-aligned after rebuild, and independent final review reports no remaining P0-P2 finding.

### 2026-07-19 — Stage 11 release verification and WP-5 exit

- The deletion-first pass removed 74 obsolete owner-parameter Workspace database calls, three ignored per-user `FsStore` options plus one duplicate test helper occurrence, and current owner-nested fixture, Docker, smoke, and documentation paths. Only explicit predecessor-layout rejection, migration, and no-fallback evidence retains the old path.
- Final review found and closed one real server-user Quick Chat defect without a new subsystem: active Better Auth sessions now invoke the existing Workspace owner, local composition provisions explicitly, and the generic shared-store constructor creates no authority-free Workspace. The 215 focused server, authorization, store, Quick Chat, sharing, and repository tests pass, and the independent re-review reports no P0-P2 finding.
- Protocol passes 163 tests, App API schemas 77, config schema 130, worker shim 161, Core Client 30, Web 125, and the Skill interface 11. NanoCore executes 2,252 passing tests with three skips; the only failure is the existing real-HTTP disconnect test because this restricted environment denies its `127.0.0.1` listener with `EPERM`, while the other 30 tests in that file pass. NanoCore typecheck, affected-package builds, generated contracts, repository checks, and built NanoCore/Web smoke pass.
- The reviewed migration evidence covers two predecessor Workspaces, a verified external cold-backup manifest, exact predecessor-to-top-level mappings and SHA-256 digests, removed owner-nested sources, and an accepted V2 marker. Focused migration, CLI, and full-backup relationship coverage passes 24 tests.
- The release bundle retains the already-passed Core-backed two-user invite/accept/restart/remove/typed-denial process path, runs every deterministic authority, lineage, zero-effect, zero-publication, migration, and artifact predicate on the closing tree, and reuses the accepted progressive-discovery story only for real-Agent Skill reachability. No new L6 story, runner, harness, compatibility reader, recovery workflow, or OpenShell patch was added; S10 owns the rebuilt multi-user Web.

- 2026-07-15 — Product direction accepted: freeze durable Core and data/authority semantics, keep first-party App API surfaces release-coupled, exclude multi-tenancy, and keep BWM/Meta-Skill outside the kernel baseline.
- 2026-07-15 — Workspace sharing direction accepted: one canonical owner-independent Workspace root, fixed owner/editor/viewer projection, no share links, no filesystem aliases, and no Federation or P2P scope in this work.
- 2026-07-16 — Documentation authority completed: Core and active specs aligned, primary-source multi-user research distilled, and this implementation plan created; no behavior implementation started.
- 2026-07-19 — WP-5 entered after the bounded G06 preamble froze five implementation lines, identified the existing administrator/Vault/effect-authority security gaps, confirmed the storage and portability defects already assigned here, removed one resolved Vault re-export item, and deleted the migration, concurrency, runtime-recovery, Web, and acceptance overreach recorded above.
- 2026-07-19 — Stage 0 exited after two independent contract reviews and one minimality review aligned identity/bootstrap, policy and product decisions, Vault and portability, storage and synchronization, exact CAS and first-writer families, stale runtime evidence, migration fallback, proportional verification, and Web sequencing. No production behavior changed; Stage 1 boundary guards and migration preflight tests are active.
- 2026-07-19 — Stage 1 exited with one existing OpenAPI coverage test that now enumerates every direct and derived Workspace operation plus the Core/Gateway boundaries, one file-local nine-case migration preflight table, two restrictive-FK assertions, and one active-owner-membership assertion. The read-only preflight passes; operation metadata, the two `CASCADE` foreign keys, and removable owner membership remain explicit red targets for Stages 3 and 4. No shared fixture, journal, crash matrix, runner, or runtime behavior was added; Stage 2 shared schemas are active.
- 2026-07-19 — Stage 2 exited with protocol `0.4.0`, one generated-schema-representable `ActorRef` tagged union, strict imported-Artifact attribution with no `actorId` alias, and one closed release-coupled Workspace sharing schema family. The human ActorRef variant derives its responsible user from `id` instead of duplicating an equality invariant that JSON Schema cannot express; non-human variants retain explicit nullable responsibility. Membership role derivation, invitation terminal timestamps, non-pending errors, CAS requests, bounded administrator recovery, and safe conflict summaries are exact closed unions. Protocol, App API schema, Core Client, affected Web, and focused NanoCore Artifact tests pass; no AEP switch, route, client operation, runner, or compatibility path entered this stage. Stage 3 identity and owner-independent storage migration are active.
- 2026-07-19 — Stage 3 migration design ambiguities were resolved in documentation only: one thin stopped-process operator CLI owns invocation, one external verified cold backup retains the complete predecessor data root, the complete staged `workspaces/` root publishes through one rename, a v2 data root contains no old owner-nested Workspace tree, the report remains evidence only, and the single post-rename Core-plus-marker window fails closed. Stage 3 implementation and verification remain active and incomplete.
- 2026-07-19 — Stage 3 exited with one shared process-level `FsStore`, owner-independent `workspaces/<workspaceId>` configuration and database routing, exact V2 `ActorRef` propagation through command receipts, scheduler admission, dispatch, AEP snapshots, restart, Gate closeout, Gateway, and worker control, plus the one stopped-process v1-to-v2 storage migration. The migration rejects live or mixed layouts and pre-existing backup destinations, verifies a complete external predecessor backup, transforms staged AEP V1 records before one-root publication, advances Core and the marker in the documented order, removes old owner-nested trees, rebuilds existing indexes, verifies canonical reads, and writes an evidence-only relative-path report. A deletion review moved regular-file inventory and digest ownership back to the existing backup module, removed duplicate traversal and CLI parsing, retained per-file predecessor-to-successor mappings because S54/S63 make them implementation-significant, and added no journal, recovery workflow, dual reader, runner, or compatibility path. NanoCore typecheck and the integrated Stage 3 storage, scheduler, runtime, Gateway, server, Goal, and Gate suites pass; execution then entered Stage 4 central authorization.

## Implementation Summary

WP-5 and G06 are verified at the accepted non-Web boundary. S63 is implemented through owner-independent V2 storage, the complete bounded sharing/user lifecycle, centralized fail-closed authorization, named attribution and first-writer controls, current-effect authority, authorized projections, Vault and portability boundaries, and the exact-release Core Client plus bearer-reachable CLI/Skill surface. S62 remains Partial because it spans other work packages and S10; the four session-only CLI/Skill operations remain the documented bounded compromise rather than an invitation to add credentials or compatibility.

## Final Verification

All named deterministic WP-5 predicates, affected package typechecks/builds, generated-contract checks, `CI=true pnpm run check:repo`, `git diff --check`, and the built NanoCore/Web smoke pass on the closing tree. The restricted environment cannot bind the one real-HTTP disconnect unit or the process E2E listener, so that infrastructure condition is recorded rather than worked around with another harness; the unchanged Stage 5 process evidence and closing-tree deterministic tests remain the composed L3 and security proof.
