---
status: Accepted
implementation: Partial
updated: 2026-09-06
---
# Agent Manifest And AEP Resolution

## Summary

This specification defines the concrete `AgentManifest` schema and validation and its resolution into Agent Environment Package snapshots.

The target model is strict: one Server-supplied manifest, one Workspace binding when present, one selected nested profile, and applicable User preference compose one authored setup, not product truth. NanoCore resolves that setup with catalogs, grants, policy, runtime proof, placement, supply, and scheduling constraints into one `ResolvedAgentSetup` and then one immutable AEP snapshot for each worker session.

Core Agent Supply owns the authored `AgentManifest` concept. This specification owns its concrete schema and validation and its resolution into `ResolvedAgentSetup` and immutable AEP snapshots. Product-facing catalog summaries remain separate from launch manifests. Worker sessions launch from resolved AEP snapshots, not from catalog entries or authored files.

## Owns

- The concrete `AgentManifest` schema and validation for authored manifest inputs.
- The authored composition and resolution contract from Server Agent Manifest, Workspace binding, selected profile, User preference, request input, logical-model catalog, supply catalog, vault grants, policy decisions, and runtime backend capability into one launch snapshot.
- Resolution precedence, fail-closed behavior, readiness diagnostics, degraded state explanation, and snapshot identity rules.
- The implementation projection for current `.agent.jsonc` loading, setup resolution, runtime config reload handling, and OpenShell-backed AEP materialization.
- The boundary between authored setup fields and runtime-native argv, safe environment bindings, and isolated state paths derived inside the selected adapter.
- Manifest schema evolution, unknown-field handling, and required-feature fail-closed behavior.
- Copy-on-init built-in AgentManifest development grant templates, including the exact out-of-box five-grant table; later template edits do not mutate existing manifests.

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
- `docs/specs/20260721-worker_execution_environment_images.md`

## Goals

- Define the manifest fields that must be authored before worker launch.
- Define the resolution order from server config, workspace policy, user preference, and request input.
- Make skills, MCP, scale intent, workspace materialization, provider use, vault grants, and backend requirements first-class manifest sections without making the manifest a deployment record.
- Keep runtime-native launch details inside the selected adapter instead of authoring them as stable product contracts.
- Make readiness and degraded states explainable before launch.

## Non-goals

- Do not preserve compact or historical manifest shapes.
- Do not define Codex, OpenCode, or Pi Agent native config file formats.
- Do not turn catalogs, grants, policy evaluation, runtime proof, or materialization into an authored setup source.
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
Server AgentManifest plus Workspace binding, selected nested profile, and User preference
  -> one composed authored setup
  -> NanoCore ResolvedAgentSetup
  -> immutable AgentEnvironmentPackage
  -> WorkerGovernanceBackend launches the governed image and generic openkit-worker-shim
  -> shim selects one opaque worker-side adapter
  -> adapter prepares one runtime-native process and collects one bounded result
  -> shim emits candidate records
  -> NanoCore validates and commits canonical product state
