---
status: Accepted
implementation: Not Started
kind: concept
date: "2026-10-12"
---

# Product Integrity Check

## Owns

This specification owns one read-only Workspace integrity check. It owns the operation `integrity.workspace.check`, the closed result values, and the two invariant names in the first set. It owns how those names read retained records and how they report `pass`, `fail`, or `unknown`. It does not own the product rules those names apply.

## Does Not Own

The Model Context Protocol tool-call rule stays in [Worker MCP Tool Supply](20260704-worker_mcp_tool_supply.md). The large language model usage rule stays in [Capability Usage Gateway Foundation](20260704-capability_usage_gateway_foundation.md) and [Audit, Usage, and Evidence Records](20260703-audit_usage_evidence_records.md). Closeout, receipts, and `recovery_required` stay in [Worker Turn Reliability Envelope](20260531-worker_turn_reliability_envelope.md). [Operation Definition](20261002-operation_definition.md) owns declaration, invocation, and projection. [Policy Enforcement Mapping](20260703-policy_enforcement_mapping.md) owns the access-right registry. [Core Permissions](../core/permissions.md) owns administrator eligibility. [NanoCore Bootstrap and Readiness](20260704-nanocore_bootstrap_readiness.md) owns boot and readiness. [Knowledge Manager Internal Agent Runtime](20260704-knowledge_manager_internal_agent_runtime.md) owns `knowledge.health.check`. [L6 Story Acceptance](20260529-l6_story_acceptance.md) owns the story, the judge, and the evidence bundle. [Operational Telemetry Standardization](20260731-operational_telemetry_standardization.md) owns operational telemetry. A deployment-scoped check is out of scope until a present invariant needs it.

## Core References

- [Foundation](../core/foundation.md)
- [Contract Evolution](../core/contract-evolution.md)
- [Permissions](../core/permissions.md)
- [Audit](../core/audit.md)
- [Agent Capability](../core/agent-capability.md)
- [Storage](../core/storage.md)

## Summary

An administrator calls one Workspace operation. The operation evaluates `usage-attribution`, `terminal-turn-consistency`, or both. Each name reports `pass`, `fail`, or `unknown`. `pass` means that name finished its predicate over its declared retained-record universe. `pass` does not prove that a story ran, and it does not prove that the deployment is healthy. `fail` overrides `unknown` in the combined result.

## Goals / Non-goals

- Give an agent one Workspace call for the two record predicates below.
- Keep HTTP and the remote Model Context Protocol projection on one declaration.
- Do not repair records, and do not store an integrity result.
- Do not gate boot or readiness, and do not read operational telemetry.
- Do not contact a provider, a Git host, or any other external system.

## Background

The engineer accepted this check on 2026-10-12. [Product Integrity Check](../decisions/20261012-product_integrity_check.md) records that acceptance. Stories 3 and 7 need a check of retained usage links. Story 10 needs a check that published terminal Turn facts agree. The existing `knowledge.health.check` operation answers a different Knowledge question.

## Decision

Declare one JSON operation, `integrity.workspace.check`. [Operation Definition](20261002-operation_definition.md) requires these declaration facts. The success status is 200. The binding is JSON. The declaration sets `mutating` to false and `returnsOneTimeSecret` to false. Use the existing body Workspace selector. Admit only a currently usable administrator, and reject every other caller before evaluation. Use the existing `audit.read` policy operation. Do not add an access right. Evaluate only the two names below. Leave `knowledge.health.check` unchanged. [Product Integrity Check](../decisions/20261012-product_integrity_check.md) records the Workspace scope, the administrator admission rule, and the first invariant set.

## Contract / Expected Behavior

### Definition And Exclusions

The integrity check is one caller-invoked read of current Workspace records. The caller is an administrator. The check applies the two predicates in this specification. The check does not repair a record and does not suggest a repair. The check does not persist an integrity result, a checkpoint, or a resume handle. The check does not run at boot, does not read boot readiness, and does not change it. The check does not change product-work admission. The check result is not operational telemetry and does not depend on it. A deployment-scoped check is out of scope until a present invariant needs it. `knowledge.health.check` stays a Knowledge operation. Its `warn` value and its repair suggestions are not integrity failures. A story may name one of these invariants. The story does not define the check.

### Authority And Projection Boundary

