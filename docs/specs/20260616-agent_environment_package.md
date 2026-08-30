---
status: Accepted
implementation: Partial
updated: 2026-08-31
---
# Agent Environment Package And Worker Governance Backends

## Owns

This specification owns the implementation-facing `AgentEnvironmentPackage` contract and the boundary between NanoCore's resolved worker-execution authority and a worker governance backend's materialization.

It owns the strict version 4 envelope, the exact canonical worker-consumed byte projection and package-config identity, the resolution and immutability invariants, the no-widen and no-secret boundaries, the redacted snapshot requirement, and the package evidence needed for launch, restart, and recovery decisions.

It owns the two forms a resolved runtime image may take inside the package — a digest-pinned published image reference or a bounded build definition — and the immutability, no-secret, no-widen, and resolution rules that apply to the build definition as package content. It does not own how a build definition is executed, stored, or imported.

## Does Not Own

This specification does not own the user-authored `AgentManifest`, provider or Vault lifecycle, workspace synchronization, worker-control protocol, capability routing, scheduling, NanoHost identity or transport, Runtime Epoch lifecycle, backend-native policy or lifecycle artifacts, runtime-native adapter behavior, product records, public UI behavior, or a cross-stage error taxonomy.

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

The parsed package has `schemaVersion: 4` and exactly these top-level fields:

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

Unknown top-level fields are rejected. Backend-specific or private expansion belongs under `extensions` only when another accepted owner defines its use; `extensions` never bypasses the package's authority, secret, or validation rules.

The schema supplies only these top-level defaults during parsing:

- `capabilities` defaults to protocol `openkit-worker-capability-v1`, mode `disabled`, and no routes;
- `credentials` defaults to no declarations;
- `extensions` defaults to an empty object.

All other top-level fields are required. `schemaVersion` is the literal number `4`, `createdAt` is an ISO date-time, and `packageId` plus `snapshotId` are non-empty immutable identities.

The top-level sections have these responsibilities:

| Section | Package responsibility |
| --- | --- |
| `scope` | Binds Workspace, Thread, Turn, AgentSession, request, and initiating `ActorRef` lineage. |
| `agent` | Identifies the selected Agent and descriptive runtime/profile projection. |
| `runtime` | Carries the governed image selection defined below, declared absolute worker binaries, fixed generic shim command, and process/session inputs. |
| `workspace` | Carries the worker-visible root, declared inputs, generated material, and output declarations. |
| `supply` | Carries resolved static Skill and MCP catalog material without granting a callable route. |
| `control` | Carries the sandbox-local `/worker-control/*` Integration binding, transcript, non-secret worker-control token reference, and the opaque runtime-adapter selector. |
| `capabilities` | Carries the sandbox-local `/capabilities/*` Integration binding and separately governed worker-capability projection; the current implementation projection is disabled with no routes. |
| `credentials` | Carries declarations and references only, never credential values. |
| `vault` | Carries non-secret Vault references and grants owned by the Vault contracts. |
| `policy` | Carries the exact filesystem, process, network, and secret policy intent to materialize. |
| `llm` | Carries one resolved sandbox-local `/inference/*` semantic binding, distinct token reference and authority mode, one preferred logical model ID, and the exact non-empty allowed logical-model set with each member's Gateway-derived effective capabilities and `modelFamilyId`; it carries no concrete Provider or route identity, and trusted relay packages omit `workerBaseUrl` and every native URL. |
| `resources` | Carries worker resource intent without creating a second scheduler. |
| `observability` | Carries required audit and evidence expectations. |
| `backend` | Carries the preferred backend, allowed kinds, and required capability set. |
| `extensions` | Carries bounded owner-defined data that grants no independent authority. |

Nested field shapes and lifecycle rules remain with the narrow owners linked above. This specification requires their resolved projections to agree in one strict envelope rather than duplicating their tables.

### Canonical Worker-Consumed Byte Projection

Immediately before NanoCore prepares the worker-consumed package import, it parses the candidate again through `AgentEnvironmentPackageSchema`; parse failure or a value outside the JSON domain fails before any effect. It then serializes recursively by preserving array order, sorting every object key by JavaScript UTF-16 code-unit order, encoding object keys and scalar strings with `JSON.stringify`, and accepting only null, booleans, strings, finite JSON numbers, arrays, and plain JSON objects. `undefined`, a non-finite number, bigint, symbol, function, cycle, non-plain object, or any other non-JSON value is rejected rather than coerced or omitted.

