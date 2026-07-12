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
- Restore one fail-closed worker capability trust boundary that resolves actor-owned storage from the authenticated Agent Environment Package, validates the requested capability against that package, and does not depend on product-auth context that is absent on worker routes.
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
- Worker-control and worker-capability routes remain outside product auth only through their explicit sandbox-token boundary; authenticated package ownership, route allowlists, policy, and replay semantics cannot fall back to `user_local` or a partially restored session.
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
- Before moving worker routes, add failing tests for server-mode owner resolution, package route authorization, restored-session fail-closed behavior, canonical control operation evidence, and exact proposal replay; preserve the separate worker-control, worker-capability, and product-auth middleware insertion points during extraction.
- Move worker wire schemas toward their existing protocol/config owners only after the behavior boundary is locked; do not mix a wire-format migration with the first route movement.
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
- Risk: mechanically moving the pre-auth worker routes preserves an unsafe server-mode `user_local` fallback or bypasses Agent Environment Package capability policy. Mitigation: characterize the accepted fail-closed trust boundary first, resolve stores from authenticated package ownership, and keep semantic fixes in test-first commits separate from route movement.
- Risk: workspace import publishes the staged workspace before writing portable Vault and injection metadata to Core DB, so a later Core DB failure can leave a published workspace with partial companion metadata. Mitigation: preserve the current success path during mechanical extraction, then characterize failure injection separately and add explicit compensation or recovery before changing the cross-store ordering.
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

### 2026-07-11: Phase 2 OpenAPI and Route Registration Ownership Complete

- Landed the Phase 2 TDD, implementation, and review-test chain from `e66c136` (`test(nanocore): expose openapi projection drift`) through `105c6b1` (`test(nanocore): verify served openapi versions`), including focused red/green commits for each migrated route group, semantic invariants, version markers, canonical path parameters, and L3/L5 serving assertions.
- Replaced source-text route scanning with a bidirectional comparison of the default app's explicit GET, POST, PUT, PATCH, and DELETE Hono entries, the generated operation catalog, and runtime registrations. All 136 documented operations now register through one shared `operationId` entry point, while every inspected non-App route must match a closed Core, auth, worker, gateway, diagnostic, or deterministic-test classification; middleware, `ALL`, and conditionally mounted browser-auth entries remain with their owning tests.
- Made the canonical OpenAPI catalog own each documented method and path. Runtime registration derives the Hono method and path from that catalog, preserves Hono path-parameter typing, rejects duplicate or unknown operation ids, and keeps the existing handler bodies and route order unchanged.
- Added generic semantic checks for unique lower-camel operation ids, explicit security, shared default `ApiError` responses, resolvable schema references, selected shared-schema projection fidelity, and canonical Core id parameter references. The bootstrap-token operation now explicitly declares its intended unauthenticated posture.
- Replaced the hand-written capability-usage response projection with `CapabilityUsageResponseSchema` and replaced 121 duplicated path-parameter constraints with the six existing Core id schemas. The post-TDD ponytail review then inlined the three single-use parameter descriptors while retaining the genuinely reused workspace, thread, and turn descriptors.
- Identified the document as App API `0.1.0`, recorded the current Core protocol version separately through `x-openkit-protocol-version`, included both in the projection-content digest, and made NanoCore instantiate and serve one module-level document per process rather than rebuilding it per request.
- Clarified that the existing Core HTTP/SSE projection remains outside the App API OpenAPI document and is governed by `@openkit/protocol`, `@openkit/core-client`, and the Core documents. A future App API-owned stream remains subject to the conditional OpenAPI streaming rule.
- Reduced `openapi.ts` from 5,814 lines at the Phase 1 checkpoint to 5,226 lines and `app.ts` from 15,098 to 15,034 lines without using line count as a target. Structural normalization proved the generated document otherwise identical after accounting for the 121 canonical references, six shared components, and updated digest.
- Independent route-diff, registry, documentation, and ponytail reviews found no behavior drift. The single-use-entity cleanup was applied in `9968bc7`, L3/L5 version serving was made explicit in `105c6b1`, and every identified documentation overstatement was narrowed to the verified implementation boundary.
- Final Phase 2 verification passed with 201 test files passed, 1 skipped, 1,413 tests passed, and 7 skipped; typecheck, lint, build, OpenAPI generation/official-schema validation/drift, repository format and governance checks, and four of four built-process smoke tests also passed.

### 2026-07-11: Phase 3 Vertical Decomposition In Progress

