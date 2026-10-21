---
status: Accepted
---
# Mediation

This document defines OpenKit mediation semantics for operation definition and invocation, worker capability supply, and internal-role Tool projection.

Mediation is the single interception base across OpenKit: operations and governed runtime capability paths are invoked across `<operation>@<stage>` mediation points, supplied to worker agents during execution, or projected as exact Tools to NanoCore-internal roles.

This document owns the semantic definition and invocation procedure of an `Operation`, mediation points (`<operation>@<stage>`), the Capability Mediation Boundary, runtime capability access, `CapabilityCall`, gateway projection, internal-role Tool identity and admission, transformer selection, credential injection contracts, context access paths, gateway-mediated usage production for a `CapabilityCall`, routing, gateway audit metadata, rate limits, quotas, and provider/tool error normalization.

This document does not own agent supply declarations, reusable knowledge semantics, task-time context package semantics, global audit projection, permission policy, sandbox containment, or `UsageRecord`, usage units, usage attribution, and system-wide metering (`docs/core/evidence.md`).

## Purpose

Agents may need LLM providers, MCP servers, tools, network access, external APIs, knowledge-base retrieval, context injection, vault-mediated credentials, or other privileged services.

Mediation gives Core a stable model for defining, invoking, supplying, routing, transforming, authorizing, metering, rate-limiting, and auditing those calls.

For worker execution, it is part of the broader agent supply domain: `agent-supply.md` declares what a worker agent may need, `mediation.md` governs the runtime capability paths supplied during execution, and `agent-session.md` records the live or resumable execution handle that consumes those paths. Internal Core roles have no worker AgentSession; this document governs their exact Tool projection, admission boundary, and operation invocation seam.

## Principles

- Mediation is the single interception base for operation invocation and for supplying capabilities to worker agents, not the declaration that an agent can do something.
- Gateway projection is the target realization for capabilities that need routing, policy, metering, audit, credential injection, or upstream error normalization.
- Capability calls that are product-visible should remain item-backed; infrastructure calls may stay in capability, usage, and audit records.
- Credential injection must use vault-mediated paths and must stay outside prompt context.
- Mediation usage and audit should be related but separate: usage measures consumption, audit explains action and governance.

## Boundary

Capability describes what can technically be supplied or used.

Mediation describes how operations and capabilities are defined, invoked, intercepted, supplied, and routed.

Policy decides whether a capability or operation may be used in the current context.

Vault supplies credential references and approved injection paths.

Sandbox constrains which endpoints, processes, files, networks, and injected resources an agent can reach.

Communication defines the capability plane used to carry calls.

Agent supply declares requested capability categories and setup requirements.

The gateway is the target implementation projection for agent capabilities that require mediation. A worker environment MUST advertise capability routes explicitly; an environment whose capability plane is disabled has no implicit capability access.

The gateway owns routing, transformer pipeline selection, credential injection contract, gateway audit metadata, usage metering, rate-limit hooks, budget checks, and upstream error normalization for gateway-mediated calls.

Gateway interception MUST use the common NanoCore mediation contract: providers may observe, advise, gate or transform, with Policy authority required for gate/transform and a final current Policy check before effects. Safe input/output version references and durable invocation evidence reuse existing owners; no provider gains credentials or runtime authority from installation. The [BWM support decision](../decisions/20261018-bwm_support_and_information_consolidation.md) records this Not Started unification, including unavailable timeout/circuit outcomes rather than fabricated permission decisions.

## Operation

When a resource family is cut over, the accepted target applies. Built-in worker MCP Tools and internal-role Tools are derived from the one semantic definition of the public operation and execute through its invocation seam. Trusted entry assembly and worker supply assembly keep capability admission and their immutable selections. Actor, execution lineage, entry scope, the private Turn, and command identities an owner derives come from the invocation context. The model-facing schema omits those bound fields. A conflicting argument is rejected before any effect. The ruling is recorded in [Operation Definition Rulings](../decisions/20261002-operation_definition_rulings.md). This document owns that semantic definition and invocation procedure.

