---
date: "2026-10-30"
---
# Independent Documentation Audit: Protocol And Communication Answers

This non-authorizing record answers the protocol and communication questions in the [independent audit](20261023-independent_doc_audit.md) and its [supplement](20261025-independent_doc_audit_supplement.md). Its owning rule is [Change Execution Governance](../change-execution.md). It records answers, documentation corrections, issue drafts, and escalations. It does not authorize design.

## Scope

- Original current-main evidence base: `0be853326bbd8575e5448b65759c269d67691328`, fetched from the upstream main branch on 2026-10-30.
- Q-43 and Q-187 amendment evidence: current upstream main `31b5fd8ff17d642cdcbf0cfed5916d8f2066569c`, fetched on 2026-10-30. Other accepted answers retain their original evidence base.
- Questions: Q-29 through Q-46 and Q-185 through Q-188. D means delegated answer, D* means verified settled consensus, and O means an existing owner settles the rule.
- Landing designation: "Answered by coordinator and consultant consensus under the engineer's delegation of 2026-10-30". The coordinator accepted the other answers and resolved Q-43 and Q-187 as D in this amendment.
- Edits cover only protocol and communication documents, this record, and the generated index. Held owners and other groups are unchanged. No code, credential, identifier allocation, migration, publication, or release-scope change is applied.
- Q-23, Q-28 and Q-189 retain their delegated sweeps. Q-37 directly names the property of its own existing receipt default; no other numeric sweep runs here.
- The answer table maps the old current-main criteria to each changed owner. Identifier spelling and enum additions preserve the existing values and producers. The receipt paragraph preserves the exact duration, exceptions, expiry comparison and recovery refusal. The Thread corrections preserve Workspace deletion and request closeout.
- Harness operation identity keeps sequence, redacted inputs, credential exclusions, dispatch and replay fences; only the binding description changes. The concurrency correction retains per-AgentSession exclusion and admitted aggregate capacity. Quarantine eligibility follows the supplied consensus, and remote MCP exclusions follow existing binding declarations.
- Changes: eight files, including six owning documents across two groups, one audit record and the generated index. Five existing enum lists are documented; no enum value, registry, record or field is introduced.
- Amendment verification: `node scripts/generate-doc-index.mjs` passed again. Under Node 24.18.0, the required `bash scripts/test-env.sh any bash -c 'node scripts/validate-spec-lifecycle.mjs && node scripts/validate-story-schema.mjs && node scripts/validate-doc-model.mjs'` passed again: lifecycle metadata, 10 stories and 687 documents. The initial missing-dependency setup failure and a relative link in quoted replacement text were corrected before the passing run.

## Answers

Evidence citations for Q-43 and Q-187 refer to the amendment base; other citations retain the original base, before this batch's edits. Every question has exactly one primary fix type; related code follow-ups do not reclassify a documentation correction. Counts: DOC 17; CODE 3; HELD 0; NONE 2; ESCALATE-E 0.

