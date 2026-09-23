# Findings

These items hand candidate inputs to owners outside this plan; they are non-authorizing and do not change any accepted design until the receiving owner admits them.

## Follow-up Index

- [ ] `GOVLAND-FND-001` [deferred] Goal Mode inspection instead of sandbox reads
- [ ] `GOVLAND-FND-002` [deferred] Goal Mode mid-course independent direction check
- [ ] `GOVLAND-FND-003` [deferred] Goal Mode model selection by decision type
- [ ] `GOVLAND-FND-004` [deferred] Offline evaluation of Orchestrator models from retained traces

## [deferred] GOVLAND-FND-001 — Goal Mode inspection instead of sandbox reads

- **Observation:** The Goal-scoped Orchestrator runs inside NanoCore and cannot read Sandbox work output; direct Sandbox reads were previously declined for security and construction complexity. The discussion proposed that when the Orchestrator needs a targeted observation, it admits a bounded inspection worker Turn that reads inside the Sandbox and returns a bounded report with evidence references, so Sandbox content leaves only through the existing evidence and publication paths under current audience policy.
- **Impact:** docs/specs/20260704-goal_mode_coordination.md owns Orchestrator inputs and worker dispatch. Without an owned observation path the Orchestrator judges from worker claims alone; adding raw read access instead would widen the Sandbox effect boundary.
- **Evidence:** temp/quality-governance/discussion-log.md, topic six, the section on context budget and the Orchestrator; the spec's Worker execution Threads section already retains one reference Item per execution and lets the Orchestrator inspect bounded results on demand through Goal-scoped Tools.
- **Owner:** docs/specs/20260704-goal_mode_coordination.md; no receiver has accepted it.
- **Next action:** Recorded as a candidate input by engineer decision on 2026-09-23 and moved outside this plan. The Goal Mode coordination owner evaluates it when a Goal Mode change next touches Orchestrator inputs or worker dispatch.

## [deferred] GOVLAND-FND-002 — Goal Mode mid-course independent direction check

- **Observation:** Agents can follow a wrong path regardless of model strength. The discussion proposed an independent Consultant worker Turn of the same kind as the existing completion verifier, admitted mid-course on objective triggers such as a repeated-work breaker trip, repeated fuse outcomes at one Plan revision, or a Plan revision, and returning findings only into Plan revision or attention paths.
- **Impact:** docs/specs/20260704-goal_mode_coordination.md owns the breaker, completion verification, and the Goal Supervisor exclusion. A Consultant with scheduling or state authority would become the excluded Goal Supervisor; one without an owned trigger would not run.
- **Evidence:** temp/quality-governance/discussion-log.md, topic six; the spec's completion proposal section already defines `completionVerification` with model-family, context, Harness, and Sandbox independence, and its lifecycle section defines the four breaker trigger classes.
- **Owner:** docs/specs/20260704-goal_mode_coordination.md; no receiver has accepted it.
- **Next action:** Recorded as a candidate input by engineer decision on 2026-09-23 and moved outside this plan. The Goal Mode coordination owner evaluates it when a Goal Mode change next touches breaker routing or verification.

## [deferred] GOVLAND-FND-003 — Goal Mode model selection by decision type

- **Observation:** Routine scheduling is already deterministic code, so the Orchestrator's remaining model work is judgment: drafting and revising plans, interpreting failures, proposing completion, and recognizing a wrong path. The discussion proposed selecting the model per Orchestrator Turn by wake reason or decision type, a strong model for judgment Turns and a fast model for routine wakes, and placing large-context fast models in reading work such as inspection rather than in the judgment seat.
- **Impact:** docs/specs/20260704-goal_mode_coordination.md owns Orchestrator admission and wake behavior. A single fast model in the Orchestrator seat would weaken the decisions most exposed to wrong-path errors.
- **Evidence:** temp/quality-governance/discussion-log.md, topic six; the spec's lifecycle section makes the deterministic watcher the default and admits a model Turn only on a material wake condition.
- **Owner:** docs/specs/20260704-goal_mode_coordination.md; no receiver has accepted it.
- **Next action:** Recorded as a candidate input by engineer decision on 2026-09-23 and moved outside this plan. The Goal Mode coordination owner evaluates it when Orchestrator model configuration is next specified.

## [deferred] GOVLAND-FND-004 — Offline evaluation of Orchestrator models from retained traces

- **Observation:** No data shows how fast-tier models perform as Orchestrator. Complete work-data retention, whose intended uses include evaluation, would allow comparing models per decision type offline on retained Goal traces before any production trial.
- **Impact:** docs/specs/20260921-work_data_retention_format.md owns retained content and its uses; docs/specs/20260704-goal_mode_coordination.md owns the Orchestrator. Choosing Orchestrator models without evidence risks either unnecessary cost or degraded judgment.
- **Evidence:** temp/quality-governance/discussion-log.md, topic six; the retention format specification lists evaluation among the purposes of retained work data.
- **Owner:** docs/specs/20260704-goal_mode_coordination.md together with docs/specs/20260921-work_data_retention_format.md; no receiver has accepted it.
- **Next action:** Recorded as a candidate input by engineer decision on 2026-09-23 and moved outside this plan. The Goal Mode coordination owner evaluates it once retained Goal traces exist in usable volume.
