---
status: Accepted
implementation: Partial
---
# Quick Chat Workspace

## Owns

- The product and implementation contract for the built-in Quick Chat workspace kind.
- The per-user seed rule that makes Quick Chat each user's initial owner-only Workspace.
- The rule that Quick Chat is not shareable in the first multi-user implementation.
- The capability boundary that allows lightweight Chat Mode and workspace knowledge while refusing repository, data-source, Task Mode, Goal Mode, worker execution, and Git write flows.
- The Quick Chat work-request transition that preserves that capability boundary while resolving or creating a separate executing Workspace through one confirmation.
- The App API and Web behavior required to project the Work Model boundary for Quick Chat.

## Does Not Own

- The canonical `Workspace` concept, which belongs to `docs/core/core-concepts.md`.
- The Core Assistant and Chat Mode routing contract, which belongs to `docs/specs/20260704-chat_mode_assistant.md`.
- Task Mode worker delegation, which belongs to `docs/specs/20260704-task_mode_worker_delegation.md`.
- Goal Mode coordination, which belongs to `docs/specs/20260704-goal_mode_coordination.md`.
- Workspace repository resources, data-source catalogs, workspace materialization, Git write workflow, or worker runtime behavior.
- User preference storage for an arbitrary default workspace selection.

## Core References

- `docs/core/core-concepts.md`
- `docs/core/architecture.md`
- `docs/core/work-model.md`
- `docs/core/storage.md`
- `docs/core/knowledge.md`

## Related Docs

- `docs/specs/20260704-chat_mode_assistant.md`
- `docs/specs/20260704-task_mode_worker_delegation.md`
- `docs/specs/20260704-goal_mode_coordination.md`
- `docs/specs/20260704-workspace_data_source_catalog.md`
- `docs/specs/20260704-git_write_workflow.md`
- `docs/specs/20260813-internal_agent_runtime.md`
- `docs/specs/20260902-agent_runtime_context_compaction.md`

## Intent

- `docs/product-vision.md`

## Summary

`docs/core/work-model.md` owns Quick Chat's stable product meaning and owner-only lightweight boundary. This specification realizes it as each local or server user's initial Workspace; a fresh local data root therefore has one Quick Chat, while a server deployment has one independent Quick Chat per user.

## Goals / Non-goals

### Goals

- Seed Quick Chat as the only Workspace initially visible to each newly created user.
- Represent Quick Chat through a product-visible workspace kind rather than a hard-coded workspace id branch.
- Allow Chat Mode, ordinary threads, ordinary items, and Knowledge Store records in Quick Chat.
- Reject repository resource binding, workspace data-source catalog use, direct Task Mode, direct Goal Mode, direct worker turn startup, and Git push flows in Quick Chat itself.
- Ensure a work request made in Quick Chat either reaches an accepted Task or Goal in a separate eligible Workspace through one confirmation or leaves a durable refusal naming the exact missing authorization.
- Keep project work in ordinary workspaces such as `code` or `general`.
- Keep Web initial Workspace selection simple by honoring an authorized current selection, otherwise selecting Quick Chat by kind, then falling back to the first authorized Workspace.

### Non-goals

- Do not add user-level default workspace preferences in this slice.
- Do not add a full workspace capability matrix before more workspace kinds require it.
- Do not let Quick Chat share knowledge implicitly with project workspaces.
- Do not let a user invite members to, transfer, or otherwise share Quick Chat in V1.
- Do not create a separate Chat-only product model outside the normal workspace, thread, turn, and item backbone.
- Do not preserve compatibility for older seeded workspace order in internal development.

## Background

The earlier NanoCore seed state created both `Demo Workspace` and `Quick Chat`.

The current Web selection algorithm chooses a route workspace, then a stored workspace id, then the first workspace returned by the server.

Because `Demo Workspace` is project-shaped seed data, automatically giving it to every new user makes the fresh landing state feel pre-populated instead of clean.

## Decision

OpenKit will add a `quick-chat` workspace kind.

NanoCore ensures one Quick Chat Workspace, and no Demo Workspace, for every active local or server user. Local boot ensures the local user's owner relationship, and Better Auth ensures a server user's Workspace and owner relationship before recording each new active session; both paths are idempotent, so a pre-existing project Workspace never suppresses the personal Quick Chat Workspace and an interrupted first attempt can retry on the next sign-in without a repair workflow.

