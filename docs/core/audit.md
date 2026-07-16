# Audit Model

Status: Accepted

This document defines OpenKit audit semantics.

This document owns audit projection semantics, auditable activity categories, audit producer boundaries, audit event record areas, audit data safety, and audit source-of-truth guidance.

This document does not own item history, permission policy, capability-call routing, vault secret storage, sandbox containment, storage layout, protocol schemas, or UI audit dashboards.

Audit records are stable projections used to explain what happened, who or what caused it, which policy or gateway path applied, and which workspace objects were affected.

## Purpose

OpenKit coordinates human users, automations, agents, agent sessions, vault references, capability calls, permissions, sandbox modes, files, artifacts, and knowledge.

Audit gives Core a durable way to answer safety, debugging, review, and governance questions without requiring every product surface to replay raw item logs.

## Principles

- Audit explains actions, actors, policy or gateway paths, affected resources, and outcomes; it does not measure consumption or replace item history.
- Core owns the durable audit projection even when adapters, bridges, gateways, or agents attach audit metadata.
- Audit should store references, summaries, hashes, stable IDs, or redacted excerpts rather than secret values or unrestricted raw payloads.
- Audit should be queryable without becoming a second user conversation log.
- Missing audit producers in early implementations must be explicit scope limits, not ambiguous product promises.

## Boundary

Audit is a projection over core activity.

Audit events may be derived from:

- items
- capability calls
- permission decisions
- vault reference use
- agent session lifecycle events
- sandbox lifecycle events
- knowledge lifecycle events
- storage migrations or imports

The item log remains the communication history. Audit records are queryable governance records and must not become a second user conversation log.

## Producers

Core is responsible for producing audit events at stable enforcement and coordination boundaries.

Core MUST write or enqueue an audit event for:

- permission decisions
- capability calls
- vault reference use
- approval decisions
- Workspace invitation, membership, role, ownership-transfer, recovery, and deletion decisions
- user disable, deletion, and credential-revocation decisions
- agent session lifecycle changes
- sandbox lifecycle changes
- knowledge entry creation, archival, supersession, or injection
- artifact publication
- destructive storage operations

Adapters, bridges, gateways, and agents may attach audit metadata, but Core owns the durable audit projection.

If an implementation intentionally omits a class of audit event, it should document that omission in product scope rather than silently presenting audit as complete.

## AuditEvent

`AuditEvent` is the conceptual record for auditable activity.

Minimum stable areas include:

- audit event ID
- `protocolVersion`
- workspace ID
- stable actor reference when an actor exists
- redacted authenticated credential and channel summary when applicable
- subject reference when the affected subject differs from the actor
- `category`
- action
- resource summary
- outcome
- `severity`
- `summary`
- timestamp
- request ID when available
- optional thread ID
- optional turn ID
- optional item ID
- optional agent ID
- optional agent session ID
- optional capability call ID
- optional permission decision ID
- optional invitation or membership ID
- optional error code

These are model areas, not a complete field list.

## Data Safety

Audit records must avoid storing secret values, raw provider payloads, sensitive sandbox internals, or unrestricted file contents.

Audit should store references, summaries, hashes, stable IDs, or redacted excerpts where needed.

An audit actor uses the `ActorRef` semantics from `docs/core/identity.md`. Display names and email addresses may appear only as redacted point-in-time summaries; they are not durable actor identifiers. Credential summaries may identify credential kind, stable credential record ID, and channel, but never secret material, authorization headers, cookies, token hashes, or invitation secrets.

## Source Of Truth

Audit records may be stored as SQLite source-of-truth records because they are operational projections that need structured query, filtering, and retention policies.

Where possible, audit events should retain links back to item IDs, capability call IDs, permission decision IDs, vault reference IDs, and other related core records.

## Invariants

- Audit records MUST NOT store secret values, raw provider payloads, sensitive sandbox internals, or unrestricted file contents.
- Audit MUST remain a governance projection over core activity, not a second user conversation log.
- Product surfaces MUST NOT claim complete audit coverage when an implementation intentionally omits an audit producer class.
- Audit events SHOULD retain stable links back to item IDs, capability call IDs, permission decision IDs, vault reference IDs, agent session IDs, or related core records when those records exist.
- Auditable shared mutations and terminal human decisions MUST preserve the winning actor reference, responsible user when applicable, target resource, request ID, outcome, and timestamp.
- Membership, ownership, credential, and permission changes MUST be auditable even when the affected user later becomes disabled, removed, or deleted.
- Core MUST own durable audit projection; adapters, bridges, gateways, and agents may only provide metadata or source events.

## Related Docs

- `docs/core/core-concepts.md`
- `docs/core/protocol.md`
- `docs/core/communication.md`
- `docs/core/permissions.md`
- `docs/core/vault.md`
- `docs/core/agent-capability.md`
- `docs/core/storage.md`
