# Identity Model

Status: Accepted

This document defines OpenKit identity semantics.

This document owns users, workspace memberships, authentication sessions, tokens, invitations, automation identities, integration identities, and the actor context that other core aspects use.

This document does not own authorization policy, permission decisions, audit projection shape, App API auth endpoints, auth-provider table layout, OAuth provider payloads, secret material, or workspace data ownership.

Identity answers who or what is acting. Permission answers whether that actor may perform an action. The two are related, but they are not the same model.

## Purpose

OpenKit supports both single-user local operation and shared server workspaces with invitations, roles, tokens, automations, and external integrations.

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

`User` is Core's canonical human-subject record family. Account-backed humans and the implicit local human use the same family; `kind = local` is an implementation projection for the implicit local human, not a distinct identity type.

`WorkspaceMember` is a user's membership in one workspace.

`Role` is a named membership or policy grouping. Role semantics belong to permission policy.

`AuthSession` is a client or login session. OpenKit-authored records must not call this concept just `Session`, to avoid collision with `AgentSession` and other session-like concepts.

`Token` is a credential used by a client, integration, automation, agent, or bridge to authenticate to Core or another OpenKit service.

`Invitation` is a pending request to join a workspace.

`AutomationIdentity` is a non-human actor that can trigger work under a declared owner or policy context. The concept alone does not define a token-issuance or Workspace-membership contract; any such contract requires a separate owning specification.

`IntegrationIdentity` is an external system identity such as a webhook source, repository app, or provider integration.

`ActorRef` is the stable, non-secret identity summary attached to shared history and governed actions. It is a closed tagged union: a human actor carries `kind=user` and its stable `id`, and that same ID is the responsible user by definition; an `agent`, `automation`, `integration`, or `system` actor additionally carries nullable `responsibleUserId`. This avoids duplicating a human identifier in two fields and keeps the complete invariant representable in both the canonical Zod schema and generated JSON Schema. Credential kind, credential ID, channel, display name, and email are request or audit projections rather than part of the stable actor reference.

These are conceptual record families, not a complete field list.

## Typical Record Areas

`User` record areas include stable identity, `kind` (`local` only for the implicit local-human projection or `human` for an account-backed human), display name, contact handles, status, creation time, last activity time, and profile metadata. Both `kind` values remain projections of the same Core `User` family.

The current User lifecycle has exactly these status values:

```text
active
disabled
```

`disabled` preserves the stable User identity and historical references while denying new authentication and authority. V1 exposes no re-enable or hard-delete transition; adding either requires an accepted owning specification before implementation.

`WorkspaceMember` record areas include workspace ID, user ID, membership status, access level or policy attributes, invitation reference, joined time, removed time, and revision.

Workspace member status values may include:

```text
active
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

`Invitation` record areas include workspace ID, inviter identity, canonical invitee user ID, proposed access level or policy attributes, issued time, expiration time, accepted time, declined time, revoked time, and status. A pending invitation is not a membership and grants no Workspace authority.

Invitation status values may include:

```text
pending
accepted
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

Every shared workspace must be able to answer:

- which users belong to a workspace
- which roles or attributes they have
- which invitations are pending
- which tokens or automations can act in the workspace
- which user or automation caused a turn, approval, vault use, or capability call

Workspace ownership is a distinguished lifecycle and authority relationship. It does not make the owner's user storage the parent of canonical workspace data, and changing the owner must not change workspace identity or move workspace-owned state.

The canonical owner must also have active membership. Ownership is stored once and effective owner authority is derived from that relationship rather than duplicated as a mutable membership role. Disabling a user preserves ownership for explicit administrator recovery and cannot cascade-delete a Workspace. Any future destructive user-deletion design must transfer ownership first or fail.

## Invariants

- Identity records MUST NOT be treated as permission decisions.
- Ordinary Workspace content access MUST come from active membership and a permission decision, not from filesystem presence, a user-owned link, an invitation, or deployment-administrator credentials alone.
- Deployment recovery authority MAY change ownership or membership through an explicit audited recovery operation, after which normal Workspace authorization applies; it MUST NOT silently bypass membership for content access.
- Workspace owner transfer MUST preserve workspace identity and history.
- Workspace-scoped human, agent, automation, and integration actions MUST preserve an `ActorRef` when attribution is required to explain who or what caused them.
- Credential scope, token binding, active membership, and current permission MUST be intersected at request time; no one fact is sufficient by itself.
- OpenKit-authored records MUST use `AuthSession`, `AgentSession`, `ChannelSession`, or another prefixed term instead of the bare `Session`.
- Raw token secret material MUST NOT be exposed after issuance through identity records, item payloads, audit records, or protocol summaries.
- Automation and integration identities MUST remain distinguishable from trigger sources.

## Related Docs

- `docs/core/core-concepts.md`
- `docs/core/permissions.md`
- `docs/core/protocol.md`
- `docs/core/audit.md`
