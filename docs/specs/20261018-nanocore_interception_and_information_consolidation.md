---
status: Accepted
implementation: Not Started
kind: mechanism
date: "2026-10-18"
---
# NanoCore Interception And Information Consolidation

## Owns

Needed for the approved unified mediation and information-consolidation decisions.

This specification owns the NanoCore mediation integration with the unified Policy base, provider participation, invocation evidence, information consolidation and transition of existing mechanisms. It defines the later Decision Trace projection without creating another record authority.

## Does Not Own

Needed to preserve the existing effect, content and authorization owners during consolidation.

This design does not replace Policy evaluation, human-required decisions, Pending Request execution, notebook publication, Skill selection, app record storage or external systems of record. It adds no arbitrary executable plugin loader, workflow runner, retry ledger or trace graph store. Binary Knowledge content is designed separately.

## Core References

Needed to identify the owners that constrain every binding and migration.

[Architecture](../core/architecture.md), [Permissions](../core/permissions.md), [Knowledge](../core/knowledge.md), [Audit](../core/audit.md), [Generative Apps](../core/generative-apps.md), [Agent Capability](../core/agent-capability.md), [Agent Supply](../core/agent-supply.md), [Communication](../core/communication.md) and [Contract Evolution](../core/contract-evolution.md).

## Summary And Decision

Needed to apply the engineer's 2026-10-18 decision without claiming implementation.

The [BWM decision](../decisions/20261018-bwm_support_and_information_consolidation.md) records information consolidation. The [unified mediation decision](../decisions/20261018-unified_mediation_and_policy.md) records the shared Policy base. All interception mechanisms live inside NanoCore at its actual mediation boundaries. Participants are providers of bounded typed jobs, not assumed to be AI. Solidified reusable procedure belongs in Skills; other reusable understanding belongs in the owner-scoped OKF notebook managed and queried by the Knowledge Manager. Operational, source-evidence and authority records retain their existing owners and are not additional curated truth stores.

## Information And Record Authority

Needed for migration C01-C04 and the typed Knowledge decision.

Claim MUST be an OKF Claim page under ordinary notebook governance; the separate canonical claims ledger ends. Preserve source references, scope, numeric confidence in [0,1], freshness, review state and conflict status. The Knowledge Manager manages and queries Claims. Confidence is an assessment input, never publication authority or proof of truth; no ordinal conversion is specified.

Rule, Effect and business Objective are Scope Schema domain page types. They retain the common OKF governance fields and declare `applies_to` to identify applicable tools or work steps. KM retrieval MUST support type and applicability selection while retaining current source, scope and audience checks. Effect pages state their basis and last check. A business Objective page is not the work-model Goal or its execution state. A retrieved Rule does not grant permission. Safety-critical rules must be supplied through a pinned Skill or a Policy-bound independent validator, rather than relying on optional retrieval alone.

The Generative Kernel retains Light App record data: entity state the work tracks, cross-system IDs and identity match basis as ordinary fields, and work progress. Structural schema, labels, constraints and record provenance remain with it. Only reusable domain meaning and solidified procedures leave the Kernel for OKF and Skills respectively. Domain concepts, roles and relationships use Entity/Topic pages or the domain Skill; neither general knowledge nor external systems' authoritative data is remodeled as a mandatory Light App.

App and catalog definitions retain exact structural versions and references to applicable Knowledge/Skill versions. Moving reusable meaning MUST NOT silently rewrite immutable definitions or relocate record state. Versioned discovery must resolve the referenced meaning or report it unavailable. Saved presentations and task context remain bounded projections, not separate reusable truth sources. A solidified procedure formerly stored in a Knowledge page or instruction body moves to Skill ownership; descriptive context and references may remain in Knowledge. Governed ScopeSchema and page publication refuse the competing `Procedure` type even when an authored schema tries to allow it; generic external OKF parsing remains permissive. This deterministic receiver check does not classify prose or change the existing Skill lifecycle.

