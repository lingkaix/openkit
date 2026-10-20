---
type: change-plan
status: in-progress
started: "2026-10-20"
branch: lane/rd-b-3a-journal
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

The implementation starts from the normal schema/test integration `e6c3d68586ba4f04cedc8170344be87075ede66c`, which includes the construction types and actual Core0014 schema `762ba87b51cf9a83c8159aa79bb866b3f9e65e81`. The later frozen provenance fixture `cc5565d943b25e0da510c32d95962faf94ec19f2` and storage export repair `ee448646662e8d01f165ad21f791b0ce8b234c9a` were normally integrated. The initial construction-only checkpoint remains historical evidence, not a claim that the current methods are placeholders.

The bounded implementation changes exactly five production files: `runtime/execution-journal.ts`, `runtime/nanohost-session-dispatch.ts`, `runtime/worker-image-settlements.ts`, `runtime/worker-environment-runtime-effects.ts` and only `prepareAndPublish` in `worker-environments/worker-environment-preparation.ts`. Paths are relative to `apps/nanocore/src/`. Types, frozen tests, storage, DDL, scheduler, Store and observation-owned paths are unchanged by this producer. Shared migration/layout projections remain with their assigned owners. The runtime guide is updated here; the application guide's replacement paragraph is relayed through its current owner rather than written concurrently.

The caller supplies explicit `actor` and `workId`; the latter is the actual publication Turn id. The native acquisition records exact candidate/input references, distinct invocation identity, target/carriage binding and original expiry before its command enters the queue. Its fixed allowance uses the existing fifteen-minute registry-acquisition ceiling from `image_acquisition.rs`, measured from Core admission rather than renewed at delivery. A process-local wake-up bounds the selected wait but is not native deadline carriage, remote-stop evidence or a new timer service. Delivery rechecks current authorization and original allowance. Lost carriage or expiry retains an unknown and exclusion; a late exact result commits its existing receipt with a separate linked local consumption, never rewriting that unknown or clearing its exclusion.

Next: publish the checked production candidate for an unchanged independent rerun. Three surrounding-path fixture failures require owner-assigned additive real-provenance/private-request-shape alignment; they are not silently edited or waived here. General Workspace execution, the engine/reconciler, authenticated native deadline carriage, span export and duration samples remain separate work. No boot/shutdown change, CI dispatch or main push is included.

## Verification And Closeout

The frozen native producer first failed on its committed-intent assertion against the actual migrated schema; the other five journal cases stopped at unavailable primitives and were implementation blockers, not five behavioral regressions. The first integrated implementation run passed all nine cases across the three unchanged frozen files, production typecheck, five-source-file Biome and NanoCore build. Exact typed round-trip, changed-input refusal, concurrent targets/revision, immutable nested unknown with linked inspection, fresh-process zero allowance, real actor/Turn intent-before-delivery and original receipt/control assertions are covered. The corrected exact-optional-property type error and initial formatting checks remain separate implementation feedback, not product RED.

A separate four-file surrounding-path probe observed 58 passes and three failures: one native settlement fixture lacks explicit actor/Turn provenance, and two adapter fixtures expect the previous exact private request shape. These files and their assertions/fault injection are untouched; their test owner must align them before broader qualification. This nine-case cut does not prove process-crash cohorts, all rollback boundaries, full remote-style absence proof, complete authenticated deadline carriage, exports or duration samples. Independent exact-candidate rerun and the coordinator's later CI/acceptance remain separate from this producer's focused evidence; no broader GREEN or landing is claimed.