The exact body is compact UTF-8 JSON with no BOM and no trailing newline. Its byte identity is the lowercase `sha256:<64hex>` digest over those exact bytes plus their UTF-8 byte length. The same exact body, digest, and length enter the existing `reference.import` request identity and file-data proof. This serializer remains local to the existing worker-governance package producer, and the legacy CLI package writer calls that same local owner; it is not a general canonical-JSON framework or dependency. The durable redacted snapshot and its digest remain a distinct evidence projection and are neither reused nor redefined by this byte identity. The complete worker-consumed body independently remains subject to the existing `package-config` import ceiling of 268,435,456 bytes, so an individually valid Dockerfile can still make the later aggregate package admission fail under the existing pre-bootstrap cleanup and fence lifecycle.

NanoCore owns those immutable package bytes. It imports them through the existing `reference.import` operation under the sole non-workspace identity `package-config`, exact relative path `package.json`, and fixed image-private destination `/openkit/config/package.json`. `package-config` is not an AEP field, declared workspace slot, output, Artifact, snapshot, credential, transport authority, executable selector, or general configuration-file surface. NanoHost owns only request-private staging and local effect proof, while the image helper owns only that fixed placement. Adjacent identity or path, export, another destination, and caller, package, image-metadata, or configuration selection are rejected.

For the NanoHost cross-host projection, the dedicated generated Context Package input preserves the exact package-root digest and binds to the declared `context` slot; NanoCore-private `workspaceRoots`, source paths, host paths, archives, and transfer handles never enter the AEP or wire contract. Each output declaration carries only its output id, normalized slot-relative path, registration posture, and retention, never a predicted digest or byte length. The NanoHost computes actual export digest and length after the terminal barrier, and those facts remain backend evidence until NanoCore verifies the bytes and hands them to the existing transcript, Artifact, or Workspace collection owner.

The package preserves distinct non-secret worker-control and inference token references, but neither raw live token nor its hash is AEP content. The NanoHost runtime resolves two independent attempt-private raw values only through the sensitive `bridge.open` boundary and supplies them to the fixed worker bootstrap through exactly two stdin slots; they never enter the fixed Start argv or environment, package, package digest, snapshot, Context Package, or another route family. The worker-control token reaches only descriptor 3, while the inference token reaches the native Agent only through the existing sanitized `OPENKIT_WORKER_INFERENCE_TOKEN` binding; capability remains disabled and receives no token. The selected adapter owns any fixed native URL that projects the semantic inference binding; NanoCore, the AEP, and the worker manifest do not select or serialize it.

## Runtime Image Selection And Build Definition

`runtime` resolves to exactly one of two image forms, never both and never neither. `runtime.image.ref` therefore stops being unconditional and becomes one arm of a discriminated selection, which changes the meaning of an existing field.

The image-form change originally moved the package to version 3. Replacing the concrete Provider route with the logical-model contract and removing the `providers` section now moves the package directly to `schemaVersion: 4`. `docs/specs/20260703-schema_evolution_record_envelope.md` permits a version change, and a required feature is appropriate only when old and new readers must coexist. Under this repository's internal-development rule they do not: NanoCore, Sandbox Integration, and the execution runtime are released together, restart recovery reads a snapshot written by the same version, and an incompatible historical data root is replaced rather than migrated. There is one accepted shape, and version 2 or version 3 packages are invalid.

**Image reference.** A published image reference with its pull policy, exactly as authored and resolved today. Which reference forms an author may use, and how a tag is treated, remain owned by `docs/specs/20260703-agent_manifest_aep_resolution.md`, `docs/specs/20260708-container_image_packaging.md`, and `docs/specs/20260721-worker_execution_environment_images.md`. This specification adds no new restriction on that form; resolving a reference to the exact content digest a sandbox consumes happens at the execution runtime's acquisition boundary and is owned there.

