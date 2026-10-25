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

The independent fixture author published `eefcccfc311ece59fc96657857ff9bd224bd88f8`, adding real provenance and exact private-request expectations in the two assigned surrounding fixtures while preserving their assertions and fault injection. Normal integration then merged main `6c98471cb52f1b2c70805abc3a241568bbf1c51d`. Neither merge conflicted; all five production files remain byte-identical to the original implementation `7edcd6e3ca4663b5d193271a531525422deac9f0`. The three frozen fixture files remain unchanged.

Next: rerun the nine frozen cases, the independent author's complete 56-case set, the related runtime set and focused static/build checks on the final integrated commit, then publish it for coordinator CI. The application guide paragraph remains an owner relay. General Workspace execution, the engine/reconciler, authenticated native deadline carriage, span export and duration samples remain separate work. No boot/shutdown change, CI dispatch or main push is included.

## Verification And Closeout

The frozen native producer first failed on its committed-intent assertion against the actual migrated schema; the other five journal cases stopped at unavailable primitives and were implementation blockers, not five behavioral regressions. The first integrated implementation run passed all nine cases across the three unchanged frozen files, production typecheck, five-source-file Biome and NanoCore build. Exact typed round-trip, changed-input refusal, concurrent targets/revision, immutable nested unknown with linked inspection, fresh-process zero allowance, real actor/Turn intent-before-delivery and original receipt/control assertions are covered. The corrected exact-optional-property type error and initial formatting checks remain separate implementation feedback, not product RED.

The initial four-file surrounding-path probe observed 58 passes and three fixture failures: one lacked explicit actor/Turn provenance, and two expected the previous exact private request shape. The independent author corrected only those assigned fixtures and reported 56 passes across five complete files, including all nine frozen cases. Inspection confirms recorded Users and publication Turns, exact callback identity, unchanged wire expectations and preserved fault injection; this report does not replace an integrated rerun. The expanded five-test-root typecheck retains inherited diagnostics; production plus the original three frozen roots was separately clean. Preserve the full diagnostic result and compare inherited diagnostics rather than adding suppressions or claiming all test types are clean.

## CI Forward Correction

Candidate `726ed686dd21b0c027a9ad34125d1043277958c8` passed the complete local 9-case, 56-case and 61-case runs but failed CI `39457733945`, including NanoCore shard job `118749564940`. A complete four-file local reproduction observed 202 passes and seven failures: two stale Core migration-list expectations and five image-settlement connection failures in restart-recovery cases. The expectation correction is mechanical: append Core0014 to the exact SQL-file and applied-ledger lists, without weakening their equality assertions.

The owning ControlStore can select an existing writer on a different connection to the same Core file. Image settlement now binds both SQLite and Drizzle to that callback connection before its guarded transaction body. The connection-identity check remains and also requires an active transaction; receipt reads, insertion, journal settlement and final verification all use that one connection. No sibling-handle write, nested transaction, recovery-test edit, test-helper bypass or frozen-assertion change is used. The runtime guide records this constraint. Next: normally merge current main, verify the bundle and rerun focused checks on the exact replacement candidate; CI dispatch and landing stay with the coordinator.

## Host Producer Fixture Alignment

Candidate `d775e5c45c92d359b59d95ad83915739eca45b5b` passed 279 cases across eleven complete local files but failed CI `39475352335`, job `118810228834`, in the Host producer pinning fixture outside that set. Its three direct `prepareImage` calls still omitted the accepted top-level `actor` and `workId`, so real dispatch correctly refused the undefined actor. This is stale fixture input against the accepted administrative producer shape, not a reason to loosen the schema or infer identity. The focused reproduction failed once at the production actor validator; after alignment the same selected case passed. Its 195 name-filtered siblings were not qualification passes.

The fixture now records a local User and a Server publication Turn in its real dispatch Core and supplies that provenance to all three preparation calls, matching the earlier independent provenance fixtures. All existing assertions, captured native inputs, normalization, Host golden bytes and Rust consumer checks remain unchanged. No production code, schema or frozen journal fixture changes. Next: normally merge current main and run the complete turn-executor-factory file and full runtime folder, plus focused static/build checks, on the exact replacement candidate. Coordinator CI and acceptance remain separate.

