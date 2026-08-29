---
status: verified
type: change-plan
---

# Web User API UI Completeness

## Intent Epoch 1

Source: engineer direction on 2026-08-29.

### Outcome

Complete the Web client as the product projection for every currently supported canonical-user or Workspace-authorized NanoCore operation. Start from the public operation catalog, preserve one explicit disposition for every included operation, implement the missing Web workflows over existing stable contracts, verify them independently, and commit the complete coherent change.

### Non-negotiables

- The inventory is derived from `PUBLIC_OPERATION_ACCESS`, generated App API OpenAPI, and `@openkit/core-client`; page names and existing mockups are not the inventory authority.
- Every included operation must map to visible user behavior, visible authoritative state, or an explicitly documented product-workflow projection. One workflow may project several operations; the Web must not become a raw API console.
- Deployment-admin, bootstrap, Worker-private, and Gateway-actor operations remain outside the ordinary user Web surface. Roadmap R048 continues to own a separate deployment-admin Web surface.
- Web consumes existing Core and App API contracts. It must not invent runtime, Policy, Knowledge, Workspace Sync, portability, scheduling, or recovery semantics.
- A callable endpoint whose owning capability is not release-ready must not be presented as a working feature. Its exact gap remains unpublished and must have a Roadmap owner.
- Existing user changes are preserved. Herdr writers receive exclusive file ownership before editing, and independent reviewers do not write producer-owned paths.
- Repository code and documentation remain English. No compatibility layer, new dependency, generic API renderer, or speculative abstraction is authorized.

### Acceptance

- A committed coverage check accounts for every included catalog operation and fails when an operation is added without a Web disposition.
- Every release-ready included operation has a reachable, accessible Web projection with truthful loading, empty, denied, failure, stale, success, and retry behavior where applicable.
- No published ordinary-user route calls a server-scoped API or requires a deployment-admin token.
- Every excluded or not-yet-release-ready capability is named against an existing Roadmap item, or the Roadmap is updated before closeout.
- Focused Web tests, package typecheck/lint/build, the relevant NanoCore/Core Client contract checks, and the minimum real-browser journeys pass with exact evidence.
- Grok 4.6 High through Cursor CLI acts as builder, Cursor CLI acts as tester, Codex sub-agents independently review material slices, and an independent Claude Code Agent performs final verification and audit.
- The final accepted repository state is committed once, with no unrelated changes included.

### Effect Boundary

Authorized effects are repository documentation, Web implementation, the smallest required Core Client projection additions, tests, browser verification against disposable local state, and a final Git commit. This change does not deploy, call external-effect operations such as a real Git push, alter staging data, use server-admin credentials, or publish a release.

## Intent Epoch 2

Source: clarification of the engineer's 2026-08-29 request after independent plan review.

### Outcome Clarification

The `roadmap` disposition is not an alternative to implementing a missing Web projection. Every included operation whose current owning contract and backend provide a truthful end-user capability must gain reachable Web behavior in this change. A roadmap-only disposition is allowed solely when the callable endpoint itself does not yet implement the named product capability, as with the in-memory, non-executing Automation definition store; such a disposition keeps the concept unpublished and explicitly prevents this change from claiming that capability complete. Operations without an ordinary user API, including Workspace deletion, sandbox-image selection, and deployment administration, remain outside Web-client completion and retain their Roadmap owners.

### Acceptance Clarification

- The change cannot close while any release-ready included operation is classified only as `roadmap`.
- Each roadmap-only exception must name the accepted capability owner, the exact backend limitation that prevents truthful publication, and the Roadmap outcome that closes it.
- Existing sharing UI remains implementation-complete only at its current contract boundary. This change must rerun the real-auth browser journey and must not claim all of R049 complete without its remaining concurrent-work acceptance.

## Intent Epoch 3

Source: independent contract verification during implementation on 2026-08-29.

### Evidence-backed Knowledge exceptions

