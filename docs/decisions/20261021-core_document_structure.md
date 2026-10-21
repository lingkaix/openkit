---
status: Accepted
date: "2026-10-21"
decider: Engineer
---
# Core Document Structure Consolidation

## Decision

Consolidate `docs/core/` into a 20-document set organized around deep modules with clear conceptual ownership, retiring `audit.md` and `metering.md` into `docs/core/evidence.md`, merging and retiring `agent-workflow.md` into `docs/core/work-model.md`, retiring `deployment-modes.md` and `app-api.md` from `docs/core/` while keeping `docs/deployment.md` and `docs/app-api.md` as calibrated platform references, renaming `agent-capability.md` to `docs/core/mediation.md` and `permissions.md` to `docs/core/policy.md`, structuring `docs/core/storage.md` into two explicit layers, and sharpening the cross-document boundaries across runtime, supply, knowledge, communication, and protocol.

The final 20-document `docs/core/` set (plus `README.md` and `AGENTS.md` as the directory guides) is:

1. `foundation.md`
2. `core-concepts.md`
3. `work-model.md`
4. `architecture.md`
5. `fault-tolerance.md`
6. `runtime-model.md`
7. `agent-supply.md`
8. `agent-session.md`
9. `protocol.md`
10. `communication.md`
11. `storage.md`
12. `identity.md`
13. `vault.md`
14. `mediation.md`
15. `policy.md`
16. `sandbox.md`
17. `knowledge.md`
18. `evidence.md`
19. `contract-evolution.md`
20. `generative-apps.md`

The structural changes C1 through C9 and their receivers are:

- **C1 (`evidence.md` narrowed; retire `audit.md` and `metering.md`)**: Create `docs/core/evidence.md` to own what is recorded and with which authority across four record classes—`Audit` (accountability and `AuditEvent`, relocated from `audit.md`), `Usage and metering` (`UsageRecord`, capability usage units, attribution, `System-wide measurement`, `Non-gateway measurement`, `Aggregation`, and `Cost projection`, relocated from `metering.md` and `docs/core/mediation.md`), `Capture Coverage` (the capture switch, admission-time fixing, decided default-on target, and current default-off implementation state with explicit gaps, grounded in `docs/core/protocol.md` and `docs/decisions/20261019-work_data_retention_completeness.md`), and `Telemetry` (diagnostic, non-authoritative, and lossy operational signals, gathered from `docs/core/fault-tolerance.md`, `docs/core/architecture.md`, `docs/core/core-concepts.md`, `docs/core/runtime-model.md`, and `docs/decisions/20261019-telemetry_as_internal_logs.md`). Persistence, retention windows, deletion, and storage classes remain in `docs/core/storage.md` Layer 1. `Workflow Evidence`, `EvidenceBundle`, and `decision-evidence` keep their existing owners.
- **C2 (rename `agent-capability.md` to `mediation.md` and `permissions.md` to `policy.md`)**: Rename the capability document to `docs/core/mediation.md` as the one interception base covering operation definition and invocation, `<operation>@<stage>` mediation points, the Capability Mediation Boundary, `CapabilityCall`, gateway routing, internal-role Tool admission, and rate-limit hooks, absorbing Enforcement Points from `permissions.md` and the Capability Mediation Boundary owner from `communication.md`. Rename `permissions.md` to `docs/core/policy.md` so it owns the Policy authority model (principals, statements, decisions, approval, administration, and disclosure).
- **C3 (`work-model.md` absorbs `agent-workflow.md`; retire `agent-workflow.md`)**: Merge `agent-workflow.md` into `docs/core/work-model.md` as one Work module covering Intent, Objective, Plan, Goal, workflow mechanisms, modes and recipes, internal role collaboration, planning and Plan approval, gates and human attention, checkpoints and stop conditions, deliverables, workflow evidence, and the concept-level definitions of `Judgement` and `Candidate Set`.
- **C4 (`fault-tolerance.md` owns durable execution)**: Absorb `runtime-model.md`'s Durable Execution section into `docs/core/fault-tolerance.md` as the single owner of durable execution and the effect-uncertainty rule, while `docs/core/runtime-model.md` keeps scheduling, placement, and substrate lifecycle.
- **C5 (Protocol deepening)**: Move the ID prefix registry and derivations, Item Delta Kinds inventory, Canonical Enums and Status Values tables, and internal-role Tool alias detail out of Core into owning specifications so `docs/core/protocol.md` retains semantics and grammar principles rather than field/enum inventories.
- **C6 (Leakage and staleness deduplication)**: Consolidate repeated cross-document rule sentences to a single owner with cross-references and refresh stale wording across `docs/core/`.
- **C7 (`README.md` inventory, term index, and reading order)**: Keep `docs/core/README.md` synchronized with the 20-document aspect set, merged term families, and reading order.
- **C8 (`generative-apps.md` keeps its name)**: Retain `docs/core/generative-apps.md` to define `Light App`, `Generative Kernel`, and `Generative UI`, with an explicit non-goal stating that OpenKit is not a low-code or no-code builder.
- **C9 (`storage.md` in two explicit layers)**: Organize `docs/core/storage.md` into Layer 1 (`System State And Work Data`: scope stores and control authority, immutable content, source of truth per data class, item log, retention and deletion classes including retained agent work data and Worker working volumes, format markers, and portability) and Layer 2 (`User Data And The Storage Service`: locations and byte operations, local-now and later non-current backends, `contentRef` digest and locator references, leases under Policy grants with host-side mounts and never sandbox FUSE, Knowledge package byte layout, and the external Git and object-storage boundary).

## Reason