The linked owner keeps each product rule. This specification owns the evaluation and the public result. The check holds no durable state. No present need for a check history was found. One operation definition is the only declaration. The declaration binds JSON, returns HTTP 200 on success, sets `mutating` to false, and sets `returnsOneTimeSecret` to false. HTTP, remote Model Context Protocol, the Core Client, and the command-line catalog are derived projections of that declaration. The result is not a one-time secret, so the remote Model Context Protocol projection may expose the operation. The handler returns the logical result and does not receive a transport object. Creation, update, termination, retry, and recovery of a check record do not apply. The records under evaluation keep the lifecycles their owners already define. The check does not create, update, terminate, retry, or recover those records.

### Authorization

The scope selector is the existing body Workspace selector. The target is that Workspace. `workspaceId` selects the Workspace and does not grant authority. The primary policy operation is the existing `audit.read` operation, and that mapping stays the existing registry row for `audit.read`. This operation does not add a registry row or an access right. The caller must be a currently usable administrator under [Core Permissions](../core/permissions.md). An administrator Web session, an administrator bearer credential, and local-mode eligibility remain eligible under the existing authorizer. Credential scope, expiry, revocation, and the active-user check stay in force. A Workspace member that is not an administrator is rejected. The check rejects every other caller before evaluation. The rejection is the existing authorization denial, and the denial body contains no invariant result. An administrator still receives a redacted result. The result copies no prompt, tool argument, tool result, secret, token, or Vault material. Source-owner confidentiality stays in force for the administrator.

### Input

The request is a strict object. It requires `workspaceId`. It may contain `names`. It contains no other field. An unknown field fails closed as the existing invalid request, and the check does not evaluate after that failure. `names`, when present, is a non-empty array of unique strings. The closed core names are `usage-attribution` and `terminal-turn-consistency`. An omitted `names` field selects both core names. An empty array is an invalid request. An unknown name is an invalid request. The request is authority-bearing, so an unknown name is not ignored. The check does not evaluate names after an invalid request. This specification adds no mechanism that makes a future name required.

### Output

A successful response is one descriptive object. `scope` is an object with `kind` equal to `workspace` and the admitted `workspaceId`. `outcome` is `pass`, `fail`, or `unknown`. `results` contains one entry for each selected name, and each selected name appears exactly once. When the caller sent `names`, the entry order matches that array. When the caller omitted `names`, `usage-attribution` comes first and `terminal-turn-consistency` comes second. Each entry has `name`, `status`, optional `reason`, and `recordRefs`. `status` is `pass`, `fail`, or `unknown`. When `status` is `pass`, `reason` is absent. When `status` is `fail`, `reason` is `violated`. When `status` is `unknown`, `reason` is `incomplete` or `unreadable`. No other reason exists. The closed pairs are `pass` with no reason, `fail` with `violated`, `unknown` with `incomplete`, and `unknown` with `unreadable`.

`recordRefs` is an array of existing record identifiers. A `pass` entry and an `unknown` entry have an empty list. A `fail` entry lists the existing identifiers that establish the violation. For a missing required row, the entry returns the existing record that creates the obligation and never invents an identifier for the absent row. `usage-attribution` returns `CapabilityCall` ids and `UsageRecord` ids. `terminal-turn-consistency` returns the Turn id, and the Worker Checkpoint id when a retained checkpoint is part of the contradiction. A malformed record that prevents evaluation gives `unknown` with reason `unreadable`. A violation already established elsewhere in the same name still gives `fail`.

A descriptive reader ignores an unknown additive field at every object level, as [Contract Evolution](../core/contract-evolution.md) requires at lines 31 to 37. That reader does not compute a weaker `outcome` from the entries it recognizes. A reader rejects an unknown `outcome`, an unknown `status`, an unknown `reason`, and a status and reason pair outside the closed pairs. A reader that does not understand a required extension fails closed. The response has no extension bag.

### Check Lifecycle

The server admits the caller before it reads invariant records. The server then evaluates each selected name from current retained records. Each name has a bound on time and on records read. The implementation chooses the current numeric default for that bound. The implementation enforces each bound while it reads, and it stops when a bound is reached. It does not complete an unbounded read and then discard the excess. When the bound stops a name before the predicate finishes, and no violation is already established, that name is `unknown` with reason `incomplete`. When a violation is already established, that name is `fail` with reason `violated` even if the scan did not finish. A finished response is not stored. Cancellation yields no result. A disconnect yields no result. The caller must not treat a missing response as `pass`. A retry is a fresh bounded read. A retry has no resume handle and no stored check to replay.

