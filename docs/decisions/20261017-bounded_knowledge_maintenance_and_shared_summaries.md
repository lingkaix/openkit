---
status: Accepted
date: "2026-10-17"
decider: Engineer
supersedes: docs/decisions/20261017-knowledge_manager_agent_and_compaction.md
---
# Bounded Knowledge Maintenance And Shared Summaries

## Decision

Each notebook scope has one nonresident Knowledge Manager maintenance Thread for work records and required approvals. Explicit requests and the daily trigger start fresh bounded Turns with one writer. Inputs include the notebook overview, run inputs and needed authorized Thread records. The notebook and commit history provide cross-run memory. Compaction occurs only within the current run; restart never replays a model or resumes a hidden editor.

Consolidation and learning from recent authorized scope Threads ship in v0.1.0 maintenance. Each Server, User and Workspace scope has one independent daily on/off setting, default off. Enable it only for acceptance, testing and evaluation; explicit requests remain available. Reuse the existing recurring scan and work records. Retain base revision, processed source range, trigger and instructions. Fixed-base candidate commits publish under current maintenance delegation or become proposals; the diff is the review surface. Human edits are inputs and cannot be overwritten. Knowledge Manager run records never become later learning inputs; failed or skipped runs remain visible. AI assessment and usage aging stay deferred.

Rolling and compaction retain the existing context-summary Item with its exact covered Item range, strategy and producing model. Reconstruction is the latest valid summary plus later Items within the admitted continuity boundary. Each execution pins strategy beside role, model and threshold; v0.1.0 has no per-call window record. Assistant and Goal Coordinator default to rolling; Knowledge Manager and a future admitted Evaluator use compaction. This refines the Knowledge Manager exception to the original all-role rolling decision. It creates no store, scheduler, registry, ledger, status family or role. Tool names remain unchanged.

## Reason

The engineer wants agent-native retrieval and curation with separate query audiences, one visible maintenance record and approval place, and bounded execution. The approximately 09:47Z, 09:55Z and 09:59Z rulings refine the earlier [Knowledge Manager decision](20261017-knowledge_manager_agent_and_compaction.md). The earlier decision's role, authority, usage, model configuration, open front matter and deferred masking rules remain in their current owners. The original 05:29Z and 05:38Z statements remain unchanged in that historical record.

### Bounded Maintenance And Shared Summary Storage

The engineer's approximately 09:47Z, 09:55Z and 09:59Z inputs refine the earlier maintenance and storage choices. Scheduled consolidation and learning from recent authorized scope Threads ship in v0.1.0. Each Server, User and Workspace scope has one daily enablement setting, default off; it is enabled only for acceptance, testing and evaluation. Explicit requests remain available. The existing recurring-trigger owner admits the closed Knowledge Manager target through its existing scan; it adds no independent scheduler or record family.

Each run retains its notebook base revision, processed source range since the prior run, trigger and instructions. It starts from the overview, run inputs and needed Thread records. Candidate commits use the fixed base; current maintenance delegation permits publication, otherwise the exact proposal needs approval. The diff is the review surface. Human edits are inputs and cannot be overwritten; source access and stale-base checks remain in force. Knowledge Manager's own run records never become later learning inputs. Failed and skipped scheduled runs have visible outcomes. AI assessment and usage aging remain deferred.

The two context strategies serve different task boundaries without claiming either is universally better. Their shared Item representation preserves history and lets evaluation group executions by the pinned strategy. Compaction checkpoints are durable existing Items, not another store. No tool name changes in this refinement; the naming discussion is separate.

### Approximately 09:47Z: English Translation

I generally agree with the Knowledge Manager design, but two points need discussion. First, tools exposed through Worker MCP, NanoCore and Server MCP should have one naming rule, because they expose the same system mechanisms. Consider a single-word namespace and an action name; the naming choice remains separate. Second, rolling context and traditional budget compaction are two agent-loop strategies. We do not assume one is better and want to evaluate both. Rolling context seems natural for the long-lived Assistant and partly long-lived Coordinator. Traditional compaction seems better for bounded Knowledge Manager tasks and a future Evaluator. Can their Thread, Turn and Item storage format be unified?

### Approximately 09:55Z: English Translation

The maintenance Thread should not be considered resident; our scheduling mechanism starts it. Check Claude Code dreaming and community discussion. I want both context-management strategies to share a storage format. If the format is shared, how can evaluation distinguish which strategy each execution used?

### Approximately 09:59Z: English Translation

Put scheduled triggering in v0.1.0. Allow a separate on/off setting for Server, User and Workspace scopes. Default it to off and enable it only during acceptance, testing and evaluation.

## Rejected Alternatives

- A resident maintenance conversation carries model context across unrelated runs. Fresh bounded runs retain the common record and approval Thread without that continuity.
- Separate summary formats or per-call window records duplicate existing Items. The pinned execution strategy distinguishes evaluation groups.
- An independent learning scheduler or additional cadence controls add mechanisms beyond the daily scope switch. The existing scan and work owners suffice.
- Unreviewed in-place rewrites can lose human changes. Fixed-base candidate commits preserve the review diff and reject a stale publication.

## Revisit When

Revisit if bounded maintenance or the shared summary format cannot preserve required context, human edits, audience isolation or visible outcomes. Revisit cadence or strategy defaults only when evaluation or a changed task boundary justifies it.

## Affected Owners

- [Knowledge And Personal Memory](../core/knowledge.md)
- [Knowledge Manager Internal Agent Runtime](../specs/20260704-knowledge_manager_internal_agent_runtime.md)
- [Internal Agent Runtime](../specs/20260813-internal_agent_runtime.md)
- [Context Management And Compaction](../specs/20260902-agent_runtime_context_compaction.md)
- [Personal Memory And Knowledge Learning](../specs/20260909-personal_memory_and_knowledge_learning.md)
- [Recurring Triggers](../specs/20260711-scheduler_recurring_event_triggers.md)
