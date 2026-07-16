# Single-Deployment Multi-User Workspace System

Status: Accepted
Implementation: Partial
Date: 2026-07-15

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
- Long-lived compatibility for App API, Core Client, CLI, Skill, or Web projections.
- Outbound email delivery or pre-account invitation onboarding.

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
- `docs/product-vision.md`

## Summary

One NanoCore deployment is one personal or small-team trust domain, not a multi-tenant host. Users share a Workspace through Core-owned membership and policy records, while the Workspace remains one canonical storage and execution boundary independent of its current owner.

The creator becomes the default owner. The owner relationship is stored once in the workspace registry, and every owner is also an active member. Non-owner membership stores only `editor` or `viewer`. Product roles compile into the existing NGAC-aligned policy kernel; OpenKit must not add a second RBAC engine or delegate workspace authorization to Better Auth.

Canonical workspace data moves to `DATA_ROOT/workspaces/<workspaceId>`. `DATA_ROOT/users/<userId>` remains the home for genuinely personal preferences and user-local state. Sharing never creates a copy, a `share/` directory, a reference file, or a filesystem link.

The smallest complete V1 supports registered-user invitations, owner/editor/viewer access, owner transfer, removal and leave, disable-safe user lifecycle, actor attribution, narrow optimistic concurrency for mutable shared records, durable first-writer human decisions, and full L2-L6 multi-user verification.

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

OpenKit already has the beginnings of server-mode multi-user isolation: Better Auth sessions, canonical users, opaque access tokens, a workspace registry, owner membership creation, active/removed membership rows, request-time membership checks, token workspace bindings, and an NGAC-aligned policy kernel.

That implementation is not yet a shared Workspace system. Requests still open an `FsStore` for the authenticated user, canonical roots remain under `users/<userId>/workspaces/<workspaceId>`, workspace databases require a user ID, scheduler admissions carry a user store owner, and global search and worker paths inherit that physical ownership assumption.

The current membership table has no access level or invitation lifecycle. Owner deletion cascades through the workspace registry. General audit rows lack a human actor reference. Most mutable shared records have no revision precondition. Approval response currently checks pending state in process-local storage before some asynchronous delivery paths, so request idempotency does not by itself guarantee a durable first-writer terminal claim.

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
8. The policy kernel is the only permission decision owner.
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

Invitation acceptance requires an authenticated session or user-bound credential whose canonical user ID equals `invitee_user_id`. V1 does not create a bearer invitation secret, send email, create an account, or expose a user directory.

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
- the operation catalog maps the concrete product operation to one registered access right
- fixed associations connect each role attribute to the allowed access rights over the Workspace object attributes
- Workspace policy, user restrictions, token restrictions, approval state, and request context remain additional policy facts

The first implementation may rebuild this small fact set per request. It must not add an authorization cache until profiling demonstrates a need.

Role checks in handlers may validate lifecycle preconditions, but they must not become a second permission engine. A handler must consume the centralized policy result rather than independently deciding that `role === owner` is sufficient.

## Central Workspace Access Resolver

Every workspace-addressed operation must pass through one structural resolver before opening canonical Workspace storage.

```text
authenticate credential and canonical actor
  -> resolve operation metadata and target resource lineage
  -> resolve canonical Workspace registry row
  -> resolve active membership and effective role
  -> intersect credential scope and current responsible-user authority
  -> project facts into the policy kernel
  -> deny on missing or invalid facts
  -> open workspaces/<workspaceId>
  -> execute and audit
```

The operation catalog must declare whether an operation is server-scoped, user-scoped, or workspace-scoped, how its canonical Workspace is resolved, which policy operation it maps to, and whether it mutates state. Authorization must not depend on ad hoc path parsing, optional request-body fields, client-side hiding, filesystem discovery, or the caller's ability to guess a UUID.

When the caller lacks access, a missing Workspace, missing membership, removed membership, token mismatch, or denied policy result returns the same typed access failure without revealing target existence. After access is established, a missing child resource may return its normal not-found result.

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
      workspace.json
      db/workspace.sqlite
      config/
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

`workspaces/<workspaceId>` owns all canonical Workspace data. Owner transfer, access-level change, membership removal, and invitation acceptance update Core records only and never copy, rename, link, or move the Workspace tree.

The user-visible Workspace list is a query over identity and policy relationships. It is not a directory listing and does not require a per-user reference file.