**Build definition.** A bounded description from which the execution runtime produces one image for this attempt, consisting of the exact V1 build-context singleton reference `build-context://empty/v1`, its exact content digest `sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`, one build input document, declared build arguments, a declared build egress grant set, and exact positive-integer `timeLimitSeconds`, `outputLimitBytes`, and `layerLimit` values. The singleton denotes a zero-entry canonical context whose byte sequence is exactly empty bytes. The V1 build input document is a Dockerfile whose value encodes nonempty UTF-8 bytes with length from 1 through 268,435,456 inclusive. Those exact bytes remain inline immutable AEP content, participate in the build-input and package digests, and are carried independently from the context; they MUST NOT enter or alter the build-context digest. The existing `input.digest` is lowercase SHA-256 over exactly those UTF-8 bytes. No BOM removal, newline normalization, compression, locator, fetch, path, alternate spelling, or context mutation is inferred. Resolving the build input grants no host, shell, lifecycle, capability, host-path, build-root, socket, context-transfer, or context-variant authority, and NanoCore MUST NOT interpret it as anything other than package content bound by its independent digest.

The build definition obeys the same package rules as every other resolved input, stated here because it is the first package field whose content is executable elsewhere:

- **Immutable.** The exact singleton context reference and digest, independent build input document, and build arguments are part of the package and its digest. Any change produces a new package and a new bounded launch; a package is never mutated to change a build. V1 accepts no other context reference or digest, and resolution MUST NOT infer, substitute, fetch, transfer, configure, or synthesize another context variant.
- **Bounded exact bytes.** Authored and resolved Dockerfiles MUST each encode 1 through 268,435,456 UTF-8 bytes inclusive and MUST match the declared lowercase SHA-256 over those exact bytes. Empty, non-UTF-8, oversized, or digest-mismatched input fails before a scheduler or backend effect; neither resolution nor carriage may replace the inline bytes with a reference.
- **No secret.** Build arguments carry no secret value, credential, token, authorization header, or unrestricted host path, and the schema rejects secret-shaped fields recursively exactly as elsewhere. A build that needs credential material expresses it as a non-secret reference; this specification authorizes no build-time secret delivery, and the absence of that mechanism is a truthful limit rather than an implied capability.
- **No widen of the sandbox.** A build definition MUST NOT grant the sandbox that runs the resulting image any network, filesystem, credential, or capability authority beyond what the same package's `policy`, `providers`, `credentials`, and `vault` sections already grant it. Nothing a build installs, writes, or configures becomes runtime authority; the launch policy remains the only authority.
- **Declared build egress.** A build legitimately needs network access the resulting sandbox does not have, because package managers and language toolchains are build-time concerns. Pretending otherwise would make the form unusable, so build egress is its own explicitly declared, bounded grant set inside the build definition rather than an inherited or implied widening of the sandbox grants. It is authored, resolved, and validated like every other grant, it is scoped to ordinary build traffic only, and it is **not** inherited by the sandbox. Each resolved grant preserves exactly one explicit `{host, port}` pair; a missing host or port, wildcard host, non-positive or out-of-range port, path, URL, protocol, capability, socket, inferred default, or inferred `443` is rejected. The runtime-owned fixed OCI registry bootstrap pairs are separate from AEP grants and do not create, remove, replace, or default an authored pair. Whether a given endpoint may appear in a build egress set remains a workspace-policy decision under its existing owner.
- **Declared execution bounds.** `timeLimitSeconds`, `outputLimitBytes`, and `layerLimit` are required positive integers and each MUST be no greater than the corresponding maximum owned by `docs/specs/20260802-nanohost_runtime_and_transport.md`. V1 therefore accepts `timeLimitSeconds` from 1 through 1800, `outputLimitBytes` from 1 through 21474836480, and `layerLimit` from 1 through 128, all inclusive. Absence, zero, a negative or fractional value, overflow, or a value above its exact maximum fails resolution before any build effect; neither NanoCore nor NanoHost supplies a default or raises a declared bound.
- **Resolved before launch.** NanoCore validates the build definition during ordinary AEP resolution, before any launch or build effect. Validation failure is a strict schema or cross-field rejection.
- **Not a published image.** The image a build definition produces is attempt-scoped. Its publication boundary and content guarantees are owned by `docs/specs/20260721-worker_execution_environment_images.md`; this specification only requires that the package never names such an image as a deployment image.
- **Digest binding.** The resulting image digest is bound to the attempt by the execution runtime owner and recorded as launch evidence. It is never written back into the immutable package. Under the build form the package-to-session consistency comparison that otherwise uses `runtime.image.ref` uses the build-definition lineage — the exact empty-context singleton reference and digest, independent Dockerfile input digest, and resolved argument digest — plus the recorded resulting image digest, and a missing or mismatched value fails closed exactly as a reference mismatch does.

