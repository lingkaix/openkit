---
date: "2026-10-24"
---
# Independent Documentation Audit: Communication Group

This non-authorizing record holds the communication group of the [independent documentation audit](20261023-independent_doc_audit.md). Its owning rule is [Change Execution Governance](../change-execution.md). It records observations, dispositions, and questions. It does not authorize design.

## Scope And Base

- Group base SHA: `05140a42f8b6aef63b399c259677ff2873307e6b` (`main` on 2026-10-24). Issue #440 had no comments and held no group in this scope.
- Core document: `docs/core/communication.md`.
- Specifications: `20260703-worker_control_protocol.md`, `20261002-remote_mcp_interface.md`, and `20260528-core_client_boundary.md`.
- Cited decisions read: `20261006-execution_backend_port_in_nanocore.md`, `20261016-retire_stateless_quick_chat.md`, and `20261015-discord_first_and_desktop_deferred.md` (through the Core text).
- G3 inspection: two read-only inspector contexts (CM-WCP for worker control; CM-RC for remote MCP and the Core Client). They read code only and ran no tests. The auditor verified each kept finding against the code.

## G2 Core Against Specifications

- CM-G2-01: `communication.md` lists the downward worker-control operations as open, inspect, close, start, interrupt, and drain. The worker-control specification adds `turn.steer`, which is not implemented. Core is silent on steer, which is not a conflict.
- CM-G2-02: the "common channel contract" that `communication.md` names has no owning specification. This is G1-TD-01, already recorded in the summary.
- No other conflict was found. The specifications cite Communication for planes, transports, and stream projection and do not redefine them.

## G3 Specifications Against Implementation

