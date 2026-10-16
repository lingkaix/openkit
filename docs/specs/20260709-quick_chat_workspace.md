---
status: Accepted
implementation: Partial
kind: concept
---
# Personal Workspace

## Owns

- The default personal Workspace, its owner-only provisioning, and the one-way migration from the former Quick Chat kind.
- Its full ordinary Workspace capability under existing Task, Goal, Artifact, Sandbox, repository, and data-source owners.
- The prohibition on adding members, transferring ownership, or implicitly converting it to a team Workspace.
- Initial Web selection and the personal Workspace placement of the private administration entry.

## Does Not Own

- The canonical `Workspace` concept, which belongs to `docs/core/core-concepts.md`.
- The Core Assistant and Chat Mode routing contract, which belongs to `docs/specs/20260704-chat_mode_assistant.md`.
- Task Mode worker delegation, which belongs to `docs/specs/20260704-task_mode_worker_delegation.md`.
- The Goal, which belongs to `docs/specs/20261002-goal.md`.
- Workspace repository resources, data-source catalogs, workspace materialization, external hosting, or worker runtime behavior.
- User preference storage for an arbitrary default workspace selection.

## Core References

- `docs/core/core-concepts.md`
- `docs/core/architecture.md`
- `docs/core/work-model.md`
- `docs/core/storage.md`
- `docs/core/knowledge.md`
- `docs/core/permissions.md`

## Related Docs

- `docs/specs/20260704-chat_mode_assistant.md`
- `docs/specs/20260704-task_mode_worker_delegation.md`
- `docs/specs/20261002-goal.md`
- `docs/specs/20260704-workspace_data_source_catalog.md`
- `docs/specs/20260704-worker_mcp_tool_supply.md`
- `docs/specs/20260813-internal_agent_runtime.md`
- `docs/specs/20260902-agent_runtime_context_compaction.md`

## Intent

- `docs/product-vision.md`

## Summary

Each User receives a default `personal` Workspace. It is an ordinary Workspace whose only special boundary is owner-only membership. It can own Task, Goal, Artifact, Sandbox, repository, and data-source work under their existing authorization and lifecycle rules ([accepted rulings 1 and 12](../decisions/20261015-private_assistant_timeline_and_rolling_context.md)).

## Goals / Non-goals

Seed the personal Workspace without Demo data. Preserve User ownership, existing history, Knowledge, idempotent provisioning, explicit disclosure, and truthful failures. Do not add a capability matrix, user default preference, parallel storage tree, or automatic membership repair. The Core Assistant and shared internal runtime retain their own contracts.

## Selected Content And Personal Memory

The personal Workspace remains owner-only: its Workspace membership cannot be widened and it cannot become a team Workspace. Ordinary work in it retains the existing Workspace audience without adding another member. Any prohibition or error below for sharing the personal Workspace refers to that Workspace conversion/membership operation, not `thread.share` publication of a selected snapshot into a separate eligible team Workspace. `20260909-thread_visibility_and_sharing.md` owns that explicit disclosure, original-private-history retention and receiving shared Thread. Existing handoff confirmation must also bind the exact public task brief and selected attachments.

User Memory is independently stored in the User scope and retrieved through `20260909-personal_memory_and_knowledge_learning.md`. Personal Workspace history may be a registered source after user-authorized capture, but its existing Workspace Knowledge records are not automatically renamed, exported as User Memory or silently activated as a personal profile. Personal Workspace creation/deletion and project selection do not create/delete personal Memory.

## Decision

Use `kind: personal` instead of `quick-chat`. Remove the former non-worker capability guards. Do not require a different Workspace for a Task or Goal handoff. Current authority and effect-specific checks still apply. The private administration entry moves to this personal Workspace without changing its Tool set.

