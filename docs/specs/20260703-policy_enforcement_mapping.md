---
status: Accepted
kind: mechanism
implementation: Partial
aspect: policy
---

# Policy Enforcement Mapping

This specification owns how NanoCore maps Policy decisions into product enforcement, mediation, and retained decision records.

## Scope

This specification owns product enforcement of the Policy Kernel, including assignments, interception, and decision records.

It does not own:

- Kernel graph semantics. [OpenKit Policy Model](20260629-openkit_policy_model.md) owns them.
- Authentication and membership storage. [Identity](../core/identity.md) owns them.
- Approval presentation. The pending-request owner retains it.
- Secret bytes. [Vault](../core/vault.md) owns them.
- Sandbox enforcement. [NanoHost Runtime And Transport](20260802-nanohost_runtime_and_transport.md) owns it.

Core: [Policy](../core/policy.md), [Mediation](../core/mediation.md).

Personal/Thread scope uses same Kernel; fixed audience/current membership; exact User Memory and Server administration; no authority from past Memory or assessments.

Kernel owns NGAC semantics; NanoCore adapter/decision/approval/backend projection; authentication, lifecycle, UI and secret mechanisms retain named owners; no second RBAC/org/tenant/per-App ACL; refuse runtime-native approval. Equal member baseline excludes Server, finite maintenance and administrator-only Workspace export under the accepted export decision. Ordinary membership supplies only the member operation set. That set excludes Server operations, finite maintenance, and Workspace export. Administrator eligibility is separate and current.

Baseline adds no generic authored graph, role table or arbitrary operation blocking; finite maintenance/resource restrictions retain their existing owners.

No separate assignment store/evaluator/receipt/scope registry; exact native constraints, Agent selector and last-revoke boundary carry only their necessary authority.

First resource restriction is shared Thread; other families need owner mapping; private/audience/source and secret/external-effect constraints cannot be shared away by resource grant.

Bare/source subject refs grant no target membership/Agent/admin identity; import absent, no new import authority/approval/recovery store.

### Finite Worker Git-Read Maintenance Assignment

Finite Git assignment only current responsible admin's private administration entry and registered Server Agent, purpose git-read/action administration.configuration.apply; no new agent principal/credential/generic language/Workspace delegation.

Goal and gate authority consumers activate only their bounded subset; Plan/domain one human approval; storage lease no active Policy family or inferred schema authority.

Pure Kernel subset, separate config merge catalog, AEP snapshot requirement, critical boot minimum allow/restriction self-check and durable linked decisions retain existing owners.

Backend material derives approved decision/AEP/grant/catalog/materialization/containment/placement intent; evidence not canonical Policy, existing owners retain compiled artifact lifecycle.

Product result spellings/approval linkage/native derived material keep existing Core/Protocol owners and never replace Kernel.

New authorization family needs owning registry update; pure Kernel stays synchronous allow/deny; runtime-native prompts always refused, no second permission mechanism.

Consolidation/interception reuses existing effect/content/Policy/Pending/Knowledge/Skill/runtime owners; no plugin loader/workflow runner/retry ledger/transcript/graph authority; binary Knowledge separate.

Glue-data use is Meta-Skill recommendation for current MVP, not Kernel validation limit or function cap.

Canonical OKF Claims/Observations/conflicts, app semantic prose labels and existing empty AEP instructions do not imply private-content migration or competing automatic Knowledge authority.

Current naming is canonical Work names projected mechanically to MCP; current hyphenated capability IDs stay owner-defined, no naming aliases.

Retained meaning/layout change requires explicit existing pre-stable reset owner, no conversion/dual writes/automatic reset; document authorizes no deployment action.

Keep MCP list disclosure/call effect, retrieval/package budget, boot/Gateway/governed decision, and approval/question/Plan/channel Pending owners distinct; no mandatory confidentiality check removed by consolidation.

Merge replaces competing fact-ledger and earlier participant exclusion only on approved surfaces; unaffected effect/Knowledge/Skill/Pending/runtime contracts retain owners and no automatic provider activation.

## Enforcement Points

Existing MCP and Workspace/User Vault operations use actual operation/stage pipeline, exact Policy resource and reference-only inputs; no material in proposals/participants. A common decision has an explicit Workspace or User database home. A source and target owner mismatch refuses before participant disclosure. A Server policy-write decision uses its native Core owner.

Retain operation and stage once; derive operation@stage for point/enforcementPoint/display; no second point string/registry; use PolicyStageV1Schema.

Only holdable Core crossings enforceable; Worker-internal shell/files/network outside this participant coverage; Sandbox stays mandatory; boot/resolver/participant calls admit no bindings.

Every authenticated primary operation requires current identity/scope then actual Kernel decision over immutable facts; unknown/missing/denied/error refuses before handler without cross-scope grant.

Ordinary primary admission remains transient, no PermissionDecision/Approval/Action Center/pending workflow; governed effects keep their explicit evidence.

User admission current active canonical user/credential at User target; Server requires current deployment admin and separate association; bootstrap remains exclusive actorless procedure.

vault.grant-withdraw is fixed User-target vault.admin; repeat exact owned reference/grant checks in native writer; actual caller User decision/Audit home even when admin acts on other's reference; no Worker/Coordinator entry.

Workspace active member and current nonmember admin use distinct associations; truthful admin actor; owner identity no permission tier; candidates checked before discovery and credential/audience/lifecycle fences remain.

Schedule is exact AutomationIdentity/responsible human, no rights itself; missing/revoked lineage cannot become admin/system fallback.

Minimum owner-lineage + current scope/Thread/operation before content/effect; filter discovery before metadata; original source/audience checks remain and Turn snapshot grants no future authority.

Native finite adapter checks admin/credential/private Thread/Turn/cancel/source/revision/assignment/candidate/failure lineage then exact Kernel allow; decision/Audit safe loaded observation only, not authority.

