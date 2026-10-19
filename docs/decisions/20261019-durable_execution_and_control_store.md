---
status: Accepted
date: "2026-10-19"
decider: Engineer
---
# Durable Execution And Control Store

## Decision

Replace split mutable control authority with scope-owned SQLite control stores. Each state transition commits in exactly one transaction in its owning database. Files hold immutable content, made durable before a transaction references its digest; readable record files are projections. Reuse the Storage Service and its content references rather than introduce another blob store. SQLite is the transaction manager, not an auxiliary journal beside existing authority. WAL databases do not gain crash-atomic cross-database commits through ATTACH.

Use durable execution without an external workflow server or code replay. Existing Turn and Task execution uses state machines as data, a step journal, durable signals and timers, and one reconciler whose restart path is its normal path. Record intent, perform the effect, then record outcome. Skip completed steps. Never automatically repeat an external effect with an unknown outcome; only declared idempotent operations are retry candidates under their owning contract. A lost native Worker is not replayable: record unknown execution, interrupt the Turn truthfully, and require a new authorized Turn for native-session resume. Preserve necessary Host and Worker fences as step attributes.

Each operation has one propagated deadline. Inner waits and retries spend the parent's remaining allowance and never renew authority. Failure closes only the owning scope: unsupported or unreadable Workspace authority quarantines that Workspace while the server and other Workspaces can boot; server-scoped authority failures refuse server boot. This failure-scope rule applies to the current storage implementation as well as the replacement. Bound NanoHost restart frequency while Core is unavailable, preferring stock systemd backoff and preserving non-restartable exit semantics.

Each Workspace remains independently backupable and movable. Its control database and locally retained immutable content stay inside its directory. The server database owns server-scoped and physical state, including users, server Knowledge, Host/Sandbox/Epoch and capacity. Cross-scope physical operations use intent, idempotent apply by identity, and outcome rather than a distributed transaction. Authored server configuration remains server-scoped and executions pin revisions or digests. Knowledge retains its meaning and history owner; its mutable publication heads follow the transaction rule in the owning scope database.

The layout must support consistent static SQLite snapshots followed by copying their referenced immutable content under garbage-collection protection. Filesystem backup and synchronization to S3-compatible storage remain the intended operational direction; other cloud drives are possible. A move requires settled in-flight executions and proved writer fencing. It does not silently transfer Vault material, server membership, Worker retained volumes, or externally shared server Knowledge.

Retained work data supports later extraction, comparison, improvement, scoring, evaluation and training without predicting its future use. Capture valuable admitted work as completely as possible under its owning confidentiality and capture rules; processing such as anonymization happens at use time. The layout uses deduplicated content-addressed messages and parts, with prompts and tool definitions stored once per digest. The same day's later confirmation assigns a separate Work Data Retention Format amendment to make Capture Coverage default on, retain model I/O losslessly, and retain native transcripts verbatim by default. Those admitted records and blobs travel with their Workspace; the execution journal references them by ID/digest rather than defining them. This layout does not become a second capture-default or record-schema owner. Missing historical capture remains missing.

The step journal uses the OpenTelemetry span data model in SQLite rows: one trace ID per execution, one span ID per step, parent identity, name, kind, Unix-nanosecond times, status, typed attributes, events and links. Open intent commits with the state transition and remains visible before completion. Each ended step has exactly one lossless OTLP span projection; an open step is not exported. Export delivery stays lossy and is not an exactly-once guarantee. Journal trace/span identities are correlation, never execution or access authority. The journal alone is an exception to the earlier no-durable-trace rule in [NanoHost Trace Headers And Startup Link](20261016-nanohost_trace_headers_and_startup_link.md); other canonical records and transport bodies gain no trace state. Optional native trace headers remain binding. The [Sandbox telemetry boundary](20261015-sandbox_telemetry_and_public_gateway_boundary.md) retains its SDK/exporter/egress prohibition, with the engineer's same-day narrow phase-marker exception: release-allowlisted Worker enum/timestamp markers may use existing worker control. Core validates identity, count/byte limits and timestamps before retaining them as bounded unverified events on the owning open step. They never decide status, outcome, retry, recovery or fences. The telemetry owner records that amendment and owns its detailed allowlist.

