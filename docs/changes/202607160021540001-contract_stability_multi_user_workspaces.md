# Contract Stability And Single-Deployment Multi-User Workspaces

Type: change-plan
Status: planned
Canonical Specs: `docs/specs/20260715-contract_stability_baseline.md`, `docs/specs/20260715-multi_user_workspace_system.md`

## Intent

Establish the pre-release stability boundary for OpenKit and implement the smallest complete multi-user Workspace system for one personal or small-team NanoCore deployment.

The work preserves durable Core meaning, data, authority, audit, and portability while keeping App API, Core Client, bundled CLI, unified Skill, and Web projections free to evolve as one exact release. It replaces the current physically user-owned Workspace model with one canonical owner-independent Workspace root and completes membership, invitation, policy, actor-attribution, concurrency, lifecycle, portability, and product-surface behavior.

This record begins with a documentation-only checkpoint. No protocol schema, database migration, storage move, application behavior, test implementation, generated artifact, or user-facing product surface is changed by that checkpoint.

## Decision Summary

- Use the four Core stability classes: `Durable`, `Release-coupled`, `Experimental`, and `Private`.
- Treat promoted Core semantics, persisted and portable truth, identity, authority, audit, storage ownership, and shared-write correctness as durable contract families once their gates pass.
- Treat NanoCore App API, `@openkit/core-client`, operation catalog, bundled CLI, unified Skill, and Web as one release-coupled set with an exact contract identity and no cross-release compatibility promise.
- Treat one NanoCore deployment as one personal or small-team trust domain, not a tenant or organization host.
- Keep Better Auth as the authentication and session provider while OpenKit Core owns users, Workspace relationships, authorization facts, and product policy.
- Give every Workspace one canonical owner and one owner-independent physical root at `DATA_ROOT/workspaces/<workspaceId>`.
- Use fixed effective product roles `owner`, `editor`, and `viewer`, projected into the existing NGAC-aligned policy kernel rather than enforced by a second RBAC engine.
- Use registered-user invitations bound to canonical user IDs for V1; do not add outbound email, pre-account bearer invitation links, or a user directory.
- Resolve every Workspace operation through one central operation-metadata and policy path before opening storage.
- Preserve stable actor and responsible-user attribution on shared history and governed decisions.
- Add compare-and-swap only to genuinely mutable shared records and durable first-writer claims to one-shot decisions; keep immutable history append-only and Workspace file apply on its existing expected-base contract.
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
- Separate responsible-user accountability from Workspace storage resolution in AEP, scheduler, worker-control, automation, capability, and usage paths.
- Add or update durable identity, audit, invitation, membership, lifecycle, revision, and lineage schemas only where the accepted invariants require them.
- Remove unused organization placeholders from OpenKit-owned schemas and generated projections.

### Core database and storage

- Replace cascading owner deletion with restrictive ownership and membership references.
- Add fixed membership access, invitation lifecycle, revisions, transition constraints, and required indexes to the Core database.
- Preserve one active owner membership and derive effective owner authority from the registry.
- Move canonical Workspace trees and `workspace.sqlite` databases from `users/<ownerUserId>/workspaces/<workspaceId>` to `workspaces/<workspaceId>`.
- Make every Workspace store opener, recovery scanner, index rebuilder, importer, exporter, scheduler, and runtime path independent from authenticated user storage.
- Add a one-way offline migration with preflight, same-filesystem staging, exact verification, layout-marker publication, a migration report, and bounded source retention.

### Identity, authorization, and recovery

- Add registered-user invitation creation, acceptance, decline, revocation, expiry, and re-invitation behavior.
- Add owner/editor/viewer effective access, member removal and leave, access change, ownership transfer, user disable, guarded deletion, and explicit administrator recovery.
- Add one central Workspace access resolver driven by canonical operation metadata, resolved resource lineage, current membership, token intersection, and the policy kernel.
- Remove path/body authorization heuristics, filesystem-discovery authorization, handler-local role tables, and implicit `server-admin` Workspace content bypass.
- Re-evaluate membership and policy at request admission and before governed effects or approved apply.