Quick Chat will be the default workspace by being the only fresh workspace, not by a separate `defaultWorkspaceId` record.

The first implementation will keep the rule deliberately small: `workspace.kind === 'quick-chat'` is the product signal that the workspace is lightweight and non-worker-capable.

The implementation must centralize the guard instead of scattering checks for a literal workspace id such as `ws_quick_chat`.

## Contract / Expected Behavior

### Workspace Shape

Quick Chat is a `WorkspaceRecord` with `kind: "quick-chat"`, `status: "active"`, no default worker agent, no default model requirement, and no default skills.

Quick Chat owns normal workspace threads, turns, items, knowledge entries, knowledge proposals, knowledge sources, audit rows, capability usage rows, and workspace-local Knowledge Store files.

Quick Chat does not own repository resources, workspace-root data-source bindings, worker materialization records, worker checkpoints, Goal Mode records, Task Mode worker state, staged workspace reviews, workspace apply results, or Git push records.

### Sharing Boundary

Quick Chat MUST remain owner-only in V1. Invitation, direct membership addition, role change, ownership transfer, and portable share operations MUST reject a Quick Chat target with a stable product error before mutation. Each user's Quick Chat id and Knowledge remain independent; a user's Quick Chat MUST NOT become a team Workspace by implication.

### Allowed Behavior

Quick Chat MUST allow Chat Mode direct answers.

Quick Chat MUST allow clarification gates and ordinary Action Center projections created by Chat Mode.

Quick Chat MUST allow Knowledge Store creation, update, retrieval, and Knowledge Manager answer/context operations that use workspace knowledge.

Quick Chat MUST use provider-backed inference through the same Core Assistant, shared Internal Agent Loop, logical-model context policy, and LLM Gateway paths as other internal model-using roles. Its lightweight capability boundary does not authorize a separate direct Provider runtime.

### Refused Behavior

Quick Chat MUST reject workspace repository resource setup.

Quick Chat MUST reject direct Task Mode start in the Quick Chat Workspace.

Quick Chat MUST reject direct Goal Mode start, planning, approval, steering, pause, resume, and step routes in the Quick Chat Workspace.

Quick Chat MUST reject direct Core turn startup when the route would start a worker turn.

Quick Chat MUST reject Git push approval and execution routes.

Quick Chat MUST reject workspace data-source edits that would make repository or host-root material available to workers.

Direct project-only route refusals MUST use a stable App API error code and a user-safe message that identifies Quick Chat's boundary. Thread-scoped Chat Mode follows the work-request transition below rather than ending in a bare project-Workspace refusal.

### Work Request Transition

Quick Chat remains the conversation owner and remains owner-only, non-shareable, repository-free, data-source-free, and non-worker-capable. A work request does not add Task, Goal, Worker, repository, data-source, credential, policy, or Git capability to Quick Chat.

When the Assistant classifies a Quick Chat request as Task or Goal work, it MUST resolve an existing eligible executing Workspace or propose creation of an empty project Workspace inside the same confirmation already required for the consequential handoff. The confirmation states the requested mode, exact executing Workspace, whether that Workspace will be created, the new execution Thread, and the effect that acceptance will produce.

One accepted confirmation creates or selects the executing Workspace, creates the new execution Thread in that Workspace, and submits the accepted Task or Goal handoff. The originating Quick Chat Thread retains one handoff Item with causation to the new Thread. No Thread spans both Workspaces, and Quick Chat remains the owner of only the originating conversation.

`workspace.create` is onboarding in this path, not administration. It creates only an empty project Workspace and grants no repository, data source, credential, worker, capability, policy, or external-effect configuration by implication. The Assistant SHOULD resolve an already eligible Workspace before proposing creation, but the user's message does not have to name or understand Workspace placement before asking for work.

If an eligible Workspace cannot be resolved and the actor lacks the exact authority required to create one, the Chat Turn MUST terminate with a durable refusal Item that names that missing authorization. It MUST create no project Workspace, execution Thread, Task, Goal, Worker Turn, checkpoint, scheduler admission, or success-shaped handoff receipt.

This transition changes no Quick Chat capability. Direct project-only routes still refuse Quick Chat before effect, and service-side enforcement remains authoritative even when a client or model proposes an invalid target.

### Lifecycle, Conflict, And Recovery

