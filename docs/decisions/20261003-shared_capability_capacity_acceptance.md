---
status: Accepted
date: "2026-10-03"
decider: Engineer
---
# Shared Capability Capacity Acceptance

## Decision

The engineer accepted the four-stream capability default with its known shared-capacity limit: AgentSessions in the one Sandbox per NanoHost share those streams, so concurrent Thread starts may still encounter client-retried HTTP 429 refusals. A bounded-wait or per-session budget mechanism remains a later item. [NanoHost Runtime And Transport](../specs/20260802-nanohost_runtime_and_transport.md#derived-values-versus-calibratable-targets) owns the existing ceiling and refusal; acceptance does not promise discovery under arbitrary co-resident load.

## Reason

The queue records the engineer's verbatim evening answers as "1. okay 2. yes 3. okay". The first answer accepts the shared four-stream default and its stated limitation. No separate reason is recorded, and the quoted wording is not translated. The second and third answers concern qualification timing and the outer-session finding; their owner amendments have not landed and belong to their pending changes. This record backfills only the landed shared-capacity acceptance, without turning those pending dispositions into a qualification waiver.

Source decision: temp/comm-redesign/engineer-queue.md, entry "Engineer rulings 2026-10-03 evening on the capability-ceiling follow-ups". Source analysis of capacity limits: temp/interface-unification/reports/capability-ceiling/consult-report.md and temp/interface-unification/reports/capability-ceiling/review-report.md. The accepted default landed in 0067c0d43d77aedb6caea78a217b43375262e21c. These are provenance references, not behavioral authority.

## Rejected Alternatives

None recorded.

## Revisit When

None recorded.

## Affected Owners

- [NanoHost Runtime And Transport](../specs/20260802-nanohost_runtime_and_transport.md)
