---
status: Accepted
implementation: Partial
kind: boundary
updated: 2026-09-21
---
# Agent Environment Package And Worker Governance Backends

## Owns

This specification owns the implementation-facing `AgentEnvironmentPackage` contract and the boundary between NanoCore's resolved worker-execution authority and a worker governance backend's materialization.

It owns the strict version 4 envelope, the exact canonical worker-consumed byte projection and package-config identity, the resolution and immutability invariants, the no-widen and no-secret boundaries, the redacted snapshot requirement, and the package evidence needed for launch, restart, and recovery decisions.

It owns the two forms a resolved runtime image may take inside the package — a digest-pinned published image reference or a bounded build definition — and the immutability, no-secret, no-widen, and resolution rules that apply to the build definition as package content. It does not own how a build definition is executed, stored, or imported.

## Does Not Own

This specification does not own the user-authored `AgentManifest`, provider or Vault lifecycle, workspace synchronization, worker-control protocol, capability routing, scheduling, NanoHost identity or transport, Runtime Epoch lifecycle, backend-native policy or lifecycle artifacts, runtime-native adapter behavior, product records, public UI behavior, a cross-stage error taxonomy, or measured harness identity. Measured harness identity is the sandbox image digest copied as a value at binding time and is owned by `docs/specs/20260802-nanohost_runtime_and_transport.md`.

Those contracts remain with their narrow Core and specification owners. An AEP carries their resolved inputs and lineage without redefining them.

## Core References

- `docs/core/runtime-model.md`
- `docs/core/agent-session.md`
- `docs/core/agent-supply.md`
- `docs/core/agent-capability.md`
- `docs/core/sandbox.md`
- `docs/core/permissions.md`
- `docs/core/vault.md`
- `docs/core/audit.md`
- `docs/core/storage.md`

## Related Docs

- `docs/specs/20260703-agent_manifest_aep_resolution.md`
- `docs/specs/20260629-worker_runtime_communication_model.md`
- `docs/specs/20260704-session_static_workspace_materialization.md`
- `docs/specs/20260703-worker_control_protocol.md`
- `docs/specs/20260703-workspace_synchronization.md`
- `docs/specs/20260703-worker_agent_capability.md`
- `docs/specs/20260704-worker_mcp_tool_supply.md`
- `docs/specs/20260703-vault_secret_injection.md`
- `docs/specs/20260704-vault_backend_implementation.md`
- `docs/specs/20260703-policy_enforcement_mapping.md`
- `docs/specs/20260703-durable_scheduler_design.md`
- `docs/specs/20260703-openshell_mechanism_internalization.md`
- `docs/specs/20260715-openshell_disposable_cell_lifecycle.md`
- `docs/specs/20260802-nanohost_runtime_and_transport.md`
- `docs/specs/20260801-nanohost_workspace_data_boundary.md`
- `docs/specs/20260708-container_image_packaging.md`
- `docs/specs/20260721-worker_execution_environment_images.md`
- `docs/specs/20260716-codex_worker_adapter.md`
- `docs/specs/20260716-opencode_worker_adapter.md`
- `docs/specs/20260716-pi_worker_adapter.md`
- `docs/specs/20260711-worker_runtime_subagent_provenance.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260902-agent_runtime_context_compaction.md`

## Definition And Exclusions

An `AgentEnvironmentPackage` is one strict, resolved, immutable NanoCore record that binds an exact worker launch to its OpenKit lineage, runtime, workspace inputs, supplied resources, sandbox-local Integration bindings, governed access, allowed logical-model contract, resource intent, observability requirements, and backend requirements.

The AEP is the canonical input to worker governance materialization. NanoCore remains authoritative for product identity, policy and permission decisions, provider and Vault references, canonical Turn and Item state, usage, audit, and review. A backend may materialize and enforce the package and return evidence, but it must not create or replace those authorities.

An AEP is not:

- a user-authored configuration file;
- a secret container or credential store;
- a backend-native policy, provider, process, container, Cell, or sandbox record;
- a NanoHost, Runtime Epoch, Gateway, container-runtime, SSH, remote endpoint, or transport-credential record;
- a worker-control or capability protocol definition;
- a canonical transcript, Item, Artifact, or Audit record;
- an instruction to infer omitted access, routes, credentials, binaries, mounts, or backend capabilities;
- a mutable session configuration or a live-update mechanism.

Backend-native identities and sensitive material remain in their backend, runtime, or Vault owners. Public and diagnostic projections use OpenKit identities and redacted summaries only.

## Authority Chain

The only accepted authority chain is:

```text
one Server AgentManifest plus optional Workspace binding, selected profile, and User preference
  -> one composed authored setup
  -> one ResolvedAgentSetup
  -> one strict immutable AgentEnvironmentPackage
  -> one validated backend materialization
  -> one bounded worker launch
```

Core Agent Supply owns the authored `AgentManifest` concept. `docs/specs/20260703-agent_manifest_aep_resolution.md` owns its concrete schema, the identified Workspace extension and User-preference composition that occurs before resolution, validation, and resolution into `ResolvedAgentSetup`. Catalogs, workspace roots, request context, grants, runtime proof, placement, and backend facts may resolve references or establish availability, compatibility, authorization, and capacity, but they must not silently author a missing image, adapter, runtime binary, network grant, credential declaration, or backend requirement.

The target `ResolvedAgentSetup` contains the complete composed manifest, selected profile, one preferred logical model, and an exact non-empty allowed logical-model set with each member's Gateway-derived effective capabilities and `modelFamilyId`. It contains no LLM Provider profile, Provider-native model, account slot, private route member, or secret value. The current concrete Provider summary is an implementation divergence recorded below.

NanoCore resolves the setup together with the exact Turn, AgentSession, `ActorRef`, workspace roots, request context, provider and Vault authority, policy, and selected backend target. The result must pass the strict AEP schema and all cross-field checks before it can cross into backend materialization.

The backend validates the package against its real capabilities and readiness before launch. Materialization may translate the accepted AEP into backend-private artifacts, but neither materialization nor launch may add authority absent from the parsed package.

## Strict Envelope

The parsed package has `schemaVersion: 4` and these top-level core fields:

```text
schemaVersion
packageId
snapshotId
createdAt
scope
agent
runtime
workspace
supply
control
capabilities
credentials
vault
policy
llm
resources
observability
backend
extensions
```