Evaluate at these concrete Core boundaries: the central Workspace resolver before lookup or mutation; App commands; Worker MCP; scheduling; AEP resolution; workspace materialization; capability projection; LLM Gateway; Vault resolution; injection; Knowledge retrieval and read; Workspace review and apply; Artifact import, introduction, and verified output; and destructive teardown. Backend adapters enforce derived runtime material, not product authority. A present category does not mean participant registration or evidence is complete. Local enforcement at these crossings stays mandatory. Common participant migration is not complete. This list adds no registry and no activation.

Gateway direct config controls coexist with Kernel primary authority; specialized durable decision/evidence owner, model pipeline not fully routed.

Core typed filesystem/network intent validated before carriage; NanoHost renders/parses exact SDK policy; malformed/unknown/unsupported refuse before backend effect.

Current actor/responsibility/membership/token/grant/origin/snapshot and conditional assurance/time facts; missing required ordinary facts deny, no local-owner fallback; enums/artifacts not new actor-kind registry.

Migration row/lane labels and angle brackets are not persisted points or registered executable IDs; preserve actual existing owner IDs, no second registry.

Ordinary operation admission: preserve existing specialized owner/checks; Intentional transient Kernel-only boundary; an absent decision ledger is not a missing record.

Boot self-check: preserve existing specialized owner/checks; Deliberate pure Kernel self-check and original Core pair/Audit; no participant bindings by design.

## Decision Records

### PermissionDecision

Retain principal, on-behalf-of identity, actual actor/process, credential and responsible human separately; no invented process for direct human work or inferred model identity.

Map gate and Kernel results through existing product contract; Goal missing-grant escalation only in defined case, never a prohibition; shadow output nondecisive.

Invocation stores output digest rather than assessment bodies; agent gate decision retains actual reviewer/human, final decision retains original caller; check current pinned chain before disclosure and release.

Bounded human-created native gate declarations retain creator/human/chain, current terminal human and immutable historical attribution.

Decision/outcome keeps actual decider/validation, persisted and active revision separately; saved/validation-failed/commit-failed/unknown distinct; no activation from candidate save.

Existing config CAS/reload/PermissionDecision/Audit retain rationale/validation; allowing evidence does not prove file commit or loaded activation.

Final owner transaction consumes required uses; exact same-effect readback recognizes only original final decision+Audit, not later authority; selected permission refs enter authorization revision.

Existing PermissionDecision artifact owns exact immutable summary/result/approval/Audit/time plus mediation pins/refs shape; reference artifact rather than repeat fields or add a record family.

Responsible-human reassignment does not rewrite old decisions; safe invocation evidence before release through current Policy/Audit; absence of old edges stays unknown and fixed label not historical immutable snapshot proof.

New actual Kernel result retains only matched association/prohibition IDs, including empty; exact evaluated revision identifies rule version; no full Policy body/duplicate provenance/new family; omit trace when no Kernel. The retained Kernel trace is two matched-identifier arrays in the existing context summary. It is not a graph body or the Decision Trace view.

Boot self-check independent pd UUIDv7, exact bootId/action/boot=true; reopen keeps original pair+Audit; ambiguity/incomplete/missing/changed facts refuse before write; new boot fresh allocation; entropy no partial publish.

Pair and Audits one existing Core SQL unit, no boot lifecycle/evaluation trigger or cross-domain atomicity. The native Core decision and its Audit await a covering FULL acknowledgement. Failure of that acknowledgement is not proof of rollback. Finite uses and the linked Audit commit in one owner transaction. File compare-and-set, reload, and any upstream effect stay separate.

Captured admitted allow derives pd UUIDv5 from exact ["pending_execution",requestId], immutable through retry; current first claim evaluation remains required; absent first decision no synthetic deny.

Neutral not_applicable is omitted if another domain applies. `combineResults` in `apps/nanocore/src/policy/interception.ts` is the precedence algorithm: error, then deny, then require_escalation, then require_approval, then defer, then not_applicable, then allow. Missing mandatory facts are an evaluation error. All-neutral blocks. Only every applicable mandatory allow authorizes. A single input is not an implicit absent-domain allow. This names that algorithm and adds no result enum or evaluator.

Imported decisions/Approval history nonauthorizing; apr_imported_ reserved and rejected at target creation; target-issued canonical VaultGrant required before mutation/material; no inference/backfill/rebind promotion or deny-history rewrite.

Product outcome behavior uses existing decision/Pending/attention owners; approval waits exact effect while work can continue; no authority from all-neutral/error/nonallow.

Policy-originated exact decision/approval/attention/Audit links; resolution retains deciding human/satisfied requirement/follow-up current evaluation; never import native runtime approval.

Collection/statement exact content revisions and schemaVersion 1; unrelated edits do not renew finite uses; existing authored configuration owner.

