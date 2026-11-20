---
status: Accepted
date: "2026-11-20"
decider: Engineer
---
# Control Kernel And Service Storage

Target: v0.2.0 (storage branch)

## Decision

The engineer approved the following storage boundaries for the v0.2.0 baseline.

| Ruling | Accepted scope |
| --- | --- |
| E1 | Keep the Control Kernel and its retained facts stable. Each stateful Core Extension owns its native store and submits evidence through typed Core operations. The kernel schema contains no product-, adapter-, or agent-specific tables, columns, checks, seeds, or index predicates. |
| E2 | Make one explicit fresh-root cutover on development, staging, and production. Close production intake until all three acceptances pass. Freeze the new baseline at v0.2.0. |
| E3 | Keep 24 application tables in the Control Kernel. Move Server work, channel-neutral communication, and security triggers into Core Services. Move backend-native state into Core Extensions. Keep governed repair callable with only the kernel store. Compare the four Core, User, Workspace, and App journals in the update helper. Service and extension journals migrate independently after kernel readiness. |
| E4 | Validate one kernel attempt, input-proof, and release contract across NanoHost, a real development probe of the OpenAI Agents API, and a disposable E2B mock. Use E2B without an account or live calls. Keep native handles and raw evidence in the adapter. |
| E5 | Core owns intake reliability. Commit exact input at its work owner. Treat receiver intake as volatile and preserve each selected input obligation until exact consumption read-back or governed resolution. Adapters declare intake durability, read-back, and safe steer boundaries. Keep accepted, consumed, and unknown distinct. |
| E6 | Retain Discord data through disable and repair by default. An administrator can delete it or opt in to expiry. Expired challenges and disclosures cease to authorize actions. |
| E7 | Use in-platform updates for eligible changes after reinstall. Qualify service-only updates with ordinary readiness, the configured NanoHost path, and credential checks. |

### Baseline And Cutover

The v0.2.0 storage branch changes all Server storage owners in one fresh-root cutover. Compatible 0.1.x releases retain their four shipped SQL trees and journals.

The v0.2.0 baseline folds all preceding SQL into one `0000_baseline.sql` at Drizzle index 0 for each Core, User, Workspace, App, service, and extension journal. Keep service and extension journals under `drizzle/services/<id>/` and `drizzle/extensions/<id>/` respectively. OpenKit-owned retained version tags start at 1 at the new baseline, including record and envelope schema versions, registered formats, and versioned receipt and codec prefixes. Missing or unsupported tags fail closed. External protocol versions remain under their respective authorities.

During explicit fresh-root provisioning, install the frozen Core baseline with its native Drizzle ledger entry in the same transaction. Root identity requires exactly one row in `server/db/core.sqlite`'s `__drizzle_migrations` with `created_at` equal to `when` in Core journal entry 0. That row's `hash` must equal the SHA-256 of the released `0000_baseline.sql`. Ordinary startup verifies this row read-only before database creation, DDL, or ingress, then checks the supported ledger and required schema. Refuse a missing, duplicate, or conflicting baseline, including a predecessor hash or schema. Later supported migrations preserve that baseline identity. Each owner still checks its own ledger.

The v0.2.0 binary refuses roots without the v0.2.0 baseline identity. The in-platform updater refuses the 0.1.x to 0.2.0 transition with an explicit fresh-install requirement. Before reinstall, stop writers, fence remote attempts, and make and verify a deployment-local cold archive including committed WAL. Restore it to an isolated local root and verify deployment identity, inventory, digests and readability with the predecessor before replacing the installation. Reinstall on a fresh root in development → staging → production order. If a host fails, stop promotion and fence candidate effects before restoring the matched old image, whole-root archive, and protected bindings. An image-only rollback into a v0.2.0 root is unsafe. The predecessor migrator can replay its own baseline into the new schema.

Apply the exact candidate DDL to an empty Core database. Compare every application table with the 24-table allowlist, excluding only SQLite and Drizzle metadata, and verify the changed constraints and index predicates. On a stopped, initialized disposable root, remove every nonkernel SQLite file and its sidecars. After boot, verify sign-in, Audit append and read, the same held work and outstanding input, typed unavailability, zero unsafe effects and one successful authorized repair call through a stub Provider. Verify that startup does not silently recreate the missing files. Repeat with a corrupt, full or migration-failed owner and verify independent owners can work while the kernel can commit. Verify restore isolation, rehearse paired rollback, and read back the NanoHost nonce file and transcript after restart. Before kernel freeze, exercise the real development Agents API and the E2B mock against lost acknowledgements, processing read-back and writer fences. A missing guarantee disables the affected capability. At cutover NanoHost is the enabled execution backend. External adapters require full qualification before production enablement. E2B stays mock-only. Security trigger reports disabled across boot, configuration, enable requests, replay and background work. Existing kernel Policy restrictions remain effective. DM pairing and unbind work. Unimplemented Reports routes and any other unfinished #720 routes remain unavailable. Subsequent kernel journal changes require engineer approval.

### Approved Retained Decisions

