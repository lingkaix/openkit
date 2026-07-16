# NanoCore Bootstrap, Readiness, And Recovery

Status: Accepted
Implementation: Partial

## Owns

- The ordered NanoCore boot phase contract, including which phases fail closed and which degrade.
- The one pre-listen restart scan between trustworthy boot foundations and normal serving.
- The single-instance data-root lock, its liveness probing, and stale-lock breaking rules.
- The liveness-versus-readiness model and the per-subsystem readiness state set.
- Boot-time corruption recovery for derived SQLite indexes and SQLite source-of-truth stores, including quarantine behavior.
- The ordered shutdown contract and its crash-only baseline.
- Boot and shutdown audit event requirements.

## Does Not Own

- Scheduler restart-recovery, lease re-adoption, epoch fencing, or untracked-execution handling. `docs/specs/20260703-durable_scheduler_design.md` owns those; boot only invokes them at the defined phase.
- The physical `DATA_ROOT` ownership tree, source-of-truth assignments, or database-per-scope layout. `docs/specs/20260703-storage_layout_record_ownership.md` owns those; boot verifies against them.
- Schema evolution, record envelopes, required-feature semantics, or unknown-record fail-closed rules. `docs/specs/20260703-schema_evolution_record_envelope.md` owns those.
- Config schema contents, identity, auth middleware, or runtime config reload posture. `docs/specs/20260628-nanocore_config_identity_contract.md` owns those.
- Vault backend design, secret storage, or unlock flows. `docs/specs/20260704-vault_backend_implementation.md` is the sibling spec being authored for the vault backend; this spec only defines how vault availability projects into boot and readiness.
- App API route design; readiness routes are an implementation projection of the diagnostics read model.

## Core References

- `docs/core/architecture.md`
- `docs/core/storage.md`
- `docs/deployment.md`
- `docs/core/audit.md`

## Summary

This spec defines how a NanoCore process becomes a trustworthy kernel: a strictly ordered boot sequence with explicit fail-closed and degrade decisions per phase, an exclusive per-data-root instance lock, a readiness model distinct from liveness and computed from per-subsystem states, automatic boot-time recovery for corrupted storage, and an ordered shutdown that remains optional because crash-only recovery is the baseline.

The clean target is that every boot either fails closed with a typed diagnostic, or reaches a readiness signal whose degraded components are individually named with typed reasons. Restart handling is a bounded durable scan plus ordinary worker-control traffic, not a boot-time serving subsystem.

## Goals

- Fix one boot phase order so every subsystem can rely on its predecessors being verified.
- Make boot failure modes typed and diagnosable instead of implicit process exit.
- Protect the single-writer scheduler and storage assumptions with an exclusive instance lock.
- Separate "the process answers HTTP" from "the process accepts product work".
- Bind the normal application listener exactly once after the restart scan has armed any eligible surviving leases.
- Recover derived indexes automatically and quarantine unrecoverable source-of-truth stores instead of booting on corrupt state.
- Keep shutdown a best-effort optimization over crash-only recovery, never a correctness requirement.
- Make every boot and shutdown auditable.

## Non-goals

- Do not restate scheduler recovery semantics, storage layout trees, or schema evolution rules; reference the owning specs.
- Do not define config schema fields or validation rules beyond the boot behavior on their outcomes.
- Do not design multi-node coordination, rolling upgrades, or zero-downtime restart.
- Do not define exact HTTP routes, response shapes, or Web UI readiness screens.

## Background

The historical baseline in `apps/nanocore/src/index.ts` was a linear script that resolved the data root, opened the server-scope `server/db/core.sqlite`, loaded runtime config, applied migrations, and served. It had no instance lock, readiness model, integrity checking, policy or vault phase, or shutdown handling, so a second process pointed at the same data root could silently violate the single-writer assumptions that `docs/specs/20260703-durable_scheduler_design.md` and `docs/specs/20260703-storage_layout_record_ownership.md` depend on. The Current Implementation Projection below records the foundation that replaced that baseline.

The durable scheduler spec defines restart recovery as a scan-and-adopt procedure but does not own when it runs relative to config, storage, policy, vault, or local identity initialization. The storage layout spec defines the ownership tree and requires derived indexes to be rebuildable but does not own boot ordering. This spec closes that design gap; the Current Implementation Projection records the applied verification and recovery behavior.

## Decision

