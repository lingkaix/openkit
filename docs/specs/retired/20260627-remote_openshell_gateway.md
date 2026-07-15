# Remote OpenShell Gateway

Status: Retired
Implementation: N/A
Status Changed: 2026-07-15
Current Guidance: None
Decision Evidence: `docs/changes/202607111941330001-core_spec_implementation_alignment_audit.md`

Active replacement: `../20260715-openshell_disposable_cell_lifecycle.md` supports both local and remote placement only when the Gateway and its sandboxes are inside one single-slot disposable Cell. This document's naked external-Gateway contract remains retired.

The earlier external remote Gateway path ended because it did not bind the endpoint to a whole-runtime teardown target, and stock OpenShell resource deletion could not prove that an older accepted create had terminated.

The replacement is a new Cell contract rather than compatibility for this archived design. Remote placement now requires a fixed SSH lifecycle target, a loopback HTTP Gateway origin backed by an operator-managed SSH local-forward, and an explicit credential-free HTTP(S) sandbox-reachable worker-control URL; a reachable shared Gateway alone is invalid.

## Lifecycle Reason

The remote external-Gateway contract ended after real stock OpenShell `0.0.80` testing showed that resource-level sandbox deletion could not prove that an older accepted create had terminated before scheduler capacity release. Current remote placement is valid only because the fixed remote helper gives NanoCore the same complete Gateway and container-runtime epoch teardown boundary as local placement.

## Retention Reason

This document preserves the previous remote topology, connectivity, workspace transport, health, and product-boundary decisions so maintainers can interpret historical A1 acceptance work. It is not current guidance for runtime selection, connectivity, or teardown; use the active disposable Cell spec instead.

## Summary

OpenKit needs a remote container runtime path that keeps NanoCore as the product source of truth while allowing worker agents to run in containers managed by a remote OpenShell gateway.

The first target is remote container placement backed by OpenShell.

This mode is not a new orchestrator, a second NanoCore, or an MCP-visible sandbox control API.

It is a remote Worker Governance backend target that reuses the same Agent Environment Package, Worker Control Gateway, workspace materialization, change-set collection, staged review, Action Center, and evidence contracts used by local container execution.

## Current Implementation Mapping

NanoCore supports remote container placement through `OPENKIT_WORKER_RUNTIME=container`, `OPENKIT_CONTAINER_PLACEMENT=remote`, and `OPENKIT_CONTAINER_BACKEND=openshell`, and keeps local/server NanoCore mode separate from worker runtime placement.

The accepted V1 implementation has configuration parsing, fail-closed diagnostics, deterministic deployment-mode tests, remote OpenShell target selection, direct worker-control configuration, scheduler-owned lineage, workspace synchronization evidence persistence, redacted backend workspace handles, workspace recovery records, Action Center recovery rows, vault-backed credential attachment, permission/audit linkage, and opt-in remote OpenShell verification paths. Deployment packaging, multi-gateway operations, richer remote health probing, and remote runtime gateway extraction remain future work rather than blockers for the V1 remote OpenShell placement contract.

OpenShell sandbox deletion normalizes the pinned 0.0.80 missing-entity result whose product-safe diagnostic contains `sandbox not found`, because the desired absent state already holds. Any other delete error remains a cleanup failure. Backend teardown itself requires a tracked materialized session: it is retryable after partial cleanup, but a second teardown after successful session removal is not an idempotent operation.

## Owns

- The remote OpenShell worker governance backend projection.
- Remote placement architecture for OpenShell-managed worker containers.
- Direct remote worker control, data transport, workspace materialization, evidence collection, and staged review boundaries.
- Backend capability expectations for remote OpenShell placement.
- The future extraction path toward a backend-neutral remote runtime gateway.

## Does Not Own

- Core deployment semantics, NanoCore auth, or public product API semantics.
- Worker-control operation schemas or worker capability route schemas.
- AEP schema ownership beyond remote placement metadata requirements.
- Workspace synchronization record schemas, staged review decision semantics, or apply behavior.
- Runtime scheduling, queueing, warm pools, capacity, or multi-gateway placement policy.
- OpenShell-native gateway internals, policy YAML schema, or provider-specific CLI contracts as public product semantics.

## Core References

- `docs/deployment.md`
- `docs/core/runtime-model.md`
- `docs/core/sandbox.md`
- `docs/core/agent-capability.md`
- `docs/core/agent-session.md`
- `docs/core/storage.md`

