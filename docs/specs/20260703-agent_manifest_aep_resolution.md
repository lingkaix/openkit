---
status: Accepted
implementation: Partial
updated: 2026-08-10
---
# Agent Manifest And AEP Resolution

## Summary

This specification defines the concrete `AgentManifest` schema and validation and its resolution into Agent Environment Package snapshots.

The target model is strict: one authored manifest plus one selected nested profile is an input, not product truth. NanoCore resolves it with workspace policy, provider catalogs, vault grants, runtime placement, supply, and scheduling constraints into one `ResolvedAgentSetup` and then one immutable AEP snapshot for each worker session.

Core Agent Supply owns the authored `AgentManifest` concept. This specification owns its concrete schema and validation and its resolution into `ResolvedAgentSetup` and immutable AEP snapshots. Product-facing catalog summaries remain separate from launch manifests. Worker sessions launch from resolved AEP snapshots, not from catalog entries or authored files.

## Owns

- The concrete `AgentManifest` schema and validation for authored manifest inputs.
- The resolution contract from authored setup, server policy, workspace policy, user preference, request input, provider catalog, supply catalog, vault grants, policy decisions, and runtime backend capability into one launch snapshot.
- Resolution precedence, fail-closed behavior, readiness diagnostics, degraded state explanation, and snapshot identity rules.
- The implementation projection for current `.agent.jsonc` loading, setup resolution, runtime config reload handling, and OpenShell-backed AEP materialization.
- The boundary between authored setup fields and runtime-native argv, safe environment bindings, and isolated state paths derived inside the selected adapter.
- Manifest schema evolution, unknown-field handling, and required-feature fail-closed behavior.

## Does Not Own

- Product-visible agent catalogs or `AgentCatalogEntry` protocol summaries.
- General AEP schema ownership beyond how this resolver creates a snapshot.
- AgentSession lifecycle, session reuse, warm pools, queueing, or placement scheduling.
- Agent capability call routing, gateway metering, or worker-visible capability protocols.
- Permission policy semantics, vault storage semantics, or sandbox containment semantics.
- Workspace synchronization, artifact registration, evidence retention, or audit schema details.
- Native Codex, OpenCode, OpenShell, or Pi Agent config file formats.
- Concrete local or remote placement, configured NanoHost selection, NanoHost credential or transport, Runtime Epoch lifecycle, sandbox-local Integration carriage, OpenShell Gateway transport, or deployment topology.

## Core References

- `docs/core/agent-supply.md`
- `docs/core/agent-session.md`
- `docs/core/agent-capability.md`
- `docs/core/sandbox.md`
- `docs/core/vault.md`
- `docs/core/permissions.md`
- `docs/core/storage.md`

## Related Docs

- `docs/specs/20260703-schema_evolution_record_envelope.md`
- `docs/specs/20260704-session_static_workspace_materialization.md`
- `docs/specs/20260802-nanohost_runtime_and_transport.md`
- `docs/specs/20260801-nanohost_workspace_data_boundary.md`

## Goals

- Define the manifest fields that must be authored before worker launch.
- Define the resolution order from server config, workspace policy, user preference, and request input.
- Make skills, MCP, scale intent, workspace materialization, provider use, vault grants, and backend requirements first-class manifest sections without making the manifest a deployment record.
- Keep runtime-native launch details inside the selected adapter instead of authoring them as stable product contracts.
- Make readiness and degraded states explainable before launch.

## Non-goals

- Do not preserve compact or historical manifest shapes.
- Do not define Codex, OpenCode, or Pi Agent native config file formats.
- Do not let workspace or user config expand beyond server policy.
- Do not make worker-side MCP supply the same thing as the end-user Agent Skill Interface.
- Do not implement scheduling in this spec; see the runtime scheduling spec.

## Background

`docs/core/agent-supply.md` owns the authored `AgentManifest` concept and NanoCore's resolved worker environment. `docs/specs/20260616-agent_environment_package.md` owns the strict AEP envelope and cross-boundary invariants. This specification owns the concrete manifest schema and validation and the deterministic resolution into `ResolvedAgentSetup` and AEP.

## Decision

Use three records:

- `AgentManifest`: the Core-owned authored declarative setup concept for one agent supply unit, with its concrete schema and validation owned by this specification.
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
- server scheduler and backend topology inputs used only during resolution

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

