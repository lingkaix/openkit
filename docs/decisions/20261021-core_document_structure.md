---
status: Accepted
date: "2026-10-21"
decider: Engineer
---
# Core Document Structure Consolidation

## Decision

The engineer approved a target of 20 Core aspect documents, organized around mechanisms with one owner for each canonical concept. Changes may land incrementally; the Core README records the current required set, term index and reading order. This decision records the approved target, not a claim that every change is already implemented.

The final 20-document set and architectural grouping are:
- Doctrine: `doctrine.md`, `core-concepts.md`, `architecture.md`, `fault-tolerance.md`, `contract-evolution.md`.
- Work: `work-model.md`, `knowledge.md`, `generative-apps.md`.
- Execution: `runtime-model.md`, `agent-session.md`, `sandbox.md`, `agent-supply.md`.
- Authority: `identity.md`, `policy.md`, `mediation.md`, `vault.md`.
- State and Evidence: `storage.md`, `evidence.md`.
- Interfaces: `protocol.md`, `communication.md`.

The approved changes are:
- **C1 — Evidence, narrowed.** `evidence.md` owns what is recorded and with which authority: Audit, Usage/metering, Capture Coverage and Telemetry. It receives `audit.md`, `metering.md`, UsageRecord and usage attribution from Mediation, and the capture switch from Protocol; it gathers existing telemetry predicates. Audit is accountability, Usage measures consumption, Capture Coverage records capture intent, and Telemetry is diagnostic, non-authoritative and lossy. Default-on Capture Coverage is the decided target; implementation defaults remain off until activation. Persistence, retention and deletion stay in Storage Layer 1. Workflow Evidence, EvidenceBundle and `decision-evidence` keep their owners. Retire `audit.md` and `metering.md` after the no-loss audit.
- **C2 — Mediation and Policy.** Rename `agent-capability.md` to `mediation.md`, the single interception base for Operation definition and invocation, operation-by-stage mediation points, CapabilityCall, gateway projection, routing, transformers, advice, gates, invocation evidence, budgets and rate limits. Move Enforcement Points from Permissions and the Capability Mediation Boundary from Communication. Communication keeps its transport projection. Rename `permissions.md` to `policy.md`; Policy owns authorization and governance, including principals, statements, decisions, approvals, administration and disclosure.
- **C3 — One Work module.** `work-model.md` absorbs `agent-workflow.md`, then the latter retires after the no-loss audit. One owner covers Intent, Objective, Plan, Goal, modes and recipes, internal-role collaboration, planning, gates, human attention and deliverables. Add the canonical Judgement and Candidate Set concepts for human-ground-truth evaluation.
- **C4 — Durable execution.** `fault-tolerance.md` receives Runtime's Durable Execution section and owns the effect-uncertainty rule. `runtime-model.md` retains scheduling, placement through the Execution Backend Port and substrate lifecycle, with a projection of the durable-execution owner.
- **C5 — Protocol depth.** Move identifier-prefix registries and derivations, Item Delta Kinds inventories, canonical enum/status tables and internal-role Tool alias detail into their receiving specifications. Core retains semantics and grammar principles. Core Concepts owns Thread, Turn and Item definitions rather than repeated definitions in Protocol.
- **C6 — Leakage and staleness.** Keep effect uncertainty in `fault-tolerance.md`, later subscription and `since` semantics in `protocol.md`, gateway-managed supply in `mediation.md`, and Shared-Sandbox audience rules in `policy.md`; replace their repeated rules with references. Correct the README Storage description, the superseded conditional agent-principal wording in Foundation, and the AgentSession invariant's missing Core-local service-Turn qualifier.
- **C7 — Navigation.** Use the architectural grouping above. Update the required set, canonical term index and reading order with each structural change rather than leaving them for a later cleanup.
- **C8 — Generative Kernel and Generative UI.** Keep `generative-apps.md`. Define the form, scope and authority of Generative Kernel and Generative UI, how Light App composes them, what AI generates and manages, and what remains with humans and Core. Ground the model in accepted Light App decisions and specifications: one SQLite file per Light App, kernel-format and definition-version markers, PocketBase-style schema, one-way migration after an automatic snapshot, agent-first access and presentation over admitted commands. This is not a traditional low-code/no-code builder.
- **C9 — Two Storage layers.** Keep one persistence module. Layer 1 owns system state and work data: scope stores and control authority, immutable content, source of truth per data class, item log, retention and deletion classes including retained agent work data and Worker working volumes, format markers and portability. Layer 2 covers user data and the Storage Service: locations and byte operations, local storage now with S3-compatible, NAS and cloud-drive backends later, digest and locator references, leases under Policy grants, package bytes and the external Git/object-storage boundary.