The transition is created by one accepted Quick Chat work request and becomes pending when the Assistant presents the combined placement and handoff confirmation. Before acceptance, the user may reject it or replace the request without creating an executing resource.

Acceptance terminates the proposal only after the complete executing-Workspace, execution-Thread, handoff Item, and Task or Goal owner tuple is durable. Rejection terminates it without those effects. Missing authorization terminates it with the exact durable refusal Item. A missing required detail may produce one bounded clarification, after which the same request is reevaluated against current state.

The Workspace candidate, actor authority, target mode, and handoff preconditions MUST be revalidated at acceptance. A deleted, unavailable, ineligible, stale, conflicting, or newly unauthorized Workspace cannot be silently replaced after the user confirmed it; the Assistant presents a new confirmation for a different target or emits the exact refusal. A dependency failure preserves no success-shaped partial handoff.

Command identity and deterministic owners govern retry. Exact replay returns the already accepted handoff or refusal without creating another Workspace, Thread, Task, or Goal. A half-state returns `recovery_required` under the Chat command contract and MUST NOT infer or repeat missing business writes. A user-requested replacement attempt uses a new request identity and resolves current Workspace eligibility and authority again.

Process restart recovers from the originating Thread, Chat command record, deterministic owner tuple, and current Workspace owners. Provider memory, UI selection, and an earlier Workspace candidate are not recovery authority.

### Observable Acceptance

- A Quick Chat work request can reach an accepted Task or Goal without first requiring the user to navigate to or manually create a project Workspace.
- The user makes one confirmation that identifies both execution placement and the Task or Goal handoff.
- The resulting Task or Goal and its execution Thread belong to the eligible project Workspace, while Quick Chat retains only the originating conversation and handoff lineage.
- If Workspace creation or selection lacks exact authorization, the durable refusal Item identifies that authorization and no downstream work exists.
- Direct Task, Goal, Worker, repository, data-source, and Git routes remain unavailable against Quick Chat itself.

### Web Behavior

The Web app does not need a custom default-workspace preference for this slice.

An authorized current Workspace selection remains authoritative. Without one, Web selects the actor's Quick Chat Workspace by kind before falling back to the first authorized Workspace, so list ordering cannot route an unscoped lightweight conversation into a project Workspace.

The Web app should not show project-only affordances as usable actions in Quick Chat.

Service-side refusals remain authoritative even when a client renders a stale or custom UI.

## Proposed Design

Add `quick-chat` to `WorkspaceKindSchema`.

Seed only Quick Chat when a user has no Workspace state. Under the owner-independent storage model, user provisioning records that user as the owner and only active member of a new top-level Quick Chat Workspace.

Keep `createDemoWorkspaceForUser(userId)` as a test and development helper that returns an importable Demo Workspace fixture without mutating the default new-user seed state.

Give Quick Chat no Workspace-specific Worker default by omitting `workspace.jsonc.defaultAgentId`. The project-only guard rejects Worker selection before default-Agent resolution, so Quick Chat never consults the Server Agent fallback. Quick Chat model choice follows the Assistant internal-role and Gateway logical-model preference chain and has no Workspace record default.

Add a small NanoCore helper that reads the workspace and rejects project-only operations for `quick-chat`.

Use that helper in repository setup, Task Mode startup, Goal Mode startup, Git push write routes, and direct worker-turn startup.

Keep Chat Mode and Knowledge Store routes available in Quick Chat. Route model-backed Chat Mode work through the shared Internal Agent Loop even though ordinary short conversations will not reach its compaction threshold. For a Chat Mode Task or Goal handoff, keep the Quick Chat guard authoritative while the Assistant resolves or creates the separate executing Workspace through the combined confirmation; emit an exact durable missing-authorization refusal only when that transition cannot be authorized.

## Current Implementation Projection

`packages/protocol/src/models/workspace.ts` owns `WorkspaceKindSchema` and `WorkspaceRecordSchema`.

`apps/nanocore/src/lib/store.ts` owns the explicit idempotent Quick Chat Workspace record constructor and the Demo Workspace fixture helper. Local app composition and the server active-session hook own provisioning; the generic shared-store constructor creates no mode-specific or authority-free Workspace.