| Finding | Clause | Evidence (at the group base SHA) | Adjudication | Action |
| --- | --- | --- | --- | --- |
| CM-WCP-03 | Authentication: NanoHost rejects client `authorization`, `x-openkit-integration-binding`, or `x-openkit-harness-binding` and adds one binding value | `apps/nanohost/src/nanocore_session.rs:157-180` compares the path with its query and never checks `x-openkit-harness-binding`; lines 214-221 forward client headers; `apps/nanocore/src/runtime/nanohost-session-dispatch.ts:1720,1745` classifies by the path without the query | Code differs from a current accepted document | Issue #463 (blocking candidate: authorization) |
| CM-WCP-01, 02, 10 | Artifact notice fields; heartbeat not persisted; final status fields | `apps/nanocore/src/runtime/worker-control-routes.ts:33-41`; `apps/nanocore/src/runtime/worker-control-gateway.ts:831` and `apps/nanocore/src/runtime/worker-control-rebuild.ts:214`; `packages/worker-protocol/src/index.ts:617-624` | Code differs from a current accepted document | Issue #464 |
| CM-WCP-04 | Harness `operationId` hashes the Sandbox Integration binding and the Harness Instance identity | `apps/nanocore/src/runtime/nanohost-harness-records.ts:1069-1075` hashes the Harness binding ref, sequence, operation, and body | No record decides the input set | Question Q-40 |
| CM-WCP-05 | Projection: "One active Turn per Harness is the current implementation and this change's rule" | `packages/worker-shim/src/harness.ts:467-469` refuses a second Turn per AgentSession and caps the Harness at `maxActiveTurns`; the specification itself sets that bound | Inside-document conflict; the scheduler side is held | Question Q-41 |
| CM-WCP-06 | Projection: `app.ts` projects the routes | `apps/nanocore/src/runtime/worker-control-routes.ts:62,109,158,205,270,338` registers them; `app.ts` calls the registrar | Projection drift | Corrected |
| CM-WCP-07 | Projection paragraph: `scheduler-records.ts` stores token bindings; a lease `releasing` state; worker command enqueue of `interrupt` | Token hashes are bound in `apps/nanocore/src/runtime/nanohost-attempt-records.ts:441`; attempt phases are `open`, `closing`, `closed` (`apps/nanocore/src/runtime/execution-attempt-records.ts:42`); no `releasing` state or command enqueue in production code | Document outdated by [the execution backend decision](../decisions/20261006-execution_backend_port_in_nanocore.md), which replaced leases with the queue and private attempt | Corrected, with the decision cited; the paragraph stays in Resolved Decisions (G4 note) |
| CM-WCP-08 | Failed verification stores quarantined evidence | `worker-control-routes.ts` logs schema and size failures without a row; `apps/nanocore/src/runtime/worker-control-rejected-evidence.ts:73-102` stores only lineage-bearing rejections, including 401 rejections with caller-claimed lineage | No record decides which failures are stored | Question Q-42 |
| CM-WCP-09 | Serial Harness poll loop and a 1000 ms maximum poll interval while a Turn is active | `packages/worker-shim/src/harness.ts:790-860` awaits each command before the next poll; `nativeOpenMs` is 60 s | The two clauses cannot both hold under load | Question Q-43 |
| CM-WCP matches | Token families and hashes, envelope `schemaVersion` 2, seven final statuses, size caps, sequence rules, retry budget, Harness poll and result envelopes, adapter registry | `worker-control-gateway.ts`, `worker-control-sequences.ts`, `harness-control.ts` | Match | None |
| CM-RMCP-01 | Request audit records the User, the Token id, and the channel | `apps/nanocore/src/remote-mcp-routes.ts:219-227` puts the Token id in the summary text and sets no structured `authentication` field | Met in text; no record decides the structured field | Question Q-38 |
| CM-RMCP-02 | Projection lists the refusals | `remote-mcp-routes.ts:184-189` refuses a mutating call with `product_work_unavailable` when boot readiness does not accept product work | Projection drift | Corrected |
| CM-RMCP-03 | Projection: one-time-secret results and the three archive streams are omitted | `packages/app-api-schemas/src/operation-contract.ts:195` omits every non-JSON binding, which includes three Artifact file streams (`packages/app-api-schemas/src/artifact-operations.ts:90,132,145`) and two Knowledge package streams (`packages/app-api-schemas/src/knowledge-package-operations.ts:22,35`) | Projection drift; the contract list at line 165 now differs from the code | Projection corrected; the contract list is Question Q-46 |
| CM-RMCP-04, 05 | `implementation: Partial`; plaintext refusal shape | Lines 124 and 191 keep browser OAuth resource-server work for this endpoint | Match | None |
| CM-CCB-01 | Client Shape lists `client.core` and `client.app` members that moved | `packages/core-client/src/core.ts:23-31` has only `meta` and the Thread event stream; `packages/core-client/src/app.ts:70-80` has only the three archive streams; `packages/core-client/src/client.ts:26-29` adds `artifactFiles` and `conversationFiles` | Document outdated by the definition-table cutover that the same specification and [Operation Definition](../specs/20261002-operation_definition.md) record; the file streams follow [Work Resource Interaction](../specs/20260713-work_resource_interaction_model.md) and the conversation file submission owner, and the namespace name is client projection detail that this specification keeps | Corrected; the provider-subscription bullet now also names auto-top-up, Codex settings, and account use-reset |
| CM-CCB-02 | "eleven provider-subscription operations" | 13 ids in `packages/app-api-schemas/src/provider-subscription-operations.ts`; the two extra operations are specified in `20260721-provider_subscription_accounts.md:220-221` | Document outdated by a later accepted specification | Corrected to thirteen |
| CM-CCB-03 | "four Automation" operations | Five in `packages/app-api-schemas/src/automation-operations.ts` | Projection drift | Corrected to five |
| CM-CCB-04 | Legacy Goal methods "may still" exist; hand-maintained mappings "remain" | No Goal method in `packages/core-client/src`; only archive, meta, auth, and file streams are hand-maintained | Projection drift | Corrected |
| CM-CCB-05 | Retained hand-maintained empty delete methods return `void` | No such method has a caller; `packages/core-client/src/transport.ts` keeps four unused helpers | Projection drift | Clause removed; the cleanup is issue #465 |
| CM-CCB-06 | Future Slices lists Vault as out of the client | `packages/app-api-schemas/src/operation-definitions.ts:58` composes the Vault definitions into `client.operations` | Projection drift | Vault removed from the list |
| CM-CCB-07 | An invalid envelope rejects the failing read and the next read returns `done` | `packages/core-client/src/events.ts:176-178,405-409` also discards queued valid events | No record decides it | Question Q-39 |
| CM-CCB other | "Quick Chat" as a live operation and schema family | No `chat.quick` definition or schema | Document outdated by [Retire Stateless Quick Chat](../decisions/20261016-retire_stateless_quick_chat.md) | Removed from the projection and the schema-family list; the count "eleven" in the same projection sentence is removed because no grouping of the current Workspace, Thread, and Turn definitions gives eleven (the protocol group found the same count in the OpenAPI projection, PR-OAS-03) |

