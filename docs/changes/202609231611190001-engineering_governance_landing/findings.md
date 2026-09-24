# Findings

These items hand candidate inputs to owners outside this plan; they are non-authorizing and do not change any accepted design until the receiving owner admits them.

## Follow-up Index

- [ ] `GOVLAND-FND-001` [deferred] Goal Mode inspection instead of sandbox reads
- [ ] `GOVLAND-FND-002` [deferred] Goal Mode mid-course independent direction check
- [ ] `GOVLAND-FND-003` [deferred] Goal Mode model selection by decision type
- [ ] `GOVLAND-FND-004` [deferred] Offline evaluation of Orchestrator models from retained traces
- [x] `GOVLAND-FND-005` [closed] Five decision records lack a recorded reason
- [x] `GOVLAND-FND-006` [closed] Export posture decision has no owner statement
- [x] `GOVLAND-FND-007` [closed] Roadmap batch cadence premise has likely expired
- [x] `GOVLAND-FND-008` [closed] Hand-written configuration still rejects unknown keys
- [ ] `GOVLAND-FND-009` [deferred] Specification bodies need normalization
- [ ] `GOVLAND-FND-010` [deferred] The new governance framework is not yet evaluated
- [ ] `GOVLAND-FND-011` [deferred] DeepSeek Harness dispatch is unverified
- [ ] `GOVLAND-FND-012` [deferred] Platform references are a six-member enumeration
- [x] `GOVLAND-FND-013` [closed] Role contracts and the glossary depart from their accepted governance type
- [x] `GOVLAND-FND-014` [closed] Agents as Workspace members has no owner statement
- [x] `GOVLAND-FND-015` [closed] Complete work-data export still omits restricted original bodies

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

## [closed] GOVLAND-FND-005 — Five decision records lack a recorded reason

- **Observation:** The ruling census backfilled decision records whose rule is owned but whose reason was never written down. Five records say so in their Reason section: docs/decisions/20260909-active_members_full_operation_set.md (why the role ceiling was removed), docs/decisions/20260813-one_turn_in_flight_per_thread.md (why parallel Turns in one Thread were reversed), docs/decisions/20260909-schedule_admission_attempts.md (why three attempts and ten minutes), docs/decisions/20260709-no_line_breaks_in_sentences.md, and docs/decisions/20260909-mixed_generative_rendering.md (why the A2UI-only first host was replaced).
- **Impact:** docs/documentation-model.md requires an agent about to change such a rule to ask the engineer first. Until the reasons exist, a later challenge to any of these rules cannot be judged against the reason, and Chesterton's Fence cannot be applied.
- **Evidence:** temp/quality-governance/probes/, ruling census of 2026-09-23 spot-checked by Claude Code; the five records as landed in this plan.
- **Owner:** The engineer, for the reasons; this plan, for recording them.
- **Next action:** Ask the engineer for each reason at the final report of this plan; record each answer in a new decision record that supersedes the incomplete one, or leave the record as it is if the engineer declines.
- **Closing verdict:** Recorded disposition: the engineer gave all five reasons on 2026-09-24. Terminal disposition: each incomplete record is Superseded by a new record that carries the same decision with the engineer's reason, and the owners now link the new records.
- **Closure evidence:** docs/decisions/20260924-member_permissions_await_policy_kernel.md, 20260924-one_active_turn_per_thread_reason.md, 20260924-schedule_admission_numbers_are_empirical.md, 20260924-line_wrapping_belongs_to_the_reader.md, and 20260924-html_delegate_for_complex_components.md under docs/decisions/; the documentation-model validator passes.

## [closed] GOVLAND-FND-006 — Export posture decision has no owner statement

- **Observation:** docs/decisions/20260921-export_simple_and_complete.md records the engineer's ruling that work-data export does simple necessary processing and then exports completely, but neither docs/specs/20260704-workspace_backup_export_import.md nor docs/specs/20260921-work_data_retention_format.md states that rule, so no owner links the record. The backup specification carries redaction and exclusion rules, such as excluding other users' private Threads, whose relation to the ruling has not been checked.
- **Impact:** Without an owner statement the ruling is not binding on implementation, and a later export change could add processing the engineer rejected or remove an exclusion the ruling did not intend to remove.
- **Evidence:** docs/decisions/20260921-export_simple_and_complete.md; a search of both specifications for the ruling found no matching statement on 2026-09-24.
- **Owner:** docs/specs/20260704-workspace_backup_export_import.md, with the engineer for the scope question.
- **Next action:** Ask the engineer whether the ruling covers the whole portable export or only the work-data families, then state it in the backup specification's export section with a link to the record.
- **Closing verdict:** Recorded disposition: on 2026-09-24 the engineer confirmed that the ruling covers all work data. Terminal disposition: the Work Data Retention Format specification states the export posture beside its portable import section and links the record; the backup owner's audience exclusions stand.
- **Closure evidence:** The Export posture paragraph under Import, Remint, And Resolution Closure in docs/specs/20260921-work_data_retention_format.md; the documentation-model validator passes.

