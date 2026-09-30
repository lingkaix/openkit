---
status: Accepted
date: "2026-09-30"
decider: Engineer
---
# A New Work Slot's First Accepted Base Comes From A Baseline Scan

## Decision

The first initialization of a new, empty work slot completes during `session.open`, before the native runtime of that AgentSession starts. After `session.open` returns and before that AgentSession's first `turn.start`, NanoCore requests a `workspace.collect` in a baseline form that names no accepted base and no previous head. NanoHost scans the slot twice through its private store and returns the snapshot pair only when both scans are equal. NanoCore compares the pair's tree with the tree it derives for the materialized source, which for a Git source is the tree of the exact accepted commit in NanoCore's own repository, and records the pair as the slot's accepted base and capture cursor only when they are equal. The manifest's permission bits are accepted as scanned. A retained slot is never re-baselined; it continues from its chain head. Unequal scans, a tree mismatch, or a source whose expected tree NanoCore cannot derive fail closed: no accepted base is recorded and the AgentSession does not receive its first Turn.

## Reason

The engineer chose this rule on 2026-09-30 from three options presented after the independent H1 review (finding R8) and an independent consultation found that no existing effect or handoff produces the accepted snapshot pair that the first link of the snapshot chain requires, so every new slot's first collection would fail with `accepted_base_unknown` and no worker change would reach review. The chosen rule reuses the existing read-only scan and private store, verifies the scanned content against an independently known tree instead of trusting the worktree, and adds one command form and a change of ordering rather than a new data path.

Accepted residual risks, stated when the engineer ruled:

- Permission bits of the first base are trusted as observed, because NanoCore cannot predict the checkout's modes.
- A repository whose checkout transforms working bytes (for example line-ending conversion or a smudge filter) fails closed at initialization.
- A source commit that NanoCore's repository does not hold fails closed at initialization.

Source: engineer answer of 2026-09-30 in the agent communication redesign session.

## Rejected Alternatives

- Read the commit's objects from the slot's own `.git` at the first collection, verify them by hash, and use the commit tree as the base. It makes NanoHost parse an untrusted Git object store, lets a worker block its own first collection by deleting objects, and shows umask differences as permission changes in the first review.
- Ship the commit's tree objects from NanoCore to NanoHost before the first collection. It transfers the whole tree for every new slot and still needs the commit in NanoCore's repository.
- Trust a baseline scan without comparing it with an expected tree. The absence of this AgentSession's first Turn is not provenance; a co-resident writer or a faulty materializer would enter the base unreviewed.
- Adopt the first Turn-end scan as the base. It hides the first Turn's writes from review.

## Revisit When

Repositories with transforming checkouts must be supported, work slots must start from sources NanoCore's repository does not hold, or the first base's permission bits need an authority stronger than observation.

## Affected Owners

- docs/specs/20260704-session_static_workspace_materialization.md
- docs/specs/20260703-workspace_synchronization.md
- docs/specs/20260801-nanohost_workspace_data_boundary.md
- docs/specs/20260802-nanohost_runtime_and_transport.md
- docs/specs/20260703-worker_control_protocol.md
- docs/specs/20260616-agent_environment_package.md
- docs/specs/20260531-worker_turn_reliability_envelope.md
