---
date: "2026-10-24"
---
# Independent Documentation Audit: Mediation Group

This non-authorizing record holds the mediation group of the [independent documentation audit](20261023-independent_doc_audit.md). Its owning rule is [Change Execution Governance](../change-execution.md). It records observations, dispositions, and questions. It does not authorize design.

## Scope And Base

- Group base SHA: `314f72fe2e62864b34eb30a155488c4507b80553` (`main` on 2026-10-24). Issue #440 had no comments and held no group in this scope. The policy group's later correction of `20260930-pending_requests.md:334` (commit `d29957e`) is the text that the MCP line 231 edit follows.
- Core document: `docs/core/mediation.md`.
- Specifications: `20261002-operation_definition.md` (OD), `20260703-worker_agent_capability.md` (WAC), `20260704-capability_usage_gateway_foundation.md` (CUG), `20260704-worker_mcp_tool_supply.md` (MCP), `20260526-llm_gateway_responses_api.md` (GW), `20260703-pi_ai_provider_gateway_adoption.md` (PIA), `20260708-pi_ai_unified_llm_backend.md` (PIU), `20260721-provider_subscription_accounts.md` (PSA), and `20261018-nanocore_interception_and_information_consolidation.md` (ICP).
- G3 inspection: five read-only inspector contexts (MD-OD for OD and WAC; MD-CUG for CUG and MCP; MD-LLM for GW, PIA, and PIU; MD-PSA for PSA; MD-ICP for ICP). They read code only and ran no tests. The auditor verified each kept finding against the code.
- Hand-offs received: `20260704-worker_mcp_tool_supply.md:231` from the policy group, and `20260703-worker_agent_capability.md:114,378` from the vault group. All three are resolved below.

## G2 Core Against Specifications

- MD-G2-01: Core Mediation line 48 gives the gateway "rate-limit hooks, budget checks", and line 179 says Core retains "rate-limit control", while lines 114 and 276 list "owning rate limits" as a mediation non-responsibility. ICP rows I39 and I40 assign a rate-limit and token-budget gate to lanes. No owner says who owns a rate limit. Question Q-85. This is also the open G1 gap G1-TD-04.
- MD-G2-02: Core Mediation line 10 owns "the semantic definition and invocation procedure of an `Operation`, mediation points (`<operation>@<stage>`)". OD owns the declarative definition and its projections, and OD line 79 gives stage and binding contracts to Policy Enforcement. Ownership of one concept is split three ways. Question Q-86.
- MD-G2-03: Core Mediation line 68 says boot admission accepts no participant bindings. The ICP row I36 (boot self-check) is marked `U`, which ICP line 113 defines as "later routing after the first pilot". Question Q-87.
- MD-G2-04: WAC line 177 listed four `CapabilityCall` statuses; Core Mediation has a closed vocabulary of seven terminal statuses. The specification text is older. Corrected: WAC now refers to the Core vocabulary.
- MD-G2-05: Core Mediation line 202 lets routing consider "provider health"; GW line 65 excludes active health scoring. Routing may still use failover outcomes, so this is not a conflict.
- MD-G2-06: Core Mediation line 12 gives `UsageRecord` to Core Evidence, which is a held group. CUG agrees. No action.

## G3 Specifications Against Implementation

