---
status: Accepted
---
# Vault Model

This document defines OpenKit secret vault semantics.

This document owns secret vault references, vault grants, the `VaultInjection` concept and its plan and receipt records, current vault-use evidence semantics, future vault-audit terminology, rotation and revocation semantics, and the rule that secret material stays outside prompts, knowledge, artifacts, logs, and ordinary workspace records.

This document does not own permission policy, sandbox containment, knowledge semantics, agent setup fields, communication transports, storage layout, provider-native secret payloads, or concrete vault backend implementation.

Vault is the secure credential boundary for workspaces and other declared scopes. It is separate from permission, sandbox, knowledge, agent config, communication, and storage, even though all of those aspects may reference vault records.

## Purpose

Agents often need access to credentials for model providers, MCP servers, external APIs, repositories, cloud services, or internal systems.

The vault model gives Core a stable way to reference, grant, inject, audit, rotate, and revoke secret use without putting secret material into prompts, agent setup records, item logs, knowledge, normal workspace files, protocol payloads, or agent-visible diagnostics.

## Principles

- Secret values are never normal workspace content.
- Core records should carry vault references, grants, injection summaries, and audit metadata rather than secret values.
- Permission decides whether a subject may use a vault reference; vault defines how secret material is referenced and injected.
- Injection must be scoped, revocable, auditable, and outside agent prompt context.
- Backend-specific storage handles and provider-native secret payloads are implementation projections unless promoted by a future core design.

## Boundary

Vault owns secret material and secret references.

Permission decides whether a subject may use a vault reference.

Sandbox constrains where and how injected credentials can be reached.

Agent capability routing applies the runtime injection contract when a capability call needs a credential.

Storage may persist vault metadata, references, grants, and audit records, but normal workspace storage must not store plaintext secret values.

## Scope

Vault records may be server-scoped, user-scoped, or workspace-scoped.

Server-owned provider config may use secret references for deployment-level credentials. Cross-scope use must be explicit and auditable.

## Core Concepts

`SecretVault` is the secure boundary for one workspace or another declared scope.

`VaultReference` is a non-secret stable reference to secret material.

`VaultGrant` records that a subject or capability path may use a vault reference under policy.

`VaultInjection` is the governed umbrella concept for making secret material available through an approved path. It spans a pre-effect plan, the backend resolution and sink effect, and, only after successful completion, a receipt.

`VaultInjectionPlan` is the durable non-secret pre-effect plan for one approved injection path. It records intended visibility, target, expiry behavior, revocation behavior, redaction, and required backend capability. It is not proof that material was resolved or injected and does not itself authorize use.

`VaultInjectionReceipt` is the durable non-secret fact that one planned injection completed successfully. It records completion lineage and redacted outcome metadata. A denied, failed, interrupted, or unproven injection MUST NOT produce a receipt.

`VaultUse` is the current durable non-secret evidence record for an attempted backend material resolution. It records either success or a typed redacted failure and is not authorization or proof that the downstream injection sink completed.

`VaultAudit` is reserved for a future consolidated audit projection over Vault activity. No current schema, service, table, or public record implements it; current evidence consists of `VaultUse` and the audit events owned by the Audit aspect.

These are conceptual record families, not a complete field list. The Vault specification owns their concrete non-secret record requirements.

## Authority And Projection Boundaries

- `VaultReference` metadata is the durable Core identity and scope authority for a secret reference. The Vault backend separately owns secret material, material versions, revocation, and material-integrity facts.
- `VaultGrant` is the durable use authority produced under permission policy. Every use MUST validate the active grant, reference, actor, target, lifetime, and injection path at the governed effect boundary.
- `VaultInjectionPlan`, `VaultInjectionReceipt`, `VaultUse`, and audit events are durable non-secret records and evidence. They MUST NOT create, extend, restore, or substitute for a grant.
- A plan's identity, original intended effect, target, grant lineage, and creation fact are immutable. A receipt's identity, successful completion fact, original plan and grant lineage, target execution lineage, and completion time are immutable. Lifecycle fields such as plan status or receipt revocation status are mutable projections over those facts; they MUST NOT rewrite history, retract completion, or claim that already exposed material was recalled.
- App API, CLI, Web, Agent Environment Package, workspace export, and runtime-backend representations are projections. They MUST preserve these meanings, redact secret material and backend-private locators, and MUST NOT become a second authority.

## Lifecycle And Failure Semantics

