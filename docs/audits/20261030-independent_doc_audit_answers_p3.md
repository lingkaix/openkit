---
date: "2026-10-30"
---
# Independent Documentation Audit: Answers For Knowledge, Generative Apps And Process

This non-authorizing record follows [Change Execution Governance](../change-execution.md) and records answers to the [independent audit](20261023-independent_doc_audit.md) and [supplement](20261025-independent_doc_audit_supplement.md). It does not authorize design or publication.

**Answered by coordinator and consultant consensus under the engineer's delegation of 2026-10-30**. The coordinator accepted the answers and directed the Q-147, Q-152 and Q-198 amendments recorded here.

## Scope

Reviewed current main `0be853326bbd8575e5448b65759c269d67691328`, after Part 3 landed. Only the knowledge, generative-apps and process specifications, this record and the generated index are changed. Other answer files were not consulted. Held and other-group files remain unchanged. The consensus amendments were verified against current main `d91c587e21f36fd01f420842631d74fba10f3487`; their cited implementation files are unchanged from the original review base.

32 answers: 30 DOC, 2 CODE, 0 HELD, 0 NONE, 0 ESCALATE-E. Code drafts also record remaining implementation gaps behind DOC corrections; each question retains one primary fix type. Q-152 remains CODE and includes one small GUI documentation clarification.

Stale premises: Q-145 sidecar reuse already crosses generations; Q-197 Policy Mapping already names `knowledge.write` and `knowledge.propose`, and Core already admits scoped Server reads; Q-198 snapshot non-authority and part of commit metadata are already stated; Q-200 checksum membership is already correct in the release owner and later cookbook text. Q-147 source-reference/Knowledge identity sorts are already bytewise in part; remaining canonical sorting is deferred to Q-189.

## Answers

