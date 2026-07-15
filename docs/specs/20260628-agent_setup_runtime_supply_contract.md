# Agent Setup And Runtime Supply Contract

Status: Accepted
Implementation: Partial

## Summary

This spec consolidates the agent setup, profile, manifest loading, and runtime supply model.

This spec is the high-level setup and runtime supply entry point. Exact authored manifest fields, AEP snapshot identity, runtime scheduling, worker capability routes, and backend-specific materialization are owned by the specialized specs linked below.

Runtime placement details are refined by `docs/specs/20260629-worker_runtime_communication_model.md`, `docs/specs/20260703-runtime_scheduling_scale.md`, and `docs/specs/20260715-openshell_disposable_cell_lifecycle.md`. Host-local staging and harness behavior are implementation projections; real Worker Agent product paths use container placements.

The current contract is NanoCore-first. NanoCore owns agent identity, selected profile, runtime placement, resolved worker environment, policy intent, workspace inputs, review outputs, and product-visible readiness. The current local and remote disposable OpenShell Cell placements materialize that contract without becoming product state.

Older setup and profile specs remain useful implementation references, but this document is the active entry point for the setup/runtime supply model.

Detailed authored manifest to AEP resolution is owned by `docs/specs/20260703-agent_manifest_aep_resolution.md`.

## Owns

- The high-level consolidated entry point for agent setup, profile, manifest loading, and runtime supply.
- The rule that manifests and profiles are inputs to NanoCore resolution, not final launch contracts.
- The relationship between agent setup, AEP snapshots, worker runtime communication, workspace synchronization, and product-visible readiness.
- Replacement routing for historical agent setup and profile specs.

## Does Not Own

- Detailed authored manifest fields, resolution precedence, AEP snapshot identity, or readiness diagnostics.
- Exact AEP schema fields, snapshot hashing, backend materialization files, or runtime-native launch payloads.
- Agent catalog product semantics already owned by `docs/core/agent-supply.md`.
- Agent session lifecycle and runtime continuity.
- Worker capability gateway routes, metering, audit, or `capability.local`/`inference.local` details.
- Runtime scheduling, queueing, warm pools, capacity, or placement decisions.
- Vault secret storage, permission policy semantics, workspace synchronization record schemas, or backend-native config formats.

## Core References

- `docs/core/agent-supply.md`
- `docs/core/agent-session.md`
- `docs/core/agent-capability.md`
- `docs/core/runtime-model.md`
- `docs/core/sandbox.md`
- `docs/core/vault.md`

## Goals

- Keep setup and runtime supply aligned with `docs/specs/20260616-agent_environment_package.md`.
- Treat agent manifests and profiles as inputs to a resolved NanoCore package, not as the final product contract.
- Support the current container runtime placements: local container and remote container.
- Keep worker capabilities, skills, MCP servers, tools, provider attachments, workspace roots, generated files, and output paths explicit.
- Preserve review-gated workspace synchronization as the default write-back path.
- Make setup diagnostics product-visible without leaking backend-private paths, credentials, process ids, or OpenShell internals.

## Non-goals

- Do not preserve historical setup file shapes as supported current behavior.
- Do not make old manifest/profile specs active guidance.
- Do not let worker-side MCP supply be confused with the end-user Agent Skill Interface.
- Do not reintroduce host execution as a real Worker Agent runtime.

## Current Contract

NanoCore resolves setup inputs into an `AgentEnvironmentPackage` snapshot for each worker session. This section names the required supply categories; detailed authored-field resolution and snapshot identity rules belong to `docs/specs/20260703-agent_manifest_aep_resolution.md` and AEP schema ownership belongs to `docs/specs/20260616-agent_environment_package.md`.

The snapshot should include:

- workspace, thread, turn, agent session, and package lineage
- selected agent and profile
- runtime placement and backend capability requirements
- worker command, image, tool, skill, and binary supply
- workspace materialization inputs and writable path policy
- provider attachments, vault references, and credential visibility policy
- MCP and other tool supply intended for the worker runtime
- mandatory direct NanoCore control endpoint metadata
- transcript, artifact, workspace change, and audit output paths

