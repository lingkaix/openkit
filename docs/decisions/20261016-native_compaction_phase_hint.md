---
status: Accepted
date: "2026-10-16"
decider: Coordinator
---
# Native Compaction Phase Hint

## Decision

The coordinator approved carrying the already validated native Codex request kind as ephemeral `requestKind` in the existing adapter-to-Gateway hint. Map only confirmed pre-output compaction failure to the existing HTTP503 `context_compaction_unavailable` envelope. Other categories remain unchanged. Add no durable field or compactor.

## Reason

The coordinator explicitly approved this cross-module seam for #123 on2026-10-16. The adapter already checks the pinned native phase but discards it, so the Gateway cannot distinguish compaction failure from ordinary inference failure. The existing hint is the smallest available carriage path.

## Rejected Alternatives

- Classifying ordinary Provider failures as compaction failure has no reliable phase evidence.
- Prompt text or a subagent label does not establish the exact native request phase.
- A new compactor or durable phase record exceeds this classification repair.

## Revisit When

Revisit if a pinned runtime stops supplying trustworthy request-phase evidence or an accepted owner requires another compaction path. Missing evidence retains the ordinary category.

## Affected Owners

- [Agent Runtime Context Management And Compaction](../specs/20260902-agent_runtime_context_compaction.md)
- [Worker Runtime Subagent Provenance](../specs/20260711-worker_runtime_subagent_provenance.md)
