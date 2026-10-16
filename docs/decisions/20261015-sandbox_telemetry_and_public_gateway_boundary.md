---
status: Accepted
date: "2026-10-15"
decider: Engineer
---
# Sandbox Telemetry And Public Gateway Boundary

## Decision

#221 retains the boundary: no operational telemetry export from inside a Worker Sandbox. Finish the Core/NanoHost observation chain through its existing owners. No in-Sandbox SDK, telemetry egress, Gateway OTLP relay, exporter credential, or Collector authority is admitted.

#209 keeps the Gateway's existing authorized reachability. The public App explicitly rejects exact `/v1` and its descendants instead of forwarding them or serving the Web application. This adds no public Gateway endpoint.

## Reason

Source: engineer-rulings-20261015.md, Resulting rulings and Confirmation and expanded delegation, in the coordinator's backlog-20261015 record. The engineer accepted the first recommended options for #221 and #209/reachability on 2026-10-15. The coordinator commissioned this disposition and owner alignment. The record preserves source evidence and does not replace these owners.

The selected #221 option names no acceptance need that requires another Sandbox exit. An expired after-RC4 date is not the deferral reason. The #209 option removes misleading HTTP 200 HTML for API requests without widening Gateway exposure.

## Rejected Alternatives

- A Worker OTLP relay needs a separate egress, untrusted-input, content-control, and authorization contract; the engineer did not select it.
- Public App proxying of Gateway `/v1` would add a reachability and authentication boundary that this ruling excludes.

## Revisit When

Revisit #221 for a concrete diagnostic requirement that the Core/NanoHost chain cannot satisfy, with separately accepted egress and untrusted-content controls. Revisit #209 only when the engineer accepts a new public Gateway boundary. Neither absence of telemetry nor a route refusal authorizes a bypass.

## Affected Owners

- [Operational Telemetry Standardization](../specs/20260731-operational_telemetry_standardization.md)
- [LLM Gateway Responses API](../specs/20260526-llm_gateway_responses_api.md)
