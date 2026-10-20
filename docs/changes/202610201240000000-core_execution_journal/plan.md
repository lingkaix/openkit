---
type: change-plan
status: in-progress
started: "2026-10-20"
branch: feat/core-execution-journal
---
# Core Execution Journal

This record tracks the first durable execution journal cut. The linked accepted owners remain authoritative; this record supplies no new design authority.

## Intent Revisions

### 2026-10-20 — Initial Direction

Implement the first bounded cut of row 3 in [Durable Execution And Control Store](../../specs/20261019-durable_execution_and_control_store.md): a persisted journal and invocation reader for the existing administrative preparation `image.acquire` path. Reuse its existing result receipt. Commit intent before queueing; commit the outcome, receipt and next local transition together. Do not switch ordinary Turn execution or implement a new request family, retry service, port, registry or proof ledger.

The effect boundary permits the agreed runtime files and this record. The storage owner first lands the product control-store cut, then authors the schema, schema export, storage guide and next Core migration from the manifest below. The independent test author owns the three assigned regression files. Publish exact types and construction without production behavior before those tests start. Shared storage and migration paths are not writable by this producer.

### 2026-10-20 — Approval Conditions

Before code changes, check that the representation permits per-step execution-target binding, multiple open steps in an execution, and nested child steps. These are representation constraints, not authorization to implement placement selection, fan-out scheduling or code-mode execution. Drop the database worker protocol and worker implementation from this cut unless the actual production path uses that worker. Later engine, signal, timer and deadline-carriage cuts need separate path approval.

### 2026-10-20 — Provenance And Neutrality Clarification

Approval adds the `prepareAndPublish` caller in `worker-environments/worker-environment-preparation.ts` for authenticated actor and publication Turn provenance, and a few owning-specification sentences for the three shapes and child uncertainty. This adds no new table, column, backend, replay consumer or execution gate. The total approved manifest is now 21 paths; the caller is this producer's single-writer path and the existing independent author keeps its assigned fixtures.

## Accepted Owners

- [Durable Execution And Control Store](../../specs/20261019-durable_execution_and_control_store.md) owns execution, steps, journal fields, deadline and receipt semantics.
- [Architecture](../../core/architecture.md) and [Compute And Harness Neutrality](../../decisions/20261020-compute_and_harness_neutrality.md) own transport-neutral placement.
- [Operational Telemetry](../../specs/20260731-operational_telemetry_standardization.md) owns export, duration sampling and Worker marker grammar.
- [NanoHost Runtime And Transport](../../specs/20260802-nanohost_runtime_and_transport.md) owns the current receiver's carriage and physical proof.
- [Storage](../../core/storage.md) and [Contract Evolution](../../core/contract-evolution.md) own retained authority, data continuity and extension handling.

## Representation Check Before Code Changes

1. **Per-step placement:** the step control carries a nullable `target` with `backendKind`, `targetId` and nullable `allocationRef`. It references existing selected authority, not a new target registry. The execution row has no backend, allocation or placement column. Local steps may have no target; the first producer records its existing selection without adding a placement decision.
2. **Concurrent open steps:** the step key is `(execution_id, step_id)`, with an independent per-execution ordinal and state. There is no unique-open-step constraint or singular current-step column. `readExecution` derives the current open-step set. An execution revision and the selected step's state guard local transitions; the revision does not identify the only permitted open step. The first producer still runs one step at a time.
3. **Nested steps:** nullable `parent_step_id` references a step in the same execution. Parent identity is immutable and is distinct from `inspected_step_id`. Children can carry the selected parent's deadline cap without changing the parent's outcome. A different execution links trace/span identity rather than reparenting it. This cut adds no nested-call producer or scheduler.

Stable `invocationId` is allocated once and is distinct from the fingerprint and trace identity. `definitionVersion` owns interpretation; exact version-qualified `inputRefs`/`outputRefs` can name a later consumer's immutable child-key mapping, complete replay fingerprint inputs and ordered delivery history without changing existing image identities or fingerprints. Actual delivery order, including reverse sibling completion, must be retained explicitly through those references by the first admitted replay consumer; the SQL admission ordinal is not that history. Control parent/cap stays separate from the trace parent, and parent success/replay cannot settle unknown children or renew their authority. No such consumer is implemented here.

These shapes have no conflict with the accepted neutrality direction. A backend-specific Epoch is evidence from that backend only; it is not required to represent another placement. Unknown receipt, absence or fence proof remains unknown and cannot authorize conflicting reuse.

