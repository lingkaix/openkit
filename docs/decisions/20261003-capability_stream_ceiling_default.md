---
status: Accepted
date: "2026-10-03"
decider: Coordinator, under the engineer's standing delegation to decide in the engineer's absence, on an independent Consultant's analysis
---
# Capability Stream Ceiling Default

## Decision

The Coordinator decided to raise the capability-family stream ceiling from two to four on both sessions as a current calibratable default, ahead of release qualification. [NanoHost Runtime And Transport](../specs/20260802-nanohost_runtime_and_transport.md#numeric-envelope) owns the envelope. The unchanged 256 KiB stream window derives a 1 MiB capability DATA ceiling, nested maximum 16, and outer maximum 18 inside the unchanged 5 MiB connection window. The 512 KiB request-body limit remains separate. Immediate HTTP 429 at the ceiling and whole-exchange permit lifetime remain. No queue, waiting mechanism, retry, provider branch, or flag is added. The producer applies no further calibration.

## Reason

The platform supplies at least three MCP servers in the demonstrated startup workload, while the old ceiling admits only two overlapping requests. Standard clients may initialize distinct servers concurrently and need not retry a transport refusal. The Consultant treated the old value as an undersized calibratable default rather than a mechanism failure. Four gives modest headroom with the same mechanism and coherent reservation arithmetic. The Coordinator chose amendment before qualification, rather than the Consultant's measurement-before-adoption sequence; neither arithmetic nor the chosen default proves arbitrary co-resident startup success or composed memory safety.

Source decision: temp/comm-redesign/engineer-queue.md, entry "Capability-family stream ceiling", dated 2026-10-03. Source analysis: temp/interface-unification/reports/capability-ceiling/consult-report.md. Source review of sequencing: temp/interface-unification/reports/capability-ceiling/review-report.md. Landing commit: 0067c0d43d77aedb6caea78a217b43375262e21c. These are provenance references, not behavioral authority.

## Rejected Alternatives

- Keep two and depend on client retries: ordinary concurrent discovery would retain the demonstrated interoperability failure.
- Add bounded startup waiting: it adds queue admission, cancellation, deadlines, authority revalidation, and accounting for a defect addressed by recalibration.
- Change only the capability divisor: actual advertised stream windows would invalidate the aggregate bound.
- Release permits before response completion: still-live responses and upstream work would escape the reservation.
- Use three streams: it covers exactly three overlapping requests, while four buys modest headroom without another mechanism.

## Revisit When

A larger selected supply or additional co-resident startup workload needs the same discovery claim, or qualification finds a measured miss. The default remains subject to the owner's calibration and admissibility rules.

## Affected Owners

- [NanoHost Runtime And Transport](../specs/20260802-nanohost_runtime_and_transport.md)
- [Worker MCP Tool Supply](../specs/20260704-worker_mcp_tool_supply.md)
- [NanoHost Workspace Data Boundary](../specs/20260801-nanohost_workspace_data_boundary.md)
