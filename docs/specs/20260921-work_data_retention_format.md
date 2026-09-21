---
status: Accepted
implementation: Not Started
date: "2026-09-21"
updated: "2026-09-21"
---
# Work Data Retention Format

## Summary

This specification owns the semantics and content model of retained OpenKit work data: what is kept, who may author it, how two record families join, how absence is distinguished from non-occurrence, and which declarations cannot be reconstructed later. Physical `DATA_ROOT` placement, source-of-truth trees, and what `turn.json` is as a file remain owned by `docs/specs/20260703-storage_layout_record_ownership.md`. Core meanings of Thread, Turn, Item, and AgentSession remain owned by Core. Architecture and technology-stack selection are out of scope.

The unique first-release criterion is: for every class of information that will only be collected later, the first-release format MUST let a reader distinguish "was not collected then" from "did not happen then". A format that cannot make that distinction would later claim completeness by default, which cannot be repaired after production data exists.

## Owns

- The purpose of retained work data and the judgement that admits a fact into the work-data record.
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
- Indexing, BM25, or multimodal semantic search. The engineer placed those out of scope.
- Architecture and technology-stack selection (step 3 of the work-data lock; not started).
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
- `docs/core/agent-capability.md`
- `docs/core/contract-evolution.md`

## Related Docs

- `docs/specs/20260703-storage_layout_record_ownership.md`
- `docs/specs/20260703-schema_evolution_record_envelope.md`
- `docs/specs/20260703-audit_usage_evidence_records.md`
- `docs/specs/20260704-agent_session_continuity.md`
- `docs/specs/20260704-workspace_backup_export_import.md`
- `docs/specs/20260616-agent_environment_package.md`
- `docs/specs/20260802-nanohost_runtime_and_transport.md`
- `docs/specs/20260704-goal_mode_coordination.md`
- `docs/specs/20260908-generative_kernel_data_operations.md`
- `docs/specs/20260703-runtime_scheduling_scale.md`

## Goals

- Retain, on the agent-loop axis, the facts needed to explain why an Agent ran as it did, what it did, what was observed, and how the work was evaluated.
- Keep world-state off that axis: files, repository contents, and environment current-state remain re-readable and MUST NOT be snapshotted as work data.
- Serve six uses, with the design floor set by fine-tuning/post-training, audit, and multi-dimensional eval, not by resume.
- Make missing data distinguishable from wrong data, and missing collection distinguishable from non-occurrence.
- Keep the protocol Item stream as the user-visible narrative and the observation ledger as annotations on a different axis.

## Non-goals

- Do not copy a durable-execution harness or invent a generic resume engine.
- Do not resume the same execution identity after interruption; succession uses retained data plus a new Thread.
- Do not snapshot working-tree bytes, CRDT world state, or keyboard capture.
- Do not promise exactly-once external effects.
- Do not add a second work state machine or a second product scheduler.
- Do not pre-build a signature chain or tamper-evident ledger. Ordinary checksums MUST NOT be advertised as that guarantee.
- Do not collect unpublished reasoning, authentication headers, Vault secrets, or raw audio by default.
- Do not turn the product into Event Sourcing.
- Do not implement the Evaluation Harness in this contract.
- Do not add row-level TTL, tombstone rows, a CaptureBatch owner, or a per-thread coverage changelog.

## Background

An Agent is a model plus a runtime. Work records therefore equal agent observations (model-side interactions that pass through Gateway, plus runtime kind, version, and environment) plus external intervention and Core decisions (user input, interrupt, approval, product acceptance). Agents are cheap scheduling units: the system does not restore an interrupted execution in place. The environment is not deterministic; reversed tool-call order from network jitter is an accepted outcome, and a perfectly recorded outbound call still does not prove that a third party processed it.

The six uses are succession/resume, audit, multi-dimensional eval/analysis/optimization, fine-tuning/post-training, knowledge extraction, and workflow improvement. Resume needs a subset of the other three high-intensity uses and MUST NOT set the floor. Multi-dimensional eval is a product capability and requires complete resolved configuration fingerprints, a task-instance identity orthogonal to Thread/Turn, and outcome labels with provenance. Fine-tuning requires lossless model I/O and separation of "what the model saw" from "what actually happened"; the engineer ruled that the architecture MUST cover that I/O while this release does not implement it, behind a task/workspace/server switch that defaults to off.

## Decision

Use two families that do not share order: naked protocol Items as the narrative, and a split-envelope observation ledger as environment and system notes. Bind capture coverage per Turn at admission into `turn.json`. Carry only long-term main facts and minimal references on observation rows (B′). Express effect uncertainty on the effect owner, not as a Turn status. Turn terminals remain the Core four-value set already corrected in `docs/core/protocol.md` by commit `968f5a4e`. Leave physical placement to the storage-layout owner.

## Contract / Expected Behavior

### Purpose And Retention Criteria

**Definition.** Retained work data answers: under which visible context and tool definitions, which model/Agent produced which action or answer; what observation followed; how the work was finally evaluated. The loop axis is complete (model I/O slots, tool I/O slots, Core decisions, human intervention). The world-state axis is not stored.

**Exclusions.** World snapshots, unpublished reasoning, Vault secrets, authentication headers, and default raw audio are out. A producer list is not a membership vote; the unified model already says what belongs.

**Authority.** This spec owns the admission judgement. Core owns Thread/Turn/Item meanings. Existing evidence families own their own records.