### One Name And The Combined Result

When any of its predicates has established a violation, a name is `fail`. Otherwise, when a predicate is `unknown`, a name is `unknown`. Otherwise a name is `pass`. The same fold applies to `outcome` across selected names. `fail` overrides `unknown`. Only when every selected name is `pass`, `outcome` is `pass`.

### Concurrent Reads

The check uses the ordinary read of each record owner. It does not add a cross-store snapshot, a snapshot coordinator, or a grace period. For `usage-attribution`, the check reads the terminal `CapabilityCall` status and the stored route document first, then the linked `UsageRecord` rows. When that order is available and the producer commits the linked rows before terminal finish, a mismatch is `fail`, because those rows were committed before the terminal state the check already saw. When a predicate cannot use that order, or the producer order is not established for the path, a mismatch is `unknown` with reason `incomplete`. A violation already established from records that were read is still `fail`.

### Missing, Stale, Restart, And Dependency Failure

Empty applicable history is not missing required history. A name with an empty retained universe finishes as `pass`. That `pass` does not prove that a story ran. A future retention deletion or compaction of usage rows, under the audit-usage owner, is a known disposition and is not an accounting omission. This specification does not design that path. While that disposition does not exist, a missing required row on a complete ordered read is a violation. The check has no `stale` reason. It reads current records and does not reuse an older check result. A restart drops an in-flight check and leaves no result. The next call reads the records the owners retained after restart. The check does not treat the restart itself as `pass` or `fail`. When the store a predicate must read cannot be read, that predicate is `unknown` with reason `unreadable`. When a violation is already established from records that were read, the name is still `fail`. The check does not contact an external system to fill a gap.

### Usage Attribution

`usage-attribution` has two predicates. One predicate covers Model Context Protocol tool calls. The other covers large language model calls. Stories 3 and 7 use this name. The retained universe is Workspace `CapabilityCall` and `UsageRecord` rows. A call whose operation is `integrity.workspace.check` is outside both predicates. A request that left no Workspace row is outside the universe. The name does not claim that an absent request never happened. The declared gap for a public model call with no Workspace lineage stays outside the universe. Nonterminal `CapabilityCall` status values are `queued` and `running`. Terminal status values are `succeeded`, `failed`, `denied`, `aborted`, `timed-out`, `interrupted`, and `unknown`. A `queued` or `running` call is transitional and stays outside the terminal universe.

The tool-call predicate reads retained calls whose operation is `mcp.call_tool`. List calls are outside this predicate. When a request id is present, the idempotency key is the owner's tuple of Workspace, request id, family, and operation. Two retained calls with that key violate the predicate. Two calls with no request id are distinct calls, and a null request id does not group them. A terminal `denied` call is the retained proof that upstream was not contacted. That call must have no linked `UsageRecord` of any category, including an auxiliary byte row. Every other terminal status does not prove that upstream was not contacted. On a complete ordered read, that call must have exactly one linked `UsageRecord` with category `tool`, unit `tool_calls`, and quantity `1`. A row with another quantity violates the predicate. Zero tool-call rows on `interrupted` or `unknown` violate the predicate, because contact cannot be excluded. A byte-quantity row on a non-denied call is auxiliary and is not a second tool-call row. Two or more tool-call rows on any included call violate the predicate. The Model Context Protocol tool route commits that usage row before terminal finish. The check reads the terminal status first and then the linked usage rows. A mismatch in that order is `fail`.

Tool-call fixtures:

- Positive. One `mcp.call_tool` call has status `denied` and no `UsageRecord` of any category. The call is consistent.
- Positive. One `mcp.call_tool` call has status `succeeded` and one tool-call `UsageRecord` with quantity `1`. The call is consistent.
- Positive. The succeeded call also has one byte-quantity `UsageRecord`. The tool-call count remains one. The call is consistent.
- Positive. One `interrupted` or `unknown` `mcp.call_tool` call has exactly one tool-call `UsageRecord` with quantity `1`. The call is consistent.
- Violating. Two `mcp.call_tool` calls share one Workspace, request id, family, and operation. The predicate is violated. `recordRefs` lists those two `CapabilityCall` ids.
- Lawful. Two `mcp.call_tool` calls have no request id. The predicate does not treat them as one logical request.
- Violating. One `denied` `mcp.call_tool` call has any linked `UsageRecord`, including a byte-quantity row. The predicate is violated.
- Violating. One terminal `mcp.call_tool` call other than `denied` has no tool-call `UsageRecord` on a complete ordered read. The predicate is violated. `recordRefs` lists that `CapabilityCall` id and does not invent a `UsageRecord` id.
- Violating. One `interrupted` `mcp.call_tool` call has no tool-call `UsageRecord` on a complete ordered read. The predicate is violated.
- Violating. One `unknown` `mcp.call_tool` call has no tool-call `UsageRecord` on a complete ordered read. The predicate is violated.
- Violating. One tool-call `UsageRecord` has a quantity other than `1`. The predicate is violated.
- Violating. One `succeeded` `mcp.call_tool` call has two tool-call `UsageRecord` rows. The predicate is violated.
- Order. A read collects an empty usage set, the producer then commits the usage row and the terminal finish, and a later read sees the succeeded call. Those observations resemble a missing row. They are not a violation, because the succeeded call never lacked its row. The check reads the terminal status before the linked usage rows, so it does not use that interleaving.
- Violating. The check reads a terminal succeeded status first and then finds no tool-call `UsageRecord`. The producer committed the usage row before finish, so the mismatch is a violation.
- Insufficient. The capability store cannot be read. The predicate is `unknown` with reason `unreadable`.
- Insufficient. The bound stops the scan during the read, before every terminal tool call is covered, and no violation is visible. The predicate is `unknown` with reason `incomplete`.
- Insufficient. The producer order is not established for a path, and the terminal status and the usage rows disagree. The predicate is `unknown` with reason `incomplete`.
- Empty. The Workspace has no `mcp.call_tool` row. This predicate passes. The pass does not prove that story 3 or story 7 ran.
- Outside. A Turn names a tool request id and the ledger has no matching call. The absent call is not a violation and does not make the predicate `unknown`.

The model-call predicate reads retained calls whose family is `llm`. One logical invocation is one `CapabilityCall`. A same-member retry stays on that call and does not open a second call. An unavailable route member creates no second `CapabilityCall` and no `UsageRecord`. One call may link several `UsageRecord` rows for distinct measurements.

The equivalent-measurement comparison is a projection of the usage owner's existing comparison. Two rows match when they agree on capability-call id, category, unit, quantity, model id, provider reference, source, and canonical source ids. Record id and recording time are not comparison fields. Two matching rows violate the predicate. Two rows that differ only in source do not match. Matching route entries cite that one retained row.

The check reads the stored route document before any lossy schema parse or public projection. An unavailable entry that carries any usage identifier is a violation, including an identifier a lossy schema would drop. Each measurement reference in an attempt entry must resolve to a retained `UsageRecord` linked to the same `CapabilityCall`. On a complete ordered read, an unresolved reference is a violation. `recordRefs` then lists only the existing `CapabilityCall` id. A reference that resolves to another call's row is a violation. `recordRefs` then lists the referencing `CapabilityCall` id and that existing `UsageRecord` id. The check does not invent an identifier. The check reads no raw prompt, provider response, or credential.

The producer commits usage rows and the route document before terminal finish. The check reads the terminal status and the stored route document first, then the linked `UsageRecord` rows. A mismatch in that order is `fail`. When the producer order is not established for a path, a mismatch is `unknown` with reason `incomplete`. A failed or `unknown` model call with no measurement does not prove that an available measurement was omitted. Absence of the route document is lawful. The predicate does not invent a route chain, and it does not treat that absence as completeness. When a request id is present, two retained `llm` calls with the same Workspace, request id, family, and operation violate the predicate. Two calls with no request id stay distinct.

Model-call fixtures:

- Positive. One `llm` call has status `succeeded`, one input-token `UsageRecord`, and one output-token `UsageRecord`. Its stored route document has one unavailable entry with no usage identifiers and one attempt entry that cites both rows of the same call. No second call exists. The call is consistent.
- Positive. One `llm` call has status `failed` and no `UsageRecord`. The call is consistent. The absence does not prove that an available measurement was omitted.
- Positive. One `llm` call has status `unknown` and no measurement. The call is consistent. The absence does not prove that an available measurement was omitted.
- Positive. No route-lineage document is stored. The absence is lawful.
- Positive. Two attempt entries cite one `UsageRecord` identifier. A second identical measurement is not stored. The call is consistent.
- Positive. Two `UsageRecord` rows for one call differ only in source. They are not equivalent duplicates.
- Violating. Two `UsageRecord` rows match on capability-call id, category, unit, quantity, model id, provider reference, source, and canonical source ids, and they differ in record id and recording time. The predicate is violated. `recordRefs` lists both `UsageRecord` ids.
- Violating. Two `llm` calls share one Workspace, request id, family, and operation. The predicate is violated.
- Violating. The check reads the stored route document before schema parse. That stored unavailable entry contains a usage identifier. The predicate is violated.
- Violating. The check reads the stored attempt entry before projection. Its measurement reference does not resolve to a retained `UsageRecord`. The result is `fail` with reason `violated`. `recordRefs` lists only that `CapabilityCall` id.
- Violating. The check reads the stored attempt entry before projection. Its measurement reference resolves to a `UsageRecord` of a different `CapabilityCall`. The result is `fail` with reason `violated`. `recordRefs` lists the referencing `CapabilityCall` id and that existing `UsageRecord` id.
- Violating. A second `CapabilityCall` exists for an unavailable route member. The predicate is violated.
- Order. A read collects an empty usage set, the producer then commits the usage row and the route document and then finishes the call, and a later read sees the succeeded call. That interleaving is not a violation. The check reads the terminal status and the stored route document before the linked usage rows.
- Insufficient. The usage store cannot be read. The predicate is `unknown` with reason `unreadable`. A malformed usage row that prevents evaluation has the same reason, unless another call in this name already violates, in which case the name is `fail`.
- Insufficient. The bound stops the read before the declared universe is covered, and no violation is visible. The predicate is `unknown` with reason `incomplete`.
- Insufficient. The producer order is not established for a path, and the terminal status and the measurements disagree. The predicate is `unknown` with reason `incomplete`.
- Outside. A public model call has no Workspace lineage and no retained call. The gap is not a violation.

### Terminal Turn Consistency

`terminal-turn-consistency` checks published terminal facts. Story 10 uses this name. The universe is each Turn whose canonical record has a terminal status and whose durable terminal event carries a `StopReason`. `pending` and `running` are not terminal. Every other canonical Turn status is terminal for this universe.

The check reads each Turn's durable event log at the existing complete durable event-read seam. It turns final-fragment repair off, so the read never writes. It keeps that seam's sequence-one check and its lineage validation. With repair off, an incomplete final fragment throws. The name is then `unknown` with reason `unreadable`, unless a violation in that name is already established. The read honors the record bound and the time bound while it reads. It does not load the whole file and then apply the bound. This is a read option at the existing seam, not a new reader. The check does not read the rolling in-memory window.

The Turn record has no `StopReason` field and no worker flag. The identifying shape is that durable event. The closed mapping applies to every Turn that carries a `StopReason` on it, not only to a Turn that still retains a Worker Checkpoint. Current writers of that event are the worker completion publisher, the worker failure publisher, and the simulator publisher. The simulator publisher writes `completed` for a completed Turn and `aborted` for an interrupted Turn. A Turn with no such event is outside the predicate.

The closed mapping is the reliability owner's initial terminal mapping. It does not depend on an adapter or mode projection. When a terminal checkpoint remains, the last two columns apply.

| Event StopReason | Turn status | Checkpoint stage | Checkpoint StopReason |
| --- | --- | --- | --- |
| `completed` | `completed` | `completed` | `completed` |
| `error` | `failed` | `failed` | `error` |
| `aborted` | `interrupted` | `aborted` | `aborted` |
| `length` | `completed` | `completed` | `length` |
| `budget_exhausted` | `completed` | `completed` | `budget_exhausted` |

The predicate passes when every stated fact holds. The event `StopReason` is a canonical Core value. It maps to the Turn status under the table. The Turn has at most one distinct canonical `StopReason`. Equivalent duplicate terminal events stay lawful. When a terminal checkpoint remains, its stage and its `StopReason` agree with the table. A `length` stop does not require Task success. A `budget_exhausted` stop does not require Task success.

The predicate fails when a complete read finds one terminal fact that contradicts another. The Turn status, the terminal event, and a terminal checkpoint stage do not change after they are written. A mismatch among them is not an observation artifact. A checkpoint that disappears between reads is absent. Absence is outside the comparison. Successful cleanup deletes the checkpoint. A cleared checkpoint plus an agreeing Turn and event is consistent. The result is not a check of all retained worker history. The predicate adds no historical checkpoint store.