| Question | Answer | Fix type | Documents changed |
| --- | --- | --- | --- |
| Q-136 (D*) | Maintenance reads the admitted fixed-base snapshot and supplied Sources, with scoped history and the existing edit Tools. Retrieval needs a named maintenance need. | DOC | [KMR] |
| Q-137 (D) | Use `knowledgeMaintenance.schedule.enabled` for daily execution and `enabled` for publication delegation; both default off. The configuration owner needs the same shape (CROSS-PART). | DOC | [KMR], [NBE] |
| Q-138 (D) | Keep the implemented `knowledge-manager` entry value and its exclusion from learning inputs. Correct the closed enum in Thread Visibility without granting authority (CROSS-PART). | DOC | [KMR] |
| Q-139 (D) | Remove the undefined ephemeral/no-memory phrase; retain the admitted input exclusions. No new Thread or Turn marker is justified. | DOC | [PML] |
| Q-140 (D) | Use the dotted proposal operation IDs. Limit the no-scheduled-mining sentence to the completed-Worker reflection composition; scoped daily learning keeps its existing owner. | DOC | [SIE], [IMP] |
| Q-141 (D*) | Keep restricted and non-Memory confidential exclusions, and stale/expired freshness exclusions. Include `current` in the profile vocabulary and describe date-based expiry as unimplemented. | DOC | [GOV], [IMP] |
| Q-142 (D) | Frontmatter values are ordinary content under the accepted credential-pattern decision; structural secret-like field-name rejection remains. Remove the contradictory value rule and draft the remaining code fix. | DOC | [GOV] |
| Q-144 (D) | Describe the current default refusal above 256 diff paths and separate 64 KiB text truncation. Remove the nonexistent page-index projection; keep the three derived projections. | DOC | [IMP] |
| Q-145 (D) | Name the current 1,000-match ceiling and `knowledge_retrieval_failed` on incomplete enumeration. The cache premise is stale: healthy generations are reused, and verified previous-generation sidecars are reused in new generations. | DOC | [RTK] |
| Q-146 (D) | Add the already-required `requestId` to the public User editor update shape. | DOC | [NBE] |
| Q-147 (D) | State the actual files, Knowledge previews, accounting and `knowledgeBaseId`; policy summaries and Knowledge descriptors follow v0.1.0 under #565. Current capability projection, typed refusals and `budget_exceeded` cover limits; notebook revision evidence is already #506, with no Q-147 code draft. | DOC | [WCP] |
| Q-148 (D) | Remove superseded Source-registry and recapture rules, distinguish physical materialization from Git pages, and remove or relocate obsolete history. Numeric and label sweeps stay with Q-23/Q-28 except in sentences changed here. | DOC | [GOV], [IMP], [KMR], [NBE], [RTK], [WCP] |
| Q-197 (D) | Existing Core Knowledge already admits Worker reads of Workspace and currently admitted Server Knowledge; tell remains Workspace-only and Memory stays private. Project trusted state inspection and list existing operation mappings cross-part; Server maintenance reads its explicit snapshot/Sources without a Workspace anchor. | DOC | [KMR], [PML], [GOV], [IMP] |
| Q-198 (D) | Document the existing Scope Schema, maintenance Thread identity, retrieval predicate, index-editing behavior and interpreter commands; commit metadata and snapshot non-authority are already stated. Memory export/import, suppression removal and Proposal-ref pruning are absent additive capabilities following v0.1.0 under #564. | DOC | [IMP], [KMR], [NBE], [PML] |
| Q-151 (D) | The embedded resource is the retained template; `structuredContent` carries the published presentation and data model. The URI continues to resolve the template only. | DOC | [GUI] |
| Q-152 (D) | A user retry after uncertainty keeps its ID and resolves the Kernel receipt; a definite Core result releases the ID for a fresh submission. Reopen returns retained presentation data, refresh re-reads the record, and the revision precondition rejects stale writes; clarify GUI and fix typed-failure ID retention. | CODE | [GUI] |
| Q-154 (D) | Project the extra operations using their existing read-only `workspace.read` or mutating `workspace.configure` mappings. Supply exact registry rows to the Policy owner (CROSS-PART), without changing rights. | DOC | [GKD] |
| Q-155 (D) | Remove superseded proposal/date wording and transient renderer patch pins, and link Material and the accepted Assistant integration owner. Keep uncertainty about genuinely unimplemented extensions; defer unrelated numbers and labels to their sweeps. | DOC | [GKD], [GUI] |
| Q-156 (D) | Return `not_found` for a never-created app ID; preserve unavailable for an existing app whose retained state cannot be read. Never fabricate unknown revision or digest values; the present placeholder projection needs a code fix. | DOC | [GKD] |
| Q-190 (D*) | Refuse populated-field removal without exact prior-value recovery proof, and keep revision preconditions unambiguous after restore under the existing owner. Do not invent a new revision mechanism or settle held storage/portability conflicts here. | DOC | [GKD] |
| Q-157 (D) | Use test layers and dispatch purposes in the contract; leave concrete workflow identifiers in the projection. Include the already-owned registry-observation refresh. | DOC | [TST] |
| Q-158 (D) | The release gate covers the `verify:release` composition through admitted shards and exact-commit reuse. It need not invoke the monolithic command again. | DOC | [TST] |
| Q-159 (D) | Keep the isolated NanoHost installer fixed-path check as a named pull-request exception alongside the lightweight repository check. The NanoHost specification remains the proof owner. | DOC | [TST] |
| Q-160 (D) | Move the Worker Task/MCP behavior proof to L3 through public interfaces and keep L5 shallow. Raw SQL setup and private implementation imports do not justify an L5 exception. | CODE | None |
| Q-161 (O) | Root LOCAL-001 makes per-package AGENTS files optional. Correct only Test Strategy and retain its existing README/script-alignment expectation without adding a checker. | DOC | [TST] |
| Q-162 (D) | One terminal result belongs to a runner invocation and includes its fixed lifecycle runs. Gateway owns public meanings, the runner test projects its allowlist, and the single-process runner may retain its overridable port default. | DOC | [TST] |
| Q-163 (D) | Make affected-story review a reviewer practice, not a claimed automatic marker. Supply the corresponding stories-guide sentence cross-part; keep schema validation limited to its existing checks. | DOC | [L6] |
| Q-164 (D) | Remove cadence ownership and state sparse, audit-selected cycles. No scheduler or default calendar is needed. | DOC | [VCA] |
| Q-165 (D) | Use the existing Auditor role acting as seed author; its measurement contract already owns fault injection and separation. No new saboteur role is needed. | DOC | [VCA] |
| Q-167 (D) | The release-shard regression supplies the five-file exactly-once inventory assertion. Keep production discovery recursive rather than hard-coding a second inventory. | DOC | [REL] |
| Q-168 (D) | Remove stale migration/trial narrative and superseded links, align strict-surface names, and place implementation identifiers and release sections correctly. Deduplicate the identifier ruling while preserving its conditions; leave unrelated numeric and label sweeps separate. | DOC | [TST], [L6], [VCA], [ERM], [DFC], [REL], [PDA] |
| Q-200 (D) | Release Management owns proved-candidate promotion and the existing manifest schema; spell out its keys and checksum membership. Supply packaging/cookbook corrections and the current proxy projection cross-part, without changing publication or route authority. | DOC | [REL] |