**Lifecycle.** Facts are captured at the moment they exist. Capture-time identities and coverage cannot be backfilled. Collectors MAY be added later only when the format already distinguishes their historical absence from non-occurrence.

**Failure.** Wrong data is worse than missing data: an Agent compensates for a gap and cannot compensate for a false authoritative fact. Inferred content MUST be marked. A silent drop of collected bytes is wrong data, not a gap.

**Acceptance.** A reader can tell, for each declared collection class, whether that class was off, attempted and failed, submitted and later unavailable, or never applicable. Eval can group runs by resolved configuration identity without reading world-state snapshots.

Multi-dimensional eval requires, as format slots even when empty: provider plus resolved physical model id plus snapshot when the producer exists; harness kind plus the measured identity this spec defines; system-prompt digest at the pre-adapter semantic boundary; sandbox image digest plus resource configuration; AEP `packageSnapshotId`; per-skill id and version; per-MCP id, version, and exposed tool set; named requested sampling fields. Digest here is a grouping key, not an integrity proof. Task-instance identity is capture-time and orthogonal to Thread: one Goal task may span many Threads and many Turns. Outcome labels come from existing Artifact Review decisions, automatic signals (tests, builds, exit codes), process signals (steps, tool counts, human interventions, cost, duration, compaction), and LLM-as-judge records that MUST carry judge model and rubric version.

### Collection Responsibility

**Definition.** Four points each record only the facts they uniquely know.

| Point | Unique facts | MUST NOT be trusted for |
| --- | --- | --- |
| Gateway | Complete model-interaction body when collected, resolved model, token/cost | Sandbox-internal execution |
| NanoHost (outside the sandbox, under our control) | What was actually injected: image digest, AEP, mounted skill/MCP versions, resource configuration, container lifecycle | In-sandbox tool detail |
| Sandbox sidecar (inside the sandbox) | Actual tool execution and return, process events, harness-internal state | Authorization and identity; it sits inside an untrusted boundary |
| Core | Actor, authorization decisions, approvals, product acceptance | Agent-internal behavior |

**Exclusions.** This is not a two-way choice between sidecar harvest at end-of-work and Gateway intercept. Configuration fingerprints are recorded by NanoHost, not self-reported by the sidecar. Sidecar reports stream incrementally; end-of-work bundling is forbidden because a crash is the diagnostic case. Managed backends that admit neither sidecar nor Gateway MUST declare the coverage gap so eval cannot mix them with self-hosted runs.

**Authority.** Each point writes only in its observer value `obs`. NanoHost owns injection identity. Core owns authorization records.

**Lifecycle.** Create on observation. Sidecar lines MUST be appendable before sandbox exit. Retry of a collection attempt is a new observation or an idempotent publication of the same identity and same content, never a silent overwrite of a different fact. Two writers MUST NOT publish conflicting payloads under one observation `id`; a conflict is `recovery_required` for that line, not a pick-one merge. Downstream publication failure (blob fsync failed, append failed) is the writer's: the line is uncommitted, not a different observation.

**Failure.** Sidecar self-report of experimental conditions is invalid for A/B grouping. A public Gateway call that has valid Workspace attribution and a null `threadId` (`apps/nanocore/src/llm/gateway-routes.ts:152-168`, `startCapabilityCall`) MUST NOT invent a workspace-level observation file; it remains on the existing CapabilityCall plus a coverage-gap declaration. A public Gateway call with no lineage or no `coreDb` returns null before any call is created (`:137-145`) and is a fully blind gap: no CapabilityCall, no observation file, and no new owner invented here.

**Acceptance.** A run's configuration identity can be grouped from NanoHost/Core facts without asking the sandbox to certify its own treatment. A crashed sandbox still has whatever the sidecar had already streamed.

### First-Release Capture Matrix

Implementation topology (who writes which collector) is deferred to architecture/technology selection. The table is the first-release byte-meaning contract. Empty unsupported slots are allowed only for cells this table marks Unsupported or Deferred. A Collect cell remains a required first-release producer even while its writer is unimplemented: absence is a missing producer, not permission to omit the cell. Real collection failures still record unknown or unavailable outcomes; those outcomes MUST NOT be used to reclassify a Collect cell as unsupported. Required metadata collection (the Collect rows) is independent of later switched full model I/O. The coverage switch governs full I/O families (model request/response bodies and other restricted originals), not these metadata cells.

| Cell | First release | Observation boundary | In-row | MUST NOT |
| --- | --- | --- | --- | --- |
| Configured provider and physical model | Collect | Dispatch attempt at the shared dispatch, not transport send and not stream completion | Provider identity and configured physical model id | Copy the whole provider request as `params:{...}`; treat dispatch attempt as a sent HTTP request |
| Provider-reported snapshot | Collect when a provider response exists | Response side | Snapshot as the provider reported it | Fill this cell from the configured model |
| Requested sampling | Collect | After dispatcher conversion and before the Pi adapter, not original entry JSON and not wire payload | Named fields with types and value bounds, including non-numeric `reasoning.effort` as well as temperature. Dispatcher conversion renames max-token and reasoning fields (`apps/nanocore/src/llm/gateway-converters.ts:63-74`, `convertChatCompletionToResponsesRequest`), so pre-conversion field names are not the byte contract. | Guess omitted values from adapter defaults; claim effective/final sampling; invent a complete numeric-bounds schema |
| Wire digest | Unsupported; no producer | — | Empty slot labeled no producer | Describe the slot as collected |
| `context.evicted` | Unsupported; no producer | — | Format slot only | Describe eviction as collected |
| Internal-agent `env.bound` | Collect | Core | NanoCore `version`, `workspaceId`, prompt digest; tools as name plus input-schema digest | Inline tool description or full schema; record a tool version (currently unavailable); inline prompt body |
| Task-instance pairing | Collect | Turn creation | `(goalId, taskId)` on the Turn when applicable | Bind the key on the Thread; invent a Task for non-task Turns |
| `turn.reap` | Collect | Core recovery decision | `reason`, `lastObservedTs`, unresolved-call `corr`/`type`/`name`/`ts`, `inferredBy` | Inline full exception, stdout, arguments, or withdrawal-source summaries |
| Layer-3 runtime context manifest | Unsupported | — | — | Treat as first-release data |
| System-prompt digest | Collect | Pre-adapter semantic boundary | Digest only | Use `workerRequestDigest`; promise one hook; treat as full I/O |
| Harness identity | Collect | Bind and reuse | Authored `runtimeVersion` label plus copied image-digest value | Treat authored `runtime.image` or AEP `runtimeVersion` as measured version |