NanoCore ensures one personal Workspace, and no Demo Workspace, for every active local or server user. Local boot ensures the local user's owner relationship, and Better Auth ensures a server user's Workspace and owner relationship before recording each new active session; both paths are idempotent, so a pre-existing project Workspace never suppresses the personal Workspace and an interrupted first attempt can retry on the next sign-in without a repair workflow. A presented usable server-admin bearer may also first enter through an actor-derived personal-Workspace operation, including the private administration Assistant, without a prior browser session. After validating the current credential and active canonical user, that resolver invokes the same idempotent provisioner only for the authenticated actor’s deterministic home before the requested operation is authorized. That provisioning creates only the authenticated actor's own personal Workspace. A currently usable administrator credential may read another user's personal Workspace under the administrator eligibility rule in [Core Permissions](../core/permissions.md). That read does not create their home, transfer ownership, or revive a tombstone. Invalid credentials create nothing; conflicting ownership or retained membership tombstones fail closed without revival. A denied or interrupted attempt never deletes retained Workspace files as a cleanup shortcut; a subsequent authorized request reuses the same existing provisioning path.

Migrate each existing `quick-chat` Workspace one way to `personal`, preserving its identity, owner, membership tombstones, Threads, Knowledge, and other retained records. No compatibility kind, dual write, or parallel Workspace is added. A conflict or interrupted migration fails closed under the existing storage/migration owner; it never resets retained data. Completed migration and exact provisioning retry reuse the same Workspace.

The personal Workspace is the initial selection without a separate `defaultWorkspaceId` record. Use kind and authenticated ownership, never a hard-coded Workspace id.

## Contract / Expected Behavior

### Workspace Shape

The personal Workspace is an active ordinary Workspace with `kind: personal`. Existing configuration owners resolve Agent, model, and Skill defaults. The kind introduces no worker-default prohibition or extra resource restrictions.

It owns normal Threads, Turns, Items, Knowledge, audit and usage projections. Repository, data-source, Worker, Goal, review, and apply records follow their existing owners. Personal placement grants no credential, permission, or external effect by implication.

### Sharing Boundary

The personal Workspace MUST remain owner-only in V1. Invitation, direct membership addition, role change, ownership transfer, and portable share operations MUST reject a personal Workspace target with a stable product error before mutation. Each user's personal Workspace id and Knowledge remain independent; a user's personal Workspace MUST NOT become a team Workspace by implication.

### Work And Handoff

Chat, Task, Goal, Artifact, Sandbox, repository, and data-source operations use their ordinary owners in the personal Workspace. A personal Chat handoff may create its linked execution Thread in that same Workspace. It does not require creation or selection of a project Workspace merely because the origin is personal.

The existing handoff confirmation binds the exact receiving Workspace, execution Thread, mode, work brief, selected inputs, and effect. Explicit disclosure to another Workspace remains subject to the sharing owner. An empty Workspace creation grants no resource configuration or execution authorization by itself.

If the actor lacks required execution or disclosure authority, Chat records the exact durable refusal and creates no downstream work. Service admission stays authoritative when the client presents a stale or invalid target.

### Lifecycle, Conflict, And Recovery

The transition is created by one accepted personal-Workspace work request and becomes pending when the Assistant presents the combined placement and handoff confirmation. Before acceptance, the user may reject it or replace the request without creating an executing resource.

Acceptance terminates the proposal only after the complete executing-Workspace, execution-Thread, handoff Item, and Task or Goal owner tuple is durable. Rejection terminates it without those effects. Missing authorization terminates it with the exact durable refusal Item. A missing required detail may produce one bounded clarification, after which the same request is reevaluated against current state.

The Workspace candidate, actor authority, target mode, and handoff preconditions MUST be revalidated at acceptance. A deleted, unavailable, ineligible, stale, conflicting, or newly unauthorized Workspace cannot be silently replaced after the user confirmed it; the Assistant presents a new confirmation for a different target or emits the exact refusal. A dependency failure preserves no success-shaped partial handoff.

Command identity and deterministic owners govern retry. Exact replay returns the already accepted handoff or refusal without creating another Workspace, Thread, Task, or Goal. A half-state returns `recovery_required` under the Chat command contract and MUST NOT infer or repeat missing business writes. A user-requested replacement attempt uses a new request identity and resolves current Workspace eligibility and authority again.

Process restart recovers from the originating Thread, Chat command record, deterministic owner tuple, and current Workspace owners. Provider memory, UI selection, and an earlier Workspace candidate are not recovery authority.

### Observable Acceptance