## Approved First-Cut Paths

Runtime producer ownership under `apps/nanocore/`: `src/runtime/execution-step-journal.ts`, `src/runtime/execution-journal.ts`, `src/runtime/nanohost-session-dispatch.ts`, `src/runtime/worker-image-settlements.ts`, `src/runtime/worker-environment-runtime-effects.ts`, `src/runtime/README.md`, `README.md`, plus only `prepareAndPublish` in `src/worker-environments/worker-environment-preparation.ts`. The owning specification and this change record are the two repository documentation paths.

Storage ownership under `apps/nanocore/`: `src/storage/schema/execution-journal.ts`, `src/storage/schema/index.ts`, `src/storage/README.md`, and provisional `drizzle/core/0014_execution_journal.sql`, `drizzle/core/meta/0014_snapshot.json`, `drizzle/core/meta/_journal.json`. Independent fixtures are `src/runtime/execution-step-journal.test.ts`, `src/runtime/worker-image-settlements.test.ts`, `src/diagnostics/snapshot.test.ts`; storage coordinates `src/storage/migrate.test.ts` and `src/storage/layout-report.test.ts`. There are 21 total paths. No worker protocol, worker implementation or other fixture is included.

## Storage Handoff Manifest

The proposed next Core migration is `0014_execution_journal.sql`, contingent on the product cut landing with Core0013 and a fresh journal check. The storage owner writes `src/storage/schema/execution-journal.ts`, `src/storage/schema/index.ts`, `src/storage/README.md`, the SQL, its snapshot and the Core journal. No Workspace migration is included. Both tables are the accepted execution/step authority, not an additional trace or proof ledger.

| Table | Exact columns |
| --- | --- |
| `control_executions` | `id TEXT PRIMARY KEY`, `schema_version INTEGER NOT NULL`, `owner_json TEXT NOT NULL`, `work_id TEXT NOT NULL`, `definition_version TEXT NOT NULL`, `input_fingerprint TEXT NOT NULL`, `phase TEXT NOT NULL`, `revision INTEGER NOT NULL`, `terminal_cause TEXT NULL`, `exclusion_refs_json TEXT NOT NULL`, `span_json TEXT NOT NULL` |
| `control_execution_steps` | `execution_id TEXT NOT NULL`, `step_id TEXT NOT NULL`, `schema_version INTEGER NOT NULL`, `ordinal INTEGER NOT NULL`, `parent_step_id TEXT NULL`, `state TEXT NOT NULL`, `invocation_id TEXT NOT NULL`, `control_json TEXT NOT NULL`, `invocation_json TEXT NOT NULL`, `span_json TEXT NOT NULL`, `inspected_execution_id TEXT NULL`, `inspected_step_id TEXT NULL` |

The execution's phase is `open`, `closing` or `closed`; revision is a positive safe integer. Step state is `intent`, `completed`, `failed`, `unknown` or `cancelled`. Schema version is 1. Ordinals are positive safe integers. JSON columns must contain valid JSON with the required object/array shape. Required semantics fail closed; descriptive additive JSON remains ignorable. Times and typed int64 values use exact decimal storage encoding and decode to bigint, never floating-point timestamps or untyped string attributes.

Required keys are step primary key `(execution_id, step_id)`, unique `(execution_id, ordinal)`, and unique `invocation_id` in the owning database. Foreign keys bind `execution_id` to the execution, `(execution_id, parent_step_id)` to a prior step in that execution, and the nullable inspected pair to an existing step in the same database. The inspected pair is both null or both present. A step cannot parent or inspect itself. Parent identity cannot change. There is no uniqueness constraint on target, allocation, parent, or an intent state.

Required indexes are `(execution_id, state, ordinal)` for current/ended reads and `(inspected_execution_id, inspected_step_id, execution_id, ordinal)` for linked inspections. Ended-step UPDATE must be refused. Identity fields on an intent are immutable; only one transition to an ended outcome may add output references and final span facts. Execution identity is immutable; closed executions cannot reopen. Retention deletion stays with the existing work/evidence/hold owner; this cut performs no deletion or automatic fence release.

`control_json` stores the declared `ExecutionStepControl`, including per-step target. `invocation_json` stores original parent reference/cap, exact carriage operation/request identity, and original clock anchor/process witness. The clock witness is a local invocation fact, not a new registry or provider Epoch. `span_json` stores the lossless journal span model. Inspection references are separate from the original ended row. The root has no target and no mutable invocation expiry.

## Construction And Regression Seam

