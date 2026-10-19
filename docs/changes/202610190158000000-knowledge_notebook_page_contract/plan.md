---
type: change-plan
status: in-progress
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

## Execution And Evidence

Independent Test Author /root/f5_notebook_test_author owns only two new contract test files. It derives intended failures from the accepted owners and ruling before production implementation. A real existing publisher/read control must establish a valid fixture. Source review uses a separate fresh Sol context, followed by L-AK's bounded owner review. Normal main merge and affected suites plus Native typecheck precede the coordinator-authorized direct fix-forward landing. Full tests stay on shared main. Test commit, RED/GREEN logs, source verdict and exact landing head will be recorded when observed.
