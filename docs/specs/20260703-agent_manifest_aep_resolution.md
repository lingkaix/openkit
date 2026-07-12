# Agent Manifest And AEP Resolution

Status: Accepted
Implementation: Implemented

## Summary

This spec defines the clean target for authored agent manifests and their resolution into Agent Environment Package snapshots.

The target model is strict: authored manifests are inputs, not product truth. NanoCore resolves them with workspace policy, provider catalogs, vault grants, runtime placement, skill supply, MCP supply, and scheduling constraints into an immutable AEP snapshot for each worker session.

In core vocabulary, the authored manifest is the concrete setup document for an `AgentSetupContract`. Product-facing catalog summaries remain separate from launch manifests. Worker sessions launch from resolved AEP snapshots, not from catalog entries or authored files.

## Owns

- The authored agent setup document used as a manifest input.
- The resolution contract from authored setup, server policy, workspace policy, user preference, request input, provider catalog, supply catalog, vault grants, policy decisions, and runtime backend capability into one launch snapshot.
- Resolution precedence, fail-closed behavior, readiness diagnostics, degraded state explanation, and snapshot identity rules.
- The implementation projection for current `.agent.jsonc` loading, setup resolution, runtime config reload handling, and OpenShell-backed AEP materialization.
- The boundary between authored setup fields and runtime-native files generated from AEP snapshots.
- Manifest schema evolution, unknown-field handling, and required-feature fail-closed behavior.

## Does Not Own

- Product-visible agent catalogs or `AgentCatalogEntry` protocol summaries.
- General AEP schema ownership beyond how this resolver creates a snapshot.
- Agent session lifecycle, session reuse, warm pools, queueing, or placement scheduling.
- Agent capability call routing, gateway metering, or worker-visible capability protocols.
- Permission policy semantics, vault storage semantics, or sandbox containment semantics.
- Workspace synchronization, artifact registration, evidence retention, or audit schema details.
- Native Codex, OpenCode, OpenShell, or Pi Agent config file formats.

## Core References

- `docs/core/agent-supply.md`
- `docs/core/agent-session.md`
- `docs/core/agent-capability.md`
- `docs/core/sandbox.md`
- `docs/core/vault.md`
- `docs/core/permissions.md`
- `docs/core/storage.md`
- `docs/specs/20260703-schema_evolution_record_envelope.md`
- `docs/specs/20260704-session_static_workspace_materialization.md`

## Goals

- Define the manifest fields that must be authored before worker launch.
- Define the resolution order from server config, workspace policy, user preference, and request input.
- Make skills, MCP, scale, workspace materialization, provider use, vault grants, and runtime placement first-class manifest sections.
- Keep runtime-native files generated from AEP snapshots instead of authored directly as stable product contracts.
- Make readiness and degraded states explainable before launch.

## Non-goals

- Do not preserve compact or historical manifest shapes.
- Do not define Codex, OpenCode, or Pi Agent native config file formats.
- Do not let workspace or user config expand beyond server policy.
- Do not make worker-side MCP supply the same thing as the user-facing `@openkit/mcp` channel.
- Do not implement scheduling in this spec; see the runtime scheduling spec.

## Background

`docs/specs/20260628-agent_setup_runtime_supply_contract.md` defines NanoCore as the owner of agent setup and resolved worker environment. `docs/specs/20260616-agent_environment_package.md` defines the broad AEP model. The missing gap is the authored manifest and deterministic resolution contract.

## Decision

Use three records:

- `AgentManifest`: the authored declarative setup file for one agent supply unit.
- `ResolvedAgentSetup`: NanoCore's policy-checked resolved setup before launch.
- `AgentEnvironmentPackage`: the immutable launch snapshot materialized into the worker runtime.

Only the AEP snapshot is used to launch a real worker session.

The manifest may be file-backed, built-in, server-provided, organization-provided, or future workspace-local. Its source does not change the rule that lower-priority layers may only select or restrict capabilities; they cannot grant new authority beyond server and workspace policy.

## Manifest Sources

Server-owned sources:

- `DATA_ROOT/config/agents/<agentId>.agent.jsonc`
- built-in agent templates shipped by OpenKit
- server provider registry and model catalog
- server skill and MCP catalogs
- server runtime placement defaults

Workspace-owned sources:

- workspace allowlists and restrictions
- workspace input roots
- workspace-specific skill and MCP visibility where policy permits
- workspace resource limits and context rules

User-owned sources:

- default agent or profile preference
- model preference within workspace policy
- notification and consent preferences

Request-owned inputs:

- selected agent
- selected profile
- task-time context hints
- requested resource class
- requested workspace roots

Request input may select or restrict. It must not grant new capabilities.

## Manifest Shape

An authored `AgentManifest` should contain these target areas:

```text
schemaVersion
requiredFeatures
minCoreVersion
id
displayName
description
runtime
profiles
model
providers
skills
mcp
tools
workspace
context
vault
policy
sandbox
resources
scale
lifecycle
observability
extensions
```

`runtime` declares the runtime family, adapter, container backend requirements, and supported placements.

`profiles` define behavior modes. Profiles may restrict parent capabilities but cannot expand them.

`model` selects defaults and fallback policy by provider instance id plus model id.

`providers` declares required provider categories and references, not raw credentials.

`skills` declares catalog refs, version constraints, placement mode, and runtime adapter compatibility.

`mcp` declares MCP server refs, visibility, connection mode, authorization scope, and whether NanoCore spawns or proxies the server.

`workspace` declares workspace roots, inputs, generated files, mounts, output roots, and snapshot exclusions.

The authored workspace section declares needs, not backend mount implementation.

Endpoint-bearing sources are not declared inline. The manifest references entries from the workspace data source catalog by `sourceRef` with optional narrowing, per `docs/specs/20260704-workspace_data_source_catalog.md`; only workspace-relative files and directories, generated content, and OpenKit artifact references may remain inline. Manifests never carry endpoints or credential material.

Resolution must turn workspace declarations into a session-static workspace layout plus turn-dynamic materialization requirements when a worker session is launched, joining `sourceRef` entries with the catalog, vault grants, and policy; the AEP snapshot records the resolved source ids and catalog entry digests.

`context` declares allowed context package categories and task-time injection hints.

`vault` declares required secret references or grant refs without secret values.

`policy` declares required actions, approval points, and policy domains touched by this agent.

`sandbox` declares isolation requirements and backend capability requirements.

`resources` declares CPU, RAM, disk, network, wall-clock, and token budget classes.

`scale` declares concurrency, warm pool, session reuse, and queueing intent.

`lifecycle` declares startup, health, refresh, stop, and teardown behavior.

`observability` declares transcript, audit, log, metrics, and evidence requirements.

`extensions` is reserved for runtime-native adapter hints. Extension fields are never the stable product contract.

The manifest schema validates known fields strictly while remaining open to future optional fields.

Unknown optional fields may be ignored by older readers when no required feature declares that the field changes behavior.

Unknown authority-bearing semantics must fail closed.

Optional extension fields must be namespaced and must not become the only place where a product-semantic decision is stored.

## Manifest Evolution Rules

General evolution behavior — additive-by-default fields, unknown optional-field tolerance, required-feature fail-closed rejection, the authority-bearing field definition, and the baseline compatibility posture — is owned by `docs/specs/20260703-schema_evolution_record_envelope.md` and is not restated here.

This spec owns only the manifest-specific classification:

- New fields under `workspace`, `vault`, `policy`, `sandbox`, `providers`, `mcp`, `tools`, `resources`, `scale`, `observability`, or `lifecycle` are authority-bearing by default; this spec is the place that may explicitly mark a specific field as descriptive metadata, and no field is currently so marked.
- Manifest writers SHOULD gate new behavior with `requiredFeatures` from the shared feature registry; `minCoreVersion` is the discouraged escape hatch per the schema evolution spec.
- Required backend capabilities remain the correct gate when the requirement is a backend property rather than a reader-semantics property.

## Resolution Order

NanoCore resolves an agent launch in this order:

1. Load server manifest and built-in template.
2. Validate known schema fields and reject unsupported required features.
3. Attach server provider, model, skill, MCP, vault, and runtime catalogs.
4. Apply workspace restrictions.
5. Apply user preferences that are allowed by workspace and server policy.
6. Apply request selections and restrictions.
7. Select profile.
8. Resolve provider instance ids and model ids.
9. Resolve skill and MCP catalog entries.
10. Resolve vault grants and injection visibility.
11. Resolve workspace materialization inputs and output roots.
12. Resolve the session-static workspace layout, workspace slots, and session compatibility envelope.
13. Resolve resource and scale policy.
14. Evaluate permission and policy requirements.
15. Negotiate backend capability requirements.
16. Produce readiness, degraded, or blocked diagnostics.
17. Mint an immutable AEP snapshot for launch.

The resolver must fail closed when a requested field is ambiguous.

The resolver must also fail closed when a manifest declares an unsupported required feature, required backend capability, required mount kind, required source kind, required provider attachment mode, required vault injection mode, or required worker-visible capability family.

Resolution is deterministic. The same inputs, catalogs, policy snapshots, vault grants, backend capability summary, workspace roots, and request selections must produce the same resolved setup and AEP content digest.

## AEP Snapshot

The AEP snapshot must carry:

- package snapshot id
- schema version
- lineage ids
- selected agent and profile
- resolved runtime placement
- backend capability requirements
- resolved provider attachments
- resolved skill supply
- resolved MCP supply
- resolved workspace inputs and output roots
- resolved session-static workspace layout and workspace slots
- resolved context package references
- vault grants and injection plans
- policy decisions or pending approval requirements
- resource and scale limits
- lifecycle and refresh behavior
- observability sinks
- redacted diagnostics
- content digest

The snapshot is immutable. Any material change creates a new snapshot.

The AEP snapshot is the only launch contract passed to worker governance backends. Runtime-native files, environment variables, command arguments, sidecar configs, policy files, MCP configs, and provider endpoint configs are generated from the snapshot.

## Readiness States

Agent readiness is product-visible and should use these categories:

- `ready`: all required refs, grants, catalogs, and backend capabilities are available.
- `degraded`: launch is allowed, but an optional capability is missing or reduced.
- `blocked`: launch must not start because a required dependency, grant, policy decision, or backend capability is missing.
- `stale`: a running session uses an older snapshot and should be relaunched or refreshed at a safe point.

Catalog-level `disabled` and `unknown` states remain catalog or setup-discovery states. A resolver should project them into launch diagnostics rather than treating them as AEP launch states: disabled setup is `blocked` for launch, and unknown setup remains unresolved until the resolver can produce `ready`, `degraded`, or `blocked`.

Readiness explanations must be redacted and must not expose secrets, host paths, or backend-private payloads.

Readiness states describe launchability. They do not describe turn completion or agent-session lifecycle state.

## Readiness Remediation Hints

First setup diagnostics should expose only redacted, action-oriented hints.

Useful product-visible remediation categories:

- missing provider profile
- missing provider credential grant
- unresolved vault grant
- policy approval required
- policy denied
- required Skill unavailable
- required MCP entry unavailable
- backend capability unavailable
- unsupported runtime or adapter version
- workspace input missing
- workspace root denied
- workspace source kind unsupported
- workspace mount kind unsupported
- workspace source not found in catalog
- workspace source disabled
- workspace source grant missing or revoked
- sandbox backend unavailable
- capability route unavailable
- agent setup disabled by policy or operator

Hints may include non-secret ids, catalog names, status labels, policy decision ids, approval ids, and documentation links. They must not include raw secret values, raw account ids, host absolute paths, backend tokens, provider-native payloads, or unrestricted filesystem listings.

Unsupported optional fields should not produce blocking remediation hints.

Unsupported required features should produce blocked diagnostics that name the unsupported feature without exposing secret material or backend-private payloads.

## Materialization

Backends materialize the AEP into:

- `/openkit/config/package.json`
- runtime-native config files
- skill directories or references
- MCP config files or proxy endpoints
- provider endpoint config
- control, capability, and inference endpoints
- workspace roots and generated files
- output roots
- transcript and evidence sinks

Worker agents must not author or mutate their own stable supply.

## Current Implementation Projection

The current implementation is the accepted V1 projection of this target:

- `packages/config-schema/src/agent.ts` defines `AuthoredAgentConfigSchema` for `schemaVersion: 1` `.agent.jsonc` files with runtime, deployment, provider, skills, MCP, workspace, permissions, sandbox, resources, lifecycle, observability, profiles, required features, and extension areas.
- Authored agent configs reject unregistered `requiredFeatures` through the shared required-feature registry before NanoCore setup resolution.
- `apps/nanocore/src/config/agents-loader.ts` loads `DATA_ROOT/config/agents/*.agent.jsonc`, rejects invalid documents, rejects internal-only simulator agents, rejects unsafe workspace paths, validates transport shape, validates MCP credential references, and maps authored configs into runtime-facing `AgentManifest` summaries.
- `apps/nanocore/src/agents/setup-resolver.ts` resolves the current authored config into `ResolvedAgentSetup` with active deployment, runtime summary, provider reference, transport, origin metadata, supported required-feature preservation, and blocking diagnostics for missing deployment, missing provider, invalid transport, or unsupported required features.
- `apps/nanocore/src/agents/setup-resolver.ts` also preserves typed authored backend requirements from `sandbox.backend`, including allowed backend kinds, preferred backend kind, and required backend capabilities.
- `apps/nanocore/src/agents/setup-ledger.ts` and the workspace-scoped `resolved_agent_setups` table provide the first durable storage shape for redacted `ResolvedAgentSetup` records, and `startTurn` plus scheduler dispatch write the record when an authored setup is resolved for launch.
- `/api/setup/diagnostics` projects resolver blockers into the product-visible agent readiness summary: when setup resolution is blocked by unsupported required features, missing providers, missing deployment, or invalid transport, the agent readiness status becomes `blocked` and its reasons include the redacted resolver diagnostic messages.
- `apps/nanocore/src/config/runtime-config.ts` treats agent config changes as restart-required because the production scheduler captures authored agent inputs at startup; reload never claims that future sessions use a snapshot which the active dispatcher has not adopted.
- `packages/config-schema/src/agent-environment.ts` defines a strict `AgentEnvironmentPackageSchema` with `scope`, `agent`, `runtime`, `workspace`, `supply`, `control`, `capabilities`, `providers`, `vault`, `policy`, `llm`, `resources`, `observability`, `backend`, and extension sections. It also rejects raw-secret-shaped values.
- `apps/nanocore/src/runtime/agent-environment.ts` currently resolves only OpenShell container-backed AEP snapshots and rejects host AEP backends.
- Current OpenShell AEP resolution derives package and snapshot IDs from turn and agent-session lineage, binds the policy block to the worker-launch policy snapshot id, projects workspace roots, generates `/openkit/config/package.json`, provides `control.local`, `capability.local`, and `inference.local` endpoint projections, and declares worker-visible transcript, artifact, policy, provider, vault, LLM, observability, and backend sections.
- Current turn orchestration passes authored backend requirements from resolved setup into AEP resolution, and current OpenShell AEP resolution merges those required backend capabilities into the package backend envelope before worker-governance backend validation.
- Current OpenShell AEP resolution can project explicit workspace root `sourceRef` bindings through the workspace data source catalog into immutable workspace input source snapshots that include source id, source kind, non-secret locator, optional vault grant reference, and catalog entry digest.
- Repository-backed product turns now pass the selected repository sourceRef context through scheduler dispatch, turn orchestration, WorkerGovernance, and HostAdapter launch paths instead of requiring manual resolver parameters.
- Selected authored agent configs now feed matching `workspace.inputs[].sourceRef` declarations into turn start context when the input id matches a materialized workspace root id, and the NanoCore API turn-start path passes the workspace data source catalog from the runtime config snapshot into the same context.
- Turn orchestration resolves matching source refs before creating the turn and returns a typed `workspace_data_source_blocked` error for missing catalogs, missing sources, disabled sources, slot denials, or access widening.
- Workspace input snapshot and workspace materialization records built from resolved AEP workspace inputs now preserve the catalog `sourceId` for source-level lineage.
- Current worker Skill and MCP supply catalogs are static in `apps/nanocore/src/runtime/agent-environment.ts`, resolve by requested ids, require approved review status, enforce runtime-adapter allowlists, and project catalog entries into AEP supply.
- Current AEP snapshots include `knowledge.search` and `knowledge.read` capability route families as the worker-visible Knowledge projection.
- Current runtime state stores redacted AEP snapshots for diagnostics and replay context, and worker-governance launch now persists redacted AEP snapshots to the workspace-scoped `agent_environment_package_snapshots` ledger.