```

No layer in this chain may infer a second runtime definition or become a parallel supply authority.

The manifest may be file-backed, built-in, server-provided, organization-provided, or future workspace-local. A Workspace binding is a co-equal authored composition input for the addressed Workspace and may add Workspace-owned resources, credential bindings, and runtime-compatible behavior. After composition, catalogs, grants, policy, runtime proof, governance materialization, and adaptation may validate, resolve, or restrict but cannot author missing setup.

## Manifest Sources

Server-owned sources:

- `DATA_ROOT/config/agents/<agentId>.agent.jsonc`
- built-in agent templates shipped by OpenKit
- server provider registry and model catalog
- server skill and MCP catalogs
- server scheduler and backend topology inputs used only during resolution

Workspace-owned sources:

- Agent bindings that reference a Server Manifest and compose Workspace-owned settings and resources
- workspace input roots
- workspace-specific Skill and MCP supply
- credential-requirement bindings
- logical-model visibility and preference
- workspace resource limits and context rules

User-owned sources:

- default agent or profile preference
- logical-model preference for the Workspace and selected Agent
- notification and consent preferences

Request-owned inputs:

- selected agent
- selected profile
- task-time context hints
- requested resource class
- requested workspace roots

Request input may select or restrict. It must not grant new capabilities.

Request input may select only a target and resources available through the current composed setup and owning catalogs. A new Workspace resource or authority requirement must enter through Workspace-authored composition before request resolution, never through an arbitrary request field.

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
models
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

Resolution treats the two forms identically in every other respect: the authored selection is preserved without inference, resolved into one immutable AEP, and materialized by the backend. A reference whose `ref` is one canonical lowercase `sha256:` digest and whose pull policy is `never` names a deployment image already admitted to the NanoHost Image Store and imported during readiness; the backend passes that digest directly to `sandbox.create` and MUST NOT emit `image.acquire`, while every other reference is materialized through the existing acquisition owner. Absence or corruption of that preloaded deployment digest remains a NanoHost readiness failure and creates no runtime fallback. Under V1 the build-context singleton is explicit authored input, not a resolver default: its zero-entry canonical byte sequence is exactly empty bytes, the 1-through-268,435,456-byte UTF-8 Dockerfile remains inline immutable package content with a lowercase SHA-256 over exactly those bytes, is independently digested, and is excluded from the context digest, and any missing or different context pair, empty or oversized Dockerfile, invalid UTF-8, or Dockerfile digest mismatch is rejected before a scheduler or backend effect. Pull policy applies only to the reference form and is meaningless under the build form, so a manifest that supplies both a build definition and a pull policy is rejected rather than silently ignoring one. A build egress set that is absent, unbounded, or wildcard-hosted is rejected; whether a specific endpoint may appear in that set remains a workspace-policy decision under its existing owner. The image selection remains a discriminated union in the resolved package; the package owner has since moved the complete clean logical-model envelope to `schemaVersion: 4`. V1 defines no Dockerfile locator, context locator variant, transfer authority, configuration input, dependency, compatibility form, or future extension placeholder.

The generic authored build arm, resolved build arm, and resolver path implement the exact authored `build-context://empty/v1` plus `sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`, prove that digest from the zero-entry empty-byte context, keep the Dockerfile excluded from that digest, enforce its nonempty 268,435,456-byte UTF-8 ceiling and exact digest, and reject every invalid input before effects.

`mode`, `deployment`, `transport`, and an unstructured `runtimeConfig` are not AgentManifest areas and must be rejected as unknown fields. They neither select local versus remote placement nor carry a NanoHost identity, NanoHost credential, Runtime Epoch identity, local command, SSH target, Gateway origin, NanoCore endpoint, direct worker endpoint, transport credential, or native runtime configuration. Server configuration and scheduler records select the one configured NanoHost; the backend resolves only sandbox-local Integration bindings for the accepted worker package. No agent-authored field may select or widen that topology.

`profiles` define behavior modes. A profile may replace scalar behavior preferences and extend identified behavior lists that the manifest declares composable, including instructions, logical-model choices, Skills, MCP supply, context, and resource preferences. It cannot add a runtime family, network or credential authority, backend requirement, or other security-sensitive supply absent from the composed authored setup.

`models` declares one preferred logical model ID and either a non-empty stable-ID allowlist or the exact sentinel `all`. `all` expands once at composition time to the exact logical models currently available to the Workspace through the Gateway catalog, and that closed expansion is recorded in the composed setup and immutable AEP. A later Gateway catalog addition does not mutate an admitted AEP or running process; it enters an `all` setup only when a later composition creates a new AEP. Provider profile IDs, provider-native model IDs, account slots, concrete routes, route members, and fallback order are forbidden in an Agent Manifest and remain Gateway-private.

`skills` declares catalog refs, version constraints, placement mode, and runtime adapter compatibility.

`mcp` declares only named catalog refs and their requested visibility or tool constraints. It must not contain server transports, commands, endpoints, credentials, or a runtime-native execution route. Resolved entries remain static AEP supply metadata until the governed `capability.local` MCP plane owned by `docs/specs/20260704-worker_mcp_tool_supply.md` is implemented and proven.

