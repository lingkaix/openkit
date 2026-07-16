# Evidence Surface Simplification

Type: change-plan
Status: verified

## Intent

Remove two evidence surfaces that duplicate existing ownership without weakening automatic evidence production, runtime evidence, verification evidence, audit linkage, redaction, retention, import quarantine, or read-only review access.

The accepted target removes the `WorkspaceSyncEvidenceBundle` record family and removes manual EvidenceBundle creation from App API, OpenAPI, Core Client, MCP, and related product documentation. NanoCore-owned domain producers remain the only writers of general `EvidenceBundle` records.

## Scope

- Delete the `WorkspaceSyncEvidenceBundle` public schema, response schema, TypeScript types, SQLite schema/table, persistence module, App API route, OpenAPI operation and component, Core Client method, MCP projection, workspace export/import record family, recovery input path, tests, fixtures, and documentation references.
- Remove `POST /api/app/workspaces/:workspaceId/evidence-bundles`, `client.app.createEvidenceBundle`, `openkit.create_evidence_bundle`, their request/response schemas, NanoCore manual creation helper, automatic reference collector, tests, fixtures, and guide references.
- Keep `GET /api/app/workspaces/:workspaceId/evidence-bundles`, `client.app.listWorkspaceEvidenceBundles`, and `openkit://workspaces/{workspaceId}/evidence-bundles` as read-only access to automatically produced bundles.
- Keep automatic general EvidenceBundle production for workspace materialization, staged workspace review, workspace apply results, and every other existing NanoCore-owned producer.
- Keep `RuntimeEvidence`, Goal verification records, AuditEvent linkage, evidence retention and sensitivity classes, evidence import quarantine, evidence compaction, and workspace evidence export/import unchanged except for removal of the synchronization-specific record family.
- Make workspace recovery retain `WorkspaceReconciliationRecord.evidenceBundleIds` and combine them with matching durable `WorkerOutputManifest` rows instead of collecting through `WorkspaceSyncEvidenceBundle`.

## Non-Goals

- Do not redesign, shrink, merge, rename, or remove `RuntimeEvidence`.
- Do not change the general `EvidenceBundle` schema, retention model, sensitivity model, import lifecycle, automatic producer behavior, read API, or export/import record format.
- Do not merge Goal verification records into EvidenceBundle or add automatic Bundle wrapping around every domain evidence record.
- Do not introduce an Evidence base type, repository abstraction, factory, generic event envelope, compatibility shim, deprecated route alias, or legacy export reader.
- Do not change workspace synchronization review, apply, quarantine, recovery decisions, backend cleanup, RuntimeEvidence linkage, or Action Center behavior beyond removing dependency on the redundant record family.

## Related Context

- [Architecture](../core/architecture.md)
- [Work Model](../core/work-model.md)
- [Agent Workflow](../core/agent-workflow.md)
- [Storage](../core/storage.md)
- [Audit](../core/audit.md)
- [Product Vision](../product-vision.md)
- [App API Boundary](../app-api.md)
- [AI Interface](../specs/superseded/20260617-openkit_ai_interface.md)
- [Audit, Usage, and Evidence Records](../specs/20260703-audit_usage_evidence_records.md)
- [Workspace Synchronization](../specs/20260703-workspace_synchronization.md)
- [Session Static Workspace Materialization](../specs/20260704-session_static_workspace_materialization.md)
- [Storage Layout and Record Ownership](../specs/20260703-storage_layout_record_ownership.md)
- [App API OpenAPI Projection](../specs/20260704-app_api_openapi_projection.md)
- [Test Strategy](../specs/20260529-test_strategy.md)
- [L6 Story Acceptance](../specs/20260529-l6_story_acceptance.md)

## Decision

`EvidenceBundle` remains the single cross-domain evidence index. Domain records carry their own business state and link directly to general EvidenceBundle ids when cross-record evidence grouping is needed.

