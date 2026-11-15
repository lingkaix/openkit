---
status: Accepted
date: "2026-11-15"
decider: Engineer, finalized by the Coordinator on an independent pilot review
---
# Structural Fitness Check

## Decision

The repository keeps one structural check, `scripts/check-structure.mjs`, run by `check:repo`. Two detectors block:
- D1, one implementation of a registered shared decision: canonical JSON, digest framing, and the Workspace access denial;
- D2, a value-import edge inside a value-import cycle.

Cognitive complexity (D4), LCOM4 cohesion (D5), list-then-search (D6) and pass-through units (D7) are on-demand Signals with no baseline. They never gate. [The toolchain guide](../toolchain.md#structural-fitness-check) owns the registry, the shrink-only baseline and the change rules.

The finalization baseline admits the value-import cycle edges present at finalization exactly once. They are recorded as debt for a follow-up issue, not as a permanent allowance. D1 items carry over only from the pilot baseline. Copies added after the pilot stopped were routed through their owners. The exception is eight Workspace denial sites in three files that were under a concurrent rewrite at finalization. They are seeded for that rewrite to remove:
- `mode-entry-routes.ts`;
- `operation-json-routes.ts`;
- `runtime/worker-governance-turn-executor.ts`.

## Reason

On 2026-10-26 the engineer ruled out file-line limits and arbitrary function-length limits, and kept essential metrics as signals unless pilot evidence showed otherwise. Only precise detectors may block. The engineer also admitted a shared-decision registry only by criterion: at least two owners, divergence is a defect, and the decision is specifiable. Tightening is easy; loosening needs review.

The checker ran as an out-of-repository pilot from 2026-10-26 to 2026-11-05. During the pilot:
- canonical JSON and digest copies were consolidated into the Protocol owners;
- the largest value-import cycle shrank from 103 to 71 files;
- blocking reports were true positives fixed with existing owners.

Logged complexity and cohesion deltas were always kept as-is and never changed code. The pilot then stopped running for ten days, partly because the TypeScript 7 upgrade broke its loader. In that gap, both target classes returned: a private `JSON.stringify` digest and new local Workspace denial constructions. A check that lives outside the repository decays silently, so it moved into `check:repo`.

## Rejected Alternatives

- File and function length limits: rejected by the engineer as proxies that invite mechanical splitting.
- Blocking on complexity or cohesion scores: no pilot evidence of precision. LCOM4 did not reproduce the hand-made decomposition maps, and the scores would become targets.
- Layer-direction checking (D3): no layer map was ever written.
- Near-duplicate body hashing (D8), the type-import cycle graph, and the record-guard and worker-target detectors: these never triggered or never led to an action, and D8 keys were unstable. Worker target stays a review-only registry entry.
- Blocking every authorization denial code: other denial codes have no single owner, so a literal check could not tell divergence from a domain's own closed refusal table.
- Per-landing Signal baselines and dispositions: they grew without bound and cost lanes logging time without changing code.

## Revisit When

- Revisit at each release milestone, using the false-positive record and the exemptions.
- Move a Signal to blocking only with evidence of its precision.
- Add a registry entry when a specification defines a shared contract or a postmortem shows a divergence defect.

## Affected Owners

- [Toolchain](../toolchain.md#structural-fitness-check)
- [Engineering Doctrine](../engineering-doctrine.md#complexity)
