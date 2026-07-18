# Agent Manifest And AEP Resolution

Status: Accepted
Implementation: Partial

## Summary

This spec defines the clean target for authored agent manifests and their resolution into Agent Environment Package snapshots.

The target model is strict: one authored manifest plus one selected nested profile is an input, not product truth. NanoCore resolves it with workspace policy, provider catalogs, vault grants, runtime placement, supply, and scheduling constraints into one `ResolvedAgentSetup` and then one immutable AEP snapshot for each worker session.

In core vocabulary, the authored manifest is the concrete setup document for an `AgentSetupContract`. Product-facing catalog summaries remain separate from launch manifests. Worker sessions launch from resolved AEP snapshots, not from catalog entries or authored files.

## Owns

- The authored agent setup document used as a manifest input.
- The resolution contract from authored setup, server policy, workspace policy, user preference, request input, provider catalog, supply catalog, vault grants, policy decisions, and runtime backend capability into one launch snapshot.
- Resolution precedence, fail-closed behavior, readiness diagnostics, degraded state explanation, and snapshot identity rules.
- The implementation projection for current `.agent.jsonc` loading, setup resolution, runtime config reload handling, and OpenShell-backed AEP materialization.
- The boundary between authored setup fields and runtime-native argv, safe environment bindings, and isolated state paths derived inside the selected adapter.
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
- Keep runtime-native launch details inside the selected adapter instead of authoring them as stable product contracts.
- Make readiness and degraded states explainable before launch.

## Non-goals

- Do not preserve compact or historical manifest shapes.
- Do not define Codex, OpenCode, or Pi Agent native config file formats.
- Do not let workspace or user config expand beyond server policy.
- Do not make worker-side MCP supply the same thing as the end-user Agent Skill Interface.
- Do not implement scheduling in this spec; see the runtime scheduling spec.

## Background

`docs/core/agent-supply.md` defines NanoCore as the owner of agent setup and resolved worker environment. `docs/specs/20260616-agent_environment_package.md` defines the broad AEP model. This specification owns the authored manifest and deterministic resolution contract.

## Decision

Use three records:

- `AgentManifest`: the authored declarative setup file for one agent supply unit.
- `ResolvedAgentSetup`: NanoCore's policy-checked resolved setup before launch.
- `AgentEnvironmentPackage`: the immutable launch snapshot materialized into the worker runtime.

Only the AEP snapshot is used to launch a real worker session.

The complete authority chain is:

```text
AgentManifest plus selected nested profile
  -> NanoCore ResolvedAgentSetup
  -> immutable AgentEnvironmentPackage
  -> WorkerGovernanceBackend launches the governed image and generic openkit-worker-shim
  -> shim selects one opaque worker-side adapter
  -> adapter prepares one runtime-native process and collects one bounded result
  -> shim emits candidate records
  -> NanoCore validates and commits canonical product state
```

No layer in this chain may infer a second runtime definition or become a parallel supply authority.

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
capabilities
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

`runtime` declares an opaque `kind`, an opaque `adapter`, an optional pinned `version`, one exact governed `image.ref` with pull policy, and a non-empty list of runtime binary ids with absolute worker-local executable paths. NanoCore must preserve these declarations generically; it must not infer an image, adapter, or binary path from `kind`.

`profiles` define behavior modes. Profiles may restrict parent capabilities but cannot expand them.

`model` selects defaults and fallback policy by provider instance id plus model id.

`providers` declares required provider categories and references, not raw credentials.

`skills` declares catalog refs, version constraints, placement mode, and runtime adapter compatibility.

`mcp` declares only named catalog refs and their requested visibility or tool constraints. It must not contain server transports, commands, endpoints, credentials, or a runtime-native execution route. Resolved entries remain static AEP supply metadata until the governed `capability.local` MCP plane owned by `docs/specs/20260704-worker_mcp_tool_supply.md` is implemented and proven.

`capabilities` declares required and optional runtime capability ids. It does not declare callable routes; launch advertisement is computed by intersecting these requirements with selected adapter and image proof.

`workspace` declares workspace roots, inputs, generated files, mounts, output roots, and snapshot exclusions.

The authored workspace section declares needs, not backend mount implementation.

Endpoint-bearing sources are not declared inline. The manifest references entries from the workspace data source catalog by `sourceRef` with optional narrowing, per `docs/specs/20260704-workspace_data_source_catalog.md`; only workspace-relative files and directories, generated content, and OpenKit artifact references may remain inline. Manifests never carry endpoints or credential material.

