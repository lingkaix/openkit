---
date: "2026-10-24"
---
# Independent Documentation Audit: Architecture Group

This non-authorizing record holds the architecture group of the [independent documentation audit](20261023-independent_doc_audit.md). Its owning rule is [Change Execution Governance](../change-execution.md). It records observations, dispositions, and questions. It does not authorize design.

## Scope And Base

- Group base SHA: `4aa0e655f36beb6771201fb4658c1555e6a1c85a`. Issue #440 had no comments and held no group in this scope. Before the commit, `main` moved to `05140a42f8b6aef63b399c259677ff2873307e6b`; those five commits change only NanoCore capability, MCP, and control-store code and three package guides, and none of them touches a file cited below.
- Core document: `docs/core/architecture.md`.
- Specifications: `20260704-workflow_coordinator_internal_agent.md`, `20260704-nanocore_bootstrap_readiness.md`, `20260813-internal_agent_runtime.md`, `20260909-internal_agent_resource_integration.md`, `20260708-container_image_packaging.md`, `20260909-deployment_host_requirements.md`, `20260910-app_update_delivery.md`, `20260628-web_product_surface_projection.md`, `20260710-web_ui_rebuild_stack.md`, `20260910-agent_operator_skill.md`, and `20261020-compute_neutrality_target.md`.
- Cited decisions read: `20261018-bwm_support_and_information_consolidation.md`, `20261016-retire_stateless_quick_chat.md`, `20261005-open_extension_partition.md`, and `20261019-durable_execution_and_control_store.md` (for the quarantine rule).
- G3 inspection: four read-only inspector contexts (AR-WFB for the Coordinator and bootstrap, AR-IAR for the internal Agent runtime and resources, AR-DEP for images, host, and update, AR-WEB for Web, the operator Skill, and compute neutrality). They read code only and ran no tests. The auditor verified each kept finding against the code.

## G2 Core Against Specifications

- AR-G2-01: `architecture.md` said that "the Internal Agent Runtime specification owns" the bounded execution substrate. Core documents stay implementation-neutral and do not reference specifications (`docs/core/AGENTS.md`). The sentence now defines the excluded term instead: "Internal Agent runtime mechanics means the role-agnostic bounded execution substrate used by model-using internal roles."
- AR-G2-02: `architecture.md` said that the unified interception mechanism "is Not Started". An implementation status in Core is a projection. The clause now ends at the decision citation. The implementation status of interception belongs to the mediation group.
- AR-G2-03: `architecture.md` named "Agent Workflow" as an owner beside Work Model. Agent Workflow is a section of `docs/core/work-model.md`, not a separate Core document. The sentence now says "Work Model owns user-facing work meaning and, through Agent Workflow, workflow progression".
- AR-G2-04: the internal roles table in `architecture.md` gives the Workflow Coordinator "planning, and stopping". The Coordinator specification says that it owns no Goal Plan or stop, and the same Core document says that the Goal model Coordinator is not the deterministic Workflow Coordinator. Question Q-18.

## G3 Specifications Against Implementation