### Two Record Families

**Definition.** `items.jsonl` is the work line: requests, replies, user input, and interaction. Its file append order is the narrative total order. Observation ledgers are environment and system notes beside that line, not on it. They do not share order. `docs/core/work-model.md` already states that the thread narrative and ordered Item history remain the user-visible source of truth.

**Exclusions.** Do not merge the families into one sequence. Do not treat observation position as a narrative rank. Do not add envelope fields to protocol Items. Do not keep a thread-level `items.jsonl`; protocol `BaseItem.turnId` is required, so a thread-level item file cannot hold a legal Item.

**Authority.** Protocol owns Item schemas and discriminators. This spec owns observation semantics. `docs/specs/20260703-storage_layout_record_ownership.md:287`, under `Structure Evolution Rules`, already states the split: `items.jsonl` lines are protocol item event records; observation ledgers carry per-line `v`, `type`, `id`, and `ts`, with `ownerScope`, lineage defaults, and `requiredFeatures` in a directory-level manifest.

**Family discrimination.** An observation line has a `v` header field. An Item line does not. Family MUST be decidable from the line itself, not only from the path.

**Join.** When the same event appears on both families, the observation MUST anchor with `parent` to the Item `id`. `corr` MUST NOT be used as that anchor. UI merge is not a contract. Pointer direction is observation → Item only.

**Three-tier location.**

| Case | Rule |
| --- | --- |
| A corresponding Item exists | MUST anchor to that Item (`parent`; `corr` only for request/response pairing of the same logical call) |
| No corresponding Item, but a Turn exists | Anchor only with `turnId`. MUST NOT invent a surrogate `parent` on an Item the observation was not assembled from (worker N-hop private transcripts, internal-agent in-memory messages) |
| No Thread, valid Workspace attribution | MUST NOT write a thread observation ledger. Leave the existing CapabilityCall plus the coverage-gap declaration |
| No lineage or no database | Fully blind: no CapabilityCall and no observation file (`apps/nanocore/src/llm/gateway-routes.ts:137-145`). Declared gap; not a promised fallback |

Multiple observations under one Item or one `turnId` are ordered by observation-file append order (ingest order). Late backfill MUST NOT be advertised as physical order; coverage MUST say so.

**Lifecycle.** Items follow protocol create/update/terminal rules. Observations are append-only lines. A Turn is the execution unit; observations that belong to a Turn carry `turnId`.

**Failure.** Cross-source `ts` order is a hint, not a fact. Four observers do not synchronize clocks. Network-reordered tool calls across sources are accepted. Missing interior `seq` values detect truncation of the observation file; a legal prefix after a lost last line is not detectable by `seq`. Item files detect torn tails by the last `0x0a` byte, not by `seq`. Pairing by `corr` is scoped to one logical-call group in one execution namespace (see References); bare `corr` MUST NOT be used as a global join key.

**Acceptance.** A reader can reconstruct the Item narrative without reading observations. A reader can place an observation relative to its Item or Turn without a cross-family sequence allocator.

### Workspace SQLite Boundary

**Definition.** Facts that must commit atomically with product state (authorization and policy decisions, approvals, usage and cost, Artifact Review) already have SQLite homes. The observation ledger and `items.jsonl` are the retention axis. The same durable id MAY appear in both places as lineage, not as a second product model.

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
| `obs` | yes | Observer: `gateway` \| `nanohost` \| `sidecar` \| `core` |
| `ret` | conditional | Core retention class when the row has a long-term or restricted class to assign; omitted means the type's default class from its owning write rule, not "no retention". See `ret` |
| `parent` | conditional | Scalar parent id: observation id or Item id |
| `corr` | conditional | Pairing key for one logical call's request and response; no external referent |
| `outcome` | conditional | `ok` \| `error` \| `unknown` on rows that describe an external-effect terminal |
| `cert` | conditional | Omitted = direct observation; `"inferred"` = writer inference or model/ASR generation |
| `turnId` | conditional | Present = Turn partition; absent = thread-level observation partition |
| `refs` | conditional | Self-describing external references; see References |
| `ext` | conditional | Namespaced extensions; MUST NOT pollute canonical fields |
| `payload` | yes | Main facts allowed by B′, shape per `type` |

`ownerScope`, lineage defaults, `requiredFeatures`, and redaction defaults live on the directory-level manifest (`thread.json` / `turn.json` as the storage owner already assigns), not repeated per line.