## Code Issues

The coordinator routes these drafts; no code was changed in this batch. Q-142, Q-156, Q-160 and Q-190 retain their accepted drafts; Q-152 belongs to the Web / Composer lane. Evidence line numbers below refer to the reviewed main commit. Cross-part mappings also use `packages/app-api-schemas/src/server-threads.ts:145` and `packages/app-api-schemas/src/memory.ts:155`.

### Q-142: Stop rejecting ordinary frontmatter values by credential words

- Defect: a title such as “Token budget” is rejected although values are ordinary retained content.
- Evidence: `apps/nanocore/src/knowledge/okf.ts:1194`; accepted owner `docs/decisions/20261006-no_credential_pattern_rejection_of_ordinary_content.md:10`.
- Fix: remove value-pattern rejection while retaining structural field-name, alias and ordinary profile validation; cover an ordinary title and a forbidden structural field separately.

### Q-152: [Web / Composer] Release submission IDs after definite Core results

- Defect: `GenerativePresentationView.tsx` clears the ID on success but retains it after every failure, so a corrected submission after a typed Core failure can hit `idempotency_key_conflict`.
- Evidence: `apps/web/src/screens/chat/GenerativePresentationView.tsx:92,107,118`; the existing Kernel receipt owns same-ID replay under `docs/specs/20260908-generative_ui_interaction.md:245`.
- Fix: keep the ID only for an uncertain outcome (no response, network failure or timeout); allocate a fresh ID after a definite Core result, whether success or typed failure. Preserve the existing user retry and no-automatic-resubmission behavior.
- No inspection operation or reload persistence is needed. Reopen returns retained data (`apps/nanocore/src/generative-ui/commands.ts:718`); refresh re-reads the source at line 345, and the Kernel revision check at `apps/nanocore/src/generative-kernel/commands.ts:1260` refuses a stale write.

### Q-156: Distinguish unknown Light Apps from unavailable retained apps

- Defect: the catch-all inspection projection returns unavailable with revision 1 and an empty digest for any ID.
- Evidence: `apps/nanocore/src/generative-kernel/commands.ts:1894,1911`; owner `docs/specs/20260908-generative_kernel_data_operations.md:213`.
- Fix: return `not_found` when no app was created, retain unavailable for an existing unreadable app, and remove fabricated identity values from the admitted response projection.

### Q-160: Move the Worker MCP Task proof to L3 public interfaces

- Defect: L5 smoke performs Task behavior setup/assertions using raw SQL and private test-support imports.
- Evidence: `tests/smoke/nanocore-worker-mcp-smoke.mjs:680,868`; owner `docs/specs/20260529-test_strategy.md:93,271`.
- Fix: retain boot/readiness smoke in L5 and move deeper Task/MCP proof to L3, with setup and observations through the owning public interfaces.

### Q-190: Keep Light App schema preconditions unambiguous across snapshot restore

- Defect: restore reinstates an older schema revision while updating only the app revision; a subsequent activation can reuse the schema number for different content.
- Evidence: `apps/nanocore/src/generative-kernel/commands.ts:530`; the same file compares schema revisions at line 315 and activates the next revision at line 340.
- Fix: resolve restore/activation identity through the existing schema and snapshot owner so an old inspected schema revision cannot admit a different schema. Keep populated-field removal proof-gated; do not infer qualification from snapshot existence.

## Held Fixes

No HELD-class answer or held edit is proposed. Q-190 still encounters the held layout/register definition-history discrepancy and the app package/source-reference ownership seam. Their storage release must resolve them; this batch supplies no new format, history table or transfer contract.

### CROSS-PART (exact text; not applied)

- Q-137 — in `docs/specs/20260628-nanocore_config_identity_contract.md`, replace the maintenance shape/meaning sentence while retaining its scope and writer rules:
  “The `knowledgeMaintenance` setting is `{enabled:boolean,schedule:{enabled:boolean},reviewRequiredPageIds:string[]}`. Defaults are disabled publication delegation, disabled daily scheduling and an empty protected-page list. `enabled` delegates publication; `schedule.enabled` separately enables the daily runs owned by Knowledge Manager.”
- Q-138 — in `docs/specs/20260909-thread_visibility_and_sharing.md`, change the closed enum to `conversation | administration | knowledge-manager` and add:
  “The `knowledge-manager` entry records scope-bound maintenance under [Knowledge Manager Internal Agent Runtime](../specs/20260704-knowledge_manager_internal_agent_runtime.md). Entry classification grants no scope or disclosure authority.”