Workspace synchronization already carries product-safe evidence refs and digests on its lifecycle records, stores recovery-required bundle ids on `WorkspaceReconciliationRecord`, and automatically promotes materialization readiness, staged review, patch, and apply-result evidence into the general ledger with stable bundle ids. A second `WorkspaceSyncEvidenceBundle` record repeats those relationships without owning a distinct state transition or production requirement, so it is removed rather than consolidated behind another abstraction.

Evidence bundles represent NanoCore-governed evidence captured at stable domain boundaries. A public manual command that scans current lineage and artifact ids produces only a `collected` reference snapshot and does not verify or promote evidence, so it is removed. Consumers retain read-only access to bundles produced by trusted domain recorders.

## Required Invariants

- Automatic materialization, staged-review, and apply-result producers continue writing the same promoted general EvidenceBundle records with stable ids, refs, digests, retention, sensitivity, and required-feature metadata.
- RuntimeEvidence remains stored, exported, imported, and readable with its existing `evidenceBundleIds` behavior.
- Task-scoped Goal verification evidence remains stored, audited, exported, imported, and projected without being wrapped in a new general Bundle; the current design does not add a Task Evaluator or independent final-verifier completion gate.
- Workspace recovery retains every general EvidenceBundle id already persisted on `WorkspaceReconciliationRecord` and resumes from matching durable output manifests without `WorkspaceSyncEvidenceBundle`.
- Evidence bundle read APIs and MCP resources remain read-only and continue returning automatically produced and imported general bundles.
- Unknown imported evidence kinds remain quarantined, and restricted or raw evidence never becomes product-visible through this removal.
- Removed routes, tools, schemas, tables, export fields, and client methods leave no aliases or compatibility readers.

## Impacted Surfaces

### Public Schemas And Clients

- `packages/app-api-schemas/src/workspace-sync.ts`: remove `WorkspaceSyncEvidenceBundleSchema`, list response schema, manifest-only helper types that become unused, and exported inferred types.
- `packages/app-api-schemas/src/evidence-bundles.ts`: remove manual create request/response schemas and types; retain record and list schemas.
- `packages/core-client/src/app.ts` and client tests: remove manual create and workspace-sync evidence-bundle methods while retaining general bundle listing.

### NanoCore

- `apps/nanocore/src/runtime/workspace-sync-evidence-bundles.ts` and its tests: delete the synchronization-specific recorder, reader, and import/export helpers.
- `apps/nanocore/src/storage/schema/workspace-sync-evidence-bundles.ts`, schema exports, and workspace baseline/migrations: remove the table and indexes through the repository's clean one-way internal migration posture.
- `apps/nanocore/src/evidence-bundles.ts`: remove manual bundle construction and digesting of manually collected refs; retain automatic record, list, import, quarantine, and compaction behavior.
- `apps/nanocore/src/app.ts`: remove the manual POST route, manual ref collector, synchronization-specific GET route, imports, export/import fields, aggregate read-model fields, and route wiring.
- `apps/nanocore/src/openapi.ts` and `apps/nanocore/openapi/app-api.openapi.json`: remove both deleted operations and their unused schemas/components while retaining general evidence-bundle GET documentation and regenerating the checked-in artifact.
- `apps/nanocore/src/storage/workspace-export.ts`: remove the synchronization-specific JSONL family and snapshot field without changing general EvidenceBundle or RuntimeEvidence export/import.
- `apps/nanocore/src/runtime/workspace-reconciliation-records.ts`: remove synchronization-specific bundle inputs and resolve recovery evidence directly from existing general bundle ids and lifecycle records.

### MCP, Web, And Guides

