---
status: Accepted
---
# Permissions Model

This document defines OpenKit permission semantics.

This document owns authorization Policy concepts, evaluation inputs, permission decisions, mediation points, Policy administration, the Assistant disclosure boundary, and approval semantics.

This document does not own identity authentication, technical capability declarations, sandbox containment, audit projection shape, App API authorization endpoints, UI permission summaries, vault secret storage, or config-merge policy.

Permission is authorization. It answers whether a subject may perform an action on a resource under current policy and context.

Permission is separate from capability and sandbox.

Identity is authentication and actor identity. Permission consumes identity context but does not define users, auth sessions, tokens, or workspace membership.

## Purpose

OpenKit agents may be able to read files, write files, run commands, access network services, call tools, use credentials, query knowledge, create artifacts, or affect external systems.

The permission model gives Core a stable way to decide whether those actions are allowed.

## Principles

- Permission is separate from identity, capability, sandbox, and audit.
- Authorization decisions should be explainable, immutable, and attributable to a subject, action, resource, context, policy, and enforcement point.
- Approval may satisfy a Policy requirement; it is not the entire permission model. Human eligibility follows Administrator Eligibility and the responsible-user rule. An accepted automatic Policy grant remains a Policy grant, never a human decision. An agent approver requires separate bounded activation under Policy Administration; this design activates none.
- Multiple layers may enforce the same decision, but Core should remain able to explain the policy result.
- Policy details may evolve, but permission vocabulary should remain stable enough for audit, UI summaries, and agent capability control.
- OpenKit may implement only a subset of NGAC, but every implemented NGAC concept MUST match NGAC definitions, standard terminology, and described semantics. Product adapters MAY expose friendlier names, but Core policy doctrine MUST preserve NGAC as the long-term standard rather than creating a parallel OpenKit-specific authorization model.
- Workspace authorization is deny-by-default and uses current identity, membership, credential, and resource facts on every governed request.

## Initial Workspace Membership Baseline

An active member is eligible for the full operation set of their Workspace, including every Light App in it. This initial product baseline uses the existing Policy Kernel and does not require owner/editor/viewer grant ceilings, per-app roles, or collection/field ACLs. Membership is evaluated from current authoritative facts; invitations, removed membership and guessed identifiers do not grant Workspace content access. A currently usable administrator credential is eligible for every operation under Administrator Eligibility below, including where the caller has no Workspace membership.

Eligibility is not unconditional execution. Current credential restrictions, actor responsibility, lifecycle preconditions, disclosure boundaries, Vault grants, explicit Policy restrictions, and required human decisions still apply. Ownership may identify lifecycle continuity and recovery responsibility; it MUST NOT be used as an extra privilege tier for ordinary active-Workspace operations. User-private and deployment-scoped resources do not become Workspace resources through membership.

Future finer permissions use the same subject/action/resource/context and enforcement-point contracts, without requiring a new Light App authorization model or client-side role engine. They include permissions for agent members, where the product Coordinator grants permissions to the workers within its dispatch scope ([decision](../decisions/20260924-agents_are_workspace_members.md)). This is the target authorization baseline; implementation projections must identify any remaining role-based restrictions honestly.

## Personal Conversation And Scoped Learning

Thread placement inside a Workspace does not grant other members access to its private conversation, private-derived Artifact or personal context. Source read authority and destination audience remain separate decisions. Private ownership permits no declassification of another resource. Task and Goal work is Workspace-shared; private-to-shared handoff admits only explicit selected material. All discovery, search, event, notification, attachment, context and export paths apply the same current audience decision, including to protected metadata. The audience decision additionally admits a currently usable administrator credential under Administrator Eligibility below. Ordinary callers retain their existing source and audience requirements.

User Memory is readable and mutable by the current owning User through governed operations, and by a currently usable administrator credential under Administrator Eligibility below. Workspace Knowledge uses active membership and current resource policy. Server Knowledge uses deployment authority and is not an automatic corpus for every Workspace. A selected personal preference may influence authorized private work across Workspaces, but protected source facts retain their original restrictions. Sharing a Memory, Knowledge Page or Skill is an explicit source-to-destination promotion, not an effect of summary generation or installation.

