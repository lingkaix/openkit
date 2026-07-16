# Quick Chat Workspace

Status: Accepted
Implementation: Partial

## Owns

- The product and implementation contract for the built-in Quick Chat workspace kind.
- The per-user seed rule that makes Quick Chat each user's initial owner-only Workspace.
- The rule that Quick Chat is not shareable in the first multi-user implementation.
- The capability boundary that allows lightweight Chat Mode and workspace knowledge while refusing repository, data-source, Task Mode, Goal Mode, worker execution, and Git write flows.
- The App API and Web behavior required to keep Quick Chat visible as the default lightweight entry point without treating it as a project workspace.

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
- `docs/product-vision.md`
- `docs/specs/20260704-chat_mode_assistant.md`
- `docs/specs/20260704-task_mode_worker_delegation.md`
- `docs/specs/20260704-goal_mode_coordination.md`
- `docs/specs/20260704-workspace_data_source_catalog.md`
- `docs/specs/20260704-git_write_workflow.md`

## Summary

NanoCore should give every local or server user one lightweight owner-only Quick Chat Workspace as that user's initial Workspace. A fresh local data root therefore has one Quick Chat; a server deployment has one independent Quick Chat per user.

Quick Chat is a real workspace for conversation, threads, items, and knowledge, but it is not a project workspace.

It exists to give users a safe immediate Core Assistant entry point before they create or select a project workspace.

Quick Chat must not silently cross into repository-bound or worker-backed workflows.

When user intent requires repository access, file edits, external side effects, Task Mode, Goal Mode, worker turns, or Git writes, the system must ask the user to create or select a project workspace instead of using Quick Chat as a hidden bridge.

## Goals / Non-goals

### Goals

- Seed Quick Chat as the only Workspace initially visible to each newly created user.
- Represent Quick Chat through a product-visible workspace kind rather than a hard-coded workspace id branch.
- Allow Chat Mode, ordinary threads, ordinary items, and Knowledge Store records in Quick Chat.
- Reject repository resource binding, workspace data-source catalog use, Task Mode, Goal Mode, direct worker turn startup, and Git push flows for Quick Chat.
- Keep project work in ordinary workspaces such as `code` or `general`.
- Keep Web initial workspace selection simple by selecting the first available workspace, which is Quick Chat for fresh servers.

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

Core architecture already defines Core Assistant as the lightweight user-facing entry role for quick replies, clarification, state queries, and triage.

The missing contract is a workspace kind that hosts that lightweight entry point while refusing heavier workflow and repository surfaces.

## Decision

OpenKit will add a `quick-chat` workspace kind.

NanoCore will seed one Quick Chat Workspace, and no Demo Workspace, for each local or server user when that user has no Workspace state.

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

Quick Chat MAY use provider-backed inference through the same Core Assistant and LLM Gateway paths as other Chat Mode requests.

### Refused Behavior

Quick Chat MUST reject workspace repository resource setup.

Quick Chat MUST reject Task Mode start and Chat Mode task handoff execution.

Quick Chat MUST reject Goal Mode start, planning, approval, steering, pause, resume, and step routes.

Quick Chat MUST reject direct Core turn startup when the route would start a worker turn.

Quick Chat MUST reject Git push approval and execution routes.

Quick Chat MUST reject workspace data-source edits that would make repository or host-root material available to workers.

Refusals MUST use a stable App API error code and a user-safe message that tells the caller to create or select a project workspace.

### Web Behavior

The Web app should not need a custom default-workspace preference for this slice.

When NanoCore returns Quick Chat first, the existing route/local-storage/first-workspace selection behavior selects Quick Chat on fresh boot.

The Web app should not show project-only affordances as usable actions in Quick Chat.

Service-side refusals remain authoritative even when a client renders a stale or custom UI.

## Proposed Design

Add `quick-chat` to `WorkspaceKindSchema`.

Seed only Quick Chat when a user has no Workspace state. Under the owner-independent storage model, user provisioning records that user as the owner and only active member of a new top-level Quick Chat Workspace.