`draftKnowledgeProposal` and `reverseKnowledgeProposal` remain unpublished roadmap dispositions under R070 and R072. The draft response is the only ordinary-user projection of the exact candidate bytes and digest, and the accepted review plus applied page lineage needed for reversal is likewise unavailable through any ordinary-user read after refresh or restart. Browser persistence or a Web-owned serializer would violate the restart and authority boundaries. These are backend projection gaps rather than alternatives to implementing release-ready UI; the other 13 missing Knowledge operations remain required in this change.

## Governing Owners

- [`docs/specs/20260628-web_product_surface_projection.md`](../../specs/20260628-web_product_surface_projection.md) owns Web publication and projection boundaries.
- [`docs/specs/20260528-core_client_boundary.md`](../../specs/20260528-core_client_boundary.md) owns typed client transport and projection responsibilities.
- [`docs/specs/20260704-app_api_openapi_projection.md`](../../specs/20260704-app_api_openapi_projection.md) owns the generated App API inventory boundary.
- [`docs/specs/20260703-workspace_synchronization.md`](../../specs/20260703-workspace_synchronization.md), [`docs/specs/20260704-workspace_backup_export_import.md`](../../specs/20260704-workspace_backup_export_import.md), [`docs/specs/20260704-knowledge_manager_internal_agent_runtime.md`](../../specs/20260704-knowledge_manager_internal_agent_runtime.md), [`docs/specs/20260703-audit_usage_evidence_records.md`](../../specs/20260703-audit_usage_evidence_records.md), and [`docs/specs/20260713-work_resource_interaction_model.md`](../../specs/20260713-work_resource_interaction_model.md) own the largest capability families implemented by this change.
- Contract edits in this change admit only Web projection over existing accepted semantics. They do not change Core lifecycle or policy decisions.

## User Operation Inventory

The canonical included universe is 139 operations: all 141 `PUBLIC_OPERATION_ACCESS` entries whose scope is `user` or `workspace`, minus the two Gateway-actor compatibility operations (`POST /v1/chat/completions` and `POST /v1/responses`). Better Auth sign-in, sign-up, and sign-out plus `GET /api/meta` are already-live admission and connection plumbing; they remain acceptance prerequisites but are not catalog operations.

Status below is the current pre-change Web status: **live** means the capability already has a Tier-A product projection, **mixed** means only part of the group is projected, and **missing** means no published product projection exists. Exact per-operation dispositions will be enforced by the coverage check rather than duplicated as a second manual authority.

### App API operations

