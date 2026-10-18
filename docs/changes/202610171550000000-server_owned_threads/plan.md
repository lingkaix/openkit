---
type: change-plan
status: in-progress
---
# Server-Owned Threads

## Intent Revision 1

The coordinator approved the eight-line plan on 2026-10-17 at 15:4xZ under the engineer's 12:42Z ruling. Add the general `server` Thread owner and implement only Server Knowledge maintenance. Current Server administration authority controls visibility. Reuse the existing Thread, Turn, Item, capability/usage, model resolver, notebook publisher, Proposal and recurring trigger owners. Add no parallel store, registry, scheduler, ledger or framework.

## Intent Revision 2

On 2026-10-18 the coordinator authorized the normal naming-branch merge before main and completion of the held Server joins plus Goal Coordinator native knowledge.ask/tell integration. No User Memory branch is imported. Scheduled Server work must use actual current authority or retain a visible failure; stored administrator Tokens cannot supply timer authority.

## Intent Revision 3

The coordinator authorized normal main and reviewed overview/User Memory dependency merges before the final Server gate. The shared attribution helper correction is imported from Memory, with no duplicate edit. Current selected-administrator browser sessions now reach the existing Server administrator check and lose admission after revocation. Human-review candidates freeze accepted page state before their exact bytes and digest are shown; they remain unpublished until native human acceptance. The regression checks unchanged preview/publication/resolved bytes, actual Kernel selection and decision replay. The queued pre-edit probe was cancelled before execution after the coordinator removed the optional observed-red wait; it supplies no test verdict. Complete owned suites, shared inventories and independent review remain mandatory. Memory implementation and landing stay with their separate owner.

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

## Implementation Boundary

Coordinator GO releases P18 paths and, under Intent Revision 2, the held naming joins after a normal merge of the named branch. Root joins Server maintenance and the existing operation composition. Two built-in Sol builders own separate storage and shared usage/capture branches, merged normally. Memory, Skills and Web remain with their assigned lanes.

Server Thread, Turn, Item and event variants add `owner: {kind: server}` and omit Workspace identity. Existing Workspace schemas remain unchanged. Canonical Server history uses `server/threads/<thread>/turns/<turn>/` and the same envelope, Item revision and event families. The supported required feature is `openkit.server-threads.v1`. Server capability/usage, work observations and evidence bundles extend their existing families in the Core database and Server evidence root; they do not allocate a new ledger or store. Ordinary Core migration adds the existing table families with a null Workspace column. Server observations bind the same capture coverage and environment record to their actual owner.

Server Proposal and Review variants omit Workspace identity and retain `ownerScope: {kind: server}`. Seven additive operation IDs expose Server tell/maintain, general Thread list/read, Turn Stop and exact Proposal read/decide. No new Item kind or configuration key is added. Existing Server `knowledgeMaintenance.enabled` and `schedule.enabled` remain independent and off by default. User Memory, future Server roles, cross-Workspace learning and deployment are excluded.

## Verification And Closeout

Add the lowest-sufficient regressions, inspect actual source and retained bytes, run complete changed-owner and package suites through the exact-head local gate, obtain independent Sol approval, push and express-land only on green main. Retain named logs and all out-of-area paths in the review. L-OPS owns deployment and real-provider acceptance. Server administration/evaluation roles, automatic cross-Workspace consolidation and User Memory remain outside this increment.
