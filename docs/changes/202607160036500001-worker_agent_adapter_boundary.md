# Worker Agent Adapter Boundary Change Plan

Type: change-plan
Status: planned
Date: 2026-07-16

## Intent

OpenKit will use Codex, OpenCode, and Pi as three concrete challenges against one clean Worker Agent integration boundary.

> The real outcome is not three adapters. The fourth Worker Agent must require only one profile, one adapter, and one image; NanoCore's product and governance core must not change.

This change removes Codex- and OpenCode-specific assumptions from NanoCore product and governance code, establishes a small worker-side adapter contract, implements the three runtime adapters, and gives each runtime an independently reviewable integration specification.

## Inherited Audit Responsibility (2026-07-17)

This plan is work package WP-2 of the [OpenKit Execution Program](./202607172152230001-openkit_execution_program.md) and absorbs audit group G03 from the [alignment audit](./202607111941330001-core_spec_implementation_alignment_audit.md). The G03 document set (C04 Runtime Model, C05 Agent Session, C13 Agent Supply, C16 Sandbox, S20-S38, S64-S66, and their supporting projections) and the G03 exit criteria in the audit ledger are inherited inputs. The program's convergence rules bind all work here.

Before implementation starts, record the G03 audit preamble in this plan per Execution Program rule 11: the authority map for the concepts this plan touches, findings classified with the audit's finding codes (in-scope findings fold into this plan's frozen scope; everything else is ticketed to the program Backlog), and confirmation of the inherited exit criteria. The preamble is review-only, bounded to at most one review day, and authorizes no implementation. The S21, S25, and S29 consolidation reviews assigned by the audit's Remaining Execution dispositions happen here; supersede a candidate only when a named current owner absorbs every continuing contract.

## Primary Acceptance Criterion

A hypothetical fourth runtime passes architectural review only when its production implementation diff is limited to exactly:

- one declarative Worker Agent profile
- one worker-side runtime adapter
- one governed worker image

The diff must not add a runtime branch, runtime enum member, provider special case, command builder, output parser, image selector, or native event type to NanoCore product, scheduling, policy, governance, workspace review, evidence import, or public API implementation.

Adapter-local tests, image smoke evidence, and one runtime-specific specification verify those three production artifacts; they do not constitute additional runtime architecture surfaces.

## Related Authority

- `docs/core/architecture.md`
- `docs/core/work-model.md`
- `docs/product-vision.md`
- `docs/core/runtime-model.md`
- `docs/core/communication.md`
- `docs/core/agent-session.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260629-worker_runtime_communication_model.md`
- `docs/specs/20260703-worker_control_protocol.md`
- `docs/specs/20260703-workspace_synchronization.md`
- `docs/specs/20260711-worker_runtime_subagent_provenance.md`
- `docs/specs/20260716-codex_worker_adapter.md`
- `docs/specs/20260716-opencode_worker_adapter.md`
- `docs/specs/20260716-pi_worker_adapter.md`

## System Architecture Decision

```text
NanoCore product and governance core
  -> resolves one declarative Worker Agent profile into an AEP
  -> launches one image through a WorkerGovernanceBackend
  -> communicates only through openkit-worker-control-v1
  -> verifies and imports only canonical OpenKit records

Governed worker image
  -> openkit-worker-shim shared harness
     -> selects the AEP-declared adapter id
     -> supervises process, control, transcript, and workspace change capture
     -> invokes one small runtime adapter
        -> Codex
        -> OpenCode
        -> Pi
```

NanoCore treats the runtime adapter id as an opaque, non-empty identifier. NanoCore does not maintain a closed runtime enum and does not infer a runtime from an agent id or display name.

The Agent Environment Package is the only profile-to-worker handoff. It declares the adapter id, image, runtime binary supply, provider and credential attachments, network policy, workspace, task input, and control contract without embedding runtime-native command syntax.

The WorkerGovernanceBackend materializes, launches, collects, and recycles a worker. It executes `runtime.command.argv` from the AEP and does not know Codex, OpenCode, Pi, their configuration files, or their provider endpoints.

