---
status: Accepted
date: "2026-09-30"
decider: Engineer
---
# Workspace Collection Is A Snapshot Chain Taken From Outside The Sandbox

## Decision

Workspace changes are collected as a chain of snapshots, taken by NanoHost from outside the Sandbox, while the worker's runtime keeps running. Each collection records its base, which is the previous head, and a new head. Successive change sets therefore telescope, so no captured change is counted twice or skipped, and NanoCore rejects a change set whose base is not the previous head. NanoHost scans the work volume read-only into a private host-side Git store, and nothing is written into the worker's own repository. The guarantee holds for captured states: a state that exists only between two scans is not observed. A scan that stays unstable while writers run is recorded and flagged, not silently accepted as stable. Collection runs at Turn end, at AgentSession release, and before a successor starts on the same volume. Review stays Core's: a review candidate is computed from Core's accepted base, not from one link of the chain. This amends the rule that NanoHost never runs Git, only for its private store.

## Reason

The engineer accepted the primary's recommendation on Round 14, question 2, translated from Chinese: "I think Q2 and Q3 are fine now; I agree with your suggestion."

Agent analysis, approved: once an AgentSession stays resident across Turns, the old collection path fails. It captured inside the Sandbox after the native runtime exited and gated export on the absence of the process group, and a resident runtime never exits between Turns. Capturing from outside keeps collection from affecting the running worker, keeps worker-controlled Git configuration, hooks, and filters out of the capture, and keeps the capture's objects out of the worker's repository. Freezing the Sandbox was rejected because it pauses legitimate background processes.

Source: the 2026-09-30 working session recorded in the agent communication redesign change record.

## Rejected Alternatives

- **Capture inside the Sandbox after the native process exits.** Rejected because a resident runtime does not exit between Turns.
- **Freezing or pausing the Sandbox during capture.** Rejected because it stops legitimate background work.
- **Per-link review candidates.** Rejected because review must compare against what Core accepted, and a rejected candidate must not advance that base.

## Revisit When

A mid-Turn checkpoint gains a consumer, a filesystem offers a cheap atomic snapshot that removes the unstable case, or collection must span more than one work volume.

## Affected Owners

- docs/specs/20260703-workspace_synchronization.md
- docs/specs/20260801-nanohost_workspace_data_boundary.md
- docs/specs/20260531-worker_turn_reliability_envelope.md
