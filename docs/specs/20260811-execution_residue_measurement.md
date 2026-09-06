---
status: Accepted
implementation: Not Started
date: 2026-08-11
updated: 2026-08-20
---
# Execution Residue Measurement

## Owns

This specification owns task-external measurement of the repository's execution framework from evidence left by completed work: its audit-side trigger, comparable observations, record form, and separation from the work being measured.

## Does Not Own

- Active execution, coordination, gates, role composition, or stop decisions; `docs/change-execution.md` owns them.
- The shape of change records or temporary pilot evidence; `docs/documentation-model.md` and `docs/change-execution.md` own those boundaries.
- Fault-injection calibration or its Goodhart guards; `docs/specs/20260719-verification_calibration.md` owns them.
- Any framework correction. Engineers decide changes after reading the evidence.

## Core References

- `docs/core/foundation.md`

## Summary

This program measures how engineering work actually proceeded after the work is complete. It does not require the active loop to produce a particular event vocabulary, does not return rates to executing agents, and never gates or redirects a running task.

Legacy committed state files and findings reports remain valid inputs under the historical framework that produced them. New pilot work may instead retain Git history, actual artifacts, append-only intent, rewritable checkpoints, raw transcripts, tool output, timing, and human decisions in uncommitted working space. An audit names exactly which evidence it used and does not normalize missing history into invented data.

## Goals

- Give engineers comparable observations about execution cost, recovery, and correctness.
- Preserve framework evidence without turning measurement into an execution controller.
- Distinguish direct counts and timings from evaluator judgment.
- Let repeated observations justify the smallest later governance change.

## Non-goals

- Do not require a state file, event schema, workflow engine, dashboard, scheduler, or live breaker.
- Do not define targets or thresholds before repeated completed-work observations exist.
- Do not score or advise an active primary agent, builder, test author, reviewer, or consultant.
- Do not infer omitted events from narrative summaries.

## Observation Panel

For each completed task, report only measures supported by its named evidence. Missing evidence is reported as unavailable, not zero.

1. Time to first direct contact with the relevant runtime, artifact, or external system.
2. Time to the first usable artifact and to final acceptance.
3. Human interruptions, classified as factual requests or decisions only the engineer owned.
4. Wrong-premise rework: time or attempts abandoned because evidence defeated the premise or proxy.
5. Recovery latency after compaction, pause, failed direction, or environment loss.
6. Coordination cost visible in role invocations, handoffs, repeated reports, or waiting where the retained record supports a count.
7. Escaped defects found after an artifact had been accepted.
8. Strict incidents involving authorization, confidentiality, credentials, data loss, destructive effects, publication, sandbox containment, or concurrent writes.
9. Final acceptance and unresolved residual risk.

Legacy records may support additional historical counts such as correction rounds, breaker trips, or assignment outcomes. Those counts are labeled legacy and never treated as requirements for new execution.

## Method

The engineer initiates a reading after a pilot set or other meaningful body of completed work. An auditor or other fresh context that did not produce the measured artifacts reads direct Git state, artifacts, execution output, checkpoint and intent history, raw retained evidence, and human decisions. It separates mechanical observations from interpretive findings and includes the method used for each measure.

The first reading establishes a baseline. A later reading may compare like-for-like evidence, but no single task establishes a universal pattern. A proposed governance addition cites repeated failures and identifies the smallest mechanism that would have intercepted them.

## Records

Each run produces one dated audit record under `docs/audits/`, links this specification, names its evidence corpus, and states observations, unavailable fields, and comparison limits. The record carries no execution authority, recommendation, automatic threshold, or live signal. A separate engineer-approved governance change owns any response.

Raw evidence remains subject to credential, confidentiality, repository-retention, and publication rules. The audit records only redacted observations needed for reproduction.

## Acceptance Predicates

- Every published number is reproducible from the named evidence and distinguishes unavailable data from zero.
- Every interpretive finding is labeled as judgment rather than count.
- No reading gates, pauses, redirects, or scores the work it measures.
- No active execution vocabulary, file, or role invocation is required solely for this program.
- A second reader can reproduce the mechanical observations without using the producer's completion report as the sole source.

## Alternatives Considered

### Required Event Schema

Rejected for active work. The earlier schema made framework conduct countable but also made event production part of the workflow and encouraged coordination activity. Legacy files remain measurable without keeping their controller active.

### Live Stagnation Breaker

Rejected. Returning aggregate rates to the measured agent changes its incentives, and early thresholds have no distribution behind them. Direction recovery belongs to `docs/change-execution.md`; framework measurement stays task-external.

### Narrative Reconstruction

Rejected. A checkpoint or completion report is a claim, not a measurement. Where direct evidence is absent, the field remains unavailable.

## Related Documents

- `docs/change-execution.md`
- `docs/documentation-model.md`
- `docs/verification-instruments.md`
- `docs/specs/20260719-verification_calibration.md`
- `docs/audits/README.md`
