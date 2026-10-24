---
date: "2026-10-24"
---
# Independent Documentation Audit: Policy Group

This non-authorizing record holds the policy group of the [independent documentation audit](20261023-independent_doc_audit.md). Its owning rule is [Change Execution Governance](../change-execution.md). It records observations, dispositions, and questions. It does not authorize design.

## Scope And Base

- Group base SHA: `05140a42f8b6aef63b399c259677ff2873307e6b`. `main` moved to `314f72fe2e62864b34eb30a155488c4507b80553` during the group with three code-only refactors (control store, capability tuples, MCP schema capture); evidence lines below are at the group base. Issue #440 had no comments and held no group in this scope.
- Core document: `docs/core/policy.md`, with the agent-principal sentence in `docs/core/doctrine.md`.
- Specifications: `20260629-openkit_policy_model.md` (PM), `20260703-policy_enforcement_mapping.md` (PEM), `20260909-thread_visibility_and_sharing.md` (TVS), and `20260930-pending_requests.md` (PR).
- Cited decisions read: `20261018-unified_mediation_and_policy.md` (through the PM projection), `20260924-member_permissions_await_policy_kernel.md`, and `20261016-retire_stateless_quick_chat.md`.
- G3 inspection: four read-only inspector contexts (PO-PM, PO-PEM, PO-TVS, PO-PR). They read code only and ran no tests. The auditor verified each kept finding against the code. PO-PEM did not verify the agent-gate field rules, the Goal-domain `administer` writer, the Worker Git-read bounds, or boundary import and export in depth.

## G2 Core Against Specifications

- PO-G2-01: Core Policy and PM both say that the Kernel checks that the terminal human of an agent responsibility chain is current. PM also keeps the evaluator pure and synchronous. Both hold if the policy owner resolves the chain into request facts before evaluation; the chain evaluation is Not Started in both. No conflict.
- PO-G2-02: Core Policy names the product reasons `not_granted` and `prohibited` for escalation. PM puts the same words on the Kernel trace, while the Kernel emits `missing-privilege` and `restriction` and the product adapter maps them. Question Q-60.
- PO-G2-03: Core Doctrine says "activation remains unclaimed" for agent principals. That is an implementation-status statement in a Core document, which is implementation-neutral. Question Q-70.
- PO-G2-04: Core Policy says that owning an administrator Token without presenting the administrator's Web session or bearer supplies no administrator eligibility; PR says a channel actor never inherits an administrator credential from pairing. The two agree. The code differs from both (issue #472).
- PO-G2-05: Core Protocol lists Thread archive or deletion, Workspace deletion, and loss of membership or authority as ending events, and the responsible user as resolver. PR adds Goal cancellation, Plan supersession, and administrator eligibility. Core is silent on them, so this is not a conflict.

## G3 Specifications Against Implementation