The accepted V1 resolver is implemented for server-owned authored setup loading, required-feature fail-closed handling, durable resolved-setup ledgers, readiness blockers, scheduler launch lineage, OpenShell AEP generation, static approved supply catalogs, workspace data source references, backend capability requirements, vault-backed provider and runtime-file attachment, redacted AEP snapshots, and App API/Core Client/OpenAPI/MCP readback. Workspace policy layering, user preference layering, policy-reviewed workspace-local agent definitions, richer readiness remediation, catalog-backed dynamic supply resolution, warm-pool intent, and multi-backend negotiation remain future extensions over the same manifest-to-resolved-setup-to-AEP pipeline.

## Scale Fields

The manifest may declare scale intent, but the scheduler owns actual placement.

Scale fields should include:

- max concurrent sessions
- idle timeout
- max turn duration
- queue priority class
- backend placement preference
- cost class
- session reuse policy
- warm pool intent

Workspace and server policy may restrict every scale field.

Scale intent fields should remain preferences and upper bounds. They must not name a concrete runtime target, force remote placement, allocate capacity, or bypass scheduler fairness. The scheduler owns placement plans, leases, queue order, warm-pool realization, and capacity records.

## Workspace-Local Agent Definitions

Workspace-local agent definitions are allowed only as policy-reviewed setup proposals.

The first supported model should be:

1. A workspace proposes an agent setup document.
2. NanoCore validates schema, redaction, source references, capability declarations, vault references, sandbox requirements, and policy domain.
3. Required reviewers or policy rules accept, edit, reject, or defer the proposal.
4. Accepted workspace-local setup becomes a workspace-scoped `AgentSetupContract` entry visible through the workspace catalog.
5. Launch still resolves through the same manifest-to-AEP pipeline and cannot expand beyond server and workspace policy.

Workers must not launch directly from an unreviewed workspace-local file.

## Skill And MCP Version Resolution

Authored manifests may express Skill and MCP supply with exact versions or policy-approved version constraints.

The AEP snapshot must always store exact resolved supply:

- catalog entry id
- resolved version
- source revision or package digest
- runtime adapter compatibility result
- policy decision ids when applicable
- materialized path or gateway route reference

The first catalog-backed worker-supply implementation should prefer exact pins until the catalog resolver records enough lockfile-style evidence to make ranges deterministic and replayable. Ranges become acceptable only when resolution writes the exact version and digest into the AEP snapshot.

## Alternatives Considered

### Use Agent Manifest Directly At Launch

Rejected. It makes authored config responsible for runtime policy, catalog resolution, and backend capability negotiation.

### Generate Native Runtime Config As The Product Contract

Rejected. Native config differs by runtime and would leak Codex, OpenCode, OpenShell, or future backend details into OpenKit semantics.

### Let Workspace Config Define Full Agents

Rejected for the first stable design. Workspace config may restrict and select within server policy, but unrestricted workspace-authored agents can bypass server governance.

## Testing Strategy