| Question | Answer | Fix type | Documents changed |
| --- | --- | --- | --- |
| Q-29 (D) | Use the retained `knowledge-injection` Item and `knowledge-injection-updated` delta names. Correct the documents without renaming or migrating retained events. Evidence: `docs/core/protocol.md:300`; `docs/specs/20260703-knowledge_store_implementation.md:265`; `packages/protocol/src/models/item.ts:43`; `packages/protocol/src/common/item-delta.ts:17` | DOC | `docs/core/protocol.md`, `docs/specs/20261021-protocol_identifiers_and_enums.md` |
| Q-30 (D) | List `generative-ui-reference` with `snapshot-updated` and `context-summary` with no deltas. Both are already admitted Item types. Evidence: `docs/specs/20261021-protocol_identifiers_and_enums.md:170`; `docs/specs/20260908-generative_ui_interaction.md:208`; `packages/protocol/src/models/item.ts:96`; `packages/protocol/src/events/envelope.ts:115` | DOC | `docs/specs/20261021-protocol_identifiers_and_enums.md` |
| Q-31 (D) | Require stable machine-readable codes and permit flat Core command codes. Keep the namespace reservations for namespaced codes. Evidence: `docs/core/protocol.md:562`; `docs/core/protocol.md:574`; `docs/core/protocol.md:645` | DOC | `docs/core/protocol.md` |
| Q-32 (D) | Add the five existing closed value lists: Workspace status, Thread status, Item status, terminal-event stop reason, and Turn trigger-source kind. This adds no status or producer. Evidence: `packages/protocol/src/models/workspace.ts:47`; `packages/protocol/src/models/thread.ts:26`; `packages/protocol/src/models/item.ts:22`; `packages/protocol/src/models/turn.ts:80`; `packages/protocol/src/models/turn.ts:105` | DOC | `docs/specs/20261021-protocol_identifiers_and_enums.md` |
| Q-33 (D) | Delta producers preserve correlations within each Item; conformance fixtures check preceding part creation and matching request resolution. Do not add a stateful ingest mechanism. Evidence: `docs/core/protocol.md:325`; `docs/specs/20261021-protocol_identifiers_and_enums.md:202`; `docs/specs/20261021-protocol_identifiers_and_enums.md:210`; `packages/protocol/src/events/envelope.ts:180`; `packages/protocol/src/events/envelope.ts:253` | DOC | `docs/specs/20261021-protocol_identifiers_and_enums.md` |
| Q-34 (D) | Name the existing Discord and NanoHost exclusions and their owners; remove nonexistent test-support routes. The historical `/internal` facade is absent, so omit that unowned wildcard and draft its coverage-test cleanup. Evidence: `docs/specs/20260704-app_api_openapi_projection.md:94`; `apps/nanocore/src/openapi.test.ts:48`; `apps/nanocore/src/llm-gateway.test.ts:293` | DOC | `docs/specs/20260704-app_api_openapi_projection.md` |
| Q-35 (D*) | Verified the settled answer: authenticated readers may fetch the secret-free OpenAPI document. Replace the ambiguous diagnostics comparison. Evidence: `docs/specs/20260704-app_api_openapi_projection.md:102`; `apps/nanocore/src/app.ts:2092`; `apps/nanocore/src/auth/middleware.ts:201` | DOC | `docs/specs/20260704-app_api_openapi_projection.md` |
| Q-36 (D) | Derive authorization route identity directly from the catalog and operation definitions. Reading generated OpenAPI reverses the accepted projection direction and remains a code defect. Evidence: `docs/specs/20260704-app_api_openapi_projection.md:10`; `docs/specs/20260704-app_api_openapi_projection.md:48`; `apps/nanocore/src/auth/operation-authorizer.ts:1253` | CODE | None |
| Q-37 (O) | The existing owner provides a bounded command-retry window, with seven days already the default. Name that property and preserve the exact expiry and in-progress exception rules. Evidence: `docs/core/protocol.md:548`; `docs/core/protocol.md:572`; `apps/nanocore/src/storage/command-request-records.ts:821`; `docs/writing.md:25` | DOC | `docs/core/protocol.md` |
| Q-185 (D) | Use the existing Protocol and Core Client owners for cursor semantics and HTTP/SSE projection. Document initial cursor zero, Workspace versus Server envelopes, UUID command identity, current framing and absence of Server SSE, without inventing transport limits or routes. Evidence: `docs/core/protocol.md:439`; `docs/specs/20260703-storage_layout_record_ownership.md:224`; `apps/nanocore/src/turn-event-routes.ts:31`; `apps/nanocore/src/turn-event-routes.ts:105`; `packages/protocol/src/events/envelope.ts:628`; `packages/protocol/src/common/ids.ts:68` | DOC | `docs/core/protocol.md`, `docs/specs/20261021-protocol_identifiers_and_enums.md`, `docs/specs/20260704-app_api_openapi_projection.md`, `docs/specs/20260528-core_client_boundary.md` |
| Q-186 (D) | Include the existing Thread update command and its `name`/`status` inputs; resume means re-entry and has no separate operation. Keep current not-found behavior, add no revision field, and remove claims of standalone Thread deletion while retaining Workspace deletion semantics. Evidence: `docs/core/protocol.md:197`; `docs/core/protocol.md:538`; `packages/protocol/src/requests/thread.ts:20`; `packages/app-api-schemas/src/thread-operations.ts:34`; `apps/nanocore/src/thread-routes.ts:233` | DOC | `docs/core/protocol.md`, `docs/specs/20260528-core_client_boundary.md` |
| Q-187 (D) | State the existing producer split under the accepted decision: caller-cancelled Knowledge Manager and maintenance runs, and worker cancellation before backend effects, publish `cancelled` with `stopReason=aborted`. Worker abort completion publishes `interrupted` with `aborted`; add the Core clarification and route the owner, integrity-check and held corrections without adding a state, reason or producer. Evidence: `docs/decisions/20260921-four_turn_terminal_states.md:10`; `apps/nanocore/src/internal-agents/knowledge-manager-agent.ts:495`; `apps/nanocore/src/knowledge/knowledge-agent-maintenance.ts:656`; `apps/nanocore/src/knowledge/user-memory-agent-maintenance.ts:348`; `apps/nanocore/src/turn-routes.ts:391`; `apps/nanocore/src/turn-routes.ts:414`; `apps/nanocore/src/lib/store.ts:5190`; `apps/nanocore/src/runtime/worker-control-records.ts:130` | DOC | `docs/core/protocol.md` |
| Q-188 (D*) | Verified the settled answer: PendingRequest owns the winner and retains the actual deciding administrator separately from the requester. Align Core eligibility and supply the remaining Multi-User projection corrections as CROSS-PART. Evidence: `docs/specs/20260930-pending_requests.md:155`; `docs/specs/20260930-pending_requests.md:268`; `docs/specs/20260930-pending_requests.md:270`; `docs/specs/20260715-multi_user_workspace_system.md:377`; `apps/nanocore/src/runtime/pending-requests.ts:327` | DOC | `docs/core/protocol.md` |
| Q-38 (D) | Populate the existing structured audit authentication summary from the verified Token actor. The existing evidence owner already requires available credential identity; no new field or audit format is needed. Evidence: `docs/core/evidence.md:83`; `docs/core/evidence.md:115`; `apps/nanocore/src/remote-mcp-routes.ts:220`; `apps/nanocore/src/auth/audit-attribution.ts:5` | CODE | None |
| Q-39 (D) | Deliver already validated queued events before surfacing the validation error once, then return done. Abort transport and reconnect immediately on the invalid event; do not advance its cursor or deliver it. Evidence: `docs/specs/20260528-core_client_boundary.md:185`; `docs/core/protocol.md:496`; `packages/core-client/src/events.ts:237`; `packages/core-client/src/events.ts:374`; `packages/core-client/src/events.ts:428` | CODE | None |
| Q-40 (D) | Use the Harness binding reference, operation sequence, operation literal, and canonical redacted body as the existing operation-id inputs. The binding identifies the admitted Harness; change no persisted identity. Evidence: `docs/specs/20260703-worker_control_protocol.md:255`; `apps/nanocore/src/runtime/nanohost-harness-records.ts:355`; `apps/nanocore/src/runtime/nanohost-harness-records.ts:1826` | DOC | `docs/specs/20260703-worker_control_protocol.md` |
| Q-41 (D) | Correct the stale projection to one active Turn per AgentSession within the admitted Harness `maxActiveTurns` bound. Scheduler admission and aggregate capacity stay with the scale owner. Evidence: `docs/specs/20260703-worker_control_protocol.md:275`; `docs/specs/20260703-worker_control_protocol.md:514`; `docs/specs/20260703-runtime_scheduling_scale.md:59`; `packages/worker-shim/src/harness.ts:466` | DOC | `docs/specs/20260703-worker_control_protocol.md` |
| Q-42 (D*) | Verified the settled answer: persist quarantine evidence only after authenticated, lineage-bearing admission. Clarify the document and retain a code follow-up because parsed unauthenticated requests can still write rows. Evidence: `docs/specs/20260703-worker_control_protocol.md:431`; `apps/nanocore/src/runtime/worker-control-routes.ts:98`; `apps/nanocore/src/runtime/worker-control-routes.ts:484`; `apps/nanocore/src/runtime/worker-control-rejected-evidence.ts:76` | DOC | `docs/specs/20260703-worker_control_protocol.md` |
| Q-43 (D) | Option B: the 1000 ms start-to-start maximum applies only between polls while no command handling or result acknowledgement is in flight. An in-flight operation on any Harness delays the next poll up to that operation's existing request allowance; serial proof and existing bounds remain unchanged. Evidence: `docs/specs/20260703-worker_control_protocol.md:244`; `docs/specs/20260703-worker_control_protocol.md:329`; `docs/decisions/20261020-harness_carriage_deadline.md:10`; `docs/decisions/20261020-harness_carriage_deadline.md:20`; `packages/worker-shim/src/harness.ts:801`; `packages/worker-shim/src/harness.ts:835` | DOC | `docs/specs/20260703-worker_control_protocol.md` |
| Q-44 (O) | The writing owner already requires property-backed current defaults. No separate edit belongs here: the delegated Q-23 sweep owns remaining timing-number corrections. Evidence: `docs/writing.md:25`; `docs/specs/20260703-worker_control_protocol.md:244`; `docs/specs/20260703-worker_control_protocol.md:329` | NONE | None |
| Q-45 (O) | Undefined plan and host labels remain for the delegated Q-28 sweep. Do not add or redefine those labels in this batch. Evidence: `docs/specs/20260703-worker_control_protocol.md:87`; `docs/specs/20260703-worker_control_protocol.md:95`; `docs/specs/20260703-worker_control_protocol.md:540`; `docs/writing.md:64` | NONE | None |
| Q-46 (D) | Exclude every declared one-time-secret result and every non-JSON binding. This covers the existing streams, including backup download, without another enumerated operation list. Evidence: `docs/specs/20261002-remote_mcp_interface.md:144`; `docs/specs/20261002-remote_mcp_interface.md:165`; `packages/app-api-schemas/src/operation-contract.ts:195` | DOC | `docs/specs/20261002-remote_mcp_interface.md` |

