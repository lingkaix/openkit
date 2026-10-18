---
status: Accepted
implementation: In Progress
kind: mechanism
date: "2026-10-18"
---
# NanoCore Interception And Information Consolidation

## Owns

Needed for the approved unified mediation and information-consolidation decisions.

This specification owns the common NanoCore interception contract, its Policy bindings, provider participation, invocation evidence, information consolidation and transition of existing mechanisms. It defines the later Decision Trace projection without creating another record authority.

## Does Not Own

Needed to preserve the existing effect, content and authorization owners during consolidation.

This design does not replace Policy evaluation, human-required decisions, Pending Request execution, notebook publication, Skill selection, app record storage or external systems of record. It adds no arbitrary executable plugin loader, workflow runner, retry ledger or trace graph store. Binary Knowledge content is designed separately.

## Core References

Needed to identify the owners that constrain every binding and migration.

[Architecture](../core/architecture.md), [Permissions](../core/permissions.md), [Knowledge](../core/knowledge.md), [Audit](../core/audit.md), [Generative Apps](../core/generative-apps.md), [Agent Capability](../core/agent-capability.md), [Agent Supply](../core/agent-supply.md), [Communication](../core/communication.md) and [Contract Evolution](../core/contract-evolution.md).

## Summary And Decision

Needed to apply the engineer's 2026-10-18 decision without claiming implementation.

The [decision record](../decisions/20261018-bwm_support_and_information_consolidation.md) records the approved direction. All interception mechanisms live inside NanoCore at its actual mediation boundaries. Participants are providers of bounded typed jobs, not assumed to be AI. Solidified reusable procedure belongs in Skills; other reusable understanding belongs in the owner-scoped OKF notebook managed and queried by the Knowledge Manager. Operational, source-evidence and authority records retain their existing owners and are not additional curated truth stores.

## Information And Record Authority

Needed for migration C01-C04 and the typed Knowledge decision.

Claim MUST be an OKF Claim page under ordinary notebook governance; the separate canonical claims ledger ends. Preserve source references, scope, numeric confidence in [0,1], freshness, review state and conflict status. The Knowledge Manager manages and queries Claims. Confidence is an assessment input, never publication authority or proof of truth; no ordinal conversion is specified.

Rule, Effect and business Objective are Scope Schema domain page types. They retain the common OKF governance fields and declare `applies_to` to identify applicable tools or work steps. KM retrieval MUST support type and applicability selection while retaining current source, scope and audience checks. Effect pages state their basis and last check. A business Objective page is not the work-model Goal or its execution state. A retrieved Rule does not grant permission. Safety-critical rules must be supplied through a pinned Skill or a Policy-bound independent validator, rather than relying on optional retrieval alone.

The Generative Kernel retains Light App record data: entity state the work tracks, cross-system IDs and identity match basis as ordinary fields, and work progress. Structural schema, labels, constraints and record provenance remain with it. Only reusable domain meaning and solidified procedures leave the Kernel for OKF and Skills respectively. Domain concepts, roles and relationships use Entity/Topic pages or the domain Skill; neither general knowledge nor external systems' authoritative data is remodeled as a mandatory Light App.

App and catalog definitions retain exact structural versions and references to applicable Knowledge/Skill versions. Moving reusable meaning MUST NOT silently rewrite immutable definitions or relocate record state. Versioned discovery must resolve the referenced meaning or report it unavailable. Saved presentations and task context remain bounded projections, not separate reusable truth sources. A solidified procedure formerly stored in a Knowledge page or instruction body moves to Skill ownership; descriptive context and references may remain in Knowledge.

Raw Sources and mechanical derivatives remain evidence. Pending proposals remain candidates until ordinary publication. Observation and conflict analysis that supplies reusable understanding belongs in OKF; operational event identity and actual decisions stay in existing work, review, Policy and Audit owners. Consolidation MUST preserve unresolved-conflict publication refusals and retrieval exclusions. Publication, archive, forgetting, restoration, stale-base conflict and restart reuse the existing Knowledge/Skill lifecycles; no parallel lifecycle is introduced.