The shared worker harness owns exactly:

- AEP loading and validation needed inside the container
- approved Skill and MCP supply materialization
- child process lifecycle and process-group termination
- direct worker-control readiness, heartbeat, polling, and command acknowledgement
- canonical transcript writing, sequencing, lineage, redaction, and terminal outcome emission
- workspace input snapshots and workspace change publication
- bounded native output capture made available to one adapter

Each runtime adapter owns exactly:

- translating the AEP task and runtime settings into one native launch command
- translating native event or output records into the adapter result consumed by the shared transcript writer
- mapping interrupt, steer, follow-up, or approval operations only when both the OpenKit control contract and the native runtime support them
- capturing runtime-native session or provenance evidence when the runtime-specific specification requires it
- declaring adapter-local capabilities and unsupported operations truthfully

An adapter must not own Workspace, Thread, Turn, Item, Goal Mode, Action Center, policy, authorization, scheduling, backend lifecycle, workspace review or apply, canonical id allocation, durable product state, provider selection, vault grants, or public API behavior.

## Adapter Contract Decision

The adapter contract remains a worker-side internal interface with four conceptual operations:

```text
prepare(AEP adapter inputs) -> native launch plan
collect(native exit and bounded output) -> normalized adapter result
interrupt(active native run) -> adapter-local graceful abort or shared process termination
captureProvenance(native stream) -> optional adapter-owned evidence
```

`prepare` receives only already resolved AEP data and returns argv, safe environment additions, output capture requirements, and adapter-local capability declarations.

`collect` returns final assistant content, optional native session metadata, and product-safe failure classification. The shared harness, not the adapter, writes canonical transcript records and terminal outcomes.

`interrupt` defaults to shared process-group termination. A native graceful-abort hook is permitted only when it implements an already accepted OpenKit control operation and passes the shared conformance suite.

`captureProvenance` is optional. Its output is evidence for NanoCore verification; it never changes canonical product state directly.

The contract must not expose NanoCore stores, routes, scheduler objects, backend handles, public Item types, or runtime-specific event unions.

## Declarative Worker Agent Profile

One profile is a repository-owned authored agent configuration that contains only data needed to resolve an AEP. The minimum profile fields are:

- stable agent id and display name
- opaque runtime kind and adapter id
- governed worker image reference
- runtime binary id and worker-local executable paths used by policy
- provider, model, credential, and trusted-inference requirements
- capabilities that the concrete adapter and image actually implement
- Skills and MCP compatibility declarations
- workspace and backend requirements

Adding a profile is configuration work. Profile loading, validation, AEP projection, routing candidates, and image selection must remain generic.

## Target Artifact Layout

```text
apps/nanocore/data-templates/config/agents/
  codex.agent.jsonc
  opencode.agent.jsonc
  pi.agent.jsonc

packages/worker-shim/src/
  harness/
  adapters/codex.ts
  adapters/opencode.ts
  adapters/pi.ts

containers/
  worker-codex/
  worker-opencode/
  worker-pi/
```

The exact shared-harness file split may remain smaller when that improves cohesion. The ownership test is more important than directory count: shared lifecycle code must not contain native runtime branches, and adapter files must not contain product or governance logic.

A fourth runtime adds one peer profile, one peer adapter, and one peer image directory. Existing NanoCore, shared harness, and canonical protocol files remain unchanged.

## End-To-End Communication Sequence

```text
1. NanoCore resolves the selected declarative profile into one immutable AEP.
2. WorkerGovernanceBackend launches the profile-selected image with the generic shim command.
3. The shared harness validates direct worker control and selects the AEP adapter id.
4. The adapter prepares and starts one native bounded run.
5. The shared harness owns heartbeat, interrupt delivery, process supervision, and workspace capture.
6. The adapter converts native terminal output into one normalized result.
7. The shared harness writes canonical transcript and terminal records.
8. NanoCore verifies lineage, sequence, schema, policy, and workspace boundaries before importing product state.
9. WorkerGovernanceBackend collects evidence and recycles the governed worker.
```

