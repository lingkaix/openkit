---
date: "2026-11-15"
---
# Independent Documentation Audit: Work-Model Group

This non-authorizing record holds the work-model group of round 2 of the [independent documentation audit](20261023-independent_doc_audit.md). Its owning rule is [Change Execution Governance](../change-execution.md). It records observations, dispositions, and questions. It does not authorize design.

## Scope And Base

- Group base SHA: `3cd345759782795e388abd73974a8f2aa8ea7ec0` (`main` on 2026-11-15). Issue #440 releases this group, and the round-2 inventory adds the conversation timeline specification (P0-G4-16).
- Core document: `docs/core/work-model.md` (WM).
- Specifications: `20260704-chat_mode_assistant.md` (CMA), `20260704-task_mode_worker_delegation.md` (TMD), `20260531-human_attention_intervention_model.md` (HAI), `20260713-work_resource_interaction_model.md` (WRI), `20261017-evaluation_foundation.md` (EVF), `20261002-goal.md` (GOAL), `20260902-agent_runtime_context_compaction.md` (ACC), `20260831-unified_conversation_composer.md` (UCC), and `20261108-conversation_timeline.md` (CTL).
- Cited records read: the [Quick Chat retirement](../decisions/20261016-retire_stateless_quick_chat.md), [shared conversation](../decisions/20261015-shared_conversation_and_single_agent_threads.md), [private Assistant timeline](../decisions/20261015-private_assistant_timeline_and_rolling_context.md), [Pre-Release SQL Baselines](../decisions/20261114-pre_release_sql_baselines.md) and [conversation timeline rulings](../decisions/20261108-conversation_timeline_rulings.md) decisions.
- G3 inspection: eleven read-only inspector contexts (CMA, TMD, HAI, WRI in two ranges, GOAL, ACC, CTL in two ranges, and EVF with UCC). They read code only and ran no tests. The auditor verified each kept finding against the code at the base SHA.

## G2 Core Against Specifications