## Enforcement Points

A mediation point is an operation at a stage on a Core-controlled effect or content crossing. Core MUST hold proposed effects or crossing content until the required decision permits release. Its identity MUST be `<operation>@<stage>`. The stages are `propose`, `decide`, `commit`, and `completed`. Core MUST extend the existing operation registry to non-API operations rather than create a separate point registry. The [unified mediation and Policy decision](../decisions/20261018-unified_mediation_and_policy.md) records this design.

The access dimensions are subject, operation, and object. The subject follows [Policy Subject](policy.md#subject); the principal and actual actor MUST remain distinct when an agent acts for a User. Stage, insertion mode, and participant with its acting authority complete the dimensions. Crossing type, effect class, sensitivity, and static risk are attributes, not substitutes for those dimensions. Advice may attach dynamic risk to one exact proposal; an assessment MUST NOT grant authority.

The built-in crossing attributes are `admission`, `disclosure`, `dispatch`, `ingress`, `mutation`, `administration`, and `decision`. An interaction can cross several points. A tool dispatch, its returning result, and disclosure of that result require separate checks at their actual boundaries. Calls inside a wrapper retain their own dispatch checks.

Gate and transform participation MUST have explicit Policy authority. Core MUST order pre-decision work as transform, advise, gate, then the mandatory final Policy Kernel evaluation. Transform retains original and replacement through their existing content owners. Advice supplies proposal attributes. Gate results combine with the mapped Kernel result under [Decision's closed precedence](policy.md#decision). A point with no bindings uses its existing permission check. The Kernel MUST remain pure and synchronous, with only low-level allow or deny results.

Only a final combined `allow` permits the commit stage. Commit obligations include the owner's write or send and Core-only credential injection. Injection MUST bind to the approved target, account, and action after the final allow. Participants MUST NOT receive secrets. Completed-stage observation cannot grant or undo the effect; returned content enters its own ingress point.

Each operation MUST declare permitted modes and provider kinds. Boot admission and centralized Workspace access resolution accept no participant bindings. Participant invocation and a participant's investigative calls use Kernel-only checks without bindings. These exclusions bound mediation depth to one level. The owning human's root decision is not itself mediated by participants.

Participant bindings are Policy statements administered under [Policy Statements And Administration](policy.md#policy-statements-and-administration), with lifetimes governed by [Delegated Goal Domain And Statement Lifetime](policy.md#delegated-goal-domain-and-statement-lifetime).

Timeout, malformed result, unavailability, and an open participant circuit MUST remain explicit failures. The binding selects human escalation by default, continuation only for non-decisive work, or error. Continuation contributes neutral `not_applicable`; it MUST NOT manufacture allow or deny. Retries MUST stay within one bounded deadline. An unresolved required gate MUST NOT release the effect.

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

The same policy decision may be enforced at multiple layers. Sandbox enforcement is still valuable even when permission policy already denies an action. Inside its Sandbox a worker has full permission; approval and audit apply to Gateway-mediated interaction with external systems at the Sandbox boundary and the Gateway, not to in-Sandbox tools or configuration, and native runtime permission prompts are not part of the permission model. Storage and network containment still apply at the Sandbox boundary. External routing follows [Sandbox](sandbox.md). [Routing](#routing) below owns the managed-supply route and REST exception; each crossing still requires its current Policy decision. Admission of that class does not exempt an action from policy-required approval or audit.

## Capability Mediation Boundary

A future capability mediation component may project Core capability services into a worker environment when the runtime cannot call those services directly.

The component is communication substrate, not the agent runtime, worker-control path, or business-logic owner.

Mediation responsibilities may include:

- expose local capability endpoints to the agent
- establish or accept a secure connection according to the deployment strategy
- forward capability requests
- apply Core-owned transformer pipeline decisions
- support vault credential injection outside agent context
- forward audit metadata
- surface upstream failures as standard errors

Mediation non-responsibilities:

- choosing models
- deciding provider fallback
- owning rate limits
- deciding which tools are visible
- deciding which capabilities exist or remain available
- persisting sensitive responses
- owning product, workflow, or approval state
- deciding permission policy
- owning credentials, metering, or usage attribution
- implementing business logic

A capability mediation responsibility is not a worker-control owner and not a worker agent. The same outer transport projection or process MAY also carry a separately authenticated worker-control plane, but the capability mediation responsibility MUST NOT inspect, authorize, synthesize, retry, or reinterpret worker-control messages. Co-location and shared carriage MUST NOT change which participant owns a decision. [Communication](communication.md#capability-mediation-boundary) owns the transport projection of this boundary.

## Capability Call

`CapabilityCall` is a conceptual record for one call through an agent capability route or gateway projection.

Typical record areas include:

- workspace ID
- thread ID
- turn ID
- AgentSession ID
- capability ID or route
- request ID
- upstream provider or service summary
- vault reference IDs used, if any
- transformer pipeline summary
- usage summary
- status
- stable error code when failed
- timestamps

These are model areas, not a complete field list.

The closed terminal `CapabilityCall` status vocabulary is:

```text
succeeded
failed
denied
aborted
timed-out
interrupted
unknown
```

An implementation MAY use private non-terminal state while a call is active, but every completed call MUST project exactly one of these terminal statuses.

`interrupted` means execution is known to have stopped without a complete capability result. It does not prove whether an external effect happened. `unknown` means that, after a crash or loss of proof, the external effect result itself cannot be established. An `unknown` call MUST NOT be replayed automatically; only external inspection or reconciliation may establish what happened, and any later attempt is a fresh authorized request. Neither status may be collapsed into successful completion or used to settle an uncertain external effect.

## Relationship To Items

Capability call records are not a substitute for the item log.

Product-visible capability calls MUST produce or be referenced by item-backed events, usually through a `tool-call`, `command-execution`, `artifact-event`, `context-injection`, or status item.

Infrastructure capability calls MAY be recorded only as capability call, usage, and audit records.

Examples of infrastructure calls include knowledge retrieval routing, internal provider health checks, gateway metadata lookup, and transformer pipeline setup.

This rule keeps user-visible history in the item log while allowing high-volume infrastructure calls to remain out of the conversation transcript.

## Gateway Projection

The unified gateway is the target implementation projection for agent capabilities.

The gateway provides stable local or protocol-level endpoints for LLM, MCP, tool, network, context, and credential-mediated calls while Core retains routing, policy, metering, audit, and rate-limit control.

In local deployments, the gateway may be a Core-local service, loopback endpoint, adapter hook, or in-process provider dispatcher.

In container or remote deployments, the gateway may be projected into the agent environment through a network proxy, runtime adapter, or managed service.

Capability projection is independent from worker control. A direct worker-control connection MUST NOT imply that any capability route exists, and a future capability gateway MUST NOT become a control relay.

Agents should depend on stable capability routes, not provider-specific routing logic.

## Routing

Agent capability routing may consider:

- workspace policy
- agent supply declarations
- model profile
- MCP or tool catalog entry
- network target
- requested context source
- user or automation identity
- sandbox mode
- cost or usage budget
- provider health

Agents should see stable local or protocol-level endpoints instead of provider-specific routing logic.

NanoCore-managed supply and the upward interface remain Gateway-mediated; separately authorized non-LLM REST grants retain their existing network and credential contracts.

## Internal Role Tool Identity And Admission

Every internal-role Tool has one governed canonical semantic ID and the same mechanically derived model name wherever it is supplied. The accepted [agent-facing naming decision](../decisions/20261017-agent_facing_naming.md) identifies the operation-identity owner for grammar, projection, length and collision checks. A Tool that projects an operation uses that operation's actual ID. Internal roles expose capabilities for their accepted product responsibilities; they do not acquire a general Worker harness by importing an installed MCP server's Tool catalog.

The canonical verb vocabulary is: `search` returns bounded candidates; `read` resolves one exact target or source; `create` creates a schema-defined resource; `update` changes an exact resource under its owner's preconditions; `delete` requests the owner's explicitly defined removal or retirement; `start` requests an explicit mode handoff; `propose` submits a candidate for authoritative acceptance; `dispatch` requests execution admission; `respond` answers one exact owned request; `cancel` requests termination through the owning control contract; `request` creates an owned attention request; and `report` submits a state claim to its owner. Broad verbs such as `manage`, `execute`, `act`, `mutate`, and `send_message` MUST NOT conceal target, effect, delivery, or authority. A transaction operation may use `dispatch` only for a closed owner-defined typed transaction, never arbitrary commands or executable code.

The Knowledge Manager's `knowledge.notebook-workspace.update` is a narrowly owned exception for interpreted command text over a private unpublished virtual notebook. Its code-owned command set has no host process, host filesystem, network, credentials or general interpreter access. `knowledge.notebook.update` separately requests the exact-base notebook publication under current authority. Both use their resource owner's bounded schemas; neither grants generic shell execution or widens other internal roles.

Internal capability implementations MUST preserve the admitted Core contract for schema, effect, scope, and required confirmation. Implementation selection MUST NOT widen internal-role eligibility.

A namespace is an organizational and semantic boundary, not a capability hierarchy. Admission of one exact ID grants neither sibling IDs, a wildcard prefix, other resources in the domain, nor authority over any concrete target.

One canonical Tool ID MUST retain one semantic contract wherever it is reused. An incompatible target, output, authority, or effect requires a different resource or verb path; schema and implementation revisions remain separate evidence and MUST NOT be encoded as version suffixes in the ID.

Tool projection MUST preserve canonical semantic identity and exact implementation evidence. Provider-facing names grant no identity or authority.

Until a resource family is cut over, trusted server code creates Tool closures bound to the authenticated actor and exact role, scope, audience, budget, confirmation, credential, and delegation context required by existing owners. The model may provide only schema-admitted operation arguments and MUST NOT supply or widen those bound authority facts.

When that resource family is cut over, the accepted target in [Operation](#operation) applies.

Every concrete call MUST be reauthorized against current Core state by its command or resource owner. Tool presence means permission for the model to request an operation, not proof that the request is authorized, within budget, current, audience-safe, successfully applied, or settled.

Read Tools MUST return only audience-safe observations with required provenance and freshness. Consequential Tools MUST invoke the exact command or reviewed MCP adapter admitted by their Core capability owner and return that owner's authoritative outcome, including unknown external effects where applicable. After generation, the final publisher MUST recheck the exact destination and audience as defense in depth before durable or shared publication.

The complete visible Tool set is selected in deterministic order from the server-resolved entry path and its authored resource selection, never by inspecting the current message. Every operation follows the owning entry's fixed Core order, regardless of whether its implementation is local or MCP-backed. Membership and order remain fixed while the run is active, and a different entry path carries its own fixed exact set. Workspace-selected resources do not become user-specific Tool membership; current actor checks remain at each call.

Absence is reserved for unreachability, not rarity. A Tool MAY remain present when its worst case is contained by read-only, proposal-only, or approval-gated execution; when current state refuses a present Tool, the owning Core contract returns a typed bounded reason as the Tool result so the model can explain the boundary and an admitted remedy.

A request for a Tool belonging to another entry path MUST produce a proposal for a new Thread on that path rather than a false capability refusal or silent admission. Approval and Thread creation remain with their existing owners; this rule only fixes capability routing.

Tool admission is created when trusted entry-path resolution selects the exact ordered set, remains immutable during the active run, and terminates with that run. Only a new bounded run resolves current admission again; a later provider round trip in the same run cannot change membership. Restart reconstructs the set from the current entry path and authority owners; there is no durable Tool-set snapshot or authorization cache.

Missing factories and alias collisions fail closed before provider projection. Stale, denied, conflicted, unavailable, unknown, or recovery-required calls return the owning typed result when safe, and dependency failure MUST NOT widen admission, expose restricted-resource existence, or infer success.

Acceptance requires exact-ID selection, stable order, one-to-one provider aliases, per-call reauthorization, typed present-but-refused results, final publication recheck, and restart reconstruction without a durable Tool-set record.

The capability boundary explicitly rejects wildcard grants, namespace-derived authority, model or user Tool registration, a broad permanent model-visible catalog, opaque universal environment Tools, per-message Tool selection, decode-time masking or provider Tool-choice controls as permission boundaries, provider aliases as authority, Tool presence as authorization, raw internal failures in model context, and durable Tool-set authority. These rejected mechanisms have no lifecycle because they do not exist; any future admission requires a separately accepted owner and predicate.

## Transformer Pipeline

The agent capability path may apply transformations before or after an upstream call.

Examples include:

- model route normalization
- request redaction
- secret reference resolution
- prompt or context assembly
- response filtering
- artifact extraction
- usage normalization
- provider error normalization

Transformer decisions should be auditable without leaking secret values or sensitive provider-native payloads.

## Rate Limits And Budgets

The gateway projection is the natural enforcement point for capability rate limits, usage budgets, provider quotas, and cost controls.

Early implementations may omit some controls, but the capability call model must keep enough ownership context to add them later.

## Usage Metering

Agent-capability-mediated calls are the current owner boundary for producing OpenKit usage records on a `CapabilityCall`.

The gateway projection should be able to explain what resources were consumed by a capability call and which workspace, thread, turn, item, agent, and AgentSession caused that consumption.

[Evidence](evidence.md#usage-and-metering) owns `UsageRecord`, capability usage units, usage attribution, system-wide measurement, and `AuditEvent` governance projections across Core. The agent capability path may emit both usage and audit metadata, while [Evidence](evidence.md#audit) owns the durable governance projection.

## Invariants

- Mediation MUST NOT be conflated with server capability flags or agent supply declarations.
- Capability mediation responsibilities MUST NOT own, inspect, authorize, synthesize, retry, or reinterpret worker-control traffic; choose models; decide provider fallback; own rate limits; decide tool visibility or capability availability; persist sensitive responses; own credentials, metering, or usage attribution; decide permission policy; own product or workflow state; or implement business logic. A shared outer transport or process may carry the separately authenticated control plane without transferring those responsibilities.
- Gateway-mediated calls SHOULD preserve workspace, thread, turn, item, agent, AgentSession, capability-call, request, usage, vault-reference, transformer, and error context where practical.
- Secret values MUST NOT appear in prompts, item payloads, context packages, audit records, usage records, or normal workspace files through the capability path.
- Product-visible capability calls MUST produce or be referenced by item-backed events.
- A disabled capability plane MUST expose no routes and MUST fail closed rather than infer access from worker supply, network reachability, or control connectivity.
- Non-gateway runtime, sandbox, storage, and workspace-sync measurement MUST follow the [Evidence](evidence.md#usage-and-metering) boundary and MUST NOT be represented as an agent-capability-mediated call unless it is one.

## Agent Capability vs Feature Discovery

Feature discovery may report which server or client features are available. Despite sharing the word "capability", feature discovery is distinct from agent capabilities and does not route, supply, meter, rate-limit, or mediate privileged worker calls.

## Related Docs

- `docs/core/core-concepts.md`
- `docs/core/communication.md`
- `docs/core/vault.md`
- `docs/core/evidence.md`
- `docs/core/policy.md`
- `docs/core/sandbox.md`
- `docs/core/agent-supply.md`
- `docs/core/agent-session.md`
- `docs/decisions/20261002-operation_definition_rulings.md`
- `docs/decisions/20261018-unified_mediation_and_policy.md`
