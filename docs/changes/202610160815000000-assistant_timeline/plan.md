---
type: change-plan
status: in-progress
---
# Personal Assistant Integration

## Intent Revision 1

The engineer assigned lane L-AK the P19, P20 and P26 packages on 2026-10-16, in that order, and authorized the lane to land complete feature increments. P19 delivers the accepted private Assistant Timeline, ordinary owner-only personal Workspace, durable rolling context, current-audience history retrieval and semantic Task/Goal handoff. It preserves command replay, pending-request continuations and current identifier APIs. This change starts with Timeline admission and personal Workspace capability. It grants no host administration or release publication.

## Accepted Owners

- [Chat Mode And Core Assistant](../../specs/20260704-chat_mode_assistant.md).
- [Personal Workspace](../../specs/20260709-quick_chat_workspace.md).
- [Thread Visibility And Sharing](../../specs/20260909-thread_visibility_and_sharing.md).
- [Internal Durable Rolling Context](../../specs/20260902-agent_runtime_context_compaction.md#internal-durable-rolling-context).
- [Unified Conversation Composer](../../specs/20260831-unified_conversation_composer.md).

## Checkpoint

The branch implements singleton private Timeline admission, ordinary owner-only personal Workspaces, stateless entry retirement, the complete ordinary Tool set, exact human-selected Task/Goal handoff, source-bound rolling context and bounded exact history. Older Items remain canonical and retrievable. Shared command/pending, administration and Goal Coordinator context uses the existing Provider, accounting and budget owners. No new transcript store, runner or checkpoint owner exists.

Primary integrates main through a744277b, including the documentation-only L-RT landing. P14 remains a prerequisite. The local unpushable preparation branch now cleanly includes the latest P14 candidate74914814 and the bounded P19 identifier/S39 corrections. Matching dependency builds, seven complete native regression files264/264 and NanoCore typecheck passed before that final fixture-only P14 merge; these are preparation results, not a primary gate or approval. The historical mixed-source diagnostic failures remain recorded below. Original review findings are independently reclassified; all blocking source corrections are prepared or committed. Final primary regeneration, exact-head delta review and complete local gate remain outstanding. No feature acceptance is inferred from the local combination.

## Seam And Evidence

The first seam joins public thread.create to canonical Thread storage and restart. A separate gpt-6.1-sol test-author reads both owners and writes only personal-assistant-timeline.test.ts. Expected current failure: independent private creation commands produce different Threads, and the home kind is quick-chat. The second seam joins the canonical Workspace kind to capability and owner-only audience enforcement. The final independent review must inspect the actual complete origin/main..HEAD diff, including owner amendments, on the exact committed landing head.

## Next Action

Keep the completed P19 source ready while separate P20 increments continue on their own branches. After P14 lands, merge main, apply only the P19 identifier and source-proof corrections from the private preparation combination, regenerate every affected projection, refresh the out-of-area inventory and obtain independent exact-head approval. Express landing requires a pushed clean committed head, repository/lint/typecheck and complete affected-module suites plus Web e2e through the local gate before acquiring the landing window. Land and release promptly, then watch the containing main-push CI and repair or revert an owned failure immediately. Do not dispatch branch full CI for this express feature. No host acceptance or release publication is authorized.

## Intent Revision 2

The coordinator clarified on 2026-10-16 that shared integration files may be edited on lane/ak before the landing window; only landing is serialized. Finish P19 completely before first landing. Train 3 must be on origin/main first. Continue P20 on a local successor branch if P19 is ready before train 3 lands.

## Intent Revision 3

The engineer selected retirement of chat.quick on 2026-10-16 through the question channel. Preserve one-shot use through conversation.submit on the Timeline in the CLI and operations Skill, remove all former public projections and inverse tests, regenerate OpenAPI and bundled CLI before the landing window under the later Express ruling, and name the removed operation in release-facing landing evidence. The accepted rationale is recorded in Retire Stateless Quick Chat.

## Intent Revision 4

The engineer approved a source-bound canonical summary Item on 2026-10-16 through the question channel. Extend the existing Item and context owners additively. Bind each summary to its exact canonical source range and digests, verify sources and current authority before use, and keep exact history retrievable through the existing Assistant history Tool. Use the ordinary Provider path with usage, audit and failure accounting within the existing Assistant budget. A producer failure leaves the window unadvanced with a visible cause. Web and CLI show the covered range. No new store, runner or checkpoint owner is authorized.

## Intent Revision 5

The coordinator selected the approved P14 reset boundary for predecessor receipt-free Assistant Tasks on2026-10-16. Any retained bytes stay inspect-only as recovery_required, with no automatic resumption, fabricated confirmation, compatibility reader, separate P19 reset or carry-forward migration. The pre-stable continuity obligation has not started, and the already approved clean-candidate P14 reset owns this prerelease disposition. Add a no-resumption regression. The next prerelease notes must state this disposition as well as removal of chat.quick. P19 landing waits for the shared P14 identifier allocator; no parallel formatter or relaxed validator is authorized.

## Personal Work Admission Correction

Independent preparation review found that lifting the former personal Workspace capability guards also let ordinary Assistant requests create conversations on Workspace-visible work Threads. Chat and Visibility already prohibit shared conversations in personal Workspaces. The correction retains ordinary Task and Goal Threads, marks the Assistant unavailable on those personal work Threads, and refuses a fresh Assistant submission before inference or canonical Turn/Item publication. Existing exact receipt replay remains before fresh-command admission. The native regression creates an actual Goal in the personal Workspace, then expects the addressed Assistant request to fail while preserving the Goal Thread and its exact history. Its first run reached the intended200-versus409 failure in p19-personal-work-assistant-red.log; the independent two-Thread probe also observed two completed answers and two Provider calls. Final green and exact-head checks remain required.

## Current Regression Alignment

The complete broad diagnostic ran 6,790 NanoCore cases against changing source and dependencies and reported 61 failures. It is diagnostic evidence, not an exact-head gate. Old server cases still asserted the removed keyword classifier and former Quick Chat restrictions. The replacement exercises model answers for vague, work, search, retry and review language without implicit Worker effects; explicit Task and Worker admission in personal Workspaces; and model-proposed Goal work that waits for exact human selection before creating a shared execution Thread. Exact Task selection, restart, source/receiving lineage, changed pending payload, unavailable destination and predecessor no-resumption remain in the native semantic-handoff suite. New real SQL receipt removal and wrong-Thread pointer cases retain fail-closed replay without reinterpretation or another Provider/Worker call. Direct Task remote Git and failure-evidence tests remain. Current fixture corrections retain original Timeline names, the personal Workspace kind and name, the additive migration journal, valid predecessor digests and explicit private audience. No authority, source proof, receipt or failure criterion is waived.

The coordinator replaced branch full CI with express landing on 2026-10-16. Complete affected module suites and Web e2e, repository/lint/typecheck gates, independent exact-head approval, pushed backup and a green local-gate result remain mandatory before landing. After P14 lands, merge main and apply only P19 corrections from the private preparation combination. Never push or land that combination. The containing main-push CI remains mandatory after landing, with immediate reviewed repair or revert for an owned failure.

## Simplicity Ruling Of 2026-10-16

The engineer removes pre-stable home-to-personal conversion and predecessor qualification from this landing. Fresh personal Workspace initialization and the ordinary SQLite schema migration remain. The existing prerelease reset owner governs actual reset effects. Portability changes remain only because the existing import/export paths must understand new summary Items and history traces without losing current content. The coordinator retained the complete P19 increment after the four-hour/two-review escalation: splitting now costs more than it saves. Reclassify prior findings under Simplicity rule6, fix only reachable defects, accepted-owner violations, security defects or user-content loss, and obtain one final delta review. All other findings are non-blocking notes; a third CHANGES REQUESTED result goes to the coordinator with exact findings. P19 lands immediately after P14 and no earlier.


## Current Lane Scope

The coordinator moved P26, D02 and D03 to L-WEB on2026-10-16. L-AK retains P19 Timeline internals and the Web parts of its own features. After P19, the next landing is D-AK-1 citation links and D-AK-2 explicit saved Source links on current Knowledge behavior. Notebook Git publication, versioned Skills and the synthetic BWM loop remain separate increments. The real Notebook commit binding stays with P20; P19 must not fabricate a binding for its current file-backed S61 reader. L-AW's Knowledge excerpt increment waits for the real Notebook cutover.
