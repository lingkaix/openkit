# P7 Policy behavior oracles

Production baseline: `464be22a0ec12a78ec2c7062769bdbde24552091`. Tests only; no Main push, production patch, invented Goal, grant or native receipt.

## Two new public-consumer cases

`apps/nanocore/src/runtime/goal-task-runtime-policy.test.ts`:

- `inherits an ancestor Thread prohibition in the actual Task and its continuation but not an unrelated Thread restriction`: native Goal, approved Plan, Task/card reservation, original scheduler/AEP and existing continuation admission; real parentThreadId; valid Workspace managed Policy; unrelated Thread restriction still permits the original call; ancestor prohibition denies before the upstream effect and records a prohibited Kernel result.
- `projects current physical prohibitions into the actual AEP network, Vault and every filesystem rule including CWD`: first prove genuine authored egress, native-created Vault grant and writable CWD. A separate Task starts under validated Workspace prohibitions before its initial AEP/attempt binding. Its real package must have empty network rules, empty Vault grants and read-only filesystem rules including `openkit-working-directory`. No immutable-attempt remint is required.

Whole owner on OLD: **35 PASS / 2 intended assertion RED / 0 skipped**, required Core build PASS. Both final failures are post-setup behavioral assertions: ancestor call remains allowed; prohibited egress remains in the package. Initial invalid fixture receipt retained and excluded. Commands: required NanoCore dependency build, then whole-file Vitest with `--retry=0 --maxWorkers=1 --fsModuleCache=false --cache=false`, ordinary FIFO. Exact external receipt: `sec-report-oracles/P7-nav-corrected.json`. NEW belongs to the P7 production owner; no second OLD round is needed.

## Existing pure-refactor coverage, unchanged

Keep whole `policy/goal-domains.test.ts`, `policy/goal-domain-administration.test.ts`, `policy/goal-task-classification.test.ts`, `mode-entry-routes.test.ts`, `runtime/task-admission.test.ts`, `runtime/goal-task-policy-context.test.ts`, and the original 35 cases in the changed owner. They cover approved Plan/card/revision checks, real Task reservation and current authority, missing Task privilege escalation to the Coordinator, finite-use boundaries, Goal closure, captured approval, and the stronger prohibit/human-approval outcomes. Keep all current assertions when replacing removed adapter imports; do not add compatibility wrappers.