| Finding | Clause | Evidence (at the group base SHA) | Adjudication | Action |
| --- | --- | --- | --- | --- |
| PO-PR-04 | PR Account Binding: a channel actor never inherits an administrator credential; Core Policy: an owned Token alone gives no eligibility | `apps/nanocore/src/channel-services.ts:54-57` and `apps/nanocore/src/channels/discord.ts:423-426` build a `session` actor in server mode; `apps/nanocore/src/auth/operation-authorizer.ts:184-189` makes it an administrator when the User owns a usable `server-admin` Token; `apps/nanocore/src/runtime/pending-request-flow.ts:1394-1412` then skips the membership check | Code differs from current accepted documents for the server-mode `session` case. In local mode the channel accepts only the local owner (`apps/nanocore/src/channel-services.ts:55`), who is an administrator by local-mode design | Issue #472 (blocking candidate: authorization), with a comment that limits it to server mode; the local-mode case is Question Q-72 |
| PO-PR-01 | PR Raise: a repeated command-intent approval matches the pending request with the same requester and exact intent | `apps/nanocore/src/runtime/pending-requests.ts:2109-2130` returns `false` for an approval without a captured call; only an identical request id matches | Code differs from a current accepted document | Issue #473 |
| PO-TVS-01 | TVS: register and emit `openkit.thread-entry.v1` and `openkit.thread-visibility.v1` on Thread records | `packages/config-schema/src/schema-evolution.ts:83-90` registers both; no producer emits them; `apps/nanocore/src/storage/control-store-products.ts:226-229` refuses any non-empty list | Code differs from a current accepted document; the TVS projection claimed the gate | Issue #471 (blocking candidate: retained data); projection corrected. The same claim in `apps/nanocore/README.md:487` and `packages/config-schema/README.md:31,89` is left to the periphery group |
| PO-PEM-01 | PEM projection: `apps/nanocore/src/policy/approval-gates.ts` creates the first approval gate and pauses the Turn | The file does not exist; `apps/nanocore/src/worker-mcp-routes.ts:1609-1625` turns `require_approval` and `require_escalation` into a captured Pending Request (`apps/nanocore/src/runtime/captured-pending-call.ts`); no production `humanGate` pause (`git grep humanGate`, tests excluded, finds none) | Projection drift; the same bullet records that the agent communication redesign replaces the pause | Corrected; the closing producer list is aligned |
| PO-PEM-02 | PEM projection: the Goal Mode supervise route records `runtime.launch` through `startGoalTaskWorkerTurn` | No `startGoalTaskWorkerTurn` and no supervise route in production code; `runtime.launch` checks are in the worker and scheduler paths | Projection drift | Corrected to a removed route; the rule that its retained decisions stay readable is kept. `20260528-core_client_boundary.md:161` still names the route and is recorded for the periphery recheck of the communication group |
| PO-PEM-03 | PEM Statement Format: the three new families "land additively"; "Future lease payloads" | `packages/protocol/src/models/policy-v1.ts:246-292,320-339`; `apps/nanocore/src/policy/configuration.ts:358-405` reads storage leases | Projection drift for the lease payload; the activation claim for agent-principal declarations is undecided | "Future" removed from the lease sentence; the family sentence is Question Q-62 |
| PO-PM-05 | PM Deferred: "Add NanoCore enforcement-point integration through `PermissionDecision` records" | `apps/nanocore/src/policy/permission-decisions.ts` writers in the boot check, `llm/gateway-routes.ts`, `runtime/worker-turn-loop.ts`, `worker-mcp-routes.ts`, `vault/vault-grant-requests.ts`, and `policy/goal-domains.ts` | Projection drift | Corrected to "Complete ...", with a reference to the PEM projection for the current writers |
| PO-PM-03 | PM projection: Goal delegated-domain activation Not Started; Joint Goal-Domain Publication: "Task join Not Started" | `apps/nanocore/src/runtime/task-admission.ts:131-151` refuses Task admission outside the Goal domain; `apps/nanocore/src/app.ts:2085-2110` wires the Goal domain services; PEM line 500 says Goal-domain publication and Task Policy hooks are implemented | Two accepted specifications disagree; the Goal specification is held | Question Q-61 |
| PO-PM-01 | PM Decision Trace: distinguishable as `not_granted` and `prohibited` | `packages/policy-kernel/src/index.ts:152,158` codes `missing-privilege` and `restriction`; `apps/nanocore/src/policy/interception.ts:300-305` maps them | Met in behavior; naming undecided | Question Q-60 |
| PO-PR-02 | PR projection: a retained `repository_push` call is denied before claim | `apps/nanocore/src/runtime/pending-request-flow.ts:825-840` sets `tool-left-supply` in the Main submission check after claim; `apps/nanocore/src/runtime/pending-requests.test.ts:2096-2100` expects `execution-error` | Projection drift; the PR Contract and acceptance already say `execution-error` after claim | Corrected, and the sentence's `captured-pending-call.ts` path now includes `runtime/`. The same stale wording in `20260704-worker_mcp_tool_supply.md:231` is left to the agent-supply group |
| PO-PR-03 | PR Deliver: the outcome Turn's trigger actor is the deciding actor of the first outcome, or the system | `apps/nanocore/src/runtime/pending-request-flow.ts:1140-1156` uses the deciding actor or the responsible user, ignores the ending actor, and takes the first by creation order | The withdrawal case and the meaning of "first" are not decided | Question Q-65 |
| PO-PR-07 | PR Parties: the accepted policy actor stays the recorded actor for a policy grant | `apps/nanocore/src/runtime/pending-requests.ts:1572-1584` accepts `nanocore-repo-push-policy`; no producer remains | No record decides whether the clause is retained-read tolerance | Question Q-66 |
| PO-PR-08 | PR Resolve: the answer command carries Workspace, Thread, `requestId`, and `answers` | `packages/protocol/src/requests/pending-request.ts:5-23` also requires the target id and, for approval, `turnId` with a scope-mismatch refusal | Documentation gap | Question Q-67 |
| PO-PR-09 | PR Resolve: any other actor gets `workspace_access_denied` | `apps/nanocore/src/runtime/pending-request-flow.ts:536-537` checks the answer shape before the actor | Check order not decided | Question Q-68 |
| PO-PR-10 | PR Canonical Load Validation: an unreadable request is inspect-only and returns `recovery_required` | `apps/nanocore/src/runtime/pending-requests.ts:635-651` drops an unreadable row from the Thread list, so the bound and the archive census do not see it; direct reads throw | List behavior not decided | Question Q-69 |
| PO-TVS-02 | TVS: `Thread.entryPath` is `conversation \| administration` | `packages/protocol/src/models/thread.ts:8-12` adds `knowledge-manager`, written by `apps/nanocore/src/lib/store.ts:3890` | No record adds the value | Question Q-63 |
| PO-TVS-03 | TVS: shared conversations come after v0.1.0 and never in a personal Workspace | `apps/nanocore/src/thread-routes.ts:217-224` creates a `workspace` conversation Thread for any admitted Workspace when the caller asks | Interim contract not decided | Question Q-64 |
| PO-TVS-04 | TVS: an administrator credential is eligible for private-Thread reads | `apps/nanocore/src/auth/operation-authorizer.ts:896` passes `false` | Same finding as identity ID-RA-03 | Question Q-57 |
| PO-TVS other | TVS projection names Quick Chat and "eleven" commands | No Quick Chat operation | Document outdated by [Retire Stateless Quick Chat](../decisions/20261016-retire_stateless_quick_chat.md) | Removed, as in the identity group |
| PO matches | Kernel elements, assignments, associations, prohibitions, process mapping, allow or deny only, trace; 29 of 29 product operation rights; server families; result precedence; stages and modes; storage-lease admission; Pending Request enums, bound, disclosure sizes, claim order, closeout, archive refusals, and Discord signature, pairing, and receipts | `packages/policy-kernel/src/index.ts`, `packages/config-schema/src/product-policy.ts`, `apps/nanocore/src/policy/`, `apps/nanocore/src/runtime/pending-request*.ts`, `apps/nanocore/src/channels/discord.ts` | Match | None |