Known core fields retain their owning validation, immutability and secret checks. Unknown additive members outside the core are ignored under Contract Evolution; ignored content from outside the reader's trust boundary is not persisted, forwarded or displayed. Unknown core values and unsupported required or authority-bearing semantics fail closed. Backend-specific or private expansion belongs under `extensions` only when another accepted owner defines its use; `extensions` never bypasses the package's authority, secret, or validation rules.

The schema supplies only these top-level defaults during parsing:

- `capabilities` defaults to protocol `openkit-worker-capability-v1`, mode `disabled`, and no routes;
- `credentials` defaults to no declarations;
- `extensions` defaults to an empty object.

All other top-level fields are required. `schemaVersion` is the literal number `4`, `createdAt` is an ISO date-time, and `packageId` plus `snapshotId` are non-empty immutable identities.

The top-level sections have these responsibilities:

| Section | Package responsibility |
| --- | --- |
| `scope` | Binds Workspace, Thread, Turn, AgentSession, request, and initiating `ActorRef` lineage. |
| `agent` | Identifies the selected Agent and descriptive runtime/profile projection. `runtimeVersion` is an unverified author label from the authored AgentManifest and MUST NOT be treated as a measured harness version. |
| `runtime` | Carries the governed image selection defined below, declared absolute worker binaries, fixed generic shim command, and process/session inputs. |
| `workspace` | Carries the worker-visible root, declared inputs, generated material, and output declarations. |
| `supply` | Carries exact scoped Skill versions and their bounded resource inventories, original plugin/member lineage, and selected MCP configuration/binding lineage with effective catalog digests. MCP entries enable only the separately governed fixed MCP capability routes; upstream configuration and credentials stay outside the package. |
| `control` | Carries the sandbox-local `/worker-control/*` Integration binding, transcript, non-secret worker-control token reference, and the opaque runtime-adapter selector. |
| `capabilities` | Carries the sandbox-local `/capabilities/*` Integration binding and separately governed worker-capability projection; it is enabled only for the exact three MCP routes when selected MCP supply is non-empty and otherwise remains disabled with no routes. |
| `credentials` | Carries declarations and references only, never credential values. |
| `vault` | Carries non-secret Vault references and grants owned by the Vault contracts. |
| `policy` | Carries the exact filesystem, process, network, and secret policy intent to materialize. |
| `llm` | Carries one resolved sandbox-local `/inference/*` semantic binding, distinct token reference and authority mode, one preferred logical model ID, and the exact non-empty allowed logical-model set with each member's Gateway-derived effective capabilities and `modelFamilyId`; it carries no concrete Provider or route identity, and trusted relay packages omit `workerBaseUrl` and every native URL. The current strict version 4 shape has no context-management field; adding the resolved policy owned by `docs/specs/20260902-agent_runtime_context_compaction.md` requires the next coordinated package version rather than an `extensions` workaround. |
| `resources` | Carries worker resource intent without creating a second scheduler. |
| `observability` | Carries required audit and evidence expectations. |
| `backend` | Carries the preferred backend, allowed kinds, and required capability set. |
| `extensions` | Carries bounded owner-defined data that grants no independent authority. |