### Shared work correctness and accountability

- Add actor attribution to the bounded record and decision families named by the multi-user spec.
- Add expected-revision compare-and-swap to mutable Workspace, membership, invitation, Knowledge projection, Artifact metadata or review, and other demonstrated shared-edit families.
- Make invitation, membership, owner-transfer, approval, and other terminal decisions durable first-writer transitions before retryable runtime delivery.
- Preserve append sequence and request-id idempotency for immutable history.
- Preserve the existing staged-review, expected-base, conflict-preflight, and approved-apply contract for Workspace files.

### Runtime, search, attention, and automation

- Make scheduler, AEP, worker control, Gateway, policy, usage, audit, and approval paths carry responsible-user context without using it as a storage owner.
- Pause Workspace-owned automations when their responsible user becomes disabled or loses authority until an owner reassigns them.
- Build Workspace lists and global search from the authorized Workspace set before loading results.
- Filter Action Center rows by current visibility and eligible decision principal.
- Keep personal preferences, recent selection, notifications, and credentials in user scope while shared work remains in Workspace scope.
- Give every server user one independent owner-only Quick Chat Workspace and reject every Quick Chat sharing or transfer operation in V1.

### Portability and product projections

- Update portable export/import coverage in the same slice as the storage and identity change.
- Preserve historical actor references only as non-authority lineage across portable import.
- Preserve users, owners, memberships, invitations, and token metadata only in full same-deployment backups.
- Add the supported sharing lifecycle to shared App API schemas, Core Client, operation catalog, bundled CLI, unified Skill, and Web without adding a second contract owner.
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

## Verified Current Baseline

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
| Scheduler, AEP, worker control, Gateway, automations | Responsible-user context, current-authority rechecks, paused stale work, and storage-owner removal. |
| Audit, usage, permission, approval, Action Center | Actor attribution, eligible principals, lifecycle producers, atomic terminal claims, redaction, and historical lineage. |
| Search, Workspace lists, notifications, Quick Chat | Authorized candidate sets, personal projections, per-user Quick Chat, and non-shareability. |
| Core Client, operation catalog, CLI, Skill | One exact-release projection of every supported sharing operation and typed conflict. |
| Web | Role-aware Workspace switcher, member/invitation management, actor labels, conflict recovery, transfer safeguards, and viewer state. |
| L0-L6 verification | Boundary, schema, policy, migration, process, browser, artifact, and representative team stories. |

## Execution Principles

- Follow test-first development for every behavior slice: land focused failing tests before production changes.
- Prefer a test commit followed by an implementation commit for each coherent behavior slice.
- Update packages in dependency order and keep commits independently reviewable: protocol and shared schemas, policy/config packages, NanoCore, Core Client and operation catalog, CLI and Skill, then Web.
- Do not use the Web or Skill as the source of business rules; complete the kernel and public contract first.
- Keep one central Workspace resolver and one policy decision path. Do not scatter role predicates across handlers.
- Add only fields, records, routes, and helpers required by the accepted V1 behavior.
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

### Stage 1 — Freeze Failing Contracts And Migration Fixtures

- Add L0 coverage that enumerates every Workspace-scoped public operation and requires canonical scope resolution and a policy operation.
- Add strict protocol and App API schema tests for actor references, members, invitations, roles, revisions, lifecycle operations, and typed conflicts.
- Add Core DB fixture tests for the current owner/membership shape and failing target constraints.
- Add storage migration fixtures for normal, duplicate-ID, missing-owner, missing-membership, symlink, corrupt database, partial-staging, and mixed-layout cases.
- Add a three-user L2/L3 scenario fixture before production behavior changes.

Exit condition: the intended target fails for explicit reasons while unchanged unrelated package tests remain green.

### Stage 2 — Land Durable Shared Schemas

