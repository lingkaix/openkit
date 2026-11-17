---
status: Accepted
implementation: Partial
kind: boundary
aspect: agent-supply
---
# Agent Manifest And AEP Resolution

This specification owns the AgentManifest schema and its resolution into one immutable package for each admitted Turn.

## Scope

Owns authored composition, resolution precedence, readiness diagnostics, copy-on-init development grants, and the boundary between public native environment settings and adapter-derived launch.

Does not own the AEP envelope. [Agent Environment Package](20260616-agent_environment_package.md) owns it.

Does not own scheduler placement. [Runtime Scheduling And Scale](20260703-durable_scheduler_design.md#scale-limits) owns it.

Does not own Skill version storage. The Skill catalog owns exact versions.

Does not own Vault material. [Vault](20260703-vault_secret_injection.md) owns delivery.

Does not own product catalog summaries.

Core: [Agent Supply](../core/agent-supply.md), [Runtime Model](../core/runtime-model.md), [Policy](../core/policy.md).

## Decision

Use three records:

- `AgentManifest`: the Core-owned authored declarative setup concept for one agent supply unit, with its concrete schema and validation owned by this specification.
- `ResolvedAgentSetup`: NanoCore's policy-checked resolved setup before launch.
- `AgentEnvironmentPackage`: the immutable launch snapshot materialized into the worker runtime.

Only the AEP snapshot is used to dispatch an admitted Turn. The AgentSession keeps the physical input slots. A new snapshot does not by itself replace the AgentSession, Harness Instance, Sandbox, or native process.

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

The accepted selection and persistent-preference rationale is recorded in [Login Preference And New-Turn Selection](../decisions/20261111-login_preference_new_turn_selection.md).

The manifest may be file-backed, built-in, server-provided, organization-provided, or future workspace-local. A Workspace binding is a co-equal authored composition input for the addressed Workspace and may add Workspace-owned resources, credential bindings, and runtime-compatible behavior. After composition, catalogs, grants, policy, runtime proof, governance materialization, and adaptation may validate, resolve, or restrict but cannot author missing setup. A composed Codex Login requirement keeps its authored preferred grant; the governed Vault replacement path may resolve a different eligible grant for that same requirement into a new Turn’s AEP. In v0.1.0, explicit preference changes require a currently authorized deployment administrator using the existing `runtime.file-update` and successful `runtime.reload` path, with the binding-change Audit owned by file publication. They apply to Turns composed from the installed reload snapshot; a save alone is not active, and queued dispatch keeps its captured snapshot under the existing snapshot/currentness contract. Ordinary Users, Workspace members and agents acquire no configuration-write authority. Existing AEPs remain immutable.

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

`AuthoredAgentConfigSchema` in `packages/config-schema/src/agent.ts` is the admitted authored manifest. Future plugin, scale, and MCP constraint targets stay explicit rules below and in Implementation Gaps. The current artifact's lack of those fields does not erase them.

`runtime` declares an opaque `kind`, an opaque `adapter`, an optional pinned `version`, one governed image selection, and a non-empty list of runtime binary ids with absolute worker-local executable paths. NanoCore must preserve these declarations generically; it must not infer an image, adapter, or binary path from `kind`.

Resolve a selected retained environment's exact administrator-admitted image in place of the manifest's default image before immutable setup and compatibility planning. The manifest image remains active default supply for work without an explicit template choice. Both use one existing resolved-setup/AEP path. All non-image authority remains manifest/policy-owned; incompatible adapter, runtime, binary, layout or required capability/policy proof refuses. No user-supplied image, host or grant override is admitted. [Persistent Worker Volumes](20260910-persistent_worker_volumes.md) owns template publication, pinned-image lifecycle and current eligibility; [User-Selected Workspace-Shared Sandboxes](../decisions/20261008-user_selected_workspace_shared_sandboxes.md) records the changed image-selection boundary.

`runtime.environment` is optional Agent-scoped authored non-secret native process configuration, not native argv or launch authority. It is a map of at most 128 ASCII identifiers matching `^[A-Za-z_][A-Za-z0-9_]*$` and no longer than 128 characters to NUL-free literal strings or null, bounded to 16 KiB of canonical compact UTF-8 JSON. A string, including an empty string, sets a value; null suppresses that image default; an omitted entry inherits it. No interpolation, executable source, credential reference or implicit file read is supported.

Only the existing Server Agent configuration owns this map in this slice. Profiles, Workspace bindings, requests and Threads introduce no additional environment override layer. A task-specific Sandbox may select an exact administrator-admitted template image through its retained-resource reference under [Persistent Worker Volumes](20260910-persistent_worker_volumes.md); this supplies no per-Thread environment-value override. Changing a shared Agent's authored map still affects all later admissions using it, and the preview states that scope.

Resolution combines verified digest-bound non-secret image defaults, then authored Agent overrides and removals, then protected runtime bindings. Credential targets are disjoint from public settings. An explicit protected-name or credential-target override, duplicate/invalid input, oversized map or missing required image evidence blocks resolution; no source silently wins an authority conflict. Harmless names outside the protected core require no package-specific platform registration.

The decision and its reason are recorded in [a decision record](../decisions/20260930-native_environment_managed_outside_the_sandbox.md).

The image selection is exactly one of two authored forms, matching the two forms the package owner accepts in `docs/specs/20260616-agent_environment_package.md`:

- one exact governed `image.ref` with pull policy; or
- one build definition declaring the exact literal context reference `build-context://empty/v1`, its exact digest `sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`, one independent nonempty inline Dockerfile build input encoding 1 through 268,435,456 exact UTF-8 bytes with its lowercase SHA-256, build arguments, and a bounded build egress grant set.

Resolution treats the two forms identically in every other respect: the authored declaration and provenance are preserved without inference. The selected retained Sandbox supplies its verified exact image pin when present; otherwise the manifest declaration resolves into one immutable AEP and is materialized by the backend. No template edit rewrites an admitted package or resource pin. A reference whose `ref` is one canonical lowercase `sha256:` digest and whose pull policy is `never` names exact content already admitted to the NanoHost Image Store. Both preparation and ordinary materialization MUST request `image.acquire` for that local digest before read-only inspection and `sandbox.create`, so a fresh empty backend imports retained content without a registry lookup or build. Missing or corrupt content fails only the dependent operation and is not a NanoHost readiness failure. Other references follow the existing exact registry acquisition owner; image layout and exact resolved identity remain mandatory before execution. Under V1 the build-context singleton is explicit authored input, not a resolver default: its zero-entry canonical byte sequence is exactly empty bytes, the 1-through-268,435,456-byte UTF-8 Dockerfile remains inline immutable package content with a lowercase SHA-256 over exactly those bytes, is independently digested, and is excluded from the context digest, and any missing or different context pair, empty or oversized Dockerfile, invalid UTF-8, or Dockerfile digest mismatch is rejected before a scheduler or backend effect. Pull policy applies only to the reference form and is meaningless under the build form, so a manifest that supplies both a build definition and a pull policy is rejected rather than silently ignoring one. A build egress set that is absent, unbounded, or wildcard-hosted is rejected; whether a specific endpoint may appear in that set remains a workspace-policy decision under its existing owner. The image selection remains a discriminated union in the resolved package; the package owner has since moved the complete clean logical-model envelope to `schemaVersion: 4`. V1 defines no Dockerfile locator, context locator variant, transfer authority, configuration input, dependency, compatibility form, or future extension placeholder.

The generic authored build arm, resolved build arm, and resolver path implement the exact authored `build-context://empty/v1` plus `sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`, prove that digest from the zero-entry empty-byte context, keep the Dockerfile excluded from that digest, enforce its nonempty 268,435,456-byte UTF-8 ceiling and exact digest, and reject every invalid input before effects.

`mode`, `deployment`, `transport`, and an unstructured `runtimeConfig` are not AgentManifest areas and must be rejected as unknown fields. They neither select local versus remote placement nor carry a NanoHost identity, NanoHost credential, Runtime Epoch identity, local command, SSH target, Gateway origin, NanoCore endpoint, direct worker endpoint, transport credential, or native runtime configuration. Server configuration and scheduler records select the one configured NanoHost; the backend resolves only sandbox-local Integration bindings for the accepted worker package. No agent-authored field may select or widen that topology.

`profiles` define behavior modes. A profile may replace scalar behavior preferences and extend identified behavior lists that the manifest declares composable, including instructions, logical-model choices, Skills, MCP supply, context, and resource preferences. It cannot add a runtime family, network or credential authority, backend requirement, or other security-sensitive supply absent from the composed authored setup.

`models` declares one preferred logical model ID and either a non-empty stable-ID allowlist or the exact sentinel `all`. `all` expands once at composition time to the exact logical models currently available to the Workspace through the Gateway catalog, and that closed expansion is recorded in the composed setup and immutable AEP. A later Gateway catalog addition does not mutate an admitted AEP or running process; it enters an `all` setup only when a later composition creates a new AEP. Provider profile IDs, provider-native model IDs, account slots, concrete routes, route members, and fallback order are forbidden in an Agent Manifest and remain Gateway-private.

`models.reasoningEffort` is an optional Agent default from the [canonical reasoning-effort enum](20261021-protocol_identifiers_and_enums.md#canonical-enums), composed with the existing selected-profile scalar preference rules. An explicit submission's `reasoningEffort` wins over that default; omission of both leaves the Turn's recorded effort absent. Runtime retention on such a Turn follows [AEP delivery](20260616-agent_environment_package.md#reasoning-effort-projection-and-delivery), under [the effort-retention decision](../decisions/20261001-reasoning_effort_retention.md). Neither omission nor a model with undeclared effort options fabricates a level. The admitted value is recorded on the Turn under [Core Protocol](../core/protocol.md#turn-reasoning-effort) and projected into the immutable AEP under [its owner](20260616-agent_environment_package.md#reasoning-effort-projection-and-delivery). The decision and its reason are recorded in [the reasoning-effort decision record](../decisions/20261001-reasoning_effort_rulings.md).

Creating, changing, or removing this default uses the existing authored Agent revision/reload and composition lifecycle. Invalid core effort values fail before launch; stale edits retain the accepted source. Changes affect only later admissions, and retained Agent files without the field remain usable without migration or a compatibility reader. Restart composes current defaults for new work; replay or recovery of an admitted Turn preserves its recorded choice. Missing model metadata or failed dependencies follow existing setup failures, not an invented effort or a new lifecycle. Acceptance requires submission → composed Agent default with no recorded value when both are omitted, selected-profile composition, invalid-value refusal, unchanged admitted Turns after edits, and retained omission without promising a native reset to default.

`plugins` declares scoped installation references and explicit member overrides under `docs/specs/20260907-agent_plugin_packaging_and_worker_supply.md`. Workspace binding and profile composition expand selected installations into Skill/MCP references before resolution, preserving exact membership and source provenance. Repeated identical references deduplicate; conflicting exact selections fail unless an authored override explicitly resolves the member. Expansion supplies no missing runtime, binary, network, credential, or policy authority.

`skills` declares scoped catalog references, optional exact versions, placement mode, and runtime adapter compatibility. Version selection follows the independent Skill owner; ranges and implicit upgrades are outside this target.

`mcp` declares only named catalog references, optional exact configuration constraints, and requested visibility or tool constraints. It must not contain server transports, commands, endpoints, credentials, or a runtime-native execution route. Each exact constraint must match the component owner's current selection; it does not create a per-version server instance. Resolved entries enable only the governed `capability.local` MCP plane owned by `docs/specs/20260704-worker_mcp_tool_supply.md`.

`capabilities` declares required and optional runtime capability ids. It does not declare callable routes; launch advertisement is computed by intersecting these requirements with selected adapter and image proof.

`workspace` declares workspace roots, inputs, generated files, mounts, output roots, and snapshot exclusions.

The authored workspace section declares needs, not backend mount implementation.

Endpoint-bearing sources are not declared inline. The manifest references entries from the workspace data source catalog by `sourceRef` with optional narrowing, per `docs/specs/20260704-workspace_data_source_catalog.md`; only workspace-relative files and directories, generated content, and OpenKit artifact references may remain inline. Manifests never carry endpoints or credential material.

Resolution must turn workspace declarations into a session-static workspace layout plus turn-dynamic materialization requirements for each admitted Turn, joining `sourceRef` entries with the catalog, vault grants, and policy; the AEP snapshot records the resolved source ids and catalog entry digests.

`context` declares allowed context package categories and task-time injection hints.

`vault` declares credentials without secret values. A Server-only manifest may directly name a Server-scope VaultGrant. A reusable manifest instead declares a stable `requirementId`, purpose, target, visibility, injection mode, and whether it is required; `workspace.jsonc` binds that ID to one Workspace-scope VaultGrant. Missing, duplicate, wrong-scope, wrong-target, expired, revoked, or incompatible required binding blocks readiness before runtime effects, subject only to the Codex Login replacement rule below. That rule still requires an authored binding and never selects an invalid grant. For a composed Codex Login requirement, the authored grant is the first eligible preference and [governed replacement](20260703-vault_secret_injection.md#selection-and-activation) may resolve a different current exact Workspace grant at a new Turn boundary. Every new AEP still resolves exactly one grant for the requirement, and a retained AEP is never changed. No other credential requirement gains a fallback.

`policy` declares required actions, approval points, and policy domains touched by this agent.

`sandbox` declares exact network grants, credential requirements or Server-scope direct declarations, and backend requirements. Each network grant identifies its host, port, protocol, purpose, and a non-empty explicit binary-path list plus either one access mode or a non-empty bounded REST rule list; omission never means every runtime binary, and every listed path must exactly match a path declared in `runtime.binaries`. Exact REST rules currently allow `GET` or `POST` with absolute OpenShell-compatible paths and cannot be combined with an access preset. Credential entries use the `vault` requirement contract plus allowed visibility and injection mode without secret values. Backend requirements may identify allowed and preferred backend kinds plus required capabilities only as eligibility constraints; they never name or select a NanoHost, backend instance, Runtime Epoch, local or remote placement, SSH target, Gateway origin, NanoCore endpoint, direct worker endpoint, route credential, or transport.

A network grant whose protocol is `rest`, whose access is `read-only`, and which has no `rules` may declare `allowEncodedSlash` with the closed boolean values `false` and `true`. Omission means `false`. The field is authority-bearing. Any other value or any occurrence on another grant shape fails validation; no coercion or fallback is allowed. Existing protocol and access defaults remain unchanged, and a resolved protocol other than `rest` cannot use this field.

`true` authorizes percent-encoded slash bytes in the endpoint's request path while preserving them as encoded segment content. It grants no additional host, port, executable scope, HTTP method, credential, or path-rule authority. It does not authorize an alternative parser, disabled inspection, or arbitrary native endpoint options. `false` and omission retain strict encoded-slash rejection. The grant's other restrictions and ordinary canonicalization remain effective.

The authored manifest is the durable source of this authorization, subject to existing policy restriction. Resolution preserves the admitted value in the immutable AEP and its material identity; backend intent and native policy are projections of that value. A grant id, host name, purpose, image, template revision, or backend default cannot infer `true`. A policy refusal or an inability to enforce the declared behavior blocks the dependent launch with a located diagnostic.

Before materialization, composed grants for the same canonical host and port must agree on encoded-slash acceptance. Omission and any grant shape that cannot declare the field mean `false` for this comparison. A disagreement blocks launch; it is not resolved by grant order, binary-list differences, merging with logical OR, or widening another grant. Existing exact host validation applies, and no new endpoint path selector is introduced.

Query encoding is outside this setting. The boolean introduces no new durable record or independent retry state machine.

The decision and its reason are recorded in [a decision record](../decisions/20261008-encoded_slash_authority_and_release_hold.md).

The Authorized binaries list defines the resolved executable-and-descendant scope of a network grant ([decision](../decisions/20261004-egress_grant_descendant_scope.md)). A connection matches that scope when the socket-owning executable path or an executable path in its observed ancestor chain is listed in the grant. Admission also requires the endpoint's exact host, port and protocol and its access preset or exact REST method and path rules; an ancestor match never authorizes an ungranted destination or forbidden method or path.

Matching uses resolved executable paths, not command labels or script paths in argv. An interpreted script does not become an independently authorized binary through its script path. Scope follows the observed chain at connection time, not a permanent process-tree provenance label; reparenting, parent exit and executable replacement can change it. Only observed ancestors within the backend's bounded depth participate. Observation stops at the Sandbox entrypoint, the root process, or an unavailable parent. This specification does not set that depth.

A granted general interpreter permits code executed through that interpreter and its observed descendant tree within the grant's endpoint limits. For example, a granted Node interpreter used by the Harness covers that Harness's observed descendants, including child shell or curl processes. Package-manager scripts and Git remote helpers use the same self-or-ancestor matching and retain the endpoint's access restrictions. Binary lists do not provide script-level or intra-Sandbox principal isolation ([decision](../decisions/20261004-egress_grant_descendant_scope.md)).

An exact REST-rule grant in sandbox.network may additionally contain publicAccess as the closed object { kind: 'credential-free-non-llm' }. The grant retains its existing id, exact host, port, protocol, purpose, explicit declared-binary list, nonempty GET/POST path rules and optional scope; it cannot combine those rules with an access preset. The marker contains no request contract, credential reference, query/header matcher, MCP tool selection or argument schema. Unknown marker values or members fail closed. An omitted marker preserves ordinary grant semantics and does not assert this public exception.

The responsible administrator declares that the intended endpoint use is public and account-independent, requires no authentication supplied by OpenKit, and exposes search/retrieval or another non-LLM service rather than an inference, chat, completions, responses, embedding or other model-execution interface. A service's internal implementation is not inferred from its marketing or host name: public search may use ranking technology without becoming a model-execution interface. This is the administrator's declared-use classification, not a per-request semantic proof, provider registry or continuous remote probe. NanoCore admits it only with current authority and applicable policy, no applicable Vault declaration or platform credential attachment targeting that destination, no known LLM Provider or Gateway/control route host, and no broader overlapping effective grant covering the same destination, binary and method/path traffic. A managed MCP selection or required Gateway approval/audit cannot be reclassified by this marker. Credential targeting is established only by authoritative destination metadata, such as a credential bound to that grant or destination, a Provider attachment, or platform injection for that route, never by a guessed environment-variable name or purpose string. A declaration whose only target is an environment-variable or file sink, with no destination association, does not target the public destination and does not block this class; destination metadata that exists but is ambiguous refuses the public-class setup.

Admission applies existing canonical host normalization and compares current configured host identities; changing the port or path does not override the known LLM Provider or Gateway/control host exclusion. Overlap compares the same canonical host/port, intersecting authorized binary sets and overlapping method/path allowances, including access presets and supported path globs. An unrelated host or nonoverlapping method/path is not a conflict merely because it uses the same binary; an unprovable overlap refuses rather than introducing a generalized pattern-analysis engine.

Classification is an admission decision over the composed setup, not a per-request assertion. OpenKit supplies no credential for this route; a user-owned key in the user's image is not an inferred Vault declaration and introduces no request-inspection requirement. The boundary continues enforcing only the existing exact network rules. An otherwise matching request is not rejected by this class merely because of its header, query or body contents.

The decision and its reason are recorded in [a decision record](../decisions/20260930-public_endpoints_by_admitted_grant.md).

NanoCore may restrict these declarations during resolution, but neither NanoCore nor a backend may add an endpoint, credential path, credential materialization, binary allow rule, or backend capability that the authored manifest and policy did not authorize. Backend environment variables, built-in endpoints, and deployment defaults must not expand the effective allowlist.

Image contents, OCI labels, and carrier markers confer no network or credential authority. `control.adapter.targetRuntime` selects exactly one adapter per session. A worker runtime is dispatch-ready only when its adapter can consume the Gateway relay with worker-visible logical model IDs and no concrete LLM Provider credential; the prior direct-provider Pi route is not dispatchable under this target. This Gateway-only rule applies to LLM inference authority, not to every networked tool. An exact authored Sandbox network grant may let its authorized executable-and-descendant scope call the declared non-LLM tool or service endpoint, including an endpoint authenticated by a separately resolved Workspace credential, but it grants no Provider endpoint, Provider credential, logical-model route, or inference bypass. The publicAccess exception neither removes nor expands that separately credentialed non-LLM REST path; a grant using it cannot also assert credential-free public classification for the same destination.

The resolved public map obeys the same 128-entry, 128-character-name and 16 KiB canonical compact UTF-8 JSON limits as the authored map. Protected control/bootstrap fields, current inference/Gateway/auth bindings, executable/argv selectors, exact conversation selectors and adapter-derived home/state/config destinations are managed rather than editable; harmless image defaults for protected placement fields are shown as managed/superseded and excluded from the public value map. Each adapter owns its exact protected-name projection. Inheritance or a vendor prefix alone does not protect an otherwise harmless setting. Trusted interpreter loader, preload, shell-startup and execution-search settings cannot alter fixed bootstrap before sanitization; ordinary native-tool PATH and package settings may differ only after that boundary, with the adapter retaining its fixed absolute command. Required control trust/proxy bindings remain protected, and user-local proxy/CA settings add no endpoint or weakened platform TLS authority.

## Built-In Development Grant Templates

The repository-owned built-in AgentManifest templates copy the same out-of-box development grants at init. Those templates are copy-on-init content: a later edit of this table or of a template file does not mutate an already-created manifest, and a missing grant fails as a denied network operation rather than being inferred from the image or from a hidden shared allowlist.

Existing authored manifests retain omission as `false`; updating templates does not update those manifests. An authorized administrator may opt an existing qualifying grant in by adding `allowEncodedSlash: true`, preserving its other fields. Initialization, reload, and release upgrade do not automatically perform that authorization change. Data continuity requires continued processing of retained manifests and AEPs, not inferred consent to wider request syntax.

For an existing deployment, an authorized administrator must inspect the actual authored selected manifest, add `"allowEncodedSlash": true` to its existing qualifying npm grant, validate and reload through the supported configuration workflow, and run a later Turn on a newly materialized policy. Do not replace the whole manifest or overwrite operator customization. Preserve retained volumes and native history during the existing successor process.

| Grant | Endpoint | Exact access | Authorized binaries (each executable and its observed descendants) |
| --- | --- | --- | --- |
| GitHub Smart HTTP read (`github-git-read`) | `github.com:443` | `GET /**/info/refs*` and `POST /**/git-upload-pack` | `/usr/bin/git` |
| GitHub REST read (`github-rest-read`) | `api.github.com:443` | OpenShell `read-only` REST access | `/usr/local/bin/gh` |
| npm package read (`npm-registry-read`) | `registry.npmjs.org:443` | OpenShell `read-only` REST access with authored `allowEncodedSlash: true` | Node, npm, npx, pnpm, and pnpx paths declared by the manifest |
| PyPI index read (`pypi-index-read`) | `pypi.org:443` | OpenShell `read-only` REST access | uv and the writable virtual-environment Python and pip paths declared by the manifest |
| PyPI artifact read (`pypi-files-read`) | `files.pythonhosted.org:443` | OpenShell `read-only` REST access | The same Python tool paths |

The Git grant deliberately omits `POST /**/git-receive-pack`, so clone, fetch, and pull are available while push is denied. No grant in this table names a mise supply host, language distribution server, release archive host, or registry mirror that exists only to serve a mise provision. Installed image tools confer no authority; a provision against an ungranted host fails denied.

Only the npm grant in the built-in development baseline declares `allowEncodedSlash: true`. The other built-in grants retain strict encoded-slash rejection. The npm grant supports scoped and unscoped package metadata and archives on its declared registry endpoint; secondary hosts remain subject to their own explicit grants.

An authored AgentManifest may add a narrower present-use grant when the generic sandbox policy permits it. Missing endpoints fail as a denied network operation, unsupported exact-rule shapes fail before sandbox creation, missing declared binaries fail manifest validation, and backend inability to enforce a grant blocks launch rather than widening access.

`resources` declares CPU, RAM, disk, network, wall-clock, and token budget classes.

`scale` declares concurrency, warm pool, session reuse, and queueing intent.

`lifecycle` declares startup, health, refresh, stop, and teardown behavior.

`observability` declares transcript, audit, log, metrics, and evidence requirements.

`extensions` is reserved for namespaced optional metadata. It must not carry the runtime selector, native argv, native event schema, network or credential authority, backend requirements, or any other launch authority; extension fields are never the stable product contract. The resolved AEP's existing private `extensions.openkit.turnInput` value is a NanoCore-supplied per-turn input, not an authored runtime override.

Known fields retain their owning validation. Unknown additive descriptive keys outside authority-bearing sections are ignored with a located warning under Contract Evolution. Unknown keys inside authority-bearing sections, unknown core values and unsupported required features fail closed. Environment-variable names in authored and delivered maps are consumed settings, not ignorable metadata; entries remain subject to the open identifier namespace, bounds and protected-name checks. The authority-bearing `publicAccess` declaration remains fail-closed: its kind must be `credential-free-non-llm`, and unknown classes, `request`, credential references or inspection semantics are not admitted.

Unknown authority-bearing semantics must fail closed.

Optional extension fields must be namespaced and must not become the only place where a product-semantic decision is stored.

## Manifest Evolution Rules

General authority-bearing field classification and required-feature fail-closed rejection are owned by `docs/specs/20260703-schema_evolution_record_envelope.md`. This contract provides no older-reader compatibility obligation: an older reader need not accept a newer manifest. Existing manifests follow the first-stable-release continuity boundary in [Contract Evolution](../core/contract-evolution.md#retained-data-continuity). Before `v0.1.0`, an explicit deployment reset may replace migration; current manifest validation remains binding. The pre-`v0.1.0` scope follows the engineer's interpretation of NONNEG-001 and COMPAT-001 in [Pre-Stable Data Continuity](../decisions/20261014-pre_stable_data_continuity.md).

This spec owns only the manifest-specific classification:

- New fields under `workspace`, `vault`, `policy`, `sandbox`, `mcp`, `tools`, `resources`, `scale`, `observability`, or `lifecycle` are authority-bearing by default; this spec is the place that may explicitly mark a specific field as descriptive metadata, and no field is currently so marked.
- Manifest writers SHOULD gate new behavior with `requiredFeatures` from the shared feature registry; `minCoreVersion` is the discouraged escape hatch per the schema evolution spec.
- Required backend capabilities remain the correct gate when the requirement is a backend property rather than a reader-semantics property.

`allowEncodedSlash` uses the existing closed authority-bearing field boundary: readers that do not understand it fail closed, and supported readers accept retained omission with strict behavior. Adding the field requires neither a permanent older-shape reader nor dual writes. A one-way migration that merely makes omitted strict behavior explicit is authority-preserving; a migration that sets `true` requires a separately accepted design and explicit authorization for the affected authored grants.

## Resolution Order

NanoCore resolves an agent launch in this order:

1. Select exactly one Server-owned or built-in `AgentManifest`; file order is never a fallback, and a missing explicit, User, Workspace, or Server selection is a typed configuration error.
2. Validate the Manifest, applicable Workspace binding, User preference, and request fields against their strict schemas and supported required features.
3. Select one nested profile and compose the Manifest, Workspace binding, profile, and User preference into one authored setup with field-level provenance.
4. Resolve the preferred and allowed logical-model set, expanding `all` from the current Workspace-visible Gateway catalog and rejecting an empty, stale, or incompatible set.
5. Attach logical-model, Skill, MCP, Vault, Workspace-resource, and runtime catalogs only to resolve references or prove support; catalogs do not supply missing authored declarations.
6. Validate request selections against the composed setup without deriving Agent identity from logical model identity.
7. Resolve the authored opaque adapter and declared runtime binary paths without runtime-specific inference. Resolve the selected retained environment's admitted image when present, otherwise the manifest default, using already verified image/default evidence before session compatibility; missing evidence returns preparation-required without an image effect.
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

`AgentEnvironmentPackageSchema` in `packages/config-schema/src/agent-environment.ts` is the admitted snapshot. The selected image is either the image reference with its pull policy or the resolved build definition and its build egress set. The command is the generic `openkit-worker-shim`. `control.adapter.kind` is `openkit-worker-shim`, and `control.adapter.targetRuntime` is the sole opaque adapter selector. The selected backend kind carries no NanoHost, host, Runtime Epoch, Gateway, SSH, or remote endpoint identity. The inference binding carries no Provider profile, provider-native model, account slot, or private route. Resolved MCP catalog metadata has no executable route. Non-secret token references are resolved by the backend and are never authored by the manifest. Network and credential policy carries requirement-to-grant provenance and no secret values. The private per-turn input stays at `extensions.openkit.turnInput`.

The resolved policy.network.rules entry preserves the exact publicAccess marker and the ordinary normalized network constraints. NanoCore validates its admission predicates before dispatch and on subsequent admission/reuse when their owning current-authority checks require it; the marker is immutable policy content and participates in the existing static policy/compatibility identity. No credential value, request schema, new transport or native command is inferred from it.

The snapshot is immutable. Any material change creates a new snapshot.

The AEP snapshot is the only launch contract passed to worker governance backends. `runtime.command.argv` launches `openkit-worker-shim`; it never contains Codex, OpenCode, Pi, or future runtime-native argv. `control.adapter.targetRuntime` is the only adapter selector, while `agent.runtimeKind` is descriptive and must not select code.

The backend materializes the governed image, exact policy, Vault bindings, Workspace, package file, and non-secret Sandbox-local Integration bindings without widening the AEP. The worker package never receives a concrete LLM Provider profile, provider-native model, account slot, private Gateway route, configured NanoHost credential, raw route token, Runtime Epoch identity, remote NanoCore or Gateway address, SSH target, Gateway forward, or direct sandbox-to-NanoCore endpoint. Inside the image, the generic shim selects the statically registered adapter named by `targetRuntime`; admitted public native environment values are resolved AEP inputs, and the adapter derives only runtime-native argv, protected environment bindings, and isolated state-root paths from those inputs. A runtime that cannot consume the logical-model relay through this contract is blocked as non-ready rather than receiving a direct-provider exception.

An AEP MCP catalog record carries only worker-safe selected supply metadata and enables the three governed MCP capability operations. The delivered Codex adapter may derive fixed loopback MCP URLs and the capability token environment-key name from that selection, but no AEP record generates an upstream command, upstream endpoint, credential reference, credential, or direct worker-to-server connection; packages without selected external MCP supply retain the same three governed routes for built-in supply, subject to current call authority.

## Readiness States

The following states are internal Agent Manifest resolution values, as [Core Agent Supply](../core/agent-supply.md#readiness) requires. Product-visible protocol records project only a readiness and health summary under the protocol owner.

- `ready`: all required refs, grants, catalogs, and backend capabilities are available.
- `degraded`: launch is allowed, but an optional capability is missing or reduced.
- `blocked`: launch must not start because a required dependency, grant, policy decision, or backend capability is missing.
- `disabled`: the configured Agent is disabled.
- `unknown`: readiness has not been established.

The resolver maps `disabled` to a blocked launch and leaves `unknown` unresolved until it establishes `ready`, `degraded`, or `blocked`. A stale running snapshot follows the existing AgentSession reuse and replacement owners; it is not another readiness value.

Admission may report `degraded` when a required worker credential is owned by an explicit manifest declaration whose durable grant can be validated only by the existing turn-scoped AEP resolver. This is a bounded preflight compromise, not proof that the credential exists: the AEP resolver remains the sole grant authority and must fail before provider, sandbox, or other external effects when the grant, reference, lifetime, target session, injection path, or backend sink is invalid. Provider-profile credentials that are not manifest-owned must still be resolved by the existing provider credential resolver before admission. `disabled`, `blocked`, and `unknown` setups must not invoke the turn executor; only `ready` and this explicit `degraded` case may proceed.

Readiness explanations must be redacted and must not expose secrets, host paths, or backend-private payloads.

Readiness states describe launchability. They do not describe turn completion or AgentSession lifecycle state.

Invalid or unsupported public classification, absent current authority, a targeting credential, ambiguous existing destination metadata or overlap, a known excluded host, required Gateway mediation or unavailable necessary admission metadata blocks the dependent setup with a value-free reason. Do not drop the marker, assume empty metadata, widen the rules or invent an alternate route. Ordinary unrelated grants retain their existing admission path.

Configuration changes use existing revision/reload and immutable AEP resolution. Reuse must still satisfy current policy/credential/route validity and the existing static Sandbox compatibility rules. Removal or newly discovered ineligibility follows current revocation/stop/replacement owners; this class creates no mutable in-place AEP, per-request reclassification, revocation detector or new lifecycle. Security revocation is not postponed merely because an old snapshot was valid. Restart revalidates current metadata and exact retained authority; failed dependency resolution never defaults to public. Retry is a new authorized request resolving current facts, never replay of a previous effect.

## Readiness Remediation Hints

First setup diagnostics should expose only redacted, action-oriented hints.

The categories below are a target inventory. They are not the setup resolver's current closed diagnostic set.

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
- distinct sandbox-local `/worker-control/*`, `/inference/*`, and `/capabilities/*` Integration bindings plus non-secret token references
- exact sandbox network, credential, process, filesystem, and backend policy
- workspace roots and generated files
- output roots
- transcript and evidence sinks

The generic shim selects the one statically registered worker-side adapter named by `control.adapter.targetRuntime`. Admitted public native environment values are AEP inputs. Native argv, executable selection, private home/control destinations, conversation selection, current Gateway bindings and credential carriers remain adapter-derived and cannot be authored through that map. Environment values add no filesystem, endpoint, credential, model, capability or MCP authority. The shared shim has no adapter-authored file contract.

Shim and adapter outputs are candidate records, never canonical product state. NanoCore validates their lineage, schema, ordering, policy, and bounds before committing any canonical record.

Worker agents must not author or mutate their own stable supply, and neither a backend nor an adapter may add undeclared network, credential, capability, provider, or MCP authority.

Changing or removing `allowEncodedSlash` takes effect only through a newly resolved package and a Sandbox materialization that enforces that package. Active Turns and retained AEP snapshots are not rewritten. A live Sandbox enforcing the previous value cannot be reused for the changed package. Existing successor, fencing, and retained-volume rules govern the transition; the change creates no new lifecycle or automatic retry. Restart reconstructs enforcement from admitted package authority. A failed application remains a failure until a fresh authorized attempt establishes the requested enforcement, and historical packages remain readable without acquiring the new authority.

## User Administration Of Native Environment

NanoCore's user configuration view and App API edit the same Agent file through existing revision-checked validation, write and safe-reload operations; neither owns an independent environment store. Reads and edits require current usable deployment-administrator authority and applicable audience checks. The response distinguishes persisted revision, runtime-snapshot reload and native application; a write or reload alone never reports a running binding changed. A changed effective public native environment requires a successor with exact native resume; a resident native process never applies the changed environment in place.

The user can inspect admitted image defaults as read-only values, edit or suppress ordinary overrides, restore inheritance, preview effective desired values and shared-Agent impact, and see the acknowledged binding's applied configuration separately from pending next-Turn changes. Protected names are managed/read-only. Credential values, raw unclassified image environment, host environment and live process dumps are not exposed. The view follows the existing private administration disclosure boundary and does not publish this data to an Agent catalog or ordinary Thread.

User application rechecks current authority, exact file revision and current image evidence; stale input refuses without overwrite. Existing required image-activation confirmation remains required, and ordinary configuration editing does not invent a new approval owner. Built-in-agent environment modification tools, MCP bindings and autonomous application are pending and are not activated by this contract.

Bootstrap inheritance keeps a nonempty `NODE_EXTRA_CA_CERTS`. An empty inherited value is discarded, and `SSL_CERT_FILE` may then supply the fallback. A public native map may still contain an empty value. That map is not the protected bootstrap set. A persistent Worker image path may import a runtime file when generation and current authority validate. That import is not generic provider attachment. A worker-local export, shell-local change or native-written environment file is not reverse-synchronized into Core. The administration view describes admitted launch configuration and the exact acknowledged binding, not every descendant's later environment. Failed validation or reload publishes no partial runtime snapshot. Restart reconstructs desired values from canonical configuration and verified immutable image evidence, never from a prior child environment; current revisions, image/default identity and credentials are rechecked at admission.

## Scale Fields

The current schema rejects `scale`. The preferences below are target intent, not an admitted or enforced map. The scheduler owns actual placement.

Scale fields should include:

- max concurrent sessions
- idle timeout
- max turn duration
- queue priority class
- cost class
- session reuse policy
- warm pool intent

Workspace and server policy may restrict every scale field.

Scale intent fields should remain preferences and upper bounds. They must not select a backend, encode deployment or transport, name a concrete runtime target, force remote placement, allocate capacity, or bypass scheduler fairness. The scheduler owns bounded FIFO admission order and the execution-attempt grant; the NanoCore-process backend adapter owns exact residency and enforces physical bounds. Manifest intent cannot create scheduling mechanisms outside the accepted profile in [Runtime Scheduling And Scale](20260703-durable_scheduler_design.md#scale-limits).

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

Authored setup may select exact Skill versions or leave selection to the Workspace pin and entry default. The precedence is an explicitly authorized one-run exact selection, an exact composed setup reference, the Workspace pin, then the entry current digest. A run override names only an already-included Skill, changes no shared pointer or pin, and retains the selection explanation. Conflicting authored exact references fail before AEP creation. Unpromoted candidates require explicit exact selection and current launch authority under the Skill owner.

An MCP exact configuration constraint must equal its catalog entry's current selection. A mismatch blocks readiness until an authorized catalog operation changes that selection or the authored constraint. Resolution never selects a parallel historic MCP process or restores old Vault grants. Package expansion preserves each component's independent selection rules.

The AEP snapshot must always store exact resolved supply:

- owner scope and catalog entry id
- exact resolved component version, digest format, and selection source
- source revision and original plugin/member lineage when applicable
- runtime adapter compatibility result
- policy decision ids when applicable
- materialized path for file supply, or a catalog binding for capability-plane supply

An MCP catalog binding is non-executable metadata. It must not carry an upstream command, native config target, direct server endpoint, credential reference, or credential; only exact selected supply enables the fixed governed `capability.local` MCP route after current package, token, catalog, policy, and schema validation.

Version ranges, implicit upgrades, and automatic candidate promotion are outside this target. Changes produce a later AEP and follow session compatibility; they never replace files in an active session. The Skill and MCP catalogs remain the unique version and selection authorities.


The schema retains `resources`. A nonempty value is refused before any Sandbox effect. An empty or absent value remains usable.

The enabled relay form carries no direct Provider credential. The schema also admits a dormant harness branch. The default App does not activate it.

## Acceptance

Proof requires admitted-default inspection; a revision-checked override, edit, suppression, and restored inheritance; desired state distinguished from acknowledged-applied state, including shared-Agent scope; actual new values observed in a native Tool only after exact successor resume; refusal of an unauthorized or stale edit; no secrets and no sibling change; and preserved conversation and native data. This states required proof. It does not claim that a run has passed.

## Implementation

- `apps/nanocore/src/agents/`
- `apps/nanocore/src/runtime/`
- `apps/nanocore/src/config/`
- `packages/config-schema/src/`
- `apps/nanocore/data-templates/config/agents/`

## Implementation Gaps

- A profile extends only behavior lists the manifest marks composable - Skill and MCP additions merge without that declaration; exact conflicting Skill digests are still refused - #636
- An authored MCP item carries an exact version, tool, or visibility constraint - the authored item is only an id - #781
- Source resolution applies requested narrowing and the Policy, Vault, and grant intersection, and returns a source remediation category - the resolver checks existence, status, slot, and access only - #782
- A nonempty worker `resources` map is enforced - the value is retained and then refused - #781
- The manifest admits the seven scale preferences - the schema rejects `scale` - #781
- A Workspace-local Agent definition is a policy-reviewed proposal and then an accepted catalog entry - ordinary Workspace bindings work; that proposal path does not - #356
- Plugin installation expands before setup resolution - no authored plugins field is consumed - #487

## Decisions

- [Login preference and new-Turn selection](../decisions/20261111-login_preference_new_turn_selection.md)
- [Public endpoints by admitted grant](../decisions/20260930-public_endpoints_by_admitted_grant.md)
- [User-selected Workspace-shared sandboxes](../decisions/20261008-user_selected_workspace_shared_sandboxes.md)
