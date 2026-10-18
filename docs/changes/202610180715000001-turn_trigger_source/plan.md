---
type: change-plan
status: in-progress
---
# Native Worker Turn Trigger Source

## Intent

The coordinator assigned C3 after R093: fill the existing optional Turn triggerSource for Worker, recurring and automation admissions. This is rc.10 additive provenance, not a new retained format or a migration. The Meta-Skill text candidate is separately approved and gated; its publication waits for the main root-Web inventory repair assigned to the coordinator. C3 is prepared independently without changing that candidate.

## Owner And Scope

Core Concepts and Identity distinguish cause from actor; Protocol owns the existing closed source values and field shape. [Worker Agent Capability](../../specs/20260703-worker_agent_capability.md) states the native producer mapping before implementation. Direct input, Task handoff and scheduled admission retain their actual causes. Existing canonical Turns, including unknown source, remain unchanged. No actor inference, model-selected metadata, new record, authority, runner, replay or repair is added.

## Verification

Strengthen existing native direct-input, confirmed Task handoff, recurring initial-publication and scheduled-event Tool admission regressions. Expected pre-change failure: each newly published Turn lacks its known triggerSource. Keep all original identity, authorization, once-only publication and replay assertions. Run complete runtime and affected root admission suites through the bounded local gate; obtain independent Sol review and express land on green main after the preceding text increment.

The four focused regressions failed on owner/test head `0524dbd8c` because each source was absent, then passed with the native producer correction. Logs: backlog `evidence/L-GO/c3-trigger-source-red.log` and `c3-trigger-source-green.log`. This focused proof does not replace the complete module gate.

Independent review of `824e91579` found that the generic App starter also serves environment replacement and Artifact Review follow-up. The correction passes an optional trusted source through that adapter and assigns handoff only in actual Task and Goal delegation callers. An added adapter-omission assertion covers the reachable error without assigning an unknown cause. The queued gate on the superseded head was cancelled before checks, not counted as product evidence.

The extra adapter-omission probe was cancelled while queued for eight minutes, before test execution. No observed RED result is claimed for that assertion; the complete Provider readiness composition suite covers it on the corrected head. The four original RED/GREEN producer regressions remain valid. Goal Task admission also asserts that its native starter receives the handoff cause.
