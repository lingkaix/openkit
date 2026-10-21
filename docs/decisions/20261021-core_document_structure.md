---
status: Accepted
date: "2026-10-21"
decider: Engineer
---
# Core Document Structure Consolidation

## Decision

Consolidate `docs/core/` into a 20-document set organized around deep modules with clear conceptual ownership, retiring `audit.md` and `metering.md` into `docs/core/evidence.md`, retiring `deployment-modes.md` and `app-api.md` from `docs/core/` while keeping `docs/deployment.md` and `docs/app-api.md` as calibrated platform references, renaming `agent-capability.md` to `docs/core/mediation.md` and `permissions.md` to `docs/core/policy.md`, structuring `docs/core/storage.md` into two explicit layers, and sharpening the cross-document boundaries across runtime, supply, knowledge, communication, and protocol.

The final 20-document `docs/core/` set (plus `contract-evolution.md` as cross-aspect evolution rules and `README.md` as the directory guide) is:

1. `foundation.md`
2. `core-concepts.md`
3. `work-model.md`
4. `architecture.md`
5. `fault-tolerance.md`
6. `runtime-model.md`
7. `agent-supply.md`
8. `agent-session.md`
9. `agent-workflow.md`
10. `protocol.md`
11. `communication.md`
12. `storage.md`
13. `identity.md`
14. `vault.md`
15. `mediation.md`
16. `policy.md`
17. `sandbox.md`
18. `knowledge.md`
19. `evidence.md`
20. `contract-evolution.md`
21. `generative-apps.md`

The structural changes C1 through C9 and their receivers are:

- **C1 (`evidence.md` narrowed; retire `audit.md` and `metering.md`)**: Create `docs/core/evidence.md` to own what is recorded and with which authority across four record classes—`Audit` (accountability and `AuditEvent`, relocated from `audit.md`), `Usage and metering` (`UsageRecord`, capability usage units, attribution, `System-wide measurement`, `Non-gateway measurement`, `Aggregation`, and `Cost projection`, relocated from `metering.md` and `docs/core/mediation.md`), `Capture Coverage` (the capture switch, admission-time fixing, decided default-on target, and current default-off implementation state with explicit gaps, grounded in `docs/core/protocol.md` and `docs/decisions/20261019-work_data_retention_completeness.md`), and `Telemetry` (diagnostic, non-authoritative, and lossy operational signals, gathered from `docs/core/fault-tolerance.md`, `docs/core/architecture.md`, `docs/core/core-concepts.md`, `docs/core/runtime-model.md`, and `docs/decisions/20261019-telemetry_as_internal_logs.md`). Persistence, retention windows, deletion, and storage classes remain in `docs/core/storage.md` Layer 1. `Workflow Evidence`, `EvidenceBundle`, and `decision-evidence` keep their existing owners.
- **C2 (retire `deployment-modes.md` from `docs/core/`)**: Relocate the deployment-semantic invariant to `docs/core/architecture.md`, runtime placement and the four-projection decomposition to `docs/core/runtime-model.md`, transport-mode selection to `docs/core/communication.md`, and degraded single-host isolation rules to `docs/core/sandbox.md`. Retain `docs/deployment.md` as a calibrated platform reference.
- **C3 (retire `app-api.md` from `docs/core/`)**: Relocate the App-and-Channel boundary to `docs/core/architecture.md` and the public surface projection rules to `docs/core/communication.md`. Retain `docs/app-api.md` as a calibrated platform reference.
- **C4 (rename `agent-capability.md` to `mediation.md`; sharpen `agent-supply.md`)**: Rename the capability document to `docs/core/mediation.md` so the filename matches its actual scope: operation definition and invocation, `<operation>@<stage>` mediation points, the Capability Mediation Boundary, `CapabilityCall`, gateway routing, internal-role Tool admission, and rate-limit hooks. Relocate the authored-to-resolved-to-materialized agent supply pipeline to `docs/core/agent-supply.md`, keeping runtime execution and substrate placement in `docs/core/runtime-model.md`.
- **C5 (rename `permissions.md` to `policy.md`)**: Rename the permissions document to `docs/core/policy.md` because Policy in OpenKit covers access control, scope and disclosure rules, approval gates, and delegated goal domains rather than only an allow/deny check.
- **C6 (sharpen `knowledge.md` around three layers)**: Organize `docs/core/knowledge.md` around `Personal Memory` (user-scoped), `Knowledge Store` (Server, User, and Workspace scopes, Notebook, pages, sources, proposals, and reviews), and `Agent-Near Context` (`Context Package` assembly and delivery), while keeping the Knowledge Manager role definition in `docs/core/architecture.md`.
- **C7 (deduplicate `fault-tolerance.md` and `runtime-model.md`)**: Keep `Durable Execution`, `Safe Point`, `Danger Window`, and fault-source rules in `docs/core/fault-tolerance.md`, with `docs/core/runtime-model.md` cross-referencing `fault-tolerance.md` rather than restating durable-execution definitions.
- **C8 (sharpen `protocol.md` and `communication.md`)**: Keep wire records, identifiers, lifecycle states, replay cursors, and directional validation in `docs/core/protocol.md`, and keep client/Core and Core/agent communication planes, transport projections, and `Proven Non-Receipt` in `docs/core/communication.md`.
- **C9 (`storage.md` in two explicit layers)**: Organize `docs/core/storage.md` into Layer 1 (`System State And Work Data`: scope stores and control authority, immutable content, source of truth per data class, item log, retention and deletion classes including retained agent work data and Worker working volumes, format markers, and portability) and Layer 2 (`User Data And The Storage Service`: locations and byte operations, local-now and later non-current backends, `contentRef` digest and locator references, leases under Policy grants with host-side mounts and never sandbox FUSE, Knowledge package byte layout, and the external Git and object-storage boundary).