This cut does not prove process-crash cohorts, all rollback boundaries, full remote-style absence proof, complete authenticated deadline carriage, exports or duration samples. The coordinator's later CI, acceptance and landing remain separate from focused local evidence; no full-engine GREEN or landing is claimed.

## Intent Revision 3 — Workspace Journal Implementation

Source: engineer implementation authorization after the Core journal landing. Persist ordinary Workspace Worker-Turn journal readers and the twelve accepted producer-backed step kinds under `workspace-worker-turn/v1`, using Workspace0012 and the existing control writer. Retain actual Turn/Task/actor, original invocation/parent cap/carriage, lossless spans and immutable unknown/exclusion semantics. Outcome, the next native product/receipt and acknowledgement scheduling must share the owning Workspace FULL transaction; Core and Workspace remain separate effect domains. This does not activate the general reconciler, authenticated native deadline transport or span export.

The independent author's seven Workspace tests and the three Core journal tests are frozen. Normally merge their published commits without editing those files. The shared acknowledgement-preparation change lands first and is merged before publication; the Worker-governance caller path also waits for its separate landing. Shared storage changes stay local to their owned regions and preserve all upstream awaited acknowledgements. The application guide remains a coordinator relay.

### Historical Combined Workspace Checkpoint

The earlier independent three-file freeze is normally merged. After rebuilding unchanged package dependencies, the six-file baseline reproduced four behavioral failures, 78 passes and five explicit schema-pending cases; the initial stale-export collection failure is setup evidence, not product RED. Workspace0012 and physical-owner-qualified readers now execute all four native reader cases. The complete six-file run observes 82 passes, five producer/deadline failures and no pending cases, retaining all original controls and nine frozen Core cases. The newly executable failure is real session-open intent before delivery. A trial receiver-clock guard caused regressions in existing controls and was removed: Core `updated_at` is not a replacement for the required original journal invocation clock.

Independent source review confirms that the shared acknowledgement-preparation change does not activate the native Workspace product/terminal owner. The prepared product handler still refuses terminal Turns; ordinary Store publication, Task hooks, observation publication and shared receipt pruning remain outside the required worker tuple. Producer wiring must not create a second owner or split commit to conceal that gap. Completing the accepted tuple needs either the existing native activation as an upstream handoff or an explicit transfer of its observation, receipt-partition and terminal-caller regions. Analytical export also needs an explicit journal-table classification; full backup closure does not silently choose its analytical policy. No ordinary Workspace producer or full transaction acceptance is claimed. The later independent Tests 1–6 freeze, owner handoff and shared landings remain pending.

## Intent Revision 4 — Shape-First Workspace Delivery

Source: the engineer's 2026-10-20 scope split and export ruling. Deliver Workspace0012, typed readers and owning-transaction primitives first, with independent storage regressions and explicit non-portable classification. The two journal tables are control state, excluded from analytical Workspace export; full operational backup and MOVE carry them only as Workspace database bytes. The [export owner](../../specs/20260704-workspace_backup_export_import.md#non-portable-and-redacted-state) and [decision clarification](../../decisions/20261019-durable_execution_and_control_store.md#workspace-journal-control-state-clarification) record that rule. No new export format is introduced.

Ordinary producers and activation remain a later delivery after the existing native Workspace terminal/product/receipt/acknowledgement owner is available. That responsibility stays with its current owner; there is no region transfer, shadow authority, file fallback or cross-database atomicity. The independent author supplies separate storage and runtime freezes. This delivery normally merges the storage freeze only, leaves runtime producer RED for the later delivery, preserves the three frozen Core tests and supplies an application-guide relay rather than editing the shared application guide.

### Shape-First Checkpoint

The implementation is carried from the earlier checkpoint onto current main without its runtime producer RED commits. The released export classification list excludes the two control tables under the accepted ruling. Storage-only freeze `fb1573d44d70ecdd708c08057300239ef744be01` is normally merged. The initial complete seven-file probe observed 96 passes and seven failures, with no pending cases: all four new native storage cases and nine frozen Core controls passed, but seven older exact inventories needed additive alignment. That failed evidence remains retained; no production inventory was filtered or hidden.

## Intent Revision 5 — Authorized Frozen-Expectation Additions