## Goals / Non-goals

### Goals

- Define the architecture for running agent workers in remote OpenShell-managed containers.
- Keep NanoCore server mode as the source of truth for Goal Mode, worker lineage, workspace materialization records, change sets, artifacts, Action Center rows, and review decisions.
- Make remote container placement a backend target under the Worker Governance boundary instead of a new product channel.
- Use the same authenticated direct NanoCore worker-control contract for local and remote placement.
- Reuse the workspace materialization and synchronization model from `docs/specs/20260703-workspace_synchronization.md`.
- Preserve backend portability so future remote Docker, VM, Kubernetes, managed sandbox, or custom worker gateway implementations can share the same product semantics.

### Non-goals

- Do not expose generic remote shell execution through MCP, App API, or Web UI.
- Do not let remote containers directly push, tag, publish, deploy, or mutate protected branches in the first implementation.
- Do not make OpenShell ids, policy YAML, gateway internals, provider handles, raw logs, raw host paths, raw environment variables, or credentials part of public App API or MCP contracts.
- Do not create another long-running NanoCore instance inside the worker runtime.
- Do not move Goal Mode planning, Action Center decisions, review gates, or workspace apply decisions into OpenShell.
- Do not implement unattended recursive self-modification.
- Do not preserve historical remote runtime selector names as supported current behavior.

## Background

OpenKit now has two related real worker placement shapes:

- local container: NanoCore delegates turns to an OpenShell-backed container path reachable from the same machine or local gateway context.
- remote container: NanoCore delegates turns to a container backend reached through a remote gateway.

The important distinction is not where the container runs.

The important distinction is who owns product state.

NanoCore must own product state and review semantics.

The remote backend owns isolation, process lifecycle, file transport, network policy, and backend evidence.

The workspace materialization design already defines how worker-visible inputs, worker-produced changes, staged review, and approved apply should work.

Remote container mode should implement that design over a remote OpenShell gateway first.

## Decision

OpenKit will use remote container placement as a Worker Governance backend target.

The first implementation will use a remote OpenShell gateway.

The Worker Governance layer should treat local and remote OpenShell targets as two placements of the same backend family:

```text
MCP / Web UI
  -> NanoCore server mode
    -> WorkerGovernanceTurnExecutor
      -> Remote OpenShell WorkerGovernanceBackend target
        -> remote OpenShell gateway
          -> remote sandbox/container
            -> openkit worker shim
              -> Codex CLI or selected worker agent runtime
```

NanoCore remains the owner of:

- thread and turn state
- Goal Mode state
- Agent Environment Package snapshots
- worker checkpoint state
- workspace materialization records
- workspace change sets
- staged workspace review records
- Action Center rows
- artifacts and evidence references
- human review decisions
- approved apply results

The remote OpenShell gateway owns:

- sandbox lifecycle
- backend policy enforcement
- upload and download transport
- gateway health and readiness
- direct worker-control endpoint routing
- backend-native logs and audit files
- backend-specific teardown

Public OpenKit surfaces should expose redacted OpenKit records, not backend internals.

## Accepted Design

### Runtime Mode Model

The public worker runtime model is runtime plus placement plus backend:

Suggested environment shape:

```bash
OPENKIT_CORE_MODE=server
OPENKIT_WORKER_RUNTIME=container
OPENKIT_CONTAINER_PLACEMENT=remote
OPENKIT_CONTAINER_BACKEND=openshell
OPENKIT_OPENSHELL_GATEWAY=...
OPENKIT_OPENSHELL_GATEWAY_URL=...
OPENKIT_OPENSHELL_WORKER_IMAGE=...
OPENKIT_OPENSHELL_WORKER_CONTROL_BASE_URL=https://<nanocore-public-or-tunnel>/api/worker-control
OPENKIT_OPENSHELL_EXTRA_NETWORK_ENDPOINTS='[...]'
```

The distinction is:

- Core mode selects NanoCore placement and auth posture
- Worker runtime selects governed container execution
- Container placement selects local or remote worker placement
- Container backend selects the remote runtime implementation
- gateway URL selects the remote OpenShell control plane
- worker-control base URL selects the exact NanoCore route that the remote worker can reach
- worker image selects the container runtime payload
- extra endpoints declare explicit network policy additions

### Backend Target Abstraction

The existing OpenShell backend should evolve from a local-only adapter into an adapter with explicit target placement.

