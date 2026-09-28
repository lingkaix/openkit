# Findings

These items record structural observations about this plan's uncommitted implementation, made by a read-only fan-out probe while the plan was paused; they are non-authorizing and leave the correction to this plan's primary.

## Follow-up Index

- [x] `RCR-FND-001` [closed] Bind capture coverage once and pass it opaquely
- [x] `RCR-FND-002` [closed] Construct ModelCaptureContext at one admission point
- [x] `RCR-FND-003` [closed] Seat timeline presentation limits in one owner
- [x] `RCR-FND-004` [closed] Reconcile with the governance landing before resuming

- [x] `RCR-FND-005` [closed] Preserve partial coverage after a local gap
- [x] `RCR-FND-006` [closed] Do not announce idle prior-Turn children as newly started
- [ ] `RCR-FND-007` [deferred] Reconcile failed Goal revision readback with admitted capture
- [x] `RCR-FND-008` [closed] Preserve work outcome after a durably recorded collector fault
- [x] `RCR-FND-009` [closed] Anchor each rejected observation to its exact expected fact
- [x] `RCR-FND-010` [closed] Identify the existing Quick Chat Knowledge-read divergence

## [closed] RCR-FND-001 — Bind capture coverage once and pass it opaquely

- **Observation:** The same admitted `{scope, value}` capture binding has four equivalent shapes: `CaptureCoverageBindingSchema` in apps/nanocore/src/storage/workspace-file-records.ts, `AgentEnvironmentCaptureCoverageSchema` in packages/config-schema/src/agent-environment.ts, the inline `RuntimeCaptureInput.captureCoverage` type, and a hand-written closed-set check in packages/worker-shim/src/cli.ts. The binding is revalidated along a path of about seven hops instead of being bound at Turn admission and carried as an opaque value.
- **Impact:** docs/specs/20260921-work_data_retention_format.md and docs/specs/20260616-agent_environment_package.md own the binding. Adding a scope or value, or changing the exact-key rule, needs four coordinated edits with no compile-time link between them; a missed edit silently diverges the Worker check from the Core schema.
- **Evidence:** temp/quality-governance/probes/probe-b-change-fanout.md, parameter-threading section, snapshot at HEAD a1ad3466 on 2026-09-23; spot-checked by Claude Code at workspace-file-records.ts:74, agent-environment.ts:1031, and cli.ts:541-549.
- **Owner:** docs/changes/202609220200000001-runtime_child_retention/plan.md, the paused runtime child retention primary.
- **Next action:** On resumption, choose one schema owner for the binding that both Core and Worker can import, replace the other shapes and the hand-written check with it, and keep the exact-key rejection covered by one existing test.

- **Closing verdict:** One strict shared Worker Protocol schema defines the admitted binding; the existing aliases carry no independent rule. Early AEP validation remains because removing it allowed credential authority resolution before missing-binding rejection. The authored policy enum remains a separate concern.
- **Closure evidence:** Independent source review in temp/changes/202609220200000001-runtime_child_retention/resume/opus-review-2.txt; protocol suite 97/97 in l1-worker-protocol-tests.txt, Core and Worker typechecks, and final repository check repo-b-final.txt in the same evidence directory. CLI exact-key and invalid-binding cases remain covered by the 98-test focused CLI run.

## [closed] RCR-FND-002 — Construct ModelCaptureContext at one admission point

- **Observation:** `ModelCaptureContext` is constructed separately at four entry points, Quick Chat in mode-entry-routes.ts, Goal planning in goal-planning.ts, Administration in administration-routes.ts, and the internal Gateway provider, each opening the Workspace database; goal-planning.ts moved `createTurn` earlier only to obtain the capture handle.
- **Impact:** docs/specs/20260921-work_data_retention_format.md owns model I/O capture. Each new internal model caller must repeat database opening and context construction, and a caller that forgets it silently loses capture.
- **Evidence:** temp/quality-governance/probes/probe-b-change-fanout.md, path B of the parameter-threading section; spot-checked by Claude Code in the goal-planning.ts diff.
- **Owner:** docs/changes/202609220200000001-runtime_child_retention/plan.md, the paused runtime child retention primary.
- **Next action:** On resumption, derive the capture context once where the owning Turn is admitted and pass it through the existing provider call, removing per-entry construction, unless the retention owner records why an entry point needs different capture semantics. On 2026-09-24 independent final source review confirmed that withTurnModelCapture owns database lifetime and persisted-binding validation for Quick Chat, Goal planning and Administration. Public and Worker Gateway calls instead derive their context from authenticated CapabilityCall and Worker lineage, then verify the same persisted binding through ModelCapture; apps/nanocore/src/llm/README.md records why that entry remains distinct under the existing owners. No universal admission factory is required.
- **Closing verdict:** Closed by consolidating the three Store-admitted internal model callers while preserving the independently authenticated Gateway boundary. Each entry still owns its Turn admission; this closes duplicate construction duties, not the remaining Goal behavior or authority findings.
- **Closure evidence:** Independent reviewer inspected model-capture.ts, all three callers and gateway-routes.ts against the current llm guide; temp/changes/202609220200000001-runtime_child_retention/resume/openkit-retention-core-fullslice.txt records 21 files and 684 passing tests. The later Goal regression remains separately open in docs/changes/202609241800000001-continuous_goal_and_builtin_prompts/findings.md as GOALCONT-FND-002.

