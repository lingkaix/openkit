# NanoCore Maintainability Recovery

Type: change-plan
Status: complete

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
- [LLM Gateway Responses API](../specs/20260526-llm_gateway_responses_api.md)
- [NanoCore Config And Identity Contract](../specs/20260628-nanocore_config_identity_contract.md)
- [Remote Auth Credential Bootstrap](../specs/20260704-remote_auth_credential_bootstrap.md)
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

### Phase 8: Residual Security and Ownership Repair

- Add failing server-mode coverage for unauthenticated public Gateway access, deployment-admin route access by ordinary sessions, configured CORS and bind posture, sign-up policy, Gateway enablement, and automation isolation.
- Make the existing Core-mode authentication and deployment-admin policies own every affected route instead of adding route-specific credential systems or parallel role vocabularies.
- Either connect each declared networking or Gateway configuration field to one runtime owner or remove the field and documentation when no present supported behavior justifies it.
- Bind automation reads and mutations to the authenticated user and actor-visible workspace before preserving the intentionally process-local V1 store; durable scheduling remains owned by its accepted future spec.
- Delete confirmed zero-reference exports, add the required `src/lib/README.md`, correct the context-materialization ownership map, and describe `FsStore` as a remaining broad aggregate rather than claiming it is fully decomposed.
- Re-run the full structural, correctness, security, and Ponytail audits before rewriting history, then consolidate the branch only after the final tracked tree and durable change records agree.

Exit criteria: all confirmed final-audit findings are fixed or explicitly retained under an accepted owner with direct evidence, the full deterministic release and story gates pass, and the rewritten branch contains only a few coherent commits without stale SHA references.

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

### 2026-07-11: Baseline and Guardrails Complete

- Reproduced the NanoCore unit, typecheck, lint, build, OpenAPI, repository, and built-process smoke baseline before behavior changes and recorded the route, provider, storage, reachability, directory, and test topology.
- Created this change plan before implementation and kept the accepted architecture, storage, work-model, OpenAPI, Git-write, provider, and test specifications authoritative.
- The branch also integrated independently reviewed external snapshot and spec-lifecycle maintenance; final history consolidation retains that repository groundwork in the first phase commit rather than preserving hundreds of interleaved micro-commits.

### 2026-07-11: Phase 1 Workspace Review Integrity and Git Safety Complete

- Replaced duplicate artifact and workspace-review decisions with one serialized application command, made review reads side-effect free, preserved terminal review state, and bound artifact claims to the canonical review decision.
- Moved review Git mutation into one cohesive owner with managed worktrees, repository-scoped serialization, clean-state validation, exact reviewed-path commits, restricted process input, explicit rollback evidence, and restart recovery.
- Closed actor isolation, Action Center recovery, terminal persistence, binary integrity, and concurrent filesystem recovery defects without adding a second transaction or repository abstraction.
- Phase verification passed the complete NanoCore suite, focused filesystem recovery coverage, typecheck, lint, build, OpenAPI validation and drift, repository checks, and built-process smoke.

### 2026-07-11: Phase 2 OpenAPI and Route Ownership Complete

- Replaced source-text coverage with a bidirectional live Hono route-table and OpenAPI operation comparison, explicit route-plane classifications, and shared registration by operation id.
- Made the canonical 136-operation catalog own every documented method and path while preserving route order, middleware insertion points, handler behavior, path typing, shared schemas, explicit security, and version markers.
- Removed duplicated path-parameter and capability-usage projections, inlined single-use descriptors, and retained the Core HTTP and SSE projection under its existing protocol owners.
- Phase verification passed semantic invariants, generated-document validation and drift, L3 and L5 serving checks, the complete NanoCore suite, and independent route and simplicity reviews.

### 2026-07-12: Phase 3 Vertical Decomposition Complete

- Moved complete workspace, worker, authentication, Knowledge, Vault, recovery, review, storage administration, catalog, scheduler, search, thread, artifact, event, repository, automation, health, service, Goal, Gateway, mode-entry, approval, and turn feature paths out of the composition root.
- Kept middleware and authentication order in `app.ts`, passed concrete dependencies to each registrar, and introduced no controller, service, repository framework, generic context container, compatibility alias, or pass-through gateway.
- Test-first review during extraction closed confirmed authorization, lineage, replay, idempotency, stream-ordering, Git publication, scheduler isolation, membership, database lifecycle, and terminal-state defects instead of preserving unsafe accidental behavior.
- `app.ts` reached 1,396 lines from the 15,714-line baseline and now owns process composition rather than inline product workflows; line count remains evidence, not a target.
- Phase verification passed focused characterization and security suites, the complete NanoCore suite, typecheck, lint, build, OpenAPI checks, formatting, diff checks, and independent correctness and Ponytail reviews.

### 2026-07-12: Phase 4 Provider Ownership Convergence Complete