- **Agent environment — missing (2):** `listAgentEnvironmentPackageSnapshots`, `getAgentEnvironmentPackageSnapshot`.
- **Agents — mixed (2):** `listAgentCatalog`, `getAgentCatalogEntry`.
- **App utilities — mixed (9):** `refreshAgentHealth`, `quickChat`, `listInterruptedWorkers`, `retryInterruptedWorkerCheckpoint`, `listSchedulerAdmissions`, `retrySchedulerAdmission`, `cancelSchedulerAdmission`, `searchApp`, `submitTurnFeedback`.
- **Artifacts — missing (2):** `importWorkspaceArtifact`, `introduceWorkspaceArtifact`.
- **Automations — missing and not release-ready (4):** `listAutomations`, `createAutomation`, `updateAutomation`, `deleteAutomation`.
- **Dashboards — live (4):** `getWorkspaceDashboard`, `getThreadDashboard`, `listThreadItems`, `listHumanAttention`.
- **Diagnostics and evidence — mixed (5):** `getCapabilityUsage`, `listWorkspaceAuditEvents`, `listWorkspaceEvidenceBundles`, `listWorkspaceRuntimeEvidence`, `listWorkspacePermissionDecisions`.
- **Knowledge Manager — mixed (17):** `answerKnowledgeManager`, `listKnowledgeSources`, `registerKnowledgeSource`, `readKnowledgeSource`, `listKnowledgeObservations`, `recordKnowledgeObservation`, `listKnowledgeClaims`, `recordKnowledgeClaim`, `listKnowledgeConflicts`, `recordKnowledgeConflict`, `resolveKnowledgeConflict`, `readKnowledgeIndexes`, `retrieveKnowledge`, `prepareKnowledgeContext`, `draftKnowledgeProposal`, `suggestKnowledgeRepairs`, `checkKnowledgeHealth`.
- **Materials — live (11):** `listWorkspaceMaterials`, `createWorkspaceMaterial`, `getWorkspaceMaterial`, `listWorkspaceMaterialRevisions`, `saveWorkspaceMaterialRevision`, `getWorkspaceMaterialRevision`, `getThreadMaterial`, `bindThreadMaterial`, `unbindThreadMaterial`, `excludeThreadMaterial`, `restoreThreadMaterial`.
- **Modes — live (13):** `startChatMode`, `startTaskMode`, `getThreadGoalSummary`, `startThreadGoal`, `submitThreadGoalSteering`, `convertGoalSteeringToFollowUp`, `cancelGoalSteering`, `createThreadGoalPlan`, `approveThreadGoalPlan`, `reviseThreadGoalPlan`, `pauseThreadGoal`, `resumeThreadGoal`, `runThreadGoalStep`.
- **Repositories — mixed (7):** `listWorkspaceRepositories`, `getWorkspaceRepositoryDiagnostics`, `setDefaultWorkspaceRepository`, `listGitPushRecords`, `getGitPushRecord`, `requestGitPushApproval`, `executeGitPush`.
- **Reviews — mixed (5):** `listArtifactReviews`, `submitArtifactReviewDecision`, `submitKnowledgeProposalDecision`, `reverseKnowledgeProposal`, `submitGoalReviewDecision`.
- **Portability — missing (3):** `exportWorkspace`, `dryRunWorkspaceImport`, `importWorkspace`.
- **Vault — mixed (6):** `rebindWorkspaceVaultReference`, `listWorkspaceVaultReferences`, `listWorkspaceVaultGrants`, `listWorkspaceVaultInjectionPlans`, `listWorkspaceVaultInjectionReceipts`, `listWorkspaceVaultUseRecords`.
- **Workspace sharing — live (12):** `listAuthorizedWorkspaces`, `listWorkspaceMembers`, `listWorkspaceInvitations`, `createWorkspaceInvitation`, `listMyWorkspaceInvitations`, `acceptWorkspaceInvitation`, `declineWorkspaceInvitation`, `revokeWorkspaceInvitation`, `changeWorkspaceMemberAccess`, `removeWorkspaceMember`, `leaveWorkspace`, `transferWorkspaceOwnership`.
- **Workspace Sync and recovery — missing (15):** `listWorkspaceSyncReviews`, `getWorkspaceSyncReview`, `submitWorkspaceSyncReviewDecision`, `listWorkspaceInputSnapshots`, `listWorkspaceMaterializationRecords`, `listBackendWorkspaceHandles`, `listWorkerOutputManifests`, `listWorkspaceChangeSets`, `listStagedWorkspaceReviews`, `listWorkspaceApplyResults`, `listWorkspaceApplyPlans`, `listWorkspaceReconciliationRecords`, `submitWorkspaceRecoveryDecision`, `listWorkspaceQuarantineRecords`, `getWorkspaceApplyResult`.

### Direct Core operations

