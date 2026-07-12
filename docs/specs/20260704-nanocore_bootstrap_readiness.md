# NanoCore Bootstrap, Readiness, And Recovery

Status: Accepted
Implementation: Implemented

## Owns

- The ordered NanoCore boot phase contract, including which phases fail closed and which degrade.
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

The clean target is that every boot either fails closed with a typed diagnostic, or reaches a readiness signal whose degraded components are individually named with typed reasons. No phase silently absorbs a failure that would change authorization, storage ownership, or single-writer assumptions.

## Goals

- Fix one boot phase order so every subsystem can rely on its predecessors being verified.
- Make boot failure modes typed and diagnosable instead of implicit process exit.
- Protect the single-writer scheduler and storage assumptions with an exclusive instance lock.
- Separate "the process answers HTTP" from "the process accepts product work".
- Recover derived indexes automatically and quarantine unrecoverable source-of-truth stores instead of booting on corrupt state.
- Keep shutdown a best-effort optimization over crash-only recovery, never a correctness requirement.
- Make every boot and shutdown auditable.

## Non-goals

- Do not restate scheduler recovery semantics, storage layout trees, or schema evolution rules; reference the owning specs.
- Do not define config schema fields or validation rules beyond the boot behavior on their outcomes.
- Do not design multi-node coordination, rolling upgrades, or zero-downtime restart.
- Do not define exact HTTP routes, response shapes, or Web UI readiness screens.

## Background

The current implementation boots in `apps/nanocore/src/index.ts` as a linear script: resolve data root, open the server-scope `server/db/core.sqlite`, load runtime config (logging diagnostics as warnings), apply migrations, and serve. There is no instance lock, no readiness model, no integrity checking, no policy or vault phase, and no shutdown handling. A second process pointed at the same data root would silently violate the single-writer assumptions that `docs/specs/20260703-durable_scheduler_design.md` and `docs/specs/20260703-storage_layout_record_ownership.md` depend on.

The durable scheduler spec defines restart recovery as a scan-and-adopt procedure but does not say when it runs relative to config, storage, policy, or vault availability. The storage layout spec defines the ownership tree and requires derived indexes to be rebuildable, but nothing currently verifies the tree or rebuilds anything at boot. This spec closes that gap by owning the ordering and the boot-time recovery behavior.

## Decision

NanoCore boots through eight strictly ordered phases. Critical phases (config, data-root layout, instance lock, migrations, policy kernel) fail closed with typed diagnostics. The vault backend and other non-critical subsystems degrade instead of failing boot. Readiness is a computed projection over per-subsystem states, distinct from liveness. Boot-time corruption recovery rebuilds derived indexes automatically and quarantines corrupt SQLite source-of-truth stores. Shutdown is ordered but every step is skippable because boot recovery handles the crash case. Boot and shutdown emit audit events.

## Contract / Expected Behavior

### Boot phases

Boot MUST execute the following phases in this order. A phase MUST NOT start before its predecessor reaches its defined outcome. Each phase records its outcome in the boot audit trail (see Boot And Shutdown Audit).

