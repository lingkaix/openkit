---
date: "2026-10-30"
---
# Independent Documentation Audit: Answers For Part 1

This non-authorizing record holds the foundation, contract-evolution and architecture answers to the [independent documentation audit](20261023-independent_doc_audit.md) and its [supplement](20261025-independent_doc_audit_supplement.md). Its owning rule is [Change Execution Governance](../change-execution.md). It records observations and proposed dispositions; it does not authorize design.

## Scope

- Current-main snapshot: `0be853326bbd8575e5448b65759c269d67691328`; 28 delegated questions. Only the assigned group documents and the generated index change.
- Answered by coordinator and consultant consensus under the engineer's delegation of 2026-10-30. The coordinator accepted 21 answers and amended the seven dispositions recorded here; CODE drafts and CROSS-PART handoffs are filed and routed by the coordinator.
- Existing audit records, held documents, product vision and agent execution files remain unchanged. Code issues are drafts only.
- Counts: DOC 17, CODE 5, HELD 2, NONE 3, CROSS-PART 1, ESCALATE-E 0.

Q-02 verify-first trace: the synthetic credential fixture at `apps/nanocore/src/llm/provider-subscription-accounts.test.ts:3185` exercises a stock provider handle. The writer validates and JSON-serializes the complete credential (`provider-subscription-accounts.ts:2810`, `:2832`), stores/rotates it through Vault (`:1455`, `:1518`), then the audited read decodes UTF-8/JSON and validates the core (`:2045`) before the existing stock runtime consumes it. The current pi-ai decoder pin is 0.99.2; Better Auth and its adapter resolve to 1.6.11 in the lockfile. This is a source-and-fixture trace, not an executed credential test or historical release qualification. No real credential file was read.

Q-184/Q-201 residual implementation observation: the Web guard still gives archive download and package transport stale R008 dispositions. The documentation records that gap; this batch changes no tests and claims no successful Web-surface qualification.

Criterion locations for coordinator review (old section → new section; all paths are listed in Answers):

- Q-02: Retained Format Register, Encrypted Vault store and Core identity rows → same rows; keep authenticated field closure, markers, key dependency and unqualified continuity explicit.
- Q-06: Recurring Triggers, Scan and retry lifecycle and Acceptance → same sections; separate the three bounds without changing deadlines or atomicity.
- Q-07: Personal Workspace, Observable Acceptance → same bullet; remove only the conversion promise already excluded by Decision.
- Q-10/Q-11: Vendor Snapshots, Does Not Own, Evidence Quality, Refresh Obligation, Accepted Design and Testing → same sections; preserve provenance, complete input sets, checksums and separate review.
- Q-12: Integrity Check, Terminal Turn Consistency, its two file-specific fixtures and Proposed Design → same locations; preserve sequence, lineage, bounds, no repair and failure precedence.
- Q-14: Stability Baseline, Testing Strategy → same L0 bullet; semantic review remains required without a fictional automated check.
- Q-15: Record Envelope, Field Naming and Resolved Decisions → restored unchanged from the base; the code draft schedules the frontmatter rename with the END reset.
- Q-16: Format Register, Summary and both inventory introductions → same locations; explicitly qualify stale locations and missing SQL coverage.
- Q-18/Q-172: Architecture, Internal Core Roles → corrected Workflow Coordinator row and added Coordinator row; Core README term index gains its existing family member.
- Q-19/Q-20: Internal Agent Runtime, Internal-role Execution Profile and input limits → same paragraphs; preserve existing defaults and state the 2147483647 ms deadline maximum, with config-schema enforcement drafted.
- Q-22: Bootstrap, Failure Scope → same paragraph; distinguish existing error/reason spellings and preserve scope isolation and bytes.
- Q-25: App Update Delivery, authority and bounded automated update → same paragraphs; distinguish prepare/start approval bindings from the content-free administrator preflight read.
- Q-27: Web Stack, Consequences and Risks → same bullets; replace unconditional implementation techniques with measured-need selection.
- Q-184/Q-201: Web Surface, ownership, inclusion, disposition and implementation sections → same sections; keep transport entries, exclusions and exact scope, and remove closed-roadmap authority claims.
- Q-202: Web Surface, Decision, Recurring Workflow Projection, Acceptance and Deferred Work → same locations; admit only the accepted monthly UTC controls and bounded range display.