## Mediation Points And Providers

Needed for unification U and later injectable participants.

A point is a named NanoCore boundary before disclosure, dispatch, result return, publication, mutation or work admission. It is not a hook inside an external agent's private loop. The migration table names existing boundaries; adding a binding does not create a new operation or permit effects outside that point's owner.

| Mode | Contract |
| --- | --- |
| observe | Copy an admitted observation; no veto, payload change or authorization. |
| advise | Return an assessment, uncertainty or recommendation; no authority by itself. |
| gate | Decide allow, refuse or request the owning approval within an explicit Policy grant. |
| transform | Produce a replacement representation within an explicit Policy grant; retain both versions through their safe existing owners. |

Providers may be an internal agent, an external agent acting through Server MCP, a decision model, a rules engine, a third-party system or a human. Each receives only the current authorized inputs for its job and returns a typed result bound to that input/version and provider identity. It MUST inspect required facts in their system of record rather than accept an unsupported worker claim. No participant receives credentials or unrelated private material merely because it is a validator.

An external participant uses an admitted call or Pending Request path with authenticated identity and current scope; it never writes Core storage directly. A provider's implementation may change behind the same contract, but its identity and version on past evidence do not change. Unsupported results are unavailable assessments, not permission to interpret free text as a grant. Existing mandatory schema, authentication, confidentiality, containment and transaction checks remain mandatory.

## Policy Bindings And Execution

Needed for agent-native Policy and the approved mode ordering.

A binding is an explicit Policy statement authored by a human or currently delegated supervising agent. It names point, mode, participant, subject/action/resource scope, input/output contract, ordering and failure behavior, with an attributable version and author/delegation references. Binding creation, narrowing, activation, replacement and revocation use the existing Policy owner and Audit. A binding or package installation does not itself grant new external effects.

The Assistant may prepare per-worker policy from a user's intent; a Goal Coordinator may manage its Tasks' per-agent and per-action policy. Both remain within the human-approved envelope and their current delegation. Widening authority, changing that envelope or introducing an unauthorized external effect requires the owning human decision. Risk tier, confidence and source-grounded assessments are decision inputs, never independent grants.

Core pins the binding/input versions for one invocation, checks current authority and orders transform -> advise -> gate -> final Policy Kernel evaluation before the effect. Multiple participants within a stage use explicit binding order. Later stages see the admitted transformed version. Every transformed version remains subject to disclosure, validation and current Policy. A gate cannot override a stronger mandatory denial or a human-required decision. A changed target, input or binding invalidates an old assessment; revocation or restart never makes an earlier assessment current authorization.

An agent approver first runs in shadow: retain its assessment while the existing authorized decision path remains decisive. Activation is a separate explicit Policy write for a bounded class after the responsible owner inspects relevant shadow evidence. Retain the actual deciding agent, responsible user and delegation source; never impersonate a human or label an agent decision as a human Review. Activation does not waive a contract that explicitly reserves the decision to a human. This specification activates no agent approver today.

## Invocation Evidence And Failure

Needed for durable invocation evidence, truthful timeout and safe transforms.

Each admitted participant invocation MUST leave a durable record in the existing Audit/Policy owner, linked to its existing call, Turn, Pending Request, retrieval trace or content version as applicable. Retain point/mode, binding and provider version, input/output references, actor/delegation, outcome and timing needed to identify timeout. Observe and advise also require records; an in-memory digest alone is insufficient. This does not require a new record type or a second transcript.

Transform evidence MUST resolve both original and replacement versions through existing Item, package, notebook, Artifact or other owning records. Audit stores safe references and outcomes, not secret-bearing or unrestricted payloads. Vault injection retains existing grant/plan/use references; preserving both versions never authorizes retaining credentials or bypassing redaction. If the required safe evidence cannot be retained, report an error rather than claim a completed transformation.