- Removed the legacy in-memory provider configuration store, static LLM provider registry, fallback defaults, parallel health path, and obsolete tests.
- Runtime provider profiles now own configured instances, defaults, credentials, capabilities, diagnostics, dashboard counts, internal agents, Quick Chat, and Gateway dispatch, while the adapter projection retains only dispatch-owned fields.
- Closed endpoint, credential-isolation, ambient-environment, custom-model, adapter-identity, and fallback-id defects without adding a new registry or configuration layer.
- Phase verification passed the complete NanoCore suite, provider-focused tests, typecheck, lint, build, OpenAPI checks, and independent correctness and Ponytail reviews.

### 2026-07-12: Phases 5 and 6 Deletion, Storage Ownership, and Documentation Complete

- Deleted production-unreachable LLM, planning, host-runtime, internal-tool, delegation, verification, and helper islands after entry-point, export, dynamic-loading, and accepted-spec checks.
- Moved the complete Vault implementation under `src/vault/`, removed pure pass-through helpers and six empty record aliases, and retained no duplicate provider, Vault, or Goal review authority.
- Removed the legacy `store.json` and `StoreSnapshot` aggregate authority; canonical files, scope-owned SQLite databases, portable Vault metadata, and injection records remain the durable owners, while derived indexes rebuild from canonical records.
- Advanced workspace export to V2 with complete canonical history, exact byte state, context integrity, collision reminting, staged validation, coordinated publication, and synchronous failure compensation.
- Centralized knowledge ledger path, month, schema, JSONL read, and append behavior in `storage/workspace-portable-file-state.ts`; `FsStore` retains domain projections but no parallel ledger protocol or duplicate public record shapes.
- Added concise ownership maps only at stable source boundaries and aligned deterministic story and smoke fixtures with production storage and session invariants.

### 2026-07-12: Phase 7 Audit Reopened The Recovery

- The first release and story closeout passed, but the independent post-closeout audit found two trailing README blank lines, 23 zero-reference exports, a missing `src/lib/README.md`, and an inaccurate context-materialization ownership map.
- The deeper correctness pass also found unauthenticated server-mode Gateway routes, ordinary-session access to deployment-wide configuration, Codex OAuth, audit, and permission surfaces, declared security configuration without runtime enforcement, and automation records without user or workspace mutation isolation.
- `FsStore` remains a 90-method aggregate spanning durable product state, context materialization, and process-local event subscriptions. The completed work removed duplicate durable authorities, but the earlier claim that one cohesive storage and projection boundary remained was too strong and is withdrawn.
- History consolidation is paused. The current 395-commit branch has 20 concurrent repository-maintenance commits and 375 maintainability commits; the final rewrite will preserve the unrelated work as its own large commit and remove obsolete short SHA references from all affected change records.
- The remaining untracked self-improvement change plan remains outside this work and must stay untouched.

### 2026-07-12: Phase 8 Security and Ownership Repair Implemented