| Finding | Clause | Evidence (at the group base SHA) | Adjudication | Action |
| --- | --- | --- | --- | --- |
| AR-WFB-01 | Coordinator Request classification: exactly one of ten decision kinds | `apps/nanocore/src/internal-agents/worker-coordinator.ts:13` has only `worker_turn` and `blocked`; `entryIntent` admits only `explicit_task` (line 109) | No record decides it; the Chat specification gives the semantic choice to the Assistant, and `work-model.md` (held) still gives classification to the Coordinator | Question Q-17 |
| AR-WFB-02, 03 | Coordinator projection: "Help" produces `clarify`, legacy Goal functions remain, `conversation.submit` uses keyword routing | Same module has no such kinds and no Goal functions; `apps/nanocore/src/internal-agents/README.md:17` says the keyword classifier is removed; the only callers pass `explicit_task` (`apps/nanocore/src/mode-entry-routes.ts:4472`, `:5113`) | Projection drift | Corrected; the projection now states the two outputs and the confirmed-handoff path, and its closing sentence names direct Task and confirmed Chat-to-Task handoff instead of Chat and Task |
| AR-WFB-04 | Worker selection consumes a `codex` or `opencode` runtime label | `worker-coordinator.ts:26-37` candidate has no runtime label | No record decides it; the Goal specification (held) also names the label | Question Q-21 |
| AR-WFB-06, 07, 08 | Bootstrap: signal handlers before phase 1; readiness always derived; LLM gateway and knowledge index states | `apps/nanocore/src/index.ts:867-868` registers signals after the listeners; `index.ts:495` freezes the snapshot; `apps/nanocore/src/bootstrap/readiness.ts:123-124` has no state source for the two subsystems | Code differs from a current accepted document | Issue #460 (blocking candidate for item 1: shutdown and recovery during boot) |
| AR-WFB-09 | Bootstrap Failure Scope: quarantine "as `recovery-required`" | `readiness.ts:74-78` uses error `recovery_required` and `readiness.ts:98` uses reason `storage.scope-quarantined` | Naming drift; the Core owner `fault-tolerance.md` is held | Question Q-22 |
| AR-WFB-10 to 12 | Phase order, criticality, credential ceremony order, rebuild reason | `index.ts` phases and `phases.ts` | Match | None |
| AR-IAR-01 | Profile-less fallback limits | `apps/nanocore/src/internal-agents/knowledge-manager-agent.ts:173-177` and `apps/nanocore/src/runtime/goal-coordinator.ts:771-775` use 8 and 24; the schema default is 16 and 48 | No record states the profile-less default for these roles | Question Q-19 |
| AR-IAR-02 | A sanitizer failure terminates `failed` | `apps/nanocore/src/internal-agents/internal-agent-loop.ts:287-333`; `apps/nanocore/src/internal-agents/redaction.ts:39-45` rethrows a non-syntax parse error | Code differs from a current accepted document | Issue #462 (low) |
| AR-IAR-03 | `deadlineMs` is a positive integer | `internal-agent-loop.ts:365-367` and the role schema set no maximum; a value above the Node timer limit fires at once | No record decides a maximum | Question Q-20 |
| AR-IAR-04 | Implementation Reference lists Quick Chat, Administration, and the Coordinator, and says the Goal implementation replaces the Coordinator assembly | `apps/nanocore/src/internal-agents/builtin-prompts.ts` has `knowledge-manager`, `quick-chat`, `administration`, and `goal-orchestrator`; `goal-coordinator.ts:666` assembles `goal-orchestrator` | Projection drift | Corrected to name the four assemblies; the replacement forecast is removed because the Goal Coordinator assembly exists |
| AR-IAR-05 | Resource integration: remove the direct `callQuickChatProvider` bypass when the shared loop lands | No match for `callQuickChatProvider` in `apps` or `packages`; `apps/nanocore/src/internal-agents/assistant-command-run.ts:308` calls `runInternalAgentLoop` | Projection drift | Corrected to state that the bypass is removed |
| AR-DEP-01 | App update: start or status for a removed ID remains `recovery_required` | `scripts/docker/app-update-helper.py:618` uses `app_update_unavailable` for status; `app_update_not_found` is never raised | Code differs from a current accepted document | Issue #461 (blocking candidate: recovery) |
| AR-DEP-02 | App update: 10-minute receipt age and 30-second launch-unknown stated as fixed rules | `app-update-helper.py:117-137` reads `prepareTtlSeconds` and `launchUnknownAfterSeconds` from host configuration | Undecided; writing rule for current defaults | Question Q-23 |
| AR-DEP-03, 04 | Host requirements: `implementation: Not Started`; "the current packager and live installer implement only arm64"; schema-version-1 paragraph in present tense | `apps/nanohost/deploy/host-manifest.json:2` is schema 2; `scripts/package-release-assets.mjs:466-469` packages both architectures; `apps/nanohost/deploy/install.sh:316` requires both; no `2.43` Git pin remains | Projection and metadata drift; the specification's own projection already says so | Corrected: `implementation: Partial` (real-host qualification is not claimed), both architectures, the schema-version-1 paragraph in past tense with the retired schema-version-1 Git admission and pin-mandatory rules removed because schema version 1 no longer exists (the schema-version-2 Workspace collection row keeps the regular non-symlink admission), and the acceptance item names the earlier arm64-only packaging |
| AR-DEP-05 | Image contract: formal release images run in `server` mode | `containers/app/Dockerfile:75` and `containers/app/entrypoint.sh:16` default to `local` | Undecided reading | Question Q-24 |
| AR-DEP-06 | Image packaging: "Today's repository still keeps", "Today's templates still name", "`smoke.sh` does not exist yet" | No leaf directories under `containers/workers`; templates select `openkit/worker-runtimes:dev`; `containers/worker-runtimes/smoke.sh` exists | Projection drift | Corrected to the current facts; `implementation: Partial` is kept because the deferred items remain |
| AR-DEP-07 | Update projection lists three operations | `packages/app-api-schemas/src/app-update-operations.ts:13` declares `app-update.preflight` too | Projection drift | Corrected |
| AR-DEP-08 | Model delivery returns `unsupported_operation` | `apps/nanocore/src/app-update/app-update-operations.ts:55-61` applies the refusal to prepare, start, and status, not to preflight | Undecided coverage | Projection now names the three refused operations; question Q-25 |
| AR-WEB-01, 02 | Web disposition counts 244, 336, 85, 83, and "Twenty-seven remain roadmap-only" | `tests/web-user-operation-surface-contract.test.mjs:12-15` asserts 337, 86, 2, and 248; 29 `roadmap` dispositions include the two Knowledge package operations under R008 | Projection drift; the specification already used 248 in its Decision | Corrected; the arithmetic now holds (337 minus 86 minus 2 minus 1 is 248) |
| AR-WEB-03 | AgentSession MUST NOT appear in Web as an identifier | `apps/web/src/screens/settings/VaultSecretsPanel.tsx:28,36`, `VaultGrantRequestsPanel.tsx:287,331-332`, `ServerVaultSecretsPanel.tsx:297`, `AdministratorCleanupPanel.tsx:37` | No record grants a Vault exception | Question Q-26 |
| AR-WEB-04 | Stack projection: Composer is text-only with no structured draft | `apps/web/src/primitives/Composer.tsx:33-142` submits a structured `ComposerDraft` with target and reasoning effort | Projection drift | Corrected |
| AR-WEB-05 | Stack Consequences: large lists MUST use virtualization | No virtualization in `apps/web/src` or `apps/web/package.json` | Undecided; the MUST sits in Consequences and has no acceptance check | Question Q-27 |
| AR-WEB-06, 07 | Stack backlog, operator Skill projection, compute neutrality | Present as described | Match | None |