No native runtime protocol crosses step 6. No canonical product mutation occurs before step 8.

## Interaction Decision For The Three Runtimes

| Runtime | Native execution surface | Native output surface | OpenKit control mapping | Session and provenance |
| --- | --- | --- | --- | --- |
| Codex | `codex exec` in one governed worker process | JSONL stdout plus `--output-last-message` | Process-group termination for interrupt; no fabricated interactive approval support | Optional Codex rollout capture under the accepted runtime-provenance contract |
| OpenCode | `opencode run --format json` in one governed worker process | JSON event stream with final assistant text extracted by the adapter | Process-group termination for interrupt; session continuation only after a concrete bounded-turn requirement | Adapter records native session identifiers when present; no NanoCore-native event leakage |
| Pi | `pi --mode json` for the bounded one-turn path; RPC is reserved for a future accepted interactive requirement | JSON event stream with final assistant content extracted by the adapter | Process-group termination for the current bounded path; RPC `abort`, `steer`, and `follow_up` are not advertised until OpenKit exposes and tests those controls | Adapter records native session metadata when present; raw runtime events remain worker-side evidence |

The current product execution envelope is one bounded worker turn. The implementation therefore uses the smallest native non-interactive surface that produces deterministic machine-readable output. Native server or RPC modes are documented but are not introduced merely because a runtime provides them.

## Decisions

- Use one `@openkit/worker-shim` package with one shared harness and three concrete adapter modules.
- Use one generic `openkit-worker-shim` entrypoint. The AEP selects the adapter; NanoCore does not select a runtime-specific binary.
- Keep the adapter registry worker-side. Registering a fourth adapter is part of adding that adapter, not a NanoCore change.
- Keep runtime identifiers open strings in NanoCore and public delegation records.
- Select the worker image from the declarative agent profile, not from a global Codex image environment variable.
- Keep one governed image artifact per runtime because native binary installation, trust surface, smoke checks, and release provenance differ.
- Keep canonical worker protocol schemas runtime-neutral. Runtime-native events never enter `packages/worker-protocol` or NanoCore.
- Preserve Codex provenance as an optional Codex adapter feature rather than making it a shared harness responsibility.
- Do not add a plugin framework, dynamic package loading, adapter SDK package, inheritance hierarchy, compatibility alias, or generic bidirectional session engine in this change.

## Scope

### In Scope

- common Worker Agent adapter architecture and acceptance contract
- individual Codex, OpenCode, and Pi adapter specifications
- worker-shim adapter contract and conformance tests
- concrete command and final-output adapters for all three runtimes
- one generic worker-shim entrypoint and generic AEP projection
- opaque runtime identifiers through routing and delegation schemas
- declarative image selection and three worker image definitions
- removal of runtime-native branches from NanoCore AEP and WorkerGovernanceBackend code touched by this path
- focused unit, contract, image-manifest, Dockerfile, and smoke tests

### Out Of Scope

- multi-turn interactive worker sessions
- live token streaming into product Items
- native approval or question UI projection
- implementation of the future worker capability plane
- arbitrary adapter package discovery or third-party dynamic loading
- provider onboarding or credential migration beyond removing runtime-specific ownership from generic code
- broad redesign of the agent catalog or Web UI

## Execution Plan

### Phase 1: Specification And Failing Contracts

- update the common communication model with the adapter boundary and fourth-runtime acceptance test
- add the three runtime-specific adapter specifications
- add failing worker-shim conformance tests for command construction, final assistant extraction, interrupt semantics, invalid native records, and capability truthfulness
- add failing NanoCore tests proving runtime ids are opaque, AEP launch is generic, image selection is profile-driven, and governance code contains no supported-runtime switch
- add failing image-manifest and Dockerfile contract tests for three runtime images

### Phase 2: Shared Harness And Adapters

