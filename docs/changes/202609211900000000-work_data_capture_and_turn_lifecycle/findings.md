# Findings

This report records non-authorizing findings from the work-data retention and Turn-lifecycle discussion. Accepted Core and specifications retain design authority. Listing a finding here is not admission of implementation work.

## Follow-up Index

- [ ] `WDC-FND-001` [open] Two denial paths produce different Turn terminal statuses
- [ ] `WDC-FND-002` [open] Replay crossover in the approval route

## [open] WDC-FND-001 — Two denial paths produce different Turn terminal statuses

- **Observation:** A denied policy-local approval writes Turn `cancelled` in `finishPolicyApprovalProjection` at `apps/nanocore/src/approval-routes.ts:601`; a denied worker gate writes Turn `interrupted` at `apps/nanocore/src/approval-routes.ts:873-874`, and the worker-control `aborted` overload at `apps/nanocore/src/runtime/worker-control-records.ts:80` also maps to Turn `interrupted`.
- **Impact:** Each path is self-consistent under its own owner, but a user sees two terminal statuses for the same product fact that an approval was denied. Unifying them would change a live mapping; leaving them split leaves the product presentation inconsistent.
- **Evidence:** Direct read of `apps/nanocore/src/approval-routes.ts:600-601` (`terminalStatus = input.decision === 'denied' ? 'cancelled' : 'completed'`) and `:868-874` (denied worker-gate closeout writes AgentSession `interrupted` and Turn `interrupted`); `apps/nanocore/src/runtime/worker-control-records.ts:80-96` (`aborted` overload returns `'interrupted'`). Source: R51.7 item 1.
- **Owner:** None is accepted.
- **Next action:** Obtain an accepted owner for whether the two denial paths should unify Turn terminal status. Do not implement unification in this plan.

## [open] WDC-FND-002 — Replay crossover in the approval route

- **Observation:** A classified closed worker gate selects the policy branch, whose replay callback still calls `finishPolicyApprovalProjection` (`apps/nanocore/src/approval-routes.ts:216`, `:232`); that helper expects a denied Turn to be `cancelled` (`:601`, `:607`) while the worker closure wrote `interrupted`, which the recovery classifier also expects (`apps/nanocore/src/runtime/worker-recovery.ts:380`, `:439`). This is source-derived and has not been reproduced at runtime.
- **Impact:** If the crossover fires, replay of a denied worker gate can fail closed against a Turn the policy helper does not recognize, leaving recovery inspect-only. The defect is unproven until a focused reproduction runs.
- **Evidence:** Direct read of `apps/nanocore/src/approval-routes.ts:216-232` (replay callback calls `finishPolicyApprovalProjection`), `:601` and `:607` (`cancelled` expected on the denied policy Turn), and the R51.7 citation of `apps/nanocore/src/runtime/worker-recovery.ts:380` and `:439`. No runtime reproduction is recorded.
- **Owner:** None is accepted.
- **Next action:** Run a focused reproduction of the classified-closed-worker-gate replay path before any remediation. Do not treat the source derivation as a runtime proof.
