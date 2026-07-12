# NanoCore Maintainability Recovery

Type: change-plan
Status: in-progress

## Intent

Remove the confirmed NanoCore code-decay hotspots while preserving the current OpenKit architecture, public contracts, product features, and specified runtime behavior.

The change preserves intended behavior, not accidental behavior that already contradicts accepted specifications or safety invariants. Confirmed examples include read routes that mutate durable or Git state, duplicate review-decision paths that can disagree, and Git commits that can include unrelated staged changes.

## Scope

- Restore one clear owner for workspace-review staging, decisions, apply results, and Git mutation.
- Make workspace-review read routes read-only and make Git-backed apply behavior deterministic and isolated from unrelated user worktree state.
- Replace source-text OpenAPI coverage with a live bidirectional route/operation gate, then make route registration and OpenAPI metadata share one definition as required by the accepted OpenAPI projection spec.
- Reduce `apps/nanocore/src/app.ts` to dependency composition, middleware, and coarse-grained route mounting by moving complete feature paths into cohesive domain route modules.
- Remove the legacy in-memory LLM provider configuration owner and keep runtime provider configuration canonical.
- Delete production-unreachable implementation islands and pure pass-through entities after proving that no production or dynamic entry point consumes them.
- Move the root-level Vault implementation into a cohesive `src/vault/` boundary without moving storage-owned schema or provider-owned credential resolution.
- Reduce `FsStore` ownership pressure by assigning record families to their documented file or SQLite source of truth instead of adding façade interfaces over the same god object.
- Add concise source-ownership documentation only at real app and subsystem boundaries.
- Keep focused tests close to each extracted feature while retaining black-box server coverage for public behavior.

## Non-Goals

- Do not add product features, routes, protocol concepts, configuration surfaces, or compatibility shims.
- Do not change the Core/App/Agent architecture, deployment model, storage doctrine, or first-party client boundary.
- Do not change public route methods, paths, request or response schemas, status codes, authentication posture, or supported workflows unless an accepted specification proves the current behavior is defective.
- Do not split one route per file, introduce a controller/service/repository framework, add a general dependency container, or replace one god object with many pass-through interfaces.
- Do not use line count, file count, exported type count, or commit count as completion targets.
- Do not mechanically add a README to every leaf directory or delete types solely to reduce totals.
- Do not combine local workspace-review Git execution with the separately secured Git push runner unless a later concrete use case proves identical semantics.

## Related Context

- [Architecture](../core/architecture.md)
- [Work Model](../core/work-model.md)
- [Storage](../core/storage.md)
- [Product Vision](../product-vision.md)
- [App API Boundary](../app-api.md)
- [App API OpenAPI Projection](../specs/20260704-app_api_openapi_projection.md)
- [Storage Layout and Record Ownership](../specs/20260703-storage_layout_record_ownership.md)
- [Workspace Synchronization](../specs/20260703-workspace_synchronization.md)
- [Git Write Workflow](../specs/20260704-git_write_workflow.md)
- [Pi AI Provider Gateway Adoption](../specs/20260703-pi_ai_provider_gateway_adoption.md)
- [Unified Pi AI LLM Backend](../specs/20260708-pi_ai_unified_llm_backend.md)
- [Test Strategy](../specs/20260529-test_strategy.md)

## Current Evidence Baseline

The baseline was re-measured from the current worktree on 2026-07-11.