| Finding | Clause | Evidence (at the group base SHA) | Adjudication | Action |
| --- | --- | --- | --- | --- |
| MD-MCP-05 | MCP Server catalog: every call rechecks selection, binding, authorization, and digest | `apps/nanocore/src/runtime/captured-pending-call.ts:524-552` rechecks digest and credentials before dispatch only for `scope === 'server'` | Code differs from a current accepted document | Issue #481 (blocking candidate: credentials) |
| MD-PSA-01 | PSA App API Error Contract: status returns 200 `unavailable` when the Vault prevents reconciliation | `apps/nanocore/src/llm/provider-subscription-accounts.ts:1187-1214` fails with 503; no producer of `status: 'unavailable'` | Code differs from a current accepted document | Issue #482 |
| MD-MCP-03 | MCP Routes: an oversized semantic result fails with `mcp-result-too-large` | `apps/nanocore/src/runtime/worker-mcp-gateway.ts:229-237,1163-1174` use `mcp-server-unavailable` for the tool list | Code differs from a current accepted document | Issue #483 (low) |
| MD-LLM-04 | PIU Cache Scope Input: public metadata cannot override server-owned authority | `apps/nanocore/src/llm/prompt-cache-key.ts:211-214` prefer metadata scope | Code differs from a current accepted document; latent | Issue #484 (low) |
| MD-OD-01 | OD: "This registry extension is Not Started." | `packages/app-api-schemas/src/operation-contract.ts:125-147`, `operation-definitions.ts:195-243` declare native `policy.write` and `mcp.call-tool` in `OPERATION_REGISTRY` and filter them from `OPERATION_DEFINITIONS` | Projection drift | Corrected |
| MD-OD-02 | OD: three archive and two Artifact streams, "all five stream exclusions" | Eight `binding: 'streaming'` definitions, including `artifact.version-file-commit` and the two Knowledge package operations of the later accepted `20261018-file_storage_and_knowledge_packages.md` | Document outdated by a later accepted specification | Corrected; the Knowledge package owner is named for package bytes. The Web and administrator CLI guidance and transfer acceptance stay limited to the archive and Artifact operations, because no record decides a Web channel for Knowledge packages and the Guide text in `apps/nanocore/src/remote-mcp-routes.ts:35,45` omits them; Question Q-112 |
| MD-OD-09 counts | OD projection: eleven provider-subscription, three App-update, fifteen Workspace lifecycle, 27 JSON operations | Top-level keys: 13 in `provider-subscription-operations.ts`, 4 in `app-update-operations.ts`, 16 in `workspace-lifecycle-operations.ts` (with `user.disable`), 33 in the four governance, environment, App search, and Vault tables | Projection drift | Counts corrected; "former sixteen routes" is history and stays |
| MD-OD-09 sentence | OD: "Operations not yet migrated ... retain hand-written routes" | No hand-written JSON product route found outside the definition-derived route, the streaming routes, and support routes | Not decided which work keeps `implementation: Partial` | Question Q-99 |
| OD other | OD line 308: "The eleven ordinary core commands and Quick Chat" | No Quick Chat operation; `conversation.submit` uses the transport-free service | Document outdated by [Retire Stateless Quick Chat](../decisions/20261016-retire_stateless_quick_chat.md) | Corrected, as in the policy group |
| MD-OD-03, 04 | OD Remote MCP: typed unsupported-operation refusal; call annotations truthful for the operation | `apps/nanocore/src/remote-mcp-routes.ts:147-158,241-248` | Not decided | Question Q-95 |
| MD-OD-05, 06 | OD Declarative Definition: credential list and "only those facts" | `operation-contract.ts:5-12,110-116,150-163` | Not decided | Question Q-96 |
| MD-OD-07 | OD Implementation Join: common algorithms contain no family dispatch | `apps/nanocore/src/operation-resolvers.ts:102-110,254-277` | Not decided | Question Q-97 |
| MD-OD-08 | OD Trusted Resolvers: read errors stay errors | `operation-resolvers.ts:238-249` catches every error from a pure function and reports a Workspace denial | Latent; no read error reaches the catch today | No action |
| MD-OD-11 | Header-carried request identity for JSON mutations | `apps/nanocore/src/operation-json-routes.ts:66-76` | No owner states the general rule | Question Q-98 |
| MD-WAC-01, 05 | WAC projection: "The Pi and OpenCode adapters project none"; six dispatched Work Tools | `packages/worker-shim/src/adapters/opencode.ts:757-765`, `pi.ts`, `deepseek.ts:2243-2246`; `apps/nanocore/src/runtime/openkit-work-supply.ts:184` supplies `work.artifact.submit` | Projection drift | Corrected |
| MD-WAC-05 other | WAC: the Work supply | `openkit-work-supply.ts:130-189` supplies `automation.event-admit`, `knowledge.ask`, and `knowledge.tell` to every package | Not decided whether the unconditional supply is intended | Question Q-100 |
| MD-WAC-02 | WAC Error Model `capability_*` codes | No production hit; the MCP family uses `mcp-*` codes | Not decided | Question Q-92 |
| MD-WAC-04 | WAC Built-In Generative Target: Kernel and Generative UI only; dots and hyphens become underscores; not cut over | `apps/nanocore/src/runtime/openkit-generative-supply.ts:21-30` adds Light App catalog and Vault request definitions and uses `operationToolName` | Document outdated by [Agent-Facing Naming](../decisions/20261017-agent_facing_naming.md), OD Names, and MCP line 239 | Corrected |
| MD-WAC-06 | WAC: an unadmitted media type returns a Tool error | `openkit-work-supply.ts:46` admits any syntactic media type | Not decided | Question Q-101 |
| Vault hand-off | WAC lines 114 and 378: the Codex auth JSON runtime-file path | `apps/nanocore/src/runtime/turn-executor-factory.ts:6181-6189` rejects runtime-file materialization on persistent Worker images | Projection drift; the capability gap is issue #480 | Corrected |
| MD-CUG-02 | CUG projection: single logical Gateway call and reused request-id refusal "awaiting implementation" | `apps/nanocore/src/llm/gateway-routes.ts:241-246,2715`; `apps/nanocore/src/capability/usage-ledger.ts:1349-1395` | Projection drift | Corrected |
| MD-CUG-03 | CUG projection: MCP conformance proves `interrupted` | No MCP producer or test finishes a call as `interrupted` (`worker-mcp-routes.ts:1874-1882`) | Projection drift | `interrupted` removed from the proof claim |
| MD-CUG-01 | CUG CapabilityCall lifecycle: 13 replay attribution fields | `usage-ledger.ts:1290` also compares `schemaSnapshotId` | Not decided | Question Q-89 |
| MD-CUG-04 | CUG GatewayCallContext: a non-null authority actor is required | `usage-ledger.ts:84-86,369,486-488` accept a null actor and skip the admission audit | Not decided | Question Q-90 |
| MD-CUG-05 | CUG line 122: a revoked actor records no Workspace effect | `captured-pending-call.ts:171-227` records a failed execution call, as `20260930-pending_requests.md:365` requires | Two accepted specifications conflict | Question Q-88 |
| MD-CUG-06 | CUG Decision names four components | Functions in `usage-ledger.ts`, no units with those names | The names are roles | No action |
| MD-MCP-01 | MCP lines 203 and 231: re-evaluation before claim; `denied-not-executed` | `apps/nanocore/src/runtime/pending-request-flow.ts:787-854` claims, then re-evaluates in the Main submission check, and ends `execution-error` | Document outdated by `20260930-pending_requests.md:365,369` | Corrected |
| MD-MCP-07 | MCP projection: no fixed per-Turn snapshot | `apps/nanocore/src/runtime/mcp-tool-schema-snapshots.ts:474-518` bind the first stamped snapshot of the Turn | Projection drift | Corrected |
| MD-MCP-02 | MCP: one `CapabilityCall` for every `mcp.call-tool` request | `worker-mcp-routes.ts:1416-1435` returns the duplicate pending result before a call starts | Inside-document tension | Question Q-91 |
| MD-MCP-04 | MCP Error normalization: a small closed code set | `worker-mcp-routes.ts:1576,1681,1818` emit `mcp-policy-stale`, `mcp-policy-unavailable`, `policy_evidence_unavailable`, `recovery_required` | Not decided | Question Q-92 |
| MD-MCP-06 | MCP Credential injection: revocation triggers `stdio` teardown | `apps/nanocore/src/vault/vault-grants.ts:316` calls no gateway hook; teardown on the next call or after 60 s idle | Not decided | Question Q-93 |
| MD-MCP-08 | MCP: one `UsageRecord` unless upstream is proved not contacted | `worker-mcp-routes.ts:2599-2615,1700-1743,1858` | Not decided whether discovery contact counts | Question Q-94 |
| MD-LLM-01 | GW projection: the logical-model schema does not contain `contextManagement` | `packages/config-schema/src/gateway.ts:29`; `apps/nanocore/src/llm/logical-models.ts:137-148` | Projection drift; the Responses injection gap stays | Corrected. The same drift in `20260902-agent_runtime_context_compaction.md:318` is handed to the agent-session group |
| MD-PIA-01 | PIA Summary and projection: pin `0.84.2`, its integrity and `gitHead` | `apps/nanocore/package.json:34` and `pnpm-lock.yaml:3392-3393` give `0.99.2` and its integrity | Projection drift | Corrected. The installed package metadata has no `gitHead`, so the stale `gitHead` is removed and not replaced |
| MD-PIA-03 | PIA Accepted Design: "one small pi-ai boundary module" | Eight NanoCore modules import pi-ai | Document outdated by PIU line 260, "one cohesive `PiAiGatewayClient` and small mapping modules" | Aligned with PIU |
| MD-PIA-02 | PIA: single internal dependency, private to NanoCore | `packages/pi-runtime-host/package.json:18` pins pi-ai `1.0.2` | Not decided | Question Q-103 |
| MD-LLM-03 | GW and PIU Cache Scope: the resolver hashes the scope before provider use | `apps/nanocore/src/llm/prompt-cache-key.ts:128-139` passes explicit and metadata keys unhashed | Not decided | Question Q-104 |
| MD-PIU-01 | GW line 113: unknown metadata fields are rejected | `packages/config-schema/src/provider.ts` strips unknown leaves, under COMPAT-001 | Specification sentence conflicts with the root extension rule | Question Q-105 |
| MD-LLM-06 | GW: no subscription-family context clamp | The Codex provider template comment says "product policy" for an authored leaf | Wording in a configuration template; not a specification | No action |
| MD-PSA-07 | PSA Rollout plan describes landed work as remaining | PSA Current Implementation Projection lines 516-524; thirteen live operations | Projection drift | The plan now says that it has landed and stays as the record of the accepted order and constraints |
| MD-PSA-02 | PSA: startup reconciliation | `reconcileAll` (`provider-subscription-accounts.ts:1284`) has no production caller | Not decided | Question Q-106 |
| MD-PSA-03 | PSA type blocks | `packages/app-api-schemas/src/provider-subscriptions.ts:219,238-270` add `label` and the never-produced `activeUntil` | Not decided | Question Q-107 |
| MD-PSA-04 | PSA: residue fails closed; reviewed cleanup is the recovery | No reviewed cleanup path exists; a failed create leaves its own directory | Not decided | Question Q-108 |
| MD-PSA-05 | PSA: reconcile is a lifecycle action | `provider-subscription-accounts.ts:637-649` reconcile and audit on each Codex attempt | Not decided | Question Q-109 |
| MD-PSA-06 | PSA: invalid slot id gets `provider_subscription_account_slot_invalid` | Create returns `invalid_request` (`provider-subscriptions.ts:92-97`) | PSA line 281 is ambiguous | Question Q-110 |
| MD-ICP-01, 02 | ICP line 183: Goal-domain activation, Task-resource intersection, and agent-principal authority are Not Started | `apps/nanocore/src/policy/goal-domains.ts`, `goal-task-access.ts`, `agent-gate.ts`; `apps/nanocore/src/policy/README.md:42` | Projection drift; ICP lines 80 and 216 already name the I16 subset | Corrected; automatic Policy review stays Not Started |
| MD-ICP-03 | ICP: advice and transform cannot activate | `apps/nanocore/src/policy/interception.ts:98-106` refuse them, but the dispatch code stays | Not decided | Question Q-102 |
| MD matches | OD definitions, resolvers, names, projections; WAC loopback credentials and identifiers; CUG lifecycle, idempotency, recovery, raw-payload rejection; MCP bounds, redirects, redaction, pending result; ICP authority, bindings, failure kinds, circuit, rows | See the inspectors' tallies in the audit working space | Match | None |