The existing reader gains `readInvocation(stepRef: ExecutionStepRef): Promise<ExecutionInvocation>` and `readExecution(executionRef: ExecutionJournalRef): Promise<ExecutionJournalExecution>`. Preserve `readEndedSteps` and `readLinkedInspections` exactly. Construction is `createExecutionStepJournalReader(db: CoreDb | WorkspaceDb, owner: WorkOwner): ExecutionStepJournalReader`. The first implementation supports Core/Server ownership only and refuses Workspace reads rather than returning empty history.

The release-authored version is `CORE_IMAGE_ACQUIRE_EXECUTION_DEFINITION = 'core-image-acquire/v1'`. The construction checkpoint exports the exact input/output types and fail-closed construction only. It runs no SQL, native effect, admission or timer, and is not journal qualification. The subsequent implementation uses the existing synchronous `controlStoreFor(sqlite).write` owner for the entire local tuple; no asynchronous callback, nested transaction, duplicate transaction wrapper or dormant worker command is added. Primitive journal writes require that owning transaction.

The test author starts from that checkpoint. Real behavioral RED requires the actual administrative producer and actual migrated schema, not a missing import/table or the construction placeholder's error. Reader round-trip and cold reopen, lost reply, original unknown immutability, linked late evidence, changed input, expired/restarted/uncertain clock refusal, atomic receipt rollback and an unaffected control are the first acceptance observations. Full A4/A6 ordinary-Turn, marker/export and remote-style proof acceptance stays in later cuts with real producer/consumer bindings; this cut does not claim it.

## Deadline And Proof Boundary

An invocation has its own non-hash identity, immutable input fingerprint, original parent link/cap, selected target and exact carriage identity. Its original E is committed before queue or slot wait. A stable input hash, parent date, heartbeat, updated timestamp or configured duration does not reconstruct E. R can only narrow live proved allowance; restart or clock uncertainty refuses execution without proof. Raw history and otherwise eligible result-only evidence remain readable.

Keep the actual receiver's capability/retry, retained receipt/consumption and effect-domain fence/absence references on existing step control. Unsupported evidence remains unknown. An empty list, kill acknowledgement, disconnect, expiry or cleanup success alone grants no replay or conflicting reattachment. Later bounded inspection links to the unknown original and never rewrites it. No remote adapter or provider-specific state is introduced.

## Working Checkpoint

Main `09c9a9696d9a884884cc2afe2881aff2778a99ea` was reconciled by normal merge on the new execution-journal branch. Inspection found no production caller of `getControlStoreWorkerClient`; only its own tests call it. Therefore both worker protocol/implementation paths are dropped. The subsequent caller and specification approvals make the current manifest 21 paths. The storage preview is commit `030a8bd7af4b7e063ef32ce13da97490f493ff93`; it remains a preview, not a landed dependency.

The existing runtime preparation input contains an authorization callback, candidate and image, but does not carry the authenticated actor or publication Turn identity. Those facts are available at `worker-environments/worker-environment-preparation.ts:prepareAndPublish`; the bounded caller-path handoff is now approved for that function only. Exact actor/work provenance must be passed from that owner; it must not be invented from a hash, telemetry or a fabricated system actor. The construction checkpoint does not wire that caller. Continue independent type/construction, schema coordination and test preparation before production wiring.

The storage owner confirmed no concurrent governing-specification or storage-guide writes during this checkpoint. The activity-view producer returned the NanoCore guide write lease after freezing its own different paragraph; preserve both guide changes through normal integration.

Next: publish the representation/table manifest, then the type/construction-only commit for the independent author. Await landed product storage and the generated journal schema before native production tests. Preserve setup failures as blockers, not behavioral RED. No production switch, CI dispatch, main push, shutdown fix or unrelated permission-ordering edit is part of this checkpoint.

## Verification And Closeout

No journal behavior is qualified yet. The construction checkpoint passed the NanoCore production typecheck with zero diagnostics, focused Biome over two TypeScript files, documentation model validation over 650 documents, lifecycle validation and generated-index verification. An initial single formatter failure was corrected; it was not behavioral RED. A construction-only probe observed four stable methods, no SQL connection access and explicit unsupported-scope refusal. Actual native dispatcher, settlement, runtime adapter and preparation caller bytes still match the reconciled main; no effect, timer or admission is wired to the new module. Record exact focused regression and build results after each runnable seam; retain the initial RED and later GREEN separately. Inspect actual diffs and independent evidence before completion. Exact-commit CI and coordinator acceptance/landing remain separate from implementation reporting.