- Add `ActorRef` and the smallest required actor fields to `@openkit/protocol` with generated-schema and conformance updates.
- Update AEP scope to carry a trigger actor and responsible user, deleting organization and physical-owner fields.
- Add release-coupled sharing and conflict schemas to `@openkit/app-api-schemas`.
- Classify every changed field as durable or release-coupled and advance the exact contract identity where required.
- Update all current producers and consumers in the same package slice; do not add permissive compatibility unions.

Exit condition: shared packages strictly express the accepted target, generated artifacts match, and no OpenKit-owned public schema contains an organization placeholder or user-owned Workspace path.

### Stage 3 — Migrate Core Identity And Workspace Storage

- Add Core DB migrations for restrictive owner/member references, registry revision, membership access and revision, invitations, uniqueness, and lifecycle indexes.
- Implement transaction helpers that preserve one owner and active owner membership.
- Add the offline storage migration with exact preflight, staging, digest verification, top-level publication, Core transaction, verification boot, migration report, and cleanup boundary.
- Refactor Workspace database and file openers, recovery, layout reporting, derived-index rebuild, export/import staging, and store construction to use `workspaces/<workspaceId>` without a user parameter.
- Remove old-path readers only after the migration fixture passes; do not add fallback lookup.

Exit condition: a migrated fixture boots only on the top-level layout, owner transfer changes no path, every Workspace has one canonical root, and failure leaves the original source recoverable with no mixed-layout product boot.

### Stage 4 — Centralize Workspace Authorization

- Define canonical operation metadata for server, user, and Workspace scope, resource resolution, mutation posture, and policy operation.
- Implement one fail-closed Workspace access resolver shared by Core and App API route families.
- Project owner/editor/viewer into the NGAC-aligned kernel and register the complete operation mapping.
- Intersect Better Auth actor or token owner, active membership, effective role, token binding and scope, responsible user, policy, and approval context.
- Remove route path/body heuristics, handler-local role decisions, user-directory discovery, and implicit `server-admin` content bypass.
- Add uniform non-enumerating access errors and IDOR tests for every resource family.

Exit condition: every Workspace-addressed operation is mechanically covered, missing facts deny, and no route can open Workspace storage before authorization.

### Stage 5 — Implement Sharing And User Lifecycle

- Implement invitation create, list, accept, decline, revoke, expiry, and re-invitation transitions for existing active users.
- Implement member list, access change, removal, leave, ownership transfer, Quick Chat rejection, and explicit administrator recovery.
- Revoke or block credentials and active product access on user disable while preserving history and ownership for resolution.
- Block hard deletion until every owned Workspace is transferred or deleted and ensure user deletion never cascades Workspace state.
- Emit linked lifecycle audit events with actor, subject, request, target, outcome, and revision.

Exit condition: the owner/editor/viewer matrix and lifecycle invariants pass transaction, restart, stale-request, and concurrent-request tests.

### Stage 6 — Add Shared Attribution And Concurrency

- Add actor attribution to user-authored Items, Turn trigger context, approvals, user-input requests, reviews, Workspace mutations, permission decisions, audit, automation, and governed effects as named by the spec.
- Add expected-revision compare-and-swap to the first demonstrated mutable shared record families and return a safe current summary on conflict.
- Make approval and other one-shot terminal decisions durable conditional transitions before any runtime or external delivery.
- Keep retry delivery idempotent and preserve the existing append-only and Workspace apply models.
- Add concurrency tests using distinct request IDs and independent clients, not only replay of one idempotency key.

Exit condition: stale writes cannot overwrite current state, contrary terminal decisions produce one durable winner, and all shared mutations remain attributable after restart.

### Stage 7 — Rebind Runtime And Background Work

- Remove physical store-owner assumptions from scheduler admission, AEP snapshots, worker-control sessions, Gateway attribution, automations, capability calls, usage, and runtime evidence.
- Reauthorize at turn admission and before governed effects, approved apply, Vault use, Git push, external API calls, and artifact publication.
- Quarantine or retain reviewable output from work whose responsible user loses authority, but prevent publication or external effects.
- Convert automations to Workspace-owned identities with one responsible user and pause them when that user loses authority.
- Verify worker restart, lease recovery, and stale-session behavior under membership downgrade, removal, disable, and owner transfer.