## G4 Organization

No move, merge, or split is proposed.

## G5 Writing

- The present-tense "Today's ..." statements in the image packaging specification and the schema-version-1 paragraph in the host requirements specification described a state that the same documents' projections already called past. They now state the current facts.
- Undefined labels remain in this group: S12 and S39 (Coordinator), S33, A1, and A2 (images, host, update), D02, D03, and P20 (Web), and P05 and D06 (resource integration). Question Q-28.
- Experience-chosen numbers without a current-default marking: Question Q-23.
- `20260909-internal_agent_resource_integration.md` has `updated: 2026-09-30` while its body cites decisions from 2026-10-15 and 2026-10-16. The audit does not change dates it did not cause; noted only.

## Semantic Preservation

| File | Normative sentences | Numbers | Backticked identifiers | Headings | Links |
| --- | --- | --- | --- | --- | --- |
| `docs/core/architecture.md` | 46 unchanged; 3 descriptive sentences changed (AR-G2-01 to 03) | 0 | 1 unchanged | 16 unchanged | 6 unchanged |
| `20260628-web_product_surface_projection.md` | 170 unchanged, 4 changed (counts only, AR-WEB-01, 02) | 1 unchanged | 216 unchanged | 44 unchanged | 43 unchanged |
| `20260704-workflow_coordinator_internal_agent.md` | 23 unchanged, 1 changed (projection forecast of the Assistant Task path, AR-WFB-03) | 0 | 98 unchanged, 12 removed from the projection (the ten kinds stay in the contract), 4 added | 27 unchanged | 4 unchanged |
| `20260708-container_image_packaging.md` | 112 unchanged | 0 | 388 unchanged, 1 removed (`containers/workers/Dockerfile` in a stale sentence) | 43 unchanged | 9 unchanged |
| `20260710-web_ui_rebuild_stack.md` | 37 unchanged, 1 removed (Composer divergence) | 0 | 94 unchanged, 1 added | 27 unchanged | 14 unchanged |
| `20260813-internal_agent_runtime.md` | 78 unchanged | 6 unchanged | 93 unchanged, 4 added | 20 unchanged | 15 unchanged |
| `20260909-deployment_host_requirements.md` | 38 unchanged, 4 changed or removed (arm64-only gap, the schema-version-2 precondition that is now met, the schema-version-1 Git admission rule removed and superseded by the schema-version-2 Workspace collection row, acceptance item 4) | 3 unchanged | 127 unchanged | 21 unchanged | 3 unchanged |
| `20260909-internal_agent_resource_integration.md` | 1 changed (AR-IAR-05) | unchanged | unchanged | unchanged | unchanged |
| `20260910-app_update_delivery.md` | 43 unchanged | 6 unchanged | 77 unchanged, 4 added | 14 unchanged | 10 unchanged |