`capabilities` declares required and optional runtime capability ids. It does not declare callable routes; launch advertisement is computed by intersecting these requirements with selected adapter and image proof.

`workspace` declares workspace roots, inputs, generated files, mounts, output roots, and snapshot exclusions.

The authored workspace section declares needs, not backend mount implementation.

Endpoint-bearing sources are not declared inline. The manifest references entries from the workspace data source catalog by `sourceRef` with optional narrowing, per `docs/specs/20260704-workspace_data_source_catalog.md`; only workspace-relative files and directories, generated content, and OpenKit artifact references may remain inline. Manifests never carry endpoints or credential material.

Resolution must turn workspace declarations into a session-static workspace layout plus turn-dynamic materialization requirements when a worker session is launched, joining `sourceRef` entries with the catalog, vault grants, and policy; the AEP snapshot records the resolved source ids and catalog entry digests.

`context` declares allowed context package categories and task-time injection hints.

`vault` declares credentials without secret values. A Server-only manifest may directly name a Server-scope VaultGrant. A reusable manifest instead declares a stable `requirementId`, purpose, target, visibility, injection mode, and whether it is required; `workspace.jsonc` binds that ID to one Workspace-scope VaultGrant. Missing, duplicate, wrong-scope, wrong-target, expired, revoked, or incompatible required binding blocks readiness before runtime effects.

`policy` declares required actions, approval points, and policy domains touched by this agent.

`sandbox` declares exact network grants, credential requirements or Server-scope direct declarations, and backend requirements. Each network grant identifies its host, port, protocol, purpose, and a non-empty explicit binary-path list plus either one access mode or a non-empty bounded REST rule list; omission never means every runtime binary, and every listed path must exactly match a path declared in `runtime.binaries`. Exact REST rules currently allow `GET` or `POST` with absolute OpenShell-compatible paths and cannot be combined with an access preset. Credential entries use the `vault` requirement contract plus allowed visibility and injection mode without secret values. Backend requirements may identify allowed and preferred backend kinds plus required capabilities only as eligibility constraints; they never name or select a NanoHost, backend instance, Runtime Epoch, local or remote placement, SSH target, Gateway origin, NanoCore endpoint, direct worker endpoint, route credential, or transport.

NanoCore may restrict these declarations during resolution, but neither NanoCore nor a backend may add an endpoint, credential path, credential materialization, binary allow rule, or backend capability that the authored manifest and policy did not authorize. Backend environment variables, built-in endpoints, and deployment defaults must not expand the effective allowlist.

Image contents, OCI labels, and carrier markers confer no network or credential authority. `control.adapter.targetRuntime` selects exactly one adapter per session. A worker runtime is dispatch-ready only when its adapter can consume the Gateway relay with worker-visible logical model IDs and no concrete LLM Provider credential; the prior direct-provider Pi route is not dispatchable under this target. This Gateway-only rule applies to LLM inference authority, not to every networked tool. An exact authored Sandbox network grant may let its explicitly named runtime binary call the declared non-LLM tool or service endpoint, including an endpoint authenticated by a separately resolved Workspace credential, but it grants no Provider endpoint, Provider credential, logical-model route, or inference bypass.

## Built-In Development Grant Templates

The repository-owned built-in AgentManifest templates copy the same out-of-box development grants at init. Those templates are copy-on-init content: a later edit of this table or of a template file does not mutate an already-created manifest, and a missing grant fails as a denied network operation rather than being inferred from the image or from a hidden shared allowlist.

| Grant | Endpoint | Exact access | Authorized binaries |
| --- | --- | --- | --- |
| GitHub Smart HTTP read (`github-git-read`) | `github.com:443` | `GET /**/info/refs*` and `POST /**/git-upload-pack` | `/usr/bin/git` |
| GitHub REST read (`github-rest-read`) | `api.github.com:443` | OpenShell `read-only` REST access | `/usr/local/bin/gh` |
| npm package read (`npm-registry-read`) | `registry.npmjs.org:443` | OpenShell `read-only` REST access | Node, npm, npx, pnpm, and pnpx paths declared by the manifest |
| PyPI index read (`pypi-index-read`) | `pypi.org:443` | OpenShell `read-only` REST access | uv and the writable virtual-environment Python and pip paths declared by the manifest |
| PyPI artifact read (`pypi-files-read`) | `files.pythonhosted.org:443` | OpenShell `read-only` REST access | The same Python tool paths |