- Added red-first coverage and fail-closed server authentication for `GET /v1/models`, `POST /v1/chat/completions`, and `POST /v1/responses`; nested `metadata.openkit.workspaceId` is inspected regardless of request Content-Type and enters the existing membership and token-binding policy, server request storage rejects missing actors, and bearer acceptance uses actual Node socket encryption and peer state before considering request URL fallback.
- Added one shared `isDeploymentAdminActor` predicate and applied it to deployment diagnostics, global runtime config, server-owned Codex OAuth, server audit, server permission-decision, data-root, and Vault routes. The local actor and `server-admin` bearer tokens remain allowed; ordinary Better Auth sessions and workspace-scoped tokens fail before request-body parsing or deployment-state access. OpenAPI now advertises bearer-only security for those routes and the existing server-admin access-token administration surface instead of incorrectly presenting a session cookie as sufficient.
- Replaced credentialed origin reflection with startup-owned exact-origin request admission. Unknown, suffix-confused, path-bearing, and `null` browser origins receive `403 Forbidden` before route work and no CORS credential headers; local mode additionally permits exact loopback browser origins, and server mode includes its configured public base URL.
- Made server startup construct Better Auth explicitly from the startup config, require a non-blank deployment secret of at least 32 characters, derive the public URL and trusted origins from the same startup snapshot, and enforce `auth.signup.enabled`. Bind host and port resolve through environment override, startup config, then mode-safe defaults; invalid server secrets and ports now fail in the config phase before layout, migration, bootstrap-token, or boot-audit side effects.
- Removed configuration that had no runtime owner instead of preserving false flexibility: proxy trust, auth enable/provider/local-user selectors, configurable Gateway route/auth markers, data-root metadata, diagnostic toggles, the duplicate feature block, unused workspace/agent defaults, duplicate Gateway provider/model defaults, consumer-free provider metadata/retry/timeout fields, and the server extension bag. Removed the redundant `GatewayPolicyStore` and the superseded `/internal/v1/chat/completions` facade with its source file, tests, options, runtime snapshot projection, config schema, template, and Docker seed config; the public Gateway is now the only OpenAI-compatible HTTP owner.
- Runtime reload now classifies provider and agent changes as restart-required and preserves the active provider registry, diagnostics, agent config, and manifests during safe reload because the production scheduler captures them at startup. Reload failures redact the concrete data root from both plans and status history.
- Derived embedded server providers from the canonical provider-profile schema, kept the real server-only `vendor` requirement, passed parsed providers directly into the registry, and deleted the clone-only projection function. Provider shape, validation, and runtime registration now share one vocabulary without weakening strict unknown-field rejection.
- Removed request-time filesystem membership invention, filters session collection reads through active membership, retains token binding as an additional restriction, and records owner membership transactionally when workspace import publishes a new workspace.
- Closed the final workspace portability isolation gaps with red-first coverage: same-deployment exports require current source access and active membership, deployment-wide registry rows participate in import collision reminting, owner registration rejects a second user for an existing workspace id without reviving removed access, and import failures expose only stable product-safe messages.
- Applied the socket-derived secret transport gate to the public bootstrap-consumption endpoint before request-body parsing, so a one-time bootstrap credential cannot cross a non-loopback plaintext connection merely because it is not carried in the bearer header.
- Made each fresh data root mint a stable unique deployment identity instead of sharing `dep_local`, so cross-root portability cannot be confused with same-deployment access. Current and predecessor deployment exports remain private after a recorded move, while unrelated deployment exports retain their portable import path.
- Kept automations intentionally process-local while isolating records by user, using collision-resistant UUIDs, filtering reads through actor-visible workspaces, and checking workspace visibility before update or delete. No persistence repository, scheduler abstraction, or compatibility layer was added.
- Replaced absolute data-root disclosure in diagnostics and setup diagnostics with the product-safe `configured | null` marker, removed duplicate diagnostics DTO exports in favor of the canonical App API schema, and updated Web rendering and OpenAPI projection.
- Closed the remaining internal-agent diagnostics drift by preserving failure `status`, `stopReason`, and observational hook failures in the canonical App API schema; NanoCore runner diagnostics now derive their safe shapes directly from that contract instead of relying on Zod stripping as an implicit mapper.
- Added concise local ownership maps for every remaining first-level NanoCore source boundary that lacked one; no new local agent rule files or duplicated architecture guides were introduced.
- Added the missing storage-schema boundary guide and made construction-only types, helpers, OpenAPI document shape, and Web component props file-local instead of exporting unused surface area.
- Fixed first-boot template activation without reintroducing implicit runtime defaults: startup validates mode, listener, and server secret before writes, copies missing committed templates, then loads the final active runtime snapshot. The built E2E harness supplies only an explicit strong fake server secret.
- Focused auth, Gateway, deployment-admin, automation, diagnostics, config-schema, App API schema, Core Client, and Web tests are green, as are the affected package typechecks and OpenAPI validation. The full deterministic release and story gates passed, independent security and contract reviews found no remaining blocker, and the final Ponytail audit found no further justified simplification before history consolidation.

## Implementation Summary

- Recovered `app.ts` from a cross-domain god function into the NanoCore composition root by moving complete feature paths to cohesive route and runtime owners without adding controller, service, repository, dependency-container, or compatibility layers.
- Replaced parallel Git, review, OpenAPI, provider, Vault, workspace-transfer, and portable-ledger ownership with one authoritative path for each concern, backed by fail-closed authorization, lineage, replay, and rollback tests.
- Removed unreachable production code, aggregate snapshot compatibility, duplicate schemas and registries, pass-through helpers, and unjustified intermediate types while retaining abstractions that encode a real security, persistence, or feature boundary.
- Kept the existing OpenKit Core/App/Agent architecture and public feature set intact. Behavior changes were limited to confirmed specification, authorization, isolation, durability, or contract defects exposed by test-first characterization and review.

## Final Verification

- `CI=true pnpm -w verify:release` passed on the final implementation: repository checks and formatting covered 764 files; all configured lint, typecheck, unit, coverage, and build phases passed; NanoCore passed 202 test files with 1 skipped, 1,626 tests with 7 skipped, and 87.41% statement, 78.27% branch, 92.55% function, and 87.41% line coverage.
- MCP coverage passed 6 files and 140 tests with 83.04% statement, 74.95% branch, 87.15% function, and 83.04% line coverage. Web coverage passed 12 files and 124 tests with 87.66% statement, 73.85% branch, 93.81% function, and 84.95% line coverage.
- NanoCore L3 black-box verification passed 16 files with 1 skipped and 20 tests with 1 skipped. NanoCore and Web built-artifact smoke suites passed.
- `CI=true pnpm -w test:stories` passed 36 story-runner tests, all five deterministic MCP stories, and the Web Playwright story. Credentialed provider and real-worker scenarios remained opt-in as documented.
- Independent final security, contract, storage-ownership, browser-boundary, Git-scope, and Ponytail reviews reported no unresolved blocker. The final documentation-only closeout passed spec lifecycle validation, repository checks, format checking, and `git diff --check` before commit.
- The frozen implementation and its durable records were consolidated into six coherent commits covering repository governance, workspace-review integrity, OpenAPI route ownership, runtime boundaries, canonical workspace storage ownership, and final deployment-contract hardening.
