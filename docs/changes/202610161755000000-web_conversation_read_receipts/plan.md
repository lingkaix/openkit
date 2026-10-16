---
type: change-plan
status: in-progress
date: "2026-10-16"
branch: lane/web-p26
---
# Conversation Read Receipts and Goal Navigation

## Intent Revision 1

The coordinator's 17:47Z instruction retains the reviewed Recovery and separate Administration cuts, exempts the P14 priority wait from the four-hour stop, and resumes source work on the next package. The assigned P26 D02 recommended choice is server-persisted User/Workspace/Thread read receipts, advancing only after actual display or explicit read and never prefetch. Implement this vertical receipt feature against current Thread and User APIs in a separate branch; reconcile the personal Timeline projection when P19 lands. L-AK keeps Timeline internals, and D03 grouping remains a separate next slice using real Goal card links and all attempts. No P17 contract or D01 Composer work is included.

## Owners and Route

The Web projection's User-owned Read Receipts criterion owns eligibility, display, mutation, unavailable states and acceptance. Storage Layout and Core Storage own the existing User database. Permissions and Thread Visibility own current actor and source access. The implementation choice is a set of observed completed message Item identities in one User-owned receipt per Thread. Existing source inspection found no global durable Thread append ordinal; this set avoids adding an ordinal or marking unseen earlier replies read. Use ordinary additive User SQLite migration, existing authenticated operation composition, typed client, TanStack reads and accessible Web primitives. Add no ledger, runner, identifier formatter, conversion or authorization store.

## Scope and Evidence

The primary owns owner criteria, operation definitions/composition, navigation and UI wiring, guides and integration. A bounded Builder may own only the receipt storage module, its regression and the ordinary User migration. Each helper has a separate worktree and merges its branch. Write ownership is recorded in the lane checkpoint before dispatch. Begin with focused failures for monotonic persisted receipts and actual UI display; then complete changed-module suites, generation and independent review. Local browser evidence proves the local workflow; L-OPS retains deployed real-authentication acceptance. The Recovery and Administration landing branches remain separate. No code lands before P14 or the coordinator's automatic 22:00Z boundary; follow Express gates and observe containing main CI.

## Implementation and Current Evidence

The existing User database has an ordinary additive receipt table and atomic set union. Public Thread operations derive the current User and reuse current Workspace/Thread admission. Navigation reads project eligible unread counts. Web observes actual message body elements in a foreground document, retains only displayed identities for a failed-save retry, and offers explicit Mark read. The existing neutral CountBadge makes unread counts visible without changing work or attention state. No Composer file-input or Timeline internals changed.

Storage helper b0400f28 was inspected and normally merged: the pre-migration regression failed with the missing SQLite table, then all 18 receipt and migration tests, NanoCore types and focused lint passed. The original Sidebar regression failed on its missing unread description; the original display regression failed because the old stream made no receipt read. First Web integration passed 12/14; its pending-description expectation and Markdown body fixture observation were corrected without dropping privacy assertions. First native integration passed 20/21; the existing actor-selector guard correctly returned 403, so the test now checks that result and unchanged receipt. A compiler error from schema-derived optional undefined is corrected in the owning function type. Existing database and layout-report migration expectations include the new migration; unrelated loose identifier fixtures and descriptive schema examples are unchanged.

Corrected focused native/Web checks are pending in `evidence/L-WEB/p26/integrated-focused-corrected.log`. A separate Builder owns one local browser proof using real public operations, actual display and Core-only restart, plus the required unreadCount in the existing shell navigation fixture. The current browser build setup failure is retained separately; no browser success is claimed. Generation, complete changed-module suites, P14/P19 reconciliation and independent review remain open. Recovery and Administration stay separate landing cuts.

## Intent Revision 2: Goal Navigation Preparation

While exact D02 checks and the P14 landing boundary wait, prepare the accepted D03 grouping in a separate primary worktree and branch. Reuse current goal.read, thread.list and conversation.navigation; do not add a projection API or reopen Goal lifecycle. Root owns the new grouping component/test and the minimal Sidebar row-render integration on lane/web-p26-goal-groups. The D02 worktree and both helper scopes remain separate. Amend the Web owner first, then prove an initial missing-group regression against the existing Sidebar before wiring production. Reconcile P19 before publication and preserve every linked Task attempt through actual card citations.

## Corrected Integration Evidence