The Git grant deliberately omits `POST /**/git-receive-pack`, so clone, fetch, and pull are available while push is denied. No grant in this table names a mise supply host, language distribution server, release archive host, or registry mirror that exists only to serve a mise provision. Installed image tools confer no authority; a provision against an ungranted host fails denied.

An authored AgentManifest may add a narrower present-use grant when the generic sandbox policy permits it. Missing endpoints fail as a denied network operation, unsupported exact-rule shapes fail before sandbox creation, missing declared binaries fail manifest validation, and backend inability to enforce a grant blocks launch rather than widening access.

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

1. Select exactly one Server-owned or built-in `AgentManifest`; file order is never a fallback, and a missing explicit, User, Workspace, or Server selection is a typed configuration error.
2. Validate the Manifest, applicable Workspace binding, User preference, and request fields against their strict schemas and supported required features.
3. Select one nested profile and compose the Manifest, Workspace binding, profile, and User preference into one authored setup with field-level provenance.
4. Resolve the preferred and allowed logical-model set, expanding `all` from the current Workspace-visible Gateway catalog and rejecting an empty, stale, or incompatible set.
5. Attach logical-model, Skill, MCP, Vault, Workspace-resource, and runtime catalogs only to resolve references or prove support; catalogs do not supply missing authored declarations.
6. Validate request selections against the composed setup without deriving Agent identity from logical model identity.
7. Resolve the authored opaque adapter, governed image, and declared runtime binary paths without runtime-specific inference.
8. Resolve Skill and MCP catalog entries as static supply metadata.
9. Bind every credential requirement to an exact Server or Workspace VaultGrant and resolve injection visibility and target without secret values.
10. Resolve exact Sandbox network, credential, and backend requirements without accepting manifest-owned placement, NanoHost, endpoint, credential, or transport topology.
11. Resolve Workspace materialization inputs and output roots.
12. Resolve the session-static Workspace layout, Workspace slots, and session compatibility envelope.
13. Resolve resource and scale policy.
14. Evaluate permission and policy requirements.
15. Intersect manifest capability requirements with selected adapter and image proof, including Gateway-relay compatibility.
16. Negotiate backend capability requirements without widening the resolved Sandbox envelope.
17. Produce ready, degraded, or blocked diagnostics.
18. Mint an immutable AEP snapshot for launch.

The resolver must fail closed when a requested field is ambiguous.

The resolver must also fail closed when a manifest declares an unsupported required feature, required backend capability, required mount kind, required source kind, required credential materialization mode, required vault injection mode, or required worker-visible capability family; when a network binary path does not match a declared runtime binary; or when required adapter or image capability proof is missing.

Optional capabilities without adapter and image proof remain unadvertised. Neither the adapter nor the image catalog may publish a second capability authority.

Resolution is deterministic. The same inputs, catalogs, policy snapshots, vault grants, backend capability summary, workspace roots, and request selections must produce the same resolved setup and AEP content digest.

User, Workspace, and Server values are precedence inputs only where a field's owner defines a preference. Composition of Workspace-owned resources is additive by stable identity and remains visible in provenance; it is not reduced to an intersection with Server defaults. Ordinary authorization, compatibility, runtime proof, and capacity may still reject the resulting setup through their own owners.

## AEP Snapshot

The AEP snapshot must carry:

- package snapshot id
- schema version
- lineage ids
- selected agent and profile
- preferred logical model ID and exact allowed logical-model IDs with each model's Gateway-derived effective capabilities and `modelFamilyId`
- descriptive runtime kind
- selected governed image selection, which is either the image reference with its pull policy or the resolved build definition and its build egress set
- generic `openkit-worker-shim` command
- `control.adapter.kind: openkit-worker-shim` and the sole opaque adapter selector in `control.adapter.targetRuntime`
- exact declared runtime binary ids and absolute worker-local paths
- selected backend kind and capability requirements without a NanoHost, host, Runtime Epoch, Gateway, SSH, or remote endpoint identity
- backend capability requirements
- one non-secret Sandbox-local inference Integration binding without a Provider profile, provider-native model, account slot, or private route
- resolved skill supply
- resolved MCP catalog metadata without an executable route
- resolved capability intersection and missing-proof diagnostics
- non-secret sandbox-local Integration route bindings and distinct worker-control, inference, and capability token references resolved by the backend, never authored by the manifest
- exact resolved network and credential policy with requirement-to-grant provenance and no secret values
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

The backend materializes the governed image, exact policy, Vault bindings, Workspace, package file, and non-secret Sandbox-local Integration bindings without widening the AEP. The worker package never receives a concrete LLM Provider profile, provider-native model, account slot, private Gateway route, configured NanoHost credential, raw route token, Runtime Epoch identity, remote NanoCore or Gateway address, SSH target, Gateway forward, or direct sandbox-to-NanoCore endpoint. Inside the image, the generic shim selects the statically registered adapter named by `targetRuntime`; the adapter derives only runtime-native argv, safe child environment additions, and isolated state-root paths from the resolved AEP. A runtime that cannot consume the logical-model relay through this contract is blocked as non-ready rather than receiving a direct-provider exception.

An AEP MCP catalog record carries only worker-safe selected supply metadata and enables the three governed MCP capability operations. The delivered Codex adapter may derive fixed loopback MCP URLs and the capability token environment-key name from that selection, but no AEP record generates an upstream command, upstream endpoint, credential reference, credential, or direct worker-to-server connection; packages without selected MCP supply keep the plane disabled.

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

- unavailable logical model or private Gateway route
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

- `/openkit/sessions/<agent-session-id>/config/package.json`
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

The current implementation follows the composed logical-model contract:

- `packages/config-schema/src/agent.ts` strictly validates `schemaVersion: 1` `.agent.jsonc` files and rejects historical top-level `provider`, `mode`, `deployment`, `transport`, and unstructured `runtimeConfig` fields. An authored runtime supplies an opaque kind and adapter, one exact image reference or bounded build, and a non-empty list of absolute worker-local binary paths.
- Each manifest declares one preferred logical model and either an admitted logical-model list or `all`, plus optional nested profiles. It owns exact sandbox network grants, reusable or Server-direct credential declarations, backend eligibility requirements, Skills, and MCP supply. No manifest field selects a concrete Provider route, local or remote placement, an SSH target, a Gateway origin, or transport credentials.
- `apps/nanocore/src/agents/setup-resolver.ts` composes the Server manifest, Workspace Agent binding, selected profile, applicable User preference, and explicit request choice. Stable-ID resources extend or override their named owner; missing required credential bindings, disallowed logical models, missing profiles, unavailable Gateway models, and unsupported required features fail closed.
- The same reusable credential requirement may bind to different Workspace-scoped VaultGrants in different Workspaces. `apps/nanocore/src/agents/setup-ledger.ts` stores the redacted resolved requirement and grant provenance without secret material.
- `apps/nanocore/src/runtime/agent-environment.ts` preserves the manifest-authored image, runtime binaries, sandbox envelope, adapter id, logical Gateway preference, and static supply through one generic OpenShell AEP resolver. It emits only the fixed zero-argument `openkit-worker-shim` command with ignored stdin, and workers receive no private Provider profile, upstream model, route, or credential identity.
- The OpenShell materializer compiles network and credential policy only from the immutable AEP. NanoHost carries resolved backend-private runtime-file and runtime-env credentials to their exact sink; missing or failing sinks create no success receipt. Provider-attachment materialization remains fail-closed until its exact provider endpoint and policy equivalence are supported.
- `packages/worker-shim` selects one adapter from its static registry. The shared contract remains `prepare` and `collect`; adapters derive native argv, safe child environment, isolated state-root paths, and one bounded normalized result. It has no dynamic plugin loader, runtime compatibility fallback, or second control plane.