Canonical Workspace readers and writers must continue to reject symlinks and unsafe paths. A `share/` folder, directory link, hard link, alias, or compatibility reference tree is prohibited.

## Personal And Shared Data Boundaries

- Workspace Threads, Items, Knowledge, Artifacts, agent sessions, approvals, policy decisions, audit, usage, repositories, data sources, and Workspace configuration are shared according to policy.
- User preferences, current Workspace selection, personal notification state, and user-local credentials remain user-scoped.
- A user's built-in Quick Chat Workspace remains owner-only and non-shareable in V1. Each server user has an independent Quick Chat Workspace and its Knowledge does not become team knowledge.
- Raw Vault secret material remains in the Vault backend. The owner manages Workspace references and grants; an editor may cause an approved agent use only when policy permits it; a viewer has no Vault-use authority.
- No per-member hidden record family is added inside a shared Workspace in V1. Truly personal state belongs to user scope.

## Actor Attribution

Shared history must distinguish actor identity from message role, trigger source, credential type, and agent identity.

The shared protocol and persisted projection should use one compact `ActorRef` shape:

```text
ActorRef
  kind: user | agent | automation | integration | system
  id: stable actor id
  responsibleUserId: stable user id or null
```

For a human user, `responsibleUserId` equals the user's ID. For an agent, automation, or integration, it identifies the active user accountable for the work when one exists. Credential kind, credential ID, and channel belong to authenticated request and audit context rather than `ActorRef`.

Actor attribution is required on:

- user-authored Items
- the actor or responsible-user trigger context that starts a Turn
- approval, elicitation, review, and ownership decisions
- membership and invitation lifecycle audit events
- Workspace mutations and revision audit records
- permission decisions and governed external effects
- automation and integration runs

Actor attribution is not added indiscriminately to immutable records that already have authoritative agent, system, or lineage identity. The goal is explainability, not a duplicated actor field on every schema.

Audit events must preserve a redacted actor or subject reference, responsible user when applicable, credential/channel summary, policy decision, target resource, request ID, outcome, and time. Display names and email addresses are projections and must not become stable actor identifiers.

No `tenantId` field is added.

## Human Attention And Decision Authority

Human gates in a shared Workspace need an eligible principal, not merely any authenticated user.

- An `ApprovalRequest` is resolved only by a subject granted `approval.respond` for the specific approval kind and resource.
- An owner may resolve owner-only sensitive approvals; an editor may resolve ordinary approvals only when the policy mapping makes that editor eligible.
- A `UserInputRequest` belongs to the responsible user who initiated or currently owns the work. Another member cannot silently answer it.
- An explicit audited owner takeover may reassign a blocked user-input gate when the responsible user is unavailable.
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

Zero changed rows produce a typed conflict and return the current safe summary. The first V1 families are Workspace metadata, membership access, invitation lifecycle, shared Knowledge current projections, Artifact metadata or review state, and other mutable records that two members can edit from stale reads.

The durable semantic is expected-revision compare-and-swap. A release-coupled HTTP projection may use a body field, ETag/If-Match, or another exact-release representation.

### One-Shot State Transitions

Invitation acceptance, invitation decline or revoke, membership removal, ownership transfer, approval decisions, and other terminal transitions use one database transaction and a conditional source-state or revision predicate.

The first winner records the actor, decision, request ID, and timestamp. Repeating the same request ID replays the result. A contrary or stale transition returns conflict and must not invoke a runtime, policy effect, or external side effect.

Approval claims must be durable before runtime delivery. Delivery happens after the transaction and is retryable from the stored decision.

### Workspace File Apply

Worker-proposed file changes continue to use the existing snapshot, content-digest, staged-review, expected-base, conflict-preflight, and approved-apply contract. This specification does not replace that path with record revisions or live coediting.

## Workspace Lifecycle

### Create

Workspace creation stages the canonical Workspace tree and transactionally records the registry owner plus active owner membership. Publication uses coordinated cleanup so a synchronous failure does not leave an ownerless Workspace, a registry-only Workspace, or an unregistered canonical tree.

The creator becomes owner unless an explicit deployment recovery operation names another active user.

### Invite

Only the owner may create an invitation. The target must already be an active canonical user and must not already have active membership.

Creating the invitation records proposed editor or viewer access, inviter, expiry, request ID, and audit evidence.

### Accept Or Decline