Timeout, provider refusal to perform its job, dependency failure, invalid result and an open circuit MUST remain explicit unavailable/error outcomes, never a fabricated deny or allow. A valid gate refusal remains a gate decision. Policy selects the existing human/Pending Request escalation, a permitted continuation for non-decisive work, or a clear error. A required gate with no valid result cannot dispatch the effect. Failure to record required evidence prevents release of its result; an already uncertain external effect stays with its existing outcome owner and MUST NOT be replayed automatically.

Use a Policy-configured bounded timeout and circuit breaker for the participant binding. Repeated provider failures open that circuit; a bounded probe after its configured wait can close it on success. While open, do not invoke the unavailable provider; record that disposition through the same owner and apply the binding's unavailable behavior. This is request/binding-local availability control, not a new durable recovery service. Restart loads current bindings, preserves recorded outcomes and does not resume or replay old participant effects.

## Frozen BASE Formats

Needed before v0.1.0 so later bindings and row migrations keep one retained contract.

`protocol/models/interception.ts` owns runtime-neutral schemas only. Authored statements live in the existing Policy/config owner; `server.jsonc.policy.interceptions` is an optional protected Server declaration. The trusted owner resolves a binding from that statement and its actual source revision; no authored entry supplies its enclosing configuration hash. Statement replacement/removal through the current owner replaces/revokes the active binding. No separate store, identity allocator, registration service or proposal workflow is introduced.

| Element | Frozen contract and ablation |
| --- | --- |
| Statement identity | Version 1 carries an owner-defined key, point/mode, participant version, existing owner scope, subject/action/resource, input/output contract versions and stage order. Without the exact target and contracts, the executor cannot distinguish the admitted job from another effect. |
| Attribution | Author and optional delegation reference come from the admitted Policy writer. Native evaluator projections name their actual system author; absent catalog-rule authorship stays unknown. Without this distinction, a requester or evaluator could be mislabeled as the rule author. |
| Resolved version | NanoCore derives the binding digest from the admitted statement and qualified source reference. I16 uses retained AEP selection and the effective MCP catalog digest, including tool rules, not only a transport declaration digest or fixed Policy label. Without this pin, a changed rule could reuse an old assessment. |
| References | Content uses the existing scope-qualified reference grammar plus owner version; other records carry their exact Server/User/Workspace owner, family, opaque identifier and version. References grant no access and missing historical bytes stay unavailable. Without qualification, a shared notebook or grant could resolve in the invocation's wrong scope. |
| Invocation | The existing scoped Audit event holds a typed version-1 observation with the admitted binding snapshot, safe input/output references, actual actor, outcome/reason and start/end times. Its existing call/Turn/request/PermissionDecision links remain authoritative. Without that small snapshot, a replaced configuration file would lose which binding was evaluated. |
| Availability | Each binding carries bounded timeout, failure threshold, circuit wait and unavailable behavior. Only observe/advise may explicitly continue without a valid result; a required gate/transform never does. Without these fields, a participant failure could silently become authorization. |
| Current release | The specialized owner supplies current admission, safe output resolution/validation, final Policy and synchronous release. No suspension separates final checks, required record and dispatch. Without this boundary, a late assessment could release a stale or unauthorized effect. |
| Native contracts | Deterministic fixtures retain Gateway per-Agent/tool scope and reference Storage lease facts (issuer/subject/audience, KB, mount, prefix, mode and expiry) through their existing owner. Without these fixtures, the frozen format could omit inputs needed by its first consumers. |

Retained invocation readers ignore unknown additive descriptive fields, including nested binding/reference metadata, without rewriting stored bytes; unknown core modes, points, required versions and authority values remain errors. Authored statements and active bindings keep exact admission.

Invocation data is an additive optional field in the existing Audit family, with ordinary nullable-column migrations. It is historical evidence, never an active Policy statement. A portable historical observation does not grant or activate its source binding in the destination. No body, raw argument, secret, new transcript or history service is retained by this format.