Resolution must turn workspace declarations into a session-static workspace layout plus turn-dynamic materialization requirements when a worker session is launched, joining `sourceRef` entries with the catalog, vault grants, and policy; the AEP snapshot records the resolved source ids and catalog entry digests.

`context` declares allowed context package categories and task-time injection hints.

`vault` declares required secret references or grant refs without secret values.

`policy` declares required actions, approval points, and policy domains touched by this agent.

`sandbox` declares exact network grants, credential declarations, and backend requirements. Each network grant identifies its host, port, protocol, access mode, purpose, and any binary paths; every binary path must exactly match a path declared in `runtime.binaries`. Credential declarations identify provider or vault references plus allowed visibility and injection mode without secret values. Backend requirements identify allowed and preferred backend kinds plus required capabilities.

NanoCore may restrict these declarations during resolution, but neither NanoCore nor a backend may add an endpoint, credential path, provider attachment, binary allow rule, or backend capability that the authored manifest and policy did not authorize. Backend environment variables, built-in endpoints, and deployment defaults must not expand the effective allowlist.

`resources` declares CPU, RAM, disk, network, wall-clock, and token budget classes.

`scale` declares concurrency, warm pool, session reuse, and queueing intent.

`lifecycle` declares startup, health, refresh, stop, and teardown behavior.

`observability` declares transcript, audit, log, metrics, and evidence requirements.

`extensions` is reserved for namespaced optional metadata. It must not carry the runtime selector, native argv, native event schema, network or credential authority, backend requirements, or any other launch authority; extension fields are never the stable product contract. The resolved AEP's existing private `extensions.openkit.turnInput` value is a NanoCore-supplied per-turn input, not an authored runtime override.

The current manifest schema validates known fields strictly. Unknown fields are rejected unless an accepted current specification explicitly defines a namespaced descriptive extension.

Unknown authority-bearing semantics must fail closed.

Optional extension fields must be namespaced and must not become the only place where a product-semantic decision is stored.

## Manifest Evolution Rules

General authority-bearing field classification and required-feature fail-closed rejection are owned by `docs/specs/20260703-schema_evolution_record_envelope.md`. This internal-development contract provides no older-reader compatibility obligation.

This spec owns only the manifest-specific classification:

- New fields under `workspace`, `vault`, `policy`, `sandbox`, `providers`, `mcp`, `tools`, `resources`, `scale`, `observability`, or `lifecycle` are authority-bearing by default; this spec is the place that may explicitly mark a specific field as descriptive metadata, and no field is currently so marked.
- Manifest writers SHOULD gate new behavior with `requiredFeatures` from the shared feature registry; `minCoreVersion` is the discouraged escape hatch per the schema evolution spec.
- Required backend capabilities remain the correct gate when the requirement is a backend property rather than a reader-semantics property.

## Resolution Order

NanoCore resolves an agent launch in this order:

1. Select exactly one server-owned or built-in `AgentManifest`; a template is a candidate manifest, not a merge layer.
2. Validate known schema fields and reject unsupported required features.
3. Attach provider, model, skill, MCP, vault, and runtime catalogs only to resolve references or prove support; catalogs do not supply missing launch declarations.
4. Apply workspace restrictions.
5. Apply user preferences that are allowed by workspace and server policy.
6. Apply request selections and restrictions.
7. Select profile.
8. Resolve the authored opaque adapter, governed image, and declared runtime binary paths without runtime-specific inference.
9. Resolve provider instance ids and model ids.
10. Resolve skill and MCP catalog entries as static supply metadata.
11. Resolve vault grants and injection visibility.
12. Resolve exact sandbox network, credential, and backend declarations.
13. Resolve workspace materialization inputs and output roots.
14. Resolve the session-static workspace layout, workspace slots, and session compatibility envelope.
15. Resolve resource and scale policy.
16. Evaluate permission and policy requirements.
17. Intersect manifest capability requirements with selected adapter and image proof.
18. Negotiate backend capability requirements without widening the resolved sandbox envelope.
19. Produce readiness, degraded, or blocked diagnostics.
20. Mint an immutable AEP snapshot for launch.

The resolver must fail closed when a requested field is ambiguous.