Only the bound invitee may accept or decline. Acceptance conditionally consumes one pending unexpired invitation and inserts or reactivates the membership in the same transaction.

Accepted, declined, revoked, and expired invitations cannot grant access again. Rejoining after removal requires a new invitation.

### Change Access

Only the owner may change a non-owner active member between editor and viewer. The update requires the current membership revision and takes effect on the next request and governed effect boundary.

### Remove Or Leave

Only the owner may remove a non-owner member. An editor or viewer may leave through the same removed-tombstone transition.

The owner cannot remove themselves or leave while they remain owner. Ownership must be transferred or the Workspace explicitly deleted.

Removal immediately blocks new requests, new turns, new human decisions, and new governed external effects. Committed history remains visible to remaining members and retains the removed actor's stable identity.

### Transfer Ownership

Ownership transfer requires:

- the current owner or an explicit deployment recovery authority
- an active target member
- a current registry revision
- one transaction that conditionally updates the owner and preserves an active membership for both users

If the target was a viewer, the transaction promotes their stored access level to editor. The former owner remains an editor unless the transfer operation explicitly requests a later safe removal after ownership changes.

Transfer preserves Workspace ID, storage root, history, policy, references, exports, and worker lineage. It emits one audit event linked to the old owner, new owner, actor, request ID, and registry revision.

### Disable Or Delete User

Disabling a user revokes product access and credentials but preserves memberships, actor references, history, and ownership until an administrator resolves them.

V1 keeps Better Auth hard deletion disabled. A user who owns a Workspace cannot be hard-deleted or erased until every owned Workspace is transferred or deleted.

Foreign keys from owner, membership, invitation, and durable actor references must not cascade-delete Workspace data or audit history. Privacy erasure requires a separately accepted retention and pseudonymization design; it is not implemented as raw row cascade.

### Delete Workspace

Only the owner or explicit deployment recovery authority may delete a Workspace. Deletion follows the storage owner's export, audit-closure, staged deletion, and recovery contract.

User deletion never triggers Workspace deletion.

## Agent, Automation, And Integration Work

An agent acts inside one Workspace under its agent identity and a responsible user or automation context.

Scheduler admission, worker package scope, policy facts, audit, usage, approval eligibility, and governed effects must carry `responsibleUserId` independently from the Workspace storage resolver. The current `userId` field must not continue to mean both physical store owner and accountable actor.

Membership and policy are re-evaluated at turn admission and before governed external effects or approved apply. If the responsible user loses authority, no new effect may occur. A bounded computation that has already begun may finish only into reviewable or quarantined output; it may not publish or apply state without a current authorized principal.

Workspace automations are Workspace-owned identities with one responsible owner. If that responsible user is disabled or removed, the automation pauses until the Workspace owner explicitly reassigns it. Current user-keyed in-memory automation ownership is not the shared target.

## Search, Action Center, And Notifications

- Workspace lists and global search use the authorized Workspace set before reading results.
- Search results never include a Workspace removed from the user's current membership or token intersection.
- Action Center rows include the eligible user or principal and are filtered by current membership and decision authority.
- A user sees personal notifications in user scope and shared work state through Workspace scope.
- Membership removal clears future personal projections without deleting shared history.
- Product surfaces show actor attribution for user messages, approvals, reviews, membership changes, and ownership transfer.

## Export, Import, Backup, And Restore

Portable Workspace export contains Workspace-owned product truth but excludes deployment-local access relationships:

- do not export active memberships, removed membership tombstones, invitations, auth sessions, access tokens, personal preferences, or user-local notification state
- retain stable actor references in history and audit as non-authority lineage
- do not treat source owner or actor IDs as target access grants
- import the authenticated importing user as the new owner and only active member
- require target-side invitations to share the imported Workspace
- keep imported Vault references unbound and repository resources target-bound as defined by their owners

A full data-root backup includes the Core database and therefore preserves users, memberships, invitations, and owner relationships when restored as the same deployment. Portable Workspace export and full deployment backup are distinct contracts.

## Current Implementation Projection

The following foundation is already implemented:

- Better Auth email/password users and session authentication
- implicit local user behavior for local mode
- opaque `okt_` tokens with `server-admin`, `workspace`, and `workspace-readonly` scopes
- workspace registry with one owner
- active/removed membership rows and owner membership creation
- per-request active membership checks for session and Workspace token actors
- token Workspace binding and read-only method gating
- same-deployment export privacy checks
- NGAC-aligned policy-kernel elements, assignments, associations, operations, and fail-closed evaluation
- request-id idempotency, append-only history, storage link rejection, and conflict-checked Workspace apply

