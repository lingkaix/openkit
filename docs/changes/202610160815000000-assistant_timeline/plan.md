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

The branch implements singleton private Timeline admission, the ordinary personal Workspace one-way metadata migration, stateless entry retirement, governed history search/range reads and shared source-bound rolling context. Assistant command/pending continuation, private administration and Goal Coordinator use the same assembler and ordinary Provider path. Exact canonical history remains retained. Focused regressions prove bounded batches, restart, current source/audience enforcement, shared budgets, real Gateway accounting and archive portability. The external checkpoint records exact named commands and observed results.

P19 now includes the complete fixed ordinary Tool set, exact human-selected Task/Goal handoffs, immutable receiving-Thread lineage and shared source-proof verification for dispatch/restart/closeout. The retired keyword classifier is removed. The branch includes main through a1f2c6b8 and has regenerated OpenAPI, protocol schemas and bundled CLI. The first independent review requested changes: generic handoff UUIDs fail named-kind reference validators; an import order fallback skipped original predecessor proof validation; one operation-test index and four retired Web exclusions remained. The proof and projection corrections pass focused regressions. The landing window is released. Integrate P14's accepted shared allocator before another landing attempt; do not add a parallel formatter or relax validators. Full affected suites, a fresh exact-head review and full CI remain required. No host acceptance or release publication is authorized.

## Seam And Evidence

The first seam joins public thread.create to canonical Thread storage and restart. A separate gpt-6.1-sol test-author reads both owners and writes only personal-assistant-timeline.test.ts. Expected current failure: independent private creation commands produce different Threads, and the home kind is quick-chat. The second seam joins the canonical Workspace kind to capability and owner-only audience enforcement. The final independent review must inspect the actual complete origin/main..HEAD diff, including owner amendments, on the exact head used by full CI.

## Next Action

The independent full mode-entry suite passed124cases and pre-integration NanoCore typecheck passed. Preserve the exact queued/terminal source tuple without synthetic receipts. The coordinator approved the larger required import extension and required its proof/remint/digest logic to move to workspace-import-assistant-history.ts; that move is complete. Real archive round-trip, restart/reuse and corrupt-proof tests pass3cases after a new tied-order predecessor counterexample first proved unwanted target publication. The two affected Web files pass62cases, and operation projections pass50cases after removing the retired row index. Repository validation, full lint and full typecheck passed before these review corrections; rerun affected gates and integrate P14 before final review/CI. Continue P20 on the separate successor branch while the identifier boundary is pending.

## Intent Revision 2

The coordinator clarified on 2026-10-16 that shared integration files may be edited on lane/ak before the landing window; only landing is serialized. Finish P19 completely before first landing. Train 3 must be on origin/main first. Continue P20 on a local successor branch if P19 is ready before train 3 lands.

## Intent Revision 3

The engineer selected retirement of chat.quick on 2026-10-16 through the question channel. Preserve one-shot use through conversation.submit on the Timeline in the CLI and operations Skill, remove all former public projections and inverse tests, regenerate OpenAPI and bundled CLI in the landing window, and name the removed operation in release-facing landing evidence. The accepted rationale is recorded in Retire Stateless Quick Chat.

## Intent Revision 4

The engineer approved a source-bound canonical summary Item on 2026-10-16 through the question channel. Extend the existing Item and context owners additively. Bind each summary to its exact canonical source range and digests, verify sources and current authority before use, and keep exact history retrievable through the existing Assistant history Tool. Use the ordinary Provider path with usage, audit and failure accounting within the existing Assistant budget. A producer failure leaves the window unadvanced with a visible cause. Web and CLI show the covered range. No new store, runner or checkpoint owner is authorized.

## Intent Revision 5

The coordinator selected the approved P14 reset boundary for predecessor receipt-free Assistant Tasks on2026-10-16. Any retained bytes stay inspect-only as recovery_required, with no automatic resumption, fabricated confirmation, compatibility reader, separate P19 reset or carry-forward migration. The pre-stable continuity obligation has not started, and the already approved clean-candidate P14 reset owns this prerelease disposition. Add a no-resumption regression. The next prerelease notes must state this disposition as well as removal of chat.quick. P19 landing waits for the shared P14 identifier allocator; no parallel formatter or relaxed validator is authorized.

## Personal Work Admission Correction

Independent preparation review found that lifting the former personal Workspace capability guards also let ordinary Assistant requests create conversations on Workspace-visible work Threads. Chat and Visibility already prohibit shared conversations in personal Workspaces. The correction retains ordinary Task and Goal Threads, marks the Assistant unavailable on those personal work Threads, and refuses a fresh Assistant submission before inference or canonical Turn/Item publication. Existing exact receipt replay remains before fresh-command admission. The native regression creates an actual Goal in the personal Workspace, then expects the addressed Assistant request to fail while preserving the Goal Thread and its exact history. Its first run reached the intended200-versus409 failure in p19-personal-work-assistant-red.log; the independent two-Thread probe also observed two completed answers and two Provider calls. Final green and exact-head checks remain required.