The resolver must also fail closed when a manifest declares an unsupported required feature, required backend capability, required mount kind, required source kind, required provider attachment mode, required vault injection mode, or required worker-visible capability family; when a network binary path does not match a declared runtime binary; or when required adapter or image capability proof is missing.

Optional capabilities without adapter and image proof remain unadvertised. Neither the adapter nor the image catalog may publish a second capability authority.

Resolution is deterministic. The same inputs, catalogs, policy snapshots, vault grants, backend capability summary, workspace roots, and request selections must produce the same resolved setup and AEP content digest.

## AEP Snapshot

The AEP snapshot must carry:

- package snapshot id
- schema version
- lineage ids
- selected agent and profile
- descriptive runtime kind
- selected governed image reference and pull policy
- generic `openkit-worker-shim` command
- `control.adapter.kind: openkit-worker-shim` and the sole opaque adapter selector in `control.adapter.targetRuntime`
- exact declared runtime binary ids and absolute worker-local paths
- resolved runtime placement
- backend capability requirements
- resolved provider attachments
- resolved skill supply
- resolved MCP catalog metadata without an executable route
- resolved capability intersection and missing-proof diagnostics
- exact resolved network and credential policy
- resolved workspace inputs and output roots
- resolved session-static workspace layout and workspace slots
- resolved context package references
- vault grants and injection plans
- policy decisions or pending approval requirements
- resource and scale limits
- lifecycle and refresh behavior
- observability sinks
- the existing private per-turn input at `extensions.openkit.turnInput`
- redacted diagnostics
- content digest

The snapshot is immutable. Any material change creates a new snapshot.

The AEP snapshot is the only launch contract passed to worker governance backends. `runtime.command.argv` launches `openkit-worker-shim`; it never contains Codex, OpenCode, Pi, or future runtime-native argv. `control.adapter.targetRuntime` is the only adapter selector, while `agent.runtimeKind` is descriptive and must not select code.

The backend materializes the governed image, exact policy, provider and vault attachments, workspace, control endpoint, and package file without widening the AEP. Inside the image, the generic shim selects the statically registered adapter named by `targetRuntime`; the current adapter contract derives only runtime-native argv, safe child environment additions, and isolated state-root paths from the resolved AEP. It returns no generated-file or native-config artifacts to the shared shim. A future runtime that cannot work within this contract must amend S25 and its adapter specification before any file envelope enters implementation.

No AEP MCP catalog record generates a runtime-native MCP config, direct worker-to-server connection, or executable route. Worker MCP execution remains disabled until its owning capability-plane contract is implemented and proven.

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

Worker governance backends materialize the AEP into:

- `/openkit/config/package.json`
- the exact governed image and generic `openkit-worker-shim` entrypoint
- skill directories or references
- provider endpoint config
- the direct control endpoint and selected inference endpoint
- exact sandbox network, credential, process, filesystem, and backend policy
- workspace roots and generated files
- output roots
- transcript and evidence sinks

The generic shim selects the one statically registered worker-side adapter named by `control.adapter.targetRuntime`. The current adapter contract derives runtime-native argv, safe child environment, and isolated state-root paths only inside the worker image; those values are not NanoCore inputs, AEP fields, or backend defaults, and the shared shim has no adapter-authored file contract.

Shim and adapter outputs are candidate records, never canonical product state. NanoCore validates their lineage, schema, ordering, policy, and bounds before committing any canonical record.

Worker agents must not author or mutate their own stable supply, and neither a backend nor an adapter may add undeclared network, credential, capability, provider, or MCP authority.

## Current Implementation Projection