Source: the engineer explicitly authorized exactly the seven mechanical additions recorded in the storage-freeze gap. Commit `63372d63ece1b484ca28b3403a162b656af89db5`, titled `test(storage): align exact inventories with Workspace0012`, contains only 17 added lines across those seven hunks in the four storage tests. The Workspace table inventory adds the two actual journal tables; five ordered migration inventories append Workspace0012; the exact analytical exclusion list adds the two control entries with the production reason string. No removal, filtering, loosened equality, other test edit or broader frozen-path permission is authorized. The three Core tests remain unchanged.

### Final Shape-First Qualification

Require the complete seven-file set to report 103 passes, zero failures and zero skips, plus focused static/build/documentation checks and an independent read-only review that inspects all seven authorized hunks. The exact candidate, named output and review are retained in the execution evidence before coordinator CI. Publication is not ordinary Workspace activation, full transaction acceptance, deadline-carriage support or span export. The later producer delivery still waits for its existing native transaction owner.

The exact-candidate run after the authorized seven hunks observes 101 passes and two newly reached stale assertions, with no skips. The Workspace migration list in `db.test.ts` at line 313 and `WORKSPACE_TABLES` in `migrate.test.ts` remain outside the seven-hunk permission. Their earlier assertions had masked these mismatches. The independent read-only review confirms the seven-hunk compliance and the remaining qualification gap; no extra test edit is inferred from the 103-pass target. The runtime guide now names only delivered qualification files and identifies deferred runtime coverage.

## Intent Revision 6 — Remaining Literal Alignment

Source: the engineer authorized the two newly reached inventory additions and a standing extension limited to exact-inventory literals in the same four storage files that omit only the two journal table names or Workspace0012 migration ID. Additions only remain mandatory; no removal, filtering, loosened equality or other edit is permitted. Commit `da6d2e6211cbe3387d6ed19ede6f63f23524eea6` adds exactly three lines in two hunks: the remaining Workspace migration ID in `db.test.ts` and the sorted journal table names in `migrate.test.ts`'s `WORKSPACE_TABLES`. No further standing-extension edit was needed.

### Final Qualification After Literal Alignment

The Core administrative journal and Workspace journal storage cuts landed on main in `f4ce56652` and `16acfd487`. Their landing gates are closed; the earlier failed checks and literal-alignment evidence remain historical. The plan stays in-progress for ordinary Workspace producers, the owning terminal/product/receipt/acknowledgement activation and the remaining reconciler work. Authenticated deadline carriage, span export and remote-proof qualification remain separate obligations. No full-engine or live acceptance is claimed.

## Intent Revision 7 — Ordinary Worker Producers And Exact Receipt Consumption

The accepted 3b-2b cut binds actual fixed-effect and Harness producers to the landed Workspace journal and existing native settlement request. The original parent allowance precedes the existing command-slot wait; exact prepared identity and its child follow that wait before Core publication or contact. Native admission supplies the live clock witness without a new refresh command. Delivery rechecks current authority after its acknowledgement. Credential hashes persist; raw credentials remain transient. The original Turn deadline remains separate from the command allowance.

The original outcome and its linked consumption obligation share one native savepoint. Core retains the receiver result until exact consumption commits; first and replayed HTTP results await that consumer. Later complete-domain inspection can close a Workspace execution after an unknown child without rewriting that child. A product terminal result or weak backend acknowledgement alone grants no release.

Coordinator rulings on idle ownership preserve the existing Core binding/result/capacity tuple for local `session.close`. Measured option C failed because boot and maintenance skipped the cleaned idle anchor after a durable drain. The pre-authorized fallback is `core-idle-cleanup/v1` in the existing Core journal, with existing step kinds and exact bridge/delete identities. Its closed-resident recovery remains in the existing backend cleanup owner. No historical Turn is reopened and no table, column, queue, protocol or retry service is added. The accepted owner text is in Physical Receipt Consumption.

Independent test-author composition uses exact frozen `87f6f88922c307acd428376308710ea5f7101fc8` with the landed native fixtures. Mechanical migrations preserve assertions; independent dispositions cover retired callback presence, additive retained receipt metadata and real native clock authority. Qualification evidence is retained with the landing. The generic remote list/kill/late-create claim is deferred to issue #500 until an actual capability-consuming adapter exists. General reconciliation, authenticated deadline headers, analytical export and increment-4 dispatch remain separate cuts.