Raw Sources and mechanical derivatives remain evidence. Pending proposals remain candidates until ordinary publication. Observation and conflict analysis that supplies reusable understanding belongs in OKF; operational event identity and actual decisions stay in existing work, review, Policy and Audit owners. Consolidation MUST preserve unresolved-conflict publication refusals and retrieval exclusions. Publication, archive, forgetting, restoration, stale-base conflict and restart reuse the existing Knowledge/Skill lifecycles; no parallel lifecycle is introduced.

## Unified Mediation And Policy

Needed to integrate the existing mechanisms without another point, permission or record authority.

[Permissions](../core/permissions.md) owns the shared point, mode, authority and scope concepts. [Policy Enforcement](20260703-policy_enforcement_mapping.md) owns statements, revisions, PermissionDecision, approval and policy.write. [Operation Definition](20261002-operation_definition.md) owns the existing registry and its non-API extension. This specification applies those contracts to the mechanisms below; it defines no separate point registry or binding store.

A point is an operation at a stage, written `<operation>@<stage>`. Stages are propose, decide, commit and completed. Admission, disclosure, dispatch, ingress, mutation, administration and decision are operation crossing attributes. Effect class, sensitivity, static risk, dynamic advice and authorization remain separate inputs. Nested actions reach their actual operation points; approval of a wrapper does not approve its nested calls.

Only crossings Core can hold before release are enforceable. Worker-internal shell, files and network remain outside this mechanism's coverage. Sandbox containment still applies; a harness hook alone cannot supply Core enforcement. Returning content enters its own ingress and disclosure checks. A result gate cannot undo an effect that already ran.

Before v0.1.0 the modes are observe, advise, gate and transform. Execution follows the Policy owner's transform -> advise -> gate -> final mandatory Kernel pipeline. Advice contributes proposal attributes, not authority. Commit obligations run only after final allow. Credential injection is a Core-only obligation bound to the approved target, account and action, not a pre-authorization participant transform. Mandatory schema, authentication, confidentiality, containment and transaction constraints remain.

The later react mode changes Policy after successful access under the binding author's authority, as an NGAC obligation. It is deferred to [issue #375](https://github.com/lingkaix/openkit/issues/375). Deterministic commit obligations do not activate react. No active react mode or implementation is claimed.

## Participants And Binding Integration

Needed for bounded providers without recursive authority or uncontrolled disclosure.

Bindings are statements in the existing Policy owner, sharing the permission and envelope/delegation revision and lifecycle. [Policy Enforcement](20260703-policy_enforcement_mapping.md) owns their point selector, mode, participant, contracts, ordering, failure behavior, state, author and delegation. Scope and lifetime are separate attributes. Lifetime uses an anchor container reference with optional notAfter and uses bounds; it is not a closed duration enum. A statement never outlives its author's authority. Package installation grants no authority.

Providers may be internal or external agents, decision models, deterministic engines or third parties. A human remains an authenticated approval resolution path. Each provider receives its admitted input scope and returns a typed result bound to its input, participant and binding versions. Required factual inspection uses the system of record, not an unsupported Worker claim. Unknown result semantics are unavailable assessments; free text supplies no grant. External participants use admitted calls or Pending Requests and never write Core storage directly.

Participant disclosure is authorized at binding write through policy.write. Invocation and investigative calls receive only the current Kernel check and accept no participant bindings. Mediation depth is one. Validators receive neither secrets nor unrelated private material. Authorization sources stay distinct from untrusted evidence; omitted material stays explicit.

The subject can be a human or agent principal with its actual process and optional on-behalf-of identity. An agent principal records its responsible human and holds only grants tracing to a human-approved domain. Acting for a user intersects that user's rights with the agent's restrictions. Actual actor, principal, responsible human and process remain distinct in decisions; none is inferred from model claims.

