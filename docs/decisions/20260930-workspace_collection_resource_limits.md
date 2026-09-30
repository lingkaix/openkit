---
status: Accepted
date: "2026-09-30"
decider: Engineer
---
# Workspace Collection Uses Fixed Resource Limits

## Decision

A `workspace.collect` scan and its result delivery run under fixed limits that are not command options:

| Concern | Limit |
| --- | --- |
| Scan duration | 120 seconds absolute, from attachment resolution through completed candidate staging |
| Result delivery | 120 seconds absolute, covering stream admission, capacity waits, body delivery, and the complete acknowledgement |
| Entries | 100,000 per scan, counting every name read from an opened directory except `.` and `..` |
| Depth | 64 descendant-directory levels below the work-slot root |
| Root-relative path | 4096 UTF-8 bytes inclusive |
| Symbolic-link target | 4096 bytes inclusive |
| Encoded metadata | 32 MiB each for one scan's path and permission metadata, one retained manifest read, and one tree listing |
| Ignore input | 1 MiB per contained ignore file and 8 MiB per scan |
| Source content | 256 MiB of regular-file content bytes per scan, hence at most 512 MiB across the two scans |
| Physical private store | 2 GiB per scoped store, with at least 64 MiB and 1024 inodes kept free on the containing filesystem |
| HEAD and ref context | 4096 bytes per HEAD or loose ref, 1 MiB packed refs, at most eight symbolic-ref hops |
| Command JSON nesting | 128 nested containers over the whole command, including unknown additive members |

Exceeding a scan resource limit fails the collection under [NanoHost Workspace Data Boundary](../specs/20260801-nanohost_workspace_data_boundary.md); it never yields an empty capture or permission to omit a path or check value. HEAD and ref context excess instead yields unavailable context without an invented commit, and excess command JSON nesting is rejected before effects. Result-delivery expiry leaves the result unknown under [NanoHost Runtime And Transport](../specs/20260802-nanohost_runtime_and_transport.md). Those specifications own the limits and their failure, preservation, cleanup, and retry rules.

## Reason

The independent H1 review (round 2, finding R7) found worker-controlled unbounded paths in time, memory, disk, traversal, and subprocess duration. Existing transport and message bounds did not bound a scan. The reviewer proposed values, and the primary selected them with a 32 MiB encoded-metadata bound instead of 8 MiB to provide more room for listings near the selected entry ceiling. Metadata size depends on encoded path lengths: short-name trees can reach 100,000 entries below 8 MiB, while longer listings can reach a metadata limit first. The 2 GiB private-store limit bounds the combined retained objects, attempts, candidate staging, and temporary packing; it does not guarantee that every combination of inputs admitted by the other limits fits. Growth that cannot satisfy that envelope is refused without evicting Core-required pairs or retained worker bytes. The candidate body retains its separate 256 MiB ceiling.

The engineer approved these values on 2026-09-30 in the agent communication redesign session, stating, translated from Chinese, “Continue with the limits you proposed,” after being told the product consequence recorded below.

Accepted consequence: a collection whose required scan work or storage exceeds a fixed bound cannot publish its changes for review while that limiting condition persists. Resolving the excess or accepting different limits is necessary; truncation is not a remedy. A later attempt requires a new authorized request. Context-only excess retains the unavailable-context outcome above. None of the selected values establishes measured capacity; host qualification must establish which ordinary useful workspaces fit within the combined limits.

## Rejected Alternatives

- The reviewer's 8 MiB encoded-metadata bound, because it provides less room for longer path encodings near the selected entry ceiling; it does not make every 100,000-entry tree impossible.
- Larger limits for large monorepositories (for example 1 GiB of content or 500,000 entries), because they would raise the per-slot disk reservation and scan time with no present workspace that needs them.
- Caller-selected limits carried in the command, because a worker-influenced or misconfigured value would reopen the unbounded paths.

## Revisit When

Host qualification shows that ordinary workspaces approach a limit, a supported workload's workspace exceeds one, or measured scan time or disk use on the supported host disagrees with these values.

## Affected Owners

- docs/specs/20260801-nanohost_workspace_data_boundary.md
- docs/specs/20260802-nanohost_runtime_and_transport.md
- docs/specs/20260703-workspace_synchronization.md
