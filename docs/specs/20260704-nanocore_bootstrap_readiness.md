---
status: Accepted
implementation: Partial
kind: topology
aspect: architecture
---
# NanoCore Bootstrap, Readiness, And Recovery

This specification owns how one NanoCore process starts, reports readiness, and shuts down for one data root.

## Scope

This specification owns the ordered boot phases, which phases fail closed, and which phases degrade. It owns the one pre-listen restart scan, the single-instance data-root lock and its process lifetime, the liveness and readiness model, boot-time corruption behavior, ordered shutdown, and boot and shutdown audit.

Does not own:

- Scheduler recovery, execution-attempt adoption, epoch fencing, and untracked execution. The durable scheduler specification owns them. Boot only places the scan.
- The data-root tree, schema evolution, record envelopes, and fault-tolerance records. Those specifications own them. Boot verifies and applies failure scope.
- Config schema, identity, auth middleware, and the remote-auth credential ceremony. Those owners keep them. This specification owns only boot position.
- Vault backend design, secret storage, and unlock flows. The vault specification owns them. This specification owns only the readiness projection.
- App API route design, Web readiness screens, multi-node lock coordination, and rolling or zero-downtime restart. Those owners keep them.

Core: [`docs/core/architecture.md`](../core/architecture.md), [`docs/core/storage.md`](../core/storage.md), [`docs/core/evidence.md`](../core/evidence.md).

## Failure Scope And Engine Replacement
The storage-neutral [Fault Tolerance rule](../core/fault-tolerance.md) applies to the current implementation, not only to the future control store. Boot evaluates failure scope before phase criticality. Unreadable, corrupt, missing expected or unsupported Workspace authority quarantines that Workspace, preserves its bytes, and exposes an authorized owner/check diagnosis. Dependent operations return `recovery_required`; readiness reports the reason `storage.scope-quarantined`. It refuses that Workspace's dependent reads, writes, dispatch and timers without preventing the server or healthy Workspaces from booting. Never create an empty replacement or use a derived index as missing authority. An unreadable Workspace need not accept a write to record its quarantine; diagnostics can be derived from the failed validation and its trusted server registry identity.

Server-scoped authority failures, including users, server Knowledge, configuration, the global registry and Host/capacity state, fail whole-server boot. User-private failures block the affected user's dependencies unless server authority is also untrustworthy. A cross-scope ownership violation or unproved shared writer fence is evaluated at that actual shared boundary, not hidden by Workspace quarantine. Ownership of a retained record is decided by its own path, envelope and owner field. Identifiers inside a nested snapshot or event payload are content of the containing scope, so a mismatch is local lineage corruption requiring that scope's quarantine, unless the loader derives admitted or canonical state of another scope from that payload; in that case the payload is an ownership claim and global shared-boundary refusal applies. Derived-index failure degrades its dependent operations; it is not corruption of authority. These rules qualify every phase, readiness and integrity rule below.