Current production selects only the configured NanoHost RuntimeTarget and resolves capability, worker-control, and inference as sandbox-local Integration bindings. One Sandbox Integration may route commands to multiple compatible Harness Instances in the same Sandbox, while each AgentSession remains owned by exactly one Thread. The authored manifest remains topology-free, and NanoHost transport, Runtime Epoch lifecycle, Sandbox placement, and route realization stay with their narrow owners.

This specification remains `Partial` for the explicitly deferred callable-capability, provider-attachment, image real-use, and readiness evidence named below, not for concrete Provider/model configuration or Workspace/User composition.

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

An Agent binding in `workspace.jsonc` that references a Server Manifest and composes Workspace-owned settings is ordinary authored composition under this specification. It is not a Workspace-local Agent definition and does not require the proposal lifecycle below.

Workspace-local agent definitions are allowed only as policy-reviewed setup proposals.

The first supported model should be:

1. A workspace proposes a workspace-scoped `AgentManifest` catalog entry.
2. NanoCore validates schema, redaction, source references, capability declarations, vault references, sandbox requirements, and policy domain.
3. Required reviewers or policy rules accept, edit, reject, or defer the proposal.
4. Accepted workspace-local setup becomes a workspace-scoped `AgentManifest` catalog entry visible through the workspace catalog.
5. Launch still resolves through the same manifest-to-AEP pipeline and remains subject to ordinary authorization, runtime support, compatibility, containment, and capacity owners.

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

An MCP catalog binding is non-executable metadata. It must not carry an upstream command, native config target, direct server endpoint, credential reference, or credential; only exact selected supply enables the fixed governed `capability.local` MCP route after current package, token, catalog, policy, and schema validation.

The first catalog-backed worker-supply implementation should prefer exact pins until the catalog resolver records enough lockfile-style evidence to make ranges deterministic and replayable. Ranges become acceptable only when resolution writes the exact version and digest into the AEP snapshot.

## Alternatives Considered

### Use Agent Manifest Directly At Launch

Rejected. It makes authored config responsible for runtime policy, catalog resolution, and backend capability negotiation.

### Generate Native Runtime Config As The Product Contract

Rejected. Native config differs by runtime and would leak Codex, OpenCode, OpenShell, or future backend details into OpenKit semantics.

### Let Workspace Config Define Unrelated Full Agents Without Review

Rejected. Workspace binding and extension of referenced Server supply is accepted authored composition, but defining an unrelated full Workspace-local Agent Manifest remains a separate proposal whose review lifecycle is stated above.

## Testing Strategy

- Schema tests for valid and invalid manifests.
- Schema evolution tests for unknown optional fields and unsupported required features.
- Resolver fixture tests for server, workspace, user, and request layers.
- Composition tests proving Workspace bindings can add Workspace-owned identified resources and replace permitted preferences while catalogs, policy, runtime proof, and materialization remain non-authoring and fail closed on unsupported or unauthorized results.
- Readiness tests for missing provider, missing vault grant, missing MCP catalog entry, and missing backend capability.
- Snapshot tests proving AEP identity changes when material inputs change.
- Shim tests proving current runtime-native argv, environment, and state paths are derived from AEP inputs without an adapter-authored file envelope.
- Boundary tests proving `runtime.command.argv` always launches `openkit-worker-shim`, `control.adapter.targetRuntime` is the only adapter selector, and `agent.runtimeKind` never selects code.
- Resolver tests proving exact authored image and runtime binary declarations reach the AEP without a runtime-specific NanoCore branch.
- Resolver tests proving the build form accepts only explicit `build-context://empty/v1` plus `sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`, preserves a nonempty inline 1-through-268,435,456-byte UTF-8 Dockerfile with its exact independent digest outside the empty-context digest, and rejects every other or missing context pair, invalid Dockerfile bound or digest, locator, or inference before effects.
- Sandbox tests rejecting network binary paths absent from `runtime.binaries` and rejecting any backend, deployment default, or environment variable that widens resolved network or credential authority.
- Capability tests proving launch advertisement is the manifest requirement intersection with adapter and image proof, required missing proof blocks launch, and optional unproven support stays unadvertised.
- MCP tests proving unselected or disabled catalog records generate no native config, connection, or route, while exact selected supply generates only fixed loopback Codex MCP projection and never an upstream command, endpoint, or credential.
- Candidate-record tests proving shim and adapter output is not canonical until NanoCore validates and commits it.
- Reload tests proving a changed composed package does not mutate the active Turn or AEP, enters only a later Turn, and is read by the next per-Turn Codex child while that child resumes the exact native handle from AgentSession-private state. Any implemented adapter that retains a native process between Turns must separately prove in-place application or refuse reuse under its accepted runtime contract.
- Redaction tests proving readiness diagnostics, AEP snapshots, generated files, and backend extensions do not expose secrets, host paths, or backend-private tokens.
- Fail-closed tests proving unsupported mount kinds, credential materialization modes, vault injection modes, and capability families block launch when required.

