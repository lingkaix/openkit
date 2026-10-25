---
date: "2026-10-25"
---
# Independent Documentation Audit: Supplement From A Second Session

This non-authorizing record adds the findings of a second audit session to the [independent documentation audit](20261023-independent_doc_audit.md). Its owning rule is [Change Execution Governance](../change-execution.md). It records observations, corrections, dispositions, and questions. It does not authorize design.

## Provenance And Scope

The engineer gave one audit instruction to two sessions. This session started on 2026-10-23 at `main` `67d3e5a68453b9efd76c3313768c01dd87ae8cdb` on branch `audit/independent-docs-20261023`. It completed its Phase 0 inventory, its G1 clean-room probe, and G3 inspections of nine specifications. It then found the parallel audit on branch `audit/independent-docs-ag29v9` (pull request #521), which had audited every open group. It stopped there to avoid a second writer on the same files.

On 2026-10-25 the engineer directed this session to add its unique findings to the audit and to close both audits. This record holds that addition. Its rules:

- Base: the head of `audit/independent-docs-ag29v9`, `0bd8c542ba2b9093948835098faa4585241eeb2d`. Code evidence cites `main` at `547887980b6fd3ef730ecc669d39a3092f731408`.
- No held document under issue #440 was edited. The held list is the ledger of the summary record.
- No archived specification was edited, and the archive check stays deferred (see Remaining Work).
- A finding that a group record, a question, or an issue of the summary record already covers is not repeated.
- Each correction follows the dispositions of the audit instruction: a projection that drifted from code is corrected; text that a later accepted record outdated is corrected with that record cited; a code difference from an accepted rule is an issue; a case no accepted record decides is a question.

Inputs:

- The [G1 probe record](20261023-independent_doc_audit_g1_probe.md): 296 findings of eight clean-room inspectors, the top-down derivation, and themes T1 to T10.
- G3 reports for the Codex, Pi, DeepSeek, and OpenCode adapters, the Internal Agent Runtime, the Workflow Coordinator, the Web UI Rebuild Stack, the Web Product Surface Projection, and Thread Visibility And Sharing. The auditor verified every kept finding against the code at `547887980`.
- This session's draft corrections to `docs/core/doctrine.md` and `docs/core/README.md`.

## Core Corrections

| ID | Finding | Evidence | Disposition |
| --- | --- | --- | --- |
| SUP-C-01 | The Relationships section of `doctrine.md` omits two of the twenty required aspects. | `docs/core/README.md` lists `fault-tolerance.md` and `generative-apps.md` in the required aspect set; `doctrine.md` Relationships names neither. | Fixed: one relationship line for each, using the opening of each document. |
| SUP-C-02 | The Document Layers list of the Core README omits decision records, although Core documents link them beside their rules. | `docs/documentation-model.md` Decision Records. | Fixed: one bullet for `docs/decisions/`, which links the documentation model as the owner of the record content. |
| SUP-C-03 | The aspect description and the term index row for `contract-evolution.md` omit three concepts that it owns. | `contract-evolution.md` boundary section owns retained data continuity, the closed core and open extension, and the post-launch operation semantic promise. | Fixed: the description and the index row name them. |
| SUP-C-04 | The term index omits canonical terms of four aspect documents. | `knowledge.md` defines `Derived Representation` and `Observation`; `sandbox.md` defines isolation levels and the shared Sandbox; `protocol.md` owns the entity-identifier grammar, scope-qualified object references, and Pending Request Semantics; `policy.md` defines `AssistantReadScope` and `OutputAudience`. | Fixed: the four index rows name them. |
| SUP-C-05 | `core-concepts.md` defines `ApprovalRequest` as "a blocking human authorization decision". A later accepted decision removed blocking gates, and `protocol.md` defines "blocking" as a derived display state of a pending request. | [Pending Tool Calls](../decisions/20260930-pending_tool_calls.md): "There is no blocking gate that pauses a Turn"; `protocol.md` Approval Semantics: "the raising Turn continues"; Pending Request Semantics defines "blocking". | Fixed: the definition says that the request holds back its effect, not the raising Turn, and cites the decision. The six covered kinds are unchanged. |
| SUP-C-06 | Active documents call `policy.md` by its former name "Permissions": "Core Permissions", "Permissions Model", "Permissions Core", "[Permissions](../core/policy.md)", and "under Permissions". | `policy.md` is titled "Policy Model"; the Core README term index and `docs/glossary.md` have no "Permissions" aspect; the archived `superseded/20260513-core_protocol_model_notes.md` names the former `docs/core/permissions.md`. | Fixed: 52 replacements in 24 documents, listed below this table. "Core Permissions" became "Core Policy" so that it stays distinct from the Policy Model specification. Kept: decision titles, the generic noun in the Worker Context Package table, the generic heading "Permissions And Accountability" in `generative-apps.md`, whose anchor a rename would change, the statement kind in `policy.md`, "General Permissions" in Delegated Worker Policy Maintenance, and "the Permissions pipeline" in Policy Enforcement Mapping, because their meaning is not certainly the aspect. Held documents keep the former name for their own audit, and `docs/cookbooks/persistent-live-acceptance.md` and `docs/roadmap.md` keep "Core Permissions" for the periphery audit. |
| SUP-C-07 | `doctrine.md` states that agent-principal activation "remains unclaimed". | Summary Question Q-70 already asks the engineer. | No change; this record does not pre-empt Q-70. |

SUP-C-06 changed these documents, with the number of replacements in each:

- Core: `core-concepts.md` (3), `identity.md` (1), and `protocol.md` (1).
- Specifications: `20260628-nanocore_config_identity_contract.md` (1), `20260629-openkit_policy_model.md` (3), `20260703-policy_enforcement_mapping.md` (1), `20260704-vault_backend_implementation.md` (2), `20260709-quick_chat_workspace.md` (1), `20260715-contract_stability_baseline.md` (1), `20260715-multi_user_workspace_system.md` (7), `20260908-generative_kernel_data_operations.md` (1), `20260908-generative_ui_interaction.md` (2), `20260909-internal_agent_resource_integration.md` (1), `20260909-knowledge_notebook_editing.md` (1), `20260909-persistent_deployment_acceptance.md` (1), `20260909-personal_memory_and_knowledge_learning.md` (3), `20260909-thread_visibility_and_sharing.md` (5), `20260910-agent_operator_skill.md` (1), `20260910-app_update_delivery.md` (2), `20260910-persistent_worker_volumes.md` (1), `20260922-delegated_worker_policy_maintenance.md` (5), `20261012-product_integrity_check.md` (3), `20261014-retrieval_kernel.md` (4), and `20261018-nanocore_interception_and_information_consolidation.md` (1).

## Specification Corrections

| ID | Specification | Finding | Evidence at `547887980` | Disposition |
| --- | --- | --- | --- | --- |
| SUP-S-01 | Codex Worker Adapter | Three sentences call `CODEX_HOME` and its rollout forest "AgentSession-private". | The specification's own Generic Volume Retention Amendment and [Codex Home Retained Whole](../decisions/20260930-codex_home_retained_whole.md) make `CODEX_HOME` the "admitted Thread-private native data home"; `packages/worker-shim/src/harness.ts:318` places it in the Thread runtime root. | Fixed: "Thread-private" in the Upstream Contract, Provenance, and Tests sentences. |
| SUP-S-02 | Codex Worker Adapter | The projection says that image installation, schema inclusion, and deployed smoke "remain with the image slice". | `containers/workers/Dockerfile:30,40` copy the schema package and lines 231-252 install the binary; `containers/worker-runtimes/smoke.sh:19,134-153` checks `codex --version` and runs `session.open`, `session.inspect`, and `session.close`. | Fixed: the projection states the installed binary, the schema package, and the smoke scope. |
| SUP-S-03 | Codex Worker Adapter | The projection says that the Turn consumer does not forward completed-result diagnostics. | `packages/worker-shim/src/turn.ts:563` adds the adapter diagnostics to the terminal status for every outcome. | Fixed: the projection states that the consumer forwards them; the preparation-error gap stays. |
| SUP-S-04 | DeepSeek Worker Adapter | The projection says that a prompt RPC error settles `failed` / `host_ended`. | `packages/worker-shim/src/adapters/deepseek.ts:236` returns `prompt_failed` when a correlated native error response set `promptFailed` (line 1732), before the `host_ended` check. | Fixed: both reasons and their conditions. |
| SUP-S-05 | DeepSeek Worker Adapter | The projection says that the Turn consumer publishes the diagnostic map only on failures. | `turn.ts:563`, as in SUP-S-03. | Fixed. |
| SUP-S-06 | Pi Worker Adapter | Native Output Mapping says that `agent_settled`, `message_end`, `turn_end`, and `agent_end` are historical JSON-mode names, "not the SDK product schema". | `packages/pi-runtime-host/src/outcome.ts:52-86` branches on these SDK events, and the pinned SDK declares `type: "agent_settled"` in `AgentSessionEvent`. | Fixed: the sentence states that the SDK host reads these SDK events. |
| SUP-S-07 | Web Product Surface Projection | The Current Implementation Projection calls Automations a "live fixed-interval" projection. The Recurring Workflow Projection, the acceptance, and the deferred work limit Automations to a fixed interval "without calendar choices". | `apps/web/src/screens/automations/AutomationsScreen.tsx:36-50,518` offers a fixed-interval and a monthly UTC cadence. [Monthly UTC Recurring Work](../decisions/20261017-monthly_utc_recurring_work.md) accepted the monthly variant, and the Scheduler Recurring Event Triggers specification owns it, but neither names Web, and that specification excludes Web presentation. | Fixed: the projection states the shipped cadences. The contract, acceptance, and deferral text are unchanged, because no accepted record decides the Web scope of the monthly variant; Question Q-202 asks. |
| SUP-S-08 | Web Product Surface Projection | Two sentences name operations by client member names (`downloadWorkspaceExportArchive`, `draftKnowledgeProposal`, and three others) instead of catalog keys. | `packages/app-api-schemas/src/workspace-archive-operations.ts:8-36` and `knowledge-operation-definitions.ts:204,277`; the Web guard uses the keys. | Fixed: the catalog keys. The disposition of the archive operations is Question Q-184. |

Other G3 report items were checked and need no record here: the summary record covers them (for example Q-17, Q-19, Q-27, Q-134, Q-135, #462, #497), or they belong to a held document, or the evidence did not hold. The DeepSeek projection still names a stale pnpm store hash for the resolved executable; Q-135 already asks whether such paths stay in specifications.

## Issues Opened

Each issue was checked against the open and closed issues first, and each cites its clause and its code at `547887980`. The first three are also listed in a comment on pull request #521.

| Issue | Specification | Finding | Severity hint |
| --- | --- | --- | --- |
| #522 `[workspace-import] Ordinary import keeps the exported private owner instead of binding private Threads to the importing user` | Thread Visibility And Sharing | `workspace-import.ts:1350-1356` spreads the exported `privateOwnerUserId` | blocking candidate (authorization) |
| #523 `[workspace-export] Workspace export fails for every non-administrator when the Workspace has any private Thread` | Thread Visibility And Sharing | `workspace-transfer-routes.ts:1468-1474` refuses instead of excluding | ordinary |
| #524 `[deepseek] A native max_tokens stop is rejected before classification, so the Turn fails instead of reporting length` | DeepSeek Worker Adapter | `deepseek.ts:69,1746-1753` omit `max_tokens` from the admitted set | ordinary |
| #525 `[internal-agent] Two fixed system prompts live outside the shared built-in prompt source and its 3000-code-point test` | Internal Agent Runtime | `policy/agent-gate.ts:16`, `internal-agents/compacting-context.ts:25` | low |
| #526 `[internal-agent] Conversational objectives are not configurable, and the deadline is not checked against four times the objective` | Internal Agent Runtime | `packages/config-schema/src/internal-role.ts:10-36` has no objective | ordinary |
| #527 `[internal-agent] A Tool-returned image fails the run instead of surviving the Gateway round trip` | Internal Agent Runtime | `gateway-provider.ts:438-444` throws `tool_image_content_unavailable` | ordinary |
| #528 `[opencode] The adapter does not configure the V2 tool output limits or image resizing` | OpenCode Worker Adapter | no `tool_output` or `media` key in the adapter | ordinary |
| #529 `[opencode] Each Turn reads the whole native conversation under one 16 MiB and 20-page bound, so a long Thread can stop accepting Turns` | OpenCode Worker Adapter | `opencode.ts:2099-2150` counts the whole session | ordinary (recovery effect) |

## G1 Cross-Comparison

Four read-only inspectors compared each of the 296 probe findings with the summary record, the fifteen group records, and the current documents on this branch. A script checked the 73 phrases that the inspectors quoted as document evidence of the open findings, each at its cited line, and all matched after two file names in the reports were corrected. Not every open finding has a quote, because a missing-fact finding cites the place where the fact belongs. The Disposition column of the module tables in the G1 probe record gives the disposition and the reference of each finding.

| Module | Held | Covered | Fixed before | Invalid | Open |
| --- | --- | --- | --- | --- | --- |
| M1 | 6 | 10 | 0 | 0 | 14 |
| M2 | 32 | 6 | 1 | 0 | 1 |
| M3 | 4 | 28 | 2 | 2 | 9 |
| M4 | 2 | 18 | 3 | 1 | 15 |
| M5 | 10 | 15 | 0 | 0 | 5 |
| M6 | 2 | 15 | 0 | 0 | 17 |
| M7 | 22 | 8 | 0 | 1 | 5 |
| M8 | 6 | 16 | 0 | 2 | 18 |
| Total | 84 | 116 | 6 | 6 | 84 |

The column meanings:

- Held: the owning group or the only evidence is held under #440. The held-group audit takes these findings from the G1 probe record.
- Covered: a group record item, a question, an issue, or a summary theme handles the same defect. Many retained-format findings are covered only by theme G1-CR-T1 and Question Q-01, so the answer to Q-01 decides them.
- Fixed before: the audit or `main` already changed the text.
- Invalid: the documents answer the probe. Held text answers M3-G30 and M3-G45, and the held-group audit reclassifies them if that text changes. A MAY clause answers M4-G30, the expiry and invalidation rules answer M7-G13, `DESIGN.md`, which the probe export lacked, answers M8-G04, and an engineer ruling answers M8-G38.

This supplement fixed five open findings:

| Finding | Correction |
| --- | --- |
| M8-G01 | The Web specification's included-set count is 248 in the inclusion rule and the stack sentence; the six other places already stated 248. |
| M8-G02 | The Web acceptance bullet says twenty-nine roadmap operations, as the disposition table does. |
| M8-G05 | The Web Consequences sentence no longer claims `Implemented` against the frontmatter `Partial`; the retired Repositories screen is removed from the workflow list, as the specification's own Owns section states. The claim that the unified Composer projection is implemented waits for the held work-model audit, because the held Unified Conversation Composer specification is `implementation: Partial`. |
| M7-G32 and M4-G22 | Internal Agent Resource Integration spells `knowledge.notebook-workspace.update` with a hyphen, as Notebook Editing, Core Mediation, the code, and the Operation Definition naming rule do. |

The other 79 open findings are documentation contradictions or missing facts that no accepted record decides. Questions Q-185 to Q-201 group them by owner.

## Questions For The Engineer

The numbering continues the summary record. Each question states the context, the options, the recommendation with its reason, and what this supplement did meanwhile. Some questions name specifications by abbreviation: CUG is Capability Usage Gateway Foundation, GKD is Generative Kernel Data And Operations, IARI is Internal Agent Resource Integration, KMR is the Knowledge Manager Agent specification (`20260704-knowledge_manager_internal_agent_runtime.md`), KSI is the Knowledge Store Implementation Contract, NBE is Knowledge Notebook Editing And Publication, PEM is Policy Enforcement Mapping, and WAC is Worker Agent Capability. OKF is the OpenKit Knowledge Format.

### Q-171. Should the Compute Neutrality Target be accepted before the `v0.1.0` freeze?

- Context: [Compute And Harness Neutrality](../decisions/20261020-compute_and_harness_neutrality.md) says "Design and neutrality validation precede the v0.1.0 freeze. Platform integrations follow the freeze." `20261020-compute_neutrality_target.md` is `status: Draft`. The summary record's G1-TD-03 states the gap but asks no question.
- Options: (A) Accept the specification before the freeze. (B) Amend the decision so that the freeze proceeds with the Draft.
- Recommendation: A, or an explicit B. A freeze that silently drops a decided precondition leaves the decision and the release in conflict.
- Meanwhile: no change.

### Q-172. Which Core document defines the Goal Coordinator role?

- Context: `core-concepts.md` names the Coordinator in its naming boundary. The Internal Core Roles table of `architecture.md` omits it, and the Core README term index has no row for it. [Goal Redesign Rulings](../decisions/20261002-goal_redesign_rulings.md) rule 1 adds "the Coordinator role". Q-18 covers only the Workflow Coordinator row.
- Options: (A) Define the role in `architecture.md` with the other Internal Core Roles and index it. (B) Define it in `work-model.md` beside Goal Mode.
- Recommendation: A. `architecture.md` owns every other internal role, so one owner keeps the role family together.
- Meanwhile: no change, because the Goal specification and `work-model.md` are held.

### Q-173. Should `docs/core/AGENTS.md` drop its restated and completed rules?

- Context: only the engineer may change this file. Lines 26 and 27 restate the Core retirement and archive rules that `docs/documentation-model.md` owns and name `docs/core/retired/`, which does not exist. Lines 28 and 29 instruct two splits that are complete: `knowledge.md`, `agent-session.md`, `policy.md`, and `sandbox.md` exist.
- Options: (A) Replace lines 26 and 27 with one pointer to the documentation model's Terminal Archive Audit And Archive Immutability section, and turn lines 28 and 29 into standing boundary rules such as "Keep knowledge and AgentSession in separate documents." (B) Keep the file.
- Recommendation: A. One fact in one place removes the drift risk, and a standing rule states what still holds.
- Meanwhile: no change. The foundation group record proposed no change to this file.

### Q-174. Should the product vision call `doctrine.md` "Doctrine"?

- Context: only the engineer may change `docs/product-vision.md`. It uses the link text "Foundation" for `./core/doctrine.md` five times; the document title is "Doctrine Model". No Core document or specification uses that link text, but nine change records do, for example `docs/changes/202609220000000001-engineering_quality_pilot/plan.md:18`.
- Options: (A) Change the link text to "Doctrine". (B) Keep "Foundation" as a vision name and add it to the glossary.
- Recommendation: A. One name for one document lets a reader find the owner without a mapping.
- Meanwhile: no change.

### Q-175. Which owner records the adapter-written native state that a resume reads?

- Context: retained data must stay usable from `v0.1.0` (NONNEG-001, COMPAT-001). Two adapters write OpenKit-authored files that a later resume reads, and no document states their shape:
  - DeepSeek: `openkit-deepseek-binding.json` under the retained state root with `cwd`, `mcpServerIds`, `model`, `models`, `sessionId`, and `skillTargetPaths` (`packages/worker-shim/src/adapters/deepseek.ts:64,82-89`), and a `private-home` child. The specification says only that "Unknown additive sidecar fields are ignored".
  - Pi: `<stateRoot>/sessions/binding-XXXXXX/session.jsonl`, a handle encoded as JSON `{cwd, path, sessionId}` whose SHA-256 digest Core keeps (`packages/pi-runtime-host/src/identity.ts:40-52,93-107`), and the `agent` home with `agent.initializing` staging. Only `packages/pi-runtime-host/README.md` states them.
- Options: (A) Each adapter specification records its adapter-written retained files with a closed core and an open extension, and the retained format register lists them; native-owned bytes stay opaque. (B) Declare adapter-private native state exempt from retained-data continuity and state the reason.
- Recommendation: A. A resume after an upgrade reads these files, so they are retained data under COMPAT-001; option B would allow an upgrade to strand existing Threads.
- Meanwhile: no change; the retained format register belongs to the contract-evolution group and the storage owners are held.

### Q-176. May a Codex Turn return more than one assistant message?

- Context: Codex Native Output Mapping returns "either one assistant message or no message". The pinned App Server marks each `agentMessage` with `phase` `commentary` or `final_answer`. The adapter ignores `phase` and fails the Turn as `malformed-result` when two non-blank messages arrive (`packages/worker-shim/src/adapters/codex.ts:128-130`).
- Options: (A) Select the `final_answer` message and treat commentary as non-final. (B) Keep the single-message rule and state that interim commentary fails the Turn.
- Recommendation: A, after a probe of the pin. Commentary is ordinary model behavior, and failing a correct Turn on it is not truthful classification.
- Meanwhile: no change.

### Q-177. Does a Codex `contextWindowExceeded` error prove a `length` outcome?

- Context: Codex Native Output Mapping preserves `length` when "correlated native evidence positively proves an output or context limit". The pinned schema carries `codexErrorInfo` `contextWindowExceeded`, but the adapter reads only `error.message` and never returns `length` (`codex.ts:109-141,289-292`).
- Options: (A) Treat `contextWindowExceeded` as positive proof and return `length`. (B) State that the pin gives no positive proof.
- Recommendation: A. A typed native discriminant is the positive evidence that [Truthful Native Stop Classification](../decisions/20261009-truthful_native_stop_classification.md) asks for.
- Meanwhile: no change.

### Q-178. Should the Codex specification state its inference-hint mapping?

- Context: the adapter registers `codexInferenceRuntimeHintMapping`, which cross-checks `x-codex-turn-metadata` and returns the request kind and lineage (`codex.ts:1553,1564`; `codex-inference-runtime-hint.ts:44-85`). [Native Compaction Phase Hint](../decisions/20261016-native_compaction_phase_hint.md) approves it, and the provenance and compaction specifications assign it to the Codex registry entry. The Codex specification does not mention it.
- Options: (A) Add the mapping to the Codex specification's owned inputs with a link to its owner. (B) Leave it to the provenance specification.
- Recommendation: A. A rebuild from the adapter specification alone would omit an accepted behavior.
- Meanwhile: no change.

### Q-179. Is an unrequested DeepSeek abort a normal completion?

- Context: DeepSeek Native Output Mapping fails a native stop without an OpenKit request. The pinned `dsh-acp@0.2.0-rc.2` maps the harness outcomes `aborted` and `blocked` to ACP `end_turn` (`lib/index.js:539-550`), and the adapter classifies `end_turn` as completed (`deepseek.ts:243-249`).
- Options: (A) Record the pin limit and require a pin that distinguishes these outcomes before enabling the template. (B) Accept the limit and state it.
- Recommendation: A. The adapter cannot tell a self-stop from success at this pin, so a completed Turn may be untrue.
- Meanwhile: no change.

### Q-180. Should the Pi specification state its protected native environment and offline mode?

- Context: `packages/worker-protocol/src/native-environment.ts:127-128` protects `PI_CODING_AGENT_DIR`, `PI_OFFLINE`, `PI_SKIP_VERSION_CHECK`, and `PI_TELEMETRY`, and the host forces offline mode, which stops native package installs and updates. The Agent manifest specification says each adapter owns its protected-name projection. Only `packages/pi-runtime-host/README.md:9,80` names these variables; no specification does.
- Options: (A) List the protected names and the offline effect in the Pi specification. (B) Keep them in code.
- Recommendation: A. The offline effect is observable to users.
- Meanwhile: no change.

### Q-181. Is the Pi "one adapter module" acceptance still the target?

- Context: Pi Acceptance requires Pi to be "one AgentManifest, one adapter module plus its static registry entry", removable "without changing NanoCore, the shared Harness contract, or canonical worker schemas". The code has four shim modules, the `pi-runtime-host` package, a workspace patch, and Pi names in shared code (`native-environment.ts:127`, `adapter-supply.ts:8`).
- Options: (A) Restate the acceptance as one adapter registry entry plus adapter-owned packages, and move Pi names out of shared code. (B) Keep the clause and open an implementation issue.
- Recommendation: A for the package count, because the SDK host is an accepted design, plus a follow-up for the shared names.
- Meanwhile: no change.

### Q-182. What owns adapter diagnostic prefixes now that the shared process runner is gone?

- Context: Codex and Pi Native Output Mapping say that "the shared process runner retains" 16 KiB stdout and stderr prefixes. `packages/worker-shim/src/adapter-registry.ts:226-227` says that the per-Turn adapters were removed with per-Turn launch. Codex never uses stdout as a diagnostic (`codex-app-server.ts:210`), and Pi keeps one prefix for the host lifetime, never reset per Turn (`pi.ts:831-832,1141-1149`).
- Options: (A) State that each resident adapter owns a per-Turn stderr prefix and that a protocol stdout is never a diagnostic. (B) Keep the text.
- Recommendation: A, because the shared runner that the text names no longer exists, and a prefix that is never reset fills during early Turns, so a later Turn reports earlier stderr. Fix the Pi per-host prefix if per-Turn is chosen.
- Meanwhile: no change.

### Q-183. Should the Pi specification state the native model representation it owns?

- Context: Pi Provider And Credentials says "This specification owns Pi's native representation of `modelParameters`" but states only context, output, and modality. The host also fixes the API family, zero costs, and reasoning flags (`packages/pi-runtime-host/src/host.ts:954-969`), and a changed parameter on any admitted route forces a successor binding (`pi.ts:641-643,1749-1776`).
- Options: (A) State the representation and the successor rule. (B) Keep them in code.
- Recommendation: A. The successor rule is observable, and the specification already claims the ownership.
- Meanwhile: no change.

### Q-184. Are the Workspace archive operations live in Web or roadmap-only?

- Context: [Streaming Archives Use Web And Administrator CLI](../decisions/20261003-streaming_archives_use_web_and_admin_cli.md) keeps the streaming bindings of the three archive operations in Web. The Portability screen uses them (`apps/web/src/screens/portability/data.ts:133,246,289`). The Web specification and the guard rows in `tests/web-user-operation-surface-contract.test.mjs:283-287` still say "unpublished under R008", and the held backup specification defers Web export and import progress.
- Options: (A) Classify them as live in the Web specification and the guard, with the held backup specification amended at its release. (B) Remove them from the Web screen.
- Recommendation: A. The decision and the shipped screen agree; the guard is a projection.
- Meanwhile: the operation names were corrected to catalog keys (SUP-S-08); the disposition is unchanged. The guard is a test, which this audit does not change.

### Q-185. Which owner states the Core stream projection?

- Findings: M1-G06, M1-G07, M1-G08, M1-G20, M1-G27.
- Context: `communication.md:239` sends "Concrete live stream availability" to protocol and communication specifications, and `20260704-app_api_openapi_projection.md:107` sends cursor behavior to the packages, so no document states the HTTP and SSE route behavior. `protocol.md:484` requires `core.stream.cursor_expired` for an old cursor while the held layout specification treats `since=0` as never expired. `protocol.md:423` requires `workspaceId` in every envelope although `core-concepts.md:75` says a Server-owned Thread has no Workspace anchor. `protocol.md:439` requires a "UUID request ID" while the identifiers specification excludes request IDs and states no format. `20261021-protocol_identifiers_and_enums.md:194` bounds delta payloads without numbers.
- Options: (A) The communication group owns one stream specification that states routes, `since` semantics including 0, frames, keep-alive, the Server-owned stream address, the `requestId` form, and delta bounds as current defaults. (B) Each existing owner adds its part.
- Recommendation: A. One owner for one boundary keeps the cursor rule and the envelope rule from drifting apart.
- Meanwhile: no change.

### Q-186. What is the Thread command surface?

- Findings: M1-G17, M1-G22, M1-G23.
- Context: `protocol.md:197` lists create, list, get, resume, and archive; `protocol.md:538` adds update; `pending_requests.md:183` names Thread deletion as an invalidating event, while the held work-data specification says hard delete is not an operation. No Thread revision field or updatable-field list exists. `20261002-operation_definition.md:111` makes an inaccessible Thread a uniform not-found but names no code. `thread.share` (Thread Visibility line 59) has no confirmation format, which matters only after `v0.1.0`.
- Options: (A) Core Concepts and Protocol state the closed Thread operation set, the revision field, and the not-found code; Pending Requests drops deletion until it exists. (B) Keep the text.
- Recommendation: A. An invalidating event that names a non-existent operation cannot be tested.
- Meanwhile: no change.

### Q-187. Which paths produce a `cancelled` Turn, and with which `stopReason`?

- Findings: M1-G09, M2-G29.
- Context: `protocol.md:239` leaves the producer to "the owning accepted specification" and `protocol.md:265` requires a `stopReason`. The held reliability specification has no `cancelled` row, and the held work-data specification calls the split an open product decision. `20261012-product_integrity_check.md:147` treats `cancelled` as terminal, but its mapping at lines 155 to 161 has no `cancelled` row, so a lawful cancelled Turn has no admitted outcome.
- Options: (A) Decide the producers and the reason, then add the integrity-check row. (B) Remove `cancelled` until a producer exists.
- Recommendation: A, decided with the held runtime-model release; add the integrity-check row in the same change.
- Meanwhile: no change.

### Q-188. Which record decides a Pending Request and who may resolve it?

- Findings: M1-G12, M1-G13, M1-G14, M1-G24, M7-G12, M3-G11.
- Context: `20260715-multi_user_workspace_system.md:377` makes the first terminal `PermissionDecision` and its AuditEvent the Approval winner, while `20260930-pending_requests.md:268` makes the PendingRequest record authoritative. The responsible-user rule differs between `pending_requests.md:270` and `multi_user_workspace_system.md:376`, and `policy.md:94` points to a rule that no document states. The request id (`pending_requests.md:106`) and the Approval id have no row in the identifiers table. The captured-call digest (`pending_requests.md:112`) has no canonical form, and "readiness order" (line 197) has no field. The receipt stores the command name, but `pending_requests.md:152` gives two spellings.
- Options: (A) Pending Requests owns the winner, the responsible-user derivation, and the request-id kind; Multi-User links them; the identifiers table registers the kinds. (B) Multi-User keeps the Approval winner and Pending Requests links it.
- Recommendation: A. The later Pending Requests design already makes its record the single authority, and authorization needs one rule.
- Meanwhile: no change.

### Q-189. Which canonical form do retained digests and derived identities use?

- Findings: M1-G10, M7-G36, M8-G15, M6-G18, M6-G09, M5-G23, M8-G12, M8-G21, M3-G07.
- Context: retained values depend on hashes and derivation names that no document fixes: the receipt "canonical semantic-input hash" (`protocol.md:570`), the Generative Kernel semantic fingerprint (GKD line 231), the Knowledge `requestDigest` (`20260703-knowledge_store_implementation.md:209`), the `kp_` proposal id (KSI line 141, which also breaks the one-form rule of the identifiers specification), the session compatibility key (Agent Session Continuity line 98 and Session-Static Materialization line 396), the `{workspaceId}` text in the Light App id name (GKD line 229), the answer-source Item id (Generative UI line 223), and the Policy snapshot digest (Policy Enforcement Mapping lines 427 and 614). `20260703-worker_context_package.md:303` uses a sort-keys rule that differs from the RFC 8785 rule at KSI line 153.
- Options: (A) The identifiers specification fixes one canonical form (RFC 8785 JSON with SHA-256) and each owner lists only its inputs. (B) Each owner states its own form.
- Recommendation: A. A rebuilt server must reproduce these values to honor retained receipts and ids, and one rule cannot drift.
- Meanwhile: no change.

### Q-190. How does a Light App schema change and recover?

- Findings: M8-G13, M8-G14, M8-G09, M8-G17, M8-G18.
- Context: GKD line 98 permits "field removal" while line 172 requires a proof of exact prior-value recovery before a populated-field drop. A restore (line 104) can roll `schemaRevision` back while line 209 says it advances only on activation, so a revision number can repeat for a different schema. The held layout specification lists a `schema_revisions` table that the register (line 155) says does not exist. GKD line 49 points to a capability-owner extension "below" that no section defines, and the held backup specification defers the app package format back to GKD.
- Options: (A) Disable populated-field removal until the recovery proof exists, make `schemaRevision` monotonic across restore, and settle the definition-history home with the storage release. (B) Accept removal with snapshot recovery only.
- Recommendation: A. Field removal can lose data, and a repeated revision defeats the staleness check.
- Meanwhile: no change.

### Q-191. Which document states the deployment mode and the authored configuration keys?

- Findings: M8-G28, M5-G29, M8-G39, M6-G23, M4-G21.
- Context: `20260628-nanocore_config_identity_contract.md:137` keeps a strict `mode` enum, and lines 200 and 201 mention "mode defaults" and a 32-character secret, but no authoritative text gives the mode selector, its precedence, the per-mode bind and data-root defaults, or the secret source; `OPENKIT_CORE_MODE` appears only in a cookbook. The NanoHost identity and credential-reference keys are unnamed (line 82). The Discord endpoint and `channels.discord` keys exist only in the operator Skill manual. `knowledgeMounts` and `defaultKnowledgeBaseId` sit in the Workspace object (held file storage specification) while the configuration contract closes that object (line 139). The LLM Gateway provider allowlist (Policy Enforcement Mapping line 527) has no home or key.
- Options: (A) The configuration contract lists every authored key with its owner, including mode selection and defaults. (B) Each owner states its own keys and the contract links them.
- Recommendation: A. Authored configuration is retained data, and a wrong mode default fails open because local mode grants implicit authority.
- Meanwhile: no change.

### Q-192. Do the identity specifications state their account rules exactly?

- Findings: M3-G15, M3-G27, M3-G19.
- Context: `20260704-remote_auth_credential_bootstrap.md:109` requires a Better Auth session of a `server-admin` Token owner to carry deployment-admin authority, while line 179 says NanoCore MAY derive it. Email normalization (Multi-User line 205, Remote Auth line 156) has no algorithm or uniqueness rule. Bearer verification in local mode (Remote MCP Interface line 144 against Remote Auth line 202) is unstated.
- Options: (A) State the derivation as a MUST, the normalization algorithm, and local-mode bearer handling. (B) Keep the text.
- Recommendation: A. Stored accounts and administrator authority depend on these rules.
- Meanwhile: no change.

### Q-193. Who is a Workspace administrator, and which rights does each association hold?

- Findings: M3-G40, M3-G17.
- Context: `20260703-policy_enforcement_mapping.md:373` defines Workspace administration as "current authority to manage that Workspace Policy", while `policy.md:36` gives every active member the full operation set; nothing says who may change managed-boundary statements. Multi-User line 243 says one active-member association supplies the access-right set, and the PEM registry (lines 262 to 290) maps operations to rights but not associations to rights.
- Options: (A) PEM states the association-to-rights table and the managed-boundary editor. (B) Keep the equal-member rule and state that no administrator tier exists.
- Recommendation: A or an explicit B. Authorization needs a finite answer.
- Meanwhile: no change.

### Q-194. Do the Vault and provider-subscription specifications agree with themselves?

- Findings: M3-G35, M3-G37.
- Context: `vault.md:42` allows user-scoped Vault records, but Vault Secret Injection line 182 homes only Server and Workspace rows, and the `env:` reference gate (line 347) has no owner. Provider Subscription Accounts says "ten ordinary operations" at line 228 and "nine" at line 555, and names fixed window ids `primary` and `secondary` at line 414 while line 420 forbids primary or secondary position.
- Options: (A) Correct the counts and the window wording, home user-scope rows, and name the `env:` owner. (B) Remove user scope.
- Recommendation: A after a code check; the counts are projection facts.
- Meanwhile: no change.

### Q-195. Which mediation rules decide authorization?

- Findings: M4-G12, M4-G07, M4-G08, M4-G06, M4-G14.
- Context: MCP Catalog Management lists approval-required and denied Tool lists at line 55 but refuses them at line 176; Worker MCP Tool Supply says "deny-unless-enabled" at line 201 and "no default-deny rule" at line 198. Whether the capability plane is enabled for every package is stated three ways: Agent Environment Package line 321 and Agent Manifest line 386 disable it, Worker Runtime Communication line 284 enables it. No document names the listener that serves `/v1/*`, the local-mode authentication, or the effect of a read-only token on Gateway use (Gateway lines 71 and 133). Gateway line 232 invents no durable home for unattributed public calls, while the held Audit specification writes them to Server families. The idempotency key of a Server-owned capability call has no `workspaceId` (Capability Usage line 146).
- Options: (A) Mediation decides each point in its owning specification. (B) Leave them to code.
- Recommendation: A. Each point decides whether a call is allowed or recorded.
- Meanwhile: no change.

### Q-196. Should the mediation vocabularies and names be closed?

- Findings: M4-G04, M4-G03, M4-G16, M4-G24, M4-G34, M4-G39, M4-G23, M7-G22, M7-G25, M4-G27.
- Context: Capability Usage line 112 lists seven capability families while Worker Agent Capability lines 107 to 112 use others, and the family is part of the idempotency key. The ledger-failure status and the recovery codes are named only in the CUG projection (lines 240 and 298). Two producer names exist for derived calls (WAC line 160, Pending Requests line 128). `mediation.md:212` gives a verb vocabulary without saying it is closed, while `knowledge.ask` and `knowledge.tell` are canonical ids. `mediation.md:26` says product-visible calls "should" be item-backed and line 167 says "MUST". The README term index lists `AgentCapability`, which `mediation.md` never defines. Internal Agent Resource Integration line 16 calls the delegated configuration Tool `administration.configuration.apply`, which is the Policy action; the Tool is `administration.configuration.dispatch` (Operation Definition line 147). The Tool touch counter excludes unavailable Tools in IARI line 134 but includes refusing closures in the Internal Agent Runtime line 130, and the counter feeds the `toolOccurrence` identity. Worker Agent Capability line 149 describes a request envelope that the MCP route at Worker MCP Tool Supply line 132 does not use.
- Options: (A) Close each vocabulary in its owner and correct the names. (B) Keep them open.
- Recommendation: A. The family and the counter feed retained identities, and the names appear in evidence.
- Meanwhile: no change; the naming conflicts are not obvious enough to fix without the owner.

### Q-197. Who may read Server Knowledge, and with which rights?

- Findings: M6-G06, M6-G07, M6-G13, M6-G33.
- Context: Knowledge Manager runtime line 131 and Personal Memory line 84 let Workers address only their Task's Workspace Knowledge, while Worker MCP Tool Supply line 159 adds "currently admitted Server Knowledge". Policy Enforcement Mapping line 275 maps only `knowledge.read`; notebook mutation, forget, maintain, tell, `memory.*`, and proposal operations have no right. Server maintenance has "no Workspace anchor" (KMR line 80), but retrieval and traces require one (KSI line 193, `protocol.md:154`). The attribute that marks an explicit user state inspection (KSI line 197) is undefined.
- Options: (A) Knowledge and Policy state the reader set, the operation-to-right rows, and the Server maintenance scope. (B) Keep Server Knowledge administrator-only and say so.
- Recommendation: A, or B stated explicitly. This is a disclosure boundary.
- Meanwhile: no change.

### Q-198. Which Knowledge shapes and lifecycle rules must the specifications state?

- Findings: M6-G03, M6-G10, M6-G11, M6-G27, M6-G29, M6-G28, M6-G22, M6-G25, M6-G30, M6-G32.
- Context: the Scope Schema keys and default types (Governance line 96, KSI line 139), the Git author mapping and commit metadata (Notebook Editing line 64), the suppression row and its removal operation (Personal Memory line 104), Proposal ref retention and pruning (NBE line 68), the maintenance Thread identity (KMR line 67), the "weak evidence" predicate (KSI line 201), the index owner after a human edit (KSI line 86 against KMR line 149), the editing command set (NBE line 76), and the Memory export operation (Personal Memory line 114) are unstated. The v0.1 OKF snapshot still calls itself normative, while KSI line 80 targets v0.2.
- Options: (A) State each in its owner; record that the v0.1 snapshot is historical in the documentation model's snapshot section. (B) Leave them to code.
- Recommendation: A for the retained shapes and the user-visible operations; snapshots are not edited.
- Meanwhile: no change.

### Q-199. Which AgentSession and adapter facts must be stated before release?

- Findings: M5-G11, M5-G17, M5-G20.
- Context: `protocol.md:185` lists AgentSession statuses, but no document gives the record fields or the transition table (Agent Session Continuity line 70). Codex line 77 still defers the Tool re-list declaration to a probe, although Codex line 296 records the answer: "Codex does not re-list tools at Turn start, so supply change requires a successor." The OpenCode (lines 134 and 144) and Pi (lines 163 and 173) specifications defer the Tool re-list and the native bearer carrier to a probe without recording the result, which decides whether a Tool change needs a successor. Worker Control Protocol line 244 forbids a one-second header timer that the held NanoHost specification uses.
- Options: (A) State the record fields and transitions, record each probe result, and settle the timer rule with the held release. (B) Keep them in code.
- Recommendation: A. Restart compares stored AgentSession state, so its shape is retained data.
- Meanwhile: no change.

### Q-200. Do the release documents agree on image promotion and manifest keys?

- Findings: M8-G32, M8-G35, M8-G31.
- Context: Container Image Packaging line 628 says the release tag build pushes an untagged digest, while Release Management lines 190 and 198 say proved digests replace tag-stage rebuilding. The release manifest keys and the `SHA256SUMS` scope (Release Management lines 102 and 284) are not given, and the release cookbook disagrees on the scope. The public HTTP route set behind the proxy appears only in a cookbook.
- Options: (A) Release Management owns promotion and the manifest keys; Image Packaging links it. (B) Keep both texts.
- Recommendation: A. The later Release Management design states the current flow.
- Meanwhile: no change; the cookbooks belong to the periphery.

### Q-201. Who owns the Web operation inventory and its roadmap owners?

- Findings: M8-G03, M8-G06.
- Context: the inclusion rule of the Web specification (line 101) depends on `PUBLIC_OPERATION_ACCESS`, which the specification does not own (line 32), and no document names its owner. The code now builds that catalog from the operation definitions (`apps/nanocore/src/auth/operation-access.ts:158`), and Operation Definition line 286 says that the access keys of the eleven Material definitions are removed. Line 202 names R008 as a capability owner although `docs/roadmap.md` marks R008 complete.
- Options: (A) Name the definition catalog as the inclusion source and allow only open roadmap items as owners. (B) Keep the text.
- Recommendation: A, because the access catalog is a projection of the definitions that Operation Definition owns, and a completed roadmap item cannot own remaining work.
- Meanwhile: no change.

### Q-202. Does the Web Automations contract admit the monthly UTC cadence?

- Context: [Monthly UTC Recurring Work](../decisions/20261017-monthly_utc_recurring_work.md) accepted a bounded monthly UTC variant of the existing recurring definition, and the Scheduler Recurring Event Triggers specification owns it. The decision names no Web owner, and that specification excludes Web presentation. The Web specification's Recurring Workflow Projection says "The initial surface configures a fixed interval", its acceptance says "without calendar choices", and its deferred work keeps calendar recurrence out of Automations. The shipped screen offers a monthly UTC cadence through the same five `automation.*` operations (`apps/web/src/screens/automations/AutomationsScreen.tsx:36-50,518`).
- Options: (A) Amend the Web contract to admit the monthly UTC cadence: the day 1 to 28 and UTC time controls, the display of a monthly expired range, and the acceptance and deferral bullets. (B) Keep the fixed-interval contract and remove the monthly controls from the screen, which is an implementation issue.
- Recommendation: A. The decision reuses the existing definition and operations, so the Web projection of that owner can cover both shapes, and the shipped screen already offers them. Web is not a named affected owner, so the engineer decides the scope.
- Meanwhile: the Current Implementation Projection states the shipped cadences (SUP-S-07). The contract, acceptance, and deferral text are unchanged.

## Semantic Preservation

The inventory compares the 30 changed Core documents and specifications with the base `0bd8c542`.

| Item class | Before | Present unchanged | Changed |
| --- | --- | --- | --- |
| Normative sentences | 2,582 | 2,567 | 15 |
| Other sentences and table rows | 10,199 | 10,138 | 61 |
| Numbers with units | 371 | 370 | 1 |
| Backticked identifiers | 2,690 | 2,683 | 7 |
| Heading anchors | 824 | 824 | 0 |
| Links | 491 | 491 | 0 |

Every changed normative sentence is one of these: a "Permissions" name replaced by "Policy" or "Core Policy" (SUP-C-06), a Codex home sentence (SUP-S-01), a Web operation name (SUP-S-08), a Web count or workflow list (M8-G01, M8-G02, M8-G05), the notebook operation spelling (M7-G32), or a projection statement (SUP-S-03 to SUP-S-05). The changed number is the stale count 244 (M8-G01). The changed identifiers are five client member names and the underscore operation name, replaced by catalog keys, and the status word `Implemented` (M8-G05). No anchor or link was lost. The two new link targets are the Pending Tool Calls decision (SUP-C-05) and the Decision Records section of the documentation model (SUP-C-02), so no inbound link needed repointing.

## Review

One fresh independent Reviewer context checked the diff from `0bd8c542` to `4b5e781` against the repository and the code at `547887980`. It ran the document model, index, and specification lifecycle validators, and they passed. It reported three blocking and seventeen non-blocking findings. This section gives each finding and its resolution.

Blocking findings, all accepted:

1. The SUP-C-06 count was wrong: the diff has 52 replacements in 24 documents. The row now gives that count, and a list gives each document and its count.
2. SUP-S-07 added a Web MUST for the monthly UTC variant that no accepted record decides, because the decision names no Web owner and the scheduler specification excludes Web presentation. It also left the Recurring Workflow Projection and the Current Implementation Projection inconsistent. The contract, acceptance, and deferral text are restored, the Current Implementation Projection states the shipped cadences, and Question Q-202 asks the engineer.
3. The G1 dispositions could not be traced: only 90 of the 296 findings had an ID in this record, and the held labels of the probe record disagreed with the counts. Each module table of the probe record now has a Disposition column, built from the four inspector reports, and the probe text separates its own group labels from the comparison result.

Non-blocking findings, all accepted:

1. "the current Policy Model" in App Update Delivery could name the Policy Model specification. It now links Core Policy.
2. The new Core README bullet restated part of the documentation model. It now links the Decision Records section.
3. SUP-C-04 changes four index rows, not five.
4. The kept list now names the generic heading in `generative-apps.md`, and the periphery hand-off names the cookbook and the roadmap.
5. M8-G05 now says that the Composer claim waits for the held work-model audit.
6. M8-G01 now says that the six other places already stated 248.
7. The probe derivation table no longer labels Quick Chat Workspace and Scheduler Recurring Event Triggers as held.
8. The probe record now says that "Cross-cutting" names its own themes.
9. The Invalid definition now says that held text answers M3-G30 and M3-G45.
10. The quote statement now says what the 73 quotes cover and why a missing-fact finding has no quote.
11. Q-174, Q-180, Q-199, and Q-201 are corrected against the cited evidence.
12. Q-182 and Q-201 now give their reasons.
13. Q-189 is a rule question because one answer fixes a form for many documents. The Remaining Work items now say what each rule question decides.
14. Summary Remaining Work item 5 now gives the combined totals.
15. The summary issue rows now point to the Issues Opened section of this record.
16. The Questions section now spells out its abbreviations.
17. The probe record has a blank line before its Method heading, and a finding with two types lists both.

The Reviewer also named two points for the engineer:

- The summary record was edited after its close-out. Pull request #521 is not merged, and on 2026-10-25 the engineer directed this session to add its findings to that audit, so the edit follows that direction. The pull request description names the edit.
- Delegated Worker Policy Maintenance says that "local/server identity remains owned by Policy". The former text gave the same owner under the name "Permissions", so the rename does not change the claim. `policy.md` owns the derivation of administrator authority in each mode, and `identity.md` owns Identity; the engineer can decide which one the sentence means.

## Remaining Work

The Remaining Work section of the summary record is the single list. This supplement adds these items to it:

- The engineer deferred the archive check on 2026-10-25 until a way to handle frozen archived documents is decided. Both sessions' read-only passes agree on its result.
- The held-group audit takes the 84 findings that the Disposition column of the G1 probe record marks Held, and renames "Permissions" to "Policy" in the held documents (SUP-C-06). The periphery audit takes the two periphery uses of "Core Permissions". Q-187, Q-190, and Q-199 also depend on held releases.
- Writing and organization (G4 and G5) were recorded, not rewritten. After the engineer answers the questions that set one rule for many documents (Q-01 on shapes that only code defines, Q-23 on experience-chosen numbers, Q-28 on tracker labels, and Q-189 on canonical digests), the rewrite runs in batches by owner under the method of issue #218: criterion inventory, rewrite, and an independent verifier.
- Before triage, recheck the 69 `doc-audit` issues against current `main`, because `main` moved after both audit bases.
- A decision sheet over the open questions can group the repeated families so that one rule answers many questions.