Keep `createDemoWorkspaceForUser(userId)` as a test and development helper that returns an importable Demo Workspace fixture without mutating the default new-user seed state.

Give Quick Chat empty runnable worker defaults by setting `defaults.defaultAgentId` and `defaults.defaultModelId` to `null`.

Add a small NanoCore helper that reads the workspace and rejects project-only operations for `quick-chat`.

Use that helper in repository setup, Task Mode startup, Goal Mode startup, Git push write routes, and direct worker-turn startup.

Keep Chat Mode and Knowledge Store routes available in Quick Chat, and skip Chat Mode Task or Goal handoff execution when the workspace is Quick Chat.

## Current Implementation Projection

`packages/protocol/src/models/workspace.ts` owns `WorkspaceKindSchema` and `WorkspaceRecordSchema`.

`apps/nanocore/src/lib/store.ts` owns the fresh data-root seed state and the Demo Workspace fixture helper.

The current user-bound `FsStore` naturally gives users independent Quick Chat data, but the accepted top-level Workspace root, explicit per-user owner membership, and stable rejection by future sharing operations are not yet implemented. This gap is why the spec is `Implementation: Partial`.

`apps/nanocore/src/app.ts` owns repository setup, Task Mode, Goal Mode, Chat Mode, and worker-turn routes.

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

Fresh NanoCore servers open into a safe lightweight conversation workspace.

Project work remains explicit because repository and worker-backed workflows require a non-Quick Chat workspace.

Demo Workspace remains available to tests and development tools through an explicit helper, but it is not user seed data.

The workspace kind enum becomes part of the shared protocol contract, so protocol tests and generated schemas must be updated.

The implementation adds a domain-specific special case, but it is centralized as a workspace kind rather than scattered as id checks.

## Rollout / Migration Plan

This repository is in internal development, so no backward compatibility layer is required.

Fresh local data roots seed only Quick Chat. In server mode, each newly created user receives one independent Quick Chat and no Demo Workspace.

Existing data roots keep their persisted workspaces until explicitly recreated or migrated by future tooling.

No old `general` Quick Chat records need to be repaired in this slice unless a focused test fixture requires it.

## Testing Strategy / Acceptance Criteria

- Protocol schema tests accept `kind: "quick-chat"` and reject unknown workspace kinds.
- NanoCore store tests prove a fresh store lists only Quick Chat and keeps it worker-default-free.
- NanoCore route tests prove Quick Chat rejects repository setup with a stable error code.
- NanoCore route tests prove Quick Chat rejects Task Mode, Goal Mode, and direct worker-turn startup before worker execution.
- Multi-user route tests prove every invitation, membership, and owner-transfer operation rejects Quick Chat before mutation.
- Existing Chat Mode and knowledge tests continue to pass for ordinary workspace-scoped behavior.
- Existing first-workspace selection keeps opening the first returned workspace, which is Quick Chat for fresh NanoCore stores.
- Focused package tests and typecheck pass for touched packages.

## Risks & Mitigations

- Risk: Quick Chat becomes a hidden project workspace through a missed route.
- Mitigation: put refusal behind one shared helper and cover each project-only entry family.

- Risk: The workspace kind grows into an ad hoc capability system.
- Mitigation: keep only `quick-chat` and project-only guards until another concrete workspace kind needs reusable capabilities.

- Risk: Users lose a visible path to start project work.
- Mitigation: Web should keep create/select workspace affordances visible from Quick Chat.

## Open Questions

None.

## Deferred / Future Work

- User-level default workspace preferences.
- Workspace capability matrix if future workspace kinds require more than the Quick Chat versus project distinction.
- Explicit Web copy or onboarding for creating a project workspace from Quick Chat.
- Optional migration tooling for existing development data roots.

## Links

- `docs/changes/202607091725150001-quick_chat_workspace.md`
- `docs/specs/20260715-multi_user_workspace_system.md`
