---
status: Accepted
date: "2026-10-15"
decider: Coordinator and Consultant, under the engineer's delegated acceptance
---
# Assistant History Tool Binding

## Decision

Keep `thread.history.read`. Extend it to bounded, authorized Item search across eligible past Threads in the current Workspace through the conversation-history adapter. [Chat Mode](../specs/20260704-chat_mode_assistant.md#assistant-history-tool) owns the effect binding; [Retrieval Kernel](../specs/20261014-retrieval_kernel.md#source-adapter-registry) owns the search mechanism.

1. Eligible means Threads that the addressing User can read now under current Thread visibility. The User's own private Assistant Timeline is eligible only for that User. Another User's private Timeline is never eligible.
2. Source and output-audience checks run at query time and again when the result is shown.
3. Results are bounded in count and bytes and carry qualified references.
4. A query inside a Turn publishes one write-once, content-free trace on that Turn under the accepted Retrieval Kernel trace rule. No new durable record means no record beyond that trace.
5. There is no administrator or cross-Workspace reach.

Retain the adapter's exclusions for hidden reasoning, credentials, raw Provider payloads, and unadmitted diagnostics.

## Reason

The engineer provisionally approved this binding and its five conditions on 2026-10-15, subject to Consultant confirmation before merge. The coordinator then reported Consultant agreement and accepted the binding under the engineer's delegated acceptance. Source: backlog-20261015/consultant-wave1.md, section "Assistant history Tool binding", which states "AGREED. No real blockers." The coordinator's acceptance was supplied directly in the P11 conversation. That working record is evidence, not design authority.

The existing Tool and conversation-history adapter serve the accepted past-conversation retrieval need. Binding them removes the open dependency without adding another Tool, search authority, or history store.

## Rejected Alternatives

- A new history Tool or operation identity duplicates the existing Core Tool.
- Administrator override, another User's private Timeline, and cross-Workspace search exceed this accepted binding.
- Omitting the query trace contradicts the accepted Retrieval Kernel trace rule.

## Revisit When

Revisit when an accepted product need requires a broader source scope or a different history Tool effect. Such a change requires its owning authorization first.

## Affected Owners

- [Chat Mode And Core Assistant](../specs/20260704-chat_mode_assistant.md)
- [Retrieval Kernel](../specs/20261014-retrieval_kernel.md)
