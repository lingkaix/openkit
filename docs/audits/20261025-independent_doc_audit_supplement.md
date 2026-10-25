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
| SUP-C-02 | The Document Layers list of the Core README omits decision records, although Core documents link them beside their rules. | `docs/documentation-model.md` Decision Records. | Fixed: one bullet for `docs/decisions/`. |
| SUP-C-03 | The aspect description and the term index row for `contract-evolution.md` omit three concepts that it owns. | `contract-evolution.md` boundary section owns retained data continuity, the closed core and open extension, and the post-launch operation semantic promise. | Fixed: the description and the index row name them. |
| SUP-C-04 | The term index omits canonical terms of four aspect documents. | `knowledge.md` defines `Derived Representation` and `Observation`; `sandbox.md` defines isolation levels and the shared Sandbox; `protocol.md` owns the entity-identifier grammar, scope-qualified object references, and Pending Request Semantics; `policy.md` defines `AssistantReadScope` and `OutputAudience`. | Fixed: the five index rows name them. |
| SUP-C-05 | `core-concepts.md` defines `ApprovalRequest` as "a blocking human authorization decision". A later accepted decision removed blocking gates, and `protocol.md` defines "blocking" as a derived display state of a pending request. | [Pending Tool Calls](../decisions/20260930-pending_tool_calls.md): "There is no blocking gate that pauses a Turn"; `protocol.md` Approval Semantics: "the raising Turn continues"; Pending Request Semantics defines "blocking". | Fixed: the definition says that the request holds back its effect, not the raising Turn, and cites the decision. The six covered kinds are unchanged. |
| SUP-C-06 | Active documents call `policy.md` by its former name "Permissions": "Core Permissions", "Permissions Model", "Permissions Core", "[Permissions](../core/policy.md)", and "under Permissions". | `policy.md` is titled "Policy Model"; the Core README term index and `docs/glossary.md` have no "Permissions" aspect; the archived `superseded/20260513-core_protocol_model_notes.md` names the former `docs/core/permissions.md`. | Fixed: 53 replacements in `core-concepts.md`, `identity.md`, `protocol.md`, and 28 non-held specifications. "Core Permissions" became "Core Policy" so that it stays distinct from the Policy Model specification. Kept: decision titles, the generic noun in the Worker Context Package table, the statement kind in `policy.md`, "General Permissions" in Delegated Worker Policy Maintenance, and "the Permissions pipeline" in Policy Enforcement Mapping, because their meaning is not certainly the aspect. Held documents keep the former name for their own audit. |
| SUP-C-07 | `doctrine.md` states that agent-principal activation "remains unclaimed". | Summary Question Q-70 already asks the engineer. | No change; this record does not pre-empt Q-70. |

## Specification Corrections

| ID | Specification | Finding | Evidence at `547887980` | Disposition |
| --- | --- | --- | --- | --- |
| SUP-S-01 | Codex Worker Adapter | Three sentences call `CODEX_HOME` and its rollout forest "AgentSession-private". | The specification's own Generic Volume Retention Amendment and [Codex Home Retained Whole](../decisions/20260930-codex_home_retained_whole.md) make `CODEX_HOME` the "admitted Thread-private native data home"; `packages/worker-shim/src/harness.ts:318` places it in the Thread runtime root. | Fixed: "Thread-private" in the Upstream Contract, Provenance, and Tests sentences. |
| SUP-S-02 | Codex Worker Adapter | The projection says that image installation, schema inclusion, and deployed smoke "remain with the image slice". | `containers/workers/Dockerfile:30,40` copy the schema package and lines 231-252 install the binary; `containers/worker-runtimes/smoke.sh:19,134-153` checks `codex --version` and runs `session.open`, `session.inspect`, and `session.close`. | Fixed: the projection states the installed binary, the schema package, and the smoke scope. |
| SUP-S-03 | Codex Worker Adapter | The projection says that the Turn consumer does not forward completed-result diagnostics. | `packages/worker-shim/src/turn.ts:563` adds the adapter diagnostics to the terminal status for every outcome. | Fixed: the projection states that the consumer forwards them; the preparation-error gap stays. |
| SUP-S-04 | DeepSeek Worker Adapter | The projection says that a prompt RPC error settles `failed` / `host_ended`. | `packages/worker-shim/src/adapters/deepseek.ts:236` returns `prompt_failed` when a correlated native error response set `promptFailed` (line 1732), before the `host_ended` check. | Fixed: both reasons and their conditions. |
| SUP-S-05 | DeepSeek Worker Adapter | The projection says that the Turn consumer publishes the diagnostic map only on failures. | `turn.ts:563`, as in SUP-S-03. | Fixed. |
| SUP-S-06 | Pi Worker Adapter | Native Output Mapping says that `agent_settled`, `message_end`, `turn_end`, and `agent_end` are historical JSON-mode names, "not the SDK product schema". | `packages/pi-runtime-host/src/outcome.ts:52-86` branches on these SDK events, and the pinned SDK declares `type: "agent_settled"` in `AgentSessionEvent`. | Fixed: the sentence states that the SDK host reads these SDK events. |
| SUP-S-07 | Web Product Surface Projection | Three statements limit Automations to the fixed interval "without calendar choices". | [Monthly UTC Recurring Work](../decisions/20261017-monthly_utc_recurring_work.md) accepted the bounded monthly UTC variant; the Scheduler Recurring Event Triggers specification owns it; `apps/web/src/screens/automations/AutomationsScreen.tsx:36-50` offers it. | Fixed: the statements name both timing variants and cite the decision. |
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

In progress. Read-only inspectors compare each of the 296 probe findings with the summary record, the group records, and the current documents. This section will give each finding's disposition.

## Questions For The Engineer

The numbering continues the summary record. Each question states the context, the options, the recommendation with its reason, and what this supplement did meanwhile.

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

- Context: only the engineer may change `docs/product-vision.md`. It uses the link text "Foundation" for `./core/doctrine.md` five times; the document title is "Doctrine Model", and no other document uses that name.
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

- Context: `packages/worker-protocol/src/native-environment.ts:127-128` protects `PI_CODING_AGENT_DIR`, `PI_OFFLINE`, `PI_SKIP_VERSION_CHECK`, and `PI_TELEMETRY`, and the host forces offline mode, which stops native package installs and updates. The Agent manifest specification says each adapter owns its protected-name projection; no document names these variables.
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
- Recommendation: A, and fix the Pi per-host prefix if per-Turn is chosen.
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

## Semantic Preservation

The inventory compares the 30 changed Core documents and specifications with the base `0bd8c542`.

| Item class | Before | Present unchanged | Changed |
| --- | --- | --- | --- |
| Normative sentences | 2,582 | 2,569 | 13 |
| Other sentences and table rows | 10,199 | 10,140 | 59 |
| Numbers with units | 371 | 371 | 0 |
| Backticked identifiers | 2,690 | 2,685 | 5 |
| Heading anchors | 824 | 824 | 0 |
| Links | 491 | 491 | 0 |

Every changed normative sentence is one of these: a "Permissions" name replaced by "Policy" or "Core Policy" (SUP-C-06), a Codex home sentence (SUP-S-01), a Web Automations statement (SUP-S-07), or a projection statement (SUP-S-03 to SUP-S-05). The five removed identifiers are client member names replaced by catalog keys (SUP-S-08). No anchor, number, or link was lost, so no inbound link needed repointing.

## Review

Pending: one fresh independent Reviewer context checks this supplement's diff before the pull request.

## Remaining Work

The Remaining Work section of the summary record is the single list. This supplement adds the items it found there.