The removed schema-version-2 precondition ("Replacing those projections is required before a schema-version-2 requirement verdict may be claimed") is satisfied by the implementation that the projection describes. The removed forecast in the Coordinator projection ("when added under the Chat owner, it must supply trusted explicit delegation intent and retain the sole outer receipt and receiving-Thread contract") is now replaced by the fact that the confirmed handoff supplies `explicit_task`; the receipt and receiving-Thread contract stay with the Chat owner. No heading anchor or file moved.

## Issues Opened

- #460 `[bootstrap] Signal handlers register after boot, and readiness does not derive vault, LLM gateway or knowledge index state`, blocking candidate for the signal handlers.
- #461 `[app-update] Status for a missing update ID returns app_update_unavailable instead of recovery_required`, blocking candidate.
- #462 `[internal-agent] A Tool result sanitizer exception becomes a correctable Tool error instead of a failed exit`, low.

## Questions For The Engineer

### Q-17. Does the Workflow Coordinator keep the ten-kind conversational classification contract?

- Context: the Coordinator specification requires exactly one of ten decision kinds and its Risks section says conversational routing classifies low-confidence cases as `clarify` or a Goal handoff. The code emits only `worker_turn` and `blocked` for trusted `explicit_task` entry. The Chat specification gives the semantic choice to the Assistant model, while `work-model.md`, held under #440, still says the Coordinator retains classification.
- Options: (A) Narrow the Coordinator contract to trusted explicit entry with `worker_turn` and `blocked`, and move conversational choice to the Assistant owner. (B) Keep the ten-kind contract as unbuilt target.
- Recommendation: A, applied with the work-model release. The trusted entry intent already separates Task from conversation, and the ten kinds have no consumer (YAGNI).
- Meanwhile: only the projection was corrected.

### Q-18. Should Core Architecture drop "planning, and stopping" from the Workflow Coordinator row?

- Context: the internal roles table gives the Coordinator planning and stopping. The Coordinator specification excludes Goal Plan and stop, and the Goal model Coordinator owns them.
- Options: (A) Remove both words from the row. (B) Keep them.
- Recommendation: A, after the Goal specification and `work-model.md` are released from #440, because the Goal Coordinator boundary is held.
- Meanwhile: no change.

### Q-19. Which limits apply to a profile-less Knowledge Manager or Goal Coordinator run?

- Context: the runtime specification states the omitted-limits default (16 model turns, 48 Tool calls) inside a profile and the profile-less default only for the Assistant. Code uses 8 and 24 for the other two roles without a profile.
- Options: (A) State that every profile-less run uses the schema default, and change the two fallbacks. (B) Record 8 and 24 as current role defaults with the property they protect.
- Recommendation: A. One rule is simpler, and no recorded reason supports a smaller fallback.
- Meanwhile: no change.

### Q-20. Should `deadlineMs` have a maximum?

- Context: the runtime input requires a positive integer only. A value above the Node timer limit (2^31 minus 1 ms) fires at once.
- Options: (A) Add a schema maximum at that limit. (B) Leave it.
- Recommendation: A. The failure is silent and the bound costs nothing.
- Meanwhile: no change.

### Q-21. Does worker selection still consume a runtime label?

- Context: the Coordinator specification and the Goal specification (held) name a `codex` or `opencode` runtime label in the candidate. The code candidate has no label, and no selection rule uses it.
- Options: (A) Remove the label from both specifications. (B) Add it to the candidate.
- Recommendation: A, with the Goal release.
- Meanwhile: no change.

### Q-22. Which name does Workspace quarantine use?

- Context: the bootstrap specification code-formats `recovery-required`. Code uses error `recovery_required` and reason `storage.scope-quarantined`. The Core owner `fault-tolerance.md` uses the plain words and is held.
- Options: (A) Name the error and reason codes in the bootstrap specification and keep plain words in Core. (B) Leave it.
- Recommendation: A, with the fault-tolerance release.
- Meanwhile: no change.

