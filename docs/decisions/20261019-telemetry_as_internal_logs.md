---
status: Accepted
date: "2026-10-19"
decider: Engineer
---
# Telemetry As Internal Logs

## Decision

OpenKit uses OpenTelemetry as the one format and toolchain for its internal diagnostics, built into the product. The telemetry specification owns the local OTLP file sink, lifecycle stage spans, one stage-duration histogram, and a read-only Turn timeline view. OpenKit does not design its own timeline/log format or libraries. Telemetry remains lossy, content-free, and never authoritative. Durable work data stays with the work data retention owner.

This decision replaces only the telemetry specification's non-goals on Data Root capture and product-visible diagnostic views. It does not supersede [Sandbox Telemetry And Public Gateway Boundary](20261015-sandbox_telemetry_and_public_gateway_boundary.md). The separate [worker phase-marker amendment](20261019-worker_reported_phase_markers.md) admits only bounded, unverified shim markers on existing worker control, not a Sandbox SDK, OTLP/native-runtime telemetry relay, or new egress. The existing [NanoHost trace-header and startup-link decision](20261016-nanohost_trace_headers_and_startup_link.md) remains unchanged.

## Reason

Source: the engineer's 2026-10-19 direction to the coordinator, translated from Chinese. The operator-only Collector topology left a single-server deployment without usable diagnostics. Per-stage timing and failed-check attribution are needed to locate execution failures without creating another source of product truth.

The coordinator confirmed local capture on by default without an OTLP endpoint, with `OTEL_SDK_DISABLED=true` disabling capture and export. Bounded size and age defaults with operator overrides keep the local files disposable. Existing Core/NanoHost observations provide lifecycle authority; the separately admitted shim markers add only unverified detail.

The coordinator's subsequent addendum makes the execution owner's durable step journal the source for timeline stages, open steps, and stage statistics. The journal uses the OpenTelemetry span data model, while local files add diagnostic detail by trace id. Persisted journal trace/span ids remain correlation values, not independent authority. This distinction prevents sink loss from removing a recorded lifecycle stage.

## Rejected Alternatives

- An OpenKit-specific event or timeline schema would duplicate a standard format and require separate logging libraries.
- Telemetry as durable evidence would make lossy delivery and retention part of product correctness and recovery.
- Bundling an observability backend would add a second supported storage and analysis system to a bounded diagnostic need.

## Revisit When

Revisit the local capture or view boundary if measured diagnostic needs cannot be met by bounded stock OTLP files and the narrow read projection. Any proposal beyond the separately admitted shim markers must satisfy #221's concrete-need, egress, and untrusted-content conditions. Missing telemetry alone does not authorize that change.

## Affected Owners

- [Operational Telemetry Standardization](../specs/20260731-operational_telemetry_standardization.md)