- extract the minimum adapter contract from the current Codex-specific shim path
- retain process supervision, control, transcript, workspace, redaction, and supply logic in the shared harness
- implement Codex, OpenCode, and Pi command and final-output adapters
- move Codex provenance capture behind the Codex adapter hook
- expose one generic shim binary and remove Codex naming from shared entities and diagnostics

### Phase 3: NanoCore Boundary Cleanup

- make runtime and adapter identifiers opaque strings in runtime, delegation, and Task Mode records
- project the generic shim command and AEP-declared adapter id
- resolve worker image and executable policy from the declarative profile
- remove Codex command construction, Codex provider defaults, runtime-name inference, and runtime-specific image selection from the generic AEP and governance path
- execute AEP commands in backend dry runs instead of a hard-coded shim command

### Phase 4: Images And Profiles

- add or clean the Codex, OpenCode, and Pi authored profiles
- build one least-privilege runtime image per adapter
- install only the generic harness and the selected native runtime in each image
- add adapter-specific smoke checks that verify the harness, native binary, native machine-readable mode, non-root user, and expected entrypoint

### Phase 5: Verification And Closure

- run package and NanoCore unit, typecheck, lint, and build checks
- run image-manifest and Dockerfile contract tests
- build and smoke all three images when the local Docker backend is available
- perform a fourth-runtime diff simulation using a fixture adapter and profile; fail the change if NanoCore source edits are required
- review for adapter leakage, duplicate ownership, speculative abstractions, and stale Codex/OpenCode host paths
- update this record with implementation evidence and exact deferred runtime proof, if any

## Verification Matrix

| Boundary | Required proof |
| --- | --- |
| Canonical protocol | The same worker protocol schemas validate records from all three adapter fixtures. |
| Shared harness | One conformance suite runs against Codex, OpenCode, and Pi without runtime-specific branches in the suite driver. |
| NanoCore | Static and behavioral tests prove opaque adapter ids, generic AEP launch, profile image selection, and runtime-neutral backend execution. |
| Adapter scope | Runtime-native command and output knowledge appears only in the relevant adapter module, specification, profile, image, and tests. |
| Images | Three manifest entries and three smoke paths install exactly one native runtime each and invoke the generic shim. |
| Fourth runtime | A fixture profile, fixture adapter, and fixture image metadata can be added without modifying NanoCore product or governance source. |

## Minimum Viable First Proof

The first proof point is one shared conformance test that accepts all three adapters and one NanoCore test that resolves an unknown fixture adapter id without a code change or runtime switch.

The proposal is falsified if implementing Pi requires a Pi branch in NanoCore, if OpenCode requires a second control protocol, if image choice remains a global runtime-specific environment variable, or if the shared harness must understand a native event type.

## Cut List And Stop Rule

Cut server/RPC sessions, interactive steering, native approval projection, hot adapter loading, cross-runtime config unification, and live token deltas before weakening the boundary.

Stop and redesign if any adapter needs to mutate NanoCore product state directly, if a runtime-native schema appears in NanoCore or the canonical worker protocol, or if the fourth-runtime simulation requires a NanoCore product or governance edit.

## Progress

- 2026-07-16: Change plan opened after auditing the current Codex-specific shim, AEP, backend, image selection, and closed runtime enums.
- 2026-07-16: Codex, OpenCode, and Pi selected as the three concrete boundary challenges; the fourth-runtime zero-core-change rule is the primary acceptance criterion.
- 2026-07-16: Common architecture and three runtime-specific adapter specifications completed. Implementation intentionally remains unstarted under the docs-only scope decision.
- 2026-07-16: Documentation passed spec lifecycle validation, repository formatting and lint checks, and the models catalog validation. No implementation file changes remain.

## Implementation Summary

Not started. This record is an approved implementation plan, not implementation evidence.

## Final Verification

Documentation-only verification passed with `CI=true pnpm run check:repo`, targeted `git diff --check`, internal related-document existence checks, pinned upstream source review for OpenCode and Pi, and a clean diff across `packages/`, `apps/`, `containers/`, `scripts/`, and `.github/` for this change.