## [closed] RCR-FND-003 — Seat timeline presentation limits in one owner

- **Observation:** The timeline limits of 50 entries per Turn and 1000 text characters appear in three implementations, apps/nanocore/src/storage/work-observations.ts, apps/nanocore/src/app-dashboard.ts, and packages/app-api-schemas/src/dashboard.ts, and the coverage-state mapping is restated in both the retention specification and the Web product projection specification.
- **Impact:** docs/specs/20260628-web_product_surface_projection.md owns presentation limits. Changing a limit or mapping needs coordinated edits across three code files and two specifications, and the interim governance audit already had to reseat duplicated numeric authority once.
- **Evidence:** temp/quality-governance/probes/probe-b-change-fanout.md, projection and specification sections; spot-checked by Claude Code at work-observations.ts:551-552 and 665-670, app-dashboard.ts:768-769, and dashboard.ts:706 and 711.
- **Owner:** docs/changes/202609220200000001-runtime_child_retention/plan.md, the paused runtime child retention primary.
- **Next action:** On resumption, keep the limits in the shared dashboard schema as the single code owner, have the storage projection and dashboard read them from it, and remove the restated coverage mapping from the retention specification in favor of a link to the Web projection owner. On 2026-09-24 the two numeric bounds were seated in the App API schema, fixed caller arguments were removed, and the coverage mapping was moved intact to the Web projection owner; the focused 54-test suite passed.

- **Closing verdict:** One code owner now defines both presentation limits; the mapping has one normative owner and no criterion was deleted.
- **Closure evidence:** Shared constants in packages/app-api-schemas/src/dashboard.ts and direct consumption by storage/work-observations.ts; `pnpm --filter @openkit/nanocore exec vitest run --no-cache --configLoader runner src/storage/work-observations.test.ts src/thread-dashboard.test.ts src/runtime/worker-control-gateway.test.ts` passed 54 tests in three files; raw output is temp/changes/202609220200000001-runtime_child_retention/resume/openkit-timeline-tests.txt.

## [closed] RCR-FND-004 — Reconcile with the governance landing before resuming

- **Observation:** While this plan was paused, the engineering governance landing edited paths this plan also changed: root AGENTS.md, docs/change-execution.md, docs/engineering-doctrine.md, docs/INDEX.md, docs/core/protocol.md, docs/specs/20260921-work_data_retention_format.md, docs/specs/20260703-worker_control_protocol.md, and the kind field of every specification. Role contracts moved from .codex/agents/ to docs/roles/, L2 now includes in-process composition tests with fault injection at a seam, change plans now say Intent Revision, and inline engineer-ruling markers in the retention specification became decision-record links. At commit 2ff8887c the repository check fails at biome with 15 errors in 14 apps/nanocore files, all of which this plan changed; biome also reports a warning, not an error, in apps/nanocore/src/docker/app-run-script.test.ts, which this plan did not change. The same errors appear with the landing diff stashed.
- **Impact:** Resuming from this plan's own checkpoint without reconciling would work against superseded role paths and test-layer rules, and the biome failures block the repository check for every other change.
- **Evidence:** git diff 2ff8887c on the named paths; the biome step of the repository check run with and without the landing diff on 2026-09-24.
- **Owner:** docs/changes/202609220200000001-runtime_child_retention/plan.md, the paused runtime child retention primary.
- **Next action:** On resumption, read docs/changes/202609231611190001-engineering_governance_landing/plan.md and its diff, name the seams this plan crosses in its checkpoint, fix the 15 biome errors in its 14 files and re-run the repository check. On 2026-09-24 this action completed; proceed to RCR-FND-001 through RCR-FND-003 under the current role contracts and named L2 seams.
- **Closing verdict:** Closed on 2026-09-24 after current governance reconciliation and mechanical formatting of the 14 identified files.
- **Closure evidence:** `temp/changes/202609220200000001-runtime_child_retention/resume/openkit-resume-repo-fixed.txt`; `pnpm check:repo` exited 0, with three warnings and 18 informational diagnostics, no errors. Baseline Core 153 tests and config 206 tests passed; the Worker hard-cap timeout under parallel load passed in isolation at 189.21 ms without changing its timeout or assertions.