### Consensus Amendment Evidence

Q-43 is D, option B. The serial rule already owns the exception; the cadence edit adds no priority path or request allowance. Cross-Harness interrupt priority is deferred until a measured need. The coordinator files that deferral as an after-v0.1.0 issue.

Q-187 is D. The accepted decision delegates producer mappings to their owning specifications. Current-main inspection found the following paths; this is evidence, not a new producer inventory or authority.

| Existing path | Turn outcome and terminal publication | Current-main evidence |
| --- | --- | --- |
| Knowledge Manager run, caller signal aborted before terminalization | `cancelled`; `updateRunTurn` calls `completeTurn`, which publishes `turn.completed`, data type `turn-completed`, with `stopReason=aborted`. Without caller cancellation, the failure path writes `failed` with `error`. | `apps/nanocore/src/internal-agents/knowledge-manager-agent.ts:115`, `:495`; `apps/nanocore/src/lib/store.ts:5190` |
| Notebook maintenance failure closeout, caller signal aborted and Turn still nonterminal | `cancelled`; native `updateTurn` delegates to terminal publication with `aborted`. In-memory `updateTurn` alone writes the status without a terminal event. | `apps/nanocore/src/knowledge/knowledge-agent-maintenance.ts:644`; `apps/nanocore/src/lib/store.ts:5048`, `:5069`, `:5190` |
| User Memory maintenance failure closeout, caller signal aborted and Turn still nonterminal | `cancelled`; `record` calls `completeTurn`, publishing the same terminal event with `aborted`. | `apps/nanocore/src/knowledge/user-memory-agent-maintenance.ts:325`, `:348`; `apps/nanocore/src/lib/store.ts:5190` |
| Worker interrupt with queued or denied admission and no execution attempt | `cancelled`; the governed-worker terminal publisher explicitly supplies `aborted` to `completeTurn`. | `apps/nanocore/src/turn-routes.ts:380`; `apps/nanocore/src/runtime/worker-turn-failure.ts:207`, `:227` |
| Worker interrupt with an open attempt and no backend operation | `cancelled`; the same publisher supplies `aborted` after closing the attempt without effects. | `apps/nanocore/src/turn-routes.ts:398`; `apps/nanocore/src/runtime/worker-turn-failure.ts:227` |
| Worker abort completion or cancellation-owned failure closeout after execution | `interrupted`, with `aborted`; worker transport status and Task mode state are not separate Turn producers. | `apps/nanocore/src/runtime/worker-control-records.ts:130`; `apps/nanocore/src/runtime/worker-governance-turn-executor.ts:4317`, `:4570` |