Exit condition: no background or worker path can continue privileged effects from stale user authority or infer a Workspace root from a user ID.

### Stage 8 — Align Search, Attention, Vault, And Portability

- Build Workspace lists and search candidates from current authorization before reading result content.
- Add eligible-principal filtering to Action Center, approvals, user-input requests, and reviews.
- Separate personal notification state from shared Workspace work state.
- Apply normal Workspace membership and policy to Workspace Vault reference, use-record, and rebind operations while retaining deployment-level Vault administration.
- Update export/import to exclude access grants, preserve actor lineage only, and create the importing user as sole owner/member.
- Verify full data-root backup and restore preserve same-deployment users and relationships.

Exit condition: removed users disappear from lists, search, attention, and Vault access on the next request; portable import grants no source-deployment authority.

### Stage 9 — Project The Exact-Release Agent Interface

- Add sharing operations to the Core Client and transport-neutral operation catalog from the same schemas and operation owners.
- Project discovery, invitation, membership, role, leave, transfer, conflict, and recovery behavior through the bundled CLI and unified Skill owned by the Agent Skill Interface plan.
- Keep invitation secrets absent and accept sensitive lookup input only through the established secret-safe CLI input posture.
- Replace any removal-only MCP parity tests for this feature with CLI/Skill contract and story coverage; do not add new MCP capabilities.
- Verify every generated artifact carries the same exact contract identity.

Exit condition: an agent using only the unified Skill can complete the supported multi-user lifecycle through governed NanoCore operations without loading private routes or implementing policy in prompts.

### Stage 10 — Add The Web Projection

- Add authorized Workspace switching and effective-role labels.
- Add owner member/invitation management, invitee accept/decline, role change, removal, leave, transfer safeguards, and explicit recovery messaging where applicable.
- Add actor labels and revision-conflict refresh/retry UX without exposing internal IDs, emails outside their intended view, or physical paths.
- Keep controls role-aware while preserving server-side enforcement as authority.

Exit condition: browser tests cover the complete lifecycle and cannot produce behavior unavailable through the shared public contract.

### Stage 11 — Release Verification And Documentation Closure

- Run L0-L6 coverage and the full relevant package, NanoCore, artifact, smoke, and story gates.
- Run the one-way migration against representative internal fixtures and retain a reviewed migration report.
- Remove obsolete organization fields, user-owned Workspace paths, authorization heuristics, current-implementation bypass notes, and old status claims from active docs only after implementation evidence exists.
- Update local READMEs, cookbooks, App API maps, generated artifacts, deployment guidance, specs, and this record.
- Close this record with commits, verification evidence, migration evidence, remaining hardening gaps, and links to the completed Agent Skill and Web projections.

Exit condition: all durable and release-coupled gates named by the stability baseline pass, no compatibility layer remains, and the representative three-user stories work after restart, migration, owner transfer, removal, export, and import.

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
- Storage migration fixture validation and schema constraint tests.
- Actor redaction, safe error, private-field boundary, export exclusion, and exact contract identity tests.

### L3-L5 implementation checkpoint

- Three-user NanoCore black-box lifecycle with owner, editor, viewer, token downgrade, removal, restart, and server-admin separation.
- Concurrent stale-write and contrary-decision tests against a real temporary NanoCore process.
- Migration, backup, restore, export, import, and packaged-server smoke using representative Workspace history.
- CLI/Skill operation coverage, redaction, and exact-release artifact checks.
- Browser lifecycle and conflict-recovery tests after the kernel and Agent interface are complete.

### L6 story checkpoint

- A three-person team shares one project Workspace, performs agent work, resolves attention gates, observes actor lineage, removes a member, and proves stale authority cannot cause a later governed effect.
- Ownership transfers without moving storage, survives restart, exports portably, imports into a fresh deployment, and grants only the importer initial authority.

## Migration Safety And Stop Rules

