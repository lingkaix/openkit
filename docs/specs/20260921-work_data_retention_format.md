---
status: Accepted
implementation: Partial
kind: concept
date: "2026-09-21"
updated: "2026-10-19"
---
# Work Data Retention Format

## Export Purpose Clarification

Export preserves admitted work data for external analysis, evaluation, audit, and other external use. Lossless re-import into OpenKit is not an export requirement; operational backup, restore, and MOVE are governed separately by [Workspace Backup, Export, Import, And Data-Root Migration](20260704-workspace_backup_export_import.md). Goal-specific storage and export redesign are frozen pending the engineer's product Redesign. This changes neither existing retention and access boundaries nor the facts of prior implementation checks. See [the engineer's decision](../decisions/20260928-goal_freeze_and_export_backup_boundary.md).

## Summary

This specification owns retained work-data completeness: capture coverage, native content, envelope/index semantics, references, observer attribution, and truthful gaps. OpenKit retains valuable observed work data without predicting later extraction, comparison, improvement, scoring, evaluation, audit, fine-tuning, or post-training. Anonymization and use-specific filtering happen at use time, not capture. The [engineer decision](../decisions/20261019-work_data_retention_completeness.md) owns the reason for default completeness.

Storage owners decide physical placement, canonical commit points, and projections. References below to JSONL, directory manifests, and file synchronization describe the applicable file representation; they never require a second canonical write beside a control-store row. Core retains Thread, Turn, Item, and AgentSession meanings. This specification introduces no store or migration.

The unique first-release criterion is: for every class of information that will only be collected later, the first-release format MUST let a reader distinguish "was not collected then" from "did not happen then". A format that cannot make that distinction would later claim completeness by default, which cannot be repaired after production data exists.

## Owns

- The purpose of retained work data and the judgement that admits a fact into the work-data record.
- Completeness of observed work data and its explicit exclusions; anticipated use is not a capture-admission gate.
- The four collection points and the facts each point uniquely knows.
- The two record families on different axes: the protocol Item stream and the observation ledger, including join, location, and family discrimination.
- Observation-ledger split-envelope header semantics, the open `type` vocabulary, `ret`, B′ content bounds, `refs`, `corr`, `parent`, coverage binding, and the three uncertainty expressions that belong to this format.
- Capture-time identity and configuration-fingerprint slots that the format must carry even when a producer is absent.
- Import remint and reference-resolution closure for observation records.
- Durability obligations of the observation append path relative to publication.

## Does Not Own

- Physical `DATA_ROOT` layout, source-of-truth decisions for file-backed versus SQLite records, the Workspace SQLite transaction boundary, storage-structure extension rules, or what `turn.json` is as a file. Those remain with `docs/specs/20260703-storage_layout_record_ownership.md` (`Owns`). This spec owns observation-ledger semantics and the meaning of coverage and identity fields that `turn.json` already carries; it MUST NOT restate directory trees or invent a second transaction owner.
- Core definitions of Workspace, Thread, Turn, Item, Artifact, ApprovalRequest, or AgentSession.
- Table DDL, ORM layout, or query design.
- Indexing, BM25, or multimodal semantic search ([decision](../decisions/20260920-retention_excludes_indexing.md)).
- Physical Storage/backend selection and control-store lifecycle; the existing Storage and durable-execution owners decide them.
- CapabilityCall, AuditEvent, UsageRecord, PermissionDecision, VaultUse, EvidenceBundle, and RuntimeEvidence as second truths. Observation records MAY `refs` their ids; they MUST NOT become a competing ledger.
- Delayed user-input protocol (blocking versus non-blocking gates, `expired`/`superseded`/`withdrawn` writers, cross-owner attention aggregation). That line has a separate owner.
- The AgentSession uncertainty axis. No accepted owner has ruled it.
- Evaluation Harness implementation. `docs/specs/20260711-evaluation_harness_design.md` owns that surface; this spec only requires that the data needed for later eval not be unrecoverably lost.

## Core References

- `docs/core/storage.md`
- `docs/core/protocol.md`
- `docs/core/core-concepts.md`
- `docs/core/work-model.md`
- `docs/core/agent-session.md`
- `docs/core/mediation.md`
- `docs/core/contract-evolution.md`

## Related Docs

- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260703-schema_evolution_record_envelope.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`
- `docs/specs/20260704-agent_session_continuity.md`
- `docs/specs/20260704-workspace_backup_export_import.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260802-nanohost_runtime_and_transport.md`
- `docs/specs/20261002-goal.md`
- `docs/specs/20260908-generative_kernel_data_operations.md`
- `docs/specs/20260703-runtime_scheduling_scale.md`

## Goals

- Retain, on the agent-loop axis, the facts needed to explain why an Agent ran as it did, what it did, what was observed, and how the work was evaluated.
- Do not snapshot unrelated world state. Actual file/attachment content already present in observed model/tool/native work remains captured input or output.
- Preserve valuable observed data without selecting an anticipated use; resume, summaries, and current analysis needs must not set the capture floor.
- Make missing data distinguishable from wrong data, and missing collection distinguishable from non-occurrence.
- Keep the protocol Item stream as the user-visible narrative and the observation ledger as annotations on a different axis.

## Non-goals

- Do not copy a durable-execution harness or invent a generic resume engine.
- Do not resume the same execution identity after interruption; succession uses retained data on the same Thread only through a new authorized Turn under [Core AgentSession Replacement](../core/agent-session.md#replacement).
- Do not add standalone working-tree/CRDT snapshots or keyboard capture; this does not discard bytes already observed in admitted model/tool/native work.
- Do not promise exactly-once external effects.
- Do not add a second work state machine or a second product scheduler.
- Do not pre-build a signature chain or tamper-evident ledger. Ordinary checksums MUST NOT be advertised as that guarantee.
- Do not capture OpenKit-held or injected credentials, authentication headers, provider keys, or Vault material. Do not add an unobserved private-state probe or a raw-audio capture feature.
- Do not add data-use consent, training permission, or purpose flags. Current read authorization, audit, legal holds, and deletion rules remain binding.
- Do not turn the product into Event Sourcing.
- Do not implement the Evaluation Harness in this contract.
- Do not add row-level TTL, tombstone rows, a CaptureBatch owner, or a per-thread coverage changelog.

## Background

An Agent is a model plus a runtime. Work records therefore equal agent observations (model-side interactions that pass through Gateway, plus runtime kind, version, and environment) plus external intervention and Core decisions (user input, interrupt, approval, product acceptance). Agents are cheap scheduling units: the system does not restore an interrupted execution in place. The environment is not deterministic; reversed tool-call order from network jitter is an accepted outcome, and a perfectly recorded outbound call still does not prove that a third party processed it.

Earlier default-off capture conserved storage but permanently lost model and runtime content before its future value was known. Default-on capture now preserves observed work, with explicit lower settings and truthful historical gaps. Lossless model I/O remains separate from proof of execution. Configuration fingerprints, task-instance identity, and outcome provenance remain required; neither a new default nor a new collector reconstructs an absent historical fact.

## Decision

Keep protocol Items and split-envelope observations as separate logical families. Default Capture Coverage to on and bind the effective policy before governed work. Store native content through the existing Storage Service and keep only envelope/index facts and references in control records. B′, existing effect uncertainty, Core Turn statuses, and owner-specific durability remain binding. Normalized messages and training/evaluation datasets are derived use-time representations, not stored truth.

## Contract / Expected Behavior

### Purpose And Retention Criteria

**Definition.** Retain valuable observed inputs, outputs, context, actions, decisions, and judgments as completely as possible. Later use does not determine capture eligibility. Keep actual observation separate from an inferred cause or a reconstructed view.

**Exclusions.** Do not snapshot unrelated world state or collect unexposed private state. Never capture OpenKit-held/injected secret material. Observed provider payloads and native transcripts otherwise retain their content, including fields that an earlier semantic filter omitted; restricted access does not require a demonstrated future use.

**Authority.** This spec owns the admission judgement. Core owns Thread/Turn/Item meanings. Existing evidence families own their own records.

**Lifecycle.** Facts are captured at the moment they exist. Capture-time identities and coverage cannot be backfilled. Collectors MAY be added later only when the format already distinguishes their historical absence from non-occurrence.

**Failure.** Wrong data is worse than missing data: an Agent compensates for a gap and cannot compensate for a false authoritative fact. Inferred content MUST be marked. A silent drop of collected bytes is wrong data, not a gap.

**Acceptance.** A reader can tell, for each declared collection class, whether that class was off, attempted and failed, submitted and later unavailable, or never applicable. Eval can group runs by resolved configuration identity without reading world-state snapshots.

Multi-dimensional eval requires, as format slots even when empty: provider plus resolved physical model id plus snapshot when the producer exists; harness kind plus the measured identity this spec defines; system-prompt digest at the pre-adapter semantic boundary; sandbox image digest plus resource configuration; AEP `packageSnapshotId`; per-skill id and version; per-MCP id, version, and exposed tool set; named requested sampling fields. Digest here is a grouping key, not an integrity proof. Task-instance identity is capture-time and orthogonal to Thread: one Goal task may span many Threads and many Turns. Outcome labels come from existing Artifact Review decisions, automatic signals (tests, builds, exit codes), process signals (steps, tool counts, human interventions, cost, duration, compaction), and LLM-as-judge records that MUST carry judge model and rubric version.

### Collection Responsibility

**Definition.** Four points each record only the facts they uniquely know.

| Point | Unique facts | MUST NOT be trusted for |
| --- | --- | --- |
| Gateway (`llm-gateway`) | Complete model-interaction body when collected, resolved model, token/cost | Sandbox-internal execution |
| NanoHost (`nanohost`; outside the sandbox, under our control) | What was actually injected: image digest, AEP, mounted skill/MCP versions, resource configuration, container lifecycle | In-sandbox tool detail |
| Sandbox sidecar (`worker-shim`; inside the sandbox) | Actual tool execution and return, process events, harness-internal state | Authorization and identity; it sits inside an untrusted boundary |
| Core (`nanocore`) | Actor, authorization decisions, approvals, product acceptance | Agent-internal behavior |

The NanoCore observer directly observes its own loop and mediated calls. The restriction on Agent-internal behavior applies to behavior outside that observer's boundary.

**Exclusions.** This is not a two-way choice between sidecar harvest at end-of-work and Gateway intercept. Configuration fingerprints are recorded by NanoHost, not self-reported by the sidecar. Sidecar reports stream incrementally; end-of-work bundling is forbidden because a crash is the diagnostic case. Managed backends that admit neither sidecar nor Gateway MUST declare the coverage gap so eval cannot mix them with self-hosted runs.

**Authority.** Each point writes only in its observer value `obs`. NanoHost owns injection identity. Core owns authorization records.

**Lifecycle.** Create on observation. Sidecar lines MUST be appendable before sandbox exit. Retry of a collection attempt is a new observation or an idempotent publication of the same identity and same content, never a silent overwrite of a different fact. Two writers MUST NOT publish conflicting payloads under one observation `id`; a conflict is `recovery_required` for that line, not a pick-one merge. Downstream publication failure (blob fsync failed, append failed) is the writer's: the line is uncommitted, not a different observation.

**Failure.** Sidecar self-report of experimental conditions is invalid for A/B grouping. Workspace attribution without a Thread uses the existing Workspace capture/control owner, not a fabricated Thread file. Without Workspace attribution, use existing server Storage/control roots with explicit server-scope coverage. Missing lineage or storage is a declared capture failure, never permission to claim complete collection or invent a Workspace, Turn, or global capture owner.

**Acceptance.** A run's configuration identity can be grouped from NanoHost/Core facts without asking the sandbox to certify its own treatment. A crashed sandbox still has whatever the sidecar had already streamed.

### First-Release Capture Matrix

The incremental runtime/model collector topology is admitted below; collection points outside that slice retain their stated implementation obligations, with their remaining topology decisions still deferred to architecture/technology selection under their accepted owners. The table is the first-release byte-meaning contract. Empty unsupported slots are allowed only for cells this table marks Unsupported or Deferred. A Collect cell remains a required first-release producer even while its writer is unimplemented: absence is a missing producer, not permission to omit the cell. Real collection failures still record unknown or unavailable outcomes; those outcomes MUST NOT be used to reclassify a Collect cell as unsupported. Required metadata collection (the Collect rows) is independent of the full-I/O setting. Default-on full capture is an additional obligation, not proof that its collectors are implemented. The coverage switch governs full I/O families (model request/response bodies and other restricted originals), not these metadata cells.

| Cell | First release | Observation boundary | In-row | MUST NOT |
| --- | --- | --- | --- | --- |
| Configured provider and physical model | Collect | Dispatch attempt at the shared dispatch, not transport send and not stream completion | Provider identity and configured physical model id | Copy the whole provider request as `params:{...}`; treat dispatch attempt as a sent HTTP request |
| Provider-reported snapshot | Collect when a provider response exists | Response side | Snapshot as the provider reported it | Fill this cell from the configured model |
| Requested sampling | Collect | Admitted semantic request at the dispatcher-to-Pi boundary before stock Context/options mapping, not original entry JSON and not wire payload | Named fields with types and value bounds, including non-numeric reasoning effort as well as temperature. Fields retain the caller's admitted public-format names; no intermediate public-format conversion defines new capture bytes. Retained earlier captures keep their OpenKit-owned boundary meaning and remain interpretable under data continuity. | Guess omitted values from adapter defaults; claim effective/final sampling; invent a complete numeric-bounds schema |
| Wire digest | Unsupported; no producer | — | Empty slot labeled no producer | Describe the slot as collected |
| `context.evicted` | Unsupported; no producer | — | Format slot only | Describe eviction as collected |
| Internal-agent `env.bound` | Collect | Core | NanoCore build revision in `version` (exact source commit, or `<releaseTag>@<sourceCommit>` for a tagged build; `unknown` without injected identity), `workspaceId`, prompt digest; tools as name plus input-schema digest. For the #144 selected-Skills family, canonical `payload.assistantSkillAdmission` contains only `{catalogRevision,skills:[{skillId,versionId,contentDigest}]}`. This field is required before model dispatch on each new command-initiated Assistant Turn admitted by `conversation.submit` through this producer, including an empty selection. It is optional on retained pre-#144 observations and other internal-agent observations. | Substitute the package version, runtime environment or a live Git lookup for the captured build revision. Inline tool description or full schema; record a tool version (currently unavailable); inline prompt body. Skill names, descriptions, bodies, paths, credentials, full Tool schemas, or a second persisted selection or prompt. |
| Task-instance pairing | Collect | Turn creation | `(goalId, taskId)` on the Turn when applicable | Bind the key on the Thread; invent a Task for non-task Turns |
| `turn.reap` | Collect | Core recovery decision | `reason`, `lastObservedTs`, unresolved-call `corr`/`type`/`name`/`ts`, `inferredBy` | Inline full exception, stdout, arguments, or withdrawal-source summaries |
| Layer-3 runtime context manifest | Unsupported | — | — | Treat as first-release data |
| System-prompt digest | Collect | Pre-adapter semantic boundary | Digest only | Use `workerRequestDigest`; promise one hook; treat as full I/O |
| Harness identity | Collect | Bind and reuse | Authored `runtimeVersion` label plus copied image-digest value | Treat authored `runtime.image` or AEP `runtimeVersion` as measured version |

### Incremental Runtime And Model Content

Default completeness extends the existing incremental observation/content path, not a new capture system. Preserve collector coverage, observed origins, and causal parentage alongside native content. Runtime-internal children remain origins within the outer Thread, Turn, AgentSession and AEP, never additional Core execution identities. Required metadata records collector availability, observed origins and causal parentage, tool/activity phases, source coordinates and coverage failures independently of the full-I/O switch. A native spawn edge or parent declaration is parentage evidence; send/wait receivers are not. Completion of a spawn operation is not completion of the child.

Sidecar metadata and admitted content use existing authenticated worker-control collection. Declare expected content before transfer; a chunk receipt proves staging only. After length/digest verification and Storage publication, the existing capture owner commits the exact publication reference. Missing chunks leave expected-but-unpublished coverage. A stopped collector is not complete collection.

Gateway and runtime producers share this expected/publication rule through existing owners. Retry preserves identity and content; divergent replay is `recovery_required`. Receipt/fingerprint records never duplicate restricted bytes. No cross-store atomicity, provider re-execution, or reconstruction from summaries is implied.

### Lossless Model Exchanges

For every Gateway-observed model call with capture on, retain the actual native upstream request and observed response. Distinguish request preparation/transport handoff from proved delivery; a timeout never proves what the provider received. Fidelity is JSON-semantic, not a promise to preserve HTTP whitespace or transport headers. Preserve field values and types, ordered arrays, exact strings, and omitted versus null values. Retain provider-specific fields rather than filtering to a normalized allowlist; the secret exclusion below is the only content exception here.

When Gateway translation changes protocols, also retain the Worker-facing request/response exchange. Mark the provider, protocol, direction, translation boundary, actual route attempt, and logical-call association. A pre-adapter semantic request alone cannot stand in for the actual upstream request. A configured model is not a provider-reported model/snapshot.

The envelope/index references the native request and response roots and records existing call/attempt identity, provider and physical model, observed reported model/snapshot, usage, terminal status, and exact supplied parameters. Preserve temperature, reasoning effort and other named or provider-native parameters without filling omitted defaults. UsageRecord and CapabilityCall keep consumption and outcome authority; retained bodies are not another usage ledger.

For streaming, retain the provider-native event sequence in ordered bounded immutable chunks. The native sequence is the lossless form: final content, tool deltas, usage, partial failures, and cancellation can be derived from it. A normalized final message is not stored as a second copy. Worker-facing translated streams retain their own native sequence when different.

Record first-token and completion times as observed at the Gateway, with their clock/boundary identified. If no token or completion was observed, leave that fact absent with its terminal/coverage explanation; do not infer provider timing. Preserve event order and native event/framing semantics across chunk boundaries, including split UTF-8, JSON, and tool deltas. Chunks need not individually parse as complete events.

A chunk index carries only ordered publication references, byte ranges/counts, observed timing, source format, and prefix/terminal coverage. It is an index over native bytes, not an OpenKit stream-event format. Append each chunk once; do not rewrite the complete growing response for each delta. A reader must distinguish an open prefix, interrupted prefix, complete stream, missing chunk, and lawfully reclaimed content.

### Native Exchange Index Contract

Reuse the existing request/response observations and their `refs`; an index is immutable content referenced by those records, not a new mutable exchange family. The envelope/index supplies the following facts only when observed or already owned:

| Slot | Required meaning |
| --- | --- |
| Existing scope/call/attempt association | The actual Workspace or server owner and logical-call correlation; retain known Turn/Thread/Item associations without inventing them. |
| Native role | Distinguish `upstream.request`, `upstream.response`, `worker.request`, and `worker.response`; a translated role cannot substitute for its upstream role. |
| Format/boundary | Provider-native protocol/media/encoding and the observer boundary; distinguish semantic historical captures from new native capture. |
| Body/sequence root | Scoped Storage publication ref, digest, length and native-message/chunk index root where published; absence carries its coverage explanation. |
| Model/parameters/usage/status | Exact observed metadata or existing owner refs, with configured and reported values separate; unknown is not an inferred default. |
| Ordered chunk entries | Native byte ranges/counts, publication refs and source sequence; receipt order is not invented provider timing. |
| Observed timing | First-token/completion facts and their Gateway clock/boundary; a valid response with no token is distinct from missing collection. |
| Coverage/omission | Bound intent, actual producer availability, expected/publication evidence, partial/truncated/excluded ranges and disposal facts. |

These slots extend existing envelopes and content manifests, not Item schemas, CapabilityCall authority, or the lifecycle journal. Version required interpretation through the existing record/feature contract. Ignore safely additive descriptive content, but fail the affected record closed for unknown required semantics, invalid scope, or contradictory publication identity.

An index may describe an incomplete prefix. It may publish only verified committed chunk refs; expected but unpublished chunks remain expectations, not publication edges. Do not label a root complete while a required native range is missing. Preserve non-occurrence, an observed empty response, and a missing response as different facts.

When an upstream request was prepared but its delivery is unknown, retain the observed native request and delivery uncertainty. Never relabel it as provider-received input. A changed route attempt has its own observed native body and response association under the same logical call; summaries cannot erase an unsuccessful attempt.

### Content Addressing And Scope Placement

Structured-value encoding and exact-byte verification follow [Digest Stability](20260703-schema_evolution_record_envelope.md#canonical-structured-values-and-exact-bytes). New structured digests use the shared Protocol encoder; retained original bodies and delivered manifests remain exact bytes. Domain framing and actual delivery identity stay with this owner; normalization cannot replace original evidence.

Use the existing [Storage Service immutable content](20261018-file_storage_and_knowledge_packages.md) and the scope's existing control records. Workspace-attributed calls store their blobs and references inside that Workspace; backup or move includes their reachable closure. Calls without Workspace attribution use existing server-scoped Storage roots and an explicit server-scope coverage observation. Never invent a Workspace/Thread/Turn identity or a global capture owner.

The scoped-reference/staging prerequisite reuses the shared Storage reference's native case: explicit `knowledgeBaseId: null`, actual Server or Workspace owner, `backend-evidence` mount and `sha256/<digest>` path under that scope's existing `evidence/backend/` root. Knowledge references continue to require their exact real Knowledge Base ID. Current `work-capture` admission is a transient trusted-caller basis, not a retained grant, Knowledge authority or permission inferred from a digest. The existing owner authorizes each operation and consumes sealed staged bytes before publishing its references; Storage itself does not publish. This prerequisite changes no collector, capture default, Turn lifecycle or replay authority.

A call without a Turn binds its effective coverage in that existing scope before dispatch and references the existing call/attempt. A Workspace-only call resolves server -> Workspace policy; an unattributed call resolves server policy. Historical absent bindings remain unknown. Missing required binding/storage follows existing admission/failure rules, not a claimed successful capture.

| Retained shape | Completeness gap closed |
| --- | --- |
| Native exchange envelope/index with scoped call refs | Separates upstream from translated Worker-facing content and retains calls without a Turn. |
| Ordered message/part reference manifest | Preserves the exact request without serializing every prior conversation prefix again. |
| Prompt/tool-definition blob refs | Retains exact definitions rather than digest-only metadata or today's changed setup. |
| Native chunk index with coverage | Preserves stream/transcript order, timing and explicit missing/truncated ranges. |
| Context/judgment refs on existing observations | Attributes actual input and decisions without copying their owners. |

These are bodies/references of existing observation/evidence records, not independently mutable families. Keep raw body bytes out of CapabilityCall, audit rows, and receipt records. EvidenceBundle may retain its existing identity, access and publication lifecycle while Storage owns bytes; do not create a parallel EvidenceBundle body store. Existing retained references remain interpretable under their original boundary and owner.

Represent each request's messages as an ordered reference sequence. Hash the versioned RFC 8785 canonical JSON serialization of each native message/part; preserve array order, exact string content and null/omitted distinctions. Bind the canonicalization version and provider-native shape. Canonicalization must not round or coerce native values; unsupported numeric/encoding values retain their native-byte representation and an explicit indexing limitation, never a falsely lossless normalized value. Store system prompts and tool definitions once per exact digest and reference them from the request. Native transcript chunks retain raw-byte digests, not a reserialized JSON substitute.

Use structurally shared immutable sequence manifests, so append creates new message/part blobs and only changed manifest nodes. A request points to its sequence root; edits, tool-definition changes, and compaction create new roots without mutating earlier requests. Do not replace this with a full O(n) reference-array rewrite for every call, which still grows quadratically across a long conversation.

Storage cost is unique retained payload bytes plus changed manifest nodes, request metadata and owner records, not repeated conversation-prefix bodies. Append-only payload growth is about O(n); sequence updates add bounded chunk metadata or logarithmic path nodes. Buffers and hashing are bounded. No numerical compression ratio is promised.

Deduplicate only inside the authorized Storage scope. Equal digests grant no read permission or cross-Workspace existence probe. All retained referring records, holds and protected snapshots keep shared objects live under Storage's collection rules. Deletion of one reference must not reclaim another retained use.

Native transcripts and model bodies are collected incrementally when the immutable binding is on. Off still requires structural facts. Unavailable sources remain explicit gaps; unsupported cannot relabel a failed required producer. Streaming cancellation/error preserves the committed prefix without asserting success. Capture failure never triggers another model call.

### Capture Publication, Restart And Disposal

The existing capture owner declares expected content and applies the current bound policy; the Storage owner verifies and commits bytes before record publication. A complete publication proves retained bytes at that commit, not model delivery or external-effect success. A chunk staging acknowledgement alone proves neither.

Nested-call inputs and results required by this specification follow their existing content owners' retention rules after the caller settles. Operational replay-cache cleanup MUST NOT remove their only required retained copy.

Same identity and same content replay is idempotent through the existing owner. A changed digest, length, source range, or boundary under that identity is a conflict, not a silent replacement. Concurrent writers cannot choose different bodies for one observation. This adds no CaptureBatch, retry daemon, durable receipt family, or second transaction owner.

After restart, read committed coverage and exact publication refs. Preserve the committed prefix, inspect the same source/transfer identity where its owner allows, and report unavailable buffered ranges. Do not reconstruct bytes from UI text, current prompts, later native sessions, or a new provider call. Recovery uses existing owners and current authorization.

Pressure or a failed content/record commit cannot silently discard acknowledged work data. Refuse new publication or record a collector failure through its owner, preserving accepted bytes and uncertainty. Disposable telemetry's drop rules do not apply to retained work content. A required failure fact that cannot persist retains the owning fail-closed behavior.

Deletion, legal requirements, operator retention windows and holds stay with existing resource/Storage owners. Disposal may make a formerly published body unavailable; preserve the remaining id/digest and disposal explanation where that owner retains lineage. Never infer physical deletion from an export status or a missing backend read. This adds no sweeper, deletion ledger, or hold type.

Use-time filtering, normalization and dataset conversion read currently authorized originals. They do not overwrite the native roots or retroactively change capture coverage. A consumer pins its transformation/schema and preserves source refs when its existing owner requires derived lineage; this specification introduces no dataset product or export service.

### Capture Safety And Restricted Access

Never capture credentials or secret material OpenKit holds or injects: Gateway authentication headers, provider keys, Vault values, bootstrap/runtime credentials, and their resolved secret carriers. Exclude transport authentication before body capture. Check known secret values across a semantic unit and chunk boundaries so splitting a value cannot bypass exclusion. Decoded semantic checks apply within the 16 MiB semantic parser ceiling; above it, the raw and escaped forms are checked across chunk boundaries and the structural-extraction limit is recorded. This is a bounded secret boundary, not a general anonymization or content-classification engine.

If a unit cannot be retained without known secret material, refuse that unit and commit an anchored safety/unavailability fact. Keep other admitted units and explicit prefix/range coverage. Do not silently mask a body and advertise it as lossless. The existing bounded staging/semantic limits apply; overflow, interruption, or collector crash declares an incomplete/unpublished gap, never complete collection.

Everything else observed within the admitted capture boundary is retained verbatim under `restricted-raw`. Do not reject content because of an anticipated use, a generic sensitive-content label, or an unrelated credential-shaped string. Later anonymization/filtering belongs to the authorized use, not mutation of captured truth. This does not add a probe for data never exposed by a provider/runtime.

`restricted-raw` is an access class, not a demonstrated-need retention gate. Apply current source/record authorization and existing audited raw reads; the class grants no new audience. User deletion, legal requirements, operator retention policy and legal holds still apply through existing owners. Record reclamation/exclusion truthfully without a new deletion ledger or purpose/consent flags.

### Native Transcripts And Runtime Logs

Retain observed native transcripts verbatim by default in the harness's own format, including available child-origin streams. Record harness kind and version identity, its source/provenance, and exact native source/Turn association. An authored version label or preflight match marker is not a measured binary version. Preserve the admitted image identity and label separately; unavailable measured identity is an explicit gap.

Native stderr/log output is content. Retain its observed bytes under the same restricted-raw boundary, not in telemetry, ordinary Items, or safe diagnostic summaries. Current default: a combined 16 MiB stderr/log budget per Turn, adjustable through the positive-safe-integer `policy.workDataCapture.nativeLogMaxBytes` field. Select its value once into the admitted AEP's existing `observability.evidence.nativeLogMaxBytes`; native admission reads that exact immutable named snapshot, not current configuration. Missing or invalid historical native authority refuses native content rather than inventing a bound. The existing ON/OFF Turn binding and AEP coverage pair are unchanged; do not add a Turn budget member, duplicate the budget in `captureCoverage`, create a counter ledger or renew allowance through another package. This is a collection bound, not an outcome or retention-duration rule.

On limit, record captured byte ranges/counts, the configured bound, source and last observed position, and a truncation reason. State omitted bytes only when measured; otherwise mark the amount unknown. Silence, no source, disabled capture, collector failure and explicit truncation are distinct. A prefix must never look like a complete transcript/log. No body is converted to a normalized message format at capture.

The single required native-content codec is `native-content-v1`, fixing RFC 8785 interpretation without canonicalizing native transcript/log byte streams. Reuse `runtime.observed` with truthful `native-transcript` and `runtime-log` fact cases, actual `stderr`/`stdout-log` log-source classes and `application/octet-stream` for arbitrary bytes. Do not add parallel event, coverage-family, role, prefix-status or per-node version taxonomies. Existing terminal, coverage, range and publication facts describe the retained prefix; unknown omissions stay unknown. The scoped-reference and receiver/policy prerequisites activate no collector or default; activation remains a later coordinated cut, with all existing capture defaults still OFF meanwhile.

Use the existing worker collection channel, provenance guards, and pre-launch source watermarks. One shim parser may derive structural facts; it does not own a second native truth. Parser limits do not authorize discarding otherwise retainable raw chunks. A frame above the existing 16 MiB semantic parser ceiling is an explicit structural-extraction limit, not complete-looking collection. The worker-control owner retains its decoded chunk bound; optional full-provenance capability is not inferred from incremental capture.

### Context And Judgment Lineage

Record what actually entered model context and where it came from: injected Knowledge, Memory, Skills, attachments, Policy/AEP snapshots, system prompt and tool definitions. Existing assembly observations carry source/version/digest refs and the actual delivered model-message/part refs or ranges. This closes the gap between a configured source and bytes actually seen by the model; do not label a selected-but-undelivered source as input.

Reuse retained model blobs for delivered bytes rather than copying complete Knowledge originals or world state for replay. Reference-only source pointers can become unavailable under their existing owner. Historical model input remains reconstructible from captured message roots where coverage is complete; source attribution retains exact source identity/digest and availability, not today's substituted bytes.

Reuse immutable AEP and selected-Skill admissions; new capture observations may cite them but never enrich or rewrite an existing `env.bound` row. Keep original, representation, and delivered digests distinct. Runtime compaction/eviction or inside-only context unavailable to a collector remains an explicit gap, not a guessed complete context manifest.

| Judgment signal | Durable authority and required work link | Remaining collection boundary |
| --- | --- | --- |
| Approval/denial and Pending Request answer | Existing PendingRequest, deciding actor/time and request/raising Turn/captured call; link its durable resolution rather than infer it from text. | Retention linking/closure must cover all implemented answer paths; secret answers remain prohibited by their owner. |
| Artifact Review, correction and accepted edit | Existing versioned Review/Material/Item owner, exact judged revision/content digest, actor and resulting revision or follow-up Turn. | Generic user edits/corrections without an existing typed work link remain a named gap; do not infer a rating from an edit. |
| Retry or redo | Existing call attempt, command receipt or follow-up Turn and the work it retries; distinguish provider retry from user-requested redo. | Do not create another retry history or replay authority. |
| Ratings or agent/judge assessments where present | Existing assessment/review with target work, producer/actor, and applicable model/rubric version. | No universal rating collector or product is claimed where no feature/owner exists. |

A durable decision owner is not proof of complete retention joins. The collector inventory below must account for each implemented producer and explicitly list absent signals. Preserve contradictory or late judgments with their existing owner/version history; never replace them with an inferred final score.

### Journal And Telemetry Boundary

The [Durable Execution And Control Store](20261019-durable_execution_and_control_store.md) owns per-step timing, outcome, failed check, retry and recovery facts in its OpenTelemetry span-model journal. Reference that journal; do not duplicate its lifecycle into observation records. Journal control may reference retained work records by id/digest, but its spans/events never contain model, tool, transcript or log content. Phase markers remain unverified diagnostics, not a retention substitute.

Durable execution references nested-call bodies retained by the capture and content owners; span diagnostics and bounded model-visible summaries MUST NOT substitute for them.

Content never enters telemetry. A normalized cross-provider message view, for example a consumer's explicitly pinned OpenTelemetry GenAI message schema, is a derived use-time projection outside telemetry export. Training/evaluation dataset formats are also use-time exports, not storage formats or a new pipeline here.

### Product-Safe Read Projections

The UI projection is lossy and carries fixed structural labels plus bounded explicitly outward assistant text only when its source remains available and disclosure-safe. It is not a new retained content tier and cannot replace originals. The existing ThreadDashboard read enforces current Thread audience before reading source bodies, excludes native identifiers, raw tool bodies, credentials, reasoning and diagnostics, and cites source observation sequence. Its presentation bounds are owned by `20260628-web_product_surface_projection.md`, with omitted/truncated presentation declared. Historical absence is unavailable; collecting and partial describe the structural observation boundary, not Turn status. The coverage-state mapping belongs to the same Web projection owner. The projection separately carries contentCapture as off, on or unknown from the immutable binding; missing history is unknown. Full-content off never suppresses required metadata or gets presented as full-content collection. Existing approval, input and correction owners remain authoritative; child text cannot manufacture a pending request ([Pending Requests](20260930-pending_requests.md)).

**Acceptance.** Multiple and nested child facts survive a parent crash after Core receipt; missing terminal evidence stays missing. Full capture on preserves exact admitted bytes and off does not retain them. Restart replay cannot duplicate, overwrite, falsely publish or resurrect lawfully expired content. A private Thread cannot leak through timeline or evidence listing. A user can follow reported progress and actual pending requests without reading restricted bodies or inferring completion from parent success.

### Two Record Families

**Definition.** Protocol Items are the work line: requests, replies, user input, and interaction. Their owning record order is the narrative total order; an `items.jsonl` representation preserves that order. Observations are environment and system notes beside that line, not on it. They do not share order. `docs/core/work-model.md` already states that the thread narrative and ordered Item history remain the user-visible source of truth.

**Exclusions.** Do not merge the families into one sequence. Do not treat observation position as a narrative rank. Do not add envelope fields to protocol Items. Do not keep a thread-level `items.jsonl`; protocol `BaseItem.turnId` is required, so a thread-level item file cannot hold a legal Item.

**Authority.** Protocol owns Item schemas and discriminators. This spec owns observation semantics. `docs/specs/20260703-storage_layout_record_ownership.md:287`, under `Structure Evolution Rules`, already states the split: `items.jsonl` lines are protocol item event records; observation ledgers carry per-line `v`, `type`, `id`, and `ts`, with `ownerScope`, lineage defaults, and `requiredFeatures` in a directory-level manifest.

**Family discrimination.** An observation line has a `v` header field. An Item line does not. Family MUST be decidable from the line itself, not only from the path.

**Join.** When the same event appears on both families, the observation MUST anchor with `parent` to the Item `id`. `corr` MUST NOT be used as that anchor. The route chain of a logical call lives on its CapabilityCall under [the evidence owner](20260703-audit_usage_evidence_records.md#gateway-route-lineage), is not an observation type, and is not copied into `ext`. UI merge is not a contract. Pointer direction is observation → Item only.

**Three-tier location.**

| Case | Rule |
| --- | --- |
| A corresponding Item exists | MUST anchor to that Item (`parent`; `corr` only for request/response pairing of the same logical call) |
| No corresponding Item, but a Turn exists | Anchor only with `turnId`. MUST NOT invent a surrogate `parent` on an Item the observation was not assembled from (worker N-hop private transcripts, internal-agent in-memory messages) |
| No Thread, valid Workspace attribution | Use the existing Workspace capture/control scope, its bound coverage and call association; no invented Thread observation file or surrogate Turn. |
| No Workspace attribution | Use existing server Storage/control roots with explicit server-scope coverage and the existing call/attempt reference. |
| No usable capture owner/store | Required admission/publication fails under its owner; record the capture gap where possible. Never fabricate lineage or claim an absent body was collected. |

Multiple observations under one Item or one `turnId` are ordered by observation-file append order (ingest order). Late backfill MUST NOT be advertised as physical order; coverage MUST say so.

**Lifecycle.** Items follow protocol create/update/terminal rules. Observations are append-only lines. A Turn is the execution unit; observations that belong to a Turn carry `turnId`.

**Failure.** Cross-source `ts` order is a hint, not a fact. Four observers do not synchronize clocks. Network-reordered tool calls across sources are accepted. Missing interior `seq` values detect truncation of the observation file; a legal prefix after a lost last line is not detectable by `seq`. Item files detect torn tails by the last `0x0a` byte, not by `seq`. Pairing by `corr` is scoped to one logical-call group in one execution namespace (see References); bare `corr` MUST NOT be used as a global join key.

**Acceptance.** A reader can reconstruct the Item narrative without reading observations. A reader can place an observation relative to its Item or Turn without a cross-family sequence allocator.

### Workspace SQLite Boundary

**Definition.** Authorization/policy decisions, approvals, usage/cost and Artifact Review retain their existing transactional homes. Items and observations name logical record families, not a requirement to maintain canonical files beside a control database. The same durable id MAY appear as lineage, never as a second product model. Storage and durable-execution owners decide physical placement and migration.

**Exclusions.** This spec does not assign SQLite versus file homes, does not require every transactional row to have a same-id Item, and does not own Material content, bindings, or Generative UI declarations. BM25, vector, and run-index tables are rebuildable derivatives.

**Authority.** `docs/specs/20260703-storage_layout_record_ownership.md` (`Owns`) already owns source-of-truth decisions and the Workspace SQLite transaction boundary, including Material identity and version-keyed Artifact Review history. Each product fact's publication and recovery follow that fact's existing owner.

**Lifecycle.** Inapplicable as a new machine: create, update, terminal, retry, and recovery stay with the named transactional owners. This spec adds no cross-store commit order.

**Failure.** Conflict, missing, stale, restart, and dependency failure for those rows are the storage-layout and product owners' rules. This spec MUST NOT prescribe a universal "SQLite first, file repair from SQLite" procedure.

**Acceptance.** A reader can tell a transactional authorization or review fact from a retention-axis observation without treating this spec as a second storage owner.

### Observation Ledger Envelope

**Definition.** Observation lines use the split envelope from `docs/specs/20260703-schema_evolution_record_envelope.md`. Per-line header:

| Field | Required | Meaning |
| --- | --- | --- |
| `v` | yes | Schema-version discriminator and family discriminator |
| `type` | yes | Dotted `family.kind` record type, open vocabulary |
| `id` | yes | Stable addressable line id |
| `ts` | yes | Observer-local clock declaration, RFC3339 UTC milliseconds; not a sort key |
| `seq` | yes | Per-file contiguous from 1; truncation detection only; not a narrative key |
| `obs` | yes | Observer: `llm-gateway` \| `nanohost` \| `worker-shim` \| `nanocore` |
| `ret` | conditional | Core retention class when the row has a long-term or restricted class to assign; omitted means the type's default class from its owning write rule, not "no retention". See `ret` |
| `parent` | conditional | Scalar parent id: observation id or Item id |
| `corr` | conditional | Pairing key for one logical call's request and response; no external referent |
| `outcome` | conditional | `ok` \| `error` \| `unknown` on rows that describe an external-effect terminal |
| `cert` | conditional | Omitted = direct observation; `"inferred"` = writer inference or model/ASR generation |
| `turnId` | conditional | Present = Turn association; absent = the existing Thread, Workspace-call or server-call scope, never an invented Turn |
| `refs` | conditional | Self-describing external references; see References |
| `ext` | conditional | Namespaced extensions; MUST NOT pollute canonical fields |
| `payload` | yes | Main facts allowed by B′, shape per `type` |

`obs` identifies the observer, not the source or verifier of a reported fact. Before a remote producer writes records, its type-owned payload MUST distinguish source claims from independent verification and identify their source and evidence basis. `cert` continues to distinguish direct observation from inference; directly observing a report does not verify its claim.

**Retained observer names.** Writers emit only the observer values listed above. Retained version-1 records and exports may contain `core`, `gateway`, or `sidecar`. Readers map them to `nanocore`, `llm-gateway`, and `worker-shim`, respectively; the collection meaning stays unchanged. This read projection leaves existing ledger bytes and their version unchanged. Import verifies original source bytes and digests; the mapped view is not replacement evidence. Same-identity replay compares the mapped observation meaning, not the historical spelling. Unknown observer values and observer/type mismatches fail closed.

`ownerScope`, lineage defaults, `requiredFeatures`, and redaction defaults live on the directory-level manifest (`thread.json` / `turn.json` as the storage owner already assigns), not repeated per line.

**Exclusions.** `perc`, `span`, and `aud` are not fields. `payload` is not a lossless dump of arbitrary content. `refs` is not an array of bare digest strings. `parent` is a single id, never a list.

**Open `type`.** New kinds are new string values. Readers MUST NOT treat unknown canonical types as processed (`docs/specs/20260703-schema_evolution_record_envelope.md`, `Reader Contract`). Authority-bearing new behavior MUST also gate on `requiredFeatures`. Product UI MUST have a generic fallback renderer so a closed switch over types cannot crash on a new kind. Payload shape is per `type`; a type MUST NOT carry restricted or time-bounded bodies in-row (B′). Concrete payload fields for first-release types are the First-Release Capture Matrix. The storage-layout owner admits these concrete header names (C8); the directory-level manifest gates the family with `openkit.work-observations.v1`.

**Lifecycle.** Append only. Identity fields that naturally exist in `payload` are also in the header and MUST cross-check on decode; mismatch is corrupt, not a pick-one merge. Same `id` with different content is a conflict, not an overwrite.

**Failure.** Unknown optional `ext` fields follow envelope preserve-or-ignore rules. Unknown required features fail closed on portable import. A corrupt header (missing required `v`/`type`/`id`/`ts`/`seq`/`obs`, or `seq` not contiguous with surviving interior lines) fails that file's read, not a silent skip.

**Acceptance.** A sweeper can classify `ret` without parsing `payload`. A reader can reject an unknown type without guessing. Family is visible from `v`.

### Retention Class `ret`

**Definition.** Observation `ret` uses only the Core closed set from `docs/core/storage.md` (`Retention Classes`): `ephemeral-diagnostic`, `turn-evidence`, `workspace-audit`, `restricted-raw`, `legal-hold`. Agent features introduce no sixth class on observation rows. Quarantine currently types `retentionClass` as `restricted-evidence` | `workspace-audit` | `legal-hold` (`packages/app-api-schemas/src/workspace-sync.ts:448`); evidence bundles already use `restricted-raw` (`packages/app-api-schemas/src/evidence-bundles.ts:26-31`). Whether quarantine `restricted-evidence` is the same class as `restricted-raw` is a pending admission of `docs/core/storage.md`. Until that owner admits a mapping, observation rows MUST NOT emit `restricted-evidence`.

**Exclusions.** Do not add `restricted-evidence` to this format's `ret` vocabulary. Do not apply `ret` to protocol Items; Item visibility is type plus Permissions. Do not infer that the closed retention set forbids a separate audience vocabulary; visibility and retention are different concerns, and this spec does not introduce an audience field. `ret` on a row is that row's class; a referenced blob's class is the target owner's. `ret` MUST NOT be rewritten to `workspace-audit` merely to keep a blob. `legal-hold` MAY cover an otherwise ordinary main fact and then blocks compaction or deletion until released; it does not authorize access (`docs/core/storage.md`, `Agent Data Retention And Deletion`).

**Authority.** Core owns the vocabulary and any quarantine fold. This spec assigns only Core tokens on observation rows. `restricted-raw` constrains access, not capture eligibility or a special demonstrated-need window. Owning record specifications and existing operator policy assign retention; no token change or sixth class is introduced.

**Lifecycle.** Set at write. Same `type` MAY carry different `ret` for permitted in-row metadata (for example ordinary versus secret-bearing tool identity); stdout and other bodies remain separately owned external content under B′, not an in-row class split of the same bytes. Days-in-window are operational knobs, not format constants.

**Failure.** Mixing restricted raw body into a long-term row violates B′. Retention never grants visibility or access. Permissions and hold remain independent of `ret`.

**Acceptance.** A retention sweeper reads `ret` from the header. No observation row uses a class outside the five Core tokens.

### Retention Basis B′

**Definition.** An observation row carries only main facts that an owner allows to keep long term, plus minimal references: identifiers, times, quantities, results, configuration identity, necessary associations. Time-bounded diagnostics, restricted originals, and complete model I/O live with their owners or external blobs, which execute recycle, hold, revocation, and access failure.

**Exclusions.** No independent daily row-level TTL. No tombstone rows. No deletion ledger. No promise that a row never disappears. Hard-delete of a Thread is not an existing Core operation and MUST NOT be assumed as a backstop.

**Authority.** This spec owns the content bound on observation rows. Blob bytes use existing Storage roots; lifetime follows referring Artifact, Source, evidence/work-data records, holds, and current operator policy. `restricted-raw` adds access constraints, not another body store or a demonstrated-need retention gate. Observation-row retain and delete follow the Thread/Workspace history owners already used for `items.jsonl` and workspace deletion closure, not a new sweeper invented here.

**Lifecycle.** Create by append. Update is not in-place rewrite of referenced content. Termination follows those existing history owners. Retry does not recreate a deleted row under a new meaning of the same id.

**Failure.** `docs/core/storage.md` requires derived reads to fail after source deletion or revocation; a row MUST NOT keep a readable copy of revoked source content. A hold does not grant access. An `expired` mark on an export projection does not prove the source was physically deleted.

**Acceptance.** Restricted or ephemeral bodies are not inlined on a long-term row regardless of size. A reader finding `absent` on a blob ref does not conclude the event never happened.

### References

**Definition.** Each `refs` entry is self-describing:

| Field | Role |
| --- | --- |
| `kind` | Target owner class; selects the resolver and uniqueness domain |
| `scope` | Ancestor identifiers required for uniqueness (a bare id is often not enough) |
| `locator` | That owner's durable locator |
| `digest` | Conditional. Content-addressed targets self-verify. An owner-id target MAY carry a historical digest of declared source bytes; that digest MUST NOT be used as the post-remint identity criterion. Insufficient scope is repaired by sufficient scope plus the exact remint map, or the reference stays explicitly unresolved; adding a digest does not repair identity |
| `edge` | `publication` or `association` |

A `publication` edge, produced by the owner after successful commit and pointing at that exact material, is the only proof that the material was submitted. An `association` edge (AEP snapshot, audit row, configuration identity, decision record) neither proves nor disproves collection.

**Resolution result.** A successful resolution attempt yields exactly one of `resolved-and-verified`, `absent`, or `mismatch`. `mismatch` MUST be detectable and MUST NOT be treated as success. Permission denial, owner unavailability, and I/O error remain the target owner's existing refusal or unavailable outcomes; they are not a fourth stored resolver state and MUST NOT masquerade as `absent`. Material under legal hold or revoked access is exists-but-unreadable through that owner's access rule, not `absent`. An intentionally unresolved external or `scope: 'server'` reference stays unresolved under source identity.

A reference MAY fail to resolve. A reference MUST NEVER be wrong: it MUST NOT bind to a different object than the one cited ([decision](../decisions/20260921-references_may_miss_never_mislead.md)).

**`corr` versus `parent`.** `corr` pairs one logical call's request and response inside that call's owning group and namespace. It is not an external referent and MUST NOT globally pair by the bare key. `parent` is the scalar anchor (observation or Item). One logical call has one `corr` even if several route attempts occurred; attempts hang off `parent`. A failed attempt MAY record its own failure fact; that fact is not the logical response and MUST NOT mint a second `corr`. Decision records are linked with an `association` ref, not with `corr`.

**Per-owner scope (current, after later corrections).** Exact remint maps cannot be replaced by digest. Content-hash does not cancel `scope`. `scope: 'server'` names a class, not a license to rebind by the same id on a different deployment. EvidenceBundle `bundles/` versus `backend/` is a location class, not a second primary key. AEP logical resolution is workspace plus `snapshotId`; direct-file location additionally needs `agentSessionId`. MCP schema snapshots still need Workspace, catalog entry, and source even when the snapshot id embeds a digest. PermissionDecision and VaultUse need `ownerScope` and the Workspace identity when the value is workspace-scoped. AuditEvent homes include Core, Workspace, app `data.sqlite`, and user-owned audit; `ownerScope` is not a single database name.

| Target | Extra scope | Remint? |
| --- | --- | --- |
| AEP snapshot | `workspaceId`; file locator also `agentSessionId` | yes |
| Artifact | `workspaceId` | yes |
| Knowledge Source | `workspaceId` | yes |
| EvidenceBundle | `workspaceId`; path class `bundles`/`backend` | yes |
| RuntimeEvidence (provenance-linked) | `workspaceId` | yes for that record's own id when a provenance package exists (`apps/nanocore/src/storage/workspace-import.ts:2347-2365`, `createWorkerRuntimeProvenanceEvidenceId`); other RuntimeEvidence ids are preserved. Foreign-key remaps of `threadId`/`turnId`/`goalId`/`taskId` are distinct from whether the record's own id changes |
| Goal task | thread + goal; taskId alone collides | yes |
| AuditEvent | home (core / workspace / app / user) + `workspaceId` when workspace-scoped | no |
| UsageRecord | `workspaceId` | no |
| CapabilityCall | `workspaceId` (its `packageSnapshotId` remints) | no |
| PermissionDecision | `ownerScope` + Workspace when applicable | no |
| VaultUse | `ownerScope` + Workspace when applicable (`vaultReferenceId` remints) | no |
| MCP tool schema snapshot | `workspaceId` + catalog entry + source | no |
| Sandbox image digest | server-homed; not in portable export | unresolved after export |

**Exclusions.** Do not use the pre-remint record digest as the post-remint identity criterion. Digest proves retrieved bytes match a recorded digest; it does not prove provenance, workspace membership, or source identity.

**Lifecycle.** Written at citation time. On portable import, in-package owner ids remint through exact maps; `corr` does not remint and remains pairable only inside the reminted group; content-addressed blob digests do not remint; server-scoped refs stay unresolved under source identity.

**Failure.** Using a pre-remint record digest to verify a post-remint record that legally changed bytes is a false `mismatch`. Guessing a server-scoped id on the destination is a wrong reference. Two imported executions that both contain `corr=c1` MUST NOT join across groups.

**Acceptance.** See Import, Remint, And Resolution Closure.

### Capture Coverage

**Definition.** Coverage is the one declaration that cannot be added after the fact. It is a system-level effective setting, not a per-thread fan-out. Resolve `server → workspace → task` to `off` or `on`; the server default is `on`. An explicit lower setting remains possible. Record its source scope, value, and the known override reason/configuration provenance without inventing a data-use purpose flag. `off` still requires the Collect metadata cells in the First-Release Capture Matrix. `on` requires full model I/O and other restricted originals. A missing collector is an explicit producer gap, not a weaker meaning of on. Cells marked Unsupported stay empty under both values. The resolved pair `{scope, value}` MUST commit with Turn admission as immutable historical content in the owning control transaction, before any work governed by that coverage starts; it is not a pointer into a live server changelog. The persisted declaration MUST be derived from that same effective capture policy, not from a separately maintained claim.

**Exclusions.** Do not store a thread-creation server epoch. Do not create CaptureBatch. Do not treat coverage as proof of collection success. Do not interrupt an already-started Turn when the capture switch changes. Security revocation of routes remains the continuity owner's rule and is not this switch.

**Lifecycle.** Create at admission. Unchanged for provider retry, while a pending request is outstanding, and proved exact reconnect of that Turn. AgentSession release does not invalidate the request and does not re-resolve the binding. Restart MUST NOT recompute a historical binding from current server config. A later Turn, including a sealed Turn's new attempt, re-resolves. Task-level override selects where to resolve; Turn stores which resolution this execution used. `(goalId, taskId)` when applicable is written on the Turn at creation, not on the Thread. Turns that are not Goal-task executions MUST omit the task tuple; planning Turns MAY carry Goal identity without inventing a Task.

**Failure.** Collector unsupported, fault, or missing data uses unavailable/failure facts. For Worker and Gateway collectors, a source or parser fault that is durably recorded as such a fact does not by itself change the actual work outcome or trigger another execution. Failure to persist required observations or failure facts remains fail-closed under the existing transport and execution owners; authorization, revocation, lineage and durable receipt requirements remain binding ([decision](../decisions/20260924-recorded_collector_fault_preserves_work_outcome.md)). Changing a bound setting MUST NOT hide an execution gap. Records outside any Turn carry the bound setting only inside an already-named existing owner; they MUST NOT borrow a past or future Turn. If Turn admission does not commit the canonical binding, governed collection MUST NOT start; do not silently assign current server policy. A conflicting existing binding on the same Turn is `recovery_required` for that Turn, not an overwrite. Historical Turns with no field remain distinguishable as never-recorded, not as `off`.

**Acceptance.** Default-on intent never proves complete delivery. A reader distinguishes explicitly off, a missing historical binding, an absent/unsupported producer, failure, truncation, lawful reclamation, and non-occurrence. Earlier off history cannot be backfilled from current policy. Required metadata stays mandatory even under an explicit off override. The Collect metadata cells (configured provider and physical model, provider-reported snapshot when a response exists, requested sampling, internal-agent `env.bound`, task-instance pairing when applicable, `turn.reap` when recovery runs, system-prompt digest, harness identity) are present or recorded as a failed required collection, not omitted as unsupported.

Four independent evidences, never derived from each other, and always about the same material / capture family / attempt:

| Question | Sole evidence |
| --- | --- |
| What was intended | The bound effective setting. Intent, not result |
| Material was submitted | A precise successful `edge: 'publication'` ref, not an arbitrary `refs` entry, not a digest-only slot |
| Collection failed | An existing or designed failure record (`capture.unavailable` or the collector owner's failure fact) |
| Source was lawfully reclaimed | The target owner's actual disposal semantics in that scope. Export `expired` does not prove source deletion |

Missing evidence stays unknown.

### Uncertainty

**Definition.** Uncertainty is expressed in three places, none of which is `Turn.status`.

1. Observation `cert`: omitted = direct; `"inferred"` = inference or model/ASR generation.
2. Observation `outcome: "unknown"` on rows that describe an external-effect terminal.
3. Effect owner and recovery owner: CapabilityCall `unknown` in `docs/core/mediation.md:70-84`; recovery requirements on the recovery owner. Interruption MUST NOT infer that an effect did not happen.

**Exclusions.** `unknown` is not a Turn status. Turn terminals are `completed`, `interrupted`, `cancelled`, `failed`, as corrected in Core by commit `968f5a4e`. `cancelled` means authorization to continue that Turn was withdrawn, including by the owning workflow when it determines the work is superseded; the specific reason is an Item, not another terminal value. `turn.reap` is normalized evidence of a recovery decision (why this Turn's execution is gone, on what basis), not a Turn `unknown` status. Command-outcome `unknown` and operation/transfer `unknown` stay with their owners.

**Lifecycle.** A terminal Turn is never reopened (`docs/core/core-concepts.md:97`, `docs/core/protocol.md`). Exact reconnect may continue a non-terminal Turn identity. A terminal `interrupted` Turn is a recovery entry for a new attempt, never re-execution of the old identity. `cancelled` does not auto-retry that identity.

**Failure.** Aggregating only `status === 'unknown'` on effect records is insufficient; other statuses are not proof of no effect. Absence of a matching CapabilityCall does not prove absence of effect risk.

**Existing-owner obligations (not a new UI workflow).** Cancellation of a Turn by itself does not require human attention; unresolved unconfirmed calls on that Turn still do. An unresolved unknown effect is evidence the person sees before accepting completion. It does not by itself write the completion disposition. Effect-specific duplicate-effect and replay checks remain with their owners (for example claimed MCP effects). These are pending implementation checks on those owners, not new format fields.

**Acceptance.** `docs/core/agent-session.md` (`Replacement`) preserves the Turn's truthful lifecycle result and leaves effect/recovery uncertainty with those owners.

### Thread Boundary

**Definition.** A Thread holds actions and references. Entities live with their owners; pointers point back.

**Exclusions from the thread record.** Generative App schema bytes, app databases, and user-operated app use while no Agent is present. Artifact and media bytes. Knowledge-page bodies. System-level supply/catalog change logs (when a binding became available and why). World current-state. Runtime-private N-hop transcripts except as observations under `turnId`.

**Inclusions.** Agent-generated presentation/schema/record writes as typed references, not as the entity. User actions that re-enter the Agent, recording what the Agent was told, not the full human fidget. Knowledge reads record which pages that retrieval actually returned. A typed Kernel narrative Item analogous to `generative-ui-reference` is a pending requirement of `docs/specs/20260908-generative_kernel_data_operations.md` (C9), not a producer this spec authorizes.

**Lifecycle.** Thread identity is lifetime-true: `threadId`, `workspaceId`, visibility, lineage, Goal membership, file-level envelope fields. Environment is not in `thread.json`. Ordinary Thread create/list/get/resume/archive stay with protocol.

**Failure.** Putting app history inside a Thread would couple app retention to Thread retention and grow idle Threads.

**Acceptance.** An idle Thread does not poll the world and therefore writes no Item from world-state watching. Late-arriving approvals, background results, and other owner-admitted arrivals still record through their owners; idle silence MUST NOT be read as "write only while a Turn is in flight." Eval finding light-app construction by typed Kernel reference waits on C9.

### Large Content And Publication Marker

**Definition.** Placement is fixed by content kind, not by size. Restricted or time-bounded bodies, model originals, tool stdout, and diffs are external, however small. Media bytes go to Artifact/Source owners, not work-data `blobs/`. Work-data blobs prefer greppable text.

**Publication.** Write and fsync blob bytes first, then append the observation line whose `refs` lists those publications, then fsync that append. A committed publication MUST NOT cite unpublished bytes. Unendorsed orphan blobs MAY exist after a crash between blob fsync and line commit and MUST be ignored on replay. Torn tails truncate at the last `0x0a`; the incomplete last line is dropped, not repaired.

**Exclusions.** No 16 KiB inline threshold as a format rule. No prefix-watermark digest chain. Digest is addressing and naming, not an integrity proof. `payload` placeholders MAY name `{kind, id, digest, bytes, mediaType}` with open IANA `mediaType` strings and logical ids rather than filesystem paths.

**Lifecycle.** Blob recycle leaves digest and byte-count on the row so the reader sees "there was content, now cleared", not "nothing was there".

**Failure.** Failed blob or observation-line synchronization leaves the publication uncommitted; see Durability.

**Acceptance.** A reader never has to ask "complete or incomplete"; only "inline or external". Size changes do not invalidate old rows. A committed line never names a blob that was not fsynced first; leftover unendorsed blobs are ignored, not treated as missing collection.

### Environment Binding And Cause

**Definition.** Environment is an observation, not a `thread.json` field. Worker environment copies of prompt/harness/skills/MCP MUST NOT be duplicated; AEP snapshot plus MCP schema snapshots are the owners, and observations `refs` them. Internal-agent `env.bound` remains because internal agents have no AEP; its receiver is Core, with in-row fields limited by the First-Release Capture Matrix. `config.model` records configured physical identity separately from any provider-reported snapshot. Requested sampling is the named typed fields at the dispatcher-to-Pi boundary; omitted values stay omitted. `cause` is an open string vocabulary, not a closed enum; the binding row MAY `refs` the decision record with `edge: 'association'`. Closed enums such as `initial|rollout|self-optimization|user-override|failure-fallback` are forbidden because mixed causes would lie.

For the #144 selected-Skills family, Core retains the trusted admission in the same immutable `env.bound` row as the prompt and Tool digests, before the model effect can run. `assistantSkillAdmission.catalogRevision` is the non-negative integer revision of the source catalog observed during assembly. It is `null` when the empty selection requires no catalog observation. `skills` is ordered by Skill ID and contains unique source Skill IDs and their exact admitted version and content digest. In this catalog, `versionId` is the content digest. Empty selection is recorded as `{catalogRevision:null,skills:[]}`. An absent field means that this observation did not record this admission evidence; it does not mean an empty selection. The field contains historical configuration identity, not Skill content or a grant of access. It uses the row's existing `turn-evidence` retention and Thread/Workspace history lifecycle, including when full model I/O capture is off. The complete environment row is appended once under its existing Turn identity. Exact replay is idempotent; changed content under that identity is a conflict. Required validation, append, or conflict failure prevents model dispatch. Re-entry uses the original admission and must not resolve a replacement selection from current defaults or pins. If the original admission cannot be used under current authority and retained-resource checks, the run fails under its existing failure contract. An existing row must not be enriched, replaced, or bypassed under another identity. The admission tuple is storage evidence only; it does not add fields to Timeline, protocol, or other public projections, and authorized portable export remains subject to current Thread audience rules. See [Work Observation Portability](20260704-workspace_backup_export_import.md#work-observation-portability) for the historical source tuple and [the accepted placement decision](../decisions/20261015-assistant_skill_admission_evidence.md) for its reason.

**Harness identity (accepted degradation).** Do not treat authored AEP `runtimeVersion` as a measured harness version. Keep it as an unverified author label from `*.agent.jsonc`. The grouping key is the measured image digest copied as a value at binding time for both new and reused bindings, because `sandbox_runtime_records` rows including `image_digest` are deleted with the physical sandbox. Authored `runtime.image` refs are not image identity. This can false-split (same harness, new base image) and MUST NOT false-merge (different binaries labeled alike). It cannot answer "which Codex version" without a later verified image-to-binary map.

This retained grouping identifies the sandbox image admitted by NanoHost, not an external harness or a measured harness binary version. Existing image values and observer labels keep their current meanings; an external observation MUST NOT be relabeled as NanoHost evidence. Later external identity and provenance forms are additive under the [neutrality decision](../decisions/20261020-compute_and_harness_neutrality.md). Unavailable native identity or transcript content remains an explicit capture gap under the existing collection rules.

**System-prompt digest.** Collect the digest of the prompt at the semantic boundary before adapter conversion. The prompt producer remains above shared Gateway dispatch. The pre-adapter digest remains a named grouping boundary, not proof of the exact upstream body. New full capture follows the native exchange boundary above; earlier captures remain interpretable under their recorded boundary. The grouping is not injective: an absent prompt and an explicit default literal produce different pre-adapter digests and identical outgoing instructions. The format MUST name the boundary; it MUST NOT promise a single existing hook. `workerRequestDigest` is the worker-request body, not the harness system prompt, and MUST NOT substitute.

**Lifecycle.** Wake-up after idle writes "the environment I see now", not a two-month changelog. Mid-turn reconfiguration is a new Turn plus a new AEP snapshot under single-flight; this spec does not reserve empty fields for in-turn hot reload.

Selecting an already-admitted command target is distinct from changing the pinned loop configuration or a Worker's AEP. Retain the target binding for each invocation through its existing evidence owner without rewriting earlier `env.bound` records.

**Failure.** System-level "when did this binding become available" belongs to supply/catalog, O(changes), joined by binding ref. Putting it on every Thread is fan-out.

**Acceptance.** Eval groups by copied image digest plus authored label, and by named pre-adapter prompt digest, without believing AEP `instructions: []` is a prompt.

### Segmentation Of Continuous Assistant Output

**Definition.** A hard cap is evaluated only at Turn boundaries. A Turn never spans segments. The numeric threshold is an operational setting, not a format constant; a suggested default of 10,000 observation lines or 100 MB, whichever first, MUST be declared on `thread.json` together with the statement that the cap is boundary-delayed. A 130 MB segment can therefore be legal overflow, not corruption. After delay, 100 MB is not a hard byte guarantee.

**Copy on segment.** Copy `parentThreadId` and an explicit `segment` ordinal. A continuation MUST NOT be treated as a new attempt. Chat that had no pairing key still has none (true missing data). Task identity lives on the Turn and is not copied as a Thread field. Coverage is per-Turn and is not copied as a generation id. `ret` defaults stay the Core closed set on new observation rows; do not copy a withdrawn audience field.

**Exclusions.** Do not mid-Turn split (that would put one Turn across two Thread segments). Do not terminalize a running Turn for storage reasons. Do not treat the continuous UI as a storage object; storage segments by policy, UI concatenates via `parentThreadId`.

**Lifecycle.** Create a new Thread segment only at a Turn boundary when the declared cap is exceeded. Segment creation, `parentThreadId`, and `segment` ordinal use the existing Thread create path owned by protocol; this spec adds no second Thread lifecycle. Admission of a new continuation with a missing predecessor Thread id fails closed. Reading already-retained lineage whose parent is missing or inaccessible leaves that lineage unresolved and grants no access, execution, or mutation (`docs/core/core-concepts.md:81`, Thread `parentThreadId`); it does not reject the history read. Restart after a partial segment publication does not allocate a second successor for the same predecessor plus ordinal. Inspecting an already-published exact successor after restart is not a conflict. A second distinct successor for the same `(parentThreadId, segment)` is `recovery_required`. A successor published without its `parentThreadId`/`segment` link is incomplete, not a new attempt.

**Failure.** A long session that silently lost pairing keys at a cap would be wrong data, not missing data.

**Acceptance.** Readers can tell legal delayed overflow from a damaged file because `thread.json` declares the delay.

### Identifiers

**Definition.** Independently generated Thread and Turn ids use UUIDv7. Owner-derived Thread, Turn, and Item ids retain their existing inputs and idempotency semantics and use UUIDv5. Both paths use the kind prefix plus canonical lowercase UUID text defined by [Protocol Identifiers And Enums](20261021-protocol_identifiers_and_enums.md#ids). The output-encoding decision is recorded in [One Identifier Mechanism](../decisions/20261014-one_identifier_mechanism.md). Consumers MAY use UUIDv7 directory-name lexicographic order as a prefilter for time-range scans. UUIDv5 order is not a time prefilter.

**Name-byte projection.** This storage format adds no derivation or input. Each derived name is the UTF-8 RFC 8785 JSON Canonicalization Scheme output for the value below, with arrays in the listed order. These rows project the allocating owners; their definitions of `actor`, `commandScope`, `outcomeScope`, `resultRole`, identifiers, and request values apply unchanged. [Chat Mode Assistant](20260704-chat_mode_assistant.md#unified-command-branch-and-replay), [Work Resource Interaction Model](20260713-work_resource_interaction_model.md#artifact-and-item-lineage), and [Pending Requests](20260930-pending_requests.md#deliver) remain those owners.

| Derived output | Prefix | JSON name value, in fixed array order |
| --- | --- | --- |
| Command-initiated Assistant Turn | `tu` | `commandScope` |
| Command-initiated handoff Thread | `th` | `[actor, workspaceId, originatingThreadId, requestId]` |
| Command-initiated first handoff Task Turn | `tu` | `[actor, workspaceId, originatingThreadId, receivingThreadId, requestId]` |
| Outcome-initiated handoff Thread | `th` | `outcomeScope` |
| Outcome-initiated first handoff Task Turn | `tu` | `outcomeScope` |
| Initiating Chat user Item | `it` | `["chat-user", assistantTurnId]` |
| Chat-owned result Item or handoff status Item | `it` | `[resultRole, assistantTurnId]` |
| Initiating downstream Task user Item | `it` | `["task-user", downstreamTurnId]` |
| Artifact introduction Turn | `tu` | `[actor, workspaceId, threadId, "artifact.introduce", requestId]` |
| Artifact communication or introduction Item | `it` | `[artifactId, communicatingTurnId]` |
| Review refinement or redo Turn | `tu` | `[workspaceId, artifactId, artifactVersion, decisionRequestId]` |
| Pending Requests request or outcome Item | `it` | `[requestId, role]` |

The Chat-owned result row excludes clarification and approval request Items. [Pending Requests](20260930-pending_requests.md#deliver) alone names those Items with `[requestId, "request"]`, using the original durable `userInputRequestId` or `approvalRequestId`, respectively. The existing request association supplies that id on replay; the Assistant Turn and `resultKind` supply no second name.

**Transcript and simulator projections.** Existing role-owned projections use these additional exact JSON names under the [accepted complete-name declaration](../decisions/20261015-identifier_owner_declarations.md):

| Existing output | Prefix | Exact JSON name |
| --- | --- | --- |
| Worker transcript Item | `it` | `["worker", producingTurnId, sequence]` |
| Simulator assistant Item | `it` | `["assistant", producingTurnId]` |
| Simulator reasoning Item | `it` | `["reasoning", producingTurnId]` |
| Simulator command Item | `it` | `["command", producingTurnId]` |
| Simulator simple result Artifact | `ar` | `producingTurnId` as a JSON string |

`producingTurnId` is the admitted canonical Turn. `sequence` is the exact numeric recorded Worker event sequence. Timestamps and native Tool IDs supply no substitute input. Simulator initiating Task user Items use the existing `["task-user", downstreamTurnId]` row. Product-backed input and approval request Items use only the Pending Requests `[requestId, "request"]` name. Worker-submitted Material candidates use Work Resource Interaction Model's exact `[packageSnapshotId, producingTurnId, submissionRequestId]` Artifact name.

These names encode existing one-role-per-Turn or sequence-owned projections. They add no simulation entity or lifecycle authority. Store publication, original content bytes, sequence, timestamps, request association, terminality, retention and provenance remain with their existing owners. A derived string cannot create an AgentSession or prove readiness. Acceptance requires exact source/projection names after reopen, distinct numeric sequences and roles, one product request Item per request, unchanged content and no replacement effects after partial publication.

**Exclusions.** Consumers MUST NOT parse a timestamp out of the id (`docs/core/core-concepts.md`, `Identifier Semantics`). Id order is never the correctness criterion; after a prefilter the implementation MUST recheck authoritative `ts` / `turn.json` timestamps. This repository currently has a generator (`apps/nanocore/src/runtime/session-id.ts`, `generateUuidV7`) and no UUIDv7 timestamp parser, so a "must consume only via helper" rule is not yet an executable invariant; until a unique helper plus a failing test exists, the two consumption rules are a review obligation, not a storage invariant. New UUIDv7 allocation MUST NOT replace existing request-derived Item identities.

**Lifecycle.** Allocate at create. Remint on portable import for in-package owner ids.

**Failure.** Sorting ids and slicing without reading `turn.json` is a review defect. Colliding or conflicting replay of a request-derived Item id follows protocol command-receipt rules; this spec does not add a second allocator.

**Acceptance.** Correctness of time filters does not depend on id bits.

### Import, Remint, And Resolution Closure

**Export posture.** The existing export owner preserves retained native families and restricted originals under current source authorization and reference closure. Do not predict later use or apply capture-time purpose filters. Identity remapping, privacy processing, dataset conversion, and other use-specific transformations remain with the authorized use/export owner, not a new storage format or pipeline here. Existing exclusions, including other users' private Threads and system-managed Vault/provider/runtime secret material, remain binding. Snapshot/backup closure includes Workspace-managed message, prompt, definition, chunk and manifest blobs; server-scoped captures do not become Workspace export data.

**Definition.** Portable import remints in-package owner identities through exact maps. The Work Observation Portability section of `docs/specs/20260704-workspace_backup_export_import.md` admits the family to the portable inventory (C6). Cold whole-tree backup does not process the family and MUST NOT fail closed solely for an observation `requiredFeatures` gate.

Pre-import two-hop example. Turn `T` already exists at admission with bound coverage. First hop has a route fallback; second hop joins an Item `I`.

| Record | Key fields | Meaning |
| --- | --- | --- |
| `req₁` | `id: o1`, `turnId: T`, `corr: c1` | First-hop request |
| `att₁ₐ` | `id: o2`, `parent: o1`, attempt 0, configured provider/model | Eligible dispatch failure; no logical response |
| `att₁ᵦ` | `id: o3`, `parent: o1`, attempt 1, configured provider/model | Dispatch attempt that entered the provider |
| `res₁` | `id: o4`, `corr: c1`, `parent: o3`, provider-reported snapshot | Pairs with `req₁` by `corr`; `parent` names which attempt |
| `req₂` | `id: o5`, `corr: c2`, `parent: o4` | Second hop; nesting via `parent` |
| `res₂` | `id: o6`, `corr: c2`, `parent: I` | Pairs with `req₂` by `corr`; Item join is this `parent` |

After export into another Workspace:

| Field | Before | After | Remap | Why |
| --- | --- | --- | --- | --- |
| `turnId` | `T` | `T'` | Turn map | In-package owner |
| `parent` observation→observation | `o3` | `o3'` | Observation-family remint | `openkit.work-observations.v1` recognition (C8/C6) |
| `parent` observation→Item | `I` | `I'` | Item map | In-package owner |
| `corr` | `c1`/`c2` | unchanged inside the reminted group | none | Pairing key; MUST NOT globally pair two imported groups that both contain `c1` |
| `refs` blob | digest of blob bytes | unchanged | none | Content-addressed; verify those bytes before import; do not rehash |
| `refs` AEP snapshot | `snapshotId` plus optional historical source-byte digest | `snapshotId'` | AEP map | Identity is the map. A historical digest MAY travel with declared byte coverage; it MUST NOT be the post-remint identity criterion |
| `refs` image digest `scope:'server'` | value plus source identity | unchanged, unresolved | none | Out of package. MUST NOT rebind by the same id on the destination |