Frontmatter `updated` values of OD and WAC are older than their latest content. The audit does not change `updated` dates; no action.

## G4 Organization

No move, merge, or split is applied. OD line 306 is one paragraph of about 900 words that mixes family joins, status codes, administrator rules, and the not-yet-migrated rule. A split is a G5 style change of an implementation projection, but its "not yet migrated" sentence is open as Q-99, so the split waits for that answer and is recorded with Q-111.

## G5 Writing

- Undefined labels: S42 (GW), S39 (WAC, MCP), #209 and #25 (GW), #127 (PIU), #144 (OD, CUG), #117 (MCP), B4 (OD), L6 (WAC, CUG, MCP), TS labels and the lane codes (ICP). As Q-28: Question Q-111.
- Experience-chosen numbers not marked as a current default: WAC "for at most 10 seconds" and "at most twenty bounded snippets"; OD "at most 40 ASCII characters" (OD calls it "OpenKit policy"). Question Q-111.
- Route strings in OD normative text (`GET /api/meta`, `GET /health`, `GET /api/diagnostics`) name support bindings; they are kept, because they define the projection exclusion.

## Semantic Preservation

The inventory tool compared each changed file with the group base. Normative sentences are sentences with MUST, MUST NOT, SHOULD, MAY, or a required or forbidden behavior.