Validation after the consensus amendments on the clone used Node 24.18.0. `node scripts/generate-doc-index.mjs` wrote the index. The required `bash scripts/test-env.sh any bash -c 'node scripts/validate-spec-lifecycle.mjs && node scripts/validate-story-schema.mjs && node scripts/validate-doc-model.mjs'` passed: lifecycle metadata, 10 stories and 687 documents. The first generator attempt stopped before validation because the fresh clone lacked `yaml`; copying the pinned `yaml` 2.8.3 and `zod` 4.6.5 packages into clone-local dependencies resolved setup. The deadline probe on Node 24.18.0 observed a 1 ms scheduled timer for an admitted 2147483648 ms duration. `git diff --check` passed. No product suite or build ran.

## Answers

| Question | Answer | Fix type | Documents changed |
| --- | --- | --- | --- |
| Q-03 (D) | A: keep the existing path; its title already says Personal Workspace and historical links retain their target. No redirect or rename is needed. Evidence on the base: docs/specs/20260709-quick_chat_workspace.md:6; docs/decisions/20261016-retire_stateless_quick_chat.md:27. | NONE | None |
| Q-04 (O) | The current owner explicitly retains the quick_chat derivation, including the absent-binding case. A cosmetic symbol rename is optional and does not justify code churn in this batch. Evidence on the base: docs/specs/20260709-quick_chat_workspace.md:73; apps/nanocore/src/lib/store.ts:1151. | NONE | None |
| Q-05 (D) | Keep the Core requirement that the origin retains a reference to the receiving Thread. Confirmed Assistant outcomes now name that Thread, but selected-Worker handoff publishes its status in the receiving Thread and still needs an origin reference. Evidence on the base: docs/core/core-concepts.md:87; apps/nanocore/src/mode-entry-routes.ts:3446; apps/nanocore/src/mode-entry-routes.ts:4627. | CODE | None |
| Q-06 (D) | A: bounds apply independently to live candidates, expired ranges, and stale pending expiries. Prefix ranges created during live materialization consume the range budget. Evidence on the base: docs/specs/20260711-scheduler_recurring_event_triggers.md:194; apps/nanocore/src/lib/automation-store.ts:272; apps/nanocore/src/lib/automation-store.ts:287. | DOC | `docs/specs/20260711-scheduler_recurring_event_triggers.md` |
| Q-07 (O) | Replace the obsolete migration acceptance clause with the already accepted no-conversion boundary. Preserve the restart prohibition on duplicate homes and resets. Evidence on the base: docs/specs/20260709-quick_chat_workspace.md:69; docs/specs/20260709-quick_chat_workspace.md:130. | DOC | `docs/specs/20260709-quick_chat_workspace.md` |
| Q-184 (O) | The newer snapshot decision retires ordinary import; the earlier recommendation to publish all three archive operations is stale. Existing Web export remains live, and completed R008 is not authority for future Web import. Evidence on the base: docs/decisions/20261027-online_workspace_snapshots_and_recovery.md:10; docs/decisions/20261003-streaming_archives_use_web_and_admin_cli.md:10; apps/web/src/screens/portability/data.ts:66; tests/web-user-operation-surface-contract.test.mjs:289. | DOC | `docs/specs/20260628-web_product_surface_projection.md` |
| Q-201 (D) | Use operation definitions as the source of operation identity and admission, with the access catalog as their projection and explicit transport entries preserved. Remove completed R008 as an unfinished-work owner without inventing a replacement backlog. Evidence on the base: apps/nanocore/src/auth/operation-access.ts:128; docs/roadmap.md:134; docs/specs/20260628-web_product_surface_projection.md:202. | DOC | `docs/specs/20260628-web_product_surface_projection.md` |
| Q-202 (D*) | Verified the supplied answer: Web admits fixed intervals and the shipped day-1-to-28 monthly UTC controls. Align cadence, range display, acceptance and deferral text; broader calendars remain deferred. Evidence on the base: docs/decisions/20261017-monthly_utc_recurring_work.md:10; apps/web/src/screens/automations/AutomationsScreen.tsx:518; docs/specs/20260628-web_product_surface_projection.md:376. | DOC | `docs/specs/20260628-web_product_surface_projection.md` |
| Q-02 (D*) | Verified the supplied narrow answer using the existing authentication and encrypted-Vault rows. Record current decoder provenance and continuity obligations, while explicitly retaining the missing historical encoder-version and qualification gaps. Evidence on the base: pnpm-lock.yaml:69; apps/nanocore/src/llm/provider-subscription-accounts.ts:2832; apps/nanocore/src/llm/provider-subscription-accounts.ts:2045; apps/nanocore/src/auth/better-auth.ts:97. | DOC | `docs/specs/20261017-retained_format_register.md` |
| Q-10 (D) | A: evidence follows the actual source: immutable source checkout, exact registry release, or checksummed rolling capture. Use the pinned package generator for Codex and never invent an unavailable upstream commit. Evidence on the base: packages/codex-app-server-schema/metadata.json:7; packages/models-dev-catalog/snapshots/2026-05-18/metadata.json:6; docs/specs/20260522-vendor_snapshot_packages.md:89. | DOC | `docs/specs/20260522-vendor_snapshot_packages.md` |
| Q-11 (D) | A: build-supply archives are outside the runtime/catalog interface-snapshot contract. The existing Retrieval Kernel owner governs its embedded dictionary; no new vendor mechanism is needed. Evidence on the base: packages/retrieval-kernel/vendor/README.md:5; docs/specs/20261014-retrieval_kernel.md:265. | DOC | `docs/specs/20260522-vendor_snapshot_packages.md` |
| Q-12 (D) | B: align the integrity reader and fixtures now with the accepted control-store decision. Preserve read-only behavior, bounds, lineage and unreadable results; replace file-fragment assumptions with retained-row/content cases. Evidence on the base: docs/decisions/20261019-durable_execution_and_control_store.md:10; apps/nanocore/src/storage/workspace-file-records.ts:1186; docs/specs/20261012-product_integrity_check.md:149. | DOC | `docs/specs/20261012-product_integrity_check.md` |
| Q-13 (D) | The current protocol constant and optional doctor check do not establish the required pre-effect mismatch refusal. Keep the gate and draft a client/admission defect; response validation after a mutation is too late. Evidence on the base: docs/specs/20260715-contract_stability_baseline.md:234; docs/core/contract-evolution.md:179; packages/core-client/src/transport.ts:149; packages/core-client/src/http.ts:37. | CODE | None |
| Q-14 (D) | A: L0 validates lifecycle metadata; owner review checks classifications and compatibility claims. Do not add a text scanner or claim those semantic checks already exist. Evidence on the base: docs/specs/20260715-contract_stability_baseline.md:284; scripts/validate-spec-lifecycle.mjs:5. | DOC | `docs/specs/20260715-contract_stability_baseline.md` |
| Q-15 (D) | Restore the mechanical casing rule: OKF frontmatter must use required_features. Draft the parser, writer, fixture and shipped-example rename for the END phase with the final prerelease reset, with no alias or dual reader. Evidence on the base: docs/specs/20260703-schema_evolution_record_envelope.md:188; apps/nanocore/src/knowledge/okf.ts:30; apps/nanocore/src/knowledge/okf.ts:382; apps/nanocore/src/knowledge/okf.test.ts:450. | CODE | None |
| Q-16 (D) | Keep complete register re-baselining with the held control-store owner review. Correct the immediate misleading claims by identifying stale file locations and incomplete SQL coverage; claim no completed inventory or alternate reader. Evidence on the base: docs/specs/20261017-retained_format_register.md:127; apps/nanocore/src/storage/workspace-file-records.ts:882; apps/nanocore/src/storage/work-observations.ts:640. | DOC | `docs/specs/20261017-retained_format_register.md` |
| Q-17 (D) | Narrow the Workflow Coordinator contract to trusted explicit Task entry and its worker_turn or blocked outcomes; no ten-way classifier is needed. Hold the exact Core and matching specification corrections for the held work-model release. Evidence on the base: docs/core/work-model.md:198; docs/specs/20260704-workflow_coordinator_internal_agent.md:90; apps/nanocore/src/internal-agents/worker-coordinator.ts:13. | HELD | None |
| Q-18 (D) | A: remove planning and stopping from the Workflow Coordinator row, preserving routing, selection and context composition. The existing Work Model and Coordinator specification already exclude Goal Plan and stop ownership. Evidence on the base: docs/core/architecture.md:95; docs/core/work-model.md:198; docs/specs/20260704-workflow_coordinator_internal_agent.md:75. | DOC | `docs/core/architecture.md` |
| Q-19 (D) | B: record current profile-less defaults of 8 model turns and 24 Tool calls for Knowledge Manager and Coordinator, with their existing deadlines. Keep profile defaults at 16/48 and explicit limits binding; no evidence justifies changing the deployed fuses. Evidence on the base: apps/nanocore/src/internal-agents/knowledge-manager-agent.ts:174; apps/nanocore/src/runtime/goal-coordinator.ts:779; packages/config-schema/src/internal-role.ts:34; docs/specs/20260813-internal_agent_runtime.md:306. | DOC | `docs/specs/20260813-internal_agent_runtime.md` |
| Q-20 (D) | Cap deadlineMs at 2147483647 ms in ordinary config-schema validation and state that bound in the runtime owner. The observed timer overflow needs this small admission fix; no bounded-wait loop or longer single-run requirement is needed. Evidence on the base: docs/specs/20260813-internal_agent_runtime.md:71; packages/config-schema/src/internal-role.ts:14; apps/nanocore/src/internal-agents/internal-agent-loop.ts:161. | CODE | `docs/specs/20260813-internal_agent_runtime.md` |
| Q-21 (D) | Require the runtime label only for Goal discovery candidates, which consume it; Workflow Coordinator candidates omit it until they have a consumer. Hold the exact shared-contract clarification with the Goal owner and add no unused code field. Evidence on the base: docs/specs/20261002-goal.md:254; apps/nanocore/src/runtime/goal-coordinator.ts:135; apps/nanocore/src/internal-agents/worker-coordinator.ts:26. | HELD | None |
| Q-22 (D) | A: distinguish error recovery_required from readiness reason storage.scope-quarantined. This is a bootstrap naming correction; quarantine semantics and the held Core owner remain unchanged. Evidence on the base: docs/specs/20260704-nanocore_bootstrap_readiness.md:10; apps/nanocore/src/bootstrap/readiness.ts:73; apps/nanocore/src/bootstrap/readiness.ts:98. | DOC | `docs/specs/20260704-nanocore_bootstrap_readiness.md` |
| Q-24 (O) | Already resolved: both the App Dockerfile and entrypoint default to server. Preserve explicit local preview selection and the accepted image contract. Evidence on the base: containers/app/Dockerfile:75; containers/app/entrypoint.sh:16; docs/specs/20260708-container_image_packaging.md:230. | NONE | None |
| Q-25 (D) | Clarify that the approval-binding rule governs Agent-mediated prepare and start effects, not the content-free preflight count read. Preflight still requires deployment-administrator authorization; no authority moves. Evidence on the base: docs/specs/20260910-app_update_delivery.md:36; docs/specs/20260910-app_update_delivery.md:62; apps/nanocore/src/app-update/app-update-operations.ts:70. | DOC | `docs/specs/20260910-app_update_delivery.md` |
| Q-26 (D) | Remove the Web session input and narrow grants by Agent, capability and expiry only, as the Web owner already requires. The API and administrator CLI retain the exact session constraint; a null dimension adds no constraint and Vault semantics do not change. Evidence on the base: docs/specs/20260628-web_product_surface_projection.md:180; docs/specs/20260703-vault_secret_injection.md:143; apps/web/src/screens/settings/VaultSecretsPanel.tsx:28. | CODE | None |
| Q-27 (D) | A: require a demonstrated rendering cost before choosing virtualization or memoization. Remove the unconditional implementation mandate without inventing a threshold or dependency. Evidence on the base: docs/specs/20260710-web_ui_rebuild_stack.md:146; docs/specs/20260710-web_ui_rebuild_stack.md:172. | DOC | `docs/specs/20260710-web_ui_rebuild_stack.md` |
| Q-172 (D) | A: Architecture already owns the internal-role family; add the Goal Coordinator role and index it. Preserve Work Model composition and the Goal owner's existing Plan, Task and human-acceptance boundaries. Evidence on the base: docs/core/architecture.md:7; docs/decisions/20261002-goal_redesign_rulings.md:12; docs/core/core-concepts.md:12. | DOC | `docs/core/architecture.md`, `docs/core/README.md` |
| Q-191 (D) | Document the existing mode precedence and startup defaults in the configuration owner and link the existing key owners without creating a registry. Route the exact replacement to identity; the accepted loopback-only local rule remains binding. Evidence on the base: docs/specs/20260628-nanocore_config_identity_contract.md:200; apps/nanocore/src/config/mode.ts:58; apps/nanocore/src/config/bind-host.ts:29; apps/nanocore/src/config/data-root.ts:19; apps/nanocore/src/auth/better-auth.ts:22; containers/app/entrypoint.sh:16. | CROSS-PART | None |

