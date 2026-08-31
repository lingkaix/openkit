---
status: Accepted
implementation: Partial
date: 2026-07-15
---
# Single-Deployment Multi-User Workspace System

## Owns

- The target design for several authenticated users sharing one canonical Workspace inside one NanoCore deployment.
- Workspace owner, member, invitation, access-level, leave, removal, transfer, disable, and deletion invariants.
- The owner-independent canonical workspace storage root and the one-way migration from user-nested workspace roots.
- Central per-request workspace access resolution and the fixed product-role projection into the existing NGAC-aligned policy kernel.
- Actor attribution, shared-write concurrency, human-decision authority, token intersection, import/export membership behavior, and multi-user acceptance criteria.

## Does Not Own

- Authentication-provider internals, password policy, or Better Auth session-table semantics.
- Canonical identity, permission, storage, audit, protocol, vault, or work concepts already owned by `docs/core/`.
- Multi-tenancy, legal tenant isolation, organizations, departments, nested teams, SSO, SCIM, or custom role administration.
- Federation, P2P, cross-deployment collaboration, or external collaboration protocols.
- Real-time coediting, CRDT, operational transformation, presence, cursors, or collaborative text merge.
- Business World Model, Meta-Skill, or domain Skill schemas.
- Automation execution, durable schedule/fire records, and automation responsibility reassignment, which belong to `docs/specs/20260711-scheduler_recurring_event_triggers.md`.
- Long-lived compatibility for App API, Core Client, CLI, Skill, or Web projections.
- Outbound email delivery or pre-account invitation onboarding.
- Runtime Epoch lifecycle, sandbox termination, cleanup, and runtime transport, which belong to `docs/specs/20260802-nanohost_runtime_and_transport.md`.

## Core References

- `docs/core/foundation.md`
- `docs/core/core-concepts.md`
- `docs/core/architecture.md`
- `docs/core/work-model.md`
- `docs/core/storage.md`
- `docs/core/identity.md`
- `docs/core/permissions.md`
- `docs/core/audit.md`
- `docs/core/vault.md`
- `docs/core/agent-session.md`
- `docs/core/contract-evolution.md`

## Intent

- `docs/product-vision.md`

## Summary

One NanoCore deployment is one personal or small-team trust domain, not a multi-tenant host. Users share a Workspace through Core-owned membership and policy records, while the Workspace remains one canonical storage and execution boundary independent of its current owner.

The creator becomes the default owner. The owner relationship is stored once in the workspace registry, and every owner is also an active member. Non-owner membership stores only `editor` or `viewer`. Product roles compile into the existing NGAC-aligned policy kernel; OpenKit must not add a second RBAC engine or delegate workspace authorization to Better Auth.

Canonical workspace data moves to `DATA_ROOT/workspaces/<workspaceId>`. `DATA_ROOT/users/<userId>` remains the home for genuinely personal preferences and user-local state. Sharing never creates a copy, a `share/` directory, a reference file, or a filesystem link.

The smallest complete V1 supports registered-user invitations, owner/editor/viewer access, owner transfer, removal and leave, disable-safe user lifecycle, actor attribution, narrow optimistic concurrency for explicitly named mutable shared records, durable first-writer human decisions, and risk-sufficient verification at the lowest layer that proves each invariant plus one representative agent-first story.

## Goals

- Support the product's typical three-to-five-person expert team without enterprise organization machinery.
- Let two or more users see and operate on the same Workspace, history, knowledge, artifacts, and agent work.
- Keep owner transfer and membership changes independent from physical workspace storage.
- Enforce every workspace operation through one fail-closed resolver and one policy kernel.
- Preserve who initiated, approved, edited, or caused shared work.
- Prevent lost updates and double terminal decisions without introducing distributed collaboration infrastructure.
- Preserve portable workspace data while excluding deployment-local access grants.
- Migrate existing internal data once to the clean target with no legacy reader or link layer.

## Non-Goals

- Do not add `tenantId`, `organizationId`, organization tables, legal-isolation claims, or per-tenant configuration.
- Do not use Better Auth Organization, Team, Admin, or access-control plugins as the owner of Workspace membership or permissions.
- Do not add custom roles, role hierarchies, multiple simultaneous roles, groups, departments, or separation-of-duty administration.
- Do not add guest links, public sharing, anonymous access, external collaborators, or pre-account email invitations.
- Do not add authorization caches before measurements demonstrate a need.
- Do not make a shared Workspace a real-time document-collaboration system.
- Do not add filesystem aliases, symlinks, hard links, per-user Workspace copies, or compatibility readers.
- Do not make deployment administrator credentials an implicit way to read Workspace content.
- Do not design future Federation or P2P behavior in this specification.

## Background

At this specification's entry point, OpenKit already had the beginnings of server-mode multi-user isolation: Better Auth sessions, canonical users, opaque access tokens, a workspace registry, owner membership creation, active/removed membership rows, request-time membership checks, token workspace bindings, and an NGAC-aligned policy kernel.

That entry implementation was not yet a shared Workspace system: requests opened an `FsStore` for the authenticated user, canonical roots remained under `users/<userId>/workspaces/<workspaceId>`, Workspace databases required a user ID, scheduler admissions carried a user-store owner, and global search and worker paths inherited that physical ownership assumption. The Current Implementation Projection below is the authoritative present-tense status.

At entry, the membership table had no access level or invitation lifecycle, owner deletion cascaded through the Workspace registry, general audit rows lacked a human actor reference, most mutable shared records had no revision precondition, and Approval response checked pending state in process-local storage before some asynchronous delivery paths. Those entry gaps defined the implementation scope; they are not the present-tense status.

Canonical storage readers already reject symbolic links across the data root, workspace records, exports, staging, and source material. A `share/` folder or per-user link would therefore contradict both the security boundary and the current storage implementation.

## Research Conclusions

The accepted design distills the following primary-source findings:

- Authentication and authorization are separate. Better Auth remains the user/session provider; Workspace authorization remains an OpenKit Core responsibility.
- Access must deny by default and validate the resolved object on every request, including read, mutation, export, and administration operations.
- Fixed roles are enough for a small flat team. Role hierarchy and custom-role administration are optional complexity, not V1 requirements.
- Role membership should become user-attribute assignments and associations in the existing NGAC-aligned policy graph, not parallel role-condition code.
- Ownership must be one canonical relationship with `ON DELETE RESTRICT`, not duplicate owner fields or cascading user deletion.
- SQLite transactions and conditional updates are sufficient for membership, transfer, invitation, revision, and first-writer decision invariants.
- Optimistic revision checks belong only on mutable shared records. Append-only history keeps its existing sequence and idempotency discipline.
- Invitation lifecycle benefits from bounded expiry, authenticated acceptance, cancellation, decline, and explicit re-invitation, but V1 does not need an outbound email or bearer-link subsystem.

## Decision

OpenKit will implement a Core-owned shared Workspace model with these fixed properties:

1. One deployment is one trust domain.
2. A Workspace is not a tenant or organization.
3. A Workspace has exactly one canonical owner.
4. Every user who accesses a Workspace has one membership row.
5. The effective product role is exactly one of `owner`, `editor`, or `viewer`.
6. `owner` is derived from the registry; non-owner access is stored as `editor` or `viewer`.
7. Better Auth establishes the human user and credential, but never decides Workspace permission.
8. The policy kernel is the only policy-evaluation owner; S56 owns the product mapping, durable `PermissionDecision`, approval linkage, and enforcement behavior.
9. Canonical Workspace storage is independent of every user root.
10. Shared mutable records use narrow compare-and-swap semantics, while immutable logs remain append-only.

## Trust And Scope Model

```text
CoreServer trust domain
  Users
    user-private preferences and local state
  Workspaces
    one canonical owner
    zero or more non-owner members
    shared work, knowledge, artifacts, agents, policy, audit, and usage
```

A deployment administrator manages deployment configuration, credentials, user lifecycle, and explicit recovery operations. Deployment administration is not a hidden membership role.

Workspace isolation remains a meaningful security boundary inside the deployment, but this specification does not claim legal isolation between organizations hosted by one deployment.

## Canonical Data Model

### User Status

The canonical Core `User.status` is exactly `active` or `disabled`. New human and implicit local users start `active`. V1 supports only the one-way `active -> disabled` transition; it exposes no re-enable, hard-delete, or `deleted` state.

User disable is a server-scoped authenticated deployment-administrator operation mapped to `api.call`, not a Workspace role and not `deployment.recover`. One `core.sqlite` transaction conditionally marks the target disabled, records `disabled_at`, deletes every Better Auth session for that user, revokes every active or rotated OpenKit access token owned by that user, writes the Core-owned lifecycle `AuditEvent`, and records the existing command receipt. The transaction preserves the stable user ID, account record, ownership, membership, invitation, ActorRef, and history needed for later explicit resolution.

Disabled users fail closed at subsequent session creation, credential verification, request authorization, invitation response, and human decision checks. Stage 7 applies the same current-authority predicate immediately before runtime and background governed effects. Existing ownership is resolved only through the explicit administrator Workspace-recovery operation.

A fresh disable request for an already disabled user is a successful no-op: it writes only that request's Core command receipt pointing to the current user and returns the current disabled projection without another lifecycle audit event. `recovery_required` applies only when the exact current `requestId`, target user, and disable outcome are already proven by the request-owned Core lifecycle audit evidence but the matching receipt is absent; a disabled row created by another request is not such evidence. NanoCore does not infer the winning request, synthesize a receipt for an effected request, or create a repair workflow.

### Workspace Registry

`workspace_registry` is a server-scope source-of-truth table with these contract fields:

- `workspace_id`: stable opaque Workspace ID and primary key
- `owner_user_id`: the one canonical owner, referencing `users.id` with `ON DELETE RESTRICT`
- `status`: `active`, `deleting`, or `deleted`
- `revision`: positive monotonic integer used for owner and lifecycle compare-and-swap
- `created_at`
- `updated_at`

The Workspace record remains the owner of product status such as active or archived. Registry status coordinates identity and destructive storage lifecycle and must not become a second product status model.

### Workspace Membership

`workspace_members` is a server-scope source-of-truth table keyed by `(workspace_id, user_id)` with these contract fields:

- `workspace_id`
- `user_id`, referencing `users.id` with `ON DELETE RESTRICT`
- `status`: `active` or `removed`
- `access_level`: `editor` or `viewer`
- `invitation_id`: nullable reference to the accepted invitation
- `joined_at`
- `removed_at`: nullable
- `revision`: positive monotonic integer
- `created_at`
- `updated_at`

The canonical owner must have an active membership row. The owner's stored `access_level` is `editor`; the effective `owner` role is derived from `workspace_registry.owner_user_id` and must never be duplicated as a membership enum value.

Removed membership rows are tombstones. An explicit later invitation acceptance may reactivate the row; filesystem discovery, sign-in, import, or Workspace creation must not revive it implicitly.

### Workspace Invitation

`workspace_invitations` is a server-scope source-of-truth table with these contract fields:

- `invitation_id`: stable opaque invitation ID and primary key
- `workspace_id`
- `invitee_user_id`: one existing active OpenKit user
- `proposed_access_level`: `editor` or `viewer`
- `inviter_user_id`
- `status`: `pending`, `accepted`, `declined`, or `revoked`
- `expires_at`
- `accepted_at`: nullable
- `declined_at`: nullable
- `revoked_at`: nullable
- `revision`: positive monotonic integer
- `created_at`
- `updated_at`

Effective expiry is derived from `status = pending` and `expires_at <= now`; V1 needs no expiry worker. A fixed seven-day expiry is the V1 default.

At most one effective pending invitation may exist for one `(workspace_id, invitee_user_id)` pair. Re-invitation revokes the old pending row and creates a new row in one transaction.

The owner supplies an exact email as the product input. NanoCore normalizes it and resolves one existing active canonical user before creating the invitation. The email is a lookup input, not the durable authority key. Absent, disabled, already-active, and otherwise ineligible targets return the same product-safe `invitee_unavailable` result.

Invitation acceptance and decline require a Better Auth session or the implicit local identity whose canonical user ID equals `invitee_user_id`. V1 does not accept an OpenKit bearer token for this user-scoped collection, create a bearer invitation secret, send email, create an account, or expose a user directory.

The authenticated invitee discovers invitations through one user-scoped `list my invitations` operation. It selects only rows whose `invitee_user_id` equals the authenticated canonical user, accepts no caller-supplied user filter, requires no active Workspace membership, and denies every OpenKit bearer token including `server-admin`, `workspace`, and `workspace-readonly`. Owner-visible invitation listing remains a separate Workspace-scoped `membership.manage` operation. Both projections reuse the same closed `WorkspaceInvitation` record and expose no email address or bearer secret.

## Why Registered-User Invitations Are The V1 Cut

Better Auth and GitHub demonstrate useful invitation lifecycle and email-matching behavior, while OWASP provides the rules for secure one-time URL tokens. OpenKit does not currently own outbound email delivery, and the unified Agent Skill must not expose action-capable invitation secrets through agent-visible output.

The smallest safe V1 therefore requires the teammate to register first and binds the pending invitation directly to their canonical user ID. A future pre-account invitation design may add a separate random one-time secret stored only as a hash, verified-email matching, secure delivery, rotation, and rate limits. It must not overload `invitation_id` as the bearer secret.

## Fixed Product Roles

### Owner

The owner has all editor rights plus Workspace lifecycle and administration authority.

Owner-only operations include:

- create, revoke, and list Workspace invitations
- change a non-owner member between editor and viewer
- remove a non-owner member
- transfer ownership
- configure Workspace repositories, data sources, agent supply, policy, and Vault references or grants
- export the portable Workspace
- archive or delete the Workspace
- perform owner-only approval kinds

### Editor

An editor may:

- read shared Workspace content and history
- create and update Threads, Turns, user-authored Items, Knowledge, Artifacts, and ordinary work records
- start, steer, interrupt, retry, and review agent work when the mapped policy operation allows it
- respond to ordinary approvals and reviews only when the specific policy association and approval eligibility allow it
- read redacted Workspace audit and usage projections when policy allows it
- leave the Workspace

An editor may not manage members, invitations, ownership, Workspace deletion, export, policy, repositories, data sources, agent supply, or Vault grants by default.

### Viewer

A viewer may read ordinary Workspace content, history, Knowledge, Artifacts, and work status.

A viewer may not mutate Workspace content, start or steer agent work, answer human gates, view sensitive audit or usage projections, export data, use Vault-backed authority, or administer the Workspace.

A viewer may leave the Workspace.

## Access Matrix

| Capability family | Owner | Editor | Viewer |
| --- | --- | --- | --- |
| Read ordinary Workspace content and history | Yes | Yes | Yes |
| Create or update ordinary work records | Yes | Yes | No |
| Start, steer, interrupt, retry, and review agent work | Yes | Yes, when policy permits | No |
| Respond to ordinary approval or review | Yes | When eligible and policy permits | No |
| Read redacted Workspace audit and usage | Yes | When policy permits | No |
| Configure repository, data source, agent supply, policy, or Vault references | Yes | No | No |
| Invite, revoke invitation, change access, or remove member | Yes | No | No |
| Export, archive, delete, or transfer ownership | Yes | No | No |
| Leave Workspace | Only after transfer | Yes | Yes |

This table defines the fixed product projection. The policy kernel remains the enforcement owner and may deny an operation that the table makes eligible. It must not grant an operation outside the effective role's association.

## Policy Kernel Projection

For each authorized request, NanoCore derives one effective role from authoritative registry and membership data and projects it into the existing NGAC-aligned policy model:

- the human or responsible identity becomes the subject
- `owner`, `editor`, or `viewer` becomes a Workspace-scoped user attribute
- the target Workspace and its resources become object attributes
- the server authorization metadata registry maps each concrete public operation to one product operation, and the policy registry maps that operation to one registered access right
- fixed associations connect each role attribute to the allowed access rights over the Workspace object attributes
- Workspace policy, user restrictions, token restrictions, approval state, and request context remain additional policy facts

The first implementation may rebuild this small fact set per request. It must not add an authorization cache until profiling demonstrates a need.

Role checks in handlers may validate lifecycle preconditions, but they must not become a second permission engine. A handler must consume the centralized policy result rather than independently deciding that `role === owner` is sufficient.

The exact V1 product-operation and access-right identifiers are owned by `docs/specs/20260703-policy_enforcement_mapping.md`. This specification is the unique owner of the fixed product-role to access-right projection. The centralized Workspace adapter uses these exact maximum associations:

| Effective role | Maximum role association |
| --- | --- |
| Owner | `ar:workspace-read`, `ar:workspace-write`, `ar:thread-read`, `ar:turn-run`, `ar:artifact-read`, `ar:artifact-write`, `ar:review-apply`, `ar:approval-respond`, `ar:knowledge-read`, `ar:knowledge-write`, `ar:knowledge-propose`, `ar:audit-read`, `ar:workspace-configure`, `ar:workspace-export`, `ar:workspace-lifecycle`, `ar:membership-manage`, `ar:vault-use`, `ar:vault-admin`, `ar:tool-use`, `ar:tool-grant`, `ar:runtime-launch`, `ar:network-egress`, `ar:llm-gateway-use`, and `ar:repo-push`. |
| Editor | `ar:workspace-read`, `ar:workspace-write`, `ar:thread-read`, `ar:turn-run`, `ar:artifact-read`, `ar:artifact-write`, `ar:review-apply`, `ar:approval-respond`, `ar:knowledge-read`, `ar:knowledge-write`, `ar:knowledge-propose`, `ar:audit-read`, `ar:vault-use`, `ar:tool-use`, `ar:runtime-launch`, `ar:network-egress`, `ar:llm-gateway-use`, `ar:repo-push`, and `ar:workspace-leave`. |
| Viewer | `ar:workspace-read`, `ar:thread-read`, `ar:artifact-read`, `ar:knowledge-read`, and `ar:workspace-leave`. |

Invitation response is user-scoped and associated only with the exact bound invitee after the durable invitation owner validates one pending unexpired invitation; it does not require active membership and does not pass through the ordinary Workspace role resolver. Workspace leave is associated only with an active editor or viewer membership. Deployment recovery is associated only with an authenticated deployment administrator and is evaluated outside ordinary content access. The adapter may omit a conditionally eligible editor right when current policy does not grant it; it must never add a right above this table.

## Central Workspace Access Resolver

Every Workspace-addressed operation must pass through one structural resolver before request-specific Workspace content lookup, mutation, or handler consumption. Normal process boot may eagerly load the shared process-level `FsStore`; authorization does not require a lazy per-Workspace storage redesign.

```text
authenticate credential and canonical actor
  -> resolve operation metadata and target resource lineage
  -> resolve canonical Workspace registry row
  -> resolve active membership and effective role
  -> intersect credential scope and current responsible-user authority
  -> project facts into the policy kernel
  -> deny on missing or invalid facts
  -> permit request-specific Workspace lookup or mutation
  -> execute and audit
```

The server authorization metadata registry must declare whether an operation is server-scoped, user-scoped, or Workspace-scoped, how its canonical Workspace is resolved, which policy operation it maps to, and whether it mutates state. App API entries bind existing OpenAPI `operationId` values; direct Core and Gateway route registration binds explicit method-and-path keys to the same metadata owner. This registry is not the transport-neutral Agent Skill operation catalog and must not be copied into it. Authorization must not depend on ad hoc path parsing, optional request-body fields, client-side hiding, filesystem discovery, or the caller's ability to guess a UUID.

The same-release server authorization metadata registry uses these exact Workspace resolution shapes:

| Resolution shape | Authoritative resolution and required behavior |
| --- | --- |
| `actor-quick-chat-workspace` | Derive the built-in Quick Chat Workspace only from the authenticated canonical user, then require that user to be its current owner and active member. Accept no caller-supplied Workspace override; such an override is invalid input. Quick Chat is therefore a Workspace-scoped `turn.run` operation even though the Workspace identity is actor-derived. |
| `authorized-workspace-set` | Query active Core memberships for the authenticated user, intersect token bindings and mutation posture, evaluate the declared operation for each candidate, and only then load candidate Workspace content. Physical Workspace discovery and load-then-filter are prohibited. |
| `body-workspace` | Parse the exact route-owned request schema and use its required `workspaceId`; generic JSON field discovery is prohibited. |
| `gateway-metadata-workspace` | This is an optional secondary Workspace resolver on the user-scoped public Gateway operations. When present, use only the exact `metadata.openkit.workspaceId` owned by the Gateway contract and require Workspace authorization; a top-level fallback is prohibited. When absent, a session or local actor may make the existing unattributed Gateway call and receives no Workspace authorization result. A Workspace token requires matching metadata, while a `server-admin` token may call only without Workspace metadata. |
| `opaque-child-workspace` | Resolve only the globally unique child-to-Workspace lineage from the child family's existing owner before authorization. That pre-authorization read may return the Workspace id and the minimum eligibility context only; it must not return child content, mutate state, or scan response-visible records. Missing child, contradictory lineage, and unauthorized Workspace produce the same access denial. |
| `path-workspace` | Use the exact route-declared Workspace parameter, authorize it from Core registry and membership facts, and only then permit request-specific Workspace content lookup or mutation. |
| `workspace-child-lineage` | Treat the route-declared Workspace as authority, authorize it before opening storage, and then require every child identifier to belong to that Workspace. When the existing child owner can distinguish a globally missing child without scanning another Workspace, a genuinely missing child may use its normal not-found result. When the existing scoped owner cannot distinguish missing from mismatched lineage without a new global index or physical scan, both outcomes use the uniform access denial; V1 adds no lineage index solely to preserve a distinct not-found response. |

An existing in-memory or derived owner may expose a narrow child-to-Workspace lookup for `opaque-child-workspace`; Stage 4 does not authorize a new durable lineage table, global content scan, cache, or recovery owner. Approval and user-input response additionally use the durable request owner to decide the exact eligible principal. Request fields are consistency checks only and never establish decision eligibility.

Server-scoped and user-scoped catalog entries are classified mechanically but do not pass through the Workspace role adapter unless they declare an optional secondary Workspace resolver. Server operations keep their deployment-administration or route-owned bootstrap checks. Ordinary user operations require a canonical authenticated user and cannot be invoked with a Workspace or `server-admin` token unless their owning contract explicitly says otherwise. The public Gateway is the explicit exception described above. Portable import and dry-run remain user-scoped: after parsing the bounded export manifest, an export from the current deployment additionally requires `workspace.read` on its source Workspace before any source content is used; a foreign portable export has no source-deployment authority to reuse.

The public bootstrap-consume operation is server-scoped with route-owned bootstrap-secret and secure-transport authentication. Its catalog classification does not make it an authenticated deployment-admin operation and does not route it through Workspace policy.

The authorization result placed in request context is either one authorized Workspace, one authorized Workspace set, or a non-Workspace scope result. Workspace-addressed handlers must consume that result instead of reopening authorization or inferring identity. Ordinary centralized read/write checks use the low-level kernel decision transiently; missing facts and policy errors return the same access denial and do not create `defer`, a durable `PermissionDecision`, approval, workflow, Action Center row, or access-decision ledger. Existing effect owners retain only the durable decision and redacted audit obligations already named by their specifications.

When the caller lacks access, a missing Workspace, missing membership, removed membership, token mismatch, or denied policy result returns the same typed access failure without revealing target existence. After access is established, a missing child resource may return its normal not-found result only when its existing owner can establish that result without cross-Workspace discovery; otherwise the scoped-owner fallback above returns the same access denial as a lineage mismatch.

The supported NanoCore process is Core-backed and every covered Workspace operation must receive central authorization context before its handler. Private Core-less local app composition remains only as an L1 unit-test seam for isolated route logic that has no membership authority; it is not a supported deployment, L3 process path, or acceptance proof and does not authorize a server-mode or production fail-open fallback. The mechanical operation registry and Core-backed route suites must fail if a supported route omits its guard.

Collection and global search operations must construct their candidate Workspace set from active membership, token intersection, and policy. They must not list a user directory or scan every physical Workspace and filter after loading private records.

## Credential And Token Intersection

Better Auth sessions establish a human user. Workspace-scoped access tokens establish a token owner, token scope, and Workspace binding. Neither is a permission decision.

The effective authority of a Workspace token is the intersection of:

- active token status
- token scope
- token Workspace binding
- the token owner's current active membership and effective role
- current policy facts and approval state

`workspace-readonly` further caps the result to read operations. Removing or downgrading a user affects the next request without rewriting every owned token.

`server-admin` is deployment administration authority. It may manage users, tokens, configuration, migrations, and explicit Workspace recovery operations, but it does not silently bypass Workspace membership for ordinary content reads or writes. An administrator may use an audited recovery operation to transfer ownership or add themselves as a member, after which normal Workspace authorization applies.

Token administration may issue a Token to another exact active canonical `ownerUserId`. Any Workspace-bound Token issuance validates the target owner's active Workspace membership, while a session whose User owns usable `server-admin` Token authority remains an ordinary session for Workspace authorization and receives no implicit membership or content access.

A request presented with a `server-admin` credential is rejected for ordinary Workspace operations even when the token owner also has a Workspace membership. The user must present a normal session or a Workspace-bound token so the credential's authority is unambiguous.

An optional break-glass content-access design is deferred. If added later, it requires an explicit reason, bounded authority, visible audit, and a separate accepted security design.

## Canonical Storage Layout

The target physical ownership tree is:

```text
DATA_ROOT/
  server/
    db/core.sqlite
    ...
  users/
    <userId>/
      db/user.sqlite
      config/
      files/
      logs/
  workspaces/
    <workspaceId>/
      workspace-record.json
      db/workspace.sqlite
      config/workspace.jsonc
      threads/
      artifacts/
      knowledge/
      sources/
      runtime/
      reviews/
      evidence/
      logs/
      indexes/
```

`server/db/core.sqlite` owns users, Workspace registry, memberships, invitations, access-token records, server audit, migrations, and global coordination records.

`users/<userId>` owns personal preferences, user-local files, user-specific Workspace ordering, recent selection, notification state, and other state that must not become shared merely because a Workspace is shared.

`workspaces/<workspaceId>` owns all canonical Workspace data. `workspace-record.json` contains only system-owned identity, ownership relationship, lifecycle, revision, and timestamp facts; `config/workspace.jsonc` contains the shared editable Workspace name, `defaultAgentId`, and other accepted Workspace composition. Owner transfer, access-level change, membership removal, and invitation acceptance update Core records only and never copy, rename, link, or move the Workspace tree.

The user-visible Workspace list is a query over identity and policy relationships. It is not a directory listing and does not require a per-user reference file.

Canonical Workspace readers and writers must continue to reject symlinks and unsafe paths. A `share/` folder, directory link, hard link, alias, or compatibility reference tree is prohibited.

## Personal And Shared Data Boundaries

- Workspace Threads, Items, Knowledge, Artifacts, AgentSessions, approvals, policy decisions, audit, usage, repositories, data sources, and Workspace configuration are shared according to policy.
- User preferences, current Workspace selection, personal notification state, and user-local credentials remain user-scoped.
- A user's built-in Quick Chat Workspace remains owner-only and non-shareable in V1. Each server user has an independent Quick Chat Workspace and its Knowledge does not become team knowledge.
- Raw Vault secret material remains in the Vault backend. The owner manages Workspace references and grants; an editor may cause an approved agent use only when policy permits it; a viewer has no Vault-use authority.
- No per-member hidden record family is added inside a shared Workspace in V1. Truly personal state belongs to user scope.

## Actor Attribution

`docs/core/identity.md` owns the closed `ActorRef` shape and its distinction from message role, trigger source, credential type, and agent identity. This specification owns the concrete multi-user attribution projections and failure rules below.

The responsible-user derivation is exact: a `user` actor yields its own `id`, every non-human actor yields its stored `responsibleUserId`, and `null` remains `null`. No producer may replace a null result with the current Workspace owner, automation owner, current session user, or another mutable projection.

`ActorRef` and AEP scope contain no tenant, organization, credential-kind, or physical Workspace-owner field. The responsible user derived from the tagged actor is authority and accountability context only and must never select a Workspace store, database, directory, or path.

The current durable actor-attribution boundary is closed to these four families:

| Family | Unique durable authority and exact field | Lifecycle and failure semantics |
| --- | --- | --- |
| Turn trigger | The durable `Turn` record carries one required immutable `triggerActor: ActorRef`; responsible user is derived from that value. | Every new Turn copies the already-authenticated or scheduler-carried actor at creation. Portable import preserves it only as historical lineage and never as an access grant. Canonical load validates the complete Workspace file-record set before publishing any of it: a missing or invalid required Turn or Item attribution rejects that Workspace set and makes NanoCore boot or portable import fail closed rather than omitting one record or loading a partial Thread. |
| Human-authored Items | `user-message`, `approval-decision`, and `user-input-response` Items each carry one required immutable `actor: ActorRef`; no field is added to `BaseItem` or to agent/system Item variants. | A newly authored user message records its authenticated source actor. Any copy or projection of an existing user message preserves the source Item's actor and never stamps the copier or current session. Approval decisions and user-input responses require `actor.kind = user`; they also keep the winning command request ID in existing `causationId`. An Approval decision Item is a non-authoritative projection copied from the durable winning AuditEvent, never from a retrier's current session. Missing actor, invalid actor kind, or missing request lineage rejects the write and the complete Workspace record set on reload rather than inferring identity from role, text, membership, or current membership. |
| User-input eligibility | A `user-input-request` Item carries one required immutable `responsibleUserId`, copied at creation from the exact responsible-user derivation of its owning Turn's immutable `triggerActor`. | Only that same active user with current Workspace authority may answer. If derivation yields `null`, the producer returns the existing protocol-wide `recovery_required` outcome with a product-safe message naming the missing responsible user and writes no request Item or gate; it does not select another user or add a new error family. Missing or invalid persisted ownership rejects the complete Workspace record set under the same strict-load rule. V1 adds no optional-field compatibility union, owner inference, or gate takeover. |
| Policy Approval winner | The first complete terminal `PermissionDecision` for one non-null `approvalId` is the durable winner; its linked immutable Workspace `AuditEvent` is the sole authority for winning `actor`, request ID, and decision time. | A Workspace partial unique constraint permits one terminal `allow` or `deny` row per Approval. A complete winner must match the originating `require_approval` row's Workspace, `approvalId`, action, resource summary, subject summary, and approval kind; `PermissionDecision.auditEventId` must equal the linked AuditEvent id and `AuditEvent.permissionDecisionId` must equal the terminal decision id. The Workspace SQLite transaction contains exactly that terminal decision and linked audit. Existing Approval, decision Item, Turn, and command-receipt projections follow through their current owners. The same exact request may idempotently finish only deterministic projections and a notification already owned by an idempotent boundary; changed input under that request conflicts, another request returns `stale`, and an incomplete, contradictory, or unprovable tuple returns `recovery_required` without redelivery or boot scanning. Stage 6 never executes a governed runtime or external effect. |

