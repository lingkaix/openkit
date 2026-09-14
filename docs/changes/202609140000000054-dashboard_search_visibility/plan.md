---
type: change-plan
status: in-progress
---
# Dashboard And Search Visibility

## Intent Epoch 1

Source: engineer request and GitHub issue #54. Deliver one focused PR for private-thread visibility in `getWorkspaceDashboard`, `getThreadDashboard`, and `searchApp`, durable visibility and fail-closed cutover, followed by the three bundled CLI mappings. Test first, keep fixture credentials fake, honor hooks, push `feat/54-dashboard-search-visibility`, open against main with `Fixes #54.`, and stop without merging. Full sharing/handoff, subscriptions, export/import, unrelated leftovers and reopening #17 are excluded.

## Owners

- `docs/specs/20260909-thread_visibility_and_sharing.md`
- `docs/core/permissions.md`
- `docs/core/storage.md`
- `docs/specs/20260713-openkit_agent_skill_interface.md`
- `docs/specs/20260704-app_api_openapi_projection.md`

## Working Checkpoint

The existing handlers authorize Workspace access only; search also discovers Artifact metadata independently. Add one audience predicate before dependent reads and project filtered counts. Private creation binds the current actor; shared work starts with explicit shared visibility and does not convert history. Cutover must use durable classification evidence and reject ambiguous records. Required-feature emission prevents older readers from treating new private records as shared.

Regressions precede production commits. Next action: observe schema, audience isolation and catalog failures, then implement the owned contract and verify focused schema, storage, NanoCore and Skill checks. Artifact-origin checks are included only where these read projections surface them. No registered `.codex/agents/` capabilities exist in this worktree; artifact self-review and exact test evidence will be recorded, with independent human approval remaining the PR gate.
