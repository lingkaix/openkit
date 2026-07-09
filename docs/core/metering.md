# Metering Model

Status: Accepted

This document records the future OpenKit system-wide metering direction.

This document owns the placeholder boundary for resource measurement that is not naturally owned by agent-capability-mediated calls.

This document does not own concrete usage schemas, billing policy, provider pricing, gateway usage records, audit events, storage layout, or runtime implementation details.

## Purpose

OpenKit will eventually need a system-wide way to explain resource consumption across agent work.

The primary conceptual owner for measured provider and tool usage is `agent-capability.md`, because LLM, MCP, tool, network, knowledge-retrieval, and credential-mediated calls pass through agent capability paths and their gateway projection.

This document stays intentionally light until non-gateway resource metering becomes stable enough to design.

## Future Scope

Future system-wide metering may need to cover resources that do not originate from a gateway call.

Examples include:

- sandbox session duration
- runtime CPU and memory allocation
- storage bytes
- artifact storage
- workspace sync traffic
- background job work
- durable index rebuild work
- local or remote container lifetime

These areas may produce usage records or cost projections later, but they should not force premature fields into the core model before a concrete implementation path exists.

## Principles

Agent-capability-mediated usage belongs to `agent-capability.md`.

Audit remains separate from metering. Metering measures consumption; audit explains actions, actors, policy paths, affected resources, and outcomes.

Metering records should preserve enough attribution to aggregate by workspace, thread, turn, item, agent session, capability call, user, or automation when those scopes are available.

Metering must not store secret values, raw provider payloads, unrestricted file contents, or backend-private runtime handles.

## Invariants

- Agent-capability-mediated usage MUST remain owned by `agent-capability.md` until a broader metering model is promoted.
- Metering MUST remain separate from audit: metering measures consumption, audit explains actions and governance.
- Metering records MUST NOT store secret values, raw provider payloads, unrestricted file contents, or backend-private runtime handles.
- Future system-wide metering SHOULD preserve attribution to workspace, thread, turn, item, agent session, capability call, user, or automation when those scopes are available.

## System-Wide Metering Direction

System-wide metering remains a future extension of the usage record family.

Runtime, sandbox, storage, and workspace-sync consumption should use the same attribution principles as agent-capability-mediated usage when they become measured.

Budgets should combine gateway usage with non-gateway runtime and storage consumption only through explicit measured units.

Cost records remain projections over measured usage, not independent source-of-truth records.

## Related Docs

- `docs/core/agent-capability.md`
- `docs/core/audit.md`
- `docs/core/sandbox.md`
- `docs/core/storage.md`
- `docs/core/runtime-model.md`