`runtime` declares an opaque `kind`, an opaque `adapter`, an optional pinned `version`, one governed image selection, and a non-empty list of runtime binary ids with absolute worker-local executable paths. NanoCore must preserve these declarations generically; it must not infer an image, adapter, or binary path from `kind`.

The image selection is exactly one of two authored forms, matching the two forms the package owner accepts in `docs/specs/20260616-agent_environment_package.md`:

- one exact governed `image.ref` with pull policy; or
- one build definition declaring the exact literal context reference `build-context://empty/v1`, its exact digest `sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`, one independent nonempty inline Dockerfile build input encoding 1 through 268,435,456 exact UTF-8 bytes with its lowercase SHA-256, build arguments, and a bounded build egress grant set.

Resolution treats the two forms identically in every other respect: the authored selection is preserved without inference, resolved into one immutable AEP, and materialized by the backend. A reference whose `ref` is one canonical lowercase `sha256:` digest and whose pull policy is `never` names a deployment image already admitted to the NanoHost Image Store and imported during readiness; the backend passes that digest directly to `sandbox.create` and MUST NOT emit `image.acquire`, while every other reference is materialized through the existing acquisition owner. Absence or corruption of that preloaded deployment digest remains a NanoHost readiness failure and creates no runtime fallback. Under V1 the build-context singleton is explicit authored input, not a resolver default: its zero-entry canonical byte sequence is exactly empty bytes, the 1-through-268,435,456-byte UTF-8 Dockerfile remains inline immutable package content with a lowercase SHA-256 over exactly those bytes, is independently digested, and is excluded from the context digest, and any missing or different context pair, empty or oversized Dockerfile, invalid UTF-8, or Dockerfile digest mismatch is rejected before a scheduler or backend effect. Pull policy applies only to the reference form and is meaningless under the build form, so a manifest that supplies both a build definition and a pull policy is rejected rather than silently ignoring one. A build egress set that is absent, unbounded, or wildcard-hosted is rejected; whether a specific endpoint may appear in that set remains a workspace-policy decision under its existing owner. The selection is a discriminated union in the resolved package, which is why the package owner moves to `schemaVersion: 3` rather than gating the form behind a required feature. V1 defines no Dockerfile locator, context locator variant, transfer authority, configuration input, dependency, compatibility form, or future extension placeholder.

The generic authored build arm, resolved build arm, and resolver path implement the exact authored `build-context://empty/v1` plus `sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`, prove that digest from the zero-entry empty-byte context, keep the Dockerfile excluded from that digest, enforce its nonempty 268,435,456-byte UTF-8 ceiling and exact digest, and reject every invalid input before effects.

`mode`, `deployment`, `transport`, and an unstructured `runtimeConfig` are not AgentManifest areas and must be rejected as unknown fields. They neither select local versus remote placement nor carry a NanoHost identity, NanoHost credential, Runtime Epoch identity, local command, SSH target, Gateway origin, NanoCore endpoint, direct worker endpoint, transport credential, or native runtime configuration. Server configuration and scheduler records select the one configured NanoHost; the backend resolves only sandbox-local Integration bindings for the accepted worker package. No agent-authored field may select or widen that topology.

`profiles` define behavior modes. Profiles may restrict parent capabilities but cannot expand them.

`provider` selects exactly one provider profile reference and an optional model id. Agent-authored provider or model fallback lists are not accepted; failure to resolve or project that one route fails closed.

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

`sandbox` declares exact network grants, credential declarations, and backend requirements. Each network grant identifies its host, port, protocol, purpose, and a non-empty explicit binary-path list plus either one access mode or a non-empty bounded REST rule list; omission never means every runtime binary, and every listed path must exactly match a path declared in `runtime.binaries`. Exact REST rules currently allow `GET` or `POST` with absolute OpenShell-compatible paths and cannot be combined with an access preset. Credential declarations identify provider or vault references plus allowed visibility and injection mode without secret values. Backend requirements may identify allowed and preferred backend kinds plus required capabilities only as eligibility constraints; they never name or select a NanoHost, backend instance, Runtime Epoch, local or remote placement, SSH target, Gateway origin, NanoCore endpoint, direct worker endpoint, route credential, or transport.

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
12. Resolve exact sandbox network, credential, and backend requirements without accepting manifest-owned placement, NanoHost, endpoint, credential, or transport topology.
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
- selected governed image selection, which is either the image reference with its pull policy or the resolved build definition and its build egress set
- generic `openkit-worker-shim` command
- `control.adapter.kind: openkit-worker-shim` and the sole opaque adapter selector in `control.adapter.targetRuntime`
- exact declared runtime binary ids and absolute worker-local paths
- selected backend kind and capability requirements without a NanoHost, host, Runtime Epoch, Gateway, SSH, or remote endpoint identity
- backend capability requirements
- resolved provider attachments
- resolved skill supply
- resolved MCP catalog metadata without an executable route
- resolved capability intersection and missing-proof diagnostics
- non-secret sandbox-local Integration route bindings and distinct worker-control, inference, and capability token references resolved by the backend, never authored by the manifest
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