## G4 Organization

No move, merge, or split is applied. PEM is 684 lines and holds the Statement Format, the access-right registry, and a long implementation projection; it is a split-review candidate. The PR Discord section is the only owner of the Discord binding (G1-TD-01).

## G5 Writing

- Experience-chosen numbers without a current-default marking: PR 16 pending requests per Thread, 16 outcomes per Turn, 2,048 and 524,288 bytes. As Q-23: Question Q-71.
- Undefined labels: I16 and R033 (PM, PEM), Stage 4 (PEM), rc.10 (TVS), SEP-2848, "#117 decision", D2, FULL, and "No eleventh operation" (PR). As Q-28: Question Q-71.
- PR uses "Draft" only as the name of the superseded Delayed User Input document; that is a historical name, not draft status.
- PR frontmatter `updated` is older than records it cites. The audit does not change `updated` dates in any group.

## Semantic Preservation

| File | Normative sentences | Numbers | Backticked identifiers | Headings | Links |
| --- | --- | --- | --- | --- | --- |
| `20260629-openkit_policy_model.md` | 65 unchanged | 0 | 106 unchanged | 41 unchanged | 4 unchanged, 1 added |
| `20260703-policy_enforcement_mapping.md` | 143 unchanged, 1 changed ("Future" removed from the lease sentence) | 0 | 358 unchanged, 4 removed (`workspace.sqlite`, `approval-gates.ts`, `ApprovalRequest`, `approval-request`), 4 added | 44 unchanged | 22 unchanged |
| `20260909-thread_visibility_and_sharing.md` | 27 unchanged | 0 | 24 unchanged, 4 added | 17 unchanged | 9 unchanged |
| `20260930-pending_requests.md` | 86 unchanged | 2 unchanged | 301 unchanged, 1 changed (the `captured-pending-call.ts` path), 3 added | 40 unchanged | 40 unchanged |

