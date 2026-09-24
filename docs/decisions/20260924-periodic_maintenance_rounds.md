---
status: Accepted
date: "2026-09-24"
decider: Engineer
---
# Concentrated Maintenance Rounds Complement Everyday Design Upkeep

## Decision

Besides Strategic Programming and upkeep within each change, the repository runs concentrated maintenance rounds like the 2026-09-22 cleanup pilot. A round is triggered by signals rather than a calendar: complexity trends at an audit, the number and age of deferred findings, recurrence of one defect class, a discovery failure in which an agent reimplemented an existing capability, observed change amplification, a release boundary, a completed governance change, or growth of unharvested temporary material. A round preserves behavior: it makes behavior-preserving changes only and commits them apart from behavior changes; it writes characterization tests before touching untested code; it registers each hypothesis and expected observable before editing; it works in small reversible slices; it compares baseline and candidate with the same oracle; it confirms by mutation that the protecting tests can see the responsibility; it obtains independent acceptance; it never removes safety protections in production to experiment; and it concludes each deletion candidate with one of the four ablation outcomes, analyzing mechanisms that back each other up together. A round is evaluated by raw before and after observations, such as repeated decision points, caller coordination steps, fan-out, and discovery probe results, by comparing registered predictions with results, and by tracking regressions attributable to the round over later changes. It uses no scores and no line-count targets. Over over-design, the Consultant watches at design time, the Reviewer at each diff, and the Auditor over accumulated work, including documents. After this governance revision, several rounds evaluate whether the new framework works better, using independent code review of their output and, where affordable, replaying a task under the old and new governance.

## Reason

The engineer wants to know when such work is needed, how to keep it from changing behavior or adding defects, and how to judge it. The 2026-09-22 pilot showed that bounded rounds with registration and independent audit can remove residue safely, and that its scores could not decide edge cases, so the evaluation stays with raw observations.

Source: change record 202609231611190001-engineering_governance_landing, proposal, section Engineer Rulings, R-009.

## Rejected Alternatives

- Fixed cleanup rounds on a schedule. Rejected; signals decide.
- Scoring rounds or targeting deleted lines. Rejected because the measure becomes the target.
- Relying only on per-change upkeep. Rejected because it did not find knowledge restated across modules.

## Revisit When

Rounds repeatedly end with no change, or a round introduces a regression that its preservation discipline should have caught.

## Affected Owners

- docs/change-execution.md
- docs/roles/auditor.md
- docs/specs/20260719-verification_calibration.md