- **Approval — live (1):** `POST /api/approvals/:approvalRequestId/respond`.
- **Artifacts — mixed (3):** `GET /api/workspaces/:workspaceId/artifacts`, `GET /api/workspaces/:workspaceId/artifacts/:artifactId`, `GET /api/workspaces/:workspaceId/artifacts/:artifactId/content`.
- **Knowledge CRUD — live (4):** `GET /api/workspaces/:workspaceId/knowledge`, `POST /api/workspaces/:workspaceId/knowledge`, `PATCH /api/workspaces/:workspaceId/knowledge/:knowledgeEntryId`, `DELETE /api/workspaces/:workspaceId/knowledge/:knowledgeEntryId`.
- **Thread reads — live (4):** `GET /api/workspaces/:workspaceId/threads`, `GET /api/workspaces/:workspaceId/threads/:threadId`, `GET /api/workspaces/:workspaceId/threads/:threadId/events`, `GET /api/workspaces/:workspaceId/threads/:threadId/turns/:turnId`.
- **Turn commands — live (2):** `POST /api/turns`, `POST /api/workspaces/:workspaceId/threads/:threadId/turns/:turnId/interrupt`.
- **Workspace lifecycle and reads — mixed (4):** `PATCH /api/workspaces/:workspaceId`, `GET /api/workspaces`, `GET /api/workspaces/:workspaceId`, `GET /api/workspaces/:workspaceId/resources`.
- **Workspace and Thread writes — live (4):** `POST /api/workspaces`, `POST /api/workspaces/:workspaceId/threads`, `PATCH /api/workspaces/:workspaceId/threads/:threadId`, `POST /api/workspaces/:workspaceId/threads/:threadId/archive`.

## Roadmap Reconciliation

The known gaps already have durable Roadmap owners: R008 covers export/import/re-binding; R010 covers Workspace deletion/recovery that has no ordinary user API yet; R028-R030 cover Vault lifecycle, grants, injection records, and use; R034 covers Audit, Usage, Evidence, and permission visibility; R037-R043 cover readiness, Agent, runtime, image, Policy, and routine management; R044-R047 cover workbench navigation, Action Center, and Workspace Sync/file review; R049 owns the full real-browser and real-auth multi-user acceptance beyond the already-live sharing projection; R050 and R054 cover Artifact product lifecycle and import/export; R069-R072 cover Knowledge retrieval and governed changes; and R092-R095 cover real recurring automation and workflow composition. No new Roadmap item is currently justified. Reconciliation must be rerun after the per-operation disposition check exposes any gap not covered by those outcomes.

## Current Method

- Freeze the Web projection owner and one generated/static coverage oracle before product edits.
- Work through cohesive existing product areas rather than endpoint-by-endpoint pages: Workspace workbench, Artifacts and portability, Agents and operational recovery, Workspace Sync, Knowledge, and settings evidence/Vault.
- Keep Automations unpublished unless the current API can support a truthful durable user capability; R092 remains the owner if it cannot.
- Add one lowest-sufficient failing test per changed behavior, then implement the smallest existing-pattern projection.
- Use Grok 4.6 High through Cursor CLI for implementation and Cursor CLI for test authorship, with explicit non-overlapping file ownership. Codex reviewers inspect every material slice. Claude Code receives a clean final diff and check evidence for independent verification and audit.

## Working Checkpoint

### Facts