The current implementation is a partial pre-WP-2 projection of this target:

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
- Current AEP resolution still selects a Codex-specific shim, runtime command, image default, and runtime adapter through NanoCore-owned runtime-specific paths. Authored manifests do not yet supply the complete exact image, runtime binary, sandbox network, credential, and opaque adapter inputs required by this contract.
- Current OpenShell materialization compiles base network policy solely from the immutable AEP. The backend has no built-in endpoint list, network expansion option, or deployment environment variable that can widen it, and it rejects non-transient provider credentials before effects until exact Providers v2 endpoint and binary policy can be carried by the AEP.
- Current OpenShell AEP resolution derives package and snapshot IDs from turn and agent-session lineage, binds the policy block to the worker-launch policy snapshot id, projects workspace roots, generates `/openkit/config/package.json`, requires direct NanoCore worker control, declares the worker capability plane disabled with no routes, selects backend-local inference or an exact NanoCore worker-inference projection bound to the selected provider/model, and declares worker-visible transcript, artifact, policy, provider, vault, LLM, observability, and backend sections.
- Current turn orchestration passes authored backend requirements from resolved setup into AEP resolution, and current OpenShell AEP resolution merges those required backend capabilities into the package backend envelope before worker-governance backend validation.
- Current OpenShell AEP resolution can project explicit workspace root `sourceRef` bindings through the workspace data source catalog into immutable workspace input source snapshots that include source id, source kind, non-secret locator, optional vault grant reference, and catalog entry digest.
- Repository-backed product turns now pass the selected repository sourceRef context through scheduler dispatch, turn orchestration, WorkerGovernance, and HostAdapter launch paths instead of requiring manual resolver parameters.
- Selected authored agent configs now feed matching `workspace.inputs[].sourceRef` declarations into turn start context when the input id matches a materialized workspace root id, and the NanoCore API turn-start path passes the workspace data source catalog from the runtime config snapshot into the same context.
- Turn orchestration resolves matching source refs before creating the turn and returns a typed `workspace_data_source_blocked` error for missing catalogs, missing sources, disabled sources, slot denials, or access widening.
- Workspace input snapshot and workspace materialization records built from resolved AEP workspace inputs now preserve the catalog `sourceId` for source-level lineage.
- Current worker Skill and MCP supply catalogs are static in `apps/nanocore/src/runtime/agent-environment.ts`, resolve by requested ids, require approved review status, enforce runtime-adapter allowlists, and project catalog entries into AEP supply.
- Current AEP snapshots expose no worker capability route families. The accepted future Knowledge projection remains `knowledge.search` and `knowledge.read` after the capability plane is rebuilt.
- Current AEP snapshots preserve the per-turn request in the private `extensions.openkit.turnInput` field consumed by the worker shim.
- Current runtime state stores redacted AEP snapshots for diagnostics and replay context, and worker-governance launch now persists redacted AEP snapshots to the workspace-scoped `agent_environment_package_snapshots` ledger.

The existing resolver implements server-owned authored setup loading, required-feature fail-closed handling, durable resolved-setup ledgers, readiness blockers, scheduler launch lineage, OpenShell AEP generation, static approved supply catalogs, workspace data source references, backend capability requirements, vault-backed provider and runtime-file attachment, redacted AEP snapshots, and checked readback surfaces. It remains partial until the single generic manifest-to-resolved-setup-to-AEP path supplies exact image, binary, sandbox policy, capability proof, generic shim, and opaque adapter fields without NanoCore runtime branches.

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
- materialized path for file supply, or a catalog binding for capability-plane supply

An MCP catalog binding is non-executable metadata while the worker capability plane is disabled. It must not carry a worker-local command, native config target, direct server endpoint, or callable route; those become available only through the governed `capability.local` contract after its independent acceptance criteria pass.

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
- Shim tests proving current runtime-native argv, environment, and state paths are derived from AEP inputs without an adapter-authored file envelope.
- Boundary tests proving `runtime.command.argv` always launches `openkit-worker-shim`, `control.adapter.targetRuntime` is the only adapter selector, and `agent.runtimeKind` never selects code.
- Resolver tests proving exact authored image and runtime binary declarations reach the AEP without a runtime-specific NanoCore branch.
- Sandbox tests rejecting network binary paths absent from `runtime.binaries` and rejecting any backend, deployment default, or environment variable that widens resolved network or credential authority.
- Capability tests proving launch advertisement is the manifest requirement intersection with adapter and image proof, required missing proof blocks launch, and optional unproven support stays unadvertised.
- MCP tests proving static catalog records do not generate native config, direct connections, or executable routes while the capability plane is disabled.
- Candidate-record tests proving shim and adapter output is not canonical until NanoCore validates and commits it.
- Reload tests proving agent config changes require restart and do not mutate the active dispatcher or live session snapshots.
- Redaction tests proving readiness diagnostics, AEP snapshots, generated files, and backend extensions do not expose secrets, host paths, or backend-private tokens.
- Fail-closed tests proving unsupported mount kinds, provider attachment modes, vault injection modes, and capability families block launch when required.

## Risks & Mitigations