**Exclusions.** `perc`, `span`, and `aud` are not fields. `payload` is not a lossless dump of arbitrary content. `refs` is not an array of bare digest strings. `parent` is a single id, never a list.

**Open `type`.** New kinds are new string values. Readers MUST NOT treat unknown canonical types as processed (`docs/specs/20260703-schema_evolution_record_envelope.md`, `Reader Contract`). Authority-bearing new behavior MUST also gate on `requiredFeatures`. Product UI MUST have a generic fallback renderer so a closed switch over types cannot crash on a new kind. Payload shape is per `type`; a type MUST NOT carry restricted or time-bounded bodies in-row (B′). Concrete payload fields for first-release types are the First-Release Capture Matrix. Canonical extra header names beyond the split-envelope minimum are a pending admission of the envelope or storage-layout owner (C8); this spec states the intended set, not an already-admitted wire schema.

**Lifecycle.** Append only. Identity fields that naturally exist in `payload` are also in the header and MUST cross-check on decode; mismatch is corrupt, not a pick-one merge. Same `id` with different content is a conflict, not an overwrite.

**Failure.** Unknown optional `ext` fields follow envelope preserve-or-ignore rules. Unknown required features fail closed on portable import. A corrupt header (missing required `v`/`type`/`id`/`ts`/`seq`/`obs`, or `seq` not contiguous with surviving interior lines) fails that file's read, not a silent skip.

**Acceptance.** A sweeper can classify `ret` without parsing `payload`. A reader can reject an unknown type without guessing. Family is visible from `v`.

### Retention Class `ret`

**Definition.** Observation `ret` uses only the Core closed set from `docs/core/storage.md` (`Retention Classes`): `ephemeral-diagnostic`, `turn-evidence`, `workspace-audit`, `restricted-raw`, `legal-hold`. Agent features introduce no sixth class on observation rows. Quarantine currently types `retentionClass` as `restricted-evidence` | `workspace-audit` | `legal-hold` (`packages/app-api-schemas/src/workspace-sync.ts:448`); evidence bundles already use `restricted-raw` (`packages/app-api-schemas/src/evidence-bundles.ts:26-31`). Whether quarantine `restricted-evidence` is the same class as `restricted-raw` is a pending admission of `docs/core/storage.md`. Until that owner admits a mapping, observation rows MUST NOT emit `restricted-evidence`.

**Exclusions.** Do not add `restricted-evidence` to this format's `ret` vocabulary. Do not apply `ret` to protocol Items; Item visibility is type plus Permissions. Do not infer that the closed retention set forbids a separate audience vocabulary; visibility and retention are different concerns, and this spec does not introduce an audience field. `ret` on a row is that row's class; a referenced blob's class is the target owner's. `ret` MUST NOT be rewritten to `workspace-audit` merely to keep a blob. `legal-hold` MAY cover an otherwise ordinary main fact and then blocks compaction or deletion until released; it does not authorize access (`docs/core/storage.md`, `Agent Data Retention And Deletion`).

**Authority.** Core owns the vocabulary and any quarantine fold. This spec assigns only Core tokens on observation rows. Owning record specifications assign ordinary windows.

**Lifecycle.** Set at write. Same `type` MAY carry different `ret` for permitted in-row metadata (for example ordinary versus secret-bearing tool identity); stdout and other bodies remain separately owned external content under B′, not an in-row class split of the same bytes. Days-in-window are operational knobs, not format constants.

**Failure.** Mixing restricted raw body into a long-term row violates B′. Retention never grants visibility or access. Permissions and hold remain independent of `ret`.

**Acceptance.** A retention sweeper reads `ret` from the header. No observation row uses a class outside the five Core tokens.

### Retention Basis B′

**Definition.** An observation row carries only main facts that an owner allows to keep long term, plus minimal references: identifiers, times, quantities, results, configuration identity, necessary associations. Time-bounded diagnostics, restricted originals, and complete model I/O live with their owners or external blobs, which execute recycle, hold, revocation, and access failure.

**Exclusions.** No independent daily row-level TTL. No tombstone rows. No deletion ledger. No promise that a row never disappears. Hard-delete of a Thread is not an existing Core operation and MUST NOT be assumed as a backstop.

**Authority.** This spec owns the content bound on observation rows. Blob lifetime follows Artifact, Source, evidence-bundle, and restricted-raw owners. Observation-row retain and delete follow the Thread/Workspace history owners already used for `items.jsonl` and workspace deletion closure, not a new sweeper invented here.

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

**Engineer ruling.** A reference MAY fail to resolve. A reference MUST NEVER be wrong: it MUST NOT bind to a different object than the one cited.

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

**Definition.** Coverage is the one declaration that cannot be added after the fact. It is a system-level effective setting, not a per-thread fan-out. Resolve `server → workspace → task` to one of `off` or `on` (default `off`). `off` still requires the Collect metadata cells in the First-Release Capture Matrix. `on` additionally enables full model I/O collection (request/response bodies and other restricted originals) when those collectors exist. Cells marked Unsupported stay empty under both values. The resolved pair `{scope, value}` is fixed at Turn admission, before any work governed by that coverage starts, and is written into `turn.json` as immutable historical content, not as a pointer into a live server changelog. `turn.json` is already rewritten on every persist by the storage owner, so this adds no file. The persisted declaration MUST be derived from that same effective capture policy, not from a separately maintained claim.