- The source catalog contains 186 operations: 45 deployment/bootstrap operations, 2 Gateway-actor operations, and 139 canonical-user or Workspace operations in scope here.
- The committed disposition guard accounts for all 139 included operations and passes against the current Tier-A surface catalog.
- Artifacts, Portability, Recovery and scheduler admission, global application search, Workspace changes, Agent detail and health, default-repository setup, Knowledge Manager workflows, AEP snapshots, evidence reads, and expanded Workspace Vault reads now have published product projections through the existing Core Client.
- The current Automations API owns in-memory definition CRUD and does not execute recurring work; publishing it as an operating automation feature would be false. R092 already owns the real capability.
- Deployment-admin APIs are deliberately absent from ordinary settings and remain owned by R048.
- The accepted Web owner now defines the 139-operation inclusion, disposition, workflow-grouping, and admin-separation contract.
- The four Automation CRUD operations plus `draftKnowledgeProposal` and `reverseKnowledgeProposal` are the only six roadmap dispositions; independent verification confirmed R092, R070, and R072 remain their truthful owners.
- Settings Debug and Vault, Agents and Repositories, Workspace Sync, Artifacts, Portability, Knowledge, and Operations each have focused component coverage, scoped formatting and type evidence, and an explicit independent Codex `ACCEPT`. The final Operations closure covers concurrent Workspace A/B settlement with per-invocation mutation handlers plus mount-local, per-Workspace scheduler reread verification; its final focused suite passes 58 tests.
- The pinned Node 24 Web package test passes all 816 tests. Web lint, typecheck, production build, the 139-operation disposition guard, root execution contracts, diff-check, repository check, and built-artifact smoke also pass.
- The updated browser journeys move inspection assertions from General to Settings Debug, and the server-mode fixture binds loopback explicitly so it does not require TLS. The complete 14-test Playwright suite passes in the repository's authoritative Linux test image. The macOS host run preserves a separate environment finding because its detached Vite process-group liveness probe returns `EPERM` during teardown after functional assertions pass.

### Independent Claude Code audit, 2026-08-29

The audit inspected the actual working-tree diff, independently re-ran the host package and repository checks listed below, and reviewed the authoritative Linux Playwright evidence plus the separate macOS environment finding. It found no security, accessibility, authority, or documentation mismatch requiring correction.

Re-run execution evidence on the macOS host:

- `pnpm exec vitest run` in `apps/web`: 17 files, 816 of 816 tests pass, independently reproducing the recorded 816-test claim.
- `pnpm exec biome check .` in `apps/web`: 146 files checked, clean.
- `pnpm exec tsc -b --force` in `apps/web`: exit 0 with no diagnostics.
- `pnpm exec vite build` in `apps/web`: exit 0. The only notice is the pre-existing informational chunk-size warning.
- `pnpm run check:repo`: exit 0. Spec lifecycle, story schema, 204-document documentation model, documentation index currency, Agent Skill reachability, AgentSession terminology, test governance, root Biome across 937 files, and the models catalog all pass.
- `git diff --check`: exit 0.
- `node --test tests/*.test.mjs`: 527 of 527 pass, including the 139-operation disposition guard and the Web preview smoke.
- `pnpm run test:smoke`: exit 0. NanoCore dual-listener and Web built-artifact smoke both report `PASS`.

Running the Web typecheck as `tsc -b apps/web` from the repository root reports resolution errors that do not reproduce from the package directory. The package script `pnpm typecheck` runs `tsc -b` inside `apps/web`, and a forced clean rebuild there is exit 0, so the root invocation is a working-directory resolution artifact rather than a defect in these bytes.

Direct-artifact verification:

- No published ordinary-user route reaches a deployment surface. Importing the runtime `PUBLIC_OPERATION_ACCESS` and sweeping every non-test file under `apps/web/src` returns zero references to any of the 45 server-scoped keys, zero references to either Gateway-actor key, and zero deployment-admin, admin-token, or bootstrap-secret references.
- Removing the General Settings Diagnostics section is a correction rather than a weakened check. `/api/app/diagnostics` requires deployment-admin authority in `apps/nanocore/src/app.ts`, and the operation is absent from `PUBLIC_OPERATION_ACCESS`, so it was never an included user operation. The dropped browser assertion is replaced by Settings Debug assertions and by a negative pin in `apps/web/src/screens/settings/settings.test.tsx` that the heading is absent and `getDiagnostics` is never called.
- No contract-derived check was weakened for green. The diff adds no `.only`, `.skip`, or `todo`, and every assertion deleted from the rewritten `workspace.test.tsx` Knowledge block re-exists in the new suite, including empty state, add-entry creation, disconnected save disabling, unsupported proposal actions, and authoritative-refetch settlement.
- `automations` remains Tier B in `apps/web/src/app/surfaces.ts`, and `isSurfaceLive` admits Tier A only, so the four roadmap Automation operations are absent from both the route tree and navigation.
- R048, R049, R070, R072, and R092 all exist and remain open in `docs/roadmap.md`.
- Web production code contains no `fetch(`, `axios`, `localStorage`, or `sessionStorage`, so every call goes through the composed Core Client and no workflow state is browser-owned.
- The browser fixture change is hygiene rather than a relaxed transport requirement. `apps/web/e2e/_lib/servers.ts` now pins `bind.host` to `127.0.0.1` where server mode would otherwise default to `0.0.0.0`, and the plaintext-credential rule in `apps/nanocore/src/auth/middleware.ts` already keyed off the loopback socket, so assertion strength is unchanged.