Rename only when a name collides with another system term, no longer names its owned mechanism after restructuring, or names a category instead of the canonical term. Naming style alone does not justify link churn and reader-memory cost. Rename `foundation.md` to `doctrine.md`: Foundation already names base layers in specification titles, while this document owns cross-aspect doctrine. The other approved renames are Agent Capability to Mediation and Permissions to Policy. The doctrine rename also updates the single root AGENTS.md path reference to that document; no AGENTS rule changes.

The engineer approved Policy because it expresses OpenKit's governance and authorization of agents, not only a permission question. The sole approved Core AGENTS wording change is: “Split policy and sandbox into separate docs. Policy is governance, authorization and decision semantics; sandbox is execution isolation and runtime environment design.”

The proposed rename from `generative-apps.md` to `light-apps.md` is withdrawn. “Generative” expresses that both the application data core and the UI are dynamically generated and managed by AI in an agent-native system, distinct from traditional low-code/no-code tools.

The retirements of Audit, Metering and Agent Workflow require an auditor's complete disposition of terms, principles, invariants and inbound current-guidance links before the final transition. Historical retention is unnecessary because Git history suffices; no Core archive directory is created. The mediation and policy renames preserve authority continuously.

## Reason

A reader needing one mechanism should obtain its stable interface, authority, invariants and failure meaning from one Core owner. Deep modules hide detail behind a small interface. Duplicated rules leak information between owners and drift; audience-based splits divide one mechanism; inventories widen an interface without deepening it. Consolidate the scattered record classes, interception mechanism and Work model, give durable execution and telemetry clear homes, and keep implementation inventories in specifications. Storage remains one persistence module with two explicit layers rather than moving retention into Evidence.

## Rejected Alternatives

- Merge Foundation and Architecture: doctrine and structural architecture are distinct seams; remove duplication instead.
- Merge Protocol and Communication: semantic independence from transport is the purpose of their boundary.
- Merge AgentSession into Runtime: native continuity has its own identity and lifecycle, separate from compute placement.
- Rename Runtime Model to Execution: the link and reader-memory cost buys little and blurs Runtime with durable execution in Fault Tolerance.
- Split Protocol into two Core documents: moving implementation inventories to specifications is sufficient.
- Change AGENTS rules generally: only the exact policy/sandbox sentence above is approved. Knowledge/AgentSession and Policy/Sandbox remain separate.
- Rename Generative Apps to Light Apps: the engineer retains the Generative Kernel/UI framing and the filename.
- Move record persistence, retention and deletion into Evidence: the narrowed C1 ruling keeps them in Storage Layer 1.

Keep `core-concepts.md` because it names the root vocabulary; `runtime-model.md` because it owns Runtime; `work-model.md` because it still names the merged module; `communication.md` because channels, notifications and planes exceed transport alone; and `fault-tolerance.md` because durable execution is narrower than its property doctrine. Other names already identify their mechanism or term.

## Revisit When

Revisit when concrete evidence shows that the resulting boundaries still duplicate authority, leave a stable concept without an owner, split one mechanism by audience, or expose implementation inventories as Core interfaces. Apply the same mechanism and rename criteria rather than renaming for style.

## Affected Owners

- `docs/core/README.md` and `docs/core/AGENTS.md`.
- [docs/core/foundation.md](../core/doctrine.md), `docs/core/core-concepts.md`, `docs/core/architecture.md`, `docs/core/fault-tolerance.md` and `docs/core/contract-evolution.md`.
- `docs/core/work-model.md`, [docs/core/agent-workflow.md](../core/work-model.md), `docs/core/knowledge.md` and `docs/core/generative-apps.md`.
- `docs/core/runtime-model.md`, `docs/core/agent-session.md`, `docs/core/sandbox.md` and `docs/core/agent-supply.md`.
- `docs/core/identity.md`, `docs/core/policy.md`, `docs/core/mediation.md` and `docs/core/vault.md`.
- `docs/core/storage.md`, `docs/core/evidence.md`, `docs/core/protocol.md` and `docs/core/communication.md`.
- `docs/specs/20261021-protocol_identifiers_and_enums.md` and `docs/specs/20260909-internal_agent_resource_integration.md` receive the implementation inventories.
