---
status: Draft
implementation: Not Started
kind: mechanism
date: "2026-10-19"
---
# Durable Execution And Control Store

## Owns

Scope-owned transactional control, durable execution, dispatch, immutable-content placement, and replacement of split-store recovery under the [engineer decision](../decisions/20261019-durable_execution_and_control_store.md).

## Does Not Own

Product/Goal structures, authorization, Knowledge semantics, retention schemas/defaults, telemetry delivery or backup/move commands; no public Run, DSL, code replay, external workflow server or second blob service.

## Core References

- [Storage](../core/storage.md) and [Runtime Model](../core/runtime-model.md).
- [Fault Tolerance](../core/fault-tolerance.md) and [Contract Evolution](../core/contract-evolution.md).
- [Permissions](../core/policy.md) and [AgentSession](../core/agent-session.md).

## Related Docs

- [Storage Layout](20260703-storage_layout_record_ownership.md), [Storage Service](20261018-file_storage_and_knowledge_packages.md), and [Notebook](20260909-knowledge_notebook_editing.md).
- [Scheduler](20260703-durable_scheduler_design.md), [Scale](20260703-runtime_scheduling_scale.md), [Bootstrap](20260704-nanocore_bootstrap_readiness.md), and [NanoHost](20260802-nanohost_runtime_and_transport.md).
- [Pending Requests](20260531-human_attention_intervention_model.md), [Recurring Triggers](20260711-scheduler_recurring_event_triggers.md), and [Test Strategy](20260529-test_strategy.md).

## Commit Rule And Scope Layout

One owning SQLite transaction commits state, journal, dependent local records and receipt; resolve uncertain acknowledgement through that request identity.

