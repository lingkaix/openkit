# Agent Coordination Playbook Audit

## Observation

- Date: 2026-08-21
- Generating owner: [`docs/change-execution.md`](../change-execution.md)
- Request: Engineer-directed repository-integrity audit of the final coordination-playbook and adjacent role and doctrine changes.
- Authority: This record is non-authorizing evidence. It does not accept the audited change, authorize implementation, or adjudicate itself.

## Observed Surfaces

- Root execution owner: `AGENTS.md`.
- Governance and rationale: `docs/change-execution.md`, `docs/documentation-model.md`, `docs/engineering-doctrine.md`, and `docs/audits/README.md`.
- Calibration boundary: `docs/specs/20260719-verification_calibration.md`.
- Role registry and operation: `.codex/config.toml` and the `researcher`, `test-author`, `builder`, `reviewer`, `verifier`, and `auditor` prompts under `.codex/agents/`.

## Direct Observations

- Root governance keeps current user intent, architecture, governing trade-offs, strict-risk acceptance, and final approval with engineers while allowing the primary agent to revise methods, decomposition, probes, and role composition.
- Change Execution assigns the primary agent responsibility for convergence, direct artifact reconciliation, next-action integration, single-writer coordination, and proportionate delegation. Its role guidance has no fixed order or invocation count, and no capability is a prerequisite for another.
- The named stall signals are expressly observations rather than counters, breakers, or automatic role calls. Their recovery route resolves claims against accepted owners and direct evidence, then distinguishes local correction, reframe, fresh-context direction checking, and engineer-owned decisions.
- Researcher, test-author, and builder selection guidance matches their prompts: external primary-source evidence, independent oracle design from accepted behavior, and implementation within a clear owner and writable boundary respectively.
- Reviewer, verifier, and auditor remain distinct across Change Execution, Engineering Doctrine, the role registry, and their prompts. Review is routine material artifact acceptance, verification is rarer falsification or fresh-context direction checking, and audit is engineer-directed or owner-directed longitudinal evidence work, governed measurement, or terminal archiving.
- Documentation Model now distinguishes engineer-owned current user intent from documentation's durable record of recorded intent and accepted decisions. The audit local guide and auditor prompt both route a generic engineer-directed repository-integrity audit to Change Execution.
- Verification Calibration describes adaptive coordination and review or adjudication functions without making its calibration method the everyday execution workflow. Its measurement ownership, separation, cadence, and thresholds remain within that specification.

## Consistency Result

No material contradiction, duplicate authority, fixed-pipeline reintroduction, or role-purpose collapse was found in the observed bytes. The coordination guidance remains owned by Change Execution, role-specific operation remains in the role prompts, rationale remains non-authoritative, and calibration remains a separate governed measurement domain. This is a scoped result: it means the stated consistency claims were not falsified by the observed corpus, not that the process is globally optimal.

## Operating Effectiveness Not Established

This audit inspected repository text and role projections. It did not execute a long-horizon task, induce context loss, measure model behavior, or observe the three approved pilots. It therefore cannot establish that the guidance reduces churn, preserves direction over days or weeks, selects roles proportionately, detects misleading reports, or recovers correctly from compaction in practice. Repository checks also cannot prove that a running verification context is actually fresh.

## Pilot Observation Need

For each of the three approved pilots, later task-external review needs retained evidence showing whether material next actions changed an Artifact, Belief, or Decision; whether a stalled route was recognized and corrected without role or handoff churn; whether role selection added production capacity or proportionate independence; whether producer claims were reconciled with actual artifacts and execution output; and whether a fresh-context direction check after compaction or resume changed or confirmed the route for an evidence-backed reason. These are observation needs only. This record sets no threshold, breaker, mandatory role call, or new workflow rule.

## Residual Uncertainty

The remaining uncertainty is operating behavior under the three pilots and later long-horizon work. Any repeated failure pattern belongs in a later dated observation and requires engineer disposition through its owning governance document; it is not implementation scope created by this record.