A trusted `retired` Workspace registry entry restores non-admission and the existing closed mutation gate before scoped migrations, Store restoration, derived-index rebuild or recovery effects. Its retained data stays in place and cannot become admitted through fresh validation. Boot creates no retirement request, export, repair or replacement. Missing or unreadable retired Workspace authority does not prevent healthy siblings from serving. Shared containment and server-authority checks remain strict. [Retained retirement](20260715-multi_user_workspace_system.md#retained-retirement-of-a-quarantined-workspace) owns the command and registry meaning; boot only reconstructs its exclusion.

[Online Workspace snapshots](20260704-workspace_backup_export_import.md#online-snapshot-policy) distinguish a crashed AUTOMATIC unsealed capture from target placement or deletion. Boot abandons only that automatic capture's publication right and releases its pins through the existing capture owner. Manual capture retains explicit recovery actions. Restore/MOVE placement and deletion retain scoped quarantine, candidate/predecessor evidence and truthful uncertainty. This rule cannot clear an unrelated readiness failure or authorize execution replay.

The [2026-10-19 decision](../decisions/20261019-durable_execution_and_control_store.md) replaces the boot-only execution classifier with the same engine used for normal progress. That seam opens each Workspace database as its quarantine unit, rebuilds the process-local dispatch index with bounded handles, and starts the ordinary reconciler after the configured listeners bind. Phase 8 classification and the recovery-maintenance path remain the current boot classification. They are not a second recovery path.

## Contract / Expected Behavior
The generic-predicate and NanoHost-proof distinction in [Durable Scheduler Design](20260703-durable_scheduler_design.md#components) also governs restart here. Heartbeat sequence, process-key adoption, final-status carriage, and authoritative NanoHost connection requirements are NanoHost-profile mechanisms supplied through their existing owners. Generic boot retains the effect-free ownership scan, exclusion and fence preservation, one bind for each configured listener, and post-listen maintenance ordering without inspecting backend-specific proof fields or branching on backend family.

### Boot phases

NanoCore MUST register `SIGINT` and `SIGTERM` handlers immediately on process entry, before phase 1 begins. Registration is process-safety plumbing rather than a boot phase and does not change the eight-phase ordering. A received signal closes admission and initiates bounded shutdown when possible, but it is diagnostic input only and never proves that a remote worker stopped or authorizes cleanup.

Boot MUST execute the following phases in this order. A phase MUST NOT start before its predecessor reaches its defined outcome. Each phase returns one typed outcome: `ok`, `degraded(reasons)`, or `failed(diagnostic)`. The criticality rules decide whether `failed` aborts. Each phase records its outcome in the boot audit trail (see Boot And Shutdown Audit). A new subsystem MUST register a phase and a readiness state to exist. The ordered phase list and the diagnostics schema are that registration.

1. **Config load and validation.** NanoCore loads and validates server config per `docs/specs/20260628-nanocore_config_identity_contract.md`. Malformed config, config that fails schema validation, and config carrying an unknown required feature MUST fail boot closed with a typed diagnostic naming the file, the failure kind, and the unsupported feature identifier where applicable. Warnings-level diagnostics MAY be recorded without failing boot, but authority-bearing validation failures MUST NOT be downgraded to warnings.
2. **Data-root layout verification.** NanoCore verifies the `DATA_ROOT` ownership tree defined by `docs/specs/20260703-storage_layout_record_ownership.md`, creating missing directories that the layout spec defines as server-creatable. Boot MUST fail closed with a typed diagnostic on an ownership violation (a path owned by one scope appearing under another) and on a data root whose recorded layout version belongs to an incompatible layout. A data root with no layout marker is initialized as a new data root; a data root with a newer layout version than this build supports MUST NOT be modified.
3. **Single-instance lock.** NanoCore acquires one operating-system-backed exclusive lock for the data root before opening any authoritative database for write. Exactly one live NanoCore process MAY own one data root at a time; this protects the single-writer scheduler and file-backed append disciplines across all stores. A competing live holder MUST fail boot closed with a typed diagnostic naming the holder when available. The operating system MUST release ownership when the holder exits, including SIGKILL or a crash; stale metadata, a changed container hostname, a reused PID or a fresh heartbeat MUST NOT block the next acquisition. A missing or unsupported locking primitive fails boot closed. The holder metadata records process identity, boot id and a diagnostic heartbeat; it does not decide ownership. Replaced stale metadata remains in the existing boot lock-acquisition audit summary. The locked directory inode MUST remain in place while ownership is held so concurrent processes cannot lock different replacement directories. The liveness beacon MAY carry an optional redacted network endpoint. Instance ownership depends on kernel locking, never on endpoint reachability or holder metadata. [Process-lifetime locking](../decisions/20261016-data_root_lock_process_lifetime.md) records the correction.
4. **Storage migration.** SQLite migrations for each ownership-scope database run transactionally at boot, and each applied migration version MUST be durably recorded before it is treated as applied. A failed migration MUST roll back and fail closed in its owning scope with a typed diagnostic naming the migration id; Workspace migration failure quarantines that Workspace instead of refusing unrelated boot. File-backed record formats MUST NOT be bulk-rewritten at boot; file-backed evolution follows `docs/specs/20260703-schema_evolution_record_envelope.md`, and any explicit one-way major-version rewrite is a separate operator-driven migration, not a boot side effect. The owner-independent Workspace layout rewrite is invoked only by the thin dedicated stopped-process CLI defined by `docs/specs/20260715-multi_user_workspace_system.md`; that CLI is not a restore mode, reusable runner, or verification harness. The CLI may call the same integrity and index-rebuild functions used by normal boot directly while the process remains stopped, but it does not execute the boot phase runner or bind a listener. The next ordinary boot independently validates an accepted v2 layout, never invokes, resumes, repairs, or infers progress for the rewrite, and fails closed on its predecessor, mixed, or partially published layout. Migration failure diagnostics retain the initiating SQLite error code, migration id and one-based statement index when available; a failed rollback is secondary. Diagnostics MUST contain only bounded trusted identifiers and codes, never SQL text, parameters, private paths or arbitrary exception messages.

5. **Policy kernel load.** NanoCore loads the policy kernel per `docs/specs/20260629-openkit_policy_model.md` and `docs/specs/20260703-policy_enforcement_mapping.md`. Failure to load a usable policy kernel MUST fail boot closed: no policy means no authorization, and NanoCore MUST NOT serve product work under an absent or partial policy kernel.
6. **Vault backend availability.** NanoCore checks the vault backend per `docs/specs/20260704-vault_backend_implementation.md`. A locked or unavailable vault MUST NOT fail boot. Boot proceeds with vault subsystem state `locked`, and every vault-dependent operation MUST fail with a typed error naming the vault state until the vault is unlocked. Vault-independent work proceeds normally; this is the canonical degraded-readiness case.
7. **Local identity initialization.** In local mode, NanoCore ensures the implicit local user exists before scheduler recovery can resolve workspace-scoped owners. Server mode performs no synthetic-user write. Failure to establish the required local identity fails this critical phase closed.
8. **Restart ownership scan.** NanoCore constructs the durable worker-control gateway and backend runtime, then runs the scheduler restart scan defined by `docs/specs/20260703-durable_scheduler_design.md`. The scan classifies any already accepted final status for existing-owner closeout, transfers unrecoverable or sequence-zero-only attempts to their existing durable cleanup owner, and moves an eligible post-launch open attempt with adapter-proved heartbeat liveness and `lastWorkerSequence >= 1` to its one preserved adapter-owned `awaiting-reconnect` deadline. An effect-capable backend binding with no open/closing attempt and no safe resident owner is fenced as `cleanup-pending` without blocking the listener; it cannot be adopted as live work. This pre-listen phase performs only durable classification, compare-and-set fencing, read-only backend restoration, and attempt exclusion/backend-fence preservation. It MUST NOT await an effectful final-status closeout, `bridge.close`, `sandbox.delete`, another NanoHost effect, a worker, or the NanoHost transport that only the private NanoHost listener can admit; it does not bind a listener, create a recovery admission index, or start a recovery-serving subsystem. Failure to establish exact live ownership, install the cleanup fence, or preserve exclusion fails the owning scope closed. Quarantine an isolated Workspace while preserving its server-owned reservations; failure of a shared server fence fails the critical phase. Incomplete physical cleanup remains cleanup-owned and fenced for the ordinary post-listen service.

After phase 8 succeeds, server mode invokes the zero-user bootstrap hook owned by `docs/specs/20260704-remote_auth_credential_bootstrap.md`. The hook MUST run only after phase 4 authoritative integrity verification and migrations have succeeded and before either configured listener is admitted; failure to persist the bootstrap hash or complete its permitted secure delivery fails closed before listener admission. This spec owns that sequencing, while the remote-auth spec owns the zero-user predicate, credential generation, delivery, expiry, and consumption semantics.

After any required bootstrap hook succeeds, NanoCore starts the LLM gateway, constructs the normal application over the worker-control gateway prepared in phase 8, and binds each configured listener exactly once. The App listener and the optional private NanoHost listener are distinct. There is no temporary recovery listener. NanoCore then starts ordinary scheduler services, computes and publishes the initial readiness projection, and opens product-work admission when the computed state permits it. Phase 8 arms the adapter reconnect window for an eligible open attempt before either listener binds. The existing scheduler maintenance service serially drains phase-8 `cleanup-pending` or `cleanup-failed` ownership and any accepted-final-status closeout that may require NanoHost effects only after the private NanoHost listener can admit the one authoritative NanoHost connection. The drain reuses the existing attempt, backend adapter, cleanup, product-closeout, and NanoHost effect owners; it adds no durable coordinator, retry stage, further connection, further listener, route family, or effect replay. One process permits at most one such drain at a time. Failure leaves the exact attempt and backend boundary fenced for the same ordinary service or the next boot, and success releases exclusion only after definite non-acceptance or complete handoff plus exact cleanup/fence proof. A worker whose open attempt has adapter-owned `awaiting-reconnect` reaches the ordinary heartbeat route and may adopt only through the process-key, lineage, sequence, deadline, and attempt compare-and-set contract. The attempt keeps exclusion while waiting; it does not create a deployment-wide readiness gate. Timeout cleanup records adapter-owned `needs-evidence` and moves the same attempt to closing before physical effect; a cleanup failure remains fenced for the next boot. A newly accepted restart final status gets one asynchronous process-local closeout attempt; failure leaves the attempt `closing` for the same ordinary maintenance path rather than creating durable retry stages.

Liveness HTTP serving begins only after phase 8 on the App listener. The private NanoHost listener is a separate bind for the authoritative NanoHost connection. The App listener returns 404 for a private NanoHost transport or family path. The NanoHost listener returns 404 for any other path. There is no temporary recovery listener, special recovery route family, or listener replacement.

### Liveness versus readiness

Liveness and readiness are distinct signals:

- **Liveness** means the process has bound the App listener and can answer that listener's permitted route set. A live process MAY be entirely unready.
- **Readiness** means NanoCore is accepting product work. Readiness is computed from per-subsystem states and MUST NOT be a single boolean in storage; it is always derived.

Per-subsystem readiness states cover at minimum: config, storage, policy kernel, vault, scheduler, LLM gateway (and provider reachability beneath it), and knowledge index. Each subsystem is in exactly one state:

- `ready`: the subsystem operates within its contract.
- `degraded`: the subsystem operates with a typed, named reduction (vault `locked`, a provider unreachable, or a derived-index rebuild that is still pending or has failed).
- `failed`: the subsystem cannot operate.

Rules:

- Server config, server-authority storage and the policy kernel are critical subsystems. Their failure at boot means boot failure; later failure stops dependent server admission. Workspace storage failure instead removes that Workspace from admission and reports its quarantine without dropping readiness for healthy Workspaces.
- Non-critical subsystems in `degraded` or `failed` produce degraded overall readiness with typed reasons, never silent acceptance. Every degraded state MUST carry a machine-readable reason and the operations it blocks.
- The diagnostics schema owns the closed subsystem slots and the states used below. Readiness is projected as an App API diagnostics read model per `docs/core/architecture.md` governed-API rules. The read model MUST expose per-subsystem state, typed reasons, and the boot id.
- Readiness summaries are derived records under `docs/specs/20260703-storage_layout_record_ownership.md` and MUST be rebuildable; they are never source of truth.
- Phase 8 is not live because the listener has not bound. An ownership-scan failure is classified by owning scope: quarantine an isolated Workspace; refuse boot when server ownership or shared fencing cannot be established.
- An open attempt with adapter-owned `awaiting-reconnect` is ordinary durable execution coordination after post-phase serving begins. It retains exclusion and blocks reuse of its session, but it does not by itself close global product admission or stop unrelated scheduler work.
- Boot MUST NOT create a settlement record, recovery coordinator, duplicate domain workflow, transcript import, workspace manifest, review state, turn state, or cleanup state. Restart closeout calls the existing owners directly.

### Process Diagnostics

Operational process observations accompany the existing boot/readiness read model after deployment-admin authorization. They describe only the sampled NanoCore process, reset with its lifetime, and are not durable state, host-wide capacity or real Worker readiness. `docs/specs/20260731-operational_telemetry_standardization.md` owns the target operational sample shape and optional instrumentation. Its failure cannot change boot readiness or product outcomes.

An explicit pre-stable deployment reset follows [Release Management](20260829-release_management.md#pre-stable-deployment-reset-and-protected-accounts) before ordinary boot. Startup failure never grants reset authority. After the operator completes the authorized reset, normal boot validates the current Data Root without fabricating predecessor integrity or recovery evidence. The pre-`v0.1.0` scope follows [Pre-Stable Data Continuity](../decisions/20261014-pre_stable_data_continuity.md).

### Boot-time corruption handling

Integrity verification runs during phases 2 and 4 and during post-phase serving initialization as appropriate to each store. Integrity checks are per-database quick checks. They are not an exhaustive scan. The rules:

- **Derived SQLite indexes** (search tables, read models, readiness summaries, knowledge indexes) that fail integrity checks MUST be rebuilt automatically from their file-backed source of truth or authoritative ledgers, per the rebuildability invariant in `docs/core/storage.md`. Rebuild MAY complete asynchronously after boot; while rebuilding, the owning subsystem reports `degraded` with reason `index-rebuilding`.
- **File-backed Workspace index sets** are verified at boot before listener bind and rebuilt when the set is missing, unreadable, structurally invalid, or incompatible with the current index format. This check does not establish source-content freshness; index-content readers rebuild from canonical sources before use. A boot rebuild that cannot complete reports the dependent index unavailable with a typed diagnostic; intact canonical authority and unrelated Workspaces remain usable.
- **Authoritative SQLite stores** (scheduler coordination, audit, idempotency and other assigned families) that fail integrity checks MUST fail their owning scope closed. The original database MUST remain unchanged at its canonical path. Boot MUST NOT move it, delete it, repair it in place, or create or migrate an empty replacement. A Workspace failure quarantines that Workspace and preserves its physical fences. A server-authority failure fails the critical phase before product identity initialization, bootstrap credential issuance, product admission or listener binding.
- **File-backed records** are not scanned exhaustively at boot. A file-backed record read during boot that carries an unknown required feature or unknown canonical record family MUST fail closed per `docs/specs/20260703-schema_evolution_record_envelope.md`; Workspace-owned failure quarantines its Workspace even during a critical phase; server-authority failure fails boot, and a derived or optional dependency degrades only its dependent operations with a typed reason.
- An authoritative integrity failure MUST be emitted through the typed critical-phase process diagnostic. Durable audit is best effort only when a trustworthy authoritative audit store remains writable; failure to write audit evidence MUST NOT authorize mutation of the corrupt store or admission in its refused scope.
- When the storage boot phase completes, every derived-index rebuild of that boot MUST surface in the readiness read model and the boot audit trail; recovery MUST NOT be invisible. Each completed boot rebuild MUST remain visible as an informational reason with no operation blocks in the readiness read model and as an event in the boot audit trail. Completion alone MUST NOT degrade readiness or clear another condition's degradation or failure. A later failed derived-index rebuild records its affected scope and MUST NOT erase earlier completed rebuild observations. Omitting an earlier observation is not permission to widen refusal.

### Ordered shutdown

On an orderly shutdown request, NanoCore SHOULD execute, in order:

1. Stop admissions: overall readiness drops, new product work is refused with a typed shutting-down error, liveness continues.
2. Scheduler wind-down: the scheduler handles open or closing execution attempts at safe points per its own spec; this spec does not define execution-attempt semantics.
3. Flush pending durable writes: buffered appends, pending audit rows, and readiness projections are flushed.
4. Release the instance lock as the final step.

Crash-only design remains the baseline: every shutdown step MUST be safe to skip, because boot recovery (kernel-released instance ownership, scheduler restart recovery, and derived-index rebuild) handles the skipped case. No durable state may exist whose correctness depends on shutdown having run. Shutdown SHOULD be bounded by a deadline after which the process exits regardless; exceeding the deadline is a crash by construction and is recorded as such on the next boot.

### Boot and shutdown audit

Boot and shutdown emit audit events per `docs/specs/20260703-audit_usage_evidence_records.md` homing rules (server control-plane scope). At minimum:

- Boot start and boot outcome events carrying: boot id (unique per process run), data-root layout version, migration versions applied this boot, lock acquisition (including any stale-lock break with the dead holder's identity), derived-index rebuild events, per-subsystem readiness outcome with degraded reasons, and the typed diagnostic on boot failure.
- Shutdown events carrying: boot id, shutdown reason, steps completed, and whether the deadline forced exit.
- Boot audit events MUST be written even when boot fails, as far as storage availability allows; a boot that fails before storage is writable emits its diagnostic through process output and the failure is reconstructed on the next successful boot from the lockfile and layout evidence.

The boot-start, boot-outcome and shutdown AuditEvents derive `aud` UUIDv5 from the recorded process-run `bootId` and fixed phase. Their exact JSON names are `[bootId, "start"]`, `[bootId, "outcome"]` and `[bootId, "shutdown"]`, respectively. [Protocol Identifiers And Enums](20261021-protocol_identifiers_and_enums.md#ids) owns the namespace and canonical bytes. Deriving the name again for the same recorded run and phase produces the same identifier. This does not authorize another publication or change duplicate-write handling. A retained event keeps its original content and timestamps. A new boot keeps its distinct recorded run identity. Existing triggers, phase order, store-availability limits, retention and failure reconstruction remain unchanged ([accepted allocation decision](../decisions/20261016-identifier_derivation_and_import_allocations.md)). Acceptance requires stable same-run/phase identity across reopen, distinct phases, and no repeated phase or external effect from audit publication.

### Persistent Pause Of Agent Work

Boot MUST read the persisted Server "pause agent work" setting before scheduling. While set, admission and dispatch MUST refuse new agent execution, including queued undispatched work and remote-client Gateway requests. Authentication, reads, answers, cancellation, revocation, configuration, Core-local Turns, recovery and unpause remain available. Running Turns continue unless an administrator also cancels them. This setting is distinct from shutdown admission; current administrators may set or clear it, and either change raises a sensitive-event notice. [Runtime Security](20261109-runtime_security.md) Pause owns the exact scope.

## Acceptance

The deterministic L3 kill/restart case proves that the same durable open attempt has its adapter-owned reconnect window armed before the replacement listeners bind. The surviving worker reconnects through the ordinary heartbeat route. No replacement worker launches. Effectful cleanup begins only after the private NanoHost listener admits the authoritative NanoHost connection. Cleanup and direct closeout complete through existing records.

The L4 check shows degraded reasons on the existing Web readiness surface.

The L5 packaged-build check completes phase 8, binds each configured listener once, starts scheduler services, and records a boot audit with the boot id, the layout version, and the applied migrations. App-image smoke checks the packaged locking utility.

The L6 case restarts mid-work with a locked vault. NanoCore boots in the degraded state. Vault-dependent work fails with the typed vault error. Unlock restores readiness. The audit trail explains that sequence.

Boot loads the persistent agent-work pause before scheduling. New execution and delayed dispatch recheck the installed setting; existing execution retains its admission.

## Implementation

- `apps/nanocore/src/bootstrap/`
- `apps/nanocore/src/`
- `apps/nanocore/src/runtime/`
- `packages/app-api-schemas/`

## Implementation Gaps

- The control-store engine replaces the boot-only execution classifier - On main, phase 8 classification and the maintenance path still run beside the native execution pieces - #755
- A later failed derived-index rebuild does not erase earlier completed rebuild observations - On main, a degraded or failed outcome replaces that subsystem's reason list and can omit an earlier informational rebuild - #755
- A boot that fails before storage is writable is reconstructed on the next successful boot - On main, audit is best effort after Core storage is writable, and the next boot does not reconstruct that earlier failure - #755

## Decisions

- [Process-lifetime locking](../decisions/20261016-data_root_lock_process_lifetime.md)
- [Durable execution and the control store](../decisions/20261019-durable_execution_and_control_store.md)
- [Pre-stable data continuity](../decisions/20261014-pre_stable_data_continuity.md)
- [Identifier derivation](../decisions/20261016-identifier_derivation_and_import_allocations.md)
