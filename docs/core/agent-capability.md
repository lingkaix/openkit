---
status: Accepted
---
# Agent Capability

This document defines OpenKit agent capability semantics for worker capability supply and internal-role Tool projection.

Agent capabilities are governed runtime paths supplied to worker agents during execution or projected as exact Tools to NanoCore-internal roles.

This document owns runtime capability access, gateway projection, internal-role Tool identity and admission, gateway-mediated usage metering, routing, transformer selection, credential injection contracts, context access paths, gateway audit metadata, rate limits, quotas, and provider/tool error normalization.

This document does not own agent supply declarations, reusable knowledge semantics, task-time context package semantics, global audit projection, permission policy, sandbox containment, or system-wide non-gateway metering.

## Purpose

Agents may need LLM providers, MCP servers, tools, network access, external APIs, knowledge-base retrieval, context injection, vault-mediated credentials, or other privileged services.

Agent capability gives Core a stable model for supplying, routing, transforming, authorizing, metering, rate-limiting, and auditing those calls.

For worker execution, it is part of the broader agent supply domain: `agent-supply.md` declares what a worker agent may need, `agent-capability.md` governs the runtime capability paths supplied during execution, and `agent-session.md` records the live or resumable execution handle that consumes those paths. Internal Core roles have no worker AgentSession; this document governs only their exact Tool projection and admission boundary.

## Principles

- Agent capability is the governed runtime path for supplying capabilities to worker agents, not the declaration that an agent can do something.
- Gateway projection is the target realization for capabilities that need routing, policy, metering, audit, credential injection, or upstream error normalization.
- Capability calls that are product-visible should remain item-backed; infrastructure calls may stay in capability, usage, and audit records.
- Credential injection must use vault-mediated paths and must stay outside prompt context.
- Agent capability usage and audit should be related but separate: usage measures consumption, audit explains action and governance.

## Boundary

Capability describes what can technically be supplied or used.

Permission decides whether a capability may be used in the current context.

Vault supplies credential references and approved injection paths.

Sandbox constrains which endpoints, processes, files, networks, and injected resources an agent can reach.

Communication defines the capability plane used to carry calls.

Agent supply declares requested capability categories and setup requirements.

The gateway is the target implementation projection for agent capabilities that require mediation. A worker environment MUST advertise capability routes explicitly; an environment whose capability plane is disabled has no implicit capability access.

The gateway owns routing, transformer pipeline selection, credential injection contract, gateway audit metadata, usage metering, rate-limit hooks, budget checks, and upstream error normalization for gateway-mediated calls.

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

## Internal Role Tool Identity And Admission

An internal-role Tool has one canonical dotted ID in the form `<domain>[.<resource>].<verb>`. Every segment MUST contain lowercase ASCII letters, digits, or underscores, MUST begin with a letter, and MUST describe the governed product domain, resource, and operation rather than a consuming role, route, transport, provider, or implementation class.

The canonical verb vocabulary is: `search` returns bounded candidates; `read` resolves one exact target or source; `start` requests an explicit mode handoff; `propose` submits a candidate for authoritative acceptance; `dispatch` requests execution admission; `respond` answers one exact owned request; `cancel` requests termination through the owning control contract; `request` creates an owned attention request; and `report` submits a state claim to its owner. Broad verbs such as `manage`, `execute`, `act`, `mutate`, and `send_message` MUST NOT conceal target, effect, delivery, or authority.

A namespace is an organizational and semantic boundary, not a capability hierarchy. Admission of one exact ID grants neither sibling IDs, a wildcard prefix, other resources in the domain, nor authority over any concrete target.

One canonical Tool ID MUST retain one semantic contract wherever it is reused. An incompatible target, output, authority, or effect requires a different resource or verb path; schema and implementation revisions remain separate evidence and MUST NOT be encoded as version suffixes in the ID.

A provider adapter MAY project a collision-checked request-local alias when dotted names violate provider constraints. It MUST retain an exact alias-to-canonical-ID mapping, MUST NOT reconstruct identity or authority by parsing the alias, and MUST use the canonical ID for internal usage, audit, evidence, and diagnostics.

