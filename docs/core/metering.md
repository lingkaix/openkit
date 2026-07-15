# Metering Model

Status: Accepted

This document owns the system-wide principles for measuring resource consumption, including runtime, storage, and network usage that is not naturally defined by one agent-capability-mediated call.

This document does not own concrete usage schemas, provider usage semantics, billing policy, provider pricing, audit events, storage layout, budget enforcement, or runtime implementation details.

## Purpose

OpenKit needs to explain resource consumption across agent work without confusing measurement with billing, audit, or policy.

Agent Capability owns the canonical `UsageRecord` and the measured usage attached to provider, model, MCP, tool, knowledge-retrieval, credential-mediated, and other governed capability calls. Metering owns how non-gateway runtime, storage, and network measurements join that record family and how system-wide aggregation remains attributable and explainable.

Current measurement already covers a deliberately coarse foundation beyond LLM gateway calls: terminal worker-session counts, workspace export and import file and byte inventories, and Git publication request counts. Duration, CPU, memory, storage-at-rest, traffic volume, budgets, and cost projection remain incomplete.

## Principles

- Measurements represent observed consumption in explicit units. They are not inferred prices or independent billing truth.
- Every measurement should retain the narrowest available work and actor attribution without inventing identity that the producer cannot prove.
- Capability-mediated usage remains defined by Agent Capability; Metering extends the same attribution and record principles to non-gateway resources.
- Coarse current units must not be presented as finer measurements. A terminal worker-session count is not sandbox duration, CPU time, or memory allocation.
- Audit remains separate from metering. Metering measures consumption; Audit explains actions, actors, policy paths, affected resources, and outcomes.
- Cost and budget decisions must be derived from measured units and explicit policy or pricing inputs.

## Canonical Terms

`System-wide measurement` means an observed quantity of runtime, storage, network, or capability consumption recorded in an explicit unit with available work attribution.

`Non-gateway measurement` means measured consumption whose natural producer is a runtime, storage workflow, repository workflow, scheduler, or other governed subsystem rather than an external capability gateway call.

`Aggregation` means combining compatible measured units across attributable scopes without changing their meaning or losing their source lineage.

`Cost projection` means a derived estimate that applies explicit pricing or allocation rules to measured usage. It is not an independent source-of-truth record.

## Current Measurement Boundary

Current non-gateway measurement covers:

- terminal worker execution counted in worker-session units
- workspace export and import inventories measured in files and bytes
- governed Git publication network calls measured in request units

These measurements establish durable attribution and aggregation paths. They do not yet measure continuous sandbox lifetime, compute allocation, storage retention, or transferred network bytes.

Gateway-mediated provider and tool measurements remain owned by `agent-capability.md` even when system-wide reports aggregate them beside non-gateway measurements.

## Deferred Measurement Coverage

The system-wide model may expand when an implementation can observe meaningful units for:

- sandbox duration and active runtime lifetime
- runtime CPU, memory, accelerator, and allocation time
- retained storage bytes and artifact lifetime
- workspace synchronization and external network traffic volume
- background jobs, indexing, maintenance, and rebuild work
- warm capacity and scheduler reservation consumption

New units should be introduced only with a concrete producer, reliable observation boundary, clear attribution, and tests that prevent double counting.

## Boundaries And Non-Goals

Metering does not decide whether an action is authorized, whether a budget permits work, how a provider prices tokens, or whether a measured event is billable.

Metering does not replace Audit, Runtime, Storage, Sandbox, Scheduler, or Agent Capability ownership. Each subsystem remains responsible for the lifecycle and meaning of the event it measures.

Metering does not require all resources to share one unit. Aggregation must preserve unit meaning and must not combine incompatible quantities into a misleading total.

Metering does not store secret values, raw provider payloads, unrestricted file contents, or backend-private runtime handles.

## Invariants

- Every measurement MUST use an explicit unit and MUST preserve its producer and available work attribution.
- Measurements with incompatible units MUST NOT be summed as one quantity.
- Coarse measurements MUST NOT be presented as duration, compute, traffic, or retained-storage measurements they did not observe.
- Agent-capability-mediated usage MUST remain canonically defined by `agent-capability.md`.
- Metering MUST remain separate from Audit, authorization, budget enforcement, and billing.
- Cost projections MUST derive from measured usage plus explicit pricing or allocation inputs.
- Metering records MUST NOT store secret values, raw provider payloads, unrestricted file contents, or backend-private runtime handles.
- Retries and replay MUST NOT double count the same measured consumption when the producer declares an idempotent identity.
- New measurement families SHOULD preserve attribution to workspace, thread, turn, item, agent session, capability call, user, automation, or external effect when those scopes are provable.

## Relationships To Other Core Aspects

`agent-capability.md` owns `UsageRecord`, capability-call attribution, provider and tool usage, and gateway usage semantics.

`audit.md` owns accountability projections and action history rather than resource quantities.

`runtime-model.md`, `agent-session.md`, and `sandbox.md` own execution and isolation lifecycles that may produce runtime measurements.

`storage.md` owns storage semantics and retention; Metering owns only measured storage consumption.

`communication.md` and `agent-capability.md` own network and external-call semantics; Metering owns only measured consumption derived from those effects.

`permissions.md` owns authority, while budget enforcement remains a policy projection over measured usage rather than a Metering decision.

## Abstract Realization Notes

An implementation may use one shared durable usage ledger for gateway and non-gateway producers, provided every producer preserves its own category, unit, source, attribution, and idempotent identity.

System-wide reporting may aggregate compatible records by workspace, actor, workflow lineage, capability, provider, or time window. Reports should keep raw measured units inspectable and label every derived cost or allocation separately.

Budget enforcement should consume accepted measurements through a policy boundary. It should not mutate historical quantities or turn estimated cost into observed usage.