Stage 5 already owns membership, invitation, ownership-transfer, recovery, and user-disable audit attribution. Existing Artifact Review and Goal Review owners retain their current decision-actor and conditional-write contracts and are not refactored here. Stage 7 owns only the current-authority checks and bounded attribution projections for implemented runtime and governed-effect paths; automation execution and responsibility reassignment remain with `docs/specs/20260711-scheduler_recurring_event_triggers.md`. Stage 8 owns eligible-principal read-model filtering. A non-policy Approval path without a named durable claim owner remains disabled or fails closed instead of creating another decision ledger.

Actor attribution is not added indiscriminately to immutable records that already have authoritative agent, system, or lineage identity. The goal is explainability, not a duplicated actor field on every schema.

The complete target audit contract preserves a redacted actor or subject reference, responsible user when applicable, credential/channel summary, policy decision, target resource, request ID, outcome, and time. The bounded Stage 6 Approval audit requires only actor, request ID, matching decision and target lineage, outcome, and time; credential/channel and broader producer context remain outside this slice. Display names and email addresses are projections and must not become stable actor identifiers.

No `tenantId` field is added.

## Human Attention And Decision Authority

Human gates in a shared Workspace need an eligible principal, not merely any authenticated user.

- An `ApprovalRequest` is resolved only by a subject granted `approval.respond` for the specific approval kind and resource.
- An owner may resolve owner-only sensitive approvals; an editor may resolve ordinary approvals only when the policy mapping makes that editor eligible.
- A `UserInputRequest` belongs to the immutable `responsibleUserId` recorded from its owning Turn at request creation. Answer-time authorization rechecks that same user's current Workspace authority; a later owner or automation-responsibility change does not rewrite or substitute the recorded user. Another member cannot silently answer it.
- When the responsible user is unavailable, a blocked user-input gate remains unresolved or the owning work is explicitly interrupted; V1 adds no gate-takeover workflow.
- Artifact and Workspace review decisions are available to owner and editor when policy permits them.
- Viewer access never includes decision authority.

Every terminal human decision records the winning actor and request ID before any retryable runtime delivery occurs.

## Shared-Write Concurrency

OpenKit uses four narrow concurrency patterns rather than one general collaboration mechanism.

### Append-Only History

Items, events, audit append history, and other immutable ledgers keep their existing single-writer or atomic append, monotonic sequence, request-id idempotency, and replay invariants. They do not gain a mutable revision field.

### Mutable Shared Records

Genuinely in-place shared records carry a positive monotonic `revision`. Update and delete operations require `expectedRevision` and use a conditional write equivalent to:

```sql
UPDATE record
SET ..., revision = revision + 1
WHERE id = ? AND revision = ?;
```

Zero changed rows produce the typed outcome defined by the owning transition and return only its current safe summary. The V1 families introduced here are invitation lifecycle, membership access and removal, ownership transfer, and administrator recovery. Existing Workspace create, import, metadata update, archive, delete, Artifact Review, Material revision, Workspace apply, and append-only owners retain their current transaction, first-writer, expected-base, or idempotency contracts; this specification neither moves them into the sharing transaction nor adds a generic revision framework or new mutable Artifact or Knowledge metadata commands.

The durable semantic is expected-revision compare-and-swap. A release-coupled HTTP projection may use a body field, ETag/If-Match, or another exact-release representation.

### One-Shot State Transitions

Invitation acceptance, invitation decline or revoke, membership removal or leave, ownership transfer, and Approval decisions use one database transaction and a conditional source-state or revision predicate. Another record family may use this pattern only when its owning specification explicitly names that transition.

The first winner records the actor, decision, request ID, and timestamp. Repeating the same request ID replays the result. For invitation accept, decline, or revoke, a zero-row conditional write is classified after reading the current safe invitation in this order: a terminal or effectively expired invitation returns `invitation_not_pending`; an invitation that remains pending with a different revision returns `revision_conflict`; a missing or caller-invisible invitation returns the non-enumerating access denial. A contrary or stale transition must not invoke a runtime, policy effect, or external side effect.

Membership access change, removal, and leave first classify an absent or caller-invisible membership as `workspace_access_denied` and an owner-removal or owner-leave attempt as `owner_transfer_required`. A removed membership or an active membership with a different revision returns `revision_conflict` with the current safe membership. Changing an active membership to its existing access level with the exact revision is a receipt-only successful no-op; it does not increment revision or emit another lifecycle audit event. A different request after removal conflicts rather than claiming the prior transition.

Ordinary ownership transfer requires the current owner. A missing or inactive target returns non-enumerating `workspace_access_denied`; a different current registry revision returns `revision_conflict`; targeting the current owner with the exact revision is a receipt-only successful no-op. A transfer that changes the owner increments the registry revision exactly once, promotes a viewer target to editor, and retains the former owner as editor. Central current-authority resolution precedes the command ledger, so a former owner retrying even the same transfer request after the role change receives `workspace_access_denied` and re-reads the authorized Workspace set; V1 does not add an authorization-and-idempotency recovery resolver solely to replay that historical success.

Both administrator recovery actions conditionally advance `workspace_registry.revision` exactly once when they change authority. `add-self-as-editor` inserts, reactivates, or promotes the authenticated administrator's membership and `transfer-ownership-to-self` additionally changes the owner; neither accepts another target. When recovery actually grants that administrator membership, the same transaction revokes any pending invitation for that user and Workspace before inserting or reactivating membership, so a later acceptance returns `invitation_not_pending` and cannot overwrite the recovered access level or lineage. That invitation change is part of the one recovery audit and does not create a second revoke command or receipt. A registry revision mismatch returns `revision_conflict` with `WorkspaceAccessRecoveryState`. With the exact current revision, an already achieved action is a receipt-only successful no-op; after another request wins, the stale prior revision conflicts. A missing Workspace returns the non-enumerating access denial.

Approval claims must be durable before any projection or delivery. Stage 6 finishes only deterministic Approval, Item, Turn, receipt, and already-idempotent notification projections from the stored winner. If delivery cannot be proven idempotent after a crash, the command returns `recovery_required` without redelivery, boot scanning, a delivery ledger, or a recovery workflow; governed runtime and external effects remain Stage 7 work.

### Lifecycle Command Transaction Boundary

Invitation, membership, ownership-transfer, administrator-recovery, and user-disable mutations introduced here are Core-owned. Each accepted state-changing lifecycle command writes its conditional authority mutation, immutable Core-owned lifecycle `AuditEvent`, and the existing command-idempotency receipt in one `core.sqlite` transaction. A successful already-disabled no-op writes only its new receipt. Existing Workspace create, import, metadata update, archive, and delete commands retain their owning contracts. No lifecycle command writes a second authoritative Workspace audit row or requires cross-database atomicity.

These commands reuse the C07 central idempotency contract and one existing ledger primitive: a matching receipt replays by projecting the stored resource identifier through its current owner; changed input under the same request ID returns `idempotency_key_conflict`; an exact request-owned effect without its receipt returns `recovery_required`. Replay does not reconstruct a byte-identical response, and missing-receipt handling does not infer a winner, synthesize a receipt, repeat a side effect, or create a settlement or repair workflow.

### Workspace File Apply

Worker-proposed file changes continue to use the existing snapshot, content-digest, staged-review, expected-base, conflict-preflight, and approved-apply contract. This specification does not replace that path with record revisions or live coediting.

## Workspace Lifecycle

### Create

Workspace creation stages the canonical Workspace tree and transactionally records the registry owner plus active owner membership. Publication uses coordinated cleanup so a synchronous failure does not leave an ownerless Workspace, a registry-only Workspace, or an unregistered canonical tree.

The creator always becomes the initial owner. Administrator recovery is a separate post-creation lifecycle command and cannot choose a different owner during creation.

### Invite

Only the owner may create an invitation. The target must already be an active canonical user and must not already have active membership.

Creating the invitation records proposed editor or viewer access, inviter, expiry, request ID, and audit evidence.

### Accept Or Decline

Only the bound invitee may accept or decline. Acceptance conditionally consumes one pending unexpired invitation for an active Workspace and inserts or reactivates the membership in the same transaction. A missing or inactive Workspace returns the same non-enumerating access denial and leaves both invitation and membership unchanged.

Accepted, declined, revoked, and expired invitations cannot grant access again. Rejoining after removal requires a new invitation.

### Change Access

Only the owner may change a non-owner active member between editor and viewer. The update requires the current membership revision and takes effect on the next request and governed effect boundary.

### Remove Or Leave

Only the owner may remove a non-owner member. An editor or viewer may leave through the same removed-tombstone transition.

The owner cannot remove themselves or leave while they remain owner. Ownership must be transferred or the Workspace explicitly deleted.

The first `leave` execution requires the caller's current active non-owner membership and the central `workspace.leave` policy result. Because that transition removes the fact needed by ordinary Workspace authorization, an exact duplicate request may instead replay only when its Core receipt is owned by the same canonical user and points to that user's removed membership tombstone. This bounded replay exposes no Workspace content, accepts no different request ID, and does not authorize another operation.

Removal immediately blocks new requests, new turns, new human decisions, and new governed external effects. Committed history remains visible to remaining members and retains the removed actor's stable identity.

### Transfer Ownership

Ownership transfer requires:

- the current owner
- an active target member
- a current registry revision
- one transaction that conditionally updates the owner and preserves an active membership for both users

If the target was a viewer, the transaction promotes their stored access level to editor. The former owner remains an editor. Removing that member is a separate later membership command with its own authority and revision predicate.

Transfer preserves Workspace ID, storage root, history, policy, references, exports, and worker lineage. It emits one audit event linked to the old owner, new owner, actor, request ID, and registry revision.

### Disable Or Delete User

Disabling a user follows the canonical one-way Core transition above. It revokes product access and credentials but preserves memberships, actor references, history, and ownership until an administrator resolves them.

V1 keeps Better Auth hard deletion disabled for every user regardless of ownership state. Ownership transfer or Workspace deletion resolves authority but does not enable a hidden hard-delete path.

Foreign keys from owner, membership, invitation, and durable actor references must not cascade-delete Workspace data or audit history. Privacy erasure requires a separately accepted retention and pseudonymization design; it is not implemented as raw row cascade.

### Delete Workspace

Only the current owner may delete a Workspace. An administrator without membership must first use explicit recovery to become owner, then invoke the ordinary owner-authorized deletion command. Deletion follows the storage owner's export, audit-closure, staged deletion, and recovery contract; no administrator-delete bypass exists.

User deletion never triggers Workspace deletion.

## Agent, Automation, And Integration Work

An agent acts inside one Workspace under its agent identity and one exact initiating `ActorRef`.

Scheduler admission and AEP schema version `2` worker package scope must carry one exact `triggerActor: ActorRef` and no duplicate human responsible-user field. Policy facts, audit, usage, approval eligibility, and governed effects derive the responsible user from the human actor `id` or the non-human actor `responsibleUserId`; none may use either identity as a Workspace storage locator. The current `userId` field must not continue to mean both physical store owner and accountable actor.

### Current-Authority Predicate

Every implemented Stage 7 boundary uses one stateless `currentWorkspaceAuthority(workspaceId, actor, productOperation, effectAuthority)` predicate immediately before the NanoCore-owned effect. The predicate derives the responsible user only from `actor`, then requires that user to be non-null and currently `active`, an active member of the exact Workspace, entitled by the current fixed-role mapping to `productOperation`, and allowed by current policy. `effectAuthority` is the existing owner-specific Approval, PermissionDecision, VaultGrant, review, or resource tuple when that boundary already requires one; the caller validates that tuple before passing the predicate, and the predicate does not become a second owner-aware policy engine. The tuple must be complete, target-matching, current-deployment authority and cannot replace the user, membership, role, or policy checks. For Vault use, the durable VaultGrant is the effect-authority owner: it must be target-issued and active, and every non-null user, Workspace, agent, AgentSession, and capability constraint must exactly match the current execution. Its optional Approval and policy-decision identifiers are immutable issuance lineage rather than use-time decision owners; when an Approval id is present it must be target-issued and the policy-decision id must be non-null, but effect execution does not re-run or reconstruct that workflow. A null responsible user, missing or contradictory fact, removed membership, disabled user, insufficient current role, denied policy, or stale effect authority denies with zero governed effect. The predicate reads current Core and owning-domain authority directly for the small single-writer deployment and adds no cache, durable decision row, state, workflow, or recovery owner.

The immutable `AEP.scope.triggerActor` is the sole runtime actor authority. Scheduler, lease, worker-control, capability, usage, audit, and runtime-evidence records may link to the Turn, AgentSession, or AEP snapshot and may copy the derived responsible user only where their owning schema requires attribution; they must not duplicate another `ActorRef`, select a replacement actor, or become current-authority records.

### Stage 7 Effect Boundaries

| Boundary | Product operation and authority actor | Exact failure and successor rule |
| --- | --- | --- |
| Turn admission and scheduler launch | `runtime.launch`; the immutable Turn/AEP `triggerActor`. | Deny before a new admission, lease, sandbox token, or worker launch. An already-created product Turn uses its existing denied or `interrupted` owner outcome; Stage 7 adds no state. |
| NanoCore-mediated active-worker capability, LLM, or external call | `tool.use`, `llm.gateway.use`, or `network.egress` as owned by the concrete call; the AEP `triggerActor`, or the authenticated actor for a separately submitted Gateway request. | Deny before upstream contact, secret resolution, or capability dispatch. Existing CapabilityCall, UsageRecord, AuditEvent, Turn, and AgentSession owners may record their already-defined denied or interrupted projection only. |
| Worker Artifact or Workspace-content publication | `artifact.write` or `workspace.write`; the AEP `triggerActor` until a separate fresh human command owns promotion. | Do not create or advance canonical Workspace content. Worker output, manifests, and Workspace Synchronization reconciliation evidence may remain inspectable but non-authorizing. |
| Workspace Sync approved apply | `review.apply`; the authenticated actor of the fresh apply request plus the exact pending Workspace Sync Review, requested `accepted` decision, and apply preconditions. | The original worker `triggerActor` remains lineage only. A fresh currently authorized actor may apply the reviewed output under its own new request; denial performs no strategy mutation or successful apply write and leaves the Review pending. |
| Vault-backed use | `vault.use`; the authenticated request actor or AEP `triggerActor`, current Workspace policy, and the exact active target-matching target-issued VaultGrant. Optional Approval and PermissionDecision ids are structurally validated issuance lineage only. | Deny before material leaves the Vault backend or an injection sink is invoked. Existing redacted failed VaultUse/Audit evidence may be written; it is not effect authority. |
| Host Git push | `repo.push`; the authenticated actor of the fresh push execution request plus the existing target-issued Approval and matching allow PermissionDecision. | The producing worker actor remains lineage only. A fresh currently authorized actor may execute under its own request; denial occurs before Vault resolution and the Git runner and may use only the existing `refused-policy` record outcome. |

Fresh apply and push requests do not reactivate or rewrite stale actor authority. Their current authenticated actors become the authority for those new commands, while the original Turn actor and worker evidence remain immutable historical lineage. For Workspace Sync apply, the route validates the exact pending Review and target, then checks current authority before handing the accepted command to the existing serialized filesystem or Git apply owner. That owner may finish the accepted command if membership changes after handoff; revocation applies at the next owner boundary. V1 does not add an inner authorization callback, cross-owner lock, rollback protocol, or settlement workflow to close this bounded race.

### Bounded Worker-Native Compromise

NanoCore cannot atomically revoke an external effect already invoked after a successful check, and an already-running sandbox may hold immutable AEP network rules or runtime-file/runtime-environment credentials whose individual worker-native requests do not traverse NanoCore. Stage 7 therefore guarantees that a failed current-authority check permits no new NanoCore-mediated upstream call, secret resolution, Workspace publication, approved apply, or Git push. A request already submitted to an external system may finish, and worker-native activity may continue until the next NanoCore or worker-control boundary detects lost authority. Detection revokes the affected route or grant and terminates that sandbox through the NanoHost; if deletion cannot be proved, the NanoHost invalidates the complete Runtime Epoch and holds capacity until fresh-empty readiness. From detection forward NanoCore accepts only non-authorizing evidence and publishes no output from the stale authority. Cleanup never proves recall of already exposed material. This bounded race is explicit; Stage 7 adds no dynamic credential revocation protocol, mutable AEP, quarantine state, recovery workflow, or claim that every in-flight external request can be cancelled.

The current automation facade is an in-memory definition store with no executor, so it has no Stage 7 background effect to reauthorize. Stage 7 does not add Workspace automation ownership, responsible-user reassignment, schedule/fire records, persistence, pause state, or an executor. The automation replacement design and its current-authority check belong entirely to `docs/specs/20260711-scheduler_recurring_event_triggers.md`; until that work lands, automation definitions remain non-executing and are not Stage 7 acceptance evidence.

## Search, Action Center, And Notifications

- Workspace lists and global search use the authorized Workspace set before reading results.
- Search results never include a Workspace removed from the user's current membership or token intersection.
- Action Center filters pending decision rows to the requesting user who can currently act: Approval rows require current `approval.respond` authority and their existing active source/Gate tuple; user-input rows require the exact stored `responsibleUserId` plus current `turn.run` authority; Artifact, Goal, Knowledge, and Workspace Sync review rows require current `review.apply` authority. Eligibility is computed while reading the projection and is not a new durable field, returned principal object, assignment record, or notification owner. Existing runtime/recovery, agent-readiness, contradictory-owner inspection, shared history, and non-actionable Workspace-status rows retain their current read and mutation owners; Stage 8 neither assigns them to a principal nor promotes an inspection row into decision authority.
- A user sees personal notifications in user scope and shared work state through Workspace scope.
- Membership removal clears future personal projections without deleting shared history.
- Product surfaces show actor attribution for user messages, approvals, reviews, membership changes, and ownership transfer.

## Export, Import, Backup, And Restore

Portable Workspace export contains Workspace-owned product truth but excludes deployment-local access relationships:

- do not export active memberships, removed membership tombstones, invitations, auth sessions, access tokens, personal preferences, or user-local notification state as target access authority
- retain stable actor references in history and audit as non-authority lineage
- do not treat source owner or actor IDs as target access grants
- import the authenticated importing user as the new owner and only active member
- require target-side invitations to share the imported Workspace
- keep imported Vault references unbound and repository resources target-bound as defined by their owners; portable non-secret VaultGrant rows remain reminted historical evidence in the reserved imported namespace and cannot authorize target use

Portable export preflight rejects a Workspace that contains any unresolved `user-input-request` before creating an export root or manifest. The V2 verifier and importer independently reject any input that nevertheless contains one, including input from another implementation or deployment. Product-safe diagnostics identify the blocking Item ids. Completed historical request and response Items retain source actor and responsible-user lineage, but target authorization never derives from those source identifiers. Full data-root backup is not subject to this portable-export restriction because it restores the same deployment authority records.

A full data-root backup includes the Core database and therefore preserves users, memberships, invitations, and owner relationships when restored as the same deployment. Portable Workspace export and full deployment backup are distinct contracts.

## Current Implementation Projection

The following foundation is already implemented:

- Better Auth email/password users and session authentication
- implicit local user behavior for local mode
- opaque `okt_` tokens with `server-admin`, `workspace`, and `workspace-readonly` scopes
- top-level owner-independent `workspaces/<workspaceId>` storage, one shared process-level Workspace store, and a stopped-process one-way migration from the predecessor owner-nested layout
- Workspace registry with one owner, active/removed membership rows, stored editor/viewer access levels, restrictive user references, positive revisions, invitation tables, and owner-integrity guards
- one exact product-operation registry covering App API and direct Core/Gateway routes, with fixed owner/editor/viewer policy projection and the seven accepted Workspace resolver shapes
- per-request authentication followed by centralized active-membership, effective-role, token-binding, read-only posture, and policy checks
- candidate-first authorized Workspace collections, idempotent local-boot or active-session provisioning plus actor-derived owner-only Quick Chat resolution, and uniform non-enumerating Workspace access denial
- handler-owned child-lineage checks that retain global not-found only when an existing owner can prove it, otherwise collapsing scoped missing and mismatch to the documented access denial
- explicit denial of `server-admin` credentials on ordinary Workspace content operations and exact same-deployment source-membership checks before portable import collision or content reads
- the fifteen-operation App API sharing surface, including authenticated invitee discovery and decisions, owner invitation/member management, non-owner leave, ordinary owner transfer, content-free administrator recovery, and one-way user disable
- one Core transaction for each accepted lifecycle authority mutation, immutable actor/subject/revision audit, and pointer-only command receipt, with receipt-only exact no-ops and `recovery_required` for a request-proven effect lacking its receipt
- direct invitation, membership, ownership-transfer, and administrator-recovery conditional writes with the exact terminal, stale, missing, disabled-user, inactive-Workspace, re-invitation, Quick Chat, and recovery/invitation interleaving semantics above
- next-request session and token rejection for disabled users through stock Better Auth hooks and the shared canonical active-user predicate
- one existing-harness server-mode restart path proving accepted membership persistence and next-request denial after removal
- same-deployment export privacy checks
- NGAC-aligned policy-kernel elements, assignments, associations, operations, and fail-closed evaluation
- request-id idempotency, append-only history, storage link rejection, and conflict-checked Workspace apply
- immutable Turn `triggerActor`, actor attribution on the three named human-authored Item families, exact user-input responsibility, and one terminal policy-originated PermissionDecision plus winning actor/request AuditEvent before deterministic Approval projection
- one stateless current-authority predicate over current canonical user, membership, fixed role, policy, and caller-validated effect authority, applied at implemented runtime admission/materialization/launch, Gateway, AEP Vault, worker publication, Workspace Sync apply handoff, and Git-push boundaries
- Workspace-attributed UsageRecord responsible-user projection and transient Gateway actor context without a second runtime actor, decision cache, recovery workflow, or executable automation owner
- the explicit bounded apply-handoff and already-submitted worker-native compromises above, with stale publication rejected at the next NanoCore or worker-control boundary
- current-authority-first Workspace list and search candidates plus request-time Action Center and dashboard eligibility for policy Approval, exact-responsible-user input, Artifact Review, Goal Review, Knowledge Review, and Workspace Synchronization Review rows without a new assignment or notification owner
- owner-only Workspace Vault reference metadata and rebind access under `vault.admin`, redacted VaultUse history under `audit.read`, and use-time enforcement of the exact current target-issued grant plus `vault.use`
- portable import that treats source users, owners, memberships, invitations, tokens, grants, and actor lineage as non-authorizing and installs only the importing user as target owner/member, while full same-deployment backup preserves the complete Core relationship graph
- all fifteen sharing operations in the Core Client with the same App API schemas and typed conflicts, plus the eleven bearer-reachable operations in the transport-neutral catalog, bundled CLI, and unified Skill
- the four session-capable own-invitation list, accept, decline, and exact own-receipt leave operations retained as the explicit CLI/Skill known-partial above instead of adding a second credential system

The rebuilt multi-user Web projection is intentionally deferred to S10. Shared schema and App API changes receive the minimum existing-Web compilation and runtime alignment required for same-release correctness, but this specification's implemented kernel, public contract, Core Client, CLI, and Skill scope adds no temporary multi-user UX or browser acceptance obligation.

The existing non-Web multi-user responsibility is implemented: owner-independent storage and migration, centralized request-time authorization, sharing and user lifecycle, bounded attribution and first-writer closure, governed-effect reauthorization, authorized read projections, Vault and portability boundaries, the `workspace-record.json` plus `config/workspace.jsonc` split with joined public name projection, and the exact-release Core Client plus bearer-reachable CLI/Skill projection. The four named session-only CLI/Skill omissions remain an accepted bounded projection compromise, and the rebuilt Web remains separately owned by S10.

## Impacted Implementation Surfaces

| Surface | Required change |
| --- | --- |
| `packages/protocol` | Add the smallest durable actor and responsible-user attribution needed by user Items, Turn triggers, decisions, and audit. |
| `packages/app-api-schemas` | Add release-coupled member, invitation, transfer, leave, expected-revision, and authorized Workspace read models. |
| `packages/policy-kernel` and policy mapping | Reuse the kernel; add fixed role fact and product-operation mappings without a second engine. |
| NanoCore Core DB | Migrate registry and membership constraints; add invitations, access levels, revisions, and lifecycle indexes. |
| NanoCore storage | Move canonical roots and Workspace databases to top-level Workspace scope; remove user-owned routing. |
| NanoCore auth and routes | Replace path/body heuristics and request-user stores with centralized operation and resource resolution. |
| Scheduler, AEP, worker control, Gateway | Keep AEP `triggerActor` as the sole runtime actor authority, derive responsible-user authority independently from owner-free storage resolution, and reauthorize only the implemented governed effects named above. |
| Audit, permission, approval, Action Center | Persist actor attribution, eligible principals, and atomic terminal claims. |
| Search and Quick Chat | Derive shared visibility from membership and keep Quick Chat owner-only; automation replacement remains with the recurring-trigger specification. |
| Export, import, backup, restore | Exclude deployment-local membership, invitation, token, and user access authority from portable export; preserve reminted Vault and effect rows only as non-authorizing history; assign the import owner; preserve full-backup identity state; and migrate paths. |
| Core Client, operation catalog, CLI, Skill | Project the complete same-release sharing lifecycle and typed conflicts without creating stable cross-release API promises. |
| Existing Web baseline and rebuilt Web | Keep the existing baseline compiling and consuming changed shared schemas correctly in the same release; add member and invitation management, role visibility, actor labels, conflict UX, and owner-transfer safeguards only in the post-program S10 rebuild. |

## One-Way Storage And Schema Migration

The migration is offline, explicit, one-way, and internal-development only. Its invocation owner is one thin dedicated stopped-process operator CLI. The CLI invokes this procedure directly; it is not a boot phase, a restore mode, a reusable migration runner, or a test harness.

### Preconditions

- Stop NanoCore product writes and worker admission.
- Require no live worker lease, active apply, or non-terminal storage publication that depends on an owner-scoped root.
- Verify the current layout marker and every canonical path.
- Reject symlinks, unsafe paths, unknown layout versions, duplicate global Workspace IDs, missing registry owners, conflicting owners, and missing owner membership.
- Verify every registry Workspace maps to exactly one existing `users/<ownerUserId>/workspaces/<workspaceId>` tree.

### Prepare

1. Before changing `DATA_ROOT`, create and verify one complete predecessor `DATA_ROOT` cold backup outside `DATA_ROOT`, including the Core database, layout marker, every owner-scoped Workspace tree, and their exact inventory and digests.
2. Create or update the one migration report under the existing server migration owner; it is evidence for the thin procedure, not a lifecycle, retry, resume, or recovery authority.
3. Copy every canonical Workspace tree into one migration-owned same-filesystem staging root shaped as the complete future `workspaces/` tree.
4. Verify exact file inventory, sizes, and digests before publication.
5. Open each staged Workspace database and apply the new Workspace-scope schema without a user owner parameter.
6. Build the Core DB migration that adds access levels, invitations, revisions, restrictive foreign keys, and owner membership invariants.
7. Classify current `userId` fields as responsible-user context, user-private ownership, or obsolete physical owner and rewrite them deliberately.

### AEP Snapshot Identity Cutover