**Exclusions.** Do not store a thread-creation server epoch. Do not create CaptureBatch. Do not treat coverage as proof of collection success. Do not interrupt an already-started Turn when the capture switch changes. Security revocation of routes remains the continuity owner's rule and is not this switch.

**Lifecycle.** Create at admission. Unchanged for provider retry, human-gate wait, and proved exact reconnect of that Turn. Restart MUST NOT recompute a historical binding from current server config. A later Turn, including a sealed Turn's new attempt, re-resolves. Task-level override selects where to resolve; Turn stores which resolution this execution used. `(goalId, taskId)` when applicable is written on the Turn at creation, not on the Thread. Turns that are not Goal-task executions MUST omit the task tuple; planning Turns MAY carry Goal identity without inventing a Task.

**Failure.** Collector unsupported, fault, or missing data uses unavailable/failure facts. Changing a bound setting MUST NOT hide an execution gap. Records outside any Turn carry the bound setting only inside an already-named existing owner; they MUST NOT borrow a past or future Turn. Crash after the admission write fails is missing binding: governed collection MUST NOT start, and the Turn is not silently given current server policy. A conflicting existing binding on the same Turn is `recovery_required` for that Turn, not an overwrite. Historical Turns with no field remain distinguishable as never-recorded, not as `off`.

**Acceptance.** After default-off production, a reader can still tell then-off from never-recorded from did-not-happen. Fine-tuning I/O is unavailable under the default until a user turns the switch on and a collector exists; that is an accepted operational consequence, not a cancellation of the architectural slot. Under that same default, the Collect metadata cells (configured provider and physical model, provider-reported snapshot when a response exists, requested sampling, internal-agent `env.bound`, task-instance pairing when applicable, `turn.reap` when recovery runs, system-prompt digest, harness identity) are present or recorded as a failed required collection, not omitted as unsupported.

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
3. Effect owner and recovery owner: CapabilityCall `unknown` in `docs/core/agent-capability.md:70-84`; recovery requirements on the recovery owner. Interruption MUST NOT infer that an effect did not happen.