Memory, Skill instructions, recalled decisions and AI assessments cannot grant permissions, bypass current target validation or resolve a pending approval or user-input request. Every management effect uses the requesting user's current authority. Optional AI evidence assessment is distinct from authorization and human Knowledge Review. Removal, forgetting or source revocation invalidates affected future reads, candidates and publication before deferred cache cleanup; separately published material retains its existing ownership and retention.

## Technical Administration

System operations and technical configuration that change deployment or runtime behavior require the requesting user's current usable administrator authority. In server mode that authority derives from their valid admin Token, including the identity owner's selected-token session projection; neither Workspace membership nor ordinary-user confirmation supplies it. Assistant and Operator act for that user, receive no Token secret and hold no independent privileged service identity. Each management call rechecks current authority, and revocation prevents later application even after an earlier proposal or confirmation.

The intended operator is the team's technical administrator or engineer. Ordinary members may request administrative help, but cannot approve system-level changes on that person's behalf. Technical administration covers host-code activation, deployment/runtime configuration, Provider setup, template authorship/publication, arbitrary image builds, runtime-policy changes and physical retained-storage purge; a Workspace-local target does not exempt these effects. Resource owners distinguish such effects from ordinary authored business content and selection of already admitted resources. This rule does not reclassify Skill content editing, catalog metadata, personal model preferences or ordinary Task/Goal resource selection as deployment administration. Their existing owners still govern admission, bindings and effects independently. A Coordinator selecting an eligible existing environment within an admitted workload does not edit the deployment's technical policy or acquire an admin credential. Workspace eligibility for that same administrator authority is Administrator Eligibility below, not a second permission model.

The identity owner's implicit local actor remains the local-mode administrator; the valid administrator-Token requirement applies to team/server-mode administration. Settling an already dispatched effect records what happened and requires its exact authenticated effect lineage, not a new user authorization. Revocation blocks new dispatch and application without preventing truthful settlement of an in-flight result.

## Shared Sandbox Resource Eligibility

Every current active Workspace member is eligible to list and inspect its shared Sandboxes, create from admitted templates, select and execute in them, rename them, stop their idle physical realization, and request administrator deletion, regardless of creator or contributor identity. Bounded compatible replacement uses the same resource eligibility. Current credential scope, policy, lifecycle and protected-source admission still apply. Only a currently usable administrator credential may purge retained storage or perform template/build/policy administration. Shared Sandbox membership does not authorize disclosure of private Core sources or grant another member's platform credentials. [User-Selected Workspace-Shared Sandboxes](../decisions/20261008-user_selected_workspace_shared_sandboxes.md) records the accepted sharing and deletion boundary; administrator eligibility below remains applicable without impersonation.

A Workspace-shared Sandbox admits its retained working and native data to current and future Workspace members; creator identity and work-slot names provide no confidentiality boundary. Private or otherwise narrower source data may enter only through its source owner's explicit authorization to that destination audience. Membership loss blocks future governed access but cannot retract previously disclosed bytes.

A user-placed secret or credential file inside a shared retained volume is readable and writable by other admitted members and is not protected as a personal Vault secret. The system must disclose that consequence and must not import those bytes as platform authority, promise secret detection or automatic sanitization, or claim that another member cannot use copied credentials externally. OpenKit-managed secrets, route tokens and control material remain outside retained volumes under their existing owners; incompatible credential exposure still refuses co-residency. The accepted user-file disclosure, rather than platform-credential sharing, is recorded in [User-Selected Workspace-Shared Sandboxes](../decisions/20261008-user_selected_workspace_shared_sandboxes.md).

## Administrator Eligibility

A currently usable administrator credential is eligible for every operation, including operations on other users' resources. The credential is the administrator's Web session or an administrator bearer. The authority follows the administrator, not the credential kind. This is one rule in the existing authorizer, not a second permission model. The ruling is recorded in [Administrator Authority](../decisions/20261002-administrator_authority.md). The Policy Kernel later refines this authority with fine-grained policy.

That eligibility includes recovering a resource another user deleted, reading other users' private Threads and private-derived content, answering approvals raised to other users, archive export and import of any Workspace, and managing the administrator's own access tokens.

Attribution stays truthful. Audit and request lineage record the administrator as the actor. They never impersonate the affected user. A recovered resource returns to its original owner.

Per-effect authority objects still exist and are checked. Approval records and Vault grants are examples. The administrator may create or issue them. An answered approval records the administrator's decision.