Only after every Workspace opener and store resolver uses `workspaceId` without a user or responsible-user storage parameter, the stopped-process CLI applies the exact [AEP V2 Identity Cutover](./20260616-agent_environment_package.md#aep-v2-identity-cutover) to every staged `runtime/agent-sessions/<agent-session-id>/aep-snapshots/<snapshot-id>.json` record. The migration-only transform rewrites valid V1 human or automation scope identity into the required `triggerActor`, removes the legacy user, automation, and organization scope fields, advances the package to schema version `2`, recomputes and records snapshot digests, and blocks publication on any invalid record. Normal runtime, restart, ledger, export, and import readers accept only schema version `2`; no V1 union, alias, fallback lookup, or compatibility reader survives publication.

### Publish

1. Publish the complete verified staged `workspaces/` root through one same-filesystem rename; do not publish Workspace roots one at a time.
2. Apply the Core DB transaction and record the new registry and membership revisions.
3. Verify every target tree and Core constraint, then remove the predecessor owner-nested Workspace trees from `DATA_ROOT`; their verified cold backup remains the rollback evidence.
4. Advance the data-root layout marker only after the target and Core verification succeeds and no owner-nested Workspace tree remains inside `DATA_ROOT`.
5. While the CLI still owns the stopped process, call the same integrity and derived-index rebuild functions used by normal boot directly, then verify Workspace reads through the new resolver. The CLI does not run the boot phase runner, bind a listener, or introduce a verification-boot mode; the next ordinary boot independently validates the accepted v2 layout without invoking or resuming migration.
6. Retain the verified external cold backup until post-migration L3 and L5 verification succeeds and the migration report has been reviewed.
7. Delete that external backup only through an explicit cleanup step, and record the predecessor-to-successor inventory and digest mapping in the migration report.

### Failure And Stop Rule

If preflight, backup, copy, digest verification, schema migration, publication, Core transaction, marker publication, or verification fails, NanoCore must not accept product work under a predecessor, mixed, or partially published layout. Before root publication it removes only migration-owned staged output. After the one root rename, a failure leaves the published target, the predecessor marker when it has not advanced, and the verified external cold backup for explicit repair or restore; it does not compensate through a dual reader or infer recovery from the report. The representative partial-publication regression is this single window between root publication and accepted Core-plus-marker completion, not a crash-point matrix.

The migration report records the failed stage as evidence but is never consulted to resume, retry, or choose recovery. No symlink, reference directory, fallback lookup, dual-path reader, or owner-nested Workspace tree remains inside a v2 `DATA_ROOT` after the new layout marker is accepted.

## API And Product Operations

The exact routes and payloads are release-coupled, but the supported behavior must include:

- list current user's authorized Workspaces
- read effective role and member summary
- list owner-visible members and invitations
- create invitation for a registered user
- list the authenticated user's own invitations without a Workspace membership or user filter
- accept or decline own invitation
- revoke pending invitation
- change editor/viewer access with expected revision
- remove member with expected revision
- leave Workspace
- transfer ownership with expected registry revision
- perform explicit administrator recovery without implicit content access
- disable one exact user through deployment-admin authority while preserving identity and history
- return typed access, invitation, terminal-state, and revision conflicts

The Core Client, operation catalog, bundled CLI, and unified Skill project the same operation owners and error semantics in the current program. The rebuilt Web projection must consume those owners in S10 before its release; no temporary Solid implementation is required.

### Exact Release-Coupled Sharing Projection

The current release uses one closed App API projection over the durable registry, membership, and invitation owners. `AuthorizedWorkspaceSummary` contains exactly the protocol `workspace` record, `ownerUserId`, `effectiveRole`, positive `registryRevision`, and positive `membershipRevision`; the latter lets a non-owner issue `leave` without a separate member lookup. `WorkspaceMember` contains exactly `workspaceId`, `userId`, durable `status`, stored `accessLevel`, nullable `effectiveRole`, nullable `invitationId`, `joinedAt`, nullable `removedAt`, positive `revision`, `createdAt`, and `updatedAt`. An active member has a non-null effective role; a removed member has `effectiveRole=null`; an effective owner is active and has stored `accessLevel=editor`.

`WorkspaceInvitation` contains exactly `invitationId`, `workspaceId`, `inviteeUserId`, `proposedAccessLevel`, `inviterUserId`, release-projected `effectiveStatus`, `expiresAt`, nullable `acceptedAt`, `declinedAt`, and `revokedAt`, positive `revision`, `createdAt`, and `updatedAt`. `effectiveStatus` is `pending`, `expired`, `accepted`, `declined`, or `revoked`; `expired` is projected from a durable pending row whose deadline has passed and does not create another durable lifecycle state. Exactly the timestamp matching an accepted, declined, or revoked status is non-null, while pending and expired projections keep every terminal timestamp null.

Every sharing mutation carries `requestId`. Invitation acceptance, decline, and revocation carry the invitation's positive `expectedRevision`; membership access change, removal, and leave carry the membership's positive `expectedRevision`; ownership transfer carries `targetUserId` and positive `expectedRegistryRevision`. Creation carries exact `inviteeEmail` and `proposedAccessLevel` but no invented registry-wide revision. Membership access change additionally carries the target `accessLevel`. User disable carries only `requestId` because its one-way conditional `active -> disabled` transition has no mutable follow-up state in V1. The former owner remains an editor after ordinary transfer and is removed only by a later explicit member mutation.

Explicit deployment recovery has exactly two current actions: `add-self-as-editor` and `transfer-ownership-to-self`. Both carry `requestId` and positive `expectedRegistryRevision`; the authenticated administrator user is the target and cannot name another target user. Transfer-to-self atomically creates or reactivates the administrator's editor membership when necessary before changing registry ownership. This is an audited recovery operation, not ordinary content access, a hidden administrator role, or a general recovery workflow.

`WorkspaceAccessRecoveryState` is the only administrator-safe read model for this operation and contains exactly `workspaceId`, `ownerUserId`, nullable `administratorRole`, and positive `registryRevision`. `administratorRole` is the authenticated administrator user's current effective `owner`, `editor`, or `viewer` role, or `null` when they have no active membership. It exposes no Workspace record or content projection.

Invitation mutations return `{ invitation }`; membership mutations return `{ member }`; ownership transfer returns `{ workspace }`; explicit recovery reads and mutations return `{ recovery }`; user disable returns `{ user }` with exactly `userId`, `status=disabled`, and `disabledAt`. Authorized Workspace, member, owner-visible invitation, and authenticated-user invitation collection responses contain only `items`. Callers may re-read the applicable collection after a successful mutation; the response need not reconstruct an earlier byte-identical HTTP body beyond the central idempotency contract.

The domain-specific release-coupled sharing error codes are exactly `workspace_access_denied`, `invitee_unavailable`, `invitation_not_pending`, `revision_conflict`, `quick_chat_not_shareable`, and `owner_transfer_required`. They reuse the protocol `ApiError` envelope and remain additional to C07's protocol-wide `idempotency_key_conflict` and `recovery_required` outcomes. Access denial, unavailable invitee, Quick Chat rejection, and owner-transfer-required errors expose no target details. `invitation_not_pending` carries the current safe invitation projection. `revision_conflict` carries a discriminator for `workspace`, `membership`, `invitation`, or `workspace_recovery` plus the matching current safe summary; `workspace_recovery` returns only `WorkspaceAccessRecoveryState`. No generic cross-record conflict framework or broader recovery payload is introduced.

The exact V1 operation surface is closed as follows:

| Operation | Method and route | Access owner | Success projection |
| --- | --- | --- | --- |
| `listAuthorizedWorkspaces` | `GET /api/app/workspaces` | authorized Workspace set; `workspace.read` | `{ items: AuthorizedWorkspaceSummary[] }` |
| `listWorkspaceMembers` | `GET /api/app/workspaces/{workspaceId}/members` | Workspace path; `membership.manage` | `{ items: WorkspaceMember[] }` |
| `listWorkspaceInvitations` | `GET /api/app/workspaces/{workspaceId}/invitations` | Workspace path; `membership.manage` | `{ items: WorkspaceInvitation[] }` |
| `createWorkspaceInvitation` | `POST /api/app/workspaces/{workspaceId}/invitations` | Workspace path; `membership.manage` | `201 { invitation }` |
| `listMyWorkspaceInvitations` | `GET /api/app/workspace-invitations` | canonical session or implicit local user | `{ items: WorkspaceInvitation[] }` |
| `acceptWorkspaceInvitation` | `POST /api/app/workspace-invitations/{invitationId}/accept` | bound canonical session or implicit local user; `invitation.respond` | `{ invitation }` |
| `declineWorkspaceInvitation` | `POST /api/app/workspace-invitations/{invitationId}/decline` | bound canonical session or implicit local user; `invitation.respond` | `{ invitation }` |
| `revokeWorkspaceInvitation` | `POST /api/app/workspaces/{workspaceId}/invitations/{invitationId}/revoke` | Workspace child; `membership.manage` | `{ invitation }` |
| `changeWorkspaceMemberAccess` | `PATCH /api/app/workspaces/{workspaceId}/members/{userId}` | Workspace child; `membership.manage` | `{ member }` |
| `removeWorkspaceMember` | `POST /api/app/workspaces/{workspaceId}/members/{userId}/remove` | Workspace child; `membership.manage` | `{ member }` |
| `leaveWorkspace` | `POST /api/app/workspaces/{workspaceId}/leave` | canonical session or implicit local user; current `workspace.leave` or exact own-receipt replay | `{ member }` |
| `transferWorkspaceOwnership` | `POST /api/app/workspaces/{workspaceId}/ownership/transfer` | Workspace path; `workspace.lifecycle` | `{ workspace }` |
| `getWorkspaceAccessRecoveryState` | `GET /api/app/workspaces/{workspaceId}/access-recovery` | deployment administrator; `deployment.recover` | `{ recovery }` |
| `recoverWorkspaceAccess` | `POST /api/app/workspaces/{workspaceId}/access-recovery` | deployment administrator; `deployment.recover` | `{ recovery }` |
| `disableUser` | `POST /api/app/users/{userId}/disable` | deployment administrator; `api.call` | `{ user }` |

The App API and Core Client expose all fifteen operations. The existing bearer-token-only CLI and unified Skill project only the operations reachable through their current credential contract. `listMyWorkspaceInvitations`, `acceptWorkspaceInvitation`, `declineWorkspaceInvitation`, and the exact own-receipt form of `leaveWorkspace` remain session-capable App API and Core Client operations in the current projection and are an explicit known-partial for the CLI and Skill; the current baseline does not add a Better Auth bearer plugin, persist session cookies in the CLI, or create another user-token system to close that presentation gap.

## Testing Strategy And Acceptance Criteria

Each invariant is proved once at the lowest sufficient layer. Higher-layer coverage is added only for a distinct integration risk; this specification does not authorize a cross-product matrix, a crash-point matrix, a reusable migration runner, or a dedicated acceptance harness. The stopped-process CLI above is only the narrow invocation surface for this one migration and does not become such a runner.

### L0 Static And Repository Checks

- Active docs agree on owner-independent Workspace scope and exact-release API posture.
- Every workspace-scoped operation declares its scope resolver and policy operation.
- Public schemas contain no `tenantId`, organization role, raw invitation secret, physical user-owner path, or private storage handle.
- No code path creates or follows a Workspace sharing link.

### L1 Package And App Tests

- Registry owner, active owner membership, restrictive foreign keys, access enums, invitation uniqueness, expiry, and transition constraints.
- Fixed owner/editor/viewer policy mappings and denial for every missing operation or fact.
- Token, membership, role downgrade, removal, and server-admin separation.
- Actor attribution and AEP schema version `2` tests accept the exact tagged `ActorRef`, reject legacy scope identity fields, and prove responsible-user derivation without storage ownership.
- Registry, membership, and invitation compare-and-swap success, stale conflict, retry, and zero-row handling.
- Durable first-writer approval and invitation transitions under concurrent requests.
- Quick Chat non-shareability and the absence of any executable current automation effect path.
- One table covers the exact current-authority predicate and six Stage 7 boundary mappings without multiplying user, role, effect, restart, or backend combinations.
- One existing runtime fixture removes or disables the AEP responsible user after launch, proves the next NanoCore-mediated effect and publication are rejected through the existing interrupted or denied owner, and treats any already-submitted worker-native request as the documented bounded compromise.

### L2 Contract And Conformance Tests

- Every public Workspace operation uses shared schemas and the central access resolver.
- A two-user fixture proves one canonical Workspace root and identical durable history.
- One table-driven owner/editor/viewer policy matrix covers the supported operation families without repeating it at higher layers.
- Portable export excludes access relationships and import creates only the target owner membership.
- Actor and responsible-user lineage survives export/import without becoming authority.

### L3 NanoCore Black-Box Tests

- One Core-backed two-user process scenario uses public session and App API operations to prove invitation discovery and acceptance, process restart, owner removal, and a typed non-enumerating denial on the removed user's next request.
- Viewer, shared-write, `server-admin`, conditional-winner, actor, owner-transfer, and governed-effect predicates remain in the deterministic L1-L2 tables and focused reload tests; L3 does not repeat them or combine them into another scenario.

### L4 Web Browser Tests — deferred to S10

- The rebuilt Web projection later proves authorized Workspace switching, member lifecycle, actor labels, typed conflict handling, and viewer affordances through the already accepted public contract.

### L5 Smoke And Artifact Health

- The stopped-process migration fixture proves V1 human and automation AEP transformation, digest-valid V2 records, top-level publication, V2-only readers, and reviewed external-backup/report evidence; built NanoCore smoke separately proves the packaged server starts and serves public operations on the current layout.
- Generated OpenAPI, Core Client, operation catalog, CLI, and Skill artifacts share one exact contract identity.
- Focused portable export/import artifact coverage proves new target ownership and no imported memberships or invitations; it is not coupled to the process lifecycle story.

### L6 Agentic Story Acceptance

- The current multi-user baseline adds no new agentic story. The accepted progressive-discovery story proves only that a real Agent can reach the unified Skill, discover and describe an operation, call the bundled CLI, and confirm durable readback.
- The release acceptance bundle combines that existing Agent/Skill reachability evidence with exact-release catalog and artifact checks for every bearer-reachable sharing operation, the Core-backed two-user L3 invitation/restart/removal path, and deterministic L1-L2 actor-lineage plus current-authority regressions. None of these evidence classes substitutes for another.
- The L3 path MUST use two canonical users and public session or App API operations to create, invite, discover, accept, restart, remove, and observe a typed non-enumerating denial on the removed user's next request. Deterministic attribution checks MUST preserve the initiating editor's immutable `triggerActor` and responsible-user lineage and the owner's distinct review or decision actor with its existing durable decision and audit linkage.
- At least one runtime-publication regression MUST revoke or disable the responsible user after worker output exists but before Artifact or Workspace publication, then prove a typed denied or interrupted outcome and zero publication. At least one irreversible-effect regression MUST remove authority after preflight but before the effect and prove that the existing provider, Vault, Git, or equivalent effect owner is not invoked. The exact current-authority table MUST continue to fail closed for a missing, removed, disabled, null-responsibility, insufficient-role, policy-denied, or missing-effect-authority tuple.
- An already-submitted worker-native request may finish until the next governed check, but its result is non-authorizing evidence and permits no later NanoCore-mediated effect or Workspace publication. Because this package adds or materially revises no L6 story, the repeated-run admission rule in S06 is not triggered.

## Alternatives Considered

### Keep Workspaces Under The Owner And Add Links

Rejected because owner transfer would require path mutation, every reader would need alias resolution, backup and deletion would have two authorities, and canonical readers already reject symbolic links.

### Add A Shared Folder With Reference Files

Rejected because a reference directory becomes a second membership database with stale-link, authorization, cleanup, and information-leak problems. Core DB membership already provides the correct index.

### Copy A Workspace Into Each User Directory

Rejected because copies require synchronization, conflict resolution, duplicated secrets and audit, and ambiguous ownership. Shared users must open one canonical Workspace.

### Use Better Auth Organization Plugin

Rejected because it adds Organization, Team, active-organization session state, member tables, invitation tables, and a second role/permission engine that duplicate OpenKit Workspace and policy owners.

### Add A Separate RBAC Engine

Rejected because fixed product roles can be projected into the existing NGAC-aligned kernel. Two authorization engines would drift on every operation.

### Directly Add Members Without Acceptance

Rejected as the default because invitation acceptance preserves consent, explicit lifecycle, and audit. Explicit deployment recovery may add or transfer a member through a separate administrative operation.

### Add Bearer Invitation Links In V1

Deferred because the current system has no secure delivery owner and agent-visible product surfaces must not expose invitation credentials. Registered-user in-product invitations satisfy the present small-team need with less security machinery.

### Let Server Admin Read Every Workspace

Rejected because deployment administration and Workspace content authority are different responsibilities. Recovery should be explicit and audited.

### Add CRDT Or Real-Time Coediting

Rejected because current shared work needs append ordering, narrow record revisions, and conflict-safe file apply, not a general collaboration substrate.

## Consequences

- Sharing becomes a database and policy relationship rather than a filesystem feature.
- Owner transfer is cheap and does not touch canonical data.
- Existing user-nested storage requires one deliberate migration before release.
- Better Auth remains replaceable and does not become the product authorization model.
- Fixed roles remain easy to explain while the policy kernel preserves one authority path.
- Shared work gains explicit actor and concurrency contracts.
- Portable Workspace export remains portable because it does not carry target deployment access grants.
- Pre-account invitation links, email delivery, custom roles, and real-time coediting remain absent until concrete requirements appear.

## Risks And Mitigations

- Risk: authorization is missed on one route. Mitigation: operation metadata and one central resolver are mandatory, with L0 route coverage and multi-user IDOR tests.
- Risk: owner and membership drift. Mitigation: one canonical owner FK, active owner membership invariant, restrictive deletion, and transactional transfer.
- Risk: migration leaves mixed paths. Mitigation: offline preflight, exact staging verification, layout marker last, source retention, and no product boot on partial state.
- Risk: role checks drift outside the policy kernel. Mitigation: fixed role-to-NGAC mappings and tests that handlers consume policy decisions.
- Risk: removed users still act through tokens or workers. Mitigation: intersect current membership on every NanoCore request and governed effect, interrupt stale responsible-user sessions at the next governed boundary, reject their publication, and retain the explicit in-flight worker-native compromise above.
- Risk: two users overwrite shared state. Mitigation: revision compare-and-swap only on mutable records and existing expected-base file apply.
- Risk: two users resolve one approval. Mitigation: durable first-writer claim before runtime delivery.
- Risk: invitation target enumeration leaks users. Mitigation: exact-email input, no directory endpoint, and one `invitee_unavailable` result.
- Risk: actor fields leak personal data. Mitigation: stable IDs only in durable records; names and emails remain redacted projections.

## Open Questions

None for V1. Pre-account invitations, verified-email delivery, break-glass access, custom roles, real-time coediting, multi-tenancy, and cross-deployment collaboration require separate accepted designs if concrete demand appears.

## Deferred Work

- Pre-account invitation links with random one-time secrets, hash-only storage, verified-email binding, secure delivery, rotation, and rate limits.
- Custom roles, groups, nested teams, role hierarchy, and delegated member administration.
- Guest or public sharing.
- Presence, real-time coediting, CRDT, and operational transformation.
- Break-glass Workspace content access.
- User privacy erasure and pseudonymization beyond disable and stable historical identity.
- Enterprise account provisioning, SSO, SCIM, and legal tenant isolation.
- Federation, P2P, and cross-deployment collaboration.

## External References

- [Better Auth Organization Plugin](https://better-auth.com/docs/plugins/organization)
- [Better Auth User And Account Deletion](https://better-auth.com/docs/concepts/users-accounts#delete-user)
- [NIST Revised Model For Role-Based Access Control](https://doi.org/10.6028/NIST.IR.6192)
- [NIST Policy Machine Specification](https://doi.org/10.6028/NIST.IR.7987r1)
- [NIST Policy Machine Overview](https://csrc.nist.gov/Projects/policy-machine)
- [OWASP Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html)
- [OWASP Insecure Direct Object Reference Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Insecure_Direct_Object_Reference_Prevention_Cheat_Sheet.html)
- [OWASP Forgot Password Token Guidance](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)
- [SQLite Foreign Key Support](https://www.sqlite.org/foreignkeys.html)
- [SQLite Transactions](https://www.sqlite.org/lang_transaction.html)
- [SQLite Isolation](https://www.sqlite.org/isolation.html)
- [SQLite Atomic Commit](https://www.sqlite.org/atomiccommit.html)
- [RFC 9110 Conditional Requests](https://www.rfc-editor.org/rfc/rfc9110.html#section-13.1.1)
- [GitHub Organization Invitation Lifecycle](https://docs.github.com/en/organizations/managing-membership-in-your-organization/inviting-users-to-join-your-organization)

## Links

- [Contract Stability Baseline](./20260715-contract_stability_baseline.md)
- [NanoCore Config And Identity Contract](./20260628-nanocore_config_identity_contract.md)
- [OpenKit Policy Model](./20260629-openkit_policy_model.md)
- [Policy Enforcement Mapping](./20260703-policy_enforcement_mapping.md)
- [Storage Layout And Record Ownership](./20260703-storage_layout_record_ownership.md)
- [Schema Evolution And Record Envelope](./20260703-schema_evolution_record_envelope.md)
- [Workspace Synchronization](./20260703-workspace_synchronization.md)
- [Workspace Backup, Export, Import, And Data-Root Migration](./20260704-workspace_backup_export_import.md)
- [Remote Auth Credential Bootstrap](./20260704-remote_auth_credential_bootstrap.md)
- [Human Attention And Intervention Model](./20260531-human_attention_intervention_model.md)
- [OpenKit Test Strategy](./20260529-test_strategy.md)
- [OpenKit Agent Skill Interface](./20260713-openkit_agent_skill_interface.md)
- [Scheduler Recurring And Event Triggers](./20260711-scheduler_recurring_event_triggers.md)
- [NanoHost Runtime And Transport](./20260802-nanohost_runtime_and_transport.md)