- `apps/nanocore/src/app.ts` contains 15,714 lines, 187 direct Hono route registrations, and a `createApp` implementation spanning about 9,860 lines.
- Several route handlers contain complete application workflows rather than HTTP adaptation; the largest current examples are Chat Mode, Goal Mode step, workspace export/import, artifact review, and LLM Gateway routes.
- Workspace-review staging, decision, Git apply, commit, rollback, branch materialization, and HTTP behavior have duplicate owners in `app.ts` and `runtime/workspace-sync-records.ts`.
- Workspace-review GET routes currently persist artifact snapshots and can materialize Git branches.
- `recordWorkspaceSyncReview` currently overwrites mutable review status from artifact-backed input on conflict.
- The artifact-review acceptance path and the dedicated workspace-review decision path duplicate apply orchestration but do not persist the same review lifecycle state.
- The workspace-review Git path changes the linked main worktree, lacks a per-repository mutation boundary, inherits the full process environment, and can commit unrelated pre-staged changes.
- `apps/nanocore/src/openapi.ts` manually owns 121 paths and 136 operations while `app.ts` owns the runtime routes; the current coverage test scans only `app.ts` source text and checks only runtime-to-document absence.
- The accepted OpenAPI specification requires an OpenAPI-aware route registry and a bidirectional comparison with the live Hono route table.
- Runtime `ProviderRegistry`, static LLM provider metadata, and `LLMProviderConfigStore` currently form three provider/configuration owners; normal startup does not supply the legacy in-memory store, but production routes still read it.
- `FsStore` contains about 87 public methods and `app.ts` calls those methods about 262 times while also opening workspace SQLite handles repeatedly.
- Static production-entry reachability identified 13 candidate production files totaling about 4,536 lines that are consumed only by tests; this remains a deletion candidate until dynamic-entry and accepted-design checks are complete.
- NanoCore has 18 immediate `src` subdirectories and no source-boundary README below `src`; the app README does not yet provide a source ownership map.
- Root-level Vault production files form a cohesive domain of about 4,533 lines.

## Required Invariants

- Existing public behavior remains covered by black-box or contract tests before movement.
- Read-only HTTP routes do not mutate files, Git refs, worktrees, databases, or product lifecycle records.
- One application command owns each workspace-review state transition and apply attempt.
- Artifact evidence remains immutable; mutable review state is never rebuilt by overwriting terminal state from an older artifact snapshot.
- A successful Git apply or commit and its durable review/apply result cannot silently diverge.
- OpenKit-created commits contain exactly the reviewed paths and never consume unrelated user-staged changes.
- Route registration and OpenAPI projection cannot drift in either direction.
- Provider existence, enablement, defaults, and credentials resolve from the documented runtime configuration source of truth.
- Storage ownership follows the existing file-first and scope-owned SQLite doctrine.
- Extracted modules expose only abstractions justified by a real use case or ownership boundary.
- No unrelated user worktree changes are staged or committed.

## Execution Plan

### Phase 0: Baseline and Guardrails

- Record the current route, OpenAPI, provider, storage, dead-code, directory, and test topology.
- Run the current NanoCore unit, typecheck, lint, format-check, repository-check, build, and smoke gates before behavior changes.
- Add characterization tests wherever current intended behavior is not already protected.

Exit criteria: the baseline is reproducible, existing failures are recorded, and later phases have explicit behavior evidence.

### Phase 1: Workspace Review Integrity and Git Safety

- Add failing regression tests for terminal review status preservation, read-only GET behavior, canonical artifact/workspace decision behavior, exact-path commits, unrelated staged content, and failure recovery.
- Make artifact ingestion stage a review only once and prevent later reads from overwriting mutable state.
- Route every workspace-review decision through one application command; remove duplicated apply orchestration from the artifact-review route.
- Move review Git behavior into one cohesive implementation with managed temporary worktrees for review branches, repository-scoped serialization, clean-state validation, exact-path commits, restricted environment handling, and observable cleanup failures.
- Reuse current apply-plan and apply-result records for cross-system transition evidence instead of adding a parallel transaction entity.
- Make list/detail GET routes strictly read-only.

Exit criteria: focused tests prove the invariants, repository mutations and durable state agree across success/failure, and all public response contracts remain unchanged.

### Phase 2: OpenAPI and Route Registration Ownership

- Replace source-regex coverage with a bidirectional live Hono route-table versus OpenAPI operation-set check and explicit exclusions.
- Convert route groups to the accepted OpenAPI-aware registration form so handler and metadata share one route definition.
- Delete the parallel manually assembled operation map after all public route groups are registered.
- Keep shared Zod packages canonical and keep generated OpenAPI output projection-only.

Exit criteria: live runtime routes and generated operations match in both directions, the artifact validates and drift-checks, and moving a route between files cannot evade coverage.

### Phase 3: Vertical Decomposition of `app.ts`

- Extract complete feature paths rather than isolated helpers, starting with workspace synchronization/review and then the largest current route families.
- Continue with Chat/Task/Goal workflows, storage export/import, worker control/capabilities, knowledge, auth/vault administration, providers/Gateway, and remaining Core/App routes.
- Pass each route module only the concrete dependencies it uses; do not introduce a universal app context.
- Move focused tests with the owning feature while preserving server-level contract coverage.

