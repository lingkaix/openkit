---
status: In Progress
---
# Private Memory Search

## Intent Revision 1

The coordinator's 2026-10-17 direction continues the Memory primitives while L-AK writes the revised Knowledge Manager owner text. Implement explicit lexical Memory search under [Personal Memory](../../specs/20260909-personal_memory_and_knowledge_learning.md), [Knowledge Store](../../specs/20260703-knowledge_store_implementation.md), [Retrieval Kernel](../../specs/20261014-retrieval_kernel.md) and [Core Protocol](../../core/protocol.md). The new Knowledge Manager Agent run and maintenance entry are not part of this increment. No automatic extraction, consolidation or AI assessment is authorized before v0.1.0.

## Outcome And Boundaries

The authenticated User can search their admitted saved Memory through the existing operation surface. The request chooses one currently authorized Workspace and a separate result limit from 1 through 20, default 5. NanoCore derives the current User and their existing private Assistant Timeline. It preserves any existing query lineage and refuses absent or contradictory private context. No request can select a User, widen the source set or make a Worker eligible.

Reuse the existing Kernel, retrieval service, source-local ranking and query-owned trace publisher. Admit the User inventory before publication and ranking, then recheck current authority, Source integrity, exact Page suppression and selected bytes before disclosure. Qualified User Page references, immutable notebook commit and content digest identify the selection. The private trace retains non-content selection facts and does not copy query text or Page bodies. Memory and Knowledge remain separate invocations and budgets.

Saved Page recall and raw Source delivery have different checks. A forgotten Page identity stays excluded. A later explicit human save under a new identity can be searched after current Source integrity admission, while raw Source model suppression remains in force. Search does not index raw Source bodies or infer extraction permission.

## Execution And Ownership

L-ID integrates the public request, handler, generated projections and local guides. A bounded builder owns the existing retrieval adapter, selection and trace dispatch, the selection metadata projection and one real-Kernel regression file. A separate test author owns the public operation regression. L-AK keeps the revised Knowledge Manager owner text. L-AW keeps the common retrieval service and Kernel. No helper edits another writer's paths.

## Evidence And Landing

The package regression first failed at the absent operation after Protocol dependencies were built; the earlier dependency collection failure is retained separately. The declared request then passed both complete Memory schema cases. The native and public regressions must exercise actual SQLite, Git, current authentication and the Kernel. Complete affected owner-module and changed-package suites, generated OpenAPI and CLI verification, independent exact-head review and the express local gate remain required before landing. No branch CI, host, account, provider or release action belongs to this increment.

## Checkpoint

The search request and handler are prepared on a separate branch from the independently reviewed explicit Memory and Source candidate. Native selection and the independent public regression are in progress. The earlier landing candidate stays frozen during its exact-head gate. This change claims neither a Knowledge Manager answer nor complete P20 acceptance.