Other changed sentences: the PM deferred bullet; three PEM projection bullets and the closing producer list; the TVS projection sentences on the feature gate, Quick Chat, and "eleven"; and the PR `repository_push` projection sentence. The removed PEM identifiers described the deleted approval-gate helper; the rule that an approval writes its `ApprovalRequest` projection and request Item together stays in PR Raise step 4. The removed `workspace.sqlite` described the deleted supervise route, and the retained-decision readability rule is kept.

## Issues Opened

- #471 `[thread] Thread records never emit the thread-entry and thread-visibility required features`, blocking candidate (retained data).
- #472 `[discord] A paired Discord account gains administrator eligibility from an owned server-admin Token`, blocking candidate (authorization); a comment limits it to server mode.
- #473 `[pending-requests] A repeated command-intent approval with a new request id is not deduplicated`, ordinary.

## Questions For The Engineer

### Q-60. Which names does the Kernel trace use for a missing grant and a prohibition?

- Context: PM says `not_granted` and `prohibited`; the Kernel emits `missing-privilege` and `restriction`, and the product adapter maps them to the Core product reasons.
- Options: (A) Name the Kernel codes in PM and keep `not_granted` and `prohibited` as product reasons. (B) Rename the Kernel codes.
- Recommendation: A.
- Meanwhile: no change.

### Q-61. Are Goal-domain activation and Task join implemented?

- Context: PM says Goal delegated-domain activation and Task join are Not Started; PEM says Goal-domain publication and Task Policy hooks are implemented, and Task admission enforces the domain. The Goal specification is held.
- Options: (A) Amend PM to the PEM status when the Goal group is released. (B) Keep PM until the Goal acceptance passes.
- Recommendation: A.
- Meanwhile: no change.

### Q-62. Did the three new Policy families land with their activating consumers?

- Context: PEM says agent-principal declarations, Goal-domain delegations, and storage leases land with their activating consumers rather than as inactive authority. All three exist in the schema; storage leases and Goal delegations have readers, and `apps/nanocore/src/policy/statements.ts:277` reads active agent-principal declarations, while Core Doctrine says agent-principal activation is unclaimed.
- Options: (A) Restate the sentence in the present tense and name which consumers are active. (B) Keep it.
- Recommendation: A, with Q-70.
- Meanwhile: no change.

### Q-63. Is `knowledge-manager` a valid `Thread.entryPath`?

- Context: TVS defines two values; the code writes a third for the Knowledge Manager Thread with Workspace visibility.
- Options: (A) Add the value to TVS with its Tool-set and visibility rule. (B) Remove it from the code.
- Recommendation: A, confirmed in the knowledge group.
- Meanwhile: no change.

### Q-64. What is the interim contract for an explicit `workspace` conversation Thread?

- Context: TVS defers shared conversation to after v0.1.0 and excludes personal Workspaces; public create accepts `visibility: workspace` for formal work in any Workspace.
- Options: (A) State that explicit `workspace` creation is for formal work and refuse it in a personal Workspace. (B) Allow it and amend the deferral.
- Recommendation: A.
- Meanwhile: no change.

### Q-65. Which actor triggers an outcome Turn for a withdrawal, and which outcome is "first"?