One retained Policy revision in policySnapshotId; mediation operation/stage derive projections, no duplicated SQL/portable point/subject facts; actual Kernel result or error absence; gate exact binding. policyDigest is sha256: plus the lowercase SHA-256 of the UTF-8 canonical complete name. Undefined object members refuse. Boot hashes the evaluated Policy state. Mediation hashes the admitted Policy document. A statement reference hashes that statement. Configuration contentHash is the untagged digest of `snapshotSemanticSummary(snapshot)` in `apps/nanocore/src/config/runtime-config.ts`. It is not `policyDigest`. Historical snapshot labels stay the literals worker_turn_launch_policy, runtime_config_gateway_policy, and policy_snapshot_runtime. [Protocol Identifiers And Enums](20261021-protocol_identifiers_and_enums.md#ids) owns the shared digest form.

Existing invocation evidence safe digests/versions/subject/outcome/time/call; no raw args/credentials/unrestricted output; missing evidence blocks; complete advise safe-reference consumer still absent.

Only final allow atomically consumes uses; shadow/gate/denial none; captured fresh evaluation and original claim identity do not double consume; catalog human conditions same pipeline.

Retired supervise decisions readable; real bounded Worker launch/checkpoint records before boundary, AgentSession/AEP share owner snapshot reference; no new Goal launch contract or direct Main writer claim.

Shared recorder seven results, required approval kind, linked scoped Audit/decision projections; captured MCP approval/escalation does not pause Turn; Goal escalation wakes Coordinator rather than human request.

Diagnostics expose only safe decision/result/reason/point/redacted summaries/snapshot/matched IDs; no secrets/raw graph/path/provider/source bodies.

Current shared formats/pilot/writers/validators plus approved continuity boundary; no compatibility converter/dual writes/automatic reset; immutable historical attribution/allocation/non-authority preserved.

Require Policy-originated approval, derived OpenShell evidence linked to decisions, resource-scoped product vocabulary and safe structural traces; no rationale-only rules lost on deletion.

Existing call/Turn/Pending/retrieval/content links remain original authority while safe Policy/Audit envelope links invocation; no parallel transcript/graph store.

Pre-freeze actual Policy/rule/author/delegation/Skill/Artifact/Turn/capture references live on original owners; preserve separate author/human/trigger/approver and unknown historical absence, never reinterpret fixed labels.

Shared retained statement/revision/decision format with real writers/validators and current pilot; broader routing can follow without a new gate/store; no incomplete shape claimed frozen by text.

Current channel-origin addition is trusted provenance only; reset and additive behavior remain separate; no automatic Policy review inferred from landed agent/Goal subset.

Current-tree export carries subject/exact page pins, native Git history; standalone fact DTO/operation/monthly/JSONL authority retired with no alias/converter; WorkObservation/Audit/suppression unchanged.

Protocol schema-only, confirmed Server candidate/CAS authority, original Policy/Audit owners and version-before-content readers; no predecessor decoder.

## Interception

Shared permission/binding/delegation collection revision pins evaluation; actual author/delegation/scope/lifetime/activation retain their existing owners.

Binding contract retains selector, scope/lifetime, participant/version, typed disclosure, ordering/failure/state and accountable authority; name PolicyBindingV1Schema rather than duplicate fields.

Binding create/replace/narrow/activate/revoke uses policy.write and write-time disclosure authority; presence of provider/Tool grants nothing.

Participant invocation/investigation is current Kernel-only with no nested bindings/recursive approval; authority chain terminates in current owning human.

Active human MCP conditions allow only prohibit/require_approval, Workspace anchor, no finite uses; common full candidate/human confirmation/CAS path.

Restrictive condition may precede Tool discovery; warning names exact tuple and travels in confirmed candidate/validation plan; apply revalidates authority/content rather than warning equality.

Future granting allow still needs observed Tool name; removing a Tool stops matches; no schema-version pin; current author/lifetime/revision rechecked.

allowedTools is supply, not another grant; discovery and direct/built-in/captured dispatch preserve current prohibitions; final Kernel mandatory; agent allow cannot satisfy human condition.

Captured calls require current native mediation readback and no retired-binding fallback; Server-origin authored Tool selectors remain unactivated.

Vault subset is deterministic deciding allow/deny gate with error failure and completed observation; preparation/apply/loaded readers refuse unsupported combinations.

Actual proposal pins subject/operation/resource/safe payload/context, Policy/binding/input versions and logical digest; existing content owners retain immutable originals.

Supported gate path keeps explicit order and final pure synchronous Kernel; participant may neither skip it nor override result precedence; Core owns deadlines/circuits. Gate order is deterministic, then a UTF-16 identifier tie-break. A duplicate active order or point position refuses.

Only final combined allow releases owner's effect/commit obligations; Core-only secret injection follows allow and exact approved target/account/action, never participant inspection or injection grant.

No new cross-domain atomicity/effect receipt/retry lifecycle; completed observer cannot veto/mutate known result; nested Tool dispatch retains independent checks.

Native agent output allow/deny/escalate plus bounded risk/authorizationAssessment/rationale; assessment untrusted, cannot impersonate human or invent product result; owner schema holds fields.

Ordinary agent activation requires same shadow binding/completed evidence and separate bounded human policy.write; no new activation store. Preserve narrow restrict-only Server exception separately. The Server security-review gate is restrict-only. A confident no-objection is neutral. A block denies. Uncertainty or failure escalates. The gate cannot grant or satisfy a human-only approval. A narrow Server anchor may skip the ordinary shadow prerequisite. The default app does not supply the qualified callback.

Native ordinary agent subset is MCP deciding gate; no advice/transform/automatic review/general Tool activation; empty/deterministic paths preserve existing effects/evidence.

Native human-confirmed agent declaration records unique identity, preserved creator/responsible human/chain and exact participant digest; no inactive/expired/cyclic/out-of-domain authority or finite-use identity.

Same submitted binding can follow its server-stamped declaration digest; no unrelated repinning; agent domain and current human domain are independently mandatory, not inherited rights. An edit preserves the agent-principal creator. The same submitted binding may repin to its server-stamped declaration digest. An unrelated or unchanged binding is not repinned.

Gate sees only admitted safe summary and one result Tool in actual admitted Turn through existing Gateway/capture/usage; no raw Tool args, investigation, invented session or execution store.

### Policy Review And Update

policy.write uses governed proposal/decision/commit; proposer/rationale/exact proposed set/scope/lifetime/base revision; derive diff/class from immutable candidate/base, not duplicate retained facts.

Validate closed shape, conflicts, current author/delegation, disclosure and widening/narrowing; full changed/removed restriction ceiling remains mandatory.

Worker suggestions are candidates, not grant authority; no self-approval of own widening; preserve exact human switch-removal recovery exception with security owner. The full-diff ceiling includes a deleted or weakened restriction. One exact human route-switch removal is the recovery exception. It is not a general self-grant.

Impact simulation/recent-decision/Pending analysis is not prerequisite; later Meta-Skill suggestions still require same governed owner. The current exclusion is implemented; optional simulation/reuse is separately #412.

### Goal Domain And Container Projection

Joint Plan approval retains exact Goal envelope, Workers/resources/rights/human/Coordinator; Task inherits intersection with immutable typed resources; no inheritance widening.

Only current inside-domain missing Task association with allowing human Kernel can escalate to exact Coordinator/Goal; prohibition/human-only/failure destinations stay intact; no dispatch/use/retained-store authority from routing.

General outside-envelope request reaches owning human via Plan revision; Coordinator grant remains Policy administration rather than satisfying human-only gate; rerun full current evaluation after grant.

Lifetime independent from scope, represented by container anchor plus optional notAfter/uses; unknown required anchor/bound refuses, not a closed duration enum.

Ordinary authority ends on anchor/time/use/author loss; once consumes atomically on final allow; persistent owner anchor has no optional bound; Coordinator grant ends no later than Goal. A finite use is keyed by the exact statement digest. An unrelated document change does not renew it.

Extending Goal authority beyond its domain needs human-approved promotion, not cleanup or inferred persistence.

Captured request binds transformed proposal/Policy/authorization; changed target/binding/revision invalidates; execution reruns current pipeline, requester does not reissue; agent only explicit activated condition not human-only.

Once consumes proposal approval with no Policy write; persistent/work-unit authority needs separate policy.write and controls distinguish them.

Current native human input-authority checks both proposal/apply, same-author observer reduction classification, agent/Goal subsets bounded; generic automatic review/general grants unimplemented.

Fixed mode contracts, not separately authored input/output replacement schema; active/shadow advice/transform refuse until safe owner/evidence exist.

Target-issued injection grant provenance already checked; binding/restart cannot reactivate imported grant. Plan creation and downstream consumers already check target-issued grant provenance.

React/post-success Policy mutation remains excluded before accepted later activation, own author's current authority; commit injection not react.

Solidified reusable procedure Skill-owned; reusable understanding owner-scoped OKF/KM; operational/source/authority records stay existing owners.

Claim is governed OKF page, not separate canonical ledger; retain source/scope/numeric finite [0,1] confidence/freshness/review/conflict; no ordinal conversion or authority from confidence.

Rule/Effect/business Objective use admitted ScopeSchema, governed fields and required applies_to; KM type/applicability filtering preserves source/scope/audience; values descriptive, never fabricated grant. Type and applicability filters use the exact types and appliesTo selectors.

Effect requires basis and explicit last_checked_at; Objective distinct from work Goal; retrieved Rule no permission; safety-critical rules pinned Skill/independent Policy validator, not optional retrieval alone.

Kernel holds structured app entity/state/progress/external-id/match data with no scenario/function restriction; structure/provenance stay; only reusable meaning/procedure use Knowledge/Skills; no mandatory Light App for external truth.

Immutable app/catalog structural versions retain exact Knowledge/Skill refs; meaning movement does not rewrite definitions or relocate data; versioned discovery resolves exact meaning or reports unavailable.

Presentation/task context bounded projection not reusable authority; formerly embedded solidified procedure moves to Skill, descriptive Knowledge refs can remain; no private grounding copy.

Governed ScopeSchema/page publication refuses Procedure even if authored schema permits it; generic external OKF parser remains permissive; no prose classifier or new Skill lifecycle.

Raw Sources/mechanical derivatives evidence; Proposal candidate until publication; reusable observations/conflicts OKF; work/review/Policy/Audit keep actual event/decision authority.

Provider receives admitted bounded typed job and binds result to input/participant/binding versions; factual investigation uses record owner not Worker claim; free text/unknown semantics grant no authority.

Replaceable narrow reviewer supplies assessment, Core enforces; no vendor/price/benchmark/world-model/measurement-campaign contract; injectable typed provider, not general framework.

Store dispositions have one accepted owner each: Claim/reusable Observation/conflict -> governed OKF, Sources evidence, Proposals candidates, Kernel data/structure preserved, procedure Skill, presentations projection, catalog metadata discovery.

Optional provider capability activates only after its separately admitted implementation, not from schema/provider installation.

Notebook/KM ordinary writer/readers; source/scope/freshness/Review independent from confidence/conflict; Observation subject distinct from evidence; same-Notebook exact digest pins version, unpinned refers object; unsupported target families refuse.

MCP pilot exact schema-independent summary/argument digest/package/Policy/current authority and mandatory Tool schema/credential/supply checks; native registry alone no endpoint.

Human-authored native gates/observers exact resource and admitted anchor; shadow nondecisive; finite-use completed observation unavailable; safe-output absence refuses active/shadow advice/transform.

Shared collection/selector/authority/deadline/evidence/current commit/human outcome/current response contracts have actual native writer/readers; schema alone proves no authority.

Plan and delegation share one human approval; Plan ref alone no domain; explicit human candidate apply and actual agent shadow/accountability only bounded subset; generic narrowing/review not activated.

MCP approval requirements: preserve existing specialized owner/checks; Human Tool conditions consumed by same current decide/captured path; additional nonpilot routing remains #373.

MCP tool.use: preserve existing specialized owner/checks; Native pilot common decide/final Kernel/observe/evidence, finite-use/currentness boundaries implemented.

MCP credential injection: preserve existing specialized owner/checks; Existing post-allow Vault plan/receipt/use with target issuance; not a separate participant transform.

Captured execution: preserve existing specialized owner/checks; Actual fresh mediated evaluation and native proof, no fallback/extra upstream effect.

## Mapping Table

Map product subject/action/resource/context vocabulary into NGAC required rights, not product-operation association rights; vocabulary examples do not create new active principal kinds.

MCP permission selector is exact Workspace/server/Tool resource; no parallel Tool-name grant kind; finite maintenance exception stays bounded.

`vault.delegate-refresh` maps to `ar:vault-delegate-refresh` for the deeper effect check when `backend-provider` delivery hands refresh-family material to a Gateway placement. Ordinary Workspace membership never supplies it. Delivery requires the current human-authored allowance for every evaluated human, including administrators, beside `vault.use`.

Vault effects use vault.use, inspection vault.admin; Worker package/session/Thread and Coordinator Goal/Task scope remain actual native bounds; revoked metadata inspectable without material.

Registry native extension preserves effect/target/audience/rights; registration creates neither endpoint nor extra primary admission.

Crossing attributes are descriptor vocabulary separate from mutation, sensitivity, risk and authorization, never access rights.

Immutable Task resource association remains baseline; alternative delegated allow only in Task class, approved Goal and human Kernel remain mandatory.

Unique primary product-operation -> NGAC right mapping exactly PRODUCT_OPERATION_ACCESS_RIGHTS; concrete descriptors select one primary operation; not another admission or role table; operation/right names distinct.

Deeper runtime.launch/vault.use/network.egress checks and exact lifecycle/claim/revision gates remain mandatory; route allow/evidence reads never become injection/effect authority.

Ownership transfer maps workspace.lifecycle; Vault metadata lists vault.admin; VaultUse/audit/evidence/usage/handle/decision reads audit.read; handlers cannot invent competing roles.

Descriptor mutation posture, not HTTP method, enforces readonly credential; incidental redacted evidence is not content mutation; retrieval can be mutating when its owner says so.

Invitee list/decision invitation.respond, member management membership.manage; new family/right needs owner registration; no vendor-specific GitHub right.

Destination Workspace mutation fence grants neither membership nor content; selected reference owner does not replace caller; Vault owns withdrawal/runtime closure.

Server target family administration/mcp/knowledge selected by descriptor, default administration, unknown denies; exact transient graph attributes/rights, no prefix/caller family inference or finite-maintenance right.

Recurring definitions/history workspace.read plus linked thread.read; mutations workspace.configure/readonly posture; due turn.run plus runtime.launch/current dispatch; audit.read separate.

### Initial Generative Operation Projection

Generative concrete operations derive primary/mutation facts from family descriptors, retain exact owner predicates, no Light App ACL or extra right/runtime registration.

Refresh/action distinct descriptors and posture; reject wrong binding class; Worker Tool route independently checks supply/tool.use without second public primary admission; equal-member baseline not bypassed.

Managed Thread adds mandatory resource Policy class; broad Workspace association cannot satisfy it; exact rights and explicit prohibition precedence via same NGAC evaluator.

Knowledge/Memory primary operations and mutation posture derive owning definition artifacts; proposal inspection/decision and User memory scope distinctions grant no extra source/audience/publication authority.

Process-local automation read/create-update-delete, scheduler/retry/cancel/checkpoint recovery map current family artifacts; not recurring schedule contract; same single primary admission/readonly/admin audience.

Existing approval schema and actual derived generative operations retain primary/member/current Policy/audience/source/effect constraints; private source only same-private-owner destination.

Invitation not membership; admin credential no synthetic member/role but separate current eligibility; canonical owner lifecycle not tier; one Kernel request, no handler role/path/body heuristics.

## Workspace Assignment Storage

Native Coordinator writer accepts real Coordinator Turn separate from Task scheduler lineage and expected revision; rereads canonical Task/current approved Goal/human credentials.

Publish only ordinary Task Worker allow inside Goal actions/resources; author is Coordinator and exact root delegation ref; owned anchor/time/use bounds; no root rewrite/self-grant/participant activation/new grant kind.

Server policy.mediation and Workspace workspace.policy.mediation share PolicyDocumentV1 grammar but distinct authority scopes; moving data grants none; no old grammar converter/dual reader/import remint.

Existing statement identity/author/authority/time/state/scope/lifetime; human writer stamps real author; native process projection preserves human responsibility and actual registered Agent, no new principal by selector.

Ordinary human allow exact invocation, prohibition follows mapped processes; agent-process selects exact trusted Agent/human/Thread/right only; native active Thread subset allow/prohibit, no approval consumer.

Managed boundary non-grant, exact Workspace-shared Thread, empty subject/actions, Workspace anchor without time/uses; remains after last grant and only explicit confirmed removal restores baseline. The required feature is openkit.workspace-resource-policy.v1. Inactive or expired author facts do not turn a managed Thread into an unmanaged Thread.

Finite Server maintenance statement exact human/Agent/network tuple and REST host/port/repos/binaries/start/end; active state replaces enabled; no Workspace authority or duplicate union; interval validFrom<=now<notAfter.

Existing Pending captures replacement set for one Thread; current human distinct confirmation stamps author through sole revision-protected config writer; preserve other statements and saved/loaded distinction. A generic runtime file operation cannot change a Policy subtree.

Export same exact statements; no authority from old grammar/history; ordinary import does not remap resource/subject references.

### Named Workspace Resource Access R033

### Scope-Owned Statement Format F3

The only admitted human-authored ordinary `allow` is a refresh-delegation allowance for exactly `vault.delegate-refresh`: human subjects, one Workspace container resource, and a Workspace lifetime anchor without finite uses. Every other human `allow` refuses. The author must hold the right, so a deployment administrator authors and revalidates this allowance. It creates no stored Kernel association and supplies no other authority.

At `vault.binding-deliver`, the Vault owner passes active, unexpired allowances whose authors still hold the right as Kernel delivery facts. Each evaluated human, including an administrator, needs an allowance naming them. The mandatory delegated-refresh policy class applies to the requester and every actual Integration credential issuer, preserving the owner, credential and issuer intersection. Absence denies; failed delegation never falls back to `vault.use`. The deciding-facts digest is rechecked. Goal domains may list this right but never supply it.

Unique durable authority is workspace.policy.mediation in Workspace config/workspace.jsonc; exact Thread/human/Agent operations/prohibitions; AEP/Approval/request/Audit/history/display name are not assignments.

Workspace privacy restrictions travel with resource, not deployment membership/credentials/Server authority; AgentSession/runtime process not policy element.

Strict feature-aware validation and sole config CAS/reload; saved bytes do not activate; failed reload retains prior loaded state; no second grant ledger/runner/full NGAC admin API.

Member/current admin/current Worker may capture exact resource access request without confirming protected target; request grants nothing; canonical target/current eligibility resolved at review/apply, readback audience-safe.

Human-only current workspace.configure or deployment admin plus distinct confirmation for all boundary/grant changes; no admin membership tier/owner extra rights/Agent approver/Server grant.

Narrowing cannot widen resource/target; widening new review; revoke retains managed boundary; existing CAS/outcome/Pending owner and no default expiry/replay subsystem.

Export carries exact assignments/prohibitions/boundaries with each included managed shared Thread; current source/export audiences; saved/effective disagreement/orphan boundary refuses; empty-positive boundary survives.

Exact canonical repo URL paths and absolute binaries; grant's whole binary set bounded; same host/port/REST, no endpoint/TLS/credential/containment/audience/unrelated edit.

Only assigned info/refs* GET and exact git-upload-pack POST; fixed final wildcard not arbitrary glob; no push/unrestricted egress/template grant; query service is client input, no new query matcher.

Human candidate/outcome captures original author/base/exact set, actual decider/approval/persisted/active states; generic file updates no replacement; uncertain persistence/activation inspect existing owner.

## Failure And Recovery

Awaited participant work requires fresh credential/Thread/Goal/grant/generation/placement checks; completed observation cannot veto/retry; automatic callers reuse actual decision/Audit owners.

Changed input/Policy/authorization/binding pins invalidate earlier decision before release; stale expected write revisions/current authority prevent activation.

Timeout/malformed/unavailable/refusal/open-circuit apply declared escalate-to-human default, nondecisive neutral continue, or blocking error; no fabricated substantive deny/inferred allow.

Mandatory authority/input/evaluation failure is error; no valid required gate result means no effect; restart loads current Policy and never replays participant effects or old authority.

Any participant retries fit one invocation deadline; availability circuit separate from later substantive-denial circuit; current executor itself performs one invocation.

Missing mandatory chain/authority gives error; participant outage/invalid output uses failure disposition; agent allow never satisfies human-only requirement; human escalation remains captured Pending owner.

Lost response/restart inspects exact owner outcome/current revision; never automatically repeat unknown write.

Read exact current root/credentials/Task/anchor/expiry/uses each use; root loss ends dependents without cleanup; unused matching grant consumes none if baseline already allows.

Current local/presented admin bearer/selected session Token need no authored assignment; revoke before Kernel; unexpected identity/storage reads stay errors rather than Policy denials.

Current credential/membership/source/author authority mandatory at use; expired issuer not replaced by historical approval/scoped human.

Missing/unavailable author/boundary facts deny, never unmanaged fallback; export boundary is restriction not grant; ordinary import absent.

Last allow revocation keeps boundary; confirmed current Workspace-config/admin change required for baseline; no restored membership/agent/credential/responsibility or administrator impersonation.

Captured execution rereads requester/decider/target/assignment/revision; approval satisfies exact condition and is not assignment or Policy bypass.

Foreign/missing/stale/unknown/expired/revoked authority or Kernel failure refuses safely; conflict writes no replacement; lost result uses saved/loaded/outcome inspection, no repair/widen/replay; restart no historical authority.

Current loaded assignment per effect, active finite interval; save alone inactive; failed reload keeps old loaded bounds; duplicates/conflicts never union; hot reload removal revokes future use.

Recheck immediately before writer dispatch; pre-dispatch cancel/revoke no write; dispatched effect settles truthfully; exact replay no duplicate write, lost outcome inspection, no old AEP/failure rewrite.

Recovery missing/contradictory decision/call/request proof refuses or recovery_required; stable attribution and zero extra upstream contact on replay/failure.

Resolver fail-closed no enumeration/workflow/ledger; keep unexpected native dependency-read errors distinct where owner propagates them, docs/specs/20260703-policy_enforcement_mapping.md:306.

defer only in explicit accepted governed workflow that obtains missing context, never ordinary request fallback.

Denied required runtime placement/root/secret/Vault/containment/capability blocks launch; optional capability may degrade only when marked optional.

Preserve unresolved-conflict Proposal refusal/retrieval exclusion and ordinary archive/forget/restore/stale-base/restart Knowledge/Skill lifecycle; no parallel truth or recovery.

Uncertain external effect remains its owner's outcome and is never automatically replayed; completed observation/evidence failure cannot silently retry known effect.

Binding config deadline and availability circuit, no contact while open, bounded recovery probe only, reset failures after success; process-memory state not durable recovery/old-effect replay.

Current draft/active unresolved Observation blocks target/source Proposal before Review mutation and excludes active retrieval including pinned query/restart; unresolved pages themselves excluded; normal resolve/archive/remove/stale/restore.

Captured post-claim response reruns current proposal/revisions; refusal retains original failed execution call+decision, no upstream contact/usage; execution call identity distinct.

## Acceptance

Accept allow/deny/evaluation failure across Server/User/Workspace cases without handler effects, cross-family rights or implicit member authority; current credential revocation remains effective.

Acceptance exercises exact member/Agent grants vs unmanaged baseline, per-operation/prohibition/last-revoke, private/credential/admin attribution, request nondisclosure/no grant, stale/revoked apply, restart and export boundary preservation.

Finite maintenance acceptance covers exact failed lineage, immutable candidate, assignment allow, one CAS, separate reload, invalid/out-of-scope/changed/push/credential/provider failures, revocation/replay; real Sandbox qualification required.

Acceptance for current point identity, supported gate/order/final Kernel/secret boundary, write and use evidence, current disclosure/revocation, Goal/approval/subject/accountability invariants; general modes/automatic review remain separately unmet.

Preserve affected-family factual mapping, decision and approval imported non-authority, capability and Vault, and fail-closed acceptance with their owners. Acceptance includes a NanoCore-authored structured fixture that NanoHost's current SDK parser accepts, and rejection of an invalid trust boundary. Every produced PermissionDecision has a linked Audit. Every Workspace-addressed public operation has resolver metadata. Ordinary Kernel admission stays the deliberate transient exception: an absent decision ledger is not a missing record. This adds no test filename and no new harness.

Active members share baseline; removed/invitee/unrelated caller denied; keep actual current nonmember administrator eligibility rather than obsolete role-matrix/admin-only-denial expectation.

Real completed consolidation qualification covers ordinary lifecycle, exact pins, Proposal refusal, retrieval, retirement, portability and operational continuity; source-test presence alone not executed proof.

Acceptance: one OKF/KM Claim/conflict authority, numeric confidence/source preserved, no unresolved-conflict activation bypass, operational/human decisions still usable.

Acceptance: Kernel data remains queryable/mutable after meaning refs; exact Knowledge/Skill availability; Source/presentation not independent reusable truth.

Acceptance: exact type/applicability retrieval excludes unauthorized/stale and confers no permission; foundation implemented, optional domain consumer separate.

Acceptance: current revocation/input/pins, shadow-vs-activation/human-only, declared failure/default escalation/neutral/error, no fabricated result or uncertain replay, bounded probe no widening.

Acceptance: current agent-gate final Kernel/post-allow injection, human policy.write scope/lifetime/revision/activation/outcome distinctions and no recursive participant mediation.

Acceptance: joint Plan/domain, Task intersection, actual agent/on-behalf identities and author/anchor/time/use bounds, atomic once; wider unbuilt authority consumers separately limited.

Each migrated specialized row retains its original regression/mandatory checks; absent optional capability never declared implemented.

## Implementation

- `packages/policy-kernel/`
- `packages/protocol/`
- `packages/config-schema/`
- `packages/app-api-schemas/`
- `apps/nanocore/src/policy/`
- `apps/nanocore/src/auth/`
- `apps/nanocore/src/vault/`
- `apps/nanohost/src/`

## Implementation Gaps

- Model/context/result native families need actual owning registrations and common routing; placeholders do not establish implemented endpoints - not met on main - #373
- Complete transform-order -> attributable possibly parallel advice -> ordered gates -> final synchronous Kernel over admitted transformed proposal - not met on main - #373
- General returning external content uses actual ingress/disclosure operation before separate release; Core-held output is validated/bounded/redacted/rejected, never undoing an already completed external effect - not met on main; also #286 and #287 - #373
- Authorized author may narrow directly without a new human apply - not met on main - #627
- General delegated supervisor may widen inside envelope; outside-envelope/envelope changes and ordinary agent activation require owning human; observe/advice may widen disclosure - not met on main - #280
- General agent creation/domain administration supports accountable agent-creator/current-human propagation and explicit human reassignment under finite acyclic current chain; broken chain suspends grants without inheriting human rights or rewriting history - not met on main; also #664 - #152
- Coordinator can record narrowing by exception - not met on main - #628
- Accepted integrity.workspace.check uses audit.read and currently usable administrator; refuse ordinary nonadmin member/other callers before effect; integrity owner owns the unimplemented operation, #229 - not met on main - #229
- Complete native-fact/common-pipeline migration and future producer coverage beyond current MCP/Vault/primary subsets - not met on main - #373
- Universal immutable worker-policy snapshot of common-revision permission, binding, and delegation statements, scope and lifetime, Kernel version, assignments, associations, access-right mappings, Server and Workspace Policy, applicable User restrictions, and request-time restrictions, with file-backed inspectability and replay - not implemented; no snapshot file, store, format, migration, or replay - #807
- Full dynamic-change/stale/successor/interrupt policy across worker sessions; in-Sandbox Tool changes alone not interrupt; only newly denied high-risk ongoing external effect can require recycle - not met on main - #807
- Other resource administration, universal future AEP/session binding and complete backend compilation stay separate unimplemented integration, not invented current stores - not met on main - #807
- General impact/review reuse, external adapter and substantive-denial-circuit work remains later; retained formats do not activate it. Narrow assessment cache already exists; boot/resolver exclusions are intentional - not met on main - #412
- Full transform/advice safe-output pipeline and automatic review/delegated general narrowing acceptance cannot be claimed from native pilot tests - not met on main; also #627 and #628 - #373
- General external agent/model/third-party participants need admitted call/Pending contract and cannot write Core storage; current native seam not proof all adapters exist - not met on main; also #305 - #279
- Each active/migrated transform must retain and resolve exact safe original and replacement owner-version references, not just hashes/body in Audit; absent safe evidence blocks release and cannot justify secret retention - not met on main - #373
- Separate Turn circuit counts only substantive denials and has no current implementation/required deadline - not met on main - #807
- Later rebuildable read-only Decision Trace traversal from anchor upstream/downstream, per-node current access/no inaccessible metadata, explicit missing edges and no text/time/arithmetic/model fabricated joins - not met on main - #278
- Complete cross-owner missing-edge producer coverage for future traversal cannot be asserted from current known Policy/capture joins; missing original facts remain exact owner gaps - not met on main - #807
- Before decisive probability/confidence thresholds, calibrate on relevant own traffic and inspect shadow errors; no calibrated traffic evidence established by static code - not met on main - #807
- Lease declaration/consumer is not in current Policy union; Storage owner uses ordinary grants; no inactive shape/lease or new grant family inferred from plan - not met on main - #807
- Generic vendor-result advisor/transformer and Turn-output interceptor absent; only build at actual owned ingress/disclosure boundaries - not met on main; also #287 - #286
- Full fake-mode acceptance must prove observe/advice no veto/mutation, ungranted transform/gate cannot act and exact safe transform versions/final Policy; unavailable modes not claimed tested as executable - not met on main - #373
- All routed/built-in/projection participant invocation and open-circuit dispositions inspectable via existing durable safe evidence, no secrets/body retention. Universal coverage remains unimplemented - not met on main - #373
- Item projection: preserve existing specialized owner/checks; Existing item conversion/package records; no generic transform binding/evidence join. - not met on main - #373
- Assistant audience: preserve existing specialized owner/checks; Actual current audience/retrieval trace; no generic assistant-history-delivery registry point. - not met on main - #373
- Knowledge eligibility: preserve existing specialized owner/checks; Current source/conflict/type/audience filters; specialized retrieval evidence, not common gate invocation. - not met on main - #373
- Context preparation: preserve existing specialized owner/checks; Deterministic retrieval/preparation, not an agent or active advise provider. - not met on main - #373
- Worker package: preserve existing specialized owner/checks; Exact package/trace/digest exists; no active common transform output consumer. - not met on main - #373
- Task composition: preserve existing specialized owner/checks; Deterministic request/admission and Goal policy exist; generic transform migration not complete. - not met on main - #373
- AEP redaction: preserve existing specialized owner/checks; Immutable redacted snapshot exists; generic AEP participant transform not registered. - not met on main - #373
- Gateway enable/provider guard: preserve existing specialized owner/checks; Direct guards and durable decisions; call-bound record failure now blocks dispatch, not universally best-effort. - not met on main - #373
- Provider credential injection: preserve existing specialized owner/checks; Existing Core/Vault effect boundary; not active model-request participant transform/commit binding. - not met on main - #373
- Usage accounting: preserve existing specialized owner/checks; Original call/UsageRecord owner exists; no all-model-request common observation claim. - not met on main - #373
- Precommit/retry availability: preserve existing specialized owner/checks; Native availability/retry semantics, not a substantive Policy deny. - not met on main - #373
- Capture confidentiality: preserve existing specialized owner/checks; Specialized capture/observation owner; no generic model-result-ingress participant gate. - not met on main - #373
- MCP discovery filtering: preserve existing specialized owner/checks; Actual list/filter bounds and constraints; no full built-in-list invocation evidence pipeline. - not met on main - #373
- Built-in/result-size boundary: preserve existing specialized owner/checks; Specialized result admission exists; source path alone not proof common result-ingress gate/evidence. - not met on main - #373
- Artifact submission: preserve existing specialized owner/checks; Artifact/source/current-command owner exists; no general common work.artifact.submit gate join established. - not met on main - #373
- Artifact candidate selection: preserve existing specialized owner/checks; Exact candidate selection/decider semantics; future generic participant routing separate. - not met on main - #373
- Notebook validation/publication: preserve existing specialized owner/checks; Native validation/CAS/Git/Audit owner, not generic notebook participant evidence. - not met on main - #373
- Knowledge decision: preserve existing specialized owner/checks; Exact review/source/audience/primary mappings; no all-review common binding consumer. - not met on main - #373
- App writes: preserve existing specialized owner/checks; Native command/receipt/revision/Audit checks; generic write gate not activated by table label. - not met on main - #373
- MCP binding write: preserve existing specialized owner/checks; Original configuration/catalog mutation owner; no arbitrary participant administration pipeline. - not met on main - #373
- Configuration write: preserve existing specialized owner/checks; Generic file owners and special human policy.write path distinct; no all-configuration participant activation. - not met on main - #373
- Secret-shaped rejection: preserve existing specialized owner/checks; Mandatory schema validation remains; not a separately invocable participant or complete invocation evidence. - not met on main - #373
- Work question and Pending response: preserve existing specialized owner/checks; Original question/Pending/Item/current human response, no generic point registration from placeholder. - not met on main - #373
- Goal Plan approval: preserve existing specialized owner/checks; Exact joint Plan/domain response and native writer exist; no every-Plan participant gate migration. - not met on main - #373
- Discord disclosure/response: preserve existing specialized owner/checks; Trusted source/actor and original native response origin; channel sender not common registered participant pipeline. - not met on main - #373
- Audit producers: preserve existing specialized owner/checks; Existing scoped Audit and common pilot evidence; not every Audit producer is a policy participant observation. - not met on main - #373
- Scheduler admission: preserve existing specialized owner/checks; Native admission/current capability owner exists; generic participant integration separate. - not met on main - #373
- Recurring trigger/outcome: preserve existing specialized owner/checks; Original definition/occurrence native owner; not common recurring completed observation. - not met on main - #373
- Worker launch: preserve existing specialized owner/checks; Actual durable launch/checkpoint decision exists in native owner, generic participant routing not complete. - not met on main - #373
- Named read scope/audience: preserve existing specialized owner/checks; Current concrete Thread/source checks exist; placeholder source-read is not generic registered common gate. - not met on main - #373
- Skill candidate decision: preserve existing specialized owner/checks; Exact current candidate/decision/Audit/command owner; common optional preassessment remains #288. - not met on main - #288
- Source excludes grant issue/revoke from vault.admin. Main assigns grant administration to vault.admin; the source and the code disagree on grant administration; do not invent a metadata-only restriction and do not change authority in this specification - not met on main - #807
- Workspace-administrator Policy-writing scope - not implemented; the Workspace-shared Thread boundary exception remains a Workspace configuration operation - #675

## Decisions

- [Unified mediation and policy](../decisions/20261018-unified_mediation_and_policy.md)
- [BWM support and information consolidation](../decisions/20261018-bwm_support_and_information_consolidation.md)
- [Workspace export is administrator-only](../decisions/20261027-workspace_export_administrator_only.md)