Agent principal creation and domain grants are administration operations with creator and responsible-human attribution. The Policy owner's finite, acyclic accountability chain must reach a specific current authorized human at evaluation. Broken authority suspends grants until human reassignment. The decision retains the agent and resolved human at that time; history is not reassigned retroactively.

Agent approvers use the Policy owner's shadow/activation path and return allow, deny or escalation to a human with their assessment. They cannot widen their own binding or envelope, replace the mandatory Kernel, or satisfy a human-only requirement. This specification activates no agent approver.

## Invocation Evidence And Failure

Needed for attributable decisions, safe transformations and truthful unavailable outcomes.

[Policy Enforcement](20260703-policy_enforcement_mapping.md) owns the shared retained envelope. Gate and Kernel evaluations use PermissionDecision; observe, advise and transform retain invocation evidence through existing Audit. Every invocation retains point/stage, proposal digest, Policy and authorization revisions, binding/participant versions, safe input/output references, subject/actor/delegation, actual outcome and relevant timing. Existing call, Turn, Pending Request, retrieval and content links remain authoritative. No separate ledger, transcript or graph store is introduced.

Transform evidence resolves original and admitted replacement versions through existing Item, package, notebook, Artifact or other content owners. Audit stores safe references and outcomes, never unrestricted bodies or credentials. Commit credential injection keeps existing grant/plan/use references. Missing required safe evidence prevents release; it cannot justify retaining secrets or claiming a completed transform. Material input, binding, authorization or Policy revision changes invalidate earlier assessments. Restart does not make history current authority.

Failure follows the binding's declaration: escalate to a human by default, continue only for a non-decisive step, or error. Timeout, invalid result, unavailable dependency and open circuit are not substantive Policy denials or allows. A valid gate denial stays distinct. The existing Pending Request resolves escalation, then Core re-evaluates. Required evidence failure blocks release. An uncertain external effect stays with its outcome owner and is never automatically replayed.

Each participant binding configures a bounded timeout and availability circuit. The orchestrator bounds retries inside one deadline. Repeated participant failures open the circuit; ordinary invocations do not contact the participant while it is open. A bounded recovery probe after the configured wait may close it on success without widening authority. An open circuit records its disposition and applies the declared failure behavior. This is binding-local availability control, not a durable recovery service. Restart loads current bindings and preserves history without resuming old effects. The separate Turn denial circuit counts only substantive denials and remains later work unless separately needed.

## Decision Trace And Provenance

Needed for pre-freeze edges and the later read-only trace view.

Decision Trace is a derived, rebuildable read-only view with one operation from an anchor in the upstream or downstream direction. Nodes are existing records; edges are retained identifier references. Core rechecks permission for each node and must not disclose inaccessible node metadata. Missing, unavailable or absent edges remain explicit within the authorized view; text similarity, timestamps, version arithmetic and model explanation MUST NOT fabricate a join. No structured model-rationale field is required.

Before v0.1.0, retain actual missing Policy/rule versions, policy author/delegator, scope and decision inputs, winning Skill pin attribution, real Artifact parent references, producing/executing Turn links and system-observed capture channel/origin on existing owners. Keep author, responsible user, trigger actor and approver distinct. Optional absent historical edges remain unknown. Existing Turn/Thread/Task, Turn/AEP, KM/caller, approval/Pending/call and encoded Artifact candidate joins MUST be reused. Fixed Policy snapshot labels are not reinterpreted as immutable historical versions. A later view cannot recover facts never retained.

## Adopted Research Conclusion

Needed for injectable decision models and shadow-to-active thresholds.

A narrow-job reviewer or decision model supplies an assessment; Core enforces Policy. Probability or confidence is not assumed calibrated: fit decisive thresholds on relevant own traffic and inspect shadow errors before activation. Keep the model/provider injectable through the same typed contract. This design adopts no vendor, price, benchmark, world-model capability or measurement campaign as a requirement.

## Current Implementation Projection

Needed to distinguish source verification from implementation of the unified design.