Human waits preserve later-Turn outcome delivery, with no paused Turn status or default expiry. Goal structures remain frozen; this engine does not decide them.

Ablate surviving-Worker adoption after Core restart, each nested clock, and each process key, connection generation, physical Epoch and attachment generation separately. Keep a mechanism only when a named failure requires it; do not remove a safety boundary by assumption or weaken its fault oracle.

This replacement must land before `v0.1.0` because it is the system's base mechanism. The engineer initially permitted backup/move operations after `v0.1.0`, then confirmed on the same day that minimal Workspace backup, restore and move also belong in `v0.1.0`. The later confirmation controls; the separate backup/move owner defines that minimal operation scope, and the complete enabling layout is mandatory. The pre-stable data cutover uses one explicitly authorized reset, with no converters, legacy readers or dual writes. This decision does not execute or independently authorize a deployment reset.

## Reason

Source: the engineer's 2026-10-19 direction to the coordinator, translated from Chinese, with the same day's clarifications of Storage reuse, scheduling, configuration, human waits, journal span fields, retention completeness, Workspace snapshot coverage and rollout. Split commits leave contradictory accepted records and require separate recovery classifiers. A single local commit point removes those windows. The remaining physical and external effect boundaries cannot become atomic with Core storage and must retain truthful uncertainty.

Per-Workspace control stores preserve portability and failure isolation. A server-owned capacity reservation is necessary for global limits, but it need not duplicate Workspace execution state. An in-memory dispatch index and bounded database handles provide global scheduling without a second durable queue. Existing bans on a universal Run or recovery ledger rejected duplicate authority; this decision replaces existing owners instead of adding a parallel one.

## Rejected Alternatives

- An auxiliary journal beside mutable files and existing control tables preserves the split-commit problem and adds another recovery obligation.
- One global database for all Workspace truth obstructs independent backup, movement and quarantine.
- WAL ATTACH, compensation, or a distributed transaction cannot provide the required single local commit semantics across external execution.
- Temporal/DBOS services, code replay, a workflow DSL or a general event bus add a product and operational surface that this need does not require.
- Replaying a lost native Worker, guessing a missing result, or using telemetry as retained evidence would invent outcomes or repeat effects.
- Whole-server refusal for an isolated Workspace defect widens failure without protecting additional authority.
- A custom NanoHost retry controller duplicates service-manager responsibility; use stock backoff or a conservative fixed-delay fallback.
- Pre-stable converters and dual writes prolong obsolete authority before the stable data-continuity boundary begins.

## Revisit When

Revisit database placement if measured scale defeats bounded handles and the rebuilt dispatch index while preserving independent Workspace portability. Revisit an ablation only with a named fault that distinguishes its alternatives. Revisit expanded backup operations after the separately owned minimal first-release scope; neither that scope nor its enabling layout may be postponed by this proposal. Any change to unknown-effect handling, authorization, writer fencing, Goal structures, or retained-data continuity requires a separate engineer decision.

## Affected Owners

- [Storage](../core/storage.md), [Runtime Model](../core/runtime-model.md), and [Fault Tolerance](../core/fault-tolerance.md).
- [Durable Execution And Control Store](../specs/20261019-durable_execution_and_control_store.md), [Storage Layout](../specs/20260703-storage_layout_record_ownership.md), and [File Storage And Knowledge Packages](../specs/20261018-file_storage_and_knowledge_packages.md).
- [Durable Scheduler](../specs/20260703-durable_scheduler_design.md), [Scheduling Scale](../specs/20260703-runtime_scheduling_scale.md), [Bootstrap](../specs/20260704-nanocore_bootstrap_readiness.md), and [NanoHost](../specs/20260802-nanohost_runtime_and_transport.md).
- [Recurring Triggers](../specs/20260711-scheduler_recurring_event_triggers.md), [Work Data Retention](../specs/20260921-work_data_retention_format.md), and [Backup/Export](../specs/20260704-workspace_backup_export_import.md).
- [Notebook](../specs/20260909-knowledge_notebook_editing.md), [Operational Telemetry](../specs/20260731-operational_telemetry_standardization.md), and [Goal Freeze And Export / Backup Separation](20260928-goal_freeze_and_export_backup_boundary.md).