- Internal cross-owner request IDs are bare UUIDv5 in the URL namespace over the UTF-8 JSON Canonicalization Scheme encoding of `["openkit:storage-receipt:v1", deploymentId, sourceOwner, verb, occurrenceKey]`. Inbound occurrences bind the channel kind, event family, and authenticated external event coordinates across principals. Retain the tuple and compare expected generation and semantic input hash separately. Changed input conflicts. Public request IDs keep their existing contract.
- Keep `channel_kind='discord'` and a permanent channel-neutral `channel.inbound` occurrence key. Preserve independently keyed external triggers. Communication commits the pairing or revocation and an immutable local Audit fact in the same transaction. Relay uses the existing Audit envelope and original event ID and full content.
- The kernel queue retains input identity and digest. Claim and create the attempt atomically. The retained attempt binds scope, authority, package, generation, phase, and the first stop cause. Its operation ID is the original invocation ID. Preserve immutable control and clock facts and settle-once step lineage. Versioned step carriage and output references bind proof identity and digest and the covered scopes and handoffs. Consume a receipt once and compare its digest on replay.
- Keep `deliver-steer` in Workspace work steps. Before contact, the kernel records an `admit` step per selected input. Link later `observe` or `consume-receipt` evidence. The versioned bounded proof binds input ID, digest and order, target Turn, attempt and generation, original operation, boundary, native proof reference and digest, and the established disposition. Unknown required semantics refuse. Use the existing execution steps for this obligation.
- Use the flat extension path `server/extensions/openai-agents/state.sqlite` for native OpenAI Agents API inspection alongside `nanohost` and `discord`. Keep E2B mock state disposable.
- A governed administrator abandonment can waive enumerated missing handoffs for fenced scopes. Record actor, original attempt, fences, surviving exclusions, missing work, and residual costs or effects. Preserve all surviving exclusions at placement and keep remote cleanup independently accountable.
- An authorized repair call binds the authenticated role and model call in kernel execution lineage and operates under a bounded Policy grant. Use a pre-authorized repair-call allocation within the shared Budget that the kernel can verify. Register `repair.model-call` v1 as the governed Policy action and terminal Audit action. Reuse `permission.decision` for admission. Denied authority or budget prevents provider contact. Report success only after terminal Audit commits.

### Decision Refinements

- The one-time reset and journal consolidation refine the first-release boundary in [Schema Migrations Start At First Release](20260918-release_schema_migrations.md#decision), [Pre-Stable Data Continuity](20261014-pre_stable_data_continuity.md#decision), and [Pre-Release SQL Baselines](20261114-pre_release_sql_baselines.md#decision). The Workspace AgentSession index correction is folded into the Workspace baseline. Subsequent carried-forward data follows the ordinary continuity rules.
- Kernel grant state and adapter-owned native bindings refine the attempt and process-proof clauses in [Execution Backend Port In NanoCore](20261006-execution_backend_port_in_nanocore.md#decision) and the retained adapter boundary in [Compute And Harness Neutrality](20261020-compute_and_harness_neutrality.md#decision).
- Per-input proof refines Core's internal retention and release obligations under [Task Live-Steer Rulings](20261008-task_live_steer_rulings.md#decision). The public native-acceptance contract continues to describe the acknowledgement.
- Each file has one bounded off-Main writer in the existing pool. Acknowledgement follows a FULL commit. This refines the writer topology in [Control Store Writer Placement And Load Envelope](20261020-control_store_writer_placement.md#decision).

The internal-agent owner specifies definition and state-placement details. Agent-specific tables are outside the Control Kernel.

## Reason

Failure of a service or extension must leave the kernel able to govern effects. Keeping independent decisions in separate files limits migration and availability failures. Keeping a binding revision and its local Audit fact in one file preserves both facts on interruption. A binding from an older snapshot cannot prove current authority. Keeping input bytes at the work owner prevents an accepted instruction disappearing with a receiver inbox or leaving duplicate text in the kernel queue after Workspace deletion. A fresh baseline makes the one-time owner switch explicit. A matched image and cold archive recover the predecessor together.

## Rejected Alternatives

- Ship successive owner changes in maintenance releases with dormant copies of moved tables. A single cutover avoids partial authority switches and rollback into stale tables.
- Give the new journals disjoint migration timestamps to separate them from the predecessor. The approved frozen baseline uses a fresh root and a matched rollback pair.
- Infer consumption from receiver acceptance or release a conflict on a kill acknowledgement alone. Both would discard obligations before the deciding facts are known.

## Revisit When

Revisit the kernel contract if the required backend probes expose a deciding fact the existing attempt, step, or scoped hold cannot represent. Where an adapter cannot prove a required guarantee, record the uncertainty and refuse the capability until it qualifies.

## Affected Owners

- [Architecture](../core/architecture.md#core) defines the ownership tiers. [Storage](../core/storage.md#server-storage-owners) records their placement and transaction boundaries.
- [Runtime](../core/runtime-model.md#scheduling-model) and [Fault Tolerance](../core/fault-tolerance.md#rules-by-fault-source) own selected input, recovery, and fencing.
- [Contract Evolution](../core/contract-evolution.md#retained-data-continuity) owns the one-time continuity exception.
- [Identity](../core/identity.md#inbound-credentials) and [Communication](../core/communication.md#common-channel-contract) own revocation and channel authority.
- [Evidence](../core/evidence.md#audit-source-of-truth) and [Mediation](../core/mediation.md#governed-repair-calls) own governed repair evidence and admission.
- [Work Model](../core/work-model.md#active-work-semantics) owns the work scope of accepted input.