Conceptually:

```ts
type OpenShellGatewayTarget =
  | { placement: 'local'; gatewayName: string }
  | { placement: 'remote'; gatewayName: string; gatewayUrl: string; workerControlBaseUrl: string };
```

The target is configuration and transport.

It must not change OpenKit product semantics.

The backend capabilities should identify placement-sensitive capabilities such as:

- `container`
- `filesystem-policy`
- `network-policy`
- `transcript-sink`
- `worker-control`
- `file-upload-download`
- `git-materialization`
- `change-set-collection`
- `remote-gateway`
- `backend-service-readiness`
- `provider-attachments`
- `credential-placeholder`
- `audit-export`

If remote placement lacks a required capability, NanoCore should fail before launch with a redacted diagnostic.

### Control Channel

Remote workers receive the exact worker-reachable NanoCore endpoint:

```text
https://<nanocore-public-or-tunnel>/api/worker-control
```

The configured URL must be explicitly intended for worker reachability, contain no credentials, and bind requests with the package-scoped control token. OpenShell network policy allows only the approved shim binaries to reach it. No sandbox-local alias, sidecar, gateway relay, or service-forwarding path is part of worker control.

The control channel carries small worker events:

- turn started
- item created
- item completed
- artifact notice
- change-set ready notice
- heartbeat where supported
- final status

Large data should use backend-native file transport, not the control channel.

### Data Transport

Remote container mode should use backend-native OpenShell upload and download operations for:

- Agent Environment Package snapshots
- worker shim configuration
- generated task files
- workspace materialization manifests
- `workspace-changes.json`
- patches or bundles
- changed-file manifests
- transcript files
- artifact files
- backend audit summaries

NanoCore normalizes downloaded payloads into OpenKit records.

Public App API and MCP responses should expose OpenKit record ids, artifact ids, change-set ids, redacted summaries, and next suggested actions.

### Workspace Materialization

Remote container mode must implement the workspace lifecycle defined in `docs/specs/20260703-workspace_synchronization.md`.

For Git repositories, the first path is:

```text
NanoCore records repository resource and base commit
  -> remote backend creates clean checkout in sandbox
  -> worker runs one bounded task
  -> backend collects workspace-changes.json, patch, changed-file list, evidence, transcript
  -> NanoCore records WorkspaceChangeSet
  -> NanoCore stages changes for review
  -> Action Center presents staged review row
  -> human approves, rejects, refines, or retries
  -> NanoCore applies approved changes on trusted host or staging worktree
```

Remote workers may use GitHub credentials for read access or explicit ephemeral branch/fork flows only when configured and audited.

Direct protected-branch push from the remote sandbox is out of scope for the first implementation.

For non-Git workspaces, remote container mode should use content-addressed manifests and staged changed-file download, matching the non-Git strategy in the workspace materialization spec.

### Agent Environment Package

Remote container mode should extend AEP metadata without making OpenShell-specific data public product state.

The package should include:

- backend target kind and placement
- worker-visible workspace root
- workspace input strategy
- change-set output path
- generated files and task files
- transcript paths
- direct control endpoint metadata
- declared provider attachments
- declared filesystem and network policy intent
- redacted backend capability requirements

OpenShell-specific ids and policy internals may live in backend evidence, but they should not be required by the App API, end-user CLI, Web UI, or Action Center.

### Remote Runtime Gateway Generalization

The first implementation can be OpenShell-specific.

The design should still leave room for a backend-neutral remote runtime gateway boundary:

```ts
interface RemoteWorkerRuntimeGateway {
  describeCapabilities(): Promise<BackendCapabilities>;
  createSession(plan: RuntimeSessionPlan): Promise<RuntimeSessionRef>;
  upload(ref: RuntimeSessionRef, files: UploadPlan): Promise<TransportRefs>;
  launch(ref: RuntimeSessionRef, command: LaunchPlan): Promise<LaunchEvidence>;
  collect(ref: RuntimeSessionRef, selectors: CollectionPlan): Promise<CollectedOutputs>;
  delete(ref: RuntimeSessionRef): Promise<TeardownEvidence>;
}
```

This future boundary is transport-only.

It must not own Goal Mode, Action Center, review decisions, workspace apply, or product state.

### Security And Review Gates

Remote container mode increases the blast radius of credential, network, and file transport mistakes.

The first implementation should enforce these rules:

- fail closed when remote gateway readiness cannot be proven
- require explicit endpoint allowlists for GitHub, NanoCore worker-control, NanoCore inference gateway, and any research targets
- keep provider credentials as runtime attachments or placeholders, never as product payload text
- redact gateway URLs when they include credentials
- store only product-safe backend summaries in App API and MCP responses
- collect changes into staged review instead of applying them directly
- require human approval before applying, committing, pushing, creating PRs, deploying, tagging, or running external side effects

### Observability

Each remote worker turn should produce evidence for:

- selected backend target and placement
- gateway readiness
- package id and snapshot id
- sandbox creation summary
- workspace materialization summary
- launch summary
- transcript collection summary
- change-set collection summary
- artifact collection summary
- teardown summary
- review row id when changes are staged

Evidence should be sufficient for a coordinator agent to explain what happened without reading remote backend internals.

## Alternatives Considered

### Direct SSH Worker Execution

Direct SSH execution is easy to prototype, but it weakens the backend abstraction and tends to leak host paths, process details, and command execution semantics into product logic.

It can remain a backup verifier path, not the product runtime target.

### Remote NanoCore Per Worker

Running another NanoCore inside each remote worker would duplicate product state and complicate recovery.

The worker runtime should remain a worker runtime, not another product orchestrator.

### Sandbox Direct Git Push

Letting remote containers push directly to GitHub is tempting for Git-backed workspaces, but it bypasses staged review and makes failed or partial worker turns difficult to reconcile.

The first implementation should collect patches or bundles into NanoCore and apply only after review.

### Product Clients Control Remote Containers Directly

This would turn a public product client into a backend admin API and break the product boundary.

The target operation catalog, bundled CLI, and unified end-user Skill remain projections over public NanoCore APIs and MUST NOT expose direct sandbox administration. The current `@openkit/mcp` facade is removal-only and is not the target interface.

## Consequences

- Remote container mode becomes a placement option, not a separate product architecture.
- Local and remote OpenShell paths can share most backend code.
- Workspace synchronization remains the hardest and most important acceptance gate.
- Review gates stay consistent across local and remote container modes.
- Future backends can implement transport capabilities without changing the public operation catalog or product-surface semantics.

## Future Evolution Path

Remote OpenShell gateway is the first proof backend for remote container mode.

It is not the final runtime abstraction.

The purpose of the first implementation is to prove the OpenKit-owned product semantics:

- NanoCore can run in server mode while worker execution happens outside the NanoCore host.
- A remote backend can materialize a workspace without owning product state.
- A remote worker can execute a bounded task and return transcript, artifacts, and workspace changes.
- NanoCore can normalize those outputs into WorkspaceChangeSet and StagedWorkspaceReview records.
- Action Center can present reviewable evidence and keep the human in the loop.
- Approved apply can happen through NanoCore-managed review gates instead of direct sandbox mutation.

Once that proof works, OpenShell-specific lessons should be extracted into a backend-neutral remote runtime model.

### Backend-Neutral Remote Runtime Gateway

The next durable abstraction should be a `RemoteWorkerRuntimeGateway` that captures the common lifecycle across remote runtime providers.

Its conceptual responsibilities are:

- describe backend capabilities
- create a runtime session
- upload packages, task files, and workspace inputs
- launch a worker command
- expose or bridge worker-local control and inference endpoints
- collect transcript, artifacts, change sets, patches, bundles, logs, and audit summaries
- delete or retain runtime state according to policy

This gateway remains transport-only.

It should never own Goal Mode state, Action Center state, human review decisions, workspace apply decisions, repository state, or MCP product semantics.

OpenShell then becomes one adapter under this gateway family.

Future adapters may include:

- remote Docker hosts
- remote VMs over SSH or an agent daemon
- Kubernetes jobs or pods
- managed sandbox providers
- user-owned worker servers
- team-owned worker fleets
- OpenKit-managed worker runtimes

Every adapter should present backend capabilities and redacted evidence through the same NanoCore-owned product records.

### Capability Tiers

Remote runtime support should evolve through capability tiers instead of one all-or-nothing backend flag.

Useful tiers include:

- `read-only-materialization`: worker can receive workspace inputs but cannot return file changes.
- `artifact-export`: worker can return transcript and artifact files.
- `git-change-set`: worker can return Git patches, bundles, changed-file lists, and base commit metadata.
- `filesystem-change-set`: worker can return content-addressed file manifests and changed files for non-Git workspaces.
- `staged-review`: NanoCore can stage returned changes and present Action Center review rows.
- `approved-apply`: NanoCore can apply approved staged changes to a trusted target workspace.
- `verifier-runtime`: backend can run independent verification steps with separate lineage and evidence.
- `audit-export`: backend can return backend-native audit summaries that NanoCore can preserve as restricted evidence.

NanoCore should select a backend only when the requested task and workspace strategy can be satisfied by the backend's declared tier.

If a backend is missing a required tier, NanoCore should fail before launch with a clear, redacted diagnostic.

### Worker Placement And Scheduling

The first remote implementation can target one configured OpenShell gateway.

After the single-gateway path works, OpenKit can add placement and scheduling without changing product semantics.

Future placement policy may consider:

- backend capability match
- gateway health
- queue depth
- available disk and memory
- expected task duration
- network locality
- data locality
- provider credential availability
- quota and cost limits
- need for independent verifier separation
- user or workspace placement policy

The scheduler must not become an orchestrator that owns product state.

It should choose where to run a worker, then report placement evidence back to NanoCore.

NanoCore should still own the records that explain what was run, why it was run there, what changed, and who approved the result.

### Security Hardening

The remote OpenShell proof path should lead to a hardened remote runtime security model.

Important future work includes:

- authenticated remote gateway registration
- short-lived worker-control tokens
- signed Agent Environment Package snapshots
- signed or hashed package uploads
- scoped provider attachments
- explicit per-task network egress policy
- gateway-level credential isolation
- immutable or append-only backend audit summaries
- conformance tests that reject raw secret, auth file, and host-path leakage
- per-workspace and per-tenant isolation policy
- policy-digest checks that tie materialization records to backend enforcement inputs

This hardening should be expressed as capability and evidence requirements rather than OpenShell-only assumptions.

### Deployment Models

Remote container mode should support multiple deployment shapes over time:

- developer-owned remote worker server for dogfooding
- user-owned remote worker server
- team-owned worker fleet
- enterprise private worker deployment
- hybrid local and remote placement
- OpenKit-managed worker runtime

MCP, Web UI, and desktop agent applications should not need to know which deployment shape is active.

They should read NanoCore status, Goal Mode state, Action Center rows, artifacts, and evidence through the same public surfaces.

### Loop Automation

Remote container mode is an enabling layer for stronger Loop Engineering, not the loop itself.

After remote worker execution and reviewable workspace synchronization are reliable, OpenKit can gradually support:

- scheduled discovery loops
- triage loops
- bounded implementation loops
- independent verifier loops
- self-correction loops
- PR preparation loops
- deployment readiness loops

These loops must remain bounded, auditable, review-gated, and human-approved for external side effects.

The coordinator may become more automated over time, but NanoCore should still preserve durable state and review evidence outside any single agent conversation.

### Evolution Order

The expected evolution is:

1. Remote OpenShell gateway dogfood works with NanoCore server mode.
2. Workspace materialization, change-set collection, staged review, and approved apply become the uniform path for container backends.
3. OpenShell-specific transport lessons are extracted into a backend-neutral `RemoteWorkerRuntimeGateway` design.
4. At least one non-OpenShell remote backend can satisfy the same remote runtime contract in deterministic tests.
5. Multiple gateway placement and independent verifier separation are supported.
6. User-managed and team-managed remote worker setup are documented and testable.
7. OpenKit-managed worker runtime becomes possible without changing MCP or Web UI product semantics.
8. Scheduled review-gated loops use remote workers as routine execution and verification capacity.

## Rollout / Migration Plan

1. Add configuration parsing for explicit remote OpenShell gateway targets.
2. Extend backend capability declarations with remote placement and file/change-set capabilities.
3. Extend AEP generation with remote container metadata and change-set output paths.
4. Implement remote gateway preflight and fail-closed diagnostics.
5. Upload package and task files to the remote sandbox.
6. Materialize Git repository workspaces in the remote sandbox.
7. Collect `workspace-changes.json`, patch, changed-file list, transcript, artifacts, and backend evidence.
8. Record WorkspaceChangeSet and StagedWorkspaceReview in NanoCore.
9. Project staged workspace reviews into Action Center and MCP-readable resources.
10. Verify with NanoCore in server mode and a worker in remote OpenShell container mode.

## Testing Strategy