Backends materialize the snapshot. Product surfaces read NanoCore records and redacted backend evidence, not backend-native manifests.

## Current Implementation Projection

The high-level setup and runtime supply contract owned by this spec is partially implemented:

- `packages/config-schema/src/agent.ts` defines the current authored agent config schema.
- `apps/nanocore/src/config/agents-loader.ts` loads `.agent.jsonc` files and maps them into runtime-facing agent manifests.
- `apps/nanocore/src/agents/setup-resolver.ts` resolves active deployment, provider references, runtime summary, transport, and origin metadata.
- `apps/nanocore/src/runtime/agent-environment.ts` resolves OpenShell-backed AEP snapshots from selected agent, turn, workspace roots, and backend input.
- `apps/nanocore/src/runtime/turn-executor-factory.ts` selects local or remote disposable Cell placement. Remote placement requires one fixed SSH lifecycle target, one operator-supplied loopback HTTP Gateway origin, and one explicit credential-free HTTP(S) worker-control URL whose path is `/api/worker-control`.
- Current AEP resolution includes static worker Skill and MCP catalog fixtures, required direct NanoCore worker control, backend-local inference or an exact trusted NanoCore worker-inference route, transcript paths, workspace roots, provider attachments where allowed, vault references where allowed, policy blocks, and observability blocks.
- Current AEPs declare `capabilities.mode: disabled` with no routes. Static worker supply does not expose `knowledge.*`, MCP, or any other callable capability family.
- The full durable server, workspace, user, request, vault, permission, scheduler, and backend capability layer stack remains owned and tracked by `docs/specs/20260703-agent_manifest_aep_resolution.md` rather than by this high-level entry point.
- The remote backend materialization E2E passes with stock OpenShell `0.0.80`, but the real Codex runtime-provenance acceptance remains pending, so this implementation is not complete.

## Runtime Placement Mapping

The current implementation selector projection is:

```text
OPENKIT_WORKER_RUNTIME=container
OPENKIT_CONTAINER_PLACEMENT=local|remote
OPENKIT_CONTAINER_BACKEND=openshell
```

Local and remote container placement are implemented through the stock OpenShell `0.0.80` backend family and share one single-slot whole-Cell teardown contract.

Remote placement is valid only when `OPENKIT_OPENSHELL_CELL_SSH_TARGET`, `OPENKIT_OPENSHELL_GATEWAY_URL`, and `OPENKIT_OPENSHELL_WORKER_CONTROL_BASE_URL` identify one coherent disposable Cell path. The SSH controller invokes only the fixed privileged helper actions, the Gateway URL is an operator-managed loopback HTTP origin, and the worker-control URL is a credential-free HTTP(S) URL ending at `/api/worker-control` that the sandbox can reach.

A naked or shared Gateway, insecure Gateway mode, custom OpenShell binary, resource-delete cleanup, fork, patch, or historical selector compatibility is not part of the contract.

## Reference Specs

The detailed historical specs have been moved under `docs/specs/superseded/agent-setup-runtime-supply/`.

They remain useful for field-level background, but new work should start from:

- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260703-workspace_synchronization.md`
- this spec

## Links

- [Agent Environment Package And Worker Governance Backends](./20260616-agent_environment_package.md)
- [Agent Manifest And AEP Resolution](./20260703-agent_manifest_aep_resolution.md)
- [Worker Runtime Communication Model](./20260629-worker_runtime_communication_model.md)
- [Worker Agent Capability](./20260703-worker_agent_capability.md)
- [Workspace Synchronization](./20260703-workspace_synchronization.md)
- [OpenShell Disposable Cell Lifecycle](./20260715-openshell_disposable_cell_lifecycle.md)
- [Runtime Scheduling And Scale](./20260703-runtime_scheduling_scale.md)
- [Runtime Model](../core/runtime-model.md)
- [Agent Supply](../core/agent-supply.md)