## Code Issues

### Q-05 — Preserve an origin-Thread reference for selected-Worker handoffs

Title: Selected-Worker handoff omits the originating Thread reference Item

- Defect: the selected-Worker path creates a receiving Thread but publishes the status only in that Thread.
- Evidence: `apps/nanocore/src/mode-entry-routes.ts:3371` and `:3446`; the Core obligation is `docs/core/core-concepts.md:87`.
- Fix: append the existing status Item form to the originating Thread with the exact receiving Thread reference, using the current handoff lineage and replay boundary.
- Verify new admission and restart/replay preserve one origin reference and create no duplicate downstream work; do not add a new record family or field without need.

### Q-13 — Refuse unknown contract identity before effectful client dispatch

Title: Core Client validates incompatible responses only after mutation dispatch

- Defect: JSON mutations dispatch before response parsing; optional doctor and a hand-set protocol constant do not enforce the accepted pre-effect gate.
- Evidence: `packages/core-client/src/transport.ts:149`, `packages/core-client/src/http.ts:37`; owner: `docs/specs/20260715-contract_stability_baseline.md:234`.
- Fix: use and advance the existing protocol identity for contract changes, and enforce its compatibility through the existing metadata/client admission boundary before unsupported work.
- Verify a mismatched client does not invoke an effectful operation and receives typed incompatibility; add no digest registry, legacy reader or compatibility shim.

