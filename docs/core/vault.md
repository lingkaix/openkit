# Vault Model

Status: Accepted

This document defines OpenKit secret vault semantics.

This document owns secret vault references, vault grants, injection boundaries, vault-use audit concepts, rotation and revocation semantics, and the rule that secret material stays outside prompts, knowledge, artifacts, logs, and ordinary workspace records.

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
- Backend-specific vault handles and provider-native secret payloads are implementation projections unless promoted by a future core design.

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

`VaultInjection` is the act of making a secret available to an agent or capability call through an approved path.

`VaultAudit` is the audit projection of vault reference use. It records that a reference was used, not the secret value.

These are conceptual record families, not a complete field list.

## Injection Contract

Secret values must be injected outside agent prompt context.

Supported future injection paths may include:

- agent capability gateway header or token injection
- MCP server environment injection
- process environment injection with sandbox constraints
- short-lived proxy credentials
- OS or external vault handles
- local encrypted vault handles

Each injection path must define where the secret is visible, how long it is valid, how it is revoked, and which audit metadata is recorded.

## Prohibited Surfaces

Secret values must not appear in:

- agent config or agent setup records
- agent catalog entries
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
- Cross-scope vault use MUST be explicit and auditable.

## Related Docs

- `docs/core/core-concepts.md`
- `docs/core/permissions.md`
- `docs/core/sandbox.md`
- `docs/core/agent-capability.md`
- `docs/core/communication.md`
- `docs/core/storage.md`