- Extracted the complete workspace synchronization route family in `e71e46c`, Agent Environment Package snapshot reads in `8dd5885`, Codex OAuth routes in `b05e13d`, and the contiguous governance/provenance surface in `2764068`. One-time AST comparisons preserved every moved handler and helper, live route registration order remained unchanged, and focused server/OpenAPI regressions passed after each slice.
- Moved the shared approval-decision query to its existing policy owner in `4bf8d4e` and collapsed three identical vault material conversion helpers into the vault boundary in `e0d5d1d`; no controller, service, repository façade, named dependency interface, or pass-through wrapper was introduced.
- Reduced `app.ts` from the 15,034-line Phase 2 checkpoint to 13,772 lines while retaining middleware and route mounting in the composition root. The extracted modules are organized by complete feature path rather than line-count targets.
- A pre-extraction worker trust-boundary audit found accepted-behavior defects that must not be hidden by mechanical movement: worker capability routes run before product auth and currently resolve server-mode storage through an absent Hono actor, falling back to `user_local`; non-MCP knowledge and artifact capabilities authenticate lineage but do not validate the resolved package route catalog; restored sessions retain partial capability access without package ownership; proposal-summary exact replay can rewrite timestamps; and command-poll rejection evidence uses `commands_poll` instead of the canonical `command_poll`.
- The same audit found local worker request schemas duplicated across NanoCore, worker-shim, worker-protocol, and config schemas. The first worker step will lock owner, package authorization, replay, and control evidence with failing tests; route extraction will follow as a behavior-preserving commit; protocol schema convergence will remain a separate change so wire-format and movement regressions stay distinguishable.
- Closed the worker trust defects in `0670255` after dedicated failing-test commits established package-owned store resolution, store-owner fail-closed behavior before workspace membership backfill, disabled capability-plane denial, exact Agent Environment Package route authorization, restored-session package requirements, canonical command-poll evidence, and proposal collision/replay semantics. Exact retries preserve human-edited proposal state, while rejected collisions no longer consume a gateway sequence or create accepted evidence.
- Moved MCP tool schema snapshot persistence into its storage owner in `33fa578`, then extracted the ten worker-control routes in `2ca5568` and eight worker-capability routes in `9a45ee1`. The composition root still mounts worker-control CORS and routes, worker-capability CORS and routes, and only then the generic product CORS and Better Auth middleware. One-time TypeScript AST comparisons reported 10 of 10 control handlers and 8 of 8 capability handlers unchanged; the capability comparison also matched all 19 private functions and 21 schemas or constants.
- Added a closed 22-entry route-plane order characterization in `61123e6`. After extraction exposed four simple worker-control endpoints that parsed unbounded JSON before sandbox authentication, `a5d2703` captured the failure and `face592` made heartbeat, artifact notice, command poll, and command acknowledgement share the existing 64 KiB bounded parser contract. Envelope, event append, and terminal result limits remain 64 KiB, 256 KiB, and 1 MiB respectively.
- Reduced `app.ts` to 11,498 lines without moving middleware ownership or introducing controller, service, repository, named dependency-container, or gateway pass-through layers. The worker-control registrar has four real dependencies, the worker-capability registrar has five, and each extracted module exposes only its registrar while keeping schemas and application helpers private.
- Latest NanoCore verification passed with 201 test files passed, 1 skipped, 1,425 tests passed, and 7 skipped; typecheck, lint across 478 files, build, OpenAPI generation/validation/drift, focused Server/OpenAPI tests, route-order tests, and independent correctness, security, and simplicity reviews also passed. Worker wire-schema convergence remains pending as a separate Phase 3 slice.
- Extracted the five server bootstrap and access-token lifecycle routes in `1ebef70` while leaving the Better Auth catch-all and product authentication middleware in the composition root. TypeScript AST comparison preserved all five handlers and both private helpers, and the registrar receives only the app, mode, optional Core DB, and active-membership predicate.
- Extracted workspace export, import dry-run, and import as one portability feature path in `6311643`. The existing collision helper moved with the routes, all three handlers and the helper matched the pre-extraction TypeScript AST after normalizing the Core DB dependency name, and the registrar remains between data-root backup verification and the OpenAPI document route. The module intentionally keeps the complete record-family mapping together instead of adding registry, adapter, controller, service, or repository layers.
- Reduced `app.ts` to 10,634 lines. The latest NanoCore verification passed with 201 test files passed, 1 skipped, 1,425 tests passed, and 7 skipped; the 159 focused workspace-transfer, export-format, Server, and OpenAPI tests, typecheck, lint across 480 files, build, OpenAPI generation/validation/drift, and independent lifecycle and simplicity reviews also passed.
- The workspace-transfer review exposed a pre-existing cross-store failure gap: the staged workspace is atomically published before portable Vault and injection metadata is imported into Core DB. This is recorded as a separate test-first reliability repair because changing failure compensation during the mechanical route move would obscure whether route behavior drifted. Worker wire-schema convergence also remains pending as a separate Phase 3 slice.
- Removed two composition-root utility ownership leaks in `1cdbf48`, extracted the complete Knowledge route family in `2e39a89`, reused the canonical protocol list schema in `0364a45`, extracted runtime-config administration in `d4cf3b5`, and extracted Vault administration in `c11dea1`. Each slice retained a single registrar with concrete dependencies and private feature helpers rather than adding controller, service, context-container, or pass-through layers.
- The Vault extraction review exposed a real authorization chain rather than treating it as mechanical-move noise: any Better Auth session could administer access tokens, mint a `server-admin` credential, and reach global Vault operations; session workspace requests also lacked an active-membership gate, and server VaultUse readback remained outside the Vault owner without deployment-admin authorization. Failing tests landed in `f5b363e`, `73b914c`, `b4709b8`, and `354e2b4` before `1c2ff05` made session and scoped-token membership checks fail closed, restricted token administration to `server-admin` bearer tokens, moved server VaultUse readback from governance to the Vault registrar, and applied one local-or-`server-admin` guard to all five global Vault surfaces.
- Reduced `app.ts` to 8,891 lines while preserving the composition root as the owner of middleware and feature mounting. The Knowledge, runtime-config, and Vault modules keep their complete feature paths together; line count remains an observation rather than a split target.
- Latest NanoCore verification passed with 201 test files passed, 1 skipped, 1,431 tests passed, and 7 skipped; typecheck, lint across 483 files, build, OpenAPI generation/validation/drift, focused auth/Vault/Server/OpenAPI coverage, and independent security and Ponytail reviews also passed.
- The Vault review also recorded two separate reliability limits for later test-first repair: backend material is written before Core DB metadata during Codex auth bootstrap and workspace reference rebind, so a metadata failure can leave partial material, and failed-unlock throttling remains process-local with actor keys retained until reused or successfully cleared. These are not hidden inside the completed route movement or authorization fix.
- Extracted the nine-route interrupted-worker recovery feature path in `2f49819`. All nine handler ASTs remained exact after normalizing only the injected Core DB name, the registrar stays at the original registration point, and the module keeps pending-user-turn editing, follow-up conversion, interrupt promotion, checkpoint retry, and terminal clearing together rather than splitting one lifecycle across single-route files.
- The recovery review found that `GET /api/app/recovery/interrupted-workers` opened every workspace DB in a scoped token owner's store because the global GET had no workspace id for middleware gating. `c4e7f79` captured server-admin, workspace, workspace-readonly, and removed-membership cases before `6569ee8` reused the existing collection-visibility policy at the registrar boundary so unauthorized workspace databases are filtered before opening.
- Extracted artifact, Knowledge, and Goal review decisions as one human-review write-side feature path in `29d8a60`. Three route handlers and three private projection helpers remained AST-equivalent after normalizing only the injected Core DB name; artifact pending-claim recovery, workspace apply/rollback, durable conflict handling, replay, follow-up creation, and all workspace DB cleanup paths stayed intact. The post-extraction review also removed one stale JSDoc parameter rather than preserving incorrect documentation in the new owner.
- Reduced `app.ts` to 7,845 lines while keeping the composition root responsible for middleware and feature mounting. Latest NanoCore verification passed with 201 test files passed, 1 skipped, 1,431 tests passed, and 7 skipped; typecheck, lint across 485 files, build, OpenAPI generation/validation/drift, focused Server/OpenAPI coverage, and independent correctness and Ponytail reviews also passed.
- The recovery review recorded one further existing cross-store partial-state limit: the deterministic interrupted-recovery seed route creates its turn and item in `FsStore` before writing the checkpoint and pending-user-turn rows to the workspace database, so a later workspace DB failure can leave the first store mutated. This requires a separate test-first compensation decision and was not mixed into the mechanical extraction.
- Extracted storage layout reporting plus data-root backup creation and verification into `storage/data-root-admin-routes.ts` in `ae53a0c`. All three handler ASTs and both private helpers remained exact, route order stayed layout, create, then verify, and the registrar requires only the app and optional data root. This reduced `app.ts` to 7,744 lines without creating a controller, service, repository, or dependency-container layer.
- The extraction audit found that Better Auth sessions could reach all three deployment-wide storage operations and workspace-scoped tokens could read the global layout report. `403e1c3` captured the five-actor matrix before `ce3d08c` removed duplicate local coverage and `4f26f9c` applied one feature-local guard before any route-owned data-root read, input parsing, UUID creation, or filesystem write. The final matrix allows only the implicit local actor and `server-admin` bearer tokens; sessions, `workspace` tokens, and `workspace-readonly` tokens receive `403 Forbidden`.
- Latest NanoCore verification passed with 202 test files passed, 1 skipped, 1,432 tests passed, and 7 skipped; typecheck, lint across 487 files, build, OpenAPI generation/validation/drift, 154 focused storage/Server/OpenAPI tests, and independent authorization, correctness, documentation, and Ponytail reviews also passed.
- Extracted the two global Agent Catalog read routes and their three private projection helpers into `agents/catalog-routes.ts` in `43fbeb7`. TypeScript AST comparison preserved all three helpers and both handlers, list-before-detail registration stayed between App Search and repository routes, and the registrar now receives only the app, request-scoped store resolver, and the existing workspace-visibility policy. This reduced `app.ts` to 7,676 lines without adding a controller, service, repository, or parallel policy helper.
- The extraction review found that the global routes had no workspace path parameter, so `workspace` and `workspace-readonly` tokens could traverse every workspace in their owner store. `1f4e641` captured server-admin access, both scoped-token kinds, bound active membership, hidden detail indistinguishability, and membership removal before `ba82495` reused `visibleWorkspacesForActor` ahead of catalog aggregation and detail lookup. Scoped tokens now see only bound workspaces with active membership, hidden entries resolve like absent entries, and adapter-native config remains excluded.
- One semantic mismatch remains deliberately open: the current global routes form a de-duplicated union of actor-visible workspace catalogs and select the first visible entry when agent ids collide. `docs/core/agent-supply.md` continues to own the target workspace-visible catalog semantic; this change closes the authorization leak but does not declare the global union or first-wins collision rule canonical. A later contract decision must choose an explicit workspace route shape or a deliberate cross-workspace index before changing this behavior.
- Latest NanoCore verification passed with 203 test files passed, 1 skipped, 1,433 tests passed, and 7 skipped; typecheck, lint across 489 files, build, OpenAPI generation/validation/drift, 20 focused Agent Catalog/auth/OpenAPI tests, and independent authorization, correctness, documentation, and Ponytail reviews also passed.
- Extracted the complete three-route Scheduler Admission list/retry/cancel App API family into `runtime/scheduler-admission-routes.ts` in `641fb73`: the routes remain in their original order between Human Attention and governance registration, all three handler ASTs remained exact after normalizing only the injected Core DB name, and the registrar has four concrete dependencies without a controller, mapper, service, or scheduler context object. This reduced `app.ts` to 7,557 lines.
- The extraction review found that retry and cancel opened a workspace database for their audit write without closing it. `2086800` captured retry success, cancel success, and injected audit failure before `d533fa7` simplified the proof to direct SQLite open-state assertions and `a4c773c` added explicit `try/finally` ownership around both audit writes.
- The same review found a cross-workspace queue-entry existence oracle. `3c9ace5` proved that retry and cancel returned different bodies for a foreign entry and the same absent entry before `9ac2fd0` moved the workspace guard into the shared admission lookup. Ownership mismatches now fail like absent entries before status inspection, mutation, workspace audit-database access, or audit writes.
- Deeper review then found that different users can legitimately retain the same imported workspace id. `99ae8fb` captured cross-user list/retry/cancel isolation, foreign-vs-absent response equality, unchanged victim state, and no workspace audit-database access; `1e82b91` independently captured Action Center isolation. `e4e0800` made list and Action Center projections require the request store owner plus workspace id, made retry/cancel owner inputs mandatory, and made each mutation compare-and-set the queue id, user id, workspace id, and expected status before checking the affected row count. Other internal uses of the shared admission lookup remain unchanged.
- Two separate lifecycle limits remain deliberately open rather than hidden by local wrappers: retry and cancel still commit the server Core DB mutation before the workspace audit write, so an audit failure produces an ambiguous cross-store partial result, while the shared `repositoryWorkspaceDb` acquisition path can leak a just-opened workspace DB handle if scoped migration fails before the caller receives it. The first belongs in the later cross-store consistency repair with the already recorded import, Vault, and recovery partial-state cases; the second belongs in shared workspace-DB acquisition cleanup.
- Latest NanoCore verification passed with 204 test files passed, 1 skipped, 1,437 tests passed, and 7 skipped; typecheck, lint across 491 files, build, OpenAPI generation/validation/drift, 189 focused Scheduler Admission/Action Center/record/Server/OpenAPI tests, and independent lifecycle, authorization, correctness, documentation, and Ponytail reviews also passed.
- Extracted the complete App Search route into `search-routes.ts` in `5ca8b9f`. The handler remained textually equivalent, registration stayed between Automation and Agent Catalog, and the registrar initially retained only the app and request-scoped store resolver. This reduced `app.ts` to 7,485 lines without adding a search service, controller, mapper, policy helper, or route context object.
- The extraction review found that the global route had no workspace path parameter and searched every workspace in a scoped token owner's store. `8f37cd9` captured matching workspace, thread, knowledge, artifact, and item data in allowed and denied workspaces before `38a4e67` removed redundant actor cases while preserving the failing proof. `040813c` reused `visibleWorkspacesForActor`, resolves the request store once, and applies one visible workspace set to all five result kinds. Scoped tokens now require both token binding and active membership, while local actors, sessions, and `server-admin` tokens retain their existing full-store behavior.
- Restart review then found that startup owner-membership backfill could recreate a deleted membership and restore Search visibility. `d036f92` captured that restart failure. The first implementation in `1b520ee` incorrectly treated the global workspace registry row as the tombstone and would have blocked a second user that legitimately retained the same imported workspace id; independent review rejected it before the checkpoint closed. `abf140f` replaced the hard-delete fixture with the explicit `removed` lifecycle state and added the cross-user same-id case, `8c5a37a` removed redundant fixture fields, and `0f9232d` made registry ownership first-write-wins while independently inserting each user's membership with conflict-preserving semantics. Repeated backfill now retains `removed` membership rows, a second user can still acquire a distinct active membership, and hard deletion is explicitly unsupported because it discards the tombstone.
- One related import lifecycle limit remains open: a workspace imported into an already cached user store does not immediately register its membership in the current process and relies on the next store reconstruction. This belongs with the existing workspace-import cross-store publication repair rather than a Search-specific wrapper.
- Latest NanoCore verification passed with 204 test files passed, 1 skipped, 1,439 tests passed, and 7 skipped; typecheck, lint across 492 files, build, OpenAPI generation/validation/drift, 16 focused Search/membership/Agent Catalog/access-token/server-auth tests, and independent equivalence, authorization, lifecycle, correctness, and Ponytail reviews also passed.
- Extracted the five contiguous Core Thread list/create/get/update/archive routes into `thread-routes.ts` in `882cee7`. All five handler ASTs and their list-before-create-before-detail-before-update-before-archive order remained exact, the registrar stayed between Knowledge registration and turn creation, and the new owner receives only the app, request-scoped store resolver, and shared in-flight idempotency ledger. The same commit removed the redundant NanoCore-local list response schema and reused `@openkit/protocol`'s `ListThreadsResponseSchema` without changing the current `{ items }` response. This reduced `app.ts` to 7,354 lines without adding a controller, service, mapper, repository, context object, or thread helper.
- The extraction review recorded one shared idempotency lifecycle limit rather than hiding it in the Thread module: `runIdempotentCommand` persists the resource effect before its command ledger row, so a process crash between those writes can replay a create, and an accepted replay returns the current resource snapshot rather than the original response. This affects the shared command path and belongs in a later cross-command durability repair.
- Latest NanoCore verification passed with 204 test files passed, 1 skipped, 1,439 tests passed, and 7 skipped; 140 focused Server/server-auth tests, typecheck, lint across 493 files, build, repository lifecycle validation, Biome across 761 files, and independent AST, correctness, DRY, and Ponytail reviews also passed.
- Extracted the five contiguous Core Workspace list/create/detail/resources/update routes into `workspace-routes.ts` in `e522635`. After normalizing only the injected Core DB name, all five handlers remained equivalent and in their original order between Agent Health and Knowledge registration. The registrar receives only the app, optional Core DB, shared in-flight idempotency ledger, request-scoped store resolver, and existing workspace visibility policy, and all route schemas continue to come directly from `@openkit/protocol`. This reduced `app.ts` to 7,259 lines without adding a controller, service, mapper, repository, helper, or route context object.
- Authorization review confirmed that workspace-scoped tokens already fail closed on global mutating requests without a workspace id, so `POST /api/workspaces` did not require a new route-local policy. One real lifecycle limit remains: create publishes the FsStore workspace before Core registry/membership and command-ledger persistence, so a later failure can leave an untracked workspace and a same-request retry can create another one. This joins the shared cross-store/idempotency consistency repair rather than receiving a Workspace-only outbox or transaction wrapper.
- The extraction review also found that `FsStore.updateWorkspace` used nullish fallback for nullable default model and agent ids, so protocol-valid explicit `null` values could not clear an existing selection. `7d6b0ce` captured the route-level failure before `ce79a21` changed only those two fields to distinguish `undefined` from `null`; omitted and partial defaults retain prior values, explicit null clears, strings replace, and skill-array behavior is unchanged. The Web test fake client still uses the old nullish merge and must be aligned with a UI-level clearing test during the Web phase rather than changing production behavior here.
- Latest NanoCore verification passed with 204 test files passed, 1 skipped, 1,440 tests passed, and 7 skipped; 156 focused Workspace/Server/store/auth/membership tests, typecheck, lint across 494 files, build, repository lifecycle validation, Biome across 762 files, and independent AST, authorization, correctness, lifecycle, DRY, and Ponytail reviews also passed.
- Moved the single workspace Action Center route into its existing feature owner `action-center.ts` in `5102301` rather than creating another one-route file. Registration stayed between repository setup and Scheduler Admission, the registrar has only the app, optional Core DB, workspace DB resolver, and request store, and its acquisition/close/error behavior remained equivalent. The same review deleted the now single-use `buildHumanAttentionResponse` pass-through, made the projection input and row builder private, and reduced the response boundary from two schema parses to one. This reduced `app.ts` to 7,241 lines without splitting the cohesive Action Center projector merely because its owner file is large.
- Latest NanoCore verification passed with 204 test files passed, 1 skipped, 1,440 tests passed, and 7 skipped; 159 focused Action Center/Server/OpenAPI tests, typecheck, lint across 494 files, build, OpenAPI generation/validation/drift, repository lifecycle validation, Biome across 762 files, and independent ownership, lifecycle, correctness, DRY, and Ponytail reviews also passed.
- Made `SubmitTurnFeedbackRequestSchema` strict in `9756c27` after `8f2df85` captured the shared-package failure. NanoCore and the Core Client now reject unknown feedback fields through the same request schema, and the OpenAPI document projects that canonical schema instead of describing a parallel shape.
- Extracted the feedback submission route into `runtime/feedback-routes.ts` in `26e73d5` because `runtime/feedback.ts` is imported by `FsStore` and must remain independent of Hono. The registrar receives only the app and request-scoped store resolver, while the storage module now uses the public feedback request and response types and retains one private strict schema only for the disk boundary. This removed the duplicate rating, request, response, and persisted-record owners without introducing a controller, service, context object, or dependency inversion.
- Latest NanoCore verification passed with 204 test files passed, 1 skipped, 1,440 tests passed, and 7 skipped; 152 focused feedback/Server/OpenAPI tests, all 53 App API schema tests plus package typecheck, lint, and build, all 22 Core Client tests, NanoCore typecheck, lint across 495 files, build, OpenAPI generation/validation/drift, repository lifecycle validation, Biome across 763 files, and independent contract, route-boundary, storage, dependency, correctness, and Ponytail reviews also passed.
- Captured two distinct agent-session lineage failures before implementation: `3fd9f27` proved that an active runtime session borrowed `configVersion` and `workspaceRoots` from an unrelated persisted session when ids differed, and `6851a28` proved that two Agent Environment Package snapshots sharing one agent-session id caused the dashboard to project the older package's heartbeat and artifact notices.
- Moved the shared active-session and stale-session projections plus their worker-control summary into `runtime/agent-session-read-model.ts`, and moved the workspace and thread dashboard routes into their existing `app-dashboard.ts` feature owner in `661f8e4`. The dashboard registrar receives six concrete current owners, resolves the actor store once per request, preserves dynamic provider and runtime-config reads, and stays at the original registration point before the terminal-command route.
- Deleted eleven local dashboard type and interface declarations by reusing `@openkit/app-api-schemas` response types and inlining the two single-use input shapes, made three single-owner projection builders private, and replaced the remaining single-use callback input bag with direct store inputs. `app.ts` fell from 7,223 to 7,007 lines, while `app.ts`, `app-dashboard.ts`, and the one new session read-model module fell from 7,726 to 7,646 production lines in total; the new module is a shared owner rather than displaced volume.
- Active-session enrichment now uses persisted session metadata only when the session id matches. Live worker-control state uses the exact persisted package snapshot when available, returns `control: null` when that exact snapshot is not live, and permits an agent-session fallback only when persisted package lineage is absent and the snapshot still matches the active session, workspace, and thread.
- Latest NanoCore verification passed with 204 test files passed, 1 skipped, 1,442 tests passed, and 7 skipped; 155 focused workspace-dashboard, thread-dashboard, runtime-config-reload, Server, and OpenAPI tests, typecheck, lint across 496 files, build, OpenAPI generation/validation/drift, repository lifecycle validation, Biome across 764 files, and independent route-order, behavior, lineage, dependency, DRY, and Ponytail reviews also passed.
- The dual-package regression in `1ac8f73` proved that terminal commands target the persisted active package and that an unavailable exact package fails closed without queueing to an older worker; the same commit extended the existing terminal-command test to prove that an incorrect agent-session id cannot mutate the queue. `a8b4ae7` moved the terminal-command route into the existing dashboard/active-session owner and made both the read projection and mutation share one package-aware, scope-validating control-snapshot resolver.
- The terminal route checks the active runtime session id directly before one persisted-session lookup and one gateway lookup, avoiding the previous unnecessary session enrichment, runtime-config read, AgentSession read-model parse, and second control-snapshot lookup. No file, type, callback bag, service, factory, or single-implementation interface was added. `app.ts` fell from 7,007 to 6,953 lines; the three production owners grew by 29 lines in total because the formerly ambiguous session-id lookup became one documented package-aware, scope-validating policy shared by two real consumers.
- Latest NanoCore verification remained at 204 test files passed, 1 skipped, 1,442 tests passed, and 7 skipped; the 155 focused Dashboard/runtime-config/Server/OpenAPI tests, typecheck, lint across 496 files, build, OpenAPI generation/validation/drift, repository lifecycle validation, Biome across 764 files, and independent mutation-safety, route-order, lineage, TOCTOU, dependency, and Ponytail reviews passed.
- Added Core Artifact list, detail, Markdown, text, and JSON-content characterization in `9e2c75e` while retaining the existing metadata-update and idempotency coverage, then used `868edf3` to prove that a PATCH through one workspace path could mutate a known artifact owned by another workspace in the same user store. `0651582` made `FsStore.updateArtifact` require and verify the owning workspace, reused the existing scoped getter so absent and foreign artifacts remain indistinguishable, narrowed updates to the five fields needed by the two real callers, and updated the simulator caller.
- Extracted the four Core Artifact list, detail, metadata-update, and content routes into one `artifact-routes.ts` owner in `1a3b607`. The registrar receives only the app, request-scoped store resolver, and shared idempotency ledger, preserves content status/MIME/JSON and command error behavior, and registers all four raw Core routes together before the unchanged workspace-sync, Agent Environment, and review-decision App API sequence.
- Deleted the NanoCore-local `ListArtifactsResponseSchema` and reused the canonical protocol response schema without adding its optional cursor field to current responses. The focused test file now matches its owner as `artifact-routes.test.ts`; no controller, service, repository, content renderer, MIME table, DTO, dependency interface, or single-route registrar was introduced. `app.ts` fell from 6,953 to 6,858 lines; the new 115-line owner makes the two production files 20 lines larger in total because the ownership boundary carries its explicit imports, dependency contract, and documentation rather than hiding the routes in the composition root.
- Latest NanoCore verification passed with 204 test files passed, 1 skipped, 1,444 tests passed, and 7 skipped; the six focused Artifact/Server/OpenAPI tests, three simulator tests, typecheck, lint across 497 files, build, OpenAPI generation/validation/drift, repository lifecycle validation, Biome across 765 files, and independent authorization, handler-equivalence, route-matching, operation-order, dependency, DRY, and Ponytail reviews also passed.
- Added the cross-workspace replay regression in `4c1ca97` and the cancelled-stream cleanup regression in `7bf68f7` before `9655404` bound every event stream to the requested workspace and thread and made abort, terminal, and exceptional exits release their retained listener exactly once. Missing and foreign turns remain indistinguishable, while existing query validation, cursor expiry, replay, and terminal-cursor `204` behavior remain unchanged.
- `aac9630` then captured a real replay-to-subscription race in which Hono backpressure produced sequences `[1, 2, 4]` and permanently lost sequence 3. `a48f751` now queues retained events and registers the live listener before the first `await`, serializes replay and live writes through one local Promise tail, and advances one monotonic sequence gate so ordering, deduplication, terminal closure, and cancellation share one stream path without changing `FsStore` or adding a public abstraction.
- Extracted the complete Core turn event route into `turn-event-routes.ts` in `f03c387`, kept its registration at the exact pre-return position, and renamed the focused suite to `turn-event-routes.test.ts`. The registrar receives only the app and request-scoped store resolver; no controller, service, repository, DTO, dependency interface, or general streaming layer was added. `app.ts` fell from 6,858 to 6,780 lines, while the composition root and the new 127-line owner grew by 49 production lines in total because the repaired stream state machine is now explicit and cohesive.
- Latest NanoCore verification passed with 204 test files passed, 1 skipped, 1,446 tests passed, and 7 skipped; the 15 focused Turn Event/OpenAPI tests, typecheck, lint and formatting across 498 files, build, OpenAPI generation/validation/drift, repository lifecycle validation, Biome across 766 files, and independent authorization, lifecycle, ordering, route-registration, dependency, DRY, and Ponytail reviews also passed.
- A final Git push boundary review found three defects that could not be hidden by the pending Repository route movement: publication was not compare-and-swap bound to the observed remote head, the isolated bare view always used SHA-1 even for SHA-256 object databases, and a missing target branch used the entire local history as an accidental outgoing baseline. `45ed0e0` captured exact-lease, ancestry, object-format, missing-branch, replace-ref, and real concurrent-remote regressions before `5d2826d` made existing-branch pushes prove fast-forward ancestry and use an exact observed-head lease, matched the clean view to SHA-1 or SHA-256, and explicitly refused remote branch creation in V1. The accepted Git write specification now distinguishes this exact lease as CAS-only concurrency control rather than force-push authority.
- Refreshed the already-minimized public Git push execution projection in `504a2b2`, then extracted repository linking, diagnostics, Git push approval/execution, and Git push record routes into one `repository-routes.ts` owner in `7fef455`. The eight operations retain their original order between Agent Catalog and Action Center; the module receives only its concrete storage, idempotency, project-workspace, Core DB, and vault dependencies, and deletes the former approval-decision pass-through plus list-and-find repository lookup.
- `app.ts` is now 6,202 lines and the cohesive Repository owner is 699 lines; the two files total 30 more lines than the previous composition-root-only form because the ownership boundary now carries explicit imports, dependency documentation, and private security helpers. The latest full NanoCore test run, 195-test Repository/Git Push/Server/OpenAPI focus, typecheck, lint across 501 files, build, OpenAPI generation/validation/drift, and independent security, behavior, route-order, DB-lifecycle, DRY, and Ponytail reviews passed.
- Extracted Automation routes in `49a36e4`, Agent Health routes in `782a090`, Service routes in `ae27691`, and the complete Goal route family in `868c251`, then co-located the thread-item list route with the existing Thread owner in `7d71a56`. Each slice retained the original registration point and concrete dependencies without adding controller, service, mapper, repository, or universal context layers.
- `app.ts` is now 4,353 lines. The remaining composition-root work is limited to diagnostics/setup, LLM Gateway and mode entry points, Core turn commands, and final mounting/composition cleanup; Phase 3 remains open until those complete feature paths leave `createApp`.
- `d522c2e` characterized public Gateway ownership before `d9a0451` moved `/v1/models`, `/v1/chat/completions`, and `/v1/responses` plus their schemas, streaming normalization, durable usage attribution, and policy flow into `llm/gateway-routes.ts`. All three handlers, fourteen helpers, and two schemas remained AST-equivalent after normalizing the injected Core DB reference, and the registrar stayed at the original public route position.
- `3ae5e39` moved terminal scheduler-lease completion beside its scheduler record owner before `e190aaa` extracted the complete approval response lifecycle. The extraction exposed scope, retry, action-id, and cross-store convergence gaps; failing tests in `48e1454`, `8e331d5`, and `9f407d5` preceded `e7dd750`, which now validates scope before mutation, records policy approvals through the existing idempotency ledger, rejects opposite decisions, repairs partial FsStore progress without duplicating items or decisions, preserves terminal turns, replays across runtime capability changes, and commits permission decisions with their generated audit rows in one SQLite transaction.
- `46cbb5a` established ownership for Quick Chat, Chat Mode, and Task Mode before `ec2ed30` moved all three mode-entry handlers and their exclusive usage, provider-error, delegation, repository-inspection, and Task projection helpers into one `mode-entry-routes.ts` owner with two registrars at the original non-contiguous registration points. Three handlers and twenty-four moved entities remained AST-equivalent after the documented dependency normalization; `6741331` then removed four temporary pass-through wrappers, optional delegation flexibility that no caller used, and the resulting unreachable null branch.
- `app.ts` is now 1,938 lines, down from the 15,034-line Phase 2 checkpoint and the 15,714-line recorded baseline. The 1,496-line mode-entry owner remains intentionally cohesive around the complete mode-selection path; line count is evidence of composition-root recovery rather than a target. Latest NanoCore verification passed with 188 test files passed, 1 skipped, 1,416 tests passed, and 7 skipped; focused mode, approval, permission, scheduler, Server, simulator, and OpenAPI tests, typecheck, lint across 476 files, build, OpenAPI generation/validation/drift, and independent correctness and Ponytail reviews also passed.
- `6df4892` and `56e3563` captured scope, capability, terminal-state, replay, scheduler-accounting, recovery-promotion, and false executor capability failures before `d09bc3e` and `6eab5eb` made generic and recovery interrupts validate ownership and runtime support before mutation, made terminal turns irreversible, completed scheduler leases for synchronous completion and interruption, replayed successful starts before mutable repository validation, and made the one-shot Worker Governance executor reject the interrupt operation it advertises as unsupported.
- `9da776e` moved the complete generic turn start, user-input continuation, feedback, scoped read, and interrupt route sequence into `turn-routes.ts`, moved scheduler admission and dispatch into `runtime/product-turn-start.ts`, and moved repository, root materialization, and source-context preparation into `runtime/turn-workspace-context.ts`. Goal routes now import the concrete workspace-context owner instead of receiving three callback dependencies, and the existing model-to-agent resolver is shared rather than duplicated.
- The composition root is now 1,396 lines and contains no product route handlers beyond diagnostics and the OpenAPI document; it retains middleware, authentication mounting, live dependency composition, and the narrow helpers that close over process-owned state. The turn extraction introduced no controller, service, façade, compatibility alias, pass-through wrapper, or generic context container, and independent review returned GO.
- Post-repair verification passed 228 focused turn, scheduler, Worker Governance, recovery, and Server tests; post-extraction verification passed 157 turn, feedback, and Server tests plus NanoCore typecheck, lint across 480 files, build, formatting, and diff checks.