### Q-23. How should these experience-chosen numbers be marked?

- Context: `docs/writing.md` requires an experience-chosen number to be a current default that states the property it protects. Unmarked numbers in this group: 16 model turns and 48 Tool calls, 3000 code points per prompt part (runtime); 64 KiB per Skill read (resource integration); 10 minutes receipt age, 30 seconds launch-unknown, 1000 receipts, 16 KiB with a 10-second read deadline (update, where the first two are host-configurable); 660 seconds fallback (operator Skill). The auditor cannot state the protected property without new intent.
- Options: (A) The engineer states each property, and the writer marks the numbers as current defaults. (B) Leave them as fixed rules.
- Recommendation: A, at least for the two host-configurable update values, whose text now disagrees with the code.
- Meanwhile: no change.

### Q-24. Which Core mode is the default of a formal release App image?

- Context: the image contract says that formal release images run in `server` mode unless a release ships a local-only preview. The Dockerfile and the entrypoint default to `local`, and the deployment guide passes `server` explicitly.
- Options: (A) Change the image default to `server`. (B) State that the image default is `local` and the formal deployment sets `server`.
- Recommendation: A. Local mode uses implicit authority, so a published image that falls back to it fails open.
- Meanwhile: no change.

### Q-25. Does the model-delivery refusal cover `app-update.preflight`?

- Context: the update specification says agent-mediated requests report unsupported until the approval adapter exists. Code refuses prepare, start, and status, and allows preflight, which is content-free and makes no host effect.
- Options: (A) State that preflight is allowed. (B) Refuse it too.
- Recommendation: A.
- Meanwhile: the projection names the three refused operations.

### Q-26. May Vault screens show or ask for an AgentSession id?

- Context: the Web projection forbids AgentSession as a Web identifier. Workspace and Server Vault screens take and show `targetAgentSessionId` in grant terms.
- Options: (A) The Vault owner defines a user-facing grant target (for example an Agent or a Thread), and Web stops asking for the id. (B) Add a narrow Vault exception to the Web rule.
- Recommendation: A, decided in the Vault group.
- Meanwhile: no change.

### Q-27. Should the virtualization MUST become a measured-need rule?

- Context: the stack specification says in Consequences that streaming logs and large lists MUST use virtualization. The Web has none, and no acceptance check measures it.
- Options: (A) Replace it with a rule tied to a measured threshold, as the bundle-size posture does. (B) Implement virtualization now.
- Recommendation: A.
- Meanwhile: no change.

### Q-28. Should undefined plan labels be defined or removed?

- Context: S12, S39, S33, A1, A2, D02, D03, P05, P20, and D06 appear without a definition or a link.
- Options: (A) Link each to its record or replace it with plain words. (B) Leave them.
- Recommendation: A. The auditor cannot resolve every label from the repository alone.
- Meanwhile: no change.

## Independent Review

A fresh Reviewer context received the diff, this record, and the inventory, and checked the cited code itself at the group base SHA. Verdict: accept with changes. Dispositions:

1. The record said that the schema-version-1 paragraph kept its rules, but two schema-version-1 Git rules were removed. Accepted; the AR-DEP-03, 04 row and the inventory row now say that they were removed because schema version 1 no longer exists and that the schema-version-2 Workspace collection row keeps the regular non-symlink admission.
2. The AR-IAR-05 evidence cell lacked the directory of `assistant-command-run.ts`. Accepted.
3. The AR-WFB-09 evidence cell placed the reason code at the wrong line. Accepted; it now cites `readiness.ts:98`.
4. The closing sentence of the Coordinator projection still said that routing for Chat and Task is implemented. Accepted; it now names direct Task and confirmed Chat-to-Task handoff.

The Reviewer confirmed that the interception status removed from Core is still recorded in the BWM support decision, that the removed Coordinator forecast stays with the Chat owner, that Core Architecture no longer references a specification, that Q-17 to Q-28 change no text, and that the diff has no content-safety problem. It did not confirm that the lower Composer action row exists; the corrected text does not claim it.

## Checks

Run on the working tree before the commit:

- `node scripts/validate-doc-model.mjs`: "Validated documentation model (664 documents)."
- `node scripts/generate-doc-index.mjs`: "Wrote docs/INDEX.md."
- `pnpm check:repo`: exit status 0.
- Content scan of the staged diff (emails, tokens, local absolute paths, Vietnamese diacritics): no match.