## Reason

OpenKit's Core documentation must follow the deep-module principle: each Core document should own one coherent conceptual boundary with a small interface and deep internal semantics, rather than splitting a single boundary across thin files or keeping implementation projections inside `docs/core/`.

1. **`evidence.md` (C1)**: `audit.md` and `metering.md` were thin documents that split closely related post-hoc observation and accounting records across three files (`audit.md`, `metering.md`, and the `UsageRecord` tail of `mediation.md`), while Capture Coverage and Telemetry rules were scattered across `protocol.md`, `fault-tolerance.md`, `architecture.md`, `core-concepts.md`, and `runtime-model.md`. Grouping Audit, Usage/metering, Capture Coverage, and Telemetry into `docs/core/evidence.md` establishes a single owner for what is recorded and with which authority, while keeping physical persistence, retention classes, and deletion in `docs/core/storage.md` Layer 1.
2. **Retiring `deployment-modes.md` and `app-api.md` from `docs/core/` (C2, C3)**: Deployment topologies and the HTTP/SSE App API surface are projections of deeper Core owners (`architecture.md`, `runtime-model.md`, `communication.md`, and `sandbox.md`), not independent Core aspects. Moving their normative Core invariants to those owners and keeping `docs/deployment.md` and `docs/app-api.md` as calibrated platform references removes downward projection detail from `docs/core/`.
3. **Renaming `agent-capability.md` to `mediation.md` and `permissions.md` to `policy.md` (C4, C5)**: A Core document is renamed only when its old filename misstates its scope and invites readers to look in the wrong owner. `agent-capability.md` had grown to own the unified `<operation>@<stage>` mediation model and internal-role Tool admission in addition to worker capabilities, making `mediation.md` the accurate name. `permissions.md` owned Policy statements, NGAC-aligned Policy Kernel semantics, disclosure audiences, approval gates, and delegated goal domains, which is broader than a binary permission check and is accurately named `policy.md`.
4. **Two layers in `storage.md` (C9)**: OpenKit persistence has two distinct conceptual layers within one persistence module—system control state and work data (Layer 1) and user file/content bytes served through the Storage Service (Layer 2). Making both layers explicit inside `docs/core/storage.md` integrates the accepted layered file storage and Knowledge package decisions without splitting persistence ownership across two Core files.
5. **Preserving `generative-apps.md`**: `docs/core/generative-apps.md` keeps its filename, with `Generative Kernel` and `Generative UI` framed inside the document and an explicit non-goal stating that OpenKit is not a low-code or no-code platform.

## Rejected Alternatives

- **Merge `core-concepts.md`, `work-model.md`, `agent-session.md`, `vault.md`, or `sandbox.md` into neighboring files**: Rejected because each of these documents already owns a distinct, high-leverage boundary (`core-concepts.md` for shared object identity and single-flight cardinalities; `work-model.md` for user-facing work projection and human intervention; `agent-session.md` for hidden runtime continuity, exact reconnect, and replacement; `vault.md` for secret references and zero-prompt-exposure injection; `sandbox.md` for containment and isolation areas). Merging them would create overloaded documents with mixed abstraction levels.
- **Move retention classes, deletion rules, and physical storage of evidence records into `evidence.md`**: Rejected because retention classes (`ephemeral-diagnostic`, `turn-evidence`, `workspace-audit`, `restricted-raw`, `legal-hold`), deletion closure, and control-store/blob placement are persistence invariants that apply across work history, Knowledge, and evidence alike and belong in `docs/core/storage.md` Layer 1.
- **Split `storage.md` into two separate Core files for control databases and file storage**: Rejected because control-store publication and content-addressed file storage share one acknowledgement, backup, and retention boundary; two explicit layers inside `docs/core/storage.md` express the distinction without fracturing persistence authority.
- **Rename `generative-apps.md` to `light-apps.md` or `generative-kernel.md`**: Rejected by engineer ruling; `generative-apps.md` remains the filename while framing `Light App`, `Generative Kernel`, and `Generative UI` together and stating explicitly that it is not a low-code or no-code builder.
- **Keep `audit.md` and `metering.md` as separate files**: Rejected because both are post-hoc record projections whose separation from each other and from Capture Coverage and Telemetry hid the unified authority boundary between authoritative governance/usage records, coverage intent, and non-authoritative diagnostics.

## Revisit When

- A future accepted architecture change introduces a genuinely new top-level Core aspect that cannot fit within the 21 aspect documents without violating single-owner boundaries.
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
- `docs/core/agent-workflow.md`
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