| File | Normative sentences | Numbers | Backticked identifiers | Headings | Links |
| --- | --- | --- | --- | --- | --- |
| `20261002-operation_definition.md` (OD) | 61 unchanged, 1 changed (stream set) | 0 | 147 unchanged, 9 added | 23 unchanged | 91 unchanged, 1 added |
| `20260703-worker_agent_capability.md` (WAC) | 66 unchanged, 1 changed (Generative tool sources) | 1 unchanged | 185 unchanged, 4 removed (the four status values, now the Core vocabulary link), 2 added | 33 unchanged | 27 unchanged, 3 added |
| `20260704-capability_usage_gateway_foundation.md` (CUG) | 48 unchanged | 0 | 176 unchanged, 2 added | 34 unchanged | 10 unchanged |
| `20260704-worker_mcp_tool_supply.md` (MCP) | 73 unchanged | 4 unchanged | 230 unchanged, 1 moved (the claim order changed; `denied-not-executed` stays for a refusal before claim), 4 added | 34 unchanged | 23 unchanged, 1 added |
| `20260526-llm_gateway_responses_api.md` (GW) | 105 unchanged | 0 | 255 unchanged, 2 added | 40 unchanged | 29 unchanged |
| `20260703-pi_ai_provider_gateway_adoption.md` (PIA) | 22 unchanged | 0 | 54 unchanged, 5 removed (old pin, integrity, `gitHead` and its value), 4 added | 20 unchanged | 2 unchanged, 1 added |
| `20260721-provider_subscription_accounts.md` (PSA) | 187 unchanged | 6 unchanged | 504 unchanged | 38 unchanged | 10 unchanged |
| `20261018-nanocore_interception_and_information_consolidation.md` (ICP) | 49 unchanged | 0 | 56 unchanged, 1 added | 17 unchanged | 25 unchanged |