The `cancelled` paths above do not produce a terminal Worker Checkpoint. Existing `preparing` checkpoints remain outside terminal checkpoint comparison; the reliability owner's worker-abort mapping stays unchanged. No new terminal event or stop reason is proposed.

## Code Issues

These are drafts only; no issue was filed and no code changed.

### Q-34 follow-up (primary fix type DOC)

Title: [openapi] Remove the unowned historical internal-route coverage exemption
- Defect: the coverage test accepts arbitrary `/internal` routes although the historical facade is absent.
- Evidence: `apps/nanocore/src/openapi.test.ts:50`; `apps/nanocore/src/llm-gateway.test.ts:293` expects the former route to return 404.
- Fix: remove that unused exemption; a future route must name an accepted owner and its actual coverage classification.
- Validation: the coverage test still admits every mounted route and refuses an unregistered route outside the owned exclusions.

### Q-36

Title: [authorization] Derive App route identity without reading generated OpenAPI
- Defect: the authorizer rebuilds its route map from the generated document, reversing the accepted source direction.
- Evidence: `apps/nanocore/src/auth/operation-authorizer.ts:1253`; `docs/specs/20260704-app_api_openapi_projection.md:10` and `:48`.
- Fix: derive method and path from the existing catalog and definition-owned bindings, preserving direct-route precedence and duplicate rejection.
- Validation: existing routes receive the same guards without creating or reading an OpenAPI document.