The specialized producers below exist, except rows explicitly marked absent. Their presence does not implement the common binding, stage order or complete invocation evidence. Current knowledge claims/observations/conflicts use monthly JSONL; live and catalog Light App definitions include semantic prose. Production AEP instructions are empty. Sources, candidates, presentations and catalog labels have evidence/operational roles, not automatic Knowledge migration. The naming cutover is already the base: canonical `work.input.request` and `work.artifact.submit` project mechanically to MCP names; capability operations use the current hyphenated names.

The I labels identify migration rows, never persisted points. Paths are under `apps/nanocore/src/`. Each row names its operation/stage, crossing attribute and role. Angle-bracket names mark non-API registry extension slots or the containing operation, not another registry or frozen operation IDs. Existing operation identities stay unchanged. A row may span multiple crossings. U means later routing after the first pilot; L means an absent optional capability. Specialized regressions remain with their lanes.

| ID; existing mechanism | Operation@stage | Crossing class | Mode or native role | Existing owner/evidence path | Lane; phase |
| --- | --- | --- | --- | --- | --- |
| I01 Item projection | `<context-delivery>@propose` | disclosure | transform | context/llm-projection.ts; transient result, original Items retained | L-AK; U |
| I02 Assistant audience | `<assistant-history-delivery>@decide` | disclosure | gate | internal-agents/assistant-history.ts; conversation retrieval trace | L-AK + L-GA; U |
| I03 Knowledge eligibility | `<knowledge-read>@decide` | disclosure | gate | storage/index-rebuild.ts; selected/excluded retrieval trace | L-AK; U |
| I04 context preparation | `<context-delivery>@propose` | disclosure | advise | knowledge-manager.ts; deterministic retrieval and usage, not an agent | L-AK; U |
| I05 Worker package | `<worker-context-delivery>@propose` | disclosure | transform | context/worker-context-package.ts; exact package/trace | L-AW + L-AK; U |
| I06 Task composition | `<task-admission>@propose` | admission | transform | internal-agents/worker-coordinator.ts; deterministic request, Task admission | L-GO + L-RT; U |
| I07 AEP redaction | `<aep-delivery>@propose` | disclosure | transform | runtime/aep-snapshot-ledger.ts; safe snapshot | L-RT + L-GA; U |
| I08 Gateway enable/allow | `<model-request>@decide` | dispatch | gate | llm/gateway-routes.ts; best-effort PermissionDecision coverage | L-RT + L-GA; U |
| I09 provider credential injection | `<model-request>@commit` | dispatch | Core obligation | app.ts, Vault owners; safe call/use references | L-GA + L-RT; U |
| I10 usage accounting | `<model-request>@completed` | dispatch | observe | capability/usage-ledger.ts; UsageRecord | L-RT; U |
| I11 precommit/retry availability | `<model-request>@decide` | dispatch | native availability guard | llm/gateway-execution.ts; attempt/call outcomes, not Policy deny | L-RT; U |
| I12 capture confidentiality | `<model-result-ingress>@decide` | ingress | gate | llm/model-capture.ts; WorkObservation with body-unavailable state | L-AW + L-RT; U |
| I13 generic transformer pipeline | `<model-request>@propose` | dispatch | transform | absent as a Policy-bound provider pipeline | L-RT; L |
| I14 MCP discovery filter | `mcp.list-tools@propose` | disclosure | transform | worker-mcp-routes.ts; schemas/calls, built-in list lacks invocation record | L-GA + L-RT; U |
| I15 MCP approval requirement | `mcp.call-tool@decide` | dispatch | gate | worker-mcp-routes.ts; Pending Request, Item and capability | L-GA + L-CH; U |
| I16 MCP tool.use | `mcp.call-tool@decide` | dispatch | gate | worker-mcp-routes.ts; PermissionDecision and call/AEP links | L-CH base + L-GA Policy review; F pilot |
| I17 MCP credential injection | `mcp.call-tool@commit` | dispatch | Core obligation | worker-mcp-routes.ts; Vault plan/receipt/use | L-GA; U |
| I18 captured execution | `mcp.call-tool@decide` | dispatch | gate | runtime/captured-pending-call.ts; Pending execution/call/result | L-GA + L-CH; U |
| I19 built-in Work result size | `<result-ingress>@decide` | ingress | gate | runtime/openkit-work-mcp.ts; bounded result/call error | L-RT; U |
| I20 Artifact submission | `work.artifact.submit@decide` | mutation | gate | runtime/openkit-work-mcp.ts; Artifact and command | L-AW; U |
| I21 Artifact candidate choice | `<artifact-candidate-selection>@decide` | decision | gate | artifact-reviews.ts; exact candidate selection and actor | L-AW; U |
| I22 ordinary admission | `<operation>@decide` | registered crossing attributes | Kernel-only admission | operation-resolvers.ts, auth/operation-authorizer.ts; decision-record gap | L-GA; U |
| I23 notebook validation | `knowledge.notebook.update@decide` | mutation | gate | knowledge/notebook-publication.ts; Git, Audit and receipt | L-AK; U |
| I24 Knowledge decision | `<knowledge-review-response>@decide` | decision | gate | knowledge-operations.ts; exact human review and command | L-AK; U |
| I25 app write validation | `<kernel-record-write>@decide` | mutation | gate | generative-kernel/commands.ts; app records, revisions and Audit | L-GO; U |
| I26 MCP binding write | `catalog.mcp-binding@decide` | administration | gate | catalog/catalog-operations.ts; authored catalog revision | L-GA; U |
| I27 configuration write | `<configuration-write>@decide` | administration | gate | config/runtime-config-operation-implementations.ts; validated file revision | L-GA; U |
| I28 secret-shaped rejection | `<containing-operation>@propose` | registered crossing attributes | mandatory validation | shared schemas; rejection lacks standalone invocation evidence | L-GA; U |
| I29 work.input.request | `work.input.request@propose; <pending-response>@decide` | mutation; decision | gate | runtime/openkit-work-mcp.ts; question Pending Request and Item | L-CH + L-RT; U |
| I30 Goal Plan approval | `<goal-plan-response>@decide` | decision | gate | runtime/goal-owner.ts; Plan/Pending exact bytes and actor | L-GO + L-CH; U |
| I31 Discord disclosure/response | `<channel-send>@decide; <pending-response>@decide` | dispatch; decision | gate | channels/discord.ts; disclosure/inbound receipt and native response | L-CH; U |
| I32 Audit producers | `<originating-operation>@completed` | registered crossing attributes | observe | audit-events.ts; existing scoped AuditEvent | L-GA + originating lane; F/U |
| I33 scheduler admission | `<scheduler-admission>@decide` | admission | gate | scheduler-records.ts; admission/input, typed capacity error | L-RT; U |
| I34 recurring trigger/outcome | `<recurring-trigger>@completed` | admission | observe | lib/automation-store.ts; definition Audit and occurrence | L-GO + L-AK; U |
| I35 Worker launch record | `<worker-launch>@decide; <worker-launch>@completed` | admission | gate decision; observe outcome | runtime/worker-turn-loop.ts; PermissionDecision/checkpoint | L-RT; U |
| I36 boot self-check | `<boot-admission>@decide` | admission | Kernel-only self-check | bootstrap/policy.ts, index.ts; Core decisions and Audit | L-GA + L-RT; U |
| I37 optional AI assessment | `<knowledge-review>@propose` | decision | advise | absent; existing assessment Observation owner is reusable | L-AK; L |
| I38 named read scope/audience | `<source-read>@decide` | disclosure | gate | permissions owner; I02/source guards are existing analogues | L-GA + L-AK; U |
| I39 generic rate-limit hook | `<model-request>@decide` | dispatch | gate | absent; provider quota parsing/retry is not this gate | L-RT + L-GA; L |
| I40 generic token-budget gate | `<model-request>@decide` | dispatch | gate | absent; usage and effort options are not this gate | L-RT + L-GA; L |
| Skill candidate decision | `catalog.skill-candidate-decide@decide` | decision | gate | catalog/catalog-operations.ts; candidate, decision Audit and command | L-AK; U |

