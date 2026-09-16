---
type: change-plan
status: verified
---
# Output Catalog And Text Layout

## Intent

The engineer's September 16 staging annotations require long words and IDs to remain inside their boxes throughout Web, and distinguish explicitly submitted user-facing Artifacts (documents, reports and other deliverables) from internal workspace-change review records. They also request a clear explanation of the current Introduce into thread control. Fixes remain separate local commits; this does not authorize staging deployment, publishing, review decisions, or deletion of retained evidence. The preceding side-panel overlay fix is committed as ff27971.

## Owners And Direction

[DESIGN.md](../../../DESIGN.md) owns text and layout. The workspace synchronization specification owns review evidence and the stored review-to-Artifact association; the work-resource interaction specification and Artifact protocol own actual publication, import, and introduction. Independent Consultant check_author_projection advised preserving the existing internal review backing records and excluding their exact joined ids from product-output discovery, without guessing from titles, kinds, prefixes, or JSON. Explicitly submitted diffs remain valid Artifacts. Images and videos illustrate the requested product category; implementing binary media storage is outside this correction's demonstrated need.

## Checkpoint

The side-panel overlay, shared text containment and actor-scoped deliverable catalog are committed as ff27971e, dcf23d23 (format follow-up ad195084), and 8bc33a23. The final Web slice displays full titles, kinds and versions; explains the reference-only Add to conversation action from an exact successful detail; and links to Workspace Changes. No protocol shape changed. No staging deployment, review decisions, apply or external publication occurred.

## Acceptance

Narrative text, identifiers and wrapped JSON fit their containing boxes; intentional wide technical regions scroll internally. Compact controls remain usable with long authoritative names. User-output discovery excludes exactly linked workspace-review evidence while retaining a legitimate output with the same title. Introduction uses a clear name and explains its actual imported-file reference semantics without promising Agent execution. No durable publication ledger, media subsystem, or evidence deletion is added.

## Text Layout Verification

The initial compact-label regression failed because ContextChip exposed no full-name title. After the shared typography and bounded-control changes, 194 focused primitive, chat and token tests passed. Web typecheck and production build passed (existing large-chunk warning). Browser checks at 800 by 600 used actual Web components and production CSS: document width fell from 3702 to 800 pixels; narrative and wrapped JSON fit, while explicit preformatted code and wide tables retained internal scrolling. Actual ArtifactsScreen content, dialog, menu and select options also fit. Independent review found an unconstrained PageHeader actions consumer; bounding its actions to half the header with wrapping and allowing ContextChip to shrink corrected the reproduced overflow. The Repositories header composition with a 380-character Workspace name and stale-status chip now measures document 800, header 473/473 and actions 237/237 client/scroll pixels; the full name remains in the chip title.

Independent reviewer review_conversation_targets accepted the final text-layout diff after the PageHeader correction, checked all 46 consumers, and separately observed 78 passing primitive tests.

## Output Catalog Checkpoint

The catalog regression reproduced both internal review records incorrectly returned beside a deliberate same-title output. A shared NanoCore projection now excludes only the persisted review Artifact relationship and preserves raw store/history/export reads. The existing response shapes suffice, so no protocol package change is needed. The focused regression covers pending and terminal reviews, surviving same-title output, exact direct reads, preserved Thread reference items, list/get/update/replay counts, search, and rejection of review evidence as a new conversation attachment before a Turn exists. Independent review identified the Workspace PATCH response gap; the shared local Workspace read projection now covers mutation responses as well. The staged read-only Workspace Changes UI shows the seven review ids in both Reviews and Staged reviews, with explicit backing Artifact ids, including the engineer's hold-6bcfc15.txt and pr-check.txt records; no decisions or external writes were made.

Independent review also found a pre-existing confidentiality gap in the affected Artifact list, counts, direct reads and attachment path. The existing two-user audience fixture reproduced the leak before correction. The shared output projection now requires the authenticated actor and uses the existing immutable Thread audience owner; direct Artifact reads and introduction recheck origin and destination audience independently. The five focused route suites now pass 25 tests, including other-user private outputs absent from inventory/counts, forbidden exact reads returning 404, and forbidden attachment rejection with no receiving Turn. NanoCore build/typecheck and documentation validation pass.

Additional server Artifact route checks passed 6 tests (166 unrelated tests excluded by the focused name filter). The final audience fixture passes 4 tests, additionally proving imported safe content cannot be introduced into another user's private Thread. These corrections restore the existing audience owner in [Core protocol](../../core/protocol.md), not a new permission model.

Independent reviewer review_conversation_targets accepted the final catalog and owner diff with no actionable slice findings and independently ran 10 passing Artifact and audience tests. The reviewer separately flagged the pre-existing Workspace export path (`createVerifiedWorkspaceExport`) for an audience audit; this catalog slice preserves export storage and makes no claim of complete export privacy. That distinct export-integrity concern is not corrected here.

## Verification

Web primitives, chat and token checks passed 194 tests for text containment; final Artifact, primitive and chat checks passed 213 tests. After the origin-explanation correction, all 44 Artifact tests passed again, including unknown-origin and version-mismatch states. Independent review separately passed 122 Artifact and primitive tests and accepted the final diff. NanoCore's five focused suites passed 25 tests; the additional server route selection passed 6, and the final two-user audience fixture passed 4 with introduction denial included. Both app builds/typechecks passed; Web retains its existing large-chunk warning. Documentation-model validation passed for 275 documents, and focused formatting/lint and diff checks passed.

Browser checks used actual components and production CSS at 800 by 600. The final Artifact long-title row measured 423 client/scroll pixels, JSON preview 439/439, and document 800/800; imported-file selection enabled Add to conversation, while produced output stayed disabled with its explanation. Earlier checks covered shared messages, menus, selectors, dialogs, PageHeader actions, intentional code/table scrolling, and side-panel docking versus overlay at its actual container breakpoint. Temporary preview servers were stopped, temporary tabs closed, and the browser viewport override reset.

## Closeout Summary

The requested text containment and deliverable-catalog correction is complete locally. Existing workspace-review evidence remains available to its authorized reviewers and historical readers, while explicit same-title deliverables remain in the catalog. Origin-specific UI copy is withheld until exact current content has loaded. The independent reviews found no remaining actionable findings in these changed slices. The separately observed pre-existing export audience issue remains outside this correction, documented above; this work does not claim full export privacy. Binary image/video storage was not added: the current import/content contract still accepts Markdown, text and JSON.