- Schema tests for valid and invalid manifests.
- Schema evolution tests for unknown optional fields and unsupported required features.
- Resolver fixture tests for server, workspace, user, and request layers.
- Security tests proving lower-priority layers cannot expand policy.
- Readiness tests for missing provider, missing vault grant, missing MCP catalog entry, and missing backend capability.
- Snapshot tests proving AEP identity changes when material inputs change.
- Materializer tests proving runtime-native files are generated from AEP, not hand-authored as product contracts.
- Reload tests proving agent config changes require restart and do not mutate the active dispatcher or live session snapshots.
- Redaction tests proving readiness diagnostics, AEP snapshots, generated files, and backend extensions do not expose secrets, host paths, or backend-private tokens.
- Fail-closed tests proving unsupported mount kinds, provider attachment modes, vault injection modes, and capability families block launch when required.

## Risks & Mitigations

- Risk: Manifest surface becomes too large. Mitigation: keep most fields optional and use catalogs for reusable detail.
- Risk: Profiles become sub-agents with their own hidden policies. Mitigation: profiles can only restrict or select within the parent agent.
- Risk: Scale settings are mistaken for scheduler commands. Mitigation: manifest declares intent; scheduler records the actual placement plan.
- Risk: MCP supply bypasses NanoCore. Mitigation: every worker-visible MCP server must resolve through the capability catalog.

## Resolved Decisions

- Authored manifests are setup inputs, not product truth.
- Catalog entries are selection and explanation surfaces, not launch manifests.
- AEP snapshots are immutable launch contracts. Any material supply, policy, workspace, provider, vault, backend, or request change produces a new snapshot.
- Request, user, and workspace layers may select or restrict allowed supply. They must not expand server or workspace policy.
- Runtime-native files are generated outputs from AEP snapshots and are never stable product contracts.
- Readiness is a redacted pre-launch diagnostic with `ready`, `degraded`, `blocked`, and `stale` target states.
- Scale fields in manifests are intent. Scheduler records decide actual placement, queueing, reuse, and capacity.
- Host execution is not a valid worker AEP backend target.
- Workspace-scoped AEP snapshot metadata belongs in workspace-owned storage. Runtime/session directories may hold generated file-backed materialization copies and backend receipts.
- Compact or historical manifest shapes do not need compatibility preservation in this internal development phase.
- Workspace-local agent definitions may exist only as policy-reviewed setup proposals and accepted workspace-scoped setup contracts. Unreviewed workspace-local files are never launch contracts.
- Authored Skill and MCP constraints may use exact pins or policy-approved ranges, but the AEP snapshot must store exact resolved versions and digests. The first catalog-backed implementation should prefer exact pins until deterministic resolver evidence exists.
- Scale intent fields remain preferences or upper bounds; scheduler records own concrete placement, queueing, reuse, warm-pool realization, and capacity.
- Product-visible readiness remediation hints must be redacted and action-oriented.
- Manifest evolution is additive by default after the accepted baseline. Unknown optional fields may be ignored or preserved, but unsupported required features must fail closed.
- Authority-bearing manifest additions must declare required features, minimum Core version, required backend capabilities, or equivalent required semantics.

## Deferred / Future Work

- Workspace policy, user preference, request selection, vault grant, permission decision, scheduler placement, backend selection, and backend negotiation layers in the resolver.
- Policy-reviewed workspace-local agent definitions.
- Full readiness diagnostics with user-actionable remediation hints.
- Catalog-backed Skill and MCP resolution outside static in-code fixtures.
- Content-digest based AEP identity and replayable resolver inputs.
- Durable generated-file receipts for runtime-native configs materialized from AEP snapshots.
- Conformance fixtures for forward-compatible optional fields and required-feature rejection.

## Links

- `docs/core/agent-supply.md`
- `docs/core/agent-session.md`
- `docs/core/agent-capability.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260704-session_static_workspace_materialization.md`
- `docs/specs/20260704-workspace_data_source_catalog.md`
- `docs/specs/20260628-agent_setup_runtime_supply_contract.md`
- `docs/specs/20260703-runtime_scheduling_scale.md`
- `docs/specs/20260703-worker_agent_capability.md`
- `docs/specs/20260703-vault_secret_injection.md`
- `docs/specs/20260703-policy_enforcement_mapping.md`
- `docs/specs/20260703-schema_evolution_record_envelope.md`