Every changed sentence is in an implementation projection, a summary of current state, a status sentence, or a sentence that a later accepted record decides. The MCP Policy binding bullet now follows the claim order and dispositions of Pending Requests; no other design rule changed.

## Issues Opened

- #481 `[mcp] A Workspace-origin captured call skips the catalog digest and credential recheck before dispatch`, blocking candidate (credentials).
- #482 `[providers] Account status never returns unavailable, so a locked Vault makes the status read fail with 503`, ordinary.
- #483 `[mcp] An oversized tools/list fails with mcp-server-unavailable instead of mcp-result-too-large`, low.
- #484 `[gateway] Prompt cache scope lets caller metadata override the trusted caller scope`, low.

## Questions For The Engineer

### Q-85. Who owns capability rate limits and budgets?

- Context: Core Mediation lines 48 and 179 give the gateway rate-limit hooks and control; lines 114 and 276 exclude "owning rate limits"; ICP rows I39 and I40 plan a rate-limit and token-budget gate; no enforcement exists.
- Options: (A) Mediation owns the enforcement point and the hook; a named owner (Policy or a budget owner) owns the limit values. (B) Mediation owns both.
- Recommendation: A. It matches the existing split between enforcement point and authority.
- Meanwhile: no change.

### Q-86. Which document owns the definition of an Operation?

- Context: Core Mediation line 10 owns the semantic definition, invocation procedure, and mediation points; OD owns the declarative definition and projections; OD line 79 gives stage and binding contracts to Policy Enforcement.
- Options: (A) Core Mediation owns the concept and the point identity; OD owns the declaration and projections; Policy Enforcement owns bindings at a point; each document states this split. (B) Move the point identity to OD.
- Recommendation: A. It keeps the Core concept implementation-neutral.
- Meanwhile: no change.