- L1 tests for remote executor configuration parsing and redacted diagnostics.
- L1 tests for OpenShell target selection between local and remote placement.
- L1 tests for AEP remote container metadata and path redaction.
- L1 tests for workspace change-set manifest parsing and staged review records.
- L2 schema tests for App API and MCP read models exposing staged workspace review evidence.
- L3 NanoCore black-box tests with deterministic backend stubs for remote container materialization, collection, and review gating.
- Opt-in OpenShell integration tests for remote gateway readiness, sandbox creation, package upload, worker launch, file collection, and teardown.
- Opt-in dogfood verification by running a bounded real workspace task through NanoCore server mode with the worker runtime in remote OpenShell placement.

## Risks & Mitigations

- Risk: remote backend transport becomes product state. Mitigation: normalize backend results into NanoCore-owned records and expose only redacted summaries publicly.
- Risk: remote workers cannot reach NanoCore worker-control routes. Mitigation: make the exact direct base URL explicit and verify reachability, authentication, and OpenShell binary policy in preflight before launch.
- Risk: workspace sync bypasses review. Mitigation: require change-set collection and staged review before apply.
- Risk: credentials leak through package snapshots or logs. Mitigation: use provider attachments, placeholders, redaction, and tests that reject raw secret shapes.
- Risk: OpenShell-specific assumptions block future backends. Mitigation: keep OpenShell as the first adapter under a capability-based backend target model.
- Risk: remote verification is flaky. Mitigation: keep deterministic local and stubbed tests as gates, and make real remote OpenShell tests opt-in.

## Resolved Implementation Decisions

- Remote placement is selected through `OPENKIT_WORKER_RUNTIME=container`, `OPENKIT_CONTAINER_PLACEMENT=remote`, and `OPENKIT_CONTAINER_BACKEND=openshell`.
- Local and remote OpenShell placements are one backend family with explicit placement metadata, not separate product backends.
- `OPENKIT_CONTAINER_BACKEND=openshell` is required for the first remote container implementation and fails closed for unsupported backend families.
- `OPENKIT_OPENSHELL_GATEWAY_URL` is required for remote OpenShell placement, is retained as backend-private runtime configuration, and is represented in product records only through redacted endpoint summaries or runtime refs.
- The first implementation uses OpenShell's named gateway plus direct endpoint CLI contract: preflight reads `openshell gateway info -g <name> --gateway-endpoint <url>`, sandbox and file operations pass both `--gateway <name>` and `--gateway-endpoint <url>`, and `OPENKIT_OPENSHELL_GATEWAY_INSECURE=1` may add `--gateway-insecure` for explicitly configured development gateways.
- Remote OpenShell placement must not require local Docker readiness. Local OpenShell placement still runs local `openshell doctor check`, while remote OpenShell placement proves readiness through CLI availability, gateway connectivity, named gateway metadata, endpoint matching, and real remote sandbox operations where opt-in verification is available.
- Workspace bundle creation must produce Linux-portable archives. On macOS, NanoCore disables AppleDouble and extended attribute headers when creating uploaded workspace tar bundles so remote Linux sandbox extraction does not receive `LIBARCHIVE.xattr`, `SCHILY.xattr`, or `._*` metadata.
- Remote gateway authentication should be declared through NanoCore server-owned config that references credential material rather than embedding credential material. The first implementation may project those references through environment-backed secret refs or vault-backed refs, but product records may expose only redacted endpoint summaries, runtime refs, and policy/audit lineage.
- Large worker outputs collected before staged review are workspace-owned when they come from workspace work. They should live under the workspace runtime, review, and evidence areas defined by `docs/specs/20260703-storage_layout_record_ownership.md`, such as agent-session workspace-change outputs, staged workspace reviews, and restricted evidence bundles. Server-owned `server/evidence` is reserved for server or gateway lifecycle evidence that is not workspace-owned.
- The minimum Action Center decision set for staged workspace reviews is accept, request refinement, retry or redo, reject, and defer. Product labels may vary, but the underlying decisions must preserve review lineage and must not apply changes without an accepted review decision.

## Links

- `docs/specs/20260703-workspace_synchronization.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260713-openkit_agent_skill_interface.md`
- `docs/specs/20260531-worker_turn_reliability_envelope.md`
- `docs/specs/20260531-human_attention_intervention_model.md`
- `docs/core/architecture.md`
- `docs/core/agent-workflow.md`
- `docs/core/sandbox.md`
- `docs/core/agent-capability.md`