## Risks & Mitigations

- Risk: Manifest surface becomes too large. Mitigation: keep most fields optional and use catalogs for reusable detail.
- Risk: Profiles become sub-agents with their own hidden policies. Mitigation: profiles may extend only the identified behavior lists that the manifest marks composable and may reference only resources in the composed catalogs; runtime, network, credential, policy, and backend authority cannot widen through a profile.
- Risk: Scale settings are mistaken for scheduler commands. Mitigation: manifest declares intent; scheduler records the actual placement plan.
- Risk: MCP supply bypasses NanoCore. Mitigation: manifests and AEPs carry only static catalog bindings; executable MCP access exists only through the separately governed `capability.local` plane after that plane is implemented and proven.

## Resolved Decisions

- Authored manifests are setup inputs, not product truth.
- Catalog entries are selection and explanation surfaces, not launch manifests.
- One authored `AgentManifest` with one selected nested behavior profile resolves through one `ResolvedAgentSetup` into one immutable AEP; no runtime-oriented profile or inferred runtime may become a parallel source.
- AgentManifest owns no `mode`, `deployment`, `transport`, or unstructured `runtimeConfig` field. It carries no NanoHost, Runtime Epoch, SSH, Gateway, NanoCore endpoint, direct worker endpoint, or transport credential. Server configuration and scheduler records select the one configured NanoHost, and the backend resolves only non-secret sandbox-local Integration bindings.
- The AEP launches only the generic `openkit-worker-shim`; `control.adapter.targetRuntime` is the sole opaque adapter selector per session, image contents confer no adapter or credential authority, and `agent.runtimeKind` is descriptive.
- Authored runtime declarations own the exact governed image and non-empty runtime binary id and absolute worker-local path list. Authored sandbox declarations own exact network grants, credential declarations, and backend requirements, and materialization may only restrict them. The five out-of-box development grants are copy-on-init template content owned here; later template edits do not mutate existing manifests.
- The V1 authored build form names only the explicit empty-context singleton and its exact digest; the independently digested Dockerfile remains inline immutable content of 1 through 268,435,456 UTF-8 bytes and is not a context entry, and no Dockerfile locator, resolver default, alternate context reference, context transfer authority, configuration, or future variant exists.
- Launch-time capability advertisement is the intersection of manifest requirements and selected adapter and image proof. Required missing proof blocks launch, and optional unproven support remains unadvertised.
- Static MCP catalog bindings alone do not authorize runtime-native MCP config, direct worker connections, or executable routes; only exact selected AEP supply authorizes the fixed governed MCP capability projection.
- Shim and adapter records remain candidates until NanoCore validates and commits canonical product state.
- AEP snapshots are immutable launch contracts. Any material supply, policy, workspace, provider, vault, backend, or request change produces a new snapshot.
- Server Manifest, Workspace binding, selected profile, and User preference compose one authored setup before resolution. Workspace composition may add Workspace-owned resources; catalogs, grants, policy, runtime proof, governance materialization, and adaptation remain non-authoring.
- Codex `0.153.4` and OpenCode `1.18.1` are relay-only for LLM authority. Direct LLM Provider credentials and endpoints are excluded from dispatchable worker supply. Pi `0.85.1` remains direct-provider-only in the current implementation and is therefore non-ready in the clean logical-model target until an accepted relay-capable adapter replaces that constraint.
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