**Lifecycle.** Private Threads of other users remain excluded under the backup/export owner. Observation-family portable listing follows the admitted C6 inventory and reference closure.

**Failure.** A wrong remint is a wrong reference. Using a pre-remint record digest as post-remint identity is forbidden.

**Acceptance.** After import, in-package joins still resolve to the same relative objects; `corr` pairs only inside the reminted group; server-scoped refs stay unresolved rather than attaching to a different deployment's object. Two imported executions that both used `corr=c1` do not join. Provenance-linked RuntimeEvidence receives a new id from the provenance package; other RuntimeEvidence keeps its identifier while its Thread/Turn/Goal/task foreign keys still remap.

### Durability

**Definition.** Storage commits verified durable content before the existing record owner commits a publication reference. Readers and notifications expose only committed references. Capture binding must commit before governed work starts. The physical owner defines that commit point; this format creates neither a cross-store transaction nor a canonical projection-file write beside a control-store row.

For a current canonical file representation, publication remains the observation-line fsync after blob fsync, plus parent-directory fsync on creation. Default is per-line fsync unless its owner first changes that point. An un-fsynced tail is uncommitted. A JSONL projection of canonical rows is not a second publication commit. Turn terminal, body-publication references, and coverage persistence keep their owning commit obligations.

**Failure.** Power loss after a non-fsynced append can drop lines the writer believed committed, which is wrong data under the missing-versus-wrong rule. Power loss after blob fsync and before line fsync MAY leave orphan blobs; they are unendorsed and ignored, not a committed publication.

