---
type: change-plan
status: implemented
completed: 2026-10-19
---
# One Knowledge Notebook Page Contract

## Intent Revision 1

The engineer confirmed F5 cleanup on 2026-10-19 at approximately 01:5xZ. The coordinator assigned F5(b) to L-GO at 01:58Z and approved its five-line direction check. Workspace Knowledge already projects and publishes Git Notebook pages. This increment removes the separate public KnowledgeEntry vocabulary and retained openkit_entry_kind metadata before the rc.10 reset; it does not replace a second canonical entry store. Direct human editing remains available.

## Accepted Owners And Boundary

[Knowledge](../../core/knowledge.md), [Notebook Editing](../../specs/20260909-knowledge_notebook_editing.md) and [Knowledge Store](../../specs/20260703-knowledge_store_implementation.md) remain authoritative. The existing notebook publisher owns validation, fixed-base publication, current access, Audit, receipts, human removal confirmation, content-bound Review invalidation and restart/replay. L-AK owns C01/C02 ledgers, Sources and their cutover. L-GO requests sequential shared-file ownership before changing their legacy entry sections. Web consumer edits belong to the coordinator on a child branch after the native contract is frozen. No compatibility API, dual reader, converter, new store or new page type is included.

## Mechanism Necessity

- One notebook operation family is necessary so clients discover one page lifecycle instead of two CRUD contracts. Existing notebook.update remains the sole publication mechanism; create/delete constrain their intent through that owner rather than adding a publisher.
- One canonical page projection is necessary to expose exact admitted OKF bytes and their identity without a second title/body/kind DTO. Its existing id, path, content and contentDigest facts come from the native authorized Notebook reader; the list retains Knowledge Base and selected revision identity.
- Removing openkit_entry_kind is necessary because it can disagree with the existing typed OKF type. Consumers read an existing OKF type only when their present behavior requires it; otherwise the redundant label is removed.
- Updating live clients, CLI, docs, runbooks and tests together is necessary because a retired operation or metadata producer would otherwise remain reachable after reset.

- The early existing receipt/in-flight input check is necessary so create path or delete digest preconditions cannot replace the required same-request changed-input conflict with an unrelated content conflict; it adds no receipt or replay owner.
- The internal base/candidate traversal qualifier is necessary so removal checks the removed page's original dependency graph under current Source authority while a simultaneous candidate edit is checked against its resulting tree; otherwise deletion skips Source checks or a valid joint change is falsely refused. It adds no retained field or resolver.

## Execution And Evidence

Independent Test Author /root/f5_notebook_test_author established the public-contract RED in bccacd0e4, e4046de8c and eaac02d94, then authored the removal/replay and changed-input RED in 4dd410867 before builder correction 4a1e9dca6. Healthy existing publisher/read controls qualified the fixtures. A separate fresh Sol reviewer inspected the source and corrections; L-AK gave the bounded Knowledge-owner approval. Coordinator-owned Web children 69208aa41 and 7d9a69b1c were normally merged, including the browser crypto correction. No GPT Web edit was made. Normal main merges preserve the admitted Policy, runtime and Knowledge Manager owners. Full CI remains the shared-main check.


## Implementation Summary

Workspace Knowledge exposes one full OKF page projection and the Notebook list/create/update/delete family. Create and confirmed deletion constrain the existing fixed-base publisher and reuse its publication result and receipt. The legacy CRUD operations, KnowledgeEntry DTO and entry-kind metadata producers are removed. Store, export/import, Core Client, generated API/CLI, Web editor and active manual use the same exact page bytes, path and digest. Current Source admission, removal confirmation, history, Review invalidation and request replay remain governed by the existing owners. No page type, retained family, registry, converter or compatibility reader was added.

The source review closed the removed-page Source/replay and changed-input findings through independent regressions. A real browser run exposed a Node crypto import in the coordinator's first Web child; the corrected child confines it to test fixtures. Three remaining native fixture records were aligned with the canonical page contract without removing their retrieval, export or foreign-tree preservation assertions. The initial Memory timeout passed unedited on retry. The final main merge also requires regeneration of the CLI bundle after the separately owned Knowledge Manager deadline change.

Complexity at closeout is 125 F5 files, three changed owning documents, three governing owners and zero new closed sets or registries. Later Source and Claim/Observation work remains outside this increment. The reset-era cleanup carries no converter; release and live-host acceptance remain separate.

## Verification Evidence

The original contract RED/GREEN and independent admission RED/GREEN are retained in lane evidence; the latter complete four-file check passed 19 tests plus Native typecheck. Native e2e passed all six cases. On the Web-joined head, complete Protocol 432, App API 467, Core Client 119 and root/CLI 103 tests passed; Web typecheck/build, all 1,550 unit tests and all 34 browser cases passed.

The initial broad Native run on 6b41739e2 completed 136 files with 2,178 passing and ten failing tests; its failed log is retained. After reviewed fixture-only corrections and the runtime main merge, all seven complete affected files passed 484/484 on 16bf39731, including Worker execution 215, executor factory 196, Workspace deletion 29, export 31, child lineage five, governed retrieval seven and unedited Memory search one. Passing unchanged suites are carried; this is not a claim of a single green 136-file invocation. The clean main985e merge at 10ba2c81b passed the complete 47-file Knowledge/KM overlap, 528/528, complete Config Schema 383/383 and Native typecheck. Its sole final failure was the actual CLI fresh-byte check; canonical regeneration then passed OpenAPI validation, exact CLI freshness, root/CLI 103/103 and repository checks. The generated OpenAPI bytes did not change. No test budget or assertion was weakened.

The independent source report is L-GO-f5-page-contract-review.md; the bounded Knowledge-owner report is L-AK-F5-owner-4a1e9dca6.md. Deciding logs are f5-final-6b417-native.log, f5-fixture-correction-final.log, f5-km-main-overlap.log, f5-final-6b417-web.log and f5-main-km-generated-refresh.log. Earlier interrupted mixed-head and superseded runs remain diagnostics, not passes. The final documentation/current-main check and landing identity are recorded in the lane checkpoint and seam board. No live host action, reset, release or branch CI was performed by this increment.