The backend materializes the governed image, exact policy, provider and vault attachments, workspace, package file, and non-secret sandbox-local Integration bindings without widening the AEP. The worker package never receives the configured NanoHost credential, raw route tokens, Runtime Epoch identity, remote NanoCore or Gateway address, SSH target, Gateway forward, or direct sandbox-to-NanoCore endpoint. Inside the image, the generic shim selects the statically registered adapter named by `targetRuntime`; the current adapter contract derives only runtime-native argv, safe child environment additions, and isolated state-root paths from the resolved AEP. It returns no generated-file or native-config artifacts to the shared shim. A future runtime that cannot work within this contract must amend S25 and its adapter specification before any file envelope enters implementation.

No AEP MCP catalog record generates a runtime-native MCP config, direct worker-to-server connection, or executable route. Worker MCP execution remains disabled until its owning capability-plane contract is implemented and proven.

## Readiness States

Agent readiness is product-visible and should use these categories:

- `ready`: all required refs, grants, catalogs, and backend capabilities are available.
- `degraded`: launch is allowed, but an optional capability is missing or reduced.
- `blocked`: launch must not start because a required dependency, grant, policy decision, or backend capability is missing.
- `stale`: a running session uses an older snapshot and should be relaunched or refreshed at a safe point.

Catalog-level `disabled` and `unknown` states remain catalog or setup-discovery states. A resolver should project them into launch diagnostics rather than treating them as AEP launch states: disabled setup is `blocked` for launch, and unknown setup remains unresolved until the resolver can produce `ready`, `degraded`, or `blocked`.

Admission may report `degraded` when a required worker credential is owned by an explicit manifest declaration whose durable grant can be validated only by the existing turn-scoped AEP resolver. This is a bounded preflight compromise, not proof that the credential exists: the AEP resolver remains the sole grant authority and must fail before provider, sandbox, or other external effects when the grant, reference, lifetime, target session, injection path, or backend sink is invalid. Provider-profile credentials that are not manifest-owned must still be resolved by the existing provider credential resolver before admission. `disabled`, `blocked`, and `unknown` setups must not invoke the turn executor; only `ready` and this explicit `degraded` case may proceed.

Readiness explanations must be redacted and must not expose secrets, host paths, or backend-private payloads.

Readiness states describe launchability. They do not describe turn completion or AgentSession lifecycle state.

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
- distinct sandbox-local `/worker-control/*`, `/inference/*`, and `/capabilities/*` Integration bindings plus non-secret token references
- exact sandbox network, credential, process, filesystem, and backend policy
- workspace roots and generated files
- output roots
- transcript and evidence sinks

The generic shim selects the one statically registered worker-side adapter named by `control.adapter.targetRuntime`. The current adapter contract derives runtime-native argv, safe child environment, and isolated state-root paths only inside the worker image; those values are not NanoCore inputs, AEP fields, or backend defaults, and the shared shim has no adapter-authored file contract.

Shim and adapter outputs are candidate records, never canonical product state. NanoCore validates their lineage, schema, ordering, policy, and bounds before committing any canonical record.

Worker agents must not author or mutate their own stable supply, and neither a backend nor an adapter may add undeclared network, credential, capability, provider, or MCP authority.

## Current Implementation Projection

The current implementation follows the single authority chain defined by this specification:

- `packages/config-schema/src/agent.ts` strictly validates `schemaVersion: 1` `.agent.jsonc` files and rejects historical top-level `mode`, `deployment`, `transport`, and unstructured `runtimeConfig` fields. An authored runtime supplies an opaque kind and adapter, one exact image reference and pull policy, and a non-empty list of absolute worker-local binary paths.
- The manifest selects exactly one provider profile and optional model. It owns exact sandbox network grants, credential declarations, and backend eligibility requirements. Network grants name explicit declared binary paths and either an access preset or bounded exact REST rules. No manifest field selects local or remote placement, an SSH target, a Gateway origin, or transport credentials.
- `apps/nanocore/src/config/agents-loader.ts` loads and validates manifests, while `apps/nanocore/src/agents/setup-resolver.ts` produces a topology-free `ResolvedAgentSetup` containing the selected manifest and resolved provider. Required features, provider and supply references, backend requirements, sandbox authority, and readiness fail closed.
- `apps/nanocore/src/agents/setup-ledger.ts` stores redacted workspace-scoped resolved-setup records. `/api/setup/diagnostics` reports redacted launchability; deployment and Gateway diagnostics remain scheduler or backend concerns.
- `apps/nanocore/src/runtime/agent-environment.ts` preserves the manifest-authored image, pull policy, runtime binaries, sandbox envelope, adapter id, provider route, and static supply through one generic OpenShell AEP resolver. It emits the fixed `openkit-worker-shim --package /openkit/config/package.json` command. `control.adapter.targetRuntime` is the sole adapter selector, and `agent.runtimeKind` never selects code.
- The current adapter and route intersection is closed and version-pinned: Codex `0.144.1` and OpenCode `1.18.1` accept only the trusted NanoCore relay envelope; Pi `0.80.7` accepts only direct Anthropic `claude-sonnet-4-5`. Zero routes, multiple routes, mixed relay and direct authority, and unsupported runtime-route pairs fail before child launch.
- The OpenShell materializer compiles network and credential policy only from the immutable AEP. Backend defaults and deployment environment cannot widen it. The backend validates required capabilities before effects and never infers an image, binary, adapter, provider, credential, or endpoint. An exact lowercase digest reference with pull policy `never` reuses the deployment image proved at NanoHost readiness and proceeds directly to `sandbox.create`; other reference forms retain `image.acquire`.
- The AEP preserves sourceRef lineage, vault-backed attachments, backend requirements, workspace roots, private per-turn input, policy binding, transcript paths, and redacted snapshots. Current Skill and MCP entries are static approved supply metadata; `capabilities` remains explicitly disabled with no callable route or generated native MCP configuration.
- `packages/worker-shim` selects one adapter from its static registry. The shared contract is only `prepare` and `collect`: adapters derive native argv, safe child environment, isolated state-root paths, and one bounded normalized result. It has no adapter-authored config-file envelope, runtime compatibility fallback, dynamic plugin loader, worker capability client, or control sidecar.

Current production selects only the configured NanoHost RuntimeTarget and resolves capability, worker-control, and inference as three sandbox-local Integration bindings over the stock `ForwardTcp`/`RelayStream` pair and nested standard HTTP/2 session. It supplies no direct NanoCore worker endpoint or Cell topology; capability remains disabled, while worker-control and inference retain distinct token bindings. The authored manifest remains topology-free, and NanoHost transport, Runtime Epoch lifecycle, and route realization stay with their narrow owners.

Local schema, resolver, AEP, materializer, readiness, redaction, worker-shim, adapter, image-contract, closed-runtime, typecheck, build, and repository gates cover this boundary. The 2026-07-21 refreshed arm64 images build locally and pass their complete image smoke checks. The earlier minimal images passed stock OpenShell `0.0.80` create, upload, adapter `prepare` dry-run, and `--no-keep` cleanup checks on A1, but refreshed-image stock OpenShell verification remains open under `docs/specs/20260721-worker_execution_environment_images.md`. The shared product-visible readiness projection can still report `ready` before provider/model compatibility and the fixed control-binary set are resolved; later AEP resolution fails closed, but this earlier false-ready projection keeps the specification Partial until the existing setup resolver owns both decisions.

## Scale Fields

The manifest may declare scale intent, but the scheduler owns actual placement.

Scale fields should include:

- max concurrent sessions
- idle timeout
- max turn duration
- queue priority class
- cost class
- session reuse policy
- warm pool intent

Workspace and server policy may restrict every scale field.

Scale intent fields should remain preferences and upper bounds. They must not select a backend, encode deployment or transport, name a concrete runtime target, force remote placement, allocate capacity, or bypass scheduler fairness. The scheduler owns placement plans, leases, queue order, warm-pool realization, and capacity records.

## Workspace-Local Agent Definitions

Workspace-local agent definitions are allowed only as policy-reviewed setup proposals.

The first supported model should be:

1. A workspace proposes a workspace-scoped `AgentManifest` catalog entry.
2. NanoCore validates schema, redaction, source references, capability declarations, vault references, sandbox requirements, and policy domain.
3. Required reviewers or policy rules accept, edit, reject, or defer the proposal.
4. Accepted workspace-local setup becomes a workspace-scoped `AgentManifest` catalog entry visible through the workspace catalog.
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
- Resolver tests proving the build form accepts only explicit `build-context://empty/v1` plus `sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`, preserves a nonempty inline 1-through-268,435,456-byte UTF-8 Dockerfile with its exact independent digest outside the empty-context digest, and rejects every other or missing context pair, invalid Dockerfile bound or digest, locator, or inference before effects.
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
- AgentManifest owns no `mode`, `deployment`, `transport`, or unstructured `runtimeConfig` field. It carries no NanoHost, Runtime Epoch, SSH, Gateway, NanoCore endpoint, direct worker endpoint, or transport credential. Server configuration and scheduler records select the one configured NanoHost, and the backend resolves only non-secret sandbox-local Integration bindings.
- The AEP launches only the generic `openkit-worker-shim`; `control.adapter.targetRuntime` is the sole opaque adapter selector, and `agent.runtimeKind` is descriptive.
- Authored runtime declarations own the exact governed image and non-empty runtime binary id and absolute worker-local path list. Authored sandbox declarations own exact network grants, credential declarations, and backend requirements, and materialization may only restrict them.
- The V1 authored build form names only the explicit empty-context singleton and its exact digest; the independently digested Dockerfile remains inline immutable content of 1 through 268,435,456 UTF-8 bytes and is not a context entry, and no Dockerfile locator, resolver default, alternate context reference, context transfer authority, configuration, or future variant exists.
- Launch-time capability advertisement is the intersection of manifest requirements and selected adapter and image proof. Required missing proof blocks launch, and optional unproven support remains unadvertised.
- Static MCP catalog bindings do not authorize runtime-native MCP config, direct worker connections, or executable routes.
- Shim and adapter records remain candidates until NanoCore validates and commits canonical product state.
- AEP snapshots are immutable launch contracts. Any material supply, policy, workspace, provider, vault, backend, or request change produces a new snapshot.
- Request, user, and workspace layers may select or restrict allowed supply. They must not expand server or workspace policy.
- Codex `0.144.1` and OpenCode `1.18.1` are relay-only for LLM authority. That route constraint excludes direct LLM provider credentials and endpoints but permits unrelated manifest-authored development grants. Pi `0.80.7` is direct-provider-only and accepts exactly Anthropic `claude-sonnet-4-5`. No adapter or resolver fallback exists between these envelopes.
- Current runtime-native launch details are adapter-derived outputs from AEP snapshots and are never stable product contracts; generated native files are not authorized by the current adapter interface.
- Readiness is a redacted pre-launch diagnostic with `ready`, `degraded`, `blocked`, and `stale` target states.
- Scale fields in manifests are intent. Scheduler records decide actual placement, queueing, reuse, and capacity.
- Host execution is not a valid worker AEP backend target.
- Workspace-scoped AEP snapshot metadata belongs in workspace-owned storage. Runtime/session directories may hold generated file-backed materialization copies and backend receipts.
- Compact or historical manifest shapes do not need compatibility preservation in this internal development phase.
- Workspace-local agent definitions may exist only as policy-reviewed `AgentManifest` proposals and accepted workspace-scoped `AgentManifest` catalog entries. Unreviewed workspace-local files are never launch contracts.
- Authored Skill and MCP constraints may use exact pins or policy-approved ranges, but the AEP snapshot must store exact resolved versions and digests. The first catalog-backed implementation should prefer exact pins until deterministic resolver evidence exists.
- Scale intent fields remain preferences or upper bounds; scheduler records own concrete placement, queueing, reuse, warm-pool realization, and capacity.
- Product-visible readiness remediation hints must be redacted and action-oriented.
- Manifest evolution changes the accepted current schema explicitly. Unknown fields and unsupported required features fail closed; no older-shape compatibility path is required.
- Authority-bearing manifest additions must declare required features, minimum Core version, required backend capabilities, or equivalent required semantics.

## Deferred / Future Work

- Policy-reviewed workspace-local agent definitions.
- Full readiness diagnostics with user-actionable remediation hints.
- Catalog-backed Skill and MCP resolution outside static in-code fixtures.
- Non-authorizing future review of generated native files and durable receipts if a concrete runtime later proves the current argv, environment, and state-path contract insufficient.

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
- `docs/specs/20260721-worker_execution_environment_images.md`
- `docs/specs/20260802-nanohost_runtime_and_transport.md`
