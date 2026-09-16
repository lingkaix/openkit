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

Width correction is committed as `b28d780d`. The accepted navigation projection and App schema are committed as `47b09d7`; NanoCore implementation is `8f9a8de2`; Core client is `57c86eb`. Web now renders distinct Chat, Worker Task, and Goal icons, upper-right blue working and yellow actionable markers, full-name keyboard/hover tooltips, and active-first activity-recency ordering. Historical activity without attribution remains explicitly unknown. Rename, archive, and restore invalidate the navigation query immediately. The existing dashboard's hardcoded mode and Thread.updatedAt were unsuitable evidence; the new actor-authorized App projection derives from existing Turns, Items, Goals, and exact eligible gates without new durable state.

Internal Chat persists a Turn only after the provider returns. The existing pending submission mutation supplies an exact browser-local Workspace/Thread blue Waiting for response indication until settlement; it does not assert accepted server execution and never overrides actionable attention. An independent Consultant inspected the narrow owner amendment and judged it within the engineer's explicit waiting-indicator intent. The independent reviewer accepted the corrected implementation after the navigation lifecycle invalidation finding was fixed. No unresolved implementation finding remains in this slice.

Verification: App schema build and 143 tests passed; NanoCore build and 58 focused navigation, dashboard, Chat, and authorization tests passed; OpenAPI generation/validation and 25 OpenAPI tests passed; Core client build and its navigation contract test passed; Web build and 229 Sidebar, App, primitive, and Chat tests passed. Focused Biome and staged checks passed. Actual-browser inspection at 831x803 confirmed sidebar clientWidth equals scrollWidth, distinct icons, 6px upper-right blue/yellow markers, and keyboard-accessible full-title/status tooltips. The temporary local browser tab, viewport override, and Vite server were cleaned up. Staging remains unchanged.

The generated OpenAPI artifact also reconciles pre-existing source/artifact drift. The operation-surface inventory check still fails its pre-existing count mismatch: 240 actual versus 227 expected after adding exactly this operation to both sides; the original mismatch was 239 versus 226. It was not weakened to hide unrelated missing inventory. The separate shell-smoke fixture limitation described above also remains. Neither failure is reported as a passing check.

Next action: await the engineer's unread persistence choice and Goal child-conversation scope answer, then implement and commit the dependent remainder. This plan stays in progress; unread and Goal grouping are not claimed complete.