## G4 Organization

No move, merge, or split is applied. The worker-control "Current implementation projection" paragraph sits inside Resolved Decisions; it belongs in the Current Implementation Projection section. The move is left for the engineer because the paragraph also holds the still-unverified one-Turn-per-Harness claim (Q-41).

## G5 Writing

- Experience-chosen numbers in the worker-control specification without a current-default marking (300 seconds, 1,250 ms, five minutes, 1000 ms, 250 ms): Question Q-44.
- Undefined labels: S61 and A1 (worker control), and the bare "#179 ruling": Question Q-45.
- The worker-control specification is 590 lines with several paragraphs over 400 words; it is a split-review candidate for the engineer.
- The package guide `packages/core-client/README.md` still says "eleven" provider-subscription operations and names Quick Chat. Package guides are in the periphery group.

## Semantic Preservation

| File | Normative sentences | Numbers | Backticked identifiers | Headings | Links |
| --- | --- | --- | --- | --- | --- |
| `20260528-core_client_boundary.md` | 16 unchanged, 2 removed (CM-CCB-04 legacy-exposure sentence, CM-CCB-05 empty-delete clause) | 0 | 150 unchanged, 2 removed, 2 added | 22 unchanged | 12 unchanged |
| `20260703-worker_control_protocol.md` | 199 unchanged, 3 changed (CM-WCP-07: command enqueue, `interrupt` lineage, snapshot fallback) | 17 unchanged | 469 unchanged, 4 removed, 6 added | 37 unchanged | 36 unchanged, 1 added |
| `20261002-remote_mcp_interface.md` | 18 unchanged | 0 | 43 unchanged, 1 added | 30 unchanged | 37 unchanged |

The removed Core Client clauses described code that no longer exists; the remaining clause about definition-derived empty deletions is kept. In the worker-control projection, the snapshot fallback rule ("never borrows state from an older package or an AgentSession-only lookup") is kept; only the deleted command-enqueue path is removed. The Client Shape bullets for `client.core` and `client.app` now list the current members, and the `client.operations` bullets below them are unchanged. No heading anchor or file moved.

## Issues Opened

- #463 `[nanohost] Harness-control routes forward client binding headers when the path has a query string`, blocking candidate.
- #464 `[worker-control] Artifact notice, heartbeat persistence and final status differ from the specification`, ordinary.
- #465 `[core-client] Remove unused hand-maintained transport helpers after the definition-table cutover`, low.

## Questions For The Engineer

### Q-38. Should the remote MCP request audit carry a structured credential reference?

- Context: the audit records the Token id only in summary text. Other producers set the structured `authentication` field.
- Options: (A) Set `authentication` from the Token actor. (B) Keep the text.
- Recommendation: A. Audit consumers should not parse prose.
- Meanwhile: no change.

### Q-39. What happens to queued valid events when a stream envelope fails validation?

- Context: the Core Client discards events that it already validated and queued, then rejects the read.
- Options: (A) Deliver the queued valid events before the error. (B) State the discard in the specification.
- Recommendation: A. A validated event is admitted, and the specification forbids delivery only of the invalid event.
- Meanwhile: no change.

### Q-40. Which inputs does the Harness `operationId` hash?

- Context: the specification names the Sandbox Integration binding and the Harness Instance identity; the code hashes the Harness binding ref, which is unique per Harness Instance.
- Options: (A) Amend the wording to the Harness binding ref. (B) Change the code to the named inputs.
- Recommendation: A.
- Meanwhile: no change.