## [closed] GOVLAND-FND-007 — Roadmap batch cadence premise has likely expired

- **Observation:** docs/decisions/20260912-large_batches_before_first_release.md rests on the engineer's statement on 2026-09-12 that fewer than one week remained before the first release. On 2026-09-24 that week has passed, and docs/roadmap.md and docs/specs/20260711-evaluation_harness_design.md still apply the cadence.
- **Impact:** If the premise no longer holds, the roadmap keeps deferring integrated evaluation for a reason that is gone.
- **Evidence:** The record's Reason and Revisit When sections; the dates.
- **Owner:** The engineer, for docs/roadmap.md.
- **Next action:** Ask the engineer whether the first release happened or the cadence still applies; a changed cadence is a new decision record that supersedes this one and an edit to docs/roadmap.md.
- **Closing verdict:** Recorded disposition: on 2026-09-24 the engineer confirmed that the large-batch cadence premise still holds. Terminal disposition: docs/roadmap.md and the evaluation harness specification stay as they are, and docs/decisions/20260912-large_batches_before_first_release.md remains Accepted.
- **Closure evidence:** The engineer's answer of 2026-09-24; no document change was needed.

## [closed] GOVLAND-FND-008 — Hand-written configuration still rejects unknown keys

- **Observation:** docs/core/contract-evolution.md now requires that an unknown key in hand-written configuration produce a warning diagnostic while authority-bearing sections and required features fail closed. docs/specs/20260628-nanocore_config_identity_contract.md still says that all authored files use strict schemas, which the Core rule now overrides for tolerant sections; packages/config-schema/src uses strict object schemas in about 160 places, and the NanoCore agents loader test expects an Unrecognized keys error.
- **Impact:** docs/specs/20260628-nanocore_config_identity_contract.md and docs/specs/20260616-agent_environment_package.md own the affected configuration; until they classify each section, an older NanoCore rejects configuration that a newer one wrote.
- **Evidence:** The authored-file schema paragraph of docs/specs/20260628-nanocore_config_identity_contract.md, a count of strict object schemas in packages/config-schema/src, and apps/nanocore/src/config/agents-loader.test.ts, all on 2026-09-24.
- **Owner:** docs/changes/202609241200000001-configuration_tolerant_reader/plan.md; accepted by the resumed governance handoff primary on 2026-09-24.
- **Next action:** Moved outside this plan by the engineer's instruction of 2026-09-24 to plan the other landing tasks. The configuration tolerant reader plan starts when the engineer transfers it. The resumed handoff admitted the task on 2026-09-24; the accepted per-file classification, loader and editor warnings, and operator delivery are now implemented and independently accepted.
- **Closing verdict:** Closed after tolerant optional fields and strict authority/required-feature boundaries passed their regressions, including source-preserving editor writes and visible reload warnings.
- **Closure evidence:** Configuration plan checkpoint; independent Grok actual-diff review in temp/changes/202609241200000001-configuration_tolerant_reader/grok-review-final.txt; configuration oracle 11/11, focused NanoCore configuration 45/45, config-schema 47/47, and Web ConfigurationScreen 12/12 tests.

## [deferred] GOVLAND-FND-009 — Specification bodies need normalization

- **Observation:** The writing rules and specification kinds landed in this plan do not yet hold for existing bodies. 31 specifications exceed the 6,000-word split-review trigger, the largest at 51,231 words; 7 specifications carry 96 file-and-line citations in normative text; 5 specifications keep Amendment sections; 13 mechanism specifications are not yet in question-and-registry form; several kind classifications were low-confidence.
- **Impact:** Agents keep reading whole oversized documents, line citations drift silently, and concept semantics stay inside mechanism specifications.
- **Evidence:** Word and citation counts over docs/specs/ on 2026-09-24; the kind classification in temp/changes/202609231611190001-engineering_governance_landing/.
- **Owner:** docs/changes/202609241200000002-documentation_normalization/plan.md; no receiver has accepted it.
- **Next action:** Moved outside this plan by the engineer's instruction of 2026-09-24 to plan the other landing tasks. The documentation normalization plan starts when the engineer transfers it.