OpenKit's Core documentation must follow the deep-module principle: each Core document should own one coherent conceptual boundary with a small interface and deep internal semantics, rather than splitting a single boundary across thin files or keeping implementation inventories inside `docs/core/`.

1. **`evidence.md` (C1)**: `audit.md` and `metering.md` were thin documents that split closely related post-hoc observation and accounting records across three files (`audit.md`, `metering.md`, and the `UsageRecord` tail of `mediation.md`), while Capture Coverage and Telemetry rules were scattered across `protocol.md`, `fault-tolerance.md`, `architecture.md`, `core-concepts.md`, and `runtime-model.md`. Grouping Audit, Usage/metering, Capture Coverage, and Telemetry into `docs/core/evidence.md` establishes a single owner for what is recorded and with which authority, while keeping physical persistence, retention classes, and deletion in `docs/core/storage.md` Layer 1.
2. **Renaming `agent-capability.md` to `mediation.md` and `permissions.md` to `policy.md` (C2)**: A Core document is renamed only when its old filename misstates its scope and invites readers to look in the wrong owner. `agent-capability.md` had grown to own the unified `<operation>@<stage>` mediation model and internal-role Tool admission in addition to worker capabilities, making `mediation.md` the accurate name. `permissions.md` owned Policy statements, NGAC-aligned Policy Kernel semantics, disclosure audiences, approval gates, and delegated goal domains, which is broader than a binary permission check and is accurately named `policy.md`.
3. **Merging `agent-workflow.md` into `work-model.md` (C3)**: `work-model.md` and `agent-workflow.md` split one Work mechanism by audience, defining Chat Mode, Task Mode, Goal Mode, Plan Mode, Action Center, and Context Compaction twice across the two files while leaving `Judgement` and `Candidate Set` without a Core definition. Merging `agent-workflow.md` into `docs/core/work-model.md` eliminates the audience split and duplicate mode definitions while giving the Work module a single coherent home.
4. **Durable execution in `fault-tolerance.md` and protocol deepening (C4, C5, C6)**: Consolidating durable execution and repeated effect-uncertainty rules in `docs/core/fault-tolerance.md` and moving concrete identifier/enum/delta inventories from `docs/core/protocol.md` to specifications keeps Core documents focused on semantics rather than inventories.
5. **Two layers in `storage.md` and preserving `generative-apps.md` (C8, C9)**: OpenKit persistence has two distinct conceptual layers within one persistence module—system control state and work data (Layer 1) and user file/content bytes served through the Storage Service (Layer 2). Making both layers explicit inside `docs/core/storage.md` integrates the accepted layered file storage and Knowledge package decisions without splitting persistence ownership across two Core files, while `docs/core/generative-apps.md` keeps its filename and frames `Generative Kernel` and `Generative UI` together.

## Rejected Alternatives

- **Merge `core-concepts.md`, `agent-session.md`, `vault.md`, or `sandbox.md` into neighboring files**: Rejected because each of these documents already owns a distinct, high-leverage boundary (`core-concepts.md` for shared object identity and single-flight cardinalities; `agent-session.md` for hidden runtime continuity, exact reconnect, and replacement; `vault.md` for secret references and zero-prompt-exposure injection; `sandbox.md` for containment and isolation areas). Merging them would create overloaded documents with mixed abstraction levels.
- **Keep `work-model.md` and `agent-workflow.md` as separate files**: Rejected because splitting the Work mechanism into a user-view document and a Core-mechanism document caused duplicate definitions of modes, gates, and compaction across the two files.
- **Move retention classes, deletion rules, and physical storage of evidence records into `evidence.md`**: Rejected because retention classes (`ephemeral-diagnostic`, `turn-evidence`, `workspace-audit`, `restricted-raw`, `legal-hold`), deletion closure, and control-store/blob placement are persistence invariants that apply across work history, Knowledge, and evidence alike and belong in `docs/core/storage.md` Layer 1.
- **Split `storage.md` into two separate Core files for control databases and file storage**: Rejected because control-store publication and content-addressed file storage share one acknowledgement, backup, and retention boundary; two explicit layers inside `docs/core/storage.md` express the distinction without fracturing persistence authority.
- **Rename `generative-apps.md` to `light-apps.md` or `generative-kernel.md`**: Rejected by engineer ruling; `generative-apps.md` remains the filename while framing `Light App`, `Generative Kernel`, and `Generative UI` together and stating explicitly that it is not a low-code or no-code builder.
- **Keep `audit.md` and `metering.md` as separate files**: Rejected because both are post-hoc record projections whose separation from each other and from Capture Coverage and Telemetry hid the unified authority boundary between authoritative governance/usage records, coverage intent, and non-authoritative diagnostics.

## Revisit When

- A future accepted architecture change introduces a genuinely new top-level Core aspect that cannot fit within the 20 aspect documents without violating single-owner boundaries.
- The Storage Service or Evidence record classes undergo a fundamental authority split accepted by a new engineer decision.

## Affected Owners

- `docs/core/README.md`
- `docs/core/foundation.md`
- `docs/core/core-concepts.md`
- `docs/core/work-model.md`
- `docs/core/architecture.md`
- `docs/core/fault-tolerance.md`
- `docs/core/runtime-model.md`
- `docs/core/agent-supply.md`
- `docs/core/agent-session.md`
- `docs/core/protocol.md`
- `docs/core/communication.md`
- `docs/core/storage.md`
- `docs/core/identity.md`
- `docs/core/vault.md`
- `docs/core/mediation.md`
- `docs/core/policy.md`
- `docs/core/sandbox.md`
- `docs/core/knowledge.md`
- `docs/core/evidence.md`
- `docs/core/contract-evolution.md`
- `docs/core/generative-apps.md`
- `docs/deployment.md`
- `docs/app-api.md`