### Q-15 — Rename the OKF frontmatter required-feature field at the reset

Title: OKF frontmatter mixes camelCase requiredFeatures with snake_case fields

- Defect: the OKF parser admits `requiredFeatures` on a snake_case frontmatter surface, contrary to the envelope owner's mechanical mapping and no-mixed-casing rule.
- Evidence: `apps/nanocore/src/knowledge/okf.ts:30`, `:382`, `:408`; owner: `docs/specs/20260703-schema_evolution_record_envelope.md:188`.
- Fix in the END phase with the final prerelease reset: rename this frontmatter field to `required_features` in the parser, writers, fixtures, and shipped Skills and Knowledge examples; keep JSON/JSONL `requiredFeatures` under their existing mapping.
- Verify required-feature rejection and round trips with the renamed frontmatter. Add no alias, dual reader, permanent exception, or retained-data migration.

### Q-20 — Reject internal-agent deadlines above the host timer maximum

Title: Internal-role configuration admits deadlines that overflow the host timer

- Defect: a positive duration goes directly to one host timer; the Node 24.18.0 probe requested 2147483648 ms and observed a scheduled duration of 1 ms.
- Evidence: `packages/config-schema/src/internal-role.ts:14`, `apps/nanocore/src/internal-agents/internal-agent-loop.ts:161`; owner: `docs/specs/20260813-internal_agent_runtime.md:71`.
- Fix: add `.max(2147483647)` to `deadlineMs` in the existing internal-role limits schema so ordinary configuration validation refuses larger values; this batch states the same maximum in the runtime owner.
- Verify 2147483647 is accepted and 2147483648 is rejected before run admission. No bounded-wait loop or longer single internal run is required.