- `mcp/src/registry.ts`, `mcp/src/nanocore-client.ts`, `mcp/scripts/smoke-nanocore-mcp.mjs`, tests, resources, and prompts: remove the manual creation tool and synchronization-specific read projection; retain the general read-only evidence resource and make smoke coverage read automatically produced bundles instead of creating one.
- `skills/openkit-loop/SKILL.md`, `skills/openkit-loop-dev/SKILL.md`, and `tests/stories/goal-mode-mcp-smoke.story.md`: replace manual creation instructions and acceptance criteria with read-only inspection of NanoCore-produced evidence.
- `apps/web` mocks and tests: remove deleted client methods; no replacement UI is added because the Web application has no current evidence-bundle product view.
- `apps/nanocore/README.md`, `mcp/README.md`, generated/public API documentation, and relevant file maps: remove deleted command and route references after implementation lands.

## Execution Plan

### Phase 1: Contract Tests First

- Update schema, OpenAPI, Core Client, MCP registry, workspace export/import, and NanoCore server tests so they require the deleted schemas, operations, tools, resources, fields, and tables to be absent.
- Preserve focused assertions for automatic EvidenceBundle production, read-only bundle listing, RuntimeEvidence linkage, Goal verification storage, audit, export/import, terminal projection, evidence quarantine, compaction, and recovery behavior.
- Add one recovery regression proving reconciliation evidence ids and durable output manifests are sufficient without synchronization-specific bundles.

Exit criteria: focused tests express the accepted smaller public and storage contract and fail against the current implementation for only the planned removals.

### Phase 2: Remove Public Contract Surfaces

- Remove the synchronization-specific and manual-create schemas from `@openkit/app-api-schemas`.
- Remove Core Client methods and response parsing for the deleted operations.
- Remove the manual MCP tool and synchronization-specific MCP projection without adding aliases or deprecated wrappers.

Exit criteria: schema and client packages build and their focused contract tests pass with only read-only general evidence access remaining.

### Phase 3: Remove NanoCore Record And Command Paths

- Delete the `WorkspaceSyncEvidenceBundle` storage and runtime modules, route wiring, OpenAPI projection, aggregate read fields, and workspace export/import family.
- Remove the manual EvidenceBundle POST route, request parsing, collection helper, construction helper, and unused imports.
- Simplify reconciliation recovery to retain `WorkspaceReconciliationRecord.evidenceBundleIds` and remove now-unused synchronization-specific inputs and evidence-id aggregation branches.
- Apply the clean one-way internal database migration or baseline update required by current storage conventions; do not preserve the deleted table or legacy import shape.

Exit criteria: NanoCore contains no production symbol, table, route, OpenAPI operation, export field, or import reader for either deleted surface, while automatic producers and existing RuntimeEvidence behavior pass focused tests.

### Phase 4: Remove Channel And Documentation Drift

- Remove remaining MCP, Web mock, generated API, README, file-map, and fixture references.
- Re-scan active docs and code for `WorkspaceSyncEvidenceBundle`, `workspace-sync/evidence-bundles`, `create_evidence_bundle`, `createEvidenceBundle`, and the manual POST route.
- Restore the affected accepted specs from `Implementation: Diverged` to their real alignment value only after code, tests, and generated contracts match.

Exit criteria: active documentation, public contracts, generated artifacts, and implementation describe one coherent evidence surface.

### Phase 5: Verification And Closeout

- Run package schema tests, NanoCore focused and full tests, Core Client tests, MCP tests, OpenAPI generation/drift checks, repository checks, builds, smoke tests, and story tests appropriate to the changed surfaces.
- Review the final diff for leftover compatibility code, duplicate evidence ownership, unused schemas, unreachable helpers, stale generated artifacts, and unrelated changes.
- Close this record with implementation commits, final verification evidence, remaining follow-ups, and any justified deviation from this plan.

Exit criteria: all scoped removals are complete, all preserved evidence paths pass, and no deleted surface remains reachable or documented.

## Verification Plan