- Context: the code uses the deciding actor or the responsible user and takes the earliest created outcome; the freeze uses readiness order.
- Options: (A) Use the ending actor for a withdrawal and the readiness order for "first". (B) State the current behavior.
- Recommendation: A.
- Meanwhile: no change.

### Q-66. Is the policy-grant actor clause retained-read tolerance only?

- Context: no producer writes `nanocore-repo-push-policy`; the validator still accepts it for completed Items.
- Options: (A) Mark the clause as validation of retained Items only. (B) Remove it with the validator.
- Recommendation: A, because retained data must stay readable.
- Meanwhile: no change.

### Q-67. Should PR name the target id and `turnId` fields of the response commands?

- Context: the commands require the request id field and, for approval, the raising `turnId`, and refuse a scope mismatch.
- Options: (A) Name them in Resolve. (B) Leave them to the schema.
- Recommendation: A.
- Meanwhile: no change.

### Q-68. In which order does a response check authority, state, and shape?

- Context: the answer shape and secret checks run before the actor check, so a non-responsible actor can learn the question shape.
- Options: (A) Authority, then state, then shape. (B) State the current order.
- Recommendation: A.
- Meanwhile: no change.

### Q-69. How does a Thread list treat an unreadable request?

- Context: the list drops the row, so the bound and the archive census do not see it.
- Options: (A) Count it against the bound and refuse archive with `recovery_required`. (B) State that lists skip it.
- Recommendation: A. Unknown core values fail closed.
- Meanwhile: no change.

### Q-70. Should Core Doctrine keep the agent-principal activation status sentence?

- Context: "activation remains unclaimed" is a status claim in Core.
- Options: (A) Move the status to PM and PEM. (B) Keep it.
- Recommendation: A.
- Meanwhile: no change.

### Q-71. How should the policy numbers and labels be marked?

- Context: the PR bounds and sizes; the labels I16, R033, Stage 4, rc.10, SEP-2848, "#117 decision", D2, FULL, and "eleventh".
- Options and recommendation: as Q-23 and Q-28.
- Meanwhile: no change.

### Q-72. Does a local-mode Discord response carry administrator eligibility?

- Context: in local mode the channel accepts only the local owner, and the local actor is an administrator by design. Core Policy says owning an administrator credential without presenting it gives no eligibility, and PR says pairing never inherits an administrator credential.
- Options: (A) Treat channel input as an ordinary actor in local mode too, so membership and audience checks apply. (B) State that the local owner keeps administrator eligibility on every channel.
- Recommendation: A, so one channel rule holds in both modes.
- Meanwhile: no change.

## Independent Review

A fresh Reviewer context received the diff, this record, and the inventory, and checked the cited code and issues itself. Verdict: accept with changes. Dispositions:

1. The TVS projection kept a sentence that said the reader requires the feature gates, and "empty" was too narrow. Accepted; the reader sentence now names the envelope, owner, and entry fields and points to #471, and the list is "absent or empty".
2. The PM deferred bullet listed only some `PermissionDecision` writers. Accepted; it now points to the PEM projection instead of a partial list.
3. The edited PR sentence cited `captured-pending-call.ts` without `runtime/`. Accepted.
4. PO-PR-04 and #472 overstated the local-mode case. Accepted; the defect is limited to server mode, #472 has a scope comment, and the local-mode case is Question Q-72.
5. Stale copies of the corrected claims in package guides and in the Core Client specification were not recorded. Accepted; they are listed under PO-TVS-01 and PO-PEM-02 for their groups.
6. The "no production `humanGate`" claim had no reproducible search. Accepted.

The Reviewer confirmed the remaining edits, the kept criteria, the inventory counts, issues #471 to #473, that Q-60 to Q-71 change no text, and that the diff has no content-safety problem.

## Checks

Run on the working tree before the commit:

- `node scripts/validate-doc-model.mjs`: "Validated documentation model (668 documents)."
- `node scripts/generate-doc-index.mjs`: "Wrote docs/INDEX.md."
- `pnpm check:repo`: exit status 0.
- Content scan of the staged diff (emails, tokens, local absolute paths, Vietnamese diacritics): no match.