### Q-26 — Remove Web grant narrowing by AgentSession

Title: Web Vault grant narrowing exposes a forbidden AgentSession input

- Lane: Web / Composer. Defect: Web accepts a free-text `targetAgentSessionId` despite the existing Web prohibition on AgentSession identifiers.
- Evidence: `apps/web/src/screens/settings/VaultSecretsPanel.tsx:28`, `:36`, `:281`; owner: `docs/specs/20260628-web_product_surface_projection.md:180`.
- Fix: remove the Web session input and its request construction from the grant-narrowing flow and matching Web forms; expose narrowing by Agent, capability and expiry only.
- Preserve the API and administrator CLI exact-session constraint and existing non-null constraints when other dimensions are narrowed. A null session dimension adds no constraint; do not change Vault semantics or its specification.
- Verify Web submits no session value and ordinary grant narrowing still preserves server-enforced constraints.

## Held Fixes

No held file is changed. Q-17 and Q-21 replacements below are retained for the coordinated held-owner release, including matching text in the assigned Workflow Coordinator specification. Q-16's full register re-baseline also remains with the held control-store review.

### Q-17 — Trusted explicit entry and two actual outcomes

Replace the paragraph at `docs/core/work-model.md:198` with:

> The Assistant chooses conversational mode within its admitted authority. Workflow Coordinator accepts only trusted explicit Task delegation, selects an eligible worker and composes the exact request without semantic reclassification; its outcomes are `worker_turn` and `blocked`. The mode service derives entry intent from the operation or accepted handoff, never from prose, and validates and applies effects under the existing admission and safety owners. Workflow Coordinator does not own Goal truth, a Goal Plan, or a Goal stop. It does not persist mode state, execute progression effects, or materialize and deliver worker context. The owning workflow boundary performs those effects through Core-owned records and services.