NanoCore boots through eight strictly ordered phases. Critical phases (config, data-root layout, instance lock, migrations, policy kernel, local identity, and restart ownership reconciliation) fail closed with typed diagnostics. The vault backend and other non-critical subsystems degrade instead of failing boot. Phases 1-6 establish trustworthy foundations, phase 7 establishes the implicit local identity when local mode requires it, and phase 8 performs one durable restart scan without serving traffic. After all eight phases complete, NanoCore binds the normal listener once, starts ordinary services, and publishes readiness. Readiness is a computed projection over per-subsystem states, distinct from liveness. Boot-time corruption recovery rebuilds derived indexes automatically and quarantines corrupt SQLite source-of-truth stores. Shutdown is ordered but every step is skippable because boot recovery handles the crash case. Boot and shutdown emit audit events.

## Contract / Expected Behavior

### Boot phases

NanoCore MUST register `SIGINT` and `SIGTERM` handlers immediately on process entry, before phase 1 begins. Registration is process-safety plumbing rather than a boot phase and does not change the eight-phase ordering. A received signal closes admission and initiates bounded shutdown when possible, but it is diagnostic input only and never proves that a remote worker stopped or authorizes cleanup.

Boot MUST execute the following phases in this order. A phase MUST NOT start before its predecessor reaches its defined outcome. Each phase records its outcome in the boot audit trail (see Boot And Shutdown Audit).

1. **Config load and validation.** NanoCore loads and validates server config per `docs/specs/20260628-nanocore_config_identity_contract.md`. Malformed config, config that fails schema validation, and config carrying an unknown required feature MUST fail boot closed with a typed diagnostic naming the file, the failure kind, and the unsupported feature identifier where applicable. Warnings-level diagnostics MAY be recorded without failing boot, but authority-bearing validation failures MUST NOT be downgraded to warnings.
2. **Data-root layout verification.** NanoCore verifies the `DATA_ROOT` ownership tree defined by `docs/specs/20260703-storage_layout_record_ownership.md`, creating missing directories that the layout spec defines as server-creatable. Boot MUST fail closed with a typed diagnostic on an ownership violation (a path owned by one scope appearing under another) and on a data root whose recorded layout version belongs to an incompatible layout. A data root with no layout marker is initialized as a new data root; a data root with a newer layout version than this build supports MUST NOT be modified.
3. **Single-instance lock.** NanoCore acquires an exclusive lockfile in the data root before opening any database for write. Exactly one NanoCore process MAY own one data root at a time; this protects the single-writer scheduler and the storage single-writer append disciplines. The lockfile MUST record the holder's process identity, boot id, and a liveness beacon. An existing local lock MUST be broken when liveness probing confirms the recorded holder process is dead, including the normal fast-restart case where the previous heartbeat is still fresh. A lock whose holder is alive, remote, unreadable, or whose liveness is indeterminate MUST fail boot closed with a typed diagnostic naming the holder when available. Lock breaking MUST be recorded in the boot audit trail.
4. **Storage migration.** SQLite migrations for each ownership-scope database run transactionally at boot, and each applied migration version MUST be durably recorded before it is treated as applied. A failed migration MUST roll back and fail boot closed with a typed diagnostic naming the migration id. File-backed record formats MUST NOT be bulk-rewritten at boot; file-backed evolution follows `docs/specs/20260703-schema_evolution_record_envelope.md`, and any explicit one-way major-version rewrite is a separate operator-driven migration, not a boot side effect.
5. **Policy kernel load.** NanoCore loads the policy kernel per `docs/specs/20260629-openkit_policy_model.md` and `docs/specs/20260703-policy_enforcement_mapping.md`. Failure to load a usable policy kernel MUST fail boot closed: no policy means no authorization, and NanoCore MUST NOT serve product work under an absent or partial policy kernel.
6. **Vault backend availability.** NanoCore checks the vault backend per `docs/specs/20260704-vault_backend_implementation.md`. A locked or unavailable vault MUST NOT fail boot. Boot proceeds with vault subsystem state `locked`, and every vault-dependent operation MUST fail with a typed error naming the vault state until the vault is unlocked. Vault-independent work proceeds normally; this is the canonical degraded-readiness case.
7. **Local identity initialization.** In local mode, NanoCore ensures the implicit local user exists before scheduler recovery can resolve workspace-scoped owners. Server mode performs no synthetic-user write. Failure to establish the required local identity fails this critical phase closed.
8. **Restart ownership scan.** NanoCore constructs the durable worker-control gateway and backend runtime, then runs the scheduler restart scan defined by `docs/specs/20260703-durable_scheduler_design.md`. The scan closes any already accepted final status through existing owners, routes unrecoverable or sequence-zero-only leases through exact cleanup, and moves an eligible post-launch heartbeat-live lease with `lastWorkerSequence >= 1` to its one preserved `awaiting-reconnect` deadline. It does not wait for a worker, bind a listener, create a recovery admission index, or start a recovery-serving subsystem. Failure to establish exact ownership, fence cleanup, or preserve capacity fails this critical phase closed.

