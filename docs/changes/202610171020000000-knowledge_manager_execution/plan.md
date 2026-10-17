---
status: Active
---
# Knowledge Manager Execution

## Intent Revision 1

On 2026-10-17, the engineer approved agent-first Knowledge Manager queries and bounded maintenance. Implement the accepted Phase 1 and Phase 1b owners. Reuse Thread, Turn, Item, CapabilityCall, UsageRecord, the notebook publisher, role-profile resolution and recurring scan. Add no store, registry, scheduler, ledger or framework. User Memory integration belongs to its separate owning lane. Deployments and the real-provider proof follow landing through the operations lane.

## Intent Revision 2

At 11:07Z, the engineer clarified that Server Knowledge shares facts across Workspaces and is not Memory. The coordinator supplied the query and contribution boundaries at 11:09Z. Workspace queries also read admitted Server Knowledge, with independent selection and scoped citations. Worker tell remains Workspace-only. Server maintenance takes explicit requests and their Sources, plus human Server notebook edits; it does not learn from Workspace Threads.

## Owners

- [Knowledge](../../core/knowledge.md) and [Knowledge Manager](../../specs/20260704-knowledge_manager_internal_agent_runtime.md) own role, scope, work records, tools, delivery and publication.
- [Notebook Editing](../../specs/20260909-knowledge_notebook_editing.md) owns the virtual editor, fixed base, candidates and publication.
- [Context Management](../../specs/20260902-agent_runtime_context_compaction.md) owns shared summary Items and context reconstruction.
- [Personal Memory And Knowledge Learning](../../specs/20260909-personal_memory_and_knowledge_learning.md) owns inputs and exclusions.
- [Recurring Triggers](../../specs/20260711-scheduler_recurring_event_triggers.md) owns the daily trigger.
- [Server Knowledge Decision](../../decisions/20261017-server_knowledge_is_shared_knowledge.md) records the scope correction.

## Criterion Map

| Criterion | Production boundary | Deciding proof |
| --- | --- | --- |
| A query uses the configured KM model, its own work and usage, exact citations and uncertainty | Knowledge agent, existing resolver and Gateway | Real Kernel and notebook with fake external Provider in the query suite |
| Native and Worker ask retain the asker's query context and delivered answer bytes | Operation assembly and openkit-work capability completion | Query and authenticated Worker MCP suites |
| Query audiences and Source checks apply at each read and delivery | Canonical page and Source readers | Private Source and history metadata refusal regressions |
| Server and Workspace selection stay separate and citations identify their scope | Existing retrieval source admission and query fanout | Server Kernel regression and query projection regression |
| Tell and explicit or daily maintenance start fresh bounded Turns in one maintenance Thread | Maintenance adapter and recurring scan | Maintenance and schedule suites |
| Inputs retain base, source range, trigger, instructions and human changes; own KM work is excluded | Turn execution metadata and admitted snapshot | Maintenance input and human-edit regressions |
| An admitted fixed-base candidate publishes under delegation or becomes a real Proposal | In-memory editor and existing publisher/Review | Editor, publisher and maintenance suites |
| Required review exposes the complete saved diff and acceptance submits its displayed identity | Existing Proposal preview and Web Knowledge row | Native preview and Web complete-part/failed-read regressions |
| A failed or skipped run remains visible; replay never repeats model work or publication | Native Status Item and existing command receipt | Late Provider failure and exact replay regression; app schedule regression |
| Compaction uses the shared context-summary Item, pins model/strategy/threshold and retains exact history | Internal loop, history and shared context evidence | Compaction, rolling, history and portability suites |

## Checkpoint

The Workspace role, query, maintenance, editor, Proposal and schedule joins are implemented on the lane branch. Server reads and scope-qualified query projection are being integrated. Server maintenance Thread placement remains a coordination question because current Threads are Workspace-owned. User Memory implementation remains with its owning lane. Independent review, generated contracts and the exact integrated local gate are pending. Focused fake-provider checks are engineering evidence and are not real-use acceptance.

## Verification And Closeout

Run complete suites for affected owner modules and changed packages through the exact committed-head local gate. Obtain an independent Sol review of the actual diff. Merge main normally, land through the express protocol and watch the main-push CI. Record exact logs, review and head before closeout. After deployment, use the configured xAI model for one real-provider run; do not assume an OpenAI model or claim acceptance from a fake Provider.