### Q-41. How many active Turns does one Harness admit?

- Context: the projection says one active Turn per Harness; the Harness admits one per AgentSession up to `maxActiveTurns`, which the same specification sets. Whether the scheduler admits more than one per Harness belongs to `20260703-runtime_scheduling_scale.md`, which is held.
- Options: (A) State the per-AgentSession rule and the `maxActiveTurns` bound, and leave scheduler admission to its owner. (B) Keep the one-per-Harness sentence.
- Recommendation: A, with the scheduling release.
- Meanwhile: no change.

### Q-42. Which worker-control verification failures store quarantined evidence?

- Context: the specification says failed verification stores quarantined evidence. Schema and size failures only log; lineage-bearing rejections, including 401 rejections with caller-claimed lineage, store rows.
- Options: (A) State that only authenticated, lineage-bearing rejections are stored, and stop storing rows for unauthenticated requests. (B) Store every failure.
- Recommendation: A. An unauthenticated caller should not write durable rows.
- Meanwhile: no change.

### Q-43. How does the 1000 ms poll maximum hold under the serial poll loop?

- Context: the loop handles one command at a time, and a long `session.open` blocks polls for every Harness, so an interrupt for another Harness can wait longer than 1000 ms.
- Options: (A) Add a priority path for `turn.interrupt`. (B) Restate the maximum for an idle loop only.
- Recommendation: A, because interrupt latency is user-visible.
- Meanwhile: no change.

### Q-44. How should the worker-control timing numbers be marked?

- Context: 300 seconds, 1,250 ms, five minutes, 1000 ms, and 250 ms appear as fixed rules. This is the same rule as Q-23.
- Options and recommendation: as Q-23.
- Meanwhile: no change.

### Q-45. Should the worker-control labels S61, A1, and "#179 ruling" be defined or linked?

- Context and recommendation: as Q-28.
- Meanwhile: no change.

### Q-46. Which operations does the remote MCP contract exclude?

- Context: the contract names one-time-secret results, the three Workspace archive streams, and the two Artifact file transfers. The code excludes every operation whose binding is not JSON, which also covers a third Artifact file stream and two Knowledge package streams.
- Options: (A) State the rule as "every one-time-secret result and every non-JSON binding". (B) Keep the closed list and add the three operations.
- Recommendation: A. The rule follows the binding and needs no edit when a stream is added.
- Meanwhile: the projection states the code rule.

## Independent Review

A fresh Reviewer context received the diff, this record, and the inventory, and checked the cited code itself. Verdict: accept with changes. Dispositions:

1. Removing `releasing` from the rejected states dropped a criterion; the code also rejects a `closing` attempt (`apps/nanocore/src/runtime/nanohost-attempt-records.ts:690-691` accepts only `open`). Accepted; the text now rejects `closing` and `closed`.
2. The remote MCP projection undercounted the non-JSON exclusions. Accepted; the projection names the rule and all eight streams, and the contract list is Question Q-46.
3. The provider-subscription Client Shape bullet omitted three of the thirteen operations. Accepted; the bullet now names them.
4. The CM-CCB-01 row needed the owners of the file streams. Accepted.
5. The removed count "eleven" in the Core Client projection had no note. Accepted; the CM-CCB other row gives the reason.
6. The `client.core` bullet named the Thread event stream while the code and the specification call it the turn event stream. Accepted; it now says "the turn event stream (`subscribeTurnEvents`)".
7. The unused transport helpers had no tracked task. Accepted; issue #465 tracks them.
8. A NanoHost line citation was off by one. Accepted.

The Reviewer confirmed that no Core document changed, that issues #463 and #464 match the code, that Q-38 to Q-45 change no text, and that the diff has no content-safety problem.

## Checks

Run on the working tree before the commit:

- `node scripts/validate-doc-model.mjs`: "Validated documentation model (666 documents)."
- `node scripts/generate-doc-index.mjs`: "Wrote docs/INDEX.md."
- `pnpm check:repo`: exit status 0.
- Content scan of the staged diff (emails, tokens, local absolute paths, Vietnamese diacritics): no match.
