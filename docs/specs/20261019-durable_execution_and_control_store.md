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
- [Permissions](../core/permissions.md) and [AgentSession](../core/agent-session.md).

## Related Docs

- [Storage Layout](20260703-storage_layout_record_ownership.md), [Storage Service](20261018-file_storage_and_knowledge_packages.md), and [Notebook](20260909-knowledge_notebook_editing.md).
- [Scheduler](20260703-durable_scheduler_design.md), [Scale](20260703-runtime_scheduling_scale.md), [Bootstrap](20260704-nanocore_bootstrap_readiness.md), and [NanoHost](20260802-nanohost_runtime_and_transport.md).
- [Pending Requests](20260531-human_attention_intervention_model.md), [Recurring Triggers](20260711-scheduler_recurring_event_triggers.md), and [Test Strategy](20260529-test_strategy.md).

## Commit Rule And Scope Layout

One owning SQLite transaction commits state, journal, dependent local records and receipt; resolve uncertain acknowledgement through that request identity.

Synchronize and verify content before references; publish caches/notifications after commit.

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

### Write And Space Budget

Core serializes each Workspace database through one in-process writer queue in WAL mode; group ready transitions into one transaction, preserving individual conditions/atomicity, acknowledging only committed groups.

Bound read transactions; enforce tested WAL size/age limits through checkpoints/backpressure.

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
| Execution | Existing work/operation identity, immutable scope/input identity, execution-definition version, current step, terminal cause and exclusion. Worker execution belongs to one Turn; Task lineage remains unchanged. |
| Step | Exact invocation/actor, intent/outcome, fingerprint, permitting decision, authority/fences, references, retry declaration and deadline. Intent precedes effects; outcome and next transition commit together. |
| Signal | Existing Pending Request identity, first valid decision and delivery linkage; same identity/content returns the result, changed content conflicts. Existing withdrawal/late-outcome rules apply. |
| Timer | Existing deadline/next-due and recurring families; conditional consumption in the owning transaction, preserving due instants across restart. |

Execution phases: `open`, `closing`, `closed`; step states: `intent`, `completed`, `failed`, `unknown`, `cancelled`; only intent is nonterminal, ended steps immutable/skipped.

One release-authored execution-definition version and closed step kinds govern interpretation; unsupported required semantics fail closed, descriptive additions remain ignorable.

Claims and outcomes condition on unchanged execution/current step; constraints enforce Thread/AgentSession single flight and effects recheck authority.

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
| Separate control | Work/attempt identity, step kind, input/output references, fingerprint, authority, retry permission, deadline and physical fences. |

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

Children cannot extend parents; heartbeats cannot renew authority; cleanup has separate bounded attempts without implied successful release.

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

| Order | Increment | Gates to extend |
| --- | --- | --- |
| 1 | Workspace quarantine and stock Host backoff | Startup/layout/readiness and service/installer faults; healthy siblings serve, corrupt server refuses boot. |
| 2 | Immutable handoff and product/control SQL | Canonical-write-capacity/observation-recovery/pending-publication faults before/after sync/commit: no dangling references/cache. Many concurrent Turns within one Workspace plus several Workspaces measure commit-latency p99/WAL peak/age to select limits. |
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
- Integrate/link the decisions-directory record `20261019-worker_reported_phase_markers.md` with telemetry; it is not yet on this branch.

Qualify systemd versions, resource limits, all 27 dispositions and individual ablations through direct tests; this documentation supplies no runtime proof.

Cutover uses one authorized pre-`v0.1.0` reset, without converters/legacy readers/dual writes/mixed deployments; subsequent continuity follows Core.