- WM-G2-01: WM (Task) and TMD (line 241) say that an authorized Coordinator request continues the same Task on a new Turn when the Task was admitted under a Goal. GOAL says that a Coordinator request is one more source of Task admission and does not exclude continuation. The code has no continuation path: `goal.task.dispatch` always creates a new Task Thread. This is not a Core-specification conflict but a missing code path. Issue #746.
- WM-G2-02: WM (Personal Workspace) says that existing Quick Chat data moves one way into the personal Workspace, citing the 2026-10-15 private Assistant timeline decision. The accepted [Personal Workspace specification](../specs/20260715-multi_user_workspace_system.md#personal-workspace) records a later engineer ruling of 2026-10-16 that removes conversion of pre-`v0.1.0` `quick-chat` data. No decision record holds that ruling, and the Core text is a meaning change. Question Q-243.
- WM-G2-03: WM requires one finalized Coordinator reference Item for each admitted Goal worker execution (runtime-model RT-G2-03). GOAL and the code write only a `goal_card_tasks` row. Existing issue #623.
- WM-G2-04: [Core concepts](../core/core-concepts.md) (a conversational Thread has exactly one addressee for its whole life) and the shared conversation decision (one agent per Chat Mode Thread) conflict with UCC and the code, which let one conversation Thread address the Assistant and the Knowledge Manager. Question Q-231.
- WM-G2-05: Placement of CTL under WM is confirmed: the timeline presents work-model objects and defers publication to the Web projection.

## G3 Specifications Against Implementation

| Finding | Clause | Evidence (at the group base SHA) | Adjudication | Action |
| --- | --- | --- | --- | --- |
| WM-CMA-01, -05 | CMA routing outcomes and the closed `resultKind` list name `approval-required` and repository answers and omit `worker-turn`, `goal-intent`, `goal-steering` and `accepted` | `packages/app-api-schemas/src/chat-mode.ts:152-159`; `apps/nanocore/src/storage/command-request-codecs.ts:58-70`; the CMA `resultRole` table matches the code | Internal contradiction; no later record decides | Question Q-230 |
| WM-CMA-02 | CMA: persistence failure returns `chat_mode_persistence_failed` | `apps/nanocore/src/mode-entry-routes.ts:4372-4375` returns `chat_mode_failed` | Code differs from a current accepted document | Issue #730 |
| WM-CMA-03 | CMA: "The Core Assistant is the only agent in every private or shared Chat Thread." | UCC (Target Dispatch) and `mode-entry-routes.ts` admit the `knowledge-manager` target in the originating Thread | Accepted documents and a decision disagree | Question Q-231 |
| WM-CMA-04 | CMA Assistant Tool boundary | CMA (lines 17, 52, 126, 138, 150, 497) and the [Gateway MCP hosting decision](../decisions/20261002-hosting_through_gateway_mcp.md) let the Assistant use a selected Gateway vendor MCP read Tool; `apps/nanocore/src/internal-agents/assistant-tools.ts` and both Tool construction sites (`apps/nanocore/src/mode-entry-routes.ts:3910`, `:4881`) supply none | Code differs from a current accepted document | Projection sentence added; issue #743 (#170 and #144 do not cover it) |
| WM-CMA-06 | CMA: the Assistant may propose a Thread for a Tool from another entry | No producer | Existing issue | #630 |
| WM-CMA-07 | CMA: shared conversation implementation waits until after `v0.1.0`; CMA also describes shared entries as current | `apps/nanocore/src/thread-routes.ts` creates Workspace-shared conversation Threads | Undecided | Question Q-232 |
| WM-CMA-08, -09 | CMA `thread.share` name; frontmatter `updated` | Concept name only; Git history | Metadata and naming | No action |
| WM-TMD-01 | TMD: the readable initiating request projection | `apps/nanocore/src/thread-dashboard.ts:379,385` always return an empty `taskInputs`; `projectThreadTaskInputs` has no production caller | Code differs from a current accepted document | Issue #728 |
| WM-TMD-02 | TMD: a `continue` outcome returns `task_stop_decision_invalid` | The code path is unreachable, not rejected | Unreachable rule | No action |
| WM-TMD-03, WM-WRI-B-01 | TMD lists seven completion states; WRI closes the `material` shape | `escalated-to-goal` (`packages/app-api-schemas/src/task-mode.ts:31-40`) and `activeDelivery` (always null) have no producer | Code differs from a current accepted document | Issue #729 |
| WM-TMD-04 | TMD: "the configured queue bound" | Literal 20 | Undecided | Runtime-model Question Q-216 |
| WM-TMD-05 | TMD (line 83): the canonical input hash covers the optional `logicalModelId` | `packages/app-api-schemas/src/task-mode.ts:18` names `modelId`, and the hash input uses it (`apps/nanocore/src/mode-entry-routes.ts:5153-5159`) | Code differs from a current accepted document | Issue #745 |
| WM-TMD-08 | TMD calls a `conversation.submit` worker delegation a handoff | `mode-entry-routes.ts` builds the worker request inline with defaults that differ from the direct-Task defaults | Undecided | Question Q-233 |
| WM-TMD-06 | TMD: no adapter is qualified by source inspection alone | Two pins are enabled; qualification evidence is outside source | Not a contradiction | No action |
| WM-TMD-07, WM-WRI-A-01 | Tracker labels S04, S05, S15, S16, S51 and P14 used as references | No definition document for S04, S05, S15, S16 and P14 | G5 navigation | Question Q-244 |
| WM-HAI-01, -02, -10 | HAI: "Pending input is not a row kind" and current row kinds include budget and external side effect; candidate row fields | `apps/nanocore/src/action-center.ts:827` emits `pending_input`; `budget`, `external_side_effect` and `review_cap` have no producer; the shipped row has seven more members | Internal contradiction and undecided row set (held M7-G23) | Question Q-234 |
| WM-HAI-03, -08 | HAI: the secret-question reason text; checkpoint rows expose request-human guidance and disabled resume | `apps/nanocore/src/action-center.ts:751`, `:1043-1056` | Code differs from a current accepted document | Issue #733 |
| WM-HAI-04, -05, -06 | HAI mapping names `apps/web/src/App.tsx` (a 12-line wrapper of `AppRoutes`, so an indirect path) and earlier operation paths | The dispatcher serves `attention.list` (`apps/nanocore/src/conversation-operation-implementations.ts`), the Artifact Review operations (`apps/nanocore/src/artifact-operations.ts`) and `sync.review-decide` (`apps/nanocore/src/runtime/workspace-sync-operations.ts`); the Web route is in `apps/web/src/app/routes.tsx` | Projection drift | Corrected |
| WM-HAI-07 | HAI: pending-user-turn residue removed | See runtime-model RT-WTR-05 | Code differs | Issue #726 |
| WM-HAI-09 | HAI source list | `action-center.ts` also projects `workspace_recovery` and `worker_control_rejection` rows, and unresolved scheduler execution attempts (`schedulerOrphanWorkerRows`, source `execution_attempt`, `apps/nanocore/src/action-center.ts:788`, `:905-933`) | Projection drift | Sources added |
| WM-GOAL-01 | GOAL: "Storage migration drops" the retired Goal tables | No migration drops them; the fresh `0000_baseline` omits them (`apps/nanocore/src/storage/goal-cutover-migration.test.ts`); the physical epoch cutover drops `pinned_goal_id` | Document outdated by the Pre-Release SQL Baselines decision | Corrected and cited |
| WM-GOAL-02 | GOAL Coordinator reference Item | See WM-G2-03 | Existing issue | #623 |
| WM-GOAL-03 | See WM-G2-01 | `apps/nanocore/src/runtime/task-admission.ts:159-188` derives a new Thread per request; the Coordinator Tool set (`apps/nanocore/src/runtime/goal-coordinator.ts:156-180`, `:663-688`) has no continuation path | Code differs from current accepted documents | Issue #746 |
| WM-GOAL-04 | GOAL: the person keeps the intent; the Coordinator calls the same operations under the same checks | `goal.intent.revise` admits the `coordinator` credential, and history names the responsible person as actor | Undecided | Question Q-236 |
| WM-WRI-A-02 | WRI: one configurable server reserve protects free space | Restore and MOVE use the literal default | Code differs from a current accepted document | Issue #731 |
| WM-WRI-B-02, -03, -04 | WRI closed public shapes and the Phase 1 command table omit `rangeFeedback`, `candidateSelections`, `judgements`, `artifact.review.select` and `material.range-correct` | The same document and EVF define these members and commands, and code has them | Internal contradiction resolved by the same accepted owner | Lists corrected; the command table gains one sentence |
| WM-WRI-B-05 | WRI exact Review fields | A stored `read_goal_id` column is outside the list | Undecided: derived attention scope or field | Question Q-237 |
| WM-ACC-01, -05 | ACC: the Knowledge Manager selects `openkit` Gateway compaction; ACC also says that OpenKit compaction keeps a `context-summary` Item; summary chain member | Code compacts Knowledge Manager context in the shared loop with no Gateway control; `previousSummary` exists in `packages/protocol/src/models/item.ts` | Internal contradiction | Question Q-238 |
| WM-ACC-02, -03 | ACC Gateway `context_management` control | No validation, injection, compactor or `invalid_context_management` exists | Stated as Partial; projection did not say so | Projection sentence added; existing #125 tracks the internal-role compactor |
| WM-ACC-06 | ACC adapter set | DeepSeek is a fourth resident adapter | Projection drift | DeepSeek added |
| WM-ACC-04, -07, -08 | Frontmatter; fixture version wording; "target shape" wording | Git history; test fixture | G5 | Question Q-244 |
| WM-CTL-A-01, WM-CTL-B-05 | CTL (Contract): "The fixed bounds are documented with the implementation; this specification does not claim that those bounds have landed"; the projection does not state the exact-or-null unread cut | `apps/nanocore/src/thread-timeline.ts:412-466` enforces 32 Turns, 128 positions and 65,536 body bytes and returns null at a bound | Status clause false; the contract deliberately leaves the bound values to the implementation | The contract sentence keeps "The fixed bounds are documented with the implementation" and loses the status clause; the History reads projection bullet states the landed values |
| WM-CTL-A-02, -03 | CTL registry table rows and disclosure values | The `plan` row is `folded` in the registry data; the table uses values outside its own vocabulary | Undecided: table or data | Question Q-242 |
| WM-CTL-A-04 | CTL Decision 7 adds a handoff toast that the rulings record does not state | Code has the toast | Decision record incomplete; decision records are not edited | Question Q-242 |
| WM-CTL-B-01 | CTL projection: a Turn error is `{code, message}` | `TurnErrorSchema` has an optional `explanation` and a nullable `code` (`packages/protocol/src/models/turn.ts:99`); `ProductTurnErrorSchema` adds an optional server `presentation` (`:130`) | Projection drift | Corrected |
| WM-CTL-B-02 | CTL: the desktop stream closes two minutes after hiding | The stream closes when hidden | Undecided | Question Q-242 |
| WM-CTL-B-03 | CTL Open Questions: plan-segment counts | The server computes plan segments (`readTimelinePlanSegments`, called from `apps/nanocore/src/thread-timeline.ts:608`) | Answered by landed code | Note added; the question text is kept |
| WM-CTL-B-04, -06 | CTL rollout tier names and a concept name | Names only | G5 | Question Q-244 |
| WM-CTL-B-07 | CTL resolver table names `/settings/server-audit` and the `item` and `request` anchors | The resolver returns no server-audit target and reads `approvalRequest` and `userInputRequest` | Projection drift | Corrected |
| WM-UCC-01 | UCC (lines 75, 168): "`goal-orchestrator` remains the wire discriminator for the Goal target" | The wire kind is `goal-coordinator` (`packages/app-api-schemas/src/chat-mode.ts:47`; `apps/nanocore/src/mode-entry-routes.ts:2620-2621`); Core concepts governs the role name, not the wire value | Code differs from a current accepted document | Issue #744 |
| WM-UCC-02, -03, -04 | UCC interface omits envelope members and the file handoff confirmation, and names a default target owner that defines nothing | `packages/app-api-schemas/src/chat-mode.ts`; default chosen in `mode-entry-routes.ts` | Undecided (held M7-G24) | Question Q-239 |
| WM-UCC-05 | No owner covers dictation | A dictation operation and control exist | Undecided | Question Q-240 |
| WM-UCC-06 | UCC `target_busy` vs CTL `409 thread_busy` for input during a Turn | Code gives `target_busy` only for a busy Worker; no in-flight check on the Assistant path (held M7-G34) | Accepted documents disagree | Question Q-241 |
| WM-UCC-07, WM-EVF-01 | Frontmatter `updated`; EVF `implementation` value | Git history; every EVF behavior has code and no gap is stated | Status clarity | Question Q-244 |

## Held G1 Probe Findings

| Items | Verdict | Disposition |
| --- | --- | --- |
| M1-G26, M7-G07 | Stand | Question Q-243 |
| M7-G08 | Resolved: WRI and EVF derive `candidateSelections` from judgements, and no selection column exists | No action |
| M7-G14 | Resolved: CMA gives semantic choice to the Assistant, and WM agrees | No action |
| M7-G20 | Resolved: TMD has one steer outcome table, and code returns `accepted` or a typed 409 | No action |
| M7-G18 | Partly | Issue #746 |
| M7-G23 | Stands | Question Q-234 |
| M7-G24, M7-G34 | Stand | Questions Q-239 and Q-241 |
| M7-G26, M7-G35 | Partly: GOAL names the operations and Coordinator Tools; Coordinator revision of intent is open | Question Q-236 |
| M7-G27 | Partly | Question Q-230 |
| M1-G28, M7-G01, M7-G02, M7-G03, M7-G05, M7-G09, M7-G19, M7-G21, M7-G33 | Partly or stand: record members, id prefixes, limits and statuses exist in code only | Round-1 Question Q-01 (delegated sweep) |

## G4 Organization

No move, merge, or split is applied. CTL stays under WM (WM-G2-05).

## G5 Writing

Tracker labels, frontmatter dates, rollout names and fixture-version wording are recorded in Question Q-244.

## Semantic Preservation

| File | Normative sentences | Other sentences | Numbers | Backticked identifiers | Headings | Links |
| --- | --- | --- | --- | --- | --- | --- |
| HAI | 119 unchanged | 418 unchanged, 3 changed | 10 unchanged | 116 unchanged, 1 removed, 10 added | 60 unchanged | 20 unchanged |
| CMA | 175 unchanged | 650 unchanged, 1 changed | 21 unchanged | 143 unchanged, 1 added | 47 unchanged | 30 unchanged |
| WRI | 280 unchanged, 1 changed, 1 moved in | 750 unchanged, 1 moved out, 1 added | 33 unchanged | 291 unchanged | 68 unchanged | 29 unchanged |
| ACC | 99 unchanged | 385 unchanged, 1 changed, 1 added | 26 unchanged | 89 unchanged | 39 unchanged | 20 unchanged |
| GOAL | 58 unchanged | 535 unchanged, 1 changed | 10 unchanged | 58 unchanged, 1 added | 55 unchanged | 21 unchanged, 1 added |
| CTL | 128 unchanged | 842 unchanged, 5 changed, 1 added | 86 unchanged, 3 added | 127 unchanged, 2 removed, 10 added | 49 unchanged | 66 unchanged |

WM, TMD, EVF and UCC are unchanged.

- WRI: the `WorkspaceMaterialRevisionSummary` and `ArtifactReviewView` closed lists gain the members that the same document and EVF define; no member is removed. The inventory script counts the corrected `ArtifactReviewView` sentence as normative ("moved in"); before the correction it counted it as another sentence ("moved out"). The added sentence after the command table keeps the inputs that WRI defines for `rangeFeedback`, `material.range-correct` and `artifact.review.select`.
- HAI: the removed identifier is `apps/web/src/App.tsx`, an indirect path; the route is in `apps/web/src/app/routes.tsx`. The source list gains `execution_attempt`.
- CTL: the removed identifiers are the stale `{code, message}` error shape and the `request` anchor name (the word `request` still occurs elsewhere in CTL, so only the anchor use is gone); the resolver table no longer lists `/settings/server-audit`, which the code never returns. The contract sentence on `earlierUnread` loses only its false status clause, so the contract still leaves the bound values to the implementation. The added numbers are the landed bounds in the History reads projection bullet. The Open Questions bullet is kept and gains one sentence.
- No acceptance item, heading or link was removed, and no file moved.

## Issues Opened

- #728 `[task-mode] The Thread dashboard always returns an empty taskInputs list`, low.
- #729 `[work-model] Remove unproduced public members: escalated-to-goal Task state and Thread material activeDelivery`, low.
- #730 `[chat-mode] Persistence failure returns chat_mode_failed instead of chat_mode_persistence_failed`, low.
- #731 `[storage] Workspace restore and MOVE ignore the configured file reserve`, blocking candidate (recovery).
- #733 `[action-center] Checkpoint rows lack the request-guidance and disabled resume actions, and the secret-question row uses another reason`, low.
- #743 `[chat-mode] The Assistant has no selected Gateway vendor MCP repository read Tool`, low to medium.
- #744 `[composer] The Goal target wire kind is goal-coordinator, but the Composer specification fixes goal-orchestrator`, low.
- #745 `[task-mode] The direct Task request and its input hash use modelId, but the Task Mode specification fixes logicalModelId`, low.
- #746 `[goal] A Coordinator request cannot continue a Goal Task on a new Turn`, low to medium.
- Existing #623, #630 and #726 cover WM-G2-03, WM-CMA-06 and WM-HAI-07; existing #125 covers the internal-role compactor (WM-ACC-02, -03).

## Questions For The Engineer

### Q-230. What is the closed Chat routing outcome set?

- Context: CMA (Routing outcomes and replay) names `approval-required` and repository answers and omits `worker-turn`, `goal-intent`, `goal-steering` and the public `accepted` outcome. The CMA `resultRole` table and the code have the second set and no `approval-required`. No Assistant Tool needs an approval in the current Tool set.
- Options: (A) Align the closed lists with the `resultRole` table and the code. (B) Keep `approval-required` and open an issue to implement it.
- Recommendation: A, and keep `approval-required` as a future outcome only when the Assistant gets a governed Tool.
- Meanwhile: no change.

### Q-231. May a Chat Thread address the Knowledge Manager?

- Context: CMA and the shared conversation decision say that the Assistant is the only agent in a Chat Mode Thread, and Core concepts says that a conversational Thread has exactly one addressee for its whole life. UCC admits the `knowledge-manager` target in the originating Thread, and the code does so.
- Options: (A) The Knowledge Manager target opens its own Thread. (B) Amend the decision and WM to allow a second internal agent in a Chat Thread.
- Recommendation: A, because one addressee per Thread is a Core rule and an accepted decision; the change is in UCC and code.
- Meanwhile: no change.

### Q-232. Does shared conversation wait until after `v0.1.0`?

- Context: CMA says that shared conversation implementation waits, and also describes shared entries as current. The code lets a team Workspace member create a Workspace-shared conversation Thread and address the Assistant.
- Options: (A) Gate shared conversation creation off for `v0.1.0`. (B) Accept the landed behavior and state it.
- Recommendation: A, because the decision defers it, the timeline for shared chat is an open item (#647), and #247 tracks shared conversation Threads in team Workspaces after `v0.1.0`.
- Meanwhile: no change.

### Q-233. Which defaults does a Task handoff use?

- Context: TMD calls a `conversation.submit` worker delegation a handoff, but the code builds that request inline with defaults that differ from the fixed direct-Task defaults. The field name is issue #745.
- Options: (A) TMD states the handoff defaults. (B) The code adopts the direct-Task defaults.
- Recommendation: B, so that one Task request shape exists.
- Meanwhile: no change.

### Q-234. What is the closed Action Center row kind set?

- Context: HAI says that pending input is not a row kind but lists it as a candidate kind, and the code emits it for queued admissions. HAI calls budget and external side effect current kinds and also lists budget decisions as a gap; `budget`, `external_side_effect` and `review_cap` have no producer. The shipped row has seven members that the candidate fields omit.
- Options: (A) HAI states the produced kinds and members as the contract and removes the unproduced kinds. (B) Keep the candidate set and implement the producers.
- Recommendation: A, with a code issue to remove the unproduced kinds after the engineer rules.
- Meanwhile: no change.

### Q-235. Does a Coordinator request continue a Goal Task on a new Turn?

- Withdrawn after the independent review. WM and TMD decide that a Coordinator request continues the same Task, and GOAL does not exclude it, so the gap is a code defect: issue #746.

### Q-236. May the Coordinator revise the person's Goal intent?

- Context: GOAL says that the person keeps the intent, and that the Coordinator calls the same operations as a person under the same checks. `goal.intent.revise` admits the Coordinator credential, and history names the responsible person as actor. `goal.create` and `goal.cancel` exclude the Coordinator.
- Options: (A) Exclude the Coordinator from `goal.intent.revise`. (B) Allow it and attribute it to the Coordinator.
- Recommendation: A, because intent stays with the person.
- Meanwhile: no change.

### Q-237. Is the Review `read_goal_id` column a field?

- Context: WRI and the storage layout owner list the exact Artifact Review fields. The table also stores `read_goal_id`, a derived Goal attention scope.
- Options: (A) State it as a derived index column outside the retained tuple. (B) Add it to the exact fields.
- Recommendation: A.
- Meanwhile: no change.

### Q-238. Does the Knowledge Manager use Gateway compaction?

- Context: ACC says that the Knowledge Manager selects `openkit` and uses OpenKit compaction under the Gateway control, and also that OpenKit compaction keeps a `context-summary` Item in the shared loop. The code does the second, and no Gateway control exists. The summary chain member `previousSummary` exists in code and is not named in ACC.
- Options: (A) The Knowledge Manager uses shared-loop compaction; the Gateway `openkit` authority covers other callers. (B) The Knowledge Manager moves to the Gateway compactor.
- Recommendation: A, and ACC names `previousSummary`.
- Meanwhile: no change.

### Q-239. Which Composer interface is the contract?

- Context: The interface omits `requiresFileHandoffConfirmation` and envelope members, types optional members as required, and does not name the 403 `file_handoff_confirmation_required` refusal. The default target owner that UCC names does not exist; the code chooses the Assistant, then `new-task-worker`, else 409 `conversation_target_not_configured`. The HTTP statuses of the target refusals are in code only.
- Options: (A) UCC adopts the code interface, names, statuses and default rule. (B) Change the code to the UCC interface.
- Recommendation: A. First-party wire formats carry no compatibility obligation, and the code shape is complete. The Goal target wire kind is issue #744.
- Meanwhile: no change.

### Q-240. Which owner covers dictation?

- Context: A dictation operation (`composer.transcribe`: `packages/app-api-schemas/src/composer-operations.ts`, `apps/nanocore/src/composer-transcribe-operations.ts`), a catalog member and a microphone control exist. [Core storage](../core/storage.md) (Agent Data Retention And Deletion) already says that a new capture path needs its existing authorization and owning contract and that captured raw audio is `restricted-raw`, so the retention class is decided. No specification or decision owns the path, which is against AUTH-003. Existing #307 covers governed transcription model access.
- Options: (A) UCC owns dictation as a Composer input. (B) A new specification owns it.
- Recommendation: A; only the owner placement is open.
- Meanwhile: no change.

### Q-241. What refusal does input to a busy Thread get?

- Context: UCC returns `target_busy` for a busy running Worker. CTL returns `409 thread_busy` for ordinary input during a Turn. CMA (line 76) says "One Turn per Thread applies; simultaneous requests queue." The Assistant and Knowledge Manager path has no in-flight check.
- Options: (A) One refusal `thread_busy` for every target while a Turn is in flight, with Task live steer as the only exception. (B) Keep target-specific refusals. (C) Queue simultaneous requests as CMA says.
- Recommendation: A, and open a code issue for the missing check after the ruling.
- Meanwhile: no change.

### Q-242. Which timeline registry values and hide delay are the contract?

- Context: The CTL registry table says that the registry is the single source of truth, but the `plan` row says "latest shown" and the data says `folded`, and several rows use values outside the table vocabulary. CTL says that the desktop stream closes two minutes after hiding; the code closes it at once. CTL Decision 7 adds a handoff toast that the rulings record does not state.
- Options: (A) The table follows the registry data and the code, and the toast exception is confirmed. (B) The code follows the table.
- Recommendation: A.
- Meanwhile: no change.

### Q-243. Does the one-way Quick Chat data move still apply?

- Context: WM says that existing Quick Chat data moves one way into the personal Workspace, citing the 2026-10-15 decision. The accepted Personal Workspace specification records the engineer ruling of 2026-10-16 that removes conversion of pre-`v0.1.0` `quick-chat` data under the prerelease reset boundary, but no decision record holds that ruling. The code still derives the personal Workspace id from the former name (`apps/nanocore/src/lib/store.ts:1021`).
- Options: (A) Record the 2026-10-16 ruling as a decision record and remove the move sentence from WM. (B) Keep the move and state it in the Personal Workspace specification.
- Recommendation: A.
- Meanwhile: no change.

### Q-244. May the work-model writing cleanups be applied?

- Context: TMD and WRI use undefined tracker labels (S04, S05, S15, S16, P14); several frontmatter `updated` dates predate their content; ACC keeps "target shape" for an implemented shape and a fixture version that differs from the test; CTL uses rollout and concept names that do not exist in code; EVF keeps `implementation: Partial` with no stated gap.
- Options: (A) Apply the cleanups. (B) Keep the text.
- Recommendation: A, under the round-1 delegated sweep for labels and history wording.
- Meanwhile: no change.

## Independent Review

One fresh reviewer read the group diff, this record and the claim inventory against the base SHA. It confirmed the WRI closed lists and the command-table sentence, the CTL `earlierUnread` values, resolver anchors and plan-segment note, the GOAL baseline sentence, the HAI paths, the ACC and CMA sentences, the issue titles and the Q-243 disposition. It returned eight findings; the auditor verified each against the base SHA and applied all of them:

- The first `earlierUnread` correction put code constants into the CTL contract. The contract sentence now keeps the deliberate deferral and loses only its status clause; the values are in the History reads projection bullet.
- WM-CMA-04 is a code gap against current accepted text: issue #743.
- WM-UCC-01 and WM-TMD-05 are decided by explicit accepted wire names: issues #744 and #745. Questions Q-233 and Q-239 keep only the undecided parts.
- WM-G2-01 misstated GOAL. GOAL does not exclude continuation, and WM and TMD decide it, so the gap is in code: issue #746. Question Q-235 is withdrawn.
- The HAI source list now includes `execution_attempt`.
- The CTL Turn error sentence now states the optional `explanation`, the nullable `code` and the optional `presentation`.
- Question Q-240 now cites the Core storage capture rule and states that only the owner placement is open.
- Record accuracy: WM-CTL-B-05 is restated, the WRI and CTL inventory rows are recounted, `apps/web/src/App.tsx` is called an indirect path, and Question Q-241 cites CMA line 76.

## Checks

At commit time: `node scripts/validate-doc-model.mjs` passed, `node scripts/generate-doc-index.mjs` regenerated `docs/INDEX.md`, `pnpm check:repo` passed, and the content scan of the staged diff found no email, token, credential path, private host, local absolute path or Vietnamese text.