### Q-38

Title: [remote-mcp] Retain structured Token identity on the request AuditEvent
- Defect: the remote MCP request audit stores the Token id only in summary text.
- Evidence: `apps/nanocore/src/remote-mcp-routes.ts:220`; `docs/core/evidence.md:115` owns the existing authentication summary.
- Fix: supply `authentication` through `auditAuthenticationFromActor(actor)`; preserve the actual User, action, outcome and request identity.
- Validation: the request AuditEvent has credential kind `token` and the verified Token record id, with no secret or new channel field.

### Q-39

Title: [core-client] Drain validated events before reporting a stream validation failure
- Defect: both stream transports clear admitted queued events, and the iterator prioritizes the error over queued values.
- Evidence: `packages/core-client/src/events.ts:237`, `:374`, and `:428`; the delivery boundary is `docs/specs/20260528-core_client_boundary.md:185`.
- Fix: retain only the events admitted before failure, deliver them in order, reject once after they drain, then return done.
- Validation: Fetch and EventSource stop immediately, never deliver the invalid event or advance its cursor, and perform no automatic reconnect.

### Q-42 follow-up (primary fix type DOC)

Title: [worker-control] Require authenticated lineage before retaining quarantine evidence
- Defect: a parsed request can create a quarantine row after token or lineage authentication fails.
- Evidence: `apps/nanocore/src/runtime/worker-control-routes.ts:98` and `:484`; the writer at `worker-control-rejected-evidence.ts:76` trusts caller-provided lineage.
- Fix: retain quarantine rows only from proved authenticated lineage, not merely a parsed body or an HTTP status classification.
- Validation: unauthenticated, mismatched-lineage, schema and size refusals write no quarantine row; admitted sequence or evidence failures retain redacted evidence.

## Held Fixes

No held document was edited. Q-187 has the following HELD correction for coordinator routing; its primary fix type remains DOC because Core Protocol is corrected here.

### CROSS-PART / HELD: Q-187 Work Data Retention

In `docs/specs/20260921-work_data_retention_format.md:851`, replace the bullet about unifying the two live denial paths with:

```markdown
- The [four-terminal-state decision](../decisions/20260921-four_turn_terminal_states.md) retains `completed`, `interrupted`, `cancelled`, and `failed`, and delegates each producer's terminal mapping to its owning specification. The split between `cancelled` and `interrupted` is not an open format decision; this specification does not unify their producers.
```

### CROSS-PART: Q-187 Product Integrity Check

In `docs/specs/20261012-product_integrity_check.md:151`, replace the sentence listing current terminal-event writers with:

```markdown
Current writers include the worker completion publisher, the worker failure publisher, the simulator publisher, and the shared terminal publisher used by Knowledge Manager and maintenance runs. Caller-cancelled Knowledge Manager and maintenance runs, and worker cancellation before backend effects, publish `cancelled` with `aborted`; worker abort completion publishes `interrupted` with `aborted`.
```

At line 153, replace `The closed mapping is the reliability owner's initial terminal mapping.` with:

```markdown
The closed mapping includes the reliability owner's initial worker terminal mapping and the existing `cancelled` outcomes below. Under the [four-terminal-state decision](../decisions/20260921-four_turn_terminal_states.md), each owning specification decides its producers. The listed `cancelled` paths produce no terminal Worker Checkpoint; absence and a `preparing` checkpoint remain outside checkpoint comparison under the rules below.
```

Add this row after the `aborted` / `interrupted` row at line 159:

```markdown
| `aborted` | `cancelled` | Not produced by these paths | Not produced by these paths |
```

### CROSS-PART: Q-187 Knowledge Manager

In `docs/specs/20260704-knowledge_manager_internal_agent_runtime.md:151`, after `The Turn ends on its terminal typed result, cancellation or the shared runtime's limits.`, insert:

```markdown
Caller cancellation terminalizes a still-nonterminal Knowledge Manager Turn as `cancelled`. Its canonical `turn.completed` event carries a `turn-completed` payload with `stopReason=aborted`. The same outcome applies when caller cancellation ends a still-nonterminal notebook or User Memory maintenance Turn through failure closeout. A role deadline without caller cancellation produces `failed` with `stopReason=error`. These producer mappings follow the [four-terminal-state decision](../decisions/20260921-four_turn_terminal_states.md); worker abort completion remains with the worker reliability owner.
```

### CROSS-PART: Q-29

- `docs/core/mediation.md:167`: replace the Item name `` `context-injection` `` with `` `knowledge-injection` ``.
- `docs/specs/20260703-worker_agent_capability.md:282`: replace `context-injection item` with `` `knowledge-injection` Item ``.
- In that specification at line 369, replace `through context-injection, tool-call, worker-output citation, or explicit product projection` with ``through a `knowledge-injection` Item, a tool-call Item, worker-output citation, or explicit product projection``.

### CROSS-PART: Q-186

In `docs/specs/20260930-pending_requests.md:183`, replace `Archive or deletion of the Thread, which are the operations that close a Thread, deletion of the Workspace` with `Archive of the Thread, deletion of the Workspace`. In the same paragraph, replace `The command that archives or deletes a Thread, or deletes a Workspace` with `The command that archives a Thread or deletes a Workspace`. Keep all remaining invalidation and closeout conditions.

At line 252, replace `Deleting a Thread or a Workspace deletes its requests with its history under the deletion owner and writes no Item.` with `Deleting a Workspace deletes its Threads' requests with their history under the deletion owner and writes no Item.` The missing/deleted-record refusal in native reservation remains required.

### CROSS-PART: Q-188

In `docs/specs/20260715-multi_user_workspace_system.md:375`, replace the sentence beginning `An Approval decision Item is a non-authoritative projection` with the exact text below:

```markdown
An Approval decision Item projects the winning PendingRequest resolution and its actual deciding actor under [Pending Requests](20260930-pending_requests.md#canonical-load-validation). A retrier's current session supplies no replacement identity.
```

Replace the Policy Approval winner table row at line 377 with:

```markdown
| Policy Approval winner | [Pending Requests](20260930-pending_requests.md#canonical-load-validation) owns the winning resolution, actual deciding actor, and request lineage. PermissionDecision and linked immutable AuditEvent records retain their policy and audit evidence; neither is a second winner. | Request admission, single-winner resolution, exact replay, claims, execution, publication, and fail-closed canonical load follow Pending Requests. Policy and audit owners retain their required linked evidence. Items and receipts remain projections and never reconstruct a missing or contradictory request winner. |
```

The Pending Requests parties predicate already preserves the actual deciding administrator on current main. This settled answer adds no identifier kind or derivation; captured-call digest wording remains with the Q-189 sweep.

## Escalated

None. Coordinator consensus resolves Q-43 and Q-187 as D answers with DOC fixes. Existing CODE drafts and CROSS-PART items remain for the coordinator to file and route.