## [deferred] GOVLAND-FND-010 — The new governance framework is not yet evaluated

- **Observation:** The engineer wants several maintenance rounds after this revision to judge whether the new framework is better, at least through code review. No rebuild probe, discovery probe, or framework comparison has run.
- **Impact:** Without registered predictions and a comparison the revision's value remains an assumption.
- **Evidence:** temp/quality-governance/discussion-log.md, topic ten and ruling R-009.
- **Owner:** docs/changes/202609241200000003-governance_framework_evaluation/plan.md; no receiver has accepted it.
- **Next action:** Moved outside this plan by the engineer's instruction of 2026-09-24 to plan the other landing tasks. The evaluation plan starts when the engineer transfers it.

## [deferred] GOVLAND-FND-011 — DeepSeek Harness dispatch is unverified

- **Observation:** DeepSeek Harness loads project AGENTS.md and delegates through model-facing subagent tools, but no project-scoped named agent directory was found, so docs/agent-harnesses.md lists it under prompt dispatch without a verified model binding.
- **Impact:** A dispatch through it could bind a role to an unverified model or miss the role contract.
- **Evidence:** Inspection of its public repository on 2026-09-23, recorded in this plan's checkpoint.
- **Owner:** docs/agent-harnesses.md; no receiver has accepted it.
- **Next action:** Moved outside this plan by the engineer's instruction of 2026-09-24. Verify dispatch and the tier binding the first time work is dispatched through DeepSeek Harness, and update docs/agent-harnesses.md.

## [deferred] GOVLAND-FND-012 — Platform references are a six-member enumeration

- **Observation:** This plan added the glossary, the writing guide, and the harness reference as platform references, bringing the enumerated set in docs/documentation-model.md and scripts/validate-doc-model.mjs to six. They were kept out of the governance set to avoid its fourth-member promotion rule, which the engineer accepted under GOVLAND-FND-013.
- **Impact:** Each new platform reference edits the model and the validator; a directory would make membership additive.
- **Evidence:** The platform reference list in docs/documentation-model.md and its validator constant as landed.
- **Owner:** docs/documentation-model.md; no receiver has accepted it.
- **Next action:** Moved outside this plan by the engineer's instruction of 2026-09-24. Decide between the enumeration and a directory when a seventh platform reference is proposed.

## [closed] GOVLAND-FND-013 — Role contracts and the glossary depart from their accepted governance type

- **Observation:** Ruling R-007 accepted recommendation 6a, which placed role contracts under docs/roles/ as governance documents, and the topic-nine recommendation accepted by R-008 placed the glossary under docs/ as a governance document. The landing instead made role contracts their own type ranked below governance and made the glossary a platform reference, because the documentation model promotes governance into a docs/governance/ directory at its fourth member, and following the accepted classification would move the three governance documents and every link to them. The writer chose this without an engineer decision.
- **Impact:** The type decides precedence: as governance, a role contract would rank with change execution instead of below it, and the glossary would carry governing authority over terms. A classification change is a governing documentation decision that the engineer owns.
- **Evidence:** temp/quality-governance/discussion-log.md, recommendation 6a with ruling R-007 and the glossary placement paragraph of topic nine with ruling R-008; the Governance Documents, Role Contracts, and Platform References sections of docs/documentation-model.md as landed; the independent review of 2026-09-24, finding R1-01.
- **Owner:** The engineer, for docs/documentation-model.md.
- **Next action:** Present both options at this plan's report: keep the landed types, recorded as a new decision with this reason; or follow the accepted classification, which promotes governance into docs/governance/ with the role contracts and the glossary as members. The writer recommends keeping the landed types, because a role contract applies governance rather than adding to it, and a glossary owns meanings rather than rules.
- **Closing verdict:** Recorded disposition: on 2026-09-24 the engineer accepted the writer's recommendation to keep the landed types. Terminal disposition: docs/decisions/20260924-role_contracts_and_glossary_types.md records the decision and its reason, superseding the governance classification in rulings R-007 and R-008.
- **Closure evidence:** docs/decisions/20260924-role_contracts_and_glossary_types.md; the Governance Documents, Role Contracts, and Platform References sections of docs/documentation-model.md.