## BASE Executor And Pilot

Needed to exercise the frozen contract at one real boundary before moving the other rows.

`nanocore/src/policy/interception.ts` orders admitted jobs, validates typed mode outcomes and rejects revoked or changed binding/input results. Observe is non-decisive and records at the admitted boundary; transform, advise and gate retain their required order before final Policy. Safe transformed values resolve through their existing owner and pass the specialized input validator. A process-local circuit is keyed by full scoped binding identity/version; one bounded probe after its wait can restore availability. Restart resumes no participant or effect. Without this small executor, the first native consumers would implement incompatible order and failure rules.

The BASE pilot is I16's final MCP `tool.use` admission. It preserves existing schema, Vault, Turn, audience and Pending Request checks, current NGAC evaluation, call/AEP joins and specialized regressions. A failed authority read is an explicit error, never a fabricated durable deny. The native evaluator author is distinct from the Worker/trigger actor and unknown catalog author. No external adapter is installed; tests inject one deterministic provider, and an unavailable participant produces a recorded unavailable result. Without the actual I16 seam, schema-only proof would not establish truthful dispatch behavior.

Only the BASE formats, small executor and I16 pilot land before freeze in this cut. The semantic audit lists reachable conflicts for owner-lane correction through the coordinator; missing invocation evidence alone remains ADDITIVE under the later migration issue. Other existing rows and provider adapters remain later work. This additive cut requires no reset or conversion reader.

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

The table's I labels are documentation references, not persisted identifiers. Paths are under `apps/nanocore/src/`. P1=context/delivery, P2=model mediation, P3=MCP admission, P4=result return, P5=Artifact/output, P6=operation/mutation, P7=Pending response, P8=work/boot admission. U means integrate with the base after phase F; L means a later optional capability. The named lane owns its migration producer, not a new authority.