Audited judgments recorded without a required correction:

- The `searchApp` disposition names the `Overview` surface, but `AppSearch` mounts in `AppShell` and is therefore reachable from every route. The row is not false and no Tier-A title names the shell, so the inventory stays as written and the shell-global placement is recorded here instead.
- `quickChat` is the weakest `workflow` claim in the inventory. `client.app.quickChat` has no Web call site and its distinct stateless, Thread-free behavior is not separately reachable. Its resolver is `actor-quick-chat-workspace` and Web models the `quick-chat` Workspace kind, so the Chat workflow does project the product capability. The specification assigns this class of claim to reviewer judgment rather than the guard, and the audit accepts it.
- `NON_RELEASE_READY_ROADMAP` is an allowlist inside the file it guards, so the rule that no release-ready operation stays roadmap-only is enforced only by whether a key was appended to that map. Release-readiness is not observable to any oracle, and the specification already states the guard is not an acceptance verdict, so no change is required; the limit is recorded so the guard is not later mistaken for stronger proof.

### Unknowns

- None. The audit resolved the remaining unknown, independently re-ran the host package and repository checks on the current bytes, and reviewed the authoritative Linux Playwright result plus the macOS teardown finding.

### Frontier

Production implementation, slice-level review, full-package verification, documentation reconciliation, authoritative-image browser verification, and independent Claude Code audit of the actual diff with host and repository re-run checks are complete. This record is verified.

### Predicted Next Action

Create the single authorized Conventional Commit containing only this verified change. R049 continues to own the remaining real-use multi-user acceptance, and R070, R072, and R092 continue to own the six deliberately unpublished operations.

## Closeout Summary

The Web client now gives every one of the 139 canonical-user or Workspace-authorized operations exactly one truthful product disposition. Every release-ready operation is reachable through a published workflow, while four non-executing Automation operations remain unpublished under R092 and Knowledge proposal drafting and reversal remain unpublished under R070 and R072 because their exact authority cannot be reread after restart. Ordinary Web routes call no server-scoped or Gateway-actor operation, Settings Debug owns developer inspection, Repositories remains selected-Workspace navigation, and all seven implementation slices received independent Codex acceptance. No deployment, push, staging mutation, credential use, new dependency, compatibility path, or new Core lifecycle owner was added.

## Verification Evidence

- Web package tests pass 816 of 816, Operations passes 58 of 58, and every focused slice suite passes.
- Web lint, typecheck, production build, the 139-operation guard, root execution contracts, repository check, generated documentation index check, diff-check, and built-artifact smoke pass under the pinned Node 24 toolchain.
- The complete Playwright suite passes 14 of 14 in the repository's authoritative Linux test image. The macOS host run passes its functional assertions but retains the distinct detached Vite process-group teardown `EPERM` environment finding.
- Settings Debug and Vault, Agents and Repositories, Workspace Sync, Artifacts, Portability, Knowledge, Operations, and the final documentation state each received independent Codex review acceptance.
- The independent Claude Code audit inspected the actual diff, re-ran the host package and repository gates recorded above, reviewed the Linux and macOS browser evidence, and found no required security, accessibility, authority, documentation, test-weakening, or scope correction.