Each allowed logical-model route may carry optional `modelParameters` for native model configuration: effective context window, maximum output tokens, supported input modalities, and reasoning support. NanoCore projects these together from the [Gateway-owned coherent contract](20260526-llm_gateway_responses_api.md#logical-model-catalog-and-ordered-routing) over members, rather than requiring all members' parameters to be deeply equal. Projection still requires all fields needed for native launch to be known; inequality alone does not remove complete parameters. The decision and its reason are recorded in [the tier-routing decision record](../decisions/20261001-gateway_tier_routing_rulings.md). It preserves explicit false and never fabricates missing values. Modality intersection defines the admitted logical contract; an adapter whose runtime cannot represent a promised modality projects the subset its runtime supports and records the omitted modalities in its existing bounded adapter diagnostics, so the drop is not silent. For modality support, the adapter refuses a new launch only when that subset lacks `text`. The decision and its reason are recorded in [the native modality subset decision](../decisions/20261001-native_modality_subset.md). Absence on a retained package means not recorded; readers retain that package and an adapter that requires the parameters refuses a new launch from it. A new resolution creates a new immutable package rather than rewriting old evidence. These model limits describe the admitted inference contract; they do not add the separate context-management policy mentioned above. The [Pi adapter](20260716-pi_worker_adapter.md) owns its native representation and supported modality subset.

### Reasoning Effort Projection And Delivery

The package's `llm.reasoningEffort` optionally projects the admitted Turn's recorded effort, and each allowed reasoning logical-model entry projects its Gateway-advertised `reasoningEffortLevels` in the [canonical reasoning-effort enum](../core/protocol.md#canonical-enums). A newly resolved package records the current advertised list, including an empty list; absence on a retained package means not recorded and never invents supported levels. The Turn remains durable authority for its admitted choice, the Agent manifest owns its default, and [Gateway](20260526-llm_gateway_responses_api.md#reasoning-effort-metadata-and-dispatch) owns current level derivation and per-request fitting. These optional core projections participate in canonical immutable package bytes, not an extension workaround or another effort store.

An AEP route carrying `reasoningEffortLevels` is a reasoning route even when the list is empty; a route without that field is not a reasoning route. On reasoning routes, adapters whose runtimes need native level metadata declare all seven canonical levels with their exact Gateway wire values, so native requests carry the Turn's recorded effort unchanged and Gateway alone fits it. The advertised list remains the Composer and diagnostic projection and does not restrict native declaration. The decision and its reason are recorded in [the native declaration and upward-fitting decision](../decisions/20261001-reasoning_effort_native_declaration_and_upward_fitting.md).

Resolution creates these projections with the ordinary per-Turn package. They never update in place; a later Turn gets a new package. For new Turn admission, submission effort precedes the composed Agent default; the resolved explicit value is recorded on the Turn and projected here, while omission of both leaves it absent. For inference bound to that Turn, an explicit Worker per-request effort precedes the recorded Turn effort; only when neither the native request nor the recorded Turn supplies effort does Gateway dispatch use the Provider default. A Turn with absent effort can still produce a native request carrying a retained runtime selection. Absence on a retained Turn or package remains unrecorded and does not authorize recomputation from current Agent defaults; retained records remain usable without migration or a compatibility reader. Invalid known effort values or conflicting Turn lineage fail before native effects; stale advertised levels do not overwrite the Turn and serving-member mismatch follows Gateway fitting. Restart/recovery uses the admitted Turn and its existing immutable package evidence, not changed defaults or a fabricated capability list. No independent effort retry, termination, or recovery lifecycle applies.

Each Worker adapter delivers the Turn's recorded effort on every Turn that has one on a route carrying `reasoningEffortLevels` through its runtime's native per-Turn control before the prompt is admitted, so native inference requests carry it. On a route without `reasoningEffortLevels`, all four adapters send no native effort and record in the existing bounded adapter diagnostics that the effort was not delivered because the model has no reasoning; the Turn does not fail and the native conversation keeps its current selection under [the effort-retention decision](../decisions/20261001-reasoning_effort_retention.md). The [Codex](20260716-codex_worker_adapter.md#reasoning-effort-delivery), [Pi](20260716-pi_worker_adapter.md#reasoning-effort-delivery), [OpenCode](20260716-opencode_worker_adapter.md#reasoning-effort-delivery), and [DeepSeek](20260930-deepseek_worker_adapter.md#reasoning-effort-delivery) adapter owners name their native interfaces and mappings; delivery qualification still requires a probe of each runtime's pinned version and native request evidence. A Turn without recorded effort carries no adapter override, so the runtime keeps its conversation's current selection: its native default or the last effort delivered on that conversation. This absence is distinct from explicit canonical `none`, which on a reasoning route is delivered as a native value rather than omission or null. Gateway private lineage records the effort the request actually carried. The retention decision and its reason are recorded in [the effort-retention decision](../decisions/20261001-reasoning_effort_retention.md). A Worker's explicit per-request effort wins for that request without changing the Turn's recorded choice. A claim that an adapter delivers effort requires evidence from its pinned-runtime probe and native inference requests. This paragraph adds no effort-specific Turn admission or refusal rule; if the probe cannot establish the prescribed delivery, that unresolved behavior returns to the owning design before the adapter amendment is accepted. Gateway drops effort for a model without reasoning and uses the Provider default for a reasoning serving member without declared options; these dispatch rules do not reset a native conversation selection. Acceptance requires exact Turn projection, advertised-list projection, retained omission without an adapter override, native-default or last-selection retention within the same conversation, explicit `none` delivery, immutable admission through restart, per-runtime pinned-version evidence that native requests carry the admitted effort where the reasoning model has declared options, and the Gateway-owned non-reasoning, absent-options, fitting, and lineage behavior. The decision and its reason are recorded in [the reasoning-effort decision record](../decisions/20261001-reasoning_effort_rulings.md).

Native effort selection belongs to the existing native conversation and is not a second canonical Turn authority or a new OpenKit effort store. On a reasoning route, a recorded value is applied before each prompt and may change between settled Turns on that conversation; absent effort neither restores a default nor rewrites the immutable package. Selection observations that are stale, missing, conflicting, or unknown do not establish delivery. A native clamp, rejection, or different reported effective level must not be silently represented as the requested level. Effective-level observations, including missing or unverifiable values reported as unknown, use the existing bounded, credential-free adapter result diagnostics; no new channel or canonical Turn mutation is introduced. Native selection failures retain the existing adapter failure and cleanup semantics, not an invented effort-specific Turn admission rule. Cancellation, close, termination, retry, exact resume, host loss, and recovery follow the existing adapter and AgentSession lifecycle; no effort-specific replay, repair, reset, or restart-restoration mechanism is added. Acceptance includes native request evidence across successive recorded and omitted choices, truthful effective-level diagnostics, unchanged retained conversation and Turn authority, and no native effort or Turn failure on routes without `reasoningEffortLevels`, with bounded diagnostics stating that the model has no reasoning and current-selection retention. Existing exact-continuity, cancellation, credential, and retained-byte predicates remain required; one runtime's evidence does not qualify another.

`agent.runtimeVersion` is created from the authored AgentManifest at package resolution (`apps/nanocore/src/runtime/agent-environment.ts:445`, `manifest.runtime.version ?? 'unversioned'`). It is not updated in place, reminted, or recovered as a measured digest; a later Turn receives a new package. A missing authored version remains the label `unversioned`. Treating `runtimeVersion` or authored `runtime.image` as measured identity is a false merge and is forbidden. This specification does not own sandbox-row deletion or the binding-time copy of the image digest.

The decision and its reason are recorded in [a decision record](../decisions/20260930-native_environment_managed_outside_the_sandbox.md).

A newly resolved environment-aware Worker package records `runtime.environment` as the core record `{ imageDigest, defaultsDigest, values }`: measured lowercase SHA-256 image identity, the canonical digest of its admitted non-secret default map, and the final bounded public string map owned by Agent Manifest And AEP Resolution. Null removals are resolved before this projection. It contains no raw credential, executable selector, protected binding override or mutable process observation, and it participates in the canonical immutable package bytes. These core fields are required for an environment-aware launch. Unknown additive members outside the core are ignored under Contract Evolution and are not forwarded into the native environment; unsupported required semantics fail closed. Retained canonical evidence is not rewritten merely to perform this projection. Environment-variable names in `values` are consumed settings, not ignorable additive metadata; the manifest owner's open identifier namespace, bounds and protected-name checks apply.

Nested field shapes and lifecycle rules remain with the narrow owners linked above. This specification requires their resolved projections to agree in one strict envelope rather than duplicating their tables.

### Canonical Worker-Consumed Byte Projection

Immediately before NanoCore prepares the worker-consumed package import, it parses the candidate again through `AgentEnvironmentPackageSchema`; parse failure or a value outside the JSON domain fails before any effect. It then serializes recursively by preserving array order, sorting every object key by JavaScript UTF-16 code-unit order, encoding object keys and scalar strings with `JSON.stringify`, and accepting only null, booleans, strings, finite JSON numbers, arrays, and plain JSON objects. `undefined`, a non-finite number, bigint, symbol, function, cycle, non-plain object, or any other non-JSON value is rejected rather than coerced or omitted.

The exact body is compact UTF-8 JSON with no BOM and no trailing newline. Its byte identity is the lowercase `sha256:<64hex>` digest over those exact bytes plus their UTF-8 byte length. The same exact body, digest, and length enter the existing `reference.import` request identity and file-data proof. This serializer remains local to the existing worker-governance package producer, and the legacy CLI package writer calls that same local owner; it is not a general canonical-JSON framework or dependency. The durable redacted snapshot and its digest remain a distinct evidence projection and are neither reused nor redefined by this byte identity. The complete worker-consumed body independently remains subject to the existing `package-config` import ceiling of 268,435,456 bytes, so an individually valid Dockerfile can still make the later aggregate package admission fail under the existing pre-bootstrap cleanup and fence lifecycle.

NanoCore owns those immutable package bytes. After exact AgentSession admission, it imports them through `reference.import` under import-only identity `package-config`, relative path `<agent-session-id>/config/package.json`, and AgentSession-private destination `/openkit/sessions/<agent-session-id>/config/package.json`. The data-boundary owner defines the closed path grammar and fixed helper root; NanoCore derives the identity from the current AEP. This is not an AEP field, declared workspace slot, output, Artifact, snapshot, credential, transport authority, executable selector, or general configuration-file surface. NanoHost owns request-private staging and local effect proof. Adjacent paths, export, caller-selected roots, and a pre-existing destination are rejected; the runtime owner clears prior Turn inputs before reuse.

For the NanoHost cross-host projection, the dedicated generated Context Package input preserves the exact package-root digest and binds to the declared `context` slot; NanoCore-private `workspaceRoots`, source paths, host paths, archives, and transfer handles never enter the AEP or wire contract. Each output declaration carries only its output id, normalized slot-relative path, registration posture, and retention, never a predicted digest or byte length. The NanoHost computes actual export digest and length after the terminal barrier, and those facts remain backend evidence until NanoCore verifies the bytes and hands them to the existing transcript, Artifact, or Workspace collection owner.

The package preserves three distinct non-secret worker-control, inference, and capability token references, but no raw live token or hash is AEP content. The NanoCore runtime resolves three independent attempt-private raw values only at the sensitive private `turn.start` dispatch and supplies them through exact AgentSession-local bindings; they never enter the fixed Start argv, package, package digest, snapshot, Context Package, or another route family. The worker-control token reaches only the Worker Shim control client, the inference token reaches the native Agent only through the sanitized `OPENKIT_WORKER_INFERENCE_TOKEN` binding, and the capability token reaches it only through the sanitized `OPENKIT_WORKER_CAPABILITY_TOKEN` binding when exact selected MCP supply enables the capability plane. The selected adapter owns the fixed native URLs that project the semantic inference and MCP bindings; NanoCore, the AEP, and the worker manifest do not select or serialize them.

## Runtime Image Selection And Build Definition

`runtime` resolves to exactly one of two image forms, never both and never neither. `runtime.image.ref` therefore stops being unconditional and becomes one arm of a discriminated selection, which changes the meaning of an existing field.

The image-form change originally moved the package to version 3. Replacing the concrete Provider route with the logical-model contract and removing the `providers` section now moves the package directly to `schemaVersion: 4`. `docs/specs/20260703-schema_evolution_record_envelope.md` permits a version change, and a required feature is appropriate only when old and new readers must coexist. Under the rule in force at that transition they did not: NanoCore, Sandbox Integration, and the execution runtime are released together, restart recovery reads a snapshot written by the same version, and an incompatible historical data root was replaced rather than migrated. There is one accepted shape, and version 2 or version 3 packages are invalid. That completed cutover stands.

**Image reference.** A published image reference with its pull policy, exactly as authored and resolved today. Which reference forms an author may use, and how a tag is treated, remain owned by `docs/specs/20260703-agent_manifest_aep_resolution.md`, `docs/specs/20260708-container_image_packaging.md`, and `docs/specs/20260721-worker_execution_environment_images.md`. This specification adds no new restriction on that form; resolving a reference to the exact content digest a sandbox consumes happens at the execution runtime's acquisition boundary and is owned there. Authored `runtime.image` references are not image identity and MUST NOT be treated as the measured harness grouping key.

**Build definition.** A bounded description from which the execution runtime produces one image for this attempt, consisting of the exact V1 build-context singleton reference `build-context://empty/v1`, its exact content digest `sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`, one build input document, declared build arguments, a declared build egress grant set, and exact positive-integer `timeLimitSeconds`, `outputLimitBytes`, and `layerLimit` values. The singleton denotes a zero-entry canonical context whose byte sequence is exactly empty bytes. The V1 build input document is a Dockerfile whose value encodes nonempty UTF-8 bytes with length from 1 through 268,435,456 inclusive. Those exact bytes remain inline immutable AEP content, participate in the build-input and package digests, and are carried independently from the context; they MUST NOT enter or alter the build-context digest. The existing `input.digest` is lowercase SHA-256 over exactly those UTF-8 bytes. No BOM removal, newline normalization, compression, locator, fetch, path, alternate spelling, or context mutation is inferred. Resolving the build input grants no host, shell, lifecycle, capability, host-path, build-root, socket, context-transfer, or context-variant authority, and NanoCore MUST NOT interpret it as anything other than package content bound by its independent digest.

The build definition obeys the same package rules as every other resolved input, stated here because it is the first package field whose content is executable elsewhere:

- **Immutable.** The exact singleton context reference and digest, independent build input document, and build arguments are part of the package and its digest. Any change produces a new package and a new bounded launch; a package is never mutated to change a build. V1 accepts no other context reference or digest, and resolution MUST NOT infer, substitute, fetch, transfer, configure, or synthesize another context variant.
- **Bounded exact bytes.** Authored and resolved Dockerfiles MUST each encode 1 through 268,435,456 UTF-8 bytes inclusive and MUST match the declared lowercase SHA-256 over those exact bytes. Empty, non-UTF-8, oversized, or digest-mismatched input fails before a scheduler or backend effect; neither resolution nor carriage may replace the inline bytes with a reference.
- **No secret.** Build arguments carry no secret value, credential, token, authorization header, or unrestricted host path, and the schema rejects secret-shaped fields recursively exactly as elsewhere. A build that needs credential material expresses it as a non-secret reference; this specification authorizes no build-time secret delivery, and the absence of that mechanism is a truthful limit rather than an implied capability.
- **No widen of the sandbox.** A build definition MUST NOT grant the sandbox that runs the resulting image any network, filesystem, credential, or capability authority beyond what the same package's `policy`, `providers`, `credentials`, and `vault` sections already grant it. Nothing a build installs, writes, or configures becomes runtime authority; the launch policy remains the only authority.
- **Declared build egress.** A build legitimately needs network access the resulting sandbox does not have, because package managers and language toolchains are build-time concerns. Pretending otherwise would make the form unusable, so build egress is its own explicitly declared, bounded grant set inside the build definition rather than an inherited or implied widening of the sandbox grants. It is authored, resolved, and validated like every other grant, it is scoped to ordinary build traffic only, and it is **not** inherited by the sandbox. Each resolved grant preserves exactly one explicit `{host, port}` pair; a missing host or port, wildcard host, non-positive or out-of-range port, path, URL, protocol, capability, socket, inferred default, or inferred `443` is rejected. The runtime-owned fixed OCI registry bootstrap pairs are separate from AEP grants and do not create, remove, replace, or default an authored pair. Whether a given endpoint may appear in a build egress set remains a workspace-policy decision under its existing owner.
- **Declared execution bounds.** `timeLimitSeconds`, `outputLimitBytes`, and `layerLimit` are required positive integers and each MUST be no greater than the corresponding maximum owned by `docs/specs/20260802-nanohost_runtime_and_transport.md`. V1 therefore accepts `timeLimitSeconds` from 1 through 1800, `outputLimitBytes` from 1 through 21474836480, and `layerLimit` from 1 through 128, all inclusive. Absence, zero, a negative or fractional value, overflow, or a value above its exact maximum fails resolution before any build effect; neither NanoCore nor NanoHost supplies a default or raises a declared bound.
- **Resolved before launch.** NanoCore validates the build definition before any launch or build effect, including when existing preparation supplies verified image evidence before environment-aware AEP resolution. Validation failure is a strict schema or cross-field rejection.
- **Not a published image.** The image a build definition produces is attempt-scoped. Its publication boundary and content guarantees are owned by `docs/specs/20260721-worker_execution_environment_images.md`; this specification only requires that the package never names such an image as a deployment image.
- **Digest binding.** The resulting image digest is bound by the execution runtime owner and recorded as preparation or launch evidence. For an environment-aware package, the already verified result is recorded at resolution in `runtime.environment.imageDigest`; an admitted immutable package is never rewritten with a later result. Under the build form the package-to-session consistency comparison that otherwise uses `runtime.image.ref` uses the build-definition lineage — the exact empty-context singleton reference and digest, independent Dockerfile input digest, and resolved argument digest — plus the recorded resulting image digest, and a missing or mismatched value fails closed exactly as a reference mismatch does.

Administrator-authorized environment preparation under `20260910-persistent_worker_volumes.md` reuses this exact build-definition shape, no-secret validation, explicit egress and bounds in an immutable candidate Artifact before a Worker attempt exists. It does not require a synthetic AEP or lease and does not grant the later workload any authority; later launch still resolves its own complete current AEP.

Execution of a build definition — acquisition, containment, network bounds, time and size bounds, storage, verification, and import — is owned by `docs/specs/20260802-nanohost_runtime_and_transport.md`. The package carries the resolved inputs and lineage only, exactly as it does for every other backend-materialized field.

## Installed Resource Inputs

Resolved `supply` binds every selected Skill to its scoped catalog identity, exact digest and format, selection source, original package/member provenance when applicable, and complete bounded directory/file inventory under `docs/specs/20260711-skill_catalog_versioning_pinning.md`. Each resource has one unique Core-assigned inventory key using a nonempty `[A-Za-z0-9_-]+` segment. Inventory paths remain relative to that Skill root, with entry kind, normalized executability, and exact file length and SHA-256. Source bytes resolve from verified retained snapshots through NanoCore-private roots; host paths, mutable source locators, source-fetch credentials, and raw file bytes are not embedded in this inventory.

After the canonical AEP import, each regular file uses the existing `reference.import` effect under the import-only `worker-supply` identity and the exact inventory-derived destination owned by `docs/specs/20260801-nanohost_workspace_data_boundary.md`. Directory entries and executable flags remain immutable input metadata; the Worker Shim realizes them inside the assigned source root and verifies the complete Skill tree digest before adaptation. Required missing, extra, corrupt, unsupported, or target-colliding content blocks native launch. The same AEP identity binds source inventory, transfer proof, and adapter inputs; source provenance never permits refetching mutable content during launch.

MCP supply carries only the exact configuration version, current binding lineage, effective catalog digest, selected ids, and existing capability-plane metadata. It does not carry the original PluginVersion tree or any upstream command, endpoint, package environment, Vault material, or client-specific extension. The selected adapter creates the deterministic read-only native supply projection from verified Skill inputs and the fixed Gateway loopback binding under `docs/specs/20260907-agent_plugin_packaging_and_worker_supply.md`. Expected and reread observed derived-tree digests plus adapter identity belong to existing materialization evidence; generated files do not become catalog authority or publisher bytes.

Resource identity, inventory, selection, and static adapter projection participate in package and session compatibility. Changed resources require later AEP resolution and the existing replacement/compatibility path, never in-place edits to active session files. Delivery or native-launch uncertainty uses existing runtime inspection and cleanup; catalog publication and external runtime installation are separate effects without atomic rollback or automatic replay.

## Resolution And Launch Invariants

NanoCore must resolve and validate an AEP before any worker launch effect.

Verified image identity and defaults must be available before final AEP resolution and compatibility/lease admission. Existing image preparation/acquisition/build and immutable settlement supply that evidence; metadata-only compatibility planning performs no image effect and fails as preparation-required when evidence is missing. An authored build or mutable reference remains traceable to its original declaration, while materialization uses its already verified result digest rather than repeating a build to rediscover defaults. A mismatched or missing result refuses dependent launch; no empty-default fallback or silent tag re-resolution is permitted.

A native environment change creates a newly resolved package and never rewrites an admitted one. Retained packages lacking this field remain valid historical evidence; new environment-aware launch requires complete resolved evidence and a consumer that supports it, never inference from ambient state. Coordinate the strict schema and all current producers/consumers; no compatibility shim or `extensions` carrier substitutes for this owned field.

A resolved network rule retains the recognized `publicAccess` marker as immutable policy evidence. NanoCore must satisfy [Agent Manifest And AEP Resolution](20260703-agent_manifest_aep_resolution.md#manifest-shape)'s current public-class admission predicates before launch. The marker adds no backend request inspector and grants no inference, credential or managed MCP bypass.

The decision and its reason are recorded in [a decision record](../decisions/20260930-public_endpoints_by_admitted_grant.md).

Resolution and materialization obey these invariants:

- The exact `AgentManifest` image, opaque adapter id, runtime binary paths, sandbox declarations, and backend requirements are preserved or narrowed, never widened.
- Every network-policy binary path names a declared runtime binary path.
- The launch command is the generic zero-argument `openkit-worker-shim` with ignored stdin; runtime-native argv remains with the selected adapter, while the private `turn.start` operation carries Turn-scoped route tokens after Harness readiness.
- NanoHost realizes that command only through the runtime-owned fixed `ExecSandboxInteractive` Start with `/workspace`, no TTY, timeout zero, and the existing six non-secret lineage environment entries; no AEP field selects or widens those backend-private Start fields.
- `control.adapter.targetRuntime` is the sole adapter selector; `agent.runtimeKind`, image names, environment variables, and backend defaults do not select or infer an adapter.
- The package carries one preferred logical model and an exact non-empty allowed logical-model set; a missing member, an incompatible derived capability or model-family value, direct Provider authority, or a runtime that cannot consume the sandbox-local Gateway relay fails before child launch.
- The sandbox-local worker-control, inference, and capability bindings remain distinct and non-secret in the package. They share no token reference or authority, and raw authentication material is resolved through runtime-private channels.
- The package MUST NOT contain a NanoHost identity or credential, Runtime Epoch identity, Cell identity, remote NanoCore or Gateway URL, SSH target, Gateway forward, container-runtime endpoint, direct sandbox-to-NanoCore endpoint, OpenShell authentication material, or raw route token.
- Workspace paths and roots must pass the containment, immutable-base, materialization, and publication rules of their owners before launch.
- After bridge readiness and exact Core AgentSession admission, NanoCore imports the initial immutable canonical AEP through the fixed `package-config` path into the AgentSession-private package slot, followed by required session-static `worker-supply` files, before dispatching `session.open` and before native runtime start. The AEP's exact body, digest, and length are verified at the fixed destination under the existing import contract, and no secret or new file identity is introduced. During `session.open`, Sandbox Integration uses that admitted AEP's source and slot declarations to initialize a new empty work slot. Every prepared Context inventory file is imported before the first `turn.start`. On later Turns, exact reuse admission precedes AEP refresh, then worker-supply refresh, then Context imports; only then may `turn.start` bind the exact private AEP, resource inventory, and Context references. Missing, failed, changed, or uncertain package admission blocks later imports and native launch without replay.
- The prepared Context Package's exact sorted regular-file inventory and package-root digest must match the generated `context` input before its per-file imports can run, while output declarations remain path-only and cannot pre-authorize produced bytes.
- Required backend capabilities must be present and backend readiness must succeed before materialization can become launchable.
- Optional capability absence remains unadvertised; it does not authorize a fallback or silent degradation.
- A backend may implement only the declared image, command, files, mounts, credentials, policy, sandbox-local Integration bindings, resources, and evidence sinks.

The AEP is immutable. Any change to launch identity, image, command, adapter, binaries, workspace layout or content, context, selected Skill/MCP versions or bindings, resource inventories, credential attachment, Vault grant, policy, preferred or allowed logical-model contract, resource intent, output declaration, observability requirement, or backend requirement creates a new AEP and a new bounded launch. A change to a Gateway-private concrete route within the same pinned logical-model contract does not change the AEP because that route is neither package content nor worker-visible authority.

This specification defines no backend update operation, mutation of a pending or active package, environment rewrite, session-reuse inference, compatibility reader, or automatic retry. Retry is a new owning request that must resolve and validate current authority again.

Termination, evidence collection, workspace handoff, teardown, and retry outcomes use their worker-runtime, synchronization, scheduler, and backend-lifecycle owners. The AEP supplies immutable lineage and requirements but does not create another lifecycle.

## Secret And Authority Boundaries

An AEP and every persisted or public snapshot must contain no raw secret value, authorization header, unrestricted host path, backend-private handle, raw provider payload, NanoHost credential, raw route token, remote Gateway locator, or transport credential.

Worker-control, inference, capability, and credential access is expressed through non-secret declarations, logical-model IDs, Integration bindings, token references, secret references, Vault references, and grants. Exact credential values may exist only in the Vault or backend-private launch path authorized by those references, and they must not be copied into the AEP, its digest input, its durable snapshot, product records, ordinary logs, or public diagnostics. A token reference for one Integration route family MUST NOT be accepted as a reference for another family. LLM Provider profile IDs, Provider-native models, account slots, route-member IDs, fallback order, and Provider credentials are Gateway-private and MUST NOT appear in an AEP.

Platform credential resolution and injection do not target a public-class destination. The class does not inspect arbitrary user-owned image material or detect user-provided authentication in request contents; its guarantee concerns admitted platform supply and routing, not universal secret detection. Existing separately authorized credentialed non-LLM REST declarations retain their current meaning and cannot be silently reclassified as public.

The package schema recursively rejects raw secret-shaped fields. Snapshot persistence redacts backend-private identifiers and local runtime references and then parses the redacted value through the same strict version 4 schema before writing it.

The initiating `scope.triggerActor` is immutable launch lineage. Its responsible user is accountability and authorization context only and never selects a Workspace database, directory, store, or backend placement.

An immutable package proves authority at resolution time, not perpetual current authority. NanoCore must reauthorize each later NanoCore-mediated governed effect through its owning permission contract. Lost authority triggers the existing interrupt, cleanup, and publication rejection behavior; it does not mutate the AEP or invent cross-domain atomicity.

## Snapshot Restart And Recovery

NanoCore persists one immutable, redacted, strictly parsed AEP snapshot under the owning Workspace at:

```text
runtime/agent-sessions/<agent-session-id>/aep-snapshots/<snapshot-id>.json
```

The snapshot record binds `snapshotId`, `packageId`, Workspace, Thread, Turn, AgentSession, Agent, runtime kind, backend kind, `createdAt`, the redacted package, and a SHA-256 digest of the exact serialized redacted package.

Snapshot list and read operations expose only the redacted record through App API, Core Client, OpenAPI, and the unified Skill/CLI. The durable snapshot remains evidence and diagnostics; it is not a replay instruction or current access grant.

Normal resolution, snapshot reads, restart, export, and import accept version 4 only. No runtime alias, compatibility union, or fallback form is authorized, and no reader accepts a version 2 or version 3 package. A later package version carries retained snapshots forward as evidence through a one-way migration or an explicit data-retirement decision under Retained Data Continuity in `docs/core/contract-evolution.md`; current execution still accepts only the current version.

Current restart recovery parses the stored package and verifies its snapshot and scope against the durable lease, session, and admission lineage required by the scheduler and worker-runtime owners before using it as recovery evidence. It does not currently compare `backend.preferred` or `runtime.image.ref` with the durable backend session. A missing, malformed, secret-bearing, or lineage-conflicting snapshot fails closed.

An exact durable package and backend lineage may support the reconnect or closeout behavior already authorized by the scheduler and worker-runtime owners. When that proof is absent, recovery uses their cleanup and truthful interrupted, failed, or `recovery_required` outcomes; AEP defines no reconstruction, secret re-resolution, hidden retry, or repair workflow.

## Current Implementation Projection

The implemented resolver, schema, snapshot readers, migration, and restart path accept strict version 4 only and require exactly one resolved runtime image form: a reference or a bounded build. Reference resolution preserves the authored reference and pull policy owned by `docs/specs/20260703-agent_manifest_aep_resolution.md`. Build resolution validates the exact empty-context singleton, immutable inline nonempty UTF-8 Dockerfile bound and digest, arguments and their digest, explicit exact build-egress set, resource bounds, and no-secret/no-widen invariants; NanoHost dispatches byte-free bounded metadata, verifies the fixed `image.build/input` carriage before the effect, executes fixed `image.acquire` or `image.build`, and returns exact digest evidence.

`Implementation: Partial` is current.

NanoCore resolves a validated `AgentManifest` through the current `ResolvedAgentSetup`, parses the generated version 4 AEP, validates backend capability requirements, materializes the package through the NanoHost-owned runtime path, and records a redacted immutable snapshot. There is no earlier-version reader, alias, dual signature, or compatibility fallback.

The current production worker lifecycle selects only a `nanohost` RuntimeTarget. NanoCore retains the durable package, lease, session, and product authorities while the selected NanoHost materializes the `openshell` backend inside its Runtime Epoch; host, Cell, remote-placement, Gateway, SSH, and direct NanoCore backend selectors are rejected.

The current package projects the fixed generic worker shim, one adapter selected from the static Codex, OpenCode, and Pi registry by `control.adapter.targetRuntime`, transcript evidence, the preferred and allowed logical-model contract with one or more Gateway-private inference routes, workspace roots and context, static Skill and selected MCP supply, credential requirements and Vault bindings without a Provider section, policy, resources, observability, backend requirements, and the three sandbox-local Integration bindings for capability, worker-control, and inference with distinct Token references. It projects no concrete Provider identity, direct NanoCore endpoint, or raw Token. The exact generated Context Package inventory maps to fixed imports after package-config, path-only outputs map to NanoHost-produced and NanoCore-verified exports, the fixed unary NanoHost bootstrap retains its response monitor without Turn credentials, and private `turn.start` dispatch plus lease-owned distinct hash-only bindings carry and restore the three Turn route families. Adapter-specific native commands, output parsing, image contents, and enabled capability behavior remain with their narrow specifications.

The version 4 package and setup resolver implement the composed preferred and allowed logical-model contract without retaining a concrete Provider summary or Provider-native route. Gateway-private route selection remains outside the AEP, and earlier package versions are rejected rather than adapted.

The current version 4 `llm` section does not project the logical model's resolved context-management policy. Worker-wide central threshold control is therefore not implemented, and a Worker Harness's native compaction defaults remain runtime-local behavior until the next coordinated AEP version and the selected adapter satisfy `docs/specs/20260902-agent_runtime_context_compaction.md`.

Current packages with no selected MCP server project worker capabilities as disabled with no routes. A package with selected MCP server supply enables only `mcp.list_servers`, `mcp.list_tools`, and `mcp.call_tool` through the separately authenticated NanoCore Gateway route; it grants no direct MCP connection, arbitrary capability, or alternate control plane.

Persistent Skill/MCP versions, Plugin membership expansion, the declared `worker-supply` inventory, and verified native resource materialization are accepted targets but are not implemented by the current static supply shape. Their schema, resolver, fixed-file admission, and adapter changes must ship together; existing package-config and Context imports are not proof of this additional resource delivery.

Current snapshot persistence redacts and reparses the package, records its digest and lineage, and supports redacted list/read diagnostics. Scheduler restart recovery verifies snapshot, scope, lease, session, admission, backend kind, and exact reference or build-input lineage before using the package for cleanup, reconnect, or closeout evidence.

The current affected package tests, migration and database checks, typechecks, builds, linters, OpenAPI generation and validation, and NanoHost Rust tests, formatting, and Clippy checks pass. This implementation projection does not claim completion of the separate A1 gate.

## Failure Semantics

Every validation, resolution, materialization, snapshot, and recovery failure is fail-closed and must be reported without secret or backend-private material.

Missing, stale, duplicate, secret-bearing, protected, unrepresentable or oversized environment input fails before native work and preserves configuration and retained data.

Current observable failure categories are:

- authored manifest loading failure, reported as an invalid-manifest diagnostic;
- setup resolution failure for an invalid default profile, missing or unsupported logical model, or unsupported required feature;
- strict AEP schema or cross-field rejection;
- missing or contradictory Turn, AgentSession, actor, logical-model contract, workspace, policy, credential, Vault, Integration binding, image, adapter, binary, or backend input;
- unsupported backend selection, required backend capability, backend readiness, or runtime-route pairing;
- an image selection that is absent, ambiguous, or supplies both forms, or a build definition that is secret-bearing, sandbox-authority-widening, omits or changes `build-context://empty/v1` or `sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`, supplies an empty, non-UTF-8, over-268,435,456-byte, or digest-mismatched inline Dockerfile, mixes that independent Dockerfile into the context digest, lacks an explicit exact `{host, port}` build egress grant, infers a port or registry bootstrap authority, or declares `timeLimitSeconds` outside 1 through 1800, `outputLimitBytes` outside 1 through 21474836480, or `layerLimit` outside 1 through 128;
- redaction, snapshot parsing, digest, path, or lineage mismatch;
- missing, contradictory, non-regular, or digest-mismatched Context Package inventory input, or an output result whose slot or path contradicts its path-only declaration;
- restart evidence that is missing, stale, contradictory, or insufficient for the owning recovery action.

The current setup resolver has stable diagnostic codes for its three setup failures. AEP resolution, backend validation, and later runtime paths currently use ordinary errors or their owning service diagnostics rather than one unified typed AEP error set.

A closed cross-stage error taxonomy is not implemented and is not authorized by this specification. That absence is a finding for a future owning design if a concrete public or cross-module need appears; it must not be disguised here as an implemented resolver contract.

Failure before launch produces no worker launch. Failure after a physical effect follows the existing backend cleanup, scheduler, worker-control, workspace publication, and audit owners and must not be reported as successful materialization or canonical product completion.

## Acceptance Predicates

Qualification proves exact precedence and removal, empty-string preservation, secret/public separation, digest mismatch refusal, unsupported-consumer refusal and stable canonical values across restart; installed image strings or a successful config write are not application evidence.

Qualification proves admission denial for invalid classes, unauthorized application, targeting credentials or ambiguous existing credential-destination metadata, known excluded hosts, broader overlaps, required Gateway mediation and missing current evidence; it also proves lossless AEP classification and unchanged exact boundary rules. Header/query/body mutations are not a deciding denial oracle for this class. An allowed public request succeeds under the exact rules, disallowed host/port/binary/method/path traffic is denied, platform secrets are absent from the route's materialization and public evidence, and an existing credentialed non-LLM REST case remains valid under its original contract.

The contract is satisfied only when all of the following are observable:

- A parsed package has literal `schemaVersion: 4`, contains the complete strict top-level envelope without a `providers` section, applies only the three documented defaults, and ignores unknown additive members outside the core under Contract Evolution without persisting, forwarding or displaying ignored content from outside its trust boundary; unknown core values and unsupported required or authority-bearing semantics fail closed, while known-field immutability and secret checks remain required.
- One Server `AgentManifest`, optional Workspace binding, selected profile, applicable User preference, and request selection compose before one `ResolvedAgentSetup` produces one immutable AEP, with no parallel setup document or authority path.
- Unequal member parameters project a complete coherent logical contract when their required values are known; mixed families retain the Gateway-derived null family without exposing route identity. Missing required parameter values remain absent and an adapter requiring them refuses launch.
- Missing authored image, adapter, binary, network, credential requirement, Workspace, policy, logical-model contract, Integration binding, or backend authority is rejected rather than inferred.
- `runtime` resolves to exactly one image form: an image reference with its pull policy, or a bounded build definition. Both forms and neither form are rejected.
- A build definition preserves exactly `build-context://empty/v1` with digest `sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`, whose zero-entry canonical byte sequence is empty bytes, and preserves 1 through 268,435,456 exact UTF-8 Dockerfile bytes inline as independently digested package content excluded from that context digest. It also preserves explicit exact `{host, port}` ordinary build grants with no inferred port or registry bootstrap authority, `timeLimitSeconds` from 1 through 1800, `outputLimitBytes` from 1 through 21474836480, and `layerLimit` from 1 through 128; it has no secret value, capability, host path, build root, socket, Dockerfile locator, context transfer, or future context variant and grants the resulting sandbox no authority beyond the package's own grants.
- The image digest produced from a build definition is recorded as preparation or launch evidence and used with the build-definition lineage wherever `runtime.image.ref` would otherwise anchor package-to-session consistency. Environment-aware resolution includes its already verified result in `runtime.environment.imageDigest` before admission; no later result rewrites the immutable package.
- The package passes strict schema, cross-field, required-capability, and backend-readiness checks before worker launch.
- Materialization and launch do not widen the parsed package or expose a second control, inference, credential, or capability route.
- A generated Context Package input preserves its package-root digest and declared `context` slot while private roots and host paths remain outside the package; every output declaration remains path-only, and actual export digest and length are accepted only as NanoHost-produced evidence after NanoCore byte verification and canonical-owner handoff.
- The worker-consumed AEP is reparsed immediately before import and serialized as compact UTF-8 JSON with recursively UTF-16-code-unit-sorted object keys, preserved array order, JSON-stringified keys and strings, no BOM, and no trailing newline; non-JSON values fail before effects, and its exact lowercase SHA-256 plus byte length bind the import identity.
- The first successful import for each admitted Turn is its canonical AEP at `/openkit/sessions/<agent-session-id>/config/package.json`; it precedes the exact `worker-supply` file inventory, complete private Context inventory, and `turn.start`. The data-boundary path grammar admits no adjacent path, export, caller-selected root, or new transfer surface. Failed import or unproved prior-input cleanup prevents launch under the existing runtime cleanup and wider-fence owner.
- The package carries only distinct non-secret sandbox-local Integration bindings and token references for worker control, inference, and capability; it carries no raw route token, NanoHost credential, remote Gateway or NanoCore endpoint, SSH target, Gateway forward, container-runtime endpoint, Cell identity, or Runtime Epoch identity.
- The package carries one preferred logical model and an exact non-empty allowed logical-model set with each member's Gateway-derived effective capabilities and `modelFamilyId`; it carries no LLM Provider profile, Provider-native model, account slot, private route member, fallback order, or Provider credential.
- NanoHost bootstrap uses only the fixed package command and six existing non-secret lineage environment entries and carries no Turn credential; private `turn.start` supplies three mutually distinct raw route tokens through AgentSession-local bindings, with worker control restricted to the Worker Shim control client and inference and enabled capability restricted to their authorized sanitized native bindings.
- Raw secrets, authorization material, backend-private handles, and unrestricted host references are absent from the AEP, durable snapshot, public diagnostics, and product records.
- Exact Skill trees verify from the retained version inventory before adapter exposure, and the expected derived supply digest equals the digest reread from installed bytes. Missing, extra, tampered, or unsupported required resources prevent native launch; raw source MCP configuration, credentials, and nonstandard extensions never enter worker discovery. A new Skill selection changes the AEP and uses the existing session compatibility boundary.
- Any material launch-input change produces a new package and bounded launch rather than mutating an existing package or session.
- The persisted snapshot is redacted, reparsed as version 4, digest-bound, Workspace-owned, and linked to the exact package, Turn, AgentSession, Agent, runtime, and backend.
- Complete restart evidence rejects a missing or mismatched package snapshot and requires `backend.preferred` and `runtime.image.ref` to match the durable backend session before claiming package-to-session consistency; the current path remains partial for those two comparisons.
- Current diagnostics distinguish the implemented setup failures and truthful broader failure categories without claiming a unified typed resolver taxonomy.
- Deleting backend-private material or one concrete adapter does not change the AEP's NanoCore-owned authority, strict envelope, or product lineage.

## Admitted Capture Binding

observability.captureCoverage is the required immutable projection of the owning Turn admission pair {scope: server | workspace | task, value: off | on}. Core supplies it from persisted history before governed work starts; Worker code does not re-resolve current configuration or infer it from provenance enablement. Missing or conflicting history blocks governed dispatch rather than silently selecting off. Exact reconnect reuses the binding; a new Turn receives its own binding. Runtime availability and successful content publication are separate observations, not claims made by this setting.

Pure pre-admission compatibility planning may use a non-dispatchable metadata projection that omits the not-yet-admitted capture binding. It must not pass as a complete dispatchable AEP, persist a historical binding, or start governed work. Actual AEP construction requires the durable Turn binding. Per-Turn capture values do not partition the existing SessionCompatibilityKey.