Execution of a build definition — acquisition, containment, network bounds, time and size bounds, storage, verification, and import — is owned by `docs/specs/20260802-nanohost_runtime_and_transport.md`. The package carries the resolved inputs and lineage only, exactly as it does for every other backend-materialized field.

## Resolution And Launch Invariants

NanoCore must resolve and validate an AEP before any worker launch effect.

Resolution and materialization obey these invariants:

- The exact `AgentManifest` image, opaque adapter id, runtime binary paths, sandbox declarations, and backend requirements are preserved or narrowed, never widened.
- Every network-policy binary path names a declared runtime binary path.
- The launch command is the generic `openkit-worker-shim --package /openkit/config/package.json`; runtime-native argv remains with the selected adapter.
- NanoHost realizes that command only through the runtime-owned fixed `ExecSandboxInteractive` Start with `/workspace`, no TTY, timeout zero, and the existing six non-secret lineage environment entries; no AEP field selects or widens those backend-private Start fields.
- `control.adapter.targetRuntime` is the sole adapter selector; `agent.runtimeKind`, image names, environment variables, and backend defaults do not select or infer an adapter.
- The package carries one preferred logical model and an exact non-empty allowed logical-model set; a missing member, an incompatible derived capability or model-family value, direct Provider authority, or a runtime that cannot consume the sandbox-local Gateway relay fails before child launch.
- The sandbox-local worker-control, inference, and capability bindings remain distinct and non-secret in the package. They share no token reference or authority, and raw authentication material is resolved through runtime-private channels.
- The package MUST NOT contain a NanoHost identity or credential, Runtime Epoch identity, Cell identity, remote NanoCore or Gateway URL, SSH target, Gateway forward, container-runtime endpoint, direct sandbox-to-NanoCore endpoint, OpenShell authentication material, or raw route token.
- Workspace paths and roots must pass the containment, immutable-base, materialization, and publication rules of their owners before launch.
- After `sandbox.create`, the exact canonical AEP body must be admitted first as `package-config/package.json` to `/openkit/config/package.json`; only then may the prepared Context Package inventory imports run, and only after all of them succeed may `bridge.open` start the fixed bootstrap. Missing, failed, changed, or uncertain package-config admission blocks every later import and worker launch.
- The prepared Context Package's exact sorted regular-file inventory and package-root digest must match the generated `context` input before its per-file imports can run, while output declarations remain path-only and cannot pre-authorize produced bytes.
- Required backend capabilities must be present and backend readiness must succeed before materialization can become launchable.
- Optional capability absence remains unadvertised; it does not authorize a fallback or silent degradation.
- A backend may implement only the declared image, command, files, mounts, credentials, policy, sandbox-local Integration bindings, resources, and evidence sinks.

The AEP is immutable. Any change to launch identity, image, command, adapter, binaries, workspace layout or content, context, credential attachment, Vault grant, policy, preferred or allowed logical-model contract, resource intent, output declaration, observability requirement, or backend requirement creates a new AEP and a new bounded launch. A change to a Gateway-private concrete route within the same pinned logical-model contract does not change the AEP because that route is neither package content nor worker-visible authority.

This specification defines no backend update operation, mutation of a pending or active package, environment rewrite, session-reuse inference, compatibility reader, or automatic retry. Retry is a new owning request that must resolve and validate current authority again.

Termination, evidence collection, workspace handoff, teardown, and retry outcomes use their worker-runtime, synchronization, scheduler, and backend-lifecycle owners. The AEP supplies immutable lineage and requirements but does not create another lifecycle.

## Secret And Authority Boundaries

An AEP and every persisted or public snapshot must contain no raw secret value, authorization header, unrestricted host path, backend-private handle, raw provider payload, NanoHost credential, raw route token, remote Gateway locator, or transport credential.

Worker-control, inference, capability, and credential access is expressed through non-secret declarations, logical-model IDs, Integration bindings, token references, secret references, Vault references, and grants. Exact credential values may exist only in the Vault or backend-private launch path authorized by those references, and they must not be copied into the AEP, its digest input, its durable snapshot, product records, ordinary logs, or public diagnostics. A token reference for one Integration route family MUST NOT be accepted as a reference for another family. LLM Provider profile IDs, Provider-native models, account slots, route-member IDs, fallback order, and Provider credentials are Gateway-private and MUST NOT appear in an AEP.

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