1. A reference becomes usable only after the backend has accepted its material and Core has a matching active non-secret `VaultReference`. Missing or contradictory backend and Core facts fail closed.
2. A grant may be created only for an active reference under the owning permission policy. Revoked, expired, imported-history, wrong-scope, or wrong-target grants do not authorize an injection.
3. NanoCore creates a `VaultInjectionPlan` after validating the intended target and visibility and before resolving material or invoking an injection sink. A plan remains a pre-effect description even when a later step fails.
4. Backend resolution records one `VaultUse` success or typed failure. If authorization, resolution, or the injection sink fails, no `VaultInjectionReceipt` is created and no success may be inferred from the plan.
5. NanoCore creates a `VaultInjectionReceipt` only after the planned sink effect completes successfully. If completion cannot be proved after interruption, the state is unknown rather than successful: no receipt may be fabricated, affected runtime state must be inspected or torn down at its existing lifecycle boundary, and any later attempt requires current authority.
6. Rotation keeps the reference identity, creates a new backend material version, and makes that version current. A bounded backend grace period may keep an explicitly requested prior version resolvable; after grace it fails as expired. Existing plans, receipts, and use evidence remain immutable history and do not select a new version.
7. Revocation immediately blocks future material resolution and may advance dependent plan and receipt lifecycle projections without changing their immutable original facts. A receipt becomes `stale-session` only when already injected material may remain reachable; runtime-file or runtime-environment material cannot be recalled atomically, so the owning runtime lifecycle must stop or recycle the affected environment before it is trusted again.
8. Grant, plan, receipt, and material expiry is enforced when the corresponding governed boundary is evaluated. Stored expiry timestamps and status fields do not imply an implemented background transition; an expired fact fails closed even when its persisted status has not been advanced.
9. A missing reference, grant, plan, material version, or required lineage; a stale or contradictory record; a locked or unavailable backend; an expired version; or a revoked reference produces a typed redacted failure. Failures may produce `VaultUse` and audit evidence, but never a successful receipt or implicit repair.
10. Backend integrity disagreement remains failed closed. Recovery MUST use an explicitly owned reviewed cleanup or ordinary new-request path; plans, receipts, use evidence, and projections MUST NOT reconstruct material, settle an unknown effect, or repair backend state.

## Injection Contract

Secret values must be injected outside agent prompt context.

Each concrete injection path MUST define where the secret is visible, how long it is valid, how it is revoked, which backend capability it requires, and which non-secret evidence it records.

The current NanoCore realization uses one encrypted-file Vault backend for both local and server deployment modes. That realization does not change the abstract Vault concepts or make ciphertext, authenticated metadata, or the external master-key file normal workspace storage.

The injection boundary is invariant across deployment shapes. Desktop-embedded, server, container, remote, and managed deployments all keep secret values inside a vault backend or a Core-controlled injection path, and agents receive credentials only through an approved injection path such as a gateway, proxy, or adapter mechanism. No deployment shape, release artifact, container image, or operator procedure may require writing a secret value into a prohibited surface in order to work; a shape that appears to require it is unsupported until an injection path covers it.

## Prohibited Surfaces

Secret values must not appear in:

- agent config or agent setup records
- agent catalog entries
- agent, deployment, or container manifests
- container images and other release artifacts
- item payloads
- knowledge entries
- protocol errors
- normal workspace files
- logs intended for product surfaces
- sandbox summaries
- capability call audit records

## Invariants

- Secret values MUST NOT appear in prompts, agent setup records, item payloads, knowledge entries, context packages, protocol errors, normal workspace files, product logs, sandbox summaries, or capability-call audit records.
- Vault references MUST be non-secret stable references rather than encoded secret material.
- Vault injection MUST happen outside agent prompt context.
- Vault use MUST be auditable by reference, scope, actor context, and injection path without recording the secret value.
- A `VaultInjectionPlan` MUST exist before its effect and MUST NOT be interpreted as evidence that injection occurred.
- A `VaultInjectionReceipt` MUST exist only for a successfully completed injection.
- `VaultUse` MUST record backend resolution success or typed failure without becoming use authority or sink-completion proof.
- Cross-scope vault use MUST be explicit and auditable.
- Deployment shape, release packaging, and operator procedure MUST NOT require writing a secret value into a prohibited surface; secret values MUST stay in a vault backend or a Core-controlled injection path in every deployment shape.

## Related Docs

- `docs/core/core-concepts.md`
- `docs/core/permissions.md`
- `docs/core/sandbox.md`
- `docs/core/agent-capability.md`
- `docs/core/communication.md`
- `docs/core/storage.md`