| ID; existing mechanism | Point; mode | Existing owner/evidence path | Lane; phase |
| --- | --- | --- | --- |
| I01 Item projection | P1; transform | context/llm-projection.ts; transient result, original Items retained | L-AK; U |
| I02 Assistant audience | P1; gate | internal-agents/assistant-history.ts; conversation retrieval trace | L-AK + L-GA; U |
| I03 Knowledge eligibility | P1; gate | storage/index-rebuild.ts; selected/excluded retrieval trace | L-AK; U |
| I04 context preparation | P1; advise | knowledge-manager.ts; deterministic retrieval and usage, not an agent | L-AK; U |
| I05 Worker package | P1; transform | context/worker-context-package.ts; exact package/trace | L-AW + L-AK; U |
| I06 Task composition | P1; transform | internal-agents/worker-coordinator.ts; deterministic request, Task admission | L-GO + L-RT; U |
| I07 AEP redaction | P1; transform | runtime/aep-snapshot-ledger.ts; safe snapshot | L-RT + L-GA; U |
| I08 Gateway enable/allow | P2; gate | llm/gateway-routes.ts; best-effort PermissionDecision coverage | L-RT + L-GA; U |
| I09 provider credential injection | P2; transform | app.ts, Vault owners; safe call/use references | L-GA + L-RT; U |
| I10 usage accounting | P2; observe | capability/usage-ledger.ts; UsageRecord | L-RT; U |
| I11 precommit/retry availability | P2; gate | llm/gateway-execution.ts; attempt/call outcomes, not Policy deny | L-RT; U |
| I12 capture confidentiality | P2; gate | llm/model-capture.ts; WorkObservation with body-unavailable state | L-AW + L-RT; U |
| I13 generic transformer pipeline | P2; transform | absent as a Policy-bound provider pipeline | L-RT; L |
| I14 MCP discovery filter | P3; transform | worker-mcp-routes.ts; schemas/calls, built-in list lacks invocation record | L-GA + L-RT; U |
| I15 MCP approval requirement | P3; gate | worker-mcp-routes.ts; Pending Request, Item and capability | L-GA + L-CH; U |
| I16 MCP tool.use | P3; gate | worker-mcp-routes.ts; PermissionDecision and call/AEP links | L-GA + L-RT; U |
| I17 MCP credential injection | P3; transform | worker-mcp-routes.ts; Vault plan/receipt/use | L-GA; U |
| I18 captured execution | P3; gate | runtime/captured-pending-call.ts; Pending execution/call/result | L-GA + L-CH; U |
| I19 built-in Work result size | P4; gate | runtime/openkit-work-mcp.ts; bounded result/call error | L-RT; U |
| I20 Artifact submission | P5; gate | runtime/openkit-work-mcp.ts; Artifact and command | L-AW; U |
| I21 Artifact candidate choice | P5; gate | artifact-reviews.ts; exact candidate selection and actor | L-AW; U |
| I22 ordinary admission | P6; gate | operation-resolvers.ts, auth/operation-authorizer.ts; decision-record gap | L-GA; U |
| I23 notebook validation | P6; gate | knowledge/notebook-publication.ts; Git, Audit and receipt | L-AK; U |
| I24 Knowledge decision | P6; gate | knowledge-operations.ts; exact human review and command | L-AK; U |
| I25 app write validation | P6; gate | generative-kernel/commands.ts; app records, revisions and Audit | L-GO; U |
| I26 MCP binding write | P6; gate | catalog/catalog-operations.ts; authored catalog revision | L-GA; U |
| I27 configuration write | P6; gate | config/runtime-config-operation-implementations.ts; validated file revision | L-GA; U |
| I28 secret-shaped rejection | P6; gate | shared schemas; rejection lacks standalone invocation evidence | L-GA; U |
| I29 work.input.request | P7; gate | runtime/openkit-work-mcp.ts; question Pending Request and Item | L-CH + L-RT; U |
| I30 Goal Plan approval | P7; gate | runtime/goal-owner.ts; Plan/Pending exact bytes and actor | L-GO + L-CH; U |
| I31 Discord disclosure/response | P7; gate | channels/discord.ts; disclosure/inbound receipt and native response | L-CH; U |
| I32 Audit producers | P8/boundary; observe | audit-events.ts; existing scoped AuditEvent | L-GA + originating lane; F/U |
| I33 scheduler admission | P8; gate | scheduler-records.ts; admission/input, typed capacity error | L-RT; U |
| I34 recurring trigger/outcome | P8; observe | lib/automation-store.ts; definition Audit and occurrence | L-GO + L-AK; U |
| I35 Worker launch record | P8; observe | runtime/worker-turn-loop.ts; PermissionDecision/checkpoint | L-RT; U |
| I36 boot self-check | P8; gate | bootstrap/policy.ts, index.ts; Core decisions and Audit | L-GA + L-RT; U |
| I37 optional AI assessment | P6; advise | absent; existing assessment Observation owner is reusable | L-AK; L |
| I38 named read scope/audience | P1/publication; gate | permissions owner; I02/source guards are existing analogues | L-GA + L-AK; U |
| I39 generic rate-limit hook | P2; gate | absent; provider quota parsing/retry is not this gate | L-RT + L-GA; L |
| I40 generic token-budget gate | P2; gate | absent; usage and effort options are not this gate | L-RT + L-GA; L |
| Skill candidate decision | P6; gate | catalog/catalog-operations.ts; candidate, decision Audit and command | L-AK; U |

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
| C09 agent Policy | ADDITIVE bindings/provenance; L-GA with L-GO/L-AK, L | Delegated authorship, revocation and shadow activation; changed old configuration meaning requires separate MIGRATION classification. |
| C10 shared execution | ADDITIVE formats/evidence; L-CH BASE/I16 with L-GA Policy review, F; remaining table lanes, L | Freeze binding/invocation formats and minimal executor with I16; audit semantic conflicts now, migrate other rows after v0.1.0 without duplicate gates. |
| C11 transform references | ADDITIVE; producing owner, U | Safe before/after versions resolve through existing owners, with no raw-secret retention. |
| C12 optional providers | ADDITIVE contracts, implementation-only adapters; table lanes, L | Inject a provider behind the contract; absent rows gain capability only when separately implemented and authorized. |