### 2026-07-11: Phase 4 Provider Ownership Convergence Complete

- `26786fd` first proved that dashboard provider counts ignored the live runtime registry; `f83317c` made both dashboard projections read the current registry instead of the absent legacy config store.
- `3e6d135` removed `LLMProviderConfigStore`, its fallback defaults, the parallel provider-health path, and the obsolete config-store tests. Runtime provider profiles now own configured instances, defaults, credentials, capabilities, diagnostics, dashboard counts, quick chat, internal agents, and Gateway dispatch.
- `9d8db49` captured the required configured-instance-to-adapter projection before `8f88067` deleted the static `LLM_PROVIDER_SPECS` registry and flattened the internal dispatch shape. The remaining projection contains only dispatch-owned fields and reuses the runtime registry's credential and capability rules.
- Independent review found and closed an endpoint and credential-isolation defect before commit: catalog adapters are now rebound to the configured instance id and endpoint, auth resolution accepts only the explicitly resolved credential, ambient provider environment keys stay invisible, unknown custom models are synthesized only against their configured endpoint, adapter identity wins over colliding instance ids, and fallback adapter ids use one normalization rule.
- The phase removed 560 net lines in its final projection commit and passed independent correctness and Ponytail reviews. Final NanoCore verification passed with 202 test files passed, 1 skipped, 1,455 tests passed, and 7 skipped; typecheck, lint across 499 files, build, and OpenAPI generation, validation, and drift checks also passed.