## Rollout / Migration Plan

Needed to settle retained meanings before freeze and bring every existing row under one base.

Phase F lands before the v0.1.0 retained-data freeze. MIGRATION means a changed retained owner/meaning; ADDITIVE keeps old facts valid with unknown missing edges. Pre-stable reset requires the existing explicit operator procedure; do not implement conversion readers, dual writes or automatic reset. No deployment action is authorized by this specification.

| Step | Class and receiver | Completion boundary |
| --- | --- | --- |
| C01 Claims | MIGRATION; L-AK, F | One OKF Claim authority, KM read/write, no canonical JSONL path; numeric confidence preserved. |
| C02 observations/conflicts | MIGRATION; L-AK + L-GA, F | Reusable analysis in OKF; event/decision authority stays; conflict refusals and exclusions still work. |
| C03 app/domain separation | MIGRATION; L-GO + L-AK, F | Light App record data, entity state, cross-system IDs and progress stay in Kernel; only reusable meaning/procedure move to OKF/Skills. |
| C04 solidified procedures | MIGRATION where present; L-AK + L-GO + L-RT, F | Skill is the procedure owner; projections reference selected versions; no private grounding copy. |
| C05 typed pages | ADDITIVE; L-AK, F shapes / L consumers | Rule/Effect/Objective and applies_to retain normal notebook governance and type-aware retrieval. |
| C06 trace edges | ADDITIVE; each producer, F | L-GA Policy/Audit, L-AK KM/Skill, L-GO app/Goal, L-AW Artifact/context, L-RT calls/AEP retain actual missing references. |
| C07 capture origin | ADDITIVE; L-CH + L-AK + L-GO, F | Trusted capture channel/actor and trigger provenance; reuse existing Discord event/request and recurring occurrence edges. |
| C08 Decision Trace | ADDITIVE; L-GA with record owners, L | Read-only authorized traversal with explicit missing links; no graph authority. |
| C09 agent Policy | Retained formats in the reset RC; L-GA with L-CH/L-GO/L-AK, F / L adapters | Statement scope/lifetime and principal/process shapes, Goal domain/delegation and shadow state freeze before v0.1.0; policy.write review is in scope. Agent activation and adapters need their own qualification. |
| C10 shared Policy base | Retained formats and I16 pilot in the reset RC; L-CH + L-GA, F | Freeze operation@stage, statement/revision and PermissionDecision envelope with their writer and validator; the I16 pilot proves the formats. Complete policy.write review and the shared pipeline before v0.1.0; behavior that writes no new shape may follow the reset RC. Other rows route later without another gate or store. |
| C11 transform references | ADDITIVE; producing owner, U | Safe before/after versions resolve through existing owners, with no raw-secret retention. |
| C12 optional providers | ADDITIVE contracts, implementation-only adapters; table lanes, L | Inject a provider behind the contract; absent rows gain capability only when separately implemented and authorized. |

