---
status: Accepted
date: "2026-10-03"
decider: Coordinator, under the engineer's standing delegation to decide in the engineer's absence, on an independent Researcher's analysis
---
# Worker Start Returns On Admission

## Decision

The Coordinator decided that task.start, Core turn.start, and the Assistant's automatic Task handoff return HTTP 202 once the exact durable Turn admission exists, with running state and no completion for a live Turn. The ordinary receipt points to that Turn before response, and exact live replay projects current state. [Task Mode Worker Delegation](../specs/20260704-task_mode_worker_delegation.md#command-response-and-replay-authority), [Chat Mode Assistant](../specs/20260704-chat_mode_assistant.md), and [Core Protocol](../core/protocol.md) own their entry and replay boundaries. Completion, terminal closeout, cleanup, recovery, and fail-closed rules remain with existing owners and proceed independently of response delivery. Existing reads and exact replay expose completion; no endpoint, lifecycle, durable state, or longer timeout is added.

## Reason

A caller lost its connection while admitted work continued because the configured worker-start path awaited terminal state and cleanup before responding. The Researcher found that ordinary HTTP and MCP clients can time out while awaiting that result, and that no accepted owner requires terminal-before-response. Undici's 300-second header timeout was the strongest explanation of the observed failure, not definitive attribution because the nested cause was unavailable. A prompt admission result makes an operation usable as an ordinary agent tool while preserving independent execution and truthful current-owner replay.

Source decision: temp/comm-redesign/engineer-queue.md, entry "Worker-starting commands return on durable admission", dated 2026-10-03. Source analysis: temp/interface-unification/reports/task-start-sync/research-report.md. Landing commits: ed41e6f9 for task.start and Assistant handoff on 2026-10-03; 3a628d62 for Core turn.start on 2026-10-04. These are provenance references, not behavioral authority.

## Rejected Alternatives

- A longer timeout: it does not correct the response boundary for ordinary agent clients; the chosen route returns on existing durable admission instead.
- A new polling endpoint or response snapshot: existing Turn, Thread, attention, and exact replay projections already expose completion and current state.

## Revisit When

None recorded.

## Affected Owners

- [Task Mode Worker Delegation](../specs/20260704-task_mode_worker_delegation.md)
- [Chat Mode Assistant](../specs/20260704-chat_mode_assistant.md)
- [Core Protocol](../core/protocol.md)
