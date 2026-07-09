# Identity Model

Status: Accepted

This document defines OpenKit identity semantics.

This document owns users, workspace memberships, authentication sessions, tokens, invitations, automation identities, integration identities, and the actor context that other core aspects use.

This document does not own authorization policy, permission decisions, audit projection shape, App API auth endpoints, auth-provider table layout, OAuth provider payloads, secret material, or workspace data ownership.

Identity answers who or what is acting. Permission answers whether that actor may perform an action. The two are related, but they are not the same model.

## Purpose

OpenKit supports single-user local operation, but the core model must remain compatible with shared workspaces, invitations, roles, tokens, automations, and external integrations.

The identity model provides stable names for the actors and credentials that appear in ownership, audit, permission, usage, and protocol records.

## Principles

- Identity answers who or what is acting; permission answers whether that actor may perform an action.
- Workspace membership is the bridge between account-level identity and workspace-scoped work.
- Tokens, automations, integrations, and human users must all have explicit actor context when they cause work.
- Implementation auth libraries may use their own table names, but core docs and OpenKit-authored records should use the conceptual identity names defined here.
- Raw credential material belongs to the vault or auth backend, not identity summaries or normal protocol records.

## Boundary

Identity owns authentication subjects and membership relationships.

Permission owns authorization policy and decisions.

Audit records preserve identity context for later review.

App API may expose sign-in, invitation, and profile endpoints, but those endpoints are implementation projections.

## Core Concepts

`User` is an account-level human subject.

`WorkspaceMember` is a user's membership in one workspace.

`Role` is a named membership or policy grouping. Role semantics belong to permission policy.

`AuthSession` is a client or login session. OpenKit-authored records must not call this concept just `Session`, to avoid collision with `AgentSession` and other session-like concepts.

`Token` is a credential used by a client, integration, automation, agent, or bridge to authenticate to Core or another OpenKit service.

`Invitation` is a pending request to join a workspace.

`AutomationIdentity` is a non-human actor that can trigger work under a declared owner or policy context.

`IntegrationIdentity` is an external system identity such as a webhook source, repository app, or provider integration.

These are conceptual record families, not a complete field list.

## Typical Record Areas

`User` record areas include stable identity, `kind` (`local` for the implicit local user or `human` for an account-level human subject), display name, contact handles, status, creation time, last activity time, and profile metadata.

User status values may include:

```text
active
disabled
deleted
```

`WorkspaceMember` record areas include workspace ID, user ID, membership status, roles or attributes, invitation reference, joined time, suspended time, and removed time.

Workspace member status values may include:

```text
invited
active
suspended
removed
```

`AuthSession` record areas include user ID, client or channel summary, issued time, last seen time, expiration time, revoked time, and status.

Auth session status values may include:

```text
active
expired
revoked
```

`Token` record areas include token ID, owner identity, scope, token type, issued time, expiration time, revocation time, rotation metadata, and status. Token records must not expose raw token secret material after issuance.

Token status values may include:

```text
active
expired
revoked
rotated
```

`Invitation` record areas include workspace ID, inviter identity, invitee handle, role or attribute proposal, issued time, expiration time, accepted time, revoked time, and status.

Invitation status values may include:

```text
pending
accepted
expired
revoked
declined
```

`AutomationIdentity` record areas include workspace ID, owner identity, automation name, trigger permissions, status, created time, disabled time, and last trigger time.

`IntegrationIdentity` record areas include workspace ID, provider or integration name, external subject summary, allowed trigger sources, token references, status, created time, and last activity time.

Automation and integration status values may include:

```text
active
disabled
revoked
error
```

Automation identity and trigger source are different concepts. `AutomationIdentity` is the subject that acts. `TriggerSource` is the event or mechanism that caused a turn or input.

## Workspace Membership

Workspace membership is the default bridge between identity and workspace-scoped work.

Future multi-user workspaces should be able to answer:

- which users belong to a workspace
- which roles or attributes they have
- which invitations are pending
- which tokens or automations can act in the workspace
- which user or automation caused a turn, approval, vault use, or capability call

## Invariants

- Identity records MUST NOT be treated as permission decisions.
- Workspace-scoped actions SHOULD preserve enough identity context to explain who or what caused them.
- OpenKit-authored records MUST use `AuthSession`, `AgentSession`, `ChannelSession`, or another prefixed term instead of the bare `Session`.
- Raw token secret material MUST NOT be exposed after issuance through identity records, item payloads, audit records, or protocol summaries.
- Automation and integration identities MUST remain distinguishable from trigger sources.

## Related Docs

- `docs/core/core-concepts.md`
- `docs/core/permissions.md`
- `docs/core/protocol.md`
- `docs/core/audit.md`