An identifiable stored `turn.completed` envelope establishes `fail` with reason `violated` when its event type and its Turn lineage are readable and its `stopReason` is a readable string outside the closed Core values. The check uses that stored value, or the existing decoder's validation failure on that field, before the unreadable fallback. It does not widen the Core enum and it does not coerce the value. When the event type, the Turn lineage, or the reason cannot be read, the result stays `unknown` with reason `unreadable`, unless a violation in that name is already established.

The predicate does not judge closeout completeness, pending receipts, AgentSession state, evidence, or `recovery_required`. The reliability owner's classifier owns those states. A checkpoint preserved as `recovery_required` already degrades scheduler readiness through that owner. This predicate does not duplicate that signal. That preservation does not make a contradictory published tuple lawful. A contradiction among published terminal facts is `fail`.

These states are outside the predicate and carry no claim. A Turn that is not terminal is outside. A terminal Turn with no `StopReason` event is outside. A checkpoint at `preparing` or `running_worker` is outside the checkpoint comparison only. An eligible Turn and event pair is still evaluated. A terminal checkpoint whose Turn has no terminal publication yet is outside.

Terminal-turn fixtures:

- Positive. The Turn record status is `completed`. The durable `turn.completed` event carries `StopReason` `completed`. The retained checkpoint stage is `completed` and its `StopReason` is `completed`. The tuple is consistent.
- Positive. The Turn record status is `failed`. The durable event carries `StopReason` `error`. The retained checkpoint stage is `failed` and its `StopReason` is `error`. The tuple is consistent.
- Positive. The Turn record status is `interrupted`. The durable event carries `StopReason` `aborted`. The retained checkpoint stage is `aborted` and its `StopReason` is `aborted`. The tuple is consistent.
- Positive. The Turn record status is `completed`. The durable event carries `StopReason` `length`. The retained checkpoint stage is `completed` and its `StopReason` is `length`. The predicate does not require Task success.
- Positive. The Turn record status is `completed`. The durable event carries `StopReason` `budget_exhausted`. The retained checkpoint stage is `completed` and its `StopReason` is `budget_exhausted`. The predicate does not require Task success.
- Positive. The Turn record status is `completed`. Two durable `turn.completed` events each carry `StopReason` `completed`. No checkpoint remains. The equivalent duplicate events are lawful.
- Positive. The Turn record status is `completed`. The durable event carries `StopReason` `completed`. Cleanup has already deleted the checkpoint. The cleared checkpoint is outside the comparison. The pair is consistent.
- Violating. The Turn record status is `failed`. The durable event carries `StopReason` `length`. The retained checkpoint stage is `completed` and its `StopReason` is `length`. The Turn status conflicts with the mapping. The result is `fail` with reason `violated`. `recordRefs` lists the Turn id.
- Violating. The Turn record status is `failed`. The durable event carries `StopReason` `completed`. The retained checkpoint stage is `completed` and its `StopReason` is `completed`. The Turn status conflicts with the mapping.
- Violating. The Turn record status is `completed`. One durable event carries `StopReason` `completed` and another carries `StopReason` `error`. The two canonical values conflict.
- Violating. The Turn record status is `completed`. The stored envelope has event `turn.completed`, a readable Turn lineage for this Turn, and `stopReason` equal to the string `not-a-core-reason`. The check evaluates that field before the unreadable fallback. The result is `fail` with reason `violated`.
- Violating. The Turn record status is `completed`. The durable event carries `StopReason` `budget_exhausted`. The retained checkpoint stage is `failed` and its `StopReason` is `error`. The checkpoint disagrees with the published Turn. `recordRefs` includes the Worker Checkpoint id.
- Violating. The Turn record status is `completed`. The durable event carries `StopReason` `completed`. The retained checkpoint stage is `failed` and its `StopReason` is `error`, and the checkpoint is also preserved as `recovery_required`. The preservation does not make the contradiction lawful.
- Insufficient. The complete durable event log cannot be read. The predicate is `unknown` with reason `unreadable`.
- Insufficient. The stored row has event `turn.completed` but no readable Turn lineage. No other Turn in this name already violates. The result is `unknown` with reason `unreadable`.
- Insufficient. The event log ends with an incomplete final fragment. Repair is off, so the read throws. No other Turn in this name already violates. The result is `unknown` with reason `unreadable`. The file bytes are unchanged after the check.
- Positive. The event log's valid final row has no trailing newline. The Turn record status is `completed`. That row is a `turn.completed` event with `stopReason` `completed`. No other terminal event conflicts, and no terminal checkpoint remains. Repair is off, so the check reads the row and does not rewrite the file. The result is `pass`. The file bytes are unchanged after the check.
- Outside the comparison. A checkpoint disappears between two reads. Absence is not a violation. When the Turn record status is `completed` and the durable event still carries `StopReason` `completed`, the Turn stays consistent.
- Empty. No Turn has a terminal status and a durable `StopReason`. The predicate passes. The pass does not prove that story 10 ran.
- Outside. The Turn record status is `running`. The Turn is not in the universe.
- Outside. The Turn record status is `completed`. The complete durable history has no `turn.completed` event. The predicate makes no claim.
- Outside the checkpoint comparison. The Turn record status is `completed`. The durable history holds one `turn.completed` event with `stopReason` `completed`. The checkpoint stage is `preparing` and its `StopReason` is absent. The Turn and event agree, so the result is `pass`.
- Outside the checkpoint comparison. The Turn record status is `completed`. The durable history holds one `turn.completed` event with `stopReason` `completed`. The checkpoint stage is `running_worker` and its `StopReason` is absent. The Turn and event agree, so the result is `pass`.
- Outside. The Turn record status is `running`. The durable history holds no `turn.completed` event. The checkpoint stage is `completed` and its `StopReason` is `completed`. The Turn is not in the universe. The predicate makes no claim.
- Violating. The Turn record status is `failed`. The durable event carries `stopReason` `length`. The retained checkpoint stage is `running_worker`. The checkpoint is outside the comparison. The Turn and the event conflict. The result is `fail` with reason `violated`. `recordRefs` lists the Turn id.
- Outside. The Turn record status is `completed`. The durable event carries `StopReason` `completed`. The checkpoint stage is `completed` and its `StopReason` is `completed`, and the checkpoint is preserved as `recovery_required`. The published facts do not contradict. The predicate makes no claim about that preservation.

