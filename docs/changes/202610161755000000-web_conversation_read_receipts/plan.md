---
type: change-plan
status: in-progress
date: "2026-10-16"
branch: lane/web-p26
---
# Conversation Read Receipts

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
