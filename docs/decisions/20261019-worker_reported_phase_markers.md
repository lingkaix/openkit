---
status: Accepted
date: "2026-10-19"
decider: Engineer
---
# Worker-Reported Phase Markers

## Decision

The worker shim, OpenKit's own code inside the Sandbox, may report a release-defined allowlist of lifecycle phase markers through the existing authenticated worker-control channel. A marker contains an enum phase name, a timestamp, and at most one optional fixed-enum outcome or stable error code. Nothing else is admitted.

NanoCore validates the allowlist, per-Turn count and byte limits, and existing parent binding. It clamps timestamps into the Core-observed parent window and drops duplicates. The execution owner records accepted markers as bounded, unverified events on the owning journal step. The telemetry owner projects those events with explicit worker-reported and unverified labels. They never change step status, outcome, retry, recovery, or fences. Missing or forged markers affect diagnostics only.

The shim uses a bounded queue with lower priority than control messages. It drops markers on overflow and never delays control traffic. No Sandbox OpenTelemetry SDK provider/exporter, OTLP endpoint/receiver, Collector, exporter credential, native agent-runtime telemetry relay, new egress, free-form string, or content is admitted.

This decision supersedes only #221's exclusion of these narrow shim reports in [Sandbox Telemetry And Public Gateway Boundary](20261015-sandbox_telemetry_and_public_gateway_boundary.md). Its other telemetry restrictions, revisit condition, and entire public Gateway decision remain binding. The documentation model has no partial-supersession status or metadata form, so the earlier record remains unchanged. This record states the limited amendment; the telemetry specification carries its operative projection contract.

## Reason

Source: the engineer's 2026-10-19 direction to the coordinator, translated from Chinese. Observed failures sit at the Core/NanoHost/shim seams: dispatch versus accepted start, session open, collection, and release. Core-side observation alone cannot localize them. The shim is OpenKit code, the channel already exists and is authenticated, and the reports remain unverified and content-free.

## Rejected Alternatives

- Core-only observation cannot locate the reported seam failures with enough precision.
- A Sandbox SDK, OTLP relay, or native runtime telemetry relay would admit a broader signal and authority boundary than this need requires.
- Free-form reports could carry content or secrets; closed enums and stable allowlisted codes bound the payload instead.
- Treating markers as proof would let forged or missing diagnostics change execution and recovery.

## Revisit When

Revisit if measured diagnostic needs exceed the closed marker shape or its bounded control-channel budget. Any broader Sandbox telemetry still requires #221's concrete unmet need and separately accepted egress and untrusted-content controls. Missing markers never authorize a bypass.

## Affected Owners

- [Operational Telemetry Standardization](../specs/20260731-operational_telemetry_standardization.md)
- The durable-execution owner mirrors bounded, unverified journal recording; it retains ownership of step lifecycle and recovery.
