---
type: change-plan
status: in-progress
---
# Conversation Navigation

## Intent Epoch 1

Source: the engineer's 2026-09-16 staging browser comment on the primary sidebar. The sidebar must not scroll horizontally. Conversation icons must distinguish Assistant Chat, Worker Task, and Goal activity; blue means working, green means an unread Agent reply, and yellow means user action is needed. Related Goal conversations must be grouped, and active conversations must sort ahead. Commit each completed fix before starting the next. Authorized effects are local implementation, verification, and commits; staging is unchanged.

## Owners

- `DESIGN.md` section 3.1 owns sidebar presentation.
- `docs/specs/20260909-thread_visibility_and_sharing.md` owns viewer-authorized conversation visibility.
- Existing Goal Mode specifications own execution Thread relationships; Core Thread and Turn records remain authoritative.
- `docs/change-execution.md` owns execution and evidence.

## Checkpoint

Width correction is implemented. Eight fixed-width workspace controls and the fieldset intrinsic minimum exceeded the sidebar content width. The controls now occupy a four-column grid; icon-button padding is explicitly zero; Search uses the brand-row content width. Browser inspection of the actual Sidebar with compiled Tailwind and 30 long-name conversations measured outer width 264px, client width 248px, scroll width 268px before and 248px after. Search fits x=12..236. Settings also has client width equal to scroll width. Web build and 59 App tests passed; focused Biome and diff checks passed. The existing shell smoke test now retains the geometry assertion; independent review ran the isolated-stack smoke, which stopped before the geometry assertion because the unchanged local-mode gateway fixture omits required logicalModels[0].contextManagement. Its server-mode dialog smoke passed. This setup failure is not product evidence; the actual-browser before/after measurement covers the changed layout. Independent review found no actionable issue in the width diff.

Independent direction review found that current Goal tasks execute within their owning Goal Thread, despite the accepted design calling for separate child execution Threads. No child relationship may be inferred from names or task IDs. Account unread has no existing cursor. Two engineer questions are pending: account-synchronized versus browser-only unread, and whether this scope includes restoring independent Goal child conversations. No dependent implementation is authorized by silence.

The current-mode dashboard field is hardcoded to automation and cannot supply icons. Thread.updatedAt alone is not reply recency. Next: commit the verified width correction, then investigate the smallest actor-authorized navigation projection over actual activity and exact eligible gates while awaiting the two scope decisions. Do not create false unread state or hierarchy.