The following required target behavior is not implemented:

- top-level owner-independent `workspaces/<workspaceId>` storage
- a Workspace store resolver independent from authenticated user ID
- editor/viewer access levels and fixed policy projection
- invitation records and operations
- centralized operation-metadata-based Workspace authorization
- owner transfer, leave, member removal operations, and owner-safe user lifecycle
- non-cascading owner and member foreign keys
- general human actor attribution in protocol and audit records
- revision compare-and-swap for shared mutable records
- durable first-writer approval claims
- responsible-user separation in scheduler, AEP, worker-control, automations, search, and Action Center
- removal of implicit `server-admin` Workspace content bypass
- same-release CLI, Skill, and Web multi-user projections

`Implementation: Partial` reflects the existing identity and membership foundation without claiming that shared storage or shared authorization works.

## Impacted Implementation Surfaces

| Surface | Required change |
| --- | --- |
| `packages/protocol` | Add the smallest durable actor and responsible-user attribution needed by user Items, Turn triggers, decisions, and audit. |
| `packages/app-api-schemas` | Add release-coupled member, invitation, transfer, leave, expected-revision, and authorized Workspace read models. |
| `packages/policy-kernel` and policy mapping | Reuse the kernel; add fixed role fact and product-operation mappings without a second engine. |
| NanoCore Core DB | Migrate registry and membership constraints; add invitations, access levels, revisions, and lifecycle indexes. |
| NanoCore storage | Move canonical roots and Workspace databases to top-level Workspace scope; remove user-owned routing. |
| NanoCore auth and routes | Replace path/body heuristics and request-user stores with centralized operation and resource resolution. |
| Scheduler, AEP, worker control, Gateway | Separate responsible user from storage resolution and reauthorize governed effects. |
| Audit, permission, approval, Action Center | Persist actor attribution, eligible principals, and atomic terminal claims. |
| Search, automations, Quick Chat | Derive shared visibility from membership; make automations Workspace-owned; keep Quick Chat owner-only. |
| Export, import, backup, restore | Exclude access grants from portable export, assign import owner, preserve full-backup identity state, and migrate paths. |
| Core Client, operation catalog, CLI, Skill | Project the complete same-release sharing lifecycle and typed conflicts without creating stable cross-release API promises. |
| Web | Add member and invitation management, role visibility, actor labels, conflict UX, and owner-transfer safeguards after kernel behavior is complete. |

## One-Way Storage And Schema Migration

The migration is offline, explicit, one-way, and internal-development only.

### Preconditions

- Stop NanoCore product writes and worker admission.
- Require no live worker lease, active apply, or non-terminal storage publication that depends on an owner-scoped root.
- Verify the current layout marker and every canonical path.
- Reject symlinks, unsafe paths, unknown layout versions, duplicate global Workspace IDs, missing registry owners, conflicting owners, and missing owner membership.
- Verify every registry Workspace maps to exactly one existing `users/<ownerUserId>/workspaces/<workspaceId>` tree.

### Prepare

1. Create a migration journal under the server migration owner.
2. Copy each canonical Workspace tree into same-filesystem staging for `workspaces/<workspaceId>`.
3. Verify exact file inventory, sizes, and digests before publication.
4. Open the staged Workspace database and apply the new Workspace-scope schema without a user owner parameter.
5. Build the Core DB migration that adds access levels, invitations, revisions, restrictive foreign keys, and owner membership invariants.
6. Classify current `userId` fields as responsible-user context, user-private ownership, or obsolete physical owner and rewrite them deliberately.

### Publish

1. Publish verified staged Workspace trees into the top-level Workspace root through same-filesystem rename.
2. Apply the Core DB transaction and record the new registry and membership revisions.
3. Advance the data-root layout marker only after every target tree and Core constraint verifies.
4. Boot in verification mode, rebuild derived indexes, and verify Workspace reads through the new resolver.
5. Retain the old owner-scoped source trees until post-migration verification succeeds.
6. Remove old trees through an explicit cleanup step and record their inventory and digest mapping in the migration report.

### Failure And Stop Rule