### 2026-07-12: Phase 5 Deletion and Directory Cohesion In Progress

- `5cfca38`, `ba7ab2e`, `e0567a7`, `b018094`, and `48efc61` removed production-unreachable direct LLM, planning, internal-tool, retired host-runtime, and runtime-helper islands after entry-point and accepted-spec checks.
- `6294453` moved the root Vault implementation and tests into `src/vault/` without moving storage-owned schemas or provider-owned credential resolution.
- `b3e18b6` and `ba6fcd5` captured and bounded hanging worker MCP sessions before `0a7e15c` removed the dead one-shot stdio API and made the cached gateway the single worker MCP session owner, including explicit Vault-credential lifecycle handling.
- The dedicated [Goal Mode Review Gate and Completion Repair](202607121123210001-goal_mode_review_gate_and_completion_repair.md) captured and repaired a live semantic defect exposed during dead-code review: human review was not actionable, `none` could skip remaining tasks, accepted review replay could drift, and terminal summaries invented a nonexistent final-verification gate.
- Goal Mode now uses one accept-and-advance path, one actionable Goal Review projection, and one immutable first-resolution snapshot. The unsupported `auto` contract, fabricated final-verification risk, unused verification runner, and unused closeout implementation are gone while durable task evidence storage, audit, export, import, and projection remain.
- `fb742bf`, `439d21e`, and `691f20e` also closed an existing MCP Git-push contract drift uncovered by the required package build: execution now sends only its approval-owned request fields, preserves the shared UUID mutation request-id contract, and deletes 21 stale test and 24 net production lines rather than duplicating approval inputs.
- The dedicated [Pi AI Usage Ledger Repair](202607121259140001-pi_ai_usage_ledger_repair.md) converted the live Pi path from public-response reconstruction to one raw terminal usage observation, completed cache-write and estimated-USD durable accounting, preserved existing diagnostics semantics, and deleted the unreachable `pi-ai-usage.ts` normalizer plus error-carried usage. The implementation removed 70 net production lines, introduced no table or service, and passed independent correctness and Ponytail review.
- Pi closeout passed 68 focused tests, the complete NanoCore suite with 1,385 tests passed and 7 skipped, Protocol/App API/Core Client/MCP suites with 147/54/22/140 tests, all affected package typecheck/lint/build gates, protocol schema regeneration, NanoCore OpenAPI generation/validation/drift, and the 740-file repository check. The same gate found and separately repaired two stale `quick-chat` generated schema projections in `33c197f`.
- The Goal slice passed the complete NanoCore, App API schema, Core Client, and MCP suites plus package typecheck, lint, build, and committed OpenAPI drift validation. Phase 5 remains open for the remaining reachability decisions and pure pass-through cleanup.