Normal resolution, snapshot reads, restart, export, and import accept version 4 only. No runtime alias, compatibility union, or fallback form is authorized, and no reader accepts a version 2 or version 3 package.

Current restart recovery parses the stored package and verifies its snapshot and scope against the durable lease, session, and admission lineage required by the scheduler and worker-runtime owners before using it as recovery evidence. It does not currently compare `backend.preferred` or `runtime.image.ref` with the durable backend session. A missing, malformed, secret-bearing, or lineage-conflicting snapshot fails closed.

An exact durable package and backend lineage may support the reconnect or closeout behavior already authorized by the scheduler and worker-runtime owners. When that proof is absent, recovery uses their cleanup and truthful interrupted, failed, or `recovery_required` outcomes; AEP defines no reconstruction, secret re-resolution, hidden retry, or repair workflow.

## Current Implementation Projection

The implemented resolver, schema, snapshot readers, migration, and restart path accept strict version 3 only and require exactly one resolved runtime image form: a reference or a bounded build. Reference resolution preserves the authored reference and pull policy owned by `docs/specs/20260703-agent_manifest_aep_resolution.md`. Build resolution validates the exact empty-context singleton, immutable inline nonempty UTF-8 Dockerfile bound and digest, arguments and their digest, explicit exact build-egress set, resource bounds, and no-secret/no-widen invariants; NanoHost dispatches byte-free bounded metadata, verifies the fixed `image.build/input` carriage before the effect, executes fixed `image.acquire` or `image.build`, and returns exact digest evidence.

`Implementation: Partial` is current.

NanoCore resolves a validated `AgentManifest` through the current `ResolvedAgentSetup`, parses the generated version 3 AEP, validates backend capability requirements, materializes the package through the NanoHost-owned runtime path, and records a redacted immutable snapshot. There is no version 2 reader, alias, dual signature, or compatibility fallback.

The current production worker lifecycle selects only a `nanohost` RuntimeTarget. NanoCore retains the durable package, lease, session, and product authorities while the selected NanoHost materializes the `openshell` backend inside its Runtime Epoch; host, Cell, remote-placement, Gateway, SSH, and direct NanoCore backend selectors are rejected.

The current package projects the fixed generic worker shim, one adapter selected from the static Codex, OpenCode, and Pi registry by `control.adapter.targetRuntime`, transcript evidence, one supported inference route, workspace roots and context, static Skill and MCP supply, provider and Vault declarations, policy, resources, observability, backend requirements, and the three sandbox-local Integration bindings for capability, worker-control, and inference with distinct Token references. It projects no direct NanoCore endpoint or raw Token. The exact generated Context Package inventory maps to fixed imports after package-config, path-only outputs map to NanoHost-produced and NanoCore-verified exports, the fixed unary two-token NanoHost bootstrap retains its response monitor, and lease-owned distinct hash-only worker-control and inference bindings restore on restart. Adapter-specific native commands, output parsing, provider-route compatibility, image contents, and enabled capability behavior remain with their narrow specifications.

The current version 3 package and setup resolver therefore diverge from the version 4 target: they retain a concrete Provider summary and one concrete inference route, do not carry the composed preferred and allowed logical-model contract, and cannot prove that Provider identity stays Gateway-private. The implementation must replace version 3 directly rather than add a compatibility reader.

Current packages project worker capabilities as disabled with no routes. Static Skill or MCP supply does not grant a worker capability, direct MCP connection, or alternate control plane.

Current snapshot persistence redacts and reparses the package, records its digest and lineage, and supports redacted list/read diagnostics. Scheduler restart recovery verifies snapshot, scope, lease, session, admission, backend kind, and exact reference or build-input lineage before using the package for cleanup, reconnect, or closeout evidence.

The current affected package tests, migration and database checks, typechecks, builds, linters, OpenAPI generation and validation, and NanoHost Rust tests, formatting, and Clippy checks pass. This implementation projection does not claim completion of the separate A1 gate.

## Failure Semantics

Every validation, resolution, materialization, snapshot, and recovery failure is fail-closed and must be reported without secret or backend-private material.

Current observable failure categories are:

- authored manifest loading failure, reported as an invalid-manifest diagnostic;
- setup resolution failure for an invalid default profile, missing provider under the current version 3 implementation, or unsupported required feature;
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