### Incidental Evidence

The operation is read-only for protected product state. [Policy Enforcement Mapping](20260703-policy_enforcement_mapping.md) says incidental redacted audit or usage evidence does not make a read-only operation a content mutation. This operation may record that same incidental evidence for the invocation. That evidence is not an integrity result. Its absence is not a predicate failure. The usage predicates exclude a call whose operation is `integrity.workspace.check`.

### Acceptance Predicates

A non-administrator receives the existing denial and no `results` entry. An invalid request produces no evaluation and no `pass`. A successful response contains each selected name once, with HTTP 200 and a JSON body. `outcome` follows the fold in this specification. The positive tool-call fixture and an empty model-call universe make `usage-attribution` `pass` when that name is selected. The zero-row `interrupted` tool-call fixture makes that name `fail` with reason `violated`. An unreadable capability store makes that name `unknown` with reason `unreadable`. Each closed mapping row makes `terminal-turn-consistency` `pass`. The conflicting `length` fixture makes that name `fail` with reason `violated`. The cleared-checkpoint fixture makes that name `pass`. A contradictory published tuple makes that name `fail` even when the checkpoint is preserved as `recovery_required`. When one selected name is `fail` and the other is `unknown`, `outcome` is `fail`. When one selected name is `unknown` and the other is `pass`, `outcome` is `unknown`. The inspected product records are unchanged, apart from incidental invocation evidence. The call does not contact an external system. The call does not read operational telemetry. The call does not read or change boot readiness. A `knowledge.health.check` report of `warn` does not by itself make this `outcome` `fail`. Product-owner tests at L1 to L3 build the fixtures in this specification. An L6 story names an invariant and does not reimplement the predicate.

## Proposed Design

One family table declares `integrity.workspace.check` with binding JSON, success status 200, `mutating` false, and `returnsOneTimeSecret` false. One transport-free handler evaluates the selected names. The handler calls the existing record reads and stops when a bound is reached. The event log uses the existing complete read seam with final-fragment repair off. It does not copy a second closeout classifier or a second usage writer. The operation composition includes the family table once.

## Current Implementation Projection