Each active local or server user receives one deterministic top-level Quick Chat Workspace and canonical owner membership before product use; the shared process store no longer uses user-scoped physical ownership. The complete sharing lifecycle rejects invitation, role change, removal, leave, transfer, administrator recovery, and portable source-authority reuse for Quick Chat, while the centralized guard rejects repository setup, Task Mode, Goal Mode, Git push, and direct worker-Turn entry. The specification remains Partial only because the rebuilt Web must still project Quick Chat's project-only affordance boundary under S10; the kernel and App API ownership contract is implemented.

`apps/nanocore/src/app.ts` owns repository setup, Task Mode, Goal Mode, Chat Mode, and worker-turn routes.

`apps/nanocore/src/mode-entry-routes.ts` still owns a direct `callQuickChatProvider` function, and `apps/nanocore/src/quick-chat.test.ts` currently asserts that no Internal Agent Runner is used. Those bytes are implementation divergence from the accepted shared-loop design and must be replaced rather than preserved when the Internal Agent Loop implementation reaches Quick Chat.

`apps/web/src/App.tsx` already selects the first returned workspace when no route or stored workspace id is valid.

`apps/nanocore/src/repository-routes.test.ts`, `apps/nanocore/src/server.test.ts`, `apps/nanocore/src/lib/store.test.ts`, `packages/protocol/src/index.test.ts`, and `apps/web/src/App.test.tsx` are the first focused regression surfaces.

## Alternatives Considered

### Keep Quick Chat As A Normal `general` Workspace

Rejected because project-only routes would keep treating it as eligible for repositories and worker execution.

### Add `defaultWorkspaceId`

Rejected for this slice because the product need is a safe lightweight workspace type, not an arbitrary user preference.

### Use A Hard-Coded Quick Chat Workspace Id

Rejected because it would create brittle route branches and break under multi-user namespace changes, import/export, or future seed id changes.

### Add A Full Capability Matrix

Deferred because the current product needs one special workspace kind and a few project-only guards.

## Consequences

Demo Workspace remains available to tests and development tools through an explicit helper, but it is not user seed data.

The workspace kind enum becomes part of the shared protocol contract, so protocol tests and generated schemas must be updated.

The implementation adds a domain-specific special case, but it is centralized as a workspace kind rather than scattered as id checks.

## Testing Strategy / Acceptance Criteria

- Protocol schema tests accept `kind: "quick-chat"` and reject unknown workspace kinds.
- NanoCore store tests prove a fresh store lists only Quick Chat and keeps it worker-default-free.
- Server auth flow tests prove sign-up establishes the actor-derived Quick Chat Workspace and canonical owner membership before the session can list Workspaces.
- NanoCore route tests prove Quick Chat rejects repository setup with a stable error code.
- NanoCore route tests prove Quick Chat rejects direct Task Mode, direct Goal Mode, and direct worker-turn startup before worker execution.
- Chat Mode tests prove one confirmation resolves or creates a separate executing Workspace and creates exactly one Task or Goal handoff, while missing Workspace authority produces one exact durable refusal and no downstream owner.
- Multi-user route tests prove every invitation, membership, and owner-transfer operation rejects Quick Chat before mutation.
- Existing Chat Mode and knowledge tests continue to pass for ordinary workspace-scoped behavior.
- Provider-backed Quick Chat tests prove the same Internal Agent Loop and logical-model context policy used by other internal roles, while a below-threshold request performs no compaction pass.
- Focused Web tests prove an authorized current selection remains authoritative and an absent or stale selection prefers Quick Chat even when a project Workspace is returned first.
- Focused package tests and typecheck pass for touched packages.

## Risks & Mitigations

- Risk: Quick Chat becomes a hidden project workspace through a missed route.
- Mitigation: put refusal behind one shared helper and cover each project-only entry family.

- Risk: The workspace kind grows into an ad hoc capability system.
- Mitigation: keep only `quick-chat` and project-only guards until another concrete workspace kind needs reusable capabilities.

- Risk: Workspace onboarding becomes a second confirmation or a hidden capability widening.
- Mitigation: the one handoff confirmation names placement and effect together, while all project-only effects remain owned by the separate executing Workspace.

## Open Questions

None.

## Deferred / Future Work

- User-level default workspace preferences.
- Workspace capability matrix if future workspace kinds require more than the Quick Chat versus project distinction.

## Links


- `docs/specs/20260715-multi_user_workspace_system.md`