- Risk: Manifest surface becomes too large. Mitigation: keep most fields optional and use catalogs for reusable detail.
- Risk: Profiles become sub-agents with their own hidden policies. Mitigation: profiles can only restrict or select within the parent agent.
- Risk: Scale settings are mistaken for scheduler commands. Mitigation: manifest declares intent; scheduler records the actual placement plan.
- Risk: MCP supply bypasses NanoCore. Mitigation: manifests and AEPs carry only static catalog bindings; executable MCP access exists only through the separately governed `capability.local` plane after that plane is implemented and proven.

## Resolved Decisions

- Authored manifests are setup inputs, not product truth.
- Catalog entries are selection and explanation surfaces, not launch manifests.
- One authored `AgentManifest` with one selected nested behavior profile resolves through one `ResolvedAgentSetup` into one immutable AEP; no runtime-oriented profile or inferred runtime may become a parallel source.
- The AEP launches only the generic `openkit-worker-shim`; `control.adapter.targetRuntime` is the sole opaque adapter selector, and `agent.runtimeKind` is descriptive.
- Authored runtime declarations own the exact governed image and non-empty runtime binary id and absolute worker-local path list. Authored sandbox declarations own exact network grants, credential declarations, and backend requirements, and materialization may only restrict them.
- Launch-time capability advertisement is the intersection of manifest requirements and selected adapter and image proof. Required missing proof blocks launch, and optional unproven support remains unadvertised.
- Static MCP catalog bindings do not authorize runtime-native MCP config, direct worker connections, or executable routes.
- Shim and adapter records remain candidates until NanoCore validates and commits canonical product state.
- AEP snapshots are immutable launch contracts. Any material supply, policy, workspace, provider, vault, backend, or request change produces a new snapshot.
- Request, user, and workspace layers may select or restrict allowed supply. They must not expand server or workspace policy.
- Current runtime-native launch details are adapter-derived outputs from AEP snapshots and are never stable product contracts; generated native files are not authorized by the current adapter interface.
- Readiness is a redacted pre-launch diagnostic with `ready`, `degraded`, `blocked`, and `stale` target states.
- Scale fields in manifests are intent. Scheduler records decide actual placement, queueing, reuse, and capacity.
- Host execution is not a valid worker AEP backend target.
- Workspace-scoped AEP snapshot metadata belongs in workspace-owned storage. Runtime/session directories may hold generated file-backed materialization copies and backend receipts.
- Compact or historical manifest shapes do not need compatibility preservation in this internal development phase.
- Workspace-local agent definitions may exist only as policy-reviewed setup proposals and accepted workspace-scoped setup contracts. Unreviewed workspace-local files are never launch contracts.
- Authored Skill and MCP constraints may use exact pins or policy-approved ranges, but the AEP snapshot must store exact resolved versions and digests. The first catalog-backed implementation should prefer exact pins until deterministic resolver evidence exists.
- Scale intent fields remain preferences or upper bounds; scheduler records own concrete placement, queueing, reuse, warm-pool realization, and capacity.
- Product-visible readiness remediation hints must be redacted and action-oriented.
- Manifest evolution changes the accepted current schema explicitly. Unknown fields and unsupported required features fail closed; no older-shape compatibility path is required.
- Authority-bearing manifest additions must declare required features, minimum Core version, required backend capabilities, or equivalent required semantics.

## Deferred / Future Work

- Workspace policy, user preference, request selection, vault grant, permission decision, scheduler placement, backend selection, and backend negotiation layers in the resolver.
- Policy-reviewed workspace-local agent definitions.
- Full readiness diagnostics with user-actionable remediation hints.
- Catalog-backed Skill and MCP resolution outside static in-code fixtures.
- Content-digest based AEP identity and replayable resolver inputs.
- Non-authorizing future review of generated native files and durable receipts if a concrete runtime later proves the current argv, environment, and state-path contract insufficient.
- Conformance fixtures for unknown-field and unsupported-required-feature rejection.

## Links

- `docs/core/agent-supply.md`
- `docs/core/agent-session.md`
- `docs/core/agent-capability.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260704-session_static_workspace_materialization.md`
- `docs/specs/20260704-workspace_data_source_catalog.md`
- `docs/specs/20260703-runtime_scheduling_scale.md`
- `docs/specs/20260703-worker_agent_capability.md`
- `docs/specs/20260703-vault_secret_injection.md`
- `docs/specs/20260703-policy_enforcement_mapping.md`
- `docs/specs/20260703-schema_evolution_record_envelope.md`