Trusted server code creates Tool closures bound to the authenticated actor and exact role, scope, audience, budget, confirmation, credential, and delegation context required by existing owners. The model may provide only schema-admitted operation arguments and MUST NOT supply or widen those bound authority facts.

Every concrete call MUST be reauthorized against current Core state by its command or resource owner. Tool presence means permission for the model to request an operation, not proof that the request is authorized, within budget, current, audience-safe, successfully applied, or settled.

Read Tools MUST return only audience-safe observations with required provenance and freshness. Consequential Tools MUST invoke an exact typed Core command and return its authoritative outcome. After generation, the final publisher MUST recheck the exact destination and audience as defense in depth before durable or shared publication.

The complete visible Tool set is selected in deterministic order from the server-resolved entry path, never by inspecting the current message. Membership and order remain fixed for that entry path while the run is active, and a different entry path carries its own fixed exact set.

Absence is reserved for unreachability, not rarity. A Tool MAY remain present when its worst case is contained by read-only, proposal-only, or approval-gated execution; when current state refuses a present Tool, the owning Core contract returns a typed bounded reason as the Tool result so the model can explain the boundary and an admitted remedy.

A request for a Tool belonging to another entry path MUST produce a proposal for a new Thread on that path rather than a false capability refusal or silent admission. Approval and Thread creation remain with their existing owners; this rule only fixes capability routing.

Tool admission is created when trusted entry-path resolution selects the exact ordered set, remains immutable during the active run, and terminates with that run. A later safe provider request or new run resolves current admission again. Restart reconstructs the set from the current entry path and authority owners; there is no durable Tool-set snapshot or authorization cache.

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

Agent-capability-mediated calls are the current owner boundary for OpenKit usage records.

The gateway projection should be able to explain what resources were consumed by a capability call and which workspace, thread, turn, item, agent, and AgentSession caused that consumption.

`UsageRecord` is the conceptual record for measured consumption.

Typical ownership areas include:

- workspace ID
- thread ID
- turn ID
- item ID
- capability call ID
- agent ID
- AgentSession ID

Concrete usage schema fields belong in protocol specs and audit or usage specs, not in this core concept document.

Agent capability usage units should be explicit.

Common agent capability units include:

- tokens
- requests
- bytes
- tool calls
- capability calls
- network requests
- provider-native billable units

Provider-native units may be preserved under extension namespaces, but normalized units should be available for product surfaces.

## Usage Attribution

Usage should be attributable to the smallest stable scope available.

Preferred attribution order:

1. capability call
2. item
3. turn
4. AgentSession
5. thread
6. workspace

Records may carry multiple IDs so usage can be aggregated at different levels.

Capability usage is not the same thing as audit.

Usage measures resource consumption. Audit explains who caused an action, which policy or gateway path applied, which resource was affected, and what outcome resulted. The agent capability path may emit both usage and audit metadata, but `audit.md` owns the durable governance projection across Core.

## Invariants

- Agent capability MUST NOT be conflated with server capability flags or agent supply declarations.
- Gateway-mediated calls SHOULD preserve workspace, thread, turn, item, agent, AgentSession, capability-call, request, usage, vault-reference, transformer, and error context where practical.
- Secret values MUST NOT appear in prompts, item payloads, context packages, audit records, usage records, or normal workspace files through the capability path.
- Product-visible capability calls MUST produce or be referenced by item-backed events.
- A disabled capability plane MUST expose no routes and MUST fail closed rather than infer access from worker supply, network reachability, or control connectivity.
- Non-gateway runtime, sandbox, storage, and workspace-sync measurement MUST follow the current Metering boundary and MUST NOT be represented as an agent-capability-mediated call unless it is one.

## Agent Capability vs Feature Discovery

Feature discovery may report which server or client features are available. Despite sharing the word "capability", feature discovery is distinct from agent capabilities and does not route, supply, meter, rate-limit, or mediate privileged worker calls.

## Related Docs

- `docs/core/core-concepts.md`
- `docs/core/communication.md`
- `docs/core/vault.md`
- `docs/core/audit.md`
- `docs/core/permissions.md`
- `docs/core/sandbox.md`
- `docs/core/agent-supply.md`
- `docs/core/agent-session.md`
- `docs/core/metering.md`