Exit criteria: `app.ts` owns composition, middleware, and route mounting only; no domain workflow is split between `app.ts` and an extracted module; complete feature paths remain directly traceable.

### Phase 4: Provider Ownership Convergence

- Characterize production provider resolution, defaults, diagnostics, dashboard counts, quick chat, internal agents, and Gateway dispatch.
- Remove `LLMProviderConfigStore` and its production fallback path.
- Make tests use the same runtime provider registry/configuration path as production.
- Keep configured runtime provider instances distinct from static adapter metadata, but eliminate duplicated credential and capability derivation rules.
- Reduce static provider metadata to fields actually owned by the adapter catalog and resolve one minimal internal provider shape.

Exit criteria: one configured-provider source of truth remains, production and tests use the same path, and provider projections report current runtime configuration.

### Phase 5: Deletion and Directory Cohesion

- Prove or disprove every production-unreachable candidate against entry points, dynamic loading, package exports, accepted specs, and current runtime selection.
- Delete confirmed unreachable production islands together with tests that only preserve those retired paths.
- Delete pure pass-through functions and shrink concrete single-consumer types where direct values are clearer.
- Move the Vault implementation and tests to `src/vault/`; leave storage schemas and provider credential resolution with their current owners.
- Update imports mechanically and avoid opportunistic behavior changes.

Exit criteria: no confirmed dead production code or pure pass-through entity remains, and root source files reflect real ownership boundaries.

### Phase 6: Storage Ownership and Source Documentation

- Inventory every `FsStore` record family against the storage core document and storage-layout spec.
- Move domain behavior to existing record-family modules and explicit file or SQLite owners instead of adding façade interfaces over `FsStore`.
- Remove `FsStore` methods and aggregate snapshot responsibilities as their real owners become authoritative.
- Add `src/README.md` as the NanoCore source map and add concise local READMEs only for stable, important boundaries such as runtime, storage, providers, auth, and Vault.

Exit criteria: new features no longer default to `FsStore`, storage source-of-truth decisions are explicit, and important source boundaries are discoverable without duplicated documentation.

### Phase 7: Final Audit and Verification

- Re-run the structural audit for god files/functions, duplicate ownership, speculative abstractions, pass-through entities, dead code, route/OpenAPI drift, provider duplication, and storage ownership.
- Run the full L0-L5 deterministic verification appropriate to NanoCore and the repository.
- Review diffs and commit history for scoped changes, English documentation, conventional commits, and no unrelated edits.
- Close this record with commit links, verification evidence, remaining risks, and a final implementation summary.

Exit criteria: every scoped issue has direct current-state evidence of resolution and all required gates pass.

## Verification Plan

Run focused tests before and after every behavior or refactor slice, then run the following gates at each material phase boundary:

- `CI=true pnpm --filter @openkit/nanocore test`
- `CI=true pnpm --filter @openkit/nanocore typecheck`
- `CI=true pnpm --filter @openkit/nanocore lint`
- `CI=true pnpm --filter @openkit/nanocore build`
- `CI=true pnpm --filter @openkit/nanocore run openapi:check`
- `CI=true pnpm run format:check`
- `CI=true pnpm run check:repo`
- `CI=true pnpm --filter @openkit/nanocore run test:e2e:smoke`
- `git diff --check`

Run the broader deterministic repository verification before final closeout:

- `CI=true pnpm -w verify:release`
- `CI=true pnpm -w test:stories`

Quota-gated, credentialed, remote-provider, or external-system tests remain opt-in and are not silently invoked.

## Commit and Review Discipline

- Land behavior changes as a failing-test commit followed by an implementation commit.
- Keep mechanical movement, dead-code deletion, and documentation changes separate from behavior changes.
- Update this record only at phase completion, material deviation, blocker, or final verification.
- After each phase, review for cohesion, coupling, duplication, speculative abstractions, pass-through layers, feature-path traceability, error handling, security, and data-loss risk.
- Format and verify the exact changed surface before every commit, then run phase-wide gates.
- Commit only files owned by this change and preserve unrelated worktree changes.

## Risks and Mitigations