- Stop before publication if any Workspace ID maps to zero or multiple source trees, any source owner conflicts with the registry, any owner membership is absent, any link or unsafe path appears, or any authoritative database fails integrity verification.
- Never advance the layout marker until all staged Workspace trees, databases, Core constraints, and registry mappings verify.
- If publication or the Core transaction fails, keep NanoCore closed to product work, preserve original source trees, remove only migration-owned staging, and record the failed stage.
- If verification boot fails, do not enable a dual reader. Repair the target or restore the retained source and retry the migration from a clean preflight.
- Do not delete retained source trees until representative L3 and L5 checks pass on the published layout and the migration report has been reviewed.
- If the central resolver cannot cover every public Workspace operation, do not expose partial sharing; fail the coverage gate and finish the resolver inventory first.
- If a background path cannot re-evaluate current authority before an effect, disable that effect path for shared Workspaces until the check exists.
- If durable first-writer claims cannot be made before runtime delivery, pause that transition family rather than relying on process-local checks.

## Expected Handoff Points

- Stage 0 is the documentation-only checkpoint and the handoff into implementation authorization.
- Stage 1 must complete before any production schema, migration, or behavior change.
- Stage 2 lands shared contracts before NanoCore implementation and must be reviewed for durable versus release-coupled classification.
- Stage 3 requires a dedicated migration review before old-path cleanup is enabled.
- Stage 4 must finish before any sharing route is considered usable.
- Stages 5 and 6 complete the minimum product-safe multi-user kernel before runtime and product projections expand.
- Stage 9 coordinates with `202607131935040001-openkit_agent_skill_interface.md` and must reuse its CLI and operation-catalog owners.
- Stage 10 begins only after the public kernel and Agent interface contracts are stable in the same release.
- Stage 11 is the only point where implementation statuses and this record may be closed as verified.

## Known Risks

- Authorization coverage may drift across the large route surface. Mitigation: one resolver, operation metadata, closed exclusions, IDOR tests, and an L0 coverage gate.
- The storage migration can create split authority between Core rows and files. Mitigation: offline execution, exact staging, marker-last publication, source retention, no mixed-layout boot, and a reviewed migration report.
- Owner and membership state may drift. Mitigation: one owner field, active owner membership invariant, restrictive deletion, revisions, and transactional transfer.
- Actor fields may spread into every schema and create duplicated identity. Mitigation: use `ActorRef` only on the accepted attribution families and keep display and credential data in redacted projections.
- General optimistic concurrency may become framework overhead. Mitigation: use revisions only on current mutable shared records and keep append-only and file-apply contracts unchanged.
- Removed users may retain authority through tokens, workers, Vault grants, or automations. Mitigation: current membership intersection at request and effect boundaries, stale-session behavior, paused automation, and cross-channel tests.
- Invitation lookup may enumerate users. Mitigation: exact-email input, no directory endpoint, one safe unavailable result, rate limits at the public operation boundary, and no durable email authority.
- Deployment administration may remain a hidden content bypass in less-visible routes. Mitigation: explicit server-versus-Workspace operation classes and a server-admin denial fixture for every Workspace resource family.
- The feature may become coupled to the unfinished unified Skill work. Mitigation: finish the public NanoCore and Core Client contract first, then reuse the separately owned operation catalog and CLI without adding MCP or another client.
- Existing broad alignment work may edit the same specs. Mitigation: this record owns the focused multi-user target; coordinate checkpoints and preserve unrelated concurrent edits.

## Checkpoints

- 2026-07-15 — Product direction accepted: freeze durable Core and data/authority semantics, keep first-party App API surfaces release-coupled, exclude multi-tenancy, and keep BWM/Meta-Skill outside the kernel baseline.
- 2026-07-15 — Workspace sharing direction accepted: one canonical owner-independent Workspace root, fixed owner/editor/viewer projection, no share links, no filesystem aliases, and no Federation or P2P scope in this work.
- 2026-07-16 — Documentation authority completed: Core and active specs aligned, primary-source multi-user research distilled, and this implementation plan created; no behavior implementation started.