1. **Config load and validation.** NanoCore loads and validates server config per `docs/specs/20260628-nanocore_config_identity_contract.md`. Malformed config, config that fails schema validation, and config carrying an unknown required feature MUST fail boot closed with a typed diagnostic naming the file, the failure kind, and the unsupported feature identifier where applicable. Warnings-level diagnostics MAY be recorded without failing boot, but authority-bearing validation failures MUST NOT be downgraded to warnings.
2. **Data-root layout verification.** NanoCore verifies the `DATA_ROOT` ownership tree defined by `docs/specs/20260703-storage_layout_record_ownership.md`, creating missing directories that the layout spec defines as server-creatable. Boot MUST fail closed with a typed diagnostic on an ownership violation (a path owned by one scope appearing under another) and on a data root whose recorded layout version belongs to an incompatible layout. A data root with no layout marker is initialized as a new data root; a data root with a newer layout version than this build supports MUST NOT be modified.
3. **Single-instance lock.** NanoCore acquires an exclusive lockfile in the data root before opening any database for write. Exactly one NanoCore process MAY own one data root at a time; this protects the single-writer scheduler and the storage single-writer append disciplines. The lockfile MUST record the holder's process identity, boot id, and a liveness beacon. An existing local lock MUST be broken when liveness probing confirms the recorded holder process is dead, including the normal fast-restart case where the previous heartbeat is still fresh. A lock whose holder is alive, remote, unreadable, or whose liveness is indeterminate MUST fail boot closed with a typed diagnostic naming the holder when available. Lock breaking MUST be recorded in the boot audit trail.
4. **Storage migration.** SQLite migrations for each ownership-scope database run transactionally at boot, and each applied migration version MUST be durably recorded before it is treated as applied. A failed migration MUST roll back and fail boot closed with a typed diagnostic naming the migration id. File-backed record formats MUST NOT be bulk-rewritten at boot; file-backed evolution follows `docs/specs/20260703-schema_evolution_record_envelope.md`, and any explicit one-way major-version rewrite is a separate operator-driven migration, not a boot side effect.
5. **Policy kernel load.** NanoCore loads the policy kernel per `docs/specs/20260629-openkit_policy_model.md` and `docs/specs/20260703-policy_enforcement_mapping.md`. Failure to load a usable policy kernel MUST fail boot closed: no policy means no authorization, and NanoCore MUST NOT serve product work under an absent or partial policy kernel.
6. **Vault backend availability.** NanoCore checks the vault backend per `docs/specs/20260704-vault_backend_implementation.md`. A locked or unavailable vault MUST NOT fail boot. Boot proceeds with vault subsystem state `locked`, and every vault-dependent operation MUST fail with a typed error naming the vault state until the vault is unlocked. Vault-independent work proceeds normally; this is the canonical degraded-readiness case.
7. **Subsystem starts.** With the kernel foundations verified, NanoCore starts product subsystems: the LLM gateway; the scheduler restart-recovery scan defined by `docs/specs/20260703-durable_scheduler_design.md` (epoch mint, lease scan, re-adoption — that spec owns the semantics; boot only guarantees it runs after storage and policy are trustworthy); the worker-control gateway rebind of token bindings to durable lease records; and knowledge store index verification per `docs/specs/20260703-knowledge_store_implementation.md`. Subsystem start failures set the subsystem's readiness state (see below) and are fatal only for critical subsystems.
8. **Readiness signal.** NanoCore computes and publishes the initial readiness projection. Product-work admission MUST NOT begin before this phase.

Liveness HTTP serving MAY begin before phase 8 so that diagnostics and readiness are observable during boot, but no route that admits product work may act before readiness exists.

### Liveness versus readiness

Liveness and readiness are distinct signals:

- **Liveness** means the process is running and serves HTTP. A live process MAY be entirely unready.
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

### Boot-time corruption recovery

Integrity verification runs during phases 2, 4, and 7 as appropriate to each store. The rules:

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

Boot is one explicit orchestrator that replaces the current linear script: an ordered list of phase executors, each returning a typed outcome (`ok`, `degraded(reasons)`, `failed(diagnostic)`), with the criticality table from this contract deciding whether `failed` aborts. The orchestrator owns the boot id, the audit emission, and the readiness state store that subsystems update after boot through the same typed states. The instance lock is a lockfile plus periodic beacon refresh; liveness probing checks the recorded process identity before breaking a local dead-holder lock. The heartbeat remains diagnostic evidence for operators and audit, but it is not allowed to block a fast restart after the recorded local process is confirmed absent. The readiness read model is a derived projection over the in-memory subsystem states, persisted only as a rebuildable summary. Shutdown reuses the phase list in reverse where applicable, under a single deadline timer.

## Current Implementation Projection

This contract is implemented for V1. `AppDiagnosticsResponseSchema` in `@openkit/app-api-schemas` now includes a strict `boot` readiness projection with a process boot id, overall readiness, product-work admission flag, and typed subsystem states for config, storage, policy, vault, scheduler, LLM gateway, and knowledge index. `apps/nanocore/src/bootstrap/readiness.ts` computes the first process-local readiness snapshot: config, storage, and policy failures stop product-work admission and set overall readiness to `failed`, while non-critical degraded or failed subsystems set overall readiness to `degraded` without closing product admission for unrelated work. `apps/nanocore/src/bootstrap/phases.ts` implements the first boot phase runner: phases run in order, thrown phase errors become typed failed outcomes, critical failed outcomes stop later phases, the runner derives the initial readiness snapshot from the phase outcomes, and fatal process exits now include the specific failed critical phase and message in process logs. `apps/nanocore/src/bootstrap/policy.ts` loads the first boot policy kernel, runs baseline allow and deny self-checks against `@openkit/policy-kernel`, and fails the policy subsystem if the kernel is not usable. `apps/nanocore/src/app.ts` exposes the snapshot through the deployment-admin diagnostics surface and rejects workspace mutations, OpenAI-compatible chat and Responses Gateway calls, Quick Chat, and turn-start admission with `product_work_unavailable` when the boot snapshot closes product admission, while authorized diagnostics and permitted read-only routes remain available.