Credential limits and the sandbox boundary are unchanged. A read-only credential stays read-only. Revocation and expiry apply. The sandbox boundary applies to every actor.

The administrator must be an active user, and the credential's scope, ownership, and lifetime must still match. Merely owning an administrator Token, without authenticating through the administrator's current Web session or presenting an administrator bearer, supplies no administrator-derived eligibility. An internal or recurring trigger does not inherit an unpresented administrator credential. The rule does not manufacture Workspace membership.

## Boundary

Permission owns policy and authorization decisions.

Capability describes what an actor can technically do.

Sandbox constrains what the runtime can actually reach.

Identity supplies the subject.

Approval is a decision step by the approver that may satisfy a permission requirement under Policy. It MUST NOT override a stronger mandatory result. Human approval eligibility follows Administrator Eligibility and the request's responsible-user rule. No agent approver is activated. Requiring approval does not pause the requesting work: the request stays pending, without a default deadline, until it is resolved or ended, as `docs/core/protocol.md` defines.

The product UI may display permission summaries, but it should not become the policy engine.

## Concepts

Permission evaluation needs these conceptual parts:

- subject
- action
- resource
- context
- policy
- decision
- enforcement point
- audit record

The policy model decision is settled: OpenKit uses an NGAC-standard-aligned subset model evaluated by the policy kernel. This document stays model-neutral in its concept vocabulary so the conceptual parts above remain stable even if the kernel evolves.

The policy kernel MUST be treated as an NGAC-standard-aligned subset implementation, not a separate OpenKit-designed policy language. Missing NGAC features are acceptable when they are explicitly out of scope, but implemented features MUST NOT redefine NGAC concepts.

## Subject

`Subject` identifies the principal whose authority is evaluated, the actual actor, the process when present, and an optional on-behalf-of principal. A principal may be a human User or an agent identity. A direct human call need not have a process; Core MUST NOT invent a Turn. Agent-executed work records its actual process.

An agent principal has its own attributes and grants, records a responsible human, and derives authority only from grants traceable to a human-approved domain. It MUST NOT implicitly inherit that human's rights or satisfy a human-only decision. When an agent acts for a User, the principal is the User, the actor is the agent, and effective authority is the User's rights intersected with the agent's restrictions. Record both identities and the credential kind. NGAC user elements represent identified principals, including agents; they do not imply human identity.

Creating an agent principal or granting it a domain MUST use an administration operation that records its creator and responsible human. An agent creator passes on the terminal human from its own responsibility chain unless a human explicitly assigns another. Every responsibility chain MUST be finite, acyclic, and end at one specific human.

At evaluation, the Kernel MUST check that the terminal human remains current and authorized over the domain. A broken chain, removed human, or lost domain authority suspends the agent's grants and fails closed until a human reassigns responsibility. This accountability condition supplies no inherited human rights. Decisions MUST retain the agent principal and responsible human resolved at decision time. Reassignment MUST NOT rewrite historical decisions.

Subject context may include:

- user
- workspace member
- deployment administrator
- agent
- profile
- AgentSession
- automation
- runtime mediation service
- external integration

An agent action MUST preserve its principal, actual actor, actual process, responsible human, and any on-behalf-of or automation context.

## Action

`Action` is the operation being requested.

Examples:

- read workspace file
- write workspace file
- delete artifact
- run shell command
- access network endpoint
- call MCP tool
- use vault reference
- read knowledge
- write proposed knowledge
- start AgentSession
- approve escalation

## Resource

`Resource` is what the action affects.

Examples:

- workspace
- thread
- turn
- item
- artifact
- file path
- knowledge entry
- vault reference
- model profile
- `AgentManifest` reference (`docs/core/agent-supply.md`)
- external service
- sandbox backend

Resources should be scoped by workspace unless explicitly global or shared.

## Context

`Context` contains decision inputs that are not just subject, action, or resource.

Examples:

- current workspace
- current membership status and Policy facts
- token scope and Workspace binding
- agent identity
- AgentSession status
- turn status
- approval state
- requested sandbox mode
- time
- network target
- file path pattern
- sensitivity label
- automation source

## Decision

`PermissionDecision` is the closed product-level result of policy evaluation. Its result is exactly one of:

```text
allow
deny
require_approval
require_escalation
defer
not_applicable
error
```

No other result value is permitted. A decision result combines with other mandatory policy inputs under this deterministic precedence, from strongest to weakest:

```text
error
deny
require_escalation
require_approval
defer
not_applicable
allow
```

Missing mandatory facts or a mandatory evaluation failure produce `error` and fail closed. Before applying the precedence, `not_applicable` inputs are neutral and are omitted when at least one mandatory policy domain applies. The combined result is `not_applicable` only when every input is `not_applicable`; that result blocks the effect because no applicable authority allowed it. The result is `allow` only when every applicable mandatory input is `allow`.

Only a final combined `allow` authorizes the effect. `deny`, `require_approval`, `require_escalation`, `defer`, `not_applicable`, and `error` all block it until an existing owner produces a new authorized evaluation where applicable. The distinct result explains why the effect is blocked; `not_applicable` never grants access.

`PermissionDecision` and its categories define the target bridge between policy evaluation, product workflow, approval, and audit.

A decision should be explainable and auditable.

Typical record areas include:

- permission decision ID
- workspace ID
- subject summary
- action
- resource summary
- context summary
- policy reference
- policy snapshot reference when available
- enforcement point
- decision
- reason code
- approval request ID when required
- timestamp
- request ID when available

Permission decision records should be immutable. A later policy check should create a new decision record rather than rewriting the prior decision.

## Enforcement Points

A mediation point is an operation at a stage on a Core-controlled effect or content crossing. Core MUST hold proposed effects or crossing content until the required decision permits release. Its identity MUST be `<operation>@<stage>`. The stages are `propose`, `decide`, `commit`, and `completed`. Core MUST extend the existing operation registry to non-API operations rather than create a separate point registry. The [unified mediation and Policy decision](../decisions/20261018-unified_mediation_and_policy.md) records this design.

The access dimensions are subject, operation, and object. The subject follows Subject above; the principal and actual actor MUST remain distinct when an agent acts for a User. Stage, insertion mode, and participant with its acting authority complete the dimensions. Crossing type, effect class, sensitivity, and static risk are attributes, not substitutes for those dimensions. Advice may attach dynamic risk to one exact proposal; an assessment MUST NOT grant authority.

The built-in crossing attributes are `admission`, `disclosure`, `dispatch`, `ingress`, `mutation`, `administration`, and `decision`. An interaction can cross several points. A tool dispatch, its returning result, and disclosure of that result require separate checks at their actual boundaries. Calls inside a wrapper retain their own dispatch checks.

Gate and transform participation MUST have explicit Policy authority. Core MUST order pre-decision work as transform, advise, gate, then the mandatory final Policy Kernel evaluation. Transform retains original and replacement through their existing content owners. Advice supplies proposal attributes. Gate results combine with the mapped Kernel result under Decision's closed precedence. A point with no bindings uses its existing permission check. The Kernel MUST remain pure and synchronous, with only low-level allow or deny results.

Only a final combined `allow` permits the commit stage. Commit obligations include the owner's write or send and Core-only credential injection. Injection MUST bind to the approved target, account, and action after the final allow. Participants MUST NOT receive secrets. Completed-stage observation cannot grant or undo the effect; returned content enters its own ingress point.

Each operation MUST declare permitted modes and provider kinds. Boot admission and centralized Workspace access resolution accept no participant bindings. Participant invocation and a participant's investigative calls use Kernel-only checks without bindings. These exclusions bound mediation depth to one level. The owning human's root decision is not itself mediated by participants.

### Policy Statements And Administration

Permissions, participant bindings, and envelopes or delegations MUST share one versioned Policy authority and snapshot. One revision pins all three statement kinds for evaluation. A binding is a Policy statement, not a separate hook configuration or grant store. Gateway tool rules and storage leases remain permission statements or grants in that same owner.

A binding MUST name its point selector, scope, lifetime, mode, participant, order, failure behavior, shadow or active state, input disclosure scope, version, author, and delegation. Creating or changing it uses the governed `policy.write` administration operation. Input disclosure authority MUST be decided when the binding is written. Invocation rechecks current authority with the Kernel only and minimizes disclosed inputs. Instructions and authorization sources MUST remain distinct from untrusted evidence.

Supervising agents MAY author per-agent and per-action Policy only inside their current human-approved delegation. Narrowing by an authorized author may apply directly. Delegated widening inside the approved envelope may apply under that delegation. Widening outside it, changing the envelope or delegation, and activating an agent approver require the owning human. Adding observe or advise participation widens disclosure and follows the same review path. A Worker may suggest a change but MUST NOT apply it. No principal may approve a change that widens its own authority.