- `CI=true pnpm --filter @openkit/app-api-schemas test`
- `CI=true pnpm --filter @openkit/core-client test`
- `CI=true pnpm --filter @openkit/nanocore test`
- `CI=true pnpm --filter @openkit/nanocore typecheck`
- `CI=true pnpm --filter @openkit/nanocore build`
- `CI=true pnpm --filter @openkit/nanocore run openapi:check`
- `CI=true pnpm --filter @openkit/mcp test`
- `CI=true pnpm run format:check`
- `CI=true pnpm run check:repo`
- `CI=true pnpm --filter @openkit/nanocore run test:e2e:smoke`
- `CI=true pnpm -w verify:release`
- `CI=true pnpm -w test:stories`
- `git diff --check`

## Expected Handoffs

- Commit public schema tests before schema implementation removal.
- Commit `@openkit/app-api-schemas` removal before NanoCore, Core Client, and MCP consumers.
- Commit NanoCore failing behavior/contract tests before NanoCore implementation deletion.
- Keep mechanical generated-contract and guide updates separate from behavioral removal where practical.
- Update this same change record at phase completion, material scope change, blocker, implementation closeout, and final verification; do not create a duplicate PR summary.

## Risks And Mitigations

- Risk: Removing synchronization-specific bundles drops recovery evidence ids. Mitigation: characterize current reconciliation inputs first and retain the ids already persisted on `WorkspaceReconciliationRecord` while recovery continues from matching durable output manifests.
- Risk: Removing manual creation accidentally removes general bundle reads or automatic producers. Mitigation: keep explicit contract tests for GET/resource readback and deterministic materialization, review, and apply producer ids.
- Risk: Workspace imports containing the removed record family fail ambiguously. Mitigation: follow the repository's no-backward-compatibility rule, remove the old import shape cleanly, and return the existing strict schema/version failure rather than adding a legacy reader.
- Risk: OpenAPI, Client, MCP, and README surfaces drift after route deletion. Mitigation: update all projections in the same phases and run bidirectional contract and repository checks.
- Risk: Cleanup expands into RuntimeEvidence or general EvidenceBundle redesign. Mitigation: treat any such change as out of scope and require a separate accepted decision.

## Checkpoints

- 2026-07-13: Contract-first commits `08c4daf` and `d0bd0e4` removed the two public schema families, and `31aa92b` and `fb813dd` removed the matching Core Client operations without aliases.
- 2026-07-13: NanoCore contract commits `486b834` and `c8587d6` established the smaller route, OpenAPI, storage, export/import, migration, automatic-producer, and recovery requirements; implementation commit `8eba4db` removed the manual writer and synchronization-specific record family, preserved automatic producers and read-only general access, and passed 1,625 NanoCore tests with 7 expected skips plus typecheck, lint, build, generated OpenAPI validation, and focused contract suites.
- 2026-07-13: MCP contract commit `257d3f9` and implementation commit `826b464` removed the manual creation tool and synchronization-specific projection while retaining the read-only general evidence resource; commits `2404f44`, `3b676fc`, `c1fd16e`, and `7fbbe92` aligned Skills, Web mocks, deterministic smoke coverage, guides, stories, active specs, and the implementation-alignment ledger with the smaller surface.
- 2026-07-13: Final residual searches found no reachable deleted writer, route, client method, schema, storage owner, MCP operation, recovery input, or export/import reader. Remaining names are deletion assertions, the one-way table-drop migration, the explicit fail-closed rejection of the retired export path, this historical change record, and a guard in the subsequent provenance plan.
- 2026-07-13: Full release verification, deterministic MCP and Web story acceptance, the focused NanoCore E2E smoke suite, format and repository checks, generated OpenAPI drift checks, lifecycle validation, and whitespace checks passed.
- 2026-07-14: A fresh closeout audit re-proved every required invariant against the current branch. It also found and corrected one stale Core Client dashboard fixture in commit `bbb0ef1`; the fixture used the retired `sidecar` control mode even though the shared App API contract permits only `direct-nanocore`. Current release, story, OpenAPI, repository, format, package, and focused smoke gates all pass after that correction.
- 2026-07-16: The ordered completion re-audit found two pre-existing workspace-import lineage gaps without reintroducing either deleted evidence surface. Test-first commits `af9fc41` and `1257620` exposed stale reconciliation bundle ids and stale Goal review/verification audit resources; fixes `f2d9cf8` and `5bab0b6` now remint those references through the existing import maps. Residual production searches remain clean, and current-HEAD release and deterministic story gates pass.