## [closed] GOVLAND-FND-014 — Agents as Workspace members has no owner statement

- **Observation:** On 2026-09-24 the engineer stated that an agent woken into or joining a Workspace, including a worker, is also a member of that Workspace, that people and agents should receive finer permissions, and that each worker's permissions may differ, with the Policy Kernel later governing every place that needs permission. docs/core/identity.md defines a Workspace membership as a user's membership, and docs/specs/20260715-multi_user_workspace_system.md requires membership rows to reference human users; docs/core/permissions.md already evaluates an agent action with the agent identity and the responsible user but does not own membership.
- **Impact:** The direction lives only in the reason of docs/decisions/20260924-member_permissions_await_policy_kernel.md. Until an owner states it, a membership or permission change could harden the human-only membership model the engineer wants to keep open, or could equate agents with user records without a design.
- **Evidence:** The engineer's answer of 2026-09-24; the membership definition in docs/core/identity.md and the membership section of docs/specs/20260715-multi_user_workspace_system.md as of 2026-09-24.
- **Owner:** docs/core/identity.md and docs/specs/20260715-multi_user_workspace_system.md, with the engineer for the design.
- **Next action:** Ask the engineer whether the direction should now be written into Core identity as a stated future direction that current membership design must not preclude, or be handed to a later permission design; in either case agent membership lifecycle is designed in its own change, not in this landing.
- **Closing verdict:** Recorded disposition: on 2026-09-24 the engineer asked that the complete design idea be recorded, adding that the product Orchestrator will grant permissions to the workers it dispatches. Terminal disposition: docs/decisions/20260924-agents_are_workspace_members.md records it, and docs/core/identity.md and docs/core/permissions.md state it as a direction current design must not preclude; agent membership lifecycle remains its own future change.
- **Closure evidence:** docs/decisions/20260924-agents_are_workspace_members.md; the WorkspaceMember paragraph of docs/core/identity.md; the finer-permissions sentence of docs/core/permissions.md.

## [closed] GOVLAND-FND-015 — Complete work-data export still omits restricted original bodies

- **Observation:** The export posture landed on 2026-09-24 in docs/specs/20260921-work_data_retention_format.md says that every retained work-data family is exported completely with no privacy or sensitive-information filtering, but docs/specs/20260704-workspace_backup_export_import.md leaves body inclusion to the existing evidence export policy, and the implementation exports restricted original bodies as expired, reference-free records and rejects portable bodies on import unless they are expired and reference-free.
- **Impact:** A conforming export can omit the original content the engineer asked to keep complete, so the two owners and the implementation disagree about what a complete export contains.
- **Evidence:** The body-inclusion sentence of the work observation portability section in docs/specs/20260704-workspace_backup_export_import.md; apps/nanocore/src/storage/workspace-export.ts and apps/nanocore/src/storage/workspace-import.ts and the test apps/nanocore/src/storage/workspace-export-observations.test.ts, which pin the omission; independent review round four on 2026-09-24.
- **Owner:** The engineer for the scope; docs/specs/20260704-workspace_backup_export_import.md and the evidence owner for the rule; the implementation change that follows.
- **Next action:** Ask the engineer whether restricted original bodies travel in a portable export. If they do, amend the backup/export owner's body-inclusion rule, keep the audience exclusions and system secret exclusions, and hand the export, import, and test change with a regression that a restricted original body round-trips intact to a planned change; if they do not, narrow the export posture sentence to say so.
- **Closing verdict:** Recorded disposition: on 2026-09-24 the engineer decided that restricted original bodies travel intact in a portable export and that import restores them intact, so a re-imported Workspace keeps complete information. Terminal disposition: docs/decisions/20260924-restricted_bodies_travel_in_export.md records it, the backup/export and retention owners state it, and the implementation is handed to docs/changes/202609241200000004-complete_work_data_export/plan.md.
- **Closure evidence:** The work observation portability section of docs/specs/20260704-workspace_backup_export_import.md and the export posture paragraph of docs/specs/20260921-work_data_retention_format.md; the planned bundle 202609241200000004-complete_work_data_export; the documentation-model validator passes.