If preflight, copy, digest verification, schema migration, publication, Core transaction, or verification fails, NanoCore must not accept product work under a mixed layout. It preserves the source trees, records the failed stage, quarantines or removes only migration-owned staged output, and requires repair or a fresh retry.

No symlink, reference directory, fallback lookup, or dual-path reader remains after the new layout marker is accepted.

## API And Product Operations

The exact routes and payloads are release-coupled, but the supported behavior must include:

- list current user's authorized Workspaces
- read effective role and member summary
- list owner-visible members and invitations
- create invitation for a registered user
- accept or decline own invitation
- revoke pending invitation
- change editor/viewer access with expected revision
- remove member with expected revision
- leave Workspace
- transfer ownership with expected registry revision
- perform explicit administrator recovery without implicit content access
- return typed access, invitation, terminal-state, and revision conflicts

The Core Client, operation catalog, bundled CLI, unified Skill, and Web must project the same operation owners and error semantics in one exact release.

## Testing Strategy And Acceptance Criteria

### L0 Static And Repository Checks

- Active docs agree on owner-independent Workspace scope and exact-release API posture.
- Every workspace-scoped operation declares its scope resolver and policy operation.
- Public schemas contain no `tenantId`, organization role, raw invitation secret, physical user-owner path, or private storage handle.
- No code path creates or follows a Workspace sharing link.

### L1 Package And App Tests

- Registry owner, active owner membership, restrictive foreign keys, access enums, invitation uniqueness, expiry, and transition constraints.
- Fixed owner/editor/viewer policy mappings and denial for every missing operation or fact.
- Token, membership, role downgrade, removal, and server-admin separation.
- Actor attribution schemas and redaction.
- Revision compare-and-swap success, stale conflict, retry, and zero-row handling.
- Durable first-writer approval and invitation transitions under concurrent requests.
- Quick Chat non-shareability and Workspace-owned automation reassignment.

### L2 Contract And Conformance Tests

- Every public Workspace operation uses shared schemas and the central access resolver.
- A two-user fixture proves one canonical Workspace root and identical durable history.
- Owner/editor/viewer matrices cover read, mutation, agent work, approval, audit, Vault, export, membership, and deletion.
- Portable export excludes access relationships and import creates only the target owner membership.
- Actor and responsible-user lineage survives export/import without becoming authority.

### L3 NanoCore Black-Box Tests

- Three users sign in; the owner invites one editor and one viewer; each accepts and receives the correct visibility.
- The editor creates work that the owner sees from the same Workspace root; the viewer can read but cannot mutate.
- Removing or downgrading a member affects the next session and token request.
- Concurrent Workspace metadata updates produce one success and one typed revision conflict.
- Concurrent contrary approval responses produce one durable winner and no duplicate runtime effect.
- Owner transfer changes no Workspace path or ID, and the old owner becomes editor.
- Owner deletion is blocked before transfer; disabled members cannot act; history remains attributable.
- Server admin cannot read Workspace content until explicit audited membership or owner recovery occurs.
- Restart preserves membership, invitations, roles, actor history, and conflict semantics.

### L4 Web Browser Tests

- Workspace switcher shows only authorized Workspaces and effective roles.
- Owner member management covers invite, revoke, role change, removal, and transfer safeguards.
- Invitee Action Center covers accept and decline.
- Actor labels and revision-conflict recovery are visible without exposing internal IDs or paths.
- Viewer controls remain disabled while server enforcement proves authoritative.

### L5 Smoke And Artifact Health

- A packaged server migrates an owner-scoped fixture, starts on the new layout, and passes a two-user share/read/write/revoke story.
- Generated OpenAPI, Core Client, operation catalog, CLI, and Skill artifacts share one exact contract identity.
- A portable export/import story proves new target ownership and no imported memberships or invitations.

### L6 Agentic Story Acceptance

- A three-person team shares one project Workspace, delegates agent work as an editor, reviews it as the owner, observes actor and responsible-user lineage, removes the editor, and proves that no later governed effect uses the removed authority.
- A second story transfers ownership, restarts NanoCore, exports the Workspace, imports it into a fresh deployment, and proves the importer is the only initial member.

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
- Risk: removed users still act through tokens or workers. Mitigation: intersect current membership on every request and governed effect, and stale responsible-user sessions.
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

- [Implementation Change Plan](../changes/202607160021540001-contract_stability_multi_user_workspaces.md)
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
