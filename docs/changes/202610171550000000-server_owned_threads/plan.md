---
type: change-plan
status: in-progress
---
# Server-Owned Threads

## Intent Revision 1

The coordinator approved the eight-line plan on 2026-10-17 at 15:4xZ under the engineer's 12:42Z ruling. Add the general `server` Thread owner and implement only Server Knowledge maintenance. Current Server administration authority controls visibility. Reuse the existing Thread, Turn, Item, capability/usage, model resolver, notebook publisher, Proposal and recurring trigger owners. Add no parallel store, registry, scheduler, ledger or framework.

## Owners

[Core Concepts](../../core/core-concepts.md#thread) owns the general Thread owner. [Knowledge](../../core/knowledge.md) and [Knowledge Manager](../../specs/20260704-knowledge_manager_internal_agent_runtime.md#server-maintenance-thread) own the maintenance role. [Notebook Editing](../../specs/20260909-knowledge_notebook_editing.md), [Context Management](../../specs/20260902-agent_runtime_context_compaction.md) and [Recurring Triggers](../../specs/20260711-scheduler_recurring_event_triggers.md) retain their existing boundaries. The [Server Knowledge decision](../../decisions/20261017-server_knowledge_is_shared_knowledge.md#general-server-thread-owner) records the reason.

## Criterion Map

| Criterion | Production seam | Proof |
| --- | --- | --- |
| General Server owner has no Workspace anchor; Turns and Items inherit it | Protocol, existing Store and canonical record writer | Creation, mutation and reopen regression; no Workspace listing or export disclosure |
| Current Server administration authority admits history and effects | Existing operation and audience admission | Administrator read/Stop, ordinary Workspace-member refusal and authority-revocation regression |
| User or Assistant request starts one fresh KM run | Existing operations, role resolver and Gateway | Fake-provider request with configured Server model and own usage |
| Daily trigger is independently off by default; failed and skipped runs are visible | Existing recurring scan and Turn outcome | Default/off, once-per-day, failure and active-writer regression |
| Inputs include base, source range, request/schedule and instructions; no Workspace learning | Existing execution metadata and Server notebook history | Exact admitted inputs, human-edit inclusion and Workspace exclusion regression |
| Fixed-base candidate uses Server delegation or native Proposal review | Existing editor and scoped notebook publisher | Delegated publication, required review and stale-base conflict regression |
| Compaction and restart keep current owners | Existing summary Item and bounded role runner | Shared-format summary and no model replay after reopen |

## Owner Criterion Changes

Core Concepts, Thread: replace exactly-one-Workspace placement with exactly one immutable Workspace or Server owner; preserve default Workspace ownership, sequential Turns, single current AgentSession, immutable lineage and no inferred authority. Creation fixes that owner, and the no-history-movement invariant now covers all owners. Server visibility requires current Server administration authority. Work Model projects this extension; Knowledge and the KM spec bind Server maintenance to it. No existing Workspace audience criterion is removed.

## Checkpoint

Main c35c68a9 is merged. Before source work, the open-branch ownership check found required shared seams held by L-AW (workspace-file-records.ts), L-ID naming and L-AW Text (internal-agents/gateway-provider.ts), and L-GA (operation-resolvers.ts). No held path is edited. Free owner text is prepared; implementation and deciding tests wait for a release or an agreed join. The operator real-provider runbook is separate evidence, not acceptance.

## Verification And Closeout

Add the lowest-sufficient regressions, inspect actual source and retained bytes, run complete changed-owner and package suites through the exact-head local gate, obtain independent Sol approval, push and express-land only on green main. Retain named logs and all out-of-area paths in the review. L-OPS owns deployment and real-provider acceptance. Server administration/evaluation roles, automatic cross-Workspace consolidation and User Memory remain outside this increment.