### Q-87. Can boot self-check ever take participant bindings?

- Context: Core Mediation line 68 says boot admission accepts no participant bindings; ICP row I36 is marked `U`, "later routing after the first pilot".
- Options: (A) Mark I36 as Kernel-only with no later routing. (B) Amend Core.
- Recommendation: A. Core bounds mediation depth on purpose.
- Meanwhile: no change.

### Q-88. Does a revoked actor's claimed call leave a Workspace call record?

- Context: CUG line 122 says a null, stale, or denied actor records no Workspace effect; Pending Requests line 365 requires a failed execution call with `execution-error`; the code follows Pending Requests.
- Options: (A) Add to CUG that a refusal after a claim records the failed execution call. (B) Change Pending Requests and the code.
- Recommendation: A. A refusal after a claim needs a durable truthful record.
- Meanwhile: no change.

### Q-89. Is `schemaSnapshotId` a replay attribution field?

- Context: CUG lists 13 immutable fields for replay; the recorder also compares `schemaSnapshotId`, and an MCP list-tools replay with a reused JSON-RPC id would throw a generic conflict.
- Options: (A) Add it to CUG and make the list-tools replay pass the stored value. (B) Remove the comparison.
- Recommendation: A. The snapshot is part of the effect attribution.
- Meanwhile: no change.

### Q-90. Should the shared recorder refuse a Workspace call with a null actor?

- Context: CUG requires a non-null actor for worker execution; the producers check it, but the recorder accepts null and then skips the admission audit and usage attribution.
- Options: (A) Fail closed in the recorder for Workspace-attributed `mcp` and `llm` calls. (B) Keep the producer-only check and state it.
- Recommendation: A. The audit-before-effect record must not be skipped silently.
- Meanwhile: no change.

### Q-91. Does a repeated pending call get its own CapabilityCall?

- Context: MCP line 202 returns the same request for a repeated call; line 214 requires one `CapabilityCall` per request; the code records nothing for the repeat.
- Options: (A) Record one denied, no-contact call per repeat. (B) State the exemption in line 214.
- Recommendation: A. It keeps the audit complete.
- Meanwhile: no change.

### Q-92. What is the worker-visible capability error vocabulary?

- Context: MCP Error normalization lists a closed set; the code also emits `mcp-policy-stale`, `mcp-policy-unavailable`, `policy_evidence_unavailable`, and `recovery_required`, and two of them name Policy as the cause, which MCP line 205 forbids. WAC lists a `capability_*` set that no code uses.
- Options: (A) Document a small stale, unavailable, and recovery set in MCP, fold Policy-origin codes into `mcp-denied`, and mark the WAC set as the target for deferred families. (B) Adopt the WAC set for every family.
- Recommendation: A.
- Meanwhile: no change.

### Q-93. Must revocation stop a `stdio` MCP server at once?

- Context: MCP line 181 says revocation triggers teardown; the code tears down only on the next call or after the 60-second idle bound.
- Options: (A) Add a revocation hook that closes the affected sessions. (B) State next-use teardown.
- Recommendation: A. A child process must not outlive its credential authority. This relates to Q-81 and issue #476.
- Meanwhile: no change.

### Q-94. Does a credentialed discovery exchange count as upstream contact for usage?

- Context: MCP requires one `UsageRecord` unless upstream is proved not contacted; a call denied after a successful credentialed `tools/list` has no usage row.
- Options: (A) State that only `tools/call` contact counts. (B) Record usage for discovery contact.
- Recommendation: A. The usage unit is `tool_calls`.
- Meanwhile: no change.

### Q-95. What are the remote MCP refusal codes and call annotations?

- Context: OD says the call refuses excluded operations with a typed unsupported-operation result and that call annotations are truthful for the operation. The code uses `mcp_secret_returning_operation` and `mcp_streaming_operation`, and the multiplexed `openkit_call` has fixed worst-case annotations, with the exact posture in `openkit_describe`.
- Options: (A) Name the two codes and state the worst-case annotation rule in OD. (B) Change the code.
- Recommendation: A. A static multiplexed tool cannot carry per-operation hints.
- Meanwhile: no change.

### Q-96. Which credential procedures and table facts may a descriptor carry?

