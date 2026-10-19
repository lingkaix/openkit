---
status: Accepted
date: "2026-10-19"
decider: Engineer
---
# Sandbox Resource And Preflight Diagnostics

## Decision

Host-observable resource facts come from NanoHost, not the Sandbox shim. NanoHost reads the exact Sandbox container's cgroup/backend state through its private V1 Docker and returns a bounded summary through existing terminal, inspect, and teardown responses. The summary covers memory peak bytes, OOM-kill count, the backend OOM-killed flag, CPU usage seconds, CPU throttled seconds, pids peak, and exit state. Absent fields mean unknown. Core's lost-Worker path uses the existing inspect call, without a new route or polling loop.

Core records those facts as host-observed, trusted attributes on the owning journal step and span. Trust identifies the existing host/backend observation boundary, not outcome authority. Resource diagnostics never decide an outcome, retry, recovery, or fence. No periodic time series or new metric is admitted; operators may use separate host monitoring.

Inside-only observations use the bounded unverified marker channel: one-time preflight version match/mismatch against the admitted harness, Gateway reachability as a closed outcome enum, writable work-area free bytes, native-process exit code 0–255 or signal enum, and stable shim error codes. Only fixed fields and bounded numbers/enums are admitted. No raw version, environment string, exception, or content is admitted. Existing count/byte limits, timestamp clamping, duplicate drops, lower-priority queues, and diagnostic-only semantics remain binding.

Native runtime stderr and logs are content, not telemetry. Their verbatim restricted-raw retention, per-Turn bound, and explicit truncation record belong to the work-data retention owner. No Sandbox OTLP receiver/Collector, arbitrary inside metrics/logs, native runtime telemetry relay, periodic inside sampling, or new egress is admitted.

This decision extends only the marker payload restriction in [Worker-Reported Phase Markers](20261019-worker_reported_phase_markers.md). The earlier marker decision and #221 remain historical records with all other restrictions intact. There is no partial-supersession metadata/status form, so neither earlier record is rewritten. Current owners state the host/inside observation distinction and the extended closed marker shape.

## Reason

Source: the engineer's 2026-10-19 direction to the coordinator, translated from Chinese. The requested performance, error, and environment diagnosis must use the component that can observe each fact truthfully. Host resource observations cannot be forged by the agent under the existing host trust boundary and remain available when the inside reporter is dead or hung, including OOM or freeze. Host/backend unavailability still means unknown. The shim can report inside-only preflight and native-process observations, but these remain unverified reports.

## Rejected Alternatives

- Periodic inside sampling, arbitrary inside metrics/logs, or a Sandbox Collector adds overhead, forgeable reports, and content risk; bounded host snapshots and closed markers meet this diagnostic need instead.
- Treating an OOM flag or shim exit report as an outcome would bypass the execution owner's status, uncertainty, recovery, and fencing rules.
- Treating stderr as telemetry would disclose content outside the work-data retention and restricted-raw boundaries.

## Revisit When

Revisit if bounded host summaries and one-time closed markers cannot localize an observed failure, or their cost interferes with control traffic. Broader inside telemetry still requires a separate accepted need and trust/content controls; periodic sampling, an OTLP receiver, and a Collector remain unadmitted.

## Affected Owners

- [Operational Telemetry Standardization](../specs/20260731-operational_telemetry_standardization.md)
- [NanoHost Runtime And Transport](../specs/20260802-nanohost_runtime_and_transport.md)
- [Work Data Retention Format](../specs/20260921-work_data_retention_format.md)
- The execution owner retains bounded journal recording and lifecycle authority.