No implementation of `integrity.workspace.check` exists. The declaration should live in a browser-safe family module under the shared schema package. The join should live in NanoCore and should use the existing invocation seam. The JSON route, the Core Client method, the command-line catalog, and the remote Model Context Protocol tool are derived from that declaration. Those paths are projection, not the contract. The equivalent-measurement comparison is the existing `hasEquivalentUsageRecord` projection. The route document is the call's stored extensions, read before schema parse. The current `readWorkspaceTurnEvents` has no repair option and no bound option. Its loader passes repair true at `apps/nanocore/src/storage/workspace-file-records.ts` line 1543. The implementation adds a non-repairing read option with in-read bounds at that existing seam. Passing false only to the low-level helper does not give in-read bounds. `knowledge.health.check` remains the Knowledge health operation.

## Alternatives Considered

A new scope kind that means either deployment or Workspace. This draft uses one existing body Workspace selector instead. A stored check history. No consumer needs a history beyond the call response and the caller's own copy. A boot-time or readiness gate. Readiness already owns admission, and this check does not use it. A second derivation of the restart classifier. The reliability owner already has one classifier for online closeout, replay, and boot, so this draft compares published terminal facts only.

## Consequences

An administrator can call the operation as a normal remote Model Context Protocol tool. A Workspace member that is not an administrator is rejected. Stories 3 and 7 can name `usage-attribution`. Story 10 can name `terminal-turn-consistency`. Stories 1, 2, 4, 5, 6, 8, and 9 name neither invariant in this first set. `knowledge.health.check` remains callable.

## Rollout / Migration Plan

There is no retained-data migration. The operation is new. No existing operation id changes. Ship the operation with its L1 to L3 fixture tests in the same change. Story files name the invariants only when those files are written.

When the integrity family exists, the implementation adds the following sentences to the Current Implementation Projection of [Operation Definition](20261002-operation_definition.md). A Current Implementation Projection describes code that exists.

The integrity family composes one JSON operation, `integrity.workspace.check`, from a browser-safe family table, joins it through the existing invocation seam, and uses the body Workspace selector, administrator admission, and `audit.read`. The operation declares success status 200, binding JSON, `mutating` false, and `returnsOneTimeSecret` false.

## Testing Strategy / Acceptance Criteria

L1 tests cover the strict request, the closed status and reason pairs, rejection of an invalid pair, the unknown-name refusal, and the empty-array refusal. L2 tests cover the outcome fold, the denial of a Workspace member who is not an administrator, and the rule that a missing response is not `pass`. L3 tests build the positive, violating, order, and insufficient fixtures in this specification through the operation boundary. Those tests also show that the inspected records stay unchanged apart from incidental invocation evidence. The tests do not use operational telemetry or an external system as the oracle. The tests do not load an unbounded ledger and then apply the bound.

## Risks & Mitigations

A zero-row `interrupted` or `unknown` tool call can be mistaken for an unfinished read. Mitigation: on a complete ordered read that row is a violation, because contact cannot be excluded. A read that collects usage before the terminal status can manufacture a missing-row violation. Mitigation: the check reads the terminal status and the stored route document first. A lossy parse can hide a usage identifier on an unavailable route entry. Mitigation: the check reads the stored route document before schema parse or public projection. An unbounded ledger load can pass a bound only after the read finishes. Mitigation: the implementation enforces the bound while it reads. An incidental usage row could be mistaken for a tool call. Mitigation: the usage universe excludes this operation's own call.

## Open Questions

No blocking question remains. The engineer accepted the Workspace scope, the administrator admission rule, and the first invariant set. [Product Integrity Check](../decisions/20261012-product_integrity_check.md) records those decisions.

## Deferred / Future Work

A deployment-scoped operation waits until a present invariant needs it. No scheduled check is added. No repair operation is added. No retention detector is added ahead of the audit-usage owner's disposition.

## Links

- [Operation Definition](20261002-operation_definition.md)
- [Policy Enforcement Mapping](20260703-policy_enforcement_mapping.md)
- [Worker MCP Tool Supply](20260704-worker_mcp_tool_supply.md)
- [Capability Usage Gateway Foundation](20260704-capability_usage_gateway_foundation.md)
- [Audit, Usage, and Evidence Records](20260703-audit_usage_evidence_records.md)
- [Worker Turn Reliability Envelope](20260531-worker_turn_reliability_envelope.md)
- [NanoCore Bootstrap and Readiness](20260704-nanocore_bootstrap_readiness.md)
- [Knowledge Manager Internal Agent Runtime](20260704-knowledge_manager_internal_agent_runtime.md)
- [L6 Story Acceptance](20260529-l6_story_acceptance.md)
- [Contract Evolution](../core/contract-evolution.md)
- [Product Integrity Check](../decisions/20261012-product_integrity_check.md)