- Context: OD lists five credential procedures, including Gateway actor; the code has seven values (`local-user`, `worker-package`, `coordinator` added) and no Gateway actor. The table also carries `inputSensitivity` and `binaryRequestBody`, which the "only those facts" list omits.
- Options: (A) Update the OD lists to the current vocabulary. (B) Remove the extra values.
- Recommendation: A. They are public contract framing.
- Meanwhile: no change.

### Q-97. May common admission contain Goal checks?

- Context: OD says common algorithms contain no family dispatch; `operation-resolvers.ts` branches on the coordinator entry and calls Goal checks.
- Options: (A) Move the Goal checks behind a Goal-owned resolver strategy. (B) State the coordinator entry as trusted entry assembly.
- Recommendation: A.
- Meanwhile: no change.

### Q-98. Who states header-carried request identity for JSON mutations?

- Context: the JSON route reads `x-openkit-request-id`, rejects a different body `requestId`, and injects the header value; OD states this only for Artifact and App-update.
- Options: (A) State the general rule once in OD. (B) State it in the Core Client boundary.
- Recommendation: A. OD owns the JSON binding.
- Meanwhile: no change.

### Q-99. Are any operations still not migrated, and what keeps OD `Partial`?

- Context: OD says operations not yet migrated keep hand-written routes; the inspection found none outside support and streaming routes.
- Options: (A) Remove the sentence and list the open OD work (lifecycle field, data-defined sources, administrator-eligibility rows). (B) Name the remaining operations.
- Recommendation: A, after a full route check.
- Meanwhile: no change.

### Q-100. Is the Work supply intended to include automation and Knowledge Manager Tools for every package?

- Context: WAC accepts seven Work Tools plus two Knowledge Manager Tools; the supply also gives `automation.event-admit` to every package, which WAC describes as a scheduled-poll Tool.
- Options: (A) Supply `automation.event-admit` only to the scheduled-poll Worker. (B) State the unconditional supply.
- Recommendation: A, if call-time authority does not already limit it.
- Meanwhile: no change.

### Q-101. Does `work_artifact_submit` refuse a media type?

- Context: WAC lists "unadmitted media type" as a Tool error; the code admits any syntactic media type, and the Tool description says so.
- Options: (A) Remove the media-type refusal from WAC. (B) Add an admission list in the Work Resource owner.
- Recommendation: A.
- Meanwhile: no change.

### Q-102. Should the inactive advise and transform dispatch code stay?

- Context: ICP forbids activation until a safe output owner exists; admission refuses them, but the dispatch branches stay.
- Options: (A) Remove the branches until an owner exists. (B) Keep them for the pipeline order.
- Recommendation: A, under QUALITY-016.
- Meanwhile: no change.

### Q-103. Is the Pi runtime host's pi-ai dependency inside PIA?

- Context: PIA calls pi-ai the single internal LLM provider-adapter dependency, private to NanoCore; `packages/pi-runtime-host` pins pi-ai `1.0.2`.
- Options: (A) State that worker-runtime packages are outside PIA. (B) Bring them under the PIA pin.
- Recommendation: A. They are runtime-side, not a Gateway path.
- Meanwhile: no change.

### Q-104. Must explicit prompt cache keys be hashed?

- Context: GW and PIU say the resolver hashes every resolved scope; the code passes explicit and metadata keys unhashed, and the tests assert it.
- Options: (A) Hash them with the provider and slot. (B) State that a client key is opaque and passes through.
- Recommendation: A. One key must not cross accounts.
- Meanwhile: no change.

### Q-105. Are unknown provider model metadata fields rejected or ignored?

- Context: GW line 113 says unknown fields are rejected; the schema strips them with a diagnostic; COMPAT-001 says readers ignore unknown additive content.
- Options: (A) Change GW to ignore unknown additive leaves with a diagnostic. (B) Reject them.
- Recommendation: A. It follows the root rule.
- Meanwhile: no change.

### Q-106. Is startup reconciliation required for provider subscription accounts?

- Context: PSA lines 194, 503, and 510 name startup reconciliation; no production caller runs it, and reads derive status from live inspection.
- Options: (A) Reword PSA to read-time reconciliation. (B) Add a boot pass.
- Recommendation: A. Projections are never exposed stale.
- Meanwhile: no change.

