---
type: change-plan
status: in-progress
---
# Native Policy Review Behavior

## Intent Revision 1

Complete the existing human Policy review path without changing its retained format. Recheck current Workspace input authority at proposal and application, and classify only the same author's supported passive observation reductions or withdrawals as narrowing. Every change retains explicit human application. The immutable candidate, CAS, PermissionDecision and Audit owners remain unchanged.

## Intent Revision 2

Reapply the reviewed additive behavior to current main while preserving subsequent agent gate, Goal and lease behavior. Keep the change within the Policy source, its regression tests and the affected guides and implementation projection. Qualify the result locally and publish a feature branch for integration. Main updates, CI dispatch and merge are excluded.

## Owners And Scope

[Permissions](../../core/permissions.md) and [Policy Enforcement](../../specs/20260703-policy_enforcement_mapping.md) own current input authority, authorized narrowing and explicit review of widening. Reuse Native Policy statements and configuration candidate/application, the existing Kernel and immutable decision/Audit owners. This change adds no automatic application or new authority consumer.

## Current Checkpoint

The test-only commit ecceee151 on main baseline d10ac3104 produced three expected failures and one passing conservative-widening control. Proposal accepted a missing input Workspace, application accepted a Workspace closed after proposal, and passive reduction classified as widening. The control retained widening for gate withdrawal, longer lifetime, changed participant and another author's withdrawal. The tests use the current retained binding shape; unrelated configuration fixtures remain unchanged.

The production adaptation reuses the current Workspace Kernel authorizer and the existing `policyScopeContains` helper. The original behavior correction was independently reviewed at 51a0ee34d; this adaptation does not claim a new independent approval. Current agent gate, Goal and lease implementations remain intact. The immutable candidate, CAS, PermissionDecision and Audit owners are unchanged.

Qualification is blocked. The complete Policy/config run (`pnpm -C apps/nanocore exec vitest run src/policy src/config`) reports 464 passing tests and two failures in `policy/agent-gate.test.ts`: direct active preparation expects a shadow-evidence error, and exact completed-shadow activation expects success. Both now encounter unavailable input Workspace authority. Their configuration fixture does not establish the input Workspace in the current registry; a direct fixture probe returned no registry row and no Workspace authorization. With the unchanged baseline configuration source, all 17 agent gate tests pass. The four added review regressions pass with the corrected source.

Native typecheck (`pnpm -C apps/nanocore exec tsc --noEmit -p tsconfig.json`), changed-file Biome check and `pnpm run -s check:repo` pass. Biome retains an existing unused-import warning in the administration test; repository checks retain existing warnings. No assertion, timeout or skip was changed. The complete suite has no skips.

Next: establish current Workspace authority in the activation fixture under separately authorized test scope, then rerun the complete Policy/config suite. That test file is outside this change's nine-file write scope. Integration readiness is not claimed, and no main update, CI dispatch or merge is performed.