**Acceptance.** A crash-boundary observation must show: a committed publication never cites unpublished bytes; unendorsed orphan blobs may exist and are ignored; missing canonical coverage binding blocks governed collection. A Turn with committed SQL coverage and a missing or stale disposable `turn.json` projection still collects under its bound setting, without recomputation. Observing that `fsync` was called is not by itself that observation.

## Current Implementation Projection

Implementation alignment remains `Partial`. Existing collectors/importers must neither be described as absent nor treated as complete. This documentation change does not implement the default-on native exchange/content-addressed target.

The pre-replacement file representation writes the immutable coverage binding into `turn.json`, which its owner rewrites on every persist. This is pre-reset implementation detail, not the target commit point. No compatibility writer or reader remains after reset.

- `apps/nanocore/src/llm/model-capture.ts` binds existing Core or Workspace databases to an admitted Turn, records environment metadata, and conditionally captures selected pre-adapter requests and normalized semantic response events. That filtering/buffering does not prove lossless upstream or translated Worker-facing exchange retention.
- `apps/nanocore/src/storage/work-observations.ts` already supplies observation schemas, immutable binding reads, append/recovery rules and EvidenceBundle body references. Reuse this owner rather than add another capture ledger.
- `apps/nanocore/src/runtime/worker-transcript.ts` already imports canonical events/Items and optional restricted runtime-provenance files. That is not default complete verbatim transcript/stderr collection.
- Current Gateway CapabilityCall rows use `redactionClass: 'metadata-only'`; counts and linkage do not prove that the separate body collector ran. Existing server-Turn model capture is not the new no-Workspace/no-Turn server coverage path.
- `apps/nanocore/src/runtime/pending-requests.ts` retains request/answer resolution and work lineage. `apps/nanocore/src/artifact-reviews.ts` stores version/content digest, source Turn, actor/decision, feedback and follow-up/revision fields in Workspace SQLite. Complete retention joins remain unproved.
- Existing immutable coverage, copied image-digest values, prompt digests, selected-Skill admissions, Item persistence and uncertainty owners remain. A digest producer is not a body producer. No implementation test accepted the new target here.