Every Policy change MUST retain the proposal diff, proposer, rationale, affected scope, lifetime, validation, widening classification, deciding authority, and activation revision. Validation and a saved proposal MUST remain distinct from committed active Policy. Missing, conflicting, stale, revoked, or unevaluable authority MUST block activation. Retry and restart MUST inspect current revision and recorded outcome rather than replay an approval or unknown write.

An agent approver is a gate participant with its own read-only investigative grant. It MUST run in shadow before the owning human explicitly activates a bounded class after inspecting shadow evidence. Its output is allow, deny, or escalation to a human, with risk, authorization assessment, and rationale. It MUST NOT approve its own binding or envelope, increase its authority, recursively request approval, impersonate a human, or satisfy a human-only decision. The [BWM support decision](../decisions/20261018-bwm_support_and_information_consolidation.md) records the preceding agent-native direction.

Timeout, malformed result, unavailability, and an open participant circuit MUST remain explicit failures. The binding selects human escalation by default, continuation only for non-decisive work, or error. Continuation contributes neutral `not_applicable`; it MUST NOT manufacture allow or deny. Retries MUST stay within one bounded deadline. An unresolved required gate MUST NOT release the effect.

### Delegated Goal Domain And Statement Lifetime

Plan approval creates the Goal's delegated Policy domain: its Workers, resources, and approved rights. The Coordinator administers that domain. A Task's Worker inherits the envelope intersected with the resources on its Task card; the Coordinator may narrow by exception.

A missing grant with reason `not_granted` inside that envelope escalates to the Coordinator. The Coordinator may extend the Task or Goal container once within its delegation, then Core MUST rerun authorization. A prohibition with reason `prohibited` blocks the effect. A requirement with reason `require_approval` remains a distinct approval condition. Outside the envelope, the owning human must decide a Plan revision. Coordinator grant administration is distinct from an agent approver satisfying an approval condition.

Scope defines whom and what a statement applies to. Lifetime is a separate attribute with a container anchor, optional expiry, and optional use count. The anchor may reference any container; there is no closed lifetime enum. The statement ends when its anchor closes, expiry passes, uses are consumed, or its author's authority ends. No cleanup job supplies that authorization boundary.

Once means one use, consumed atomically by the allowing decision. A once-only approval creates no Policy change. An unbounded lifetime anchored on the scope owner means persistent authority until revocation or that owner's closure. A Coordinator may choose any lifetime within its Goal domain, but its statements MUST end with that domain at the latest. Longer authority requires promotion approved by the domain's owning human. Choose the narrowest anchor or bounds that cover the reason, rather than only the current call. Repeated same-reason grants across Goals may become a Workspace proposal for the human.

### Mediation Acceptance

An unauthorized transform, participant disclosure, Policy widening, or credential injection MUST be refused before release. Changed proposals, revisions, or participant bindings MUST invalidate prior assessments and approvals. Immutable historical decisions remain evidence, not current grants. Observe and advise MUST never become authorizing results. Deferred post-success Policy reactions do not authorize a present effect.

Permission checks should happen at enforcement points.

Examples:

- centralized Workspace access resolution before a Workspace-addressed handler reads or mutates state
- app API command handler
- Core scheduler
- agent adapter
- agent capability gateway projection
- runtime mediation boundary
- vault access boundary
- filesystem operation boundary
- sandbox startup boundary

The same policy decision may be enforced at multiple layers. Sandbox enforcement is still valuable even when permission policy already denies an action. Inside its Sandbox a worker has full permission; approval and audit apply to Gateway-mediated interaction with external systems at the Sandbox boundary and the Gateway, not to in-Sandbox tools or configuration, and native runtime permission prompts are not part of the permission model. Storage and network containment still apply at the Sandbox boundary. External routing follows [Sandbox](sandbox.md). NanoCore-managed supply and the upward interface remain Gateway-mediated; separately authorized non-LLM REST grants retain their existing network and credential contracts. Admission of that class does not exempt an action from policy-required approval or audit.

## Approval Gates

Approval gates are permission-related but not identical to permission.

The target model is that policy decides an action requires user approval, and after approval Core records which policy requirement the approval satisfied.