- Q-154 — append these rows to the existing operation table in `docs/specs/20260703-policy_enforcement_mapping.md`, retaining its current column order:

```markdown
| `kernel.snapshots.list`, `catalog.light-app-list`, `catalog.light-app-read`, `catalog.light-app-export` | `workspace.read` / `ar:workspace-read` | Read-only; current Workspace admission and source visibility. |
| `kernel.apps.instantiate`, `kernel.schema.activate`, `kernel.snapshots.rollback`, `kernel.format.upgrade` | `workspace.configure` / `ar:workspace-configure` | Mutating; existing definition, revision and snapshot predicates. |
| `catalog.light-app-import`, `catalog.light-app-history-import`, `catalog.light-app-select`, `catalog.light-app-pin` | `workspace.configure` / `ar:workspace-configure` | Mutating; catalog selection grants no execution authority. |
```

- Q-163 — add to `tests/stories/README.md` after the contracts guidance:
  “When a listed contract changes, the change reviewer reviews the affected story and updates it if its accepted behavior changed. The schema validator checks contract existence; it does not mark stories for review.”
- Q-197 — add the concrete-operation projection to `docs/specs/20260703-policy_enforcement_mapping.md`:
  “Knowledge ask and ordinary read operations use `knowledge.read`; tell, maintenance and notebook mutations use `knowledge.write`; Workspace proposal drafting uses `knowledge.propose`. Workspace proposal inspection and decisions use `review.apply`, with inspection read-only. Server proposal inspection uses read-only `knowledge.read`, while its decision uses mutating `review.apply`. `memory.*` uses `api.call` at the User target and retains its current-self admission and operation-specific mutation posture. These mappings grant no additional source, audience or publication authority.”
- Q-200 — replace the two Image Promotion build/retry sentences in `docs/specs/20260708-container_image_packaging.md`:
  “Prerelease candidate CI builds and smokes the exact image digests. The release tag promotes those proved indexes without rebuilding, under [Release Management](../specs/20260829-release_management.md#prerelease-candidate-images). Same-tag recovery follows that owner's immutable-retry rules; it adds no tag-stage rebuild fallback.”
- Q-200 — add to that packaging specification's implementation projection, not its authority rules:
  “The App image currently serves Caddy on port 8080 by default and forwards `/api/*`, `/internal/*` and exact `/mcp` to the loopback App listener, whose default port is 4317. `/api/nanohost/transport/*` returns 404; turn event streams flush immediately. Unsupported API paths do not fall back to the SPA. `Caddyfile` and `containers/app/entrypoint.sh` implement this projection; the App Dockerfile declares no `USER` override. This projection grants no route or caller authority.”
- Q-200 — replace the first `SHA256SUMS` bullet in `docs/cookbooks/release.md`:
  “`SHA256SUMS` for all three portable archives and `openkit-release-<tag>.json`; the manifest itself lists only the three archive checksums.”

## Escalated

None. Q-198 is DOC: the absent operations are additive and follow v0.1.0 under [#564](https://github.com/lingkaix/openkit/issues/564). No new operation, retained shape or retention rule is introduced. Git actor/commit metadata is already stated in Notebook Editing; the documentation model already makes both OKF snapshots non-authorizing.

[GOV]: ../specs/20260702-knowledge_store_governance_rules.md
[IMP]: ../specs/20260703-knowledge_store_implementation.md
[KMR]: ../specs/20260704-knowledge_manager_internal_agent_runtime.md
[PML]: ../specs/20260909-personal_memory_and_knowledge_learning.md
[NBE]: ../specs/20260909-knowledge_notebook_editing.md
[RTK]: ../specs/20261014-retrieval_kernel.md
[WCP]: ../specs/20260703-worker_context_package.md
[SIE]: ../specs/20260710-self_improvement_evaluation_loop.md
[GKD]: ../specs/20260908-generative_kernel_data_operations.md
[GUI]: ../specs/20260908-generative_ui_interaction.md
[TST]: ../specs/20260529-test_strategy.md
[L6]: ../specs/20260529-l6_story_acceptance.md
[VCA]: ../specs/20260719-verification_calibration.md
[ERM]: ../specs/20260811-execution_residue_measurement.md
[DFC]: ../specs/20260729-documentation_field_contract.md
[REL]: ../specs/20260829-release_management.md
[PDA]: ../specs/20260909-persistent_deployment_acceptance.md
