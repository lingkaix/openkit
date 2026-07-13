# Agent Capability

Status: Accepted

This document defines OpenKit agent capability semantics.

Agent capabilities are runtime capabilities supplied to worker agents during execution.

This document owns runtime capability access, gateway projection, gateway-mediated usage metering, routing, transformer selection, credential injection contracts, context access paths, gateway audit metadata, rate limits, quotas, and provider/tool error normalization.

This document does not own agent supply declarations, reusable knowledge semantics, task-time context package semantics, global audit projection, permission policy, sandbox containment, or system-wide non-gateway metering.

## Purpose

Agents may need LLM providers, MCP servers, tools, network access, external APIs, knowledge-base retrieval, context injection, vault-mediated credentials, or other privileged services.

Agent capability gives Core a stable model for supplying, routing, transforming, authorizing, metering, rate-limiting, and auditing those calls.

It is part of the broader agent supply domain: `agent-supply.md` declares what a worker agent may need, `agent-capability.md` governs the runtime capability paths supplied during execution, and `agent-session.md` records the live or resumable execution handle that consumes those paths.

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
- agent session ID
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

The gateway projection should be able to explain what resources were consumed by a capability call and which workspace, thread, turn, item, agent, and agent session caused that consumption.

`UsageRecord` is the conceptual record for measured consumption.

Typical ownership areas include:

- workspace ID
- thread ID
- turn ID
- item ID
- capability call ID
- agent ID
- agent session ID

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
4. agent session
5. thread
6. workspace

Records may carry multiple IDs so usage can be aggregated at different levels.

Capability usage is not the same thing as audit.

Usage measures resource consumption. Audit explains who caused an action, which policy or gateway path applied, which resource was affected, and what outcome resulted. The agent capability path may emit both usage and audit metadata, but `audit.md` owns the durable governance projection across Core.

## Invariants

- Agent capability MUST NOT be conflated with server capability flags or agent supply declarations.
- Gateway-mediated calls SHOULD preserve workspace, thread, turn, item, agent, agent session, capability-call, request, usage, vault-reference, transformer, and error context where practical.
- Secret values MUST NOT appear in prompts, item payloads, context packages, audit records, usage records, or normal workspace files through the capability path.
- Product-visible capability calls MUST produce or be referenced by item-backed events.
- A disabled capability plane MUST expose no routes and MUST fail closed rather than infer access from worker supply, network reachability, or control connectivity.
- Non-gateway runtime, sandbox, storage, and workspace-sync metering MUST remain future metering scope until promoted by a stable design.

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