- A personal Workspace accepts ordinary Task, Goal, Artifact, Sandbox, repository, and data-source admission under their existing owners.
- A Chat handoff may use a linked execution Thread in that same Workspace with one existing confirmation.
- Missing execution or disclosure authority leaves an exact durable refusal with no downstream work.
- Member addition, invitation, transfer, and team conversion fail before mutation.
- Migration preserves existing identities, Threads, Knowledge, ownership, and tombstones; restart never creates a duplicate home or resets data.

### Web Behavior

The Web app does not need a custom default-workspace preference for this slice.

An authorized current Workspace selection remains authoritative. Without one, Web selects the actor's personal Workspace by kind before falling back to the first authorized Workspace, so list ordering cannot silently select another Workspace.

The Web app exposes ordinary work affordances under their existing readiness and authority checks.

Service-side refusals remain authoritative even when a client renders a stale or custom UI.

## Proposed Design

Reuse the existing Workspace record, owner-independent storage, authenticated per-user provisioner, ordinary configuration resolution, and shared internal Agent loop. Retain Demo creation only as an explicit test/development helper. Replace `quick-chat` with `personal` through one migration and delete the former project-only guards. No special runtime or second provisioning owner is added.

## Current Implementation Projection

The canonical Workspace kind is `personal`. Loading a retained `quick-chat` Workspace validates its complete canonical history, then atomically replaces only the former kind in its system record. This one-way migration preserves the Workspace identity, authored configuration, descriptive annotations, Threads, Items, Knowledge and Core membership records. An invalid record or history fails without publishing the kind change. Current protocol schemas do not admit the former kind.

`packages/protocol/src/models/workspace.ts` owns `WorkspaceKindSchema` and `WorkspaceRecordSchema`.

`apps/nanocore/src/lib/store.ts` owns the explicit idempotent Quick Chat Workspace record constructor and the Demo Workspace fixture helper. Local app composition, the server active-session hook, and the actor-derived Quick Chat resolver for a presented usable server-admin bearer invoke the shared provisioning owner in `workspace-membership.ts`; the generic shared-store constructor creates no mode-specific or authority-free Workspace.

Each active local or server user receives one deterministic personal Workspace and canonical owner membership before product use; the shared process store uses owner-independent physical placement. The current identifier API remains the sole identity allocator. The complete membership lifecycle rejects invitation, role change, removal, leave, transfer, administrator recovery and portable source-authority reuse for the personal Workspace. Ordinary Task, Goal, repository, Artifact and Worker admission uses the same owners as other Workspaces. A shared execution Thread in a personal Workspace remains readable by its sole member; the private conversation and administration Threads retain their owner audience.

The former stateless Quick Chat entry is superseded by [Retire Stateless Quick Chat](../decisions/20261016-retire_stateless_quick_chat.md). `conversation.submit` owns ordinary Assistant entry on the private Timeline. One-shot CLI and Skill requests use that command and retain its durable lineage. The former direct Provider call and standalone operation are removed, with no compatibility alias.

Web resolves the caller-owned personal Workspace by current kind, ownership and membership when no authorized explicit selection is present.

`apps/nanocore/src/repository-routes.test.ts`, `apps/nanocore/src/server.test.ts`, `apps/nanocore/src/lib/store.test.ts`, `packages/protocol/src/index.test.ts`, and `apps/web/src/App.test.tsx` are the first focused regression surfaces.

## Alternatives Considered

The engineer chose an ordinary personal Workspace over the former lightweight Quick Chat kind. A default preference record, capability matrix, hard-coded Workspace id, or parallel Workspace would add an unneeded owner or mechanism.

## Testing Strategy / Acceptance Criteria

Check ordinary work admission, owner-only membership, initial selection, exact provisioning retry, and the migration/restart predicates above. Preserve invalid-credential, wrong-owner, tombstone, no-reset, current-authority, disclosure, and command-replay checks. The shared loop remains required for model-backed Chat; personal placement grants no direct Provider exception.

## Open Questions

None.

## Deferred / Future Work

User-level default Workspace preferences require a demonstrated need. Shared conversations follow the post-v0.1.0 team-Workspace owner and do not relax personal membership.

## Links

- `docs/specs/20260715-multi_user_workspace_system.md`