## [closed] RCR-FND-005 — Preserve partial coverage after a local gap

- **Observation:** The independent Opus reviewer found that any unavailable coverage fact wins over observed progress, including a malformed-frame gap.
- **Impact:** The Web projection owner requires observed facts with a gap to remain partial; the current projection can overstate loss of visibility.
- **Evidence:** apps/nanocore/src/storage/work-observations.ts coverage accumulation; temp/changes/202609220200000001-runtime_child_retention/resume/opus-review-1.txt M1.
- **Owner:** docs/changes/202609220200000001-runtime_child_retention/plan.md, the resumed retention primary.
- **Next action:** Derive a red storage projection test from the current owner, then correct the aggregate projection without changing retention.

- **Closing verdict:** Observed activity with a recorded gap projects partial; unavailable remains reserved for no activity evidence. Independent review inspected the implementation and exact red/green outputs.
- **Closure evidence:** temp/changes/202609220200000001-runtime_child_retention/resume/oracle-m1-red.txt, oracle-m1-green.txt (2 cases), m1-work-observations-green.txt (10 tests), and opus-review-3.txt

## [closed] RCR-FND-006 — Do not announce idle prior-Turn children as newly started

- **Observation:** The independent Opus reviewer found that a watermarked child source emits an origin fact even when no bytes arrived after Turn admission.
- **Impact:** The work-data retention watermark boundary excludes prior-Turn activity, and the current projection can present historical children as new activity.
- **Evidence:** packages/worker-shim/src/codex-runtime-capture.ts origin emission after tail setup; temp/changes/202609220200000001-runtime_child_retention/resume/opus-review-1.txt M2.
- **Owner:** docs/changes/202609220200000001-runtime_child_retention/plan.md, the resumed retention primary.
- **Next action:** Derive a red collector test with an idle prior-Turn child, then restrict origin publication to current-Turn evidence.

- **Closing verdict:** A pre-watermarked idle child emits no new origin; a current-Turn spawn or appended source bytes can emit it. Independent review confirmed the boundary. The wording used for a resumed child remains a separate presentation question.
- **Closure evidence:** temp/changes/202609220200000001-runtime_child_retention/resume/oracle-m2-red.txt, oracle-m2-green.txt, m2-codex-runtime-capture-green.txt (10 tests), and opus-review-3.txt

## [deferred] RCR-FND-007 — Reconcile failed Goal revision readback with admitted capture

- **Observation:** The broader focused suite reproduces a failed Goal revision readback error on clean 69a60f59: admission now persists a planner Turn before failure, leaving a partial tuple where the existing test expects no new result.
- **Impact:** Goal Mode handled-failure readback and durable model capture both apply; weakening either contract to make the suite green is not authorized.
- **Evidence:** apps/nanocore/src/runtime/goal-planning.test.ts failed revision case; independent Opus Consultant source review on 2026-09-24; isolated baseline reported by the context builder.
- **Owner:** docs/changes/202609220200000001-runtime_child_retention/plan.md, the resumed retention primary.
- **Next action:** Probe whether the existing revision admission or exact tuple definition permits a correction satisfying both owners; pause dependent Goal edits until the probe settles, otherwise present a concrete owner amendment to the engineer. On 2026-09-28 the engineer froze Goal development without accepting this behavior; the receiver is the engineer-led Goal Mode product Redesign, activated only by an explicit engineer instruction to resume that design.


## [closed] RCR-FND-008 — Preserve work outcome after a durably recorded collector fault

- **Observation:** A malformed native source ancestry persists a partial-frame gap through the actual collector-to-Core composition but still rejects both stdout processing and finalization.
- **Impact:** This conflates collection quality with the work outcome. The engineer approved separating them while preserving fail-closed handling when required observations or failure facts cannot be persisted.
- **Evidence:** temp/changes/202609220200000001-runtime_child_retention/resume/oracle-m3-probe.txt and oracle-m3-facts.json; docs/decisions/20260924-recorded_collector_fault_preserves_work_outcome.md.
- **Owner:** docs/changes/202609220200000001-runtime_child_retention/plan.md, the resumed retention primary.
- **Next action:** Derive a regression from the approved owner amendment, correct only source/parser fault propagation, and retain persistence and authenticated-lineage failure assertions.