`apps/nanocore/src/bootstrap/lock.ts` implements the first data-root lock slice. `apps/nanocore/src/index.ts` creates the boot readiness snapshot, acquires `server/runtime/nanocore.lock` before opening the server SQLite database for write, records holder process metadata and a heartbeat timestamp, passes the same boot id into diagnostics, and releases the lock on orderly `SIGINT` / `SIGTERM` shutdown. A second process aimed at the same data root fails closed while the holder is live, remote, unreadable, or liveness is indeterminate. A local lock is broken immediately when the recorded process id is confirmed absent, including fast restarts where the previous heartbeat is still fresh.

`apps/nanocore/src/index.ts` now routes the current startup path through the phase runner for config template surface preparation, runtime config load and mode resolution, data-root layout verification, instance lock acquisition, server SQLite migration, policy kernel load, vault availability projection, local identity initialization, and scheduler restart recovery before creating the app and serving HTTP. `apps/nanocore/src/storage/fs-layout.ts` exposes `ensureConfigTemplateSurface` so the config phase can prepare `DATA_ROOT/config`, `providers`, and `agents` templates without writing the storage layout marker or running storage ownership verification before config validation. `apps/nanocore/src/bootstrap/vault.ts` projects the configured vault backend state honestly: a locked backend reports `degraded` with `vault.locked` and blocks `vault.read`, `vault.use`, and `secret.inject`, while product-work admission remains open for unrelated work. `apps/nanocore/src/bootstrap/audit.ts` records durable server-scope boot lifecycle rows and matching server-owned general `AuditEvent` rows: a boot start row after migrations make storage writable with data-root layout version, lock acquisition, stale-break summary, migration ids, storage recovery events, and index rebuild events; a boot outcome row after phase execution completes; and an orderly shutdown row on `SIGINT` / `SIGTERM` after HTTP close and before data-root lock release. `apps/nanocore/src/bootstrap/shutdown.ts` provides the first bounded shutdown deadline helper, and `apps/nanocore/src/bootstrap/readiness.ts` provides the shutdown readiness projection. On `SIGINT` / `SIGTERM`, NanoCore first closes product-work admission with `shutdown.in_progress`, stops process-local scheduler and OpenShell polling services, then waits for HTTP close, records shutdown audit, and releases the data-root lock; if the deadline fires first, NanoCore records the already-completed stop hooks plus `shutdown.deadline`, records `deadlineForcedExit: true`, releases the lock, and exits with a forced shutdown code. `apps/nanocore/src/storage/fs-layout.ts` creates parts of the target tree, including the server-owned vault directory, writes a server-owned data-root layout marker that fails closed on unsupported versions, fails closed on known legacy ownership paths, and verifies canonical SQLite database filename ownership for `core.sqlite`, `user.sqlite`, and `workspace.sqlite`. `apps/nanocore/src/storage/db.ts` runs boot-time `PRAGMA quick_check` recovery for the server-scope `server/db/core.sqlite` source-of-truth store and for existing user- and workspace-scope SQLite stores. When a check fails, NanoCore preserves the original file under the owning scope's `quarantine/` directory, records the original path, quarantine path, SHA-256 digest, scope, and failure detail in boot start audit JSON, opens a fresh database, applies migrations, and reports storage readiness as `degraded` with `storage.quarantined`. `apps/nanocore/src/storage/layout-report.ts` lists quarantined server/user/workspace storage files for operator inspection without mutating or reading their contents. `apps/nanocore/src/storage/index-rebuild.ts` rebuilds `indexes/search.json` at boot for existing workspace directories that have a canonical `workspace.json` projection, records rebuild results in boot start audit JSON, and reports storage readiness as `degraded` with `storage.index-rebuilt` when rebuilds occurred without quarantine. `apps/nanocore/src/runtime/scheduler-restart-recovery.ts` mints the process scheduler epoch during the scheduler boot phase, requeues pre-launch leases, adopts live leases with valid heartbeat deadlines, and marks downtime-expired leases stale with orphan-worker evidence according to the durable scheduler spec. Vault-backed provider credential operations preserve typed locked-vault failures through the audited provider resolver and public gateway error envelope, and vault-backed host Git push records `auth-failed` without invoking the child process when gateway-only credential material cannot be resolved. Shutdown correctness remains crash-first: request admission stop, service stop hooks, bounded HTTP close, shutdown audit, and lock release are best-effort steps over boot-time recovery rather than required durability barriers.

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

