---
type: change-plan
status: in-progress
---
# Native Policy Review Behavior

## Intent Revision 1

Complete the existing human Policy review path without changing its retained format. Recheck current Workspace input authority at proposal and application, and classify only the same author's supported passive observation reductions or withdrawals as narrowing. Every change retains explicit human application. The immutable candidate, CAS, PermissionDecision and Audit owners remain unchanged.

## Intent Revision 2

Reapply the reviewed additive behavior to current main while preserving subsequent agent gate, Goal and lease behavior. Keep the change within the Policy source, its regression tests and the affected guides and implementation projection. Qualify the result locally and publish a feature branch for integration. Main updates, CI dispatch and merge are excluded.

## Intent Revision 3

The scope extension on 2026-10-21 permits fixture setup in `policy/agent-gate.test.ts` only. Register the binding input Workspace with the existing owner-membership helper in `configurationFixture()`. Keep the authority check, all assertions, other fixtures, timeouts and skips unchanged. Rerun the complete local gates before publishing the separate test correction.

## Owners And Scope

[Permissions](../../core/permissions.md) and [Policy Enforcement](../../specs/20260703-policy_enforcement_mapping.md) own current input authority, authorized narrowing and explicit review of widening. Reuse Native Policy statements and configuration candidate/application, the existing Kernel and immutable decision/Audit owners. This change adds no automatic application or new authority consumer.

## Current Checkpoint

The test-only commit ecceee151 on main baseline d10ac3104 produced three expected failures and one passing conservative-widening control. Proposal accepted a missing input Workspace, application accepted a Workspace closed after proposal, and passive reduction classified as widening. The control retained widening for gate withdrawal, longer lifetime, changed participant and another author's withdrawal. The tests use the current retained binding shape; unrelated configuration fixtures remain unchanged.

The production adaptation reuses the current Workspace Kernel authorizer and the existing `policyScopeContains` helper. The original behavior correction was independently reviewed at 51a0ee34d; this adaptation does not claim a new independent approval. Current agent gate, Goal and lease implementations remain intact. The immutable candidate, CAS, PermissionDecision and Audit owners are unchanged.

Initial qualification was blocked. The initial complete Policy/config run reported 464 passing tests and two failures in `policy/agent-gate.test.ts`: direct active preparation expects a shadow-evidence error, and exact completed-shadow activation expects success. Both encountered unavailable input Workspace authority. Their configuration fixture did not establish the input Workspace in the current registry; a direct fixture probe returned no registry row and no Workspace authorization. With the unchanged baseline configuration source, all 17 agent gate tests pass. The four added review regressions pass with the corrected source.

Native typecheck (`pnpm -C apps/nanocore exec tsc --noEmit -p tsconfig.json`), changed-file Biome check and `pnpm run -s check:repo` pass. Biome retains an existing unused-import warning in the administration test; repository checks retain existing warnings. No assertion, timeout or skip was changed. The complete suite has no skips.

The authorized fixture correction calls `recordWorkspaceOwnerMembership` for the binding's input Workspace and its human owner in `configurationFixture()`. The only test-file additions are that helper import and call. The authority check, assertions, other fixtures and Thread creation remain unchanged. The final complete Policy/config run (`pnpm -C apps/nanocore exec vitest run src/policy src/config`) passes all 466 tests across 39 files, with no failures or skips. Native typecheck, changed-file Biome and repository checks pass after the fixture correction. The branch is ready for integration review. No main update, CI dispatch or merge is performed.