**Exclusions.** `unknown` is not a Turn status. Turn terminals are `completed`, `interrupted`, `cancelled`, `failed`, as corrected in Core by commit `968f5a4e`. `cancelled` means authorization to continue that Turn was withdrawn, including by the owning workflow when it determines the work is superseded; the specific reason is an Item, not another terminal value. `turn.reap` is normalized evidence of a recovery decision (why this Turn's execution is gone, on what basis), not a Turn `unknown` status. Command-outcome `unknown` and operation/transfer `unknown` stay with their owners.

**Lifecycle.** A terminal Turn is never reopened (`docs/core/core-concepts.md:97`, `docs/core/protocol.md`). Exact reconnect may continue a non-terminal Turn identity. A terminal `interrupted` Turn is a recovery entry for a new attempt, never re-execution of the old identity. `cancelled` does not auto-retry that identity.

**Failure.** Aggregating only `status === 'unknown'` on effect records is insufficient; other statuses are not proof of no effect. Absence of a matching CapabilityCall does not prove absence of effect risk.

**Existing-owner obligations (not a new UI workflow).** Cancellation of a Turn by itself does not require human attention; unresolved unconfirmed calls on that Turn still do. Unresolved unknown effects still block Goal `completed` (`docs/specs/20260704-goal_mode_coordination.md`, Goal completion predicate). Effect-specific duplicate-effect and replay checks remain with their owners (for example git-push recovery). These are pending implementation checks on those owners, not new format fields.

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

**Failure.** The current canonical append writer does not fsync; see Durability. Until that defect is closed, publication commit is not purchased.

**Acceptance.** A reader never has to ask "complete or incomplete"; only "inline or external". Size changes do not invalidate old rows. A committed line never names a blob that was not fsynced first; leftover unendorsed blobs are ignored, not treated as missing collection.

### Environment Binding And Cause

**Definition.** Environment is an observation, not a `thread.json` field. Worker environment copies of prompt/harness/skills/MCP MUST NOT be duplicated; AEP snapshot plus MCP schema snapshots are the owners, and observations `refs` them. Internal-agent `env.bound` remains because internal agents have no AEP; its receiver is Core, with in-row fields limited by the First-Release Capture Matrix. `config.model` records configured physical identity separately from any provider-reported snapshot. Requested sampling is the named typed fields at the dispatcher-to-Pi boundary; omitted values stay omitted. `cause` is an open string vocabulary, not a closed enum; the binding row MAY `refs` the decision record with `edge: 'association'`. Closed enums such as `initial|rollout|self-optimization|user-override|failure-fallback` are forbidden because mixed causes would lie.

**Harness identity (accepted degradation).** Do not treat authored AEP `runtimeVersion` as a measured harness version. Keep it as an unverified author label from `*.agent.jsonc`. The grouping key is the measured image digest copied as a value at binding time for both new and reused bindings, because `sandbox_runtime_records` rows including `image_digest` are deleted with the physical sandbox. Authored `runtime.image` refs are not image identity. This can false-split (same harness, new base image) and MUST NOT false-merge (different binaries labeled alike). It cannot answer "which Codex version" without a later verified image-to-binary map.

**System-prompt digest.** Collect the digest of the prompt at the semantic boundary before adapter conversion. Chat calls reach that boundary through one converter; Codex and bridged Responses reach it through another (`apps/nanocore/src/llm/pi-ai-client.ts:284-300`). The grouping is not injective: an absent prompt and an explicit default literal produce different pre-adapter digests and identical outgoing instructions. The format MUST name the boundary; it MUST NOT promise a single existing hook. `workerRequestDigest` is the worker-request body, not the harness system prompt, and MUST NOT substitute.

**Lifecycle.** Wake-up after idle writes "the environment I see now", not a two-month changelog. Mid-turn reconfiguration is a new Turn plus a new AEP snapshot under single-flight; this spec does not reserve empty fields for in-turn hot reload.

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

**Definition.** Thread and Turn ids use UUIDv7. Item ids remain deterministically derived for idempotency. Consumers MAY use UUIDv7 directory-name lexicographic order as a prefilter for time-range scans.

**Exclusions.** Consumers MUST NOT parse a timestamp out of the id (`docs/core/core-concepts.md`, `Identifier Semantics`). Id order is never the correctness criterion; after a prefilter the implementation MUST recheck authoritative `ts` / `turn.json` timestamps. This repository currently has a generator (`apps/nanocore/src/runtime/session-id.ts`, `generateUuidV7`) and no UUIDv7 timestamp parser, so a "must consume only via helper" rule is not yet an executable invariant; until a unique helper plus a failing test exists, the two consumption rules are a review obligation, not a storage invariant. New UUIDv7 allocation MUST NOT replace existing request-derived Item identities.

**Lifecycle.** Allocate at create. Remint on portable import for in-package owner ids.

**Failure.** Sorting ids and slicing without reading `turn.json` is a review defect. Colliding or conflicting replay of a request-derived Item id follows protocol command-receipt rules; this spec does not add a second allocator.

**Acceptance.** Correctness of time filters does not depend on id bits.

### Import, Remint, And Resolution Closure

**Definition.** Portable import remints in-package owner identities through exact maps. Classifying observation files into the portable inventory is a pending requirement of `docs/specs/20260704-workspace_backup_export_import.md` (C6). Until that owner admits the family, this spec MUST NOT treat export listing as already accepted. Cold whole-tree backup does not process the family and MUST NOT fail closed solely for an observation `requiredFeatures` gate.

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
| `parent` observation→observation | `o3` | `o3'` | Observation-family remint | Pending `requiredFeatures` recognition (C8/C6) |
| `parent` observation→Item | `I` | `I'` | Item map | In-package owner |
| `corr` | `c1`/`c2` | unchanged inside the reminted group | none | Pairing key; MUST NOT globally pair two imported groups that both contain `c1` |
| `refs` blob | digest of blob bytes | unchanged | none | Content-addressed; verify those bytes before import; do not rehash |
| `refs` AEP snapshot | `snapshotId` plus optional historical source-byte digest | `snapshotId'` | AEP map | Identity is the map. A historical digest MAY travel with declared byte coverage; it MUST NOT be the post-remint identity criterion |
| `refs` image digest `scope:'server'` | value plus source identity | unchanged, unresolved | none | Out of package. MUST NOT rebind by the same id on the destination |

**Lifecycle.** Private Threads of other users remain excluded under the backup/export owner. Observation-family portable listing waits on C6.

**Failure.** A wrong remint is a wrong reference. Using a pre-remint record digest as post-remint identity is forbidden.

**Acceptance.** After import, in-package joins still resolve to the same relative objects; `corr` pairs only inside the reminted group; server-scoped refs stay unresolved rather than attaching to a different deployment's object. Two imported executions that both used `corr=c1` do not join. Provenance-linked RuntimeEvidence receives a new id from the provenance package; other RuntimeEvidence keeps its identifier while its Thread/Turn/Goal/task foreign keys still remap.

### Durability

**Definition.** Publication commit is the fsync return of the observation line that cites already-fsynced blob bytes (and, when a new file is created, parent-directory fsync). Un-fsynced tail is uncommitted missing data, not committed wrong data. Turn terminal, blob-referencing lines, and coverage changes are commit points. Default is fsync per observation line unless a later measured change redefines the commit point first. Coverage and Turn-manifest persistence failure blocks governed collection before it starts; that persistence is the storage owner's `turn.json` rewrite, which today also lacks fsync (`writeFileAtomic` at `apps/nanocore/src/storage/workspace-file-records.ts:2498-2512`).

**Present defect.** `appendCanonicalTextFile` (`apps/nanocore/src/storage/workspace-file-records.ts:2450-2488`) opens `O_WRONLY|O_APPEND|O_CREAT|O_NOFOLLOW|O_NONBLOCK`, `writeSync`s, and `closeSync`s. It does not `fsync` the file or the parent directory. Closing the fd hands bytes to the kernel only. This is a verified present defect of the canonical writer, not the durability contract. The same storage tree already fsyncs file and directory in other paths; the append log does not.

**Failure.** Power loss after a non-fsynced append can drop lines the writer believed committed, which is wrong data under the missing-versus-wrong rule. Power loss after blob fsync and before line fsync MAY leave orphan blobs; they are unendorsed and ignored, not a committed publication.

**Acceptance.** After the writer defect is closed, a crash-boundary observation must show: a committed publication never cites unpublished bytes; unendorsed orphan blobs may exist and are ignored; missing `turn.json` coverage persistence blocks governed work. Observing that `fsync` was called is not by itself that observation.

## Current Implementation Projection

Implementation alignment is `Not Started` for this contract. Existing pieces this contract uses rather than replaces:

- Protocol Items persist as `ItemSchema.parse` then `JSON.stringify` into `items.jsonl` via `appendWorkspaceItemRevision` (`apps/nanocore/src/storage/workspace-file-records.ts:846-870`). The canonical append helper (`:2450-2488`) does not fsync.
- Turn terminals in Core are the four-value set (`docs/core/protocol.md`, `Turn Semantics`, after `968f5a4e`). `TurnStatusSchema` already includes `cancelled` (`packages/protocol/src/models/turn.ts:21-29`).
- CapabilityCall already has `unknown` (`docs/core/agent-capability.md:70-84`).
- Storage layout already names observation-ledger split headers (`docs/specs/20260703-storage_layout_record_ownership.md:287`, `Structure Evolution Rules`) and the `turn.json` file in the Turn directory (`:352`, `Workspace Storage Layout`).
- Coverage binding, observation writers, copied image-digest values, system-prompt digest producers, and observation `requiredFeatures` import recognition are not implemented.
- Gateway CapabilityCall rows today use `redactionClass: 'metadata-only'` (`apps/nanocore/src/llm/gateway-routes.ts:162`, `:665`) and do not persist bodies; that matches default-off I/O collection, not a claim that bodies were collected.

### Evidence Strength

Implementation facts restated in this specification were re-verified by opening the cited file in the current tree at HEAD `968f5a4e0af0938b8237c05ac044cc754fcf4f8e` plus the uncommitted working-tree bytes of those same paths. Opened in this tree: `apps/nanocore/src/storage/workspace-file-records.ts:846-870`, `:2450-2488`, and `writeFileAtomic` at `:2498-2512`; `apps/nanocore/src/storage/workspace-import.ts:2347-2365` (`createWorkerRuntimeProvenanceEvidenceId`); `apps/nanocore/src/llm/gateway-routes.ts:137-145` and `:152-168`; `apps/nanocore/src/llm/gateway-converters.ts:63-74` (`convertChatCompletionToResponsesRequest`); `apps/nanocore/src/llm/pi-ai-client.ts:284-300` and `:802-808`; `apps/nanocore/src/runtime/session-id.ts:9-28`; `packages/protocol/src/models/turn.ts:21-29`; `packages/app-api-schemas/src/workspace-sync.ts:448`; `packages/app-api-schemas/src/evidence-bundles.ts:26-31`; `docs/core/protocol.md` Turn terminals; `docs/core/storage.md:123-131`, `:133-149`, and `:173-185`; `docs/core/core-concepts.md:81`, `:113`, and `:117`; `docs/core/agent-session.md:87`; `docs/core/agent-capability.md:70-84`; `docs/core/work-model.md:26`; `docs/core/core-concepts.md:151`; `docs/specs/20260703-storage_layout_record_ownership.md:16-24`, `:277-279`, `:287`, `:335`, and `:347-352`; `docs/specs/20260703-schema_evolution_record_envelope.md:165-173`; `docs/specs/20260703-runtime_scheduling_scale.md:126`; `docs/specs/20260704-workspace_backup_export_import.md:81` and `:141`; `docs/specs/20260908-generative_kernel_data_operations.md:122` and `:211`; `docs/specs/20260704-goal_mode_coordination.md:183`. The discussion record's facts were originally pinned at baseline `c1a8b6ad` and were not all re-verified at that commit. Carried without independent confirmation in this tree: third-party grep-first percentage claims; external-harness comparison tables; the note.md §10 inventory as of `c1a8b6ad`; `workerRequestDigest` internals; the AEP assembler writing `instructions: []`.

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

**Disposition.** Resolved differently. Turn `unknown` was withdrawn. Commit `968f5a4e` corrected the documents: Turn terminals are `completed`, `interrupted`, `cancelled`, `failed` (`docs/core/protocol.md`); `docs/core/agent-session.md:87` (`Replacement`) now keeps the Turn's truthful lifecycle result and leaves effect/recovery uncertainty with those owners. CapabilityCall `unknown` remains (`docs/core/agent-capability.md:70-84`).

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

**Disposition.** Live pending owner admission. This spec does not edit the backup/export owner and does not treat export listing as already accepted.

### C7 — Item-log persistence invariants

**Owner.** `docs/core/storage.md:8-9` (`Storage Model` opening) owns item-log persistence invariants; `:173-185` (`Item Log Invariants`) require append-only Item logs, preserved protocol order, and single-writer append.

**What the early record wanted.** Item losslessness plus a raw content reference on the Item.

**Disposition.** Moot for that request. This format keeps Items as naked protocol JSON, so it does not ask Core to widen `ItemSchema` or add raw refs. Residue: those invariants remain on `items.jsonl`; observation durability is this spec's append/fsync contract, not a rewrite of the Item-log section.

### C8 — Envelope header slots

**Owner.** `docs/specs/20260703-schema_evolution_record_envelope.md:165-173` (`Line-Oriented Records`: split-envelope minimum `v` / `type` / `id` / `ts`; the owning storage spec names concrete header fields).

**What this format needs.** Observation lines add `seq`, `obs`, `ret`, `parent`, `corr`, `outcome`, `cert`, `turnId`, `refs`, and `ext` beyond the split-envelope minimum. `perc` and `span` are absent; audience is not a field; `parent` is observation-only; `seq` is per-file truncation detection. `payload` is the body, not a header slot.

**Disposition.** Live pending owner admission. The intended header is the envelope table in Observation Ledger Envelope. Implementation MUST NOT treat those extra names as canonical until the envelope or storage-layout owner admits them.

### C9 — Kernel operations on the narrative axis

**Owner.** `docs/specs/20260908-generative_kernel_data_operations.md:211` commits attributed AuditEvent and a metadata-only receipt in the app-database transaction; `:122` says user-visible operation outcomes are item-backed through existing owners.

**What this format needs.** A typed narrative Item for Kernel work (stable app/schema/digest references, analogous to `generative-ui-reference`) so eval can find light-app construction without grepping a tool name.

**Disposition.** Live pending owner admission. This spec does not decide the Kernel owner's change and does not itself emit that Item.

### C10 — Runtime evidence versus Runtime Epoch addressing

**Owner.** `docs/specs/20260703-runtime_scheduling_scale.md:126` (`NanoHost Boundary`): "NanoCore neither addresses nor stores Runtime Epoch identity."

**Normative distinction.** Retaining runtime evidence on the observation axis MUST NOT be implemented as NanoCore addressing or storing Runtime Epoch identity for scheduling, placement, or capacity. Copied measured facts (for example image digest at bind time) are historical identity on the retention axis. Scheduler targeting, lease, and capacity remain the scheduling owner's records; Runtime Epoch identity remains NanoHost-private. The two obligations do not conflict when that separation is kept. Implementing retention as a second epoch-id scheduling key WOULD conflict with `:126` and is forbidden.

**Disposition.** Live. This distinction is a requirement of this spec.

## Testing Strategy / Acceptance Criteria

- Family discrimination: a line with `v` is observation; a protocol Item line without `v` parses as Item; mixing headers fails.
- Join: when both families record one tool call, observation `parent` equals the Item id; using `corr` as that anchor fails the contract test.
- Location: an internal-agent hop without a protocol Item records `turnId` and no surrogate Item `parent`.
- Coverage: two sequential Turns in one Thread with the switch flipped between them persist two different bound values on their `turn.json`; the first Turn is not rewritten; default is `off`; restart does not rewrite a historical binding from current server policy; missing binding blocks governed collection.
- First-release matrix: configured model does not fill provider snapshot; omitted sampling is not default-filled; wire digest and `context.evicted` remain labeled unsupported. Under default `off`, the Collect metadata cells are present or recorded as failed required collection.
- Segmentation: a Turn that exceeds the declared cap is not split mid-Turn; `thread.json` declares the delay; a conflicting second successor for `(parentThreadId, segment)` fails closed; inspecting an already-published exact successor after restart does not; a history read with a missing parent stays unresolved and is not rejected.
- B′: a restricted body is not inlined on a `turn-evidence` row at any size.
- References: `mismatch` is distinct from `absent` and from owner denial/unavailable; destination-side rebinding of a `scope:'server'` image digest fails; two imported groups that both contain `corr=c1` do not join.
- Import table: the two-hop example remints `T`, observation ids, and Item `I`; `corr` pairs only inside the reminted group; blob digests stay; server-scoped refs stay unresolved; AEP identity follows the map, not a pre-remint record digest.
- Uncertainty: no fixture may persist `Turn.status = 'unknown'`.
- Durability: a committed publication never cites unpublished bytes; unendorsed orphan blobs may exist and are ignored; `fsync` presence alone is not a pass.
- Identifiers: a time-range filter that sorts UUIDv7 ids without reading `turn.json` is not a passing correctness test.
- Public Gateway: null `threadId` with valid lineage has CapabilityCall and no thread observation file; missing lineage or `coreDb` has neither.

## Deferred / Future Work

- Step 3 architecture and technology stack.
- Full model I/O collection behind the default-off switch, including wire-byte digest once a real producer exists; the first producer that writes a digest MUST pick the boundary later full collection will use, or attach a deterministic mapping.
- `context.evicted` producer; the type may exist as unsupported with no producer.
- Layer-3 runtime-assembled context manifests.
- Verified image digest → harness binary version map.
- Indexing, BM25, and semantic search.
- Evaluation Harness.
- Delayed user-input specification.
- Closing the `appendCanonicalTextFile` fsync defect.
- Optional unique UUIDv7 filter helper plus a failing test, if chosen over the review-obligation form.

## Open Questions

- AgentSession-axis `unknown` has no accepted owner; this spec does not decide it.
- Whether Goal plan-revision failure handling (preserve scene, fail the Turn, do not fail the Goal) is admitted by `docs/specs/20260704-goal_mode_coordination.md` is implementation work under the change plan, not a format gap.
- Whether the two live denial paths that write Turn `cancelled` versus `interrupted` should unify is a product-owner decision, not a format field.
- Whether a mandatory UUIDv7 filter helper plus failing test is required, versus a review checklist, is not closed; this spec states the consumption rules and the present lack of a parser.
- Adding `actor` to `StatusItem` was proposed so "who interrupted" is on the narrative axis; it is not authority to implement now. Until protocol admits it, structured interrupter identity stays on the observation row or an existing owner, not a silently dropped requirement.
- Envelope extra header names (C8), observation portable inventory (C6), Kernel typed Item (C9), and quarantine `restricted-evidence` mapping remain pending their owners.

## Risks & Mitigations

- Compressing review rounds into this contract could drop a bound. Mitigation: withdrawn fields (`perc`, `span`, `aud`, Turn `unknown`, row TTL, size-based placement, `corr` as Item join) are listed as exclusions, not omitted.
- Default-off coverage makes most history `off`. Mitigation: every Turn still carries the bound value so later switch-on data does not rewrite the past.
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
- `docs/core/agent-capability.md`
