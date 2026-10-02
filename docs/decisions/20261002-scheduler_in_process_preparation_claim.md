---
status: Accepted
date: "2026-10-02"
decider: Engineer
---
# Synchronous And Background Dispatch Share One In-Process Preparation Claim

## Decision

Within the one NanoCore process that owns a data root, a queued scheduler admission is prepared by at most one dispatcher at a time. Selection claims the admission in process before preparation, and the claim ends when that attempt leases, defers, is cancelled, or fails. Background dispatch skips an admission that another dispatcher is preparing. A synchronous caller whose own admission is already being prepared by background dispatch does not prepare it again; it waits for that attempt and takes its outcome as its own, so a leased admission returns the started Turn and a failure becomes the caller's own dispatch failure under [the synchronous-caller rule](20261002-synchronous_caller_own_failure_cancels_admission.md). The claim is never persisted or recovered; the durable lease remains the only guard against a second launch across restarts. The durable scheduler specification owns the rule.

## Reason

After the synchronous-caller rule landed, the coordinator reported that synchronous and background dispatch can select and prepare the same queued admission concurrently, because selection reserves nothing before lease acquisition. When background dispatch leases first and the caller's own preparation then fails, the caller reports a failure for a Turn that is running, which is the outcome the synchronous-caller rule exists to prevent. The coordinator offered four options: a durable claim on the admission row, an in-process claim, a post-failure lookup that returns the leased Turn, or accepting the gap. On 2026-10-02 the engineer chose the in-process claim: 「1. b」, translated as “1: option B.”

The engineer gave the choice without a separate reason. The coordinator's reasons for recommending it were that one NanoCore process owns a data root under the existing process lock, that preparation previews continuity without Store or backend effects, and that the conditional durable lease already rejects a second launch; an in-process claim therefore closes both the contradictory caller outcome and the duplicate preparation without new durable state or a stale-claim recovery lifecycle. This does not reopen the rejected "Use Process-Local State Only" alternative, which concerns lease identity and reconnect fencing; those stay durable.

## Rejected Alternatives

- A durable claim on the admission row. It needs a schema change and a lifecycle for claims left behind by a crashed process, for a race that one process can settle in memory.
- A post-failure lookup that returns the leased Turn when the caller's cancellation finds the admission already leased. It corrects the response after the fact and leaves the duplicate preparation.
- Accepting the gap and keeping only the projection note.

## Revisit When

Coordinator-proposed revisit conditions, not an Engineer ruling: more than one process may dispatch against one Core database, or admission preparation gains Store or backend effects.

## Affected Owners

- docs/specs/20260703-durable_scheduler_design.md