### 2026-07-12: Phase 5 Vault Key File Boot Repair Complete

- The dedicated [Vault Key File Boot Repair](202607121259140002-vault_key_file_boot_repair.md) removed the split-key and dead-source risks exposed during Vault directory cohesion work without adding another Vault abstraction.
- Config now owns one optional absolute `vault.encryptedFile.keyFilePath`. The loader uses one bounded no-follow descriptor, validates process-user ownership, exact `0600` mode, regular-file type, and exact 32-byte length, and converts every failure to a typed redacted result.
- Encrypted-file backend construction now initializes an authenticated header only for an empty safe store and otherwise verifies the raw master key before availability or mutation. Wrong keys, tampered or unsupported headers, and non-empty headerless stores fail closed; retained backends fail locked after state replacement or lock.
- One process Vault state is now created in the non-critical boot phase, optionally unlocked from the key file, and reused by runtime callers. Missing, invalid, and wrong keys keep NanoCore running with locked degraded Vault. Temporary, candidate, previous, current, admin-request, and per-entry data-key buffers are zeroed at their lifecycle boundaries, including orderly shutdown and process exit.
- TDD commits from `6139800` through `dde829b` preserved config, header, business-clock, boot, admin, restart, and shutdown semantics. Two independent P2 review findings were fixed before the header implementation commit, and final header and boot/security/Ponytail reviews returned GO.
- Closeout passed 65 Vault tests, 39 boot/admin/security focus tests, the three-test built-process config suite, the complete NanoCore suite with 1,403 tests passed and 7 skipped, Config Schema's 54 tests, all affected typecheck/lint/build gates, OpenAPI generation/validation/drift, four built-process smoke tests, and the 740-file repository format and governance checks. Phase 5 remains open for the remaining reachability decisions, pass-through cleanup, and storage ownership work.

## Implementation Summary

In progress.

## Final Verification

Pending.