Synchronize and verify file-backed content before its first durable reference. Bounded retained Item and Item-event bodies instead follow [Storage's inline rule](../core/storage.md#item-log-invariants): verify their exact bytes and commit them with their owning metadata in the same FULL transaction. Each file-backed content byte is synchronized exactly once by its publishing owner; a second pipeline stage must not repeat a successful publication barrier. This allocates first-publication work, not permission to treat an uncertain publication as durable. Publish caches and notifications only after FULL commit: visible canonical progress means committed progress, with no volatile publication path. Intent commits before external contact; outcome commits afterwards. Neither progress coalescing nor a future storage backend weakens that effect write-ahead rule.

WAL ATTACH cannot make cross-database effects atomic.

| Location | Authority |
| --- | --- |
| `workspaces/<id>/db/workspace.sqlite` | Workspace, Thread, Turn, AgentSession, ordered Items, receipts, executions/steps, signals/timers, Policy/configuration/catalog/Knowledge heads, local Audit/usage/observations/evidence. |
| `workspaces/<id>/content/` | Existing Storage immutable AEP/context, messages/parts, prompt/tool definitions, configuration revisions, Artifact/evidence payloads. |
| `workspaces/<id>/knowledge/` | Existing managed originals, schema revisions and immutable Notebook history. |
| `workspaces/<id>/projections/` | Disposable readable records, never accepted writes or recovery authority. |
| `server/db/core.sqlite` and server Storage | Users, membership/registry, configuration/Knowledge heads, server executions/evidence, physical bindings and capacity. |
| Existing user databases/Storage | Private preferences, Memory, receipts and content. |
| Derived indexes | Rebuildable audience-scoped projections only. |

Reuse `@openkit/storage`, staged handoff, `sha256:` and content references; prohibit immutable overwrites and cross-scope deduplication disclosure.

Server configuration stays server-owned; AEP pins revisions/digests, distinct from reload outcome and running-Turn input.

Vault and host-owned Worker volumes retain their owners.

When AgentSession facts move into SQL, native continuation references retain the scope of their actual native owner, independently of executor placement. The current file-backed pair remains the NanoHost representation; do not give a generic column a NanoHost-placement meaning. Preserve the [AgentSession owner](../core/agent-session.md); this amendment adds no native-reference fields or provider integration.

### Write And Space Budget

For `v0.1.0`, a bounded pool of control-store workers owns the activated admission/product families and the measured switches in the table below. Each Workspace database is pinned to one worker for its worker-owned families while open. The server database's worker-owned families have a separate worker. Other families retain their current Main owner, including in the same database. Each family has exactly one logical writer; SQLite locking does not supply this ownership boundary. The [mixed-writer exception](../decisions/20261020-control_store_mixed_writer_exception.md) remains, with only worker placement, load references and real-effect measured-need qualification amended by the [worker and load-reference decision](../decisions/20261023-independent_control_store_writers_and_load_references.md). All threads remain inside one NanoCore and its existing data-root authority. Preparing unused handlers or schema does not activate a family. There is no compulsory migration of unmeasured cold families.

Different Workspaces require no joint commit or global order. Within one Workspace, different Sandboxes, AgentSessions and Threads are logically independent. Shared Knowledge publication bases, capacity/quota, Pending authority and synchronization cursors still use deciding SQL revision checks in their owning database. Server-owned physical capacity remains server-owned. A server fact must commit before another database references it; this causal dependency creates no cross-database transaction. These boundaries remove unrelated waiting without weakening shared-state checks.

| Family | Writer and boundary |
| --- | --- |
| Activated Workspace product metadata, Workspace/Server Thread, Turn, AgentSession and ordered admission/product records | Database worker, with the entire dependent local tuple. Retain the product's actual server or Workspace scope; do not invent a Workspace for a server product. |
| Original command receipts and required local Audit rows | The tuple's writer, partitioned by admitted operation identity and owning scope. Each writer commits and prunes only its own rows; no new ledger or ownership column. A legacy read that prunes is a write. |
| Authentication, User identity/Tokens, Vault, Workspace registry/membership/sharing | Existing main-thread owner; no pre-v0.1.0 conversion requirement. Registry ownership is distinct from admission/product metadata. |
| Artifact submission SQL tuple; Artifact Review; Workspace Material, Material revision and Thread Material binding mutations | Database worker. Artifact submission commits its Item/reference, Review and original artifact.submit receipt together after durable bytes. All Review insertions, judgements, selections and decisions use this writer. Accepted Material proposal decisions commit their revision, current pointer, bound queues, Review decision and original receipt together. Material creation, independent revision save, binding/inclusion changes, exact-range judgements/corrections and verified queue consumption use this same writer; each command commits its original receipt with its complete local tuple. |
| Evaluation candidate sets and their set-owned selections/assessments | Existing Main owner under the cold-family exception. A qualification proxy is not evidence of a product hot path and does not authorize migration of this family or its receipt/Audit partitions. |
| Channels, attention/deletion, presentation, Knowledge/configuration/catalog and User read receipts | Existing main-thread owner for SQL families; existing file owners remain until their separately accepted switch. |
| Pending Request and dependent Goal product mutations | Database worker for the complete native admission/publication/claim/effect/disposition tuple and original receipts. Native claims reserve at most one execution and apply native-owned checks. Main checks its current authority at the existing effect-submission boundary: after external claim ACK before contact, or immediately before posting a Goal claim-and-effect transaction. |
| Workspace CapabilityCall, linked usage, PermissionDecision and their required Audit rows | Database worker for the complete measured family: admission, final/gate/approval decisions and finite-use consumption, participant Audit, raw-proof accounting, same-row attribution, MCP schema capture/binding and usage/terminal publication. Preserve correlation with the native Pending claim through its request-derived execution call identity. MCP success uses two native ledger transactions for an existing Turn/server schema and three on first discovery; unchanged current observation reuse preserves its capture time. After awaited commits, Main rechecks current authority at effect submission; the durable Call row precedes contact. Server/User decisions and unrelated Audit producers keep their existing owners. |
| Worker checkpoint and its required launch/recovery/terminal tuple | Database worker for reservation, launch PermissionDecision/Audit, preparing checkpoint, dependent Goal-card/Thread link and revision, update/bind, terminal evidence and derived runtime Call/usage/Audit, guarded deletion, and interrupted retry with its original worker.recovery.retry receipt. Core execution-attempt and current authority checks remain on Main before submission; exact retained checkpoint comparison protects cleanup after awaited proof. |
| Not-yet-moved scheduler, execution/control, AEP/observation/evidence/synchronization, unrelated usage and other Policy families | Existing main-thread owner outside the complete tuples above. Unmeasured frequency does not make these families cold. A later move needs its complete tuple and explicit ownership switch. |
| Independent Light App business databases | Existing scoped business/schema/recovery owner; no cross-database atomicity claim. |
| Startup DDL/recovery, stopped migration/import and maintenance tools | Existing scoped owner under explicit phase exclusion. Stop or exclude the live writer before the phase; never compete with it. Live imports follow each target family's writer. |

Artifact files and synchronous capacity sections keep their existing owner. Synchronize durable bytes before the submission SQL transition; preserve truthful fail-closed file/SQL gaps and the accepted refusal, replay and recovery rules. Review refinement/redo keeps its existing separate checkpoint, Turn and scheduler proof paths; this switch creates no cross-domain transaction. Route evaluation.judgement-add and its original receipt to the existing exact target's writer; candidate-set mutations stay with their current Main owner. Stopped staged import retains the explicit phase exclusion. No second writer, settlement state, ledger, asynchronous global admission scope, terminal bypass or other family migration is authorized by this switch. All complete-body, savepoint, FULL acknowledgement, committed-read, bounded queue, batching, WAL, busy-handling and qualification requirements above remain binding.

Direct Material save admits at most 16,777,216 exact UTF-8 bytes. Native transport carries them in one transferable binary payload outside the unchanged 1 MiB JSON envelope. The client admits binary bytes against its bounded in-flight budget before `postMessage`; native preparation verifies length and digest before SQL. Artifact-backed Review preparation reads and verifies the retained original under the existing UTF-8 processor limit. Failure, cancellation and lost acknowledgement preserve truthful commit certainty. This adds no Storage stage capability, durable family, ledger, settlement state, Main fallback or asynchronous global admission scope.

For new native bodies first referenced by a worker batch, the owning database worker is the publishing owner. Inline Item and Item-event bodies use the existing control database; file-backed bodies use existing Storage staging and content references rather than a new buffer or ledger. Existing Artifact/file authorities and already durable content keep their owners. The minimal durable pipeline is:

1. Prepare and verify the bounded batch's exact native bodies outside SQL. Select inline or the unchanged file descriptor under the Core byte boundary, without converting prior revisions. Synchronize each new immutable file exactly once, in a bounded parallel cohort owned by that database worker, not first in Main and again in the worker. Reused content must have a verified completed durability boundary; mere path existence after interruption is insufficient.
2. Publish create-only canonical names and synchronize each distinct changed directory once for the batch, after its entries are prepared. Do not synchronize existing unchanged ancestors on every ensure-directory call. Retain existing path, type and scope validation. Newly created directories still require their changed parent entries to be durable before references; include those parents in the distinct-directory set. Unlink private staging names without a following cleanup sync. Names surviving a crash are garbage, not authoritative deletion or capture results.
3. Only after all referenced files and paths are durable, run the complete local SQL transitions and outer FULL COMMIT, committing exact inline bodies with their metadata. A failed savepoint may leave an unreferenced immutable object, never a dangling accepted reference. Publish acknowledgements and committed views afterwards.

The existing startup staging-cleanup owner must remove abandoned native publication names under writer exclusion, before live admission. Its current Workspace `.staging` cleanup alone does not cover hidden publication `.tmp` names beside canonical content; extend that owner to the exact private names in admitted roots, without touching canonical digests or live captures. No new cleanup service or durable marker is required. A directory whose first publication is uncertain still needs recovery validation; an unchanged, established ancestor does not need a repeated sync. This optimization does not weaken acknowledged deletion.

- The complete read-check-write body of a worker-owned transition runs inside the worker's transaction. If a required tuple dependency lacks a native handler, do not split the tuple between worker and main commits.
- No main-thread callback, awaited external effect or file synchronization runs inside SQL.
- The worker groups eligible ready transitions of one database into one transaction: at most 32 transitions and at most 5 ms of additional writer coalescing wait. Progress eligibility follows the explicit throttle below; other work does not inherit that delay. These existing writer bounds limit batch monopolization and added waiting; they do not synchronize different databases.
- Each transition/Item gets its own savepoint. A failed Item leaves no rows and refuses that Turn's queued successors; it does not fail independent siblings or undo an earlier committed Item. Expected predecessor revisions still decide applicability. No successor is silently rebased or skipped.
- The worker acknowledges a transition only after the outer COMMIT with `synchronous=FULL`. Writing callers await that acknowledgement, then publish caches and notifications.
- A missing acknowledgement does not prove non-commit. The request identity and receipt rule above resolves it.

The main thread keeps separate read-only WAL connections (`query_only=ON`) for worker-owned product reads. It retains writable connections for main-owned families. A legacy writable connection is not a table-level SQLite access-control boundary; enforce the family boundary in producers and shared receipt/Audit paths.
- These reads stay synchronous, see the last committed state and never write.
- A read ends its SQL transaction before streaming or awaiting a downstream consumer.
- Export, backup copy and diagnostic scans are paged; none runs as one long main-thread read.
- If a read must see a write that is not yet acknowledged, the caller's design is wrong. That is not a reason to route reads through the worker.

Keep the retained Main writable connections' busy wait bounded at the current 5 ms default, not the native seconds-long default. This bounds lock waiting, not COMMIT/fsync time, transaction duration or operating-system scheduling. Do not retry automatically. Retain the original qualification criterion of at most 10 ms observed Main BEGIN duration, including failed starts; it bounds write-admission stalls separately from the main-loop percentile. Observe actual first-write lock acquisition for deferred transactions as well, rather than claiming a pass from absent BEGIN IMMEDIATE samples.

Main-owned synchronous Workspace writes that can overlap live native activity take the existing native posting hold scoped to that database key. The hold asynchronously settles that database's posted acknowledgements, defers its new posts within the existing admission slots and byte budget, and releases idempotently in finally after the synchronous operation. Same-database holds run FIFO; a global backup hold waits for earlier database holds, while later database holds wait for it. A failed channel refuses the hold. Other databases continue independently. The Main busy wait remains 5 ms with no retry. This is writer exclusion, not a family switch or a new request queue. A Main family's hold duration or frequency that harms native service is evidence for a later measured migration.

Any Main family whose actual reference-profile write path causes main event-loop p99 to exceed 25 ms, fails the Main BEGIN criterion or breaks sibling isolation must move to its owning database worker as a measured need. Attribute the failure with actual family/transaction timing and counts. Move the whole family and its original receipt/required Audit partitions, preserving complete tuples, disjoint pruning and the effect-submission authority recheck after awaited commits. CapabilityCall, PermissionDecision and their required Audit are the expected first candidates, not already proved failures of the old proxy workload. Unmeasured frequency, module co-location or a synthetic contender is not a migration grant.

Native BUSY/LOCKED uses the existing transport-neutral operation error owner: HTTP 503 and `operation_storage_unavailable`, with equivalent MCP framing. Tell the caller to inspect the original request outcome before retry. Do not expose SQL, classify busy as authorization refusal, promise non-commit from timeout alone or create another retry ledger. Only proved pre-effect failure or rollback establishes non-commit; COMMIT/reply uncertainty still resolves through the original receipt.

Preparation does not activate the writer or transport changes. Qualification uses actual native tuples, including immutable-body publication, Pending, Goal and terminal publication, plus real effect submission through its actual owner. The mixed arm must exercise CapabilityCall, PermissionDecision and required Audit while they remain Main-owned; it must not substitute candidate-set creation or direct SQL. Preserve required usage, outcome and Item publication work and the owner's transaction boundaries; a synthetic combined transaction is not the product path. Preserve the native payload/operation mix; SQL-only or prepublished-content probes cannot qualify it. Account for scheduled, offered, committed, refused, late and unresolved work by identity. A Main stall or client single-flight check must not silently reduce offered load. After a justified migration, retain the same effect workload and verify the new writer placement, rather than remove the effect dose or retain a redundant Main writer.

Use natural batching for one Turn or AgentSession. At most one commit is in flight per Turn, including its publication-to-COMMIT boundary. Items arriving meanwhile enter the existing FIFO within its count and byte bounds, or receive explicit refusal beyond them; queued means pending, not durably accepted or visible. The next commit takes queued Items in order with one savepoint each. Preserve the AgentSession's ordering boundary where applicable, expected predecessor revisions and in-order FULL acknowledgements. A failed Item refuses its Turn successors, including later queued work, rather than rebasing them. This does not multiply capacity by addressing both identities or change one-active-Turn execution exclusion. Lost acknowledgements resolve through original receipts, never automatic effect replay. There is no four-item or K-deep in-flight commit requirement.

Admission bounds each physical database/Turn to eight pending publications, including its active publication. A publication addressing several Turns checks their distinct selectors atomically before reserving or installing any tail; excess work is refused busy with definite non-commit. Before durable MCP call admission, reserve one native count credit for that exact call's serial closeout through its original invocation settlement. The admitted call's cold or changed MCP schema observation also borrows that same exact-call credit; exact unchanged current observation needs no additional native request once that Call's bound schema stamp is proved. Child discovery has its own credit; cold opening, admission and unrelated commands retain ordinary accounting. Credited closeout charges its actual envelope and material bytes but is exempt from aggregate byte-pressure refusal, so ordinary new work yields to already admitted effect closeout. Existing single-item ceilings remain: capability JSON is at most 1 MiB, and a scalar larger than the entire material pool is refused. This rule also covers builtin Knowledge answers without adding an answer cap or worst-case byte reservation. The admitted effect's exact terminal tool-call Item publication is serial closeout: it borrows that invocation credit and is exempt from the per-Turn and aggregate byte-pressure refusal while preserving same-Turn ordering and actual byte charges. These limits bound new admissions. Genuine terminal Item publication failure is explicit and privately diagnosed; it does not rewrite the settled effect. After acknowledged failed closeout, a proved absence of target Tool contact is reported as `details: { outcome: 'failed', upstreamEffect: 'not-contacted' }`; an earlier committed terminal outcome, uncertain closeout or unavailable required publication cannot establish that failed outcome. This does not claim non-commit of admission or any internal substep. Only proved pre-contact native admission refusal carries `commit: 'not-committed'` to the MCP caller; a failed post-contact SQL write or missing acknowledgement grants no such claim about the effect. The [admission fairness decision](../decisions/20261025-native_admission_fairness.md) records the accepted count and byte-pressure trade-off.

For high-frequency progress, the first change after idle commits immediately without a throttle delay. Subsequent progress commits are at least 100 ms apart; intervening changes coalesce into the next eligible batch, with storage pressure allowed to lengthen the interval within existing operation deadlines and queue bounds. Arrivals do not perpetually restart a debounce timer. Coalesce replaceable pending progress projections or append batches, never discard canonical Items, observations or native transcript bytes. Producers retain all unacknowledged data under SOURCE-RETENTION below. A barrier bypasses the throttle and flushes its complete causal prefix before acceptance: effect write-ahead, Pending/approval, API receipts, Turn terminality, capture acceptance, deletion, Vault and authentication are never deferred for progress coalescing. The 5-ms writer window begins once work becomes eligible; the 100-ms progress eligibility delay is explicit, not hidden in that window. First-idle progress and barriers do not deliberately wait for a writer-coalescing timer. No new durable scheduler, buffer or public operation class is introduced.

Design load envelope (committed work, not merely offers):
- **Status and headroom:** expected product peak remains well below 100 transitions/s per NanoCore instance. A capacity floor of 200 committed transitions/s provides at least twice that peak, including when it concentrates in one Workspace. This floor and the safety criteria are firm requirements, not claims of measured achievement. The following workload shapes, single-Turn throughput, isolation percentage and pool sizing are provisional reference defaults until the first native measurement. Revisions must retain the capacity floor and safety criteria; failure is not a waiver.
- **Per-Workspace reference:** sustain at least 200 committed transitions/s with 40 active Turns at a mean 5/s each (40 × 5 = 200). The 5/s rate means one transition per 200 ms; increased concurrency supplies headroom without demanding an 80/s serial Turn. It is a provisional workload reference, not a measured per-Turn rate. Separately demonstrate one Turn sustaining 20 committed/s with natural batching and at most one commit in flight. Queued Items are not concurrent commits. At a 100-ms progress cadence, this needs at least two Items per commit rather than twenty separate commits/s; report actual batch sizes and timing instead of assuming that amortization.
- **Per-NanoCore-instance reference:** sustain at least 200 committed transitions/s across four concurrently active Workspaces, each contributing at least 50/s from ten active Turns at 5/s. Four preserves the previous hot-plus-three-siblings topology. Use four Workspace workers plus the separate server worker on the reference host; this is a bounded reference configuration, not a thread per stored Workspace. The concentrated and distributed profiles are alternative distributions of one 200/s budget, not a promise of 800/s.
- **Workspace isolation:** offer one Workspace 400 transitions/s, twice the instance reference, while each of three siblings offers 5/s. Each sibling must commit and acknowledge at least 99% of its own scheduled valid offers during the steady measurement window. Count refusal, missed scheduling and late acknowledgement as failures, not reduced denominators. At the window below, each sibling needs at least 1485 of 1500 successes. This allows at most 1% boundary/tail variation. The earlier 72.0–74.4% result measured cold commands in the primary Workspace, not sibling success; each sibling now needs its own proof. The three siblings need only 15/s; the hot Workspace must yield and refuse excess rather than monopolize admission, preparation or SQL service. This is bounded storage-service isolation, not a new execution-placement or quota policy.
- **Real-effect mixed reference:** schedule one complete effect lifecycle per ten scheduled native transitions, independently of acknowledgement timing. This provisional 1:10 ratio requires 20 effects/s at 200 native transitions/s, or 5 effects/s in each 50/s Workspace. A normal Worker MCP effect publishes one terminal tool-call Item; ten percent effect-associated native traffic is a reference assumption, not observed production frequency. The effect dose is four times the former 5/s proxy and prevents a zero-Main mixed qualification. Within the envelope, complete the scheduled valid effect dose at the stated rate; missing or refused effect dose fails qualification. Ledger writes do not count toward the native committed-rate targets. Record lifecycle/ledger counts separately from native product progress, counting each terminal Item only once. The ratio and actual synchronous family coverage remain in force after migration; a higher deployment effect ratio needs its own RC measurement.
- **Measurement:** use a steady 300-second window and two repetitions per reference profile. This retains the earlier 192000/640-second observation length and exposes the observed run-to-run variation. Derive offers from wall-clock time, not acknowledgement timing. Report committed acknowledgements in the measurement window separately from drain completion; a drain proves disposition, not throughput. Include count/byte queue occupancy, actual batch sizes, per-Turn in-flight commit counts and refusal reasons. Every repetition must pass, including each sibling separately; aggregate averages cannot hide starvation. Exercise overflow and a failed predecessor with dependent queued successors without changing the ordinary valid-load denominator.
- **Reference storage class:** the measured development host has 16 cores and a local btrfs filesystem on a LUKS SSD. With 4 KiB objects, serial file-plus-parent publication measured 43 objects/s, or 85 fsync/s and approximately 11.7 ms per fsync, not per object. At 16-way concurrency it measured 560 objects/s, or 1121 fsync/s. A 32-file cohort with one parent sync measured 1129 objects/s; serial WAL-like append plus fdatasync measured 88/s. These observations identify the storage class and distinguish latency from concurrent capacity; they are not transition-throughput guarantees. Re-measure deployment hosts, storage and the complete native profiles at release-candidate acceptance; report CPU, filesystem, encryption, storage concurrency and competing load. An unqualified host cannot inherit the development host's result.
- **Synchronization observation:** the current path is estimated at 1060 syncs/s for 200 transitions/s, about 5.3 per transition, versus approximately 1121 fsync/s measured parallel storage capacity. That leaves no useful margin. Target an average of at most three sync operations per committed native transition, or 600/s at the reference rate. This is a design target, not an additional numerical pass/fail gate: committed throughput and the existing safety criteria still decide qualification. The actual count and breakdown are REQUIRED reported observations for every reference profile, not an inference from this estimate. Include all Main/worker file, directory, SQLite WAL and checkpoint synchronization, actual effect-dose work, new-directory costs and failed work during the measurement window; normalize by native transitions committed and acknowledged in that window. Count actual platform fsync/fdatasync operations, including SQLite-internal calls, without double-counting wrapper instrumentation. Report batching and I/O concurrency and any measurement gaps; JavaScript-only counters are not a complete count. No claim of achieving the target may substitute for measurement.
- **Within the envelope:** Core loses no accepted transition, keeps main event-loop delay p99 at or below 25 ms, and survives reopen with exact original receipts and their committed tuples/content. The loop bound protects service responsiveness; exact reopen and no loss protect acknowledged authority. Acknowledgement remains after outer FULL COMMIT, with immutable content durable before its first durable reference. These requirements also remain binding during the saturation/isolation run.
- **Beyond the envelope:** Core refuses excess work explicitly through bounded admission, ordered-queue and WAL backpressure, scope-local where the owning scope is known. It never drops acknowledged work, acknowledges before COMMIT or grows an unbounded queue. Pressure in one Workspace must preserve the stated sibling service. Worker sharding replaces the former shared-worker latency coupling; it promises only the measured reference isolation, not unlimited hardware isolation.

Bound offered work, pending work and read duration. Keep each WAL at or below the existing 32 MiB bound through checkpoints and backpressure, preventing storage growth under blocked readers. WAL age triggers backpressure and is reported for diagnosis; it is not a latency objective.

Queued envelope and binary/echo backing budgets are per owning database. Outstanding commands for that database share one bounded WAL-growth forecast; they do not each reserve the complete WAL allowance. Distinct databases and other file producers still share actual filesystem capacity. Every affected filesystem must admit each new request against its current ordinary or control margin. A failed channel retains its outstanding reservations until the native owner actually exits.

At creation, including the authorized reset, set `auto_vacuum=INCREMENTAL` for all OpenKit-owned databases, including server, Workspace, user and Light App `data.sqlite`; opaque MCP databases remain app-owned.

Run bounded `incremental_vacuum`; enforce `secure_delete=ON` per connection because FAST can leave freelist remnants; checkpoint/truncate after deletion obligations, retrying blocked checkpoints without device-erasure guarantees.

Use `VACUUM INTO` only on common-cut static snapshots under durable capture protection.

Content deletion removes unheld blobs through reachability GC; backups expire under retention.

Thread-owned rows carry Thread identity directly or through their owner, permitting transactional separation; stable cross-Thread references, including Knowledge provenance/Task links, resolve archived/purged states truthfully.

### Workspace Authorities Outside The Control Database

| Existing owner | Target commit and complete-snapshot boundary |
| --- | --- |
| Notebook Git refs/pages/Source pointers | SQL head, expected-base check, Audit and receipt commit over synchronized immutable Git history; refs/pages become projections. Copy the referenced history, not a moving branch. Preserve Source identities, semantics and reference-may-miss behavior. |
| Authored configuration, schemas, mounts | SQL admitted heads over exact immutable revision bytes; editable files are drafts. Full-directory capture labels and includes unadmitted drafts without activating them. Failed admission preserves the prior head. |
| Skill/MCP/Plugin/Light App catalogs | SQL heads, pins, binding associations and receipts; installed snapshots remain immutable. Include retained historical versions. |
| `light-apps/<appId>/data.sqlite` | Keep independent business DDL/schema-data rollback and app-local receipt/Audit authority. Turn writes are keyed effects resolved through app receipts, not another execution journal. Snapshot each database and exact definitions. |
| `mcp-data/<packageDataKey>/` | Opaque binding-owned mutable business data; preserve referenced data across rollback/uninstall. Pause/stop every writer and obtain supported flush/snapshot proof; otherwise refuse hot capture. Unknown mutations cannot be retried. |
| Managed `files/`, `data/`, `sources/`, Artifact/transcript metadata | Mutable Core heads/records move to SQL; payloads remain immutable. External mounts remain explicit external references, not implicit backup coverage. |
| Runtime/staging/indexes/logs/projections | Disposable or diagnostic, never product authority; exclusion requires declared coverage. |

Only accepted per-Light-App business databases remain additional canonical Workspace databases because their independent schema/data recovery contract requires them.

### Snapshot Cut And Capture Protection

Before snapshots, the backup owner durably creates a Workspace SQL capture record excluding Storage GC and Notebook prune/repack for that Workspace.

This specific capture obligation is new, not an existing hold implementation or generic service.

Existing mutation admission blocks writes, settles cross-database effects and establishes one common control/app/opaque-root cut; release the gate only after all snapshots stabilize.

Other Workspaces continue; an unfreezable writer refuses hot capture, and independent database copies do not prove consistency.

Quiesced capture settles executions/stops writers; never file-copy live SQLite/WAL or declare unresolved effects application-consistent.

The owner durably finishes after verifying transitive blob/history closure, or explicitly abandons; GC/prune/repack resumes only without active captures.

Restart, unavailable authority, process loss and wall-clock passage cannot release protection; abandoned partial bundles cannot restore as complete.

## Minimal Engine

One NanoCore reconciler advances executions, steps, existing signals and timers.

| Primitive | Retained contract |
| --- | --- |
| Execution | Existing work/operation identity, immutable scope/input identity, execution-definition version, current steps, terminal cause and exclusion. Worker execution belongs to one Turn; Task lineage remains unchanged. |
| Step | Exact invocation/actor, intent/outcome, fingerprint, permitting decision, authority/fences, references, retry declaration and deadline. Intent precedes effects; outcome and next transition commit together. |
| Signal | Existing Pending Request identity, first valid decision and delivery linkage; same identity/content returns the result, changed content conflicts. Existing withdrawal/late-outcome rules apply. |
| Timer | Existing deadline/next-due and recurring families; conditional consumption in the owning transaction, preserving due instants across restart. |

Execution phases: `open`, `closing`, `closed`; step states: `intent`, `completed`, `failed`, `unknown`, `cancelled`; only intent is nonterminal, ended steps immutable/skipped.

One release-authored execution-definition version and closed step kinds govern interpretation; unsupported required semantics fail closed, descriptive additions remain ignorable.

Each step names its own selected execution target and control parent/deadline cap; an execution may have concurrently open steps and nested child steps. Invocation identity is stable and distinct from the input fingerprint and trace identity; the definition version and exact versioned control/content references carry consumer-specific child keys, replay fingerprint inputs and actual result-delivery order, never diagnostic attributes.

Claims and outcomes condition on the unchanged execution and selected current step; constraints enforce Thread/AgentSession single flight and effects recheck authority.

Worker/network/user waits occur outside SQL.

### Worker-Turn Transitions

W is Workspace SQL, S is server SQL; these closed transitions apply normally and after restart.

| Transition / owner | Effect identity and receipt; retry | Next step / exclusion proof |
| --- | --- | --- |
| Admission / W | Request identity/hash; atomic Turn/source/execution/receipt. Identical input returns receipt; changed input conflicts. | Reservation; Thread/AgentSession exclusion. |
| Reservation / W intent, S apply, W result | Reserve invocation key defined below; exact S receipt. Same-key inspection/apply only. | Held -> preparation; definite refusal -> due admission with fresh invocation; cancellation -> fencing/release. No Worker starts before W accepts held result. |
| Preparation / W and receiver | Execution/attempt/step invocation, fingerprint/fences and retained receipt; retry only under receiver idempotence. | Consume receipts, then start; failure/cancellation -> terminal publication. Missing proof retains exclusion. |
| Start / W and Harness | Exact command invocation/fingerprint; Harness receipt and Worker identity. Proven non-receipt permits delivery within deadline; ambiguous native start never permits replay. | Observation/collection, or terminal publication on definite failure/unknown. Dispatch alone proves neither completion nor absence. |
| Observation/collection / W and receiver | Attempt/process/sequence/payload fingerprint; keyed collection receipt. Deduplicate identical content; reject divergent replay. | Observe or publish terminal result/prefix/coverage; never invent output. |
| Terminal publication / W | Turn outcome, ordered Items, Task fact, `turn.reap`, evidence, receipt and next cleanup step commit together. Same request resolves uncertain commit. | Execution becomes closing; product terminality does not release physical or local exclusion. |
| Fencing/release / W intent, S apply, W result | Exact reservation/binding identities, stop/absence and attachment proofs; idempotent release receipt/tombstone. | Close execution and release local exclusion only after physical no-writer/release proof or proved no-allocation. Otherwise remain closing and fenced. |
| Cancellation / W | Commit first cause/revocation; cancel definite unstarted work, inspect possibly applied effects. | Terminal publication then fencing/release; late evidence cannot reopen work. |
| Human wait / W | Pending Request and owner's terminal Turn outcome commit; no paused Turn or default response expiry. | Terminal publication and cleanup; decision delivery admits a later Turn under current authority and exclusion. |

An internal terminal publication that settles both the original submission and a waiting Stop command commits both original command receipts and Audits with that Turn tuple on the same native writer.

Failed, cancelled and interrupted Turn publication retains all applicable original RuntimeEvidence and required references; a zero record count alone does not prevent that publication when the original execution and all required observation and evidence facts agree, and unknown effects and cleanup keep their exclusion until physical release is proved.

Lost replies leave intent open for bounded inspection, without dependency-driven deadline extension. Deadline, cancellation or proved Worker loss ends unproved effects `unknown`; definite non-execution permits failed/cancelled settlement.

Later inspection is linked cleanup evidence, never revision of the original outcome.

Native loss interrupts its Turn; continuation requires newly admitted work and proved native resume, with the existing new-linked-Thread rule on resume failure.

Recurring cadence, overlap, missed-occurrence and admission-only retry semantics remain unchanged; accepted failed/unknown execution is not retried as an occurrence.

## Step Journal And Span Model

The journal uses the OpenTelemetry span model, not an SDK buffer; fields contain bounded diagnostics, never prompts, tool arguments, output bodies, credentials or private reasoning.

| Field group | Required representation |
| --- | --- |
| Correlation | Execution trace: 16 bytes/32 lowercase hexadecimal digits; root/step spans: 8 bytes/16 digits; optional parent has span width. Nonzero IDs confer no authority. |
| Description | Name, span kind, integer Unix-nanosecond start, nullable end, OTel `UNSET`/`OK`/`ERROR` status and description; no floating-point timestamp loss. |
| Attributes | Typed AnyValue preserves double versus int and exact int64; applicable semantic conventions/GenAI keys, `openkit.*`, pinned schema URL; no stringification or attribute-controlled execution. |
| Events/links | Ordered timestamped typed events, trace/span links, permitted flags/state, optional fields and dropped counts; no silent loss of required facts. |
| Envelope | Stable instrumentation scope, resource descriptors, schema URLs and flags; immutable descriptor sharing is permitted. |
| Separate control | Work/attempt identity, step kind, selected target, control parent/cap separate from the trace parent, versioned input/output references, fingerprint, authority, retry permission, deadline and physical fences. |

Projection must preserve stored types, values, counts and metadata exactly; the telemetry owner chooses the typed OTLP/JSON path, not a narrowing SDK-span conversion.

Open roots/steps remain inspectable but unexported; unknown ends with `ERROR`, controlled description and uncertainty attributes.

Export may drop/duplicate spans, never delay, roll back or retry work.

Orphan detection is observed time, not physical completion.

Journal retention follows work/evidence/holds, not diagnostic-file limits; expiry never releases fences.

This journal alone narrows the [no-durable-trace decision](../decisions/20261016-nanohost_trace_headers_and_startup_link.md); other canonical records and transport bodies gain no trace fields.

### Journal-To-Lifecycle Mapping

Admission persists the root span model/identity/start on the execution row; restart preserves it, cleanup/release closure ends it without a step-duration sample. Steps use that trace and causal parent/root; distinct executions link rather than reparent.

Preparation follows resolve -> check -> materialize -> open/inspect; actual invocations map to the telemetry owner's ten stages:

| Step kind | Lifecycle stage |
| --- | --- |
| Admit, queue/capacity wait | Admission/queue |
| Resolve setup | Preparation |
| Reserve, validate setup | Validation |
| Materialize | Materialization |
| Open/inspect session | Session open/inspect |
| Deliver start | turn.start delivery |
| Observe native execution | Native run |
| Record this Turn's human wait | Pending request wait |
| Collect evidence | Collection |
| Consume receipt, inspect cleanup, fence, release | Cleanup/release |

Local terminal/cancellation commits inherit the settling step's stage; they create no synthetic stage or sample.

Each ended step supplies one span/sample; label linked retries separately, report invalid durations, never resample repeated reads/exports.

Attach Host summaries before step end; late observations use linked inspection/cleanup, never ended spans.

### Unverified Worker Markers

Use the [telemetry owner's closed marker schema](20260731-operational_telemetry_standardization.md): phase, environment preflight, native exit and shim error code; do not define another variant grammar.

Bind the exact Core-selected parent, validate the closed schema/budgets, and atomically check accumulated limits with append.

Clamp to the observed parent/receipt window; reject overflow, wrong ownership and ended-step input.

At admission, set `openkit.report.origin=worker` and boolean `openkit.report.verified=false`; marker events never decide outcome, retry, recovery, deadline or fences.

Marker loss is diagnostic, not work-data capture failure; no Sandbox SDK, OTLP exporter, new egress or credential is admitted.

## Effect And Deadline Semantics

Retry needs the retained declaration, actual receiver idempotence/non-execution proof, current authority and remaining allowance; changed declarations may revoke permission, never upgrade unsafe intent.

Never blindly redeliver unknown effects; missing dependencies preserve fences.

One deadline covers operation slot wait/delivery/execution/collection/retries; durable queue residence and human response retain their semantics.

Persist absolute expiry once; use monotonic remaining time locally, conservatively clamped after restart or clock uncertainty.

Children cannot extend parents; heartbeats cannot renew authority; cleanup has separate bounded attempts without implied successful release. Parent success or replay neither settles unknown children nor renews their authority.

Authenticate absolute expiry/remaining allowance, accounting for transit; never transport monotonic timestamps.

Optional W3C headers stay diagnostic; required deadline headers bind stored operations without changing JSON/file fingerprints, refusing missing/invalid/extending carriage.

## Global Dispatch And Physical Capacity

The in-memory index holds eligible identities/earliest due times; boot pages server and validated Workspace open/due executions.

Both scopes' commits wake the same index/reconciler, including server-only image settlement.

Index-update failure invalidates that scope's index and rebuilds it before dispatch; every selection rereads and conditionally claims its owning row.

Preserve ordering/fairness with identity ties; reject stale/duplicate candidates, wake on capacity changes, and avoid all-database dispatch scans.

Resource tests select bounded handle/boot concurrency limits; deadline-bound backpressure cannot exceed them.

Pin only during local operations; eviction preserves work, reopen validates scope/version.

### Reservation Identity And Commit Gaps

A reserve invocation key is `(Workspace, execution, attempt, reservation-step invocation)` with immutable fingerprint and absolute admission deadline.

Its server row retains requested quantities, selected physical boundary, exact result and `held`, `refused` or `released` disposition, including cancellation tombstones.

Capacity debit and held result commit together; active-execution capacity derives from held rows, distinct from resident physical capacity.

Same key/input returns the exact result; changed input conflicts.

| Committed situation | Required continuation |
| --- | --- |
| W intent; no S row | Current, unexpired admission may apply same key; unavailable storage is not absence. |
| S held; W result absent | Inspect same key, commit W result; no second allocation or premature Worker start. |
| Definite no-capacity refusal | Retain refusal without debit. Later eligible admission uses a fresh invocation identity; never mutate/replay the refusal into success. |
| Cancel/release; S key absent | Atomically install released tombstone; delayed reserve must reject it. |
| Cancel; S held | Keep exact identity; prevent start and release only with required physical proof. |
| S released; W acknowledgement absent | Return retained terminal result; no double decrement or resurrection. |
| W unavailable; S held | Preserve capacity exclusion until physical inspection/fencing proves release. |
| S authority unreadable | Refuse server boot/admission; never reconstruct capacity from Workspace projections. |

Retain terminal identity until the original invocation cannot be admitted, at least through its deadline, with supported snapshot/restore preserving that protection.

A restore lacking that identity must refuse pre-restore invocations, not reopen admission for them.

### Physical Receipt Consumption

Every physical receiver, including Harness, retains its keyed result until the Workspace outcome transaction durably schedules consumption acknowledgement, retried by the reconciler after crashes.

Physical results owned by an active or closing Worker-Turn execution use that execution's Workspace outcome and consumption acknowledgement. Idle AgentSession lifecycle work is admitted by its existing exact Core binding owner, never by a historical Turn. For that Core-owned work, the existing lifecycle owner must durably consume the exact keyed result and commit its required physical-state transition before acknowledgement or retirement. Required Workspace capture or outcome publication still commits in its actual owner before the corresponding barrier releases. A closed Turn execution is never reopened for idle lifecycle work.

Wider idle-resident cleanup uses `core-idle-cleanup/v1` in the existing Core journal. Its existing cleanup, collection, release and receipt-consumption kinds retain the exact original bridge/delete request, resident, actor and physical Epoch. Intent precedes contact; the exact outcome and consumption commit before acknowledgement. The existing closed-resident recovery owner consumes retained results and continues a never-admitted delete after an acknowledged bridge close. An unfinished or unknown effect grants result-only inspection, never repeated contact or a renewed allowance; unavailable evidence preserves exclusion until the existing physical fencing owner proves absence. This definition adds no table, column, queue, retry or protocol and supplies no authority for prior Turn work.

The receiver conditionally accepts the exact consumer identity/receipt acknowledgement; only then may a successor retire the result.

Unavailable consumers block retirement and competing dispatch rather than discard evidence; this uses existing receiver receipts, not another ledger.

Receivers reject stale process/connection/Epoch/attachment identities; absence proof never establishes prior work success.

### Cross-Workspace Activation

Activation A->B is keyed: A commits intent; B atomically commits admission/execution, source evidence and receipt; A records the result.

B's eligibility depends only on B's local tuple, never scanning A's receipt or waiting for A's outcome commit.

Changed input under the same key conflicts; duplicates return B's result and first admission checks current target authority.

Server configuration/physical changes remain separate keyed effects.

## Failure Scope And Boot

[Owning-scope failure](../core/fault-tolerance.md) applies before cutover: unreadable/unsupported Workspace authority, missing required content or contradictory lineage quarantines that Workspace, preserving bytes and blocking unsafe operations.

Expose authorized diagnosis; never initialize empty replacement authority or trust projections.

Server/shared-authority failure refuses boot; user-private failure blocks dependent operations; rebuildable-index failure is not canonical loss.

Containment/writer uncertainty fences its actual affected scope; healthy Workspaces remain usable.

Establish server lock/foundations, validate scopes, build the index, then start the ordinary listener/reconciler without listener-dependent pre-listen cleanup.

[NanoHost backoff](20260802-nanohost_runtime_and_transport.md#core-outage-restart-backoff) remains stock systemd policy, not another retry daemon or deadline.

## Portability, Snapshot Closure And Garbage Collection

Workspace databases and all locally retained immutable closure travel together, independently readable without a source-server join.

Vault, server users/membership/configuration origin, server Knowledge shares, mounts/repositories, Host bindings and Worker volumes remain explicit external references with declared coverage.

Historical grants and server snapshots are evidence, not destination authority; unavailable external references remain unavailable.

Move requires settled effects and fencing; durable human history travels, unconsumed executable authority does not.

Restore verifies complete closure before admission and preserves active capture protection.

Outside capture, GC roots include live references, retained history and legal holds; serialize publication against sweep so pre-commit objects cannot race accepted references.

Quarantine forbids sweeping unreadable roots; failed GC preserves bytes and reports pressure.

### Deferred Thread Cold Tier

After `v0.1.0` (estimated 3–5 engineer-days), archive only terminal Threads with closed executions and no queued/open work: seal rows into one immutable digest-addressed Workspace object using [backup/move closure](20260704-workspace_backup_export_import.md), rooting referenced blobs, then one transaction conditionally replaces unchanged hot rows with an archive pointer.

Restore imports under current authority; purge retains a purged stub and deletes unheld archives.

Creation-time reclamation, secure deletion and Thread-keyed stable references make this additive.

If load tests fail, per-Thread hot-append databases are an unbuilt escape hatch; Workspace control remains centralized.

## Retained Work Data And Cost

Retention owns records, privacy exclusions and default-on capture; steps reference IDs/digests.

**SOURCE-RETENTION:** every producer, including worker shim, NanoHost and Sandbox-side owners, retains the admitted data it owes NanoCore until NanoCore durably acknowledges it, and resends unacknowledged data with stable idempotent sequence numbers in the existing operation/producer scope. Identical redelivery resolves through the original receipt or durable capture cursor; conflicting bytes for the same sequence refuse. Transport acceptance, reconnect, a new baseline or producer cleanup is not a durable acknowledgement. Existing privacy exclusions still apply; this rule does not admit otherwise forbidden capture.

Reuse the producer's existing ownership: NanoHost `workspace_collect` pending pairs and worker-volume native transcripts are examples, not a new NanoHost buffer, ledger or state family. Correct acknowledgement, baseline-replacement and cleanup paths in those owners where necessary; retain or refuse rather than replace an unacknowledged pair. Core retains user-data authority and the accepted capture cursor; source copies are redelivery material, not canonical Workspace history. Core restart recovers durable receipts/cursors and requests the missing suffix from those owners without replaying effects. Missing source bytes produce truthful capture gaps, never fabricated completeness. Durable acknowledgement is the earliest release boundary, not permission to bypass any longer existing retention policy. The physical-receipt consumption rule is the effect-result instance of this same handoff rule.

| Retained slot | Workspace placement |
| --- | --- |
| Instructions, Items, Task/Turn and human interventions | SQL identity/order/decision/delivery; immutable messages and attachments. |
| Model I/O, requested sampling | SQL observer/model/snapshot/coverage and immutable ordered request/response roots. |
| Tool/native work | SQL correlation/outcome/coverage; admitted arguments/results and verbatim native transcripts in immutable blobs. |
| Environment/context | AEP/package/configuration/delivery/resource identities and retained inputs, prompts, Agent/Skill/MCP definitions. |
| Audit, permissions, usage/cost | Existing domain records, not duplicate journal ledgers. |
| Artifacts, changes, acceptance/evaluation | Version/review/outcome and candidate/rubric/model identities; retained outputs/check evidence, without activating Evaluation Harness. |
| Lifecycle and absent capture | Step timings/outcomes, failed checks, `turn.reap`, expected/unpublished and unavailable facts. |

Share lossless messages/parts, prompts and tool definitions by digest within authorized scope; preserve order, role, tool correlation and omitted-versus-present values.

Immutable request roots share content rather than repeatedly storing conversation prefixes; the retention owner chooses representation.

Stream bounded immutable chunks, one verified ordered SQL reference per chunk boundary, never per-delta rows; prefixes remain explicitly incomplete.

Cost follows unique retained bytes plus references/journal metadata; expiry leaves truthful unavailable references and respects holds.

| Current capture gap | Required receiver |
| --- | --- |
| Default-off full I/O | Default-on peer amendment; absent history stays absent. |
| Digest-only prompts | Retain exact admitted bytes once per digest. |
| CapabilityCall metadata only | Enabled observation producer; counts cannot reconstruct bodies. |
| Native-only transcripts/volumes | Verbatim incremental collector with explicit coverage; volumes alone are not collection. |
| Unsupported wire digest/context eviction/runtime context manifests | Preserve unsupported labels until a producer exists. |
| Gateway without Thread or lineage/database | Explicit gap; never invent an observation owner. |
| Crash, overflow, rejection, missing events | Preserve committed prefixes/failure facts, never successful empty capture. |

## Replacement Inventory

Paths use `apps/nanocore/src/`; preserve domain logic.

| Existing authority/path | Replacement / deletion |
| --- | --- |
| Canonical Workspace/Thread/Turn/AgentSession JSON, Items JSONL; `lib/store.ts`, `storage/workspace-file-records.ts` | Product SQL; delete file truth, whole-Workspace rewrite, cache-before-persist and publication repair. |
| Artifact/review/proposal/configuration metadata; Notebook publishers | SQL records/heads/receipt/Audit over immutable versions; delete Git-ref commit authority and cross-file repair. |
| `scheduler_admission_entries` | Executions/index; delete global durable queue and local publication predicates. |
| `worker-environments/worker-environment-activation.ts`, dispatch `activationPublicationComplete` | Keyed A->B admission and B-local evidence/receipt; delete cross-Workspace source scans. |
| `scheduler_execution_attempts` | Execution/step attributes; delete duplicate phase lifecycle. |
| `worker_turn_checkpoints`, `runtime/worker-checkpoints.ts` | Intent/outcome plus atomic products; delete stage mirroring/checkpoint joins. |
| `worker_backend_sessions` | Preparation/cleanup steps; delete parallel lifecycle and handoff flags. |
| `worker_control_records`, `worker_control_sequence_fingerprints` | Workspace observation/fingerprint and step evidence commit together; preserve divergent-replay rejection. |
| `worker_image_settlements` | Server execution/steps in ordinary discovery; delete deferred-settlement lifecycle. |
| `pending_requests`, pending flow/captured-call modules | Existing signals plus ordinary delivery steps; delete boot-only delivery/publication repair. |
| Recurring schedules/occurrences/expired ranges/external admissions | Workspace records and engine timers; delete scanner/restart publication repair. |
| Scheduler restart, NanoHost attempt recovery, maintenance service | Ordinary inspection/deadline/cleanup; delete separate classifiers/loops. |
| Worker recovery/operations/failure, cancelled-checkpoint cleanup, backend-cleanup projection, mode-entry closeout | Delete checkpoint reconstruction/release and fill-only repair; preserve diagnostics/new-request admission. |
| `recoverRunningCapabilityCalls` in `capability/usage-ledger.ts` and its boot call | Ordinary call-loss step settlement; preserve usage family, delete boot-only unknown classifier. |
| `storage/work-observation-recovery.ts` | Publish `turn.reap` in ordinary terminal transition, not restart-only recovery. |
| `runtime/task-terminal-fact.ts` repair | Fact and Turn share transaction; delete fact-to-file scan, preserve Task facts/Goals. |
| `storage/work-observations.ts`, mutable `observations.jsonl` | SQL observation metadata/order/sequence; immutable bodies; delete mutable-file publication. |
| `runtime/worker-control-rebuild.ts` | Retain only disposable handle reconstruction from committed authority, or delete; no outcome classification. |
| AEP/context publishers, workspace-sync/snapshot-chain joins | Storage handoff and local result/handle/cursor commit; delete unsynchronized publication and completion flags. |
| Executor command waiter; worker-shim Harness outage budgets | Remaining-deadline context; delete untimed wait/fresh allowances, preserve serialization/exact receipts. |

Preserve physical runtime/transport/binding/token/image authorities, rejected-control evidence, synchronization/review/apply, Audit/permission/usage/evidence, app business and Goal/Task fact families.

Seven coordination families become `executions`, `execution_steps`, `execution_resource_reservations`: **7 -> 3**; signals, four recurring/event families and moved product families are reused.

The separate capture-record family prevents snapshot-versus-GC loss.

## Disposition Of The 27 Recovery-Required Ingress Classes

| Class | Replacement fate |
| --- | --- |
| 01 Incomplete command/source publication | Local gaps eliminated by admission tuple; cross-Workspace activation remains keyed effect/result gap, without source scans. |
| 02 Request/checkpoint/input mismatch | Delete checkpoint join; input conflicts refuse, corrupt linkage quarantines. |
| 03 Duplicate/ambiguous session | Local uniqueness; native predecessor proof remains required. |
| 04 Active Turn/session conflict | Atomic exclusion; real work waits, contradictory ownership quarantines. |
| 05 Unsupported continuity inspection | Block inspection, then unknown at closure boundary; restore dependency or fence. |
| 06 Missing AEP/native proof | Missing required content quarantines; absent native proof blocks resume. |
| 07 Storage generation conflict | Physical fencing; no successor attachment without absence proof. |
| 08 Prepared setup changed | Pinned input and conditional transition refuse; settle old effects before new admission. |
| 09 Missing capture binding | Local admission binding; no current-default substitution. |
| 10 Task/Knowledge/Item contradiction | Validate references; quarantine corrupt authority, preserve external unavailability. |
| 11 Partial handoff | Atomic local publication; cross-scope exact-result inspection. |
| 12 Invalid Context trace/bytes | Immutable-before-reference; lost content never rebuilt from current data. |
| 13 Unknown command/result | Intent permits bounded inspection; deadline/cancellation/Worker loss ends unknown; later inspection is linked, never blind redelivery. |
| 14 Receipt/sequence contradiction | Atomic local observations; divergent replay conflicts. |
| 15 Pending/grant/effect/delivery gap | Signals/steps; external uncertainty remains explicit. |
| 16 Collection/cursor/transcript mismatch | Atomic cursor/result; source loss stays incomplete. |
| 17 Terminal/checkpoint/receipt disagreement | Atomic terminal tuple; lost referenced bytes still fail. |
| 18 Missing cleanup proof | Closing remains fenced; explicit inspection may be necessary. |
| 19 Ineligible adoption/unresolved cleanup | Ordinary unknown/cleanup; R remains an ablation candidate. |
| 20 Retry: missing checkpoint | Classifier deleted; read execution/original receipt. |
| 21 Retry: missing Turn | Quarantine integrity failure. |
| 22 Retry: assignment mismatch | Atomic assignment; corruption quarantines and fences. |
| 23 Retry: missing AgentSession | Quarantine, never synthesize identity. |
| 24 Retry: wrong session scope | Refuse; never relocate session to repair. |
| 25 Retry: absent/multiple attempts | Execution linkage/exclusion; disputed physical owners require fencing. |
| 26 Retry: terminal disagreement | Atomic terminal tuple; successor still requires fence eligibility. |
| 27 Deferred image settlement | Server boot/commit discovery; exact-result inspection, lost witness remains unknown. |

## Ablation Plan

Remove one mechanism at a time against unchanged fault oracles; retain it unless evidence and the governing decision permit deletion.

| Removal | Failure / gate |
| --- | --- |
| Single-owner durable pipeline: compare duplicate/serial publication with parallel file cohorts and one sync per changed directory | Report full sync counts and the 200/s profiles without relaxing FULL. Removing any required file/path barrier must fail content-before-reference/reopen fault oracles; removing redundant ancestor/cleanup syncs must not. Prove startup removes only abandoned private names. |
| Natural batching versus K-deep in-flight pipelining | First prove one Turn at 20 committed/s with one commit in flight, bounded FIFO savepoints, ordered ACK and failed-successor refusal. A single SQLite writer cannot commit K transactions concurrently. MAIN may propose the smallest necessary overlap only after a measured preparation bottleneck survives natural batching; no K is prescribed. |
| Throttled progress coalescing | Compare per-change publication with first-idle-immediate, then at least 100-ms coalescing. Report syncs, batch sizes and latency; barriers bypass the delay, every retained record/byte survives, and canonical visibility still follows FULL. |
| SOURCE-RETENTION | Lose a Core ACK, restart/reconnect, and attempt producer cleanup or baseline replacement: the existing source owner must retain/resend the identical sequence until durable acknowledgement. Prove exact receipt/capture recovery without effect replay or a second buffer; report unavailable-source gaps truthfully. |
| R survivor adoption | Core dies during work: `scheduler-restart-recovery.test.ts`/`worker-first-release-faults.test.ts` prove exact observation or truthful interruption, fencing and new-Turn resume; report availability cost. |
| Preparation 25-minute clock | Stalled preparation: `worker-first-release-faults.test.ts`/`turn-executor-factory.test.ts` prove parent deadline bounds authority. |
| Image 300s, Sandbox-ready 120s, native-open 60s, native-request 8s, separately | Stalled dependency/uncertain stop: `turn-executor-factory.test.ts`, shim `native-startup.test.ts`, adapter faults. |
| Core command 300s and untimed slot wait | Blocked/lost dispatch, late result: `nanohost-harness-records.test.ts`, `worker-first-release-faults.test.ts`, shim `harness.test.ts`. |
| Worker poll/result 300s, separately | Lost header/body/ack: shim `harness.test.ts`/`control-client.test.ts` exact receipts. |
| Exchange 1s / retry pacing 250ms, separately | Hung exchange/hot loop: same transport faults; resource bounds remain necessary. |
| Execution authority 2h | Runaway live Worker: `scheduler-restart-recovery.test.ts`/`worker-first-release-faults.test.ts` enforce expiry. |
| Heartbeat 30s | Dead Worker holds capacity: `worker-control-gateway.test.ts`/`worker-first-release-faults.test.ts`; silence is not non-execution. |
| Reconnect allowance / boot adoption 5m, separately | Repeated restart cannot renew authority: `scheduler-restart-recovery.test.ts`/`control-client.test.ts`. |
| Native stop 10s / cleanup tail 4s, separately | Hung close remains fenced: shim `lifecycle-deadline.test.ts`/adapter faults. |
| Core live-export / Host helper 300s, separately | Lost collection remains incomplete: `workspace-snapshot-chain.test.ts`/`turn-executor-factory.test.ts`/Host collection tests. |
| Gateway pre-commit 120s, waits 1/2/4s, Retry-After 10s, separately | Outage/accepted-output uncertainty: Gateway execution tests, no post-commit retry. |
| MCP SDK/fetch bounds, health 15s, idle 60s, separately | Hung call/stale session/leak: `worker-mcp-gateway.test.ts`. |
| Host startup 120s, stop 30s, restart delay, separately | Unready Epoch/survivor/outage storm: Host Epoch/installer/service tests. |
| Process key | Wrong survivor: `scheduler-restart-recovery.test.ts`/`worker-control-gateway.test.ts`. |
| Connection generation | Delayed old carriage: `nanohost-harness-records.test.ts`/Host transport tests. |
| Physical Epoch | Replaced Host claims absence: `scheduler-restart-recovery.test.ts`/Host Epoch tests. |
| Attachment generation | Old writer reaches reattached volume: `worker-storage-bindings.test.ts`/Host volume tests. |

Capacity, human waits, health/reclamation and cleanup pacing are not execution clocks.

## Implementation Plan And Acceptance

Remove obsolete responsibilities with replacements; move tests without weakening oracles.

Admission preparation may land unused native handlers/schema before public activation; it does not satisfy public admission or mixed-load acceptance. After this amendment is accepted, prove that separate read-only/query-only product handles reject writes and each database's worker-owned families use its pinned worker. Instrument ordinary producers to prove that Main never mutates those families, including any measured whole-family switch and its receipt/Audit partitions and pruning. Do not require retained legacy writable connections to reject all writes or move their unmeasured families. Qualify complete native tuples, the committed-load and natural-batching profiles, durable-publication/synchronization observations and SOURCE-RETENTION recovery, real per-effect Main contention with the required dose and BEGIN observations, and the separate per-sibling isolation criterion above. Re-run the same real-effect profile after each justified writer switch; moving a proxy cannot satisfy this gate. No loss, dangling reference, early acknowledgement, stale-revision success or unauthorized cross-family mutation is permitted. Earlier failed qualifications remain failed; this document supplies no implementation proof.

| Order | Increment | Gates to extend |
| --- | --- | --- |
| 1 | Workspace quarantine and stock Host backoff | Startup/layout/readiness and service/installer faults; healthy siblings serve, corrupt server refuses boot. |
| 2 | Immutable handoff and product/control SQL | Canonical-write-capacity/observation-recovery/pending-publication faults before/after sync/commit: no dangling references/cache. Real concurrent transitions through the grouped worker: commit/acknowledgement/savepoint correctness, exact acknowledged receipts after reopen, no loss and main event-loop delay p99 <= 25 ms through the design load envelope, explicit refusal beyond it, 32 MiB WAL cap. |
| 3 | Engine/journal/signals/timers/deadlines | First-release/restart/pending/recurring/shim faults; open intent survives, ended steps skip, later-Turn delivery, no replay. |
| 4 | Global index/handles/reservations | Both commit gaps; absent-key cancel then delayed reserve; refusal then fresh admission; restored tombstone; missing Workspace/cache eviction. |
| 5 | Retention placement, snapshot closure, ablations | Observation/export/snapshot-chain faults; exact shared content/prefix coverage; capture crash and explicit abandonment; Storage GC and Git prune/repack remain excluded. |

Additional deciding crash cases:

- `runtime/nanohost-harness-records.test.ts`: settlement -> crash before Workspace outcome -> competing dispatch cannot retire the result; acknowledgement replay permits succession.
- B activation admission -> crash before A outcome -> B is locally eligible and A recovers the exact receipt without duplicate Turn or source scanning.
- Server-only image-settlement restart test: with no Workspace execution, the ordinary reconciler discovers and settles the retained image effect/result.
- Lost native result -> terminal unknown and separate linked inspection; product terminality alone never releases exclusion.
- Call loss, `turn.reap` and Task terminal fact settle through ordinary transitions without boot-only scans.
- Span round-trip preserves double `1.0`, exact int64 beyond JavaScript safe integers and dropped counts; all marker variants preserve stored/exported trust keys. Open roots/steps and late Host observations obey lifecycle/sample rules without changing control.

### Acceptance Dependencies

Acceptance is conditional on integrated peer amendments, not promises of later alignment:

- [Work Data Retention](20260921-work_data_retention_format.md): default-on admitted model I/O/native transcripts, separate privacy exclusions, exact-byte/prompt/tool/prefix coverage tests.
- [Backup/Restore/Move](20260704-workspace_backup_export_import.md): minimal `v0.1.0` operations, common-cut writer coverage, durable capture exclusion, closure and restore tests.
- [Operational Telemetry](20260731-operational_telemetry_standardization.md): journal-only durable-trace exception and bounded unverified marker validation/export tests.
- [Worker-Reported Phase Markers](../decisions/20261019-worker_reported_phase_markers.md): the telemetry owner supplies the closed marker variant schema and projection.

Qualify systemd versions, resource limits, all 27 dispositions and individual ablations through direct tests; this documentation supplies no runtime proof.

Cutover uses one authorized pre-`v0.1.0` reset, without converters/legacy readers/dual writes/mixed deployments; subsequent continuity follows Core.