The store dispositions are: TS1 Claim -> OKF Claim; TS2 reusable observations -> OKF Observation; TS3 reusable conflicts -> OKF Observation with conflict state; TS4 Sources stay evidence; TS5 proposals stay candidates; TS6 live app and TS7 template reusable meaning -> Entity/Topic/Rule or Skill while records/structure stay; TS8 presentations stay projections; TS9 has no production instruction-body store and future procedures use Skills; TS10 plugin descriptions stay discovery metadata. These are classifications, not a claim that live private content was inspected or moved.

The merged base, registry extension, Policy statement/revision, scope/lifetime and Goal domain formats, enriched PermissionDecision and policy.write are Not Started. Existing specialized mechanisms and the landed channel-origin addition do not establish that implementation. Changed retained meaning/layout joins the coordinator-owned reset RC only after the pre-reset cut announcement; additive changes require no conversion. The reset RC requires final retained shapes, writers and validators; behavior that writes no new shape may follow additively before v0.1.0. Other row routing, impact simulation, adaptive/cached review, external adapters and react remain later work.

MCP list filtering and call enforcement share constraints but keep separate disclosure/effect checks. Retrieval eligibility and package budgeting retain distinct owners. Reuse PermissionDecision/Audit across boot, Gateway, MCP and ordinary governed effects; reuse Pending Request across approvals, questions, Plans and channel responses. Confidentiality checks at separate storage/dispatch stages remain mandatory. Result ingress lacks a general vendor-result adviser/transformer; output disclosure lacks a generic Turn-output interceptor. Add those later only at actual owned boundaries. The transient Workspace resolver stays Kernel-only with no per-request ledger. Report actual producer coverage before claiming complete invocation evidence for routed rows.