## Rollout / Migration Plan

This is new machinery replacing the linear boot script; per the internal development compatibility rule there is no dual path. Rollout order: (1) boot orchestrator with typed phase outcomes wrapping the existing config/layout/migration steps, plus the instance lock; (2) liveness/readiness split and the diagnostics read model; (3) boot audit events; (4) integrity checks with derived-index rebuild and source-of-truth quarantine; (5) policy kernel and vault phases as those subsystems land; (6) scheduler recovery and worker-control rebind hooks when the durable scheduler ships; (7) ordered shutdown. Existing data roots pass through phase 2 initialization once (layout marker written); no legacy boot path is preserved.

## Testing Strategy / Acceptance Criteria

Mapped to the L0-L6 model in `docs/specs/20260529-test_strategy.md`:

- L0: repository checks that the phase order in code matches this spec's ordering table; schema-drift checks for the readiness read model and boot audit event shapes.
- L1: unit tests for phase outcome typing and criticality decisions; lock acquisition, beacon refresh, liveness probing, and stale-break predicates; readiness computation from every subsystem state combination; quarantine path selection and retention naming.
- L2: contract tests that boot honors owning-spec behavior at the boundaries: unknown-required-feature config and records fail closed per the schema evolution spec; scheduler recovery is invoked exactly once, after storage and policy phases; vault-dependent operations return the typed locked error while vault state is `locked`.
- L3: NanoCore black-box tests: boot on empty, healthy, and corrupted data roots (corrupt derived index rebuilds and reports `index-rebuilding`; corrupt scheduler database is quarantined with audit and recreated); second-process boot against a held lock fails typed; kill-and-restart breaks the stale lock only after probe; boot with malformed config, incompatible layout version, and failing migration each produce the named typed diagnostic and no partial writes; readiness endpoint reflects vault locked/unlocked transitions; ordered shutdown releases the lock last, and SIGKILL at every shutdown step still yields a clean next boot.
- L4: not applicable until Web UI readiness surfaces exist; then degraded-reason display tests.
- L5: smoke test that a packaged build boots to a readiness signal on a fresh data root, and that boot audit rows exist with boot id, layout version, and applied migrations.
- L6: story acceptance covering an operator restarting NanoCore mid-work with a locked vault: boot succeeds degraded, vault-dependent work fails typed, unlock restores readiness, and the audit trail explains the whole sequence.

Acceptance criteria: every phase failure mode above produces its typed diagnostic deterministically; no test can produce two live NanoCore processes on one data root; a crash at any point requires no manual repair before the next boot; readiness never reports `ready` while a critical subsystem is not `ready`.

## Risks & Mitigations

- Risk: liveness probing wrongly declares a paused-but-alive holder dead and breaks its lock. Mitigation: only same-host lock records with a confirmed absent process id may be broken; live, remote, unreadable, or indeterminate holders fail boot closed rather than breaking the lock.
- Risk: automatic quarantine destroys operator confidence by recreating stores unexpectedly. Mitigation: quarantine preserves the original file, writes audit, and surfaces in readiness; nothing is deleted.
- Risk: readiness state discipline erodes as subsystems multiply. Mitigation: the orchestrator only starts registered subsystems; registration requires a state reporter, enforced at L0/L1.
- Risk: boot-time integrity checks slow startup on large data roots. Mitigation: exhaustive scans are excluded by contract; checks are per-database quick checks plus lazy verification, with async index rebuild.
- Risk: shutdown deadline races flush ordering. Mitigation: every flushed write is also crash-recoverable; the deadline is a bound, not a correctness edge.

## Resolved Decisions

Previously open questions are resolved by accepted V1 defaults: the liveness beacon may carry an optional redacted network endpoint for remote operator diagnostics, but lock-break authority still depends on lease and liveness evidence rather than endpoint reachability alone; phase 7 performs bounded sample verification of knowledge indexes during boot and leaves exhaustive validation to repair workflows or first-query fallback.

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