- **Closing verdict:** Closed under the approved decision. Source/parser faults remain visible as gaps without rewriting work outcome; required append failures propagate, including timer failures on later input. Invalid ancestry is rejected before descendant reachability. Independent review accepted the bounded correction. Native-frame ancestry faults still use the broader malformed-frame label; per-descendant gap labeling after an ancestor becomes invalid is a non-gating observation.
- **Closure evidence:** temp/changes/202609220200000001-runtime_child_retention/resume/opus-review-bounded-closeout.txt; oracle-review3-worker-capture-green.txt (26 tests), oracle-review3-core-gateway-green.txt (40 tests), and repo-b-final.txt (exit 0) in the same directory. B1 deciding failure is oracle-b1-ablation-red.txt, followed by oracle-b1-restored-green.txt; oracle-b1-red.txt contains a later green run and is not failure evidence.

## [closed] RCR-FND-009 — Anchor each rejected observation to its exact expected fact

- **Observation:** Four expected tool observations across arguments and results sharing one call reference produce only two credential-guard unavailability facts without exact expected-observation anchors.
- **Impact:** A call reference cannot disambiguate the retained gaps, so the required anchored-unavailability evidence is incomplete.
- **Evidence:** temp/changes/202609220200000001-runtime_child_retention/resume/oracle-l1-producer-red.txt and oracle-l1-composition-red.txt; both fail at the observed two-versus-four count before anchor assertions.
- **Owner:** docs/changes/202609220200000001-runtime_child_retention/plan.md, the resumed retention primary.
- **Next action:** Carry the existing expected-observation identity through unavailable Worker observations and resolve it to the ledger parent within the authenticated package; do not retain rejected body bytes or weaken the credential guard.

- **Closing verdict:** Closed after per-observation anchors, Core ingress validation, and interrupted-outcome retention. Independent review withdrew a proposed permanent unavailable/publication exclusion because the owner treats them as independent facts; no new content lifecycle was introduced.
- **Closure evidence:** temp/changes/202609220200000001-runtime_child_retention/resume/opus-review-bounded-closeout.txt; oracle-review3-worker-capture-green.txt (26 tests), oracle-review3-core-gateway-green.txt (40 tests), and repo-b-final.txt (exit 0) in the same directory. B1 deciding failure is oracle-b1-ablation-red.txt, followed by oracle-b1-restored-green.txt; oracle-b1-red.txt contains a later green run and is not failure evidence.

## [closed] RCR-FND-010 — Identify the existing Quick Chat Knowledge-read divergence

- **Observation:** A durable fixture correction exposed the existing unconditional Knowledge pre-read on the direct-answer path. The normative Chat Mode information-source contract requires zero such reads for a general question. Initial triage mistook the Current Implementation Projection describing the pre-read for a competing criterion; independent Consultant scrutiny corrected that classification.
- **Impact:** The implementation diverges from accepted intent, and a test also pins that older implementation. This is not an unresolved governing decision and does not authorize weakening the zero-read regression. The broader shared-loop correction is outside the retention change.
- **Evidence:** docs/specs/20260704-chat_mode_assistant.md, current-input admission and direct-answer criteria; apps/nanocore/src/quick-chat.test.ts, current-input handoff-summary case and S61-before-provider case; mode-entry-routes.ts unconditional answerFromWorkspaceKnowledge call.
- **Owner:** docs/changes/202609220200000001-runtime_child_retention/plan.md, the resumed retention primary.
- **Next action:** Preserve the observed baseline failure in retention closeout, and address the accepted information-source contract in its owning Chat change without inventing a query classifier or bypassing capture. No engineer ruling is needed to identify a non-authoritative implementation projection as a divergence; an exception allowing ambient reads would require one.
- **Closing verdict:** Closed by 44119012, removing the ordinary Assistant ambient Knowledge pre-read while retaining explicit Knowledge Manager selection and exact replay. Independent reviewer inspected the implementation and strengthened zero-read oracle against the accepted Chat owner; no query classifier or capture bypass was introduced.
- **Closure evidence:** temp/changes/202609290900000001-chat_task_stability_handoff/rcr-fnd-010-focused-green.log records four files and 72 passing tests; deciding-green records three cases and the combined core-integration.txt independently passes quick-chat.test.ts. Typecheck and focused lint pass. The captured deciding-red log is a transcription of the terminal result, not a raw saved execution log. Real-user experience validation remains in the receiving handoff.