The corrected source08384fb1 passed all21 native cases in four complete files and all14 Web cases in three complete files; NanoCore types passed. Web types found only two existing typed navigation fixtures missing the new unreadCount. The next change adds unreadCount:0 to those two fixtures without changing assertions. The normally merged browser helper adds one real public-API case: prefetch remains unread, actual foreground body display records its exact Item identity, and Core-only restart retains the receipt after the browser leaves the body. Its complete new file passed1/1, direct NanoCore build passed and focused lint passed. Original failed compiler and integration outputs remain external evidence.

At8d23c96f the matching dependency build, OpenAPI generation and validation, CLI generation and byte check, existing root Web-operation coverage guard, all272 App API tests in25files, all194 Chat and effort cases in two complete files, and Web types completed0. The existing coverage inventory names both receipt operations and exact catalog counts. Generated outputs travel with this feature. Evidence is evidence/L-WEB/p26/generation-and-typed-fixtures.log and read-receipts-browser/{browser,build-retry,lint}.log in the assigned backlog. Full changed-module and browser local gate, final independent approval and P14/P19 dependency reconciliation remain open. This evidence does not claim a deployed acceptance or an Express landing.

## Goal Navigation and Broader Integration Evidence

D02 source c34711833339ccf9a9d5c986c1b34cab9f47f114 passed all 1,329 Web tests in 47 files, all 22 database and layout-report tests in two files, and all 100 Core Client tests in eight files. Actual output is p26/full-web-and-receipt-consumers.log in the assigned backlog. This broad check found no shared-renderer or remaining database-consumer regression. It does not replace the final merged Native, root and browser gate.

D03 joins existing Goal/card/Task links and current visible Threads. Its old-Sidebar regression failed on the missing group control after successful setup. The implemented complete grouping and Sidebar files passed all nine cases, including all attempts, archived and missing Tasks, collapse, unrelated work, read-only behavior and failed-source suppression. That run exposed three unsupported Testing Library exact options; only those options were removed because string role names already match exactly. The original failed type output is retained. A later matching direct Web build passed tsc-b and Vite. No receipt or work mutation belongs to grouping.

The existing long-preview browser case now also checks a Goal expander at its two existing widths. Its first complete shell file run passed three cases and failed the new layout predicate: the control's right edge was 277 while navigation ended at 264. The parent changed only the Goal row's shrinkable flex wrapper, preserving every browser assertion and timeout. At exact source 0827bac36cf891e38d1bedfb1cb259bd6e77e292, the same complete four-case shell file passed in 43.9 seconds with one worker; direct Web build, focused lint and diff check passed. Both original and corrected logs/traces remain under goal-layout/ in the assigned backlog. The later main merge changed three Markdown paths only.

D02 and initial D03 each have independent source approval. Final combined source review, actual P14/P19 reconciliation, Assistant/member navigation and complete merged-module/browser local-gate remain open. Recovery and Administration remain separate cuts. No deployed authentication or whole-server backup claim follows from local simulator evidence.

## Intent Revision 3: Recorded Interruption Identity

The assigned P26 includes D12 from work-packages.md and inventory.md: users must be able to identify the actual interrupter without treating triggerActor as that person or adding an unaccepted StatusItem actor. Read-only tracing found that the public turn.interrupt operation drops admitted actorRef and emits no semantic interruption Audit event. Complete this bounded existing-Audit producer and Usage and audit projection while P14 priority holds Recovery and Administration. The Audit owner defines the accepted Stop-request boundary, original actor and exact lineage, ordinary replay without another event, explicit historical absence and failure gaps, and current exact Thread audience. Preserve existing runtime/command ownership and add no public API, table, field, reconstruction or cross-store atomicity claim. Root owns owner documents, guides and integration; two bounded Builders may own separate backend and Web/test paths in separate worktrees and branches. Lowest sufficient public-command and Web regressions precede production wiring; final combined changed-module and browser gates remain required after P14/P19 reconciliation.

## Combined Source and D12 Preparation Evidence

Independent source review APPROVED415c3d847bb0dd36dcb6f6a6375f9a47fea712d0. Its complete combined Web suite passed1,331tests in48files in271.68seconds, with the source worktree clean. Actual output is evidence/L-WEB/p26/combined-full-web.log in the assigned backlog. These results precede D12 production changes and do not replace the required final merged gate.

Read-only D12 tracing confirmed that operation admission has the actor but the current interrupt family drops it; neither internal Chat nor Worker cancellation records the requesting identity. The existing AuditEvent already carries actor and exact lineage, but its Workspace read lacks the current exact Thread filter and the Web safe row drops actor/lineage. Backend and Web Builders have separate paths and branches from the committed owner criterion. Their expected-red and positive checks are pending. Existing runtime and command receipts keep their current responsibility; no new public representation or runtime propagation is needed. L-AW reserved ProposalReview and D01 input seams remain untouched.
