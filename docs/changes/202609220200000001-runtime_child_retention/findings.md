# Findings

These items record structural observations about this plan's uncommitted implementation, made by a read-only fan-out probe while the plan was paused; they are non-authorizing and leave the correction to this plan's primary.

## Follow-up Index

- [ ] `RCR-FND-001` [open] Bind capture coverage once and pass it opaquely
- [ ] `RCR-FND-002` [open] Construct ModelCaptureContext at one admission point
- [ ] `RCR-FND-003` [open] Seat timeline presentation limits in one owner
- [ ] `RCR-FND-004` [open] Reconcile with the governance landing before resuming

## [open] RCR-FND-001 — Bind capture coverage once and pass it opaquely

- **Observation:** The same admitted `{scope, value}` capture binding has four equivalent shapes: `CaptureCoverageBindingSchema` in apps/nanocore/src/storage/workspace-file-records.ts, `AgentEnvironmentCaptureCoverageSchema` in packages/config-schema/src/agent-environment.ts, the inline `RuntimeCaptureInput.captureCoverage` type, and a hand-written closed-set check in packages/worker-shim/src/cli.ts. The binding is revalidated along a path of about seven hops instead of being bound at Turn admission and carried as an opaque value.
- **Impact:** docs/specs/20260921-work_data_retention_format.md and docs/specs/20260616-agent_environment_package.md own the binding. Adding a scope or value, or changing the exact-key rule, needs four coordinated edits with no compile-time link between them; a missed edit silently diverges the Worker check from the Core schema.
- **Evidence:** temp/quality-governance/probes/probe-b-change-fanout.md, parameter-threading section, snapshot at HEAD a1ad3466 on 2026-09-23; spot-checked by Claude Code at workspace-file-records.ts:74, agent-environment.ts:1031, and cli.ts:541-549.
- **Owner:** docs/changes/202609220200000001-runtime_child_retention/plan.md, the paused runtime child retention primary.
- **Next action:** On resumption, choose one schema owner for the binding that both Core and Worker can import, replace the other shapes and the hand-written check with it, and keep the exact-key rejection covered by one existing test.

## [open] RCR-FND-002 — Construct ModelCaptureContext at one admission point

- **Observation:** `ModelCaptureContext` is constructed separately at four entry points, Quick Chat in mode-entry-routes.ts, Goal planning in goal-planning.ts, Administration in administration-routes.ts, and the internal Gateway provider, each opening the Workspace database; goal-planning.ts moved `createTurn` earlier only to obtain the capture handle.
- **Impact:** docs/specs/20260921-work_data_retention_format.md owns model I/O capture. Each new internal model caller must repeat database opening and context construction, and a caller that forgets it silently loses capture.
- **Evidence:** temp/quality-governance/probes/probe-b-change-fanout.md, path B of the parameter-threading section; spot-checked by Claude Code in the goal-planning.ts diff.
- **Owner:** docs/changes/202609220200000001-runtime_child_retention/plan.md, the paused runtime child retention primary.
- **Next action:** On resumption, derive the capture context once where the owning Turn is admitted and pass it through the existing provider call, removing per-entry construction, unless the retention owner records why an entry point needs different capture semantics.

## [open] RCR-FND-003 — Seat timeline presentation limits in one owner

- **Observation:** The timeline limits of 50 entries per Turn and 1000 text characters appear in three implementations, apps/nanocore/src/storage/work-observations.ts, apps/nanocore/src/app-dashboard.ts, and packages/app-api-schemas/src/dashboard.ts, and the coverage-state mapping is restated in both the retention specification and the Web product projection specification.
- **Impact:** docs/specs/20260628-web_product_surface_projection.md owns presentation limits. Changing a limit or mapping needs coordinated edits across three code files and two specifications, and the interim governance audit already had to reseat duplicated numeric authority once.
- **Evidence:** temp/quality-governance/probes/probe-b-change-fanout.md, projection and specification sections; spot-checked by Claude Code at work-observations.ts:551-552 and 665-670, app-dashboard.ts:768-769, and dashboard.ts:706 and 711.
- **Owner:** docs/changes/202609220200000001-runtime_child_retention/plan.md, the paused runtime child retention primary.
- **Next action:** On resumption, keep the limits in the shared dashboard schema as the single code owner, have the storage projection and dashboard read them from it, and remove the restated coverage mapping from the retention specification in favor of a link to the Web projection owner.

## [open] RCR-FND-004 — Reconcile with the governance landing before resuming

- **Observation:** While this plan was paused, the engineering governance landing edited paths this plan also changed: root AGENTS.md, docs/change-execution.md, docs/engineering-doctrine.md, docs/INDEX.md, docs/core/protocol.md, docs/specs/20260921-work_data_retention_format.md, docs/specs/20260703-worker_control_protocol.md, and the kind field of every specification. Role contracts moved from .codex/agents/ to docs/roles/, L2 now includes in-process composition tests with fault injection at a seam, change plans now say Intent Revision, and inline engineer-ruling markers in the retention specification became decision-record links. At commit 2ff8887c the repository check fails at biome with 15 errors in 14 apps/nanocore files, all of which this plan changed; biome also reports a warning, not an error, in apps/nanocore/src/docker/app-run-script.test.ts, which this plan did not change. The same errors appear with the landing diff stashed.
- **Impact:** Resuming from this plan's own checkpoint without reconciling would work against superseded role paths and test-layer rules, and the biome failures block the repository check for every other change.
- **Evidence:** git diff 2ff8887c on the named paths; the biome step of the repository check run with and without the landing diff on 2026-09-24.
- **Owner:** docs/changes/202609220200000001-runtime_child_retention/plan.md, the paused runtime child retention primary.
- **Next action:** On resumption, read docs/changes/202609231611190001-engineering_governance_landing/plan.md and its diff, name the seams this plan crosses in its checkpoint, fix the 15 biome errors in its 14 files and re-run the repository check.