## Current Status

- All five phases are complete and verified.
- The deleted surfaces are absent from public schemas, storage ownership, App API and OpenAPI, Core Client, MCP, workspace transfer, recovery aggregation, Web mocks, guides, Skills, and stories.
- General EvidenceBundle access is read-only for consumers, NanoCore-owned automatic producers remain intact, and the linked active specs and implementation-alignment ledger describe the shipped boundary.

## Final Implementation Summary

- NanoCore is now the only writer of general EvidenceBundle records through trusted domain producers. App API, Core Client, and MCP retain list/read access but expose no manual creation command.
- The redundant `WorkspaceSyncEvidenceBundle` schema, table, recorder, API and OpenAPI operation, Core Client and MCP projection, recovery input, and workspace export/import family were removed without compatibility aliases or readers. A one-way migration drops the retired table, and imports fail closed when the retired JSONL path is inventoried.
- Workspace recovery preserves `WorkspaceReconciliationRecord.evidenceBundleIds` and combines the reconciliation record with matching durable `WorkerOutputManifest` rows. It no longer reconstructs evidence through a second synchronization-specific aggregation record.
- RuntimeEvidence, Goal verification records, general EvidenceBundle retention and sensitivity, automatic materialization/review/apply producers, audit linkage, quarantine, compaction, and general evidence export/import remain intact; imported reconciliation bundle ids and Goal review/verification audit resources now follow their reminted target records.
- Product documentation, active specs, Skills, deterministic stories, generated OpenAPI, package guides, and the core/spec implementation-alignment ledger now describe the same smaller surface.

## Final Verification Evidence

- Changed-package schema, unit, typecheck, lint, and build gates passed for `@openkit/app-api-schemas`, `@openkit/core-client`, `@openkit/nanocore`, `@openkit/mcp`, and `@openkit/web`; the current NanoCore unit and coverage runs each pass 1,963 tests with 7 environment-gated OpenShell E2E tests skipped.
- NanoCore OpenAPI generation, validation, and checked-artifact drift checks passed with the deleted operations and components absent and the general read operation retained.
- `CI=true pnpm -w verify:release` passed repository L0-L2 checks, package tests and coverage, builds, 21 NanoCore E2E tests with 1 environment-gated skip, and NanoCore and Web built-artifact smoke tests.
- `CI=true pnpm -w test:stories` passed 70 story-runner tests, all five deterministic MCP story runners, and the Web Playwright story; the Goal Mode smoke exposed 99 tools and omitted `openkit.create_evidence_bundle`.
- `CI=true pnpm --filter @openkit/nanocore run test:e2e:smoke` passed all 4 focused smoke tests.
- `CI=true pnpm run format:check`, `CI=true pnpm run check:repo`, the spec lifecycle validator, the changed-document link audit, exact active-spec alignment recount, and `git diff --check` passed.
- Final CodeGraph and repository searches found no reachable deleted production surface. The only retained old export-path handling is a strict rejection guard, not a compatibility reader.
- The optional external Skill quick validator could not start because its local Python environment lacks PyYAML; repository-owned MCP Skill tests, package tests, and repository checks validated both changed Skill files successfully.

## Remaining Follow-Ups

- No evidence-surface follow-up remains. Runtime sub-agent provenance is owned by [Worker Runtime Sub-Agent Provenance](202607111937290001-worker_runtime_subagent_provenance.md) and must preserve this read-only consumer boundary without reintroducing either deleted surface.