### Current Completeness Gaps

| Boundary | Current gap to close |
| --- | --- |
| Coverage | Default-off history and missing bindings cannot be backfilled; new default-on resolution needs implementation. |
| Gateway content | Selected semantic content does not cover actual upstream fields, translated pairs, native streaming chunks/timing, or no-Turn coverage. |
| Cost | Complete shared message/prompt/tool blobs and structurally shared request roots are not established. |
| Native runtime | Optional provenance/import does not establish default verbatim transcripts/logs, truncation records, or measured binary version identity. |
| Context | AEP/Skill/digest metadata does not prove exact Knowledge/Memory/attachment delivery or visibility into runtime-private compaction. |
| Judgments | Durable requests/Reviews exist; complete edit/correction/retry/rating lineage and joins are not established. |
| Lifecycle | The separate journal owner supplies step facts; metadata and telemetry cannot replace its unimplemented portions. |

### Collector Replacement Map

| Remove from the new write path | Replacement / preserve |
| --- | --- |
| Default-off resolver fallback | Default-on effective resolution; preserve explicit off and immutable historical bindings. |
| `model-capture.ts` pre-adapter semantic writer / `admittedModelRequest` allowlist as complete I/O | Actual native upstream/translated exchange roots; preserve required safe metadata and historical boundary labels. |
| Normalized semantic response-body persistence | Derived reconstruction from the retained native sequence; safe UI projections remain disposable. |
| Repeated full request/history bodies or full reference-prefix arrays | Scoped message/part blobs and structurally shared roots. |
| Parallel EvidenceBundle body-byte copies | Storage owns bytes; preserve EvidenceBundle identity, access and publication lifecycle. |
| Optional-only provenance gate as the sole transcript collector | Default bound-policy incremental native capture; preserve provenance guards and source watermarks. |
| File publication/recovery path | Follow the [DX replacement inventory](20261019-durable_execution_and_control_store.md#replacement-inventory), not a separate RET file-authority path. |

These replacements preserve secret exclusion, required metadata, safe UI projections, existing request/Review authority, and the declared meaning of retained old bodies.

### Collector Priority And Estimated Increments

Deliver increments 1–3 first so real work retains useful originals before broader enrichment. Each increment reuses existing writers, authorization and Storage publication, and applies the [collector replacement map](#collector-replacement-map) without retaining the replaced write authority. These are implementation estimates, not new owners, observed test results, or a runner.

| Order | Collector and owner boundary | Estimated production modules | Estimated focused test files |
| --- | --- | --- | --- |
| 1 | Gateway dispatch/translation: upstream and Worker-facing native bodies, streaming chunks/timing, scoped coverage and message/prompt/tool dedup through current model/observation/Storage owners. | 3–5 | 4–6 |
| 2 | Existing Worker/native collection and Core transcript importer: verbatim streams, bounded stderr/logs, harness provenance, gaps and truncation. | 6–9 | 5–8 |
| 3 | Core/NanoHost context assembly and accepted delivery: exact message/source references, Knowledge/Memory/Skill/attachment lineage and Policy/AEP snapshots. | 3–5 | 3–5 |
| 4 | Existing request/review/edit/redo and other judgment/tool producers: missing work/version/actor links and unavailable/absent-feature coverage. | 2–4 | 3–5 |
| 5 | Journal and retention-owner join: existing retained-record id/digest references and closure checks, after the execution owner supplies the journal. | 1–3 | 2–3 |

Increment 1 distinguishes Workspace-attributed, Workspace-only and server-only calls from its start. Increment 2 retains a safe committed prefix before Worker crash, not only successful terminal harvest. Increment 3 proves actual delivery, not selection. Later increments never relabel missing earlier collectors as complete.

Storage/schema migrations remain with their owners. Retained records keep their declared boundary and references. New collection never backfills history or silently reinterprets old semantic bodies as native wire capture.

### Evidence Strength

The following citations preserve the earlier source verification at `968f5a4e0af0938b8237c05ac044cc754fcf4f8e`, not a current completeness verdict. Current claims are limited to the named source boundaries above; inspected test files are not executed acceptance. Opened in this tree: `apps/nanocore/src/storage/workspace-file-records.ts:846-870`, `:2450-2488`, and `writeFileAtomic` at `:2498-2512`; `apps/nanocore/src/storage/workspace-import.ts:2347-2365` (`createWorkerRuntimeProvenanceEvidenceId`); `apps/nanocore/src/llm/gateway-routes.ts:137-145` and `:152-168`; `apps/nanocore/src/llm/gateway-converters.ts:63-74` (`convertChatCompletionToResponsesRequest`); `apps/nanocore/src/llm/pi-ai-client.ts:284-300` and `:802-808`; `apps/nanocore/src/runtime/session-id.ts:9-28`; `packages/protocol/src/models/turn.ts:21-29`; `packages/app-api-schemas/src/workspace-sync.ts:448`; `packages/app-api-schemas/src/evidence-bundles.ts:26-31`; `docs/core/protocol.md` Turn terminals; `docs/core/storage.md:123-131`, `:133-149`, and `:173-185`; `docs/core/core-concepts.md:81`, `:113`, and `:117`; `docs/core/agent-session.md:87`; `docs/core/mediation.md:70-84`; `docs/core/work-model.md:26`; `docs/core/core-concepts.md:151`; `docs/specs/20260703-storage_layout_record_ownership.md:16-24`, `:277-279`, `:287`, `:335`, and `:347-352`; `docs/specs/20260703-schema_evolution_record_envelope.md:165-173`; `docs/specs/20260703-runtime_scheduling_scale.md:126`; `docs/specs/20260704-workspace_backup_export_import.md:81` and `:141`; `docs/specs/20260908-generative_kernel_data_operations.md:122` and `:211`; `docs/specs/20260704-goal_mode_coordination.md:183`. The discussion record's facts were originally pinned at baseline `c1a8b6ad` and were not all re-verified at that commit. Carried without independent confirmation in this tree: third-party grep-first percentage claims; external-harness comparison tables; the note.md §10 inventory as of `c1a8b6ad`; `workerRequestDigest` internals; the AEP assembler writing `instructions: []`.

## Required Owner Alignments

Listing an alignment is not approval of a change to another owner's document. Each live row needs its accepted owner before dependent implementation (`[AUTH-001]`).

### C1 — Item as the communication atom inside a Turn

**Owner.** `docs/core/core-concepts.md:113`: "`Item` is the ordered communication and storage atom inside a turn."

**What the early record wanted.** Legalize Items outside a Turn.

**Disposition.** Withdrawn. Protocol Items stay naked protocol JSON with required `turnId`; observations are a separate family. This format does not need a Core doctrine change that would make Item an observation atom outside a Turn.

### C2 — Runtime-private traces are not Items

**Owner.** `docs/core/core-concepts.md:117`: "Runtime-private traces and chain-of-thought are not Items unless an owning design intentionally promotes a safe, product-visible summary."

**What the early record wanted.** Redefine Item from communication atom to observation atom, with visibility as a per-record attribute.

**Disposition.** Withdrawn for the same reason: observations are not Items. Runtime-private traces remain non-Items unless a separate owning design promotes a summary. Do not reopen this Core doctrine change.

### C3 — TurnStatus and the word `unknown`

**Owner (historical conflict).** `packages/protocol/src/models/turn.ts:21-29` has no `unknown`; an older `docs/core/agent-session.md` sentence listed `unknown` beside Turn outcomes.

**What the early record wanted.** Add Turn `unknown`, or an orthogonal certainty field.

**Disposition.** Resolved differently. Turn `unknown` was withdrawn. Commit `968f5a4e` corrected the documents: Turn terminals are `completed`, `interrupted`, `cancelled`, `failed` (`docs/core/protocol.md`); `docs/core/agent-session.md:87` (`Replacement`) now keeps the Turn's truthful lifecycle result and leaves effect/recovery uncertainty with those owners. CapabilityCall `unknown` remains (`docs/core/mediation.md:70-84`).

### C4 — `_ext/` reserved namespace

**Owner (as cited).** The record pointed at `docs/specs/20260703-storage_layout_record_ownership.md:335`, under `Workspace Record And Configuration Split`, as "unknown filename is an explicit unsupported-layout error."

**Current tree.** `:335` (`Workspace Record And Configuration Split`) is the removed `workspace.json` unsupported-layout rule, not a general unknown-filename ban. Unknown canonical families fail closed at `:277-279` (`Structure Evolution Rules`).

**Disposition.** Withdrawn. The physical `_ext/` staging namespace has no remaining argument; this spec does not add one.

### C5 — Calendar sharding of the Turn directory

**Owner.** `docs/specs/20260703-storage_layout_record_ownership.md` layout tree, currently `threads/<threadId>/turns/<turnId>/` (`Workspace Storage Layout`, `:347-352`).

**What the early record wanted.** `turns/<YYYY>/<MM>/<turnId>/`.

**Disposition.** Withdrawn. This spec does not restate or change that tree.

### C6 — Portable export enumerates known families

**Owner.** `docs/specs/20260704-workspace_backup_export_import.md:81` (directory membership is not an export permission) and `:141` (later Workspace-owned durable records MUST be classified there; no implemented family may be silently omitted).

**What this format needs.** Observation files that live under a Thread directory need classification into the portable inventory so a Thread's work-data files cannot drop an unclassified family. Cold whole-root backup remains a separate path.

**Disposition.** Admitted on 2026-09-22 in the backup/export owner, including inventory, audience and exact remint/reference closure.

### C7 — Item-log persistence invariants

**Owner.** `docs/core/storage.md:8-9` (`Storage Model` opening) owns item-log persistence invariants; `:173-185` (`Item Log Invariants`) require append-only Item logs, preserved protocol order, and single-writer append.

**What the early record wanted.** Item losslessness plus a raw content reference on the Item.

**Disposition.** Moot for that request. This format keeps Items as naked protocol JSON, so it does not ask Core to widen `ItemSchema` or add raw refs. Residue: applicable Item-file invariants remain with the Item owner. Observation publication follows the owning physical commit point and this spec's content-first rule, not a second canonical file write beside the control store.

### C8 — Envelope header slots

**Owner.** `docs/specs/20260703-schema_evolution_record_envelope.md:165-173` (`Line-Oriented Records`: split-envelope minimum `v` / `type` / `id` / `ts`; the owning storage spec names concrete header fields).

**What this format needs.** Observation lines add `seq`, `obs`, `ret`, `parent`, `corr`, `outcome`, `cert`, `turnId`, `refs`, and `ext` beyond the split-envelope minimum. `perc` and `span` are absent; audience is not a field; `parent` is observation-only; `seq` is per-file truncation detection. `payload` is the body, not a header slot.

**Disposition.** Admitted on 2026-09-22 by Turn Observation Placement in the storage-layout owner, using the header above and the registered required feature.

### C9 — Kernel operations on the narrative axis

**Owner.** `docs/specs/20260908-generative_kernel_data_operations.md:211` commits attributed AuditEvent and a metadata-only receipt in the app-database transaction; `:122` says user-visible operation outcomes are item-backed through existing owners.

**What this format needs.** A typed narrative Item for Kernel work (stable app/schema/digest references, analogous to `generative-ui-reference`) so eval can find light-app construction without grepping a tool name.

**Disposition.** Live pending owner admission. This spec does not decide the Kernel owner's change and does not itself emit that Item.

### C10 — Runtime evidence versus Runtime Epoch addressing

**Owner.** `docs/specs/20260703-runtime_scheduling_scale.md:126` (`NanoHost Boundary`): "NanoCore neither addresses nor stores Runtime Epoch identity."

**Normative distinction.** Retaining runtime evidence on the observation axis MUST NOT be implemented as NanoCore addressing or storing Runtime Epoch identity for scheduling, placement, or capacity. Copied measured facts (for example image digest at bind time) are historical identity on the retention axis. Scheduler admission and execution attempts remain the scheduling owner's records, while physical capacity and residency remain backend-adapter projections; Runtime Epoch identity remains NanoHost-private. The two obligations do not conflict when that separation is kept. Implementing retention as a second epoch-id scheduling key WOULD conflict with `:126` and is forbidden.

**Disposition.** Live. This distinction is a requirement of this spec.

## Testing Strategy / Acceptance Criteria

The target is proved at each actual collector and Storage boundary, not by metadata presence alone. These fixtures define deciding observations; implementation is still required.

| Fixture | Required observation |
| --- | --- |
| Same history grows through many model calls | Only new message bytes and changed shared-manifest nodes appear; prior request roots reconstruct unchanged. |
| Provider includes an unknown field or a large exact native number | Native content retains its meaning; unsupported canonical indexing cannot round it or silently drop it. |
| Gateway translates protocols and retries one route | Each observed upstream attempt and the distinct Worker-facing exchange resolve through the existing call associations. |
| A native stream stops inside JSON/UTF-8/tool deltas | Published bytes form an explicitly incomplete native prefix; no fabricated final message or completion time. |
| Model call has Workspace attribution but no Turn | Workspace blobs and coverage exist without surrogate execution identity. |
| Model call has no Workspace attribution | Server roots and explicit server-scope coverage exist, not a global capture owner or fake Workspace. |
| Native stderr exceeds its Turn budget | Restricted verbatim bytes stop at the stated bound, with exact retained ranges and explicit measured-or-unknown omitted length. |
| Context source changes after model dispatch | Captured message roots reconstruct the actual input; source refs never bind today's changed bytes. |
| User answers late, denies, edits, or retries | Existing owner/actor/version linkage survives; chronology or text does not manufacture a rating or new authority. |
| Capture is off or a collector is missing | Intent and actual gap are distinct; metadata cannot advertise complete bodies. |
| A shared blob has two retained references | Removing one record cannot delete the other's content or bypass a hold/snapshot. |

- Family discrimination: a line with `v` is observation; a protocol Item line without `v` parses as Item; mixing headers fails.
- Join: when both families record one tool call, observation `parent` equals the Item id; using `corr` as that anchor fails the contract test.
- Location: an internal-agent hop without a protocol Item records `turnId` and no surrogate Item `parent`.
- Coverage: server default is `on`; explicit Workspace/task off overrides persist scope/value/provenance, not purpose flags. Sequential Turns can bind different values without rewriting history. Restart does not recompute old policy; missing required binding blocks governed collection. Historical off/absent/failed/unsupported/non-occurring cases remain distinct.
- First-release matrix: configured model does not fill provider snapshot; omitted sampling is not default-filled; wire digest and `context.evicted` remain labeled unsupported. Under an explicit `off` override, Collect metadata remains present or recorded as failed required collection.
- Segmentation: a Turn that exceeds the declared cap is not split mid-Turn; `thread.json` declares the delay; a conflicting second successor for `(parentThreadId, segment)` fails closed; inspecting an already-published exact successor after restart does not; a history read with a missing parent stays unresolved and is not rejected.
- B′: a restricted body is not inlined on a `turn-evidence` row at any size.
- References: `mismatch` is distinct from `absent` and from owner denial/unavailable; destination-side rebinding of a `scope:'server'` image digest fails; two imported groups that both contain `corr=c1` do not join.
- Import table: the two-hop example remints `T`, observation ids, and Item `I`; `corr` pairs only inside the reminted group; blob digests stay; server-scoped refs stay unresolved; AEP identity follows the map, not a pre-remint record digest.
- Uncertainty: no fixture may persist `Turn.status = 'unknown'`.
- Durability: a committed publication never cites unpublished bytes; unendorsed orphan blobs may exist and are ignored; `fsync` presence alone is not a pass.
- Identifiers: a time-range filter that sorts UUIDv7 ids without reading `turn.json` is not a passing correctness test.
- Public Gateway: Workspace-only calls capture under that Workspace without inventing a Thread/Turn; unattributed calls retain server-scope coverage and native bodies under existing server roots. Missing required storage is a capture/admission failure, not a blind successful-capture claim.
- JSON fidelity: reconstruct actual upstream and translated Worker-facing requests/responses with exact native fields, strings, array order and null/omitted distinctions. Configured defaults and semantic summaries cannot substitute for observed wire bodies.
- Streaming: replay ordered native chunks across split UTF-8/JSON/tool deltas; derive the final response without a second stored copy. Prove first-token/completion observation boundaries and explicit interrupted/error/missing-chunk coverage.
- Deduplication: growing requests reuse message/prompt/tool blobs and sequence subtrees. Inspect newly written payload/manifest bytes; a complete prefix/body or full reference-array copy per request fails the cost criterion. Edits preserve old roots.
- Native capture: harness-format bytes and observed stderr/log bytes remain unchanged; kind/version provenance is explicit. A log budget overflow has ranges/counts, limit and truncation reason; unknown omitted length is not zero. Parser failure cannot silently discard retained raw bytes.
- Safety: injected/held credentials spanning chunks never enter any blob, envelope or export. A refused unit creates a safety gap; non-secret provider-native fields and other sensitive work content are not silently filtered. Raw reads require current authorization and audit.
- Context: resolve delivered message roots and source/digest refs for Knowledge, Memory, Skills, attachments and Policy/AEP. Selection alone does not prove delivery; unavailable source/inside context is not reconstructed from today's data.
- Judgment: approvals/denials/answers resolve to the exact existing request/work and deciding actor; Review/edit links name exact versions. Retries and ratings keep their owner and provenance; absent features remain declared gaps.
- Lifecycle: journal references supply step facts without another state machine or content-bearing spans. Dropping the diagnostic sink changes no retained work record.
- Scope/closure: Workspace snapshot/move carries every reachable managed capture blob; server-only capture stays server-scoped. Cross-scope digest equality grants no access. Shared blobs survive while another retained ref/hold/snapshot needs them; lawful disposal leaves truthful unavailability.

## Deferred / Future Work

- Implementation of the ordered collector increments below is incomplete, not optional omission of the default-on target.
- Raw wire-byte digest remains unsupported until its producer names that byte boundary; a canonical JSON message digest is not a raw transport digest.
- `context.evicted` producer; the type may exist as unsupported with no producer.
- Layer-3 runtime-assembled context manifests.
- Verified image digest → harness binary version map.
- Indexing, BM25, and semantic search.
- Evaluation Harness.
- Remaining judgment producer/link coverage; the existing Pending Request lifecycle stays with its owner.
- Crash-boundary durability verification beyond the implemented file and directory synchronization.
- Optional unique UUIDv7 filter helper plus a failing test, if chosen over the review-obligation form.

## Open Questions

- AgentSession-axis `unknown` has no accepted owner; this spec does not decide it.
- A failed Plan proposal leaves the Goal open and does not clear a still-valid active version, as `docs/specs/20261002-goal.md` defines. That is not an open format question.
- Whether the two live denial paths that write Turn `cancelled` versus `interrupted` should unify is a product-owner decision, not a format field.
- Whether a mandatory UUIDv7 filter helper plus failing test is required, versus a review checklist, is not closed; this spec states the consumption rules and the present lack of a parser.
- Adding `actor` to `StatusItem` was proposed so "who interrupted" is on the narrative axis; it is not authority to implement now. Until protocol admits it, structured interrupter identity stays on the observation row or an existing owner, not a silently dropped requirement.
- Envelope extra header names (C8) and portable inventory (C6) are admitted by their existing owners. Kernel typed Item (C9) and quarantine `restricted-evidence` mapping remain pending their owners.

## Risks & Mitigations

- Compressing review rounds into this contract could drop a bound. Mitigation: withdrawn fields (`perc`, `span`, `aud`, Turn `unknown`, row TTL, size-based placement, `corr` as Item join) are listed as exclusions, not omitted.
- Default-on capture increases storage and access risk. Mitigation: scoped content deduplication, shared manifests, bounded streaming/log collection, existing operator retention/deletion policy and audited restricted-raw reads; no capture-time purpose gate or silent loss.
- Semantic adapters or parser limits can discard native fields. Mitigation: retain native exchanges/transcripts first, derive normalized views later, and expose source/exclusion/truncation gaps.
- Citing a disappearing `sandbox_runtime_records` row would false-absent harness identity. Mitigation: copy the digest value at bind/reuse time.
- Treating export `expired` as source deletion would false-reclaim. Mitigation: disposal follows the target owner's scope-specific semantics.

## Alternatives Considered

- Single-family JSONL mixing narrative and observations (Codex-style): rejected because differential retention would be impossible without deleting narrative bytes.
- Per-thread coverage changelog or epoch-id chain: rejected; `turn.json` admission binding is cheaper and portable.
- Turn status `unknown`: rejected; effect uncertainty already has CapabilityCall and recovery owners.
- Row-level TTL and tombstones: rejected under B′.
- Size-threshold inline: rejected; placement follows content kind.
- Using `workerRequestDigest` or AEP `instructions: []` as system-prompt digest: rejected.
- Closed `cause` enum: rejected; open vocabulary plus an association ref to the decision record.
- Thread-level task-instance key: rejected; Goal tasks share a Thread and attempts are Turns.

## Links

- `docs/core/storage.md`
- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260703-schema_evolution_record_envelope.md`
- `docs/core/protocol.md`
- `docs/core/mediation.md`