Approval strength MUST follow reversibility and blast radius rather than the operation category:

| Effect class | Required decision |
| --- | --- |
| Reversible, low-cost, internally scoped, and unambiguous | One-step commitment that states the exact target and effect, returns the authoritative outcome, and identifies an available correction or undo path. |
| Materially consequential but recoverable | Explicit preview of the exact target and resulting state before commitment. |
| Irreversible, externally visible, credential-bearing, authorization-changing, or cost-material | Distinct explicit confirmation that states what cannot be undone, plus every additional decision required by the owning safety, permission, cost, credential, or external-effect contract. |

Ambiguity about the target or effect raises the required decision by one level. Approval does not bypass current authorization, and an approval that satisfied an earlier evaluation does not authorize an effect after the actor, target, policy, resource, or relevant state changes. A granted governed call is re-evaluated against current facts immediately before it executes, and the requester does not re-issue the call to use the grant.

The approval MUST bind to the admitted post-transform proposal digest and the Policy and authorization revisions. A change invalidates that binding. Once-only approval creates no Policy statement; longer authority requires the Policy Administration path and its scope and lifetime.

The required decision exists for one proposed effect and terminates when the effect is accepted or rejected, when an invalidating event ends the request, or when it is replaced. It has no default time expiry; staleness is disclosed to the approver and enforced by re-evaluation at execution. Retry after rejection, invalidation, staleness, conflict, restart, or dependency failure requires a new current authorization evaluation and, when still required, a new approval; Core MUST NOT replay the earlier approval as ambient authority.

Conformance is observable when low-consequence reversible effects can complete through the one-step form, materially consequential recoverable effects expose their preview before commitment, and irreversible or authority-changing effects cannot apply without the distinct confirmation and every owner-required additional gate.

## Assistant Disclosure Authorization

`AssistantReadScope` and `OutputAudience` are separate permission decisions for every Assistant answer and every proposed transfer of Assistant-produced material. Across all model paths, previews, names, digests, snippets, counts, and diagnostics are disclosures. Recheck source access and destination disclosure on search, reads, downloads, history, and exports. Filter before index-generation access and ranking. A running Turn may retain its admitted local snapshot, but later OpenKit operations and Turns acquire no frozen authorization. [Large Files And Model Context](../decisions/20261015-large_files_and_model_context.md) records this boundary.

`AssistantReadScope` is the exact set of sources and source revisions that the current actor may discover or retrieve for the current request. It is bounded by current identity, Workspace membership, resource visibility, source policy, requested operation, sensitivity, and every other applicable permission input. It grants no write, promotion, publication, notification, worker-context, or external-effect authority.

`OutputAudience` is the exact destination and set of recipients authorized to receive the output. It is resolved independently of the requesting actor's read authority and before output-producing context is assembled. A requester who may read material privately does not thereby authorize that material, its protected metadata, or a derived summary to reach a shared Thread, Artifact, Knowledge record, Worker context, notification, or external destination.

The permission owner is the unique durable authority for both decisions. Assistant role assembly may project the resulting scope and audience into a bounded Turn input, and publication may project the decision into a destination-specific Item or effect, but neither projection may widen the current permission decision or become an authorization cache.

### Evaluation And Publication Lifecycle

For every Assistant request, Core MUST resolve the destination and `OutputAudience` before assembling the output-producing model context. Candidate discovery MUST expose only metadata already eligible for both the current actor and destination. Every concrete source read MUST then create a current authorization evaluation over the actor, source, Workspace, revision, operation, and destination audience before returning material to the model.

Retrieved material MUST retain source identity, provenance, visibility, freshness, and disclosure constraints through context assembly and response generation. Material outside the resolved `OutputAudience` MUST be excluded before generation; post-generation redaction is not the primary confidentiality boundary.

Immediately before a durable or shared output is published, Core MUST reauthorize the destination and material as a defense-in-depth publication guard. The guard may publish the eligible answer, require an explicit typed promotion or sharing decision, redirect the result to an authorized owner-private destination, or fail closed. It MUST NOT silently remove a material restriction and publish the remainder as though the original answer had been authorized.

A Tool's presence means only that the model may request its operation. It is never evidence that the current actor, source, target, audience, or effect is authorized. Every Tool call MUST perform the current owning permission and resource checks, including when a granted call is executed after approval, and after warm-provider reuse, retry, or restart. A call that needs approval returns a pending result through its Tool result rather than executing. A present Tool whose call is refused returns a product-safe typed refusal reason through its owning Tool result; permission denial MUST NOT be represented by removing that Tool from an otherwise reachable entry path.