### Q-107. Should the quota `label` and `activeUntil` fields stay?

- Context: the wire schema has a server `label` ("7 days") that Web ignores and that differs from PSA's Web-derived labels, and an `activeUntil` field that is never produced.
- Options: (A) Remove both. (B) Specify both in PSA.
- Recommendation: A.
- Meanwhile: no change.

### Q-108. How does an operator recover from account-directory residue?

- Context: PSA fails residue closed and names reviewed cleanup as the recovery; no cleanup path exists, and a failed create leaves its own empty directory.
- Options: (A) Let a failed create remove only the directory it created, ignore its own temporary-file pattern, and state whether reviewed cleanup must exist before `implemented`. (B) Keep the literal rule.
- Recommendation: A.
- Meanwhile: no change.

### Q-109. Should each Codex attempt run the audited reconcile?

- Context: inference admission calls `getStatus`, which reconciles and writes a `provider_subscription.reconcile` audit row per attempt.
- Options: (A) Read the account setting without the audit-bearing reconcile on the dispatch path. (B) State the per-attempt audit.
- Recommendation: A.
- Meanwhile: no change.

### Q-110. Which code does create return for an invalid slot id?

- Context: every pair-addressed operation returns `provider_subscription_account_slot_invalid`, but create returns `invalid_request` from the strict schema.
- Options: (A) Move the create slot check to the owner. (B) State the exception.
- Recommendation: A, for one stable code.
- Meanwhile: no change.

### Q-111. How should the mediation labels, numbers, and the long OD paragraph be fixed?

- Context: the labels and numbers in G5, and OD line 306.
- Options: (A) As Q-28: replace each label with its meaning or a link, mark experience-chosen numbers as current defaults, and split OD line 306 by topic after Q-99. (B) Keep them.
- Recommendation: A.
- Meanwhile: no change.

### Q-112. Which channel serves Knowledge package transfer?

- Context: OD now excludes the two Knowledge package streams from remote MCP. Its Guide and transfer acceptance name Web and the administrator CLI only for the archive and Artifact operations. `20261018-file_storage_and_knowledge_packages.md` names the streaming App API bindings but no Web surface, and only the packaged operator CLI uses them.
- Options: (A) State in the Knowledge package owner that the administrator CLI is the transfer channel and that Guide names it. (B) Require a Web surface.
- Recommendation: A, until a Web consumer need exists.
- Meanwhile: no change.

Existing Q-29 still covers `context-injection` versus `knowledge-injection`, which ICP does not use.

## Independent Review

A fresh Reviewer context received the diff, this record, and the inventory, and checked the cited code, `20260930-pending_requests.md`, and issues #481 to #484 itself. Verdict: changes requested, then approved once findings 1, 2, and 4 were applied. Dispositions:

1. The OD stream edit put the Knowledge package operations under the Web and administrator CLI Guide sentence and the transfer acceptance, which would add a criterion that no record decides. Accepted; those two sentences now apply to the archive and Artifact operations only, the MD-OD-02 row explains it, and Question Q-112 is added.
2. MD-MCP-03 cited `normalizeMcpCallError` instead of `normalizeMcpListError`. Accepted; the row cites `worker-mcp-gateway.ts:1163-1174`, and a correction comment is on issue #483.
3. The MCP Policy binding edit dropped the words "inside the approval response command". Accepted; the bullet now says "the Main submission check of the approval response command".
4. The base note did not name the policy group's later Pending Requests correction. Accepted; the Scope And Base section names it.

The Reviewer confirmed the MCP claim order against Pending Requests, the OD counts and stream set, the WAC Generative tool sources and cut-over, the PIA pin and integrity, the PSA rollout framing, the GW, CUG, and ICP edits, all four issues, the inventory table, and spot-checked Q-88, Q-95, Q-100, and Q-103. It found no content-safety or style problem.

## Checks

Run on the working tree before the commit:

- `node scripts/validate-doc-model.mjs`: "Validated documentation model (670 documents)."
- `node scripts/generate-doc-index.mjs`: "Wrote docs/INDEX.md."
- `pnpm check:repo`: exit status 0.
- Content scan of the staged diff (emails, tokens, local absolute paths, Vietnamese diacritics): no match.
