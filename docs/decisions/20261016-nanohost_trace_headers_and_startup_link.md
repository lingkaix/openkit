---
status: Accepted
date: "2026-10-16"
decider: Coordinator
---
# NanoHost Trace Headers And Startup Link

## Decision

Carry optional W3C `traceparent` and `tracestate` in native NanoHost transport headers. A Turn-caused effect span may link once to completed Epoch startup. Add no body field or durable trace state. Record this interpretation when closing #220.

## Reason

The coordinator accepted this interpretation on2026-10-16 after independent Codex Astra scrutiny. The required Pi advisor could not start because authentication refresh failed; the coordinator explicitly authorized Codex Astra instead. Issue #220 proposed body-field carriage and one trace reaching Epoch and member spans. The issue is a proposal, not owner authority. Transport headers preserve exact effect identity and work for JSON and file bodies. Startup normally precedes a Turn, so a link describes that relation without inventing parentage.

## Rejected Alternatives

- A body field adds another encoding and changes exact effect grammar without a present need.
- Parenting earlier startup to a later Turn invents causality.
- A process-lifetime root, durable trace record or reconstructed trace adds lifecycle machinery outside the diagnostic need.

## Revisit When

Revisit if an accepted diagnostic requirement cannot be served by optional headers, bounded spans and the startup link. Missing or lost telemetry alone does not justify a new authority or recovery path.

## Affected Owners

- [Operational Telemetry Standardization](../specs/20260731-operational_telemetry_standardization.md)
- [NanoHost Runtime And Transport](../specs/20260802-nanohost_runtime_and_transport.md)