Any transfer from an owner-private or otherwise restricted source into a durable or broader audience MUST use an explicit typed promotion that identifies the selected source material, destination, audience, provenance, required confirmation, and authoritative outcome. A generated summary is not declassification, and the actor's authority to read the source is not authority to promote it.

### Conflict, Failure, And Recovery

Missing actor, source, destination, audience, membership, revision, visibility, or mandatory policy facts fail closed. Authorization loss, source deletion, audience change, policy change, or a stale source revision invalidates the affected read or publication decision immediately for later calls.

If the source or destination changes during generation, the publication guard evaluates current truth and refuses, redirects, or requires a new explicit promotion; it never relies on the earlier model-input decision to publish. A dependency failure or indeterminate authorization result produces `error` or the applicable blocking `PermissionDecision`, not a partially authorized answer.

Restart and retry reconstruct `AssistantReadScope` and `OutputAudience` from current durable owners. Cached provider context, cached summaries, prior Tool results, and prior permission or approval records cannot restore access after revocation or supply missing authority. An already published Item follows its own accepted visibility and retention owner; the permission model does not rewrite history to simulate revocation.

Conflicting human requests remain separate attributed requests. Permission evaluates the current actor and state for each request and does not decide which human is socially correct; ordinary command ordering, stale-state rejection, and the owning resource lifecycle decide whether a later authorized command can change current state.

### Acceptance Predicates

- The same request MAY produce a richer answer in an owner-private Thread than in a shared Thread, and the difference is explainable from the resolved scope and audience.
- Material, protected metadata, or a derived summary from a source unavailable to the destination audience MUST NOT enter that audience's model output, Item, Artifact, Knowledge record, Worker context, notification, or external effect.
- Tool presence, an earlier approval, a warm provider context, or a successful prior call MUST NOT bypass current per-call authorization.
- A restricted-to-broader transfer MUST leave one explicit typed promotion outcome with source, destination, audience, provenance, actor, and request lineage.
- Revocation, stale revision, missing policy input, restart, or publication-time conflict MUST fail closed without publishing a success-shaped result.

## Audit

Permission-sensitive actions should leave audit records.

Audit records should preserve:

- subject
- action
- resource
- context summary
- decision
- enforcement point
- approval reference when present
- timestamp
- outcome

Audit records must not leak secret values.

Detailed audit semantics belong to `docs/core/audit.md`.

## Invariants

- Permission MUST NOT be collapsed into capability, sandbox, identity, or approval.
- Implemented policy-kernel concepts MUST remain semantically consistent with NGAC. If product vocabulary needs different names, the mapping belongs in adapters rather than in the kernel concept definitions.
- Permission decisions SHOULD preserve subject, action, resource, context, policy reference, enforcement point, outcome, reason, and request correlation when those fields are available.
- Permission-sensitive actions SHOULD leave audit records or enough metadata for future audit projection.
- Approval records MUST NOT be treated as a complete permission engine unless a policy requirement explicitly links the approval to an authorization decision.
- Product UI summaries MUST NOT become the policy source of truth.
- Workspace membership and any future product-role vocabulary MUST be projected into the Policy Kernel rather than enforced by a second handler-local role engine; the current adapter uses one active-member association, while ownership is a lifecycle identity rather than a permission ceiling.
- Invitation state, filesystem presence, owner-nested paths, and token scope alone MUST NOT grant Workspace access.
- A currently usable administrator credential is eligible for every operation under Administrator Eligibility. Credential validation, per-effect authority objects, truthful attribution, read-only limits, revocation, expiry, and the sandbox boundary stay in force. Merely owning an administrator Token, without authenticating through the administrator's current Web session or presenting an administrator bearer, supplies no administrator-derived eligibility.
- Missing actor, responsible-user, required membership or currently usable administrator credential, resource, token-binding, or required policy facts MUST fail closed.
- `AssistantReadScope` MUST NOT imply `OutputAudience`, and `OutputAudience` MUST NOT imply source-read authority.
- Assistant source reads and publication MUST be reauthorized at their enforcement points; Tool presence and prior approval MUST NOT be treated as authority.