After phase 8 succeeds, NanoCore starts the LLM gateway, verifies knowledge indexes, constructs the normal application over the worker-control gateway prepared in phase 8, binds its configured listener exactly once, starts ordinary scheduler services, computes and publishes the initial readiness projection, and opens product-work admission when the computed state permits it. A worker whose lease is `awaiting-reconnect` reaches the ordinary heartbeat route and may adopt only through the process-key, lineage, sequence, deadline, and lease compare-and-set contract. The lease keeps its capacity while waiting; it does not create a deployment-wide readiness gate. Timeout cleanup compare-and-sets the lease to `needs-evidence` before physical effect; a cleanup failure remains fenced for the next boot. A newly accepted restart final status gets one asynchronous process-local closeout attempt; failure leaves the lease `releasing` for the next boot rather than creating durable retry stages.

Liveness HTTP serving begins only after phase 8 through the single normal listener. There is no temporary recovery listener, special recovery route family, or listener replacement.

### Liveness versus readiness

Liveness and readiness are distinct signals:

- **Liveness** means the process has bound the single normal HTTP listener and can answer its permitted route set. A live process MAY be entirely unready.
- **Readiness** means NanoCore is accepting product work. Readiness is computed from per-subsystem states and MUST NOT be a single boolean in storage; it is always derived.

Per-subsystem readiness states cover at minimum: config, storage, policy kernel, vault, scheduler, LLM gateway (and provider reachability beneath it), and knowledge index. Each subsystem is in exactly one state:

- `ready`: the subsystem operates within its contract.
- `degraded`: the subsystem operates with a typed, named reduction (vault `locked`, a provider unreachable, knowledge index rebuilding).
- `failed`: the subsystem cannot operate.

Rules:

- Config, storage, and the policy kernel are critical subsystems. A critical subsystem in `failed` state at boot means boot failure; a critical subsystem entering `failed` after boot MUST drop overall readiness and stop product-work admission.
- Non-critical subsystems in `degraded` or `failed` produce degraded overall readiness with typed reasons, never silent acceptance. Every degraded state MUST carry a machine-readable reason and the operations it blocks.
- Readiness is projected as an App API diagnostics read model per `docs/core/architecture.md` governed-API rules; exact routes and payload shapes are implementation projection. The read model MUST expose per-subsystem state, typed reasons, and the boot id.
- Readiness summaries are derived records under `docs/specs/20260703-storage_layout_record_ownership.md` and MUST be rebuildable; they are never source of truth.
- Phase 8 is not live because the listener has not bound. A failed ownership scan fails boot closed with its typed diagnostic.
- An `awaiting-reconnect` lease is ordinary durable scheduler state after post-phase serving begins. It retains its own capacity and blocks reuse of its session, but it does not by itself close global product admission or stop unrelated scheduler work.
- Boot MUST NOT create a settlement record, recovery coordinator, duplicate domain workflow, transcript import, workspace manifest, review state, turn state, or cleanup state. Restart closeout calls the existing owners directly.

### Boot-time corruption recovery

Integrity verification runs during phases 2 and 4 and during post-phase serving initialization as appropriate to each store. The rules:

- **Derived SQLite indexes** (search tables, read models, readiness summaries, knowledge indexes) that fail integrity checks MUST be rebuilt automatically from their file-backed source of truth or authoritative ledgers, per the rebuildability invariant in `docs/core/storage.md`. Rebuild MAY complete asynchronously after boot; while rebuilding, the owning subsystem reports `degraded` with reason `index-rebuilding`.
- **SQLite source-of-truth stores** (scheduler coordination records, audit ledgers, idempotency ledgers, and the other families assigned to SQLite by the storage layout spec) that fail integrity checks MUST be quarantined, not repaired in place: the database file is moved aside under the owning scope's quarantine location, an audit record is written naming the file, digest, and failure, and a fresh empty store is created and migrated. In-flight work whose scheduler records were quarantined is then handled by the scheduler's untracked-execution rules in `docs/specs/20260703-durable_scheduler_design.md`; this spec adds no scheduler semantics.
- **File-backed records** are not scanned exhaustively at boot. A file-backed record read during boot that carries an unknown required feature or unknown canonical record family MUST fail closed per `docs/specs/20260703-schema_evolution_record_envelope.md`; when the record is required for a critical phase this fails boot, otherwise it degrades the owning subsystem with a typed reason.
- Quarantine MUST preserve the quarantined material untouched for the retention window defined by the storage layout spec's quarantined-evidence rules. Boot MUST NOT delete data it cannot read.
- A quarantine or rebuild event at boot MUST surface in the readiness read model and the boot audit trail; recovery MUST NOT be invisible.

### Ordered shutdown

On an orderly shutdown request, NanoCore SHOULD execute, in order:

1. Stop admissions: overall readiness drops, new product work is refused with a typed shutting-down error, liveness continues.
2. Scheduler wind-down: the scheduler handles live leases at safe points per its own spec; this spec does not define lease semantics.
3. Flush pending durable writes: buffered appends, pending audit rows, and readiness projections are flushed.
4. Release the instance lock as the final step.

Crash-only design remains the baseline: every shutdown step MUST be safe to skip, because boot recovery (lock liveness probing, scheduler restart recovery, index rebuild, quarantine) handles the skipped case. No durable state may exist whose correctness depends on shutdown having run. Shutdown SHOULD be bounded by a deadline after which the process exits regardless; exceeding the deadline is a crash by construction and is recorded as such on the next boot.

### Boot and shutdown audit

Boot and shutdown emit audit events per `docs/specs/20260703-audit_usage_evidence_records.md` homing rules (server control-plane scope). At minimum:

- Boot start and boot outcome events carrying: boot id (unique per process run), data-root layout version, migration versions applied this boot, lock acquisition (including any stale-lock break with the dead holder's identity), quarantine and rebuild events, per-subsystem readiness outcome with degraded reasons, and the typed diagnostic on boot failure.
- Shutdown events carrying: boot id, shutdown reason, steps completed, and whether the deadline forced exit.
- Boot audit events MUST be written even when boot fails, as far as storage availability allows; a boot that fails before storage is writable emits its diagnostic through process output and the failure is reconstructed on the next successful boot from the lockfile and layout evidence.

## Accepted Design

Boot is one explicit orchestrator: an ordered list of phase executors, each returning a typed outcome (`ok`, `degraded(reasons)`, `failed(diagnostic)`), with the criticality table deciding whether `failed` aborts. Signal handlers are installed before the orchestrator begins. The orchestrator owns the boot id, audit emission, and readiness state store. The instance lock is a lockfile plus periodic beacon refresh; liveness probing checks the recorded process identity before breaking a local dead-holder lock. Phase 7 establishes local identity where required, and phase 8 reconciles existing durable owners and arms eligible leases. The process then binds the normal listener once and starts ordinary services. No recovery admission index, route gate, listener phase, or settlement coordinator exists.

## Current Implementation Projection

The V1 foundation and pre-listen restart scan are implemented in the active slice. `AppDiagnosticsResponseSchema` in `@openkit/app-api-schemas` now includes a strict `boot` readiness projection with a process boot id, overall readiness, product-work admission flag, and typed subsystem states for config, storage, policy, vault, scheduler, LLM gateway, and knowledge index. `apps/nanocore/src/bootstrap/readiness.ts` computes the first process-local readiness snapshot: config, storage, and policy failures stop product-work admission and set overall readiness to `failed`, while non-critical degraded or failed subsystems set overall readiness to `degraded` without closing product admission for unrelated work. `apps/nanocore/src/bootstrap/phases.ts` implements the boot phase runner, and `apps/nanocore/src/app.ts` exposes the resulting diagnostics and admission gate.

`apps/nanocore/src/bootstrap/lock.ts` implements the first data-root lock slice. `apps/nanocore/src/index.ts` creates the boot readiness snapshot, acquires `server/runtime/nanocore.lock` before opening the server SQLite database for write, records holder process metadata and a heartbeat timestamp, passes the same boot id into diagnostics, and releases the lock on orderly `SIGINT` / `SIGTERM` shutdown. A second process aimed at the same data root fails closed while the holder is live, remote, unreadable, or liveness is indeterminate. A local lock is broken immediately when the recorded process id is confirmed absent, including fast restarts where the previous heartbeat is still fresh.

`apps/nanocore/src/index.ts` runs config, data-root layout verification, instance locking, SQLite migration, policy load, vault projection, and scheduler restart recovery before it creates the application and binds HTTP. The active restart slice constructs the durable worker-control gateway and backend runtime during that scan, closes any accepted final status through existing records, and arms eligible leases as `awaiting-reconnect`. After serving starts, the existing scheduler lease-maintenance interval invokes expired reconnect cleanup; no restart-specific timer or shutdown owner exists. Boot audit, storage quarantine, derived-index rebuild, shutdown admission stop, bounded HTTP close, and final lock release remain the existing foundation.

The active restart slice constructs the durable worker-control gateway and backend runtime during phase 8, arms eligible leases before constructing the application, then binds the ordinary listener once after the boot phases complete. A surviving worker retries until that listener is available and adopts through the normal heartbeat route. No special route gate or recovery-serving state is required.

## Alternatives Considered

- **Lazy migrations (migrate on first table touch).** Rejected: it smears schema authority across the whole process lifetime, makes "storage ready" unknowable at readiness time, and turns migration failures into mid-request errors instead of one typed boot outcome.
- **No instance lock, relying on SQLite file locking.** Rejected: SQLite locking is per-database and per-transaction; it does not protect file-backed append disciplines, the scheduler's single-logical-writer assumption across databases, or the data root as a whole. One exclusive lock per data root is simpler to reason about than emergent lock composition.
- **Fatal boot on locked vault.** Rejected: it couples kernel availability to secret-backend availability and makes headless restart (reboot, crash recovery) impossible without interactive unlock. Typed per-operation failures under `locked` state preserve safety without holding the whole kernel hostage.
- **Single boolean readiness.** Rejected: it cannot express the vault-locked and index-rebuilding cases without either lying (`ready`) or over-blocking (`unready`); per-subsystem typed states are the minimum honest model.
- **Repairing corrupt source-of-truth SQLite in place (e.g. `REINDEX`, dump/reload).** Rejected as the default: silent repair can resurrect torn coordination state that the scheduler then trusts. Quarantine-and-recreate plus the scheduler's untracked-execution rules give a defined, auditable outcome; explicit repair tooling can exist as operator action, not boot behavior.
- **Requiring ordered shutdown for correctness.** Rejected: any state that needs shutdown to run is state that a crash corrupts; crash-only with boot recovery is the only baseline that survives reality.

## Consequences

- Boot gains phases and checks; startup on a healthy data root gains only lock, layout, and integrity costs, which are negligible on localhost.
- A second NanoCore against the same data root becomes an immediate typed failure instead of silent corruption.
- Operators and product surfaces get one honest readiness answer with named degraded reasons, at the cost of maintaining per-subsystem state discipline in every subsystem.
- Corruption stops being a boot-blocker for derived state and stops being silently trusted for source-of-truth state.
- The boot orchestrator becomes a dependency for every future subsystem: new subsystems MUST register a phase and a readiness state to exist.
- A restarting process exposes no partial application surface: it reconciles restart ownership first, then the ordinary listener becomes reachable to surviving workers.

## Rollout / Migration Plan

This is new machinery replacing the linear boot script; per the internal development compatibility rule there is no dual path. Rollout order: (1) boot orchestrator with typed phase outcomes wrapping the existing config/layout/migration steps, plus the instance lock; (2) liveness/readiness split and the diagnostics read model; (3) boot audit events; (4) integrity checks with derived-index rebuild and source-of-truth quarantine; (5) policy kernel and vault phases; (6) immediate signal registration; (7) local identity initialization; (8) one pre-listen scheduler recovery scan with read-only backend restoration and worker-control rebuild; (9) one normal listener bind, ordinary service start, and ordered shutdown. Existing data roots pass through phase 2 initialization once; no legacy boot path is preserved.

## Testing Strategy / Acceptance Criteria

Mapped to the L0-L6 model in `docs/specs/20260529-test_strategy.md`:

- L0: repository checks that phases 1-8 remain in the specified order and the normal listener has one bind site after phase 8; schema-drift checks for the readiness read model and boot audit event shapes.
- L1: unit tests for phase outcome typing, criticality decisions, exactly-once listener bind, lock acquisition, beacon refresh, liveness probing, stale-break predicates, readiness computation, quarantine path selection, bounded reconnect deadline scheduling, and timeout CAS fencing.
- L2: contract tests that boot honors owning-spec behavior at the boundaries: unknown-required-feature config and records fail closed per the schema evolution spec; scheduler recovery is invoked exactly once before listener bind; awaiting leases are accepted only by the ordinary exact-next heartbeat path; vault-dependent operations return the typed locked error while vault state is `locked`.
- L3: retain one deterministic NanoCore kill/restart test that proves the same durable lease is armed before the replacement listener binds, the surviving worker reconnects through the ordinary heartbeat route, no replacement worker launches, and direct closeout completes through existing records.
- L4: not applicable until Web UI readiness surfaces exist; then degraded-reason display tests.
- L5: smoke test that a packaged build completes phase 8, then binds one normal listener, starts scheduler services, and records boot audit rows with boot id, layout version, and applied migrations.
- L6: story acceptance covering an operator restarting NanoCore mid-work with a locked vault: boot succeeds degraded, vault-dependent work fails typed, unlock restores readiness, and the audit trail explains the whole sequence.

Acceptance criteria: every phase failure mode above produces its typed diagnostic deterministically; no test can bind the normal listener twice or before the restart scan completes; no test can produce two live NanoCore processes on one data root; a crash at any point requires no manual repair before the next boot; readiness never reports `ready` while a critical subsystem has failed.

## Risks & Mitigations

- Risk: liveness probing wrongly declares a paused-but-alive holder dead and breaks its lock. Mitigation: only same-host lock records with a confirmed absent process id may be broken; live, remote, unreadable, or indeterminate holders fail boot closed rather than breaking the lock.
- Risk: automatic quarantine destroys operator confidence by recreating stores unexpectedly. Mitigation: quarantine preserves the original file, writes audit, and surfaces in readiness; nothing is deleted.
- Risk: readiness state discipline erodes as subsystems multiply. Mitigation: the orchestrator only starts registered subsystems; registration requires a state reporter, enforced at L0/L1.
- Risk: boot-time integrity checks slow startup on large data roots. Mitigation: exhaustive scans are excluded by contract; checks are per-database quick checks plus lazy verification, with async index rebuild.
- Risk: shutdown deadline races flush ordering. Mitigation: every flushed write is also crash-recoverable; the deadline is a bound, not a correctness edge.
- Risk: a surviving worker retries before the replacement listener is bound. Mitigation: the shim's existing bounded outage loop keeps the same child alive; phase 8 is a bounded local scan, and the ordinary listener is bound immediately afterward.

## Resolved Decisions

Previously open questions are resolved by accepted V1 defaults: the liveness beacon may carry an optional redacted network endpoint for remote operator diagnostics, but lock-break authority still depends on lease and liveness evidence rather than endpoint reachability alone; post-phase serving initialization performs bounded sample verification of knowledge indexes before listener bind and leaves exhaustive validation to repair workflows or first-query fallback.

The normal application listener binds exactly once after phase 8 completes the restart scan. `awaiting-reconnect` is lease-local scheduler state, not a boot readiness phase or deployment-wide admission gate.

## Deferred / Future Work

- Operator repair tooling for quarantined stores (inspect, salvage rows, re-import) beyond preserve-and-recreate.
- Multi-node boot coordination and lock semantics if the multi-node scheduler deferred by the durable scheduler spec ever lands.
- Rolling or zero-downtime restart designs.
- Web UI readiness and boot-history surfaces beyond the diagnostics read model named here.
- Backup/restore verification hooks at boot once the storage backup model exists.

## Links

- `docs/specs/20260703-durable_scheduler_design.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260703-schema_evolution_record_envelope.md`
- `docs/specs/20260628-nanocore_config_identity_contract.md`
- `docs/specs/20260629-openkit_policy_model.md`
- `docs/specs/20260703-policy_enforcement_mapping.md`
- `docs/specs/20260704-vault_backend_implementation.md`
- `docs/specs/20260703-knowledge_store_implementation.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`
- `docs/specs/20260529-test_strategy.md`
- `docs/core/storage.md`
- `docs/core/architecture.md`