In `docs/specs/20260704-workflow_coordinator_internal_agent.md`, replace the first sentence under Coordinator inputs with:

> The mode service supplies only trusted `explicit_task` entry intent for bounded Task delegation.

Replace the complete Request classification subsection body with:

> For trusted explicit Task delegation, Workflow Coordinator deterministically selects only from the eligible worker candidates and composes the exact structured worker request from the preserved instruction and authorized context. It does not classify undecided conversation or reclassify explicit Task instructions by keyword. The V1 decision is exactly `worker_turn` or `blocked`; missing eligible supply produces `blocked`, and malformed Coordinator output remains invalid. The request-scoped decision owns no durable state and grants no permission for downstream effects.
>
> Every decision includes confidence, a user-safe explanation, `requiredUserAction`, and nullable selected worker, delegation draft, and structured worker request. Only `worker_turn` may carry those worker fields.
>
> For an accepted Task Mode `worker_turn`, `requiredUserAction=none` and the prelaunch approval list is empty. A `blocked` result uses `requiredUserAction=refine_request` and carries no worker payload. Explicit Task entry authorizes bounded delegation only; later governed effects use their existing approval gates. A blocked decision cannot create a checkpoint or worker Turn. Any `worker_turn` carrying another required-user-action value is invalid and the owning mode must reject it before mutation.

Replace the Decision bullet beginning “Coordinator may recommend Task Mode or a Goal handoff” with:

> Coordinator selects a worker and composes the request only for trusted explicit Task entry; mode services apply accepted decisions through the named durable owner tuples. Task Mode has no durable mode record. The Assistant calls the Goal owner's create operation for a Goal handoff; Workflow Coordinator does not classify that handoff or call a Goal Plan or Goal stop function.

Replace the first Consequences bullet with:

> Direct Task entry and confirmed Chat-to-Task handoff share one explicit-delegation contract. Undecided conversation remains with the Assistant under the Work Model.

Replace the “Coordinator over-calls workers” risk bullet with:

> Risk: Coordinator over-calls workers. Mitigation: Assistant handles Chat Mode; Coordinator accepts only trusted explicit Task delegation. Explicit Task selection authorizes one bounded attempt under the Task owner's hard admission and effect controls.

### Q-21 — Runtime labels only where consumed

Replace the paragraph at `docs/specs/20261002-goal.md:254` with:

> Reuse [Agent Supply](../core/agent-supply.md) and the current setup and readiness projection used for ordinary Task candidate selection. The result contains only candidate identity, display name, supported product runtime label, readiness, and bounded safe reasons. The [Workflow Coordinator candidate contract](../specs/20260704-workflow_coordinator_internal_agent.md#worker-selection) owns the shared identity, display name, readiness, and bounded safe reasons. The `codex` or `opencode` runtime label is required for Goal discovery candidates because Goal discovery consumes it; Workflow Coordinator candidates omit it until they have a consumer. Reuse must satisfy the shared candidate contract and ordinary Task eligibility rules; an existing helper alone is not evidence of conformance. Reconcile missing Goal runtime labels, unsafe reasons, or readiness defaults through those owners. Do not copy a selection path or widen product runtime values. Bound result count and bytes under the existing read limits. Expose no native commands, host paths, credentials, raw configuration, or additional control operations. Discovery creates no catalog, health store, Worker session, or execution authority.

For the matching Workflow Coordinator Worker selection paragraph at `docs/specs/20260704-workflow_coordinator_internal_agent.md:104`, retain this replacement for the same release:

> Worker selection consumes only the caller-supplied candidate id, display name, `ready`, `blocked`, or `unknown` readiness, and optional bounded redacted reasons. Workflow Coordinator selects only a ready candidate and omits the runtime label until it has a consumer. Goal discovery additionally requires the supported `codex` or `opencode` runtime label under its owning contract because that discovery consumes it.

Replace the final sentence of that subsection, beginning “Runtime-family inference”, with:

> Goal discovery's runtime-family inference and closed product runtime labels remain with its existing owners; Workflow Coordinator adds no runtime preference or label.

## Escalated

None. These corrections describe or narrow the accepted model without changing authority or scope.

### Q-191 — CROSS-PART to identity

Do not apply this handoff in this batch. In `docs/specs/20260628-nanocore_config_identity_contract.md`, replace the first Current Contract paragraph with the following paragraphs:

> Deployment mode resolves from a nonempty `OPENKIT_CORE_MODE`, then `server.jsonc`'s `mode`, then `local` for a bare NanoCore process. The supported values are exactly `local` and `server`; an invalid explicit value fails startup rather than falling back. The [App image](../specs/20260708-container_image_packaging.md) supplies `server` by default through its environment and entrypoint.
>
> The App listener host resolves from a nonempty `OPENKIT_BIND_HOST`, then `server.bind.host`, then `127.0.0.1` in local mode or `0.0.0.0` in server mode. Its port resolves from a defined `PORT`, then `server.bind.port`, then 3000; the result must be an integer from 1 through 65535. Local mode rejects every non-loopback host, including an explicit environment or server-file override. The App image instead supplies its existing loopback NanoCore bind and internal port defaults under the image owner; these are deployment inputs to the same resolver.
>
> `OPENKIT_DATA_ROOT`, when nonempty, resolves relative to the process working directory; otherwise a bare process uses `openkit-nanocore-data` under the system temporary directory in either mode. The App image supplies `/data/openkit`. [Storage Layout And Record Ownership](../specs/20260703-storage_layout_record_ownership.md) owns the contents and retained layout; selecting a mode does not select another data-root layout.
>
> Better Auth reads its deployment secret from `BETTER_AUTH_SECRET`. Server mode requires that value and rejects a trimmed length below 32 characters. Local mode uses the local development fallback only when the variable is absent. This does not change the local loopback requirement or server-mode authentication and authorization owners.
>
> Local mode is optimized for single-user development and dogfooding. Its implicit local human is a projection of the Core `User` record family with `kind = local`, not a separate identity type. Product surfaces should still carry explicit workspace and user-facing state where the App API requires it.

Replace the Configuration Scope And Files paragraph beginning “`server.jsonc` owns deployment” with:

> `server.jsonc` owns deployment, auth, listener, NanoHost, channel, and final `defaults.defaultAgentId` values. It contains no `coreProviderId`, `coreModel`, `gatewayProviderId`, or `gatewayModel`, and it does not duplicate the Gateway logical-model catalog. [NanoHost Runtime And Transport](../specs/20260802-nanohost_runtime_and_transport.md) owns the configured `nanohost.identityId`, `nanohost.credentialRef`, listener, rendezvous and credential-slot semantics. [Pending Requests](../specs/20260930-pending_requests.md#external-attention-and-discord-responses) owns the Discord channel's disclosure and response contract; the [operator configuration projection](../../skills/openkit-ops/references/nanocore-data-root-config.en.md) states its existing `channels.discord` keys and signed interaction endpoint. [LLM Gateway](../specs/20260526-llm_gateway_responses_api.md) owns Gateway enablement, logical routes and Provider/model admission through the existing Gateway and Provider files; a historical provider-allowlist description does not define another authored key.
>
> [File Storage And Knowledge Packages](../specs/20261018-file_storage_and_knowledge_packages.md) owns `knowledgeMounts` and `defaultKnowledgeBaseId` in Server and User configuration and inside the Workspace configuration's `workspace` object. Those known fields retain their owner's validation within this contract's file scope and unknown-field rules. Key semantics remain with these existing owners; this contract creates no second key registry.

Replace the Current Implementation Projection bullet beginning “`apps/nanocore/src/config/bind-host.ts` resolves” with:

> `apps/nanocore/src/config/bind-host.ts` resolves the App HTTP/1.1 listener host and port from explicit environment overrides, then the startup server config, then the defaults stated above. Local mode rejects a non-loopback App listener host, including an explicit environment or server-file override. The NanoHost native HTTP/2 listener instead uses the explicit restart-required `nanohost.bind` and never consumes those App-listener overrides.