## Testing Strategy / Acceptance Criteria

Needed to make each approved decision and migration completion observable.

- A Claim or reusable conflict has one OKF/KM authority, retains its numeric confidence and sources, and cannot become active or bypass an unresolved conflict through migration. Operational records and required human decisions remain usable.
- An app record's entity state, external IDs and progress remain queryable/mutable in the Kernel after domain meaning moves; discovery resolves exact Knowledge/Skill references or reports unavailable. Presentations and Sources do not become competing truth stores.
- Type/applicability retrieval finds eligible Rule, Effect and Objective pages, excludes unauthorized or stale material, and grants no operation authority.
- Fakes cover shared operation@stage identity and each mode: observe/advise cannot veto or mutate; ungranted gate/transform cannot act; granted transformations retain safe original/replacement references; final Policy rejects an unauthorized transformed effect.
- Binding revocation, changed input/version or stale result prevents release; shadow decisions do not replace the current decider, and activation records the actual agent and delegated class without satisfying a human-only gate.
- Timeout, bad output, unavailable dependency and open circuit follow declared failure behavior, defaulting to human escalation. Non-decisive continuation and error stay explicit. Required evidence failure blocks release. No failure fabricates deny/allow or replays an uncertain effect; a bounded probe cannot widen authority.
- Every invoked participant and open-circuit disposition is inspectable through existing durable evidence, including observe/advise and built-in list/projection paths; no secrets or unrestricted bodies enter Audit.
- Trace traversal uses retained IDs, rechecks every node's current access and exposes no inaccessible metadata; missing edges remain missing, and restart rebuilds the view without inventing lineage.
- I16 proves the mandatory final Kernel and post-allow credential obligation boundary. policy.write proves scope, lifetime, review and activation revision, with failed-save and active-state distinctions. Participant invocation is Kernel-only without recursive mediation.
- Goal Plan approval creates its delegated domain; Task authority intersects that domain with Task resources. Agent principals and on-behalf-of subjects retain their distinct accountable identities. Anchor closure, notAfter or consumed uses end authority, bounded by the author; once consumes one use atomically with allow.
- Each table row retains its specialized regression while integrating with common bindings/evidence. No mandatory check is deleted merely because a provider now participates; absent optional rows are not reported as implemented.

## Related Documents

Needed to preserve specialized effect owners rather than duplicate their lifecycles.

[Pending Requests](20260930-pending_requests.md), [Knowledge Governance](20260702-knowledge_store_governance_rules.md), [Notebook Editing](20260909-knowledge_notebook_editing.md), [Policy Enforcement](20260703-policy_enforcement_mapping.md), [MCP Supply](20260704-worker_mcp_tool_supply.md) and [Kernel Data Operations](20260908-generative_kernel_data_operations.md) retain their unaffected contracts. On the specific consolidation and later provider-binding surfaces, this specification replaces the separate Claim-ledger design and earlier restrictions that excluded the now-approved participant mechanism; it does not activate those providers or bypass the required implementation phases.