- Risk: route extraction silently changes middleware order or error mapping. Mitigation: characterize route behavior first and compare the live route table, auth posture, response schemas, and black-box tests.
- Risk: workspace-review cleanup changes current accidental behavior. Mitigation: use accepted workspace-sync and Git-write specifications as authority and preserve public response contracts while removing unsafe side effects.
- Risk: Git/SQLite coordination cannot be atomic across systems. Mitigation: reuse durable apply-plan/apply-result transitions, serialize repository mutations, validate before mutation, and make rollback or recovery state explicit and tested.
- Risk: deleting test-only production files removes a planned path. Mitigation: check active specs, runtime selection, dynamic loading, and package exports; future-only code without a current production owner is deleted under YAGNI and can be restored from history if later accepted.
- Risk: route modules or storage cleanup create more abstractions than they remove. Mitigation: require each new module, type, or function to own a complete feature path or concrete reusable rule.
- Risk: documentation proliferation creates a second maintenance burden. Mitigation: keep one app source map and add local READMEs only where a stable ownership boundary needs local guidance.

## Checkpoints

### 2026-07-11: Plan Started

- Revalidated the current worktree, branch, repository guidance, prior audit findings, and current source topology.
- Recorded the full remediation scope, invariants, execution order, verification gates, commit discipline, and completion evidence requirements before implementation.

### 2026-07-11: Phase 0 Baseline Complete

- Committed the initial change plan as `cb50455` (`docs: plan nanocore maintainability recovery`).
- NanoCore unit baseline passed with 198 test files passed, 1 skipped, 1,238 tests passed, and 7 skipped.
- NanoCore typecheck, lint, build, OpenAPI generation/validation/drift, and four-test built-process smoke baseline passed.
- Repository format and governance checks passed.
- The first OpenAPI and smoke attempts failed only because the managed sandbox rejected a local tsx IPC socket and loopback listeners; the same commands passed unchanged with those local runtime permissions, so no product baseline failure was recorded.

### 2026-07-11: Phase 1 Workspace Review Integrity and Git Safety Complete

- Landed the Phase 1 behavior in `03c3933` (`fix(nanocore): preserve workspace review integrity`), `48317de` (`fix(worker-shim): preserve git workspace snapshots`), and `7758348` (`fix(nanocore): harden workspace review lifecycle`) after the scoped NanoCore and worker-shim regression commits from `92e151d` through `d0aacd9` established the failure cases first.
- Replaced duplicated artifact and dedicated workspace-review decisions with one serialized application command, made review reads side-effect free, preserved terminal review state, and made artifact claim recovery explicit and retryable.
- Moved local review Git execution out of `app.ts` into one cohesive owner with restricted child environments, canonical repository serialization, exact reviewed-path commits, filter rejection, ref compare-and-swap, canonical review-branch ownership validation, and compensation across staging, apply, discard, persistence failure, and retry.
- Made worker-shim snapshots preserve Git metadata and reviewed path lineage without consuming unrelated staged work, and kept the CLI as a thin caller of one workspace Git owner.
- Made filesystem apply use deterministic replacement paths, one strict rollback marker, deterministic preparation ownership, overlapping-target reservations, marker-last cleanup, exact lineage validation, immutable rollback evidence, safe parent-directory rollback, and idempotent process-restart recovery without wildcard cleanup.
- Bound Agent Environment Package scope and workspace synchronization storage to the actor-owned `FsStore` user id instead of `user_local`, and made both governed-worker and host-adapter callers pass the actor explicitly.
- Made governed turn completion and failure persistence tolerate falsey thrown values, setup failures, write-after-mutation errors, partial terminal persistence, and retry without producing duplicate terminal outcomes.
- Reduced `app.ts` from the recorded 15,714-line baseline to 15,098 lines while keeping the complete review workflow traceable through `runtime/workspace-review-application.ts`; the larger route-family decomposition remains Phase 3 work rather than being mixed into this safety phase.
- Independent reviews closed every confirmed P0-P2 finding across Git ownership, filesystem rollback, actor isolation, Action Center recovery, terminal persistence, and concurrency; the final filesystem recovery suite passed 46 of 46 tests.
- Final NanoCore verification passed with 201 test files passed, 1 skipped, 1,409 tests passed, and 7 skipped; typecheck, lint, build, OpenAPI generation/validation/drift, repository format and governance checks, and four of four built-process smoke tests also passed.
- Accepted ceilings remain explicit: filesystem and Git serialization are process-local under the single-instance data-root lock, filesystem recovery covers process restart under the documented one-external-writer assumption, and host-power-loss durability requires a future repository-wide cross-platform fsync primitive rather than a bespoke local abstraction.

## Implementation Summary

In progress.

## Final Verification

Pending.