The store dispositions are: TS1 Claim -> OKF Claim; TS2 reusable observations -> OKF Observation; TS3 reusable conflicts -> OKF Observation with conflict state; TS4 Sources stay evidence; TS5 proposals stay candidates; TS6 live app and TS7 template reusable meaning -> Entity/Topic/Rule or Skill while records/structure stay; TS8 presentations stay projections; TS9 has no production instruction-body store and future procedures use Skills; TS10 plugin descriptions stay discovery metadata. These are classifications, not a claim that live private content was inspected or moved.

MCP list filtering and call enforcement share constraints but keep separate disclosure/effect checks. Retrieval eligibility and package budgeting retain distinct owners. Reuse PermissionDecision/Audit across boot, Gateway, MCP and ordinary admission; reuse Pending Request across approvals, questions, Plans and channel responses. Confidentiality checks at separate storage/dispatch stages remain mandatory. P4 lacks a general vendor-result adviser/transformer; P5 lacks a generic Turn-output interceptor. Add those later only at actual owned boundaries. Ordinary admission, transient projection and built-in list coverage must be closed through existing Audit before claiming complete invocation evidence.

## Testing Strategy / Acceptance Criteria

Needed to make each approved decision and migration completion observable.

- A Claim or reusable conflict has one OKF/KM authority, retains its numeric confidence and sources, and cannot become active or bypass an unresolved conflict through migration. Operational records and required human decisions remain usable.
- An app record's entity state, external IDs and progress remain queryable/mutable in the Kernel after domain meaning moves; discovery resolves exact Knowledge/Skill references or reports unavailable. Presentations and Sources do not become competing truth stores.
- Type/applicability retrieval finds eligible Rule, Effect and Objective pages, excludes unauthorized or stale material, and grants no operation authority.
- Fakes cover each mode: observe/advise cannot veto or mutate; ungranted gate/transform cannot act; granted transformations retain safe original/replacement references; final Policy rejects an unauthorized transformed effect.
- Binding revocation, changed input/version or stale result prevents release; shadow decisions do not replace the current decider, and activation records the actual agent and delegated class without satisfying a human-only gate.
- Timeout, bad output, provider failure, open circuit and evidence-write failure yield explicit unavailable/error outcomes, no false deny/allow, and no automatic replay of an uncertain effect. A permitted bounded probe restores availability without widening authority.
- Every invoked participant and open-circuit disposition is inspectable through existing durable evidence, including observe/advise and built-in list/projection paths; no secrets or unrestricted bodies enter Audit.
- Trace traversal uses retained IDs, rechecks every node's current access and exposes no inaccessible metadata; missing edges remain missing, and restart rebuilds the view without inventing lineage.
- Each table row retains its specialized regression while integrating with common bindings/evidence. No mandatory check is deleted merely because a provider now participates; absent optional rows are not reported as implemented.

## Related Documents

Needed to preserve specialized effect owners rather than duplicate their lifecycles.

[Pending Requests](20260930-pending_requests.md), [Knowledge Governance](20260702-knowledge_store_governance_rules.md), [Notebook Editing](20260909-knowledge_notebook_editing.md), [Policy Enforcement](20260703-policy_enforcement_mapping.md), [MCP Supply](20260704-worker_mcp_tool_supply.md) and [Kernel Data Operations](20260908-generative_kernel_data_operations.md) retain their unaffected contracts. On the specific consolidation and later provider-binding surfaces, this specification replaces the separate Claim-ledger design and earlier restrictions that excluded the now-approved participant mechanism; it does not activate those providers or bypass the required implementation phases.