The contract is satisfied only when all of the following are observable:

- A parsed package has literal `schemaVersion: 4`, contains the complete strict top-level envelope without a `providers` section, applies only the three documented defaults, and rejects unknown top-level fields.
- One Server `AgentManifest`, optional Workspace binding, selected profile, applicable User preference, and request selection compose before one `ResolvedAgentSetup` produces one immutable AEP, with no parallel setup document or authority path.
- Missing authored image, adapter, binary, network, credential requirement, Workspace, policy, logical-model contract, Integration binding, or backend authority is rejected rather than inferred.
- `runtime` resolves to exactly one image form: an image reference with its pull policy, or a bounded build definition. Both forms and neither form are rejected.
- A build definition preserves exactly `build-context://empty/v1` with digest `sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855`, whose zero-entry canonical byte sequence is empty bytes, and preserves 1 through 268,435,456 exact UTF-8 Dockerfile bytes inline as independently digested package content excluded from that context digest. It also preserves explicit exact `{host, port}` ordinary build grants with no inferred port or registry bootstrap authority, `timeLimitSeconds` from 1 through 1800, `outputLimitBytes` from 1 through 21474836480, and `layerLimit` from 1 through 128; it has no secret value, capability, host path, build root, socket, Dockerfile locator, context transfer, or future context variant and grants the resulting sandbox no authority beyond the package's own grants.
- The image digest produced from a build definition is recorded as launch evidence, never written back into the immutable package, and used with the build-definition lineage wherever `runtime.image.ref` would otherwise anchor package-to-session consistency.
- The package passes strict schema, cross-field, required-capability, and backend-readiness checks before worker launch.
- Materialization and launch do not widen the parsed package or expose a second control, inference, credential, or capability route.
- A generated Context Package input preserves its package-root digest and declared `context` slot while private roots and host paths remain outside the package; every output declaration remains path-only, and actual export digest and length are accepted only as NanoHost-produced evidence after NanoCore byte verification and canonical-owner handoff.
- The worker-consumed AEP is reparsed immediately before import and serialized as compact UTF-8 JSON with recursively UTF-16-code-unit-sorted object keys, preserved array order, JSON-stringified keys and strings, no BOM, and no trailing newline; non-JSON values fail before effects, and its exact lowercase SHA-256 plus byte length bind the import identity.
- The first successful import after `sandbox.create` is exactly `package-config/package.json` at fixed `/openkit/config/package.json`; it precedes every generated Context Package import and `bridge.open`, admits no adjacent path, export, selector, schema field, or new transfer surface, and any absent, changed, failed, or uncertain package import prevents worker launch under the existing delete-to-epoch-fence truth.
- The package carries only distinct non-secret sandbox-local Integration bindings and token references for worker control, inference, and capability; it carries no raw route token, NanoHost credential, remote Gateway or NanoCore endpoint, SSH target, Gateway forward, container-runtime endpoint, Cell identity, or Runtime Epoch identity.
- The package carries one preferred logical model and an exact non-empty allowed logical-model set with each member's Gateway-derived effective capabilities and `modelFamilyId`; it carries no LLM Provider profile, Provider-native model, account slot, private route member, fallback order, or Provider credential.
- NanoHost bootstrap uses only the fixed package command and six existing non-secret lineage environment entries; its two independent raw tokens cross only the runtime-private stdin-slot boundary, with worker control restricted to descriptor 3 and inference restricted to the authorized sanitized native binding.
- Raw secrets, authorization material, backend-private handles, and unrestricted host references are absent from the AEP, durable snapshot, public diagnostics, and product records.
- Any material launch-input change produces a new package and bounded launch rather than mutating an existing package or session.
- The persisted snapshot is redacted, reparsed as version 4, digest-bound, Workspace-owned, and linked to the exact package, Turn, AgentSession, Agent, runtime, and backend.
- Complete restart evidence rejects a missing or mismatched package snapshot and requires `backend.preferred` and `runtime.image.ref` to match the durable backend session before claiming package-to-session consistency; the current path remains partial for those two comparisons.
- Current diagnostics distinguish the implemented setup failures and truthful broader failure categories without claiming a unified typed resolver taxonomy.
- Deleting backend-private material or one concrete adapter does not change the AEP's NanoCore-owned authority, strict envelope, or product lineage.
