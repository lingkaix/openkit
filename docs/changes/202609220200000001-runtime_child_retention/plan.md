---
type: change-plan
status: in-progress
date: "2026-09-22"
branch: codex/runtime-child-retention
---
# Runtime Child Retention And Decision-Useful Timeline

## Intent Epoch 1 — 2026-09-22

The engineer requested retention of Worker-created runtime sub-agents and useful Chat/Task visibility, with agent-initiated challenges to accepted governing design independently examined by a Consultant and approved by the engineer. The engineer also proposed Strategic Programming, described as spending roughly 10–20% of each change on design maintenance. The adopted doctrine records it as a heuristic, not a quota; the original discussion and Stanford CS190 author-source link are preserved in temp/research/20260922-engineering-principles.md. The initial investigation proposed incremental child metadata and bounded timeline summaries, preserving the existing outer execution identity and restricted-evidence boundary. That investigation did not implement the feature.

## Intent Epoch 2 — 2026-09-22

The engineer clarified that complete data and content admitted by the existing parent-agent work-data capture design must be collected and retained for later inspection, audit, evaluation, scoring, knowledge extraction, self-improvement, and model fine-tuning/training. Metadata and summaries are insufficient retention. Ordinary users need decision-useful timeline information rather than every detail: what happened during the elapsed work, what requires approval or response, and what supports a voluntary correction. The engineer authorized Primary and Consultant to determine the concrete implementation and carry it out, preferring one or more PI agents for implementation. Finish with a working note explaining how the discussed engineering theories and methods apply to future development, maintenance, and governance. No commit, push, deployment, external publication, or unrelated data collection was requested.

## Owners And Accepted Boundaries

Root AGENTS.md and docs/change-execution.md own execution. docs/specs/20260921-work_data_retention_format.md owns Item versus observation families, body/metadata separation, capture coverage, identity, and durability. docs/specs/20260711-worker_runtime_subagent_provenance.md owns runtime-origin evidence, with children remaining within the outer Worker execution. Worker control, storage layout, evidence retention, permissions, and Web projection retain their existing owners. The clarification authorizes completing the admitted full-content capture path and revising affected owners within this intent; it does not authorize secret or unpublished-reasoning collection, a second scheduler, or unrestricted raw-content disclosure.

Capture policy remains the existing admission-bound setting: required metadata is independent of full-I/O capture; complete admitted bodies must actually be preserved when that capture is enabled. A gap or unsupported source is explicit, never a zero-child or complete-retention claim. Restricted bodies cannot be replaced by UI summaries. Source reports remain evidence, not child execution authority.

## Working Checkpoint

Baseline is a1ad346685f788e31b5233a14da662d3281fba77, clean at start. Primary created codex/runtime-child-retention without committing or staging. Earlier investigation and 28 passing baseline tests are retained under the same-name temp/changes directory; the broader clarified implementation has not yet been verified. The independent Claude Code Consultant scrutinized the full-content retention route and corrected its initial unsafe text-tier and already-present origin-ref assumptions. Six GPT-6 astra PI builders now own protocol/config, Core persistence/ingestion, runtime capture, Gateway/internal entry capture, timeline projection, and portable closure respectively; Primary owns accepted-owner alignment, shared contract coordination, integration, and the final working note.

Existing retention, storage-layout, envelope, worker-control, AEP, provenance, portability and Web owners now admit the concrete route within the engineer-delegated boundary. The shared handoff is retained under temp/changes/202609220200000001-runtime_child_retention/implementation-contract.md. Metadata is recorded first; expected restricted bodies stream to evidence-owned staging, then a separate publication observation records verified complete content. The next deciding observation is exact Core-backed crash/replay readback and live child content before parent finalization. Missing bytes, unsafe projection or duplicate ownership would require local correction before acceptance. Existing callback or renderer presence is not proof of durable live publication, complete child capture, or crash recovery.

Paused by the engineer on 2026-09-23. While paused, the [Engineering Governance Landing](../202609231611190001-engineering_governance_landing/plan.md) plan holds write ownership of every path, including files this plan already modified, and will change governance, role definitions, test strategy L2, and several specifications this plan touched. Before resuming, re-read that plan's accepted decisions and current diff, reconcile shared paths, and address the three structural items in [findings](findings.md).

## Verification Direction

Use the existing test layers and focused contract-derived examples: multiple/nested children, spawn-operation completion distinct from child completion, full capture off/on, exact admitted body preservation, interleaving and duplicates, partial frames, unavailable collectors, crash after durable receipt, restart replay, version mismatch, retention/expiry and portable boundaries, Thread audience, and real human-gate behavior. Do not invent a new Gherkin runner, score threshold, or tracing platform. Pinned fake-runtime and provider fixtures prove their named boundaries; they do not replace opt-in real-runtime acceptance. Independent review inspects the actual final artifacts and named output. Raw attempts and dissent remain under temp/changes/202609220200000001-runtime_child_retention.

## Owner Links

- [Storage Core](../../core/storage.md)
- [Work model](../../core/work-model.md)
- [Work Data Retention](../../specs/20260921-work_data_retention_format.md)
- [Runtime provenance](../../specs/20260711-worker_runtime_subagent_provenance.md)
- [Storage layout](../../specs/20260703-storage_layout_record_ownership.md)
- [Workspace portability](../../specs/20260704-workspace_backup_export_import.md)
- [Change execution](../../change-execution.md)

## Interim Independent Findings

The independent Claude Code Auditor found no out-of-scope governing change. Its narrow documentation findings were duplicate numeric authorities (now seated only in Worker Control for chunk size and Web Projection for presentation limits), missing source trace for the engineer-proposed 10–20% heuristic (now in Intent Epoch 1), and omitted deferred topology selection for out-of-slice collectors (restored). The independent GPT-6 astra reviewer reproduced stale cached activity claiming ongoing collection after a dashboard refresh failure; the UI owner is correcting that behavior. None of these interim observations accepts unfinished implementation.

The first cross-domain test exercised the real Codex collector and WorkerTranscriptWriter into Core worker-control persistence, injected a receipt failure after publication, reopened the databases, and read exact child content into the timeline before parent final status. Its first run exposed duplicate child-start labels; the projection now recognizes one initial child appearance per origin while retaining all source facts. A later independent review reproduced credential reconstruction across delta bodies and JSON escapes, identical metadata replay conflicts, and resumed-child watermark state loss. These are corrections within existing ownership, not accepted residual defects. PI agents then hit their GPT-6 astra quota; all stopped. Primary and available registered GPT-6 astra collaborators took explicit ownership of the remaining fixes. Validation remains in progress.
