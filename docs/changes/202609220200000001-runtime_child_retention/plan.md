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

## Intent Revision 3 — 2026-09-24

The engineer resumed the unfinished work preserved in commit 2ff8887ca1f74c3c4be0cfe12d480ad9fd58cfc9 after the governance landing in 69a60f59f1004604b9fc74e83ff635acee903fc9, instructing this primary to execute the Governance Landing Handoff and evaluate the completed work under the new framework before discussing further improvements. Internal delegates use gpt-6-sol by this explicit task instruction. Independent Claude Code consultation may use opus 5.5. The handoff authorizes one separate local commit per active task after verification; it does not authorize push, deployment, external publication, or temporary-material deletion. Earlier Intent Epoch headings remain immutable historical entries.

## Working Checkpoint

Resumed from clean HEAD 69a60f59f1004604b9fc74e83ff635acee903fc9 on the existing codex/runtime-child-retention branch. The previous implementation is committed in 2ff8887c; old agent reports and working logs are historical evidence, not proof that the current tree passes. No previous delegate remains active. Root governance, the landing plan/proposal, the role index, the handoff, and RCR-FND-001 through RCR-FND-004 have been reread. Role contracts now come from docs/roles/ through prompt dispatch. The existing governance corpus and decision-record links are preserved.

Named representation seams: immutable Turn capture binding to dispatchable AEP to Worker runtime; native runtime facts/content through Worker Control into observation and EvidenceBundle publication; model-call admission through Gateway capture into the same append owner; observation/evidence reads into the authorized ThreadDashboard projection. A separate test author will derive or reconcile L2 composition checks against both sides of each affected seam. Portable full-body round-trip is the next handoff task, with its own plan and test author, not silently added here.

Predicted Next Action: finish the independently reproduced local projection and watermark corrections, repair production-shaped test fixtures without weakening their assertions, and complete unavailability anchoring. The engineer approved separating durably recorded collector faults from failures to persist required facts (Proposal B), now recorded in docs/decisions/20260924-recorded_collector_fault_preserves_work_outcome.md. Exact failed revision-attempt retention/readback (Proposal A) remains unapproved: the engineer instead requested a broader discussion of Goal setup and a distinct Planning phase. Their proposal and independent challenge are retained at temp/changes/202609220200000001-runtime_child_retention/resume/owner-amendment-proposal.md. Goal failure semantics remain unchanged while that discussion is open; B implementation and existing-owner corrections proceed independently. Expected observable: original behavior checks remain valid, exact negative cases decide the new corrections, and task 1 closes only after those decisions, focused checks and independent acceptance. Evidence that changes the route: an owner-compatible correction that removes a proposed amendment, an unexplained regression, or a reviewer counterexample. Tasks 2 and 3 remain next in the handoff order, not silently started during task 1.

Evaluation predictions registered before resumed edits: centralization should reduce independently maintained binding shapes from four to one and timeline numeric owners from three to one; capture-context construction should no longer impose independent database-opening and lineage-construction duties on each internal entry. These are named raw observations, not score targets. Behavior and Safety Kernel checks must continue to hold. Discoverability and framework causality remain unmeasured unless separately tested.

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
